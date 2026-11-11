/** Root-only QA128 restart verification; authoring this file does not execute it.
 * QA_EXPECTED_REVISION=<accepted SHA> QA128_DATABASE_NAME=dynaminds
 * DYNA_WORKER_DISABLED=true QA128_RESTART_VERIFIED=true DATABASE_URL=<loopback>
 * tsx scripts/b2b-dropshipping-returns-native-restart-proof.ts verify
 * Only GET and UTC repeatable-read/read-only SQL. No login, mutation or checkpoint rewrite.
 * The explicit flag attests the root's observed shutdown/relaunch, not merely healthy HTTP.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import type { Pool } from 'pg';

type Row = Record<string, any>;
type Actor = { tenant: string; user: string; cookie: string };
type Mark = { count: number; sha256: string };
type Checkpoint = { buyer: Record<string, Mark>; supplier: Record<string, Mark> };
const setupPath = 'data/b2b-dropshipping-returns-stage128.json';
const checkpointPath = 'data/b2b-dropshipping-returns-stage128-chrome-checkpoint.json';
const setupReportPath = 'docs/b2b-dropshipping-returns-native-setup-qa.json';
const chromeReportPath = 'docs/b2b-dropshipping-returns-native-chrome-qa.json';
const reportPath = process.env.QA_REPORT_FILE ?? 'docs/b2b-dropshipping-returns-native-restart-qa.json';
assert.match(reportPath, /^docs\/b2b-dropshipping-returns-native-restart(?:-[a-z0-9]+)*-qa\.json$/);
const schema = '111_b2b_dropshipping_returns';
const prefix = '/b2b/dropshipping-returns';
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const bytesHash = (v: Buffer) => createHash('sha256').update(v).digest('hex');
let pool: Pool | undefined;
let step = 'preflight';
async function privateFile(path: string) {
  const st = await lstat(path);
  assert(st.isFile() && !st.isSymbolicLink() && (st.mode & 0o777) === 0o600);
  assert(st.size <= 32 * 1024 * 1024);
  return readFile(path);
}
async function absent(path: string) {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error('Existing report must not be overwritten');
}
async function get(actor: Actor | null, route: string): Promise<Row> {
  assert(route.startsWith('/') && !route.startsWith('//'));
  const response = await fetch('http://127.0.0.1:4100/api' + route, {
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
    cache: 'no-store',
    headers: actor ? { cookie: actor.cookie, 'X-Workspace-ID': actor.tenant } : {},
  });
  assert.equal(response.status, 200, 'Required GET failed; root must resolve expired cookies');
  if (actor) assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.text();
  assert(Buffer.byteLength(body) <= 8 * 1024 * 1024);
  return JSON.parse(body) as Row;
}
async function health(revision: string) {
  const h = await get(null, '/health');
  assert.equal(h.status, 'ok');
  assert.equal(h.mode, 'local');
  assert.equal(h.revision, revision);
  assert.equal(h.schema_revision, schema);
  assert.equal(h.restore_preview, false);
  assert.equal(h.background_workers_enabled, false);
  assert.equal(h.b2b_dropshipping_returns_available, true);
}
async function snapshot(s: Row, db: URL): Promise<Checkpoint> {
  assert(pool);
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    assert.equal((await c.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'on');
    const info = (
      await c.query(`SELECT current_database() name,host(inet_server_addr()) host,
      inet_server_port() port,(SELECT name FROM migrations ORDER BY name DESC LIMIT 1) schema_revision`)
    ).rows[0];
    assert.equal(info.name, 'dynaminds');
    assert(['127.0.0.1', '::1'].includes(info.host));
    assert.equal(info.port, Number(db.port || 5432));
    assert.equal(info.schema_revision, schema);
    const names: string[] = (
      await c.query(`SELECT t.table_name FROM information_schema.tables t
      JOIN information_schema.columns k USING(table_schema,table_name)
      WHERE t.table_schema='public' AND t.table_type='BASE TABLE' AND k.column_name='tenant_id'
      AND t.table_name<>'sessions' UNION SELECT 'users' UNION SELECT 'tenants' ORDER BY 1`)
    ).rows.map((r) => r.table_name);
    assert.equal(names.length, 303, 'Exact accepted schema table set');
    const out: Checkpoint = { buyer: {}, supplier: {} };
    for (const side of ['buyer', 'supplier'] as const) {
      assert.deepEqual(names, Object.keys(s.checkpoint[side]).sort());
      const actor = s[side] as Actor;
      for (const name of names) {
        assert.match(name, /^[a-z_][a-z0-9_]*$/);
        const key = name === 'users' || name === 'tenants' ? 'id' : 'tenant_id';
        const rows = (
          await c.query(`SELECT to_jsonb(t) row FROM "${name}" t WHERE ${key}=$1 ORDER BY 1`, [
            name === 'users' ? actor.user : actor.tenant,
          ])
        ).rows;
        out[side][name] = { count: rows.length, sha256: hash(rows) };
      }
    }
    await c.query('COMMIT');
    return out;
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}
async function apiEvidence(s: Row, accepted: Row) {
  const e = accepted.evidence;
  for (const key of ['buyer_return_id', 'supplier_return_id', 'case_id', 'preview_id'])
    assert.match(e[key], /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  assert.equal(e.row.retail_refund_minor, '1000');
  assert.equal(e.row.wholesale_refund_minor, '700');
  for (const side of ['buyer', 'supplier'] as const) {
    const actor = s[side] as Actor;
    assert.deepEqual({ tenant: actor.tenant, user: actor.user }, accepted[side]);
    assert(typeof actor.cookie === 'string' && actor.cookie.length > 0);
    const me = (await get(actor, '/auth/me')).user;
    assert.equal(me.id, actor.user);
    assert.equal(me.tenant_id, actor.tenant);
    assert.equal(me.role, 'admin');
    const rid = side === 'buyer' ? e.buyer_return_id : e.supplier_return_id;
    const r = await get(actor, '/returns/' + rid);
    assert.equal(r.id, rid);
    assert.equal(r.state, 'refund_pending');
    assert.equal(r.refund_amount, side === 'buyer' ? 1000 : 700);
    assert.equal(r.refunded_shipping, 0);
    assert.equal(r.refunded_at, null);
    assert.equal(r.settlement, null);
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].accepted, 1);
    assert.equal(r.items[0].restocked, side === 'buyer' ? 0 : 1);
    if (side === 'buyer') {
      assert.equal(r.received_at, null);
      assert.equal(r.receipt, null);
      assert.equal(r.acceptance_kind, 'partner');
      assert.equal(r.partner_acceptance.kind, 'partner');
      assert.deepEqual(r.partner_acceptance.case_ids, [e.case_id]);
    } else {
      assert(r.received_at && r.receipt);
      assert.equal(r.acceptance_kind, 'physical');
      assert(r.physical_received_at);
    }
    const context = await get(actor, prefix + '/returns/' + rid + '/context');
    assert.equal(context.current_role, 'admin');
    assert.equal(context.read_only, false);
    assert.equal(context.context.can_receive_locally, false);
    if (side === 'buyer') {
      assert.equal(context.context.can_reconcile, false);
      assert.deepEqual(
        context.context.case_refs.map((v: Row) => v.id),
        [e.case_id],
      );
    }
    const detail = await get(actor, prefix + '/cases/' + e.case_id);
    assert.equal(detail.current_role, 'admin');
    assert.equal(detail.read_only, false);
    assert.equal(detail.case.id, e.case_id);
    assert.equal(detail.case.preview_id, e.preview_id);
    assert.equal(detail.case.state, 'received');
    assert.equal(detail.case.wholesale_refund_minor, '700');
    assert(detail.case.received_at && detail.case.retail_reconciled_at);
    const rows = await get(actor, prefix + '/cases/' + e.case_id + '/rows?limit=100');
    assert.equal(rows.meta.total, 1);
    assert.equal(rows.meta.cursor, null);
    assert.equal(rows.data.length, 1);
    for (const key of [
      'customer_item_id',
      'dropship_order_id',
      'quantity',
      'retail_refund_minor',
      'wholesale_refund_minor',
    ])
      assert.deepEqual(rows.data[0][key], e.row[key]);
    const events = await get(actor, prefix + '/cases/' + e.case_id + '/events?limit=100');
    assert.equal(events.meta.total, 3);
    assert.equal(events.meta.cursor, null);
    assert.deepEqual(events.data.map((v: Row) => v.kind).sort(), [
      'receive',
      'reconcile',
      'submit',
    ]);
    assert.deepEqual(
      events.data.map((v: Row) => v.id).sort(),
      e.actions
        .filter((v: Row) => v.kind !== 'settings')
        .map((v: Row) => v.id)
        .sort(),
    );
  }
}

try {
  assert.equal(process.argv[2], 'verify');
  assert.equal(
    process.env.QA128_RESTART_VERIFIED,
    'true',
    'Root observed orderly stop/relaunch attestation required',
  );
  assert.equal(process.env.DYNA_WORKER_DISABLED, 'true');
  assert.notEqual(process.env.DYNA_TEST, 'true');
  const revision = process.env.QA_EXPECTED_REVISION ?? '';
  assert.match(revision, /^[a-f0-9]{7,40}$/);
  const db = new URL(process.env.DATABASE_URL ?? '');
  assert(['localhost', '127.0.0.1', '[::1]'].includes(db.hostname));
  assert(['postgres:', 'postgresql:'].includes(db.protocol));
  assert.equal(db.search, '');
  assert.equal(db.pathname, '/dynaminds');
  assert.equal(process.env.QA128_DATABASE_NAME, 'dynaminds');
  const config = await lstat(process.env.DYNA_LOCAL_CONFIG_PATH ?? '.local.json');
  assert(config.isFile() && !config.isSymbolicLink() && !(config.mode & 0o077));
  await absent(reportPath);
  const setupBytes = await privateFile(setupPath),
    acceptedBytes = await privateFile(checkpointPath);
  const setupReportBytes = await readFile(setupReportPath),
    chromeReportBytes = await readFile(chromeReportPath);
  const s: Row = JSON.parse(setupBytes.toString('utf8')),
    accepted: Row = JSON.parse(acceptedBytes.toString('utf8')),
    setupReport: Row = JSON.parse(setupReportBytes.toString('utf8')),
    chromeReport: Row = JSON.parse(chromeReportBytes.toString('utf8'));
  assert.equal(s.stage128, true);
  assert.equal(s.setup_complete, true);
  assert.equal(s.pending, null);
  assert.equal(accepted.stage128, true);
  assert.equal(accepted.chrome_human_attested, true);
  for (const state of [s, accepted]) {
    assert.equal(state.runtime_revision, revision);
    assert.equal(state.schema_revision, schema);
  }
  assert.equal(setupBytes.length, accepted.setup.bytes);
  assert.equal(bytesHash(setupBytes), accepted.setup.sha256);
  assert.equal(bytesHash(setupReportBytes), accepted.setup.report_sha256);
  assert.equal(hash(s.setup_checkpoint), accepted.setup.checkpoint_sha256);
  assert.equal(setupReport.status, 'PASS');
  assert.equal(setupReport.revision, revision);
  assert.equal(setupReport.schema_revision, schema);
  assert.equal(setupReport.setup_checkpoint_sha256, accepted.setup.checkpoint_sha256);
  assert.equal(chromeReport.status, 'PASS');
  assert.equal(chromeReport.revision, revision);
  assert.equal(chromeReport.schema_revision, schema);
  assert.deepEqual(chromeReport.setup, accepted.setup);
  assert.equal(chromeReport.checkpoint_sha256, hash(accepted.checkpoint));
  assert.deepEqual(chromeReport.own_tables, { buyer: 303, supplier: 303 });
  step = 'health_after_attested_restart';
  await health(revision);
  pool = (await import('../server/db')).pool;
  step = 'exact_accepted_snapshot_before_GET';
  assert.deepEqual(await snapshot(accepted, db), accepted.checkpoint);
  step = 'original_cookie_GET_RMA_evidence';
  await apiEvidence(s, accepted);
  await health(revision);
  step = 'exact_accepted_snapshot_after_GET';
  assert.deepEqual(await snapshot(accepted, db), accepted.checkpoint);
  step = 'immutable_files';
  assert.deepEqual(await privateFile(setupPath), setupBytes);
  assert.deepEqual(await privateFile(checkpointPath), acceptedBytes);
  assert.deepEqual(await readFile(setupReportPath), setupReportBytes);
  assert.deepEqual(await readFile(chromeReportPath), chromeReportBytes);
  step = 'save_public_report';
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        stage: 128,
        phase: 'native_restart',
        status: 'PASS',
        revision,
        schema_revision: schema,
        own_tables: { buyer: 303, supplier: 303 },
        checkpoint_sha256: hash(accepted.checkpoint),
        accepted_checkpoint_file_sha256: bytesHash(acceptedBytes),
        setup_sha256: bytesHash(setupBytes),
        original_setup_and_checkpoint_bytes_unchanged: true,
        full_business_exact_before_and_after_GET: true,
        sessions_excluded: true,
        background_workers_enabled: false,
        restart_verified: true,
        root_shutdown_relaunch_attestation: {
          confirmed: true,
          source: 'Explicit QA128_RESTART_VERIFIED=true after root observed orderly stop/relaunch',
          independently_inferred_from_health: false,
        },
        retail_credit_minor: 1000,
        wholesale_credit_minor: 700,
        retail_acceptance_kind: 'partner',
        buyer_physical_received: false,
        supplier_received_quantity: 1,
        supplier_restocked_quantity: 1,
        database_writes: false,
        private_checkpoint_rewritten: false,
        original_baseline_rebased: false,
        restore_verified: false,
        lost_ack_verified: false,
        live_provider_verified: false,
        bank_payment_verified: false,
        private_credentials_published: false,
        full_goal_complete: false,
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
  process.stdout.write(
    'QA128 native restart PASS (two exact 303-table checkpoints; no database writes)\n',
  );
} catch (error) {
  const failure = error as Error & { code?: string };
  const line = failure.stack?.match(
    /b2b-dropshipping-returns-native-restart-proof\.ts:(\d+):\d+/,
  )?.[1];
  const safe = {
    stage: 128,
    phase: 'native_restart',
    status: 'FAIL',
    step,
    code:
      typeof failure.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(failure.code)
        ? failure.code
        : null,
    source_line: line ? Number(line) : null,
    private_checkpoint_rewritten: false,
    database_writes: false,
    automatic_retry: false,
    restore_verified: false,
    full_goal_complete: false,
  };
  await writeFile(reportPath, JSON.stringify(safe, null, 2) + '\n', { flag: 'wx' }).catch(() => {});
  process.stderr.write(JSON.stringify(safe) + '\n');
  process.exitCode = 1;
} finally {
  await pool?.end();
}
