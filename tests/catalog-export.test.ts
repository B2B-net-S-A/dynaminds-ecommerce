import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { SaxesParser } from 'saxes';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed, DEMO_TENANT } from './fixtures';
import {
  catalogExportFileInput,
  catalogExportFileQuery,
  catalogExportOptionsQuery,
  catalogXmlEscape,
  catalogCsvText,
  openCatalogExport,
} from '../server/catalog-export';
import type { Actor } from '../server/domain';

assert.equal(process.env.DYNA_TEST, 'true');
assert.match(new URL(process.env.DATABASE_URL!).pathname, /^\/dynaminds_test_\d+$/);
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let cookie = '',
  warehouse = '',
  actor: Actor;
const prefix = 'QA114-' + randomUUID().slice(0, 8);
const req = (url: string, method: 'GET' | 'POST' = 'GET', payload?: Record<string, unknown>) => {
  assert(app);
  return app.inject({ url, method, payload, headers: { cookie }, remoteAddress: '127.114.1.1' });
};
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({
    integrationTransport: async () => {
      throw Error('Catalog export must be local');
    },
  });
  const login = await req('/api/auth/login', 'POST', {
    email: 'admin@demo.local',
    password: 'DynaDemo!2026',
  });
  assert.equal(login.statusCode, 200, 'POST /api/auth/login');
  cookie = String(login.headers['set-cookie']).split(';')[0];
  const me = (await req('/api/auth/me')).json<{ user: { id: string } }>();
  actor = { tenantId: DEMO_TENANT, userId: me.user.id, role: 'admin' };
  warehouse = (await req('/api/warehouses')).json<{ data: Array<{ id: string }> }>().data[0].id;
});
after(async () => {
  try {
    await app?.close();
  } finally {
    await pool.end();
  }
});

type Product = {
  id: string;
  version: number;
  sku: string;
  name: string;
  price: number;
  vat: number;
  active: boolean;
  kind: string;
  attributes: Record<string, unknown>;
  images: string[];
};
async function product(extra: Record<string, unknown> = {}) {
  const r = await req('/api/products', 'POST', {
    sku: prefix + '-' + randomUUID().slice(0, 8),
    name: 'Katalog eksport ą😀',
    price: 1599,
    quantity: 0,
    warehouse_id: warehouse,
    ...extra,
  });
  assert.equal(r.statusCode, 201, 'create export fixture');
  return r.json<Product>();
}
async function file(ids: string[], columns: string[], extra: Record<string, unknown> = {}) {
  return req('/api/catalog/exports/file', 'POST', {
    format: 'csv',
    selection: 'selected',
    ids,
    columns,
    spreadsheet_safe: false,
    ...extra,
  });
}
function csv(text: string): Record<string, string>[] {
  // Independent RFC4180 decoder; catalogue import has a different fixed schema.
  const rows: string[][] = [];
  let row: string[] = [],
    value = '',
    quoted = false;
  const input = text.replace(/^\ufeff/, '');
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === '"') {
      if (quoted && input[i + 1] === '"') {
        value += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && c === ',') {
      row.push(value);
      value = '';
    } else if (!quoted && (c === '\r' || c === '\n')) {
      if (c === '\r' && input[i + 1] === '\n') i++;
      row.push(value);
      rows.push(row);
      row = [];
      value = '';
    } else value += c;
  }
  assert.equal(quoted, false);
  if (row.length || value) {
    row.push(value);
    rows.push(row);
  }
  const head = rows.shift();
  assert(head);
  return rows.map((r) => {
    assert.equal(r.length, head.length);
    return Object.fromEntries(head.map((h, i) => [h, r[i]]));
  });
}
function xml(text: string) {
  type Node = { name: string; attributes: Record<string, string>; children: Node[]; text: string };
  const parser = new SaxesParser({ xmlns: false }),
    stack: Node[] = [];
  let root: Node | undefined;
  parser.on('opentag', (tag) => {
    const node: Node = {
      name: tag.name,
      attributes: tag.attributes as Record<string, string>,
      children: [],
      text: '',
    };
    if (stack.length) stack.at(-1)!.children.push(node);
    else root = node;
    stack.push(node);
  });
  parser.on('text', (value) => {
    if (stack.length) stack.at(-1)!.text += value;
    else assert.equal(value.trim(), '');
  });
  parser.on('closetag', () => {
    stack.pop();
  });
  parser.write(text).close();
  assert(root);
  return root;
}
test('strict query/body normalization, selected500 and rejected unknown/duplicate/ambiguous config', () => {
  const id = randomUUID();
  assert.deepEqual(
    catalogExportFileQuery.parse({
      selection: 'selected',
      ids: id.toUpperCase(),
      columns: 'ean,sku',
      spreadsheet_safe: 'false',
    }),
    {
      format: 'csv',
      selection: 'selected',
      ids: [id],
      columns: ['ean', 'sku'],
      search: '',
      headers: {},
      active: 'all',
      spreadsheet_safe: false,
    },
  );
  assert.equal(catalogExportFileQuery.parse({}).columns.length, 6);
  assert(catalogExportOptionsQuery.safeParse({}).success);
  for (const b of [
    { columns: ['sku', 'sku'] },
    { columns: ['credentials'] },
    { ids: [id] },
    { selection: 'selected' },
    { spreadsheet_safe: 'false' },
    { remote_url: 'https://example.test' },
  ])
    assert.equal(catalogExportFileInput.safeParse(b).success, false);
  assert(
    catalogExportFileInput.safeParse({
      selection: 'selected',
      ids: Array.from({ length: 500 }, () => randomUUID()),
    }).success,
  );
  assert.equal(
    catalogExportFileInput.safeParse({
      selection: 'selected',
      ids: Array.from({ length: 501 }, () => randomUUID()),
    }).success,
    false,
  );
});

