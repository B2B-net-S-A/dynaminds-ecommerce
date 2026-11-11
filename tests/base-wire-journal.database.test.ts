/** Real Fastify injection + real developer key gate + real 220/221 sidecars + the
 * native OMS (addOrder, payments, stage transitions, set_workflow, notes, demo
 * shipment and invoice). Root-only execution on a fresh disposable clone
 * dynaminds_wirejournal_20261023_NN made from the clean 217 template with
 * 218-221 applied by the guarded applier (nine native guards before and after).
 * The suite writes orders, so a rerun requires a NEW clone.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { pool, tenantTx } from '../server/db';
import { tokenHash } from '../server/security';
import { authenticateBaseWireApiKey } from '../server/developer-api';
import { registerBaseWireRoutes } from '../server/base-wire-routes';
import { createBaseWireOrdersFamily } from '../server/base-wire-orders';
import { createDefaultBaseWireOrdersService } from '../server/base-wire-orders-runtime';
import { createBaseWireJournalFamily } from '../server/base-wire-journal';
import { createDefaultBaseWireJournalService } from '../server/base-wire-journal-runtime';
import { createProduct } from '../server/catalog';
import { createOrder, issueDocument, orderSchema, productSchema, scan, shipDemo, type Actor } from '../server/domain';
import { transitionDirectLegacyOnReturnInTx } from '../server/legacy-return-on-command';
import { applyOrderAction } from '../server/order-operations';
import { localOrderEvent } from '../server/events';

assert.equal(process.env.DYNA_TEST, 'true', 'Explicit isolated test mode required');
const selected = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(selected.hostname, '127.0.0.1');
assert.equal(selected.port, '57084');
assert.match(selected.pathname, /^\/dynaminds_wirejournal_20261023_[0-9]{2}$/);
assert.equal(selected.username, 'postgres');
pool.options.query_timeout = 9000;
const KEY_NAME = 'Isolated wire journal test';
type Owner = { tenant: string; user: string; catalog: string; warehouse: string; currency: string; token: string; actor: Actor };
let app: ReturnType<typeof Fastify>, copy: ReturnType<typeof Fastify>, a: Owner, b: Owner, readOnlyKey: Owner, writeOnly: Owner, noOrders: Owner;
async function key(row: { tenant_id: string; user_id: string; catalog: string; warehouse: string; currency: string }, scopes: string[]): Promise<Owner> {
  const token = 'dyna_api_' + randomBytes(32).toString('hex'), id = randomUUID();
  await pool.query(`INSERT INTO api_keys(id,tenant_id,user_id,name,token_hash,prefix,scopes,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+interval '1 day')`, [id, row.tenant_id, row.user_id, KEY_NAME, tokenHash(token), token.slice(0, 16), scopes]);
  return { tenant: row.tenant_id, user: row.user_id, catalog: row.catalog, warehouse: row.warehouse, currency: row.currency, token,
    actor: { tenantId: row.tenant_id, userId: row.user_id, role: 'admin', source: 'manual' } };
}
async function wire(owner: Owner, method: string, parameters: unknown, target = app) {
  return target.inject({ method: 'POST', url: '/connector.php',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-bltoken': owner.token },
    payload: new URLSearchParams({ method, parameters: JSON.stringify(parameters) }).toString() });
}
const success = (r: any) => { assert.equal(r.statusCode, 200, r.body); const d = r.json(); assert.equal(d.status, 'SUCCESS', r.body); return d; };
const refused = (r: any, status: number) => { assert.equal(r.statusCode, status, r.body); const d = r.json(); assert.equal(d.status, 'ERROR');
  assert.deepEqual(Object.keys(d).sort(), ['error_code','error_message','status']); assert(!/SELECT |stack|dyna_api_/.test(r.body)); return d; };
type Log = { log_id: number; id: number; order_id: number; log_type: number; object_id: number; date: number };
const journal = async (o: Owner, parameters: Record<string, unknown> = {}, target = app) => success(await wire(o, 'getJournalList', parameters, target)).logs as Log[];
/** Base continuation: last_log_id = last returned log_id, until a page has fewer than 100. */
async function drain(o: Owner, from: number, filter: Record<string, unknown> = {}) {
  const out: Log[] = [];let last = from, pages = 0;
  for (;;) {
    const logs = await journal(o, { ...filter, last_log_id: last });pages++;
    assert(logs.length <= 100);
    for (const l of logs) { assert(l.log_id > last, 'strictly increasing'); assert.equal(l.id, l.log_id); last = l.log_id; }
    out.push(...logs);if (logs.length < 100) return { logs: out, last, pages };
  }
}
const head = async (o: Owner) => (await drain(o, 0)).last;
const publicId = async (table: string, tenant: string, local: string) =>
  Number((await pool.query(`SELECT public_id::text p FROM ${table} WHERE tenant_id=$1 AND local_id=$2`, [tenant, local])).rows[0]?.p);
