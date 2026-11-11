import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { PoolClient } from 'pg';
import { migrate, pool, tenantTx } from '../server/db';
import { seed } from './fixtures';
import { createOrder, orderSchema, type Actor } from '../server/domain';
import { locationOperation } from '../server/stock-locations';
import {
  inventoryBulkEditRow,
  inventoryBulkEditSelectionQuery,
  inventoryBulkEditPreviewInput,
} from '../server/inventory-bulk-edit-schema';
import {
  createInventoryBulkEditPreview,
  executeInventoryBulkEdit,
  inventoryBulkEditPreviewRows,
  inventoryBulkEditExecutionRows,
  inventoryBulkEditSelection,
  inventoryBulkEditMetadata,
  inventoryBulkEditHash,
} from '../server/inventory-bulk-edit';

assert.equal(process.env.DYNA_TEST, 'true');
assert.match(new URL(process.env.DATABASE_URL!).pathname, /^\/dynaminds_\w*test_\w+$/);
let a: Actor, user: string, w: string;
before(async () => {
  await migrate();
  if (!(await pool.query("SELECT to_regclass('public.inventory_bulk_edit_previews') p")).rows[0].p)
    await pool.query(
      readFileSync(new URL('../server/086_inventory_bulk_edit.sql', import.meta.url), 'utf8'),
    );
  await seed();
  user = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
});
beforeEach(async () => {
  a = { tenantId: randomUUID(), userId: user, role: 'admin' };
  w = randomUUID();
  await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,'QA107 inventory','enterprise')", [
    a.tenantId,
  ]);
  await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [
    a.tenantId,
    user,
  ]);
  await pool.query("INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'QA107','MAIN')", [
    w,
    a.tenantId,
  ]);
});
after(() => pool.end());
const tx = <T>(fn: (c: PoolClient) => Promise<T>) => tenantTx(a.tenantId, fn);
async function product(quantity: number | null = 10, kind = 'simple') {
  const id = randomUUID();
  await tx(async (c) => {
    await c.query(
      'INSERT INTO products(id,tenant_id,sku,name,price,kind) VALUES($1,$2,$3,$4,1234,$5)',
      [id, a.tenantId, 'I-' + id, 'QA inventory', kind],
    );
    if (quantity !== null)
      await c.query(
        'INSERT INTO stock(tenant_id,warehouse_id,product_id,on_hand) VALUES($1,$2,$3,$4)',
        [a.tenantId, w, id, quantity],
      );
  });
  return id;
}
async function stock(id: string, warehouse = w) {
  return tx(
    async (c) =>
      (
        await c.query('SELECT * FROM stock WHERE warehouse_id=$1 AND product_id=$2', [
          warehouse,
          id,
        ])
      ).rows[0] ?? null,
  );
}
async function input(
  id: string,
  operation: 'none' | 'count' | 'move' = 'none',
  extra: any = {},
  location = 'A-01',
) {
  const s = await stock(id),
    p = await tx(
      async (c) => (await c.query('SELECT version FROM products WHERE id=$1', [id])).rows[0],
    );
  return {
    product_id: id,
    product_version: p.version,
    stock_version: s?.version ?? null,
    location,
    operation,
    ...extra,
  } as any;
}
const preview = async (rows: any[], extra: any = {}) =>
  (
    await createInventoryBulkEditPreview(a, {
      client_key: randomUUID(),
      warehouse_id: w,
      note: 'QA107 pomiar i przesunięcie',
      rows,
      ...extra,
    })
  ).preview;
const consent = (p: any) => ({
  client_key: randomUUID(),
  scope_hash: p.scope_hash,
  confirmed: true as const,
});
const bins = (id: string) =>
  tx(
    async (c) =>
      (
        await c.query(
          'SELECT location,quantity FROM stock_locations WHERE warehouse_id=$1 AND product_id=$2 ORDER BY location',
          [w, id],
        )
      ).rows,
  );
