import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed } from './fixtures';
import { catalogXmlValue } from '../server/catalog-export';
import { languageFileImportRequestHash } from '../server/language-file-import';
import {
  createProductTranslationBulkEditPreviewInTx,
  productTranslationBulkEditHash,
} from '../server/product-translation-bulk-edit';

assert.equal(process.env.DYNA_TEST, 'true');
assert.match(new URL(process.env.DATABASE_URL!).pathname, /^\/dynaminds_test_\d+$/);
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie = '',
  tenant = '',
  user = '',
  ip = 0;
const root = '/language-file-imports';
const req = (path: string, method: any = 'GET', payload?: any) =>
  app.inject({
    method,
    url: '/api' + path,
    payload,
    headers: { cookie },
    remoteAddress: '127.117.1.' + ip,
  });
async function ok(path: string, method: any = 'GET', payload?: any, status = 200) {
  const r = await req(path, method, payload);
  assert.equal(r.statusCode, status, method + ' ' + path + ': ' + r.body);
  assert.equal(r.headers['cache-control'], 'no-store');
  return r.json() as any;
}
const tx = <T>(fn: (c: PoolClient) => Promise<T>) => tenantTx(tenant, fn);
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({
    integrationTransport: async () => {
      throw Error('File import must not contact providers');
    },
  });
  app.log.error = (entry: unknown) => {
    process.stderr.write('Language import request failure: ' + JSON.stringify(entry) + '\n');
  };
  app.addHook('onError', (request, _reply, error, done) => {
    const failure = error as Error & { code?: string; where?: string };
    if (request.url.startsWith('/api' + root) && failure.code?.match(/^[0-9A-Z]{5}$/))
      process.stderr.write(
        'Language import SQL diagnostic: ' +
          JSON.stringify({ code: failure.code, where: failure.where }) +
          '\n',
      );
    done();
  });
  const login = await req('/auth/login', 'POST', {
    email: 'admin@demo.local',
    password: 'DynaDemo!2026',
  });
  assert.equal(login.statusCode, 200);
  cookie = String(login.headers['set-cookie']).split(';')[0];
  user = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
});
beforeEach(async () => {
  ip++;
  tenant = randomUUID();
  await pool.query(
    "INSERT INTO tenants(id,name,plan) VALUES($1,'QA language file imports','enterprise')",
    [tenant],
  );
  await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [
    tenant,
    user,
  ]);
  const switched = await req('/workspaces/switch', 'POST', { tenant_id: tenant });
  assert.equal(switched.statusCode, 200);
  cookie = String(switched.headers['set-cookie']).split(';')[0];
});
after(async () => {
  try {
    await app?.close();
  } finally {
    await pool.end();
  }
});
async function products(n = 1) {
  const ids = Array.from({ length: n }, () => randomUUID());
  await tx((c) =>
    c.query(
      `INSERT INTO products(id,tenant_id,sku,name,description,price,vat,category,attributes) SELECT id,$1,'LF-'||id,'Base name','Base description',1234,23,'Original','{"material":"cotton"}'::jsonb FROM unnest($2::uuid[]) id`,
      [tenant, ids],
    ),
  );
  return ids.map((id) => ({ id, sku: 'LF-' + id }));
}
const definition = (locales = ['de', 'en']) => ({
  format: 'csv',
  mode: 'columns',
  delimiter: ';',
  spreadsheet_safe: false,
  spreadsheet_text_prefix: 'reject_ambiguous',
  identity: 'sku',
  mapping: { identity: 'SKU' },
  languages: locales.map((locale) => ({
    locale,
    mapping: {
      name: locale + '_name',
      description: locale + '_description',
      operation: locale + '_op',
    },
    empty_name: 'preserve',
    empty_description: 'preserve',
  })),
});
const csv = (records: string[][]) =>
  records.map((row) => row.map((v) => '"' + v.replaceAll('"', '""') + '"').join(';')).join('\r\n');
const content = (rows: string[][], locales = ['de', 'en']) =>
  csv([['SKU', ...locales.flatMap((l) => [l + '_name', l + '_description', l + '_op'])], ...rows]);
