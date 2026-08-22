# syntax=docker/dockerfile:1

FROM golang:1.26.5-alpine AS fixture-builder

WORKDIR /src

COPY tests/fixtures/deploy-health-server.go ./

RUN CGO_ENABLED=0 GOOS=linux go build \
      -buildvcs=false \
      -trimpath \
      -o /out/galata-deploy-health-server \
      ./deploy-health-server.go

# Match the operating system required by ops/setup-server.sh. This image runs
# systemd because the behavior under test is systemd's EnvironmentFile merge
# order for transient candidate services.
FROM ubuntu:26.04

ARG DEBIAN_FRONTEND=noninteractive
ENV container=docker

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      curl \
      logrotate \
      nginx \
      rsync \
      systemd \
      systemd-sysv \
    && rm -rf /var/lib/apt/lists/* \
    && systemctl mask \
      dev-hugepages.mount \
      sys-fs-fuse-connections.mount \
      systemd-remount-fs.service

COPY ops/deploy-helper.sh /usr/local/sbin/galata-deploy-helper
COPY ops/logrotate/galata-nginx /etc/logrotate.d/galata-nginx
COPY ops/runtime-environment.sh /usr/local/libexec/galata-runtime-environment.sh
COPY ops/systemd/galata-server.service /etc/systemd/system/galata-server.service
COPY ops/systemd/galata-dev-server.service /etc/systemd/system/galata-dev-server.service
COPY ops/deploy-test/run.sh /usr/local/sbin/run-galata-deploy-test
COPY --from=fixture-builder /out/galata-deploy-health-server /usr/local/libexec/galata-deploy-health-server

RUN chmod 0755 \
      /usr/local/sbin/galata-deploy-helper \
      /usr/local/sbin/run-galata-deploy-test \
      /usr/local/libexec/galata-runtime-environment.sh \
      /usr/local/libexec/galata-deploy-health-server \
    && chmod 0644 /etc/logrotate.d/galata-nginx \
    && logrotate --debug /etc/logrotate.conf

STOPSIGNAL SIGRTMIN+3

CMD ["/sbin/init"]