async function setupMove(id: string, quantity: number, destination = 'B-02') {
  const s = await stock(id);
  return tx((c) =>
    locationOperation(
      c,
      a,
      {
        warehouse_id: w,
        product_id: id,
        location: 'A-01',
        expected_version: s.version,
        client_key: randomUUID(),
        note: 'QA107 setup',
        quantity,
        destination,
      },
      'move',
    ),
  );
}
async function business() {
  return tx(async (c) => ({
    products: (await c.query('SELECT * FROM products ORDER BY id')).rows,
    stock: (await c.query('SELECT * FROM stock ORDER BY warehouse_id,product_id')).rows,
    bins: (await c.query('SELECT * FROM stock_locations ORDER BY warehouse_id,product_id,location'))
      .rows,
    reservations: (await c.query('SELECT * FROM reservations ORDER BY order_id,product_id')).rows,
    allocations: (
      await c.query('SELECT * FROM reservation_locations ORDER BY order_id,product_id,location')
    ).rows,
    movements: (await c.query('SELECT * FROM stock_movements ORDER BY id')).rows,
    location_movements: (await c.query('SELECT * FROM stock_location_movements ORDER BY id')).rows,
    operations: (await c.query('SELECT * FROM stock_location_operations ORDER BY id')).rows,
    audit: (
      await c.query(
        "SELECT * FROM audit_events WHERE action NOT LIKE 'inventory.bulk.%' ORDER BY id",
      )
    ).rows,
    orders: (await c.query('SELECT * FROM orders ORDER BY id')).rows,
    jobs: (await c.query('SELECT * FROM jobs ORDER BY id')).rows,
    events: (await c.query('SELECT * FROM order_events ORDER BY id')).rows,
  }));
}

test('strict units, UTF16 locations, operation-specific shape and separate selection50/write500 boundaries', () => {
  const r = {
    product_id: randomUUID(),
    product_version: 1,
    stock_version: '0',
    location: 'A-01',
    operation: 'none',
  };
  assert(inventoryBulkEditRow.safeParse(r).success);
  for (const bad of [
    { ...r, quantity: 0 },
    { ...r, destination: 'B' },
    { ...r, stock_version: '00' },
    { ...r, stock_version: 'oops' },
    { ...r, stock_version: '9223372036854775808' },
    { ...r, product_version: 2147483648 },
    { ...r, location: '\ud800' },
    { ...r, location: 'A\0B' },
    { ...r, location: '😀'.repeat(41) },
    { ...r, operation: 'count', quantity: -1 },
    { ...r, operation: 'count', quantity: 1.5 },
    { ...r, operation: 'count', quantity: 1000001 },
    { ...r, operation: 'move', quantity: 0, destination: 'B' },
  ])
    assert.equal(inventoryBulkEditRow.safeParse(bad).success, false);
  const ids = Array.from({ length: 500 }, () => randomUUID());
  assert(
    inventoryBulkEditSelectionQuery.safeParse({
      warehouse_id: randomUUID(),
      ids: ids.slice(0, 50).join(','),
    }).success,
  );
  assert.equal(
    inventoryBulkEditSelectionQuery.safeParse({
      warehouse_id: randomUUID(),
      ids: ids.slice(0, 51).join(','),
    }).success,
    false,
  );
  const b = {
    client_key: randomUUID(),
    warehouse_id: randomUUID(),
    note: 'Pomiar',
    rows: ids.map((product_id) => ({ ...r, product_id })),
  };
  assert(inventoryBulkEditPreviewInput.safeParse(b).success);
  assert.equal(
    inventoryBulkEditPreviewInput.safeParse({
      ...b,
      rows: [...b.rows, { ...r, product_id: randomUUID() }],
    }).success,
    false,
  );
  assert.equal(inventoryBulkEditPreviewInput.safeParse({ ...b, rows: [r, r] }).success, false);
  assert.equal(
    inventoryBulkEditPreviewInput.safeParse({
      ...b,
      rows: [r, { ...r, location: 'B', stock_version: '1' }],
    }).success,
    false,
  );
});

