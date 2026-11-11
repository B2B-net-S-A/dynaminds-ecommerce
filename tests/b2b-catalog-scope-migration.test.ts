import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';

// No runtime module is imported before DATABASE_URL selects the owned database.
assert.equal(process.env.DYNA_TEST, 'true');
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalUrl = new URL(originalDatabaseUrl ?? '');
assert(['127.0.0.1', 'localhost', '[::1]'].includes(originalUrl.hostname));
assert.match(originalUrl.pathname, /^\/dynaminds_test_\d+$/);
const server = new URL('../server/', import.meta.url);
const privateTables = [
  'b2b_supplier_catalog_scopes', 'b2b_buyer_catalog_scopes',
  'b2b_catalog_scope_previews', 'b2b_catalog_scope_operations',
  'b2b_catalog_scope_admissions', 'b2b_catalog_bindings',
] as const;
type Manifest = Record<string, { columns: string[]; rows: any[] }>;
function identifier(value: string) {
  assert.match(value, /^[a-z_][a-z0-9_]*$/);
  return '"' + value + '"';
}
async function data(c: pg.Client): Promise<Manifest> {
  const result: Manifest = {};
  const tables = (await c.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1")).rows;
  for (const { table_name: name } of tables) {
    const columns = (await c.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position", [name])).rows.map(row => row.column_name as string);
    result[name] = { columns, rows: (await c.query(`SELECT to_jsonb(q) row FROM ${identifier(name)} q ORDER BY 1`)).rows };
  }
  return result;
}
async function retainedData(c: pg.Client, before: Manifest) {
  for (const [name, old] of Object.entries(before)) {
    const columns = (await c.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position", [name])).rows.map(row => row.column_name);
    const expected = name === 'b2b_catalog_runs' ? [...old.columns, 'catalog_scope', 'catalog_scope_hash', 'api_key_id'] : old.columns;
    assert.deepEqual(columns, expected, 'Only declared additive columns: ' + name);
    const rows = (await c.query(`SELECT to_jsonb(q) row FROM (SELECT ${old.columns.map(identifier).join(',')} FROM ${identifier(name)}) q ORDER BY 1`)).rows;
    assert.deepEqual(rows, old.rows, 'Every historical column and row retained: ' + name);
  }
}
async function oldMetadata(c: pg.Client) {
  return {
    relations: (await c.query("SELECT oid::text,relname,relkind,relowner::regrole::text owner,relacl::text,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN('r','p','i','S') ORDER BY oid")).rows,
    functions: (await c.query("SELECT oid::text,proname,pg_get_function_identity_arguments(oid) arguments,proowner::regrole::text owner,proacl::text,pg_get_functiondef(oid) definition FROM pg_proc WHERE pronamespace='public'::regnamespace AND prokind='f' ORDER BY oid")).rows,
    policies: (await c.query("SELECT to_jsonb(p) row FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid WHERE c.relnamespace='public'::regnamespace ORDER BY p.oid")).rows,
    triggers: (await c.query("SELECT to_jsonb(t) row FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace ORDER BY t.oid")).rows,
  };
}
async function retainedMetadata(c: pg.Client, before: Awaited<ReturnType<typeof oldMetadata>>) {
  const after = await oldMetadata(c);
  for (const name of ['relations', 'functions', 'policies', 'triggers'] as const) {
    const prior = before[name], current = after[name];
    const id = (row: any) => row.oid ?? row.row.oid;
    const byId = new Map(current.map(row => [String(id(row)), row]));
    for (const row of prior) assert.deepEqual(byId.get(String(id(row))), row, 'Old OID/owner/ACL/definition preserved: ' + name + ':' + id(row));
  }
}
async function deniedAsApp(c: pg.Client, tenant: string, statement: string) {
  await c.query('BEGIN');
  try {
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
    await assert.rejects(c.query(statement), (error: any) => error.code === '42501');
  } finally { await c.query('ROLLBACK'); }
}

test('actual143→144 preserves every old row/OID/ACL and a genuine queued B2B run; new scope evidence stays empty/private', async () => {
  const name = originalUrl.pathname.slice(1) + '_b2b_' + randomUUID().replaceAll('-', '').slice(0, 12);
  assert.match(name, /^dynaminds_test_\d+_b2b_[a-f0-9]{12}$/);
  const scratchUrl = new URL(originalUrl); scratchUrl.pathname = '/' + name;
  const admin = new pg.Client({ connectionString: originalUrl.href });
  const c = new pg.Client({ connectionString: scratchUrl.href });
  let created = false, connected = false, app: FastifyInstance | undefined, runtimePool: pg.Pool | undefined;
  let providerCalls = 0;
  try {
    await admin.connect(); await admin.query(`CREATE DATABASE "${name}"`); created = true;
    await c.connect(); connected = true; await c.query("SET TimeZone='UTC'");
    const dbSource = await readFile(new URL('db.ts', server), 'utf8');
    const section = dbSource.slice(dbSource.indexOf('for (const [name, file] of ['));
    assert(section.startsWith('for (const [name, file] of ['));
    const migrations = [...section.matchAll(/\[\s*'(\d{3}_[a-z0-9_]+)'\s*,\s*'\.\/([a-z0-9_-]+\.sql)'\s*,?\s*\]/g)]
      .map(match => ({ name: match[1], file: match[2] })).filter(migration => Number(migration.name.slice(0, 3)) <= 143);
    assert.equal(migrations.length, 143); assert.equal(migrations[0].name, '001_foundation');
    assert.equal(migrations.at(-1)?.name, '143_catalog_export_catalogs');
    for (const migration of migrations) {
      await c.query('BEGIN');
      try {
        await c.query(await readFile(new URL(migration.file, server), 'utf8'));
        if (migration.name === '092_wms_stocktakes') await c.query(await readFile(new URL('wms-stocktake-invariants.sql', server), 'utf8'));
        if (migration.name === '108_b2b_dropshipping') await c.query(await readFile(new URL('108_b2b_dropship_dispatch.sql', server), 'utf8'));
        await c.query('INSERT INTO migrations(name) VALUES($1)', [migration.name]);
        await c.query('COMMIT');
      } catch (error) { await c.query('ROLLBACK'); throw error; }
    }
    process.env.DATABASE_URL = scratchUrl.href;
    const db = await import('../server/db'); runtimePool = db.pool;
    // Calling migrate() here would accidentally apply a future registered144.
    const { seed } = await import('./fixtures'); await seed();
    const { buildApp } = await import('../server/app');
    app = await buildApp({ backgroundWorkersEnabled: false, integrationTransport: async () => { providerCalls++; throw new Error('Migration fixture forbids external transport'); } });
    const { productCatalogFixture } = await import('./product-catalogs-fixture');
    const supplier = await productCatalogFixture(app), buyer = await productCatalogFixture(app);
    await supplier.ok('/price-lists/' + supplier.list.id + '/items', 'PUT', {
      version: supplier.list.version, items: [{ product_id: supplier.product.id, price: 700 }],
    });
    const accountBody = { name: 'Own pre144 buyer', email: randomUUID() + '@example.test', warehouse_id: supplier.warehouse,
      price_list_id: supplier.list.id, payment_mode: 'prepaid', address: { street: 'Migration 159', city: 'Warszawa', postal_code: '00-159', country: 'PL' } };
    const born = await supplier.ok('/b2b/accounts', 'POST', accountBody, 201);
    const account = await supplier.ok('/b2b/accounts/' + born.id, 'PATCH', { ...accountBody, version: born.version, active: true, confirmed: true });
    const invite = await supplier.ok('/b2b/accounts/' + account.id + '/network-invite', 'POST', { version: account.version, recipient_email: 'admin@demo.local', confirmed: true });
    const link = await buyer.ok('/b2b/network/accept', 'POST', { token: invite.token, confirmed: true });
    const run = await buyer.ok('/b2b/network/links/' + link.id + '/refresh', 'POST', { client_key: randomUUID(), confirmed: true });
    assert.equal(run.state, 'queued');
    const oldRun = (await c.query('SELECT * FROM b2b_catalog_runs WHERE tenant_id=$1 AND id=$2', [buyer.tenant, run.id])).rows[0];
    assert(oldRun?.job_id); assert.equal(oldRun.link_id, link.id); assert.equal(oldRun.actor_id, buyer.user);
    const job = (await c.query('SELECT * FROM jobs WHERE tenant_id=$1 AND id=$2', [buyer.tenant, oldRun.job_id])).rows[0];
    assert.equal(job.state, 'pending'); assert.equal(job.kind, 'b2b.catalog'); assert.equal(job.payload.run_id, run.id);
    assert.equal(job.payload.link_id, link.id); assert.equal(job.lease_token, null);
    assert.equal(providerCalls, 0);
    await app.close(); app = undefined; // No worker, session or API change during comparison.
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const before = await data(c), metadata = await oldMetadata(c);
    await c.query('COMMIT');
    for (const table of privateTables) assert.equal(before[table], undefined);
    assert(before.b2b_catalog_runs.rows.some(row => row.row.id === run.id));
    assert(before.b2b_accounts.rows.length > 0 && before.b2b_links.rows.length > 0);
    assert(before.price_list_items.rows.length > 0 && before.return_cases.rows.length > 0);
    await c.query('BEGIN');
    try {
      await c.query(await readFile(new URL('144_b2b_catalog_scopes.sql', server), 'utf8'));
      // This test applies SQL once. It does not rewrite the old migrations ledger.
      await c.query('SET CONSTRAINTS ALL IMMEDIATE'); await c.query('COMMIT');
    } catch (error) { await c.query('ROLLBACK'); throw error; }
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await retainedData(c, before); await retainedMetadata(c, metadata);
    const after = await data(c);
    assert.deepEqual(Object.keys(after).filter(table => !before[table]).sort(), [...privateTables].sort());
    for (const row of after.b2b_catalog_runs.rows) {
      assert.equal(row.row.catalog_scope, null); assert.equal(row.row.catalog_scope_hash, null); assert.equal(row.row.api_key_id, null);
    }
    assert.equal((await c.query('SELECT state FROM b2b_catalog_runs WHERE id=$1', [run.id])).rows[0].state, 'queued');
    assert.equal((await c.query('SELECT state FROM jobs WHERE id=$1', [oldRun.job_id])).rows[0].state, 'pending');
    assert.equal((await c.query('SELECT public.b2b_catalog_scope_installed() installed,public.b2b_catalog_scope_guards() guards')).rows[0].installed, true);
    assert.equal((await c.query('SELECT public.b2b_catalog_scope_guards() guards')).rows[0].guards, true);
    for (const table of privateTables) {
      assert.deepEqual(after[table].rows, [], 'No scope, preview, admission or replay receipt is backfilled');
      const safety = (await c.query("SELECT relrowsecurity,relforcerowsecurity,has_table_privilege('dyna_app',oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') app_table,has_any_column_privilege('dyna_app',oid,'SELECT,INSERT,UPDATE') app_column,EXISTS(SELECT 1 FROM aclexplode(coalesce(relacl,acldefault('r',relowner))) a WHERE a.grantee=0) public_grant FROM pg_class WHERE oid=$1::regclass", [table])).rows[0];
      assert.deepEqual(safety, { relrowsecurity: true, relforcerowsecurity: true, app_table: false, app_column: false, public_grant: false });
      assert.equal((await c.query('SELECT count(*)::int n FROM pg_constraint WHERE conrelid=$1::regclass AND NOT convalidated', [table])).rows[0].n, 0);
      assert.equal((await c.query("SELECT count(*)::int n FROM pg_attribute a,LATERAL aclexplode(a.attacl) x WHERE a.attrelid=$1::regclass AND NOT a.attisdropped AND x.grantee=0", [table])).rows[0].n, 0);
    }
    const functions = (await c.query("SELECT p.oid::text,p.proname,has_function_privilege('dyna_app',p.oid,'EXECUTE') app,EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') public FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'b2b_catalog_scope_%' ORDER BY p.oid")).rows;
    assert(functions.length > 0);
    for (const fn of functions) { assert.equal(fn.app, false, fn.proname); assert.equal(fn.public, false, fn.proname); }
    await c.query('COMMIT');
    // Actual denied statements, beyond inspecting a manifest boolean.
    for (const table of privateTables) {
      await deniedAsApp(c, buyer.tenant, `SELECT * FROM ${identifier(table)} LIMIT 1`);
      await deniedAsApp(c, buyer.tenant, `INSERT INTO ${identifier(table)} DEFAULT VALUES`);
      await deniedAsApp(c, buyer.tenant, `UPDATE ${identifier(table)} SET tenant_id=tenant_id WHERE false`);
      await deniedAsApp(c, buyer.tenant, `DELETE FROM ${identifier(table)} WHERE false`);
    }
    await deniedAsApp(c, buyer.tenant, 'SELECT public.b2b_catalog_scope_installed()');
    await deniedAsApp(c, buyer.tenant, `SELECT public.b2b_catalog_scope_preview('${buyer.user}'::uuid,NULL,'buyer','${link.id}'::uuid,'{}'::jsonb)`);
    await retainedData(c, before); assert.equal(providerCalls, 0);
  } finally {
    try { await app?.close(); } finally {
      try { await runtimePool?.end(); } finally {
        try { if (connected) await c.end(); } finally {
          try {
            if (created) {
              await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [name]);
              await admin.query(`DROP DATABASE "${name}"`);
            }
          } finally {
            try { await admin.end(); } finally {
              if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
              else process.env.DATABASE_URL = originalDatabaseUrl;
            }
          }
        }
      }
    }
  }
});
