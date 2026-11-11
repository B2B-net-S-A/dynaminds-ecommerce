# KSeF purchase side: cost invoices received by the company's NIP. Prepared without a migration (26.10.2026, lane L1 part B)

## What exists now
This is pure modules and a local fake. Nothing is wired yet: no route, no worker job, no table, no change to `server/db.ts`. `KSEF_REAL_ENABLED` stays `false`, so the client refuses the test, demo and prod hosts before any request. It talks only to the loopback fake.

| File | What it does |
|---|---|
| `server/ksef-purchase-model.ts` | Pure functions. Metadata checks, a strict FA(3) reader and extraction, the checkpoint, KOR linking, read backoff, a bounded ZIP reader and export package pairing. |
| `server/ksef-purchase-client.ts` | `KsefPurchaseClient` makes the HTTP calls. `syncPurchaseInvoices` is the loop a future job runs: checkpoint → page → files → `store`. |
| `server/ksef229-fake-purchase.ts` | `startFakeKsefPurchase()` is a front server around the unchanged 229 fake (see "Fake"). |
| `tests/ksef-purchase-model.test.ts` (9), `tests/ksef-purchase-client.test.ts` (7), `tests/ksef-purchase-fixtures.ts` | Tests and the FA(3) files of received invoices they use. |

## Contract (KSeF 2.0 as implemented; uncertain points are in "Sandbox questions")
### Authentication
- The 229 login is reused: `KsefClient.authenticate()` runs challenge → MF keys → KSeF token (RSA-OAEP) or XAdES → status → redeem.
- The access token is cached until `validUntil − 60 s`. When it expires, it is renewed with `POST /auth/token/refresh` (refresh token). A full login happens only when there is no refresh token or KSeF refuses the refresh.
- A `401` in the middle of paging renews the token once and repeats the same request.
- The token needs the invoice-read permission. Secrets are redacted from every error.

### `POST /invoices/query/metadata?pageOffset={n}&pageSize={10–250}&sortOrder=Asc`
- Body: `{subjectType: "Subject2", dateRange: {dateType, from, to, restrictToPermanentStorageHwmDate?}}`.
- `dateType` is `PermanentStorage` (default), `Invoicing` (accepted by KSeF, used for "acquisition") or `Issue`.
- Answer: `{hasMore, isTruncated, permanentStorageHwmDate, invoices[]}`.
- Every invoice is checked (`parsePurchaseMetadata`): a KSeF number with a valid CRC-8, number, dates, seller NIP, currency, type (`Vat|Zal|Kor|Roz|Upr|KorZal|KorRoz`) and `invoiceHash` (base64 SHA-256). At most 250 per page; the answer is limited to 10 MiB.

### `GET /invoices/ksef/{ksefNumber}`
- Returns the FA(3) file as stored, read with a 3 MiB limit.
- `fetchInvoice` checks that the SHA-256 equals `invoiceHash`, the seller NIP, number and issue date equal the metadata, and the buyer NIP equals the context NIP. Then it parses the file strictly.

### Export package
1. `POST /invoices/exports` with `{encryption: {encryptedSymmetricKey, initializationVector}, filters}`. The fresh AES-256 key is RSA-OAEP-encrypted with the MF key whose usage is `SymmetricKeyEncryption`. The answer is `{referenceNumber}`.
2. `GET /invoices/exports/{ref}` is polled: `100` means in progress, `200` gives the `package`. The package lists `parts[]` (`ordinalNumber`, `url`, `partSize`, `partHash`, `encryptedPartSize`, `encryptedPartHash`) plus `isTruncated`, `last{PermanentStorage,Invoicing,Issue}Date` and `permanentStorageHwmDate`.
3. Each part URL is a pre-signed link, so the bearer token is never sent there.
   - Local fake: the URL must be the fake's own origin.
   - MF: https only, no credentials in the URL.
