/**
 * AUTHORED / NOT_RUN. Genuine PostgreSQL + Fastify API acceptance, not the DOM controlled suite.
 * Root must supply an isolated numeric TEMPLATE clone of accepted schema165, config before imports,
 * DATABASE_URL, DYNA_TEST=true and DYNA_BUYER_ADDRESS_NATIVE=true. Never seed/reset an older DB.
 * The first leaf checks actual pre166 absence, then the registered managed migration installs166.
 * DEMO documents below prove that billing projections remain unchanged; they are not issued159 FV.
 * Full historical/template preservation, restart, encrypted restore and Chrome are root-owned gates.
 */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { Pool, PoolClient } from 'pg';

type Actor = { cookie: string; tenant: string; user: string; warehouse: string };
type Fixture = { owner: Actor; product: any; order: any; token: string; ip: string };
const original = { recipient_name: 'Pierwotny Kupujący', street: 'Stara 5', city: 'Gdańsk',
  postal_code: '80-001', country: 'PL', phone: '+48123456789' };
const changed = { ...original, recipient_name: 'Odbiorca po korekcie', street: 'Nowa 12/3', city: 'Łódź', postal_code: '90-001' };
// JSONB and native HTTP JSON preserve the same values with different object-key order.
// Sort all object keys recursively; keep every field/value, null and array order exact.
const canonicalJson = (v: unknown): string => {
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  if (v !== null && typeof v === 'object') return '{' + Object.entries(v)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, value]) => JSON.stringify(k) + ':' + canonicalJson(value)).join(',') + '}';
  assert.ok(v === null || ['string', 'boolean', 'number'].includes(typeof v), 'Canonical JSON requires actual JSON values');
  return JSON.stringify(v);
};
const digest = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');
const exact = (a: unknown, b: unknown, label: string) => assert.equal(digest(a), digest(b), label);
let app: FastifyInstance, pool: Pool, migrate: () => Promise<void>;
let makeApp: typeof import('../server/app').buildApp;
let owner: Actor, foreign: Actor, viewer: string, absent: Fixture;
let ip = 40, providerCalls = 0;

const request = (who: Actor | string, url: string, method: InjectOptions['method'] = 'GET', payload?: unknown, target = app) =>
  target.inject({ method, url: '/api' + url, payload: payload as any,
    headers: { cookie: typeof who === 'string' ? who : who.cookie, 'idempotency-key': randomUUID() },
    remoteAddress: '127.0.166.' + ip });
async function success(who: Actor | string, url: string, method: InjectOptions['method'] = 'GET', payload?: unknown, code = 200) {
  const r = await request(who, url, method, payload);
  assert.equal(r.statusCode, code, 'Native internal endpoint status');
  return r.json() as any;
}
const publicRequest = (f: Fixture, path = '', method: InjectOptions['method'] = 'GET', payload?: unknown, target = app) =>
  target.inject({ method, url: '/api/public/orders/' + f.token + '/address' + path,
    payload: payload as any, remoteAddress: f.ip });
