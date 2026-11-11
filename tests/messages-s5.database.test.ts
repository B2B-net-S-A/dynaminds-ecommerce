/** S5 on a real disposable clone (dynaminds_s5_<YYYYMMDD>_NN or dynaminds_s5fix_<YYYYMMDD>_NN): real routes, worker tick and SQL.
 * - COM-002/COM-007: new template tags (portal link, products, delivery, invoice) through the real
 *   preview → queue → worker path, the inactive-link and no-invoice refusals, link rotation
 *   invalidating an old preview, and the live editor preview (sample, own order, viewer, foreign tenant);
 * - COM-001: one timeline of email, SMS and portal per order or per buyer email, private kinds
 *   only for admin/operator, tenant isolation, channel filter and cursor;
 * - COM-PORTAL-5: the buyer downloads a prepared Fakturownia PDF through the portal token without
 *   any provider call; foreign, disabled, unprepared and changed documents are refused;
 *   a verified Odoo PDF is offered instead of the DEMO print of the same document;
 * - COM-PORTAL-1: carrier tracking link for a live parcel. */
import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { encrypt } from '../server/security';
import { tick } from '../server/worker';
import { seed } from './fixtures';
import { PORTAL_ORIGIN } from '../server/message-variables';
import { sourceHash } from '../server/catalog-source-normalize';
import { connectionHash } from '../server/offer-sync-policy';
import { exportSource } from '../server/odoo-exports';
import { createHash } from 'node:crypto';

assert.equal(process.env.DYNA_TEST, 'true', 'Explicit isolated test mode required');
const selected = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(selected.hostname, '127.0.0.1');
assert.match(selected.pathname, /^\/dynaminds_(s5(fix)?|sf4)_2026[0-9]{4}_[0-9]{2}$/);
// PG04 is shared by many lanes; catalog-wide preflight reads can pass 8 s under that load.
// Only this test's own connections get a longer statement timeout; the app default is unchanged.
pool.options.options = String(pool.options.options).replace('statement_timeout=8000', 'statement_timeout=60000');

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n', 'latin1');
let app: FastifyInstance, admin: string, operator: string, viewer: string, other: string, warehouse: string, product: string;
let calls: string[] = [], invoiceHeader: any;
const transport = async (url: string, init: RequestInit) => {
  assert.equal(init.method, 'GET');
  const u = new URL(url);
  assert.equal(u.hostname, 'invoice-qa.fakturownia.pl');
  calls.push(u.pathname);
  if (u.pathname.endsWith('.json')) return new Response(JSON.stringify(invoiceHeader));
  return new Response(new Uint8Array(PDF), { headers: { 'content-type': 'application/pdf' } });
};
const req = (url: string, method: any = 'GET', payload?: any, cookie = admin) =>
  app.inject({ url: '/api' + url, method, payload, headers: { cookie, 'idempotency-key': randomUUID() } });
async function ok(url: string, method: any = 'GET', payload?: any, cookie = admin) {
  const r = await req(url, method, payload, cookie);
  assert(r.statusCode < 300, url + ' ' + r.statusCode + ' ' + r.body);
  return r.json();
}
async function status(url: string, code: number, method: any = 'GET', payload?: any, cookie = admin) {
  const r = await req(url, method, payload, cookie);
  assert.equal(r.statusCode, code, url + ' ' + r.body);
  return r.json();
}
const pub = (token: string, path = '', method: any = 'GET', payload?: any) =>
  app.inject({ url: '/api/public/orders/' + token + path, method, payload, remoteAddress: '127.0.0.77' });
async function drain() {
  for (let i = 0; i < 200; i++) if (!(await tick())) return;
  throw new Error('Worker did not drain');
}
const buyer = 'buyer-' + randomUUID().slice(0, 8) + '@example.test';
async function order(email = buyer) {
  return ok('/orders', 'POST', {
    customer_name: 'Anna Kupująca',
    email,
    warehouse_id: warehouse,
    address: { street: 'ul. Testowa 1', city: 'Warszawa', postal_code: '00-950', country: 'PL', phone: '500100200' },
    items: [{ product_id: product, quantity: 2 }],
  });
}
async function invoice(o: any) {
  await ok(
    '/orders/' + o.id + '/status',
    'PATCH',
    await legacySerialOrderStatusPayload((p) => ok(p), '/orders/' + o.id + '/status', { status: 'paid' }),
  );
  return ok('/orders/' + o.id + '/documents', 'POST', { kind: 'invoice' });
}
async function shipment(o: any, carrier: string, tracking: string, mode: string) {
  await pool.query(
    "INSERT INTO shipments(id,tenant_id,order_id,carrier,tracking_number,mode,status) VALUES($1,(SELECT tenant_id FROM orders WHERE id=$2),$2,$3,$4,$5,'created')",
    [randomUUID(), o.id, carrier, tracking, mode],
  );
}
const emailTemplate = (body: string, html = '') =>
  ok('/email/templates', 'POST', { name: 'S5 ' + randomUUID().slice(0, 6), subject: 'Zamówienie {{order_number}}', body, html, client_key: randomUUID() });
