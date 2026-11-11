// Synthetic local QA only; never contacts Amazon or moves money.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
import { demoAmazonOrder } from '../server/amazon-example';
const file = 'data/amazon-stage073.json',
  phase = process.argv[2];
const tables = [
  'products',
  'stock',
  'orders',
  'order_items',
  'reservations',
  'documents',
  'shipments',
  'return_cases',
  'return_items',
  'payment_entries',
  'listings',
];
let cookie = '';
async function api(path: string, method = 'GET', payload?: any, status = 200) {
  const r = await fetch('http://127.0.0.1:4100/api' + path, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(payload ? { 'content-type': 'application/json' } : {}),
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  const text = await r.text();
  assert.equal(r.status, status, path + ':' + text);
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
  return JSON.parse(text);
}
async function fingerprints(tenants: string[]) {
  const r: any = {};
  for (const table of tables) {
    const rows = (
      await pool.query(
        `SELECT to_jsonb(t)::text row FROM ${table} t WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1`,
        [tenants],
      )
    ).rows;
    r[table] = {
      count: rows.length,
      sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
    };
  }
  return r;
}
try {
  if (phase === 'baseline') {
    const tenants = (await pool.query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id);
    await writeFile(
      file,
      JSON.stringify(
        { tenants, before: await fingerprints(tenants), baseline_at: new Date().toISOString() },
        null,
        2,
      ) + '\n',
      { mode: 0o600, flag: 'wx' },
    );
    console.log({ tenants: tenants.length, tables: tables.length });
  } else {
    const state = JSON.parse(await readFile(file, 'utf8'));
    const save = () => writeFile(file, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    if (phase === 'setup') {
      assert(!state.fixture);
      const email = 'qa-amazon@demo.local',
        password = 'DynaAmazon!2026';
      const signed = await api(
        '/auth/signup',
        'POST',
        {
          email,
          password,
          name: 'QA Amazon 073',
          organization: { name: 'QA Amazon 073', currency: 'PLN', locale: 'pl-PL' },
        },
        201,
      );
      const f: any = (state.fixture = {
        email,
        password,
        user: signed.user.id,
        tenant: signed.user.tenant_id,
      });
      await save();
      f.warehouse = (await api('/warehouses')).data[0].id;
      const p = await api(
        '/products',
        'POST',
        {
          sku: 'QA-AMAZON-073',
          name: 'Produkt kontrolny Amazon',
          price: 12345,
          vat: 23,
          quantity: 10,
          warehouse_id: f.warehouse,
        },
        201,
      );
      f.product = p.id;
      f.sku = p.sku;
      await save();
      const ex = await api('/integrations/amazon-example', 'POST', {});
      f.channel = ex.channel_id;
      await save();
      await api('/integrations/' + f.channel + '/mappings', 'POST', {
        external_id: 'AMAZON-DEMO-SKU',
        sku: f.sku,
      });
      const row = (await api('/integrations/' + f.channel + '/imports')).data[0];
      f.inbound = row.id;
      f.hash = row.source_hash;
      assert.equal(row.normalized.email, '');
      assert.equal(row.normalized.paid_amount, 0);
      const o = await api('/imports/' + f.inbound + '/commit', 'POST', {
        warehouse_id: f.warehouse,
        expected_hash: f.hash,
      });
      f.order = o.id;
      f.number = o.number;
      await save();
      assert.equal(o.total, 24690);
      assert.equal(o.status, 'new');
      assert.equal(o.email, '');
      assert.equal(o.items[0].quantity, 2);
      assert.equal((await api('/orders/' + o.id + '/payments')).data.length, 0);
      const retry = await api('/imports/' + f.inbound + '/commit', 'POST', {
        warehouse_id: f.warehouse,
        expected_hash: f.hash,
      });
      assert.equal(retry.id, o.id);
      console.log({
        scope: 'local_simulation',
        tenant: f.tenant,
        order: o.number,
        total: o.total,
        reserved: 2,
        email_missing_preserved: true,
        source_receipts: 0,
      });
    } else {
      const f = state.fixture;
      await api('/auth/login', 'POST', { email: f.email, password: f.password });
      if (phase === 'ui-stage') {
        const raw = demoAmazonOrder();
        raw.id = raw.orderId = '123-1234567-7654321';
        const staged = await api('/integrations/' + f.channel + '/stage-orders', 'POST', {
          data: [raw],
        });
        f.ui_inbound = staged.data[0].id;
        await save();
        console.log({ ui_inbound: f.ui_inbound });
      } else if (phase === 'ui-cleanup') {
        const row = (await api('/integrations/' + f.channel + '/imports')).data.find(
          (r: any) => r.id === f.ui_inbound,
        );
        assert(row.order_id);
        const o = await api('/orders/' + row.order_id);
        assert.equal(o.total, 24690);
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int n FROM payment_entries WHERE order_id=$1 AND method='source_import'",
              [o.id],
            )
          ).rows[0].n,
          0,
        );
        assert.equal(
          (await pool.query('SELECT price FROM products WHERE id=$1', [f.product])).rows[0].price,
          12345,
        );
        assert.equal(o.email, '');
        assert.equal(o.status, 'new');
        assert.equal(
          (await pool.query('SELECT reserved FROM stock WHERE product_id=$1', [f.product])).rows[0]
            .reserved,
          2,
        );
        await api('/orders/' + o.id + '/status', 'PATCH', { status: 'cancelled' });
        f.ui_order = o.id;
        await save();
        console.log({
          ui_import_verified: true,
          local_reservation: 2,
          qa_order_cancelled_locally: true,
        });
      } else if (phase === 'fulfill') {
        let o = await api('/orders/' + f.order);
        assert.equal(o.status, 'new');
        const pay = await api('/orders/' + o.id + '/payments');
        await api('/orders/' + o.id + '/payments', 'POST', {
          client_key: randomUUID(),
          version: o.version,
          kind: 'receipt',
          amount: o.total,
          currency: o.currency,
          method: 'other',
          reference: 'QA-AMAZON-073-BEZ-PLATNOSCI',
          note: 'Wyłącznie syntetyczna deklaracja w firmie QA; bez przelewu',
          confirmed: true,
        });
        assert.equal((await api('/orders/' + o.id)).status, 'paid');
        await api('/orders/' + o.id + '/status', 'PATCH', { status: 'picking' });
        for (let n = 0; n < 2; n++) await api('/orders/' + o.id + '/scan', 'POST', { code: f.sku });
        await api('/orders/' + o.id + '/status', 'PATCH', { status: 'packed' });
        await api('/orders/' + o.id + '/ship-demo', 'POST', {});
        const doc = await api('/orders/' + o.id + '/documents', 'POST', { kind: 'invoice' });
        f.document = doc.id;
        await save();
        o = await api('/orders/' + o.id);
        assert.equal(o.status, 'shipped');
        const r = await api(
          '/orders/' + o.id + '/returns',
          'POST',
          {
            client_key: randomUUID(),
            reason: 'QA Amazon 073 — zwrot lokalny',
            shipping_refund: o.shipping_cost,
            items: o.items.map((i: any) => ({ item_id: i.id, quantity: i.quantity })),
          },
          201,
        );
        f.return_id = r.id;
        await save();
        await api('/returns/' + r.id + '/receive', 'POST', {
          version: r.version,
          shipping_refund: o.shipping_cost,
          note: 'QA przyjęcie lokalne',
          items: r.items.map((i: any) => ({
            item_id: i.item_id,
            accepted: i.requested,
            restocked: i.requested,
          })),
        });
        await api('/returns/' + r.id + '/document', 'POST', {});
        const received = await api('/returns/' + r.id);
        await api('/returns/' + r.id + '/refund', 'POST', {
          version: received.version,
          amount: o.total,
          reference: 'QA-AMAZON-073-BEZ-PRZELEWU',
          confirmed: true,
        });
        console.log({ full_demo_process: true, external_writes: 0, real_money_moved: 0 });
      } else if (phase === 'verify') {
        const o = await api('/orders/' + f.order),
          r = await api('/returns/' + f.return_id),
          stock = (
            await pool.query('SELECT * FROM stock WHERE tenant_id=$1 AND product_id=$2', [
              f.tenant,
              f.product,
            ])
          ).rows[0];
        assert.equal(o.status, 'return_completed');
        assert.equal(o.total, 24690);
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int n FROM payment_entries WHERE order_id=$1 AND method='source_import'",
              [o.id],
            )
          ).rows[0].n,
          0,
        );
        assert.equal(
          (await pool.query('SELECT price FROM products WHERE id=$1', [f.product])).rows[0].price,
          12345,
        );
        assert.equal(o.email, '');
        assert.equal(r.state, 'closed');
        assert.equal(r.refund_amount, 24690);
        assert.equal(stock.on_hand, 10);
        assert.equal(stock.reserved, 0);
        assert(r.items.every((i: any) => i.accepted === 2 && i.restocked === 2));
        assert.deepEqual(await fingerprints(state.tenants), state.before);
        const health = await api('/health');
        const report = {
          stage: 73,
          goal_complete: false,
          revision: health.revision,
          schema_revision: health.schema_revision,
          verified_at: new Date().toISOString(),
          scope: 'native_local_http_and_database_synthetic_example',
          tenant: f.tenant,
          order: o.number,
          total_minor: o.total,
          source_email: '',
          source_receipts: 0,
          local_demo_receipt_and_refund: 24690,
          final_status: o.status,
          final_stock: { quantity: stock.on_hand, reserved: stock.reserved },
          prior_tenants_preserved: state.tenants.length,
          prior_business_tables_unchanged: tables.length,
          external_writes: 0,
          real_money_moved: 0,
          authenticated_amazon_api_verified: false,
          steps: [
            'example',
            'sku_mapping',
            'import',
            'idempotent_replay',
            'local_demo_payment',
            'pick',
            'scan_two_units',
            'pack',
            'demo_shipment',
            'invoice',
            'return',
            'restock',
            'local_demo_refund',
          ],
        };
        await writeFile('docs/amazon-native-qa.json', JSON.stringify(report, null, 2) + '\n');
        console.log(report);
      }
    }
  }
} finally {
  await pool.end();
}
