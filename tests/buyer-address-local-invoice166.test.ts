/** AUTHOR / NOT_RUN. Root supplies an already installed owned numeric166 DB and
 * private config BEFORE runtime imports. No seed, migration, reset, SQL parent
 * inserts, listener or provider. This is actual B2B FV159, not a DEMO document.
 * Bill-to is explicitly approved input from ORIGINAL data; no autofill claim.
 * Consumer157 likewise takes explicit request.buyer (SQL frame), so it is not
 * mislabeled as an automatic original-buyer projection in this acceptance.
 */
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { Pool } from 'pg';
import { ordinarySignup, paidAndShipped, sellerSeries, nativePreviewBody,
  type NativeActor, type Row } from '../data/source-drafts/b2b-fa3-native-acceptance-fixtures2';
import { issuedPrivateGraph159 } from '../data/source-drafts/b2b-fa3-invoice159-issued-reader166';
import { assertFiscalMoney159, assertIssuedGraph159, hash159,
  type IssuedBasis159 } from '../data/source-drafts/b2b-fa3-invoice159-native-acceptance-oracles166';

const original = Object.freeze({ recipient_name: 'Pierwotna firma QA166', street: 'Pierwotna 5',
  city: 'Gdańsk', postal_code: '80-001', country: 'PL', phone: '+48123456789' });
const delivery = Object.freeze({ ...original, recipient_name: 'Operacyjny odbiorca po korekcie',
  street: 'Nowa 12/3', city: 'Łódź', postal_code: '90-001' });
const canonical = (v: unknown): string => {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v !== null && typeof v === 'object') return '{' + Object.entries(v)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, value]) => JSON.stringify(k) + ':' + canonical(value)).join(',') + '}';
  assert.ok(v === null || ['string', 'number', 'boolean'].includes(typeof v), 'Actual JSON value');
  return JSON.stringify(v);
};
const sha = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
const exact = (a: unknown, b: unknown, message: string) => assert.equal(sha(a), sha(b), message);
const one = (rows: Row[]) => { assert.equal(rows.length, 1, 'One actual compound-owned row'); return rows[0]; };
let app: FastifyInstance | undefined, pool: Pool | undefined;
let providerCalls = 0, fetchCalls = 0, savedFetch: typeof globalThis.fetch | undefined;
const deniedFetch: typeof globalThis.fetch = async () => { ++fetchCalls; throw Error('External fetch forbidden in native invoice166 acceptance'); };

