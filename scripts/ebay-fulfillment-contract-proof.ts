import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
const source =
  'https://developer.ebay.com/api-docs/master/sell/fulfillment/openapi/3/sell_fulfillment_v1_oas3.json';
const r = await fetch(source, { signal: AbortSignal.timeout(20000) });
assert.equal(r.status, 200);
const b = Buffer.from(await r.arrayBuffer());
assert(b.length < 4 * 1024 * 1024);
const v = JSON.parse(b.toString());
const path = v.paths['/order/{orderId}/shipping_fulfillment'];
assert(path.get && path.post);
assert.equal(path.post.operationId, 'createShippingFulfillment');
assert(path.post.responses['201'].headers.Location);
assert.deepEqual(path.post.security[0].api_auth, [
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
]);
assert.equal(
  path.post.requestBody.content['application/json'].schema.$ref,
  '#/components/schemas/ShippingFulfillmentDetails',
);
assert.deepEqual(Object.keys(v.components.schemas.ShippingFulfillmentDetails.properties).sort(), [
  'lineItems',
  'shippedDate',
  'shippingCarrierCode',
  'trackingNumber',
]);
assert(
  v.components.schemas.ShippingFulfillmentDetails.properties.trackingNumber.description.includes(
    'alphanumeric',
  ),
);
assert(v.components.schemas.ShippingFulfillment.properties.shipmentTrackingNumber);
assert(v.components.schemas.ShippingFulfillmentPagedCollection.properties.fulfillments);
assert(v.components.schemas.ShippingFulfillmentPagedCollection.properties.total);
const report = {
  checked_at: new Date().toISOString(),
  scope: 'public_official_eBay_fulfillment_contract',
  official_source: source,
  http_status: r.status,
  bytes: b.length,
  sha256: createHash('sha256').update(b).digest('hex'),
  api_version: v.info.version,
  endpoints: [
    'GET /order/{orderId}',
    'GET /order/{orderId}/shipping_fulfillment',
    'POST /order/{orderId}/shipping_fulfillment',
  ],
  write_scope: 'sell.fulfillment',
  created_http: 201,
  location_header: true,
  tracking_field_read: 'shipmentTrackingNumber',
  tracking_field_write: 'trackingNumber',
  provider_authenticated: false,
  provider_business_mutations: 0,
  whole_goal_complete: false,
};
await writeFile(
  process.argv[2] ?? 'docs/ebay-fulfillment-contract-qa.json',
  JSON.stringify(report, null, 2) + '\n',
);
console.log(report);
