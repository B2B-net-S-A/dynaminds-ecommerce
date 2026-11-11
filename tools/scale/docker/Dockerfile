# Dedicated PostgreSQL 18 for the stage 5 scale dataset and measurement (docs/scale/MEASUREMENT-MANIFEST-20261025.md).
# Same major/minor as PG04 (18.4, arm64). libfaketime is preloaded into every server process so the
# generator can move the database clock day by day (tools/scale/simclock.mjs); see README.md.
FROM postgres:18.4-trixie@sha256:a02db8cac496f15b094798a38254f14d6e00741f709360e5e00bb6668ea31636
RUN apt-get update \
 && apt-get install -y --no-install-recommends libfaketime \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /usr/local/lib/faketime /faketime /wal-archive \
 && ln -s "$(dpkg -L libfaketime | grep '/libfaketime.so.1$')" /usr/local/lib/faketime/libfaketime.so.1 \
 && test -e /usr/local/lib/faketime/libfaketime.so.1 \
 && chown postgres:postgres /wal-archive && chmod 0700 /wal-archive
COPY --chmod=0755 postgres-faketime.sh /usr/local/lib/faketime/postgres-faketime.sh
RUN mv /usr/lib/postgresql/18/bin/postgres /usr/lib/postgresql/18/bin/postgres.real \
 && cp /usr/local/lib/faketime/postgres-faketime.sh /usr/lib/postgresql/18/bin/postgres
COPY postgresql.scale.conf /etc/postgresql/postgresql.scale.conf
# WAL archive / restore commands (zstd, fsync before success); see tools/recovery/README.md.
COPY --chmod=0755 dyna-wal-archive dyna-wal-restore /usr/local/bin/
COPY initdb/ /docker-entrypoint-initdb.d/
