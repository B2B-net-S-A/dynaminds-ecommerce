/**
 * Root-only QA113 ACK drill: setup → real Chrome start0 / dropped increment ACK /
 * explicit same-body retry → verify. No automatic stocktake scans or posting.
 * Uses two NEW workspaces and an independent0600 state; never reads/writes the
 * accepted stocktake-scans-stage113.json. Setup failure requires manual readback.
 * QA_EXPECTED_REVISION defaults to01179f4; QA_ACK_UI_VERIFIED=true is required
 * by verify and represents independent root attestation, not helper observation.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';

type Json = Record<string, any>;
type Fingerprints = Record<string, { count: number; sha256: string }>;
const phase = process.argv[2];
const statePath = 'data/stocktake-scans-ack-stage113.json';
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
const prefix = (c: Json) => (c.engine === 'wms' ? '/wms-lots/stocktakes' : '/stocktakes');
let cookie = '';

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
    ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
    signal: AbortSignal.timeout(20000),
  });
  assert(statuses.includes(r.status), `${method} ${path}: HTTP ${r.status}`);
  if (noStore) assert.match(r.headers.get('cache-control') ?? '', /no-store/);
  const next = r.headers.get('set-cookie');
  if (next) cookie = next.split(';')[0];
  const text = await r.text();
  assert(Buffer.byteLength(text) <= 5242880, 'Bounded API response required');
  return JSON.parse(text) as Json;
}
async function save(s: Json) {
  const st = await lstat(statePath);
  assert(st.isFile() && !st.isSymbolicLink() && (st.mode & 0o777) === 0o600);
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
  assert(!s.pending, 'Uncertain setup requires manual own readback, never automatic resubmission');
  s.pending = { label, path, method, body, started_at: new Date().toISOString() };
  await save(s);
  const result = await api(path, method, body, statuses);
  // Store even credential-bearing invitation responses privately before clearing
  // the pending gate; no response or request is printed in public reports.
  s.last_completed = { label, result, cookie, at: new Date().toISOString() };
  s.pending = null;
  await save(s);
  return result;
}
async function own(c: Json, role: 'admin' | 'operator') {
  cookie = role === 'admin' ? c.cookie : c.operator.cookie;
  const me = (await api('/auth/me')).user;
  assert.equal(me.id, role === 'admin' ? c.user : c.operator.user);
  assert.equal(me.tenant_id, c.tenant);
  assert.equal(me.role, role);
  const identity = await pool.query(
    'SELECT t.id FROM tenants t JOIN memberships m ON m.tenant_id=t.id JOIN users u ON u.id=m.user_id WHERE t.id=$1 AND u.id=$2 AND u.email=$3 AND t.name=$4 AND t.created_at>=$5::timestamptz',
    [c.tenant, c.user, c.email, c.organization, c.created_at],
  );
  assert.equal(identity.rows.length, 1, 'Only the newly created ACK workspace is eligible');
}
async function snapshot(c: Json, names: string[]): Promise<Fingerprints> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await db.query("SET LOCAL TIME ZONE 'UTC'");
    const out: Fingerprints = {};
    for (const name of names) {
      assert(/^[a-z][a-z0-9_]*$/.test(name));
      const selector =
        name === 'users' ? 'id=ANY($1::uuid[])' : name === 'tenants' ? 'id=$1' : 'tenant_id=$1';
      const rows = (
        await db.query(`SELECT to_jsonb(t) row FROM "${name}" t WHERE ${selector} ORDER BY 1`, [
          name === 'users' ? [c.user, c.operator.user] : c.tenant,
        ])
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
async function stock(c: Json): Promise<Json> {
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
  assert.equal((await stock(c)).on_hand, 7);
  assert.equal((await stock(c)).reserved, 3);
  const order = (
    await pool.query('SELECT status FROM orders WHERE tenant_id=$1 AND id=$2', [
      c.tenant,
      c.order.id,
    ])
  ).rows;
  const pick = (
    await pool.query(
      'SELECT quantity,scanned FROM order_pick_items WHERE tenant_id=$1 AND order_id=$2 AND product_id=$3',
      [c.tenant, c.order.id, c.product.id],
    )
  ).rows;
  const bins = (
    await pool.query(
      'SELECT quantity,scanned,location FROM reservation_locations WHERE tenant_id=$1 AND order_id=$2 AND product_id=$3',
      [c.tenant, c.order.id, c.product.id],
    )
  ).rows;
  const lots = (
    await pool.query(
      'SELECT layer_id,quantity,scanned,state,location FROM wms_reservation_layers WHERE tenant_id=$1 AND order_id=$2 AND product_id=$3',
      [c.tenant, c.order.id, c.product.id],
    )
  ).rows;
  assert.deepEqual(order, [{ status: 'picking' }]);
  assert.deepEqual(pick, [{ quantity: 3, scanned: 1 }]);
  assert.deepEqual(bins, [{ quantity: 3, scanned: 1, location: c.location }]);
  assert.deepEqual(
    lots,
    c.engine === 'wms'
      ? [
          {
            layer_id: c.picking_layer_id,
            quantity: 3,
            scanned: 1,
            state: 'active',
            location: c.location,
          },
        ]
      : [],
  );
}
async function setupCase(s: Json, engine: 'wms' | 'quantity') {
  const c: Json = {
    engine,
    created_at: new Date().toISOString(),
    organization: `QA113 ACK — ${engine} — ${randomUUID()}`,
    email: `qa-ack113-${engine}-${randomUUID()}@demo.local`,
    password: 'DynaACK113!-' + randomUUID(),
    location: 'SCAN-113-ACK-A',
    ean: '001130000007',
    operator: {
      email: `qa-ack113-op-${engine}-${randomUUID()}@demo.local`,
      password: 'DynaACK113Operator!-' + randomUUID(),
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
      name: 'QA113 ACK administrator',
      organization: { name: c.organization },
    },
    [201],
  );
  c.tenant = signup.user.tenant_id;
  c.user = signup.user.id;
  c.cookie = cookie;
  assert.equal(signup.user.role, 'admin');
  await save(s);
  await attempt(s, 'plan-' + engine, '/workspaces/plan', { plan: 'business' }, [200], 'PATCH');
  const warehouses = (await api('/warehouses')).data;
  assert.equal(warehouses.length, 1, 'Fresh own workspace has one explicit warehouse');
  c.warehouse = warehouses[0].id;
  await save(s);
  c.product = await attempt(
    s,
    'product-' + engine,
    '/products',
    {
      name: 'QA113 ACK produkt fizyczny',
      sku: 'QA113-ACK-A',
      ean: c.ean,
      price: 1500,
      warehouse_id: c.warehouse,
      quantity: 7,
      location: c.location,
    },
    [201],
  );
  await save(s);
  const before = await stock(c);
  assert.equal(before.on_hand, 7);
  assert.equal(before.reserved, 0);
  if (engine === 'wms') {
    const opening = (
      await attempt(
        s,
        'opening-' + engine,
        '/wms-lots/opening-previews',
        {
          client_key: randomUUID(),
          policy_version: '0',
          currency: 'PLN',
          note: 'QA113 ACK BO koszt317',
          lines: [
            {
              product_id: c.product.id,
              warehouse_id: c.warehouse,
              location: c.location,
              quantity: 7,
              stock_version: String(before.version),
              lot_code: 'QA113-ACK-LOT-A',
              unit_cost_minor: '317',
            },
          ],
        },
        [201],
      )
    ).preview;
    assert.equal(opening.ready, true);
    await attempt(
      s,
      'activate-' + engine,
      `/wms-lots/opening-previews/${opening.id}/activate`,
      {
        client_key: randomUUID(),
        scope_hash: opening.scope_hash,
        confirmed: true,
        ack_unknown_costs: false,
      },
      [201],
    );
    assert.equal((await api('/wms-lots/valuation')).valuation.known_minor, '2219');
  } else assert.equal((await api('/wms-lots')).policy.enabled, false);
  c.order = await attempt(
    s,
    'order-' + engine,
    '/orders',
    {
      customer_name: 'QA113 ACK rezerwacja kontrolna',
      email: 'qa113-ack@example.test',
      payment_mode: 'cod',
      warehouse_id: c.warehouse,
      items: [{ product_id: c.product.id, quantity: 3 }],
      note: 'QA113 ACK: nie wysyłać',
    },
    [201],
  );
  await save(s);
  await attempt(
    s,
    'picking-' + engine,
    '/orders/' + c.order.id + '/status',
    { status: 'picking' },
    [200],
    'PATCH',
  );
  if (engine === 'wms') {
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
  // One ordinary ORDER picking scan belongs to the setup/control snapshot only.
  // It is never used for stocktake counting, which must be performed in Chrome.
  await attempt(
    s,
    'control-picking-scan-' + engine,
    '/orders/' + c.order.id + '/scan',
    {
      client_key: randomUUID(),
      code: c.ean,
      location: c.location,
      ...(c.picking_layer_id ? { layer_id: c.picking_layer_id } : {}),
    },
    [200],
  );
  await assertReservation(c);
  c.reservation_before = await snapshot(c, reservationTables);
  const body = {
    client_key: randomUUID(),
    warehouse_id: c.warehouse,
    name: `QA113 ACK ślepy spis ${engine}`,
    blind: true,
    ...(engine === 'wms' ? { policy_version: '1' } : { location_prefix: c.location }),
  };
  const created = await attempt(
    s,
    'stocktake-' + engine,
    prefix(c),
    body,
    engine === 'wms' ? [201] : [200],
  );
  c.stocktake_id = engine === 'wms' ? created.stocktake.id : created.id;
  await save(s);
  const invitation = await attempt(
    s,
    'invitation-' + engine,
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
      name: 'QA113 ACK operator',
      invitation_token: invitation.token,
    },
    [201],
  );
  assert.equal(op.user.role, 'operator');
  assert.equal(op.user.tenant_id, c.tenant);
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
  assert.equal(meta.stocktake.blind, true);
  assert.equal(meta.current_role, 'operator');
  assert.equal(meta.stocktake.state, 'counting');
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
  c.line_id = candidate.data[0].line_id;
  c.physical_before = await snapshot(c, physical);
  c.ready = true;
  await save(s);
}
async function ownNames(): Promise<string[]> {
  return (
    await pool.query(
      "SELECT DISTINCT t.table_name FROM information_schema.tables t JOIN information_schema.columns c USING(table_schema,table_name) WHERE t.table_schema='public' AND t.table_type='BASE TABLE' AND c.column_name='tenant_id' UNION SELECT 'tenants' UNION SELECT 'users' ORDER BY 1",
    )
  ).rows.map((r) => String(r.table_name));
}
async function verifyCase(s: Json, c: Json) {
  await own(c, 'operator');
  await assertReservation(c);
  assert.deepEqual(
    await snapshot(c, physical),
    c.physical_before,
    'Inventory/OMS physical snapshot must remain exact',
  );
  assert.deepEqual(
    await snapshot(c, reservationTables),
    c.reservation_before,
    'Reserved and picking snapshot must remain exact',
  );
  const meta = await api(
    `${prefix(c)}/${c.stocktake_id}/scan-metadata`,
    'GET',
    undefined,
    [200],
    true,
  );
  assert.equal(meta.current_role, 'operator');
  assert.equal(meta.stocktake.blind, true);
  assert.equal(meta.stocktake.state, 'counting');
  assert.equal(meta.can_replay, true);
  const history = await api(
    `${prefix(c)}/${c.stocktake_id}/scans?limit=100`,
    'GET',
    undefined,
    [200],
    true,
  );
  assert.equal(history.current_role, 'operator');
  assert.equal(history.meta.total, 2);
  assert.equal(history.meta.cursor, null);
  assert.equal(history.data.length, 2);
  const receipts: Json[] = [...history.data].sort((a: Json, b: Json) =>
    BigInt(a.after_line_version) < BigInt(b.after_line_version) ? -1 : 1,
  );
  const [start, increment] = receipts;
  assert.equal(start.kind, 'start');
  assert.equal(start.counted, 0);
  assert.equal(start.increment, 0);
  assert.equal(start.generation_id, start.id);
  assert.equal(increment.kind, 'increment');
  assert.equal(increment.previous_count, 0);
  assert.equal(increment.increment, 1);
  assert.equal(increment.counted, 1);
  assert.equal(increment.generation_id, start.id);
  assert.equal(increment.before_line_version, start.after_line_version);
  for (const r of receipts) {
    assert.equal(r.engine, c.engine);
    assert.equal(r.stocktake_id, c.stocktake_id);
    assert.equal(r.line_id, c.line_id);
    assert.equal(r.product_id, c.product.id);
    assert.equal(r.location, c.location);
    assert.equal(r.code, c.ean);
    assert.equal(BigInt(r.after_line_version), BigInt(r.before_line_version) + 1n);
    assert(!('request' in r) && !('source_snapshot' in r) && !('basis_hash' in r));
    assert.deepEqual(
      (await api(`${prefix(c)}/${c.stocktake_id}/scans/${r.id}`, 'GET', undefined, [200], true))
        .scan,
      r,
    );
  }
  const lineTable = c.engine === 'wms' ? 'wms_stocktake_lines' : 'stocktake_lines';
  const lines = (
    await pool.query(
      `SELECT id,counted,version FROM ${lineTable} WHERE tenant_id=$1 AND stocktake_id=$2`,
      [c.tenant, c.stocktake_id],
    )
  ).rows;
  assert.deepEqual(lines, [{ id: c.line_id, counted: 1, version: increment.after_line_version }]);
  const receiptRows = (
    await pool.query(
      'SELECT actor_id,request,result,prior_scan_id,wms_measurement_id,quantity_measurement_id FROM stocktake_scan_receipts WHERE tenant_id=$1 AND engine=$2 AND stocktake_id=$3 ORDER BY after_line_version',
      [c.tenant, c.engine, c.stocktake_id],
    )
  ).rows;
  assert.equal(receiptRows.length, 2);
  assert(receiptRows.every((r) => r.actor_id === c.operator.user));
  assert.deepEqual(
    receiptRows.map((r) => r.result),
    receipts,
  );
  assert.equal(receiptRows[0].prior_scan_id, null);
  assert.equal(receiptRows[1].prior_scan_id, start.id);
  const measurementTable =
    c.engine === 'wms' ? 'wms_stocktake_measurements' : 'stocktake_measurements';
  const measures = (
    await pool.query(
      `SELECT id,actor_id FROM ${measurementTable} WHERE tenant_id=$1 AND stocktake_id=$2 ORDER BY id`,
      [c.tenant, c.stocktake_id],
    )
  ).rows;
  assert.equal(measures.length, 2, 'Exactly two real measurements, not duplicate ACK attempts');
  assert(measures.every((r) => r.actor_id === c.operator.user));
  const linked = receiptRows
    .map((r) => (c.engine === 'wms' ? r.wms_measurement_id : r.quantity_measurement_id))
    .sort();
  assert.deepEqual(measures.map((r) => r.id).sort(), linked);
  const query = new URLSearchParams({ code: c.ean, location: c.location });
  const candidates = await api(
    `${prefix(c)}/${c.stocktake_id}/scan-candidates?${query}`,
    'GET',
    undefined,
    [200],
    true,
  );
  assert.equal(candidates.current_role, 'operator');
  assert.equal(candidates.meta.total, 1);
  assert.equal(candidates.meta.cursor, null);
  const candidate = candidates.data[0];
  assert.equal(candidate.line_id, c.line_id);
  assert.equal(candidate.counted, 1);
  assert.equal(candidate.generation_id, start.id);
  assert.equal(candidate.can_continue, true);
  const publicKeys = new Set([
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
    Object.keys(candidate).every((k) => publicKeys.has(k)),
    'Blind projection cannot disclose system quantities or costs',
  );
  // Capture EVERY own tenant table and both known own actors before retry.
  const beforeReplay = await snapshot(c, s.own_names);
  s.pending = {
    label: 'exact-replay-' + c.engine,
    path: `${prefix(c)}/${c.stocktake_id}/scans`,
    method: 'POST',
    body: receiptRows[1].request,
    started_at: new Date().toISOString(),
  };
  await save(s);
  const replay = await api(s.pending.path, 'POST', s.pending.body, [200], true);
  assert.equal(replay.reused, true);
  assert.deepEqual(replay.scan, increment);
  assert.equal(replay.current_role, 'operator');
  assert.equal(replay.current_line, null);
  assert.deepEqual(
    await snapshot(c, s.own_names),
    beforeReplay,
    'Canonical retry must have zero effects across the complete own checkpoint',
  );
  s.pending = null;
  c.own_snapshot = beforeReplay;
  c.verified_count = 1;
  c.scan_count = 2;
  c.measurement_count = 2;
  c.start_receipt_id = start.id;
  c.increment_receipt_id = increment.id;
  c.replay_verified = true;
  await save(s);
}
async function report(s: Json, status: string) {
  await writeFile(
    `docs/stocktake-scans-ack-${phase}-qa.json`,
    JSON.stringify(
      {
        stage: 113,
        phase,
        status,
        revision: s.runtime_revision,
        schema: s.schema,
        independent_fixtures: true,
        ui_verified: s.ui_verified === true,
        ui_attestation:
          s.ui_verified === true
            ? 'Root explicitly attested actual Chrome ACK-loss/block/retry for BOTH cases; helper verifies readback only'
            : 'PENDING: real Chrome ACK loss and explicit retry required',
        cases: (s.cases ?? []).map((c: Json) => ({
          engine: c.engine,
          tenant: c.tenant,
          operator: c.operator?.user,
          warehouse: c.warehouse,
          product: c.product?.id,
          stocktake: c.stocktake_id,
          line: c.line_id,
          ean: c.ean,
          location: c.location,
          counted: c.verified_count ?? null,
          receipts: c.scan_count ?? null,
          measurements: c.measurement_count ?? null,
          start_receipt: c.start_receipt_id ?? null,
          increment_receipt: c.increment_receipt_id ?? null,
          own_checkpoint_sha256: c.own_snapshot ? sha(c.own_snapshot) : null,
          canonical_retry_zero_effects: c.replay_verified === true,
        })),
        physical_quantity_each: 7,
        reserved_quantity_each: 3,
        control_picking_scanned_each: 1,
        automated_stocktake_scans: 0,
        automated_stocktake_post: false,
        own_checkpoint_tables: s.own_names?.length ?? null,
        hardware_verified: false,
        provider_verified: false,
        goal_complete: false,
      },
      null,
      2,
    ) + '\n',
  );
  console.log({ phase, status, case_count: s.cases.length });
}

try {
  assert(phase === 'setup' || phase === 'verify', 'Use setup or verify only');
  let s: Json;
  if (phase === 'setup')
    s = {
      stage: 113,
      purpose: 'independent-browser-ack',
      created_at: new Date().toISOString(),
      cases: [],
      pending: null,
      ui_verified: false,
    };
  else {
    const st = await lstat(statePath);
    assert(st.isFile() && !st.isSymbolicLink() && (st.mode & 0o777) === 0o600);
    s = JSON.parse(await readFile(statePath, 'utf8')) as Json;
    assert.equal(s.stage, 113);
    assert.equal(s.purpose, 'independent-browser-ack');
    assert(
      s.setup_complete && !s.pending,
      'Only complete own setup with no uncertain request may verify',
    );
  }
  const expected = process.env.QA_EXPECTED_REVISION ?? '01179f4';
  assert(/^01179f4[a-f0-9]{0,33}$/.test(expected), 'Only accepted01179f4 source is eligible');
  const health = await api('/health');
  assert.equal(health.revision, expected);
  assert.equal(health.schema_revision, '095_stocktake_scan_recovery');
  assert.equal(health.restore_preview, false);
  assert.equal(health.stocktake_scans_available, true);
  if (phase === 'setup') {
    s.runtime_revision = expected;
    s.schema = health.schema_revision;
    await writeFile(statePath, JSON.stringify(s, null, 2), { flag: 'wx', mode: 0o600 });
    await setupCase(s, 'wms');
    await setupCase(s, 'quantity');
    assert.notEqual(s.cases[0].tenant, s.cases[1].tenant);
    s.setup_complete = true;
    await save(s);
    await report(s, 'SETUP_READY_CHROME_ACK_PENDING');
  } else {
    assert.equal(s.runtime_revision, expected);
    assert.equal(s.schema, health.schema_revision);
    assert.equal(
      process.env.QA_ACK_UI_VERIFIED,
      'true',
      'Root must independently verify ACK loss after commit, blocked next Enter and manual same-key/body retry for BOTH engines',
    );
    assert.equal(s.cases.length, 2);
    assert.deepEqual(
      s.cases.map((c: Json) => c.engine),
      ['wms', 'quantity'],
    );
    assert(s.cases.every((c: Json) => c.ready));
    s.own_names = await ownNames();
    s.own_snapshot_timezone = 'UTC';
    for (const c of s.cases) await verifyCase(s, c);
    s.ui_verified = true;
    s.api_acceptance = {
      status: 'PASS',
      at: new Date().toISOString(),
      canonical_replay: true,
      physical_unchanged: true,
    };
    await save(s);
    await report(s, 'ROOT_CHROME_ATTESTED_READBACK_AND_REPLAY_PASS');
  }
} catch {
  const safePhase = phase === 'setup' || phase === 'verify' ? phase : 'unknown';
  await writeFile(
    `docs/stocktake-scans-ack-${safePhase}-qa.json`,
    JSON.stringify(
      {
        stage: 113,
        phase: safePhase,
        status: 'INCOMPLETE',
        ui_verified: false,
        message:
          'Inspect only the own private state/pending step. Do not rerun partial setup or an uncertain POST automatically.',
        hardware_verified: false,
        provider_verified: false,
        goal_complete: false,
      },
      null,
      2,
    ) + '\n',
  ).catch(() => {});
  console.error({ phase: safePhase, status: 'INCOMPLETE' });
  process.exitCode = 1;
} finally {
  await pool.end();
}