async function preview(text: string, d = definition(), extra: any = {}) {
  const input = { client_key: randomUUID(), content: text, definition: d, ...extra };
  const response = await ok(root + '/previews', 'POST', input, 201);
  return { input, response, head: response.preview };
}
async function rows(id: string, execution = false) {
  const data: any[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await ok(
      root +
        (execution ? '/executions/' : '/previews/') +
        id +
        '/rows' +
        (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''),
    );
    assert(page.data.length <= 50);
    data.push(...page.data);
    cursor = page.meta.cursor;
    if (cursor) {
      assert(!seen.has(cursor));
      seen.add(cursor);
    }
    if (!cursor) assert.equal(data.length, page.meta.total);
  } while (cursor);
  assert.deepEqual(
    data.map((r) => r.index),
    data.map((_, i) => i),
  );
  return data;
}
const consent = (head: any, codes: string[] = []) => ({
  client_key: randomUUID(),
  scope_hash: head.scope_hash,
  confirmed: true,
  ack_missing_locale_codes: codes,
});
async function execute(head: any, codes: string[] = []) {
  const input = consent(head, codes);
  const response = await ok(root + '/previews/' + head.id + '/execute', 'POST', input, 201);
  return { input, response, head: response.execution };
}
async function evidence() {
  return tx(async (c) => {
    const result: Record<string, unknown> = {};
    for (const t of [
      'products',
      'product_translations',
      'language_file_import_previews',
      'language_file_import_rows',
      'language_file_import_executions',
      'language_file_import_execution_rows',
      'product_translation_bulk_edit_previews',
      'product_translation_bulk_edit_rows',
      'product_translation_bulk_edit_executions',
      'product_translation_bulk_edit_execution_rows',
      'audit_events',
      'jobs',
    ])
      result[t] = (await c.query(`SELECT to_jsonb(x) value FROM ${t} x ORDER BY 1`)).rows;
    return result;
  });
}

test('language file complete CSV matrix, real receipts, linked history and exact inert replay', async () => {
  const p = await products(3);
  const text =
    '\ufeff' +
    content(
      p.map((r, i) => [
        r.sku,
        'Nazwa "DE" ' + i,
        'Łódź\r\nOpis "DE"',
        'set',
        'English ' + i,
        'English description',
        'set',
      ]),
    );
  const plan = await preview(text);
  assert.equal(plan.head.source_hash, createHash('sha256').update(text, 'utf8').digest('hex'));
  assert.equal(plan.head.summary.total_pairs, 6);
  assert.equal(plan.head.summary.changed_pairs, 6);
  assert.equal(plan.head.can_execute, true);
  const full = await rows(plan.head.id);
  assert.equal(full.length, 6);
  assert(full.every((r) => r.status === 'changed' && r.core_index !== null));
  const applied = await execute(plan.head);
  const receipts = await rows(applied.head.id, true);
  assert.equal(receipts.length, 6);
  assert(receipts.every((r) => r.core_receipt_id));
  const actual = await tx((c) =>
    c.query(
      'SELECT p.version,p.name,p.description,t.locale,t.manual_receipt_id,t.name translated_name,t.description translated_description FROM products p JOIN product_translations t ON (t.tenant_id,t.product_id)=(p.tenant_id,p.id) ORDER BY p.id,t.locale',
    ),
  );
  assert.equal(actual.rowCount, 6);
  assert(
    actual.rows
      .filter((r) => r.locale === 'de')
      .every(
        (r) =>
          /^Nazwa "DE" [0-2]$/.test(r.translated_name) &&
          r.translated_description === 'Łódź\r\nOpis "DE"',
      ),
  );
  assert(
    actual.rows.every(
      (r) =>
        r.version === 2 &&
        r.name === 'Base name' &&
        r.description === 'Base description' &&
        r.manual_receipt_id,
    ),
  );
  const before = await evidence();
  const replay = await ok(root + '/previews/' + plan.head.id + '/execute', 'POST', applied.input);
  assert.equal(replay.reused, true);
  assert.equal(replay.execution.id, applied.head.id);
  const previewReplay = await ok(root + '/previews', 'POST', plan.input);
  assert.equal(previewReplay.preview.executed_execution_id, applied.head.id);
  assert.equal(previewReplay.preview.can_execute, false);
  assert.deepEqual(await evidence(), before);
  const detail = await ok(root + '/previews/' + plan.head.id);
  assert.equal(detail.preview.executed_execution_id, applied.head.id);
  assert.equal((await ok(root + '/executions/' + applied.head.id)).execution.state, 'done');
  assert((await ok(root + '/previews')).data.some((r: any) => r.id === plan.head.id));
  assert((await ok(root + '/executions')).data.some((r: any) => r.id === applied.head.id));
});

