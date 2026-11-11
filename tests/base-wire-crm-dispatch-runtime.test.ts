/** Real service/dispatch/runtime composition on closed transaction/domain ports.
 * No database, native authority, route registration or219 activation is claimed. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { createBaseWireCrmService, BASE_WIRE_CRM_METHODS } from '../server/base-wire-crm';
import {
  createBaseWireCrmDictionariesService, BASE_WIRE_CRM_DICTIONARY_METHODS,
  isBaseWireCrmDictionaryWrite,
} from '../server/base-wire-crm-dictionaries';
import { createBaseWireCrmDispatch } from '../server/base-wire-crm-dispatch';
import { ensure, Problem } from '../server/errors';
import { withBaseWireCrmAuthority } from '../server/base-wire-crm-authority';
import type { Actor } from '../server/domain';
import type { BaseWireCrmDispatchCapabilities } from '../server/base-wire-crm-dispatch';
import type { BaseWireCrmDispatchRuntimeFactories } from '../server/base-wire-crm-runtime';

function load(file: string, imports: Record<string, unknown>) {
  const module = { exports: {} as any };
  const source = readFileSync(new URL('../server/' + file, import.meta.url), 'utf8');
  const code = transformSync(source, { loader: 'ts', format: 'cjs', target: 'node24' }).code;
  new Function('require', 'module', 'exports', code)((name: string) => {
    assert(Object.hasOwn(imports, name), 'Ambient import forbidden: ' + name);
    return imports[name];
  }, module, module.exports);
  return module.exports;
}
const uid = (n: number) => `83000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor: Actor = { tenantId: uid(1), userId: uid(2), apiKeyId: uid(3), source: 'api', role: 'admin' };
const problem = (status: number) => (error: unknown) => error instanceof Problem && error.status === status;
const caps = (overrides: Partial<BaseWireCrmDispatchCapabilities> = {}): BaseWireCrmDispatchCapabilities => ({
  crm218Verified: true, dictionary219Verified: true, readOnly: false, ...overrides,
});
const writes = ['addCrmClient', 'deleteCrmClient', 'addCrmClientStatus', 'deleteCrmClientStatus',
  'addCrmClientStatusGroup', 'deleteCrmClientStatusGroup'];

function fixture() {
  const events: string[] = [];
  const row = { id: uid(10), status_id: uid(11), login: 'Shared native profile' };
  const proof = Object.freeze({ writing: false });
  let reading = false;
  const c: any = { query: async (sql: string, args: unknown[] = []) => {
    events.push('query');
    if (reading) assert(/^SELECT/.test(sql) && !/FOR (UPDATE|SHARE)|advisory/.test(sql));
    if (sql.startsWith('SELECT pg_advisory_xact_lock')) {
      assert.deepEqual(args, ['crm215:' + actor.tenantId]); events.push('mutex'); return { rows: [] };
    }
    assert.equal(args[0], actor.tenantId);
    if (sql.startsWith('SELECT local_id FROM base_wire218_client_ids')) return { rows: [{ local_id: uid(10) }] };
    if (sql.startsWith('SELECT local_id FROM base_wire218_field_ids')) return { rows: [{ local_id: uid(12) }] };
    if (sql.startsWith('SELECT public_id::text AS public_id FROM base_wire218_client_ids')) return { rows: [{ public_id: '1' }] };
    if (sql.startsWith('SELECT public_id::text AS public_id FROM base_wire218_status_ids')) return { rows: [{ public_id: '2' }] };
    assert.fail('Unexpected closed SQL: ' + sql);
  } };
  const tx = (read: boolean) => async <T>(tenantId: string, work: (client: any) => Promise<T>) => {
    assert.equal(tenantId, actor.tenantId); events.push(read ? 'read-tx' : 'write-tx');
    reading = read;
    try { return await work(c); } finally { reading = false; events.push('end'); }
  };
  const authorize = async (client: any, principal: Actor, writing: boolean) => {
    assert.equal(client, c); assert.equal(principal.tenantId, actor.tenantId);
    assert.equal(principal.apiKeyId, actor.apiKeyId); assert.equal(writing, !reading);
    if (writing) assert.equal(events.at(-1), 'mutex');
    events.push('fresh-authority'); return proof;
  };
  const domain = (client: any, principal: Actor, selectedProof: unknown) => {
    assert.equal(client, c); assert.equal(principal.apiKeyId, actor.apiKeyId); assert.equal(selectedProof, proof);
    events.push('client-domain');
    return {
      list: async (query: unknown) => { assert.deepEqual(query, { page: 1, limit: 100 }); return []; },
      detail: async () => ({ ...row }), fields: async () => [],
      replay: async () => null,
      save: async () => { events.push('client-save'); return { ...row }; },
      remove: async (id: string) => { assert.equal(id, row.id); events.push('client-remove'); },
      file: async (clientId: string, fieldId: string) => {
        assert.equal(clientId, row.id); assert.equal(fieldId, uid(12));
        return { title: 'private.csv', data: Buffer.from('closed') };
      },
    };
  };
  const dictionaryDomain = (client: any, principal: Actor, selectedProof: unknown) => {
    assert.equal(client, c); assert.equal(principal.apiKeyId, actor.apiKeyId); assert.equal(selectedProof, proof);
    events.push('dictionary-domain');
    return {
      groups: async () => [{ id: uid(20), name: 'Główna', is_main_group: 1, version: 1 }],
      statuses: async () => [{ id: uid(11), name: 'Nowy', color: '#112233', group_id: uid(20), is_primary: 1, version: 1, position: 0 }],
      publicId: async (kind: string, resourceId: string) => {
        assert.equal(resourceId, kind === 'group' ? uid(20) : uid(11)); return kind === 'group' ? '3' : '2';
      },
    };
  };
  const db = { tenantTx: tx(false), tenantReadTx: tx(true) };
  const dictionaryRuntime = load('base-wire-crm-dictionaries-runtime.ts', {
    './db': db, './crm': { createCrmDictionaryWirePort: dictionaryDomain },
    './base-wire-crm-authority': { authorizeBaseWireCrmInTx: authorize, withBaseWireCrmAuthority }, './errors': { ensure },
    './base-wire-crm-dictionaries': { createBaseWireCrmDictionariesService, BASE_WIRE_CRM_DICTIONARY_METHODS, isBaseWireCrmDictionaryWrite },
  });
  const runtime = load('base-wire-crm-runtime.ts', {
    './db': db, './crm': { createCrmClientWirePort: domain },
    './base-wire-crm-authority': { authorizeBaseWireCrmInTx: authorize },
    './base-wire-crm': { createBaseWireCrmService: (...args: Parameters<typeof createBaseWireCrmService>) => {
      events.push('client-factory'); return createBaseWireCrmService(...args);
    } },
    './base-wire-crm-dictionaries-runtime': { createBaseWireCrmDictionaryRuntime: (...args: any[]) => {
      events.push('dictionary-factory'); return dictionaryRuntime.createBaseWireCrmDictionaryRuntime(...args);
    } },
    './base-wire-crm-dispatch': { createBaseWireCrmDispatch },
  });
  return { runtime, events, dispatch: (selected = caps(), factories?: BaseWireCrmDispatchRuntimeFactories) =>
    runtime.createDefaultBaseWireCrmDispatch(selected, factories) };
}

test('module import and default dispatch construction have no factory/TX effects; existing five-service factory still works', async () => {
  const f = fixture(); assert.equal(f.events.length, 0);
  f.dispatch(); assert.equal(f.events.length, 0);
  const service = f.runtime.createDefaultBaseWireCrmService();
  assert.deepEqual(f.events, ['client-factory']);
  assert.deepEqual(await service.execute(actor, 'getCrmClients', {}), { clients: [] });
  assert.deepEqual(f.events.slice(1), ['read-tx', 'fresh-authority', 'client-domain', 'end']);
});

test('verified218 without219 preserves allfive client methods/files and refuses allsix before dictionary construction', async () => {
  const f = fixture(), service = f.dispatch(caps({ dictionary219Verified: false }));
  for (const method of BASE_WIRE_CRM_DICTIONARY_METHODS)
    await assert.rejects(service.execute(actor, method, {}), problem(503));
  assert.equal(f.events.length, 0);
  assert.deepEqual(await service.execute(actor, 'getCrmClients', {}), { clients: [] });
  assert.deepEqual(await service.execute(actor, 'getCrmClientData', { crm_client_id: 1 }), {
    login: 'Shared native profile', crm_client_id: 1, status_id: 2,
  });
  assert.deepEqual(await service.execute(actor, 'getCrmClientExtraFields', {}), { extra_fields: [] });
  const options = { clientKey: uid(30) };
  assert.deepEqual(await service.execute(actor, 'addCrmClient', { login: 'Added' }, options), { crm_client_id: 1 });
  assert.deepEqual(await service.execute(actor, 'deleteCrmClient', { crm_client_id: 1 }, options), {});
  assert.deepEqual(await service.file(actor, 1, 4), { title: 'private.csv', data: Buffer.from('closed') });
  assert.equal(f.events.filter(event => event === 'client-factory').length, 1);
  assert(!f.events.includes('dictionary-factory'));
  assert.equal(f.events.filter(event => event === 'write-tx').length, 2);
  assert.equal(f.events.filter(event => event === 'read-tx').length, 4);
});

test('unverified218 blocks all11 methods and attachment before either factory or transaction', async () => {
  const f = fixture(), service = f.dispatch(caps({ crm218Verified: false }));
  for (const method of [...BASE_WIRE_CRM_METHODS, ...BASE_WIRE_CRM_DICTIONARY_METHODS])
    await assert.rejects(service.execute(actor, method, {}), problem(503));
  await assert.rejects(service.file(actor, 1, 4), problem(503));
  assert.equal(f.events.length, 0);
});

test('readonly blocks allsix writes while both real adapters and private files keep read-only transactions', async () => {
  const f = fixture(), service = f.dispatch(caps({ readOnly: true }));
  for (const method of writes) await assert.rejects(service.execute(actor, method, {}), problem(423));
  assert.equal(f.events.length, 0);
  assert.deepEqual(await service.execute(actor, 'getCrmClients', {}), { clients: [] });
  assert.deepEqual(await service.execute(actor, 'getCrmClientStatusGroups', {}), {
    status_groups: [{ group_id: 3, name: 'Główna', is_main_group: 1 }],
  });
  assert.deepEqual(await service.execute(actor, 'getCrmClientStatuses', {}), {
    statuses: [{ id: 2, name: 'Nowy', color: '#112233', group_id: 3, is_primary: 1 }],
  });
  await service.file(actor, 1, 4);
  assert.equal(f.events.filter(event => event === 'read-tx').length, 4);
  assert.equal(f.events.filter(event => event === 'dictionary-factory').length, 1);
  assert(!f.events.includes('write-tx')); assert(!f.events.includes('mutex'));
});

test('injected factories receive one immutable validated startup snapshot and forward actor/arguments without eager execution', async () => {
  const f = fixture(), input = caps(), observed: unknown[] = [];
  const result = { original: true }, file = { data: Buffer.from('x') };
  let selected: BaseWireCrmDispatchCapabilities | undefined;
  const factories: BaseWireCrmDispatchRuntimeFactories = {
    clients: () => { observed.push('clients'); return {
      execute: async (...args) => { observed.push(args); return result; },
      file: async (...args) => { observed.push(args); return file as any; },
    }; },
    dictionaries: value => { selected = value; observed.push('dictionaries'); return {
      execute: async (...args) => { observed.push(args); return result; },
    }; },
  };
  const service = f.dispatch(input, factories);
  (input as any).dictionary219Verified = false; (input as any).readOnly = true;
  assert.deepEqual(observed, []); assert.equal(f.events.length, 0);
  const parameters = { name: 'Nowa' }, options = { clientKey: uid(31) };
  assert.equal(await service.execute(actor, 'addCrmClientStatusGroup', parameters, options), result);
  assert.deepEqual(selected, caps()); assert(Object.isFrozen(selected)); assert.notEqual(selected, input);
  assert.deepEqual(observed, ['dictionaries', [actor, 'addCrmClientStatusGroup', parameters, options]]);
  assert.equal(await service.execute(actor, 'getCrmClients', {}), result);
  assert.equal(await service.file(actor, 1, 4), file);
  assert.equal(observed.filter(event => event === 'clients').length, 1);
  assert.equal(f.events.length, 0);
  const blocked = f.dispatch(caps({ dictionary219Verified: false }), factories);
  const before = observed.length;
  await assert.rejects(blocked.execute(actor, 'getCrmClientStatusGroups', {}), problem(503));
  assert.equal(observed.length, before);
});

test('malformed capability/accessor/extra flags and unknown methods fail before factory construction', async () => {
  const f = fixture();
  const accessor = { ...caps() };
  Object.defineProperty(accessor, 'readOnly', { enumerable: true, get() { assert.fail('Startup accessor must not run'); } });
  for (const invalid of [accessor, { ...caps(), readOnly: 'false' }, { ...caps(), request219: true }, null,
    { ...caps(), [Symbol('untrusted')]: true }])
    assert.throws(() => f.dispatch(invalid as any), problem(503));
  await assert.rejects(f.dispatch().execute(actor, 'getInventoryProducts', {}), problem(400));
  assert.equal(f.events.length, 0);
});
