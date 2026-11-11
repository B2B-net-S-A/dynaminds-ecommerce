import { test, before, beforeEach, after } from 'node:test';
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
import {
  productLogisticsPatchSchema,
  unknownProductLogistics,
  PRODUCT_LOGISTICS_FIELDS,
} from '../server/product-logistics-schema';
import { attachProductLogistics } from '../server/product-logistics';
import {
  catalogBulkEditHash,
  createCatalogBulkEditPreview,
  executeCatalogBulkEdit,
  catalogBulkEditPreviewRows,
  catalogBulkEditExecutionRows,
} from '../server/catalog-bulk-edit';
import { CATALOG_BULK_EDIT_FIELDS } from '../server/catalog-bulk-edit-schema';

assert.equal(process.env.DYNA_TEST, 'true');
assert.match(new URL(process.env.DATABASE_URL!).pathname, /^\/dynaminds_\w*test_\w+$/);
let a: Actor, warehouse: string, user: string;
const profile = {
  weight_grams: 1200,
  length_mm: 300,
  width_mm: 200,
  height_mm: 100,
  manufacturer: 'Producent QA',
};
const profileOf = (p: any) => Object.fromEntries(PRODUCT_LOGISTICS_FIELDS.map((k) => [k, p[k]]));
const oldFields = CATALOG_BULK_EDIT_FIELDS.slice(0, 9);
const oldOf = (p: any) => Object.fromEntries(oldFields.map((k) => [k, p[k]]));
before(async () => {
  await migrate();
  if (!(await pool.query("SELECT to_regclass('public.product_logistics') p")).rows[0].p)
    await pool.query(
      readFileSync(new URL('../server/083_product_logistics.sql', import.meta.url), 'utf8'),
    );
  await seed();
  user = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
});
beforeEach(async () => {
  a = { tenantId: randomUUID(), userId: user, role: 'admin' };
  warehouse = randomUUID();
  await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,'QA105 logistics','enterprise')", [
    a.tenantId,
  ]);
  await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [
    a.tenantId,
    user,
  ]);
  await pool.query(
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'QA105','LOGISTICS')",
    [warehouse, a.tenantId],
  );
});
after(() => pool.end());
const tx = <T>(fn: (c: PoolClient) => Promise<T>) => tenantTx(a.tenantId, fn);
async function create(extra: any = {}) {
  return tx((c) =>
    createProduct(
      c,
      a,
      productSchema.parse({
        sku: 'LOG-' + randomUUID(),
        name: 'Produkt logistyczny',
        price: 1234,
        warehouse_id: warehouse,
        quantity: 10,
        ...extra,
      }),
    ),
  );
}
async function detail(id: string) {
  return tx((c) => productDetail(c, id));
}
async function edit(p: any, changes: any = {}) {
  // A legacy client sends the original nine fields and component definition, omitting the logistics profile.
  return tx((c) =>
    editProduct(c, a, p.id, editSchema.parse({ ...oldOf(p), version: p.version, ...changes })),
  );
}
async function preview(rows: any[]) {
  return (
    await createCatalogBulkEditPreview(a, {
      client_key: randomUUID(),
      rows: rows.map((p) => ({ product_id: p.id, version: p.version, changes: p.changes ?? {} })),
    })
  ).preview;
}
const consent = (p: any) => ({
  client_key: randomUUID(),
  scope_hash: p.scope_hash,
  confirmed: true as const,
});
async function business() {
  return tx(async (c) => ({
    products: (await c.query('SELECT * FROM products ORDER BY id')).rows,
    profiles: (await c.query('SELECT * FROM product_logistics ORDER BY product_id')).rows,
    stock: (await c.query('SELECT * FROM stock ORDER BY product_id')).rows,
    movements: (await c.query('SELECT * FROM stock_movements ORDER BY id')).rows,
    audits: (await c.query('SELECT * FROM audit_events ORDER BY id')).rows,
    jobs: (await c.query('SELECT * FROM jobs ORDER BY id')).rows,
    executions: (await c.query('SELECT * FROM catalog_bulk_edit_executions ORDER BY id')).rows,
  }));
}

