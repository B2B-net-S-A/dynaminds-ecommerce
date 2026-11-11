// Host-native, localhost-only labelled simulation. No provider writes, shipment purchases or bank transfers.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
const path = 'data/ebay-offers-stage062.json',
  phase = process.argv[2];
let cookie = '';
async function api(p: string, method = 'GET', body?: any) {
  const r = await fetch('http://127.0.0.1:4100/api' + p, {
    method,
    headers: {
      cookie,
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(p === '/orders' ? { 'idempotency-key': randomUUID() } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
  assert(r.ok, `${method} ${p}: ${r.status} ${await r.clone().text()}`);
  return r.json() as any;
}
const save = (s: any) => writeFile(path, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
async function fingerprint(t: string, tenants: string[]) {
  assert(/^[a-z][a-z0-9_]*$/.test(t));
  const rows = (
    await pool.query(
      `SELECT to_jsonb(t)::text row FROM ${t} t WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1`,
      [tenants],
    )
  ).rows;
  return {
    count: rows.length,
    sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
  };
}
try {
  if (phase === 'baseline') {
    const prior = JSON.parse(await readFile('data/ebay-catalog-stage061.json', 'utf8'));
    const tenants = (await pool.query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id),
      before: any = {};
    for (const t of Object.keys(prior.before)) before[t] = await fingerprint(t, tenants);
    await save({ tenants, before, excluded: prior.excluded });
    console.log({ tenants: tenants.length, tables: Object.keys(before).length });
  } else {
    const s = JSON.parse(await readFile(path, 'utf8'));
    if (phase === 'setup') {
      assert(!s.fixture);
      const email = 'qa-ebay-offers@demo.local';
      await api('/auth/signup', 'POST', {
        email,
        password: 'DynaDemo!2026',
        name: 'QA oferty eBay',
        organization: { name: 'QA oferty eBay 062', currency: 'PLN', locale: 'pl-PL' },
      });
      const f: any = (s.fixture = { email, tenant: (await api('/auth/me')).user.tenant_id });
      await save(s);
      await api('/workspaces/plan', 'PATCH', { plan: 'enterprise' });
      f.warehouse = (await api('/warehouses')).data[0].id;
      f.channel = (await api('/integrations/ebay-example', 'POST', {})).channel_id;
      const p = await api('/products', 'POST', {
        sku: 'EBAY-DEMO-SKU',
        name: 'Produkt eBay — QA synchronizacji',
        price: 12300,
        vat: 23,
        quantity: 10,
        warehouse_id: f.warehouse,
      });
      f.product = p.id;
      f.listing = (
        await api(`/integrations/${f.channel}/mappings`, 'POST', {
          external_id: 'EBAY-DEMO-SKU',
          sku: p.sku,
        })
      ).id;
      // A local historical order proves that later offer/catalog changes do not rewrite sales totals.
      const o = await api('/orders', 'POST', {
        customer_name: 'Jan QA eBay',
        email: 'ebay@example.test',
        warehouse_id: f.warehouse,
        address: { street: 'Testowa 62', city: 'Warszawa', postal_code: '00-001', country: 'PL' },
        items: [{ product_id: p.id, quantity: 2 }],
      });
      f.order = o.id;
      f.order_total = o.total;
      await api(`/orders/${o.id}/payments`, 'POST', {
        client_key: randomUUID(),
        version: o.version,
        kind: 'receipt',
        amount: o.total,
        currency: 'PLN',
        method: 'other',
        reference: 'QA-DEMO-NO-TRANSFER',
        confirmed: true,
      });
      await save(s);
      console.log({
        tenant: f.tenant,
        channel: f.channel,
        product: f.product,
        order: f.order,
        total: f.order_total,
      });
    } else {
      const f = s.fixture;
      await api('/auth/login', 'POST', { email: f.email, password: 'DynaDemo!2026' });
      if (phase === 'ui') {
        const plans = (await api(`/integrations/${f.channel}/offers`)).data;
        const done = plans.find((p: any) => p.state === 'done' && p.result?.desired_applied);
        assert(done, 'Queue and execute the first preview in the UI');
        f.ui_plan = done.id;
        assert.equal(done.payload.requests[0].shipToLocationAvailability.quantity, 8);
        assert.equal(done.payload.requests[0].offers[0].price.value, '123.00');
        const listing = (await pool.query('SELECT * FROM listings WHERE id=$1', [f.listing]))
          .rows[0];
        assert.equal(listing.last_result.stock_quantity, 8);
        assert.equal(listing.last_result.scope, 'local_simulation');
        assert.deepEqual(
          (await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [f.product]))
            .rows,
          [{ on_hand: 10, reserved: 2 }],
        );
        await save(s);
        console.log({ ui_plan: f.ui_plan, availability: 8, price: '123.00' });
      } else if (phase === 'change') {
        const cfg = (await api(`/integrations/${f.channel}/offer-sync`)).config;
        assert(cfg?.enabled, 'Enable schedule in UI');
        f.sync_version = cfg.version;
        const p = await api(`/products/${f.product}`);
        await api(`/products/${f.product}`, 'PATCH', { ...p, version: p.version, price: 24600 });
        await api('/inventory/adjust', 'POST', {
          product_id: f.product,
          warehouse_id: f.warehouse,
          delta: 1,
          note: 'QA lokalne przyjęcie +1 dla harmonogramu eBay',
        });
        await save(s);
        console.log({ next_price: '246.00', next_available: 9, run_schedule: 'UI' });
      } else if (phase === 'auto') {
        const plans = (await api(`/integrations/${f.channel}/offers`)).data;
        const done = plans.find(
          (p: any) =>
            p.sync_version &&
            p.state === 'done' &&
            p.payload.requests[0].offers[0].price?.value === '246.00',
        );
        assert(done, 'Run and refresh the schedule in UI');
        f.auto_plan = done.id;
        assert.equal(done.payload.requests[0].shipToLocationAvailability.quantity, 9);
        const listing = (await pool.query('SELECT * FROM listings WHERE id=$1', [f.listing]))
          .rows[0];
        assert.equal(listing.last_result.stock_quantity, 9);
        assert.equal(listing.last_result.ebay_offer_snapshot.regular_price, '246.00');
        const cfg = (await api(`/integrations/${f.channel}/offer-sync`)).config;
        assert(!cfg.enabled, 'Pause the schedule in UI before business flow');
        await save(s);
        console.log({
          auto_plan: f.auto_plan,
          availability: 9,
          price: '246.00',
          schedule: 'paused',
        });
      } else if (phase === 'flow') {
        let o = await api(`/orders/${f.order}`);
        assert.equal(o.total, f.order_total);
        await api(`/orders/${f.order}/status`, 'PATCH', { status: 'picking' });
        o = await api(`/orders/${f.order}`);
        for (const i of o.picking_items)
          for (let n = 0; n < i.quantity; n++)
            await api(`/orders/${f.order}/scan`, 'POST', { code: i.sku });
        await api(`/orders/${f.order}/status`, 'PATCH', { status: 'packed' });
        f.shipment = (await api(`/orders/${f.order}/ship-demo`, 'POST', {})).id;
        f.document = (await api(`/orders/${f.order}/documents`, 'POST', { kind: 'invoice' })).id;
        await save(s);
        let ret = await api(`/orders/${f.order}/returns`, 'POST', {
          client_key: randomUUID(),
          reason: 'QA oferty eBay — lokalny zwrot',
          shipping_refund: 0,
          items: o.items.map((i: any) => ({ item_id: i.id, quantity: i.quantity })),
        });
        ret = await api(`/returns/${ret.id}/receive`, 'POST', {
          version: ret.version,
          shipping_refund: 0,
          note: 'QA przyjęcie zwrotu',
          items: ret.items.map((i: any) => ({
            item_id: i.item_id,
            accepted: i.requested,
            restocked: i.requested,
          })),
        });
        f.return = ret.id;
        f.correction = (await api(`/returns/${ret.id}/document`, 'POST', {})).id;
        await api(`/returns/${ret.id}/refund`, 'POST', {
          version: ret.version,
          amount: f.order_total,
          reference: 'QA-SYMULACJA-BEZ-PRZELEWU',
          confirmed: true,
        });
        await save(s);
        console.log({ order: f.order, return: f.return, total: f.order_total });
      } else if (phase === 'verify') {
        const o = await api(`/orders/${f.order}`),
          p = await api(`/products/${f.product}`),
          h = await api('/health');
        assert.equal(o.status, 'return_completed');
        assert.equal(o.total, 24600);
        assert.equal(o.total, f.order_total);
        assert.equal(p.price, 24600);
        const afterReturn = (
          await pool.query(
            "SELECT * FROM offer_plans WHERE channel_id=$1 AND state='done' AND (payload->'requests'->0->'shipToLocationAvailability'->>'quantity')::int=11 ORDER BY created_at DESC LIMIT 1",
            [f.channel],
          )
        ).rows[0];
        if (afterReturn) {
          assert(afterReturn.result.desired_applied);
          f.after_return_plan = afterReturn.id;
        }
        const listing = (
          await pool.query('SELECT last_result FROM listings WHERE id=$1', [f.listing])
        ).rows[0];
        const stock = (
          await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [f.product])
        ).rows[0];
        assert.deepEqual(stock, { on_hand: 11, reserved: 0 });
        const payments = (
          await pool.query(
            'SELECT kind,amount FROM payment_entries WHERE order_id=$1 ORDER BY kind',
            [f.order],
          )
        ).rows;
        assert.deepEqual(payments, [
          { kind: 'receipt', amount: 24600 },
          { kind: 'refund', amount: 24600 },
        ]);
        for (const [t, hash] of Object.entries(s.before))
          assert.deepEqual(await fingerprint(t, s.tenants), hash, t + ' changed for prior tenant');
        if (process.argv[3]) assert.equal(h.revision, process.argv[3]);
        const report = {
          checked_at: new Date().toISOString(),
          scope: 'native_local_eBay_offer_sync_simulation',
          revision: h.revision,
          schema_revision: h.schema_revision,
          existing_tenants_preserved: s.tenants.length,
          stable_tables_preserved: Object.keys(s.before).length,
          ui_plan: f.ui_plan,
          auto_plan: f.auto_plan,
          first_offer: { price: '123.00', available: 8 },
          automatic_offer: { price: '246.00', available: 9 },
          after_return_offer: {
            price: listing.last_result.ebay_offer_snapshot.regular_price,
            available: listing.last_result.stock_quantity,
          },
          after_return_plan: f.after_return_plan ?? null,
          schedule_enabled: false,
          historical_order_total: o.total,
          current_catalog_price: p.price,
          order_status: o.status,
          final_stock: stock,
          payment_entries: payments,
          provider_authenticated: false,
          real_provider_mutations: 0,
          whole_goal_complete: false,
        };
        s.verification = report;
        await save(s);
        await writeFile(
          process.argv[3] ? 'data/ebay-offers-runtime-062.json' : 'docs/ebay-offers-native-qa.json',
          JSON.stringify(report, null, 2) + '\n',
        );
        console.log(report);
      } else throw new Error('Unknown phase');
    }
  }
} finally {
  await pool.end();
}
