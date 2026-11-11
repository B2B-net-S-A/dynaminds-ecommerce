import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  BANK_COD_CSV_LIMITS,
  BANK_COD_CURRENCY_SCALE,
  BankCodCsvError,
  bankCodProfile,
  tokenizeBankCodCsv,
  decodeBankCodCsv,
  resolveBankCodColumns,
  parseBankCodMoney,
  parseBankCodDate,
  extractBankCodReference,
  bankCodEconomicKey,
  parseBankCodCsv,
  type BankCodProfile,
} from '../server/bank-cod-csv';
const tenant = '11111111-1111-4111-8111-111111111111',
  namespace = '22222222-2222-4222-8222-222222222222',
  channel = '33333333-3333-4333-8333-333333333333';
const profile = (extra: any = {}) =>
  bankCodProfile.parse({
    name: 'Bank QA',
    source_kind: 'bank_statement',
    source_namespace_id: namespace,
    transaction_id_scope: 'namespace',
    mode: 'bank_receipt',
    encoding: 'utf-8',
    delimiter: ';',
    header: true,
    skip_records: 0,
    decimal_separator: ',',
    grouping_separator: 'none',
    sign: 'credit_positive',
    date_format: 'YYYY-MM-DD',
    columns: {
      transaction_id: { index: 0 },
      booking_date: { index: 1 },
      amount: { index: 2 },
      currency: { index: 3 },
      reference: [{ index: 4 }],
    },
    match: { kind: 'order_number', extraction: 'whole_field' },
    ...extra,
  });
const data = (extra = 'TX-1;2026-10-05;100,00;PLN;WEB-001') =>
  'Transakcja;Data;Kwota;Waluta;Tytuł\r\n' + extra;
const parse = (text: string, p = profile()) =>
  parseBankCodCsv(Buffer.from(text, 'utf8'), p, { tenant_id: tenant });
const error = (code: string) => (e: unknown) => e instanceof BankCodCsvError && e.code === code;
const money = (raw: string, extra: any = {}) =>
  parseBankCodMoney(raw, 'PLN', {
    decimal_separator: ',',
    grouping_separator: 'none',
    sign: 'credit_positive',
    ...extra,
  });
const quote = (v: string) => '"' + v.replaceAll('"', '""') + '"';

