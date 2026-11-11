// Native localhost only; synthetic organization. No real SMS is sent.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool, migrate } from '../server/db';
import { safeFetch } from '../server/integrations';
const file = 'data/sms-automations-stage028.json';
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
  'automation_schedules',
  'automation_schedule_runs',
  'automation_schedule_items',
  'automation_schedule_receipts',
  'sms_templates',
  'sms_batches',
  'sms_messages',
];

async function fingerprint(table: string, tenants: string[]) {
  const rows = (
    await pool.query(
      `SELECT (to_jsonb(t)-'automation_run_id'-'automation_schedule_run_id'-'order_batch_id'-'order_guard')::text AS row FROM ${table} t WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1`,
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
    const tenants = (await pool.query('SELECT id FROM tenants ORDER BY id')).rows.map((x) => x.id),
      before: any = {};
    for (const t of tables) before[t] = await fingerprint(t, tenants);
    await migrate();
    for (const t of tables) assert.deepEqual(await fingerprint(t, tenants), before[t]);
    await writeFile(
      file,
      JSON.stringify({
        tenants,
        before,
        migration: { revision: '028_sms_automations', previous_tables_preserved: tables.length },
      }),
      { mode: 0o600 },
    );
    console.log(
      JSON.stringify({
        migration: '028_sms_automations',
        previous_tables_preserved: tables.length,
      }),
    );
  } else {
    const d = JSON.parse(await readFile(file, 'utf8'));
    await api('/auth/login', 'POST', { email: 'admin@demo.local', password: 'DynaDemo!2026' });
    if (phase === 'setup') {
      assert(!d.fixture);
      const org = await api('/workspaces', 'POST', {
        name: 'QA SMS automatyzacje 20261004',
        currency: 'PLN',
        locale: 'pl-PL',
      });
      tenant = org.user.tenant_id;
      const wh = (await api('/warehouses')).data[0],
        p = await api('/products', 'POST', {
          sku: 'QA-SMS-028',
          name: 'Towar komunikacji QA',
          price: 1299,
          quantity: 10,
          warehouse_id: wh.id,
        });
      const orders = [];
      for (const [name, phone] of [
        ['QA Alicja', '500500500'],
        ['QA Bogdan', '+48 600 600 600'],
      ]) {
        const o = await api('/orders', 'POST', {
          customer_name: name,
          email: 'sms@example.test',
          warehouse_id: wh.id,
          address: { country: 'PL', phone },
          items: [{ product_id: p.id, quantity: 1 }],
        });
        orders.push({ id: o.id, number: o.number });
      }
      d.fixture = { tenant_id: tenant, product_id: p.id, orders };
      await writeFile(file, JSON.stringify(d), { mode: 0o600 });
      console.log(JSON.stringify(d.fixture));
    } else if (phase === 'trigger') {
      tenant = d.fixture.tenant_id;
      await api('/workspaces/switch', 'POST', { tenant_id: tenant });
      const wh = (await api('/warehouses')).data[0];
      const o = await api('/orders', 'POST', {
        customer_name: 'QA Celina reguła',
        email: 'sms@example.test',
        warehouse_id: wh.id,
        address: { country: 'PL', phone: '500500500' },
        items: [{ product_id: d.fixture.product_id, quantity: 1 }],
      });
      d.fixture.orders.push({ id: o.id, number: o.number });
      await writeFile(file, JSON.stringify(d), { mode: 0o600 });
      console.log(JSON.stringify({ created_order: o.id, number: o.number }));
    } else if (phase === 'verify') {
      tenant = d.fixture.tenant_id;
      await api('/workspaces/switch', 'POST', { tenant_id: tenant });
      const templates = (await api('/sms/templates')).data;
      assert.equal(templates.length, 1);
      const messages = (await api('/sms/messages')).data;
      assert(messages.length >= 7, 'Need rule, schedule, bulk and single action evidence');
      assert(
        messages.every(
          (m: any) => m.state === 'simulated' && m.mode === 'local' && m.result.delivered === false,
        ),
      );
      const origins = (await pool.query('SELECT * FROM sms_batches WHERE tenant_id=$1', [tenant]))
        .rows;
      assert(origins.some((b: any) => b.automation_run_id));
      assert(origins.some((b: any) => b.automation_schedule_run_id));
      assert(origins.some((b: any) => b.order_batch_id));
      assert(
        origins.some(
          (b: any) => !b.automation_run_id && !b.automation_schedule_run_id && !b.order_batch_id,
        ),
      );
      const jobs = (
        await pool.query(
          "SELECT count(*)::int AS n FROM jobs WHERE tenant_id=$1 AND kind='sms.test'",
          [tenant],
        )
      ).rows[0].n;
      assert.equal(jobs, messages.length);
      for (const t of tables)
        assert.deepEqual(
          await fingerprint(t, d.tenants),
          d.before[t],
          t + ' previous rows changed',
        );
      let tls: any;
      try {
        const r = await safeFetch('https://certificate-test.smsapi.com/', { method: 'GET' });
        tls = {
          url: 'https://certificate-test.smsapi.com/',
          status: r.status,
          body: (await r.text()).trim().slice(0, 80),
          scope: 'Public TLS/connectivity only; no account or SMS proof',
        };
      } catch {
        tls = { status: 'unavailable', scope: 'Public TLS only' };
      }
      const proof = {
        ...d.migration,
        fixture: d.fixture,
        template: { id: templates[0].id, name: templates[0].name, version: templates[0].version },
        messages: messages.map((m: any) => ({
          id: m.id,
          order_id: m.order_id,
          number: m.number,
          state: m.state,
          parts: m.parts,
          encoding: m.encoding,
          mode: m.mode,
          result: m.result,
          error: m.error,
        })),
        jobs,
        previous_business_fields_preserved: true,
        origins: origins.map((b: any) => ({
          id: b.id,
          rule: b.automation_run_id,
          schedule: b.automation_schedule_run_id,
          bulk: b.order_batch_id,
          order_guard: b.order_guard,
        })),
        real_sms_sent: 0,
        provider_account_verified: false,
        public_tls: tls,
      };
      await writeFile('docs/sms-automations-qa.json', JSON.stringify(proof, null, 2) + '\n');
      await writeFile(
        'docs/openapi.json',
        JSON.stringify(await api('/developer/openapi'), null, 2) + '\n',
      );
      console.log(JSON.stringify(proof));
    } else throw new Error('Unknown phase');
  }
} finally {
  await pool.end();
}
