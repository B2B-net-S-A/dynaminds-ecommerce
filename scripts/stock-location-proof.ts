// Native localhost only; synthetic tenant. Sensitive links stay out of the exported evidence.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool, migrate } from '../server/db';
const file = 'data/stock-locations-stage025.json';
const tables = [
  'orders',
  'order_items',
  'order_pick_items',
  'products',
  'stock',
  'reservations',
  'stock_movements',
  'warehouse_documents',
  'warehouse_document_lines',
  'purchase_orders',
  'purchase_order_lines',
  'purchase_receipts',
  'purchase_receipt_lines',
  'documents',
  'shipments',
  'return_cases',
  'return_items',
  'listings',
  'offer_plans',
  'order_status_plans',
  'source_payment_checks',
  'source_payment_configs',
  'payment_entries',
];
async function fingerprint(table: string, tenants: string[]) {
  const rows = (
    await pool.query(
      `SELECT row_to_json(t)::text AS row FROM ${table} t WHERE tenant_id=ANY($1::uuid[]) ORDER BY row_to_json(t)::text`,
      [tenants],
    )
  ).rows;
  return {
    count: rows.length,
    sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
  };
}
let cookie = '',
  tenant = '';
async function api(p: string, m = 'GET', b?: any) {
  const r = await fetch('http://127.0.0.1:4100/api' + p, {
    method: m,
    headers: {
      cookie,
      ...(tenant && !['/auth/login', '/workspaces', '/workspaces/switch'].includes(p)
        ? { 'x-workspace-id': tenant }
        : {}),
      ...(b ? { 'content-type': 'application/json' } : {}),
    },
    ...(b ? { body: JSON.stringify(b) } : {}),
  });
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
  assert(r.ok, m + ' ' + p + ':' + r.status);
  return r.json();
}
try {
  const phase = process.argv[2];
  if (phase === 'migrate') {
    const tenants = (await pool.query('SELECT id FROM tenants ORDER BY id')).rows.map((x) => x.id),
      before: any = {};
    for (const t of tables) before[t] = await fingerprint(t, tenants);
    await migrate();
    for (const t of tables)
      assert.deepEqual(
        await fingerprint(t, tenants),
        before[t],
        t + ' migration changed previous rows',
      );
    const sums = (
      await pool.query(
        'SELECT count(*)::int AS n FROM stock s WHERE s.on_hand<>(SELECT coalesce(sum(l.quantity),0) FROM stock_locations l WHERE (l.tenant_id,l.warehouse_id,l.product_id)=(s.tenant_id,s.warehouse_id,s.product_id))',
      )
    ).rows[0].n;
    assert.equal(sums, 0);
    await writeFile(
      file,
      JSON.stringify({
        tenants,
        before,
        migration: { previous_tables_preserved: tables.length, all_bin_totals_match: true },
      }),
      { mode: 0o600 },
    );
    console.log(
      JSON.stringify({
        migration: '025_stock_locations',
        previous_tables_preserved: tables.length,
        all_bin_totals_match: true,
      }),
    );
  } else {
    const d = JSON.parse(await readFile(file, 'utf8'));
    await api('/auth/login', 'POST', { email: 'admin@demo.local', password: 'DynaDemo!2026' });
    if (phase === 'setup') {
      assert(!d.fixture);
      const org = await api('/workspaces', 'POST', {
        name: 'QA Lokalizacje 20261004',
        currency: 'PLN',
        locale: 'pl-PL',
      });
      tenant = org.user.tenant_id;
      await api('/workspaces/plan', 'PATCH', { plan: 'business' });
      const warehouse = (await api('/warehouses')).data[0];
      const product = await api('/products', 'POST', {
        sku: 'QA-LOC-MULTI',
        name: 'Towar w kilku lokalizacjach QA',
        price: 3000,
        warehouse_id: warehouse.id,
        quantity: 20,
        location: 'A-01',
      });
      d.fixture = {
        tenant_id: tenant,
        warehouse_id: warehouse.id,
        product_id: product.id,
        sku: product.sku,
      };
      await writeFile(file, JSON.stringify(d), { mode: 0o600 });
      console.log(JSON.stringify(d.fixture));
    } else {
      tenant = d.fixture.tenant_id;
      await api('/workspaces/switch', 'POST', { tenant_id: tenant });
      const f = d.fixture;
      if (phase === 'order') {
        assert(!f.order_id);
        const bins = (
          await api(
            '/stock-locations?warehouse_id=' + f.warehouse_id + '&product_id=' + f.product_id,
          )
        ).data;
        assert.deepEqual(
          bins.map((b: any) => [b.location, b.quantity]),
          [
            ['A-01', 12],
            ['B-02', 8],
          ],
        );
        const o = await api('/orders', 'POST', {
          warehouse_id: f.warehouse_id,
          customer_name: 'QA Skan lokalizacji',
          email: 'qa@example.test',
          address: { street: 'Testowa 1', postcode: '00-001', city: 'Warszawa', country: 'PL' },
          items: [{ product_id: f.product_id, quantity: 15 }],
        });
        await api('/orders/' + o.id + '/status', 'PATCH', { status: 'paid' });
        await api('/orders/' + o.id + '/status', 'PATCH', { status: 'picking' });
        f.order_id = o.id;
        f.number = o.number;
        await writeFile(file, JSON.stringify(d), { mode: 0o600 });
        console.log(JSON.stringify({ number: o.number, allocation: o.picking_items[0].locations }));
      } else if (phase === 'fulfill') {
        assert(!d.fulfilled);
        let o = await api('/orders/' + f.order_id);
        assert.equal(o.picking_items[0].scanned, 15);
        await api('/orders/' + o.id + '/status', 'PATCH', { status: 'packed' });
        await api('/orders/' + o.id + '/ship-demo', 'POST', {});
        await api('/orders/' + o.id + '/documents', 'POST', { kind: 'invoice' });
        const r = await api('/orders/' + o.id + '/returns', 'POST', {
          client_key: randomUUID(),
          reason: 'QA częściowy zwrot — trzy sprawne, dwa uszkodzone',
          shipping_refund: 0,
          items: [{ item_id: o.items[0].id, quantity: 5 }],
        });
        const received = await api('/returns/' + r.id + '/receive', 'POST', {
          version: Number(r.version),
          shipping_refund: 0,
          note: 'QA do sprzedaży trzy sztuki, dwie poza stanem',
          items: [{ item_id: o.items[0].id, accepted: 5, restocked: 3 }],
        });
        assert.equal(received.settlement_amount, 15000);
        await api('/returns/' + r.id + '/refund', 'POST', {
          version: Number(received.version),
          amount: 15000,
          reference: 'QA lokalne potwierdzenie rozliczenia',
          confirmed: true,
        });
        await api('/returns/' + r.id + '/document', 'POST', {});
        d.fulfilled = {
          demo_shipment: true,
          demo_invoice: true,
          partial_return_accepted: 5,
          restocked: 3,
          refund: 15000,
        };
        await writeFile(file, JSON.stringify(d), { mode: 0o600 });
      } else if (phase === 'capture') {
        assert(d.fulfilled);
        const o = await api('/orders/' + f.order_id),
          bins = (
            await api(
              '/stock-locations?warehouse_id=' + f.warehouse_id + '&product_id=' + f.product_id,
            )
          ).data;
        assert.deepEqual(
          bins.map((b: any) => [b.location, b.quantity, b.reserved]),
          [
            ['A-01', 0, 0],
            ['B-02', 5, 0],
            ['C-03', 3, 0],
            ['ZWROT', 1, 0],
          ],
        );
        const s = (
          await pool.query(
            'SELECT on_hand,reserved,version FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3',
            [tenant, f.warehouse_id, f.product_id],
          )
        ).rows[0];
        assert.equal(s.on_hand, 9);
        assert.equal(s.reserved, 0);
        for (const t of tables)
          assert.deepEqual(
            await fingerprint(t, d.tenants),
            d.before[t],
            t + ' previous rows changed',
          );
        const proof = {
          checked_at: new Date().toISOString(),
          environment: 'native localhost synthetic only',
          fixture: f,
          migration: d.migration,
          fulfillment: d.fulfilled,
          stock: s,
          bins,
          order: {
            number: o.number,
            status: o.status,
            payment: o.payment,
            picks: o.picking_items.map((i: any) => ({
              sku: i.sku,
              quantity: i.quantity,
              scanned: i.scanned,
              locations: i.locations,
            })),
            documents: o.documents.map((i: any) => ({
              kind: i.kind,
              mode: i.mode,
              total: i.data.total,
            })),
          },
          movements: (
            await api(
              '/stock-location-movements?warehouse_id=' +
                f.warehouse_id +
                '&product_id=' +
                f.product_id,
            )
          ).data,
          previous_rows_preserved: true,
        };
        await writeFile('docs/stock-locations-qa.json', JSON.stringify(proof, null, 2) + '\n');
        await writeFile(
          'docs/openapi.json',
          JSON.stringify(await api('/v1/openapi'), null, 2) + '\n',
        );
        console.log(
          JSON.stringify({
            stock: s,
            bins: bins.map((b: any) => [b.location, b.quantity]),
            previous_rows_preserved: true,
          }),
        );
      } else throw Error('Unknown phase');
    }
  }
} finally {
  await pool.end();
}
