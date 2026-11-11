import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
const path = 'data/odoo-catalog-sync-stage056.json',
  phase = process.argv[2];
let cookie = '';
const save = (s: any) => writeFile(path, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
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
    const prev = JSON.parse(await readFile('data/odoo-order-stage055.json', 'utf8')),
      tenants = (await pool.query('SELECT id FROM tenants ORDER BY id')).rows.map((t) => t.id),
      before: any = {};
    for (const t of Object.keys(prev.before)) before[t] = await fingerprint(t, tenants);
    await save({ tenants, before, excluded: prev.excluded });
    console.log({ tenants: tenants.length, tables: Object.keys(before).length });
  } else {
    const s = JSON.parse(await readFile(path, 'utf8'));
    if (phase === 'setup') {
      assert(!s.fixture);
      const email = 'qa-odoo-catalog-sync@demo.local';
      await api('/auth/signup', 'POST', {
        email,
        password: 'DynaDemo!2026',
        name: 'QA Odoo katalog sync',
        organization: {
          name: 'QA Odoo harmonogram katalogu 20261004',
          currency: 'PLN',
          locale: 'pl-PL',
        },
      });
      const f: any = (s.fixture = { email, tenant: (await api('/auth/me')).user.tenant_id });
      await save(s);
      await api('/workspaces/plan', 'PATCH', { plan: 'enterprise' });
      f.warehouse = (await api('/warehouses')).data[0].id;
      f.channel = (await api('/integrations/odoo-example', 'POST', {})).channel_id;
      f.products = [];
      await save(s);
      for (const [id, name, quantity] of [
        [101, 'Niebieska', 12],
        [102, 'Czerwona', 5],
      ] as const) {
        const sku = 'OD-SYNC-QA-' + id + '-' + randomUUID().slice(0, 8);
        const p = await api('/products', 'POST', {
          name: 'QA Odoo sync ' + name,
          sku,
          price: 9999,
          vat: 23,
          warehouse_id: f.warehouse,
          quantity,
        });
        f.products.push({ id: p.id, external_id: id, sku, quantity });
        await save(s);
        await api(`/integrations/${f.channel}/mappings`, 'POST', { external_id: String(id), sku });
      }
      const order = await api('/orders', 'POST', {
        customer_name: 'Syntetyczny odbiorca QA Odoo sync',
        email: 'qa@example.test',
        warehouse_id: f.warehouse,
        items: [{ product_id: f.products[0].id, quantity: 2 }],
        shipping_cost: 1499,
        address: { street: 'Testowa 1', city: 'Warszawa', postal_code: '00-001', country: 'PL' },
      });
      f.order = order.id;
      f.order_total_before = order.total;
      assert.equal(order.total, 21497);
      await save(s);
      await api(`/orders/${f.order}/payments`, 'POST', {
        client_key: randomUUID(),
        version: order.version,
        kind: 'receipt',
        amount: 21497,
        currency: 'PLN',
        method: 'other',
        reference: 'QA SYMULACJA WPŁATY',
        confirmed: true,
      });
      f.reserved_before = (
        await pool.query(
          'SELECT product_id,on_hand,reserved FROM stock WHERE product_id=ANY($1::uuid[]) ORDER BY product_id',
          [f.products.map((p: any) => p.id)],
        )
      ).rows;
      await save(s);
      console.log({
        scope: 'local_simulation',
        approval: 'pending_in_Chrome',
        channel: f.channel,
        order: order.number,
        total_before: order.total,
      });
    } else {
      const f = s.fixture;
      await api('/auth/login', 'POST', { email: f.email, password: 'DynaDemo!2026' });
      const index = await api(`/integrations/${f.channel}/odoo-catalog-sync`),
        r = index.runs.find((r: any) => r.state === 'success');
      assert(r);
      assert.equal(r.applied, 2);
      assert.equal(r.skipped, 0);
      f.run = r.id;
      await save(s);
      const detail = await api(`/odoo-catalog-sync-runs/${f.run}`);
      assert.equal(detail.data.length, 2);
      assert(detail.data.every((i: any) => i.result.scope === 'local_simulation'));
      for (const p of f.products)
        assert.equal(
          (await pool.query('SELECT price FROM products WHERE id=$1', [p.id])).rows[0].price,
          p.external_id === 101 ? 4305 : 4920,
        );
      let o = await api(`/orders/${f.order}`);
      assert.equal(o.total, 21497);
      if (phase === 'flow') {
        assert(!f.return);
        assert.deepEqual(
          (
            await pool.query(
              'SELECT product_id,on_hand,reserved FROM stock WHERE product_id=ANY($1::uuid[]) ORDER BY product_id',
              [f.products.map((p: any) => p.id)],
            )
          ).rows,
          f.reserved_before,
        );
        const newer = await api('/orders', 'POST', {
          customer_name: 'Syntetyczny nabywca nowej ceny',
          email: 'qa@example.test',
          warehouse_id: f.warehouse,
          items: [{ product_id: f.products[0].id, quantity: 2 }],
          shipping_cost: 1499,
          address: { street: 'Testowa 1', city: 'Warszawa', postal_code: '00-001', country: 'PL' },
        });
        assert.equal(newer.total, 10109);
        f.new_order = newer.id;
        await save(s);
        await api(`/orders/${newer.id}/status`, 'PATCH', { status: 'cancelled' });
        await api(`/orders/${f.order}/status`, 'PATCH', { status: 'picking' });
        o = await api(`/orders/${f.order}`);
        for (const i of o.picking_items)
          for (let n = 0; n < i.quantity; n++)
            await api(`/orders/${f.order}/scan`, 'POST', { code: i.sku });
        await api(`/orders/${f.order}/status`, 'PATCH', { status: 'packed' });
        await api(`/orders/${f.order}/ship-demo`, 'POST', {});
        f.document = (await api(`/orders/${f.order}/documents`, 'POST', { kind: 'invoice' })).id;
        await save(s);
        let ret = await api(`/orders/${f.order}/returns`, 'POST', {
          client_key: randomUUID(),
          reason: 'QA harmonogram Odoo — lokalny zwrot',
          shipping_refund: 1499,
          items: o.items.map((i: any) => ({ item_id: i.id, quantity: i.quantity })),
        });
        ret = await api(`/returns/${ret.id}/receive`, 'POST', {
          version: ret.version,
          shipping_refund: 1499,
          note: 'QA przyjęcie',
          items: ret.items.map((i: any) => ({
            item_id: i.item_id,
            accepted: i.requested,
            restocked: i.requested,
          })),
        });
        f.correction = (await api(`/returns/${ret.id}/document`, 'POST', {})).id;
        await api(`/returns/${ret.id}/refund`, 'POST', {
          version: ret.version,
          amount: 21497,
          reference: 'QA-SYMULACJA-BEZ-PRZELEWU',
          confirmed: true,
        });
        f.return = ret.id;
        await save(s);
      }
      o = await api(`/orders/${f.order}`);
      assert.equal(o.status, 'return_completed');
      assert.equal((await api(`/orders/${f.new_order}`)).status, 'cancelled');
      for (const p of f.products)
        assert.deepEqual(
          (await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [p.id])).rows,
          [{ on_hand: p.quantity, reserved: 0 }],
        );
      for (const [t, hash] of Object.entries(s.before))
        assert.deepEqual(await fingerprint(t, s.tenants), hash, t + ' changed for prior firm');
      for (const t of [
        'odoo_catalog_schedules',
        'odoo_catalog_sync_runs',
        'odoo_catalog_sync_items',
      ])
        assert.equal(
          (
            await pool.query(`SELECT count(*)::int n FROM ${t} WHERE tenant_id=ANY($1::uuid[])`, [
              s.tenants,
            ])
          ).rows[0].n,
          0,
        );
      const h = await api('/health');
      assert.equal(h.schema_revision, '043_odoo_catalog_sync');
      if (process.argv[3]) assert.equal(h.revision, process.argv[3]);
      const report = {
        checked_at: new Date().toISOString(),
        scope: 'native_local_Odoo_catalog_schedule_simulation',
        provider_authenticated: false,
        whole_goal_complete: false,
        revision: h.revision,
        schema_revision: h.schema_revision,
        existing_tenants_preserved: s.tenants.length,
        stable_tables_preserved: Object.keys(s.before).length + 3,
        applied_variants: 2,
        skipped: 0,
        ERP_availability: detail.data.map((i: any) => ({
          external_id: i.external_id,
          quantity: i.result.availability,
        })),
        local_prices: [4305, 4920],
        physical_stock_preserved_during_sync: true,
        reserved_stock_preserved_during_sync: true,
        old_order_total_preserved: 21497,
        new_order_total: 10109,
        new_order_cancelled: true,
        old_order_status: o.status,
        local_fulfillment_and_return: true,
        final_stock: f.products.map((p: any) => ({
          external_id: p.external_id,
          on_hand: p.quantity,
          reserved: 0,
        })),
        provider_requests: 0,
        real_provider_mutations: 0,
      };
      s.verification = report;
      await save(s);
      await writeFile(
        phase === 'verify'
          ? 'data/odoo-catalog-sync-runtime-056.json'
          : 'docs/odoo-catalog-sync-native-qa.json',
        JSON.stringify(report, null, 2) + '\n',
      );
      console.log(report);
    }
  }
} finally {
  await pool.end();
}
