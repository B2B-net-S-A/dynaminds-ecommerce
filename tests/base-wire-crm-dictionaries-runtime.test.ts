/** Actual runtime + adapter + SQL-authority proof + native CRM port on CLOSED
 * transactions/query ports. No real DB/RLS/MFA execution, route or activation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as crypto from 'node:crypto';
import { transformSync } from 'esbuild';
import { z } from 'zod';
import { ensure, Problem } from '../server/errors';
import { createBaseWireCrmDictionariesService, BASE_WIRE_CRM_DICTIONARY_METHODS, isBaseWireCrmDictionaryWrite } from '../server/base-wire-crm-dictionaries';
import type { Actor } from '../server/domain';

function load(file: string, imports: Record<string, any>) {
  const module = { exports: {} as any };
  const source = readFileSync(new URL('../server/' + file, import.meta.url), 'utf8');
  const code = transformSync(source, { loader: 'ts', format: 'cjs', target: 'node24' }).code;
  new Function('require', 'module', 'exports', code)((name: string) => {
    assert(Object.hasOwn(imports, name), 'Unexpected runtime import ' + name);
    return imports[name];
  }, module, module.exports);
  return module.exports;
}
const authority = load('base-wire-crm-authority.ts', { './errors': { ensure } });
const schema = load('crm-schema.ts', { zod: { z } });
const fields = load('crm-field-definitions.ts', { zod: { z }, './errors': { ensure } });
const forbidden = () => assert.fail('Ambient database/credential IO forbidden');
const uid = (n: number) => `79000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const isProblem = (status: number) => (error: unknown) => error instanceof Problem && error.status === status;

function fixture() {
  const actors: Actor[] = [0, 1].map(i => ({ tenantId: uid(i + 1), userId: uid(i + 3), apiKeyId: uid(i + 5), role: 'admin', source: 'api' }));
  let state: any = {
    groups: [
      { id: uid(10), tenant_id: uid(1), name: 'Główna', is_main_group: true, version: 1 },
      { id: uid(11), tenant_id: uid(1), name: 'Original', is_main_group: false, version: 7 },
      { id: uid(12), tenant_id: uid(2), name: 'Foreign', is_main_group: true, version: 1 },
    ],
    statuses: [0, 1].map(i => ({ id: uid(20 + i), tenant_id: actors[i].tenantId, name: 'Nowy', color: '#112233', group_id: uid(i ? 12 : 10), is_primary: true, position: 0, version: 1 })),
    commands: [], audits: [], maps: [
      { kind: 'group', tenant_id: uid(1), resource_id: uid(10), local_id: uid(10), public_id: '1' },
      { kind: 'group', tenant_id: uid(1), resource_id: uid(11), local_id: uid(11), public_id: '2' },
      { kind: 'group', tenant_id: uid(2), resource_id: uid(12), local_id: uid(12), public_id: '3' },
      ...[0, 1].map(i => ({ kind: 'status', tenant_id: actors[i].tenantId, resource_id: uid(20 + i), local_id: uid(20 + i), public_id: String(i + 1) })),
    ],
  };
  const policy = { role: 'admin' as string | null, revoked: false, mfa: true, readScope: true, writeScope: true, installed219: true, loseCommitAck: false };
  const log: { event: string; sql?: string; args?: unknown[]; reading?: boolean }[] = [];
  let tenant = '', reading = false;
  const own = (row: any) => row.tenant_id === tenant;
  const out = (rows: any[]) => ({ rows: structuredClone(rows), rowCount: rows.length });
  const c: any = { query: async (sql: string, args: any[] = []) => {
    log.push({ event: 'query', sql, args: structuredClone(args), reading });
    if (reading) assert(/^SELECT/.test(sql) && !/FOR (UPDATE|SHARE)|advisory/.test(sql), 'Reader cannot lock or write');
    if (sql.startsWith('SELECT pg_advisory_xact_lock')) {
      assert.equal(args[0], 'crm215:' + tenant); log.push({ event: 'mutex' }); return out([]);
    }
    if (sql.startsWith('SELECT public.base_wire218_authority')) {
      log.push({ event: 'authority' });
      const actor = actors.find(a => a.tenantId === tenant && a.userId === args[0] && a.apiKeyId === args[1]);
      const allowed = actor && !policy.revoked && policy.mfa && policy.readScope && (!args[2] || policy.writeScope);
      return out([{ role: allowed ? policy.role : null }]);
    }
    if (sql.startsWith("SELECT to_regclass('public.base_wire218_status_ids')"))
      return out([{ status_ready: true, group_ready: policy.installed219 }]);
    if (sql === 'SELECT * FROM crm_status_groups ORDER BY is_main_group DESC,name,id') return out(state.groups.filter(own));
    if (sql === 'SELECT * FROM crm_statuses ORDER BY group_id,position,id') return out(state.statuses.filter(own));
    if (sql === 'SELECT * FROM crm_commands WHERE client_key=$1') return out(state.commands.filter((row: any) => own(row) && row.client_key === args[0]));
    const mapping = /FROM base_wire(218_status|219_group)_ids/.exec(sql);
    if (mapping) {
      assert.equal(args[0], tenant);
      const kind = mapping[1] === '218_status' ? 'status' : 'group';
      const rows = state.maps.filter((row: any) => own(row) && row.kind === kind && (sql.startsWith('SELECT local_id')
        ? row.public_id === String(args[1]) && row.local_id !== null : row.resource_id === args[1]));
      return out(rows.map((row: any) => sql.startsWith('SELECT local_id') ? { local_id: row.local_id } : { public_id: row.public_id }));
    }
    if (sql === 'SELECT * FROM crm_status_groups WHERE id=$1 FOR UPDATE') return out(state.groups.filter((row: any) => own(row) && row.id === args[0]));
    if (sql === 'UPDATE crm_status_groups SET name=$2,version=version+1 WHERE id=$1 RETURNING *') {
      const row = state.groups.find((row: any) => own(row) && row.id === args[0]); assert(row);
      row.name = args[1]; row.version++; return out([row]);
    }
    if (sql.startsWith('INSERT INTO crm_commands')) {
      assert(!state.commands.some((row: any) => own(row) && row.client_key === args[1]));
      state.commands.push({ tenant_id: args[0], client_key: args[1], actor_id: args[2], request_hash: args[3], request: JSON.parse(args[4]), response: JSON.parse(args[5]) });
      return out([{ client_key: args[1] }]);
    }
    assert.fail('Unexpected closed query ' + sql);
  } };
  const tx = (read: boolean) => async <T>(tenantId: string, work: (client: any) => Promise<T>): Promise<T> => {
    tenant = tenantId; reading = read; log.push({ event: read ? 'read-tx' : 'write-tx' });
    const previous = structuredClone(state); let result: T;
    try { result = await work(c); }
    catch (error) { state = previous; log.push({ event: 'rollback' }); throw error; }
    finally { reading = false; }
    log.push({ event: 'commit' });
    if (policy.loseCommitAck) { policy.loseCommitAck = false; throw new Error('Lost closed commit ACK'); }
    return result;
  };
  const crm = load('crm.ts', {
    'node:crypto': crypto, zod: { z }, './errors': { ensure }, './base-wire-crm-authority': authority,
    './db': { tenantTx: forbidden, tenantReadTx: forbidden }, './security': { encrypt: forbidden, decrypt: forbidden },
    './crm-schema': schema, './crm-field-definitions': fields,
    './domain': { audit: async (client: any, actor: Actor, action: string, id: string, detail: unknown) => {
      assert.equal(client, c); assert.equal(actor.tenantId, tenant); state.audits.push({ tenant_id: tenant, action, id, detail });
    } },
  });
  const db = { tenantTx: tx(false), tenantReadTx: tx(true) };
  const runtime = load('base-wire-crm-dictionaries-runtime.ts', {
    './db': db, './crm': crm, './base-wire-crm-authority': authority, './errors': { ensure },
    './base-wire-crm-dictionaries': { createBaseWireCrmDictionariesService, BASE_WIRE_CRM_DICTIONARY_METHODS, isBaseWireCrmDictionaryWrite },
  });
  const capabilities = { crm218Verified: true, dictionary219Verified: true, readOnly: false };
  return {
    actors, log, policy, capabilities, get state() { return state; },
    service: (caps: any = capabilities) => runtime.createBaseWireCrmDictionaryRuntime(caps),
  };
}

test('both validated startup capabilities are required; readonly writes and malformed flags have no transaction effects', async () => {
  const f = fixture();
  for (const flag of ['crm218Verified', 'dictionary219Verified']) {
    await assert.rejects(f.service({ ...f.capabilities, [flag]: false }).execute(f.actors[0], 'getCrmClientStatusGroups', {}), isProblem(503));
    assert.throws(() => f.service({ ...f.capabilities, [flag]: 'true' }), isProblem(503));
  }
  for (const method of ['addCrmClientStatusGroup', 'addCrmClientStatus', 'deleteCrmClientStatusGroup', 'deleteCrmClientStatus'])
    await assert.rejects(f.service({ ...f.capabilities, readOnly: true }).execute(f.actors[0], method, {}), isProblem(423));
  await assert.rejects(f.service().execute(f.actors[0], 'getCrmClients', {}), isProblem(400));
  assert.deepEqual(f.log, []);
  assert.equal(f.state.commands.length, 0);
});

test('production-default composition reads the real native dictionary port in tenantReadTx without allocation, even in readonly', async () => {
  const f = fixture(), before = structuredClone(f.state), service = f.service({ ...f.capabilities, readOnly: true });
  assert.deepEqual(await service.execute(f.actors[0], 'getCrmClientStatusGroups', {}), {
    status_groups: [{ group_id: 1, name: 'Główna', is_main_group: 1 }, { group_id: 2, name: 'Original', is_main_group: 0 }],
  });
  assert.deepEqual(await service.execute(f.actors[1], 'getCrmClientStatuses', {}), {
    statuses: [{ id: 2, name: 'Nowy', color: '#112233', group_id: 3, is_primary: 1 }],
  });
  assert.deepEqual(f.state, before);
  assert.equal(f.log.filter(row => row.event === 'read-tx').length, 2);
  assert(!f.log.some(row => row.event === 'write-tx' || row.event === 'mutex'));
  assert(f.log.filter(row => row.sql).every(row => row.reading && /^SELECT/.test(row.sql!)));
});

test('write mutex precedes actual SQL authority and native patch/journal/audit in the same transaction', async () => {
  const f = fixture(), key = uid(100);
  assert.deepEqual(await f.service().execute(f.actors[0], 'addCrmClientStatusGroup', { group_id: 2, name: 'Updated' }, { clientKey: key }), { group_id: 2 });
  assert.deepEqual(f.log.filter(row => ['write-tx', 'mutex', 'authority'].includes(row.event)).slice(0, 3).map(row => row.event), ['write-tx', 'mutex', 'authority']);
  const saved = f.state.groups.find((row: any) => row.id === uid(11));
  assert.equal(saved.name, 'Updated'); assert.equal(saved.version, 8);
  assert.equal(f.state.commands.length, 1); assert.equal(f.state.audits.length, 1);
  assert.equal(f.state.commands[0].request.body.version, 7);
  assert.equal(f.state.commands[0].request.wire_api_key_id, f.actors[0].apiKeyId);
});

test('fresh shared SQL authority denies revoked keys, missing scopes/MFA and changed role before native access or replay', async () => {
  for (const [flag, value] of [['revoked', true], ['mfa', false], ['readScope', false], ['writeScope', false], ['role', 'operator']] as const) {
    const f = fixture(), before = structuredClone(f.state); (f.policy as any)[flag] = value;
    await assert.rejects(f.service().execute(f.actors[0], 'addCrmClientStatusGroup', { group_id: 2, name: 'Denied' }), isProblem(403));
    assert.deepEqual(f.state, before);
    const queries = f.log.filter(row => row.sql);
    assert.equal(queries.length, 2); assert(queries[0].sql!.includes('advisory')); assert(queries[1].sql!.includes('base_wire218_authority'));
    assert.deepEqual(queries[1].args, [f.actors[0].userId, f.actors[0].apiKeyId, true]);
  }
  const f = fixture(); f.policy.readScope = false;
  await assert.rejects(f.service().execute(f.actors[0], 'getCrmClientStatuses', {}), isProblem(403));
  assert(!f.log.some(row => row.event === 'mutex'));
});

test('lost ACK replays through fresh authority and the real journal after tombstone without a second native write', async () => {
  const f = fixture(), service = f.service(), key = uid(101), body = { group_id: 2, name: 'Retained' };
  f.policy.loseCommitAck = true;
  await assert.rejects(service.execute(f.actors[0], 'addCrmClientStatusGroup', body, { clientKey: key }), /Lost closed commit ACK/);
  assert.equal(f.state.commands.length, 1);
  f.state.groups = f.state.groups.filter((row: any) => row.id !== uid(11));
  f.state.maps.find((row: any) => row.resource_id === uid(11)).local_id = null;
  const before = structuredClone(f.state), cut = f.log.length;
  assert.deepEqual(await service.execute(f.actors[0], 'addCrmClientStatusGroup', body, { clientKey: key }), { group_id: 2 });
  assert.deepEqual(f.state, before);
  assert(!f.log.slice(cut).some(row => row.sql && /^(INSERT|UPDATE|DELETE)|FOR UPDATE|SELECT local_id/.test(row.sql)));
  f.policy.revoked = true;
  await assert.rejects(service.execute(f.actors[0], 'addCrmClientStatusGroup', body, { clientKey: key }), isProblem(403));
  assert.deepEqual(f.state, before);
});

test('actual port refuses absent219 despite stale startup capability; foreign IDs and session actors cannot write', async () => {
  const f = fixture(), before = structuredClone(f.state); f.policy.installed219 = false;
  await assert.rejects(f.service().execute(f.actors[0], 'getCrmClientStatuses', {}), isProblem(503));
  assert.deepEqual(f.state, before);
  f.policy.installed219 = true;
  await assert.rejects(f.service().execute(f.actors[0], 'addCrmClientStatusGroup', { group_id: 3, name: 'Foreign' }), isProblem(404));
  await assert.rejects(f.service().execute({ ...f.actors[0], source: 'manual' }, 'addCrmClientStatusGroup', { group_id: 2, name: 'Session' }), isProblem(403));
  assert.deepEqual(f.state, before);
});
