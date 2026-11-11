/** Source-authored pure tests. Root executes; no DB, routes, login or renderer IAM claim. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { SaxesParser } from 'saxes';
import { Problem } from '../server/errors';
import type { CatalogStockCountPublicDocument } from '../server/catalog-stock-count-query';
import { renderCatalogStockCountExport, type CatalogStockCountExportRow } from '../server/catalog-stock-count-export';

const id = (n: number) => `${String(n).padStart(8, '0')}-1690-4169-8169-169169169169`;
type Fixture = { document: CatalogStockCountPublicDocument; rows: CatalogStockCountExportRow[] };
function fixture(count = 101, on = true, kind: 'PW' | 'RW' = 'RW'): Fixture {
  const document: CatalogStockCountPublicDocument = {
    id: id(1), receipt_id: id(2), source_id: id(3), execution_id: id(4), protocol: on ? 'stock_file' : 'inventory_bulk',
    warehouse_id: id(5), warehouse: { id: id(5), name: 'Zapisany magazyn <A> & "B"', code: 'OLD' },
    kind, number: `${kind}/2026/000001`, year: 2026, sequence: '1', series_id: id(6), row_count: count,
    quantity: String(count), wms_enabled: on, created_at: '2026-10-07T12:34:56.123456+00:00',
  };
  const rows: CatalogStockCountExportRow[] = Array.from({ length: count }, (_, ordinal) => ({
    id: id(1000 + ordinal), ordinal, document_id: document.id, warehouse_id: document.warehouse_id,
    product_id: id(20000 + ordinal), sku: 'SAME-SKU', name: `Pozycja ${ordinal}: <>&"',\npolskie ąę`, location: 'BIN-A',
    delta: kind === 'PW' ? 1 : -1, quantity: '1', bin_movement_id: on ? null : id(40000 + ordinal),
    layer_movement_id: on ? id(50000 + ordinal) : null, source_index: on ? ordinal : null,
    stocktake_line_id: on ? id(60000 + ordinal) : null, stocktake_posting_id: on ? id(7) : null,
    lot_id: on ? id(70000 + ordinal) : null, layer_id: on ? id(80000 + ordinal) : null,
    ...(on ? { unit_cost_minor: ordinal % 3 === 1 ? null : ordinal % 3 === 0 ? '0' : '9007199254740993',
      value_minor: ordinal % 3 === 1 ? null : ordinal % 3 === 0 ? '0' : '9007199254740993', currency: 'PLN', exponent: 2 } : {}),
  }));
  return { document, rows };
}
const render = (f: Fixture, format: 'csv' | 'xml', includeValues = true) =>
  renderCatalogStockCountExport(f.document, f.rows, { format, includeValues });

// Independent parser: quoted CSV fields and embedded CR/LF are records, not split lines.
function csv(content: string): Record<string, string>[] {
  const records: string[][] = []; let fields: string[] = [], cell = '', quoted = false;
  for (let n = 0; n < content.length; n++) {
    const c = content[n];
    if (quoted) {
      if (c === '"' && content[n + 1] === '"') { cell += '"'; n++; }
      else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') { assert.equal(cell, ''); quoted = true; }
    else if (c === ',') { fields.push(cell); cell = ''; }
    else if (c === '\r' && content[n + 1] === '\n') { fields.push(cell); records.push(fields); fields = []; cell = ''; n++; }
    else cell += c;
  }
  assert.equal(quoted, false); assert.deepEqual(fields, []); assert.equal(cell, '');
  const columns = records.shift(); assert(columns); assert.equal(new Set(columns).size, columns.length);
  return records.map(r => { assert.equal(r.length, columns.length); return Object.fromEntries(columns.map((k, n) => [k, r[n]])); });
}
type Xml = { name: string; attributes: Record<string, unknown>; children: Xml[]; text: string };
function xml(content: string): Xml {
  const parser = new SaxesParser(), stack: Xml[] = []; let root: Xml | undefined;
  parser.on('doctype', () => assert.fail('DTD must never appear'));
  parser.on('opentag', tag => {
    const node: Xml = { name: tag.name, attributes: { ...tag.attributes }, children: [], text: '' };
    if (stack.length) stack.at(-1)!.children.push(node); else { assert.equal(root, undefined); root = node; }
    stack.push(node);
  });
  parser.on('text', text => { if (stack.length) stack.at(-1)!.text += text; else assert.equal(text.trim(), ''); });
  parser.on('closetag', () => { stack.pop(); }); parser.write(content).close();
  assert(root); assert.equal(stack.length, 0); return root;
}
function fields(node: Xml): Record<string, string | null> {
  assert.equal(node.text.trim(), '');
  assert.equal(new Set(node.children.map(c => c.name)).size, node.children.length);
  return Object.fromEntries(node.children.map(c => {
    assert.equal(c.children.length, 0);
    if (c.attributes.nil === 'true') { assert.deepEqual(c.attributes, { nil: 'true' }); assert.equal(c.text, ''); return [c.name, null]; }
    assert.deepEqual(c.attributes, {}); return [c.name, c.text];
  }));
}
function child(node: Xml, name: string): Xml {
  const selected = node.children.filter(c => c.name === name); assert.equal(selected.length, 1); return selected[0];
}
function refused(work: () => unknown, status: number) {
  assert.throws(work, (error: unknown) => error instanceof Problem && error.status === status);
}
const monetaryKeys = ['unit_cost_minor', 'value_minor', 'currency', 'exponent', 'known_value_minor', 'signed_known_value_minor'];
function expectedBuckets(f: Fixture) {
  const buckets = new Map<string, { currency: string; exponent: number; known_quantity: bigint; zero_cost_quantity: bigint;
    unknown_quantity: bigint; known_value_minor: bigint; signed_known_value_minor: bigint }>();
  for (const r of f.rows) {
    assert(r.currency !== undefined && r.exponent !== undefined && r.unit_cost_minor !== undefined && r.value_minor !== undefined);
    const key = r.currency + ':' + r.exponent;
    const b = buckets.get(key) ?? { currency: r.currency, exponent: r.exponent, known_quantity: 0n, zero_cost_quantity: 0n,
      unknown_quantity: 0n, known_value_minor: 0n, signed_known_value_minor: 0n };
    const q = BigInt(r.quantity);
    if (r.unit_cost_minor === null) b.unknown_quantity += q;
    else { b.known_quantity += q; if (r.unit_cost_minor === '0') b.zero_cost_quantity += q;
      const amount = BigInt(r.unit_cost_minor) * q; b.known_value_minor += amount; b.signed_known_value_minor += r.delta > 0 ? amount : -amount; }
    buckets.set(key, b);
  }
  return [...buckets.values()].sort((a, b) => a.currency.localeCompare(b.currency) || a.exponent - b.exponent)
    .map(b => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, typeof v === 'bigint' ? String(v) : v])));
}

const columns = ['record_type','document_id','receipt_id','source_id','execution_id','protocol','number','kind',
  'series_id','year','sequence','created_at','warehouse_id','warehouse_name','warehouse_code','wms_enabled','row_count',
  'quantity','value_state','ordinal','row_id','product_id','sku','name','location','delta','bin_movement_id','layer_movement_id',
  'source_index','stocktake_line_id','stocktake_posting_id','lot_id','layer_id'];
const valueColumns = ['cost_state','unit_cost_minor','value_minor','currency','exponent','known_quantity',
  'zero_cost_quantity','unknown_quantity','known_value_minor','signed_known_value_minor'];
function text(v: unknown): string { return v === null || v === undefined ? '' : String(v); }

test('independently parsed CSV contains all101 same-SKU physical rows, exact IDs/signs and all valuation buckets', () => {
  const f = fixture(), result = render(f, 'csv'), records = csv(result.content);
  assert.equal(result.content.split('\r\n')[0], [...columns, ...valueColumns].map(c => '"' + c + '"').join(','));
  assert.equal(records[0].record_type, 'document'); assert.equal(records[0].document_id, f.document.id);
  assert.equal(records[0].number, f.document.number); assert.equal(records[0].quantity, '101');
  assert.equal(records[0].row_count, '101'); assert.equal(records[0].warehouse_name, f.document.warehouse.name);
  assert.equal(records[0].warehouse_code, f.document.warehouse.code);
  assert.equal(records.filter(r => r.record_type === 'document').length, 1);
  const common = { document_id: f.document.id, receipt_id: f.document.receipt_id, source_id: f.document.source_id,
    execution_id: f.document.execution_id, protocol: f.document.protocol, number: f.document.number, kind: f.document.kind,
    series_id: f.document.series_id, year: String(f.document.year), sequence: f.document.sequence,
    created_at: f.document.created_at, warehouse_id: f.document.warehouse_id, wms_enabled: String(f.document.wms_enabled),
    value_state: 'partial_unknown' };
  for (const record of records) for (const [key, value] of Object.entries(common))
    assert.equal(record[key], value, 'Exact CSV common identity ' + key + ' in ' + record.record_type);
  for (const key of ['ordinal','row_id','product_id','sku','name','location','delta','bin_movement_id','layer_movement_id',
    'source_index','stocktake_line_id','stocktake_posting_id','lot_id','layer_id', ...valueColumns])
    assert.equal(records[0][key], '', 'Document record does not invent unrelated field ' + key);
  const buckets = records.filter(r => r.record_type === 'valuation'); assert.equal(buckets.length, 1);
  for (const [key, value] of Object.entries(expectedBuckets(f)[0])) assert.equal(buckets[0][key], String(value));
  for (const key of ['warehouse_name','warehouse_code','row_count','ordinal','row_id','product_id','sku','name','location','delta',
    'bin_movement_id','layer_movement_id','source_index','stocktake_line_id','stocktake_posting_id','lot_id','layer_id',
    'cost_state','unit_cost_minor','value_minor']) assert.equal(buckets[0][key], '', 'Bucket does not invent row field ' + key);
  const physical = records.filter(r => r.record_type === 'row'); assert.equal(physical.length, 101);
  assert.equal(records.length, 103); assert.equal(new Set(physical.map(r => r.row_id)).size, 101);
  assert.equal(new Set(physical.map(r => r.sku)).size, 1, 'Same SKU never collapses original physical identity');
  assert.equal(physical.reduce((n, r) => n + BigInt(r.delta), 0n), -101n);
  for (let ordinal = 0; ordinal < f.rows.length; ordinal++) {
    const row = f.rows[ordinal], serialized = physical[ordinal];
    assert.equal(serialized.document_id, f.document.id); assert.equal(serialized.receipt_id, f.document.receipt_id);
    assert.equal(serialized.source_id, f.document.source_id); assert.equal(serialized.execution_id, f.document.execution_id);
    assert.equal(serialized.number, f.document.number); assert.equal(serialized.warehouse_id, f.document.warehouse_id);
    assert.equal(serialized.row_id, row.id);
    for (const key of ['warehouse_name','warehouse_code','row_count','known_quantity','zero_cost_quantity','unknown_quantity',
      'known_value_minor','signed_known_value_minor']) assert.equal(serialized[key], '', 'Physical row does not invent head/bucket field ' + key);
    for (const key of ['ordinal','product_id','sku','name','location','delta','quantity','bin_movement_id','layer_movement_id',
      'source_index','stocktake_line_id','stocktake_posting_id','lot_id','layer_id','unit_cost_minor','value_minor','currency','exponent'] as const)
      assert.equal(serialized[key], text(row[key]), 'Saved CSV cell ' + key + ' row ' + ordinal);
    assert.equal(serialized.cost_state, row.unit_cost_minor === null ? 'unknown' : 'known');
  }
});

test('strict XML parser recovers full head/101rows, NULL nil and literal zero; redacted XML omits financial elements', () => {
  const f = fixture(), valued = render(f, 'xml'), root = xml(valued.content);
  assert.equal(root.name, 'count_document'); assert.deepEqual(root.attributes, { version: '1' });
  assert.deepEqual(root.children.map(n => n.name), ['document', 'valuation', 'rows']);
  const head = child(root, 'document');
  for (const key of ['id','receipt_id','source_id','execution_id','protocol','warehouse_id','kind','number','year','sequence',
    'series_id','row_count','quantity','wms_enabled','created_at'] as const)
    assert.equal(child(head, key).text, String(f.document[key]));
  assert.deepEqual(fields(child(head, 'warehouse')), f.document.warehouse);
  const rows = child(root, 'rows').children; assert.equal(rows.length, 101); assert(rows.every(r => r.name === 'row'));
  for (let ordinal = 0; ordinal < rows.length; ordinal++) {
    const expected = Object.fromEntries(Object.entries({ ...f.rows[ordinal], cost_state: f.rows[ordinal].unit_cost_minor === null ? 'unknown' : 'known' })
      .map(([key, value]) => [key, value === null ? null : String(value)]));
    assert.deepEqual(fields(rows[ordinal]), expected, 'All saved XML row fields survive actual parsing');
  }
  assert.equal(fields(rows[0]).unit_cost_minor, '0'); assert.equal(fields(rows[1]).unit_cost_minor, null);
  const valuation = child(root, 'valuation'); assert.equal(child(valuation, 'physical_quantity').text, '101');
  const buckets = child(valuation, 'buckets').children; assert.equal(buckets.length, 1); assert.equal(buckets[0].name, 'bucket');
  assert.deepEqual(fields(buckets[0]), Object.fromEntries(Object.entries(expectedBuckets(f)[0]).map(([key, value]) => [key, String(value)])));
  const redacted = xml(render(f, 'xml', false).content); assert.deepEqual(redacted.children.map(n => n.name), ['document', 'rows']);
  for (const row of child(redacted, 'rows').children) for (const key of [...monetaryKeys, 'cost_state']) assert.equal(key in fields(row), false);
});

test('CSV formula protection retains quoted newlines/commas; XML rejects invalid codepoints instead of lossy sanitization', () => {
  const f = fixture(6, false), inputs = ['=SUM(1,2)', ' +1', '-5', '@A1', '\t=2', '\n=3'];
  for (let i = 0; i < f.rows.length; i++) f.rows[i].name = inputs[i];
  const records = csv(render(f, 'csv', false).content).filter(r => r.record_type === 'row');
  assert.deepEqual(records.map(r => r.name), inputs.map(v => "'" + v));
  assert(records.every(r => r.delta === '-1'), 'Typed numeric RW delta is not a text formula');
  const recovered = child(xml(render(f, 'xml', false).content), 'rows').children.map(r => fields(r).name);
  assert.deepEqual(recovered, inputs, 'XML escaping preserves valid text without spreadsheet representation');
  const newline = fixture(3, false); newline.rows[0].name = 'before\rafter'; newline.rows[1].name = 'before\r\nafter';
  const csvNewlines = csv(render(newline, 'csv', false).content).filter(r => r.record_type === 'row');
  const xmlNewlines = child(xml(render(newline, 'xml', false).content), 'rows').children;
  assert.deepEqual(csvNewlines.map(r => r.name), newline.rows.map(r => r.name));
  assert.deepEqual(xmlNewlines.map(r => fields(r).name), newline.rows.map(r => r.name),
    'Character references must preserve CR/CRLF despite XML line-ending normalization');
  for (const bad of ['\u0000','\u0001','\u000b','\ufffe','\uffff','\ud800','\udfff']) for (const format of ['csv', 'xml'] as const) {
    const invalid = fixture(3, false); invalid.rows[0].name = 'before' + bad + 'after'; refused(() => render(invalid, format, false), 422);
  }
});

test('whole101-row RW valuation keeps0/NULL and exact int64 values in separate real currency/exponent buckets', () => {
  const f = fixture();
  for (const r of f.rows) { r.currency = ['JPY', 'KWD', 'PLN'][Math.floor(r.ordinal / 3) % 3];
    r.exponent = r.currency === 'JPY' ? 0 : r.currency === 'KWD' ? 3 : 2; }
  f.document.sequence = '9007199254740993'; f.document.number = 'RW/2026/9007199254740993';
  for (const format of ['csv', 'xml'] as const) {
    const result = render(f, format);
    assert.equal(result.values_included, true); assert.equal(result.value_state, 'partial_unknown');
    assert.equal(result.row_count, 101); assert.deepEqual(result.document, f.document);
    assert.deepEqual(result.valuation, { state: 'partial_unknown', physical_quantity: '101', buckets: expectedBuckets(f) });
    assert(result.valuation!.buckets.every(b => BigInt(b.signed_known_value_minor) <= 0n));
    assert.equal(result.filename, `RW-count-${f.document.id}.${format}`);
    assert.equal(result.content_type, format === 'csv' ? 'text/csv; charset=utf-8' : 'application/xml; charset=utf-8');
    assert.equal('snapshot_at' in result, false, 'A transport timestamp must not alter immutable file bytes');
  }
});

test('known-zero differs from unknown, and selected whole-manifest values never silently become zero on redaction or OFF', () => {
  const f = fixture(3); for (const r of f.rows) { r.unit_cost_minor = '0'; r.value_minor = '0'; }
  const complete = render(f, 'xml'); assert.equal(complete.value_state, 'complete');
  assert.deepEqual(complete.valuation, { state: 'complete', physical_quantity: '3', buckets: [
    { currency: 'PLN', exponent: 2, known_quantity: '3', zero_cost_quantity: '3', unknown_quantity: '0', known_value_minor: '0', signed_known_value_minor: '0' },
  ] });
  for (const format of ['csv', 'xml'] as const) for (const [input, requested, state] of [
    [f, false, 'not_requested'], [fixture(3, false), true, 'unavailable_off'],
  ] as const) {
    const result = render(input, format, requested); assert.equal(result.values_included, false); assert.equal(result.value_state, state);
    assert.equal('valuation' in result, false); assert.equal(result.row_count, 3);
    for (const key of monetaryKeys) assert(!JSON.stringify(result).includes(key), `No projected money field ${key}`);
  }
  const missing = fixture(3); delete missing.rows[0].unit_cost_minor;
  refused(() => render(missing, 'xml'), 409);
  const off = fixture(3, false); Object.assign(off.rows[0], { unit_cost_minor: '0', value_minor: '0', currency: 'PLN', exponent: 2 });
  refused(() => render(off, 'csv'), 409);
});

test('PW carries positive signed physical and monetary amounts while known0 and unknown remain distinct', () => {
  const f = fixture(3, true, 'PW'), quantities = [2, 3, 4]; f.document.quantity = '9';
  for (let n = 0; n < f.rows.length; n++) {
    const row = f.rows[n]; row.delta = quantities[n]; row.quantity = String(quantities[n]);
    row.value_minor = row.unit_cost_minor === null ? null : String(BigInt(row.unit_cost_minor!) * BigInt(row.quantity));
  }
  const expected = { state: 'partial_unknown', physical_quantity: '9', buckets: [{ currency: 'PLN', exponent: 2,
    known_quantity: '6', zero_cost_quantity: '2', unknown_quantity: '3', known_value_minor: '36028797018963972',
    signed_known_value_minor: '36028797018963972' }] };
  for (const format of ['csv', 'xml'] as const) {
    const result = render(f, format); assert.equal(result.value_state, 'partial_unknown'); assert.deepEqual(result.valuation, expected);
    assert.equal(result.document.number, 'PW/2026/000001'); assert.equal(result.row_count, 3);
    const physical = format === 'csv' ? csv(result.content).filter(r => r.record_type === 'row')
      : child(xml(result.content), 'rows').children.map(fields);
    assert.deepEqual(physical.map(r => r.delta), ['2','3','4']); assert.deepEqual(physical.map(r => r.quantity), ['2','3','4']);
    assert.equal(physical[0].unit_cost_minor, '0'); assert.equal(physical[0].value_minor, '0');
    assert.equal(physical[1].value_minor, format === 'csv' ? '' : null);
    assert.equal(physical[2].value_minor, '36028797018963972');
    assert.equal(physical.reduce((sum, r) => sum + BigInt(r.delta!), 0n), 9n);
  }
});

test('identical immutable input and options produce complete byte-identical exports without mutating caller-owned rows', () => {
  const f = fixture(), before = structuredClone(f);
  for (const format of ['csv', 'xml'] as const) for (const values of [false, true]) {
    const first = render(f, format, values), second = render(structuredClone(f), format, values);
    assert.deepEqual(Buffer.from(second.content, 'utf8'), Buffer.from(first.content, 'utf8'));
    assert.deepEqual(second, first); assert.deepEqual(f, before);
  }
});

test('invalid ordinal/sign/foreign identity/duplicate movements/full count or sum fail as a whole409 without partial export', () => {
  const corruptions: Array<(f: Fixture) => void> = [
    f => { f.rows[0].ordinal = 1; }, f => { f.rows[0].delta = 1; },
    f => { f.rows[0].document_id = id(999); }, f => { f.rows[0].warehouse_id = id(999); },
    f => { f.document.warehouse.id = id(999); }, f => { f.rows[1].id = f.rows[0].id; },
    f => { f.rows[1].layer_movement_id = f.rows[0].layer_movement_id; },
    f => { f.rows.pop(); }, f => { f.document.quantity = '102'; },
    f => { f.rows[0].quantity = '2'; }, f => { f.rows[2].value_minor = '9007199254740992'; },
    f => { f.rows[1].value_minor = '0'; }, f => { f.rows[0].layer_id = null; },
  ];
  for (const format of ['csv', 'xml'] as const) for (const corrupt of corruptions) {
    const f = fixture(); corrupt(f); refused(() => render(f, format), 409);
  }
});

test('full10000-row bounded manifest succeeds, but10001 and escaped8MiB envelope refuse413 without truncation', () => {
  const bounded = fixture(10000, false);
  for (const format of ['csv', 'xml'] as const) {
    const result = render(bounded, format, false); assert.equal(result.row_count, 10000);
    if (format === 'csv') assert.equal(csv(result.content).filter(r => r.record_type === 'row').length, 10000);
    else assert.equal(child(xml(result.content), 'rows').children.length, 10000);
    assert(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 8388608);
    refused(() => render(fixture(10001, false), format, false), 413);
  }
  const escaped = fixture(101, false);
  for (const r of escaped.rows) r.name = '\\'.repeat(45000);
  // Even when raw CSV fits, JSON doubles each backslash; refuse the whole envelope.
  refused(() => render(escaped, 'csv', false), 413);
});
