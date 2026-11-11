/** Stateful CLOSED dictionary port + real adapter/codec. Not native CRM/PG,
 * authorization, a registered route, migration219 or vendor acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { Problem } from '../server/errors';
import { decodeBaseWireRequest, encodeBaseWireSuccess, type BaseWireJson } from '../server/base-wire-codec';
import { BASE_WIRE_CRM_DICTIONARY_METHODS as METHODS, createBaseWireCrmDictionariesService,
  isBaseWireCrmDictionaryWrite, type BaseWireCrmDictionaryPort, type CrmDictionaryCommand,
  type CrmDictionaryReceipt, type CrmWireGroup, type CrmWireStatus, type DictionaryKind } from '../server/base-wire-crm-dictionaries';

const uuid = (n: number) => `71000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const copy = structuredClone;
type Group = CrmWireGroup & { tenant: string };
type Status = CrmWireStatus & { tenant: string };
type Client = { id: string; tenant: string; status_id: string; version: number; deleted: boolean; profile: { notes: string } };
type MapRow = { kind: DictionaryKind; tenant: string; resource: string; local: string | null; public: string };
type Journal = { tenant: string; actor: string; key: string; command: CrmDictionaryCommand; receipt: CrmDictionaryReceipt };

function fixture() {
  const tenants = ['A', 'B'], initialGroups: Group[] = tenants.map((tenant, i) => ({ tenant, id: uuid(i + 1), name: 'Główna', is_main_group: 1, version: 1 }));
  const initialStatuses: Status[] = tenants.map((tenant, i) => ({ tenant, id: uuid(i + 3), name: 'Nowy', color: '#64748b', group_id: initialGroups[i].id, is_primary: 1, position: 0, version: 1 }));
  let state = {
    groups: initialGroups, statuses: initialStatuses, clients: [] as Client[],
    maps: [ ...initialGroups.map((g, i) => ({ kind: 'group' as const, tenant: g.tenant, resource: g.id, local: g.id, public: String(i + 1) })),
      ...initialStatuses.map((s, i) => ({ kind: 'status' as const, tenant: s.tenant, resource: s.id, local: s.id, public: String(i + 1) })) ] as MapRow[],
    journal: [] as Journal[], audit: [] as { tenant: string; method: string; resource: string }[],
    orders: [{ id: uuid(8), tenant: 'A', total: '12.30', buyer: { name: 'Historical' }, client_id: uuid(9) }],
  };
  // Allocation counters are deliberately outside the rollback snapshot: a real
  // identity sequence may have gaps, and no test promises rollback reuse.
  let nextResource = 100, nextGroup = 10, nextStatus = 10;
  let failJournal = false, loseCommitAck = false;
  const calls: { tenant: string; writing: boolean; operation: string }[] = [];
  function session(tenant = 'A', actor = 'admin', key = 'key-1') {
    const policy = { revoked: false, readOnly: false, role: 'admin' };
    const service = createBaseWireCrmDictionariesService({
      async transaction(writing, work) {
        calls.push({ tenant, writing, operation: 'EXTERNAL_AUTHORITY' });
        // Explicit test double for the external integration boundary, not a
        // replacement for the real218 SQL authority/WeakMap proof.
        if (policy.revoked) throw new Problem(403, 'Closed authority revoked');
        if (writing && policy.readOnly) throw new Problem(423, 'Closed preview');
        if (writing && policy.role !== 'admin') throw new Problem(403, 'Closed role');
        const saved = copy(state); let active = true;
        const mark = (operation: string, write = false) => {
          assert(active); assert(!write || writing, 'No writes on a dictionary GET'); calls.push({ tenant, writing, operation });
        };
        const live = (kind: DictionaryKind, id: string) => {
          const row = (kind === 'group' ? state.groups : state.statuses).find(r => r.tenant === tenant && r.id === id);
          if (!row) throw new Problem(404, 'Missing own dictionary'); return row;
        };
        const retain = (command: CrmDictionaryCommand, resourceId: string): CrmDictionaryReceipt => {
          if (failJournal) throw new Problem(503, 'Closed journal failure');
          const receipt = { method: command.method, resourceId };
          state.journal.push({ tenant, actor, key, command: copy(command), receipt: copy(receipt) });
          state.audit.push({ tenant, method: command.method, resource: resourceId }); return receipt;
        };
        const allocate = (kind: DictionaryKind, resource: string) => {
          state.maps.push({ tenant, kind, resource, local: resource, public: String(kind === 'group' ? nextGroup++ : nextStatus++) });
        };
        const tombstone = (kind: DictionaryKind, id: string) => {
          const m = state.maps.find(m => m.tenant === tenant && m.kind === kind && m.resource === id); assert(m); m.local = null;
        };
        const append = (group: string) => Math.max(-1, ...state.statuses.filter(s => s.tenant === tenant && s.group_id === group).map(s => s.position)) + 1;
        const port: BaseWireCrmDictionaryPort = {
          async groups() { mark('groups'); return state.groups.filter(g => g.tenant === tenant).map(({ tenant: _, ...g }) => copy(g)); },
          async statuses() { mark('statuses'); return state.statuses.filter(s => s.tenant === tenant).map(({ tenant: _, ...s }) => copy(s)); },
          async resolve(kind, id) { mark('resolve:' + kind); return state.maps.find(m => m.tenant === tenant && m.kind === kind && m.public === String(id) && m.local !== null)?.local ?? null; },
          async publicId(kind, resource) { mark('publicId:' + kind); return state.maps.find(m => m.tenant === tenant && m.kind === kind && m.resource === resource)?.public ?? null; },
          async replay(command) {
            mark('replay', true); const existing = state.journal.find(j => j.tenant === tenant && j.command.clientKey === command.clientKey);
            if (!existing) return null;
            if (existing.actor !== actor || existing.key !== key || existing.command.method !== command.method || existing.command.wireHash !== command.wireHash)
              throw new Problem(409, 'Original command custody differs');
            return copy(existing.receipt);
          },
          async saveGroup(id, input, command) {
            mark('saveGroup', true);
            if (id) { const row = live('group', id) as Group; row.name = input.name; row.version++; return retain(command, id); }
            const row: Group = { id: uuid(nextResource++), tenant, name: input.name, is_main_group: 0, version: 1 };
            state.groups.push(row); allocate('group', row.id); return retain(command, row.id);
          },
          async saveStatus(id, input, command) {
            mark('saveStatus', true); const row = id ? live('status', id) as Status : null;
            const groupId = input.group_id ?? row?.group_id ?? state.groups.find(g => g.tenant === tenant && g.is_main_group === 1)!.id;
            live('group', groupId);
            if (row) {
              if (row.is_primary && groupId !== row.group_id) throw new Problem(409, 'Primary keeps group');
              if (groupId !== row.group_id) row.position = append(groupId);
              if (input.name !== undefined) row.name = input.name;
              if (input.color !== undefined) row.color = input.color;
              row.group_id = groupId; row.version++; return retain(command, row.id);
            }
            assert(input.name && input.color);
            const created: Status = { id: uuid(nextResource++), tenant, group_id: groupId, name: input.name, color: input.color, is_primary: 0, version: 1, position: append(groupId) };
            state.statuses.push(created); allocate('status', created.id); return retain(command, created.id);
          },
          async removeGroup(id, command) {
            mark('removeGroup', true); const row = live('group', id) as Group;
            if (row.is_main_group) throw new Problem(409, 'Main protected');
            const main = state.groups.find(g => g.tenant === tenant && g.is_main_group === 1)!; let position = append(main.id);
            for (const s of state.statuses.filter(s => s.tenant === tenant && s.group_id === id).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))) {
              s.group_id = main.id; s.position = position++; s.version++;
            }
            state.groups = state.groups.filter(g => g !== row); tombstone('group', id); return retain(command, id);
          },
          async removeStatus(id, target, command) {
            mark('removeStatus', true); const row = live('status', id) as Status; live('status', target);
            if (row.is_primary) throw new Problem(409, 'Primary protected');
            if (id === target) throw new Problem(422, 'Distinct target required');
            for (const client of state.clients.filter(c => c.tenant === tenant && c.status_id === id)) { client.status_id = target; client.version++; }
            state.statuses = state.statuses.filter(s => s !== row); tombstone('status', id); return retain(command, id);
          },
        };
        let result;
        try { result = await work(port); } catch (error) { state = saved; throw error; } finally { active = false; }
        if (loseCommitAck) { loseCommitAck = false; throw new Error('Closed lost commit ACK'); }
        return result;
      },
    });
    return { service, policy };
  }
  return { session, get state() { return state; }, calls,
    failJournal: (value: boolean) => { failJournal = value; }, loseCommitAck: () => { loseCommitAck = true; } };
}

async function wire(service: ReturnType<typeof createBaseWireCrmDictionariesService>, method: string, parameters: Record<string, BaseWireJson>, clientKey?: string) {
  const request = decodeBaseWireRequest({ httpMethod: 'POST', contentType: 'application/x-www-form-urlencoded',
    body: Buffer.from(new URLSearchParams({ method, parameters: JSON.stringify(parameters) }).toString()) }, METHODS);
  return service.execute(request.method, request.parameters, { clientKey }).then(payload => JSON.parse(encodeBaseWireSuccess(payload).toString()));
}
const problem = (status: number) => (error: unknown) => error instanceof Problem && error.status === status;

test('the six exact retained methods use documented output names/types and GETs allocate nothing', async () => {
  const contract = JSON.parse(readFileSync(new URL('../docs/parity/base-api-client-contracts.v1.json', import.meta.url), 'utf8'));
  assert.equal(METHODS.length, 6);
  assert(METHODS.every(method => contract.methods.some((m: any) => m.method === method)));
  const f = fixture(), { service } = f.session(), before = copy(f.state);
  assert.deepEqual(await wire(service, 'getCrmClientStatusGroups', {}), { status: 'SUCCESS', status_groups: [{ group_id: 1, name: 'Główna', is_main_group: 1 }] });
  assert.deepEqual(await wire(service, 'getCrmClientStatuses', {}), { status: 'SUCCESS', statuses: [{ id: 1, name: 'Nowy', color: '#64748b', group_id: 1, is_primary: 1 }] });
  assert.deepEqual(f.state, before); assert(f.calls.every(c => !c.writing));
  assert(!f.calls.some(c => /save|remove|replay/.test(c.operation)));
  for (const method of METHODS) assert.equal(isBaseWireCrmDictionaryWrite(method), !method.startsWith('get'));
  assert.equal(isBaseWireCrmDictionaryWrite('unknown'), false);
});

test('wire creation/edit shares the dictionary state, omitted group has different create/update semantics and moves append', async () => {
  const f = fixture(), { service } = f.session();
  const group = await wire(service, 'addCrmClientStatusGroup', { name: 'Obsługa' });
  const first = await wire(service, 'addCrmClientStatus', { name: 'Pierwszy', color: '#ABCDEF', group_id: group.group_id });
  const second = await wire(service, 'addCrmClientStatus', { name: 'Drugi', color: '#111111', group_id: group.group_id });
  const main = await wire(service, 'addCrmClientStatus', { name: 'Domyślny', color: '#222222' });
  let statuses = (await wire(service, 'getCrmClientStatuses', {})).statuses;
  assert.equal(statuses.find((s: any) => s.id === main.status_id).group_id, 1);
  assert.equal(statuses.find((s: any) => s.id === first.status_id).group_id, group.group_id);
  const beforeEdit = copy(f.state.statuses.find(s => s.name === 'Pierwszy')!);
  await wire(service, 'addCrmClientStatus', { status_id: first.status_id, name: 'Zmieniony' });
  const one = f.state.statuses.find(s => s.name === 'Zmieniony')!;
  assert.deepEqual(one, { ...beforeEdit, name: 'Zmieniony', version: beforeEdit.version + 1 });
  await wire(service, 'addCrmClientStatus', { status_id: main.status_id, group_id: group.group_id });
  assert(f.state.statuses.find(s => s.name === 'Domyślny')!.position > f.state.statuses.find(s => s.name === 'Drugi')!.position);
  await wire(service, 'addCrmClientStatusGroup', { group_id: group.group_id, name: 'Obsługa VIP' });
  statuses = (await wire(service, 'getCrmClientStatuses', {})).statuses;
  assert.equal(statuses.find((s: any) => s.id === first.status_id).name, 'Zmieniony');
  assert.equal(statuses.find((s: any) => s.id === second.status_id).group_id, group.group_id);
  assert.equal((await wire(service, 'getCrmClientStatusGroups', {})).status_groups.find((g: any) => g.group_id === group.group_id).name, 'Obsługa VIP');
});

test('deleting a status transfers active and archived clients atomically, retaining complete profiles/orders and numeric tombstone', async () => {
  const f = fixture(), { service } = f.session();
  const created = await wire(service, 'addCrmClientStatus', { name: 'Do scalenia', color: '#123456' });
  const status = f.state.statuses.find(s => s.name === 'Do scalenia')!;
  for (const deleted of [false, true]) f.state.clients.push({ id: uuid(300 + Number(deleted)), tenant: 'A', status_id: status.id, version: 3, deleted, profile: { notes: 'Keep this entire profile' } });
  f.state.clients.push({ id: uuid(302), tenant: 'B', status_id: uuid(4), version: 8, deleted: false, profile: { notes: 'Foreign' } });
  const clients = copy(f.state.clients), orders = copy(f.state.orders), key = randomUUID();
  f.failJournal(true);
  const before = copy(f.state);
  await assert.rejects(wire(service, 'deleteCrmClientStatus', { status_id: created.status_id, target_status_id: 1 }, key), problem(503));
  assert.deepEqual(f.state, before, 'Transfer/deletion/tombstone rolls back together with journal refusal');
  f.failJournal(false);
  assert.deepEqual(await wire(service, 'deleteCrmClientStatus', { status_id: created.status_id, target_status_id: 1 }, key), { status: 'SUCCESS' });
  assert.deepEqual(f.state.clients, clients.map(c => c.tenant === 'A' ? { ...c, status_id: uuid(3), version: c.version + 1 } : c));
  assert.deepEqual(f.state.orders, orders);
  assert.equal(f.state.maps.find(m => m.kind === 'status' && m.resource === status.id)!.local, null);
  assert(!f.state.statuses.some(s => s.id === status.id));
});

test('deleting a group moves statuses to main without deleting clients or changing status identities; main/primary are protected', async () => {
  const f = fixture(), { service } = f.session();
  const group = await wire(service, 'addCrmClientStatusGroup', { name: 'Przenoszone' });
  const status = await wire(service, 'addCrmClientStatus', { name: 'Zostaje', color: '#000000', group_id: group.group_id });
  const local = f.state.statuses.find(s => s.name === 'Zostaje')!;
  f.state.clients.push({ id: uuid(310), tenant: 'A', status_id: local.id, version: 2, deleted: false, profile: { notes: 'Same client' } });
  const clients = copy(f.state.clients), identity = copy(f.state.maps.find(m => m.kind === 'status' && m.resource === local.id));
  const beforeDelete = copy(f.state);
  await assert.rejects(wire(service, 'addCrmClientStatus', { status_id: 1, group_id: group.group_id }), problem(409));
  f.failJournal(true);
  await assert.rejects(wire(service, 'deleteCrmClientStatusGroup', { group_id: group.group_id }), problem(503));
  assert.deepEqual(f.state, beforeDelete, 'Moving statuses and deleting the group rolls back on journal failure');
  f.failJournal(false);
  assert.deepEqual(await wire(service, 'deleteCrmClientStatusGroup', { group_id: group.group_id }), { status: 'SUCCESS' });
  assert.deepEqual(f.state.clients, clients); assert.deepEqual(f.state.maps.find(m => m.kind === 'status' && m.resource === local.id), identity);
  assert.equal(f.state.statuses.find(s => s.id === local.id)!.group_id, uuid(1));
  assert.equal((await wire(service, 'getCrmClientStatuses', {})).statuses.find((s: any) => s.id === status.status_id).group_id, 1);
  const before = copy(f.state);
  await assert.rejects(wire(service, 'deleteCrmClientStatusGroup', { group_id: 1 }), problem(409));
  await assert.rejects(wire(service, 'deleteCrmClientStatus', { status_id: 1, target_status_id: status.status_id }), problem(409));
  assert.deepEqual(f.state, before);
});

test('lost ACK and keyed create/update/delete replay after tombstones retain exact historical IDs without recreation', async () => {
  const f = fixture(), { service } = f.session();
  const createGroupKey = randomUUID(), groupBody = { name: 'Oryginał' };
  f.loseCommitAck(); await assert.rejects(wire(service, 'addCrmClientStatusGroup', groupBody, createGroupKey), /lost commit ACK/);
  const group = await wire(service, 'addCrmClientStatusGroup', groupBody, createGroupKey);
  const createStatusKey = randomUUID(), statusBody = { name: 'Oryginalny', color: '#ABC123', group_id: group.group_id };
  const status = await wire(service, 'addCrmClientStatus', statusBody, createStatusKey);
  const editKey = randomUUID(), editBody = { status_id: status.status_id, name: 'Nowszy' };
  await wire(service, 'addCrmClientStatus', editBody, editKey);
  const deleteStatusKey = randomUUID(), deleteBody = { status_id: status.status_id, target_status_id: 1 };
  await wire(service, 'deleteCrmClientStatus', deleteBody, deleteStatusKey);
  const deleteGroupKey = randomUUID(); await wire(service, 'deleteCrmClientStatusGroup', { group_id: group.group_id }, deleteGroupKey);
  const before = copy(f.state); f.calls.length = 0;
  assert.deepEqual(await wire(service, 'addCrmClientStatusGroup', groupBody, createGroupKey), group);
  assert.deepEqual(await wire(service, 'addCrmClientStatus', statusBody, createStatusKey), status);
  assert.deepEqual(await wire(service, 'addCrmClientStatus', editBody, editKey), { status: 'SUCCESS', status_id: status.status_id });
  assert.deepEqual(await wire(service, 'deleteCrmClientStatus', deleteBody, deleteStatusKey), { status: 'SUCCESS' });
  assert.deepEqual(await wire(service, 'deleteCrmClientStatusGroup', { group_id: group.group_id }, deleteGroupKey), { status: 'SUCCESS' });
  assert.deepEqual(f.state, before); assert(!f.calls.some(c => c.operation.startsWith('resolve:') || /save|remove/.test(c.operation)));
  await assert.rejects(wire(service, 'addCrmClientStatusGroup', { name: 'Inna treść' }, createGroupKey), problem(409));
  await assert.rejects(wire(f.session('A', 'admin', 'key-2').service, 'addCrmClientStatusGroup', groupBody, createGroupKey), problem(409));
  await assert.rejects(wire(f.session('A', 'other-actor').service, 'addCrmClientStatusGroup', groupBody, createGroupKey), problem(409));
  assert.deepEqual(f.state, before);
});

test('external authority is consulted even before replay; viewer/preview writes refuse but readonly discovery remains usable', async () => {
  const f = fixture(), session = f.session(), key = randomUUID(), body = { name: 'Trwała' };
  await wire(session.service, 'addCrmClientStatusGroup', body, key);
  const before = copy(f.state);
  session.policy.revoked = true; f.calls.length = 0;
  await assert.rejects(wire(session.service, 'addCrmClientStatusGroup', body, key), problem(403));
  assert.deepEqual(f.calls.map(c => c.operation), ['EXTERNAL_AUTHORITY']);
  session.policy.revoked = false; session.policy.readOnly = true;
  await assert.rejects(wire(session.service, 'addCrmClientStatusGroup', body, key), problem(423));
  await wire(session.service, 'getCrmClientStatusGroups', {}); await wire(session.service, 'getCrmClientStatuses', {});
  session.policy.readOnly = false; session.policy.role = 'viewer';
  await assert.rejects(wire(session.service, 'addCrmClientStatusGroup', { name: 'Forbidden' }), problem(403));
  assert.deepEqual(f.state, before);
});

test('tenant/kind-scoped identity resolution refuses foreign and missing resources without partial transfer', async () => {
  const f = fixture(), { service } = f.session(), before = copy(f.state);
  // 1 is deliberately both a valid own GROUP and STATUS identity: method/field
  // selects the namespace. A single polymorphic UUID store would be incorrect.
  assert.equal((await wire(service, 'getCrmClientStatuses', {})).statuses[0].id, 1);
  for (const [method, body] of [
    ['addCrmClientStatusGroup', { group_id: 2, name: 'Foreign' }],
    ['addCrmClientStatus', { status_id: 2, name: 'Foreign' }],
    ['addCrmClientStatus', { name: 'Foreign group', color: '#000000', group_id: 2 }],
    ['deleteCrmClientStatusGroup', { group_id: 2 }],
    ['deleteCrmClientStatus', { status_id: 1, target_status_id: 2 }],
    ['deleteCrmClientStatusGroup', { group_id: 99999 }],
  ] as const) await assert.rejects(wire(service, method, body), problem(404));
  assert.deepEqual(f.state, before);
});

test('LOCAL missing-field/no-op refusals and native name/color/ID boundaries are validated before a transaction', async () => {
  const f = fixture(), { service } = f.session();
  const invalid: [string, Record<string, BaseWireJson>][] = [
    ['addCrmClientStatusGroup', {}], ['addCrmClientStatusGroup', { name: '' }], ['addCrmClientStatusGroup', { name: ' '.repeat(3) }],
    ['addCrmClientStatusGroup', { name: 'x'.repeat(16) }], ['addCrmClientStatus', { name: 'x'.repeat(31), color: '#112233' }],
    ['addCrmClientStatus', { name: 'No color' }], ['addCrmClientStatus', { color: '#112233' }],
    ['addCrmClientStatus', { name: 'Bad color', color: '112233' }], ['addCrmClientStatus', { status_id: 1 }],
    ['deleteCrmClientStatus', { status_id: 1, target_status_id: 1 }], ['getCrmClientStatuses', { page: 1 }],
  ];
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null, '1', true]) invalid.push(['deleteCrmClientStatusGroup', { group_id: value }]);
  for (const [method, body] of invalid) await assert.rejects(wire(service, method, body));
  assert.equal(f.calls.length, 0);
  await wire(service, 'addCrmClientStatusGroup', { name: 'x'.repeat(15) });
  await wire(service, 'addCrmClientStatus', { name: 'x'.repeat(30), color: '#aAbBcC' });
  await assert.rejects(service.execute('notAServiceMethod', {}), problem(400));
  await assert.rejects(wire(service, 'addCrmClientStatusGroup', { name: 'Okay' }, 'not-a-uuid'), z.ZodError);
});

test('MAX_SAFE mapped identities work; missing/unsafe maps make GET fail closed without allocation', async () => {
  const f = fixture(), { service } = f.session();
  const map = f.state.maps.find(m => m.kind === 'group' && m.tenant === 'A')!;
  map.public = String(Number.MAX_SAFE_INTEGER);
  assert.equal((await wire(service, 'getCrmClientStatusGroups', {})).status_groups[0].group_id, Number.MAX_SAFE_INTEGER);
  await wire(service, 'addCrmClientStatusGroup', { group_id: Number.MAX_SAFE_INTEGER, name: 'Bezpieczna' });
  map.public = '9007199254740992'; const unsafe = copy(f.state);
  await assert.rejects(wire(service, 'getCrmClientStatusGroups', {}), problem(503)); assert.deepEqual(f.state, unsafe);
  const currentMap = f.state.maps.find(m => m.kind === 'group' && m.tenant === 'A')!;
  f.state.maps.splice(f.state.maps.indexOf(currentMap), 1); const absent = copy(f.state);
  await assert.rejects(wire(service, 'getCrmClientStatuses', {}), problem(503)); assert.deepEqual(f.state, absent);
});

test('unkeyed identical creates intentionally produce distinct IDs and dictionary journal/audit entries', async () => {
  const f = fixture(), { service } = f.session(), input = { name: 'Identyczna' };
  const one = await wire(service, 'addCrmClientStatusGroup', input), two = await wire(service, 'addCrmClientStatusGroup', input);
  assert.notEqual(one.group_id, two.group_id); assert.equal(f.state.journal.length, 2); assert.equal(f.state.audit.length, 2);
});
