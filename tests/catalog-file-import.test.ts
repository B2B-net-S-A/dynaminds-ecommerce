import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed, DEMO_TENANT } from './fixtures';
import { catalogFileImportPreviewInput } from '../server/catalog-file-import-schema';
import { parseCatalogFileImport } from '../server/catalog-file-import-parse';

assert.equal(process.env.DYNA_TEST, 'true');
assert.match(new URL(process.env.DATABASE_URL!).pathname, /^\/dynaminds_test_\d+$/);
type Json = Record<string, any>;
type ImportRow = {
  index: number;
  operation: string;
  product_id: string;
  sku: string | null;
  before: Json | null;
  after: Json | null;
  matched_historical_sku: boolean;
  changed_fields: string[];
  errors: string[];
};
type Preview = {
  id: string;
  scope_hash: string;
  ready: boolean;
  total: number;
  created: number;
  updated: number;
  unchanged: number;
  invalid: number;
};
type Response = {
  preview: Preview;
  rows: ImportRow[];
  meta: { cursor: string | null };
  reused: boolean;
};
type Execution = {
  execution: Preview & { state: string; preview_id: string };
  rows: ImportRow[];
  meta: { cursor: string | null };
  reused: boolean;
};
const prefix = 'QA117-' + randomUUID().slice(0, 8);
let app: Awaited<ReturnType<typeof buildApp>> | undefined,
  cookie = '',
  warehouse = '';
let a: Json, b: Json;
let providers = 0;
function request(path: string, method: 'GET' | 'POST' | 'PATCH' = 'GET', payload?: Json) {
  assert(app);
  return app.inject({
    url: '/api' + path,
    method,
    payload,
    headers: { cookie, ...(path === '/orders' ? { 'idempotency-key': randomUUID() } : {}) },
    remoteAddress: '127.117.2.1',
  });
}
async function ok<T>(
  path: string,
  method: 'GET' | 'POST' | 'PATCH' = 'GET',
  payload?: Json,
  status = 200,
): Promise<T> {
  const response = await request(path, method, payload);
  assert.equal(
    response.statusCode,
    status,
    path.startsWith('/auth') ? path + ': ' + response.statusCode : response.body,
  );
  return response.json<T>();
}
const input = (content: string, extra: Json = {}) => ({
  client_key: randomUUID(),
  format: 'csv',
  content,
  warehouse_id: warehouse,
  currency: 'PLN',
  mode: 'update',
  identity: 'sku',
  empty_policy: 'skip',
  delimiter: ',',
  mapping: {},
  ignore_readonly_fields: false,
  ...extra,
});
const preview = (content: string, extra: Json = {}) =>
  ok<Response>('/catalog/file-imports/preview', 'POST', input(content, extra), 201);
const consent = (p: Response) => ({
  client_key: randomUUID(),
  scope_hash: p.preview.scope_hash,
  confirmed: true,
});
const execute = (p: Response, body = consent(p)) =>
  ok<Execution>(`/catalog/file-imports/previews/${p.preview.id}/execute`, 'POST', body, 201);
async function physical() {
  const names = [
    'stock',
    'stock_locations',
    'stock_movements',
    'reservations',
    'reservation_locations',
    'orders',
    'order_items',
  ];
  const result: Record<string, unknown> = {};
  for (const name of names)
    result[name] = (
      await pool.query(`SELECT to_jsonb(t) row FROM "${name}" t WHERE tenant_id=$1 ORDER BY 1`, [
        DEMO_TENANT,
      ])
    ).rows;
  return result;
}
async function productRows(ids: string[]) {
  return tenantTx(
    DEMO_TENANT,
    async (c) => {
      const p = (
        await c.query(
          'SELECT id,version,sku,name,ean,price,description,attributes,images,kind,parent_id FROM products WHERE id=ANY($1::uuid[]) ORDER BY id',
          [ids],
        )
      ).rows;
      const components = (
        await c.query(
          'SELECT bundle_id,product_id,quantity FROM bundle_components WHERE bundle_id=ANY($1::uuid[]) ORDER BY bundle_id,product_id',
          [ids],
        )
      ).rows;
      const logistics = (
        await c.query(
          'SELECT product_id,weight_grams,length_mm,width_mm,height_mm,manufacturer FROM product_logistics WHERE product_id=ANY($1::uuid[]) ORDER BY product_id',
          [ids],
        )
      ).rows;
      return { p, components, logistics };
    },
    { wmsAdmission: 'read' },
  );
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({
    integrationTransport: async () => {
      providers++;
      throw Error('Import cannot call providers');
    },
  });
  const login = await request('/auth/login', 'POST', {
    email: 'admin@demo.local',
    password: 'DynaDemo!2026',
  });
  assert.equal(login.statusCode, 200, 'POST /auth/login');
  cookie = String(login.headers['set-cookie']).split(';')[0];
  warehouse = (await ok<{ data: { id: string }[] }>('/warehouses')).data[0].id;
  a = await ok<Json>(
    '/products',
    'POST',
    {
      sku: prefix + '-A',
      ean: '0011700000001',
      name: 'Native import A',
      description: '  Opis & XML\r\n尾  ',
      price: 2599,
      quantity: 12,
      warehouse_id: warehouse,
      attributes: { color: 'żółty' },
      weight_grams: 1001,
      images: ['https://example.test/a.png'],
    },
    201,
  );
  b = await ok<Json>(
    '/products',
    'POST',
    {
      sku: prefix + '-B',
      name: 'Native import B',
      price: 1001,
      quantity: 10,
      warehouse_id: warehouse,
    },
    201,
  );
  await ok(
    '/orders',
    'POST',
    {
      customer_name: 'QA117 reservation',
      email: 'qa117@example.test',
      warehouse_id: warehouse,
      items: [{ product_id: a.id, quantity: 3 }],
    },
    201,
  );
});
after(async () => {
  try {
    await app?.close();
  } finally {
    await pool.end();
  }
});

