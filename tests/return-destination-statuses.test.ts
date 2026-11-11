import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { PoolClient } from 'pg';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { seed } from './fixtures';
import { returnAssistantFixture } from './return-assistant-fixture';
import { productCatalogFacts } from './product-catalogs-fixture';
import * as S from '../server/return-destination-statuses';
import * as V from '../server/return-destination-statuses-schema';
import { previewWarehouseInventoryPolicy, commitWarehouseInventoryPolicy } from '../server/warehouse-inventory-policies';
import { returnDestinationsAvailable } from '../server/return-destinations';

// Authored only for root's disposable native harness. No primary/provider calls.
assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/dynaminds_test_[a-zA-Z0-9_]+$/);
let app: Awaited<ReturnType<typeof buildApp>>;
let intakeAvailable = false;
before(async () => {
  await migrate(); await seed();
  for (const [marker, file] of [['warehouse_inventory_policy_installed()', '146_warehouse_inventory_policies.sql'],
    ['return_destination_status_installed()', '147_return_destination_statuses.sql']]) {
    if (!(await pool.query('SELECT to_regprocedure($1) marker', ['public.' + marker])).rows[0].marker)
      await pool.query(await readFile(resolve('server', file), 'utf8'));
  }
  intakeAvailable = await returnDestinationsAvailable();
  app = await buildApp({ integrationTransport: async () => { throw Error('Status configuration cannot call providers'); } });
});
after(async () => { try { await app?.close(); } finally { await pool.end(); } });
type Fixture = Awaited<ReturnType<typeof returnAssistantFixture>>;
const prefix = '/return-assistant/statuses';
const consent = (preview: any) => ({ client_key: randomUUID(), scope_hash: preview.scope_hash, confirmed: true });
const settings = (f: Fixture, extra: any = {}) => ({
  name: 'Own accepted return', color: '#12abef', active: true, decision: 'accept', inventory_effect: 'sale',
  warehouse_id: f.warehouse, warehouse_policy_version: '0', default_location: 'RETURN-161', ...extra,
});
const create = (f: Fixture, extra: any = {}) => ({ client_key: randomUUID(), kind: 'create', settings: settings(f, extra) });
const rejected = { name: 'Own rejected goods', color: '#ff0000', active: true, decision: 'reject', inventory_effect: 'none',
  warehouse_id: null, warehouse_policy_version: null, default_location: null };
const statusError = (status: number) => (error: any) => error.status === status;
function businessEqual(original: Record<string, any[]>, current: Record<string, any[]>) {
  assert.deepEqual(Object.keys(current), Object.keys(original));
  for (const name of Object.keys(original))
    if (!name.startsWith('return_destination_status') && !name.startsWith('warehouse_inventory_policy')
      && name !== 'warehouse_inventory_policies' && name !== 'audit_events') assert.deepEqual(current[name], original[name], name);
}
async function waitingFor(holder: PoolClient, expression: RegExp) {
  const pid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const blocked = (await pool.query(`SELECT query FROM pg_stat_activity WHERE datname=current_database()
      AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))`, [pid])).rows;
    if (blocked.some(row => expression.test(row.query))) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Actual status issuer must wait on the held own status row');
}
function noPrivate(value: unknown) {
  const inspect = (node: any) => {
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      assert(!['tenant_id', 'actor_id', 'api_key_id', 'request_hash', 'txid', 'admission', 'password_hash'].includes(key));
      inspect(child);
    }
  }; inspect(value);
}

test('schema rejects unsupported combinations, duplicate authority fields and unsafe text; policy0 remains valid', () => {
  const base = { ...rejected };
  assert(V.returnDestinationStatusSettings.safeParse(base).success);
  for (const extra of [{ decision: 'accept' }, { warehouse_id: randomUUID() }, { inventory_effect: null },
    { color: '#fff' }, { name: 'bad\u0000name' }, { default_location: 'A\nB' }, { tenant_id: randomUUID() }])
    assert.equal(V.returnDestinationStatusSettings.safeParse({ ...base, ...extra }).success, false);
  assert(V.returnDestinationStatusSettings.safeParse({ ...base, decision: 'accept', inventory_effect: 'sale', warehouse_id: randomUUID(), warehouse_policy_version: '0', default_location: 'RET' }).success);
  assert.equal(V.returnDestinationStatusCommitInput.safeParse({ ...consent({ scope_hash: '0'.repeat(64) }), confirmed: false }).success, false);
});

