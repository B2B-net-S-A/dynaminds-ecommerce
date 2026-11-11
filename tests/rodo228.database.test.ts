/** Native 228 RODO on a real disposable clone: the actual session routes (Fastify injection
 * with the actor the auth hook would set), the CRM card and the Base CRM connector.php read
 * with the register hooks installed, the export ZIP of a real customer, the refusals, the
 * anonymisation preview and confirmation of a real invoiced customer of the demo tenant who
 * also has orders under the same e-mail in another tenant, the kept fields and their due
 * date, the register retention, and the nine guards plus local_invoice_guards before and
 * after. Root-only on a fresh clone dynaminds_rodo228_20261023_NN migrated by real
 * migrate() 218–228. The suite writes; rerun = NEW clone. */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tenantTx } from '../server/db';
import { Problem } from '../server/errors';
import { tokenHash } from '../server/security';
import { authenticateBaseWireApiKey } from '../server/developer-api';
import { registerCrmRoutes } from '../server/crm-routes';
import { registerBaseWireCrmRoutes } from '../server/base-wire-crm-routes';
import { observeBaseWireReads } from '../server/base-wire-routes';
import { createDefaultBaseWireCrmService } from '../server/base-wire-crm-runtime';
import { registerRodo228Routes } from '../server/rodo228-routes';
import { rodo228Available } from '../server/rodo228';
import { rodo228CrmAccess, rodo228WireObserver } from '../server/rodo228-hooks';
import { subjectHash } from '../server/rodo228-model';

assert.equal(process.env.DYNA_TEST, 'true', 'Explicit isolated test mode required');
const selected = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(selected.hostname, '127.0.0.1');
assert.equal(selected.port, '57084');
assert.match(selected.pathname, /^\/dynaminds_(rodo228_20261023|s2_20261026)_[0-9]{2}$/);
assert.equal(selected.username, 'postgres');
pool.options.query_timeout = 20000;

const KEY = 'rodo228-test-key-' + randomBytes(8).toString('hex');
const A = '11111111-1111-4111-8111-111111111111';
const SUBJECT = 'local-woo@example.test', EXPORTED = 'klient5@example.test', OPEN = 'klient1@example.test';
const GUARDS = ['ordinary187_valid', 'buyer_address_guards', 'order_merge_delivery209_valid', 'return_credit206_guards', 'ordinary188_structure_valid',
  'return_credit211_metadata_valid', 'large_import173_valid', 'fa3_draft_guards', 'pim_dictionary_valid', 'local_invoice_guards'];
let session: FastifyInstance, later: FastifyInstance, admin: string, operator: string | undefined, client: string, wireToken: string, wireKey: string, subjectOrder: string, otherTenant: string;

async function guards() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN READ ONLY'); await c.query('SET LOCAL search_path TO "$user",public'); await c.query("SET LOCAL statement_timeout='8s'");
    await c.query('SET LOCAL jit=off'); await c.query("SET LOCAL timezone='UTC'");
    const out: Record<string, boolean> = {};
    for (const g of GUARDS) out[g] = (await c.query('SELECT public.' + g + '() v')).rows[0].v;
    return out;
  } finally { await c.query('ROLLBACK'); c.release(); }
}
const allTrue = Object.fromEntries(GUARDS.map(g => [g, true]));
const make = async (now: () => Date) => {
  const app = Fastify();
  app.decorateRequest('actor'); app.decorateRequest('apiScopes');
  app.addHook('preHandler', async (req: any) => {
    if (!req.url.startsWith('/api/')) return;
    const as = JSON.parse(String(req.headers['x-test-as'] ?? '{}'));
    req.actor = { tenantId: as.tenant ?? A, userId: as.user ?? admin, role: as.role ?? 'admin' };
  });
  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof Problem) return reply.code(err.status).send({ error: err.message });
    if (err instanceof z.ZodError) return reply.code(422).send({ error: err.issues.map(i => i.message).join('; ') });
    process.stderr.write('rodo228 test 500: ' + (err?.code ?? '') + ' ' + String(err?.message ?? err).slice(0, 400) + '\n');
    return reply.code(500).send({ error: 'Błąd serwera' });
  });
  registerCrmRoutes(app, { available: true, readOnly: false, access: rodo228CrmAccess(pool, KEY) });
  registerBaseWireCrmRoutes(app, { available: true, readOnly: false, service: createDefaultBaseWireCrmService(), authenticate: (t, s) => authenticateBaseWireApiKey(t, s, true) });
  registerRodo228Routes(app, { available: true, readOnly: false, pool, key: KEY, now });
  await app.ready();
  return app;
};
const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, as: Record<string, unknown> = {}, app = session) =>
  app.inject({ method, url, headers: { 'x-test-as': JSON.stringify(as) }, ...(payload === undefined ? {} : { payload: payload as any }) });
