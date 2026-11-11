/** 224 Base category identities on a real disposable clone: native PIM categories and
 * product categories are written only through the actual native PIM service (preview +
 * confirmed apply with the API-key PIM authority), then read through the actual Base
 * connector.php (getInventoryCategories, getInventoryProductsData category_id,
 * getInventoryProductsList filter_category_id) with the real developer key gate.
 * Root-only execution on a fresh clone dynaminds_cat224_20261023_NN made from the clean
 * 217 template with 218–224 by the guarded applier. The suite writes; rerun = NEW clone.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { pool, tenantTx, tenantReadTx } from '../server/db';
import { tokenHash } from '../server/security';
import { authenticateBaseWireApiKey } from '../server/developer-api';
import { registerBaseWireRoutes } from '../server/base-wire-routes';
import { createBaseWireInventoryFamily } from '../server/base-wire-inventory';
import { createDefaultBaseWireInventoryService, baseWireCategories224Available } from '../server/base-wire-inventory-runtime';
import { createPimService } from '../server/pim-dictionaries/service';
import { createProduct } from '../server/catalog';
import { productSchema, type Actor } from '../server/domain';

assert.equal(process.env.DYNA_TEST, 'true', 'Explicit isolated test mode required');
const selected = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(selected.hostname, '127.0.0.1');
assert.equal(selected.port, '57084');
assert.match(selected.pathname, /^\/dynaminds_cat224_20261023_[0-9]{2}$/);
assert.equal(selected.username, 'postgres');
pool.options.query_timeout = 9000;
const KEY_NAME = 'Isolated categories 224 test';
const MAX_SAFE = 9007199254740991;
type Owner = { tenant: string; user: string; catalog: string; inventory: number; warehouse: string; wire: string; pim: Actor; actor: Actor };
let wire: FastifyInstance, a: Owner, b: Owner;
const pim = createPimService({ sessionName: 'dyna_session', readOnly: false, cursorKey: 'c'.repeat(64), transaction: (actor, _w, work) => tenantTx(actor.tenantId, work) });
const tag = randomBytes(3).toString('hex');

async function key(row: any, scopes: string[]) {
  const token = 'dyna_api_' + randomBytes(32).toString('hex'), id = randomUUID();
  await pool.query(`INSERT INTO api_keys(id,tenant_id,user_id,name,token_hash,prefix,scopes,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+interval '1 day')`, [id, row.tenant_id, row.user_id, KEY_NAME, tokenHash(token), token.slice(0, 16), scopes]);
  return { id, token };
}
async function owner(row: any): Promise<Owner> {
  const read = await key(row, ['inventory:read']), write = await key(row, ['products:read', 'products:write']);
  // Same capture as the native PIM route for a Bearer API key (credential custody for the PIM identity proof).
  const pimActor = pim.captureActor({ actor: { tenantId: row.tenant_id, userId: row.user_id, role: 'admin', apiKeyId: write.id, source: 'api' },
    currentUser: { id: row.user_id, tenant_id: row.tenant_id }, headers: { authorization: 'Bearer ' + write.token }, cookies: {} });
  const inventory = Number((await pool.query('SELECT public_id::text p FROM base_wire220_catalog_ids WHERE tenant_id=$1 AND local_id=$2', [row.tenant_id, row.catalog])).rows[0].p);
  return { tenant: row.tenant_id, user: row.user_id, catalog: row.catalog, inventory, warehouse: row.warehouse, wire: read.token, pim: pimActor,
    actor: { tenantId: row.tenant_id, userId: row.user_id, role: 'admin', source: 'manual' } };
}
async function base(o: Owner, method: string, parameters: unknown) {
  return wire.inject({ method: 'POST', url: '/connector.php', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-bltoken': o.wire },
    payload: new URLSearchParams({ method, parameters: JSON.stringify(parameters) }).toString() });
}
const baseOk = (r: any) => { assert.equal(r.statusCode, 200, r.body); const d = r.json(); assert.equal(d.status, 'SUCCESS', r.body); return d; };
const baseRefused = (r: any, status: number) => { assert.equal(r.statusCode, status, r.body); const d = r.json(); assert.equal(d.status, 'ERROR', r.body);
  assert(!/SELECT |stack|dyna_api_/.test(r.body), r.body); return d; };
/** Native PIM write: preview at the current revision, then the confirmed apply of that preview. */
async function pimApply(o: Owner, request: Record<string, unknown>) {
  const revision = (await pim.dictionary(o.pim, o.catalog)).revision;
  const preview: any = await pim.preview(o.pim, o.catalog, { client_key: randomUUID(), revision, ...request });
  assert.equal(preview.ready, true, JSON.stringify(preview.errors));
  const operation: any = await pim.apply(o.pim, o.catalog, preview.id, { client_key: randomUUID(), scope_hash: preview.scope_hash, confirmed: true });
  assert.equal(operation.changed_count, 1);
  return operation;
}
const createCategory = (o: Owner, name: string, parent: string | null = null) => {
  const id = randomUUID();
  return pimApply(o, { kind: 'dictionary', changes: [{ kind: 'category_create', id, parent_id: parent, name }] }).then(() => id);
};
async function categoryOf(o: Owner, product: string, category: string | null) {
  const s: any = await pim.product(o.pim, o.catalog, product);
  await pimApply(o, { kind: 'product_values', rows: [{ product_id: product, product_version: s.product_version, state_version: s.state_version, source_hash: s.source_hash, category_id: category, values: [] }] });
}
const sidecar = async (tenant: string, category: string) =>
  (await pool.query('SELECT public_id::text p FROM base_wire224_category_ids WHERE tenant_id=$1 AND category_id=$2', [tenant, category])).rows.map(r => Number(r.p));
