import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { seed } from './fixtures';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/dynaminds_test_\d+$/);
type Row = Record<string, any>;
let app: Awaited<ReturnType<typeof buildApp>>;
let cookie = '',
  tenant = '',
  warehouse = '',
  address = 1;
const prefix = '/price-matrix-imports';
const transport = async () => {
  throw Error('A local price file cannot contact providers');
};
const req = (path: string, method: any = 'GET', payload?: any) =>
  app.inject({
    method,
    url: '/api' + path,
    payload,
    headers: { cookie },
    remoteAddress: '127.2.113.' + address,
  });
async function ok(path: string, method: any = 'GET', payload?: any, status = 200) {
  const r = await req(path, method, payload);
  assert.equal(r.statusCode, status, `${method} ${path}: ${r.body.slice(0, 600)}`);
  return r.json() as Row;
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({
    integrationTransport: transport,
    logging: process.env.PRICE_MATRIX_IMPORT_TEST_LOG === 'true',
  });
  const r = await req('/auth/login', 'POST', {
    email: 'admin@demo.local',
    password: 'DynaDemo!2026',
  });
  assert.equal(r.statusCode, 200);
  cookie = String(r.headers['set-cookie']).split(';')[0];
});
beforeEach(async () => {
  ++address;
  tenant = randomUUID();
  warehouse = randomUUID();
  await pool.query(
    "INSERT INTO tenants(id,name,plan) VALUES($1,'Price file engine','enterprise')",
    [tenant],
  );
  await pool.query(
    "INSERT INTO memberships(tenant_id,user_id,role) SELECT $1,id,'admin' FROM users WHERE email='admin@demo.local'",
    [tenant],
  );
  await pool.query(
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Price file warehouse','PF')",
    [warehouse, tenant],
  );
  const fresh = await req('/auth/login', 'POST', {
    email: 'admin@demo.local',
    password: 'DynaDemo!2026',
  });
  assert.equal(fresh.statusCode, 200);
  cookie = String(fresh.headers['set-cookie']).split(';')[0];
  const r = await req('/workspaces/switch', 'POST', { tenant_id: tenant });
  assert.equal(r.statusCode, 200);
  cookie = String(r.headers['set-cookie']).split(';')[0];
});
after(async () => {
  try {
    await app?.close();
  } finally {
    await pool.end();
  }
});
const product = (extra: Row = {}) =>
  ok(
    '/products',
    'POST',
    {
      sku: 'FILE-' + randomUUID(),
      name: 'File price product',
      price: 10001,
      vat: 23,
      quantity: 5,
      warehouse_id: warehouse,
      ...extra,
    },
    201,
  );
const list = (extra: Row = {}) =>
  ok(
    '/price-lists',
    'POST',
    {
      name: 'File ' + randomUUID(),
      currency: 'PLN',
      fallback: true,
      ...extra,
    },
    201,
  );
const definition = (extra: Row = {}) => ({
  format: 'csv',
  delimiter: ';',
  identity: 'sku',
  mapping: { identity: 'sku', price: 'price', operation: 'operation' },
  amount_mode: 'decimal',
  decimal_separator: ',',
  basis: 'gross',
  empty_policy: 'skip',
  spreadsheet_safe: false,
  native_price_mode: 'mapped',
  ...extra,
});
const cell = (x: unknown) => '"' + String(x).replaceAll('"', '""') + '"';
function input(lists: Row[], rows: unknown[][], extra: Row = {}): Row {
  return {
    client_key: randomUUID(),
    file_name: 'matrix.csv',
    content:
      'sku;pln;eur;op_pln;op_eur\r\n' +
      rows.map((r) => r.map(cell).join(';')).join('\r\n') +
      '\r\n',
    targets: lists.map((l, i) => ({
      price_list_id: l.id,
      list_version: l.version,
      definition: definition({
        mapping: { identity: 'sku', price: i ? 'eur' : 'pln', operation: i ? 'op_eur' : 'op_pln' },
        decimal_separator: '.',
        basis: i ? 'gross' : 'net',
      }),
    })),
    ...extra,
  };
}
async function preview(body: Row) {
  return (await ok(prefix + '/previews', 'POST', body, 201)).preview as Row;
}
const consent = (p: Row, extra: Row = {}) => ({
  client_key: randomUUID(),
  scope_hash: p.scope_hash,
  confirmed: true as const,
  ack_missing_price_list_ids: [],
  ...extra,
});
const executionPath = (p: Row) => prefix + '/previews/' + p.id + '/execute';
async function execute(p: Row, b: Row = consent(p)) {
  return (await ok(executionPath(p), 'POST', b, 201)).execution as Row;
}
async function pages(url: string) {
  const rows: Row[] = [];
  let cursor: string | null = null;
  do {
    const r = await ok(url + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''));
    rows.push(...r.data);
    cursor = r.meta.cursor;
  } while (cursor);
  return rows;
}
async function pair() {
  return [await list(), await list({ currency: 'EUR', fallback: false })];
}
async function current(l: Row) {
  return (await ok('/price-lists/' + l.id + '/items')).list as Row;
}
async function entries(l: Row) {
  return (
    await pool.query(
      'SELECT product_id,price FROM price_list_items WHERE tenant_id=$1 AND price_list_id=$2 ORDER BY product_id',
      [tenant, l.id],
    )
  ).rows;
}
const protectedTables = [
  'products',
  'product_sku_aliases',
  'product_logistics',
  'stock',
  'stock_locations',
  'stock_movements',
  'stock_location_movements',
  'orders',
  'order_items',
  'order_events',
  'order_pick_items',
  'reservations',
  'reservation_locations',
  'payment_entries',
  'listings',
  'offer_plans',
  'jobs',
];
async function physicalAndCommerce() {
  const result: Row = {};
  for (const name of protectedTables)
    result[name] = (
      await pool.query(`SELECT to_jsonb(t) row FROM ${name} t WHERE tenant_id=$1 ORDER BY 1`, [
        tenant,
      ])
    ).rows;
  return result;
}

