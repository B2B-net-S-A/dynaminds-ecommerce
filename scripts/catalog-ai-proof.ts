import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { pool } from '../server/db';
const phase = process.argv[2],
  file = 'data/catalog-ai-stage092.json';
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
async function snapshot(ids: string[]) {
  const s: any = {};
  for (const t of tables)
    s[t] = (
      await pool.query(
        `SELECT to_jsonb(t) row FROM ${t} t WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1`,
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
      s.email = 'qa-ai-092@demo.local';
      s.password = 'DynaLocalAi!2026';
      const u = await api(
        '/auth/signup',
        'POST',
        {
          email: s.email,
          password: s.password,
          name: 'QA Lokalny AI92',
          organization: { name: 'QA Local AI 092' },
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
            sku: 'QA-AI-092',
            name: 'Kubek stalowy 350 ml',
            description: 'Kubek wykonany ze stali nierdzewnej. Pojemność 350 ml. Kolor czarny.',
            attributes: { Materiał: 'stal nierdzewna', Pojemność: '350 ml', Kolor: 'czarny' },
            price: 3000,
            quantity: 10,
            warehouse_id: s.warehouse,
          },
          201,
        )
      ).id;
      s.source_product = await api('/products/' + s.product);
      await save();
      console.log({ organization: 'QA Local AI 092', product: 'QA-AI-092', ready_for_UI: true });
    } else {
      await api('/auth/login', 'POST', { email: s.email, password: s.password });
      if (phase === 'inspect') {
        const ai = await api('/products/' + s.product + '/ai');
        console.log({
          history: ai.data.map((d: any) => ({
            id: d.id,
            state: d.state,
            destination: d.destination,
            locale: d.locale,
            usage: d.usage,
            error: d.error,
          })),
          translations: ai.translations.map((t: any) => ({ locale: t.locale, name: t.name })),
        });
      } else if (phase === 'order') {
        assert(!s.order, 'QA order already exists; do not repeat the business flow');
        const history = await api('/products/' + s.product + '/ai');
        assert.equal(history.data.filter((d: any) => d.state === 'applied').length, 2);
        assert(history.translations.some((t: any) => t.locale === 'en'));
        s.ai_product = await api('/products/' + s.product);
        assert.equal(s.ai_product.version, 3);
        for (const k of [
          'sku',
          'price',
          'vat',
          'category',
          'attributes',
          'images',
          'active',
          'kind',
          'stock',
          'components',
        ])
          assert(isDeepStrictEqual(s.ai_product[k], s.source_product[k]), k);
        s.order = (
          await api(
            '/orders',
            'POST',
            {
              customer_name: 'Kupujący QA92',
              email: 'qa-ai-buyer@example.test',
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
          await api('/orders/' + s.order + '/scan', 'POST', { code: 'QA-AI-092' });
        await api('/orders/' + s.order + '/status', 'PATCH', { status: 'packed' });
        await api('/orders/' + s.order + '/ship-demo', 'POST', {});
        s.invoice = (
          await api('/orders/' + s.order + '/documents', 'POST', { kind: 'invoice' })
        ).id;
        const o = await api('/orders/' + s.order),
          item = o.items[0];
        assert.equal(o.total, 6000);
        s.order_snapshot = o;
        s.return_id = (
          await api(
            '/orders/' + s.order + '/returns',
            'POST',
            {
              client_key: randomUUID(),
              kind: 'return',
              reason: 'QA92 pełny zwrot po AI',
              items: [{ item_id: item.id, quantity: 2 }],
            },
            201,
          )
        ).id;
        await save();
        await api('/returns/' + s.return_id + '/receive', 'POST', {
          version: (await api('/returns/' + s.return_id)).version,
          items: [{ item_id: item.id, accepted: 2, restocked: 2 }],
          note: 'QA92',
        });
        s.correction = (await api('/returns/' + s.return_id + '/document', 'POST', {})).id;
        s.final_order = await api('/orders/' + s.order);
        s.final_product = await api('/products/' + s.product);
        assert(isDeepStrictEqual({ ...s.final_product, stock: s.ai_product.stock }, s.ai_product));
        assert.equal(s.final_product.stock.length, s.ai_product.stock.length);
        for (const row of s.final_product.stock) {
          const old = s.ai_product.stock.find((x: any) => x.warehouse_id === row.warehouse_id);
          assert(old);
          assert.equal(Number(row.version), Number(old.version) + 3);
          assert(isDeepStrictEqual({ ...row, version: old.version }, old));
        }
        s.completed_at = new Date().toISOString();
        await save();
        console.log({
          order: s.final_order.number,
          total: s.final_order.total,
          stock_expected: '10/0',
          return_received: true,
        });
      } else if (phase === 'verify') {
        assert(s.completed_at);
        const health = await api('/health');
        assert.equal(health.schema_revision, '070_catalog_ai');
        assert(health.catalog_ai_available);
        const p = await api('/products/' + s.product);
        assert(isDeepStrictEqual(p, s.final_product));
        assert(isDeepStrictEqual(await api('/orders/' + s.order), s.final_order));
        const hist = await api('/products/' + s.product + '/ai'),
          applied = hist.data.filter((d: any) => d.state === 'applied');
        assert.equal(applied.length, 2);
        assert.equal(hist.translations.length, 1);
        assert(
          applied.every(
            (d: any) =>
              d.usage.prompt_tokens > 0 &&
              d.usage.output_tokens > 0 &&
              (
                {
                  'qwen2.5:0.5b':
                    'a8b0c51577010a279d933d14c2a8ab4b268079d44c5c8830c0a93900f1827c67',
                  'qwen2.5:1.5b':
                    '65ec06548149b04c096a120e4a6da9d4017ea809c91734ea5631e89f96ddc57b',
                  'qwen2.5:7b': '845dbda0ea48ed749caafd9e6037047aa19acfcfd82e704d7ca97d631a0b697e',
                } as Record<string, string>
              )[d.model] === d.model_digest,
          ),
        );
        const stock = (
          await pool.query(
            'SELECT on_hand,reserved FROM stock WHERE tenant_id=$1 AND product_id=$2',
            [s.tenant, s.product],
          )
        ).rows;
        assert(isDeepStrictEqual(stock, [{ on_hand: 10, reserved: 0 }]));
        const now = await snapshot(s.ids),
          scheduler = [];
        for (const t of Object.keys(s.before)) {
          if (t !== 'order_status_configs') {
            assert(isDeepStrictEqual(now[t], s.before[t]), 'Prior table changed: ' + t);
            continue;
          }
          assert.equal(now[t].length, s.before[t].length);
          for (const { row: old } of s.before[t]) {
            const cur: any = now[t].find((r: any) => r.row.channel_id === old.channel_id)?.row;
            assert(cur);
            if (isDeepStrictEqual(cur, old)) continue;
            assert(
              [
                '728d4b12-8a88-4125-95c0-308e3bef3798',
                'fd17a7f8-b7ba-49f8-b65a-52e5050d2181',
              ].includes(old.channel_id),
            );
            const fields = Object.keys(old).filter((k) => !isDeepStrictEqual(cur[k], old[k]));
            assert(fields.every((k) => ['last_job_id', 'last_run_at', 'next_run_at'].includes(k)));
            const ch = s.before.channels.find((r: any) => r.row.id === old.channel_id)?.row;
            assert(ch?.settings.simulation && old.enabled);
            const job = (
              await pool.query('SELECT tenant_id,kind,payload FROM jobs WHERE id=$1', [
                cur.last_job_id,
              ])
            ).rows[0];
            assert.equal(job.tenant_id, old.tenant_id);
            assert.equal(job.kind, 'order.status.scan');
            assert.equal(job.payload.channel_id, old.channel_id);
            assert.equal(job.payload.version, old.version);
            scheduler.push({
              channel: old.channel_id,
              fields,
              reason: 'existing_local_minute_scan',
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
              'SELECT count(*)::int n FROM ai_catalog_drafts WHERE tenant_id=ANY($1::uuid[])',
              [s.ids],
            )
          ).rows[0].n,
          0,
        );
        const report = {
          stage: 92,
          verified_at: new Date().toISOString(),
          baseline_at: s.baseline_at,
          runtime_revision: health.revision,
          schema: health.schema_revision,
          organization: s.tenant,
          models: applied.map((d: any) => ({ name: d.model, digest: d.model_digest })),
          inference: 'actual_local_Ollama_0.35.1',
          generated_and_reviewed_in_UI: 2,
          cancelled_untranslated_drafts: hist.data
            .filter((d: any) => d.state === 'cancelled')
            .map((d: any) => ({ model: d.model, locale: d.locale })),
          applied_manual_corrections: applied.filter(
            (d: any) => !isDeepStrictEqual(d.output, d.reviewed_text),
          ).length,
          main_catalog_and_english_translation: true,
          usage: applied.map((d: any) => d.usage),
          order: s.final_order.number,
          total: s.final_order.total,
          stock: { on_hand: 10, reserved: 0 },
          history_after_return_and_restart_preserved: true,
          prior_firms_business_unchanged: s.ids.length,
          prior_accounts_unchanged: s.accounts.length,
          compared_prior_tables: 25,
          prior_tables_exact: 24,
          existing_scheduler_metadata_changes: scheduler,
          no_prior_firm_AI: true,
          external_model_calls: false,
          external_model_weight_downloads: true,
          actual_messages_payments_shipping: false,
          goal_complete: false,
        };
        await writeFile('data/catalog-ai-native-qa.json', JSON.stringify(report, null, 2) + '\n');
        console.log(report);
      }
    }
  }
} finally {
  await pool.end();
}
