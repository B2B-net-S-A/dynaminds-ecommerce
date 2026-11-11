// Only a newly created local QA firm. Private baseline never enters the report.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { pool } from '../server/db';
const file = 'data/shopify-stage095b.json',
  phase = process.argv[2];
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
  'workspace_billing_accounts',
  'workspace_billing_previews',
  'workspace_billing_entries',
  'ai_catalog_drafts',
  'product_translations',
  'deepl_catalog_drafts',
  'deepl_catalog_batches',
  'shopify_account_bindings',
  'shopify_oauth_states',
];
const hash = (v: any) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
async function baseline(ids: string[]) {
  const result: Record<string, string> = {};
  for (const t of tables)
    result[t] = hash(
      (
        await pool.query(
          `SELECT to_jsonb(t) row FROM ${t} t WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1`,
          [ids],
        )
      ).rows,
    );
  result.tenants = hash(
    (
      await pool.query(
        'SELECT to_jsonb(t) row FROM tenants t WHERE id=ANY($1::uuid[]) ORDER BY 1',
        [ids],
      )
    ).rows,
  );
  return result;
}
let cookie = '';
async function api(p: string, m = 'GET', b?: any, status = 200) {
  const r = await fetch('http://127.0.0.1:4100/api' + p, {
    method: m,
    headers: { cookie, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: b === undefined ? undefined : JSON.stringify(b),
  });
  assert.equal(r.status, status, p + ' ' + (await r.clone().text()));
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
  return r.json() as any;
}
try {
  if (phase === 'baseline') {
    const ids = (await pool.query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id),
      users = (await pool.query('SELECT id,email,name,password_hash FROM users ORDER BY id')).rows;
    await writeFile(
      file,
      JSON.stringify(
        {
          ids,
          userIds: users.map((r) => r.id),
          usersHash: hash(users),
          before: await baseline(ids),
        },
        null,
        2,
      ),
      { flag: 'wx', mode: 0o600 },
    );
    console.log({
      prior_firms: ids.length,
      prior_users: users.length,
      business_tables: tables.length,
    });
  } else {
    const s = JSON.parse(await readFile(file, 'utf8')),
      save = () => writeFile(file, JSON.stringify(s, null, 2), { mode: 0o600 });
    const health = await api('/health');
    assert.equal(health.schema_revision, '073_shopify_translations');
    assert(health.shopify_translations_available);
    if (process.env.PROOF_REVISION) assert.equal(health.revision, process.env.PROOF_REVISION);
    if (phase === 'setup' || phase === 'finish-setup') {
      if (phase === 'setup') {
        assert(!s.tenant);
        s.email = 'qa-shopify-095b@demo.local';
        s.password = 'DynaShopifyPublish!2026';
        const u = await api(
          '/auth/signup',
          'POST',
          {
            email: s.email,
            password: s.password,
            name: 'QA Shopify95b',
            organization: { name: 'QA Shopify publikacja 095b' },
          },
          201,
        );
        s.tenant = u.user.tenant_id;
        s.user = u.user.id;
        await save();
        s.warehouse = (await api('/warehouses')).data[0].id;
        s.channel = (await api('/integrations/shopify-example', 'POST', {})).channel_id;
        const start = await api(`/integrations/${s.channel}/shopify-oauth/start`, 'POST', {
          translations_write: true,
        });
        await api('/oauth/shopify/finish', 'POST', { return_url: start.demo_return_url });
        s.deepl = (await api('/integrations/deepl-example', 'POST', {})).channel_id;
        s.product = await api(
          '/products',
          'POST',
          {
            sku: 'QA-SHOPIFY-095B',
            name: 'Kubek stalowy 350 ml',
            description: 'Kubek ze stali nierdzewnej. Pojemność 350 ml.',
            price: 3000,
            quantity: 10,
            warehouse_id: s.warehouse,
          },
          201,
        );
        await save();
        const draft = await api(
          `/products/${s.product.id}/deepl/preview`,
          'POST',
          {
            version: s.product.version,
            client_key: randomUUID(),
            channel_id: s.deepl,
            source_lang: 'pl',
            target_lang: 'de',
            formality: 'default',
          },
          201,
        );
        s.draft = draft.id;
        await save();
        await api(`/deepl/drafts/${draft.id}/queue`, 'POST', {
          confirm_external: true,
          max_characters: draft.characters,
        });
      } else await api('/auth/login', 'POST', { email: s.email, password: s.password });
      let ready = false;
      for (let i = 0; i < 100; i++) {
        const d = (await api(`/products/${s.product.id}/deepl`)).data.find(
          (d: any) => d.id === s.draft,
        );
        assert(d);
        if (d.state === 'ready') {
          ready = true;
          break;
        }
        assert(!['failed', 'cancelled'].includes(d.state));
        await setTimeout(100);
      }
      assert(ready);
      await api(`/deepl/drafts/${s.draft}/apply`, 'POST', {
        approve: true,
        version: s.product.version,
        name: 'Stahlbecher 350 ml',
        description: 'Becher aus Edelstahl. Volumen 350 ml.',
      });
      s.product = await api(`/products/${s.product.id}`);
      assert.equal(s.product.version, 2);
      s.listing = await api(`/integrations/${s.channel}/mappings`, 'POST', {
        external_id: 'gid://shopify/ProductVariant/701',
        sku: s.product.sku,
      });
      s.stockBefore = (
        await pool.query('SELECT to_jsonb(s) row FROM stock s WHERE tenant_id=$1 ORDER BY 1', [
          s.tenant,
        ])
      ).rows;
      await save();
      console.log({
        ready_for_UI: true,
        email: s.email,
        product: s.product.sku,
        local_language: 'de',
        simulation: true,
        external_requests: 0,
      });
    } else {
      await api('/auth/login', 'POST', { email: s.email, password: s.password });
      if (phase === 'order') {
        assert(!s.order);
        const p = s.product;
        s.order = (
          await api(
            '/orders',
            'POST',
            {
              customer_name: 'Kupujący QA95b',
              email: 'qa-shopify-buyer@example.test',
              warehouse_id: s.warehouse,
              items: [{ product_id: p.id, quantity: 2 }],
            },
            201,
          )
        ).id;
        await save();
        for (const status of ['paid', 'picking'])
          await api(`/orders/${s.order}/status`, 'PATCH', { status });
        for (let i = 0; i < 2; i++) await api(`/orders/${s.order}/scan`, 'POST', { code: p.sku });
        await api(`/orders/${s.order}/status`, 'PATCH', { status: 'packed' });
        await api(`/orders/${s.order}/ship-demo`, 'POST', {});
        s.invoice = (await api(`/orders/${s.order}/documents`, 'POST', { kind: 'invoice' })).id;
        const current = await api(`/orders/${s.order}`),
          item = current.items[0];
        s.return_id = (
          await api(
            `/orders/${s.order}/returns`,
            'POST',
            {
              client_key: randomUUID(),
              kind: 'return',
              reason: 'QA95b pełny zwrot po publikacji tłumaczeń Shopify',
              items: [{ item_id: item.id, quantity: 2 }],
            },
            201,
          )
        ).id;
        await save();
        await api(`/returns/${s.return_id}/receive`, 'POST', {
          version: (await api(`/returns/${s.return_id}`)).version,
          items: [{ item_id: item.id, accepted: 2, restocked: 2 }],
          note: 'QA95b',
        });
        s.correction = (await api(`/returns/${s.return_id}/document`, 'POST', {})).id;
        s.finalOrder = await api(`/orders/${s.order}`);
        assert.equal(s.finalOrder.total, 6000);
        s.finalProduct = await api(`/products/${p.id}`);
        assert.equal(s.finalProduct.version, 2);
        assert.equal(s.finalProduct.price, 3000);
        assert.equal(
          s.finalProduct.stock.reduce((n: number, r: any) => n + Number(r.on_hand), 0),
          10,
        );
        assert.equal(
          s.finalProduct.stock.reduce((n: number, r: any) => n + Number(r.reserved), 0),
          0,
        );
        await save();
        console.log({ order: s.finalOrder.number, total: 6000, full_return: true, stock: '10/0' });
      } else if (phase === 'verify') {
        const history = await api(`/products/${s.product.id}/shopify-translations`),
          plans = [];
        assert(history.available);
        assert.equal(history.product_version, 2);
        for (const head of history.data)
          plans.push(await api(`/shopify-translation-plans/${head.id}`));
        assert(plans.some((p) => p.state === 'done' && p.attempted_at));
        assert(plans.some((p) => p.state === 'done' && !p.attempted_at));
        assert(plans.some((p) => p.state === 'cancelled'));
        for (const p of plans.filter((p) => p.state === 'done')) {
          assert(p.result.confirmed);
          assert(p.result.fields.every((f: any) => f.confirmed));
          assert(p.remote_snapshot.simulation);
          assert.equal(p.local_snapshot.product_version, 2);
        }
        assert.equal(
          (
            await pool.query(
              'SELECT count(*)::int n FROM shopify_translation_claims c JOIN shopify_translation_plans p ON p.id=c.plan_id WHERE tenant_id=$1',
              [s.tenant],
            )
          ).rows[0].n,
          0,
        );
        assert.deepEqual(await api(`/orders/${s.order}`), s.finalOrder);
        assert.deepEqual(await api(`/products/${s.product.id}`), s.finalProduct);
        assert.deepEqual(await baseline(s.ids), s.before);
        assert.equal(
          hash(
            (
              await pool.query(
                'SELECT id,email,name,password_hash FROM users WHERE id=ANY($1::uuid[]) ORDER BY id',
                [s.userIds],
              )
            ).rows,
          ),
          s.usersHash,
        );
        for (const table of [
          'shopify_translation_plans',
          'shopify_translation_observations',
          'shopify_translation_simulations',
        ])
          assert.equal(
            (
              await pool.query(
                `SELECT count(*)::int n FROM ${table} WHERE tenant_id=ANY($1::uuid[])`,
                [s.ids],
              )
            ).rows[0].n,
            0,
          );
        const report = {
          stage: '095b',
          health,
          scope: 'own_local_simulation',
          provider_authenticated: false,
          external_writes: 0,
          goal_complete: false,
          local_language: 'de',
          target_language: 'de',
          plans: plans.map((p) => ({
            id: p.id,
            state: p.state,
            phase: p.phase,
            attempted: !!p.attempted_at,
            confirmed: p.result.confirmed ?? false,
            fields: p.result.fields ?? [],
            observations: p.observations.length,
          })),
          order: s.finalOrder.number,
          total: s.finalOrder.total,
          full_return: true,
          stock: '10/0',
          source_name: s.finalProduct.name,
          product_version: 2,
          price: 3000,
          prior_firms: s.ids.length,
          prior_users: s.userIds.length,
          preserved_tables: tables.length + 1,
          preserved: true,
          checked_at: new Date().toISOString(),
        };
        s.plan = plans.find((p) => p.state === 'done' && p.attempted_at).id;
        await save();
        await writeFile(
          'docs/shopify-translation-publication-native-qa.json',
          JSON.stringify(report, null, 2) + '\n',
        );
        console.log(report);
      } else throw Error('Unknown phase');
    }
  }
} finally {
  await pool.end();
}
