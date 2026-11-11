# Invoices beyond the 157 lifetime limit go to FV-S (230) — 29.10.2026

## Why
- The sealed 157 local invoice has a lifetime budget per company, the same for every plan:
  `local_invoice_budget` (`server/157_local_invoices.sql:137`) refuses the 2001st preview, the 2001st receipt and any
  history over 64 MiB with 23514 "Limit historii faktur". The deferred constraint trigger `local_invoice_complete`
  (`:287–300`) runs it again, so no front door gets around it, and changing the body breaks 10 guards (p274 probes).
- The load test (`docs/scale/LOAD-TEST-FULL-20261029.md` §4.7) left companies at 1 272–1 705 receipts after one hour;
  the full data set plans ~7 400 invoices per company.
- Owner decision (Artur, 29.10.2026, TASKS.md "Czeka na mnie" 06:15, variant 2): invoices beyond the limit go through the
  230 path, numbered `FV-S/<prefix>/<year>/<seq>`. Before this change only the tools (913b6d5, d3dfa1d) used 230; the
  product still answered the user with the 409 "Limit historii faktur".

## When the route switches (decision)
- **At the limit, not before.** The 157 numbering stays continuous for as long as the sealed budget allows; the company
  switches to FV-S once, when the next 157 preview would be refused. The limit is the same for every plan, so there is
  no plan-specific threshold to keep in sync.
- Not chosen: switching early ("near the limit" or for enterprise). It would end the 157 series for no gain; the
  per-write cost of `local_invoice_budget` (full scan, 52 ms at 2000) is a performance matter of the 157 path and stops
  growing once the company is on FV-S. Reversible: `localInvoiceBudgetInTx` is the single place that decides.
- How "at the limit" is known, cheaply:
  - previews ≥ 2000 or receipts ≥ 2000, each counted with `LIMIT 2000` through the `(tenant_id, id)` unique index;
  - the 64 MiB byte limit is not pre-computed (that is the full scan); instead a 157 preview the native function
    refuses with exactly "Limit historii faktur" is answered by 230 in a new transaction (also covers a concurrent
    preview taking the 2000th place). Base `addInvoice` does the same with a savepoint inside its one transaction.

## What the user and an API client get
- **Same request, same route.** The 157 panel and API clients keep sending
  `POST /api/local-invoices/orders/:id/previews` with the 157 body. At the limit the answer is `201` with:
  - `preview` — a 230 preview (`invoice230_previews`) of the same consumer sale: same series, order version, buyer
    name and address (`{kind:'consumer', name, address:{…}}`), delivery VAT and sale date;
  - `invoice230: true`, `series: 'FV-S'`, `overflow: {reason: 'previews'|'receipts'|'history', limit: 2000}`;
  - `series_note` (Polish), e.g. "Limit faktur lokalnych B2C jest wyczerpany (firma ma już 2000 podglądów faktur
    lokalnych; limit obowiązuje dożywotnio w każdym planie). Ta faktura zostanie wystawiona w podserii FV-S: numer
    FV-S/FV/2026/…, a nie FV/2026/…. …";
  - `issue_path` = `/local-invoices/previews/<id>/tax-issue`.
- The issue is unchanged: `…/previews/:id/tax-issue` or the native `/issue` alias already issue a 230 preview in FV-S.
  Their answer now also has `series: 'FV-S'` and `series_note: "Faktura wystawiona w podserii FV-S (numeracja 230): <number>."`
  (preSerialization hook, any 230 issue on these two routes; existing fields unchanged).
- A replay of the same 157 request (same `client_key`) answers the same 230 preview with 200. A key that already has a
  157 preview is always replayed natively, whatever the budget is now.
- Audit: `local_invoice.overflow230` on the 230 preview (order, reason, client key, limit), next to `invoice230.preview`.
- **The routed invoice must be the sale the 157 form confirmed** (PLN consumer in PL, ordinary domestic VAT, no special
  procedure, no fiscal receipt). Otherwise the answer is 409 with the reason and nothing is stored: another currency,
  ZW/NP/OO/OSS lines or MPP, or a printed receipt (those go to the "Faktura VAT: B2B, EUR, ZW/NP/OO/OSS" panel). The
  check runs on the calculation before storing and again on the stored (locked) snapshot.
- **UI** (`web/local-invoices.tsx` + `web/local-invoice-overflow.tsx`): the 157 panel recognises the FV-S answer,
  checks it against the body it sent, shows the note in an orange box above the FV-S calculation (the 230 snapshot view,
  exported from `web/invoice230.tsx`), asks for consent and issues with "Wystaw fakturę FV-S". After the issue it shows
  the number and the issue note, a print link, and points to the FV-S panel for FA(3), KSeF and KOR-S; the order view
  reloads (`onChanged`), so the FV-S panel shows the document.
- **Base `addInvoice`** (`server/base-wire-invoices-runtime.ts`): at the limit (or on the budget refusal, after
  `ROLLBACK TO SAVEPOINT`) the same consumer sale is previewed and issued in FV-S inside the Base transaction. The
  response is `{invoice_id, invoice_number, local_note}` (LOCAL extension; a 157 invoice still answers `{invoice_id}`).
  `getInvoices` and `getInvoiceFile` now also read FV-S invoices of a PLN consumer sale at domestic rates (the content of
  the Base invoice DTO), with the 230 evidence check (document = 230 record); other FV-S invoices stay outside Base as
  before.

