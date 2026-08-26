# Public content database

`public.sqlite` is the canonical, reviewed, public-only build source. It is
safe to commit only while `npm run content:verify` passes the exact schema/column
privacy allowlist, SQLite integrity and foreign-key checks, zero-warning
catalog, and reviewed count baseline.

Current reviewed SHA-256:

```text
ca0ff5e67d72fe7c454b0a61e5cf92b91ef33e89a7be7b0989137f86f8709647
```

Schema version 2 stores publication instants as explicit RFC 3339 UTC values.
They represent midnight in `Europe/Istanbul` on the first day of the first
month printed on each cover, including historical Turkish DST. The
`public_media_metadata` table contains reviewed technical facts for public
media, so builds never probe media or depend on `ffprobe`.

A protected private-content archive may be supplied explicitly to the release
scanner, but it is not part of this directory. It remains offline and must not
be deployed or embedded.
