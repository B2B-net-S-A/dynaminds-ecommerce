#!/bin/bash
# Client demo instance of DYNAMINDS Ecommerce (local only). See docs/demo/SCENARIUSZ-DEMO-20261030.md.
#
#   tools/demo/demo.sh start      demo PostgreSQL, local fakes, relays, packaged release on http://127.0.0.1:4300
#   tools/demo/demo.sh stop       stop the app, relays, fakes and the demo PostgreSQL (data stays)
#   tools/demo/demo.sh status     containers, fakes, /api/health summary
#   tools/demo/demo.sh reset      demo database back to its snapshot (CREATE DATABASE … TEMPLATE), images too; restarts the app
#   tools/demo/demo.sh woo-order  one new order in the bound local WooCommerce store (imported within ~1–2 min)
#   tools/demo/demo.sh woo-ca     after `operator.mjs renew-tls`: the demo copy of the store CA and its pin follow, restart
#   tools/demo/demo.sh build      packaged release of HEAD (tools/scale/release-build.mjs) for the demo
#   tools/demo/demo.sh seed       fresh demo database + curated demo company (tools/demo/seed.mjs), Woo channel, snapshot
#   tools/demo/demo.sh guards     the 16 guards on the demo database (read only)
#
# Isolation: own Docker PostgreSQL dyna-scale-demo-pg18 (127.0.0.1:57095, volumes dyna-scale-demo-pg18-*), own port 4300.
# Never touches Main (4100, app/data/postgres), PG04 (57084) or the scale containers. No real provider, KSeF/MF or carrier
# calls: KSeF and the fiscal printer are local fakes (tools/demo/fakes.mts); carriers run in their simulation channels.
# Private state (passwords, keys, selection files) lives in $DEMO_ROOT (0700, outside the repository).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
die() { echo "demo: $*" >&2; exit 1; }
W="$REPO"; while [ "$W" != / ] && [ ! -d "$W/local-builds" ]; do W="$(dirname "$W")"; done
[ -d "$W/local-builds" ] || die "no local-builds/ above $REPO"
DEMO_ROOT="${DEMO_ROOT:-$W/local-builds/dyna-demo}"
PORT="${DEMO_HTTP_PORT:-4300}"
PG_PORT="${DEMO_PG_PORT:-57095}"
DB=dynaminds_demo; SNAP=dynaminds_demo_snapshot
CONTAINER=dyna-scale-demo-pg18; APP=dyna-demo-app; FWD=dyna-demo-fwd
KSEF_PORT=4239; PRINTER_PORT=4233
NODE_IMAGE="node:22.23.0-trixie-slim@sha256:cfd8f2a5bc50526aee08e88970979f92722828e7dcc6d8983607fb8bff4bdb82"
PRIV="$DEMO_ROOT/private"; LOGS="$DEMO_ROOT/logs"; STATE="$DEMO_ROOT/pg-state"
for p in 4100 5432 57084 57090 57091; do [ "$PG_PORT" != "$p" ] && [ "$PORT" != "$p" ] || die "port $p is reserved (Main/PG04/scale)"; done

pg() { SCALE_PG_CONTAINER=$CONTAINER SCALE_PG_PORT=$PG_PORT SCALE_PG_STATE="$STATE" SCALE_PG_COMPOSE_OVERRIDE="$HERE/compose.demo.yml" \
  DEMO_HTTP_PORT=$PORT "$REPO/tools/scale/docker/scale-pg.sh" "$@"; }
