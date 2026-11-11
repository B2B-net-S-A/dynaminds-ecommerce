# Base wire: fulfillment family (220), 23.10.2026

Fourth family on `POST /connector.php` (`server/base-wire-fulfillment.ts`, native port
`server/base-wire-fulfillment-runtime.ts`). Sources: `base-api-orders-next-contracts-20261018.md`
(getOrderSources, addOrderPickList; HTML snapshot `base-api-orders-next-sources-20261018.json.gz`) and
`base-api-courier-contracts.v1.json` (createPackage, getLabel, getOrderPackages, getPackageDetails,
getCourierPackagesStatusHistory, getCouriersList). Local acceptance only; no Base
sandbox/account or courier request was made. No new migration.

## Identities
- Orders: `base_wire220_order_ids` (numeric `order_id` from addOrder/getOrders); unknown or foreign → 404.
- Packages = native `shipments`; the 220 AFTER INSERT trigger allocates `base_wire220_package_ids`
  in the same transaction as the shipment, so `package_id` is committed with it.
- **Pick lists have no 220 sidecar (LOCAL, no migration).** `pick_list_id` is derived from the
  immutable native wave UUID: hex digits 1–12 and 14 (the 52 random bits of a v4 UUID; digit 13 is
  the version) + 1, i.e. 1..2^52. A collision with another wave of the same company fails the call
  (503 `LOCAL_BASE_WIRE_PICK_LIST_ID`, nothing created). A later sidecar must backfill these values
  instead of renumbering. Lookup by `pick_list_id` (getOrderPickLists) is not implemented.

## Scopes
No shipping scope exists in `apiScopes`. LOCAL: `orders:read` for getOrderSources/getLabel and the four
courier reads (getOrderPackages, getPackageDetails, getCourierPackagesStatusHistory, getCouriersList),
`orders:write` for addOrderPickList/createPackage; every write also needs `orders:read`
(`baseWireRequiredScopes`). Writes need role admin/operator (native shipping routes).

## Method → native mapping
| Method | Native source |
|---|---|
| getOrderSources | `channels` (as `GET /api/integrations`) with an order-source provider, `b2b_accounts` |
| addOrderPickList | `previewWave` + `createWave` (same as `POST /api/picking-waves/preview` then `POST /api/picking-waves`) |
| createPackage | `shipDemo` (same as `POST /api/orders/:id/ship-demo`) for the local courier `demo` |
| getLabel | demo: the page of `GET /api/shipments/:id/label` (`demoShipmentLabelInTx`, extracted from that route); DPD: `cachedDpdLabel` |
| getOrderPackages | `shipments` of the order (the shipments of the order card, `order-detail-rows.ts`) + `base_wire220_package_ids` |
| getPackageDetails | `shipments` + the InPost/DPD `shipping_plans` row that created it (`shipment_id`) + the `base_wire.package.created` audit of createPackage |
| getCourierPackagesStatusHistory | stored `shipments.tracking_data.tracking_details` (written by `readShipmentTracking`); no provider request |
| getCouriersList | the local simulator + `channels` with provider `inpost`/`dpd` (as `GET /api/shipping/channels`) |

## getOrderSources (LOCAL)
`{personal:{"0":"Osobiście / telefonicznie"}}` plus one group per native order-source provider with
a channel (`allegro, woocommerce, prestashop, shopify, odoo, ebay, amazon, mirakl`), and `b2b` when the
company has a B2B account. Group codes are the `order_source` values getOrders returns (not Base's
`shop` grouping). Every group has the single key `"0"` because getOrders returns `order_source_id`
0; the value is the channel name, several channels joined with ", ". `source_missing`: key/value
types and the marketplace enum.

## addOrderPickList (LOCAL)
- `order_ids`: 1–100 distinct positive integers (duplicates 422; not described by Base). All-or-nothing:
  any unknown/foreign order → 404, no wave.
- Native rules decide (409): one warehouse, status paid/picking or COD new, active reservations with
  locations, nothing left to pick refused, order not in another open wave, no active packing session.
- Native effects: wave named `Lista Base API` (Base sends no name); orders move to `picking`
  (the native wave rule). Nothing is printed, picked or packed.
- `Idempotency-Key` stores `{pick_list_id}` in `idempotency_keys` in the wave's transaction.

