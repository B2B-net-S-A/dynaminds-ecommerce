import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

// Construct a genuinely historical, exclusively owned148 database; never
// remove149 from the central/shared harness and never touch primary.
assert.equal(process.env.DYNA_TEST, 'true');
const original = process.env.DATABASE_URL, parent = new URL(original ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(parent.hostname));
assert.match(parent.pathname, /^\/dynaminds_test_\d+$/);
const database = parent.pathname.slice(1) + '_adjust149_' + randomUUID().replaceAll('-', '').slice(0, 12);
assert.match(database, /^dynaminds_test_\d+_adjust149_[a-f0-9]{12}$/);
const url = new URL(parent); url.pathname = '/' + database;
const admin = new pg.Client({ connectionString: parent.href });
let connected = false, created = false, providerCalls = 0;
let pool: pg.Pool, app: Awaited<ReturnType<typeof import('../server/app').buildApp>>;
let fixture: typeof import('./stocktake-adjustments-fixture');
type Row = Record<string, any>;
const newTables = ['series', 'series_commands', 'counters', 'previews', 'preview_rows', 'admissions', 'receipts', 'documents', 'document_rows'].map(name => 'stocktake_adjustment_' + name);
before(async () => {
  await admin.connect(); connected = true; await admin.query(`CREATE DATABASE "${database}"`); created = true;
  process.env.DATABASE_URL = url.href;
  pool = (await import('../server/db')).pool; assert.equal(new URL(pool.options.connectionString!).pathname, url.pathname);
  assert.equal((await pool.query("SELECT to_regclass('public.migrations') relation")).rows[0].relation, null);
  const central = await readFile(new URL('../server/db.ts', import.meta.url), 'utf8');
  const section = central.slice(central.indexOf('for (const [name, file] of [')); assert(section.startsWith('for (const [name, file] of ['));
  const manifest = [...section.matchAll(/\[\s*'(\d{3}_[a-z0-9_]+)'\s*,\s*'\.\/([a-z0-9_-]+\.sql)'\s*,?\s*\]/g)].map(m => ({ name: m[1], file: m[2] })).filter(m => Number(m.name.slice(0, 3)) <= 148);
  assert.equal(manifest.length, 148); assert.equal(manifest[0].name, '001_foundation'); assert.equal(manifest.at(-1)?.name, '148_return_destinations');
  const c = await pool.connect();
  try {
    for (const migration of manifest) {
      await c.query('BEGIN');
      try {
        await c.query(await readFile(new URL('../server/' + migration.file, import.meta.url), 'utf8'));
        if (migration.name === '092_wms_stocktakes') await c.query(await readFile(new URL('../server/wms-stocktake-invariants.sql', import.meta.url), 'utf8'));
        if (migration.name === '108_b2b_dropshipping') await c.query(await readFile(new URL('../server/108_b2b_dropship_dispatch.sql', import.meta.url), 'utf8'));
        await c.query('INSERT INTO migrations(name) VALUES($1)', [migration.name]); await c.query('COMMIT');
      } catch (error) { await c.query('ROLLBACK'); throw error; }
    }
  } finally { c.release(); }
  await (await import('./fixtures')).seed(); fixture = await import('./stocktake-adjustments-fixture');
  app = await (await import('../server/app')).buildApp({ integrationTransport: async () => { providerCalls++; throw Error('No providers in adjustment migration'); } });
});
after(async () => {
  try { await app?.close(); }
  finally {
    try { await pool?.end(); }
    finally {
      try { if (created) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`); }
      finally { try { if (connected) await admin.end(); } finally { if (original === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = original; } }
    }
  }
});
async function globalRows() {
  const c = await pool.connect(), rows: Record<string, Row[]> = {};
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); await c.query("SET LOCAL TimeZone='UTC'");
    for (const { tablename } of (await c.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1")).rows) {
      assert.match(tablename, /^[a-z][a-z0-9_]*$/); rows[tablename] = (await c.query(`SELECT to_jsonb(q) row FROM public."${tablename}" q ORDER BY 1`)).rows;
    }
    await c.query('COMMIT'); return rows;
  } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
}
async function metadata() {
  const functions = (await pool.query("SELECT p.oid,p.oid::regprocedure::text signature,to_jsonb(p) meta,pg_get_functiondef(p.oid) definition FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.prokind IN('f','p') ORDER BY p.oid")).rows;
  const triggers = (await pool.query("SELECT t.oid,c.relname,to_jsonb(t) meta,pg_get_triggerdef(t.oid,false) definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace ORDER BY t.oid")).rows;
  const tables = (await pool.query(`SELECT c.oid,c.relname,c.relowner,c.relacl,c.relrowsecurity,c.relforcerowsecurity,
    (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.attnum),'[]') FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0) columns,
    (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.oid),'[]') FROM pg_policy p WHERE p.polrelid=c.oid) policies,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('meta',to_jsonb(x),'definition',pg_get_constraintdef(x.oid,false)) ORDER BY x.oid),'[]') FROM pg_constraint x WHERE x.conrelid=c.oid) constraints,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('meta',to_jsonb(i),'definition',pg_get_indexdef(i.indexrelid)) ORDER BY i.indexrelid),'[]') FROM pg_index i WHERE i.indrelid=c.oid) indexes
    FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' ORDER BY c.oid`)).rows;
  return { functions, triggers, tables };
}
async function legacyPost(on: boolean) {
  const f = await fixture.stocktakeAdjustmentFixture(app, on), source = await fixture.countedAdjustmentSource(f);
  const path = (on ? '/wms-lots/stocktakes/' : '/stocktakes/') + source.id + '/post';
  const body = on ? { client_key: randomUUID(), version: source.version, review_id: source.review_id, scope_hash: source.scope_hash, confirmed: true } : { version: source.version, confirmed: true };
  const result = await f.ok(path, 'POST', body, on ? 201 : 200);
  assert.equal(on ? result.posting.state : result.state, 'posted');
  return { f, source, path, body, result };
}