test('RFC quotes, embedded delimiters, doubled quotes, CRLF/LF and EOF preserve raw cell data and physical ranges', () => {
  const records = tokenizeBankCodCsv('A;B\r\n"a;b";"line1\r\nline2\n""quote"""\nlast;', ';');
  assert.deepEqual(records, [
    { logical_record: 1, line_start: 1, line_end: 1, cells: ['A', 'B'] },
    { logical_record: 2, line_start: 2, line_end: 4, cells: ['a;b', 'line1\r\nline2\n"quote"'] },
    { logical_record: 3, line_start: 5, line_end: 5, cells: ['last', ''] },
  ]);
  assert.deepEqual(tokenizeBankCodCsv('"";""', ';')[0].cells, ['', '']);
  assert.equal(tokenizeBankCodCsv('a;b\n', ';').length, 1);
  assert.equal(tokenizeBankCodCsv('a;b\n\n', ';').length, 2);
  for (const delimiter of [',', ';', '\t', '|'] as const)
    assert.deepEqual(
      tokenizeBankCodCsv('x' + delimiter + quote('a' + delimiter + 'b'), delimiter)[0].cells,
      ['x', 'a' + delimiter + 'b'],
    );
});
test('malformed quote states and inconsistent columns reject whole input rather than returning partial rows', () => {
  for (const raw of ['a;"unterminated', 'a;bad"quote', '"closed" ;b', '"closed"x;b'])
    assert.throws(
      () => tokenizeBankCodCsv(raw, ';'),
      (e: unknown) =>
        e instanceof BankCodCsvError && ['invalid_quote', 'unclosed_quote'].includes(e.code),
    );
  assert.throws(() => tokenizeBankCodCsv('a;b\rc;d', ';'), error('bare_cr'));
  const bad = data() + '\r\nTX-2;2026-10-05;1,00;PLN';
  assert.throws(
    () => parse(bad),
    (e: unknown) => error('column_count')(e) && (e as BankCodCsvError).logical_record === 3,
  );
});
test('strict UTF8, BOM only at start, UTF16/declared encoding mismatch and CP1250 Polish text', () => {
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(data())]);
  const result = parseBankCodCsv(bytes, profile(), { tenant_id: tenant });
  assert.equal(result.headers![0], 'Transakcja');
  assert.equal(result.file_hash, createHash('sha256').update(bytes).digest('hex'));
  assert.notEqual(result.file_hash, parse(data()).file_hash);
  assert.throws(
    () => decodeBankCodCsv(Uint8Array.of(0xc3, 0x28), 'utf-8'),
    error('invalid_encoding'),
  );
  assert.throws(
    () => decodeBankCodCsv(Uint8Array.of(0xff, 0xfe, 65, 0), 'utf-8'),
    error('unsupported_encoding'),
  );
  assert.throws(() => decodeBankCodCsv(bytes, 'windows-1250'), error('encoding_bom'));
  assert.throws(
    () => parse(data() + '\nTX-2;2026-10-05;1,00;PLN;\ufeffWEB-2'),
    error('unexpected_bom'),
  );
  const polish = Buffer.from([
    90, 97, 0xbf, 0xf3, 0xb3, 0xe6, 32, 103, 0xea, 0x9c, 108, 0xb9, 32, 106, 97, 0x9f, 0xf1,
  ]);
  assert.equal(decodeBankCodCsv(polish, 'windows-1250'), 'Zażółć gęślą jaźń');
  const cp = Buffer.concat([
    Buffer.from('ID;Date;Amount;Currency;Ref\nTX-1;2026-10-05;100,00;PLN;'),
    polish,
  ]);
  assert.equal(
    parseBankCodCsv(cp, profile({ encoding: 'windows-1250' }), { tenant_id: tenant }).rows[0]
      .normalized!.reference,
    'Zażółć gęślą jaźń',
  );
  for (const b of [0x81, 0x83, 0x88, 0x90, 0x98])
    assert.throws(
      () =>
        parseBankCodCsv(
          Buffer.concat([Buffer.from('a;'), Buffer.from([b])]),
          profile({ encoding: 'windows-1250' }),
          { tenant_id: tenant },
        ),
      error('control_character'),
    );
});
test('NUL and disallowed controls are structural failures, not silently stripped', () => {
  for (const v of ['\u0000', '\u0001', '\u007f', '\u0081'])
    assert.throws(
      () => parse(data() + v),
      (e: unknown) =>
        e instanceof BankCodCsvError && ['nul_byte', 'control_character'].includes(e.code),
    );
});

