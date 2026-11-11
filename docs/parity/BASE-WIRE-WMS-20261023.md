# Base wire: WMS family, 23.10.2026

Eighth family on `POST /connector.php` (`server/base-wire-wms.ts`, native port
`server/base-wire-wms-runtime.ts`), registered in `server/app.ts` with the 220 inventory capability
(`baseWireInventoryAvailable`: warehouse/product/catalog identities). Sources:
`base-api-document-contracts.v1.json` (Product catalog / Documents), `base-api-purchase-order-contracts.v1.json`,
`base-api-inventory-other-configuration-contracts-20261018.md` (Suppliers), `base-api-stocktake-contracts.v1.json`.
Local acceptance only; no Base sandbox/account request was made. **No new migration.**

## Methods
| Method | Native source | Scope |
|---|---|---|
| getInventoryDocuments | `warehouse_documents` (+ lines, `purchase_receipts`) — same rows as `GET /api/warehouse-documents` | inventory:read |
| getInventoryDocumentItems | `warehouse_document_lines` (as `warehouseDetail`) | inventory:read |
| addInventoryDocument | `createWarehouseDocument` (`POST /api/warehouse-documents`), empty line list | inventory:write |
| addInventoryDocumentItems | `editWarehouseDocument` (`PATCH /api/warehouse-documents/:id`), existing + new lines | inventory:write |
| setInventoryDocumentStatusConfirmed | `postWarehouseDocument` (`POST /api/warehouse-documents/:id/post`) | inventory:write |
| getInventoryPurchaseOrders | `purchase_orders` + lines/receipts (as `GET /api/purchase-orders`) | purchasing:read |
| getInventoryPurchaseOrderItems | `purchase_order_lines` (+ `purchase_receipt_lines` locations) | purchasing:read |
| addInventoryPurchaseOrder | `purchaseSave` (`POST /api/purchase-orders`), empty line list | purchasing:write |
| addInventoryPurchaseOrderItems | `purchaseSave` with id (`PATCH /api/purchase-orders/:id`) | purchasing:write |
| setInventoryPurchaseOrderStatus | `purchaseAction` place/close/cancel, `purchaseReceipt` (`/receive`) | purchasing:write |
| getInventorySuppliers | `suppliers` (as `GET /api/suppliers`) | purchasing:read |
| addInventorySupplier | `supplierSave` (`POST`/`PATCH /api/suppliers`) | purchasing:write |
| getInventoryStocktakes | `stocktakes` + `stocktake_lines` aggregates | inventory:read |
| getInventoryStocktakeItems | `stocktake_lines` | inventory:read |

Scopes are those of the native REST operations in `developer-api.ts`; every write also needs the
read scope (`baseWireRequiredScopes`). Writes need role **admin** (native routes `admin()`); reads any
member. Native gates stay in force: posting a document needs a key with inventory:read+write
(`wms_key_grant`), a purchase receipt additionally purchasing:read+write (cost operation). Tenants with
the WMS lot policy refuse legacy quantity writes (409, native). Read-only copies refuse writes (423).

## Not offered (registry answers 400 `LOCAL_BASE_WIRE_METHOD`)
- `getInventoryDocumentSeries`, `getInventoryPurchaseOrderSeries`, `getInventoryStocktakeSeries`: the
  native documents/POs/stocktakes have no series dictionary (`document_series_id`/`series_id` are 0).
- `addInventoryDocumentFile`, `getInventoryDocumentFile`, `addInventoryPurchaseOrderFile`,
  `getInventoryPurchaseOrderFile`: no native file storage for these documents.
- `getInventoryPurchaseOrderLogs`: no per-PO log contract mapping (audit events are not a Base log).
- `deleteInventorySupplier`: native suppliers are deactivated, never deleted (POs keep them).
- `getInventoryPayers`/`addInventoryPayer`/`deleteInventoryPayer`, manufacturers: no native payer/manufacturer.
- `addInventoryStocktake`, `addInventoryStocktakeItems`, `setInventoryStocktakeStatus`: the native
  stocktake starts in counting (no draft), its lines come from stock locations by one prefix (no manual,
  zone or random scope), counting needs per-line versions/stock basis and posting a review hash — no
  exact mapping. Stocktakes are read-only here.
