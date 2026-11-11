/**
 * QA113 operator: setup → actual browser start0/scans on BOTH own cases → verify.
 * Optional post is a separate, explicitly authorized phase. Restart only reads.
 * This helper never attests UI automatically. One control picking scan is setup-only;
 * inventory counting always uses the actual manual scanner UI, never order scan.
 * Operator fixtures use genuine manual-delivery invitations and signup, not SQL role writes.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pool } from '../server/db';

type Json = Record<string, any>;
type Fingerprints = Record<string, { count: number; sha256: string }>;
const phase = process.argv[2],
  statePath = 'data/stocktake-scans-stage113.json';
const phases = [
  'setup',
  'verify',
  'verify-posted',
  'adopt-source',
  'adopt-recovery-schema',
  'post',
  'restart',
];
const runFile = promisify(execFile);
const physical = [
  'products',
  'product_sku_aliases',
  'product_logistics',
  'stock',
  'stock_locations',
  'stock_movements',
  'stock_location_movements',
  'wms_policies',
  'wms_lots',
  'wms_cost_layers',
  'wms_layer_positions',
  'wms_layer_movements',
  'wms_operations',
  'orders',
  'order_items',
  'order_pick_items',
  'reservations',
  'reservation_locations',
  'wms_reservation_layers',
  'wms_issue_fragments',
  'wms_return_fragments',
  'warehouse_documents',
  'warehouse_document_lines',
  'purchase_orders',
  'purchase_order_lines',
  'purchase_receipts',
  'purchase_receipt_lines',
  'return_cases',
  'shipments',
  'payment_entries',
  'order_events',
  'outbound_events',
  'outbound_deliveries',
  'email_messages',
  'sms_messages',
];
const proofTables = [
  ...physical,
  'stocktakes',
  'stocktake_lines',
  'stocktake_measurements',
  'wms_stocktakes',
  'wms_stocktake_lines',
  'wms_stocktake_scope_layers',
  'wms_stocktake_measurements',
  'wms_stocktake_measurement_layers',
  'wms_stocktake_reviews',
  'wms_stocktake_review_rows',
  'wms_stocktake_postings',
  'stocktake_scan_receipts',
  'audit_events',
];
const reservationTables = [
  'orders',
  'order_items',
  'order_pick_items',
  'reservations',
  'reservation_locations',
  'wms_reservation_layers',
  'order_events',
];
const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
let cookie = '';
const prefix = (c: Json) => (c.engine === 'wms' ? '/wms-lots/stocktakes' : '/stocktakes');
async function api(
  path: string,
  method = 'GET',
  body?: unknown,
  statuses = [200],
  noStore = false,
): Promise<Json> {
  const r = await fetch('http://127.0.0.1:4100/api' + path, {
    method,
    headers: { cookie, 'Content-Type': 'application/json' },
    ...(method === 'GET' || method === 'HEAD' ? {} : { body: JSON.stringify(body ?? {}) }),
    signal: AbortSignal.timeout(20000),
  });
  assert(statuses.includes(r.status), `${method} ${path}: HTTP ${r.status}`);
  if (noStore) assert.match(r.headers.get('cache-control') ?? '', /no-store/);
  const next = r.headers.get('set-cookie');
  if (next) cookie = next.split(';')[0];
  const text = await r.text();
  assert(Buffer.byteLength(text) <= 5242880, 'Bounded native API response required');
  return JSON.parse(text) as Json;
}
async function save(s: Json) {
  const st = await lstat(statePath);
  assert(
    st.isFile() && !st.isSymbolicLink() && (st.mode & 0o777) === 0o600,
    'Private state must remain a regular0600 file',
  );
  await writeFile(statePath, JSON.stringify(s, null, 2), { mode: 0o600 });
}
async function attempt(
  s: Json,
  label: string,
  path: string,
  body: unknown,
  statuses: number[],
  method = 'POST',
) {
  assert(
    !s.pending,
    'Uncertain previous outcome requires manual own readback; no automatic second attempt',
  );
  s.pending = { label, method, path, body, started_at: new Date().toISOString() };
  await save(s);
  const result = await api(path, method, body, statuses);
  s.pending = null;
  s.completed_steps ??= [];
  s.completed_steps.push({ label, at: new Date().toISOString() });
  await save(s);
  return result;
}
async function snapshot(c: Json, names: string[]): Promise<Fingerprints> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await db.query("SET LOCAL TIME ZONE 'UTC'");
    const out: Fingerprints = {};
    for (const name of names) {
      assert(/^[a-z][a-z0-9_]*$/.test(name));
      const rows = (
        await db.query(
          `SELECT to_jsonb(t) row FROM "${name}" t WHERE ${name === 'users' ? 'id=ANY($1::uuid[])' : name === 'tenants' ? 'id=$1' : 'tenant_id=$1'} ORDER BY 1`,
          [name === 'users' ? [c.user, c.operator.user] : c.tenant],
        )
      ).rows;
      out[name] = { count: rows.length, sha256: sha(rows) };
    }
    await db.query('COMMIT');
    return out;
  } finally {
    await db.query('ROLLBACK').catch(() => {});
    db.release();
  }
}
async function report(s: Json, status: string, extra: Json = {}) {
  const publicReport = {
    stage: 113,
    phase,
    status,
    revision: s.runtime_revision,
    schema: s.schema,
    cases: (s.cases ?? []).map((c: Json) => ({
      engine: c.engine,
      tenant: c.tenant,
      user: c.user,
      operator: c.operator?.user,
      warehouse: c.warehouse,
      product: c.product?.id,
      order: c.order?.id,
      stocktake: c.stocktake_id,
      line: c.line_id,
      counted: c.verified_count ?? null,
      scan_receipts: c.scan_count ?? null,
      checkpoint_sha256: c.own_snapshot ? sha(c.own_snapshot) : null,
    })),
    ui_verified: s.ui_verified === true,
    provider_verified: false,
    hardware_certified: false,
    goal_complete: false,
    ...extra,
  };
  await writeFile(
    `docs/stocktake-scans-native-${phase}-qa.json`,
    JSON.stringify(publicReport, null, 2) + '\n',
  );
  console.log({ phase, status, revision: s.runtime_revision, case_count: s.cases?.length ?? 0 });
}
async function own(c: Json, role: 'admin' | 'operator' = 'admin') {
  cookie = role === 'admin' ? c.cookie : c.operator.cookie;
  const me = (await api('/auth/me')).user;
  assert.equal(me.id, role === 'admin' ? c.user : c.operator.user);
  assert.equal(me.tenant_id, c.tenant);
  assert.equal(me.role, role);
  const identity = (
    await pool.query(
      `SELECT t.id FROM tenants t JOIN memberships m ON m.tenant_id=t.id JOIN users u ON u.id=m.user_id WHERE t.id=$1 AND u.id=$2 AND u.email=$3 AND t.name=$4 AND t.created_at>=$5::timestamptz`,
      [c.tenant, c.user, c.email, c.organization, c.created_at],
    )
  ).rows;
  assert.equal(identity.length, 1, 'Only a known newly created QA113 workspace may be used');
}
async function stock(c: Json) {
  const rows = (
    await pool.query(
      'SELECT on_hand,reserved,version FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3',
      [c.tenant, c.warehouse, c.product.id],
    )
  ).rows;
  assert.equal(rows.length, 1);
  return rows[0];
}
async function assertReservation(c: Json) {
  assert.equal((await stock(c)).reserved, 3);
  const [orders, picks, allocations, lots] = await Promise.all([
    pool.query('SELECT status FROM orders WHERE tenant_id=$1 AND id=$2', [c.tenant, c.order.id]),
    pool.query(
      'SELECT quantity,scanned FROM order_pick_items WHERE tenant_id=$1 AND order_id=$2 AND product_id=$3',
      [c.tenant, c.order.id, c.product.id],
    ),
    pool.query(
      'SELECT quantity,scanned,location FROM reservation_locations WHERE tenant_id=$1 AND order_id=$2 AND product_id=$3',
      [c.tenant, c.order.id, c.product.id],
    ),
    pool.query(
      'SELECT quantity,scanned,state,layer_id,location FROM wms_reservation_layers WHERE tenant_id=$1 AND order_id=$2 AND product_id=$3',
      [c.tenant, c.order.id, c.product.id],
    ),
  ]);
  assert.deepEqual(orders.rows, [{ status: 'picking' }]);
  assert.deepEqual(picks.rows, [{ quantity: 3, scanned: 1 }]);
  assert.deepEqual(allocations.rows, [{ quantity: 3, scanned: 1, location: c.location }]);
  if (c.engine === 'wms') {
    assert.equal(lots.rows.length, 1);
    assert.deepEqual(lots.rows[0], {
      quantity: 3,
      scanned: 1,
      state: 'active',
      layer_id: c.picking_layer_id,
      location: c.location,
    });
  } else assert.equal(lots.rows.length, 0);
}
async function setupReservation(s: Json, c: Json) {
  c.order = await attempt(
    s,
    'order-' + c.engine,
    '/orders',
    {
      customer_name: 'QA113 własna rezerwacja kontrolna',
      email: 'qa113-reservation@example.test',
      payment_mode: 'cod',
      warehouse_id: c.warehouse,
      items: [{ product_id: c.product.id, quantity: 3 }],
      note: 'QA113: nie wysyłać; jedna sztuka kompletacji przed ślepym spisem',
    },
    [201],
  );
  await save(s);
  await attempt(
    s,
    'picking-' + c.engine,
    '/orders/' + c.order.id + '/status',
    { status: 'picking' },
    [200],
    'PATCH',
  );
  if (c.engine === 'wms') {
    const layers = (
      await pool.query(
        'SELECT layer_id FROM wms_reservation_layers WHERE tenant_id=$1 AND order_id=$2 AND product_id=$3',
        [c.tenant, c.order.id, c.product.id],
      )
    ).rows;
    assert.equal(layers.length, 1);
    c.picking_layer_id = layers[0].layer_id;
  }
  await save(s);
  await attempt(
    s,
    'picking-scan-' + c.engine,
    '/orders/' + c.order.id + '/scan',
    {
      client_key: randomUUID(),
      code: c.ean,
      location: c.location,
      ...(c.picking_layer_id ? { layer_id: c.picking_layer_id } : {}),
    },
    [200],
  );
  assert.equal((await stock(c)).on_hand, 7);
  await assertReservation(c);
  c.reservation_before = await snapshot(c, reservationTables);
  await save(s);
}
async function scanHistory(c: Json) {
  const rows: Json[] = [];
  let cursor: string | null = null,
    total: number | null = null;
  do {
    const q = new URLSearchParams({ limit: '100', ...(cursor ? { cursor } : {}) });
    const page = await api(
      `${prefix(c)}/${c.stocktake_id}/scans?${q}`,
      'GET',
      undefined,
      [200],
      true,
    );
    assert(Array.isArray(page.data) && page.data.length <= 100);
    assert.equal(page.current_role, 'operator');
    assert.equal(typeof page.meta.total, 'number');
    if (total === null) total = page.meta.total;
    else assert.equal(page.meta.total, total);
    rows.push(...page.data);
    cursor = page.meta.cursor;
    assert(rows.length <= 100000, 'Receipt history bounded by actual quota');
  } while (cursor);
  assert.equal(rows.length, total);
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length);
  return rows;
}
async function inspect(c: Json, expectedCount: number, allowPosted = false) {
  await own(c, 'operator');
  await assertReservation(c);
  assert.deepEqual(
    await snapshot(c, reservationTables),
    c.reservation_before,
    'Original order, reservation and one picking scan must remain exact',
  );
  const meta = await api(
    `${prefix(c)}/${c.stocktake_id}/scan-metadata`,
    'GET',
    undefined,
    [200],
    true,
  );
  assert.equal(meta.available, true);
  assert.equal(meta.current_role, 'operator');
  assert.equal(meta.stocktake.blind, true);
  assert(
    allowPosted
      ? ['counting', 'posted'].includes(meta.stocktake.state)
      : meta.stocktake.state === 'counting',
  );
  const receipts = await scanHistory(c);
  assert(
    receipts.length >= expectedCount + 1,
    'A real start plus physical +1 receipts is required',
  );
  const chronological = receipts.sort((a, b) =>
    BigInt(a.after_line_version) < BigInt(b.after_line_version) ? -1 : 1,
  );
  const latest = chronological.at(-1)!;
  const generation = chronological.filter((r) => r.generation_id === latest.generation_id);
  assert.equal(generation.length, expectedCount + 1);
  assert.equal(generation[0].kind, 'start');
  assert.equal(generation[0].counted, 0);
  assert.equal(generation[0].increment, 0);
  assert.equal(generation[0].generation_id, generation[0].id);
  for (let i = 0; i < generation.length; i++) {
    const r = generation[i];
    assert.equal(r.engine, c.engine);
    assert.equal(r.stocktake_id, c.stocktake_id);
    assert.equal(r.line_id, c.line_id);
    assert.equal(r.product_id, c.product.id);
    assert.equal(r.location, c.location);
    assert.equal(r.counted, i);
    assert.equal(BigInt(r.after_line_version), BigInt(r.before_line_version) + 1n);
    if (i) {
      assert.equal(r.kind, 'increment');
      assert.equal(r.increment, 1);
      assert.equal(r.previous_count, i - 1);
      assert.equal(r.before_line_version, generation[i - 1].after_line_version);
    }
    assert(
      !('basis_hash' in r) && !('source_snapshot' in r) && !('request' in r),
      'Only public immutable receipts are allowed',
    );
    assert.deepEqual(
      (await api(`${prefix(c)}/${c.stocktake_id}/scans/${r.id}`, 'GET', undefined, [200], true))
        .scan,
      r,
    );
  }
  assert(
    generation.some((r) => r.kind === 'increment' && r.code === c.ean),
    'Leading-zero EAN must have been physically entered through the scanner UI',
  );
  const measured = (
    await pool.query(
      `SELECT l.id,l.counted,l.version FROM ${c.engine === 'wms' ? 'wms_stocktake_lines' : 'stocktake_lines'} l WHERE tenant_id=$1 AND stocktake_id=$2`,
      [c.tenant, c.stocktake_id],
    )
  ).rows;
  assert.equal(measured.length, 1);
  assert.equal(measured[0].id, c.line_id);
  assert.equal(measured[0].counted, expectedCount);
  assert.equal(measured[0].version, latest.after_line_version);
  const proofs = (
    await pool.query(
      'SELECT actor_id,request,result FROM stocktake_scan_receipts WHERE tenant_id=$1 AND engine=$2 AND stocktake_id=$3 ORDER BY after_line_version',
      [c.tenant, c.engine, c.stocktake_id],
    )
  ).rows;
  assert(
    proofs.every((r) => r.actor_id === c.operator.user),
    'Native scans must be genuine own operator actions',
  );
  assert.deepEqual(proofs.at(-1)!.result, latest);
  if (!allowPosted) {
    const q = new URLSearchParams({ code: c.ean, location: c.location });
    const candidates = await api(
      `${prefix(c)}/${c.stocktake_id}/scan-candidates?${q}`,
      'GET',
      undefined,
      [200],
      true,
    );
    assert.equal(candidates.meta.total, 1);
    assert.equal(candidates.meta.cursor, null);
    const line = candidates.data[0];
    assert.equal(line.line_id, c.line_id);
    assert.equal(line.counted, expectedCount);
    assert.equal(line.generation_id, latest.generation_id);
    assert.equal(line.can_continue, true);
    const allowed = new Set([
      'line_id',
      'product_id',
      'sku',
      'name',
      'current_sku',
      'current_ean',
      'location',
      'lot',
      'matched_by',
      'line_version',
      'counted',
      'needs_recount',
      'generation_id',
      'can_continue',
      'basis_token',
      'resolution_token',
      'expires_at',
    ]);
    assert(
      Object.keys(line).every((k) => allowed.has(k)),
      'Blind resolver must not disclose system quantities or private source',
    );
  }
  return { latest, request: proofs.at(-1)!.request, receipts: chronological };
}
async function checkpoint(s: Json) {
  const names = (
    await pool.query(
      `SELECT DISTINCT t.table_name FROM information_schema.tables t JOIN information_schema.columns col USING(table_schema,table_name) WHERE t.table_schema='public' AND t.table_type='BASE TABLE' AND col.column_name='tenant_id' UNION SELECT 'tenants' UNION SELECT 'users' ORDER BY 1`,
    )
  ).rows.map((r) => String(r.table_name));
  s.own_names = names;
  s.own_snapshot_timezone = 'UTC';
  for (const c of s.cases) c.own_snapshot = await snapshot(c, names);
  await save(s);
}
async function exactCheckpoint(s: Json) {
  assert(
    s.api_acceptance?.status === 'PASS' &&
      s.own_snapshot_timezone === 'UTC' &&
      Array.isArray(s.own_names) &&
      !s.pending,
  );
  for (const c of s.cases)
    assert.deepEqual(
      await snapshot(c, s.own_names),
      c.own_snapshot,
      'Complete accepted own checkpoint must remain exact; no drift normalization',
    );
}
async function typedPosted(c: Json) {
  await own(c);
  assert.equal((await stock(c)).on_hand, 7);
  await assertReservation(c);
  if (c.engine === 'wms') {
    const h = (await api(`${prefix(c)}/${c.stocktake_id}`)).stocktake;
    assert.equal(h.state, 'posted');
    const posting = (await api(`${prefix(c)}/${c.stocktake_id}/posting`)).posting;
    assert.equal(posting.id, h.posting_id);
    assert.equal(posting.review_id, h.latest_review_id);
    assert.equal(posting.changed, false);
    const joined = (
      await pool.query(
        `SELECT to_jsonb(h) h,to_jsonb(p) p,to_jsonb(r) r,to_jsonb(op) op
      FROM wms_stocktakes h JOIN wms_stocktake_postings p ON (p.tenant_id,p.stocktake_id,p.id)=(h.tenant_id,h.id,h.posting_id)
      JOIN wms_stocktake_reviews r ON (r.tenant_id,r.stocktake_id,r.id)=(h.tenant_id,h.id,p.review_id)
      JOIN wms_operations op ON (op.tenant_id,op.id,op.stocktake_id,op.stocktake_posting_id,op.stocktake_review_id)=(p.tenant_id,p.operation_id,h.id,p.id,r.id)
      WHERE h.tenant_id=$1 AND h.id=$2`,
        [c.tenant, c.stocktake_id],
      )
    ).rows;
    assert.equal(joined.length, 1, 'Posting must have genuine typed review and operation');
    const { h: raw, p, r, op } = joined[0];
    assert.equal(p.actor_id, c.user);
    assert.equal(r.actor_id, c.user);
    assert.equal(op.kind, 'stocktake_post');
    assert.equal(op.actor_id, c.user);
    assert.equal(op.id, posting.wms_operation_id);
    assert.equal(r.id, raw.last_review_id);
    assert.equal(BigInt(raw.version), BigInt(r.stocktake_version) + 1n);
    assert.equal(p.request.confirmed, true);
    assert.equal(p.request.scope_hash, r.scope_hash);
    assert.equal(p.request.version, r.stocktake_version.toString());
    assert.equal(p.request.review_id, r.id);
    assert.equal(p.request.client_key, p.client_key);
    assert.deepEqual(op.request, {
      stocktake_id: raw.id,
      posting_id: p.id,
      review_id: r.id,
      body: p.request,
    });
    assert.deepEqual(p.result.summary, r.summary);
    assert.equal(r.summary.total, 1);
    assert.equal(r.summary.changed, 0);
    assert.equal(p.result.changed, false);
    assert.equal(op.result.changed, 0);
    assert.equal(op.result.rows.length, 1);
    assert.equal(op.result.rows[0].line_id, c.line_id);
    assert.equal(op.result.rows[0].product_id, c.product.id);
    assert.equal(op.result.rows[0].location, c.location);
    assert.equal(op.result.rows[0].delta, 0);
    assert.deepEqual(op.result.rows[0].fragments, []);
    assert.equal(op.result.summary.known_delta_minor, '0');
    assert.equal(op.result.summary.unknown_delta_quantity, '0');
    const proof = (
      await pool.query(
        'SELECT "before","after",fragments FROM wms_stocktake_review_rows WHERE tenant_id=$1 AND review_id=$2 AND line_id=$3',
        [c.tenant, r.id, c.line_id],
      )
    ).rows;
    assert.equal(proof.length, 1);
    assert.equal(proof[0].before.quantity, 7);
    assert.equal(proof[0].after.quantity, 7);
    assert.deepEqual(proof[0].fragments, []);
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int n FROM wms_layer_movements WHERE tenant_id=$1 AND operation_id=$2',
          [c.tenant, op.id],
        )
      ).rows[0].n,
      0,
    );
    const v = (await api('/wms-lots/valuation')).valuation;
    assert.equal(v.quantity, '7');
    assert.equal(v.known_minor, '2219');
    assert.equal(v.unknown_quantity, '0');
    return { posting_id: p.id, review_id: r.id, operation_id: op.id };
  }
  const h = await api(`/stocktakes/${c.stocktake_id}`);
  assert.equal(h.state, 'posted');
  assert.equal(h.posted_by, c.user);
  assert.equal(h.lines.length, 1);
  assert.equal(h.lines[0].counted, 7);
  assert.equal(h.summary.delta, 0);
  return {};
}
async function postedCheckpointAllowed(s: Json, c: Json, current: Fingerprints) {
  const allowed = new Set([
    'sessions',
    'audit_events',
    ...(c.engine === 'wms'
      ? [
          'wms_stocktakes',
          'wms_stocktake_reviews',
          'wms_stocktake_review_rows',
          'wms_stocktake_postings',
          'wms_operations',
        ]
      : ['stocktakes']),
  ]);
  for (const name of s.own_names)
    if (!allowed.has(name))
      assert.deepEqual(
        current[name],
        c.own_snapshot[name],
        'Manual NOP post may only change its own approval evidence',
      );
  // New own browser logins are explicit additions, never deletion/rewrite of an accepted session.
  const db = await pool.connect();
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await db.query("SET LOCAL TIME ZONE 'UTC'");
    const rows = (
      await db.query(
        'SELECT to_jsonb(t) row FROM sessions t WHERE tenant_id=$1 AND created_at<=$2::timestamptz ORDER BY 1',
        [c.tenant, s.api_acceptance.at],
      )
    ).rows;
    assert.deepEqual({ count: rows.length, sha256: sha(rows) }, c.own_snapshot.sessions);
    const append = [
      'audit_events',
      ...(c.engine === 'wms'
        ? ['wms_operations', 'wms_stocktake_reviews', 'wms_stocktake_postings']
        : []),
    ];
    for (const table of append) {
      const old = (
        await db.query(
          `SELECT to_jsonb(t) row FROM "${table}" t WHERE tenant_id=$1 AND created_at<=$2::timestamptz ORDER BY 1`,
          [c.tenant, s.api_acceptance.at],
        )
      ).rows;
      assert.deepEqual(
        { count: old.length, sha256: sha(old) },
        c.own_snapshot[table],
        'Manual review/post must preserve all earlier evidence',
      );
      assert.equal(current[table].count, old.length + (table === 'audit_events' ? 2 : 1));
    }
    const actions = (
      await db.query(
        'SELECT user_id,entity_id,action FROM audit_events WHERE tenant_id=$1 AND created_at>$2::timestamptz ORDER BY action',
        [c.tenant, s.api_acceptance.at],
      )
    ).rows;
    assert.deepEqual(
      actions,
      ['post', 'review'].map((kind) => ({
        user_id: c.user,
        entity_id: c.stocktake_id,
        action: (c.engine === 'wms' ? 'wms.stocktake.' : 'stocktake.') + kind,
      })),
    );
    if (c.engine === 'wms') {
      const old = (
        await db.query(
          `SELECT to_jsonb(t) row FROM wms_stocktake_review_rows t JOIN wms_stocktake_reviews r ON (r.tenant_id,r.id)=(t.tenant_id,t.review_id) WHERE t.tenant_id=$1 AND r.created_at<=$2::timestamptz ORDER BY 1`,
          [c.tenant, s.api_acceptance.at],
        )
      ).rows;
      assert.deepEqual(
        { count: old.length, sha256: sha(old) },
        c.own_snapshot.wms_stocktake_review_rows,
      );
      assert.equal(current.wms_stocktake_review_rows.count, old.length + 1);
    }
    await db.query('COMMIT');
  } finally {
    await db.query('ROLLBACK').catch(() => {});
    db.release();
  }
  const extra = (
    await pool.query(
      'SELECT user_id FROM sessions WHERE tenant_id=$1 AND created_at>$2::timestamptz',
      [c.tenant, s.api_acceptance.at],
    )
  ).rows;
  assert(extra.every((r) => r.user_id === c.user || r.user_id === c.operator.user));
  return extra.length;
}
async function setupCase(s: Json, engine: 'wms' | 'quantity') {
  const c: Json = {
    engine,
    created_at: new Date().toISOString(),
    organization: `QA113 — własny odbiór skanów ${engine}`,
    email: `qa-scan113-${engine}-${randomUUID()}@demo.local`,
    password: 'DynaScan113!-' + randomUUID(),
    location: 'SCAN-113-A',
    ean: '001130000007',
    operator: {
      email: `qa-scan113-op-${engine}-${randomUUID()}@demo.local`,
      password: 'DynaScan113Operator!-' + randomUUID(),
    },
  };
  s.cases.push(c);
  await save(s);
  cookie = '';
  const signup = await attempt(
    s,
    'signup-' + engine,
    '/auth/signup',
    {
      email: c.email,
      password: c.password,
      name: 'QA113 administrator skanów',
      organization: { name: c.organization },
    },
    [201],
  );
  c.tenant = signup.user.tenant_id;
  c.user = signup.user.id;
  c.cookie = cookie;
  assert.equal(signup.user.role, 'admin');
  await save(s);
  await api('/workspaces/plan', 'PATCH', { plan: 'business' });
  const wh = await api('/warehouses');
  assert(wh.data.length >= 1);
  c.warehouse = wh.data[0].id;
  await save(s);
  c.product = await attempt(
    s,
    'product-' + engine,
    '/products',
    {
      name: 'QA113 fizyczny produkt EAN',
      sku: 'QA113-SCAN-A',
      ean: c.ean,
      price: 1500,
      warehouse_id: c.warehouse,
      quantity: 7,
      location: c.location,
    },
    [201],
  );
  await save(s);
  assert.equal(c.product.sku, 'QA113-SCAN-A');
  assert.equal(c.product.ean, c.ean);
  const before = await stock(c);
  assert.equal(before.on_hand, 7);
  assert.equal(before.reserved, 0);
  if (engine === 'wms') {
    const b = {
      client_key: randomUUID(),
      policy_version: '0',
      currency: 'PLN',
      note: 'QA113 rzeczywisty lokalny BO koszt317',
      lines: [
        {
          product_id: c.product.id,
          warehouse_id: c.warehouse,
          location: c.location,
          quantity: 7,
          stock_version: String(before.version),
          lot_code: 'QA113-LOT-A',
          unit_cost_minor: '317',
        },
      ],
    };
    const opening = (await attempt(s, 'opening-preview', '/wms-lots/opening-previews', b, [201]))
      .preview;
    assert.equal(opening.ready, true);
    c.opening_id = opening.id;
    await save(s);
    const activated = await attempt(
      s,
      'opening-activate',
      `/wms-lots/opening-previews/${opening.id}/activate`,
      {
        client_key: randomUUID(),
        scope_hash: opening.scope_hash,
        confirmed: true,
        ack_unknown_costs: false,
      },
      [201],
    );
    assert(activated.operation);
    c.opening_operation_id = activated.operation.id;
    await save(s);
    const v = (await api('/wms-lots/valuation')).valuation;
    assert.equal(v.known_minor, '2219');
    assert.equal(v.unknown_quantity, '0');
    await setupReservation(s, c);
    c.stocktake_id = (
      await attempt(
        s,
        'stocktake-wms',
        '/wms-lots/stocktakes',
        {
          client_key: randomUUID(),
          warehouse_id: c.warehouse,
          name: 'QA113 ślepy spis EAN operatora WMS',
          policy_version: '1',
          blind: true,
        },
        [201],
      )
    ).stocktake.id;
  } else {
    assert.equal((await api('/wms-lots')).policy.enabled, false);
    await setupReservation(s, c);
    c.stocktake_id = (
      await attempt(
        s,
        'stocktake-quantity',
        '/stocktakes',
        {
          client_key: randomUUID(),
          warehouse_id: c.warehouse,
          name: 'QA113 ślepy spis EAN operatora OFF',
          blind: true,
          location_prefix: c.location,
        },
        [200],
      )
    ).id;
  }
  await save(s);
  const invitation = await attempt(
    s,
    'operator-invitation-' + engine,
    '/workspaces/invitations',
    { email: c.operator.email, role: 'operator' },
    [201],
  );
  assert.equal(invitation.delivery, 'manual');
  c.invitation_id = invitation.id;
  await save(s);
  cookie = '';
  const op = await attempt(
    s,
    'operator-signup-' + engine,
    '/auth/signup',
    {
      email: c.operator.email,
      password: c.operator.password,
      name: 'QA113 operator ślepego skanowania',
      invitation_token: invitation.token,
    },
    [201],
  );
  assert.equal(op.user.tenant_id, c.tenant);
  assert.equal(op.user.role, 'operator');
  c.operator.user = op.user.id;
  c.operator.cookie = cookie;
  assert.notEqual(c.operator.user, c.user);
  await save(s);
  await own(c, 'operator');
  const meta = await api(
    `${prefix(c)}/${c.stocktake_id}/scan-metadata`,
    'GET',
    undefined,
    [200],
    true,
  );
  assert.equal(meta.can_scan, true);
  assert.equal(meta.current_role, 'operator');
  const q = new URLSearchParams({ code: c.ean, location: c.location });
  const candidate = await api(
    `${prefix(c)}/${c.stocktake_id}/scan-candidates?${q}`,
    'GET',
    undefined,
    [200],
    true,
  );
  assert.equal(candidate.meta.total, 1);
  assert.equal(candidate.meta.cursor, null);
  assert.equal(candidate.data[0].counted, null);
  assert.equal(candidate.data[0].generation_id, null);
  assert.equal(candidate.data[0].can_continue, false);
  c.line_id = candidate.data[0].line_id;
  c.physical_before = await snapshot(c, physical);
  c.ready = true;
  await save(s);
}
try {
  assert(
    phases.includes(phase),
    'Use setup, verify, verify-posted, adopt-source, adopt-recovery-schema, optional post, or restart',
  );
  if (phase !== 'setup') {
    const st = await lstat(statePath);
    assert(st.isFile() && !st.isSymbolicLink() && (st.mode & 0o777) === 0o600);
  }
  const s: Json =
    phase === 'setup'
      ? {
          stage: 113,
          created_at: new Date().toISOString(),
          cases: [],
          ui_verified: false,
          restart_verified: false,
        }
      : JSON.parse(await readFile(statePath, 'utf8'));
  if (phase !== 'setup') {
    assert.equal(s.stage, 113);
  }
  const expected = process.env.QA_EXPECTED_REVISION ?? s.runtime_revision;
  assert(
    typeof expected === 'string' && /^[a-f0-9]{7,40}$/.test(expected),
    'Explicit verified runtime revision required',
  );
  const health = await api('/health');
  assert.equal(health.revision, expected);
  if (phase === 'setup')
    assert(
      ['094_wms_stocktake_scans', '095_stocktake_scan_recovery'].includes(health.schema_revision),
      'Only verified094/095 schemas supported',
    );
  else if (phase === 'adopt-recovery-schema')
    assert.equal(health.schema_revision, '095_stocktake_scan_recovery');
  else assert.equal(health.schema_revision, s.schema);
  assert.equal(health.restore_preview, false);
  assert.equal(health.stocktake_scans_available, true);
  if (phase !== 'setup' && phase !== 'adopt-source' && phase !== 'adopt-recovery-schema')
    assert.equal(s.runtime_revision, expected, 'Do not silently change accepted source');
  if (phase === 'setup') {
    s.runtime_revision = expected;
    s.original_runtime_revision = expected;
    s.schema = health.schema_revision;
    s.setup_started = true;
    await writeFile(statePath, JSON.stringify(s, null, 2), { flag: 'wx', mode: 0o600 });
    await setupCase(s, 'wms');
    await setupCase(s, 'quantity');
    s.setup_complete = true;
    await save(s);
    await report(s, 'SETUP_READY_UI_PENDING', {
      manual_next:
        'Use the private operator account for each workspace. Select bin and leading-zero EAN, explicitly start from0, enter7 physical stocktake scans. Setup already created the separate control order and one official picking scan; no inventory scan is performed automatically.',
      physical_quantity_each: 7,
      reserved_quantity_each: 3,
      picking_scanned_each: 1,
      wms_known_minor: '2219',
      ui_verified: false,
    });
  } else if (phase === 'adopt-recovery-schema') {
    const previous = process.env.QA_PREVIOUS_REVISION;
    assert.equal(
      previous,
      s.runtime_revision,
      'Explicit095 prior runtime must match stored source',
    );
    assert(
      previous?.startsWith('a4556b4'),
      'Only the accepted a4556b4 frontend source may transition through this095 fix',
    );
    assert.equal(s.schema, '094_wms_stocktake_scans');
    assert.equal(expected, process.env.QA_EXPECTED_REVISION);
    assert.notEqual(expected, previous);
    assert(
      s.manual_post_verified && s.post_complete && s.cases.every((c: Json) => c.posted),
      'Actual manual post readback must precede095 source adoption',
    );
    await exactCheckpoint(s);
    const [head, oldResolved, newResolved] = await Promise.all([
      runFile('git', ['rev-parse', 'HEAD']),
      runFile('git', ['rev-parse', `${previous}^{commit}`]),
      runFile('git', ['rev-parse', `${expected}^{commit}`]),
    ]);
    const oldRevision = oldResolved.stdout.trim(),
      newRevision = newResolved.stdout.trim();
    assert.equal(head.stdout.trim(), newRevision, '095 runtime must match current HEAD');
    const paths = (await runFile('git', ['diff', '--name-only', oldRevision, newRevision])).stdout
      .trim()
      .split('\n')
      .filter(Boolean);
    const allowed = new Set([
      'server/095_stocktake_scan_recovery.sql',
      'server/db.ts',
      'tests/stocktake-scans-recovery.test.ts',
      'scripts/test.ts',
    ]);
    assert(
      paths.length > 0 && paths.every((path) => allowed.has(path)),
      'Only the exact095 SQL/registry/regression files are allowed',
    );
    assert(
      paths.includes('server/095_stocktake_scan_recovery.sql') && paths.includes('server/db.ts'),
    );
    const migrationPath = 'server/095_stocktake_scan_recovery.sql';
    const liveSql = await readFile(migrationPath);
    const committed = await runFile('git', ['show', `${newRevision}:${migrationPath}`]);
    const migrationSha = createHash('sha256').update(liveSql).digest('hex');
    assert.equal(
      migrationSha,
      createHash('sha256').update(committed.stdout, 'utf8').digest('hex'),
      'Actual working095 SQL must exactly match committed bytes',
    );
    for (const c of s.cases) {
      await typedPosted(c);
      const readback = await inspect(c, 7, true);
      assert.equal(readback.receipts.length, 8);
      assert.deepEqual(readback.latest, c.last_scan);
    }
    await exactCheckpoint(s);
    s.original_runtime_revision ??= previous;
    s.original_schema ??= s.schema;
    s.source_transition_history ??= [];
    s.source_transition_history.push({
      kind: 'recovery-schema',
      previous_revision: previous,
      revision: expected,
      previous_commit: oldRevision,
      commit: newRevision,
      previous_schema: s.schema,
      schema: health.schema_revision,
      paths,
      actual_migration_sha256: migrationSha,
      at: new Date().toISOString(),
      checkpoint_sha256: sha(s.cases.map((c: Json) => c.own_snapshot)),
    });
    s.runtime_revision = expected;
    s.schema = health.schema_revision;
    s.restart_verified = false;
    await save(s);
    await report(s, 'RECOVERY_SCHEMA_ADOPTED_DATA_EXACT', {
      previous_revision: previous,
      previous_schema: s.original_schema,
      original_runtime_revision: s.original_runtime_revision,
      actual_migration_sha256: migrationSha,
      checkpoint_rebased: false,
    });
  } else if (phase === 'adopt-source') {
    const previous = process.env.QA_PREVIOUS_REVISION;
    assert.equal(
      previous,
      s.runtime_revision,
      'Explicit prior source must match accepted metadata',
    );
    assert.equal(expected, process.env.QA_EXPECTED_REVISION, 'Explicit new runtime required');
    assert.notEqual(expected, previous);
    await exactCheckpoint(s);
    const [head, oldResolved, newResolved] = await Promise.all([
      runFile('git', ['rev-parse', 'HEAD']),
      runFile('git', ['rev-parse', `${previous}^{commit}`]),
      runFile('git', ['rev-parse', `${expected}^{commit}`]),
    ]);
    const oldRevision = oldResolved.stdout.trim(),
      newRevision = newResolved.stdout.trim();
    assert.equal(head.stdout.trim(), newRevision, 'Running new revision must be current HEAD');
    const server = await runFile('git', [
      'diff',
      '--name-only',
      oldRevision,
      newRevision,
      '--',
      'server',
    ]);
    assert.equal(server.stdout.trim(), '', 'No server changes allowed in source adoption');
    const changed = (await runFile('git', ['diff', '--name-only', oldRevision, newRevision])).stdout
      .trim()
      .split('\n')
      .filter(Boolean);
    assert(
      changed.length > 0 && changed.every((path) => path.startsWith('web/')),
      'Source transition must contain only frontend files',
    );
    for (const c of s.cases) await inspect(c, c.verified_count, Boolean(c.posted));
    await exactCheckpoint(s);
    s.original_runtime_revision ??= previous;
    s.source_transition_history ??= [];
    s.source_transition_history.push({
      previous_revision: previous,
      revision: expected,
      previous_commit: oldRevision,
      commit: newRevision,
      paths: changed,
      at: new Date().toISOString(),
      checkpoint_sha256: sha(s.cases.map((c: Json) => c.own_snapshot)),
    });
    s.runtime_revision = expected;
    s.restart_verified = false;
    await save(s);
    await report(s, 'FRONTEND_SOURCE_ADOPTED_DATA_EXACT', {
      original_runtime_revision: s.original_runtime_revision,
      previous_revision: previous,
      checkpoint_rebased: false,
    });
  } else if (phase === 'verify-posted') {
    assert(
      s.api_acceptance?.status === 'PASS' &&
        s.own_snapshot_timezone === 'UTC' &&
        Array.isArray(s.own_names) &&
        !s.pending &&
        !s.post_complete,
      'Accepted scans and a new manual post readback required',
    );
    let total = 0;
    for (const c of s.cases) {
      assert.equal(c.verified_count, 7);
      const before = await snapshot(c, s.own_names);
      const additionalSessions = await postedCheckpointAllowed(s, c, before);
      const posted = await typedPosted(c);
      const readback = await inspect(c, 7, true);
      assert.equal(readback.receipts.length, 8);
      assert.deepEqual(readback.latest, c.last_scan);
      const retry = await api(
        `${prefix(c)}/${c.stocktake_id}/scans`,
        'POST',
        c.replay_request,
        [200],
        true,
      );
      assert.equal(retry.reused, true);
      assert.equal(retry.current_line, null);
      assert.deepEqual(retry.scan, c.last_scan);
      assert.deepEqual(
        await snapshot(c, s.own_names),
        before,
        'Readback and old canonical receipt retry must have zero new effects',
      );
      c.pre_manual_post_snapshot = c.own_snapshot;
      c.manual_post_proof = {
        ...posted,
        additional_own_sessions: additionalSessions,
        at: new Date().toISOString(),
      };
      c.posted = true;
      total += readback.receipts.length;
    }
    assert.equal(total, 16);
    s.post_complete = true;
    s.manual_post_verified = true;
    s.restart_verified = false;
    await checkpoint(s);
    await report(s, 'MANUAL_POST_READBACK_PASS', {
      immutable_scan_receipts: total,
      physical_quantity_each: 7,
      reserved_quantity_each: 3,
      picking_scanned_each: 1,
      wms_known_minor: '2219',
      automated_post: false,
      ui_attestation:
        'Independent root browser evidence required; this helper only reads its result',
    });
  } else if (phase === 'verify') {
    assert(s.setup_complete && !s.pending, 'Only complete own setup may be verified');
    const expectedCount = Number(process.env.QA_EXPECTED_SCAN_COUNT ?? '7');
    assert(
      Number.isInteger(expectedCount) && expectedCount >= 2 && expectedCount <= 1000000,
      'Expected count must be explicitly meaningful and bounded',
    );
    for (const c of s.cases) {
      const view = await inspect(c, expectedCount);
      assert.deepEqual(
        await snapshot(c, physical),
        c.physical_before,
        'Physical/OMS state must remain exact after scans',
      );
      const before = await snapshot(c, proofTables);
      const replay = await api(
        `${prefix(c)}/${c.stocktake_id}/scans`,
        'POST',
        view.request,
        [200],
        true,
      );
      assert.equal(replay.reused, true);
      assert.deepEqual(replay.scan, view.latest);
      assert.equal(replay.current_line, null);
      assert.deepEqual(
        await snapshot(c, proofTables),
        before,
        'Canonical retry must not append a count/audit or change physical state',
      );
      c.verified_count = expectedCount;
      c.scan_count = view.receipts.length;
      c.replay_request = view.request;
      c.last_scan = view.latest;
      c.verified = true;
    }
    s.api_acceptance = {
      status: 'PASS',
      at: new Date().toISOString(),
      canonical_replay: true,
      physical_unchanged: true,
      blind_api_verified: true,
    };
    s.restart_verified = false;
    await checkpoint(s);
    await report(s, 'NATIVE_READBACK_AND_REPLAY_PASS', {
      ui_attestation:
        'PENDING; this phase does not automatically attest browser or hardware interaction',
      physical_quantity_each: 7,
      reserved_quantity_each: 3,
      picking_scanned_each: 1,
    });
  } else if (phase === 'post') {
    assert(
      process.env.QA_ALLOW_STOCKTAKE_POST === 'true',
      'Separate explicit own post authorization required',
    );
    assert(
      s.api_acceptance?.status === 'PASS' && !s.post_started && !s.pending,
      'Already started posting requires manual readback, not automatic restart',
    );
    s.post_started = true;
    await save(s);
    for (const c of s.cases) {
      await own(c);
      const n = c.verified_count;
      assert(Number.isInteger(n));
      if (c.engine === 'wms') {
        const h = (await api(`${prefix(c)}/${c.stocktake_id}`)).stocktake;
        assert.equal(h.state, 'counting');
        const review = (
          await attempt(
            s,
            'review-wms',
            `${prefix(c)}/${c.stocktake_id}/reviews`,
            {
              client_key: randomUUID(),
              version: h.version,
              note: 'QA113 jawny review po rzeczywistym skanowaniu',
              surplus:
                n > 7 ? [{ line_id: c.line_id, unit_cost_minor: '317', currency: 'PLN' }] : [],
            },
            [201],
          )
        ).review;
        const body = {
          client_key: randomUUID(),
          version: review.stocktake_version,
          review_id: review.id,
          scope_hash: review.scope_hash,
          confirmed: true,
        };
        const posted = await attempt(
          s,
          'post-wms',
          `${prefix(c)}/${c.stocktake_id}/post`,
          body,
          [201],
        );
        assert.equal(posted.posting.state, 'posted');
        const before = await snapshot(c, proofTables);
        assert.equal((await api(`${prefix(c)}/${c.stocktake_id}/post`, 'POST', body)).reused, true);
        assert.deepEqual(await snapshot(c, proofTables), before);
        const valuation = (await api('/wms-lots/valuation')).valuation;
        assert.equal(valuation.known_minor, (BigInt(n) * 317n).toString());
        assert.equal(valuation.unknown_quantity, '0');
        c.posting_id = posted.posting.id;
      } else {
        let h = await api(`/stocktakes/${c.stocktake_id}`);
        assert.equal(h.state, 'counting');
        h = await attempt(
          s,
          'review-quantity',
          `/stocktakes/${c.stocktake_id}/review`,
          { version: h.version },
          [200],
        );
        const body = { version: h.version, confirmed: true };
        const result = await attempt(
          s,
          'post-quantity',
          `/stocktakes/${c.stocktake_id}/post`,
          body,
          [200],
        );
        assert.equal(result.state, 'posted');
        const before = await snapshot(c, proofTables);
        assert.equal(
          (await api(`/stocktakes/${c.stocktake_id}/post`, 'POST', body)).state,
          'posted',
        );
        assert.deepEqual(await snapshot(c, proofTables), before);
      }
      assert.equal((await stock(c)).on_hand, n);
      await assertReservation(c);
      assert.deepEqual(
        await snapshot(c, reservationTables),
        c.reservation_before,
        'Posting keeps the original reservation and picking scan exact',
      );
      c.posted = true;
      await own(c, 'operator');
      const before = await snapshot(c, proofTables);
      assert.deepEqual(
        (await api(`${prefix(c)}/${c.stocktake_id}/scans`, 'POST', c.replay_request, [200], true))
          .scan,
        c.last_scan,
      );
      assert.deepEqual(
        await snapshot(c, proofTables),
        before,
        'Old exact scan survives posting without reactivating its counter',
      );
    }
    s.post_complete = true;
    s.restart_verified = false;
    await checkpoint(s);
    await report(s, 'SEPARATE_POST_PASS', {
      ui_attestation: 'Still requires independent root browser evidence',
    });
  } else {
    assert(
      s.api_acceptance?.status === 'PASS' &&
        s.own_snapshot_timezone === 'UTC' &&
        Array.isArray(s.own_names) &&
        !s.pending,
      'Accepted complete checkpoint required',
    );
    for (const c of s.cases) {
      assert.deepEqual(
        await snapshot(c, s.own_names),
        c.own_snapshot,
        'Every accepted own table must match before any post-restart readback',
      );
      await inspect(c, c.verified_count, Boolean(c.posted));
      assert.equal((await stock(c)).on_hand, c.posted ? c.verified_count : 7);
      await assertReservation(c);
      assert.deepEqual(
        await snapshot(c, s.own_names),
        c.own_snapshot,
        'Readback must preserve the complete own checkpoint',
      );
    }
    s.restart_verified = true;
    s.restart_revision = health.revision;
    await save(s);
    await report(s, 'RESTART_PASS', {
      own_checkpoint_tables: s.own_names.length,
      exact_readback: true,
    });
  }
} catch (error) {
  // Print no server body, password, cookie, invitation or HMAC, including on failed setup.
  const safePhase = phases.includes(phase) ? phase : 'unknown';
  await writeFile(
    `docs/stocktake-scans-native-${safePhase}-qa.json`,
    JSON.stringify(
      {
        stage: 113,
        phase: safePhase,
        status: 'INCOMPLETE',
        message:
          'Native helper failed; inspect the exact phase and own pending request privately. Do not repeat partial setup/post automatically.',
        provider_verified: false,
        ui_verified: false,
        goal_complete: false,
      },
      null,
      2,
    ) + '\n',
  ).catch(() => {});
  console.error({
    phase: safePhase,
    status: 'INCOMPLETE',
    error_type: error instanceof Error ? error.name : 'Error',
  });
  process.exitCode = 1;
} finally {
  await pool.end();
}
