import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
const sources = [];
for (const [url, patterns] of [
  [
    'https://developer.ebay.com/develop/api/sell/api_call_limits',
    [/Inventory API/, /default/i, /Application Growth Check/],
  ],
  [
    'https://developer.ebay.com/develop/api/sell/error_codes',
    [/429/, /Too many requests/i, /request limit has been reached/i],
  ],
] as const) {
  const { stdout } = await promisify(execFile)(
    'curl',
    ['-sS', '-L', '--max-time', '30', '-w', '\n%{http_code}', url],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  const split = stdout.lastIndexOf('\n'),
    status = Number(stdout.slice(split + 1));

  const html = stdout.slice(0, split),
    plain = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  const content_verified = status === 200 && patterns.every((p) => p.test(plain));
  sources.push({
    url,
    http_status: status,
    content_verified,
    bytes: Buffer.byteLength(html),
    sha256: createHash('sha256').update(html).digest('hex'),
  });
}
const report = {
  checked_at: new Date().toISOString(),
  sources,
  direct_documents_verified: sources.every((s) => s.content_verified),
  search_index_verified_at: '2026-10-04',
  search_index_note:
    'Official eBay pages retrieved through web search confirm default call limits and HTTP429. Direct GET may return403; no authenticated quota read.',
  local_concurrency_per_application_mode_family: 4,
  lease_seconds: 60,
  local_missing_retry_after_fallback_seconds: 60,
  provider_daily_quota_hardcoded: false,
  provider_quota_api_read: false,
  provider_authenticated: false,
  provider_business_requests: 0,
  whole_goal_complete: false,
};
await writeFile('docs/ebay-api-contract-qa.json', JSON.stringify(report, null, 2) + '\n');
console.log(report);
