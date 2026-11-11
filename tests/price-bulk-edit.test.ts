import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { PoolClient } from 'pg';
import { migrate, pool, tenantTx } from '../server/db';
import { seed } from './fixtures';
import type { Actor } from '../server/domain';
import { prices } from '../server/pricing';
import {
  priceBulkEditRow,
  priceBulkEditPreviewInput,
  priceBulkEditSelectionQuery,
} from '../server/price-bulk-edit-schema';
import {
  createPriceBulkEditPreview,
  executePriceBulkEdit,
  priceBulkEditGross,
  priceBulkEditHash,
  priceBulkEditPreviewRows,
  priceBulkEditExecutionRows,
  priceBulkEditHistory,
  priceBulkEditMetadata,
  priceBulkEditSelection,
} from '../server/price-bulk-edit';

assert.equal(process.env.DYNA_TEST, 'true');
assert.match(new URL(process.env.DATABASE_URL!).pathname, /^\/dynaminds_\w*test_\w+$/);
let a: Actor, user: string;
before(async () => {
  await migrate();
  if (!(await pool.query("SELECT to_regclass('public.price_bulk_edit_previews') p")).rows[0].p)
    await pool.query(
      readFileSync(new URL('../server/087_price_bulk_edit.sql', import.meta.url), 'utf8'),
    );
  await seed();
  user = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
});
beforeEach(async () => {
  a = { tenantId: randomUUID(), userId: user, role: 'admin' };
  await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,'QA108 prices','enterprise')", [
    a.tenantId,
  ]);
  await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [
    a.tenantId,
    user,
  ]);
});
after(() => pool.end());
const tx = <T>(f: (c: PoolClient) => Promise<T>) => tenantTx(a.tenantId, f);
async function products(n = 1, extra: any = {}) {
  const data = Array.from({ length: n }, () => ({
    id: randomUUID(),
    price: 10001,
    vat: 23,
    kind: 'simple',
    active: true,
    ...extra,
  }));
  await tx((c) =>
    c.query(
      `INSERT INTO products(id,tenant_id,sku,name,price,vat,kind,active) SELECT id,$1,'P-'||id::text,'QA108 price',price,vat,kind,active FROM jsonb_to_recordset($2::jsonb)x(id uuid,price int,vat int,kind text,active boolean)`,
      [a.tenantId, JSON.stringify(data)],
    ),
  );
  return data;
}
async function list(extra: any = {}) {
  const id = randomUUID(),
    b = {
      currency: 'PLN',
      fallback: true,
      active: true,
      adjustment_bps: 0,
      adjustment_amount: 0,
      ...extra,
    };
  await tx((c) =>
    c.query(
      'INSERT INTO price_lists(id,tenant_id,name,currency,fallback,active,adjustment_bps,adjustment_amount) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        id,
        a.tenantId,
        'QA108 ' + id,
        b.currency,
        b.fallback,
        b.active,
        b.adjustment_bps,
        b.adjustment_amount,
      ],
    ),
  );
  return id;
}
const row = (id: string, operation = 'set', extra: any = {}) =>
  ({
    product_id: id,
    product_version: 1,
    operation,
    ...(operation === 'set' ? { basis: 'gross', amount_minor: 1234 } : {}),
    ...extra,
  }) as any;
const preview = async (l: string, rows: any[], extra: any = {}) =>
  (
    await createPriceBulkEditPreview(a, {
      client_key: randomUUID(),
      price_list_id: l,
      list_version: 1,
      rows,
      ...extra,
    })
  ).preview;
const consent = (p: any, extra: any = {}) => ({
  client_key: randomUUID(),
  scope_hash: p.scope_hash,
  confirmed: true as const,
  ...extra,
});
const status = (n: number) => (e: any) => e.status === n;
async function business() {
  return tx(async (c) => ({
    products: (await c.query('SELECT * FROM products ORDER BY id')).rows,
    logistics: (await c.query('SELECT * FROM product_logistics ORDER BY product_id')).rows,
    aliases: (await c.query('SELECT * FROM product_sku_aliases ORDER BY sku')).rows,
    stock: (await c.query('SELECT * FROM stock ORDER BY warehouse_id,product_id')).rows,
    orders: (await c.query('SELECT * FROM orders ORDER BY id')).rows,
    reservations: (await c.query('SELECT * FROM reservations ORDER BY order_id,product_id')).rows,
    jobs: (await c.query('SELECT * FROM jobs ORDER BY id')).rows,
    events: (await c.query('SELECT * FROM order_events ORDER BY id')).rows,
  }));
}
const quote = (ids: string[], l: string) => tx((c) => prices(c, ids, l, a.tenantId));
async function pageAll(fn: (cursor?: string) => Promise<any>) {
  const data: any[] = [];
  let cursor: string | undefined;
  do {
    const r = await fn(cursor);
    data.push(...r.data);
    cursor = r.meta.cursor ?? undefined;
  } while (cursor);
  return data;
}