const localOrder = async (tenant: string, publicOrder: number) =>
  (await pool.query('SELECT local_id FROM base_wire220_order_ids WHERE tenant_id=$1 AND public_id=$2', [tenant, publicOrder])).rows[0]?.local_id as string;
const version = async (c: any, id: string) => (await c.query('SELECT version::text v FROM orders WHERE id=$1', [id])).rows[0].v as string;
async function nativeProduct(o: Owner, sku: string, quantity: number) {
  return tenantTx(o.tenant, c => createProduct(c, o.actor, productSchema.parse({ name: 'Produkt ' + sku, sku, price: 1999, vat: 23, catalog_id: o.catalog, warehouse_id: o.warehouse, quantity })));
}
async function nativeOrder(o: Owner) {
  const p = await nativeProduct(o, 'WJ-N-' + randomBytes(4).toString('hex'), 5);
  const order = await tenantTx(o.tenant, c => createOrder(c, o.actor, orderSchema.parse({ customer_name: 'Klient natywny', email: 'native@example.com', warehouse_id: o.warehouse,
    currency: o.currency, items: [{ product_id: p.id, quantity: 1 }] }), undefined, { fieldSource: 'manual' }));
  return order.id as string;
}
const note = (o: Owner, order: string, text: string) => tenantTx(o.tenant, c => applyOrderAction(c, o.actor, order, { type: 'add_note', note: text }));

before(async () => {
  for (const name of ['base_wire220_order_ids', 'base_wire220_invoice_ids', 'base_wire220_package_ids', 'base_wire221_journal_ids'])
    assert.notEqual((await pool.query('SELECT to_regclass($1) n', ['public.' + name])).rows[0].n, null, 'Clone needs committed 220/221: ' + name);
  assert.equal((await pool.query('SELECT count(*)::int n FROM api_keys WHERE name=$1', [KEY_NAME])).rows[0].n, 0, 'Fresh clone required; no rerun');
  const rows = (await pool.query(`SELECT m.tenant_id,m.user_id,c.id catalog,(SELECT min(w.warehouse_id::text) FROM product_catalog_warehouses w WHERE w.catalog_id=c.id) warehouse,
      (SELECT currency FROM tenants t WHERE t.id=m.tenant_id) currency
    FROM (SELECT DISTINCT ON(tenant_id) tenant_id,user_id FROM memberships WHERE role='admin' ORDER BY tenant_id,user_id) m
    JOIN product_catalogs c ON c.tenant_id=m.tenant_id AND c.is_default AND c.active
    WHERE (SELECT currency FROM tenants t WHERE t.id=m.tenant_id)='PLN'
    AND NOT coalesce((SELECT enabled FROM wms_policies x WHERE x.tenant_id=m.tenant_id),false)
    AND NOT coalesce((SELECT require_mfa FROM workspace_security_policies x WHERE x.tenant_id=m.tenant_id),false)
    AND NOT (public.catalog_stock_control_policy(c.id)->>'strict')::boolean
    AND EXISTS(SELECT 1 FROM product_catalog_warehouses w WHERE w.catalog_id=c.id)
    ORDER BY (SELECT plan FROM tenants t WHERE t.id=m.tenant_id)='enterprise' DESC,m.tenant_id LIMIT 2`)).rows;
  assert.equal(rows.length, 2);
  a = await key(rows[0], ['orders:read', 'orders:write']); b = await key(rows[1], ['orders:read', 'orders:write']);
  readOnlyKey = await key(rows[0], ['orders:read']); writeOnly = await key(rows[0], ['orders:write']); noOrders = await key(rows[0], ['inventory:read']);
  const families = (readOnly: boolean) => [createBaseWireOrdersFamily({ available: true, service: createDefaultBaseWireOrdersService({ readOnly, mergeClaims: true }) }),
    createBaseWireJournalFamily({ available: true, service: createDefaultBaseWireJournalService({ readOnly }) })];
  app = Fastify();
  registerBaseWireRoutes(app, { readOnly: false, families: families(false), authenticate: (token, scope) => authenticateBaseWireApiKey(token, scope, true) });
  copy = Fastify();
  registerBaseWireRoutes(copy, { readOnly: true, families: families(true), authenticate: (token, scope) => authenticateBaseWireApiKey(token, scope, true) });
  await app.ready();await copy.ready();
});
after(async () => { await app?.close(); await copy?.close(); await pool.end(); });

