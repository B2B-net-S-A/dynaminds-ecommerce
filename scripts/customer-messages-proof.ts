import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';

const file = 'data/customer-messages-stage097.json';
const phase = process.argv[2];
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
];
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
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
async function api(
  path: string,
  method = 'GET',
  body?: unknown,
  expected = 200,
  publicCall = false,
) {
  const response = await fetch('http://127.0.0.1:4100/api' + path, {
    method,
    headers: {
      cookie: publicCall ? '' : cookie,
      'Content-Type': 'application/json',
      'Idempotency-Key': randomUUID(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // Portal tokens are intentionally absent from diagnostic labels.
  assert.equal(response.status, expected, publicCall ? 'Public portal request failed' : path);
  if (!publicCall && response.headers.get('set-cookie'))
    cookie = response.headers.get('set-cookie')!.split(';')[0];
  return response.json() as Promise<any>;
}
try {
  if (phase === 'baseline') {
    assert.equal(
      (await pool.query('SELECT name FROM migrations ORDER BY name DESC LIMIT 1')).rows[0].name,
      '074_shopify_translation_batches',
    );
    assert.equal(
      (await pool.query("SELECT to_regclass('public.customer_messages') present")).rows[0].present,
      null,
    );
    const ids = (await pool.query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id);
    const users = (await pool.query('SELECT id,email,name,password_hash FROM users ORDER BY id'))
      .rows;
    await writeFile(
      file,
      JSON.stringify(
        {
          ids,
          userIds: users.map((u) => u.id),
          usersHash: hash(users),
          before: await baseline(ids),
        },
        null,
        2,
      ),
      { mode: 0o600, flag: 'wx' },
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
    assert.equal(health.schema_revision, '075_customer_messages');
    assert(health.customer_messages_available);
    if (process.env.PROOF_REVISION) assert.equal(health.revision, process.env.PROOF_REVISION);
    if (phase === 'setup' || phase === 'finish-setup') {
      if (phase === 'setup') {
        assert(!s.tenant, 'Use finish-setup for the already created own firm');
        s.email = 'qa-messages-097@demo.local';
        s.password = 'DynaMessages!2026';
        const u = await api(
          '/auth/signup',
          'POST',
          {
            email: s.email,
            password: s.password,
            name: 'QA wiadomości 097',
            organization: { name: 'QA kontakt kupującego 097' },
          },
          201,
        );
        s.tenant = u.user.tenant_id;
        s.user = u.user.id;
        await save();
      } else await api('/auth/login', 'POST', { email: s.email, password: s.password });
      assert(!s.ids.includes(s.tenant));
      s.warehouse ??= (await api('/warehouses')).data[0].id;
      if (!s.product) {
        s.product = await api(
          '/products',
          'POST',
          {
            name: 'Kubek kontakt QA097',
            sku: 'QA-MESSAGES-097',
            price: 3000,
            quantity: 10,
            warehouse_id: s.warehouse,
          },
          201,
        );
        await save();
      }
      if (!s.order) {
        s.order = await api(
          '/orders',
          'POST',
          {
            customer_name: 'Kupujący QA097',
            email: 'qa-messages-buyer@example.test',
            warehouse_id: s.warehouse,
            items: [{ product_id: s.product.id, quantity: 2 }],
            note: 'QA097 notatka wewnętrzna zamówienia',
          },
          201,
        );
        await save();
      }
      s.order = await api(`/orders/${s.order.id}`);
      s.token = s.order.portal_token;
      assert.match(s.token, /^[a-f0-9]{48}$/);
      assert.equal((await api('/customer-messages')).data.length, 0);
      assert.deepEqual(
        (await api(`/public/orders/${s.token}/messages`, 'GET', undefined, 200, true)).data,
        [],
      );
      s.beforeProducts = (await api('/products')).data;
      await save();
      console.log({
        phase,
        order: s.order.number,
        products: 1,
        own_new_firm: true,
        external_requests: 0,
      });
    } else if (phase === 'verify' || phase === 'rotate') {
      await api('/auth/login', 'POST', { email: s.email, password: s.password });
      assert(!s.ids.includes(s.tenant));
      const history = await api('/customer-messages');
      assert.equal(history.data.length, 1);
      const head = history.data[0];
      assert.equal(head.order_id, s.order.id);
      const detail = await api(`/customer-messages/${head.id}`);
      const publicHistory = await api(
        `/public/orders/${s.token}/messages`,
        'GET',
        undefined,
        200,
        true,
      );
      const stored = (
        await pool.query(
          "SELECT client_key,body,kind FROM customer_messages WHERE tenant_id=$1 AND thread_id=$2 AND kind IN ('buyer','reply') ORDER BY created_at LIMIT 2",
          [s.tenant, head.id],
        )
      ).rows;
      for (const m of stored) {
        const replay = await api(
          m.kind === 'buyer'
            ? `/public/orders/${s.token}/messages`
            : `/customer-messages/${head.id}/reply`,
          'POST',
          { client_key: m.client_key, body: m.body },
          200,
          m.kind === 'buyer',
        );
        assert(replay.reused);
      }
      assert.deepEqual(await api(`/customer-messages/${head.id}`), detail);
      assert(detail.data.some((m: any) => m.kind === 'buyer'));
      assert(detail.data.some((m: any) => m.kind === 'reply'));
      assert(detail.data.some((m: any) => m.kind === 'note'));
      assert.equal(
        publicHistory.data.length,
        detail.data.filter((m: any) => m.kind !== 'note').length,
      );
      for (const m of publicHistory.data) {
        assert.deepEqual(Object.keys(m).sort(), ['body', 'created_at', 'id', 'kind']);
        assert.notEqual(m.kind, 'note');
        assert(!detail.data.some((d: any) => d.id === m.id));
      }
      for (const m of detail.data.filter((m: any) => m.kind === 'note'))
        assert(!JSON.stringify(publicHistory).includes(m.body));
      assert(!JSON.stringify(publicHistory).includes(s.order.note));
      assert.deepEqual((await api('/products')).data, s.beforeProducts);
      assert.deepEqual(await baseline(s.ids), s.before);
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
      if (phase === 'rotate') {
        assert(!s.rotated, 'Rotation already recorded');
        const next = await api(`/orders/${s.order.id}/portal`, 'POST', {
          action: 'rotate',
          days: 90,
        });
        s.oldToken = s.token;
        s.token = next.portal_token;
        s.rotated = true;
        await save();
        await api(`/public/orders/${s.oldToken}/messages`, 'GET', undefined, 404, true);
        await api(
          `/public/orders/${s.oldToken}/messages`,
          'POST',
          { client_key: randomUUID(), body: 'Nie zapisuj' },
          404,
          true,
        );
        const after = await api(`/public/orders/${s.token}/messages`, 'GET', undefined, 200, true);
        assert.deepEqual(after.data, publicHistory.data);
      }
      s.thread = head.id;
      s.proofRevision = health.revision;
      await save();
      console.log({
        phase,
        revision: health.revision,
        schema: health.schema_revision,
        order: s.order.number,
        private_notes: detail.data.filter((m: any) => m.kind === 'note').length,
        public_messages: publicHistory.data.length,
        public_projection_safe: true,
        idempotent_replays_without_revision_change: stored.length,
        prior_firms_unchanged: s.ids.length,
        prior_users_unchanged: s.userIds.length,
        products_unchanged: true,
        rotated_old_token_revoked: Boolean(s.rotated),
        external_requests: 0,
      });
    } else throw new Error('Unknown proof phase');
  }
} finally {
  await pool.end();
}
