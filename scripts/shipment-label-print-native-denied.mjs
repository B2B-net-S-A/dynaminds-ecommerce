/** Isolated QA146 API acceptance. Each exact request is journalled before dispatch. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
const root = '<workspace>/app';
const setup = JSON.parse(await readFile(root + '/data/print-jobs-stage146.json', 'utf8'));
const snapshot = JSON.parse(
  await readFile(root + '/data/shipment-label-print-stage146-after-files.json', 'utf8'),
);
assert.equal(setup.complete, true);
assert.equal(setup.pending, null);
const source = snapshot.rows.print_job_label_sources[0];
const preview = snapshot.rows.print_label_previews.find((p) => p.id === source.preview_id);
assert.equal(source.preview_id, '0af78cfb-0475-4eba-953b-6d48537a6e2f');
const records = [];
async function attempt(name, path, expected, body, auth = true) {
  const intentPath = root + '/data/qa146-print-api-' + name + '.json';
  const intent = {
    name,
    method: body ? 'POST' : 'GET',
    path,
    body,
    expected,
    started_at: new Date().toISOString(),
  };
  await writeFile(intentPath, JSON.stringify(intent), { flag: 'wx', mode: 0o600 });
  const headers = auth ? { cookie: setup.cookie, 'X-Workspace-ID': setup.tenant_id } : {};
  if (body) headers['Content-Type'] = 'application/json';
  const r = await fetch('http://127.0.0.1:4100/api' + path, {
    method: intent.method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  const result = await r.json();
  await writeFile(intentPath + '.result.json', JSON.stringify({ status: r.status, result }), {
    flag: 'wx',
    mode: 0o600,
  });
  assert.equal(r.status, expected, name + ': unexpected HTTP status');
  records.push({ name, status: r.status, expected });
  return result;
}
const h = await attempt('health', '/health', 200, undefined, false);
assert.equal(h.revision, process.env.QA_EXPECTED_REVISION);
assert.equal(h.background_workers_enabled, false);
const queue = '/print-jobs/label-previews/' + source.preview_id + '/queue';
const replay = await attempt('exact-replay', queue, 200, source.request);
assert.equal(replay.reused, true);
assert.equal(replay.job.id, source.job_id);
await attempt('changed-scope', queue, 409, { ...source.request, scope_hash: 'a'.repeat(64) });
await attempt('already-bound-preview-new-key', queue, 409, {
  ...source.request,
  client_key: randomUUID(),
});
await attempt('consent-false', queue, 422, { ...source.request, confirmed: false });
await attempt('caller-label-body', queue, 422, { ...source.request, content_base64: 'JVBERg==' });
const create = '/print-jobs/shipments/' + setup.shipment_id + '/label-previews';
await attempt('stale-order-version', create, 409, {
  ...preview.request,
  client_key: randomUUID(),
  order_version: '1',
});
await attempt('stale-printer-version', create, 409, {
  ...preview.request,
  client_key: randomUUID(),
  printer_version: '2',
});
await attempt('caller-provenance', create, 422, {
  ...preview.request,
  client_key: randomUUID(),
  source_kind: 'demo_generated',
});
await attempt(
  'wrong-workspace-pdf',
  '/print-jobs/label-previews/' + source.preview_id + '/pdf?workspace_id=' + randomUUID(),
  409,
);
await attempt(
  'anonymous-content',
  '/print-jobs/label-previews/' + source.preview_id + '/content',
  401,
  undefined,
  false,
);
const page = await attempt('final-job-list', '/print-jobs/jobs', 200);
assert.equal(page.jobs.length, 1);
assert.equal(page.jobs[0].id, source.job_id);
assert.equal(page.jobs[0].state, 'file_saved');
const report = {
  stage: 146,
  status: 'REPLAY_AND_DENIED_PASS',
  revision: h.revision,
  cases: records,
  exact_replay_reused: true,
  one_job: true,
  file_saved: true,
  provider_verified: false,
  physical_print_verified: false,
};
await writeFile(
  root + '/docs/shipment-label-print-native-denied.json',
  JSON.stringify(report, null, 2) + '\n',
  { flag: 'wx', mode: 0o600 },
);
console.log(JSON.stringify(report));
