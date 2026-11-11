# Hosted client demo. Context prepared by tools/demo/render/build-image.sh.
FROM postgres:18.4-trixie
ENV NODE_VERSION=22.23.0
RUN set -eu; apt-get update; apt-get install -y --no-install-recommends ca-certificates curl xz-utils; \
    arch="$(dpkg --print-architecture)"; case "$arch" in amd64) n=x64;; arm64) n=arm64;; *) exit 1;; esac; \
    f="node-v$NODE_VERSION-linux-$n.tar.xz"; cd /tmp; curl -fsSLO "https://nodejs.org/dist/v$NODE_VERSION/$f"; \
    curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" | grep " $f\$" | sha256sum -c -; \
    tar -xJf "$f" -C /usr/local --strip-components=1 --no-same-owner; rm -f "$f"; apt-get purge -y curl xz-utils; apt-get autoremove -y; rm -rf /var/lib/apt/lists/*; \
    useradd --system --create-home --shell /usr/sbin/nologin dyna
COPY release-canonical /opt/dyna/release-canonical
COPY release-build.json edge.mjs fakes.mjs postgresql.demo.conf /opt/dyna/
COPY data /opt/dyna/data
COPY entrypoint.sh /usr/local/bin/dyna-demo
# Runtime packages resolve their locked dependencies from an ancestor node_modules.
RUN cd /opt/dyna && cp release-canonical/package.json release-canonical/package-lock.json . && npm ci --omit=dev --ignore-scripts --no-audit --no-fund && chown -R root:root /opt/dyna && chmod -R go-w,go+rX /opt/dyna && chmod 0755 /usr/local/bin/dyna-demo
ENV PORT=10000
EXPOSE 10000
ENTRYPOINT ["/usr/local/bin/dyna-demo"]
