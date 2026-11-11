import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
const url = 'https://developer.ebay.com/develop/guides/sell/listing-management';
const r = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
assert.equal(r.status, 200);
const html = await r.text(),
  plain = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
assert(/250 times per calendar day/.test(plain));
assert(/bulkUpdatePriceQuantity/.test(plain));
const report = {
  checked_at: new Date().toISOString(),
  source: url,
  http_status: r.status,
  sha256: createHash('sha256').update(html).digest('hex'),
  bytes: Buffer.byteLength(html),
  provider_calendar_limit: 250,
  local_rolling_window_hours: 24,
  local_attempt_limit: 250,
  authenticated_provider_verified: false,
  provider_business_requests: 0,
  whole_goal_complete: false,
};
await writeFile('docs/ebay-budget-contract-qa.json', JSON.stringify(report, null, 2) + '\n');
console.log(report);
