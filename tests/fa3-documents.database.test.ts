/** FA(3) single entry point on a real disposable clone: real issued documents of the
 * restored copy (consumer FV 157, consumer correction 188, consumer return correction
 * 206/207, B2B FV 159, a demo document) read through GET /api/fa3/documents/:id/fa3.xml
 * with the native identity frame of an own API key, as the auth hook would set it.
 * Key fields are parsed back with an XML parser and compared with the stored rows.
 * Root-only on a fresh clone dynaminds_fa3all_20261023_NN; only api_keys rows are added. */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../server/db';
import { Problem } from '../server/errors';
import { tokenHash } from '../server/security';
import { registerFa3DocumentRoutes } from '../server/fa3-document-routes';
import { registerB2bInvoiceRoutes } from '../server/b2b-invoice-routes';
import { xmlValues } from './fa3-fixtures';

assert.equal(process.env.DYNA_TEST, 'true', 'Explicit isolated test mode required');
const selected = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(selected.hostname, '127.0.0.1');
assert.equal(selected.port, '57084');
assert.match(selected.pathname, /^\/dynaminds_(fa3all_20261023|xsd30_20261030|relxsd_20261030)_[0-9]{2}$/);
assert.equal(selected.username, 'postgres');
pool.options.query_timeout = 20000;
const KEY_NAME = 'Isolated FA3 all documents test';
const SCOPES = ['orders:read', 'documents:read', 'products:read'];
type Owner = { tenant: string; user: string; token: string; keyId: string };
let app: FastifyInstance;
const owners = new Map<string, Owner>();

async function owner(tenant: string): Promise<Owner> {
  const known = owners.get(tenant); if (known) return known;
  const user = (await pool.query("SELECT user_id FROM memberships WHERE tenant_id=$1 AND role='admin' ORDER BY user_id LIMIT 1", [tenant])).rows[0].user_id as string;
  const token = 'dyna_api_' + randomBytes(32).toString('hex'), keyId = randomUUID();
  await pool.query(`INSERT INTO api_keys(id,tenant_id,user_id,name,token_hash,prefix,scopes,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+interval '1 day')`,
    [keyId, tenant, user, KEY_NAME, tokenHash(token), token.slice(0, 16), SCOPES]);
  const o = { tenant, user, token, keyId }; owners.set(tenant, o); return o;
}
const xml = async (o: Owner, id: string) => app.inject({ method: 'GET', url: `/api/fa3/documents/${id}/fa3.xml`,
  headers: { authorization: 'Bearer ' + o.token, 'x-test-as': JSON.stringify({ tenant: o.tenant, user: o.user, key: o.keyId }) } });
const ok = (r: Awaited<ReturnType<typeof xml>>) => {
  assert.equal(r.statusCode, 200, r.body);
  assert.match(String(r.headers['content-type']), /^application\/xml; charset=utf-8$/);
  assert.equal(r.headers['cache-control'], 'no-store'); assert.equal(r.headers['x-content-type-options'], 'nosniff');
  return xmlValues(r.body);
};
const money = (minor: string | number | bigint) => { const n = BigInt(minor), a = n < 0n ? -n : n; return `${n < 0n ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`; };
const row = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0];

before(async () => {
  assert.equal((await pool.query('SELECT count(*)::int n FROM api_keys WHERE name=$1', [KEY_NAME])).rows[0].n, 0, 'Fresh clone required; no rerun');
  app = Fastify();
  app.decorateRequest('actor'); app.decorateRequest('currentUser'); app.decorateRequest('apiScopes'); app.decorateRequest('apiKeyId');
  app.addHook('onRequest', async (req: any) => {
    const as = JSON.parse(String(req.headers['x-test-as']));
    req.actor = { tenantId: as.tenant, userId: as.user, role: 'admin', apiKeyId: as.key, source: 'api' };
    req.currentUser = { id: as.user, tenant_id: as.tenant, role: 'admin', api_key_id: as.key };
    req.apiKeyId = as.key; req.apiScopes = SCOPES; req.cookies = {};
  });
  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof Problem) return reply.code(err.status).send({ detail: err.message });
    if (err instanceof z.ZodError) return reply.code(422).send({ detail: 'Nieprawidłowe żądanie' });
    return reply.code(500).send({ detail: 'Błąd serwera: ' + err.message });
  });
  registerFa3DocumentRoutes(app, { sessionName: 'dyna_session' });
  registerB2bInvoiceRoutes(app, { readOnly: false, sessionName: 'dyna_session' });
  await app.ready();
});
after(async () => { await app?.close(); await pool.end(); });

test('real consumer FV 157: BrakID buyer, seller NIP, number, dates and amounts equal the stored snapshot', async () => {
  const d = await row(`SELECT d.id,d.tenant_id,d.number,d.data FROM documents d WHERE d.mode='local_invoice'
    AND EXISTS(SELECT FROM local_consumer_credit_documents c WHERE c.original_document_id=d.id) LIMIT 1`);
  const v = ok(await xml(await owner(d.tenant_id), d.id)), s = d.data;
  assert.deepEqual([v.RodzajFaktury, v.P_2, v.P_1, v.KodWaluty], [['VAT'], [d.number], [s.issue_date], ['PLN']]);
  assert.deepEqual([v.NIP, v.BrakID, v.Nazwa], [[s.seller.tax_id], ['1'], [s.seller.name, s.buyer.name]]);
  assert.deepEqual(v.P_15, [money(s.totals.gross_minor)]);
  assert.deepEqual(v.P_11A, s.lines.map((l: any) => money(l.gross_minor)));
  assert.deepEqual(v.P_12, s.lines.map((l: any) => l.vat_rate === 0 ? '0 KR' : String(l.vat_rate)));
  const net23 = s.lines.filter((l: any) => l.vat_rate === 23).reduce((n: bigint, l: any) => n + BigInt(l.net_minor), 0n);
  if (net23 > 0n) assert.deepEqual(v.P_13_1, [money(net23)]);
  assert.equal(v.FaWiersz.length, s.lines.length);
});

