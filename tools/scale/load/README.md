# Load test (stage 5, goal conditions 10–12)

Driver for the profile "30 min × 12 and 30 min × 24 clients with active workers; p95/p99, zero errors"
(`docs/scale/MEASUREMENT-MANIFEST-20261025.md` sections 5–6, `docs/parity/acceptance-profile.v1.json`).
Dry run and its findings: `docs/scale/LOAD-TEST-DRYRUN-20261027.md`.

| File | Role |
|---|---|
| `run.mjs` | orchestrator on the host: setup, release CLIs, client containers per phase, monitor, drain, report |
| `setup.mjs` | inside the release: owner sessions of tenants A–E, one `order.created → add_note` rule with its local worker per tenant |
| `client.mjs` | one closed-loop client per container (one request in flight, no think time, no retry; 409 classified, labelled races with a no-effect readback) |
| `prepare.mjs` | unmeasured preparation of each command from current state over the ordinary API |
| `report.mjs` | rebuilds `run.json`'s result and `SUMMARY.md` of a finished run from its `raw/` files |
| `probe.mjs` | business readiness of one fresh release CLI (cold start): `/api/health` with scoped automation, an authenticated `GET /api/orders` per tenant |
| `reconcile.mjs` | correctness reconciliation after the run (read only): stock ledger, reservations, orders, invoices, payments, jobs, orphans, 15 guards → `raw/reconciliation.json`, PASS/FAIL |
| `lib.mjs` | pure parts: mix cycle, task schedule, histograms, expected values, one-shot fixtures, labelled races and 409 causes, report (mix, write share, stock), markdown (tests: `tests/scale-load.test.mjs`) |

## Topology

Everything runs in the network namespace of `dyna-scale-pg18` (`--network container:dyna-scale-pg18`), nothing is
published. The release accepts only a loopback database session on the server's own port (manifest section 7
item 11) and its CLI listens on `127.0.0.1` only, so the app cannot sit on a separate Docker bridge.

