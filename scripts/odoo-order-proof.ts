import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
const path = 'data/odoo-order-stage055.json',
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
    const previous = JSON.parse(await readFile('data/odoo-invoice-stage054.json', 'utf8')),
      tenants = (await pool.query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id),
      before: any = {};
    for (const t of [...Object.keys(previous.before), 'odoo_invoice_exports'])
      before[t] = await fingerprint(t, tenants);
    await save({ tenants, before, excluded: previous.excluded });
    console.log({ tenants: tenants.length, tables: Object.keys(before).length });
  } else {
    const s = JSON.parse(await readFile(path, 'utf8'));
    if (phase === 'setup') {
      assert(!s.fixture);
      const email = 'qa-odoo-orders@demo.local';
      await api('/auth/signup', 'POST', {
        email,
        password: 'DynaDemo!2026',
        name: 'QA Odoo zamówienia',
        organization: { name: 'QA Odoo zamówienia 20261004', currency: 'PLN', locale: 'pl-PL' },
      });
      const f: any = (s.fixture = { email, tenant: (await api('/auth/me')).user.tenant_id });
      await save(s);
      await api('/workspaces/plan', 'PATCH', { plan: 'enterprise' });
      f.warehouse = (await api('/warehouses')).data[0].id;
      f.channel = (await api('/integrations/odoo-example', 'POST', {})).channel_id;
      await save(s);
      f.sku = 'OD-ORDER-QA-' + randomUUID().slice(0, 8);
      f.product = (
        await api('/products', 'POST', {
          name: 'Produkt QA import zamówienia Odoo',
          sku: f.sku,
          price: 9999,
          vat: 23,
          warehouse_id: f.warehouse,
          quantity: 12,
        })
      ).id;
      await save(s);
      await api(`/integrations/${f.channel}/mappings`, 'POST', { external_id: '101', sku: f.sku });
      console.log({ scope: 'local_simulation', approval: 'pending_in_Chrome', ...f });
    } else {
      const f = s.fixture;
      await api('/auth/login', 'POST', { email: f.email, password: 'DynaDemo!2026' });
      const inbound = (await api(`/integrations/${f.channel}/imports`)).data;
      assert.equal(inbound.length, 1);
      assert.equal(inbound[0].state, 'imported');
      assert.equal(inbound[0].source_changed, false);
      f.inbound = inbound[0].id;
      f.order = inbound[0].order_id;
      await save(s);
      let o = await api(`/orders/${f.order}`);
      assert.equal(o.source, 'odoo');
      assert.equal(o.total, 10109);
      assert.equal(o.shipping_cost, 1499);
      if (phase === 'flow') {
        assert.equal(o.status, 'paid');
        assert.deepEqual(
          (await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [f.product]))
            .rows,
          [{ on_hand: 12, reserved: 2 }],
        );
        assert.equal(
          (
            await pool.query('SELECT count(*)::int n FROM payment_entries WHERE order_id=$1', [
              f.order,
            ])
          ).rows[0].n,
          1,
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
          reason: 'QA import Odoo — lokalny zwrot',
          shipping_refund: 1499,
          items: o.items.map((i: any) => ({ item_id: i.id, quantity: i.quantity })),
        });
        ret = await api(`/returns/${ret.id}/receive`, 'POST', {
          version: ret.version,
          shipping_refund: 1499,
          note: 'QA przyjęcie zwrotu',
          items: ret.items.map((i: any) => ({
            item_id: i.item_id,
            accepted: i.requested,
            restocked: i.requested,
          })),
        });
        f.correction = (await api(`/returns/${ret.id}/document`, 'POST', {})).id;
        await api(`/returns/${ret.id}/refund`, 'POST', {
          version: ret.version,
          amount: 10109,
          reference: 'QA-SYMULACJA-BEZ-PRZELEWU',
          confirmed: true,
        });
        f.return = ret.id;
        await save(s);
      }
      o = await api(`/orders/${f.order}`);
      assert.equal(o.status, 'return_completed');
      const stock = (
        await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [f.product])
      ).rows;
      assert.deepEqual(stock, [{ on_hand: 12, reserved: 0 }]);
      for (const [t, hash] of Object.entries(s.before))
        assert.deepEqual(await fingerprint(t, s.tenants), hash, t + ' changed for previous firm');
      const h = await api('/health');
      assert.equal(h.schema_revision, '042_odoo_invoice_exports');
      if (process.argv[3]) assert.equal(h.revision, process.argv[3]);
      const payments = (
        await pool.query(
          'SELECT kind,amount FROM payment_entries WHERE order_id=$1 ORDER BY kind',
          [f.order],
        )
      ).rows;
      assert.deepEqual(payments, [
        { kind: 'receipt', amount: 10109 },
        { kind: 'refund', amount: 10109 },
      ]);
      const report = {
        checked_at: new Date().toISOString(),
        scope: 'native_local_Odoo_order_simulation',
        revision: h.revision,
        schema_revision: h.schema_revision,
        provider_authenticated: false,
        whole_goal_complete: false,
        existing_tenants_preserved: s.tenants.length,
        stable_tables_preserved: Object.keys(s.before).length,
        order_source: o.source,
        source_number: 'S-ODOO-DEMO-2001',
        order_number: o.number,
        order_status: o.status,
        total: 10109,
        shipping_cost: 1499,
        local_catalog_price: 9999,
        ERP_line_total: 8610,
        quantity: 2,
        atomic_reservation_verified: true,
        payment_entries: payments,
        final_stock: stock[0],
        local_fulfillment_and_return: true,
        real_provider_mutations: 0,
      };
      s.verification = report;
      await save(s);
      await writeFile(
        phase === 'verify' ? 'data/odoo-order-runtime-055.json' : 'docs/odoo-order-native-qa.json',
        JSON.stringify(report, null, 2) + '\n',
      );
      console.log(report);
    }
  }
} finally {
  await pool.end();
}
