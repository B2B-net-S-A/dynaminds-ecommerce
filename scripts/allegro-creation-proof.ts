// Only this synthetic organization is mutated; external provider HTTP is never used.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
const file = 'data/allegro-creation-stage042.json',
  email = 'qa-allegro-create@demo.local',
  password = 'DynaDemo!2026';
const tables = [
  ...Object.keys(
    JSON.parse(await readFile('data/repricing-schedules-stage041.json', 'utf8')).before,
  ),
  'repricing_schedules',
  'repricing_runs',
];
let state: any,
  cookie = '';
async function fingerprints(tenants: string[]) {
  const out: any = {};
  for (const table of tables) {
    assert(/^[a-z_]+$/.test(table));
    const rows = (
      await pool.query(
        'SELECT to_jsonb(t)::text row FROM ' +
          table +
          ' t WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1',
        [tenants],
      )
    ).rows;
    out[table] = {
      count: rows.length,
      sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
    };
  }
  return out;
}
async function api(path: string, method = 'GET', body?: any, status = 200) {
  const r = await fetch('http://127.0.0.1:4100/api' + path, {
    method,
    headers: {
      cookie,
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(path === '/orders' ? { 'idempotency-key': randomUUID() } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
  const d = await r.json();
  assert.equal(r.status, status, path + ': ' + JSON.stringify(d));
  return d;
}
const save = () => writeFile(file, JSON.stringify(state), { mode: 0o600 });
try {
  const phase = process.argv[2];
  if (phase === 'baseline') {
    const tenants = (await pool.query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id);
    state = { tenants, before: await fingerprints(tenants) };
    await save();
    console.log(JSON.stringify({ old_tenants: tenants.length, business_tables: tables.length }));
  } else {
    state = JSON.parse(await readFile(file, 'utf8'));
    if (phase === 'setup' && !state.fixture) {
      await api(
        '/auth/signup',
        'POST',
        {
          email,
          password,
          name: 'QA Nowe oferty Allegro',
          organization: { name: 'QA Nowe oferty Allegro 20261004' },
        },
        201,
      );
      state.fixture = { tenant: (await api('/auth/me')).user.tenant_id };
      await save();
    } else await api('/auth/login', 'POST', { email, password });
    const f = state.fixture;
    if (phase === 'setup') {
      assert(!f.product, 'Fixture już istnieje; użyj kolejnego etapu zamiast ponownego setupu');
      await api('/workspaces/plan', 'PATCH', { plan: 'enterprise' });
      f.warehouse = (await api('/warehouses')).data[0].id;
      f.channel = (await api('/integrations/allegro-example', 'POST', {})).channel_id;
      f.product = await api(
        '/products',
        'POST',
        {
          sku: 'AL-NEW-1',
          name: 'Lampa biurkowa demonstracyjna QA',
          price: 12300,
          vat: 23,
          quantity: 12,
          warehouse_id: f.warehouse,
        },
        201,
      );
      f.old_order = await api(
        '/orders',
        'POST',
        {
          customer_name: 'QA wcześniejsza rezerwacja',
          email: 'buyer-before@example.test',
          warehouse_id: f.warehouse,
          items: [{ product_id: f.product.id, quantity: 2 }],
        },
        201,
      );
      await save();
      console.log(
        JSON.stringify({
          tenant: f.tenant,
          channel: f.channel,
          product: f.product.id,
          available: 10,
        }),
      );
    }
    if (phase === 'reserve') {
      assert(!f.order, 'Zamówienie rezerwacji już istnieje');
      const plans = (await api('/integrations/' + f.channel + '/offers')).data;
      assert.equal(plans.length, 2);
      assert(plans.every((p: any) => p.state === 'done'));
      f.order = await api(
        '/orders',
        'POST',
        {
          customer_name: 'QA nowa oferta Allegro',
          email: 'buyer-after@example.test',
          warehouse_id: f.warehouse,
          items: [{ product_id: f.product.id, quantity: 3 }],
        },
        201,
      );
      await save();
      console.log(JSON.stringify({ order: f.order.id, total: f.order.total, available: 7 }));
    }
    if (phase === 'fulfill') {
      const plans = (await api('/integrations/' + f.channel + '/offers')).data;
      assert.equal(plans.length, 3);
      assert(plans.every((p: any) => p.state === 'done'));
      const current = await api('/orders/' + f.order.id);
      if (current.status === 'new') {
        await api('/orders/' + f.old_order.id + '/status', 'PATCH', { status: 'cancelled' });
        await api('/orders/' + f.order.id + '/status', 'PATCH', { status: 'paid' });
        await api('/orders/' + f.order.id + '/status', 'PATCH', { status: 'picking' });
        for (let n = 0; n < 3; n++)
          await api('/orders/' + f.order.id + '/scan', 'POST', { code: f.product.sku });
        await api('/orders/' + f.order.id + '/status', 'PATCH', { status: 'packed' });
        await api('/orders/' + f.order.id + '/ship-demo', 'POST', {});
        await api('/orders/' + f.order.id + '/documents', 'POST', { kind: 'invoice' });
      }
      const o = await api('/orders/' + f.order.id);
      const existing = (
        await pool.query('SELECT id FROM return_cases WHERE tenant_id=$1 AND order_id=$2', [
          f.tenant,
          o.id,
        ])
      ).rows;
      assert(existing.length <= 1);
      let r = existing.length
        ? await api('/returns/' + existing[0].id)
        : await api(
            '/orders/' + o.id + '/returns',
            'POST',
            {
              client_key: randomUUID(),
              reason: 'QA nowa oferta — lokalny zwrot',
              shipping_refund: o.shipping_cost,
              items: o.items.map((i: any) => ({ item_id: i.id, quantity: i.quantity })),
            },
            201,
          );
      if (r.state === 'requested') {
        r = await api('/returns/' + r.id + '/receive', 'POST', {
          version: r.version,
          shipping_refund: o.shipping_cost,
          note: 'QA lokalne przyjęcie',
          items: r.items.map((i: any) => ({
            item_id: i.item_id,
            accepted: i.requested,
            restocked: i.requested,
          })),
        });
      }
      await api('/returns/' + r.id + '/document', 'POST', {});
      r = await api('/returns/' + r.id);
      if (r.state !== 'closed') {
        await api('/returns/' + r.id + '/refund', 'POST', {
          version: r.version,
          amount: o.total,
          reference: 'QA-BEZ-PRZELEWU-ALLEGRO-042',
          confirmed: true,
        });
      }
      f.return_id = r.id;
      await save();
      console.log(JSON.stringify({ demo_fulfillment_return: 1, available: 12, real_payments: 0 }));
    }
    if (phase === 'verify' || phase === 'runtime') {
      const plans = (await api('/integrations/' + f.channel + '/offers')).data;
      assert.equal(plans.length, 4);
      assert(
        plans.every(
          (p: any) =>
            p.state === 'done' && p.result.scope === 'local_simulation' && p.result.desired_applied,
        ),
      );
      const created = plans.find((p: any) => p.operation === 'create_draft');
      assert.equal(created.payload.stock.available, 10);
      assert.equal(created.payload.sellingMode.price.amount, '123.00');
      assert.equal(created.payload.publication.status, 'INACTIVE');
      assert.equal(
        plans.find((p: any) => p.operation === 'publish').payload.publication.status,
        'ACTIVE',
      );
      assert.deepEqual(
        plans
          .filter((p: any) => p.operation === 'sync')
          .map((p: any) => p.payload.stock.available)
          .sort((a: number, b: number) => a - b),
        [7, 12],
      );
      const listing = (await api('/integrations/' + f.channel + '/offer-listings')).data;
      assert.equal(listing.length, 1);
      assert.equal(listing[0].last_result.stock_quantity, 12);
      assert.equal(listing[0].last_result.status, 'ACTIVE');
      const stock = (
        await pool.query(
          'SELECT on_hand,reserved FROM stock WHERE tenant_id=$1 AND product_id=$2',
          [f.tenant, f.product.id],
        )
      ).rows[0];
      assert.deepEqual(stock, { on_hand: 12, reserved: 0 });
      const order = await api('/orders/' + f.order.id);
      assert.equal(order.total, 36900);
      assert.equal(order.status, 'return_completed');
      assert(order.documents.every((d: any) => d.mode === 'demo'));
      assert.equal(order.documents.length, 2);
      const returned = await api('/returns/' + f.return_id);
      assert.equal(returned.state, 'closed');
      assert.equal(returned.refund_amount, order.total);
      assert(returned.items.every((i: any) => i.accepted === 3 && i.restocked === 3));
      assert.equal((await api('/orders/' + f.old_order.id)).total, f.old_order.total);
      assert.deepEqual(await fingerprints(state.tenants), state.before);
      const h = await api('/health'),
        proof = {
          checked_at: new Date().toISOString(),
          scope: 'native_local_worker_chrome_synthetic',
          browser_steps: [
            'create_draft',
            'publish',
            'sync_reserved_quantity',
            'sync_returned_quantity',
          ],
          native_api_steps: ['fixtures', 'order_reservation', 'fulfillment_demo', 'return_demo'],
          schema_revision: h.schema_revision,
          runtime_revision: h.revision,
          old_tenants_preserved: state.tenants.length,
          business_tables_unchanged: tables.length,
          offer_plans: 4,
          listing_count: 1,
          created_quantity: 10,
          reservation_sync_quantity: 7,
          final_quantity: 12,
          final_stock: stock,
          price: 12300,
          new_order_total: 36900,
          old_order_unchanged: true,
          order_status: order.status,
          demo_documents: 2,
          provider_requests: 0,
          real_payments: 0,
        };
      await writeFile(
        phase === 'runtime'
          ? 'data/allegro-creation-stage042-runtime.json'
          : 'docs/allegro-creation-qa.json',
        JSON.stringify(proof, null, 2) + '\n',
      );
      console.log(JSON.stringify(proof));
    }
  }
} finally {
  await pool.end();
}
