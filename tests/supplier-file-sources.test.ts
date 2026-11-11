import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed } from './fixtures';
import { decrypt } from '../server/security';

assert.equal(process.env.DYNA_TEST, 'true');
const db = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(db.hostname));
assert.match(db.pathname, /^\/dynaminds_test_\d+(?:\d+)?$/);
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie = '',
  tenant = '',
  user = '',
  warehouse = '',
  supplier: any;
let address = 1;
let fixtureEmail = '';
const csvConfig = {
  format: 'csv',
  delimiter: ';',
  fields: {
    remote_id: { path: 'ID', value_type: 'text' },
    sku: { path: 'SKU', value_type: 'text' },
    name: { path: 'Nazwa', value_type: 'text' },
    cost_minor: { path: 'Koszt', value_type: 'decimal_money' },
    quantity: { path: 'Stan', value_type: 'integer' },
  },
};
const head = 'ID;SKU;Nazwa;Koszt;Stan\n';
const file = (cost = '100.01', quantity = '7', two = true) =>
  head +
  `remote/A;SRC-A;Towar pierwszy;${cost};${quantity}\n` +
  (two ? 'remote/B;SRC-B;Towar drugi;0.00;0\n' : '');
function req(path: string, method: any = 'GET', payload?: any, auth = cookie, instance = app) {
  return instance.inject({
    url: '/api' + path,
    method,
    payload,
    headers: { cookie: auth },
    remoteAddress: '127.118.5.' + address,
  });
}
async function ok(path: string, method: any = 'GET', payload?: any, auth = cookie) {
  const r = await req(path, method, payload, auth);
  assert(
    [200, 201].includes(r.statusCode),
    path.startsWith('/auth') ? `${path}: ${r.statusCode}` : r.body,
  );
  if (path.startsWith('/supplier-file-'))
    assert.match(String(r.headers['cache-control']), /no-store/);
  return r.json();
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({
    integrationTransport: async () => {
      throw new Error('Unexpected provider call');
    },
  });
});
beforeEach(async () => {
  address++;
  fixtureEmail = `feed-${randomUUID()}@demo.local`;
  const r = await req(
    '/auth/signup',
    'POST',
    {
      name: 'Supplier feed QA',
      organization: { name: 'File source QA ' + address, currency: 'PLN', locale: 'pl-PL' },
      email: fixtureEmail,
      password: 'FileSourceTests!2026',
    },
    '',
  );
  assert.equal(r.statusCode, 201, r.body);
  cookie = String(r.headers['set-cookie']).split(';')[0];
  tenant = r.json().user.tenant_id;
  user = r.json().user.id;
  warehouse = (await ok('/warehouses')).data[0].id;
  supplier = await ok('/suppliers', 'POST', { name: 'Dostawca plikowy', code: 'FEED' });
});
after(async () => {
  await app.close();
  await pool.end();
});
async function source(config: any = csvConfig) {
  const body = {
    client_key: randomUUID(),
    supplier_id: supplier.id,
    name: 'Katalog CSV',
    language: 'pl',
    currency: 'EUR',
    max_handling_days: 2,
    config,
  };
  const r = await ok('/supplier-file-sources', 'POST', body);
  return { ...r.source, body };
}
async function preview(s: any, content = file(), scope = 'delta') {
  const body = {
    client_key: randomUUID(),
    version: s.version,
    filename: 'fixture.csv',
    content,
    scope,
  };
  const r = await ok('/supplier-file-sources/' + s.id + '/previews', 'POST', body);
  return { ...r.preview, body };
}
const command = (p: any, confirm_missing = false) => ({
  client_key: randomUUID(),
  confirm_rows: p.summary.total,
  confirm_missing,
});
const apply = (p: any, b = command(p)) =>
  ok('/supplier-file-previews/' + p.id + '/apply', 'POST', b);
async function catalog(s: any) {
  return (await ok('/supplier-catalog?source_id=' + s.id + '&limit=100')).data.sort(
    (a: any, b: any) => a.remote_product_id.localeCompare(b.remote_product_id),
  );
}
const protectedTables = [
  'products',
  'stock',
  'stock_locations',
  'stock_movements',
  'stock_location_movements',
  'reservations',
  'reservation_locations',
  'orders',
  'order_items',
  'product_translations',
  'price_list_items',
  'purchase_orders',
  'warehouse_documents',
];
async function protectedState() {
  const state: any = {};
  for (const name of protectedTables)
    state[name] = (
      await pool.query(`SELECT to_jsonb(t) row FROM ${name} t WHERE tenant_id=$1 ORDER BY 1`, [
        tenant,
      ])
    ).rows;
  return state;
}