test('OFF/ON configuration previews preserve genuine commerce; revision CAS and exact replay preserve immutable history', async () => {
  for (const on of [false, true]) {
    const f = await returnAssistantFixture(app, on), original = await productCatalogFacts(f.tenant);
    // Direct callers must opt into the verified startup capability, as app.ts
    // does. No-context compatibility still defaults false;148 may be installed.
    assert.equal((await S.returnDestinationStatusOptions(f.actor)).intake_available, false);
    const options = await S.returnDestinationStatusOptions(f.actor, { intakeAvailable });
    assert.equal(options.intake_available, intakeAvailable); assert.equal(options.can_manage, true);
    for (const alias of ['/api', '/api/v1']) {
      const actual = await app.inject({ url: alias + prefix + '/options', headers: { cookie: f.cookie } });
      assert.equal(actual.statusCode, 200); assert.equal(actual.json().intake_available, intakeAvailable);
    }
    assert.deepEqual(options.warehouses.find((w: any) => w.id === f.warehouse).policy, { usage: 'sale', enabled: true, version: '0' });
    const input = create(f), reply = await S.previewReturnDestinationStatus(f.actor, input), p = reply.preview;
    assert.equal(p.after.id, p.status_id); assert.equal(p.before, null); assert.equal(p.after.version, '1'); noPrivate(reply);
    const previewRows = await productCatalogFacts(f.tenant), retry = await S.previewReturnDestinationStatus(f.actor, input);
    assert.equal(retry.reused, true); assert.deepEqual(retry.preview, p); assert.deepEqual(await productCatalogFacts(f.tenant), previewRows);
    const body = consent(p), saved = await S.commitReturnDestinationStatus(f.actor, p.id, body);
    assert.equal(saved.status.version, '1'); assert.equal(saved.status.revision_id, saved.operation.after.revision_id);
    const immutablePreview = { ...p }; delete immutablePreview.can_commit; delete immutablePreview.operation_id;
    assert.deepEqual(saved.operation.snapshot, immutablePreview); noPrivate(saved);
    const accepted = await productCatalogFacts(f.tenant);
    const repeat = await S.commitReturnDestinationStatus(f.actor, p.id, body);
    assert.equal(repeat.reused, true); assert.deepEqual(repeat.operation, saved.operation); assert.deepEqual(await productCatalogFacts(f.tenant), accepted);
    await assert.rejects(S.commitReturnDestinationStatus(f.actor, p.id, consent(p)), statusError(409));
    const update = { client_key: randomUUID(), kind: 'update', status_id: saved.status.id, version: '1', settings: { ...saved.status.settings, name: 'Own revised inspection' } };
    const p2 = (await S.previewReturnDestinationStatus(f.actor, update)).preview;
    const revised = await S.commitReturnDestinationStatus(f.actor, p2.id, consent(p2)); assert.equal(revised.status.version, '2');
    const final = await productCatalogFacts(f.tenant);
    const historical = await S.commitReturnDestinationStatus(f.actor, p.id, body);
    assert.deepEqual(historical.status, saved.status); assert.deepEqual(historical.operation, saved.operation);
    assert.equal((await S.returnDestinationStatusDetail(f.actor, saved.status.id)).status.version, '2');
    assert.equal((await S.returnDestinationStatusHistory(f.actor, saved.status.id)).data.length, 2);
    await assert.rejects(S.previewReturnDestinationStatus(f.actor, { ...update, client_key: randomUUID() }), statusError(409));
    assert.deepEqual(await productCatalogFacts(f.tenant), final); businessEqual(original, final);
  }
});