async function publicSuccess(f: Fixture, path = '', method: InjectOptions['method'] = 'GET', payload?: unknown, code = 200) {
  const r = await publicRequest(f, path, method, payload);
  assert.equal(r.statusCode, code, 'Native public endpoint status');
  assert.equal(r.headers['cache-control'], 'no-store');
  return r.json() as any;
}
function cookie(r: { headers: Record<string, unknown> }) {
  const raw = r.headers['set-cookie'];
  assert.ok(typeof raw === 'string' || Array.isArray(raw), 'Native cookie must exist');
  return (Array.isArray(raw) ? raw[0] : raw).split(';')[0] as string;
}
async function signup(invitation?: string): Promise<Actor> {
  const email = 'address166-' + randomUUID() + '@example.test';
  const r = await request('', '/auth/signup', 'POST', {
    email, name: 'Native address QA', password: 'Address166!' + randomBytes(18).toString('hex'),
    ...(invitation ? { invitation_token: invitation } : { organization: { name: 'Native address166 ' + randomUUID() } }),
  });
  assert.equal(r.statusCode, 201, 'Genuine ordinary signup');
  const auth = cookie(r), me = await success(auth, '/auth/me');
  const spaces = await success(auth, '/workspaces');
  const tenant = spaces.data[0].id;
  const warehouses = await success(auth, '/warehouses');
  return { cookie: auth, tenant, user: me.user.id, warehouse: warehouses.data[0].id };
}
async function fixture(who = owner, point = false): Promise<Fixture> {
  ++ip;
  const product = await success(who, '/products', 'POST', { sku: 'ADR166-' + randomUUID(),
    name: 'Adres native QA', price: 12300, vat: 23, warehouse_id: who.warehouse, quantity: 10 }, 201);
  const order = await success(who, '/orders', 'POST', { customer_name: original.recipient_name,
    email: 'buyer-private@example.test', warehouse_id: who.warehouse, payment_mode: 'cod',
    address: { street: original.street, city: original.city, postal_code: original.postal_code,
      country: original.country, phone: original.phone, ...(point ? { locker_code: 'WAW01M' } : {}) },
    items: [{ product_id: product.id, quantity: 1 }], shipping_cost: 800 }, 201);
  return { owner: who, product, order, token: order.portal_token, ip: '127.0.167.' + ip };
}
async function row(f: Fixture) {
  return (await pool.query('SELECT to_jsonb(o) v FROM orders o WHERE(tenant_id,id)=($1,$2)', [f.owner.tenant, f.order.id])).rows[0].v;
}
async function state(f: Fixture) {
  return (await pool.query('SELECT to_jsonb(s) v FROM buyer_address_state s WHERE(tenant_id,order_id)=($1,$2)', [f.owner.tenant, f.order.id])).rows[0]?.v ?? null;
}
async function access(f: Fixture, enabled = true, classify = true) {
  const o = await row(f), s = await state(f);
  return success(f.owner, '/orders/' + f.order.id + '/buyer-address-access', 'PATCH', {
    version: Number(o.version), policy_version: s ? Number(s.version) : 0, enabled,
    ...(classify ? { delivery_kind: 'address', confirmed_delivery_kind: true } : {}),
  });
}
function assertPublic(v: any) {
  assert.deepEqual(Object.keys(v).sort(), ['available', 'read_only', 'enabled', 'can_edit', 'reason', 'delivery', 'revision', 'last_change'].sort());
  assert.equal(typeof v.available, 'boolean');
  assert.equal(typeof v.read_only, 'boolean');
  if (v.delivery) assert.deepEqual(Object.keys(v.delivery).sort(), Object.keys(original).sort());
  // Neither opaque revision nor status wire may expose token/order/tenant identity.
  assert.ok(!JSON.stringify(v).includes('portal_token'));
}
async function preview(f: Fixture, delivery = changed, key = randomUUID()) {
  const before = await publicSuccess(f); assertPublic(before);
  const body = { client_key: key, revision: before.revision, delivery };
  const p = await publicSuccess(f, '/previews', 'POST', body, 201);
  assert.deepEqual(Object.keys(p).sort(), ['available', 'read_only', 'id', 'scope_hash', 'expires_at', 'before', 'after', 'changed', 'state', 'local_only', 'reused'].sort());
  exact(p.before, before.delivery, 'Preview binds actual current address');
  exact(p.after, delivery, 'Preview binds submitted address');
  return { p, body, before };
}
const applyBody = (p: any, key = randomUUID()) => ({ client_key: key, scope_hash: p.scope_hash, confirmed: true, local_only: true });
async function apply(f: Fixture, p: any, body = applyBody(p), code = 201) {
  const r = await publicSuccess(f, '/previews/' + p.id + '/apply', 'POST', body, code);
  assert.deepEqual(Object.keys(r).sort(), ['available', 'read_only', 'id', 'state', 'changed', 'delivery', 'revision', 'created_at', 'reused'].sort());
  assert.equal(r.state, 'applied'); exact(r.delivery, p.after, 'Applied frozen delivery');
  return r;
}