test('profile CAS and exact creation retry; raw encrypted custody and full preview preserve physical/catalog data', async () => {
  const s = await source();
  const retry = await ok('/supplier-file-sources', 'POST', s.body);
  assert.equal(retry.source.id, s.id);
  assert.equal(retry.reused, true);
  assert.equal(
    (await req('/supplier-file-sources', 'POST', { ...s.body, name: 'Changed' })).statusCode,
    409,
  );
  assert((await ok('/supplier-sources')).data.some((x: any) => x.id === s.id && x.kind === 'file'));
  const before = await protectedState(),
    p = await preview(s);
  assert.deepEqual(p.summary, {
    total: 2,
    valid: 2,
    invalid: 0,
    new: 2,
    changed: 0,
    unchanged: 0,
    missing: 0,
  });
  assert.equal(p.rows.length, 2);
  assert.equal(p.rows[0].snapshot.unit_cost, 10001);
  assert.equal(p.rows[0].snapshot.quantity, 7);
  const raw = (
    await pool.query(
      'SELECT raw_content,raw_hash,raw_bytes FROM supplier_file_previews WHERE id=$1',
      [p.id],
    )
  ).rows[0];
  assert.equal(decrypt(raw.raw_content).content, p.body.content);
  assert(!raw.raw_content.includes('Towar pierwszy'));
  assert.equal(raw.raw_hash, createHash('sha256').update(p.body.content).digest('hex'));
  assert.equal(Number(raw.raw_bytes), Buffer.byteLength(p.body.content));
  assert(!JSON.stringify(p).includes(raw.raw_content));
  const b = command(p),
    r = await apply(p, b);
  assert.equal(r.run.rows.length, 2);
  assert.equal(r.run.scope_hash, p.scope_hash);
  const replay = await apply(p, b);
  assert.equal(replay.run.id, r.run.id);
  assert.equal(replay.run.scope_hash, p.scope_hash);
  const history = await ok('/supplier-file-sources/' + s.id + '/history');
  assert.equal(history.data[0].id, r.run.id);
  assert.equal(history.data[0].scope_hash, p.scope_hash);
  assert.equal(
    (
      await req('/supplier-file-previews/' + p.id + '/apply', 'POST', {
        ...b,
        confirm_missing: true,
      })
    ).statusCode,
    409,
  );
  assert.deepEqual(await protectedState(), before);
  const cfg = {
    client_key: randomUUID(),
    version: s.version,
    name: 'Katalog po edycji',
    config: csvConfig,
  };
  const updated = await ok('/supplier-file-sources/' + s.id, 'PATCH', cfg);
  assert.equal(updated.source.version, s.version + 1);
  assert.equal((await ok('/supplier-file-sources/' + s.id, 'PATCH', cfg)).reused, true);
  assert.equal(
    (await req('/supplier-file-sources/' + s.id, 'PATCH', { ...cfg, client_key: randomUUID() }))
      .statusCode,
    409,
  );
});

