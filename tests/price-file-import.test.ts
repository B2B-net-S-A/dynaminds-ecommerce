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
const prefix = '/price-file-imports';
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
    logging: process.env.PRICE_FILE_IMPORT_TEST_LOG === 'true',
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
function input(l: Row, rows: unknown[][], extra: Row = {}) {
  return {
    client_key: randomUUID(),
    price_list_id: l.id,
    list_version: l.version,
    file_name: 'own-prices.csv',
    definition: definition(),
    content:
      'sku;price;operation\r\n' + rows.map((r) => r.map(cell).join(';')).join('\r\n') + '\r\n',
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
  ack_missing_prices: false,
  ...extra,
});
const executionPath = (p: Row) => prefix + '/previews/' + p.id + '/execute';
async function execute(p: Row, b = consent(p)) {
  return (await ok(executionPath(p), 'POST', b, 201)).execution as Row;
}
async function coreRows(p: Row) {
  const h = (
    await pool.query(
      'SELECT core_preview_id FROM price_file_import_previews WHERE tenant_id=$1 AND id=$2',
      [tenant, p.id],
    )
  ).rows[0];
  assert(h?.core_preview_id, 'A valid file preview must bind a durable core preview');
  return (
    await pool.query(
      'SELECT * FROM price_bulk_edit_rows WHERE tenant_id=$1 AND preview_id=$2 ORDER BY index',
      [tenant, h.core_preview_id],
    )
  ).rows as Row[];
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

test('decimal net money is exact, zero is a real override, none preserves and only the selected currency list changes', async () => {
  const a = await product(),
    b = await product(),
    c = await product(),
    dot = await product(),
    l = await list(),
    eur = await list({ currency: 'EUR', fallback: false });
  const protectedBefore = await physicalAndCommerce(),
    eurBefore = await entries(eur);
  const p = await preview(
    input(
      l,
      [
        [a.sku, '100,01', 'set'],
        [b.sku, '0', 'set'],
        [c.sku, '', 'none'],
      ],
      { definition: definition({ basis: 'net' }) },
    ),
  );
  const rows = await coreRows(p);
  assert.equal(rows[0].input.amount_minor, 10001);
  assert.equal(rows[0].after.override_price, 12301);
  assert.equal(rows[1].after.override_present, true);
  assert.equal(rows[1].after.override_price, 0);
  assert.equal(rows[2].status, 'unchanged');
  await execute(p);
  assert.deepEqual(
    await entries(l),
    [
      { product_id: a.id, price: 12301 },
      { product_id: b.id, price: 0 },
    ].sort((a, b) => a.product_id.localeCompare(b.product_id)),
  );
  assert.equal((await current(l)).version, l.version + 1);
  const dotted = await preview(
    input(await current(l), [[dot.sku, '100.01', 'set']], {
      definition: definition({ basis: 'net', decimal_separator: '.' }),
    }),
  );
  const dotRow = (await coreRows(dotted))[0];
  assert.equal(dotRow.input.amount_minor, 10001);
  assert.equal(dotRow.after.override_price, 12301);
  await execute(dotted);
  const absentColumn = await preview(
    input(await current(l), [], {
      content: `sku\r\n${a.sku}\r\n`,
      definition: definition({
        empty_policy: 'remove',
        mapping: { identity: 'sku', price: 'price' },
      }),
    }),
  );
  assert.equal((await coreRows(absentColumn))[0].input.operation, 'none');
  assert.equal((await coreRows(absentColumn))[0].after.override_price, 12301);
  await execute(absentColumn);
  const emptyCell = await preview(
    input(await current(l), [], {
      content: `sku;price\r\n${a.sku};\r\n`,
      definition: definition({
        empty_policy: 'remove',
        mapping: { identity: 'sku', price: 'price' },
      }),
    }),
  );
  assert.equal((await coreRows(emptyCell))[0].input.operation, 'remove');
  await execute(emptyCell);
  assert.deepEqual(await entries(eur), eurBefore);
  assert.deepEqual(await physicalAndCommerce(), protectedBefore);
});

test('remove follows the actual rule or missing state, requires missing-price consent and absent remove is NOP', async () => {
  const p = await product(),
    l = await list({ fallback: false });
  await ok('/price-lists/' + l.id + '/items', 'PUT', {
    version: l.version,
    items: [{ product_id: p.id, price: 0 }],
  });
  const frozen = await preview(input(await current(l), [[p.sku, '', 'remove']]));
  assert.equal((await coreRows(frozen))[0].after.source, 'missing');
  const before = await entries(l),
    version = (await current(l)).version;
  assert.equal((await req(executionPath(frozen), 'POST', consent(frozen))).statusCode, 422);
  assert.deepEqual(await entries(l), before);
  assert.equal((await current(l)).version, version);
  await execute(frozen, consent(frozen, { ack_missing_prices: true }));
  assert.deepEqual(await entries(l), []);
  const absent = await preview(input(await current(l), [[p.sku, '', 'remove']]));
  assert.equal((await coreRows(absent))[0].status, 'unchanged');
  const v = (await current(l)).version;
  await execute(absent, consent(absent, { ack_missing_prices: true }));
  assert.equal((await current(l)).version, v);
  const rule = await list();
  const setRule = await preview(input(rule, [[p.sku, '100,01', 'set']]));
  assert.equal((await coreRows(setRule))[0].status, 'changed'); // equal effective price still creates own entry
  await execute(setRule);
  const remove = await preview(
    input(await current(rule), [[p.sku, '', '']], {
      definition: definition({ empty_policy: 'remove' }),
    }),
  );
  assert.equal((await coreRows(remove))[0].after.source, 'rule');
  await execute(remove);
  assert.deepEqual(await entries(rule), []);
});

test('same-key retry is one durable execution, later price edits cannot rewrite the historical receipt, equal own set is NOP', async () => {
  const p = await product(),
    l = await list(),
    body = input(l, [[p.sku, '17,00', 'set']]);
  const made = await preview(body),
    retryPreview = await ok(prefix + '/previews', 'POST', body);
  assert.equal(retryPreview.preview.id, made.id);
  assert.equal(retryPreview.reused, true);
  const b = consent(made),
    both = await Promise.all([
      req(executionPath(made), 'POST', b),
      req(executionPath(made), 'POST', b),
    ]);
  assert.deepEqual(both.map((r) => r.statusCode).sort(), [200, 201]);
  assert.equal(both[0].json().execution.id, both[1].json().execution.id);
  const e = both.find((r) => r.statusCode === 201)!.json().execution,
    after = await entries(l);
  const retried = await ok(executionPath(made), 'POST', b);
  assert.equal(retried.execution.id, e.id);
  assert.equal(retried.reused, true);
  assert.deepEqual(await entries(l), after);
  assert.equal(
    (await req(executionPath(made), 'POST', { ...b, ack_missing_prices: true })).statusCode,
    409,
  );
  const nop = await preview(input(await current(l), [[p.sku, '17,00', 'set']]));
  assert.equal((await coreRows(nop))[0].status, 'unchanged');
  const v = (await current(l)).version;
  await execute(nop);
  assert.equal((await current(l)).version, v);
  await ok('/price-lists/' + l.id + '/items', 'PUT', {
    version: v,
    items: [{ product_id: p.id, price: 999 }],
  });
  const historical = await ok(executionPath(made), 'POST', b);
  assert.equal(historical.execution.id, e.id);
  assert.equal(historical.reused, true);
  assert.deepEqual(await entries(l), [{ product_id: p.id, price: 999 }]);
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::int n FROM price_file_import_executions WHERE tenant_id=$1 AND preview_id=$2',
        [tenant, made.id],
      )
    ).rows[0].n,
    1,
  );
});