test('language file partial patch, explicit description clear and remove require the exact locale ACK', async () => {
  const [p] = await products();
  await execute(
    (
      await preview(
        content([
          [p.sku, 'Deutsch', 'Preserved description', 'set', 'English', 'Old description', 'set'],
        ]),
      )
    ).head,
  );
  const d = definition();
  d.languages[0].empty_description = 'clear';
  const plan = await preview(content([[p.sku, 'Geändert', '', 'set', '', '', 'remove']]), d);
  assert.equal(plan.head.summary.missing_after_count, 1);
  const before = await evidence();
  assert.equal(
    (await req(root + '/previews/' + plan.head.id + '/execute', 'POST', consent(plan.head)))
      .statusCode,
    422,
  );
  assert.equal(
    (
      await req(
        root + '/previews/' + plan.head.id + '/execute',
        'POST',
        consent(plan.head, ['de', 'en']),
      )
    ).statusCode,
    422,
  );
  assert.deepEqual(await evidence(), before);
  const applied = await execute(plan.head, ['en']);
  assert.deepEqual(applied.head.ack_missing_locale_codes, ['en']);
  const translated = await tx((c) =>
    c.query('SELECT locale,name,description FROM product_translations'),
  );
  assert.deepEqual(translated.rows, [{ locale: 'de', name: 'Geändert', description: '' }]);
  assert.equal((await tx((c) => c.query('SELECT version FROM products'))).rows[0].version, 3);
});

test('language file native XML uses current CAS, preserves unselected languages and accepts Unicode text', async () => {
  const [p] = await products();
  const translations = [
    { locale: 'de', name: 'Łódź Ω', description: 'Opis\n雪', version: 99 },
    { locale: 'it', name: 'Ignorato', description: 'Unselected', version: 7 },
  ];
  const text =
    '<catalog currency="PLN"><product>' +
    [...catalogXmlValue('sku', p.sku), ...catalogXmlValue('translations_json', translations)].join(
      '',
    ) +
    '</product></catalog>';
  const d: any = {
    format: 'xml',
    mode: 'translations_json',
    delimiter: ';',
    spreadsheet_safe: false,
    identity: 'sku',
    mapping: { identity: 'sku', translations_json: 'translations_json' },
    languages: [{ locale: 'de', empty_name: 'preserve', empty_description: 'preserve' }],
  };
  const plan = await preview(text, d);
  const full = await rows(plan.head.id);
  assert.equal(full[0].source_translation_version, 99);
  assert.equal(full[0].input.translation_version, null);
  assert.equal(plan.head.summary.skipped_locale_entries, 1);
  await execute(plan.head);
  const actual = await tx((c) =>
    c.query('SELECT locale,name,description,version FROM product_translations'),
  );
  assert.deepEqual(actual.rows, [
    { locale: 'de', name: 'Łódź Ω', description: 'Opis\n雪', version: 1 },
  ]);
});

test('language file invalid source is retained wholly and never gives a partly executable core preview', async () => {
  const p = await products(2);
  const plan = await preview(
    content([
      [p[0].sku, 'Valid DE', '', 'set', 'Valid EN', '', 'set'],
      ['UNKNOWN', 'Bad source', '', 'set', 'Bad source', '', 'set'],
      [p[1].sku, 'Valid later', '', 'set', 'Valid later', '', 'set'],
    ]),
  );
  assert.equal(plan.head.core_preview_id, null);
  assert.equal(plan.head.summary.ready, false);
  const full = await rows(plan.head.id);
  assert.equal(full.length, 6);
  assert(full.some((r) => r.status === 'invalid' && r.raw_cells.SKU === 'UNKNOWN'));
  const before = await evidence();
  assert.equal(
    (await req(root + '/previews/' + plan.head.id + '/execute', 'POST', consent(plan.head)))
      .statusCode,
    409,
  );
  assert.deepEqual(await evidence(), before);
  assert.equal(
    (await tx((c) => c.query('SELECT id FROM product_translation_bulk_edit_previews'))).rowCount,
    0,
  );
});