test('raw CSV exact text/JSON/null roundtrip and safe spreadsheet representation', async () => {
  const p = await product({
    sku: prefix + '-=sku',
    ean: '001140000007',
    name: '=HYPERLINK("https://example.test")',
    description: 'Cytat "ą😀", przecinek\r\nDruga linia',
    attributes: { Kolor: 'biały', Rozmiar: '001' },
    images: ['https://example.test/own-image.jpg'],
    weight_grams: 1200,
    length_mm: 30,
    manufacturer: 'Producent QA',
  });
  const fields = [
    'sku',
    'ean',
    'name',
    'description',
    'price_minor',
    'vat_rate',
    'active',
    'weight_g',
    'width_mm',
    'manufacturer',
    'attributes_json',
    'images_json',
  ];
  const raw = await file([p.id], fields);
  assert.equal(raw.statusCode, 200);
  assert.match(String(raw.headers['content-type']), /^text\/csv/);
  assert.equal(raw.headers['cache-control'], 'no-store');
  assert.equal(Number(raw.headers['content-length']), Buffer.byteLength(raw.body));
  const row = csv(raw.body)[0];
  assert.equal(row.sku, p.sku);
  assert.equal(row.ean, '001140000007');
  assert.equal(row.name, '=HYPERLINK("https://example.test")');
  assert.equal(row.description, 'Cytat "ą😀", przecinek\r\nDruga linia');
  assert.equal(row.price_minor, '1599');
  assert.equal(row.vat_rate, '23');
  assert.equal(row.weight_g, '1200');
  assert.equal(row.width_mm, '');
  assert.deepEqual(JSON.parse(row.attributes_json), { Kolor: 'biały', Rozmiar: '001' });
  assert.deepEqual(JSON.parse(row.images_json), ['https://example.test/own-image.jpg']);
  const safe = await file([p.id], fields, { spreadsheet_safe: true });
  assert.equal(safe.statusCode, 200);
  assert.equal(safe.body[0], '\ufeff');
  const protectedRow = csv(safe.body)[0];
  assert.equal(protectedRow.ean, "'001140000007");
  assert.equal(protectedRow.sku, "'" + p.sku);
  assert.equal(protectedRow.name, "'" + row.name);
  assert.equal(protectedRow.price_minor, '1599');
  assert.equal(catalogCsvText('\t=1+1', 'description', true), "'\t=1+1");
});