async function guards() {
  assert.ok(pool);
  const row = one((await pool.query(`SELECT packed_label_print_guards() AS packed156,
    buyer_address_guards() AS address166`)).rows);
  assert.deepEqual(row, { packed156: true, address166: true });
  return row;
}
before(async () => {
  assert.equal(process.env.DYNA_TEST, 'true');
  assert.equal(process.env.DYNA_BUYER_ADDRESS_LOCAL_INVOICE_NATIVE, 'true', 'Root authorizes the owned native invoice166 gate');
  const u = new URL(process.env.DATABASE_URL ?? '');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname));
  assert.equal(u.port, '55432'); assert.match(u.pathname, /^\/dynaminds_test_[0-9]{13}$/);
  const path = process.env.DYNA_LOCAL_CONFIG_PATH;
  assert.equal(typeof path, 'string', 'Private config path supplied before app/db imports');
  assert.ok(path && path.startsWith('/'), 'Absolute private config supplied before app/db imports');
  const stat = await lstat(path); assert.ok(stat.isFile() && !stat.isSymbolicLink());
  assert.equal(stat.mode & 0o777, 0o600);
  savedFetch = globalThis.fetch; globalThis.fetch = deniedFetch;
  pool = (await import('../server/db')).pool;
  const required = ['156_packed_label_print', '157_local_invoices', '158_fa3_draft_native',
    '159_b2b_invoice', '166_buyer_address_sidecar'];
  assert.deepEqual((await pool.query('SELECT name FROM migrations WHERE name=ANY($1::text[]) ORDER BY name', [required])).rows,
    [...required].sort().map(name => ({ name })), 'All genuine native families installed by root; test never migrates');
  await guards();
  app = await (await import('../server/app')).buildApp({ logging: false, backgroundWorkersEnabled: false,
    integrationTransport: async () => { ++providerCalls; throw Error('Provider forbidden in native invoice166 acceptance'); } });
});
after(async () => {
  // Close native app before its shared pool. Failure remains terminal, not masked
  // by restoration of the owned global hook or by a successful later closer.
  const closed: PromiseSettledResult<unknown>[] = [];
  try {
    if (app) closed.push(...await Promise.allSettled([app.close()]));
    if (pool) closed.push(...await Promise.allSettled([pool.end()]));
  } finally {
    if (savedFetch) { assert.equal(globalThis.fetch, deniedFetch, 'Only this own fetch hook is restored'); globalThis.fetch = savedFetch; }
  }
  for (const result of closed) assert.equal(result.status, 'fulfilled', 'Owned app/pool closer fulfilled');
  assert.equal(providerCalls, 0); assert.equal(fetchCalls, 0);
  if (pool) { assert.equal(pool.totalCount, 0); assert.equal(pool.idleCount, 0); assert.equal(pool.waitingCount, 0); }
});
async function originalOrder(a: NativeActor, orderId: string) {
  assert.ok(pool);
  return one((await pool.query('SELECT to_jsonb(o) row FROM orders o WHERE(tenant_id,id)=($1,$2)', [a.tenant, orderId])).rows).row;
}
async function projectGraph(a: NativeActor, id: string) {
  assert.ok(pool);
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TimeZone='UTC'");
    const row = one((await c.query(`SELECT to_jsonb(d) project,to_jsonb(p) preview,to_jsonb(r) receipt,
    to_jsonb(s) series,to_jsonb(cmd) command FROM fa3_draft_projects d
    JOIN fa3_draft_previews p ON(p.tenant_id,p.id)=(d.tenant_id,d.preview_id)
    JOIN fa3_draft_receipts r ON(r.tenant_id,r.project_id)=(d.tenant_id,d.id)
    JOIN local_invoice_series s ON(s.tenant_id,s.id)=(p.tenant_id,p.series_id)
    JOIN local_invoice_series_commands cmd ON(cmd.tenant_id,cmd.series_id)=(s.tenant_id,s.id)
    WHERE(d.tenant_id,d.id)=($1,$2)`, [a.tenant, id])).rows);
    await c.query('COMMIT');
    return row;
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  } finally { c.release(); }
}