test('language file stale product rejects the whole operation and the ordinary core endpoint cannot bypass file custody', async () => {
  const [p] = await products();
  const plan = await preview(content([[p.sku, 'Deutsch', '', 'set', 'English', '', 'set']]));
  assert(plan.head.core_preview_id);
  const coreHead = (
    await req('/product-translation-bulk-edit/previews/' + plan.head.core_preview_id)
  ).json() as any;
  const before = await evidence();
  const bypass = await req(
    '/product-translation-bulk-edit/previews/' + plan.head.core_preview_id + '/execute',
    'POST',
    {
      client_key: randomUUID(),
      scope_hash: coreHead.preview.scope_hash,
      confirmed: true,
      ack_missing_translations: false,
    },
  );
  assert.equal(bypass.statusCode, 409);
  assert.deepEqual(await evidence(), before);
  await tx((c) =>
    c.query("UPDATE products SET name='Changed source',version=version+1 WHERE id=$1", [p.id]),
  );
  const changed = await evidence();
  assert.equal(
    (await req(root + '/previews/' + plan.head.id + '/execute', 'POST', consent(plan.head)))
      .statusCode,
    409,
  );
  assert.deepEqual(await evidence(), changed);
});

test('language file profiles preserve CAS revisions and exact retry after later edits', async () => {
  const input = { client_key: randomUUID(), name: 'Mapa dwóch języków', definition: definition() };
  const saved = await ok(root + '/profiles', 'POST', input, 201);
  assert.equal(saved.profile.version, 1);
  const update = {
    client_key: randomUUID(),
    version: 1,
    name: 'Mapa zmieniona',
    definition: definition(),
    archived: false,
  };
  const changed = await ok(root + '/profiles/' + saved.profile.id, 'PATCH', update);
  assert.equal(changed.profile.version, 2);
  assert.equal(
    (
      await req(root + '/profiles/' + saved.profile.id, 'PATCH', {
        ...update,
        client_key: randomUUID(),
      })
    ).statusCode,
    409,
  );
  const archived = await ok(root + '/profiles/' + saved.profile.id, 'PATCH', {
    ...update,
    client_key: randomUUID(),
    version: 2,
    archived: true,
  });
  assert.equal(archived.profile.version, 3);
  const replay = await ok(root + '/profiles/' + saved.profile.id, 'PATCH', update);
  assert.equal(replay.reused, true);
  assert.equal(replay.profile.version, 2);
  assert.equal((await ok(root + '/profiles/' + saved.profile.id)).profile.version, 3);
  assert((await ok(root + '/profiles')).data.some((r: any) => r.id === saved.profile.id));
  const [p] = await products();
  const rejected = await req(root + '/previews', 'POST', {
    client_key: randomUUID(),
    content: content([[p.sku, 'Deutsch', '', 'set', 'English', '', 'set']]),
    definition: definition(),
    profile: { id: saved.profile.id, version: 2 },
  });
  assert.equal(rejected.statusCode, 409);
});

test('language file fresh ACL also governs completed replay and public evidence is SELECT only', async () => {
  const [p] = await products();
  const plan = await preview(content([[p.sku, 'Deutsch', '', 'set', 'English', '', 'set']]));
  const applied = await execute(plan.head);
  await pool.query("UPDATE memberships SET role='viewer' WHERE (tenant_id,user_id)=($1,$2)", [
    tenant,
    user,
  ]);
  assert.equal(
    (await req(root + '/previews/' + plan.head.id + '/execute', 'POST', applied.input)).statusCode,
    403,
  );
  const options = await ok(root + '/options');
  assert.equal(options.current_role, 'viewer');
  assert.equal(options.can_write, false);
  await assert.rejects(
    tx((c) => c.query('DELETE FROM language_file_import_previews')),
    (e: any) => e.code === '42501',
  );
  await assert.rejects(
    tx((c) => c.query('SELECT * FROM language_file_import_admissions')),
    (e: any) => e.code === '42501',
  );
  const other = randomUUID();
  await pool.query(
    "INSERT INTO tenants(id,name,plan) VALUES($1,'QA other language firm','enterprise')",
    [other],
  );
  const foreign = await tenantTx(other, (c) =>
    c.query('SELECT id FROM language_file_import_previews'),
  );
  assert.equal(foreign.rowCount, 0);
});