- Transfers (`getInventoryTransfers…`, transfer contracts): natively a transfer is an MM document
  kind, not an entity; MM is reachable as `document_type` 4.

## Identities (LOCAL policy)
- Warehouse, product (simple or variant) and catalog (`inventory_id`) IDs are the 220 identities.
- `document_id`, purchase `order_id`/`id`, `supplier_id`, `stocktake_id` and stocktake `item_id`: no
  220 sidecar and no migration. Derived like `pick_list_id`/`return_id`
  (`BASE-WIRE-FULFILLMENT220-20261023.md`, `BASE-WIRE-RETURNS-20261023.md`): hex digits 1–12 and 14 of
  the immutable native v4 UUID + 1 (1..2^52). Natively created rows are visible at once with the same
  ID. A collision with another row of the same company and kind fails the create (503
  `LOCAL_BASE_WIRE_WMS_ID`, nothing kept); a lookup/page meeting two rows with one ID fails 503. A
  later sidecar must backfill these values. Lookups compute the derivation (no index; acceptable locally).
- Document and PO lines have no own identity (one native line per product): `item_id` = the line's
  220 product ID; `position` = 1-based rank in the native order (sku, product), so a later line with a
  smaller SKU shifts positions.
- Idempotency-Key (UUID) on every write is replayed in the same transaction as the effect
  (`idempotency_keys`, prefix `base_wire220:`); another body under the key → 409.

## Documents
- `document_type`: 0 GR ↔ `receipt` (PZ), 2 GI ↔ `issue` (WZ), 4 IT ↔ `transfer` (MM). 1 IGR, 3 IGI,
  5 OB → 422 `LOCAL_BASE_WIRE_DOCUMENT_TYPE`. Native `count` (INW) documents and the read-only
  stocktake-adjustment PW/RW register are not listed.
- `document_status`: 0 ↔ draft, 1 ↔ posted. Cancelled native documents are not listed.
- `direction` 0 for PZ, 1 for WZ/MM. `warehouse_id2` = MM destination. `total_price`/`price` (N28): a PZ of a
  purchase receipt carries the native purchase cost — line `price` = the purchase order line's
  `unit_cost` (the same value as getInventoryPurchaseOrderItems `item_cost`), line `total_price` = unit cost ×
  PZ quantity, document `total_price` = sum of its lines (major units, the PO currency, which Base documents
  do not state). Shown only to keys that also hold `purchasing:read` (the scope of the native purchase
  costs, like `/wms-lots/valuation`), checked on `api_keys` through the owner pool like the catalog export;
  other keys get 0. Manual PZ, WZ and MM: 0 (`warehouse_document_lines` has no price column). `source_object_*` = 2 + purchase order ID for a PZ of a purchase receipt, else
  0; `connection_*` repeats it (the only native link). `filter_source_object_type` other than 2 → empty.
  `filter_warehouse_id` matches the main warehouse. Dates: created/posted, inclusive second bounds.
  Order (created_at, id), page n = rows 100(n−1)+1…100n.
- addInventoryDocument creates an empty native draft (the native REST schema needs ≥1 line, the
  function and tables do not; the Base flow adds items afterwards). `invoice_no` → `reference`, `notes`
  → `note`. `target_warehouse_id` only (and required) for type 4. `date_add`/`date_execute`/`contractor`
  non-empty → 422 `LOCAL_BASE_WIRE_UNSUPPORTED_FIELD` (native dates are the transaction clock).
- addInventoryDocumentItems: draft only (409); the product must not already be on the document (409),
  no duplicates in a call (422). Native location: PZ `location_name`, MM `target_location_name`
  (default `A-01`); a WZ takes no location (the native issue chooses it), and the other location field
  is refused. `price`, `expiry_date`, `batch`, `serial_no`, `comments` non-empty → 422.
