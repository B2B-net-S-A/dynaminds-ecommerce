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
const s = JSON.parse(bytes.toString('utf8'));
const inventory = s.paths['/inventory_item/{sku}'].put,
  offer = s.paths['/offer'].post;
assert.equal(inventory.operationId, 'createOrReplaceInventoryItem');
assert.equal(offer.operationId, 'createOffer');
for (const p of [inventory, offer]) {
  assert(p.security.some((v: any) => v.api_auth.includes(EBAY_INVENTORY_WRITE_SCOPE)));
  for (const header of ['Content-Language', 'Content-Type'])
    assert(p.parameters.some((v: any) => v.name === header && v.in === 'header' && v.required));
  assert(p.requestBody.content['application/json']);
}
assert(inventory.responses['204']);
assert(offer.responses['201']);
assert(s.components.schemas.OfferResponse.properties.offerId);
assert(s.paths['/inventory_item/{sku}'].get.responses['404']);
assert(s.paths['/offer'].get.responses['404']);
const report = {
  checked_at: new Date().toISOString(),
  source,
  http_status: r.status,
  bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  artifact_version: s.info.version,
  mutations: ['PUT /sell/inventory/v1/inventory_item/{sku}', 'POST /sell/inventory/v1/offer'],
  required_headers: ['Content-Language', 'Content-Type'],
  required_scope: EBAY_INVENTORY_WRITE_SCOPE,
  html_marker_preservation_authenticated: false,
  provider_authenticated: false,
  provider_business_mutations: 0,
  whole_goal_complete: false,
};
await writeFile('docs/ebay-creation-contract-qa.json', JSON.stringify(report, null, 2) + '\n');
console.log(report);