test('global counts precede moves even in reversed input order; destination count shows final amount and common final stock version', async () => {
  const p = await product();
  await setupMove(p, 5);
  const before = await stock(p),
    baseline = await business();
  const v = await preview([
    await input(p, 'move', { quantity: 4, destination: 'B-02' }),
    await input(p, 'count', { quantity: 8 }, 'B-02'),
  ]);
  assert(v.ready);
  assert.equal(v.changed, 2);
  assert.deepEqual(await business(), baseline);
  const frozen = (await inventoryBulkEditPreviewRows(a, v.id)).data;
  assert.equal(frozen[0].after.quantity, 1);
  assert.equal(frozen[1].after.quantity, 12);
  assert.equal(frozen[1].after.warehouse_on_hand, 13);
  assert.equal(frozen[1].after.stock_version, (BigInt(before.version) + 2n).toString());
  const result = await executeInventoryBulkEdit(a, v.id, consent(v));
  assert.equal(result.execution.changed, 2);
  assert.deepEqual(await bins(p), [
    { location: 'A-01', quantity: 1 },
    { location: 'B-02', quantity: 12 },
  ]);
  const receipts = (await inventoryBulkEditExecutionRows(a, result.execution.id)).data;
  assert(
    receipts.every(
      (r) =>
        r.before_stock_version === before.version &&
        r.after_stock_version === (BigInt(before.version) + 2n).toString() &&
        r.operation_ids.length === 1,
    ),
  );
  const after = await business();
  assert.deepEqual(after.products, baseline.products);
  assert.deepEqual(after.orders, baseline.orders);
  assert.deepEqual(after.jobs, baseline.jobs);
  assert.deepEqual(after.events, baseline.events);
  assert.equal(after.movements.length - baseline.movements.length, 1);
  assert.equal(after.location_movements.length - baseline.location_movements.length, 3);
});

test('incoming moves never finance outgoing moves; unknown existing source is invalid rather than zero', async () => {
  const p = await product();
  await setupMove(p, 10);
  const baseline = await business();
  const v = await preview([
    await input(p, 'move', { quantity: 1, destination: 'A-01' }, 'B-02'),
    await input(p, 'move', { quantity: 1, destination: 'C-03' }),
  ]);
  assert.equal(v.ready, false);
  const rows = (await inventoryBulkEditPreviewRows(a, v.id)).data;
  assert.equal(rows[1].status, 'invalid');
  assert(rows[1].errors.some((x: string) => x.includes('przychodzących')));
  await assert.rejects(executeInventoryBulkEdit(a, v.id, consent(v)), (e: any) => e.status === 409);
  assert.deepEqual(await business(), baseline);
  const unknown = await preview([await input(p, 'count', { quantity: 5 }, 'DOES-NOT-EXIST')]);
  assert.equal(unknown.ready, false);
  assert.equal((await inventoryBulkEditPreviewRows(a, unknown.id)).data[0].before.quantity, null);
});

test('none can be a receiving destination, while genuine unchanged counts/none create no movement, operation or version', async () => {
  const p = await product();
  await setupMove(p, 5);
  const v = await preview([
    await input(p, 'move', { quantity: 2, destination: 'B-02' }),
    await input(p, 'none', {}, 'B-02'),
  ]);
  assert.equal(v.changed, 1);
  assert.equal(v.unchanged, 1);
  const frozen = (await inventoryBulkEditPreviewRows(a, v.id)).data;
  assert.equal(frozen[1].status, 'unchanged');
  assert.equal(frozen[1].after.quantity, 7);
  const e = await executeInventoryBulkEdit(a, v.id, consent(v));
  const receipt = (await inventoryBulkEditExecutionRows(a, e.execution.id)).data[1];
  assert.equal(receipt.after.quantity, 7);
  assert.deepEqual(receipt.operation_ids, []);
  const baseline = await business(),
    n = await preview([
      await input(p, 'count', { quantity: 3 }),
      await input(p, 'none', {}, 'B-02'),
    ]);
  assert.equal(n.changed, 0);
  assert.equal(n.unchanged, 2);
  await executeInventoryBulkEdit(a, n.id, consent(n));
  assert.deepEqual(await business(), baseline);
});

