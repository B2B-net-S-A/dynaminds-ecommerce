import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { PoolClient } from 'pg';
import { migrate, pool, tenantTx } from '../server/db';
import { seed } from './fixtures';
import { productSchema, type Actor } from '../server/domain';
import {
  createProduct,
  editProduct,
  editSchema,
  productDetail,
  listProducts,
} from '../server/catalog';
import { productSkuSchema } from '../server/product-sku-schema';
import { resolveProductSkus, productSkuAvailable } from '../server/product-sku';
import {
  createCatalogBulkEditPreview,
  executeCatalogBulkEdit,
  catalogBulkEditPreviewRows,
  catalogBulkEditExecutionRows,
  catalogBulkEditMetadata,
} from '../server/catalog-bulk-edit';
import { CATALOG_BULK_EDIT_FIELDS } from '../server/catalog-bulk-edit-schema';

assert.equal(process.env.DYNA_TEST, 'true');
assert.match(new URL(process.env.DATABASE_URL!).pathname, /^\/dynaminds_\w*test_\w+$/);
let a: Actor, user: string, warehouse: string;
before(async () => {
  await migrate();
  if (!(await pool.query("SELECT to_regclass('public.product_sku_aliases') p")).rows[0].p)
    await pool.query(
      readFileSync(new URL('../server/085_product_sku.sql', import.meta.url), 'utf8'),
    );
  await seed();
  user = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
});
beforeEach(async () => {
  a = { tenantId: randomUUID(), userId: user, role: 'admin' };
  warehouse = randomUUID();
  await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,'QA106 SKU','enterprise')", [
    a.tenantId,
  ]);
  await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [
    a.tenantId,
    user,
  ]);
  await pool.query("INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'QA106','SKU')", [
    warehouse,
    a.tenantId,
  ]);
});
after(() => pool.end());
const tx = <T>(fn: (c: PoolClient) => Promise<T>) => tenantTx(a.tenantId, fn);
const originalFields = CATALOG_BULK_EDIT_FIELDS.slice(0, 9);
const oldValues = (p: any) => Object.fromEntries(originalFields.map((k) => [k, p[k]]));
async function create(extra: any = {}) {
  return tx((c) =>
    createProduct(
      c,
      a,
      productSchema.parse({
        sku: 'SKU-' + randomUUID(),
        name: 'Produkt SKU',
        price: 1234,
        warehouse_id: warehouse,
        quantity: 10,
        ...extra,
      }),
    ),
  );
}
const detail = (id: string) => tx((c) => productDetail(c, id));
const edit = (p: any, changes: any = {}) =>
  tx((c) =>
    editProduct(c, a, p.id, editSchema.parse({ ...oldValues(p), version: p.version, ...changes })),
  );
const preview = async (rows: any[]) =>
  (
    await createCatalogBulkEditPreview(a, {
      client_key: randomUUID(),
      rows: rows.map((p) => ({ product_id: p.id, version: p.version, changes: p.changes ?? {} })),
    })
  ).preview;
const consent = (p: any) => ({
  client_key: randomUUID(),
  scope_hash: p.scope_hash,
  confirmed: true as const,
});
async function business() {
  return tx(async (c) => ({
    products: (await c.query('SELECT * FROM products ORDER BY id')).rows,
    aliases: (await c.query('SELECT * FROM product_sku_aliases ORDER BY sku')).rows,
    profiles: (await c.query('SELECT * FROM product_logistics ORDER BY product_id')).rows,
    stock: (await c.query('SELECT * FROM stock ORDER BY product_id')).rows,
    movements: (await c.query('SELECT * FROM stock_movements ORDER BY id')).rows,
    audit: (await c.query('SELECT * FROM audit_events ORDER BY id')).rows,
    jobs: (await c.query('SELECT * FROM jobs ORDER BY id')).rows,
    executions: (await c.query('SELECT * FROM catalog_bulk_edit_executions ORDER BY id')).rows,
  }));
}

