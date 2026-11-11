/** Per-section order editing (Uwagi v3 §6) through the real routes (Fastify injection with the actor the
 * auth hook sets): values, history with values, locks enforced by the server (423), the payment ledger,
 * the version, no migration (the sealed `orders` guards accept every write) and the RODO export and
 * anonymisation of the history values. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, migrate, tenantTx, tenantReadTx } from '../server/db';
import { Problem } from '../server/errors';
import { createOrder, orderSchema, transition, issueDocument, type Actor } from '../server/domain';
import { registerOrderEditRoutes } from '../server/order-edit-routes';
import { cardPayload } from '../server/order-sections';
import { resolveSubjectInTx, exportBundleInTx, anonymiseInTx } from '../server/rodo228';
import { ANON_TEXT } from '../server/rodo228-model';
import { seed, DEMO_TENANT } from './fixtures';
assert.equal(process.env.DYNA_TEST, 'true');
type Row = Record<string, any>;
let app: FastifyInstance, warehouse: string, products: Row[];
const roles: Record<string, Actor> = {};
const admin = 'admin', operator = 'operator', viewer = 'viewer';
const req = (p: string, method: any = 'GET', payload?: unknown, as = admin) =>
  app.inject({ url: '/api' + p, method, ...(payload === undefined ? {} : { payload: payload as any }), headers: { 'x-test-as': as } });
async function ok(p: string, method: any = 'GET', payload?: unknown, as = admin) {
  const r = await req(p, method, payload, as);
  assert(r.statusCode < 300, r.body);
  return r.json();
}
async function refused(r: Promise<any>, status: number, pattern?: RegExp) {
  const res = await r;
  assert.equal(res.statusCode, status, res.body);
  assert(!/SELECT |stack/.test(res.body), res.body);
  if (pattern) assert.match(res.json().detail, pattern);
  return res.json();
}
const native = <T>(fn: (c: any) => Promise<T>) => tenantTx(DEMO_TENANT, fn);
const card = (id: string, as = admin) => ok('/orders/' + id, 'GET', undefined, as);
const save = (o: Row, section: string, values: Row, as = admin) =>
  req(`/orders/${o.id}/sections/${section}`, 'PATCH', { expected_version: Number(o.version), values }, as);
const saved = async (o: Row, section: string, values: Row, as = admin) => {
  const r = await save(o, section, values, as);
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
};
const edits = (o: Row, section: string) => o.events.filter((e: Row) => e.kind === 'order.section_edited' && e.detail.section === section);
const product = (sku: string) => products.find((p) => p.sku === sku)!;
async function order(extra: Row = {}): Promise<Row> {
  const o = await native((c) =>
    createOrder(c, roles.admin, orderSchema.parse({
      customer_name: 'Monika Kozłowska',
      email: `sections-${randomUUID()}@example.test`,
      warehouse_id: warehouse,
      address: { street: 'Wojska Polskiego 11', city: 'Szczecin', postal_code: '70-470', phone: '600100200' },
      shipping_cost: 1699,
      items: [{ product_id: product('LAMP-001').id, quantity: 1 }],
      ...extra,
    })),
  );
  return card(o.id);
}

before(async () => {
  await migrate();
  await seed();
  for (const role of ['admin', 'operator', 'viewer'] as const) {
    const id = (await pool.query('SELECT id FROM users WHERE email=$1', [role + '@demo.local'])).rows[0].id;
    roles[role] = { tenantId: DEMO_TENANT, userId: id, role, source: 'manual' };
  }
  warehouse = (await pool.query("SELECT id FROM warehouses WHERE tenant_id=$1 AND code='WAW'", [DEMO_TENANT])).rows[0].id;
  products = (await pool.query('SELECT * FROM products WHERE tenant_id=$1', [DEMO_TENANT])).rows;
  app = Fastify();
  app.decorateRequest('actor');
  app.decorateRequest('apiScopes');
  app.addHook('onRequest', async (r) => {
    r.actor = roles[String(r.headers['x-test-as'])];
    r.apiScopes = undefined;
  });
  app.setErrorHandler((err: any, _r, reply) => {
    if (err instanceof Problem) return reply.code(err.status).send({ detail: err.message });
    if (err instanceof z.ZodError)
      return reply.code(422).send({ detail: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    process.stderr.write('UNEXPECTED ' + String(err?.code ?? '') + ' ' + String(err?.message ?? err) + '\n');
    return reply.code(500).send({ detail: 'Nieoczekiwany błąd serwera' });
  });
  // As app.ts: the card read applies the actor's locks.
  app.get('/api/orders/:id', async (r) =>
    tenantReadTx(r.actor.tenantId, (c) => cardPayload(c, r.actor, (r.params as Row).id, r.apiScopes)),
  );
  registerOrderEditRoutes(app);
  await app.ready();
});
after(async () => {
  await app.close();
  await pool.end();
});

test('the card carries section values and locks; viewer reads only, operator does not change the payment state', async () => {
  const o = await order();
  assert.deepEqual(o.section_values.customer, { name: 'Monika Kozłowska', company: '', email: o.email, phone: '600100200' });
  assert.deepEqual(o.section_values.delivery_address, {
    recipient: 'Monika Kozłowska', street: 'Wojska Polskiego 11', postal_code: '70-470', city: 'Szczecin', country: 'PL', pickup_point: '',
  });
  assert.deepEqual(o.section_values.delivery_method, { method: 'courier', carrier: '', cost: 1699 });
  assert.equal(o.section_values.payment.state, 'unpaid');
  assert.equal(o.section_values.invoice.wants_invoice, false);
  for (const s of ['customer', 'delivery_address', 'invoice', 'products', 'delivery_method', 'payment', 'extra'])
    assert.deepEqual(o.section_locks[s], { locked: false }, s);
  const v = await card(o.id, viewer);
  assert(Object.values(v.section_locks).every((l: any) => l.locked && /tylko do odczytu/.test(l.reason)));
  const op = await card(o.id, operator);
  assert.equal(op.payment_edit.state.locked, true);
  assert.match(op.payment_edit.state.reason, /administrator/);
  assert.deepEqual(op.payment_edit.method, { locked: false });
  assert.deepEqual(op.section_locks.payment, { locked: false });
});

test('customer saves independently, records values with the actor and bumps the version; unchanged writes nothing', async () => {
  const o = await order();
  const r = await saved(o, 'customer', { name: 'Monika Nowak', company: 'Nowak Sp. z o.o.', phone: '+48 600 100 300' }, operator);
  assert.equal(r.customer_name, 'Monika Nowak');
  assert.equal(r.address.company, 'Nowak Sp. z o.o.');
  assert.equal(r.address.phone, '+48 600 100 300');
  assert.equal(r.address.street, 'Wojska Polskiego 11', 'other sections stay');
  assert(BigInt(r.version) > BigInt(o.version));
  const [e] = edits(r, 'customer');
  assert.equal(e.detail.actor_id, roles.operator.userId);
  assert.equal(typeof e.detail.actor_name, 'string');
  assert.deepEqual(e.detail.changes, [
    { field: 'name', label: 'Imię i nazwisko', before: 'Monika Kozłowska', after: 'Monika Nowak' },
    { field: 'company', label: 'Firma', before: '', after: 'Nowak Sp. z o.o.' },
    { field: 'phone', label: 'Telefon', before: '600100200', after: '+48 600 100 300' },
  ]);
  const same = await saved(r, 'customer', { name: 'Monika Nowak' });
  assert.equal(same.version, r.version);
  assert.equal(edits(same, 'customer').length, 1);
  // Contact data stay editable on a cancelled order; the delivery address does not.
  const cancelled = await native((c) => transition(c, roles.admin, o.id, 'cancelled', undefined, undefined, undefined, undefined, String(same.version)));
  const c2 = await card(cancelled.id);
  await saved(c2, 'customer', { email: 'monika.nowak@example.test' });
  const locked = await refused(save(await card(o.id), 'delivery_address', { city: 'Police' }), 423);
  assert.deepEqual(locked.lock, { locked: true, reason: 'Zamówienie jest anulowane' });
});

test('validation at the boundary: e-mail, phone, postal code, NIP checksum, money, unknown fields and sections', async () => {
  const o = await order();
  await refused(save(o, 'customer', { email: 'brak-maila' }), 422, /e-mail/);
  await refused(save(o, 'customer', { email: '' }), 422, /e-mail/);
  await refused(save(o, 'customer', { name: 'X' }), 422, /2 znaki/);
  await refused(save(o, 'customer', { phone: 'abc' }), 422, /Telefon/);
  await refused(save(o, 'customer', { nick: 'x' }), 422);
  await refused(save(o, 'delivery_address', { postal_code: '70470' }), 422, /kod pocztowy dla kraju PL/);
  await refused(save(o, 'delivery_address', { country: 'POL' }), 422, /dwuliterowy/);
  await refused(save(o, 'invoice', { wants_invoice: true, buyer: 'Firma', nip: '1234567890', street: 'A 1', postal_code: '00-001', city: 'Warszawa' }), 422, /NIP/);
  await refused(save(o, 'invoice', { wants_invoice: true }), 422, /nabywcy/);
  await refused(save(o, 'delivery_method', { cost: -1 }), 422, /ujemna/);
  await refused(save(o, 'delivery_method', { cost: 10.5 }), 422, /groszach/);
  await refused(save(o, 'delivery_method', { method: 'drone' }), 422, /sposób dostawy/);
  await refused(save(o, 'payment', { state: 'paid', paid_at: '2999-01-01' }), 422, /przyszłości/);
  await refused(save(o, 'products', {}), 422, /Nieznana sekcja/);
  await refused(req(`/orders/${o.id}/sections/customer`, 'PATCH', { expected_version: Number(o.version) + 3, values: { name: 'Anna Nowak' } }), 409, /Odśwież/);
  await refused(req(`/orders/${o.id}/sections/customer`, 'PATCH', { values: { name: 'Anna Nowak' } }), 422);
  await refused(save(o, 'customer', { name: 'Anna Nowak' }, viewer), 403);
  await refused(save({ ...o, id: randomUUID() }, 'customer', { name: 'Anna Nowak' }), 404);
  assert.equal((await card(o.id)).version, o.version, 'nothing written');
});

test('delivery address, delivery method with cost, invoice data and notes are kept without a migration', async () => {
  const o = await order();
  const address = { recipient: 'Jan Kozłowski', street: 'Bałtycka 2', postal_code: '81-001', city: 'Gdynia', pickup_point: 'GDY01M' };
  // A pickup point on a courier delivery would make the label module refuse the order, so the method comes first.
  await refused(save(o, 'delivery_address', address), 422, /najpierw zmień sposób dostawy/);
  const m = await saved(o, 'delivery_method', { method: 'parcel_locker', carrier: 'InPost', cost: 1299 });
  assert.equal(m.shipping_cost, 1299);
  assert.equal(m.total, o.total - 400);
  assert.equal(m.payment.amount_due, m.total);
  assert.deepEqual(m.section_values.delivery_method, { method: 'parcel_locker', carrier: 'InPost', cost: 1299 });
  assert.deepEqual(edits(m, 'delivery_method')[0].detail.changes.map((x: Row) => [x.field, x.before, x.after]), [
    ['method', 'Kurier', 'Paczkomat / automat paczkowy'],
    ['carrier', '', 'InPost'],
    ['cost', '16,99 PLN', '12,99 PLN'],
  ]);
  const a = await saved(m, 'delivery_address', address);
  assert.deepEqual(
    { r: a.address.recipient, s: a.address.street, p: a.address.postal_code, c: a.address.city, l: a.address.locker_code },
    { r: 'Jan Kozłowski', s: 'Bałtycka 2', p: '81-001', c: 'Gdynia', l: 'GDY01M' },
  );
  const inv = { wants_invoice: true, buyer: 'Kozłowski Sp. z o.o.', nip: '526-000-12-46', street: 'Długa 1', postal_code: '00-950', city: 'Warszawa', country: 'PL' };
  const i = await saved(a, 'invoice', inv);
  assert.deepEqual(i.section_values.invoice, { ...inv, nip: '5260001246' });
  assert(BigInt(i.version) > BigInt(m.version), 'a history-only section still makes a new revision');
  const n = await saved(i, 'extra', { note: 'Zadzwonić przed dostawą' });
  assert.equal(n.note, 'Zadzwonić przed dostawą');
  // A later save of another section keeps the stored values of the others.
  const again = await saved(n, 'customer', { phone: '600999888' });
  assert.deepEqual(again.section_values.invoice, { ...inv, nip: '5260001246' });
  assert.equal(again.section_values.delivery_method.carrier, 'InPost');
  // The automation event was raised for every save.
  const kinds = (await pool.query("SELECT detail->>'section' s FROM order_events WHERE order_id=$1 AND kind='order.section_edited' ORDER BY created_at", [o.id])).rows.map((r) => r.s);
  assert.deepEqual(kinds, ['delivery_method', 'delivery_address', 'invoice', 'extra', 'customer']);
});

test('payment: the administrator marks paid, partial, unpaid and cash on delivery through the ledger', async () => {
  const o = await order();
  await refused(save(o, 'payment', { state: 'paid' }, operator), 423, /administrator/);
  const m = await saved(o, 'payment', { method: 'online' }, operator);
  assert.equal(m.section_values.payment.method, 'online');
  assert.equal(m.status, 'new');
  const partial = await saved(m, 'payment', { state: 'partial', amount: 1000, reference: 'Przelew 1/2', paid_at: '2026-11-08' });
  assert.equal(partial.status, 'new');
  assert.equal(partial.payment.net, 1000);
  assert.deepEqual(
    { s: partial.section_values.payment.state, a: partial.section_values.payment.amount, p: partial.section_values.payment.paid_at, r: partial.section_values.payment.reference },
    { s: 'partial', a: 1000, p: '2026-11-08', r: 'Przelew 1/2' },
  );
  await refused(save(partial, 'payment', { state: 'partial', amount: 500 }), 422, /większa od dotychczas/);
  const paid = await saved(partial, 'payment', { state: 'paid', reference: 'Przelew 2/2', paid_at: '2026-11-09' });
  assert.equal(paid.status, 'paid', 'new -> paid by the existing settle path');
  assert.equal(paid.payment.amount_due, 0);
  assert.equal(paid.section_values.payment.state, 'paid');
  const changed = paid.events.filter((e: Row) => e.kind === 'payment.changed');
  assert.deepEqual(changed.map((e: Row) => [e.detail.from, e.detail.to]), [['unpaid', 'partial'], ['partial', 'paid']]);
  const entries = (await pool.query("SELECT kind,amount,request->>'paid_at' d FROM payment_entries WHERE order_id=$1 ORDER BY created_at,id", [o.id])).rows;
  assert.deepEqual(entries, [{ kind: 'receipt', amount: 1000, d: '2026-11-08' }, { kind: 'receipt', amount: o.total - 1000, d: '2026-11-09' }]);
  await refused(save(paid, 'payment', { reference: 'Inny tytuł' }), 422, /historii płatności/);
  const unpaid = await saved(paid, 'payment', { state: 'unpaid' });
  assert.equal(unpaid.status, 'new', 'paid -> new when the money is reversed');
  assert.equal(unpaid.payment.net, 0);
  assert.equal((await pool.query("SELECT count(*)::int n FROM payment_entries WHERE order_id=$1 AND kind='reversal'", [o.id])).rows[0].n, 2);
  const cod = await saved(unpaid, 'payment', { state: 'cod' });
  assert.equal(cod.payment_mode, 'cod');
  assert.equal(cod.status, 'paid');
  assert.equal(cod.section_values.payment.state, 'cod');
});

test('locks follow labels and documents; the server refuses with 423 and the lock', async () => {
  const o = await order();
  const paid = await saved(o, 'payment', { state: 'paid' });
  await native((c) => c.query("INSERT INTO shipments(id,tenant_id,order_id,carrier,tracking_number,mode) VALUES($1,$2,$3,'InPost',$4,'demo')", [randomUUID(), DEMO_TENANT, o.id, 'T-' + randomUUID().slice(0, 8)]));
  const labelled = await card(o.id);
  assert.deepEqual(labelled.section_locks.delivery_address, { locked: true, reason: 'Najpierw anuluj etykietę u przewoźnika', action: 'cancel_label' });
  assert.deepEqual(labelled.section_locks.delivery_method, labelled.section_locks.delivery_address);
  assert.deepEqual(labelled.section_locks.customer, { locked: false });
  assert.equal(labelled.section_values.delivery_method.carrier, 'InPost');
  const r = await refused(save(labelled, 'delivery_address', { city: 'Police' }), 423);
  assert.equal(r.lock.action, 'cancel_label');
  await refused(save(labelled, 'payment', { state: 'cod' }), 423, /anuluj etykietę/);
  assert.match(labelled.section_locks.products.reason, /przesyłkę/);
  const named = await saved(labelled, 'customer', { email: 'po-etykiecie@example.test' });
  await native((c) => issueDocument(c, roles.admin, o.id, 'invoice'));
  const invoiced = await card(o.id);
  assert.deepEqual(invoiced.section_locks.invoice, { locked: true, reason: 'Zmiana tylko przez korektę', action: 'correction' });
  assert.deepEqual(invoiced.section_locks.products, invoiced.section_locks.invoice);
  assert.deepEqual(invoiced.payment_edit.method, invoiced.section_locks.invoice);
  assert.deepEqual(invoiced.payment_edit.state, { locked: false });
  await refused(save(invoiced, 'invoice', { wants_invoice: false, nip: '' , buyer: 'Ktoś Inny' }), 423, /korektę/);
  await refused(save(invoiced, 'payment', { method: 'cash' }), 423, /korektę/);
  assert.equal((await card(o.id)).version, invoiced.version);
  assert(named && paid);
});

test('legacy customer edit and RODO: history values are exported and anonymised', async () => {
  const o = await order();
  const first = o.email;
  const r = await ok('/orders/' + o.id + '/customer', 'PATCH', {
    expected_version: String(o.version), customer_name: o.customer_name, email: 'nowy-' + first, phone: '600100200',
    street: 'Wojska Polskiego 11', postal_code: '70-470', city: 'Szczecin',
  });
  const legacy = r.events.find((e: Row) => e.kind === 'order.customer_updated');
  assert.deepEqual(legacy.detail.fields, ['email']);
  assert.deepEqual(legacy.detail.changes, [{ field: 'email', label: 'E-mail', before: first, after: 'nowy-' + first }]);
  const inv = await saved(r, 'invoice', { wants_invoice: true, buyer: 'Monika Kozłowska', nip: '5260001246', street: 'Długa 1', postal_code: '00-950', city: 'Warszawa' });
  await native((c) => transition(c, roles.admin, o.id, 'cancelled', undefined, undefined, undefined, undefined, String(inv.version)));
  const key = 'sections-test-key';
  const bundle: Row = await native(async (c) => exportBundleInTx(c, roles.admin, await resolveSubjectInTx(c, roles.admin, { email: 'nowy-' + first }, key), key, new Date()));
  const exported = bundle.zamowienia.find((x: Row) => x.id === o.id);
  assert(exported.historia_zmian.some((h: Row) => h.pole === 'E-mail' && h.przed === first));
  assert.equal(exported.dane_do_faktury.nip, '5260001246');
  await native(async (c) => anonymiseInTx(c, await resolveSubjectInTx(c, roles.admin, { email: 'nowy-' + first }, key), '2026-11-09'));
  const rows = (await pool.query("SELECT kind,detail FROM order_events WHERE order_id=$1 AND kind IN ('order.customer_updated','order.section_edited')", [o.id])).rows;
  const text = JSON.stringify(rows);
  assert(!text.includes(first) && !text.includes('5260001246') && !text.includes('Długa 1'), text);
  const invoiceEvent = rows.find((x) => x.detail.section === 'invoice')!;
  assert.equal(invoiceEvent.detail.values.nip, ANON_TEXT);
  assert.equal(invoiceEvent.detail.values.wants_invoice, true, 'non-personal values stay');
});
