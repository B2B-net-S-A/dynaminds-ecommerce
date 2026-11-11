/** Import-safe SOURCE_ONLY / NOT_RUN. Root supplies the isolated native app,
 * owner-client factory, full stable566 capture and WX0600 private artifact writer.
 * Race A only: a real users NO KEY UPDATE barrier at168 terminal IAM. No app,
 * database/config creation, migration, provider request or synthetic authority.
 * Run exclusively: the temporary pg query observer passes every result/error
 * through unchanged and is restored before returning. Root closes app/pool and
 * verifies source/config pins, providers, listeners and process resources. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { Client } from 'pg';
import { createPhysicalWzNativeFixture } from './physical-parcel-wz-native-fixture';

type Entry = { row: Record<string, any>; pk?: unknown };
type Snapshot = { graph: { rows: Record<string, Entry[]> }; guards: Record<string, boolean>; [key: string]: any };
type Artifact = { path: string; sha256: string };
type Response = Awaited<ReturnType<FastifyInstance['inject']>>;
const terminal = 'SELECT parcel_physical_wz_terminal_prepare()';
const pause = () => new Promise<void>(r => setTimeout(r, 15));
async function bounded<T>(p: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([p, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Native request deadline exceeded; timeout is FAIL')), milliseconds);
  })]); } finally { if (timer) clearTimeout(timer); }
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function one<T>(rows: T[]): T { assert.equal(rows.length, 1); return rows[0]; }
function row(s: Snapshot, table: string, id: string) { return one(s.graph.rows[table].filter(e => e.row.id === id)); }
function valid(s: Snapshot) {
  assert.equal(Object.keys(s.graph.rows).length, 566);
  assert.equal(s.graph.rows.migrations.length, 168);
  assert.equal(Object.keys(s.guards).length, 24);
  assert(Object.values(s.guards).every(v => v === true));
}
function added(before: Entry[], after: Entry[]): Entry[] {
  const ids = new Set(before.map(e => e.row.id));
  assert.equal(ids.size, before.length);
  for (const old of before) assert.deepEqual(one(after.filter(e => e.row.id === old.row.id)), old, 'Every old row stays literal');
  assert.equal(new Set(after.map(e => e.row.id)).size, after.length);
  return after.filter(e => !ids.has(e.row.id));
}
function revokeDelta(before: Snapshot, after: Snapshot, key: string, tenant: string, user: string) {
  valid(after);
  const old = row(before, 'api_keys', key), fresh = row(after, 'api_keys', key);
  assert.equal(old.row.revoked_at, null);
  assert.equal(typeof fresh.row.revoked_at, 'string'); assert(Number.isFinite(Date.parse(fresh.row.revoked_at)));
  assert.deepEqual({ ...fresh, row: { ...fresh.row, revoked_at: old.row.revoked_at } }, old);
  const audit = one(added(before.graph.rows.audit_events, after.graph.rows.audit_events)).row;
  assert.deepEqual(Object.keys(audit).sort(), ['id', 'tenant_id', 'user_id', 'action', 'entity_id', 'detail', 'created_at'].sort());
  assert(uuid.test(audit.id)); assert.equal(audit.tenant_id, tenant); assert.equal(audit.user_id, user);
  assert.equal(audit.action, 'api_key.revoked'); assert.equal(audit.entity_id, key); assert.deepEqual(audit.detail, {});
  assert.equal(typeof audit.created_at, 'string'); assert(Number.isFinite(Date.parse(audit.created_at)));
  const expected = structuredClone(before);
  expected.graph.rows.api_keys = expected.graph.rows.api_keys.map(e => e.row.id === key ? fresh : e);
  // This replacement follows explicit old-row preservation and exactly one
  // independently checked native audit; it never normalizes unknown old changes.
  expected.graph.rows.audit_events = after.graph.rows.audit_events;
  assert.deepEqual(after, expected, 'Full566 rollback except genuine key revocation and its one audit');
}

export async function runPhysicalParcelWzHeldIamNative(args: {
  app: FastifyInstance;
  database: string;
  capture: () => Promise<Snapshot>;
  save: (name: string, value: unknown) => Promise<Artifact>;
  /** Returns a NEW UNCONNECTED owner Client. Helper connects/ends it once. */
  createOwnedClient: (purpose: 'holder' | 'observer') => Client | Promise<Client>;
  remoteAddresses: readonly [string, string];
  tag: string;
}) {
  assert(/^dynaminds_test_\d{13}$/.test(args.database));
  assert.notEqual(args.remoteAddresses[0], args.remoteAddresses[1]);
  const { Client: PgClient } = await import('pg'); // library only; no connection/app evaluation
  const journal: unknown[] = [], outcomes: unknown[] = [];
  let serial = 0;
  async function request(options: InjectOptions, expected: number): Promise<Response> {
    // Save the exact private request BEFORE any injection, including uncertain writes.
    const intent = await args.save('request-' + (++serial) + '.private.json', options);
    const response = await args.app.inject(options);
    const receipt = await args.save('response-' + serial + '.private.json', {
      intent, status: response.statusCode, headers: response.headers, body: response.body,
    });
    journal.push({ intent, receipt, status: response.statusCode });
    assert.equal(response.statusCode, expected, 'Genuine native request ' + options.method + ' ' + options.url);
    return response;
  }
  for (const [index, revoke] of [false, true].entries()) {
    const remoteAddress = args.remoteAddresses[index];
    const f = await createPhysicalWzNativeFixture({ app: args.app, strictCatalog: false, automaticWz: true,
      remoteAddress, tag: args.tag + (revoke ? '-revoked' : '-control') });
    await args.save('fixture-' + index + '.private.json', f);
    const key = (await request({ method: 'POST', url: '/api/developer/keys', remoteAddress,
      headers: { cookie: f.credentials.cookie, 'x-workspace-id': f.tenant },
      payload: { name: 'Physical WZ held IAM ' + randomUUID(), scopes: ['orders:read', 'orders:write'], expires_days: 1 } }, 201)).json();
    assert(uuid.test(key.id)); assert.equal(typeof key.token, 'string'); assert(key.token.length > 20);
    const headers = { authorization: 'Bearer ' + key.token, 'x-workspace-id': f.tenant };
    const source = (await request({ method: 'GET', url: '/api/v1/order-parcels/plans/' + f.plan.id + '/physical-wz/source', remoteAddress, headers }, 200)).json();
    assert.equal(source.can_write, true); assert.equal(source.source.plan_id, f.plan.id);
    const preview = (await request({ method: 'POST', url: '/api/v1/order-parcels/plans/' + f.plan.id + '/physical-wz/previews', remoteAddress, headers,
      payload: { client_key: randomUUID(), revision: source.source.revision, parcels: f.allocation } }, 201)).json().preview;
    assert(uuid.test(preview.id)); assert.equal(preview.can_apply, true);
    const detail = (await request({ method: 'GET', url: '/api/v1/order-parcels/physical-wz/previews/' + preview.id, remoteAddress, headers }, 200)).json();
    assert.equal(detail.preview.id, preview.id); assert.equal(detail.preview.can_apply, true);
    const before = await args.capture(); valid(before);
    const previewRow = row(before, 'parcel_physical_wz_previews', preview.id).row;
    assert.equal(previewRow.actor_id, f.user); assert.equal(previewRow.api_key_id, key.id);
    const beforeArtifact = await args.save('before-' + index + '-566.private.json', before);
    const body = { client_key: randomUUID(), scope_hash: preview.scope_hash, confirmed: true };
    const applyOptions: InjectOptions = { method: 'POST', url: '/api/v1/order-parcels/physical-wz/previews/' + preview.id + '/apply', remoteAddress, headers, payload: body };
    const applyIntent = await args.save('apply-intent-' + index + '.private.json', applyOptions);
    let holder: Client | undefined, observer: Client | undefined;
    let holderPid = 0, writerPid = 0, pending: Promise<Response> | undefined, settled = false;
    let expectedRequestHash: string | undefined;
    let response: Response | undefined, error: unknown;
    const errors: Array<{ pid: number; code: unknown; message: unknown; where: unknown }> = [];
    const original = PgClient.prototype.query;
    const observedQuery = function(this: Client & { processID?: number }, ...call: any[]) {
      const query = typeof call[0] === 'string' ? call[0] : call[0]?.text;
      const p: any = Reflect.apply(original, this, call);
      if (query === terminal && p && typeof p.then === 'function') {
        const pid = this.processID ?? 0;
        // Attach a handled observational child, return the EXACT original promise.
        // Capture only the PID independently bound by pg_blocking_pids below.
        void p.then(() => undefined, (e: any) => {
          if (pid === writerPid && writerPid > 0) errors.push({ pid, code: e?.code, message: e?.message, where: e?.where });
        });
      }
      return p;
    } as typeof original;
    const closed: unknown[] = [];
    try {
      holder = await args.createOwnedClient('holder'); await holder.connect();
      observer = await args.createOwnedClient('observer'); assert.notEqual(observer, holder); await observer.connect();
      for (const c of [holder, observer]) {
        const identity = one((await c.query('SELECT current_database() database,current_user role,pg_backend_pid() pid')).rows);
        assert.equal(identity.database, args.database); assert.notEqual(identity.role, 'dyna_app');
      }
      expectedRequestHash = one((await observer.query(`SELECT encode(sha256(convert_to(
        jsonb_build_object('tenant',$1::uuid,'actor',$2::uuid,'key',$3::uuid,'preview',$4::uuid,'request',$5::jsonb)::text,'UTF8')),'hex') hash`,
        [f.tenant, f.user, key.id, preview.id, JSON.stringify(body)])).rows).hash;
      assert(typeof expectedRequestHash === 'string' && /^[a-f0-9]{64}$/.test(expectedRequestHash));
      holderPid = Number(one((await holder.query('SELECT pg_backend_pid() pid')).rows).pid);
      await holder.query('BEGIN');
      assert.equal((await holder.query('SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE', [f.user])).rowCount, 1);
      PgClient.prototype.query = observedQuery;
      pending = args.app.inject(applyOptions); pending.then(() => { settled = true; }, () => { settled = true; });
      const deadline = Date.now() + 5500;
      let barrier: Record<string, any> | undefined;
      while (Date.now() < deadline) {
        assert(!settled, 'Apply must still be pending at the genuine terminal barrier');
        const waits: Array<Record<string, any>> = (await observer.query(`SELECT pid,datname,query,state,wait_event_type,wait_event,pg_blocking_pids(pid) blockers
          FROM pg_stat_activity WHERE datname=$1 AND query=$2 AND $3::int=ANY(pg_blocking_pids(pid))`, [args.database, terminal, holderPid])).rows;
        assert(waits.length <= 1, 'Do not choose a request PID from ambiguous waiters');
        if (waits.length === 1) { barrier = waits[0]; writerPid = Number(waits[0].pid); break; }
        await pause();
      }
      assert(barrier && writerPid > 0 && writerPid !== holderPid, 'Actual terminal users-holder wait must be observed before action');
      await args.save('actual-wait-' + index + '.private.json', { database: args.database, holder_pid: holderPid,
        writer_pid: writerPid, barrier, apply_intent: applyIntent });
      if (revoke) {
        const revoked = await request({ method: 'DELETE', url: '/api/developer/keys/' + key.id, remoteAddress,
          headers: { cookie: f.credentials.cookie, 'x-workspace-id': f.tenant } }, 200);
        assert.deepEqual(revoked.json(), { ok: true });
        assert(!settled, 'Revocation must commit while apply remains held');
      }
      await holder.query('ROLLBACK');
      response = await bounded(pending, 9000);
      await args.save('apply-response-' + index + '.private.json', { intent: applyIntent, status: response.statusCode, body: response.body, native_errors: errors });
      assert.equal(response.statusCode, revoke ? 401 : 201);
      if (revoke) assert.equal(one(errors.filter(e => e.pid === writerPid)).code, '28000', 'Original native error must pass through unchanged');
      else assert.equal(errors.filter(e => e.pid === writerPid).length, 0);
    } catch (e) {
      error = e;
      // Diagnostic saving never runs ahead of mandatory cancellation/closers.
    } finally {
      if (pending && !settled && observer && writerPid) {
        try {
          const bound = (await observer.query(`SELECT pid FROM pg_stat_activity WHERE pid=$1 AND datname=$2 AND query=$3
            AND $4::int=ANY(pg_blocking_pids(pid))`, [writerPid, args.database, terminal, holderPid])).rows;
          if (bound.length === 1) {
            await observer.query('SELECT pg_cancel_backend($1)', [writerPid]);
            error ??= new Error('Known bound native request cancelled; cancellation is FAIL');
          }
        } catch (e) { error ??= e; }
      }
      if (holder) await holder.query('ROLLBACK').catch(e => { error ??= e; });
      if (pending) await bounded(pending, 14000).catch(e => { error ??= e; });
      const foreignObserver = PgClient.prototype.query !== observedQuery && PgClient.prototype.query !== original;
      if (!foreignObserver) PgClient.prototype.query = original;
      else error ??= new Error('Foreign pg query observer replacement; refusing to overwrite it');
      const closure = await Promise.allSettled([holder?.end(), observer?.end()]);
      closed.push(...closure.map(x => x.status));
      for (const x of closure) if (x.status === 'rejected') error ??= x.reason;
      await args.save('held-cleanup-' + index + '.private.json', { owned_clients_closed: closure.every(x => x.status === 'fulfilled'),
        closers: closed, pending_settled: !pending || settled, query_observer_restored: !foreignObserver,
        holder_pid: holderPid, writer_pid: writerPid, native_errors: errors,
        failure: error instanceof Error ? { name: error.name, message: error.message } : error ? String(error) : null });
    }
    if (error) throw error;
    assert(response);
    const after = await args.capture(); valid(after);
    const afterArtifact = await args.save('after-' + index + '-566.private.json', after);
    if (revoke) revokeDelta(before, after, key.id, f.tenant, f.user);
    else {
      const mapping = one(added(before.graph.rows.parcel_physical_wz_mappings, after.graph.rows.parcel_physical_wz_mappings)).row;
      const r = response.json(); assert.equal(r.reused, false); assert.equal(r.mapping.id, mapping.id);
      assert.deepEqual(Object.keys(r.mapping).sort(), ['id','preview_id','plan_id','order_id','scope_hash','projection_hash','created_at','allocation','projected_parcels','classification_origin'].sort());
      for (const k of ['id','preview_id','plan_id','order_id','scope_hash']) assert.equal(r.mapping[k], mapping[k]);
      assert.equal(r.mapping.classification_origin, 'operator_confirmed');
      assert.equal(r.mapping.projection_hash, previewRow.frame.projection_hash);
      assert.deepEqual(r.mapping.allocation, previewRow.frame.allocation);
      assert.deepEqual(r.mapping.projected_parcels, previewRow.frame.projected_parcels);
      assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(r.mapping.created_at));
      assert.deepEqual(Object.keys(mapping).sort(), ['id','tenant_id','preview_id','plan_id','order_id','actor_id','api_key_id','client_key','request','request_hash','scope_hash','frame','created_at'].sort());
      assert(uuid.test(mapping.id)); assert.equal(mapping.tenant_id, f.tenant); assert.equal(mapping.actor_id, f.user);
      assert.equal(mapping.api_key_id, key.id); assert.equal(mapping.plan_id, f.plan.id); assert.equal(mapping.order_id, f.order.id);
      assert.equal(mapping.preview_id, preview.id); assert.equal(mapping.client_key, body.client_key);
      assert.deepEqual(mapping.request, body); assert.equal(mapping.scope_hash, preview.scope_hash); assert.deepEqual(mapping.frame, previewRow.frame);
      assert.equal(mapping.request_hash, expectedRequestHash); assert.equal(typeof mapping.created_at, 'string'); assert(Number.isFinite(Date.parse(mapping.created_at)));
      const expected = structuredClone(before); expected.graph.rows.parcel_physical_wz_mappings = after.graph.rows.parcel_physical_wz_mappings;
      assert.deepEqual(after, expected, 'Positive control commits exactly one complete native mapping; every other row/metadata/sequence literal');
    }
    outcomes.push({ control: !revoke, key_id: key.id, owner_id: f.user, tenant_id: f.tenant, preview_id: preview.id,
      actual_terminal_wait: true, holder_pid: holderPid, writer_pid: writerPid, status: response.statusCode,
      original_native_code: revoke ? '28000' : null, before: beforeArtifact, after: afterArtifact,
      owned_clients_closed: true, apply_intent: applyIntent });
  }
  const requests = await args.save('requests.private.json', journal);
  const result = { status: 'ROOT_NATIVE_PHYSICAL_WZ_HELD_IAM_RACE_A_PASS', database: args.database,
    tables: 566, migrations: 168, guards: 24, outcomes, requests,
    race_a_positive_control201: true, race_a_late_key_revoke401_native28000: true,
    complete_rollback_except_native_key_audit: true, old_rows_metadata_sequences_literal: true,
    helper_owned_clients_closed: true, app_pool_provider_process_closure_required: true,
    race_b_executed: false, restored_copy_executed: false };
  await args.save('result.private.json', result); return result;
}