test('explicit SKU uses the new UTF16 length limit, valid Unicode and case-sensitive trimmed codes', () => {
  assert.equal(productSkuSchema.parse('  Kod-AbC  '), 'Kod-AbC');
  assert.equal(productSkuSchema.parse('😀'.repeat(40)).length, 80);
  assert.equal(productSkuSchema.parse('SKU'), 'SKU');
  assert.equal(productSkuSchema.parse('sku'), 'sku');
  for (const value of [
    null,
    '',
    ' \t\n ',
    'x'.repeat(81),
    '😀'.repeat(41),
    'NUL\0',
    '\ud800',
    '\udc00',
    123,
  ])
    assert.equal(productSkuSchema.safeParse(value).success, false);
});

test('creation claims current codes and flat/list/metadata capability; resolver preserves exact matched case', async () => {
  const p = await create({ sku: 'Kod-A' }),
    q = await create({ sku: 'kod-a' });
  assert.equal(p.version, 1);
  assert.equal(p.product_sku_edit_available, true);
  assert.equal((await detail(q.id)).product_sku_edit_available, true);
  const resolved = await tx((c) => resolveProductSkus(c, ['Kod-A', 'kod-a', 'KOD-A', 'Kod-A']));
  assert.deepEqual(
    new Map(resolved.map((p) => [p.matched_sku, p.id])),
    new Map([
      ['Kod-A', p.id],
      ['kod-a', q.id],
    ]),
  );
  const list = await tx((c) => listProducts(c, { search: '', limit: 200 }));
  assert.equal(list.meta.product_sku_edit_available, true);
  assert(list.data.every((p: any) => p.product_sku_edit_available));
  assert.equal((await catalogBulkEditMetadata(a)).product_sku_edit_available, true);
  assert.equal(
    (await tx((c) => c.query('SELECT count(*)::int n FROM product_sku_aliases'))).rows[0].n,
    2,
  );
});

test('rename keeps UUID/stock/profile, reserves old code, blocks reuse and allows rename back without new aliases', async () => {
  const p = await create({ weight_grams: 1234, manufacturer: 'Marka' }),
    before = await business();
  const renamed = await edit(p, { sku: 'Nowy-' + randomUUID() });
  assert.equal(renamed.id, p.id);
  assert.equal(renamed.version, 2);
  assert.equal(renamed.weight_grams, 1234);
  assert.equal(renamed.manufacturer, 'Marka');
  const after = await business();
  assert.deepEqual(after.stock, before.stock);
  assert.deepEqual(after.movements, before.movements);
  assert.deepEqual(after.profiles, before.profiles);
  assert.deepEqual(
    after.audit.find((event) => event.action === 'product.update' && event.entity_id === p.id)
      .detail,
    { version: 2, sku_before: p.sku, sku_after: renamed.sku },
  );
  await assert.rejects(create({ sku: p.sku }), (e: any) => e.code === '23505');
  assert.deepEqual(await business(), after);
  const back = await edit(renamed, { sku: p.sku });
  assert.equal(back.version, 3);
  assert.equal(back.sku, p.sku);
  const aliases = (
    await tx((c) => c.query('SELECT sku,product_id FROM product_sku_aliases ORDER BY sku'))
  ).rows;
  assert.equal(aliases.length, 2);
  assert(aliases.every((x) => x.product_id === p.id));
  const legacy = await edit(back, { name: 'Nazwa klienta legacy' });
  assert.equal(legacy.sku, p.sku);
  assert.equal(legacy.version, 4);
});

test('historical exact resolver and card search find current product without changing SKU back', async () => {
  const p = await create(),
    changed = await edit(p, { sku: 'Bieżący-' + randomUUID() });
  const resolved = await tx((c) => resolveProductSkus(c, [p.sku, changed.sku, 'obcy']));
  assert.equal(resolved.length, 2);
  assert.deepEqual(new Set(resolved.map((x) => x.matched_sku)), new Set([p.sku, changed.sku]));
  assert(resolved.every((x) => x.id === p.id && x.sku === changed.sku));
  const found = await tx((c) => listProducts(c, { search: p.sku, limit: 50 }));
  assert.deepEqual(
    found.data.map((x: any) => x.id),
    [p.id],
  );
  const importedLegacy = await edit(changed, { description: 'Import po starym kodzie, bez sku' });
  assert.equal(importedLegacy.sku, changed.sku);
  assert.equal((await tx((c) => resolveProductSkus(c, [p.sku])))[0].id, p.id);
});