const emailPreview = (t: any, o: any) =>
  ok('/email/preview', 'POST', { template_id: t.id, template_version: t.version, order_ids: [o.id], mode: 'local', client_key: randomUUID() });

let A: any, B: any;
before(async () => {
  await migrate();
  await seed();
  // The clone carries hundreds of pending jobs of real channels; park them so tick() only
  // runs this test's jobs (the run also uses the loopback-only network guard).
  await pool.query("UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL WHERE state IN ('pending','running')");
  app = await buildApp({ integrationTransport: transport, logging: process.env.S5_TEST_LOG === '1' });
  const login = async (email: string) =>
    (await app.inject({ url: '/api/auth/login', method: 'POST', payload: { email, password: 'DynaDemo!2026' } })).headers['set-cookie']!
      .toString()
      .split(';')[0];
  admin = await login('admin@demo.local');
  operator = await login('operator@demo.local');
  viewer = await login('viewer@demo.local');
  other = await login('other@demo.local');
  warehouse = (await ok('/warehouses')).data[0].id;
  product = (await ok('/products', 'POST', { sku: 'S5-' + randomUUID(), name: 'Kubek S5', price: 4900, quantity: 100, warehouse_id: warehouse })).id;
  A = await order();
  B = await order();
});
after(async () => {
  await app.close();
  await pool.end();
});

test('COM-002/007: new tags render through preview → queue → worker; link and invoice are required', async () => {
  const t = await emailTemplate(
    'Link: {{portal_link}}\nProdukty: {{products}}\nAdres: {{delivery_address}}\nDostawa: {{delivery_method}} {{tracking_number}}\nFaktura: {{invoice_number}}',
    '<p><a href="{{portal_link}}">Twoje zamówienie</a> <a href="http://evil.example/">x</a></p>',
  );
  const noInvoice = await emailPreview(t, A);
  assert.equal(noInvoice.items[0].state, 'invalid');
  assert.equal(noInvoice.items[0].error, 'Zamówienie nie ma jeszcze faktury');
  const doc = await invoice(A);
  await shipment(A, 'InPost ShipX', 'QA520000011395', 'sandbox');
  const fresh = await ok('/orders/' + A.id);
  const b = await emailPreview(t, A);
  const m = b.items[0];
  assert.equal(m.state, 'draft', m.error);
  const link = PORTAL_ORIGIN + '/api/public/orders/' + fresh.portal_token;
  assert.equal(
    m.payload.text,
    `Link: ${link}\nProdukty: 2 × Kubek S5\nAdres: ul. Testowa 1, 00-950 Warszawa, PL\nDostawa: InPost ShipX QA520000011395\nFaktura: ${doc.number}`,
  );
  assert(m.payload.html.includes(`<a href="${link}">Twoje zamówienie</a>`), m.payload.html);
  assert(!m.payload.html.includes('evil.example'), m.payload.html);
  await ok('/email/batches/' + b.id + '/queue', 'POST', { confirmed: true });
  await drain();
  const sent = (await ok('/email/batches/' + b.id)).items[0];
  assert.equal(sent.state, 'simulated', sent.error);
  // The portal page opened from that link is the order page.
  assert.equal((await pub(fresh.portal_token)).statusCode, 200);

  // A preview made before rotation cannot be queued: the old link is no longer valid.
  const stale = await emailPreview(t, A);
  const rotated = await ok('/orders/' + A.id + '/portal', 'POST', { action: 'rotate', days: 30 });
  assert.notEqual(rotated.portal_token, fresh.portal_token);
  await status('/email/batches/' + stale.id + '/queue', 409, 'POST', { confirmed: true });
  const after = (await emailPreview(t, A)).items[0];
  assert(after.payload.text.includes(rotated.portal_token));
  await ok('/orders/' + A.id + '/portal', 'POST', { action: 'disable' });
  const disabled = (await emailPreview(t, A)).items[0];
  assert.equal(disabled.state, 'invalid');
  assert.match(disabled.error, /Link do strony zamówienia jest wyłączony lub wygasł/);
  A.portal_token = (await ok('/orders/' + A.id + '/portal', 'POST', { action: 'rotate', days: 30 })).portal_token;
});

