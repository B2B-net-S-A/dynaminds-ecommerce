import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

// Root executes this only in its disposable native harness. It builds its own
// historical database; it never removes 142/143 from the shared test database.
assert.equal(process.env.DYNA_TEST, 'true');
const originalUrl = new URL(process.env.DATABASE_URL ?? '');
assert(['127.0.0.1', 'localhost', '[::1]'].includes(originalUrl.hostname));
assert.match(originalUrl.pathname, /^\/dynaminds_test_\d+$/);
const server = new URL('../server/', import.meta.url);
const ident = (value: string) => {
  assert.match(value, /^[a-z_][a-z0-9_]*$/);
  return '"' + value + '"';
};
type Manifest = Record<string, { columns: unknown[]; table: unknown; rows: unknown[] }>;
async function manifest(c: pg.Client): Promise<Manifest> {
  const result: Manifest = {};
  const names = (await c.query(`SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1`)).rows.map(r => r.table_name as string);
  // Includes sessions and the migration ledger: applying the SQL script below
  // does not insert a bookkeeping row, so every preexisting row must be exact.
  for (const name of names) {
    const relation = (await c.query(`SELECT relowner::text owner,relacl::text acl,relrowsecurity,relforcerowsecurity
      FROM pg_class WHERE oid=$1::regclass`, ['public.' + name])).rows[0];
    const columns = (await c.query(`SELECT a.attname,a.atttypid::text type_oid,a.atttypmod,a.attnotnull,
      a.attgenerated,a.attidentity,a.atthasdef,pg_get_expr(d.adbin,d.adrelid) default_expression
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON(d.adrelid,d.adnum)=(a.attrelid,a.attnum)
      WHERE a.attrelid=$1::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`, ['public.' + name])).rows;
    result[name] = { columns, table: relation, rows: (await c.query(`SELECT to_jsonb(q) row FROM public.${ident(name)} q ORDER BY 1`)).rows };
  }
  return result;
}
async function validatorIdentity(c: pg.Client) {
  return (await c.query(`SELECT p.oid::text oid,p.proowner::text owner_oid,r.rolname owner_name,
    p.proacl::text acl,p.prorettype::text return_type,p.proargtypes::text argument_types,
    p.provolatile,p.prosecdef,p.proconfig,
    has_function_privilege('dyna_app',p.oid,'EXECUTE') app_execute,
    (SELECT jsonb_agg(jsonb_build_object('grantor',a.grantor::text,'grantee',a.grantee::text,
       'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY a.grantee,a.grantor,a.privilege_type,a.is_grantable)
     FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a) effective_acl
    FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
    WHERE p.oid='public.catalog_export_profile_definition_valid(jsonb)'::regprocedure`)).rows[0];
}
async function validatorDependencies(c: pg.Client) {
  return (await c.query(`SELECT d.classid::regclass::text object_class,d.objid::text object_oid,d.objsubid,
    d.refclassid::regclass::text referenced_class,d.refobjid::text referenced_oid,d.refobjsubid,d.deptype,
    k.conname,k.conrelid::regclass::text relation,pg_get_constraintdef(k.oid) constraint_definition
    FROM pg_depend d LEFT JOIN pg_constraint k ON d.classid='pg_constraint'::regclass AND k.oid=d.objid
    WHERE d.refclassid='pg_proc'::regclass
      AND d.refobjid='public.catalog_export_profile_definition_valid(jsonb)'::regprocedure
    ORDER BY d.classid,d.objid,d.objsubid,d.refobjsubid,d.deptype`)).rows;
}

