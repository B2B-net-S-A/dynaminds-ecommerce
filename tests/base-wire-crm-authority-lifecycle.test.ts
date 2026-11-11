/** Actual authority + native ports + service callbacks on closed query runners.
 * No PostgreSQL transaction, RLS or SQL-authority implementation is simulated
 * as accepted here; the tested boundary is callback completion and client reuse. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as crypto from 'node:crypto';
import { transformSync } from 'esbuild';
import { z } from 'zod';
import { ensure, Problem } from '../server/errors';
import type { Actor } from '../server/domain';

function load(file: string, imports: Record<string, unknown>) {
  const module = { exports: {} as any };
  const code = transformSync(readFileSync(new URL('../server/' + file, import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs', target: 'node24' }).code;
  new Function('require', 'module', 'exports', code)((name: string) => {
    assert(Object.hasOwn(imports, name), 'Unexpected ambient import ' + name); return imports[name];
  }, module, module.exports);
  return module.exports;
}
const authority = load('base-wire-crm-authority.ts', { './errors': { ensure } });
const schema = load('crm-schema.ts', { zod: { z } });
const codec = load('base-wire-codec.ts', { zod: { z }, './errors': { Problem } });
const fields = load('crm-field-definitions.ts', { zod: { z }, './errors': { ensure } });
const forbidden = () => assert.fail('Ambient database, credentials and audit are forbidden');
const crm = load('crm.ts', {
  'node:crypto': crypto, zod: { z }, './errors': { ensure }, './base-wire-crm-authority': authority,
  './db': { tenantTx: forbidden, tenantReadTx: forbidden }, './security': { encrypt: forbidden, decrypt: forbidden },
  './crm-schema': schema, './crm-field-definitions': fields, './domain': { audit: forbidden },
});
const clients = load('base-wire-crm.ts', {
  'node:crypto': crypto, zod: { z }, './errors': { ensure }, './crm-schema': schema,
  './base-wire-codec': codec, './base-wire-crm-authority': authority,
});
const dictionaries = load('base-wire-crm-dictionaries.ts', {
  'node:crypto': crypto, zod: { z }, './errors': { ensure }, './base-wire-codec': codec,
});
const uid = (n: number) => `94000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor: Actor = { tenantId: uid(1), userId: uid(2), apiKeyId: uid(3), source: 'api', role: 'admin' };
const denied = (error: unknown) => error instanceof Problem && error.status === 403;

function fixture(kind: 'client' | 'dictionary') {
  const flags = { revoked: false, domainThrow: false, workThrow: false, lostCommitAck: false };
  const queries: string[] = [];
  const retained: { proof: any; port?: any }[] = [];
  let boundaryChecks = 0;
  const c: any = { query: async (sql: string) => {
    queries.push(sql);
    if (sql.startsWith('SELECT public.base_wire218_authority')) return { rows: [{ role: flags.revoked ? null : 'admin' }] };
    if (sql.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [] };
    if (sql.startsWith("SELECT to_regclass('public.base_wire218_status_ids')")) return { rows: [{ status_ready: true, group_ready: true }] };
    if (sql.startsWith('SELECT * FROM crm_clients WHERE deleted_at IS NULL') || sql === 'SELECT * FROM crm_status_groups ORDER BY is_main_group DESC,name,id') {
      // Suspension proves the authority scope lasts through awaited work.
      await Promise.resolve();
      authority.assertBaseWireCrmAuthority(c, actor, retained.at(-1)!.proof);
      if (flags.workThrow) throw new Error('Closed work failed');
      return { rows: [] };
    }
    assert.fail('Unexpected query ' + sql);
  } };
  const checkExpired = () => {
    const r = retained.at(-1); if (!r) return;
    assert.throws(() => authority.assertBaseWireCrmAuthority(c, actor, r.proof), denied);
    boundaryChecks++;
  };
  const run = async (_tenant: string, work: (c: any) => Promise<unknown>) => {
    let result;
    try { result = await work(c); } finally { checkExpired(); }
    // The real transaction runner commits only after its callback returns.
    if (flags.lostCommitAck) throw new Error('Closed COMMIT acknowledgement lost');
    return result;
  };
  const domain = (client: any, principal: Actor, proof: any) => {
    assert.equal(client, c); const r: { proof: any; port?: any } = { proof }; retained.push(r);
    if (flags.domainThrow) throw new Error('Closed domain construction failed');
    r.port = kind === 'client' ? crm.createCrmClientWirePort(client, principal, proof) : crm.createCrmDictionaryWirePort(client, principal, proof);
    return r.port;
  };
  const db = { tenantTx: run, tenantReadTx: run };
  const dictionaryRuntime = load('base-wire-crm-dictionaries-runtime.ts', {
    './db': db, './crm': { createCrmDictionaryWirePort: domain }, './base-wire-crm-authority': authority,
    './errors': { ensure }, './base-wire-crm-dictionaries': dictionaries,
  });
  const runtime = load('base-wire-crm-runtime.ts', {
    './db': db, './crm': { createCrmClientWirePort: domain }, './base-wire-crm-authority': authority,
    './base-wire-crm': clients, './base-wire-crm-dictionaries-runtime': dictionaryRuntime,
    './base-wire-crm-dispatch': { createBaseWireCrmDispatch: forbidden },
  });
  const service = kind === 'client' ? runtime.createDefaultBaseWireCrmService()
    : dictionaryRuntime.createBaseWireCrmDictionaryRuntime({ crm218Verified: true, dictionary219Verified: true, readOnly: false });
  const execute = () => service.execute(actor, kind === 'client' ? 'getCrmClients' : 'getCrmClientStatusGroups', {});
  const useEscaped = (port = retained.at(-1)?.port) => kind === 'client' ? port.list({}) : port.groups();
  return { flags, queries, retained, c, execute, useEscaped, get boundaryChecks() { return boundaryChecks; } };
}

for (const kind of ['client', 'dictionary'] as const) {
  test(kind + ': real default callback expires escaped port before COMMIT, then reused client requires fresh authority', async () => {
    const f = fixture(kind);
    assert.deepEqual(await f.execute(), kind === 'client' ? { clients: [] } : { status_groups: [] });
    assert.equal(f.boundaryChecks, 1);
    const escaped = f.retained[0].port, before = f.queries.length;
    await assert.rejects(f.useEscaped(escaped), denied); assert.equal(f.queries.length, before, 'Expired port refuses before any SQL');
    f.flags.revoked = true;
    await assert.rejects(f.execute(), denied);
    assert.equal(f.retained.length, 1, 'Denied fresh authorization never constructs a domain');
    const deniedQueries = f.queries.length;
    await assert.rejects(f.useEscaped(escaped), denied); assert.equal(f.queries.length, deniedQueries);
    f.flags.revoked = false;
    await f.execute(); assert.equal(f.retained.length, 2); assert.notEqual(f.retained[0].proof, f.retained[1].proof);
    await assert.rejects(f.useEscaped(escaped), denied);
  });
  for (const failure of ['domainThrow', 'workThrow', 'lostCommitAck'] as const) {
    test(kind + ': ' + failure + ' still invalidates before transaction callback leaves', async () => {
      const f = fixture(kind); f.flags[failure] = true;
      await assert.rejects(f.execute(), /Closed/); assert.equal(f.boundaryChecks, 1);
      assert.throws(() => authority.assertBaseWireCrmAuthority(f.c, actor, f.retained[0].proof), denied);
      if (f.retained[0].port) { const before = f.queries.length; await assert.rejects(f.useEscaped(), denied); assert.equal(f.queries.length, before); }
    });
  }
}
test('explicit authority scope waits for work, revokes on read/write callback failure, and supports manual cleanup', async () => {
  for (const writing of [false, true]) {
    const c: any = { query: async () => ({ rows: [{ role: 'admin' }] }) }; let held: any;
    await assert.rejects(authority.withBaseWireCrmAuthority(c, actor, writing, async (proof: any) => {
      held = proof; await Promise.resolve(); authority.assertBaseWireCrmAuthority(c, actor, proof, writing);
      throw new Error('Callback failed');
    }), /Callback failed/);
    assert.throws(() => authority.assertBaseWireCrmAuthority(c, actor, held), denied);
    const manual = await authority.authorizeBaseWireCrmInTx(c, actor, writing);
    try { authority.assertBaseWireCrmAuthority(c, actor, manual, writing); } finally { authority.revokeBaseWireCrmAuthority(manual); }
    authority.revokeBaseWireCrmAuthority(manual);
    assert.throws(() => authority.assertBaseWireCrmAuthority(c, actor, manual), denied);
  }
});