test('COM-002: SMS tags through the real local flow, and the live editor previews save nothing', async () => {
  const t = await ok('/sms/templates', 'POST', {
    name: 'S5 SMS ' + randomUUID().slice(0, 6),
    body: '{{order_number}}: {{portal_link}} {{tracking_number}}',
    max_parts: 3,
    client_key: randomUUID(),
  });
  const b = await ok('/sms/preview', 'POST', { template_id: t.id, template_version: t.version, order_ids: [A.id], mode: 'local', client_key: randomUUID() });
  const m = b.items[0];
  assert.equal(m.state, 'draft', m.error);
  assert.equal(m.payload, `${A.number}: ${PORTAL_ORIGIN}/api/public/orders/${A.portal_token} QA520000011395`);
  assert.equal(m.recipient, '48500100200');
  await ok('/sms/batches/' + b.id + '/queue', 'POST', { confirmed: true });
  await drain();
  assert.equal((await ok('/sms/batches/' + b.id)).items[0].state, 'simulated');

  const counts = async () =>
    (await pool.query('SELECT (SELECT count(*) FROM email_batches)::int e,(SELECT count(*) FROM sms_batches)::int s,(SELECT count(*) FROM jobs)::int j')).rows[0];
  const before = await counts();
  const sample = await ok('/email/templates/preview', 'POST', { subject: 'Zamówienie {{order_number}}', body: 'Link {{portal_link}}' });
  assert.equal(sample.sample, true);
  assert.equal(sample.subject, 'Zamówienie ZAM/2026/0001');
  const real = await ok('/email/templates/preview', 'POST', { subject: '{{order_number}}', body: '{{products}} · {{delivery_address}}', order_id: A.id }, operator);
  assert.equal(real.sample, false);
  assert.equal(real.recipient, buyer);
  assert.equal(real.text, '2 × Kubek S5 · ul. Testowa 1, 00-950 Warszawa, PL');
  const sms = await ok('/sms/templates/preview', 'POST', { body: '{{order_number}} {{portal_link}}', max_parts: 2, order_id: A.id });
  assert.equal(sms.payload, A.number + ' ' + PORTAL_ORIGIN + '/api/public/orders/' + A.portal_token);
  assert.equal(sms.recipient, '48500100200');
  await status('/email/templates/preview', 422, 'POST', { subject: 'x', body: '{{payment_link}}' });
  await status('/sms/templates/preview', 403, 'POST', { body: '{{order_number}}' }, viewer);
  await status('/email/templates/preview', 403, 'POST', { subject: 'x', body: 'y', order_id: A.id }, viewer);
  // Another company cannot render this order: RLS hides it.
  await status('/email/templates/preview', 404, 'POST', { subject: 'x', body: '{{order_number}}', order_id: A.id }, other);
  await status('/sms/templates/preview', 404, 'POST', { body: '{{order_number}}', order_id: A.id }, other);
  assert.deepEqual(await counts(), before);
});

test('COM-001: order timeline merges email, SMS and portal; private kinds by role; buyer scope', async () => {
  const pubWrite = await pub(A.portal_token, '/messages', 'POST', { client_key: randomUUID(), body: 'Kiedy wysyłka?' });
  assert.equal(pubWrite.statusCode, 201, pubWrite.body);
  const thread = (await ok('/customer-messages?order_id=' + A.id)).data[0];
  await ok('/customer-messages/' + thread.id + '/reply', 'POST', { client_key: randomUUID(), body: 'Jutro rano.' });
  await ok('/customer-messages/' + thread.id + '/note', 'POST', { client_key: randomUUID(), body: 'NOTATKA WEWNĘTRZNA' });
  const t = await emailTemplate('Dzień dobry {{customer_name}}');
  const bb = await emailPreview(t, B);
  await ok('/email/batches/' + bb.id + '/queue', 'POST', { confirmed: true });
  await drain();

  const mine = await ok('/orders/' + A.id + '/communication');
  const kinds = mine.data.map((e: any) => e.channel + ':' + e.direction + ':' + e.state);
  assert(kinds.includes('email:out:simulated'), kinds.join());
  assert(kinds.includes('sms:out:simulated'), kinds.join());
  assert(kinds.includes('portal:in:buyer') && kinds.includes('portal:out:reply') && kinds.includes('portal:internal:note'), kinds.join());
  assert(mine.data.every((e: any) => e.order_id === A.id));
  assert.equal(mine.private_visible, true);
  for (let i = 1; i < mine.data.length; i++) assert(new Date(mine.data[i - 1].at) >= new Date(mine.data[i].at));
  assert(!JSON.stringify(mine).includes('Dzień dobry Anna'), 'order scope excludes the other order');

  const seen = await ok('/orders/' + A.id + '/communication', 'GET', undefined, viewer);
  assert.equal(seen.private_visible, false);
  assert(!JSON.stringify(seen).includes('NOTATKA WEWNĘTRZNA'));
  assert(seen.data.some((e: any) => e.state === 'reply'));

  const customer = await ok('/orders/' + A.id + '/communication?scope=customer', 'GET', undefined, operator);
  assert.deepEqual(new Set(customer.customer.orders.map((o: any) => o.id)), new Set([A.id, B.id]));
  assert(customer.data.some((e: any) => e.order_id === B.id && e.channel === 'email' && e.order_number === B.number));
  const sms = await ok('/orders/' + A.id + '/communication?channel=sms');
  assert(sms.data.length >= 1 && sms.data.every((e: any) => e.channel === 'sms'));

  await status('/orders/' + A.id + '/communication', 404, 'GET', undefined, other);
  await status('/orders/' + A.id + '/communication?cursor=bad', 422);
  await status('/orders/' + A.id + '/communication?scope=all', 422);
});

