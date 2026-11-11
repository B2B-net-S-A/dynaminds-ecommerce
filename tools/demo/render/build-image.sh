#!/bin/bash
# Prepares the image context from a packaged release and the demo snapshot, and builds the image.
#   tools/demo/render/build-image.sh <release-build.json> <image tag> [platform, default linux/amd64]
# Context and private values stay in local-builds/render-demo (outside the repository); the demo's encryption key goes to
# private/render.env, 0600, and is never part of the image. Needs the demo instance's containers (tools/demo/demo.sh).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; REPO="$(cd "$HERE/../../.." && pwd)"
RB="${1:?release-build.json}"; TAG="${2:?image tag}"; PLATFORM="${3:-linux/amd64}"
W="$REPO"; while [ "$W" != / ] && [ ! -d "$W/local-builds" ]; do W="$(dirname "$W")"; done
ROOT="$W/local-builds/render-demo"; CTX="$ROOT/context"; DEMO="$W/local-builds/dyna-demo"; PG=dyna-scale-demo-pg18
umask 077; mkdir -p "$ROOT/private"; rm -rf "$CTX"; mkdir -p "$CTX/data/images"
RELEASE="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).release_directory' "$RB")"
cp -Rp "$RELEASE" "$CTX/release-canonical"; cp "$RB" "$CTX/release-build.json"
cp "$HERE/edge.mjs" "$HERE/postgresql.demo.conf" "$HERE/entrypoint.sh" "$HERE/Dockerfile" "$CTX/"
(cd "$REPO" && npx esbuild "$REPO/tools/demo/fakes.mts" --bundle --platform=node --format=esm --outfile="$CTX/fakes.mjs" --log-level=warning \
  --define:import.meta.url='"file:///demo-fakes-bundle"' \
  --banner:js="import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);")
cp "$REPO/server/262_revoke_public_temporary.sql" "$CTX/data/"
cp -Rp "$DEMO/images-snapshot/." "$CTX/data/images/"
cp "$DEMO/private/printer-state.json" "$CTX/data/printer-state.json"
docker exec "$PG" psql -X -q -U postgres -c "DROP DATABASE IF EXISTS render_dump_src" -c "CREATE DATABASE render_dump_src TEMPLATE dynaminds_demo_snapshot"
docker exec "$PG" pg_dump -U postgres -d render_dump_src --format=custom --no-owner -Z6 -f /tmp/demo.dump
docker exec "$PG" pg_dumpall -U postgres --roles-only --no-role-passwords -f /tmp/roles.sql
# pg_dump omits an explicit ACL equal to the owner's default and the restore leaves it NULL. The release's ACL normalizer
# re-materializes it only for the migrations it lists (up to 261), so a dump at 266 or later stops the release start
# ("267 exact complete addition descriptor:relation public.automation267_editors"). The entrypoint replays these grants
# after pg_restore, which gives back the snapshot's ACLs exactly; the release still runs its own strict comparison.
docker exec -i "$PG" psql -X -q -At -v ON_ERROR_STOP=1 -U postgres -d render_dump_src > "$CTX/data/owner-default-acls.sql" <<'SQL'
SELECT format('GRANT ALL ON %s %I.%I TO %I;', CASE WHEN c.relkind='S' THEN 'SEQUENCE' ELSE 'TABLE' END, n.nspname, c.relname, pg_get_userbyid(c.relowner))
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname<>'information_schema' AND n.nspname NOT LIKE 'pg\_%'
  AND c.relacl=acldefault(CASE WHEN c.relkind='S' THEN 's' ELSE 'r' END::"char", c.relowner)
UNION ALL
SELECT format('GRANT ALL ON SCHEMA %I TO %I;', n.nspname, pg_get_userbyid(n.nspowner))
FROM pg_namespace n
WHERE n.nspname NOT IN ('information_schema','public') AND n.nspname NOT LIKE 'pg\_%' AND n.nspacl=acldefault('n', n.nspowner)
ORDER BY 1;
SQL
docker exec "$PG" psql -X -q -U postgres -c "DROP DATABASE render_dump_src"
docker cp -q "$PG:/tmp/demo.dump" "$CTX/data/demo.dump"; docker cp -q "$PG:/tmp/roles.sql" "$CTX/data/roles.sql"; docker exec "$PG" rm -f /tmp/demo.dump /tmp/roles.sql
printf '.git\n' > "$CTX/.dockerignore"
chmod -R go+rX "$CTX"
{ echo "DEMO_ENCRYPTION_KEY=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).encryptionKey' "$DEMO/pg-state/local-config.json")"
  [ -s "$ROOT/private/basic-auth" ] || node -e 'process.stdout.write(require("crypto").randomBytes(18).toString("base64url"))' > "$ROOT/private/basic-auth"
  echo "DEMO_BASIC_AUTH_PASSWORD=$(cat "$ROOT/private/basic-auth")"; } > "$ROOT/private/render.env"
docker buildx build --platform "$PLATFORM" --load -t "$TAG" "$CTX"
echo "image $TAG ($PLATFORM), private values in $ROOT/private/render.env"
