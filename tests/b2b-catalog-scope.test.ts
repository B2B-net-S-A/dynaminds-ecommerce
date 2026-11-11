import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { seed } from './fixtures';
import { productCatalogFixture, productCatalogFacts, productCatalogCreate, productCatalogConsent } from './product-catalogs-fixture';
import * as S from '../server/b2b-catalog-scope';
import * as V from '../server/b2b-catalog-scope-schema';

assert.equal(process.env.DYNA_TEST, 'true');
const db = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(db.hostname));
assert.match(db.pathname, /^\/dynaminds_test_\d+$/);
let app: Awaited<ReturnType<typeof buildApp>>;
let providerCalls = 0;
before(async () => {
  await migrate(); await seed();
  // Exercise the ordinary registered migration path, including144 exactly once.
  assert((await pool.query("SELECT 1 FROM migrations WHERE name='144_b2b_catalog_scopes'")).rowCount);
  app = await buildApp({ integrationTransport: async () => { providerCalls++; throw new Error('No B2B scope transport'); } });
});
after(async () => { try { await app?.close(); } finally { await pool.end(); } });
async function fixture() {
  const f = await productCatalogFixture(app);
  const p = (await f.ok('/product-catalogs/previews', 'POST', productCatalogCreate(f), 201)).preview;
  const selected = (await f.ok('/product-catalogs/previews/' + p.id + '/commit', 'POST', productCatalogConsent(p), 201)).catalog;
  const body = { name: 'Own B2B scope account', email: randomUUID() + '@example.test', warehouse_id: f.warehouse, price_list_id: f.list.id,
    address: { street: 'Own fixture 159', city: 'Warszawa', postal_code: '00-159', country: 'PL' }, payment_mode: 'prepaid' };
  const account = await f.ok('/b2b/accounts', 'POST', body, 201);
  const previewInput = { client_key: randomUUID(), account_version: String(account.version), catalog_id: selected.id, catalog_version: selected.version,
    warehouse_id: f.spare.id, price_list_id: f.list.id, language: 'pl' };
  return { ...f, selected, account, accountBody: body, previewInput };
}
const consent = (p: any) => ({ client_key: randomUUID(), scope_hash: p.scope_hash, confirmed: true });
const status = (code: number) => (error: any) => error.status === code;
function nonConfiguration(rows: Record<string, any[]>) {
  return Object.fromEntries(Object.entries(rows).filter(([name]) => !['b2b_accounts', 'b2b_links', 'audit_events'].includes(name) && !name.startsWith('b2b_catalog_scope_') && !['b2b_supplier_catalog_scopes', 'b2b_buyer_catalog_scopes'].includes(name)));
}
function privateFree(value: unknown) {
  const visit = (v: any): void => {
    if (!v || typeof v !== 'object') return;
    for (const [key, item] of Object.entries(v)) {
      assert(!['tenant_id', 'supplier_tenant_id', 'actor_id', 'api_key_id', 'request_hash', 'txid', 'password_hash', 'invite_hash', 'admission'].includes(key)); visit(item);
    }
  }; visit(value);
}