test('custody uses real146 policy and refuses foreign/stale or mismatched targets without mutation', async () => {
  const f = await returnAssistantFixture(app), other = await returnAssistantFixture(app);
  const wh = await f.ok('/warehouses', 'POST', { name: 'Own empty custody target', code: 'RC-' + randomUUID().slice(0, 8) });
  const policyPreview = (await previewWarehouseInventoryPolicy(f.actor, wh.id, { client_key: randomUUID(), version: '0', usage: 'custody', enabled: true })).preview;
  assert.equal(policyPreview.ready, true);
  const policy = (await commitWarehouseInventoryPolicy(f.actor, policyPreview.id, consent(policyPreview))).operation.after;
  const original = await productCatalogFacts(f.tenant);
  for (const extra of [{ warehouse_id: other.warehouse }, { inventory_effect: 'custody' }, { warehouse_policy_version: '99' }]) {
    await assert.rejects(S.previewReturnDestinationStatus(f.actor, create(f, extra)), error => [404, 409].includes((error as any).status));
  }
  const p = (await S.previewReturnDestinationStatus(f.actor, create(f, { warehouse_id: wh.id, warehouse_policy_version: policy.version, inventory_effect: 'custody' }))).preview;
  assert.equal(p.resources.warehouse.policy.usage, 'custody');
  const saved = await S.commitReturnDestinationStatus(f.actor, p.id, consent(p), { intakeAvailable });
  assert.equal(saved.status.settings.inventory_effect, 'custody'); assert.equal(saved.intake_available, intakeAvailable);
  businessEqual(original, await productCatalogFacts(f.tenant));
  const foreign = await S.returnDestinationStatusOptions(other.actor); assert(foreign.warehouses.every((w: any) => w.id !== wh.id));
  await assert.rejects(S.returnDestinationStatusDetail(other.actor, saved.status.id), statusError(404));
  await assert.rejects(S.returnDestinationStatusOperation(other.actor, saved.operation.id), statusError(404));
});

test('current admin/key grant and exact principal-body binding apply to previews, commits and committed replay', async () => {
  const f = await returnAssistantFixture(app);
  const scopes = ['orders:read', 'inventory:read', 'returns:configure'];
  const first = await f.ok('/developer/keys', 'POST', { name: 'Own return configuration one', scopes }, 201);
  const second = await f.ok('/developer/keys', 'POST', { name: 'Own return configuration two', scopes }, 201);
  const a = { ...f.actor, apiKeyId: first.id }, b = { ...f.actor, apiKeyId: second.id };
  const input = create(f), p = (await S.previewReturnDestinationStatus(a, input)).preview;
  const beforeRows = await productCatalogFacts(f.tenant);
  await assert.rejects(S.previewReturnDestinationStatus(b, input), statusError(409));
  await assert.rejects(S.previewReturnDestinationStatus(a, { ...input, settings: { ...input.settings, color: '#123456' } }), statusError(409));
  await assert.rejects(S.commitReturnDestinationStatus(b, p.id, consent(p)), statusError(409));
  assert.deepEqual(await productCatalogFacts(f.tenant), beforeRows);
  const body = consent(p), saved = await S.commitReturnDestinationStatus(a, p.id, body); noPrivate(saved);
  await pool.query('UPDATE api_keys SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2', [f.tenant, first.id]);
  const revoked = await productCatalogFacts(f.tenant);
  await assert.rejects(S.commitReturnDestinationStatus(a, p.id, body), statusError(401));
  assert.deepEqual(await productCatalogFacts(f.tenant), revoked);
  await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [f.tenant, f.user]);
  try {
    const beforeViewer = await productCatalogFacts(f.tenant), viewer = await S.returnDestinationStatusOptions(f.actor);
    assert.equal(viewer.current_role, 'viewer'); assert.equal(viewer.can_manage, false);
    await assert.rejects(S.previewReturnDestinationStatus(f.actor, create(f)), statusError(403));
    assert.deepEqual(await productCatalogFacts(f.tenant), beforeViewer);
  } finally { await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [f.tenant, f.user]); }
});

test('role and key withdrawal after a proven own status-row wait roll back the whole configuration transaction', async () => {
  for (const keyCase of [false, true]) {
    const f = await returnAssistantFixture(app);
    const key = keyCase ? await f.ok('/developer/keys', 'POST', { name: 'Own late configuration', scopes: ['orders:read', 'inventory:read', 'returns:configure'] }, 201) : null;
    const actor = { ...f.actor, ...(key ? { apiKeyId: key.id } : {}) };
    const p = (await S.previewReturnDestinationStatus(actor, create(f))).preview;
    const first = await S.commitReturnDestinationStatus(actor, p.id, consent(p));
    const change = { client_key: randomUUID(), kind: 'update', status_id: first.status.id, version: '1', settings: { ...first.status.settings, name: 'Never admitted after withdrawal' } };
    const p2 = (await S.previewReturnDestinationStatus(actor, change)).preview;
    const holder = await pool.connect(); let pending: Promise<any> | undefined;
    try {
      await holder.query('BEGIN'); await holder.query('SELECT id FROM return_destination_statuses WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [f.tenant, first.status.id]);
      pending = S.commitReturnDestinationStatus(actor, p2.id, consent(p2)); pending.catch(() => undefined);
      await waitingFor(holder, /return_destination_status_commit/);
      if (key) await pool.query('UPDATE api_keys SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2', [f.tenant, key.id]);
      else await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [f.tenant, f.user]);
      const revokedRows = await productCatalogFacts(f.tenant);
      await holder.query('COMMIT');
      await assert.rejects(pending, statusError(key ? 401 : 403)); assert.deepEqual(await productCatalogFacts(f.tenant), revokedRows);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined); holder.release(); await pending?.catch(() => undefined);
      if (!key) await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [f.tenant, f.user]);
    }
  }
});

