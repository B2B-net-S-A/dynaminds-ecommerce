# Base wire: orders family (220), 23.10.2026

Third family on `POST /connector.php` (`server/base-wire-orders.ts`, native port
`server/base-wire-orders-runtime.ts`). Sources: `base-api-orders-contracts.v1.json` (addOrder,
getOrders, setOrderFields, setOrdersMerge, addOrderBySplit), `base-api-order-configuration-contracts.v1.json`
(getOrderStatusList, setOrderStatus, setOrderPayment, getOrderPaymentsHistory) and
`base-api-orders-next-contracts-20261018.md` (getOrdersByEmail/Phone, getOrderExtraFields). The second
batch (getOrdersByEmail … setOrdersMerge) is described in its own section at the end.
Local acceptance only; no Base sandbox/account request was made. No new migration: the 220
sidecars `base_wire220_order_ids` and `base_wire220_order_status_ids` are used as they are.

## Identities (migration 220)
- Order statuses = native `workflow_statuses` (insert trigger allocates the numeric ID) **plus the
  fixed native order stages** (below).
- Orders have no insert trigger (the `orders` user triggers are pinned). IDs are allocated by
  `base_wire220_allocate_pending('order')` (current tenant, native creation order):
  - `addOrder` calls it in its own transaction, after the native create, so the returned
    `order_id` is committed together with the order;
  - `getOrders` calls it in a short writing transaction **before** its read snapshot, so every
    natively created order (UI, REST, imports, marketplaces) is returned with a stable numeric ID;
  - on a read-only copy (`readOnly`) nothing is allocated: only already allocated orders are
    returned (LOCAL).
- Order lines have no 220 identity. `order_product_id` (getOrders) is derived from the immutable order
  item UUID like `extra_field_id`: hex digits 1–12 and 14 (52 random bits) + 1 (LOCAL, 23.10.2026, for
  `addOrderBySplit`). Before that it was always `0`.

## Native stage statuses (LOCAL policy, no migration; added 23.10.2026)
A new company has no `workflow_statuses`, but every native order is in one of the fixed stages
(`operation-schema.ts` `stages`). Base accounts always have statuses, so each stage is also a status:

| stage | id | name |
|---|---|---|
| new | 2147483001 | Nowe |
| paid | 2147483002 | Opłacone |
| picking | 2147483003 | W kompletacji |
| packed | 2147483004 | Spakowane |
| shipped | 2147483005 | Nadane |
| delivered | 2147483006 | Dostarczone |
| completed | 2147483007 | Zakończone |
| cancelled | 2147483008 | Anulowane |
| return_initiated | 2147483009 | Zwrot zgłoszony |
| return_received | 2147483010 | Zwrot przyjęty |
| return_completed | 2147483011 | Zwrot zakończony |

- **Reserved range 2147483000–2147483647** (top of int32, so 32-bit Base clients keep working) is
  local policy for fixed native statuses. IDs are never renumbered; new stages are appended. The 220
  workflow-status identity is one global sequence starting at 1 and would need ~2.1 billion statuses to
  reach the range; if a workflow status ID ever lies there, getOrderStatusList, getOrders and
  set/addOrder status lookups fail with 503 `LOCAL_BASE_WIRE_STATUS_ID_RANGE` (fail closed, no
  collision). A later migration must keep these IDs.
- Colour `#3455db` (the native default of a new workflow status); names = native UI stage names
  (`web/api.ts statusNames`); `group_id` 0, `is_primary` 0, `name_for_customer` = name.

## Scopes
`orders:read` for getOrderStatusList/getOrders/getOrdersByEmail/getOrdersByPhone/getOrderPaymentsHistory,
`orders:write` for addOrder/setOrderStatus/setOrderPayment/setOrdersMerge; `order-fields:read` for
getOrderExtraFields and `order-fields:write` for setOrderFields (the native gates of
`GET /api/order-fields` and `PATCH /api/orders/:id/fields`). Every write also needs its `:read`
(`baseWireRequiredScopes`). Writes need role admin/operator (same as `POST /api/orders` and order
operations); the native merge additionally requires admin and the key's `inventory:read/write`
(`order_merge_key_grant`). The family has native credential custody (the merge re-verifies the key).

