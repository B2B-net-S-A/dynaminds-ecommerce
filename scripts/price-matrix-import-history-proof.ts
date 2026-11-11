/** Read-only preservation for migration114. Compares original accepted checkpoints,
 * never refreshes or rewrites those baselines. Sessions are excluded explicitly. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pool } from '../server/db';

type Mark = { count: number; sha256: string };
type Firm = { tenant: string; user: string; checkpoint: Record<string, Mark> };
const phase = process.argv[2];
assert(phase === 'before' || phase === 'after');
const root = resolve(process.env.QA_HISTORY_ROOT ?? '.');
const report = process.env.QA_REPORT_FILE ?? `docs/price-matrix-import-history-${phase}.json`;
assert.match(report, /^docs\/price-matrix-import-history-[a-z0-9-]+\.json$/);
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const bytesHash = (v: Buffer) => createHash('sha256').update(v).digest('hex');
const originals = new Map<string, Buffer>();
async function privateFile(path: string) {
  assert.match(path, /^data\/[a-z0-9-]+\.json$/);
  const full = resolve(root, path),
    st = await lstat(full);
  assert(st.isFile() && !st.isSymbolicLink() && (st.mode & 0o777) === 0o600);
  assert(st.size <= 32 * 1024 * 1024);
  const bytes = await readFile(full);
  originals.set(path, bytes);
  return JSON.parse(bytes.toString('utf8'));
}
async function publicFile(path: string) {
  return JSON.parse(await readFile(resolve(root, path), 'utf8'));
}
try {
  assert.notEqual(process.env.DYNA_TEST, 'true');
  const expected = process.env.QA_EXPECTED_REVISION;
  assert.match(expected ?? '', /^[a-f0-9]{40}$/);
  const old127 = await privateFile('data/source-order-intent-stage127b.json');
  assert.equal(
    digest(old127.accepted_checkpoint),
    '904d7b3f02c976630e8089e4978a9eb52d2cd8bf3f684751350841f8ed29070a',
  );
  assert.equal(old127.previous.length, 6);
  const firms: Firm[] = [...old127.previous];
  for (const prior of old127.previous) {
    await privateFile(prior.path);
    assert.equal(bytesHash(originals.get(prior.path)!), prior.fixture_sha256);
  }
  for (const side of ['buyer', 'supplier'] as const)
    firms.push({ ...old127[side], checkpoint: old127.accepted_checkpoint[side] });
  const old128Setup = await privateFile('data/b2b-dropshipping-returns-stage128.json');
  const old128 = await privateFile('data/b2b-dropshipping-returns-stage128-chrome-checkpoint.json');
  const proof128 = await publicFile('docs/b2b-dropshipping-returns-native-chrome-qa.json');
  assert.equal(proof128.status, 'PASS');
  assert.equal(
    proof128.checkpoint_sha256,
    'a8d72c234e8c39fa5d86e8a409676901a0355439a63dc67f0998cd91bfba10f8',
  );
  assert.equal(digest(old128.checkpoint), proof128.checkpoint_sha256);
  assert.equal(
    bytesHash(originals.get('data/b2b-dropshipping-returns-stage128.json')!),
    proof128.setup.sha256,
  );
  for (const side of ['buyer', 'supplier'] as const) {
    assert.equal(old128[side].tenant, old128Setup[side].tenant);
    assert.equal(old128[side].user, old128Setup[side].user);
    firms.push({ ...old128[side], checkpoint: old128.checkpoint[side] });
  }
  const setup129Path = 'data/b2b-return-local-origins-stage129.json';
  const checkpoint129Path = 'data/b2b-return-local-origins-stage129-chrome-checkpoint.json';
  const setup129 = await privateFile(setup129Path),
    accepted129 = await privateFile(checkpoint129Path);
  assert.equal(
    bytesHash(originals.get(setup129Path)!),
    '75c7dccae36af941494ff3cde8a8ac95934b5953f67b0e4007a8c858186edcea',
  );
  assert.equal(
    bytesHash(originals.get(checkpoint129Path)!),
    'f99aa3bbd4f1ef7821dc5f2fc26da115423fb197afb8ad7ad82c33e37a190251',
  );
  assert.equal(
    digest(accepted129.checkpoint),
    'cdbcc5183d44396975510f55ce93d8b53b7e855aa2115c002d867f1d5f8d5037',
  );
  assert.equal(accepted129.stage, 129);
  assert.equal(accepted129.chrome_verified, true);
  assert.equal(accepted129.chrome_human_attested, true);
  for (const side of ['buyer', 'supplier'] as const) {
    assert.deepEqual(accepted129[side], {
      tenant: setup129[side].tenant,
      user: setup129[side].user,
    });
    firms.push({ ...accepted129[side], checkpoint: accepted129.checkpoint[side] });
  }
  const setup130Path = 'data/price-file-import-stage130.json';
  const accepted130Path = 'data/price-file-import-stage130-chrome-checkpoint.json';
  const setup130 = await privateFile(setup130Path),
    accepted130 = await privateFile(accepted130Path);
  assert.equal(setup130.setup_complete, true);
  assert.equal(setup130.pending, null);
  assert.equal(
    bytesHash(originals.get(setup130Path)!),
    '266de72cb1f34238a26a19e889fbf72e88e5de5c740ea3b58f412df5db4be85e',
  );
  assert.equal(accepted130.status, 'PASS');
  assert.equal(accepted130.setup_sha256, bytesHash(originals.get(setup130Path)!));
  assert.equal(
    bytesHash(originals.get(accepted130Path)!),
    '7593dd26968b6fd39c02ca7fa383d6bc22bcccc78fb57e06058ea9745ceffd19',
  );
  assert.equal(Object.keys(accepted130.snapshot).length, 310);
  firms.push({ tenant: setup130.tenant, user: setup130.user, checkpoint: accepted130.snapshot });
  assert.equal(firms.length, 13);
  assert.equal(new Set(firms.map((f) => f.tenant)).size, 13);
  const response = await fetch('http://127.0.0.1:4100/api/health', {
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
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
    phase === 'before' ? '113_price_file_imports' : '114_price_matrix_imports',
  );
  assert.equal(health.price_file_import_available, true);
  if (phase === 'after') assert.equal(health.price_matrix_import_available, true);
  const c = await pool.connect();
  const counts: Array<{ original_tables: number; new_empty_tables: number }> = [];
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TimeZone='UTC'");
    assert.equal((await c.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'on');
    assert.equal((await c.query('SELECT current_database() name')).rows[0].name, 'dynaminds');
    const names: string[] = (
      await c.query(`SELECT t.table_name FROM information_schema.tables t
      JOIN information_schema.columns k USING(table_schema,table_name)
      WHERE t.table_schema='public' AND t.table_type='BASE TABLE' AND k.column_name='tenant_id'
      AND t.table_name<>'sessions' UNION SELECT 'users' UNION SELECT 'tenants' ORDER BY 1`)
    ).rows.map((r) => r.table_name);
    for (const firm of firms) {
      for (const table of Object.keys(firm.checkpoint))
        assert(names.includes(table), 'Missing accepted table: ' + table);
      let empty = 0;
      for (const table of names) {
        assert.match(table, /^[a-z_][a-z0-9_]*$/);
        const key = ['users', 'tenants'].includes(table) ? 'id' : 'tenant_id';
        const rows = (
          await c.query(`SELECT to_jsonb(t) row FROM "${table}" t WHERE ${key}=$1 ORDER BY 1`, [
            table === 'users' ? firm.user : firm.tenant,
          ])
        ).rows;
        if (Object.hasOwn(firm.checkpoint, table))
          assert.deepEqual(
            { count: rows.length, sha256: digest(rows) },
            firm.checkpoint[table],
            'Accepted data changed: ' + table,
          );
        else {
          assert.equal(rows.length, 0, 'Unexpected rows in accepted firm: ' + table);
          empty++;
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
  const privateHashes = Object.fromEntries(
    [...originals].map(([path, bytes]) => [path, bytesHash(bytes)]),
  );
  for (const [path, bytes] of originals)
    assert.deepEqual(await readFile(resolve(root, path)), bytes);
  if (phase === 'after') {
    const before = JSON.parse(
      await readFile('docs/price-matrix-import-history-before.json', 'utf8'),
    );
    assert.equal(before.status, 'PASS');
    assert.deepEqual(before.private_fixture_sha256, privateHashes);
    assert.deepEqual(
      before.firms.map((f: any) => f.original_tables),
      counts.map((f) => f.original_tables),
    );
  }
  await writeFile(
    report,
    JSON.stringify(
      {
        phase,
        status: 'PASS',
        revision: expected,
        schema_revision: health.schema_revision,
        firms: counts,
        private_fixture_sha256: privateHashes,
        sessions_excluded: true,
        fixture_rewritten: false,
        original_baseline_rebased: false,
        full_goal_complete: false,
        scope:
          'Thirteen previously accepted firms including the exact CSV/XML130 Chrome checkpoint: exact original rows and private bytes, new tables empty. Read-only preservation; no new matrix UI acceptance.',
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
  process.stdout.write(
    JSON.stringify({ status: 'PASS', phase, firms: firms.length, private_files: originals.size }) +
      '\n',
  );
} finally {
  await pool.end();
}
