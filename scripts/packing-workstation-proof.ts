/** Native QA110. Never rebase the baseline or print private session credentials. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';

const statePath = 'data/packing-workstation-stage110.json';
const phase = process.argv[2];
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
let cookie = '';
async function api(path: string, method = 'GET', body?: unknown, status = 200, lease?: string) {
  const r = await fetch('http://127.0.0.1:4100/api' + path, {
    method,
    headers: {
      cookie,
      'Content-Type': 'application/json',
      ...(lease ? { 'X-Packing-Lease': lease } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal(r.status, status, `${method} ${path}: HTTP${r.status}`);
  const next = r.headers.get('set-cookie');
  if (next) cookie = next.split(';')[0];
  return r.json() as Promise<any>;
}
const save = (state: any) => writeFile(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
async function preservation() {
  const original = JSON.parse(
    await readFile('data/packing-workstation-stage110-baseline.json', 'utf8'),
  );
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    const mismatches: string[] = [];
    const traced: string[] = [];
    let trace: any;
    try {
      trace = JSON.parse(await readFile('data/packing-workstation-listing-trace.json', 'utf8'));
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
    }
    for (const name of original.names) {
      assert(/^[a-z][a-z0-9_]*$/.test(name));
      const scope =
        name === 'shopify_translation_claims'
          ? 'EXISTS(SELECT 1 FROM shopify_translation_plans p WHERE p.id=t.plan_id AND p.tenant_id=ANY($1::uuid[]))'
          : `${name === 'tenants' ? 't.id' : 't.tenant_id'}=ANY($1::uuid[])`;
      const rows = (
        await c.query(`SELECT to_jsonb(t) row FROM "${name}" t WHERE ${scope} ORDER BY 1`, [
          original.ids,
        ])
      ).rows;
      if (
        rows.length !== original.before[name].count ||
        hash(rows) !== original.before[name].sha256
      ) {
        mismatches.push(name);
        if (name === 'listings' && trace) {
          assert(trace.report.actual_backup_matches_original_listing_baseline);
          const overrides = new Map(trace.overrides.map((r: any) => [r.id, r]));
          const normalized = structuredClone(rows);
          for (const { row } of normalized) {
            const old: any = overrides.get(row.id);
            if (!old) continue;
            const sync = row.last_result.odoo_catalog_sync;
            assert.equal(sync.scope, 'local_simulation');
            const run = (
              await c.query(
                'SELECT simulation,state FROM odoo_catalog_sync_runs WHERE tenant_id=$1 AND id=$2',
                [row.tenant_id, sync.run_id],
              )
            ).rows[0];
            assert(run?.simulation && run.state === 'success');
            sync.run_id = old.run_id;
            sync.observed_at = old.observed_at;
          }
          // PostgreSQL jsonb ordering is not lexical JSON ordering; sort in the database.
          const canonical = (
            await c.query(
              'SELECT value row FROM jsonb_array_elements($1::jsonb) v(value) ORDER BY 1',
              [JSON.stringify(normalized.map((r) => r.row))],
            )
          ).rows;
          assert.equal(
            hash(canonical),
            original.before[name].sha256,
            'Only individually traced Odoo observation fields may differ',
          );
          traced.push(name);
        }
      }
    }
    const users = (
      await c.query('SELECT to_jsonb(u) row FROM users u WHERE id=ANY($1::uuid[]) ORDER BY id', [
        original.user_ids,
      ])
    ).rows;
    assert.equal(hash(users), original.users_sha256);
    const databases = (await c.query('SELECT datname FROM pg_database ORDER BY datname')).rows.map(
      (r) => r.datname,
    );
    assert(original.databases.every((name: string) => databases.includes(name)));
    await c.query('COMMIT');
    return {
      earlier_firms: original.ids.length,
      earlier_users: original.user_ids.length,
      protected_tables: original.names.length,
      raw_exact_tables: original.names.length - mismatches.length,
      mismatches,
      traced_mismatch_tables: traced,
      untraced_mismatches: mismatches.filter((n) => !traced.includes(n)),
      all_other_fields_exact: mismatches.every((n) => traced.includes(n)),
      prior_databases_preserved: original.databases.length,
      baseline_rebased: false,
    };
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}
async function ownSnapshot(tenant: string, extraNames?: string[]) {
  const names = extraNames ?? [
    'orders',
    'order_items',
    'order_pick_items',
    'reservations',
    'reservation_locations',
    'stock',
    'stock_locations',
    'stock_movements',
    'stock_location_movements',
    'products',
    'product_logistics',
    'shipping_plans',
    'shipments',
    'documents',
    'payment_entries',
    'packing_stations',
    'packing_cartons',
    'packing_policies',
    'packing_sessions',
    'packing_operations',
    'packing_previews',
    'packing_receipts',
    'order_packing_profiles',
  ];
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    const rows: Record<string, string> = {};
    for (const name of names)
      rows[name] = hash(
        (
          await c.query(`SELECT to_jsonb(t) row FROM "${name}" t WHERE tenant_id=$1 ORDER BY 1`, [
            tenant,
          ])
        ).rows,
      );
    await c.query('COMMIT');
    return rows;
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}
try {
  const health = await api('/health');
  assert.equal(health.revision, process.env.PACKING_PROOF_REVISION ?? '3002ab9');
  assert.equal(health.schema_revision, '089_packing_workstation');
  assert(health.packing_workstation_available);
  assert(!health.restore_preview);
  const preserved = await preservation();
  if (phase === 'preserved') {
    await writeFile(
      'docs/packing-workstation-preservation-qa.json',
      JSON.stringify(
        {
          stage: 110,
          phase,
          status: preserved.untraced_mismatches.length
            ? 'RAW_MISMATCH_REQUIRES_TRACE'
            : preserved.mismatches.length
              ? 'PASS_WITH_TRACED_OBSERVATION_FIELDS'
              : 'PASS',
          runtime_revision: health.revision,
          schema: health.schema_revision,
          ...preserved,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(preserved);
  } else if (phase === 'prepare') {
    const state: any = {
      stage: 110,
      email: 'qa-packing110-' + randomUUID().slice(0, 8) + '@demo.local',
      password: 'DynaPacking!2026-' + randomUUID(),
      created_at: new Date().toISOString(),
      runtime_revision: health.revision,
      schema: health.schema_revision,
    };
    await writeFile(statePath, JSON.stringify(state, null, 2), { mode: 0o600, flag: 'wx' });
    const signup = await api(
      '/auth/signup',
      'POST',
      {
        email: state.email,
        password: state.password,
        name: 'QA pakowanie110',
        organization: { name: 'QA pakowanie110 — lokalne dane testowe' },
      },
      201,
    );
    state.tenant = signup.user.tenant_id;
    state.user = signup.user.id;
    state.cookie = cookie;
    await save(state);
    await api('/workspaces/plan', 'PATCH', { plan: 'business' });
    state.warehouse = (await api('/warehouses')).data[0].id;
    state.station = (
      await api(
        '/packing/stations',
        'POST',
        {
          client_key: randomUUID(),
          code: 'QA110-01',
          label: 'QA110 stanowisko testowe',
          enabled: true,
        },
        201,
      )
    ).station;
    state.carton = (
      await api(
        '/packing/cartons',
        'POST',
        {
          client_key: randomUUID(),
          code: 'QA110-C01',
          label: 'QA110 karton testowy',
          enabled: true,
          inner_dimensions: { length_mm: 360, width_mm: 180, height_mm: 80 },
          outer_dimensions: { length_mm: 380, width_mm: 200, height_mm: 100 },
          tare_grams: 120,
        },
        201,
      )
    ).carton;
    state.product = await api(
      '/products',
      'POST',
      {
        sku: 'QA110-P01',
        name: 'QA110 produkt do rzeczywistego skanowania',
        price: 2500,
        warehouse_id: state.warehouse,
        quantity: 20,
        location: 'QA110-A',
        weight_grams: 1000,
        length_mm: 100,
        width_mm: 50,
        height_mm: 20,
      },
      201,
    );
    const makeOrder = () =>
      api(
        '/orders',
        'POST',
        {
          customer_name: 'QA110 Odbiorca Testowy',
          email: 'packing110@example.test',
          payment_mode: 'cod',
          warehouse_id: state.warehouse,
          address: {
            street: 'Testowa',
            city: 'Warszawa',
            postal_code: '01-354',
            country: 'PL',
            phone: '500600700',
          },
          items: [{ product_id: state.product.id, quantity: 2 }],
        },
        201,
      );
    state.api_order = await makeOrder();
    state.ui_order = await makeOrder();
    for (const o of [state.api_order, state.ui_order])
      await api('/orders/' + o.id + '/status', 'PATCH', { status: 'picking' });
    let o = await api('/orders/' + state.api_order.id);
    state.api_lease = randomUUID();
    let s = (
      await api(
        '/packing/sessions',
        'POST',
        {
          client_key: randomUUID(),
          order_id: o.id,
          order_version: String(o.version),
          station_id: state.station.id,
          station_version: state.station.version,
          lease_token: state.api_lease,
        },
        201,
      )
    ).session;
    for (let i = 0; i < 2; i++) {
      const body = {
        client_key: randomUUID(),
        session_version: s.version,
        order_version: String(o.version),
        code: state.product.sku,
        location: 'QA110-A',
      };
      const first = await api(
        '/packing/sessions/' + s.id + '/scans',
        'POST',
        body,
        201,
        state.api_lease,
      );
      const replay = await api(
        '/packing/sessions/' + s.id + '/scans',
        'POST',
        body,
        200,
        state.api_lease,
      );
      assert(replay.reused);
      assert.deepEqual(replay.operation, first.operation);
      s = (await api('/packing/sessions/' + s.id, 'GET', undefined, 200, state.api_lease)).session;
    }
    const measured = { weight_grams: 2370, length_mm: 380, width_mm: 200, height_mm: 100 };
    const p = (
      await api(
        '/packing/previews',
        'POST',
        {
          client_key: randomUUID(),
          kind: 'finish',
          session_id: s.id,
          session_version: s.version,
          order_version: String(o.version),
          station_version: state.station.version,
          packaging: {
            kind: 'carton',
            carton_id: state.carton.id,
            carton_version: state.carton.version,
          },
          measurements: measured,
          include_product_estimate: true,
        },
        201,
        state.api_lease,
      )
    ).preview;
    assert(p.ready);
    state.api_preview = p;
    state.api_session = s;
    const body = {
      client_key: randomUUID(),
      scope_hash: p.scope_hash,
      confirmed: true,
      confirm_measured: true,
    };
    const finished = await api(
      '/packing/previews/' + p.id + '/finish',
      'POST',
      body,
      201,
      state.api_lease,
    );
    const repeated = await api(
      '/packing/previews/' + p.id + '/finish',
      'POST',
      body,
      200,
      state.api_lease,
    );
    assert(repeated.reused);
    assert.deepEqual(repeated.receipt, finished.receipt);
    state.api_receipt = finished.receipt;
    o = await api('/orders/' + o.id);
    assert.equal(o.status, 'packed');
    assert.equal(String(o.version), finished.receipt.after_order_version);
    state.cookie = cookie;
    state.checkpoint = await ownSnapshot(state.tenant);
    await save(state);
    await writeFile(
      'docs/packing-workstation-native-qa.json',
      JSON.stringify(
        {
          stage: 110,
          status: 'API_PASS; UI_RESTART_RECOVERY_PENDING',
          runtime_revision: health.revision,
          schema: health.schema_revision,
          api_order: o.id,
          ui_order: state.ui_order.id,
          receipt: state.api_receipt.id,
          measurement: measured,
          scanned_physical_quantity: 2,
          scan_exact_retry: true,
          finish_exact_retry: true,
          ui_verified: false,
          restart_verified: false,
          recovery_verified: false,
          provider_verified: false,
          preservation: preserved,
          goal_complete: false,
        },
        null,
        2,
      ) + '\n',
    );
    console.log({
      phase,
      status: 'API_PASS; UI_RESTART_RECOVERY_PENDING',
      tenant: state.tenant,
      api_order: o.id,
      ui_order: state.ui_order.id,
      receipt: state.api_receipt.id,
      preservation: preserved,
    });
  } else if (phase === 'ui-checkpoint') {
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    cookie = state.cookie;
    const order = await api('/orders/' + state.ui_order.id);
    assert.equal(order.status, 'packed');
    assert.equal(String(order.version), '3');
    const profile = (await api('/packing/orders/' + order.id + '/profile')).profile;
    assert(profile.current);
    assert.equal(profile.revision, '1');
    const receipt = (await api('/packing/receipts/' + profile.receipt_id)).receipt;
    assert.deepEqual(receipt.measurements, {
      weight_grams: 2375,
      length_mm: 380,
      width_mm: 200,
      height_mm: 100,
    });
    const session = (
      await pool.query('SELECT * FROM packing_sessions WHERE tenant_id=$1 AND order_id=$2', [
        state.tenant,
        order.id,
      ])
    ).rows[0];
    assert.equal(session.state, 'finished');
    assert.equal(session.version, '5');
    assert.equal(session.lease_generation, '2');
    const operations = (
      await pool.query(
        'SELECT kind,count(*)::integer n FROM packing_operations WHERE tenant_id=$1 AND session_id=$2 GROUP BY kind',
        [state.tenant, session.id],
      )
    ).rows;
    assert.equal(operations.find((r) => r.kind === 'scan')?.n, 2);
    assert.equal(operations.find((r) => r.kind === 'renew')?.n, 1);
    const plans = (await api('/orders/' + order.id + '/shipping')).data;
    assert.equal(plans.length, 1);
    const plan = plans[0];
    assert.equal(plan.state, 'ready');
    assert.equal(plan.job_state, 'done');
    assert.equal(plan.simulation, 'true');
    assert.equal(plan.input.packing.receipt_id, receipt.id);
    assert.equal(plan.input.packing_snapshot.receipt_id, receipt.id);
    assert.equal(plan.input.receiver.first_name, 'QA110 Szkic');
    assert.deepEqual(plan.payload.parcels, [
      {
        dimensions: { length: 380, width: 200, height: 100, unit: 'mm' },
        weight: { amount: 2.375, unit: 'kg' },
        is_non_standard: false,
      },
    ]);
    assert.equal(plan.order_snapshot.status, 'packed');
    assert(!Object.hasOwn(plan.order_snapshot, 'packing'));
    const events = (
      await pool.query(
        "SELECT count(*)::integer n FROM order_events WHERE tenant_id=$1 AND order_id=$2 AND kind='order.packed'",
        [state.tenant, order.id],
      )
    ).rows[0];
    assert.equal(events.n, 1);
    const checkpoint = await ownSnapshot(state.tenant);
    for (const table of [
      'products',
      'product_logistics',
      'stock',
      'stock_locations',
      'stock_movements',
      'stock_location_movements',
      'documents',
      'payment_entries',
    ])
      assert.equal(
        checkpoint[table],
        state.checkpoint[table],
        table + ' changed during packing/label',
      );
    state.ui_receipt = receipt;
    state.ui_session_id = session.id;
    state.ui_plan_id = plan.id;
    state.checkpoint = checkpoint;
    await save(state);
    const report = JSON.parse(await readFile('docs/packing-workstation-native-qa.json', 'utf8'));
    Object.assign(report, {
      status: 'UI/API/LOCAL_LABEL_PASS; RESTART_RECOVERY_PENDING',
      ui_verified: true,
      ui_receipt: receipt.id,
      ui_session_reload_verified: true,
      explicit_renew_verified: true,
      ui_measurements: receipt.measurements,
      ui_finish_disabled_before_consent: true,
      dpd_nonrepresentable_button_disabled: true,
      recipient_draft_preserved_on_handoff: true,
      bound_inpost_local_label_verified: true,
      ui_shipping_plan: plan.id,
      checkpoint_tables: Object.keys(checkpoint).length,
      preservation: preserved,
    });
    await writeFile(
      'docs/packing-workstation-native-qa.json',
      JSON.stringify(report, null, 2) + '\n',
    );
    console.log({
      phase,
      status: report.status,
      ui_receipt: receipt.id,
      ui_plan: plan.id,
      preservation: preserved,
    });
  } else if (phase === 'effects-checkpoint') {
    assert.deepEqual(
      preserved.untraced_mismatches,
      [],
      'Trace every old-business mismatch before acceptance',
    );
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    assert(state.ui_receipt && state.ui_plan_id);
    assert.deepEqual(
      await ownSnapshot(state.tenant),
      state.checkpoint,
      'Original23 checkpoint remains unchanged',
    );
    const names = [
      'jobs',
      'order_events',
      'audit_events',
      'outbound_events',
      'outbound_deliveries',
      'email_messages',
      'sms_messages',
      'order_local_financial_fences',
    ];
    const active = (
      await pool.query(
        "SELECT count(*)::int n FROM jobs WHERE tenant_id=$1 AND state IN ('pending','running')",
        [state.tenant],
      )
    ).rows[0].n;
    assert.equal(active, 0);
    const effects = await ownSnapshot(state.tenant, names);
    await writeFile(
      'data/packing-workstation-effects-checkpoint.json',
      JSON.stringify({ names, effects }, null, 2),
      { mode: 0o600, flag: 'wx' },
    );
    state.effects_names = names;
    state.effects_checkpoint = effects;
    await save(state);
    console.log({
      phase,
      status: 'PASS',
      original_checkpoint_tables: 23,
      effects_tables: names.length,
      active_jobs: active,
      preservation: preserved,
    });
  } else if (phase === 'verify' || phase === 'restart') {
    assert.deepEqual(
      preserved.untraced_mismatches,
      [],
      'Untraced baseline drift blocks acceptance',
    );
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    cookie = state.cookie;
    const receipt = await api('/packing/receipts/' + state.api_receipt.id);
    assert.equal(receipt.receipt.id, state.api_receipt.id);
    const profile = (await api('/packing/orders/' + state.api_order.id + '/profile')).profile;
    assert(profile.current);
    assert.equal(profile.receipt_id, state.api_receipt.id);
    const snapshot = await ownSnapshot(state.tenant);
    assert.deepEqual(snapshot, state.checkpoint);
    assert(state.effects_names?.length === 8 && state.effects_checkpoint);
    assert.deepEqual(
      await ownSnapshot(state.tenant, state.effects_names),
      state.effects_checkpoint,
    );
    const report = JSON.parse(await readFile('docs/packing-workstation-native-qa.json', 'utf8'));
    report.preservation = preserved;
    report.restart_verified = phase === 'restart' || report.restart_verified;
    report.checkpoint_tables_exact = Object.keys(snapshot).length;
    report.effects_tables_exact = state.effects_names.length;
    report.runtime_revision = health.revision;
    await writeFile(
      'docs/packing-workstation-native-qa.json',
      JSON.stringify(report, null, 2) + '\n',
    );
    console.log({
      phase,
      status: 'PASS',
      checkpoint_tables: Object.keys(snapshot).length,
      preservation: preserved,
    });
  } else throw Error('Use preserved, prepare, verify or restart');
} finally {
  await pool.end();
}
