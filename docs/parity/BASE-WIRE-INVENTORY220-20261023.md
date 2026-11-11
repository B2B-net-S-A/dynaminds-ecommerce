# Base wire: inventory family (220), 23.10.2026

Second family on `POST /connector.php` (`server/base-wire-inventory.ts`, native port
`server/base-wire-inventory-runtime.ts`). Sources: `base-api-inventory-configuration-contracts.v1.json`
(getInventoryWarehouses, getInventories) and `base-api-inventory-products-contracts.v1.json` (the other three).
Local acceptance only; no Base sandbox/account request was made.

## Identities (migration 220)
Numeric IDs come from `base_wire220_*_ids` sidecars: warehouses, product_catalogs (= Base
`inventory_id`), products (variants and bundles are products rows), price_lists, workflow_statuses,
orders, shipments (packages), documents of kind invoice/correction, local_invoice_series.
Orders/documents/series have no allocation trigger (their user triggers are pinned by earlier
guards); a future family must call `base_wire220_allocate_pending(kind)` in a writing transaction.

## Scopes
`inventory:read` for every read (also the PIM reads below, family precedent), `inventory:write` for the
stock update, `products:write` for `updateInventoryProductsPrices` and `addInventoryProduct` (the scope of
the native writers `POST/PATCH /products` and `PUT /price-lists/:id/items`). Every Base write requires its
read scope too (`baseWireRequiredScopes`, enforced in `authenticateBaseWireApiKey`): `inventory:read` or
`products:read`.

## Method → native mapping
| Method | Native source |
|---|---|
| getInventoryWarehouses | `warehouses` (same rows as `GET /api/warehouses`), WMS policy (`wmsLotsPolicyInTx`) |
| getInventories | `product_catalog_options_in_tx()` heads (same as `GET /api/product-catalogs/options`: name, is_default, languages, warehouse_ids, price_list_ids) + catalog/warehouse/price-group sidecars |
| getInventoryProductsList | `products` of one catalog (`products.catalog_id`, the column `GET /api/products?catalog_id=` filters on) + `stock`, ordered by product public ID |
| getInventoryProductsData | `products`, `stock`, `bundle_components`, variants by `parent_id`, filtered by catalog |
| updateInventoryProductsStock | legacy delta writer `adjustLegacyStockInTx` (shared with `POST /api/inventory/adjust`), `enlistInventoryLegacyAdjustmentInTx` duty (key re-verified at COMMIT), `assertWmsLegacyQuantityWriteInTx`, `catalogStockControlStrictCatalogInTx`, catalog warehouse assignment |

## Field choices (LOCAL, not Base claims)
- Warehouses: `warehouse_type` always `bl`; `internal_warehouse_id` = `warehouse_id`; `description`,
  `address`, `postcode`, `city`, `country` are `''` (no native source); `is_default` false (no native
  default warehouse); `stock_edition` = WMS lots disabled.
- Catalogs (getInventories): every own catalog (also inactive ones; Base has no such state), ordered by
  `inventory_id`; `languages`/`default_language` are the native locales as stored; `price_groups` = public
  IDs of the assigned price lists plus the derived base group (below), ascending; `warehouses` =
  `bl_<warehouse_id>` keys (same keys as the stock maps); `description` `''`, `default_warehouse` `''`,
  `default_price_group` = the base group (`products.price` applies to every catalog); `reservations` true (native stock always carries
  `reserved`); `is_default` = the native default catalog. No parameters (strict `{}`).
- Product list (getInventoryProductsList): `inventory_id` required (unknown/foreign → 404). Page size 1000
  (Base: "1000 products per page for Base warehouse"); `page` ≥1, default 1 (Base documents no default);
  an empty page is `{products:{}}` and marks the end. `filter_sort` `id ASC` (default) or `id DESC`, exact
  strings; DESC selects which products fall on each page, but integer-like JSON object keys still
  serialize ascending. Row: `id`, `parent_id` (0 for main), `ean` (`''` when null), `sku`, `name`, `stock`
  (`bl_<id>` → on_hand). `prices` is not returned (same reason as below). Variants only with
  `include_variants: true`. Supported filters: `filter_id`; `filter_ean` exact (no native additional
  EANs exist); `filter_sku` exact, case-sensitive; `filter_name` case-insensitive substring; `filter_stock_from/to`
  on the sum of on_hand over the product's stock rows (groups/bundles: 0). Absent, `null` or `''` means no
  filter. `filter_category_id` needs 224 (see "Categories (224)"); without it any value is refused like
  `filter_tag` (no tag IDs), `filter_price_from/to` (prices are price-list derived), `filter_locations`
  (matching undocumented): any other value (also 0) → 422 `LOCAL_BASE_WIRE_UNSUPPORTED_FILTER`. Products and
  catalogs always have a 220 ID (allocation trigger on insert); a missing one is 503 like the other reads.
