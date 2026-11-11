/** Bounded root native fixture queue drain. Real dispatch engine, exactly own
 * pending automation jobs with immutable empty rule arrays; no worker tick. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, open, readFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = '<workspace>/app';
const file = resolve(root, 'data/product-catalogs-empty-jobs157.json');
let state: any, pool: any;
async function read(path: string) {
  const s = await lstat(path); assert(s.isFile() && !s.isSymbolicLink()); assert.equal(s.mode & 0o777, 0o600);
  return JSON.parse(await readFile(path, 'utf8'));
}
async function wx(path: string, v: any) { const f = await open(path, 'wx', 0o600);
  try { await f.writeFile(JSON.stringify(v, null, 2) + '\n'); await f.sync(); } finally { await f.close(); } }
async function save() { const tmp = file + '.' + randomUUID() + '.tmp'; await wx(tmp, state); await rename(tmp, file);
  const d = await open(resolve(root, 'data'), 'r'); try { await d.sync(); } finally { await d.close(); } }
async function main() {
  assert.equal(process.cwd(), root); assert.equal(process.env.DYNA_LOCAL_CONFIG_PATH, resolve(root, '.local.json'));
  assert.equal(process.env.DYNA_WORKER_DISABLED, 'true');
  assert.equal(process.env.QA157_EMPTY_JOBS_CONFIRM, 'DISPATCH_ONLY_OWN_FROZEN_EMPTY_RULES');
  const setup = await read(resolve(root, 'data/product-catalogs-stage157.json'));
  const off = await read(resolve(root, 'data/product-catalogs-commerce157-off.json'));
  assert.equal(setup.complete, true); assert.equal(setup.pending, null); assert.equal(off.status, 'LOCAL_COMMERCE_PASS');
  assert.equal(off.tenant_id, setup.actor.tenant_id);
  const { pool: p } = await import('../server/db'); pool = p;
  const { dispatchAutomation } = await import('../server/automations');
  const h = await fetch('http://127.0.0.1:4100/api/health').then(r => r.json());
  assert.equal(h.revision, 'f4dee74de9940d3b6fda92f7f6324c6a33dad484'); assert.equal(h.background_workers_enabled, false);
  const jobs = (await pool.query("SELECT * FROM jobs WHERE tenant_id=$1 AND state IN ('pending','running') ORDER BY id", [off.tenant_id])).rows;
  assert.equal(jobs.length, 10);
  for (const j of jobs) { assert.equal(j.state, 'pending'); assert.equal(j.kind, 'automation');
    assert.deepEqual(j.payload.rules, []); assert(j.payload.snapshot); assert.equal(j.payload.orderId, off.order_id); }
  assert.equal((await pool.query('SELECT count(*)::int n FROM automation_rules WHERE tenant_id=$1', [off.tenant_id])).rows[0].n, 0);
  state = { stage: 157, tenant_id: off.tenant_id, order_id: off.order_id, status: 'PREPARED', pending: null,
    jobs, completed: [], provider_calls: 0, workers_enabled: false };
  await wx(file, state);
  for (const j of jobs) {
    const lease = randomUUID(); state.pending = { job_id: j.id, lease_token: lease, phase: 'claim' }; await save();
    const claimed = (await pool.query("UPDATE jobs SET state='running',lease_token=$3,locked_at=now(),attempts=attempts+1 WHERE tenant_id=$1 AND id=$2 AND state='pending' AND kind='automation' AND payload=$4::jsonb RETURNING *",
      [off.tenant_id, j.id, lease, JSON.stringify(j.payload)])).rows;
    assert.equal(claimed.length, 1); state.pending.phase = 'dispatch'; await save();
    await dispatchAutomation(claimed[0]);
    const after = (await pool.query('SELECT * FROM jobs WHERE tenant_id=$1 AND id=$2', [off.tenant_id, j.id])).rows[0];
    assert.equal(after.state, 'done'); assert.equal(after.lease_token, null);
    state.completed.push(after); state.pending = null; await save();
  }
  assert.equal((await pool.query("SELECT count(*)::int n FROM jobs WHERE tenant_id=$1 AND state IN ('pending','running')", [off.tenant_id])).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM automation_runs WHERE tenant_id=$1', [off.tenant_id])).rows[0].n, 0);
  state.status = 'OWN_EMPTY_RULE_JOBS_DONE'; await save(); process.stdout.write('QA157_OWN_EMPTY_RULE_JOBS_DONE_10\n');
}
main().catch(async (e) => { if (state) { state.status = 'FAILED_DO_NOT_RETRY'; state.failure = String(e); await save().catch(() => undefined); }
  process.stderr.write('QA157_EMPTY_JOBS_FAILED_PRIVATE_DETAILS_WITHHELD\n'); process.exitCode = 1; }).finally(async () => { await pool?.end(); });
