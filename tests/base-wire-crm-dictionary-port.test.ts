/** Real crm.ts parse/apply/prior/receipt code on explicit CLOSED query ports.
 * No PG, real SQL authority/RLS, migration219, registered route or activation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as crypto from 'node:crypto';
import { transformSync } from 'esbuild';
import { z } from 'zod';
import { ensure, Problem } from '../server/errors';
import { createBaseWireCrmDictionariesService } from '../server/base-wire-crm-dictionaries';

const uid = (n: number) => `72000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function load(file: string, ports: Record<string, any>) {
  const module = { exports: {} as any };
  const code = transformSync(readFileSync(new URL('../server/' + file, import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs', target: 'node24' }).code;
  new Function('require', 'module', 'exports', code)((key: string) => {
    assert(Object.hasOwn(ports, key), 'Unexpected runtime import ' + key); return ports[key];
  }, module, module.exports);
  return module.exports;
}
const authority = load('base-wire-crm-authority.ts', { './errors': { ensure } });
const schema = load('crm-schema.ts', { zod: { z } });
const fields = load('crm-field-definitions.ts', { zod: { z }, './errors': { ensure } });
const forbidden = () => assert.fail('No ambient DB/crypto integration allowed in this closed test');

function fixture() {
  const tenants = [uid(1), uid(2)], actors = tenants.map((tenantId, i) => ({ tenantId, userId: uid(3 + i), apiKeyId: uid(5 + i), role: 'admin', source: 'api' }));
  let state: any = { groups: [], statuses: [], clients: [], maps: [], commands: [], audit: [], orders: [{ id: uid(30), tenant_id: tenants[0], total: '12.30', historical: { name: 'Same buyer' } }] };
  for (let i = 0; i < 2; i++) {
    state.groups.push({ id: uid(10 + i), tenant_id: tenants[i], name: 'Główna', is_main_group: true, version: 1 });
    state.statuses.push({ id: uid(20 + i), tenant_id: tenants[i], name: 'Nowy', color: '#64748b', group_id: uid(10 + i), is_primary: true, position: 0, version: 1 });
    state.maps.push({ kind: 'group', tenant_id: tenants[i], resource_id: uid(10 + i), local_id: uid(10 + i), public_id: String(i + 1) });
    state.maps.push({ kind: 'status', tenant_id: tenants[i], resource_id: uid(20 + i), local_id: uid(20 + i), public_id: String(i + 1) });
  }
  let next = 100, groupSeq = 10, statusSeq = 10, current = actors[0], reading = false;
  const flags = { installed219: true, revoked: false, journalFailure: false, loseCommitAck: false };
  const queries: { sql: string; args: any[]; reading: boolean }[] = [];
  const own = (row: any) => row.tenant_id === current.tenantId;
  const out = (rows: any[]) => ({ rows: structuredClone(rows), rowCount: rows.length });
  const allocate = (kind: string, row: any) => state.maps.push({ kind, tenant_id: row.tenant_id, resource_id: row.id, local_id: row.id, public_id: String(kind === 'group' ? groupSeq++ : statusSeq++) });
  const c: any = { query: async (sql: string, args: any[] = []) => {
    queries.push({ sql, args: structuredClone(args), reading });
    if (reading) assert(/^SELECT/.test(sql) && !/FOR (UPDATE|SHARE)|advisory/.test(sql), 'GET stays SELECT-only without write locks');
    if (sql.startsWith('SELECT public.base_wire218_authority')) {
      const actor = actors.find(a => a.tenantId === current.tenantId && a.userId === args[0] && a.apiKeyId === args[1]);
      return out([{ role: actor && !flags.revoked ? 'admin' : null }]);
    }
    if (sql.startsWith("SELECT to_regclass('public.base_wire218_status_ids')")) return out([{ status_ready: true, group_ready: flags.installed219 }]);
    if (sql.startsWith('SELECT pg_advisory_xact_lock')) { assert.equal(args[0], 'crm215:' + current.tenantId); return out([]); }
    if (sql === 'SELECT * FROM crm_commands WHERE client_key=$1') return out(state.commands.filter((row: any) => own(row) && row.client_key === args[0]));
    if (sql.startsWith('INSERT INTO crm_commands')) {
      if (flags.journalFailure || state.commands.some((r: any) => own(r) && r.client_key === args[1])) return out([]);
      state.commands.push({ tenant_id: args[0], client_key: args[1], actor_id: args[2], request_hash: args[3], request: JSON.parse(args[4]), response: JSON.parse(args[5]) });
      return out([{ client_key: args[1] }]);
    }
    const mapping = /FROM base_wire(218_status|219_group)_ids/.exec(sql);
    if (mapping) {
      assert.equal(args[0], current.tenantId); const kind = mapping[1] === '218_status' ? 'status' : 'group';
      const rows = state.maps.filter((m: any) => own(m) && m.kind === kind && (sql.startsWith('SELECT local_id') ? m.public_id === String(args[1]) && m.local_id !== null : m.resource_id === args[1]));
      return out(rows.map((m: any) => sql.startsWith('SELECT local_id') ? { local_id: m.local_id } : { public_id: m.public_id }));
    }
    if (sql === 'SELECT * FROM crm_status_groups ORDER BY is_main_group DESC,name,id') return out(state.groups.filter(own));
    if (sql === 'SELECT * FROM crm_statuses ORDER BY group_id,position,id') return out(state.statuses.filter(own));
    if (sql === 'SELECT id FROM crm_status_groups WHERE is_main_group') return out(state.groups.filter((r: any) => own(r) && r.is_main_group).map((r: any) => ({ id: r.id })));
    if (sql === 'SELECT * FROM crm_status_groups WHERE is_main_group FOR UPDATE') return out(state.groups.filter((r: any) => own(r) && r.is_main_group));
    if (sql === 'SELECT * FROM crm_status_groups WHERE id=$1 FOR UPDATE') return out(state.groups.filter((r: any) => own(r) && r.id === args[0]));
    if (sql === 'SELECT * FROM crm_statuses WHERE id=$1 FOR UPDATE') return out(state.statuses.filter((r: any) => own(r) && r.id === args[0]));
    if (sql === 'SELECT id FROM crm_status_groups WHERE id=$1 FOR SHARE') return out(state.groups.filter((r: any) => own(r) && r.id === args[0]).map((r: any) => ({ id: r.id })));
    if (sql === 'SELECT id FROM crm_statuses WHERE id=$1 FOR SHARE') return out(state.statuses.filter((r: any) => own(r) && r.id === args[0]).map((r: any) => ({ id: r.id })));
    if (sql === 'SELECT coalesce(max(position),-1)+1 AS position FROM crm_statuses WHERE group_id=$1') return out([{ position: Math.max(-1, ...state.statuses.filter((r: any) => own(r) && r.group_id === args[0]).map((r: any) => r.position)) + 1 }]);
    if (sql === 'INSERT INTO crm_status_groups(tenant_id,name) VALUES($1,$2) RETURNING *') {
      const row = { id: uid(next++), tenant_id: args[0], name: args[1], is_main_group: false, version: 1 }; state.groups.push(row); allocate('group', row); return out([row]);
    }
    if (sql.startsWith('INSERT INTO crm_statuses(tenant_id,group_id,name,color,position)')) {
      const row = { id: uid(next++), tenant_id: args[0], group_id: args[1], name: args[2], color: args[3], is_primary: false, version: 1,
        position: Math.max(-1, ...state.statuses.filter((r: any) => own(r) && r.group_id === args[1]).map((r: any) => r.position)) + 1 };
      state.statuses.push(row); allocate('status', row); return out([row]);
    }
    if (sql === 'UPDATE crm_status_groups SET name=$2,version=version+1 WHERE id=$1 RETURNING *') {
      const row = state.groups.find((r: any) => own(r) && r.id === args[0]); assert(row); row.name = args[1]; row.version++; return out([row]);
    }
    if (sql === 'UPDATE crm_statuses SET name=$2,color=$3,group_id=$4,position=$5,version=version+1 WHERE id=$1 RETURNING *') {
      const row = state.statuses.find((r: any) => own(r) && r.id === args[0]); assert(row); Object.assign(row, { name: args[1], color: args[2], group_id: args[3], position: args[4], version: row.version + 1 }); return out([row]);
    }
    if (sql === 'UPDATE crm_clients SET status_id=$2,version=version+1,updated_at=clock_timestamp() WHERE status_id=$1') {
      for (const row of state.clients.filter((r: any) => own(r) && r.status_id === args[0])) Object.assign(row, { status_id: args[1], version: row.version + 1, updated_at: '2026-10-19T12:00:00Z' }); return out([]);
    }
    if (sql.startsWith('WITH moved AS (SELECT id,row_number() OVER(ORDER BY position,id)')) {
      let position = Math.max(-1, ...state.statuses.filter((r: any) => own(r) && r.group_id === args[1]).map((r: any) => r.position)) + 1;
      for (const row of state.statuses.filter((r: any) => own(r) && r.group_id === args[0]).sort((a: any, b: any) => a.position - b.position || a.id.localeCompare(b.id))) Object.assign(row, { group_id: args[1], position: position++, version: row.version + 1 }); return out([]);
    }
    if (sql === 'DELETE FROM crm_statuses WHERE id=$1' || sql === 'DELETE FROM crm_status_groups WHERE id=$1') {
      const kind = sql.includes('crm_status_groups') ? 'group' : 'status', rows = kind === 'group' ? 'groups' : 'statuses';
      state[rows] = state[rows].filter((r: any) => !(own(r) && r.id === args[0]));
      const map = state.maps.find((r: any) => own(r) && r.kind === kind && r.resource_id === args[0]); assert(map); map.local_id = null; return out([]);
    }
    assert.fail('Unexpected actual CRM query: ' + sql);
  } };
  const crm = load('crm.ts', {
    'node:crypto': crypto, zod: { z }, './errors': { ensure }, './base-wire-crm-authority': authority,
    './db': { tenantTx: forbidden, tenantReadTx: forbidden }, './security': { encrypt: forbidden, decrypt: forbidden }, './crm-schema': schema,
    './crm-field-definitions': fields, './domain': { audit: async (_client: any, actor: any, action: string, resource: string, data: any) => {
      assert.equal(_client, c); assert.equal(actor.tenantId, current.tenantId); state.audit.push({ actor: structuredClone(actor), action, resource, data });
    } },
  });
  function service(actor = actors[0]) {
    return createBaseWireCrmDictionariesService({ async transaction(writing, work) {
      current = actor; reading = !writing; const snapshot = structuredClone(state); let result;
      try {
        const proof = await authority.authorizeBaseWireCrmInTx(c, actor, writing);
        result = await work(crm.createCrmDictionaryWirePort(c, actor, proof));
      } catch (error) { state = snapshot; throw error; } finally { reading = false; }
      if (flags.loseCommitAck) { flags.loseCommitAck = false; throw new Error('Lost closed COMMIT ACK'); }
      return result;
    } });
  }
  return { service, crm, authority, c, actors, flags, queries, get state() { return state; }, async proof(writing: boolean) { current = actors[0]; return authority.authorizeBaseWireCrmInTx(c, actors[0], writing); } };
}
const isProblem = (status: number) => (e: unknown) => e instanceof Problem && e.status === status;

test('additive native port requires the real client-bound proof and explicitly refuses the absent219 dependency before DML', async () => {
  const f = fixture();
  const forged = f.crm.createCrmDictionaryWirePort(f.c, f.actors[0], Object.freeze({ writing: true }));
  await assert.rejects(forged.groups(), isProblem(403)); assert.equal(f.queries.length, 0);
  const proof = await f.proof(true);
  await assert.rejects(f.crm.createCrmDictionaryWirePort({ query: forbidden }, f.actors[0], proof).groups(), isProblem(403));
  await assert.rejects(f.crm.createCrmDictionaryWirePort(f.c, { ...f.actors[0], apiKeyId: uid(800) }, proof).groups(), isProblem(403));
  f.flags.installed219 = false; const before = structuredClone(f.state);
  await assert.rejects(f.service().execute('getCrmClientStatuses', {}), isProblem(503));
  await assert.rejects(f.service().execute('addCrmClientStatusGroup', { name: 'Blocked' }), isProblem(503));
  assert.deepEqual(f.state, before); assert(!f.queries.some(q => /^(INSERT|UPDATE|DELETE)/.test(q.sql)));
});

test('real native apply/parser/journal create and patch the same dictionaries using locked current versions; readonly GETs never allocate', async () => {
  const f = fixture(), service = f.service();
  const group = await service.execute('addCrmClientStatusGroup', { name: 'Obsługa' });
  const local = f.state.groups.find((g: any) => g.name === 'Obsługa'); local.version = 7;
  await service.execute('addCrmClientStatusGroup', { group_id: group.group_id, name: 'VIP' });
  const patch = f.state.commands.find((j: any) => j.request.method === 'PATCH');
  assert.equal(patch.request.body.version, 7); assert.equal(patch.response.data.version, 8);
  const status = await service.execute('addCrmClientStatus', { name: 'Oczekuje', color: '#112233', group_id: group.group_id });
  await service.execute('addCrmClientStatus', { status_id: status.status_id, color: '#ABCDEF' });
  const saved = f.state.statuses.find((s: any) => s.name === 'Oczekuje'); assert.equal(saved.color, '#ABCDEF'); assert.equal(saved.group_id, local.id);
  assert(f.state.audit.some((a: any) => a.action === 'crm.status-groups.patch'));
  const before = structuredClone(f.state), start = f.queries.length;
  assert.deepEqual(await service.execute('getCrmClientStatusGroups', {}), { status_groups: [{ group_id: 1, name: 'Główna', is_main_group: 1 }, { group_id: group.group_id, name: 'VIP', is_main_group: 0 }] });
  assert.equal((await service.execute('getCrmClientStatuses', {})).statuses instanceof Array, true);
  assert.deepEqual(f.state, before); assert(f.queries.slice(start).every(q => q.reading && /^SELECT/.test(q.sql)));
  assert(f.queries.slice(start).some(q => q.sql.includes('resource_id=$2::uuid')));
});

test('real native status/group deletion delegates all transfers/protection and rolls back effects on journal failure', async () => {
  const f = fixture(), service = f.service();
  const group = await service.execute('addCrmClientStatusGroup', { name: 'Grupa' });
  const status = await service.execute('addCrmClientStatus', { name: 'Przenoszony', color: '#112233', group_id: group.group_id });
  const local = f.state.statuses.find((s: any) => s.name === 'Przenoszony');
  for (const deleted_at of [null, '2026-10-18T00:00:00Z']) f.state.clients.push({ id: uid(deleted_at ? 501 : 500), tenant_id: f.actors[0].tenantId,
    status_id: local.id, profile: { notes: 'Whole old profile' }, version: 3, deleted_at, updated_at: '2026-10-18T00:00:00Z' });
  const before = structuredClone(f.state); f.flags.journalFailure = true;
  await assert.rejects(service.execute('deleteCrmClientStatus', { status_id: status.status_id, target_status_id: 1 }), isProblem(409));
  assert.deepEqual(f.state, before, 'Actual apply changes and missing journal ACK roll back in the caller transaction');
  f.flags.journalFailure = false;
  await assert.rejects(service.execute('deleteCrmClientStatus', { status_id: 1, target_status_id: status.status_id }), isProblem(409));
  assert.deepEqual(f.state, before, 'The actual native primary-status refusal retains all rows');
  await service.execute('deleteCrmClientStatusGroup', { group_id: group.group_id });
  assert.deepEqual(f.state.clients, before.clients); assert.equal(f.state.statuses.find((s: any) => s.id === local.id).group_id, uid(10));
  await service.execute('deleteCrmClientStatus', { status_id: status.status_id, target_status_id: 1 });
  assert.deepEqual(f.state.clients, before.clients.map((c: any) => ({ ...c, status_id: uid(20), version: 4, updated_at: '2026-10-19T12:00:00Z' })));
  assert.deepEqual(f.state.orders, before.orders);
  const final = structuredClone(f.state);
  await assert.rejects(service.execute('deleteCrmClientStatusGroup', { group_id: 1 }), isProblem(409));
  await assert.rejects(service.execute('deleteCrmClientStatus', { status_id: 1, target_status_id: 2 }), isProblem(404));
  assert.deepEqual(f.state, final);
});

test('retained original journal replays after physical tombstones without live lookup or a second native mutation', async () => {
  const f = fixture(), service = f.service(), key = crypto.randomUUID(), body = { name: 'Original' };
  f.flags.loseCommitAck = true;
  await assert.rejects(service.execute('addCrmClientStatusGroup', body, { clientKey: key }), /Lost closed COMMIT ACK/);
  const created = await service.execute('addCrmClientStatusGroup', body, { clientKey: key });
  await service.execute('deleteCrmClientStatusGroup', { group_id: created.group_id });
  const before = structuredClone(f.state), start = f.queries.length;
  assert.deepEqual(await service.execute('addCrmClientStatusGroup', body, { clientKey: key }), created);
  assert.deepEqual(f.state, before);
  assert(!f.queries.slice(start).some(q => /FOR UPDATE|^(INSERT|UPDATE|DELETE)|SELECT local_id/.test(q.sql)));
  assert(f.queries.slice(start).some(q => q.sql.includes('resource_id=$2::uuid')));
  const original = f.state.commands.find((j: any) => j.client_key === key);
  original.response.data.name = 'Tampered';
  await assert.rejects(service.execute('addCrmClientStatusGroup', body, { clientKey: key }), isProblem(503));
});

test('fresh authority and actor/key/original-hash custody guard replay and foreign dictionary writes', async () => {
  const f = fixture(), service = f.service(), key = crypto.randomUUID(), body = { name: 'Retained' };
  await service.execute('addCrmClientStatusGroup', body, { clientKey: key }); const before = structuredClone(f.state);
  await assert.rejects(service.execute('addCrmClientStatusGroup', { name: 'Other' }, { clientKey: key }), isProblem(409));
  const readProof = await f.proof(false), readPort = f.crm.createCrmDictionaryWirePort(f.c, f.actors[0], readProof);
  await assert.rejects(readPort.replay({ clientKey: key, method: 'addCrmClientStatusGroup', wireHash: 'a'.repeat(64) }), isProblem(403));
  const proof = await f.proof(true);
  const actor = { ...f.actors[0], apiKeyId: uid(700) };
  const alternate = await f.authority.authorizeBaseWireCrmInTx(f.c, f.actors[0], true);
  await assert.rejects(f.crm.createCrmDictionaryWirePort(f.c, actor, alternate).replay({ clientKey: key, method: 'addCrmClientStatusGroup', wireHash: 'a'.repeat(64) }), isProblem(403));
  assert(proof);
  await assert.rejects(service.execute('addCrmClientStatusGroup', { group_id: 2, name: 'Foreign' }), isProblem(404));
  f.flags.revoked = true;
  await assert.rejects(service.execute('addCrmClientStatusGroup', body, { clientKey: key }), isProblem(403));
  assert.deepEqual(f.state, before);
});
