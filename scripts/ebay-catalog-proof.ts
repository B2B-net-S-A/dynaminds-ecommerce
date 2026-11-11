import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
const path = 'data/ebay-catalog-stage061.json',
  phase = process.argv[2];
let cookie = '';
const save = (s: any) => writeFile(path, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
async function api(p: string, method = 'GET', body?: any) {
  const r = await fetch('http://127.0.0.1:4100/api' + p, {
    method,
    headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
  assert(r.ok, `${method} ${p}: ${r.status} ${await r.clone().text()}`);
  return (await r.json()) as any;
}
async function fingerprint(t: string, tenants: string[]) {
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
    const prior = JSON.parse(await readFile('data/ebay-order-stage060.json', 'utf8')),
      tenants = (await pool.query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id),
      before: any = {};
    for (const t of Object.keys(prior.before)) before[t] = await fingerprint(t, tenants);
    await save({ tenants, before, excluded: prior.excluded });
    console.log({ tenants: tenants.length, tables: Object.keys(before).length });
  } else {
    const s = JSON.parse(await readFile(path, 'utf8'));
    if (phase === 'setup') {
      assert(!s.fixture);
      const email = 'qa-ebay-catalog@demo.local';
      await api('/auth/signup', 'POST', {
        email,
        password: 'DynaDemo!2026',
        name: 'QA katalog eBay',
        organization: { name: 'QA katalog eBay 061', currency: 'PLN', locale: 'pl-PL' },
      });
      const f: any = (s.fixture = { email, tenant: (await api('/auth/me')).user.tenant_id });
      await save(s);
      await api('/workspaces/plan', 'PATCH', { plan: 'enterprise' });
      f.warehouse = (await api('/warehouses')).data[0].id;
      f.channel = (await api('/integrations/ebay-example', 'POST', {})).channel_id;
      await save(s);
      console.log(f);
    } else {
      const f = s.fixture;
      await api('/auth/login', 'POST', { email: f.email, password: 'DynaDemo!2026' });
      if (phase === 'catalog') {
        const index = await api(`/integrations/${f.channel}/catalog-source-runs`);
        const run = index.data.find((r: any) => r.state === 'ready');
        assert(run);
        f.run = run.id;
        const rows = await api(`/catalog-source-runs/${run.id}?limit=100`);
        assert.equal(rows.data.length, 4);
        assert(rows.data.every((r: any) => r.state === 'applied'));
        const mappings = await api(`/integrations/${f.channel}/imports`);
        assert.equal(mappings.mappings.length, 1);
        assert.equal(
          (
            await pool.query('SELECT count(*)::int n FROM listings WHERE channel_id=$1', [
              f.channel,
            ])
          ).rows[0].n,
          3,
        );
        const products = await api('/products?limit=100');
        assert.equal(products.data.length, 4);
        f.product = products.data.find((p: any) => p.sku === 'EBAY-DEMO-SKU').id;
        assert.deepEqual(
          (await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [f.product]))
            .rows,
          [{ on_hand: 0, reserved: 0 }],
        );
        assert.equal(products.data.filter((p: any) => p.kind === 'variant').length, 2);
        assert.equal(products.data.filter((p: any) => p.kind === 'group').length, 1);
        await save(s);
        await api('/inventory/adjust', 'POST', {
          product_id: f.product,
          warehouse_id: f.warehouse,
          delta: 12,
          note: 'QA lokalne przyjęcie po imporcie katalogu eBay',
        });
        await api('/integrations/ebay-example', 'POST', {});
        console.log({
          products: 4,
          mappings: 3,
          physical_initial: 0,
          received: 12,
          order_import: 'pending_in_UI',
        });
      } else if (phase === 'flow') {
        const inbound = (await api(`/integrations/${f.channel}/imports`)).data[0];
        assert.equal(inbound.state, 'imported');
        f.inbound = inbound.id;
        f.order = inbound.order_id;
        await save(s);
        let o = await api(`/orders/${f.order}`);
        assert.equal(o.status, 'paid');
        assert.equal(o.total, 10001);
        assert.equal(o.items[0].product_id, f.product);
        assert.deepEqual(
          (await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [f.product]))
            .rows,
          [{ on_hand: 12, reserved: 2 }],
        );
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
          reason: 'QA katalog eBay — lokalny zwrot',
          shipping_refund: 1000,
          items: o.items.map((i: any) => ({ item_id: i.id, quantity: i.quantity })),
        });
        ret = await api(`/returns/${ret.id}/receive`, 'POST', {
          version: ret.version,
          shipping_refund: 1000,
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
          amount: 10001,
          reference: 'QA-SYMULACJA-BEZ-PRZELEWU',
          confirmed: true,
        });
        await save(s);
        console.log({ order: f.order, return: f.return });
      } else if (phase === 'verify') {
        const o = await api(`/orders/${f.order}`),
          p = await api(`/products/${f.product}`),
          run = await api(`/catalog-source-runs/${f.run}?limit=100`);
        assert.equal(o.status, 'return_completed');
        assert.equal(p.price, 10000);
        assert.equal(run.run.state, 'ready');
        assert(run.data.every((r: any) => r.state === 'applied'));
        const stock = (
          await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [f.product])
        ).rows[0];
        assert.deepEqual(stock, { on_hand: 12, reserved: 0 });
        for (const [t, hash] of Object.entries(s.before))
          assert.deepEqual(await fingerprint(t, s.tenants), hash, t + ' changed for previous firm');
        const h = await api('/health');
        if (process.argv[3]) assert.equal(h.revision, process.argv[3]);
        const payments = (
          await pool.query(
            'SELECT kind,amount FROM payment_entries WHERE order_id=$1 ORDER BY kind',
            [f.order],
          )
        ).rows;
        assert.deepEqual(payments, [
          { kind: 'receipt', amount: 10001 },
          { kind: 'refund', amount: 10001 },
        ]);
        const report = {
          checked_at: new Date().toISOString(),
          scope: 'native_local_eBay_inventory_and_order_simulation',
          revision: h.revision,
          schema_revision: h.schema_revision,
          provider_authenticated: false,
          whole_goal_complete: false,
          existing_tenants_preserved: s.tenants.length,
          stable_tables_preserved: Object.keys(s.before).length,
          catalog_rows: 4,
          saleable_skus: 3,
          groups: 1,
          variants: 2,
          sku_mappings: 3,
          physical_initial: 0,
          external_availability: [12, 13, 14],
          local_catalog_price: 10000,
          marketplace_line_total: 9001,
          order_total: 10001,
          shipping_cost: 1000,
          order_number: o.number,
          order_status: o.status,
          final_stock: stock,
          payment_entries: payments,
          real_provider_mutations: 0,
        };
        s.verification = report;
        await save(s);
        await writeFile(
          process.argv[3]
            ? 'data/ebay-catalog-runtime-061.json'
            : 'docs/ebay-catalog-native-qa.json',
          JSON.stringify(report, null, 2) + '\n',
        );
        console.log(report);
      } else throw new Error('Unknown phase');
    }
  }
} finally {
  await pool.end();
}
