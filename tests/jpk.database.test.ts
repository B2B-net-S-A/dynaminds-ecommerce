/** JPK files on a real disposable clone (dynaminds_jpk_20261023_NN): the real routes with the real
 * finance-admin authorization and the real loader (native detail reads with a session identity).
 * For every tenant with issued documents in October 2026 the V7M and JPK_FA files are parsed back
 * and their Ctrl sums compared with the stored totals of the same documents; the invoiced gross is
 * cross-checked with GET /api/settlement-report. Demo-only tenant, 403, 400 and a real 409.
 * Root-only on a fresh clone; only sessions rows are added. */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { pool } from '../server/db';
import { Problem } from '../server/errors';
import { tokenHash } from '../server/security';
import { registerJpkRoutes } from '../server/jpk-routes';
import { registerSettlementReportRoutes } from '../server/settlement-report-routes';
import { jpkValues, jpkRecords, minorOf } from './jpk-fixtures';

assert.equal(process.env.DYNA_TEST, 'true', 'Explicit isolated test mode required');
const selected = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(selected.hostname, '127.0.0.1');
assert.equal(selected.port, '57084');
assert.match(selected.pathname, /^\/dynaminds_(jpk_20261023|xsd30_20261030)_[0-9]{2}$/);
assert.equal(selected.username, 'postgres');
pool.options.query_timeout = 20000;
const SESSION = 'dyna_session';
type Who = { tenant: string; user: string; role: string; token: string };
let app: FastifyInstance;
const sessions: Who[] = [];

async function member(tenant: string, role: string): Promise<Who> {
  const user = (await pool.query('SELECT user_id FROM memberships WHERE tenant_id=$1 AND role=$2 ORDER BY user_id LIMIT 1', [tenant, role])).rows[0]?.user_id as string;
  assert(user, `seed needs ${role} in ${tenant}`);
  const token = randomBytes(32).toString('hex');
  await pool.query(`INSERT INTO sessions(token_hash,user_id,tenant_id,expires_at,account_version,mfa_verified_at)
    VALUES($1,$2,$3,clock_timestamp()+interval '1 hour',coalesce((SELECT version FROM account_security WHERE user_id=$2),0),clock_timestamp())`, [tokenHash(token), user, tenant]);
  const w = { tenant, user, role, token }; sessions.push(w); return w;
}
const get = (w: Who, url: string) => app.inject({ url, headers: { 'x-test-as': JSON.stringify(w) } });
const TP = 'kod_urzedu=1206&email=ksiegowosc%40sklep.test';
const ADDR = 'wojewodztwo=mazowieckie&powiat=Warszawa&gmina=Warszawa&nr_domu=1&miejscowosc=Warszawa&kod_pocztowy=00-001';
const big = (v: unknown) => BigInt(String(v));

/** Stored totals of every issued (non-demo) document of a tenant in October, read from the native rows. */
async function storedDocuments(tenant: string) {
  const rows = (await pool.query(`
    SELECT number, kind, coalesce(data->>'sell_date',data->>'sale_date',data->>'issue_date') tax_date, data->>'issue_date' issue_date,
      CASE mode WHEN 'local_invoice' THEN data->'totals' WHEN 'b2b_invoice' THEN data#>'{fiscal_snapshot,totals}' ELSE data#>'{calculation,totals,delta}' END t
     FROM documents WHERE tenant_id=$1 AND mode IN ('local_invoice','b2b_invoice','b2b_correction')
    UNION ALL SELECT number,kind,data->>'issue_date',data->>'issue_date',data#>'{calculation,totals,delta}' FROM local_consumer_credit_documents WHERE tenant_id=$1
    UNION ALL SELECT number,kind,data->>'issue_date',data->>'issue_date',data#>'{calculation,totals,delta}' FROM return_credit206_documents WHERE tenant_id=$1`, [tenant])).rows;
  return rows.filter(r => r.tax_date.startsWith('2026-10')).map(r => ({ number: r.number as string, kind: r.kind as string, issue_date: r.issue_date as string,
    gross: big(r.t.gross_minor), net: big(r.t.net_minor), vat: big(r.t.vat_minor) }));
}

before(async () => {
  app = Fastify();
  app.decorateRequest('actor'); app.decorateRequest('currentUser'); app.decorateRequest('apiScopes'); app.decorateRequest('apiKeyId');
  app.addHook('onRequest', async (req: any) => {
    const w = JSON.parse(String(req.headers['x-test-as'])) as Who;
    req.actor = { tenantId: w.tenant, userId: w.user, role: w.role, source: 'session' };
    req.currentUser = { id: w.user, tenant_id: w.tenant, role: w.role };
    req.cookies = { [SESSION]: w.token };
  });
  app.setErrorHandler((err: any, _req, reply) =>
    err instanceof Problem ? reply.code(err.status).send({ detail: err.message }) : reply.code(500).send({ detail: 'Nieoczekiwany błąd serwera: ' + err.message }));
  registerJpkRoutes(app, { sessionName: SESSION });
  registerSettlementReportRoutes(app, { readOnly: false });
  await app.ready();
});
after(async () => { await app?.close(); await pool.end(); });

