// Local owned fixtures; credentials and raw mail remain in ignored data files.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { localSmtpPassword } from '../server/smtp';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { pool } from '../server/db';
import { decrypt } from '../server/security';
const file = 'data/email-stage083.json',
  phase = process.argv[2];
const tables = [
  'channels',
  'products',
  'stock',
  'orders',
  'order_items',
  'reservations',
  'documents',
  'shipments',
  'return_cases',
  'return_items',
  'payment_entries',
  'listings',
  'purchase_orders',
  'purchase_order_lines',
  'picking_waves',
  'picking_wave_orders',
  'amazon_fulfillment_plans',
  'email_templates',
  'email_batches',
  'email_messages',
  'automation_rules',
  'automation_schedules',
];
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
async function snapshot(tenants: string[]) {
  const out: any = {};
  for (const t of tables)
    out[t] = (
      await pool.query(
        `SELECT to_jsonb(t) row FROM ${t} t WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1`,
        [tenants],
      )
    ).rows.map((r) => r.row);
  return out;
}
async function accounts(users: string[]) {
  const out: any = {};
  for (const t of ['users', 'account_security'])
    out[t] = (
      await pool.query(
        `SELECT to_jsonb(t) row FROM ${t} t WHERE ${t === 'users' ? 'id' : 'user_id'}=ANY($1::uuid[]) ORDER BY 1`,
        [users],
      )
    ).rows.map((r) => r.row);
  return out;
}
let cookie = '';
async function api(path: string, method = 'GET', payload?: any, expected = 200) {
  const r = await fetch('http://127.0.0.1:4100/api' + path, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(payload ? { 'content-type': 'application/json' } : {}),
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  assert.equal(r.status, expected, path + ':' + r.status);
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
  return r.json() as any;
}
try {
  if (phase === 'baseline') {
    const tenants = (await pool.query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id),
      users = (await pool.query('SELECT id FROM users ORDER BY id')).rows.map((r) => r.id);
    await writeFile(
      file,
      JSON.stringify(
        {
          tenants,
          users,
          before: await snapshot(tenants),
          accounts: await accounts(users),
          baseline_at: new Date().toISOString(),
        },
        null,
        2,
      ),
      { flag: 'wx', mode: 0o600 },
    );
    console.log({
      prior_firms: tenants.length,
      prior_accounts: users.length,
      tables: tables.length,
    });
  } else {
    const s = JSON.parse(await readFile(file, 'utf8'));
    const save = () => writeFile(file, JSON.stringify(s, null, 2), { mode: 0o600 });
    if (phase === 'setup') {
      const h = await api('/health');
      assert.equal(h.schema_revision, '062_email_actions');
      assert(h.email_available);
      if (!s.tenant) {
        s.email = 'qa-email-083@demo.local';
        s.password = 'DynaEmail!2026';
        const signed = await api(
          '/auth/signup',
          'POST',
          {
            email: s.email,
            password: s.password,
            name: 'QA Email',
            organization: { name: 'QA Email 083' },
          },
          201,
        );
        s.user = signed.user.id;
        s.tenant = signed.user.tenant_id;
        s.cookie = cookie;
        await save();
      } else {
        await api('/auth/login', 'POST', { email: s.email, password: s.password });
        s.cookie = cookie;
      }
      s.warehouse = (await api('/warehouses')).data[0].id;
      s.product ??= (
        await pool.query("SELECT id FROM products WHERE tenant_id=$1 AND sku='QA-EMAIL-083'", [
          s.tenant,
        ])
      ).rows[0]?.id;
      s.product ??= (
        await api(
          '/products',
          'POST',
          {
            sku: 'QA-EMAIL-083',
            name: 'QA Produkt komunikacji email',
            price: 12345,
            quantity: 10,
            warehouse_id: s.warehouse,
          },
          201,
        )
      ).id;
      s.order ??= (
        await pool.query('SELECT id FROM orders WHERE tenant_id=$1 ORDER BY created_at', [s.tenant])
      ).rows[0]?.id;
      if (!s.order) {
        const o = await api(
          '/orders',
          'POST',
          {
            customer_name: 'QA Klient Email',
            email: 'qa-email-buyer@example.test',
            warehouse_id: s.warehouse,
            address: {
              country: 'PL',
              street: 'Testowa 1',
              city: 'Warszawa',
              postal_code: '00-001',
              phone: '500500500',
            },
            items: [{ product_id: s.product, quantity: 2 }],
          },
          201,
        );
        s.order = o.id;
      }
      let o = await api('/orders/' + s.order);
      s.number = o.number;
      await save();
      if (o.status === 'new')
        await api(`/orders/${o.id}/payments`, 'POST', {
          version: o.version,
          kind: 'receipt',
          amount: o.total,
          currency: o.currency,
          method: 'other',
          reference: 'QA083-BEZ-PRZELEWU',
          note: 'Lokalna deklaracja QA, bez transferu pieniędzy',
          client_key: randomUUID(),
          confirmed: true,
        });
      o = await api('/orders/' + s.order);
      if (o.status === 'paid') await api(`/orders/${o.id}/status`, 'PATCH', { status: 'picking' });
      o = await api('/orders/' + s.order);
      if (o.status === 'picking') {
        for (let i = Number(o.items[0].scanned); i < 2; i++)
          await api(`/orders/${o.id}/scan`, 'POST', { code: 'QA-EMAIL-083' });
        await api(`/orders/${o.id}/status`, 'PATCH', { status: 'packed' });
      }
      o = await api('/orders/' + s.order);
      // The browser test creates an order.shipped email rule and ships this packed order.

      s.channel ??= (await api('/integrations/smtp-example', 'POST', {})).channel_id;
      s.external_channel ??= (
        await pool.query(
          "SELECT id FROM channels WHERE tenant_id=$1 AND provider='smtp' AND settings->>'delivery'='external'",
          [s.tenant],
        )
      ).rows[0]?.id;
      s.external_channel ??= (
        await api(
          '/integrations',
          'POST',
          {
            provider: 'smtp',
            name: 'SMTP config QA — nieweryfikowane konto',
            mode: 'sandbox',
            settings: {
              host: 'smtp.example.com',
              port: '587',
              from_email: 'qa@example.test',
              from_name: 'QA konfiguracji',
            },
            credentials: { username: 'qa-only', password: 'QA083-NOT-A-PROVIDER-CREDENTIAL' },
          },
          200,
        )
      ).id;
      s.cookie = cookie;
      await save();
      console.log({
        tenant: s.tenant,
        order: s.order,
        number: s.number,
        shipment: 'packed_awaiting_UI',
        stock: { on_hand: 10, reserved: 2 },
        external_smtp: 'configuration_only_no_connection',
      });
    } else if (phase === 'final' || phase === 'runtime' || phase === 'runtime-final') {
      cookie = s.cookie;
      await api('/auth/login', 'POST', { email: s.email, password: s.password });
      s.cookie = cookie;
      await save();
      const h = await api('/health');
      assert.equal(h.schema_revision, '062_email_actions');
      s.document ??= (await api(`/orders/${s.order}/documents`, 'POST', { kind: 'invoice' })).id;
      await save();
      const messages = (await api('/email/messages?order_id=' + s.order)).data;
      const accepted = messages.filter((m: any) => m.state === 'smtp_accepted');
      assert.equal(accepted.length, 1);
      assert(accepted[0].automation_run_id);
      assert.equal(messages.filter((m: any) => m.state === 'simulated').length, 3);
      assert(messages.some((m: any) => m.automation_schedule_run_id));
      assert(messages.some((m: any) => m.order_batch_id));
      const ruleRun = (
        await pool.query('SELECT * FROM automation_runs WHERE id=$1', [
          accepted[0].automation_run_id,
        ])
      ).rows[0];
      assert.equal(ruleRun.state, 'done');
      assert.equal(ruleRun.result.actions[0].email.message_id, accepted[0].id);
      assert.equal(ruleRun.result.actions.length, 2);
      const scheduleMessage = messages.find((m: any) => m.automation_schedule_run_id);
      const scheduleRun = (
        await pool.query('SELECT * FROM automation_schedule_runs WHERE id=$1', [
          scheduleMessage.automation_schedule_run_id,
        ])
      ).rows[0];
      assert.equal(scheduleRun.state, 'done');
      assert.equal(scheduleRun.done, 1);
      const bulkMessage = messages.find((m: any) => m.order_batch_id);
      const bulk = (
        await pool.query('SELECT * FROM order_batches WHERE id=$1', [bulkMessage.order_batch_id])
      ).rows[0];
      assert.equal(bulk.state, 'done');
      const receipts = {
        rule: {
          id: ruleRun.id,
          state: ruleRun.state,
          actions: 2,
          email_message_id: accepted[0].id,
        },
        schedule: {
          id: scheduleRun.id,
          state: scheduleRun.state,
          done: 1,
          email_message_id: scheduleMessage.id,
        },
        bulk: { id: bulk.id, state: bulk.state, email_message_id: bulkMessage.id },
      };

      const m = accepted[0];
      assert.equal(m.result.delivered, false);
      assert.equal(m.result.local_sink, true);
      const o = await api('/orders/' + s.order);
      assert.equal(o.total, 24690);
      assert.equal(o.status, 'shipped');
      assert.match(m.payload.text, /246.90 PLN/);
      const tracking = (
        await pool.query(
          'SELECT tracking_number FROM shipments WHERE tenant_id=$1 AND order_id=$2',
          [s.tenant, s.order],
        )
      ).rows[0]?.tracking_number;
      assert(tracking && m.payload.text.includes(tracking));
      assert.deepEqual(
        (await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [s.product]))
          .rows,
        [{ on_hand: 8, reserved: 0 }],
      );
      const matches = [];
      for (const name of await readdir('data/smtp-mailbox')) {
        const path = 'data/smtp-mailbox/' + name;
        assert.equal((await stat(path)).mode & 0o777, 0o600);
        const raw = await readFile(path, 'utf8');
        assert(!raw.includes('qa-email-buyer'));
        const content = decrypt(raw) as any;
        const mime = Buffer.from(content.raw_base64, 'base64').toString('utf8');
        if (mime.includes('X-Dynaminds-Message: ' + m.id)) {
          assert.match(mime, /Content-Type: multipart\/alternative/);
          assert.match(mime, /To: qa-email-buyer@example.test/);
          matches.push({
            recipient: content.recipient,
            bytes: Buffer.byteLength(mime),
            sha256: digest(mime),
            message_id: m.result.message_id,
            accepted_at: content.accepted_at,
          });
        }
      }
      assert.equal(matches.length, 1);
      assert.equal(matches[0].recipient, 'qa-email-buyer@example.test');
      const current = await snapshot(s.tenants);
      const exact: any = {};
      const background: any[] = [];
      for (const t of tables) {
        if (t !== 'listings') {
          assert.deepEqual(current[t], s.before[t], t);
          exact[t] = { count: current[t].length, sha256: digest(current[t]) };
          continue;
        }
        const before = new Map(s.before[t].map((r: any) => [r.id, r]));
        assert.equal(current[t].length, s.before[t].length);
        for (const row of current[t]) {
          const old: any = before.get(row.id);
          assert(old);
          if (digest(row) !== digest(old)) {
            assert(
              [
                '3ebc91fb-8ed7-43f4-ab26-910abb745e7b',
                'c1958211-5be4-48f5-b742-049985fd9b3e',
              ].includes(row.id),
            );
            assert.equal(row.tenant_id, 'e0cc18c3-593e-4ccc-adde-db0f03c38409');
            const a = structuredClone(row),
              b = structuredClone(old);
            for (const x of [a, b]) {
              if (x.last_result?.odoo_catalog_sync) {
                delete x.last_result.odoo_catalog_sync.run_id;
                delete x.last_result.odoo_catalog_sync.observed_at;
              }
            }
            assert.deepEqual(a, b, 'Only known Odoo observation metadata may differ');
            background.push({
              table: t,
              id: row.id,
              fields: [
                'last_result.odoo_catalog_sync.run_id',
                'last_result.odoo_catalog_sync.observed_at',
              ],
              source: 'existing_local_hourly_schedule',
            });
          }
        }
        exact[t] = {
          count: current[t].length,
          exact: digest(current[t]) === digest(s.before[t]),
          only_background_metadata: background.length > 0,
        };
      }
      assert.deepEqual(await accounts(s.users), s.accounts);
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int n FROM jobs WHERE tenant_id=$1 AND kind='email.send' AND state IN ('pending','running')",
            [s.tenant],
          )
        ).rows[0].n,
        0,
      );
      if (phase === 'runtime-final')
        assert.equal(
          h.revision,
          execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        );
      const logs = ['data/dev-stage083.log', 'data/smtp-sink083.log'];
      for (const path of logs) {
        const log = await readFile(path, 'utf8');
        for (const secret of [
          s.password,
          s.cookie,
          localSmtpPassword(),
          'QA083-NOT-A-PROVIDER-CREDENTIAL',
        ])
          assert(!log.includes(secret), 'No credential literal in ' + path);
      }
      const report = {
        checked_at: new Date().toISOString(),
        secret_scan_logs: logs,
        no_secret_literals_in_logs: true,
        baseline_at: s.baseline_at,
        runtime: h,
        scope: 'local_SMTProtocol_not_external_provider',
        source_receipts: receipts,
        tenant_id: s.tenant,
        order: { id: s.order, number: s.number, total: 24690, status: 'shipped' },
        stock: { on_hand: 8, reserved: 0 },
        template_count: (await api('/email/templates')).data.length,
        message_states: messages.map((m: any) => ({ id: m.id, state: m.state })),
        rule_smtp_accepted: 1,
        schedule_simulated: 1,
        bulk_simulated: 1,
        single_action_simulated: 1,
        accepted_by_local_smtp: 1,
        delivered_external: 0,
        encrypted_local_receipt: matches[0],
        prior_firms: s.tenants.length,
        prior_accounts: s.users.length,
        prior_accounts_exact: true,
        prior_business: exact,
        background_changes: background,
        external_connection_verified: false,
        external_messages: 0,
        queue_drained: true,
      };
      await writeFile(
        phase === 'runtime-final'
          ? 'data/email-actions-runtime-final.json'
          : phase === 'runtime'
            ? 'docs/email-actions-runtime-qa.json'
            : 'docs/email-actions-native-qa.json',
        JSON.stringify(report, null, 2),
      );
      console.log({
        runtime: h.revision,
        local_smtp_receipts: 1,
        prior_firms: s.tenants.length,
        background_changes: background.length,
        stock: report.stock,
      });
    } else throw new Error('Unknown phase');
  }
} finally {
  await pool.end();
}
