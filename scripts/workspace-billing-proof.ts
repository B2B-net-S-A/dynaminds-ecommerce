// Native QA belongs to one new firm. Calendar advancement is explicitly controlled, not real elapsed time.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
import { renewBillingDue } from '../server/workspace-billing';
const phase = process.argv[2],
  file = 'data/workspace-stage090.json';
const tables = [
  'channels',
  'products',
  'stock',
  'orders',
  'order_items',
  'reservations',
  'shipments',
  'documents',
  'return_cases',
  'return_items',
  'payment_entries',
  'warehouses',
  'memberships',
  'workspace_usage',
  'workspace_invitations',
  'shopify_webhook_configs',
  'shopify_webhook_deliveries',
  'shopify_webhook_simulations',
  'shopify_subscription_plans',
  'shopify_subscription_observations',
  'shopify_subscription_simulations',
];
async function snapshot(ids: string[]) {
  const r: any = {};
  for (const t of tables)
    r[t] = (
      await pool.query(
        `SELECT to_jsonb(t) row FROM ${t} t WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1`,
        [ids],
      )
    ).rows;
  r.tenants = (
    await pool.query('SELECT to_jsonb(t) row FROM tenants t WHERE id=ANY($1::uuid[]) ORDER BY 1', [
      ids,
    ])
  ).rows;
  return r;
}
let cookie = '';
async function api(path: string, method = 'GET', body?: any, status = 200) {
  const r = await fetch('http://127.0.0.1:4100/api' + path, {
    method,
    headers: { cookie, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal(r.status, status, path + ' ' + (await r.clone().text()));
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
  return r.json() as any;
}
try {
  if (phase === 'baseline') {
    const ids = (await pool.query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id),
      accounts = (await pool.query('SELECT id,email,password_hash,name FROM users ORDER BY id'))
        .rows;
    await writeFile(
      file,
      JSON.stringify(
        { ids, accounts, before: await snapshot(ids), baseline_at: new Date().toISOString() },
        null,
        2,
      ),
      { flag: 'wx', mode: 0o600 },
    );
    console.log({ prior_firms: ids.length, prior_accounts: accounts.length });
  } else {
    const s = JSON.parse(await readFile(file, 'utf8'));
    const save = () => writeFile(file, JSON.stringify(s, null, 2), { mode: 0o600 });
    if (phase === 'setup') {
      assert(!s.tenant);
      s.email = 'qa-billing-090@demo.local';
      s.password = 'DynaBilling!2026';
      const u = await api(
        '/auth/signup',
        'POST',
        {
          email: s.email,
          password: s.password,
          name: 'QA Abonament90',
          organization: { name: 'QA Abonament 090' },
        },
        201,
      );
      s.tenant = u.user.tenant_id;
      s.user = u.user.id;
      await save();
      s.warehouse = (await api('/warehouses')).data[0].id;
      assert.equal((await api('/workspaces/billing')).account, null);
      await api('/warehouses', 'POST', { name: 'Drugi magazyn QA90', code: 'QA90-2' }, 409);
      s.starter_limit_http = 409;
      await save();
      console.log({
        ready_for_UI: true,
        organization: 'QA Abonament 090',
        starter_second_warehouse: 409,
      });
    } else {
      await api('/auth/login', 'POST', { email: s.email, password: s.password });
      let b = await api('/workspaces/billing');
      if (phase === 'expand') {
        assert(!s.expanded_at);
        assert.equal(b.account.plan, 'business');
        assert.equal(b.entries.length, 1);
        s.second_warehouse = (
          await api('/warehouses', 'POST', { name: 'Drugi magazyn QA90', code: 'QA90-2' })
        ).id;
        s.product = (
          await api(
            '/products',
            'POST',
            {
              sku: 'QA-BILLING090',
              name: 'Produkt abonamentu90',
              price: 1500,
              quantity: 10,
              warehouse_id: s.warehouse,
            },
            201,
          )
        ).id;
        s.order = (
          await api(
            '/orders',
            'POST',
            {
              customer_name: 'Kupujący QA90',
              email: 'buyer90@example.test',
              warehouse_id: s.warehouse,
              items: [{ product_id: s.product, quantity: 2 }],
            },
            201,
          )
        ).id;
        await save();
        await api(`/orders/${s.order}/status`, 'PATCH', { status: 'paid' });
        await api(`/orders/${s.order}/status`, 'PATCH', { status: 'picking' });
        for (let i = 0; i < 2; i++)
          await api(`/orders/${s.order}/scan`, 'POST', { code: 'QA-BILLING090' });
        await api(`/orders/${s.order}/status`, 'PATCH', { status: 'packed' });
        await api(`/orders/${s.order}/ship-demo`, 'POST', {});
        s.document = (await api(`/orders/${s.order}/documents`, 'POST', { kind: 'invoice' })).id;
        const o = await api(`/orders/${s.order}`),
          item = o.items[0];
        s.number = o.number;
        const ret = await api(
          `/orders/${s.order}/returns`,
          'POST',
          {
            client_key: randomUUID(),
            kind: 'return',
            reason: 'QA90 lokalny proces abonamentu',
            items: [{ item_id: item.id, quantity: 2 }],
          },
          201,
        );
        s.return_id = ret.id;
        await api(`/returns/${ret.id}/receive`, 'POST', {
          version: (await api(`/returns/${ret.id}`)).version,
          note: 'QA90',
          items: [{ item_id: item.id, accepted: 2, restocked: 2 }],
        });
        s.correction = (await api(`/returns/${ret.id}/document`, 'POST', {})).id;
        s.historical = await api(`/orders/${s.order}`);
        s.expanded_at = new Date().toISOString();
        await save();
        console.log({
          business_second_warehouse: 200,
          order: s.number,
          full_local_OMS_return: true,
        });
      } else if (phase === 'blocked') {
        assert(s.expanded_at && !s.blocked_at);
        assert.equal(b.account.plan, 'enterprise');
        assert.equal(b.account.next_terms.plan, 'starter');
        assert.equal(b.account.auto_renew, true);
        assert.equal(b.entries.length, 3);
        s.before_renewal = b.entries;
        s.controlled_clock = new Date(b.account.period_end).toISOString();
        assert.deepEqual(await renewBillingDue(new Date(s.controlled_clock), s.tenant), {
          renewed: 0,
          blocked: 1,
        });
        b = await api('/workspaces/billing');
        assert.equal(b.account.plan, 'enterprise');
        assert.match(b.account.next_error, /warehouses/);
        assert.deepEqual(b.entries, s.before_renewal);
        s.blocked_at = new Date().toISOString();
        await save();
        console.log({
          controlled_calendar: true,
          downgrade_blocked: true,
          history_preserved: true,
        });
      } else if (phase === 'renew') {
        assert(s.blocked_at && !s.renewed_at);
        assert.equal(b.account.next_terms, null);
        assert.equal(b.account.auto_renew, true);
        const clock = new Date(new Date(s.controlled_clock).getTime() + 3600001);
        assert.deepEqual(await renewBillingDue(clock, s.tenant), { renewed: 1, blocked: 0 });
        assert.deepEqual(await renewBillingDue(clock, s.tenant), { renewed: 0, blocked: 0 });
        b = await api('/workspaces/billing');
        assert.equal(b.entries.length, 4);
        assert.equal(b.entries[0].kind, 'renew');
        assert.equal(b.entries[0].amount, 99900);
        s.renewed_at = new Date().toISOString();
        await save();
        console.log({
          renewed_once: true,
          full_month_example_amount: 99900,
          controlled_clock: clock.toISOString(),
        });
      } else if (phase === 'verify') {
        assert(s.renewed_at);
        assert.equal(b.account.auto_renew, false);
        assert.equal(b.account.plan, 'enterprise');
        assert.equal(b.account.next_terms, null);
        assert.equal(b.entries.length, 4);
        assert.equal(b.entries.filter((e: any) => e.kind === 'credit').length, 1);
        assert.deepEqual(await api(`/orders/${s.order}`), s.historical);
        assert.deepEqual(
          (
            await pool.query(
              'SELECT on_hand,reserved FROM stock WHERE tenant_id=$1 AND product_id=$2',
              [s.tenant, s.product],
            )
          ).rows,
          [{ on_hand: 10, reserved: 0 }],
        );
        assert.deepEqual(await snapshot(s.ids), s.before);
        assert.deepEqual(
          (
            await pool.query(
              'SELECT id,email,password_hash,name FROM users WHERE id=ANY($1::uuid[]) ORDER BY id',
              [s.accounts.map((a: any) => a.id)],
            )
          ).rows,
          s.accounts,
        );
        for (const t of [
          'workspace_billing_accounts',
          'workspace_billing_previews',
          'workspace_billing_entries',
        ])
          assert.equal(
            (
              await pool.query(`SELECT count(*)::int n FROM ${t} WHERE tenant_id=ANY($1::uuid[])`, [
                s.ids,
              ])
            ).rows[0].n,
            0,
          );
        const h = await api('/health');
        assert.equal(h.schema_revision, '068_workspace_billing');
        assert(h.workspace_billing_available);
        const report = {
          stage: 90,
          verified_at: new Date().toISOString(),
          baseline_at: s.baseline_at,
          runtime_revision: h.revision,
          schema: h.schema_revision,
          own_organization: s.tenant,
          mode: 'local_estimate',
          actual_payments: false,
          UI_activation_change_schedule_cancel_auto_manually_observed: true,
          UI_over_limit_commit_disabled: true,
          controlled_calendar_renewal: true,
          automatic_downgrade_blocked: true,
          renewal_duplicate_no_extra_entry: true,
          entries: 4,
          credits: 1,
          current_plan: 'enterprise',
          auto_renew: false,
          starter_second_warehouse: 409,
          business_second_warehouse: 200,
          OMS_order: s.number,
          total: s.historical.total,
          OMS_historical_exact: true,
          stock: { on_hand: 10, reserved: 0 },
          prior_firms_unchanged: s.ids.length,
          prior_accounts_unchanged: s.accounts.length,
          compared_business_tables: tables.length + 1,
          prior_firms_not_activated: true,
          goal_complete: false,
        };
        await writeFile(
          'data/workspace-billing-native-qa.json',
          JSON.stringify(report, null, 2) + '\n',
        );
        console.log(report);
      }
    }
  }
} finally {
  await pool.end();
}