test('October 2026: for every tenant with issued documents the V7M and JPK_FA files parse back and Ctrl sums equal the stored documents', async () => {
  // Every native read is a full tenant transaction (seconds on PG04), so a representative set:
  // FV + 188 + 206/207, FV + 206/207 on another day, FV alone, and a B2B FV 159.
  const pick = async (sql: string) => (await pool.query(sql)).rows[0].tenant_id as string;
  const tenants = [...new Set([
    await pick("SELECT c.tenant_id FROM local_consumer_credit_documents c WHERE EXISTS(SELECT FROM return_credit206_documents r WHERE r.tenant_id=c.tenant_id) ORDER BY 1 LIMIT 1"),
    await pick("SELECT r.tenant_id FROM return_credit206_documents r WHERE NOT EXISTS(SELECT FROM local_consumer_credit_documents c WHERE c.tenant_id=r.tenant_id) ORDER BY data->>'issue_date' DESC,1 LIMIT 1"),
    await pick("SELECT d.tenant_id FROM documents d WHERE d.mode='local_invoice' AND NOT EXISTS(SELECT FROM return_credit206_documents r WHERE r.tenant_id=d.tenant_id) ORDER BY 1 LIMIT 1"),
    await pick("SELECT tenant_id FROM documents WHERE mode='b2b_invoice' ORDER BY 1 LIMIT 1"),
  ])];
  assert.equal(tenants.length, 4, 'four distinct seeded tenants');
  let corrections = 0, b2b = 0;
  for (const tenant of tenants) {
    const admin = await member(tenant, 'admin'), stored = await storedDocuments(tenant);
    const v7 = await get(admin, `/api/jpk/v7m.xml?okres=2026-10&${TP}`);
    assert.equal(v7.statusCode, 200, tenant + ' ' + v7.body);
    const v = jpkValues(v7.body), rows = jpkRecords(v7.body, 'SprzedazWiersz');
    const expressed = stored.filter(d => d.gross !== 0n || d.net !== 0n);
    assert.deepEqual(rows.map(r => r.DowodSprzedazy).sort(), expressed.map(d => d.number).sort(), tenant + ' one row per document');
    assert.equal(v7.headers['x-jpk-wiersze'], String(rows.length));
    const outputVat = expressed.reduce((n, d) => n + d.vat, 0n);
    assert.equal(minorOf(v.PodatekNalezny![0]), outputVat, tenant + ' SprzedazCtrl = stored VAT');
    assert.equal(rows.reduce((n, r) => n + minorOf(r.K_16) + minorOf(r.K_18) + minorOf(r.K_20), 0n), outputVat);
    const nets = rows.reduce((n, r) => n + ['K_10', 'K_11', 'K_13', 'K_15', 'K_17', 'K_19', 'K_21', 'K_22', 'K_31'].reduce((m, k) => m + minorOf(r[k]), 0n), 0n);
    assert.equal(nets, expressed.reduce((n, d) => n + d.net, 0n), tenant + ' K nets = stored nets');
    assert.deepEqual(v.P_38, [((outputVat < 0n ? -1n : 1n) * (((outputVat < 0n ? -outputVat : outputVat) + 50n) / 100n)).toString()], tenant + ' P_38');
    const seller = (await pool.query(`SELECT coalesce(data#>>'{seller,tax_id}',data#>>'{fiscal_snapshot,seller,tax_id}') nip FROM documents WHERE tenant_id=$1 AND mode IN ('local_invoice','b2b_invoice') LIMIT 1`, [tenant])).rows[0].nip;
    assert.deepEqual(v.NIP, [seller]);

    const fa = await get(admin, `/api/jpk/fa.xml?od=2026-10-01&do=2026-10-31&kod_urzedu=1206&${ADDR}`);
    assert.equal(fa.statusCode, 200, tenant + ' ' + fa.body);
    const f = jpkValues(fa.body), invoices = jpkRecords(fa.body, 'Faktura'), lines = jpkRecords(fa.body, 'FakturaWiersz');
    const issued = (await storedDocuments(tenant)).filter(d => d.issue_date.startsWith('2026-10'));
    assert.deepEqual(invoices.map(i => i.P_2A).sort(), issued.map(d => d.number).sort());
    assert.deepEqual(f.LiczbaFaktur, [String(issued.length)]);
    assert.equal(minorOf(f.WartoscFaktur![0]), issued.reduce((n, d) => n + d.gross, 0n), tenant + ' FakturaCtrl = stored gross');
    assert.deepEqual(f.LiczbaWierszyFaktur, [String(lines.length)]);
    assert.equal(minorOf(f.WartoscWierszyFaktur![0]), issued.reduce((n, d) => n + d.net, 0n), tenant + ' FakturaWierszCtrl = stored net');
    assert.deepEqual(invoices.filter(i => i.RodzajFaktury === 'KOREKTA').map(i => i.P_2A).sort(), issued.filter(d => d.kind === 'correction').map(d => d.number).sort());
    corrections += issued.filter(d => d.kind === 'correction').length;
    b2b += invoices.filter(i => i.P_5B).length;

    if (tenant !== tenants[0]) continue;
    // Settlement report of the same tenant: invoiced gross of the orders equals the JPK_FA invoices.
    const s = await get(admin, '/api/settlement-report?from=2026-09-01&to=2026-10-31');
    assert.equal(s.statusCode, 200, s.body);
    const pln = s.json().totals.find((x: any) => x.currency === 'PLN');
    if (pln) assert.equal(BigInt(pln.invoiced), invoices.filter(i => i.RodzajFaktury === 'VAT').reduce((n, i) => n + minorOf(i.P_15), 0n), tenant + ' settlement invoiced');
  }
  assert.ok(corrections >= 3, 'real corrections 188/206 covered: ' + corrections);
  assert.ok(b2b >= 1, 'real B2B invoice covered: ' + b2b);
});