- setInventoryDocumentStatusConfirmed: an empty document → 422; an already confirmed one → success
  without a second posting (stock moves exactly once; the native post is replay-safe as well).

## Purchase orders
- Status: draft 0, ordered 1, partial 4, received 3, closed 3, cancelled 5. `name` ↔ `reference`,
  `notes` ↔ `note`, `date_delivery_expected` → `expected_date` (UTC date). `payer_id` must be 0;
  `invoice_no`, `date_cost_invoice_issue`, `additional_costs`, `packages` non-empty → 422.
  `date_sent` = first `purchase.place` audit event, `date_received` = last receipt, `date_completed` =
  last change of a received/closed order. Amounts: native minor units ↔ Base major (2 decimals max).
- addInventoryPurchaseOrderItems: draft only. The same product with the same `item_cost` and
  `supplier_code` adds the quantity (like the native draft append); another cost/code → 409 (one native
  line per product). Item `location`/`batch`/`expiry_date`/`serial_no`/`comments` → 422.
- setInventoryPurchaseOrderStatus: 1 = native place (non-empty draft); 5 = native cancel
  (`Anulowane przez Base API`; draft/ordered only, else native 409); 0 only as a no-op; 2 and 6 → 422
  (no native delivery stage). 3/4 with `completed_items`: `completed_quantity` is the **absolute**
  received total of the line (LOCAL), so the native receipt (PZ posted in the same transaction, location
  `A-01`) gets only the increase and a repeat receives nothing; a lower value → 409. 4 must leave the
  order open (else 409, use 3). 3 closes any open remainder natively (`Zakończone przez Base API`).
  The same status again without new quantities is a no-op.

## Suppliers
- Output `address`, `phone`, `email`, `tax_no` (= `tax_id`); `postcode`, `city`, `email_copy_to`,
  `currency` are '' (no native columns). Inactive suppliers are listed too. `filter_name` is a
  case-insensitive substring. Unpaged: more than 1000 matches → 422.
- addInventorySupplier without `supplier_id` creates (name ≥2 characters required, LOCAL code
  `BASE-<12 hex>`, country PL, active); with `supplier_id` updates, omitted fields keep their value.
  `postcode`, `city`, `email_copy_to`, `currency`, `take_product_cost_from/code_from` non-empty → 422.

## Stocktakes (read-only)
- Status: counting 2, review 4, posted 3, cancelled 5; 0/1 do not exist (filter → empty).
  `stocktake_number` '' (no native number; filter → empty), priority/assignment/schedule 0,
  `items_preparation_status` ready. Item `quantity` = native basis quantity, `verified_quantity` =
  counted (0 when not counted), `is_verified` = counted.
- Blind stocktakes in counting/review show non-admins expected quantities and compliance counts as 0
  (the native detail hides them too).

## Tests
- `tests/base-wire-wms.test.ts` — service on a closed native port (6 tests; N28: PZ cost, manual PZ 0, no
  purchasing:read 0, scope not read when no native cost).
- `tests/base-wire-n28-fixes.database.test.ts` — N28 fixes on a fresh PG04 clone `dynaminds_n28fix_20261023_NN`
  (218–225 by the guarded applier; 3 tests): PO receipt PZ 4×12.50 + 3×3.33 → document 59.99 and line
  prices; inventory-only key 0; manual PZ 0; also the inventory stockless birth and translations (below).
- `tests/base-wire-wms.database.test.ts` — real Fastify + key gate + native code on a fresh PG04 clone
  `dynaminds_wirewms_20261023_NN` (2 tests): Base PZ draft + items + confirm → stock +3 exactly once
  (key replay and plain repeat), native document posted with one movement; supplier create/update/list;
  PO create (replayed create = one PO), items, place, partial receipt once, completion closing the
  remainder; stocktake reads of a native stocktake; foreign tenant 404/empty; read-only key 403.
- `tests/base-wire-crm-application-registration.test.ts` — eighth family in the `app.ts` statement.
