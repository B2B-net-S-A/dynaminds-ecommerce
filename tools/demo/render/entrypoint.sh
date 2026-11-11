#!/bin/bash
# One container, one disk: PostgreSQL 18 on loopback, the demo's local KSeF/printer fakes, the packaged release and its public
# entrance (edge.mjs). The release needs its own superuser-owned cluster on loopback, so a managed database cannot replace it.
set -euo pipefail
export DYNA_PUBLIC_ORIGIN="${DYNA_PUBLIC_ORIGIN:-${RENDER_EXTERNAL_URL:-}}"   # Render sets the service's own https address.
: "${DEMO_ENCRYPTION_KEY:?required}" "${DEMO_BASIC_AUTH_PASSWORD:?required}" "${DYNA_PUBLIC_ORIGIN:?required}"
export DEMO_BASIC_AUTH_USER="${DEMO_BASIC_AUTH_USER:-demo}"
DATA="${DEMO_DATA_DIR:-/var/data}"; PGDATA="$DATA/pg"; SECRETS="$DATA/secrets"; APP_PORT=4300; DB=dynaminds_demo; SNAP=dynaminds_demo_snapshot
OPT=/opt/dyna; KSEF_PORT=4239; PRINTER_PORT=4233
export DEMO_APP_PORT=$APP_PORT PORT="${PORT:-10000}"
as_pg() { gosu postgres env -u DEMO_ENCRYPTION_KEY -u DEMO_BASIC_AUTH_PASSWORD "$@"; }
as_app() { gosu dyna env -u DEMO_ENCRYPTION_KEY -u DEMO_BASIC_AUTH_PASSWORD "$@"; }
psql_on() { local db="$1"; shift; gosu postgres env -u DEMO_ENCRYPTION_KEY PGPASSFILE="$PGDATA/.demo-pgpass" psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -U postgres -d "$db" "$@"; }

pids=()
stop_all() { for ((i=${#pids[@]}-1; i>=0; i--)); do kill -TERM "${pids[i]}" 2>/dev/null || true; sleep 1; done; [ ! -s "$PGDATA/postmaster.pid" ] || as_pg pg_ctl -D "$PGDATA" -m fast -w stop || true; }
trap 'exit 0' TERM INT
trap stop_all EXIT

# The public port first: the platform waits for it, and the visitor sees "starting" instead of an error.
# /api/health reports the release commit, so the deploy pipeline can tell the new build from the old one.
DEMO_RELEASE_COMMIT="$(node -p 'require("/opt/dyna/release-build.json").commit ?? ""' 2>/dev/null || true)"; export DEMO_RELEASE_COMMIT
gosu dyna env -u DEMO_ENCRYPTION_KEY node "$OPT/edge.mjs" & pids+=($!)
unset DEMO_BASIC_AUTH_PASSWORD

install -d -m 0755 "$DATA"
# One instance per disk: a platform that starts the new container before stopping the old one (rolling update) would
# otherwise run two clusters on one PGDATA, because the pid file is removed below. The lock lives as long as this shell
# and its children; the new container waits for the old one to stop.
exec 9>"$DATA/.instance.lock"
flock -w "${DEMO_INSTANCE_LOCK_WAIT_SECONDS:-600}" 9 || { echo "DEMO_INSTANCE_LOCK: another instance still holds $DATA"; exit 1; }
install -d -m 0700 -o dyna -g dyna "$SECRETS" "$DATA/images" "$DATA/state"
# .seeded holds the sha256 of the dump the disk was seeded from. An image with another dump seeds the disk again from
# scratch (visitors' changes are lost); an image with the same dump keeps the database. A disk seeded before the sha was
# recorded has an empty .seeded and is seeded again once.
DUMP_SHA="$(sha256sum "$OPT/data/demo.dump" | cut -d' ' -f1)"
if [ -e "$DATA/.seeded" ] && [ "$(cat "$DATA/.seeded")" != "$DUMP_SHA" ]; then
  echo "DEMO_RESEED: the image carries another demo dump, seeding the disk again"; rm -f "$DATA/.seeded" "$DATA/.resetting"
fi
# .seeded is written last, so an interrupted first start begins again on a clean cluster instead of an empty database.
[ -e "$DATA/.seeded" ] || rm -rf "$PGDATA"
install -d -m 0700 -o postgres -g postgres "$PGDATA"
rm -f "$PGDATA/postmaster.pid"   # A disk belongs to one instance; a killed one leaves this behind.
FIRST=0
if [ ! -e "$DATA/.seeded" ]; then
  FIRST=1
  node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))' > "$SECRETS/postgres.password"
  chown dyna:dyna "$SECRETS/postgres.password"; chmod 0600 "$SECRETS/postgres.password"
  install -m 0600 -o postgres -g postgres "$SECRETS/postgres.password" /tmp/pg.pw
  as_pg initdb -D "$PGDATA" -U postgres --pwfile=/tmp/pg.pw --auth=scram-sha-256 --locale=C.UTF-8 --encoding=UTF8 >/dev/null
  rm -f /tmp/pg.pw
  install -m 0600 -o postgres -g postgres /dev/null "$PGDATA/.demo-pgpass"
  printf '127.0.0.1:5432:*:postgres:%s\n' "$(cat "$SECRETS/postgres.password")" > "$PGDATA/.demo-pgpass"
fi
as_pg cp "$OPT/postgresql.demo.conf" "$PGDATA/postgresql.demo.conf"
grep -q postgresql.demo.conf "$PGDATA/postgresql.conf" || echo "include 'postgresql.demo.conf'" >> "$PGDATA/postgresql.conf"
as_pg pg_ctl -D "$PGDATA" -l "$PGDATA/server.log" -w -t 120 start >/dev/null

node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1],JSON.stringify({dbPassword:fs.readFileSync(process.argv[2],"utf8"),encryptionKey:process.env.DEMO_ENCRYPTION_KEY}),{mode:0o600})' \
  "$SECRETS/local-config.json" "$SECRETS/postgres.password"