test('first supplier configuration changes only explicit config and immutable evidence; exact retries preserve all rows', async () => {
  const f = await fixture(), original = await productCatalogFacts(f.tenant);
  assert.equal(await S.b2bCatalogScopeAvailable(), true);
  const options = await S.b2bCatalogScopeOptions(f.actor, 'supplier', f.account.id);
  assert.equal(options.can_preview, true); assert.equal(options.scope, null); privateFree(options);
  const reply = await S.previewB2BSupplierCatalogScope(f.actor, f.account.id, f.previewInput), p = reply.preview;
  assert.equal(reply.reused, false); assert.equal(p.kind, 'supplier'); assert.equal(p.snapshot.catalog.id, f.selected.id);
  assert.equal(p.snapshot.before.warehouse_id, f.warehouse); assert.equal(p.snapshot.resources.warehouse.id, f.spare.id); privateFree(reply);
  const afterPreview = await productCatalogFacts(f.tenant);
  const pr = await S.previewB2BSupplierCatalogScope(f.actor, f.account.id, f.previewInput);
  assert.equal(pr.reused, true); assert.deepEqual(pr.preview, p); assert.deepEqual(await productCatalogFacts(f.tenant), afterPreview);
  const body = consent(p), result = await S.commitB2BCatalogScope(f.actor, p.id, body);
  assert.equal(result.scope.catalog_id, f.selected.id); assert.equal(result.scope.version, '1'); assert.equal(result.operation.after.version, String(f.account.version + 1));
  assert.equal(result.operation.after.warehouse_id, f.spare.id); assert.equal(result.operation.after.active, f.account.active); privateFree(result);
  const accepted = await productCatalogFacts(f.tenant);
  assert.deepEqual(nonConfiguration(accepted), nonConfiguration(original));
  const accountAfter = accepted.b2b_accounts.find(entry => entry.row.id === f.account.id)!.row;
  assert.deepEqual(accepted.b2b_accounts, original.b2b_accounts.map(entry => entry.row.id === f.account.id
    ? { row: { ...entry.row, warehouse_id: f.spare.id, price_list_id: f.list.id, version: f.account.version + 1, updated_at: accountAfter.updated_at } } : entry));
  assert(Date.parse(accountAfter.updated_at) >= Date.parse(original.b2b_accounts.find(entry => entry.row.id === f.account.id)!.row.updated_at));
  assert.deepEqual(accepted.b2b_links, original.b2b_links);
  const replay = await S.commitB2BCatalogScope(f.actor, p.id, body);
  assert.equal(replay.reused, true); assert.deepEqual(replay.operation, result.operation); assert.deepEqual(await productCatalogFacts(f.tenant), accepted);
  await assert.rejects(S.commitB2BCatalogScope(f.actor, p.id, { ...body, scope_hash: '0'.repeat(64) }), status(409));
  await assert.rejects(S.commitB2BCatalogScope(f.actor, p.id, consent(p)), status(409));
  await assert.rejects(S.previewB2BSupplierCatalogScope(f.actor, f.account.id, { ...f.previewInput, client_key: randomUUID(), account_version: result.operation.after.version }), status(409));
  const history = await S.b2bCatalogScopeHistory(f.actor, 'supplier', f.account.id, { kind: 'operation', limit: 1 });
  assert.equal(history.data.length, 1); assert.equal(history.next_cursor, null); assert.equal(history.data[0].id, result.operation.id); assert.equal(Object.hasOwn(history.data[0], 'snapshot'), false);
  assert.deepEqual((await S.b2bCatalogScopeOperation(f.actor, result.operation.id)).operation, result.operation);
  assert.equal((await S.b2bCatalogScopePreview(f.actor, p.id)).preview.can_commit, false);
  assert.deepEqual(await productCatalogFacts(f.tenant), accepted); assert.equal(providerCalls, 0);
});

test('foreign/unassigned/stale inputs and malformed consent roll back exactly; readonly rejects before parsing', async () => {
  const f = await fixture(), other = await fixture(), original = await productCatalogFacts(f.tenant);
  await assert.rejects(S.previewB2BSupplierCatalogScope(f.actor, other.account.id, f.previewInput), status(404));
  for (const extra of [{ catalog_id: other.selected.id }, { warehouse_id: f.warehouse }, { price_list_id: other.list.id }, { language: 'zz' }, { account_version: '99' }]) {
    await assert.rejects(S.previewB2BSupplierCatalogScope(f.actor, f.account.id, { ...f.previewInput, client_key: randomUUID(), ...extra }), status(409));
  }
  assert.equal(V.b2bSupplierCatalogScopePreviewInput.safeParse({ ...f.previewInput, account_version: 'abc' }).success, false);
  assert.equal(V.b2bSupplierCatalogScopePreviewInput.safeParse({ ...f.previewInput, supplier_tenant_id: other.tenant }).success, false);
  assert.equal(V.b2bCatalogScopeSelectedInput.safeParse([f.product.id, f.product.id.toUpperCase()]).success, false);
  await assert.rejects(S.previewB2BSupplierCatalogScope(f.actor, f.account.id, null, { readOnly: true }), status(423));
  await assert.rejects(S.commitB2BCatalogScope(f.actor, randomUUID(), null, { readOnly: true }), status(423));
  const ro = await S.b2bCatalogScopeOptions(f.actor, 'supplier', f.account.id, { readOnly: true }); assert.equal(ro.can_manage, false); assert.equal(ro.can_preview, false);
  assert.deepEqual(await productCatalogFacts(f.tenant), original);
  const p = (await S.previewB2BSupplierCatalogScope(f.actor, f.account.id, f.previewInput)).preview;
  await f.ok('/b2b/accounts/' + f.account.id, 'PATCH', { ...f.accountBody, version: f.account.version, active: false, confirmed: true });
  const changed = await productCatalogFacts(f.tenant);
  await assert.rejects(S.commitB2BCatalogScope(f.actor, p.id, consent(p)), status(409));
  assert.deepEqual(await productCatalogFacts(f.tenant), changed);
});