test('real consumer correction 188: KOR with DaneFaKorygowanej (NrKSeFN), reason, StanPrzed rows and the signed difference', async () => {
  const c = await row('SELECT id,tenant_id,number,original_document_id,data FROM local_consumer_credit_documents LIMIT 1');
  const r = await xml(await owner(c.tenant_id), c.id), v = ok(r), calc = c.data.calculation;
  assert.match(String(r.headers['content-disposition']), new RegExp(`^attachment; filename="${c.number.replace(/\//g, '-')}\\.fa3\\.xml"$`));
  assert.deepEqual([v.RodzajFaktury, v.P_2, v.P_1, v.TypKorekty, v.NrKSeFN], [['KOR'], [c.number], [c.data.issue_date], ['2'], ['1']]);
  assert.deepEqual([v.NrFaKorygowanej, v.DataWystFaKorygowanej], [[c.data.original_document.number], [c.data.original_document.data.issue_date]]);
  assert.deepEqual(v.PrzyczynaKorekty, [c.data.reason]);
  const affected = calc.rows.filter((x: any) => x.affected);
  assert.equal(v.FaWiersz.length, 2 * affected.length); assert.equal(v.StanPrzed.length, affected.length);
  assert.deepEqual(v.P_11A, affected.flatMap((x: any) => [money(x.before.gross_minor), money(x.after.gross_minor)]));
  assert.deepEqual(v.P_15, [money(calc.totals.delta.gross_minor)]); assert.ok(BigInt(calc.totals.delta.gross_minor) < 0n, 'credit is negative');
});

test('real consumer return correction 206/207 through the same entry point', async () => {
  const c = await row("SELECT id,tenant_id,number,data FROM return_credit206_documents WHERE (data#>>'{calculation,totals,delta,gross_minor}')::bigint<>0 LIMIT 1");
  const v = ok(await xml(await owner(c.tenant_id), c.id));
  assert.deepEqual([v.RodzajFaktury, v.P_2, v.NrFaKorygowanej], [['KOR'], [c.number], [c.data.original_document.number]]);
  assert.deepEqual(v.P_15, [money(c.data.calculation.totals.delta.gross_minor)]);
});

test('real B2B FV 159 keeps its exporter behind the single entry point', async () => {
  const d = await row("SELECT id,tenant_id,number,data FROM documents WHERE mode='b2b_invoice' LIMIT 1");
  const v = ok(await xml(await owner(d.tenant_id), d.id));
  assert.deepEqual([v.RodzajFaktury, v.P_2, v.NIP], [['VAT'], [d.number], [d.data.fiscal_snapshot.seller.tax_id, d.data.fiscal_snapshot.buyer.tax_id]]);
});

test('the B2B FA(3) button (pinned route) answers the same validated file', async () => {
  const d = await row("SELECT id,tenant_id,number FROM documents WHERE mode='b2b_invoice' LIMIT 1"), o = await owner(d.tenant_id);
  const r = await app.inject({ method: 'GET', url: `/api/b2b-invoices/documents/${d.id}/fa3.xml`,
    headers: { authorization: 'Bearer ' + o.token, 'x-test-as': JSON.stringify({ tenant: o.tenant, user: o.user, key: o.keyId }) } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.headers['x-walidacja-xsd'], 'zgodny');
  assert.equal(xmlValues(r.body).P_2?.[0], d.number);
});

test('refusals: demo document 409 with Polish reason, unknown id 404, another tenant 404, malformed id 422', async () => {
  const demo = await row("SELECT id,tenant_id FROM documents WHERE mode='demo' LIMIT 1");
  const r = await xml(await owner(demo.tenant_id), demo.id);
  assert.equal(r.statusCode, 409, r.body); assert.match(r.json().detail, /demonstracyjny/);
  const credit = await row('SELECT id,tenant_id FROM local_consumer_credit_documents LIMIT 1');
  const stranger = await owner(demo.tenant_id === credit.tenant_id ? (await row("SELECT id FROM tenants WHERE id<>$1 LIMIT 1", [credit.tenant_id])).id : demo.tenant_id);
  const foreign = await xml(stranger, credit.id); assert.equal(foreign.statusCode, 404, foreign.body); assert.match(foreign.json().detail, /Nie znaleziono dokumentu/);
  const unknown = await xml(stranger, randomUUID()); assert.equal(unknown.statusCode, 404, unknown.body);
  const bad = await xml(stranger, 'not-a-uuid'); assert.equal(bad.statusCode, 422, bad.body);
  assert.equal((await pool.query('SELECT count(*)::int n FROM api_keys WHERE name=$1', [KEY_NAME])).rows[0].n, owners.size, 'nothing but own keys written');
});