test('V7K: October/November without the declaration, December carries VAT-7K of the quarter', async () => {
  const tenant = (await pool.query("SELECT tenant_id FROM local_consumer_credit_documents LIMIT 1")).rows[0].tenant_id;
  const admin = await member(tenant, 'admin');
  const oct = await get(admin, `/api/jpk/v7k.xml?okres=2026-10&${TP}`);
  assert.equal(oct.statusCode, 200, oct.body);
  const o = jpkValues(oct.body);
  assert.equal(o.Deklaracja, undefined); assert.ok(Number(o.LiczbaWierszySprzedazy![0]) >= 2);
  const dec = await get(admin, `/api/jpk/v7k.xml?okres=2026-12&${TP}`);
  assert.equal(dec.statusCode, 200, dec.body);
  const d = jpkValues(dec.body);
  assert.deepEqual([d.KodFormularzaDekl, d.LiczbaWierszySprzedazy], [['VAT-7K'], ['0']]);
  assert.equal(BigInt(d.P_38![0]!), (minorOf(o.PodatekNalezny![0]) + 50n) / 100n, 'declaration over the quarter = October VAT');
});

test('demo-only tenant: demo documents are not VAT documents; NIP and name then come from the request', async () => {
  const tenant = '11111111-1111-4111-8111-111111111111';
  assert.ok((await pool.query("SELECT count(*)::int n FROM documents WHERE tenant_id=$1 AND mode='demo'", [tenant])).rows[0].n > 0);
  const admin = await member(tenant, 'admin');
  const bare = await get(admin, `/api/jpk/v7m.xml?okres=2026-10&${TP}`);
  assert.equal(bare.statusCode, 400, bare.body); assert.match(bare.json().detail, /podaj NIP/);
  const r = await get(admin, `/api/jpk/v7m.xml?okres=2026-10&${TP}&nip=5260250274&nazwa=Demo%20Sp.%20z%20o.o.`);
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(jpkValues(r.body).LiczbaWierszySprzedazy, ['0']);
});

test('refusals on real data: operator and viewer 403, bad period 400, documents of another NIP 409 with the list', async () => {
  const demo = '11111111-1111-4111-8111-111111111111';
  for (const role of ['operator', 'viewer']) {
    const r = await get(await member(demo, role), `/api/jpk/v7m.xml?okres=2026-10&${TP}`);
    assert.equal(r.statusCode, 403, r.body); assert.match(r.json().detail, /administrator finansów/);
  }
  const tenant = (await pool.query("SELECT tenant_id FROM local_consumer_credit_documents LIMIT 1")).rows[0].tenant_id;
  const admin = await member(tenant, 'admin');
  const bad = await get(admin, `/api/jpk/v7m.xml?okres=2026-1&${TP}`);
  assert.equal(bad.statusCode, 400); assert.match(bad.json().detail, /RRRR-MM/);
  const other = await get(admin, `/api/jpk/v7m.xml?okres=2026-10&${TP}&nip=8567346215`);
  assert.equal(other.statusCode, 409, other.body);
  const body = other.json(), stored = await storedDocuments(tenant);
  assert.deepEqual(body.documents.map((d: any) => d.number).sort(), stored.map(d => d.number).sort());
  assert.ok(body.documents.every((d: any) => /NIP sprzedawcy/.test(d.reason)));
  assert.equal((await pool.query('SELECT count(*)::int n FROM sessions WHERE token_hash = ANY($1)', [sessions.map(s => tokenHash(s.token))])).rows[0].n, sessions.length, 'only own sessions written');
});