test('general CSV handles explicit aliases, quoted newlines, zero and leading EAN; XML rejects unsafe structures and mapper shadowing', () => {
  const q = catalogFileImportPreviewInput.parse(
    input('Kod;Nazwa;Cena;GTIN\r\nNEW;"Linia\nDruga";0;00123\r\n', {
      delimiter: ';',
      mode: 'create',
      mapping: { sku: 'Kod', name: 'Nazwa', price_minor: 'Cena', ean: 'GTIN' },
    }),
  );
  const parsed = parseCatalogFileImport(q);
  assert.deepEqual(parsed.rows, [
    { fields: { sku: 'NEW', name: 'Linia\nDruga', price_minor: '0', ean: '00123' }, errors: [] },
  ]);
  for (const content of ['sku,sku\nA,A\n', 'sku,name\n"broken,A\n'])
    assert.throws(() =>
      parseCatalogFileImport(catalogFileImportPreviewInput.parse(input(content))),
    );
  assert.throws(() =>
    parseCatalogFileImport(
      catalogFileImportPreviewInput.parse(input('name\nA\n', { mapping: { sku: 'name' } })),
    ),
  );
  const xml = '<catalog currency="PLN"><product><sku type="string">A</sku></product></catalog>';
  assert.equal(
    parseCatalogFileImport(catalogFileImportPreviewInput.parse(input(xml, { format: 'xml' })))
      .rows[0].fields.sku,
    'A',
  );
  for (const content of [
    '<!DOCTYPE catalog [<!ENTITY secret SYSTEM "file:///etc/passwd">]>' + xml,
    '<catalog currency="PLN"><product><sku type="string">A</sku><sku type="string">B</sku></product></catalog>',
    '<catalog currency="PLN"><product><attributes_json type="object"><entry key="__proto__" type="string">bad</entry></attributes_json></product></catalog>',
    '<catalog currency="PLN"><product><sku type="string">' +
      '<item type="array">'.repeat(17) +
      'x' +
      '</item>'.repeat(17) +
      '</sku></product></catalog>',
  ])
    assert.throws(() =>
      parseCatalogFileImport(
        catalogFileImportPreviewInput.parse(input(content, { format: 'xml' })),
      ),
    );
});

