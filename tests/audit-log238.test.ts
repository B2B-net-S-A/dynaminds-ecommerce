/** Migration 238 (docs/parity/AUDIT-LOG238-20261027.md): the organisation's audit log (SEC-009) names its
 * author, keeps the API key of key-authenticated actions, filters and pages with a cursor and exports CSV;
 * the members' login list (237) filters by person and pages, so a burst on one login hides nobody.
 * Database test on a disposable clone migrated to HEAD. */
import { test, before, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { seed } from './fixtures';

assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>;
const password = 'AuditLog238!2026';
let ipCounter = 0;
const ip = () => '10.238.' + (Math.floor(++ipCounter / 250) % 250) + '.' + ((ipCounter % 250) + 1);
const cookieOf = (r: any) => r.headers['set-cookie']?.toString().split(';')[0];
const req = (url: string, method: any = 'GET', payload?: any, cookie?: string, headers: any = {}) =>
  app.inject({ url, method, payload, remoteAddress: ip(), headers: { 'user-agent': 'QA-238/1.0', ...(cookie ? { cookie } : {}), ...headers } });
const bearer = (token: string) => ({ authorization: 'Bearer ' + token });
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
async function signup(name = 'QA 238', extra: any = {}) {
  const r = await req('/api/auth/signup', 'POST', {
    email: randomUUID() + '@example.test',
    name,
    password,
    ...(extra.invitation_token ? {} : { organization: { name: 'QA 238 ' + randomUUID().slice(0, 8) } }),
    ...extra,
  });
  assert.equal(r.statusCode, 201, r.body);
  return { user: r.json().user, cookie: cookieOf(r) as string };
}
async function join(a: any, b: any, role: string) {
  const inv = await req('/api/workspaces/invitations', 'POST', { email: b.user.email, role }, a.cookie);
  assert.equal(inv.statusCode, 201, inv.body);
  const r = await req('/api/workspaces/invitations/accept', 'POST', { token: inv.json().token }, b.cookie);
  assert.equal(r.statusCode, 200, r.body);
  b.cookie = cookieOf(r);
  b.user = r.json().user;
}
async function key(a: any, scopes: string[]) {
  const r = await req('/api/developer/keys', 'POST', { name: 'Integracja 238', scopes, expires_days: 30 }, a.cookie);
  assert.equal(r.statusCode, 201, r.body);
  return r.json();
}
const warehouse = async (a: any) => (await req('/api/warehouses', 'GET', undefined, a.cookie)).json().data[0].id;
const productBody = (w: string) => ({ name: 'QA 238 produkt', sku: 'A238-' + randomUUID(), price: 100, warehouse_id: w, quantity: 1 });
/** Synthetic audit rows (owner connection) at exact times; ties share created_at so only the id orders them. */
async function rows(tenant: string, list: { user?: string | null; action: string; entity?: string | null; at: string; detail?: unknown }[]) {
  const ids: string[] = [];
  for (const r of list) {
    const id = randomUUID();
    ids.push(id);
    await pool.query('INSERT INTO audit_events(id,tenant_id,user_id,action,entity_id,detail,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)', [
      id, tenant, r.user ?? null, r.action, r.entity ?? null, JSON.stringify(r.detail ?? {}), r.at]);
  }
  return ids;
}
async function all(url: string, cookie: string) {
  const seen: any[] = [];
  let cursor: string | null = null, pages = 0;
  do {
    const r = await req(url + (cursor ? '&after=' + encodeURIComponent(cursor) : ''), 'GET', undefined, cookie);
    assert.equal(r.statusCode, 200, r.body);
    seen.push(...r.json().data);
    cursor = r.json().meta.cursor;
    assert(++pages < 50, 'the cursor ends');
  } while (cursor);
  return { seen, pages };
}

test('SEC-009: an API key action keeps its api_key_id; the list names the author (person, or key name and prefix) and no secret', async () => {
  const a = await signup('Anna Audyt');
  const w = await warehouse(a);
  const manual = await req('/api/products', 'POST', productBody(w), a.cookie);
  assert.equal(manual.statusCode, 201, manual.body);
  const k = await key(a, ['products:read', 'products:write']);
  const viaKey = await req('/api/v1/products', 'POST', productBody(w), undefined, bearer(k.token));
  assert.equal(viaKey.statusCode, 201, viaKey.body);
  const stored = (await pool.query(
    'SELECT k.api_key_id,k.tenant_id FROM audit238_event_keys k JOIN audit_events e ON e.id=k.event_id WHERE e.entity_id=$1', [viaKey.json().id])).rows;
  assert.deepEqual(stored, [{ api_key_id: k.id, tenant_id: a.user.tenant_id }], 'the key that acted is recorded with the event');
  assert.equal((await pool.query(
    'SELECT count(*)::int n FROM audit238_event_keys k JOIN audit_events e ON e.id=k.event_id WHERE e.entity_id=$1', [manual.json().id])).rows[0].n, 0, 'a session action has no key');
  const r = await req('/api/audit?action=product.create', 'GET', undefined, a.cookie);
  assert.equal(r.statusCode, 200, r.body);
  assert(!r.body.includes(k.token), 'no secret in the log');
  const byEntity = new Map(r.json().data.map((e: any) => [e.entity_id, e]));
  const m: any = byEntity.get(manual.json().id), v: any = byEntity.get(viaKey.json().id);
  assert.deepEqual(m.author, { kind: 'user', user_id: a.user.id, name: 'Anna Audyt', api_key_id: null, api_key_name: null, api_key_prefix: null });
  assert.deepEqual(v.author, { kind: 'api_key', user_id: a.user.id, name: 'Anna Audyt', api_key_id: k.id, api_key_name: 'Integracja 238', api_key_prefix: k.prefix });
  assert.equal(m.action, 'product.create');
  // The key filter narrows to what that key did.
  const onlyKey = (await req('/api/audit?api_key_id=' + k.id, 'GET', undefined, a.cookie)).json().data;
  assert.deepEqual(onlyKey.map((e: any) => e.entity_id), [viaKey.json().id]);
  const sources = (await req('/api/audit?source=api_key', 'GET', undefined, a.cookie)).json().data;
  assert(sources.length >= 1 && sources.every((e: any) => e.author.kind === 'api_key'));
});

test('SEC-009: a payment recorded through /api/v1 with a key is attributed to that key (payments.ts writes its own audit row)', async () => {
  const a = await signup('Płatności A');
  const w = await warehouse(a);
  const p = await req('/api/products', 'POST', productBody(w), a.cookie);
  assert.equal(p.statusCode, 201, p.body);
  const k = await key(a, ['orders:read', 'orders:write']);
  const o = await req('/api/v1/orders', 'POST', { customer_name: 'QA Kupujący', email: 'buyer238@example.test', warehouse_id: w, items: [{ product_id: p.json().id, quantity: 1 }] },
    undefined, { ...bearer(k.token), 'idempotency-key': randomUUID() });
  assert.equal(o.statusCode, 201, o.body);
  const current = (await req('/api/v1/orders/' + o.json().id, 'GET', undefined, undefined, bearer(k.token))).json();
  const pay = await req('/api/v1/orders/' + o.json().id + '/payments', 'POST', { client_key: randomUUID(), version: Number(current.version), kind: 'receipt',
    amount: Number(current.total), currency: 'PLN', reference: 'QA 238 wpłata kluczem', confirmed: true }, undefined, bearer(k.token));
  assert.equal(pay.statusCode, 200, pay.body);
  const rows = (await req('/api/audit?entity_id=' + o.json().id, 'GET', undefined, a.cookie)).json().data;
  const receipt = rows.find((e: any) => e.action === 'payment.receipt');
  assert(receipt, JSON.stringify(rows.map((e: any) => e.action)));
  assert.equal(receipt.author.kind, 'api_key');
  assert.equal(receipt.author.api_key_id, k.id);
  assert(rows.filter((e: any) => e.action === 'order.create').every((e: any) => e.author.api_key_id === k.id));
});

test('SEC-009: filters (person, action, entity, date range) and a complete keyset cursor over ties; never another workspace', async () => {
  const a = await signup('Admin A'), b = await signup('Operator B'), c = await signup('Admin C');
  await join(a, b, 'operator');
  const entity = randomUUID(), t = '2026-10-20T10:00:00.000000Z';
  const ids = await rows(a.user.tenant_id, [
    { user: a.user.id, action: 'qa238.status', entity, at: t, detail: { from: 'new', to: 'paid' } },
    { user: b.user.id, action: 'qa238.status', entity, at: t },
    { user: b.user.id, action: 'qa238.tag', entity: null, at: t },
    { user: a.user.id, action: 'qa238.tag', entity, at: '2026-10-21T08:00:00.000000Z' },
    { user: null, action: 'qa238.system', entity: null, at: '2026-10-19T23:59:59.999999Z' },
    { user: b.user.id, action: 'qa238.status', entity: null, at: '2026-10-22T12:00:00.000000Z' },
    { user: a.user.id, action: 'qa238', entity: null, at: t },
  ]);
  const { seen, pages } = await all('/api/audit?action=qa238&limit=2', a.cookie);
  assert.equal(pages, 4);
  assert.deepEqual(seen.map((e) => e.id).sort(), [...ids].sort(), 'every row once, none skipped at the ties');
  for (let i = 1; i < seen.length; i++) {
    const p = seen[i - 1], q = seen[i];
    assert(p.created_at > q.created_at || (p.created_at === q.created_at && p.id > q.id), 'created_at DESC, id DESC');
  }
  const ask = async (q: string) => {
    const r = await req('/api/audit?' + q, 'GET', undefined, a.cookie);
    assert.equal(r.statusCode, 200, r.body);
    return r.json().data.map((e: any) => e.id).sort();
  };
  assert.deepEqual(await ask('action=qa238&user_id=' + b.user.id), [ids[1], ids[2], ids[5]].sort());
  assert.deepEqual(await ask('action=qa238.status'), [ids[0], ids[1], ids[5]].sort());
  assert.deepEqual(await ask('entity_id=' + entity), [ids[0], ids[1], ids[3]].sort());
  assert.deepEqual(await ask('action=qa238&from=2026-10-20T00:00:00Z&to=2026-10-21T00:00:00Z'), [ids[0], ids[1], ids[2], ids[6]].sort());
  // A date without time is a whole day in Warsaw (the UI date fields): 19.10 23:59:59Z is 20.10 01:59 there.
  assert.deepEqual(await ask('action=qa238&from=2026-10-20&to=2026-10-20'), [ids[0], ids[1], ids[2], ids[4], ids[6]].sort());
  assert.deepEqual(await ask('action=qa238&source=system'), [ids[4]]);
  const first = (await req('/api/audit?entity_id=' + entity, 'GET', undefined, a.cookie)).json().data.find((e: any) => e.id === ids[0]);
  assert.deepEqual(first.detail, { from: 'new', to: 'paid' });
  assert.equal(first.author.kind, 'user');
  // Another workspace: the same filters and even A's cursor reach only its own rows.
  const mine = await rows(c.user.tenant_id, [{ user: c.user.id, action: 'qa238.status', entity, at: t }]);
  const other = async (q: string) => (await req('/api/audit?' + q, 'GET', undefined, c.cookie)).json().data.map((e: any) => e.id);
  assert.deepEqual(await other('entity_id=' + entity), mine);
  assert.deepEqual(await other('action=qa238&user_id=' + a.user.id), []);
  const cursorA = (await req('/api/audit?action=qa238&limit=1', 'GET', undefined, a.cookie)).json().meta.cursor;
  assert.deepEqual(await other('action=qa238&after=' + encodeURIComponent(cursorA)), mine);
  // Malformed input: 422 with a Polish message, nothing read.
  for (const q of ['after=nope', 'after=' + encodeURIComponent('2026-10-20T10:00:00.000000Z|x'), 'user_id=abc', 'entity_id=1', 'api_key_id=zz',
    'from=2026-10-21T00:00:00Z&to=2026-10-20T00:00:00Z', 'limit=0', 'limit=201', 'action=' + encodeURIComponent("x' OR 1=1"), 'source=robot', 'unknown=1']) {
    const r = await req('/api/audit?' + q, 'GET', undefined, a.cookie);
    assert.equal(r.statusCode, 422, q + ' ' + r.body);
  }
});

test('SEC-009: only an administrator session reads, exports or lists the authors; viewer, operator and an API key get 403', async () => {
  const a = await signup(), viewer = await signup(), operator = await signup();
  await join(a, viewer, 'viewer');
  await join(a, operator, 'operator');
  const k = await key(a, ['products:read', 'orders:read']);
  for (const url of ['/api/audit', '/api/audit/export', '/api/audit/authors']) {
    for (const who of [viewer, operator]) assert.equal((await req(url, 'GET', undefined, who.cookie)).statusCode, 403, url);
    assert.equal((await req(url, 'GET', undefined, undefined, bearer(k.token))).statusCode, 403, url + ' API key');
    assert.equal((await req(url, 'GET', undefined, a.cookie)).statusCode, 200, url + ' admin');
  }
  const authors = (await req('/api/audit/authors', 'GET', undefined, a.cookie)).json();
  assert.deepEqual(authors.members.map((m: any) => m.id).sort(), [a.user.id, viewer.user.id, operator.user.id].sort());
  assert.deepEqual(authors.api_keys.map((x: any) => [x.id, x.prefix]), [[k.id, k.prefix]]);
  assert(!JSON.stringify(authors).includes(k.token));
});

test('SEC-009: CSV export follows the filters, neutralises formulas, and the export itself is audited', async () => {
  const a = await signup('Eksport A');
  const entity = randomUUID();
  await rows(a.user.tenant_id, [
    { user: a.user.id, action: 'qa238.status', entity, at: '2026-10-20T10:00:00.000000Z', detail: { from: 'new', to: 'paid' } },
    { user: a.user.id, action: '=1+1', entity, at: '2026-10-20T09:00:00.000000Z' },
    { user: a.user.id, action: 'qa238.other', entity: randomUUID(), at: '2026-10-20T08:00:00.000000Z' },
  ]);
  const r = await req('/api/audit/export?entity_id=' + entity, 'GET', undefined, a.cookie);
  assert.equal(r.statusCode, 200, r.body);
  assert.match(String(r.headers['content-type']), /^text\/csv; charset=utf-8/);
  assert.match(String(r.headers['content-disposition']), /attachment; filename="dziennik-audytu-\d{8}\.csv"/);
  assert(r.body.startsWith('﻿'), 'BOM for spreadsheets');
  const lines = r.body.slice(1).trim().split('\r\n');
  assert.equal(lines[0], 'Czas (UTC);Autor;Klucz API;Operacja;Kod operacji;Obiekt;Zmiany;Szczegóły');
  assert.equal(lines.length, 3, 'only the filtered rows');
  assert.match(lines[1], /;Eksport A;;[^;]*;qa238\.status;/);
  assert.match(lines[1], /;new → paid;/, 'the before/after change in its own column');
  assert.match(lines[2], /;'=1\+1;/, 'a formula-looking cell gets a leading apostrophe');
  const audited = (await pool.query("SELECT user_id,detail FROM audit_events WHERE tenant_id=$1 AND action='audit.exported'", [a.user.tenant_id])).rows;
  assert.equal(audited.length, 1);
  assert.equal(audited[0].user_id, a.user.id);
  assert.equal(audited[0].detail.rows, 2);
  assert.equal(audited[0].detail.filters.entity_id, entity);
  assert.equal((await req('/api/audit/export?after=nope', 'GET', undefined, a.cookie)).statusCode, 422);
});

test('SEC-005: the members login list filters by person and outcome and pages with a cursor, so a burst on one login hides nobody', async () => {
  const a = await signup('Admin L'), flooded = await signup('Zalewany'), quiet = await signup('Cichy'), outsider = await signup('Obcy');
  await join(a, flooded, 'operator');
  await join(a, quiet, 'viewer');
  assert.equal((await req('/api/auth/login', 'POST', { email: quiet.user.email, password: 'wrong-238' })).statusCode, 401);
  // 150 refused attempts on one login (the burst of the 237 review), written as the login path writes them.
  await pool.query(
    `INSERT INTO auth237_login_events(user_id,subject_hash,outcome,status,ip,created_at)
     SELECT $1,$2,'password_locked',429,'10.238.9.9',clock_timestamp()-(g||' seconds')::interval FROM generate_series(1,150) g`,
    [flooded.user.id, randomBytes(32).toString('hex')]);
  const first = await req('/api/workspaces/security/logins', 'GET', undefined, a.cookie);
  assert.equal(first.statusCode, 200, first.body);
  const page = first.json();
  assert.equal(page.data.length, 50, 'a page, not everything');
  assert(page.meta.cursor, 'more pages');
  assert.deepEqual(page.members.map((m: any) => m.id).sort(), [a.user.id, flooded.user.id, quiet.user.id].sort());
  assert(!JSON.stringify(page).includes(outsider.user.email));
  const quietOnly = (await req('/api/workspaces/security/logins?user_id=' + quiet.user.id, 'GET', undefined, a.cookie)).json();
  assert(quietOnly.data.length >= 1 && quietOnly.data.every((e: any) => e.user_email === quiet.user.email));
  assert(quietOnly.data.some((e: any) => e.outcome === 'password_failed'), 'the quiet member is reachable despite the burst');
  const failed = (await req('/api/workspaces/security/logins?outcome=password_failed', 'GET', undefined, a.cookie)).json().data;
  assert(failed.length >= 1 && failed.every((e: any) => e.outcome === 'password_failed'));
  const { seen } = await all('/api/workspaces/security/logins?limit=40&user_id=' + flooded.user.id, a.cookie);
  assert(seen.length >= 150);
  assert.equal(new Set(seen.map((e) => e.id)).size, seen.length, 'no row twice');
  assert.deepEqual((await req('/api/workspaces/security/logins?user_id=' + outsider.user.id, 'GET', undefined, a.cookie)).json().data, [], 'not a member: nothing');
  for (const q of ['after=nope', 'user_id=1', 'limit=500', 'outcome=hacked', 'x=1'])
    assert.equal((await req('/api/workspaces/security/logins?' + q, 'GET', undefined, a.cookie)).statusCode, 422, q);
  assert.equal((await req('/api/workspaces/security/logins', 'GET', undefined, quiet.cookie)).statusCode, 403);
});