## Method → native mapping
| Method | Native source |
|---|---|
| getOrderStatusList | `workflow_statuses` (same rows as `GET /api/workflow-statuses`), active and inactive, then the 11 fixed stage statuses |
| addOrder | `createOrder` (same as `POST /api/orders`, field source `api`, no order-field writes) with `manual_lines` for Base prices; `recordPayment` for `paid`; `applyOrderAction(set_workflow)` for `order_status_id` |
| getOrders | `orders`, `order_items`, `order_pick_items`, `order_events`, `shipments`, `paymentBalance` (merge-aware), same merge-source predicate as `GET /api/orders` |
| setOrderStatus | workflow status: `applyOrderAction(set_workflow)`; stage status: `applyOrderAction(set_status)` (both as `POST /api/orders/:id/operations`): native stage transition, event and audit |

## addOrder (LOCAL choices)
- Native source `manual`; `custom_source_id` must be omitted/0. N28 observation (UI shows "Ręczne" /
  "Dodane ręcznie"): **not changed, by decision**. The native order `source` set (`orderSchema` in
  `server/domain.ts`) has no `api` value — `api` exists only as the order-field write source and in
  preview/receipt tables, not on `orders`. Native rules key on `source IN ('manual','demo')`: the parcel
  release of a commercial plan (`137_order_parcel_releases.sql`, re-pinned in
  `204_partial_commercial_sale_scope.sql`) would refuse an `api` order, and Base getOrders maps
  manual/demo to `personal` (Base itself files addOrder orders under the personal source). A distinct
  "API / Base" label needs a reviewed native origin column or source value (migration + rule review). `date_add` is accepted but the native
  creation time is authoritative (reads return it).
- Buyer: `delivery_fullname` → customer name (required natively, 2–200 characters), `email`, `phone`, `delivery_address/postcode/city/
  country_code` → native address, `delivery_point_id` → locker code, `admin_comments` → note,
  `payment_method_cod` → payment mode `cod`, `delivery_price` → shipping cost, `currency`.
- Refused with 422 `LOCAL_BASE_WIRE_UNSUPPORTED_FIELD` when non-empty (no native column; never
  silently dropped): `payment_method`, `user_comments`, `user_login`, `delivery_method`,
  `delivery_company`, `delivery_state`, `delivery_point_name/address/postcode/city`, all `invoice_*`,
  `want_invoice`, `extra_field_1/2`, non-empty `custom_extra_fields`, line `location`/`attributes`.
- Lines: `storage` `db` only. Product by numeric `product_id` (220); a variant by `variant_id` whose
  parent must be `product_id`; else by exact `sku`, else by `ean` (must be unique). Unknown or foreign
  product → 404: a native line always references a catalog product, no free-text lines. `sku`/`ean`
  (with an ID) and `tax_rate` must match the product (422); `storage_id` 0 or the product's catalog
  (`inventory_id`). Line `name`/`weight` are not stored; the native catalog snapshot is used.
- `price_brutto` is required (LOCAL; an omitted price would create a free line); (≤ 2 decimals) × `quantity` = native line total; each Base line stays a distinct
  native commercial line. Max 100 lines.
- Warehouse: `warehouse_id` = `internal_warehouse_id` of getInventoryWarehouses; all non-zero values
  must agree. Omitted/0 is accepted only when the company has exactly one warehouse (no per-source
  default warehouse exists natively); otherwise 422.
- Reservations, stock checks, catalog/warehouse assignment and pricing currency follow `createOrder`.
- `paid=1` (`true`, `1`, `"1"`): one `receipt` for the whole amount due (`recordPayment`, reference
  `Base API addOrder paid=1`) in the same transaction; the native rule then promotes `new` → `paid`.
  Amount due 0 → no entry.
- `order_status_id` is applied after the payment as a native `set_workflow` (workflow status) or
  `set_status` (stage status); an impossible stage transition (e.g. paid order into a `new`-stage
  status) fails the whole call (409).
- The allocation lock (`base_wire220_allocate_pending`) is held to COMMIT, so concurrent addOrder
  calls of one company serialize at that point.
- `Idempotency-Key` (UUID) stores `{order_id}` in `idempotency_keys` in the same transaction: a retry
  after a lost ACK returns the same `order_id` with no second order/payment/reservation; another body
  under the key is 409. Without the header there is no replay protection (Base documents none).

