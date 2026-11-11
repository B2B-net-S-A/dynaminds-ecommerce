/** Migration 266 through the real app (buildApp, session cookies): the accountant "Księgowa" (a viewer membership with
 * a grant) reads like a viewer, changes only the order card's payment section and uses payment imports (match and
 * confirm a transfer); the server refuses every other write. And the tenant setting "Drukuj etykietę przy pakowaniu":
 * off = no label after packing, on = the DEMO label after the last scan (demo carrier only). */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { migrate, pool, tenantTx } from '../server/db';
import { buildApp } from '../server/app';
import { registerPaymentImportRoutes } from '../server/payment-import-routes';
import { processPaymentImportJob } from '../server/payment-imports';
import { isDemoCarrier } from '../server/order-settings';
import { seed } from './fixtures';
assert.equal(process.env.DYNA_TEST, 'true');
type Row = Record<string, any>;
let app: FastifyInstance, tenant: string, warehouse: string, product: Row;
const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};
let n = 1;
const req = (url: string, method: any = 'GET', payload?: unknown, as = 'admin') =>
  app.inject({ url: '/api' + url, method, ...(payload === undefined ? {} : { payload: payload as any }), remoteAddress: '127.0.2.' + (n++ % 250 + 1), headers: { cookie: cookies[as] } });
async function ok(url: string, method: any = 'GET', payload?: unknown, as = 'admin') {
  const r = await req(url, method, payload, as);
  assert(r.statusCode < 300, method + ' ' + url + ' as ' + as + ': ' + r.body);
  return r.json();
}
async function refused(url: string, method: any, payload: unknown, as: string, status = 403) {
  const r = await req(url, method, payload, as);
  assert.equal(r.statusCode, status, method + ' ' + url + ' as ' + as + ': ' + r.body);
  return r.json();
}
async function login(email: string) {
  const r = await app.inject({ url: '/api/auth/login', method: 'POST', payload: { email, password: 'DynaDemo!2026' } });
  assert.equal(r.statusCode, 200, r.body);
  return String(r.headers['set-cookie']).split(';')[0];
}
async function switchTo(as: string) {
  const r = await req('/workspaces/switch', 'POST', { tenant_id: tenant }, as);
  assert.equal(r.statusCode, 200, r.body);
  cookies[as] = String(r.headers['set-cookie']).split(';')[0];
  return r.json().user;
}

before(async () => {
  await migrate();
  await seed();
  app = await buildApp();
  if (!app.hasRoute({ method: 'GET', url: '/api/payment-imports/profiles' })) registerPaymentImportRoutes(app, { available: true, readOnly: false });
  // A fresh firm: admin@ is its administrator, viewer@ its accountant, operator@ a plain viewer.
  tenant = randomUUID();
  warehouse = randomUUID();
  await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,'QA Księgowa 266','enterprise')", [tenant]);
  for (const [who, role] of [['admin', 'admin'], ['viewer', 'viewer'], ['operator', 'viewer']] as const) {
    ids[who] = (await pool.query('SELECT id FROM users WHERE email=$1', [who + '@demo.local'])).rows[0].id;
    await pool.query('INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)', [tenant, ids[who], role]);
    cookies[who] = await login(who + '@demo.local');
  }
  await pool.query('INSERT INTO accountant266_memberships(tenant_id,user_id,granted_by) VALUES($1,$2,$3)', [tenant, ids.viewer, ids.admin]);
  await pool.query("INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'QA 266','K66')", [warehouse, tenant]);
  for (const who of ['admin', 'viewer', 'operator']) await switchTo(who);
  product = await ok('/products', 'POST', { sku: 'K266-' + randomUUID().slice(0, 8), name: 'Lampa 266', price: 10000, warehouse_id: warehouse, quantity: 100 });
});
after(async () => {
  await app.close();
  await pool.end();
});
const order = (extra: Row = {}) =>
  ok('/orders', 'POST', {
    customer_name: 'Anna Księgowa',
    email: `k266-${randomUUID()}@example.test`,
    warehouse_id: warehouse,
    items: [{ product_id: product.id, quantity: 2 }],
    address: { street: 'Polna 1', city: 'Gdańsk', postal_code: '80-001', phone: '500600700' },
    ...extra,
  });