test('one matrix preserves exact PLN net/EUR gross, zero and none without touching commerce or a third list', async () => {
  const a = await product(),
    b = await product(),
    c = await product(),
    ls = await pair(),
    third = await list();
  const before = await physicalAndCommerce(),
    thirdBefore = await current(third);
  const p = await preview(
    input(ls, [
      [a.sku, '100.01', '17.00', 'set', 'set'],
      [b.sku, '0', '0', 'set', 'set'],
      [c.sku, '', '', 'none', 'none'],
    ]),
  );
  assert.equal(p.summary.ready, true);
  assert.equal(p.summary.total_products, 3);
  assert.equal(p.summary.total_cells, 6);
  const rows = await pages(prefix + '/previews/' + p.id + '/rows');
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => r.product_id),
    [a.id, b.id, c.id],
  );
  for (const r of rows)
    assert.deepEqual(
      r.cells.map((v: Row) => v.price_list_id),
      ls.map((l) => l.id).sort(),
    );
  const r = rows[0];
  assert.equal(r.cells.find((v: Row) => v.price_list_id === ls[0].id).after.override_price, 12301);
  assert.equal(r.cells.find((v: Row) => v.price_list_id === ls[1].id).after.override_price, 1700);
  const e = await execute(p, consent(p, { ack_missing_price_list_ids: [ls[1].id] }));
  assert.equal(e.core_execution_ids.length, 2);
  for (const [i, l] of ls.entries()) {
    assert.deepEqual(
      await entries(l),
      [
        { product_id: a.id, price: i ? 1700 : 12301 },
        { product_id: b.id, price: 0 },
      ].sort((x, y) => x.product_id.localeCompare(y.product_id)),
    );
    assert.equal((await current(l)).version, l.version + 1);
  }
  assert.deepEqual(await current(third), thirdBefore);
  assert.deepEqual(await physicalAndCommerce(), before);
});

test('remove-to-rule and missing are separate per-list facts and require exactly the missing-list consent', async () => {
  const p = await product(),
    ls = await pair();
  for (const l of ls)
    await ok('/price-lists/' + l.id + '/items', 'PUT', {
      version: l.version,
      items: [{ product_id: p.id, price: 0 }],
    });
  const now = await Promise.all(ls.map(current)),
    made = await preview(input(now, [[p.sku, '', '', 'remove', 'remove']]));
  const row = (await pages(prefix + '/previews/' + made.id + '/rows'))[0];
  assert.equal(row.cells.find((c: Row) => c.price_list_id === ls[0].id).after.source, 'rule');
  assert.equal(row.cells.find((c: Row) => c.price_list_id === ls[1].id).after.source, 'missing');
  const before = await Promise.all(ls.map(entries));
  for (const ids of [[], [ls[0].id], [ls[0].id, ls[1].id], [randomUUID()]]) {
    assert.equal(
      (
        await req(
          executionPath(made),
          'POST',
          consent(made, { ack_missing_price_list_ids: ids.sort() }),
        )
      ).statusCode,
      422,
    );
    assert.deepEqual(await Promise.all(ls.map(entries)), before);
  }
  await execute(made, consent(made, { ack_missing_price_list_ids: [ls[1].id] }));
  assert.deepEqual(await Promise.all(ls.map(entries)), [[], []]);
});

