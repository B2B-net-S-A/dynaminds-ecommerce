/** Uwagi v3 §6 follow-up: documents issued from an order use the invoice data edited on the card, labels use
 * the edited delivery recipient; both fall back to the order when nothing was edited. Real routes and DB. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, migrate, tenantTx, tenantReadTx } from '../server/db';
import { Problem } from '../server/errors';
import { createOrder, orderSchema, issueDocument, type Actor } from '../server/domain';
import { registerOrderEditRoutes } from '../server/order-edit-routes';
import { cardPayload } from '../server/order-sections';
import { orderInvoiceParty } from '../server/order-invoice-party';
import { invoicePartyOf, invoicePartyPolishNip, orderPickupPoint, orderRecipientName } from '../shared/order-invoice-party';
import { effectiveDelivery166 } from '../server/buyer-delivery-address';
import { demoShipmentLabelInTx } from '../server/app';
import { seed, DEMO_TENANT } from './fixtures';
assert.equal(process.env.DYNA_TEST, 'true');
type Row = Record<string, any>;
let app: FastifyInstance, warehouse: string, product: Row, admin: Actor;
const native = <T>(fn: (c: any) => Promise<T>) => tenantTx(DEMO_TENANT, fn);
async function ok(p: string, method: any = 'GET', payload?: unknown) {
  const r = await app.inject({ url: '/api' + p, method, ...(payload === undefined ? {} : { payload: payload as any }) });
  assert(r.statusCode < 300, r.body);
  return r.json();
}
const save = (o: Row, section: string, values: Row) =>
  ok(`/orders/${o.id}/sections/${section}`, 'PATCH', { expected_version: Number(o.version), values });
const ADDRESS = { street: 'Wojska Polskiego 11', city: 'Szczecin', postal_code: '70-470', phone: '600100200' };
async function order(): Promise<Row> {
  const o = await native((c) =>
    createOrder(c, admin, orderSchema.parse({
      customer_name: 'Monika Kozłowska',
      email: `party-${randomUUID()}@example.test`,
      warehouse_id: warehouse,
      address: ADDRESS,
      shipping_cost: 1699,
      items: [{ product_id: product.id, quantity: 1 }],
    })),
  );
  return ok('/orders/' + o.id);
}

before(async () => {
  await migrate();
  await seed();
  const id = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
  admin = { tenantId: DEMO_TENANT, userId: id, role: 'admin', source: 'manual' };
  warehouse = (await pool.query("SELECT id FROM warehouses WHERE tenant_id=$1 AND code='WAW'", [DEMO_TENANT])).rows[0].id;
  product = (await pool.query("SELECT * FROM products WHERE tenant_id=$1 AND sku='LAMP-001'", [DEMO_TENANT])).rows[0];
  app = Fastify();
  app.decorateRequest('actor');
  app.decorateRequest('apiScopes');
  app.addHook('onRequest', async (r) => { r.actor = admin; r.apiScopes = undefined; });
  app.setErrorHandler((err: any, _r, reply) => {
    if (err instanceof Problem) return reply.code(err.status).send({ detail: err.message });
    if (err instanceof z.ZodError) return reply.code(422).send({ detail: err.issues.map((i) => i.message).join('; ') });
    return reply.code(500).send({ detail: String(err?.message ?? err) });
  });
  app.get('/api/orders/:id', async (r) => tenantReadTx(r.actor.tenantId, (c) => cardPayload(c, r.actor, (r.params as Row).id, r.apiScopes)));
  registerOrderEditRoutes(app);
  await app.ready();
});
after(async () => {
  await app.close();
  await pool.end();
});

test('rule: nothing edited -> the order customer; edited buyer, NIP and address win; only a NIP keeps the order address', () => {
  const o = { customer_name: 'Jan Kowalski', email: 'jan@example.test', address: { ...ADDRESS, country: 'pl', company: 'Kowalski SA' } };
  const own = { street: ADDRESS.street, postal_code: ADDRESS.postal_code, city: ADDRESS.city, country: 'PL' };
  assert.deepEqual(invoicePartyOf(o), { source: 'order', name: 'Jan Kowalski', tax_id: '', email: 'jan@example.test', address: own });
  // The card's section_values.invoice of an order without an edit: empty buyer and NIP.
  assert.equal(invoicePartyOf(o, { buyer: '', nip: '', street: '', postal_code: '', city: '', country: 'PL' }).source, 'order');
  assert.deepEqual(invoicePartyOf(o, { buyer: 'Firma B', nip: '5260250274', street: 'Prosta 1', postal_code: '00-850', city: 'Warszawa', country: 'PL' }), {
    source: 'invoice_section', name: 'Firma B', tax_id: '5260250274', email: 'jan@example.test',
    address: { street: 'Prosta 1', postal_code: '00-850', city: 'Warszawa', country: 'PL' },
  });
  const nipOnly = invoicePartyOf(o, { buyer: '', nip: 'PL5260250274', street: '' });
  assert.deepEqual([nipOnly.name, nipOnly.address, invoicePartyPolishNip(nipOnly)], ['Kowalski SA', own, '5260250274']);
  assert.equal(invoicePartyPolishNip(invoicePartyOf(o, { buyer: 'GmbH', nip: 'DE123456789', street: 'Ring 5', city: 'Hamburg', postal_code: '20095', country: 'DE' })), '');
  assert.equal(orderRecipientName(o), 'Jan Kowalski');
  assert.equal(orderRecipientName({ ...o, address: { ...o.address, recipient: 'Anna Odbiorca' } }), 'Anna Odbiorca');
  assert.equal(orderRecipientName({ customer_name: 'X', address: { recipient: '  ' } }), 'X');
  assert.equal(orderPickupPoint({ address: { locker_code: 'WAW01M' } }), 'WAW01M');
  assert.equal(orderPickupPoint({ address: null }), '');
});

test('effective delivery (labels and carrier forms) uses address.recipient of the original order', () => {
  const original = (address: Row) => ({ customer_name: 'Monika Kozłowska', address: { ...ADDRESS, country: 'PL', ...address } }) as any;
  const plain = effectiveDelivery166({ original: original({}), sidecarOverride: null, deliveryKind: 'address' });
  assert.equal(plain.delivery?.recipient_name, 'Monika Kozłowska');
  const edited = effectiveDelivery166({ original: original({ recipient: 'Paweł Odbiorca' }), sidecarOverride: null, deliveryKind: 'address' });
  assert.equal(edited.delivery?.recipient_name, 'Paweł Odbiorca');
  assert.equal(edited.origin, 'original');
});

test('DEMO invoice: no edit -> order customer and address, no tax id', async () => {
  const o = await order();
  const party = await native((c) => orderInvoiceParty(c, DEMO_TENANT, o.id));
  assert.equal(party.source, 'order');
  assert.equal(party.name, 'Monika Kozłowska');
  const paid = await save(o, 'payment', { state: 'paid' });
  assert.equal(paid.status, 'paid');
  const d = await native((c) => issueDocument(c, admin, o.id, 'invoice'));
  assert.equal(d.data.customer, 'Monika Kozłowska');
  assert.deepEqual(d.data.address, o.address);
  assert.equal('tax_id' in d.data, false);
});

test('DEMO invoice: the edited invoice data (buyer, NIP, address) is the buyer; the latest edit wins', async () => {
  const o = await order();
  const first = await save(o, 'invoice', {
    wants_invoice: true, buyer: 'Stara Firma sp. z o.o.', nip: '5260250274', street: 'Stara 1', postal_code: '00-001', city: 'Warszawa', country: 'PL',
  });
  const second = await save(first, 'invoice', { buyer: 'Nowa Firma sp. z o.o.', street: 'Prosta 20', postal_code: '00-850' });
  const party = await native((c) => orderInvoiceParty(c, DEMO_TENANT, o.id));
  assert.deepEqual(party, {
    source: 'invoice_section', name: 'Nowa Firma sp. z o.o.', tax_id: '5260250274', email: o.email,
    address: { street: 'Prosta 20', postal_code: '00-850', city: 'Warszawa', country: 'PL' },
  });
  // The card payload gives the web forms the same party.
  assert.deepEqual(invoicePartyOf(second, second.section_values.invoice), party);
  await save(second, 'payment', { state: 'paid' });
  const d = await native((c) => issueDocument(c, admin, o.id, 'invoice'));
  assert.equal(d.data.customer, 'Nowa Firma sp. z o.o.');
  assert.equal(d.data.tax_id, '5260250274');
  assert.deepEqual(d.data.address, party.address);
  assert.equal(d.data.email, o.email);
  await assert.rejects(native((c) => orderInvoiceParty(c, DEMO_TENANT, randomUUID())), /Nie znaleziono zamówienia/);
});

test('DEMO label: the edited delivery recipient, otherwise the customer name', async () => {
  const o = await order();
  const ship = async (x: Row) => {
    const id = randomUUID(), tracking = 'T-' + randomUUID().slice(0, 8);
    await native((c) => c.query("INSERT INTO shipments(id,tenant_id,order_id,carrier,tracking_number,mode) VALUES($1,$2,$3,'InPost',$4,'demo')", [id, DEMO_TENANT, x.id, tracking]));
    return native((c) => demoShipmentLabelInTx(c, DEMO_TENANT, id));
  };
  const plain = await ship(o);
  assert.match(plain, /<p>Monika Kozłowska<\/p>/);
  const other = await order();
  const edited = await save(other, 'delivery_address', { recipient: 'Paweł Odbiorca' });
  assert.equal(edited.address.recipient, 'Paweł Odbiorca');
  const html = await ship(edited);
  assert.match(html, /<p>Paweł Odbiorca<\/p>/);
  assert.doesNotMatch(html, /Monika Kozłowska/);
});
