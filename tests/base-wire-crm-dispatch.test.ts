/** Actual prepared dispatcher + both actual adapters on closed transaction/domain
 * ports. No routes, PostgreSQL, network, runtime factory or activation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Actor } from '../server/domain';
import { ensure, Problem } from '../server/errors';
import { createBaseWireCrmService, BASE_WIRE_CRM_METHODS } from '../server/base-wire-crm';
import { createBaseWireCrmDictionariesService, BASE_WIRE_CRM_DICTIONARY_METHODS } from '../server/base-wire-crm-dictionaries';
import { authorizeBaseWireCrmInTx, assertBaseWireCrmAuthority } from '../server/base-wire-crm-authority';
import {
  createBaseWireCrmDispatch, BASE_WIRE_CRM_DISPATCH_METHODS,
  isBaseWireCrmDispatchWrite, baseWireCrmDispatchScope,
  type BaseWireCrmDispatchCapabilities, type BaseWireCrmDispatchPorts,
} from '../server/base-wire-crm-dispatch';

const uid = (n: number) => `84000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor: Actor = { tenantId: uid(1), userId: uid(2), apiKeyId: uid(3), role: 'admin', source: 'api' };
const writes = ['addCrmClient', 'deleteCrmClient', 'addCrmClientStatusGroup', 'addCrmClientStatus', 'deleteCrmClientStatusGroup', 'deleteCrmClientStatus'];
const reads = ['getCrmClientData', 'getCrmClients', 'getCrmClientExtraFields', 'getCrmClientStatusGroups', 'getCrmClientStatuses'];
const problem = (status: number) => (error: unknown) => error instanceof Problem && error.status === status;
const caps = (): BaseWireCrmDispatchCapabilities => ({ crm218Verified: true, dictionary219Verified: true, readOnly: false });

function fixture() {
  const effects: string[] = [], calls: { kind: string; actor: Actor; method?: string; parameters?: unknown; options?: unknown; ids?: number[] }[] = [];
  let profile: any = { id: uid(10), status_id: uid(20), login: 'Original', notes: 'Private', custom_extra_fields: {} };
  const file = { title: 'invoice.pdf', mime_type: 'application/pdf', bytes: Buffer.from([0, 1, 127, 255]) };
  const groups: any[] = [{ id: uid(30), name: 'Main', is_main_group: 1, version: 1 }];
  const statuses: any[] = [{ id: uid(20), name: 'New', color: '#112233', group_id: uid(30), is_primary: 1, position: 0, version: 1 }];
  const maps = new Map<string, number>([[uid(10), 1], [uid(20), 2], [uid(40), 3], [uid(30), 4]]);
  let serial = 50;
  const client: any = { query: async (sql: string, args: any[] = []) => {
    effects.push('sql:' + sql);
    if (sql.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [] };
    if (sql.startsWith('SELECT public.base_wire218_authority')) {
      assert.deepEqual(args.slice(0, 2), [actor.userId, actor.apiKeyId]);
      return { rows: [{ role: 'admin' }] };
    }
    assert.equal(args[0], actor.tenantId);
    assert(/FROM base_wire218_(client|status|field)_ids/.test(sql), 'Closed identity lookup only');
    if (sql.startsWith('SELECT public_id')) return { rows: maps.has(args[1]) ? [{ public_id: String(maps.get(args[1])) }] : [] };
    const found = [...maps].find(([, value]) => value === args[1]);
    return { rows: found ? [{ local_id: found[0] }] : [] };
  } };
  const clients = createBaseWireCrmService({
    transaction: async (principal, writing, work) => {
      assert.equal(principal, actor); effects.push(writing ? 'client-write-tx' : 'client-read-tx');
      return work(client);
    },
    authorize: authorizeBaseWireCrmInTx,
    domain: ((c: any, principal: Actor, proof: any) => {
      assertBaseWireCrmAuthority(c, principal, proof);
      return {
        async replay() { return null; },
        async save(id: string | null, input: any) {
          assertBaseWireCrmAuthority(c, principal, proof, true); effects.push('client-save');
          assert(id === null || id === profile.id); profile = { ...profile, ...input }; return structuredClone(profile);
        },
        async remove(id: string) {
          assertBaseWireCrmAuthority(c, principal, proof, true); assert.equal(id, profile.id);
          effects.push('client-remove'); profile.archived = true; return { id, deleted: true };
        },
        async detail(id: string) { assert.equal(id, profile.id); return structuredClone(profile); },
        async list() { return [structuredClone(profile)]; },
        async fields() { return [{ extra_field_id: uid(40), name: 'Memo', editor_type: 'text', options: [], archived: false }]; },
        async file(id: string, field: string) { assert.equal(id, profile.id); assert.equal(field, uid(40)); return file; },
      };
    }) as any,
  });
  const dictionaryAdapter = createBaseWireCrmDictionariesService({
    transaction: async (writing, work) => {
      effects.push(writing ? 'dictionary-write-tx' : 'dictionary-read-tx');
      const proof = await authorizeBaseWireCrmInTx(client, actor, writing);
      assertBaseWireCrmAuthority(client, actor, proof, writing);
      const receipt = (command: any, id: string) => ({ method: command.method, resourceId: id });
      return work({
        async groups() { return structuredClone(groups); },
        async statuses() { return structuredClone(statuses); },
        async resolve(kind, id) {
          const rows = kind === 'group' ? groups : statuses;
          return rows.find(row => maps.get(row.id) === id)?.id ?? null;
        },
        async publicId(_kind, resource) { return maps.has(resource) ? String(maps.get(resource)) : null; },
        async replay() { return null; },
        async saveGroup(id, input, command) {
          effects.push('dictionary-save-group');
          if (id) Object.assign(groups.find(row => row.id === id), input);
          else { id = uid(serial++); maps.set(id, serial); groups.push({ id, ...input, is_main_group: 0, version: 1 }); }
          return receipt(command, id);
        },
        async saveStatus(id, input, command) {
          effects.push('dictionary-save-status');
          if (id) Object.assign(statuses.find(row => row.id === id), input);
          else { id = uid(serial++); maps.set(id, serial); statuses.push({ id, ...input, group_id: input.group_id ?? uid(30), is_primary: 0, position: 1, version: 1 }); }
          return receipt(command, id);
        },
        async removeGroup(id, command) { effects.push('dictionary-remove-group'); groups.splice(groups.findIndex(row => row.id === id), 1); return receipt(command, id); },
        async removeStatus(id, target, command) { assert(statuses.some(row => row.id === target)); effects.push('dictionary-remove-status'); statuses.splice(statuses.findIndex(row => row.id === id), 1); return receipt(command, id); },
      });
    },
  });
  const ports: BaseWireCrmDispatchPorts = {
    clients: {
      execute: (principal, method, parameters, options) => { calls.push({ kind: 'clients', actor: principal, method, parameters, options }); return clients.execute(principal, method, parameters, options); },
      file: (principal, ...ids) => { calls.push({ kind: 'file', actor: principal, ids }); return clients.file(principal, ...ids); },
    },
    dictionaries: {
      execute: (principal, method, parameters, options) => { calls.push({ kind: 'dictionaries', actor: principal, method, parameters, options }); return dictionaryAdapter.execute(method, parameters, options); },
    },
  };
  return { effects, calls, file, ports, create: (selected = caps()) => createBaseWireCrmDispatch(selected, ports) };
}

test('the closed11 union has exactly six writes/five reads and refuses unknown classifiers', () => {
  assert(Object.isFrozen(BASE_WIRE_CRM_DISPATCH_METHODS));
  assert.deepEqual(BASE_WIRE_CRM_DISPATCH_METHODS, [...BASE_WIRE_CRM_METHODS, ...BASE_WIRE_CRM_DICTIONARY_METHODS]);
  assert.equal(new Set(BASE_WIRE_CRM_DISPATCH_METHODS).size, 11);
  assert.deepEqual([...BASE_WIRE_CRM_DISPATCH_METHODS].filter(isBaseWireCrmDispatchWrite).sort(), [...writes].sort());
  assert.deepEqual([...BASE_WIRE_CRM_DISPATCH_METHODS].filter(m => !isBaseWireCrmDispatchWrite(m)).sort(), [...reads].sort());
  for (const name of writes) assert.equal(baseWireCrmDispatchScope(name), 'crm:write');
  for (const name of reads) assert.equal(baseWireCrmDispatchScope(name), 'crm:read');
  for (const name of ['unknown', '__proto__', '', 'getCrmClients ']) {
    assert.throws(() => isBaseWireCrmDispatchWrite(name), problem(400));
    assert.throws(() => baseWireCrmDispatchScope(name), problem(400));
  }
});

test('startup flags are exact own booleans, immutable after construction, with no accessor or request overrides', async () => {
  const f = fixture();
  for (const value of [null, [], {}, { ...caps(), unexpected: true }, { ...caps(), [Symbol('flag')]: true }, ...Object.keys(caps()).flatMap(key => ['true', 1, null, undefined].map(v => ({ ...caps(), [key]: v })))])
    assert.throws(() => f.create(value as any), problem(503));
  const inherited = Object.create(caps()); assert.throws(() => f.create(inherited), problem(503));
  const getter = { ...caps() }; Object.defineProperty(getter, 'readOnly', { get() { assert.fail('Capability getter must not execute'); } });
  assert.throws(() => f.create(getter), problem(503));
  const selected = { ...caps(), readOnly: true, dictionary219Verified: false }, service = f.create(selected);
  selected.readOnly = false; selected.dictionary219Verified = true;
  await assert.rejects(service.execute(actor, 'addCrmClient', { readOnly: false }), problem(423));
  await assert.rejects(service.execute(actor, 'getCrmClientStatuses', { dictionary219Verified: true }), problem(503));
  assert.deepEqual(f.effects, []); assert.deepEqual(f.calls, []);
});

test('all five legacy adapters remain usable without219; parameters/options and file bytes retain the legacy path', async () => {
  const f = fixture(), service = f.create({ ...caps(), dictionary219Verified: false }), options = { clientKey: uid(90) }, parameters = { crm_client_id: 1, login: 'Edited' };
  assert.deepEqual(await service.execute(actor, 'addCrmClient', parameters, options), { crm_client_id: 1 });
  assert.equal(f.calls[0].parameters, parameters); assert.equal(f.calls[0].options, options); assert.equal(f.calls[0].actor, actor);
  assert.equal((await service.execute(actor, 'getCrmClientData', { crm_client_id: 1 })).login, 'Edited');
  const clients = (await service.execute(actor, 'getCrmClients', {})).clients;
  assert(Array.isArray(clients)); assert.equal(clients.length, 1);
  assert.deepEqual(await service.execute(actor, 'getCrmClientExtraFields', {}), { extra_fields: [{ extra_field_id: 3, name: 'Memo', editor_type: 'text' }] });
  const file = await service.file(actor, 1, 3);
  assert.equal(file, f.file); assert.equal(file.bytes, f.file.bytes); assert.deepEqual([...file.bytes], [0, 1, 127, 255]);
  assert.deepEqual(await service.execute(actor, 'deleteCrmClient', { crm_client_id: 1 }), {});
  assert(f.calls.every(row => row.kind === 'clients' || row.kind === 'file'));
  assert.deepEqual(new Set(f.calls.filter(row => row.kind === 'clients').map(row => row.method)), new Set(BASE_WIRE_CRM_METHODS));
});

test('unverified219 rejects all six before any delegation; unverified218 rejects all11 and files', async () => {
  for (const selected of [{ ...caps(), dictionary219Verified: false }, { ...caps(), crm218Verified: false }]) {
    const f = fixture(), service = f.create(selected), methods = selected.crm218Verified ? BASE_WIRE_CRM_DICTIONARY_METHODS : BASE_WIRE_CRM_DISPATCH_METHODS;
    for (const method of methods) await assert.rejects(service.execute(actor, method, {}), problem(503));
    if (!selected.crm218Verified) await assert.rejects(service.file(actor, 1, 3), problem(503));
    assert.deepEqual(f.calls, []); assert.deepEqual(f.effects, []);
  }
});

test('readonly refuses all six mutating methods with zero effects, retaining all five local reads and file navigation', async () => {
  const f = fixture(), service = f.create({ ...caps(), readOnly: true });
  for (const method of writes) await assert.rejects(service.execute(actor, method, {}), problem(423));
  assert.deepEqual(f.calls, []); assert.deepEqual(f.effects, []);
  for (const method of reads) await service.execute(actor, method, method === 'getCrmClientData' ? { crm_client_id: 1 } : {});
  assert.equal(await service.file(actor, 1, 3), f.file);
  assert(!f.effects.some(row => /write-tx|save|remove|advisory/.test(row)));
});

test('all six dictionary methods reach the actual dictionary adapter and never the legacy list fallback', async () => {
  const f = fixture(), service = f.create(), options = { clientKey: uid(91) }, parameters = { name: 'Wholesale' };
  const group = await service.execute(actor, 'addCrmClientStatusGroup', parameters, options);
  assert.equal(f.calls[0].parameters, parameters); assert.equal(f.calls[0].options, options); assert.equal(f.calls[0].actor, actor);
  const status = await service.execute(actor, 'addCrmClientStatus', { name: 'Ready', color: '#aabbcc', group_id: group.group_id });
  const groups = (await service.execute(actor, 'getCrmClientStatusGroups', {})).status_groups;
  const statuses = (await service.execute(actor, 'getCrmClientStatuses', {})).statuses;
  assert(Array.isArray(groups)); assert.equal(groups.length, 2);
  assert(Array.isArray(statuses)); assert.equal(statuses.length, 2);
  assert.deepEqual(await service.execute(actor, 'deleteCrmClientStatus', { status_id: status.status_id, target_status_id: 2 }), {});
  assert.deepEqual(await service.execute(actor, 'deleteCrmClientStatusGroup', { group_id: group.group_id }), {});
  assert(f.calls.every(row => row.kind === 'dictionaries'));
  assert.deepEqual(new Set(f.calls.map(row => row.method)), new Set(BASE_WIRE_CRM_DICTIONARY_METHODS));
});

test('unknown methods and readonly request-shaped capability fields cannot enter the legacy fallback', async () => {
  const f = fixture(), service = f.create();
  for (const method of ['getCrmClientStatus', '__proto__', '', null])
    await assert.rejects(service.execute(actor, method as any, { crm218Verified: true, dictionary219Verified: true, readOnly: false }), problem(400));
  assert.deepEqual(f.calls, []); assert.deepEqual(f.effects, []);
  // Even with verified server capabilities, the actual adapters still reject
  // request-shaped flags rather than using them as startup authority.
  await assert.rejects(service.execute(actor, 'getCrmClientStatuses', { readOnly: false }));
  await assert.rejects(service.execute(actor, 'getCrmClients', { dictionary219Verified: true }));
  assert.deepEqual(f.effects, []);
});
