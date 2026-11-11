import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { pool } from '../server/db';
const path = 'data/odoo-stage053.json',
  phase = process.argv[2];
const email = 'qa-odoo@demo.local';
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
    const previous = JSON.parse(await readFile('data/dpd-tracking-stage052.json', 'utf8')),
      tenants = (await pool.query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id),
      before: any = {};
    for (const t of Object.keys(previous.before)) before[t] = await fingerprint(t, tenants);
    await save({ tenants, before, excluded: previous.excluded });
    console.log({ tenants: tenants.length, tables: Object.keys(before).length });
  } else {
    const s = JSON.parse(await readFile(path, 'utf8'));
    if (phase === 'setup') {
      assert(!s.fixture);
      await api('/auth/signup', 'POST', {
        email,
        password: 'DynaDemo!2026',
        name: 'QA Odoo',
        organization: { name: 'QA Odoo katalog 20261004', currency: 'PLN', locale: 'pl-PL' },
      });
      const f: any = (s.fixture = { email, tenant: (await api('/auth/me')).user.tenant_id });
      await save(s);
      await api('/workspaces/plan', 'PATCH', { plan: 'enterprise' });
      f.warehouse = (await api('/warehouses')).data[0].id;
      f.channel = (await api('/integrations/odoo-example', 'POST', {})).channel_id;
      await save(s);
      const run = await api(`/integrations/${f.channel}/catalog-source-runs`, 'POST', {
        client_key: randomUUID(),
        warehouse_id: f.warehouse,
        vat: 23,
        import_stock: false,
      });
      f.run = run.id;
      await save(s);
      for (let i = 0; i < 100; i++) {
        const r = await api(`/catalog-source-runs/${f.run}`);
        if (r.run.state === 'ready') {
          assert.equal(r.data.length, 3);
          break;
        }
        assert.equal(r.run.state, 'queued');
        await setTimeout(300);
      }
      assert.equal((await api(`/catalog-source-runs/${f.run}`)).run.state, 'ready');
      console.log({ phase, run: f.run, scope: 'local_simulation', approval: 'pending_in_UI' });
    } else {
      const f = s.fixture;
      await api('/auth/login', 'POST', { email: f.email, password: 'DynaDemo!2026' });
      if (phase === 'flow') {
        assert(!f.order);
        const r = await api(`/catalog-source-runs/${f.run}`);
        assert.equal(r.data.filter((i: any) => i.state === 'applied').length, 3);
        const selected = r.data.find((i: any) => i.external_id === '101');
        f.product = selected.product_id;
        await save(s);
        assert.deepEqual(
          (await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [f.product]))
            .rows,
          [{ on_hand: 0, reserved: 0 }],
        );
        let receipt = await api('/warehouse-documents', 'POST', {
          kind: 'receipt',
          warehouse_id: f.warehouse,
          reference: 'QA Odoo — fizyczne przyjęcie 10 sztuk',
          lines: [{ product_id: f.product, quantity: 10, location: 'A-01' }],
        });
        receipt = await api(`/warehouse-documents/${receipt.id}/post`, 'POST', {
          version: receipt.version,
        });
        f.receipt = receipt.id;
        await save(s);
        let o = await api('/orders', 'POST', {
          source: 'manual',
          customer_name: 'Syntetyczny odbiorca QA Odoo',
          email: 'qa@example.test',
          warehouse_id: f.warehouse,
          note: 'QA: zamówienie lokalne produktu z Odoo, nie import zamówienia ERP',
          address: {
            street: 'Testowa 1',
            city: 'Warszawa',
            postal_code: '01-354',
            country: 'PL',
            phone: '500600700',
          },
          items: [{ product_id: f.product, quantity: 2 }],
          shipping_cost: 0,
        });
        f.order = o.id;
        await save(s);
        assert.equal(
          (
            await pool.query('SELECT count(*)::int n FROM payment_entries WHERE order_id=$1', [
              o.id,
            ])
          ).rows[0].n,
          0,
        );
        await api(`/orders/${o.id}/payments`, 'POST', {
          client_key: randomUUID(),
          version: o.version,
          kind: 'receipt',
          amount: o.total,
          currency: 'PLN',
          method: 'other',
          reference: 'QA SYMULACJA WPŁATY',
          confirmed: true,
        });
        o = await api(`/orders/${o.id}`);
        if (o.status !== 'paid') await api(`/orders/${o.id}/status`, 'PATCH', { status: 'paid' });
        await api(`/orders/${o.id}/status`, 'PATCH', { status: 'picking' });
        o = await api(`/orders/${o.id}`);
        for (const i of o.picking_items)
          for (let n = 0; n < i.quantity; n++)
            await api(`/orders/${o.id}/scan`, 'POST', { code: i.sku });
        await api(`/orders/${o.id}/status`, 'PATCH', { status: 'packed' });
        await api(`/orders/${o.id}/ship-demo`, 'POST', {});
        await api(`/orders/${o.id}/documents`, 'POST', { kind: 'invoice' });
        let ret = await api(`/orders/${o.id}/returns`, 'POST', {
          client_key: randomUUID(),
          reason: 'QA Odoo — lokalny zwrot',
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
        await api(`/returns/${ret.id}/document`, 'POST', {});
        await api(`/returns/${ret.id}/refund`, 'POST', {
          version: ret.version,
          amount: o.total,
          reference: 'QA-SYMULACJA-BEZ-PRZELEWU',
          confirmed: true,
        });
        f.return = ret.id;
        await save(s);
      }
      if (phase === 'verify' || phase === 'flow') {
        const r = await api(`/catalog-source-runs/${f.run}`),
          o = await api(`/orders/${f.order}`);
        assert.equal(r.run.state, 'ready');
        assert.equal(o.status, 'return_completed');
        assert.equal(r.run.context.warehouse_id, 1);
        assert.equal(r.run.import_stock, false);
        const rows = (
          await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [f.product])
        ).rows;
        assert.deepEqual(rows, [{ on_hand: 10, reserved: 0 }]);
        for (const [table, hash] of Object.entries(s.before))
          assert.deepEqual(
            await fingerprint(table, s.tenants),
            hash,
            table + ' changed for previous firm',
          );
        const report = {
          checked_at: new Date().toISOString(),
          scope: 'native_local_Odoo_catalog_simulation',
          provider_authenticated: false,
          revision: (await api('/health')).revision,
          schema_revision: (await api('/health')).schema_revision,
          existing_tenants_preserved: s.tenants.length,
          stable_tables_preserved: Object.keys(s.before).length,
          catalog_rows: r.data.length,
          groups: 1,
          variants: 2,
          ERP_availability: r.data
            .filter((i: any) => i.kind === 'variant')
            .map((i: any) => i.source.quantity),
          physical_stock_immediately_after_catalog: 0,
          physical_receipt: 10,
          order_source: o.source,
          order_number: o.number,
          order_status: o.status,
          final_stock: rows[0],
          local_fulfillment_and_return: true,
          no_external_write: true,
          whole_goal_complete: false,
        };
        s.verification = report;
        await save(s);
        if (phase === 'verify' && process.argv[3]) assert.equal(report.revision, process.argv[3]);
        await writeFile(
          phase === 'verify' ? 'data/odoo-runtime-053.json' : 'docs/odoo-native-qa.json',
          JSON.stringify(report, null, 2) + '\n',
        );
        console.log(report);
      }
    }
  }
} finally {
  await pool.end();
}
