/** QA112 uses the real loopback API. Private credentials never enter public evidence. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, lstat } from 'node:fs/promises';
import { pool } from '../server/db';

type Json = Record<string, any>;
const statePath = 'data/wms-stocktakes-stage112.json';
const prefix = '/wms-lots/stocktakes';
const phase = process.argv[2];
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
let cookie = '';
async function api(path: string, method = 'GET', body?: unknown, statuses = [200]) {
  const response = await fetch('http://127.0.0.1:4100/api' + path, {
    method,
    headers: { cookie, 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(15000),
  });
  assert(statuses.includes(response.status), `${method} ${path}: HTTP ${response.status}`);
  const next = response.headers.get('set-cookie');
  if (next) cookie = next.split(';')[0];
  return response.json() as Promise<Json>;
}
const save = (s: Json) => writeFile(statePath, JSON.stringify(s, null, 2), { mode: 0o600 });
const report = (name: string, value: unknown) =>
  writeFile('docs/' + name, JSON.stringify(value, null, 2) + '\n');
const physical = [
  'stock',
  'stock_locations',
  'wms_lots',
  'wms_cost_layers',
  'wms_layer_positions',
  'wms_layer_movements',
  'stock_movements',
  'stock_location_movements',
];
const protectedOrder = [
  'products',
  'orders',
  'order_items',
  'order_pick_items',
  'reservations',
  'reservation_locations',
  'wms_reservation_layers',
  'wms_issue_fragments',
  'order_events',
  'outbound_events',
  'outbound_deliveries',
  'warehouse_documents',
  'return_cases',
  'shipments',
];
const evidence = [
  ...new Set([
    ...physical,
    ...protectedOrder,
    'wms_operations',
    'audit_events',
    'wms_stocktakes',
    'wms_stocktake_lines',
    'wms_stocktake_scope_layers',
    'wms_stocktake_measurements',
    'wms_stocktake_measurement_layers',
    'wms_stocktake_reviews',
    'wms_stocktake_review_rows',
    'wms_stocktake_postings',
  ]),
];
async function snapshot(s: Json, names: string[]) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    const out: Record<string, { count: number; sha256: string }> = {};
    for (const name of names) {
      assert(/^[a-z][a-z0-9_]*$/.test(name));
      const rows = (
        await c.query(
          `SELECT to_jsonb(t) row FROM "${name}" t WHERE
        ${['tenants', 'users'].includes(name) ? 'id' : 'tenant_id'}=$1 ORDER BY 1`,
          [name === 'users' ? s.user : s.tenant],
        )
      ).rows;
      out[name] = { count: rows.length, sha256: digest(rows) };
    }
    await c.query('COMMIT');
    return out;
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}
async function stock(s: Json) {
  return (
    await pool.query(
      'SELECT on_hand,reserved FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3',
      [s.tenant, s.warehouse, s.product.id],
    )
  ).rows[0];
}
async function counted(s: Json, h: Json, quantity: number) {
  const page = await api(prefix + '/' + h.id + '/lines');
  assert.equal(page.data.length, 1);
  assert.equal(page.meta.cursor, null);
  const line = page.data[0];
  const body = {
    client_key: randomUUID(),
    note: 'QA112 rzeczywisty pomiar lokalny',
    lines: [{ id: line.id, version: line.version, basis_token: line.basis_token, quantity }],
  };
  s.count_request = body;
  await save(s);
  const result = await api(prefix + '/' + h.id + '/counts', 'POST', body, [201]);
  const before = await snapshot(s, evidence);
  assert.equal((await api(prefix + '/' + h.id + '/counts', 'POST', body)).reused, true);
  assert.deepEqual(await snapshot(s, evidence), before);
  return { line, result, head: (await api(prefix + '/' + h.id)).stocktake };
}
async function create(s: Json, name: string) {
  const body = {
    client_key: randomUUID(),
    warehouse_id: s.warehouse,
    name,
    policy_version: '1',
    blind: true,
  };
  s.create_request = body;
  await save(s);
  const result = await api(prefix, 'POST', body, [201]);
  const before = await snapshot(s, evidence);
  assert.equal((await api(prefix, 'POST', body)).reused, true);
  assert.deepEqual(await snapshot(s, evidence), before);
  return result.stocktake;
}
async function checkpoint(s: Json) {
  const names = (
    await pool.query(`SELECT DISTINCT t.table_name FROM information_schema.tables t
    JOIN information_schema.columns col USING(table_schema,table_name)
    WHERE t.table_schema='public' AND t.table_type='BASE TABLE' AND col.column_name='tenant_id'
    UNION SELECT 'tenants' UNION SELECT 'users' ORDER BY 1`)
  ).rows.map((r) => r.table_name);
  s.own_names = names;
  s.own_snapshot_timezone = 'UTC';
  s.own_snapshot = await snapshot(s, names);
  await save(s);
}
try {
  const health = await api('/health');
  const existing = phase === 'setup' ? null : JSON.parse(await readFile(statePath, 'utf8'));
  const expected = process.env.QA_EXPECTED_REVISION ?? existing?.runtime_revision;
  assert(
    expected && /^[a-f0-9]{7,40}$/.test(expected),
    'An explicit verified revision is required',
  );
  assert.equal(health.revision, expected);
  assert.equal(health.schema_revision, '093_wms_validation_scopes');
  assert.equal(health.restore_preview, false);
  assert.equal(health.wms_stocktakes_available, true);
  if (phase === 'setup') {
    const s: Json = {
      stage: 112,
      created_at: new Date().toISOString(),
      runtime_revision: expected,
      schema: health.schema_revision,
      email: 'qa-wms112-' + randomUUID().slice(0, 10) + '@demo.local',
      password: 'DynaWms112!-' + randomUUID(),
      ui_verified: false,
      restart_verified: false,
    };
    await writeFile(statePath, JSON.stringify(s, null, 2), { flag: 'wx', mode: 0o600 });
    const signup = await api(
      '/auth/signup',
      'POST',
      {
        email: s.email,
        password: s.password,
        name: 'QA112 administrator inwentaryzacji',
        organization: { name: 'QA112 — lokalny odbiór partii' },
      },
      [201],
    );
    s.tenant = signup.user.tenant_id;
    s.user = signup.user.id;
    s.cookie = cookie;
    await save(s);
    await api('/workspaces/plan', 'PATCH', { plan: 'business' });
    s.warehouse = (await api('/warehouses')).data[0].id;
    s.product = await api(
      '/products',
      'POST',
      {
        name: 'QA112 produkt liczony',
        sku: 'QA112-A',
        price: 2500,
        warehouse_id: s.warehouse,
        quantity: 10,
        location: 'A-01',
      },
      [201],
    );
    const version = (
      await pool.query('SELECT version FROM stock WHERE tenant_id=$1 AND product_id=$2', [
        s.tenant,
        s.product.id,
      ])
    ).rows[0].version;
    const opening = (
      await api(
        '/wms-lots/opening-previews',
        'POST',
        {
          client_key: randomUUID(),
          policy_version: '0',
          currency: 'PLN',
          note: 'QA112 jawny koszt początkowy',
          lines: [
            {
              product_id: s.product.id,
              warehouse_id: s.warehouse,
              location: 'A-01',
              quantity: 10,
              stock_version: String(version),
              lot_code: 'QA112-LOT',
              unit_cost_minor: '100',
            },
          ],
        },
        [201],
      )
    ).preview;
    assert.equal(opening.ready, true);
    await api(
      '/wms-lots/opening-previews/' + opening.id + '/activate',
      'POST',
      {
        client_key: randomUUID(),
        scope_hash: opening.scope_hash,
        confirmed: true,
        ack_unknown_costs: false,
      },
      [201],
    );
    s.order = await api(
      '/orders',
      'POST',
      {
        customer_name: 'QA112 kupujący lokalny',
        email: 'qa112@example.test',
        phone: '500600700',
        payment_mode: 'cod',
        warehouse_id: s.warehouse,
        address: {
          street: 'Testowa',
          building_number: '1',
          city: 'Warszawa',
          post_code: '00-001',
          country: 'PL',
        },
        items: [{ product_id: s.product.id, quantity: 5 }],
      },
      [201],
    );
    s.cookie = cookie;
    s.setup_complete = true;
    await save(s);
    assert.deepEqual(await stock(s), { on_hand: 10, reserved: 5 });
    await report('wms-stocktakes-native-setup-qa.json', {
      stage: 112,
      status: 'SETUP_PASS',
      revision: expected,
      schema: health.schema_revision,
      tenant: s.tenant,
      physical: 10,
      reserved: 5,
      known_value_minor: '1000',
      provider_verified: false,
      goal_complete: false,
    });
    console.log({ phase, status: 'SETUP_PASS', tenant: s.tenant });
  } else {
    const s = existing as Json;
    const stat = await lstat(statePath);
    assert(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600);
    cookie = s.cookie;
    if (phase === 'api') {
      assert(
        s.setup_complete && !s.api_started,
        'Partial mutations need readback, not an automatic replay',
      );
      s.api_started = true;
      await save(s);
      const orderBefore = await snapshot(s, protectedOrder);
      const physicalBefore = await snapshot(s, physical);
      const h = await create(s, 'QA112 niedobór z ochroną rezerwacji');
      s.shortage_id = h.id;
      await save(s);
      const m = await counted(s, h, 8);
      const reviewBody = {
        client_key: randomUUID(),
        version: m.head.version,
        note: 'QA112 zgoda na niedobór dwóch sztuk',
        surplus: [],
      };
      s.review_request = reviewBody;
      await save(s);
      const r = (await api(prefix + '/' + h.id + '/reviews', 'POST', reviewBody, [201])).review;
      assert.equal(r.summary.shortage_quantity, 2);
      assert.equal(r.summary.known_loss_minor, '200');
      assert.deepEqual(await snapshot(s, physical), physicalBefore);
      const reviewedSnapshot = await snapshot(s, evidence);
      assert.equal((await api(prefix + '/' + h.id + '/reviews', 'POST', reviewBody)).reused, true);
      assert.deepEqual(await snapshot(s, evidence), reviewedSnapshot);
      const body = {
        client_key: randomUUID(),
        version: r.stocktake_version,
        review_id: r.id,
        scope_hash: r.scope_hash,
        confirmed: true,
      };
      s.post_request = body;
      await save(s);
      const result = await api(prefix + '/' + h.id + '/post', 'POST', body, [201]);
      assert.equal(result.posting.changed, true);
      assert.deepEqual(await snapshot(s, protectedOrder), orderBefore);
      assert.deepEqual(await stock(s), { on_hand: 8, reserved: 5 });
      const after = await snapshot(s, evidence);
      const replay = await api(prefix + '/' + h.id + '/post', 'POST', body);
      assert.equal(replay.reused, true);
      assert.equal(replay.posting.id, result.posting.id);
      assert.deepEqual(await snapshot(s, evidence), after);
      assert.equal((await api('/wms-lots/valuation')).valuation.known_minor, '800');
      await api('/orders/' + s.order.id + '/status', 'PATCH', { status: 'picking' });
      const a = (
        await pool.query(
          'SELECT layer_id,location FROM wms_reservation_layers WHERE tenant_id=$1 AND order_id=$2',
          [s.tenant, s.order.id],
        )
      ).rows[0];
      await api(
        '/orders/' + s.order.id + '/scan',
        'POST',
        {
          client_key: randomUUID(),
          code: s.product.sku,
          location: a.location,
          layer_id: a.layer_id,
        },
        [200, 201],
      );
      assert.equal(
        (
          await pool.query(
            'SELECT scanned FROM wms_reservation_layers WHERE tenant_id=$1 AND order_id=$2',
            [s.tenant, s.order.id],
          )
        ).rows[0].scanned,
        1,
      );
      const cancelled = await create(s, 'QA112 ponowne liczenie i anulowanie');
      const c = await counted(s, cancelled, 8);
      const cr = (
        await api(
          prefix + '/' + cancelled.id + '/reviews',
          'POST',
          {
            client_key: randomUUID(),
            version: c.head.version,
            note: 'QA112 przegląd bez różnicy',
            surplus: [],
          },
          [201],
        )
      ).review;
      const reopenBody = {
        client_key: randomUUID(),
        version: cr.stocktake_version,
        note: 'QA112 ponowny pomiar',
      };
      s.reopen_request = reopenBody;
      await save(s);
      const reopened = (
        await api(prefix + '/' + cancelled.id + '/reopen', 'POST', reopenBody, [201])
      ).stocktake;
      const reopenedSnapshot = await snapshot(s, evidence);
      assert.equal(
        (await api(prefix + '/' + cancelled.id + '/reopen', 'POST', reopenBody)).reused,
        true,
      );
      assert.deepEqual(await snapshot(s, evidence), reopenedSnapshot);
      const c2 = await counted(s, reopened, 7);
      const cancelBody = {
        client_key: randomUUID(),
        version: c2.head.version,
        note: 'QA112 anulowanie przed korektą',
      };
      await api(prefix + '/' + cancelled.id + '/cancel', 'POST', cancelBody, [201]);
      const cancelledAfter = await snapshot(s, evidence);
      assert.equal(
        (await api(prefix + '/' + cancelled.id + '/cancel', 'POST', cancelBody)).reused,
        true,
      );
      assert.deepEqual(await snapshot(s, evidence), cancelledAfter);
      assert.deepEqual(await stock(s), { on_hand: 8, reserved: 5 });
      assert.equal((await api(prefix + '/' + cancelled.id + '/reviews')).data.length, 1);
      s.cancelled_id = cancelled.id;
      s.api_acceptance = {
        status: 'PASS',
        shortage: 2,
        reserved: 5,
        original_reservation_scannable: true,
        preview_inert: true,
        exact_retries_effect_free: true,
        replayed_operations: ['create', 'count', 'review', 'post', 'reopen', 'cancel'],
        actor_role: 'admin',
        native_operator_ui_verified: false,
        reopen_history_cancel: true,
      };
      s.cookie = cookie;
      await save(s);
      await report('wms-stocktakes-native-api-qa.json', {
        stage: 112,
        ...s.api_acceptance,
        revision: expected,
        schema: health.schema_revision,
        tenant: s.tenant,
        stocktake: h.id,
        physical: 8,
        known_value_minor: '800',
        ui: 'PENDING',
        restart: 'PENDING',
        restore: 'PENDING',
        provider_verified: false,
        goal_complete: false,
      });
      console.log({ phase, status: 'API_PASS', tenant: s.tenant });
    } else if (phase === 'ui-checkpoint') {
      assert(s.api_acceptance?.status === 'PASS' && !s.ui_verified);
      assert.deepEqual(await stock(s), { on_hand: 9, reserved: 5 });
      assert.equal((await api('/wms-lots/valuation')).valuation.known_minor, '923');
      const posted = (
        await pool.query(
          "SELECT id FROM wms_stocktakes WHERE tenant_id=$1 AND state='posted' AND id<>$2",
          [s.tenant, s.shortage_id],
        )
      ).rows;
      assert.equal(posted.length, 1);
      s.ui_stocktake_id = posted[0].id;
      assert.equal(
        (await api(prefix + '/' + s.ui_stocktake_id + '/posting')).posting.state,
        'posted',
      );
      s.ui_verified = true;
      await checkpoint(s);
      await report('wms-stocktakes-ui-qa.json', {
        stage: 112,
        status: 'UI_PASS',
        revision: expected,
        tenant: s.tenant,
        stocktake: s.ui_stocktake_id,
        physical: 9,
        reserved: 5,
        known_value_minor: '923',
        screenshot: 'wms-stocktakes-ui-posted.png',
        goal_complete: false,
      });
      console.log({ phase, status: 'UI_CHECKPOINT_PASS' });
    } else if (phase === 'restart') {
      assert(s.ui_verified && !s.restart_verified);
      assert.deepEqual(await snapshot(s, s.own_names), s.own_snapshot);
      const login = await api('/auth/login', 'POST', { email: s.email, password: s.password });
      assert.equal(login.user.tenant_id, s.tenant);
      assert.equal((await api(prefix + '/' + s.ui_stocktake_id)).stocktake.state, 'posted');
      assert.deepEqual(await stock(s), { on_hand: 9, reserved: 5 });
      s.cookie = cookie;
      s.restart_verified = true;
      await checkpoint(s);
      await report('wms-stocktakes-restart-qa.json', {
        stage: 112,
        status: 'RESTART_PASS',
        revision: expected,
        schema: health.schema_revision,
        checkpoint_exact_before_login: true,
        goal_complete: false,
      });
      console.log({ phase, status: 'RESTART_PASS' });
    } else assert.fail('Use setup, api, ui-checkpoint or restart');
  }
} finally {
  await pool.end();
}
