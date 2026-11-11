# Product deletion 225 — native "deleted" state (variant A), 23.10.2026

Decision by the owner: variant A of "Native gaps re-examined 23.10.2026" in
`BASE-WIRE-INVENTORY220-20261023.md`. A physical `DELETE FROM products` stays out of scope
(immutable SKU alias in `product_sku_aliases`, 60 NO ACTION foreign keys, un-keyed history).

## Data (migration 225)
- `server/225_product_deletions.sql`: own table `product_deletions225` (tenant_id, product_id FK to
  `products(tenant_id,id)`, actor_id, api_key_id, reason ≤ 500, product_version, deleted_at), PK
  (tenant_id, product_id), RLS `tenant_scope`, SELECT+INSERT for `dyna_app`, append-only guard (no
  UPDATE/DELETE/TRUNCATE, also for the owner). Nothing is attached to `products` or any other core table
  except the internal RI triggers of the FK. A deletion is permanent (no restore).
- Registered in `server/db.ts` after 224; packaged (2801 bytes, sha256 e927a41a…); exact compiled
  225→224 cold-catalogue inverse (31 additions, 0 changes). All nine guards true before/after 225 and after
  a real `migrate()` 218–225.

## Command (`server/product-deletion-command.ts`)
One transaction: exclusive catalogue lock → product row FOR UPDATE → not already deleted → version →
stock rows FOR UPDATE → refusals → `editProduct(..., active:false)` (native editor, version+1, no product
rule event) → `product_deletions225` row → audit `product.delete`.

Refusals (409, first match):
| Native fact | Message |
|---|---|
| `stock.on_hand<>0 OR reserved<>0`, `wms_layer_positions` quantity/reserved | Produkt ma stan magazynowy lub rezerwacje. Wyzeruj stan przed usunięciem. |
| `reservations.state='active'` | Produkt ma aktywne rezerwacje zamówień. |
| order line in an order `new/paid/picking/packed/return_initiated/return_received` | Produkt jest w otwartych zamówieniach lub zwrotach. |
| purchase order line, order `draft/ordered/partial` | Produkt jest w otwartych zamówieniach zakupu. |
| line of a `draft` warehouse document | Produkt jest w niezaksięgowanym dokumencie magazynowym. |
| line of a `counting/review` stocktake or WMS stocktake | Produkt jest w otwartej inwentaryzacji. |
| non-deleted variant of the group | Grupa ma warianty. Usuń najpierw warianty. |
| component of a non-deleted bundle | Produkt jest składnikiem zestawu. |
| any `listings` row (natively a listing is never ended) or `offer_plans` `preview/queued` | Produkt ma oferty w kanałach sprzedaży. |

Other answers: 404 not found (also foreign tenant, RLS), 409 "Produkt został już usunięty", 409 stale
version, 503 without 225.

## Entry points
- Native: `POST /api/products/:id/deletion` (admin), body `{version, reason?}` → `{id, sku, deleted:true,
  deleted_at}`. Not exposed on `/api/v1` (the developer API op list is unchanged).
- UI: "Usuń produkt" on the catalog product card (admin), in-dialog confirmation with consequences and
  optional reason (`web/catalog-product-deletion.tsx`).
- Base: `deleteInventoryProduct` `{product_id}` in the inventory family (PIM part), scope products:write,
  admin, native credential custody, `Idempotency-Key` replay stored in the same transaction; response
  `{}` (→ `{status:"SUCCESS"}`); native refusals 409; absent or already deleted 404; without 225 → 503
  (startup capability `productDeletions225Available`).

## Reads
- **Detail choice: 404.** `GET /api/products/:id` of a deleted product answers 404 "Produkt został
  usunięty" (no banner): the card is gone; orders, returns and documents show their own snapshot
  (sku/name on the line) and keep `product_id`.
- Hidden: product list/search (also SKU aliases) and the `sellable` picker, variants on a group card,
  the four Base inventory reads (getInventoryProductsList/Data/Stock/Prices) and every product lookup of
  the Base inventory writes, plus the must-filter modules below.
- Writers: `editProduct` refuses (409 "Produkt został usunięty"); a deleted group is not a valid parent;
  writers that require `active` refuse naturally (a deleted product is always inactive).
- SKU: the row and its immutable alias stay, so the SKU is never given to another product
  (`createProduct` → unique violation; Base addInventoryProduct → 409). The CSV import preview marks a
  row matching a deleted SKU as an error.

## Audit of the modules reading `products` (80 files)
`grep -l "FROM products\|JOIN products" server/*.ts`. Counts: **must-filter 36** (all done),
**history-keep 13**, **irrelevant 31**.