psql_in() { local db="$1"; shift; docker exec -i "$CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d "$db" "$@"; }
running() { [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null || echo false)" = true ]; }
release_record() { [ -s "$DEMO_ROOT/release-build.path" ] || die "no release; run: tools/demo/demo.sh build"; cat "$DEMO_ROOT/release-build.path"; }

init_state() {
  umask 077
  mkdir -p "$DEMO_ROOT" "$PRIV" "$LOGS" "$DEMO_ROOT/images" "$STATE/secrets" "$STATE/faketime" "$STATE/dumps"
  chmod 0700 "$DEMO_ROOT" "$PRIV" "$LOGS" "$STATE" "$STATE/secrets" "$STATE/faketime" "$STATE/dumps"
  [ -s "$STATE/secrets/postgres.password" ] || openssl rand -hex 32 > "$STATE/secrets/postgres.password"
  [ -s "$STATE/faketime/faketime.rc" ] || { echo "+0" > "$STATE/faketime/faketime.rc"; chmod 0644 "$STATE/faketime/faketime.rc"; }
  # Own encryption key (the demo database starts empty; nothing encrypted with another key is read).
  [ -s "$STATE/local-config.json" ] || node -e 'const fs=require("fs");fs.writeFileSync(process.argv[2],JSON.stringify({dbPassword:fs.readFileSync(process.argv[1],"utf8").trim(),encryptionKey:require("crypto").randomBytes(32).toString("hex")}),{mode:0o600})' \
    "$STATE/secrets/postgres.password" "$STATE/local-config.json"
}

# selection.json (release CLI) and app.env; the database URL carries the local password, so both are 0600 in $PRIV.
write_private() {
  local rb; rb="$(release_record)"
  node -e '
const fs=require("fs");const [priv,state,rbPath,db,root]=process.argv.slice(1);const rb=JSON.parse(fs.readFileSync(rbPath,"utf8"));
const cfg=JSON.parse(fs.readFileSync(state+"/local-config.json","utf8"));
const url=`postgres://postgres:${encodeURIComponent(cfg.dbPassword)}@127.0.0.1:5432/${db}`;
const w=(f,s)=>{fs.writeFileSync(f+".tmp",s,{mode:0o600});fs.renameSync(f+".tmp",f);};
w(priv+"/selection.json",JSON.stringify({releaseDirectory:rb.release_directory,manifestSha:rb.release_manifest_sha256,expectedOwner:"postgres",databaseUrl:url,localConfigurationPath:state+"/local-config.json",revision:rb.release_manifest_sha256}));
w(priv+"/app.env",[`DATABASE_URL=${url}`,`DYNA_LOCAL_CONFIG_PATH=${state}/local-config.json`,`DYNA_IMAGE_DIR=${root}/images`,
 "DYNA_KSEF_FAKE=local","DYNA_PAYU_FAKE=local","DYNA_MIGRATION_BACKUP=off","DYNA_RATE_LIMIT_PER_MIN=3000","TZ=Europe/Warsaw",""].join("\n"));
' "$PRIV" "$STATE" "$rb" "$DB" "$DEMO_ROOT"
}

fakes_alive() { [ -s "$PRIV/fakes.pid" ] && kill -0 "$(cat "$PRIV/fakes.pid")" 2>/dev/null; }
start_fakes() {
  fakes_alive && return 0
  : > "$LOGS/fakes.log"
  nohup node "$REPO/node_modules/tsx/dist/cli.mjs" "$HERE/fakes.mts" $KSEF_PORT $PRINTER_PORT \
    "$STATE/faketime/faketime.rc" "$PRIV/printer-state.json" < /dev/null >> "$LOGS/fakes.log" 2>&1 &
  echo $! > "$PRIV/fakes.pid"
  for _ in $(seq 1 60); do grep -q DEMO_FAKES_LISTENING "$LOGS/fakes.log" && return 0; fakes_alive || break; sleep 0.5; done
  tail -20 "$LOGS/fakes.log" >&2; die "fakes did not start"
}
stop_fakes() { if fakes_alive; then kill "$(cat "$PRIV/fakes.pid")"; fi; rm -f "$PRIV/fakes.pid"; }

woo_ports() { [ -s "$PRIV/woo-ports" ] && cat "$PRIV/woo-ports" || true; }
start_fwd() {
  docker rm -f "$FWD" >/dev/null 2>&1 || true
  local relays=("0.0.0.0:14300=127.0.0.1:$PORT" "127.0.0.1:$KSEF_PORT=host.docker.internal:$KSEF_PORT" "127.0.0.1:$PRINTER_PORT=host.docker.internal:$PRINTER_PORT")
  for p in $(woo_ports); do relays+=("127.0.0.1:$p=host.docker.internal:$p"); done
  docker run -d --init --name "$FWD" --network "container:$CONTAINER" --user "$(id -u):$(id -g)" --memory 64m --read-only \
    -v "$HERE:/demo:ro" "$NODE_IMAGE" node /demo/forward.mjs "${relays[@]}" >/dev/null
}

# The release CLI in the database container's network namespace (its cold identity check needs a loopback session on
# the server's own port; tools/scale/docker/README.md "Release"). The local Woo store root is masked (tmpfs): the
# release reads only its copies of the CA and the importer key in $PRIV/woo.
app_args() {
  local sel="$PRIV/selection.json" args
  args=("$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).release_directory)' "$(release_record)")/runtime/server/ordinary-local-cli.mjs"
    "$sel" "$(shasum -a 256 "$sel" | cut -d' ' -f1)" "$PORT" --scoped-automation)
  if [ -s "$PRIV/woo/selection.json" ]; then
    args+=(--local-woo-stores "$PRIV/woo/selection.json" "$(shasum -a 256 "$PRIV/woo/selection.json" | cut -d' ' -f1)" --local-woo-reads --local-woo-stock)
  fi
  printf '%s\n' "${args[@]}"
}
start_app() {
  running "$APP" && return 0
  docker rm -f "$APP" >/dev/null 2>&1 || true
  write_private
  local mask=() args=()
  [ -s "$PRIV/woo-root" ] && mask=(--mount "type=tmpfs,destination=$(cat "$PRIV/woo-root")")
  while IFS= read -r l; do args+=("$l"); done < <(app_args)
  docker run -d --init --name "$APP" --network "container:$CONTAINER" --user "$(id -u):$(id -g)" \
    -v "$W:$W" ${mask[@]+"${mask[@]}"} -w "$REPO" --env-file "$PRIV/app.env" "$NODE_IMAGE" node "${args[@]}" >/dev/null
  local t0=$SECONDS
  until docker logs "$APP" 2>&1 | grep -q ORDINARY_LOCAL_APP_LISTENING; do
    running "$APP" || { docker logs "$APP" 2>&1 | tail -20 >&2; die "app exited"; }
    [ $((SECONDS - t0)) -lt 900 ] || die "app not listening after 900 s"
    sleep 2
  done
  docker logs "$APP" > "$LOGS/app-start.log" 2>&1 || true
  echo "app listening after $((SECONDS - t0)) s"
}
stop_app() { if running "$APP"; then docker stop -t 60 "$APP" >/dev/null; fi; docker logs "$APP" >> "$LOGS/app.log" 2>&1 || true; docker rm -f "$APP" >/dev/null 2>&1 || true; }

health() { curl -fsS --max-time 10 "http://127.0.0.1:$PORT/api/health"; }
health_summary() {
  health | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const h=JSON.parse(s);const keep=["ok","status","schema_revision","revision","background_workers_enabled","scoped_automation_enabled","local_woo_reads_enabled","local_woo_read_processor_running","local_woo_stock_enabled","local_woo_stock_processor_running","local_woo_stock_blocked_channels","rate_limit"];console.log(JSON.stringify(Object.fromEntries(keep.filter(k=>k in h).map(k=>[k,h[k]])),null,1))})'
}

