// Native localhost only. Isolated synthetic QA organization, no provider writes.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool, migrate } from '../server/db';
const file = 'data/stocktake-stage029.json';
const tables = [
  'orders',
  'order_items',
  'order_pick_items',
  'products',
  'stock',
  'reservations',
  'stock_movements',
  'stock_locations',
  'reservation_locations',
  'stock_location_movements',
  'stock_location_operations',
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
  'automation_rules',
  'automation_runs',
  'automation_schedules',
  'automation_schedule_runs',
  'automation_schedule_items',
  'automation_schedule_receipts',
  'sms_templates',
  'sms_batches',
  'sms_messages',
  'order_batches',
  'order_batch_items',
];
async function fingerprint(table: string, tenants: string[]) {
  const rows = (
    await pool.query(
      `SELECT (to_jsonb(t)-'stocktake_id')::text AS row FROM ${table} t WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1`,
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
async function api(path: string, method = 'GET', body?: any) {
  const r = await fetch('http://127.0.0.1:4100/api' + path, {
    method,
    headers: {
      cookie,
      ...(tenant && !['/auth/login', '/workspaces', '/workspaces/switch'].includes(path)
        ? { 'x-workspace-id': tenant }
        : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
  assert(r.ok, path + ':' + r.status);
  return r.json();
}
try {
  const phase = process.argv[2];
  if (phase === 'migrate') {
    const tenants = (await pool.query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id),
      before: any = {};
    for (const t of tables) before[t] = await fingerprint(t, tenants);
    await migrate();
    for (const t of tables) assert.deepEqual(await fingerprint(t, tenants), before[t]);
    await writeFile(
      file,
      JSON.stringify({
        tenants,
        before,
        migration: {
          revision: '029_stocktakes',
          previous_business_tables_preserved: tables.length,
        },
      }),
      { mode: 0o600 },
    );
    console.log(
      JSON.stringify({
        migration: '029_stocktakes',
        previous_business_tables_preserved: tables.length,
      }),
    );
  } else {
    const d = JSON.parse(await readFile(file, 'utf8'));
    await api('/auth/login', 'POST', { email: 'admin@demo.local', password: 'DynaDemo!2026' });
    if (phase === 'setup') {
      assert(!d.fixture);
      const org = await api('/workspaces', 'POST', {
        name: 'QA Spis 20261004',
        currency: 'PLN',
        locale: 'pl-PL',
      });
      tenant = org.user.tenant_id;
      const w = (await api('/warehouses')).data[0];
      const p = await api('/products', 'POST', {
          sku: 'QA-SPIS-029-A',
          name: 'Towar dwóch lokalizacji',
          price: 1000,
          warehouse_id: w.id,
          quantity: 10,
          location: 'A-01',
        }),
        q = await api('/products', 'POST', {
          sku: 'QA-SPIS-029-C',
          name: 'Towar spisu C',
          price: 2000,
          warehouse_id: w.id,
          quantity: 20,
          location: 'C-01',
        });
      const bins = (await api('/stock-locations?warehouse_id=' + w.id + '&product_id=' + p.id))
        .data;
      await api('/stock-location-moves', 'POST', {
        warehouse_id: w.id,
        product_id: p.id,
        location: 'A-01',
        destination: 'B-02',
        quantity: 4,
        expected_version: bins[0].version,
        client_key: randomUUID(),
        note: 'QA rozłożenie przed spisem',
      });
      const order = await api('/orders', 'POST', {
        customer_name: 'QA rezerwacja spisu',
        email: 'stocktake@example.test',
        warehouse_id: w.id,
        address: { country: 'PL' },
        items: [{ product_id: p.id, quantity: 3 }],
      });
      d.fixture = {
        tenant_id: tenant,
        warehouse_id: w.id,
        products: [p.id, q.id],
        order_id: order.id,
      };
      await writeFile(file, JSON.stringify(d), { mode: 0o600 });
      console.log(JSON.stringify(d.fixture));
    } else if (phase === 'verify') {
      tenant = d.fixture.tenant_id;
      await api('/workspaces/switch', 'POST', { tenant_id: tenant });
      const list = (await api('/stocktakes')).data;
      assert.equal(list.length, 1);
      const st = await api('/stocktakes/' + list[0].id);
      assert.equal(st.state, 'posted');
      assert.equal(st.summary.total, 3);
      assert.equal(st.summary.counted, 3);
      assert.equal(st.summary.delta, -2);
      assert.equal(st.summary.conflicts, 0);
      const bins = (await api('/stock-locations?warehouse_id=' + d.fixture.warehouse_id)).data;
      assert.deepEqual(bins.map((b: any) => [b.location, b.quantity]).sort(), [
        ['A-01', 5],
        ['B-02', 5],
        ['C-01', 18],
      ]);
      assert.equal(
        bins.reduce((n: number, b: any) => n + b.reserved, 0),
        3,
      );
      const sm = (
          await pool.query(
            'SELECT product_id,delta FROM stock_movements WHERE stocktake_id=$1 ORDER BY product_id',
            [st.id],
          )
        ).rows,
        lm = (
          await pool.query(
            'SELECT product_id,location,delta FROM stock_location_movements WHERE stocktake_id=$1 ORDER BY product_id,location',
            [st.id],
          )
        ).rows;
      assert.equal(sm.length, 1);
      assert.equal(sm[0].delta, -2);
      assert.equal(lm.length, 3);
      const h = (await api('/stocktakes/' + st.id + '/measurements')).data;
      assert.equal(h.length, 1);
      assert.equal(h[0].inputs.length, 3);
      // Replay after posting is read-only.
      const replay = await api('/stocktakes/' + st.id + '/post', 'POST', {
        version: st.version,
        confirmed: true,
      });
      assert.equal(replay.id, st.id);
      assert.equal(
        (await pool.query('SELECT * FROM stock_location_movements WHERE stocktake_id=$1', [st.id]))
          .rowCount,
        3,
      );
      for (const t of tables)
        assert.deepEqual(
          await fingerprint(t, d.tenants),
          d.before[t],
          t + ' prior business fields changed',
        );
      const proof = {
        ...d.migration,
        fixture: d.fixture,
        stocktake: {
          id: st.id,
          name: st.name,
          state: st.state,
          summary: st.summary,
          lines: st.lines.map((l: any) => ({
            id: l.id,
            sku: l.sku,
            location: l.location,
            basis: l.basis_quantity,
            counted: l.counted,
            difference: l.difference,
          })),
        },
        bins: bins.map((b: any) => ({
          sku: b.sku,
          location: b.location,
          quantity: b.quantity,
          reserved: b.reserved,
        })),
        warehouse_movements: sm,
        location_movements: lm,
        measurements: h.length,
        posting_replay_no_duplicates: true,
        previous_business_fields_preserved: true,
        external_writes: 0,
      };
      await writeFile('docs/stocktake-qa.json', JSON.stringify(proof, null, 2) + '\n');
      await writeFile(
        'docs/openapi.json',
        JSON.stringify(await api('/developer/openapi'), null, 2) + '\n',
      );
      console.log(JSON.stringify(proof));
    } else throw new Error('Unknown phase');
  }
} finally {
  await pool.end();
}
