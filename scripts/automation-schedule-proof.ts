// Local synthetic fixture only. Cookies and buyer links never enter the evidence.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool, migrate } from '../server/db';
const file = 'data/automation-schedules-stage026.json';
const tables = [
  'orders',
  'order_items',
  'order_pick_items',
  'products',
  'stock',
  'reservations',
  'stock_movements',
  'stock_locations',
  'reservation_locations',
  'stock_location_movements',
  'stock_location_operations',
  'warehouse_documents',
  'warehouse_document_lines',
  'purchase_orders',
  'purchase_order_lines',
  'purchase_receipts',
  'purchase_receipt_lines',
  'documents',
  'shipments',
  'return_cases',
  'return_items',
  'listings',
  'offer_plans',
  'order_status_plans',
  'source_payment_checks',
  'source_payment_configs',
  'payment_entries',
  'automation_rules',
  'automation_runs',
];
async function fingerprint(table: string, tenants: string[]) {
  const rows = (
    await pool.query(
      `SELECT row_to_json(t)::text AS row FROM ${table} t WHERE tenant_id=ANY($1::uuid[]) ORDER BY row_to_json(t)::text`,
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
async function api(path: string, method = 'GET', body?: any) {
  const r = await fetch('http://127.0.0.1:4100/api' + path, {
    method,
    headers: {
      cookie,
      ...(tenant && !['/auth/login', '/workspaces', '/workspaces/switch'].includes(path)
        ? { 'x-workspace-id': tenant }
        : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
  assert(r.ok, path + ':' + r.status);
  return r.json();
}
try {
  const phase = process.argv[2];
  if (phase === 'migrate') {
    const tenants = (await pool.query('SELECT id FROM tenants ORDER BY id')).rows.map((v) => v.id),
      before: any = {};
    for (const t of tables) before[t] = await fingerprint(t, tenants);
    await migrate();
    for (const t of tables) assert.deepEqual(await fingerprint(t, tenants), before[t]);
    await writeFile(
      file,
      JSON.stringify({
        tenants,
        before,
        migration: {
          revision: '026_automation_schedules',
          previous_tables_preserved: tables.length,
        },
      }),
      { mode: 0o600 },
    );
    console.log(
      JSON.stringify({
        migration: '026_automation_schedules',
        previous_tables_preserved: tables.length,
      }),
    );
  } else {
    const d = JSON.parse(await readFile(file, 'utf8'));
    await api('/auth/login', 'POST', { email: 'admin@demo.local', password: 'DynaDemo!2026' });
    if (phase === 'setup') {
      assert(!d.fixture);
      const org = await api('/workspaces', 'POST', {
        name: 'QA Harmonogramy 20261004',
        currency: 'PLN',
        locale: 'pl-PL',
      });
      tenant = org.user.tenant_id;
      await api('/workspaces/plan', 'PATCH', { plan: 'business' });
      const wh = (await api('/warehouses')).data[0];
      const p = await api('/products', 'POST', {
        sku: 'QA-SCHEDULE-026',
        name: 'Towar harmonogramów QA',
        price: 2500,
        quantity: 80,
        warehouse_id: wh.id,
      });
      const orders = [];
      for (let i = 0; i < 31; i++)
        orders.push(
          (
            await api('/orders', 'POST', {
              customer_name: 'QA cykl ' + (i + 1),
              email: 'schedule@example.test',
              warehouse_id: wh.id,
              items: [{ product_id: p.id, quantity: 1 }],
              address: { country: 'PL' },
            })
          ).id,
        );
      d.fixture = { tenant_id: tenant, warehouse_id: wh.id, product_id: p.id, order_ids: orders };
      await writeFile(file, JSON.stringify(d), { mode: 0o600 });
      console.log(JSON.stringify({ fixture: d.fixture }));
    } else if (phase === 'capture') {
      tenant = d.fixture.tenant_id;
      await api('/workspaces/switch', 'POST', { tenant_id: tenant });
      const schedules = (await api('/automation-schedules')).data;
      assert.equal(schedules.length, 1);
      const s = schedules[0];
      assert.equal(s.enabled, false);
      const runs = (await api('/automation-schedules/' + s.id + '/runs')).data;
      assert(runs.some((v: any) => v.state === 'done' && v.done === 31));
      assert(runs.some((v: any) => v.state === 'done' && v.scanned === 0));
      const rows = (
        await pool.query('SELECT id,tags,note,status FROM orders WHERE tenant_id=$1 ORDER BY id', [
          tenant,
        ])
      ).rows;
      assert.equal(rows.length, 31);
      for (const o of rows) {
        assert.deepEqual(o.tags, ['do-kontaktu']);
        assert.equal(o.note, 'Zweryfikuj termin opłacenia');
        assert.equal(o.status, 'new');
      }
      const stock = (
        await pool.query(
          'SELECT on_hand,reserved FROM stock WHERE tenant_id=$1 AND product_id=$2',
          [tenant, d.fixture.product_id],
        )
      ).rows[0];
      assert.deepEqual(stock, { on_hand: 80, reserved: 31 });
      for (const t of tables)
        assert.deepEqual(
          await fingerprint(t, d.tenants),
          d.before[t],
          t + ' previous data changed',
        );
      const receipt = (
        await pool.query(
          'SELECT count(*)::int AS n FROM automation_schedule_receipts WHERE tenant_id=$1',
          [tenant],
        )
      ).rows[0].n;
      assert.equal(receipt, 31);
      const proof = {
        ...d.migration,
        fixture: d.fixture,
        schedule_id: s.id,
        runs: runs.map((v: any) => ({
          id: v.id,
          scheduled_for: v.scheduled_for,
          state: v.state,
          scanned: v.scanned,
          done: v.done,
          skipped: v.skipped,
          failed: v.failed,
          definition_version: v.definition_version,
        })),
        stock,
        receipts: receipt,
        notes_exactly_once: true,
        schedule_disabled: true,
        previous_rows_preserved: true,
      };
      await writeFile('docs/automation-schedules-qa.json', JSON.stringify(proof, null, 2) + '\n');
      await writeFile(
        'docs/openapi.json',
        JSON.stringify(await api('/developer/openapi'), null, 2) + '\n',
      );
      console.log(JSON.stringify(proof));
    } else throw Error('Unknown phase');
  }
} finally {
  await pool.end();
}
