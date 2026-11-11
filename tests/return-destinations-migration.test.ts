import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

// Never uninstall148 from the shared harness database. This test constructs an
// empty, exclusively owned147 database before importing any application pool.
assert.equal(process.env.DYNA_TEST, 'true');
const originalDatabase = process.env.DATABASE_URL;
const parent = new URL(originalDatabase ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(parent.hostname));
assert.match(parent.pathname, /^\/dynaminds_test_\d+$/);
const name = parent.pathname.slice(1) + '_dest148_' + randomUUID().replaceAll('-', '').slice(0, 12);
assert.match(name, /^dynaminds_test_\d+_dest148_[a-f0-9]{12}$/);
const own = new URL(parent); own.pathname = '/' + name;
const admin = new pg.Client({ connectionString: parent.href });
let created = false, adminConnected = false;
let pool: pg.Pool;
let app: Awaited<ReturnType<typeof import('../server/app').buildApp>>;
let makeFixture: typeof import('./return-assistant-fixture').returnAssistantFixture;
let providerCalls = 0;
type Row = Record<string, any>;
type Fixture = Awaited<ReturnType<typeof import('./return-assistant-fixture').returnAssistantFixture>>;
const sidecars = ['return_destination_parts', 'return_destination_arrivals', 'return_destination_fragments', 'return_destination_admissions'];
const changed = [
  'return_assistant_budget()', 'return_assistant_prepare(uuid,uuid,jsonb,uuid,uuid)',
  'return_assistant_physical_validate(return_assistant_admissions)', 'return_assistant_complete()',
  'return_assistant_finish(uuid,uuid,uuid)', 'wms_fragment_consistency()',
  'wms_validate_operation_scope(uuid,uuid)', 'b2b_return_local_finish(uuid)',
  'order_parcel_return_validate_receive(uuid,uuid,uuid,jsonb,jsonb)',
  'order_parcel_return_validate_physical(order_parcel_return_admissions)',
];
const seals = ['return_cases', 'return_items', 'return_assistant_sessions', 'return_assistant_photos', 'orders',
  'order_items', 'payment_entries', 'documents', 'packing_stations', 'wms_policies', 'stock_movements',
  'wms_return_fragments', 'stock', 'stock_locations', 'stock_location_movements', 'wms_layer_positions',
  'wms_layer_movements', 'wms_cost_layers', 'wms_lots', 'wms_issue_fragments', 'wms_operations', 'reservations',
  'reservation_locations', 'wms_reservation_layers', 'shipments', 'order_parcel_dispatches', 'order_parcel_releases',
  'order_parcel_return_claims', 'order_parcel_commercial_origins', 'order_parcel_origin_fragments',
  'return_destination_statuses', 'return_destination_status_revisions', 'warehouse_inventory_policies',
  'warehouses', 'products', 'product_catalog_warehouses'];
const witnessTables = ['stock_movements', 'stock_location_movements', 'wms_return_fragments', 'wms_layer_movements', 'wms_operations'];

