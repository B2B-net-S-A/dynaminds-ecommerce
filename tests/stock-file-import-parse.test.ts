import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { parseStockFile } from '../server/stock-file-import-parse';
import {
  stockFileImportPreviewInput,
  stockFileImportExecuteInput,
  stockFileImportProfileInput,
  stockFileImportPosition,
  STOCK_FILE_IMPORT_LIMITS,
  type StockFileImportInput,
} from '../server/stock-file-import-schema';

const warehouse = randomUUID();
function input(content: string, changes: Record<string, any> = {}): StockFileImportInput {
  return stockFileImportPreviewInput.parse({
    client_key: randomUUID(),
    file_name: 'physical.csv',
    content,
    note: 'Own physical count',
    definition: {
      format: 'csv',
      xml_mode: 'positions',
      delimiter: ';',
      identity: 'sku',
      identity_field: 'Kod',
      spreadsheet_safe: false,
      empty_policy: 'skip',
    },
    targets: [
      {
        warehouse_id: warehouse,
        quantity_scope: 'position',
        mapping: { quantity: 'Stan' },
        default_location: 'A-01',
      },
    ],
    resolutions: [],
    ...changes,
  });
}
const cell = (b: StockFileImportInput, index = 0) => parseStockFile(b).rows[index].cells[0];
const rejected = (fn: () => unknown, status = 422) =>
  assert.throws(fn, (e: any) => e.status === status);
const xmlEscape = (v: string) =>
  v.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
// Independent native-format fixture, without loading an exporter or database module.
function typed(tag: string, value: any, key?: string): string {
  const attribute = key === undefined ? '' : ` key="${xmlEscape(key)}"`;
  if (value === null) return `<${tag}${attribute} nil="true"/>`;
  const type = Array.isArray(value) ? 'array' : typeof value;
  const contents = Array.isArray(value)
    ? value.map((v) => typed('item', v)).join('')
    : type === 'object'
      ? Object.entries(value)
          .map(([k, v]) => typed('entry', v, k))
          .join('')
      : xmlEscape(String(value));
  return `<${tag}${attribute} type="${type}">${contents}</${tag}>`;
}
function catalog(groups: any[]) {
  const b = input(
    `<catalog currency="PLN"><product>${typed('sku', 'OWN')}${typed('inventory_json', groups)}</product></catalog>`,
  );
  b.definition = { ...b.definition, format: 'xml', xml_mode: 'catalog', identity_field: 'sku' };
  b.targets[0] = {
    ...b.targets[0],
    quantity_scope: 'warehouse_total',
    mapping: { quantity: 'inventory_json' },
  };
  return b;
}
const position = (quantity: number, location = 'A-01') => ({
  location,
  quantity,
  lot: null,
  unit_cost_minor: null,
  currency: null,
});

test('stock file parser retains absolute zero, explicit none and blank separately from malformed counts', () => {
  const b = input(
    'Kod;Stan;Op\nZERO;0;count\nSKIP;999;none\nBLANK;;\nNEG;-1;count\nFRAC;1.5;count\nLIMIT;1000001;count',
  );
  b.targets[0].mapping.operation = 'Op';
  const parsed = parseStockFile(b);
  assert.equal(parsed.source_hash, createHash('sha256').update(b.content).digest('hex'));
  assert.deepEqual(
    parsed.rows.map((r) => r.identity),
    ['ZERO', 'SKIP', 'BLANK', 'NEG', 'FRAC', 'LIMIT'],
  );
  assert.equal(parsed.rows[0].cells[0].quantity, 0);
  assert.deepEqual(parsed.rows[0].cells[0].positions, [position(0)]);
  for (const i of [1, 2])
    assert.deepEqual(parsed.rows[i].cells[0], {
      warehouse_id: warehouse,
      operation: 'none',
      quantity: null,
      positions: [],
      errors: [],
    });
  for (const i of [3, 4, 5]) assert(parsed.rows[i].cells[0].errors.length > 0);
  const missing = cell(input('Kod;Other\nOWN;0'));
  assert.match(missing.errors.join(' '), /Brak mapowanego pola/);
  const required = input('Kod;Stan\nOWN;');
  required.definition.empty_policy = 'error';
  assert.match(cell(required).errors.join(' '), /Brak wymaganego pomiaru/);
  const id = randomUUID(),
    byUuid = input(`Kod;Stan\n${id.toUpperCase()};0\nnot-a-uuid;0`);
  byUuid.definition.identity = 'uuid';
  const identified = parseStockFile(byUuid);
  assert.equal(identified.rows[0].identity, id);
  assert.equal(identified.rows[0].raw_cells.Kod, id.toUpperCase());
  assert.deepEqual(identified.rows[0].errors, []);
  assert.equal(identified.rows[1].identity, null);
  assert(identified.rows[1].errors.length > 0);
});