chown dyna:dyna "$SECRETS/local-config.json"

seed_files() { rm -rf "$DATA/images"; install -d -m 0700 -o dyna -g dyna "$DATA/images"; cp -Rp "$OPT/data/images/." "$DATA/images/"; chown -R dyna:dyna "$DATA/images"
  install -m 0600 -o dyna -g dyna "$OPT/data/printer-state.json" "$DATA/state/printer-state.json"; }
if [ "$FIRST" = 1 ]; then
  grep -v -E '^(CREATE ROLE postgres|ALTER ROLE postgres)' "$OPT/data/roles.sql" | psql_on postgres
  psql_on postgres -c "CREATE DATABASE $DB"
  gosu postgres env PGPASSFILE="$PGDATA/.demo-pgpass" pg_restore -h 127.0.0.1 -U postgres -d "$DB" --single-transaction --exit-on-error --no-owner "$OPT/data/demo.dump"
  # The owner-default ACLs pg_dump omits (build-image.sh); without them a dump at 266 or later stops the release start.
  psql_on "$DB" -1 -f "$OPT/data/owner-default-acls.sql"
  psql_on "$DB" -f "$OPT/data/262_revoke_public_temporary.sql"
  psql_on postgres -c "CREATE DATABASE $SNAP TEMPLATE $DB" -c "ALTER DATABASE $SNAP WITH ALLOW_CONNECTIONS false IS_TEMPLATE true"
  seed_files
  printf '%s\n' "$DUMP_SHA" > "$DATA/.seeded.tmp"; mv -f "$DATA/.seeded.tmp" "$DATA/.seeded"
elif [ "${DEMO_RESET_ON_BOOT:-0}" = 1 ] || [ -e "$DATA/.resetting" ]; then
  # Back to the initial demo data. Set the variable, restart, then remove it, or every restart resets.
  touch "$DATA/.resetting"
  psql_on postgres -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" -c "CREATE DATABASE $DB TEMPLATE $SNAP"
  psql_on "$DB" -f "$OPT/data/262_revoke_public_temporary.sql"
  seed_files
  rm -f "$DATA/.resetting"
  echo "DEMO_RESET_DONE"
fi
unset DEMO_ENCRYPTION_KEY

printf '+0\n' > "$DATA/state/faketime.rc"; chown dyna:dyna "$DATA/state/faketime.rc"
as_app node "$OPT/fakes.mjs" $KSEF_PORT $PRINTER_PORT "$DATA/state/faketime.rc" "$DATA/state/printer-state.json" & pids+=($!)

node -e 'const fs=require("fs");const [secrets,opt,db]=process.argv.slice(1);const cfg=JSON.parse(fs.readFileSync(secrets+"/local-config.json","utf8"));const r=JSON.parse(fs.readFileSync(opt+"/release-build.json","utf8"));
fs.writeFileSync(secrets+"/selection.json",JSON.stringify({releaseDirectory:opt+"/release-canonical",manifestSha:r.release_manifest_sha256,expectedOwner:"postgres",databaseUrl:`postgres://postgres:${encodeURIComponent(cfg.dbPassword)}@127.0.0.1:5432/${db}`,localConfigurationPath:secrets+"/local-config.json",revision:r.release_manifest_sha256}),{mode:0o600})' \
  "$SECRETS" "$OPT" "$DB"
chown dyna:dyna "$SECRETS/selection.json"
SEL_SHA="$(sha256sum "$SECRETS/selection.json" | cut -d' ' -f1)"
cd "$OPT"
as_app env DYNA_LOCAL_CONFIG_PATH="$SECRETS/local-config.json" DYNA_IMAGE_DIR="$DATA/images" DYNA_DATA_DIR="$DATA/state" \
  DYNA_KSEF_FAKE=local DYNA_PAYU_FAKE=local DYNA_MIGRATION_BACKUP=off DYNA_RATE_LIMIT_PER_MIN=3000 DYNA_PUBLIC_ORIGIN="$DYNA_PUBLIC_ORIGIN" TZ=Europe/Warsaw \
  node "$OPT/release-canonical/runtime/server/ordinary-local-cli.mjs" "$SECRETS/selection.json" "$SEL_SHA" "$APP_PORT" --scoped-automation & pids+=($!)
# Any process ending ends the container; the platform restarts it.
set +e; wait -n; exit $?