test('file availability -> zero-stock local product -> NET purchase -> genuine partial PZ and exact replay', async () => {
  const s = await source(),
    p = await preview(s);
  await apply(p);
  let [item] = await catalog(s);
  const product = await ok('/supplier-catalog/' + item.id + '/product', 'POST', {
    version: item.version,
    sku: 'LOCAL-FEED',
    price: 25000,
    vat: 23,
    warehouse_id: warehouse,
  });
  assert.equal((await ok('/inventory?product_id=' + product.id)).data[0].on_hand, 0);
  [item] = await catalog(s);
  const b = {
    client_key: randomUUID(),
    warehouse_id: warehouse,
    items: [{ id: item.id, version: item.version, quantity: 5 }],
  };
  const purchase = await ok('/supplier-sources/' + s.id + '/purchase', 'POST', b);
  assert.equal((await ok('/supplier-sources/' + s.id + '/purchase', 'POST', b)).id, purchase.id);
  let po = await ok('/purchase-orders/' + purchase.id);
  assert.equal(po.currency, 'EUR');
  assert.equal(po.lines[0].unit_cost, 10001);
  assert.equal(po.total_net, 50005);
  const original = (
    await pool.query('SELECT snapshot FROM supplier_catalog_purchases WHERE purchase_id=$1', [
      po.id,
    ])
  ).rows[0].snapshot;
  assert.equal(original[0].file_run_id, item.file_run_id);
  const next = await preview(s, file('50.00', '6'));
  await apply(next);
  assert.equal((await catalog(s))[0].product_id, product.id);
  assert.deepEqual(
    (
      await pool.query('SELECT snapshot FROM supplier_catalog_purchases WHERE purchase_id=$1', [
        po.id,
      ])
    ).rows[0].snapshot,
    original,
  );
  assert.equal((await ok('/products/' + product.id)).price, 25000);
  assert.equal((await ok('/inventory?product_id=' + product.id)).data[0].on_hand, 0);
  await ok('/purchase-orders/' + po.id + '/place', 'POST', { version: po.version });
  po = await ok('/purchase-orders/' + po.id);
  const receipt = {
    version: po.version,
    client_key: randomUUID(),
    lines: [{ product_id: product.id, quantity: 2, location: 'FEED-01' }],
  };
  await ok('/purchase-orders/' + po.id + '/receive', 'POST', receipt);
  await ok('/purchase-orders/' + po.id + '/receive', 'POST', receipt);
  assert.equal((await ok('/inventory?product_id=' + product.id)).data[0].on_hand, 2);
  assert.equal((await ok('/purchase-orders/' + po.id)).state, 'partial');
  assert.equal((await ok('/products/' + product.id)).price, 25000);
});

test('delta preserves omitted supplier rows; full missing requires exact consent; NOP retains version', async () => {
  const s = await source(),
    first = await preview(s);
  await apply(first);
  const initial = await catalog(s),
    p = await preview(s, file('100.01', '7', false));
  await apply(p);
  let rows = await catalog(s);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].version, initial[0].version);
  assert.deepEqual(rows[1], initial[1]);
  const full = await preview(s, file('100.01', '7', false), 'full');
  assert.equal(full.summary.missing, 1);
  assert.equal(
    (await req('/supplier-file-previews/' + full.id + '/apply', 'POST', command(full))).statusCode,
    409,
  );
  await apply(full, command(full, true));
  rows = await catalog(s);
  assert.equal(rows[1].snapshot.quantity, 0);
  assert.equal(rows[1].snapshot.active, false);
  assert.equal(rows[1].version, initial[1].version + 1);
  assert.equal((await ok('/supplier-file-sources/' + s.id + '/history?limit=1')).meta.total, 3);
});

test('invalid row prevents entire publication; duplicate and missing numbers remain invalid durable rows', async () => {
  const s = await source();
  for (const content of [
    file('1.001'),
    head + 'A;S-A;Towar A;1.00;5\nA;S-A;Towar A;2.00;6',
    head + 'A;S-A;Towar A;;5',
  ]) {
    const p = await preview(s, content, 'full');
    assert(p.summary.invalid > 0);
    assert.equal(p.can_apply, false);
    assert.equal(
      (await req('/supplier-file-previews/' + p.id + '/apply', 'POST', command(p, true)))
        .statusCode,
      422,
    );
    assert.equal((await catalog(s)).length, 0);
  }
  assert.equal(
    (
      await pool.query('SELECT count(*)::int n FROM supplier_file_runs WHERE tenant_id=$1', [
        tenant,
      ])
    ).rows[0].n,
    0,
  );
});

test('source config or linked item changed after preview rolls back the full batch', async () => {
  const s = await source();
  await apply(await preview(s));
  const stale = await preview(s, file('90.00')),
    [item] = await catalog(s);
  const product = await ok('/products', 'POST', {
    sku: 'LINKED',
    name: 'Link test',
    price: 1200,
    vat: 23,
    quantity: 0,
    warehouse_id: warehouse,
  });
  await ok('/supplier-catalog/' + item.id + '/link', 'PATCH', {
    version: item.version,
    product_id: product.id,
  });
  const before = await catalog(s);
  assert.equal(
    (await req('/supplier-file-previews/' + stale.id + '/apply', 'POST', command(stale)))
      .statusCode,
    409,
  );
  assert.deepEqual(await catalog(s), before);
  const p = await preview(s);
  await ok('/supplier-file-sources/' + s.id, 'PATCH', {
    client_key: randomUUID(),
    version: s.version,
    name: 'Changed mapping',
    config: csvConfig,
  });
  assert.equal(
    (await req('/supplier-file-previews/' + p.id + '/apply', 'POST', command(p))).statusCode,
    409,
  );
  assert.deepEqual(await catalog(s), before);
});

