/** Root-run source-only QA157 preparation. No catalog preview/commit, worker,
 * provider, migration, restore, or automatic retry. Unknown results require
 * manual custody inspection. This fixture is PREPARED_NOT_ACCEPTED.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Pool } from 'pg';

const root = '<workspace>/app';
const base = 'http://127.0.0.1:4100/api';
const config = resolve(root, '.local.json');
const journal = resolve(root, 'data/product-catalogs-stage157.json');
const report = resolve(root, 'docs/product-catalogs-native157-setup.json');
const revision = process.env.QA_EXPECTED_REVISION ?? '';
const schema = '142_product_catalogs';
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const fp = (v: unknown) => sha(JSON.stringify(v));
let state: any;
let pool: Pool | undefined;
let step = 'preflight';

function uuid(v: unknown): string {
  assert.equal(typeof v, 'string');
  assert.match(v as string, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  return v as string;
}
async function absent(file: string) {
  try { await lstat(file); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  throw Error('Exclusive output exists');
}
async function privateRead(file: string) {
  const s = await lstat(file);
  assert(s.isFile() && !s.isSymbolicLink());
  assert.equal(s.mode & 0o777, 0o600);
  assert(s.size > 0 && s.size <= 64 * 1024 * 1024);
  return readFile(file);
}
async function wx(file: string, value: unknown, mode = 0o600) {
  const f = await open(file, 'wx', mode);
  try { await f.writeFile(JSON.stringify(value, null, 2) + '\n'); await f.sync(); }
  finally { await f.close(); }
}
async function save() {
  await privateRead(journal);
  const temp = journal + '.' + randomUUID() + '.tmp';
  try {
    await wx(temp, state);
    await rename(temp, journal);
    const d = await open(dirname(journal), 'r');
    try { await d.sync(); } finally { await d.close(); }
  } finally { await unlink(temp).catch(() => undefined); }
}
function headers() {
  return {
    'Content-Type': 'application/json',
    ...(state?.actor.cookie ? { cookie: state.actor.cookie, 'X-Workspace-ID': state.actor.tenant_id } : {}),
  };
}
async function body(r: Response): Promise<any> {
  const b = Buffer.from(await r.arrayBuffer());
  assert(b.length <= 16 * 1024 * 1024);
  return JSON.parse(b.toString('utf8'));
}
async function get(route: string): Promise<any> {
  assert(route.startsWith('/') && !route.includes('://'));
  const r = await fetch(base + route, { headers: headers(), redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000) });
  assert.equal(r.status, 200, 'Own scoped GET');
  return body(r);
}
async function health() {
  const h = await get('/health');
  assert.equal(h.status, 'ok'); assert.equal(h.revision, revision);
  assert.equal(h.schema_revision, schema); assert.equal(h.mode, 'local');
  assert.equal(h.restore_preview, false); assert.equal(h.background_workers_enabled, false);
  assert.equal(h.product_catalogs_available, true);
}
async function identity() {
  const m = await get('/auth/me');
  assert.equal(m.user.id, state.actor.user_id);
  assert.equal(m.user.tenant_id, state.actor.tenant_id); assert.equal(m.user.role, 'admin');
}
async function post(label: string, route: string, b: unknown, expected: number, assign: (data: any, r: Response) => void) {
  step = label; assert.equal(state.pending, null);
  const fixed = ['/auth/signup', '/workspaces/billing/preview', '/warehouses', '/price-lists', '/products'];
  assert(fixed.includes(route) || (state.actor.billing_preview?.id && route === '/workspaces/billing/previews/' + state.actor.billing_preview.id + '/commit'));
  await health(); if (route !== '/auth/signup') await identity();
  state.pending = { label, method: 'POST', route, body: b, expected_status: expected, response: null };
  state.status = 'PENDING_WRITE'; await save();
  let r: Response, d: any;
  try {
    r = await fetch(base + route, { method: 'POST', headers: headers(), body: JSON.stringify(b), redirect: 'error', signal: AbortSignal.timeout(90000) });
    d = await body(r);
  } catch {
    state.status = 'UNKNOWN_RESULT_DO_NOT_RETRY'; await save();
    throw Error('Unconfirmed write');
  }
  state.pending.response = { status: r.status, data: d }; await save();
  assert.equal(r.status, expected, 'Exact fixture write status');
  assign(d, r); await save();
  state.completed.push({ label, route, status: r.status, response_sha256: fp(d) });
  state.pending = null; state.status = 'CONFIRMED'; await save();
}
async function capture() {
  const c = await pool!.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TimeZone='UTC'");
    const names = (await c.query("SELECT table_name FROM information_schema.tables t WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name<>'sessions' AND (table_name IN('users','tenants') OR EXISTS(SELECT 1 FROM information_schema.columns k WHERE k.table_schema=t.table_schema AND k.table_name=t.table_name AND k.column_name='tenant_id')) ORDER BY 1")).rows;
    const rows: Record<string, any[]> = {}, snapshot: Record<string, { count: number; sha256: string }> = {};
    for (const { table_name: name } of names) {
      assert.match(name, /^[a-z][a-z0-9_]*$/);
      const key = ['users', 'tenants'].includes(name) ? 'id' : 'tenant_id';
      const target = name === 'users' ? state.actor.user_id : state.actor.tenant_id;
      rows[name] = (await c.query(`SELECT to_jsonb(x) row FROM "${name}" x WHERE ${key}=$1 ORDER BY 1`, [target])).rows;
      snapshot[name] = { count: rows[name].length, sha256: fp(rows[name]) };
    }
    await c.query('COMMIT'); return { rows, snapshot };
  } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
}
async function prepare() {
  const a = state.actor;
  await post('signup', '/auth/signup', {
    name: 'QA157 Own Catalog Admin', email: a.email, password: a.password,
    organization: { name: 'QA157 Own Catalog ' + state.suffix, currency: 'PLN', locale: 'pl-PL' },
  }, 201, (d, r) => {
    a.user_id = uuid(d.user.id); a.tenant_id = uuid(d.user.tenant_id);
    a.cookie = (r.headers.get('set-cookie') ?? '').split(';')[0]; assert(a.cookie.startsWith('dyna_session='));
  });
  const wh = await get('/warehouses'); assert.equal(wh.data.length, 1);
  a.warehouses.push(wh.data[0]); a.warehouse_id = uuid(wh.data[0].id); await save();
  const billing = await get('/workspaces/billing');
  assert.equal(billing.mode, 'local_estimate'); assert.equal(billing.current_plan, 'starter'); assert.equal(billing.account, null);
  await post('own-local-entitlement-preview', '/workspaces/billing/preview', { kind: 'activate', plan: 'enterprise' }, 200, d => {
    assert.equal(d.mode, 'local_estimate'); assert.equal(d.can_commit, true); assert.deepEqual(d.blockers, []);
    uuid(d.id); a.billing_preview = d;
  });
  await post('own-local-entitlement-commit', '/workspaces/billing/previews/' + a.billing_preview.id + '/commit', {}, 200, d => {
    assert.equal(d.mode, 'local_estimate'); assert.equal(d.plan, 'enterprise'); a.billing_commit = d;
  });
  await post('own-second-warehouse', '/warehouses', { name: 'QA157 SECOND', code: 'QA157-' + state.suffix }, 200, d => {
    uuid(d.id); a.warehouses.push(d);
  });
  a.warehouse_ids = a.warehouses.map((w: any) => uuid(w.id)); await save();
  for (const currency of ['PLN', 'EUR']) {
    await post('own-empty-list-' + currency, '/price-lists', { name: 'QA157 ' + currency + ' ' + state.suffix, currency, fallback: false, adjustment_bps: 0, adjustment_amount: 0 }, 201, d => {
      uuid(d.id); assert.equal(d.currency, currency); a.price_lists.push(d);
    });
  }
  for (let i = 0; i < 2; i++) {
    await post('own-zero-stock-product-' + i, '/products', {
      name: 'QA157 Default Product ' + (i + 1), sku: 'QA157-' + state.suffix + '-' + (i + 1), kind: 'simple',
      price: i === 0 ? 0 : 12345, vat: 23, quantity: 0, warehouse_id: a.warehouse_ids[i], location: 'QA157-01',
    }, 201, d => { uuid(d.id); a.products.push(d); });
  }
  const options = await get('/product-catalogs/options');
  assert.equal(options.available, true); assert.equal(options.can_manage, true);
  assert.equal(options.current_role, 'admin'); assert.equal(options.read_only, false);
  const catalogs = await get('/product-catalogs');
  assert.equal(catalogs.data.length, 1); assert.equal(catalogs.next_cursor, null);
  const head = (await get('/product-catalogs/' + uuid(catalogs.data[0].id))).catalog;
  assert.equal(head.is_default, true); assert.equal(head.active, true);
  assert.deepEqual([...head.warehouse_ids].sort(), [...a.warehouse_ids].sort());
  assert.deepEqual([...head.price_list_ids].sort(), a.price_lists.map((p: any) => p.id).sort());
  const products = await Promise.all(a.products.map((p: any) => get('/products/' + p.id)));
  for (const p of products) assert.equal(p.catalog_id, head.id);
  const lists = await Promise.all(a.price_lists.map((p: any) => get('/price-lists/' + p.id + '/items')));
  for (const list of lists) { assert.deepEqual(list.data, []); assert.equal(list.meta.cursor, null); }
  a.default_catalog_id = head.id;
  state.source_born = { options, catalogs, catalog: head, products, warehouses: await get('/warehouses'), price_lists: lists };
  state.setup_checkpoint = await capture();
  const s = state.setup_checkpoint.snapshot;
  assert.equal(s.product_catalogs.count, 1);
  for (const table of ['product_catalog_previews', 'product_catalog_operations', 'product_catalog_admissions', 'orders', 'payment_entries', 'documents', 'return_cases']) assert.equal(s[table].count, 0, 'No fixture acceptance/commerce graph');
  assert.equal(s.products.count, 2);
  for (const x of state.setup_checkpoint.rows.stock) { assert.equal(x.row.on_hand, 0); assert.equal(x.row.reserved, 0); }
}
async function main() {
  assert.equal(process.cwd(), root); assert.equal(process.argv.length, 3); assert.equal(process.argv[2], 'prepare');
  assert.equal(process.env.DYNA_LOCAL_CONFIG_PATH, config);
  assert.equal(process.env.DYNA_WORKER_DISABLED, 'true');
  assert(!process.env.DYNA_TEST); assert.equal(process.env.APP_REVISION, revision);
  assert.match(revision, /^[a-f0-9]{40}$/);
  assert.equal(process.env.QA157_SETUP_CONFIRM, 'CREATE_ONE_NEW_OWN_CATALOG_FIXTURE');
  for (const d of ['data', 'docs']) { const s = await lstat(resolve(root, d)); assert(s.isDirectory() && !s.isSymbolicLink()); }
  const configBytes = await privateRead(config);
  await absent(journal); await absent(report); await health();
  pool = (await import('../server/db')).pool;
  const u = new URL(pool.options.connectionString!);
  assert.equal(u.hostname, '127.0.0.1'); assert.equal(u.port, '55432'); assert.equal(u.pathname, '/dynaminds');
  const native = (await pool.query('SELECT current_user role,current_database() db,host(inet_server_addr()) host,inet_server_port() port')).rows[0];
  assert.deepEqual(native, { role: 'postgres', db: 'dynaminds', host: '127.0.0.1', port: 55432 });
  const suffix = randomUUID().slice(0, 8);
  state = { stage: 157, revision, runtime_revision: revision, schema_revision: schema, suffix,
    status: 'PREPARED_NOT_ACCEPTED', complete: false, pending: null, completed: [],
    actor: { email: 'qa157-' + suffix + '@demo.local', password: 'QA157-' + randomBytes(24).toString('hex'), cookie: '', warehouses: [], price_lists: [], products: [] },
    config_sha256: sha(configBytes), provider_verified: false, chrome_verified: false, full_goal_complete: false };
  await wx(journal, state); await prepare(); await identity(); await health();
  assert((await privateRead(config)).equals(configBytes)); assert.equal(state.pending, null); assert.equal(state.completed.length, 8);
  state.complete = true; state.status = 'PREPARED_NOT_ACCEPTED'; await save();
  await wx(report, { stage: 157, status: 'PREPARED_NOT_ACCEPTED', revision, schema_revision: schema,
    tenant_id: state.actor.tenant_id, warehouse_ids: state.actor.warehouse_ids, price_list_ids: state.actor.price_lists.map((p: any) => p.id), product_ids: state.actor.products.map((p: any) => p.id), default_catalog_id: state.actor.default_catalog_id,
    successful_writes: state.completed.length, own_tables: Object.keys(state.setup_checkpoint.snapshot).length,
    own_snapshot_sha256: fp(state.setup_checkpoint.snapshot), setup_file_sha256: sha(await privateRead(journal)),
    own_local_entitlement_only: true, catalog_previews: 0, catalog_operations: 0, initial_stock: 0,
    config_unchanged: true, earlier_firms_preservation_verified: false, chrome_verified: false, provider_verified: false, full_goal_complete: false }, 0o644);
  process.stdout.write('QA157_PREPARED_NOT_ACCEPTED\n');
}
main().catch(async () => {
  if (state) { state.status = state.pending ? 'UNKNOWN_OR_UNCONFIRMED_DO_NOT_RETRY' : 'PREPARATION_FAILED_DO_NOT_RETRY'; await save().catch(() => undefined); }
  process.stderr.write('QA157_SETUP_FAILED_STEP_' + step + '_PRIVATE_DETAILS_WITHHELD\n'); process.exitCode = 1;
}).finally(async () => { await pool?.end(); });