test('fifteen-field sheet changes one version, preserves frozen row label and exact replay; NOP keeps aliases/audit', async () => {
  const p = await create({
    weight_grams: 1200,
    length_mm: 30,
    width_mm: 20,
    height_mm: 10,
    manufacturer: 'Marka',
  });
  const q = await create(),
    before = await business();
  const changes = {
    name: 'Wszystkie pola SKU',
    ean: '5901234567890',
    price: 4321,
    vat: 8,
    category: 'Nowa',
    description: 'Nowy opis',
    active: false,
    attributes: { x: 'y' },
    images: ['https://example.test/new.jpg'],
    weight_grams: 2400,
    length_mm: 60,
    width_mm: 40,
    height_mm: 20,
    manufacturer: 'Nowa marka',
    sku: 'SKU-Nowy-' + randomUUID(),
  };
  const v = await preview([{ ...p, changes }, q]);
  assert.equal(v.ready, true);
  const rows = (await catalogBulkEditPreviewRows(a, v.id)).data;
  assert.equal(rows[0].sku, p.sku);
  assert.equal(Object.keys(rows[0].before).length, 15);
  assert.deepEqual(rows[0].after, changes);
  assert.deepEqual(rows[0].changed_fields, [...CATALOG_BULK_EDIT_FIELDS]);
  const b = consent(v),
    result = await executeCatalogBulkEdit(a, v.id, b);
  const saved = await detail(p.id);
  assert.equal(saved.id, p.id);
  assert.equal(saved.version, 2);
  assert.equal(saved.sku, changes.sku);
  const receipts = (await catalogBulkEditExecutionRows(a, result.execution.id)).data;
  assert.equal(receipts[0].sku, p.sku);
  assert.deepEqual(receipts[0].changed_fields, [...CATALOG_BULK_EDIT_FIELDS]);
  assert.equal(receipts[1].after_version, 1);
  const after = await business();
  assert.deepEqual(after.stock, before.stock);
  assert.deepEqual(after.movements, before.movements);
  assert.equal(after.audit.length, before.audit.length + 1);
  assert.deepEqual((await executeCatalogBulkEdit(a, v.id, b)).execution, result.execution);
  assert.deepEqual(await business(), after);
  const noop = await preview([{ ...(await detail(q.id)), changes: { sku: q.sku } }]),
    untouched = await business();
  await executeCatalogBulkEdit(a, noop.id, consent(noop));
  const final = await business();
  assert.deepEqual(final.products, untouched.products);
  assert.deepEqual(final.aliases, untouched.aliases);
  assert.deepEqual(final.audit, untouched.audit);
  assert.deepEqual(final.jobs, untouched.jobs);
});

test('duplicate targets, swaps and another product historical code are per-row invalid and reject entire scope', async () => {
  const p = await create(),
    q = await create();
  const free = 'Duplicated-' + randomUUID(),
    before = await business();
  for (const changes of [
    [{ sku: free }, { sku: free }],
    [{ sku: q.sku }, { sku: p.sku }],
  ]) {
    const v = await preview([
      { ...p, changes: changes[0] },
      { ...q, changes: changes[1] },
    ]);
    assert.equal(v.ready, false);
    const rows = (await catalogBulkEditPreviewRows(a, v.id)).data;
    assert(rows.every((r: any) => r.status === 'invalid' && r.errors.length));
    await assert.rejects(executeCatalogBulkEdit(a, v.id, consent(v)), (e: any) => e.status === 409);
    assert.deepEqual(await business(), before);
  }
  const moved = await edit(q, { sku: 'Moved-' + randomUUID() }),
    unchanged = await business();
  const historical = await preview([{ ...p, changes: { sku: q.sku } }]);
  assert.equal(historical.ready, false);
  await assert.rejects(edit(p, { sku: q.sku }), (e: any) => e.status === 409);
  assert.deepEqual(await business(), unchanged);
  assert.equal((await detail(moved.id)).sku, moved.sku);
});