before(async () => {
  await admin.connect(); adminConnected = true;
  await admin.query(`CREATE DATABASE "${name}"`); created = true;
  process.env.DATABASE_URL = own.href;
  pool = (await import('../server/db')).pool;
  assert.equal(new URL(pool.options.connectionString!).pathname, own.pathname);
  assert.equal((await pool.query("SELECT to_regclass('public.migrations') relation")).rows[0].relation, null);
  const central = await readFile(new URL('../server/db.ts', import.meta.url), 'utf8');
  const section = central.slice(central.indexOf('for (const [name, file] of ['));
  assert(section.startsWith('for (const [name, file] of ['));
  const manifest = [...section.matchAll(/\[\s*'(\d{3}_[a-z0-9_]+)'\s*,\s*'\.\/([a-z0-9_-]+\.sql)'\s*,?\s*\]/g)]
    .map(m => ({ name: m[1], file: m[2] })).filter(m => Number(m.name.slice(0, 3)) <= 147);
  assert.equal(manifest.length, 147); assert.equal(manifest[0].name, '001_foundation');
  assert.equal(manifest.at(-1)?.name, '147_return_destination_statuses');
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
  await (await import('./fixtures')).seed();
  makeFixture = (await import('./return-assistant-fixture')).returnAssistantFixture;
  app = await (await import('../server/app')).buildApp({ integrationTransport: async () => {
    providerCalls++; throw Error('Migration fixture cannot invoke providers');
  } });
});
after(async () => {
  try { await app?.close(); }
  finally {
    try { await pool?.end(); }
    finally {
      try { if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`); }
      finally {
        try { if (adminConnected) await admin.end(); }
        finally { if (originalDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = originalDatabase; }
      }
    }
  }
});

async function rows(includeSessions = true): Promise<Row> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); await c.query("SET LOCAL TimeZone='UTC'");
    const result: Row = {};
    const tables = (await c.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1")).rows;
    for (const { tablename } of tables) {
      assert.match(tablename, /^[a-z][a-z0-9_]*$/);
      if (!includeSessions && tablename === 'sessions') continue;
      result[tablename] = (await c.query(`SELECT to_jsonb(q) row FROM public."${tablename}" q ORDER BY 1`)).rows;
    }
    await c.query('COMMIT'); return result;
  } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
}
async function metadata() {
  const functions = (await pool.query(`SELECT p.oid,p.oid::regprocedure::text signature,to_jsonb(p) meta,
    pg_get_functiondef(p.oid) definition FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.prokind IN('f','p') ORDER BY p.oid`)).rows;
  const triggers = (await pool.query(`SELECT t.oid,r.relname,to_jsonb(t) meta,pg_get_triggerdef(t.oid,false) definition,
    con.conrelid::regclass::text constraint_table,con.contype constraint_type
    FROM pg_trigger t JOIN pg_class r ON r.oid=t.tgrelid LEFT JOIN pg_constraint con ON con.oid=t.tgconstraint
    WHERE r.relnamespace='public'::regnamespace ORDER BY t.oid`)).rows;
  const tables = (await pool.query(`SELECT c.oid,c.relname,c.relowner,c.relacl,c.relrowsecurity,c.relforcerowsecurity,
    (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.attnum),'[]') FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0) columns,
    (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.oid),'[]') FROM pg_policy p WHERE p.polrelid=c.oid) policies,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('meta',to_jsonb(x),'definition',pg_get_constraintdef(x.oid,false)) ORDER BY x.oid),'[]') FROM pg_constraint x WHERE x.conrelid=c.oid) constraints,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('meta',to_jsonb(i),'definition',pg_get_indexdef(i.indexrelid)) ORDER BY i.indexrelid),'[]') FROM pg_index i WHERE i.indrelid=c.oid) indexes
    FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' ORDER BY c.oid`)).rows;
  return { functions, triggers, tables };
}
async function draft139(f: Fixture) {
  const lease = randomUUID();
  let session = (await f.ok('/return-assistant/sessions', 'POST', { client_key: randomUUID(), return_number: f.rma.number,
    station_id: f.station.id, station_version: String(f.station.version), lease_token: lease }, 201)).session;
  for (const line of session.lines) for (let n = 0; n < line.requested; n++)
    session = (await f.ok('/return-assistant/sessions/' + session.id + '/scans', 'POST', {
      client_key: randomUUID(), version: String(session.version), lease_token: lease, code: f.product.sku, item_id: line.item_id,
    })).session;
  session = (await f.ok('/return-assistant/sessions/' + session.id + '/draft', 'PATCH', {
    client_key: randomUUID(), version: String(session.version), lease_token: lease, note: 'Genuine147 historical sale intake',
    shipping_refund: 0, parts: session.lines.map((line: Row) => ({ part_id: randomUUID(), item_id: line.item_id, status: 'sale', quantity: line.requested })),
    ...(f.on ? { wms_lots: f.receiveBody.wms_lots } : {}),
  })).session;
  const preview = (await f.ok('/return-assistant/sessions/' + session.id + '/previews', 'POST', {
    client_key: randomUUID(), version: String(session.version), lease_token: lease,
  }, 201)).preview;
  assert.equal(preview.action, 'receive'); assert.equal(preview.summary.refund_minor, 1000);
  const body = { client_key: randomUUID(), scope_hash: preview.scope_hash, confirmed: true, lease_token: lease };
  return { f, preview, body };
}
async function receive139(draft: Awaited<ReturnType<typeof draft139>>, status = 201) {
  const result = await draft.f.ok('/return-assistant/previews/' + draft.preview.id + '/receive', 'POST', draft.body, status);
  assert.equal(result.return_case.state, 'refund_pending'); assert.equal(result.return_case.refund_amount, 1000);
  assert.equal(result.session.state, 'completed'); return result;
}

