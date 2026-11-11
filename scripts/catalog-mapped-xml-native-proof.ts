/** Owned QA134 only, HTTP mutations with durable pending state and no automatic retry. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, lstat } from 'node:fs/promises';
import { pool } from '../server/db';
const phase = process.argv[2];
assert(['setup', 'first', 'second'].includes(phase ?? ''));
assert.notEqual(process.env.DYNA_TEST, 'true');
const revision = process.env.QA_EXPECTED_REVISION;
assert.match(revision ?? '', /^[a-f0-9]{40}$/);
const api = 'http://127.0.0.1:4100/api';
const path = 'data/catalog-mapped-xml-stage134.json';
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
let state: any;
async function save(initial = false) {
  const content = JSON.stringify(state, null, 2) + '\n';
  if (initial) await writeFile(path, content, { flag: 'wx', mode: 0o600 });
  else {
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    const tmp = path + '.write-' + randomUUID();
    await writeFile(tmp, content, { flag: 'wx', mode: 0o600 });
    await rename(tmp, path);
  }
}
async function mutate(url: string, body: unknown, kind: string) {
  assert.equal(state.pending, null);
  state.pending = { url, body, kind, started_at: new Date().toISOString() };
  await save();
  const r = await fetch(api + url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(state.cookie ? { cookie: state.cookie } : {}),
    },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  const result = (await r.json()) as any;
  assert.equal(r.status, 201, 'Own fixture mutation failed: ' + kind);
  state.pending.received = { status: r.status, body: result };
  if (r.headers.get('set-cookie')) state.cookie = r.headers.get('set-cookie')!.split(';')[0];
  await save();
  if (kind === 'signup') {
    state.tenant = result.user.tenant_id;
    state.user = result.user.id;
  } else state.products.push(result);
  state.completed.push(state.pending);
  state.pending = null;
  await save();
}
async function snapshot() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TimeZone='UTC'");
    const names = (
      await c.query(
        `SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id' AND table_name<>'sessions' UNION SELECT 'tenants' UNION SELECT 'users' ORDER BY 1`,
      )
    ).rows.map((r) => r.table_name as string);
    const tables: any = {};
    for (const n of names) {
      assert.match(n, /^[a-z_][a-z0-9_]*$/);
      const key = ['tenants', 'users'].includes(n) ? 'id' : 'tenant_id';
      const rows = (
        await c.query(`SELECT to_jsonb(t) row FROM "${n}" t WHERE ${key}=$1 ORDER BY 1`, [
          n === 'users' ? state.user : state.tenant,
        ])
      ).rows;
      tables[n] = { count: rows.length, sha256: digest(rows) };
    }
    const products = (
      await c.query(
        'SELECT id,sku,name,description,price,version FROM products WHERE tenant_id=$1 ORDER BY sku',
        [state.tenant],
      )
    ).rows;
    const executions = (
      await c.query(
        'SELECT * FROM catalog_file_import_executions WHERE tenant_id=$1 ORDER BY created_at,id',
        [state.tenant],
      )
    ).rows;
    const rows = (
      await c.query(
        'SELECT * FROM catalog_file_import_execution_rows WHERE tenant_id=$1 ORDER BY execution_id,index',
        [state.tenant],
      )
    ).rows;
    const previews = (
      await c.query(
        'SELECT id,config,total,ready FROM catalog_file_import_previews WHERE tenant_id=$1 ORDER BY created_at,id',
        [state.tenant],
      )
    ).rows;
    await c.query('COMMIT');
    return { tables, products, executions, rows, previews };
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}
try {
  const health = (await (await fetch(api + '/health')).json()) as any;
  assert.equal(health.revision, revision);
  assert.equal(health.schema_revision, '117_language_file_imports');
  assert.equal(health.background_workers_enabled, false);
  assert.equal(health.restore_preview, false);
  if (phase === 'setup') {
    const suffix = randomUUID().slice(0, 8);
    state = {
      stage: 134,
      revision,
      email: 'qa-xml-134-' + suffix + '@demo.local',
      password: 'DynaXmlDemo!2026',
      pending: null,
      completed: [],
      products: [],
      setup_complete: false,
    };
    await save(true);
    await mutate(
      '/auth/signup',
      {
        email: state.email,
        password: state.password,
        name: 'QA134 Mapped XML',
        organization: { name: 'QA134 Mapped XML ' + suffix, currency: 'PLN', locale: 'pl-PL' },
      },
      'signup',
    );
    const w = (await (
      await fetch(api + '/warehouses', { headers: { cookie: state.cookie } })
    ).json()) as any;
    state.warehouse = w.data[0].id;
    for (let i = 0; i < 2; i++)
      await mutate(
        '/products',
        {
          sku: 'QA134-' + suffix + '-' + i,
          name: 'QA134 Original ' + i,
          description: 'Original description ' + i,
          price: 1200,
          vat: 23,
          quantity: 4,
          warehouse_id: state.warehouse,
          category: 'QA134',
        },
        'product',
      );
    const xml = (second: boolean) =>
      `<?xml version="1.0" encoding="UTF-8"?><s:feed xmlns:s="urn:dynaminds:qa134"><s:items>${state.products.map((p: any, i: number) => `<s:item code="${p.sku}"><s:name>${second && !i ? 'Produkt po uzgodnieniu' : 'Produkt XML ' + i}</s:name><s:description><![CDATA[Opis <b>XML</b> ${i} 雪]]></s:description><s:price>${i ? '20.05' : '10.23'}</s:price><s:stock>999</s:stock></s:item>`).join('')}</s:items></s:feed>`;
    await writeFile('docs/catalog-mapped-xml-native-first.xml', xml(false), { flag: 'wx' });
    await writeFile('docs/catalog-mapped-xml-native-second.xml', xml(true), { flag: 'wx' });
    const baseline = await snapshot();
    state.setup_complete = true;
    await save();
    await writeFile(
      'docs/catalog-mapped-xml-native-setup.json',
      JSON.stringify(
        {
          status: 'PASS',
          revision,
          tenant: state.tenant,
          user: state.user,
          email: state.email,
          warehouse: state.warehouse,
          baseline,
          fixture_sha256: createHash('sha256')
            .update(await readFile(path))
            .digest('hex'),
          provider_calls: false,
        },
        null,
        2,
      ) + '\n',
      { flag: 'wx' },
    );
    console.log({ status: 'SETUP_PASS', products: 2, tenant: state.tenant });
  } else {
    state = JSON.parse(await readFile(path, 'utf8'));
    assert(state.setup_complete && !state.pending);
    assert.equal(state.revision, revision);
    const setup = JSON.parse(await readFile('docs/catalog-mapped-xml-native-setup.json', 'utf8'));
    assert.equal(
      createHash('sha256')
        .update(await readFile(path))
        .digest('hex'),
      setup.fixture_sha256,
    );
    const actual = await snapshot();
    assert.equal(actual.executions.length, phase === 'first' ? 1 : 2);
    assert.equal(actual.products.length, 2);
    assert.deepEqual(
      actual.products.map((p) => p.price),
      [1023, 2005],
    );
    assert.deepEqual(
      actual.products.map((p) => p.version),
      phase === 'first' ? [2, 2] : [3, 2],
    );
    assert.deepEqual(
      actual.products.map((p) => p.name),
      phase === 'first'
        ? ['Produkt XML 0', 'Produkt XML 1']
        : ['Produkt po uzgodnieniu', 'Produkt XML 1'],
    );
    assert.deepEqual(
      actual.products.map((p) => p.description),
      [0, 1].map((i) => `Opis <b>XML</b> ${i} 雪`),
    );
    for (const name of [
      'stock',
      'stock_locations',
      'stock_movements',
      'reservations',
      'reservation_locations',
      'orders',
      'order_items',
      'product_translations',
      'price_list_items',
      'supplier_sources',
      'supplier_catalog_items',
    ]) {
      assert(actual.tables[name], 'Missing required preservation table ' + name);
      assert.deepEqual(
        actual.tables[name],
        setup.baseline.tables[name],
        'Unrelated data changed: ' + name,
      );
    }
    assert.equal(actual.rows.length, phase === 'first' ? 2 : 4);
    const allowed = new Set([
      'products',
      'audit_events',
      'catalog_file_import_previews',
      'catalog_file_import_rows',
      'catalog_file_import_executions',
      'catalog_file_import_execution_rows',
    ]);
    let unchangedTables = 0;
    for (const [name, fingerprint] of Object.entries(actual.tables)) {
      if (allowed.has(name)) continue;
      assert.deepEqual(
        fingerprint,
        setup.baseline.tables[name],
        'Unrelated own table changed: ' + name,
      );
      unchangedTables++;
    }
    const expectedMapping = {
      record_path: '/s:feed/s:items/s:item',
      fields: {
        sku: { path: '@code', value_type: 'text' },
        name: { path: 's:name', value_type: 'text' },
        description: { path: 's:description', value_type: 'text' },
        price_minor: { path: 's:price', value_type: 'decimal_money' },
      },
    };
    assert(
      actual.previews.every(
        (p) =>
          p.ready && p.total === 2 && p.config.xml_mapping.record_path === '/s:feed/s:items/s:item',
      ),
    );
    for (const preview of actual.previews)
      assert.deepEqual(preview.config.xml_mapping, expectedMapping);
    for (const [i, execution] of actual.executions.entries()) {
      const rows = actual.rows
        .filter((r) => r.execution_id === execution.id)
        .sort((a, b) => a.index - b.index);
      assert.equal(rows.length, 2);
      for (const [j, row] of rows.entries()) {
        assert.equal(row.product_id, state.products[j].id);
        assert.equal(row.preview_id, execution.preview_id);
        assert.equal(row.before_version, i ? 2 : 1);
        assert.equal(row.after_version, i ? (j ? 2 : 3) : 2);
        assert.equal(row.operation, i && j ? 'unchanged' : 'update');
        assert.equal(row.after.price, j ? 2005 : 1023);
        assert.equal(row.after.name, i && !j ? 'Produkt po uzgodnieniu' : 'Produkt XML ' + j);
      }
    }
    const e = actual.executions.at(-1)!;
    assert.equal(e.updated, phase === 'first' ? 2 : 1);
    assert.equal(e.unchanged, phase === 'first' ? 0 : 1);
    if (phase === 'second') {
      const first = JSON.parse(
        await readFile('docs/catalog-mapped-xml-native-first-readback.json', 'utf8'),
      );
      // SQL timestamps are Date objects; the saved checkpoint contains their exact ISO strings.
      assert.deepEqual(JSON.parse(JSON.stringify(actual.executions[0])), first.actual.executions[0]);
      assert.deepEqual(
        JSON.parse(JSON.stringify(actual.rows.filter((r) => r.execution_id === actual.executions[0].id))),
        first.actual.rows,
      );
    }
    await writeFile(
      `docs/catalog-mapped-xml-native-${phase}-readback.json`,
      JSON.stringify(
        {
          status: 'PASS',
          revision,
          tenant: state.tenant,
          phase,
          actual,
          unchanged_own_tables: unchangedTables,
          allowed_changed_tables: [...allowed],
          preserved_physical_and_supplier_scope: true,
          source_availability_not_imported: true,
          provider_calls: false,
          full_goal_complete: false,
        },
        null,
        2,
      ) + '\n',
      { flag: 'wx' },
    );
    console.log({
      status: 'READBACK_PASS',
      phase,
      executions: actual.executions.length,
      rows: actual.rows.length,
    });
  }
} finally {
  await pool.end();
}
