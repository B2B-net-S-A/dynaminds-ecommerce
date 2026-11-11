/** Local QA127. Preserve accepted QA126/124/111 firms and original fixture bytes. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';

const path = 'data/b2b-external-order-intent-stage127.json';
const originals = [
  'data/wms-lots-stage111.json',
  'data/source-fulfillment-stage124.json',
  'data/b2b-network-dropshipping-stage126.json',
];
const phase = process.argv[2];
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const bytesHash = (v: Buffer) => createHash('sha256').update(v).digest('hex');
let state: any,
  cookie = '';
const save = () => writeFile(path, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
async function api(route: string, method = 'GET', body?: unknown, expected = 200) {
  const response = await fetch('http://127.0.0.1:4100/api' + route, {
    method,
    headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20000),
  });
  if (response.headers.get('set-cookie'))
    cookie = response.headers.get('set-cookie')!.split(';')[0];
  const data = await response.json();
  // Failure output intentionally excludes payload/DTOs and private headers.
  assert.equal(response.status, expected, `${method} ${route}: HTTP ${response.status}`);
  return data as any;
}
async function checkpoint(tenant: string, user: string) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    const names = (
      await c.query(`SELECT table_name FROM information_schema.columns
      WHERE table_schema='public' AND column_name='tenant_id' AND table_name<>'sessions'
      UNION SELECT 'tenants' UNION SELECT 'users' ORDER BY 1`)
    ).rows;
    const result: Record<string, { count: number; sha256: string }> = {};
    for (const { table_name: table } of names) {
      assert(/^[a-z_][a-z0-9_]*$/.test(table));
      const identity = ['tenants', 'users'].includes(table) ? 'id' : 'tenant_id';
      const rows = (
        await c.query(
          `SELECT to_jsonb(t) row FROM "${table}" t
        WHERE ${identity}=$1 ORDER BY 1`,
          [table === 'users' ? user : tenant],
        )
      ).rows;
      result[table] = { count: rows.length, sha256: hash(rows) };
    }
    await c.query('COMMIT');
    return result;
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}
async function previousFirmsUnchanged() {
  for (const f of state.previous) {
    assert.equal(bytesHash(await readFile(f.path)), f.fixture_sha256);
    const current = await checkpoint(f.tenant, f.user);
    for (const [table, before] of Object.entries(f.checkpoint))
      assert.deepEqual(current[table], before, `Previously accepted firm changed: ${table}`);
    for (const [table, now] of Object.entries(current))
      if (!f.checkpoint[table])
        assert.equal(now.count, 0, `New module populated old firm: ${table}`);
  }
}
async function login(side: 'buyer' | 'supplier') {
  const s = state[side];
  await api('/auth/login', 'POST', { email: s.email, password: s.password });
  cookie = cookie.split(';')[0];
  s.cookie = cookie;
  await save();
}
const dropshipBase = () => '/b2b/network/links/' + state.link + '/dropshipping';
const buyerPhysicalTables = [
  'stock',
  'stock_locations',
  'stock_location_movements',
  'stock_location_operations',
  'stock_movements',
  'reservations',
  'reservation_locations',
  'order_pick_items',
  'warehouse_documents',
  'warehouse_document_lines',
  'wms_operations',
  'wms_lots',
  'wms_cost_layers',
  'wms_layer_positions',
  'wms_reservation_layers',
  'wms_layer_movements',
  'wms_issue_fragments',
  'wms_return_fragments',
  'shipments',
];
async function buyerPhysicalCheckpoint() {
  const all = await checkpoint(state.buyer.tenant, state.buyer.user);
  return Object.fromEntries(
    buyerPhysicalTables.map((table) => {
      assert(all[table], 'Missing physical table: ' + table);
      return [table, all[table]];
    }),
  );
}
async function unchangedBuyerPhysical() {
  assert(state.buyer_physical_baseline);
  assert.deepEqual(
    await buyerPhysicalCheckpoint(),
    state.buyer_physical_baseline,
    'External fulfillment changed buyer physical custody',
  );
}
async function stock(product: string) {
  const rows = (
    await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [product])
  ).rows;
  assert.equal(rows.length, 1);
  return rows[0];
}
async function liveDropship() {
  const rows = (await api(dropshipBase() + '/orders')).data;
  const active = rows.filter(
    (o: any) => o.customer_order_id === state.customer && o.state !== 'cancelled',
  );
  assert.equal(active.length, 1);
  return (await api(dropshipBase() + '/orders/' + active[0].id)).order;
}
const retailSnapshot = (o: any) => ({
  currency: o.currency,
  customer_name: o.customer_name,
  email: o.email,
  total: o.total,
  address: o.address,
  items: o.items.map((i: any) => ({
    id: i.id,
    quantity: i.quantity,
    line_total: i.line_total,
    price: i.price,
    vat: i.vat,
    components: i.components,
  })),
});
async function unchangedRetail() {
  const customer = await api('/orders/' + state.customer);
  assert.deepEqual(retailSnapshot(customer), state.customer_original);
  return customer;
}
async function confirmQaReceipt(orderId: string, expectedAmount: number) {
  const order = await api('/orders/' + orderId);
  const history = await api('/orders/' + orderId + '/payments');
  assert.equal(order.total, expectedAmount);
  assert.equal(history.balance.amount_due, expectedAmount);
  assert.equal(history.balance.received, 0);
  await api('/orders/' + orderId + '/payments', 'POST', {
    client_key: randomUUID(),
    version: Number(order.version),
    kind: 'receipt',
    amount: expectedAmount,
    currency: order.currency,
    method: 'other',
    reference: 'QA127 local synthetic operator confirmation; no bank transfer',
    confirmed: true,
  });
}
try {
  if (phase === 'baseline') {
    const previous = [];
    for (const original of originals) {
      const stat = await lstat(original);
      assert(stat.isFile() && !stat.isSymbolicLink() && !(stat.mode & 0o077));
      const bytes = await readFile(original),
        accepted = JSON.parse(bytes.toString());
      const firms =
        accepted.buyer && accepted.supplier ? [accepted.buyer, accepted.supplier] : [accepted];
      for (const firm of firms)
        previous.push({
          path: original,
          fixture_sha256: bytesHash(bytes),
          tenant: firm.tenant,
          user: firm.user,
          checkpoint: await checkpoint(firm.tenant, firm.user),
        });
    }
    state = {
      previous,
      original_runtime: await api('/health'),
      captured_at: new Date().toISOString(),
    };
    await writeFile(path, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    console.log(
      JSON.stringify({
        phase,
        status: 'PASS',
        accepted_firms: previous.length,
        tables: previous.map((f) => Object.keys(f.checkpoint).length),
        old_fixture_rewrites: 0,
      }),
    );
  } else if (['setup', 'prepare'].includes(phase)) {
    const stat = await lstat(path);
    assert(!(stat.mode & 0o077));
    state = JSON.parse(await readFile(path, 'utf8'));
    if (phase === 'setup') {
      assert(!state.buyer && !state.supplier, 'Never repeat an existing setup');
      for (const [side, label] of [
        ['supplier', 'Dostawca'],
        ['buyer', 'Sprzedawca'],
      ] as const) {
        const password = 'Dyna-QA127-' + randomUUID(),
          email = `qa127-${side}-${randomUUID()}@example.test`;
        await api(
          '/auth/signup',
          'POST',
          {
            email,
            password,
            name: 'QA127 ' + label,
            organization: { name: 'QA127 Dropshipping ' + label },
          },
          201,
        );
        const me = (await api('/auth/me')).user;
        state[side] = { email, password, tenant: me.tenant_id, user: me.id, cookie };
        await save();
        await api('/workspaces/plan', 'PATCH', { plan: 'enterprise' });
        state[side].warehouse = (await api('/warehouses')).data[0].id;
        await save();
      }
      await login('supplier');
      state.product = (
        await api(
          '/products',
          'POST',
          {
            sku: 'QA127-SUPPLIER-A',
            name: 'QA127 produkt dostawcy',
            price: 20000,
            quantity: 20,
            warehouse_id: state.supplier.warehouse,
          },
          201,
        )
      ).id;
      const list = await api('/price-lists', 'POST', { name: 'QA127 hurt', currency: 'PLN' }, 201);
      await api('/price-lists/' + list.id + '/items', 'PUT', {
        version: list.version,
        items: [{ product_id: state.product, price: 12345 }],
      });
      const body = {
        name: 'QA127 Sprzedawca — nabywca hurtowy',
        email: state.buyer.email,
        warehouse_id: state.supplier.warehouse,
        price_list_id: list.id,
        address: {
          street: 'Adres sprzedawcy 127',
          city: 'Warszawa',
          postal_code: '00-127',
          country: 'PL',
        },
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
      state.run = (
        await api('/b2b/network/links/' + state.link + '/refresh', 'POST', {
          client_key: randomUUID(),
          confirmed: true,
        })
      ).id;
      await save();
      await previousFirmsUnchanged();
      console.log(
        JSON.stringify({
          phase,
          status: 'PASS',
          new_synthetic_firms: 2,
          previous_firms_unchanged: true,
          external_operations: 0,
        }),
      );
    } else {
      assert(!state.customer, 'Never repeat customer setup');
      await login('buyer');
      const base = '/b2b/network/links/' + state.link;
      const catalog = await api(base + '/catalog');
      assert.equal(catalog.data.length, 1);
      state.item = catalog.data[0].id;
      state.local = (
        await api(base + '/catalog/' + state.item + '/product', 'POST', {
          version: catalog.data[0].version,
          sku: 'QA127-RETAIL-A',
          sale_price: 25000,
          warehouse_id: state.buyer.warehouse,
          confirmed: true,
        })
      ).product_id;
      await save();
      const physical = await pool.query(
        'SELECT on_hand,reserved FROM stock WHERE tenant_id=$1 AND product_id=$2',
        [state.buyer.tenant, state.local],
      );
      assert(physical.rows.every((r) => Number(r.on_hand) === 0 && Number(r.reserved) === 0));
      const documents = await pool.query(
        'SELECT count(*)::int n FROM warehouse_documents WHERE tenant_id=$1',
        [state.buyer.tenant],
      );
      assert.equal(documents.rows[0].n, 0);
      await previousFirmsUnchanged();
      console.log(
        JSON.stringify({
          phase,
          status: 'PASS',
          buyer_on_hand: 0,
          buyer_reserved: 0,
          buyer_receipts: 0,
          supplier_on_hand: 20,
          external_operations: 0,
        }),
      );
    }
  } else if (phase === 'physical-baseline') {
    state = JSON.parse(await readFile(path, 'utf8'));
    assert(
      state.local && !state.buyer_physical_baseline,
      'Capture QA127 physical baseline exactly once',
    );
    state.buyer_physical_baseline = await buyerPhysicalCheckpoint();
    await save();
    await previousFirmsUnchanged();
    console.log(
      JSON.stringify({
        phase,
        status: 'PASS',
        buyer_physical_tables: buyerPhysicalTables.length,
        buyer_on_hand: 0,
        buyer_receipts: 0,
      }),
    );
  } else if (
    [
      'created',
      'forwarded',
      'forwarding-cancelled',
      'customer-cancelled',
      'customer-reopened',
      'pay-customer',
      'supplier-dispatch',
      'verify',
    ].includes(phase)
  ) {
    const stat = await lstat(path);
    assert(!(stat.mode & 0o077));
    state = JSON.parse(await readFile(path, 'utf8'));
    await login('buyer');
    if (phase === 'created') {
      assert(!state.customer, 'Never recapture accepted commercial baseline');
      const rows = (
        await pool.query('SELECT id FROM orders WHERE tenant_id=$1', [state.buyer.tenant])
      ).rows;
      assert.equal(rows.length, 1, 'Exactly one new customer order from Chrome');
      state.customer = rows[0].id;
      const customer = await api('/orders/' + state.customer);
      assert.equal(customer.total, 75900);
      assert.equal(customer.items.length, 1);
      assert.equal(customer.items[0].quantity, 3);
      assert.equal(customer.picking_items.length, 0);
      state.customer_line = customer.items[0].id;
      state.customer_original = retailSnapshot(customer);
      const detail = await api('/b2b/external-order-intents/orders/' + state.customer);
      assert(detail.intent && detail.intent.state === 'open');
      state.intent_id = detail.intent.id;
      state.intent_version = detail.intent.version;
      await save();
    } else if (phase === 'forwarded') {
      const d = await liveDropship();
      state.forwarding = d.id;
      state.supplier_order = d.supplier_order_id;
      assert.equal(d.wholesale.total_minor, '37535');
      assert.equal(d.retail.total_minor, '75900');
      assert.equal(d.receiver.address.street, 'Adres klienta 127');
      assert.equal(d.fulfillment.payment_balance.received, '0');
      assert.deepEqual(await stock(state.product), { on_hand: 20, reserved: 3 });
      await unchangedRetail();
      await save();
    } else if (phase === 'forwarding-cancelled') {
      const d = (await api(dropshipBase() + '/orders/' + state.forwarding)).order;
      assert.equal(d.state, 'cancelled');
      assert.equal(d.fulfillment.shipments.length, 0);
      assert.deepEqual(await stock(state.product), { on_hand: 20, reserved: 0 });
      state.cancelled_forwarding = state.forwarding;
      await unchangedRetail();
      await save();
    } else if (['customer-cancelled', 'customer-reopened'].includes(phase)) {
      const detail = await api('/b2b/external-order-intents/orders/' + state.customer);
      assert.equal(detail.intent.state, phase === 'customer-cancelled' ? 'closed' : 'open');
      const customer = await unchangedRetail();
      if (phase === 'customer-cancelled') assert.equal(customer.status, 'cancelled');
      else assert(!['cancelled', 'shipped', 'delivered', 'completed'].includes(customer.status));
      assert.equal(customer.payment.received, 0);
      assert.equal(customer.payment.refunded, 0);
      assert.deepEqual(await stock(state.product), { on_hand: 20, reserved: 0 });
      assert(detail.intent.version > state.intent_version);
      state.intent_version = detail.intent.version;
      await save();
    } else if (phase === 'pay-customer') {
      assert(!state.customer_paid, 'Never replay synthetic payment admission');
      await confirmQaReceipt(state.customer, 75900);
      const customer = await unchangedRetail();
      assert.equal(customer.payment.received, 75900);
      assert.equal(customer.payment.amount_due, 0);
      state.customer_paid = true;
      await save();
    } else if (phase === 'supplier-dispatch') {
      assert(
        state.supplier_order && !state.supplier_dispatched,
        'Never replay physical supplier dispatch',
      );
      await login('supplier');
      const supplier = await api('/orders/' + state.supplier_order);
      assert.equal(supplier.total, 37535);
      assert.equal(supplier.address.street, 'Adres klienta 127');
      await confirmQaReceipt(state.supplier_order, 37535);
      await api('/orders/' + state.supplier_order + '/status', 'PATCH', { status: 'picking' });
      for (let n = 0; n < 3; n++)
        await api('/orders/' + state.supplier_order + '/scan', 'POST', {
          code: 'QA127-SUPPLIER-A',
        });
      await api('/orders/' + state.supplier_order + '/status', 'PATCH', { status: 'packed' });
      await api('/orders/' + state.supplier_order + '/ship-demo', 'POST', {});
      state.supplier_dispatched = true;
      await save();
      assert.deepEqual(await stock(state.product), { on_hand: 17, reserved: 0 });
      await login('buyer');
      const d = await liveDropship();
      assert.equal(d.fulfillment.status, 'shipped');
      assert(d.fulfillment.shipments.some((p: any) => p.dispatched_at && p.tracking_number));
      await unchangedRetail();
    } else {
      const expected = process.env.QA_EXPECTED_REVISION;
      assert(expected && /^[a-f0-9]{7,40}$/.test(expected));
      const health = await api('/health');
      assert.equal(health.revision, expected);
      assert.equal(health.schema_revision, '109_b2b_external_order_intents');
      assert.equal(health.b2b_external_order_intents_available, true);
      const customer = await unchangedRetail(),
        d = await liveDropship();
      assert.equal(customer.status, 'shipped');
      assert(d.reconciled);
      assert.equal(customer.payment.received, 75900);
      assert.equal(customer.payment.amount_due, 0);
      assert.equal(d.fulfillment.payment_balance.received, '37535');
      assert.equal(d.fulfillment.payment_balance.amount_due, '0');
      assert.deepEqual(await stock(state.product), { on_hand: 17, reserved: 0 });
      const refusedBefore = {
        buyer: await checkpoint(state.buyer.tenant, state.buyer.user),
        supplier: await checkpoint(state.supplier.tenant, state.supplier.user),
      };
      await api(
        dropshipBase() + '/orders/' + d.id + '/cancel',
        'POST',
        {
          client_key: randomUUID(),
          version: d.version,
          reason: 'QA127 po nadaniu',
          confirmed: true,
        },
        409,
      );
      assert.deepEqual(
        {
          buyer: await checkpoint(state.buyer.tenant, state.buyer.user),
          supplier: await checkpoint(state.supplier.tenant, state.supplier.user),
        },
        refusedBefore,
        'Rejected cancellation preserves both firms and ledgers',
      );
    }
    await unchangedBuyerPhysical();
    await previousFirmsUnchanged();
    console.log(
      JSON.stringify({
        phase,
        status: 'PASS',
        buyer_on_hand: 0,
        buyer_reserved: 0,
        buyer_receipts: 0,
        buyer_physical_tables_exact: buyerPhysicalTables.length,
        previous_firms_exact: state.previous.length,
        old_fixture_rewrites: 0,
        external_operations: 0,
      }),
    );
  } else if (phase === 'previous') {
    const stat = await lstat(path);
    assert(!(stat.mode & 0o077));
    state = JSON.parse(await readFile(path, 'utf8'));
    await previousFirmsUnchanged();
    console.log(
      JSON.stringify({
        phase,
        status: 'PASS',
        accepted_firms: state.previous.length,
        original_fixture_bytes_unchanged: true,
      }),
    );
  } else throw new Error('Unknown QA127 phase');
} finally {
  await pool.end();
}
