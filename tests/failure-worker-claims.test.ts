/** S4: what tick() does with a job kind owned by another loop (RES-21). The scoped automation worker
 * claims `automation.local_stock` only while attempts=0; if the general tick() claims it first, it fails
 * the job as unsupported (max_attempts=1), and the stock effect of the rule is lost without a retry.
 * Run on a fresh clone dynaminds_s4_20261025_NN (tests/failure-helpers.ts). */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool } from '../server/db';
import { tick } from '../server/worker';
import { assertS4Clone, quiesceJobs, jobRow } from './failure-helpers';

assertS4Clone();
let tenant: string;
before(async () => {
  await quiesceJobs();
  tenant = (await pool.query('SELECT id FROM tenants ORDER BY created_at LIMIT 1')).rows[0].id;
});
after(async () => {
  await pool.end();
});

async function pendingJob(kind: string, maxAttempts = 1) {
  const id = randomUUID();
  await pool.query('INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key,max_attempts) VALUES($1,$2,$3,$4,$5,$6)', [
    id, tenant, kind, JSON.stringify({ s4: true }), 's4-claim:' + id, maxAttempts,
  ]);
  return id;
}

test('tick() nie przejmuje zadań pętli DeepL ani AI (wyłączone z przejęcia)', async () => {
  const ids = [await pendingJob('catalog.ai'), await pendingJob('catalog.deepl', 3), await pendingJob('catalog.deepl.batch', 3)];
  try {
    assert.equal(await tick({ transport: async () => assert.fail('no provider call') }), false);
    for (const id of ids) assert.deepEqual([(await jobRow(id)).state, (await jobRow(id)).attempts], ['pending', 0]);
  } finally {
    await pool.query("UPDATE jobs SET state='done' WHERE id=ANY($1::uuid[])", [ids]);
  }
});

test('tick() nie przejmuje automation.local_stock (efekt stanu reguły zostaje dla pętli reguł)', async () => {
  const id = await pendingJob('automation.local_stock');
  try {
    const claimed = await tick({ transport: async () => assert.fail('no provider call') });
    const j = await jobRow(id);
    assert.deepEqual([claimed, j.state, j.attempts, j.error], [false, 'pending', 0, null]);
  } finally {
    await pool.query("UPDATE jobs SET state='done' WHERE id=$1", [id]);
  }
});
