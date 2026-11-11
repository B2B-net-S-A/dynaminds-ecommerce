/** One-shot local QA130 fixture, not a browser acceptance claim.
 * API mutations are recorded before dispatch; an uncertain action is never replayed automatically. */
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { open, lstat, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { pool } from '../server/db';
type Row = Record<string, any>;
const statePath = 'data/price-file-import-stage130.json';
const csvPath = 'docs/price-file-import-native-mapped.csv';
const xmlPath = 'docs/price-file-import-native-own-entries.xml';
const reportPath = 'docs/price-file-import-native-setup-qa.json';
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const bytesHash = (v: string) => createHash('sha256').update(v, 'utf8').digest('hex');
async function absent(path: string) {
  try {
    await lstat(path);
    throw new Error('Refuse existing owned fixture: ' + path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}
async function save(s: Row, initial = false) {
  const handle = await open(
    statePath,
    constants.O_WRONLY |
      constants.O_NOFOLLOW |
      (initial ? constants.O_CREAT | constants.O_EXCL : 0),
    0o600,
  );
  try {
    const st = await handle.stat();
    assert(st.isFile() && (st.mode & 0o777) === 0o600);
    await handle.truncate(0);
    await handle.writeFile(JSON.stringify(s, null, 2) + '\n');
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function health() {
  const r = await fetch('http://127.0.0.1:4100/api/health', {
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(r.status, 200);
  const h = (await r.json()) as Row;
  assert.equal(h.status, 'ok');
  assert.equal(h.mode, 'local');
  assert.equal(h.revision, process.env.QA_EXPECTED_REVISION);
  assert.equal(h.schema_revision, '113_price_file_imports');
  assert.equal(h.price_file_import_available, true);
  assert.equal(h.restore_preview, false);
  assert.equal(h.background_workers_enabled, false);
  return h;
}
async function call(
  s: Row,
  path: string,
  method = 'GET',
  body?: unknown,
  expected = 200,
  file = false,
) {
  const mutates = method !== 'GET';
  if (mutates) {
    s.pending = { path, method, body, expected };
    await save(s);
  }
  const response = await fetch('http://127.0.0.1:4100/api' + path, {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
    headers: {
      ...(s.cookie ? { cookie: s.cookie } : {}),
      ...(s.tenant ? { 'X-Workspace-ID': s.tenant } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.equal(response.status, expected, 'Unexpected local API status: ' + path);
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  if (cookie) s.cookie = cookie;
  const data = file ? await response.text() : await response.json();
  if (mutates) {
    s.pending = null;
    await save(s);
  }
  return data as any;
}
async function snapshot(s: Row) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TimeZone='UTC'");
    const names: string[] = (
      await c.query(`SELECT t.table_name FROM information_schema.tables t
      JOIN information_schema.columns k USING(table_schema,table_name)
      WHERE t.table_schema='public' AND t.table_type='BASE TABLE' AND k.column_name='tenant_id'
      AND t.table_name<>'sessions' UNION SELECT 'users' UNION SELECT 'tenants' ORDER BY 1`)
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
    await c.query('COMMIT');
    return result;
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
  for (const path of [statePath, csvPath, xmlPath, reportPath]) await absent(path);
  assert.equal((await pool.query('SELECT current_database() name')).rows[0].name, 'dynaminds');
  const h = await health();
  const suffix = randomUUID().slice(0, 8),
    s: Row = {
      stage: 130,
      setup_complete: false,
      pending: null,
      email: `qa130-price-${suffix}@demo.local`,
      password: `DynaQa130!${randomUUID()}`,
      products: [],
      revision: h.revision,
      schema_revision: h.schema_revision,
    };
  await save(s, true);
  const signup = await call(
    s,
    '/auth/signup',
    'POST',
    {
      email: s.email,
      password: s.password,
      name: 'QA130 Import cen',
      organization: { name: 'QA130 Cenniki ' + suffix, currency: 'PLN', locale: 'pl-PL' },
    },
    201,
  );
  s.user = signup.user.id;
  s.tenant = signup.user.tenant_id;
  assert.equal(signup.user.role, 'admin');
  await save(s);
  const warehouses = await call(s, '/warehouses');
  s.warehouse = warehouses.data[0].id;
  await save(s);
  for (let i = 0; i < 53; i++) {
    const product = await call(
      s,
      '/products',
      'POST',
      {
        sku: `000130-${suffix}-${String(i).padStart(3, '0')}`,
        name: `QA130 Produkt ${String(i).padStart(3, '0')}`,
        price: i === 0 ? 10001 : i === 2 ? 3000 : 1000,
        vat: 23,
        quantity: 0,
        warehouse_id: s.warehouse,
        category: 'QA130',
      },
      201,
    );
    s.products.push(product);
    await save(s);
  }
  s.pln = await call(
    s,
    '/price-lists',
    'POST',
    { name: 'QA130 PLN ' + suffix, currency: 'PLN', fallback: true },
    201,
  );
  s.eur = await call(
    s,
    '/price-lists',
    'POST',
    { name: 'QA130 EUR ' + suffix, currency: 'EUR', fallback: false },
    201,
  );
  await save(s);
  await call(s, `/price-lists/${s.pln.id}/items`, 'PUT', {
    version: s.pln.version,
    items: [
      { product_id: s.products[1].id, price: 700 },
      { product_id: s.products[2].id, price: 900 },
    ],
  });
  await call(s, `/price-lists/${s.eur.id}/items`, 'PUT', {
    version: s.eur.version,
    items: [{ product_id: s.products[0].id, price: 2100 }],
  });
  const xml = await call(
    s,
    '/catalog/exports/file',
    'POST',
    {
      format: 'xml',
      columns: ['id', 'sku', 'prices_json'],
      selection: 'selected',
      ids: [s.products[0].id],
      price_list_ids: [s.pln.id, s.eur.id],
      headers: {},
      spreadsheet_safe: false,
    },
    200,
    true,
  );
  assert(xml.includes('<catalog ') && xml.includes('<prices_json ') && xml.includes(s.eur.id));
  await writeFile(xmlPath, xml, { flag: 'wx' });
  s.eur = (await call(s, `/price-lists/${s.eur.id}/items`)).list;
  await call(s, `/price-lists/${s.eur.id}/items`, 'PUT', {
    version: s.eur.version,
    items: [{ product_id: s.products[0].id, price: 1000 }],
  });
  s.pln = (await call(s, `/price-lists/${s.pln.id}/items`)).list;
  s.eur = (await call(s, `/price-lists/${s.eur.id}/items`)).list;
  const csv =
    'Kod;Kwota;Operacja;Waluta\r\n' +
    s.products
      .map(
        (p: Row, i: number) =>
          `${p.sku};${i === 0 ? '100,01' : i === 1 || i === 2 ? '' : i === 3 ? '0' : '10,00'};${i === 1 ? 'none' : i === 2 ? 'remove' : 'set'};PLN`,
      )
      .join('\r\n') +
    '\r\n';
  await writeFile(csvPath, csv, { flag: 'wx' });
  s.files = {
    csv: { path: csvPath, sha256: bytesHash(csv) },
    xml: { path: xmlPath, sha256: bytesHash(xml) },
  };
  s.setup_checkpoint = await snapshot(s);
  s.setup_complete = true;
  await save(s);
  await health();
  const original = await readFile(statePath);
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        status: 'PASS',
        phase: 'native_fixture_setup',
        stage: 130,
        revision: h.revision,
        schema_revision: h.schema_revision,
        synthetic_products: s.products.length,
        currencies: ['PLN', 'EUR'],
        files: s.files,
        setup_checkpoint_sha256: hash(s.setup_checkpoint),
        private_setup_sha256: createHash('sha256').update(original).digest('hex'),
        background_workers_enabled: false,
        chrome_verified: false,
        price_file_import_executed: false,
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
    JSON.stringify({ status: 'PASS', phase: 'setup', products: 53, chrome_verified: false }) + '\n',
  );
} finally {
  await pool.end();
}
