import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { seed } from './fixtures';
import { productCatalogFixture, productCatalogFacts, productCatalogCreate, productCatalogConsent } from './product-catalogs-fixture';

// Root-only disposable PostgreSQL gate. TODOs are executed security expectations,
// not current acceptance: all raw business mutations are unconditionally rolled back.
assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/dynaminds_test_\d+$/);
let app: Awaited<ReturnType<typeof buildApp>>;
before(async () => {
  await migrate(); await seed();
  app = await buildApp({ integrationTransport: async () => { throw Error('Raw catalog safety tests cannot call providers'); } });
});
after(async () => { try { await app?.close(); } finally { await pool.end(); } });

async function raw(tenant: string) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL statement_timeout='8s'");
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
    assert.equal((await c.query('SELECT current_user r')).rows[0].r, 'dyna_app');
    return c;
  } catch (error) { await c.query('ROLLBACK').catch(() => {}); c.release(); throw error; }
}
async function rollback(c: PoolClient) { await c.query('ROLLBACK').catch(() => {}); c.release(); }
const denied = (code: string, message: string) => (error: any) => error.code === code && error.message === message;
async function write(c: PoolClient, uid: string, kid: string | null, step: 'preview' | 'commit', preview: string | null, body: any) {
  return (await c.query('SELECT product_catalog_write($1,$2,$3,$4,$5::jsonb) result', [uid, kid, step, preview, JSON.stringify(body)])).rows[0].result;
}
async function genuinePreview(f: any, key?: any) {
  return (await f.ok('/product-catalogs/previews', 'POST', productCatalogCreate(f), 201, key)).preview;
}
async function waitingFor(waiterPid: number, blocker: PoolClient, query: RegExp) {
  assert.equal(typeof waiterPid, 'number');
  const blockerPid = (await blocker.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const row = (await pool.query('SELECT query,$2::int=ANY(pg_blocking_pids(pid)) blocked FROM pg_stat_activity WHERE pid=$1', [waiterPid, blockerPid])).rows[0];
    if (row?.blocked && query.test(row.query)) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('The tested SQL must actually wait on the identified IAM row holder');
}

test('raw typed writes deny a foreign actor, a foreign workspace and an actor/key mismatch without changing either firm', async () => {
  const a = await productCatalogFixture(app);
  // The shared commerce fixture deliberately reuses seeded admin@demo.local.
  // A real signup is required here; a second commerce fixture is not a foreign UID.
  const signup = await app.inject({ url: '/api/auth/signup', method: 'POST', remoteAddress: '127.157.9.1',
    payload: { email: 'catalog-sql-' + randomUUID() + '@example.test', name: 'Own distinct catalog actor',
      password: 'OwnCatalogSql!157Safe', organization: { name: 'Own distinct catalog boundary firm' } } });
  assert.equal(signup.statusCode, 201, 'The foreign principal must be a genuinely registered account');
  const registered = signup.json().user, b = { tenant: registered.tenant_id as string, user: registered.id as string };
  assert.equal(registered.role, 'admin'); assert.notEqual(a.user, b.user); assert.notEqual(a.tenant, b.tenant);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM memberships
    WHERE (tenant_id,user_id) IN (($1::uuid,$2::uuid),($3::uuid,$4::uuid))`,
  [a.tenant, b.user, b.tenant, a.user])).rows[0].n, 0, 'Neither actor may hold the opposite firm membership');
  const keyReply = await app.inject({ url: '/api/developer/keys', method: 'POST', remoteAddress: '127.157.9.1',
    headers: { cookie: String(signup.headers['set-cookie']).split(';')[0] },
    payload: { name: 'Own raw boundary key', scopes: ['products:read', 'products:write'] } });
  assert.equal(keyReply.statusCode, 201, 'The foreign key must be issued to the distinct authenticated account');
  const foreignKey = keyReply.json();
  const beforeA = await productCatalogFacts(a.tenant), beforeB = await productCatalogFacts(b.tenant);
  for (const attempt of [
    { tenant: a.tenant, uid: b.user, kid: null, message: 'Brak aktualnego uprawnienia katalogów' },
    { tenant: b.tenant, uid: a.user, kid: null, message: 'Brak aktualnego uprawnienia katalogów' },
    { tenant: a.tenant, uid: a.user, kid: foreignKey.id, message: 'Klucz katalogów jest nieaktualny' },
  ]) {
    const c = await raw(attempt.tenant);
    try { await assert.rejects(write(c, attempt.uid, attempt.kid, 'preview', null, productCatalogCreate(a)), denied('23514', attempt.message)); }
    finally { await rollback(c); }
  }
  assert.deepEqual(await productCatalogFacts(a.tenant), beforeA);
  assert.deepEqual(await productCatalogFacts(b.tenant), beforeB);
});

test('a valid own raw principal cannot read or consume a genuine other-firm preview', async () => {
  const a = await productCatalogFixture(app), b = await productCatalogFixture(app), p = await genuinePreview(b);
  const beforeA = await productCatalogFacts(a.tenant), beforeB = await productCatalogFacts(b.tenant);
  for (const step of ['read', 'commit']) {
    const c = await raw(a.tenant);
    try {
      await assert.rejects(step === 'read'
        ? c.query("SELECT product_catalog_read($1,NULL,'preview',$2,NULL,50,'{}'::jsonb)", [a.user, p.id])
        : write(c, a.user, null, 'commit', p.id, productCatalogConsent(p)), denied('P0002', 'Brak podglądu katalogu'));
    } finally { await rollback(c); }
  }
  assert.deepEqual(await productCatalogFacts(a.tenant), beforeA);
  assert.deepEqual(await productCatalogFacts(b.tenant), beforeB);
});

test('explicit final PIN really waits on IAM and denies a grant/key withdrawn after genuine graph flush', async () => {
  for (const keyCase of [false, true]) {
    const f = await productCatalogFixture(app);
    const key = keyCase ? await f.ok('/developer/keys', 'POST', { name: 'Own raw final pin key', scopes: ['products:read', 'products:write'] }, 201) : null;
    const p = await genuinePreview(f, key), original = await productCatalogFacts(f.tenant);
    const c = await raw(f.tenant), holder = await pool.connect();
    const waiterPid = Number((await c.query('SELECT pg_backend_pid() pid')).rows[0].pid);
    let pending: Promise<any> | undefined;
    try {
      const result = await write(c, f.user, key?.id ?? null, 'commit', p.id, productCatalogConsent(p));
      assert.equal(result.reused, false);
      await c.query('SET CONSTRAINTS ALL IMMEDIATE');
      await holder.query('BEGIN');
      if (key) await holder.query('UPDATE api_keys SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2', [f.tenant, key.id]);
      else await holder.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [f.tenant, f.user]);
      pending = c.query('SELECT product_catalog_require($1,$2,true,true)', [f.user, key?.id ?? null]);
      void pending.catch(() => {});
      await waitingFor(waiterPid, holder, /product_catalog_require/);
      await holder.query('COMMIT');
      await assert.rejects(pending, denied('23514', key ? 'Klucz katalogów jest nieaktualny' : 'Brak aktualnego uprawnienia katalogów'));
    } finally {
      await holder.query('ROLLBACK').catch(() => {}); holder.release();
      await pending?.catch(() => {});
      await c.query('ROLLBACK').catch(() => {}); c.release();
      if (key) await pool.query('UPDATE api_keys SET revoked_at=NULL WHERE tenant_id=$1 AND id=$2', [f.tenant, key.id]);
      else await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [f.tenant, f.user]);
    }
    assert.deepEqual(await productCatalogFacts(f.tenant), original, 'Denied final PIN rolls back the full typed graph; restored test IAM is exact');
  }
});

test('a successful explicit terminal PIN holds its checked membership until the raw graph is rolled back', async () => {
  const f = await productCatalogFixture(app), p = await genuinePreview(f), original = await productCatalogFacts(f.tenant);
  const c = await raw(f.tenant), revoke = await pool.connect();
  const revocationPid = Number((await revoke.query('SELECT pg_backend_pid() pid')).rows[0].pid);
  let pending: Promise<any> | undefined;
  try {
    await write(c, f.user, null, 'commit', p.id, productCatalogConsent(p));
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    const access = (await c.query('SELECT product_catalog_require($1,NULL,true,true) flags', [f.user])).rows[0].flags;
    assert.equal(access.allowed, true);
    await revoke.query('BEGIN');
    pending = revoke.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [f.tenant, f.user]);
    void pending.catch(() => {});
    await waitingFor(revocationPid, c, /UPDATE memberships/);
    await c.query('ROLLBACK');
    assert.equal((await pending).rowCount, 1);
    await revoke.query('ROLLBACK');
  } finally {
    await c.query('ROLLBACK').catch(() => {}); c.release();
    await pending?.catch(() => {}); await revoke.query('ROLLBACK').catch(() => {}); revoke.release();
  }
  assert.deepEqual(await productCatalogFacts(f.tenant), original);
});

test('shared dyna_app must not fabricate an authenticated own admin solely by supplying that UID', {
  todo: 'OPEN: SQL142 trusts the server-provided UID; no DB session-principal protocol exists',
}, async () => {
  const f = await productCatalogFixture(app), original = await productCatalogFacts(f.tenant), c = await raw(f.tenant);
  try {
    // No invented app.user_id GUC: that is not an established authenticated DB contract.
    assert.equal((await c.query('SELECT product_catalog_access($1,NULL,true,false) flags', [f.user])).rows[0].flags.allowed, true);
    await assert.rejects(write(c, f.user, null, 'preview', null, productCatalogCreate(f)), (error: any) => error.code === '42501');
  } finally { await rollback(c); assert.deepEqual(await productCatalogFacts(f.tenant), original); }
});

test('reflushing an already completed raw graph after grant withdrawal must recheck terminal IAM without caller finalaccess', {
  todo: 'OPEN: complete is unpinned and a second flush has no remaining event; HTTP final PIN is a separate obligation',
}, async () => {
  const f = await productCatalogFixture(app), p = await genuinePreview(f), original = await productCatalogFacts(f.tenant), c = await raw(f.tenant);
  try {
    await write(c, f.user, null, 'commit', p.id, productCatalogConsent(p));
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [f.tenant, f.user]);
    assert.equal((await c.query('SELECT product_catalog_access($1,NULL,true,false) flags', [f.user])).rows[0].flags.allowed, false);
    // An actual second flush demonstrates the empty deferred-event gap. COMMIT
    // is deliberately not executed; this case must leave no persisted catalog.
    await assert.rejects(c.query('SET CONSTRAINTS ALL IMMEDIATE'), denied('23514', 'Brak aktualnego uprawnienia katalogów'));
  } finally {
    await rollback(c);
    await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [f.tenant, f.user]);
    assert.deepEqual(await productCatalogFacts(f.tenant), original);
  }
});