test('stock positions XML preserves int64 money text and rejects unsafe structure instead of interpreting it', () => {
  const b = input(
    '<dynaminds-stock-counts version="1"><row><field name="Kod">OWN&amp;Ł</field><field name="Stan">1</field><field name="Koszt">9007199254740993</field><field name="Waluta">PLN</field></row></dynaminds-stock-counts>',
  );
  b.definition.format = 'xml';
  b.targets[0].mapping = { quantity: 'Stan', unit_cost_minor: 'Koszt', currency: 'Waluta' };
  assert.equal(parseStockFile(b).rows[0].identity, 'OWN&Ł');
  assert.equal(cell(b).positions[0].unit_cost_minor, '9007199254740993');
  for (const content of [
    '<!DOCTYPE x [<!ENTITY x SYSTEM "file:///etc/passwd">]>' + b.content,
    '<dynaminds-stock-counts version="1"><row><field name="Kod"><nested/></field></row></dynaminds-stock-counts>',
    '<dynaminds-stock-counts version="1"><row><field name="constructor">x</field></row></dynaminds-stock-counts>',
    '<dynaminds-stock-counts version="1"><row><field name="Kod">a</field><field name="Kod">b</field></row></dynaminds-stock-counts>',
    '<dynaminds-stock-counts xmlns="urn:other" version="1"><row><field name="Kod">x</field></row></dynaminds-stock-counts>',
  ])
    rejected(() => parseStockFile({ ...b, content }));
  for (const cost of ['01', '-1', '1.5', '9223372036854775808'])
    assert(
      !stockFileImportPosition.safeParse({ ...position(1), unit_cost_minor: cost, currency: 'PLN' })
        .success,
    );
});

test('stock catalog XML selects own warehouse physical on_hand and demands conserved explicit positions', () => {
  const groups = [
    { warehouse_id: randomUUID(), status: 'available', source: 'stock', on_hand: 999 },
    {
      warehouse_id: warehouse,
      status: 'available',
      source: 'stock',
      on_hand: 3,
      reserved: 2,
      available: 1,
    },
  ];
  const b = catalog(groups);
  assert.equal(cell(b).quantity, 3);
  assert.match(cell(b).errors.join(' '), /Agregat wymaga/);
  b.resolutions = [
    { source_index: 0, warehouse_id: warehouse, positions: [position(1), position(2, 'B-02')] },
  ];
  assert.deepEqual(cell(b).positions, b.resolutions[0].positions);
  assert.deepEqual(cell(b).errors, []);
  b.resolutions[0].positions[1].quantity = 1;
  assert.match(cell(b).errors.join(' '), /nie pokrywa/);
  for (const source of ['components', null])
    assert.match(
      cell(catalog([{ ...groups[1], source }])).errors.join(' '),
      /własnego stanu fizycznego/,
    );
  assert.match(cell(catalog([groups[1], groups[1]])).errors.join(' '), /Powtórzona grupa/);
  for (const rows of [
    [],
    [{ warehouse_id: warehouse, status: 'missing', source: 'stock', on_hand: null }],
  ]) {
    const c = cell(catalog(rows));
    assert.equal(c.operation, 'none');
    assert.equal(c.quantity, null);
    assert.deepEqual(c.errors, []);
  }
});

test('stock schema rejects ambiguous configuration and approval-bearing profiles, normalizes exact consent sets', () => {
  const b = input('Kod;Stan\nOWN;1');
  for (const bad of [
    { ...b, targets: [b.targets[0], b.targets[0]] },
    { ...b, targets: [{ ...b.targets[0], mapping: { quantity: 'Kod' } }] },
    { ...b, targets: [{ ...b.targets[0], mapping: { quantity: 'Stan', location: 'Stan' } }] },
    {
      ...b,
      resolutions: [{ source_index: 0, warehouse_id: randomUUID(), positions: [position(1)] }],
    },
    {
      ...b,
      resolutions: [
        { source_index: 0, warehouse_id: warehouse, positions: [position(1), position(0)] },
      ],
    },
    { ...b, definition: { ...b.definition, remove: true } },
  ])
    assert(!stockFileImportPreviewInput.safeParse(bad).success);
  const profile = {
    client_key: randomUUID(),
    name: 'Own mapping',
    definition: b.definition,
    targets: b.targets,
  };
  assert(stockFileImportProfileInput.safeParse(profile).success);
  for (const extra of [
    { content: b.content },
    { resolutions: [] },
    { ack_surplus_warehouse_ids: [] },
  ])
    assert(!stockFileImportProfileInput.safeParse({ ...profile, ...extra }).success);
  const consent = {
    client_key: randomUUID(),
    scope_hash: 'a'.repeat(64),
    confirmed: true,
    ack_surplus_warehouse_ids: [warehouse.toUpperCase()],
    ack_unknown_loss_warehouse_ids: [],
  };
  assert.deepEqual(stockFileImportExecuteInput.parse(consent).ack_surplus_warehouse_ids, [
    warehouse,
  ]);
  assert(
    !stockFileImportExecuteInput.safeParse({
      ...consent,
      ack_surplus_warehouse_ids: [warehouse, warehouse.toUpperCase()],
    }).success,
  );
  assert(!stockFileImportExecuteInput.safeParse({ ...consent, confirmed: false }).success);
});

test('stock parser keeps 500 complete source rows and enforces UTF8 bytes independently of character count', () => {
  const b = input('Kod;Stan\n' + Array.from({ length: 500 }, (_, i) => `OWN-${i};0`).join('\n'));
  assert.equal(parseStockFile(b).rows.length, 500);
  rejected(() => parseStockFile({ ...b, content: b.content + '\nEXCESS;0' }));
  const multibyte = 'Kod;Stan\n' + 'Ł'.repeat(1100000) + ';1';
  assert(multibyte.length < STOCK_FILE_IMPORT_LIMITS.file_bytes);
  rejected(() => parseStockFile({ ...b, content: multibyte }), 413);
  rejected(() => parseStockFile(input('Kod;Kod\nOWN;1')));
  rejected(() => parseStockFile(input('Kod;__proto__\nOWN;1')));
  const width = parseStockFile(input('Kod;Stan\nOWN;1;EXTRA'));
  assert.match(width.rows[0].errors.join(' '), /Liczba komórek/);
});
