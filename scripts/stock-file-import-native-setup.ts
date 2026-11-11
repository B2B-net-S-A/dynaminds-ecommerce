/** ROOT-ONLY QA132 fixture author. setup once, or explicit recover-warehouse-limit
 * only for the independently read-back terminal OFF warehouse409. Never imports.
 * Successful setup has122 mutations including4 local-estimate billing calls.
 * Every mutation has a durable pending record, then a durable successful response,
 * then durable assigned business IDs before pending is cleared. No automatic replay. */
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { open, lstat, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
type Row = Record<string, any>;
type Receipt = {
  actor: string;
  key: string;
  path: string;
  method: string;
  status: number;
  response: unknown;
  cookie?: string;
  completed_at: string;
};
const statePath = 'data/stock-file-import-stage132.json';
const manifestPath = 'docs/stock-file-import-source-evidence-manifest.json';
const artifacts = [
  'docs/stock-file-import-native-off.csv',
  'docs/stock-file-import-native-on.csv',
  'docs/stock-file-import-native-off-resolutions.json',
  'docs/stock-file-import-native-on-resolutions.json',
];
const reportPath = 'docs/stock-file-import-native-setup-qa.json';
const rejectedReadbackPath = 'docs/stock-file-import-native-rejected-warehouse-readback.json';
const recoveryOriginalPath = 'data/stock-file-import-stage132-before-warehouse-recovery.json';
const api = 'http://127.0.0.1:4100/api';
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const bytesHash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
let db: Pool | undefined;
let state: Row | undefined;
async function absent(path: string) {
  try {
    await lstat(path);
    throw new Error('Refuse existing owned fixture: ' + path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}
async function syncDirectory(path: string) {
  const f = await open(dirname(resolve(path)), constants.O_RDONLY);
  try {
    await f.sync();
  } finally {
    await f.close();
  }
}
async function save(s: Row, initial = false) {
  const content = JSON.stringify(s, null, 2) + '\n';
  if (initial) {
    const f = await open(
      statePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await f.writeFile(content);
      await f.sync();
    } finally {
      await f.close();
    }
    await syncDirectory(statePath);
    return;
  }
  const existing = await lstat(statePath);
  assert(
    existing.isFile() && !existing.isSymbolicLink() && (existing.mode & 0o777) === 0o600,
    'Private fixture must remain an owned regular0600 file',
  );
  const temp = statePath + '.write-' + randomUUID();
  const f = await open(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await f.writeFile(content);
    await f.sync();
  } finally {
    await f.close();
  }
  try {
    await rename(temp, statePath);
    await syncDirectory(statePath);
  } catch (e) {
    await unlink(temp).catch(() => {});
    throw e;
  }
}
async function health() {
  const r = await fetch(api + '/health', { redirect: 'error', signal: AbortSignal.timeout(10000) });
  assert.equal(r.status, 200);
  const h = (await r.json()) as Row;
  assert.equal(h.status, 'ok');
  assert.equal(h.mode, 'local');
  assert.equal(h.revision, process.env.QA_EXPECTED_REVISION);
  assert.equal(h.schema_revision, '115_stock_file_imports');
  for (const feature of [
    'stock_file_import_available',
    'inventory_bulk_edit_available',
    'wms_lots_available',
    'wms_stocktakes_available',
  ])
    assert.equal(h[feature], true);
  assert.equal(h.restore_preview, false);
  assert.equal(h.background_workers_enabled, false);
  return h;
}
async function fetchOwn(s: Row, path: string, method = 'GET', body?: unknown) {
  const response = await fetch(api + path, {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
    headers: {
      ...(s.cookie ? { cookie: s.cookie } : {}),
      ...(s.tenant ? { 'X-Workspace-ID': s.tenant } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  const text = await response.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = { non_json_response: text };
  }
  return { response, data, cookie };
}
async function readOwn(s: Row, path: string) {
  const { response, data } = await fetchOwn(s, path);
  assert.equal(response.status, 200, 'Unexpected local GET status: ' + path);
  return data as Row;
}
async function mutate(
  s: Row,
  actor: Row,
  key: string,
  path: string,
  method: string,
  body: unknown,
  expected: number,
  apply: (result: Row) => void,
) {
  assert.equal(s.pending, null, 'An uncertain mutation cannot be dispatched or replayed');
  assert(
    !s.completed.some((r: Receipt) => r.key === key),
    'A completed mutation cannot be replayed',
  );
  s.pending = {
    actor: actor.mode,
    key,
    path,
    method,
    body,
    expected,
    started_at: new Date().toISOString(),
  };
  await save(s);
  const { response, data, cookie } = await fetchOwn(actor, path, method, body);
  if (response.status !== expected) {
    s.pending.observed = { status: response.status, response: data, cookie: cookie ?? null };
    await save(s);
    throw new Error('Unexpected local mutation status: ' + path + ' ' + response.status);
  }
  const receipt: Receipt = {
    actor: actor.mode,
    key,
    path,
    method,
    status: response.status,
    response: data,
    ...(cookie ? { cookie } : {}),
    completed_at: new Date().toISOString(),
  };
  s.completed.push(receipt);
  s.pending.received = receipt;
  if (cookie) actor.cookie = cookie;
  // Keep pending present while the complete successful response is durably recorded.
  await save(s);
  apply(data as Row);
  await save(s);
  s.pending = null;
  await save(s);
  return data as Row;
}
async function checkpoint(tenants: string[], users: string[]) {
  assert(db);
  const c = await db.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TimeZone='UTC'");
    const names: string[] = (
      await c.query(
        `SELECT t.table_name FROM information_schema.tables t JOIN information_schema.columns k USING(table_schema,table_name) WHERE t.table_schema='public' AND t.table_type='BASE TABLE' AND k.column_name='tenant_id' AND t.table_name<>'sessions' UNION SELECT 'users' UNION SELECT 'tenants' ORDER BY 1`,
      )
    ).rows.map((r) => r.table_name);
    const tables: Row = {},
      rows: Row = {};
    for (const name of names) {
      assert.match(name, /^[a-z_][a-z0-9_]*$/);
      const key = ['users', 'tenants'].includes(name) ? 'id' : 'tenant_id';
      const data = (
        await c.query(
          `SELECT to_jsonb(t) row FROM "${name}" t WHERE ${key}=ANY($1::uuid[]) ORDER BY 1`,
          [name === 'users' ? users : tenants],
        )
      ).rows;
      tables[name] = { count: data.length, sha256: hash(data) };
      rows[name] = data.map((r) => r.row);
    }
    await c.query('COMMIT');
    return { tables, rows };
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}
async function sourceManifest() {
  const bytes = await readFile(manifestPath),
    manifest = JSON.parse(bytes.toString()) as Row;
  assert.equal(manifest.stage, 132);
  assert.equal(manifest.source.length, 26);
  assert.equal(manifest.gates.module.fail, 0);
  assert.equal(manifest.gates.compatibility.fail, 0);
  for (const entry of manifest.source as Row[]) {
    assert.equal(typeof entry.path, 'string');
    assert(!entry.path.startsWith('/') && !entry.path.split('/').includes('..'));
    assert.equal(
      bytesHash(await readFile(entry.path)),
      entry.sha256,
      'Accepted source hash changed: ' + entry.path,
    );
  }
  return { path: manifestPath, sha256: bytesHash(bytes), source_count: 26 };
}
async function establishActor(s: Row, mode: 'off' | 'on', suffix: string) {
  assert(db);
  const actor: Row = {
    mode,
    email: `qa132-stock-${mode}-${suffix}@demo.local`,
    password: `DynaQa132!${randomUUID()}`,
    products: [],
    warehouses: [],
    lots: [],
  };
  s[mode] = actor;
  await save(s);
  await mutate(
    s,
    actor,
    mode + '-signup',
    '/auth/signup',
    'POST',
    {
      email: actor.email,
      password: actor.password,
      name: `QA132 stock ${mode.toUpperCase()}`,
      organization: {
        name: `QA132 Physical ${mode.toUpperCase()} ${suffix}`,
        currency: 'PLN',
        locale: 'pl-PL',
      },
    },
    201,
    (r) => {
      actor.user = r.user.id;
      actor.tenant = r.user.tenant_id;
      assert.equal(r.user.role, 'admin');
    },
  );
  await completeActorSetup(s, actor, suffix);
}
async function completeActorSetup(s: Row, actor: Row, suffix: string) {
  assert(db);
  const mode = actor.mode as 'off' | 'on';
  const auth = await readOwn(actor, '/auth/me');
  assert.equal(auth.id ?? auth.user?.id, actor.user);
  assert.equal(auth.tenant_id ?? auth.user?.tenant_id, actor.tenant);
  const first = await readOwn(actor, '/warehouses');
  assert.equal(first.data.length, 1);
  if (actor.warehouse) assert.equal(first.data[0].id, actor.warehouse);
  actor.warehouse = first.data[0].id;
  actor.warehouses = [first.data[0]];
  await save(s);
  const billing = await readOwn(actor, '/workspaces/billing');
  assert.equal(billing.mode, 'local_estimate');
  assert.equal(billing.admin, true);
  assert.equal(billing.account, null);
  assert.equal(billing.current_plan, 'starter');
  assert.equal(billing.entries.length, 0);
  const enterprise = billing.plans.find((p: Row) => p.plan === 'enterprise');
  assert(enterprise && enterprise.limits.warehouses >= 2);
  await mutate(
    s,
    actor,
    mode + '-billing-preview',
    '/workspaces/billing/preview',
    'POST',
    { kind: 'activate', plan: 'enterprise' },
    200,
    (p) => {
      assert.equal(p.mode, 'local_estimate');
      assert.equal(p.actor_id, actor.user);
      assert.equal(p.tenant_id, actor.tenant);
      assert.equal(p.kind, 'activate');
      assert.equal(p.before_plan, 'starter');
      assert.equal(p.terms.plan, 'enterprise');
      assert.equal(p.can_commit, true);
      assert.deepEqual(p.blockers, []);
      assert(p.id);
      actor.billing_preview = p;
    },
  );
  await mutate(
    s,
    actor,
    mode + '-billing-commit',
    `/workspaces/billing/previews/${actor.billing_preview.id}/commit`,
    'POST',
    {},
    200,
    (r) => {
      assert.equal(r.mode, 'local_estimate');
      assert.equal(r.plan, 'enterprise');
      actor.billing_result = r;
    },
  );
  const activated = await readOwn(actor, '/workspaces/billing');
  assert.equal(activated.mode, 'local_estimate');
  assert.equal(activated.current_plan, 'enterprise');
  assert.equal(activated.account.plan, 'enterprise');
  assert.equal(activated.entries.length, 1);
  assert.equal(activated.entries[0].tenant_id, actor.tenant);
  await mutate(
    s,
    actor,
    mode + '-warehouse',
    '/warehouses',
    'POST',
    { name: `QA132 ${mode.toUpperCase()} Second`, code: `QA132-${mode.toUpperCase()}-2` },
    200,
    (r) => {
      actor.second_warehouse = r.id;
      actor.warehouses.push(r);
    },
  );
  for (let i = 0; i < 53; i++)
    await mutate(
      s,
      actor,
      mode + '-product-' + i,
      '/products',
      'POST',
      {
        sku: `000132-${mode}-${suffix}-${String(i).padStart(3, '0')}`,
        name: `QA132 ${mode.toUpperCase()} Physical ${String(i).padStart(3, '0')}`,
        price: 2500,
        vat: 23,
        quantity: 10,
        location: 'A-01',
        warehouse_id: actor.warehouse,
        category: 'QA132',
      },
      201,
      (p) => {
        assert(p.id && p.version);
        actor.products.push(p);
      },
    );
  await mutate(
    s,
    actor,
    mode + '-receipt-create',
    '/warehouse-documents',
    'POST',
    {
      kind: 'receipt',
      warehouse_id: actor.second_warehouse,
      reference: `QA132 ${mode} genuine second warehouse stock`,
      lines: actor.products.map((p: Row) => ({ product_id: p.id, quantity: 3, location: 'A-01' })),
    },
    201,
    (r) => {
      actor.receipt = r;
    },
  );
  await mutate(
    s,
    actor,
    mode + '-receipt-post',
    `/warehouse-documents/${actor.receipt.id}/post`,
    'POST',
    { version: actor.receipt.version },
    200,
    (r) => {
      actor.receipt_post = r;
    },
  );
  if (mode === 'on') {
    const c = await db.connect();
    let stocks: Row[];
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await c.query("SET LOCAL TimeZone='UTC'");
      stocks = (
        await c.query(
          'SELECT product_id,warehouse_id,on_hand,reserved,version FROM stock WHERE tenant_id=$1 ORDER BY warehouse_id,product_id',
          [actor.tenant],
        )
      ).rows;
      await c.query('COMMIT');
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
    assert.equal(stocks.length, 106);
    await mutate(
      s,
      actor,
      mode + '-opening-preview',
      '/wms-lots/opening-previews',
      'POST',
      {
        client_key: randomUUID(),
        policy_version: '0',
        currency: 'PLN',
        note: 'QA132 explicit cost opening; unknown and zero preserved',
        lines: stocks.map((stock) => {
          const i = actor.products.findIndex((p: Row) => p.id === stock.product_id);
          assert(i >= 0);
          assert.equal(stock.reserved, 0);
          return {
            warehouse_id: stock.warehouse_id,
            product_id: stock.product_id,
            location: 'A-01',
            quantity: stock.on_hand,
            stock_version: String(stock.version),
            lot_code: `QA132-${suffix}-${i}-${stock.warehouse_id === actor.warehouse ? '1' : '2'}`,
            unit_cost_minor: i === 1 ? null : i === 2 ? '0' : '317',
          };
        }),
      },
      201,
      (r) => {
        assert.equal(r.preview.ready, true);
        actor.opening_preview = r.preview;
      },
    );
    await mutate(
      s,
      actor,
      mode + '-opening-activate',
      `/wms-lots/opening-previews/${actor.opening_preview.id}/activate`,
      'POST',
      {
        client_key: randomUUID(),
        scope_hash: actor.opening_preview.scope_hash,
        confirmed: true,
        ack_unknown_costs: true,
      },
      201,
      (r) => {
        actor.opening_activation = r;
      },
    );
  }
  await mutate(
    s,
    actor,
    mode + '-reservation-order',
    '/orders',
    'POST',
    {
      customer_name: `QA132 ${mode.toUpperCase()} Reserved original customer`,
      email: `qa132-${mode}@example.test`,
      phone: '500600700',
      payment_mode: 'cod',
      warehouse_id: actor.warehouse,
      address: {
        street: 'Testowa',
        building_number: '132',
        city: 'Warszawa',
        post_code: '00-001',
        country: 'PL',
      },
      items: [{ product_id: actor.products[0].id, quantity: 4 }],
    },
    201,
    (r) => {
      actor.reservation_order = r;
    },
  );
  const options = await readOwn(actor, '/stock-file-imports/options');
  assert.equal(options.available, true);
  assert.equal(options.policy.enabled, mode === 'on');
  assert.equal(options.can_write, true);
  assert.equal(options.can_read_value, true);
  assert.equal(options.warehouses.length, 2);
  assert.equal(options.next_cursor, null);
  actor.policy = options.policy;
  const own = await checkpoint([actor.tenant], [actor.user]);
  assert.equal(own.rows.products.length, 53);
  assert.equal(own.rows.stock.length, 106);
  assert.equal(own.rows.stock_locations.length, 106);
  for (const stock of own.rows.stock as Row[]) {
    assert(actor.products.some((p: Row) => p.id === stock.product_id));
    assert.equal(stock.on_hand, stock.warehouse_id === actor.warehouse ? 10 : 3);
    assert.equal(
      stock.reserved,
      stock.warehouse_id === actor.warehouse && stock.product_id === actor.products[0].id ? 4 : 0,
    );
  }
  assert.equal(own.rows.orders.length, 1);
  assert.equal(own.rows.order_items.length, 1);
  assert.equal(own.rows.order_items[0].quantity, 4);
  for (const name of [
    'stock_file_import_previews',
    'stock_file_import_executions',
    'stock_file_import_profiles',
    'stock_file_import_profile_revisions',
    'stock_file_import_admissions',
    'stock_file_import_core_witnesses',
    'inventory_bulk_edit_previews',
    'inventory_bulk_edit_executions',
    'wms_stocktakes',
    'wms_stocktake_lines',
    'wms_stocktake_postings',
    'wms_issue_fragments',
    'wms_return_fragments',
    'payment_entries',
    'shipments',
  ])
    assert.equal(
      own.rows[name].length,
      0,
      'Setup cannot create import, fulfillment or payment: ' + name,
    );
  if (mode === 'on') {
    assert.equal(own.rows.wms_lots.length, 106);
    assert.equal(own.rows.wms_cost_layers.length, 106);
    assert.equal(own.rows.wms_layer_positions.length, 106);
    assert.equal(own.rows.wms_policies[0].enabled, true);
    actor.lots = own.rows.wms_layer_positions.map((pos: Row) => {
      const layer = own.rows.wms_cost_layers.find((l: Row) => l.id === pos.layer_id);
      assert(layer);
      return {
        product_id: pos.product_id,
        warehouse_id: pos.warehouse_id,
        location: pos.location,
        lot_id: layer.lot_id,
        layer_id: layer.id,
        unit_cost_minor: layer.unit_cost_minor === null ? null : String(layer.unit_cost_minor),
        currency: layer.currency,
      };
    });
  } else
    for (const name of [
      'wms_lots',
      'wms_cost_layers',
      'wms_layer_positions',
      'wms_reservation_layers',
      'wms_operations',
    ])
      assert.equal(own.rows[name].length, 0);
  actor.expected_after = {
    positions: 106,
    changed: 106,
    warehouse_quantities: { [actor.warehouse]: 8, [actor.second_warehouse]: 5 },
    reserved_product_id: actor.products[0].id,
    reserved_quantity: 4,
    unknown_loss_quantity: mode === 'on' ? 2 : 0,
    surplus_quantity: mode === 'on' ? 106 : 0,
    known_loss_minor: mode === 'on' ? '32334' : null,
    known_surplus_minor: mode === 'on' ? '53000' : null,
    ack_unknown_loss_warehouse_ids: mode === 'on' ? [actor.warehouse] : [],
    ack_surplus_warehouse_ids: mode === 'on' ? [actor.second_warehouse] : [],
    protected_customer_order_id: actor.reservation_order.id,
  };
  const columns =
    mode === 'on'
      ? [
          'Kod',
          'W1',
          'W2',
          'Loc1',
          'Loc2',
          'Lot1',
          'Lot2',
          'Koszt1',
          'Koszt2',
          'Waluta1',
          'Waluta2',
        ]
      : ['Kod', 'W1', 'W2', 'Loc1', 'Loc2'];
  const csv =
    columns.join(';') +
    '\r\n' +
    actor.products
      .map((p: Row) => {
        const base = [p.sku, '8', '5', 'A-01', 'A-01'];
        if (mode === 'on')
          for (const w of [actor.warehouse, actor.second_warehouse]) {
            const lot = actor.lots.find((l: Row) => l.product_id === p.id && l.warehouse_id === w);
            assert(lot);
            base.push(lot.lot_id);
          }
        if (mode === 'on') base.push('500', '500', 'PLN', 'PLN');
        return base.join(';');
      })
      .join('\r\n') +
    '\r\n';
  actor.definition = {
    format: 'csv',
    xml_mode: 'positions',
    delimiter: ';',
    identity: 'sku',
    identity_field: 'Kod',
    spreadsheet_safe: false,
    empty_policy: 'error',
  };
  actor.targets = [actor.warehouse, actor.second_warehouse]
    .map((warehouse_id: string, i: number) => ({
      warehouse_id,
      quantity_scope: 'position',
      mapping: {
        quantity: i === 0 ? 'W1' : 'W2',
        location: i === 0 ? 'Loc1' : 'Loc2',
        ...(mode === 'on'
          ? {
              lot_id: i === 0 ? 'Lot1' : 'Lot2',
              unit_cost_minor: i === 0 ? 'Koszt1' : 'Koszt2',
              currency: i === 0 ? 'Waluta1' : 'Waluta2',
            }
          : {}),
      },
      default_location: null,
    }))
    .sort((a: Row, b: Row) => a.warehouse_id.localeCompare(b.warehouse_id));
  actor.resolutions = actor.products
    .flatMap((p: Row, source_index: number) =>
      [actor.warehouse, actor.second_warehouse].map((warehouse_id: string, i: number) => ({
        source_index,
        warehouse_id,
        positions: [
          {
            location: 'A-01',
            lot:
              mode === 'on'
                ? {
                    kind: 'existing',
                    lot_id: actor.lots.find(
                      (l: Row) => l.product_id === p.id && l.warehouse_id === warehouse_id,
                    ).lot_id,
                  }
                : null,
            quantity: i === 0 ? 8 : 5,
            unit_cost_minor: mode === 'on' ? '500' : null,
            currency: mode === 'on' ? 'PLN' : null,
          },
        ],
      })),
    )
    .sort(
      (a: Row, b: Row) =>
        a.source_index - b.source_index || a.warehouse_id.localeCompare(b.warehouse_id),
    );
  const csvPath = `docs/stock-file-import-native-${mode}.csv`,
    resolutionPath = `docs/stock-file-import-native-${mode}-resolutions.json`;
  const resolutionBytes = JSON.stringify(actor.resolutions, null, 2) + '\n';
  await writeFile(csvPath, csv, { flag: 'wx' });
  await writeFile(resolutionPath, resolutionBytes, { flag: 'wx' });
  actor.files = {
    csv: { path: csvPath, sha256: bytesHash(csv), bytes: Buffer.byteLength(csv) },
    resolutions: {
      path: resolutionPath,
      sha256: bytesHash(resolutionBytes),
      bytes: Buffer.byteLength(resolutionBytes),
    },
  };
  s.setup_checkpoint[mode] = own.tables;
  s.setup_rows[mode] = own.rows;
  s.files[mode] = actor.files;
  await save(s);
}
async function recoverRejectedWarehouse(manifest: Row, h: Row) {
  assert(db);
  await absent(recoveryOriginalPath);
  const st = await lstat(statePath);
  assert(st.isFile() && !st.isSymbolicLink() && (st.mode & 0o777) === 0o600);
  assert(st.size > 0 && st.size <= 32 * 1024 * 1024);
  const original = await readFile(statePath),
    s: Row = JSON.parse(original.toString());
  state = s;
  assert.equal(s.stage, 132);
  assert.equal(s.setup_complete, false);
  assert.equal(s.revision, h.revision);
  assert.equal(s.schema_revision, h.schema_revision);
  assert.deepEqual(s.source_manifest, manifest);
  assert.equal(s.completed.length, 1);
  assert.equal(s.on, null);
  assert.deepEqual(s.setup_checkpoint, {});
  assert.deepEqual(s.setup_rows, {});
  assert.deepEqual(s.files, {});
  assert(!s.recovery_original && (!s.rejected || s.rejected.length === 0));
  const actor: Row = s.off,
    pending: Row = s.pending,
    signup: Row = s.completed[0];
  assert(actor && actor.mode === 'off' && actor.user && actor.tenant && actor.cookie);
  assert.deepEqual(actor.products, []);
  assert.deepEqual(actor.lots, []);
  assert.equal(actor.warehouses.length, 1);
  assert.equal(actor.warehouse, actor.warehouses[0].id);
  assert(!actor.second_warehouse && !actor.billing_preview && !actor.billing_result);
  const suffix = /^qa132-stock-off-([a-f0-9]{8})@demo\.local$/.exec(actor.email)?.[1];
  assert(suffix, 'Expected exact synthetic OFF account');
  assert.equal(signup.actor, 'off');
  assert.equal(signup.key, 'off-signup');
  assert.equal(signup.path, '/auth/signup');
  assert.equal(signup.method, 'POST');
  assert.equal(signup.status, 201);
  assert.equal(signup.response.user.id, actor.user);
  assert.equal(signup.response.user.tenant_id, actor.tenant);
  assert.equal(signup.response.user.role, 'admin');
  assert(pending && !pending.received, 'Only terminal observed409 may be recovered');
  assert.equal(pending.actor, 'off');
  assert.equal(pending.key, 'off-warehouse');
  assert.equal(pending.path, '/warehouses');
  assert.equal(pending.method, 'POST');
  assert.equal(pending.expected, 200);
  assert.deepEqual(pending.body, { name: 'QA132 OFF Second', code: 'QA132-OFF-2' });
  assert.equal(pending.observed?.status, 409);
  assert.equal(pending.observed?.response?.status, 409);
  assert.equal(
    pending.observed?.response?.detail,
    'Limit planu: magazyny. Wykorzystano 1, limit 1.',
  );
  const independent: Row = JSON.parse(await readFile(rejectedReadbackPath, 'utf8'));
  assert.equal(independent.status, 'PASS');
  assert.equal(independent.phase, 'read_only_reconciliation_of_rejected_warehouse');
  assert.equal(independent.private_journal_sha256, bytesHash(original));
  assert.equal(independent.prior_checkpoint_sha256, hash(s.prior_checkpoint));
  assert.equal(independent.second_warehouse_created, false);
  assert.equal(independent.products_created, 0);
  assert.equal(independent.billing_account_created, false);
  assert.equal(independent.pending_preserved, true);
  const priorTenants: string[] = s.prior_tenant_ids,
    priorUsers: string[] = s.prior_user_ids;
  assert(priorTenants.length > 0 && priorUsers.length > 0);
  assert.equal(new Set(priorTenants).size, priorTenants.length);
  assert.equal(new Set(priorUsers).size, priorUsers.length);
  assert(!priorTenants.includes(actor.tenant) && !priorUsers.includes(actor.user));
  const actualTenants: string[] = (await db.query('SELECT id FROM tenants ORDER BY id')).rows.map(
    (r) => r.id,
  );
  const actualUsers: string[] = (await db.query('SELECT id FROM users ORDER BY id')).rows.map(
    (r) => r.id,
  );
  assert.deepEqual(actualTenants, [...priorTenants, actor.tenant].sort());
  assert.deepEqual(actualUsers, [...priorUsers, actor.user].sort());
  assert.deepEqual(
    (await checkpoint(priorTenants, priorUsers)).tables,
    s.prior_checkpoint,
    'All original tenant/user fingerprints must match before recovery writes',
  );
  assert.equal(independent.prior_firms, priorTenants.length);
  assert.equal(independent.prior_tables_verified, Object.keys(s.prior_checkpoint).length);
  const auth = await readOwn(actor, '/auth/me');
  assert.equal(auth.id ?? auth.user?.id, actor.user);
  assert.equal(auth.tenant_id ?? auth.user?.tenant_id, actor.tenant);
  assert.equal(auth.role ?? auth.user?.role, 'admin');
  const warehouses = await readOwn(actor, '/warehouses');
  assert.equal(warehouses.data.length, 1);
  assert.equal(warehouses.data[0].id, actor.warehouse);
  assert(!warehouses.data.some((w: Row) => w.code === pending.body.code));
  const products = await readOwn(actor, '/products');
  assert.deepEqual(products.data, []);
  const billing = await readOwn(actor, '/workspaces/billing');
  assert.equal(billing.mode, 'local_estimate');
  assert.equal(billing.admin, true);
  assert.equal(billing.current_plan, 'starter');
  assert.equal(billing.account, null);
  assert.equal(billing.entries.length, 0);
  assert.equal(billing.usage.warehouses, 1);
  const own = await checkpoint([actor.tenant], [actor.user]);
  assert.equal(own.tables.warehouses.count, 1);
  for (const table of Object.keys(own.tables).filter(
    (t) =>
      t.startsWith('workspace_billing_') ||
      t.startsWith('stock_file_import_') ||
      ['products', 'stock', 'stock_locations', 'orders'].includes(t),
  ))
    assert.equal(own.tables[table].count, 0, 'Unexpected pre-recovery own row: ' + table);
  assert.deepEqual((await checkpoint(priorTenants, priorUsers)).tables, s.prior_checkpoint);
  assert.equal(bytesHash(await readFile(statePath)), bytesHash(original));
  await health();
  // Preserve the exact failed journal bytes and definitive rejection before clearing pending.
  const backup = await open(
    recoveryOriginalPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await backup.writeFile(original);
    await backup.sync();
  } finally {
    await backup.close();
  }
  await syncDirectory(recoveryOriginalPath);
  s.recovery_original = {
    path: recoveryOriginalPath,
    bytes: original.length,
    sha256: bytesHash(original),
    readback_path: rejectedReadbackPath,
    readback_sha256: bytesHash(await readFile(rejectedReadbackPath)),
  };
  s.rejected = [
    {
      ...pending,
      resolved_as: 'definitive_starter_warehouse_limit_1',
      resolved_at: new Date().toISOString(),
      no_warehouse_created: true,
    },
  ];
  await save(s);
  s.pending = null;
  await save(s);
  return { s, suffix };
}
try {
  const phase = process.argv[2];
  assert(phase === 'setup' || phase === 'recover-warehouse-limit');
  assert.notEqual(process.env.DYNA_TEST, 'true');
  assert.equal(process.env.DYNA_WORKER_DISABLED, 'true');
  assert.match(process.env.QA_EXPECTED_REVISION ?? '', /^[a-f0-9]{40}$/);
  for (const path of [reportPath, ...artifacts]) await absent(path);
  if (phase === 'setup') {
    await absent(statePath);
    await absent(recoveryOriginalPath);
  }
  const config = await lstat(resolve(process.env.DYNA_LOCAL_CONFIG_PATH ?? '.local.json'));
  assert(config.isFile() && !config.isSymbolicLink());
  if (process.env.DATABASE_URL) {
    const url = new URL(process.env.DATABASE_URL);
    assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
    assert.equal(url.pathname, '/dynaminds');
  }
  const manifest = await sourceManifest();
  db = (await import('../server/db')).pool;
  assert.equal((await db.query('SELECT current_database() name')).rows[0].name, 'dynaminds');
  const h = await health();
  let s: Row, suffix: string;
  if (phase === 'recover-warehouse-limit') {
    ({ s, suffix } = await recoverRejectedWarehouse(manifest, h));
  } else {
    const tenants: string[] = (await db.query('SELECT id FROM tenants ORDER BY id')).rows.map(
        (r) => r.id,
      ),
      users: string[] = (await db.query('SELECT id FROM users ORDER BY id')).rows.map((r) => r.id);
    const previous = await checkpoint(tenants, users);
    s = {
      stage: 132,
      setup_complete: false,
      pending: null,
      completed: [],
      rejected: [],
      revision: h.revision,
      schema_revision: h.schema_revision,
      created_at: new Date().toISOString(),
      source_manifest: manifest,
      off: null,
      on: null,
      setup_checkpoint: {},
      setup_rows: {},
      files: {},
      prior_tenant_ids: tenants,
      prior_user_ids: users,
      prior_checkpoint: previous.tables,
    };
    state = s;
    await save(s, true);
    suffix = randomUUID().slice(0, 8);
  }
  if (phase === 'recover-warehouse-limit') await completeActorSetup(s, s.off, suffix);
  else await establishActor(s, 'off', suffix);
  await establishActor(s, 'on', suffix);
  assert.equal(s.completed.length, 122);
  assert.equal(s.rejected.length, phase === 'recover-warehouse-limit' ? 1 : 0);
  assert.equal(s.pending, null);
  const tenants: string[] = s.prior_tenant_ids,
    users: string[] = s.prior_user_ids;
  assert.deepEqual(
    (await checkpoint(tenants, users)).tables,
    s.prior_checkpoint,
    'Preexisting firms/users must remain exact',
  );
  assert.deepEqual(await sourceManifest(), manifest);
  await health();
  s.setup_complete = true;
  s.setup_completed_at = new Date().toISOString();
  await save(s);
  const original = await readFile(statePath);
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        status: 'PASS',
        phase: 'native_fixture_setup',
        stage: 132,
        revision: h.revision,
        schema_revision: h.schema_revision,
        workers_enabled: false,
        source_manifest: manifest,
        synthetic_firms: 2,
        synthetic_products: 106,
        source_rows_per_file: 53,
        physical_rows_per_file: 106,
        completed_mutations: s.completed.length,
        rejected_mutations: s.rejected.length,
        recovery_of_terminal_warehouse_limit: phase === 'recover-warehouse-limit',
        local_billing_only: true,
        pending: false,
        previous_firms_preserved: tenants.length,
        prior_checkpoint_sha256: hash(s.prior_checkpoint),
        setup_checkpoint_sha256: hash(s.setup_checkpoint),
        table_counts: {
          off: Object.keys(s.setup_checkpoint.off).length,
          on: Object.keys(s.setup_checkpoint.on).length,
        },
        private_setup_sha256: bytesHash(original),
        files: s.files,
        chrome_verified: false,
        import_executed: false,
        restart_verified: false,
        restore_verified: false,
        full_goal_complete: false,
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
  process.stdout.write(
    JSON.stringify({
      status: 'PASS',
      phase,
      firms: 2,
      products: 106,
      completed_mutations: s.completed.length,
      import_executed: false,
    }) + '\n',
  );
} catch (e) {
  const path = 'data/stock-file-import-native-setup-failure-' + randomUUID() + '.json';
  await writeFile(
    path,
    JSON.stringify(
      {
        phase: process.argv[2] === 'recover-warehouse-limit' ? 'recover-warehouse-limit' : 'setup',
        error:
          e instanceof Error ? { name: e.name, message: e.message, stack: e.stack } : String(e),
        pending: state?.pending ?? null,
        completed: state?.completed?.length ?? 0,
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx', mode: 0o600 },
  ).catch(() => {});
  process.stderr.write(
    'QA132 setup failed; inspect the private pending journal. Do not repeat mutations.\n',
  );
  process.exitCode = 1;
} finally {
  await db?.end();
}
