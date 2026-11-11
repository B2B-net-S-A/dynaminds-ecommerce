import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Problem } from '../server/errors';
import { parseSupplierFileSource } from '../server/supplier-file-source-parse';
import {
  supplierFileSourceConfig,
  sourceCreateInput,
  configUpdateInput,
  previewInput,
  applyInput,
  pageInput,
  type SupplierFileSourceConfig,
} from '../server/supplier-file-source-schema';

const uuid = '11111111-1111-4111-8111-111111111111';
const fields = {
  remote_id: { path: 'ID' },
  name: { path: 'Nazwa' },
  cost_minor: { path: 'Cena', value_type: 'decimal_money' },
  quantity: { path: 'Stan', value_type: 'integer' },
};
const csv = (extra: Record<string, unknown> = {}) =>
  supplierFileSourceConfig.parse({ format: 'csv', fields, ...extra });
const parse = (content: string, config: SupplierFileSourceConfig = csv(), days = 2) =>
  parseSupplierFileSource(content, config, 'PLN', days);
const refuses = (fn: () => unknown, status = 422) =>
  assert.throws(fn, (e: unknown) => e instanceof Problem && e.status === status);
const head = 'ID;Nazwa;Cena;Stan\n';

test('supplier CSV preserves arbitrary remote identity, exact NET money, Unicode and genuine zero without local stock', () => {
  const rows = parse('\ufeff' + head + 'ref/a:001;"Towar 雪; A";10.23;4\r\nref-B;Drugi;0.00;0\r\n');
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => r.errors),
    [[], []],
  );
  assert.deepEqual(rows[0], {
    index: 0,
    remote_product_id: 'ref/a:001',
    remote_variant_id: '',
    sku: '',
    name: 'Towar 雪; A',
    errors: [],
    snapshot: {
      remote_product_id: 'ref/a:001',
      remote_variant_id: '',
      sku: '',
      name: 'Towar 雪; A',
      ean: null,
      description: '',
      images: [],
      unit_cost: 1023,
      currency: 'PLN',
      tiers: [],
      quantity: 4,
      active: true,
      handling: [{ quantity: 4, minHandlingDays: 0, maxHandlingDays: 0, warehouse: null }],
      condition: 'nieznany',
    },
  });
  assert.equal(rows[1].snapshot!.unit_cost, 0);
  assert.equal(rows[1].snapshot!.quantity, 0);
  assert(!Object.hasOwn(rows[0].snapshot!, 'on_hand'));
  assert(!Object.hasOwn(rows[0].snapshot!, 'simulation'));
});

test('supplier CSV minor units and decimal amounts stay exact at purchasing bounds and refuse float coercion', () => {
  const minor = csv({ fields: { ...fields, cost_minor: { path: 'Cena', value_type: 'integer' } } });
  assert.equal(
    parse(head + 'A;Towar;1000000000;10000000', minor)[0].snapshot!.unit_cost,
    1000000000,
  );
  assert.equal(parse(head + 'A;Towar;10000000.00;1')[0].snapshot!.unit_cost, 1000000000);
  assert.equal(parse(head + 'A;Towar;100.01;1')[0].snapshot!.unit_cost, 10001);
  for (const value of [
    '1e2',
    '1,23',
    '-1',
    '01',
    '+1',
    '1.001',
    '10000000.01',
    '9007199254740993',
    ' 1',
  ]) {
    const row = parse(head + `A;Towar;${value};1`)[0];
    assert.equal(row.snapshot, null, value);
    assert(
      row.errors.some((e) => e.includes('cost_minor')),
      value,
    );
  }
  assert.equal(parse(head + 'A;Towar;1.0;1', minor)[0].snapshot, null);
});

test('supplier missing or blank required amounts are durable errors rather than zero defaults', () => {
  for (const source of [
    'ID;Nazwa;Stan\nA;Towar;1',
    head + 'A;Towar;;1',
    'ID;Nazwa;Cena\nA;Towar;1.00',
    head + 'A;Towar;1.00;',
  ]) {
    const row = parse(source)[0];
    assert.equal(row.snapshot, null);
    assert(row.errors.some((e) => /cost_minor|quantity/.test(e)));
  }
  for (const qty of ['1.0', '-1', '1e3', '10000001'])
    assert.equal(parse(head + `A;Towar;1;${qty}`)[0].snapshot, null);
});

test('supplier availability is filtered only by explicit handling days while preserving the source bucket', () => {
  const config = csv({
    fields: { ...fields, handling_days: { path: 'Dni', value_type: 'integer' } },
  });
  const rows = parse(head.trim() + ';Dni\nA;Towar;1;7;2\nB;Drugi;1;9;3', config);
  assert.deepEqual(
    rows.map((r) => r.snapshot!.quantity),
    [7, 0],
  );
  assert.equal(rows[1].snapshot!.handling[0].quantity, 9);
  assert.equal(rows[1].snapshot!.handling[0].maxHandlingDays, 3);
  for (const value of ['', '-1', '366', '2.5'])
    assert.equal(parse(head.trim() + `;Dni\nA;Towar;1;7;${value}`, config)[0].snapshot, null);
  assert.equal(parse(head + 'A;Towar;1;7', config)[0].snapshot, null);
});