## Where it lives (pinned files unchanged)
- `server/invoice-overflow230.ts` (new): budget check, the 157→230 request mapping, the scope check, the preview
  (session/API) and the in-transaction issue (Base), and `registerLocalInvoiceOverflow` — a preHandler of the pinned
  native preview route that answers the request itself, like the `/issue` alias does for its route: under the limit it
  calls the native `previewLocalInvoice()` and the native `project()` shape, at the limit it answers with 230.
- Registered by `registerInvoice230Routes` (`server/invoice230-routes.ts`) when 230 is available, so `server/app.ts`
  is unchanged; Fastify applies a root hook to routes registered before it (checked on Fastify 5.12.5).
- Unchanged and byte-identical: `server/local-invoices.ts`, `server/local-invoice-routes.ts`,
  `server/local-invoice-values.ts`, `server/local-invoice-issue-alias.ts`, `server/tax226-routes.ts`,
  `server/tax226-local-invoices.ts`, `server/app.ts`, `server/db.ts` (all pins of `scripts/full-base-scale-http-ports.mjs`
  still match), every SQL file.

## Readers of `mode='local_invoice'` vs 230 (checked 29.10)
| Reader | FV-S (230) invoice |
|---|---|
| JPK_V7M / JPK_FA (`jpk-source.ts:18` `JPK_MODES`) | included (DB test: row in V7M of the period) |
| KSeF 229/231 (`ksef229.ts`, kind `invoice230`) | included (DB test: fake KSeF accepted) |
| FA(3) XML / batch (`fa3-documents.ts`, `fa3-document-batch.ts`) | included |
| Settlement report (`settlement-report-data.ts:46`) | included (DB test) |
| Print (`/api/documents/:id/print`, `/api/invoice230/documents/:id/print`) | included |
| Corrections | KOR-S 232 (DB test: cancellation issued); 188/206/207/160 answer 409 pointing to KOR-S |
| RODO 228 (`rodo228.ts:238`) | `invoice230_previews` / `invoice230_documents` kept for tax retention |
| Base `getInvoices` / `getInvoiceFile` | **was missing** — added for PLN consumer domestic FV-S |
| 157 register `GET /api/local-invoices/documents` | 157 only (pinned); FV-S are in the FV-S register `GET /api/invoice230/documents` |

## Tests
- `tests/invoice-overflow230.database.test.ts` on a dedicated clone `dynaminds_inv29_20261029_NN` (template
  `dynaminds_restore_36751abef3079f3f` + real `migrate()`): plants the company at exactly 2000 previews (one owner
  transaction as `dyna_app`, `local_invoice_store_preview` with the key's identity frame — the sealed functions,
  triggers and deferred budget checks), then:
  - before: the pinned native route without the overflow answers 409 "Limit historii faktur" (the 23514) and stores nothing;
  - after: the same request → FV-S preview with the note, replay 200, issue by `tax-issue` and by the `/issue` alias,
    157 counter unchanged, FV-S counter +2, a second preview of an invoiced order refused;
  - JPK_V7M row (108,13 / 24,87), settlement report, fake KSeF accepted, KOR-S cancellation, 188 path → KOR-S;
  - Base `addInvoice` → FV-S with `invoice_number`/`local_note`, `getInvoices`/`getInvoiceFile` read it;
  - a ZW order is refused with the reason, nothing stored; the ten guards true before and after.
- `web/local-invoice-overflow.test.mjs`: answer readers (12 refused mutations of the preview, 5 of the document) and
  the review/issued views (note, consent, viewer).

## Evidence (29.10.2026)
- Red (routing disabled, clone `dynaminds_inv29_20261029_01`): 1/5 — "before" passes; the 157 preview answers
  409 "Limit historii faktur" (tests 2, 3, 5) and Base `addInvoice` answers 409 "Zakres faktury zmienił się" (test 4).
- Green (clone `dynaminds_inv29_20261029_02`): 5/5 in 1 150 s; planting 2000 previews took 526 s
  (100 per tenant transaction; each PG04 transaction pays the full app lifecycle).
- Planting note: one raw owner transaction (outside `tenantTx`) fails at COMMIT with "209 complete source
  installation required" — the deferred checks need the app's transaction lifecycle, so the plant goes through `tenantTx`.
- Related unit/UI tests 72/72 (`base-wire-invoices`, `nbp227-issue-hooks` incl. the hash pins,
  `full-base-scale-http-ports` source pins, `local-invoice-issue-alias`, web 230/157 panels); `tsc --noEmit` clean.
- Browser click-through (built-in browser; API on 127.0.0.1:4191 against clone 02, vite on 5191; the proxy presents
  the standard dev origin 5173 because the API accepts writes only from the standard local UI origins, `app.ts:911-920`):
  the planted demo company (2000 previews), "Lokalne faktury B2C" panel, the same 157 form → "Podgląd przed
  wystawieniem — seria FV-S" with the orange note → consent → "Wystaw fakturę FV-S" → FV-S/OVD6B5A5/2026/000004 and
  …/000005; the issued note stays visible after the order reload; the FV-S panel shows the document with print and
  FA(3). The first run showed that the order reload after the issue cleared the panel state; the issued FV-S note is now
  kept per order for the page session (`overflowIssues` in `web/local-invoices.tsx`).