test('mapped XML namespace/CDATA arbitrary IDs, frozen config and source-bound history; BigBuy operations refused', async () => {
  const config = {
    format: 'xml',
    record_path: '/s:feed/s:item',
    fields: {
      remote_id: { path: '@code', value_type: 'text' },
      name: { path: 's:name', value_type: 'text' },
      cost_minor: { path: 's:cost', value_type: 'decimal_money' },
      quantity: { path: 's:qty', value_type: 'integer' },
      description: { path: 's:description', value_type: 'text' },
    },
  };
  const s = await source(config),
    content =
      '<s:feed xmlns:s="urn:qa"><s:item code="ID/001"><s:name>Towar XML 雪</s:name><s:cost>20.05</s:cost><s:qty>3</s:qty><s:description><![CDATA[Opis <b>XML</b>]]></s:description></s:item></s:feed>';
  const p = await preview(s, content);
  await apply(p);
  const readback = await ok('/supplier-file-previews/' + p.id);
  assert.deepEqual(readback.preview.config_snapshot.fields, config.fields);
  const [item] = await catalog(s);
  assert.equal(item.snapshot.unit_cost, 2005);
  assert.equal(item.remote_product_id, 'ID/001');
  assert.equal(item.snapshot.description, 'Opis <b>XML</b>');
  assert.equal(
    (
      await req('/supplier-sources/' + s.id + '/reads', 'POST', {
        client_key: randomUUID(),
        remote_product_id: '1',
      })
    ).statusCode,
    422,
  );
  assert.equal(
    (await req('/supplier-sources/' + s.id + '/bulk-runs', 'POST', { client_key: randomUUID() }))
      .statusCode,
    422,
  );
  assert.equal(
    (
      await req('/supplier-sources/' + s.id + '/schedule', 'PUT', {
        version: 0,
        enabled: true,
        interval_minutes: 60,
        page_size: 10000,
      })
    ).statusCode,
    422,
  );
});

test('500 complete supplier rows published; 501 and oversized UTF8 refused without preview truncation', async () => {
  const s = await source(),
    content =
      head + Array.from({ length: 500 }, (_, i) => `R-${i};SKU-${i};Towar ${i};0.01;1`).join('\n');
  const p = await preview(s, content);
  assert.equal(p.rows.length, 500);
  assert.equal(p.summary.total, 500);
  const r = await apply(p);
  assert.equal(r.run.rows.length, 500);
  const before = (
    await pool.query('SELECT count(*)::int n FROM supplier_file_previews WHERE tenant_id=$1', [
      tenant,
    ])
  ).rows[0].n;
  for (const bad of [content + '\nR-501;SKU-501;Towar 501;0.01;1', '雪'.repeat(700000)]) {
    const res = await req('/supplier-file-sources/' + s.id + '/previews', 'POST', {
      client_key: randomUUID(),
      version: s.version,
      content: bad,
      scope: 'delta',
    });
    assert([413, 422].includes(res.statusCode), res.body);
  }
  assert.equal(
    (
      await pool.query('SELECT count(*)::int n FROM supplier_catalog_items WHERE tenant_id=$1', [
        tenant,
      ])
    ).rows[0].n,
    500,
  );
  assert.equal(
    (
      await pool.query('SELECT count(*)::int n FROM supplier_file_previews WHERE tenant_id=$1', [
        tenant,
      ])
    ).rows[0].n,
    before,
  );
});