test('global concurrent exact retry is one matrix receipt; historical replay and two-list NOP never bump versions', async () => {
  const p = await product(),
    ls = await pair(),
    body = input(ls, [[p.sku, '10.00', '17.00', 'set', 'set']]),
    made = await preview(body);
  const retry = await ok(prefix + '/previews', 'POST', body);
  assert.equal(retry.reused, true);
  assert.equal(retry.preview.id, made.id);
  const b = consent(made),
    rs = await Promise.all([
      req(executionPath(made), 'POST', b),
      req(executionPath(made), 'POST', b),
    ]);
  assert.deepEqual(rs.map((r) => r.statusCode).sort(), [200, 201]);
  assert.equal(rs[0].json().execution.id, rs[1].json().execution.id);
  const eid = rs[0].json().execution.id;
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::int n FROM price_matrix_import_executions WHERE tenant_id=$1',
        [tenant],
      )
    ).rows[0].n,
    1,
  );
  const now = await Promise.all(ls.map(current));
  const nop = await preview(input(now, [[p.sku, '10.00', '17.00', 'set', 'set']]));
  assert.equal(nop.summary.changed, 0);
  await execute(nop);
  assert.deepEqual(
    (await Promise.all(ls.map(current))).map((l) => l.version),
    now.map((l) => l.version),
  );
  await ok('/price-lists/' + ls[1].id + '/items', 'PUT', {
    version: now[1].version,
    items: [{ product_id: p.id, price: 999 }],
  });
  const after = await Promise.all(ls.map(entries)),
    counts = (
      await pool.query(
        'SELECT (SELECT count(*) FROM price_bulk_edit_executions WHERE tenant_id=$1)::int core,(SELECT count(*) FROM price_matrix_import_executions WHERE tenant_id=$1)::int matrix',
        [tenant],
      )
    ).rows[0];
  const historic = await ok(executionPath(made), 'POST', b);
  assert.equal(historic.reused, true);
  assert.equal(historic.execution.id, eid);
  assert.deepEqual(await Promise.all(ls.map(entries)), after);
  assert.deepEqual(
    (
      await pool.query(
        'SELECT (SELECT count(*) FROM price_bulk_edit_executions WHERE tenant_id=$1)::int core,(SELECT count(*) FROM price_matrix_import_executions WHERE tenant_id=$1)::int matrix',
        [tenant],
      )
    ).rows[0],
    counts,
  );
  assert.equal(
    (await req(executionPath(made), 'POST', { ...b, ack_missing_price_list_ids: [ls[0].id] }))
      .statusCode,
    409,
  );
});

test('historical SKU resolves once for every cell; ambiguous identifiers and duplicate resolved UUID block all lists', async () => {
  const old = 'OLD-' + randomUUID(),
    p = await product({ sku: old, name: 'Ambiguous', ean: '5900000000001' }),
    q = await product({ name: 'Ambiguous', ean: '5900000000001' }),
    ls = await pair();
  await ok('/products/' + p.id, 'PATCH', {
    version: p.version,
    name: p.name,
    price: p.price,
    sku: 'NEW-' + randomUUID(),
    ean: p.ean,
  });
  function identity(body: Row, kind: string) {
    body.targets = body.targets.map((t: Row) => ({
      ...t,
      definition: { ...t.definition, identity: kind },
    }));
    return body;
  }
  const made = await preview(
    identity(input(ls, [[old, '1.00', '1.00', 'set', 'set']]), 'historical_sku'),
  );
  assert.equal((await pages(prefix + '/previews/' + made.id + '/rows'))[0].product_id, p.id);
  await execute(made);
  for (const [kind, values] of [
    ['ean', ['5900000000001']],
    ['name', ['Ambiguous']],
    ['uuid', [p.id, p.id]],
  ] as Array<[string, string[]]>) {
    const currentLists = await Promise.all(ls.map(current)),
      before = await Promise.all(ls.map(entries));
    const invalid = await preview(
      identity(
        input(
          currentLists,
          values.map((v) => [v, '1.00', '2.00', 'set', 'set']),
        ),
        kind,
      ),
    );
    assert.equal(invalid.summary.ready, false);
    const rows = await pages(prefix + '/previews/' + invalid.id + '/rows');
    assert.equal(rows.length, values.length);
    assert.equal((await req(executionPath(invalid), 'POST', consent(invalid))).statusCode, 409);
    assert.deepEqual(await Promise.all(ls.map(entries)), before);
  }
  assert.notEqual(q.id, p.id);
});

