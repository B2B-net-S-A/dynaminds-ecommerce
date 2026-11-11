import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { EBAY_INVENTORY_WRITE_SCOPE } from '../server/ebay';
const url =
  'https://developer.ebay.com/api-docs/master/sell/inventory/openapi/3/sell_inventory_v1_oas3.json';
const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20000) });
assert.equal(response.status, 200);
const bytes = Buffer.from(await response.arrayBuffer());
assert(bytes.length < 4 * 1024 * 1024);
const s = JSON.parse(bytes.toString('utf8')),
  write = s.paths['/bulk_update_price_quantity'].post;
assert.equal(write.operationId, 'bulkUpdatePriceQuantity');
assert(write.security.some((x: any) => x.api_auth.includes(EBAY_INVENTORY_WRITE_SCOPE)));
assert(write.description.includes('Only one SKU'));
assert(write.description.includes('250 times'));
assert.equal(
  write.requestBody.content['application/json'].schema.$ref,
  '#/components/schemas/BulkPriceQuantity',
);
assert.equal(
  write.responses['200'].content['application/json'].schema.$ref,
  '#/components/schemas/BulkPriceQuantityResponse',
);
assert(write.responses['207']);
assert(write.parameters.some((p: any) => p.name === 'Content-Type' && p.required));
assert(s.components.schemas.PriceQuantity.properties.shipToLocationAvailability);
assert(s.components.schemas.OfferPriceQuantity.properties.offerId);
assert(s.components.schemas.OfferPriceQuantity.properties.price);
assert(s.components.schemas.OfferPriceQuantity.properties.availableQuantity);
assert(s.paths['/inventory_item/{sku}'].get);
assert(s.paths['/offer'].get);
const report = {
  checked_at: new Date().toISOString(),
  scope: 'public_official_eBay_inventory_contract_read',
  source: url,
  http_status: response.status,
  bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  version: s.info.version,
  mutation: 'POST /sell/inventory/v1/bulk_update_price_quantity',
  scope_required: EBAY_INVENTORY_WRITE_SCOPE,
  sku_per_call: 1,
  offers_per_sku_max: 25,
  listing_revisions_daily_limit: 250,
  partial_status: 207,
  provider_authenticated: false,
  provider_business_mutations: 0,
  whole_goal_complete: false,
};
await writeFile('docs/ebay-offers-contract-qa.json', JSON.stringify(report, null, 2) + '\n');
console.log(report);