test('the first over100 active statuses refuses entirely; deactivation preserves prior revisions and permits one replacement', async () => {
  const f = await returnAssistantFixture(app); let initial: any;
  for (let index = 0; index < 100; index++) {
    const p = (await S.previewReturnDestinationStatus(f.actor, { client_key: randomUUID(), kind: 'create', settings: { ...rejected, name: 'Own status ' + index } })).preview;
    const receipt = await S.commitReturnDestinationStatus(f.actor, p.id, consent(p)); if (!index) initial = receipt.status;
  }
  const atLimit = await productCatalogFacts(f.tenant);
  await assert.rejects(S.previewReturnDestinationStatus(f.actor, create(f)), statusError(413));
  assert.deepEqual(await productCatalogFacts(f.tenant), atLimit);
  const list = await S.returnDestinationStatusList(f.actor, { limit: 50 }); assert.equal(list.data.length, 50); assert(list.next_cursor);
  const next = await S.returnDestinationStatusList(f.actor, { limit: 50, cursor: list.next_cursor }); assert.equal(next.data.length, 50); assert.equal(next.next_cursor, null);
  const off = (await S.previewReturnDestinationStatus(f.actor, { client_key: randomUUID(), kind: 'update', status_id: initial.id, version: initial.version, settings: { ...initial.settings, active: false } })).preview;
  await S.commitReturnDestinationStatus(f.actor, off.id, consent(off));
  const replacement = (await S.previewReturnDestinationStatus(f.actor, create(f))).preview;
  await S.commitReturnDestinationStatus(f.actor, replacement.id, consent(replacement));
  assert.equal((await pool.query('SELECT count(*)::int n FROM return_destination_status_revisions WHERE tenant_id=$1', [f.tenant])).rows[0].n, 102);
});

test('private SQL tables/issuers deny app grants and a torn enabled trigger fails closed without row changes', async () => {
  const f = await returnAssistantFixture(app), original = await productCatalogFacts(f.tenant), c = await pool.connect();
  try {
    for (const table of ['return_destination_statuses', 'return_destination_status_revisions', 'return_destination_status_previews', 'return_destination_status_operations', 'return_destination_status_admissions']) {
      await c.query('BEGIN'); await c.query('SET LOCAL ROLE dyna_app'); await c.query("SELECT set_config('app.tenant_id',$1,true)", [f.tenant]);
      await assert.rejects(c.query(`SELECT * FROM ${table}`), (error: any) => error.code === '42501'); await c.query('ROLLBACK');
    }
    await c.query('BEGIN'); await c.query('SET LOCAL ROLE dyna_app');
    await assert.rejects(c.query('SELECT return_destination_status_preview($1,NULL,$2::jsonb)', [f.user, JSON.stringify(create(f))]), (error: any) => error.code === '42501'); await c.query('ROLLBACK');
    await c.query('BEGIN'); await c.query('ALTER TABLE return_destination_statuses DISABLE TRIGGER return_destination_status_row_guard'); await c.query('COMMIT');
    try {
      await assert.rejects(S.returnDestinationStatusOptions(f.actor), statusError(503));
      assert.equal((await f.request(prefix + '/options')).statusCode, 503);
      assert.equal((await f.request(prefix + '/previews', 'POST', null)).statusCode, 503);
    } finally { await c.query('ALTER TABLE return_destination_statuses ENABLE TRIGGER return_destination_status_row_guard'); }
    assert.deepEqual(await productCatalogFacts(f.tenant), original);
  } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
});