test('one changed list, product VAT or repricing scope rejects the entire two-list matrix and produces no partial receipts', async () => {
  for (const change of ['list', 'vat', 'price', 'repricing']) {
    const p = await product(),
      ls = await pair(),
      made = await preview(input(ls, [[p.sku, '10.00', '17.00', 'set', 'set']]));
    if (change === 'vat')
      await ok('/products/' + p.id, 'PATCH', {
        version: p.version,
        name: p.name,
        price: p.price,
        vat: 8,
      });
    else if (change === 'price')
      await ok('/price-lists/' + ls[1].id + '/items', 'PUT', {
        version: ls[1].version,
        items: [{ product_id: p.id, price: 33 }],
      });
    else if (change === 'repricing')
      await ok('/price-lists/' + ls[1].id + '/repricing', 'PUT', { version: 0, config: {} });
    else
      await ok('/price-lists/' + ls[1].id, 'PATCH', {
        version: ls[1].version,
        name: 'Changed',
        active: true,
        fallback: false,
        adjustment_bps: 0,
        adjustment_amount: 0,
      });
    const before = await Promise.all(ls.map(entries)),
      versions = (await Promise.all(ls.map(current))).map((l) => l.version),
      receipts = (
        await pool.query(
          'SELECT count(*)::int n FROM price_bulk_edit_executions WHERE tenant_id=$1',
          [tenant],
        )
      ).rows[0].n;
    assert.equal((await req(executionPath(made), 'POST', consent(made))).statusCode, 409);
    assert.deepEqual(await Promise.all(ls.map(entries)), before);
    assert.deepEqual(
      (await Promise.all(ls.map(current))).map((l) => l.version),
      versions,
    );
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int n FROM price_bulk_edit_executions WHERE tenant_id=$1',
          [tenant],
        )
      ).rows[0].n,
      receipts,
    );
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int n FROM price_matrix_import_executions WHERE tenant_id=$1 AND preview_id=$2',
          [tenant, made.id],
        )
      ).rows[0].n,
      0,
    );
  }
});

test('native XML selects own prices independently for both UUID lists and never copies effective fallback or a third list', async () => {
  const p = await product(),
    ls = await pair(),
    third = await list();
  await ok('/price-lists/' + ls[0].id + '/items', 'PUT', {
    version: ls[0].version,
    items: [{ product_id: p.id, price: 0 }],
  });
  await ok('/price-lists/' + third.id + '/items', 'PUT', {
    version: third.version,
    items: [{ product_id: p.id, price: 999 }],
  });
  const exported = await req('/catalog/exports/file', 'POST', {
    format: 'xml',
    columns: ['sku', 'prices_json'],
    selection: 'selected',
    ids: [p.id],
    price_list_ids: [third.id, ...ls.map((l) => l.id)],
    spreadsheet_safe: false,
  });
  assert.equal(exported.statusCode, 200);
  const body = input(await Promise.all(ls.map(current)), [], {
    content: exported.body,
    file_name: 'matrix.xml',
  });
  body.targets = body.targets.map((t: Row) => ({
    ...t,
    definition: definition({
      format: 'xml',
      mapping: { identity: 'sku', price: 'prices_json' },
      native_price_mode: 'own_entries',
    }),
  }));
  const made = await preview(body),
    r = (await pages(prefix + '/previews/' + made.id + '/rows'))[0];
  assert.equal(r.cells.find((c: Row) => c.price_list_id === ls[0].id).input.operation, 'set');
  assert.equal(r.cells.find((c: Row) => c.price_list_id === ls[1].id).input.operation, 'remove');
  const before = await entries(third);
  await execute(made, consent(made, { ack_missing_price_list_ids: [ls[1].id] }));
  assert.deepEqual(await entries(ls[0]), [{ product_id: p.id, price: 0 }]);
  assert.deepEqual(await entries(ls[1]), []);
  assert.deepEqual(await entries(third), before);
  const invalid = await preview({
    ...body,
    client_key: randomUUID(),
    content: exported.body.replaceAll(ls[1].id, randomUUID()),
    targets: body.targets.map((t: Row) => ({ ...t, list_version: t.list_version })),
  });
  assert.equal(invalid.summary.ready, false);
});