# The app always runs on the real clock; a killed seeder can leave the offset file moved.
clock_real() { [ "$(tr -d '[:space:]' < "$STATE/faketime/faketime.rc")" = "+0" ] || { rm -f "$STATE/faketime/faketime.rc.lock"; printf '+0\n' > "$STATE/faketime/faketime.rc"; sleep 2.2; }; }
start() {
  init_state
  clock_real
  running "$CONTAINER" || pg up
  start_fakes
  running "$FWD" || start_fwd
  start_app
  health_summary
  echo "DYNAMINDS demo: http://127.0.0.1:$PORT  (credentials: tools/demo/CREDENTIALS.local.md)"
}
stop() { stop_app; docker rm -f "$FWD" >/dev/null 2>&1 || true; stop_fakes; if running "$CONTAINER"; then pg stop; fi; }
status() {
  for c in "$CONTAINER" "$FWD" "$APP"; do printf '%-24s %s\n' "$c" "$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$c" 2>/dev/null || echo missing)"; done
  printf '%-24s %s\n' fakes "$(fakes_alive && echo "running pid $(cat "$PRIV/fakes.pid")" || echo stopped)"
  if running "$CONTAINER"; then psql_in postgres -At -c "SELECT datname||' '||pg_size_pretty(pg_database_size(datname)) FROM pg_database WHERE datname LIKE 'dynaminds_demo%' ORDER BY 1"; fi
  if running "$APP"; then health_summary; fi
}