const section = (o: Row, name: string, values: Row, as: string) =>
  req(`/orders/${o.id}/sections/${name}`, 'PATCH', { expected_version: Number(o.version), values }, as);

test('the accountant session: role viewer with the accountant flag, label Księgowa in the switcher', async () => {
  const me = (await ok('/auth/me', 'GET', undefined, 'viewer')).user;
  assert.equal(me.role, 'viewer');
  assert.equal(me.accountant, true);
  assert.equal((await ok('/auth/me', 'GET', undefined, 'operator')).user.accountant, false);
  assert.equal((await ok('/auth/me', 'GET', undefined, 'admin')).user.accountant, false);
  const mine = (await ok('/workspaces', 'GET', undefined, 'viewer')).data.find((w: Row) => w.id === tenant);
  assert.equal(mine.role, 'accountant');
});

test('order card: the accountant reads every section and edits only Płatność, by the administrator rules', async () => {
  const o = await order();
  const card = await ok('/orders/' + o.id, 'GET', undefined, 'viewer');
  for (const s of ['customer', 'delivery_address', 'invoice', 'products', 'delivery_method', 'extra'])
    assert(card.section_locks[s].locked && /tylko do odczytu/.test(card.section_locks[s].reason), s);
  assert.deepEqual(card.section_locks.payment, { locked: false });
  assert.deepEqual(card.payment_edit, { state: { locked: false }, method: { locked: false } });
  // A plain viewer and the operator keep their old layers.
  const plain = await ok('/orders/' + o.id, 'GET', undefined, 'operator');
  assert(plain.payment_edit.state.locked && plain.section_locks.payment.locked);
  // Server, not only the UI: other sections and other writes are refused.
  assert.match((await refused(`/orders/${o.id}/sections/customer`, 'PATCH', { expected_version: Number(o.version), values: { name: 'X Y' } }, 'viewer')).detail, /tylko sekcję Płatność/);
  await refused(`/orders/${o.id}/sections/payment`, 'PATCH', { expected_version: Number(o.version), values: { state: 'paid' } }, 'operator');
  await refused('/orders', 'POST', { customer_name: 'X', email: 'x@example.test', warehouse_id: warehouse, items: [{ product_id: product.id, quantity: 1 }] }, 'viewer');
  await refused(`/orders/${o.id}/status`, 'PATCH', { status: 'cancelled', expected_version: String(o.version) }, 'viewer');
  // The payment state and the method change through the ledger, as for the administrator.
  const partial = await section(o, 'payment', { state: 'partial', amount: 5000, reference: 'Przelew 1/2', paid_at: '2026-11-09' }, 'viewer');
  assert.equal(partial.statusCode, 200, partial.body);
  const p = partial.json();
  assert.equal(p.payment.net, 5000);
  const edit = p.events.filter((e: Row) => e.kind === 'order.section_edited').at(-1);
  assert.equal(edit.detail.actor_id, ids.viewer);
  const method = await section(p, 'payment', { method: 'card' }, 'viewer');
  assert.equal(method.statusCode, 200, method.body);
  const paid = await section(method.json(), 'payment', { state: 'paid', reference: 'Przelew 2/2', paid_at: '2026-11-10' }, 'viewer');
  assert.equal(paid.statusCode, 200, paid.body);
  assert.equal(paid.json().payment.amount_due, 0);
  assert.equal(paid.json().section_values.payment.state, 'paid');
  assert.equal(paid.json().section_values.payment.method, 'card');
});