test('target claimed after preview rejects all edits without creating aliases, history or catalogue effects', async () => {
  const p = await create(),
    q = await create(),
    target = 'Claimed-' + randomUUID();
  const v = await preview([
    { ...p, changes: { sku: target } },
    { ...q, changes: { price: 9876 } },
  ]);
  assert.equal(v.ready, true);
  await create({ sku: target });
  const before = await business();
  await assert.rejects(executeCatalogBulkEdit(a, v.id, consent(v)), (e: any) => e.status === 409);
  assert.deepEqual(await business(), before);
});

test('legacy 41-emoji SKU survives a name-only fifteen-field sheet while explicit SKU obeys the UTF16 limit', async () => {
  const id = randomUUID(),
    sku = '😀'.repeat(41);
  // Before Stage106, Zod .max(80) accepted 41 Unicode points (82 UTF-16 units).
  // Seed the persisted legacy shape without using the new create validator.
  await tx((c) =>
    c.query('INSERT INTO products(id,tenant_id,sku,name,price) VALUES($1,$2,$3,$4,1234)', [
      id,
      a.tenantId,
      sku,
      'Legacy Unicode SKU',
    ]),
  );
  const p = await detail(id),
    v = await preview([{ ...p, changes: { name: 'Nazwa po zmianie bez SKU' } }]);
  assert.equal(v.ready, true);
  const rows = (await catalogBulkEditPreviewRows(a, v.id)).data;
  assert.equal(rows[0].before.sku, sku);
  assert.equal(rows[0].after.sku, sku);
  assert.deepEqual(rows[0].changed_fields, ['name']);
  await executeCatalogBulkEdit(a, v.id, consent(v));
  const saved = await detail(id);
  assert.equal(saved.version, 2);
  assert.equal(saved.sku, sku);
  assert.equal(saved.name, 'Nazwa po zmianie bez SKU');
  assert.equal((await tx((c) => resolveProductSkus(c, [sku])))[0].id, id);
  const explicit = await preview([{ ...saved, changes: { sku } }]);
  assert.equal(explicit.ready, false);
  const invalid = (await catalogBulkEditPreviewRows(a, explicit.id)).data[0];
  assert.equal(invalid.status, 'invalid');
  assert(invalid.errors.length > 0);
  assert.equal(invalid.after, null);
  const before = await business();
  await assert.rejects(
    executeCatalogBulkEdit(a, explicit.id, consent(explicit)),
    (e: any) => e.status === 409,
  );
  assert.equal(
    editSchema.safeParse({ ...oldValues(saved), version: saved.version, sku }).success,
    false,
  );
  assert.deepEqual(await business(), before);
});

test('missing SKU module exposes false capability/current-only resolver; omission works and explicit rename503', async () => {
  const p = await create(),
    old = p.sku;
  await pool.query('ALTER TABLE product_sku_aliases RENAME TO product_sku_aliases_qa_missing');
  try {
    assert.equal(await tx((c) => productSkuAvailable(c)), false);
    assert.equal((await detail(p.id)).product_sku_edit_available, false);
    const current = await tx((c) => resolveProductSkus(c, [old]));
    assert.equal(current[0].id, p.id);
    assert.equal(current[0].matched_sku, old);
    const legacy = await edit(p, { name: 'Legacy bez SKU' });
    assert.equal(legacy.sku, old);
    const before = await tx(async (c) => ({
      products: (await c.query('SELECT * FROM products')).rows,
      audits: (await c.query('SELECT * FROM audit_events ORDER BY id')).rows,
    }));
    await assert.rejects(
      edit(legacy, { sku: 'Missing-' + randomUUID() }),
      (e: any) => e.status === 503,
    );
    await assert.rejects(
      preview([{ ...legacy, changes: { sku: old } }]),
      (e: any) => e.status === 503,
    );
    assert.deepEqual(
      await tx(async (c) => ({
        products: (await c.query('SELECT * FROM products')).rows,
        audits: (await c.query('SELECT * FROM audit_events ORDER BY id')).rows,
      })),
      before,
    );
  } finally {
    await pool.query('ALTER TABLE product_sku_aliases_qa_missing RENAME TO product_sku_aliases');
  }
  assert.equal((await detail(p.id)).product_sku_edit_available, true);
});
