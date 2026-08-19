#!/usr/bin/env python3

import argparse
import hashlib
import json
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo


ALLOWED_COLUMNS = {
    "schema_metadata": {"key", "value"},
    "magazines": {
        "id", "publishDateText", "thumbnailURL", "tableOfContents", "publishDate"
    },
    "pages": {"magazineIndex", "pageNumber", "content"},
    "public_contributors": {
        "id", "displayName", "normalizedName", "slug"
    },
    "published_works": {
        "id", "magazineIndex", "startPage", "endPage", "title", "type", "kind",
    },
    "published_work_toc_entries": {
        "magazineIndex", "tocPageNumber", "tocPosition", "linkedPage",
        "tocTitle", "tocAuthor", "workId"
    },
    "published_work_contributors": {
        "workId", "contributorId", "position", "role"
    },
    "audio_recitations": {
        "id", "workId", "sequence", "pageNumber", "kind", "poemTitle",
        "poetName", "mp3Path", "oggPath", "anchorId"
    },
    "audio_recitation_contributors": {
        "recitationId", "contributorId", "position", "role"
    },
    "published_work_media": {
        "id", "workId", "pageNumber", "position", "title", "kind",
        "mediaPath", "anchorId"
    },
    "published_work_media_contributors": {
        "mediaId", "contributorId", "position", "role"
    },
    "public_media_metadata": {
        "publicPath", "encodingFormat", "contentSize", "duration", "width",
        "height", "thumbnailPath"
    },
}

SUMMARY_QUERIES = {
    "magazines": "SELECT COUNT(*) FROM magazines",
    "pages": "SELECT COUNT(*) FROM pages",
    "works": "SELECT COUNT(*) FROM published_works",
    "contributors": "SELECT COUNT(*) FROM public_contributors",
    "recitations": "SELECT COUNT(*) FROM audio_recitations",
    "inlineMediaContributions": "SELECT COUNT(*) FROM published_work_media",
    "mediaMetadata": "SELECT COUNT(*) FROM public_media_metadata",
}

TURKISH_MONTHS = {
    "Ocak": 1,
    "Şubat": 2,
    "Mart": 3,
    "Nisan": 4,
    "Mayıs": 5,
    "Haziran": 6,
    "Temmuz": 7,
    "Ağustos": 8,
    "Eylül": 9,
    "Ekim": 10,
    "Kasım": 11,
    "Aralık": 12,
}
UTC_TIMESTAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
ISO_DURATION = re.compile(r"^PT(?:\d+(?:\.\d+)?)S$")
IMAGE_PATH = re.compile(r'/images/[^"\'()<>\s]+', re.IGNORECASE)


def expected_publication_time(label):
    match = re.match(r"^(\S+).*?(\d{4})$", label)
    if not match or match.group(1) not in TURKISH_MONTHS:
        raise ValueError(f"Unsupported cover period: {label}")
    local = datetime(
        int(match.group(2)),
        TURKISH_MONTHS[match.group(1)],
        1,
        tzinfo=ZoneInfo("Europe/Istanbul"),
    )
    return local.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def verify_publication_dates(connection):
    rows = connection.execute(
        "SELECT id, publishDateText, publishDate FROM magazines ORDER BY id"
    )
    for issue, label, published_at in rows:
        if not UTC_TIMESTAMP.fullmatch(published_at):
            raise ValueError(
                f"Issue {issue} publishDate is not explicit RFC 3339 UTC: "
                f"{published_at}"
            )
        expected = expected_publication_time(label)
        if published_at != expected:
            raise ValueError(
                f"Issue {issue} publication mismatch: expected {expected}, "
                f"found {published_at}"
            )