- `dyna-load-app`: `ordinary-local-cli.mjs … 4101 --scoped-automation` (HTTP + the release's scoped worker);
- `dyna-load-worker-2…`: more release CLIs (`4102…`, `--scoped-automation`), worker processes without client traffic
  (`--workers 2` = two worker processes, profile `minimum_actual_worker_processors`);
- `dyna-load-<phase>-cNN`: one container per client; each binds its own source address `127.0.0.(11+N)`, so the
  per-peer limit (`server/http-peer-ip.ts`, `server/rate-limit-config.ts`; 600/min unless the run sets
  `--rate-limit-per-min`) counts each client separately;
- monitor (in `run.mjs`, over `127.0.0.1:$SCALE_PG_PORT`, default 57090): every 0.5 s `pg_stat_activity` of the database (state, wait event,
  query), every 1 s the pending jobs created during the run and the oldest pending age (partial index `jobs_claim`),
  every 30 s and every 1 s while draining also running, done and failed (a scan of `jobs`, which keeps every done
  job: `full: true` rows; only these end the drain), every 30 s and every 1 s while draining (or with `--hold`) the
  completion lag of the rules (`automation_runs.finished_at − orders.created_at`, a scan of `automation_runs`; the
  `finished_at` cursor loses no run, and each lag counts in the phase of its finish time), every ~15 s `docker stats`.

## Requests

Each client walks its share of one global sequence: task n = k·clients + client, tenant = n mod 5, operation =
an interleaved 100-slot cycle of the profile mix (15 % `order_create`, 10 % `reserve_and_status`, …). Before each
measured request the client prepares the command (current versions, balances, previews, lot positions; recorded in
`*.prep.ndjson`, not in latencies), builds a one-shot fixture and sends the request produced by the source-pinned
bindings (`scripts/full-base-scale-http-ports.mjs` `prepare`), then checks the response with their `complete`
(exact totals, versions, fresh `reused:false` outcomes, fragments). A request is a success only when that check passes.

| Operation | Variant sent | Preparation |
|---|---|---|
| `order_list` | recent / older than 30 days (cursor), half with `status=shipped` | — |
| `catalog_search` | SKU / text 50:50, hit / no hit / broad 50:25:25, half with `warehouse_id` | catalogue window (below) |
| `order_detail` | dataset orders the load never writes (new/paid/picking/packed/cancelled) | list read once, from orders created before the run start (`run_started_at`) |
| `order_create` | `POST /api/orders`, profile line/unit buckets, products of the window with available ≥ 8, ≤ ¼ of it per line | catalogue window, new window every 10 orders |
| `reserve_and_status` | own paid order `paid → picking` | own order paid (receipt or `PATCH paid`), fresh version |
| `payment_or_document` | half receipt for the amount due of an own new order, half invoice of a shipped order: 230 preview (`POST /api/invoice230/orders/:id/previews`) issued by the native `…/local-invoices/previews/:id/issue` alias into FV-S (the sealed 157 budget allows 2000 local invoices per company for life) | order read, 230 invoice preview |
| `stock_operation` | A/C/E: WMS adjustment +1, −1 (lot layer), transfer MAIN → ZAP 1 unit; B/D: manual OFF PW/RW ±1 on the default bin (`POST /api/inventory/manual-corrections/previews/:id/apply`); every other command on a frozen hot SKU | A/C/E: policy, lot position (window or hot product), preview, preview rows; B/D: `…/manual-corrections/source` (revision), preview |
| `return_receive` | return case of 1 unit of a shipped order, then `POST /api/returns/:id/receive` (A/C/E with `wms_lots` picks) | order read, case, fragments, stock version |

Until 29.10.2026 `stock_operation` of B and D was recorded as `not_bindable`: the bindings accepted only the WMS
protocols, and B/D have no WMS lots by the profile (`dataset.per_tenant[].wms_lots: false`, the dataset plan follows it).
The bindings now also admit the native manual OFF correction of tenants without lots (`kind: 'manual_off'`, pinned
`server/manual-inventory-off*.ts`, `server/169_manual_inventory_off.sql`); the dataset and its plan digest are unchanged.

Catalogue window: three pages of 200 of `GET /api/products?warehouse_id=MAIN&sellable=true` from a random product id
(keyset `after`, wrapped to the start), so the load spreads over the whole catalogue; before 28.10 every client read
the same first 600 products and lot positions, which ran out first.

## Profile fidelity (28.10.2026)

- **Stock.** The mix has no receipt operation and the profile allows no extra driver client, so the dataset carries
  the stock: a run needs saleable units on MAIN for its whole length. The monitor samples, per tenant, the sum of
  `available` on MAIN and the SKUs with ≥ 8 available every 15 s; the report gives consumption per minute and the
  runway per phase. A command that cannot be prepared for lack of stock is counted under *skipped for lack of stock*
  (target 0). Sizing: `docs/scale/MEASUREMENT-MANIFEST-20261025.md` section 12.
- **Expected refusals.** Only the pre-labelled races of `EXPECTED_RACES` (`lib.mjs`) may refuse: 409 with the exact
  native reason on the stock row version (`return_receive` "Zapas zwrotu zmienił wersję. Odczytaj ponownie cały
  zakres", `stock_operation` "Stan lub rezerwacja zmieniły wersję"). Such a response is an *expected refusal*:
  a request in the denominator, not a success (excluded from success RPS and percentiles, own latency line),
  ≤ 1 % of the phase's requests, never retried (profile: no automatic retry of writes). The client reads back that
  it had no effect (return case not received; no new lot / unchanged layer); a visible effect is a failure
  `REFUSAL_HAD_EFFECT`. Every other 409 is an error, reported by cause (`stock_shortage`, `order_version`,
  `policy_version`, `version_other`, `other`).
- **Mix.** Per phase and per complete 60-s bucket: share of every operation among sent requests and the write share
  against the profile (tolerance 2 pp). Before 29.10 B/D `stock_operation` (not bindable, 2 % of tasks) lowered the
  sent write share to ≈ 38.8 %; with manual OFF every tenant sends it (profile 40 %).
- **Driver queueing.** One request in flight per client (intervals of measured and preparation calls never overlap),
  one keep-alive socket, the clock runs from `http.request` to the last body byte; each sample carries `ttfb_ms`, each
  client its event-loop delay (`*.loop.ndjson`), and `docker stats` includes the client containers.

## Profile compliance (29.10.2026, `docs/scale/LOAD-DRIVER-PROFILE-COMPLIANCE-20261029.md`)

- **Timing.** A plan that differs from `config.timing` (warmup 600 s, `steady12:12:1800,steady24:24:1800`, 3 cold
  starts per process) refuses to start unless `--dry-run`; `run.json` `profile_compliance` (`acceptance_run` only for
  the exact profile without `--dry-run`) and the `SUMMARY.md` header record it.
- **Cold start.** `--cold-attempts` (default 3, the profile): each release CLI is started that many times in a fresh
  container, one after another; each attempt is timed from `docker run` to business readiness (`probe.mjs`: listening,
  `/api/health` with `scoped_automation_enabled`, an authenticated `GET /api/orders?limit=1` for each of A–E). All but
  the last attempt stop again; the last serves the run. `run.json` `cold_start.processes.<name>`: attempts, median,
  max, `all_within` (each ≤ 180 s).
- **Hot SKUs.** `setup.mjs` freezes per tenant `--hot-skus` (default 4) products with ≥ 50 available on MAIN (lot tenants:
  with lot positions; B/D: simple products with their default bin) before any request; `run.json` `hot_skus`. Every
  other `stock_operation` targets them; per phase `hot` in the report (share, ok/refused/failed).
- **Finite-stock contention.** Per phase and tenant one frozen SKU with 2…7 available (`run.json` `contention_plan`,
  never picked by the ≥ 8 order window). The first `order_create` of three clients (the first whose schedule has one for that tenant, `contentionClients`) orders its whole
  available quantity: one may succeed, the others must be refused with exactly `Za mało towaru: <that SKU>. Dostępne: n`
  (a labelled race of that command only, no-effect readback: no order with the command's e-mail). Report:
  `hot.contention.tenants.<slot>.as_expected` (all sent, ≤ 1 accepted, the rest refused, 0 failures).
- **Labelled races.** `EXPECTED_RACES` adds `manual_off_source` (B/D apply on a changed frame: 409 `Manual OFF native source
  or authority refused`, readback: the preview has no receipt).
- **Background lanes.** `run.json` `background`: automation (the run's `order.created` rules) per tenant and phase —
  ≥ 5 completions in every complete minute and one in every rolling 60 s. Without `--woo`, `order_import` and
  `stock_sync` are recorded `blocked`. With `--woo <woo-store-bindings.private.json>` (official local WooCommerce stores,
  `tools/local/official-woo/README.md`) they are measured the same way from the database (`woo.mjs`, `woo-lanes.mjs`):
  - stores a–e serve tenants A–E (at least 2, profile `local_official_woo_instances_min`); a store whose order count plus
    this run's orders would cross the read ceiling (1000) refuses before any effect;
  - setup freezes 80 simple products per tenant (≥ 30 available on MAIN, not hot, not contention), the driver creates
    them in the store with the same SKU and stock (producer key, host side), maps them, enrolls the run's channel;
  - only `dyna-load-app` gets `--local-woo-stores` (copies of the CA and the importer key in `--out/private`),
    `--local-woo-reads`, `--local-woo-stock`, and it starts after the worker processes; the owned store root is
    masked (tmpfs) in every container;
  - lanes: stock-only offer sync 30 s, orders.sync read 60 s, import opt-in after the first read; source orders: one per
    store every 7.5 s with 3 mapped lines, from the first phase until the last one ends; then lanes off, drain;
  - `order_import` = import receipts done, `stock_sync` = offer plans `external_api_verified` with `desired_applied`;
    `run.json` `woo` also has the producer counts, per-channel rows and the stock readback (Woo vs DYNAMINDS) at the end.
  The release reaches the stores through the forwarder in the database container's namespace
  (`operator.mjs forward`). State 30.10.2026: wired and measured. Since `8f548bd`/`bcee492`, reads and plan
  conflicts no longer park a channel. An uncertain stock write still parks it, by design. Stock throughput stays
  below 12/min per minute under load (`docs/scale/LOAD-DRIVER-PROFILE-COMPLIANCE-20261029.md` §3.4, §8).
- **Reconciliation.** After the drain and after every release CLI has stopped, `reconcile.mjs` runs automatically;
  `run.json` `reconciliation` (`status`, `failed`, `guards_true`) and `raw/reconciliation.json` (all counts). A FAIL makes
  the run exit 1.

## Run

```sh
# release of the commit, dataset, a copy for this run (the run writes into it)
node tools/scale/release-build.mjs --out <dir> --base-contract <N29 dir> --base-contract-sha <sha>
tools/scale/docker/scale-pg.sh clone dynaminds_scale_YYYYMMDD_NN      # + generate.mjs --release (tools/scale/docker/README.md)
#   dataset for the full profile: --tenants 5 --skus 40000 --orders 4000 (stock for 600 s + 2 × 1800 s, manifest section 12;
#   dynaminds_scale_20261028_71), 5 min validation: --skus 20000 (dynaminds_scale_20261028_61)
tools/scale/docker/scale-pg.sh psql postgres -c "CREATE DATABASE dynaminds_scale_YYYYMMDD_MM TEMPLATE dynaminds_scale_YYYYMMDD_NN"
# full profile (the defaults are the profile: --warmup 600 --phases steady12:12:1800,steady24:24:1800 --cold-attempts 3)
node tools/scale/load/run.mjs --release <dir>/release-build.json --db dynaminds_scale_YYYYMMDD_MM --tag <plan tag> \
  --out docs/scale/results/<YYYYMMDD-HHMM>-<sha12> --workers 2
# driver validation only (not an acceptance run): shorter warmup/phases need --dry-run
node tools/scale/load/run.mjs … --warmup 60 --phases steady12:12:180,steady24:24:180 --workers 2 --dry-run
```

`--rate-limit-per-min <60…100000>` sets `DYNA_RATE_LIMIT_PER_MIN` for the release (owner decision 29.10.2026,
`docs/scale/LOAD-TEST-FULL-20261029.md` §4.1). It goes into `app.env` for setup and every release CLI.
- After start, `run.json` `rate_limit` records what each CLI reports in `/api/health` (`rate_limit`).
- The `SUMMARY.md` header shows the same value.
- A mismatch stops the run before warmup. So does the option on a release without that field.
- Without the option the run requires the default 600 (`source: default`). A release before 29.10 is recorded as
  `source: release-fixed`.

After the drain, before the release CLIs stop, `run.json` `reply_health` records each CLI's `/api/health`
`reply_warnings` and `ordinary_requests.late_hook_failures` (release 423497f and later); the `SUMMARY.md` header shows
the totals and marks NOT CLEAN for any non-zero count, an unreachable CLI or a release without the fields.

`--hold` (driver development) keeps the release running after the phases: writing `id:clients:seconds` to
`<out>/next-phase` runs one more phase (summary `<out>/hold-<id>.md`), `<out>/stop` ends the run.

Host sleep (full run 28.10.2026: clamshell on battery, `pmset -g log`). On macOS a run of ≥ 1800 s planned
(warmup + phases) refuses to start on battery (`pmset -g batt`); `--allow-battery` overrides. During the run a 1-s
clock sample compares `Date.now()` and `performance.now()`: a gap over 5 s is a `host_pause` event (`host_sleep` when
only the wall clock moved, `process_stall` otherwise) in `run.json` `host_pauses` and `raw/monitor.ndjson`; every phase
it overlaps gets `valid: false` and is marked NIEWAŻNA in `SUMMARY.md` (also after `report.mjs`).

Run from the checkout that holds `data/scale/pg18-docker` or set `SCALE_PG_STATE` to it.
The full-dataset instance (`docs/scale/FULL-DATASET-GEN-20261029.md`) runs with
`SCALE_PG_CONTAINER=dyna-scale-full-pg18 SCALE_PG_PORT=57091 SCALE_PG_STATE=<full-base>/data/scale/pg18-full-docker`;
the port follows the pairing rule of `scale-pg.sh` (57090 only for `dyna-scale-pg18`, Main/PG04 ports refused). Output: `run.json`
(report), `SUMMARY.md`, `raw/` (samples, preparation calls, monitor, container logs). Secrets (database URL,
session cookies, the local config copy) are in `<out>/private` during the run and deleted at its end.
