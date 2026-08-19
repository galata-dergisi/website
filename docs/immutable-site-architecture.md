# Immutable public site architecture

Production has two deliberately separate data paths:

```text
content/public.sqlite -- Node 24 build + Svelte SSR --> manifest + files
                                                            |
                                                            | go:embed
                                                            v
                                                    Go HTTP server

POST /katkida-bulunun --> private staging --> atomic rename --> private inbox
```

## Build boundary

`content/public.sqlite` is the canonical public-content source. Its exact
table-and-column allowlist, integrity, foreign keys, stored catalog summary,
and checksum are verified before every build. Catalog replacement requires a
complete, separately reviewed SQLite file.

Schema version 2 also stores explicit UTC publication instants and a reviewed
public-media metadata inventory. Rendering reads these facts directly; it
never derives dates from the build host timezone or probes media during the
build.

Node, npm, Vite, and Svelte are build tools only. They compile the browser
reader and contribution form, render crawlable HTML, decorate public credits,
and generate the content-addressed response tree under
`internal/site/dist/`. They are not installed or executed by the production
application.

The generated manifest covers every public HTML route, compatibility and
reader-SEO JSON route, redirect, Atom feed, sitemap, robots response,
contribution form, browser bundle, and small UI asset. Magazine images, video,
and audio remain outside the binary and are served by the reverse proxy.

## Runtime boundary

The Go server embeds `internal/site/dist`. Public `GET` and `HEAD` handling
performs no SQL, Svelte execution, compression, content generation, or
filesystem write. It performs manifest lookup, conditional-request
evaluation, and copying of an embedded identity or deterministic gzip file.

`POST /katkida-bulunun` is the only write path. An accepted submission becomes
one owner-only directory under `inbox/`, containing schema-versioned
`metadata.json` and, for non-video submissions, one validated asset. Staging
and final directory renames ensure an inbox entry is either complete or absent.
No submission is added to the public catalog automatically.

The production artifact is one Go binary. Browser JavaScript embedded in that
binary runs only in visitors' browsers; there is no JavaScript application
server or production package installation.
