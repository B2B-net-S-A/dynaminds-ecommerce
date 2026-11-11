import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { pool, tenantTx } from './db';
import { audit } from './domain';
import { ensure, Problem } from './errors';
import { decrypt, encrypt } from './security';
import { wmsLotsHash } from './wms-lots';
import {
  updateSupplierFileSource,
  previewSupplierFileSource,
  applySupplierFileSource,
  supplierFileSourcesAvailable,
} from './supplier-file-sources';
import {
  fetchSupplierRemoteFeed,
  SupplierRemoteFetchError,
  supplierRemoteFeedUrl,
  type SupplierRemoteFetchDependencies,
} from './supplier-remote-fetch-transport';
import {
  supplierRemoteUpdateInput,
  supplierRemoteFetchInput,
  supplierFeedScheduleInput,
  supplierRemotePageInput,
  supplierRemoteAuthValue,
  SUPPLIER_REMOTE_FEED_LIMITS,
  type SupplierRemoteActor,
  type SupplierRemoteUpdateInput,
  type SupplierRemoteFetchInput,
  type SupplierFeedScheduleInput,
  type SupplierRemotePageInput,
  type SupplierFeedPublishPolicy,
} from './supplier-remote-schema';

export {
  supplierRemoteUpdateInput,
  supplierRemoteFetchInput,
  supplierFeedScheduleInput,
  supplierRemotePageInput,
  SUPPLIER_REMOTE_FEED_LIMITS,
} from './supplier-remote-schema';
export const SUPPLIER_REMOTE_FETCH_JOB = 'supplier.file.fetch';
export type SupplierRemoteFetchJob = {
  id: string;
  tenant_id: string;
  lease_token: string;
  attempts: number;
  payload: { fetch_id: string };
};
const tables = [
  'supplier_file_remotes',
  'supplier_file_remote_revisions',
  'supplier_file_feed_schedules',
  'supplier_file_feed_schedule_revisions',
  'supplier_file_fetch_runs',
];
const functions = [
  'supplier_remote_installed()',
  'supplier_remote_access(uuid,uuid,boolean,boolean)',
  'supplier_remote_require(uuid,uuid,boolean)',
  'supplier_remote_lock(uuid)',
  'supplier_remote_quota(uuid)',
  'supplier_remote_policy_valid(jsonb)',
  'supplier_remote_cancel(uuid,text)',
  'supplier_remote_save_remote(uuid,jsonb,uuid,uuid)',
  'supplier_remote_save_schedule(uuid,jsonb,uuid,uuid)',
  'supplier_remote_queue(uuid,jsonb,uuid,uuid)',
  'supplier_remote_start(uuid,uuid,uuid)',
  'supplier_remote_finish(uuid,uuid,uuid,jsonb)',
  'supplier_remote_defer(uuid,text)',
  'supplier_remote_sweep(uuid)',
  'supplier_remote_retry(uuid,uuid,uuid,text,integer)',
  'supplier_remote_reap(uuid)',
  'supplier_remote_immutable()',
  'supplier_remote_scope()',
  'supplier_remote_complete()',
  'supplier_remote_replay_remote(uuid,uuid,text,uuid,uuid)',
];
const remoteColumns =
  'id,tenant_id,source_id,version,source_version,actor_id,api_key_id,display_host,auth_kind,scope,created_at,updated_at';
const fetchColumns =
  'id,tenant_id,source_id,source_version,remote_version,schedule_version,actor_id,api_key_id,client_key,request_hash,job_id,state,phase,attempt,queued_at,started_at,finished_at,http_status,wire_bytes,decoded_bytes,wire_hash,raw_hash,preview_id,run_id,summary,error_code,request,policy_snapshot';
const internal118 = { deferConstraintFinalization: true, deferPrincipalPin: true } as const;