test('genuine nonempty147 receipts survive additive148 with exact old rows and explicit metadata deltas; active093 legacy return still executes', async () => {
  assert.equal((await pool.query('SELECT name FROM migrations ORDER BY name DESC LIMIT 1')).rows[0].name, '147_return_destination_statuses');
  assert.equal((await pool.query("SELECT to_regprocedure('public.return_destination_installed()') marker")).rows[0].marker, null);
  const off = await draft139(await makeFixture(app, false)); const offResult = await receive139(off);
  const on = await draft139(await makeFixture(app, true)); const onResult = await receive139(on);
  // Prepare a real legacy preview under147, execute it AFTER148. This reaches
  // active093/core physical checks, rather than proving only historical GET.
  const pending = await draft139(await makeFixture(app, true));
  const before = await rows(); const old = await metadata();
  assert.equal(before.return_assistant_receipts.length, 2);
  assert.equal(before.return_assistant_previews.length, 3);
  assert.equal(before.wms_validation_scopes.length, 0);
  const returned = before.wms_return_fragments.map((r: Row) => r.row).filter((r: Row) => r.return_id === on.f.rma.id);
  assert.equal(returned.length, 2);
  const originalCosts = returned.map((returnedRow: Row) => {
    const originals = before.wms_issue_fragments.map((r: Row) => r.row).filter((original: Row) =>
      original.tenant_id === returnedRow.tenant_id && original.id === returnedRow.issue_fragment_id &&
      original.order_id === returnedRow.order_id && original.product_id === returnedRow.product_id && original.layer_id === returnedRow.layer_id);
    assert.equal(originals.length, 1, 'Every actual return has exactly its complete original issue tuple');
    assert.notEqual(originals[0].unit_cost_minor, null);
    assert.equal(BigInt(returnedRow.value_minor), BigInt(returnedRow.quantity) * BigInt(originals[0].unit_cost_minor));
    return String(originals[0].unit_cost_minor);
  });
  assert.deepEqual(originalCosts.sort(), ['0', '1000']);
  assert.equal(returned.reduce((n: bigint, r: Row) => n + BigInt(r.value_minor), 0n), 2000n);
  assert(before.stock_movements.some((r: Row) => r.row.return_id === off.f.rma.id));
  const sql = await readFile(new URL('../server/148_return_destinations.sql', import.meta.url), 'utf8');
  const c = await pool.connect();
  try { await c.query('BEGIN'); await c.query(sql); await c.query("INSERT INTO migrations(name) VALUES('148_return_destinations')"); await c.query('COMMIT'); }
  catch (error) { await c.query('ROLLBACK'); throw error; } finally { c.release(); }
  const afterRows = await rows(); const installed = await metadata();
  for (const [table, basis] of Object.entries(before)) {
    if (table === 'migrations') assert.deepEqual(afterRows[table].filter((r: Row) => r.row.name !== '148_return_destinations'), basis);
    else assert.deepEqual(afterRows[table], basis, 'All original global rows, including sessions: ' + table);
  }
  assert.deepEqual(Object.keys(afterRows).filter(table => !Object.hasOwn(before, table)).sort(), [...sidecars].sort());
  for (const table of sidecars) assert.deepEqual(afterRows[table], [], 'No backfilled sidecar: ' + table);
  assert.equal(afterRows.migrations.length, before.migrations.length + 1);
  const addedOldConstraints: Row[] = [];
  for (const table of old.tables) {
    const current = installed.tables.find(r => r.oid === table.oid); assert(current, 'Every old table OID survives');
    for (const constraint of table.constraints)
      assert.deepEqual(current.constraints.find((r: Row) => r.meta.oid === constraint.meta.oid), constraint, 'Every old constraint OID/full metadata survives: ' + table.relname);
    const additions = current.constraints.filter((r: Row) => !table.constraints.some((prior: Row) => prior.meta.oid === r.meta.oid));
    if (table.relname !== 'return_assistant_receipts') assert.deepEqual(additions, [], 'No other old-table constraint additions: ' + table.relname);
    addedOldConstraints.push(...additions);
    assert.deepEqual({ ...current, constraints: table.constraints }, table, 'All original column/index/owner/ACL/RLS metadata: ' + table.relname);
  }
  assert.equal(addedOldConstraints.length, 1, 'Only one new deferred parent-trigger constraint on an old table');
  const parentConstraint = addedOldConstraints[0], receiptTable = old.tables.find(t => t.relname === 'return_assistant_receipts');
  assert(receiptTable); assert.equal(String(parentConstraint.meta.conrelid), String(receiptTable.oid));
  assert.equal(parentConstraint.meta.contype, 't'); assert.equal(parentConstraint.meta.conname, 'return_destination_parent_complete');
  assert.equal(parentConstraint.meta.condeferrable, true); assert.equal(parentConstraint.meta.condeferred, true);
  assert.equal(parentConstraint.meta.convalidated, true);
  assert.equal(parentConstraint.definition, 'TRIGGER DEFERRABLE INITIALLY DEFERRED');
  const parentTrigger = installed.triggers.filter(t => t.relname === 'return_assistant_receipts' && t.meta.tgname === 'return_destination_parent_complete');
  assert.equal(parentTrigger.length, 1);
  assert.equal(parentTrigger[0].meta.tgconstraint, parentConstraint.meta.oid);
  assert.equal(parentTrigger[0].meta.tgtype, 5); assert.equal(parentTrigger[0].meta.tgdeferrable, true);
  assert.equal(parentTrigger[0].meta.tginitdeferred, true); assert.equal(parentTrigger[0].meta.tgisinternal, false);
  assert.equal(parentTrigger[0].meta.tgenabled, 'O');
  const completeFunction = installed.functions.find(f => f.signature === 'return_destination_complete()'); assert(completeFunction);
  assert.equal(String(parentTrigger[0].meta.tgfoid), String(completeFunction.oid));
  assert.match(parentTrigger[0].definition, /^CREATE CONSTRAINT TRIGGER return_destination_parent_complete AFTER INSERT ON public\.return_assistant_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION (?:public\.)?return_destination_complete\(\)$/);

  // PostgreSQL parses the exact VALUES literals from frozen SQL, while this
  // independent allowlist forbids additions to its old-function patch set.
  const patchMatch = sql.match(/FOR patch IN SELECT \* FROM\(VALUES([\s\S]*?)\)v\(signature,needle,replacement\) LOOP/);
  assert(patchMatch); const patches = (await pool.query('SELECT * FROM(VALUES' + patchMatch[1] + ')v(signature,needle,replacement)')).rows;
  assert.deepEqual(patches.map(p => p.signature.replace(/^public\./, '')).sort(), [...changed].sort());
  for (const fn of old.functions) {
    const current = installed.functions.find(row => row.oid === fn.oid); assert(current, 'Old OID retained: ' + fn.signature);
    const patch = patches.find(p => p.signature === 'public.' + fn.signature);
    if (!patch) { assert.deepEqual(current, fn, 'Unchanged entire old function: ' + fn.signature); continue; }
    const beforeMeta = { ...fn.meta }, afterMeta = { ...current.meta };
    delete beforeMeta.prosrc; delete afterMeta.prosrc;
    if (fn.signature === 'wms_fragment_consistency()') {
      assert.equal(beforeMeta.prosecdef, false); assert.equal(afterMeta.prosecdef, true);
      assert.deepEqual(afterMeta.proconfig, ['search_path=pg_catalog, public, pg_temp']);
      delete beforeMeta.prosecdef; delete afterMeta.prosecdef; delete beforeMeta.proconfig; delete afterMeta.proconfig;
    }
    assert.deepEqual(afterMeta, beforeMeta, 'Exact old owner/raw ACL/signature/all other attributes: ' + fn.signature);
    assert.equal(fn.meta.prosrc.split(patch.needle).length, 2, 'Unique original anchor');
    let expected = fn.meta.prosrc.replace(patch.needle, patch.replacement);
    if (fn.signature === 'return_assistant_complete()') {
      const anchor = ' PERFORM return_assistant_physical_validate(a);'; assert.equal(expected.split(anchor).length, 2);
      expected = expected.replace(anchor, ' END IF; /* destinations_v1: common financial checks above remain mandatory */\n' + anchor);
    }
    if (['wms_fragment_consistency()', 'wms_validate_operation_scope(uuid,uuid)'].includes(fn.signature))
      expected = expected.replace(/\b(FROM|JOIN)(\s+)(wms_issue_fragments|wms_return_fragments|wms_operations|wms_layer_movements|return_cases|return_items|wms_cost_layers|wms_lots)\b/gi, '$1$2public.$3');
    assert.notEqual(current.meta.prosrc, fn.meta.prosrc); assert.equal(current.meta.prosrc, expected, 'Only declared body transformation: ' + fn.signature);
  }
  const newFunctions = installed.functions.filter(fn => !old.functions.some(prior => prior.oid === fn.oid));
  assert.equal(newFunctions.length, 27); assert(newFunctions.every(fn => fn.signature.startsWith('return_destination_')));
  for (const table of sidecars) {
    const actual = (await pool.query(`SELECT c.relrowsecurity,c.relforcerowsecurity,
      has_table_privilege('dyna_app',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') app_access,
      EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner)))a WHERE a.grantee<>c.relowner) other_grants,
      EXISTS(SELECT 1 FROM pg_attribute x CROSS JOIN LATERAL aclexplode(x.attacl)a WHERE x.attrelid=c.oid AND a.grantee<>c.relowner) column_grants
      FROM pg_class c WHERE c.oid=$1::regclass`, [table])).rows[0];
    assert.deepEqual(actual, { relrowsecurity: true, relforcerowsecurity: true, app_access: false, other_grants: false, column_grants: false });
  }
  assert.equal((await pool.query(`SELECT count(*)::int n FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a
    WHERE p.oid=ANY($1::oid[]) AND a.grantee<>p.proowner`, [newFunctions.map(fn => fn.oid)])).rows[0].n, 0, 'No new function PUBLIC/app/foreign-role EXECUTE');
  for (const trigger of old.triggers) assert.deepEqual(installed.triggers.find(r => r.oid === trigger.oid), trigger, 'Every original user/internal trigger retains OID and full definition');
  const extra = installed.triggers.filter(t => !old.triggers.some(prior => prior.oid === t.oid));
  const expectedUsers = [
    ...sidecars.flatMap(table => [table + ':return_destination_record_guard', table + ':return_destination_complete']),
    ...witnessTables.map(table => table + ':return_destination_witness'), ...seals.map(table => table + ':return_destination_seal'),
    'return_assistant_receipts:return_destination_parent_complete',
  ];
  assert.equal(expectedUsers.length, 50);
  assert.deepEqual(extra.filter(t => !t.meta.tgisinternal).map(t => t.relname + ':' + t.meta.tgname).sort(), expectedUsers.sort());
  const internal = extra.filter(t => t.meta.tgisinternal); assert.equal(internal.length, 72, 'Four RI triggers per eighteen new FKs');
  assert(internal.every(t => t.constraint_type === 'f' && sidecars.includes(t.constraint_table.replace(/^public\./, ''))), 'Only new148 FK internal triggers may be added');
  assert.equal((await pool.query('SELECT public.return_destination_guards() guards')).rows[0].guards, true);
  const stable = await rows(false);
  const offReplay = await receive139(off, 200), onReplay = await receive139(on, 200);
  assert.equal(offReplay.reused, true); assert.equal(onReplay.reused, true);
  assert.deepEqual(offReplay.receipt, offResult.receipt); assert.deepEqual(onReplay.receipt, onResult.receipt);
  assert.deepEqual(await rows(false), stable, 'Exact pre148 receive retries have no business/audit delta');
  await receive139(pending);
  const fragments = (await pool.query(`SELECT r.quantity,r.value_minor,i.unit_cost_minor FROM public.wms_return_fragments r
    JOIN public.wms_issue_fragments i ON(i.tenant_id,i.id,i.order_id,i.product_id,i.layer_id)=
      (r.tenant_id,r.issue_fragment_id,r.order_id,r.product_id,r.layer_id)
    WHERE(r.tenant_id,r.return_id)=($1,$2) ORDER BY r.product_id`, [pending.f.tenant, pending.f.rma.id])).rows;
  assert.equal(fragments.length, 2); assert.deepEqual(fragments.map(r => String(r.unit_cost_minor)).sort(), ['0', '1000']);
  for (const fragment of fragments) assert.equal(BigInt(fragment.value_minor), BigInt(fragment.quantity) * BigInt(fragment.unit_cost_minor));
  assert.equal(fragments.reduce((n, r) => n + BigInt(r.value_minor), 0n), 2000n);
  assert.equal((await pool.query('SELECT count(*)::int n FROM wms_validation_scopes')).rows[0].n, 0);
  for (const table of sidecars) assert.equal((await pool.query(`SELECT count(*)::int n FROM public."${table}"`)).rows[0].n, 0, 'Ordinary legacy receive does not fabricate148 evidence');
  assert.equal(providerCalls, 0);
});