- Products: keyed by numeric ID; `parent_id`, `is_bundle`, `sku`, `ean` (`''` when null), `tags`,
  `tax_rate` (= native VAT), `text_fields` (below), `stock`/`reservations`/`locations`
  (`bl_<warehouse_id>` → on_hand/reserved/location), `images` (positions 1–16), `variants`
  (name/sku/ean/stock/locations), `bundle_products` (bundles only).
- `text_fields` (N28, 23.10.2026): `name`/`description` = the native product (`products.name/description`,
  the catalogue default language); every native `product_translations` row of another **two-letter** locale
  adds `name|<xx>` and `description|<xx>` (contract: `[field]|[lang]`, lang = two-letter code, unqualified =
  default catalogue language). LOCAL: a translation row in the default language is not returned (the
  unqualified key is the product), and region/script locales (`en-gb`, `pt-br`) are omitted because Base
  `[lang]` has two letters. Native AI/DeepL/bulk-edit/language-file translations are all read; variants
  carry their own rows. No `features`/`description_extra*`/`extra_field_*` (no native mapping).
- `category_id` only with 224 (see "Categories (224)"); 0 = no native category.
- Not returned (no reviewed native mapping): `asin`, `star`, `manufacturer_id`,
  `prices` (served by getInventoryProductsPrices), `weight/height/
  width/length` (native logistics units need explicit conversion), `thresholds`, `incoming`,
  `average_cost`, `average_landed_cost`, `links`, `videos`.
- Flags `include_erp_units`, `include_wms_units`, `include_additional_eans`, `include_suppliers`,
  `include_relations`, `include_marketplace_categories`, `include_shipping_templates`,
  `include_channels_media` set to `true` are refused (422 `LOCAL_BASE_WIRE_UNSUPPORTED_FLAG`).
- `inventory_id` is required; an unknown/foreign one is 404. Products of another catalog or tenant
  are omitted (read) or reported in `warnings` (write). Read batch ceiling 1000 IDs.
- Stock update: absolute `on_hand` per `bl_<id>` warehouse (integers 0..2^31−1, max 1000 products).
  Per-product all-or-nothing: unknown product, group/bundle, unknown or unassigned warehouse, missing
  stock row, or target below reservations → one warning for that product, no effect. Active WMS or a
  strict catalog refuses the whole request (409). `counter` = products accepted (also when the stock
  already matched; no movement then). `warnings` is always an object.
- `Idempotency-Key` (UUID) stores the response in `idempotency_keys` in the same transaction;
  a retry after a lost ACK replays it with no second movement; another body under the same key is 409.
  Without the header the request is not replay-protected (Base documents no idempotency).

## PIM methods (23.10.2026, `server/base-wire-inventory-pim.ts`, same native port file)
Sources: `base-api-inventory-products-contracts.v1.json` (stock/prices/product methods) and
`base-api-inventory-other-configuration-contracts-20261018.md` (getInventoryPriceGroups). No migration.

| Method | Native source |
|---|---|
| getInventoryPriceGroups | `price_lists` (same rows as `GET /api/price-lists`) + `base_wire220_price_group_ids`, `tenants.currency` |
| getInventoryProductsStock | same page/filters as getInventoryProductsList (main products) + `stock` (on_hand, reserved) |
| getInventoryProductsPrices | `products.price`, `price_list_items`, the fallback rule of `prices()` (`POST /api/pricing/quote`) |
| updateInventoryProductsPrices | `writePriceListItemsInTx` (extracted unchanged from `PUT /api/price-lists/:id/items`), `editProduct` (`PATCH /api/products/:id`) for the base price |
| addInventoryProduct | create: `createProduct` (`POST /api/products`); update by `product_id`: `editProduct` with the current row + the given fields |

