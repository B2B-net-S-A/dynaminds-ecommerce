#!/bin/sh
# Installed as /usr/lib/postgresql/18/bin/postgres: the server (and initdb's bootstrap backend) run
# with libfaketime; nothing else in the container does (gosu, a static Go binary, hangs when its
# parent shell carries the preload). Offset file and cache: see README.md.
# SCALE_FAKETIME=off starts the server without the preload (real clock, no interception cost).
if [ "${SCALE_FAKETIME:-on}" != off ]; then
  export LD_PRELOAD=/usr/local/lib/faketime/libfaketime.so.1
  export FAKETIME_TIMESTAMP_FILE="${FAKETIME_TIMESTAMP_FILE:-/faketime/faketime.rc}"
  export FAKETIME_CACHE_DURATION="${FAKETIME_CACHE_DURATION:-1}"
  export FAKETIME_DONT_FAKE_MONOTONIC="${FAKETIME_DONT_FAKE_MONOTONIC:-1}"
fi
exec /usr/lib/postgresql/18/bin/postgres.real "$@"