test('profiles CAS retain original replay revision and apply only explicitly refreshed current list versions', async () => {
  const p = await product(),
    ls = await pair(),
    body = {
      client_key: randomUUID(),
      name: 'Matrix profile',
      targets: input(ls, []).targets.map(({ list_version, ...t }: Row) => t),
    };
  const profile = (await ok(prefix + '/profiles', 'POST', body, 201)).profile;
  assert.deepEqual(
    profile.targets.map((t: Row) => t.price_list_id),
    ls.map((l) => l.id).sort(),
  );
  const changed = (
    await ok(prefix + '/profiles/' + profile.id, 'PATCH', {
      ...body,
      client_key: randomUUID(),
      version: profile.version,
      name: 'Updated',
    })
  ).profile;
  assert.equal(changed.version, profile.version + 1);
  assert.equal(
    (
      await req(prefix + '/profiles/' + profile.id, 'PATCH', {
        ...body,
        client_key: randomUUID(),
        version: profile.version,
      })
    ).statusCode,
    409,
  );
  const retry = await ok(prefix + '/profiles', 'POST', body);
  assert.equal(retry.reused, true);
  assert.equal(retry.profile.version, profile.version);
  assert.equal(retry.profile.name, profile.name);
  const apply = input(ls, [[p.sku, '1.00', '2.00', 'set', 'set']]);
  apply.targets = changed.targets.map((t: Row) => ({
    ...t,
    list_version: ls.find((l) => l.id === t.price_list_id)!.version,
  }));
  await execute(await preview(apply));
});

test(
  '500 products by two lists retain all 1000 cells through final preview and execution pages; 501 never truncates',
  { timeout: 45000 },
  async () => {
    const ls = await pair(),
      ps = Array.from({ length: 500 }, () => ({ id: randomUUID(), sku: 'BOUND-' + randomUUID() }));
    await pool.query(
      "INSERT INTO products(id,tenant_id,sku,name,price) SELECT id,$1,sku,'Matrix boundary',100 FROM jsonb_to_recordset($2::jsonb)x(id uuid,sku text)",
      [tenant, JSON.stringify(ps)],
    );
    const body = input(
        ls,
        ps.map((p) => [p.sku, '0', '0', 'set', 'set']),
      ),
      made = await preview(body);
    assert.equal(made.summary.total_products, 500);
    assert.equal(made.summary.total_cells, 1000);
    const before = await pages(prefix + '/previews/' + made.id + '/rows');
    assert.equal(before.length, 500);
    assert.deepEqual(
      before.map((r) => r.product_id),
      ps.map((p) => p.id),
    );
    assert(before.every((r) => r.cells.length === 2));
    const e = await execute(made),
      after = await pages(prefix + '/executions/' + e.id + '/rows');
    assert.equal(after.length, 500);
    assert.deepEqual(
      after.map((r) => r.product_id),
      ps.map((p) => p.id),
    );
    assert(after.every((r) => r.cells.length === 2));
    for (const l of ls) {
      assert.equal((await entries(l)).length, 500);
      assert.equal((await current(l)).version, l.version + 1);
    }
    const tooMany = input(await Promise.all(ls.map(current)), [
      ...ps.map((p) => [p.sku, '0', '0', 'set', 'set']),
      [ps[0].sku, '0', '0', 'set', 'set'],
    ]);
    assert.equal((await req(prefix + '/previews', 'POST', tooMany)).statusCode, 422);
  },
);

test('missing price column preserves one list while explicit blank removes; missing configured currency is a durable invalid matrix', async () => {
  const p = await product(),
    ls = await pair();
  for (const l of ls)
    await ok('/price-lists/' + l.id + '/items', 'PUT', {
      version: l.version,
      items: [{ product_id: p.id, price: 333 }],
    });
  const body = input(await Promise.all(ls.map(current)), [], {
    content: `sku;eur;op_eur\r\n${p.sku};;remove\r\n`,
  });
  body.targets[0].definition = definition({
    mapping: { identity: 'sku', price: 'pln' },
    empty_policy: 'remove',
  });
  const made = await preview(body),
    r = (await pages(prefix + '/previews/' + made.id + '/rows'))[0];
  assert.equal(r.cells.find((c: Row) => c.price_list_id === ls[0].id).input.operation, 'none');
  await execute(made, consent(made, { ack_missing_price_list_ids: [ls[1].id] }));
  assert.deepEqual(await entries(ls[0]), [{ product_id: p.id, price: 333 }]);
  assert.deepEqual(await entries(ls[1]), []);
  const invalid = input(await Promise.all(ls.map(current)), [
    [p.sku, '1.00', '2.00', 'set', 'set'],
  ]);
  invalid.targets[1].definition.mapping.currency = 'Currency';
  const plan = await preview(invalid);
  assert.equal(plan.summary.ready, false);
  const before = await Promise.all(ls.map(entries));
  assert.equal((await req(executionPath(plan), 'POST', consent(plan))).statusCode, 409);
  assert.deepEqual(await Promise.all(ls.map(entries)), before);
});
