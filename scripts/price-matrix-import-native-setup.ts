/** ROOT-ONLY QA131 fixture author. Run once after schema114; never executes an import.
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
  key: string;
  path: string;
  method: string;
  status: number;
  response: unknown;
  cookie?: string;
  completed_at: string;
};
const statePath = 'data/price-matrix-import-stage131.json';
const csvPath = 'docs/price-matrix-import-native-mapped.csv';
const reportPath = 'docs/price-matrix-import-native-setup-qa.json';
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
  assert.equal(h.schema_revision, '114_price_matrix_imports');
  assert.equal(h.price_matrix_import_available, true);
  assert.equal(h.price_bulk_edit_available, true);
  assert.equal(h.price_file_import_available, true);
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
  s.pending = { key, path, method, body, expected, started_at: new Date().toISOString() };
  await save(s);
  const { response, data, cookie } = await fetchOwn(s, path, method, body);
  if (response.status !== expected) {
    s.pending.observed = { status: response.status, response: data, cookie: cookie ?? null };
    await save(s);
    throw new Error('Unexpected local mutation status: ' + path + ' ' + response.status);
  }
  const receipt: Receipt = {
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
  if (cookie) s.cookie = cookie;
  // Keep pending present while the complete successful response is durably recorded.
  await save(s);
  apply(data as Row);
  await save(s);
  s.pending = null;
  await save(s);
  return data as Row;
}
async function snapshot(s: Row) {
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
    const result: Row = {};
    for (const name of names) {
      assert.match(name, /^[a-z_][a-z0-9_]*$/);
      const key = ['users', 'tenants'].includes(name) ? 'id' : 'tenant_id';
      const rows = (
        await c.query(`SELECT to_jsonb(t) row FROM "${name}" t WHERE ${key}=$1 ORDER BY 1`, [
          name === 'users' ? s.user : s.tenant,
        ])
      ).rows;
      result[name] = { count: rows.length, sha256: hash(rows) };
    }
    const lists = (
      await c.query('SELECT to_jsonb(t) row FROM price_lists t WHERE tenant_id=$1 ORDER BY id', [
        s.tenant,
      ])
    ).rows;
    const items = (
      await c.query(
        'SELECT to_jsonb(t) row FROM price_list_items t WHERE tenant_id=$1 ORDER BY price_list_id,product_id',
        [s.tenant],
      )
    ).rows;
    const products = (
      await c.query(
        'SELECT id,sku,name,price,vat,version FROM products WHERE tenant_id=$1 ORDER BY id',
        [s.tenant],
      )
    ).rows;
    assert.equal(products.length, 53);
    for (const p of products) {
      const i = s.products.findIndex((x: Row) => x.id === p.id);
      assert(i >= 0);
      assert.equal(p.price, i === 0 ? 10001 : i === 2 ? 3000 : 1000);
      assert.equal(p.vat, 23);
      assert.equal(String(p.version), String(s.products[i].version));
    }
    const expected = [
      { price_list_id: s.pln.id, product_id: s.products[1].id, price: 700 },
      { price_list_id: s.pln.id, product_id: s.products[2].id, price: 900 },
      { price_list_id: s.eur.id, product_id: s.products[0].id, price: 1000 },
      { price_list_id: s.eur.id, product_id: s.products[2].id, price: 500 },
      { price_list_id: s.third.id, product_id: s.products[0].id, price: 777 },
    ];
    assert.deepEqual(
      items
        .map(({ row }) => ({
          price_list_id: row.price_list_id,
          product_id: row.product_id,
          price: row.price,
        }))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      expected.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    );
    const stocks = (
      await c.query(
        'SELECT product_id,warehouse_id,on_hand,reserved FROM stock WHERE tenant_id=$1 ORDER BY product_id',
        [s.tenant],
      )
    ).rows;
    assert.equal(stocks.length, 53);
    for (const row of stocks) {
      assert(s.products.some((p: Row) => p.id === row.product_id));
      assert.equal(row.warehouse_id, s.warehouse);
      assert.equal(row.on_hand, 0);
      assert.equal(row.reserved, 0);
    }
    for (const table of [
      'price_matrix_import_previews',
      'price_matrix_import_executions',
      'price_matrix_import_profiles',
      'price_matrix_import_profile_revisions',
      'price_matrix_import_targets',
      'price_matrix_import_execution_targets',
      'price_matrix_import_core_witnesses',
      'price_matrix_import_execution_admissions',
      'price_file_import_previews',
      'price_file_import_executions',
      'price_bulk_edit_previews',
      'price_bulk_edit_executions',
      'orders',
      'order_items',
      'payment_entries',
      'shipments',
      'reservations',
    ])
      assert.equal(
        result[table]?.count,
        0,
        'Setup cannot perform downstream business work: ' + table,
      );
    await c.query('COMMIT');
    return { checkpoint: result, pricing_rows: { lists, items }, products };
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}
try {
  assert.equal(process.argv[2], 'setup');
  assert.notEqual(process.env.DYNA_TEST, 'true');
  assert.equal(process.env.DYNA_WORKER_DISABLED, 'true');
  assert.match(process.env.QA_EXPECTED_REVISION ?? '', /^[a-f0-9]{40}$/);
  for (const path of [statePath, csvPath, reportPath]) await absent(path);
  // Refuse provisioning a missing configuration; server/db must never create one here.
  const config = await lstat(resolve(process.env.DYNA_LOCAL_CONFIG_PATH ?? '.local.json'));
  assert(config.isFile());
  db = (await import('../server/db')).pool;
  assert.equal((await db.query('SELECT current_database() name')).rows[0].name, 'dynaminds');
  const h = await health(),
    suffix = randomUUID().slice(0, 8),
    s: Row = {
      stage: 131,
      setup_complete: false,
      pending: null,
      completed: [],
      email: `qa131-price-matrix-${suffix}@demo.local`,
      password: `DynaQa131!${randomUUID()}`,
      products: [],
      revision: h.revision,
      schema_revision: h.schema_revision,
      created_at: new Date().toISOString(),
    };
  state = s;
  await save(s, true);
  await mutate(
    s,
    'signup',
    '/auth/signup',
    'POST',
    {
      email: s.email,
      password: s.password,
      name: 'QA131 Macierz cen',
      organization: { name: 'QA131 Macierz ' + suffix, currency: 'PLN', locale: 'pl-PL' },
    },
    201,
    (r) => {
      s.user = r.user.id;
      s.tenant = r.user.tenant_id;
      assert.equal(r.user.role, 'admin');
    },
  );
  const auth = await readOwn(s, '/auth/me');
  assert.equal(auth.id ?? auth.user?.id, s.user);
  assert.equal(auth.tenant_id ?? auth.user?.tenant_id, s.tenant);
  const warehouses = await readOwn(s, '/warehouses');
  assert.equal(warehouses.data.length, 1, 'Select the genuine unique default warehouse');
  s.warehouse = warehouses.data[0].id;
  await save(s);
  for (let i = 0; i < 53; i++)
    await mutate(
      s,
      'product-' + i,
      '/products',
      'POST',
      {
        sku: `000131-${suffix}-${String(i).padStart(3, '0')}`,
        name: `QA131 Produkt ${String(i).padStart(3, '0')}`,
        price: i === 0 ? 10001 : i === 2 ? 3000 : 1000,
        vat: 23,
        quantity: 0,
        warehouse_id: s.warehouse,
        category: 'QA131',
      },
      201,
      (p) => {
        assert(p.id && p.version);
        s.products.push(p);
      },
    );
  for (const [key, currency, fallback, name] of [
    ['pln', 'PLN', true, 'QA131 PLN NET '],
    ['eur', 'EUR', false, 'QA131 EUR GROSS '],
    ['third', 'PLN', true, 'QA131 PLN NIEZMIENIANY '],
  ] as const)
    await mutate(
      s,
      'list-' + key,
      '/price-lists',
      'POST',
      { name: name + suffix, currency, fallback },
      201,
      (list) => {
        assert(list.id);
        s[key] = list;
      },
    );
  for (const [key, items] of [
    [
      'pln',
      [
        { product_id: s.products[1].id, price: 700 },
        { product_id: s.products[2].id, price: 900 },
      ],
    ],
    [
      'eur',
      [
        { product_id: s.products[0].id, price: 1000 },
        { product_id: s.products[2].id, price: 500 },
      ],
    ],
    ['third', [{ product_id: s.products[0].id, price: 777 }]],
  ] as Array<[string, Row[]]>)
    await mutate(
      s,
      'prices-' + key,
      `/price-lists/${s[key].id}/items`,
      'PUT',
      { version: s[key].version, items },
      200,
      (list) => {
        assert.equal(list.id, s[key].id);
        assert.equal(list.version, s[key].version + 1);
        s[key] = list;
      },
    );
  assert.equal(s.completed.length, 60);
  assert.equal(s.pending, null);
  assert.equal(s.products.length, 53);
  for (const key of ['pln', 'eur', 'third']) {
    const r = await readOwn(s, `/price-lists/${s[key].id}/items?limit=100`);
    assert.equal(r.list.version, s[key].version);
    assert.equal(r.list.currency, s[key].currency);
    assert.equal(r.meta.cursor, null);
    s[key] = r.list;
  }
  const csv =
    'Kod;PLN;EUR;OpPLN;OpEUR;WalutaPLN;WalutaEUR\r\n' +
    s.products
      .map((p: Row, i: number) =>
        [
          p.sku,
          i === 0 ? '100,01' : i === 1 || i === 2 ? '' : i === 3 ? '0' : '10,00',
          i === 0 ? '21,00' : i === 1 ? '0' : i === 2 ? '' : i === 3 ? '30,00' : '11,00',
          i === 1 ? 'none' : i === 2 ? 'remove' : 'set',
          i === 2 ? 'remove' : 'set',
          'PLN',
          'EUR',
        ].join(';'),
      )
      .join('\r\n') +
    '\r\n';
  await writeFile(csvPath, csv, { flag: 'wx' });
  s.files = {
    csv: {
      path: csvPath,
      sha256: bytesHash(csv),
      bytes: Buffer.byteLength(csv),
      products: 53,
      cells: 106,
    },
  };
  const common = {
    format: 'csv',
    delimiter: ';',
    identity: 'sku',
    amount_mode: 'decimal',
    decimal_separator: ',',
    empty_policy: 'skip',
    spreadsheet_safe: false,
    native_price_mode: 'mapped',
  };
  s.targets = [
    {
      price_list_id: s.pln.id,
      list_version: s.pln.version,
      definition: {
        ...common,
        basis: 'net',
        mapping: { identity: 'Kod', price: 'PLN', operation: 'OpPLN', currency: 'WalutaPLN' },
      },
    },
    {
      price_list_id: s.eur.id,
      list_version: s.eur.version,
      definition: {
        ...common,
        basis: 'gross',
        mapping: { identity: 'Kod', price: 'EUR', operation: 'OpEUR', currency: 'WalutaEUR' },
      },
    },
  ].sort((a: Row, b: Row) => a.price_list_id.localeCompare(b.price_list_id));
  s.expected_after = {
    pln: {
      version: s.pln.version + 1,
      changed: 52,
      unchanged: 1,
      missing_after_count: 0,
      own_entry_count: 52,
    },
    eur: {
      version: s.eur.version + 1,
      changed: 53,
      unchanged: 0,
      missing_after_count: 1,
      own_entry_count: 52,
    },
    third: { version: s.third.version, product_id: s.products[0].id, price: 777 },
    total_products: 53,
    total_cells: 106,
    changed: 105,
    unchanged: 1,
    ack_missing_price_list_ids: [s.eur.id],
  };
  await save(s);
  const frozen = await snapshot(s);
  s.setup_checkpoint = frozen.checkpoint;
  s.setup_pricing_rows = frozen.pricing_rows;
  s.setup_complete = true;
  s.setup_completed_at = new Date().toISOString();
  await save(s);
  await health();
  const original = await readFile(statePath);
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        status: 'PASS',
        phase: 'native_fixture_setup',
        stage: 131,
        revision: h.revision,
        schema_revision: h.schema_revision,
        synthetic_products: 53,
        selected_lists: 2,
        untouched_lists: 1,
        source_cells: 106,
        currencies: ['PLN', 'EUR'],
        completed_mutations: s.completed.length,
        pending: false,
        files: s.files,
        table_count: Object.keys(s.setup_checkpoint).length,
        setup_checkpoint_sha256: hash(s.setup_checkpoint),
        private_setup_sha256: bytesHash(original),
        background_workers_enabled: false,
        chrome_verified: false,
        price_matrix_import_executed: false,
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
      phase: 'setup',
      products: 53,
      lists: 3,
      completed_mutations: 60,
      chrome_verified: false,
    }) + '\n',
  );
} catch (e) {
  // All detailed failures, including pending successful responses, remain private.
  const path = 'data/price-matrix-import-native-setup-failure-' + randomUUID() + '.txt';
  await writeFile(
    path,
    JSON.stringify(
      {
        phase: 'setup',
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
    'QA131 setup failed; inspect the private failure record and pending journal. Do not repeat mutations.\n',
  );
  process.exitCode = 1;
} finally {
  await db?.end();
}