4. For each part: the encrypted size and hash are checked, the part is decrypted with AES-256-CBC and the export key/IV, then its plain size and hash are checked. The parts are joined in order.
5. The ZIP is read with `readPurchaseZip`:
   - only stored or deflated entries; no encryption and no ZIP64;
   - flat names `[A-Za-z0-9_][A-Za-z0-9._-]*` without `..`, and no repeated name;
   - declared sizes are bounded before inflating: 3 MiB per invoice, 64 MiB for `_metadata.json`, 512 MiB in total, at most 10 001 entries;
   - CRC is checked.
6. `parsePurchasePackage` pairs every `_metadata.json` invoice with its `{ksefNumber}.xml`. A file without metadata, or metadata without a file, refuses the package.

### Errors
| Error | When |
|---|---|
| `KsefUnavailableError` | 5xx after retries, timeout, no connection |
| `KsefRateLimitedError` (subclass of the above) | 429 with a Retry-After over 60 s, or 429 after the retries; carries `retryAfterMs` |
| `KsefRefusedError` | 4xx, or a failed export status |
| `KsefPurchaseDataError` | Bad data, with a `code` and a Polish message that contains no file content |

### Reads, rate limits and backoff
- All reads are idempotent. 429, 500, 502, 503 and 504 are retried up to 5 attempts.
- The wait is Retry-After (seconds or HTTP date) when KSeF sends one. Otherwise it is exponential from 500 ms to a 30 s cap, with jitter.
- A wait over 60 s is not slept. The attempt ends with `KsefRateLimitedError`, and the job reschedules itself.
- Requests are spaced by at least `minIntervalMs` (125 ms by default).
- The client's overall `deadline` (the 229 lease rule) cuts every request and wait.

## FA(3) reader (`parsePurchaseXml`, `parseReceivedFa3`)
- **Safety:** this is the approach of `carrier-dhl-xml.ts` (saxes, strict).
  - UTF-8 only: a fatal decoder, and a declared encoding other than UTF-8 is refused. A BOM is allowed.
  - No `DOCTYPE`, so no entity declarations and no XXE. An undefined entity is a syntax error. No processing instructions.
  - Limits: one root, at most 3 MiB, depth 24, 100 000 elements, 1 MiB of text per element.
  - Attributes are kept, because `KodFormularza@kodSystemowy` must be read.
- **Accepted:** the root `Faktura` in namespace `http://crd.gov.pl/wzor/2025/06/25/13775/` with `kodSystemowy="FA (3)"` and value `FA`. Every element that should be single must appear once.
- **Extracted:**
  - seller NIP (checksum) and name; buyer NIP / NrVatUE / NrID and name;
  - `P_2`, `P_1`, `P_6` or `OkresFa`, `KodWaluty`, `RodzajFaktury`;
  - totals per rate in minor units: `P_13_x`/`P_14_x`/`P_14_xW` for 23/22, 8/7, 5, 4 and OSS; 0 % domestic/WDT/export; zw; np I/II; reverse charge; margin;
  - `P_15`; annotations P_16 (cash method), P_17 (self-invoicing), P_18 (reverse charge), P_18A (split payment); the first payment due date.
  - An amount with more than 2 fraction digits, an exponent or an unsafe size is refused.
- **Corrections:** for `KOR`, `KOR_ZAL` and `KOR_ROZ`, at least one `DaneFaKorygowanej` is required, each with exactly one of `NrKSeF=1` + `NrKSeFFaKorygowanej` (a valid KSeF number) or `NrKSeFN=1`. `PrzyczynaKorekty` and `TypKorekty` (1|2|3) are read too.
- **Linking (`linkCorrection`):**
  - A reference is linked by its KSeF number when it has one, otherwise by seller NIP + number + issue date.
  - It is never linked to another seller's invoice (`seller_mismatch`). Two candidates give `ambiguous`.
  - An unresolved reference stays: the original may arrive later or predate KSeF.

## Checkpoint (`PurchaseCheckpoint`, JSON, `parsePurchaseCheckpoint` refuses a corrupted one)
- **Shape:** `{version: 1, nip, dateType, completedUpTo, window: null | {from, to, cursorFrom, cursorOffset, boundary[], hwm}}`.
- **Opening a window (`startPurchaseWindow`):**
  - `from = completedUpTo − lookback` and `to = min(run start, from + 90 days)`.
  - Lookback: PermanentStorage 0 (KSeF HWM), Invoicing 1 day, Issue 14 days (offline and emergency invoices arrive up to 7 business days late).
  - A run catches up to the moment it started.