// Whole business graph of the two newly created fixture tenants only. Root owns the old TEMPLATE graph.
async function captureTenant(tenant: string) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TimeZone='UTC'");
    const names = (await c.query(`SELECT c.relname FROM pg_class c WHERE c.relnamespace='public'::regnamespace
      AND c.relkind='r' AND EXISTS(SELECT FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='tenant_id' AND NOT a.attisdropped)
      ORDER BY c.relname`)).rows;
    const result: Record<string, any[]> = {};
    for (const { relname } of names) {
      assert.match(relname, /^[a-z0-9_]+$/);
      result[relname] = (await c.query(`SELECT to_jsonb(t) v FROM public."${relname}" t WHERE tenant_id=$1 ORDER BY to_jsonb(t)::text`, [tenant])).rows.map(x => x.v);
    }
    await c.query('COMMIT'); return result;
  } finally { await c.query('ROLLBACK'); c.release(); }
}
async function zero(f: Fixture, operation: () => Promise<unknown>) {
  const before = await captureTenant(f.owner.tenant);
  const result = await operation();
  exact(await captureTenant(f.owner.tenant), before, 'Grouped read/refusal/replay business default-zero');
  return result;
}
function retainOld(before: any[], after: any[], label: string) {
  for (const old of before) assert.ok(after.some(next => digest(next) === digest(old)), label);
}
async function deliveryDelta(f: Fixture, operation: () => Promise<unknown>, changes: boolean) {
  const before = await captureTenant(f.owner.tenant), oldOrder = await row(f);
  const result = await operation();
  const after = await captureTenant(f.owner.tenant), newOrder = await row(f);
  const allowed = new Set(['buyer_address_receipts', 'buyer_address_state', ...(changes ? ['orders', 'order_events', 'audit_events'] : [])]);
  for (const name of Object.keys(before)) if (!allowed.has(name)) exact(after[name], before[name], 'Unrelated own business rows retained: ' + name);
  assert.equal(after.buyer_address_receipts.length, before.buyer_address_receipts.length + 1);
  retainOld(before.buyer_address_receipts, after.buyer_address_receipts, 'Existing immutable receipts retained');
  const receipt = after.buyer_address_receipts.find(next => !before.buyer_address_receipts.some(old => old.id === next.id));
  assert.equal(receipt.tenant_id, f.owner.tenant); assert.equal(receipt.order_id, f.order.id);
  assert.equal(receipt.kind, 'delivery'); assert.equal(receipt.changed, changes);
  assert.equal(BigInt(receipt.before_order_version), BigInt(oldOrder.version));
  assert.equal(BigInt(receipt.after_order_version), BigInt(oldOrder.version) + (changes ? 1n : 0n));
  assert.equal(after.orders.length, before.orders.length);
  assert.equal(after.buyer_address_state.length, before.buyer_address_state.length);
  for (const old of before.buyer_address_state) if (old.order_id !== f.order.id)
    assert.ok(after.buyer_address_state.some(next => digest(next) === digest(old)), 'Other own current pointers retained');
  if (changes) {
    assert.equal(BigInt(newOrder.version), BigInt(oldOrder.version) + 1n);
    const strip = (v: any) => Object.fromEntries(Object.entries(v).filter(([k]) => !['version', 'updated_at'].includes(k)));
    exact(strip(newOrder), strip(oldOrder), 'Only order version and updated_at change');
    for (const old of before.orders) if (old.id !== f.order.id) assert.ok(after.orders.some(next => digest(next) === digest(old)), 'Other own orders retained');
    assert.equal(after.order_events.length, before.order_events.length + 1);
    assert.equal(after.audit_events.length, before.audit_events.length + 1);
    retainOld(before.order_events, after.order_events, 'Old local events retained');
    retainOld(before.audit_events, after.audit_events, 'Old audits retained');
    const addedEvent = after.order_events.find(next => !before.order_events.some(old => old.id === next.id));
    assert.equal(addedEvent.order_id, f.order.id);
    const current = after.buyer_address_state.find(next => next.order_id === f.order.id);
    const previous = before.buyer_address_state.find(next => next.order_id === f.order.id);
    assert.equal(current.last_receipt_id, receipt.id);
    assert.equal(BigInt(current.version), BigInt(previous.version) + 1n);
    assert.equal(BigInt(current.delivery_version), BigInt(previous.delivery_version) + 1n);
    const addedAudit = after.audit_events.find(next => !before.audit_events.some(old => old.id === next.id));
    assert.equal(addedAudit.action, 'buyer.delivery_address.changed'); assert.equal(addedAudit.entity_id, f.order.id);
    const safe = JSON.stringify(addedEvent);
    for (const secret of [original.street, changed.street, f.token]) assert.ok(!safe.includes(secret), 'Local event carries no private address/token');
  } else {
    exact(newOrder, oldOrder, 'No-op does not touch order');
    exact(after.buyer_address_state, before.buyer_address_state, 'No-op does not move current pointer');
  }
  return result;
}

