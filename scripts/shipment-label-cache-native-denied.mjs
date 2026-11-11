/** One-shot exact replay and denied API requests on the own QA147 fixture. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = '<workspace>/app';
const s = JSON.parse(
  await readFile(resolve(root, 'data/shipment-label-cache-stage147.json'), 'utf8'),
);
const p = JSON.parse(
  await readFile(resolve(root, 'data/shipment-label-cache-stage147-proof-v2.json'), 'utf8'),
);
assert.equal(s.stage, 147);
assert.equal(s.complete, true);
assert.equal(s.pending, null);
assert.equal(p.status, 'PASS_LIMITED');
assert.equal(p.pending, null);
const own = s.orders[0];
const ready = p.completed.find((x) => x.step === 'acquire-ready');
const cached = ready.receipt.cache;
const health = await (await fetch('http://127.0.0.1:4100/api/health')).json();
assert.equal(health.revision, process.env.QA_EXPECTED_REVISION);
assert.equal(health.schema_revision, '131_shipment_label_cache');
assert.equal(health.background_workers_enabled, false);
const tests = [
  {
    name: 'exact acquire replay',
    method: 'POST',
    path: `/print-jobs/shipments/${own.shipment_id}/label-cache`,
    body: null,
  },
];
// Read the immutable original request through a private owner query. Replay
// uses its original principal and key, without a new acquisition identity.
const { pool } = await import('../server/db.ts');
try {
  const row = (
    await pool.query(
      'SELECT request FROM shipment_label_cache_acquisitions WHERE tenant_id=$1 AND id=$2',
      [s.tenant_id, ready.receipt.acquisition.id],
    )
  ).rows[0];
  assert(row);
  tests[0].body = row.request;
  tests.push(
    {
      name: 'caller bytes refused',
      method: 'POST',
      path: `/print-jobs/shipments/${own.shipment_id}/label-cache`,
      body: {
        ...row.request,
        client_key: randomUUID(),
        content_base64: s.controlled_pdf.content_base64,
      },
      expected: 422,
    },
    {
      name: 'missing consent refused',
      method: 'POST',
      path: `/print-jobs/shipments/${own.shipment_id}/label-cache`,
      body: { ...row.request, client_key: randomUUID(), confirmed_existing_label: false },
      expected: 422,
    },
    {
      name: 'changed source refused',
      method: 'POST',
      path: `/print-jobs/shipments/${own.shipment_id}/label-cache`,
      body: { ...row.request, client_key: randomUUID(), source_hash: '0'.repeat(64) },
      expected: 409,
    },
    {
      name: 'changed request for same key refused',
      method: 'POST',
      path: `/print-jobs/shipments/${own.shipment_id}/label-cache`,
      body: { ...row.request, source_hash: '0'.repeat(64) },
      expected: 409,
    },
    {
      name: 'foreign workspace export refused',
      method: 'GET',
      path: `/print-jobs/label-cache/${cached.id}/pdf?workspace_id=${randomUUID()}`,
      expected: 409,
    },
    {
      name: 'anonymous content refused',
      method: 'GET',
      path: `/print-jobs/label-cache/${cached.id}/content`,
      anonymous: true,
      expected: 401,
    },
    {
      name: 'unbounded history refused',
      method: 'GET',
      path: `/print-jobs/shipments/${own.shipment_id}/label-cache/history?limit=51`,
      expected: 422,
    },
  );
  const custody = resolve(root, 'data/shipment-label-cache-stage147-denied.json');
  // Reserve and retain exact requests before any POST; no automatic rerun.
  await writeFile(
    custody,
    JSON.stringify({ stage: 147, status: 'INTENT_RECORDED', tests }) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  const results = [];
  for (const t of tests) {
    const r = await fetch('http://127.0.0.1:4100/api' + t.path, {
      method: t.method,
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
      headers: {
        'Content-Type': 'application/json',
        ...(t.anonymous ? {} : { cookie: s.cookie, 'X-Workspace-ID': s.tenant_id }),
      },
      ...(t.body ? { body: JSON.stringify(t.body) } : {}),
    });
    assert.equal(r.status, t.expected ?? 200, t.name);
    if (t.name === 'exact acquire replay') {
      const d = await r.json();
      assert.equal(d.reused, true);
      assert.equal(d.cache.id, cached.id);
      assert.equal(d.acquisition.state, 'ready');
    } else await r.arrayBuffer();
    results.push({ name: t.name, status: r.status });
  }
  const report = {
    stage: 147,
    status: 'EXACT_REPLAY_AND_DENIED_PASS',
    runtime_revision: health.revision,
    results,
    provider_verified: false,
    full_goal_complete: false,
  };
  await writeFile(
    resolve(root, 'docs/shipment-label-cache-native-denied.json'),
    JSON.stringify(report, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  console.log(JSON.stringify(report));
} finally {
  await pool.end();
}
