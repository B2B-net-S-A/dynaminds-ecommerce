// Only a newly created local QA firm. Private baseline never enters the report.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
const file = 'data/shopify-stage095.json',
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
    assert.equal(health.schema_revision, '072_deepl_batches');
    if (process.env.PROOF_REVISION) assert.equal(health.revision, process.env.PROOF_REVISION);
    if (phase === 'setup') {
      assert(!s.tenant, 'Own QA firm already exists');
      s.email = 'qa-shopify-095@demo.local';
      s.password = 'DynaShopifyTranslation!2026';
      const r = await api(
        '/auth/signup',
        'POST',
        {
          email: s.email,
          password: s.password,
          name: 'QA Shopify95',
          organization: { name: 'QA Shopify tłumaczenia 095' },
        },
        201,
      );
      s.tenant = r.user.tenant_id;
      s.user = r.user.id;
      s.channel = (await api('/integrations/shopify-example', 'POST', {})).channel_id;
      const start = await api(`/integrations/${s.channel}/shopify-oauth/start`, 'POST', {});
      await api('/oauth/shopify/finish', 'POST', { return_url: start.demo_return_url });
      await api(`/integrations/${s.channel}/shopify-locales`, 'GET', undefined, 403);
      await save();
      console.log({
        ready_for_UI: true,
        email: s.email,
        channel: s.channel,
        translation_permission: false,
      });
    } else {
      await api('/auth/login', 'POST', { email: s.email, password: s.password });
      if (phase === 'enable') {
        const start = await api(`/integrations/${s.channel}/shopify-oauth/start`, 'POST', {
          confirm_same_account: true,
          translations_write: true,
        });
        assert.deepEqual(start.requested_scopes, [
          'read_inventory',
          'read_locales',
          'read_locations',
          'read_orders',
          'read_products',
          'write_translations',
        ]);
        await api('/oauth/shopify/finish', 'POST', { return_url: start.demo_return_url });
        await save();
        console.log({ own_simulation_enabled: true, external_requests: 0 });
      } else if (phase === 'verify') {
        const account = await api(`/integrations/${s.channel}/shopify-account`),
          languages = await api(`/integrations/${s.channel}/shopify-locales`);
        assert(account.bound && account.grant_matches && account.source === 'simulation');
        assert(
          account.scopes.includes('write_translations') && account.scopes.includes('read_locales'),
        );
        assert.equal(languages.source, 'local_simulation');
        assert.deepEqual(
          languages.locales.map((l: any) => [l.locale, l.primary, l.published]),
          [
            ['pl', true, true],
            ['de', false, true],
            ['en', false, true],
            ['fr', false, false],
          ],
        );
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
        const states = (
          await pool.query(
            'SELECT state FROM shopify_oauth_states WHERE tenant_id=$1 ORDER BY created_at',
            [s.tenant],
          )
        ).rows;
        assert.equal(states.length, 2);
        assert(states.every((r) => r.state === 'done'));
        const report = {
          stage: '095a',
          health,
          scope: 'own_local_simulation',
          provider_authenticated: false,
          api_write_route: false,
          locales: languages.locales,
          oauth_states: states.length,
          prior_firms: s.ids.length,
          prior_users: s.userIds.length,
          preserved_tables: tables.length + 1,
          preserved: true,
        };
        await writeFile(
          'docs/shopify-translations-native-qa.json',
          JSON.stringify(report, null, 2) + '\n',
        );
        console.log(report);
      } else throw new Error('Unknown phase');
    }
  }
} finally {
  await pool.end();
}
