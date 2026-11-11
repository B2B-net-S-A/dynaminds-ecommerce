import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
const source = 'https://developer.ebay.com/develop/guides/authorization.md';
const r = await fetch(source, { signal: AbortSignal.timeout(20000) });
assert.equal(r.status, 200);
const bytes = Buffer.from(await r.arrayBuffer());
assert(bytes.length < 4 * 1024 * 1024);
const text = bytes.toString().replace(/\\_/g, '_');
for (const value of [
  'https://auth.sandbox.ebay.com/oauth2/authorize',
  'https://auth.ebay.com/oauth2/authorize',
  'https://api.sandbox.ebay.com/identity/v1/oauth2/token',
  'https://api.ebay.com/identity/v1/oauth2/token',
  'RuName',
  'authorization_code',
  'refresh_token_expires_in',
  '1024',
  'single-use',
  'state',
])
  assert(text.includes(value), value);
const report = {
  checked_at: new Date().toISOString(),
  scope: 'public_official_eBay_OAuth_documentation_read',
  source,
  http_status: r.status,
  bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  validated: [
    'sandbox/live consent and token hosts',
    'RuName in redirect_uri',
    'authorization_code grant',
    'single-use code length 1024',
    'state returned on callback',
    'refresh token expiry',
  ],
  provider_authenticated: false,
  provider_business_mutations: 0,
  whole_goal_complete: false,
};
await writeFile('docs/ebay-oauth-contract-qa.json', JSON.stringify(report, null, 2) + '\n');
console.log(report);