test('RLS, API read/write scopes and readonly copies prevent writes; raw receipts are immutable', async () => {
  const s = await source(),
    p = await preview(s);
  await apply(p);
  await assert.rejects(
    tenantTx(tenant, (c) =>
      c.query('UPDATE supplier_file_previews SET raw_hash=$2 WHERE id=$1', [p.id, '0'.repeat(64)]),
    ),
  );
  const foreign = await req(
    '/auth/login',
    'POST',
    { email: 'other@demo.local', password: 'DynaDemo!2026' },
    '',
  );
  assert.equal(foreign.statusCode, 200);
  const other = String(foreign.headers['set-cookie']).split(';')[0];
  assert.equal(
    (await req('/supplier-file-sources/' + s.id, 'GET', undefined, other)).statusCode,
    404,
  );
  const key = await ok('/developer/keys', 'POST', {
    name: 'Feed read',
    scopes: ['purchasing:read'],
  });
  const read = await app.inject({
    url: '/api/v1/supplier-file-previews/' + p.id,
    headers: { authorization: 'Bearer ' + key.token },
  });
  assert.equal(read.statusCode, 200);
  const denied = await app.inject({
    url: '/api/v1/supplier-file-sources/' + s.id + '/previews',
    method: 'POST',
    payload: p.body,
    headers: { authorization: 'Bearer ' + key.token },
  });
  assert.equal(denied.statusCode, 403);
  const copy = await buildApp({ readOnly: true });
  try {
    const login = await req(
      '/auth/login',
      'POST',
      { email: fixtureEmail, password: 'FileSourceTests!2026' },
      '',
      copy,
    );
    assert.equal(login.statusCode, 200, login.body);
    const copyCookie = String(login.headers['set-cookie']).split(';')[0];
    const options = await req('/supplier-file-sources/options', 'GET', undefined, copyCookie, copy);
    assert.equal(options.statusCode, 200, options.body);
    const flags = options.json();
    assert.equal(flags.can_write, false);
    assert.equal(
      (await req('/supplier-file-sources', 'POST', {}, copyCookie, copy)).statusCode,
      423,
    );
  } finally {
    await copy.close();
  }
  const doc = (await ok('/developer/openapi')).paths;
  const operation = doc['/supplier-file-sources/{id}/previews'].post;
  assert(operation);
  assert.deepEqual(operation['x-required-scopes'], ['purchasing:read', 'purchasing:write']);
});

test('public API applies its own frozen preview; another API key cannot consume the same attempt', async () => {
  const s = await source();
  const key = await ok('/developer/keys', 'POST', {
    name: 'Feed read/write',
    scopes: ['purchasing:read', 'purchasing:write'],
  });
  const second = await ok('/developer/keys', 'POST', {
    name: 'Other feed key',
    scopes: ['purchasing:read', 'purchasing:write'],
  });
  const call = (url: string, payload: any, token = key.token) =>
    app.inject({
      url: '/api/v1' + url,
      method: 'POST',
      payload,
      headers: { authorization: 'Bearer ' + token },
      remoteAddress: '127.118.6.' + address,
    });
  const body = { client_key: randomUUID(), version: s.version, content: file(), scope: 'delta' };
  const response = await call('/supplier-file-sources/' + s.id + '/previews', body);
  assert.equal(response.statusCode, 201, response.body);
  const p = response.json().preview,
    b = command(p);
  const otherPreview = await app.inject({
    url: '/api/v1/supplier-file-previews/' + p.id,
    headers: { authorization: 'Bearer ' + second.token },
  });
  assert.equal(otherPreview.statusCode, 200, otherPreview.body);
  assert.equal(otherPreview.json().preview.can_apply, false);
  assert.equal(
    (await call('/supplier-file-previews/' + p.id + '/apply', b, second.token)).statusCode,
    409,
  );
  const accepted = await call('/supplier-file-previews/' + p.id + '/apply', b);
  assert.equal(accepted.statusCode, 200, accepted.body);
  const replay = await call('/supplier-file-previews/' + p.id + '/apply', b);
  assert.equal(replay.json().run.id, accepted.json().run.id);
});

