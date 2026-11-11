import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
const sources = [
  [
    'get_user',
    'https://developer.ebay.com/devzone/xml/docs/reference/ebay/GetUser.html',
    ['EIASToken', 'ReturnSummary', '1477'],
  ],
  [
    'xml_gateway',
    'https://developer.ebay.com/api-docs/user-guides/static/make-a-call/using-xml.html',
    [
      'https://api.sandbox.ebay.com/ws/api.dll',
      'https://api.ebay.com/ws/api.dll',
      'X-EBAY-API-IAF-TOKEN',
      'X-EBAY-API-COMPATIBILITY-LEVEL',
      'text/xml',
    ],
  ],
  [
    'immutable_identity',
    'https://developer.ebay.com/api-docs/user-guides/static/trading-user-guide/user-mgmt-user-info.html',
    ['EIASToken', 'does not change', 'UserId'],
  ],
  [
    'authorization',
    'https://developer.ebay.com/develop/guides/authorization.md',
    ['Trading API', 'User access token', 'https://api.ebay.com/oauth/api_scope'],
  ],
] as const;
const reports = await Promise.all(
  sources.map(async ([name, url, expected]) => {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    assert.equal(r.status, 200, url);
    const bytes = Buffer.from(await r.arrayBuffer());
    assert(bytes.length < 8 * 1024 * 1024);
    const text = bytes
      .toString()
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/\\_/g, '_');
    for (const v of expected) assert(text.includes(v), name + ': ' + v);
    return {
      name,
      url,
      http_status: r.status,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      validated: expected,
    };
  }),
);
const report = {
  checked_at: new Date().toISOString(),
  scope: 'official_public_eBay_Trading_GetUser_contract',
  sources: reports,
  provider_authenticated: false,
  provider_business_mutations: 0,
  whole_goal_complete: false,
};
await writeFile('docs/ebay-account-contract-qa.json', JSON.stringify(report, null, 2) + '\n');
console.log(report);