test('historical SKU matches the original UUID, ambiguous EAN/name and repeated resolved UUID block the complete file', async () => {
  const old = 'OLD-' + randomUUID(),
    p = await product({ sku: old, name: 'Repeated name', ean: '5900000000001' }),
    q = await product({ name: 'Repeated name', ean: '5900000000001' }),
    l = await list();
  await ok('/products/' + p.id, 'PATCH', {
    version: p.version,
    name: p.name,
    price: p.price,
    sku: 'NEW-' + randomUUID(),
    ean: p.ean,
  });
  const history = await preview(
    input(l, [[old, '12,00', 'set']], { definition: definition({ identity: 'historical_sku' }) }),
  );
  assert.equal((await coreRows(history))[0].product_id, p.id);
  await execute(history);
  for (const [identity, rows] of [
    ['ean', [['5900000000001', '7,00', 'set']]],
    ['name', [['Repeated name', '7,00', 'set']]],
    [
      'uuid',
      [
        [p.id, '7,00', 'set'],
        [p.id, '8,00', 'set'],
      ],
    ],
  ] as Array<[string, unknown[][]]>) {
    const before = await entries(l),
      invalid = await preview(
        input(await current(l), rows, { definition: definition({ identity }) }),
      );
    assert.equal(invalid.summary.ready, false);
    assert.equal((await req(executionPath(invalid), 'POST', consent(invalid))).statusCode, 409);
    assert.deepEqual(await entries(l), before);
  }
  assert.notEqual(p.id, q.id);
  const uniqueName = 'Identity drift ' + randomUUID(),
    named = await product({ name: uniqueName });
  const selected = await preview(
    input(await current(l), [[uniqueName, '7,00', 'set']], {
      definition: definition({ identity: 'name' }),
    }),
  );
  await product({ name: uniqueName });
  const before = await entries(l);
  assert.equal((await req(executionPath(selected), 'POST', consent(selected))).statusCode, 409);
  assert.deepEqual(await entries(l), before);
  assert(named.id);
});