test('COM-PORTAL-5: prepared Fakturownia PDF downloads from the portal without a provider call', async () => {
  const C = await order('pdf-' + randomUUID().slice(0, 8) + '@example.test');
  const d = await invoice(C);
  const ch = randomUUID();
  await pool.query(
    "INSERT INTO channels(id,tenant_id,provider,name,mode,settings,credentials) VALUES($1,(SELECT tenant_id FROM orders WHERE id=$2),'fakturownia','QA invoice','live',$3,$4)",
    [ch, C.id, JSON.stringify({ account_url: 'https://invoice-qa.fakturownia.pl' }), encrypt({ api_token: 'qa-token' })],
  );
  await pool.query("UPDATE documents SET mode='external',channel_id=$2,external_id='778899' WHERE id=$1", [d.id, ch]);
  const payload = {
    positions: d.data.items.map((i: any) => ({ name: i.name, quantity: i.quantity, tax: i.vat, total_price_gross: (i.gross / 100).toFixed(2) })),
    seller_tax_no: '',
    buyer_tax_no: '',
  };
  invoiceHeader = { ...payload, id: 778899, number: d.number, price_gross: (d.data.total / 100).toFixed(2) };
  await pool.query(
    "INSERT INTO invoice_plans(id,tenant_id,order_id,channel_id,actor_id,kind,input,payload,order_snapshot,mode,state,phase,remote_id,document_id) VALUES($1,(SELECT tenant_id FROM orders WHERE id=$2),$2,$3,(SELECT id FROM users WHERE email='admin@demo.local'),'invoice','{}',$4,$5,'external','done','created','778899',$6)",
    [randomUUID(), C.id, ch, JSON.stringify(payload), JSON.stringify({ total: d.data.total }), d.id],
  );
  const doc = async () => (await pub(C.portal_token, '/data')).json().documents.find((x: any) => x.id === d.id);
  assert.equal((await doc()).download, null);
  assert.equal((await pub(C.portal_token, '/documents/' + d.id + '/file')).statusCode, 409);

  await ok('/documents/' + d.id + '/email-file', 'POST', { confirmed: true }, operator);
  const providerCalls = calls.length;
  assert(providerCalls > 0);
  assert.equal((await doc()).download, 'pdf');
  const r = await pub(C.portal_token, '/documents/' + d.id + '/file');
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.headers['content-type'], 'application/pdf');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.match(String(r.headers['content-disposition']), /^attachment; filename="faktura-[A-Za-z0-9._-]+\.pdf"$/);
  assert(r.rawPayload.equals(PDF));
  assert.equal(calls.length, providerCalls, 'portal download never calls the provider');
  const audit = (await pool.query("SELECT user_id,detail FROM audit_events WHERE action='portal.document.download' AND entity_id=$1", [d.id])).rows;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].user_id, null);
  assert.equal(audit[0].detail.source, 'fakturownia');

  // Another order's token, an unknown token and a disabled link cannot reach the file.
  assert.equal((await pub(B.portal_token, '/documents/' + d.id + '/file')).statusCode, 404);
  assert.equal((await pub('0'.repeat(48), '/documents/' + d.id + '/file')).statusCode, 404);
  // A changed document no longer matches the prepared file.
  // /data offers the button only when the file endpoint would serve it (same checks).
  await pool.query("UPDATE documents SET external_id='778900' WHERE id=$1", [d.id]);
  assert.equal((await pub(C.portal_token, '/documents/' + d.id + '/file')).statusCode, 409);
  assert.equal((await doc()).download, null, 'no PDF button for a file the endpoint refuses');
  await pool.query("UPDATE documents SET external_id='778899' WHERE id=$1", [d.id]);
  assert.equal((await doc()).download, 'pdf');
  assert.equal((await pub(C.portal_token, '/documents/' + d.id + '/file')).statusCode, 200);
  await ok('/orders/' + C.id + '/portal', 'POST', { action: 'disable' });
  assert.equal((await pub(C.portal_token, '/documents/' + d.id + '/file')).statusCode, 404);
  assert.equal(calls.length, providerCalls);
});

