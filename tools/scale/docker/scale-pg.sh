#!/bin/bash
# Dedicated Docker PostgreSQL 18.4 (+ libfaketime) for the stage 5 scale dataset. See README.md.
#
#   tools/scale/docker/scale-pg.sh up                 build + start, wait for the healthcheck
#   tools/scale/docker/scale-pg.sh stop | down        stop the container (named volumes stay)
#   tools/scale/docker/scale-pg.sh status             container, healthcheck, version, clock, key settings
#   tools/scale/docker/scale-pg.sh clock [show|real|set <ISO>]   database clock (libfaketime offset file)
#   tools/scale/docker/scale-pg.sh dump-template      pg_dump of the PG04 template (read-only on PG04)
#   tools/scale/docker/scale-pg.sh restore-template   restore that dump here + compare table counts with PG04
#   tools/scale/docker/scale-pg.sh clone <dynaminds_scale_YYYYMMDD_NN>   clone template, real migrate(), guards
#   tools/scale/docker/scale-pg.sh env <db>           print exports for the generator (contains the local password)
#   tools/scale/docker/scale-pg.sh psql [db] [psql args…]
#   tools/scale/docker/scale-pg.sh netns-node <db> [node args…]   node (Linux, NODE_IMAGE) inside this container's
#                                                    network namespace: 127.0.0.1:5432 is the server, as the packaged
#                                                    release's cold identity check requires (see README, "Release")
#   tools/scale/docker/scale-pg.sh config            resolved instance names + compose config (offline, writes nothing)
#   tools/scale/docker/scale-pg.sh vacuum-loop <db> [seconds≥60, default 600]   detached sidecar in this container's
#                                                    network namespace: VACUUM (ANALYZE, SKIP_LOCKED) every interval.
#                                                    While the libfaketime clock is moved back autovacuum does not run
#                                                    (29.10: 100 000 new SKU never analyzed, WMS opening plan 37 s → 37 ms)
#
# Never touches Main (4100, app/data/postgres) or PG04's data; PG04 (57084) is only read by pg_dump.
#
# Second instance (the full dataset: its simulated days move the clock of the whole instance):
#   SCALE_PG_CONTAINER=dyna-scale-full-pg18 SCALE_PG_PORT=57091 SCALE_PG_STATE=<own dir> scale-pg.sh up
# gives it its own compose project (= container name), volumes <container>-data / <container>-wal-archive and
# generator container <container without -pg18>-gen; dyna-scale-pg18 keeps project dyna-scale-pg and its names.
# Optional: SCALE_PG_CPUS / SCALE_PG_MEMORY (docker update after `up`), SCALE_GEN_CPUS (netns-node --cpus),
# SCALE_GEN_DETACH=1 (netns-node detached, container kept after exit for `docker logs`; `docker rm` before a rerun),
# SCALE_WORKSPACE (mount root of netns-node; default $REPO/../.., which is wrong from a git worktree),
# DYNA_RATE_LIMIT_PER_MIN (passed to netns-node when set: per-address limit of the release app, default 600).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
die() { echo "scale-pg: $*" >&2; exit 1; }
export SCALE_PG_PORT="${SCALE_PG_PORT:-57090}"
export SCALE_PG_STATE="${SCALE_PG_STATE:-$REPO/data/scale/pg18-docker}"
export SCALE_PG_CONTAINER="${SCALE_PG_CONTAINER:-dyna-scale-pg18}"
CONTAINER="$SCALE_PG_CONTAINER"
[[ "$CONTAINER" =~ ^dyna-scale-[a-z0-9]+(-[a-z0-9]+)*$ ]] || die "container must be dyna-scale-<lowercase words>, got: $CONTAINER"
if [ "$CONTAINER" = dyna-scale-pg18 ]; then PROJECT=dyna-scale-pg; GEN="${SCALE_GEN_NAME:-dyna-scale-gen}"
else PROJECT="$CONTAINER"; GEN="${SCALE_GEN_NAME:-${CONTAINER%-pg18}-gen}"; fi
VACUUM="${CONTAINER%-pg18}-vacuum"
TEMPLATE="${SCALE_PG_TEMPLATE:-dynaminds_restore_36751abef3079f3f}"
PG04_LOCATOR="${PG04_LOCATOR:-$REPO/../../local-builds/full-base-accelerated-pg210-20261018-04/locator.private.json}"
RESTORE_CONFIG="${SCALE_RESTORE_CONFIG:-$REPO/../../local-builds/full-base-preview-20261017/n23-backup-restore-prepared-agent-20261019-01/restore/${TEMPLATE#dynaminds_restore_}/local-config.json}"
IMAGE_CLIENT="postgres:18.4-trixie@sha256:a02db8cac496f15b094798a38254f14d6e00741f709360e5e00bb6668ea31636"
NODE_IMAGE="${SCALE_NODE_IMAGE:-node:22.23.0-trixie-slim@sha256:cfd8f2a5bc50526aee08e88970979f92722828e7dcc6d8983607fb8bff4bdb82}"
DUMP="$SCALE_PG_STATE/dumps/$TEMPLATE.dump"
# SCALE_PG_COMPOSE_OVERRIDE: optional extra compose file (tools/demo/compose.demo.yml publishes the demo HTTP port).
compose() { docker compose -p "$PROJECT" -f "$HERE/compose.yml" ${SCALE_PG_COMPOSE_OVERRIDE:+-f "$SCALE_PG_COMPOSE_OVERRIDE"} "$@"; }
for p in 4100 5432 57084; do [ "$SCALE_PG_PORT" != "$p" ] || die "port $p is reserved (Main/PG04)"; done
[ "$CONTAINER" = dyna-scale-pg18 ] || [ "$SCALE_PG_PORT" != 57090 ] || die "port 57090 belongs to dyna-scale-pg18; give $CONTAINER its own SCALE_PG_PORT"

