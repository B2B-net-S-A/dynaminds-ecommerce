#!/usr/bin/env bash
# Local staging of DYNAMINDS Ecommerce: the demo on http://127.0.0.1:4300 runs the code of `main` from the public
# repository B2B-net-S-A/dynaminds-ecommerce. Description (Polish): docs/staging.md.
#
# Same idea as NEXUS's scripts/staging/refresh_code.sh: new code, the same demo database. The new release applies
# its own migrations to dynaminds_demo when it starts; the snapshot dynaminds_demo_snapshot and the images
# snapshot are never touched (`tools/demo/demo.sh reset` still brings the demo back to them).
#
#   tools/staging/refresh.sh            fetch main, build, restart the demo, guards, smoke, trace
#   tools/staging/refresh.sh --dry-run  resolve the configuration and print the plan; changes nothing
#
# Steps: git fetch <remote> main → dedicated worktree (detached at that SHA) → `demo.sh build` there →
# `demo.sh stop` + `demo.sh start` (only after a good build) → `demo.sh guards` (16/16) → smoke.mjs
# (/api/health 200, every demo test account logs in) → one-line JSON trace.
#
# Exit codes (trace `stan` in brackets):
#   0 [ok]        demo on the release of main, guards 16/16, smoke green
#   1 [failed]    fetch, worktree or build failed; the demo keeps running the previous release (no restart)
#   2 [failed]    configuration missing (source repository, remote, node_modules, demo state, test accounts,
#                 Docker) or a bad argument
#   3 [failed]    the new release did not come up (start, migrations, /api/health); one attempt to start the
#                 previous release again, its result is in the log and in `powod`
#   4 [degraded]  the new release runs, but the guards are not 16/16
#   5 [degraded]  the new release runs and the guards are 16/16, but the smoke failed (health or a login)
#   6 [skipped]   another refresh is running
#
# Environment (all optional):
#   STAGING_SOURCE_REPO  git checkout to fetch into (default: the checkout holding this script)
#   STAGING_REMOTE       remote of the public repository (default: the one whose URL names it)
#   STAGING_BRANCH       branch (default main)
#   STAGING_WORKTREE     dedicated worktree (default: <dir of the source checkout>/staging-main); do not edit there
#   STAGING_DEPS         locked node_modules linked into the worktree (default: the source checkout's node_modules)
#   STAGING_TRACE        trace file (default ~/.claude/dyna-ecommerce-rutyny/odswiezenie.ok, empty = no trace)
#   DEMO_ROOT, DEMO_HTTP_PORT  as in tools/demo/demo.sh
# Passwords are read only by smoke.mjs from $DEMO_ROOT/private/credentials.json and are never printed.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUBLIC_REPO_RE='[/:]B2B-net-S-A/dynaminds-ecommerce(\.git)?$'
BRANCH="${STAGING_BRANCH:-main}"
PORT="${DEMO_HTTP_PORT:-4300}"
TRACE="${STAGING_TRACE-$HOME/.claude/dyna-ecommerce-rutyny/odswiezenie.ok}"
APP=dyna-demo-app
DRY=0
START_HM="$(date +%H:%M)"; T0=$SECONDS
SHA=""; RELEASE=""; GUARDS=""; SMOKE=""; RELEASES=""

log() { echo "staging: $*"; }

