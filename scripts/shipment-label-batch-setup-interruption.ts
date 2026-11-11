/** Read-only evidence for the failed QA149 owner-fixture transaction. Never resumes it. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pool } from '../server/db';
const root = '<workspace>/app';
assert.equal(process.cwd(), root);
assert.equal(process.env.DYNA_LOCAL_CONFIG_PATH, root + '/.local.json');
try {
  const bytes = await readFile(root + '/data/shipment-label-batch-stage149.json');
  const s = JSON.parse(bytes.toString());
  assert.equal(s.complete, false);
  assert.equal(s.pending?.kind, 'OWNER_SQL_FIXTURE');
  assert.equal(s.pending.shipments.length, 3);
  const c = await pool.connect();
  let counts: any, constraint: any;
  try {
    await c.query('BEGIN READ ONLY');
    counts = (
      await c.query(
        'SELECT (SELECT count(*) FROM orders WHERE tenant_id=$1)::int orders,(SELECT count(*) FROM shipments WHERE tenant_id=$1)::int shipments,(SELECT count(*) FROM print_jobs WHERE tenant_id=$1)::int print_jobs,(SELECT count(*) FROM shipment_label_cache_assets WHERE tenant_id=$1)::int caches',
        [s.tenant_id],
      )
    ).rows[0];
    constraint = (
      await c.query(
        "SELECT conname,pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conrelid='shipments'::regclass AND contype='u' AND pg_get_constraintdef(oid)='UNIQUE (tenant_id, order_id)' ",
      )
    ).rows;
    assert.deepEqual(counts, { orders: 2, shipments: 0, print_jobs: 0, caches: 0 });
    assert.equal(constraint.length, 1);
    await c.query('COMMIT');
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
  const r = {
    stage: 149,
    status: 'SETUP_INTERRUPTED_NO_RETRY',
    tenant_id: s.tenant_id,
    pending_kind: s.pending.kind,
    proposed_shipments: 3,
    completed_api_mutations: s.completed.length,
    counts,
    blocking_constraint: constraint[0],
    owner_seed_transaction_rolled_back: true,
    private_journal_sha256: createHash('sha256').update(bytes).digest('hex'),
    journal_resumed: false,
    provider_requests: 0,
    batch_process_verified: false,
    full_goal_complete: false,
  };
  await writeFile(
    '<workspace>/worktrees/stock-file-import/docs/shipment-label-batch-setup-interruption.json',
    JSON.stringify(r, null, 2) + '\n',
    { flag: 'wx' },
  );
  console.log(
    JSON.stringify({ status: r.status, counts, blocking_constraint: constraint[0].conname }),
  );
} finally {
  await pool.end();
}
