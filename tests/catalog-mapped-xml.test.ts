import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  catalogFileImportPreviewInput,
  CATALOG_FILE_IMPORT_READONLY_FIELDS,
} from '../server/catalog-file-import-schema';
import { parseCatalogFileImport } from '../server/catalog-file-import-parse';
import { Problem } from '../server/errors';

type Field = { path: string; value_type?: 'text' | 'integer' | 'decimal_money' | 'boolean' };
const base = {
  client_key: '11111111-1111-4111-8111-111111111111',
  warehouse_id: '22222222-2222-4222-8222-222222222222',
  format: 'xml',
  currency: 'EUR',
};
function input(
  content: string,
  fields: Record<string, Field>,
  recordPath = '/feed/items/item',
  extra: Record<string, unknown> = {},
) {
  return catalogFileImportPreviewInput.parse({
    ...base,
    content,
    xml_mapping: { record_path: recordPath, fields },
    ...extra,
  });
}
function mapped(content: string, fields: Record<string, Field>, recordPath?: string) {
  return parseCatalogFileImport(input(content, fields, recordPath));
}
function refuses(action: () => unknown, status = 422) {
  assert.throws(action, (error: unknown) => error instanceof Problem && error.status === status);
}
const feed = (rows: string) => `<feed><items>${rows}</items></feed>`;

test('mapped XML reads producer nesting, QName attributes, CDATA and explicit currency', () => {
  const content =
    '\ufeff<?xml version="1.0"?>' +
    '<p:feed xmlns:p="urn:producer" xmlns:m="urn:metadata"><p:items>' +
    '<p:item sku="001-A" m:ean="000123"><p:label>A &amp; B</p:label>' +
    '<p:details><p:description><![CDATA[  Opis <tekst> 雪\n尾  ]]></p:description></p:details>' +
    '<p:amount gross="100.01"/><p:active>true</p:active><p:weight>1001</p:weight>' +
    '</p:item></p:items></p:feed>';
  const result = mapped(
    content,
    {
      sku: { path: '@sku' },
      ean: { path: '@m:ean' },
      name: { path: 'p:label' },
      description: { path: 'p:details/p:description' },
      price_minor: { path: 'p:amount/@gross', value_type: 'decimal_money' },
      active: { path: 'p:active', value_type: 'boolean' },
      weight_g: { path: 'p:weight', value_type: 'integer' },
    },
    '/p:feed/p:items/p:item',
  );
  assert.equal(result.currency, 'EUR');
  assert.deepEqual(result.rows, [
    {
      fields: {
        sku: '001-A',
        ean: '000123',
        name: 'A & B',
        description: '  Opis <tekst> 雪\n尾  ',
        price_minor: '10001',
        active: true,
        weight_g: '1001',
      },
      errors: [],
    },
  ]);
});

test('mapped XML money conversion is exact above floating precision and preserves genuine zero', () => {
  const values = ['0', '0.00', '1.2', '17.01', '90071992547409.93', '-1.01'];
  const result = mapped(
    feed(
      values.map((value, i) => `<item><sku>${i}</sku><amount>${value}</amount></item>`).join(''),
    ),
    {
      sku: { path: 'sku' },
      price_minor: { path: 'amount', value_type: 'decimal_money' },
    },
  );
  assert.deepEqual(
    result.rows.map((row) => row.fields.price_minor),
    ['0', '0', '120', '1701', '9007199254740993', '-101'],
  );
  assert(result.rows.every((row) => row.errors.length === 0));
});

test('mapped XML keeps absent fields omitted and explicit empty leaves for the ordinary empty policy', () => {
  for (const empty_policy of ['skip', 'clear']) {
    const q = input(
      feed('<item><sku>A</sku></item><item><sku>B</sku><desc/><price/><active/></item>'),
      {
        sku: { path: 'sku' },
        description: { path: 'desc' },
        price_minor: { path: 'price', value_type: 'decimal_money' },
        active: { path: 'active', value_type: 'boolean' },
      },
      undefined,
      { empty_policy },
    );
    assert.deepEqual(parseCatalogFileImport(q).rows, [
      { fields: { sku: 'A' }, errors: [] },
      { fields: { sku: 'B', description: '', price_minor: '', active: '' }, errors: [] },
    ]);
  }
});