test('supplier row identity is the product/variant tuple and duplicates invalidate every implicated row', () => {
  const config = csv({
    fields: { ...fields, remote_variant_id: { path: 'Wariant' }, sku: { path: 'SKU' } },
  });
  const rows = parse(
    head.trim() + ';Wariant;SKU\nA;Pierwszy;1;2;x;SAME\nA;Drugi;2;3;y;SAME\nB;Trzeci;3;4;;SAME',
    config,
  );
  assert(rows.every((r) => r.errors.length === 0));
  assert.deepEqual(
    rows.map((r) => [r.remote_product_id, r.remote_variant_id]),
    [
      ['A', 'x'],
      ['A', 'y'],
      ['B', ''],
    ],
  );
  const duplicate = parse(
    head.trim() + ';Wariant;SKU\nA;Pierwszy;1;2;x;S1\nA;Drugi;2;3;x;S2',
    config,
  );
  assert(
    duplicate.every(
      (r) =>
        r.snapshot === null && r.errors.includes('Powtórzony identyfikator produktu i wariantu'),
    ),
  );
  assert.equal(parse(head + ';Towar;1;1')[0].snapshot, null);
  assert.equal(parse(head + '  ;Towar;1;1')[0].snapshot, null);
});

test('supplier XML reads namespaced nested attributes, CDATA and distinct supplier SKU without catalog field collisions', () => {
  const config = supplierFileSourceConfig.parse({
    format: 'xml',
    record_path: '/p:feed/p:items/p:item',
    fields: {
      remote_id: { path: '@id' },
      remote_variant_id: { path: '@variant' },
      sku: { path: 'p:sku' },
      name: { path: 'p:name' },
      cost_minor: { path: 'p:cost/@net', value_type: 'decimal_money' },
      quantity: { path: 'p:availability', value_type: 'integer' },
      ean: { path: '@ean' },
      description: { path: 'p:description' },
      handling_days: { path: 'p:availability/@days', value_type: 'integer' },
    },
  });
  const content =
    '<p:feed xmlns:p="urn:own"><p:items><p:item id="remote/001" variant="blue" ean="000123"><p:sku>SUP-SKU</p:sku><p:name>A &amp; B</p:name><p:cost net="17.01"/><p:availability days="2">3</p:availability><p:description><![CDATA[Opis <b>雪</b>\nLinia]]></p:description></p:item></p:items></p:feed>';
  const row = parseSupplierFileSource(content, config, 'EUR', 2)[0];
  assert.deepEqual(row.errors, []);
  assert.equal(row.remote_product_id, 'remote/001');
  assert.equal(row.remote_variant_id, 'blue');
  assert.equal(row.sku, 'SUP-SKU');
  assert.equal(row.snapshot!.unit_cost, 1701);
  assert.equal(row.snapshot!.currency, 'EUR');
  assert.equal(row.snapshot!.ean, '000123');
  assert.equal(row.snapshot!.description, 'Opis <b>雪</b>\nLinia');
  assert.equal(row.snapshot!.quantity, 3);
});

test('supplier XML missing and malformed numeric leaves stay invalid and do not partially synthesize snapshots', () => {
  const config = supplierFileSourceConfig.parse({
    format: 'xml',
    record_path: '/feed/item',
    fields: {
      remote_id: { path: '@id' },
      name: { path: 'name' },
      cost_minor: { path: 'cost', value_type: 'decimal_money' },
      quantity: { path: 'quantity', value_type: 'integer' },
    },
  });
  const rows = parse(
    '<feed><item id="A"><name>Towar</name><quantity>1</quantity></item><item id="B"><name>Drugi</name><cost>1.234</cost><quantity/></item><item id="C"><name>Trzeci</name><cost>0</cost><quantity>0</quantity></item></feed>',
    config,
  );
  assert.equal(rows.length, 3);
  assert.equal(rows[0].snapshot, null);
  assert.equal(rows[1].snapshot, null);
  assert(rows[0].errors.some((e) => e.includes('cost_minor')));
  assert(rows[1].errors.some((e) => e.includes('quantity')));
  assert.equal(rows[2].snapshot!.unit_cost, 0);
  assert.equal(rows[2].snapshot!.quantity, 0);
});

test('supplier XML refuses external entities, processing instructions, ambiguous leaves and invalid namespaces', () => {
  const config = supplierFileSourceConfig.parse({
    format: 'xml',
    record_path: '/feed/item',
    fields: {
      remote_id: { path: '@id' },
      name: { path: 'name' },
      cost_minor: { path: 'cost', value_type: 'integer' },
      quantity: { path: 'quantity', value_type: 'integer' },
    },
  });
  const item = '<item id="A"><name>Towar</name><cost>1</cost><quantity>2</quantity></item>';
  for (const content of [
    '<!DOCTYPE feed [<!ENTITY x SYSTEM "file:///etc/passwd">]><feed>' + item + '</feed>',
    '<feed><?fetch forbidden?>' + item + '</feed>',
    '<feed>' + item.replace('<cost>1</cost>', '<cost>1</cost><cost>2</cost>') + '</feed>',
    '<feed>' +
      item.replace('<name>Towar</name>', '<name><nested>Towar</nested></name>') +
      '</feed>',
    '<feed><p:item/></feed>',
  ])
    refuses(() => parse(content, config));
});

