// Native localhost / synthetic QA. Private links and credentials stay out of evidence.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool, migrate } from '../server/db';
const file = 'data/source-payments-stage024.json';
const tables = [
  'orders',
  'order_items',
  'products',
  'stock',
  'documents',
  'listings',
  'offer_plans',
  'variant_offer_batches',
  'shipping_plans',
  'shipments',
  'warehouse_documents',
  'warehouse_document_lines',
  'suppliers',
  'purchase_orders',
  'purchase_order_lines',
  'purchase_receipts',
  'purchase_receipt_lines',
  'stock_movements',
  'reservations',
  'return_cases',
  'return_items',
  'variant_offer_batch_items',
  'order_status_plans',
  'order_status_simulations',
  'payment_entries',
];
async function fingerprint(table: string, tenants: string[]) {
  const rows = (
    await pool.query(
      `SELECT to_jsonb(t)::text AS line FROM ${table} t WHERE tenant_id=ANY($1::uuid[]) ORDER BY line`,
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
async function response(p: string, m = 'GET', body?: any, token?: string) {
  return fetch('http://127.0.0.1:4100/api' + p, {
    method: m,
    headers: {
      ...(token
        ? { authorization: 'Bearer ' + token }
        : {
            cookie,
            ...(tenant && !['/auth/login', '/workspaces', '/workspaces/switch'].includes(p)
              ? { 'x-workspace-id': tenant }
              : {}),
          }),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function api(p: string, m = 'GET', body?: any) {
  const r = await response(p, m, body);
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
  assert(r.ok, m + ' ' + p + ': ' + r.status);
  return r.json();
}
try {
  const phase = process.argv[2];
  if (phase === 'migrate') {
    const tenants = (await pool.query('SELECT id FROM tenants ORDER BY id')).rows.map((x) => x.id),
      before: Record<string, any> = {};
    for (const t of tables) before[t] = await fingerprint(t, tenants);
    await writeFile(file, JSON.stringify({ tenants, before }), { mode: 0o600 });
    await migrate();
    for (const t of tables)
      assert.deepEqual(await fingerprint(t, tenants), before[t], t + ' previous rows modified');
    const d = {
      tenants,
      before,
      migration: {
        previous_tables_preserved: tables.length,
        new_tables: 2,
        prior_payment_entries: before.payment_entries.count,
      },
    };
    await writeFile(file, JSON.stringify(d), { mode: 0o600 });
    console.log(JSON.stringify(d.migration));
  } else {
    const d = JSON.parse(await readFile(file, 'utf8'));
    await api('/auth/login', 'POST', { email: 'admin@demo.local', password: 'DynaDemo!2026' });
    if (phase === 'setup') {
      assert(!d.fixture);
      const org = await api('/workspaces', 'POST', {
        name: 'QA Dopłaty 20261004',
        currency: 'PLN',
        locale: 'pl-PL',
      });
      tenant = org.user.tenant_id;
      await api('/workspaces/plan', 'PATCH', { plan: 'business' });
      const warehouse = (await api('/warehouses')).data[0];
      d.fixture = { tenant_id: tenant, warehouse_id: warehouse.id, orders: [] };
      await writeFile(file, JSON.stringify(d), { mode: 0o600 });
      for (const provider of ['woocommerce', 'allegro', 'prestashop']) {
        const ex = await api(
          '/integrations/' +
            (provider === 'woocommerce'
              ? 'demo-import'
              : provider === 'allegro'
                ? 'allegro-example'
                : 'prestashop-example'),
          'POST',
          {},
        );
        const raw = (
          await pool.query('SELECT raw FROM inbound_orders WHERE id=$1', [ex.data[0].id])
        ).rows[0].raw;
        if (provider === 'woocommerce') {
          raw.date_paid = null;
          raw.status = 'on-hold';
        } else if (provider === 'allegro') {
          raw.payment = {
            ...raw.payment,
            type: 'ONLINE',
            paidAmount: { amount: '20.00', currency: 'PLN' },
          };
          raw.surcharges = [];
        } else {
          raw.total_paid_real = '0.000000';
          raw._dyna.state.paid = '0';
        }
        const p = await api('/products', 'POST', {
          sku: 'QA-LATE-' + provider.toUpperCase(),
          name: 'Dopłaty ' + provider + ' QA',
          price: 10000,
          quantity: 20,
          warehouse_id: warehouse.id,
        });
        await api('/integrations/' + ex.channel_id + '/mappings', 'POST', {
          external_id:
            provider === 'allegro' ? 'demo-offer-1' : provider === 'prestashop' ? '701:0' : '701',
          sku: p.sku,
        });
        const staged = (
          await api('/integrations/' + ex.channel_id + '/stage-orders', 'POST', { data: [raw] })
        ).data[0];
        const o = await api('/imports/' + staged.id + '/commit', 'POST', {
          warehouse_id: warehouse.id,
        });
        assert.equal(o.status, 'new');
        assert.equal(o.payment.received, provider === 'allegro' ? 2000 : 0);
        d.fixture.orders.push({
          provider,
          order_id: o.id,
          number: o.number,
          total: o.total,
          channel_id: ex.channel_id,
          product_id: p.id,
          sku: p.sku,
        });
        await writeFile(file, JSON.stringify(d), { mode: 0o600 });
      }
      console.log(
        JSON.stringify({
          tenant_id: tenant,
          orders: d.fixture.orders,
          scope: 'local_synthetic_only',
        }),
      );
    } else {
      tenant = d.fixture.tenant_id;
      await api('/workspaces/switch', 'POST', { tenant_id: tenant });
      if (phase === 'aux') {
        assert(!d.aux);
        for (const f of d.fixture.orders) {
          let o = await api('/orders/' + f.order_id);
          assert.equal(o.payment.amount_due, 0);
          assert.equal(o.status, 'paid');
          await api('/orders/' + o.id + '/status', 'PATCH', { status: 'picking' });
          for (const i of o.picking_items)
            for (let n = 0; n < i.quantity; n++)
              await api('/orders/' + o.id + '/scan', 'POST', { code: i.sku });
          await api('/orders/' + o.id + '/status', 'PATCH', { status: 'packed' });
          await api('/orders/' + o.id + '/ship-demo', 'POST', {});
          await api('/orders/' + o.id + '/documents', 'POST', { kind: 'invoice' });
          if (f.provider === 'prestashop') {
            const r = await api('/orders/' + o.id + '/returns', 'POST', {
              client_key: randomUUID(),
              reason: 'QA pełny zwrot po dopłacie źródłowej',
              shipping_refund: o.shipping_cost,
              items: o.items.map((i: any) => ({ item_id: i.id, quantity: i.quantity })),
            });
            const received = await api('/returns/' + r.id + '/receive', 'POST', {
              version: Number(r.version),
              shipping_refund: o.shipping_cost,
              note: 'QA cały towar sprawny',
              items: o.items.map((i: any) => ({
                item_id: i.id,
                accepted: i.quantity,
                restocked: i.quantity,
              })),
            });
            assert.equal(received.settlement_amount, o.total);
            await api('/returns/' + r.id + '/refund', 'POST', {
              version: Number(received.version),
              amount: o.total,
              reference: 'QA DEMO zwrot środków po dopłacie',
              confirmed: true,
            });
            await api('/returns/' + r.id + '/document', 'POST', {});
            await api('/orders/' + o.id + '/source-payments/read', 'POST', {});
            // Wait on the specific native queue until its current authoritative state is terminal.
            let finished = false;
            for (let n = 0; n < 30; n++) {
              const h = await api('/orders/' + o.id + '/source-payments');
              if (h.job?.state === 'done') {
                assert.equal(h.data[0].state, 'unchanged');
                finished = true;
                break;
              }
              assert(h.job?.state !== 'failed');
              await new Promise((r) => setTimeout(r, 500));
            }
            assert(finished, 'Native source-payment job did not finish within 15 seconds');
          }
        }
        const f = d.fixture.orders[0],
          key = await api('/developer/keys', 'POST', {
            name: 'QA source read-only',
            scopes: ['orders:read'],
          });
        const r = await response(
          '/v1/orders/' + f.order_id + '/source-payments/read',
          'POST',
          {},
          key.token,
        );
        assert.equal(r.status, 403);
        await api('/developer/keys/' + key.id, 'DELETE');
        d.aux = {
          all_fulfilled_demo: true,
          presta_full_return_demo: true,
          post_refund_source_unchanged: true,
          public_api_read_only_status: r.status,
          api_keys_revoked: true,
        };
        await writeFile(file, JSON.stringify(d), { mode: 0o600 });
      } else if (phase === 'capture') {
        const orders = [];
        for (const f of d.fixture.orders) {
          const o = await api('/orders/' + f.order_id),
            h = await api('/orders/' + o.id + '/source-payments'),
            ledger = await api('/orders/' + o.id + '/payments');
          assert.equal(o.payment.received, o.total);
          assert.equal(o.payment.amount_due, 0);
          assert.equal(h.totals.amount, o.total);
          const cfg = (await api('/integrations/' + f.channel_id + '/payment-sync')).config;
          assert(!cfg?.enabled, 'Leave native QA schedules paused');
          const stock = (
            await pool.query(
              'SELECT on_hand,reserved FROM stock WHERE tenant_id=$1 AND product_id=$2 AND warehouse_id=$3',
              [tenant, f.product_id, d.fixture.warehouse_id],
            )
          ).rows[0];
          orders.push({
            provider: f.provider,
            id: o.id,
            number: o.number,
            status: o.status,
            payment: o.payment,
            source_totals: h.totals,
            checks: h.data,
            entries: ledger.data.map((p: any) => ({
              id: p.id,
              kind: p.kind,
              amount: p.amount,
              method: p.method,
            })),
            stock,
            documents: o.documents.map((p: any) => ({
              id: p.id,
              kind: p.kind,
              mode: p.mode,
              total: p.data.total,
            })),
          });
        }
        for (const t of tables)
          assert.deepEqual(
            await fingerprint(t, d.tenants),
            d.before[t],
            t + ' previous rows modified by QA',
          );
        const proof = {
          checked_at: new Date().toISOString(),
          environment: 'native localhost / synthetic only',
          tenant_id: tenant,
          migration: d.migration,
          aux: d.aux,
          orders,
          prior_rows_preserved: true,
        };
        await writeFile('docs/source-payments-qa.json', JSON.stringify(proof, null, 2) + '\n');
        await writeFile(
          'docs/openapi.json',
          JSON.stringify(await api('/v1/openapi'), null, 2) + '\n',
        );
        console.log(
          JSON.stringify({
            orders: orders.map((o) => ({
              number: o.number,
              status: o.status,
              payment: o.payment,
              stock: o.stock,
            })),
            previous_tables_preserved: tables.length,
          }),
        );
      } else throw Error('Unknown phase');
    }
  }
} finally {
  await pool.end();
}