test('foreign table/column/function grants, owners, security mode and extra RLS policies fail closed with exact aborted repair', async () => {
  const f = await returnAssistantFixture(app), original = await productCatalogFacts(f.tenant), c = await pool.connect();
  const metadata = async () => (await c.query(`SELECT jsonb_build_object(
    'tables',(SELECT jsonb_agg(to_jsonb(x) ORDER BY x.oid) FROM (
      SELECT oid,relowner,relacl,relrowsecurity,relforcerowsecurity FROM pg_class
      WHERE relnamespace='public'::regnamespace AND relname LIKE 'return_destination_status%')x),
    'columns',(SELECT jsonb_agg(to_jsonb(x) ORDER BY x.attrelid,x.attnum) FROM (
      SELECT a.attrelid,a.attnum,a.attacl FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
      WHERE c.relnamespace='public'::regnamespace AND c.relname LIKE 'return_destination_status%' AND a.attnum>0 AND NOT a.attisdropped)x),
    'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid WHERE c.relnamespace='public'::regnamespace AND c.relname LIKE 'return_destination_status%'),
    'functions',(SELECT jsonb_agg(to_jsonb(x) ORDER BY x.oid) FROM (
      SELECT oid,proowner,proacl,prosecdef,pg_get_functiondef(oid) definition FROM pg_proc
      WHERE pronamespace='public'::regnamespace AND proname LIKE 'return_destination_status_%')x)
    ) evidence`)).rows[0].evidence;
  try {
    const beforeMetadata = await metadata();
    for (const ddl of [
      'GRANT SELECT ON return_destination_statuses TO pg_read_all_data',
      'GRANT SELECT(id) ON return_destination_statuses TO pg_read_all_data',
      'GRANT EXECUTE ON FUNCTION return_destination_status_head(uuid) TO pg_read_all_data',
      'ALTER TABLE return_destination_statuses OWNER TO pg_read_all_data',
      'ALTER FUNCTION return_destination_status_head(uuid) OWNER TO pg_read_all_data',
      'ALTER FUNCTION return_destination_status_head(uuid) SECURITY INVOKER',
      'CREATE POLICY qa161_extra_status_policy ON return_destination_statuses USING(true) WITH CHECK(true)',
    ]) {
      await c.query('BEGIN');
      try {
        await c.query(ddl);
        await assert.rejects(S.returnDestinationStatusesAvailable(c), statusError(503));
      } finally { await c.query('ROLLBACK'); }
      assert.deepEqual(await metadata(), beforeMetadata, 'DDL rollback restores every captured owner, ACL, column grant, policy and function definition');
      assert.equal(await S.returnDestinationStatusesAvailable(c), true);
      assert.deepEqual(await productCatalogFacts(f.tenant), original);
    }
  } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
});