test('one frozen create batch resolves forward group/variant/bundle SKU dependencies, preserves allocated UUIDs, and retries exactly', async () => {
  const skus = {
    group: prefix + '-CREATE-G',
    variant: prefix + '-CREATE-V',
    part: prefix + '-CREATE-P',
    kit: prefix + '-CREATE-K',
  };
  const quote = (v: string) => '"' + v.replaceAll('"', '""') + '"';
  const content =
    'sku,name,price_minor,kind,parent_sku,bundle_components_json,ean,weight_g\r\n' +
    [
      [
        skus.kit,
        'Nowy zestaw',
        '0',
        'bundle',
        '',
        JSON.stringify([
          { sku: skus.variant, quantity: 2 },
          { sku: skus.part, quantity: 1 },
        ]),
        '',
        '',
      ],
      [skus.variant, 'Nowy wariant', '1201', 'variant', skus.group, '', '0011700007', '1001'],
      [skus.group, 'Nowa grupa', '0', 'group', '', '', '', ''],
      [skus.part, 'Nowy składnik', '301', 'simple', '', '', '', ''],
    ]
      .map((row) => row.map(quote).join(','))
      .join('\r\n') +
    '\r\n';
  const body = input(content, { mode: 'create' }),
    p = await ok<Response>('/catalog/file-imports/preview', 'POST', body, 201);
  assert(p.preview.ready);
  assert.equal(p.preview.created, 4);
  assert.equal(p.preview.invalid, 0);
  const allocated = new Map(p.rows.map((r) => [r.sku, r.product_id]));
  const preread = (
    await pool.query('SELECT id FROM products WHERE tenant_id=$1 AND id=ANY($2::uuid[])', [
      DEMO_TENANT,
      [...allocated.values()],
    ])
  ).rows;
  assert.deepEqual(preread, []);
  const repeated = await ok<Response>('/catalog/file-imports/preview', 'POST', body);
  assert(repeated.reused);
  assert.deepEqual(repeated.rows, p.rows);
  const command = consent(p),
    done = await execute(p, command);
  assert.equal(done.execution.created, 4);
  assert.equal(done.execution.state, 'done');
  const saved = await productRows([...allocated.values()]);
  assert.equal(saved.p.length, 4);
  assert(saved.p.every((r) => r.version === 1));
  const variant = saved.p.find((r) => r.sku === skus.variant)!;
  assert.equal(variant.id, allocated.get(skus.variant));
  assert.equal(variant.parent_id, allocated.get(skus.group));
  assert.equal(variant.ean, '0011700007');
  assert.equal(variant.price, 1201);
  assert.deepEqual(
    saved.components.map((r) => [r.product_id, r.quantity]).sort(),
    [
      [allocated.get(skus.variant), 2],
      [allocated.get(skus.part), 1],
    ].sort(),
  );
  assert.equal(saved.logistics.find((r) => r.product_id === variant.id)?.weight_grams, 1001);
  const before = await productRows([...allocated.values()]);
  const replay = await ok<Execution>(
    `/catalog/file-imports/previews/${p.preview.id}/execute`,
    'POST',
    command,
  );
  assert(replay.reused);
  assert.deepEqual(replay.rows, done.rows);
  assert.deepEqual(await productRows([...allocated.values()]), before);
  assert.equal(providers, 0);
});

test('mapped partial updates need no price/name, keep omitted fields and reservations; exact no-op emits no product audit/version change', async () => {
  const before = await physical(),
    current = await productRows([a.id, b.id]);
  const content = `Kod;Opis\r\n${a.sku};Nowy opis\r\n${b.sku};Opis B\r\n`;
  const p = await preview(content, {
    delimiter: ';',
    mapping: { sku: 'Kod', description: 'Opis' },
  });
  assert(p.preview.ready);
  assert.equal(p.preview.updated, 2);
  assert(
    p.rows.every((r) => r.changed_fields.length === 1 && r.changed_fields[0] === 'description'),
  );
  await execute(p);
  const saved = await productRows([a.id, b.id]);
  for (const old of current.p) {
    const row = saved.p.find((r) => r.id === old.id)!;
    assert.equal(row.version, old.version + 1);
    assert.equal(row.name, old.name);
    assert.equal(row.price, old.price);
    assert.equal(row.ean, old.ean);
  }
  assert.deepEqual(saved.logistics, current.logistics);
  assert.deepEqual(await physical(), before);
  const noOp = await preview(content, {
    delimiter: ';',
    mapping: { sku: 'Kod', description: 'Opis' },
  });
  assert.equal(noOp.preview.unchanged, 2);
  assert(noOp.preview.ready);
  const auditBefore = (
    await pool.query(
      "SELECT count(*)::integer n FROM audit_events WHERE tenant_id=$1 AND action='product.update'",
      [DEMO_TENANT],
    )
  ).rows[0].n;
  await execute(noOp);
  assert.deepEqual(await productRows([a.id, b.id]), saved);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::integer n FROM audit_events WHERE tenant_id=$1 AND action='product.update'",
        [DEMO_TENANT],
      )
    ).rows[0].n,
    auditBefore,
  );
});

