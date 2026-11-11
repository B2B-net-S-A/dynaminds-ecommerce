import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool, migrate } from '../server/db';
import { seed } from './fixtures';
import { encrypt } from '../server/security';

assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  other: string,
  viewer: string,
  tenant: string;
const ids: string[] = [];
const request = (url: string, auth = cookie) =>
  app.inject({ url, headers: auth ? { cookie: auth } : {} });
const cookieOf = (r: any) => r.headers['set-cookie'].toString().split(';')[0];
before(async () => {
  await migrate();
  await seed();
  app = await buildApp();
  const signup = await app.inject({
    method: 'POST',
    url: '/api/auth/signup',
    payload: {
      name: 'Panel integracji QA',
      email: randomUUID() + '@example.test',
      password: 'WorkspaceLocal!2026',
      organization: { name: 'Panel integracji QA' },
    },
  });
  assert.equal(signup.statusCode, 201, signup.body);
  cookie = cookieOf(signup);
  tenant = signup.json().user.tenant_id;
  const plan = await app.inject({
    url: '/api/workspaces/plan',
    method: 'PATCH',
    payload: { plan: 'enterprise' },
    headers: { cookie },
  });
  assert.equal(plan.statusCode, 200, plan.body);
  const providers = ['amazon', 'woocommerce', 'dpd', 'smsapi'];
  const statuses = [
    'simulation',
    'verified_read',
    'authorized_read',
    'awaiting_oauth',
    'error',
    'not_verified',
  ];
  for (let i = 0; i < 205; i++) {
    const id = randomUUID();
    ids.push(id);
    await pool.query(
      `INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings,status,created_at)
      VALUES($1,$2,$3,$4,$5,$9,$6,$7,$8::timestamptz)`,
      [
        id,
        tenant,
        providers[i % 4],
        i === 0 ? 'Dosłownie_%\\test' : 'Połączenie QA ' + String(i).padStart(3, '0'),
        i % 2 ? 'live' : 'sandbox',
        { simulation: i % 7 === 0 },
        statuses[i % 6],
        '2026-10-05T12:00:00.' + String(1 + (i % 3)).padStart(6, '0') + 'Z',
        encrypt({ token: 'SECRET-WORKSPACE' }),
      ],
    );
  }
  other = cookieOf(
    await app.inject({
      url: '/api/auth/login',
      method: 'POST',
      payload: { email: 'other@demo.local', password: 'DynaDemo!2026' },
    }),
  );
  const user = (await pool.query("SELECT id FROM users WHERE email='viewer@demo.local'")).rows[0];
  await pool.query("INSERT INTO memberships(user_id,tenant_id,role) VALUES($1,$2,'viewer')", [
    user.id,
    tenant,
  ]);
  const login = await app.inject({
    url: '/api/auth/login',
    method: 'POST',
    payload: { email: 'viewer@demo.local', password: 'DynaDemo!2026' },
  });
  viewer = cookieOf(
    await app.inject({
      url: '/api/workspaces/switch',
      method: 'POST',
      payload: { tenant_id: tenant },
      headers: { cookie: cookieOf(login) },
    }),
  );
});
after(async () => {
  await app.close();
  await pool.end();
});

