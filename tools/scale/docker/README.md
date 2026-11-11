# Dedicated scale PostgreSQL (Docker, libfaketime)

Instance for the stage 5 dataset and measurement (`docs/scale/MEASUREMENT-MANIFEST-20261025.md`, sections 3–4 and 10).
Not PG04 (57084), not Main (4100, `app/data/postgres`).

| Item | Value |
|---|---|
| image | `dyna-scale-pg18-faketime:18.4`, built from `postgres:18.4-trixie@sha256:a02db8ca…1636` (arm64) + Debian `libfaketime` |
| container / port | `dyna-scale-pg18`, `127.0.0.1:57090` → 5432 (override `SCALE_PG_PORT`; 4100/5432/57084 refused) |
| data | named volume `dyna-scale-pg18-data` (`/var/lib/postgresql`), WAL archive volume `dyna-scale-pg18-wal-archive` |
| WAL archive | `archive_command` = `dyna-wal-archive` (zstd + fsync), `archive_timeout = 60s`; base backups and point-in-time restore: `tools/recovery/README.md` |
| settings | `postgresql.scale.conf` (manifest section 3), included from `postgresql.conf` by `initdb/10-scale.sh` on first start |
| cluster role | `dyna_app NOLOGIN` (created on first start; the restored template's grants refer to it) |
| local state | `data/scale/pg18-docker/` (gitignored, 0700): `secrets/postgres.password`, `local-config.json`, `faketime/faketime.rc`, `dumps/` |

## Use

```sh
tools/scale/docker/scale-pg.sh up                 # build + start, waits for the healthcheck (pg_isready)
tools/scale/docker/scale-pg.sh dump-template      # pg_dump -Fc of PG04 dynaminds_restore_36751abef3079f3f (read-only snapshot)
tools/scale/docker/scale-pg.sh restore-template   # restore + exact per-table counts and ACL digests vs PG04
tools/scale/docker/scale-pg.sh clone dynaminds_scale_20261026_02   # CREATE DATABASE … TEMPLATE, real migrate(), 10 guards
eval "$(tools/scale/docker/scale-pg.sh env dynaminds_scale_20261026_02)"
node node_modules/tsx/dist/cli.mjs tools/scale/generate.mjs --simulate-days …   # see generate.mjs header
tools/scale/docker/scale-pg.sh status | clock | stop | down
```

`down` keeps both named volumes; removing them (`docker volume rm …`) is a separate, deliberate step.

## Template

PG04 clones come from `dynaminds_restore_36751abef3079f3f`, a database the application's own recovery
path restored from a backup (`server/recovery.ts`, restore directory
`local-builds/full-base-preview-20261017/n23-backup-restore-prepared-agent-20261019-01/restore/36751abef3079f3f`,
ledger `217_crm_field_definitions`). Here it is copied with `pg_dump -Fc` (client 18.4 in the same image,
through `host.docker.internal:57084`) and `pg_restore`. pg_dump leaves out an ACL that equals the
owner default, so 234 relations/schemas whose source ACL was materialized as exactly `{postgres=…/postgres}`
come back as NULL; `compare-template.mjs --apply-owner-acl` re-materializes them with `GRANT ALL … TO
postgres` and then requires identical row counts for all 646 tables and identical digests of relation,
function, schema, type and default ACLs, function/trigger/event-trigger/policy/index counts.
`local-config.json` keeps the template's encryption key (from the restore directory) with this
instance's password. `clone` then runs the real `migrate()` (→ `233_fiscal_receipts`, 223 entries).

## Clock (libfaketime)

`/usr/lib/postgresql/18/bin/postgres` is a wrapper (`postgres-faketime.sh`) that preloads
`libfaketime.so.1` into the server only. Nothing else in the container carries the preload: with it in
the entrypoint shell, `gosu` (static Go) hangs and the container never initializes.

- `FAKETIME_TIMESTAMP_FILE=/faketime/faketime.rc` (bind mount of `data/scale/pg18-docker/faketime`):
  a relative offset in seconds, e.g. `-15617414` or `+0`. Relative, so the clock keeps running.
- `FAKETIME_CACHE_DURATION=1`: every backend re-reads the file at most once per second, so a change
  reaches existing pool connections and new sessions within ~1 s, without a restart.
- `FAKETIME_DONT_FAKE_MONOTONIC=1`: monotonic clocks (latches, `instr_time`, waits) stay real.
- Effect: `now()`, `transaction_timestamp()`, `clock_timestamp()`, `current_date` and every
  `DEFAULT now()` / trigger timestamp follow the simulated day, for the whole instance (all databases).
- `generate.mjs --simulate-days` writes the same offset to the file and to the generator process'
  `Date` (`tools/scale/simclock.mjs`), so application code that uses `new Date()` agrees with the
  database. It changes the day only at a barrier (no statement in flight), because PostgreSQL
  schedules `statement_timeout`/`lock_timeout` on the wall clock, and verifies each change with a fresh
  session before writing. At the end it writes `+0` again.
- By hand: `scale-pg.sh clock set 2026-04-28T06:00:00Z`, `scale-pg.sh clock real`.
- One simulating generator per instance: it holds `faketime.rc.lock` (pid) for the run.
- Keep the file at `+0` when a cluster is initialized: the entrypoint's temporary server is watched by
  `pg_ctl` (real clock), which gives up on a postmaster whose pid file carries a shifted start time.
- Measurement: `SCALE_FAKETIME=off tools/scale/docker/scale-pg.sh up` recreates the container without the
  preload. Measured: `pim_dictionary_valid()` 7.0–7.4 s with and without libfaketime on the same restored
  template, so the preload adds no visible cost there; still, the measured release runs with it off.
- Side effects while the clock is in the past: time-based checkpoints wait (WAL-size checkpoints
  still run), autovacuum scheduling is skewed; run `VACUUM (ANALYZE)` after generating. Rows of the
  template keep their real (October 2026) timestamps, i.e. "in the future" of the simulated days.

## Memory

Docker Desktop's VM has 32 GiB here (`docker info`), so the manifest's `shared_buffers=16GB` takes half of
it and `effective_cache_size=64GB` describes the host, not the VM. See manifest section 10.

## Release (generator in the packaged release)

The full dataset is generated by the packaged release (manifest section 2), not by the source tree: in source
mode every `tenantTx` first runs the four schema validators (`server/db.ts` `preflightUngatedTenantSchema`),
12–15 s per transaction here; the release installs its schema gate once at start (`installOrdinarySchemaRuntime`).

```sh
# 1. package of one commit (file-only; new directory outside the repo, under local-builds for its node_modules)
node tools/scale/release-build.mjs --out "<workspace>/local-builds/full-base-preview-20261017/scale-release-YYYYMMDD-NN"
#    → <out>/release-build.json: commit, release_manifest_sha256, package_tree_sha256, metafile sha256, contract delta
# 2. clone + generator inside the release (Linux node in this container's network namespace)
tools/scale/docker/scale-pg.sh clone dynaminds_scale_YYYYMMDD_NN
tools/scale/docker/scale-pg.sh netns-node dynaminds_scale_YYYYMMDD_NN tools/scale/generate.mjs \
  --release <out>/release-build.json --simulate-days … --checkpoint … --report …
tools/scale/docker/scale-pg.sh netns-kill      # kill -9 of that generator (resume test); rerun = resume
# fixed tenantTx cost, release vs source (SELECT 1 body, nothing written)
tools/scale/docker/scale-pg.sh netns-node <db> tools/scale/tx-probe.mjs --release <out>/release-build.json
eval "$(tools/scale/docker/scale-pg.sh env <db>)"; node node_modules/tsx/dist/cli.mjs tools/scale/tx-probe.mjs --n 5
```

Why a container: the release's cold validation (`packing189-catalogue-reader.mjs` `derivePackingColdIdentity`)
accepts only an owner session whose `inet_server_addr()` is loopback and whose `inet_server_port()` equals the
client's port. Through the published port the server sees `192.168.48.2:5432` while the client uses
`127.0.0.1:57090`, so the factory refuses (`recovery-selected-database`). `netns-node` runs
`node:22.23.0-trixie-slim@sha256:cfd8f2a5…db82` (arm64, same Node as the host) with
`--network container:dyna-scale-pg18`, the workspace mounted at its own absolute path and the caller's uid/gid;
the database URL is `127.0.0.1:5432`. The measured release (stage 5 load) needs the same placement.
In that namespace `127.0.0.1` matches `host … 127.0.0.1/32 trust` of the image's `pg_hba.conf`; the
container is reachable only from this host (`127.0.0.1:57090`), and the factory still requires the
URL password to equal `local-config.json`'s `dbPassword`.