test('absent stock NOP/count0 preserves absence; positive count creates stock only in its warehouse; nonphysical rows remain explicit', async () => {
  const p = await product(null),
    group = await product(null, 'group');
  const selection = await inventoryBulkEditSelection(a, { warehouse_id: w, ids: [p, group] });
  assert.equal(selection.data.length, 2);
  const empty = selection.data.find((r) => r.product_id === p);
  assert.equal(empty.exists, false);
  assert.equal(empty.stock_version, null);
  assert.equal(empty.quantity, 0);
  assert.equal(selection.data.find((r) => r.product_id === group).editable, false);
  const baseline = await business(),
    nop = await preview([await input(p, 'count', { quantity: 0 })]);
  await executeInventoryBulkEdit(a, nop.id, consent(nop));
  assert.equal(await stock(p), null);
  assert.deepEqual(await business(), baseline);
  const v = await preview([await input(p, 'count', { quantity: 7 })]);
  assert.equal(v.ready, true);
  const e = await executeInventoryBulkEdit(a, v.id, consent(v));
  assert.equal((await stock(p)).on_hand, 7);
  assert.equal((await stock(p)).version, '1');
  assert.equal(
    (await inventoryBulkEditExecutionRows(a, e.execution.id)).data[0].before_stock_version,
    null,
  );
  const blocked = await preview([await input(group, 'count', { quantity: 5 })]);
  assert.equal(blocked.ready, false);
  assert.equal(await stock(group), null);
  const other = randomUUID();
  await pool.query(
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Second','SECOND')",
    [other, a.tenantId],
  );
  await tx((c) =>
    c.query('INSERT INTO stock(tenant_id,warehouse_id,product_id,on_hand) VALUES($1,$2,$3,19)', [
      a.tenantId,
      other,
      p,
    ]),
  );
  const count = await preview([await input(p, 'count', { quantity: 8 })]);
  await executeInventoryBulkEdit(a, count.id, consent(count));
  assert.equal((await stock(p, other)).on_hand, 19);
  assert.equal((await inventoryBulkEditMetadata(a)).warehouses.length, 2);
});

test('active reservation floors block counts and moves without changing allocations or order snapshots', async () => {
  const p = await product();
  await tx((c) =>
    createOrder(
      c,
      a,
      orderSchema.parse({
        warehouse_id: w,
        customer_name: 'QA reservation',
        email: 'qa@example.test',
        items: [{ product_id: p, quantity: 6 }],
      }),
    ),
  );
  const baseline = await business();
  for (const row of [
    await input(p, 'count', { quantity: 5 }),
    await input(p, 'move', { quantity: 5, destination: 'B-02' }),
  ]) {
    const v = await preview([row]);
    assert.equal(v.ready, false);
    await assert.rejects(
      executeInventoryBulkEdit(a, v.id, consent(v)),
      (e: any) => e.status === 409,
    );
  }
  assert.deepEqual(await business(), baseline);
  const v = await preview([await input(p, 'count', { quantity: 8 })]);
  await executeInventoryBulkEdit(a, v.id, consent(v));
  const after = await business();
  assert.deepEqual(after.allocations, baseline.allocations);
  assert.deepEqual(after.reservations, baseline.reservations);
  assert.deepEqual(after.orders, baseline.orders);
  assert.equal((await stock(p)).reserved, 6);
});

test('stock version detects ABA and a stale final row rejects every row atomically; exact replay survives changed live CAS', async () => {
  const p = await product(),
    q = await product();
  const v = await preview([
    await input(p, 'count', { quantity: 12 }),
    await input(q, 'count', { quantity: 13 }),
  ]);
  await tx((c) =>
    c.query('UPDATE stock SET on_hand=on_hand WHERE warehouse_id=$1 AND product_id=$2', [w, q]),
  );
  const baseline = await business();
  await assert.rejects(executeInventoryBulkEdit(a, v.id, consent(v)), (e: any) => e.status === 409);
  assert.deepEqual(await business(), baseline);
  const body = {
    client_key: randomUUID(),
    warehouse_id: w,
    note: 'QA canonical replay',
    rows: [await input(p, 'count', { quantity: 12 })],
  };
  const first = await createInventoryBulkEditPreview(a, body);
  const reordered = JSON.parse(JSON.stringify(body), (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).reverse())
      : v,
  );
  assert.equal((await createInventoryBulkEditPreview(a, reordered)).reused, true);
  const key = consent(first.preview),
    e = await executeInventoryBulkEdit(a, first.preview.id, key);
  await tx((c) =>
    c.query('UPDATE stock SET on_hand=on_hand WHERE warehouse_id=$1 AND product_id=$2', [w, p]),
  );
  const saved = await business();
  const retry = await executeInventoryBulkEdit(a, first.preview.id, key);
  assert.equal(retry.reused, true);
  assert.equal(retry.execution.id, e.execution.id);
  assert.deepEqual(await business(), saved);
  await assert.rejects(
    createInventoryBulkEditPreview(a, { ...body, note: 'inny zakres' }),
    (e: any) => e.status === 409,
  );
  await assert.rejects(
    executeInventoryBulkEdit(a, first.preview.id, { ...key, scope_hash: '0'.repeat(64) }),
    (e: any) => e.status === 409,
  );
  assert.equal(
    inventoryBulkEditHash({ b: 1, a: { x: 2, y: 3 } }),
    inventoryBulkEditHash({ a: { y: 3, x: 2 }, b: 1 }),
  );
});

