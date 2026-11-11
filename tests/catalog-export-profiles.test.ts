import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SaxesParser } from 'saxes';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed, DEMO_TENANT } from './fixtures';
import {
  catalogExportProfileCreateInput,
  catalogExportProfileHash,
  type CatalogExportProfile,
} from '../server/catalog-export-profiles';
import { CATALOG_EXPORT_COLUMNS } from '../server/catalog-export';

assert.equal(process.env.DYNA_TEST, 'true');
assert.match(new URL(process.env.DATABASE_URL!).pathname, /^\/dynaminds_test_\d+$/);
let app: Awaited<ReturnType<typeof buildApp>> | undefined,
  cookie = '',
  warehouse = '',
  user = '';
let providerCalls = 0;
const prefix = 'QA115-' + randomUUID().slice(0, 8);
type Method = 'GET' | 'POST' | 'PATCH';
const request = (path: string, method: Method = 'GET', payload?: Record<string, unknown>) => {
  assert(app);
  return app.inject({
    url: '/api' + path,
    method,
    payload,
    headers: { cookie },
    remoteAddress: '127.115.1.1',
  });
};
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({
    integrationTransport: async () => {
      providerCalls++;
      throw Error('Local export profiles cannot contact providers');
    },
  });
  const login = await request('/auth/login', 'POST', {
    email: 'admin@demo.local',
    password: 'DynaDemo!2026',
  });
  assert.equal(login.statusCode, 200, 'POST /auth/login');
  cookie = String(login.headers['set-cookie']).split(';')[0];
  user = (await request('/auth/me')).json<{ user: { id: string } }>().user.id;
  warehouse = (await request('/warehouses')).json<{ data: Array<{ id: string }> }>().data[0].id;
});
after(async () => {
  try {
    await app?.close();
  } finally {
    await pool.end();
  }
});
type Definition = CatalogExportProfile['definition'];
const definition = (extra: Partial<Definition> = {}): Definition => ({
  format: 'csv',
  columns: ['ean', 'sku', 'name'],
  headers: {},
  spreadsheet_safe: false,
  ...extra,
});
async function create(d = definition(), label = prefix + '-' + randomUUID()) {
  const body = { name: label, definition: d, client_key: randomUUID() };
  const r = await request('/catalog/export-profiles', 'POST', body);
  assert.equal(r.statusCode, 201, r.body);
  return { body, profile: r.json<{ profile: CatalogExportProfile }>().profile };
}
async function product() {
  const r = await request('/products', 'POST', {
    sku: prefix + '-' + randomUUID(),
    ean: '0012345678905',
    name: 'Produkt „CSV”, XML & <ą>',
    price: 1234,
    quantity: 0,
    warehouse_id: warehouse,
    attributes: { color: 'żółty & <gold>', sizes: 'S, M' },
    images: ['https://example.invalid/qa115-a.png', 'https://example.invalid/qa115-b.png'],
  });
  assert.equal(r.statusCode, 201, r.body);
  return r.json<{ id: string; version: number }>();
}
async function download(p: CatalogExportProfile, ids: string[]) {
  return request('/catalog/exports/file', 'POST', { ...p.definition, selection: 'selected', ids });
}
async function profileSnapshot() {
  return (
    await pool.query(
      'SELECT to_jsonb(p) AS row FROM catalog_export_profiles p WHERE tenant_id=$1 ORDER BY id',
      [DEMO_TENANT],
    )
  ).rows;
}
async function auditCount(id: string) {
  return Number(
    (
      await pool.query<{ count: string }>(
        'SELECT count(*)::text count FROM audit_events WHERE tenant_id=$1 AND entity_id=$2',
        [DEMO_TENANT, id],
      )
    ).rows[0].count,
  );
}