### Price groups (LOCAL)
- **Base price group = `products.price`, derived ID `2147483647` (no sidecar, no migration).** It is the
  `is_default` group of every catalog (`getInventories.default_price_group`), currency = company currency,
  type `standard`, name `Cena podstawowa`. The value fits int32 clients; a price list whose 220 ID ever
  equals it refuses getInventories and the price methods (503), nothing is renumbered.
- Price list → group by its 220 ID: `name`, `currency`; `description` `''`. `fallback` lists are
  `dependent_on_price_group` on the base group with `price_multiplier` = 1 + adjustment_bps/10000 and
  `price_addition` = adjustment_amount/100 (native: half-up rounding to minor units after the multiplier,
  then the addition; Base rounding is undocumented). Other lists are `standard` (1, 0). Bundles: never
  calculated (`false`, 1, 0). Inactive lists are listed (Base has no such state). Ordered by ID (base last).

### Prices (LOCAL)
- Base gross prices ↔ native integer minor units (both gross: order lines take them as `unit_gross`).
  Accepted only when exact: number 0..1 000 000 with at most 2 decimals; anything else is 422 for the
  whole request. Currency is the price list's own.
- Read (`getInventoryProductsPrices`, page 1000 main products by ID, `page` default 1): per product the
  base group, and for each price list assigned to the catalog the native quote result: the SKU price,
  else the fallback rule (active list in the company currency, result within 0..1 000 000), else no entry.
  Groups (native: no sale price) have `prices: {}`; variants are under `variants{variant_id}`.
- Write (`updateInventoryProductsPrices`, ≤1000 products/variants, variants by their own ID): per product
  all-or-nothing; unknown/foreign/other-catalog product, a variant group, or a price group not assigned to
  the catalog → one warning, no effect. A given price becomes a stored SKU price (an exact override, also on
  a fallback list, as natively); the base group edits `products.price` through `editProduct` (product
  version, audit `product.update`, product rules event). Unchanged values are not rewritten. Each touched
  list gets one native write (list version +1, audit `pricing.items`); no list version check (Base has none).
  Roles as natively: viewer 403; the base group needs admin. `counter` = accepted products.

### Stock read (LOCAL)
Same filters/paging/sort as getInventoryProductsList; `filter_category_id`, `filter_asin` (no native ASIN),
`filter_locations` with a value → 422 `LOCAL_BASE_WIRE_UNSUPPORTED_FILTER`. `reservations` is always
returned (native stock always carries `reserved`); `variant_reservations` only for products with variants,
listing variants/warehouses with a nonzero reservation. Groups/bundles have no own stock (`{}`).

### addInventoryProduct (LOCAL)
- Admin only (native product writers). `inventory_id` required (unknown/foreign → 404). `product_id`
  absent, `null`, `''` or 0 = create; otherwise update of a product of that catalog (else 404).
- Mapped: `sku`, `ean`, `tags` (list replaces, `[]` clears, omitted keeps), `tax_rate` (native VAT 0/5/8/23
  only; others incl. −1/−0.02/−0.03 → 422), `text_fields` `name`/`description` (also `|<default_language>`
  of the catalog; other languages → 422 `LOCAL_BASE_WIRE_UNSUPPORTED_FIELD` "Tłumaczenia zapisuje natywna
  edycja tłumaczeń (podgląd i wykonanie), nie Base API": a native translation requires provenance — an
  AI/DeepL draft or a bulk-edit receipt (CHECK `product_translations_provenance`), written only by the
  two-step preview → confirmed execute, so a one-call Base write has no exact native path), `prices` (as above), `images` (`url:` values at positions 0–15 replacing or appending
  contiguously; `data:`, empty values (delete) and gaps → 422; native max 10), `bundle_products`
  (components of this catalog), `parent_id`/`is_bundle` (create only: variant of a native **group** —
  Base main products cannot become groups natively — or bundle).