// Real native waiter cause, not a timed assumption. The holder changes only this owned test order.
async function heldOrder(f: Fixture, change: (c: PoolClient) => Promise<unknown>, operation: () => Promise<any>) {
  const c = await pool.connect(); let pending: Promise<any> | undefined; let waiter: number | undefined;
  try {
    await c.query('BEGIN');
    const holder = Number((await c.query('SELECT pg_backend_pid() pid')).rows[0].pid);
    await c.query('SELECT id FROM orders WHERE(tenant_id,id)=($1,$2) FOR UPDATE', [f.owner.tenant, f.order.id]);
    await change(c); pending = operation();
    for (let i = 0; i < 160; i++) {
      const waits = (await pool.query(`SELECT pid FROM pg_stat_activity WHERE datname=current_database()
        AND pid<>$1 AND $1=ANY(pg_blocking_pids(pid)) AND state='active'`, [holder])).rows;
      if (waits.length === 1) { waiter = Number(waits[0].pid); break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(waiter, 'Actual request must wait on this own order holder');
    await c.query('COMMIT'); return await pending;
  } catch (e) {
    if (waiter) await pool.query('SELECT pg_cancel_backend($1)', [waiter]);
    throw e;
  } finally {
    await c.query('ROLLBACK'); c.release();
    if (pending) await pending.catch(() => undefined);
  }
}

before(async () => {
  assert.equal(process.env.DYNA_TEST, 'true');
  assert.equal(process.env.DYNA_BUYER_ADDRESS_NATIVE, 'true', 'Root explicitly authorizes this isolated native gate');
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.match(url.pathname, /^\/dynaminds_test_[0-9]{13}$/);
  assert.ok(process.env.DYNA_LOCAL_CONFIG_PATH, 'Root supplies private config before runtime imports');
  const db = await import('../server/db'); pool = db.pool; migrate = db.migrate;
  ({ buildApp: makeApp } = await import('../server/app'));
  const ledger = (await pool.query("SELECT name FROM migrations WHERE name IN('165_competitor_observation_portability','166_buyer_address_sidecar') ORDER BY name")).rows;
  exact(ledger, [{ name: '165_competitor_observation_portability' }], 'Start from intact accepted165 template, never migrate older controls from empty');
  app = await makeApp({ backgroundWorkersEnabled: false, integrationTransport: async () => { providerCalls++; throw Error('Unexpected native provider call'); } });
  owner = await signup(); ++ip; foreign = await signup();
  const inviteEmail = 'address166-viewer-' + randomUUID() + '@example.test';
  const invite = await success(owner, '/workspaces/invitations', 'POST', { email: inviteEmail, role: 'viewer' }, 201);
  const r = await request('', '/auth/signup', 'POST', { email: inviteEmail, name: 'Address viewer', password: 'Address166!' + randomBytes(18).toString('hex'), invitation_token: invite.token });
  assert.equal(r.statusCode, 201); viewer = cookie(r);
  absent = await fixture();
});
after(async () => {
  const closed = [await Promise.allSettled([app?.close()]), await Promise.allSettled([pool?.end()])].flat();
  for (const result of closed) assert.equal(result.status, 'fulfilled', 'Owned application and pool closed');
  assert.equal(providerCalls, 0, 'No remote provider called by this suite');
});

test('actual165 absence is neutral GET and503 write; only then managed166 installation', async () => {
  await zero(absent, async () => {
    const s = await publicSuccess(absent); assertPublic(s);
    assert.equal(s.available, false); assert.equal(s.reason, 'module_unavailable');
    assert.equal(s.delivery, null);
    assert.equal((await publicRequest(absent, '/previews', 'POST', { client_key: randomUUID(), revision: 'none', delivery: changed })).statusCode, 503);
  });
  await app.close(); await migrate();
  app = await makeApp({ backgroundWorkersEnabled: false, integrationTransport: async () => { providerCalls++; throw Error('Unexpected native provider call'); } });
  assert.equal((await pool.query("SELECT count(*)::int n FROM migrations WHERE name='166_buyer_address_sidecar'")).rows[0].n, 1);
});
test('operator opt-in, exact public preview/apply and local-only one-version transition', async () => {
  const f = await fixture();
  const off = await publicSuccess(f); assert.equal(off.enabled, false); assert.equal(off.delivery, null);
  const beforePolicy = await row(f); await access(f); exact(await row(f), beforePolicy, 'Policy-only does not update order');
  const { p, body } = await preview(f);
  await zero(f, async () => {
    const replay = await publicSuccess(f, '/previews', 'POST', body, 200); assert.equal(replay.id, p.id); assert.equal(replay.reused, true);
    const read = await publicSuccess(f, '/previews/' + p.id);
    assert.deepEqual(Object.keys(read).sort(), ['preview', 'receipt', 'can_apply', 'reason'].sort());
    assert.equal(read.preview.id, p.id); assert.equal(read.receipt, null); assert.equal(read.can_apply, true);
  });
  const a = await deliveryDelta(f, () => apply(f, p), true) as any;
  assert.equal(a.reused, false);
  const current = await publicSuccess(f); exact(current.delivery, changed, 'Current public effective address');
  const card = await success(owner, '/orders/' + f.order.id);
  exact(card.address, f.order.address, 'Original bill-to address remains original on order card');
  const stored = JSON.stringify((await captureTenant(owner.tenant)).buyer_address_receipts);
  assert.ok(!stored.includes(changed.street)); assert.ok(!stored.includes(f.token));
});
test('fresh native shipping snapshot uses corrected delivery while existing and future DEMO billing stay original', async () => {
  async function paid(f: Fixture) {
    const o = await row(f);
    await success(f.owner, '/orders/' + o.id + '/payments', 'POST', { client_key: randomUUID(),
      version: Number(o.version), kind: 'receipt', amount: Number(o.total), currency: 'PLN', reference: 'Native address gate', confirmed: true });
    if ((await row(f)).status === 'new') await success(f.owner, '/orders/' + o.id + '/status', 'PATCH', { status: 'paid' });
  }
  const f = await fixture(); await paid(f);
  const oldDocument = await success(owner, '/orders/' + f.order.id + '/documents', 'POST', { kind: 'invoice' });
  assert.equal(oldDocument.mode, 'demo'); exact(oldDocument.data.address, f.order.address, 'Original DEMO billing');
  const documentRow = async () => (await pool.query('SELECT to_jsonb(d) v FROM documents d WHERE(tenant_id,id)=($1,$2)', [owner.tenant, oldDocument.id])).rows[0].v;
  const frozenDocument = await documentRow();
  await access(f); const { p } = await preview(f); await apply(f, p);
  await success(owner, '/orders/' + f.order.id + '/status', 'PATCH', { status: 'picking' });
  await success(owner, '/orders/' + f.order.id + '/scan', 'POST', { code: f.product.sku });
  await success(owner, '/orders/' + f.order.id + '/status', 'PATCH', { status: 'packed' });
  const channel = await success(owner, '/shipping/example', 'POST', {});
  // Receiver is the operator's explicit input. This assertion concerns the fresh native frozen order basis.
  const shipping = await success(owner, '/orders/' + f.order.id + '/shipping/preview', 'POST', {
    channel_id: channel.id, service: 'inpost_courier_standard', weight: 1, cod: 0, insurance: 0,
    dimensions: { length: 100, width: 100, height: 100 },
    receiver: { first_name: 'Odbiorca', last_name: 'QA', email: 'buyer-private@example.test', phone: changed.phone,
      address: { street: 'Nowa', building_number: '12/3', city: changed.city, post_code: changed.postal_code, country_code: changed.country } },
  });
  assert.equal(shipping.scope, 'local_simulation');
  const plan = (await pool.query('SELECT order_snapshot FROM shipping_plans WHERE(tenant_id,id,order_id)=($1,$2,$3)', [owner.tenant, shipping.id, f.order.id])).rows[0];
  assert.deepEqual(Object.keys(plan.order_snapshot.buyer_delivery).sort(), ['version', 'hash', 'delivery'].sort());
  exact(plan.order_snapshot.buyer_delivery.delivery, changed, 'Fresh shipment binds accepted delivery');
  assert.equal(plan.order_snapshot.buyer_delivery.version, String((await state(f)).delivery_version));
  const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
  assert.equal(plan.order_snapshot.buyer_delivery.hash, digest(canonical(changed)));
  exact(plan.order_snapshot.address, f.order.address, 'Original buyer remains a separate frozen basis');
  exact(await documentRow(), frozenDocument, 'Existing invoice row stays byte-for-byte represented');
  const second = await fixture(); await access(second); const q = (await preview(second)).p; await apply(second, q); await paid(second);
  const later = await success(owner, '/orders/' + second.order.id + '/documents', 'POST', { kind: 'invoice' });
  exact(later.data.address, second.order.address, 'New DEMO invoice keeps original billing after correction');
  assert.equal(later.data.customer, original.recipient_name);
});
test('no-op keeps order/pointer unchanged; exact replay and key conflict do not create effects', async () => {
  const f = await fixture(); await access(f); const { p } = await preview(f, original);
  assert.equal(p.changed, false); const body = applyBody(p);
  const a = await deliveryDelta(f, () => apply(f, p, body), false) as any;
  await zero(f, async () => {
    const replay = await apply(f, p, body, 200); assert.equal(replay.id, a.id); assert.equal(replay.reused, true);
    assert.equal((await publicRequest(f, '/previews/' + p.id + '/apply', 'POST', { ...body, scope_hash: '0'.repeat(64) })).statusCode, 409);
  });
});
test('two concurrent different applies from one revision admit exactly one effect', async () => {
  const f = await fixture(); await access(f);
  const a = (await preview(f)).p, b = (await preview(f, { ...changed, street: 'Trzecia 7' })).p;
  const before = await row(f), count = (await pool.query('SELECT count(*)::int n FROM buyer_address_receipts WHERE order_id=$1', [f.order.id])).rows[0].n;
  const responses = await Promise.all([publicRequest(f, '/previews/' + a.id + '/apply', 'POST', applyBody(a)), publicRequest(f, '/previews/' + b.id + '/apply', 'POST', applyBody(b))]);
  assert.deepEqual(responses.map(r => r.statusCode).sort(), [201, 409]);
  assert.equal(BigInt((await row(f)).version), BigInt(before.version) + 1n);
  assert.equal((await pool.query('SELECT count(*)::int n FROM buyer_address_receipts WHERE order_id=$1', [f.order.id])).rows[0].n, count + 1);
});
test('fresh sidecar CAS, opt-out and token rotation prevent stale reads and terminal replay', async () => {
  const f = await fixture(); const before = await row(f); await access(f);
  assert.equal((await request(owner, '/orders/' + f.order.id + '/buyer-address-access', 'PATCH', { version: Number(before.version), policy_version: 0, enabled: false })).statusCode, 409);
  const { p } = await preview(f), body = applyBody(p); await apply(f, p, body); await access(f, false, false);
  await zero(f, async () => { const s = await publicSuccess(f); assert.equal(s.enabled, false); assert.equal(s.delivery, null); assert.equal(s.revision, null);
    assert.equal((await publicRequest(f, '/previews/' + p.id + '/apply', 'POST', body)).statusCode, 404); });
  await access(f, true, false);
  const rotated = await success(owner, '/orders/' + f.order.id + '/portal', 'POST', { action: 'rotate', days: 30 });
  await zero(f, async () => { assert.equal((await publicRequest(f)).statusCode, 404); assert.equal((await publicRequest(f, '/previews/' + p.id + '/apply', 'POST', body)).statusCode, 404); });
  const fresh = { ...f, token: rotated.portal_token }; assert.equal((await publicSuccess(fresh)).can_edit, true);
});
test('strict malformed/same-country/point/foreign plan and internal ACL refusals are write-free', async () => {
  const f = await fixture(), other = await fixture(foreign); await access(f); await access(other);
  const s = await publicSuccess(f), p = (await preview(other)).p;
  await zero(f, async () => {
    for (const delivery of [{ ...changed, email: 'forbidden@example.test' }, { ...changed, country: 'DE' }, { ...changed, phone: '123 456 789' }, { ...changed, street: '\nBad' }])
      assert.equal((await publicRequest(f, '/previews', 'POST', { client_key: randomUUID(), revision: s.revision, delivery })).statusCode, 422);
    assert.equal((await publicRequest(f, '/previews/' + p.id + '/apply', 'POST', applyBody(p))).statusCode, 404);
    assert.equal((await request(viewer, '/orders/' + f.order.id + '/buyer-address-access', 'PATCH', { version: Number(f.order.version), policy_version: 1, enabled: false })).statusCode, 403);
    assert.equal((await request(foreign, '/orders/' + f.order.id + '/buyer-address-history')).statusCode, 404);
    const read = await success(viewer, '/orders/' + f.order.id + '/buyer-address-history'); assert.ok(Array.isArray(read.data));
  });
  const point = await fixture(owner, true);
  await zero(point, async () => { assert.equal((await request(owner, '/orders/' + point.order.id + '/buyer-address-access', 'PATCH', { version: Number(point.order.version), policy_version: 0, enabled: true, delivery_kind: 'address', confirmed_delivery_kind: true })).statusCode, 409); });
});
test('actual held order revoke and picking transition are rechecked after the native wait', async () => {
  for (const kind of ['revoke', 'picking'] as const) {
    const f = await fixture(); await access(f); const { p } = await preview(f);
    const count = (await pool.query('SELECT count(*)::int n FROM buyer_address_receipts WHERE order_id=$1', [f.order.id])).rows[0].n;
    const r = await heldOrder(f, c => c.query(kind === 'revoke' ? 'UPDATE orders SET portal_enabled=false WHERE id=$1' : "UPDATE orders SET status='picking',updated_at=clock_timestamp() WHERE id=$1", [f.order.id]),
      () => publicRequest(f, '/previews/' + p.id + '/apply', 'POST', applyBody(p)));
    assert.equal(r.statusCode, kind === 'revoke' ? 404 : 409);
    assert.equal((await pool.query('SELECT count(*)::int n FROM buyer_address_receipts WHERE order_id=$1', [f.order.id])).rows[0].n, count);
  }
  const f = await fixture(); await access(f); const { p } = await preview(f);
  const r = await heldOrder(f, async () => {}, () => publicRequest(f, '/previews/' + p.id + '/apply', 'POST', applyBody(p)));
  assert.equal(r.statusCode, 201, 'Unchanged actual held fence permits one positive application');
});
test('native v1 scope and current key expiry are checked again after an actual order lock wait', async () => {
  const f = await fixture();
  const read = await success(owner, '/developer/keys', 'POST', { name: 'Address read gate', scopes: ['orders:read'], expires_days: 30 }, 201);
  const writer = await success(owner, '/developer/keys', 'POST', { name: 'Address write gate', scopes: ['orders:read', 'orders:write'], expires_days: 30 }, 201);
  const api = (key: any, path: string, method: InjectOptions['method'] = 'GET', payload?: unknown) => app.inject({
    method, url: '/api/v1/orders/' + f.order.id + path, payload: payload as any,
    headers: { authorization: 'Bearer ' + key.token }, remoteAddress: f.ip,
  });
  await zero(f, async () => {
    assert.equal((await api(read, '/buyer-address-history')).statusCode, 200);
    assert.equal((await api(read, '/buyer-address-access', 'PATCH', { version: Number(f.order.version), policy_version: 0,
      enabled: true, delivery_kind: 'address', confirmed_delivery_kind: true })).statusCode, 403);
  });
  const policy = await api(writer, '/buyer-address-access', 'PATCH', { version: Number(f.order.version), policy_version: 0,
    enabled: true, delivery_kind: 'address', confirmed_delivery_kind: true });
  assert.equal(policy.statusCode, 200);
  const oldState = await state(f), beforeOrder = await row(f);
  const receipts = (await pool.query('SELECT count(*)::int n FROM buyer_address_receipts WHERE(tenant_id,order_id)=($1,$2)', [owner.tenant, f.order.id])).rows[0].n;
  const response = await heldOrder(f, c => c.query("UPDATE api_keys SET expires_at=clock_timestamp()-interval '1 second' WHERE(tenant_id,id)=($1,$2)", [owner.tenant, writer.id]),
    () => api(writer, '/buyer-address-access', 'PATCH', { version: Number(beforeOrder.version), policy_version: Number(oldState.version), enabled: false }));
  assert.equal(response.statusCode, 401);
  exact(await state(f), oldState, 'Expiry after initial middleware and before locked policy check leaves state unchanged');
  exact(await row(f), beforeOrder, 'Expired admin key does not update order');
  assert.equal((await pool.query('SELECT count(*)::int n FROM buyer_address_receipts WHERE(tenant_id,order_id)=($1,$2)', [owner.tenant, f.order.id])).rows[0].n, receipts);
});
test('readonly native mode refuses malformed writes before parse and permits truthful public GET', async () => {
  const f = await fixture(); await access(f);
  const ro = await makeApp({ readOnly: true, previewPort: 4194, backgroundWorkersEnabled: false });
  try { await zero(f, async () => {
    const s = (await publicRequest(f, '', 'GET', undefined, ro)).json(); assertPublic(s); assert.equal(s.read_only, true); assert.equal(s.can_edit, false);
    for (const path of ['/previews', '/previews/' + randomUUID() + '/apply']) {
      const r = await ro.inject({ url: '/api/public/orders/' + f.token + '/address' + path, method: 'POST', payload: '{', headers: { 'content-type': 'application/json' } });
      assert.equal(r.statusCode, 423);
    }
    const r = await ro.inject({ url: '/api/orders/' + f.order.id + '/buyer-address-access', method: 'PATCH', payload: '{', headers: { 'content-type': 'application/json' } });
    assert.equal(r.statusCode, 423);
  }); } finally { await ro.close(); }
});