test('definition shares strict export validation: ordered columns, canonical header maps, Unicode aliases and no stored scope', async () => {
  const key = randomUUID();
  const parsed = catalogExportProfileCreateInput.parse({
    name: '  CSV profile  ',
    definition: definition({ headers: { ean: '  Kod  ', name: 'Nazwa' } }),
    client_key: key.toUpperCase(),
  });
  assert.equal(parsed.name, 'CSV profile');
  assert.equal(parsed.client_key, key);
  assert.equal(parsed.definition.headers.ean, 'Kod');
  assert.deepEqual(parsed.definition.columns, ['ean', 'sku', 'name']);
  assert.equal(
    catalogExportProfileHash({
      name: parsed.name,
      definition: { ...parsed.definition, headers: { name: 'Nazwa', ean: 'Kod' } },
    }),
    catalogExportProfileHash({ definition: parsed.definition, name: parsed.name }),
  );
  for (const d of [
    { ...definition(), ids: [randomUUID()] },
    { ...definition(), selection: 'selected' },
    definition({ headers: { ean: 'duplicate', sku: 'DUPLICATE' } }),
    definition({ headers: { ean: 'sku' } }),
    definition({ headers: { description: 'Not selected' } }),
    definition({ headers: { ean: 'bad\u0085' } }),
    definition({ format: 'xml', headers: { ean: 'xmlAlias' } }),
    definition({ format: 'xml', headers: { ean: 'a:b' } }),
    definition({ headers: JSON.parse('{"constructor":"unknown"}') as Definition['headers'] }),
  ])
    assert.equal(
      catalogExportProfileCreateInput.safeParse({ name: 'strict', definition: d, client_key: key })
        .success,
      false,
    );
  // Fastify rejects prototype keys while decoding the HTTP body. Zod's partial
  // record strips __proto__, so a direct schema call is not this transport proof.
  const before = await profileSnapshot();
  const poisoned = await request('/catalog/export-profiles', 'POST', {
    name: 'Forbidden prototype key',
    definition: definition({
      headers: JSON.parse('{"__proto__":"poison"}') as Definition['headers'],
    }),
    client_key: key,
  });
  assert.equal(poisoned.statusCode, 400, poisoned.body);
  assert.deepEqual(await profileSnapshot(), before);
});

test('saved CSV order and quoted own labels drive a real raw export with leading-zero EAN and all twenty fields', async () => {
  const p = await product(),
    d = definition({
      columns: CATALOG_EXPORT_COLUMNS.filter(
        (c) => !['inventory_json', 'prices_json'].includes(c.key),
      ).map((c) => c.key),
      headers: { ean: 'Kod EAN', name: 'Nazwa, "własna"', sku: 'Kod produktu' },
    });
  const saved = await create(d),
    response = await download(saved.profile, [p.id]);
  assert.equal(response.statusCode, 200, response.body);
  const header = response.body.split('\r\n')[0];
  assert.equal(
    header,
    d.columns.map((k) => '"' + (d.headers[k] ?? k).replaceAll('"', '""') + '"').join(','),
  );
  assert(response.body.includes('"0012345678905"'));
  assert(response.body.includes('"1234"'));
  const detail = await request('/catalog/export-profiles/' + saved.profile.id);
  assert.equal(detail.statusCode, 200);
  assert.deepEqual(detail.json<{ profile: CatalogExportProfile }>().profile.definition, d);
  assert(!detail.body.includes('initial_request'));
  assert(!detail.body.includes('request_hash'));
  assert(!detail.body.includes('client_key'));
  assert.equal(providerCalls, 0);
});

test('saved XML aliases form actual structured elements with nested parameters and lossless escaped values', async () => {
  const p = await product(),
    saved = await create(
      definition({
        format: 'xml',
        columns: ['ean', 'name', 'attributes_json', 'images_json'],
        headers: {
          ean: 'barcode',
          name: 'product_name',
          attributes_json: 'parameters',
          images_json: 'gallery',
        },
      }),
    );
  const response = await download(saved.profile, [p.id]);
  assert.equal(response.statusCode, 200, response.body);
  const parser = new SaxesParser({ xmlns: false }),
    names: string[] = [],
    texts: string[] = [];
  parser.on('opentag', (tag) => {
    names.push(tag.name);
  });
  parser.on('text', (text) => {
    texts.push(text);
  });
  parser.write(response.body).close();
  for (const tag of ['barcode', 'product_name', 'parameters', 'gallery', 'entry', 'item'])
    assert(names.includes(tag), tag);
  assert(!names.includes('attributes_json'));
  assert(texts.includes('0012345678905'));
  assert(texts.includes('żółty & <gold>'));
  assert(texts.includes('https://example.invalid/qa115-a.png'));
  assert(texts.includes('https://example.invalid/qa115-b.png'));
  assert(response.body.includes('key="color"'));
  assert.equal(providerCalls, 0);
});