test('nonempty historical148 stocktake graphs survive additive149 with unchanged old rows and authentic legacy replay', async () => {
  assert.equal((await pool.query('SELECT name FROM migrations ORDER BY name DESC LIMIT 1')).rows[0].name, '148_return_destinations');
  const off = await legacyPost(false), on = await legacyPost(true);
  const before = await globalRows(), old = await metadata();
  assert(before.stocktakes.some(x => x.row.id === off.source.id && x.row.state === 'posted'));
  assert(before.wms_stocktake_postings.some(x => x.row.stocktake_id === on.source.id));
  const operation = before.wms_operations.find(x => x.row.id === on.result.posting.wms_operation_id)!.row;
  assert.equal(operation.kind, 'stocktake_post'); assert.equal(operation.warehouse_document_id, null);
  const movements = before.wms_layer_movements.map(x => x.row).filter(x => x.operation_id === operation.id);
  assert.equal(movements.length, 6); assert(movements.some(x => x.delta < 0 && x.value_delta === null)); assert(movements.some(x => x.value_delta !== null && String(x.value_delta) === '0'));
  const c = await pool.connect();
  try { await c.query('BEGIN'); await c.query(await readFile(new URL('../server/149_stocktake_adjustments.sql', import.meta.url), 'utf8')); await c.query("INSERT INTO migrations(name) VALUES('149_stocktake_adjustments')"); await c.query('COMMIT'); }
  catch (error) { await c.query('ROLLBACK'); throw error; } finally { c.release(); }
  const now = await globalRows(), current = await metadata();
  for (const [name, basis] of Object.entries(before)) assert.deepEqual(name === 'migrations' ? now[name].filter(x => x.row.name !== '149_stocktake_adjustments') : now[name], basis, 'All old global rows, including sessions: ' + name);
  assert.deepEqual(Object.keys(now).filter(name => !Object.hasOwn(before, name)).sort(), [...newTables].sort());
  for (const table of newTables) {
    assert.deepEqual(now[table], [], 'No document/history backfill: ' + table);
    const security = (await pool.query("SELECT relrowsecurity,relforcerowsecurity,has_table_privilege('dyna_app',oid,'SELECT,INSERT,UPDATE,DELETE') app_access FROM pg_class WHERE oid=$1::regclass", ['public.' + table])).rows[0];
    assert.deepEqual(security, { relrowsecurity: true, relforcerowsecurity: true, app_access: false });
  }
  // No legacy function replacement is admitted silently. This explicit oracle
  // must be updated only after backend/root declares a necessary149 delta.
  for (const fn of old.functions) assert.deepEqual(current.functions.find(x => x.oid === fn.oid), fn, 'Old function body/OID/owner/ACL/config: ' + fn.signature);
  for (const trigger of old.triggers) assert.deepEqual(current.triggers.find(x => x.oid === trigger.oid), trigger, 'Old trigger OID/definition: ' + trigger.relname);
  const additions = current.triggers.filter(x => !old.triggers.some(b => b.oid === x.oid));
  const expectedTriggers: { table: string; name: string; function: string; type: number; deferred: boolean }[] = [
    { table: 'stocktake_adjustment_receipts', name: 'stocktake_adjustment_complete', function: 'stocktake_adjustment_complete()', type: 5, deferred: true },
    { table: 'stocktake_adjustment_admissions', name: 'stocktake_adjustment_admission_complete', function: 'stocktake_adjustment_complete()', type: 5, deferred: true },
    { table: 'stocktake_adjustment_counters', name: 'stocktake_adjustment_counter_guard', function: 'stocktake_adjustment_counter_guard()', type: 27, deferred: false },
    { table: 'stocktake_adjustment_admissions', name: 'stocktake_adjustment_admission_guard', function: 'stocktake_adjustment_admission_guard()', type: 27, deferred: false },
    ...['series', 'series_commands', 'previews', 'preview_rows', 'receipts', 'documents', 'document_rows'].map(n => ({ table: 'stocktake_adjustment_' + n, name: 'stocktake_adjustment_immutable', function: 'stocktake_adjustment_immutable()', type: 27, deferred: false })),
    ...['receipts', 'documents', 'document_rows'].map(n => ({ table: 'stocktake_adjustment_' + n, name: 'stocktake_adjustment_insert_guard', function: 'stocktake_adjustment_insert_guard()', type: 7, deferred: false })),
    ...['stocktakes', 'stocktake_lines', 'stock_location_movements', 'stock_movements', 'wms_stocktakes', 'wms_stocktake_lines', 'wms_stocktake_postings', 'wms_operations', 'wms_layer_movements'].map(n => ({ table: n, name: 'stocktake_adjustment_source_seal', function: 'stocktake_adjustment_source_seal()', type: 31, deferred: false })),
  ];
  const userAdditions = additions.filter(x => !x.meta.tgisinternal);
  assert.equal(expectedTriggers.length, 23); assert.equal(userAdditions.length, expectedTriggers.length);
  for (const expected of expectedTriggers) {
    const trigger = userAdditions.find(x => x.relname === expected.table && x.meta.tgname === expected.name); assert(trigger);
    assert.equal(trigger.meta.tgenabled, 'O'); assert.equal(trigger.meta.tgtype, expected.type);
    assert.equal(trigger.meta.tgdeferrable, expected.deferred); assert.equal(trigger.meta.tginitdeferred, expected.deferred);
    const fn = current.functions.find(x => String(x.oid) === String(trigger.meta.tgfoid)); assert(fn);
    assert.equal(fn.signature, expected.function);
    if (expected.deferred) {
      const table = current.tables.find(x => x.relname === expected.table); assert(table);
      const constraint = table.constraints.find((x: Row) => String(x.meta.oid) === String(trigger.meta.tgconstraint)); assert(constraint);
      assert.equal(constraint.meta.contype, 't'); assert.equal(constraint.meta.conname, expected.name);
      assert.equal(constraint.meta.condeferrable, true); assert.equal(constraint.meta.condeferred, true);
    } else assert.equal(String(trigger.meta.tgconstraint), '0');
  }
  // Every extra RI trigger must belong to an actual validated FK on a new
  // sidecar, including the parent-side RI triggers on legacy journal tables.
  // No new hidden constraint on a historical business table is admitted.
  const newForeignKeys = current.tables.filter(x => newTables.includes(x.relname)).flatMap(x => x.constraints).filter((x: Row) => x.meta.contype === 'f');
  const riAdditions = additions.filter(x => x.meta.tgisinternal);
  assert.equal(riAdditions.length, newForeignKeys.length * 4);
  for (const fk of newForeignKeys) {
    assert.equal(fk.meta.convalidated, true);
    const triggers = riAdditions.filter(x => String(x.meta.tgconstraint) === String(fk.meta.oid)); assert.equal(triggers.length, 4);
    assert.deepEqual(triggers.map(x => String(x.meta.tgrelid)).sort(), [fk.meta.conrelid, fk.meta.conrelid, fk.meta.confrelid, fk.meta.confrelid].map(String).sort());
  }
  for (const table of old.tables) {
    const after = current.tables.find(x => x.oid === table.oid); assert(after);
    const identity = table.relname === 'stock_movements' ? 'stocktake_adjustment_stock_identity' : table.relname === 'stock_location_movements' ? 'stocktake_adjustment_location_identity' : null;
    if (identity === null) assert.deepEqual(after, table, 'Old table columns/RLS/ACL/indexes/constraints: ' + table.relname);
    else {
      const constraints = after.constraints.filter((x: Row) => !table.constraints.some((old: Row) => old.meta.oid === x.meta.oid));
      const indexes = after.indexes.filter((x: Row) => !table.indexes.some((old: Row) => old.meta.indexrelid === x.meta.indexrelid));
      assert.equal(constraints.length, 1); assert.equal(indexes.length, 1);
      const con = constraints[0]; assert.equal(con.meta.conname, identity); assert.equal(con.meta.contype, 'u'); assert.equal(con.meta.convalidated, true); assert.equal(con.meta.condeferrable, false);
      assert.equal(String(con.meta.conrelid), String(table.oid)); assert.equal(String(con.meta.conindid), String(indexes[0].meta.indexrelid));
      const columns = con.meta.conkey.map((n: number) => table.columns.find((x: Row) => x.attnum === n)?.attname); assert.deepEqual(columns, ['tenant_id', 'id']);
      assert.equal(indexes[0].meta.indisunique, true); assert.equal(indexes[0].meta.indisvalid, true); assert.equal(indexes[0].meta.indisready, true);
      assert.deepEqual({ ...after, constraints: after.constraints.filter((x: Row) => x.meta.oid !== con.meta.oid), indexes: after.indexes.filter((x: Row) => x.meta.indexrelid !== indexes[0].meta.indexrelid) }, table, 'Only declared tenant journal identity UNIQUE/index may be added');
    }
  }
  const installed = (await pool.query('SELECT stocktake_adjustment_installed() installed,stocktake_adjustment_guards() guards')).rows[0]; assert.deepEqual(installed, { installed: true, guards: true });
  await off.f.ok(off.path, 'POST', off.body); const retry = await on.f.ok(on.path, 'POST', on.body); assert.equal(retry.reused, true); assert.equal(retry.posting.id, on.result.posting.id);
  assert.deepEqual(await globalRows(), now, 'Historical replay performs no delayed document generation or counter bump');
  assert.equal(providerCalls, 0);
});
