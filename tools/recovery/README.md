# Physical backup and point-in-time restore (stage 5, goal condition 11)

Continuous WAL archiving plus base backup sets for the Docker PostgreSQL of stage 5
(`tools/scale/docker`, container `dyna-scale-pg18`). Targets: RPO ≤ 15 min, RTO ≤ 60 min.
Measured drill: `docs/scale/RECOVERY-DRILL-20261027.md`.

A physical backup (base backup + WAL replay) restores catalogs, roles and ACLs byte for byte, so it does
not go through `pg_dump` and the ACL normalizer of the logical path (`server/recovery.ts`; migrations
219/220 sequence ACLs). The logical `npm run backup` stays the per-database / pre-migration copy (MIG-3).
A plain `pg_dump` file is restored with `scripts/dump-restore.ts` (section "Logical dump restore" below).

## Logical dump restore (plain `pg_dump --format=custom`)

A logical dump loses two catalog states the application start requires:

| Lost in the dump | Effect on start | Re-established by |
|---|---|---|
| database ACL of `262_revoke_public_temporary` (`datacl` is never dumped; the new database gives PUBLIC `TEMPORARY` again) | `server/index.ts` and the release start (`server/ordinary-local-runtime.ts`, code `DATABASE_TEMP_PRIVILEGE`) refuse: `DatabaseTempPrivilegeError` „Baza … pozwala roli aplikacji tworzyć tabele tymczasowe (TEMPORARY)…” | `reapplyRevokePublicTemporary` (the exact 262 statement, as the owner) |
| explicit owner-only relation/schema ACLs equal to the default (`pg_dump` omits them, the restore leaves `relacl` NULL): at HEAD 263, 240 tables, 14 ID sequences (219, 220 ×9, 221, 223, 224) and `ordinary187_private`; from 266 also `accountant266_invitations`, `accountant266_memberships` and (267) `automation267_editors` | release start refuses in the ACL normalizer, e.g. `263 requires complete261 predecessor:relation public.stocktake_adjustment_usage` (before 30.10.2026: `219 exact complete addition descriptor:…_seq`; before 11.11.2026 on a database from 266: `267 exact complete addition descriptor:relation public.automation267_editors`) | `normalizeOrdinaryLegacyOwnerAcls` (`server/ordinary-legacy-schema.mjs`), which the release start also runs |

```sh
# dump (any loopback cluster; postgres user; pg_dump 18 from npm run pg:tools)
PGPASSWORD=… ~/.local/share/dynaminds/pg-tools/18/bin/pg_dump --host=127.0.0.1 --port=<port> --username=postgres \
  --dbname=<source> --format=custom --file=<private dir>/source.dump
# restore into a NEW empty database of the cluster named by DATABASE_URL (refuses an existing one)
DATABASE_URL=postgres://postgres:…@127.0.0.1:<port>/postgres npx tsx scripts/dump-restore.ts \
  --file <private dir>/source.dump --database <new database>
# {"status":"restored","database":…,"temporary":{…,"reapplied":true},"owner_default_acls_materialized":258,"ms":…}
```

`server/recovery-dump-restore.ts`: `CREATE DATABASE` as `restoreBackup` does, `dyna_app` role check, `pg_restore
--single-transaction --exit-on-error --no-owner`, then 262 and the normalizer. The normalizer materializes a NULL ACL
only for a record whose complete descriptor (with the explicit ACL) is the legacy189 expectation or an addition of a
listed source contract, and only after the whole proposed catalogue passes the unchanged source comparison; afterwards
the strict comparison runs again before COMMIT. Any failure drops the new database. A new release migration that adds
a relation, sequence or schema with an explicit owner-only ACL must add its source contract to the normalizer list:
`tests/ordinary-legacy-schema-contracts.test.mjs` derives the required set from `migration-manifest.mjs` and fails
otherwise; `tests/dump-restore-start.database.test.ts` runs dump → restore → `server/index.ts` on a clone
(`dynaminds_dumprestore_YYYYMMDD_NN`). Measured 30.10.2026 at HEAD 263: `docs/parity/CRM-N25B-LOCAL-20261023.md`.
Measured 11.11.2026 at HEAD 267 (fresh `migrate()` 001–267, PostgreSQL 18.4): 258 ACLs materialized (255 + the three
266/267 tables), restored ACLs equal to the source, 16 guards true, `/api/health` 200 with schema 267; the normalizer
without 266/267 refused `267 exact complete addition descriptor:relation public.automation267_editors`.