test('native structural XML round-trips complete typed PIM and rejects derived fields/currency unless explicitly ignored', async () => {
  const columns = [
    'id',
    'sku',
    'ean',
    'name',
    'description',
    'price_minor',
    'vat_rate',
    'category',
    'active',
    'kind',
    'weight_g',
    'length_mm',
    'width_mm',
    'height_mm',
    'manufacturer',
    'attributes_json',
    'images_json',
    'bundle_components_json',
    'variants_json',
    'translations_json',
  ];
  const xml = await request('/catalog/exports/file', 'POST', {
    format: 'xml',
    columns,
    selection: 'selected',
    ids: [a.id],
    spreadsheet_safe: false,
  });
  assert.equal(xml.statusCode, 200, xml.body);
  const denied = await preview(xml.body, { format: 'xml', identity: 'id', empty_policy: 'clear' });
  assert(!denied.preview.ready);
  assert(denied.rows[0].errors.some((e) => e.includes('variants_json')));
  const before = await productRows([a.id]),
    physicalBefore = await physical();
  const p = await preview(xml.body, {
    format: 'xml',
    identity: 'id',
    empty_policy: 'clear',
    ignore_readonly_fields: true,
  });
  assert(p.preview.ready, p.rows[0].errors.join('; '));
  assert.equal(p.preview.unchanged, 1);
  await execute(p);
  assert.deepEqual(await productRows([a.id]), before);
  assert.deepEqual(await physical(), physicalBefore);
  const wrong = await preview(xml.body.replace('currency="PLN"', 'currency="EUR"'), {
    format: 'xml',
    identity: 'id',
    ignore_readonly_fields: true,
  });
  assert(!wrong.preview.ready);
  assert(wrong.rows[0].errors.some((e) => e.includes('FX')));
});

test('clear distinguishes empty from omitted, zero from missing, and validates native recipe/image/logistics updates as one product version', async () => {
  const p = await preview(
    `sku,description,price_minor,weight_g,attributes_json,images_json\r\n${a.sku},,0,,{},[]\r\n`,
    { empty_policy: 'clear' },
  );
  assert(p.preview.ready, p.rows[0].errors.join('; '));
  const version = p.rows[0].before!.version;
  assert.equal(p.rows[0].after!.price, 0);
  assert.equal(p.rows[0].after!.description, '');
  assert.equal(p.rows[0].after!.weight_grams, null);
  assert.deepEqual(p.rows[0].after!.attributes, {});
  assert.deepEqual(p.rows[0].after!.images, []);
  const physicalBefore = await physical();
  await execute(p);
  const saved = await productRows([a.id]);
  assert.equal(saved.p[0].version, version + 1);
  assert.equal(saved.p[0].price, 0);
  assert.equal(saved.logistics[0].weight_grams, null);
  assert.deepEqual(await physical(), physicalBefore);
  const emptyName = await preview(`sku,name\n${a.sku},\n`, { empty_policy: 'clear' });
  assert(!emptyName.preview.ready);
  assert(emptyName.rows[0].errors.some((e) => e.includes('name')));
});

test('identity aliases preserve UUID/current SKU while ambiguous names, foreign id and reserved batch swaps invalidate the entire preview', async () => {
  const oldSku = b.sku;
  const detail = await ok<Json>('/products/' + b.id);
  const newSku = prefix + '-B-RENAMED';
  b = await ok<Json>('/products/' + b.id, 'PATCH', {
    ...detail,
    sku: newSku,
    version: detail.version,
    components: [],
  });
  const p = await preview(`sku,description\n${oldSku},Alias opis\n`);
  assert(p.preview.ready);
  assert.equal(p.rows[0].product_id, b.id);
  assert.equal(p.rows[0].matched_historical_sku, true);
  assert.equal(p.rows[0].after!.sku, newSku);
  await execute(p);
  assert.equal((await productRows([b.id])).p[0].sku, newSku);
  await tenantTx(DEMO_TENANT, (c) =>
    c.query('UPDATE products SET name=$1 WHERE id=ANY($2::uuid[])', [
      prefix + ' ambiguous',
      [a.id, b.id],
    ]),
  );
  const ambiguous = await preview(`name,description\n${prefix} ambiguous,No first match\n`, {
    identity: 'name',
  });
  assert(!ambiguous.preview.ready);
  assert(ambiguous.rows[0].errors.some((e) => e.includes('niejednoznaczna')));
  const foreign = await preview(`id,name\n${randomUUID()},Foreign\n`, {
    identity: 'id',
    mode: 'upsert',
  });
  assert(!foreign.preview.ready);
  const swap = await preview(`id,sku\n${a.id},${newSku}\n${b.id},${a.sku}\n`, { identity: 'id' });
  assert(!swap.preview.ready);
  assert.equal(swap.preview.invalid, 2);
});