- **Paging (`advancePurchaseCheckpoint`):**
  - The page must belong to the current cursor, otherwise `stale_page`. Its dates must be inside the range and non-decreasing, otherwise `contract`.
  - The next query starts at the last date of the page, inclusive, with offset 0. The KSeF numbers already seen at that date are kept in `boundary` and filtered out.
  - A page entirely of one date moves only the offset, and every number seen stays in `boundary`.
  - So a boundary that splits a same-date group, or an invoice that appeared between pages, is re-read and never skipped. More than 10 000 invoices at one instant ends with `stuck` instead of a loop.
- **Closing a window:** when there are no more pages, `completedUpTo = min(to, HWM)` for PermanentStorage (never backwards), otherwise `to`.
- **Export packages (`advanceAfterExport`):** a truncated package moves the cursor to its last date, inclusive.
- **Dedup key = KSeF number.**
  - In memory, the boundary and the page.
  - In storage, `UNIQUE(tenant_id, ksef_number)` with `ON CONFLICT DO NOTHING`. `store` returns the duplicate count.
- **Restart:**
  - `store` persists the page's invoices, rejects and the new checkpoint in one transaction.
  - A crash before it leaves the old checkpoint, so the page is read again.
  - A refused file becomes a reject and does not block the checkpoint.

## Fake (`server/ksef229-fake-purchase.ts`)
- It is a front server on 127.0.0.1 that forwards every request it does not serve to an unchanged `startFakeKsef()`, so 229 behaviour is untouched.
- It learns access tokens from the forwarded login answers (ksef-token/xades → redeem → refresh) and checks them with the same clock.
- It publishes its own `SymmetricKeyEncryption` key and re-encrypts the session key for the 229 fake on `POST /sessions/online`. A test proves that a 229 send still works through the front.
- Its key list is valid 2000–2100, because the 229 client checks key validity by the wall clock and tests use their own clock.
- Own routes:
  - query metadata: Subject1/2, the three date types, HWM restriction, 10–250 page size, a 90-day range, `truncateAt`;
  - download;
  - export: status polls, ZIP split into parts and encrypted per part;
  - part links, which refuse an `Authorization` header.
- Controls: `addReceivedInvoice`, `setHwm`, `setTruncateAt`, `setExportPartSize`, `setExportPolls`, `failNext(route, status, n, retryAfter)`, `tamperDownload`, `expireAccessTokens`, `onQuery`, `queries`.

## Migration proposal (next free number when the slot comes, e.g. `2NN_ksef_purchase`; requires 229)
All tables follow the 229 conventions:
- `tenant_id uuid NOT NULL`, composite FKs `(tenant_id, …)`;
- RLS `ENABLE` + `FORCE`, policy `tenant_scope TO dyna_app USING/WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)`;
- `REVOKE ALL … FROM PUBLIC, dyna_app`, then column grants. No DELETE or TRUNCATE for `dyna_app` and, through guards, not for the owner either, except the retention function.

1. **`ksef_purchase_sync`**: one row per `(tenant_id, nip)`, PK; FK `(tenant_id, nip) → ksef229_configs(tenant_id, nip)`.
   - Columns: `enabled boolean`, `date_type text CHECK IN ('PermanentStorage','Invoicing','Issue')`, `start_from timestamptz`, `checkpoint jsonb NOT NULL` (CHECK `checkpoint->>'version'='1' AND checkpoint->>'nip'=nip AND checkpoint->>'dateType'=date_type`; the application validates the rest with `parsePurchaseCheckpoint`).
   - Run fields: `lease_token uuid`, `leased_until timestamptz`, `last_run_at`, `last_ok_at`, `last_error text` (no secrets), `rate_limited_until timestamptz`, `created_*`, `updated_*`.
   - Grants: INSERT, plus UPDATE of everything except `tenant_id`, `nip` and `created_*`. Writing the checkpoint is fenced by the exact lease, as in RES-04.