init_state() {
  umask 077
  mkdir -p "$SCALE_PG_STATE"/{secrets,faketime,dumps}
  chmod 0700 "$SCALE_PG_STATE" "$SCALE_PG_STATE"/{secrets,dumps,faketime}
  [ -s "$SCALE_PG_STATE/secrets/postgres.password" ] || openssl rand -hex 32 > "$SCALE_PG_STATE/secrets/postgres.password"
  chmod 0600 "$SCALE_PG_STATE/secrets/postgres.password"
  [ -s "$SCALE_PG_STATE/faketime/faketime.rc" ] || { echo "+0" > "$SCALE_PG_STATE/faketime/faketime.rc"; chmod 0644 "$SCALE_PG_STATE/faketime/faketime.rc"; }
  if [ ! -s "$SCALE_PG_STATE/local-config.json" ]; then
    # Same encryption key as the restored template (its encrypted rows must stay readable); our own password.
    [ -r "$RESTORE_CONFIG" ] || die "missing restore config $RESTORE_CONFIG"
    node -e 'const fs=require("fs");const k=JSON.parse(fs.readFileSync(process.argv[1],"utf8")).encryptionKey;
      fs.writeFileSync(process.argv[3],JSON.stringify({dbPassword:fs.readFileSync(process.argv[2],"utf8").trim(),encryptionKey:k}),{mode:0o600});' \
      "$RESTORE_CONFIG" "$SCALE_PG_STATE/secrets/postgres.password" "$SCALE_PG_STATE/local-config.json"
  fi
}
password() { tr -d '\n' < "$SCALE_PG_STATE/secrets/postgres.password"; }
url() { echo "postgres://postgres:$(password)@127.0.0.1:$SCALE_PG_PORT/$1"; }
psql_in() { local db="$1"; shift; docker exec -i "$CONTAINER" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$db" "$@"; }
wait_healthy() {
  for _ in $(seq 1 90); do
    s="$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo missing)"
    [ "$s" = healthy ] && return 0
    sleep 2
  done
  die "container not healthy (last: $s)"
}
valid_db() { [[ "$1" =~ ^dynaminds_scale_[0-9]{8}_[0-9]{2}$ ]] || die "database must be dynaminds_scale_YYYYMMDD_NN, got: $1"; }

clock_set() { # $1 = ISO instant or "real"
  local off
  if [ "$1" = real ]; then off="+0"; else
    off="$(node -e 'const t=Date.parse(process.argv[1]);if(Number.isNaN(t))process.exit(2);const s=Math.round((t-Date.now())/1000);process.stdout.write((s<0?"-":"+")+Math.abs(s))' "$1")" || die "bad instant: $1"
  fi
  local f="$SCALE_PG_STATE/faketime/faketime.rc"
  printf '%s\n' "$off" > "$f.tmp"; chmod 0644 "$f.tmp"; mv "$f.tmp" "$f"
  sleep 2.2 # FAKETIME_CACHE_DURATION=1: every backend re-reads within a second
  echo "offset $off"
}
clock_show() {
  echo "host now      $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "offset file   $(cat "$SCALE_PG_STATE/faketime/faketime.rc")"
  psql_in postgres -At -c "SELECT 'db now()      '||to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')"
}

cmd="${1:-status}"; shift || true
case "$cmd" in
  up|start)
    init_state
    compose up -d --build
    [ -z "${SCALE_PG_CPUS:-}" ] || docker update --cpus "$SCALE_PG_CPUS" "$CONTAINER" >/dev/null
    [ -z "${SCALE_PG_MEMORY:-}" ] || docker update --memory "$SCALE_PG_MEMORY" --memory-swap "$SCALE_PG_MEMORY" "$CONTAINER" >/dev/null
    wait_healthy
    echo "healthy on 127.0.0.1:$SCALE_PG_PORT"
    ;;
  config)
    printf '{"container":"%s","project":"%s","generator":"%s","vacuum":"%s","port":"%s"}\n' "$CONTAINER" "$PROJECT" "$GEN" "$VACUUM" "$SCALE_PG_PORT"
    compose config --format json
    ;;
  stop) compose stop ;;
  down) compose down ;; # volumes are external-named and kept; `docker volume rm` is a separate, manual decision
  status)
    compose ps
    echo "health: $(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo missing)"
    docker inspect -f '{{range .State.Health.Log}}{{.End}} exit={{.ExitCode}} {{.Output}}{{end}}' "$CONTAINER" 2>/dev/null | tail -2
    psql_in postgres -At -c "SELECT version()" \
      -c "SELECT name||'='||current_setting(name) FROM pg_settings WHERE name IN ('shared_buffers','effective_cache_size','work_mem','maintenance_work_mem','max_wal_size','min_wal_size','checkpoint_timeout','random_page_cost','max_connections','jit','TimeZone','archive_mode','wal_level','autovacuum_vacuum_scale_factor','autovacuum_analyze_scale_factor','track_io_timing','log_min_duration_statement','fsync','synchronous_commit','full_page_writes') ORDER BY name" \
      -c "SELECT 'archived='||archived_count||' failed='||failed_count||' last='||coalesce(last_archived_wal,'-') FROM pg_stat_archiver" \
      -c "SELECT 'db '||datname||' '||pg_size_pretty(pg_database_size(datname)) FROM pg_database WHERE datname LIKE 'dynaminds_%' ORDER BY 1"
    clock_show
    ;;
  clock)
    sub="${1:-show}"
    case "$sub" in
      show) clock_show ;;
      real) clock_set real; clock_show ;;
      set) [ -n "${2:-}" ] || die "clock set <ISO instant>"; clock_set "$2"; clock_show ;;
      *) die "clock show|real|set <ISO>" ;;
    esac
    ;;
  dump-template)
    init_state
    [ -r "$PG04_LOCATOR" ] || die "missing PG04 locator $PG04_LOCATOR"
    PGPASSWORD="$(node -e 'const u=new URL(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).databaseUrl);process.stdout.write(decodeURIComponent(u.password))' "$PG04_LOCATOR")"
    export PGPASSWORD
    # Read-only: pg_dump runs one REPEATABLE READ snapshot on PG04. host.docker.internal reaches PG04's 127.0.0.1:57084.
    docker run --rm -e PGPASSWORD -v "$SCALE_PG_STATE/dumps:/dumps" "$IMAGE_CLIENT" \
      pg_dump -h host.docker.internal -p 57084 -U postgres -d "$TEMPLATE" -Fc -Z 6 -f "/dumps/$TEMPLATE.dump.tmp"
    unset PGPASSWORD
    mv "$DUMP.tmp" "$DUMP"; chmod 0600 "$DUMP"
    shasum -a 256 "$DUMP" | tee "$DUMP.sha256"
    ls -l "$DUMP"
    ;;
  restore-template)
    [ -s "$DUMP" ] || die "no dump; run dump-template first"
    shasum -a 256 -c "$DUMP.sha256"
    exists="$(psql_in postgres -At -c "SELECT count(*) FROM pg_database WHERE datname='$TEMPLATE'")"
    [ "$exists" = 0 ] || die "$TEMPLATE already exists here (drop it manually if a fresh restore is wanted)"
    psql_in postgres -c "CREATE DATABASE $TEMPLATE TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER libc LOCALE 'C.UTF-8'"
    docker exec -i "$CONTAINER" pg_restore -U postgres -d "$TEMPLATE" --exit-on-error < "$DUMP"
    psql_in "$TEMPLATE" -c "VACUUM (ANALYZE)" >/dev/null
    # Exact per-table row counts here vs PG04 (read-only there).
    node "$HERE/compare-template.mjs" "$PG04_LOCATOR" "$TEMPLATE" "$(url "$TEMPLATE")" --apply-owner-acl
    ;;
  clone)
    db="${1:-}"; valid_db "$db"
    psql_in postgres -c "CREATE DATABASE $db TEMPLATE $TEMPLATE"
    cd "$REPO"
    DATABASE_URL="$(url "$db")" DYNA_LOCAL_CONFIG_PATH="$SCALE_PG_STATE/local-config.json" DYNA_TEST=true DYNA_WORKER_DISABLED=true \
      node node_modules/tsx/dist/cli.mjs -e "import('./server/db.ts').then(async m=>{const t=Date.now();await m.migrate();console.log('migrate ok',Date.now()-t,'ms');await m.pool.end();})"
    psql_in "$db" -At -c "SELECT 'ledger '||max(name)||' entries='||count(*) FROM migrations"
    node -e 'import(process.argv[1]).then(async m=>{const g=await m.checkGuards(process.argv[2]);console.log("guards",JSON.stringify(g.values),JSON.stringify(g.ms),"all_true="+g.all_true);process.exit(g.all_true?0:1)})' \
      "$REPO/tools/scale/inspect.mjs" "$(url "$db")"
    ;;
  env)
    db="${1:-}"; valid_db "$db"
    echo "export DATABASE_URL='$(url "$db")'"
    echo "export DYNA_LOCAL_CONFIG_PATH='$SCALE_PG_STATE/local-config.json'"
    echo "export DYNA_TEST=true DYNA_WORKER_DISABLED=true"
    echo "export SCALE_FAKETIME_FILE='$SCALE_PG_STATE/faketime/faketime.rc'"
    ;;
  psql) db="${1:-postgres}"; shift || true; docker exec -it "$CONTAINER" psql -X -U postgres -d "$db" "$@" ;;
  netns-node)
    # The release refuses a database it does not reach over loopback on the server's own port
    # (packing189-catalogue-reader: inet_server_addr() loopback, inet_server_port() = client port), which a
    # published Docker port never satisfies (server sees 192.168.x:5432, client uses 127.0.0.1:57090). So the
    # generator runs in a Node container sharing this container's network namespace. The workspace is mounted
    # at the same absolute path (release directory, node_modules symlink, checkpoint and faketime file keep
    # their paths); uid/gid are the caller's, so the 0600 local config passes the factory's owner check.
    # The hostname is the server container's (shared UTS with --network container:); the fixed --name keeps
    # one such generator at a time.
    db="${1:-}"; valid_db "$db"; shift
    WORKSPACE="${SCALE_WORKSPACE:-$(cd "$REPO/../.." && pwd)}"
    run_opts=(--rm); [ "${SCALE_GEN_DETACH:-}" != 1 ] || run_opts=(-d)
    [ -z "${SCALE_GEN_CPUS:-}" ] || run_opts+=(--cpus "$SCALE_GEN_CPUS")
    # Per-address limit of the release app (server/rate-limit-config.ts), passed only when set; the release validates it.
    [ -z "${DYNA_RATE_LIMIT_PER_MIN+set}" ] || run_opts+=(-e DYNA_RATE_LIMIT_PER_MIN)
    docker run "${run_opts[@]}" --init --name "$GEN" --network "container:$CONTAINER" \
      --user "$(id -u):$(id -g)" -v "$WORKSPACE:$WORKSPACE" -w "$REPO" \
      -e DATABASE_URL="postgres://postgres:$(password)@127.0.0.1:5432/$db" \
      -e DYNA_LOCAL_CONFIG_PATH="$SCALE_PG_STATE/local-config.json" -e DYNA_TEST=true -e DYNA_WORKER_DISABLED=true \
      -e SCALE_FAKETIME_FILE="$SCALE_PG_STATE/faketime/faketime.rc" -e TZ="${SCALE_GEN_TZ:-Europe/Warsaw}" \
      "$NODE_IMAGE" node "$@"
    ;;
  vacuum-loop)
    # Same image as the server (psql 18.4); 127.0.0.1 inside the namespace is trusted by the image's pg_hba, so no
    # password is passed. One line per pass in `docker logs`; stop with `docker rm -f` of the sidecar.
    db="${1:-}"; valid_db "$db"; every="${2:-600}"
    [[ "$every" =~ ^[0-9]+$ ]] && [ "$every" -ge 60 ] || die "interval must be whole seconds >= 60, got: $every"
    docker run -d --name "$VACUUM" --network "container:$CONTAINER" --cpus "${SCALE_VACUUM_CPUS:-1}" --memory 256m \
      --entrypoint /bin/sh dyna-scale-pg18-faketime:18.4 -c 'while true; do t=$(date +%s)
        if psql -X -q -h 127.0.0.1 -U postgres -d "$0" -c "VACUUM (ANALYZE, SKIP_LOCKED)"; then r=ok; else r="exit=$?"; fi
        echo "$(date -u +%FT%TZ) vacuum-analyze $r $(( $(date +%s) - t ))s"; sleep "$1"; done' "$db" "$every"
    ;;
  netns-kill) docker kill --signal KILL "$GEN" ;; # kill -9 of the containerized generator (resume test)
  *) die "unknown command $cmd" ;;
esac