export async function supplierRemoteFeedsAvailable(c: Pool | PoolClient): Promise<boolean> {
  const q = (
    await c.query(
      `SELECT
    (SELECT count(*) FROM unnest($1::text[]) n JOIN pg_class p ON p.oid=to_regclass(n) WHERE p.relrowsecurity AND p.relforcerowsecurity)=$2 rls,
    NOT EXISTS(SELECT 1 FROM unnest($3::text[]) f WHERE to_regprocedure(f) IS NULL) funcs,
    (SELECT count(*) FROM unnest($1::text[]) n JOIN pg_trigger g ON g.tgrelid=to_regclass(n) WHERE g.tgname='supplier_remote_scope' AND g.tgenabled='O' AND g.tgfoid=to_regprocedure('supplier_remote_scope()'))=$2 scope,
    (SELECT count(*) FROM unnest($1::text[]) n JOIN pg_trigger g ON g.tgrelid=to_regclass(n) WHERE g.tgname='supplier_remote_no_delete' AND g.tgenabled='O' AND g.tgfoid=to_regprocedure('supplier_remote_immutable()'))=$2 deletion,
    (SELECT count(*) FROM pg_trigger g WHERE g.tgrelid=ANY(ARRAY[to_regclass('supplier_file_remote_revisions'),to_regclass('supplier_file_feed_schedule_revisions')]) AND g.tgname='supplier_remote_immutable' AND g.tgenabled='O' AND g.tgfoid=to_regprocedure('supplier_remote_immutable()'))=2 immutable,
    (SELECT count(*) FROM unnest($1::text[]) n JOIN pg_trigger g ON g.tgrelid=to_regclass(n) WHERE g.tgname='supplier_remote_complete' AND g.tgdeferrable AND g.tginitdeferred AND g.tgenabled='O' AND g.tgfoid=to_regprocedure('supplier_remote_complete()'))=5 complete,
    (SELECT count(*) FROM pg_constraint co WHERE co.conrelid=to_regclass('supplier_file_fetch_runs') AND co.contype='f' AND co.convalidated AND co.confrelid=ANY(ARRAY[to_regclass('jobs'),to_regclass('supplier_file_previews'),to_regclass('supplier_file_runs'),to_regclass('api_keys'),to_regclass('supplier_file_source_revisions'),to_regclass('supplier_file_remote_revisions'),to_regclass('supplier_file_feed_schedule_revisions'),to_regclass('supplier_sources')]))=8 fks`,
      [tables, tables.length, functions],
    )
  ).rows[0];
  return Object.values(q).every(Boolean) && (await supplierFileSourcesAvailable(c));
}
async function installedOrArtifacts(c: Pool | PoolClient): Promise<boolean> {
  const q = (
    await c.query(
      "SELECT to_regprocedure('supplier_remote_installed()') present,EXISTS(SELECT 1 FROM unnest($1::text[]) n WHERE to_regclass(n) IS NOT NULL) artifacts",
      [tables],
    )
  ).rows[0];
  if (
    q.present &&
    (await c.query('SELECT supplier_remote_installed() installed')).rows[0].installed
  )
    return true;
  // Owner read of the migration ledger handles a removed installed helper. Never
  // grant migrations/secret SELECT to the app role to obtain this information.
  return (
    q.artifacts ||
    (
      await pool.query(
        "SELECT EXISTS(SELECT 1 FROM migrations WHERE name='119_supplier_remote_feeds') installed",
      )
    ).rows[0].installed
  );
}
async function backgroundAvailable(): Promise<boolean> {
  if (await supplierRemoteFeedsAvailable(pool)) return true;
  ensure(!(await installedOrArtifacts(pool)), 503, 'Moduł zdalnych feedów jest niekompletny');
  return false;
}
export const supplierRemoteRequestHash = (
  a: SupplierRemoteActor,
  kind: string,
  parent: string,
  request: unknown,
) =>
  wmsLotsHash({
    tenant_id: a.tenantId,
    actor_id: a.userId,
    api_key_id: a.apiKeyId ?? null,
    kind,
    parent_id: parent,
    request,
  });
