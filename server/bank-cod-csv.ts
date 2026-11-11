import { createHash } from 'node:crypto';
import { z } from 'zod';

export const BANK_COD_CSV_VERSION = '1';
export const BANK_COD_CSV_LIMITS = Object.freeze({
  bytes: 5 * 1024 * 1024,
  data_records: 5000,
  columns: 100,
  field_bytes: 10 * 1024,
  record_bytes: 64 * 1024,
});
// Explicit first-stage currency contract, not a default for arbitrary ISO currencies.
export const BANK_COD_CURRENCY_SCALE = Object.freeze({ PLN: 2, EUR: 2, USD: 2, GBP: 2, CZK: 2 });
const currency = z.enum(['PLN', 'EUR', 'USD', 'GBP', 'CZK']);
type Currency = z.infer<typeof currency>;
const text = (max: number, empty = false) =>
  z
    .string()
    .min(empty ? 0 : 1)
    .max(max)
    .refine((v) => !/[\x00-\x1f\x7f-\x9f\ufeff]/.test(v) && (empty || !!v.trim()));
const uuid = z.uuid().transform((v) => v.toLowerCase());
const column = z.strictObject({ index: z.number().int().min(0).max(99) });
const columns = z.strictObject({
  transaction_id: column,
  statement_id: column.optional(),
  booking_date: column,
  amount: column,
  currency: column.optional(),
  reference: z.array(column).min(1).max(4),
  direction: column.optional(),
  order_reference: column.optional(),
  tracking_number: column.optional(),
  fee: column.optional(),
});
export const bankCodProfile = z
  .strictObject({
    name: text(120),
    description: text(2000, true).default(''),
    source_kind: z.enum(['bank_statement', 'carrier_report']),
    source_namespace_id: uuid,
    transaction_id_scope: z.enum(['namespace', 'statement']),
    mode: z.enum(['bank_receipt', 'cod_collection', 'cod_remittance']),
    encoding: z.enum(['utf-8', 'windows-1250']),
    delimiter: z.enum([',', ';', '\t', '|']),
    header: z.boolean(),
    skip_records: z.number().int().min(0).max(100),
    decimal_separator: z.enum(['.', ',']),
    grouping_separator: z.enum(['none', ' ', '\u00a0', '.', ',']),
    sign: z.enum(['credit_positive', 'credit_negative']),
    date_format: z.enum(['YYYY-MM-DD', 'DD.MM.YYYY']),
    columns,
    fixed_currency: currency.optional(),
    fixed_fee_minor: z.literal('0').optional(),
    direction_values: z
      .strictObject({
        credit: z.array(text(80)).min(1).max(10),
        debit: z.array(text(80)).min(1).max(10),
      })
      .optional(),
    match: z.strictObject({
      kind: z.enum(['order_number', 'external_order_id', 'tracking_number']),
      channel_id: uuid.optional(),
      carrier: text(80).optional(),
      extraction: z.enum(['whole_field', 'delimited_token']),
      reference_prefix: text(80).optional(),
    }),
  })
  .superRefine((v, c) => {
    const bad = (message: string) => c.addIssue({ code: 'custom', message });
    if (v.grouping_separator === v.decimal_separator)
      bad('Separator dziesiętny i grupowania są identyczne');
    if (!!v.columns.currency === !!v.fixed_currency) bad('Wymagane dokładnie jedno źródło waluty');
    if (v.transaction_id_scope === 'statement' && !v.columns.statement_id)
      bad('Zakres statement wymaga kolumny statement_id');
    if (v.mode === 'bank_receipt' && v.source_kind !== 'bank_statement')
      bad('Wpłata bankowa wymaga bank_statement');
    if (v.mode === 'cod_collection' && v.source_kind !== 'carrier_report')
      bad('Pobranie od klienta wymaga carrier_report');
    if (v.mode !== 'bank_receipt' && (!v.columns.tracking_number || !v.match.carrier))
      bad('COD wymaga numeru przesyłki i przewoźnika');
    if (v.mode === 'cod_remittance') {
      if (!!v.columns.fee === !!v.fixed_fee_minor)
        bad('Remittance wymaga dokładnie jednego źródła fee');
    } else if (v.columns.fee || v.fixed_fee_minor) bad('Fee dopuszczone wyłącznie w remittance');
    if (!!v.columns.direction !== !!v.direction_values)
      bad('Kolumna kierunku wymaga jawnych wartości credit/debit');
    if (v.direction_values) {
      const all = [...v.direction_values.credit, ...v.direction_values.debit];
      if (new Set(all).size !== all.length) bad('Wartości kierunku muszą być unikalne i rozłączne');
    }
    if (v.match.kind === 'external_order_id' && !v.match.channel_id)
      bad('external_order_id wymaga kanału');
    if (v.match.kind === 'tracking_number' && (!v.columns.tracking_number || !v.match.carrier))
      bad('Dopasowanie tracking wymaga kolumny i przewoźnika');
    if (v.match.extraction === 'delimited_token' && !v.match.reference_prefix)
      bad('Token wymaga jawnego literalnego prefixu');
    if (v.match.extraction === 'whole_field' && v.match.reference_prefix)
      bad('Prefix dotyczy wyłącznie tokenu');
    if (v.match.kind === 'tracking_number' && v.match.extraction !== 'whole_field')
      bad('Numer przesyłki wymaga whole_field');
    const core = [
      v.columns.transaction_id,
      v.columns.statement_id,
      v.columns.booking_date,
      v.columns.amount,
      v.columns.currency,
      v.columns.direction,
      v.columns.fee,
    ].filter((x) => x !== undefined);
    if (new Set(core.map((x) => x.index)).size !== core.length)
      bad('Ekonomiczne kolumny nie mogą oznaczać tego samego pola');
    if (
      v.columns.order_reference?.index === v.columns.transaction_id.index ||
      v.columns.tracking_number?.index === v.columns.transaction_id.index
    )
      bad('Transaction ID nie może być kolumną identyfikatora zamówienia/przesyłki');
    if (new Set(v.columns.reference.map((x) => x.index)).size !== v.columns.reference.length)
      bad('Powtórzona kolumna tytułu');
  });