test('exact integer units, nullable unknowns, trimmed manufacturer and strict Unicode bounds', () => {
  assert.deepEqual(productLogisticsPatchSchema.parse({}), {});
  assert.deepEqual(
    productLogisticsPatchSchema.parse(unknownProductLogistics()),
    unknownProductLogistics(),
  );
  assert.deepEqual(
    productLogisticsPatchSchema.parse({
      weight_grams: 100000000,
      length_mm: 100000,
      width_mm: 1,
      height_mm: 1,
      manufacturer: '  Marka  ',
    }),
    {
      weight_grams: 100000000,
      length_mm: 100000,
      width_mm: 1,
      height_mm: 1,
      manufacturer: 'Marka',
    },
  );
  for (const value of [0, -1, 1.5, 100000001, '100', NaN, Infinity])
    assert.equal(productLogisticsPatchSchema.safeParse({ weight_grams: value }).success, false);
  for (const key of ['length_mm', 'width_mm', 'height_mm'])
    for (const value of [0, 1.5, 100001])
      assert.equal(productLogisticsPatchSchema.safeParse({ [key]: value }).success, false);
  for (const value of ['', '  ', 'a'.repeat(201), 'NUL\0', '\ud800', '\udc00'])
    assert.equal(productLogisticsPatchSchema.safeParse({ manufacturer: value }).success, false);
  assert.equal(productLogisticsPatchSchema.safeParse({ manufacturer: 'Marka 😀' }).success, true);
  assert.equal(productLogisticsPatchSchema.safeParse({ weight_kg: 1 }).success, false);
});

test('creation version1 and batched list/detail distinguish absent unknown profile without backfill', async () => {
  const p = await create(profile),
    q = await create();
  assert.equal(p.version, 1);
  assert.deepEqual(profileOf(p), profile);
  assert.equal(p.product_logistics_available, true);
  assert.deepEqual(profileOf(q), unknownProductLogistics());
  assert.deepEqual(profileOf(await detail(p.id)), profile);
  const list = await tx((c) => listProducts(c, { search: '', limit: 200 }));
  assert.equal(list.meta.product_logistics_available, true);
  assert.deepEqual(profileOf(list.data.find((x: any) => x.id === p.id)), profile);
  const rows = await tx((c) =>
    c.query('SELECT product_id FROM product_logistics ORDER BY product_id'),
  );
  assert.deepEqual(
    rows.rows.map((x) => x.product_id),
    [p.id],
  );
  const attached = await tx((c) => attachProductLogistics(c, [{ id: q.id, marker: 'preserved' }]));
  assert.equal(attached[0].marker, 'preserved');
  assert.deepEqual(profileOf(attached[0]), unknownProductLogistics());
});

test('ordinary edit changes one product version, preserves omitted logistics and retains legacy no-op bump', async () => {
  const p = await create(profile);
  const changed = await edit(p, { weight_grams: 2400 });
  assert.equal(changed.version, 2);
  assert.deepEqual(profileOf(changed), { ...profile, weight_grams: 2400 });
  const legacy = await edit(changed, { name: 'Nazwa legacy' });
  assert.equal(legacy.version, 3);
  assert.deepEqual(profileOf(legacy), profileOf(changed));
  const nop = await edit(legacy);
  assert.equal(nop.version, 4);
  assert.deepEqual(profileOf(nop), profileOf(changed));
  const cleared = await edit(nop, unknownProductLogistics());
  assert.equal(cleared.version, 5);
  assert.deepEqual(profileOf(cleared), unknownProductLogistics());
  const evidence = await tx((c) =>
    c.query(
      "SELECT count(*)::int n FROM audit_events WHERE action='product.update' AND entity_id=$1",
      [p.id],
    ),
  );
  assert.equal(evidence.rows[0].n, 4);
});

test('fourteen-field sheet uses explicit null clears, canonical order and a true no-op with stable replay', async () => {
  const p = await create(profile),
    q = await create();
  const before = await business();
  const v = await preview([
    { ...p, changes: { name: 'Nowa nazwa', manufacturer: null, weight_grams: null } },
    q,
  ]);
  const rows = (await catalogBulkEditPreviewRows(a, v.id)).data;
  assert.equal(Object.keys(rows[0].before).length, 15);
  assert.equal(rows[0].before.sku, p.sku);
  assert.equal(rows[0].after.sku, p.sku);
  assert.deepEqual(rows[0].changed_fields, ['name', 'weight_grams', 'manufacturer']);
  assert.equal(rows[1].status, 'unchanged');
  const b = consent(v),
    result = await executeCatalogBulkEdit(a, v.id, b);
  assert.equal(result.execution.changed, 1);
  assert.equal(result.execution.unchanged, 1);
  assert.equal((await detail(p.id)).version, 2);
  assert.equal((await detail(q.id)).version, 1);
  assert.deepEqual(profileOf(await detail(p.id)), {
    ...profile,
    weight_grams: null,
    manufacturer: null,
  });
  const after = await business();
  assert.deepEqual(after.stock, before.stock);
  assert.deepEqual(after.movements, before.movements);
  assert.equal(after.audits.length, before.audits.length + 1);
  assert.deepEqual((await executeCatalogBulkEdit(a, v.id, b)).execution, result.execution);
  assert.deepEqual(await business(), after);
  const noop = await preview([{ ...(await detail(q.id)), changes: { weight_grams: null } }]);
  const untouched = await business();
  await executeCatalogBulkEdit(a, noop.id, consent(noop));
  const final = await business();
  assert.deepEqual(final.products, untouched.products);
  assert.deepEqual(final.profiles, untouched.profiles);
  assert.deepEqual(final.audits, untouched.audits);
  assert.deepEqual(final.jobs, untouched.jobs);
});

