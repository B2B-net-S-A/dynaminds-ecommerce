# Base wire: returns family, 23.10.2026

Seventh family on `POST /connector.php` (`server/base-wire-returns.ts`, native port
`server/base-wire-returns-runtime.ts`). Source: `base-api-return-contracts.v1.json` (Order returns).
Local acceptance only; no Base sandbox/account request was made. Reasons: migration **223** (below).

## Methods
| Method | Native source |
|---|---|
| getOrderReturnStatusList | the fixed `return_cases.state` values (below) |
| addOrderReturn | `requestReturn` (same as `POST /api/orders/:id/returns`) |
| getOrderReturns | `return_cases`, `return_items`, `order_items`, `orders`, `order_events` (same rows as `GET /api/returns`) |
| setOrderReturnStatus | `decideReturn` (same as `POST /api/returns/:id/decision`) for rejected/cancelled |
| setOrderReturnRefund | `recordRefund` (same as `POST /api/returns/:id/refund`) |
| getOrderReturnPaymentsHistory | `payment_entries` of kind `refund` with this `return_id` |
| getOrderReturnReasonsList | `return_reasons223` (same rows as `GET /api/return-reasons`), active only |

Not offered (registry answers 400 `LOCAL_BASE_WIRE_METHOD`):
- `getOrderReturnExtraFields`, `setOrderReturnFields`, `getOrderReturnProductStatuses`, status groups,
  batch statuses and the rest of the 21 contract methods: no native extra fields, groups or
  per-product Base statuses (return destination statuses, `return-destination-statuses-routes.ts`, are
  a per-item custody/acceptance configuration with UUIDs under `returns:configure`, not a header
  status). Out of scope here.

## Identities (LOCAL policy)
- **Return statuses** = the five fixed native states, in the reserved range of
  `BASE-WIRE-ORDERS220-20261023.md` (2147483000–2147483647), never renumbered:
  `requested` 2147483101 Do rozpatrzenia, `refund_pending` 2147483102 Uznane — do rozliczenia,
  `closed` 2147483103 Zamknięte, `rejected` 2147483104 Odrzucone, `cancelled` 2147483105 Anulowane.
  Colour `#3455db`, `group_id` 0, `is_primary` 0, `name_for_customer` = name.
- **return_id**: 220 has no return sidecar and no migration is added. Like `pick_list_id`
  (`BASE-WIRE-FULFILLMENT220-20261023.md`) it is derived from the immutable `return_cases.id`: hex
  digits 1–12 and 14 (the 52 random bits of a v4 UUID; digit 13 is the version) + 1, i.e. 1..2^52.
  Natively created cases (UI, buyer portal, legacy full returns) get the same derived ID, so they are
  visible at once. A collision with another case of the same company fails addOrderReturn (503
  `LOCAL_BASE_WIRE_RETURN_ID`, nothing created); a lookup or page that meets two cases with one
  derived ID fails with 503. A later sidecar must backfill these values instead of renumbering.
  Lookups compute the derivation over the company's cases (no index; acceptable locally).
- `order_id`, product, catalog and warehouse IDs are the 220 identities; return lines have none
  (`order_return_product_id` and `order_product_id` are 0).

## Scopes
No returns read/write scope exists in `apiScopes` (`returns:configure` configures destination
statuses). LOCAL: `orders:read` for getOrderReturnStatusList/getOrderReturns/
getOrderReturnPaymentsHistory, `orders:write` for addOrderReturn/setOrderReturnStatus/
setOrderReturnRefund (same as `GET /api/v1/returns` = `orders:read` and the return-destination
previews = `orders:write`). Every write also needs `orders:read` (`baseWireRequiredScopes`). Writes
need role admin/operator (the native return routes refuse viewers). Read-only copies refuse writes
(423) and never allocate order IDs.

## addOrderReturn (LOCAL choices)
- `order_id` is required (a native case always belongs to an own order); unknown or foreign → 404.
- Native rules decide (409): the order must be released (shipped/delivered/completed/return_*, or
  packed with a parcel return), quantities available, shipping not yet claimed, sale warehouse;
  replacement fulfilments refused.