## Archiving (in the image)

| Setting | Value | Where |
|---|---|---|
| `archive_mode` / `wal_level` | `on` / `replica` | `tools/scale/docker/postgresql.scale.conf` |
| `archive_command` | `/usr/local/bin/dyna-wal-archive %p %f`: zstd (level 1) to `/wal-archive/<name>.zst`, fsync of the file and the directory before success; an identical re-archive succeeds, different content is refused | `tools/scale/docker/dyna-wal-archive` |
| `archive_timeout` | `60s`: a segment with any write is switched and archived within ~60 s | conf |
| restore | `dyna-wal-restore <dir> %f %p` reads `.zst` or plain (archives from before 27.10.2026) | `tools/scale/docker/dyna-wal-restore` |
| archive volume | `dyna-scale-pg18-wal-archive` (separate from the data volume `dyna-scale-pg18-data`) | `compose.yml` |

A forced switch of an almost empty 16 MiB segment compresses to < 1 KiB (measured 690 B), so the
60 s timeout costs disk only when there are writes.

**libfaketime.** While the generator moves the database clock into the past (`--simulate-days`),
`archive_timeout` does not fire (the server sees its last switch in the future); segments are still
archived when they fill. The RPO bound holds with the real clock (`SCALE_FAKETIME=off`, the measured
release and normal operation). For PITR inside a simulated-days run use restore points
(`restore-point`, below), not times.

## Commands (`node tools/recovery/pitr.mjs …`)

All output is JSON without secrets. Every argument is validated before anything runs
(`tools/recovery/pitr-lib.mjs`, tests `node --test tests/recovery-pitr.test.mjs`).

```sh
R=tools/recovery/pitr.mjs; S="$PWD/data/recovery/sets"; P=<operator passphrase file, 0600>
# base backup set (run periodically, e.g. every 6 h; RPO comes from the archive, the interval bounds WAL replay)
node $R base-backup --source dyna-scale-pg18 --sets "$S" --files "$PWD/data/product-images" \
  --keys "$PWD/data/scale/pg18-docker/local-config.json" --passphrase-file "$P" \
  --config "$PWD/tools/scale/docker/postgresql.scale.conf" --config "$PWD/tools/scale/docker/compose.yml" \
  --config "$PWD/tools/scale/docker/Dockerfile" --config <release-build.json>
# images written between base backups (append-only mirror; run as often as the RPO, e.g. every 5 min)
node $R files-sync --files "$PWD/data/product-images" --mirror "$PWD/data/recovery/files-mirror"
node $R restore-point --source dyna-scale-pg18 --name before_migration_237   # named target + WAL switch
node $R verify-set --set "$S/<id>"
# restore to a NEW container + volumes (refuses existing ones, the source container and dyna-scale-pg18)
node $R restore --set "$S/<id>" --target dyna-recovery-t1 --target-time 2026-10-27T04:05:06.123Z \
  --state <dir for files, keys, config> --passphrase-file "$P" --files-mirror "$PWD/data/recovery/files-mirror/product-images"
node $R prune --sets "$S" --source dyna-scale-pg18 --keep 3            # plan only; --apply deletes sets + old WAL
```

Periodic runs (local, not GitHub Actions), e.g. `crontab -e`:

```cron
0 */6 * * *  cd "<workspace>/development/full-base" && node tools/recovery/pitr.mjs base-backup --source dyna-scale-pg18 --sets "$PWD/data/recovery/sets" … >> data/recovery/cron.log 2>&1
*/5 * * * *  cd "<workspace>/development/full-base" && node tools/recovery/pitr.mjs files-sync --files "$PWD/data/product-images" --mirror "$PWD/data/recovery/files-mirror" >> data/recovery/cron.log 2>&1
```