test('strict minor units and exact half-up net conversion; selection50 differs from write500', () => {
  for (const vat of [0, 5, 8, 23])
    assert.equal(priceBulkEditGross(10, vat, 'net'), Math.floor((10 * (100 + vat) + 50) / 100));
  assert.equal(priceBulkEditGross(0, 23, 'net'), 0);
  assert.equal(priceBulkEditGross(100000000, 23, 'gross'), 100000000);
  assert.equal(priceBulkEditGross(10, 5, 'net'), 11);
  assert.throws(() => priceBulkEditGross(100000000, 23, 'net'), status(422));
  const r = row(randomUUID());
  for (const bad of [
    { ...r, amount_minor: 0.5 },
    { ...r, amount_minor: -1 },
    { ...r, amount_minor: 100000001 },
    { ...r, basis: undefined },
    { ...r, product_version: 2147483648 },
    { ...r, operation: 'none' },
    { ...r, operation: 'remove' },
  ])
    assert.equal(priceBulkEditRow.safeParse(bad).success, false);
  assert(priceBulkEditRow.safeParse({ ...r, amount_minor: 0 }).success);
  const rows = Array.from({ length: 500 }, () => row(randomUUID()));
  const b = { client_key: randomUUID(), price_list_id: randomUUID(), list_version: 1, rows };
  assert(priceBulkEditPreviewInput.safeParse(b).success);
  assert.equal(
    priceBulkEditPreviewInput.safeParse({ ...b, rows: [...rows, row(randomUUID())] }).success,
    false,
  );
  assert.equal(
    priceBulkEditPreviewInput.safeParse({ ...b, rows: [rows[0], rows[0]] }).success,
    false,
  );
  assert(
    priceBulkEditSelectionQuery.safeParse({
      price_list_id: b.price_list_id,
      ids: rows
        .slice(0, 50)
        .map((r) => r.product_id)
        .join(','),
    }).success,
  );
  assert.equal(
    priceBulkEditSelectionQuery.safeParse({
      price_list_id: b.price_list_id,
      ids: rows
        .slice(0, 51)
        .map((r) => r.product_id)
        .join(','),
    }).success,
    false,
  );
});
test('net VAT rounding and gross zero write one list revision, retain input receipts and leave commerce unchanged', async () => {
  const ps = await Promise.all([0, 5, 8, 23].map((vat) => products(1, { vat }))),
    ids = ps.map((p) => p[0].id),
    l = await list(),
    before = await business();
  const inputs = ids.map((id, i) =>
      row(id, 'set', { basis: i === 0 ? 'gross' : 'net', amount_minor: i === 0 ? 0 : 10 }),
    ),
    p = await preview(l, inputs);
  assert.equal(p.changed, 4);
  assert.equal(p.ready, true);
  assert.deepEqual(await business(), before);
  const e = (await executePriceBulkEdit(a, p.id, consent(p))).execution;
  assert.equal(e.after_list_version, 2);
  assert.deepEqual(await business(), before);
  const result = await priceBulkEditExecutionRows(a, e.id);
  assert.deepEqual(
    result.data.map((r) => r.input),
    inputs,
  );
  assert.deepEqual(
    result.data.map((r) => r.after.override_price),
    [0, 11, 11, 12],
  );
  assert.deepEqual(
    (await quote(ids, l)).items.map((p) => [p.product_id, p.price]).sort(),
    ids.map((id, i) => [id, [0, 11, 11, 12][i]]).sort(),
  );
});
test('override presence is distinct from fallback and zero; real NOP leaves list revision untouched', async () => {
  const [p] = await products(1, { price: 0 }),
    l = await list();
  const first = await preview(l, [row(p.id, 'set', { amount_minor: 0 })]);
  assert.equal(first.changed, 1);
  await executePriceBulkEdit(a, first.id, consent(first));
  assert.equal((await quote([p.id], l)).items[0].source, 'override');
  const nop = await preview(l, [row(p.id, 'set', { amount_minor: 0 })], { list_version: 2 });
  assert.equal(nop.unchanged, 1);
  assert.equal(
    (await executePriceBulkEdit(a, nop.id, consent(nop))).execution.after_list_version,
    2,
  );
  const clear = await preview(l, [row(p.id, 'remove')], { list_version: 2 });
  await executePriceBulkEdit(a, clear.id, consent(clear));
  const q = await quote([p.id], l);
  assert.equal(q.items[0].source, 'rule');
  assert.equal(q.items[0].price, 0);
  const absent = await preview(l, [row(p.id, 'remove')], { list_version: 3 });
  assert.equal(absent.unchanged, 1);
  assert.equal(
    (await executePriceBulkEdit(a, absent.id, consent(absent))).execution.after_list_version,
    3,
  );
});
test('foreign currency never converts catalog fallback; intentional missing requires explicit independent consent', async () => {
  const [p] = await products(),
    l = await list({ currency: 'EUR', fallback: false });
  const missing = await preview(l, [row(p.id, 'none')]);
  assert.equal(missing.missing_after_count, 1);
  await assert.rejects(executePriceBulkEdit(a, missing.id, consent(missing)), status(422));
  const accepted = (
    await executePriceBulkEdit(a, missing.id, consent(missing, { ack_missing_prices: true }))
  ).execution;
  assert.equal(accepted.after_list_version, 1);
  await assert.rejects(quote([p.id], l), status(422));
  for (const currency of ['EUR', 'USD', 'GBP', 'CZK']) {
    const x = await list({ currency, fallback: false });
    const ready = await preview(x, [row(p.id, 'set', { basis: 'net', amount_minor: 100 })]);
    await executePriceBulkEdit(a, ready.id, consent(ready));
    assert.equal((await quote([p.id], x)).currency, currency);
    assert.equal((await quote([p.id], x)).items[0].price, 123);
  }
  const set = await preview(l, [row(p.id)]);
  await executePriceBulkEdit(a, set.id, consent(set));
  const remove = await preview(l, [row(p.id, 'remove')], { list_version: 2 });
  assert.equal(remove.missing_after_count, 1);
  const old = await quote([p.id], l);
  await assert.rejects(executePriceBulkEdit(a, remove.id, consent(remove)), status(422));
  assert.deepEqual(await quote([p.id], l), old);
  await executePriceBulkEdit(a, remove.id, consent(remove, { ack_missing_prices: true }));
  await assert.rejects(quote([p.id], l), status(422));
});
test('invalid fallback and group rows block whole scope; valid override repairs fallback without activation', async () => {
  const [p] = await products(),
    [group] = await products(1, { kind: 'group' }),
    l = await list({ adjustment_amount: -10002, active: false });
  const blocked = await preview(l, [row(p.id, 'none')]);
  assert.equal(blocked.invalid, 1);
  assert.equal(blocked.ready, false);
  await assert.rejects(executePriceBulkEdit(a, blocked.id, consent(blocked)), status(409));
  const mixture = await preview(l, [row(p.id), row(group.id)]);
  assert.equal(mixture.invalid, 1);
  assert.equal(mixture.changed, 1);
  await assert.rejects(executePriceBulkEdit(a, mixture.id, consent(mixture)), status(409));
  const repaired = await preview(l, [row(p.id)]);
  assert.equal(repaired.ready, true);
  assert.match(repaired.warnings.join(' '), /nieaktywny/);
  await executePriceBulkEdit(a, repaired.id, consent(repaired));
  assert.equal(
    (
      await tx(
        async (c) => (await c.query('SELECT active FROM price_lists WHERE id=$1', [l])).rows[0],
      )
    ).active,
    false,
  );
  await assert.rejects(quote([p.id], l), status(409));
});
test('one stale VAT/product or list baseline rejects every approved price without partial effects', async () => {
  const ps = await products(2),
    l = await list(),
    p = await preview(
      l,
      ps.map((p) => row(p.id)),
    );
  await tx((c) => c.query('UPDATE products SET vat=8,version=version+1 WHERE id=$1', [ps[1].id]));
  await assert.rejects(executePriceBulkEdit(a, p.id, consent(p)), status(409));
  assert.equal((await tx((c) => c.query('SELECT * FROM price_list_items'))).rowCount, 0);
  const rows = ps.map((p, i) => row(p.id, 'set', { product_version: i ? 2 : 1 })),
    fresh = await preview(l, rows);
  await tx((c) => c.query('UPDATE price_lists SET version=version+1 WHERE id=$1', [l]));
  await assert.rejects(executePriceBulkEdit(a, fresh.id, consent(fresh)), status(409));
  assert.equal((await tx((c) => c.query('SELECT * FROM price_bulk_edit_executions'))).rowCount, 0);
  const stale = await preview(l, rows);
  assert.equal(stale.conflicts, 2);
  assert.equal(stale.ready, false);
});
test('canonical exact retry returns original receipt after live edits; changed input/key scope is rejected', async () => {
  const [p] = await products(),
    l = await list(),
    body = {
      client_key: randomUUID(),
      price_list_id: l,
      list_version: 1,
      rows: [row(p.id, 'set', { basis: 'net', amount_minor: 100 })],
    };
  const first = await createPriceBulkEditPreview(a, body),
    reordered = JSON.parse(
      JSON.stringify({
        rows: body.rows,
        price_list_id: l,
        list_version: 1,
        client_key: body.client_key,
      }),
    );
  const second = await createPriceBulkEditPreview(a, reordered);
  assert.equal(second.reused, true);
  assert.equal(second.preview.id, first.preview.id);
  const b = consent(first.preview),
    result = await executePriceBulkEdit(a, first.preview.id, b);
  await tx((c) => c.query('UPDATE price_lists SET version=version+1 WHERE id=$1', [l]));
  assert.deepEqual(
    (await executePriceBulkEdit(a, first.preview.id, b)).execution,
    result.execution,
  );
  assert.equal((await createPriceBulkEditPreview(a, body)).reused, true);
  await assert.rejects(
    executePriceBulkEdit(a, first.preview.id, { ...b, ack_missing_prices: true }),
    status(409),
  );
  await assert.rejects(
    createPriceBulkEditPreview(a, { ...body, rows: [row(p.id, 'set', { amount_minor: 101 })] }),
    status(409),
  );
  const hist = await priceBulkEditHistory(a);
  assert.equal(hist.data.length, 1);
  assert.equal(hist.data[0].id, result.execution.id);
  assert.equal(priceBulkEditHash({ a: 1, b: [2, 3] }), priceBulkEditHash({ b: [2, 3], a: 1 }));
  assert.notEqual(priceBulkEditHash([2, 3]), priceBulkEditHash([3, 2]));
});
test('500 changed prices execute atomically once; all ten frozen pages and 500 NOPs retain one revision', async () => {
  const ps = await products(500),
    l = await list(),
    inputs = ps.map((p, i) => row(p.id, 'set', { amount_minor: i })),
    p = await preview(l, inputs);
  assert.equal(p.changed, 500);
  assert.equal(p.total, 500);
  const initial = await pageAll((cursor) => priceBulkEditPreviewRows(a, p.id, cursor));
  assert.equal(initial.length, 500);
  assert.equal(new Set(initial.map((r) => r.product_id)).size, 500);
  const e = (await executePriceBulkEdit(a, p.id, consent(p))).execution;
  assert.equal(e.after_list_version, 2);
  const result = await pageAll((cursor) => priceBulkEditExecutionRows(a, e.id, cursor));
  assert.deepEqual(
    result.map((r) => r.input),
    inputs,
  );
  assert.equal(result.length, 500);
  assert.equal((await tx((c) => c.query('SELECT * FROM price_list_items'))).rowCount, 500);
  const nop = await preview(l, inputs, { list_version: 2 });
  assert.equal(nop.unchanged, 500);
  assert.equal(
    (await executePriceBulkEdit(a, nop.id, consent(nop))).execution.after_list_version,
    2,
  );
  const selection = await priceBulkEditSelection(a, {
    price_list_id: l,
    ids: ps.slice(0, 50).map((p) => p.id),
  });
  assert.equal(selection.data.length, 50);
  assert.equal(selection.meta.cursor, null);
  const metadata = await priceBulkEditMetadata(a, { search: 'QA108' });
  assert.equal(metadata.price_lists.length, 1);
  assert.equal(metadata.limits.selection_products, 50);
});