test('Przelewy i pobrania: the accountant matches and confirms a transfer; a plain viewer is refused', async () => {
  await refused('/payment-imports/namespaces', 'GET', undefined, 'operator');
  const o = await order();
  const ns = await ok('/payment-imports/namespaces', 'POST', { client_key: randomUUID(), label: 'Bank 266', source_kind: 'shared_settlement' }, 'viewer');
  const definition = {
    name: 'Bank 266', source_kind: 'bank_statement', source_namespace_id: ns.id, transaction_id_scope: 'namespace', mode: 'bank_receipt',
    encoding: 'utf-8', delimiter: ';', header: true, skip_records: 0, decimal_separator: ',', grouping_separator: 'none',
    sign: 'credit_positive', date_format: 'YYYY-MM-DD', fixed_currency: 'PLN',
    columns: { transaction_id: { index: 0 }, booking_date: { index: 1 }, amount: { index: 2 }, reference: [{ index: 3 }], order_reference: { index: 3 } },
    match: { kind: 'order_number', extraction: 'whole_field' },
  };
  const p = await ok('/payment-imports/profiles', 'POST', { client_key: randomUUID(), definition }, 'viewer');
  const csv = `tx;date;amount;order\nK266-${randomUUID()};2026-11-09;${(o.total / 100).toFixed(2).replace('.', ',')};${o.number}\n`;
  const upload = await ok('/payment-imports/uploads', 'POST', { client_key: randomUUID(), profile_id: p.id, profile_version: p.version, filename: 'bank.csv', content_base64: Buffer.from(csv).toString('base64') }, 'viewer');
  const head = await ok('/payment-imports/previews', 'POST', { client_key: randomUUID(), file_id: upload.file_id, profile_id: p.id, profile_version: p.version }, 'viewer');
  const view = await ok('/payment-imports/previews/' + head.id, 'GET', undefined, 'viewer');
  assert.equal(view.data[0].classification, 'ready');
  await refused(`/payment-imports/previews/${view.id}/queue`, 'POST', { client_key: randomUUID(), version: view.version, row_ids: [view.data[0].row_id], scope_hash: view.scope_hash, confirmed: true, local_ledger_only: true }, 'operator');
  const e = await ok(`/payment-imports/previews/${view.id}/queue`, 'POST', { client_key: randomUUID(), version: view.version, row_ids: [view.data[0].row_id], scope_hash: view.scope_hash, confirmed: true, local_ledger_only: true }, 'viewer');
  const job = (await pool.query("UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$2,locked_at=now() WHERE id=$1 RETURNING *", [e.job_id, randomUUID()])).rows[0];
  assert.equal((await processPaymentImportJob(job)).state, 'done');
  const after = await ok('/orders/' + o.id, 'GET', undefined, 'viewer');
  assert.equal(after.payment.amount_due, 0);
  assert.equal(after.status, 'paid');
  // Splitting a payment (124) re-checks the role in the database: a session accountant passes, a plain viewer
  // and an accountant's API key do not.
  const access = (uid: string, kid: string | null) =>
    tenantTx(tenant, async (c) => (await c.query('SELECT payment_allocation_access($1,$2,false) g', [uid, kid])).rows[0].g);
  assert.equal((await access(ids.viewer, null)).allowed, true);
  assert.equal((await access(ids.operator, null)).allowed, false);
  assert.equal((await access(ids.viewer, randomUUID())).allowed, false);
  assert.equal((await access(ids.admin, null)).allowed, true);
});

test('team: invite as Księgowa, role shown as accountant, change to and from the accountant role', async () => {
  const email = `ksiegowa-${randomUUID().slice(0, 8)}@example.test`;
  const inv = await ok('/workspaces/invitations', 'POST', { email, role: 'accountant' });
  assert.equal(inv.role, 'accountant');
  const stored = (await pool.query('SELECT i.role,g.invitation_id FROM workspace_invitations i LEFT JOIN accountant266_invitations g ON g.invitation_id=i.id WHERE i.id=$1', [inv.id])).rows[0];
  assert.deepEqual(stored, { role: 'viewer', invitation_id: inv.id }, 'a viewer invitation with the accountant intent');
  const settings = await ok('/workspaces/settings');
  assert.equal(settings.invitations.find((i: Row) => i.id === inv.id).role, 'accountant');
  assert.equal(settings.members.find((m: Row) => m.id === ids.viewer).role, 'accountant');
  assert.equal(settings.members.find((m: Row) => m.id === ids.operator).role, 'viewer');
  // Signup through the invitation: a viewer membership with the grant.
  const signup = await app.inject({ url: '/api/auth/signup', method: 'POST', payload: { email, name: 'Nowa Księgowa', password: 'Ksiegowa!2026-266', invitation_token: inv.token } });
  assert.equal(signup.statusCode, 201, signup.body);
  assert.equal(signup.json().user.accountant, true);
  assert.equal(signup.json().user.role, 'viewer');
  // Plain viewer -> accountant -> operator -> viewer.
  await ok('/workspaces/members/' + ids.operator, 'PATCH', { role: 'accountant' });
  assert.equal((await ok('/auth/me', 'GET', undefined, 'operator')).user.accountant, true);
  await ok('/workspaces/members/' + ids.operator, 'PATCH', { role: 'operator' });
  const op = (await ok('/auth/me', 'GET', undefined, 'operator')).user;
  assert.deepEqual([op.role, op.accountant], ['operator', false]);
  assert.equal((await pool.query('SELECT count(*)::int n FROM accountant266_memberships WHERE tenant_id=$1 AND user_id=$2', [tenant, ids.operator])).rows[0].n, 0);
  await ok('/workspaces/members/' + ids.operator, 'PATCH', { role: 'viewer' });
  assert.equal((await ok('/workspaces/settings')).members.find((m: Row) => m.id === ids.operator).role, 'viewer');
  // Only the administrator manages the team; the accountant cannot grant itself anything.
  await refused('/workspaces/members/' + ids.operator, 'PATCH', { role: 'accountant' }, 'viewer');
  await refused('/workspaces/invitations', 'POST', { email: 'x-' + email, role: 'accountant' }, 'viewer');
  // Removing the membership removes the grant (cascade).
  const userId = (await pool.query('SELECT id FROM users WHERE email=$1', [email])).rows[0].id;
  await ok('/workspaces/members/' + userId, 'DELETE');
  assert.equal((await pool.query('SELECT count(*)::int n FROM accountant266_memberships WHERE user_id=$1', [userId])).rows[0].n, 0);
});