const ok = (r: any) => { assert.equal(r.statusCode, 200, r.body); return r.json(); };
const refused = (r: any, status: number, re: RegExp) => { assert.equal(r.statusCode, status, r.body); assert.match(r.json().error, re); assert(!/SELECT |stack|ERROR:/.test(r.body), r.body); };
const wire = (method: string, parameters: unknown) => session.inject({ method: 'POST', url: '/connector.php', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-bltoken': wireToken },
  payload: new URLSearchParams({ method, parameters: JSON.stringify(parameters) }).toString() });
/** Files of a stored ZIP by name. */
function unzip(b: Buffer) {
  const end = b.length - 22, out: Record<string, Buffer> = {};
  assert.equal(b.readUInt32LE(end), 0x06054b50);
  let p = b.readUInt32LE(end + 16);
  for (let i = 0; i < b.readUInt16LE(end + 10); i++) {
    const n = b.readUInt16LE(p + 28), size = b.readUInt32LE(p + 24), off = b.readUInt32LE(p + 42), name = b.subarray(p + 46, p + 46 + n).toString();
    out[name] = b.subarray(off + 30 + b.readUInt16LE(off + 26), off + 30 + b.readUInt16LE(off + 26) + size); p += 46 + n;
  }
  return out;
}
/** Hash of every row of the given tables outside tenant A. */
async function others() {
  const out: Record<string, string> = {};
  for (const t of ['orders', 'documents', 'crm_clients', 'crm_values', 'idempotency_keys', 'inbound_orders', 'webhook_deliveries', 'shipping_plans', 'order_events', 'shipments', 'return_cases'])
    out[t] = (await pool.query(`SELECT md5(coalesce(string_agg(x::text,'|' ORDER BY x::text),'')) h FROM ${t} x WHERE tenant_id<>$1`, [A])).rows[0].h;
  return out;
}
const mentions = async (table: string, text: string) => (await pool.query(`SELECT count(*)::int n FROM ${table} x WHERE tenant_id=$1 AND x::text ILIKE $2`, [A, '%' + text + '%'])).rows[0].n as number;
const registerRows = async (where: string, params: unknown[]) => (await pool.query(`SELECT action,channel,resource,purpose,crm_client_id,subject_hash,api_key_id FROM rodo228_access_log WHERE tenant_id=$1 AND ${where} ORDER BY accessed_at,id`, [A, ...params])).rows;