- Lines → native order items: by `variant_id` (+ parent `product_id`), else simple `product_id`, else
  `sku`, else `ean`; then narrowed by `price_brutto` (unit price of the order line, cents),
  `tax_rate`, `storage_id` (catalog), `sku`. No line → 404; several lines of one product → 422
  (give `price_brutto`); the same order line twice → 422. Line `name`/`weight` are not stored.
- `warehouse_id` (all non-zero values must agree) → native receiving warehouse; omitted → the order
  warehouse (native default). Foreign → 404.
- `admin_comments` → native reason; empty → `Zwrot zgłoszony przez Base API` (the native reason is
  required). `delivery_price` → requested shipping refund (minor units, ≤ 2 decimals).
- Buyer fields (`email`, `phone`, `delivery_fullname/address/postcode/city/country_code`): the native
  case has no buyer data of its own; empty or equal to the order's buyer (email case-insensitive) is
  accepted, anything else 422. `currency` must be the order currency.
- `status_id`: omitted/0 or `requested`; another return status → 422 `LOCAL_BASE_WIRE_RETURN_STATUS`
  (a new native case always starts as requested); unknown → 404. `date_add` accepted, native time wins.
- Refused with 422 `LOCAL_BASE_WIRE_UNSUPPORTED_FIELD` when non-empty: `custom_source_id`,
  `reference_number` (the native number `RMA-…` is generated), `refunded=1`, `user_login`,
  `delivery_company`, `delivery_state`, `extra_field_1/2`, non-empty `custom_extra_fields`,
  `refund_account_number`, `refund_iban`, `refund_swift`; line `order_product_id`, `location`,
  `attributes`, `status_id`.
- Line `return_reason_id` (23.10.2026, 223): the native reason belongs to the case, so all non-zero line
  values must be equal (else 422); 0/omitted = "other" (no choice). The ID must be an own active
  dictionary reason (unknown/foreign 404, inactive 422); it becomes the case's `reason_id` (native
  `requestReturn`). Without 223 a non-zero value is 422 `LOCAL_BASE_WIRE_UNSUPPORTED_FIELD`.
- Kind `return` (complaints are not created through Base). Response `{return_id}`.
- `Idempotency-Key` (UUID) stores `{return_id}` in `idempotency_keys` in the case's transaction: a
  retry after a lost ACK returns the same `return_id` and creates nothing; another body is 409.

## getOrderReturns (LOCAL choices)
- Max 100 per call. Order: (`date_add` second, `return_id`) ascending; with `id_from` alone by
  `return_id`. Bounds inclusive; `date_from` + `id_from` form one keyset tuple, so the next page is
  `date_from` = last `date_add`, `id_from` = last `return_id` + 1 (lossless also for > 100 cases in one
  second). Natively created orders get their 220 ID first (as getOrders); on read-only copies only
  already allocated orders' cases are listed.
- Filters: `order_id`, `return_id`, `status_id` (unknown → none). `filter_order_return_source`:
  every native case is `personal` with source ID 0, so other sources or a non-zero source ID match
  nothing. `include_custom_extra_fields`/`include_connect_data` = true → 422
  `LOCAL_BASE_WIRE_UNSUPPORTED_FLAG`.
- Fields: `reference_number` = native number; `status_id` = state ID; `date_in_status` = last native
  state event of the case (`return.requested/received/rejected/cancelled/refund_recorded`);
  `refunded` = the recorded settlement amount (major units; contract type/meaning ambiguous);
  buyer/address/currency/external_order_id from the order; `delivery_price` = requested shipping,
  after receipt the accepted shipping; `admin_comments` = reason; `fulfillment_status` 0 requested,
  5 refund_pending, 1 closed, 2 rejected/cancelled. Refund account fields are empty and sent under
  both the table names (`order_return_*`) and the example names (`refund_*`). Products: `storage`
  `db`, `storage_id` catalog, `product_id`/`variant_id` as getOrders, `quantity` = requested,
  `price_brutto` = order-line unit price, `tax_rate`, `warehouse_id` = receiving warehouse; empty/0:
  location, auction_id, attributes, weight, bundle_id, status_id, return_reason_id/comment.