test('byte view boundaries define the original file evidence and caller input remains unchanged', () => {
  const file = Buffer.from(data(), 'utf8');
  const backing = Buffer.concat([Buffer.from('not CSV'), file, Buffer.from('other file')]);
  const before = Buffer.from(backing);
  const view = backing.subarray(7, 7 + file.byteLength);
  const result = parseBankCodCsv(view, profile(), { tenant_id: tenant });
  assert.equal(result.file_bytes, file.byteLength);
  assert.equal(result.file_hash, createHash('sha256').update(file).digest('hex'));
  assert.equal(result.rows[0].normalized?.transaction_id, 'TX-1');
  assert.deepEqual(backing, before);
});
test('skip counts logical records and headers keep exact positional/semantic mapping', () => {
  const p = profile({ skip_records: 2 }),
    csv = '"Account\nmetadata"\nReport date\nID;Date;Value;CCY;Order\nTX-1;2026-10-05;1,00;PLN;001';
  const r = parse(csv, p);
  assert.equal(r.skipped_records, 2);
  assert.equal(r.rows[0].logical_record, 4);
  assert.equal(r.rows[0].line_start, 5);
  assert.equal(r.rows[0].data_index, 1);
  assert.equal(r.rows[0].normalized!.match_identifiers[0], '001');
  assert.deepEqual(
    resolveBankCodColumns(r.headers!, {
      transaction_id: { header: 'ID' },
      booking_date: { header: 'Date' },
      amount: { header: 'Value' },
      currency: { header: 'CCY' },
      reference: [{ header: 'Order' }],
    }),
    p.columns,
  );
  assert.throws(
    () =>
      resolveBankCodColumns(['ID', 'ID', 'Date', 'Amount', 'Order'], {
        transaction_id: { header: 'ID' },
        booking_date: { header: 'Date' },
        amount: { header: 'Amount' },
        reference: [{ header: 'Order' }],
      }),
    error('ambiguous_header'),
  );
  assert.throws(
    () =>
      resolveBankCodColumns(r.headers!, {
        transaction_id: { header: 'id' },
        booking_date: { header: 'Date' },
        amount: { header: 'Value' },
        reference: [{ header: 'Order' }],
      }),
    error('missing_header'),
  );
  const explicit = resolveBankCodColumns(['ID', 'ID', 'Date', 'Amount', 'Order'], {
    transaction_id: { index: 0 },
    booking_date: { index: 2 },
    amount: { index: 3 },
    reference: [{ index: 4 }],
    currency: undefined,
  });
  assert.equal(explicit.transaction_id.index, 0);
});
test('headerless data and blank logical records are handled explicitly without guessing or truncation', () => {
  const r = parse('TX-1;2026-10-05;1,00;PLN;001', profile({ header: false }));
  assert.equal(r.headers, null);
  assert.equal(r.rows[0].logical_record, 1);
  assert.throws(() => parse(data() + '\n\n'), error('column_count'));
  assert.throws(() => parse('ID;Date;Amount;Currency;Ref'), error('empty_data'));
  assert.throws(() => parse('Meta', profile({ skip_records: 1 })), error('missing_header'));
});
test('5MiB, 5000 data rows, 100 columns, 10KiB field and 64KiB logical record are hard bounded', () => {
  assert.throws(
    () => decodeBankCodCsv(new Uint8Array(BANK_COD_CSV_LIMITS.bytes + 1), 'utf-8'),
    error('file_limit'),
  );
  const accepted = parse(
    data(Array.from({ length: 5000 }, (_, i) => `TX-${i};2026-10-05;1,00;PLN;WEB-${i}`).join('\n')),
  );
  assert.equal(accepted.rows.length, 5000);
  assert.throws(
    () =>
      parse(
        data(
          Array.from({ length: 5001 }, (_, i) => `TX-${i};2026-10-05;1,00;PLN;WEB-${i}`).join('\n'),
        ),
      ),
    error('row_limit'),
  );
  assert.equal(
    tokenizeBankCodCsv(Array.from({ length: 100 }, () => '').join(';'), ';')[0].cells.length,
    100,
  );
  assert.throws(
    () => tokenizeBankCodCsv(Array.from({ length: 101 }, () => '').join(';'), ';'),
    error('column_limit'),
  );
  assert.equal(tokenizeBankCodCsv('ą'.repeat(5120), ';')[0].cells[0].length, 5120);
  assert.throws(() => tokenizeBankCodCsv('ą'.repeat(5121), ';'), error('field_limit'));
  assert.equal(tokenizeBankCodCsv('😀'.repeat(2560), ';')[0].cells[0].length, 5120);
  assert.throws(() => tokenizeBankCodCsv('😀'.repeat(2561), ';'), error('field_limit'));
  assert.throws(
    () => tokenizeBankCodCsv(Array.from({ length: 7 }, () => 'x'.repeat(10000)).join(';'), ';'),
    error('record_limit'),
  );
});
test('profile rejects ambiguous money/currency/identity mappings, unsafe options and wrong economic source modes', () => {
  const p = profile();
  const bad = [
    { grouping_separator: ',' },
    { fixed_currency: 'PLN' },
    { columns: { ...p.columns, currency: undefined } },
    { transaction_id_scope: 'statement' },
    { mode: 'cod_remittance' },
    { mode: 'cod_collection', source_kind: 'bank_statement' },
    { columns: { ...p.columns, fee: { index: 5 } } },
    { match: { kind: 'external_order_id', extraction: 'whole_field' } },
    { match: { kind: 'order_number', extraction: 'delimited_token' } },
    { columns: { ...p.columns, order_reference: { index: 0 } } },
    { columns: { ...p.columns, amount: { index: 1 } } },
    { encoding: 'auto' },
    { delimiter: 'guess' },
    { eval: 'doSomething()' },
    { skip_records: 101 },
  ];
  for (const extra of bad)
    assert.equal(bankCodProfile.safeParse({ ...p, ...extra }).success, false);
  assert.throws(
    () => parse(data(), profile({ columns: { ...p.columns, amount: { index: 99 } } })),
    error('missing_column'),
  );
});
test('money strings digit-by-digit preserve exact minor units and explicit two-decimal currency scales', () => {
  assert.deepEqual(BANK_COD_CURRENCY_SCALE, { PLN: 2, EUR: 2, USD: 2, GBP: 2, CZK: 2 });
  for (const raw of ['100', '100,0', '100,00']) assert.equal(money(raw).minor, '10000');
  assert.equal(money('0,01').ledger_integer, 1);
  assert.equal(money('0001,20').minor, '120');
  assert.equal(money(' 100,00 ').normalized, '100.00');
  assert.equal(money('21474836,47').ledger_integer, 2147483647);
  assert.throws(() => money('21474836,48'), error('amount_range'));
  for (const code of Object.keys(BANK_COD_CURRENCY_SCALE))
    assert.equal(
      parseBankCodMoney('1.01', code as any, {
        decimal_separator: '.',
        grouping_separator: 'none',
        sign: 'credit_positive',
      }).minor,
      '101',
    );
});
test('grouping is strict and no extra decimals, exponents, currency symbols or numeric coercion are accepted', () => {
  assert.equal(money('1 234,56', { grouping_separator: ' ' }).minor, '123456');
  assert.equal(money('1\u00a0234,56', { grouping_separator: '\u00a0' }).minor, '123456');
  assert.equal(money('1.234,56', { grouping_separator: '.' }).minor, '123456');
  assert.equal(
    money('1,234.56', { decimal_separator: '.', grouping_separator: ',' }).minor,
    '123456',
  );
  for (const raw of ['12 34,56', '1234 567,89', '1 23 456,00', '1.23,00'])
    assert.throws(
      () => money(raw, { grouping_separator: raw.includes('.') ? '.' : ' ' }),
      error('invalid_grouping'),
    );
  for (const raw of ['1,234', '1,000', '0,000'])
    assert.throws(() => money(raw), error('extra_decimals'));
  for (const raw of [
    '',
    '1e3',
    'NaN',
    'Infinity',
    '1 PLN',
    '(1,00)',
    '--1',
    '+-1',
    '1,',
    '1.00',
    '1_000',
    '1,0,0',
    '=1+1',
  ])
    assert.throws(() => money(raw));
  assert.throws(() => money(1 as any));
  assert.throws(() =>
    parseBankCodMoney('1.00', 'JPY' as any, {
      decimal_separator: '.',
      grouping_separator: 'none',
      sign: 'credit_positive',
    }),
  );
});
test('sign policy is explicit, no abs or debit-to-receipt/refund inference', () => {
  assert.equal(money('-100').signed_minor, '-10000');
  assert.equal(money('-100').minor, null);
  assert.equal(money('-100', { sign: 'credit_negative' }).minor, '10000');
  assert.equal(money('+100', { sign: 'credit_negative' }).signed_minor, '-10000');
  assert.equal(parse(data('TX-1;2026-10-05;-100,00;PLN;001')).rows[0].status, 'invalid');
  assert.ok(
    parse(data('TX-1;2026-10-05;-100,00;PLN;001')).rows[0].issues.some(
      (i) => i.code === 'unsupported_debit',
    ),
  );
  assert.equal(
    parse(data('TX-1;2026-10-05;-100,00;PLN;001'), profile({ sign: 'credit_negative' })).rows[0]
      .normalized!.amount_minor,
    '10000',
  );
  const p = profile({
    columns: { ...profile().columns, direction: { index: 5 } },
    direction_values: { credit: ['CREDIT', 'IN'], debit: ['DEBIT', 'OUT'] },
  });
  const row = parse('ID;Date;Amount;CCY;Ref;Direction\nTX-1;2026-10-05;1,00;PLN;001;DEBIT', p)
    .rows[0];
  assert.equal(row.status, 'invalid');
  assert.ok(row.issues.some((i) => i.code === 'unsupported_debit'));
  assert.equal(
    parse('ID;Date;Amount;CCY;Ref;Direction\nTX-1;2026-10-05;1,00;PLN;001;credit', p).rows[0]
      .issues[0].code,
    'invalid_direction',
  );
  assert.equal(
    bankCodProfile.safeParse({ ...p, direction_values: { credit: ['X'], debit: ['X'] } }).success,
    false,
  );
});
test('dates are strict declared calendar dates without guessing Date.parse or timezone conversion', () => {
  assert.equal(parseBankCodDate('2000-02-29', 'YYYY-MM-DD'), '2000-02-29');
  assert.equal(parseBankCodDate('29.02.2024', 'DD.MM.YYYY'), '2024-02-29');
  assert.equal(parseBankCodDate('0001-01-01', 'YYYY-MM-DD'), '0001-01-01');
  for (const raw of [
    '1900-02-29',
    '2026-02-29',
    '2026-04-31',
    '2026-13-01',
    '2026-00-01',
    '2026-01-00',
    '0000-01-01',
    '2026-1-01',
    '01/02/2026',
    '2026-10-05T00:00:00Z',
    ' 2026-10-05',
  ])
    assert.throws(() => parseBankCodDate(raw, 'YYYY-MM-DD'), error('invalid_date'));
  assert.throws(() => parseBankCodDate('2026-10-05', 'DD.MM.YYYY'), error('invalid_date'));
  assert.equal(parse(data('TX-1;01/02/2026;1,00;PLN;001')).rows[0].status, 'invalid');
});
test('formula-looking/HTML/URL content remains exact passive data with no execution or external fetch', () => {
  const values = [
    '=globalThis.__csvExecuted=true',
    '+SUM(A1:A2)',
    '-HYPERLINK("https://example.test")',
    '@cmd',
    '<script>bad()</script>',
    'https://example.test/file',
  ];
  const p = profile({ columns: { ...profile().columns, order_reference: { index: 5 } } });
  const csv =
    'ID;Date;Amount;CCY;Ref;Order\n' +
    values.map((v, i) => `TX-${i};2026-10-05;1,00;PLN;${quote(v)};001`).join('\n');
  const r = parse(csv, p);
  assert.equal((globalThis as any).__csvExecuted, undefined);
  for (let i = 0; i < values.length; i++) {
    assert.equal(r.rows[i].cells[4], values[i]);
    assert.equal(r.rows[i].normalized!.reference, values[i]);
    assert.equal(r.rows[i].status, 'valid');
  }
});
test('literal token extraction preserves case/leading zero and reports missing/multiple identifiers', () => {
  const match = {
    kind: 'order_number' as const,
    extraction: 'delimited_token' as const,
    reference_prefix: 'ORDER:',
  };
  assert.deepEqual(extractBankCodReference(['Payment (ORDER:00001); ORDER:00001'], match), [
    '00001',
  ]);
  assert.deepEqual(extractBankCodReference(['XORDER:999 ORDER:00001 ORDER:00002'], match), [
    '00001',
    '00002',
  ]);
  assert.deepEqual(extractBankCodReference(['ORDERX:001'], match), []);
  const p = profile({ match });
  assert.equal(
    parse(data('TX-1;2026-10-05;1,00;PLN;ORDER:001 ORDER:002'), p).rows[0].status,
    'review',
  );
  assert.equal(
    parse(data('TX-1;2026-10-05;1,00;PLN;Payment'), p).rows[0].issues[0].code,
    'missing_reference',
  );
  assert.equal(
    parse(data('TX-1;2026-10-05;1,00;PLN;ORDER:AbC001'), p).rows[0].normalized!
      .match_identifiers[0],
    'AbC001',
  );
});
test('missing economic ID and statement-scoped ID remain review without guessed transaction identity', () => {
  const missing = parse(data(';2026-10-05;1,00;PLN;001')).rows[0];
  assert.equal(missing.status, 'review');
  assert.equal(missing.economic_key, null);
  assert.equal(missing.normalized!.transaction_id, null);
  const p = profile({
    transaction_id_scope: 'statement',
    columns: { ...profile().columns, statement_id: { index: 5 } },
  });
  const row = parse('ID;Date;Amount;CCY;Ref;Statement\nTX-1;2026-10-05;1,00;PLN;001;', p).rows[0];
  assert.equal(row.status, 'review');
  assert.equal(row.economic_key, null);
  assert.ok(row.issues.some((i) => i.code === 'missing_statement_id'));
  assert.notEqual(
    bankCodEconomicKey(tenant, p, 'TX-1', 'S1'),
    bankCodEconomicKey(tenant, p, 'TX-1', 'S2'),
  );
  assert.notEqual(
    bankCodEconomicKey(tenant, profile(), 'TX-1'),
    bankCodEconomicKey(tenant, profile(), 'tx-1'),
  );
  assert.notEqual(
    bankCodEconomicKey(tenant, profile(), 'TX-1'),
    bankCodEconomicKey(tenant, profile(), 'TX-01'),
  );
});
const cod = (mode: 'cod_collection' | 'cod_remittance', source = 'carrier_report') =>
  profile({
    source_kind: source,
    mode,
    columns: {
      ...profile().columns,
      tracking_number: { index: 5 },
      ...(mode === 'cod_remittance' ? { fee: { index: 6 } } : {}),
    },
    match: { kind: 'tracking_number', carrier: 'DPD', extraction: 'whole_field' },
  });
