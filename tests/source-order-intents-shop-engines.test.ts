import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool } from '../server/db';
import { PrestaShop, WooCommerce, type Transport } from '../server/integrations';
import { demoPrestaOrder } from '../server/prestashop-example';
import { demoWooOrder } from '../server/import-routes';
import {
  makeProviderHarness,
  freshSourceIntentFixture,
} from './source-order-intents-provider-fixture';

type Row = Record<string, any>;
type Provider = 'woocommerce' | 'prestashop';
type Fixture = Awaited<ReturnType<typeof freshSourceIntentFixture>>;
assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert.match(database.pathname, /^\/dynaminds_test_\d+$/);
assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
const settings = {
  woocommerce: { store_url: 'https://example.com' },
  prestashop: {
    store_url: 'https://example.com',
    shop_id: '1',
    order_state_ids: '2,3',
  },
};
const credentials = {
  woocommerce: { consumer_key: 'qa127c-synthetic-key', consumer_secret: 'qa127c-synthetic-secret' },
  prestashop: { api_key: 'P'.repeat(32) },
};
const calls: Array<{ url: URL; method: string }> = [];
let currentProvider: Provider, remote: Row;
let h: Awaited<ReturnType<typeof makeProviderHarness>>;
const json = (v: unknown) =>
  new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
const transport: Transport = async (url, init) => {
  const u = new URL(url),
    method = init.method ?? 'GET';
  calls.push({ url: u, method });
  assert.equal(method, 'GET', 'Source import must not mutate either shop provider');
  if (currentProvider === 'woocommerce') {
    assert.equal(u.hostname, 'example.com');
    assert.equal(u.pathname, '/wp-json/wc/v3/orders/' + remote.id);
    return json(remote);
  }
  assert.equal(u.hostname, 'example.com');
  assert.equal(u.searchParams.get('id_shop'), '1');
  const resource = u.pathname.split('/').at(-1)!;
  if (resource === 'orders') {
    assert.equal(u.searchParams.get('filter[id]'), '[' + remote.id + ']');
    const order = structuredClone(remote);
    delete order._dyna;
    return json({ orders: [order] });
  }
  const keys: Record<string, string> = {
    customers: 'customer',
    addresses: 'address',
    currencies: 'currency',
    countries: 'country',
    order_states: 'state',
    order_details: 'details',
    order_cart_rules: 'cart_rules',
  };
  assert(keys[resource], 'Unexpected PrestaShop resource: ' + resource);
  const value = remote._dyna[keys[resource]];
  let values: Row[] = Array.isArray(value) ? value : [value];
  const ids = u.searchParams.get('filter[id]');
  if (ids) values = values.filter((r) => ids.slice(1, -1).split('|').includes(String(r.id)));
  const orderIds = u.searchParams.get('filter[id_order]');
  if (orderIds)
    values = values.filter((r) => orderIds.slice(1, -1).split('|').includes(String(r.id_order)));
  return json({ [resource]: values });
};
before(async () => {
  h = await makeProviderHarness({ transport });
});
after(async () => {
  await h?.close();
});