test('actual143 preserves all142 rows/columns and the legacy validator OID, owner, ACL and CHECK dependencies', async () => {
  const database = originalUrl.pathname.slice(1) + '_export_' + randomUUID().replaceAll('-', '').slice(0, 12);
  assert.match(database, /^dynaminds_test_\d+_export_[a-f0-9]{12}$/);
  const admin = new pg.Client({ connectionString: originalUrl.href });
  const scratchUrl = new URL(originalUrl); scratchUrl.pathname = '/' + database;
  const c = new pg.Client({ connectionString: scratchUrl.href });
  let created = false, connected = false;
  const ids = { tenant: randomUUID(), user: randomUUID(), warehouse: randomUUID(), product: randomUUID(), list: randomUUID(), profile: randomUUID(), sourceProfile: randomUUID() };
  const legacy = { format: 'csv', columns: ['sku', 'name', 'price_minor'], headers: { name: 'Nazwa produktu' }, spreadsheet_safe: true };
  const legacySources = { format: 'xml', columns: ['sku', 'inventory_json', 'prices_json'], headers: {}, spreadsheet_safe: false, warehouse_ids: [ids.warehouse], price_list_ids: [ids.list] };
  try {
    await admin.connect(); await admin.query(`CREATE DATABASE ${ident(database)}`); created = true;
    await c.connect(); connected = true; await c.query("SET TimeZone='UTC'");
    const source = await readFile(new URL('db.ts', server), 'utf8');
    const section = source.slice(source.indexOf('for (const [name, file] of ['));
    assert(section.startsWith('for (const [name, file] of ['), 'Central historical migration manifest is required');
    const migrations = [...section.matchAll(/\[\s*'(\d{3}_[a-z0-9_]+)'\s*,\s*'\.\/([a-z0-9_-]+\.sql)'\s*,?\s*\]/g)]
      .map(m => ({ name: m[1], file: m[2] })).filter(m => Number(m.name.slice(0, 3)) <= 142);
    assert.equal(migrations.length, 142); assert.equal(migrations[0].name, '001_foundation');
    assert.equal(migrations.at(-1)?.name, '142_product_catalogs');
    assert.equal(new Set(migrations.map(m => m.name)).size, 142);
    for (const migration of migrations) {
      await c.query('BEGIN');
      try {
        await c.query(await readFile(new URL(migration.file, server), 'utf8'));
        if (migration.name === '092_wms_stocktakes') await c.query(await readFile(new URL('wms-stocktake-invariants.sql', server), 'utf8'));
        if (migration.name === '108_b2b_dropshipping') await c.query(await readFile(new URL('108_b2b_dropship_dispatch.sql', server), 'utf8'));
        await c.query('INSERT INTO migrations(name) VALUES($1)', [migration.name]);
        await c.query('COMMIT');
      } catch (e) { await c.query('ROLLBACK'); throw e; }
      if (migration.name === '025_stock_locations') {
        // Explicit synthetic historical owner fixture, born before modern
        // admissions. This is data preservation, not a commerce-flow claim.
        await c.query('BEGIN');
        try {
          await c.query("INSERT INTO tenants(id,name,plan) VALUES($1,'Own legacy export migration','enterprise')", [ids.tenant]);
          await c.query("INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,'Own migration actor','not-a-login-password')", [ids.user, 'export-migration-' + ids.user + '@example.test']);
          await c.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [ids.tenant, ids.user]);
          await c.query("INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Historical own export source','OLD')", [ids.warehouse, ids.tenant]);
          await c.query("INSERT INTO products(id,tenant_id,sku,name,price,vat,kind) VALUES($1,$2,$3,'Historical nondivisible price',1701,23,'simple')", [ids.product, ids.tenant, 'OLD-EXPORT-' + ids.product]);
          await c.query("INSERT INTO stock(tenant_id,warehouse_id,product_id,on_hand,location) VALUES($1,$2,$3,7,'LEGACY-01')", [ids.tenant, ids.warehouse, ids.product]);
          await c.query("INSERT INTO price_lists(id,tenant_id,name,currency) VALUES($1,$2,'Historical own export zero','PLN')", [ids.list, ids.tenant]);
          await c.query('INSERT INTO price_list_items(tenant_id,price_list_id,product_id,price) VALUES($1,$2,$3,0)', [ids.tenant, ids.list, ids.product]);
          await c.query('COMMIT');
        } catch (e) { await c.query('ROLLBACK'); throw e; }
      }
      if (migration.name === '097_catalog_export_sources') {
        for (const [id, name, definition] of [
          [ids.profile, 'Historical scalar export', legacy],
          [ids.sourceProfile, 'Historical source export', legacySources],
        ] as const) {
          assert.equal((await c.query('SELECT catalog_export_profile_definition_valid($1::jsonb) valid', [JSON.stringify(definition)])).rows[0].valid, true);
          await c.query(`INSERT INTO catalog_export_profiles(id,tenant_id,actor_id,client_key,request_hash,initial_request,name,definition)
            VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb)`, [id, ids.tenant, ids.user, randomUUID(), '0'.repeat(64), JSON.stringify({ name, definition }), name, JSON.stringify(definition)]);
        }
      }
    }
    const catalog = (await c.query('SELECT id FROM product_catalogs WHERE tenant_id=$1 AND is_default', [ids.tenant])).rows[0];
    assert(catalog);
    assert.equal((await c.query('SELECT catalog_export_profile_definition_valid($1::jsonb) valid', [JSON.stringify({ ...legacy, catalog_id: catalog.id })])).rows[0].valid, false, '142 validator must not already accept143 catalog field');
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const before = await manifest(c), identity = await validatorIdentity(c), dependencies = await validatorDependencies(c);
    await c.query('COMMIT');
    assert.equal(before.catalog_export_profiles.rows.length, 2);
    assert.equal(before.products.rows.length, 1); assert.equal(before.stock.rows.length, 1);
    assert.equal(identity.app_execute, true);
    const checks = dependencies.filter(d => d.object_class === 'pg_constraint' && d.relation === 'catalog_export_profiles');
    assert.equal(checks.length, 2, 'Both current definition and immutable initial request bind the original validator');

    await c.query('BEGIN');
    try {
      await c.query(await readFile(new URL('143_catalog_export_catalogs.sql', server), 'utf8'));
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; }
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    assert.deepEqual(await manifest(c), before, 'Every old table, column, ACL/RLS flag and full row remains exact');
    assert.deepEqual(await validatorIdentity(c), identity, 'CREATE OR REPLACE retains OID, owner, raw/effective ACL and signature');
    assert.deepEqual(await validatorDependencies(c), dependencies, 'Existing CHECK bindings remain attached to exactly the same function OID');
    for (const definition of [legacy, legacySources, { ...legacy, catalog_id: catalog.id }, { ...legacySources, catalog_id: catalog.id }]) {
      assert.equal((await c.query('SELECT catalog_export_profile_definition_valid($1::jsonb) valid', [JSON.stringify(definition)])).rows[0].valid, true);
    }
    for (const definition of [
      { ...legacy, catalog_id: null }, { ...legacy, catalog_id: 'not-a-uuid' },
      { ...legacy, catalog_version: '1' }, { ...legacy, scope_hash: '0'.repeat(64) },
      { ...legacySources, warehouse_ids: [] },
    ]) assert.equal((await c.query('SELECT catalog_export_profile_definition_valid($1::jsonb) valid', [JSON.stringify(definition)])).rows[0].valid, false);
    assert.equal((await c.query('SELECT catalog_export_catalogs_guards() ok')).rows[0].ok, true);
    const privileges = (await c.query(`SELECT
      has_function_privilege('dyna_app','catalog_export_catalogs_installed()','EXECUTE') marker,
      has_function_privilege('dyna_app','catalog_export_catalogs_guards()','EXECUTE') guards,
      has_function_privilege('dyna_app','catalog_export_catalogs_profile_guard()','EXECUTE') private_trigger`)).rows[0];
    assert.deepEqual(privileges, { marker: true, guards: true, private_trigger: false });
    await c.query('COMMIT');
    // Actual trigger installation is checked independently from new definition
    // syntax. Foreign/unassigned API behavior lives in the service suite.
    assert.equal((await c.query(`SELECT count(*)::integer n FROM pg_trigger WHERE
      tgrelid='catalog_export_profiles'::regclass AND tgname='catalog_export_catalogs_profile_guard'
      AND tgfoid='catalog_export_catalogs_profile_guard()'::regprocedure AND tgenabled='O' AND NOT tgisinternal`)).rows[0].n, 1);
  } finally {
    if (connected) { await c.query('ROLLBACK').catch(() => undefined); await c.end(); }
    if (created) {
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [database]);
      await admin.query(`DROP DATABASE ${ident(database)}`);
    }
    await admin.end();
  }
});
