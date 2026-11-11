# Integrating p276 (queue counters, manual dispatch, monitor lag cadence + prepared migration 276 automation_runs_queued_job)

Built on p275 (`INTEGRATION-p275.md`); integrate p275 first. Design and measurements:
`docs/parity/QUEUE-COUNTERS-P276-20261029.md`. Parts:

- **TS, no migration** (`server/*.ts`, commit "perf(p276): queue counters …"): 12 queue counters in 11 files count
  `(state='pending' OR state='running')`; manual dispatch in `server/local-automation-routes.ts` probes the dispatcher by
  its dedup key. Line counts unchanged. None of these files is in `server/catalog-stock-writer-coverage.ts` or
  `scripts/full-base-scale-http-ports.mjs`. One test-local pin moved: `tests/automation-rule-reconciliation.database.test.mjs`
  `sourceSha` of `server/automation-local-effects.ts` (review note in the file; that test is skipped by default).
  The counters need p275's migration (`jobs_running_lease`) to use an index; without it their plan is the sequential
  scan it was (measured), so the order of merging does not matter.
- **Driver** (`tools/scale/load/`): monitor lag query every 30 s (every 1 s while draining or with `--hold`), lags
  attributed by finish time. Merge as is.
- **Prepared migration 276** (`server/276_automation_runs_queued_job.sql`): one partial index for the
  `automation_runs` reaper of `tick()`. Kept separate from 275 on purpose: 275 costs nothing on the write path, 276
  makes the run completion (`queued → done`) a non-HOT update. If that trade-off is not wanted, drop 276 alone; the
  reaper then keeps its 147 ms per tick at 509 k runs.

## Left on purpose

- `server/wms-lots.ts:1365` (`(SELECT count(*) FROM jobs WHERE state IN ('pending','running'))::int jobs`): the WMS
  limits lane owns the file. Same one-string rewrite; it then needs the `SourceOpening`-style re-pin of `wms-lots.ts`
  in `server/catalog-stock-writer-coverage.ts` and `scripts/full-base-scale-http-ports.mjs`.
- `server/b2b-network.ts:332`: hash-pinned in `server/catalog-stock-writer-coverage.ts`
  (`tests/catalog-stock-writer-coverage.test.ts:80` asserts the pin and its reversal). Same rewrite, with a re-pin
  note and the reversal test extended.
- Both are listed in `KEPT` of `tests/queue-counters276.test.mjs`; remove the entry with the rewrite.

## Steps for 276 (as for 275)

1. `git mv server/276_automation_runs_queued_job.sql server/N_automation_runs_queued_job.sql`; first comment line
   `Migration 276_… (PREPARED placeholder; …)` → `Migration N_… (…)`. The object name has no number; keep it.
2. Manifest row in `shared/large-import-dependencies/pim-large-import173-business-traversal-ui/migration-manifest.mjs`
   after the last row (275's N if it went first):
   ```js
    row({number:N,name:'N_automation_runs_queued_job',file:'N_automation_runs_queued_job.sql',native_id:'automation_runs_queued_jobN',bytes:<B>,sha256:'<S>',contract:'automation-runs-queued-jobN',
     note:'OptionalN adds only the partial index automation_runs_queued_job ON automation_runs(job_id) WHERE state=queued for the tick() automation_runs reaper, after the exact P source.'}),
   ```
   `<B> <S>`: `node -e "const b=require('fs').readFileSync('server/N_automation_runs_queued_job.sql');console.log(b.length,require('crypto').createHash('sha256').update(b).digest('hex'))"`.
3. Cold catalogue pair before/after N on a clone of `dynaminds_restore_36751abef3079f3f` migrated to P: expected
   **1 addition** (index `public.automation_runs_queued_job` on `public.automation_runs`), 0 changes, 0 removals (or 1
   change of the table record if the catalogue lists indexes inside it). Source contract, compatibility module (the
   projector removes the index), one line in `release-cold-projectors.mjs`, a compatibility test — as for 253/275.
4. `tests/migration-ledger-guard.test.ts`: `release.length` +1, future names, MIG-2 expected `applied`.
   Runbook line in `docs/parity/MIGRATIONS-S1-20261026.md`.
5. `tests/queue-counters276.test.mjs`: replace the "not registered" assertions of the 276 test by the manifest test;
   its DB part runs only on `dynaminds_p276_YYYYMMDD_NN` with 275 and 276 applied by hand — add the new clone family and
   drop the by-hand step once `migrate()` applies both.

## Verify after integration

Without a database: `node --test tests/queue-counters276.test.mjs tests/scale-load.test.mjs tests/jobs-running-lease275.test.mjs
tests/scoped-automation-claim275.test.mjs`; `npx tsc --noEmit -p .`.

On a fresh clone migrated to HEAD: ledger count; 14 guards true (`jit=off`, UTC); cold inspection PASSED; the DB part of
`tests/queue-counters276.test.mjs`.

Measured on this branch (PG04 `dynaminds_p276_20261029_01`, 275 and 276 applied by hand): 14 guards true before,
after 275+276, and after `ordinary187_approve`.