test('XML contains structured own variants/components/translations and exact CR/escaping/null', async () => {
  const physical = await product({
    ean: '',
    description: 'A & B <tag>\r\n😀',
    attributes: { 'a&"key': 'wartość<ą>', List: 'a,b' },
  });
  const group = await product({ kind: 'group' });
  const variant = await product({
    kind: 'variant',
    parent_id: group.id,
    attributes: { Size: 'M' },
  });
  const kit = await product({
    kind: 'bundle',
    components: [{ product_id: physical.id, quantity: 2 }],
  });
  const preview = await req('/api/product-translation-bulk-edit/previews', 'POST', {
    client_key: randomUUID(),
    locales: ['en'],
    rows: [
      {
        product_id: physical.id,
        product_version: physical.version,
        translation_version: null,
        locale: 'en',
        operation: 'set',
        patch: { name: 'Export English', description: 'English\r\ntext' },
      },
    ],
  });
  assert.equal(preview.statusCode, 201);
  const frozen = preview.json<{ preview: { id: string; scope_hash: string } }>().preview;
  const applied = await req(
    `/api/product-translation-bulk-edit/previews/${frozen.id}/execute`,
    'POST',
    { client_key: randomUUID(), scope_hash: frozen.scope_hash, confirmed: true },
  );
  assert.equal(applied.statusCode, 201);
  const result = await file(
    [physical.id, group.id, kit.id],
    [
      'id',
      'description',
      'attributes_json',
      'weight_g',
      'variants_json',
      'bundle_components_json',
      'translations_json',
    ],
    { format: 'xml' },
  );
  assert.equal(result.statusCode, 200);
  assert.match(String(result.headers['content-type']), /^application\/xml/);
  const root = xml(result.body);
  assert.equal(root.name, 'catalog');
  assert.equal(root.attributes.currency, 'PLN');
  assert.equal(root.attributes.price_source, 'catalog');
  assert.equal(root.children.length, 3);
  const node = (id: string) =>
    root.children.find((n) => n.children.find((c) => c.name === 'id')?.text === id)!;
  const field = (id: string, name: string) => node(id).children.find((c) => c.name === name)!;
  assert.equal(field(physical.id, 'description').text, 'A & B <tag>\r\n😀');
  assert.equal(field(physical.id, 'weight_g').attributes.nil, 'true');
  assert.equal(field(physical.id, 'attributes_json').attributes.type, 'object');
  assert.equal(
    field(physical.id, 'attributes_json').children.find((c) => c.attributes.key === 'a&"key')?.text,
    'wartość<ą>',
  );
  assert.equal(
    field(group.id, 'variants_json').children[0].children.find((c) => c.attributes.key === 'id')
      ?.text,
    variant.id,
  );
  assert.equal(
    field(kit.id, 'bundle_components_json').children[0].children.find(
      (c) => c.attributes.key === 'quantity',
    )?.text,
    '2',
  );
  assert.equal(
    field(physical.id, 'translations_json').children[0].children.find(
      (c) => c.attributes.key === 'description',
    )?.text,
    'English\r\ntext',
  );
  assert.throws(() => catalogXmlEscape('bad\u0001text'), /XML/);
});

test('500 selected UUID body and full filtered pages preserve exact scope/order and active filter', async () => {
  const scope = Array.from({ length: 501 }, (_, i) => ({
    id: randomUUID(),
    sku: `${prefix}-large-${i}`,
    active: i !== 500,
  }));
  await tenantTx(DEMO_TENANT, (c) =>
    c.query(
      `INSERT INTO products(id,tenant_id,sku,name,price,active) SELECT x.id,$1,x.sku,$2,0,x.active FROM jsonb_to_recordset($3::jsonb) AS x(id uuid,sku text,active boolean)`,
      [DEMO_TENANT, prefix + '-large', JSON.stringify(scope)],
    ),
  );
  const selected = await file(
    scope.slice(0, 500).map((p) => p.id),
    ['id', 'sku'],
  );
  assert.equal(selected.statusCode, 200);
  assert.equal(selected.headers['x-catalog-export-count'], '500');
  assert.deepEqual(
    csv(selected.body).map((r) => r.id),
    scope
      .slice(0, 500)
      .map((p) => p.id)
      .sort(),
  );
  const filtered = await req('/api/catalog/exports/file', 'POST', {
    format: 'csv',
    columns: ['id', 'active'],
    selection: 'filtered',
    search: prefix + '-large',
    active: 'all',
    spreadsheet_safe: false,
  });
  assert.equal(filtered.statusCode, 200);
  assert.equal(csv(filtered.body).length, 501);
  const active = await req(
    '/api/catalog/exports/file?columns=id&search=' +
      encodeURIComponent(prefix + '-large') +
      '&active=yes&spreadsheet_safe=false',
  );
  assert.equal(active.statusCode, 200);
  assert.equal(csv(active.body).length, 500);
  const inactive = await req(
    '/api/catalog/exports/file?columns=id&search=' +
      encodeURIComponent(prefix + '-large') +
      '&active=no&spreadsheet_safe=false',
  );
  assert.equal(inactive.statusCode, 200);
  assert.deepEqual(
    csv(inactive.body).map((r) => r.id),
    [scope[500].id],
  );
});

