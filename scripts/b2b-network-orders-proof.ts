import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
const path = 'data/b2b-network-orders-stage050.json',
  phase = process.argv[2];
const state = JSON.parse(await readFile(path, 'utf8'));
let cookie = '';
async function api(path: string, method = 'GET', body?: any, status = 200) {
  const r = await fetch('http://127.0.0.1:4100/api' + path, {
    method,
    headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
  const d: any = await r.json();
  assert.equal(r.status, status, path + ':' + JSON.stringify(d));
  return d;
}
const save = () => writeFile(path, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
const login = (side: string) =>
  api('/auth/login', 'POST', { email: state[side].email, password: 'DynaDemo!2026' });
try {
  if (phase === 'setup') {
    assert(!state.supplier, 'QA fixture exists');
    for (const [side, label] of [
      ['supplier', 'Dostawca'],
      ['buyer', 'Odbiorca'],
    ]) {
      const email = 'qa-network-orders-' + side + '@demo.local';
      await api(
        '/auth/signup',
        'POST',
        {
          email,
          password: 'DynaDemo!2026',
          name: 'QA ' + label,
          organization: { name: 'QA Zakupy B2B ' + label + ' 20261004' },
        },
        201,
      );
      state[side] = { email, tenant: (await api('/auth/me')).user.tenant_id };
      await save();
      await api('/workspaces/plan', 'PATCH', { plan: 'enterprise' });
      state[side].warehouse = (await api('/warehouses')).data[0].id;
    }
    await login('supplier');
    state.product = (
      await api(
        '/products',
        'POST',
        {
          sku: 'NET-QA-050-A',
          name: 'Pudełko kraft — zakup hurtowy',
          description: 'Lokalny test zakupów między organizacjami.',
          price: 20000,
          quantity: 20,
          warehouse_id: state.supplier.warehouse,
        },
        201,
      )
    ).id;
    let list = await api(
      '/price-lists',
      'POST',
      { name: 'Cennik zakupów B2B QA', currency: 'PLN' },
      201,
    );
    await api('/price-lists/' + list.id + '/items', 'PUT', {
      version: list.version,
      items: [{ product_id: state.product, price: 12345 }],
    });
    const body = {
      name: 'QA Odbiorca zakupów B2B',
      email: state.buyer.email,
      warehouse_id: state.supplier.warehouse,
      price_list_id: list.id,
      address: { street: 'Testowa 50', city: 'Warszawa', postal_code: '00-050', country: 'PL' },
      shipping_cost: 500,
      payment_mode: 'prepaid',
    };
    let account = await api('/b2b/accounts', 'POST', body, 201);
    account = await api('/b2b/accounts/' + account.id, 'PATCH', {
      ...body,
      version: account.version,
      active: true,
      confirmed: true,
    });
    state.account = account.id;
    const invite = await api('/b2b/accounts/' + account.id + '/network-invite', 'POST', {
      version: account.version,
      recipient_email: state.buyer.email,
      confirmed: true,
    });
    await login('buyer');
    state.link = (
      await api('/b2b/network/accept', 'POST', { token: invite.token, confirmed: true })
    ).id;
    await save();
    const base = '/b2b/network/links/' + state.link;
    state.run = (
      await api(base + '/refresh', 'POST', { client_key: randomUUID(), confirmed: true })
    ).id;
    await save();
  } else if (phase === 'import') {
    await login('buyer');
    const base = '/b2b/network/links/' + state.link,
      cat = await api(base + '/catalog');
    assert.equal(cat.data.length, 1);
    state.item = cat.data[0].id;
    state.local = (
      await api(base + '/catalog/' + state.item + '/product', 'POST', {
        version: cat.data[0].version,
        sku: 'OWN-QA-050-A',
        sale_price: 25000,
        warehouse_id: state.buyer.warehouse,
        confirmed: true,
      })
    ).product_id;
    await save();
    console.log({ catalog_imported: true });
  } else if (phase === 'fulfill') {
    const rows = (
      await pool.query('SELECT * FROM b2b_network_orders WHERE link_id=$1', [state.link])
    ).rows;
    assert.equal(rows.length, 1);
    state.order = rows[0].id;
    state.source_order = rows[0].source_order_id;
    state.local = (
      await pool.query('SELECT product_id FROM b2b_network_order_lines WHERE order_id=$1', [
        state.order,
      ])
    ).rows[0].product_id;
    await save();
    assert.equal(
      (await pool.query('SELECT reserved FROM stock WHERE product_id=$1', [state.product])).rows[0]
        .reserved,
      3,
    );
    assert.equal(
      (await pool.query('SELECT on_hand FROM stock WHERE product_id=$1', [state.local])).rows[0]
        .on_hand,
      0,
    );
    await login('supplier');
    await api('/orders/' + state.source_order + '/status', 'PATCH', { status: 'paid' });
    await api('/orders/' + state.source_order + '/status', 'PATCH', { status: 'picking' });
    for (let n = 0; n < 3; n++)
      await api('/orders/' + state.source_order + '/scan', 'POST', { code: 'NET-QA-050-A' });
    await api('/orders/' + state.source_order + '/status', 'PATCH', { status: 'packed' });
    await api('/orders/' + state.source_order + '/ship-demo', 'POST', {});
    state.invoice = (
      await api('/orders/' + state.source_order + '/documents', 'POST', { kind: 'invoice' })
    ).id;
    await save();
    console.log({ supplier_dispatched: true, demonstration_only: true });
  } else if (phase === 'verify') {
    await login('buyer');
    const o = await api('/b2b/network/orders/' + state.order);
    assert.equal(o.state, 'received');
    assert.equal(o.lines[0].received, 3);
    assert.equal(o.receipts.length, 2);
    assert.equal(o.total_gross, 37535);
    assert.equal(o.shipping_gross, 500);
    assert.equal(o.fulfillment.status, 'shipped');
    assert(o.fulfillment.shipments[0].dispatched_at);
    assert.equal(
      (await pool.query('SELECT on_hand FROM stock WHERE product_id=$1', [state.local])).rows[0]
        .on_hand,
      3,
    );
    assert.equal(
      (await pool.query('SELECT price FROM products WHERE id=$1', [state.local])).rows[0].price,
      25000,
    );
    const stock = (
      await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [state.product])
    ).rows[0];
    assert.deepEqual(stock, { on_hand: 17, reserved: 0 });
    for (const [table, before] of Object.entries(state.before) as [string, any][]) {
      assert(/^[a-z_0-9]+$/.test(table));
      const rows = (
        await pool.query(
          'SELECT to_jsonb(t)::text row FROM (SELECT ' +
            before.columns.join(',') +
            ' FROM ' +
            table +
            ' WHERE tenant_id=ANY($1::uuid[])) t ORDER BY 1',
          [state.tenants],
        )
      ).rows;
      assert.equal(rows.length, before.count, table);
      assert.equal(
        createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
        before.sha256,
        table,
      );
    }
    const proof = {
      checked_at: new Date().toISOString(),
      scope: 'native_local_cross_organization_purchase_fulfillment_partial_PZ',
      source_order_id: state.source_order,
      buyer_order_id: state.order,
      supplier_stock: stock,
      buyer_stock: 3,
      buyer_sale_price: 25000,
      total_gross: 37535,
      shipping_gross: 500,
      currency: 'PLN',
      receipts: o.receipts.map((r: any) => r.number),
      preserved_previous_firms: state.tenants.length,
      preserved_stable_tables: Object.keys(state.before).length,
      provider_requests: 0,
      real_financial_operations: 0,
      whole_goal_complete: false,
    };
    await writeFile('docs/b2b-network-orders-qa.json', JSON.stringify(proof, null, 2) + '\n');
    console.log(proof);
  } else throw Error('Unknown phase');
} finally {
  await pool.end();
}