test('a later profile-only edit invalidates the whole selected sheet without partial catalogue effects', async () => {
  const p = await create(profile),
    q = await create(profile);
  const v = await preview([
    { ...p, changes: { weight_grams: 3500 } },
    { ...q, changes: { manufacturer: 'Inny' } },
  ]);
  await edit(q, { height_mm: 250 });
  const before = await business();
  await assert.rejects(executeCatalogBulkEdit(a, v.id, consent(v)), (e: any) => e.status === 409);
  assert.deepEqual(await business(), before);
});

test('all fourteen fields may change in one receipt and one version with no stock adjustment', async () => {
  const p = await create(profile),
    before = await business();
  const changes = {
    name: 'Wszystkie pola',
    ean: '5901111111111',
    price: 4321,
    vat: 8,
    category: '',
    description: 'Nowy opis',
    active: false,
    attributes: { marka: 'nowa' },
    images: ['https://example.test/new.jpg'],
    weight_grams: 999,
    length_mm: 33,
    width_mm: 22,
    height_mm: 11,
    manufacturer: 'Nowa marka',
  };
  const v = await preview([{ ...p, changes }]);
  const rows = (await catalogBulkEditPreviewRows(a, v.id)).data;
  const changedFields = CATALOG_BULK_EDIT_FIELDS.filter((k) => k !== 'sku');
  assert.deepEqual(rows[0].changed_fields, changedFields);
  assert.deepEqual(rows[0].after, { ...changes, sku: p.sku });
  const result = await executeCatalogBulkEdit(a, v.id, consent(v));
  assert.deepEqual(
    (await catalogBulkEditExecutionRows(a, result.execution.id)).data[0].changed_fields,
    changedFields,
  );
  const saved = await detail(p.id),
    after = await business();
  assert.equal(saved.version, 2);
  assert.deepEqual(Object.fromEntries(CATALOG_BULK_EDIT_FIELDS.map((k) => [k, saved[k]])),
    { ...changes, sku: p.sku });
  assert.deepEqual(after.stock, before.stock);
  assert.deepEqual(after.movements, before.movements);
  assert.equal(after.audits.length, before.audits.length + 1);
});

test('persisted nine-field multi-change preview executes with original ordered fields, scope and immutable receipt', async () => {
  const p = await create(profile),
    id = randomUUID();
  const changes = { name: 'Nazwa starego podglądu', ean: '5900000000000', price: 7777 };
  const row = {
    index: 0,
    product_id: p.id,
    resolved_product_id: p.id,
    sku: p.sku,
    expected_version: 1,
    current_version: 1,
    status: 'changed',
    changes,
    before: oldOf(p),
    after: { ...oldOf(p), ...changes },
    changed_fields: ['name', 'ean', 'price'],
    errors: [],
  };
  const scope_hash = catalogBulkEditHash({ actor_id: user, rows: [row], rules_snapshot: [] });
  await tx(async (c) => {
    await c.query(
      "INSERT INTO catalog_bulk_edit_previews(id,tenant_id,actor_id,client_key,request_hash,scope_hash,source,rules_snapshot,total,changed,unchanged,invalid,conflicts,ready) VALUES($1,$2,$3,$4,$5,$6,'manual','[]',1,1,0,0,0,true)",
      [id, a.tenantId, user, randomUUID(), catalogBulkEditHash({ historical: true }), scope_hash],
    );
    await c.query(
      "INSERT INTO catalog_bulk_edit_rows(tenant_id,preview_id,index,product_id,resolved_product_id,sku,expected_version,current_version,status,changes,before,after,changed_fields,errors) VALUES($1,$2,0,$3,$3,$4,1,1,'changed',$5,$6,$7,$8,'[]')",
      [
        a.tenantId,
        id,
        p.id,
        p.sku,
        JSON.stringify(changes),
        JSON.stringify(row.before),
        JSON.stringify(row.after),
        JSON.stringify(row.changed_fields),
      ],
    );
  });
  const frozen = (await catalogBulkEditPreviewRows(a, id)).data;
  const b = consent({ scope_hash }),
    result = await executeCatalogBulkEdit(a, id, b);
  assert.deepEqual(profileOf(await detail(p.id)), profile);
  assert.equal((await detail(p.id)).version, 2);
  assert.deepEqual((await catalogBulkEditPreviewRows(a, id)).data, frozen);
  assert.equal(
    (
      await tx((c) =>
        c.query('SELECT scope_hash FROM catalog_bulk_edit_previews WHERE id=$1', [id]),
      )
    ).rows[0].scope_hash,
    scope_hash,
  );
  const receipts = (await catalogBulkEditExecutionRows(a, result.execution.id)).data;
  assert.deepEqual(receipts[0].changed_fields, ['name', 'ean', 'price']);
  assert.equal(Object.keys(frozen[0].before).length, 9);
  assert.equal(Object.keys(frozen[0].after).length, 9);
  const after = await business();
  assert.deepEqual((await executeCatalogBulkEdit(a, id, b)).execution, result.execution);
  assert.deepEqual(await business(), after);
});