- Create: the base group price is required (native `price` is mandatory); `stock` names at most one
  `bl_` warehouse assigned to the catalog (two or more → 422 "Podaj stan najwyżej w jednym magazynie
  katalogu"). Without `stock` (absent, null or `{}`; Base allows a product without stock) the native
  product is born with 0 in the catalogue warehouse with the **lowest Base warehouse ID** (LOCAL
  deterministic rule: `createProduct` needs one warehouse and there is no native default warehouse;
  N28 FAIL 3, previously 422 for catalogues with 2+ warehouses).
  Native rules apply (SKU uniqueness 409, strict catalog/WMS, bundle components active and physical, …).
- Update changes only the given fields (the native PATCH body is the current row + those fields; `ean`
  null is written as `''` like a native PATCH). Kind, parent and catalog cannot change (422); `stock` →
  422 (use updateInventoryProductsStock); `active`, `category`, attributes and logistics are kept.
- Refused when non-empty (422 `LOCAL_BASE_WIRE_UNSUPPORTED_FIELD`; null/''/0/[]/{} are ignored because Base
  clients send every key): `ean_additional`, `asin`, `weight/height/width/length` (unit conversion not
  reviewed), `average_cost`, `star`, `manufacturer_id`, `category_id`, `thresholds`, `locations`, `videos`,
  `media_options`, `links`, `suppliers`, `relations`, `shipping_template`, other `text_fields` keys.
- Response `{product_id, warnings: {}}`: refusals are errors, never partial warnings.
- `Idempotency-Key` for both writes: response stored in `idempotency_keys` in the same transaction; the
  request hash includes the method, so a key is never shared across methods.

### N28 tests
- `tests/base-wire-inventory.test.ts`, `tests/base-wire-inventory-pim.test.ts`, `tests/base-wire-registry.test.ts`
  (closed ports): translations in `text_fields`, stockless birth in a 2-warehouse catalogue, specific 4xx
  reasons, generic Zod/internal/5xx. CRM routing tests now simulate internal 4xx text with raw PostgreSQL
  wording (still generic), since a Polish 4xx reason is passed deliberately.
- `tests/base-wire-n28-fixes.database.test.ts` on `dynaminds_n28fix_20261023_NN`: Base create without stock
  → native stock 0 in the lowest-ID warehouse (also `stock: {}`; explicit warehouse honoured; two → 422 with
  the reason); native bulk-edit translations `en` + `en-gb` → `name|en`/`description|en` only; `name|en`
  write → 422 with the reason; foreign tenant 404.

### Error messages (all connector.php families, N28, `baseWireError` in `server/base-wire-routes.ts`)
- A 4xx `Problem` carries its Polish business reason in `error_message` (the same `detail` the native
  REST API returns), e.g. "Podaj stan najwyżej w jednym magazynie katalogu", "Nie znaleziono własnego
  katalogu", "Podgląd kopii jest tylko do odczytu". Control characters become spaces, at most 300 characters.
- Still generic "Żądanie <rodzina> odrzucone.": Zod validation (English/structural messages), Fastify and
  parser 4xx, and any 4xx text that looks internal (raw PostgreSQL/driver text: violates, constraint,
  relation, column, SQL keywords, permission denied, function/trigger; a UUID; `dyna_api_`).
- Every 5xx stays "Operacja nie została potwierdzona. Nie ponawiaj automatycznie." (writes:
  `LOCAL_BASE_WIRE_OUTCOME_UNCONFIRMED`). Error codes are unchanged.

### Skipped (not registered → 400 `LOCAL_BASE_WIRE_METHOD`)
- **addInventoryCategory / deleteInventoryCategory** (and `category_id` in addInventoryProduct, 422):
  native PIM categories are written only through the two-step preview + confirmed apply protocol with
  PIM authority custody (admin, `products:write`), which refuses categories with unmet required parameter
  bindings; a single Base call would bypass it. Planned as variant B (below). The legacy free-text
  `products.category` is not a Base category (flat, not per catalog, no identity).

### deleteInventoryProduct (225, 23.10.2026, variant A)
- Native deleted state, never a physical delete: `deleteProductInTx` (native refusals 409, `active=false`
  through editProduct + append-only `product_deletions225` row). `{product_id}` only (any own catalog),
  admin, products:write, `Idempotency-Key` replay; absent/already deleted → 404; without 225 → 503.
  Deleted products are absent from every read of this family. Details and the module audit:
  `PRODUCT-DELETION225-20261023.md`.

### Categories (224, 23.10.2026, read-only variant A)
Migration `server/224_base_wire_categories.sql`: sidecar `base_wire224_category_ids` (tenant, catalog FK to
`product_catalogs`, PIM category UUID **without** a foreign key to `pim_dictionary_categories`, `public_id`
bigint identity 1..2^53−1; immutable: update/delete/truncate refused also for the owner; RLS tenant scope;
SELECT for `dyna_app`). Owner SECURITY DEFINER functions, current tenant from `app.tenant_id`:
`base_wire224_allocate_categories()` (writing transaction; advisory lock per tenant; allocates every native
category of the tenant without an ID, never renumbers), `base_wire224_categories(catalog)` and
`base_wire224_product_categories(catalog)` (readers of `pim_dictionary_categories` and
`pim_dictionary_product_states.category_id`, the current native category of a product; rows with an ID
only). Nothing is attached to any PIM table; all nine guards stay true after 218–224. The migration
backfills the existing categories (order tenant, catalog, UUID: the PIM keeps no creation time).
- Startup capability: table + three functions present (`baseWireCategories224Available`); without it
  getInventoryCategories is 503, `category_id` is not returned and `filter_category_id` stays 422.
- IDs are allocated in a short writing transaction before getInventoryCategories, getInventoryProductsData
  (non-empty) and a list with `filter_category_id` (pattern of getOrders). A read-only copy never allocates:
  a category created after its last allocation is not listed and its products show `category_id` 0.
- **getInventoryCategories**: `inventory_id` own catalog (unknown/foreign 404); each category
  `{category_id, name, parent_id}` (parent 0 for a root), ordered by ID, current native name (a rename or
  move keeps the ID); inactive native categories are listed too (Base has no such state). Omitted/null
  `inventory_id` = Base shared categories: none exist natively → `categories: []`.
- **getInventoryProductsData** `category_id` = 224 ID of the product's current native PIM category
  (variants: their own state), 0 when none. **getInventoryProductsList** `filter_category_id` (int ≥1) =
  exact category (not the subtree); the Base list row has no `category_id` field, so none is added.
  getInventoryProductsStock still refuses `filter_category_id` (422).

### Native gaps re-examined 23.10.2026 (options; categories variant A implemented above as 224)
- **Product deletion** (variant A implemented as 225, `PRODUCT-DELETION225-20261023.md`). A real `DELETE FROM products` is impossible for every product: each product owns an
  immutable SKU alias (`product_sku_aliases`, 197/197 products on the 217 template; trigger `immutable`
  refuses DELETE; the row is the native "a historic SKU is never given to another product" invariant and is
  read by 16 pinned functions), plus 60 NO ACTION foreign keys and ~30 un-keyed history columns
  (`stock_movements`, `reservations`, WMS layers, cross-tenant B2B `source_product_id`). Only
  `base_wire220_product_ids` is ready (ON DELETE SET NULL tombstone). Options: (A) hidden state in an
  own table (`product_deletions223`: tenant, product FK, actor, time) + `active=false`, refused while stock,
  reservations, variants or bundle use exist; filter it out of the product list/detail, pickers and the
  four Base inventory reads, and make `editProduct` refuse it. Guard-safe (own table, FK to products), but
  "disappears from all ordinary reads" means auditing ~59 server modules that read `products` (imports by
  SKU, exports, feeds, translations, bulk edits) — estimated > 1 day. (B) Real delete would need a change
  to the pinned alias immutability (out of scope by rule).
- **Categories with stable numeric IDs.** Identity must live on `pim_dictionary_categories` (UUID, per
  catalog, renames keep the UUID). Probed on a 218–222 clone (rolled back): a sidecar with a FOREIGN KEY to
  `pim_dictionary_categories` turns `ordinary187_valid`, `large_import173_valid` and `pim_dictionary_valid`
  false; a sidecar keyed to `product_catalogs` plus an owner SECURITY DEFINER reader of the PIM table keeps
  all nine guards true. Options: (A) read-only first — 22x sidecar `base_wire22x_category_ids` (no FK to PIM)
  allocated by an owner function, `getInventoryCategories` and `category_id` in product reads from
  `pim_dictionary_product_states`; (B) + writes — `addInventoryCategory` and `category_id` in
  addInventoryProduct through the native PIM preview + confirmed apply (dictionary / product_values kinds)
  with the PIM identity proof for the API key (admin, products:write), which refuses categories with
  unmet required parameter bindings. (B) is > 1 day; (A) about half a day.