async function packed(o: Row) {
  let cur = await ok(`/orders/${o.id}/status`, 'PATCH', { status: 'paid', expected_version: String(o.version) });
  cur = await ok(`/orders/${o.id}/status`, 'PATCH', { status: 'picking', expected_version: String(cur.version) });
  for (let i = 0; i < 2; i++) cur = await ok(`/orders/${o.id}/scan`, 'POST', { code: product.sku });
  return ok(`/orders/${o.id}/status`, 'PATCH', { status: 'packed', expected_version: String(cur.version) });
}

test('"Drukuj etykietę przy pakowaniu": admin only, off = no label, on = the DEMO label after the last scan, demo carrier only', async () => {
  const initial = await ok('/order-settings', 'GET', undefined, 'viewer');
  assert.deepEqual([initial.available, initial.print_label_at_packing, initial.version], [true, false, 0]);
  await refused('/order-settings', 'PUT', { print_label_at_packing: true, version: 0 }, 'viewer');
  await refused('/order-settings', 'PUT', { print_label_at_packing: true }, 'admin', 422);

  const off = await packed(await order());
  assert.equal(off.status, 'packed');
  assert.equal(off.shipments.length, 0, 'setting off: no label');

  const on = await ok('/order-settings', 'PUT', { print_label_at_packing: true, version: 0 });
  assert.deepEqual([on.print_label_at_packing, on.version], [true, 1]);
  await refused('/order-settings', 'PUT', { print_label_at_packing: false, version: 0 }, 'admin', 409);
  const labelled = await packed(await order());
  assert.equal(labelled.status, 'packed');
  assert.equal(labelled.shipments.length, 1);
  assert.deepEqual([labelled.shipments[0].mode, labelled.shipments[0].carrier, labelled.shipments[0].dispatched_at], ['demo', 'Symulator lokalny', null]);
  assert.equal(labelled.fulfilment_stage, 'ready_to_ship');
  assert(labelled.events.some((e: Row) => e.kind === 'shipment.label_created'));
  // Hand-over still works on the auto label.
  const shipped = await ok(`/orders/${labelled.id}/ship-demo`, 'POST');
  assert.equal(shipped.status, 'shipped');

  // A real carrier chosen in Dostawa: nothing automatic (a real label costs money).
  const o = await order();
  const dpd = await section(o, 'delivery_method', { carrier: 'DPD' }, 'admin');
  assert.equal(dpd.statusCode, 200, dpd.body);
  const real = await packed(dpd.json());
  assert.equal(real.status, 'packed');
  assert.equal(real.shipments.length, 0, 'real carrier: no automatic label');
  assert.deepEqual(['', ' ', 'Symulator lokalny', 'demo', 'DPD', 'InPost'].map(isDemoCarrier), [true, true, true, true, false, false]);
});