2. **`ksef_purchase_invoices`**: `id uuid PK`, `UNIQUE(tenant_id, id)`, **`UNIQUE(tenant_id, ksef_number)`** (the dedup key).
   - Identity: `buyer_nip` (FK to the sync row), `ksef_number` (format CHECK as in 229), `seller_nip`, `seller_name`, `invoice_number`, `invoice_type` (metadata enum), `fa3_kind`.
   - Dates: `issue_date date`, `sale_date`, `sale_period_from/to`, `invoicing_date`, `acquisition_date`, `permanent_storage_date timestamptz`.
   - Amounts: `currency char(3)`, `net_total`, `vat_total`, `gross_total numeric(18,2)`, `vat_pln_total`.
   - Flags: `split_payment`, `cash_method`, `self_invoicing`, `reverse_charge`, `has_attachment`, `invoicing_mode`, `payment_due_date`.
   - File: `xml bytea NOT NULL` with `xml_bytes` (CHECK `= octet_length(xml)`, ≤ 3 MiB), `invoice_hash` (CHECK base64 of SHA-256 of `xml`, length 44), `xml_sha256` hex (CHECK = sha256(xml)).
   - Source: `source text CHECK IN ('query','export')`, `fetched_at`.
   - Workflow: `status text CHECK IN ('new','accepted','booked','ignored')`, `booked_at`, `booked_by`, `accounting_ref text`, `note text`.
   - Retention: `retain_until date NOT NULL`, `legal_hold boolean NOT NULL DEFAULT false`.
   - Guard `ksef_purchase_invoice_guard()`: everything taken from KSeF is immutable. Only the workflow columns, `legal_hold` and `retain_until` (later only) change. No DELETE except through `ksef_purchase_retention_purge()`.
   - Index `(tenant_id, buyer_nip, permanent_storage_date)`, `(tenant_id, seller_nip, invoice_number, issue_date)` for KOR linking, `(tenant_id, status)`.
3. **`ksef_purchase_invoice_rates`**: PK `(tenant_id, invoice_id, rate_code)`; `rate_code CHECK IN ('23','8','5','4','oss','0_kr','0_wdt','0_ex','zw','np_i','np_ii','oo','marza')`, `net`, `vat`, `vat_pln numeric(18,2)`. Insert-only, written in the same transaction as the invoice.
4. **`ksef_purchase_corrections`**: PK `(tenant_id, correction_id, ordinal)`.
   - FK `correction_id → ksef_purchase_invoices`.
   - Reference: `ref_invoice_number`, `ref_issue_date`, `ref_ksef_number` (nullable).
   - Link: `resolved_invoice_id` (nullable FK), `resolved_by CHECK IN ('ksef_number','invoice_number')`, `problem CHECK IN ('seller_mismatch','ambiguous')`.
   - The resolution can be set once, later, when the original arrives (guard).
5. **`ksef_purchase_rejects`**: PK `(tenant_id, ksef_number)`; `buyer_nip`, `invoice_hash`, `code`, `reason` (Polish, no content), `first_seen_at`, `last_seen_at`, `attempts`, `resolved_at` (set when a later download succeeds).
   - No file content is stored. A refused file may be hostile, and the user can see it in the MF app.
