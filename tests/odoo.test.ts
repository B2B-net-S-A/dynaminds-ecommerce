import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Odoo, odooConfig, odooId, odooMoney } from '../server/odoo';
import { odooSettings, odooCredentials, odooFixture } from './odoo-fixtures';
import { normalizeOdooCatalog, demoOdooCatalog, demoOdooContext } from '../server/odoo-catalog';

test('Odoo fixed JSON-2 reads bind Bearer, database, company, warehouse and keyset', async () => {
  const f = odooFixture(51),
    c = new Odoo(odooSettings, odooCredentials, f.transport);
  let fences = 0;
  const first = await c.catalogPage(0, async () => {
    fences++;
  });
  assert.equal(first.data.length, 50);
  assert.equal(first.has_more, true);
  assert.equal(first.next_cursor, 150);
  const second = await c.catalogPage(first.next_cursor);
  assert.equal(second.data.length, 1);
  assert.equal(second.has_more, false);
  assert.equal(second.data[0].id, 151);
  assert.equal(fences, 9);
  assert(f.calls.every((c) => ['read', 'search_read'].includes(c.method)));
  assert.deepEqual(f.calls.find((c) => c.method === 'search_read').args.domain, [
    ['id', '>', 0],
    ['active', '=', true],
    ['sale_ok', '=', true],
    '|',
    ['company_id', '=', false],
    ['company_id', '=', 1],
  ]);
  assert.equal(first.data[0].attributes[0].name, 'Kolor');
});
test('Odoo rejects public URL misuse, missing scope, ambiguous price basis and malformed key', () => {
  for (const url of [
    'http://erp.odoo.com',
    'https://127.0.0.1',
    'https://localhost',
    'https://erp.odoo.com/path',
    'https://x:pass@erp.odoo.com',
    'https://erp.odoo.com?key=secret',
  ])
    assert.throws(() => odooConfig({ ...odooSettings, server_url: url }, odooCredentials));
  for (const [k, v] of Object.entries({
    company_id: '0',
    warehouse_id: '1.5',
    unit_id: '2147483648',
    database: 'db\nkey',
    price_mode: '',
  }))
    assert.throws(() => odooConfig({ ...odooSettings, [k]: v }, odooCredentials));
  assert.throws(() => odooConfig(odooSettings, { api_key: 'secret\r\nheader' }));
  assert.throws(() => odooId(Number.MAX_SAFE_INTEGER));
});
test('Odoo never forwards provider exception details; rejects oversized and invalid JSON', async () => {
  for (const response of [
    () => new Response(JSON.stringify({ error: { message: 'secret_private_token' } })),
    () => new Response('secret_private_token', { status: 403 }),
    () => new Response('invalid secret_private_token'),
    () => new Response(' '.repeat(4 * 1024 * 1024 + 1)),
  ]) {
    const c = new Odoo(odooSettings, odooCredentials, async () => response());
    await assert.rejects(
      () => c.test(),
      (e) => e instanceof Error && !e.message.includes('secret_private_token'),
    );
  }
});
test('Odoo POST read retries are bounded and recheck authorization before each request', async () => {
  const f = odooFixture(0);
  let calls = 0,
    fences = 0;
  const c = new Odoo(odooSettings, odooCredentials, async (u, i) => {
    calls++;
    if (calls === 1)
      return new Response('private', { status: 429, headers: { 'Retry-After': '0' } });
    return f.transport(u, i);
  });
  await c.catalogPage(0, async () => {
    fences++;
  });
  assert.equal(calls, 6);
  assert.equal(fences, 6);
  let denied = 0;
  const stopped = new Odoo(odooSettings, odooCredentials, async () => {
    denied++;
    return new Response('private', { status: 503, headers: { 'Retry-After': '0' } });
  });
  await assert.rejects(
    () =>
      stopped.catalogPage(0, async () => {
        if (denied) throw Error('revoked');
      }),
    /revoked/,
  );
  assert.equal(denied, 1);
  let repeated = 0;
  await assert.rejects(
    () =>
      new Odoo(odooSettings, odooCredentials, async () => {
        repeated++;
        return new Response('', { status: 504, headers: { 'Retry-After': '0' } });
      }).test(),
    /HTTP 504/,
  );
  assert.equal(repeated, 3);
});
test('Odoo rejects foreign company, warehouse, currency, incomplete reads and repeated IDs', async () => {
  for (const defect of ['company', 'warehouse', 'currency', 'missing', 'repeat', 'attr'] as const) {
    const f = odooFixture();
    if (defect === 'company') f.rows[0].company_id = [2, 'Other'];
    if (defect === 'warehouse') f.state.foreignWarehouse = true;
    if (defect === 'currency') f.rows[0].currency_id = [2, 'EUR'];
    if (defect === 'missing')
      f.state.edit = (m, _, d) => {
        if (m === 'product.template') d.length = 0;
      };
    if (defect === 'repeat') f.rows[1].id = f.rows[0].id;
    if (defect === 'attr')
      f.state.edit = (m, _, d) => {
        if (m === 'product.template.attribute.value') d[0].product_tmpl_id = [99, 'Other'];
      };
    await assert.rejects(() => new Odoo(odooSettings, odooCredentials, f.transport).catalogPage(0));
  }
});
test('Odoo rejects writes observed while enriching product and template data', async () => {
  for (const model of ['product.product', 'product.template']) {
    const f = odooFixture();
    f.state.edit = (m, method, d, args) => {
      if (m === model && method === 'read' && args.fields.length === 2)
        d[0].write_date = '2026-10-04 15:00:00';
    };
    await assert.rejects(
      () => new Odoo(odooSettings, odooCredentials, f.transport).catalogPage(0),
      /zmienił/,
    );
  }
});
test('Odoo money preserves cents, rejects meaningful sub-cent precision and ambiguous units', () => {
  assert.equal(odooMoney(0.1 + 0.2), 30);
  assert.throws(() => odooMoney(12.345));
  assert.throws(() => odooMoney(-1));
  assert.throws(() => odooMoney(1000001));
  const raw = demoOdooCatalog()[0],
    run = { channel_id: 'abcdabcd', context: demoOdooContext, vat: 23 };
  const row = normalizeOdooCatalog(raw, run);
  assert.equal(row.source.price, 4305);
  assert.equal(row.source.quantity, 12);
  assert.equal(row.kind, 'variant');
  assert.equal(row.parent_external_id, 'template:10');
  assert.equal(normalizeOdooCatalog({ ...raw, lst_price: 12.345 }, run).source.price, null);
  assert.equal(normalizeOdooCatalog({ ...raw, uom_id: [2, 'kg'] }, run).source.unsupported, true);
  assert.equal(normalizeOdooCatalog({ ...raw, free_qty: 1.5 }, run).source.quantity, null);
  assert.equal(normalizeOdooCatalog({ ...raw, type: 'service' }, run).source.unsupported, true);
  assert.equal(
    normalizeOdooCatalog(raw, { ...run, context: { ...demoOdooContext, prices_include_tax: true } })
      .source.price,
    3500,
  );
  assert.equal(normalizeOdooCatalog(raw, run, true).source.price, 0);
});