test('COD collection vs remittance have separate stages and ledger kind; bank remittance shares merchant-credit identity', () => {
  const collection = cod('cod_collection'),
    remit = cod('cod_remittance'),
    bankRemit = cod('cod_remittance', 'bank_statement');
  const receipt = profile();
  assert.notEqual(
    bankCodEconomicKey(tenant, collection, 'TX-1'),
    bankCodEconomicKey(tenant, remit, 'TX-1'),
  );
  assert.equal(
    bankCodEconomicKey(tenant, receipt, 'TX-1'),
    bankCodEconomicKey(tenant, remit, 'TX-1'),
  );
  assert.equal(
    bankCodEconomicKey(tenant, remit, 'TX-1'),
    bankCodEconomicKey(tenant, bankRemit, 'TX-1'),
  );
  const c = parse(
    'ID;Date;Amount;CCY;Ref;Tracking\nTX-1;2026-10-05;100,00;PLN;COD;00000001',
    collection,
  ).rows[0];
  assert.equal(c.normalized!.event_stage, 'customer_to_carrier');
  assert.equal(c.normalized!.ledger_kind, 'courier_collection');
  assert.equal(c.normalized!.tracking_number, '00000001');
  const b = parse(
    'ID;Date;Amount;CCY;Ref;Tracking;Fee\nTX-1;2026-10-05;98,00;PLN;COD;00000001;2,00',
    bankRemit,
  ).rows[0];
  assert.equal(b.normalized!.amount_minor, '9800');
  assert.equal(b.normalized!.fee_minor, '200');
  assert.equal(b.normalized!.gross_minor, '10000');
  assert.equal(b.normalized!.method, 'bank_csv_cod');
  assert.equal(b.normalized!.ledger_kind, 'courier_remittance');
});
test('fees are explicit, no guessed default or net/fee arithmetic overflow; zero-net fee-only remittance is only parsed', () => {
  const remit = cod('cod_remittance');
  assert.equal(
    parse('ID;Date;Amount;CCY;Ref;Tracking;Fee\nTX-1;2026-10-05;98,00;PLN;COD;001;', remit).rows[0]
      .status,
    'invalid',
  );
  assert.equal(
    parse('ID;Date;Amount;CCY;Ref;Tracking;Fee\nTX-1;2026-10-05;98,00;PLN;COD;001;-2,00', remit)
      .rows[0].status,
    'invalid',
  );
  const feeOnly = parse(
    'ID;Date;Amount;CCY;Ref;Tracking;Fee\nTX-1;2026-10-05;0;PLN;COD;001;2,00',
    remit,
  ).rows[0];
  assert.equal(feeOnly.status, 'valid');
  assert.equal(feeOnly.normalized!.gross_minor, '200');
  assert.equal(parse(data('TX-1;2026-10-05;0;PLN;001')).rows[0].issues[0].code, 'zero_amount');
  const wide = parse(
    'ID;Date;Amount;CCY;Ref;Tracking;Fee\nTX-1;2026-10-05;21474836,47;PLN;COD;001;21474836,47',
    remit,
  ).rows[0];
  assert.equal(wide.normalized!.gross_minor, '4294967294');
  const fixed = cod('cod_remittance');
  delete (fixed.columns as any).fee;
  (fixed as any).fixed_fee_minor = '0';
  assert.equal(
    parse('ID;Date;Amount;CCY;Ref;Tracking\nTX-1;2026-10-05;1,00;PLN;COD;001', fixed).rows[0]
      .normalized!.fee_minor,
    '0',
  );
});
test('fixed currency is explicit, mixed currency sums stay separated and malformed currency is per-row invalid', () => {
  const p = profile();
  delete (p.columns as any).currency;
  (p as any).fixed_currency = 'PLN';
  assert.equal(parse(data(), p).rows[0].normalized!.currency, 'PLN');
  const r = parse(
    data(
      'TX-1;2026-10-05;1,01;PLN;001\nTX-2;2026-10-05;2,02;EUR;002\nTX-3;2026-10-05;1,00;JPY;003',
    ),
  );
  assert.equal(r.summary.counts.valid, 2);
  assert.equal(r.summary.counts.invalid, 1);
  assert.equal(r.summary.totals.PLN!.valid.amount_minor, '101');
  assert.equal(r.summary.totals.EUR!.valid.amount_minor, '202');
  assert.equal((r.summary as any).amount_total, undefined);
});
test('duplicates share economic identity but have distinct deterministic row IDs; conflicting payload blocks original and duplicate', () => {
  const raw = data() + '\nTX-1;2026-10-05;100;PLN;WEB-001';
  const r = parse(raw);
  assert.deepEqual(
    r.rows.map((x) => x.status),
    ['valid', 'duplicate'],
  );
  assert.equal(r.rows[1].duplicate_of, r.rows[0].row_id);
  assert.equal(r.rows[0].economic_key, r.rows[1].economic_key);
  assert.notEqual(r.rows[0].row_id, r.rows[1].row_id);
  assert.equal(parse(raw).rows[0].row_id, r.rows[0].row_id);
  assert.equal(r.summary.totals.PLN!.valid.amount_minor, '10000');
  assert.equal(r.summary.totals.PLN!.duplicate.amount_minor, '10000');
  for (const changed of [
    'TX-1;2026-10-05;99;PLN;WEB-001',
    'TX-1;2026-10-06;100;PLN;WEB-001',
    'TX-1;2026-10-05;100;EUR;WEB-001',
    'TX-1;2026-10-05;100;PLN;WEB-002',
    'TX-1;2026-10-05;bad;PLN;WEB-001',
  ])
    assert.deepEqual(
      parse(data() + '\n' + changed).rows.map((x) => x.status),
      ['conflict', 'conflict'],
    );
});
test('identity ignores filename/profile name/file row order, scopes tenant and namespace, canonicalizes UUID case', () => {
  const p = profile(),
    changed = profile({ name: 'Other display name', description: 'Another format' });
  assert.equal(bankCodEconomicKey(tenant, p, 'TX-1'), bankCodEconomicKey(tenant, changed, 'TX-1'));
  const r = parse(data() + '\nTX-2;2026-10-05;10;PLN;002'),
    swapped = parse(data('TX-2;2026-10-05;10;PLN;002\nTX-1;2026-10-05;100,00;PLN;WEB-001'));
  assert.notEqual(r.file_hash, swapped.file_hash);
  assert.equal(r.rows[0].economic_key, swapped.rows[1].economic_key);
  assert.notEqual(r.rows[0].row_id, swapped.rows[1].row_id);
  assert.notEqual(bankCodEconomicKey(tenant, p, 'TX-1'), bankCodEconomicKey(channel, p, 'TX-1'));
  assert.notEqual(
    bankCodEconomicKey(tenant, p, 'TX-1'),
    bankCodEconomicKey(tenant, profile({ source_namespace_id: channel }), 'TX-1'),
  );
  const alpha = 'ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF';
  assert.equal(
    bankCodEconomicKey(alpha, profile({ source_namespace_id: alpha }), 'TX-1'),
    bankCodEconomicKey(
      alpha.toLowerCase(),
      profile({ source_namespace_id: alpha.toLowerCase() }),
      'TX-1',
    ),
  );
});
test('semantic limits are row issues, raw evidence is retained, source parse never claims ready/applied/actual bank verification', () => {
  const r = parse(data('TX-1;2026-10-05;1,00;PLN;' + quote('x'.repeat(4001))));
  assert.equal(r.rows[0].status, 'invalid');
  assert.ok(r.rows[0].issues.some((i) => i.code === 'reference_limit'));
  assert.equal(r.rows[0].cells[4].length, 4001);
  const missing = parse(
    'ID;Date;Amount;CCY;Ref;Tracking\nTX-1;2026-10-05;1,00;PLN;COD;',
    cod('cod_collection'),
  ).rows[0];
  assert.equal(missing.status, 'review');
  assert.ok(missing.issues.some((i) => i.code === 'missing_tracking_number'));
  assert.equal((parse(data()).rows[0] as any).ready, undefined);
  assert.equal((parse(data()) as any).ledger_written, undefined);
  assert.equal(parse(data()).rows[0].status, 'valid');
});
