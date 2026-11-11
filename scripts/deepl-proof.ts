import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { pool } from '../server/db';
const phase = process.argv[2],
  file = 'data/deepl-stage093.json';
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
  'ai_catalog_drafts',
  'product_translations',
];
async function snapshot(ids: string[]) {
  const s: any = {};
  for (const t of tables)
    s[t] = (
      await pool.query(
        `SELECT to_jsonb(t)-'deepl_draft_id' row FROM ${t} t WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1`,
        [ids],
      )
    ).rows;
  s.tenants = (
    await pool.query('SELECT to_jsonb(t) row FROM tenants t WHERE id=ANY($1::uuid[]) ORDER BY 1', [
      ids,
    ])
  ).rows;
  return s;
}
let cookie = '';
async function api(path: string, method = 'GET', body?: any, status = 200) {
  const r = await fetch('http://127.0.0.1:4100/api' + path, {
    method,
    headers: { cookie, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal(r.status, status, path);
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
  return (await r.json()) as any;
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
      { mode: 0o600, flag: 'wx' },
    );
    console.log({ prior_firms: ids.length, prior_accounts: accounts.length });
  } else {
    const s = JSON.parse(await readFile(file, 'utf8')),
      save = () => writeFile(file, JSON.stringify(s, null, 2), { mode: 0o600 });
    if (phase === 'setup') {
      assert(!s.tenant);
      s.email = 'qa-deepl-093@demo.local';
      s.password = 'DynaLocalDeepL!2026';
      const u = await api(
        '/auth/signup',
        'POST',
        {
          email: s.email,
          password: s.password,
          name: 'QA DeepL93',
          organization: { name: 'QA DeepL 093' },
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
            sku: 'QA-DEEPL-093',
            name: 'Kubek stalowy 350 ml',
            description: 'Kubek ze stali nierdzewnej. Pojemność 350 ml. Kolor czarny.',
            attributes: { Materiał: 'stal nierdzewna', Pojemność: '350 ml', Kolor: 'czarny' },
            price: 3000,
            quantity: 10,
            warehouse_id: s.warehouse,
          },
          201,
        )
      ).id;
      s.source_product = await api('/products/' + s.product);
      s.channel = (await api('/integrations/deepl-example', 'POST', {})).channel_id;
      await save();
      console.log({ organization: 'QA DeepL 093', sku: 'QA-DEEPL-093', ready_for_UI: true });
    } else {
      await api('/auth/login', 'POST', { email: s.email, password: s.password });
      if (phase === 'inspect') {
        const h = await api('/products/' + s.product + '/deepl');
        console.log({
          drafts: h.data.map((d: any) => ({
            id: d.id,
            state: d.state,
            source: d.source_lang,
            target: d.target_lang,
            simulation: d.simulation,
            characters: d.characters,
            output: d.output,
            reviewed: d.reviewed_text,
            usage: d.usage,
          })),
          translations: h.translations.map((t: any) => ({ locale: t.locale, name: t.name })),
        });
      } else if (phase === 'order') {
        assert(!s.order, 'QA order already exists; do not repeat');
        const h = await api('/products/' + s.product + '/deepl');
        assert.equal(h.data.filter((d: any) => d.state === 'applied').length, 1);
        assert.equal(h.data.filter((d: any) => d.state === 'cancelled').length, 1);
        assert.equal(h.translations[0].locale, 'en-us');
        s.translated_product = await api('/products/' + s.product);
        assert.equal(s.translated_product.version, 2);
        for (const k of Object.keys(s.source_product).filter((k) => k !== 'version'))
          assert(isDeepStrictEqual(s.translated_product[k], s.source_product[k]), k);
        s.order = (
          await api(
            '/orders',
            'POST',
            {
              customer_name: 'Kupujący QA93',
              email: 'qa-deepl-buyer@example.test',
              warehouse_id: s.warehouse,
              items: [{ product_id: s.product, quantity: 2 }],
            },
            201,
          )
        ).id;
        await save();
        for (const status of ['paid', 'picking'])
          await api('/orders/' + s.order + '/status', 'PATCH', { status });
        for (let i = 0; i < 2; i++)
          await api('/orders/' + s.order + '/scan', 'POST', { code: 'QA-DEEPL-093' });
        await api('/orders/' + s.order + '/status', 'PATCH', { status: 'packed' });
        await api('/orders/' + s.order + '/ship-demo', 'POST', {});
        s.invoice = (
          await api('/orders/' + s.order + '/documents', 'POST', { kind: 'invoice' })
        ).id;
        const o = await api('/orders/' + s.order),
          item = o.items[0];
        assert.equal(o.total, 6000);
        s.return_id = (
          await api(
            '/orders/' + s.order + '/returns',
            'POST',
            {
              client_key: randomUUID(),
              kind: 'return',
              reason: 'QA93 pełny zwrot po DeepL',
              items: [{ item_id: item.id, quantity: 2 }],
            },
            201,
          )
        ).id;
        await save();
        await api('/returns/' + s.return_id + '/receive', 'POST', {
          version: (await api('/returns/' + s.return_id)).version,
          items: [{ item_id: item.id, accepted: 2, restocked: 2 }],
          note: 'QA93',
        });
        s.correction = (await api('/returns/' + s.return_id + '/document', 'POST', {})).id;
        s.final_order = await api('/orders/' + s.order);
        s.final_product = await api('/products/' + s.product);
        assert(
          isDeepStrictEqual(
            { ...s.final_product, stock: s.translated_product.stock },
            s.translated_product,
          ),
        );
        for (const row of s.final_product.stock) {
          const old = s.translated_product.stock.find(
            (x: any) => x.warehouse_id === row.warehouse_id,
          );
          assert.equal(Number(row.version), Number(old.version) + 3);
          assert(isDeepStrictEqual({ ...row, version: old.version }, old));
        }
        s.completed_at = new Date().toISOString();
        await save();
        console.log({ order: s.final_order.number, total: 6000, stock: '10/0', returned: true });
      } else if (phase === 'verify') {
        assert(s.completed_at);
        const health = await api('/health');
        assert.equal(health.schema_revision, '071_deepl');
        assert(health.deepl_available);
        assert(isDeepStrictEqual(await api('/products/' + s.product), s.final_product));
        assert(isDeepStrictEqual(await api('/orders/' + s.order), s.final_order));
        const h = await api('/products/' + s.product + '/deepl'),
          applied = h.data.filter((d: any) => d.state === 'applied');
        assert.equal(applied.length, 1);
        assert.equal(h.data.filter((d: any) => d.state === 'cancelled').length, 1);
        assert.equal(h.translations.length, 1);
        assert(applied[0].simulation);
        assert(!isDeepStrictEqual(applied[0].output, applied[0].reviewed_text));
        const now = await snapshot(s.ids),
          scheduler = [];
        for (const t of Object.keys(s.before))
          if (t !== 'order_status_configs')
            assert(isDeepStrictEqual(now[t], s.before[t]), 'Previous firm table ' + t);
        assert.equal(now.order_status_configs.length, s.before.order_status_configs.length);
        for (const oldRow of s.before.order_status_configs) {
          const old = oldRow.row,
            cur = now.order_status_configs.find(
              (x: any) => x.row.channel_id === old.channel_id,
            )?.row;
          assert(cur);
          const stripped = (r: any) =>
            Object.fromEntries(
              Object.entries(r).filter(
                ([k]) => !['last_job_id', 'last_run_at', 'next_run_at'].includes(k),
              ),
            );
          assert(isDeepStrictEqual(stripped(cur), stripped(old)));
          if (!isDeepStrictEqual(cur, old)) {
            assert(
              [
                '728d4b12-8a88-4125-95c0-308e3bef3798',
                'fd17a7f8-b7ba-49f8-b65a-52e5050d2181',
              ].includes(old.channel_id),
            );
            const ch = s.before.channels.find((x: any) => x.row.id === old.channel_id)?.row;
            assert(ch.settings.simulation && old.enabled);
            const j = (
              await pool.query('SELECT tenant_id,kind,payload FROM jobs WHERE id=$1', [
                cur.last_job_id,
              ])
            ).rows[0];
            assert.equal(j.tenant_id, old.tenant_id);
            assert.equal(j.kind, 'order.status.scan');
            assert.equal(j.payload.channel_id, old.channel_id);
            assert.equal(j.payload.version, old.version);
            scheduler.push({
              channel: old.channel_id,
              fields: ['last_job_id', 'last_run_at', 'next_run_at'],
            });
          }
        }
        assert(
          isDeepStrictEqual(
            (
              await pool.query(
                'SELECT id,email,password_hash,name FROM users WHERE id=ANY($1::uuid[]) ORDER BY id',
                [s.accounts.map((a: any) => a.id)],
              )
            ).rows,
            s.accounts,
          ),
        );
        assert.equal(
          (
            await pool.query(
              'SELECT count(*)::int n FROM deepl_catalog_drafts WHERE tenant_id=ANY($1::uuid[])',
              [s.ids],
            )
          ).rows[0].n,
          0,
        );
        assert.equal(
          (
            await pool.query(
              'SELECT count(*)::int n FROM product_translations WHERE tenant_id=ANY($1::uuid[]) AND deepl_draft_id IS NOT NULL',
              [s.ids],
            )
          ).rows[0].n,
          0,
        );
        const configuredAccounts = (
          await pool.query(
            "SELECT count(*)::int n FROM channels WHERE provider='deepl' AND settings->>'simulation' IS DISTINCT FROM 'true'",
          )
        ).rows[0].n;
        assert.equal(configuredAccounts, 0);
        const report = {
          stage: 93,
          verified_at: new Date().toISOString(),
          baseline_at: s.baseline_at,
          runtime_revision: health.revision,
          UI_workflow_revision: '16a0aa10337d7311a5d2364140211696c904d2cd',
          schema: health.schema_revision,
          organization: s.tenant,
          provider_mode: 'explicit_local_simulation',
          authenticated_DeepL: false,
          actual_configured_DeepL_accounts: configuredAccounts,
          UI_preview_queue_review_apply: true,
          manual_review_preserved: true,
          cancelled_before_dispatch: true,
          history_after_restart_preserved: true,
          source_catalog_stock_prices_preserved: true,
          locale: 'en-us',
          usage: applied[0].usage,
          order: s.final_order.number,
          total: 6000,
          stock: { on_hand: 10, reserved: 0 },
          prior_firms_business_unchanged: s.ids.length,
          prior_accounts_unchanged: s.accounts.length,
          compared_prior_tables: tables.length + 1,
          prior_tables_exact: tables.length,
          existing_scheduler_metadata_changes: scheduler,
          nullable_deepl_provenance_column_added_to_prior_translations: true,
          real_messages_payments_shipping: false,
          goal_complete: false,
        };
        await writeFile('data/deepl-native-qa.json', JSON.stringify(report, null, 2) + '\n');
        console.log(report);
      }
    }
  }
} finally {
  await pool.end();
}