### Backup set layout (`data/recovery/sets/<UTC id>-<container>/`, everything 0700/0600)

| Path | Content |
|---|---|
| `manifest.json` | `dyna-recovery-set/v1`: source container, archive volume, **system identifier**, timeline, start WAL/LSN, size + sha256 of every file |
| `base/base.tar.zst`, `base/pg_wal.tar`, `base/backup_manifest` | `pg_basebackup -Ft -X stream --compress=client-zstd:level=3`, checked with `pg_verifybackup` |
| `files/<dir name>/…` | snapshot of the image directory at backup time |
| `keys/local-config.json.sealed` | `dbPassword` + `encryptionKey`, AES-256-GCM, key from scrypt (N=2^15, r=8, p=1) of the passphrase |
| `config/…` | `postgresql.scale.conf`, `compose.yml`, `Dockerfile`, the release's `release-build.json` |

### Keys and the passphrase

- The passphrase is read **only** from `--passphrase-file`: a regular file (no symlink) of the operator,
  mode 0600, at least 12 characters. It is never an argument, an environment variable or a log line, and
  it is not stored in the set. Keep it outside `data/recovery` (password manager, separate medium); the
  operator writes it to a 0600 file for the duration of a backup/restore and passes that path.
- A wrong passphrase or a changed key file is refused (GCM tag); nothing is written.
- Restored keys land in `<state>/local-config.json` (0600). The release accepts only a 0600 file of the
  process user whose `dbPassword` equals the database URL's password.
- Application processes get the database URL from a 0600 `--env-file`, not from the docker command line.

### Refusals

| Case | Refusal |
|---|---|
| archive segment, `backup_manifest` or restored cluster with another system identifier | `system identifier mismatch (<what>)` |
| changed / missing / non-private file in the set | `<path>: sha256 differs …`, `… must be 0600` |
| restore target = source container or `dyna-scale-pg18`, or target container/volume exists | `refused: …` |
| not exactly one of `--target-time` / `--target-name` / `--latest`; non-ISO time; unsafe names/paths | argument errors before any Docker call |
| `--keys` without `--passphrase-file`; `--passphrase` on argv | argument errors |

## Drills

- `node tools/recovery/rpo-drill.mjs --src <disposable container> --dir <dir>`: writes acknowledged
  commits every 100 ms, `kill -9` of the server 2.5 s before the next `archive_timeout` switch (worst case),
  restore of base backup + archive only (data volume treated as lost), comparison of the newest restored
  row with the newest acknowledged commit; then crash recovery of the killed server on its own volume.
- `node tools/recovery/restore-drill.mjs --src <container> --template <db> --db <dynaminds_scale_…> --release <release-build.json> --dir <dir> --passphrase-file <f>`:
  seeds a non-empty queue through the release API (`drill-app.mjs seed`), base backup, more WAL-only
  work, target time, canary after the target; then the timed restore to a new container, release CLI
  with `--scoped-automation`, ten guards, queue drained exactly once, API reads with the restored session,
  restart and re-check. Report: `<dir>/drill-report.json`.

- `node tools/recovery/full-drill.mjs --dataset dyna-scale-full-pg18 --db <dataset db> --release <release-build.json> --local-config <dataset local-config.json> --dir <dir> --passphrase-file <f>`:
  the same drill on the full stage 5 dataset. The dataset container is only base-backed-up; a `--latest` restore of it
  is the drill source (`dyna-recovery-full-src`). Seed (API read-back sample of 5 orders + 5 invoice230 documents per
  tenant, rule, image, N pending jobs), base backup set, N more orders after it, row counts of every table per tenant
  as the recovery point, then probe commits every 100 ms and `kill -9` of the drill source just before an
  `archive_timeout` switch. Timed from the kill: `--latest` restore into `dyna-recovery-full-t1`, measured RPO, counts
  compared, release cold start, 10 + 2 guards, queue drained once, read-back compared. Report: `<dir>/full-drill-report.json`.
  Measured run: `docs/scale/RECOVERY-DRILL-FULL-20261029.md`.

All of them refuse `dyna-scale-pg18` as source or target; their sources are containers restored from a base backup.
