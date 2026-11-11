// Local synthetic fixture only; credentials and private portal URLs stay out of evidence.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
const phase = process.argv[2],
  path = 'data/purchasing-stage021.json',
  d = JSON.parse(await readFile(path, 'utf8'));
let cookie = '';
async function api(p: string, method = 'GET', body?: any) {
  const r = await fetch('http://127.0.0.1:4100/api' + p, {
    method,
    headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
  assert(r.ok, `${method} ${p}: ${r.status}`);
  return r.json();
}
async function previousUnchanged() {
  for (const [t, rows] of Object.entries(d.before)) {
    const current = (
      await pool.query(
        `SELECT to_jsonb(t) AS row FROM ${t} t WHERE ($1::uuid IS NULL OR tenant_id<>$1) ORDER BY to_jsonb(t)::text`,
        [d.fixture?.tenant_id ?? null],
      )
    ).rows.map((r) => r.row);
    assert.deepEqual(current, rows, t);
  }
  return true;
}
try {
  assert.equal((await api('/health')).schema_revision, '021_purchasing');
  if (phase === 'migrated') {
    d.migration = {
      previous_business_rows_unchanged: await previousUnchanged(),
      counts: Object.fromEntries(
        Object.entries(d.before).map(([t, rows]: any) => [t, rows.length]),
      ),
    };
    await writeFile(path, JSON.stringify(d, null, 2));
    console.log(JSON.stringify(d.migration));
  }
  if (phase === 'setup') {
    assert(!d.fixture);
    assert.equal(
      (await pool.query("SELECT id FROM tenants WHERE name='QA Zakupy 20261004'")).rowCount,
      0,
    );
    await api('/auth/login', 'POST', { email: 'admin@demo.local', password: 'DynaDemo!2026' });
    const org = await api('/workspaces', 'POST', {
        name: 'QA Zakupy 20261004',
        currency: 'PLN',
        locale: 'pl-PL',
      }),
      warehouse = (await api('/warehouses')).data[0];
    d.fixture = { tenant_id: org.user.tenant_id, warehouse_id: warehouse.id, products: [] };
    await writeFile(path, JSON.stringify(d, null, 2));
    for (const p of [
      { sku: 'QA-ZAK-BLUZA', name: 'Bluza · zakupy QA', price: 12900 },
      { sku: 'QA-ZAK-KOSZULKA', name: 'Koszulka · zakupy QA', price: 7900 },
    ]) {
      const product = await api('/products', 'POST', {
        ...p,
        warehouse_id: warehouse.id,
        quantity: 0,
      });
      d.fixture.products.push({ id: product.id, ...p });
      await writeFile(path, JSON.stringify(d, null, 2));
    }
    console.log(JSON.stringify(d.fixture));
  }
  if (phase === 'fulfill') {
    const f = d.fixture;
    assert(!f.sales_order);
    await api('/auth/login', 'POST', { email: 'admin@demo.local', password: 'DynaDemo!2026' });
    await api('/workspaces/switch', 'POST', { tenant_id: f.tenant_id });
    const purchases = (await api('/purchase-orders')).data,
      po = purchases.find((p: any) => p.reference === 'QA-ZAKUP-20261004');
    assert(po);
    const full = await api('/purchase-orders/' + po.id);
    assert.equal(full.state, 'received');
    assert.equal(full.receipts.length, 2);
    assert.equal(full.total_net, 27500);
    assert.deepEqual(
      full.lines.map((l: any) => [l.sku, l.quantity, l.received_quantity, l.on_hand]),
      [
        ['QA-ZAK-BLUZA', 5, 5, 5],
        ['QA-ZAK-KOSZULKA', 3, 3, 3],
      ],
    );
    let o = await api('/orders', 'POST', {
      customer_name: 'Klient zakupów QA',
      email: 'zakupy-qa@example.invalid',
      warehouse_id: f.warehouse_id,
      items: f.products.map((p: any) => ({ product_id: p.id, quantity: 1 })),
      address: { street: 'Testowa 1', city: 'Warszawa', postal_code: '00-001', country: 'PL' },
    });
    f.sales_order = { id: o.id, number: o.number };
    await writeFile(path, JSON.stringify(d, null, 2));
    await api('/orders/' + o.id + '/status', 'PATCH', { status: 'paid' });
    const reserved = (
      await pool.query('SELECT reserved FROM stock WHERE tenant_id=$1', [f.tenant_id])
    ).rows;
    assert(reserved.every((s) => s.reserved === 1));
    await api('/orders/' + o.id + '/status', 'PATCH', { status: 'picking' });
    for (const p of f.products) await api('/orders/' + o.id + '/scan', 'POST', { code: p.sku });
    await api('/orders/' + o.id + '/status', 'PATCH', { status: 'packed' });
    await api('/orders/' + o.id + '/ship-demo', 'POST', {});
    await api('/orders/' + o.id + '/documents', 'POST', { kind: 'invoice' });
    o = await api('/orders/' + o.id);
    let r = await api('/orders/' + o.id + '/returns', 'POST', {
      client_key: randomUUID(),
      reason: 'QA zakupy — zwrot DEMO',
      shipping_refund: 0,
      items: o.items.map((i: any) => ({ item_id: i.id, quantity: i.quantity })),
    });
    r = await api('/returns/' + r.id + '/receive', 'POST', {
      version: r.version,
      shipping_refund: 0,
      note: 'QA przyjęcie',
      items: r.items.map((i: any) => ({
        item_id: i.item_id,
        accepted: i.requested,
        restocked: i.requested,
      })),
    });
    await api('/returns/' + r.id + '/document', 'POST', {});
    await api('/returns/' + r.id + '/refund', 'POST', {
      version: r.version,
      amount: o.total,
      reference: 'QA-SYMULACJA-BEZ-PRZELEWU',
      confirmed: true,
    });
    f.purchase_order_id = po.id;
    f.return_id = r.id;
    await writeFile(path, JSON.stringify(d, null, 2));
    console.log(
      JSON.stringify({
        purchase_number: po.number,
        sales_number: o.number,
        total: o.total,
        reserved: 2,
        physical_scans: 2,
        shipment: 'DEMO',
        refund: 'synthetic',
      }),
    );
  }
  if (phase === 'public') {
    const f = d.fixture;
    assert(!d.public);
    await api('/auth/login', 'POST', { email: 'admin@demo.local', password: 'DynaDemo!2026' });
    await api('/workspaces/switch', 'POST', { tenant_id: f.tenant_id });
    const keys: any[] = [];
    const existing = (await api('/developer/keys')).data.filter(
      (k: any) => !k.revoked_at && ['QA zakup read', 'QA zakup write'].includes(k.name),
    );
    for (const k of existing) await api('/developer/keys/' + k.id, 'DELETE');
    try {
      const read = await api('/developer/keys', 'POST', {
          name: 'QA zakup read',
          scopes: ['purchasing:read'],
        }),
        write = await api('/developer/keys', 'POST', {
          name: 'QA zakup write',
          scopes: ['purchasing:read', 'purchasing:write'],
        });
      keys.push(read, write);
      const call = (key: any, p: string, method = 'GET', body?: any) =>
        fetch('http://127.0.0.1:4100/api/v1' + p, {
          method,
          headers: {
            authorization: 'Bearer ' + key.token,
            ...(body ? { 'content-type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
      assert.equal((await call(read, '/purchase-orders/' + f.purchase_order_id)).status, 200);
      const receipt = (
          await pool.query(
            'SELECT * FROM purchase_receipts WHERE order_id=$1 ORDER BY created_at,id LIMIT 1',
            [f.purchase_order_id],
          )
        ).rows[0],
        lines = (
          await pool.query(
            'SELECT product_id,quantity,location FROM purchase_receipt_lines WHERE receipt_id=$1',
            [receipt.id],
          )
        ).rows;
      const body = {
          version: 1,
          client_key: receipt.client_key,
          reference: receipt.reference,
          note: receipt.note,
          lines,
        },
        endpoint = '/purchase-orders/' + f.purchase_order_id + '/receive';
      assert.equal((await call(read, endpoint, 'POST', body)).status, 403);
      const r = await call(write, endpoint, 'POST', body);
      assert.equal(r.status, 200);
      assert.equal((await r.json()).replayed, true);
      d.public = {
        read_status: 200,
        write_with_read_scope: 403,
        receipt_replay: 200,
        extra_stock_change: false,
        keys_revoked: true,
      };
    } finally {
      for (const k of keys) await api('/developer/keys/' + k.id, 'DELETE');
    }
    await writeFile(path, JSON.stringify(d, null, 2));
    console.log(JSON.stringify(d.public));
  }
  if (phase === 'verify') {
    const f = d.fixture;
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int AS count FROM api_keys WHERE tenant_id=$1 AND revoked_at IS NULL',
          [f.tenant_id],
        )
      ).rows[0].count,
      0,
    );
    await api('/auth/login', 'POST', { email: 'admin@demo.local', password: 'DynaDemo!2026' });
    await api('/workspaces/switch', 'POST', { tenant_id: f.tenant_id });
    const orders = (await api('/purchase-orders')).data,
      full = await api('/purchase-orders/' + f.purchase_order_id),
      closed = await api(
        '/purchase-orders/' + orders.find((p: any) => p.reference === 'QA-ZAMKNIECIE').id,
      ),
      o = await api('/orders/' + f.sales_order.id);
    assert.equal(full.state, 'received');
    assert.equal(full.receipts.length, 2);
    assert.equal(closed.state, 'closed');
    assert.equal(closed.lines[0].received_quantity, 1);
    assert.equal(closed.lines[0].closed_quantity, 3);
    assert.equal(o.status, 'return_completed');
    assert.equal(o.total, 20800);
    const stock = (
      await pool.query(
        'SELECT p.sku,p.price,s.on_hand,s.reserved FROM stock s JOIN products p ON p.id=s.product_id WHERE s.tenant_id=$1 ORDER BY p.sku',
        [f.tenant_id],
      )
    ).rows;
    assert.deepEqual(stock, [
      { sku: 'QA-ZAK-BLUZA', price: 12900, on_hand: 6, reserved: 0 },
      { sku: 'QA-ZAK-KOSZULKA', price: 7900, on_hand: 3, reserved: 0 },
    ]);
    const docs = (
      await pool.query(
        "SELECT kind,(data->>'total')::int AS total,mode FROM documents WHERE tenant_id=$1 ORDER BY total DESC",
        [f.tenant_id],
      )
    ).rows;
    assert.deepEqual(
      docs.map((x) => x.total),
      [20800, -20800],
    );
    assert(docs.every((x) => x.mode === 'demo'));
    const report = {
      stage: '021_purchasing',
      migration: d.migration,
      previous_business_rows_unchanged: await previousUnchanged(),
      purchase: {
        number: full.number,
        state: full.state,
        total_net: full.total_net,
        received_net: full.received_net,
        receipts: full.receipts.map((r: any) => ({
          number: r.document_number,
          quantity: r.lines.reduce((n: number, l: any) => n + l.quantity, 0),
          state: r.document_status,
        })),
      },
      partial_close: {
        number: closed.number,
        state: closed.state,
        received: 1,
        closed: 3,
        reason: closed.close_reason,
      },
      sales: {
        number: o.number,
        status: o.status,
        total: o.total,
        currency: o.currency,
        physical_scans: 2,
      },
      stock,
      documents: docs,
      external_supplier_order_sent: false,
      provider_writes: false,
      public_api: d.public ?? null,
      real_payment: false,
      full_goal_complete: false,
    };
    await writeFile(
      process.env.PROOF_OUTPUT ?? 'docs/purchasing-qa.json',
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
  }
} finally {
  await pool.end();
}
