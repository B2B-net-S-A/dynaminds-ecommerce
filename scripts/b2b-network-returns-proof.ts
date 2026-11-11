import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
const path = 'data/b2b-network-returns-stage051.json',
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
      const email = 'qa-network-returns-' + side + '@demo.local';
      await api(
        '/auth/signup',
        'POST',
        {
          email,
          password: 'DynaDemo!2026',
          name: 'QA ' + label,
          organization: { name: 'QA Zwroty B2B ' + label + ' 20261004' },
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
          sku: 'NET-QA-051-A',
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
      address: { street: 'Testowa 50', city: 'Warszawa', postal_code: '00-051', country: 'PL' },
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
        sku: 'OWN-QA-051-A',
        sale_price: 25000,
        warehouse_id: state.buyer.warehouse,
        confirmed: true,
      })
    ).product_id;
    await save();
    console.log({ catalog_imported: true });
  } else if (phase === 'purchase') {
    assert(!state.order && !state.cancel_order, 'Purchases already exist');
    await login('buyer');
    const base = '/b2b/network/links/' + state.link;
    for (const [key, quantity] of [
      ['order', 3],
      ['cancel_order', 2],
    ] as const) {
      const q = await api(base + '/quotes', 'POST', {
        client_key: randomUUID(),
        warehouse_id: state.buyer.warehouse,
        items: [{ item_id: state.item, quantity }],
      });
      const o = await api(base + '/quotes/' + q.id + '/checkout', 'POST', { confirmed: true });
      state[key] = o.id;
      state[key + '_source'] = o.source_order_id;
      await save();
    }
    await login('supplier');
    const o = await api('/orders/' + state.cancel_order_source);
    await api('/orders/' + o.id + '/payments', 'POST', {
      version: o.version,
      client_key: randomUUID(),
      kind: 'receipt',
      amount: o.total,
      currency: o.currency,
      reference: 'Lokalna wpłata QA anulowania',
      confirmed: true,
    });
    console.log({ purchases: 2, source_reserved: 5, real_financial_operations: 0 });
  } else if (phase === 'fulfill') {
    await login('supplier');
    const id = state.order_source;
    await api('/orders/' + id + '/status', 'PATCH', { status: 'paid' });
    await api('/orders/' + id + '/status', 'PATCH', { status: 'picking' });
    for (let n = 0; n < 3; n++)
      await api('/orders/' + id + '/scan', 'POST', { code: 'NET-QA-051-A' });
    await api('/orders/' + id + '/status', 'PATCH', { status: 'packed' });
    await api('/orders/' + id + '/ship-demo', 'POST', {});
    state.invoice = (await api('/orders/' + id + '/documents', 'POST', { kind: 'invoice' })).id;
    await save();
    await login('buyer');
    const o = await api('/b2b/network/orders/' + state.order);
    await api('/b2b/network/orders/' + o.id + '/receipts', 'POST', {
      version: o.version,
      client_key: randomUUID(),
      confirmed: true,
      lines: [{ product_id: state.local, quantity: 3, location: 'B2B-051' }],
    });
    console.log({ supplier_stock: 17, buyer_stock: 3, demonstration_only: true });
  } else if (phase === 'supplier') {
    const row = (
      await pool.query('SELECT * FROM b2b_network_returns WHERE order_id=$1', [state.order])
    ).rows;
    assert.equal(row.length, 1);
    assert.equal(row[0].state, 'dispatched');
    state.return_id = row[0].id;
    state.source_return = row[0].source_return_id;
    state.wz = row[0].dispatch_document_id;
    await save();
    await login('supplier');
    let r = await api('/returns/' + state.source_return);
    assert.equal(r.state, 'requested');
    await api('/returns/' + r.id + '/receive', 'POST', {
      version: r.version,
      note: 'Przyjęto jedną sztukę; druga wraca do odbiorcy.',
      items: [{ item_id: r.items[0].item_id, accepted: 1, restocked: 1 }],
    });
    r = await api('/returns/' + r.id);
    assert.equal(r.refund_amount, 12345);
    await api('/returns/' + r.id + '/refund', 'POST', {
      version: r.version,
      amount: r.settlement_amount,
      reference: 'Lokalne potwierdzenie QA — bez przelewu',
      confirmed: true,
    });
    state.correction = (await api('/returns/' + r.id + '/document', 'POST', {})).id;
    await save();
    console.log({
      accepted: 1,
      refund_recorded: 12345,
      source_stock: 18,
      real_financial_operations: 0,
    });
  } else if (phase === 'verify') {
    await login('buyer');
    const cancelled = await api('/b2b/network/orders/' + state.cancel_order),
      o = await api('/b2b/network/orders/' + state.order),
      r = await api('/b2b/network/orders/' + state.order + '/returns/' + state.return_id);
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.fulfillment.status, 'cancelled');
    assert.equal(cancelled.fulfillment.payments.overpayment, 25190);
    assert.equal(cancelled.fulfillment.payments.refunded, 0);
    assert.equal(o.state, 'received');
    assert.equal(o.lines[0].received, 3);
    assert.equal(o.lines[0].return_committed, 1);
    assert.equal(r.state, 'dispatched');
    assert.equal(r.supplier.state, 'closed');
    assert.equal(r.supplier.settled_amount, 12345);
    assert.equal(r.lines[0].quantity, 2);
    assert.equal(r.lines[0].recovered, 1);
    assert.equal(r.recoveries.length, 1);
    const supplierStock = (
      await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [state.product])
    ).rows[0];
    const buyerStock = (
      await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [state.local])
    ).rows[0];
    assert.deepEqual(supplierStock, { on_hand: 18, reserved: 0 });
    assert.deepEqual(buyerStock, { on_hand: 2, reserved: 0 });
    assert.equal(
      (await pool.query('SELECT price FROM products WHERE id=$1', [state.local])).rows[0].price,
      25000,
    );
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
      scope:
        'native_local_B2B_purchase_cancellation_RMA_WZ_partial_acceptance_settlement_recovery_PZ',
      buyer_order_id: state.order,
      cancelled_order_id: state.cancel_order,
      return_id: state.return_id,
      supplier_stock: supplierStock,
      buyer_stock: buyerStock,
      buyer_sale_price: 25000,
      requested: 2,
      accepted: 1,
      recovered: 1,
      refund_recorded: 12345,
      cancelled_overpayment: 25190,
      cancelled_refunded: 0,
      currency: 'PLN',
      dispatch_document: r.dispatch_document.number,
      recoveries: r.recoveries.map((x: any) => x.number),
      preserved_previous_firms: state.tenants.length,
      preserved_stable_tables: Object.keys(state.before).length,
      provider_requests: 0,
      real_financial_operations: 0,
      whole_goal_complete: false,
    };
    await writeFile('docs/b2b-network-returns-qa.json', JSON.stringify(proof, null, 2) + '\n');
    console.log(proof);
  } else throw Error('Unknown phase');
} finally {
  await pool.end();
}