before(async () => {
  for (const name of ['rodo228_access_log', 'rodo228_requests', 'rodo228_retained', 'rodo228_settings'])
    assert.notEqual((await pool.query('SELECT to_regclass($1) n', ['public.' + name])).rows[0].n, null, 'Clone needs committed 228: ' + name);
  assert.equal((await pool.query("SELECT count(*)::int n FROM migrations WHERE name='228_rodo'")).rows[0].n, 1);
  assert.equal((await pool.query('SELECT count(*)::int n FROM rodo228_access_log')).rows[0].n, 0, 'Fresh clone required; no rerun');
  assert.equal(await rodo228Available(pool), true);
  admin = (await pool.query("SELECT user_id FROM memberships WHERE tenant_id=$1 AND role='admin' ORDER BY user_id LIMIT 1", [A])).rows[0].user_id;
  operator = (await pool.query("SELECT user_id FROM memberships WHERE tenant_id=$1 AND role='operator' ORDER BY user_id LIMIT 1", [A])).rows[0]?.user_id;
  assert.equal((await pool.query('SELECT coalesce((SELECT require_mfa FROM workspace_security_policies WHERE tenant_id=$1),false) m', [A])).rows[0].m, false);
  subjectOrder = (await pool.query('SELECT id FROM orders WHERE tenant_id=$1 AND email=$2', [A, SUBJECT])).rows[0].id;
  otherTenant = (await pool.query('SELECT tenant_id FROM orders WHERE tenant_id<>$1 AND email=$2 LIMIT 1', [A, SUBJECT])).rows[0].tenant_id;
  // A CRM profile of the same customer with consents and notes, linked to the order.
  const status = (await pool.query('SELECT id FROM crm_statuses WHERE tenant_id=$1 AND is_primary', [A])).rows[0].id;
  client = (await pool.query(`INSERT INTO crm_clients(tenant_id,status_id,profile) VALUES($1,$2,$3::jsonb) RETURNING id`, [A, status, JSON.stringify({ star: 2, contractor_id: 0, login: 'lokalny-woo',
    phone: '+48 600 700 800', email: 'Local-Woo@example.test', notes: 'Prosi o kontakt po 17:00', invoice_company: '', invoice_fullname: 'Lokalny Kupujący', invoice_address: 'Kwiatowa 12',
    invoice_postcode: '00-950', invoice_city: 'Warszawa', invoice_state: '', invoice_country_code: 'PL', invoice_tax_id: '', delivery_company: '', delivery_fullname: '', delivery_address: '',
    delivery_postcode: '', delivery_city: '', delivery_state: '', delivery_country_code: '' })])).rows[0].id;
  const consent = (await pool.query("SELECT id FROM crm_extra_fields WHERE tenant_id=$1 AND name='Zgody'", [A])).rows[0].id;
  await pool.query("INSERT INTO crm_values(tenant_id,client_id,field_id,editor_type,value) VALUES($1,$2,$3,'checkbox','[\"E-mail\",\"Telefon\"]')", [A, client, consent]);
  await pool.query('INSERT INTO crm_order_links(tenant_id,client_id,order_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [A, client, subjectOrder]);
  wireToken = 'dyna_api_' + randomBytes(32).toString('hex'); wireKey = randomUUID();
  await pool.query(`INSERT INTO api_keys(id,tenant_id,user_id,name,token_hash,prefix,scopes,expires_at) VALUES($1,$2,$3,'Isolated rodo228 test',$4,$5,'{orders:read}',clock_timestamp()+interval '1 day')`,
    [wireKey, A, admin, tokenHash(wireToken), wireToken.slice(0, 16)]);
  await pool.query("INSERT INTO base_wire218_key_scopes(tenant_id,key_id,scope) VALUES($1,$2,'crm:read')", [A, wireKey]);
  observeBaseWireReads(rodo228WireObserver(pool, KEY, () => rodo228Available(pool)));
  session = await make(() => new Date('2026-10-23T10:00:00Z'));
  later = await make(() => new Date('2033-01-02T10:00:00Z'));
});
after(async () => { observeBaseWireReads(null); await session?.close(); await later?.close(); await pool.end(); });

test('guards true before any RODO operation', async () => assert.deepEqual(await guards(), allTrue));

test('customer card and Base CRM read are written to the access register', async () => {
  const card = ok(await call('GET', '/api/crm/clients/' + client));
  assert.equal(card.data.email, 'Local-Woo@example.test');
  ok(await call('GET', '/api/crm/clients/' + client + '/orders'));
  const pub = Number((await pool.query('SELECT public_id::text p FROM base_wire218_client_ids WHERE tenant_id=$1 AND local_id=$2', [A, client])).rows[0].p);
  const w = await wire('getCrmClientData', { crm_client_id: pub });
  assert.equal(w.statusCode, 200, w.body); assert.equal(w.json().status, 'SUCCESS', w.body);
  const rows = await registerRows('crm_client_id=$2', [client]);
  const hash = subjectHash(KEY, A, 'email', SUBJECT);
  assert.deepEqual(rows.map(r => [r.action, r.channel, r.resource]), [['read', 'session', 'GET /api/crm/clients/:id'], ['read', 'session', 'GET /api/crm/clients/:id/orders'], ['read', 'api', 'connector.php getCrmClientData']]);
  assert(rows.every(r => r.subject_hash === hash)); assert.equal(rows[2].api_key_id, wireKey); assert.equal(rows[0].api_key_id, null);
  // The register is append-only for the application.
  await assert.rejects(tenantTx(A, c => c.query('UPDATE rodo228_access_log SET purpose=$1', ['x'])), (e: any) => e.code === '42501');
  await assert.rejects(tenantTx(A, c => c.query('DELETE FROM rodo228_access_log')), (e: any) => e.code === '42501');
  await assert.rejects(pool.query('UPDATE rodo228_access_log SET purpose=$1', ['x']), (e: any) => e.code === '55000');
});

test('refusals: operator 403, unknown customer 404, open order and unsettled payment 409', async () => {
  if (operator) refused(await call('GET', '/api/rodo228/export?email=' + EXPORTED, undefined, { role: 'operator', user: operator }), 403, /administrator/);
  refused(await call('GET', '/api/rodo228/export?email=' + EXPORTED, undefined, { role: 'viewer' }), 403, /administrator/);
  refused(await call('POST', '/api/rodo228/anonymisation/preview', { email: 'nikogo-takiego@example.test' }), 404, /^Nie znaleziono klienta o podanych danych$/);
  refused(await call('POST', '/api/rodo228/anonymisation/preview', { crm_client_id: randomUUID() }), 404, /Nie znaleziono klienta CRM/);
  const before = (await pool.query('SELECT md5(string_agg(o::text,\'|\' ORDER BY id)) h FROM orders o WHERE tenant_id=$1', [A])).rows[0].h;
  refused(await call('POST', '/api/rodo228/anonymisation/preview', { email: OPEN }), 409, /otwarte zamówienia: DE-\d{8}-[0-9A-F]{8} \(nowe\); nierozliczone płatności/);
  refused(await call('POST', '/api/rodo228/anonymisation/preview', { email: EXPORTED }), 409, /otwarte zamówienia: .*\(wysłane\)/);
  assert.equal((await pool.query('SELECT md5(string_agg(o::text,\'|\' ORDER BY id)) h FROM orders o WHERE tenant_id=$1', [A])).rows[0].h, before, 'a refused preview changes nothing');
  assert.equal((await pool.query('SELECT count(*)::int n FROM rodo228_requests')).rows[0].n, 0);
  const refusals = await registerRows("action='anonymisation_preview'", []);
  assert.equal(refusals.length, 2); assert(refusals.every(r => /Odmowa/.test(r.purpose)));
});

test('export of a real customer: ZIP with JSON and CSV containing the orders, invoice data and register', async () => {
  const r = await call('GET', '/api/rodo228/export?email=' + EXPORTED + '&purpose=' + encodeURIComponent('Wniosek klienta z 23.10.2026'));
  assert.equal(r.statusCode, 200, r.body); assert.equal(r.headers['content-type'], 'application/zip'); assert.equal(r.headers['cache-control'], 'private, no-store');
  const files = unzip(r.rawPayload), data = JSON.parse(files['dane-klienta.json']!.toString('utf8'));
  const orders = (await pool.query('SELECT id,number FROM orders WHERE tenant_id=$1 AND lower(email)=$2 ORDER BY created_at', [A, EXPORTED])).rows;
  assert(orders.length >= 1);
  assert.deepEqual(data.zamowienia.map((o: any) => o.numer), orders.map(o => o.number));
  assert(data.zamowienia.every((o: any) => o.email === EXPORTED && o.pozycje.length > 0));
  const doc = (await pool.query('SELECT number FROM documents WHERE order_id=$1', [orders[0].id])).rows[0];
  if (doc) assert(data.faktury.some((f: any) => f.numer === doc.number && f.zamowienie === orders[0].number));
  assert.equal(data.informacje.podstawa, 'art. 15 i art. 20 RODO');
  assert(data.adresy.length >= 1);
  const csv = files['dane-klienta.csv']!.toString('utf8');
  assert(csv.startsWith('﻿sekcja;rekord;pole;wartosc'));
  assert(csv.includes(';numer;' + orders[0].number));
  const rows = await registerRows("action='export'", []);
  assert.equal(rows.length, 1); assert.equal(rows[0].purpose, 'Wniosek klienta z 23.10.2026'); assert.equal(rows[0].subject_hash, subjectHash(KEY, A, 'email', EXPORTED));
  // Export of the CRM customer carries the consents and the CRM profile.
  const crm = JSON.parse(unzip((await call('GET', '/api/rodo228/export?crm_client_id=' + client)).rawPayload)['dane-klienta.json']!.toString('utf8'));
  assert.deepEqual(crm.zgody.map((z: any) => z.wartosc), [['E-mail', 'Telefon']]);
  assert.equal(crm.klienci_crm[0].profil.notes, 'Prosi o kontakt po 17:00');
  assert(crm.zamowienia.some((o: any) => o.id === subjectOrder));
});

let preview: any;
test('preview: what is anonymised and what is kept with its legal basis and retention end; nothing changes', async () => {
  const orderBefore = (await pool.query('SELECT o::text t FROM orders o WHERE id=$1', [subjectOrder])).rows[0].t;
  preview = ok(await call('POST', '/api/rodo228/anonymisation/preview', { email: SUBJECT }));
  assert.equal(preview.state, 'previewed'); assert.match(preview.plan_sha256, /^[a-f0-9]{64}$/);
  const p = preview.plan;
  assert.deepEqual(p.crm_client_ids, [client]);
  assert.deepEqual(p.orders.map((o: any) => [o.id, o.tax_retention_end]), [[subjectOrder, '2031-12-31']]);
  const order = p.anonymise.find((i: any) => i.table === 'orders');
  assert(order && order.fields.includes('email'));
  assert(p.anonymise.some((i: any) => i.table === 'crm_clients' && i.fields.includes('profile.email') && i.fields.includes('profile.notes')));
  assert(p.anonymise.some((i: any) => i.table === 'crm_values'));
  const keepOrder = p.keep.find((i: any) => i.table === 'orders' && i.basis === 'tax_retention');
  assert.deepEqual(keepOrder.fields, ['customer_name', 'address.street', 'address.city', 'address.postal_code', 'address.country']);
  assert.equal(keepOrder.retention_end, '2031-12-31'); assert.equal(keepOrder.due_on, '2032-01-01'); assert.match(keepOrder.legal_basis, /art\. 112 ustawy o VAT/);
  assert(p.keep.filter((i: any) => i.table === 'documents').every((i: any) => i.basis === 'tax_retention' && i.retention_end === '2031-12-31'));
  assert(p.keep.some((i: any) => i.basis === 'immutable_evidence' && /art\. 118 KC/.test(i.legal_basis)));
  assert(!/local-woo@|Lokalny Kupujący|Kwiatowa|600 700 800/i.test(JSON.stringify(p)), 'the plan holds no personal values');
  assert.equal((await pool.query('SELECT o::text t FROM orders o WHERE id=$1', [subjectOrder])).rows[0].t, orderBefore, 'preview is rolled back');
  assert.equal((await pool.query('SELECT count(*)::int n FROM crm_values WHERE client_id=$1', [client])).rows[0].n, 1);
});

test('confirm: personal data removed outside the retained fields, invoice buyer kept, other tenant untouched, idempotent', async () => {
  const docsBefore = (await pool.query('SELECT id,data::text d FROM documents WHERE order_id=$1 ORDER BY id', [subjectOrder])).rows;
  const otherBefore = await others();
  const orderBefore = (await pool.query('SELECT customer_name,address FROM orders WHERE id=$1', [subjectOrder])).rows[0];
  refused(await call('POST', '/api/rodo228/anonymisation/' + preview.request_id + '/confirm', { plan_sha256: 'f'.repeat(64) }), 409, /innego podglądu/);
  refused(await call('POST', '/api/rodo228/anonymisation/' + preview.request_id + '/confirm', { plan_sha256: preview.plan_sha256 }, { role: 'operator', user: operator ?? admin }), 403, /administrator/);
  const done = ok(await call('POST', '/api/rodo228/anonymisation/' + preview.request_id + '/confirm', { plan_sha256: preview.plan_sha256 }));
  assert.equal(done.state, 'completed'); assert.equal(done.replayed, false);
  assert.equal(done.result.anonymised, preview.plan.anonymise.length); assert.equal(done.result.kept, preview.plan.keep.length);
  const again = ok(await call('POST', '/api/rodo228/anonymisation/' + preview.request_id + '/confirm', { plan_sha256: preview.plan_sha256 }));
  assert.equal(again.replayed, true); assert.deepEqual(again.result, done.result);
  // The order: contact data gone, invoice buyer data kept.
  const o = (await pool.query('SELECT customer_name,email,note,address FROM orders WHERE id=$1', [subjectOrder])).rows[0];
  assert.match(o.email, /^anonim-[0-9a-f]{8}@anonim\.invalid$/); assert.equal(o.note, '');
  assert.equal(o.customer_name, orderBefore.customer_name); assert.equal(o.address.street, orderBefore.address.street); assert.equal(o.address.city, orderBefore.address.city);
  if (orderBefore.address.phone !== undefined) assert.equal(o.address.phone, '');
  // Invoices are unchanged.
  assert.deepEqual((await pool.query('SELECT id,data::text d FROM documents WHERE order_id=$1 ORDER BY id', [subjectOrder])).rows, docsBefore);
  // CRM profile and its consents.
  const cl = (await pool.query('SELECT profile,version FROM crm_clients WHERE id=$1', [client])).rows[0];
  for (const k of ['email', 'phone', 'login', 'notes', 'invoice_fullname', 'invoice_address', 'invoice_city', 'invoice_postcode']) assert.equal(cl.profile[k], '', k);
  assert.equal(cl.profile.star, 2); assert.equal(cl.version, 2);
  assert.equal((await pool.query('SELECT count(*)::int n FROM crm_values WHERE client_id=$1', [client])).rows[0].n, 0);
  // Mutable places in tenant A no longer mention the customer; documents still do.
  for (const t of ['orders', 'crm_clients', 'crm_values', 'inbound_orders', 'idempotency_keys', 'webhook_deliveries', 'shipping_plans', 'order_events', 'shipments', 'return_cases', 'audit_events'])
    for (const text of [SUBJECT, '600 700 800', 'Prosi o kontakt']) assert.equal(await mentions(t, text), 0, t + ' still mentions ' + text);
  assert(await mentions('documents', SUBJECT) > 0, 'invoice buyer data is kept');
  // Other tenants, including the same e-mail elsewhere, are untouched.
  assert.deepEqual(await others(), otherBefore);
  assert.equal((await pool.query('SELECT email FROM orders WHERE tenant_id=$1 AND email=$2', [otherTenant, SUBJECT])).rowCount! >= 1, true);
  // Kept fields with the due date, and the register.
  const kept = (await pool.query("SELECT source_table,basis,to_char(retention_end,'YYYY-MM-DD') e,to_char(due_on,'YYYY-MM-DD') d FROM rodo228_retained WHERE request_id=$1 ORDER BY item_no", [preview.request_id])).rows;
  assert.equal(kept.length, preview.plan.keep.length);
  assert(kept.some(k => k.source_table === 'orders' && k.basis === 'tax_retention' && k.e === '2031-12-31' && k.d === '2032-01-01'));
  const reg = await registerRows('crm_client_id=$2', [client]);
  assert.deepEqual(reg.map(r => r.action), ['read', 'read', 'read', 'export', 'anonymisation_preview', 'anonymisation']);
  const byEmail = ok(await call('GET', '/api/rodo228/access-log?email=' + SUBJECT));
  assert.deepEqual(byEmail.data.map((r: any) => r.action), ['anonymisation', 'anonymisation_preview', 'export', 'read', 'read', 'read']);
  assert(byEmail.data.every((r: any) => r.actor !== null));
  assert.equal(ok(await call('GET', '/api/rodo228/access-log?action=export&limit=1')).data.length, 1);
});

test('a new preview of the anonymised customer finds nothing more to anonymise in the order and CRM', async () => {
  const p = ok(await call('POST', '/api/rodo228/anonymisation/preview', { crm_client_id: client })).plan;
  assert(!p.anonymise.some((i: any) => ['orders', 'crm_clients', 'crm_values'].includes(i.table)), JSON.stringify(p.anonymise));
});

test('kept fields: none due today, all due after the retention end ("do anonimizacji po terminie")', async () => {
  const now = ok(await call('GET', '/api/rodo228/retained?due=1'));
  assert.equal(now.today, '2026-10-23'); assert.equal(now.data.length, 0);
  const all = ok(await call('GET', '/api/rodo228/retained'));
  assert(all.data.length >= preview.plan.keep.length); assert(all.data.every((r: any) => r.overdue === false));
  const due = ok(await call('GET', '/api/rodo228/retained?due=1', undefined, {}, later));
  assert.equal(due.today, '2033-01-02'); assert(due.data.length >= preview.plan.keep.length);
  assert(due.data.every((r: any) => r.overdue === true && r.due_on <= '2033-01-02'));
  assert(due.data.some((r: any) => r.source_table === 'orders' && r.order_number));
  assert.equal(ok(await call('GET', '/api/rodo228/requests')).data.filter((r: any) => r.state === 'completed').length, 1);
});

test('register retention: configurable, purge removes only rows older than it', async () => {
  refused(await call('PUT', '/api/rodo228/settings', { access_log_retention_days: 30 }), 422, /180 dni/);
  assert.equal(ok(await call('PUT', '/api/rodo228/settings', { access_log_retention_days: 365 })).settings.access_log_retention_days, 365);
  await pool.query(`INSERT INTO rodo228_access_log(tenant_id,accessed_at,actor_id,channel,action,purpose,resource,crm_client_id) VALUES($1,clock_timestamp()-interval '400 days',$2,'session','read','stary wpis','test',$3)`, [A, admin, client]);
  const count = async () => (await pool.query('SELECT count(*)::int n FROM rodo228_access_log WHERE tenant_id=$1', [A])).rows[0].n as number;
  const n = await count();
  assert.equal(ok(await call('POST', '/api/rodo228/access-log/purge')).deleted, 1);
  assert.equal(await count(), n - 1);
  assert.equal(ok(await call('POST', '/api/rodo228/access-log/purge')).deleted, 0);
  assert.equal(ok(await call('GET', '/api/rodo228/status')).settings.access_log_retention_days, 365);
});

test('an order frozen by its parcel allocation is kept as immutable evidence with the guard reason', async () => {
  const row = (await pool.query(`SELECT o.id,o.tenant_id,o.email,o.number,(SELECT user_id FROM memberships m WHERE m.tenant_id=o.tenant_id AND m.role='admin' ORDER BY user_id LIMIT 1) admin
    FROM orders o WHERE o.status='shipped' AND EXISTS(SELECT 1 FROM order_parcel_plans p WHERE p.order_id=o.id)
    AND NOT EXISTS(SELECT 1 FROM orders x WHERE x.tenant_id=o.tenant_id AND x.email=o.email AND x.id<>o.id) ORDER BY o.tenant_id,o.id LIMIT 1`)).rows[0];
  assert(row?.admin, 'a single shipped order with a parcel allocation');
  await pool.query("UPDATE orders SET status='delivered' WHERE id=$1", [row.id]);
  const before = (await pool.query('SELECT o::text t FROM orders o WHERE id=$1', [row.id])).rows[0].t;
  const as = { tenant: row.tenant_id, user: row.admin };
  const pv = ok(await call('POST', '/api/rodo228/anonymisation/preview', { email: row.email }, as));
  assert(!pv.plan.anonymise.some((i: any) => i.table === 'orders'));
  const k = pv.plan.keep.find((i: any) => i.table === 'orders');
  assert.equal(k.basis, 'immutable_evidence'); assert.match(k.reason, /Przydział paczek zamraża odbiorcę/); assert.equal(k.retention_end, '2032-12-31'); assert.equal(k.due_on, '2033-01-01');
  assert(k.fields.includes('email') && k.fields.includes('customer_name'));
  ok(await call('POST', '/api/rodo228/anonymisation/' + pv.request_id + '/confirm', { plan_sha256: pv.plan_sha256 }, as));
  assert.equal((await pool.query('SELECT o::text t FROM orders o WHERE id=$1', [row.id])).rows[0].t, before);
  assert.equal((await pool.query("SELECT count(*)::int n FROM rodo228_retained WHERE tenant_id=$1 AND source_table='orders' AND basis='immutable_evidence' AND row_ref=$2", [row.tenant_id, row.id])).rows[0].n, 1);
  assert.equal((await pool.query('SELECT count(*)::int n FROM rodo228_retained WHERE tenant_id=$1', [A])).rows[0].n, preview.plan.keep.length, 'tenant A kept rows unchanged');
});

test('guards true after anonymisation', async () => assert.deepEqual(await guards(), allTrue));