test('older schema reads null capability, permits omitted legacy writes and rejects explicit logistics before effects', async () => {
  const p = await create(profile);
  await pool.query('ALTER TABLE product_logistics RENAME TO product_logistics_qa_missing');
  try {
    const old = await detail(p.id);
    assert.equal(old.product_logistics_available, false);
    assert.deepEqual(profileOf(old), unknownProductLogistics());
    const legacy = await edit(old, { name: 'Kopia legacy' });
    assert.equal(legacy.version, 2);
    const before = await tx(async (c) => ({
      products: (await c.query('SELECT * FROM products')).rows,
      audit: (await c.query('SELECT * FROM audit_events ORDER BY id')).rows,
    }));
    await assert.rejects(edit(legacy, { weight_grams: null }), (e: any) => e.status === 503);
    await assert.rejects(create({ manufacturer: null }), (e: any) => e.status === 503);
    const after = await tx(async (c) => ({
      products: (await c.query('SELECT * FROM products')).rows,
      audit: (await c.query('SELECT * FROM audit_events ORDER BY id')).rows,
    }));
    assert.deepEqual(after, before);
  } finally {
    await pool.query('ALTER TABLE product_logistics_qa_missing RENAME TO product_logistics');
  }
  assert.deepEqual(profileOf(await detail(p.id)), profile);
});

test('manufacturer CHECK deparse/reparse is exact and preserves its bounds without weakening recovery fingerprint', async () => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const definition = (
      await c.query(
        "SELECT pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conrelid='public.product_logistics'::regclass AND conname='product_logistics_manufacturer_check'",
      )
    ).rows[0]?.definition;
    assert.equal(typeof definition, 'string');
    await c.query(
      'CREATE TEMP TABLE product_logistics_check_roundtrip(manufacturer text) ON COMMIT DROP',
    );
    // The definition is trusted PostgreSQL metadata, exactly as pg_dump emits it.
    await c.query(
      'ALTER TABLE product_logistics_check_roundtrip ADD CONSTRAINT roundtrip_check ' + definition,
    );
    const reparsed = (
      await c.query(
        "SELECT pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conrelid='pg_temp.product_logistics_check_roundtrip'::regclass AND conname='roundtrip_check'",
      )
    ).rows[0].definition;
    assert.equal(
      reparsed,
      definition,
      'Restoring the deparsed CHECK must preserve the exact schema fingerprint',
    );
    for (const manufacturer of [null, 'A', 'A'.repeat(200), 'Marka 😀'])
      await c.query('INSERT INTO product_logistics_check_roundtrip(manufacturer) VALUES($1)', [
        manufacturer,
      ]);
    for (const manufacturer of ['', 'A'.repeat(201), ' A', 'A ']) {
      await c.query('SAVEPOINT invalid_manufacturer');
      await assert.rejects(
        c.query('INSERT INTO product_logistics_check_roundtrip(manufacturer) VALUES($1)', [
          manufacturer,
        ]),
        (e: any) => e.code === '23514',
      );
      await c.query('ROLLBACK TO SAVEPOINT invalid_manufacturer');
      await c.query('RELEASE SAVEPOINT invalid_manufacturer');
    }
  } finally {
    // The same client rolls back the temporary table and every test row on success or failure.
    try {
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  }
});
