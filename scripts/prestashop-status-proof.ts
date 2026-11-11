import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
const phase = process.argv[2],
  file = 'data/prestashop-stage091.json';
const tables = [
  'channels',
  'products',
  'stock',
  'stock_movements',
  'orders',
  'order_items',
  'order_pick_items',
  'order_events',
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
  'order_status_configs',
  'order_status_plans',
  'order_status_simulations',
  'workspace_billing_accounts',
  'workspace_billing_previews',
  'workspace_billing_entries',
];
async function snap(ids: string[]) {
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
        { ids, accounts, before: await snap(ids), baseline_at: new Date().toISOString() },
        null,
        2,
      ),
      { flag: 'wx', mode: 0o600 },
    );
    console.log({ prior_firms: ids.length, prior_accounts: accounts.length });
  } else {
    const s = JSON.parse(await readFile(file, 'utf8')),
      save = () => writeFile(file, JSON.stringify(s, null, 2), { mode: 0o600 });
    if (phase === 'setup') {
      assert(!s.tenant);
      s.email = 'qa-prestashop-091@demo.local';
      s.password = 'DynaPresta!2026';
      const u = await api(
        '/auth/signup',
        'POST',
        {
          email: s.email,
          password: s.password,
          name: 'QA Presta91',
          organization: { name: 'QA PrestaShop 091' },
        },
        201,
      );
      s.tenant = u.user.tenant_id;
      s.user = u.user.id;
      await save();
      s.warehouse = (await api('/warehouses')).data[0].id;
      s.product = (
        await api(
          '/products',
          'POST',
          {
            sku: 'QA-PS-STATUS091',
            name: 'Produkt realizacji PrestaShop',
            price: 1500,
            quantity: 10,
            warehouse_id: s.warehouse,
          },
          201,
        )
      ).id;
      const p = await api('/products/' + s.product);
      const example = await api('/integrations/prestashop-example', 'POST', {});
      s.channel = example.channel_id;
      s.inbound = example.data[0].id;
      await api('/integrations/' + s.channel + '/mappings', 'POST', {
        external_id: '701:0',
        sku: p.sku,
      });
      const imported = await api('/imports/' + s.inbound + '/commit', 'POST', {
        warehouse_id: s.warehouse,
      });
      s.order = imported.order?.id ?? imported.id;
      await save();
      await api('/orders/' + s.order + '/status', 'PATCH', { status: 'picking' });
      for (let i = 0; i < 2; i++)
        await api('/orders/' + s.order + '/scan', 'POST', { code: p.sku });
      await api('/orders/' + s.order + '/status', 'PATCH', { status: 'packed' });
      await api('/orders/' + s.order + '/ship-demo', 'POST', {});
      s.document = (await api('/orders/' + s.order + '/documents', 'POST', { kind: 'invoice' })).id;
      s.before_status = await api('/orders/' + s.order);
      s.number = s.before_status.number;
      s.setup_at = new Date().toISOString();
      await save();
      console.log({
        organization: 'QA PrestaShop 091',
        order: s.number,
        ready_for_UI: true,
        total: s.before_status.total,
      });
    } else {
      await api('/auth/login', 'POST', { email: s.email, password: s.password });
      if (phase === 'delivered') {
        const history = await api('/orders/' + s.order + '/channel-status');
        assert(history.data.some((p: any) => p.state === 'done' && p.result.status === '4'));
        assert.deepEqual(await api('/orders/' + s.order), s.before_status);
        await api('/orders/' + s.order + '/status', 'PATCH', { status: 'delivered' });
        s.delivered_at = new Date().toISOString();
        await save();
        console.log({ ready_for_automatic_status: true });
      } else if (phase === 'return') {
        const history = await api('/orders/' + s.order + '/channel-status');
        assert(history.data.some((p: any) => p.state === 'done' && p.result.status === '5'));
        assert.equal(history.config.enabled, false);
        const o = await api('/orders/' + s.order),
          item = o.items[0];
        s.return_id = (
          await api(
            '/orders/' + s.order + '/returns',
            'POST',
            {
              client_key: randomUUID(),
              kind: 'return',
              reason: 'QA91 pełny zwrot po potwierdzeniu statusu',
              items: [{ item_id: item.id, quantity: 2 }],
            },
            201,
          )
        ).id;
        await api('/returns/' + s.return_id + '/receive', 'POST', {
          version: (await api('/returns/' + s.return_id)).version,
          note: 'QA91',
          items: [{ item_id: item.id, accepted: 2, restocked: 2 }],
        });
        s.correction = (await api('/returns/' + s.return_id + '/document', 'POST', {})).id;
        s.after_return = await api('/orders/' + s.order);
        s.returned_at = new Date().toISOString();
        await save();
        console.log({ return_received: true, stock_expected: '10/0', history_expected: 2 });
      } else if (phase === 'audit') {
        const current = await snap(s.ids);
        for (const t of Object.keys(s.before)) {
          if (isDeepStrictEqual(s.before[t], current[t])) continue;
          const oldRows = s.before[t].map((r: any) => r.row),
            newRows = current[t].map((r: any) => r.row);
          const key = (r: any) =>
            JSON.stringify([
              r.tenant_id,
              r.id,
              r.channel_id,
              r.order_id,
              r.product_id,
              r.warehouse_id,
              r.user_id,
            ]);
          const changed = [];
          for (const old of oldRows) {
            const now = newRows.find((r: any) => key(r) === key(old));
            if (!isDeepStrictEqual(old, now))
              changed.push({
                id: old.id,
                channel_id: old.channel_id,
                enabled: old.enabled,
                fields: now
                  ? Object.keys(old).filter((k) => !isDeepStrictEqual(old[k], now[k]))
                  : ['missing'],
              });
          }
          if (changed.length || oldRows.length !== newRows.length)
            console.log(
              JSON.stringify(
                { table: t, before_count: oldRows.length, after_count: newRows.length, changed },
                null,
                2,
              ),
            );
        }
      } else if (phase === 'verify') {
        assert(s.returned_at);
        const h = await api('/health');
        assert.equal(h.schema_revision, '069_prestashop_status');
        const history = await api('/orders/' + s.order + '/channel-status');
        assert.equal(history.config.enabled, false);
        assert.equal(history.target, null);
        assert.equal(history.data.filter((p: any) => p.state === 'done').length, 2);
        assert(history.data.some((p: any) => p.config_version !== null && p.result.status === '5'));
        assert.deepEqual(await api('/orders/' + s.order), s.after_return);
        const stock = (
          await pool.query(
            'SELECT on_hand,reserved FROM stock WHERE tenant_id=$1 AND product_id=$2',
            [s.tenant, s.product],
          )
        ).rows;
        assert.deepEqual(stock, [{ on_hand: 10, reserved: 0 }]);
        const current = await snap(s.ids);
        const schedulerChanges = [];
        const expectedExistingChannels = [
          '728d4b12-8a88-4125-95c0-308e3bef3798',
          'fd17a7f8-b7ba-49f8-b65a-52e5050d2181',
        ];
        for (const t of Object.keys(s.before)) {
          if (t !== 'order_status_configs') {
            assert(isDeepStrictEqual(current[t], s.before[t]), 'Prior table changed: ' + t);
            continue;
          }
          assert.equal(current[t].length, s.before[t].length);
          for (const { row: old } of s.before[t]) {
            const now: any = current[t].find((r: any) => r.row.channel_id === old.channel_id)?.row;
            assert(now);
            if (isDeepStrictEqual(now, old)) continue;
            assert(expectedExistingChannels.includes(old.channel_id));
            const channel = s.before.channels.find((r: any) => r.row.id === old.channel_id)?.row;
            assert(
              channel?.settings.simulation && ['woocommerce', 'allegro'].includes(channel.provider),
            );
            assert.equal(old.enabled, true);
            const fields = Object.keys(old).filter((k) => !isDeepStrictEqual(old[k], now[k]));
            assert(fields.every((k) => ['last_job_id', 'last_run_at', 'next_run_at'].includes(k)));
            for (const k of ['last_run_at', 'next_run_at'])
              assert(new Date(now[k]).getTime() >= new Date(old[k]).getTime());
            const job = (
              await pool.query('SELECT tenant_id,kind,payload FROM jobs WHERE id=$1', [
                now.last_job_id,
              ])
            ).rows[0];
            assert.equal(job.tenant_id, old.tenant_id);
            assert.equal(job.kind, 'order.status.scan');
            assert.equal(job.payload.channel_id, old.channel_id);
            assert.equal(job.payload.version, old.version);
            schedulerChanges.push({
              channel: old.channel_id,
              provider: channel.provider,
              fields,
              reason: 'existing_enabled_local_minute_scan',
            });
          }
        }
        const priorAccounts = (
          await pool.query(
            'SELECT id,email,password_hash,name FROM users WHERE id=ANY($1::uuid[]) ORDER BY id',
            [s.accounts.map((a: any) => a.id)],
          )
        ).rows;
        assert(isDeepStrictEqual(priorAccounts, s.accounts), 'Prior accounts changed');
        assert.equal(
          (
            await pool.query(
              'SELECT count(*)::int n FROM prestashop_status_claims WHERE tenant_id=ANY($1::uuid[])',
              [s.ids],
            )
          ).rows[0].n,
          0,
        );
        const report = {
          stage: 91,
          verified_at: new Date().toISOString(),
          baseline_at: s.baseline_at,
          runtime_revision: h.revision,
          schema: h.schema_revision,
          organization: s.tenant,
          order: s.number,
          total: s.after_return.total,
          manual_status: '4',
          automatic_status: '5',
          confirmed_plans: 2,
          auto_enabled: false,
          UI_mapping_preview_queue_enable_disable_observed: true,
          history_after_return_preserved: true,
          stock: { on_hand: 10, reserved: 0 },
          prior_firms_business_and_config_unchanged_except_existing_scheduler_metadata:
            s.ids.length,
          prior_accounts_unchanged: s.accounts.length,
          compared_business_tables: tables.length + 1,
          prior_tables_exact: tables.length,
          existing_scheduler_metadata_changes: schedulerChanges,
          native_transport: 'explicit_local_simulation',
          provider_account_verified: false,
          actual_external_writes: false,
          goal_complete: false,
        };
        await writeFile(
          'data/prestashop-status-native-qa.json',
          JSON.stringify(report, null, 2) + '\n',
        );
        console.log(report);
      }
    }
  }
} finally {
  await pool.end();
}
