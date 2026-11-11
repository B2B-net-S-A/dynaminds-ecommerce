/** Operator-only122 encrypted restore. Authoring does not execute this proof.
 * The accepted state and earlier checkpoint files are read, never rewritten. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { pool } from '../server/db';
import {
  createBackup,
  restoreBackup,
  localDatabase,
  restoreDatabaseName,
  tableFingerprints,
  schemaFingerprint,
} from '../server/recovery';
import { verifyOrderMergesPreservation } from './order-merges-preservation';

type Json = Record<string, any>;
type Client = pg.Client | pg.PoolClient;
const revision = process.env.QA_EXPECTED_REVISION;
assert(revision && /^[a-f0-9]{7,40}$/.test(revision), 'QA_EXPECTED_REVISION required');
const schema = '105_order_merge_guards';
const statePath = 'data/order-merges-stage122.json';
const reportPath = 'docs/order-merges-recovery-qa.json';
const port = 4162;
const url = `http://127.0.0.1:${port}/api`;
const source = localDatabase();
const admin = new pg.Client({ ...source, database: 'postgres' });
const tables = [
  'order_merge_previews',
  'order_merge_preview_rows',
  'order_merge_executions',
  'order_merge_execution_rows',
  'order_merge_claims',
  'order_merge_origins',
  'order_merge_custody_transfers',
];
const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const byteSha = (v: Buffer | string) => createHash('sha256').update(v).digest('hex');
const json = (v: unknown): any => JSON.parse(JSON.stringify(v));
const identifier = (s: string) => {
  assert(/^[a-z][a-z0-9_]*$/.test(s));
  return '"' + s + '"';
};
const stageStat = await lstat(statePath);
assert(stageStat.isFile() && !stageStat.isSymbolicLink() && (stageStat.mode & 0o077) === 0);
const stateBytes = await readFile(statePath);
const s: Json = JSON.parse(stateBytes.toString('utf8'));
assert(
  s.stage === 122 && s.setup_complete && !s.pending && s.readback_verified && s.restart_verified,
  'Actual accepted readback and restart required before recovery',
);
assert(/^[a-f0-9]{7,40}$/.test(s.runtime_revision), 'Original setup revision required');
assert.equal(s.restart_revision, revision, 'Actual verified restart revision differs');
assert.equal(s.schema_revision, schema);
assert.equal(s.own_snapshot_timezone, 'UTC');
assert(s.accepted_checkpoint && s.evidence && s.original_payment_entries);
assert.equal(sha(s.evidence), s.accepted_evidence_sha256);
const expected: Json = s.fulfilment_verified ? s.fulfilment_checkpoint : s.accepted_checkpoint;
assert(
  expected && (!s.fulfilment_verified || s.fulfilment_evidence),
  'Accepted final checkpoint required',
);
const captureBytes = await readFile('docs/order-merges-preservation-before.json');
const capture: Json = JSON.parse(captureBytes.toString('utf8'));
assert(capture.status === 'PASS' && capture.checkpoints.length === 7 && capture.mode === 'capture');
let owned: string | undefined,
  ownedDirectory: string | undefined,
  copied: pg.Client | undefined,
  child: ReturnType<typeof spawn> | undefined;
let prior: string[] = [],
  phase = 'prerequisites',
  copyLog = '',
  adminConnected = false;
let report: Json = {
  status: 'PENDING',
  source_revision: revision,
  source_runtime_revision: revision,
  original_setup_revision: s.runtime_revision,
  full_goal_complete: false,
};

async function readonly<T>(c: Client, fn: () => Promise<T>) {
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    assert.equal(
      (await c.query("SELECT current_setting('transaction_read_only') v")).rows[0].v,
      'on',
    );
    const result = await fn();
    await c.query('COMMIT');
    return result;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  }
}
async function ownCheckpoint(c: Client) {
  return readonly(c, async () => {
    const actual: Json = {};
    const currentNames: string[] = (
      await c.query(`SELECT t.table_name
      FROM information_schema.tables t JOIN information_schema.columns k USING(table_schema,table_name)
      WHERE t.table_schema='public' AND t.table_type='BASE TABLE'
      AND k.column_name='tenant_id' AND t.table_name<>'sessions' ORDER BY t.table_name`)
    ).rows.map((r) => r.table_name);
    assert.deepEqual(
      [...currentNames, 'tenants', 'users'].sort(),
      Object.keys(expected).sort(),
      'The full accepted own business-table scope must match',
    );
    for (const name of Object.keys(expected).sort()) {
      const identity = name === 'tenants' || name === 'users' ? 'id' : 'tenant_id';
      const rows: Json[] = (
        await c.query(
          `SELECT to_jsonb(t) row FROM ${identifier(name)} t WHERE ${identity}=$1 ORDER BY 1`,
          [name === 'users' ? s.user : s.tenant],
        )
      ).rows;
      // Native122 hashes bare business rows, but identity tables retain the row wrapper.
      const data = identity === 'id' ? rows : rows.map((r) => r.row);
      actual[name] = { count: rows.length, sha256: sha(data) };
    }
    assert.deepEqual(actual, expected, 'Accepted own122 rows changed');
    assert.equal(
      (await c.query('SELECT name FROM migrations ORDER BY name DESC LIMIT 1')).rows[0].name,
      schema,
    );
    const member = (
      await c.query('SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2', [
        s.tenant,
        s.user,
      ])
    ).rows;
    assert.deepEqual(member, [{ role: 'admin' }]);
    assert.equal(
      (await c.query('SELECT name FROM tenants WHERE id=$1', [s.tenant])).rows[0].name,
      s.organization_name,
    );
    return actual;
  });
}
async function earlierCopy(c: Client) {
  return readonly(c, async () => {
    for (const p of capture.checkpoints) {
      const bytes = await readFile(p.file);
      assert.equal(byteSha(bytes), p.private_state_sha256, 'Earlier private state replaced');
      const old = JSON.parse(bytes.toString('utf8'));
      const accepted = p.file.includes('-ack-')
        ? old.final_business_checkpoint
        : old.accepted_checkpoint;
      assert.equal(sha(accepted), p.checkpoint_sha256);
      assert.equal(old.tenant, p.tenant_id);
      assert.equal(old.user, p.user_id);
      for (const [name, fingerprint] of Object.entries(p.captured)) {
        const identity = name === 'tenants' || name === 'users' ? 'id' : 'tenant_id';
        const rows = (
          await c.query(
            `SELECT to_jsonb(t) row FROM ${identifier(name)} t WHERE ${identity}=$1 ORDER BY 1`,
            [name === 'users' ? old.user : old.tenant],
          )
        ).rows;
        assert.deepEqual(
          { count: rows.length, sha256: sha(rows) },
          fingerprint,
          'Earlier copy rows differ: ' + p.stage + ':' + name,
        );
      }
      for (const name of tables)
        assert.equal(
          (
            await c.query(`SELECT count(*)::int n FROM ${identifier(name)} WHERE tenant_id=$1`, [
              old.tenant,
            ])
          ).rows[0].n,
          0,
        );
    }
    return {
      firms: 7,
      accepted_and_pre_migration_business_rows_exact: true,
      captured_tables_per_firm: capture.table_names.length,
      sessions_policy: 'Original business checkpoints exclude sessions',
    };
  });
}
async function sourceExact() {
  const c = await pool.connect();
  try {
    await ownCheckpoint(c);
  } finally {
    c.release();
  }
  const preservation = await verifyOrderMergesPreservation('check');
  assert.equal(preservation.status, 'PASS');
  assert.equal(
    byteSha(await readFile(statePath)),
    byteSha(stateBytes),
    'Accepted122 state bytes changed',
  );
  assert.equal(
    byteSha(await readFile('docs/order-merges-preservation-before.json')),
    byteSha(captureBytes),
  );
  return preservation;
}
async function frozenCustodyRows(c: Client): Promise<Json[]> {
  return readonly(c, async () => {
    const rows: Json[] = (
      await c.query(
        'SELECT to_jsonb(t) row FROM order_merge_custody_transfers t WHERE tenant_id=$1 ORDER BY 1',
        [s.tenant],
      )
    ).rows.map((r) => r.row);
    assert.deepEqual(
      { count: rows.length, sha256: sha(rows) },
      expected.order_merge_custody_transfers,
      'Full frozen custody rows must match the accepted checkpoint',
    );
    for (const proof of rows) {
      for (const key of ['stock', 'bins', 'positions'])
        assert(Array.isArray(proof.before_snapshot[key]), 'Physical before proof: ' + key);
      assert.deepEqual(
        Object.keys(proof.after_snapshot).sort(),
        ['layers', 'locations', 'reservations'],
        'Planned custody after proof contains only transferred reservations',
      );
    }
    return rows;
  });
}
async function call(
  path: string,
  cookie = '',
  method = 'GET',
  body?: string,
  workspace = s.tenant,
) {
  return fetch(url + path, {
    method,
    signal: AbortSignal.timeout(15000),
    headers: {
      ...(cookie ? { cookie, 'X-Workspace-ID': workspace } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body } : {}),
  });
}
async function get(path: string, cookie: string) {
  const response = await call(path, cookie);
  assert.equal(response.status, 200, 'Copy GET ' + path);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const value: Json = await response.json();
  assert(value.read_only === true && value.can_preview === false && value.can_execute === false);
  return value;
}
async function pages(path: string, cookie: string, limit = 100) {
  const out: Json[] = [],
    seen = new Set<string>();
  let cursor: string | null = null,
    total: number | undefined;
  do {
    const body = await get(
      path + '?limit=' + limit + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
      cookie,
    );
    assert(Array.isArray(body.data) && body.data.length <= limit);
    assert(Number.isInteger(body.meta.total) && body.meta.total <= 10000);
    total ??= body.meta.total;
    assert.equal(body.meta.total, total);
    out.push(...body.data);
    cursor = body.meta.cursor;
    if (cursor) {
      assert(!seen.has(cursor));
      seen.add(cursor);
    }
  } while (cursor);
  assert.equal(out.length, total);
  return out;
}
function publicHead(h: Json) {
  const keys = [
    'id',
    'preview_id',
    'merge_mode',
    'main_order_id',
    'target_order_id',
    'source_count',
    'total',
    'sum_delivery_costs',
    'total_minor',
    'shipping_cost',
    'target_status',
    'payment_balance',
    'receiver_conflict',
    'physical_count',
    'physical_quantity',
    'physical_scanned',
    'scope_hash',
    'ready',
    'conflicts',
    'state',
    'created_at',
    'expires_at',
  ];
  const out = Object.fromEntries(keys.filter((k) => h[k] !== undefined).map((k) => [k, h[k]]));
  const main = (h.snapshot ?? h.before_snapshot).orders.find((o: Json) => o.id === h.main_order_id);
  return json({ ...out, currency: main.currency, payment_mode: main.payment_mode });
}
function sourceProjection(o: Json, snapshot: Json) {
  const keys = [
    'id',
    'number',
    'status',
    'version',
    'customer_name',
    'email',
    'address',
    'currency',
    'warehouse_id',
    'payment_mode',
    'total',
    'shipping_cost',
    'source',
    'channel_id',
    'external_id',
    'tags',
    'note',
  ];
  const picks = snapshot.picks.filter((p: Json) => p.order_id === o.id);
  return json({
    ...Object.fromEntries(keys.map((k) => [k, o[k]])),
    payment_balance:
      snapshot.payments.orders.find((p: Json) => p.order_id === o.id)?.balance ?? null,
    physical_quantity: picks.reduce((n: number, p: Json) => n + p.quantity, 0),
    physical_scanned: picks.reduce((n: number, p: Json) => n + p.scanned, 0),
  });
}
async function rolledBackProbe(c: pg.Client, fn: () => Promise<void>, code: string) {
  await c.query('BEGIN');
  try {
    await assert.rejects(fn, (e: any) => e.code === code);
  } finally {
    await c.query('ROLLBACK');
  }
}

try {
  await admin.connect();
  adminConnected = true;
  prior = (await admin.query('SELECT datname FROM pg_database ORDER BY datname')).rows.map(
    (r) => r.datname,
  );
  const probe = createServer();
  await new Promise<void>((done, fail) => {
    probe.once('error', fail);
    probe.listen(port, '127.0.0.1', done);
  });
  await new Promise<void>((done) => probe.close(() => done()));
  const sourceResponse = await fetch('http://127.0.0.1:4100/api/health', {
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(sourceResponse.status, 200);
  const sourceHealth: Json = await sourceResponse.json();
  assert(
    sourceHealth.revision === revision &&
      sourceHealth.schema_revision === schema &&
      !sourceHealth.restore_preview &&
      sourceHealth.order_merges_available,
  );
  const sourcePreservationBefore = await sourceExact();
  const sourceProofClient = await pool.connect();
  let sourceCustodyProofs: Json[];
  try {
    sourceCustodyProofs = await frozenCustodyRows(sourceProofClient);
  } finally {
    sourceProofClient.release();
  }

  phase = 'encrypted backup and exact isolated restore';
  const backup = await createBackup();
  assert.equal(backup.encryption, 'AES-256-GCM');
  await sourceExact();
  const restored = await restoreBackup(backup.file);
  owned = restoreDatabaseName(restored.database);
  assert(!prior.includes(owned) && owned !== source.database, 'Only a fresh owned copy');
  ownedDirectory = resolve(restored.directory);
  assert.equal(ownedDirectory, resolve('data/restores', restored.id));
  assert.equal(owned, 'dynaminds_restore_' + restored.id);
  assert(
    restored.row_fingerprints_match &&
      restored.schema_fingerprint_match &&
      restored.preview_only &&
      restored.worker_enabled === false &&
      restored.status === 'verified',
  );
  const restoredStat = await lstat(ownedDirectory);
  assert(
    restoredStat.isDirectory() &&
      !restoredStat.isSymbolicLink() &&
      (restoredStat.mode & 0o077) === 0,
  );
  const manifest: Json = JSON.parse(
    await readFile(resolve(ownedDirectory, 'manifest.json'), 'utf8'),
  );
  assert.equal(manifest.schema_fingerprint_version, 4);
  copied = new pg.Client({ ...source, database: owned });
  await copied.connect();
  // A fresh preview Pool has this same connection default. Preserve it for SQL
  // JSON HTTP projections; immutable checkpoint/manifest reads remain in UTC.
  const copyApiTimezone = (await copied.query("SELECT current_setting('TimeZone') AS timezone"))
    .rows[0].timezone as string;
  assert(copyApiTimezone && typeof copyApiTimezone === 'string');
  await copied.query("SET TIME ZONE 'UTC'");
  assert.deepEqual(
    await tableFingerprints(copied),
    manifest.tables,
    'Full manifest rows before preview',
  );
  assert.equal(
    await schemaFingerprint(copied),
    manifest.schema_sha256,
    'Full schema/RLS/ACL match',
  );
  await ownCheckpoint(copied);
  const previousCopy = await earlierCopy(copied);

  phase = 'copy scope and immutable proof guards';
  const acls = (
    await copied.query(
      `SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,
    has_table_privilege('dyna_app',c.oid,'SELECT') app_select,
    has_table_privilege('dyna_app',c.oid,'INSERT') app_insert,
    has_table_privilege('dyna_app',c.oid,'UPDATE') app_update,
    has_table_privilege('dyna_app',c.oid,'DELETE') app_delete
    FROM pg_class c WHERE c.oid=ANY($1::regclass[]) ORDER BY c.relname`,
      [tables],
    )
  ).rows;
  assert.equal(acls.length, 7);
  for (const acl of acls) {
    assert(acl.relrowsecurity && acl.relforcerowsecurity && acl.app_select);
    assert(!acl.app_update && !acl.app_delete);
    assert.equal(acl.app_insert, acl.relname !== 'order_merge_custody_transfers');
  }
  const foreignFks = (
    await copied.query(
      `SELECT c.conrelid::regclass::text AS table_name,
    pg_get_constraintdef(c.oid) definition,c.convalidated FROM pg_constraint c
    WHERE c.contype='f' AND c.conrelid=ANY($1::regclass[]) ORDER BY 1,2`,
      [tables],
    )
  ).rows;
  for (const name of tables)
    assert(
      foreignFks.some(
        (f) =>
          f.table_name === name &&
          f.convalidated &&
          f.definition.startsWith('FOREIGN KEY (tenant_id,'),
      ),
      'Genuine validated tenant-composite FK: ' + name,
    );
  for (const name of tables)
    await rolledBackProbe(
      copied,
      () =>
        copied!
          .query(`UPDATE ${identifier(name)} SET byte_count=byte_count WHERE tenant_id=$1`, [
            s.tenant,
          ])
          .then(() => {}),
      '23514',
    );
  await copied.query('BEGIN');
  try {
    await copied.query('SET LOCAL ROLE dyna_app');
    await copied.query("SELECT set_config('app.tenant_id',$1,true)", [
      capture.checkpoints[0].tenant_id,
    ]);
    for (const name of tables)
      assert.equal(
        (
          await copied.query(`SELECT count(*)::int n FROM ${identifier(name)} WHERE tenant_id=$1`, [
            s.tenant,
          ])
        ).rows[0].n,
        0,
      );
  } finally {
    await copied.query('ROLLBACK');
  }
  await rolledBackProbe(
    copied,
    async () => {
      await copied!.query('SET LOCAL ROLE dyna_app');
      await copied!.query("SELECT set_config('app.tenant_id',$1,true)", [
        capture.checkpoints[0].tenant_id,
      ]);
      await copied!.query('SELECT order_merge_transfer_custody($1)', [
        s.evidence.main_execution_id,
      ]);
    },
    '23514',
  );
  await ownCheckpoint(copied);

  const originalEntries = (
    await copied.query(
      'SELECT to_jsonb(t) row FROM payment_entries t WHERE tenant_id=$1 ORDER BY 1',
      [s.tenant],
    )
  ).rows.map((r) => r.row);
  for (const entry of s.original_payment_entries)
    assert.deepEqual(
      originalEntries.find((p) => p.id === entry.id),
      entry,
      'Original payment entry remains on its original order',
    );
  const executions: Json[] = (
    await copied.query('SELECT * FROM order_merge_executions WHERE tenant_id=$1 ORDER BY id', [
      s.tenant,
    ])
  ).rows;
  const previews: Json[] = (
    await copied.query('SELECT * FROM order_merge_previews WHERE tenant_id=$1 ORDER BY id', [
      s.tenant,
    ])
  ).rows;
  assert.equal(executions.length, 2);
  assert.equal(
    previews.length,
    expected.order_merge_previews.count,
    'Every preview in the exact accepted checkpoint is retained, including unused previews',
  );
  assert.deepEqual(executions.map((e) => e.merge_mode).sort(), [
    'into_main_order',
    'technical_merge',
  ]);
  const claims: Json[] = (
    await copied.query(
      'SELECT source_order_id,target_order_id,execution_id,merge_mode FROM order_merge_claims WHERE tenant_id=$1 ORDER BY source_order_id',
      [s.tenant],
    )
  ).rows;
  assert.equal(claims.length, 3);
  const custody: Json[] = (
    await copied.query(
      'SELECT * FROM order_merge_custody_transfers WHERE tenant_id=$1 ORDER BY execution_id',
      [s.tenant],
    )
  ).rows;
  assert.equal(custody.length, 2);
  assert.deepEqual(
    await frozenCustodyRows(copied),
    sourceCustodyProofs,
    'Every immutable custody field, including historical physical before rows, matches source backup',
  );
  // JSONB retains its original timestamp representation. Compare source
  // business records using PostgreSQL's actual types (including full timestamp
  // precision), without rewriting/normalizing any persisted JSON or checkpoint.
  assert(Array.isArray(s.original_orders) && s.original_orders.length === 4);
  for (const original of s.original_orders) {
    const typedOrigin: { header_exact: boolean; items_exact: boolean }[] = (
      await copied.query(
        `SELECT
        to_jsonb(jsonb_populate_record(NULL::orders,o.header)) IS NOT DISTINCT FROM
        to_jsonb(jsonb_populate_record(NULL::orders,$3::jsonb)) AS header_exact,
        (SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id)
          FROM jsonb_populate_recordset(NULL::order_items,o.items) i) IS NOT DISTINCT FROM
        (SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id)
          FROM jsonb_populate_recordset(NULL::order_items,$4::jsonb) i) AS items_exact
        FROM order_merge_origins o WHERE o.tenant_id=$1 AND o.order_id=$2`,
        [
          s.tenant,
          original.id,
          JSON.stringify(original),
          JSON.stringify(s.original_items.filter((i: Json) => i.order_id === original.id)),
        ],
      )
    ).rows;
    assert.deepEqual(
      typedOrigin,
      [{ header_exact: true, items_exact: true }],
      'Original typed header/items retain the exact business values and timestamp instants',
    );
  }
  for (const e of executions) {
    const proof = custody.find((p) => p.execution_id === e.id);
    assert(
      proof &&
        proof.actor_id === e.actor_id &&
        proof.target_order_id === e.target_order_id &&
        proof.merge_mode === e.merge_mode,
    );
    assert.deepEqual(proof.source_ids, e.source_ids);
    assert.deepEqual(proof.before_snapshot, e.before_snapshot.custody);
    // after_snapshot is the planned reservation transfer, not a physical
    // after-image. Actual later dispatch/return stock is covered by the full
    // accepted fulfilment checkpoint; it must not equal historical merge stock.
  }
  const beforeHttp = await tableFingerprints(copied);
  const sessionsBefore = (
    await copied.query('SELECT to_jsonb(t) row FROM sessions t ORDER BY token_hash')
  ).rows;
  phase = 'isolated read-only HTTP';
  child = spawn(
    process.execPath,
    [
      'node_modules/tsx/dist/cli.mjs',
      'scripts/restore-preview.ts',
      '--result',
      resolve(ownedDirectory, 'result.json'),
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, DYNA_PREVIEW_PORT: String(port), APP_REVISION: revision },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout?.on('data', (b) => (copyLog += b.toString()));
  child.stderr?.on('data', (b) => (copyLog += b.toString()));
  let health: Json | undefined;
  for (let i = 0; i < 100; i++) {
    assert(child.exitCode === null && child.signalCode === null, 'Owned preview process exited');
    try {
      const r = await call('/health');
      if (r.ok) {
        health = await r.json();
        break;
      }
    } catch {}
    await delay(100);
  }
  assert(
    health?.restore_preview &&
      health.revision === revision &&
      health.schema_revision === schema &&
      health.order_merges_available,
  );
  assert.equal(
    (await call('/order-merges/options', s.cookie)).status,
    401,
    'Original cookie cannot authorize copy',
  );
  const login = await call(
    '/auth/login',
    '',
    'POST',
    JSON.stringify({ email: s.email, password: s.password }),
  );
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert(cookie);
  assert.equal(
    (
      await call(
        '/order-merges/options',
        cookie,
        'GET',
        undefined,
        capture.checkpoints[0].tenant_id,
      )
    ).status,
    409,
    'Own copy login cannot switch to an earlier foreign workspace',
  );
  const options = await get('/order-merges/options', cookie);
  assert(options.available && options.current_role === 'admin');
  const readbacks: Json[] = [{ kind: 'options', status: 200 }];
  for (const [kind, heads] of [
    ['preview', previews],
    ['execution', executions],
  ] as const) {
    for (const h of heads) {
      const path = '/order-merges/' + (kind === 'preview' ? 'previews/' : 'executions/') + h.id;
      const body = await get(path, cookie);
      assert.deepEqual(body[kind], publicHead(h));
      const rows: Json[] = (
        await copied.query(
          `SELECT row${kind === 'execution' ? ',target_item_id' : ''}
        FROM order_merge_${kind}_rows WHERE tenant_id=$1 AND ${kind}_id=$2 ORDER BY index`,
          [s.tenant, h.id],
        )
      ).rows.map((r) => ({
        ...r.row,
        ...(r.target_item_id ? { target_item_id: r.target_item_id } : {}),
      }));
      assert.deepEqual(await pages(path + '/rows', cookie), rows);
      const snapshot = h.snapshot ?? h.before_snapshot;
      assert.deepEqual(
        await pages(path + '/sources', cookie),
        snapshot.orders.map((o: Json) => sourceProjection(o, snapshot)),
      );
      const physical = (
        snapshot.custody.layers.length ? snapshot.custody.layers : snapshot.custody.locations
      )
        .filter((r: Json) => r.state === undefined || r.state === 'active')
        .map((r: Json) => ({
          source_order_id: r.order_id,
          product_id: r.product_id,
          warehouse_id: r.warehouse_id,
          location: r.location,
          layer_id: r.layer_id ?? null,
          quantity: r.quantity,
          scanned: r.scanned,
        }));
      assert.deepEqual(await pages(path + '/physical', cookie), physical);
      readbacks.push({
        kind,
        id: h.id,
        full_public_head_rows_sources_physical_exact: true,
        rows: rows.length,
      });
    }
  }
  const history = await pages('/order-merges/history', cookie, 25);
  // History uses SQL JSONB heads, preserving microsecond timestamp strings and
  // JSON numeric quantities; detail heads use pg Date/bigint wire conversions.
  const historySql = await readonly(copied, async () => {
    await copied!.query("SELECT set_config('TimeZone',$1,true)", [copyApiTimezone]);
    return (
      await copied!.query(
        `SELECT 'preview' kind,to_jsonb(p) value
    FROM order_merge_previews p WHERE tenant_id=$1 UNION ALL
    SELECT 'execution',to_jsonb(e) FROM order_merge_executions e WHERE tenant_id=$1`,
        [s.tenant],
      )
    ).rows;
  });
  const expectedHistory = historySql.map((r) => ({ kind: r.kind, ...publicHead(r.value) }));
  assert.deepEqual(
    [...history].sort((a, b) => a.id.localeCompare(b.id)),
    expectedHistory.sort((a, b) => a.id.localeCompare(b.id)),
    'Full exact history set, not count only',
  );
  readbacks.push({ kind: 'history', entries: history.length, exact: true });
  for (const claim of claims) {
    const lineage = await get('/order-merges/orders/' + claim.source_order_id + '/lineage', cookie);
    assert.equal(lineage.owner_order_id, claim.target_order_id);
    assert.equal(lineage.closed_source, true);
    assert.deepEqual(lineage.claims, [claim]);
    assert.equal(lineage.created_by, null, 'An original source has no technical birth');
    assert(
      lineage.origin &&
        lineage.origin.header.portal_token === undefined &&
        lineage.origin.header.source_snapshot === undefined,
    );
    const origin: Json = (
      await copied.query(
        'SELECT header,items FROM order_merge_origins WHERE tenant_id=$1 AND order_id=$2',
        [s.tenant, claim.source_order_id],
      )
    ).rows[0];
    assert.deepEqual(
      lineage.origin.header,
      sourceProjection(origin.header, { picks: [], payments: { orders: [] } }),
    );
    assert.deepEqual(
      lineage.origin.items,
      origin.items.map((i: Json) =>
        Object.fromEntries(
          [
            'id',
            'order_id',
            'product_id',
            'sku',
            'name',
            'quantity',
            'scanned',
            'price',
            'vat',
            'line_total',
            'components',
          ].map((k) => [k, i[k]]),
        ),
      ),
    );
    readbacks.push({
      kind: 'lineage',
      source_order_id: claim.source_order_id,
      exact_original_projection: true,
    });
  }
  for (const original of s.original_orders) {
    const lineage = await get('/order-merges/orders/' + original.id + '/lineage', cookie);
    assert.equal(lineage.order_id, original.id);
    assert.equal(lineage.created_by, null, 'All four original orders have no technical birth');
  }
  const technical = executions.find((e) => e.merge_mode === 'technical_merge');
  assert(technical);
  const birth: Json = (
    await copied.query(
      `SELECT id,merge_mode,created_at,main_order_id,
      before_snapshot->'orders' AS sources FROM order_merge_executions
      WHERE tenant_id=$1 AND target_order_id=$2 AND merge_mode='technical_merge'
      ORDER BY created_at,id LIMIT 1`,
      [s.tenant, technical.target_order_id],
    )
  ).rows[0];
  assert(birth && birth.id === technical.id);
  const technicalLineage = await get(
    '/order-merges/orders/' + technical.target_order_id + '/lineage',
    cookie,
  );
  assert.equal(technicalLineage.order_id, technical.target_order_id);
  assert.equal(technicalLineage.owner_order_id, technical.target_order_id);
  assert.equal(technicalLineage.closed_source, false);
  assert.deepEqual(technicalLineage.claims, []);
  assert.equal(technicalLineage.origin, null);
  assert.deepEqual(
    technicalLineage.created_by,
    {
      id: birth.id,
      merge_mode: 'technical_merge',
      created_at: birth.created_at.toISOString(),
      main_order_id: birth.main_order_id,
      sources: birth.sources.map((o: Json) => ({ id: o.id, number: o.number })),
    },
    'Technical target birth is the exact immutable SQL execution with bounded source identity',
  );
  for (const privateKey of ['portal_token', 'source_snapshot', 'request_hash', 'api_key_id'])
    assert(!JSON.stringify(technicalLineage).includes('"' + privateKey + '"'));
  readbacks.push({
    kind: 'technical_target_lineage',
    target_order_id: technical.target_order_id,
    immutable_birth_exact: true,
    source_identities_exact: true,
    original_births_null: 4,
  });
  const rejected: Json[] = [];
  for (const [method, path] of [
    ['POST', '/order-merges/previews'],
    ['POST', '/order-merges/execute'],
    ['PATCH', '/orders/' + s.main_first.id + '/status'],
    ['POST', '/orders/' + s.main_first.id + '/payments'],
  ]) {
    const response = await call(path, cookie, method, '{');
    assert.equal(response.status, 423, 'Read-only before malformed parse: ' + path);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    rejected.push({ method, path, status: 423 });
  }
  const afterHttp = await tableFingerprints(copied);
  assert.deepEqual(Object.keys(afterHttp), Object.keys(beforeHttp));
  for (const name of Object.keys(beforeHttp))
    if (name !== 'sessions')
      assert.deepEqual(
        afterHttp[name],
        beforeHttp[name],
        'Copy HTTP altered business rows: ' + name,
      );
  const sessionsAfter = (
    await copied.query('SELECT to_jsonb(t) row FROM sessions t ORDER BY token_hash')
  ).rows;
  const oldKeys = new Set(sessionsBefore.map((x) => x.row.token_hash));
  assert.equal(sessionsAfter.length, sessionsBefore.length + 1);
  assert.deepEqual(
    sessionsAfter.filter((x) => oldKeys.has(x.row.token_hash)),
    sessionsBefore,
  );
  const added = sessionsAfter.filter((x) => !oldKeys.has(x.row.token_hash));
  assert.equal(added.length, 1);
  assert(added[0].row.user_id === s.user && added[0].row.tenant_id === s.tenant);
  const crossCookie = await fetch('http://127.0.0.1:4100/api/order-merges/options', {
    headers: { cookie, 'X-Workspace-ID': s.tenant },
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(crossCookie.status, 401);
  await ownCheckpoint(copied);
  await earlierCopy(copied);
  report = {
    status: 'PASS',
    source_revision: revision,
    source_runtime_revision: revision,
    original_setup_revision: s.runtime_revision,
    schema_revision: schema,
    backup: {
      tables: backup.tables,
      migrations: backup.schema,
      encryption: backup.encryption,
      sha256: backup.sha256,
    },
    restore: {
      tables: restored.tables,
      encrypted_records_verified: restored.encrypted_records_verified,
      row_fingerprints_match: true,
      schema_fingerprint_match: true,
      worker_enabled: false,
    },
    own_checkpoint_tables: Object.keys(expected).length,
    own_checkpoint_sha256: sha(expected),
    accepted_merge_checkpoint_sha256: sha(s.accepted_checkpoint),
    checkpoint_kind: s.fulfilment_verified
      ? 'fulfilment_after_actual_dispatch_return'
      : 'accepted_merge',
    earlier_firms: previousCopy,
    preservation_before: {
      status: sourcePreservationBefore.status,
      firms: sourcePreservationBefore.previous_firms,
    },
    merge_tables_force_rls: 7,
    immutable_populated_tables_probed: 7,
    validated_composite_tenant_fks: true,
    foreign_scope_read_and_transfer_denied: true,
    originals_payment_ledger_exact: true,
    original_source_typed_records_exact: true,
    api_history_timezone: copyApiTimezone,
    claims: claims.length,
    custody_proofs: custody.length,
    frozen_custody_full_rows_source_and_copy_exact: true,
    frozen_custody_physical_before_keys_exact: ['stock', 'bins', 'positions'],
    frozen_custody_rows_sha256: sha(sourceCustodyProofs),
    current_physical_accepted_checkpoint_exact: true,
    readbacks,
    malformed_writes: rejected,
    all_non_session_copy_tables_unchanged: true,
    prior_global_sessions_exact: true,
    own_copy_session_added: 1,
    cookie_cross_isolation: true,
    chrome_copy_verified: false,
    provider_operations: false,
    full_goal_complete: false,
  };
} catch (e) {
  // Detailed assertions are private-only; public reports never include header,
  // ledger, auth or customer values from assertion diffs.
  copyLog +=
    '\nPRIVATE PROOF FAILURE phase=' +
    phase +
    '\n' +
    (e instanceof Error ? (e.stack ?? e.message) : 'Unknown failure') +
    '\n';
  report = {
    status: 'FAIL',
    source_revision: revision,
    source_runtime_revision: revision,
    original_setup_revision: s.runtime_revision,
    phase,
    error: e instanceof Error ? e.name : 'UnknownFailure',
    detail: 'Proof failed; no acceptance claim. Operator must inspect own private copy log.',
    full_goal_complete: false,
  };
  process.exitCode = 1;
} finally {
  const cleanupErrors: string[] = [];
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise((done) => child!.once('exit', done)), delay(5000)]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await new Promise((done) => child!.once('exit', done));
    }
  }
  try {
    await copied?.end();
  } catch {
    cleanupErrors.push('owned copy connection close');
  }
  if (owned && adminConnected) {
    try {
      assert(!prior.includes(owned) && owned !== source.database);
      await admin.query(`DROP DATABASE "${restoreDatabaseName(owned)}"`);
      report.owned_copy_removed = true;
    } catch {
      cleanupErrors.push('owned copy database cleanup');
    }
  }
  if (ownedDirectory && report.owned_copy_removed === true) {
    try {
      assert.equal(
        ownedDirectory,
        resolve('data/restores', owned!.replace('dynaminds_restore_', '')),
      );
      await rm(ownedDirectory, { recursive: true });
      report.owned_decrypted_restore_files_removed = true;
    } catch {
      cleanupErrors.push('owned decrypted restore files cleanup');
    }
  }
  if (adminConnected && prior.length) {
    try {
      const now = (await admin.query('SELECT datname FROM pg_database ORDER BY datname')).rows.map(
        (r) => r.datname,
      );
      assert.deepEqual(now, prior, 'All original databases retained exactly');
      report.original_databases_retained = prior.length;
      report.original_database_inventory_exact = true;
    } catch {
      cleanupErrors.push('original database inventory');
    }
    try {
      const preservation = await sourceExact();
      report.source_after_cleanup_exact = true;
      report.preservation_after_cleanup = {
        status: preservation.status,
        firms: preservation.previous_firms,
      };
    } catch {
      cleanupErrors.push('source and seven checkpoint preservation after cleanup');
    }
  }
  if (cleanupErrors.length) {
    report.status = 'FAIL';
    report.cleanup_failures = cleanupErrors;
    process.exitCode = 1;
  }
  await admin.end().catch(() => {});
  await pool.end();
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  await writeFile('data/order-merges-recovery-copy-log.txt', copyLog, { mode: 0o600 });
  console.log(
    JSON.stringify({
      status: report.status,
      phase,
      owned_copy_removed: report.owned_copy_removed,
      original_databases_retained: report.original_databases_retained,
      full_goal_complete: false,
    }),
  );
}
