/** Explicit owned QA144 attempts with a durable unknown-outcome journal. No automatic retries. */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = '<workspace>/app';
assert.equal(resolve(process.env.DYNA_LOCAL_CONFIG_PATH ?? ''), resolve(root, '.local.json'));
const phase = process.argv[2];
assert(['single-denied', 'change-tag', 'replay'].includes(phase));
const state = JSON.parse(
  await readFile(resolve(root, 'data/proforma-batches-stage144.json'), 'utf8'),
);
assert.equal(state.complete, true);
assert.equal(state.pending, null);
const journalPath = resolve(root, `data/proforma-batches-stage144-attempt-${phase}.json`);
const reportPath = `docs/proforma-batches-native-${phase}.json`;
for (const path of [journalPath, reportPath]) {
  try {
    await lstat(path);
    throw Error('Own attempt already exists; inspect rather than rerun');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}
const health = (await (await fetch('http://127.0.0.1:4100/api/health')).json()) as any;
assert.equal(health.revision, process.env.QA_EXPECTED_REVISION);
assert.equal(health.schema_revision, '128_proforma_batches');
assert.equal(health.background_workers_enabled, false);
assert.equal(health.restore_preview, false);
const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const { pool } = await import('../server/db');
try {
  async function snapshot() {
    const c = await pool.connect();
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await c.query("SET LOCAL TimeZone='UTC'");
      const names = (
        await c.query(
          "SELECT table_name FROM information_schema.tables t WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name<>'sessions' AND EXISTS(SELECT 1 FROM information_schema.columns k WHERE k.table_schema=t.table_schema AND k.table_name=t.table_name AND k.column_name='tenant_id') ORDER BY table_name",
        )
      ).rows;
      const rows: Record<string, any[]> = {};
      for (const { table_name: name } of names) {
        assert(/^[a-z_][a-z0-9_]*$/.test(name));
        rows[name] = (
          await c.query(`SELECT to_jsonb(q) row FROM "${name}" q WHERE tenant_id=$1 ORDER BY 1`, [
            state.tenant_id,
          ])
        ).rows.map((r) => r.row);
      }
      await c.query('COMMIT');
      return rows;
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }
  const before = await snapshot();
  const journal: { phase: string; attempts: any[]; complete: boolean } = {
    phase,
    attempts: [],
    complete: false,
  };
  await writeFile(journalPath, JSON.stringify(journal) + '\n', { flag: 'wx', mode: 0o600 });
  const post = async (path: string, body: unknown, status: number) => {
    journal.attempts.push({ path, body, expected_status: status, pending: true });
    await writeFile(journalPath, JSON.stringify(journal) + '\n', { mode: 0o600 });
    const r = await fetch('http://127.0.0.1:4100/api' + path, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      headers: {
        cookie: state.cookie,
        'X-Workspace-ID': state.tenant_id,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    assert.equal(r.status, status, 'Owned attempt returned unexpected status; do not retry');
    const result = (await r.json()) as any;
    journal.attempts.at(-1).pending = false;
    await writeFile(journalPath, JSON.stringify(journal) + '\n', { mode: 0o600 });
    return result;
  };
  const detail: Record<string, unknown> = {};
  if (phase === 'single-denied') {
    assert.equal(before.proforma_batch_previews.length, 1);
    assert.equal(before.documents.length, 0);
    const p = before.proforma_batch_previews[0].payload.rows[0];
    await post(
      `/proformas/previews/${p.preview_id}/issue`,
      { client_key: randomUUID(), scope_hash: p.scope_hash, confirmed: true, local_only: true },
      409,
    );
    detail.single_child_status = 409;
  } else if (phase === 'change-tag') {
    assert.equal(before.proforma_batch_previews.length, 2);
    assert.equal(before.proforma_batch_executions.length, 1);
    const issued = before.proforma_batch_executions[0].preview_id;
    const p = before.proforma_batch_previews.find((p) => p.id !== issued).payload.rows[0];
    const result = await post(
      `/orders/${p.order_id}/operations`,
      { type: 'add_tag', tag: 'QA144-stale-preview' },
      200,
    );
    assert.equal(result.changed, true);
    assert.notEqual(String(result.version), p.order_version);
    detail.order_id = p.order_id;
    detail.old_version = p.order_version;
    detail.new_version = String(result.version);
  } else {
    assert.equal(before.proforma_batch_executions.length, 1);
    const e = before.proforma_batch_executions[0];
    const result = await post(`/proformas/batches/previews/${e.preview_id}/issue`, e.request, 200);
    assert.equal(result.reused, true);
    assert.equal(result.execution.id, e.id);
    await post(
      `/proformas/batches/previews/${e.preview_id}/issue`,
      { ...e.request, scope_hash: '0'.repeat(64) },
      409,
    );
    detail.exact_replay_status = 200;
    detail.reused = true;
    detail.conflicting_same_key_status = 409;
    detail.execution_id = e.id;
  }
  const after = await snapshot();
  if (phase !== 'change-tag')
    assert.equal(sha(after), sha(before), 'Owned denial/replay changed business rows');
  journal.complete = true;
  await writeFile(journalPath, JSON.stringify(journal) + '\n', { mode: 0o600 });
  const report = {
    stage: 144,
    phase,
    status: 'PASS',
    runtime_revision: health.revision,
    ...detail,
    owned_tables: Object.keys(before).length,
    before_sha256: sha(before),
    after_sha256: sha(after),
    unchanged_business_rows: phase !== 'change-tag',
    external_provider_verification: false,
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(
    JSON.stringify({
      stage: 144,
      phase,
      status: 'PASS',
      unchanged_business_rows: phase !== 'change-tag',
    }),
  );
} finally {
  await pool.end();
}
