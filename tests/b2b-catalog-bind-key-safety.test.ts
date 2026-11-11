import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildApp } from '../server/app';
import { pool, migrate } from '../server/db';
import { processB2bCatalog } from '../server/b2b-network';
import { seed } from './fixtures';
import { productCatalogFixture, productCatalogFacts } from './product-catalogs-fixture';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/dynaminds_test_\d+$/);
let app: Awaited<ReturnType<typeof buildApp>>, providerCalls = 0;
const requiredScopes = ['products:read', 'products:write', 'purchasing:read', 'purchasing:write'];
before(async () => {
  await migrate(); await seed();
  assert((await pool.query("SELECT 1 FROM migrations WHERE name='143_catalog_export_catalogs'")).rowCount);
  if (!(await pool.query("SELECT to_regprocedure('public.b2b_catalog_scope_installed()') marker")).rows[0].marker)
    await pool.query(await readFile(resolve('server/144_b2b_catalog_scopes.sql'), 'utf8'));
  app = await buildApp({ backgroundWorkersEnabled: false, integrationTransport: async () => { providerCalls++; throw Error('Key safety forbids provider transport'); } });
});
after(async () => { try { await app?.close(); } finally { await pool.end(); } });

async function fixture() {
  const supplier = await productCatalogFixture(app), buyer = await productCatalogFixture(app);
  assert.equal((await pool.query('SELECT count(*)::int n FROM wms_policies WHERE tenant_id=ANY($1::uuid[]) AND enabled', [[supplier.tenant, buyer.tenant]])).rows[0].n, 0,
    'This case proves the independent OFF terminal network IAM gate');
  await supplier.ok('/price-lists/' + supplier.list.id + '/items', 'PUT', { version: supplier.list.version, items: [{ product_id: supplier.product.id, price: 700 }] });
  const accountBody = { name: 'Own key-bound buyer', email: randomUUID() + '@example.test', warehouse_id: supplier.warehouse,
    price_list_id: supplier.list.id, payment_mode: 'prepaid', address: { street: 'Own159', city: 'Warszawa', postal_code: '00-159', country: 'PL' } };
  const born = await supplier.ok('/b2b/accounts', 'POST', accountBody, 201);
  const account = await supplier.ok('/b2b/accounts/' + born.id, 'PATCH', { ...accountBody, version: born.version, active: true, confirmed: true });
  const invite = await supplier.ok('/b2b/accounts/' + account.id + '/network-invite', 'POST', { version: account.version, recipient_email: 'admin@demo.local', confirmed: true });
  const link = await buyer.ok('/b2b/network/accept', 'POST', { token: invite.token, confirmed: true });
  const run = await buyer.ok('/b2b/network/links/' + link.id + '/refresh', 'POST', { client_key: randomUUID(), confirmed: true });
  const job = (await pool.query("UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$3,locked_at=now() WHERE tenant_id=$1 AND id=$2 AND state='pending' RETURNING *", [buyer.tenant, run.job_id, randomUUID()])).rows[0];
  assert(job); await processB2bCatalog(job);
  const catalog = await buyer.ok('/b2b/network/links/' + link.id + '/catalog');
  assert.equal(catalog.data.length, 1); assert.equal(catalog.data[0].source_product_id, supplier.product.id);
  const item = catalog.data[0], path = '/b2b/network/links/' + link.id + '/catalog/' + item.id + '/bind';
  const key = await buyer.ok('/developer/keys', 'POST', { name: 'Own terminal binding key', scopes: requiredScopes }, 201);
  return { supplier, buyer, key, item, path, body: { client_key: randomUUID(), version: item.version, product_id: buyer.product.id, confirmed: true } };
}