## getOrders (LOCAL choices)
- Max 100 per call. Order: (`date_confirmed` second, `order_id`) ascending; with `id_from` alone
  (no `date_confirmed_from`) by `order_id` ascending, so `id_from` = last `order_id` + 1 also pages
  losslessly (lazily allocated IDs are not monotonic in creation time).
- Native orders have no unconfirmed state: `confirmed` true, `date_confirmed` = `date_add` = creation
  second; `get_unconfirmed_orders` has no effect.
- Bounds are inclusive: `date_confirmed_from`, `date_from` on the creation second, `id_from` on
  `order_id`. **When `date_confirmed_from` and `id_from` are both given they form one keyset tuple**
  `(date_confirmed, order_id) >= (date_confirmed_from, id_from)`. Lossless paging (also for > 100
  orders in one second, which Base does not document): next call `date_confirmed_from` =
  last `date_confirmed`, `id_from` = last `order_id` + 1, until a page has < 100. Base's "+1 s"
  recommendation still works when no second holds ≥ 100 orders.
- `status_id` filters the workflow status; a stage status ID matches orders in that stage **without**
  a workflow status (exactly the orders whose `order_status_id` is that stage); `filter_email` exact, case-insensitive;
  `filter_order_source` `personal` = native manual/demo, other values = native source code;
  `filter_external_order_id` exact. `shop_order_id` and `order_source_id` are always 0, so a non-zero
  `filter_shop_order_id`/`filter_order_source_id` matches nothing. Contract constraints
  (`filter_order_source_id` needs `filter_order_source`; external + shop order filter) are 422.
- `include_custom_extra_fields`, `include_commissions`, `include_connect_data`,
  `include_discounts_data` set to `true` → 422 `LOCAL_BASE_WIRE_UNSUPPORTED_FLAG`.
- Fields: `order_status_id` = workflow status ID, else the stage status ID of the native stage (never 0); `date_in_status` = last
  status/workflow event; `payment_done` = net paid (`paymentBalance`); `payment_method_cod` "1"/"0";
  `delivery_package_module/nr` = shipment carrier/tracking; `pick_state` = all pick items scanned;
  `pack_state` = native status packed or later; `admin_comments` = native note; products: `storage`
  `db`, `storage_id` = catalog ID, `product_id`/`variant_id` (parent/variant for variants, `"0"`
  otherwise), `price_brutto` = native line total / quantity rounded to the cent (imported lines may not divide evenly), `tax_rate` = native VAT, `warehouse_id` = order
  warehouse. Address comes from the order source data (the buyer-address delivery override is not
  applied). Without native source: `''`/`0` for user_login, payment_method, user_comments,
  delivery_method(_id), delivery_company/state/country, pick-up point name/address, all invoice
  fields (`want_invoice` "0"), extra fields, order_page, star, crm_client_id, location, attributes,
  weight, bundle_id, transaction IDs, auction_id.
- Known limit (not verified against Base): a native transaction that commits after a reader has
  passed its creation second (creation time = transaction start) can be missed by date paging.

## setOrderStatus
`order_id` and `status_id` must be own (404 otherwise; unknown IDs in the reserved range too).
Workflow status: inactive 422, impossible stage transition 409 (native rules). Stage status: native
`set_status`, i.e. the same transition rules (409 with the native message, e.g. paid → shipped; shipped
only via shipping, `new` never), cancellation via the native cancel path, and the workflow status is
cleared. Same stage without a workflow status: no change, `{}`. Same stage while a workflow status is
set: 409 `LOCAL_BASE_WIRE_STAGE_STATUS` (no native operation drops a workflow status without a stage
change). Optional `Idempotency-Key` as for addOrder; response `{}`.
Journal (221) log type 18 still covers workflow changes only; native stage changes are not logged as
type 18 (unchanged).

## Second batch (23.10.2026): lookups, extra fields, payments, merge
No new migration. Natively created orders get their numeric ID by the same lazy allocation as getOrders.