test('API key is actor/body-bound; read metadata is redacted and current role controls flags', async () => {
  const f = await fixture();
  const read = await f.ok('/developer/keys', 'POST', { name: 'Own B2B products reader', scopes: ['products:read'] }, 201);
  const scopes = ['products:read', 'products:write', 'inventory:read'];
  const first = await f.ok('/developer/keys', 'POST', { name: 'Own B2B config one', scopes }, 201);
  const second = await f.ok('/developer/keys', 'POST', { name: 'Own B2B config two', scopes }, 201);
  const keyActor = { ...f.actor, apiKeyId: first.id }, otherActor = { ...f.actor, apiKeyId: second.id };
  const reader = { ...f.actor, apiKeyId: read.id };
  const options = await S.b2bCatalogScopeOptions(reader, 'supplier', f.account.id);
  assert.equal(options.can_manage, false); assert.equal(options.can_read_inventory, false); assert.equal(options.source.account.warehouse_id, null); assert.deepEqual(options.resources.warehouses, []);
  for (const c of options.resources.catalogs) assert.deepEqual(c.warehouse_ids, []);
  const p = (await S.previewB2BSupplierCatalogScope(keyActor, f.account.id, f.previewInput)).preview, before = await productCatalogFacts(f.tenant);
  await assert.rejects(S.commitB2BCatalogScope(otherActor, p.id, consent(p)), status(409));
  assert.deepEqual(await productCatalogFacts(f.tenant), before);
  const restricted = await S.b2bCatalogScopePreview(reader, p.id); assert.equal(restricted.preview.request.warehouse_id, null); assert.equal(restricted.preview.snapshot.resources.warehouse, null); privateFree(restricted);
  await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [f.tenant, f.user]);
  const changed = await productCatalogFacts(f.tenant);
  try {
    const viewer = await S.b2bCatalogScopePreview(f.actor, p.id); assert.equal(viewer.can_manage, false); assert.equal(viewer.preview.can_commit, false);
    // Migration013 revokes this user's keys on a role change. A revoked key is
    // genuinely401; the current cookie principal separately exercises403.
    const key = changed.api_keys.find(entry => entry.row.id === first.id)?.row;
    assert(key?.revoked_at, 'Actual membership role trigger must revoke the existing API key');
    await assert.rejects(S.commitB2BCatalogScope(keyActor, p.id, consent(p)), status(401));
    await assert.rejects(S.commitB2BCatalogScope(f.actor, p.id, consent(p)), status(403));
    assert.deepEqual(await productCatalogFacts(f.tenant), changed);
  } finally { await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [f.tenant, f.user]); }
});

test('terminal fresh IAM waits after genuine config hydration and rolls back the entire accepted graph', async () => {
  const f = await fixture(), p = (await S.previewB2BSupplierCatalogScope(f.actor, f.account.id, f.previewInput)).preview;
  const before = await productCatalogFacts(f.tenant), holder = await pool.connect(); let outcome: Promise<void> | undefined;
  try {
    await holder.query('BEGIN'); const pid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    await holder.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [f.tenant, f.user]);
    outcome = assert.rejects(S.commitB2BCatalogScope(f.actor, p.id, consent(p)), status(403));
    let blocked = false;
    for (let i = 0; i < 250; i++) {
      const waits = await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE 'SELECT role FROM memberships%FOR SHARE'", [pid]);
      if (waits.rowCount) { blocked = true; break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert(blocked, 'Real terminal IAM row wait must be proved, not scheduled by a sleep');
    await holder.query('COMMIT'); await outcome;
    const after = await productCatalogFacts(f.tenant);
    const expected: Awaited<ReturnType<typeof productCatalogFacts>> = { ...before, memberships: before.memberships.map(entry => entry.row.user_id === f.user ? { row: { ...entry.row, role: 'viewer' } } : entry) };
    assert.deepEqual(after, expected);
    assert.equal(after.b2b_catalog_scope_operations.length, 0); assert.equal(after.b2b_supplier_catalog_scopes.length, 0);
  } finally {
    await holder.query('ROLLBACK'); holder.release();
    if (outcome) await outcome;
    await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [f.tenant, f.user]);
  }
});