| Module | Class | Action |
|---|---|---|
| allegro-batches.ts | must-filter | batch creation refuses deleted |
| allegro-batch-routes.ts | history-keep | — |
| automation-local-effects.ts | irrelevant | offers of picked orders; deleted has neither |
| b2b-catalog-scope-adapters.ts | irrelevant | `p.active` gates |
| b2b-external-order-intent-preconditions.ts | irrelevant | createOrder active check |
| b2b-external-order-imports.ts | irrelevant | active checks |
| b2b-network.ts | irrelevant | `active` in query |
| b2b-network-orders.ts | irrelevant | requireActive |
| b2b-network-dropshipping.ts | history-keep | — |
| b2b-network-returns.ts | history-keep | — |
| b2b.ts | irrelevant | `p.active` |
| base-wire-inventory-runtime.ts | must-filter | four reads + write lookups filtered; deleteProduct |
| base-wire-orders-runtime.ts | irrelevant | addOrder → createOrder refuses inactive |
| base-wire-returns-runtime.ts | history-keep | — |
| base-wire-wms-runtime.ts | history-keep | — |
| catalog-ai-routes.ts | irrelevant | panel behind the hidden card |
| catalog-ai.ts | must-filter | generation refuses deleted |
| catalog-bulk-edit.ts | must-filter | selection/preview filtered |
| catalog-export.ts | must-filter | export filter and variants filtered |
| catalog-export-sources.ts | irrelevant | ids from filtered export rows |
| catalog-file-import.ts | must-filter | row error "Produkt został usunięty"; parent/component refused |
| catalog-file-import-eligibility.ts | irrelevant | id availability check |
| catalog-source.ts | must-filter | apply refuses a deleted SKU candidate |
| catalog-source-routes.ts | irrelevant | preview display; apply refuses |
| catalog.ts | must-filter | list/search/picker, detail 404, variants, editProduct, parent, CSV preview |
| competitor-observations.ts | must-filter | import refuses deleted |
| deepl-catalog.ts | must-filter | preview refuses deleted |
| deepl-batches.ts | must-filter | batch creation refuses deleted |
| deepl-catalog-routes.ts | irrelevant | panel existence |
| deepl-batch-routes.ts | history-keep | — |
| domain.ts | irrelevant | createOrder active checks; pick scan is history |
| import-routes.ts | irrelevant | offer mappings; deleted has none |
| inventory.ts | must-filter | list/snapshot filtered; legacy adjust refuses |
| inventory-bulk-edit.ts | must-filter | states filtered |
| inventory-correction.ts | irrelevant | refusal sits in inventory.ts (file is byte-pinned) |
| language-file-import.ts | must-filter | identities filtered |
| local-automation-worker-control.ts | irrelevant | offers |
| local-simulation-offer-routes.ts | must-filter | 404 |
| local-woo-flow.ts | irrelevant | offers |
| odoo-catalog-sync.ts | irrelevant | offers; run items history |
| odoo-image-imports.ts | irrelevant | requires an offer |
| offer-routes.ts | history-keep | — |
| offer-sync-routes.ts | irrelevant | offers |
| offer-sync.ts | irrelevant | offers |
| offers.ts | irrelevant | uses productDetail (404) |
| order-product-logistics.ts | history-keep | — |
| order-split-source.ts | history-keep | — |
| packing-workstation.ts | history-keep | — |
| picking-waves.ts | history-keep | — |
| pricing.ts | must-filter | quote 404 |
| pricing-routes.ts | must-filter | list filtered; item write refuses |
| price-bulk-edit.ts | must-filter | states filtered |
| price-file-import.ts | must-filter | resolution filtered (preview and apply) |
| price-matrix-import.ts | must-filter | re-resolution filtered |
| product-deletion-command.ts | irrelevant | the command itself |
| product-rule-schedules.ts | must-filter | frozen products filtered |
| product-rules.ts | must-filter | run refuses; deletion emits no rule event |
| product-sku.ts | irrelevant | SKU identity: deleted SKUs stay reserved |
| product-translation-bulk-edit.ts | must-filter | states filtered |
| purchasing.ts | must-filter | purchase line refuses |
| replenishment-automations.ts | irrelevant | `p.active` |
| replenishment-plans.ts | must-filter | policy write refuses; selection/list filtered |
| repricing.ts | irrelevant | inactive skipped |
| repricing-routes.ts | must-filter | inputs list filtered; write refuses |
| return-assistant-queues.ts | history-keep | — |
| shopify-translations.ts | irrelevant | requires an offer; history |
| shopify-translation-routes.ts | irrelevant | panel |
| shopify-translation-batches.ts | must-filter | selection filtered |
| stock-file-import.ts | must-filter | resolution filtered |
| stock-location-routes.ts | must-filter | list filtered |
| stocktake-scans.ts | irrelevant | frozen stocktake lines |
| stocktakes.ts | must-filter | scope filtered |
| supplier-catalog.ts | must-filter | linking refuses |
| supplier-catalog-routes.ts | irrelevant | existing mapping display |
| variable-offers.ts | must-filter | variants filtered |
| variant-offer-batches.ts | must-filter | group/variants filtered |
| variant-offer-routes.ts | history-keep | — |
| warehouse.ts | must-filter | document lines refuse; posting an earlier draft refuses |
| wms-lots.ts | must-filter | receipts/movements refuse |
| wms-stocktakes.ts | must-filter | declared positions refuse |

## Evidence (23.10.2026)
- `tests/product-deletions225.database.test.ts` on fresh clone `dynaminds_pdel225_20261023_07`
  (217 template + 218–225, guarded): 6/6 pass.
- Unit: `tests/base-wire-inventory-pim.test.ts` (deleteInventoryProduct), `run-bw.sh` 267/267,
  `web/catalog-product-deletion.test.mjs` + `web/catalog-list.test.mjs` 13/13, packaging 75/75,
  source-compatibility + cold-gate 191 pass / 7 opt-in skipped.

## Remaining / known limits
- No restore ("cofnij usunięcie"); the table is append-only by design.
- A product with any channel listing can never be deleted (listings are never ended natively).
- Concurrent stock writers that do not check 225 (e.g. a stocktake posting created before deletion is
  refused by the open-stocktake check, but a writer starting after the commit still goes through the
  per-module refusals listed above).
- `tests/base-wire-inventory-pim.database.test.ts` was adjusted (deleteInventoryProduct now 503 without
  the 225 capability) but not rerun: it requires a `dynaminds_wirepim_*` clone.
- `server/catalog-stock-writer-coverage.ts` SOURCE_ROSTER pins were already out of date on HEAD and now
  also differ for the files filtered here; re-pin at release packaging.