snapshot() {
  stop_app
  # A template database cannot be dropped; the previous snapshot is unmarked first.
  if [ "$(psql_in postgres -At -c "SELECT count(*) FROM pg_database WHERE datname='$SNAP'")" = 1 ]; then
    psql_in postgres -c "ALTER DATABASE $SNAP WITH IS_TEMPLATE false"
  fi
  psql_in postgres -c "DROP DATABASE IF EXISTS $SNAP WITH (FORCE)" -c "CREATE DATABASE $SNAP TEMPLATE $DB" \
    -c "ALTER DATABASE $SNAP WITH ALLOW_CONNECTIONS false IS_TEMPLATE true"
  rm -rf "$DEMO_ROOT/images-snapshot"; cp -Rp "$DEMO_ROOT/images" "$DEMO_ROOT/images-snapshot"
  [ ! -s "$PRIV/woo/state.json" ] || cp -p "$PRIV/woo/state.json" "$PRIV/woo/state.snapshot.json"
  echo "snapshot $SNAP"
}
reset() {
  running "$CONTAINER" || { init_state; pg up; }
  [ "$(psql_in postgres -At -c "SELECT count(*) FROM pg_database WHERE datname='$SNAP'")" = 1 ] || die "no snapshot $SNAP (run seed)"
  stop_app
  psql_in postgres -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" -c "CREATE DATABASE $DB TEMPLATE $SNAP"
  # The database ACL is not copied by TEMPLATE; the release refuses to start without migration 262's revoke.
  psql_in "$DB" < "$REPO/server/262_revoke_public_temporary.sql"
  rm -rf "$DEMO_ROOT/images"; cp -Rp "$DEMO_ROOT/images-snapshot" "$DEMO_ROOT/images"
  [ ! -s "$PRIV/woo/state.snapshot.json" ] || cp -p "$PRIV/woo/state.snapshot.json" "$PRIV/woo/state.json"
  echo "database $DB restored from $SNAP"
  start
}

# One seeder container in the namespace (release runtime in-process, ordinary HTTP routes through app.inject).
seed_node() {
  write_private
  docker rm -f dyna-demo-seed >/dev/null 2>&1 || true
  docker run --rm --init --name dyna-demo-seed --network "container:$CONTAINER" --user "$(id -u):$(id -g)" \
    -v "$W:$W" -w "$REPO" --env-file "$PRIV/app.env" -e DEMO_ROOT="$DEMO_ROOT" -e DEMO_RELEASE="$(release_record)" \
    -e DEMO_FAKETIME_FILE="$STATE/faketime/faketime.rc" -e DEMO_KSEF_PORT=$KSEF_PORT -e DEMO_PRINTER_PORT=$PRINTER_PORT \
    "$NODE_IMAGE" node "$@"
}

cmd="${1:-status}"; shift || true
case "$cmd" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  reset) reset ;;
  build)
    base="$W/local-builds/full-base-preview-20261017/base-wire-n29-20261023-01/source-contract"
    out="$W/local-builds/full-base-preview-20261017/demo-release-$(date +%Y%m%d-%H%M%S)"
    node "$REPO/tools/scale/release-build.mjs" --out "$out" --base-contract "$base" \
      --base-contract-sha 548e34291ded9998cef9c7db7392e7ff4a5f377ed833c332e51f0209cd90cc06 > "$LOGS/build.log"
    init_state; echo "$out/release-build.json" > "$DEMO_ROOT/release-build.path"; tail -3 "$LOGS/build.log"; echo "release $out"
    ;;
  seed)
    init_state
    clock_real
    running "$CONTAINER" || pg up
    stop_app
    psql_in postgres -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" -c "CREATE DATABASE $DB"
    rm -rf "$DEMO_ROOT/images"; mkdir -m 0700 "$DEMO_ROOT/images"; rm -rf "$PRIV/woo"
    rm -f "$PRIV/woo-ports" "$PRIV/woo-root"
    python3 "$HERE/product-images.py" "$HERE/catalog.json" "$PRIV/product-images"
    stop_fakes; start_fakes; start_fwd   # fresh fakes: no fiscal day or KSeF session of an earlier run
    seed_node tools/demo/seed.mjs "$@"
    start_app
    node "$HERE/seed-woo.mjs" "$DEMO_ROOT" "http://127.0.0.1:$PORT"
    stop_app; start_fwd; start_app   # restart with the Woo selection (the relays now include the store ports)
    node "$HERE/seed-woo.mjs" "$DEMO_ROOT" "http://127.0.0.1:$PORT" --lanes
    snapshot
    start
    ;;
  woo-order) node "$HERE/seed-woo.mjs" "$DEMO_ROOT" "http://127.0.0.1:$PORT" --order ;;
  woo-ca) node "$HERE/seed-woo.mjs" "$DEMO_ROOT" "http://127.0.0.1:$PORT" --refresh-ca; stop; start ;;
  guards) seed_node tools/demo/guards.mjs ;;
  seed-node) seed_node "$@" ;;   # internal: run a node script in the namespace with the demo env
  *) die "unknown command $cmd (start|stop|status|reset|woo-order|woo-ca|build|seed|guards)" ;;
esac
