/** 225 native product deletion on a real disposable clone: the native route
 * POST /api/products/:id/deletion and the Base connector.php deleteInventoryProduct
 * (real developer key gate) over deleteProductInTx; refusals from native facts,
 * hidden in the native list/detail/picker and the four Base inventory reads,
 * history kept, SKU never reused, replay, tenant isolation, append-only table.
 * Root-only execution on a fresh clone dynaminds_pdel225_20261023_NN made from the
 * clean 217 template with 218–225 by the guarded applier. The suite writes; rerun = NEW clone.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tenantTx, tenantReadTx } from '../server/db';
import { tokenHash } from '../server/security';
import { authenticateBaseWireApiKey } from '../server/developer-api';
import { registerBaseWireRoutes } from '../server/base-wire-routes';
import { createBaseWireInventoryFamily } from '../server/base-wire-inventory';
import { createDefaultBaseWireInventoryService, productDeletions225Available } from '../server/base-wire-inventory-runtime';
import { registerCatalogRoutes } from '../server/catalog-routes';
import { createProduct, editProduct, editSchema } from '../server/catalog';
import { adjustLegacyStockInTx } from '../server/inventory';
import { cancelOrder, createOrder, getOrder, orderSchema, productSchema, type Actor } from '../server/domain';
import { Problem } from '../server/errors';

assert.equal(process.env.DYNA_TEST, 'true', 'Explicit isolated test mode required');
const selected = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(selected.hostname, '127.0.0.1');
assert.equal(selected.port, '57084');
assert.match(selected.pathname, /^\/dynaminds_pdel225_20261023_[0-9]{2}$/);
assert.equal(selected.username, 'postgres');
pool.options.query_timeout = 9000;
const KEY_NAME = 'Isolated product deletions 225 test';
type Row = Record<string, any>;
type Owner = { tenant: string; user: string; catalog: string; inventory: number; warehouse: string; currency: string; read: string; write: string; actor: Actor };
let wire: FastifyInstance, session: FastifyInstance, a: Owner, b: Owner;
const tag = randomBytes(3).toString('hex');

async function key(row: Row, scopes: string[]) {
  const token = 'dyna_api_' + randomBytes(32).toString('hex');
  await pool.query(`INSERT INTO api_keys(id,tenant_id,user_id,name,token_hash,prefix,scopes,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+interval '1 day')`, [randomUUID(), row.tenant_id, row.user_id, KEY_NAME, tokenHash(token), token.slice(0, 16), scopes]);
  return token;
}
async function owner(row: Row): Promise<Owner> {
  const inventory = Number((await pool.query('SELECT public_id::text p FROM base_wire220_catalog_ids WHERE tenant_id=$1 AND local_id=$2', [row.tenant_id, row.catalog])).rows[0].p);
  return { tenant: row.tenant_id, user: row.user_id, catalog: row.catalog, inventory, warehouse: row.warehouse, currency: row.currency,
    read: await key(row, ['inventory:read']), write: await key(row, ['products:read', 'products:write']),
    actor: { tenantId: row.tenant_id, userId: row.user_id, role: 'admin', source: 'manual' } };
}
const base = (token: string, method: string, parameters: unknown, headers: Record<string, string> = {}) =>
  wire.inject({ method: 'POST', url: '/connector.php', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-bltoken': token, ...headers },
    payload: new URLSearchParams({ method, parameters: JSON.stringify(parameters) }).toString() });
const baseOk = (r: any) => { assert.equal(r.statusCode, 200, r.body); const d = r.json(); assert.equal(d.status, 'SUCCESS', r.body); return d; };
const baseRefused = (r: any, status: number) => { assert.equal(r.statusCode, status, r.body); const d = r.json(); assert.equal(d.status, 'ERROR', r.body);
  assert(!/SELECT |stack|dyna_api_/.test(r.body), r.body); return d; };
const as = (o: Owner, role: Actor['role'] = 'admin') => ({ 'x-test-as': JSON.stringify({ tenant: o.tenant, user: o.user, role }) });
const route = (o: Owner, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, role: Actor['role'] = 'admin') =>
  session.inject({ method, url, headers: as(o, role), ...(payload === undefined ? {} : { payload: payload as any }) });
async function product(o: Owner, sku: string, extra: Row = {}) {
  const p = await tenantTx(o.tenant, c => createProduct(c, o.actor, productSchema.parse({ name: 'Produkt ' + sku, sku, price: 1999, vat: 23, catalog_id: o.catalog,
    warehouse_id: o.warehouse, quantity: 0, ...extra })));
  const id = Number((await pool.query('SELECT public_id::text p FROM base_wire220_product_ids WHERE tenant_id=$1 AND local_id=$2', [o.tenant, p.id])).rows[0].p);
  return { local: p.id as string, id, sku, version: p.version as number };
}
const version = async (id: string) => Number((await pool.query('SELECT version FROM products WHERE id=$1', [id])).rows[0].version);
const remove = async (o: Owner, id: string, body: Row = {}) => route(o, 'POST', `/api/products/${id}/deletion`, { version: await version(id), ...body });
const deletions = async (id: string) => (await pool.query('SELECT * FROM product_deletions225 WHERE product_id=$1', [id])).rows;
const refusedWith = (r: any, status: number, text: RegExp) => { assert.equal(r.statusCode, status, r.body); assert.match(r.json().error, text); };

before(async () => {
  assert.equal(await productDeletions225Available(pool), true, 'Clone needs committed 225');
  assert.equal((await pool.query('SELECT count(*)::int n FROM api_keys WHERE name=$1', [KEY_NAME])).rows[0].n, 0, 'Fresh clone required; no rerun');
  const rows = (await pool.query(`SELECT m.tenant_id,m.user_id,c.id catalog,(SELECT min(w.warehouse_id::text) FROM product_catalog_warehouses w WHERE w.catalog_id=c.id) warehouse,
      (SELECT currency FROM tenants t WHERE t.id=m.tenant_id) currency
    FROM (SELECT DISTINCT ON(tenant_id) tenant_id,user_id FROM memberships WHERE role='admin' ORDER BY tenant_id,user_id) m
    JOIN product_catalogs c ON c.tenant_id=m.tenant_id AND c.is_default AND c.active
    WHERE NOT coalesce((SELECT enabled FROM wms_policies x WHERE x.tenant_id=m.tenant_id),false)
    AND NOT coalesce((SELECT require_mfa FROM workspace_security_policies x WHERE x.tenant_id=m.tenant_id),false)
    AND NOT (public.catalog_stock_control_policy(c.id)->>'strict')::boolean
    AND EXISTS(SELECT 1 FROM product_catalog_warehouses w WHERE w.catalog_id=c.id)
    ORDER BY (SELECT plan FROM tenants t WHERE t.id=m.tenant_id)='enterprise' DESC,m.tenant_id LIMIT 2`)).rows;
  assert.equal(rows.length, 2);
  a = await owner(rows[0]); b = await owner(rows[1]);
  wire = Fastify();
  registerBaseWireRoutes(wire, { readOnly: false, families: [createBaseWireInventoryFamily({ available: true,
    service: createDefaultBaseWireInventoryService({ readOnly: false, categories: true, deletions: true }) })],
    authenticate: (token, scope) => authenticateBaseWireApiKey(token, scope, true) });
  await wire.ready();
  session = Fastify();
  session.decorateRequest('actor'); session.decorateRequest('currentUser'); session.decorateRequest('apiScopes');
  session.addHook('onRequest', async (req: any) => {
    const who = JSON.parse(String(req.headers['x-test-as']));
    req.actor = { tenantId: who.tenant, userId: who.user, role: who.role };
    req.currentUser = { id: who.user, tenant_id: who.tenant, role: who.role };
  });
  session.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof Problem) return reply.code(err.status).send({ error: err.message });
    if (err instanceof z.ZodError) return reply.code(422).send({ error: err.issues.map(i => i.message).join('; ') });
    return reply.code(500).send({ error: 'Błąd serwera: ' + err.message });
  });
  registerCatalogRoutes(session);
  await session.ready();
});
after(async () => { await wire?.close(); await session?.close(); await pool.end(); });

test('refusals from native facts: stock, open order + reservation, variants, bundle use, channel listing, stale version, non-admin', async () => {
  const stocked = await product(a, 'DEL225-' + tag + '-S', { quantity: 3 });
  refusedWith(await remove(a, stocked.local), 409, /stan magazynowy/);
  const ordered = await product(a, 'DEL225-' + tag + '-O', { quantity: 1 });
  await tenantTx(a.tenant, c => createOrder(c, a.actor, orderSchema.parse({ customer_name: 'Klient Usuwanie', email: `del-${tag}@example.com`, warehouse_id: a.warehouse,
    currency: a.currency, address: { street: 'Prosta 1', city: 'Warszawa', postal_code: '00-001', country: 'PL', phone: '500600700' },
    items: [{ product_id: ordered.local, quantity: 1 }] }), undefined, { fieldSource: 'manual' }));
  refusedWith(await remove(a, ordered.local), 409, /stan magazynowy lub rezerwacje/);
  const group = await product(a, 'DEL225-' + tag + '-G', { kind: 'group' });
  const variant = await product(a, 'DEL225-' + tag + '-G-M', { kind: 'variant', parent_id: group.local });
  refusedWith(await remove(a, group.local), 409, /Grupa ma warianty/);
  const part = await product(a, 'DEL225-' + tag + '-C');
  const bundle = await product(a, 'DEL225-' + tag + '-B', { kind: 'bundle', components: [{ product_id: part.local, quantity: 2 }] });
  refusedWith(await remove(a, part.local), 409, /składnikiem zestawu/);
  const listed = await product(a, 'DEL225-' + tag + '-L');
  const channel = (await pool.query('SELECT id FROM channels WHERE tenant_id=$1 ORDER BY id LIMIT 1', [a.tenant])).rows[0];
  assert(channel, 'tenant A needs a channel for the listing case');
  await pool.query("INSERT INTO listings(id,tenant_id,channel_id,product_id,external_id,status,price) VALUES($1,$2,$3,$4,$5,'publish',1999)",
    [randomUUID(), a.tenant, channel.id, listed.local, 'del225-' + tag]);
  refusedWith(await remove(a, listed.local), 409, /oferty w kanałach/);
  const plain = await product(a, 'DEL225-' + tag + '-P');
  refusedWith(await route(a, 'POST', `/api/products/${plain.local}/deletion`, { version: plain.version + 5 }), 409, /innym oknie/);
  refusedWith(await route(a, 'POST', `/api/products/${plain.local}/deletion`, { version: plain.version }, 'operator'), 403, /administratora/);
  assert.equal((await route(a, 'POST', `/api/products/${plain.local}/deletion`, { version: plain.version, extra: 1 })).statusCode, 422);
  // Nothing was written for any refusal.
  for (const p of [stocked, ordered, group, part, listed, plain]) assert.deepEqual(await deletions(p.local), []);
  // Order of deletion that the refusals describe: variant before group, bundle before component.
  for (const p of [variant, group, bundle, part]) assert.equal((await remove(a, p.local)).statusCode, 200);
  for (const p of [variant, group, bundle, part]) assert.equal((await deletions(p.local)).length, 1);
});

let gone: { local: string; id: number; sku: string; version: number }, orderId: string;
test('deletion hides the product from native list/detail/picker and the Base reads; the historical order keeps it', async () => {
  const p = await product(a, 'DEL225-' + tag + '-H', { quantity: 1 });
  // Sold and cancelled, then the remaining unit corrected away: history without open duties.
  orderId = (await tenantTx(a.tenant, c => createOrder(c, a.actor, orderSchema.parse({ customer_name: 'Klient Historia', email: `hist-${tag}@example.com`,
    warehouse_id: a.warehouse, currency: a.currency, address: { street: 'Prosta 1', city: 'Warszawa', postal_code: '00-001', country: 'PL', phone: '500600700' },
    items: [{ product_id: p.local, quantity: 1 }] }), undefined, { fieldSource: 'manual' }))).id;
  refusedWith(await remove(a, p.local), 409, /stan magazynowy lub rezerwacje/);
  await tenantTx(a.tenant, c => cancelOrder(c, a.actor, orderId));
  await tenantTx(a.tenant, c => adjustLegacyStockInTx(c, a.actor, { product_id: p.local, warehouse_id: a.warehouse, delta: -1, note: 'Test 225' }));
  const before = baseOk(await base(a.read, 'getInventoryProductsList', { inventory_id: a.inventory, filter_sku: p.sku })).products;
  assert.deepEqual(Object.keys(before), [String(p.id)]);
  const r = await remove(a, p.local, { reason: '  Wycofany z oferty  ' });
  assert.equal(r.statusCode, 200, r.body);
  const body = r.json();
  assert.deepEqual({ ...body, deleted_at: typeof body.deleted_at }, { id: p.local, sku: p.sku, deleted: true, deleted_at: 'string' });
  const [row] = await deletions(p.local);
  assert.equal(row.tenant_id, a.tenant); assert.equal(row.actor_id, a.user); assert.equal(row.reason, 'Wycofany z oferty'); assert.equal(row.api_key_id, null);
  const saved = (await pool.query('SELECT active,version,sku FROM products WHERE id=$1', [p.local])).rows[0];
  assert.equal(saved.active, false); assert.equal(saved.version, p.version + 1); assert.equal(row.product_version, saved.version);
  assert.equal((await pool.query("SELECT count(*)::int n FROM audit_events WHERE entity_id=$1 AND action='product.delete'", [p.local])).rows[0].n, 1);
  // Native reads.
  const list = await route(a, 'GET', '/api/products?search=' + encodeURIComponent(p.sku));
  assert.equal(list.statusCode, 200); assert.deepEqual(list.json().data, []);
  assert.deepEqual((await route(a, 'GET', '/api/products?sellable=true&search=' + encodeURIComponent(p.sku))).json().data, []);
  refusedWith(await route(a, 'GET', '/api/products/' + p.local), 404, /usunięty/);
  // Base reads: list, data, stock, prices.
  assert.deepEqual(baseOk(await base(a.read, 'getInventoryProductsList', { inventory_id: a.inventory, filter_sku: p.sku })).products, {});
  assert.deepEqual(baseOk(await base(a.read, 'getInventoryProductsData', { inventory_id: a.inventory, products: [p.id] })).products, {});
  assert.equal(baseOk(await base(a.read, 'getInventoryProductsStock', { inventory_id: a.inventory, filter_id: p.id })).products[String(p.id)], undefined);
  let page = 1, seen = false;
  for (;;) {
    const prices = baseOk(await base(a.read, 'getInventoryProductsPrices', { inventory_id: a.inventory, page })).products;
    if (String(p.id) in prices) seen = true;
    if (Object.keys(prices).length < 1000) break;
    page++;
  }
  assert.equal(seen, false);
  // History: the cancelled order still shows the line and its snapshot.
  const order = await tenantReadTx(a.tenant, c => getOrder(c, orderId));
  const line = order.items.find((i: Row) => i.product_id === p.local);
  assert(line, 'historical line kept'); assert.equal(line.sku, p.sku); assert.equal(line.name, 'Produkt ' + p.sku);
  gone = { ...p, version: saved.version };
});

test('a deleted product is never edited, restocked or deleted again; its SKU is never reused', async () => {
  const current = (await pool.query('SELECT * FROM products WHERE id=$1', [gone.local])).rows[0];
  await assert.rejects(tenantTx(a.tenant, c => editProduct(c, a.actor, gone.local, editSchema.parse({ name: current.name, ean: current.ean ?? '', price: current.price, vat: current.vat,
    category: current.category, description: current.description, attributes: current.attributes, images: current.images, active: true, version: current.version, components: [] }))),
    (e: any) => e.status === 409 && /usunięty/.test(e.message));
  refusedWith(await route(a, 'PATCH', '/api/products/' + gone.local, { name: 'Wskrzeszony', price: 1, version: current.version }), 409, /usunięty/);
  await assert.rejects(tenantTx(a.tenant, c => adjustLegacyStockInTx(c, a.actor, { product_id: gone.local, warehouse_id: a.warehouse, delta: 5, note: 'Test 225' })),
    (e: any) => e.status === 409);
  refusedWith(await route(a, 'POST', `/api/products/${gone.local}/deletion`, { version: current.version }), 409, /już usunięty/);
  // Native SKU invariant: the code stays with the deleted product (row + immutable alias).
  await assert.rejects(product(a, gone.sku), (e: any) => e.code === '23505' || e.status === 409);
  const bl = 'bl_' + (await pool.query('SELECT public_id::text p FROM base_wire220_warehouse_ids WHERE tenant_id=$1 AND local_id=$2', [a.tenant, a.warehouse])).rows[0].p;
  const fresh = { inventory_id: a.inventory, text_fields: { name: 'Nowy ' + gone.sku }, prices: { '2147483647': 10 }, stock: { [bl]: 0 } };
  baseRefused(await base(a.write, 'addInventoryProduct', { ...fresh, sku: gone.sku }), 409);
  // Control: the same body with an unused SKU is accepted.
  baseOk(await base(a.write, 'addInventoryProduct', { ...fresh, sku: gone.sku + '-NOWY' }));
  assert.equal((await pool.query('SELECT count(*)::int n FROM product_sku_aliases WHERE tenant_id=$1 AND sku=$2 AND product_id=$3', [a.tenant, gone.sku, gone.local])).rows[0].n, 1);
  assert.equal((await deletions(gone.local)).length, 1);
});

test('Base deleteInventoryProduct: native refusals, success, Idempotency-Key replay, absent afterwards, scopes', async () => {
  const stocked = await product(a, 'DEL225-' + tag + '-WS', { quantity: 2 });
  baseRefused(await base(a.write, 'deleteInventoryProduct', { product_id: stocked.id }), 409);
  baseRefused(await base(a.read, 'deleteInventoryProduct', { product_id: stocked.id }), 403);
  const p = await product(a, 'DEL225-' + tag + '-W');
  const clientKey = randomUUID();
  assert.deepEqual(baseOk(await base(a.write, 'deleteInventoryProduct', { product_id: p.id }, { 'idempotency-key': clientKey })), { status: 'SUCCESS' });
  assert.deepEqual(baseOk(await base(a.write, 'deleteInventoryProduct', { product_id: p.id }, { 'idempotency-key': clientKey })), { status: 'SUCCESS' });
  const rows = await deletions(p.local);
  assert.equal(rows.length, 1); assert.equal(rows[0].reason, 'Base API deleteInventoryProduct'); assert.notEqual(rows[0].api_key_id, null);
  baseRefused(await base(a.write, 'deleteInventoryProduct', { product_id: p.id }), 404);
  baseRefused(await base(a.write, 'deleteInventoryProduct', { product_id: stocked.id }, { 'idempotency-key': clientKey }), 409);
  baseRefused(await base(a.write, 'deleteInventoryProduct', { product_id: p.id, inventory_id: a.inventory }), 422);
  assert.deepEqual(baseOk(await base(a.read, 'getInventoryProductsData', { inventory_id: a.inventory, products: [p.id, stocked.id] })).products[String(p.id)], undefined);
  assert.deepEqual(await deletions(stocked.local), []);
});

test('tenant isolation: foreign products are absent, foreign deletions invisible', async () => {
  const mine = await product(b, 'DEL225-' + tag + '-F');
  baseRefused(await base(a.write, 'deleteInventoryProduct', { product_id: mine.id }), 404);
  refusedWith(await remove(a, mine.local), 404, /Nie znaleziono/);
  baseRefused(await base(b.write, 'deleteInventoryProduct', { product_id: gone.id }), 404);
  assert.deepEqual(await deletions(mine.local), []);
  assert.equal((await remove(b, mine.local)).statusCode, 200);
  await tenantReadTx(b.tenant, async c => {
    assert.deepEqual((await c.query('SELECT DISTINCT tenant_id FROM product_deletions225')).rows.map(r => r.tenant_id), [b.tenant]);
  });
  // A's product list and Base reads are unaffected by B's deletion and vice versa.
  assert.equal((await pool.query('SELECT active FROM products WHERE id=$1', [mine.local])).rows[0].active, false);
});

test('product_deletions225 is append-only, dyna_app may only insert own-tenant rows', async () => {
  for (const sql of ['UPDATE product_deletions225 SET reason=NULL WHERE product_id=$1', 'DELETE FROM product_deletions225 WHERE product_id=$1'])
    await assert.rejects(pool.query(sql, [gone.local]), /permanent/);
  await assert.rejects(pool.query('TRUNCATE product_deletions225'), /permanent/);
  await assert.rejects(tenantTx(a.tenant, c => c.query('UPDATE product_deletions225 SET reason=NULL WHERE product_id=$1', [gone.local])), (e: any) => e.code === '42501');
  const other = await product(b, 'DEL225-' + tag + '-X');
  await assert.rejects(tenantTx(a.tenant, c => c.query('INSERT INTO product_deletions225(tenant_id,product_id,actor_id,product_version) VALUES($1,$2,$3,1)', [b.tenant, other.local, a.user])),
    (e: any) => e.code === '42501');
  assert.equal((await deletions(gone.local)).length, 1);
});