async function query(c: PoolClient, sql: string, params: unknown[] = []) {
  try {
    return await c.query(sql, params);
  } catch (e) {
    const p = e as { code?: string; message?: string };
    if (p.code === 'P0002') throw new Problem(404, 'Nie znaleziono własnego źródła lub pobrania');
    if (p.code === 'P0001' && /^REMOTE_[A-Z_]+$/.test(p.message ?? ''))
      throw new Problem(409, p.message!);
    if (p.code === 'P0001' && /^Limit /.test(p.message ?? '')) throw new Problem(409, 'QUOTA');
    if (p.code === '42501' && p.message === 'Klucz API wygasł lub został wycofany')
      throw new Problem(401, p.message);
    if (p.code === '42501' && p.message === 'Brak aktualnych uprawnień purchasing')
      throw new Problem(403, p.message);
    throw e;
  }
}
async function access(c: PoolClient, a: SupplierRemoteActor, write = false, pin = false) {
  const ctx = (
    await c.query("SELECT current_user role,current_setting('app.tenant_id',true) tenant")
  ).rows[0];
  ensure(
    ctx.role === 'dyna_app' && ctx.tenant === a.tenantId,
    403,
    'Niezgodny kontekst zdalnego feedu',
  );
  ensure(await supplierRemoteFeedsAvailable(c), 503, 'Moduł zdalnych feedów jest niekompletny');
  const g = (
    await query(c, 'SELECT supplier_remote_access($1,$2,$3,$4) g', [
      a.userId,
      a.apiKeyId ?? null,
      write,
      pin,
    ])
  ).rows[0].g;
  ensure(g.key_valid, 401, 'Klucz API wygasł lub został wycofany');
  ensure(g.allowed, 403, 'Brak aktualnych uprawnień purchasing');
  return {
    available: true,
    read_only: false,
    current_role: g.role,
    can_read: true,
    can_manage: g.can_write,
    can_fetch: g.can_write,
    can_enable_schedule: g.can_write,
  };
}
async function final(c: PoolClient, a: SupplierRemoteActor, write: boolean) {
  if (write) await query(c, 'SET CONSTRAINTS ALL IMMEDIATE');
  return access(c, a, write, true);
}
async function source(c: PoolClient, id: string, lock = false) {
  if (lock)
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended('supplier-file:'||$1,0))", [
      (await c.query("SELECT current_setting('app.tenant_id') t")).rows[0].t,
    ]);
  const s = (
    await c.query(
      `SELECT s.*,cfg.config,p.active supplier_active FROM supplier_sources s JOIN supplier_file_source_configs cfg ON(cfg.tenant_id,cfg.source_id)=(s.tenant_id,s.id) JOIN suppliers p ON(p.tenant_id,p.id)=(s.tenant_id,s.supplier_id) WHERE s.id=$1 AND s.kind='file'${lock ? ' FOR UPDATE OF s' : ''}`,
      [id],
    )
  ).rows[0];
  ensure(s, 404, 'Nie znaleziono własnego źródła plikowego');
  return s;
}
function remoteView(r: any, s: any) {
  return r
    ? {
        id: r.id,
        source_id: r.source_id,
        version: r.version,
        source_version: r.source_version,
        configured: true,
        display_host: r.display_host,
        auth_kind: r.auth_kind,
        has_credentials: r.auth_kind !== 'none',
        scope: r.scope,
        created_at: r.created_at,
        updated_at: r.updated_at,
      }
    : {
        source_id: s.id,
        version: 0,
        source_version: s.version,
        configured: false,
        display_host: null,
        auth_kind: 'none',
        has_credentials: false,
        scope: 'delta',
      };
}
function fetchView(f: any) {
  const {
    tenant_id,
    actor_id,
    api_key_id,
    client_key,
    request_hash,
    request,
    policy_snapshot,
    ...out
  } = f;
  return out;
}
function scheduleView(v: any, s: any, r: any) {
  return v
    ? {
        source_id: v.source_id,
        version: v.version,
        source_version: v.source_version,
        remote_version: v.remote_version,
        enabled: v.enabled,
        interval_minutes: v.interval_minutes,
        publish: v.publish,
        next_at: v.next_at,
        last_fetch_id: v.last_fetch_id,
        error_code: v.error_code,
        created_at: v.created_at,
        updated_at: v.updated_at,
      }
    : {
        source_id: s.id,
        version: 0,
        source_version: s.version,
        remote_version: r?.version ?? 0,
        enabled: false,
        interval_minutes: 30,
        publish: supplierFeedScheduleInput.shape.publish.parse(undefined),
        next_at: null,
        last_fetch_id: null,
        error_code: null,
      };
}
async function remote(c: PoolClient, id: string) {
  return (
    await c.query(`SELECT ${remoteColumns} FROM supplier_file_remotes WHERE source_id=$1`, [id])
  ).rows[0];
}
async function fetchRow(c: PoolClient, id: string) {
  const f = (
    await c.query(`SELECT ${fetchColumns} FROM supplier_file_fetch_runs WHERE id=$1`, [id])
  ).rows[0];
  ensure(f, 404, 'Nie znaleziono pobrania');
  return f;
}
function strip118(value: unknown): any {
  if (Array.isArray(value)) return value.map(strip118);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([k]) =>
            ![
              'expected_items',
              'raw_content',
              'request_hash',
              'top_xid',
              'transaction_started_at',
            ].includes(k),
        )
        .map(([k, v]) => [k, strip118(v)]),
    );
  return value;
}

