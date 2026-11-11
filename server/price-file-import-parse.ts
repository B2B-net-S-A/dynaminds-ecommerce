import { ensure } from './errors';
import {
  assertCatalogImportJson,
  parseCatalogCsvRecords,
  parseNativeCatalogXmlRecords,
} from './catalog-file-import-parse';
import {
  PRICE_FILE_IMPORT_LIMITS as L,
  type PriceFileImportInput,
} from './price-file-import-schema';
export function parsePriceFileAmount(
  value: unknown,
  mode: 'minor' | 'decimal',
  separator: '.' | ',',
): number {
  ensure(
    typeof value === 'string' ||
      (mode === 'minor' && typeof value === 'number' && Number.isSafeInteger(value)),
    422,
    'Cena musi być dokładnym tekstem lub całkowitą kwotą minor',
  );
  const s = String(value);
  let n: bigint;
  if (mode === 'minor') {
    ensure(/^(0|[1-9][0-9]*)$/.test(s), 422, 'Niepoprawna całkowita kwota minor');
    n = BigInt(s);
  } else {
    const escaped = separator === '.' ? '\\.' : ',';
    ensure(
      new RegExp(`^(0|[1-9][0-9]*)(?:${escaped}[0-9]{1,2})?$`).test(s),
      422,
      'Cena wymaga najwyżej dwóch miejsc dziesiętnych bez wykładnika',
    );
    const [whole, fraction = ''] = s.split(separator);
    n = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  }
  ensure(n <= 100000000n, 422, 'Cena przekracza dopuszczalny zakres');
  return Number(n);
}
export function parsePriceFile(q: PriceFileImportInput) {
  ensure(Buffer.byteLength(q.content, 'utf8') <= L.file_bytes, 413, 'Plik przekracza 2 MiB');
  assertCatalogImportJson(q.content);
  const content = q.content.replace(/^\ufeff/, '');
  if (q.definition.format === 'xml') {
    const r = parseNativeCatalogXmlRecords(content);
    return {
      currency: r.currency,
      rows: r.rows.map((raw_cells) => ({ raw_cells, errors: [] as string[] })),
    };
  }
  const [headers, ...records] = parseCatalogCsvRecords(content, q.definition.delimiter);
  ensure(
    headers?.length &&
      headers.every((h) => h && !['__proto__', 'prototype', 'constructor'].includes(h)) &&
      new Set(headers.map((h) => h.toLowerCase())).size === headers.length,
    422,
    'Niepoprawne lub powtórzone nagłówki CSV',
  );
  ensure(records.length >= 1 && records.length <= L.rows, 422, 'Plik wymaga od 1 do 500 wierszy');
  return {
    currency: null,
    rows: records.map((row) => ({
      raw_cells: Object.fromEntries(
        headers
          .map((h, i) => [h, row[i] ?? null])
          .concat(row.slice(headers.length).map((v, i) => [`__extra_${i}`, v])),
      ),
      errors: row.length === headers.length ? [] : ['Liczba pól nie odpowiada nagłówkom'],
    })),
  };
}
export function priceFileCell(value: unknown, safe: boolean, identity?: string) {
  if (typeof value !== 'string' || !safe || !value.startsWith("'")) return value;
  const original = value.slice(1);
  return ['uuid', 'sku', 'historical_sku', 'ean'].includes(identity ?? '') ||
    /^[\s]*[=+\-@]/u.test(original) ||
    /^[\t\r\n]/u.test(original) ||
    /^[\s]*[+-]?\d+(?:[.,]\d+)?(?:[eE][+-]?\d+)?[\s]*$/u.test(original)
    ? original
    : value;
}
