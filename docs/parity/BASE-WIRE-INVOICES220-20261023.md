# Base wire: invoices family (220), 23.10.2026

Fifth family on `POST /connector.php` (`server/base-wire-invoices.ts`, native port
`server/base-wire-invoices-runtime.ts`). Source: `base-api-document-contracts.v1.json` (Orders /
Invoices: getSeries, addInvoice, getInvoices, getInvoiceFile; HTML snapshot
`base-api-document-sources-20261017.json.gz`). Local acceptance only; no Base sandbox/account
request was made. No new migration. `getJournalList` is NOT implemented (it needs a migration,
see the last section).

## Identities
- Series = native `local_invoice_series`; `base_wire220_invoice_series_ids` (no insert trigger,
  allocated by `base_wire220_allocate_pending('invoice_series')`).
- Invoices = native `documents` of kind invoice/correction; `base_wire220_invoice_ids` (no insert
  trigger, `allocate_pending('invoice')`). addInvoice allocates in its own transaction; reads first
  allocate `order`, `invoice_series`, `invoice` in a short writing transaction (like getOrders), then
  read in a read-only one. A read-only copy never allocates.
- Orders: `base_wire220_order_ids`; unknown or foreign IDs → 404.

## Scopes and gate
`documents:read` for getSeries/getInvoices/getInvoiceFile, `documents:write` for addInvoice; write
also needs `documents:read` (`baseWireRequiredScopes`). Every method then runs the native
local-invoice gate inside the same transaction (`local_invoice_identity` + `local_invoice_access`,
as `transaction()` in local-invoices.ts): the X-BLToken must be the key's own token (credential
custody, `nativeCredentialCustody: true`), the key must also hold `orders:read`, MFA policy and
membership are current, writes need admin/operator. The pre-read allocation uses the read gate.

## Method → native mapping
| Method | Native source |
|---|---|
| getSeries | `local_invoice_series` (as `GET /api/local-invoices/series`) |
| addInvoice | `local_invoice_store_preview` then `local_invoice_issue` (as `POST /api/local-invoices/orders/:id/previews` then `/previews/:id/issue`), ONE transaction |
| getInvoices | `documents` mode `local_invoice` + `local_invoice_receipts` (as `GET /api/local-invoices/documents`), same evidence check as `documentView` |
| getInvoiceFile | `localInvoicePrintHtml` (as `GET /api/local-invoices/documents/:id/print`) |

local-invoices.ts is source-pinned (`scripts/full-base-scale-http-ports.mjs`) and its
`transaction()` is private, so the port repeats its steps in the same order: module check, identity
hash, identity/access, `fa3DraftOwnerInTx(local_invoice_locks)`, `assertNoFa3DraftProjectInTx`, the SQL
function, `audit`, and the same SQLSTATE → HTTP mapping. Difference: preview and issue share one
transaction, so there is no `SET CONSTRAINTS ALL IMMEDIATE` between them (it would make the
admission → receipt FK immediate); one IMMEDIATE runs after the issue, before COMMIT.

## Numbering
The number always comes from `local_invoice_issue`: next `local_invoice_counters.last_number` of the
series and UTC year, `PREFIX/YYYY/NNNNNN`. Base sends no number and none is accepted (unknown fields
→ 422). A refused or rolled-back call consumes no number (the counter is in the same transaction).

## addInvoice (LOCAL)
- Input `order_id`, `series_id`, optional `vat_rate`. `DEFAULT` and `ITEM` both mean the frozen
  catalog VAT of each order line (native series have no VAT setting). `EXPT`/`ZW`/`NP`/`OO` and a
  numeric rate → 422 `LOCAL_BASE_WIRE_UNSUPPORTED_FIELD`.
- Buyer = the order's consumer: `customer_name` and the delivery address; only `country=PL`
  (native scope: consumer, PL, PLN, ordinary domestic; B2B/NIP is a separate native process).
- Sale date = UTC date of the first native `order.shipped` event; an order that was never shipped
  → 409 (the native rule also requires status shipped/delivered).
- Delivery VAT: the single item rate; free delivery takes the highest item rate (zero amount);
  paid delivery with mixed item rates → 422 `LOCAL_BASE_WIRE_SHIPPING_VAT` (choose it in the app).
- The native preview attestations (`ordinary_domestic`, consumer sale, no special procedure, not
  a fiscal receipt) and the issue confirmation are given by the API call itself, within the
  scope above. **Needs Artur's confirmation** that an API key may attest these.
- Idempotency-Key → `idempotency_keys` (`base_wire220:<uuid>`) in the same transaction; replay
  returns the same `invoice_id`, another body → 409. Without a key a second call → 409 (native: one
  local invoice per order). Response `{invoice_id}`.