export async function getSupplierRemote(c: PoolClient, a: SupplierRemoteActor, id: string) {
  if (!(await supplierRemoteFeedsAvailable(c))) {
    ensure(!(await installedOrArtifacts(c)), 503, 'Moduł zdalnych feedów jest niekompletny');
    ensure(await supplierFileSourcesAvailable(c), 503, 'Brak źródeł plikowych');
    const ctx = (
      await c.query("SELECT current_user role,current_setting('app.tenant_id',true) tenant")
    ).rows[0];
    ensure(
      ctx.role === 'dyna_app' && ctx.tenant === a.tenantId,
      403,
      'Niezgodny kontekst zdalnego feedu',
    );
    const g = (
      await c.query('SELECT supplier_file_access($1,$2,false,false) g', [
        a.userId,
        a.apiKeyId ?? null,
      ])
    ).rows[0].g;
    ensure(g.key_valid, 401, 'Klucz API wygasł lub został wycofany');
    ensure(g.allowed, 403, 'Brak aktualnych uprawnień purchasing');
    const s = await source(c, id),
      last = (
        await c.query('SELECT supplier_file_access($1,$2,false,true) g', [
          a.userId,
          a.apiKeyId ?? null,
        ])
      ).rows[0].g;
    ensure(last.key_valid, 401, 'Klucz API wygasł lub został wycofany');
    ensure(last.allowed, 403, 'Brak aktualnych uprawnień purchasing');
    return {
      remote: remoteView(null, s),
      available: false,
      read_only: false,
      current_role: last.role,
      can_read: true,
      can_manage: false,
      can_fetch: false,
      can_enable_schedule: false,
    };
  }
  await access(c, a);
  const s = await source(c, id),
    r = await remote(c, id),
    flags = await final(c, a, false);
  return {
    remote: remoteView(r, s),
    ...flags,
    can_fetch: flags.can_manage && !!r,
    can_enable_schedule: flags.can_manage && !!r,
  };
}
export async function updateSupplierRemote(
  c: PoolClient,
  a: SupplierRemoteActor,
  id: string,
  input: SupplierRemoteUpdateInput,
) {
  await access(c, a, true);
  const b = supplierRemoteUpdateInput.parse(input),
    s = await source(c, id, true);
  await access(c, a, true);
  const hash = supplierRemoteRequestHash(a, 'remote', id, b),
    old = (
      await query(c, 'SELECT supplier_remote_replay_remote($1,$2,$3,$4,$5) v', [
        id,
        b.client_key,
        hash,
        a.userId,
        a.apiKeyId ?? null,
      ])
    ).rows[0].v;
  if (old) {
    const flags = await final(c, a, true);
    return { remote: old, reused: true, ...flags };
  }
  const r = await remote(c, id);
  ensure(
    s.version === b.source_version && (r?.version ?? 0) === b.version,
    409,
    'REMOTE_VERSION_CONFLICT',
  );
  ensure(b.url || r, 422, 'Pierwsza konfiguracja wymaga URL');
  const u = b.url ? supplierRemoteFeedUrl(b.url) : null;
  await updateSupplierFileSource(
    c,
    a,
    id,
    { client_key: b.client_key, version: b.source_version, name: s.name, config: s.config },
    internal118,
  );
  const payload = {
    ...b,
    id: r?.id ?? randomUUID(),
    revision_id: randomUUID(),
    request_hash: hash,
    request_cipher: encrypt({ request: b }),
    url_cipher: u ? encrypt({ url: u.href }) : null,
    display_host: u?.hostname.replace(/^\[|\]$/g, ''),
    auth_action: b.auth.action,
    auth_cipher: b.auth.action === 'replace' ? encrypt({ auth: b.auth.value }) : null,
    auth_kind: b.auth.action === 'replace' ? b.auth.value.kind : null,
  };
  // Do not store the plaintext url/auth input in JSON metadata or an audit.
  const { url, auth, ...safe } = payload;
  const v = (
    await query(c, 'SELECT supplier_remote_save_remote($1,$2,$3,$4) v', [
      id,
      JSON.stringify(safe),
      a.userId,
      a.apiKeyId ?? null,
    ])
  ).rows[0].v;
  await audit(c, a, 'supplier.remote.updated', id, {
    version: v.version,
    source_version: v.source_version,
    scope: v.scope,
    auth_kind: v.auth_kind,
  });
  const flags = await final(c, a, true);
  return { remote: v, reused: !!v.reused, ...flags };
}
export async function queueSupplierRemoteFetch(
  c: PoolClient,
  a: SupplierRemoteActor,
  id: string,
  input: SupplierRemoteFetchInput,
  internal?: { schedule_version: number },
) {
  await access(c, a, true);
  const b = supplierRemoteFetchInput.parse(input);
  await source(c, id, true);
  await access(c, a, true);
  const request = { ...b, ...(internal ? { schedule_version: internal.schedule_version } : {}) };
  const v = {
    ...request,
    id: randomUUID(),
    job_id: randomUUID(),
    request,
    request_hash: supplierRemoteRequestHash(a, 'fetch', id, request),
  };
  const r = (
    await query(c, 'SELECT supplier_remote_queue($1,$2,$3,$4) v', [
      id,
      JSON.stringify(v),
      a.userId,
      a.apiKeyId ?? null,
    ])
  ).rows[0].v;
  if (!r.reused)
    await audit(c, a, 'supplier.remote.queued', r.id, {
      source_id: id,
      schedule_version: internal?.schedule_version ?? null,
    });
  const f = await fetchRow(c, r.id),
    flags = await final(c, a, true);
  return { fetch: fetchView(f), reused: !!r.reused, ...flags };
}
export async function getSupplierFeedSchedule(c: PoolClient, a: SupplierRemoteActor, id: string) {
  await access(c, a);
  const s = await source(c, id),
    r = await remote(c, id),
    v = (await c.query('SELECT * FROM supplier_file_feed_schedules WHERE source_id=$1', [id]))
      .rows[0];
  const flags = await final(c, a, false);
  return { schedule: scheduleView(v, s, r), ...flags };
}
export async function updateSupplierFeedSchedule(
  c: PoolClient,
  a: SupplierRemoteActor,
  id: string,
  input: SupplierFeedScheduleInput,
) {
  await access(c, a, true);
  const b = supplierFeedScheduleInput.parse(input);
  await source(c, id, true);
  await access(c, a, true);
  const v = {
    ...b,
    id: randomUUID(),
    request_hash: supplierRemoteRequestHash(a, 'schedule', id, b),
  };
  const r = (
    await query(c, 'SELECT supplier_remote_save_schedule($1,$2,$3,$4) v', [
      id,
      JSON.stringify(v),
      a.userId,
      a.apiKeyId ?? null,
    ])
  ).rows[0].v;
  if (!r.reused)
    await audit(c, a, 'supplier.remote.schedule.updated', id, {
      version: r.version,
      enabled: r.enabled,
      publish: r.publish,
    });
  const flags = await final(c, a, true);
  return { schedule: r, reused: !!r.reused, ...flags };
}
export async function supplierRemoteFetchDetail(c: PoolClient, a: SupplierRemoteActor, id: string) {
  await access(c, a);
  const f = await fetchRow(c, id);
  let preview: any = null,
    run: any = null;
  ensure(!f.run_id || f.preview_id, 503, 'Niespójny trwały wynik pobrania');
  if (f.preview_id) {
    const p = (
      await c.query(
        'SELECT id,source_id,scope_hash,payload,created_at FROM supplier_file_previews WHERE tenant_id=$1 AND id=$2',
        [a.tenantId, f.preview_id],
      )
    ).rows[0];
    ensure(p && p.source_id === f.source_id, 503, 'Niespójny trwały wynik pobrania');
    // A manual 118 apply has its own receipt; fetch.run_id only records automatic publication.
    const r = (
      await c.query(
        'SELECT id,source_id,preview_id,payload,created_at FROM supplier_file_runs WHERE tenant_id=$1 AND preview_id=$2',
        [a.tenantId, f.preview_id],
      )
    ).rows[0];
    ensure(
      (!r || r.source_id === f.source_id) && (!f.run_id || r?.id === f.run_id),
      503,
      'Niespójny trwały wynik pobrania',
    );
    preview = strip118({
      ...p.payload,
      id: p.id,
      scope_hash: p.scope_hash,
      created_at: p.created_at,
      can_apply: false,
      executed_run_id: r?.id ?? null,
    });
    if (r) {
      const rr = (
        await c.query(
          'SELECT payload FROM supplier_file_run_rows WHERE tenant_id=$1 AND run_id=$2 ORDER BY index',
          [a.tenantId, r.id],
        )
      ).rows;
      const n = r.payload.rows.length;
      run = strip118({
        ...r.payload,
        id: r.id,
        source_id: r.source_id,
        preview_id: r.preview_id,
        scope_hash: preview.scope_hash,
        created_at: r.created_at,
        rows: rr.slice(0, n).map((x: any, i: number) => ({
          ...r.payload.rows[i],
          item_id: x.payload.item_id,
          after: x.payload.after,
        })),
        missing: rr.slice(n).map((x: any, i: number) => ({
          ...r.payload.missing[i],
          item_id: x.payload.item_id,
          after: x.payload.after,
        })),
      });
    }
  }
  const flags = await final(c, a, false);
  return { fetch: fetchView(f), preview, run, ...flags };
}
export async function supplierRemoteFetchHistory(
  c: PoolClient,
  a: SupplierRemoteActor,
  id: string,
  input: SupplierRemotePageInput,
) {
  await access(c, a);
  await source(c, id);
  const b = supplierRemotePageInput.parse(input);
  if (b.after)
    ensure(
      (
        await c.query('SELECT id FROM supplier_file_fetch_runs WHERE source_id=$1 AND id=$2', [
          id,
          b.after,
        ])
      ).rowCount,
      404,
      'Nie znaleziono kursora historii',
    );
  const rows = (
    await c.query(
      `SELECT ${fetchColumns} FROM supplier_file_fetch_runs WHERE source_id=$1 AND($2::uuid IS NULL OR(queued_at,id)<(SELECT queued_at,id FROM supplier_file_fetch_runs WHERE source_id=$1 AND id=$2)) ORDER BY queued_at DESC,id DESC LIMIT $3`,
      [id, b.after ?? null, b.limit + 1],
    )
  ).rows;
  const total = (
    await c.query('SELECT count(*)::integer n FROM supplier_file_fetch_runs WHERE source_id=$1', [
      id,
    ])
  ).rows[0].n;
  const data = rows.slice(0, b.limit).map(fetchView),
    flags = await final(c, a, false);
  return {
    data,
    meta: {
      total,
      has_more: rows.length > b.limit,
      cursor: rows.length > b.limit ? data.at(-1)?.id : null,
    },
    ...flags,
  };
}

