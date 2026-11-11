/** Prepared QA112 helper. Run setup, then manual operator UI, then verify with explicit attestation. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';

type Json = Record<string, any>;
const path = 'data/wms-stocktakes-stage112.json',
  prefix = '/wms-lots/stocktakes';
const phase = process.argv[2],
  sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const physical = [
  'products',
  'stock',
  'stock_locations',
  'wms_lots',
  'wms_cost_layers',
  'wms_layer_positions',
  'wms_layer_movements',
  'stock_movements',
  'stock_location_movements',
  'orders',
  'order_items',
  'order_pick_items',
  'reservations',
  'reservation_locations',
  'wms_reservation_layers',
  'wms_issue_fragments',
];
let cookie = '';
async function api(url: string, method = 'GET', body?: unknown, statuses = [200]) {
  const r = await fetch('http://127.0.0.1:4100/api' + url, {
    method,
    headers: { cookie, 'Content-Type': 'application/json' },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
    signal: AbortSignal.timeout(15000),
  });
  assert(statuses.includes(r.status), `${method} ${url}: HTTP ${r.status}`);
  const next = r.headers.get('set-cookie');
  if (next) cookie = next.split(';')[0];
  return r.json() as Promise<Json>;
}
async function save(s: Json) {
  await writeFile(path, JSON.stringify(s, null, 2), { mode: 0o600 });
}
async function snapshot(s: Json, names: string[]) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    const out: Json = {};
    for (const table of names) {
      assert(/^[a-z][a-z0-9_]*$/.test(table));
      const rows = (
        await c.query(
          `SELECT to_jsonb(t) row FROM "${table}" t WHERE ${['tenants', 'users'].includes(table) ? 'id' : 'tenant_id'}=$1 ORDER BY 1`,
          [table === 'users' ? s.user : s.tenant],
        )
      ).rows;
      out[table] = { count: rows.length, sha256: sha(rows) };
    }
    await c.query('COMMIT');
    return out;
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}
async function ownAdmin(s: Json) {
  const rows = (
    await pool.query(
      `SELECT t.id FROM tenants t JOIN memberships m ON m.tenant_id=t.id JOIN users u ON u.id=m.user_id
    WHERE t.id=$1 AND u.id=$2 AND m.role='admin' AND u.email=$3 AND t.name=$4 AND t.created_at >= $5::timestamptz`,
      [s.tenant, s.user, s.email, 'QA112 — lokalny odbiór partii', s.created_at],
    )
  ).rows;
  assert.equal(rows.length, 1, 'Only the known newly created QA112 admin/tenant is permitted');
  cookie = s.cookie;
  const me = (await api('/auth/me')).user;
  assert(
    me.id === s.user && me.tenant_id === s.tenant && me.role === 'admin',
    'QA112 administrator session required',
  );
}
async function unchangedValue(s: Json) {
  const stock = (
    await pool.query(
      'SELECT on_hand,reserved FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3',
      [s.tenant, s.warehouse, s.product.id],
    )
  ).rows;
  assert.deepEqual(stock, [{ on_hand: 9, reserved: 5 }]);
  const v = (await api('/wms-lots/valuation')).valuation;
  assert.equal(v.known_minor, '923');
  assert.equal(v.unknown_quantity, '0');
}
async function report(s: Json, status: string, extra: Json = {}) {
  await writeFile(
    'docs/wms-stocktakes-operator-qa.json',
    JSON.stringify(
      {
        stage: 112,
        status,
        revision: s.runtime_revision,
        schema: s.schema,
        tenant: s.tenant,
        operator_user: s.operator_user,
        operator_home_tenant: s.operator_home_tenant,
        stocktake: s.operator_stocktake_id,
        provider_verified: false,
        goal_complete: false,
        ...extra,
      },
      null,
      2,
    ) + '\n',
  );
  console.log({
    phase,
    status,
    tenant: s.tenant,
    operator_user: s.operator_user,
    stocktake: s.operator_stocktake_id,
  });
}
try {
  assert(['setup', 'verify'].includes(phase), 'Use setup or verify');
  const stat = await lstat(path);
  assert(
    stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600,
    'Private QA state must be a regular0600 file',
  );
  const s: Json = JSON.parse(await readFile(path, 'utf8'));
  assert(
    s.stage === 112 && s.api_acceptance?.status === 'PASS' && s.ui_verified === true,
    'Actual API and initial UI acceptance required',
  );
  const expected = process.env.QA_EXPECTED_REVISION ?? s.runtime_revision;
  assert(
    typeof expected === 'string' && /^[a-f0-9]{7,40}$/.test(expected),
    'Explicit verified source revision required',
  );
  const health = await api('/health');
  assert.equal(health.revision, expected);
  assert.equal(health.schema_revision, '093_wms_validation_scopes');
  assert.equal(health.restore_preview, false);
  assert.equal(health.wms_stocktakes_available, true);
  assert.equal(
    expected,
    s.runtime_revision,
    'Do not silently change the original acceptance source',
  );
  await ownAdmin(s);
  await unchangedValue(s);
  if (phase === 'setup') {
    assert(
      !s.operator_setup_started,
      'Partial setup requires manual readback; never create another account or spis automatically',
    );
    s.operator_setup_started = true;
    s.operator_setup_at = new Date().toISOString();
    s.operator_email = 'qa-wms112-operator-' + randomUUID().slice(0, 10) + '@demo.local';
    s.operator_password = 'DynaWms112Operator!-' + randomUUID();
    s.operator_signup_request = {
      email: s.operator_email,
      password: s.operator_password,
      name: 'QA112 operator ślepego spisu',
      organization: { name: 'QA112 operator — własne konto testowe' },
    };
    await save(s);
    cookie = '';
    const signup = await api('/auth/signup', 'POST', s.operator_signup_request, [201]);
    s.operator_user = signup.user.id;
    s.operator_home_tenant = signup.user.tenant_id;
    s.operator_new_cookie = cookie;
    await save(s);
    assert(
      s.operator_user !== s.user &&
        s.operator_home_tenant !== s.tenant &&
        signup.user.role === 'admin',
      'Fresh separate account/home required',
    );
    s.operator_membership_request = {
      user_id: s.operator_user,
      tenant_id: s.tenant,
      role: 'operator',
    };
    await save(s);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SET LOCAL statement_timeout='8s'");
      const own = (
        await c.query('SELECT role FROM memberships WHERE user_id=$1 AND tenant_id=$2 FOR SHARE', [
          s.user,
          s.tenant,
        ])
      ).rows;
      assert.deepEqual(own, [{ role: 'admin' }]);
      const fresh = (
        await c.query(
          `SELECT u.id FROM users u JOIN tenants t ON t.id=$2 JOIN memberships m ON m.user_id=u.id AND m.tenant_id=t.id
        WHERE u.id=$1 AND u.email=$3 AND t.created_at >= $4::timestamptz AND t.name=$5 AND m.role='admin'`,
          [
            s.operator_user,
            s.operator_home_tenant,
            s.operator_email,
            s.operator_setup_at,
            'QA112 operator — własne konto testowe',
          ],
        )
      ).rows;
      assert.equal(
        fresh.length,
        1,
        'Only the new synthetic account can receive this fixture membership',
      );
      const ms = (
        await c.query('SELECT tenant_id,role FROM memberships WHERE user_id=$1', [s.operator_user])
      ).rows;
      assert.deepEqual(
        ms,
        [{ tenant_id: s.operator_home_tenant, role: 'admin' }],
        'No existing QA112 or other membership permitted',
      );
      await c.query("INSERT INTO memberships(user_id,tenant_id,role) VALUES($1,$2,'operator')", [
        s.operator_user,
        s.tenant,
      ]);
      await c.query('COMMIT');
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
    s.operator_membership_complete = true;
    s.operator_switch_request = { tenant_id: s.tenant };
    await save(s);
    cookie = s.operator_new_cookie;
    const switched = await api('/workspaces/switch', 'POST', s.operator_switch_request);
    s.operator_new_cookie = cookie;
    await save(s);
    assert(
      switched.user.id === s.operator_user &&
        switched.user.tenant_id === s.tenant &&
        switched.user.role === 'operator',
      'Real operator session must select the own QA112 workspace',
    );
    cookie = s.cookie;
    const before = await snapshot(s, physical);
    s.operator_create_request = {
      client_key: randomUUID(),
      warehouse_id: s.warehouse,
      name: 'QA112 ślepy pomiar operatora',
      policy_version: '1',
      blind: true,
    };
    await save(s);
    const h = (await api(prefix, 'POST', s.operator_create_request, [201])).stocktake;
    s.operator_stocktake_id = h.id;
    s.operator_setup_complete = true;
    s.operator_physical_before = before;
    await save(s);
    assert.equal(h.blind, true);
    assert.equal(h.state, 'counting');
    assert.equal(h.line_count, 1);
    assert.deepEqual(await snapshot(s, physical), before);
    await report(s, 'SETUP_PASS', {
      role: 'operator',
      native_validation: 'PENDING',
      ui: 'PENDING',
    });
  } else {
    assert(
      s.operator_setup_complete && !s.operator_verify_started,
      'Partial verification requires manual readback; no automatic cancellation retry',
    );
    assert.equal(
      process.env.QA_OPERATOR_UI_VERIFIED,
      'true',
      'Root must confirm actual operator UI blind-count interaction first',
    );
    s.operator_verify_started = true;
    await save(s);
    assert.deepEqual(await snapshot(s, physical), s.operator_physical_before);
    const measured = (
      await pool.query(
        `SELECT l.id line_id,l.counted,l.latest_measurement_id,m.actor_id,m.kind FROM wms_stocktake_lines l
      JOIN wms_stocktake_measurements m ON (m.tenant_id,m.stocktake_id,m.id)=(l.tenant_id,l.stocktake_id,l.latest_measurement_id)
      WHERE l.tenant_id=$1 AND l.stocktake_id=$2`,
        [s.tenant, s.operator_stocktake_id],
      )
    ).rows;
    assert.equal(measured.length, 1);
    assert.equal(measured[0].counted, 9);
    assert.equal(measured[0].actor_id, s.operator_user);
    assert.equal(measured[0].kind, 'count');
    const membership = (
      await pool.query('SELECT role FROM memberships WHERE user_id=$1 AND tenant_id=$2', [
        s.operator_user,
        s.tenant,
      ])
    ).rows;
    assert.deepEqual(membership, [{ role: 'operator' }]);
    cookie = s.operator_new_cookie;
    const blind = await api(prefix + '/' + s.operator_stocktake_id + '/lines');
    assert.equal(blind.current_role, 'operator');
    assert.equal(blind.can_read_value, false);
    assert.equal(blind.data.length, 1);
    assert.equal(blind.meta.cursor, null);
    const allowed = new Set([
      'id',
      'product_id',
      'sku',
      'name',
      'location',
      'lot',
      'counted',
      'version',
      'basis_token',
      'needs_recount',
    ]);
    assert(
      Object.keys(blind.data[0]).every((k) => allowed.has(k)),
      'Blind API projection must not expose basis or cost',
    );
    assert.equal(blind.data[0].counted, 9);
    assert.equal(blind.data[0].id, measured[0].line_id);
    cookie = s.cookie;
    const h = (await api(prefix + '/' + s.operator_stocktake_id)).stocktake;
    assert.equal(h.state, 'counting');
    s.operator_cancel_request = {
      client_key: randomUUID(),
      version: h.version,
      note: 'QA112 zakończony ślepy pomiar operatora — anulowanie bez korekty',
    };
    await save(s);
    const cancelled = await api(
      prefix + '/' + h.id + '/cancel',
      'POST',
      s.operator_cancel_request,
      [201],
    );
    assert.equal(cancelled.stocktake.state, 'cancelled');
    const after = await snapshot(s, s.own_names);
    assert.equal(
      (await api(prefix + '/' + h.id + '/cancel', 'POST', s.operator_cancel_request)).reused,
      true,
    );
    assert.deepEqual(await snapshot(s, s.own_names), after);
    assert.deepEqual(await snapshot(s, physical), s.operator_physical_before);
    await unchangedValue(s);
    s.operator_ui_verified = true;
    s.native_operator_ui_verified = true;
    s.operator_measurement_id = measured[0].latest_measurement_id;
    s.cookie = cookie;
    s.restart_verified = false;
    s.own_snapshot_timezone = 'UTC';
    s.own_names = (
      await pool.query(`SELECT DISTINCT t.table_name FROM information_schema.tables t JOIN information_schema.columns col USING(table_schema,table_name)
      WHERE t.table_schema='public' AND t.table_type='BASE TABLE' AND col.column_name='tenant_id'
      UNION SELECT 'tenants' UNION SELECT 'users' ORDER BY 1`)
    ).rows.map((r) => r.table_name);
    s.own_snapshot = await snapshot(s, s.own_names);
    await save(s);
    await report(s, 'PASS', {
      role: 'operator',
      measurement_id: s.operator_measurement_id,
      counted: 9,
      physical: 9,
      reserved: 5,
      known_value_minor: '923',
      actual_operator_ui_attested: true,
      blind_api_projection: true,
      cancel_replay_inert: true,
      physical_unchanged: true,
      restart: 'PENDING',
      restore: 'PENDING',
    });
  }
} finally {
  await pool.end();
}
