# syntax=docker/dockerfile:1

# Keep the scanner target aligned with the repository's pinned production
# build toolchains. Node is used only to generate the embedded site.
FROM node:24.18.0-alpine AS site-builder

WORKDIR /src

COPY package.json package-lock.json ./

RUN npm ci

COPY client/ client/
COPY content/ content/
COPY scripts/ scripts/
COPY postcss.config.mjs svelte.config.mjs ./

RUN npm run build \
    && npm run verify:site

FROM golang:1.26.5-alpine AS server-builder

WORKDIR /src

COPY go.mod ./
COPY cmd/ cmd/
COPY internal/ internal/
COPY --from=site-builder /src/internal/site/dist/ internal/site/dist/

RUN mkdir -p /out/contributions \
    && CGO_ENABLED=0 GOOS=linux go build \
        -buildvcs=false \
        -trimpath \
        -ldflags="-s -w" \
        -o /out/galata-server \
        ./cmd/galata-server

# The production-mode scan target contains only the statically linked server,
# its CA roots, and its private writable inbox. It is not a deployment image.
FROM scratch AS scan-target

COPY --from=server-builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=server-builder /out/galata-server /galata-server
COPY --from=server-builder --chown=65532:65532 /out/contributions/ /var/lib/galata-contributions/

USER 65532:65532
EXPOSE 3000

ENTRYPOINT ["/galata-server"]