| Method | Native source |
|---|---|
| getOrdersByEmail | `orders` (same query and merge-source predicate as getOrders), `lower(email)` exact |
| getOrdersByPhone | same, `orders.address->>'phone'` exact |
| getOrderExtraFields | `listOrderFieldsInTx` = `GET /api/order-fields` (definitions, role filter, order) |
| setOrderFields | `patchOrderFieldsInTx` = `PATCH /api/orders/:id/fields` (source `api`, order version CAS, history, audit) |
| setOrderPayment | `paymentBalance` (merge-aware net) + `recordPayment` (`POST /api/orders/:id/payments`, receipt) |
| getOrderPaymentsHistory | `payment_entries` of the same ledger sources as `GET /api/orders/:id/payments` |
| setOrdersMerge | `createOrderMergePreview` + `executeOrderMerge` (`POST /api/order-merges/previews`, `/execute`) |

`order-fields.ts` gained the in-transaction variants `listOrderFieldsInTx`/`patchOrderFieldsInTx`;
the HTTP functions now wrap them unchanged.

### getOrdersByEmail / getOrdersByPhone (LOCAL)
- Input `email`/`phone` required (1–50 characters, trimmed). E-mail exact, case-insensitive; phone exact
  as stored natively (no normalisation of prefixes/spaces: `+48 600…` ≠ `48600…`).
- At most 100, **newest first** (creation second, then order_id descending); Base documents no limit/order.
- Output `order_id`, `order_status_id` (workflow status, else the stage status, as getOrders),
  `date_in_status`, `date_add`; by phone also `delivery_fullname` (native customer name) and
  `delivery_company` `''` (no native column). Merged source orders are hidden (as getOrders).

### getOrderExtraFields (LOCAL)
- Enabled definitions readable by the member (`read_role`), native display order. `extra_field_id` is
  derived from the definition UUID (hex digits 1–12 and 14 + 1, i.e. 1..2^52, like `pick_list_id`); two
  definitions of one company with the same derived ID fail closed with 503 `LOCAL_BASE_WIRE_EXTRA_FIELD_ID`.
- `editor_type`: text, number, select, radio, date, file as named; native `multi_select` → `checkbox`.
  `options` (enabled option labels, native order) only for select/radio/checkbox. A list of objects
  (the Base example), not an object keyed by ID.
- Writing transaction like `GET /api/order-fields` (`order_field_role` pins the membership row).

### setOrderFields (LOCAL)
- Only `custom_extra_fields` has a native write. The native order header (buyer, address, delivery,
  payment mode, currency, note, pick/pack state, star) has **no edit operation after creation**, so any
  other given field is refused with 422 `LOCAL_BASE_WIRE_UNSUPPORTED_FIELD` — even an empty value,
  because Base treats a given field as an edit. Nothing is written then.
- `custom_extra_fields`: object keyed by `extra_field_id` (or an empty `[]`), at most 20 (native limit).
  `''` clears the value. text/date: string (native validation, date `YYYY-MM-DD`); number: number or
  decimal string; select/radio: the exact label of an enabled option; checkbox: list of such labels.
  A Base file value (`{title,file}`) is refused (422 `LOCAL_BASE_WIRE_UNSUPPORTED_FIELD`): the native
  file is a separate stored-file upload command. Unknown/foreign field or order → 404; native role,
  definition-enabled and value rules apply (403/409/422).
- One native patch at the order's current version (locked), source `api`; unchanged values are not
  rewritten (native). Response `{}`. Optional `Idempotency-Key` as for addOrder.

### setOrderPayment (LOCAL)
- **`payment_done` is the new TOTAL paid** (Base contract), not an increment. In one transaction the
  payment owner order is locked (as `recordPayment` does), the merge-aware net paid (`paymentBalance`
  received − refunded) is read and `delta = payment_done − net`:
  - `delta > 0`: exactly one confirmed `receipt` of `delta` (`recordPayment`, method `other`), then the
    native paid promotion (`new` → `paid` when nothing is due);
  - `delta = 0`: no entry (a retry of the same total records nothing, with or without Idempotency-Key);
  - `delta < 0`: 422 `LOCAL_BASE_WIRE_PAYMENT_DECREASE` (native corrections reverse one specific entry
    and require an admin; no mapping of "lower the total").
- Amount ≤ 2 decimals (422 `LOCAL_BASE_WIRE_AMOUNT`), order currency, overpayment allowed (native).
- `payment_comment` → entry note; `external_payment_id` → reference `Base API setOrderPayment <id>`
  (without it `Base API setOrderPayment`). `payment_date` is accepted but the native entry time is
  authoritative (no column), like `date_add` of addOrder. With `delta = 0` comment/external ID are not
  stored (no entry). Response `{}`. `Idempotency-Key` stores `{}` in the same transaction.