6. **`ksef_purchase_exports`**: an export in progress must survive a restart.
   - Columns: `reference_number` UNIQUE per tenant, `buyer_nip`, `filters jsonb`, `key_ciphertext text` (the app's AES-256-GCM `encrypt()` of `{key, iv}`, set to NULL by the guard once the state is final), `state CHECK IN ('started','ready','downloaded','failed','expired')`, `expires_at`, `created_at`.
7. **`ksef_purchase_events`**: append-only log with kinds `run_start`, `page`, `stored`, `duplicate`, `rejected`, `rate_limited`, `token_refresh`, `export_*` and `error`. It holds counts and KSeF numbers, never tokens and never file content.

### Retention (tax law and RODO)
**Tax.** Invoices must be kept until the tax liability lapses: art. 112 VAT and art. 70 §1 Ordynacja podatkowa, 5 years from the end of the year of the payment deadline. Accounting evidence follows art. 74 ust. 2 ustawy o rachunkowości (5 years from the start of the following year).
- `retain_until = 31 December of (year(issue_date) + 6)`. This covers the December invoice whose VAT is due in January.
- An interrupted or suspended limitation (proceedings, a control) is handled with `legal_hold`.
- KSeF itself keeps invoices for 10 years, so the local copy is not the only one.

**RODO.** Sole-trader sellers and buyer contacts are personal data.
- Purpose: tax and accounting.
- Access: the accounting role only (route permissions), plus RLS.
- `ksef_purchase_retention_purge()` (SECURITY DEFINER, owner only, scheduled) deletes invoices, rates and corrections with `retain_until < current_date AND NOT legal_hold`.
- Rejects and events older than 1 year are deleted.
- An export key is deleted the moment its package is read.
- A RODO erasure request does not override the tax retention (art. 17 ust. 3 lit. b). It is answered with the retention date, and the row is purged by the same function afterwards.

## Wiring list (when the migration lands)
1. **Store.** `server/ksef-purchase.ts` (DB) implements `PurchaseStore` in one `tenantTx`:
   - `INSERT … ON CONFLICT (tenant_id, ksef_number) DO NOTHING`, returning the duplicate count;
   - the rates;
   - KOR references resolved with `linkCorrection` against the existing rows, and earlier unresolved references pointing at the new number resolved too;
   - rejects upserted;
   - the checkpoint updated, fenced by the lease;
   - events appended.
2. **Worker job `ksef.purchase.sync`** (free-text kind in `jobs`, one dispatch branch in `server/worker.ts`, like `ksef.status`):
   - one pending job per `(tenant, nip)`, scheduled every 30 min while `enabled`;
   - lease longer than the client deadline (RES-04 rule);
   - `maxPages` per run, with immediate requeue when `done=false`;
   - `KsefRateLimitedError` reschedules at `retryAfterMs`; `KsefUnavailableError` uses the generic backoff of `tick()`.
3. **Job `ksef.purchase.export`** for the first backfill (from `start_from`, e.g. 2026-02-01) and for windows with more than 10 000 invoices: `startExport` → store the encrypted key → poll → `downloadExportPackage` → `checkedEntry` per file → the same `store`.
4. **Routes `/api/ksef-purchase/…`**:
   - `GET status`, `GET invoices` (filters: seller, dates, status, type, amount), `GET invoices/:id`, `GET invoices/:id/fa3.xml`;
   - `PATCH invoices/:id {status, accounting_ref, note}`, `POST sync/:nip` (queue now), `PUT sync/:nip {enabled, date_type, start_from}` (admin), `GET rejects`, `POST rejects/:ksef/retry`.
   - Roles: administrator and accountant write; viewer reads.
5. **UI "Faktury kosztowe z KSeF"** (Dokumenty):
   - list with filters and badges (KOR, split payment, reverse charge, overdue payment);
   - detail with seller, numbers, dates, the rates table, the KOR chain (links both ways), "Pobierz XML", "Oznacz jako zaksięgowaną" / "Pomiń";
   - per NIP: sync state (checkpoint date, last run, last error, rate limited until), "Pobierz teraz";
   - rejects list with reason and "Pobierz ponownie".
   - Settings → KSeF: the "Pobieraj faktury kosztowe" switch and the start date.
6. **Accounting export:**
   - CSV/XLSX of booked or accepted invoices with rates;
   - the purchase-side JPK_V7 rows (`K_40`–`K_47` need the user's classification, fixed assets vs other, so a category column is added to the workflow);
   - `NrKSeF` on purchase JPK rows (coordinate with the `server/jpk-*` owner).
7. `/api/health`: `ksef_purchase_available`.

## Sandbox questions (to confirm against the MF test environment and OpenAPI)
1. **Query paging.** Exact `pageSize` limits (10–250?) and the result cap that sets `isTruncated` (10 000?). Whether `hasMore` is false when truncated. The maximum `dateRange` (90 days assumed). Whether `to` is required.
2. **Ordering.** The sort order within equal dates (is it stable between calls?), and the precision of the date fields (ms or µs). The checkpoint is safe for unstable order across a date change, but within one same-date group larger than a page it relies on a stable order.
3. **HWM.** The `permanentStorageHwmDate` semantics, and whether `restrictToPermanentStorageHwmDate` is honoured for `PermanentStorage` only. Whether `Invoicing` really is the acquisition date (`acquisitionDate` vs `invoicingDate`).
4. **Metadata field names.** `seller.nip`, `buyer.identifier{type,value}`, the `invoiceType` enum, `invoiceHash`, `currency`, `netAmount`/`grossAmount`/`vatAmount`, `isSelfInvoicing`, `hasAttachment`, `thirdSubjects`.
5. **`GET /invoices/ksef/{nr}`.** The content type, whether the bytes are exactly those whose hash is `invoiceHash`, and whether a buyer may download it when the invoice names it only in `Podmiot3`.
6. **Export.**
   - Body shape (`filters` vs top level), status codes and texts, whether parts are encrypted separately with the same key/IV (assumed) or the whole ZIP is encrypted and then split.
   - The part URL host (for an allowlist), file names inside the ZIP (`{ksefNumber}.xml`, `_metadata.json` assumed), the package size cap and expiry, `isTruncated` with `last*Date`.
7. **Rate limits.** The per-endpoint limits (per second, minute and hour) for query, download and export. The `Retry-After` format. Whether 429 counts against the limit.
8. **Permissions.** The KSeF token permission needed for reading invoices (`InvoiceRead`?), and whether the same token as for sending can carry it.
9. **Subjects.** Whether `Subject3` (Podmiot3, e.g. the payer) and `SubjectAuthorized` should also be pulled for the purchase ledger.
10. **Corrections.** Whether `NrKSeFFaKorygowanej` is always the original's number in KSeF for KSeF-era originals, and how a correction of an offline invoice that has no number yet is referenced.

## Verification (26.10.2026)
- `npx tsc --noEmit -p .`: clean.
- `node --import tsx --test tests/ksef-purchase-model.test.ts tests/ksef-purchase-client.test.ts`: **16/16** (9 + 7), three runs in a row.
  - Model: FA(3) extraction with per-rate minor units and PLN VAT of an EUR invoice; refusals (DTD/XXE, undefined entity, PI, non-UTF-8, size, depth, truncated, wrong namespace or form, duplicate element, bad NIP, date, kind, missing P_15).
  - Model: KOR references and linking (KSeF number, number + date, seller mismatch, ambiguous, unresolved); metadata and file-vs-metadata checks.
  - Model: checkpoint boundary re-read, HWM close, same-date offset, JSON restart, stale, out-of-range, unordered and stuck pages, corrupted checkpoint, Issue lookback and the 90-day cap; export advance; backoff; ZIP (deflate, bomb, CRC, traversal, encryption, pairing).
  - Client: 26 invoices with a 12-invoice same-date group across pages, an insertion between pages and a listed duplicate, all stored exactly once, and a second run giving 26 duplicates.
  - Client: DTD, truncated, foreign-buyer and tampered files become rejects while the checkpoint completes, and KOR is linked.
  - Client: token expiry mid-paging (refresh, one login) and a server 401 (one renewal).
  - Client: 429 with Retry-After 2 s, Retry-After 120 s as `KsefRateLimitedError` with the checkpoint unchanged, and 503 × 5 then unavailable.
  - Client: a crash at the second store, then a restart from the checkpoint JSON with nothing skipped, and `maxPages` resume.
  - Client: an export with 2 status polls and several encrypted parts, decrypted and paired; a truncated export advances; a wrong key is refused.
  - Client: MF hosts refused; a non-loopback fake refused; a 229 send through the front accepted.
- The existing 229 unit tests (`ksef229-client`, `-model`, `-crypto`) pass 29/29. In one earlier run before these changes, one `ksef229-client` test failed once; the rerun was green (pre-existing timing flake, no 229 file was changed).
