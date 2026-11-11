import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { EBAY_ACCOUNT_READ_SCOPE, EBAY_TRADING_SCOPE, EBAY_INVENTORY_SCOPE } from '../server/ebay';
const sources = [
  [
    'account',
    'https://developer.ebay.com/api-docs/master/sell/account/openapi/3/sell_account_v1_oas3.json',
  ],
  [
    'taxonomy',
    'https://developer.ebay.com/api-docs/master/commerce/taxonomy/openapi/3/commerce_taxonomy_v1_oas3.json',
  ],
  [
    'inventory',
    'https://developer.ebay.com/api-docs/master/sell/inventory/openapi/3/sell_inventory_v1_oas3.json',
  ],
] as const;
const reports: any[] = [];
for (const [kind, source] of sources) {
  const r = await fetch(source, { redirect: 'error', signal: AbortSignal.timeout(20000) });
  assert.equal(r.status, 200);
  const bytes = Buffer.from(await r.arrayBuffer());
  assert(bytes.length < 4 * 1024 * 1024);
  const s = JSON.parse(bytes.toString('utf8'));
  const check = (path: string, operation: string, scope: string) => {
    const p = s.paths[path].get;
    assert.equal(p.operationId, operation);
    assert(p.security.some((v: any) => v.api_auth.includes(scope)));
    assert(p.responses['200']);
    return p;
  };
  const methods: string[] = [];
  if (kind === 'account')
    for (const name of ['payment', 'return', 'fulfillment']) {
      const p = check(
        '/' + name + '_policy',
        'get' + name[0].toUpperCase() + name.slice(1) + 'Policies',
        EBAY_ACCOUNT_READ_SCOPE,
      );
      assert(p.parameters.some((v: any) => v.name === 'marketplace_id'));
      assert(p.parameters.some((v: any) => v.name === 'Content-Language'));
      const single =
        '/' +
        name +
        '_policy/{' +
        (name === 'fulfillment' ? 'fulfillmentPolicyId' : name + '_policy_id') +
        '}';
      check(
        single,
        'get' + name[0].toUpperCase() + name.slice(1) + 'Policy',
        EBAY_ACCOUNT_READ_SCOPE,
      );
      methods.push('/' + name + '_policy', single);
    }
  if (kind === 'taxonomy')
    for (const [path, op] of [
      ['/get_default_category_tree_id', 'getDefaultCategoryTreeId'],
      ['/category_tree/{category_tree_id}/get_category_suggestions', 'getCategorySuggestions'],
      ['/category_tree/{category_tree_id}/get_category_subtree', 'getCategorySubtree'],
      [
        '/category_tree/{category_tree_id}/get_item_aspects_for_category',
        'getItemAspectsForCategory',
      ],
    ]) {
      check(path, op, EBAY_TRADING_SCOPE);
      methods.push(path);
    }
  if (kind === 'inventory') {
    const p = check('/location', 'getInventoryLocations', EBAY_INVENTORY_SCOPE);
    for (const v of ['limit', 'offset']) assert(p.parameters.some((a: any) => a.name === v));
    methods.push('/location');
  }
  reports.push({
    kind,
    source,
    http_status: 200,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    artifact_version: s.info.version,
    methods,
  });
}
const report = {
  checked_at: new Date().toISOString(),
  scope: 'official_public_OpenAPI_documents_only',
  sources: reports,
  seller_scope: EBAY_ACCOUNT_READ_SCOPE,
  application_scope: EBAY_TRADING_SCOPE,
  provider_authenticated: false,
  provider_business_requests: 0,
  whole_goal_complete: false,
};
await writeFile('docs/ebay-seller-contract-qa.json', JSON.stringify(report, null, 2) + '\n');
console.log(report);