# One JSON line, written atomically (the same shape as NEXUS's bin/slad.py).
write_trace() {
  local stan="$1" kod="$2" powod="$3"
  [ -n "$TRACE" ] || return 0
  mkdir -p "$(dirname "$TRACE")" || return 0
  /usr/bin/python3 - "$TRACE" "$stan" "$kod" "$START_HM" "${SHA:0:12}" "$powod" "$RELEASE" "$GUARDS" "$SMOKE" \
    "$RELEASES" "$((SECONDS - T0))" <<'PY' || echo "staging: trace not written ($TRACE)" >&2
import json, os, sys, tempfile
from datetime import datetime
path, stan, kod, start, sha, powod, release, guards, smoke, releases, seconds = sys.argv[1:]
liczniki = {k: v for k, v in (("wydanie", release), ("straznicy", guards), ("smoke", smoke),
                              ("wydania_na_dysku", releases), ("czas_s", seconds)) if v}
for k in ("wydania_na_dysku", "czas_s"):
    if k in liczniki and liczniki[k].isdigit():
        liczniki[k] = int(liczniki[k])
dane = {"v": 1, "rutyna": "odswiezenie", "stan": stan, "kod": int(kod), "start": start,
        "koniec": datetime.now().astimezone().isoformat(timespec="seconds"), "sha": sha or None,
        "powod": powod or None, "liczniki": liczniki}
uchwyt, tymczasowy = tempfile.mkstemp(dir=os.path.dirname(path) or ".", suffix=".tmp")
with os.fdopen(uchwyt, "w") as plik:
    plik.write(json.dumps(dane, ensure_ascii=False) + "\n")
os.chmod(tymczasowy, 0o644)
os.replace(tymczasowy, path)
PY
}

LOCK=""
finish() {
  local kod="$1" powod="${2:-}" stan
  case "$kod" in 0) stan=ok ;; 4|5) stan=degraded ;; 6) stan=skipped ;; *) stan=failed ;; esac
  [ -z "$powod" ] || echo "staging: $powod" >&2
  if [ "$DRY" = 0 ]; then
    write_trace "$stan" "$kod" "$powod"
    [ -z "$LOCK" ] || rm -rf "$LOCK"
  fi
  log "koniec: stan=$stan kod=$kod (${SHA:0:12})"
  exit "$kod"
}

case "${1:-}" in
  "") ;;
  --dry-run) DRY=1 ;;
  *) DRY=1; finish 2 "nieznany argument ${1} (użycie: tools/staging/refresh.sh [--dry-run])" ;;
esac
export GIT_TERMINAL_PROMPT=0

# --- configuration -----------------------------------------------------------------------------------------------
for c in git node docker curl; do command -v "$c" >/dev/null || finish 2 "brak polecenia $c w PATH"; done
SRC="${STAGING_SOURCE_REPO:-$(git -C "$HERE" rev-parse --show-toplevel 2>/dev/null || true)}"
[ -n "$SRC" ] && git -C "$SRC" rev-parse --git-dir >/dev/null 2>&1 \
  || finish 2 "brak repozytorium źródłowego (ustaw STAGING_SOURCE_REPO)"
SRC="$(git -C "$SRC" rev-parse --show-toplevel)"
REMOTE="${STAGING_REMOTE:-}"
if [ -z "$REMOTE" ]; then
  for r in $(git -C "$SRC" remote); do
    if git -C "$SRC" remote get-url "$r" | grep -Eq "$PUBLIC_REPO_RE"; then REMOTE="$r"; break; fi
  done
fi
[ -n "$REMOTE" ] && git -C "$SRC" remote get-url "$REMOTE" >/dev/null 2>&1 \
  || finish 2 "brak remote'a publicznego repo B2B-net-S-A/dynaminds-ecommerce w $SRC (ustaw STAGING_REMOTE)"
