/** Root-only QA129 followup, never execute while authoring.
 * QA_EXPECTED_REVISION=<reviewed application SHA> QA129_DATABASE_NAME=dynaminds
 * DYNA_WORKER_DISABLED=true QA129_RESTART_VERIFIED=true DATABASE_URL=<loopback>
 * tsx scripts/b2b-return-local-origins-native-restart-proof.ts verify
 * Requires the NEW Chrome checkpoint and separate root stop/relaunch report.
 * GET + UTC repeatable-read/read-only SQL only; no login, mutation or baseline rewrite.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import type { Pool } from 'pg';

type Row = Record<string, any>;
type Actor = { tenant: string; user: string; warehouse: string; cookie: string };
type Mark = { count: number; sha256: string };
type Snapshot = Record<string, Mark>;
type Checkpoint = { buyer: Snapshot; supplier: Snapshot };
const setupPath = 'data/b2b-return-local-origins-stage129.json';
const checkpointPath = 'data/b2b-return-local-origins-stage129-chrome-checkpoint.json';
const setupReportPath = 'docs/b2b-return-local-origins-native-setup-qa.json';
const chromeReportPath = 'docs/b2b-return-local-origins-native-chrome-qa.json';
const processReportPath = 'docs/b2b-return-local-origins-restart-process-qa.json';
const reportPath = 'docs/b2b-return-local-origins-native-restart-qa.json';
const schema = '112_b2b_return_local_origins';
const prefix = '/b2b/dropshipping-returns';
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const bytesHash = (v: Buffer) => createHash('sha256').update(v).digest('hex');
const uuid = (v: unknown) =>
  assert(typeof v === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v));
let pool: Pool | undefined;
let step = 'no_write_preflight';

async function privateFile(path: string) {
  const st = await lstat(path);
  assert(st.isFile() && !st.isSymbolicLink() && (st.mode & 0o777) === 0o600);
  assert(st.size <= 32 * 1024 * 1024);
  return readFile(path);
}
async function publicFile(path: string) {
  const st = await lstat(path);
  assert(st.isFile() && !st.isSymbolicLink() && st.size <= 8 * 1024 * 1024);
  return readFile(path);
}
async function absent(path: string) {
  try {
    await lstat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  throw Error('Existing report refuses overwrite or rebase');
}
async function get(actor: Actor | null, route: string): Promise<Row> {
  assert(route.startsWith('/') && !route.startsWith('//'));
  const response = await fetch('http://127.0.0.1:4100/api' + route, {
    method: 'GET',
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(30000),
    headers: actor ? { cookie: actor.cookie, 'X-Workspace-ID': actor.tenant } : {},
  });
  assert.equal(
    response.status,
    200,
    'Required GET failed; expired cookies require root action, never automatic login',
  );
  if (actor) assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  const text = await response.text();
  assert(Buffer.byteLength(text) <= 8 * 1024 * 1024);
  return JSON.parse(text) as Row;
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
  assert.equal(h.b2b_local_return_origins_available, true);
}
async function pages(actor: Actor, route: string): Promise<Row[]> {
  const all: Row[] = [],
    seen = new Set<string>();
  let cursor: string | null = null,
    total: number | undefined;
  do {
    const response: Row = await get(
      actor,
      route +
        (route.includes('?') ? '&' : '?') +
        'limit=100' +
        (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
    );
    assert.equal(response.current_role, 'admin');
    assert.equal(response.read_only, false);
    assert(Array.isArray(response.data) && response.data.length <= 100);
    assert(
      Number.isSafeInteger(response.meta.total) &&
        response.meta.total >= 0 &&
        response.meta.total <= 10000,
    );
    if (total === undefined) total = response.meta.total as number;
    else assert.equal(response.meta.total, total);
    all.push(...response.data);
    assert(all.length <= total);
    cursor = response.meta.cursor;
    assert(cursor === null || typeof cursor === 'string');
    if (cursor) {
      assert(!seen.has(cursor));
      seen.add(cursor);
    }
  } while (cursor);
  assert.equal(all.length, total);
  return all;
}
async function snapshot(s: Row, accepted: Row, db: URL): Promise<Checkpoint> {
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
    assert.equal(names.length, 305, 'Exact reviewed schema table set');
    const out: Checkpoint = { buyer: {}, supplier: {} };
    for (const side of ['buyer', 'supplier'] as const) {
      assert.deepEqual(names, Object.keys(accepted.checkpoint[side]).sort());
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
      for (const name of [
        'payment_entries',
        'order_items',
        'order_pick_items',
        'reservations',
        'reservation_locations',
        'shipments',
        'shopify_dispatch_evidence',
        'order_source_lines',
      ]) {
        assert(out[side][name] && s.setup_checkpoint[side][name]);
        assert.deepEqual(
          out[side][name],
          s.setup_checkpoint[side][name],
          'Original cash, commerce and dispatch custody must remain exact',
        );
      }
      const stock = (
        await c.query(
          'SELECT on_hand,reserved,available FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3',
          [actor.tenant, actor.warehouse, s[side + '_product']],
        )
      ).rows;
      assert.deepEqual(stock, [
        { on_hand: side === 'buyer' ? 5 : 19, reserved: 0, available: side === 'buyer' ? 5 : 19 },
      ]);
      const deltas = (
        await c.query(
          `SELECT delta,kind,return_id FROM stock_movements
        WHERE tenant_id=$1 AND return_id IS NOT NULL ORDER BY return_id,id`,
          [actor.tenant],
        )
      ).rows;
      assert.deepEqual(deltas, [
        {
          delta: 1,
          kind: 'return',
          return_id: accepted.evidence[side === 'buyer' ? 'local_return_id' : 'supplier_return_id'],
        },
      ]);
    }
    const e = accepted.evidence;
    const origin = (
      await c.query(
        'SELECT id,return_id,order_id,actor_id,scope_hash,request FROM b2b_return_local_origins WHERE tenant_id=$1 ORDER BY id',
        [s.buyer.tenant],
      )
    ).rows;
    assert.equal(origin.length, 1);
    assert.equal(origin[0].id, e.origin_id);
    assert.equal(origin[0].return_id, e.local_return_id);
    assert.equal(origin[0].order_id, s.customer_order);
    assert.equal(origin[0].actor_id, s.buyer.user);
    assert.deepEqual(origin[0].request.items, [
      { customer_item_id: s.customer_item, shipment_id: s.local_shipment, quantity: 1 },
    ]);
    const proofs = (
      await c.query(
        'SELECT id,origin_id,return_id,applied,before_snapshot,after_snapshot FROM b2b_return_local_proofs WHERE tenant_id=$1 ORDER BY id',
        [s.buyer.tenant],
      )
    ).rows;
    assert.equal(proofs.length, 1);
    assert.equal(proofs[0].id, e.local_proof_id);
    assert.equal(proofs[0].origin_id, e.origin_id);
    assert.equal(proofs[0].return_id, e.local_return_id);
    assert.equal(proofs[0].applied, true);
    assert(proofs[0].before_snapshot && proofs[0].after_snapshot);
    assert.equal(proofs[0].after_snapshot.head.refund_amount, 2500);
    assert(proofs[0].after_snapshot.head.received_at);
    await c.query('COMMIT');
    return out;
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}
function assertRma(
  r: Row,
  id: string,
  amount: number,
  itemId: string | null,
  restocked: number,
  physical: boolean,
) {
  assert.equal(r.id, id);
  assert.equal(r.state, 'refund_pending');
  assert.equal(r.refund_amount, amount);
  assert.equal(r.refunded_shipping, 0);
  assert.equal(r.refunded_at, null);
  assert.equal(r.settlement, null);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].requested, 1);
  assert.equal(r.items[0].accepted, 1);
  assert.equal(r.items[0].restocked, restocked);
  if (itemId) assert.equal(r.items[0].item_id, itemId);
  assert.equal(r.acceptance_kind, physical ? 'physical' : 'partner');
  assert(r.accepted_at);
  if (physical) {
    assert(r.received_at && r.receipt && r.physical_received_at);
  } else {
    assert.equal(r.received_at, null);
    assert.equal(r.receipt, null);
    assert.equal(r.physical_received_at, null);
  }
}
async function apiEvidence(s: Row, accepted: Row) {
  const e = accepted.evidence,
    buyer = s.buyer as Actor,
    supplier = s.supplier as Actor;
  for (const name of [
    'local_return_id',
    'partner_return_id',
    'supplier_return_id',
    'origin_id',
    'case_id',
    'preview_id',
    'local_proof_id',
  ])
    uuid(e[name]);
  assert.notEqual(e.local_return_id, e.partner_return_id);
  for (const side of ['buyer', 'supplier'] as const) {
    const actor = s[side] as Actor;
    assert.deepEqual({ tenant: actor.tenant, user: actor.user }, accepted[side]);
    for (const field of ['tenant', 'user', 'warehouse'] as const) uuid(actor[field]);
    assert(typeof actor.cookie === 'string' && actor.cookie.length > 0);
    const me = (await get(actor, '/auth/me')).user;
    assert.equal(me.id, actor.user);
    assert.equal(me.tenant_id, actor.tenant);
    assert.equal(me.role, 'admin');
  }
  const local = await get(buyer, '/returns/' + e.local_return_id);
  assertRma(local, e.local_return_id, 2500, s.customer_item, 1, true);
  const partner = await get(buyer, '/returns/' + e.partner_return_id);
  assertRma(partner, e.partner_return_id, 2500, s.customer_item, 0, false);
  assert.deepEqual(partner.partner_acceptance.case_ids, [e.case_id]);
  const wholesale = await get(supplier, '/returns/' + e.supplier_return_id);
  assertRma(wholesale, e.supplier_return_id, 700, null, 1, true);
  const overview = await get(buyer, '/orders/' + s.customer_order + '/returns');
  assert.equal(overview.meta.cursor, null);
  assert.equal(overview.case_count, 2);
  assert.deepEqual(
    overview.cases.map((r: Row) => r.id).sort(),
    [e.local_return_id, e.partner_return_id].sort(),
  );
  assert.equal(overview.refund_total, 5000);
  assert.equal(overview.settled_total, 0);
  const item = overview.items.find((r: Row) => r.id === s.customer_item);
  assert(item);
  assert.equal(item.quantity, 3);
  assert.equal(item.returned, 2);
  assert.equal(item.available, 1);
  const localContext = await get(buyer, prefix + '/returns/' + e.local_return_id + '/context');
  assert.equal(localContext.current_role, 'admin');
  assert.equal(localContext.read_only, false);
  assert.equal(localContext.context.fulfillment_origin, 'local');
  assert.equal(localContext.context.local_origin.id, e.origin_id);
  assert.deepEqual(localContext.context.local_origin.items, [
    { customer_item_id: s.customer_item, shipment_id: s.local_shipment, quantity: 1 },
  ]);
  assert.equal(localContext.context.can_select_local_origin, false);
  for (const [actor, rid, origin] of [
    [buyer, e.partner_return_id, 'partner'],
    [supplier, e.supplier_return_id, 'supplier'],
  ] as const) {
    const context = await get(actor, prefix + '/returns/' + rid + '/context');
    assert.equal(context.current_role, 'admin');
    assert.equal(context.read_only, false);
    assert.equal(context.context.fulfillment_origin, origin);
    assert.equal(context.context.local_origin, null);
    assert.equal(context.context.can_receive_locally, false);
    assert.equal(context.context.can_reconcile, false);
    const cases = await pages(
      actor,
      prefix + '/cases?return_id=' + rid + '&side=' + (origin === 'partner' ? 'buyer' : 'supplier'),
    );
    assert.deepEqual(
      cases.map((v) => v.id),
      [e.case_id],
    );
    const detail = await get(actor, prefix + '/cases/' + e.case_id);
    assert.equal(detail.case.state, 'received');
    assert.equal(detail.case.preview_id, e.preview_id);
    assert.equal(detail.case.wholesale_refund_minor, '700');
    assert(detail.case.received_at && detail.case.retail_reconciled_at);
    const rows = await pages(actor, prefix + '/cases/' + e.case_id + '/rows');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].customer_item_id, s.customer_item);
    assert.equal(rows[0].quantity, 1);
    assert.equal(rows[0].retail_refund_minor, '2500');
    assert.equal(rows[0].wholesale_refund_minor, '700');
    for (const key of [
      'customer_item_id',
      'dropship_order_id',
      'quantity',
      'retail_refund_minor',
      'wholesale_refund_minor',
    ])
      assert.deepEqual(rows[0][key], e.row[key]);
    const events = await pages(actor, prefix + '/cases/' + e.case_id + '/events');
    assert.deepEqual(events.map((v) => v.kind).sort(), ['receive', 'reconcile', 'submit']);
    assert.deepEqual(
      events.map((v) => v.id).sort(),
      e.actions
        .filter((v: Row) => v.kind !== 'settings')
        .map((v: Row) => v.id)
        .sort(),
    );
  }
  const preview = await get(buyer, prefix + '/previews/' + e.preview_id);
  assert.equal(preview.preview.can_submit, false);
  assert.deepEqual(preview.preview.executed_case_ids, [e.case_id]);
  for (const [actor, orderId, received, credit] of [
    [buyer, s.customer_order, 7500, 5000],
    [supplier, s.supplier_order, 1400, 700],
  ] as const) {
    const balance = (await get(actor, '/orders/' + orderId + '/payments')).balance;
    assert.equal(balance.received, received);
    assert.equal(balance.refunded, 0);
    assert.equal(balance.credit, credit);
    assert.equal(balance.amount_due, 0);
    assert.equal(balance.overpayment, credit);
  }
}

try {
  assert.equal(process.argv[2], 'verify');
  assert.equal(process.env.QA129_RESTART_VERIFIED, 'true');
  assert.equal(process.env.DYNA_WORKER_DISABLED, 'true');
  assert.notEqual(process.env.DYNA_TEST, 'true');
  const revision = process.env.QA_EXPECTED_REVISION ?? '';
  assert.match(revision, /^[a-f0-9]{7,40}$/);
  const db = new URL(process.env.DATABASE_URL ?? '');
  assert(['postgres:', 'postgresql:'].includes(db.protocol));
  assert(['localhost', '127.0.0.1', '[::1]'].includes(db.hostname));
  assert.equal(db.search, '');
  assert.equal(db.pathname, '/dynaminds');
  assert.equal(process.env.QA129_DATABASE_NAME, 'dynaminds');
  const config = await lstat(process.env.DYNA_LOCAL_CONFIG_PATH ?? '.local.json');
  assert(config.isFile() && !config.isSymbolicLink() && !(config.mode & 0o077));
  await absent(reportPath);
  const setupBytes = await privateFile(setupPath),
    checkpointBytes = await privateFile(checkpointPath);
  const setupReportBytes = await publicFile(setupReportPath),
    chromeReportBytes = await publicFile(chromeReportPath),
    processBytes = await publicFile(processReportPath);
  const s: Row = JSON.parse(setupBytes.toString('utf8')),
    accepted: Row = JSON.parse(checkpointBytes.toString('utf8'));
  const setupReport: Row = JSON.parse(setupReportBytes.toString('utf8')),
    chromeReport: Row = JSON.parse(chromeReportBytes.toString('utf8'));
  const processReport: Row = JSON.parse(processBytes.toString('utf8'));
  assert.equal(s.stage129, true);
  assert.equal(s.setup_complete, true);
  assert.equal(s.pending, null);
  assert.equal(accepted.stage, 129);
  assert.equal(accepted.chrome_verified, true);
  assert.equal(accepted.chrome_human_attested, true);
  for (const v of [s, accepted]) {
    assert.equal(v.runtime_revision, revision);
    assert.equal(v.schema_revision, schema);
  }
  assert.equal(accepted.setup.path, setupPath);
  assert.equal(accepted.setup.bytes, setupBytes.length);
  assert.equal(accepted.setup.sha256, bytesHash(setupBytes));
  assert.equal(accepted.setup.report_sha256, bytesHash(setupReportBytes));
  assert.equal(accepted.setup.checkpoint_sha256, hash(s.setup_checkpoint));
  assert.equal(setupReport.status, 'PASS');
  assert.equal(setupReport.revision, revision);
  assert.equal(setupReport.schema_revision, schema);
  assert.equal(setupReport.setup_checkpoint_sha256, hash(s.setup_checkpoint));
  assert.equal(chromeReport.status, 'PASS');
  assert.equal(chromeReport.revision, revision);
  assert.equal(chromeReport.schema_revision, schema);
  assert.equal(chromeReport.setup_file_sha256, bytesHash(setupBytes));
  assert.equal(chromeReport.checkpoint_sha256, hash(accepted.checkpoint));
  assert.deepEqual(chromeReport.setup, accepted.setup);
  assert.equal(chromeReport.human_chrome_attestation.confirmed, true);
  assert.equal(chromeReport.human_chrome_attestation.independently_inferred_from_sql, false);
  assert.deepEqual(chromeReport.own_tables, { buyer: 305, supplier: 305 });
  assert.equal(processReport.stage, 129);
  assert.equal(processReport.status, 'PASS');
  assert.equal(processReport.revision, revision);
  assert.equal(processReport.schema_revision, schema);
  for (const key of ['stopped_handle', 'live_handle'])
    assert(
      typeof processReport[key] === 'string' &&
        processReport[key].length > 0 &&
        processReport[key].length <= 128,
    );
  assert.notEqual(processReport.stopped_handle, processReport.live_handle);
  assert.equal(processReport.stop_exit_code, 0);
  assert.equal(processReport.listeners_absent, true);
  assert.equal(processReport.health_revision, revision);
  assert.equal(processReport.background_workers_enabled, false);
  step = 'health_after_root_attested_restart';
  await health(revision);
  pool = (await import('../server/db')).pool;
  step = 'full_snapshot_before_GET';
  assert.deepEqual(await snapshot(s, accepted, db), accepted.checkpoint);
  step = 'original_actor_readonly_evidence';
  await apiEvidence(s, accepted);
  await health(revision);
  step = 'full_snapshot_after_GET';
  assert.deepEqual(await snapshot(s, accepted, db), accepted.checkpoint);
  step = 'immutable_input_files';
  assert.deepEqual(await privateFile(setupPath), setupBytes);
  assert.deepEqual(await privateFile(checkpointPath), checkpointBytes);
  assert.deepEqual(await publicFile(setupReportPath), setupReportBytes);
  assert.deepEqual(await publicFile(chromeReportPath), chromeReportBytes);
  assert.deepEqual(await publicFile(processReportPath), processBytes);
  step = 'save_new_public_report';
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        stage: 129,
        phase: 'native_restart',
        status: 'PASS',
        revision,
        schema_revision: schema,
        own_tables: { buyer: 305, supplier: 305 },
        checkpoint_sha256: hash(accepted.checkpoint),
        accepted_checkpoint_file_sha256: bytesHash(checkpointBytes),
        setup_file_sha256: bytesHash(setupBytes),
        setup_report_sha256: bytesHash(setupReportBytes),
        chrome_report_sha256: bytesHash(chromeReportBytes),
        root_process_report_sha256: bytesHash(processBytes),
        root_process_report: processReportPath,
        root_shutdown_relaunch_attestation: {
          confirmed: true,
          independently_inferred_from_SQL_or_health: false,
          stopped_handle: processReport.stopped_handle,
          live_handle: processReport.live_handle,
        },
        full_business_exact_before_and_after_GET: true,
        original_setup_and_checkpoint_bytes_unchanged: true,
        sessions_excluded: true,
        background_workers_enabled: false,
        restart_verified: true,
        local_return_quantity: 1,
        partner_return_quantity: 1,
        supplier_restocked_quantity: 1,
        local_credit_minor: 2500,
        partner_retail_credit_minor: 2500,
        wholesale_credit_minor: 700,
        buyer_on_hand: 5,
        supplier_on_hand: 19,
        original_commercial_quantity: 3,
        cash_and_dispatch_exact: true,
        buyer_partner_physical_received: false,
        database_writes: false,
        private_checkpoint_rewritten: false,
        original_baseline_rebased: false,
        lost_ack_verified: false,
        restore_verified: false,
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
    'QA129 native restart PASS (two exact 305-table checkpoints; only GET/read-only SQL)\n',
  );
} catch (error) {
  const e = error as Error & { code?: string };
  const line = e.stack?.match(/b2b-return-local-origins-native-restart-proof\.ts:(\d+):\d+/)?.[1];
  const safe = {
    stage: 129,
    phase: 'native_restart',
    status: 'FAIL',
    step,
    code: typeof e.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(e.code) ? e.code : null,
    source_line: line ? Number(line) : null,
    database_writes: false,
    automatic_retry: false,
    private_checkpoint_rewritten: false,
    original_baseline_rebased: false,
    full_goal_complete: false,
  };
  await writeFile(reportPath, JSON.stringify(safe, null, 2) + '\n', { flag: 'wx' }).catch(() => {});
  process.stderr.write(JSON.stringify(safe) + '\n');
  process.exitCode = 1;
} finally {
  await pool?.end();
}