test('selected native XML own entries preserve zero and rule origin without using another list effective price', async () => {
  const a = await product(),
    b = await product(),
    l = await list(),
    eur = await list({ currency: 'EUR', fallback: false });
  await ok('/price-lists/' + l.id + '/items', 'PUT', {
    version: l.version,
    items: [{ product_id: a.id, price: 0 }],
  });
  await ok('/price-lists/' + eur.id + '/items', 'PUT', {
    version: eur.version,
    items: [
      { product_id: a.id, price: 777 },
      { product_id: b.id, price: 888 },
    ],
  });
  const exportResult = await req('/catalog/exports/file', 'POST', {
    format: 'xml',
    columns: ['sku', 'prices_json'],
    selection: 'selected',
    ids: [a.id, b.id],
    price_list_ids: [eur.id, l.id],
    spreadsheet_safe: false,
  });
  assert.equal(exportResult.statusCode, 200);
  const body = input(await current(l), [], {
    content: exportResult.body,
    file_name: 'own-native.xml',
    definition: definition({
      format: 'xml',
      native_price_mode: 'own_entries',
      mapping: { identity: 'sku', price: 'prices_json' },
    }),
  });
  const p = await preview(body),
    rows = await coreRows(p);
  assert.deepEqual(
    rows.map((r) => [r.product_id, r.input.operation, r.after.override_price]).sort(),
    [
      [a.id, 'set', 0],
      [b.id, 'remove', null],
    ].sort(),
  );
  const v = (await current(l)).version,
    eurBefore = await entries(eur);
  await execute(p);
  assert.equal((await current(l)).version, v);
  assert.deepEqual(await entries(eur), eurBefore);
  const missing = await preview({
    ...body,
    client_key: randomUUID(),
    content: exportResult.body.replaceAll(l.id, randomUUID()),
  });
  assert.equal(missing.summary.ready, false);
});

test('list, product VAT and own price or repricing changes after preview fail CAS with no partial file/core receipt', async () => {
  for (const change of ['list', 'vat', 'entry', 'repricing']) {
    const p = await product(),
      l = await list(),
      frozen = await preview(input(l, [[p.sku, '10,00', 'set']]));
    if (change === 'vat')
      await ok('/products/' + p.id, 'PATCH', {
        version: p.version,
        name: p.name,
        price: p.price,
        vat: 8,
      });
    else if (change === 'entry')
      await ok('/price-lists/' + l.id + '/items', 'PUT', {
        version: l.version,
        items: [{ product_id: p.id, price: 73 }],
      });
    else if (change === 'repricing')
      await ok('/price-lists/' + l.id + '/repricing', 'PUT', { version: 0, config: {} });
    else
      await ok('/price-lists/' + l.id, 'PATCH', {
        version: l.version,
        name: 'Changed ' + randomUUID(),
        active: true,
        fallback: true,
        adjustment_bps: 0,
        adjustment_amount: 0,
      });
    const before = await entries(l),
      v = (await current(l)).version;
    assert.equal((await req(executionPath(frozen), 'POST', consent(frozen))).statusCode, 409);
    assert.deepEqual(await entries(l), before);
    assert.equal((await current(l)).version, v);
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int n FROM price_file_import_executions WHERE tenant_id=$1 AND preview_id=$2',
          [tenant, frozen.id],
        )
      ).rows[0].n,
      0,
    );
    if (change === 'list') {
      const stale = await preview(input(l, [[p.sku, '10,00', 'set']]));
      assert.equal(stale.summary.ready, false);
      assert.equal(stale.summary.conflicts, 1);
    }
  }
});

