import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
const specUrl =
  'https://developer.ebay.com/api-docs/master/sell/fulfillment/openapi/3/sell_fulfillment_v1_oas3.json';
const r = await fetch(specUrl, { signal: AbortSignal.timeout(20000) });
assert.equal(r.status, 200);
const bytes = Buffer.from(await r.arrayBuffer());
assert(bytes.length < 4 * 1024 * 1024);
const spec = JSON.parse(bytes.toString('utf8')),
  page = spec.paths['/order'].get;
assert.equal(page.operationId, 'getOrders');
assert.equal(spec.paths['/order/{orderId}'].get.operationId, 'getOrder');
for (const p of ['filter', 'offset', 'limit', 'fieldGroups'])
  assert(page.parameters.some((v: any) => v.name === p));
assert(
  page.security[0].api_auth.includes(
    'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly',
  ),
);
for (const [model, fields] of Object.entries({
  Order: [
    'orderId',
    'lastModifiedDate',
    'lineItems',
    'pricingSummary',
    'cancelStatus',
    'paymentSummary',
    'fulfillmentStartInstructions',
  ],
  LineItem: [
    'sku',
    'quantity',
    'total',
    'taxes',
    'deliveryCost',
    'ebayCollectAndRemitTaxes',
    'ebayCollectedCharges',
  ],
  DeliveryCost: ['shippingCost', 'discountAmount', 'handlingCost', 'importCharges'],
  PricingSummary: ['total', 'deliveryCost', 'deliveryDiscount', 'fee'],
  Payment: ['amount', 'paymentStatus'],
  ExtendedContact: ['fullName', 'email', 'contactAddress'],
  CancelStatus: ['cancelState', 'cancelRequests'],
})) {
  for (const field of fields)
    assert(spec.components.schemas[model].properties[field], model + '.' + field);
}
const report = {
  checked_at: new Date().toISOString(),
  scope: 'official_public_OpenAPI_contract_read',
  official_source: specUrl,
  http_status: r.status,
  bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  api_version: spec.info.version,
  read_endpoints_confirmed: ['GET /order', 'GET /order/{orderId}'],
  field_groups: 'TAX_BREAKDOWN',
  authorization_reference: 'https://developer.ebay.com/develop/guides/sell/authorization',
  base_reference: 'https://base.com/pl-PL/integracje/ebay/',
  provider_authenticated: false,
  provider_business_mutations: 0,
  whole_goal_complete: false,
};
await writeFile('docs/ebay-order-contract-qa.json', JSON.stringify(report, null, 2) + '\n');
console.log(report);
