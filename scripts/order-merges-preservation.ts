/** SELECT-only stage122 preservation. Original private checkpoints are never rewritten.
 * capture must run before103; check compares the very same earlier firms after105.
 * Sessions are excluded exactly as in the accepted121 business checkpoint policy. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pool } from '../server/db';

type Fingerprint = { count: number; sha256: string };
type Checkpoint = Record<string, Fingerprint>;
type Saved = {
  file: string;
  stage: number;
  tenant: string;
  user: string;
  expected: Checkpoint;
  privateSha: string;
};
const files = [
  'data/catalog-export-sources-stage116.json',
  'data/catalog-file-import-stage117.json',
  'data/replenishment-stage118.json',
  'data/replenishment-ack-stage118.json',
  'data/replenishment-forecast-stage119.json',
  'data/replenishment-append-stage120.json',
  'data/replenishment-automations-stage121.json',
] as const;
const mergeTables = [
  'order_merge_previews',
  'order_merge_preview_rows',
  'order_merge_executions',
  'order_merge_execution_rows',
  'order_merge_claims',
  'order_merge_origins',
  'order_merge_custody_transfers',
].sort();
const beforePath = 'docs/order-merges-preservation-before.json';
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bytesSha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

async function savedCheckpoints(): Promise<Saved[]> {
  const out: Saved[] = [];
  for (const file of files) {
    const stat = await lstat(file);
    assert(
      stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0,
      'Accepted state must be a private regular file: ' + file,
    );
    const bytes = await readFile(file);
    const s = JSON.parse(bytes.toString('utf8'));
    const expected: Checkpoint = file.includes('-ack-')
      ? s.final_business_checkpoint
      : s.accepted_checkpoint;
    assert(
      expected && typeof expected === 'object' && !Array.isArray(expected),
      'Missing original accepted checkpoint: ' + file,
    );
    assert(uuid.test(s.tenant) && uuid.test(s.user), 'Own identities required: ' + file);
    assert(!Object.hasOwn(expected, 'sessions'), 'Unexpected sessions checkpoint policy');
    for (const [name, value] of Object.entries(expected)) {
      assert(/^[a-z][a-z0-9_]*$/.test(name));
      assert(
        value &&
          Number.isSafeInteger(value.count) &&
          value.count >= 0 &&
          /^[a-f0-9]{64}$/.test(value.sha256),
        'Invalid accepted fingerprint: ' + file + ':' + name,
      );
    }
    if (s.stage === 121) {
      assert.equal(Object.keys(expected).length, 268);
      assert.equal(
        sha(expected),
        'eb69116d809d70241a9c46fc5a6a4ab93f988188a7b0205b4204599f56ffeb06',
      );
      assert.equal(s.restart_verified, true);
      assert.deepEqual(s.accepted_evidence.checkpoint, expected);
      assert.equal(sha(s.accepted_evidence), s.accepted_evidence_sha256);
    }
    out.push({
      file,
      stage: s.stage,
      tenant: s.tenant,
      user: s.user,
      expected,
      privateSha: bytesSha(bytes),
    });
  }
  assert.equal(
    new Set(out.map((s) => s.tenant)).size,
    files.length,
    'Seven distinct earlier firms',
  );
  return out;
}

/** Also reusable before backup/after cleanup; no top-level API, runtime or DB mutation. */
export async function verifyOrderMergesPreservation(mode: 'capture' | 'check') {
  assert(mode === 'capture' || mode === 'check');
  const saved = await savedCheckpoints();
  const earlier = mode === 'check' ? JSON.parse(await readFile(beforePath, 'utf8')) : null;
  if (earlier) {
    assert.equal(earlier.status, 'PASS');
    assert.equal(earlier.mode, 'capture');
    assert.equal(earlier.schema_revision, '102_replenishment_automations');
    assert.equal(earlier.checkpoints.length, files.length);
  }
  const c = await pool.connect();
  let report;
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    assert.equal(
      (await c.query("SELECT current_setting('transaction_read_only') v")).rows[0].v,
      'on',
    );
    const schema = (await c.query('SELECT name FROM migrations ORDER BY name DESC LIMIT 1')).rows[0]
      .name;
    assert.equal(
      schema,
      mode === 'capture' ? '102_replenishment_automations' : '105_order_merge_guards',
    );
    const tenantNames: string[] = (
      await c.query(`SELECT t.table_name FROM information_schema.tables t
        JOIN information_schema.columns k USING(table_schema,table_name)
        WHERE t.table_schema='public' AND t.table_type='BASE TABLE'
          AND k.column_name='tenant_id' AND t.table_name<>'sessions'
        ORDER BY t.table_name`)
    ).rows.map((r) => r.table_name);
    const names = [...tenantNames, 'tenants', 'users'];
    assert.equal(new Set(names).size, names.length);
    if (earlier)
      assert.deepEqual(
        names.filter((n) => !mergeTables.includes(n)).sort(),
        [...earlier.table_names].sort(),
        'Only the seven explicit additive merge tables may change the table scope',
      );
    else assert(!mergeTables.some((n) => names.includes(n)), 'Capture before merge schema only');

    const current = new Map(saved.map((s) => [s.file, {} as Checkpoint]));
    for (const name of names) {
      assert(/^[a-z][a-z0-9_]*$/.test(name));
      const identity = name === 'users' || name === 'tenants' ? 'id' : 'tenant_id';
      const ids = saved.map((s) => (name === 'users' ? s.user : s.tenant));
      const rows: { row: Record<string, unknown> }[] = (
        await c.query(
          `SELECT to_jsonb(t) row FROM "${name}" t WHERE ${identity}=ANY($1::uuid[]) ORDER BY 1`,
          [ids],
        )
      ).rows;
      for (const s of saved) {
        const id = name === 'users' ? s.user : s.tenant;
        const scoped = rows.filter((r) => r.row[identity] === id);
        current.get(s.file)![name] = { count: scoped.length, sha256: sha(scoped) };
        if (mode === 'check' && mergeTables.includes(name))
          assert.equal(
            scoped.length,
            0,
            'New merge evidence must not touch an earlier firm: ' + name,
          );
      }
    }
    const checkpoints = saved.map((s) => {
      const captured = current.get(s.file)!;
      for (const [name, expected] of Object.entries(s.expected))
        assert.deepEqual(
          captured[name],
          expected,
          'Original accepted checkpoint changed: ' + s.file + ':' + name,
        );
      if (earlier) {
        const prior = earlier.checkpoints.find((p: { file: string }) => p.file === s.file);
        assert(prior, 'Original capture entry required');
        assert.equal(
          prior.private_state_sha256,
          s.privateSha,
          'Accepted private state bytes changed',
        );
        assert.equal(prior.checkpoint_sha256, sha(s.expected), 'Accepted baseline replaced');
        assert.equal(prior.tenant_id, s.tenant);
        assert.equal(prior.user_id, s.user);
        assert.deepEqual(
          Object.fromEntries(Object.entries(captured).filter(([n]) => !mergeTables.includes(n))),
          prior.captured,
          'All pre-migration captured business rows remain exact: ' + s.file,
        );
      }
      return {
        file: s.file,
        stage: s.stage,
        tenant_id: s.tenant,
        user_id: s.user,
        accepted_tables: Object.keys(s.expected).length,
        checkpoint_sha256: sha(s.expected),
        private_state_sha256: s.privateSha,
        accepted_exact: true,
        captured,
      };
    });
    for (const s of saved)
      assert.equal(
        bytesSha(await readFile(s.file)),
        s.privateSha,
        'Accepted state changed during observation',
      );
    await c.query('COMMIT');
    report = {
      status: 'PASS',
      mode,
      schema_revision: schema,
      observed_at: new Date().toISOString(),
      previous_firms: saved.length,
      original_tables_verified_per_firm:
        mode === 'check' ? earlier.table_names.length : names.length,
      table_names: names.filter((n) => !mergeTables.includes(n)),
      checkpoints,
      new_merge_tables_empty_for_previous_firms: mode === 'check' ? mergeTables : null,
      sessions_excluded_by_original_business_checkpoint_policy: true,
      normalization: 'NONE; 103–105 add tables/constraints/triggers but no earlier row columns',
      baseline_rebased: false,
      scope:
        'Seven accepted own QA firms116–121, exact original checkpoints plus all business-table rows captured before122; not all historic firms or all databases',
      full_goal_complete: false,
    };
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const mode = process.argv[2];
    assert(mode === 'capture' || mode === 'check', 'Use capture or check');
    const milestone = process.argv[3];
    const outputs: Record<string, string> = {
      migration: 'docs/order-merges-preservation-after.json',
      ui: 'docs/order-merges-preservation-after-ui.json',
      restart: 'docs/order-merges-preservation-after-restart.json',
      recovery: 'docs/order-merges-preservation-after-recovery.json',
    };
    assert(
      mode === 'capture' ? !milestone : !milestone || Object.hasOwn(outputs, milestone),
      'Use an explicit check milestone: migration, ui, restart or recovery',
    );
    const report = await verifyOrderMergesPreservation(mode);
    await writeFile(
      mode === 'capture' ? beforePath : outputs[milestone ?? 'migration'],
      JSON.stringify(report, null, 2) + '\n',
      { flag: 'wx' },
    );
    console.log(
      JSON.stringify({
        status: report.status,
        mode,
        previous_firms: report.previous_firms,
        original_tables_verified_per_firm: report.original_tables_verified_per_firm,
        accepted_tables: report.checkpoints.map((p) => p.accepted_tables),
        baseline_rebased: false,
      }),
    );
  } finally {
    await pool.end();
  }
}