## createPackage (LOCAL)
- `courier_code` `demo` = native local simulator (`Symulator lokalny`, shipment mode `demo`): synchronous,
  one shipment per whole order, the native rules apply (order must be `packed`, stock consumed,
  order `shipped`, WZ, a second shipment of the order 409).
- `inpost`/`dpd`: the native flow is a quoted/queued plan finished by a worker, so there is no package to
  return. Refused with 422 `LOCAL_BASE_WIRE_COURIER_ASYNC` before any effect (nothing queued, no courier
  confirmation claimed). Other codes → 404.
- `account_id` omitted/0 only (no demo accounts) else 404; non-empty `fields` → 422
  `LOCAL_BASE_WIRE_UNSUPPORTED_FIELD`; exactly one package (more → 422).
- Package: `weight` (kg, required > 0 per the Base contract), `size_length/size_width/size_height` (cm),
  numbers or numeric text (COURIER-DOC-008); other keys 422. No native column exists: the validated
  package is recorded in the audit event `base_wire.package.created` of the shipment.
- Response: `package_id` (220), `package_number` = native tracking number, `courier_inner_number` `''`,
  `packages` with the same single entry. `Idempotency-Key` as above (same transaction as shipDemo).

## getLabel (LOCAL)
- `courier_code` required (`source_missing`: requiredness not marked); at least one of `package_id`,
  `package_number`. With both they must name one shipment (else 404); a tracking number shared by
  several own shipments of the courier → 409. Courier of a shipment: mode `demo` → `demo`, carrier
  `DPD Polska` → `dpd`, `InPost ShipX` → `inpost`; mismatch → 404.
- demo → `extension` `html`, `label` = base64 of the exact native label page bytes (UTF-8), in a writing
  transaction like the native route (effective delivery address).
- DPD → `pdf`, the stored label PDF (`cachedDpdLabel`), never a provider request.
- InPost → 422 `LOCAL_BASE_WIRE_LABEL_PROVIDER`: the native route fetches it from the provider;
  connector.php does not make that request.

## Courier reads (LOCAL, all in the read transaction `tenantReadTx`)
Common: strict input; any other key 422 (ZodError → `LOCAL_BASE_WIRE_UNSUPPORTED_FIELD` path of the
registry). Lookups are the current company only; an unknown or foreign `order_id`/`package_id` → 404.
Courier code of a shipment as in getLabel: mode `demo` → `demo` (this includes a simulated InPost
shipment, carrier `InPost ShipX` mode `demo`), `DPD Polska` → `dpd`, `InPost ShipX` → `inpost`.
Merge-source orders: the getOrders operational predicate is applied (`order_merge_claims`, when the
startup capability `orderMergeClaimsAvailable` is set; passed to the family as `mergeClaims`): a merged
source order is 404 in getOrderPackages and its shipments are not resolved by `package_id` (natively a
merged source has no shipments: merge refuses `existing_shipments`).

### getOrderPackages
`order_id` (positive int). `packages`: every native shipment of the order (an order-parcel plan may give
several), ordered by `package_id`; an own order without shipments → `[]`.
| Field | Native source / LOCAL value |
|---|---|
| package_id | `base_wire220_package_ids.public_id` |
| courier_package_nr | `shipments.tracking_number` |
| courier_inner_number | `shipments.external_id` when it differs from the tracking number (InPost ShipX shipment id); else `''` (demo; DPD where it is the waybill) |
| courier_code | courier code above; `''` for an unmapped carrier |
| courier_other_name | `''`; for an unmapped carrier the native carrier name (first 20 characters) |
| account_id | `0`: courier accounts (channels) have no Base numeric identity; createPackage accepts 0 only |
| tracking_status | `shipments.status` through the status table below |
| tracking_status_date | Unix seconds of `tracking_data.provider_updated_at`, else `tracking_at`, else `created_at` |
| tracking_delivery_days | `0`: no native count (weekend/holiday/day-boundary rules undocumented) |
| package_type / is_return | `0` / `false`: native shipments are outbound dispatches; returns are return cases |
| tracking_url | `''`: no native tracking URL |
The status table may give 12 (exception) here although this page documents 0..11 (COURIER-DOC-004);
the value is kept, not dropped.

