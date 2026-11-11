import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

assert.equal(process.env.DYNA_TEST, 'true');
const originalUrl = new URL(process.env.DATABASE_URL ?? '');
assert(['127.0.0.1', 'localhost', '[::1]'].includes(originalUrl.hostname));
assert.match(originalUrl.pathname, /^\/dynaminds_test_\d+$/);
const server = new URL('../server/', import.meta.url);
type Manifest = Record<string, { columns: string[]; rows: any[] }>;
async function manifest(c: pg.Client): Promise<Manifest> {
  const result: Manifest = {};
  const names = (await c.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name NOT IN('sessions','migrations') ORDER BY 1")).rows.map(r => r.table_name as string);
  for (const name of names) {
    assert.match(name, /^[a-z_][a-z0-9_]*$/);
    const columns = (await c.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY 1", [name])).rows.map(r => r.column_name as string);
    result[name] = { columns, rows: (await c.query(`SELECT to_jsonb(q) row FROM "${name}" q ORDER BY 1`)).rows };
  }
  return result;
}
async function retained(c: pg.Client, before: Manifest) {
  for (const [name, basis] of Object.entries(before)) {
    const available = (await c.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1", [name])).rows.map(r => r.column_name);
    assert(basis.columns.every(column => available.includes(column)), 'Old columns preserved: ' + name);
    const rows = (await c.query(`SELECT to_jsonb(q) row FROM (SELECT ${basis.columns.map(column => `"${column}"`).join(',')} FROM "${name}") q ORDER BY 1`)).rows;
    assert.deepEqual(rows, basis.rows, 'Old full rows preserved: ' + name);
  }
}

test('actual142 backfills real141 legacy graphs without changing any old column and future tenants receive a default', async () => {
  // A separate owned database is required: never remove migration142 or its
  // guards from the common test database. Follow the central historical order.
  const database = originalUrl.pathname.slice(1) + '_catalog_' + randomUUID().replaceAll('-', '').slice(0, 12);
  assert.match(database, /^dynaminds_test_\d+_catalog_[a-f0-9]{12}$/);
  const admin = new pg.Client({ connectionString: originalUrl.href });
  const scratchUrl = new URL(originalUrl); scratchUrl.pathname = '/' + database;
  const c = new pg.Client({ connectionString: scratchUrl.href });
  let created = false, connected = false;
  try {
    await admin.connect(); await admin.query(`CREATE DATABASE "${database}"`); created = true;
    await c.connect(); connected = true; await c.query("SET TimeZone='UTC'");
    const dbSource = await readFile(new URL('db.ts', server), 'utf8');
    const section = dbSource.slice(dbSource.indexOf('for (const [name, file] of ['));
    assert(section.startsWith('for (const [name, file] of ['), 'Central migration manifest required');
    const migrations = [...section.matchAll(/\[\s*'(\d{3}_[a-z0-9_]+)'\s*,\s*'\.\/([a-z0-9_-]+\.sql)'\s*,?\s*\]/g)]
      .map(m => ({ name: m[1], file: m[2] })).filter(m => Number(m.name.slice(0, 3)) <= 141);
    assert.equal(migrations.length, 141); assert.equal(migrations[0].name, '001_foundation'); assert.equal(migrations.at(-1)?.name, '141_email_inbound');
    const ids = { tenant: randomUUID(), user: randomUUID(), warehouse: randomUUID(), list: randomUUID(), a: randomUUID(), group: randomUUID(), variant: randomUUID(), bundle: randomUUID(), order: randomUUID(), item: randomUUID(), rma: randomUUID() };
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
        // Explicit historical owner fixture before modern admission modules.
        // Its graph is preserved as data, not claimed as an executed workflow.
        await c.query('BEGIN');
        await c.query("INSERT INTO tenants(id,name,plan,locale) VALUES($1,'Own legacy catalog migration','enterprise','pt-BR')", [ids.tenant]);
        await c.query("INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,'Own migration actor','not-a-login-password')", [ids.user, 'catalog-migration-' + ids.user + '@example.test']);
        await c.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [ids.tenant, ids.user]);
        await c.query("INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Historical actual source','OLD')", [ids.warehouse, ids.tenant]);
        for (const [id, kind, parent, price] of [[ids.a, 'simple', null, 0], [ids.group, 'group', null, 1000], [ids.variant, 'variant', ids.group, 12301], [ids.bundle, 'bundle', null, 25000]] as const) {
          await c.query('INSERT INTO products(id,tenant_id,sku,name,price,vat,kind,parent_id) VALUES($1,$2,$3,$4,$5,23,$6,$7)', [id, ids.tenant, 'OLD-' + id, 'Historical ' + kind, price, kind, parent]);
        }
        await c.query('INSERT INTO bundle_components(tenant_id,bundle_id,product_id,quantity) VALUES($1,$2,$3,2)', [ids.tenant, ids.bundle, ids.a]);
        await c.query("INSERT INTO stock(tenant_id,warehouse_id,product_id,on_hand,location) VALUES($1,$2,$3,7,'LEGACY-01')", [ids.tenant, ids.warehouse, ids.a]);
        await c.query("INSERT INTO price_lists(id,tenant_id,name,currency) VALUES($1,$2,'Historical own zero','EUR')", [ids.list, ids.tenant]);
        await c.query('INSERT INTO price_list_items(tenant_id,price_list_id,product_id,price) VALUES($1,$2,$3,0)', [ids.tenant, ids.list, ids.variant]);
        await c.query("INSERT INTO orders(id,tenant_id,number,customer_name,email,total,warehouse_id,portal_token,status) VALUES($1,$2,'OLD-CATALOG-ORDER','Historical Buyer','old@example.test',25000,$3,$4,'shipped')", [ids.order, ids.tenant, ids.warehouse, randomUUID()]);
        const recipe = [{ product_id: ids.a, quantity: 2 }];
        await c.query('INSERT INTO order_items(id,tenant_id,order_id,product_id,name,sku,quantity,price,vat,line_total,components) VALUES($1,$2,$3,$4,$5,$6,1,25000,23,25000,$7)', [ids.item, ids.tenant, ids.order, ids.bundle, 'Historical frozen bundle', 'OLD-' + ids.bundle, JSON.stringify(recipe)]);
        await c.query("INSERT INTO return_cases(id,tenant_id,order_id,warehouse_id,number,kind,reason) VALUES($1,$2,$3,$4,'OLD-CATALOG-RMA','return','Existing frozen source')", [ids.rma, ids.tenant, ids.order, ids.warehouse]);
        await c.query('INSERT INTO return_items(tenant_id,order_id,return_id,item_id,sku,name,components,requested) VALUES($1,$2,$3,$4,$5,$6,$7,1)', [ids.tenant, ids.order, ids.rma, ids.item, 'OLD-' + ids.bundle, 'Historical frozen bundle', JSON.stringify(recipe)]);
        await c.query('COMMIT');
      }
    }
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); const before = await manifest(c); await c.query('COMMIT');
    assert.equal(before.products.rows.length, 4); assert.equal(before.product_sku_aliases.rows.length, 4);
    assert.equal(before.return_items.rows.length, 1); assert.equal(before.stock.rows.length, 1);
    await c.query('BEGIN'); await c.query(await readFile(new URL('142_product_catalogs.sql', server), 'utf8'));
    await c.query("INSERT INTO migrations(name) VALUES('142_product_catalogs')"); await c.query('COMMIT');
    await retained(c, before);
    const catalog = (await c.query('SELECT * FROM product_catalogs WHERE tenant_id=$1', [ids.tenant])).rows;
    assert.equal(catalog.length, 1); assert.equal(catalog[0].is_default, true); assert.equal(catalog[0].active, true);
    assert.deepEqual((await c.query('SELECT DISTINCT catalog_id FROM products WHERE tenant_id=$1', [ids.tenant])).rows, [{ catalog_id: catalog[0].id }]);
    assert.equal((await c.query('SELECT count(*)::int n FROM product_catalog_warehouses WHERE tenant_id=$1 AND catalog_id=$2 AND warehouse_id=$3', [ids.tenant, catalog[0].id, ids.warehouse])).rows[0].n, 1);
    assert.equal((await c.query('SELECT count(*)::int n FROM product_catalog_price_lists WHERE tenant_id=$1 AND catalog_id=$2 AND price_list_id=$3', [ids.tenant, catalog[0].id, ids.list])).rows[0].n, 1);
    assert.equal((await c.query("SELECT count(*)::int n FROM product_catalog_languages WHERE tenant_id=$1 AND catalog_id=$2 AND locale='pt-br'", [ids.tenant, catalog[0].id])).rows[0].n, 1);
    for (const table of ['product_catalogs', 'product_catalog_warehouses', 'product_catalog_price_lists', 'product_catalog_languages', 'product_catalog_previews', 'product_catalog_operations', 'product_catalog_admissions']) {
      const guard = (await c.query("SELECT relrowsecurity,relforcerowsecurity,has_table_privilege('dyna_app',oid,'INSERT,UPDATE,DELETE') mutation FROM pg_class WHERE oid=$1::regclass", [table])).rows[0];
      assert.deepEqual(guard, { relrowsecurity: true, relforcerowsecurity: true, mutation: false });
      assert.equal((await c.query('SELECT count(*)::int n FROM pg_constraint WHERE conrelid=$1::regclass AND NOT convalidated', [table])).rows[0].n, 0);
    }
    assert.equal((await c.query("SELECT has_table_privilege('dyna_app','product_catalog_admissions','SELECT') access")).rows[0].access, false);
    const future = randomUUID(), wh = randomUUID(), pl = randomUUID();
    await c.query("INSERT INTO tenants(id,name,plan) VALUES($1,'Own future catalog tenant','enterprise')", [future]);
    await c.query("INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Future own source','NEW')", [wh, future]);
    await c.query("INSERT INTO price_lists(id,tenant_id,name,currency) VALUES($1,$2,'Future own list','PLN')", [pl, future]);
    const next = (await c.query('SELECT * FROM product_catalogs WHERE tenant_id=$1 AND is_default', [future])).rows;
    assert.equal(next.length, 1);
    assert.equal((await c.query('SELECT count(*)::int n FROM product_catalog_warehouses WHERE tenant_id=$1 AND catalog_id=$2 AND warehouse_id=$3', [future, next[0].id, wh])).rows[0].n, 1);
    assert.equal((await c.query('SELECT count(*)::int n FROM product_catalog_price_lists WHERE tenant_id=$1 AND catalog_id=$2 AND price_list_id=$3', [future, next[0].id, pl])).rows[0].n, 1);
  } finally {
    if (connected) await c.end();
    if (created) {
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [database]);
      await admin.query(`DROP DATABASE "${database}"`);
    }
    await admin.end();
  }
});