### getOrderPaymentsHistory (LOCAL)
- Native ledger of the order (merge-aware sources as the order card), oldest first, unpaged. Only entries
  that change the amount paid (receipt, courier collection, refund and their reversals); courier
  remittances are omitted. `paid_before`/`paid_after` = running net paid; `total_price` = current native
  order total; `currency` = order currency; `date` = entry time; `comment` = entry note (a reversal's reason).
- `external_payment_id` exists only for entries written by setOrderPayment with an ID; default
  (`show_full_history` false/omitted) returns only those, `true` returns all. Numbers are JSON numbers
  (documented types), not the strings of the Base example.

### setOrdersMerge (LOCAL)
- `main_order_id`, `order_ids_to_merge` (1–99 own orders, unique, without the main), `merge_mode`
  `technical_merge`|`into_main_order`, `sum_delivery_costs` (bool/0/1) map 1:1 to the native preview.
- Two native transactions as in the UI: preview, then execute with its `scope_hash`. Native rules decide
  (admin, key `inventory:*` grant, same currency/warehouse/payment mode, pre-fulfilment status, no
  shipments/documents/provider attempts → 409 with the native message). Base keeps the main order's
  shipping/invoice data, so a receiver conflict is confirmed as the main order's receiver
  (`confirmed_receiver_selection`).
- `merged_order_id`: the main order (`into_main_order`) or the new native `order_merge` order
  (`technical_merge`), whose numeric ID is allocated right after the execution. Merged sources are then
  hidden by getOrders/getOrdersByEmail/Phone (native operational predicate).
- `Idempotency-Key`: the native preview and execute client keys are derived from it (SHA-256 of API key,
  Idempotency-Key and step, UUID v4 layout); each native step commits with its key, so a retry after a
  lost ACK replays both natively and returns the same `merged_order_id`; another body under the key is
  409 (native request hash). After a refused merge a new key is needed (the stored preview is reused).
  Without the header every call is a new native preview.
- Unavailable (503) when the copy has no complete merge module.

### addOrderBySplit (native 222 split, added 23.10.2026)
- Maps to the native split of migration 222 (`createOrderSplit222Preview` + `executeOrderSplit222`), each
  its own native transaction under the API key's credential custody (the presented key's hash is
  re-checked by `buyer_address_identity`, scopes by `order_merge_key_grant` inside the split transaction).
  Requires `orders:write` (+ `orders:read`) at the registry and natively also `inventory:read` +
  `inventory:write`; a key without them is 403 with no effect.
- `items_to_split[].order_product_id` is the derived getOrders line ID (above); it is matched against the
  order's current lines and the lines it already moved away, so an exact replay maps the same items.
  Unknown line 404; two lines of one order with the same derived ID 503.
- `delivery_cost_to_split` is read as gross (the native `shipping_cost` is gross; LOCAL), at most the
  current delivery cost, moved from the parent to the child.
- Response `new_order_id`: the child's 220 numeric ID, allocated right after the execution.
- `Idempotency-Key`: preview and execute client keys derived from it like `setOrdersMerge` (`stepKey`), so a
  retry after a lost ACK replays both natively and returns the same `new_order_id`; without the header
  every call is a new split.
- Unavailable (503) when the copy has no 222 schema. Every native refusal (payments, documents, parcel
  plan, scans, merge history, returns, external intents, WMS lots, empty parent, …) is passed through;
  mapping and refusals: `ORDER-SPLIT222-20261023.md`.

### Verification
`tests/base-wire-orders.test.ts` (closed ports) and `tests/base-wire-orders-next.database.test.ts` (real
clone `dynaminds_wireord2_20261023_NN`, 218–221): lookups vs native SQL, total semantics (one delta, retry
records nothing, Idempotency-Key replay), setOrderFields changes only order-field values (header and other
columns unchanged, version + 1), technical merge creates the native merged order with a 220 ID and replays
once, foreign tenant 404/empty, read-only key 403. addOrderBySplit: `tests/order-split222.database.test.ts`
(real clone `dynaminds_split_20261023_NN`, 218–222); without 222 the method answers 503 (orders-next test).