test('options actual base currency/count and zero business writes across repeated downloads', async () => {
  const p = await product();
  const names = [
    'products',
    'product_logistics',
    'product_translations',
    'stock',
    'stock_locations',
    'reservations',
    'orders',
    'audit_events',
    'jobs',
    'outbound_events',
  ];
  const snapshot = () =>
    tenantTx(DEMO_TENANT, async (c) => {
      const result: Record<string, { count: string; digest: string }> = {};
      for (const name of names)
        result[name] = (
          await c.query<{ count: string; digest: string }>(
            `SELECT count(*)::text count, md5(coalesce(string_agg(to_jsonb(t)::text,'|' ORDER BY to_jsonb(t)::text),'')) digest FROM ${name} t`,
          )
        ).rows[0];
      return result;
    });
  const before = await snapshot();
  const options = await req('/api/catalog/exports/options?selection=selected&ids=' + p.id);
  assert.equal(options.statusCode, 200);
  const b = options.json<{
    catalog_currency: string;
    price_source: string;
    count: { matched_products: number; capped: boolean };
    columns: Array<{ key: string }>;
  }>();
  assert.equal(b.catalog_currency, 'PLN');
  assert.equal(b.price_source, 'catalog');
  assert.deepEqual(b.count, { matched_products: 1, capped: false });
  assert.equal(b.columns.length, 22);
  assert.equal((await file([p.id], ['name', 'price_minor'])).statusCode, 200);
  assert.equal((await file([p.id], ['name'], { format: 'xml' })).statusCode, 200);
  assert.deepEqual(await snapshot(), before);
});

test('a prepared file remains one coherent product/profile snapshot after later edits', async () => {
  const p = await product({ weight_grams: 111, manufacturer: 'Before' });
  const artifact = await openCatalogExport(actor, {
    selection: 'selected',
    ids: [p.id],
    columns: ['name', 'price_minor', 'weight_g', 'manufacturer'],
    spreadsheet_safe: false,
  });
  try {
    await tenantTx(DEMO_TENANT, async (c) => {
      await c.query('UPDATE products SET name=$1,price=777,version=version+1 WHERE id=$2', [
        'After',
        p.id,
      ]);
      await c.query(
        'UPDATE product_logistics SET weight_grams=222,manufacturer=$1 WHERE product_id=$2',
        ['After', p.id],
      );
    });
    const buffers: Buffer[] = [];
    for await (const chunk of artifact.stream) buffers.push(Buffer.from(chunk));
    const frozen = csv(Buffer.concat(buffers).toString('utf8'))[0];
    assert.equal(frozen.name, p.name);
    assert.equal(frozen.price_minor, '1599');
    assert.equal(frozen.weight_g, '111');
    assert.equal(frozen.manufacturer, 'Before');
    await artifact.dispose();
    const fresh = csv(
      (await file([p.id], ['name', 'price_minor', 'weight_g', 'manufacturer'])).body,
    )[0];
    assert.deepEqual(fresh, {
      name: 'After',
      price_minor: '777',
      weight_g: '222',
      manufacturer: 'After',
    });
  } finally {
    await artifact.dispose();
  }
});