test('Base addOrder, native payment, stage changes, demo shipment, invoice, workflow status and note appear with increasing log_id and Base types', async () => {
  const start = await head(a);
  const sku = 'WJ-' + randomBytes(4).toString('hex'), p = await nativeProduct(a, sku, 10);
  const pid = await publicId('base_wire220_product_ids', a.tenant, p.id), wid = await publicId('base_wire220_warehouse_ids', a.tenant, a.warehouse);
  const order = success(await wire(a, 'addOrder', { delivery_fullname: 'Jan Base', email: 'base@example.com', phone: '500600700', delivery_address: 'Prosta 1',
    delivery_postcode: '00-001', delivery_city: 'Warszawa', delivery_country_code: 'PL', currency: a.currency, paid: 1, delivery_price: 10,
    products: [{ storage: 'db', product_id: String(pid), warehouse_id: wid, price_brutto: 25.5, tax_rate: 23, quantity: 2 }] })).order_id as number;
  const local = await localOrder(a.tenant, order);
  const created = await drain(a, start, { order_id: order });
  // One native transaction: order.created, payment.receipt, order.paid (stage) — same timestamp, any order among them.
  assert.deepEqual(created.logs.map(l => l.log_type).sort((x, y) => x - y), [1, 3, 18]);
  assert(created.logs.every(l => l.order_id === order && l.object_id === 0 && Math.abs(l.date - Date.now() / 1000) < 600));
  await tenantTx(a.tenant, async c => transitionDirectLegacyOnReturnInTx(c, a.actor, local, 'picking', await version(c, local)));
  const location = (await pool.query('SELECT location FROM reservation_locations WHERE order_id=$1', [local])).rows[0]?.location;
  for (let n = 0; n < 2; n++) await tenantTx(a.tenant, c => scan(c, a.actor, local, sku, location, undefined, { client_key: randomUUID() }));
  await tenantTx(a.tenant, async c => transitionDirectLegacyOnReturnInTx(c, a.actor, local, 'packed', await version(c, local)));
  await tenantTx(a.tenant, c => shipDemo(c, a.actor, local));
  const doc = await tenantTx(a.tenant, c => issueDocument(c, a.actor, local, 'invoice'));
  const status = await tenantTx(a.tenant, async c => (await c.query("INSERT INTO workflow_statuses(id,tenant_id,name,color,stage,active) VALUES($1,$2,'Dziennik',$3,'shipped',true) RETURNING id",
    [randomUUID(), a.tenant, '#1c8752'])).rows[0].id as string);
  await tenantTx(a.tenant, c => applyOrderAction(c, a.actor, local, { type: 'set_workflow', status_id: status }));
  await note(a, local, 'Notatka dziennika');
  const later = await drain(a, created.last, { order_id: order });
  const pkg = await publicId('base_wire220_package_ids', a.tenant, (await pool.query('SELECT id FROM shipments WHERE order_id=$1', [local])).rows[0].id);
  const invoice = await publicId('base_wire220_invoice_ids', a.tenant, doc.id), statusId = await publicId('base_wire220_order_status_ids', a.tenant, status);
  // picking/packed stages (18), demo shipment (9 + package), invoice (7 + invoice), workflow (18 + status), note (16); scans are not exposed.
  assert.deepEqual(later.logs.map(l => [l.log_type, l.object_id]), [[18, 0], [18, 0], [9, pkg], [7, invoice], [18, statusId], [16, 0]]);
  assert(pkg > 0 && invoice > 0 && statusId > 0);
  // Type filter and the unfiltered tenant journal agree with the per-order view.
  assert.deepEqual((await drain(a, start, { order_id: order, logs_types: [7, 9] })).logs.map(l => l.log_type), [9, 7]);
  const all = (await drain(a, start)).logs.filter(l => l.order_id === order);
  assert.deepEqual(all, [...created.logs, ...later.logs]);
  // Foreign/unknown order filters match nothing; identities never leak UUIDs.
  assert.deepEqual(await journal(b, { order_id: order }), []);
  assert(!JSON.stringify(all).includes(local));
});