async function nativeProduct(o: Owner, sku: string) {
  const p = await tenantTx(o.tenant, c => createProduct(c, o.actor, productSchema.parse({ name: 'Produkt ' + sku, sku, price: 1999, vat: 23, catalog_id: o.catalog, warehouse_id: o.warehouse, quantity: 1 })));
  const id = Number((await pool.query('SELECT public_id::text p FROM base_wire220_product_ids WHERE tenant_id=$1 AND local_id=$2', [o.tenant, p.id])).rows[0].p);
  return { local: p.id as string, id };
}

before(async () => {
  assert.equal(await baseWireCategories224Available(pool), true, 'Clone needs committed 224');
  assert.equal((await pool.query('SELECT count(*)::int n FROM api_keys WHERE name=$1', [KEY_NAME])).rows[0].n, 0, 'Fresh clone required; no rerun');
  // The migration backfilled every existing native category exactly once.
  assert.equal((await pool.query(`SELECT count(*)::int n FROM pim_dictionary_categories c LEFT JOIN base_wire224_category_ids s
    ON(s.tenant_id,s.catalog_id,s.category_id)=(c.tenant_id,c.catalog_id,c.id) WHERE s.public_id IS NULL`)).rows[0].n, 0, 'Complete 224 backfill');
  const rows = (await pool.query(`SELECT m.tenant_id,m.user_id,c.id catalog,(SELECT min(w.warehouse_id::text) FROM product_catalog_warehouses w WHERE w.catalog_id=c.id) warehouse
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
  registerBaseWireRoutes(wire, { readOnly: false, families: [createBaseWireInventoryFamily({ available: true, service: createDefaultBaseWireInventoryService({ readOnly: false, categories: true }) })],
    authenticate: (token, scope) => authenticateBaseWireApiKey(token, scope, true) });
  await wire.ready();
});
after(async () => { await wire?.close(); await pool.end(); });

let root: string, child: string, rootId: number, childId: number;
test('native PIM categories get stable numeric IDs; a rename keeps the ID; the tree maps to parent_id', async () => {
  const backfilled = (await pool.query('SELECT count(*)::int n FROM base_wire224_category_ids WHERE tenant_id=$1 AND catalog_id=$2', [a.tenant, a.catalog])).rows[0].n;
  const initial = baseOk(await base(a, 'getInventoryCategories', { inventory_id: a.inventory })).categories;
  assert.equal(initial.length, backfilled);
  root = await createCategory(a, 'Kuchnia ' + tag);
  child = await createCategory(a, 'Kubki ' + tag, root);
  // Natively created: no ID until the next Base read allocates it (no trigger on the PIM table).
  assert.deepEqual(await sidecar(a.tenant, root), []);
  const listed = baseOk(await base(a, 'getInventoryCategories', { inventory_id: a.inventory })).categories;
  [rootId] = await sidecar(a.tenant, root); [childId] = await sidecar(a.tenant, child);
  assert(Number.isSafeInteger(rootId) && rootId >= 1 && rootId <= MAX_SAFE && childId !== rootId);
  assert.deepEqual(listed.slice(initial.length), [{ category_id: rootId, name: 'Kuchnia ' + tag, parent_id: 0 }, { category_id: childId, name: 'Kubki ' + tag, parent_id: rootId }]);
  assert.deepEqual(listed.map((c: any) => c.category_id), [...listed.map((c: any) => c.category_id)].sort((x, y) => x - y));
  // Rename (native category_update, version from the native dictionary) keeps UUID and numeric ID.
  const current = (await pim.dictionary(a.pim, a.catalog)).categories.find((c: any) => c.id === child) as any;
  await pimApply(a, { kind: 'dictionary', changes: [{ kind: 'category_update', id: child, version: current.version, parent_id: root, name: 'Kubki i filiżanki ' + tag, active: true }] });
  const renamed = baseOk(await base(a, 'getInventoryCategories', { inventory_id: a.inventory })).categories;
  assert.deepEqual(renamed.find((c: any) => c.category_id === childId), { category_id: childId, name: 'Kubki i filiżanki ' + tag, parent_id: rootId });
  assert.deepEqual(await sidecar(a.tenant, child), [childId]);
  assert.equal(renamed.length, listed.length);
  // Repeated reads allocate nothing new; omitted inventory_id = shared categories (none natively).
  baseOk(await base(a, 'getInventoryCategories', { inventory_id: a.inventory }));
  assert.equal((await pool.query('SELECT count(*)::int n FROM base_wire224_category_ids WHERE tenant_id=$1', [a.tenant])).rows[0].n, backfilled + 2);
  assert.deepEqual(baseOk(await base(a, 'getInventoryCategories', {})).categories, []);
  baseRefused(await base(a, 'getInventoryCategories', { inventory_id: 2147483000 }), 404);
});

test('product category from the native PIM state: category_id in getInventoryProductsData, filter_category_id in the list', async () => {
  const p = await nativeProduct(a, 'CAT224-' + tag + '-1'), q = await nativeProduct(a, 'CAT224-' + tag + '-2');
  await categoryOf(a, p.local, child);
  const data = baseOk(await base(a, 'getInventoryProductsData', { inventory_id: a.inventory, products: [p.id, q.id] })).products;
  assert.equal(data[String(p.id)].category_id, childId);
  assert.equal(data[String(q.id)].category_id, 0);
  const list = async (category: unknown) => Object.keys(baseOk(await base(a, 'getInventoryProductsList', { inventory_id: a.inventory, filter_category_id: category })).products).map(Number);
  assert.deepEqual(await list(childId), [p.id]);
  assert.deepEqual(await list(rootId), [], 'exact category, not the subtree');
  assert.equal((await list('')).length > 1, true);
  baseRefused(await base(a, 'getInventoryProductsList', { inventory_id: a.inventory, filter_category_id: 0 }), 422);
  // Moving the product to another category (native) changes category_id; the IDs stay.
  await categoryOf(a, p.local, root);
  assert.equal(baseOk(await base(a, 'getInventoryProductsData', { inventory_id: a.inventory, products: [p.id] })).products[String(p.id)].category_id, rootId);
  assert.deepEqual(await list(rootId), [p.id]);
  assert.deepEqual(await list(childId), []);
  // Category writes stay refused (variant B): addInventoryCategory is not registered, category_id in addInventoryProduct is not mapped.
  baseRefused(await base(a, 'addInventoryCategory', { inventory_id: a.inventory, name: 'X' }), 400);
});

test('tenant isolation: foreign catalog 404, foreign category IDs match nothing, owner functions and RLS see the own tenant only', async () => {
  const bRoot = await createCategory(b, 'Obca ' + tag);
  const bList = baseOk(await base(b, 'getInventoryCategories', { inventory_id: b.inventory })).categories;
  const [bId] = await sidecar(b.tenant, bRoot);
  assert(bList.some((c: any) => c.category_id === bId));
  assert(!bList.some((c: any) => [rootId, childId].includes(c.category_id)));
  baseRefused(await base(b, 'getInventoryCategories', { inventory_id: a.inventory }), 404);
  assert.deepEqual(Object.keys(baseOk(await base(b, 'getInventoryProductsList', { inventory_id: b.inventory, filter_category_id: rootId })).products), []);
  // dyna_app as tenant B: the owner readers return nothing for A's catalog; the sidecar shows only B's rows.
  await tenantReadTx(b.tenant, async c => {
    assert.deepEqual((await c.query('SELECT * FROM public.base_wire224_categories($1)', [a.catalog])).rows, []);
    assert.deepEqual((await c.query('SELECT * FROM public.base_wire224_product_categories($1)', [a.catalog])).rows, []);
    assert.deepEqual((await c.query('SELECT DISTINCT tenant_id FROM base_wire224_category_ids')).rows.map(r => r.tenant_id), [b.tenant]);
  });
});

test('identities are immutable; dyna_app cannot write the sidecar; allocation needs a writing transaction', async () => {
  for (const sql of ['UPDATE base_wire224_category_ids SET category_id=gen_random_uuid() WHERE public_id=$1', 'DELETE FROM base_wire224_category_ids WHERE public_id=$1'])
    await assert.rejects(pool.query(sql, [childId]), /immutable/);
  await assert.rejects(pool.query('TRUNCATE base_wire224_category_ids'), /immutable/);
  await assert.rejects(tenantTx(a.tenant, c => c.query('INSERT INTO base_wire224_category_ids(tenant_id,catalog_id,category_id) VALUES($1,$2,gen_random_uuid())', [a.tenant, a.catalog])), (e: any) => e.code === '42501');
  await assert.rejects(tenantReadTx(a.tenant, c => c.query('SELECT public.base_wire224_allocate_categories()')), (e: any) => e.code === '25006');
  assert.deepEqual(await sidecar(a.tenant, child), [childId]);
});
