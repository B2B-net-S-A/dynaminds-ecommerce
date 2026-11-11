/** Root-only, one-shot QA147 controlled transport proof. Never contacts a carrier.
 * Run from adopted primary: QA_EXPECTED_REVISION=<40hex> DYNA_WORKER_DISABLED=true
 * DYNA_LOCAL_CONFIG_PATH=<workspace>/app/.local.json
 * QA147_PROOF_CONFIRM=CONTROLLED_TRANSPORT_ONLY tsx scripts/shipment-label-cache-native-proof.ts
 * Explicit v2 after the first preflight-only timezone failure. Its empty original
 * journal and setup are verified and preserved; no queue or automatic resume.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Transport } from '../server/integrations';

const root = '<workspace>/app';
const evidenceRoot = '<workspace>/worktrees/stock-file-import/docs';
const statePath = resolve(root, 'data/shipment-label-cache-stage147.json');
const firstCustodyPath = resolve(root, 'data/shipment-label-cache-stage147-proof.json');
const custodyPath = resolve(root, 'data/shipment-label-cache-stage147-proof-v2.json');
const reportPath = resolve(evidenceRoot, 'shipment-label-cache-native-proof.json');
const revision = process.env.QA_EXPECTED_REVISION ?? '';
const digest = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const hash = (v: unknown) => digest(JSON.stringify(v));
const encode = (v: unknown) => JSON.stringify(v, null, 2) + '\n';
assert.match(revision, /^[a-f0-9]{40}$/);
assert.equal(process.env.QA147_PROOF_CONFIRM, 'CONTROLLED_TRANSPORT_ONLY');
assert.equal(process.env.DYNA_WORKER_DISABLED, 'true');
assert.notEqual(process.env.DYNA_TEST, 'true');
assert.equal(resolve(process.cwd()), root);
assert.equal(resolve(dirname(fileURLToPath(import.meta.url)), '..'), root);
const configPath = resolve(process.env.DYNA_LOCAL_CONFIG_PATH ?? '');
assert.equal(configPath, resolve(root, '.local.json'));
assert.equal((await lstat(configPath)).mode & 0o777, 0o600);
assert.equal((await lstat(statePath)).mode & 0o777, 0o600);
for (const path of [custodyPath, reportPath]) {
  try {
    await lstat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
    throw e;
  }
  throw Error('QA147 proof output already exists; never rerun or resume');
}
const setupBytes = await readFile(statePath);
const s = JSON.parse(setupBytes.toString());
assert.equal((await lstat(firstCustodyPath)).mode & 0o777, 0o600);
const firstCustodyBytes = await readFile(firstCustodyPath);
const firstCustody = JSON.parse(firstCustodyBytes.toString());
assert.equal(firstCustody.stage, 147);
assert.equal(firstCustody.setup_sha256, digest(setupBytes));
assert.equal(firstCustody.pending, null);
assert.deepEqual(firstCustody.completed, []);
assert.equal(firstCustody.status, 'IN_PROGRESS');
assert.equal(s.stage, 147);
assert.equal(s.complete, true);
assert.equal(s.pending, null);
assert.equal(s.fixture_seeded_source, true);
assert.equal(s.provider_verified, false);
assert.equal(s.orders.length, 2);
assert.equal(s.schema_revision, '131_shipment_label_cache');
const pdf = Buffer.from(s.controlled_pdf.content_base64, 'base64');
assert.equal(digest(pdf), s.controlled_pdf.content_sha256);
assert.equal(pdf.length, s.controlled_pdf.content_bytes);
assert.equal(s.controlled_pdf.warning, 'TEST TRANSPORTU - NIE DO NADANIA');
async function health() {
  const r = await fetch('http://127.0.0.1:4100/api/health', {
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(r.status, 200);
  const h = (await r.json()) as any;
  assert.equal(h.status, 'ok');
  assert.equal(h.mode, 'local');
  assert.equal(h.revision, revision);
  assert.equal(h.schema_revision, '131_shipment_label_cache');
  assert.equal(h.restore_preview, false);
  assert.equal(h.background_workers_enabled, false);
  assert.equal(h.shipment_label_cache_available, true);
}
await health();
const { pool } = await import('../server/db');
const connection = new URL(pool.options.connectionString!);
assert(['127.0.0.1', 'localhost'].includes(connection.hostname));
assert.equal(connection.port, '55432');
assert.equal(connection.pathname, '/dynaminds');
const {
  acquireShipmentLabelCache,
  shipmentLabelCacheMetadata,
  shipmentLabelCacheContent,
  shipmentLabelCacheHistory,
  reconcileShipmentLabelCache,
} = await import('../server/shipment-label-cache');
const { decrypt } = await import('../server/security');
const actor = {
  tenantId: s.tenant_id,
  userId: s.user_id,
  role: 'admin' as const,
  source: 'manual' as const,
};
type Checkpoint = Record<string, { count: number; sha256: string }>;
const journal: {
  stage: number;
  setup_sha256: string;
  pending: unknown;
  completed: unknown[];
  status: string;
} = {
  stage: 147,
  setup_sha256: digest(setupBytes),
  pending: null,
  completed: [],
  status: 'IN_PROGRESS',
};
async function atomic(path: string, value: unknown) {
  const tmp = path + '.' + randomUUID() + '.tmp';
  try {
    const f = await open(tmp, 'wx', 0o600);
    try {
      await f.writeFile(encode(value));
      await f.sync();
    } finally {
      await f.close();
    }
    await rename(tmp, path);
    const d = await open(dirname(path), 'r');
    try {
      await d.sync();
    } finally {
      await d.close();
    }
  } finally {
    await unlink(tmp).catch(() => {});
  }
}
async function exclusive(path: string, value: unknown) {
  const f = await open(path, 'wx', 0o600);
  try {
    await f.writeFile(encode(value));
    await f.sync();
  } finally {
    await f.close();
  }
}
async function checkpoint(timezone: 'UTC' | 'Europe/Warsaw' = 'UTC'): Promise<Checkpoint> {
  const c = await pool.connect();
  const result: Checkpoint = {};
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SELECT set_config('TimeZone',$1,true)", [timezone]);
    const db = (
      await c.query(
        "SELECT current_database() db,current_user role,inet_server_port() port,current_setting('transaction_read_only') ro",
      )
    ).rows[0];
    assert.equal(db.db, 'dynaminds');
    assert.equal(db.role, 'postgres');
    assert.equal(db.port, 55432);
    assert.equal(db.ro, 'on');
    const tables = (
      await c.query(
        "SELECT table_name FROM information_schema.tables t WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name<>'sessions' AND EXISTS(SELECT 1 FROM information_schema.columns k WHERE k.table_schema=t.table_schema AND k.table_name=t.table_name AND k.column_name='tenant_id') ORDER BY table_name",
      )
    ).rows;
    for (const { table_name: name } of tables) {
      assert.match(name, /^[a-z_][a-z0-9_]*$/);
      const r = (
        await c.query(
          `SELECT count(*)::integer n,coalesce(jsonb_agg(v ORDER BY v::text),'[]'::jsonb) data FROM (SELECT to_jsonb(t) v FROM "${name}" t WHERE tenant_id=$1) q`,
          [s.tenant_id],
        )
      ).rows[0];
      result[name] = { count: r.n, sha256: hash(r.data) };
    }
    await c.query('COMMIT');
    return result;
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}
function same(before: Checkpoint, after: Checkpoint, except: string[] = []) {
  assert.deepEqual(Object.keys(before), Object.keys(after));
  for (const t of Object.keys(before))
    if (!except.includes(t))
      assert.deepEqual(after[t], before[t], 'Unexpected own table change: ' + t);
}
function publicOnly(v: unknown) {
  if (!v || typeof v !== 'object') return;
  for (const [k, x] of Object.entries(v)) {
    assert(
      !/(?:password|token|credentials|encrypted|connection_hash|source_frame|request_hash|content_base64)/i.test(
        k,
      ),
      'Private field in public metadata',
    );
    publicOnly(x);
  }
}
async function mutation<T>(step: string, request: unknown, fn: () => Promise<T>): Promise<T> {
  assert.equal(journal.pending, null);
  await health();
  journal.pending = { step, request, started_at: new Date().toISOString() };
  await atomic(custodyPath, journal);
  const r = await fn();
  publicOnly(r);
  journal.completed.push({ step, receipt: r });
  journal.pending = null;
  await atomic(custodyPath, journal);
  return r;
}
let getCount = 0;
const observed: unknown[] = [];
function transport(o: any, key: string, fail = false): Transport {
  return async (url, init) => {
    getCount++;
    assert.equal(
      url,
      `https://sandbox-api-shipx-pl.easypack24.net/v1/shipments/${encodeURIComponent(o.external_id)}/label?format=pdf&type=A6`,
    );
    assert.equal(init.method, 'GET');
    assert.equal(init.body, undefined);
    // A separate owner read sees committed intent, not this service transaction.
    const c = await pool.connect();
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const rows = (
        await c.query(
          'SELECT id,state,asset_id,source_hash FROM shipment_label_cache_acquisitions WHERE tenant_id=$1 AND shipment_id=$2 AND client_key=$3',
          [s.tenant_id, o.shipment_id, key],
        )
      ).rows;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].state, 'fetching');
      assert.equal(rows[0].asset_id, null);
      const n = (
        await c.query('SELECT count(*)::integer n FROM print_jobs WHERE tenant_id=$1', [
          s.tenant_id,
        ])
      ).rows[0].n;
      assert.equal(n, 0);
      observed.push({
        acquisition_id: rows[0].id,
        state: 'fetching',
        committed_before_get: true,
        print_jobs: 0,
      });
      await c.query('COMMIT');
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
    if (fail) throw Error('CONTROLLED_TRANSPORT_INTERRUPTED');
    return new Response(new Uint8Array(pdf), {
      status: 200,
      headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(pdf.length) },
    });
  };
}
await exclusive(custodyPath, journal);
try {
  // Reproduce the immutable setup serialization under its verified original
  // TimeZone. This comparison MUST pass before taking a separate UTC baseline.
  const setupTimezoneCheckpoint = await checkpoint('Europe/Warsaw');
  for (const t of [
    'shipment_label_cache_assets',
    'shipment_label_cache_acquisitions',
    'print_jobs',
    'print_label_previews',
    'print_job_label_sources',
  ])
    assert.equal(setupTimezoneCheckpoint[t]?.count, 0);
  for (const t of Object.keys(s.setup_checkpoint))
    if (!['users', 'tenants'].includes(t))
      assert.deepEqual(
        setupTimezoneCheckpoint[t],
        s.setup_checkpoint[t],
        'Setup changed before proof: ' + t,
      );
  const before = await checkpoint();
  assert.deepEqual(Object.keys(before), Object.keys(setupTimezoneCheckpoint));
  for (const t of Object.keys(before))
    assert.equal(
      before[t].count,
      setupTimezoneCheckpoint[t].count,
      'Count changed between timezone readbacks: ' + t,
    );
  const first = s.orders[0],
    second = s.orders[1];
  const m = await shipmentLabelCacheMetadata(actor, first.shipment_id);
  assert.equal(m.can_acquire, true);
  assert.equal(m.cache, null);
  const body = {
    client_key: randomUUID(),
    order_version: m.order_version!,
    source_hash: m.source_hash!,
    confirmed_existing_label: true as const,
  };
  const ready = await mutation('acquire-ready', body, () =>
    acquireShipmentLabelCache(actor, first.shipment_id, body, {
      transport: transport(first, body.client_key),
    }),
  );
  assert.equal(ready.acquisition.state, 'ready');
  assert.equal(ready.reused, false);
  assert(ready.cache);
  assert.equal(getCount, 1);
  assert.equal(ready.cache.content_sha256, digest(pdf));
  assert.equal(ready.cache.content_bytes, pdf.length);
  assert.equal(ready.cache.origin, 'provider_get');
  const saved = (
    await pool.query(
      'SELECT content_encrypted,content_sha256,content_bytes,acquisition_id FROM shipment_label_cache_assets WHERE tenant_id=$1 AND id=$2',
      [s.tenant_id, ready.cache.id],
    )
  ).rows[0];
  const encryptedExact = decrypt(saved.content_encrypted).content_base64 === pdf.toString('base64');
  assert.equal(encryptedExact, true);
  assert.notEqual(saved.content_encrypted, pdf.toString('base64'));
  assert.equal(saved.acquisition_id, ready.acquisition.id);
  const afterReady = await checkpoint();
  same(before, afterReady, [
    'shipment_label_cache_assets',
    'shipment_label_cache_acquisitions',
    'audit_events',
  ]);
  const replay = await mutation('exact-acquire-replay', body, () =>
    acquireShipmentLabelCache(actor, first.shipment_id, body, {
      transport: transport(first, body.client_key),
    }),
  );
  assert.equal(replay.reused, true);
  assert.deepEqual(replay.cache, ready.cache);
  assert.deepEqual(replay.acquisition, ready.acquisition);
  assert.equal(getCount, 1);
  same(afterReady, await checkpoint());
  const hitBody = { ...body, client_key: randomUUID() };
  const hit = await mutation('new-key-cache-hit', hitBody, () =>
    acquireShipmentLabelCache(actor, first.shipment_id, hitBody, {
      transport: transport(first, hitBody.client_key),
    }),
  );
  assert.equal(hit.reused, false);
  assert.equal(hit.acquisition.state, 'ready');
  assert.notEqual(hit.acquisition.id, ready.acquisition.id);
  assert.deepEqual(hit.cache, ready.cache);
  assert.equal(getCount, 1);
  const afterHit = await checkpoint();
  same(afterReady, afterHit, ['shipment_label_cache_acquisitions', 'audit_events']);
  const m2 = await shipmentLabelCacheMetadata(actor, second.shipment_id);
  assert.equal(m2.can_acquire, true);
  const failureBody = {
    client_key: randomUUID(),
    order_version: m2.order_version!,
    source_hash: m2.source_hash!,
    confirmed_existing_label: true as const,
  };
  const unknown = await mutation('controlled-unknown', failureBody, () =>
    acquireShipmentLabelCache(actor, second.shipment_id, failureBody, {
      transport: transport(second, failureBody.client_key, true),
    }),
  );
  assert.equal(unknown.acquisition.state, 'unknown');
  assert.equal(unknown.cache, null);
  assert.equal(getCount, 2);
  const unknownCheckpoint = await checkpoint();
  same(afterHit, unknownCheckpoint, ['shipment_label_cache_acquisitions', 'audit_events']);
  const noGetReplay = await mutation('unknown-exact-replay', failureBody, () =>
    acquireShipmentLabelCache(actor, second.shipment_id, failureBody, {
      transport: transport(second, failureBody.client_key, true),
    }),
  );
  assert.equal(noGetReplay.reused, true);
  assert.equal(noGetReplay.acquisition.state, 'unknown');
  assert.equal(getCount, 2);
  same(unknownCheckpoint, await checkpoint());
  const reconcileBody = { client_key: randomUUID(), confirmed_abandon: true as const };
  const abandoned = await mutation('manual-abandon', reconcileBody, () =>
    reconcileShipmentLabelCache(actor, unknown.acquisition.id, reconcileBody),
  );
  assert.equal(abandoned.acquisition.state, 'abandoned');
  assert.equal(abandoned.cache, null);
  assert.equal(getCount, 2);
  const final = await checkpoint();
  same(before, final, [
    'shipment_label_cache_assets',
    'shipment_label_cache_acquisitions',
    'audit_events',
  ]);
  assert.equal(final.shipment_label_cache_assets.count, 1);
  assert.equal(final.shipment_label_cache_acquisitions.count, 3);
  assert.equal(final.print_jobs.count, 0);
  const content = await shipmentLabelCacheContent(actor, ready.cache.id);
  assert.equal(content.content_base64, pdf.toString('base64'));
  const history = await shipmentLabelCacheHistory(actor, first.shipment_id, { limit: 50 });
  assert.equal(history.data.length, 2);
  assert.equal(history.next_cursor, null);
  publicOnly(history);
  same(final, await checkpoint());
  await health();
  assert.equal(digest(await readFile(statePath)), digest(setupBytes));
  assert.equal(digest(await readFile(firstCustodyPath)), digest(firstCustodyBytes));
  journal.status = 'PASS_LIMITED';
  await atomic(custodyPath, journal);
  await exclusive(reportPath, {
    stage: 147,
    status: 'PASS_LIMITED_CONTROLLED_TRANSPORT',
    runtime_revision: revision,
    setup_revision: s.runtime_revision,
    schema_revision: s.schema_revision,
    tenant_id: s.tenant_id,
    source_origin: 'owner_seeded_synthetic_sandbox_shipments',
    provider_verified: false,
    external_provider_verified: false,
    physical_dispatch_verified: false,
    physical_print_verified: false,
    controlled_gets: 2,
    successful_gets: 1,
    interrupted_gets: 1,
    committed_intent_observations: observed,
    encrypted_exact: encryptedExact,
    cache: ready.cache,
    ready_acquisition: ready.acquisition.id,
    cache_hit_acquisition: hit.acquisition.id,
    abandoned_acquisition: abandoned.acquisition.id,
    acquisitions: 3,
    assets: 1,
    print_jobs: 0,
    exact_replay_gets: 0,
    new_key_cache_hit_gets: 0,
    unknown_replay_gets: 0,
    reconcile_gets: 0,
    own_tables: Object.keys(final).length,
    own_noncache_business_unchanged: true,
    readback_effect_free: true,
    setup_sha256: digest(setupBytes),
    first_attempt_preflight_only: true,
    first_attempt_custody_sha256: digest(firstCustodyBytes),
    original_setup_checkpoint_preserved: true,
    setup_checkpoint_timezone: 'Europe/Warsaw',
    mutation_checkpoint_timezone: 'UTC',
    original_setup_checkpoint_verified_sha256: hash(setupTimezoneCheckpoint),
    before_sha256: hash(before),
    after_sha256: hash(final),
    fixture_warning: s.controlled_pdf.warning,
    full_goal_complete: false,
    next: 'Separate native Chrome all-page PDF review and explicit queue consent; no job was created by this proof.',
  });
  console.log(
    JSON.stringify({
      status: 'PASS_LIMITED_CONTROLLED_TRANSPORT',
      assets: 1,
      acquisitions: 3,
      controlled_gets: 2,
      print_jobs: 0,
      external_provider_verified: false,
    }),
  );
} catch {
  throw Error(
    'QA147 controlled proof interrupted; custody retained. Do not rerun or print private errors.',
  );
} finally {
  await pool.end();
}
