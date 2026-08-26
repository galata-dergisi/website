# syntax=docker/dockerfile:1

# Keep the scanner target aligned with the repository's pinned production
# build toolchains. Node is used only to generate the embedded site.
FROM node:24.18.0-alpine AS site-builder

WORKDIR /src

COPY package.json package-lock.json ./

RUN npm ci

COPY client/ client/
COPY content/ content/
COPY ops/nginx/ ops/nginx/
COPY scripts/ scripts/
COPY postcss.config.mjs svelte.config.mjs ./

RUN --mount=type=bind,from=galata_static_images,target=/galata-static-images,readonly \
    GALATA_STATIC_ASSETS_ROOT=/galata-static-images npm run build \
    && npm run verify:site

FROM golang:1.27.0-alpine AS server-builder

WORKDIR /src

COPY go.mod ./
COPY cmd/ cmd/
COPY internal/ internal/
COPY --from=site-builder /src/internal/site/dist/ internal/site/dist/

RUN CGO_ENABLED=0 GOOS=linux go build \
        -buildvcs=false \
        -trimpath \
        -ldflags="-s -w" \
        -o /out/galata-server \
        ./cmd/galata-server

# The production-mode scan target contains only the statically linked server.
# It is not a deployment image.
FROM scratch AS scan-target

COPY --from=server-builder /out/galata-server /galata-server

USER 65532:65532
EXPOSE 3000

ENTRYPOINT ["/galata-server"]