test('COM-PORTAL-5: a verified Odoo PDF replaces the DEMO print of the same document', async () => {
  const D = await order('odoo-' + randomUUID().slice(0, 8) + '@example.test');
  const d = await invoice(D);
  const tenant = (await pool.query('SELECT tenant_id FROM orders WHERE id=$1', [D.id])).rows[0].tenant_id;
  const ch = randomUUID(), id = randomUUID();
  const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw' }).format(new Date(d.created_at));
  const input = { shipping_vat: 23, taxes: [{ vat: 23, tax_id: 24 }], partner_id: 1, journal_id: 1, account_id: 1, invoice_date: day, due_date: day };
  await pool.query(
    "INSERT INTO channels(id,tenant_id,provider,name,mode,settings,credentials) VALUES($1,$2,'odoo','QA Odoo','sandbox',$3,$4)",
    [ch, tenant, JSON.stringify({ simulation: 'true' }), encrypt({ api_key: 'qa-odoo' })],
  );
  const channel = (await pool.query('SELECT * FROM channels WHERE id=$1', [ch])).rows[0];
  await pool.query(
    "INSERT INTO odoo_invoice_exports(id,tenant_id,document_id,order_id,channel_id,actor_id,client_key,input_hash,source_hash,connection_hash,credentials_hash,reference,input,snapshot,payload,mode,state,phase,remote_id,result) VALUES($1,$2,$3,$4,$5,(SELECT id FROM users WHERE email='admin@demo.local'),$6,$7,$8,$9,$10,'QA',$11,'{}','{}','simulation','done','verified','91','{\"id\":91}')",
    [id, tenant, d.id, D.id, ch, randomUUID(), 'a'.repeat(64), sourceHash(exportSource(d, input as any)), connectionHash(channel), sourceHash(channel.credentials), JSON.stringify(input)],
  );
  await pool.query(
    "INSERT INTO odoo_invoice_files(tenant_id,export_id,actor_id,filename,size,sha256,content_encrypted,remote_attachment_id,mode) VALUES($1,$2,(SELECT id FROM users WHERE email='admin@demo.local'),'DEMO-odoo-91.pdf',$3,$4,$5,'DEMO-91','simulation')",
    [tenant, id, PDF.length, createHash('sha256').update(PDF).digest('hex'), encrypt({ pdf_base64: PDF.toString('base64') })],
  );
  const listed = (await pub(D.portal_token, '/data')).json().documents.find((x: any) => x.id === d.id);
  assert.equal(listed.download, 'pdf');
  const r = await pub(D.portal_token, '/documents/' + d.id + '/file');
  assert.equal(r.statusCode, 200, r.body);
  assert(r.rawPayload.equals(PDF));
  // The account changed after export: the stored PDF no longer matches and is not served.
  await pool.query("UPDATE channels SET credentials=$2 WHERE id=$1", [ch, encrypt({ api_key: 'rotated' })]);
  assert.equal((await pub(D.portal_token, '/documents/' + d.id + '/file')).statusCode, 409);
  // /data no longer offers „Pobierz PDF”: the buyer sees „pobranie u sprzedawcy” instead of a failed download.
  const after = (await pub(D.portal_token, '/data')).json().documents.find((x: any) => x.id === d.id);
  assert.equal(after.download, 'print', 'falls back to the DEMO print of the same document');
});

test('COM-PORTAL-1: a live parcel gets the carrier tracking link, sandbox does not', async () => {
  await shipment(B, 'DPD Polska', '0000123456789U', 'live');
  const s = (await pub(B.portal_token, '/data')).json().shipments[0];
  assert.equal(s.tracking_url, 'https://tracktrace.dpd.com.pl/parcelDetails?typ=1&p1=0000123456789U');
  const a = (await pub(A.portal_token, '/data')).json().shipments[0];
  assert.equal(a.mode, 'sandbox');
  assert.equal(a.tracking_url, null);
});