function wooRaw(paid: boolean): Row {
  const raw: Row = structuredClone(demoWooOrder);
  raw.id = 127701;
  raw.status = paid ? 'processing' : 'on-hold';
  raw.date_paid = paid ? '2026-10-06T12:00:00' : null;
  raw.payment_method = 'bacs';
  raw.total = '42.00';
  raw.shipping_total = '5.00';
  raw.shipping_tax = '0.00';
  raw.customer_note = 'QA127C source historic same-SKU prices; no real shop';
  raw.line_items = [
    {
      id: 1277011,
      product_id: 701,
      variation_id: 0,
      name: 'Historical Woo line 10',
      sku: 'QA127C-SAME',
      quantity: 2,
      total: '20.00',
      total_tax: '0.00',
    },
    {
      id: 1277012,
      product_id: 701,
      variation_id: 0,
      name: 'Historical Woo line 17',
      sku: 'QA127C-SAME',
      quantity: 1,
      total: '17.00',
      total_tax: '0.00',
    },
  ];
  return raw;
}
function prestaRaw(payment: 'unpaid' | 'paid' | 'partial'): Row {
  const raw: Row = structuredClone(demoPrestaOrder),
    base = structuredClone(raw._dyna.details[0]);
  raw.id = '127702';
  raw.reference = 'QA127C-PRESTA-42';
  raw.current_state = '2';
  raw.total_paid_tax_incl = '42.000000';
  raw.total_products_wt = '37.000000';
  raw.total_shipping_tax_incl = '5.000000';
  raw.total_discounts_tax_incl = '0.000000';
  raw.total_paid_real =
    payment === 'paid' ? '42.000000' : payment === 'partial' ? '10.000000' : '0.000000';
  raw._dyna.state.paid = payment === 'paid' ? '1' : '0';
  raw._dyna.cart_rules = [];
  raw.associations.order_rows = [
    { id: '1277021', product_id: '701', product_attribute_id: '0', product_quantity: '2' },
    { id: '1277022', product_id: '701', product_attribute_id: '0', product_quantity: '1' },
  ];
  raw._dyna.details = [
    {
      ...structuredClone(base),
      id: '1277021',
      id_order: raw.id,
      product_quantity: '2',
      product_reference: 'QA127C-SAME',
      product_name: 'Historical Presta line 10',
      total_price_tax_incl: '20.000000',
    },
    {
      ...structuredClone(base),
      id: '1277022',
      id_order: raw.id,
      product_quantity: '1',
      product_reference: 'QA127C-SAME',
      product_name: 'Historical Presta line 17',
      total_price_tax_incl: '17.000000',
    },
  ];
  return raw;
}
async function setup(provider: Provider, payment: 'unpaid' | 'paid' | 'partial' = 'unpaid') {
  currentProvider = provider;
  remote = provider === 'woocommerce' ? wooRaw(payment === 'paid') : prestaRaw(payment);
  // Stage the exact hydrated reader output, rather than a fabricated _dyna overlay.
  const raw =
    provider === 'woocommerce'
      ? await new WooCommerce(settings.woocommerce, credentials.woocommerce, transport).order(
          Number(remote.id),
        )
      : await new PrestaShop(settings.prestashop, credentials.prestashop, transport).order(
          String(remote.id),
        );
  const f = await freshSourceIntentFixture(h, {
    provider,
    raw,
    settings: settings[provider],
    credentials: credentials[provider],
    external_product_id: provider === 'woocommerce' ? '701' : '701:0',
    remote_line_ids: provider === 'woocommerce' ? ['1277011', '1277012'] : ['1277021', '1277022'],
  });
  calls.length = 0;
  return f;
}
async function assertImported(f: Fixture, provider: Provider, received: number) {
  const paid = received === 4200;
  const physical = await f.snapshot({ physicalOnly: true });
  assert.equal(Object.keys(physical).length, 19);
  const p = await f.preview(),
    body = f.executeBody(p);
  assert.equal(p.source.total, 4200);
  assert.equal(p.source.shipping_cost, 500);
  assert.equal(p.source.payment.paid_amount, received);
  assert.equal(p.source.payment.paid, paid);
  assert.equal(p.rows.length, 2);
  assert.equal(new Set(p.rows.map((r: Row) => r.customer_item_id)).size, 2);
  const response = await f.execute(p, body);
  assert.equal(response.statusCode, 201, response.body);
  const result = response.json();
  assert.equal(result.order.source, provider);
  assert.equal(result.order.total, 4200);
  assert.equal(result.order.currency, 'PLN');
  assert.equal(result.order.shipping_cost, 500);
  assert.equal(result.order.status, paid ? 'paid' : 'new');
  assert.equal(result.order.items.length, 2);
  assert.equal(result.order.picking_items.length, 0);
  assert.equal(result.order.payment.received, received);
  assert.equal(result.order.payment.amount_due, 4200 - received);
  const bindings = (
    await pool.query(
      'SELECT * FROM order_source_lines WHERE tenant_id=$1 AND source_order_id=$2 ORDER BY remote_line_id',
      [f.buyer.tenant, result.order.id],
    )
  ).rows;
  assert.equal(bindings.length, 2);
  assert.deepEqual(
    bindings.map((b) => b.remote_line_id),
    provider === 'woocommerce' ? ['1277011', '1277012'] : ['1277021', '1277022'],
  );
  for (const [index, quantity, price, lineTotal] of [
    [0, 2, 1000, 2000],
    [1, 1, 1700, 1700],
  ]) {
    const b = bindings[index],
      item = result.order.items.find((i: Row) => i.id === b.source_item_id);
    assert(item);
    assert.equal(item.product_id, f.product.id);
    assert.equal(item.quantity, quantity);
    assert.equal(item.price, price);
    assert.equal(item.line_total, lineTotal);
    assert.equal(item.vat, 23);
    assert.equal(b.product_id, f.product.id);
    assert.equal(b.channel_id, f.channel.id);
    assert.equal(b.inbound_id, f.inbound.id);
    assert.equal(b.source_hash, f.inbound.source_hash);
    assert.equal(b.quantity, quantity);
    assert.equal(b.line_total, lineTotal);
    const intentLine = result.intent.items.find((i: Row) => i.customer_item_id === item.id);
    assert(intentLine);
    assert.equal(intentLine.local_quantity, 0);
    assert.equal(intentLine.external_quantity, quantity);
    assert.equal(intentLine.unassigned_quantity, 0);
    assert.equal(intentLine.link_id, f.link.id);
  }
  const payments = (
    await pool.query(
      'SELECT kind,amount,currency,method FROM payment_entries WHERE tenant_id=$1 AND order_id=$2 ORDER BY id',
      [f.buyer.tenant, result.order.id],
    )
  ).rows;
  assert.deepEqual(
    payments,
    received ? [{ kind: 'receipt', amount: received, currency: 'PLN', method: 'source_import' }] : [],
  );
  const [e] = (
    await pool.query(
      'SELECT * FROM b2b_external_import_executions WHERE tenant_id=$1 AND inbound_id=$2',
      [f.buyer.tenant, f.inbound.id],
    )
  ).rows;
  assert(e);
  assert.equal(e.preview_id, p.id);
  assert.equal(e.order_id, result.order.id);
  assert.equal(e.intent_id, result.intent.id);
  const [cert] = (
    await pool.query(
      'SELECT * FROM b2b_external_import_certificates WHERE tenant_id=$1 AND id=$2',
      [f.buyer.tenant, e.certificate_id],
    )
  ).rows;
  assert.equal(cert.state, 'complete');
  assert.equal(cert.actual_order_id, result.order.id);
  assert.equal(cert.intent_id, result.intent.id);
  const [inbound] = (
    await pool.query(
      'SELECT state,order_id,source_hash,imported_hash FROM inbound_orders WHERE tenant_id=$1 AND id=$2',
      [f.buyer.tenant, f.inbound.id],
    )
  ).rows;
  assert.equal(inbound.state, 'imported');
  assert.equal(inbound.order_id, result.order.id);
  assert.equal(inbound.imported_hash, inbound.source_hash);
  assert.deepEqual(
    await f.snapshot({ physicalOnly: true }),
    physical,
    'All19 physical tables: external-only source import has no physical effects',
  );
  if (provider === 'woocommerce')
    assert(
      calls.some((c) => c.url.pathname === '/wp-json/wc/v3/orders/' + remote.id),
      'Actual Woo current order reread required',
    );
  else
    for (const resource of [
      'orders',
      'customers',
      'addresses',
      'countries',
      'currencies',
      'order_states',
      'order_details',
      'order_cart_rules',
    ])
      assert(
        calls.some((c) => c.url.pathname.endsWith('/' + resource)),
        'Actual Presta hydrated reread: ' + resource,
      );
  const beforeRetry = await f.snapshot(),
    callCount = calls.length;
  const replay = await f.execute(p, body);
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().reused, true);
  assert.equal(replay.json().order.id, result.order.id);
  assert.equal(replay.json().intent.id, result.intent.id);
  assert.deepEqual(await f.snapshot(), beforeRetry, 'Exact replay has no business effects');
  assert.equal(
    calls.length,
    callCount,
    'Completed exact replay does not require a new provider observation',
  );
}

