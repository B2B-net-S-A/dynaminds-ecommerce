/** Root-only QA112 extension. Writes through loopback HTTP to a newly created own firm. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
import { verifyWmsStocktakesPreservation } from './wms-stocktakes-preservation';

type Json = Record<string, any>;
const statePath = 'data/wms-stocktakes-extended112.json';
const reportPath = 'docs/wms-stocktakes-extended-native-qa.json';
const baselinePath = 'data/wms-stocktakes-stage112-baseline.json';
const primaryPath = 'data/wms-stocktakes-stage112.json';
const phase = process.argv[2];
const prefix = '/wms-lots/stocktakes';
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bytesHash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
let cookie = '',
  workspace = '';
let activeState: Json | undefined;
async function api(path: string, method = 'GET', body?: unknown, statuses = [200]): Promise<Json> {
  const writes = !['GET', 'HEAD'].includes(method);
  if (writes && activeState) {
    activeState.last_write = { path, method, request: body ?? {}, response_received: false };
    await save(activeState);
  }
  const response = await fetch('http://127.0.0.1:4100/api' + path, {
    method,
    headers: {
      cookie,
      'Content-Type': 'application/json',
      ...(workspace ? { 'X-Workspace-Id': workspace } : {}),
    },
    body: ['GET', 'HEAD'].includes(method) ? undefined : JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(15000),
  });
  if (writes && activeState) {
    activeState.last_write.response_received = true;
    activeState.last_write.http_status = response.status;
    await save(activeState);
  }
  assert(statuses.includes(response.status), `${method} ${path}: HTTP ${response.status}`);
  const next = response.headers.get('set-cookie');
  if (next) cookie = next.split(';')[0];
  const result = (await response.json()) as Json;
  if (writes && activeState) {
    activeState.last_write.accepted = true;
    activeState.cookie = cookie;
    await save(activeState);
  }
  return result;
}
const save = (s: Json) => writeFile(statePath, JSON.stringify(s, null, 2), { mode: 0o600 });
const report = (data: Json) => writeFile(reportPath, JSON.stringify(data, null, 2) + '\n');
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
const protectedOms = [
  'products',
  'product_logistics',
  'product_sku_aliases',
  'bundle_components',
  'orders',
  'order_items',
  'order_pick_items',
  'reservations',
  'reservation_locations',
  'wms_reservation_layers',
  'wms_issue_fragments',
  'wms_return_fragments',
  'order_events',
  'outbound_events',
  'outbound_deliveries',
  'payment_entries',
  'order_local_financial_fences',
  'return_cases',
  'return_items',
  'shipping_plans',
  'shipments',
];
const effects = [
  ...new Set([
    ...physical,
    ...protectedOms,
    'wms_operations',
    'wms_previews',
    'audit_events',
    'warehouse_documents',
    'warehouse_document_lines',
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
async function rows(s: Json, table: string, extra = '', args: unknown[] = []): Promise<Json[]> {
  assert(/^[a-z][a-z0-9_]*$/.test(table));
  return (
    await pool.query(`SELECT * FROM "${table}" WHERE tenant_id=$1 ${extra}`, [s.tenant, ...args])
  ).rows;
}
async function snapshot(s: Json, names: string[]) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    const result: Record<string, { count: number; sha256: string }> = {};
    for (const name of names) {
      assert(/^[a-z][a-z0-9_]*$/.test(name));
      const r = (
        await c.query(
          `SELECT to_jsonb(t) row FROM "${name}" t WHERE ${['users', 'tenants'].includes(name) ? 'id' : 'tenant_id'}=$1 ORDER BY 1`,
          [name === 'users' ? s.user : s.tenant],
        )
      ).rows;
      result[name] = { count: r.length, sha256: sha(r) };
    }
    await c.query('COMMIT');
    return result;
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}
async function stockVersions(s: Json) {
  const stocks = await rows(s, 'stock', 'AND warehouse_id=$2 AND product_id=$3', [
    s.warehouse,
    s.product.id,
  ]);
  assert.equal(stocks.length, 1);
  return [
    { warehouse_id: s.warehouse, product_id: s.product.id, version: String(stocks[0].version) },
  ];
}
async function expectStock(s: Json, quantity: number, reserved: number) {
  const stocks = await rows(s, 'stock', 'AND warehouse_id=$2 AND product_id=$3', [
    s.warehouse,
    s.product.id,
  ]);
  assert.equal(stocks.length, 1);
  assert.equal(stocks[0].on_hand, quantity);
  assert.equal(stocks[0].reserved, reserved);
  return stocks[0];
}
async function value(expected: string) {
  const v = (await api('/wms-lots/valuation')).valuation;
  assert.equal(v.known_minor, expected);
  assert.equal(v.unknown_quantity, '0');
  assert.equal(v.currency, 'PLN');
  return v;
}
async function allPages(path: string): Promise<Json[]> {
  const result: Json[] = [],
    seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await api(
      path +
        (path.includes('?') ? '&' : '?') +
        new URLSearchParams({ limit: '100', ...(cursor ? { cursor } : {}) }),
    );
    assert(page.data.length <= 100);
    result.push(...page.data);
    cursor = page.meta.cursor;
    if (cursor) {
      assert(!seen.has(cursor));
      seen.add(cursor);
    }
    assert(seen.size <= 100);
  } while (cursor);
  assert.equal(new Set(result.map((r) => r.id ?? r.line_id)).size, result.length);
  return result;
}
async function retry(s: Json, path: string, body: Json, flag = 'reused') {
  const before = await snapshot(s, effects);
  const result = await api(path, 'POST', body);
  assert.equal(result[flag], true);
  assert.deepEqual(
    await snapshot(s, effects),
    before,
    'Exact retry changed own OMS/WMS or immutable evidence',
  );
  return result;
}
async function waitFor(path: string, ready: (r: Json) => boolean, failed: (r: Json) => boolean) {
  const until = Date.now() + 60000;
  while (Date.now() < until) {
    const r = await api(path);
    assert(!failed(r), 'Local simulated shipping failed');
    if (ready(r)) return r;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  assert.fail('Local worker did not complete within 60 seconds');
}
async function waitJobs(s: Json) {
  const until = Date.now() + 60000;
  while (Date.now() < until) {
    const jobs = await rows(s, 'jobs');
    assert.equal(
      jobs.filter((j) => j.state === 'failed' || j.error != null).length,
      0,
      'Own worker failed/error jobs',
    );
    if (!jobs.some((j) => ['pending', 'running'].includes(j.state))) return;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  assert.fail('Own worker jobs remain nonterminal');
}
async function checkpoint(s: Json) {
  s.own_names = (
    await pool.query(
      `SELECT DISTINCT t.table_name FROM information_schema.tables t JOIN information_schema.columns col USING(table_schema,table_name) WHERE t.table_schema='public' AND t.table_type='BASE TABLE' AND col.column_name='tenant_id' UNION SELECT 'tenants' UNION SELECT 'users' ORDER BY 1`,
    )
  ).rows.map((r) => r.table_name);
  s.own_snapshot_timezone = 'UTC';
  s.own_snapshot = await snapshot(s, s.own_names);
  s.cookie = cookie;
  await save(s);
}
async function immutableInputs(s: Json) {
  assert.equal(
    bytesHash(await readFile(baselinePath)),
    s.original_baseline_sha256,
    'Never rebase the original112 baseline',
  );
  assert.equal(
    bytesHash(await readFile(primaryPath)),
    s.primary_state_sha256,
    'Do not modify the primary112 QA state',
  );
  const p = await verifyWmsStocktakesPreservation();
  assert.equal(p.status, 'PASS_CORE_AND_SOURCE_TRACED_BACKGROUND');
  assert.equal(p.original_baseline_sha256, s.original_baseline_sha256);
  return p;
}

try {
  assert(
    ['setup', 'api', 'ui-checkpoint', 'restart', 'readback'].includes(phase ?? ''),
    'Use setup, api, ui-checkpoint, restart or readback',
  );
  const health = await api('/health');
  const s: Json = phase === 'setup' ? {} : JSON.parse(await readFile(statePath, 'utf8'));
  const expected = process.env.QA_EXPECTED_REVISION ?? s.runtime_revision;
  assert(
    typeof expected === 'string' && /^[a-f0-9]{7,40}$/.test(expected),
    'Explicit accepted runtime required',
  );
  assert.equal(health.revision, expected);
  assert.equal(health.schema_revision, '093_wms_validation_scopes');
  assert.equal(health.restore_preview, false);
  assert.equal(health.wms_lots_available, true);
  assert.equal(health.wms_stocktakes_available, true);
  if (phase === 'setup') {
    Object.assign(s, {
      stage: 112,
      extension: 'BO_TWO_PZ_TWO_BINS_DISPATCH_PARTIAL_RETURN',
      created_at: new Date().toISOString(),
      runtime_revision: expected,
      schema: health.schema_revision,
      email: 'qa-wms112-extended-' + randomUUID().slice(0, 12) + '@demo.local',
      password: 'DynaWms112Extended!-' + randomUUID(),
      original_baseline_sha256: bytesHash(await readFile(baselinePath)),
      primary_state_sha256: bytesHash(await readFile(primaryPath)),
      ui_verified: false,
      restart_verified: false,
    });
    s.preservation_before = await immutableInputs(s);
    await writeFile(statePath, JSON.stringify(s, null, 2), { flag: 'wx', mode: 0o600 });
    activeState = s;
    const signup = await api(
      '/auth/signup',
      'POST',
      {
        email: s.email,
        password: s.password,
        name: 'QA112 extended administrator',
        organization: { name: 'QA112 extended — BO/dostawy i zwrot' },
      },
      [201],
    );
    s.tenant = signup.user.tenant_id;
    s.user = signup.user.id;
    workspace = s.tenant;
    s.cookie = cookie;
    await save(s);
    const primary: Json = JSON.parse(await readFile(primaryPath, 'utf8'));
    assert.notEqual(s.tenant, primary.tenant);
    await api('/workspaces/plan', 'PATCH', { plan: 'business' });
    s.warehouse = (await api('/warehouses')).data[0].id;
    s.product = await api(
      '/products',
      'POST',
      {
        name: 'QA112 extended fizyczny składnik',
        sku: 'QA112-EXT-A',
        ean: '001120000001',
        price: 2500,
        vat: 23,
        warehouse_id: s.warehouse,
        quantity: 10,
        location: 'A-01',
      },
      [201],
    );
    s.bundle = await api(
      '/products',
      'POST',
      {
        name: 'QA112 extended zestaw 2A',
        sku: 'QA112-EXT-KIT',
        kind: 'bundle',
        price: 6000,
        vat: 23,
        components: [{ product_id: s.product.id, quantity: 2 }],
        warehouse_id: s.warehouse,
        quantity: 0,
        location: 'A-01',
      },
      [201],
    );
    await save(s);
    assert.equal((await api('/wms-lots')).policy.enabled, false);
    s.opening_request = {
      client_key: randomUUID(),
      policy_version: '0',
      currency: 'PLN',
      note: 'QA112 extended BO10 ze znanym kosztem100',
      lines: [
        {
          product_id: s.product.id,
          warehouse_id: s.warehouse,
          location: 'A-01',
          quantity: 10,
          stock_version: (await stockVersions(s))[0].version,
          lot_code: 'EXT-BO',
          unit_cost_minor: '100',
        },
      ],
    };
    await save(s);
    const opening = (await api('/wms-lots/opening-previews', 'POST', s.opening_request, [201]))
      .preview;
    assert.equal(opening.ready, true);
    s.opening_preview_id = opening.id;
    s.activation_request = {
      client_key: randomUUID(),
      scope_hash: opening.scope_hash,
      confirmed: true,
      ack_unknown_costs: false,
    };
    await save(s);
    await api(
      '/wms-lots/opening-previews/' + opening.id + '/activate',
      'POST',
      s.activation_request,
      [201],
    );
    await expectStock(s, 10, 0);
    await value('1000');
    const layers = await rows(s, 'wms_cost_layers');
    assert.equal(layers.length, 1);
    s.bo_layer = layers[0];
    assert.equal(s.bo_layer.unit_cost_minor, '100');
    assert.equal(s.bo_layer.quantity_received, 10);
    s.setup_complete = true;
    s.cookie = cookie;
    s.preservation_after_setup = await immutableInputs(s);
    await save(s);
    await report({
      stage: 112,
      extension: s.extension,
      status: 'SETUP_PASS_API_PENDING',
      revision: expected,
      schema: s.schema,
      tenant: s.tenant,
      bo_quantity: 10,
      bo_value_minor: '1000',
      api: 'PENDING',
      ui: 'PENDING',
      restart: 'PENDING',
      restore: 'PENDING',
      provider_verified: false,
      goal_complete: false,
    });
  } else {
    const stat = await lstat(statePath);
    assert(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600);
    assert.equal(expected, s.runtime_revision, 'Do not relabel an existing acceptance');
    cookie = s.cookie;
    workspace = s.tenant;
    if (phase === 'readback') {
      assert(s.tenant && s.user, 'An own signup identity is required for partial readback');
      assert.equal(bytesHash(await readFile(baselinePath)), s.original_baseline_sha256);
      assert.equal(bytesHash(await readFile(primaryPath)), s.primary_state_sha256);
      const counts: Json = {};
      for (const name of effects) counts[name] = (await rows(s, name)).length;
      const stocks = await rows(s, 'stock');
      const orders = await rows(s, 'orders');
      const heads = await rows(s, 'wms_stocktakes');
      const operations = await rows(s, 'wms_operations');
      const channels = (await api('/shipping/channels')).data;
      await report({
        stage: 112,
        extension: s.extension,
        status:
          s.api_acceptance?.status === 'PASS'
            ? 'COMPLETED_API_READBACK'
            : 'PARTIAL_READBACK_REQUIRES_ROOT_DECISION',
        revision: expected,
        schema: s.schema,
        tenant: s.tenant,
        counts,
        stocks: stocks.map((r) => ({
          product_id: r.product_id,
          warehouse_id: r.warehouse_id,
          quantity: r.on_hand,
          reserved: r.reserved,
          version: String(r.version),
        })),
        orders: orders.map((r) => ({ id: r.id, status: r.status, version: r.version })),
        stocktakes: heads.map((r) => ({
          id: r.id,
          state: r.state,
          version: String(r.version),
          posting_id: r.posting_id,
        })),
        operations: operations.map((r) => ({ id: r.id, kind: r.kind, client_key: r.client_key })),
        shipping_channels: channels.map((r: Json) => ({
          id: r.id,
          simulation: r.settings.simulation === true,
        })),
        last_write: s.last_write
          ? {
              path: s.last_write.path,
              method: s.last_write.method,
              response_received: s.last_write.response_received,
              accepted: s.last_write.accepted === true,
              http_status: s.last_write.http_status ?? null,
              client_key: s.last_write.request?.client_key ?? null,
            }
          : null,
        automatic_resume: false,
        readonly_readback: true,
        provider_verified: false,
        goal_complete: false,
      });
    } else if (phase === 'api') {
      activeState = s;
      s.preservation_before_phase = await immutableInputs(s);
      assert(
        s.setup_complete && !s.api_started && !s.api_acceptance,
        'Partial attempts require exact readback and a separate approved resume; do not rerun writes',
      );
      s.api_started = new Date().toISOString();
      await save(s);
      await expectStock(s, 10, 0);
      await value('1000');
      s.receipts = [];
      for (const [quantity, cost, location, code] of [
        [6, '200', 'A-01', 'EXT-PZ-1'],
        [4, '300', 'B-01', 'EXT-PZ-2'],
      ] as const) {
        const body = {
          client_key: randomUUID(),
          policy_version: '1',
          warehouse_id: s.warehouse,
          stock_versions: await stockVersions(s),
          confirmed: true,
          note: 'QA112 extended rzeczywisty lokalny PZ',
          lines: [
            {
              product_id: s.product.id,
              quantity,
              location,
              lot_code: code,
              unit_cost_minor: cost,
              currency: 'PLN',
            },
          ],
        };
        s.pending_receipt_request = body;
        await save(s);
        const r = await api('/wms-lots/receipts', 'POST', body, [201]);
        assert.equal(r.operation.kind, 'receipt');
        const document = (
          await rows(s, 'warehouse_documents', 'AND id=$2', [r.result.warehouse_document_id])
        )[0];
        assert(document);
        assert.equal(document.kind, 'receipt');
        assert.equal(document.status, 'posted');
        const layer = (
          await rows(s, 'wms_cost_layers', 'AND operation_id=$2', [r.operation.id])
        )[0];
        assert(layer);
        assert.equal(layer.unit_cost_minor, cost);
        assert.equal(layer.quantity_received, quantity);
        assert.equal(layer.warehouse_document_id, document.id);
        assert.equal((await retry(s, '/wms-lots/receipts', body)).operation.id, r.operation.id);
        s.receipts.push({
          request: body,
          operation_id: r.operation.id,
          document_id: document.id,
          layer,
        });
        await save(s);
      }
      await expectStock(s, 20, 0);
      await value('3400');
      // One actual lot/layer spans two bins, without inventing two lots with equal display codes.
      s.bin_move_request = {
        client_key: randomUUID(),
        policy_version: '1',
        kind: 'bin_move',
        product_id: s.product.id,
        warehouse_id: s.warehouse,
        location: 'A-01',
        destination_location: 'B-01',
        quantity: 2,
        layer_ids: [s.receipts[0].layer.id],
        stock_versions: await stockVersions(s),
        note: 'QA112 extended ta sama partia w dwóch binach',
      };
      await save(s);
      const move = (await api('/wms-lots/movement-previews', 'POST', s.bin_move_request, [201]))
        .preview;
      assert.equal(move.ready, true);
      s.bin_move_execute = {
        client_key: randomUUID(),
        scope_hash: move.scope_hash,
        confirmed: true,
      };
      await save(s);
      s.bin_move_operation = (
        await api(
          '/wms-lots/movement-previews/' + move.id + '/execute',
          'POST',
          s.bin_move_execute,
          [201],
        )
      ).operation;
      const moveJournal = await rows(s, 'wms_layer_movements', 'AND operation_id=$2', [
        s.bin_move_operation.id,
      ]);
      assert.equal(moveJournal.length, 2);
      assert.equal(
        moveJournal.reduce((n, r) => n + BigInt(r.delta), 0n),
        0n,
      );
      assert.equal(
        moveJournal.reduce((n, r) => n + BigInt(r.value_delta), 0n),
        0n,
      );
      await value('3400');
      const split = await rows(s, 'wms_layer_positions', 'AND layer_id=$2 ORDER BY location', [
        s.receipts[0].layer.id,
      ]);
      assert.deepEqual(
        split.map((r) => ({ location: r.location, quantity: r.quantity })),
        [
          { location: 'A-01', quantity: 4 },
          { location: 'B-01', quantity: 2 },
        ],
      );
      s.order = await api(
        '/orders',
        'POST',
        {
          customer_name: 'QA112 extended lokalny kupujący',
          email: 'qa112-ext@example.test',
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
          items: [{ product_id: s.bundle.id, quantity: 4 }],
        },
        [201],
      );
      await save(s);
      const reserved = await rows(s, 'wms_reservation_layers', 'AND order_id=$2', [s.order.id]);
      assert.equal(reserved.length, 1);
      assert.equal(reserved[0].layer_id, s.bo_layer.id);
      assert.equal(reserved[0].quantity, 8);
      await api('/orders/' + s.order.id + '/status', 'PATCH', { status: 'picking' });
      const firstScan = {
        client_key: randomUUID(),
        code: s.product.sku,
        location: reserved[0].location,
        layer_id: reserved[0].layer_id,
      };
      await api('/orders/' + s.order.id + '/scan', 'POST', firstScan);
      const firstScanSnapshot = await snapshot(s, effects);
      await api('/orders/' + s.order.id + '/scan', 'POST', firstScan);
      assert.deepEqual(await snapshot(s, effects), firstScanSnapshot);
      await expectStock(s, 20, 8);
      s.reservations_before_post = await rows(s, 'wms_reservation_layers', 'AND order_id=$2', [
        s.order.id,
      ]);
      assert.equal(s.reservations_before_post[0].scanned, 1);
      const omsBefore = await snapshot(s, protectedOms),
        physicalBefore = await snapshot(s, physical);
      s.stocktake_create = {
        client_key: randomUUID(),
        warehouse_id: s.warehouse,
        name: 'QA112 extended BO i dwie dostawy / dwa biny',
        policy_version: '1',
        blind: true,
      };
      await save(s);
      s.stocktake = (await api(prefix, 'POST', s.stocktake_create, [201])).stocktake;
      await save(s);
      const lines = await allPages(prefix + '/' + s.stocktake.id + '/lines');
      assert.equal(lines.length, 4);
      const bo = lines.find((l) => l.lot.id === s.bo_layer.lot_id)!;
      const surplus = lines.find(
        (l) => l.lot.id === s.receipts[0].layer.lot_id && l.location === 'B-01',
      )!;
      assert(bo && surplus);
      assert.equal(bo.current_quantity, 10);
      assert.equal(bo.reserved, 8);
      assert.equal(surplus.current_quantity, 2);
      s.count_request = {
        client_key: randomUUID(),
        note: 'QA112 extended rzeczywisty pomiar czterech lot-binów',
        lines: lines.map((l) => ({
          id: l.id,
          version: l.version,
          basis_token: l.basis_token,
          quantity: l.id === bo.id ? 9 : l.id === surplus.id ? 3 : l.current_quantity,
        })),
      };
      await save(s);
      await api(prefix + '/' + s.stocktake.id + '/counts', 'POST', s.count_request, [201]);
      await retry(s, prefix + '/' + s.stocktake.id + '/counts', s.count_request);
      const head = (await api(prefix + '/' + s.stocktake.id)).stocktake;
      s.review_request = {
        client_key: randomUUID(),
        version: head.version,
        note: 'QA112 extended niedobór BO100 i nadwyżka koszt250',
        surplus: [{ line_id: surplus.id, unit_cost_minor: '250', currency: 'PLN' }],
      };
      await save(s);
      s.review = (
        await api(prefix + '/' + s.stocktake.id + '/reviews', 'POST', s.review_request, [201])
      ).review;
      assert.equal(s.review.summary.total, 4);
      assert.equal(s.review.summary.changed, 2);
      assert.equal(s.review.summary.shortage_quantity, 1);
      assert.equal(s.review.summary.surplus_quantity, 1);
      assert.equal(s.review.summary.known_loss_minor, '100');
      assert.equal(s.review.summary.known_surplus_minor, '250');
      const plan = await allPages(
        prefix + '/' + s.stocktake.id + '/reviews/' + s.review.id + '/rows',
      );
      const loss = plan.find((l) => l.line_id === bo.id)!;
      assert.equal(loss.fragments.length, 1);
      assert.equal(loss.fragments[0].layer_id, s.bo_layer.id);
      assert.equal(loss.fragments[0].quantity, 1);
      assert.equal(loss.fragments[0].unit_cost_minor, '100');
      assert.deepEqual(
        await snapshot(s, physical),
        physicalBefore,
        'Counts/review must not change any physical stock',
      );
      assert.deepEqual(
        await snapshot(s, protectedOms),
        omsBefore,
        'Counts/review must not alter original reservation/scanned/OMS',
      );
      const stockBeforePost = (await stockVersions(s))[0].version;
      s.post_request = {
        client_key: randomUUID(),
        version: s.review.stocktake_version,
        review_id: s.review.id,
        scope_hash: s.review.scope_hash,
        confirmed: true,
      };
      await save(s);
      s.posting = (
        await api(prefix + '/' + s.stocktake.id + '/post', 'POST', s.post_request, [201])
      ).posting;
      assert.equal(s.posting.changed, true);
      assert.deepEqual(
        await snapshot(s, protectedOms),
        omsBefore,
        'Stocktake post changed protected OMS/reservations',
      );
      const afterPost = await expectStock(s, 20, 8);
      assert.equal(BigInt(afterPost.version), BigInt(stockBeforePost) + 1n);
      await value('3550');
      assert.deepEqual(
        await rows(s, 'wms_reservation_layers', 'AND order_id=$2', [s.order.id]),
        s.reservations_before_post,
      );
      s.surplus_layer = (
        await rows(s, 'wms_cost_layers', 'AND stocktake_line_id=$2', [surplus.id])
      )[0];
      assert(s.surplus_layer);
      assert.equal(s.surplus_layer.lot_id, s.receipts[0].layer.lot_id);
      assert.equal(s.surplus_layer.unit_cost_minor, '250');
      assert.equal(s.surplus_layer.quantity_received, 1);
      assert.equal(
        (await retry(s, prefix + '/' + s.stocktake.id + '/post', s.post_request)).posting.id,
        s.posting.id,
      );
      assert.equal((await rows(s, 'wms_issue_fragments')).length, 0);
      assert.equal((await api(prefix + '/' + s.stocktake.id)).stocktake.needs_recount_count, 0);
      for (let n = 1; n < 8; n++) {
        const body = {
          client_key: randomUUID(),
          code: s.product.sku,
          location: reserved[0].location,
          layer_id: reserved[0].layer_id,
        };
        await api('/orders/' + s.order.id + '/scan', 'POST', body);
        const beforeRetry = await snapshot(s, effects);
        await api('/orders/' + s.order.id + '/scan', 'POST', body);
        assert.deepEqual(await snapshot(s, effects), beforeRetry);
      }
      assert.equal(
        (await rows(s, 'wms_reservation_layers', 'AND order_id=$2', [s.order.id]))[0].scanned,
        8,
      );
      await api('/orders/' + s.order.id + '/status', 'PATCH', { status: 'packed' });
      await value('3550');
      assert.equal((await rows(s, 'wms_issue_fragments')).length, 0);
      const channel = await api('/shipping/example', 'POST', {});
      s.shipping_channel_id = channel.id;
      await save(s);
      const ownChannel = (await api('/shipping/channels')).data.find(
        (c: Json) => c.id === channel.id,
      );
      assert(ownChannel);
      assert.equal(ownChannel.settings.simulation, true, 'Never send an actual provider request');
      const packed = await api('/orders/' + s.order.id);
      s.shipping_input = {
        channel_id: channel.id,
        service: 'inpost_courier_standard',
        receiver: {
          first_name: 'QA112',
          last_name: 'Extended',
          email: 'qa112-ext@example.test',
          phone: '500600700',
          address: {
            street: 'Testowa',
            building_number: '1',
            city: 'Warszawa',
            post_code: '00-001',
            country_code: 'PL',
          },
        },
        dimensions: { length: 380, width: 200, height: 100 },
        weight: 2,
        cod: packed.total,
        insurance: packed.total,
      };
      await save(s);
      const shipping = await api(
        '/orders/' + s.order.id + '/shipping/preview',
        'POST',
        s.shipping_input,
        [200, 201],
      );
      s.shipping_plan_id = shipping.id;
      await save(s);
      await api('/shipping-plans/' + shipping.id + '/queue', 'POST', {});
      const path = '/orders/' + s.order.id + '/shipping';
      const quoted = (
        await waitFor(
          path,
          (r) => r.data.some((p: Json) => p.id === shipping.id && p.state === 'quoted'),
          (r) => r.data.some((p: Json) => p.id === shipping.id && p.state === 'failed'),
        )
      ).data.find((p: Json) => p.id === shipping.id);
      assert(quoted.offers.length > 0);
      await api('/shipping-plans/' + shipping.id + '/buy', 'POST', {
        offer_id: quoted.offers[0].id,
        confirm_cost: true,
        ack_unknown_rate: true,
      });
      await waitFor(
        path,
        (r) => r.data.some((p: Json) => p.id === shipping.id && p.state === 'ready'),
        (r) => r.data.some((p: Json) => p.id === shipping.id && p.state === 'failed'),
      );
      await value('3550');
      assert.equal((await rows(s, 'wms_issue_fragments')).length, 0);
      await api('/shipping-plans/' + shipping.id + '/dispatch', 'POST', {});
      await expectStock(s, 12, 0);
      await value('2750');
      const issues = await rows(s, 'wms_issue_fragments', 'AND order_id=$2', [s.order.id]);
      assert.equal(issues.length, 1);
      assert.equal(issues[0].layer_id, s.bo_layer.id);
      assert.equal(issues[0].quantity, 8);
      assert.equal(issues[0].unit_cost_minor, '100');
      assert.equal(issues[0].value_minor, '800');
      const shipped = await api('/orders/' + s.order.id);
      assert.equal(shipped.status, 'shipped');
      s.return_create = {
        client_key: randomUUID(),
        reason: 'QA112 extended częściowy zwrot jednego z czterech zestawów',
        items: [{ item_id: shipped.items[0].id, quantity: 1 }],
      };
      await save(s);
      s.return_case = await api(
        '/orders/' + s.order.id + '/returns',
        'POST',
        s.return_create,
        [200, 201],
      );
      s.return_receive = {
        version: Number(s.return_case.version),
        shipping_refund: 0,
        note: 'QA112 extended zwrot dwóch fizycznych sztuk z pierwotnym kosztem BO100',
        items: [{ item_id: s.return_case.items[0].item_id, accepted: 1, restocked: 1 }],
        wms_lots: {
          client_key: randomUUID(),
          policy_version: '1',
          stock_versions: await stockVersions(s),
          picks: [{ issue_fragment_id: issues[0].id, quantity: 2, location: 'ZWROT' }],
        },
      };
      await save(s);
      await api('/returns/' + s.return_case.id + '/receive', 'POST', s.return_receive);
      const returnSnapshot = await snapshot(s, effects);
      await api('/returns/' + s.return_case.id + '/receive', 'POST', s.return_receive);
      assert.deepEqual(await snapshot(s, effects), returnSnapshot);
      await expectStock(s, 14, 0);
      s.final_valuation = await value('2950');
      const returned = await rows(s, 'wms_return_fragments', 'AND return_id=$2', [
        s.return_case.id,
      ]);
      assert.equal(returned.length, 1);
      assert.equal(returned[0].issue_fragment_id, issues[0].id);
      assert.equal(returned[0].layer_id, s.bo_layer.id);
      assert.equal(returned[0].quantity, 2);
      assert.equal(returned[0].value_minor, '200');
      const immutableCosts = await rows(
        s,
        'wms_cost_layers',
        'AND id=ANY($2::uuid[]) ORDER BY id',
        [[s.bo_layer.id, ...s.receipts.map((r: Json) => r.layer.id)]],
      );
      assert.equal(immutableCosts.length, 3);
      for (const original of [s.bo_layer, ...s.receipts.map((r: Json) => r.layer)])
        assert.deepEqual(
          JSON.parse(JSON.stringify(immutableCosts.find((l) => l.id === original.id))),
          JSON.parse(JSON.stringify(original)),
        );
      await waitJobs(s);
      s.api_acceptance = {
        status: 'PASS',
        physical_lines: 4,
        bo_quantity: 10,
        bo_cost_minor: '100',
        pz_receipts: 2,
        pz_costs_minor: ['200', '300'],
        same_lot_in_two_bins: true,
        reserved_before_post: 8,
        scanned_before_post: 1,
        reservation_preserved_exact: true,
        shortage_quantity: 1,
        shortage_value_minor: '100',
        surplus_quantity: 1,
        surplus_value_minor: '250',
        stock_version_bumps: 1,
        dispatch_quantity: 8,
        dispatch_cost_minor: '800',
        partial_return_physical_quantity: 2,
        partial_return_value_minor: '200',
        returned_original_cost_minor: '100',
        final_quantity: 14,
        final_known_minor: '2950',
        exact_retry_effect_free: true,
        no_issue_at_packed_or_label: true,
        shipping_simulation: true,
        provider_verified: false,
      };
      s.preservation_after_api = await immutableInputs(s);
      await checkpoint(s);
      await report({
        stage: 112,
        extension: s.extension,
        ...s.api_acceptance,
        revision: expected,
        schema: s.schema,
        tenant: s.tenant,
        stocktake: s.stocktake.id,
        order: s.order.id,
        immutable_checkpoint_tables: s.own_names.length,
        ui: 'PENDING_SEPARATE_ROOT_EVIDENCE',
        restart: 'PENDING',
        restore: 'PENDING',
        baseline_rebased: false,
        goal_complete: false,
      });
    } else if (phase === 'ui-checkpoint') {
      assert.equal(
        process.env.QA_EXTENDED_UI_VERIFIED,
        'true',
        'Root must attest the actual extended UI interaction',
      );
      assert(s.api_acceptance?.status === 'PASS' && !s.ui_verified && !s.restart_verified);
      activeState = s;
      const me = (await api('/auth/me')).user;
      assert(
        me.id === s.user && me.tenant_id === s.tenant && me.role === 'admin',
        'Exact own administrator cookie required',
      );
      const names = s.own_names.filter((name: string) => name !== 'sessions');
      assert.deepEqual(
        await snapshot(s, names),
        Object.fromEntries(Object.entries(s.own_snapshot).filter(([name]) => name !== 'sessions')),
        'Actual UI must not alter accepted non-session data',
      );
      // The original API phase has one signup session. UI may add sessions of that same user/firm only.
      assert.equal(
        s.own_snapshot.sessions.count,
        1,
        'Original API session set must be identifiable, never silently rebased',
      );
      assert(s.cookie.startsWith('dyna_session='));
      const token = decodeURIComponent(s.cookie.slice(s.cookie.indexOf('=') + 1));
      const originalHash = createHash('sha256').update(token).digest('hex');
      const c = await pool.connect();
      let additionalSessions = 0;
      try {
        await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await c.query("SET LOCAL TIME ZONE 'UTC'");
        const sessions = (
          await c.query('SELECT to_jsonb(t) row FROM sessions t WHERE tenant_id=$1 ORDER BY 1', [
            s.tenant,
          ])
        ).rows;
        const original = sessions.filter((r) => r.row.token_hash === originalHash);
        assert.equal(original.length, 1);
        assert.equal(
          sha(original),
          s.own_snapshot.sessions.sha256,
          'Original API session remains exactly unchanged',
        );
        assert(
          sessions.every((r) => r.row.user_id === s.user && r.row.tenant_id === s.tenant),
          'All added UI sessions must belong to the exact accepted administrator',
        );
        additionalSessions = sessions.length - original.length;
        assert(
          additionalSessions >= 1 && additionalSessions <= 10,
          'Explicit own UI login sessions required; no unbounded session allowance',
        );
        await c.query('COMMIT');
      } finally {
        await c.query('ROLLBACK').catch(() => {});
        c.release();
      }
      assert.equal((await allPages(prefix + '/' + s.stocktake.id + '/lines')).length, 4);
      assert.equal((await api(prefix + '/' + s.stocktake.id)).stocktake.state, 'posted');
      assert.equal(
        (await api(prefix + '/' + s.stocktake.id + '/posting')).posting.id,
        s.posting.id,
      );
      await expectStock(s, 14, 0);
      await value('2950');
      s.preservation_after_ui = await immutableInputs(s);
      s.ui_verified = true;
      s.ui_attestation = {
        root_manual_ui: true,
        verified_at: new Date().toISOString(),
        non_session_checkpoint_exact: true,
        original_api_session_exact: true,
        extra_own_ui_sessions: additionalSessions,
        physical_lines: 4,
        posted: true,
        quantity: 14,
        known_minor: '2950',
      };
      s.restart_verified = false;
      await checkpoint(s);
      await report({
        stage: 112,
        extension: s.extension,
        ...s.api_acceptance,
        status: 'UI_PASS',
        revision: expected,
        schema: s.schema,
        tenant: s.tenant,
        ui: 'PASS',
        ui_attestation: s.ui_attestation,
        native_api_status: s.api_acceptance.status,
        restart: 'PENDING',
        restore: 'PENDING',
        baseline_rebased: false,
        goal_complete: false,
      });
    } else {
      activeState = s;
      s.preservation_before_phase = await immutableInputs(s);
      assert(s.api_acceptance?.status === 'PASS' && !s.restart_verified);
      assert.deepEqual(
        await snapshot(s, s.own_names),
        s.own_snapshot,
        'Extended own checkpoint changed before restart login',
      );
      const login = await api('/auth/login', 'POST', { email: s.email, password: s.password });
      assert.equal(login.user.tenant_id, s.tenant);
      await expectStock(s, 14, 0);
      await value('2950');
      assert.equal((await api(prefix + '/' + s.stocktake.id)).stocktake.state, 'posted');
      assert.equal((await api('/orders/' + s.order.id)).status, 'shipped');
      assert.equal((await allPages(prefix + '/' + s.stocktake.id + '/lines')).length, 4);
      assert.equal(
        (await api(prefix + '/' + s.stocktake.id + '/posting')).posting.id,
        s.posting.id,
      );
      s.restart_verified = true;
      s.preservation_after_restart = await immutableInputs(s);
      await checkpoint(s);
      await report({
        stage: 112,
        extension: s.extension,
        ...s.api_acceptance,
        revision: expected,
        schema: s.schema,
        tenant: s.tenant,
        restart: 'PASS',
        checkpoint_exact_before_login: true,
        ui: s.ui_verified ? 'PASS' : 'PENDING_SEPARATE_ROOT_EVIDENCE',
        restore: 'PENDING',
        baseline_rebased: false,
        goal_complete: false,
      });
    }
  }
  console.log({
    phase,
    status:
      phase === 'setup'
        ? 'SETUP_PASS'
        : phase === 'api'
          ? 'API_PASS'
          : phase === 'readback'
            ? 'READBACK_ONLY'
            : phase === 'ui-checkpoint'
              ? 'UI_PASS'
              : 'RESTART_PASS',
  });
} catch (error) {
  if (activeState) {
    await report({
      stage: 112,
      extension: activeState.extension,
      status: 'INCOMPLETE_REQUIRES_READBACK',
      phase,
      revision: activeState.runtime_revision,
      schema: activeState.schema,
      tenant: activeState.tenant ?? null,
      last_write_path: activeState.last_write?.path ?? null,
      error_type: error instanceof Error ? error.name : 'UnknownError',
      automatic_resume: false,
      provider_verified: false,
      goal_complete: false,
    });
  }
  throw error;
} finally {
  await pool.end();
}