export type BankCodProfile = z.infer<typeof bankCodProfile>;
export class BankCodCsvError extends Error {
  constructor(
    public code: string,
    message: string,
    public logical_record?: number,
    public line_start?: number,
    public line_end?: number,
  ) {
    super(message);
    this.name = 'BankCodCsvError';
  }
}
const fail = (code: string, message: string): never => {
  throw new BankCodCsvError(code, message);
};
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
function canonical(v: any): any {
  return Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, x]) => [k, canonical(x)]),
        )
      : v;
}
export type BankCodCsvRecord = {
  logical_record: number;
  line_start: number;
  line_end: number;
  cells: string[];
};

export function tokenizeBankCodCsv(
  text: string,
  delimiter: BankCodProfile['delimiter'],
  maxRecords = 5101,
): BankCodCsvRecord[] {
  if (typeof text !== 'string' || !text.length) fail('empty_csv', 'Pusty plik CSV');
  if (![',', ';', '\t', '|'].includes(delimiter))
    fail('invalid_delimiter', 'Niedopuszczony separator');
  if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 5101)
    fail('invalid_limit', 'Niedopuszczony limit rekordów');
  if (Buffer.byteLength(text, 'utf8') > BANK_COD_CSV_LIMITS.bytes * 3)
    fail('decoded_limit', 'Za duży tekst CSV');
  const records: BankCodCsvRecord[] = [];
  let cells: string[] = [],
    field = '',
    quoted = false,
    closed = false,
    started = false;
  let line = 1,
    startLine = 1,
    fieldBytes = 0,
    recordBytes = 0;
  const error = (code: string, message: string): never => {
    throw new BankCodCsvError(code, message, records.length + 1, startLine, line);
  };
  const append = (ch: string) => {
    field += ch;
    fieldBytes += Buffer.byteLength(ch, 'utf8');
    if (fieldBytes > BANK_COD_CSV_LIMITS.field_bytes)
      error('field_limit', 'Pole CSV przekracza 10 KiB');
  };
  const count = (ch: string) => {
    recordBytes += Buffer.byteLength(ch, 'utf8');
    if (recordBytes > BANK_COD_CSV_LIMITS.record_bytes)
      error('record_limit', 'Rekord CSV przekracza 64 KiB');
  };
  const finishField = () => {
    cells.push(field);
    if (cells.length > BANK_COD_CSV_LIMITS.columns)
      error('column_limit', 'CSV przekracza 100 kolumn');
    field = '';
    fieldBytes = 0;
    closed = false;
  };
  const finishRecord = () => {
    finishField();
    if (records.length >= maxRecords) error('row_limit', 'CSV przekracza limit rekordów');
    records.push({
      logical_record: records.length + 1,
      line_start: startLine,
      line_end: line,
      cells,
    });
    cells = [];
    field = '';
    recordBytes = 0;
    started = false;
  };
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i)!,
      ch = String.fromCodePoint(cp);
    i += ch.length;
    if (cp === 0) error('nul_byte', 'CSV zawiera NUL');
    if (cp === 0xfeff) error('unexpected_bom', 'BOM dozwolony wyłącznie na początku UTF-8');
    if ((cp < 32 && ![9, 10, 13].includes(cp)) || (cp >= 0x7f && cp <= 0x9f))
      error('control_character', 'CSV zawiera niedopuszczony znak sterujący');
    if (quoted) {
      count(ch);
      started = true;
      if (ch === '"') {
        if (text[i] === '"') {
          count('"');
          append('"');
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else if (ch === '\r' && text[i] === '\n') {
        count('\n');
        append('\r\n');
        i++;
        line++;
      } else {
        append(ch);
        if (ch === '\n' || ch === '\r') line++;
      }
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r') {
        if (text[i] !== '\n') error('bare_cr', 'Poza cytatem wymagane CRLF lub LF');
        i++;
      }
      finishRecord();
      line++;
      startLine = line;
      continue;
    }
    count(ch);
    started = true;
    if (closed && ch !== delimiter) error('invalid_quote', 'Dane po zamknięciu cytowanego pola');
    if (ch === delimiter) {
      finishField();
      continue;
    }
    if (ch === '"') {
      if (field.length || closed) error('invalid_quote', 'Cudzysłów w niecytowanym polu');
      quoted = true;
      continue;
    }
    append(ch);
  }
  if (quoted) error('unclosed_quote', 'Nie zamknięto cytowanego pola');
  if (started || cells.length || field.length || closed) finishRecord();
  if (!records.length) fail('empty_csv', 'Pusty plik CSV');
  return records;
}
export function decodeBankCodCsv(bytes: Uint8Array, encoding: BankCodProfile['encoding']) {
  if (!(bytes instanceof Uint8Array)) fail('invalid_bytes', 'CSV wymaga surowych bajtów');
  if (!bytes.byteLength) fail('empty_csv', 'Pusty plik CSV');
  if (bytes.byteLength > BANK_COD_CSV_LIMITS.bytes) fail('file_limit', 'CSV przekracza 5 MiB');
  if (!['utf-8', 'windows-1250'].includes(encoding))
    fail('unsupported_encoding', 'Nieobsługiwane kodowanie');
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))
    fail('unsupported_encoding', 'UTF-16 nie jest obsługiwane');
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  if (bom && encoding !== 'utf-8')
    fail('encoding_bom', 'BOM UTF-8 nie pasuje do zadeklarowanego kodowania');
  let decoded: string;
  try {
    decoded = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    fail('invalid_encoding', 'Nie można dokładnie zdekodować CSV');
  }
  return bom ? decoded!.slice(1) : decoded!;
}
const headerColumn = z.union([column, z.strictObject({ header: text(200) })]);
const headerMapping = z.strictObject({
  transaction_id: headerColumn,
  statement_id: headerColumn.optional(),
  booking_date: headerColumn,
  amount: headerColumn,
  currency: headerColumn.optional(),
  reference: z.array(headerColumn).min(1).max(4),
  direction: headerColumn.optional(),
  order_reference: headerColumn.optional(),
  tracking_number: headerColumn.optional(),
  fee: headerColumn.optional(),
});
export function resolveBankCodColumns(
  headers: readonly string[],
  mapping: z.input<typeof headerMapping>,
) {
  z.array(z.string().max(10240)).min(1).max(100).parse(headers);
  const b = headerMapping.parse(mapping);
  const resolve = (v: z.infer<typeof headerColumn>) => {
    if ('index' in v) {
      if (v.index >= headers.length) fail('missing_column', 'Indeks nie istnieje w nagłówku');
      return v;
    }
    const indices = headers.flatMap((h, i) => (h === v.header ? [i] : []));
    if (!indices.length) fail('missing_header', 'Brak wskazanego nagłówka');
    if (indices.length !== 1)
      fail('ambiguous_header', 'Nieunikalny nagłówek wymaga jawnego indeksu');
    return { index: indices[0] };
  };
  return columns.parse(
    Object.fromEntries(
      Object.entries(b)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, Array.isArray(v) ? v.map(resolve) : resolve(v!)]),
    ),
  );
}
export type BankCodMoney = {
  raw: string;
  normalized: string;
  signed_minor: string;
  minor: string | null;
  ledger_integer: number | null;
};
export function parseBankCodMoney(
  raw: string,
  code: Currency,
  format: Pick<BankCodProfile, 'decimal_separator' | 'grouping_separator' | 'sign'>,
): BankCodMoney {
  currency.parse(code);
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 10240)
    fail('invalid_amount', 'Nieprawidłowa kwota');
  const f = z
    .strictObject({
      decimal_separator: z.enum(['.', ',']),
      grouping_separator: z.enum(['none', ' ', '\u00a0', '.', ',']),
      sign: z.enum(['credit_positive', 'credit_negative']),
    })
    .parse({
      decimal_separator: format.decimal_separator,
      grouping_separator: format.grouping_separator,
      sign: format.sign,
    });
  if (f.decimal_separator === f.grouping_separator)
    fail('invalid_money_format', 'Sprzeczne separatory');
  let s = raw.replace(/^ +| +$/g, '');
  if (!s) fail('missing_amount', 'Brak kwoty');
  let negative = false;
  if (s[0] === '-' || s[0] === '+') {
    negative = s[0] === '-';
    s = s.slice(1);
  }
  const parts = s.split(f.decimal_separator);
  if (parts.length > 2 || !parts[0] || (parts.length === 2 && !parts[1]))
    fail('invalid_amount', 'Nieprawidłowy zapis kwoty');
  let whole = parts[0];
  const fraction = parts[1] ?? '',
    scale = BANK_COD_CURRENCY_SCALE[code];
  if (f.grouping_separator !== 'none' && whole.includes(f.grouping_separator)) {
    const groups = whole.split(f.grouping_separator);
    if (!/^[0-9]{1,3}$/.test(groups[0]) || !groups.slice(1).every((g) => /^[0-9]{3}$/.test(g)))
      fail('invalid_grouping', 'Nieprawidłowe grupy cyfr');
    whole = groups.join('');
  }
  if (!/^[0-9]+$/.test(whole) || !/^[0-9]*$/.test(fraction))
    fail('invalid_amount', 'Kwota musi zawierać wyłącznie cyfry i zadeklarowane separatory');
  if (fraction.length > scale) fail('extra_decimals', 'Za dużo miejsc dziesiętnych');
  if (whole.length > 32) fail('amount_range', 'Kwota przekracza zakres');
  let n = 0n;
  for (const d of whole + fraction.padEnd(scale, '0')) n = n * 10n + BigInt(d);
  if (n > 2147483647n) fail('amount_range', 'Kwota przekracza zakres ledger int32');
  const signed = (negative ? -n : n) * (f.sign === 'credit_negative' ? -1n : 1n);
  const factor = 10n ** BigInt(scale);
  const normalized =
    (signed < 0n ? '-' : '') +
    (n / factor).toString() +
    '.' +
    (n % factor).toString().padStart(scale, '0');
  return {
    raw,
    normalized,
    signed_minor: signed.toString(),
    minor: signed >= 0n ? signed.toString() : null,
    ledger_integer: signed >= 0n ? Number(signed) : null,
  };
}
export function parseBankCodDate(raw: string, format: BankCodProfile['date_format']) {
  if (typeof raw !== 'string') fail('invalid_date', 'Nieprawidłowa data');
  let year: string, month: string, day: string;
  if (format === 'YYYY-MM-DD') {
    const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(raw);
    if (!m) fail('invalid_date', 'Data wymaga YYYY-MM-DD');
    [, year, month, day] = m!;
  } else if (format === 'DD.MM.YYYY') {
    const m = /^([0-9]{2})\.([0-9]{2})\.([0-9]{4})$/.exec(raw);
    if (!m) fail('invalid_date', 'Data wymaga DD.MM.YYYY');
    [, day, month, year] = m!;
  } else fail('invalid_date_format', 'Nieobsługiwany format daty');
  const y = Number(year!),
    mo = Number(month!),
    d = Number(day!),
    leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0),
    days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (y < 1 || mo < 1 || mo > 12 || d < 1 || d > days[mo - 1])
    fail('invalid_date', 'Data nie istnieje w kalendarzu');
  return `${year!}-${month!}-${day!}`;
}
export function bankCodStage(mode: BankCodProfile['mode']) {
  return mode === 'cod_collection' ? 'customer_to_carrier' : 'credit_to_merchant';
}
export function bankCodEconomicKey(
  tenantId: string,
  profile: BankCodProfile,
  transactionId: string,
  statementId?: string | null,
) {
  const tenant = uuid.parse(tenantId),
    p = bankCodProfile.parse(profile);
  validateIdentity(transactionId, 'transaction_id');
  if (p.transaction_id_scope === 'statement') validateIdentity(statementId ?? '', 'statement_id');
  return hash([
    tenant,
    p.source_namespace_id,
    p.transaction_id_scope === 'statement' ? statementId : null,
    transactionId,
    bankCodStage(p.mode),
  ]);
}
function validateIdentity(value: string, field: string) {
  if (!value) fail('missing_' + field, 'Brak identyfikatora');
  if (!text(200).safeParse(value).success || value !== value.trim())
    fail('invalid_' + field, 'Nieprawidłowy identyfikator');
  return value;
}
export function extractBankCodReference(values: readonly string[], match: BankCodProfile['match']) {
  const identifiers: string[] = [];
  if (match.extraction === 'whole_field') {
    for (const raw of values) {
      if (!raw) continue;
      const v = raw.replace(/^ +| +$/g, '');
      if (!text(200).safeParse(v).success)
        fail('invalid_reference', 'Identyfikator zamówienia/przesyłki jest nieprawidłowy');
      identifiers.push(v);
    }
  } else {
    const prefix =
      match.reference_prefix || fail('missing_reference_prefix', 'Brak literalnego prefixu');
    // Fixed boundary grammar: whitespace, comma, semicolon, pipe, brackets or parentheses.
    for (const raw of values)
      for (const token of raw.split(/[\s,;|()[\]{}]+/u)) {
        if (!token.startsWith(prefix)) continue;
        const id = token.slice(prefix.length);
        validateIdentity(id, 'reference');
        identifiers.push(id);
      }
  }
  return [...new Set(identifiers)];
}
function rowId(tenant: string, fileHash: string, record: number) {
  const h = hash([tenant, fileHash, record]);
  const v =
    h.slice(0, 12) +
    '8' +
    h.slice(13, 16) +
    (8 + (parseInt(h[16], 16) & 3)).toString(16) +
    h.slice(17, 32);
  return `${v.slice(0, 8)}-${v.slice(8, 12)}-${v.slice(12, 16)}-${v.slice(16, 20)}-${v.slice(20)}`;
}
type Issue = { code: string; field: string; message: string };
type Source = {
  transaction_id: string | null;
  statement_id: string | null;
  booking_date: string;
  currency: Currency;
  amount_minor: string;
  fee_minor: string;
  gross_minor: string;
  ledger_amount: number;
  ledger_fee: number;
  reference: string;
  match_identifiers: string[];
  tracking_number: string | null;
  event_stage: ReturnType<typeof bankCodStage>;
  ledger_kind: 'receipt' | 'courier_collection' | 'courier_remittance';
  method: 'bank_csv' | 'courier_csv' | 'bank_csv_cod';
};
export type BankCodParsedRow = BankCodCsvRecord & {
  row_id: string;
  data_index: number;
  row_hash: string;
  economic_key: string | null;
  identity_payload_hash: string;
  status: 'valid' | 'invalid' | 'review' | 'duplicate' | 'conflict';
  issues: Issue[];
  normalized: Source | null;
  duplicate_of?: string;
  parsed_values: {
    amount: BankCodMoney | null;
    fee: BankCodMoney | null;
    booking_date: string | null;
  };
};
export function parseBankCodCsv(
  bytes: Uint8Array,
  input: z.input<typeof bankCodProfile>,
  context: { tenant_id: string },
) {
  const profile = bankCodProfile.parse(input),
    tenant = uuid.parse(context.tenant_id);
  if (!(bytes instanceof Uint8Array)) fail('invalid_bytes', 'CSV wymaga surowych bajtów');
  if (!bytes.byteLength) fail('empty_csv', 'Pusty plik CSV');
  if (bytes.byteLength > BANK_COD_CSV_LIMITS.bytes) fail('file_limit', 'CSV przekracza 5 MiB');
  // Hash and decode one bounded owned snapshot, including a possible original UTF-8 BOM.
  const snapshot = Buffer.from(bytes),
    fileHash = createHash('sha256').update(snapshot).digest('hex'),
    decoded = decodeBankCodCsv(snapshot, profile.encoding),
    profileHash = hash(canonical(profile));
  const all = tokenizeBankCodCsv(
    decoded,
    profile.delimiter,
    profile.skip_records + (profile.header ? 1 : 0) + BANK_COD_CSV_LIMITS.data_records,
  );
  const skipped = all.slice(0, profile.skip_records),
    remaining = all.slice(profile.skip_records),
    header = profile.header ? remaining.shift() : undefined;
  if (profile.header && !header) fail('missing_header', 'Brak nagłówka');
  if (!remaining.length) fail('empty_data', 'Brak rekordów danych');
  const width = (header ?? remaining[0]).cells.length;
  const selected = Object.values(profile.columns)
    .flatMap((v) => (Array.isArray(v) ? v : [v]))
    .filter((v) => v !== undefined);
  if (selected.some((v) => v.index >= width))
    fail('missing_column', 'Wskazana kolumna nie istnieje');
  for (const r of remaining)
    if (r.cells.length !== width)
      throw new BankCodCsvError(
        'column_count',
        'Niezgodna liczba kolumn',
        r.logical_record,
        r.line_start,
        r.line_end,
      );
  const rows: BankCodParsedRow[] = remaining.map((record, dataIndex) => {
    const cells = record.cells,
      get = (c?: z.infer<typeof column>) => (c ? cells[c.index] : null);
    const issues: Issue[] = [];
    const read = <T>(field: string, fn: () => T): T | null => {
      try {
        return fn();
      } catch (e) {
        if (!(e instanceof BankCodCsvError)) throw e;
        issues.push({ code: e.code, field, message: e.message });
        return null;
      }
    };
    const transaction = read('transaction_id', () =>
      validateIdentity(get(profile.columns.transaction_id)!, 'transaction_id'),
    );
    const statement = profile.columns.statement_id
      ? read('statement_id', () =>
          validateIdentity(get(profile.columns.statement_id)!, 'statement_id'),
        )
      : null;
    const date = read('booking_date', () =>
      parseBankCodDate(get(profile.columns.booking_date)!, profile.date_format),
    );
    const code = read('currency', () => {
      const raw = profile.fixed_currency ?? get(profile.columns.currency);
      if (!currency.safeParse(raw).success)
        fail('invalid_currency', 'Brak lub nieobsługiwana waluta');
      return raw as Currency;
    });
    const amount = code
      ? read('amount', () => parseBankCodMoney(get(profile.columns.amount)!, code, profile))
      : null;
    const fee = code
      ? read('fee', () =>
          parseBankCodMoney(
            profile.mode === 'cod_remittance'
              ? (profile.fixed_fee_minor ?? get(profile.columns.fee)!)
              : '0',
            code,
            { ...profile, sign: 'credit_positive' },
          ),
        )
      : null;
    if (amount && amount.minor === null)
      issues.push({
        code: 'unsupported_debit',
        field: 'amount',
        message: 'Debit nie jest wpłatą ani korektą',
      });
    if (fee && fee.minor === null)
      issues.push({ code: 'invalid_fee', field: 'fee', message: 'Prowizja nie może być ujemna' });
    if (profile.columns.direction) {
      const direction = get(profile.columns.direction)!;
      if (profile.direction_values!.debit.includes(direction))
        issues.push({
          code: 'unsupported_debit',
          field: 'direction',
          message: 'Debit nie jest wpłatą ani korektą',
        });
      else if (!profile.direction_values!.credit.includes(direction))
        issues.push({
          code: 'invalid_direction',
          field: 'direction',
          message: 'Nieznany kierunek transakcji',
        });
    }
    if (
      amount?.minor === '0' &&
      !(profile.mode === 'cod_remittance' && fee?.minor && BigInt(fee.minor) > 0n)
    )
      issues.push({
        code: 'zero_amount',
        field: 'amount',
        message: 'Brak dodatniej kwoty lub rozliczenia prowizji',
      });
    const references = profile.columns.reference.map((c) => cells[c.index]),
      reference = references.join('\n');
    if (reference.length > 4000)
      issues.push({
        code: 'reference_limit',
        field: 'reference',
        message: 'Tytuł przekracza 4000 znaków',
      });
    const tracking = profile.columns.tracking_number
      ? read('tracking_number', () =>
          validateIdentity(get(profile.columns.tracking_number)!, 'tracking_number'),
        )
      : null;
    const identifiers = read('match', () =>
      extractBankCodReference(
        profile.match.kind === 'tracking_number'
          ? [tracking ?? '']
          : profile.columns.order_reference
            ? [get(profile.columns.order_reference)!]
            : references,
        profile.match,
      ),
    );
    if (!identifiers?.length)
      issues.push({
        code: 'missing_reference',
        field: 'match',
        message: 'Brak identyfikatora dopasowania',
      });
    else if (identifiers.length > 1)
      issues.push({
        code: 'ambiguous_reference',
        field: 'match',
        message: 'Wiele identyfikatorów wymaga uzgodnienia',
      });
    const economicKey =
      transaction && (profile.transaction_id_scope === 'namespace' || statement)
        ? bankCodEconomicKey(tenant, profile, transaction, statement)
        : null;
    const ledgerKind =
      profile.mode === 'bank_receipt'
        ? 'receipt'
        : profile.mode === 'cod_collection'
          ? 'courier_collection'
          : 'courier_remittance';
    const method =
      profile.mode === 'bank_receipt'
        ? 'bank_csv'
        : profile.source_kind === 'carrier_report'
          ? 'courier_csv'
          : 'bank_csv_cod';
    const normalized: Source | null =
      code && date && amount?.minor !== null && amount && fee?.minor !== null && fee
        ? {
            transaction_id: transaction,
            statement_id: statement,
            booking_date: date,
            currency: code,
            amount_minor: amount.minor!,
            fee_minor: fee.minor!,
            gross_minor: (BigInt(amount.minor!) + BigInt(fee.minor!)).toString(),
            ledger_amount: amount.ledger_integer!,
            ledger_fee: fee.ledger_integer!,
            reference,
            match_identifiers: identifiers ?? [],
            tracking_number: tracking,
            event_stage: bankCodStage(profile.mode),
            ledger_kind: ledgerKind,
            method,
          }
        : null;
    const payloadHash = hash({
      ledger_kind: ledgerKind,
      method,
      amount: amount?.signed_minor ?? get(profile.columns.amount),
      fee: fee?.signed_minor ?? get(profile.columns.fee),
      currency: code ?? get(profile.columns.currency),
      date: date ?? get(profile.columns.booking_date),
      match: {
        kind: profile.match.kind,
        channel: profile.match.channel_id ?? null,
        carrier: profile.match.carrier ?? null,
        identifiers: identifiers ?? references,
        tracking,
      },
    });
    const reviewCodes = new Set([
      'missing_transaction_id',
      'missing_statement_id',
      'missing_tracking_number',
      'missing_reference',
      'ambiguous_reference',
    ]);
    const status = issues.some((i) => !reviewCodes.has(i.code))
      ? 'invalid'
      : issues.length
        ? 'review'
        : 'valid';
    return {
      ...record,
      row_id: rowId(tenant, fileHash, record.logical_record),
      data_index: dataIndex + 1,
      economic_key: economicKey,
      identity_payload_hash: payloadHash,
      row_hash: hash({
        parser: BANK_COD_CSV_VERSION,
        profile: profileHash,
        raw: cells,
        normalized,
      }),
      status,
      issues,
      normalized,
      parsed_values: { amount, fee, booking_date: date },
    };
  });
  const groups = new Map<string, BankCodParsedRow[]>();
  for (const row of rows)
    if (row.economic_key) {
      const group = groups.get(row.economic_key) ?? [];
      group.push(row);
      groups.set(row.economic_key, group);
    }
  for (const group of groups.values())
    if (group.length > 1) {
      const same = group.every((r) => r.identity_payload_hash === group[0].identity_payload_hash);
      if (!same) {
        for (const r of group) {
          r.status = 'conflict';
          r.issues.push({
            code: 'conflicting_transaction',
            field: 'transaction_id',
            message: 'Ten sam ekonomiczny identyfikator ma inny dowód',
          });
        }
      } else
        for (const r of group.slice(1)) {
          r.duplicate_of = group[0].row_id;
          if (r.status === 'valid') {
            r.status = 'duplicate';
            r.issues.push({
              code: 'duplicate_transaction',
              field: 'transaction_id',
              message: 'Powtórzona transakcja w tym pliku',
            });
          }
        }
    }
  const counts = { valid: 0, invalid: 0, review: 0, duplicate: 0, conflict: 0 };
  const totals: Partial<
    Record<
      Currency,
      Record<BankCodParsedRow['status'], { amount_minor: string; fee_minor: string }>
    >
  > = {};
  for (const r of rows) {
    counts[r.status]++;
    if (!r.normalized) continue;
    const bucket =
      totals[r.normalized.currency] ??
      (Object.fromEntries(
        Object.keys(counts).map((k) => [k, { amount_minor: '0', fee_minor: '0' }]),
      ) as Record<BankCodParsedRow['status'], { amount_minor: string; fee_minor: string }>);
    const t = bucket[r.status];
    t.amount_minor = (BigInt(t.amount_minor) + BigInt(r.normalized.amount_minor)).toString();
    t.fee_minor = (BigInt(t.fee_minor) + BigInt(r.normalized.fee_minor)).toString();
    totals[r.normalized.currency] = bucket;
  }
  return {
    parser_version: BANK_COD_CSV_VERSION,
    profile,
    profile_hash: profileHash,
    file_hash: fileHash,
    file_bytes: snapshot.byteLength,
    headers: header?.cells ?? null,
    skipped_records: skipped.length,
    rows,
    summary: { data_records: rows.length, counts, totals },
  };
}
