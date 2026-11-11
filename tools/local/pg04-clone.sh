#!/bin/bash
# PG04 clones for the clone-only DB suites (tests/invoice230.database.test.ts and others that require
# 127.0.0.1:57084 and a dynaminds_<suite>_YYYYMMDD_NN database made from the PG04 template).
#
#   tools/local/pg04-clone.sh start          start PG04 (local test cluster, TCP only) unless it already runs
#   tools/local/pg04-clone.sh clone <db>     CREATE DATABASE <db> TEMPLATE dynaminds_restore_…, real migrate()
#   tools/local/pg04-clone.sh env <db>       exports for the test run (contain the PG04 password; do not log them)
#   tools/local/pg04-clone.sh list [suite]   existing clones (pick the next free NN)
#   tools/local/pg04-clone.sh drop <db>      drop one clone
#   tools/local/pg04-clone.sh stop           fast shutdown of PG04
#
# invoice230 (the suite's regex fixes the date; it issues invoices and refuses a rerun, so each run = NEW clone):
#   tools/local/pg04-clone.sh start
#   tools/local/pg04-clone.sh list inv230            # next free NN
#   tools/local/pg04-clone.sh clone dynaminds_inv230_20261023_NN
#   eval "$(tools/local/pg04-clone.sh env dynaminds_inv230_20261023_NN)"
#   node node_modules/tsx/dist/cli.mjs --test --test-concurrency=1 tests/invoice230.database.test.ts
#
# Why PG04 and not a Docker restore of the template dump: pg_dump drops ACLs equal to the owner default, so a
# restored template fails order_merge_delivery209_valid() and migration 257 refuses it ("271 valid Source209
# installation required"). CREATE DATABASE … TEMPLATE on PG04 copies the catalogue exactly.
# PG04 is slow (~15 s per tenantTx under load); run DB suites in the background.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
WORKSPACE="${PG04_WORKSPACE:-$HOME/DYNA Ecomerce}"
die() { echo "pg04-clone: $*" >&2; exit 1; }
PG04_DIR="${PG04_DIR:-$WORKSPACE/local-builds/full-base-accelerated-pg210-20261018-04}"
LOCATOR="$PG04_DIR/locator.private.json"
CONFIG="${PG04_TEST_CONFIG:-$WORKSPACE/local-builds/test-harness/pg04-test-config.json}"
TEMPLATE=dynaminds_restore_36751abef3079f3f
PORT=57084
[ -r "$LOCATOR" ] || die "missing PG04 locator $LOCATOR (set PG04_DIR)"
field() { node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=process.argv[2].split(".").reduce((o,k)=>o[k],j);process.stdout.write(String(v))' "$LOCATOR" "$1"; }
BIN="$(field runtimeBinaryPin.path)"
DATA="$(field dataDirectory)"
PGPASSWORD="$(node -e 'process.stdout.write(decodeURIComponent(new URL(process.argv[1]).password))' "$(field databaseUrl)")"
export PGPASSWORD
url() { node -e 'const u=new URL(process.argv[1]);u.pathname="/"+process.argv[2];process.stdout.write(u.toString())' "$(field databaseUrl)" "$1"; }
valid_db() { [[ "$1" =~ ^dynaminds_[a-z0-9]+_[0-9]{8}_[0-9]{2}$ ]] || die "database must be dynaminds_<suite>_YYYYMMDD_NN, got: $1"; }
up() { nc -z 127.0.0.1 "$PORT" 2>/dev/null; }
# psql is not on the host; the pinned server has no client, so SQL goes through node-postgres.
sql() { (cd "$REPO" && node -e 'const pg=require("pg");const c=new pg.Client({connectionString:process.argv[1]});c.connect().then(()=>c.query(process.argv[2])).then(r=>{for(const row of r.rows??[])console.log(Object.values(row).join(" "));return c.end()}).catch(e=>{console.error(e.message);process.exit(1)})' "$(url "$1")" "$2"); }

cmd="${1:-}"; shift || true
case "$cmd" in
  start)
    if up; then echo "PG04 already listening on 127.0.0.1:$PORT"; exit 0; fi
    [ ! -e "$DATA/postmaster.pid" ] || die "$DATA/postmaster.pid exists but nothing listens; check $PG04_DIR/postgres.private.log"
    nohup "$BIN" -D "$DATA" -p "$PORT" -c listen_addresses=127.0.0.1 -c unix_socket_directories= >> "$PG04_DIR/postgres.private.log" 2>&1 &
    for _ in $(seq 1 120); do up && sql postgres "SELECT 1" >/dev/null 2>&1 && { echo "PG04 ready on 127.0.0.1:$PORT"; exit 0; }; sleep 1; done
    die "PG04 did not start; see $PG04_DIR/postgres.private.log"
    ;;
  clone)
    db="${1:-}"; valid_db "$db"; up || die "PG04 is not running; run start first"
    sql postgres "CREATE DATABASE $db TEMPLATE $TEMPLATE"
    cd "$REPO"
    DATABASE_URL="$(url "$db")" DYNA_LOCAL_CONFIG_PATH="$CONFIG" DYNA_TEST=true DYNA_WORKER_DISABLED=true \
      node node_modules/tsx/dist/cli.mjs -e "import('./server/db.ts').then(async m=>{const t=Date.now();await m.migrate();console.log('migrate ok',Date.now()-t,'ms');await m.pool.end();})"
    sql "$db" "SELECT 'ledger '||max(name)||' entries='||count(*) FROM migrations"
    # The suites check these guards in before() with statement_timeout 8 s. Cold after start they take up to
    # ~130 s, warm ~4 s, so this pass both verifies the clone and warms the cache. Session options as the
    # server pool (server/db.ts): without timezone=UTC the 209/206/211 fingerprints differ and read false.
    (cd "$REPO" && node -e 'const pg=require("pg");(async()=>{const c=new pg.Client({connectionString:process.argv[1],options:"-c jit=off -c timezone=UTC"});await c.connect();let ok=true;
      for(const g of ["ordinary187_valid","buyer_address_guards","order_merge_delivery209_valid","return_credit206_guards","ordinary188_structure_valid","return_credit211_metadata_valid","large_import173_valid","fa3_draft_guards","pim_dictionary_valid","local_invoice_guards"]){
        const t=Date.now();const v=(await c.query(`SELECT public.${g}() v`)).rows[0].v;ok=ok&&v===true;console.log("guard",g,v,Date.now()-t,"ms")}
      await c.end();process.exit(ok?0:1)})().catch(e=>{console.error(e.message);process.exit(1)})' "$(url "$db")")
    ;;
  env)
    db="${1:-}"; valid_db "$db"
    echo "export DATABASE_URL='$(url "$db")'"
    echo "export DYNA_LOCAL_CONFIG_PATH='$CONFIG'"
    echo "export DYNA_TEST=true DYNA_WORKER_DISABLED=true"
    ;;
  list) sql postgres "SELECT datname FROM pg_database WHERE datname LIKE 'dynaminds\_${1:-}%' ORDER BY 1" ;;
  drop) db="${1:-}"; valid_db "$db"; sql postgres "DROP DATABASE IF EXISTS $db WITH (FORCE)" ;;
  stop)
    up || { echo "PG04 not running"; exit 0; }
    pid="$(head -1 "$DATA/postmaster.pid")"; kill -INT "$pid"
    for _ in $(seq 1 60); do up || { echo "PG04 stopped"; exit 0; }; sleep 1; done
    die "PG04 still running (pid $pid)"
    ;;
  *) die "usage: start | clone <db> | env <db> | list [suite] | drop <db> | stop" ;;
esac
