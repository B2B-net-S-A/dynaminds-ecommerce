/** Local QA126. Private state is separate from every previously accepted fixture. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';

const path = 'data/b2b-network-dropshipping-stage126.json';
const originals = ['data/wms-lots-stage111.json', 'data/source-fulfillment-stage124.json'];
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
async function liveDropship() {
  const rows = (await api(dropshipBase() + '/orders')).data;
  const active = rows.filter(
    (o: any) => o.customer_order_id === state.customer && o.state !== 'cancelled',
  );
  assert.equal(active.length, 1, 'Exactly one live forwarding of this customer');
  const detail = await api(dropshipBase() + '/orders/' + active[0].id);
  return detail.order;
}
async function stock(product: string) {
  const rows = (
    await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [product])
  ).rows;
  assert.equal(rows.length, 1);
  return rows[0];
}
async function unchangedRetail() {
  const o = await api('/orders/' + state.customer),
    b = state.customer_paid_baseline;
  assert.equal(o.total, b.total);
  assert.deepEqual(o.address, b.address);
  assert.deepEqual(
    o.items.map((i: any) => ({
      id: i.id,
      quantity: i.quantity,
      line_total: i.line_total,
      price: i.price,
    })),
    b.items,
  );
  for (const key of ['received', 'refunded', 'credit', 'amount_due', 'overpayment'])
    assert.equal(o.payment[key], b.payment[key], `Customer payment ${key} changed`);
  return o;
}
try {
  if (phase === 'baseline') {
    const previous = [];
    for (const p of originals) {
      const stat = await lstat(p);
      assert(stat.isFile() && !stat.isSymbolicLink() && !(stat.mode & 0o077));
      const bytes = await readFile(p),
        s = JSON.parse(bytes.toString());
      previous.push({
        path: p,
        fixture_sha256: bytesHash(bytes),
        tenant: s.tenant,
        user: s.user,
        checkpoint: await checkpoint(s.tenant, s.user),
      });
    }
    state = { previous };
    await writeFile(path, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    console.log(
      JSON.stringify({
        phase,
        status: 'PASS',
        firms: previous.length,
        tables: previous.map((f) => Object.keys(f.checkpoint).length),
        old_fixture_rewrites: 0,
      }),
    );
  } else {
    const stat = await lstat(path);
    assert(!(stat.mode & 0o077));
    state = JSON.parse(await readFile(path, 'utf8'));
    if (phase === 'setup') {
      assert(!state.buyer && !state.supplier, 'Never repeat an existing setup');
      for (const [side, label] of [
        ['supplier', 'Dostawca'],
        ['buyer', 'Sprzedawca'],
      ] as const) {
        const password = 'Dyna-QA126-' + randomUUID(),
          email = `qa126-${side}-${randomUUID()}@example.test`;
        await api(
          '/auth/signup',
          'POST',
          {
            email,
            password,
            name: 'QA126 ' + label,
            organization: { name: 'QA126 Dropshipping ' + label },
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
            sku: 'QA126-SUPPLIER-A',
            name: 'QA126 produkt dostawcy',
            price: 20000,
            quantity: 20,
            warehouse_id: state.supplier.warehouse,
          },
          201,
        )
      ).id;
      const list = await api('/price-lists', 'POST', { name: 'QA126 hurt', currency: 'PLN' }, 201);
      await api('/price-lists/' + list.id + '/items', 'PUT', {
        version: list.version,
        items: [{ product_id: state.product, price: 12345 }],
      });
      const body = {
        name: 'QA126 Sprzedawca — nabywca hurtowy',
        email: state.buyer.email,
        warehouse_id: state.supplier.warehouse,
        price_list_id: list.id,
        address: {
          street: 'Adres sprzedawcy 126',
          city: 'Warszawa',
          postal_code: '00-126',
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
    } else if (phase === 'prepare') {
      assert(!state.customer, 'Never repeat customer setup');
      await login('buyer');
      const base = '/b2b/network/links/' + state.link;
      const catalog = await api(base + '/catalog');
      assert.equal(catalog.data.length, 1);
      state.item = catalog.data[0].id;
      state.local = (
        await api(base + '/catalog/' + state.item + '/product', 'POST', {
          version: catalog.data[0].version,
          sku: 'QA126-RETAIL-A',
          sale_price: 25000,
          warehouse_id: state.buyer.warehouse,
          confirmed: true,
        })
      ).product_id;
      await save();
      const receipt = await api(
        '/warehouse-documents',
        'POST',
        {
          kind: 'receipt',
          warehouse_id: state.buyer.warehouse,
          reference: 'QA126 własny towar',
          lines: [{ product_id: state.local, quantity: 20, location: 'A-01' }],
        },
        201,
      );
      await api('/warehouse-documents/' + receipt.id + '/post', 'POST', {
        version: receipt.version,
      });
      state.initial_receipt = receipt.id;
      state.customer = (
        await api(
          '/orders',
          'POST',
          {
            customer_name: 'QA126 Klient końcowy',
            email: 'qa126-customer@example.test',
            address: {
              street: 'Adres klienta 126',
              city: 'Kraków',
              postal_code: '30-126',
              country: 'PL',
              phone: '+48126000126',
            },
            warehouse_id: state.buyer.warehouse,
            shipping_cost: 900,
            items: [{ product_id: state.local, quantity: 3 }],
          },
          201,
        )
      ).id;
      const customer = await api('/orders/' + state.customer);
      assert.equal(customer.total, 75900);
      state.customer_line = customer.items[0].id;
      state.customer_original = {
        total: customer.total,
        payment: customer.payment,
        address: customer.address,
        items: customer.items.map((i: any) => ({
          id: i.id,
          quantity: i.quantity,
          line_total: i.line_total,
          price: i.price,
        })),
      };
      await save();
      await previousFirmsUnchanged();
      console.log(
        JSON.stringify({
          phase,
          status: 'PASS',
          retail_total_minor: 75900,
          retail_units: 3,
          initial_own_stock: 20,
          previous_firms_unchanged: true,
        }),
      );
    } else if (phase === 'pay-customer') {
      assert(state.customer && !state.customer_paid_baseline, 'Never repeat payment admission');
      await login('buyer');
      await api('/orders/' + state.customer + '/status', 'PATCH', { status: 'paid' });
      const customer = await api('/orders/' + state.customer);
      assert.equal(customer.payment.received, 75900);
      assert.equal(customer.payment.amount_due, 0);
      state.customer_paid_baseline = {
        total: customer.total,
        payment: customer.payment,
        address: customer.address,
        items: customer.items.map((i: any) => ({
          id: i.id,
          quantity: i.quantity,
          line_total: i.line_total,
          price: i.price,
        })),
      };
      await save();
      await previousFirmsUnchanged();
      console.log(
        JSON.stringify({
          phase,
          status: 'PASS',
          synthetic_manual_customer_receipt_minor: 75900,
          external_payment_operations: 0,
          previous_firms_unchanged: true,
        }),
      );
    } else if (phase === 'forwarded') {
      await login('buyer');
      const d = await liveDropship();
      state.forwarding = d.id;
      state.supplier_order = d.supplier_order_id;
      assert.equal(d.wholesale.total_minor, '25190');
      assert.equal(d.receiver.address.street, 'Adres klienta 126');
      assert.equal(d.retail.total_minor, '75900');
      assert.equal(d.fulfillment.payment_balance.received, '0');
      assert.equal(d.fulfillment.payment_balance.amount_due, '25190');
      assert.deepEqual(await stock(state.local), { on_hand: 20, reserved: 1 });
      assert.deepEqual(await stock(state.product), { on_hand: 20, reserved: 2 });
      await unchangedRetail();
      await save();
      await previousFirmsUnchanged();
      console.log(
        JSON.stringify({
          phase,
          status: 'PASS',
          retail_total_minor: 75900,
          wholesale_total_minor: 25190,
          wholesale_received_minor: 0,
          buyer_reserved: 1,
          supplier_reserved: 2,
          source_retail_unchanged: true,
          previous_firms_unchanged: true,
        }),
      );
    } else if (phase === 'cancelled') {
      await login('buyer');
      const d = (await api(dropshipBase() + '/orders/' + state.forwarding)).order;
      assert.equal(d.state, 'cancelled');
      assert.equal(d.fulfillment.status, 'cancelled');
      assert.equal(d.fulfillment.shipments.length, 0);
      assert.deepEqual(await stock(state.local), { on_hand: 20, reserved: 3 });
      assert.deepEqual(await stock(state.product), { on_hand: 20, reserved: 0 });
      await unchangedRetail();
      await previousFirmsUnchanged();
      state.cancelled_forwarding = d.id;
      await save();
      console.log(
        JSON.stringify({
          phase,
          status: 'PASS',
          buyer_reserved: 3,
          supplier_reserved: 0,
          source_retail_unchanged: true,
          previous_firms_unchanged: true,
          external_operations: 0,
        }),
      );
    } else if (phase === 'supplier-dispatch') {
      assert(
        state.supplier_order && !state.supplier_dispatched,
        'Never replay physical dispatch phase',
      );
      await login('supplier');
      const supplier = await api('/orders/' + state.supplier_order);
      assert.equal(supplier.total, 25190);
      assert.equal(supplier.address.street, 'Adres klienta 126');
      await api('/orders/' + state.supplier_order + '/status', 'PATCH', { status: 'paid' });
      await api('/orders/' + state.supplier_order + '/status', 'PATCH', { status: 'picking' });
      for (let i = 0; i < 2; i++)
        await api('/orders/' + state.supplier_order + '/scan', 'POST', {
          code: 'QA126-SUPPLIER-A',
        });
      await api('/orders/' + state.supplier_order + '/status', 'PATCH', { status: 'packed' });
      await api('/orders/' + state.supplier_order + '/ship-demo', 'POST', {});
      const invoice = await api('/orders/' + state.supplier_order + '/documents', 'POST', {
        kind: 'invoice',
      });
      state.supplier_invoice = invoice.id;
      state.supplier_dispatched = true;
      await save();
      const forwarding = await pool.query(
        'SELECT bill_to FROM b2b_dropship_supplier_orders WHERE tenant_id=$1 AND order_id=$2',
        [state.supplier.tenant, state.supplier_order],
      );
      assert.equal(forwarding.rows.length, 1);
      const billedCompany = forwarding.rows[0].bill_to;
      assert.equal(invoice.data.customer, billedCompany.name);
      assert.equal(invoice.data.email, billedCompany.email);
      assert.deepEqual(invoice.data.address, billedCompany.address);
      assert.equal(invoice.data.tax_id, billedCompany.tax_id);
      assert.notEqual(invoice.data.customer, supplier.customer_name);
      assert.deepEqual(await stock(state.product), { on_hand: 18, reserved: 0 });
      await login('buyer');
      const d = await liveDropship();
      assert.equal(d.fulfillment.status, 'shipped');
      assert(d.fulfillment.shipments.some((s: any) => s.dispatched_at && s.tracking_number));
      await unchangedRetail();
      await previousFirmsUnchanged();
      console.log(
        JSON.stringify({
          phase,
          status: 'PASS',
          supplier_on_hand: 18,
          supplier_reserved: 0,
          synthetic_manual_wholesale_receipt_minor: 25190,
          tracking_visible_to_buyer: true,
          wholesale_invoice_uses_purchasing_company: true,
          source_retail_unchanged: true,
          previous_firms_unchanged: true,
          external_shipments: 0,
        }),
      );
    } else if (phase === 'buyer-dispatch') {
      assert(
        state.supplier_dispatched && !state.buyer_dispatched,
        'Never replay buyer physical dispatch phase',
      );
      await login('buyer');
      await api('/orders/' + state.customer + '/status', 'PATCH', { status: 'picking' });
      await api('/orders/' + state.customer + '/scan', 'POST', { code: 'QA126-RETAIL-A' });
      await api('/orders/' + state.customer + '/status', 'PATCH', { status: 'packed' });
      await api('/orders/' + state.customer + '/ship-demo', 'POST', {});
      state.buyer_dispatched = true;
      await save();
      assert.deepEqual(await stock(state.local), { on_hand: 19, reserved: 0 });
      await unchangedRetail();
      await previousFirmsUnchanged();
      console.log(
        JSON.stringify({
          phase,
          status: 'PASS',
          buyer_on_hand: 19,
          buyer_reserved: 0,
          local_issued: 1,
          source_retail_unchanged: true,
          previous_firms_unchanged: true,
          external_shipments: 0,
        }),
      );
    } else if (phase === 'verify') {
      const revision = process.env.QA_EXPECTED_REVISION;
      assert(revision && /^[a-f0-9]{7,40}$/.test(revision));
      const health = await api('/health');
      assert.equal(health.revision, revision);
      assert.equal(health.schema_revision, '108_b2b_dropshipping');
      await login('buyer');
      const d = await liveDropship(),
        customer = await unchangedRetail();
      assert(d.reconciled);
      assert.equal(customer.status, 'shipped');
      assert.equal(d.fulfillment.payment_balance.received, '25190');
      assert.equal(d.fulfillment.payment_balance.amount_due, '0');
      assert.deepEqual(await stock(state.local), { on_hand: 19, reserved: 0 });
      assert.deepEqual(await stock(state.product), { on_hand: 18, reserved: 0 });
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int n FROM warehouse_documents WHERE tenant_id=$1 AND kind='receipt'",
            [state.buyer.tenant],
          )
        ).rows[0].n,
        1,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int n FROM shipments WHERE tenant_id=$1 AND order_id=$2',
            [state.buyer.tenant, state.customer],
          )
        ).rows[0].n,
        1,
      );
      await api(
        dropshipBase() + '/orders/' + d.id + '/cancel',
        'POST',
        {
          client_key: randomUUID(),
          version: d.version,
          reason: 'QA126 próba cofnięcia po nadaniu',
          confirmed: true,
        },
        409,
      );
      const localParcel = (
        await pool.query(
          `SELECT e.items FROM shopify_dispatch_evidence e
        JOIN shipments s ON(s.tenant_id,s.id)=(e.tenant_id,e.shipment_id)
        WHERE s.tenant_id=$1 AND s.order_id=$2`,
          [state.buyer.tenant, state.customer],
        )
      ).rows;
      assert.equal(localParcel.length, 1);
      assert.equal(localParcel[0].items.length, 1);
      assert.equal(localParcel[0].items[0].quantity, 1);
      assert.equal(localParcel[0].items[0].original_quantity, 3);
      assert.equal(localParcel[0].items[0].external_quantity, 2);
      await previousFirmsUnchanged();
      console.log(
        JSON.stringify({
          phase,
          status: 'PASS',
          revision,
          schema: health.schema_revision,
          retail_received_minor: 75900,
          wholesale_received_minor: 25190,
          buyer_on_hand: 19,
          supplier_on_hand: 18,
          buyer_receipts: 1,
          buyer_real_local_parcels: 1,
          local_manifest_units: 1,
          no_fake_shipments: true,
          post_dispatch_cancel_rejected: true,
          previous_firms_unchanged: true,
          old_fixture_rewrites: 0,
          external_operations: 0,
        }),
      );
    } else if (phase === 'previous') {
      await previousFirmsUnchanged();
      console.log(
        JSON.stringify({
          phase,
          status: 'PASS',
          firms: state.previous.length,
          original_checkpoint_comparison: true,
          old_fixture_rewrites: 0,
        }),
      );
    } else throw Error('Unsupported QA126 phase');
  }
} finally {
  await pool.end();
}