test('500 explicit write rows stay complete through all 50-row proof pages; selection cursor is warehouse/scope bound', async () => {
  const ids = Array.from({ length: 500 }, () => randomUUID());
  await tx(async (c) => {
    await c.query(
      "INSERT INTO products(id,tenant_id,sku,name,price) SELECT id,$1,'I-'||id,'QA500',100 FROM unnest($2::uuid[]) id",
      [a.tenantId, ids],
    );
    // Keep fixture statements bounded with every native row guard active. The
    // preview and execution below still receive all 500 rows in one request.
    for (let offset = 0; offset < ids.length; offset += 50) {
      await c.query(
        'INSERT INTO stock(tenant_id,warehouse_id,product_id,on_hand) SELECT $1,$2,id,10 FROM unnest($3::uuid[]) id',
        [a.tenantId, w, ids.slice(offset, offset + 50)],
      );
    }
  });
  const baseline = await business();
  const v = await preview(
    ids.map((product_id) => ({
      product_id,
      product_version: 1,
      stock_version: '0',
      location: 'A-01',
      operation: 'none',
    })),
  );
  assert.equal(v.total, 500);
  assert.equal(v.unchanged, 500);
  let cursor: string | undefined,
    seen: number[] = [];
  do {
    const page = await inventoryBulkEditPreviewRows(a, v.id, cursor);
    assert(page.data.length <= 50);
    seen.push(...page.data.map((r) => r.index));
    cursor = page.meta.cursor ?? undefined;
  } while (cursor);
  assert.deepEqual(
    seen,
    Array.from({ length: 500 }, (_, i) => i),
  );
  const e = await executeInventoryBulkEdit(a, v.id, consent(v));
  seen = [];
  do {
    const page = await inventoryBulkEditExecutionRows(a, e.execution.id, cursor);
    seen.push(...page.data.map((r) => r.index));
    cursor = page.meta.cursor ?? undefined;
  } while (cursor);
  assert.equal(new Set(seen).size, 500);
  assert.deepEqual(await business(), baseline);
  // Fifty products can have more than one bin; pagination carries the exact sorted request identity.
  await setupMove(ids[0], 1);
  const selection = await inventoryBulkEditSelection(a, { warehouse_id: w, ids: ids.slice(0, 50) });
  assert.equal(selection.meta.total, 51);
  assert.equal(selection.data.length, 50);
  assert(selection.meta.cursor);
  const last = await inventoryBulkEditSelection(a, {
    warehouse_id: w,
    ids: ids.slice(0, 50).reverse(),
    cursor: selection.meta.cursor!,
  });
  assert.equal(last.data.length, 1);
  await assert.rejects(
    inventoryBulkEditSelection(a, {
      warehouse_id: w,
      ids: ids.slice(1, 51),
      cursor: selection.meta.cursor!,
    }),
    (e: any) => e.status === 422,
  );
  await assert.rejects(
    preview([
      {
        product_id: randomUUID(),
        product_version: 1,
        stock_version: null,
        location: 'A-01',
        operation: 'count',
        quantity: 1,
      },
    ]),
    (e: any) => e.status === 422,
  );
});
