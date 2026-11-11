/** ROOT ONLY; authored without execution. Two NEW own local QA159 firms.
 * CLI: prepare | configure | refresh | bind | checkout | verify.
 * Each mutation has durable private pending custody BEFORE the call. Unknown
 * results stop permanently; no worker tick, provider, automatic retry or login.
 * Known continuation requires QA159_RESUME_KNOWN=true, exact journal SHA and
 * unchanged last confirmed full snapshot. Earlier checkpoint bytes never rebase.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Pool } from 'pg';

const ROOT = '<workspace>/app';
const WT = '<workspace>/worktrees/stock-file-import';
const BASE = 'http://127.0.0.1:4100/api';
const JOURNAL = resolve(ROOT, 'data/b2b-catalog-native159-flow.json');
const CONFIG = resolve(ROOT, '.local.json');
const PHASES = ['prepare', 'configure', 'refresh', 'bind', 'checkout', 'verify'] as const;
type Phase = typeof PHASES[number];
type Row = Record<string, any>;
const phase = process.argv[2] as Phase;
const revision = process.env.QA_EXPECTED_REVISION ?? '';
const schema = '145_order_merge_counters';
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const fp = (v: unknown) => sha(JSON.stringify(v));
const inputFiles = new Map<string, { digest: string; mode: number; max: number }>();
let state: Row | undefined, baseline: Row, prior: Row, pool: Pool | undefined;
let step = 'preflight', writableJournal = false;
function uuid(v: unknown): string {
  assert(typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v)); return v;
}
function id(v: string) { assert.match(v, /^[a-z][a-z0-9_]*$/); return '"' + v + '"'; }
async function privateFile(file: string, mode = 0o600, max = 256 * 1024 * 1024) {
  const s = await lstat(file); assert(s.isFile() && !s.isSymbolicLink());
  assert.equal(s.mode & 0o777, mode); assert(s.size > 0 && s.size <= max);
  return readFile(file);
}
async function pin(file: string, digest: string | undefined, mode = 0o600, max?: number) {
  assert(typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest));
  const bytes = await privateFile(file, mode, max); assert.equal(sha(bytes), digest);
  inputFiles.set(file, { digest, mode, max: max ?? 256 * 1024 * 1024 }); return bytes;
}
async function absent(file: string) {
  try { await lstat(file); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
  throw Error('Exclusive evidence exists');
}
async function wx(file: string, value: unknown, mode = 0o600) {
  const bytes = JSON.stringify(value, null, 2) + '\n'; assert(Buffer.byteLength(bytes) <= 256 * 1024 * 1024);
  const f = await open(file, 'wx', mode);
  try { await f.writeFile(bytes); await f.sync(); } finally { await f.close(); }
  const d = await open(dirname(file), 'r'); try { await d.sync(); } finally { await d.close(); }
}
async function save() {
  await privateFile(JOURNAL);
  const temp = JOURNAL + '.' + randomUUID() + '.tmp';
  try {
    await wx(temp, state); await rename(temp, JOURNAL);
    const d = await open(dirname(JOURNAL), 'r'); try { await d.sync(); } finally { await d.close(); }
  } finally { await unlink(temp).catch(() => undefined); }
}
async function custody() {
  for (const [file, v] of inputFiles) assert.equal(sha(await privateFile(file, v.mode, v.max)), v.digest);
  for (const [name, v] of Object.entries(prior.private_files) as [string, Row][]) {
    assert.match(name, /^[A-Za-z0-9_.-]+\.json$/);
    assert.equal(sha(await privateFile(resolve(ROOT, 'data', name), v.mode)), v.sha256);
  }
}
function headers(a?: Row) {
  return { 'Content-Type': 'application/json', ...(a?.cookie ? { cookie: a.cookie, 'X-Workspace-ID': uuid(a.tenant_id) } : {}) };
}
async function response(r: Response): Promise<Row> {
  const bytes = Buffer.from(await r.arrayBuffer()); assert(bytes.length <= 16 * 1024 * 1024);
  return JSON.parse(bytes.toString('utf8'));
}
async function get(a: Row | undefined, route: string): Promise<Row> {
  // No arbitrary URL or invisible GET that creates a session/worker/provenance.
  assert(/^\/(health|auth\/me|warehouses|price-lists|product-catalogs(?:\/options|\/[a-f0-9-]+)?|products\/[a-f0-9-]+|b2b\/(?:accounts\/[a-f0-9-]+\/catalog-scope|catalog-scope\/(?:previews|operations)\/[a-f0-9-]+|network\/links\/[a-f0-9-]+(?:\/(?:catalog|runs|catalog-scope|orders(?:\/[a-f0-9-]+)?))?))$/.test(route));
  const r = await fetch(BASE + route, { method: 'GET', headers: headers(a), redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000) });
  assert.equal(r.status, 200); return response(r);
}
async function health() {
  const h = await get(undefined, '/health'); assert.equal(h.status, 'ok'); assert.equal(h.revision, revision);
  assert.equal(h.schema_revision, schema); assert.equal(h.mode, 'local'); assert.equal(h.restore_preview, false);
  assert.equal(h.background_workers_enabled, false); assert.equal(h.product_catalogs_available, true); assert.equal(h.b2b_catalog_scope_available, true);
}
async function identity(a: Row) {
  uuid(a.tenant_id); uuid(a.user_id); const m = await get(a, '/auth/me');
  assert.equal(m.user.id, a.user_id); assert.equal(m.user.tenant_id, a.tenant_id); assert.equal(m.user.role, 'admin');
}
async function capture() {
  const c = await pool!.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); await c.query("SET LOCAL TimeZone='UTC'");
    const tables: string[] = (await c.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name<>'sessions' ORDER BY 1")).rows.map(r => r.table_name);
    assert.deepEqual(tables, Object.keys(baseline.capture.tables).sort(), 'No schema/table drift');
    const tenants = Object.values(state!.actors).filter((a: any) => a.tenant_id).map((a: any) => uuid(a.tenant_id));
    const users = Object.values(state!.actors).filter((a: any) => a.user_id).map((a: any) => uuid(a.user_id));
    const own: Record<string, Row[]> = {}, snapshot: Record<string, Row> = {};
    for (const name of tables) {
      const cols: string[] = (await c.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position", [name])).rows.map(r => r.column_name);
      assert.deepEqual(cols, baseline.capture.tables[name].columns, 'Exact baseline columns');
      const key = name === 'users' || name === 'tenants' ? 'id' : cols.includes('tenant_id') ? 'tenant_id' : cols.includes('user_id') ? 'user_id' : null;
      const ids = name === 'users' || key === 'user_id' ? users : tenants;
      const oldRows = (await c.query(`SELECT to_jsonb(x) row FROM ${id(name)} x${key ? ` WHERE ${id(key)} IS NULL OR NOT (${id(key)}=ANY($1::uuid[]))` : ''} ORDER BY 1`, key ? [ids] : [])).rows;
      assert.deepEqual({ count: oldRows.length, sha256: fp(oldRows) }, baseline.capture.tables[name].fingerprint, 'Every old global row retained: ' + name);
      if (key) {
        own[name] = (await c.query(`SELECT to_jsonb(x) row FROM ${id(name)} x WHERE ${id(key)}=ANY($1::uuid[]) ORDER BY 1`, [ids])).rows;
        snapshot[name] = { count: own[name].length, sha256: fp(own[name]) };
      }
    }
    assert(tenants.length <= 2 && users.length <= 2);
    const g = (await c.query('SELECT public.b2b_catalog_scope_installed() installed,public.b2b_catalog_scope_guards() guards')).rows[0];
    assert.deepEqual(g, { installed: true, guards: true }); await c.query('COMMIT'); return { rows: own, snapshot };
  } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
}
function key(label: string) { return state!.keys[label] ?? (state!.keys[label] = randomUUID()); }
const operations = () => state!.completed as Row[];
async function write(label: string, actor: Row, method: 'POST' | 'PATCH' | 'PUT', route: string, body: Row, expected: number, assign: (d: Row, r: Response) => void) {
  step = label; assert.equal(state!.pending, null);
  const allowed = /^\/(?:auth\/signup|workspaces\/billing\/preview|workspaces\/billing\/previews\/[a-f0-9-]+\/commit|price-lists(?:\/[a-f0-9-]+\/items)?|products|product-catalogs\/previews(?:\/[a-f0-9-]+\/commit)?|b2b\/accounts(?:\/[a-f0-9-]+(?:\/network-invite|\/catalog-scope\/previews)?)?|b2b\/catalog-scope\/previews\/[a-f0-9-]+\/commit|b2b\/network\/accept|b2b\/network\/links\/[a-f0-9-]+\/(?:catalog-scope\/previews|refresh|catalog\/[a-f0-9-]+\/bind|quotes(?:\/[a-f0-9-]+\/checkout)?))$/;
  assert(allowed.test(route));
  const known = operations().find(v => v.label === label);
  if (known) { assert.equal(known.actor, actor.kind); assert.equal(known.method, method); assert.equal(known.route, route); assert.deepEqual(known.body, body); return; }
  await custody(); await health(); if (route !== '/auth/signup') await identity(actor);
  if (state!.last_capture) assert.deepEqual(await capture(), state!.last_capture, 'No drift before next mutation');
  state!.pending = { label, actor: actor.kind, method, route, body, expected_status: expected }; state!.status = 'PENDING_WRITE'; await save();
  const r = await fetch(BASE + route, { method, headers: headers(actor), body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(90000) });
  const d = await response(r); state!.pending.response = { status: r.status, data: d }; await save();
  assert.equal(r.status, expected); assign(d, r);
  state!.last_capture = await capture();
  operations().push({ label, actor: actor.kind, method, route, body, status: r.status, response_sha256: fp(d) });
  state!.pending = null; state!.status = 'CONFIRMED'; await save();
}
async function prepare() {
  // Exactly two fresh actors; passwords are stored only in private custody.
  for (const a of [state!.actors.supplier, state!.actors.buyer]) {
    await write(a.kind + '-signup', a, 'POST', '/auth/signup', { name: 'QA159 Own ' + a.kind,
      email: a.email, password: a.password, organization: { name: 'QA159 ' + a.kind + ' ' + state!.suffix, currency: 'PLN', locale: 'pl-PL' } }, 201, (d, r) => {
      a.user_id = uuid(d.user.id); a.tenant_id = uuid(d.user.tenant_id);
      a.cookie = (r.headers.get('set-cookie') ?? '').split(';')[0]; assert(/^dyna_session=[A-Za-z0-9_.-]+$/.test(a.cookie));
    });
    await identity(a); const wh = await get(a, '/warehouses'); assert.equal(wh.data.length, 1); a.warehouse_id = uuid(wh.data[0].id);
    await write(a.kind + '-enterprise-preview', a, 'POST', '/workspaces/billing/preview', { kind: 'activate', plan: 'enterprise' }, 200, d => {
      assert.equal(d.mode, 'local_estimate'); assert.equal(d.can_commit, true); assert.deepEqual(d.blockers, []); a.billing_preview = d;
    });
    await write(a.kind + '-enterprise-commit', a, 'POST', '/workspaces/billing/previews/' + uuid(a.billing_preview.id) + '/commit', {}, 200, d => {
      assert.equal(d.mode, 'local_estimate'); assert.equal(d.plan, 'enterprise'); a.billing_commit = d;
    });
    await write(a.kind + '-price-list', a, 'POST', '/price-lists', { name: 'QA159 ' + a.kind + ' PLN', currency: 'PLN' }, 201, d => { uuid(d.id); a.list = d; });
    const options = await get(a, '/product-catalogs/options'); assert.equal(options.available, true); assert.equal(options.can_manage, true);
    await write(a.kind + '-catalog-preview', a, 'POST', '/product-catalogs/previews', { client_key: key(a.kind + '-catalog-preview'), kind: 'create',
      settings: { name: 'QA159 ' + a.kind + ' selected', active: true, languages: ['pl'], default_language: 'pl', warehouse_ids: [a.warehouse_id], price_list_ids: [a.list.id] } }, 201, d => { assert.equal(d.preview.ready, true); a.catalog_preview = d.preview; });
    await write(a.kind + '-catalog-commit', a, 'POST', '/product-catalogs/previews/' + uuid(a.catalog_preview.id) + '/commit',
      { client_key: key(a.kind + '-catalog-commit'), scope_hash: a.catalog_preview.scope_hash, confirmed: true }, 201, d => { uuid(d.catalog.id); a.catalog = d.catalog; });
    for (const selected of [true, false]) {
      const label = a.kind + (selected ? '-selected-product' : '-default-product');
      await write(label, a, 'POST', '/products', { ...(selected ? { catalog_id: a.catalog.id } : {}), sku: 'QA159-' + state!.suffix + '-' + label,
        name: 'QA159 ' + label, kind: 'simple', price: 1000, vat: 23, quantity: a.kind === 'supplier' ? selected ? 2 : 3 : 0,
        warehouse_id: a.warehouse_id, location: 'QA159-01' }, 201, d => { uuid(d.id); a[selected ? 'selected' : 'other'] = d; });
    }
    const selected = await get(a, '/products/' + uuid(a.selected.id)), other = await get(a, '/products/' + uuid(a.other.id));
    assert.equal(selected.catalog_id, a.catalog.id); assert.notEqual(other.catalog_id, a.catalog.id);
    await write(a.kind + '-prices', a, 'PUT', '/price-lists/' + uuid(a.list.id) + '/items', { version: a.list.version,
      items: [{ product_id: a.selected.id, price: 777 }, { product_id: a.other.id, price: 999 }] }, 200, d => { a.list_current_version = d.version; });
  }
}
async function configure() {
  const s = state!.actors.supplier, b = state!.actors.buyer;
  const account = { name: 'QA159 Own buyer', email: b.email, warehouse_id: s.warehouse_id, price_list_id: s.list.id,
    address: { street: 'QA159 Local 1', city: 'Warszawa', postal_code: '00-159', country: 'PL' }, payment_mode: 'prepaid' };
  await write('supplier-account-create', s, 'POST', '/b2b/accounts', account, 201, d => { s.account = d; });
  await write('supplier-account-active', s, 'PATCH', '/b2b/accounts/' + uuid(s.account.id), { ...account, version: s.account.version, active: true, confirmed: true }, 200, d => { s.active_account = d; });
  await write('supplier-scope-preview', s, 'POST', '/b2b/accounts/' + s.account.id + '/catalog-scope/previews', {
    client_key: key('supplier-scope-preview'), account_version: String(s.active_account.version), catalog_id: s.catalog.id, catalog_version: s.catalog.version,
    warehouse_id: s.warehouse_id, price_list_id: s.list.id, language: 'pl' }, 201, d => { assert.equal(d.preview.ready, true); s.scope_preview = d.preview; });
  await write('supplier-scope-commit', s, 'POST', '/b2b/catalog-scope/previews/' + uuid(s.scope_preview.id) + '/commit', {
    client_key: key('supplier-scope-commit'), scope_hash: s.scope_preview.scope_hash, confirmed: true }, 201, d => { s.scope_operation = d.operation; });
  await write('own-network-invitation', s, 'POST', '/b2b/accounts/' + s.account.id + '/network-invite', {
    version: Number(s.scope_operation.after.version), recipient_email: b.email, confirmed: true }, 200, d => { assert.match(d.token, /^[a-f0-9]{64}$/); state!.invitation = d; });
  await write('buyer-accept-invitation', b, 'POST', '/b2b/network/accept', { token: state!.invitation.token, confirmed: true }, 200, d => {
    uuid(d.id); assert.equal(d.supplier_tenant_id, s.tenant_id); assert.equal(d.account_id, s.account.id); b.link = d;
  });
  await write('buyer-scope-preview', b, 'POST', '/b2b/network/links/' + b.link.id + '/catalog-scope/previews', {
    client_key: key('buyer-scope-preview'), link_version: String(b.link.version), target_catalog_id: b.catalog.id, target_catalog_version: b.catalog.version }, 201, d => { assert.equal(d.preview.ready, true); b.scope_preview = d.preview; });
  await write('buyer-scope-commit', b, 'POST', '/b2b/catalog-scope/previews/' + uuid(b.scope_preview.id) + '/commit', {
    client_key: key('buyer-scope-commit'), scope_hash: b.scope_preview.scope_hash, confirmed: true }, 201, d => { b.scope_operation = d.operation; });
}
function workerDelta(before: Row, after: Row, actor: Row) {
  const permitted = new Set(['jobs', 'b2b_catalog_runs', 'b2b_catalog_staging', 'b2b_catalog_items', 'b2b_links']);
  for (const name of Object.keys(before.rows)) {
    if (!permitted.has(name)) { assert.deepEqual(after.rows[name], before.rows[name], 'Worker changes only its catalog graph: ' + name); continue; }
    const key = name === 'jobs' ? 'id' : name === 'b2b_catalog_runs' ? 'id' : name === 'b2b_links' ? 'id' : name === 'b2b_catalog_staging' ? 'run_id' : 'link_id';
    const target = name === 'jobs' ? actor.run.job_id : ['b2b_catalog_runs', 'b2b_catalog_staging'].includes(name) ? actor.run.id : actor.link.id;
    const other = (rows: Row[]) => rows.filter(v => v.row.tenant_id !== actor.tenant_id || v.row[key] !== target);
    assert.deepEqual(other(after.rows[name]), other(before.rows[name]), 'Other own graph rows retained: ' + name);
    if (name === 'jobs') {
      const old = before.rows[name].find((v: Row) => v.row.id === target)?.row, fresh = after.rows[name].find((v: Row) => v.row.id === target)?.row;
      assert(old && fresh); const lifecycle = new Set(['state', 'attempts', 'lease_token', 'locked_at', 'error', 'run_at']);
      const immutable = (v: Row) => Object.fromEntries(Object.entries(v).filter(([k]) => !lifecycle.has(k)));
      assert.deepEqual(immutable(fresh), immutable(old), 'Chosen job identity/payload preserved');
    }
  }
}
async function refresh() {
  const b = state!.actors.buyer, s = state!.actors.supplier, route = '/b2b/network/links/' + uuid(b.link.id);
  await write('buyer-refresh', b, 'POST', route + '/refresh', { client_key: key('buyer-refresh'), confirmed: true }, 200, d => { uuid(d.id); uuid(d.job_id); b.run = d; });
  const processCatalog = (await import('../server/b2b-network')).processB2bCatalog;
  for (let page = 0; page < 5; page++) {
    const known = operations().find(op => op.label === 'refresh-page-' + page); if (known) continue;
    const r = (await pool!.query('SELECT * FROM b2b_catalog_runs WHERE tenant_id=$1 AND id=$2', [b.tenant_id, b.run.id])).rows[0];
    assert(r && r.job_id === b.run.job_id && r.link_id === b.link.id && r.actor_id === b.user_id);
    if (r.state === 'done') break;
    assert.equal(r.state, 'queued'); await custody(); await health(); await identity(b);
    const beforePage = await capture(); assert.deepEqual(beforePage, state!.last_capture);
    step = 'refresh-page-' + page;
    const lease = randomUUID(); state!.pending = { label: step, method: 'OWN_JOB_CLAIM_AND_ONE_PAGE', tenant_id: b.tenant_id,
      job_id: b.run.job_id, run_id: b.run.id, lease_token: lease, page }; state!.status = 'PENDING_WORKER_PAGE'; await save();
    // Precisely one known own job. No queue scan, worker tick, fail/retry helper,
    // stale lease reclaim or other job is executable through this script.
    const c = await pool!.connect(); let job: Row;
    try {
      await c.query('BEGIN');
      const current = (await c.query('SELECT * FROM jobs WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [b.tenant_id, b.run.job_id])).rows[0];
      assert(current && current.state === 'pending' && current.kind === 'b2b.catalog' && current.attempts === 0 && current.lease_token === null);
      assert.equal(current.payload.run_id, b.run.id); assert.equal(current.payload.link_id, b.link.id); assert.equal(current.payload.actor_id, b.user_id);
      assert.equal(current.payload.api_key_id, null); assert.equal(current.payload.catalog_scope_hash, r.catalog_scope_hash);
      job = (await c.query("UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$3,locked_at=now() WHERE tenant_id=$1 AND id=$2 AND state='pending' AND lease_token IS NULL RETURNING *", [b.tenant_id, b.run.job_id, lease])).rows[0];
      assert(job); await c.query('COMMIT');
    } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
    await processCatalog(job!);
    const after = (await pool!.query('SELECT * FROM jobs WHERE tenant_id=$1 AND id=$2', [b.tenant_id, b.run.job_id])).rows[0];
    assert(['pending', 'done'].includes(after.state)); assert.equal(after.lease_token, null); assert.equal(after.attempts, 0);
    const afterPage = await capture(); workerDelta(beforePage, afterPage, b);
    state!.last_capture = afterPage; operations().push({ label: step, job_id: b.run.job_id, page, state: after.state });
    state!.pending = null; state!.status = 'CONFIRMED'; await save();
  }
  const run = (await pool!.query('SELECT * FROM b2b_catalog_runs WHERE tenant_id=$1 AND id=$2', [b.tenant_id, b.run.id])).rows[0];
  assert.equal(run.state, 'done'); assert.equal(run.fetched, 1); assert.equal(run.catalog_scope.supplier.catalog_id, s.catalog.id);
  assert.equal(run.catalog_scope.buyer.target_catalog_id, b.catalog.id);
  const page = await get(b, route + '/catalog'); assert.equal(page.data.length, 1); assert.equal(page.next, null);
  assert.equal(page.data[0].source_product_id, s.selected.id); assert.equal(page.data[0].snapshot.price, 777); assert.equal(page.data[0].snapshot.available, 2);
  assert.equal(page.target_catalog.id, b.catalog.id); b.item = page.data[0]; state!.publication = page; await save();
}
async function bind() {
  const b = state!.actors.buyer;
  const body = { client_key: key('bind'), version: b.item.version, product_id: b.selected.id, confirmed: true };
  const route = '/b2b/network/links/' + uuid(b.link.id) + '/catalog/' + uuid(b.item.id) + '/bind';
  await write('bind-own-existing-target', b, 'POST', route, body, 201, d => {
    assert.equal(d.reused, false); assert.equal(d.binding.item_id, b.item.id); assert.equal(d.binding.product_id, b.selected.id);
    assert.equal(d.binding.item_version_after, b.item.version + 1); assert.equal(d.binding.quantity, 0); b.binding = d.binding;
  });
  const before = await capture();
  await write('bind-exact-replay', b, 'POST', route, body, 200, d => { assert.equal(d.reused, true); assert.deepEqual(d.binding, b.binding); });
  assert.deepEqual(await capture(), before, 'Bind replay has no business/audit effect');
}
async function checkout() {
  const b = state!.actors.buyer, route = '/b2b/network/links/' + uuid(b.link.id);
  const body = { client_key: key('quote'), warehouse_id: b.warehouse_id, items: [{ item_id: b.item.id, quantity: 1 }] };
  await write('quote-one-own-unit', b, 'POST', route + '/quotes', body, 200, d => {
    uuid(d.id); uuid(d.source_quote_id); assert.equal(d.summary.total_gross, 777); assert.equal(d.summary.shipping_gross, 0);
    assert.equal(d.summary.items.length, 1); assert.equal(d.summary.items[0].product_id, b.selected.id); b.quote = d;
  });
  await write('checkout-one-own-unit', b, 'POST', route + '/quotes/' + uuid(b.quote.id) + '/checkout', { confirmed: true }, 200, d => {
    uuid(d.id); assert.equal(d.quote_id, b.quote.id); assert.equal(d.total_gross, 777); b.purchase = d;
  });
  const accepted = await capture();
  await write('checkout-exact-replay', b, 'POST', route + '/quotes/' + b.quote.id + '/checkout', { confirmed: true }, 200, d => { assert.deepEqual(d, b.purchase); });
  assert.deepEqual(await capture(), accepted, 'Checkout exact replay no second reservation/order/audit');
  // Network quotes remain immutable; only the separate supplier b2b_quotes row
  // receives its source order_id. Do not invent that field on this network DTO.
  await write('quote-exact-replay-after-checkout', b, 'POST', route + '/quotes', body, 200, d => {
    assert.deepEqual(d, b.quote); b.quote_after_checkout = d;
  });
  assert.deepEqual(await capture(), accepted, 'Historical quote replay no write');
}
async function verify() {
  const s = state!.actors.supplier, b = state!.actors.buyer;
  await identity(s); await identity(b); const captured = await capture(); assert.deepEqual(captured, state!.last_capture);
  const rows = (name: string, tenant: string) => (captured.rows[name] ?? []).map(v => v.row).filter(v => v.tenant_id === tenant);
  assert.equal(rows('products', s.tenant_id).length, 2); assert.equal(rows('products', b.tenant_id).length, 2);
  const sStock = rows('stock', s.tenant_id).find(r => r.product_id === s.selected.id && r.warehouse_id === s.warehouse_id);
  assert(sStock); assert.equal(sStock.on_hand, 2); assert.equal(sStock.reserved, 1);
  const otherStock = rows('stock', s.tenant_id).find(r => r.product_id === s.other.id && r.warehouse_id === s.warehouse_id);
  assert(otherStock); assert.equal(otherStock.on_hand, 3); assert.equal(otherStock.reserved, 0);
  assert(rows('stock', b.tenant_id).every(r => r.on_hand === 0 && r.reserved === 0));
  for (const tenant of [s.tenant_id, b.tenant_id]) assert.equal(rows('wms_policies', tenant).length, 0, 'This fixture is explicitly WMS OFF');
  const reservations = rows('reservations', s.tenant_id); assert.equal(reservations.length, 1);
  assert.equal(reservations[0].product_id, s.selected.id); assert.equal(reservations[0].quantity, 1); assert.equal(reservations[0].state, 'active');
  assert.equal(rows('orders', s.tenant_id).length, 1); assert.equal(rows('orders', b.tenant_id).length, 0);
  const order = rows('orders', s.tenant_id)[0]; assert.equal(order.id, b.purchase.source_order_id); assert.equal(order.total, 777);
  assert.equal(order.b2b_account_id, s.account.id); assert.equal(order.warehouse_id, s.warehouse_id);
  const supplierQuote = rows('b2b_quotes', s.tenant_id).find(q => q.id === b.quote.source_quote_id);
  assert(supplierQuote); assert.equal(supplierQuote.order_id, order.id);
  for (const tenant of [s.tenant_id, b.tenant_id]) for (const name of ['shipments', 'documents', 'return_cases', 'payment_entries']) assert.equal(rows(name, tenant).length, 0);
  assert.equal(rows('b2b_catalog_items', b.tenant_id).length, 1); const item = rows('b2b_catalog_items', b.tenant_id)[0];
  assert.equal(item.product_id, b.selected.id); assert.equal(item.source_product_id, s.selected.id); assert.equal(item.published, true);
  const bindings = rows('b2b_catalog_bindings', b.tenant_id); assert.equal(bindings.length, 1);
  assert.equal(bindings[0].id, b.binding.id); assert.equal(bindings[0].item_id, item.id); assert.equal(bindings[0].product_id, b.selected.id);
  assert.equal(bindings[0].link_id, b.link.id); assert.equal(bindings[0].actor_id, b.user_id); assert.equal(bindings[0].api_key_id, null);
  assert.equal(rows('b2b_network_orders', b.tenant_id).length, 1); assert.equal(rows('b2b_network_quotes', b.tenant_id).length, 1);
  assert.equal(rows('b2b_quotes', s.tenant_id).length, 1);
  assert.equal(rows('b2b_network_order_lines', b.tenant_id)[0].quantity, 1);
  const job = rows('jobs', b.tenant_id).find(j => j.id === b.run.job_id); assert(job); assert.equal(job.state, 'done');
  assert.equal(rows('b2b_catalog_staging', b.tenant_id).length, 0);
  const detail = await get(b, '/b2b/network/links/' + b.link.id + '/orders/' + uuid(b.purchase.id)); assert.deepEqual(detail, b.purchase);
  const sScope = await get(s, '/b2b/accounts/' + s.account.id + '/catalog-scope');
  const bScope = await get(b, '/b2b/network/links/' + b.link.id + '/catalog-scope');
  assert.equal(sScope.scope.catalog_id, s.catalog.id); assert.equal(bScope.scope.target_catalog_id, b.catalog.id);
  await custody(); await health(); assert.deepEqual(await capture(), captured);
  state!.verify_checkpoint = captured; state!.complete = true; state!.status = 'LOCAL_API_B2B_FLOW_VERIFIED'; await save();
}
async function main() {
  assert.equal(process.cwd(), ROOT); assert.equal(await realpath(ROOT), ROOT); assert.equal(process.argv.length, 3); assert(PHASES.includes(phase));
  assert.match(revision, /^[a-f0-9]{40}$/); assert.equal(process.env.APP_REVISION, revision);
  assert.equal(process.env.DYNA_LOCAL_CONFIG_PATH, CONFIG); assert.equal(process.env.DYNA_WORKER_DISABLED, 'true'); assert(!process.env.DYNA_TEST); assert(!process.env.DYNA_PREVIEW_PORT);
  assert.equal(process.env.QA159_FLOW_CONFIRM, 'CREATE_ONLY_TWO_NEW_OWN_QA159_FIRMS_AND_ONE_LOCAL_PURCHASE');
  for (const n of ['data', 'docs']) { const p = resolve(ROOT, n), s = await lstat(p); assert(s.isDirectory() && !s.isSymbolicLink()); assert.equal(await realpath(p), p); }
  const report = resolve(ROOT, 'docs/b2b-catalog-native159-flow-' + phase + '.json'); await absent(report);
  const beforeBytes = await pin(resolve(ROOT, 'data/b2b-catalog-native159-after-migration.json'), process.env.QA159_AFTER_MIGRATION_SHA256);
  baseline = JSON.parse(beforeBytes.toString()); assert.equal(baseline.stage, 159); assert.equal(baseline.phase, 'after-migration');
  assert.equal(baseline.schema_revision, schema); assert.equal(baseline.status, 'READ_ONLY_B2B_CATALOG_CHECKPOINT_PASS');
  const priorBytes = await pin(resolve(WT, 'docs/product-catalogs-preservation157-before.json'), baseline.inputs.preservation162, 0o644);
  prior = JSON.parse(priorBytes.toString()); assert.equal(prior.stage, 157); assert.equal(prior.status, 'PRESERVATION_PASS'); assert.equal(prior.tenants.length, 162);
  assert.equal(Object.keys(prior.private_files).length, 366); assert.equal(baseline.inputs.config, prior.config.sha256);
  await pin(CONFIG, baseline.inputs.config, 0o600, 65536);
  // Retain the original linked historical evidence files independently of any
  // later journal checkpoints; no baseline row/hash substitution is permitted.
  await pin(resolve(ROOT, 'data/product-catalogs-stage157.json'), baseline.inputs.setup157);
  await pin(resolve(ROOT, 'data/product-catalogs-checkpoint157-after-commerce.json'), baseline.inputs.accepted157);
  await pin(resolve(ROOT, 'data/catalog-export-catalogs-checkpoint158-before-native.json'), baseline.inputs.checkpoint158);
  await pin(resolve(ROOT, 'data/b2b-catalog-native159-before-migration.json'), baseline.inputs.before159);
  let continuing = false;
  try { await lstat(JOURNAL); continuing = true; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  if (continuing) {
    assert.equal(process.env.QA159_RESUME_KNOWN, 'true'); assert.match(process.env.QA159_FLOW_JOURNAL_SHA256 ?? '', /^[a-f0-9]{64}$/);
    const bytes = await privateFile(JOURNAL); assert.equal(sha(bytes), process.env.QA159_FLOW_JOURNAL_SHA256); state = JSON.parse(bytes.toString());
    assert.equal(state!.stage, 159); assert.equal(state!.schema_revision, schema); assert.equal(state!.after_migration_sha256, sha(beforeBytes));
    assert.equal(state!.pending, null); assert(!state!.status.includes('UNKNOWN')); assert.equal(state!.runtime_revision, revision);
    assert(state!.last_capture, 'Known continuation has an actual previous capture');
    assert.deepEqual(Object.keys(state!.actors).sort(), ['buyer', 'supplier']);
    assert(!state!.completed_phases.includes(phase), 'Completed phase is never automatically repeated');
  } else {
    assert.equal(phase, 'prepare'); assert.notEqual(process.env.QA159_RESUME_KNOWN, 'true');
    const suffix = randomUUID().slice(0, 8);
    state = { stage: 159, schema_revision: schema, runtime_revision: revision, suffix, after_migration_sha256: sha(beforeBytes),
      status: 'BORN_PRIVATE_CUSTODY', complete: false, pending: null, completed: [], completed_phases: [], keys: {},
      actors: Object.fromEntries(['supplier', 'buyer'].map(kind => [kind, { kind, email: 'qa159-' + suffix + '-' + kind + '@demo.local',
        password: 'QA159-' + randomBytes(24).toString('hex'), cookie: '' }])), provider_verified: false, native_ui_verified: false, full_goal_complete: false };
    await wx(JOURNAL, state); writableJournal = true;
  }
  const index = PHASES.indexOf(phase); assert.deepEqual(state!.completed_phases, PHASES.slice(0, index));
  await custody(); await health(); pool = (await import('../server/db')).pool;
  const u = new URL(pool.options.connectionString!); assert.equal(u.hostname, '127.0.0.1'); assert.equal(u.port, '55432'); assert.equal(u.pathname, '/dynaminds'); assert.equal(u.username, 'postgres');
  assert.deepEqual((await pool.query('SELECT current_user role,current_database() db,host(inet_server_addr()) host,inet_server_port() port')).rows[0],
    { role: 'postgres', db: 'dynaminds', host: '127.0.0.1', port: 55432 });
  const initial = await capture(); if (state!.last_capture) assert.deepEqual(initial, state!.last_capture, 'Known-only continuation exact last snapshot');
  else { state!.last_capture = initial; await save(); }
  for (const a of Object.values(state!.actors) as Row[]) if (a.tenant_id) await identity(a);
  writableJournal = true;
  step = phase; await ({ prepare, configure, refresh, bind, checkout, verify }[phase])(); await custody(); await health(); assert.equal(state!.pending, null);
  state!.completed_phases.push(phase); state!.last_capture = await capture(); await save();
  await wx(report, { stage: 159, phase, status: phase === 'verify' ? 'LOCAL_API_B2B_FLOW_VERIFIED' : 'CONFIRMED_PHASE_ONLY', revision, schema_revision: schema,
    actors: 2, completed_phases: state!.completed_phases, confirmed_operations: operations().length,
    manual_worker_pages: operations().filter(v => v.method === undefined && v.label.startsWith('refresh-page-')).length,
    after_migration_checkpoint_sha256: state!.after_migration_sha256, own_snapshot_sha256: fp(state!.last_capture.snapshot),
    journal_sha256: sha(await privateFile(JOURNAL)), all_old_global_rows_retained: true, original_private_files: Object.keys(prior.private_files).length,
    config_preserved: true, sessions_excluded: true, baseline_rebased: false, provider_verified: false, native_ui_verified: false, full_goal_complete: false }, 0o644);
  process.stdout.write('QA159_FLOW_CONFIRMED_PHASE_' + phase + '\n');
}
main().catch(async (error: unknown) => {
  if (state && writableJournal) { state.status = state.pending ? 'UNKNOWN_OR_UNCONFIRMED_DO_NOT_RETRY' : 'FAILED_WITH_KNOWN_RECEIPTS_ONLY'; await save().catch(() => undefined); }
  const stack = error instanceof Error ? error.stack ?? '' : '', m = stack.match(/b2b-catalog-native159-flow\.ts:(\d+):(\d+)/);
  process.stderr.write(JSON.stringify({ status: 'QA159_FLOW_FAILED', step, ...(m ? { source_line: Number(m[1]), source_column: Number(m[2]) } : {}), private_details_withheld: true }) + '\n'); process.exitCode = 1;
}).finally(async () => { try { await pool?.end(); } catch { process.stderr.write('QA159_FLOW_CLOSE_FAILED_PRIVATE_DETAILS_WITHHELD\n'); process.exitCode = 1; } });