## getInvoices (LOCAL)
- Only native local invoices (`mode='local_invoice'`, numbered series). Demo (`DEMO-FV`),
  provider (Fakturownia) and B2B documents keep their 220 identity but are not listed and their file
  is 404: their data shapes are not a numbered native invoice. IDs therefore have gaps.
- Order: `invoice_id` ascending, at most 100; `id_from` inclusive; `date_from` on `created_at`;
  filters `invoice_id`, `order_id`, `series_id` combine with AND.
- `get_government_data=true` → 422 `LOCAL_BASE_WIRE_UNSUPPORTED_FLAG` (never sent to KSeF).
  `get_external_invoices` has no effect (no external files exist).
- Fields: `type` normal, `sub_id` = native sequence, `month` 0 (yearly numbering), `postfix` '',
  `date_sell`/`date_pay_to` = 00:00 UTC of sell/due date, totals from the frozen snapshot,
  `additional_info` = series notes, `seller` = name/street/postcode city/NIP joined by CRLF,
  buyer fields from the snapshot, `invoice_country` '', correction/exchange/external fields empty,
  `payment` '' (no method name natively). Items: unit gross/net = line amount / quantity (4
  decimals), `ean` '' and `order_product_id` 0 (no numeric item identity).
- A page whose JSON exceeds the connector node limit (25000) fails with 413, never truncates.

## getInvoiceFile (LOCAL)
`invoice` = `"data:"` + base64 of the native print HTML (UTF-8), not a PDF. `get_external=true`
returns the same file (Base fallback). `invoice_number` = native number.

## Tests
- `tests/base-wire-invoices.test.ts` (closed ports, in run-bw.sh): mapping, refusals, replay/lost
  ACK, allocation modes, read-only copy, credential hand-off through connector.php.
- `tests/base-wire-invoices.database.test.ts` on a fresh PG04 clone `dynaminds_wireinv_20261023_NN`
  (218+219+220 by the guarded applier): Base addOrder → native ship → addInvoice → next native
  number, replay, native register/detail, natively issued invoice visible with a stable id, file
  bytes equal the native print, second tenant, read-only key and key without `orders:read`.

## getJournalList: not implemented, migration design
Base needs a numeric, per-tenant increasing `log_id` without gaps visible to an incremental reader.
`order_events` has a UUID key and `created_at=now()` (transaction start), so neither is commit
ordered; deriving an ID would lose events committed late. A lossless ID needs a sidecar, i.e. a
migration. Proposed `221_base_wire_journal.sql` (successor to 220, owner-installed, same packaging
as 220: db.ts registration, resource packaging, cold-inspection projector and exact 221→220 inverse):
- Table `base_wire221_journal_ids(tenant_id uuid, source text CHECK(source IN('order_event','document')),
  resource_id uuid, local_id uuid, log_id bigint GENERATED ALWAYS AS IDENTITY, PRIMARY KEY(tenant_id,source,resource_id),
  UNIQUE(log_id), UNIQUE(tenant_id,log_id))`; FK `local_id → order_events(id)` resp. documents
  `ON DELETE SET NULL(local_id)` (tombstone); RLS tenant_scope, SELECT only for dyna_app; immutable
  /no-truncate triggers like `base_wire220_identity_guard`.
- No trigger on `order_events` or `documents` (both may be validator-pinned); a new
  `base_wire221_allocate_journal()` SECURITY DEFINER, per-tenant advisory lock, inserts pending rows
  in `(created_at,id)` order. IDs are assigned under the lock and committed before it is released,
  so a reader never sees a lower `log_id` appear later. getJournalList allocates in a short writing
  transaction, then reads `log_id > last_log_id` (exclusive, LOCAL), ascending, 100 per call, 3 days.
- Log types from native kinds: `order.created` 1, `payment.receipt` 3, `order.merged` 5,
  local invoice document 7 (`object_id` = 220 invoice id), `order.shipped`/`order.parcel.dispatched`
  9 (`object_id` = package id), `order.delivery_address_changed` 11, `order.note_added`/`order.tags_changed`
  16, `order.workflow_changed` and `order.<status>` 18 (`object_id` = 220 status id or 0); other
  kinds not exposed. `order_id` = 220 order id.
- Guards to re-check before/after (all nine of apply-guarded): `ordinary187_valid`,
  `large_import173_valid` and `pim_dictionary_valid` (catalogue-wide trigger/FK fingerprints; the
  new RI triggers attach to `order_events`), `order_merge_delivery209_valid` (reads
  `order_events` of merged orders), `fa3_draft_guards` (documents), plus the other four unchanged.
  220 already showed FK RI triggers on `documents`/`orders` keep them true; `order_events` is new.