## setOrderReturnStatus
- Own case by `return_id` (404 otherwise); unknown status 404. Same status → `{}` (no change).
- `rejected` / `cancelled` from `requested` → native `decideReturn` with note `Status zmieniony przez Base
  API` (event, audit, parcel rules); a decided case → native 409.
- `refund_pending` (acceptance needs per-line accepted/restocked quantities, stock and WMS decisions)
  and `closed` (needs a refund confirmation, see setOrderReturnRefund) and back to `requested` → 409
  `LOCAL_BASE_WIRE_RETURN_TRANSITION`. A bare Base status never implies physical or money effects.
- Optional `Idempotency-Key` as above; response `{}`.

## setOrderReturnRefund (never pays twice)
- The native refund is a recorded confirmation (`method return_confirmation`, no payment-provider
  call), like Base's declaration. Native rules: state `refund_pending` (else 409) and
  `order_refund_done` (≤ 2 decimals) must equal exactly the funds available to give back
  (`min(refund_amount, overpayment)`, shown as `settlement_amount` in the native case; else 422).
- Reference (native, 3–200 characters) = `external_refund_id` and `refund_comment` joined with ` · `;
  both empty/too short → 422. `refund_date` accepted, the native time wins.
- Replay safety: one transaction holds the native order/case locks; a case that already has a
  settlement is never paid again. A replay with the same amount and reference (lost ACK, with or
  without `Idempotency-Key`) answers `{}` without any native call; another amount or reference → 409
  `LOCAL_BASE_WIRE_RETURN_REFUNDED` (Base "replace the amount" semantics are not supported: native
  settlements are final). Concurrent identical calls serialize on the native locks; the second sees
  the settlement (native `recordRefund` replay) and pays nothing.

## getOrderReturnPaymentsHistory
Own case by `return_id`. One entry per native refund payment of the case: `paid_before`/`paid_after`
= refunded sum before/after it, `total_price` = the case refund amount, `currency`,
`external_payment_id` = native reference, `date`. A zero payout records no payment, so the history is
empty. Every native entry has a reference and there are no value edits, so `show_full_history`
changes nothing (LOCAL).

## Availability
Available with the orders family (220 order sidecar + `base_wire220_allocate_pending`); registered in
the single `registerBaseWireRoutes` statement of `app.ts`.

## Tests
- `tests/base-wire-returns.test.ts` (closed ports), `tests/base-wire-crm-application-registration.test.ts`.
- `tests/base-wire-returns.database.test.ts` on a fresh `dynaminds_wireret_20261023_NN` clone: Base
  addOrder → native ship → addOrderReturn → native case and register; replay; cancel through
  setOrderReturnStatus; native receive → setOrderReturnRefund once (key replay, keyless replay,
  other reference 409, one payment entry); paging of 103 native cases; second tenant isolated;
  read-only key refused.

## Return reasons (migration 223, 23.10.2026)
Native: `return_reasons223` (tenant dictionary: UUID + numeric `public_id` = Base `return_reason_id`,
name 3–120 characters unique case-insensitively per company, `active`, `position`, `version`) and
`return_case_reasons223` (the reason chosen at case creation, with its name at that moment; immutable).
Reasons are never deleted (guard trigger): a rename keeps the UUID and public ID, deactivation hides the
reason from new choices only. The case's free text (`return_cases.reason`) stays the native reason; a case
without a choice is "other". Session/API routes `GET/POST /api/return-reasons`, `PATCH /api/return-reasons/:id`
(writes: admin, API scope `returns:configure`), `reason_id` in `POST /api/orders/:id/returns` (not in the
buyer portal or B2B requests: their actor has no user), `reason_choice` in the return detail and register.
UI: order detail → Zwroty i reklamacje → "Powody zwrotu — słownik" (admin) and "Powód z listy" in the
new-case form. Health flag `return_reasons223_available`.
- `getOrderReturnReasonsList` (no parameters, strict `{}`): `return_reasons[]` = `{return_reason_id, name}`
  of active reasons by position, then ID (LOCAL: Base has no inactive state). Without 223 → 503
  `LOCAL_BASE_WIRE_RETURN_REASONS`.
- `getOrderReturns`: every line carries the case's `return_reason_id` (current dictionary ID; 0 = other);
  `return_reason_comment` stays `''` (the free text is `admin_comments`).