### getPackageDetails
`package_id` (positive int). `package_details`: one entry (one native shipment is one parcel);
`additional_fields`: `[]` (no courier-specific fields locally; PHP-style empty array).
- InPost/DPD shipment: values of the `shipping_plans.input` that created it (latest plan with this
  `shipment_id`). `weight` kg; DPD `dimensions` in cm; InPost courier service `dimensions` stored in mm,
  returned in cm (÷10); InPost locker service: `size_template` = native template (`small/medium/large`),
  no dimensions, `is_custom` false; `service` = native InPost service (DPD `''`); `insurance_value` =
  `input.insurance`/100, `insurance_currency` `PLN` (the native request currency); `cost_value` =
  InPost `selected_offer.rate`/100 with its currency, DPD rate is null natively → `0`/`''`.
- Demo shipment from createPackage: the validated parcel of the `base_wire.package.created` audit
  written in the shipment's own transaction (`audit_events.created_at = shipments.created_at`, i.e. the
  same `now()`); `weight` kg, `size_*` cm, `is_custom` when a size was given.
- Demo shipment from the panel/order-parcel plan: no native parcel data → `weight` 0, units `''`.
- Always: `cod_value` = `shipments.cod_expected`/100, `cod_currency` = order currency.
- LOCAL `''`/0: `type` (no native dox/pallet), `pickup_date` (DPD pickup runs are not per shipment),
  `additional_services` `[]`, `courier_packaging_type`; `weight_unit`/`size_unit` `''` when unknown.

### getCourierPackagesStatusHistory
`package_ids`: 1–100 distinct positive ints (duplicates/101 → 422). All-or-nothing: any unknown or
foreign id → 404. `packages_history`: object keyed by `package_id`; events = the stored
`tracking_data.tracking_details` (InPost/simulation `{status,datetime}`, DPD `{code,datetime,status}`),
oldest first (stable for equal dates); `tracking_status_date` = Unix seconds of `datetime`,
`courier_status_code` = DPD business code, else the native status (≤100 chars), `tracking_status`
through the table. A shipment never tracked (demo) → `[]`; nothing is synthesized. No tracking read
is started (no `tracking_revision` change, no provider request). An unparseable stored date → 503.

### Tracking status table (native → Base)
| Base | Native statuses |
|---|---|
| 1 label_created | created, label_ready, offers_prepared, offer_selected, confirmed |
| 2 shipped | dispatched_by_sender, dispatched_by_sender_to_pok, collected_from_sender, taken_by_courier, taken_by_courier_from_pok |
| 3 not_delivered | delivery_failed, undelivered, rejected_by_receiver, undelivered_wrong_address, undelivered_incomplete_address, undelivered_unknown_receiver, pickup_time_expired |
| 4 out_for_delivery | out_for_delivery, out_for_delivery_to_address |
| 5 delivered | delivered |
| 6 return | returned_to_sender, return_in_transit |
| 7 aviso | avizo |
| 8 waiting_at_point | ready_to_pickup, ready_to_pickup_from_pok, ready_to_pickup_from_branch, pickup_reminder_sent |
| 9 lost | lost |
| 10 canceled | canceled |
| 11 on_the_way | adopted_at_source_branch, sent_from_source_branch, adopted_at_sorting_center, sent_from_sorting_center, adopted_at_target_branch, in_transit, redirected (DPD number change) |
| 12 exception | claimed |
| 13 transferred_abroad | none (no native status) |
| 0 unknown | anything else, including DPD notification events (native status null) and `unknown` |
Sources: shipment creation (`created` demo, `label_ready` DPD, InPost buy status), the local tracking
example (`confirmed/out_for_delivery/delivered/returned_to_sender`), `dpdStatus()` and InPost ShipX
statuses stored verbatim.

### getCouriersList
No input (`{}`; any key 422). `couriers`: `demo` (`Symulator lokalny`) always — the only courier
createPackage creates synchronously; `dpd` (`DPD Polska`) and `inpost` (`InPost ShipX`) only when the
company has at least one native channel of that provider (any status/mode, as the shipping channel
picker lists them). Order: demo, then dpd, inpost. Names are the native carrier names.

## Availability
Family available with the orders family and `base_wire220_package_ids`; `addOrderPickList` additionally
needs the native picking-wave tables (`admit`, 503). Read-only copies refuse both writes (423).