test('language file full 500 by six matrix is applied atomically and every row page remains available', async () => {
  const p = await products(500);
  const locales = ['cs', 'de', 'en', 'fr', 'it', 'pl'];
  const plan = await preview(
    content(
      p.map((r, i) => [r.sku, ...locales.flatMap((l) => [l + ' name ' + i, l + ' desc', 'set'])]),
      locales,
    ),
    definition(locales),
  );
  assert.equal(plan.head.summary.total_pairs, 3000);
  assert.equal((await rows(plan.head.id)).length, 3000);
  const applied = await execute(plan.head);
  assert.equal((await rows(applied.head.id, true)).length, 3000);
  const actual = await tx((c) => c.query('SELECT count(*)::int n FROM product_translations'));
  assert.equal(actual.rows[0].n, 3000);
  assert.equal(
    (await tx((c) => c.query('SELECT count(*)::int n FROM products WHERE version=2'))).rows[0].n,
    500,
  );
});

test('language file strict input rejects overrides and restore read-only refuses malformed JSON before parsing', async () => {
  const [p] = await products();
  const input = {
    client_key: randomUUID(),
    content: content([[p.sku, 'Deutsch', '', 'set', 'English', '', 'set']]),
    definition: definition(),
  };
  const before = await evidence();
  assert.equal(
    (await req(root + '/previews', 'POST', { ...input, product_id: p.id })).statusCode,
    422,
  );
  assert.equal(
    (
      await req(root + '/previews', 'POST', {
        ...input,
        definition: { ...input.definition, product_version: 1 },
      })
    ).statusCode,
    422,
  );
  assert.equal(
    (
      await req(root + '/profiles', 'POST', {
        client_key: randomUUID(),
        name: 'Mapa',
        definition: definition(),
        content: input.content,
      })
    ).statusCode,
    422,
  );
  assert.deepEqual(await evidence(), before);
  const ro = await buildApp({
    readOnly: true,
    integrationTransport: async () => {
      throw Error('Read-only cannot contact providers');
    },
  });
  try {
    const login = await ro.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' },
    });
    assert.equal(login.statusCode, 200);
    const roCookie = String(login.headers['set-cookie']).split(';')[0];
    const switched = await ro.inject({
      method: 'POST',
      url: '/api/workspaces/switch',
      headers: { cookie: roCookie },
      payload: { tenant_id: tenant },
    });
    assert.equal(switched.statusCode, 200);
    const previewCookie = String(switched.headers['set-cookie']).split(';')[0];
    const response = await ro.inject({
      method: 'POST',
      url: '/api' + root + '/previews',
      headers: { cookie: previewCookie, 'content-type': 'application/json' },
      payload: '{',
    });
    assert.equal(response.statusCode, 423);
    assert.equal(response.headers['cache-control'], 'no-store');
    const options = (
      await ro.inject({
        method: 'GET',
        url: '/api' + root + '/options',
        headers: { cookie: previewCookie },
      })
    ).json() as any;
    assert.equal(options.read_only, true);
    assert.equal(options.can_write, false);
  } finally {
    await ro.close();
  }
  assert.deepEqual(await evidence(), before);
});

