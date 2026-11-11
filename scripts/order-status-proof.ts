// Local native-runtime evidence. Business snapshots stay in ignored data/; no cookies or customer fields are printed.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
const path = 'data/order-status-stage022.json',
  d = JSON.parse(await readFile(path, 'utf8')),
  phase = process.argv[2];
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
async function previous() {
  for (const [t, rows] of Object.entries(d.before)) {
    const current = (
      await pool.query(
        `SELECT to_jsonb(t) row FROM ${t} t WHERE ($1::uuid IS NULL OR tenant_id<>$1) ORDER BY to_jsonb(t)::text`,
        [d.fixture?.tenant_id ?? null],
      )
    ).rows.map((r) => r.row);
    assert.deepEqual(current, rows, t);
  }
  return true;
}
const save = () => writeFile(path, JSON.stringify(d, null, 2));
try {
  assert.equal((await api('/health')).schema_revision, '022_order_status');
  if (phase === 'migrated') {
    d.migration = {
      previous_business_rows_unchanged: await previous(),
      business_tables: Object.keys(d.before).length,
    };
    await save();
    console.log(JSON.stringify(d.migration));
  }
  if (phase === 'setup') {
    assert(!d.fixture);
    assert.equal(
      (await pool.query("SELECT id FROM tenants WHERE name='QA Statusy 20261004'")).rowCount,
      0,
    );
    await api('/auth/login', 'POST', { email: 'admin@demo.local', password: 'DynaDemo!2026' });
    const org = await api('/workspaces', 'POST', {
        name: 'QA Statusy 20261004',
        currency: 'PLN',
        locale: 'pl-PL',
      }),
      wh = (await api('/warehouses')).data[0];
    d.fixture = { tenant_id: org.user.tenant_id, warehouse_id: wh.id, channels: [] };
    await save();
    for (const provider of ['woocommerce', 'allegro']) {
      const p = await api('/products', 'POST', {
        sku: provider === 'allegro' ? 'QA-STATUS-ALLEGRO' : 'QA-STATUS-WOO',
        name:
          provider === 'allegro'
            ? 'Produkt Allegro · status QA'
            : 'Produkt WooCommerce · status QA',
        quantity: 10,
        price: 1000,
        warehouse_id: wh.id,
      });
      const example = await api(
        '/integrations/' + (provider === 'allegro' ? 'allegro-example' : 'demo-import'),
        'POST',
        {},
      );
      await api('/integrations/' + example.channel_id + '/mappings', 'POST', {
        external_id: provider === 'allegro' ? 'demo-offer-1' : '701',
        sku: p.sku,
      });
      d.fixture.channels.push({
        provider,
        channel_id: example.channel_id,
        product_id: p.id,
        sku: p.sku,
        inbound_id: example.data[0].id,
      });
      await save();
    }
    console.log(JSON.stringify(d.fixture));
  }
  if (phase === 'capture') {
    for (const ch of d.fixture.channels) {
      const row = (
        await pool.query(
          'SELECT id,number,status FROM orders WHERE tenant_id=$1 AND channel_id=$2',
          [d.fixture.tenant_id, ch.channel_id],
        )
      ).rows[0];
      assert(row);
      ch.order_id = row.id;
      ch.number = row.number;
    }
    await save();
    console.log(JSON.stringify(d.fixture.channels));
  }
  if (phase === 'fulfill') {
    await api('/auth/login', 'POST', { email: 'admin@demo.local', password: 'DynaDemo!2026' });
    await api('/workspaces/switch', 'POST', { tenant_id: d.fixture.tenant_id });
    for (const ch of d.fixture.channels) {
      const o = await api('/orders/' + ch.order_id);
      if (o.status === 'paid') {
        await api('/orders/' + o.id + '/status', 'PATCH', { status: 'picking' });
        for (let n = 0; n < 3; n++)
          await api('/orders/' + o.id + '/scan', 'POST', { code: ch.sku });
        await api('/orders/' + o.id + '/status', 'PATCH', { status: 'packed' });
      }
    }
    console.log('Oba zamówienia są spakowane; oczekują wysyłki DEMO w UI.');
  }
  if (phase === 'final') {
    const f = d.fixture;
    const orders = (
      await pool.query('SELECT id,number,status,total FROM orders WHERE tenant_id=$1 ORDER BY id', [
        f.tenant_id,
      ])
    ).rows;
    assert(orders.every((o) => o.status === 'shipped'));
    assert.equal(orders.length, 2);
    const plans = (
      await pool.query(
        'SELECT p.id,p.order_id,p.local_status,p.target,p.state,p.phase,p.config_version,p.result,p.error FROM order_status_plans p WHERE tenant_id=$1 ORDER BY created_at,id',
        [f.tenant_id],
      )
    ).rows;
    for (const ch of f.channels) {
      const sim = (
        await pool.query(
          'SELECT status,revision FROM order_status_simulations WHERE tenant_id=$1 AND order_id=$2',
          [f.tenant_id, ch.order_id],
        )
      ).rows[0];
      assert.equal(sim.status, ch.provider === 'allegro' ? 'SENT' : 'completed');
      assert(
        plans.some(
          (p) => p.order_id === ch.order_id && p.local_status === 'shipped' && p.state === 'done',
        ),
      );
    }
    const stock = (
      await pool.query(
        'SELECT product_id,on_hand,reserved,available FROM stock WHERE tenant_id=$1 ORDER BY product_id',
        [f.tenant_id],
      )
    ).rows;
    assert(stock.every((s) => s.on_hand === 7 && s.reserved === 0));
    const configs = (
      await pool.query(
        'SELECT channel_id,enabled,version,external_authorized FROM order_status_configs WHERE tenant_id=$1 ORDER BY channel_id',
        [f.tenant_id],
      )
    ).rows;
    assert(configs.every((c) => c.enabled && !c.external_authorized));
    const proof = {
      scope: 'native_local_simulation',
      previous_business_rows_unchanged: await previous(),
      orders,
      stock,
      configs,
      plans,
      real_provider_verified: false,
    };
    d.result = proof;
    await save();
    await writeFile('docs/order-status-qa.json', JSON.stringify(proof, null, 2));
    console.log(
      JSON.stringify({
        scope: proof.scope,
        orders: orders.length,
        verified_plans: plans.filter((p) => p.state === 'done').length,
        previous_business_rows_unchanged: proof.previous_business_rows_unchanged,
        real_provider_verified: false,
      }),
    );
  }
} finally {
  await pool.end();
}
