import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { pool } from '../server/db';
const file = 'data/product-rules-stage098.json',
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
  'product_translations',
  'ai_catalog_drafts',
  'deepl_catalog_drafts',
  'deepl_catalog_batches',
  'shopify_account_bindings',
  'shopify_oauth_states',
  'shopify_translation_plans',
  'shopify_translation_observations',
  'shopify_translation_simulations',
  'shopify_translation_batches',
  'shopify_translation_batch_items',
  'customer_message_threads',
  'customer_messages',
];
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
async function fingerprints(ids: string[]) {
  const out: Record<string, string> = {};
  for (const t of tables)
    out[t] = hash(
      (
        await pool.query(
          `SELECT to_jsonb(t) row FROM ${t} t WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1`,
          [ids],
        )
      ).rows,
    );
  out.tenants = hash(
    (
      await pool.query(
        'SELECT to_jsonb(t) row FROM tenants t WHERE id=ANY($1::uuid[]) ORDER BY 1',
        [ids],
      )
    ).rows,
  );
  return out;
}
let cookie = '';
async function api(path: string, method = 'GET', body?: unknown, status = 200) {
  const r = await fetch('http://127.0.0.1:4100/api' + path, {
    method,
    headers: { cookie, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal(r.status, status, path);
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
  return r.json() as Promise<any>;
}
async function wait(id: string) {
  for (let n = 0; n < 100; n++) {
    const r = await api('/product-rule-runs/' + id);
    if (r.state !== 'queued') return r;
    await setTimeout(200);
  }
  throw Error('Own product rule job did not finish');
}
try {
  if (phase === 'baseline') {
    assert.equal(
      (await pool.query('SELECT name FROM migrations ORDER BY name DESC LIMIT 1')).rows[0].name,
      '075_customer_messages',
    );
    assert.equal(
      (await pool.query("SELECT to_regclass('public.product_rules') p")).rows[0].p,
      null,
    );
    const ids = (await pool.query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id),
      users = (await pool.query('SELECT id,email,name,password_hash FROM users ORDER BY id')).rows;
    await writeFile(
      file,
      JSON.stringify(
        {
          ids,
          userIds: users.map((u) => u.id),
          usersHash: hash(users),
          before: await fingerprints(ids),
        },
        null,
        2,
      ),
      { flag: 'wx', mode: 0o600 },
    );
    console.log({
      phase,
      prior_firms: ids.length,
      prior_users: users.length,
      business_tables: tables.length,
    });
  } else {
    const s = JSON.parse(await readFile(file, 'utf8'));
    const save = () => writeFile(file, JSON.stringify(s, null, 2), { mode: 0o600 });
    const health = await api('/health');
    assert.equal(health.schema_revision, '076_product_rules');
    assert(health.product_rules_available);
    if (process.env.PROOF_REVISION) assert.equal(health.revision, process.env.PROOF_REVISION);
    if (phase === 'setup') {
      assert(!s.tenant);
      s.email = 'qa-rules-098@demo.local';
      s.password = 'DynaRules!2026';
      const signup = await api(
        '/auth/signup',
        'POST',
        {
          email: s.email,
          password: s.password,
          name: 'QA reguł 098',
          organization: { name: 'QA reguły produktów 098' },
        },
        201,
      );
      s.tenant = signup.user.tenant_id;
      s.user = signup.user.id;
      await save();
      assert(!s.ids.includes(s.tenant));
      s.warehouse = (await api('/warehouses')).data[0].id;
      s.products = [];
      for (let i = 1; i <= 2; i++) {
        s.products.push(
          await api(
            '/products',
            'POST',
            {
              sku: 'QA098-' + i,
              name: 'Kubek reguł ' + i,
              price: 3500,
              quantity: 5,
              warehouse_id: s.warehouse,
              attributes: { Kolor: i === 1 ? 'czarny' : 'biały' },
            },
            201,
          ),
        );
        await save();
      }
      assert.deepEqual((await api('/product-rules')).data, []);
      console.log({ phase, own_new_firm: true, products: 2, external_requests: 0 });
    } else if (phase === 'exercise' || phase === 'verify') {
      await api('/auth/login', 'POST', { email: s.email, password: s.password });
      assert(!s.ids.includes(s.tenant));
      const rules = (await api('/product-rules')).data;
      const reviewed = rules.find((r: any) => r.name === 'Klasyfikacja QA098');
      assert(reviewed?.enabled && reviewed.event === 'product.updated');
      s.rule = reviewed.id;
      const history = (await api('/product-rule-runs')).data;
      const manual = history.filter((r: any) => r.origin === 'manual' && r.state === 'done');
      assert.equal(manual.length, 1);
      const m = await api('/product-rule-runs/' + manual[0].id);
      assert.equal(m.items.length, 2);
      assert.equal(m.result.changed, 2);
      s.manual = m.id;
      for (const item of m.items) {
        assert.equal(item.state, 'changed');
        assert.equal(item.projected.category, 'QA098 — reguły');
      }
      if (phase === 'exercise') {
        assert(!s.automatic);
        const p = await api('/products/' + s.products[0].id);
        await api('/products/' + p.id, 'PATCH', {
          ...p,
          category: 'Kontrola QA098',
          name: 'Kubek po edycji QA098',
        });
        const autos = (await api('/product-rule-runs')).data.filter(
          (r: any) => r.origin === 'catalog',
        );
        assert.equal(autos.length, 1);
        const applied = await wait(autos[0].id);
        assert.equal(applied.state, 'done');
        assert.equal(applied.result.changed, 1);
        s.automatic = applied.id;
        await save();
        const newRule = await api('/product-rules', 'POST', {
          client_key: randomUUID(),
          confirm_future_changes: true,
          definition: {
            name: 'Nowe produkty QA098',
            event: 'product.created',
            enabled: true,
            conditions: [{ field: 'sku', op: 'prefix', value: 'QA098-' }],
            actions: [{ type: 'set_attribute', key: 'Kontrola', value: 'automatyczna' }],
          },
        });
        s.createdRule = newRule.id;
        await save();
        s.third = await api(
          '/products',
          'POST',
          {
            sku: 'QA098-3',
            name: 'Kubek nowy QA098',
            price: 4500,
            quantity: 3,
            warehouse_id: s.warehouse,
          },
          201,
        );
        await save();
        const created = (await api('/product-rule-runs')).data.filter(
          (r: any) => r.event === 'product.created',
        );
        assert.equal(created.length, 1);
        const done = await wait(created[0].id);
        assert.equal(done.state, 'done');
        assert.equal(done.result.changed, 1);
        s.createdRun = done.id;
        await save();
      }
      assert(s.automatic && s.createdRun && s.third);
      const all = (await api('/product-rule-runs')).data;
      assert.equal(all.length, 3);
      assert(all.every((r: any) => r.state === 'done'));
      for (const old of s.products) {
        const p = await api('/products/' + old.id);
        assert.equal(p.category, 'QA098 — reguły');
        assert.equal(p.price, 3500);
        assert.equal(p.stock[0].on_hand, 5);
        assert.equal(p.stock[0].reserved, 0);
      }
      const third = await api('/products/' + s.third.id);
      assert.equal(third.attributes.Kontrola, 'automatyczna');
      assert.equal(third.price, 4500);
      assert.equal(third.stock[0].on_hand, 3);
      assert.equal(
        (
          await pool.query('SELECT count(*)::int n FROM product_rule_causes WHERE tenant_id=$1', [
            s.tenant,
          ])
        ).rows[0].n,
        2,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int n FROM jobs WHERE tenant_id=$1 AND kind<>'product.rules'",
            [s.tenant],
          )
        ).rows[0].n,
        0,
      );
      assert.deepEqual(await fingerprints(s.ids), s.before);
      const users = (
        await pool.query(
          'SELECT id,email,name,password_hash FROM users WHERE id=ANY($1::uuid[]) ORDER BY id',
          [s.userIds],
        )
      ).rows;
      assert.equal(hash(users), s.usersHash);
      assert.equal(
        (await pool.query('SELECT count(*)::int n FROM tenants')).rows[0].n,
        s.ids.length + 1,
      );
      assert.equal(
        (await pool.query('SELECT count(*)::int n FROM users')).rows[0].n,
        s.userIds.length + 1,
      );
      const report = {
        stage: 98,
        verified_at: new Date().toISOString(),
        full_native_restart_preserved: phase === 'verify',
        scope: 'local_native',
        revision: health.revision,
        schema: health.schema_revision,
        prior_firms: s.ids.length,
        prior_users: s.userIds.length,
        prior_business_fingerprints_equal: true,
        prior_user_fingerprint_equal: true,
        own_products: 3,
        manual_batch_products: 2,
        automatic_updated: 1,
        automatic_created: 1,
        completed_runs: 3,
        recursive_jobs: 0,
        prices_and_stock_unchanged_by_rules: true,
        external_requests: 0,
        provider_verified: false,
      };
      await writeFile('docs/product-rules-native-qa.json', JSON.stringify(report, null, 2) + '\n');
      await save();
      console.log(report);
    } else throw Error('Unknown phase');
  }
} finally {
  await pool.end();
}