test('language file withdrawal during a genuine product lock wait rejects the complete preview', async () => {
  const [p] = await products();
  const input = {
    client_key: randomUUID(),
    content: content([[p.sku, 'Deutsch', '', 'set', 'English', '', 'set']]),
    definition: definition(),
  };
  const before = await evidence();
  const blocker = await pool.connect();
  let waiting: ReturnType<typeof req> | undefined;
  try {
    await blocker.query('BEGIN');
    const pid = (await blocker.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    await blocker.query('SELECT id FROM products WHERE id=$1 FOR UPDATE', [p.id]);
    waiting = req(root + '/previews', 'POST', input);
    let observed = false;
    for (let i = 0; i < 100 && !observed; i++) {
      observed = !!(
        await pool.query(
          `SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))`,
          [pid],
        )
      ).rowCount;
      if (!observed) await new Promise((r) => setTimeout(r, 10));
    }
    assert(observed, 'A real importer backend must be blocked by the held own product row');
    await pool.query("UPDATE memberships SET role='viewer' WHERE (tenant_id,user_id)=($1,$2)", [
      tenant,
      user,
    ]);
    await blocker.query('COMMIT');
    assert.equal((await waiting).statusCode, 403);
    assert.deepEqual(await evidence(), before);
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
    if (waiting) await waiting;
  }
});

test('language file Unicode header keys keep the same canonical hash in TypeScript and SQL', async () => {
  const [p] = await products();
  const d = definition(['de']);
  d.languages[0].mapping.name = '\u{10000}';
  d.languages[0].mapping.description = '\ue000';
  const plan = await preview(
    csv([
      ['SKU', '\u{10000}', '\ue000', 'de_op'],
      [p.sku, 'Nazwa Unicode', 'Opis 雪 Ω', 'set'],
    ]),
    d,
  );
  assert.equal(plan.head.summary.ready, true);
  await execute(plan.head);
  const actual = await tx((c) => c.query('SELECT name,description FROM product_translations'));
  assert.deepEqual(actual.rows, [{ name: 'Nazwa Unicode', description: 'Opis 雪 Ω' }]);
});

test('language file SQL refuses forged text even with a genuine fresh core witness and matching hashes', async () => {
  const [p] = await products();
  const plan = await preview(
    content([[p.sku, 'Deutsch source', '', 'set', 'English source', '', 'set']]),
  );
  const frozen = (
    await tx((c) =>
      c.query('SELECT payload FROM language_file_import_previews WHERE id=$1', [plan.head.id]),
    )
  ).rows[0].payload;
  const before = await evidence();
  const actor = { tenantId: tenant, userId: user, role: 'admin' as const };
  await assert.rejects(
    tx(async (c) => {
      const v = JSON.parse(JSON.stringify(frozen));
      const id = randomUUID();
      v.id = id;
      v.client_key = randomUUID();
      v.request.client_key = v.client_key;
      const fakeInputs = v.rows.map((r: any) => ({
        ...r.input,
        patch: { ...r.input.patch, name: 'Forged approved text' },
      }));
      const core = await createProductTranslationBulkEditPreviewInTx(
        c,
        actor,
        { client_key: id, locales: ['de', 'en'], rows: fakeInputs },
        'manual',
        { deferConstraintFinalization: true },
      );
      const real = (
        await c.query(
          'SELECT * FROM product_translation_bulk_edit_rows WHERE preview_id=$1 ORDER BY index',
          [core.preview.id],
        )
      ).rows;
      v.core_preview_id = core.preview.id;
      for (let i = 0; i < v.rows.length; i++) {
        Object.assign(v.rows[i], {
          input: real[i].input,
          before: real[i].before,
          after: real[i].after,
          status: real[i].status,
          errors: real[i].errors,
          core_index: real[i].index,
          receipt_id: real[i].receipt_id,
        });
      }
      v.request_hash = languageFileImportRequestHash(actor, 'preview', null, v.request);
      delete v.scope_hash;
      v.scope_hash = productTranslationBulkEditHash(v);
      await c.query('SELECT language_file_import_store_preview($1,$2,NULL)', [
        JSON.stringify(v),
        user,
      ]);
    }),
    (e: any) => e.code === '23514' && e.message.includes('Źródłowy tekst lub operacja'),
  );
  assert.deepEqual(await evidence(), before);
});

test('language file installed but torn guards fail closed for cached and newly built apps', async () => {
  const [p] = await products();
  const before = await evidence();
  let fresh: Awaited<ReturnType<typeof buildApp>> | undefined;
  await pool.query('ALTER TABLE products DISABLE TRIGGER language_file_import_seal');
  try {
    const options = await req(root + '/options');
    assert.equal(options.statusCode, 503, options.body);
    assert.equal(options.headers['cache-control'], 'no-store');
    const write = await req(root + '/previews', 'POST', {
      client_key: randomUUID(),
      content: content([[p.sku, 'Deutsch', '', 'set', 'English', '', 'set']]),
      definition: definition(),
    });
    assert.equal(write.statusCode, 503, write.body);
    fresh = await buildApp();
    const absent = await fresh.inject({
      method: 'GET',
      url: '/api' + root + '/options',
      headers: { cookie },
    });
    assert.equal(absent.statusCode, 503, absent.body);
    assert.equal(absent.headers['cache-control'], 'no-store');
    assert.deepEqual(await evidence(), before);
  } finally {
    await fresh?.close();
    await pool.query('ALTER TABLE products ENABLE TRIGGER language_file_import_seal');
  }
  assert.equal((await ok(root + '/options')).available, true);
  await pool.query(
    'ALTER FUNCTION language_file_import_installed() RENAME TO language_file_import_installed_hidden_test',
  );
  let withoutMarker: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    withoutMarker = await buildApp();
    const missingMarker = await withoutMarker.inject({
      method: 'GET',
      url: '/api' + root + '/options',
      headers: { cookie },
    });
    assert.equal(missingMarker.statusCode, 503, missingMarker.body);
    assert.deepEqual(await evidence(), before);
  } finally {
    await withoutMarker?.close();
    await pool.query(
      'ALTER FUNCTION language_file_import_installed_hidden_test() RENAME TO language_file_import_installed',
    );
  }
});

