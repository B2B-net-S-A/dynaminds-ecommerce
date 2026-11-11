import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { orderFieldBatchCsvConfigSchema } from '../server/order-field-batches-schema';
import {
  parseOrderFieldBatchCsv,
  orderFieldBatchCsvBytes,
  orderFieldCsvCellSchema,
  orderFieldCsvQuote,
  orderFieldSheetCell,
} from '../server/order-field-batches-csv';
const config = () =>
  orderFieldBatchCsvConfigSchema.parse({
    encoding: 'utf-8',
    delimiter: ',',
    header: true,
    identity: { kind: 'order_id', column: 0 },
    order_version_column: 1,
    fields: [{ column: 2, field_id: randomUUID(), definition_version: 1 }],
  });
test('CSV BOM, quotes, CRLF/multiline and strict JSON preserve literal values', () => {
  const value = 'Zażółć, "quote"\nnext',
    row = [randomUUID(), '1', JSON.stringify({ operation: 'set', value })],
    bytes = Buffer.from(
      '\ufeffid,version,field\r\n' + row.map(orderFieldCsvQuote).join(',') + '\r\n',
    );
  const parsed = parseOrderFieldBatchCsv(bytes, config());
  assert.equal(parsed.rows.length, 1);
  assert.equal(orderFieldCsvCellSchema.parse(JSON.parse(parsed.rows[0][2])).operation, 'set');
  assert.equal(JSON.parse(parsed.rows[0][2]).value, value);
});
test('full 16 KiB Unicode text and legal escaped supplementary JSON fit the cell bound', () => {
  const emoji = '😀'.repeat(4000),
    escaped = '{"operation":"set","value":"' + '\\ud83d\\ude00'.repeat(4000) + '"}',
    r = parseOrderFieldBatchCsv(
      Buffer.from('id,v,f\n' + [randomUUID(), '1', escaped].map(orderFieldCsvQuote).join(',')),
      config(),
    );
  assert.equal(JSON.parse(r.rows[0][2]).value, emoji);
  assert.equal(Buffer.byteLength(emoji), 16000);
});
test('Windows1250 is explicit; malformed UTF8/undefinedCP1250/NUL/ragged/quotes are rejected', () => {
  const cp = { ...config(), encoding: 'windows-1250' as const },
    bytes = Buffer.concat([Buffer.from('id,v,f\n"'), Buffer.from([0xb9]), Buffer.from('",1,"{}"')]);
  assert.equal(parseOrderFieldBatchCsv(bytes, cp).rows[0][0], 'ą');
  for (const bad of [
    Buffer.from([0xc3, 0x28]),
    Buffer.from('a,b,c\n1,2'),
    Buffer.from('a,b,c\n"x"bad,1,{}'),
    Buffer.from('a,b,c\n"unclosed,1,{}'),
    Buffer.from('a,b,c\n\0,1,{}'),
  ])
    assert.throws(() => parseOrderFieldBatchCsv(bad, config()));
  assert.throws(() => parseOrderFieldBatchCsv(Buffer.from([0x81]), cp));
});
test('5000 rows accepted and 5001, oversized cells/bytes, duplicate mapping columns rejected', () => {
  const row = 'a,1,{}\n';
  assert.equal(
    parseOrderFieldBatchCsv(Buffer.from('id,v,f\n' + row.repeat(5000)), config()).rows.length,
    5000,
  );
  assert.throws(() =>
    parseOrderFieldBatchCsv(Buffer.from('id,v,f\n' + row.repeat(5001)), config()),
  );
  assert.throws(() =>
    parseOrderFieldBatchCsv(Buffer.from('id,v,f\n' + 'x'.repeat(65537) + ',1,{}'), config()),
  );
  assert.throws(() => orderFieldBatchCsvBytes(Buffer.alloc(5242881).toString('base64')));
  assert.throws(() =>
    orderFieldBatchCsvConfigSchema.parse({ ...config(), order_version_column: 0 }),
  );
});
test('set/clear do not overload empty/null; sheet prefix escaping never changes exact raw', () => {
  assert.deepEqual(orderFieldCsvCellSchema.parse({ operation: 'set', value: '' }), {
    operation: 'set',
    value: '',
  });
  assert.deepEqual(orderFieldCsvCellSchema.parse({ operation: 'set', value: [] }), {
    operation: 'set',
    value: [],
  });
  assert.throws(() => orderFieldCsvCellSchema.parse({ operation: 'clear', value: null }));
  for (const text of ['=1', ' +1', '\t-1', '\r@x'])
    assert.equal(orderFieldSheetCell(text), "'" + text);
  assert.equal(orderFieldSheetCell('ordinary'), 'ordinary');
});
