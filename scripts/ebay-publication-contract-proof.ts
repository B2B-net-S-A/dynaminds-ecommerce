import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { EBAY_INVENTORY_WRITE_SCOPE } from '../server/ebay';
const source =
  'https://developer.ebay.com/api-docs/master/sell/inventory/openapi/3/sell_inventory_v1_oas3.json';
const r = await fetch(source, { redirect: 'error', signal: AbortSignal.timeout(20000) });
assert.equal(r.status, 200);
const bytes = Buffer.from(await r.arrayBuffer());
assert(bytes.length < 4 * 1024 * 1024);
const s = JSON.parse(bytes.toString('utf8')),
  p = s.paths['/offer/{offerId}/publish'].post;
assert.equal(p.operationId, 'publishOffer');
assert.equal(p.requestBody, undefined);
assert(p.security.some((v: any) => v.api_auth.includes(EBAY_INVENTORY_WRITE_SCOPE)));
assert(p.parameters.some((v: any) => v.name === 'offerId' && v.in === 'path' && v.required));
assert.equal(
  p.responses['200'].content['application/json'].schema.$ref,
  '#/components/schemas/PublishResponse',
);
assert(s.components.schemas.PublishResponse.properties.listingId);
assert.equal(s.paths['/offer/{offerId}'].get.operationId, 'getOffer');
assert.equal(s.paths['/location/{merchantLocationKey}'].get.operationId, 'getInventoryLocation');
assert(s.components.schemas.EbayOfferDetailsWithAll.properties.listing);
assert(s.components.schemas.InventoryItemWithSkuLocaleGroupid.properties.inventoryItemGroupKeys);
const report = {
  checked_at: new Date().toISOString(),
  source,
  http_status: r.status,
  bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  version: s.info.version,
  mutation: 'POST /sell/inventory/v1/offer/{offerId}/publish',
  request_body: false,
  response_listing_id: true,
  required_scope: EBAY_INVENTORY_WRITE_SCOPE,
  provider_authenticated: false,
  provider_business_mutations: 0,
  whole_goal_complete: false,
};
await writeFile('docs/ebay-publication-contract-qa.json', JSON.stringify(report, null, 2) + '\n');
console.log(report);