test('large group relation is paged without truncation or duplicate variants', async () => {
  const group = await product({ kind: 'group' });
  const variants = Array.from({ length: 253 }, (_, i) => ({
    id: randomUUID(),
    sku: `${prefix}-v-${i}`,
    name: `Variant ${i}`,
  }));
  await tenantTx(DEMO_TENANT, (c) =>
    c.query(
      `INSERT INTO products(id,tenant_id,sku,name,price,kind,parent_id) SELECT x.id,$1,x.sku,x.name,0,'variant',$2 FROM jsonb_to_recordset($3::jsonb) AS x(id uuid,sku text,name text)`,
      [DEMO_TENANT, group.id, JSON.stringify(variants)],
    ),
  );
  const result = await file([group.id], ['id', 'variants_json']);
  assert.equal(result.statusCode, 200);
  const rows = JSON.parse(csv(result.body)[0].variants_json) as Array<{
    id: string;
    sku: string;
    active: boolean;
  }>;
  assert.equal(rows.length, 253);
  assert.deepEqual(
    rows.map((v) => v.id),
    variants.map((v) => v.id).sort(),
  );
  assert(rows.every((v) => v.active));
});

test('a real translation read wait keeps product and translation from the same RR snapshot', async () => {
  const p = await product({ name: 'Before snapshot' });
  const preview = await req('/api/product-translation-bulk-edit/previews', 'POST', {
    client_key: randomUUID(),
    locales: ['en'],
    rows: [
      {
        product_id: p.id,
        product_version: p.version,
        translation_version: null,
        locale: 'en',
        operation: 'set',
        patch: { name: 'Before English', description: 'Before text' },
      },
    ],
  });
  assert.equal(preview.statusCode, 201);
  const head = preview.json<{ preview: { id: string; scope_hash: string } }>().preview;
  const applied = await req(
    `/api/product-translation-bulk-edit/previews/${head.id}/execute`,
    'POST',
    { client_key: randomUUID(), scope_hash: head.scope_hash, confirmed: true },
  );
  assert.equal(applied.statusCode, 201);
  const blocker = await pool.connect();
  let pending: ReturnType<typeof openCatalogExport> | undefined;
  try {
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE product_translations IN ACCESS EXCLUSIVE MODE');
    pending = openCatalogExport(actor, {
      selection: 'selected',
      ids: [p.id],
      columns: ['name', 'translations_json'],
      spreadsheet_safe: false,
    });
    void pending.catch(() => {});
    let waiting = false;
    for (let i = 0; i < 300 && !waiting; i++) {
      waiting = (
        await pool.query<{ waiting: boolean }>(
          `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM product_translations t WHERE t.product_id%') AS waiting`,
        )
      ).rows[0].waiting;
      if (!waiting) await delay(10);
    }
    assert(waiting, 'export must actually wait on translation table');
    await blocker.query('UPDATE products SET name=$1,version=version+1 WHERE id=$2', [
      'After snapshot',
      p.id,
    ]);
    // Delete the current locale rather than forge new text under its immutable
    // manual receipt. The receipt/history stays intact while this writer commits.
    await blocker.query(
      'DELETE FROM product_translations WHERE tenant_id=$1 AND product_id=$2 AND locale=$3',
      [DEMO_TENANT, p.id, 'en'],
    );
    await blocker.query('COMMIT');
    const artifact = await pending;
    try {
      const buffers: Buffer[] = [];
      for await (const chunk of artifact.stream) buffers.push(Buffer.from(chunk));
      const frozen = csv(Buffer.concat(buffers).toString('utf8'))[0];
      assert.equal(frozen.name, 'Before snapshot');
      assert.deepEqual(JSON.parse(frozen.translations_json), [
        { locale: 'en', name: 'Before English', description: 'Before text', version: 1 },
      ]);
      await artifact.dispose();
      const fresh = csv((await file([p.id], ['name', 'translations_json'])).body)[0];
      assert.deepEqual(fresh, { name: 'After snapshot', translations_json: '[]' });
    } finally {
      await artifact.dispose();
    }
  } finally {
    await blocker.query('ROLLBACK').catch(() => {});
    blocker.release();
    if (pending)
      await pending.then(
        (f) => f.dispose(),
        () => {},
      );
  }
});