test('administrator demotion while waiting for a source lock prevents the cached-role preview write', async () => {
  const s = await source(),
    c = await pool.connect();
  let pending: Promise<any> | undefined;
  try {
    await c.query('BEGIN');
    await c.query('SELECT id FROM supplier_sources WHERE id=$1 FOR UPDATE', [s.id]);
    pending = Promise.resolve(
      req('/supplier-file-sources/' + s.id + '/previews', 'POST', {
        client_key: randomUUID(),
        version: s.version,
        content: file(),
      }),
    );
    const deadline = Date.now() + 3000;
    let waiting = false;
    while (Date.now() < deadline) {
      waiting = Boolean(
        (
          await pool.query(
            "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FOR UPDATE OF s%' AND pid<>pg_backend_pid()",
          )
        ).rowCount,
      );
      if (waiting) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert(waiting, 'The real preview request did not reach the held source lock');
    await pool.query("UPDATE memberships SET role='operator' WHERE tenant_id=$1 AND user_id=$2", [
      tenant,
      user,
    ]);
    await c.query('COMMIT');
    const response = await pending;
    assert.equal(response.statusCode, 403, response.body);
    assert.equal(
      (
        await pool.query('SELECT count(*)::int n FROM supplier_file_previews WHERE tenant_id=$1', [
          tenant,
        ])
      ).rows[0].n,
      0,
    );
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
    if (pending) await pending;
  }
});

test('file source identity and catalog custody cannot be bypassed through legacy SQL grants', async () => {
  const s = await source();
  await apply(await preview(s));
  const [item] = await catalog(s);
  const bigbuy = await ok('/supplier-sources/demo', 'POST', { supplier_id: supplier.id });
  await assert.rejects(
    tenantTx(tenant, (c) =>
      c.query("UPDATE supplier_sources SET kind='bigbuy',channel_id=$2 WHERE id=$1", [
        s.id,
        bigbuy.channel_id,
      ]),
    ),
    /Tożsamość plikowego źródła dostawcy jest niezmienna/,
  );
  await assert.rejects(
    tenantTx(tenant, (c) =>
      c.query('UPDATE supplier_catalog_items SET source_id=$2 WHERE id=$1', [item.id, bigbuy.id]),
    ),
    /Nie można zmienić źródła/,
  );
  await assert.rejects(
    tenantTx(tenant, (c) =>
      c.query(
        `UPDATE supplier_catalog_items SET snapshot=jsonb_set(snapshot,'{quantity}','999') WHERE id=$1`,
        [item.id],
      ),
    ),
    /Brak zatwierdzonego/,
  );
  await assert.rejects(
    tenantTx(tenant, (c) =>
      c.query('SELECT raw_content FROM supplier_file_previews WHERE source_id=$1', [s.id]),
    ),
    /permission denied/,
  );
  const flags = (
    await pool.query(
      `SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname=ANY($1::text[])`,
      [
        [
          'supplier_file_source_configs',
          'supplier_file_source_revisions',
          'supplier_file_previews',
          'supplier_file_preview_rows',
          'supplier_file_runs',
          'supplier_file_run_rows',
        ],
      ],
    )
  ).rows;
  assert.equal(flags.length, 6);
  assert(flags.every((r) => r.relrowsecurity && r.relforcerowsecurity));
  assert.deepEqual((await catalog(s))[0], item);
});

test('API key revoked during an actual source-lock wait cannot persist its already authorized preview', async () => {
  const s = await source();
  const key = await ok('/developer/keys', 'POST', {
    name: 'Revoked during wait',
    scopes: ['purchasing:read', 'purchasing:write'],
  });
  const c = await pool.connect();
  let pending: Promise<any> | undefined;
  try {
    await c.query('BEGIN');
    await c.query('SELECT id FROM supplier_sources WHERE id=$1 FOR UPDATE', [s.id]);
    pending = Promise.resolve(
      app.inject({
        url: '/api/v1/supplier-file-sources/' + s.id + '/previews',
        method: 'POST',
        payload: { client_key: randomUUID(), version: s.version, content: file() },
        headers: { authorization: 'Bearer ' + key.token },
        remoteAddress: '127.118.7.' + address,
      }),
    );
    const deadline = Date.now() + 3000;
    let waiting = false;
    while (Date.now() < deadline) {
      waiting = Boolean(
        (
          await pool.query(
            "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FOR UPDATE OF s%' AND pid<>pg_backend_pid()",
          )
        ).rowCount,
      );
      if (waiting) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert(waiting, 'Actual API request must reach the held source lock');
    await pool.query('UPDATE api_keys SET revoked_at=now() WHERE tenant_id=$1 AND id=$2', [
      tenant,
      key.id,
    ]);
    await c.query('COMMIT');
    const response = await pending;
    assert.equal(response.statusCode, 401, response.body);
    assert.equal(
      (
        await pool.query('SELECT count(*)::int n FROM supplier_file_previews WHERE tenant_id=$1', [
          tenant,
        ])
      ).rows[0].n,
      0,
    );
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
    if (pending) await pending;
  }
});