test(
  'all 500 file rows and final review/receipt pages are retained; 501 is rejected before truncation',
  { timeout: 30000 },
  async () => {
    const l = await list();
    // Synthetic own PIM scope; no 500 HTTP product effects or provider calls.
    const products = Array.from({ length: 500 }, () => ({
      id: randomUUID(),
      sku: 'BOUND-' + randomUUID(),
    }));
    await pool.query(
      `INSERT INTO products(id,tenant_id,sku,name,price) SELECT id,$1,sku,'Own boundary',100 FROM jsonb_to_recordset($2::jsonb)x(id uuid,sku text)`,
      [tenant, JSON.stringify(products)],
    );
    const body = input(
        l,
        products.map((p) => [p.sku, '0', 'set']),
      ),
      frozen = await preview(body);
    assert.equal((await coreRows(frozen)).length, 500);
    async function pages(path: string) {
      const rows: Row[] = [];
      let cursor: string | null = null;
      do {
        const r = await ok(path + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''));
        rows.push(...r.data);
        cursor = r.meta.cursor;
      } while (cursor);
      assert.equal(rows.length, 500);
      return rows;
    }
    await pages(prefix + '/previews/' + frozen.id + '/rows');
    const e = await execute(frozen);
    await pages(prefix + '/executions/' + e.id + '/rows');
    assert.equal((await entries(l)).length, 500);
    const tooMany = input(await current(l), [
      ...products.map((p) => [p.sku, '0', 'set']),
      [products[0].sku, '0', 'set'],
    ]);
    assert.equal((await req(prefix + '/previews', 'POST', tooMany)).statusCode, 422);
  },
);

test('mapping profiles preserve their exact definition, CAS edits and explicit chosen-list currency interpretation', async () => {
  const p = await product(),
    l = await list(),
    d = definition({
      mapping: { identity: 'Kod', price: 'Kwota', currency: 'Waluta' },
      amount_mode: 'minor',
    });
  const body = {
    client_key: randomUUID(),
    name: 'Own mapped profile',
    definition: d,
    price_list_id: l.id,
  };
  const profile = (await ok(prefix + '/profiles', 'POST', body, 201)).profile;
  assert.deepEqual(profile.definition, d);
  assert.equal(profile.price_list_id, l.id);
  const retried = await ok(prefix + '/profiles', 'POST', body);
  assert.equal(retried.profile.id, profile.id);
  assert.equal(retried.reused, true);
  const changed = await ok(prefix + '/profiles/' + profile.id, 'PATCH', {
    ...body,
    client_key: randomUUID(),
    version: profile.version,
    name: 'Edited profile',
  });
  assert.equal(changed.profile.version, profile.version + 1);
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
  const good = await preview(
    input(l, [], {
      definition: profile.definition,
      content: `Kod;Kwota;Waluta\r\n${p.sku};0;PLN\r\n`,
    }),
  );
  assert.equal((await coreRows(good))[0].after.override_price, 0);
  const wrong = await preview(
    input(l, [], {
      definition: profile.definition,
      content: `Kod;Kwota;Waluta\r\n${p.sku};0;EUR\r\n`,
    }),
  );
  assert.equal(wrong.summary.ready, false);
  assert.equal((await req(executionPath(wrong), 'POST', consent(wrong))).statusCode, 409);
  assert.deepEqual(await entries(l), []);
  for (const omitted of ['currency', 'operation']) {
    const invalid = await preview(
      input(l, [], {
        definition: definition({
          mapping: {
            identity: 'Kod',
            price: 'Kwota',
            [omitted]: omitted === 'currency' ? 'Waluta' : 'Dzialanie',
          },
        }),
        content: `Kod;Kwota\r\n${p.sku};1,00\r\n`,
      }),
    );
    assert.equal(invalid.summary.ready, false);
    assert.equal(invalid.summary.invalid, 1);
    assert.equal((await req(executionPath(invalid), 'POST', consent(invalid))).statusCode, 409);
  }
  // Actual exporter prefixes every SKU in spreadsheet mode, even a non-formula identifier.
  const exported = await req('/catalog/exports/file', 'POST', {
    format: 'csv',
    columns: ['sku', 'price_minor'],
    selection: 'selected',
    ids: [p.id],
    spreadsheet_safe: true,
  });
  assert.equal(exported.statusCode, 200);
  const safe = await preview(
    input(l, [], {
      content: exported.body,
      definition: definition({
        delimiter: ',',
        spreadsheet_safe: true,
        amount_mode: 'minor',
        mapping: { identity: 'sku', price: 'price_minor' },
      }),
    }),
  );
  assert.equal((await coreRows(safe))[0].product_id, p.id);
  const quoted = await product({ sku: "'literal-" + randomUUID() });
  const raw = await preview(input(l, [[quoted.sku, '1,00', 'set']]));
  assert.equal((await coreRows(raw))[0].product_id, quoted.id);
});