test('language file uppercase UUID paths are canonical for execution and profile CAS replay', async () => {
  const [p] = await products();
  const plan = await preview(content([[p.sku, 'Deutsch', '', 'set', 'English', '', 'set']]));
  const input = consent(plan.head);
  const applied = await ok(
    root + '/previews/' + plan.head.id.toUpperCase() + '/execute',
    'POST',
    input,
    201,
  );
  const replay = await ok(root + '/previews/' + plan.head.id + '/execute', 'POST', input, 200);
  assert.equal(applied.execution.id, replay.execution.id);
  const created = await ok(
    root + '/profiles',
    'POST',
    { client_key: randomUUID(), name: 'Uppercase URL', definition: definition() },
    201,
  );
  const changed = {
    client_key: randomUUID(),
    version: 1,
    name: 'Canonical UUID',
    definition: definition(),
    archived: false,
  };
  const updated = await ok(
    root + '/profiles/' + created.profile.id.toUpperCase(),
    'PATCH',
    changed,
  );
  const old = await ok(root + '/profiles/' + created.profile.id, 'PATCH', changed);
  assert.equal(updated.profile.version, 2);
  assert.equal(old.profile.version, 2);
  assert.equal(old.reused, true);
});

test('language file public API binds replay and execution to the current scoped API key', async () => {
  const specResponse = await req('/developer/openapi');
  assert.equal(specResponse.statusCode, 200, specResponse.body);
  const spec = specResponse.json() as any;
  assert.equal(
    Object.entries(spec.paths)
      .filter(([path]) => path.startsWith(root))
      .reduce((n, [, operations]) => n + Object.keys(operations as object).length, 0),
    13,
  );
  assert.deepEqual(spec.paths[root + '/previews/{id}/execute'].post['x-required-scopes'], [
    'products:read',
    'products:write',
  ]);
  assert(
    spec.paths[root + '/previews/{id}/rows'].get.parameters.some((p: any) => p.name === 'cursor'),
  );
  const [p] = await products();
  const mint = async (scopes: string[]) => {
    const r = await req('/developer/keys', 'POST', { name: 'QA language import key', scopes });
    assert.equal(r.statusCode, 201, r.body);
    return r.json() as any;
  };
  const a = await mint(['products:read', 'products:write']);
  const b = await mint(['products:read', 'products:write']);
  const read = await mint(['products:read']);
  const publicReq = (token: string, path: string, method: any = 'GET', payload?: any) =>
    app.inject({
      method,
      url: '/api/v1' + root + path,
      payload,
      headers: { authorization: 'Bearer ' + token },
      remoteAddress: '127.117.2.' + ip,
    });
  const body = {
    client_key: randomUUID(),
    content: content([[p.sku, 'Deutsch', '', 'set', 'English', '', 'set']]),
    definition: definition(),
  };
  const denied = await publicReq(read.token, '/previews', 'POST', body);
  assert.equal(denied.statusCode, 403, denied.body);
  const made = await publicReq(a.token, '/previews', 'POST', body);
  assert.equal(made.statusCode, 201, made.body);
  const head = made.json().preview;
  const before = await evidence();
  assert.equal((await publicReq(b.token, '/previews', 'POST', body)).statusCode, 409);
  assert.equal(
    (await publicReq(b.token, '/previews/' + head.id + '/execute', 'POST', consent(head)))
      .statusCode,
    409,
  );
  assert.deepEqual(await evidence(), before);
  const input = consent(head);
  const applied = await publicReq(a.token, '/previews/' + head.id + '/execute', 'POST', input);
  assert.equal(applied.statusCode, 201, applied.body);
  const revoked = await req('/developer/keys/' + a.id, 'DELETE');
  assert.equal(revoked.statusCode, 200, revoked.body);
  const frozen = await evidence();
  const replay = await publicReq(a.token, '/previews/' + head.id + '/execute', 'POST', input);
  assert.equal(replay.statusCode, 401, replay.body);
  assert.deepEqual(await evidence(), frozen);
});
