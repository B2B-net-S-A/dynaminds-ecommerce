/** Read-only preservation proof across schema111. Never rewrites an accepted fixture. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';

type Mark = { count: number; sha256: string };
type Checkpoint = Record<string, Mark>;
type Firm = { tenant: string; user: string; checkpoint: Checkpoint };
const phase = process.argv[2];
assert(phase === 'before' || phase === 'after');
const acceptedPath = 'data/source-order-intent-stage127b.json';
const beforePath = 'docs/b2b-dropshipping-returns-history-before.json';
const afterPath = process.env.QA_REPORT_FILE ?? 'docs/b2b-dropshipping-returns-history-after.json';
assert.match(afterPath, /^docs\/b2b-dropshipping-returns-history-[a-z0-9-]+\.json$/);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bytesHash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const originalCheckpointHash = '904d7b3f02c976630e8089e4978a9eb52d2cd8bf3f684751350841f8ed29070a';

async function privateBytes(path: string) {
  assert.match(path, /^data\/[a-z0-9-]+\.json$/);
  const info = await lstat(path);
  assert(
    info.isFile() && !info.isSymbolicLink() && !(info.mode & 0o077),
    'Private regular fixture required',
  );
  return readFile(path);
}

try {
  const acceptedBytes = await privateBytes(acceptedPath);
  const accepted = JSON.parse(acceptedBytes.toString('utf8'));
  assert.equal(
    digest(accepted.accepted_checkpoint),
    originalCheckpointHash,
    'Original accepted checkpoint must remain exact',
  );
  assert.equal(accepted.previous.length, 6);
  const files = new Map<string, string>([[acceptedPath, bytesHash(acceptedBytes)]]);
  const firms: Firm[] = [...accepted.previous];
  for (const prior of accepted.previous) {
    const bytes = await privateBytes(prior.path);
    assert.equal(bytesHash(bytes), prior.fixture_sha256, 'Previous private fixture changed');
    files.set(prior.path, bytesHash(bytes));
  }
  for (const side of ['buyer', 'supplier'])
    firms.push({
      tenant: accepted[side].tenant,
      user: accepted[side].user,
      checkpoint: accepted.accepted_checkpoint[side],
    });
  assert.equal(firms.length, 8);
  assert.equal(new Set(firms.map((f) => f.tenant)).size, 8);
  const healthResponse = await fetch('http://127.0.0.1:4100/api/health', {
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(healthResponse.status, 200);
  const health = (await healthResponse.json()) as Record<string, any>;
  const expectedRevision = process.env.QA_EXPECTED_REVISION;
  assert(
    expectedRevision && /^[a-f0-9]{7,40}$/.test(expectedRevision),
    'Expected runtime revision required',
  );
  assert.equal(health.revision, expectedRevision);
  assert.equal(health.restore_preview, false);
  assert.equal(
    health.schema_revision,
    phase === 'before' ? '110_b2b_external_order_imports' : '111_b2b_dropshipping_returns',
  );
  if (phase === 'after') assert.equal(health.b2b_dropshipping_returns_available, true);

  const c = await pool.connect();
  const counts: Array<{ original_tables: number; new_empty_tables: number }> = [];
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TimeZone='UTC'");
    const names: string[] = (
      await c.query(`SELECT t.table_name
      FROM information_schema.tables t JOIN information_schema.columns k USING(table_schema,table_name)
      WHERE t.table_schema='public' AND t.table_type='BASE TABLE' AND k.column_name='tenant_id'
      AND t.table_name<>'sessions' UNION SELECT 'users' UNION SELECT 'tenants' ORDER BY 1`)
    ).rows.map((r) => r.table_name);
    for (const firm of firms) {
      let newEmpty = 0;
      for (const name of Object.keys(firm.checkpoint))
        assert(names.includes(name), 'Original table missing: ' + name);
      for (const name of names) {
        assert.match(name, /^[a-z_][a-z0-9_]*$/);
        const key = name === 'users' || name === 'tenants' ? 'id' : 'tenant_id';
        const rows = (
          await c.query(`SELECT to_jsonb(t) row FROM "${name}" t WHERE ${key}=$1 ORDER BY 1`, [
            name === 'users' ? firm.user : firm.tenant,
          ])
        ).rows;
        if (Object.hasOwn(firm.checkpoint, name))
          assert.deepEqual(
            { count: rows.length, sha256: digest(rows) },
            firm.checkpoint[name],
            'Accepted business rows changed: ' + name,
          );
        else {
          assert.equal(rows.length, 0, 'New module populated an accepted firm: ' + name);
          ++newEmpty;
        }
      }
      counts.push({
        original_tables: Object.keys(firm.checkpoint).length,
        new_empty_tables: newEmpty,
      });
    }
    await c.query('COMMIT');
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
  for (const [path, hash] of files)
    assert.equal(
      bytesHash(await privateBytes(path)),
      hash,
      'Fixture bytes changed during observation',
    );
  const fixtureHashes = Object.fromEntries(files);
  if (phase === 'after') {
    const before = JSON.parse(await readFile(beforePath, 'utf8'));
    assert.equal(before.status, 'PASS');
    assert.equal(before.accepted_checkpoint_sha256, originalCheckpointHash);
    assert.deepEqual(
      fixtureHashes,
      before.private_fixture_sha256,
      'Original private bytes changed since pre111',
    );
    assert.deepEqual(
      counts.map((c) => c.original_tables),
      before.firms.map((c: any) => c.original_tables),
    );
  }
  const report = {
    phase,
    status: 'PASS',
    revision: health.revision,
    schema_revision: health.schema_revision,
    accepted_checkpoint_sha256: originalCheckpointHash,
    firms: counts,
    private_fixture_sha256: fixtureHashes,
    sessions_excluded: true,
    fixture_rewritten: false,
    original_baseline_rebased: false,
    scope:
      'Eight previously accepted firms: exact original tenant rows and empty new tables; no new workflow acceptance.',
    private_credentials_published: false,
    full_goal_complete: false,
  };
  await writeFile(
    phase === 'before' ? beforePath : afterPath,
    JSON.stringify(report, null, 2) + '\n',
    { flag: 'wx' },
  );
  process.stdout.write(
    JSON.stringify({
      phase,
      status: 'PASS',
      firms: firms.length,
      original_baseline_rebased: false,
    }) + '\n',
  );
} finally {
  await pool.end();
}