test('last_log_id continuation over more than 100 events has no gaps or duplicates', async () => {
  const order = await nativeOrder(a), orderPublic = await (async () => { await journal(a); return publicId('base_wire220_order_ids', a.tenant, order); })();
  const start = await head(a);
  const ids = await tenantTx(a.tenant, async c => { const out: string[] = []; for (let n = 0; n < 130; n++) out.push(await localOrderEvent(c, a.tenant, order, 'order.note_added', { n })); return out; });
  for (let n = 0; n < 5; n++) await note(a, order, 'Kolejna ' + n);
  const page = await drain(a, start, { order_id: orderPublic });
  assert.equal(page.logs.length, 135);assert(page.pages >= 2);
  assert.equal(new Set(page.logs.map(l => l.log_id)).size, 135);
  assert(page.logs.every(l => l.log_type === 16 && l.order_id === orderPublic));
  // Every native event has exactly one log_id, the same one the reader saw.
  const mapped = (await pool.query("SELECT j.log_id::int id FROM base_wire221_journal_ids j JOIN order_events e ON e.id=j.event_id WHERE e.order_id=$1 AND e.kind='order.note_added' ORDER BY j.log_id", [order])).rows.map(r => r.id);
  assert.deepEqual(mapped, page.logs.map(l => l.log_id));
  assert.equal((await pool.query('SELECT count(*)::int n FROM base_wire221_journal_ids WHERE resource_id=ANY($1::uuid[])', [ids])).rows[0].n, 130);
  // The unfiltered reader pages identically.
  assert.deepEqual((await drain(a, start)).logs.filter(l => l.order_id === orderPublic), page.logs);
});