function publishAllowed(p: any, policy: SupplierFeedPublishPolicy, existingItems: number): boolean {
  if (!policy.enabled || p.summary.invalid || (!policy.allow_new && p.summary.new > 0))
    return false;
  if (p.scope === 'full' && p.missing.length) {
    const w = policy.withdrawal;
    return (
      w.enabled &&
      p.rows.length >= w.min_rows &&
      p.missing.length <= w.max_missing &&
      p.missing.length * 100 <= Math.max(existingItems, 1) * w.max_missing_percent
    );
  }
  return true;
}
function sanitizedFailure(e: unknown): { code: string; status?: number } {
  if (e instanceof SupplierRemoteFetchError) return { code: e.code, status: e.http_status };
  if (e instanceof Problem)
    return {
      code:
        e.status === 401 || e.status === 403
          ? 'IAM_REVOKED'
          : e.status === 409
            ? e.message === 'QUOTA'
              ? 'QUOTA'
              : 'CONFIG_CHANGED'
            : e.status === 413
              ? 'QUOTA'
              : 'INVALID_SOURCE',
    };
  return { code: 'FETCH_FAILED' };
}
/** Claimed job only. Network runs after the initial tenant transaction commits. */
export async function processSupplierRemoteFetch(
  job: SupplierRemoteFetchJob,
  transport: SupplierRemoteFetchDependencies = {},
) {
  if (!(await backgroundAvailable())) return;
  try {
    const meta = await tenantTx(job.tenant_id, async (c) => {
      ensure(await supplierRemoteFeedsAvailable(c), 503, 'Moduł zdalnych feedów jest niekompletny');
      const m = (
        await query(c, 'SELECT supplier_remote_start($1,$2,$3) v', [
          job.payload.fetch_id,
          job.id,
          job.lease_token,
        ])
      ).rows[0].v;
      if (m.terminal) return m;
      const a: SupplierRemoteActor = {
        tenantId: job.tenant_id,
        userId: m.actor_id,
        role: (
          await c.query('SELECT supplier_remote_access($1,$2,true,false) g', [
            m.actor_id,
            m.api_key_id,
          ])
        ).rows[0].g.role,
        ...(m.api_key_id ? { apiKeyId: m.api_key_id } : {}),
      };
      await final(c, a, true);
      return m;
    });
    if (meta.terminal) return; // same-lease duplicate does NOT finish its shared job.
    const cfg = (
      await pool.query(
        'SELECT url_cipher,auth_cipher FROM supplier_file_remotes WHERE tenant_id=$1 AND source_id=$2 AND version=$3 AND source_version=$4',
        [job.tenant_id, meta.source_id, meta.remote_version, meta.source_version],
      )
    ).rows[0];
    ensure(cfg, 409, 'REMOTE_VERSION_CONFLICT');
    const response = await fetchSupplierRemoteFeed(
      {
        url: decrypt(cfg.url_cipher).url,
        auth: cfg.auth_cipher
          ? supplierRemoteAuthValue.parse(decrypt(cfg.auth_cipher).auth)
          : { kind: 'none' },
      },
      transport,
    );
    // This first implementation sends unconditional GET; 304 is never promoted
    // to new raw/freshness. Conditional reuse requires a separate accepted cache.
    ensure(response.kind === 'downloaded', 409, 'NOT_MODIFIED_WITHOUT_PRIOR');
    if (response.kind !== 'downloaded') return;
    await tenantTx(job.tenant_id, async (c) => {
      const g = (
        await c.query('SELECT supplier_remote_access($1,$2,true,false) g', [
          meta.actor_id,
          meta.api_key_id,
        ])
      ).rows[0].g;
      const a: SupplierRemoteActor = {
        tenantId: job.tenant_id,
        userId: meta.actor_id,
        role: g.role,
        ...(meta.api_key_id ? { apiKeyId: meta.api_key_id } : {}),
      };
      await access(c, a, true);
      await source(c, meta.source_id, true);
      // Fence before even creating a preview. Already started cannot be reclaimed
      // with start(); the held job row below belongs to this exact attempt.
      const fence = (
        await c.query(
          "SELECT 1 FROM jobs WHERE id=$1 AND kind=$2 AND payload->>'fetch_id'=$3 AND state='running' AND lease_token=$4 AND locked_at>clock_timestamp()-interval '5 minutes' FOR UPDATE",
          [job.id, SUPPLIER_REMOTE_FETCH_JOB, job.payload.fetch_id, job.lease_token],
        )
      ).rowCount;
      ensure(fence, 409, 'REMOTE_LEASE_LOST');
      const f = await fetchRow(c, job.payload.fetch_id);
      ensure(f.state === 'fetching', 409, 'REMOTE_LEASE_LOST');
      const r = await remote(c, meta.source_id);
      ensure(
        r && r.version === meta.remote_version && r.source_version === meta.source_version,
        409,
        'REMOTE_VERSION_CONFLICT',
      );
      const p = await previewSupplierFileSource(
        c,
        a,
        meta.source_id,
        {
          client_key: job.payload.fetch_id,
          version: meta.source_version,
          filename: 'remote-feed',
          content: response.content,
          scope: meta.scope,
        },
        internal118,
      );
      const existingItems = (
        await c.query(
          "SELECT jsonb_array_length(payload->'expected_items') n FROM supplier_file_previews WHERE id=$1",
          [p.preview.id],
        )
      ).rows[0].n;
      let run_id: string | null = null;
      if (
        meta.schedule_version !== null &&
        meta.policy &&
        publishAllowed(p.preview, meta.policy, existingItems)
      ) {
        const applied = await applySupplierFileSource(
          c,
          a,
          p.preview.id,
          {
            client_key: job.payload.fetch_id,
            confirm_rows: p.preview.rows.length,
            confirm_missing: p.preview.scope === 'full' && p.preview.missing.length > 0,
          },
          internal118,
        );
        run_id = applied.run.id;
      }
      const state =
        meta.schedule_version !== null && meta.policy?.enabled && !run_id
          ? 'awaiting-consent'
          : 'success';
      await query(c, 'SELECT supplier_remote_finish($1,$2,$3,$4)', [
        job.payload.fetch_id,
        job.id,
        job.lease_token,
        JSON.stringify({
          state,
          http_status: 200,
          wire_bytes: response.wire_bytes,
          decoded_bytes: response.decoded_bytes,
          wire_hash: response.wire_hash,
          raw_hash: response.raw_hash,
          preview_id: p.preview.id,
          run_id,
          error_code: state === 'awaiting-consent' ? 'AWAITING_CONSENT' : null,
        }),
      ]);
      await audit(c, a, 'supplier.remote.received', job.payload.fetch_id, {
        source_id: meta.source_id,
        preview_id: p.preview.id,
        run_id,
        raw_hash: response.raw_hash,
        state,
      });
      await final(c, a, true);
    });
  } catch (e) {
    await failSupplierRemoteFetch(job, e);
  }
}
export async function failSupplierRemoteFetch(job: SupplierRemoteFetchJob, e: unknown) {
  if (!(await backgroundAvailable())) return;
  let failure = sanitizedFailure(e);
  await tenantTx(job.tenant_id, async (c) => {
    const f = await fetchRow(c, job.payload.fetch_id),
      g = (
        await c.query('SELECT supplier_remote_access($1,$2,true,false) g', [
          f.actor_id,
          f.api_key_id,
        ])
      ).rows[0].g;
    if (!g.allowed) failure = { code: 'IAM_REVOKED' };
    // Failure cleanup is lease-bound, carries only fixed codes, and cannot create
    // a preview/catalog write or impersonate a principal whose IAM was revoked.
    const retry = (
      await query(c, 'SELECT supplier_remote_retry($1,$2,$3,$4,$5) ok', [
        job.payload.fetch_id,
        job.id,
        job.lease_token,
        failure.code,
        failure.status ?? null,
      ])
    ).rows[0].ok;
    if (retry) {
      await c.query('SET CONSTRAINTS ALL IMMEDIATE');
      return;
    }
    await query(c, 'SELECT supplier_remote_finish($1,$2,$3,$4)', [
      job.payload.fetch_id,
      job.id,
      job.lease_token,
      JSON.stringify({
        state: failure.code === 'CONFIG_CHANGED' ? 'conflict' : 'failed',
        error_code: failure.code,
        http_status: failure.status ?? null,
      }),
    ]);
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
  });
}
export async function reapSupplierRemoteFetches() {
  if (!(await backgroundAvailable())) return;
  const candidates = (
    await pool.query(
      "SELECT f.id,f.tenant_id FROM supplier_file_fetch_runs f JOIN jobs j ON(j.tenant_id,j.id)=(f.tenant_id,f.job_id) WHERE f.state IN('queued','fetching') AND(j.state='failed' OR(j.state='running' AND j.locked_at<clock_timestamp()-interval '5 minutes' AND j.attempts>=j.max_attempts)) ORDER BY f.queued_at,f.id LIMIT 20",
    )
  ).rows;
  for (const row of candidates)
    await tenantTx(row.tenant_id, async (c) => {
      await query(c, 'SELECT supplier_remote_reap($1)', [row.id]);
      await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    });
}
export async function scheduleSupplierRemoteFeedsDue() {
  if (!(await backgroundAvailable())) return;
  const candidates = (
    await pool.query(
      'SELECT tenant_id,source_id FROM supplier_file_feed_schedules WHERE enabled AND error_code IS NULL AND next_at<=now() ORDER BY next_at,source_id LIMIT 20',
    )
  ).rows;
  for (const row of candidates)
    await tenantTx(row.tenant_id, async (c) => {
      await source(c, row.source_id, true);
      await query(c, 'SELECT supplier_remote_sweep($1)', [row.source_id]);
      // No FOR UPDATE: dyna_app has SELECT only on schedules (119), so the row lock failed with 42501 on every
      // run. source(..., true) already serialises this tenant (advisory lock) and locks the source row.
      const cfg = (
        await c.query('SELECT * FROM supplier_file_feed_schedules WHERE source_id=$1', [
          row.source_id,
        ])
      ).rows[0];
      if (!cfg?.enabled || cfg.error_code || !cfg.next_at || new Date(cfg.next_at) > new Date())
        return;
      if (
        (
          await c.query(
            "SELECT 1 FROM supplier_file_fetch_runs WHERE source_id=$1 AND state IN('queued','fetching')",
            [row.source_id],
          )
        ).rowCount
      )
        return;
      const g = (
        await c.query('SELECT supplier_remote_access($1,$2,true,false) g', [
          cfg.actor_id,
          cfg.api_key_id,
        ])
      ).rows[0].g;
      if (!g.allowed) {
        await query(c, 'SELECT supplier_remote_sweep($1)', [row.source_id]);
        return;
      }
      const a: SupplierRemoteActor = {
        tenantId: row.tenant_id,
        userId: cfg.actor_id,
        role: g.role,
        ...(cfg.api_key_id ? { apiKeyId: cfg.api_key_id } : {}),
      };
      await c.query('SAVEPOINT supplier_remote_enqueue');
      try {
        await queueSupplierRemoteFetch(
          c,
          a,
          row.source_id,
          {
            client_key: randomUUID(),
            source_version: cfg.source_version,
            remote_version: cfg.remote_version,
          },
          { schedule_version: cfg.version },
        );
        await c.query('RELEASE SAVEPOINT supplier_remote_enqueue');
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT supplier_remote_enqueue');
        await c.query('RELEASE SAVEPOINT supplier_remote_enqueue');
        if (!(e instanceof Problem)) throw e;
        await query(c, 'SELECT supplier_remote_sweep($1)', [row.source_id]);
      }
    });
}
