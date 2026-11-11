import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
const url =
  'https://developer.ebay.com/api-docs/master/sell/inventory/openapi/3/sell_inventory_v1_oas3.json';
const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
assert.equal(r.status, 200);
const bytes = Buffer.from(await r.arrayBuffer());
assert(bytes.length < 4 * 1024 * 1024);
const spec = JSON.parse(bytes.toString('utf8'));
for (const [path, operation] of Object.entries({
  '/inventory_item': 'getInventoryItems',
  '/inventory_item_group/{inventoryItemGroupKey}': 'getInventoryItemGroup',
  '/offer': 'getOffers',
})) {
  const op = spec.paths[path].get;
  assert.equal(op.operationId, operation);
  assert(
    op.security[0].api_auth.includes(
      'https://api.ebay.com/oauth/api_scope/sell.inventory.readonly',
    ),
  );
}
for (const [model, fields] of Object.entries({
  InventoryItems: ['inventoryItems', 'limit', 'next', 'size', 'total'],
  InventoryItemWithSkuLocaleGroupid: [
    'sku',
    'product',
    'availability',
    'inventoryItemGroupKeys',
    'groupIds',
  ],
  InventoryItemGroup: ['inventoryItemGroupKey', 'variantSKUs', 'variesBy', 'aspects', 'imageUrls'],
  Offers: ['offers', 'limit', 'next', 'size', 'total'],
  EbayOfferDetailsWithAll: [
    'offerId',
    'sku',
    'marketplaceId',
    'format',
    'pricingSummary',
    'listing',
    'lotSize',
  ],
  PricingSummary: ['price', 'auctionStartPrice'],
  Tax: ['applyTax', 'vatPercentage'],
  ShipToLocationAvailability: ['quantity'],
}))
  for (const field of fields)
    assert(spec.components.schemas[model].properties[field], model + '.' + field);
for (const [path, params] of Object.entries({
  '/inventory_item': ['offset', 'limit'],
  '/offer': ['offset', 'limit', 'sku', 'marketplace_id'],
}))
  for (const name of params)
    assert(spec.paths[path].get.parameters.some((p: any) => p.name === name));
const report = {
  checked_at: new Date().toISOString(),
  scope: 'official_public_Inventory_OpenAPI_contract_read',
  official_source: url,
  http_status: r.status,
  bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  api_version: spec.info.version,
  read_endpoints_confirmed: [
    'GET /inventory_item',
    'GET /inventory_item_group/{inventoryItemGroupKey}',
    'GET /offer?sku=...&marketplace_id=...',
  ],
  scope_confirmed: 'sell.inventory.readonly',
  provider_authenticated: false,
  provider_business_mutations: 0,
  whole_goal_complete: false,
};
await writeFile('docs/ebay-catalog-contract-qa.json', JSON.stringify(report, null, 2) + '\n');
console.log(report);