test('actual corrected delivery166 → paid/pick/scan/pack/DEMO dispatch → issued FV159 retains explicitly approved ORIGINAL buyer', { timeout: 120000 }, async () => {
  assert.ok(app && pool);
  const a = await ordinarySignup(app, 'address166 issued159');
  const product = await a.ok('/products', 'POST', { sku: 'ADR-FV159-' + randomUUID(),
    name: 'Ordinary domestic product166', price: 12300, vat: 23,
    warehouse_id: a.warehouse.id, quantity: 5, location: 'A-01' }, 201);
  const address = { street: original.street, city: original.city, postal_code: original.postal_code,
    country: original.country, phone: original.phone };
  const initial = await a.ok('/orders', 'POST', { source: 'manual', customer_name: original.recipient_name,
    email: a.email, warehouse_id: a.warehouse.id, payment_mode: 'prepaid', currency: 'PLN', address,
    items: [{ product_id: product.id, quantity: 1 }], shipping_cost: 800 }, 201);
  const before = await originalOrder(a, initial.id), originalSourceHash = sha({
    customer_name: before.customer_name, email: before.email, address: before.address, source_snapshot: before.source_snapshot });
  assert.equal(before.status, 'new'); exact(before.address, address, 'Actual original SQL address');
  const unknown = await a.ok('/orders/' + initial.id + '/buyer-address-access');
  assert.equal(unknown.available, true); assert.equal(unknown.delivery_kind, 'unknown');
  assert.equal(unknown.enabled, false);
  await a.ok('/orders/' + initial.id + '/buyer-address-access', 'PATCH', {
    version: unknown.order_version, policy_version: unknown.policy_version, enabled: true,
    delivery_kind: 'address', confirmed_delivery_kind: true });
  async function publicOk(path = '', method: InjectOptions['method'] = 'GET', payload?: Row, status = 200) {
    assert.ok(app);
    const r = await app.inject({ method, url: '/api/public/orders/' + initial.portal_token + '/address' + path,
      payload, remoteAddress: '127.166.159.1' });
    assert.equal(r.statusCode, status, 'Actual native public address response');
    assert.equal(r.headers['cache-control'], 'no-store'); return r.json() as Row;
  }
  const status = await publicOk(); exact(status.delivery, original, 'Original public delivery before correction');
  assert.equal(status.can_edit, true);
  const preview = await publicOk('/previews', 'POST', { client_key: randomUUID(), revision: status.revision, delivery }, 201);
  exact(preview.before, original, 'Native before'); exact(preview.after, delivery, 'Native accepted target');
  const applied = await publicOk('/previews/' + preview.id + '/apply', 'POST', {
    client_key: randomUUID(), scope_hash: preview.scope_hash, confirmed: true, local_only: true }, 201);
  assert.equal(applied.changed, true); exact(applied.delivery, delivery, 'Genuine terminal address receipt');
  exact((await publicOk()).delivery, delivery, 'Actual fresh public effective address');
  const corrected = await originalOrder(a, initial.id);
  assert.equal(BigInt(corrected.version), BigInt(before.version) + 1n);
  assert.equal(sha({ customer_name: corrected.customer_name, email: corrected.email,
    address: corrected.address, source_snapshot: corrected.source_snapshot }), originalSourceHash, 'Original source/billing hash retained');
  const current = await a.ok('/orders/' + initial.id);
  exact(current.effective_delivery.delivery, delivery, 'Actual operator effective delivery differs from invoice buyer');
  exact(current.address, address, 'Order API still exposes original source address');
  const shipped = await paidAndShipped(a, initial.id);
  assert.equal(shipped.status, 'shipped'); assert.equal(shipped.total, 13100);
  const { series } = await sellerSeries(a);
  // This is explicit legal bill-to approval from the ORIGINAL SQL-backed fields,
  // never inferred from the operational override or represented as an autofill.
  const buyer = { kind: 'ordinary_explicit', party: { kind: 'business', name: before.customer_name,
    tax_id: '1234563218', address: { country: before.address.country, line1: before.address.street,
      line2: before.address.postal_code + ' ' + before.address.city } }, confirmed: true };
  const buyerHash = sha(buyer), body = nativePreviewBody(shipped, series, buyer);
  const projectPreview = await a.ok('/b2b-fa3/orders/' + shipped.id + '/previews', 'POST', body, 201);
  exact(projectPreview.draft.buyer, buyer.party, 'Full ORIGINAL fiscal buyer, explicit input');
  assert.deepEqual(projectPreview.draft.source.buyer_basis, { kind: 'ordinary_explicit', confirmed_bill_to_hash: buyerHash });
  assert.notEqual(projectPreview.draft.buyer.address.line1, delivery.street);
  assertFiscalMoney159(projectPreview.draft); assert.equal(projectPreview.draft_hash, hash159(projectPreview.draft));
  const approved = await a.ok('/b2b-fa3/previews/' + projectPreview.id + '/approve', 'POST', {
    client_key: randomUUID(), scope_hash: projectPreview.scope_hash, confirmed: true, project_only: true }, 201);
  assert.equal(approved.project.issued, false); assert.equal(approved.project.ksef_state, 'not_submitted');
  const saved = await projectGraph(a, approved.project.id);
  exact(saved.preview.request, body, 'Native approved request retains actual explicit buyer');
  exact(saved.project.draft, projectPreview.draft, 'Full approved native fiscal project');
  const issueDate = new Date().toISOString().slice(0, 10), previewRequest = { client_key: randomUUID(),
    project_id: approved.project.id, issue_date: issueDate, local_only: true, confirmed_project_snapshot: true };
  const invoicePreview = await a.ok('/b2b-invoices/projects/' + approved.project.id + '/previews', 'POST', previewRequest, 201);
  assert.equal(invoicePreview.can_issue, true); exact(invoicePreview.snapshot.fiscal_snapshot.buyer, buyer.party, 'Original buyer survives actual159 preview');
  const issueRequest = { client_key: randomUUID(), scope_hash: invoicePreview.scope_hash, confirmed: true, local_only: true };
  const issued = await a.ok('/b2b-invoices/previews/' + invoicePreview.id + '/issue', 'POST', issueRequest, 201);
  assert.equal(issued.reused, false); assert.equal(issued.document.mode, 'b2b_invoice'); assert.equal(issued.document.kind, 'invoice');
  assert.match(issued.document.number, /^FV-B2B\//);
  const native = await issuedPrivateGraph159(pool, a.tenant, issued.document.id);
  const basis: IssuedBasis159 = { tenant: a.tenant, actor: a.user, apiKey: null,
    project: saved.project, projectReceipt: saved.receipt, originalPreview: saved.preview,
    series: saved.series, seriesCommand: saved.command, previewRequest, issueRequest,
    sequence: 1, issueDate, paymentMode: 'prepaid' };
  assertIssuedGraph159(basis, native, issued);
  exact(native.document.data.fiscal_snapshot.buyer, buyer.party, 'Actual issued SQL document retains ORIGINAL fiscal buyer');
  assert.equal(sha({ kind: 'ordinary_explicit', party: native.document.data.fiscal_snapshot.buyer, confirmed: true }), buyerHash);
  assert.equal(native.document.data.ksef_state, 'not_submitted'); assert.equal(native.document.data.fiscalized, false);
  const detail = await a.ok('/b2b-invoices/documents/' + issued.document.id);
  exact(detail, { document: issued.document, receipt: issued.receipt }, 'Native public document detail and actual receipt');
  const page = await a.ok('/b2b-invoices/documents?limit=50');
  assert.equal(page.next_cursor, null); exact(page.documents, [issued.document], 'Own issued159 register');
  const print = await a.request('/b2b-invoices/documents/' + issued.document.id + '/print');
  assert.equal(print.statusCode, 200); assert.match(String(print.headers['content-type']), /text\/html/);
  for (const text of [original.recipient_name, original.street, original.city, original.postal_code]) assert.ok(print.body.includes(text), 'Print includes original buyer field');
  for (const text of [delivery.recipient_name, delivery.street, delivery.city]) assert.ok(!print.body.includes(text), 'Print does not substitute operational receiver');
  const replay = await a.ok('/b2b-invoices/previews/' + invoicePreview.id + '/issue', 'POST', issueRequest, 200);
  assert.equal(replay.reused, true); exact(replay.document, issued.document, 'Historical exact replay document');
  exact(replay.receipt, issued.receipt, 'Historical exact replay receipt');
  exact(await issuedPrivateGraph159(pool, a.tenant, issued.document.id), native, 'Every selected private issuance row retained on reads/replay');
  const final = await originalOrder(a, initial.id);
  assert.equal(sha({ customer_name: final.customer_name, email: final.email,
    address: final.address, source_snapshot: final.source_snapshot }), originalSourceHash, 'Original source SQL fields retained after real fulfillment and invoice');
  exact((await a.ok('/orders/' + initial.id)).effective_delivery.delivery, delivery, 'Operational delivery still distinct after issue');
  await guards();
});
