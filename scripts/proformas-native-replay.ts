/** Two explicit owned QA143 API attempts; never creates a new issue key. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
const root = '<workspace>/app';
assert.equal(resolve(process.env.DYNA_LOCAL_CONFIG_PATH ?? ''), resolve(root, '.local.json'));
const state = JSON.parse(await readFile(resolve(root, 'data/proformas-stage143.json'), 'utf8'));
const final = JSON.parse(
  await readFile(resolve(root, 'data/proformas-stage143-final.json'), 'utf8'),
);
assert.equal(state.complete, true);
assert.equal(state.pending, null);
const receipt = final.native.proforma_receipts.find((r: any) => r.order_id === state.orders[0].id);
assert(receipt && receipt.actor_id === state.user_id && receipt.api_key_id === null);
const { pool } = await import('../server/db');
try {
  async function verify() {
    const c = await pool.connect();
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await c.query("SET LOCAL TimeZone='UTC'");
      const rows: Record<string, unknown> = {};
      for (const name of Object.keys(final.native)) {
        assert(/^[a-z_][a-z0-9_]*$/.test(name));
        rows[name] = (
          await c.query(`SELECT to_jsonb(q) row FROM "${name}" q WHERE tenant_id=$1 ORDER BY 1`, [
            state.tenant_id,
          ])
        ).rows.map((r) => r.row);
      }
      assert.equal(
        createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
        createHash('sha256').update(JSON.stringify(final.native)).digest('hex'),
        'Replay changed owned business rows',
      );
      await c.query('COMMIT');
      return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }
  const before = await verify();
  const health = (await (await fetch('http://127.0.0.1:4100/api/health')).json()) as any;
  assert.equal(health.revision, process.env.QA_EXPECTED_REVISION);
  assert.equal(health.schema_revision, '127_proformas');
  assert.equal(health.background_workers_enabled, false);
  assert.equal(health.restore_preview, false);
  const post = async (body: unknown, status: number) => {
    const r = await fetch(
      'http://127.0.0.1:4100/api/proformas/previews/' + receipt.preview_id + '/issue',
      {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
        headers: {
          cookie: state.cookie,
          'X-Workspace-ID': state.tenant_id,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );
    assert.equal(r.status, status);
    return r.json() as Promise<any>;
  };
  const exact = await post(receipt.request, 200);
  assert.equal(exact.reused, true);
  assert.equal(exact.document.id, receipt.document_id);
  assert.equal(exact.document.number, receipt.number);
  await post({ ...receipt.request, scope_hash: '0'.repeat(64) }, 409);
  const after = await verify();
  assert.equal(after, before);
  const report = {
    stage: 143,
    status: 'PASS',
    runtime_revision: health.revision,
    exact_replay_status: 200,
    reused: true,
    conflicting_same_key_status: 409,
    document_id: receipt.document_id,
    number: receipt.number,
    before_sha256: before,
    after_sha256: after,
    no_additional_document_or_number: true,
  };
  await writeFile('docs/proformas-native-replay.json', JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
  });
  console.log(
    JSON.stringify({
      status: 'PASS',
      exact_replay: 200,
      conflicting_same_key: 409,
      business_rows_unchanged: true,
    }),
  );
} finally {
  await pool.end();
}