for (const provider of ['woocommerce', 'prestashop'] as const) {
  for (const paid of [false, true])
    test(`${provider} actual source-intent import preserves 10/17 same-SKU lines, ${paid ? 'full source payment' : 'unpaid declaration'}, zero own stock and exact replay`, async () => {
      await assertImported(
        await setup(provider, paid ? 'paid' : 'unpaid'),
        provider,
        paid ? 4200 : 0,
      );
    });
  test(`${provider} actual fresh provider price drift rejects frozen source intent atomically and restages only the observed source`, async () => {
    const f = await setup(provider),
      p = await f.preview(),
      body = f.executeBody(p);
    const before = await f.snapshot(),
      physical = await f.snapshot({ physicalOnly: true });
    if (provider === 'woocommerce') {
      remote.total = '43.00';
      remote.line_items[0].total = '21.00';
    } else {
      remote.total_paid_tax_incl = '43.000000';
      remote.total_products_wt = '38.000000';
      remote._dyna.details[0].total_price_tax_incl = '21.000000';
    }
    const response = await f.execute(p, body);
    assert.equal(response.statusCode, 409, response.body);
    assert(
      calls.length > 0,
      'Drift must be observed by actual transport, not direct staged mutation',
    );
    const after = await f.snapshot();
    for (const table of [
      'orders',
      'order_items',
      'payment_entries',
      'order_source_lines',
      'b2b_external_order_intents',
      'b2b_external_order_intent_revisions',
      'b2b_external_order_allocation_proofs',
      'b2b_external_import_previews',
      'b2b_external_import_executions',
      'b2b_external_import_certificates',
    ])
      assert.deepEqual(
        after[table],
        before[table],
        'Provider drift must not create/modify customer proof: ' + table,
      );
    assert.deepEqual(await f.snapshot({ physicalOnly: true }), physical);
    const [inbound] = (
      await pool.query(
        'SELECT state,order_id,source_hash,imported_hash,raw FROM inbound_orders WHERE tenant_id=$1 AND id=$2',
        [f.buyer.tenant, f.inbound.id],
      )
    ).rows;
    assert.equal(inbound.order_id, null);
    assert.equal(inbound.imported_hash, null);
    assert.equal(inbound.state, 'staged');
    assert.notEqual(inbound.source_hash, f.inbound.source_hash);
    assert.equal(
      provider === 'woocommerce' ? inbound.raw.total : inbound.raw.total_paid_tax_incl,
      provider === 'woocommerce' ? '43.00' : '43.000000',
    );
    const replay = await f.request(
      '/imports/' + f.inbound.id + '/external-intent-previews',
      'POST',
      f.previewBody,
    );
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().reused, true);
    assert.equal(replay.json().preview.id, p.id);
    assert.equal(replay.json().preview.scope_hash, p.scope_hash);
    assert.deepEqual(replay.json().preview.source, p.source);
    const newPreview = await f.request(
      '/imports/' + f.inbound.id + '/external-intent-previews',
      'POST',
      { ...f.previewBody, client_key: randomUUID() },
    );
    assert.equal(
      newPreview.statusCode,
      409,
      'Original expected_source_hash cannot silently approve the changed source',
    );
  });
}
test('PrestaShop actual partial source receipt imports 1000 without topping up 3200 due, preserves zero own stock and exact replay', async () => {
  await assertImported(await setup('prestashop', 'partial'), 'prestashop', 1000);
});
