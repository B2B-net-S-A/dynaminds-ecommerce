/** ROOT ONLY. Authoring does not execute backup, restore, DB or HTTP.
 * QA_EXPECTED_REVISION=<exact accepted SHA> QA129_DATABASE_NAME=dynaminds
 * DYNA_WORKER_DISABLED=true DATABASE_URL=<native loopback postgres:55432/dynaminds>
 * tsx scripts/b2b-return-local-origins-recovery-proof.ts verify
 * Requires genuine Chrome129 and restart PASS reports. Never rebases private checkpoints.
 * Writes SQL only in its newly generated restore DB, inside rolled-back probes.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, writeFile, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { pool } from '../server/db';
import {
  createBackup,
  restoreBackup,
  restoreDatabaseName,
  localDatabase,
  tableFingerprints,
  schemaFingerprint,
} from '../server/recovery';

type Row = Record<string, any>;
type Mark = { count: number; sha256: string };
type Checkpoint = { buyer: Record<string, Mark>; supplier: Record<string, Mark> };
const schema = '112_b2b_return_local_origins';
const prefix = '/b2b/dropshipping-returns';
const setupPath = 'data/b2b-return-local-origins-stage129.json';
const checkpointPath = 'data/b2b-return-local-origins-stage129-chrome-checkpoint.json';
const setupReportPath = 'docs/b2b-return-local-origins-native-setup-qa.json';
const chromeReportPath = 'docs/b2b-return-local-origins-native-chrome-qa.json';
const restartReportPath = 'docs/b2b-return-local-origins-native-restart-qa.json';
const processReportPath = 'docs/b2b-return-local-origins-restart-process-qa.json';
const reportPath = 'docs/b2b-return-local-origins-recovery-qa.json';
const port = 4102;
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const bytesHash = (v: Buffer) => createHash('sha256').update(v).digest('hex');
let step = 'preflight';
let source: pg.Client | undefined, copy: pg.Client | undefined, database: string | undefined;
let child: ChildProcess | undefined, log: Awaited<ReturnType<typeof open>> | undefined;
let beforeManifest: Awaited<ReturnType<typeof tableFingerprints>> | undefined;
let beforeSchema: string | undefined, beforeDatabases: string[] | undefined;
let report: Row | undefined;
const originals = new Map<string, Buffer>();
const publicOriginals = new Map<string, Buffer>();
const runId = randomUUID();
function uuid(v: unknown) {
  assert(typeof v === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v));
}
async function absent(path: string) {
  try {
    await lstat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  throw Error('Existing recovery output refuses overwrite/retry');
}
async function read(path: string, privateFile = false): Promise<Buffer> {
  const st = await lstat(path);
  assert(st.isFile() && !st.isSymbolicLink() && st.size <= (privateFile ? 32 : 8) * 1024 * 1024);
  if (privateFile) assert.equal(st.mode & 0o777, 0o600);
  const bytes = await readFile(path);
  (privateFile ? originals : publicOriginals).set(path, bytes);
  return bytes;
}
async function rr<T>(c: pg.Client, fn: () => Promise<T>): Promise<T> {
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await c.query("SET LOCAL TimeZone='UTC'");
    const result = await fn();
    await c.query('COMMIT');
    return result;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  }
}
async function own(c: pg.Client, s: Row): Promise<Checkpoint> {
  const names: string[] = (
    await c.query(`SELECT t.table_name FROM information_schema.tables t
    JOIN information_schema.columns k USING(table_schema,table_name)
    WHERE t.table_schema='public' AND t.table_type='BASE TABLE' AND k.column_name='tenant_id'
    AND t.table_name<>'sessions' UNION SELECT 'users' UNION SELECT 'tenants' ORDER BY 1`)
  ).rows.map((r) => r.table_name);
  assert.equal(names.length, 305, 'Reviewed112 own table set');
  const result: Checkpoint = { buyer: {}, supplier: {} };
  for (const side of ['buyer', 'supplier'] as const)
    for (const name of names) {
      assert.match(name, /^[a-z_][a-z0-9_]*$/);
      const key = ['users', 'tenants'].includes(name) ? 'id' : 'tenant_id';
      const rows: Row[] = (
        await c.query(`SELECT to_jsonb(t) row FROM "${name}" t WHERE ${key}=$1 ORDER BY 1`, [
          name === 'users' ? s[side].user : s[side].tenant,
        ])
      ).rows;
      result[side][name] = { count: rows.length, sha256: hash(rows) };
    }
  return result;
}
async function sessions(c: pg.Client): Promise<Row[]> {
  return (await c.query('SELECT to_jsonb(s) row FROM sessions s ORDER BY token_hash')).rows.map(
    (r) => r.row,
  );
}
async function fetchAt(
  base: string,
  path: string,
  cookie = '',
  method = 'GET',
  raw?: string,
  tenant?: string,
) {
  assert(path.startsWith('/') && !path.startsWith('//'));
  return fetch(base + '/api' + path, {
    method,
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(20000),
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(tenant ? { 'X-Workspace-ID': tenant } : {}),
      ...(raw !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(raw !== undefined ? { body: raw } : {}),
  });
}
async function health(base: string, revision: string, preview: boolean) {
  const response = await fetchAt(base, '/health');
  assert.equal(response.status, 200);
  const h: Row = await response.json();
  assert.equal(h.status, 'ok');
  assert.equal(h.mode, 'local');
  assert.equal(h.revision, revision);
  assert.equal(h.schema_revision, schema);
  assert.equal(h.restore_preview, preview);
  assert.equal(h.background_workers_enabled, false);
  for (const name of [
    'b2b_local_return_origins_available',
    'b2b_dropshipping_returns_available',
    'b2b_external_order_imports_available',
    'b2b_external_order_intents_available',
    'b2b_dropshipping_available',
  ])
    assert.equal(h[name], true);
}
async function get(path: string, cookie: string, tenant: string): Promise<Row> {
  const response = await fetchAt(
    `http://127.0.0.1:${port}`,
    path,
    cookie,
    'GET',
    undefined,
    tenant,
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  const text = await response.text();
  assert(Buffer.byteLength(text) <= 8 * 1024 * 1024);
  return JSON.parse(text) as Row;
}
async function pages(path: string, cookie: string, tenant: string): Promise<Row[]> {
  const rows: Row[] = [],
    seen = new Set<string>();
  let cursor: string | null = null,
    total: number | undefined;
  for (let n = 0; n < 101; n++) {
    const page: Row = await get(
      path +
        (path.includes('?') ? '&' : '?') +
        'limit=100' +
        (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
      cookie,
      tenant,
    );
    assert.equal(page.read_only, true);
    assert.equal(page.can_manage, false);
    assert(Array.isArray(page.data) && page.data.length <= 100);
    assert(Number.isSafeInteger(page.meta.total) && page.meta.total <= 10000);
    if (total === undefined) total = page.meta.total;
    else assert.equal(page.meta.total, total);
    for (const row of page.data) {
      const identity = row.id ?? row.index;
      assert(typeof identity === 'string' || Number.isInteger(identity));
      const key = String(identity);
      assert(!seen.has(key));
      seen.add(key);
      rows.push(row);
    }
    cursor = page.meta.cursor ?? null;
    if (!cursor) {
      assert.equal(rows.length, total);
      return rows;
    }
    assert(n < 100, 'Full collection pagination bound');
  }
  throw Error('Unreachable page bound');
}
async function history(revision: string, label: string): Promise<Row> {
  const path = 'docs/b2b-return-local-origins-history-recovery-' + label + '-' + runId + '.json';
  await absent(path);
  const handle = await open(
    'data/b2b-return-local-origins-history-recovery-' + label + '-' + runId + '.log',
    'wx',
    0o600,
  );
  try {
    const p = spawn(
      process.execPath,
      [
        'node_modules/tsx/dist/cli.mjs',
        'scripts/b2b-return-local-origins-history-proof.ts',
        'after',
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, QA_EXPECTED_REVISION: revision, QA_REPORT_FILE: path },
        stdio: ['ignore', handle.fd, handle.fd],
      },
    );
    const status = await new Promise<number | null>((ok, bad) => {
      p.once('error', bad);
      p.once('exit', ok);
    });
    assert.equal(status, 0, 'Separate original-ten-firm preservation checker');
  } finally {
    await handle.close();
  }
  const result: Row = JSON.parse((await read(path)).toString('utf8'));
  assert.equal(result.status, 'PASS');
  assert.equal(result.revision, revision);
  assert.equal(result.schema_revision, schema);
  assert.equal(result.firms.length, 10);
  assert.equal(Object.keys(result.private_fixture_sha256).length, 7);
  return { ...result, report_path: path };
}
async function oracle(c: pg.Client, s: Row, accepted: Row) {
  const e = accepted.evidence;
  for (const key of [
    'local_return_id',
    'partner_return_id',
    'supplier_return_id',
    'origin_id',
    'local_proof_id',
    'case_id',
    'preview_id',
  ])
    uuid(e[key]);
  for (const side of ['buyer', 'supplier'] as const) {
    const actor = s[side],
      product = s[side + '_product'];
    const stock: Row[] = (
      await c.query(
        'SELECT on_hand,reserved,available FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3',
        [actor.tenant, actor.warehouse, product],
      )
    ).rows;
    assert.deepEqual(stock, [
      { on_hand: side === 'buyer' ? 5 : 19, reserved: 0, available: side === 'buyer' ? 5 : 19 },
    ]);
    assert.equal(
      (
        await c.query(
          "SELECT coalesce(sum(amount),0)::int n FROM payment_entries WHERE tenant_id=$1 AND order_id=$2 AND kind='receipt'",
          [actor.tenant, s[side === 'buyer' ? 'customer_order' : 'supplier_order']],
        )
      ).rows[0].n,
      side === 'buyer' ? 7500 : 1400,
    );
  }
  const origins: Row[] = (
    await c.query('SELECT * FROM b2b_return_local_origins WHERE tenant_id=$1 ORDER BY id', [
      s.buyer.tenant,
    ])
  ).rows;
  const proofs: Row[] = (
    await c.query('SELECT * FROM b2b_return_local_proofs WHERE tenant_id=$1 ORDER BY id', [
      s.buyer.tenant,
    ])
  ).rows;
  assert.equal(origins.length, 1);
  assert.equal(proofs.length, 1);
  assert.equal(origins[0].id, e.origin_id);
  assert.equal(origins[0].return_id, e.local_return_id);
  assert.equal(origins[0].order_id, s.customer_order);
  assert.equal(origins[0].actor_id, s.buyer.user);
  assert.deepEqual(origins[0].request.items, [
    { customer_item_id: s.customer_item, shipment_id: s.local_shipment, quantity: 1 },
  ]);
  assert.equal(proofs[0].id, e.local_proof_id);
  assert.equal(proofs[0].origin_id, e.origin_id);
  assert.equal(proofs[0].applied, true);
  assert.equal(proofs[0].return_id, e.local_return_id);
  assert(proofs[0].transaction_id && proofs[0].transaction_started_at);
  assert.equal(proofs[0].after_snapshot.head.refund_amount, 2500);
  assert(proofs[0].after_snapshot.head.received_at);
  await c.query("SELECT set_config('app.tenant_id',$1,true)", [s.buyer.tenant]);
  assert.equal(
    (await c.query('SELECT b2b_return_local_installed() installed')).rows[0].installed,
    true,
  );
  assert.deepEqual(
    (await c.query('SELECT b2b_return_local_snapshot($1) snapshot', [e.local_return_id])).rows[0]
      .snapshot,
    proofs[0].after_snapshot,
  );
  for (const [tenant, id, amount, physical, restocked] of [
    [s.buyer.tenant, e.local_return_id, 2500, true, 1],
    [s.buyer.tenant, e.partner_return_id, 2500, false, 0],
    [s.supplier.tenant, e.supplier_return_id, 700, true, 1],
  ] as const) {
    const r: Row = (
      await c.query('SELECT * FROM return_cases WHERE tenant_id=$1 AND id=$2', [tenant, id])
    ).rows[0];
    const items: Row[] = (
      await c.query('SELECT * FROM return_items WHERE tenant_id=$1 AND return_id=$2', [tenant, id])
    ).rows;
    assert(r);
    assert.equal(r.state, 'refund_pending');
    assert.equal(r.refund_amount, amount);
    assert.equal(r.refunded_shipping, 0);
    assert.equal(Boolean(r.received_at), physical);
    assert.equal(Boolean(r.receipt), physical);
    assert.equal(r.refunded_at, null);
    assert.equal(r.settlement, null);
    assert.equal(items.length, 1);
    assert.equal(items[0].requested, 1);
    assert.equal(items[0].accepted, 1);
    assert.equal(items[0].restocked, restocked);
    if (tenant === s.buyer.tenant) assert.equal(items[0].item_id, s.customer_item);
  }
  const bridge: Row = (
    await c.query('SELECT * FROM b2b_dropship_return_cases WHERE tenant_id=$1 AND id=$2', [
      s.buyer.tenant,
      e.case_id,
    ])
  ).rows[0];
  assert(bridge);
  assert.equal(bridge.return_id, e.partner_return_id);
  assert.equal(bridge.preview_id, e.preview_id);
  assert.equal(bridge.supplier_return_id, e.supplier_return_id);
  const partnerProofs: Row[] = (
    await c.query(
      'SELECT to_jsonb(p) row FROM b2b_dropship_return_proofs p WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1',
      [[s.buyer.tenant, s.supplier.tenant]],
    )
  ).rows.map((row) => row.row);
  assert.equal(partnerProofs.length, 2);
  assert.deepEqual(
    [...partnerProofs].sort((a, b) => a.id.localeCompare(b.id)),
    [...e.partner_proofs].sort((a: Row, b: Row) => a.id.localeCompare(b.id)),
  );
  for (const proof of partnerProofs) {
    assert.equal(proof.applied, true);
    assert(['receive', 'reconcile'].includes(proof.kind));
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [proof.tenant_id]);
    const after = { ...proof.after_snapshot };
    delete after.stock;
    assert.deepEqual(
      (await c.query('SELECT b2b_dropship_return_snapshot($1) snapshot', [proof.return_id])).rows[0]
        .snapshot,
      after,
    );
  }
  assert.equal(
    (await c.query('SELECT count(*)::int n FROM b2b_dropship_return_created_cases')).rows[0].n,
    0,
  );
  return { origins, proofs };
}
async function rollbackProbe(c: pg.Client, fn: () => Promise<void>) {
  await c.query('BEGIN');
  try {
    await c.query("SET LOCAL TimeZone='UTC'");
    await fn();
  } finally {
    await c.query('ROLLBACK');
  }
}
async function refused(c: pg.Client, sql: string, params: unknown[], code: string) {
  let reached = false;
  try {
    await c.query(sql, params);
  } catch (e) {
    assert.equal((e as { code?: string }).code, code);
    reached = true;
  }
  assert(reached, 'Required SQL refusal did not occur');
}
async function protection(c: pg.Client, s: Row, accepted: Row) {
  for (const name of ['b2b_return_local_origins', 'b2b_return_local_proofs']) {
    const meta: Row = (
      await c.query(
        'SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',
        [name],
      )
    ).rows[0];
    assert(meta.relrowsecurity && meta.relforcerowsecurity);
    for (const permission of ['INSERT', 'UPDATE', 'DELETE'])
      assert.equal(
        (await c.query("SELECT has_table_privilege('dyna_app',$1,$2) allowed", [name, permission]))
          .rows[0].allowed,
        false,
      );
  }
  assert.equal(
    (
      await c.query(
        "SELECT has_table_privilege('dyna_app','b2b_return_local_origins','SELECT') allowed",
      )
    ).rows[0].allowed,
    true,
  );
  assert.equal(
    (
      await c.query(
        "SELECT has_table_privilege('dyna_app','b2b_return_local_proofs','SELECT') allowed",
      )
    ).rows[0].allowed,
    false,
  );
  const required: Array<[string, string, string]> = [
    ['b2b_return_local_origins', 'complete', 'b2b_return_local_origin_complete()'],
    ['b2b_return_local_origins', 'immutable', 'b2b_return_local_immutable()'],
    ['b2b_return_local_origins', 'budget', 'b2b_return_local_budget()'],
    ['b2b_return_local_proofs', 'proof_complete', 'b2b_return_local_proof_complete()'],
    ['b2b_return_local_proofs', 'immutable', 'b2b_return_local_private_guard()'],
    ['b2b_return_local_proofs', 'budget', 'b2b_return_local_budget()'],
    ['return_cases', 'local_origin_guard', 'b2b_return_local_rma_guard()'],
    ['return_items', 'local_origin_guard', 'b2b_return_local_rma_guard()'],
    ['return_cases', 'local_origin_complete', 'b2b_return_local_initial_complete()'],
    ['return_items', 'local_origin_complete', 'b2b_return_local_initial_complete()'],
    ['b2b_dropship_return_previews', 'local_origin_guard', 'b2b_return_local_bridge_guard()'],
    ['b2b_dropship_return_cases', 'local_origin_guard', 'b2b_return_local_bridge_guard()'],
  ];
  for (const relation of [
    'stock',
    'stock_locations',
    'stock_movements',
    'wms_layer_positions',
    'wms_layer_movements',
    'wms_return_fragments',
    'wms_operations',
    'return_cases',
    'return_items',
    'orders',
    'order_items',
    'shipments',
  ])
    required.push([relation, 'local_return_seal', 'b2b_return_local_seal()']);
  for (const [relation, name, fn] of required) {
    const rows: Row[] = (
      await c.query(
        `SELECT tgdeferrable,tginitdeferred FROM pg_trigger
      WHERE tgrelid=to_regclass('public.'||$1) AND tgname=$2 AND tgfoid=to_regprocedure('public.'||$3)
      AND tgenabled IN('O','A') AND NOT tgisinternal`,
        [relation, name, fn],
      )
    ).rows;
    assert.equal(rows.length, 1, 'Restored required guard ' + relation + '.' + name);
    if (['complete', 'proof_complete', 'local_origin_complete'].includes(name))
      assert(rows[0].tgdeferrable && rows[0].tginitdeferred);
  }
  for (const fn of [
    'b2b_return_local_auth(uuid,uuid,boolean)',
    'b2b_return_local_snapshot(uuid)',
    'b2b_return_local_origin_complete()',
    'b2b_return_local_proof_complete()',
    'b2b_return_local_rma_guard()',
    'b2b_return_local_initial_complete()',
    'b2b_return_local_bridge_guard()',
    'b2b_return_local_seal()',
    'b2b_return_local_immutable()',
    'b2b_return_local_private_guard()',
    'b2b_return_local_budget()',
  ]) {
    assert.equal(
      (await c.query("SELECT has_function_privilege('dyna_app',$1,'EXECUTE') allowed", [fn]))
        .rows[0].allowed,
      false,
    );
    assert.equal(
      (
        await c.query(
          `SELECT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL
      aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
      WHERE p.oid=$1::regprocedure AND acl.grantee=0 AND acl.privilege_type='EXECUTE') allowed`,
          [fn],
        )
      ).rows[0].allowed,
      false,
    );
  }
  for (const fn of [
    'b2b_return_local_installed()',
    'b2b_return_local_external(uuid)',
    'b2b_return_local_choices(uuid,uuid,uuid)',
    'b2b_return_local_select(uuid,uuid,uuid,jsonb)',
    'b2b_return_local_prepare(uuid,uuid,uuid,jsonb)',
    'b2b_return_local_finish(uuid)',
    'b2b_return_local_receive_replay(uuid,uuid,uuid,jsonb)',
  ]) {
    assert.equal(
      (await c.query("SELECT has_function_privilege('dyna_app',$1,'EXECUTE') allowed", [fn]))
        .rows[0].allowed,
      true,
    );
    assert.equal(
      (
        await c.query(
          `SELECT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL
      aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
      WHERE p.oid=$1::regprocedure AND acl.grantee=0 AND acl.privilege_type='EXECUTE') allowed`,
          [fn],
        )
      ).rows[0].allowed,
      false,
    );
  }
  await rollbackProbe(c, async () => {
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [s.supplier.tenant]);
    assert.equal(
      (
        await c.query('SELECT count(*)::int n FROM b2b_return_local_origins WHERE tenant_id=$1', [
          s.buyer.tenant,
        ])
      ).rows[0].n,
      0,
    );
  });
  await rollbackProbe(c, async () => {
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [s.buyer.tenant]);
    await refused(c, 'SELECT * FROM b2b_return_local_proofs', [], '42501');
  });
  await rollbackProbe(c, () =>
    refused(
      c,
      'UPDATE b2b_return_local_origins SET created_at=created_at WHERE id=$1',
      [accepted.evidence.origin_id],
      '23514',
    ),
  );
  await rollbackProbe(c, () =>
    refused(
      c,
      'UPDATE b2b_return_local_proofs SET after_snapshot=after_snapshot WHERE id=$1',
      [accepted.evidence.local_proof_id],
      '23514',
    ),
  );
  await rollbackProbe(c, () =>
    refused(
      c,
      `INSERT INTO b2b_return_local_origins
    SELECT (jsonb_populate_record(NULL::b2b_return_local_origins,to_jsonb(o)||jsonb_build_object(
      'id',$2::uuid,'tenant_id',$3::uuid,'client_key',$4::uuid))).* FROM b2b_return_local_origins o WHERE id=$1`,
      [accepted.evidence.origin_id, randomUUID(), s.supplier.tenant, randomUUID()],
      '23503',
    ),
  );
  return required.length;
}
async function freePort() {
  const p = createServer();
  await new Promise<void>((ok, bad) => {
    p.once('error', bad);
    p.listen(port, '127.0.0.1', ok);
  });
  await new Promise<void>((ok, bad) => p.close((e) => (e ? bad(e) : ok())));
}
async function stopOwnChild() {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((ok) => child!.once('exit', () => ok()));
  child.kill('SIGTERM');
  if (!(await Promise.race([closed.then(() => true), delay(10000).then(() => false)]))) {
    child.kill('SIGKILL');
    await closed;
  }
}
async function apiEvidence(s: Row, accepted: Row, cookies: Record<string, string>) {
  const e = accepted.evidence,
    base = `http://127.0.0.1:${port}`;
  const writes: Array<[string, string, string]> = [];
  for (const side of ['buyer', 'supplier'] as const) {
    const options = await get(prefix + '/options', cookies[side], s[side].tenant);
    assert.equal(options.read_only, true);
    assert.equal(options.can_manage, false);
  }
  const settings = await get(
    prefix + '/settings/' + s.account,
    cookies.supplier,
    s.supplier.tenant,
  );
  assert.equal(settings.read_only, true);
  assert.equal(settings.can_manage, false);
  assert.equal(settings.settings.enabled, true);
  assert.equal(settings.settings.warehouse_id, s.supplier.warehouse);
  for (const [side, rid, origin, credit, restocked] of [
    ['buyer', e.local_return_id, 'local', 2500, 1],
    ['buyer', e.partner_return_id, 'partner', 2500, 0],
    ['supplier', e.supplier_return_id, 'supplier', 700, 1],
  ] as const) {
    const actor = s[side],
      cookie = cookies[side];
    const r = await get('/returns/' + rid, cookie, actor.tenant);
    assert.equal(r.id, rid);
    assert.equal(r.refund_amount, credit);
    assert.equal(r.state, 'refund_pending');
    assert.equal(r.acceptance_kind, origin === 'partner' ? 'partner' : 'physical');
    assert(r.accepted_at);
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].accepted, 1);
    assert.equal(r.items[0].restocked, restocked);
    assert.equal(Boolean(r.received_at), origin !== 'partner');
    assert.equal(Boolean(r.receipt), origin !== 'partner');
    const context = (await get(prefix + '/returns/' + rid + '/context', cookie, actor.tenant))
      .context;
    assert.equal(context.fulfillment_origin, origin);
    assert.equal(context.can_select_local_origin, false);
    assert.equal(context.can_receive_locally, false);
    assert.equal(context.can_reconcile, false);
    assert.equal(context.can_preview, false);
    if (origin === 'local') {
      assert.equal(context.local_origin.id, e.origin_id);
      assert.deepEqual(context.local_origin.items, [
        { customer_item_id: s.customer_item, shipment_id: s.local_shipment, quantity: 1 },
      ]);
    } else assert.equal(context.local_origin, null);
    writes.push(
      ['POST', '/returns/' + rid + '/receive', side],
      ['POST', prefix + '/returns/' + rid + '/local-origin', side],
    );
  }
  for (const side of ['buyer', 'supplier'] as const) {
    const actor = s[side],
      cookie = cookies[side];
    const cases = await pages(
      prefix +
        '/cases?return_id=' +
        e[side === 'buyer' ? 'partner_return_id' : 'supplier_return_id'] +
        '&side=' +
        side,
      cookie,
      actor.tenant,
    );
    assert.deepEqual(
      cases.map((x) => x.id),
      [e.case_id],
    );
    const head = (await get(prefix + '/cases/' + e.case_id, cookie, actor.tenant)).case;
    assert.equal(head.state, 'received');
    assert.equal(head.wholesale_refund_minor, '700');
    assert(head.received_at && head.retail_reconciled_at);
    const rows = await pages(prefix + '/cases/' + e.case_id + '/rows', cookie, actor.tenant);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].customer_item_id, s.customer_item);
    assert.equal(rows[0].quantity, 1);
    assert.equal(rows[0].retail_refund_minor, '2500');
    assert.equal(rows[0].wholesale_refund_minor, '700');
    const events = await pages(prefix + '/cases/' + e.case_id + '/events', cookie, actor.tenant);
    assert.deepEqual(events.map((v) => v.kind).sort(), ['receive', 'reconcile', 'submit']);
    const orderId = s[side === 'buyer' ? 'customer_order' : 'supplier_order'];
    const ledger = (await get('/orders/' + orderId + '/payments', cookie, actor.tenant)).balance;
    assert.equal(ledger.received, side === 'buyer' ? 7500 : 1400);
    assert.equal(ledger.refunded, 0);
    assert.equal(ledger.credit, side === 'buyer' ? 5000 : 700);
    assert.equal(ledger.amount_due, 0);
    assert.equal(ledger.overpayment, ledger.credit);
    const order = await get('/orders/' + orderId, cookie, actor.tenant);
    assert.equal(order.status, 'shipped');
    assert.equal(order.total, side === 'buyer' ? 7500 : 1400);
    assert.deepEqual(order.items, s.source_born[side + '_order'].items);
    assert.deepEqual(order.picking_items, s.source_born[side + '_order'].picking_items);
  }
  const preview = (await get(prefix + '/previews/' + e.preview_id, cookies.buyer, s.buyer.tenant))
    .preview;
  assert.equal(preview.can_submit, false);
  assert.deepEqual(preview.executed_case_ids, [e.case_id]);
  writes.push(
    ['POST', prefix + '/returns/' + e.partner_return_id + '/previews', 'buyer'],
    ['POST', prefix + '/previews/' + e.preview_id + '/submit', 'buyer'],
    ['POST', prefix + '/cases/' + e.case_id + '/receive', 'supplier'],
    ['POST', prefix + '/cases/' + e.case_id + '/decision', 'supplier'],
    ['POST', prefix + '/cases/' + e.case_id + '/withdraw', 'buyer'],
    ['POST', prefix + '/returns/' + e.partner_return_id + '/reconcile', 'buyer'],
    ['PATCH', prefix + '/settings/' + s.account, 'supplier'],
    ['POST', '/orders/' + s.customer_order + '/ship-demo', 'buyer'],
  );
  for (const [method, path, side] of writes) {
    const response = await fetchAt(
      base,
      path,
      cookies[side],
      method,
      '{"malformed":',
      s[side].tenant,
    );
    assert.equal(response.status, 423, 'Read-only before parse');
    assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  }
  assert.equal(
    (
      await fetchAt(
        base,
        '/returns/' + e.local_return_id,
        cookies.supplier,
        'GET',
        undefined,
        s.supplier.tenant,
      )
    ).status,
    404,
  );
  return writes.length;
}

try {
  assert.equal(process.argv[2], 'verify');
  assert.equal(process.env.DYNA_WORKER_DISABLED, 'true');
  assert.notEqual(process.env.DYNA_TEST, 'true');
  assert.equal(process.env.QA129_DATABASE_NAME, 'dynaminds');
  const revision = process.env.QA_EXPECTED_REVISION ?? '';
  assert.match(revision, /^[a-f0-9]{40}$/);
  const local = localDatabase();
  assert.equal(local.database, 'dynaminds');
  await absent(reportPath);
  const s: Row = JSON.parse((await read(setupPath, true)).toString('utf8'));
  const accepted: Row = JSON.parse((await read(checkpointPath, true)).toString('utf8'));
  const setupReport: Row = JSON.parse((await read(setupReportPath)).toString('utf8'));
  const chromeReport: Row = JSON.parse((await read(chromeReportPath)).toString('utf8'));
  const restartReport: Row = JSON.parse((await read(restartReportPath)).toString('utf8'));
  const processReport: Row = JSON.parse((await read(processReportPath)).toString('utf8'));
  assert.equal(s.stage129, true);
  assert.equal(s.setup_complete, true);
  assert.equal(s.pending, null);
  for (const record of [s, accepted]) {
    assert.equal(record.runtime_revision, revision);
    assert.equal(record.schema_revision, schema);
  }
  assert.equal(accepted.stage, 129);
  assert.equal(accepted.chrome_verified, true);
  assert.equal(accepted.chrome_human_attested, true);
  for (const record of [setupReport, chromeReport, restartReport, processReport]) {
    assert.equal(record.status, 'PASS');
    assert.equal(record.revision, revision);
    assert.equal(record.schema_revision, schema);
  }
  assert.equal(restartReport.restart_verified, true);
  assert.equal(restartReport.checkpoint_sha256, hash(accepted.checkpoint));
  assert.equal(
    restartReport.accepted_checkpoint_file_sha256,
    bytesHash(originals.get(checkpointPath)!),
  );
  assert.equal(accepted.setup.sha256, bytesHash(originals.get(setupPath)!));
  assert.equal(accepted.setup.checkpoint_sha256, hash(s.setup_checkpoint));
  assert.equal(accepted.setup.report_sha256, bytesHash(publicOriginals.get(setupReportPath)!));
  assert.deepEqual(chromeReport.setup, accepted.setup);
  assert.equal(chromeReport.checkpoint_sha256, hash(accepted.checkpoint));
  assert.equal(processReport.stop_exit_code, 0);
  assert.equal(processReport.listeners_absent, true);
  assert.equal(processReport.background_workers_enabled, false);
  assert.equal(processReport.health_revision, revision);
  assert.notEqual(processReport.stopped_handle, processReport.live_handle);
  for (const side of ['buyer', 'supplier'] as const)
    assert.deepEqual(accepted[side], { tenant: s[side].tenant, user: s[side].user });
  assert.equal(
    bytesHash(originals.get(setupPath)!),
    '75c7dccae36af941494ff3cde8a8ac95934b5953f67b0e4007a8c858186edcea',
  );
  assert.equal(
    bytesHash(originals.get(checkpointPath)!),
    'f99aa3bbd4f1ef7821dc5f2fc26da115423fb197afb8ad7ad82c33e37a190251',
  );
  assert.equal(
    hash(accepted.checkpoint),
    'cdbcc5183d44396975510f55ce93d8b53b7e855aa2115c002d867f1d5f8d5037',
  );
  await health('http://127.0.0.1:4100', revision, false);
  process.env.APP_REVISION = revision;
  step = 'source-history-before';
  const historyBefore = await history(revision, 'before');
  for (const [path, expected] of Object.entries(historyBefore.private_fixture_sha256)) {
    assert.match(path, /^data\/[a-z0-9-]+\.json$/);
    assert.equal(
      bytesHash(await read(resolve(process.env.QA_HISTORY_ROOT ?? '.', path), true)),
      expected,
    );
  }
  assert.equal(originals.size, 9, 'Seven historical +two new immutable private files');
  beforeDatabases = (
    await pool.query('SELECT datname FROM pg_database WHERE datistemplate=false ORDER BY datname')
  ).rows.map((r) => r.datname);
  source = new pg.Client(local);
  await source.connect();
  step = 'source-full-manifest';
  const before = await rr(source, async () => ({
    checkpoint: await own(source!, s),
    manifest: await tableFingerprints(source!),
    schema: await schemaFingerprint(source!),
    sessions: await sessions(source!),
    oracle: await oracle(source!, s, accepted),
  }));
  assert.deepEqual(before.checkpoint, accepted.checkpoint);
  beforeManifest = before.manifest;
  beforeSchema = before.schema;
  step = 'encrypted-backup-and-restore';
  const backup = await createBackup({ directory: resolve('data', 'qa129-backups', runId) });
  const restored = await restoreBackup(backup.file, {
    directory: resolve('data', 'qa129-restores', runId),
  });
  const ownedDatabase = restoreDatabaseName(restored.database);
  assert(!beforeDatabases.includes(ownedDatabase), 'Never clean up a previously existing database');
  database = ownedDatabase;
  assert.equal(restored.source, 'dynaminds');
  assert.equal(restored.revision, revision);
  assert.equal(restored.worker_enabled, false);
  assert(
    restored.preview_only && restored.row_fingerprints_match && restored.schema_fingerprint_match,
  );
  copy = new pg.Client({ ...local, database });
  await copy.connect();
  step = 'restored-full-manifest';
  const recovered = await rr(copy, async () => ({
    checkpoint: await own(copy!, s),
    manifest: await tableFingerprints(copy!),
    schema: await schemaFingerprint(copy!),
    sessions: await sessions(copy!),
    oracle: await oracle(copy!, s, accepted),
  }));
  assert.deepEqual(recovered.manifest, before.manifest);
  assert.equal(recovered.schema, before.schema);
  assert.deepEqual(recovered.checkpoint, accepted.checkpoint);
  assert.deepEqual(recovered.sessions, before.sessions);
  assert.deepEqual(
    recovered.oracle,
    before.oracle,
    'Durable whole origins/proofs including xid+clock retained exactly',
  );
  assert.equal(
    (await copy.query('SELECT name FROM migrations ORDER BY name DESC LIMIT 1')).rows[0].name,
    schema,
  );
  step = 'restored-ACL-RLS-deferred-immutability';
  const guardCount = await protection(copy, s, accepted);
  step = 'owned-readonly-preview';
  await freePort();
  log = await open(resolve(restored.directory, 'qa129-preview.log'), 'wx', 0o600);
  child = spawn(
    process.execPath,
    [
      'node_modules/tsx/dist/cli.mjs',
      'scripts/restore-preview.ts',
      '--result',
      resolve(restored.directory, 'result.json'),
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DYNA_PREVIEW_PORT: String(port),
        DYNA_WORKER_DISABLED: 'true',
        APP_REVISION: revision,
      },
      stdio: ['ignore', log.fd, log.fd],
    },
  );
  let spawnError = false;
  child.once('error', () => {
    spawnError = true;
  });
  let ready = false;
  for (let n = 0; n < 100; n++) {
    assert(!spawnError && child.exitCode === null, 'Owned preview exited');
    try {
      await health(`http://127.0.0.1:${port}`, revision, true);
      ready = true;
      break;
    } catch (e) {
      if (e instanceof assert.AssertionError) throw e;
    }
    await delay(200);
  }
  assert(ready, 'Bounded owned preview readiness');
  const cookies: Record<string, string> = {};
  for (const side of ['buyer', 'supplier'] as const) {
    const actor = s[side];
    assert(typeof actor.cookie === 'string' && actor.cookie.startsWith('dyna_session='));
    const response = await fetchAt(
      `http://127.0.0.1:${port}`,
      '/auth/login',
      '',
      'POST',
      JSON.stringify({ email: actor.email, password: actor.password }),
    );
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie')?.split(';')[0];
    assert(typeof cookie === 'string' && cookie.startsWith('dyna_session_preview_4102='));
    cookies[side] = cookie;
    const me = (await get('/auth/me', cookie, actor.tenant)).user;
    assert.equal(me.id, actor.user);
    assert.equal(me.tenant_id, actor.tenant);
    assert.equal(me.role, 'admin');
    assert.equal((await fetchAt(`http://127.0.0.1:${port}`, '/auth/me', actor.cookie)).status, 401);
    assert.equal((await fetchAt('http://127.0.0.1:4100', '/auth/me', cookie)).status, 401);
  }
  step = 'copied-HTTP-reads-and-423';
  const writeCount = await apiEvidence(s, accepted, cookies);
  await health(`http://127.0.0.1:${port}`, revision, true);
  const after = await rr(copy, async () => ({
    checkpoint: await own(copy!, s),
    manifest: await tableFingerprints(copy!),
    schema: await schemaFingerprint(copy!),
    sessions: await sessions(copy!),
  }));
  assert.deepEqual(after.checkpoint, accepted.checkpoint);
  assert.equal(after.schema, before.schema);
  for (const [name, fp] of Object.entries(before.manifest))
    if (name !== 'sessions') assert.deepEqual(after.manifest[name], fp);
  const oldSessions = new Map(before.sessions.map((row) => [row.token_hash, hash(row)]));
  for (const row of before.sessions)
    assert(after.sessions.some((x) => x.token_hash === row.token_hash));
  for (const row of after.sessions)
    if (oldSessions.has(row.token_hash)) assert.equal(hash(row), oldSessions.get(row.token_hash));
  const added = after.sessions.filter((row) => !oldSessions.has(row.token_hash));
  assert.equal(added.length, 2);
  for (const side of ['buyer', 'supplier'] as const)
    assert.equal(
      added.filter((row) => row.user_id === s[side].user && row.tenant_id === s[side].tenant)
        .length,
      1,
    );
  step = 'source-history-after';
  const historyAfter = await history(revision, 'after');
  assert.deepEqual(historyAfter.private_fixture_sha256, historyBefore.private_fixture_sha256);
  assert.deepEqual(historyAfter.firms, historyBefore.firms);
  report = {
    stage: 129,
    phase: 'native-recovery',
    status: 'PASS',
    revision,
    schema_revision: schema,
    verified_at: new Date().toISOString(),
    restore_tables: restored.tables,
    encrypted_records_verified: restored.encrypted_records_verified,
    whole_row_manifest_exact: true,
    schema_fingerprint_exact: true,
    own_tables: {
      buyer: Object.keys(recovered.checkpoint.buyer).length,
      supplier: Object.keys(recovered.checkpoint.supplier).length,
    },
    checkpoint_sha256: hash(accepted.checkpoint),
    original_private_files: originals.size,
    original_private_files_bytes_exact: true,
    previous_firms: historyAfter.firms.length,
    previous_history_reports: [historyBefore.report_path, historyAfter.report_path],
    force_RLS_tables: 2,
    private_SELECT_SQLSTATE: '42501',
    immutable_SQLSTATE: '23514',
    foreign_origin_FK_SQLSTATE: '23503',
    critical_guard_checks: guardCount,
    source_cookie_on_copy: 401,
    preview_cookie_on_source: 401,
    read_only_before_parse_writes: writeCount,
    copy_added_auth_sessions: 2,
    buyer_on_hand: 5,
    supplier_on_hand: 19,
    buyer_cash_minor: 7500,
    supplier_cash_minor: 1400,
    buyer_credit_minor: 5000,
    supplier_credit_minor: 700,
    local_physical_receipt: true,
    partner_physical_received_at: null,
    background_workers_enabled: false,
    restore_verified: true,
    original_checkpoint_rewritten: false,
    live_provider_verified: false,
    bank_payment_verified: false,
    lost_ACK_verified: false,
    native_WMS_ON_verified: false,
    full_goal_complete: false,
  };
} catch (error) {
  const e = error as Error & { code?: string };
  report = {
    stage: 129,
    phase: 'native-recovery',
    status: 'FAIL',
    step,
    error_name: e.name,
    error_code: e.code,
    full_goal_complete: false,
  };
  await writeFile(
    'data/b2b-return-local-origins-recovery-failure-' + runId + '.txt',
    (e.stack ?? String(error)) + '\n',
    { flag: 'wx', mode: 0o600 },
  ).catch(() => {});
  process.exitCode = 1;
} finally {
  const errors: unknown[] = [];
  const attempt = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      errors.push(e);
    }
  };
  await attempt(stopOwnChild);
  await attempt(async () => {
    await log?.close();
  });
  await attempt(async () => {
    await copy?.end();
  });
  if (database)
    await attempt(() => pool.query(`DROP DATABASE ${restoreDatabaseName(database!)} WITH (FORCE)`));
  if (beforeDatabases)
    await attempt(async () => {
      assert.deepEqual(
        (
          await pool.query(
            'SELECT datname FROM pg_database WHERE datistemplate=false ORDER BY datname',
          )
        ).rows.map((r) => r.datname),
        beforeDatabases,
      );
    });
  if (source && beforeManifest)
    await attempt(() =>
      rr(source!, async () => {
        assert.deepEqual(await tableFingerprints(source!), beforeManifest);
        assert.equal(await schemaFingerprint(source!), beforeSchema);
      }),
    );
  await attempt(async () => {
    for (const [path, bytes] of [...originals, ...publicOriginals])
      assert.deepEqual(await readFile(path), bytes);
  });
  await attempt(async () => {
    await source?.end();
  });
  await attempt(() => pool.end());
  if (errors.length) {
    process.exitCode = 1;
    report = {
      ...report,
      status: 'FAIL',
      cleanup_or_preservation_failed: true,
      cleanup_errors: errors.length,
      full_goal_complete: false,
    };
  }
  if (report) {
    report.cleanup_owned_copy_only = true;
    report.source_manifest_exact = Boolean(beforeManifest) && !errors.length;
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }).catch(
      () => {
        process.exitCode = 1;
      },
    );
    process.stdout.write(
      JSON.stringify({
        stage: 129,
        status: report.status,
        phase: 'native-recovery',
        full_goal_complete: false,
      }) + '\n',
    );
  }
}
