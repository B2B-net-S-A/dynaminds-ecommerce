/** Read-only preservation of the original127 and128 checkpoints across112.
 * Never copies credentials, modifies fixtures or rebases an accepted checkpoint.
 * Run from the primary app with QA_EXPECTED_REVISION and phase before|after.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pool } from '../server/db';

type Mark = { count: number; sha256: string };
type Firm = { tenant: string; user: string; checkpoint: Record<string, Mark> };
const phase = process.argv[2];
assert(phase === 'before' || phase === 'after');
const reportPath =
  process.env.QA_REPORT_FILE ?? `docs/b2b-return-local-origins-history-${phase}.json`;
assert.match(reportPath, /^docs\/b2b-return-local-origins-history-[a-z0-9-]+\.json$/);
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const bytesHash = (v: Buffer) => createHash('sha256').update(v).digest('hex');
const original127 = '904d7b3f02c976630e8089e4978a9eb52d2cd8bf3f684751350841f8ed29070a';
const original128 = 'a8d72c234e8c39fa5d86e8a409676901a0355439a63dc67f0998cd91bfba10f8';
const privateHashes = new Map<string, string>();
const historyRoot = resolve(process.env.QA_HISTORY_ROOT ?? '.');
async function privateBytes(path: string) {
  assert.match(path, /^data\/[a-z0-9-]+\.json$/);
  const sourcePath = resolve(historyRoot, path);
  const stat = await lstat(sourcePath);
  assert(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600);
  assert(stat.size <= 32 * 1024 * 1024);
  return readFile(sourcePath);
}
async function readPrivate(path: string) {
  const bytes = await privateBytes(path);
  privateHashes.set(path, bytesHash(bytes));
  return JSON.parse(bytes.toString('utf8'));
}

try {
  const old = await readPrivate('data/source-order-intent-stage127b.json');
  assert.equal(digest(old.accepted_checkpoint), original127);
  assert.equal(old.previous.length, 6);
  const oldProof = JSON.parse(
    await readFile(
      resolve(historyRoot, 'docs/b2b-dropshipping-returns-history-before.json'),
      'utf8',
    ),
  );
  assert.equal(oldProof.status, 'PASS');
  assert.equal(oldProof.accepted_checkpoint_sha256, original127);
  const firms: Firm[] = [...old.previous];
  for (const prior of old.previous) {
    const bytes = await privateBytes(prior.path);
    assert.equal(bytesHash(bytes), prior.fixture_sha256);
    privateHashes.set(prior.path, bytesHash(bytes));
  }
  for (const side of ['buyer', 'supplier'] as const)
    firms.push({ ...old[side], checkpoint: old.accepted_checkpoint[side] });
  assert.deepEqual(Object.fromEntries(privateHashes), oldProof.private_fixture_sha256);
  const setup = await readPrivate('data/b2b-dropshipping-returns-stage128.json');
  const own = await readPrivate('data/b2b-dropshipping-returns-stage128-chrome-checkpoint.json');
  const ownProof = JSON.parse(
    await readFile(
      resolve(historyRoot, 'docs/b2b-dropshipping-returns-native-chrome-qa.json'),
      'utf8',
    ),
  );
  assert.equal(ownProof.status, 'PASS');
  assert.equal(ownProof.checkpoint_sha256, original128);
  assert.equal(digest(own.checkpoint), original128);
  assert.equal(
    privateHashes.get('data/b2b-dropshipping-returns-stage128.json'),
    ownProof.setup.sha256,
  );
  for (const side of ['buyer', 'supplier'] as const) {
    assert.equal(own[side].tenant, setup[side].tenant);
    assert.equal(own[side].user, setup[side].user);
    firms.push({ ...own[side], checkpoint: own.checkpoint[side] });
  }
  assert.equal(firms.length, 10);
  assert.equal(new Set(firms.map((f) => f.tenant)).size, 10);
  const expected = process.env.QA_EXPECTED_REVISION;
  assert(expected && /^[a-f0-9]{40}$/.test(expected));
  const response = await fetch('http://127.0.0.1:4100/api/health', {
    signal: AbortSignal.timeout(10000),
    redirect: 'error',
  });
  assert.equal(response.status, 200);
  const health = (await response.json()) as Record<string, any>;
  assert.equal(health.status, 'ok');
  assert.equal(health.mode, 'local');
  assert.equal(health.revision, expected);
  assert.equal(health.restore_preview, false);
  assert.equal(health.background_workers_enabled, false);
  assert.equal(
    health.schema_revision,
    phase === 'before' ? '111_b2b_dropshipping_returns' : '112_b2b_return_local_origins',
  );
  if (phase === 'after') assert.equal(health.b2b_local_return_origins_available, true);
  const c = await pool.connect();
  const counts: Array<{ original_tables: number; new_empty_tables: number }> = [];
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TimeZone='UTC'");
    assert.equal((await c.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'on');
    assert.equal((await c.query('SELECT current_database() name')).rows[0].name, 'dynaminds');
    const names: string[] = (
      await c.query(`SELECT t.table_name
      FROM information_schema.tables t JOIN information_schema.columns k USING(table_schema,table_name)
      WHERE t.table_schema='public' AND t.table_type='BASE TABLE' AND k.column_name='tenant_id'
      AND t.table_name<>'sessions' UNION SELECT 'users' UNION SELECT 'tenants' ORDER BY 1`)
    ).rows.map((r) => r.table_name);
    for (const firm of firms) {
      for (const name of Object.keys(firm.checkpoint))
        assert(names.includes(name), 'Original table missing: ' + name);
      let empty = 0;
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
            'Original accepted rows changed: ' + name,
          );
        else {
          assert.equal(rows.length, 0, 'New module populated an accepted firm: ' + name);
          ++empty;
        }
      }
      counts.push({
        original_tables: Object.keys(firm.checkpoint).length,
        new_empty_tables: empty,
      });
    }
    await c.query('COMMIT');
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
  for (const [path, hash] of privateHashes) assert.equal(bytesHash(await privateBytes(path)), hash);
  if (phase === 'after') {
    const before = JSON.parse(
      await readFile('docs/b2b-return-local-origins-history-before.json', 'utf8'),
    );
    assert.equal(before.status, 'PASS');
    assert.equal(before.accepted127_checkpoint_sha256, original127);
    assert.equal(before.accepted128_checkpoint_sha256, original128);
    assert.deepEqual(before.private_fixture_sha256, Object.fromEntries(privateHashes));
    assert.deepEqual(
      before.firms.map((f: any) => f.original_tables),
      counts.map((f) => f.original_tables),
    );
  }
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        phase,
        status: 'PASS',
        revision: expected,
        schema_revision: health.schema_revision,
        accepted127_checkpoint_sha256: original127,
        accepted128_checkpoint_sha256: original128,
        firms: counts,
        private_fixture_sha256: Object.fromEntries(privateHashes),
        sessions_excluded: true,
        fixture_rewritten: false,
        original_baseline_rebased: false,
        full_goal_complete: false,
        scope:
          'Ten previously accepted firms; exact original tenant rows, empty new tables and seven original private files. No new workflow, browser, restart or restore acceptance.',
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
  process.stdout.write(
    JSON.stringify({
      phase,
      status: 'PASS',
      firms: firms.length,
      private_files: privateHashes.size,
      original_baseline_rebased: false,
    }) + '\n',
  );
} finally {
  await pool.end();
}