test('supplier schemas reject unknown fields, XPath, numeric type mismatches and missing exact confirmation/CAS inputs', () => {
  assert(
    sourceCreateInput.safeParse({
      client_key: uuid,
      supplier_id: uuid,
      name: 'Źródło',
      currency: 'PLN',
      config: csv(),
    }).success,
  );
  assert(
    !sourceCreateInput.safeParse({
      client_key: uuid,
      supplier_id: uuid,
      name: 'Źródło',
      currency: 'BTC',
      config: csv(),
    }).success,
  );
  assert(!configUpdateInput.safeParse({ version: 1, name: 'Źródło', config: csv() }).success);
  assert(
    configUpdateInput.safeParse({ client_key: uuid, version: 1, name: 'Źródło', config: csv() })
      .success,
  );
  assert(!applyInput.safeParse({ client_key: uuid, confirm_rows: 0 }).success);
  assert(!applyInput.safeParse({ client_key: uuid, confirm_rows: 501 }).success);
  assert.equal(applyInput.parse({ client_key: uuid, confirm_rows: 2 }).confirm_missing, false);
  assert.equal(
    previewInput.parse({ client_key: uuid, version: 1, content: 'source' }).scope,
    'delta',
  );
  assert(!previewInput.safeParse({ client_key: uuid, version: 0, content: 'source' }).success);
  assert.equal(pageInput.parse({ limit: '100' }).limit, 100);
  assert(!pageInput.safeParse({ limit: 101 }).success);
  for (const extra of [
    { fields: { ...fields, quantity: { path: 'Stan' } } },
    { fields: { ...fields, remote_id: { path: 'ID', value_type: 'integer' } } },
    { fields: { ...fields, quantity: { path: 'Cena', value_type: 'integer' } } },
    { fields: { ...fields, secret: { path: 'X' } } },
    { record_path: '/feed/item' },
    { format: 'xml', record_path: '/feed//item' },
    { format: 'xml', record_path: '/feed/item', fields: { ...fields, name: { path: '../name' } } },
  ])
    assert(!supplierFileSourceConfig.safeParse({ format: 'csv', fields, ...extra }).success);
});

test('supplier CSV rejects malformed framing/duplicate aliases and unsafe text without retaining truncated data', () => {
  for (const content of [
    'ID;ID;Cena;Stan\nA;Towar;1;1',
    'ID;id;Cena;Stan\nA;Towar;1;1',
    head + 'A;Towar;1',
    head + 'A;"Towar;1;1',
    head + 'A;"Towar"x;1;1',
    '__proto__;Nazwa;Cena;Stan\nA;Towar;1;1',
  ])
    refuses(() => parse(content));
  for (const content of [head + 'A;Towar\0;1;1', head + 'A;Towar\ud800;1;1'])
    refuses(() => parse(content));
  assert.equal(parse(head + 'A;"\tTowar";1;1')[0].snapshot, null);
  assert.equal(parse(head + 'A;Towar;1;1\nB;Drugi;1;1').length, 2);
});

test('supplier parser accepts exactly 500 rows and refuses 501 and UTF8 byte overflow without truncation', () => {
  const source = Array.from({ length: 500 }, (_, i) => `R${i};Towar ${i};1.01;${i}`).join('\n');
  const rows = parse(head + source);
  assert.equal(rows.length, 500);
  assert.equal(rows[499].index, 499);
  assert.equal(rows[499].snapshot!.quantity, 499);
  refuses(() => parse(head + source + '\nEXTRA;Towar;1;1'));
  refuses(() => parse(head + 'A;' + '雪'.repeat(700000) + ';1;1'), 413);
});

test('supplier XML enforces full-record, nesting and node budgets independently of selected values', () => {
  const config = supplierFileSourceConfig.parse({
    format: 'xml',
    record_path: '/feed/item',
    fields: {
      remote_id: { path: '@id' },
      name: { path: 'name' },
      cost_minor: { path: 'cost', value_type: 'integer' },
      quantity: { path: 'quantity', value_type: 'integer' },
    },
  });
  const items = Array.from(
    { length: 500 },
    (_, i) => `<item id="R${i}"><name>Towar</name><cost>1</cost><quantity>0</quantity></item>`,
  ).join('');
  assert.equal(parse('<feed>' + items + '</feed>', config).length, 500);
  refuses(() => parse('<feed>' + items + '<item/>' + '</feed>', config));
  refuses(() => parse('<feed>' + '<deep>'.repeat(16) + '</deep>'.repeat(16) + '</feed>', config));
  refuses(() => parse('<feed>' + '<unused/>'.repeat(100000) + '</feed>', config));
});