test('bounded keyset traversal preserves timestamp microseconds and UUID ties without duplicates', async () => {
  let next: string | null = null;
  const found: string[] = [];
  let pages = 0;
  do {
    const r = await request(
      '/api/integrations/connections?limit=17' + (next ? '&after=' + next : ''),
    );
    assert.equal(r.statusCode, 200, r.body);
    const body = r.json();
    assert.equal(body.total, 205);
    assert.ok(body.data.length <= 17);
    found.push(...body.data.map((ch: any) => ch.id));
    next = body.next;
    pages++;
    assert.ok(pages < 20);
    assert.ok(!r.body.includes('SECRET-WORKSPACE'));
    assert.ok(!r.body.includes('page_time'));
  } while (next);
  assert.equal(pages, 13);
  assert.equal(found.length, 205);
  assert.equal(new Set(found).size, 205);
  assert.deepEqual(new Set(found), new Set(ids));
});
test('tenant isolation, read-only role, metadata without unbounded channels and truthful summaries', async () => {
  const metadata = (await request('/api/integrations/workspace', viewer)).json();
  assert.equal(metadata.summary.total, 205);
  assert.equal(metadata.registry.length, 14);
  assert.equal(metadata.channels, undefined);
  assert.equal(metadata.summary.attention, 68);
  for (const status of ['simulation', 'verified_read']) {
    const r = (await request('/api/integrations/connections?status=' + status, viewer)).json();
    assert.equal(r.total, metadata.summary[status]);
    for (const ch of r.data)
      status === 'simulation'
        ? assert.ok(ch.status === 'simulation' || ch.settings.simulation)
        : assert.ok(ch.status === 'verified_read' && !ch.settings.simulation);
  }
  const theirs = (await request('/api/integrations/connections', other)).json();
  assert.ok(theirs.data.every((ch: any) => !ids.includes(ch.id)));
  assert.equal((await request('/api/integrations/connections', '')).statusCode, 401);
});
test('combined provider/mode/state/search filters and literal wildcard escaping', async () => {
  const literal = await request(
    '/api/integrations/connections?' + new URLSearchParams({ search: '_%\\test' }),
  );
  assert.equal(literal.statusCode, 200, literal.body);
  assert.equal(literal.json().total, 1);
  assert.equal(literal.json().data[0].id, ids[0]);
  const named = (
    await request('/api/integrations/connections?search=DPD%20Polska&mode=sandbox')
  ).json();
  assert.equal(named.total, 51);
  assert.ok(named.data.every((ch: any) => ch.provider === 'dpd' && ch.mode === 'sandbox'));
  const combined = (
    await request(
      '/api/integrations/connections?provider=woocommerce&mode=live&status=attention&search=QA',
    )
  ).json();
  assert.ok(combined.total > 0);
  assert.ok(
    combined.data.every(
      (ch: any) =>
        ch.provider === 'woocommerce' && ch.mode === 'live' && ch.status === 'awaiting_oauth',
    ),
  );
  const empty = (await request('/api/integrations/connections?search=missing-provider')).json();
  assert.equal(empty.total, 0);
  assert.deepEqual(empty.data, []);
  assert.equal(empty.next, null);
});
test('cursor validation rejects malformed, changed-filter and foreign-tenant tokens; no credentials projection', async () => {
  const first = (await request('/api/integrations/connections?limit=2')).json();
  for (const url of [
    '/api/integrations/connections?after=invalid',
    '/api/integrations/connections?search=QA&after=' + first.next,
    '/api/integrations/connections?provider=missing',
    '/api/integrations/connections?status=arbitrary',
    '/api/integrations/connections?limit=101',
    '/api/integrations/connections?limit=0',
    '/api/integrations/connections?search=' + 'x'.repeat(101),
    '/api/integrations/connections?unknown=true',
  ])
    assert.equal((await request(url)).statusCode, 422, url);
  assert.equal(
    (await request('/api/integrations/connections?after=' + first.next, other)).statusCode,
    422,
  );
  assert.ok(first.data.every((ch: any) => !('credentials' in ch) && !('tenant_id' in ch)));
});
test('newer inserts and deletion of page boundary do not repeat already visited rows', async () => {
  const first = (await request('/api/integrations/connections?limit=3')).json();
  const newer = randomUUID();
  try {
    await pool.query(
      `INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,created_at) VALUES($1,$2,'amazon','Nowy QA','sandbox','hidden','2026-10-05T13:00:00Z')`,
      [newer, tenant],
    );
    const boundary = first.data.at(-1).id;
    await pool.query('DELETE FROM channels WHERE id=$1', [boundary]);
    const next = await request('/api/integrations/connections?limit=100&after=' + first.next);
    assert.equal(next.statusCode, 200, next.body);
    assert.ok(
      next
        .json()
        .data.every((ch: any) => ch.id !== newer && !first.data.some((p: any) => p.id === ch.id)),
    );
  } finally {
    await pool.query('DELETE FROM channels WHERE id=$1', [newer]);
  }
});
test('restore preview serves workspace pages with separate login and refuses mutations', async () => {
  const preview = await buildApp({ readOnly: true, previewPort: 4199 });
  try {
    const login = await preview.inject({
      url: '/api/auth/login',
      method: 'POST',
      payload: { email: 'viewer@demo.local', password: 'DynaDemo!2026' },
    });
    assert.equal(login.statusCode, 200, login.body);
    const auth = cookieOf(login);
    for (const url of ['/api/integrations/workspace', '/api/integrations/connections?limit=5']) {
      assert.equal((await preview.inject({ url, headers: { cookie: auth } })).statusCode, 200);
      assert.equal((await preview.inject({ url, headers: { cookie } })).statusCode, 401);
    }
    assert.equal(
      (
        await preview.inject({
          url: '/api/integrations',
          method: 'POST',
          payload: {},
          headers: { cookie: auth },
        })
      ).statusCode,
      423,
    );
  } finally {
    await preview.close();
  }
});
