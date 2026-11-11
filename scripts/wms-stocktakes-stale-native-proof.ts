/** Root-only native rejection of an earlier review belonging to an already cancelled own spis. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
type Json = Record<string, any>;
const statePath = 'data/wms-stocktakes-stage112.json';
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
async function snapshot(s: Json) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    const out: Json = {};
    for (const name of s.own_names as string[]) {
      assert(/^[a-z][a-z0-9_]*$/.test(name));
      const rows = (
        await c.query(
          `SELECT to_jsonb(t) row FROM "${name}" t WHERE ${['tenants', 'users'].includes(name) ? 'id' : 'tenant_id'}=$1 ORDER BY 1`,
          [name === 'users' ? s.user : s.tenant],
        )
      ).rows;
      out[name] = { count: rows.length, sha256: hash(rows) };
    }
    await c.query('COMMIT');
    return out;
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}
try {
  const stat = await lstat(statePath);
  assert(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600);
  const bytes = await readFile(statePath);
  const s: Json = JSON.parse(bytes.toString('utf8'));
  assert(
    s.stage === 112 &&
      s.api_acceptance?.status === 'PASS' &&
      s.ui_verified &&
      s.native_operator_ui_verified &&
      s.restart_verified,
  );
  const revision = process.env.QA_EXPECTED_REVISION ?? s.runtime_revision;
  const h = (await (await fetch('http://127.0.0.1:4100/api/health')).json()) as Json;
  assert.equal(h.revision, revision);
  assert.equal(revision, s.runtime_revision);
  assert.equal(h.schema_revision, '093_wms_validation_scopes');
  assert(!h.restore_preview);
  const original = await snapshot(s);
  assert.deepEqual(original, s.own_snapshot);
  const [old] = (
    await pool.query(
      `SELECT h.id,h.state,h.version,r.id review_id,r.stocktake_version,r.scope_hash FROM wms_stocktakes h JOIN wms_stocktake_reviews r ON (r.tenant_id,r.stocktake_id)=(h.tenant_id,h.id) WHERE h.tenant_id=$1 AND h.state='cancelled' ORDER BY r.created_at LIMIT 1`,
      [s.tenant],
    )
  ).rows;
  assert(
    old && BigInt(old.stocktake_version) < BigInt(old.version),
    'A genuine earlier immutable review of a cancelled own spis is required',
  );
  const response = await fetch(
    'http://127.0.0.1:4100/api/wms-lots/stocktakes/' + old.id + '/post',
    {
      method: 'POST',
      headers: { cookie: s.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_key: randomUUID(),
        version: old.stocktake_version,
        review_id: old.review_id,
        scope_hash: old.scope_hash,
        confirmed: true,
      }),
      signal: AbortSignal.timeout(15000),
    },
  );
  assert.equal(response.status, 409);
  assert.deepEqual(
    await snapshot(s),
    original,
    'Rejected stale terminal approval must change no own data',
  );
  assert.equal(
    hash(await readFile(statePath)),
    hash(bytes),
    'The accepted private checkpoint must remain unchanged',
  );
  const result = {
    stage: 112,
    status: 'PASS',
    revision,
    schema: h.schema_revision,
    case: 'earlier_review_of_cancelled_spis',
    stocktake: old.id,
    review: old.review_id,
    request_version: old.stocktake_version,
    current_version: old.version,
    http_status: 409,
    own_tables_exact: Object.keys(original).length,
    physical_movement_ABA_claim: false,
    provider_verified: false,
    goal_complete: false,
  };
  await writeFile(
    'docs/wms-stocktakes-stale-native-qa.json',
    JSON.stringify(result, null, 2) + '\n',
    { flag: 'wx' },
  );
  console.log(result);
} finally {
  await pool.end();
}