test('one late product-version conflict prevents every row and receipt; a new alias claim after preview blocks an allocated create', async () => {
  const p = await preview(`sku,category\n${a.sku},Frozen A\n${b.sku},Frozen B\n`);
  assert(p.preview.ready);
  await tenantTx(DEMO_TENANT, (c) =>
    c.query('UPDATE products SET version=version+1 WHERE id=$1', [b.id]),
  );
  const before = await productRows([a.id, b.id]),
    physicalBefore = await physical();
  const rejected = await request(
    `/catalog/file-imports/previews/${p.preview.id}/execute`,
    'POST',
    consent(p),
  );
  assert.equal(rejected.statusCode, 409, rejected.body);
  assert.deepEqual(await productRows([a.id, b.id]), before);
  assert.deepEqual(await physical(), physicalBefore);
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::integer n FROM catalog_file_import_executions WHERE tenant_id=$1 AND preview_id=$2',
        [DEMO_TENANT, p.preview.id],
      )
    ).rows[0].n,
    0,
  );
  const sku = prefix + '-CLAIMED-LATER';
  const fresh = await preview(`sku,name,price_minor\n${sku},New frozen,0\n`, { mode: 'create' });
  assert(fresh.preview.ready);
  await ok(
    '/products',
    'POST',
    { sku, name: 'Later live claim', price: 0, quantity: 0, warehouse_id: warehouse },
    201,
  );
  const denied = await request(
    `/catalog/file-imports/previews/${fresh.preview.id}/execute`,
    'POST',
    consent(fresh),
  );
  assert.equal(denied.statusCode, 409, denied.body);
  assert.equal(
    (
      await pool.query('SELECT count(*)::integer n FROM products WHERE tenant_id=$1 AND id=$2', [
        DEMO_TENANT,
        fresh.rows[0].product_id,
      ])
    ).rows[0].n,
    0,
  );
});

test('500 genuine created rows and immutable execution rows remain complete over five pages; 501 fails without a new preview', async () => {
  const content =
    'sku,name,price_minor\n' +
    Array.from(
      { length: 500 },
      (_, i) => `${prefix}-RANGE-${String(i).padStart(4, '0')},Range ${i},${i}`,
    ).join('\n') +
    '\n';
  const p = await preview(content, { mode: 'create' });
  assert(p.preview.ready);
  assert.equal(p.preview.created, 500);
  assert.equal(p.rows.length, 100);
  const all: ImportRow[] = [...p.rows];
  let cursor = p.meta.cursor;
  while (cursor) {
    const page = await ok<Response>(
      `/catalog/file-imports/previews/${p.preview.id}?cursor=${cursor}`,
    );
    assert(page.rows.length <= 100);
    all.push(...page.rows);
    cursor = page.meta.cursor;
  }
  assert.equal(all.length, 500);
  assert.deepEqual(
    all.map((r) => r.index),
    Array.from({ length: 500 }, (_, i) => i),
  );
  assert.equal(new Set(all.map((r) => r.product_id)).size, 500);
  const done = await execute(p),
    receipts: ImportRow[] = [...done.rows];
  cursor = done.meta.cursor;
  while (cursor) {
    const page = await ok<Execution>(
      `/catalog/file-imports/executions/${done.execution.id}?cursor=${cursor}`,
    );
    assert(page.rows.length <= 100);
    receipts.push(...page.rows);
    cursor = page.meta.cursor;
  }
  assert.equal(receipts.length, 500);
  assert.deepEqual(
    receipts.map((r) => r.product_id),
    all.map((r) => r.product_id),
  );
  const products = await productRows(all.map((r) => r.product_id));
  assert.equal(products.p.length, 500);
  assert(products.p.every((r) => r.version === 1));
  const bySku = new Map(products.p.map((r) => [r.sku, r]));
  for (let i = 0; i < 500; i++)
    assert.equal(bySku.get(`${prefix}-RANGE-${String(i).padStart(4, '0')}`)?.price, i);
  const prior = (
    await pool.query(
      'SELECT count(*)::integer n FROM catalog_file_import_previews WHERE tenant_id=$1',
      [DEMO_TENANT],
    )
  ).rows[0].n;
  const tooMany = await request(
    '/catalog/file-imports/preview',
    'POST',
    input(content + `${prefix}-RANGE-0500,Range 500,500\n`, { mode: 'create' }),
  );
  assert.equal(tooMany.statusCode, 422, tooMany.body);
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::integer n FROM catalog_file_import_previews WHERE tenant_id=$1',
        [DEMO_TENANT],
      )
    ).rows[0].n,
    prior,
  );
  assert.equal(providers, 0);
});
