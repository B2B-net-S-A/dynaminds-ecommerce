/** Owned QA fixture only. No provider traffic, no existing firm changes, no automatic retry. */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, rename, lstat } from 'node:fs/promises';
import { pool } from '../server/db';
import { catalogXmlValue } from '../server/catalog-export';
const phase = process.argv[2];
assert(['setup', 'readback', 'xml-fixture', 'xml-readback'].includes(phase ?? ''));
assert.notEqual(process.env.DYNA_TEST, 'true');
const statePath = 'data/language-file-import-stage133.json';
const revision = '1cd31084d129e71c7a588e435b8a9e426be0f3d6';
const api = 'http://127.0.0.1:4100/api';
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
let state: any;
async function save(initial = false) {
  const content = JSON.stringify(state, null, 2) + '\n';
  if (initial) await writeFile(statePath, content, { flag: 'wx', mode: 0o600 });
  else {
    assert.equal((await lstat(statePath)).mode & 0o777, 0o600);
    const temp = statePath + '.write-' + randomUUID();
    await writeFile(temp, content, { flag: 'wx', mode: 0o600 });
    await rename(temp, statePath);
  }
}
async function mutate(path: string, body: unknown, kind: string) {
  assert.equal(state.pending, null);
  state.pending = { path, body, kind, started_at: new Date().toISOString() };
  await save();
  const response = await fetch(api + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(state.cookie ? { cookie: state.cookie } : {}),
    },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  const result = (await response.json()) as any;
  assert.equal(response.status, 201, 'QA mutation failed: ' + kind);
  state.pending.received = { status: response.status, body: result };
  if (response.headers.get('set-cookie'))
    state.cookie = response.headers.get('set-cookie')!.split(';')[0];
  await save();
  if (kind === 'signup') {
    state.tenant = result.user.tenant_id;
    state.user = result.user.id;
  } else state.products.push(result);
  state.completed.push(state.pending);
  state.pending = null;
  await save();
}
try {
  const health = (await (await fetch(api + '/health')).json()) as any;
  assert.equal(health.revision, revision);
  assert.equal(health.schema_revision, '117_language_file_imports');
  assert.equal(health.background_workers_enabled, false);
  assert.equal(health.language_file_import_available, true);
  if (phase === 'setup') {
    const suffix = randomUUID().slice(0, 8);
    state = {
      stage: 133,
      revision,
      email: 'qa-language-133-' + suffix + '@demo.local',
      password: 'DynaLanguageDemo!2026',
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
        name: 'QA133 Language Import',
        organization: { name: 'QA133 Language files ' + suffix, currency: 'PLN', locale: 'pl-PL' },
      },
      'signup',
    );
    const warehouses = (await (
      await fetch(api + '/warehouses', { headers: { cookie: state.cookie } })
    ).json()) as any;
    assert.equal(warehouses.data.length, 1);
    for (let i = 0; i < 2; i++)
      await mutate(
        '/products',
        {
          sku: 'QA133-' + suffix + '-' + i,
          name: 'QA133 Base ' + i,
          description: 'Original description ' + i,
          price: 1234,
          vat: 23,
          quantity: 0,
          warehouse_id: warehouses.data[0].id,
          category: 'QA133',
        },
        'product',
      );
    const csv = [
      ['SKU', 'de_name', 'de_description', 'de_op', 'en_name', 'en_description', 'en_op'],
      ...state.products.map((p: any, i: number) => [
        p.sku,
        'Deutsch ' + i,
        'Łódź\r\nOpis "DE" ' + i,
        'set',
        i ? '' : 'English ' + i,
        i ? '' : 'English description ' + i,
        i ? 'remove' : 'set',
      ]),
    ]
      .map((r) => r.map((v: string) => '"' + v.replaceAll('"', '""') + '"').join(';'))
      .join('\r\n');
    const xml =
      '<catalog currency="PLN"><product>' +
      [...catalogXmlValue('sku', state.products[0].sku)].join('') +
      [
        ...catalogXmlValue('translations_json', [
          { locale: 'de', name: 'Deutsch XML', description: 'Opis XML 雪', version: 99 },
        ]),
      ].join('') +
      '</product></catalog>';
    await writeFile('docs/language-file-import-native.csv', '\ufeff' + csv, { flag: 'wx' });
    await writeFile('docs/language-file-import-native.xml', xml, { flag: 'wx' });
    state.setup_complete = true;
    await save();
    await writeFile(
      'docs/language-file-import-native-setup.json',
      JSON.stringify(
        {
          status: 'PASS',
          revision,
          tenant: state.tenant,
          user: state.user,
          products: state.products.map((p: any) => ({ id: p.id, sku: p.sku })),
          email: state.email,
          fixture_sha256: createHash('sha256')
            .update(await readFile(statePath))
            .digest('hex'),
          csv_sha256: createHash('sha256')
            .update(await readFile('docs/language-file-import-native.csv'))
            .digest('hex'),
          xml_sha256: createHash('sha256')
            .update(await readFile('docs/language-file-import-native.xml'))
            .digest('hex'),
          provider_calls: false,
        },
        null,
        2,
      ) + '\n',
      { flag: 'wx' },
    );
    console.log({
      status: 'SETUP_PASS',
      tenant: state.tenant,
      products: 2,
      import_executed: false,
    });
  } else if (phase === 'xml-fixture') {
    state = JSON.parse(await readFile(statePath, 'utf8'));
    assert(state.setup_complete && !state.pending);
    const xml =
      '<catalog currency="PLN"><product>' +
      [...catalogXmlValue('sku', state.products[0].sku)].join('') +
      [
        ...catalogXmlValue('translations_json', [
          { locale: 'de', name: 'Deutsch XML', description: 'Opis XML 雪', version: 99 },
        ]),
      ].join('') +
      '</product></catalog>';
    assert(!xml.includes('[object Generator]'));
    await writeFile('docs/language-file-import-native-valid.xml', xml, { flag: 'wx' });
    console.log({
      status: 'XML_FIXTURE_PASS',
      bytes: Buffer.byteLength(xml),
      original_preserved: true,
    });
  } else {
    state = JSON.parse(await readFile(statePath, 'utf8'));
    assert(state.setup_complete && !state.pending);
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
        const key = n === 'tenants' || n === 'users' ? 'id' : 'tenant_id';
        const rows = (
          await c.query(`SELECT to_jsonb(t) row FROM "${n}" t WHERE ${key}=$1 ORDER BY 1`, [
            n === 'users' ? state.user : state.tenant,
          ])
        ).rows;
        tables[n] = { count: rows.length, sha256: hash(rows) };
      }
      const products = (
        await c.query(
          'SELECT id,sku,name,description,version FROM products WHERE tenant_id=$1 ORDER BY sku',
          [state.tenant],
        )
      ).rows;
      const translations = (
        await c.query(
          'SELECT product_id,locale,name,description,version,manual_receipt_id FROM product_translations WHERE tenant_id=$1 ORDER BY product_id,locale',
          [state.tenant],
        )
      ).rows;
      const executions = (
        await c.query(
          'SELECT id,preview_id,core_execution_id,payload FROM language_file_import_executions WHERE tenant_id=$1 ORDER BY created_at',
          [state.tenant],
        )
      ).rows;
      const profiles = (
        await c.query(
          'SELECT id,name,version,archived FROM language_file_import_profiles WHERE tenant_id=$1 ORDER BY created_at',
          [state.tenant],
        )
      ).rows;
      assert.equal(products.length, 2);
      products.forEach((p, i) => {
        assert.equal(p.name, 'QA133 Base ' + i);
        assert.equal(p.description, 'Original description ' + i);
      });
      assert.equal(executions.length, phase === 'xml-readback' ? 2 : 1);
      assert.deepEqual(executions[0].payload.ack_missing_locale_codes, ['en']);
      assert.equal(executions[0].payload.rows.length, 4);
      assert.equal(translations.length, 3);
      assert.equal(
        tables.language_file_import_execution_rows.count,
        phase === 'xml-readback' ? 5 : 4,
      );
      assert.equal(profiles.length, 1);
      assert.equal(profiles[0].version, 2);
      if (phase === 'xml-readback') {
        const csv = JSON.parse(
          await readFile('docs/language-file-import-native-csv-readback.json', 'utf8'),
        );
        assert.deepEqual(executions[0], csv.executions[0]);
        const changedId = state.products[0].id;
        assert.deepEqual(
          translations.filter((t) => t.product_id !== changedId || t.locale !== 'de'),
          csv.translations.filter((t: any) => t.product_id !== changedId || t.locale !== 'de'),
        );
        const de = translations.find((t) => t.product_id === changedId && t.locale === 'de');
        assert.equal(de?.name, 'Deutsch XML');
        assert.equal(de?.description, 'Opis XML 雪');
        assert.equal(de?.version, 2);
        assert.deepEqual(executions[1].payload.ack_missing_locale_codes, []);
        assert.equal(executions[1].payload.rows[0].source_translation_version, 99);
        assert.equal(executions[1].payload.rows[0].input.translation_version, 1);
        assert.deepEqual(
          products.map((p) => p.version),
          [3, 2],
        );
      } else assert(translations.every((t) => t.manual_receipt_id && t.version === 1));
      await c.query('COMMIT');
      await writeFile(
        phase === 'xml-readback'
          ? 'docs/language-file-import-native-xml-readback.json'
          : 'docs/language-file-import-native-csv-readback.json',
        JSON.stringify(
          {
            status: 'PASS',
            revision,
            tenant: state.tenant,
            products,
            translations,
            executions,
            profiles,
            tables,
            provider_calls: false,
            browser_attestation_separate: true,
          },
          null,
          2,
        ) + '\n',
        { flag: 'wx' },
      );
      console.log({
        status: phase === 'xml-readback' ? 'XML_READBACK_PASS' : 'CSV_READBACK_PASS',
        translations: 3,
        pairs: phase === 'xml-readback' ? 5 : 4,
        tables: names.length,
      });
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }
} finally {
  await pool.end();
}
