import { test, before, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed, DEMO_TENANT, SECOND_TENANT } from './fixtures';
import { tokenHash } from '../server/security';

assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>;
const password = 'LocalWorkspace!2026';
const cookieOf = (r: any) => r.headers['set-cookie'].toString().split(';')[0];
const req = (url: string, method: any = 'GET', payload?: any, cookie?: string, headers: any = {}) =>
  app.inject({ url, method, payload, headers: { ...(cookie ? { cookie } : {}), ...headers } });
before(async () => {
  await migrate();
  await seed();
});
beforeEach(async () => {
  app = await buildApp();
});
afterEach(async () => {
  await app.close();
});
after(async () => {
  await pool.end();
});
async function signup(extra: any = {}) {
  const email = randomUUID() + '@example.test';
  const r = await req('/api/auth/signup', 'POST', {
    email,
    name: 'QA Konto',
    password,
    organization: { name: 'QA Firma ' + randomUUID().slice(0, 8) },
    ...extra,
  });
  assert.equal(r.statusCode, 201, r.body);
  return { cookie: cookieOf(r), user: r.json().user, email: r.json().user.email };
}
async function login(email: string, pw = password) {
  const r = await req('/api/auth/login', 'POST', { email, password: pw });
  assert.equal(r.statusCode, 200, r.body);
  return cookieOf(r);
}
async function invite(owner: any, email: string, role = 'operator') {
  const r = await req('/api/workspaces/invitations', 'POST', { email, role }, owner.cookie);
  assert.equal(r.statusCode, 201);
  return r.json();
}
async function accept(account: any, token: string) {
  const r = await req('/api/workspaces/invitations/accept', 'POST', { token }, account.cookie);
  assert.equal(r.statusCode, 200);
  return { ...account, cookie: cookieOf(r), user: r.json().user };
}
async function state(a: any) {
  return (await req('/api/workspaces/settings', 'GET', undefined, a.cookie)).json();
}
async function limits(a: any, overrides: Record<string, number>) {
  const code = 'qa-' + randomUUID();
  await pool.query(
    "INSERT INTO service_plans SELECT $1,'QA limits',limits || $2::jsonb FROM service_plans WHERE code='starter'",
    [code, JSON.stringify(overrides)],
  );
  await pool.query('UPDATE tenants SET plan=$2 WHERE id=$1', [a.user.tenant_id, code]);
}
async function warehouse(a: any) {
  return (await req('/api/warehouses', 'GET', undefined, a.cookie)).json().data[0].id;
}
async function product(a: any, sku = 'QA-' + randomUUID()) {
  return req(
    '/api/products',
    'POST',
    { sku, name: sku, price: 100, quantity: 100, warehouse_id: await warehouse(a) },
    a.cookie,
  );
}
test('rejestracja atomowo tworzy konto, Starter, MAIN, liczniki i sesję z hashem', async () => {
  const a = await signup();
  const s = await state(a);
  assert.equal(a.user.plan, 'starter');
  assert.equal(a.user.role, 'admin');
  assert.equal(s.usage.memberships, 1);
  assert.equal(s.usage.warehouses, 1);
  assert.equal(s.usage.products, 0);
  assert.equal((await warehouse(a)).length, 36);
  assert.match(
    (await pool.query('SELECT password_hash FROM users WHERE id=$1', [a.user.id])).rows[0]
      .password_hash,
    /^[a-f0-9]{32}:[a-f0-9]{128}$/,
  );
  assert.equal(
    (
      await pool.query('SELECT 1 FROM sessions WHERE token_hash=$1', [
        tokenHash(a.cookie.split('=')[1]),
      ])
    ).rowCount,
    1,
  );
  assert.equal((await req('/api/products', 'GET', undefined, a.cookie)).json().data.length, 0);
});
test('walidacja hasła, konflikt email niezależny od wielkości liter i dokładne publiczne ścieżki', async () => {
  const a = await signup();
  assert.equal(
    (
      await req('/api/auth/signup', 'POST', {
        email: 'bad@example.test',
        name: 'QA',
        password: 'short',
        organization: { name: 'QA' },
      })
    ).statusCode,
    422,
  );
  const duplicate = await req('/api/auth/signup', 'POST', {
    email: a.email.toUpperCase(),
    name: 'QA',
    password,
    organization: { name: 'QA' },
  });
  assert.equal(duplicate.statusCode, 409);
  assert.equal(
    (await pool.query('SELECT count(*) FROM users WHERE lower(email)=$1', [a.email])).rows[0].count,
    '1',
  );
  assert.equal((await req('/api/auth/login/hidden')).statusCode, 401);
});
test('nowa organizacja rotuje sesję, izoluje katalog i ma własny magazyn/walutę', async () => {
  const a = await signup();
  await product(a);
  const r = await req(
    '/api/workspaces',
    'POST',
    { name: 'QA EU', currency: 'EUR', locale: 'de-DE' },
    a.cookie,
  );
  assert.equal(r.statusCode, 201);
  const next = cookieOf(r);
  assert.equal((await req('/api/auth/me', 'GET', undefined, a.cookie)).statusCode, 401);
  assert.equal((await req('/api/products', 'GET', undefined, next)).json().data.length, 0);
  const s = (await req('/api/workspaces/settings', 'GET', undefined, next)).json();
  assert.equal(s.tenant.currency, 'EUR');
  assert.equal((await req('/api/workspaces', 'GET', undefined, next)).json().data.length, 2);
  const back = await req('/api/workspaces/switch', 'POST', { tenant_id: a.user.tenant_id }, next);
  assert.equal(back.statusCode, 200);
  assert.equal(
    (await req('/api/products', 'GET', undefined, cookieOf(back))).json().data.length,
    1,
  );
});
test('obca organizacja nie jest dostępna; odmowa nie unieważnia sesji', async () => {
  const a = await signup();
  const r = await req('/api/workspaces/switch', 'POST', { tenant_id: DEMO_TENANT }, a.cookie);
  assert.equal(r.statusCode, 403);
  assert.equal((await req('/api/auth/me', 'GET', undefined, a.cookie)).statusCode, 200);
  assert.equal((await req('/api/workspaces', 'GET', undefined, a.cookie)).json().data.length, 1);
});
test('równoczesne przełączenie starej sesji ma dokładnie jednego zwycięzcę', async () => {
  const a = await signup();
  const results = await Promise.all(
    Array.from({ length: 6 }, () =>
      req('/api/workspaces/switch', 'POST', { tenant_id: a.user.tenant_id }, a.cookie),
    ),
  );
  assert.equal(results.filter((r) => r.statusCode === 200).length, 1);
  assert(results.filter((r) => r.statusCode !== 200).every((r) => r.statusCode === 401));
});
test('stary nagłówek organizacji blokuje zapis po rotacji bez efektów ubocznych', async () => {
  const a = await signup();
  const r = await req('/api/workspaces', 'POST', { name: 'QA Druga' }, a.cookie);
  const stale = await req(
    '/api/warehouses',
    'POST',
    { name: 'Zły magazyn', code: 'BAD' },
    cookieOf(r),
    { 'x-workspace-id': a.user.tenant_id },
  );
  assert.equal(stale.statusCode, 409);
  assert.match(stale.json().detail, /Organizacja/);
  assert.equal(
    (
      await pool.query('SELECT count(*) FROM warehouses WHERE tenant_id=$1', [
        r.json().user.tenant_id,
      ])
    ).rows[0].count,
    '1',
  );
});
test('zaproszenie przechowuje tylko hash, nie ujawnia go na listach ani w audycie', async () => {
  const a = await signup();
  const i = await invite(a, 'invite@example.test');
  const s = await state(a);
  assert.equal(s.pending_invitations, 1);
  assert.equal(s.invitations.length, 1);
  assert.equal(s.invitations[0].token_hash, undefined);
  assert.equal(s.invitations[0].token, undefined);
  const db = (await pool.query('SELECT token_hash FROM workspace_invitations WHERE id=$1', [i.id]))
    .rows[0];
  assert.equal(db.token_hash, tokenHash(i.token));
  const audit = (await pool.query('SELECT detail FROM audit_events WHERE entity_id=$1', [i.id]))
    .rows;
  assert(!JSON.stringify(audit).includes(i.token));
});
test('rejestracja przez zaproszenie zajmuje zarezerwowane miejsce bez nowej organizacji', async () => {
  const owner = await signup();
  const i = await invite(owner, 'new-' + randomUUID() + '@example.test', 'viewer');
  const member = await signup({
    email: i.email,
    organization: undefined,
    invitation_token: i.token,
  });
  assert.equal(member.user.tenant_id, owner.user.tenant_id);
  assert.equal(member.user.role, 'viewer');
  const s = await state(owner);
  assert.equal(s.usage.memberships, 2);
  assert.equal(s.pending_invitations, 0);
  assert.equal(
    (await req('/api/workspaces', 'GET', undefined, member.cookie)).json().data.length,
    1,
  );
  assert.equal(
    (await req('/api/workspaces/invitations/accept', 'POST', { token: i.token }, member.cookie))
      .statusCode,
    409,
  );
});
test('nieprawidłowe zaproszenie wycofuje całe tworzenie konta', async () => {
  const address = randomUUID() + '@example.test';
  const r = await req('/api/auth/signup', 'POST', {
    email: address,
    name: 'QA',
    password,
    invitation_token: 'f'.repeat(64),
  });
  assert.equal(r.statusCode, 409);
  assert.equal((await pool.query('SELECT 1 FROM users WHERE email=$1', [address])).rowCount, 0);
});
test('zaproszenie jest przypisane do email, a wygasłe lub cofnięte nie przyznaje dostępu', async () => {
  const owner = await signup(),
    other = await signup();
  const i = await invite(owner, 'different@example.test');
  assert.equal(
    (await req('/api/workspaces/invitations/accept', 'POST', { token: i.token }, other.cookie))
      .statusCode,
    403,
  );
  await pool.query(
    "UPDATE workspace_invitations SET expires_at=now()-interval '1 second' WHERE id=$1",
    [i.id],
  );
  assert.equal(
    (await req('/api/workspaces/invitations/accept', 'POST', { token: i.token }, other.cookie))
      .statusCode,
    409,
  );
  const valid = await invite(owner, other.email);
  assert.equal(
    (await req('/api/workspaces/invitations/' + valid.id, 'DELETE', undefined, owner.cookie))
      .statusCode,
    200,
  );
  assert.equal(
    (await req('/api/workspaces/invitations/accept', 'POST', { token: valid.token }, other.cookie))
      .statusCode,
    409,
  );
});
test('istniejące konto dołącza jednorazowo i zachowuje poprzednią organizację', async () => {
  const owner = await signup(),
    other = await signup();
  const i = await invite(owner, other.email);
  const joined = await accept(other, i.token);
  assert.equal((await req('/api/auth/me', 'GET', undefined, other.cookie)).statusCode, 401);
  assert.equal(
    (await req('/api/workspaces', 'GET', undefined, joined.cookie)).json().data.length,
    2,
  );
  assert.equal(joined.user.role, 'operator');
  assert.equal(
    (
      await req(
        '/api/workspaces/invitations',
        'POST',
        { email: other.email, role: 'admin' },
        owner.cookie,
      )
    ).statusCode,
    409,
  );
});
test('współbieżne zaproszenia nie przekraczają liczby miejsc; wygaśnięcie zwalnia rezerwację', async () => {
  const a = await signup();
  await limits(a, { memberships: 2 });
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, n) =>
      req(
        '/api/workspaces/invitations',
        'POST',
        { email: `seat${n}@example.test`, role: 'operator' },
        a.cookie,
      ),
    ),
  );
  assert.equal(results.filter((r) => r.statusCode === 201).length, 1);
  assert(results.filter((r) => r.statusCode !== 201).every((r) => r.statusCode === 409));
  await pool.query(
    "UPDATE workspace_invitations SET expires_at=now()-interval '1 second' WHERE tenant_id=$1",
    [a.user.tenant_id],
  );
  await invite(a, 'new-seat@example.test');
  assert.equal((await state(a)).pending_invitations, 1);
});
test('operator i podgląd nie zarządzają firmą, planem, rolami ani zaproszeniami', async () => {
  const owner = await signup(),
    account = await signup();
  const joined = await accept(account, (await invite(owner, account.email, 'viewer')).token);
  for (const [url, method, payload] of [
    ['/api/workspaces/settings', 'PATCH', { name: 'Bad', locale: 'pl-PL' }],
    ['/api/workspaces/plan', 'PATCH', { plan: 'enterprise' }],
    ['/api/workspaces/invitations', 'POST', { email: 'bad@example.test', role: 'admin' }],
    ['/api/workspaces/members/' + owner.user.id, 'PATCH', { role: 'viewer' }],
  ] as const)
    assert.equal((await req(url, method, payload, joined.cookie)).statusCode, 403);
  const read = await state(joined);
  assert.deepEqual(read.members, []);
  assert.deepEqual(read.invitations, []);
  await req(
    '/api/workspaces/members/' + account.user.id,
    'PATCH',
    { role: 'operator' },
    owner.cookie,
  );
  assert.equal(
    (await req('/api/workspaces/plan', 'PATCH', { plan: 'enterprise' }, joined.cookie)).statusCode,
    403,
  );
});
test('role są aktualne w istniejącej sesji, a obcy użytkownik/invite nie podlega edycji', async () => {
  const owner = await signup(),
    other = await signup();
  const joined = await accept(other, (await invite(owner, other.email, 'admin')).token);
  await req('/api/workspaces/members/' + other.user.id, 'PATCH', { role: 'viewer' }, owner.cookie);
  assert.equal(
    (await req('/api/auth/me', 'GET', undefined, joined.cookie)).json().user.role,
    'viewer',
  );
  assert.equal(
    (
      await req(
        '/api/workspaces/settings',
        'PATCH',
        { name: 'Wrong', locale: 'pl-PL' },
        joined.cookie,
      )
    ).statusCode,
    403,
  );
  const foreign = (
    await pool.query('SELECT user_id FROM memberships WHERE tenant_id=$1', [SECOND_TENANT])
  ).rows[0].user_id;
  assert.equal(
    (await req('/api/workspaces/members/' + foreign, 'DELETE', undefined, owner.cookie)).statusCode,
    404,
  );
  assert.equal(
    (await req('/api/workspaces/invitations/' + randomUUID(), 'DELETE', undefined, owner.cookie))
      .statusCode,
    404,
  );
});
test('ostatniego administratora nie można usunąć ani zdegradować; wyścig zostawia jednego', async () => {
  const owner = await signup();
  assert.equal(
    (await req('/api/workspaces/members/' + owner.user.id, 'DELETE', undefined, owner.cookie))
      .statusCode,
    409,
  );
  assert.equal(
    (
      await req(
        '/api/workspaces/members/' + owner.user.id,
        'PATCH',
        { role: 'viewer' },
        owner.cookie,
      )
    ).statusCode,
    409,
  );
  const second = await signup();
  const joined = await accept(second, (await invite(owner, second.email, 'admin')).token);
  const results = await Promise.all([
    req('/api/workspaces/members/' + second.user.id, 'PATCH', { role: 'viewer' }, owner.cookie),
    req('/api/workspaces/members/' + owner.user.id, 'PATCH', { role: 'viewer' }, joined.cookie),
  ]);
  assert.equal(results.filter((r) => r.statusCode === 200).length, 1);
  assert.equal(
    (
      await pool.query("SELECT count(*) FROM memberships WHERE tenant_id=$1 AND role='admin'", [
        owner.user.tenant_id,
      ])
    ).rows[0].count,
    '1',
  );
});
test('odebranie dostępu unieważnia sesje w tej firmie, zachowuje sesję własnej firmy', async () => {
  const owner = await signup(),
    other = await signup();
  const separate = await login(other.email);
  const joined = await accept(other, (await invite(owner, other.email)).token);
  assert.equal(
    (await req('/api/workspaces/members/' + other.user.id, 'DELETE', undefined, owner.cookie))
      .statusCode,
    200,
  );
  assert.equal((await req('/api/auth/me', 'GET', undefined, joined.cookie)).statusCode, 401);
  assert.equal((await req('/api/auth/me', 'GET', undefined, separate)).statusCode, 200);
  assert.equal((await state(owner)).usage.memberships, 1);
});
test('limit magazynów działa w API; upgrade odblokowuje, downgrade nie usuwa danych', async () => {
  const a = await signup();
  assert.equal(
    (await req('/api/warehouses', 'POST', { name: 'Drugi', code: 'TWO' }, a.cookie)).statusCode,
    409,
  );
  assert.equal((await state(a)).usage.warehouses, 1);
  assert.equal(
    (await req('/api/workspaces/plan', 'PATCH', { plan: 'business' }, a.cookie)).statusCode,
    200,
  );
  assert.equal(
    (await req('/api/warehouses', 'POST', { name: 'Drugi', code: 'TWO' }, a.cookie)).statusCode,
    200,
  );
  assert.equal(
    (await req('/api/workspaces/plan', 'PATCH', { plan: 'starter' }, a.cookie)).statusCode,
    409,
  );
  const s = await state(a);
  assert.equal(s.tenant.plan, 'business');
  assert.equal(s.usage.warehouses, 2);
});
test('plan uwzględnia oczekujące zaproszenia i aktualny miesiąc, nie historyczne zamówienia', async () => {
  const a = await signup();
  await req('/api/workspaces/plan', 'PATCH', { plan: 'business' }, a.cookie);
  await invite(a, 'one@example.test');
  await invite(a, 'two@example.test');
  const i = await invite(a, 'three@example.test');
  assert.equal(
    (await req('/api/workspaces/plan', 'PATCH', { plan: 'starter' }, a.cookie)).statusCode,
    409,
  );
  await req('/api/workspaces/invitations/' + i.id, 'DELETE', undefined, a.cookie);
  await pool.query(
    "INSERT INTO orders(id,tenant_id,number,customer_name,email,warehouse_id,portal_token,created_at,total) VALUES($1,$2,'OLD','Old','old@example.test',$3,$4,'2020-01-01',0)",
    [randomUUID(), a.user.tenant_id, await warehouse(a), randomUUID()],
  );
  assert.equal(
    (await req('/api/workspaces/plan', 'PATCH', { plan: 'starter' }, a.cookie)).statusCode,
    200,
  );
  assert.equal((await state(a)).usage.orders, 0);
});
test('współbieżne tworzenie produktów nie przekracza limitu i wycofuje stan/audyt', async () => {
  const a = await signup();
  await limits(a, { products: 2 });
  const results = await Promise.all(Array.from({ length: 8 }, () => product(a)));
  assert.equal(results.filter((r) => r.statusCode === 201).length, 2);
  assert(results.filter((r) => r.statusCode !== 201).every((r) => r.statusCode === 409));
  assert.equal((await state(a)).usage.products, 2);
  assert.equal(
    (await pool.query('SELECT count(*) FROM stock WHERE tenant_id=$1', [a.user.tenant_id])).rows[0]
      .count,
    '2',
  );
});
test('atomowy CSV nie omija limitu i nie zostawia połowy importu', async () => {
  const a = await signup();
  await limits(a, { products: 1 });
  const preview = await req(
    '/api/catalog/imports/preview',
    'POST',
    {
      warehouse_id: await warehouse(a),
      csv: 'sku;name;price;quantity\nONE;Pierwszy;1;5\nTWO;Drugi;2;6',
    },
    a.cookie,
  );
  assert.equal(preview.statusCode, 200, preview.body);
  const apply = await req(
    '/api/catalog/imports/' + preview.json().id + '/apply',
    'POST',
    undefined,
    a.cookie,
  );
  assert.equal(apply.statusCode, 409, apply.body);
  assert.equal((await state(a)).usage.products, 0);
  assert.equal(
    (await pool.query('SELECT 1 FROM products WHERE tenant_id=$1', [a.user.tenant_id])).rowCount,
    0,
  );
});
test('limit zamówień dotyczy transakcji rezerwacji; replay nie zużywa kolejnego miejsca', async () => {
  const a = await signup();
  await limits(a, { orders: 2 });
  const p = (await product(a)).json();
  const body = {
    customer_name: 'QA Klient',
    email: 'buyer@example.test',
    warehouse_id: await warehouse(a),
    items: [{ product_id: p.id, quantity: 1 }],
  };
  const results = await Promise.all(
    Array.from({ length: 6 }, () =>
      req('/api/orders', 'POST', body, a.cookie, { 'idempotency-key': randomUUID() }),
    ),
  );
  assert.equal(results.filter((r) => r.statusCode === 201).length, 2);
  assert(results.filter((r) => r.statusCode !== 201).every((r) => r.statusCode === 409));
  const stock = (
    await pool.query('SELECT reserved FROM stock WHERE tenant_id=$1', [a.user.tenant_id])
  ).rows[0];
  assert.equal(stock.reserved, 2);
  const b = await signup();
  await limits(b, { orders: 1 });
  const pb = (await product(b)).json();
  const key = randomUUID();
  const order = {
    ...body,
    warehouse_id: await warehouse(b),
    items: [{ product_id: pb.id, quantity: 1 }],
  };
  const first = await req('/api/orders', 'POST', order, b.cookie, { 'idempotency-key': key });
  const replay = await req('/api/orders', 'POST', order, b.cookie, { 'idempotency-key': key });
  assert.equal(first.statusCode, 201);
  assert.equal(replay.statusCode, 200);
  assert.equal(first.json().id, replay.json().id);
  assert.equal((await state(b)).usage.orders, 1);
});
test('równoczesne kanały bez blokady katalogu nadal mieszczą się w atomowym limicie', async () => {
  const a = await signup();
  await limits(a, { channels: 2 });
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, n) =>
      req(
        '/api/integrations',
        'POST',
        {
          provider: 'allegro',
          name: 'QA channel ' + n,
          mode: 'sandbox',
          credentials: { access_token: 'local-test' },
          settings: {},
        },
        a.cookie,
      ),
    ),
  );
  assert.equal(results.filter((r) => r.statusCode === 200).length, 2);
  assert(results.filter((r) => r.statusCode !== 200).every((r) => r.statusCode === 409));
  assert.equal((await state(a)).usage.channels, 2);
});
test('liczniki są RLS, tylko do odczytu i cofają się razem z wycofaną transakcją', async () => {
  const a = await signup(),
    b = await signup();
  const rows = await tenantTx(a.user.tenant_id, (c) =>
    c.query('SELECT tenant_id FROM workspace_usage'),
  );
  assert(rows.rows.every((r) => r.tenant_id === a.user.tenant_id));
  await assert.rejects(
    tenantTx(a.user.tenant_id, (c) => c.query('UPDATE workspace_usage SET used=0')),
    /permission denied/,
  );
  await assert.rejects(
    tenantTx(b.user.tenant_id, async (c) => {
      await c.query(
        "INSERT INTO products(id,tenant_id,sku,name,price) VALUES($1,$2,'ROLLBACK','Rollback',1)",
        [randomUUID(), b.user.tenant_id],
      );
      throw new Error('rollback');
    }),
    /rollback/,
  );
  assert.equal((await state(b)).usage.products, 0);
  await product(a);
  assert.equal((await state(a)).usage.products, 1);
  await tenantTx(a.user.tenant_id, (c) => c.query("UPDATE products SET name='Renamed'"));
  assert.equal((await state(a)).usage.products, 1);
});
test('odmowa przeniesienia rekordu między firmami i zmiany miesiąca zamówienia', async () => {
  const a = await signup();
  const p = (await product(a)).json();
  // BEFORE triggers fire in name order: product_catalog_product_membership (142) runs before
  // workspace_scope (012) on products, so the catalog guard is the one that refuses the move.
  await assert.rejects(
    pool.query('UPDATE products SET tenant_id=$2 WHERE id=$1', [p.id, SECOND_TENANT]),
    /Niezmienna przynależność produktu do katalogu/,
  );
  // memberships has no other BEFORE UPDATE trigger, so workspace_scope itself answers there.
  await assert.rejects(
    pool.query('UPDATE memberships SET tenant_id=$2 WHERE tenant_id=$1', [a.user.tenant_id, SECOND_TENANT]),
    /organizacji/,
  );
  const o = await req(
    '/api/orders',
    'POST',
    {
      customer_name: 'QA',
      email: 'qa@example.test',
      warehouse_id: await warehouse(a),
      items: [{ product_id: p.id, quantity: 1 }],
    },
    a.cookie,
  );
  await assert.rejects(
    pool.query("UPDATE orders SET created_at=created_at-interval '1 month' WHERE id=$1", [
      o.json().id,
    ]),
    /okresu/,
  );
});
test('administrator zapisuje nazwę i region tylko własnej firmy, waluta pozostaje stała', async () => {
  const a = await signup(),
    b = await signup();
  const updated = await req(
    '/api/workspaces/settings',
    'PATCH',
    { name: 'QA Zmieniona', locale: 'de-DE', currency: 'EUR' },
    a.cookie,
  );
  assert.equal(updated.statusCode, 200);
  const s = await state(a);
  assert.equal(s.tenant.name, 'QA Zmieniona');
  assert.equal(s.tenant.locale, 'de-DE');
  assert.equal(s.tenant.currency, 'PLN');
  const me = (await req('/api/auth/me', 'GET', undefined, a.cookie)).json().user;
  assert.equal(me.tenant_name, 'QA Zmieniona');
  assert.deepEqual([me.locale, me.currency], ['de-DE', 'PLN']);
  assert.deepEqual(
    [(await req('/api/auth/me', 'GET', undefined, b.cookie)).json().user.locale, b.user.locale],
    ['pl-PL', 'pl-PL'],
  );
  assert.notEqual((await state(b)).tenant.name, 'QA Zmieniona');
});
test('ACCOUNT-002: /api/auth/me i logowanie podają region i walutę firmy do formatowania', async () => {
  const a = await signup({
    organization: { name: 'QA Region ' + randomUUID().slice(0, 8), currency: 'EUR', locale: 'en-GB' },
  });
  assert.deepEqual([a.user.locale, a.user.currency], ['en-GB', 'EUR']);
  const me = (await req('/api/auth/me', 'GET', undefined, a.cookie)).json().user;
  assert.deepEqual([me.locale, me.currency], ['en-GB', 'EUR']);
  const relogged = (await req('/api/auth/me', 'GET', undefined, await login(a.email))).json().user;
  assert.deepEqual([relogged.locale, relogged.currency], ['en-GB', 'EUR']);
});
test('równoczesne tworzenie firm przy 19 rolach admina tworzy tylko jedną kolejną', async () => {
  const a = await signup();
  for (let n = 0; n < 18; n++) {
    const id = randomUUID();
    await pool.query("INSERT INTO tenants(id,name) VALUES($1,'QA cap fixture')", [id]);
    await pool.query("INSERT INTO memberships VALUES($1,$2,'admin')", [a.user.id, id]);
  }
  const cookies = [a.cookie, await login(a.email), await login(a.email)];
  const results = await Promise.all(
    cookies.map((cookie, n) => req('/api/workspaces', 'POST', { name: 'QA cap ' + n }, cookie)),
  );
  assert.equal(results.filter((r) => r.statusCode === 201).length, 1);
  assert(results.filter((r) => r.statusCode !== 201).every((r) => r.statusCode === 409));
  assert.equal(
    (
      await pool.query("SELECT count(*) FROM memberships WHERE user_id=$1 AND role='admin'", [
        a.user.id,
      ])
    ).rows[0].count,
    '20',
  );
});
test('konto bez członkostwa ponownie loguje się do własnej pustej firmy bez odzyskania cofniętego dostępu', async () => {
  const owner = await signup();
  const i = await invite(owner, randomUUID() + '@example.test');
  const member = await signup({
    email: i.email,
    organization: undefined,
    invitation_token: i.token,
  });
  await req('/api/workspaces/members/' + member.user.id, 'DELETE', undefined, owner.cookie);
  assert.equal((await req('/api/auth/me', 'GET', undefined, member.cookie)).statusCode, 401);
  const cookies = await Promise.all([
    login(member.email),
    login(member.email),
    login(member.email),
  ]);
  const users = await Promise.all(
    cookies.map(
      async (cookie) => (await req('/api/auth/me', 'GET', undefined, cookie)).json().user,
    ),
  );
  assert(
    users.every(
      (u) =>
        u.role === 'admin' &&
        u.plan === 'starter' &&
        u.tenant_id === users[0].tenant_id &&
        u.tenant_id !== owner.user.tenant_id,
    ),
  );
  assert.equal(
    (await pool.query('SELECT count(*) FROM memberships WHERE user_id=$1', [member.user.id]))
      .rows[0].count,
    '1',
  );
});
test('logowanie z nowym zaproszeniem przywraca członkostwo konta bez firm i nie tworzy dodatkowej organizacji', async () => {
  const owner = await signup();
  const i = await invite(owner, randomUUID() + '@example.test');
  const member = await signup({
    email: i.email,
    organization: undefined,
    invitation_token: i.token,
  });
  await req('/api/workspaces/members/' + member.user.id, 'DELETE', undefined, owner.cookie);
  const next = await invite(owner, member.email, 'viewer');
  const input = { email: member.email, password, invitation_token: next.token };
  const r = await req('/api/auth/login', 'POST', input);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().user.tenant_id, owner.user.tenant_id);
  assert.equal(r.json().user.role, 'viewer');
  assert.equal(
    (await pool.query('SELECT count(*) FROM memberships WHERE user_id=$1', [member.user.id]))
      .rows[0].count,
    '1',
  );
  assert.equal((await req('/api/auth/login', 'POST', input)).statusCode, 409);
});
