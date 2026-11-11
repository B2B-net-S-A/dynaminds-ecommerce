# Security review, stage 2-3 (25.10.2026)

Branch `goal/full-base-20261017`, range `f86dc41..0c2ab8b` (tax model 226, NBP 227, RODO 228, KSeF 229, FV-S 230/231,
KOR-S 232, receipts 233, settlement report, FA(3) all-documents, JPK, the `/issue` alias guard, the connector.php hooks).
Read-only review: code reading plus three throw-away probes that never touched Main (port 4100) or a database.

## Result

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 0 |
| Medium | 3 |

No finding is a data-loss or cross-tenant problem. The three medium findings are cheap to fix and should go in before merge;
none of them needs a migration. Low and informational notes are listed at the end and do not count.

## Medium findings

### M1. Any authenticated user (viewer) can make the server open TCP connections to loopback ports and read the first reply line

- Where: `server/receipt233-service.ts:83-85` (`receipt233TestPrinter` accepts a draft printer config), `server/receipt233-routes.ts:42`
  (route authorised with `actor(req, false)`, i.e. read access), `server/receipt233-printer.ts:107` and `:121`
  (`new PrinterError('PROTOCOL', line.slice(0, 80))` puts the first 80 characters of the peer's reply into the message).
- Why it is wrong: `local_invoice_access(..., writing=false)` admits `viewer` (`server/157_local_invoices.sql:65`). The draft body only has to pass
  `printerInput`, which allows host `127.0.0.1|::1|localhost` and any port 1024-65535 (`server/receipt233.ts:37-38`). The driver connects,
  sends `HELLO\n`, and the route returns `problems: ["... nieobsługiwanym protokołem (<first 80 chars of the reply>)"]`.
  A viewer therefore gets (a) an open/closed port oracle for the whole loopback interface (`ECONNREFUSED` vs a reply vs a 5 s timeout) and
  (b) the first line of whatever answers on those ports (local Postgres proxies, dev servers, the app's own port, AI/print/scale bridges).
  Saving a printer is admin-only, testing a draft is not.
- How to show it fails: probe run in this review (`scratchpad/probe-printer.ts`, a fake service answering `HTTP/1.1 400 Bad Request internal-banner: redis-like secret-123`):
  `fiscalPrinterDriver({host:'127.0.0.1',port}).status()` throws
  `Drukarka odpowiada nieobsługiwanym protokołem (HTTP/1.1 400 Bad Request internal-banner: redis-like secret-123)`;
  port 1 gives `... nie odpowiada (offline) ... (ECONNREFUSED)`.
  End to end: log in as a viewer, `POST /api/receipt233/printer/test` with
  `{"name":"x","model_family":"posnet","host":"127.0.0.1","port":<any>,"unique_number":"ABC12345678"}` and read `problems`.
  Test to add: `receipt233` routes test, viewer and operator get 403 on a draft body; the PROTOCOL message never contains peer bytes.
- Fix: require admin for a draft test (`taxInvoiceTransaction(a, true, ...)` plus the `can_configure` check used by `receipt233SavePrinter`), keep
  the no-body test of the saved printer for read roles. Independently, replace the peer bytes in the PROTOCOL detail with a fixed text
  (`'nieoczekiwana odpowiedź'`) and log the line server-side only.

### M2. The personal-data access register can be flooded and the flood cannot be purged for at least 180 days

- Where: `server/crm-routes.ts:53-62` (one register row per client of every list page, up to `limit` = 100, `server/crm-schema.ts:106`),
  `server/rodo228.ts:33-37` (insert), `server/228_rodo.sql:115-124` (rows are deletable only when older than the retention),
  `server/rodo228.ts:446` (retention minimum 180 days), `server/base-wire-routes.ts:134-136` (tenant limit 100/min is taken before the read,
  but the file route in `server/base-wire-crm-routes.ts:33-38` never calls `admitTenant`, so it has only the global 600/min per IP).
- Why it is wrong: the register is append-only on purpose, but its write volume is chosen by the reader. One session with CRM access calling
  `GET /api/crm/clients?limit=100` in a loop writes 100 rows per request; the global limit of 600 requests/min per peer
  (`server/app.ts:744`) allows about 60 000 rows/min (about 3.6 M rows/hour). Via connector.php, `getCrmClients` writes up to 100 rows per call
  (100 calls/min per tenant, about 10 000 rows/min) and the attachment download writes one row per call with no tenant limit.
  The rows are legitimate evidence, so `rodo228_purge_access_log()` refuses them until they are 180+ days old; the table (and every register
  page and export that reads it) grows without a bound that an administrator can act on.
- How to show it fails: DB test on a clone: seed 100 CRM clients, call `GET /api/crm/clients?limit=100` 50 times as a viewer, assert
  `count(*) FROM rodo228_access_log` stays small (today it is 5 000), then `POST /api/rodo228/access-log/purge` returns `deleted: 0`.
- Fix: log one register row per request (resource, count, and the client ids in `detail`, capped at 100 ids), or coalesce identical
  `(actor, api_key, action, crm_client_id)` rows inside a short window; give the connector file route the same `admitTenant` limit as the POST route.
  Keep the rule "a read that cannot be recorded is not returned".

### M3. `.local.json` (database password and the 256-bit encryption key) is not git-ignored

- Where: `/.gitignore` lists `node_modules/ dist/ data/ output/ *.log .env .env.*` only; `server/db.ts:43` reads `.local.json`
  (keys `dbPassword`, `encryptionKey`); `git status` shows it as untracked (`?? .local.json`).
- Why it is wrong: since 229 the same `encryptionKey` encrypts the KSeF token/certificate/private key (`server/security.ts:21-35`,
  `server/ksef229.ts:75`) and keys the RODO subject hashes (`server/rodo228-model.ts:43`). Several agents commit on this branch; one
  `git add -A` or `git add .` commits the key next to the ciphertexts. The file is mode 0600 and has never been tracked
  (`git log -- .local.json` is empty), so nothing leaked yet; this is the hygiene gate that keeps it so.
- How to show it fails: `git check-ignore -v .local.json` prints nothing (exit 1); `git add -n .` lists it.
- Fix: add `.local.json` to `.gitignore` (and a gitleaks/pre-commit rule for `encryptionKey`). If it was ever committed on another
  branch or worktree, rotate the key and re-encrypt the KSeF configs.

## Checked and found sound (evidence)

- Authorization on every new route is server-side and re-read per request: `server/app.ts:928-940` joins `sessions` with `memberships` on each
  request, so `req.actor.role` is the current role. 226/227 write routes require admin or `ensure(...)` on role (`tax226-routes.ts:28-34`,
  `nbp227-routes.ts:23-29`); RODO, settlement and JPK require a session and the current admin (`rodo228-routes.ts:39-46`, `paymentImportAdmin` =
  `offer_sync_is_admin`); 230/232/233 run in the native FV identity frame (`tax226-local-invoices.ts:38-42`, `local_invoice_access`: writes need
  admin/operator); KSeF settings are admin plus session only, send/queue admin/operator (`ksef229-routes.ts:47-57`).
- API keys cannot reach any new route: `authenticateApiKey` (`developer-api.ts:1536-1561`) accepts only `publicOperations` matched under
  `/api/v1`, and none of the new paths is one of them, so the `req.apiScopes` branches in the new routes are defence in depth. The existing
  `/api/v1/documents/:id/print` still maps to 230 invoices through the same frame (`app.ts:1537-1540`). connector.php scopes are unchanged since
  `f86dc41`; `baseWireRequiredScopes` still forces `<family>:read` with `<family>:write`, and `crm:write` requires `crm:read` (`developer-api.ts:1515-1535`).
- Tenant isolation: all 28 new tables enable and force RLS with `tenant_scope` for `dyna_app` and grant column-level updates only
  (`226..233_*.sql` loops); `tenantAppendTx` (`db.ts:193-218`) sets `app.tenant_id` and `SET LOCAL ROLE dyna_app` like `tenantTx`.
- SQL injection: every interpolated fragment in the new modules is a code constant (column lists, table names from fixed arrays in `rodo228.ts`
  `EVIDENCE/TAX/KSEF_FILES`, `jpk-source.ts` table list); values are bound parameters. LIKE patterns in the anonymiser escape `\ % _` (`rodo228.ts:327`).
- XML: FA(3) and JPK escape `& < >` (and `"` in JPK), `\r` as `&#13;`, text is checked by `b2bFa3XmlTextValid`, tag names and attribute values are
  constants (`fa3-render.ts:57-58`, `jpk-model.ts:70-71`). The only XML consumers are `fa3XmlFacts` (regex on our own output, rejects `<!DOCTYPE`/`<!ENTITY`,
  `ksef229-model.ts:74`) and the lxml XSD check with `no_network`, `resolve_entities=False`, `load_dtd=False` (`fa3-xsd.ts:23-38`): no XXE path.
- CSV: settlement cells get a leading apostrophe for `= + - @ \t \r` after optional whitespace (`settlement-report.ts:373-377`); the RODO CSV does
  the same (`rodo228-model.ts:146`). Filenames in `Content-Disposition` are generated from sanitised numbers or constants.
- HTML prints (`invoice230-print.ts`, `invoice232-print.ts`): every dynamic value goes through `htmlEscape`.
- KSeF secrets: AES-256-GCM at rest (`security.ts`), masked view only (`ksef229-model.ts:145-150`), secrets live in `#private` fields and are redacted
  from every client error (`ksef229-client.ts` `#redact`), no `console`/logger calls in the new modules, no key material in tests (runtime-generated) or docs.
  `KSEF_REAL_ENABLED` is a code constant `false` and `ksefBaseUrl` refuses test/demo/prod before any request; redirects are an error
  (`redirect: 'error'`); NBP reads go to the fixed origin `https://api.nbp.pl` through the declared provider transport (`nbp227-fetch.ts:14-31`).
- Numbering: 230 takes the shared `local_invoice_locks()` advisory lock, 232 locks per original invoice and then the counter row `FOR UPDATE`;
  both are backed by `UNIQUE(tenant_id,series_id,year,sequence)`, a counter guard and a deferred completeness trigger, so a duplicate number is
  impossible at the database level. The KSeF send takes a 3-minute lease with an atomic `UPDATE ... WHERE lease_until IS NULL OR lease_until<now`
  after `INSERT ... ON CONFLICT DO NOTHING` (`ksef229.ts:277-295`): two concurrent sends cannot both lease.
- `/issue` alias guard: Fastify applies a root `preHandler` to routes registered before and after it (probe `scratchpad/hook-order.mjs`: both
  `/before` and `/after` answered 409), so the 230 correction guard in `invoice230-routes.ts:42-52` covers the earlier 188/206/160 routes; the alias
  hook matches on `routeOptions.url`, keeps the 423 and Origin checks of the global `onRequest`, and the locked checks of `tax-issue` stay authoritative.
- Error messages: `Problem` texts are Polish business reasons; unexpected errors become the generic 500; connector.php maps with the `INTERNAL`
  filter (`base-wire-routes.ts:59-70`).
- RODO: register hooks are fail-closed (the read is not returned if the row cannot be written); hashes are keyed HMACs of the tenant and identifier;
  preview and confirm run the same function with a plan hash; refusal paths (open order, open return, unsettled payment) and the
  immutable-evidence savepoints are covered by `tests/rodo228.database.test.ts`; export and purge are admin plus session only.
- CSRF: session cookies are `SameSite=Lax` and every non-GET request that carries an `Origin` is checked against the allow-list (`app.ts:884-897`);
  all new mutations are POST/PUT.

## Low and informational (not counted, not blocking)

1. `server/ksef229-model.ts:46-47` + `server/ksef229-client.ts:40-47`: the local-fake `base_url` regex allows `.` and `/`, so `http://127.0.0.1:5432/v2/../../x`
   validates and `new URL` normalises it to another path on any loopback port (probe: `ksefBaseUrl('local_fake','http://127.0.0.1:9000/v2/../../metrics')` returns
   `http://127.0.0.1:9000/metrics`). Administrator only, loopback only, and only JSON `title/detail` text is echoed back, so low. Fix: reject `..` and `//` in the path.
2. `server/rodo228-routes.ts:54`: `GET /api/rodo228/export` writes a register row and takes a free-text `purpose` from the query, and session cookies are
   `SameSite=Lax`, so a cross-site top-level navigation by an administrator can create register rows with attacker-chosen text. Prefer POST.
3. Access-register scope is the CRM card and the three connector.php CRM reads only (documented in `RODO228-20261023.md`). Orders, invoices, receipts, the
   portal and the Base orders family also return e-mail, phone and address and are not recorded. Decide whether "who read personal data" must cover them;
   today the register is complete only for the CRM channel. Reads in a read-only restore preview are not recorded either.
4. `server/rodo228-model.ts:37-40`: customers are matched by the last 9 digits of a phone number, so numbers of different countries that share those digits
   can be pulled into one export or anonymisation. Keep the country prefix when it is present.
5. `server/invoice230-print.ts:44` and `server/invoice232-print.ts:32` (and the `/api/documents/:id/print` branch in `app.ts:1537`) send no
   `Content-Security-Policy`, unlike the older prints (`b2b-credit-routes.ts:17`). Escaping is correct today; the header is a cheap second layer.
6. `server/invoice232.ts:183-187`: KOR-S locks only per original invoice, so two first corrections of one series and year can both miss the counter row and the
   second fails with a unique violation (409 "Rekord już istnieje"). No duplicate number results; add a series-level advisory lock for a clean retry.
7. `server/ksef229.ts:44`: the 3-minute lease can be shorter than a worst-case attempt (about 14 requests of 15 s each); a second attempt would resend an
   invoice that KSeF rejects as a duplicate. Make the lease heartbeat or longer than the worst case.
8. `server/nbp227.ts:54-70`: a manual rate has no plausibility band against neighbouring fetched rates. Administrator only and audited (`nbp.rate_manual`);
   consider a warning when it differs by more than a few percent.
9. `server/rodo228-routes.ts:39-46` takes the role from the request-start membership; the irreversible anonymisation does not re-check it inside the transaction
   (the pattern `paymentImportAdmin` uses). The window is milliseconds.

## Not covered

No database-backed test or request against a running server was executed; the DB tests (`tests/*.database.test.ts`) were read, not run. Hash-pinned
files (`local-invoices.ts`, `local-invoice-routes.ts`, `local-invoice-values.ts`) are unchanged in the range. The web UI was checked only for
`dangerouslySetInnerHTML` and unsafe `href` (none; the KOD I link is built server-side from an `http(s)` base).
