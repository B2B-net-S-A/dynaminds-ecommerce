import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ensure, Problem } from './errors';
import { orderFieldBatchCsvConfigSchema } from './order-field-batches-schema';
export function orderFieldBatchCsvBytes(content: string) {
  ensure(
    content.length <= 6990508 && content.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(content),
    422,
    'Niepoprawne base64 CSV',
  );
  const bytes = Buffer.from(content, 'base64');
  ensure(
    bytes.length > 0 && bytes.length <= 5242880 && bytes.toString('base64') === content,
    422,
    'Limit CSV 5 MiB lub niekanoniczne bajty',
  );
  return bytes;
}
export function parseOrderFieldBatchCsv(
  bytes: Buffer,
  config: z.infer<typeof orderFieldBatchCsvConfigSchema>,
) {
  ensure(bytes.length > 0 && bytes.length <= 5242880, 422, 'Limit CSV 5 MiB');
  config = orderFieldBatchCsvConfigSchema.parse(config);
  let text: string;
  try {
    text = new TextDecoder(config.encoding, { fatal: true }).decode(bytes);
  } catch {
    throw new Problem(422, 'Niepoprawne kodowanie CSV');
  }
  // WHATWG decoders map undefined Windows bytes to control/replacement characters; reject those bytes explicitly.
  if (config.encoding === 'windows-1250')
    ensure(
      !bytes.some((b) => [0x81, 0x83, 0x88, 0x90, 0x98].includes(b)),
      422,
      'Niepoprawny bajt Windows-1250',
    );
  if (text.startsWith('\ufeff')) text = text.slice(1);
  ensure(!text.includes('\0'), 422, 'CSV zawiera NUL');
  const rows: string[][] = [];
  let row: string[] = [],
    cell = '',
    quoted = false,
    closed = false,
    started = false;
  const pushCell = () => {
    ensure(Buffer.byteLength(cell) <= 65536, 422, 'Komórka CSV przekracza 64 KiB');
    row.push(cell);
    ensure(row.length <= 100, 422, 'CSV przekracza 100 kolumn');
    cell = '';
    closed = false;
    started = false;
  };
  const pushRow = () => {
    pushCell();
    rows.push(row);
    row = [];
    ensure(rows.length <= 5001, 422, 'CSV przekracza 5000 rekordów');
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else cell += ch;
      continue;
    }
    if (ch === '"') {
      ensure(!started && !closed, 422, 'Niepoprawne cudzysłowy CSV');
      quoted = true;
      started = true;
      continue;
    }
    if (ch === config.delimiter) {
      pushCell();
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r') {
        ensure(text[i + 1] === '\n', 422, 'CSV wymaga LF lub CRLF');
        i++;
      }
      pushRow();
      continue;
    }
    ensure(!closed, 422, 'Tekst po zamkniętym cudzysłowie CSV');
    cell += ch;
    started = true;
  }
  ensure(!quoted, 422, 'Niezamknięty cudzysłów CSV');
  if (cell.length || row.length || started || closed) pushRow();
  ensure(rows.length >= 2, 422, 'CSV wymaga nagłówka i rekordów');
  const header = rows.shift()!;
  ensure(
    rows.every((r) => r.length === header.length),
    422,
    'Nierówna liczba kolumn CSV',
  );
  const cols = [
    config.identity.column,
    config.order_version_column,
    ...config.fields.map((f) => f.column),
  ];
  ensure(
    cols.every((n) => n < header.length),
    422,
    'Mapowanie poza kolumnami CSV',
  );
  return { header, rows, file_hash: createHash('sha256').update(bytes).digest('hex') };
}
export const orderFieldCsvCellSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('set'), value: z.unknown() }),
  z.strictObject({ operation: z.literal('clear') }),
]);
export function orderFieldCsvQuote(value: string) {
  return '"' + value.replaceAll('"', '""') + '"';
}
export function orderFieldSheetCell(value: string) {
  return /^[\s\u0000-\u001f\u007f]*[=+\-@]/.test(value) ? "'" + value : value;
}