test('mapped XML retains malformed typed values as invalid rows without coercion or losing later records', () => {
  const result = mapped(
    feed(
      '<item><sku>A</sku><price>1,23</price><qty>1.5</qty><flag>1</flag></item>' +
        '<item><sku>B</sku><price>1.234</price><qty>01</qty><flag> TRUE </flag></item>' +
        '<item><sku>C</sku><price>7.00</price><qty>-0</qty><flag>false</flag></item>',
    ),
    {
      sku: { path: 'sku' },
      price_minor: { path: 'price', value_type: 'decimal_money' },
      weight_g: { path: 'qty', value_type: 'integer' },
      active: { path: 'flag', value_type: 'boolean' },
    },
  );
  assert.deepEqual(
    result.rows.map((row) => row.errors.length),
    [3, 3, 0],
  );
  assert.deepEqual(result.rows[0].fields, {
    sku: 'A',
    price_minor: '1,23',
    weight_g: '1.5',
    active: '1',
  });
  assert.deepEqual(result.rows[2].fields, {
    sku: 'C',
    price_minor: '700',
    weight_g: '0',
    active: false,
  });
});

test('mapped XML rejects duplicate leaf or attribute matches for the entire batch', () => {
  refuses(() =>
    mapped(feed('<item><sku>A</sku><name>First</name><name>Second</name></item>'), {
      sku: { path: 'sku' },
      name: { path: 'name' },
    }),
  );
  refuses(() =>
    mapped(feed('<item><sku>A</sku><price value="1"/><price value="2"/></item>'), {
      sku: { path: 'sku' },
      price_minor: { path: 'price/@value', value_type: 'integer' },
    }),
  );
  refuses(() =>
    mapped(feed('<item><sku>A</sku><description>One<b>Two</b></description></item>'), {
      description: { path: 'description' },
    }),
  );
});

test('mapped XML schema only permits bounded literal paths and explicit writable mappings', () => {
  for (const path of [
    '//feed/item',
    '/feed/*',
    '/feed/../item',
    '/feed/item[1]',
    '/feed/@id',
    '/feed/item | /other/item',
    '/feed/item()',
    '/' + Array(17).fill('x').join('/'),
  ])
    assert.equal(
      catalogFileImportPreviewInput.safeParse({
        ...base,
        content: '<feed/>',
        xml_mapping: { record_path: path, fields: { sku: { path: '@id' } } },
      }).success,
      false,
      path,
    );
  for (const path of [
    '../name',
    '//name',
    'x/*',
    'x/@id/y',
    'text()',
    'name[1]',
    '@xmlns:p',
    'x//name',
    '',
    '/name',
  ])
    assert.equal(
      catalogFileImportPreviewInput.safeParse({
        ...base,
        content: '<feed/>',
        xml_mapping: { record_path: '/feed/item', fields: { name: { path } } },
      }).success,
      false,
      path,
    );
  for (const field of CATALOG_FILE_IMPORT_READONLY_FIELDS)
    assert.equal(
      catalogFileImportPreviewInput.safeParse({
        ...base,
        content: '<feed/>',
        ignore_readonly_fields: true,
        xml_mapping: { record_path: '/feed/item', fields: { [field]: { path: 'value' } } },
      }).success,
      false,
      field,
    );
  for (const extra of [{ format: 'csv' }, { mapping: { sku: 'code' } }])
    assert.equal(
      catalogFileImportPreviewInput.safeParse({
        ...base,
        content: '<feed/>',
        xml_mapping: { record_path: '/feed/item', fields: { sku: { path: '@id' } } },
        ...extra,
      }).success,
      false,
    );
  assert.equal(
    catalogFileImportPreviewInput.safeParse({
      ...base,
      content: '<feed/>',
      xml_mapping: { record_path: '/feed/item', fields: {}, unknown: true },
    }).success,
    false,
  );
});