test('exact create replay after edit and archive returns current profile and adds no audit or configuration writes', async () => {
  const saved = await create(),
    id = saved.profile.id;
  const patched = await request('/catalog/export-profiles/' + id, 'PATCH', {
    version: 1,
    name: prefix + 'edited-' + randomUUID(),
    definition: definition({ columns: ['name', 'ean'], headers: { name: 'Nazwa' } }),
  });
  assert.equal(patched.statusCode, 200, patched.body);
  const current = patched.json<{ profile: CatalogExportProfile }>().profile;
  const archived = await request('/catalog/export-profiles/' + id + '/archive', 'POST', {
    version: current.version,
  });
  assert.equal(archived.statusCode, 200, archived.body);
  const expected = archived.json<{ profile: CatalogExportProfile }>().profile,
    rows = await profileSnapshot(),
    audits = await auditCount(id);
  const replay = await request('/catalog/export-profiles', 'POST', {
    client_key: saved.body.client_key.toUpperCase(),
    definition: { ...saved.body.definition, headers: {} },
    name: ' ' + saved.body.name + ' ',
  });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().reused, true);
  assert.deepEqual(replay.json().profile, expected);
  assert.deepEqual(await profileSnapshot(), rows);
  assert.equal(await auditCount(id), audits);
  const mismatch = await request('/catalog/export-profiles', 'POST', {
    ...saved.body,
    name: 'Another initial request',
  });
  assert.equal(mismatch.statusCode, 409);
  assert.deepEqual(await profileSnapshot(), rows);
});

test('CAS keeps complete ordered definitions and audit before/after hashes; per-download selection never enters profile', async () => {
  const saved = await create(),
    p = await product();
  const changed = definition({
    format: 'xml',
    columns: ['name', 'sku'],
    headers: { name: 'label', sku: 'code' },
  });
  const patch = await request('/catalog/export-profiles/' + saved.profile.id, 'PATCH', {
    version: 1,
    name: saved.profile.name,
    definition: changed,
  });
  assert.equal(patch.statusCode, 200, patch.body);
  const current = patch.json<{ profile: CatalogExportProfile }>().profile;
  const before = await profileSnapshot();
  assert.equal(
    (
      await request('/catalog/export-profiles/' + current.id, 'PATCH', {
        version: 1,
        name: 'stale',
        definition: definition(),
      })
    ).statusCode,
    409,
  );
  assert.deepEqual(await profileSnapshot(), before);
  const downloadResponse = await download(current, [p.id]);
  assert.equal(downloadResponse.statusCode, 200, downloadResponse.body);
  assert.deepEqual(await profileSnapshot(), before);
  const audit = (
    await pool.query<{
      detail: {
        before: CatalogExportProfile;
        after: CatalogExportProfile;
        before_hash: string;
        after_hash: string;
      };
    }>(
      "SELECT detail FROM audit_events WHERE tenant_id=$1 AND entity_id=$2 AND action='catalog.export_profile.update' ORDER BY created_at DESC LIMIT 1",
      [DEMO_TENANT, current.id],
    )
  ).rows[0].detail;
  assert.equal(audit.before.version, 1);
  assert.equal(audit.after.version, 2);
  assert.deepEqual(audit.after.definition, changed);
  assert.equal(
    audit.after_hash,
    catalogExportProfileHash({ name: current.name, definition: changed, archived: false }),
  );
  assert.equal(
    audit.before_hash,
    catalogExportProfileHash({
      name: saved.profile.name,
      definition: saved.profile.definition,
      archived: false,
    }),
  );
});

test('tenant list includes archived profiles but cannot resolve or mutate a foreign profile UUID', async () => {
  const saved = await create();
  const archived = await request(
    '/catalog/export-profiles/' + saved.profile.id + '/archive',
    'POST',
    { version: 1 },
  );
  assert.equal(archived.statusCode, 200);
  const list = await request('/catalog/export-profiles');
  assert.equal(list.statusCode, 200, list.body);
  assert.equal(list.json().limit, 200);
  assert(
    list
      .json<{ data: CatalogExportProfile[] }>()
      .data.some((p) => p.id === saved.profile.id && p.archived),
  );
  const other = randomUUID(),
    foreign = randomUUID();
  await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,$2,'enterprise')", [
    other,
    prefix + 'foreign',
  ]);
  const d = definition(),
    initial = { name: 'Foreign profile', definition: d };
  await tenantTx(other, (c) =>
    c.query(
      `INSERT INTO catalog_export_profiles(id,tenant_id,actor_id,client_key,request_hash,initial_request,name,definition) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        foreign,
        other,
        user,
        randomUUID(),
        catalogExportProfileHash({ actor_id: user, request: initial }),
        JSON.stringify(initial),
        initial.name,
        JSON.stringify(d),
      ],
    ),
  );
  assert.equal((await request('/catalog/export-profiles/' + foreign)).statusCode, 404);
  assert.equal(
    (
      await request('/catalog/export-profiles/' + foreign, 'PATCH', {
        version: 1,
        name: 'Hijack',
        definition: d,
      })
    ).statusCode,
    404,
  );
  assert(!list.body.includes(foreign));
  const restored = await request(
    '/catalog/export-profiles/' + saved.profile.id + '/restore',
    'POST',
    { version: 2 },
  );
  assert.equal(restored.statusCode, 200, restored.body);
  assert.equal(restored.json().profile.archived, false);
  assert.equal(providerCalls, 0);
});
