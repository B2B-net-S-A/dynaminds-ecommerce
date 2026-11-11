import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { pool } from '../server/db';
const path = 'data/dpd-tracking-stage052.json',
  phase = process.argv[2],
  email = 'qa-dpd-tracking@demo.local';
const state = JSON.parse(await readFile(path, 'utf8'));
const save = () => writeFile(path, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
let cookie = '';
async function api(p: string, method = 'GET', body?: any) {
  const r = await fetch('http://127.0.0.1:4100/api' + p, {
    method,
    headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
  assert(r.ok, `${method} ${p} ${r.status}: ${await r.clone().text()}`);
  return (await r.json()) as any;
}
try {
  if (phase === 'setup') {
    assert(!state.fixture);
    await api('/auth/signup', 'POST', {
      email,
      password: 'DynaDemo!2026',
      name: 'QA Tracking DPD',
      organization: { name: 'QA Tracking DPD 20261004' },
    });
    const f: any = (state.fixture = {
      email,
      tenant: (await api('/auth/me')).user.tenant_id,
      orders: [],
    });
    await save();
    await api('/workspaces/plan', 'PATCH', { plan: 'enterprise' });
    f.warehouse = (await api('/warehouses')).data[0].id;
    f.channel = (await api('/dpd-shipping/example', 'POST', {})).channel_id;
    await save();
    for (const mode of ['prepaid', 'cod']) {
      const p = await api('/products', 'POST', {
        sku: 'DPD-TRACK-QA-052-' + mode.toUpperCase(),
        name: 'Tracking DPD QA ' + mode,
        price: 5000,
        vat: 23,
        quantity: 12,
        warehouse_id: f.warehouse,
      });
      const o = await api('/orders', 'POST', {
        customer_name: 'Syntetyczny odbiorca DPD ' + mode,
        payment_mode: mode,
        email: 'qa@example.test',
        warehouse_id: f.warehouse,
        address: {
          street: 'Testowa 1',
          city: 'Warszawa',
          postal_code: '01-354',
          country: 'PL',
          phone: '500600700',
        },
        items: [{ product_id: p.id, quantity: 2 }],
      });
      if (mode === 'prepaid')
        await api('/orders/' + o.id + '/payments', 'POST', {
          client_key: randomUUID(),
          version: Number(o.version),
          kind: 'receipt',
          amount: 10000,
          currency: 'PLN',
          reference: 'Lokalna wpłata QA',
          confirmed: true,
        });
      await api('/orders/' + o.id + '/status', 'PATCH', { status: 'picking' });
      for (let n = 0; n < 2; n++) await api('/orders/' + o.id + '/scan', 'POST', { code: p.sku });
      await api('/orders/' + o.id + '/status', 'PATCH', { status: 'packed' });
      const address = {
        name: 'Syntetyczny odbiorca QA',
        address: 'Testowa 1',
        city: 'Warszawa',
        postalCode: '01354',
        countryCode: 'PL',
        phone: '500600700',
        email: 'qa@example.test',
      };
      const plan = await api('/orders/' + o.id + '/dpd-shipping/preview', 'POST', {
        channel_id: f.channel,
        sender: address,
        receiver: address,
        weight: 1,
        dimensions: { length: 20, width: 20, height: 20 },
        content: 'Przykład lokalny',
        cod: mode === 'cod' ? 10000 : 0,
        insurance: 10000,
      });
      await api('/dpd-shipping/' + plan.id + '/queue', 'POST', {
        confirmed: true,
        ack_unknown_rate: true,
      });
      let ready: any;
      for (let n = 0; n < 40; n++) {
        ready = (await api('/orders/' + o.id + '/shipping')).data.find(
          (x: any) => x.id === plan.id,
        );
        if (ready.state === 'ready') break;
        assert.notEqual(ready.state, 'failed', ready.error);
        await setTimeout(250);
      }
      assert.equal(ready.state, 'ready');
      await api('/dpd-shipping/' + plan.id + '/dispatch', 'POST', { confirmed: true });
      f.orders.push({
        id: o.id,
        number: o.number,
        product: p.id,
        plan: plan.id,
        shipment: ready.shipment_id,
        mode,
      });
      await save();
    }
    console.log({ email, channel: f.channel, orders: f.orders });
  } else {
    const f = state.fixture;
    assert(f);
    await api('/auth/login', 'POST', { email, password: 'DynaDemo!2026' });
    if (phase === 'verify') {
      const d = await api('/integrations/' + f.channel + '/tracking');
      assert.equal(d.stats.total, 2);
      assert.equal(d.stats.terminal, 2);
      assert.equal(d.config.enabled, true);
      const outcomes = [];
      for (const o of f.orders) {
        const result = await api('/orders/' + o.id);
        const packet = result.shipments.find((s: any) => s.id === o.shipment);
        assert.equal(packet.tracking_data.scope, 'local_simulation');
        assert.equal(
          packet.tracking_data.status,
          o.mode === 'cod' ? 'delivered' : 'returned_to_sender',
        );
        assert.equal(result.status, o.mode === 'cod' ? 'delivered' : 'shipped');
        const stock = (
          await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [o.product])
        ).rows[0];
        assert.deepEqual(stock, { on_hand: 10, reserved: 0 });
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int n FROM stock_movements WHERE product_id=$1 AND kind='shipment'",
              [o.product],
            )
          ).rows[0].n,
          1,
        );
        const payments = (
          await pool.query(
            'SELECT amount,kind FROM payment_entries WHERE order_id=$1 ORDER BY id',
            [o.id],
          )
        ).rows;
        assert.equal(payments.length, o.mode === 'cod' ? 0 : 1);
        outcomes.push({
          number: o.number,
          status: result.status,
          tracking: packet.tracking_data.status,
          scope: packet.tracking_data.scope,
          stock,
          payments,
        });
      }
      for (const [table, b] of Object.entries(state.before) as [string, any][]) {
        const rows = (
          await pool.query(
            'SELECT to_jsonb(t)::text row FROM (SELECT ' +
              b.columns.join(',') +
              ' FROM ' +
              table +
              ' WHERE tenant_id=ANY($1::uuid[])) t ORDER BY 1',
            [state.tenants],
          )
        ).rows;
        assert.equal(rows.length, b.count, table);
        assert.equal(
          createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
          b.sha256,
          table,
        );
      }
      const proof = {
        checked_at: new Date().toISOString(),
        scope: 'native_local_DPD_tracking_simulation',
        previous_tenants: state.tenants.length,
        unchanged_tables: Object.keys(state.before).length,
        outcomes,
        provider_requests: 0,
        whole_goal_complete: false,
      };
      state.verification = proof;
      await save();
      await writeFile('docs/dpd-tracking-qa.json', JSON.stringify(proof, null, 2) + '\n');
      console.log(proof);
    }
  }
} finally {
  await pool.end();
}