test('mapped XML resolves namespace validity but never substitutes URI-equivalent literal QName paths', () => {
  refuses(() =>
    mapped(
      '<p:feed><p:items><p:item/></p:items></p:feed>',
      { sku: { path: '@id' } },
      '/p:feed/p:items/p:item',
    ),
  );
  const content =
    '<feed xmlns:a="urn:same" xmlns:b="urn:same"><items><item>' +
    '<a:sku>A</a:sku><b:sku>B</b:sku></item></items></feed>';
  assert.deepEqual(mapped(content, { sku: { path: 'a:sku' } }).rows, [
    { fields: { sku: 'A' }, errors: [] },
  ]);
  refuses(() => mapped(content, { sku: { path: 'a:sku' } }, '/other/items/item'));
});

test('mapped XML rejects XXE, processing instructions, malformed documents and invalid Unicode', () => {
  for (const content of [
    '<!DOCTYPE feed [<!ENTITY x SYSTEM "file:///etc/passwd">]>' +
      feed('<item><sku>&x;</sku></item>'),
    feed('<item><sku>&undeclared;</sku></item>'),
    '<?worker mutate="1"?>' + feed('<item/>'),
    feed('<item/>') + '<?worker?>',
    '<feed><items><item></items></feed>',
    '<feed/><feed/>',
    feed('<item a="1" a="2"/>'),
    feed('<item><sku>\0</sku></item>'),
    feed('<item><sku>\ud800</sku></item>'),
  ])
    refuses(() => mapped(content, { sku: { path: 'sku' } }));
});

test('mapped XML enforces record, depth, node and byte budgets without truncation', () => {
  const content = feed(Array.from({ length: 500 }, (_, i) => `<item sku="${i}"/>`).join(''));
  const result = mapped(content, { sku: { path: '@sku' } });
  assert.equal(result.rows.length, 500);
  assert.equal(new Set(result.rows.map((row) => row.fields.sku)).size, 500);
  refuses(() =>
    mapped(feed(Array(501).fill('<item sku="A"/>').join('')), { sku: { path: '@sku' } }),
  );
  refuses(() =>
    mapped(
      '<feed>' + '<x>'.repeat(16) + '</x>'.repeat(16) + '</feed>',
      { sku: { path: '@sku' } },
      '/feed',
    ),
  );
  refuses(() =>
    mapped(
      '<feed>' + '<!--x-->'.repeat(100000) + '<item/>' + '</feed>',
      { sku: { path: '@sku' } },
      '/feed/item',
    ),
  );
  refuses(
    () =>
      // Under the schema character cap, above the actual UTF-8 byte cap.
      mapped(feed('<item><sku>' + '雪'.repeat(700000) + '</sku></item>'), { sku: { path: 'sku' } }),
    413,
  );
});

test('native typed catalog XML stays unchanged when xml_mapping is absent', () => {
  const q = catalogFileImportPreviewInput.parse({
    ...base,
    currency: 'PLN',
    content:
      '<catalog currency="PLN"><product><sku type="string">001-A</sku>' +
      '<price_minor type="number">0</price_minor><active type="boolean">false</active>' +
      '<attributes_json type="object"><entry key="color" type="string">żółty</entry></attributes_json>' +
      '</product></catalog>',
  });
  assert.equal(q.xml_mapping, undefined);
  assert.deepEqual(parseCatalogFileImport(q), {
    currency: 'PLN',
    rows: [
      {
        fields: {
          sku: '001-A',
          price_minor: 0,
          active: false,
          attributes_json: { color: 'żółty' },
        },
        errors: [],
      },
    ],
  });
});

test('mapped XML uses the same full XML name grammar as the browser, including legal astral names', () => {
  assert.deepEqual(
    mapped(
      '<💾><商品·><🧾 code="A"><Ńame>雪</Ńame></🧾></商品·></💾>',
      {
        sku: { path: '@code' },
        name: { path: 'Ńame' },
      },
      '/💾/商品·/🧾',
    ).rows,
    [{ fields: { sku: 'A', name: '雪' }, errors: [] }],
  );
});