test('HTTP bind compound omissions deny; expired and revoked keys cannot adopt a committed exact receipt', async () => {
  const f = await fixture();
  const partials = [];
  for (const missing of requiredScopes) partials.push(await f.buyer.ok('/developer/keys', 'POST', {
    name: 'Own missing ' + missing, scopes: requiredScopes.filter(scope => scope !== missing),
  }, 201));
  const before = await productCatalogFacts(f.buyer.tenant), supplierBefore = await productCatalogFacts(f.supplier.tenant);
  for (const key of partials) {
    const denied = await f.buyer.request(f.path, 'POST', { ...f.body, client_key: randomUUID() }, key);
    assert.equal(denied.statusCode, 403);
  }
  assert.deepEqual(await productCatalogFacts(f.buyer.tenant), before);
  assert.deepEqual(await productCatalogFacts(f.supplier.tenant), supplierBefore);
  const accepted = await f.buyer.ok(f.path, 'POST', f.body, 201, f.key);
  assert.equal(accepted.reused, false); assert.equal(accepted.binding.product_id, f.buyer.product.id);
  const committed = await productCatalogFacts(f.buyer.tenant);
  assert.equal(committed.b2b_catalog_bindings.length, 1);
  assert.deepEqual(committed.stock, before.stock); assert.deepEqual(committed.stock_movements, before.stock_movements);
  const originalExpiry = (await pool.query('SELECT expires_at::text expires_at FROM api_keys WHERE tenant_id=$1 AND id=$2', [f.buyer.tenant, f.key.id])).rows[0].expires_at;
  await pool.query("UPDATE api_keys SET expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND id=$2", [f.buyer.tenant, f.key.id]);
  const expired = await productCatalogFacts(f.buyer.tenant);
  assert.equal((await f.buyer.request(f.path, 'POST', f.body, f.key)).statusCode, 401);
  assert.deepEqual(await productCatalogFacts(f.buyer.tenant), expired);
  // Restore only this test key's expiry to prove the next401 is revocation,
  // rather than the already-expired branch. No application policy is changed.
  await pool.query('UPDATE api_keys SET expires_at=$3 WHERE tenant_id=$1 AND id=$2', [f.buyer.tenant, f.key.id, originalExpiry]);
  const validAgain = await productCatalogFacts(f.buyer.tenant);
  const replay = await f.buyer.ok(f.path, 'POST', f.body, 200, f.key);
  assert.equal(replay.reused, true); assert.deepEqual(replay.binding, accepted.binding);
  assert.deepEqual(await productCatalogFacts(f.buyer.tenant), validAgain);
  await f.buyer.ok('/developer/keys/' + f.key.id, 'DELETE');
  const revoked = await productCatalogFacts(f.buyer.tenant);
  assert(revoked.api_keys.find(row => row.row.id === f.key.id)?.row.revoked_at);
  assert.equal((await f.buyer.request(f.path, 'POST', f.body, f.key)).statusCode, 401);
  assert.deepEqual(await productCatalogFacts(f.buyer.tenant), revoked);
  assert.deepEqual(await productCatalogFacts(f.supplier.tenant), supplierBefore);
  assert.equal(providerCalls, 0);
});

test('HTTP OFF bind reaches real terminal key lock after receipt flush; expiry while waiting rolls back the entire new graph', async () => {
  const f = await fixture(), before = await productCatalogFacts(f.buyer.tenant), supplierBefore = await productCatalogFacts(f.supplier.tenant);
  const holder = await pool.connect(); let response: Promise<Awaited<ReturnType<typeof f.buyer.request>>> | undefined;
  try {
    await holder.query('BEGIN'); await holder.query("SET LOCAL TimeZone='UTC'");
    const pid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    // NO KEY UPDATE allows the new receipt's immediate FK KEY SHARE checks,
    // but conflicts with the genuine terminal IAM FOR SHARE lock.
    assert.equal((await holder.query('SELECT id FROM api_keys WHERE tenant_id=$1 AND id=$2 FOR NO KEY UPDATE', [f.buyer.tenant, f.key.id])).rowCount, 1);
    // Global bearer auth reads the still-valid committed key without a row lock.
    // Only the actual final networkAccess FOR SHARE should block on this holder.
    response = Promise.resolve(f.buyer.request(f.path, 'POST', f.body, f.key));
    let observed = false;
    for (let index = 0; index < 250; index++) {
      const blocked = await pool.query(`SELECT pid FROM pg_stat_activity WHERE datname=current_database()
        AND $1=ANY(pg_blocking_pids(pid))
        AND query LIKE 'SELECT user_id,scopes,revoked_at,expires_at FROM api_keys%FOR SHARE'`, [pid]);
      if (blocked.rowCount) { observed = true; break; }
      await new Promise(resolveWait => setTimeout(resolveWait, 20));
    }
    assert(observed, 'The actual terminal API-key FOR SHARE wait must occur after the bind writer, not an arbitrary timed request');
    assert.deepEqual(await productCatalogFacts(f.buyer.tenant), before, 'Uncommitted binding/item/audit must remain invisible');
    await holder.query("UPDATE api_keys SET expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND id=$2", [f.buyer.tenant, f.key.id]);
    const actualKey = (await holder.query('SELECT to_jsonb(k) row FROM api_keys k WHERE tenant_id=$1 AND id=$2', [f.buyer.tenant, f.key.id])).rows[0];
    await holder.query('COMMIT');
    const denied = await response; assert.equal(denied.statusCode, 401);
    const expected: Record<string, any[]> = { ...before, api_keys: before.api_keys.map(row => row.row.id === f.key.id ? actualKey : row) };
    assert.deepEqual(await productCatalogFacts(f.buyer.tenant), expected, 'Only the independently committed own key expiry may differ');
    assert.deepEqual(await productCatalogFacts(f.supplier.tenant), supplierBefore);
    assert.equal(expected.b2b_catalog_bindings.length, 0);
    assert.equal((await f.buyer.request(f.path, 'POST', f.body, f.key)).statusCode, 401);
    assert.deepEqual(await productCatalogFacts(f.buyer.tenant), expected);
    assert.equal(providerCalls, 0);
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined); holder.release();
    if (response) await response;
  }
});