test('buyer scope derives supplier only from a genuine persisted invitation/link and preserves scheduling', async () => {
  const supplier = await fixture(), buyer = await fixture();
  const activated = await supplier.ok('/b2b/accounts/' + supplier.account.id, 'PATCH', { ...supplier.accountBody, version: supplier.account.version, active: true, confirmed: true });
  const invite = await supplier.ok('/b2b/accounts/' + supplier.account.id + '/network-invite', 'POST', { version: activated.version, recipient_email: 'admin@demo.local', confirmed: true });
  const link = await buyer.ok('/b2b/network/accept', 'POST', { token: invite.token, confirmed: true });
  const body = { client_key: randomUUID(), link_version: String(link.version), target_catalog_id: buyer.selected.id, target_catalog_version: buyer.selected.version };
  const original = await productCatalogFacts(buyer.tenant), originalSupplier = await productCatalogFacts(supplier.tenant);
  const p = (await S.previewB2BBuyerCatalogScope(buyer.actor, link.id, body)).preview; privateFree(p);
  assert.equal(p.snapshot.resources.supplier.account_id, supplier.account.id);
  const result = await S.commitB2BCatalogScope(buyer.actor, p.id, consent(p)); privateFree(result);
  assert.equal(result.scope.target_catalog_id, buyer.selected.id); assert.equal(result.operation.after.version, String(link.version + 1));
  assert.equal(result.operation.after.paused, link.paused); assert.equal(result.operation.after.schedule_minutes, link.schedule_minutes);
  const accepted = await productCatalogFacts(buyer.tenant);
  assert.deepEqual(nonConfiguration(accepted), nonConfiguration(original));
  assert.deepEqual(accepted.b2b_accounts, original.b2b_accounts);
  assert.deepEqual(accepted.b2b_links, original.b2b_links.map(entry => entry.row.id === link.id ? { row: { ...entry.row, version: link.version + 1 } } : entry));
  assert.deepEqual(await productCatalogFacts(supplier.tenant), originalSupplier); assert.equal(providerCalls, 0);
});

test('private tables and issuers remain inaccessible to app; disabled proof guard fails closed in a rolled-back owner transaction', async () => {
  const f = await fixture(), before = await productCatalogFacts(f.tenant);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('ALTER TABLE b2b_catalog_scope_admissions DISABLE TRIGGER b2b_catalog_scope_admission_complete');
    await assert.rejects(S.b2bCatalogScopeAvailable(c), status(503));
    await c.query('ROLLBACK');
    await c.query('BEGIN');
    await c.query('ALTER TABLE b2b_catalog_scope_previews RENAME COLUMN expires_at TO qa159_hidden_expiry');
    await assert.rejects(S.b2bCatalogScopeAvailable(c), status(503));
    await c.query('ROLLBACK');
    for (const name of ['b2b_supplier_catalog_scopes', 'b2b_buyer_catalog_scopes', 'b2b_catalog_scope_previews', 'b2b_catalog_scope_operations', 'b2b_catalog_scope_admissions']) {
      await c.query('BEGIN'); await c.query('SET LOCAL ROLE dyna_app'); await c.query("SELECT set_config('app.tenant_id',$1,true)", [f.tenant]);
      await assert.rejects(c.query(`SELECT * FROM ${name}`), (error: any) => error.code === '42501'); await c.query('ROLLBACK');
    }
    await c.query('BEGIN'); await c.query('SET LOCAL ROLE dyna_app'); await c.query("SELECT set_config('app.tenant_id',$1,true)", [f.tenant]);
    await assert.rejects(c.query('SELECT public.b2b_catalog_scope_preview($1,NULL,$2,$3,$4::jsonb)', [f.user, 'supplier', f.account.id, JSON.stringify(f.previewInput)]), (error: any) => error.code === '42501');
    await c.query('ROLLBACK'); assert.equal(await S.b2bCatalogScopeAvailable(c), true);
  } finally { await c.query('ROLLBACK'); c.release(); }
  assert.deepEqual(await productCatalogFacts(f.tenant), before);
});