def verify_media_metadata(connection):
    referenced = {"/images/header-logo.jpg"}
    archived_ogg_paths = {
        row[0] for row in connection.execute(
            "SELECT oggPath FROM audio_recitations WHERE oggPath IS NOT NULL"
        )
    }
    referenced.update(
        row[0] for row in connection.execute(
            "SELECT thumbnailURL FROM magazines"
        )
    )
    for (content,) in connection.execute("SELECT content FROM pages"):
        referenced.update(
            match.group(0).split("?", 1)[0].split("#", 1)[0]
            for match in IMAGE_PATH.finditer(content)
        )
    referenced.update(
        row[0] for row in connection.execute(
            "SELECT mediaPath FROM published_work_media"
        )
    )
    for (mp3_path,) in connection.execute(
        "SELECT mp3Path FROM audio_recitations"
    ):
        if mp3_path:
            referenced.add(mp3_path)

    metadata = {}
    for row in connection.execute(
        """
        SELECT publicPath, encodingFormat, contentSize, duration,
               width, height, thumbnailPath
        FROM public_media_metadata ORDER BY publicPath
        """
    ):
        (
            public_path, encoding_format, content_size, duration,
            width, height, thumbnail_path,
        ) = row
        metadata[public_path] = row
        if public_path in archived_ogg_paths:
            continue
        if content_size <= 0:
            raise ValueError(f"Invalid contentSize for {public_path}")
        if encoding_format.startswith("image/"):
            if not width or not height:
                raise ValueError(f"Image dimensions missing for {public_path}")
        elif encoding_format.startswith(("audio/", "video/")):
            if not duration or not ISO_DURATION.fullmatch(duration):
                raise ValueError(f"Duration missing or invalid for {public_path}")
        else:
            raise ValueError(
                f"Unsupported encodingFormat for {public_path}: "
                f"{encoding_format}"
            )
        if encoding_format.startswith("video/"):
            if not width or not height or not thumbnail_path:
                raise ValueError(
                    f"Video dimensions or thumbnail missing for {public_path}"
                )
            referenced.add(thumbnail_path)

    missing = sorted(referenced - set(metadata))
    orphaned = sorted(set(metadata) - referenced - archived_ogg_paths)
    if missing or orphaned:
        raise ValueError(
            "Public media metadata coverage mismatch: "
            f"missing={missing}, orphaned={orphaned}"
        )

    video_paths = {
        row[0] for row in connection.execute(
            """
            SELECT mediaPath FROM published_work_media
            WHERE kind = 'video' ORDER BY mediaPath
            """
        )
    }
    if len(video_paths) != 8:
        raise ValueError(
            f"Expected 8 referenced published videos, found {len(video_paths)}"
        )
    if "/images/sayi44/semih-gorsel2.mp4" in metadata:
        raise ValueError("Unreferenced semih-gorsel2.mp4 entered public metadata")


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_database(database_path):
    connection = sqlite3.connect(f"file:{database_path}?mode=ro", uri=True)
    try:
        tables = {
            row[0]
            for row in connection.execute(
                """
                SELECT name
                FROM sqlite_schema
                WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
                """
            )
        }
        expected_tables = set(ALLOWED_COLUMNS)
        if tables != expected_tables:
            raise ValueError(
                "Public table allowlist mismatch: expected "
                f"{sorted(expected_tables)}, found {sorted(tables)}"
            )

        for table, allowed in ALLOWED_COLUMNS.items():
            columns = {
                row[1]
                for row in connection.execute(f'PRAGMA table_info("{table}")')
            }
            if columns != allowed:
                raise ValueError(
                    f"Public column allowlist mismatch for {table}: expected "
                    f"{sorted(allowed)}, found {sorted(columns)}"
                )

        integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity != "ok":
            raise ValueError(f"SQLite integrity check failed: {integrity}")

        violations = connection.execute("PRAGMA foreign_key_check").fetchall()
        if violations:
            raise ValueError(
                f"SQLite foreign-key check found {len(violations)} violation(s)"
            )

        metadata = dict(connection.execute(
            "SELECT key, value FROM schema_metadata ORDER BY key"
        ))
        expected_metadata = {
            "schema_version": "2",
            "publication_timezone": "Europe/Istanbul",
            "publication_rule": "first-named-month-start",
            "media_metadata_source": "reviewed-public-assets",
        }
        for key, expected_value in expected_metadata.items():
            if metadata.get(key) != expected_value:
                raise ValueError(
                    f"Public database metadata {key} must be "
                    f"{expected_value!r}, found {metadata.get(key)!r}"
                )
        if "catalog_summary" not in metadata:
            raise ValueError("Public database is missing catalog_summary metadata")
        summary = json.loads(metadata["catalog_summary"])
        actual = {
            name: connection.execute(query).fetchone()[0]
            for name, query in SUMMARY_QUERIES.items()
        }
        actual["warnings"] = 0
        if summary != actual:
            raise ValueError(
                f"Catalog summary mismatch: expected {summary}, found {actual}"
            )

        verify_publication_dates(connection)
        verify_media_metadata(connection)

        return {
            "database": str(database_path),
            "sha256": sha256_file(database_path),
            "integrityCheck": integrity,
            "foreignKeyViolations": 0,
            "summary": summary,
            "tables": sorted(tables),
        }
    finally:
        connection.close()


def main():
    parser = argparse.ArgumentParser(
        description="Verify the canonical public-only Galata SQLite database."
    )
    parser.add_argument(
        "database",
        nargs="?",
        type=Path,
        default=Path("content/public.sqlite"),
    )
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parent.parent
    database = (
        args.database
        if args.database.is_absolute()
        else repo_root / args.database
    ).resolve()
    if not database.is_file():
        raise SystemExit(f"Missing public database: {database}")

    print(json.dumps(verify_database(database), indent=2))


if __name__ == "__main__":
    main()
