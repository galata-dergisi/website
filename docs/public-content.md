# Public content and SEO

The schema-v2 reviewed catalog in `content/public.sqlite` contains only public issue
pages, work titles, display names, issue/page coordinates, published media
paths, and public contribution roles. It must not contain submission messages,
email addresses, credentials, private contributor records, or operational
state.

Issue publication values are nominal editorial timestamps. Each is the
explicit UTC instant corresponding to `00:00:00 Europe/Istanbul` on the first
day of the first month printed on the cover. The verifier applies IANA timezone
history and rejects timezone-less or inconsistent values.

The catalog also contains reviewed MIME types, byte sizes, durations,
dimensions, and video-thumbnail paths for public media. These facts are
captured during catalog review; deterministic site builds do not probe media
files or require external inspection tools.

## Build and verify

```sh
npm run content:verify
npm run test:ssr
npm run build
npm run verify:site
```

The Vite frontend build writes browser assets to `public/` and the build-only
Svelte renderer adapter to `build/ssr/HomePage.cjs`. The adapter preserves the
generator's `render(props) -> { html }` contract while using `svelte/server`
internally. The site generator reads the canonical
SQLite database in read-only mode and writes the embedded response tree to
`internal/site/dist/`.

Set `PUBLIC_BASE_URL` during generation when the canonical origin differs from
`https://galatadergisi.org`.

Contributor spelling aliases used while decorating published page markup live
in `content/contributor-aliases.json`. They affect only public display-name
matching; contributor IDs, slugs, and relationships remain in the canonical
database.

## Public routes

- `/dergiler/sayi{issue}/{page}` renders the complete work containing that
  page and publishes the work-start canonical URL.
- `/magazines/{issue}/seo` and its trailing-slash alias provide the noindexed,
  versioned SEO document map used by the hydrated reader. Continuation pages
  keep their physical route while resolving to the work-start metadata.
- `/katkida-bulunanlar/{id}-{slug}` is a stable contributor profile; an old
  slug redirects by contributor ID.
- `/feed.xml` is an Atom 1.0 feed containing every canonical non-cover work,
  ordered by reviewed publication time, issue, and start page. It is served as
  `application/atom+xml`, supports deterministic gzip, and is intentionally
  excluded from the sitemap.
- `/sitemap.xml` contains the homepage, issues, canonical works, and public
  contributors. Its `lastmod` values represent content-change dates: the newest
  issue for the homepage, publication for issues and works, and the newest
  represented publication for contributor profiles.
- `/robots.txt` advertises the sitemap.
- Compatibility magazine JSON routes and issue SEO JSON retain
  `X-Robots-Tag: noindex`.
- The private-submission form at `/katkida-bulunun` publishes
  `<meta name="robots" content="noindex">`.
- Recitation and inline-media links retain their physical page plus stable
  `#ses-…` and `#gorsel-…` fragments.

## Metadata policy

- Every physical route in a canonical cluster reuses one title, description,
  social-tag set, and JSON-LD graph.
- One generated `SeoDocument` contract supplies server rendering and hydrated
  reader updates. The client replaces title, description, language, canonical,
  Open Graph, Twitter, article, and JSON-LD metadata before updating the URL;
  charset, analytics, icons, styles, and feed discovery remain untouched.
- Every indexable document advertises `/feed.xml` with an Atom alternate link
  and publishes `twitter:site` as `@GalataDergisi`.
- Contributor-specific `twitter:creator` and `hreflang` remain absent until
  reviewed contributor handles or genuine translated URLs exist.
- Descriptions use a meaningful excerpt only after filtering titles, bylines,
  controls, handles, and page numbers. Thin pages receive deterministic issue-,
  type-, creator-, and media-aware descriptions.
- JSON-LD is a connected `@graph` with stable Organization, WebSite,
  Periodical, WebPage, work, person, breadcrumb, image, audio, and video IDs.
- `dateModified` and `article:modified_time` are omitted until real editorial
  modification data exists.
- Reader pages intentionally do not publish a viewport tag. Existing titles
  and social-card images are not shortened or replaced by the SEO generator.
- Rights, licenses, accessibility claims, personal social identities,
  transcripts, keywords, ratings, search actions, and unsupported rich-result
  types remain absent without separately reviewed public data.

## Review checks

Before accepting a catalog or renderer change:

1. Fetch representative prose, poetry, visual, recitation, and contributor
   pages with browser scripting disabled; confirm titles and public credits.
2. Enable browser scripting and confirm the same HTML hydrates into the reader
   without a layout change.
3. Verify continuation-page canonicals, synchronized reader head/URL state,
   issue SEO endpoints, Atom entries and discovery, missing-route responses,
   sitemap uniqueness, structured metadata, redirects, JSON aliases, and
   fragments.
4. Require a byte-identical second generated build.

Catalog authoring is outside this repository. A replacement is accepted only
as a complete reviewed SQLite file that passes the verifier and all
generated-site checks.