test('concurrent writers: an event committed late gets a higher log_id; a continuation reader loses nothing', async () => {
  const order = await nativeOrder(a);await journal(a);const orderPublic = await publicId('base_wire220_order_ids', a.tenant, order);
  const start = await head(a);
  let release!: () => void;const gate = new Promise<void>(r => { release = r; });let inserted!: () => void;const begun = new Promise<void>(r => { inserted = r; });
  const slow = tenantTx(a.tenant, async c => { const id = await localOrderEvent(c, a.tenant, order, 'order.note_added', { slow: true }); inserted(); await gate; return id; });
  await begun;
  const fast = await tenantTx(a.tenant, c => localOrderEvent(c, a.tenant, order, 'order.note_added', { fast: true }));
  const first = await drain(a, start, { order_id: orderPublic });
  assert.equal(first.logs.length, 1, 'the uncommitted event is not journaled yet');
  release();const slowId = await slow;
  const second = await drain(a, first.last, { order_id: orderPublic });
  assert.equal(second.logs.length, 1);assert(second.logs[0].log_id > first.logs[0].log_id, 'late commit, higher log_id');
  const ofEvent = async (id: string) => Number((await pool.query('SELECT log_id::text v FROM base_wire221_journal_ids WHERE resource_id=$1', [id])).rows[0].v);
  assert.equal(await ofEvent(fast), first.logs[0].log_id);assert.equal(await ofEvent(slowId), second.logs[0].log_id);
  // Several writers and concurrent allocating readers: the sequential continuation reader sees every event once.
  const seen: Log[] = [];let last = second.last, writing = true;
  const writers = Promise.all([0, 1, 2, 3].map(w => (async () => {
    for (let n = 0; n < 6; n++) await tenantTx(a.tenant, async c => { await localOrderEvent(c, a.tenant, order, 'order.note_added', { w, n }); await new Promise(r => setTimeout(r, 15 * ((w + n) % 3))); });
  })())).finally(() => { writing = false; });
  const noise = Promise.all([0, 1].map(async () => { while (writing) await journal(a, { order_id: orderPublic }); }));
  while (writing) { const r = await drain(a, last, { order_id: orderPublic }); seen.push(...r.logs); last = r.last; }
  await writers;await noise;
  const tail = await drain(a, last, { order_id: orderPublic });seen.push(...tail.logs);
  assert.equal(seen.length, 24);assert.equal(new Set(seen.map(l => l.log_id)).size, 24);
  for (let n = 1; n < seen.length; n++) assert(seen[n].log_id > seen[n - 1].log_id);
  assert.equal((await pool.query('SELECT count(*)::int n FROM order_events e JOIN base_wire221_journal_ids j ON j.event_id=e.id WHERE e.order_id=$1', [order])).rows[0].n, 26 + 1);
});

test('second tenant is isolated; a read-only copy never allocates; orders:read is required', async () => {
  const ownB = await nativeOrder(b);
  const logsB = (await drain(b, 0)).logs, ownBPublic = await publicId('base_wire220_order_ids', b.tenant, ownB);
  assert(logsB.some(l => l.order_id === ownBPublic && l.log_type === 1));
  const logsA = (await drain(a, 0)).logs;
  const tenantOf = async (ids: number[]) => (await pool.query('SELECT DISTINCT tenant_id::text t FROM base_wire221_journal_ids WHERE log_id=ANY($1::bigint[])', [ids])).rows.map(r => r.t);
  assert.deepEqual(await tenantOf(logsA.map(l => l.log_id)), [a.tenant]);assert.deepEqual(await tenantOf(logsB.map(l => l.log_id)), [b.tenant]);
  assert(!logsA.some(l => l.order_id === ownBPublic));
  // The read-only copy reads committed log IDs only and allocates nothing.
  const start = await head(a), fresh = await nativeOrder(a);
  const before = (await pool.query('SELECT count(*)::int n FROM base_wire221_journal_ids')).rows[0].n;
  assert.deepEqual(await journal(readOnlyKey, { last_log_id: start }, copy), []);
  assert.equal((await pool.query('SELECT count(*)::int n FROM base_wire221_journal_ids')).rows[0].n, before);
  assert.equal((await pool.query('SELECT count(*)::int n FROM base_wire220_order_ids WHERE local_id=$1', [fresh])).rows[0].n, 0);
  const created = await journal(readOnlyKey, { last_log_id: start });
  assert.deepEqual(created.map(l => l.log_type), [1]);
  assert.deepEqual(await journal(readOnlyKey, { last_log_id: start }, copy), created);
  // Scope gate: orders:write alone (write requires read) and unrelated scopes are refused.
  refused(await wire(writeOnly, 'getJournalList', {}), 403);refused(await wire(noOrders, 'getJournalList', {}), 403);
  refused(await wire(a, 'getJournalList', { last_log_id: -1 }), 422);refused(await wire(a, 'getJournalList', { logs_types: [23] }), 422);
  // dyna_app may only read the sidecar.
  await assert.rejects(tenantTx(a.tenant, c => c.query("INSERT INTO base_wire221_journal_ids(tenant_id,source,resource_id) VALUES($1,'order_event',$2)", [a.tenant, randomUUID()])),
    (e: any) => e.code === '42501');
});