test('genuinely absent147 is neutral on GET/HEAD options and malformed writes503 precede parse in both aliases', async () => {
  const f = await returnAssistantFixture(app), original = await productCatalogFacts(f.tenant);
  const tables = ['return_destination_statuses', 'return_destination_status_revisions', 'return_destination_status_previews', 'return_destination_status_operations', 'return_destination_status_admissions'];
  const functions = (await pool.query("SELECT oid,proname FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'return_destination_status_%' ORDER BY oid")).rows;
  assert.equal(functions.length, 16);
  const triggers = (await pool.query("SELECT oid,tgrelid,tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'return_destination_status_%' ORDER BY oid")).rows;
  assert.equal(triggers.length, 9);
  const c = await pool.connect(); let hidden = false, ledgerHidden = false;
  try {
    await c.query('BEGIN');
    for (const fn of functions) {
      const signature = (await c.query('SELECT $1::oid::regprocedure::text signature', [fn.oid])).rows[0].signature;
      await c.query(`ALTER FUNCTION ${signature} RENAME TO qa161_hidden_${fn.oid}`);
    }
    for (const trigger of triggers) {
      const relation = (await c.query('SELECT $1::oid::regclass::text relation', [trigger.tgrelid])).rows[0].relation;
      await c.query(`ALTER TRIGGER ${trigger.tgname} ON ${relation} RENAME TO qa161_hidden_trigger_${trigger.oid}`);
    }
    for (const name of tables) await c.query(`ALTER TABLE ${name} RENAME TO qa161_hidden_${name}`);
    await c.query('COMMIT'); hidden = true;
    // Removing every artifact while keeping the declared installed migration
    // is torn, rather than a legacy database with no module.
    const ledger = (await c.query("SELECT name FROM migrations WHERE name='147_return_destination_statuses'")).rows;
    if (ledger.length) {
      await assert.rejects(S.returnDestinationStatusesAvailable(), statusError(503));
      const torn = await app.inject({ url: '/api' + prefix + '/options', headers: { cookie: f.cookie } });
      assert.equal(torn.statusCode, 503);
      await c.query("UPDATE migrations SET name='qa161_hidden_147_return_destination_statuses' WHERE name='147_return_destination_statuses'");
      ledgerHidden = true;
    }
    const absent = await S.returnDestinationStatusOptions(f.actor, { intakeAvailable: true });
    assert.equal(absent.available, false); assert.equal(absent.intake_available, false,
      'Even an explicit intake capability cannot turn absent147 into an available status module');
    for (const alias of ['/api', '/api/v1']) {
      const read = await app.inject({ url: alias + prefix + '/options', headers: { cookie: f.cookie } });
      assert.equal(read.statusCode, 200); assert.equal(read.json().available, false); assert.equal(read.json().can_manage, false); assert.equal(read.json().intake_available, false); assert.deepEqual(read.json().warehouses, []);
      const head = await app.inject({ method: 'HEAD', url: alias + prefix + '/options', headers: { cookie: f.cookie } }); assert.equal(head.statusCode, 200); assert.equal(head.body, '');
      for (const path of [prefix + '/previews', prefix + '/previews/' + randomUUID() + '/commit']) {
        const write = await app.inject({ method: 'POST', url: alias + path, headers: { cookie: f.cookie, 'content-type': 'application/json' }, payload: '{' }); assert.equal(write.statusCode, 503);
      }
    }
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    if (hidden) {
      await c.query('BEGIN');
      for (const name of tables) await c.query(`ALTER TABLE qa161_hidden_${name} RENAME TO ${name}`);
      for (const trigger of triggers) {
        assert.match(trigger.tgname, /^return_destination_status_[a-z_]+$/);
        const relation = (await c.query('SELECT $1::oid::regclass::text relation', [trigger.tgrelid])).rows[0].relation;
        await c.query(`ALTER TRIGGER qa161_hidden_trigger_${trigger.oid} ON ${relation} RENAME TO ${trigger.tgname}`);
      }
      for (const fn of functions) {
        assert.match(fn.proname, /^return_destination_status_[a-z_]+$/);
        const signature = (await c.query('SELECT $1::oid::regprocedure::text signature', [fn.oid])).rows[0].signature;
        await c.query(`ALTER FUNCTION ${signature} RENAME TO ${fn.proname}`);
      }
      if (ledgerHidden) await c.query("UPDATE migrations SET name='147_return_destination_statuses' WHERE name='qa161_hidden_147_return_destination_statuses'");
      await c.query('COMMIT');
    }
    c.release();
  }
  assert.equal(await S.returnDestinationStatusesAvailable(), true); assert.deepEqual(await productCatalogFacts(f.tenant), original);
});

test('actual restore-cookie reads false controls and malformed config writes423 precede parsing normal/v1', async () => {
  const f = await returnAssistantFixture(app), p = (await S.previewReturnDestinationStatus(f.actor, create(f))).preview;
  const restored = await buildApp({ readOnly: true, previewPort: 4198, integrationTransport: async () => { throw Error('No transport in copy'); } });
  try {
    assert.equal((await restored.inject({ url: '/api' + prefix + '/options', headers: { cookie: f.cookie } })).statusCode, 401);
    const login = await restored.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' } }); assert.equal(login.statusCode, 200);
    const sw = await restored.inject({ method: 'POST', url: '/api/workspaces/switch', headers: { cookie: String(login.headers['set-cookie']).split(';')[0] }, payload: { tenant_id: f.tenant } }); assert.equal(sw.statusCode, 200);
    const cookie = String(sw.headers['set-cookie']).split(';')[0], original = await productCatalogFacts(f.tenant);
    for (const alias of ['/api', '/api/v1']) {
      for (const path of [prefix + '/previews', prefix + '/previews/' + p.id + '/commit']) {
        const reply = await restored.inject({ method: 'POST', url: alias + path, headers: { cookie, 'content-type': 'application/json' }, payload: '{' }); assert.equal(reply.statusCode, 423);
      }
      const read = await restored.inject({ url: alias + prefix + '/previews/' + p.id, headers: { cookie } }); assert.equal(read.statusCode, 200);
      assert.equal(read.json().read_only, true); assert.equal(read.json().can_manage, false); assert.equal(read.json().preview.can_commit, false);
    }
    assert.deepEqual(await productCatalogFacts(f.tenant), original);
  } finally { await restored.close(); }
});