WT="${STAGING_WORKTREE:-$(dirname "$SRC")/staging-main}"
DEPS="${STAGING_DEPS:-$SRC/node_modules}"
[ -d "$DEPS" ] || finish 2 "brak node_modules do podlinkowania: $DEPS (ustaw STAGING_DEPS)"
DEPS="$(cd "$DEPS" && pwd -P)"
W="$(dirname "$WT")"; while [ "$W" != / ] && [ ! -d "$W/local-builds" ]; do W="$(dirname "$W")"; done
[ -d "$W/local-builds" ] || finish 2 "brak katalogu local-builds/ nad $WT (tools/demo/demo.sh)"
export DEMO_ROOT="${DEMO_ROOT:-$W/local-builds/dyna-demo}"
CREDS="$DEMO_ROOT/private/credentials.json"
[ -s "$CREDS" ] || finish 2 "brak kont testowych demo ($DEMO_ROOT/private/credentials.json); najpierw tools/demo/demo.sh seed"
[ -s "$DEMO_ROOT/release-build.path" ] || finish 2 "brak stanu demo ($DEMO_ROOT/release-build.path); najpierw tools/demo/demo.sh build i seed"
docker info >/dev/null 2>&1 || finish 2 "Docker nie działa"

prev_record="$(cat "$DEMO_ROOT/release-build.path")"
json_field() { node -e 'try{const v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))[process.argv[2]];console.log(v??"")}catch{console.log("")}' "$1" "$2"; }
prev_commit="$(json_field "$prev_record" commit)"
prev_dir="$(json_field "$prev_record" release_directory)"
releases_dir="$(dirname "$(dirname "$prev_dir")")"
count_releases() { RELEASES="$(find "$releases_dir" -maxdepth 1 -type d -name 'demo-release-*' 2>/dev/null | wc -l | tr -d ' ')"; }
count_releases
app_runs() { docker inspect -f '{{.State.Running}} {{json .Args}}' "$APP" 2>/dev/null | grep -q "^true .*$1/runtime/server/"; }
health_code() { curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:$PORT/api/health" 2>/dev/null || true; }

log "źródło $SRC, remote $REMOTE/$BRANCH, worktree $WT, demo :$PORT, DEMO_ROOT $DEMO_ROOT"
log "teraz: wydanie $(basename "$(dirname "$prev_dir")") z ${prev_commit:0:12}, wydań na dysku: $RELEASES"

if [ "$DRY" = 1 ]; then
  SHA="$(git -C "$SRC" ls-remote "$REMOTE" "refs/heads/$BRANCH" 2>/dev/null | cut -f1)"
  [ -n "$SHA" ] || finish 2 "git ls-remote $REMOTE $BRANCH nie zwrócił SHA"
  if [ "$prev_commit" = "$SHA" ] && app_runs "$prev_dir"; then
    log "plan: demo już na ${SHA:0:12} — bez builda i restartu; strażnicy i smoke"
  else
    log "plan: fetch → worktree na ${SHA:0:12} → demo.sh build → demo.sh stop/start → strażnicy → smoke"
  fi
  log "ślad: ${TRACE:-(wyłączony)}"
  finish 0
fi

# --- one run at a time -------------------------------------------------------------------------------------------
LOCK_DIR="$DEMO_ROOT/staging-refresh.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  if kill -0 "$(cat "$LOCK_DIR/pid" 2>/dev/null)" 2>/dev/null; then
    finish 6 "trwa inny bieg odświeżenia (pid $(cat "$LOCK_DIR/pid"))"
  fi
  rm -rf "$LOCK_DIR"; mkdir "$LOCK_DIR" || finish 2 "nie można założyć blokady $LOCK_DIR"
fi
LOCK="$LOCK_DIR"; echo $$ > "$LOCK/pid"

# --- code of main ------------------------------------------------------------------------------------------------
git -C "$SRC" fetch --quiet "$REMOTE" "$BRANCH" || finish 1 "git fetch $REMOTE $BRANCH nie przeszedł"
SHA="$(git -C "$SRC" rev-parse "refs/remotes/$REMOTE/$BRANCH")" || finish 1 "brak refs/remotes/$REMOTE/$BRANCH po fetch"
log "main = $SHA"

if [ -e "$WT/.git" ]; then
  # Detached checkout without --force: edits in the dedicated worktree stop the run instead of being lost.
  git -C "$WT" checkout --quiet --detach "$SHA" || finish 1 "checkout $SHA w $WT nie przeszedł (zmiany w worktree?)"
else
  [ ! -e "$WT" ] || finish 2 "$WT istnieje, ale nie jest worktree gita"
  git -C "$SRC" worktree add --quiet --detach "$WT" "$SHA" || finish 1 "git worktree add $WT nie przeszedł"
fi
# The repository has no node_modules; the release build reuses the locked local dependencies (never copies).
if [ "$(cd "$WT/node_modules" 2>/dev/null && pwd -P)" != "$DEPS" ]; then
  rm -f "$WT/node_modules"; ln -s "$DEPS" "$WT/node_modules" || finish 2 "nie można podlinkować $DEPS"
fi
DEMO="$WT/tools/demo/demo.sh"
[ -x "$DEMO" ] || finish 2 "brak $DEMO w kodzie z main"

# --- release and restart -----------------------------------------------------------------------------------------
if [ "$prev_commit" = "$SHA" ] && app_runs "$prev_dir" && [ "$(health_code)" = 200 ]; then
  RELEASE="$(basename "$(dirname "$prev_dir")")"
  log "demo już jest na ${SHA:0:12} ($RELEASE); bez builda i restartu"
else
  log "build wydania z ${SHA:0:12}"
  "$DEMO" build || finish 1 "demo.sh build nie przeszedł (log: $DEMO_ROOT/logs/build.log); demo działa na poprzednim wydaniu"
  new_record="$(cat "$DEMO_ROOT/release-build.path")"
  new_dir="$(json_field "$new_record" release_directory)"
  [ "$(json_field "$new_record" commit)" = "$SHA" ] || finish 1 "nowe wydanie nie jest z $SHA ($new_record)"
  RELEASE="$(basename "$(dirname "$new_dir")")"; count_releases
  log "restart demo na $RELEASE (migracje wykonuje wydanie przy starcie)"
  "$DEMO" stop
  started=0
  if "$DEMO" start; then
    for _ in $(seq 1 30); do [ "$(health_code)" = 200 ] && { started=1; break; }; sleep 2; done
  fi
  if [ "$started" = 0 ] || ! app_runs "$new_dir"; then
    why="nowe wydanie $RELEASE nie wstało (log: $DEMO_ROOT/logs/app.log)"
    echo "$prev_record" > "$DEMO_ROOT/release-build.path"
    "$DEMO" stop
    if "$DEMO" start && [ "$(health_code)" = 200 ]; then
      finish 3 "$why; demo wróciło na poprzednie wydanie $(basename "$(dirname "$prev_dir")")"
    fi
    finish 3 "$why; poprzednie wydanie też nie wstało — demo nie działa"
  fi
fi

# --- guards and smoke --------------------------------------------------------------------------------------------
guards_json="$("$DEMO" guards 2>&1)"; guards_rc=$?
GUARDS="$(printf '%s' "$guards_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const r=JSON.parse(s.slice(s.indexOf("{")));const v=Object.values(r.values);console.log(`${v.filter(x=>x===true).length}/${r.count}`)}catch{console.log("")}})')"
log "strażnicy: ${GUARDS:-brak wyniku}"
if [ "$guards_rc" != 0 ] || [ -z "$GUARDS" ] || [ "${GUARDS%%/*}" != "${GUARDS##*/}" ]; then
  printf '%s\n' "$guards_json" | tail -25 >&2
  finish 4 "strażnicy ${GUARDS:-bez wyniku} na $RELEASE"
fi

smoke_out="$(node "$HERE/smoke.mjs" --base "http://127.0.0.1:$PORT" --credentials "$CREDS" 2>&1)"; smoke_rc=$?
log "smoke: $smoke_out"
if [ "$smoke_rc" = 0 ]; then SMOKE=ok; else
  SMOKE=failed
  finish 5 "smoke nie przeszedł: $(printf '%s' "$smoke_out" | tail -1 | cut -c1-160)"
fi

finish 0
