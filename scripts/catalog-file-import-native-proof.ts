/** Root QA117. Setup owns one synthetic firm. Readback accepts only the
 * three manual UI imports described below, then freezes their exact data. */
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { lstat, open, readFile, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { pool } from '../server/db';

type Json = Record<string, any>;
const phase = process.argv[2],
  revision = process.env.QA_EXPECTED_REVISION;
assert(['setup', 'readback'].includes(phase));
assert(revision && /^[a-f0-9]{7,40}$/.test(revision));
const statePath = 'data/catalog-file-import-stage117.json';
const prefix = 'docs/catalog-file-import-native';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** SQL is the oracle; JSON normalization matches public Date/string serialization only. */
function publicHead(row: Json, preview?: Json): Json {
  return JSON.parse(
    JSON.stringify({
      id: row.id,
      ...(preview ? { preview_id: row.preview_id, state: row.state } : {}),
      actor_id: row.actor_id,
      scope_hash: row.scope_hash,
      total: row.total,
      created: row.created,
      updated: row.updated,
      unchanged: row.unchanged,
      invalid: preview ? 0 : row.invalid,
      ready: preview ? true : row.ready,
      created_at: row.created_at,
      config: (preview ?? row).config,
      active_product_rules: (preview ?? row).rules_snapshot.length,
    }),
  );
}
function publicRows(rows: Json[]): Json[] {
  return rows.map((raw) => {
    const row = { ...raw };
    for (const privateKey of ['tenant_id', 'preview_id', 'execution_id', 'byte_count'])
      delete row[privateKey];
    return JSON.parse(JSON.stringify({ ...row, changes: raw.input }));
  });
}
function assertImportConfigs(previews: Json[], s: Json) {
  assert.deepEqual(
    previews.map((p) => p.config.format),
    ['xml', 'xml', 'csv'],
  );
  assert.deepEqual(
    previews.map((p) => p.config.mapping),
    [{}, {}, { sku: 'Kod dostawcy', name: 'Nowa nazwa' }],
  );
  for (const p of previews) {
    assert.equal(p.actor_id, s.user);
    assert.equal(p.config.warehouse_id, s.warehouse.id);
    assert.equal(p.config.currency, 'PLN');
    assert.equal(p.config.mode, 'update');
    assert.equal(p.config.empty_policy, 'skip');
    assert.equal(p.config.ignore_readonly_fields, false);
    assert(!Object.hasOwn(p.config, 'content'));
  }
  assert.equal(previews[2].config.delimiter, ';');
  assert.equal(previews[2].config.identity, 'sku');
}
function assertMappedRows(rows: Json[], s: Json) {
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.product_id).sort(), [s.products.a.id, s.products.b.id].sort());
  for (const [key, product] of Object.entries(s.products) as [string, Json][]) {
    const row = rows.find((r) => r.product_id === product.id);
    assert(row);
    assert.equal(row.identity_value, product.sku);
    assert.equal(row.sku, product.sku);
    assert.equal(row.current_sku, product.sku);
    assert.equal(row.matched_historical_sku, false);
    assert.equal(row.operation, 'update');
    assert.equal(row.input.name, key === 'a' ? 'QA117 Nazwa CSV A' : 'QA117 Nazwa CSV B');
    assert.equal(row.after.name, row.input.name);
    assert.equal(row.after.sku, product.sku);
    assert.deepEqual(row.changed_fields, ['name']);
    assert.deepEqual(row.errors, []);
  }
}
const invariantNames = [
  'warehouses',
  'stock',
  'stock_locations',
  'reservations',
  'reservation_locations',
  'orders',
  'order_items',
  'order_events',
  'price_lists',
  'price_list_items',
];
const ownNames = [
  'tenants',
  'users',
  'memberships',
  'products',
  'product_sku_aliases',
  'product_logistics',
  'bundle_components',
  'catalog_file_import_previews',
  'catalog_file_import_rows',
  'catalog_file_import_executions',
  'catalog_file_import_execution_rows',
  'audit_events',
  'workspace_usage',
  ...invariantNames,
];
async function save(s: Json, fresh = false) {
  if (!fresh) {
    const stat = await lstat(statePath);
    assert(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600);
  }
  const handle = await open(
    statePath,
    constants.O_WRONLY |
      constants.O_NOFOLLOW |
      (fresh ? constants.O_CREAT | constants.O_EXCL : constants.O_TRUNC),
    0o600,
  );
  try {
    await handle.writeFile(JSON.stringify(s, null, 2));
  } finally {
    await handle.close();
  }
}
async function load(): Promise<Json> {
  const stat = await lstat(statePath);
  assert(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600);
  return JSON.parse(await readFile(statePath, 'utf8'));
}
async function api(s: Json, path: string, method = 'GET', body?: unknown, expected = 200) {
  const response = await fetch('http://127.0.0.1:4100/api' + path, {
    method,
    signal: AbortSignal.timeout(30000),
    headers: {
      ...(s.cookie ? { cookie: s.cookie, 'X-Workspace-ID': s.tenant } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal(response.status, expected, `${method} ${path}: HTTP ${response.status}`);
  return { response, data: (await response.json()) as Json };
}
async function step(
  s: Json,
  label: string,
  path: string,
  method: string,
  body: Json,
  expected = 200,
) {
  s.pending = { label, path, method, body, expected };
  await save(s);
  const result = await api(s, path, method, body, expected);
  s.pending = null;
  await save(s);
  return result.data;
}
async function snapshot(s: Json, names: string[]) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    const result: Json = {};
    for (const name of names) {
      assert(ownNames.includes(name));
      const key = name === 'users' || name === 'tenants' ? 'id' : 'tenant_id';
      const rows = (
        await c.query(
          `SELECT to_jsonb(t) row FROM "${name}" t
        WHERE ${key}=$1 ORDER BY 1`,
          [name === 'users' ? s.user : s.tenant],
        )
      ).rows;
      result[name] = { count: rows.length, sha256: digest(rows) };
    }
    await c.query('COMMIT');
    return result;
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}
async function setup(health: Json) {
  const suffix = randomUUID();
  const s: Json = {
    stage: 117,
    email: `qa117-file-${suffix}@demo.local`,
    password: process.env.QA_NATIVE_TEST_PASSWORD ?? `DynaQa117!${randomUUID()}`,
    setup_complete: false,
    pending: 'signup',
    own_names: ownNames,
    invariant_names: invariantNames,
    products: {},
    runtime_revision: revision,
    schema_revision: health.schema_revision,
  };
  await save(s, true);
  const signup = await api(
    {},
    '/auth/signup',
    'POST',
    {
      email: s.email,
      password: s.password,
      name: 'QA117 Import plikowy',
      organization: { name: 'QA117 Pliki ' + suffix.slice(0, 8), currency: 'PLN', locale: 'pl-PL' },
    },
    201,
  );
  const cookie = signup.response.headers.get('set-cookie');
  assert(cookie);
  s.cookie = cookie.split(';')[0];
  s.user = signup.data.user.id;
  s.tenant = signup.data.user.tenant_id;
  assert.equal(signup.data.user.role, 'admin');
  s.pending = null;
  await save(s);
  s.warehouse = (await api(s, '/warehouses')).data.data[0];
  await save(s);
  for (const [key, price, quantity] of [
    ['a', 2599, 12],
    ['b', 1001, 10],
  ] as const) {
    s.products[key] = await step(
      s,
      'create ' + key,
      '/products',
      'POST',
      {
        sku: `000117-${suffix.slice(0, 8)}-${key}`,
        ean: key === 'a' ? '001170000001' : '001170000002',
        name: 'QA117 Produkt ' + key,
        description: 'Opis początkowy ' + key,
        price,
        quantity,
        warehouse_id: s.warehouse.id,
        category: 'QA117',
        weight_grams: 500,
        attributes: { kolor: key === 'a' ? 'zielony' : 'niebieski' },
      },
      201,
    );
    await save(s);
  }
  const orderBody = {
    customer_name: 'QA117 Rezerwacja',
    email: 'qa117@example.test',
    warehouse_id: s.warehouse.id,
    items: [
      { product_id: s.products.a.id, quantity: 3 },
      { product_id: s.products.b.id, quantity: 1 },
    ],
  };
  const orderResponse = await fetch('http://127.0.0.1:4100/api/orders', {
    method: 'POST',
    headers: {
      cookie: s.cookie,
      'X-Workspace-ID': s.tenant,
      'Content-Type': 'application/json',
      'idempotency-key': randomUUID(),
    },
    body: JSON.stringify(orderBody),
  });
  assert.equal(orderResponse.status, 201);
  s.order = await orderResponse.json();
  await save(s);
  const config = {
    format: 'xml',
    selection: 'selected',
    ids: [s.products.a.id],
    columns: ['id', 'sku', 'description', 'price_minor', 'attributes_json', 'weight_g'],
    spreadsheet_safe: false,
  };
  const exported = await fetch('http://127.0.0.1:4100/api/catalog/exports/file', {
    method: 'POST',
    headers: { cookie: s.cookie, 'X-Workspace-ID': s.tenant, 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  assert.equal(exported.status, 200);
  const original = await exported.text();
  const oldPrice = '<price_minor type="number">2599</price_minor>';
  const oldDescription = '<description type="string">Opis początkowy a</description>';
  assert.equal(original.split(oldPrice).length, 2);
  assert.equal(original.split(oldDescription).length, 2);
  const edited = original
    .replace(oldPrice, '<price_minor type="number">0</price_minor>')
    .replace(
      oldDescription,
      '<description type="string">Opis z XML — ą &amp; &lt;test&gt;</description>',
    );
  s.xml_content = edited;
  s.csv_content =
    'Kod dostawcy;Nowa nazwa\r\n' +
    `${s.products.a.sku};QA117 Nazwa CSV A\r\n${s.products.b.sku};QA117 Nazwa CSV B\r\n`;
  await writeFile(prefix + '-original.xml', original);
  await writeFile(prefix + '-edited.xml', edited);
  await writeFile(prefix + '-mapped.csv', s.csv_content);
  s.invariant_snapshot = await snapshot(s, invariantNames);
  s.setup_complete = true;
  s.pending = null;
  await save(s);
  await writeFile(
    prefix + '-setup-qa.json',
    JSON.stringify(
      {
        status: 'PASS_SETUP_ONLY',
        stage: 117,
        tenant: s.tenant,
        runtime_revision: revision,
        schema_revision: health.schema_revision,
        products: Object.values(s.products).map((p: any) => ({
          id: p.id,
          sku: p.sku,
          version: p.version,
        })),
        xml_source: 'actual native catalog export',
        expected_ui_operations: [
          'XML A price2599→0 and description, omitted name/EAN/logistics retained',
          'same XML again: unchanged, product version retained',
          'CSV semicolon mapping sku→Kod dostawcy/name→Nowa nazwa: two partial updates',
        ],
        provider_operations_performed: false,
        ui_verified: false,
        full_goal_complete: false,
      },
      null,
      2,
    ),
  );
  return { phase: 'setup', status: 'PASS_SETUP_ONLY', email: s.email, tenant: s.tenant };
}
async function readback(health: Json) {
  const s = await load();
  assert(s.stage === 117 && s.setup_complete && !s.pending);
  assert.equal(s.runtime_revision, revision);
  assert.equal(s.schema_revision, health.schema_revision);
  const before = await snapshot(s, ownNames);
  if (s.accepted_checkpoint) assert.deepEqual(before, s.accepted_checkpoint);
  assert.deepEqual(
    await snapshot(s, invariantNames),
    s.invariant_snapshot,
    'Import changed orders, stock, reservations or price-list data',
  );
  const products = (
    await pool.query(
      `SELECT id,sku,ean,name,description,price,version,category,attributes
    FROM products WHERE tenant_id=$1 ORDER BY id`,
      [s.tenant],
    )
  ).rows;
  assert.equal(products.length, 2);
  const logistics = (
    await pool.query(
      'SELECT product_id,weight_grams,length_mm,width_mm,height_mm,manufacturer FROM product_logistics WHERE tenant_id=$1 ORDER BY product_id',
      [s.tenant],
    )
  ).rows;
  assert.equal(logistics.length, 2);
  for (const [key, p] of Object.entries(s.products) as [string, Json][]) {
    const actual = products.find((row) => row.id === p.id);
    assert(actual);
    assert.equal(actual.sku, p.sku);
    assert.equal(actual.ean, p.ean);
    assert.equal(actual.category, 'QA117');
    assert.deepEqual(actual.attributes, p.attributes);
    assert.equal(actual.name, key === 'a' ? 'QA117 Nazwa CSV A' : 'QA117 Nazwa CSV B');
    assert.equal(actual.price, key === 'a' ? 0 : 1001);
    assert.equal(actual.description, key === 'a' ? 'Opis z XML — ą & <test>' : 'Opis początkowy b');
    assert.equal(actual.version, Number(p.version) + (key === 'a' ? 2 : 1));
    const profile = logistics.find((row) => row.product_id === p.id);
    assert(profile);
    for (const field of ['weight_grams', 'length_mm', 'width_mm', 'height_mm', 'manufacturer']) {
      assert.equal(profile[field], p[field] ?? null, `Import changed ${key}.${field}`);
    }
  }
  const previews = (
    await pool.query(
      `SELECT * FROM catalog_file_import_previews
    WHERE tenant_id=$1 ORDER BY created_at,id`,
      [s.tenant],
    )
  ).rows;
  const executions = (
    await pool.query(
      `SELECT * FROM catalog_file_import_executions
    WHERE tenant_id=$1 ORDER BY created_at,id`,
      [s.tenant],
    )
  ).rows;
  assert.equal(previews.length, 3);
  assert.equal(executions.length, 3);
  assertImportConfigs(previews, s);
  assert.deepEqual(
    previews.map((p) => [p.total, p.created, p.updated, p.unchanged, p.invalid, p.ready]),
    [
      [1, 0, 1, 0, 0, true],
      [1, 0, 0, 1, 0, true],
      [2, 0, 2, 0, 0, true],
    ],
  );
  assert.deepEqual(
    executions.map((p) => [p.total, p.created, p.updated, p.unchanged]),
    [
      [1, 0, 1, 0],
      [1, 0, 0, 1],
      [2, 0, 2, 0],
    ],
  );
  const options = (await api(s, '/catalog/file-imports/options')).data;
  assert(options.available && options.can_read && options.can_write && !options.read_only);
  for (const p of previews) {
    const detail = (await api(s, '/catalog/file-imports/previews/' + p.id)).data;
    const rows = (
      await pool.query(
        'SELECT * FROM catalog_file_import_rows WHERE tenant_id=$1 AND preview_id=$2 ORDER BY index',
        [s.tenant, p.id],
      )
    ).rows;
    assert.equal(rows.length, p.total);
    if (p.config.format === 'csv') assertMappedRows(rows, s);
    assert.deepEqual(detail.preview, publicHead(p));
    assert.deepEqual(detail.rows, publicRows(rows));
    assert(detail.available && detail.can_read && detail.can_write && !detail.read_only);
    assert.equal(detail.meta.cursor, null);
  }
  for (const e of executions) {
    const detail = (await api(s, '/catalog/file-imports/executions/' + e.id)).data;
    const p = previews.find((p) => p.id === e.preview_id);
    assert(p);
    assert.equal(e.actor_id, s.user);
    const rows = (
      await pool.query(
        'SELECT * FROM catalog_file_import_execution_rows WHERE tenant_id=$1 AND execution_id=$2 ORDER BY index',
        [s.tenant, e.id],
      )
    ).rows;
    assert.equal(rows.length, e.total);
    if (p.config.format === 'csv') assertMappedRows(rows, s);
    assert.deepEqual(detail.execution, publicHead(e, p));
    assert.deepEqual(detail.rows, publicRows(rows));
    assert(detail.available && detail.can_read && detail.can_write && !detail.read_only);
    assert.equal(detail.meta.cursor, null);
  }
  // PostgreSQL retains timestamp microseconds for history ordering; Date sorting would not.
  const orderedHistory = (
    await pool.query(
      `SELECT kind,id FROM (
      SELECT 'preview'::text kind,id,created_at FROM catalog_file_import_previews WHERE tenant_id=$1
      UNION ALL
      SELECT 'execution'::text kind,id,created_at FROM catalog_file_import_executions WHERE tenant_id=$1
    ) h ORDER BY created_at DESC,id DESC,kind DESC`,
      [s.tenant],
    )
  ).rows;
  const expectedHistory = orderedHistory.map((h) => {
    const execution = h.kind === 'execution';
    const raw = (execution ? executions : previews).find((row) => row.id === h.id);
    assert(raw);
    const parent = execution ? previews.find((p) => p.id === raw.preview_id) : undefined;
    if (execution) assert(parent);
    return { kind: h.kind, ...publicHead(raw, parent) };
  });
  const history = (await api(s, '/catalog/file-imports/history')).data;
  assert.equal(expectedHistory.length, 6);
  assert.deepEqual(history.data, expectedHistory);
  assert(history.available && history.can_read && history.can_write && !history.read_only);
  assert.equal(history.meta.cursor, null);
  const after = await snapshot(s, ownNames);
  assert.deepEqual(after, before);
  if (!s.accepted_checkpoint) {
    s.accepted_checkpoint = after;
    await save(s);
  }
  await writeFile(
    prefix + '-readback-qa.json',
    JSON.stringify(
      {
        status: 'PASS',
        phase,
        stage: 117,
        runtime_revision: revision,
        schema_revision: health.schema_revision,
        tenant: s.tenant,
        previews: 3,
        executions: 3,
        rows: 4,
        no_op_retains_version: true,
        own_tables: ownNames.length,
        accepted_checkpoint_exact: true,
        orders_inventory_price_lists_unchanged: true,
        logistics_preserved_against_setup: true,
        history_read_only_unchanged: true,
        public_heads_rows_exact: true,
        history_exact: true,
        formats_and_mapping_exact: true,
        checkpoint_sha256: digest(after),
        provider_operations_performed: false,
        ui_verified_by_helper: false,
        full_goal_complete: false,
      },
      null,
      2,
    ),
  );
  return { status: 'PASS', phase, previews: 3, executions: 3 };
}
try {
  const response = await fetch('http://127.0.0.1:4100/api/health');
  assert.equal(response.status, 200);
  const health = (await response.json()) as Json;
  assert.equal(health.revision, revision);
  assert.equal(health.schema_revision, '098_catalog_file_imports');
  assert.equal(health.restore_preview, false);
  assert.equal(health.catalog_file_imports_available, true);
  process.stdout.write(
    JSON.stringify(phase === 'setup' ? await setup(health) : await readback(health)) + '\n',
  );
} finally {
  await pool.end();
}
