import { createHash } from 'node:crypto';
import { SaxesParser } from 'saxes';
import { z } from 'zod';
import { ensure } from './errors';
import {
  assertCatalogImportJson,
  parseCatalogCsvRecords,
  parseNativeCatalogXmlRecords,
} from './catalog-file-import-parse';
import { priceFileCell } from './price-file-import-parse';
import {
  STOCK_FILE_IMPORT_LIMITS as L,
  stockFileImportPreviewInput,
  stockFileImportPosition,
  type StockFileImportInput,
  type StockFileImportTarget,
  type ParsedStockFile,
  type StockFileImportPosition,
} from './stock-file-import-schema';

const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const cleanField = (name: string) => name.length > 0 && name.length <= 80 && !forbidden.has(name);
const quantity = (v: unknown): number => {
  ensure(
    typeof v === 'string' && /^(0|[1-9][0-9]{0,6})$/.test(v),
    422,
    'Pomiar wymaga kanonicznej nieujemnej liczby całkowitej',
  );
  const n = Number(v);
  ensure(n <= L.quantity, 422, 'Pomiar przekracza 1000000');
  return n;
};
const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Niepoprawny pomiar');

/** Closed native physical format. Text money never passes through JSON Number. */
export function parseStockPositionsXml(content: string): Record<string, string>[] {
  ensure(!/<!\s*(DOCTYPE|ENTITY)/i.test(content), 422, 'DTD i encje są zabronione');
  const result: Record<string, string>[] = [];
  let depth = 0,
    rootSeen = false,
    nodes = 0,
    row: Record<string, string> | null = null;
  let fieldName: string | null = null,
    fieldText = '';
  const parser = new SaxesParser({ xmlns: false });
  parser.on('opentag', (tag) => {
    ensure(++nodes <= 100000, 422, 'Za dużo węzłów XML');
    ensure(!tag.name.includes(':'), 422, 'Namespace XML jest niedozwolony');
    const attrs = tag.attributes as Record<string, string>;
    if (depth === 0) {
      ensure(
        !rootSeen &&
          tag.name === 'dynaminds-stock-counts' &&
          Object.keys(attrs).length === 1 &&
          attrs.version === '1',
        422,
        'Niepoprawny format XML pomiarów',
      );
      rootSeen = true;
    } else if (depth === 1) {
      ensure(tag.name === 'row' && !Object.keys(attrs).length, 422, 'XML wymaga row');
      ensure(result.length < L.source_rows, 422, 'XML przekracza 500 wierszy');
      row = Object.create(null) as Record<string, string>;
    } else if (depth === 2) {
      ensure(
        tag.name === 'field' &&
          Object.keys(attrs).length === 1 &&
          typeof attrs.name === 'string' &&
          cleanField(attrs.name),
        422,
        'Niepoprawne pole XML',
      );
      ensure(row && !Object.hasOwn(row, attrs.name), 422, 'Powtórzone pole XML');
      fieldName = attrs.name;
      fieldText = '';
    } else ensure(false, 422, 'Zagnieżdżenia w polu XML są niedozwolone');
    depth++;
  });
  parser.on('text', (v) => {
    if (depth === 3) fieldText += v;
    else ensure(v.trim().length === 0, 422, 'Tekst poza polem XML');
  });
  parser.on('cdata', (v) => {
    ensure(depth === 3, 422, 'CDATA poza polem XML');
    fieldText += v;
  });
  parser.on('closetag', () => {
    depth--;
    if (depth === 2) {
      ensure(row && fieldName !== null, 422, 'Niepoprawne pole XML');
      row[fieldName] = fieldText;
      fieldName = null;
    } else if (depth === 1) {
      ensure(row && Object.keys(row).length > 0, 422, 'Pusty wiersz XML');
      result.push(row);
      row = null;
    }
  });
  parser.on('error', () => ensure(false, 422, 'Niepoprawny XML'));
  parser.write(content).close();
  ensure(rootSeen && depth === 0 && result.length > 0, 422, 'XML wymaga wierszy pomiarów');
  return result;
}

function records(
  b: StockFileImportInput,
): Array<{ raw_cells: Record<string, unknown>; errors: string[] }> {
  const content = b.content.replace(/^\ufeff/, '');
  if (b.definition.format === 'xml') {
    const rows =
      b.definition.xml_mode === 'positions'
        ? parseStockPositionsXml(content)
        : parseNativeCatalogXmlRecords(content).rows;
    return rows.map((raw_cells) => ({ raw_cells, errors: [] }));
  }
  const [headers, ...data] = parseCatalogCsvRecords(content, b.definition.delimiter);
  ensure(
    headers?.length &&
      headers.every(cleanField) &&
      new Set(headers.map((v) => v.toLowerCase())).size === headers.length,
    422,
    'CSV wymaga unikalnych, bezpiecznych nagłówków',
  );
  ensure(data.length > 0 && data.length <= L.source_rows, 422, 'CSV wymaga 1–500 wierszy');
  return data.map((values) => ({
    raw_cells: Object.fromEntries(headers.map((h, i) => [h, values[i] ?? ''])),
    errors: values.length === headers.length ? [] : ['Liczba komórek różni się od nagłówków'],
  }));
}
function mappedPosition(
  b: StockFileImportInput,
  t: StockFileImportTarget,
  raw: Record<string, unknown>,
  n: number,
): StockFileImportPosition {
  const scalar = (key: keyof StockFileImportTarget['mapping']) => {
    const field = t.mapping[key];
    if (!field) return null;
    const v = priceFileCell(
      raw[field],
      b.definition.format === 'csv' && b.definition.spreadsheet_safe,
    );
    ensure(
      v === '' || v === null || typeof v === 'string',
      422,
      'Pole pomiaru wymaga tekstu: ' + field,
    );
    return v === '' ? null : (v as string | null);
  };
  const location = scalar('location') ?? t.default_location;
  const lotId = scalar('lot_id'),
    lotCode = scalar('lot_code'),
    expiry = scalar('expiry_date');
  ensure(!(lotId && lotCode), 422, 'Wskaż istniejącą albo nową partię');
  ensure(!expiry || lotCode, 422, 'Data ważności wymaga nowej partii');
  return stockFileImportPosition.parse({
    location,
    quantity: n,
    lot: lotId
      ? { kind: 'existing', lot_id: lotId }
      : lotCode
        ? { kind: 'new', lot_code: lotCode, expiry_date: expiry }
        : null,
    unit_cost_minor: scalar('unit_cost_minor'),
    currency: scalar('currency'),
  });
}
function nativeQuantity(raw: unknown, t: StockFileImportTarget): string | null {
  ensure(Array.isArray(raw), 422, 'inventory_json wymaga tablicy magazynów');
  const selected = raw.filter(
    (v) => v && typeof v === 'object' && v.warehouse_id === t.warehouse_id,
  );
  ensure(selected.length <= 1, 422, 'Powtórzona grupa wybranego magazynu');
  if (!selected.length) return null;
  const r = selected[0];
  if (r.status === 'missing' && r.source === 'stock' && r.on_hand === null) return null;
  ensure(
    r.status === 'available' &&
      r.source === 'stock' &&
      Number.isSafeInteger(r.on_hand) &&
      r.on_hand >= 0 &&
      r.on_hand <= 2147483647,
    422,
    'XML nie zawiera własnego stanu fizycznego',
  );
  return String(r.on_hand);
}

/** DB-free interpretation. Product identity, actual basis/cost grants stay server-owned. */
export function parseStockFile(input: StockFileImportInput): ParsedStockFile {
  ensure(
    Buffer.byteLength(JSON.stringify(input), 'utf8') <= L.request_bytes,
    413,
    'Żądanie przekracza 6 MiB',
  );
  const b = stockFileImportPreviewInput.parse(input);
  ensure(Buffer.byteLength(b.content, 'utf8') <= L.file_bytes, 413, 'Plik przekracza 2 MiB');
  assertCatalogImportJson(b);
  const data = records(b);
  assertCatalogImportJson(data);
  for (const r of b.resolutions)
    ensure(r.source_index < data.length, 422, 'Rozwiązanie wskazuje nieistniejący wiersz');
  let physical = 0;
  const rows = data.map(({ raw_cells, errors }, source_index) => {
    let identity: string | null = null;
    const rowErrors = [...errors];
    try {
      ensure(
        Object.hasOwn(raw_cells, b.definition.identity_field),
        422,
        'Brak pola identyfikatora',
      );
      const value = priceFileCell(
        raw_cells[b.definition.identity_field],
        b.definition.format === 'csv' && b.definition.spreadsheet_safe,
        b.definition.identity,
      );
      ensure(typeof value === 'string' && value.length > 0, 422, 'Brak tekstowego identyfikatora');
      if (b.definition.identity === 'uuid') {
        const parsedId = z.uuid().safeParse(value);
        ensure(parsedId.success, 422, 'Niepoprawny UUID produktu');
        identity = parsedId.data.toLowerCase();
      } else identity = value;
    } catch (e) {
      rowErrors.push(errorText(e));
    }
    const cells = b.targets.map((t) => {
      const cell: ParsedStockFile['rows'][number]['cells'][number] = {
        warehouse_id: t.warehouse_id,
        operation: 'none',
        quantity: null,
        positions: [],
        errors: [],
      };
      try {
        for (const key of Object.values(t.mapping))
          ensure(Object.hasOwn(raw_cells, key), 422, 'Brak mapowanego pola: ' + key);
        const resolution = b.resolutions.find(
          (r) => r.source_index === source_index && r.warehouse_id === t.warehouse_id,
        );
        const operation = t.mapping.operation
          ? priceFileCell(
              raw_cells[t.mapping.operation],
              b.definition.format === 'csv' && b.definition.spreadsheet_safe,
            )
          : '';
        ensure(
          operation === '' || operation === null || operation === 'none' || operation === 'count',
          422,
          'Operacja musi być count lub none',
        );
        if (operation === 'none') {
          ensure(!resolution, 422, 'Pominięty pomiar nie może mieć rozwiązania');
          return cell;
        }
        const value =
          b.definition.format === 'xml' && b.definition.xml_mode === 'catalog'
            ? nativeQuantity(raw_cells[t.mapping.quantity], t)
            : priceFileCell(
                raw_cells[t.mapping.quantity],
                b.definition.format === 'csv' && b.definition.spreadsheet_safe,
              );
        if (value === null || value === '') {
          ensure(!resolution, 422, 'Pusty pomiar nie może mieć rozwiązania');
          ensure(
            operation !== 'count' && b.definition.empty_policy === 'skip',
            422,
            'Brak wymaganego pomiaru',
          );
          return cell;
        }
        const n =
          t.quantity_scope === 'warehouse_total'
            ? (() => {
                ensure(
                  typeof value === 'string' && /^(0|[1-9][0-9]{0,9})$/.test(value),
                  422,
                  'Niepoprawny agregat fizyczny',
                );
                const q = Number(value);
                ensure(q <= 2147483647, 422, 'Agregat przekracza int32');
                return q;
              })()
            : quantity(value);
        cell.operation = 'count';
        cell.quantity = n;
        if (resolution) {
          ensure(
            t.quantity_scope !== 'position' || resolution.positions.length === 1,
            422,
            'Pomiar pozycji ma dokładnie jedno rozwiązanie',
          );
          ensure(
            resolution.positions.reduce((sum, p) => sum + p.quantity, 0) === n,
            422,
            'Rozkład pozycji nie pokrywa źródłowego pomiaru',
          );
          cell.positions = resolution.positions;
        } else if (t.quantity_scope === 'warehouse_total')
          cell.errors.push('Agregat wymaga jawnych pomiarów wszystkich binów/partii');
        else cell.positions = [mappedPosition(b, t, raw_cells, n)];
      } catch (e) {
        cell.errors.push(errorText(e));
      }
      return cell;
    });
    return { source_index, raw_cells, identity, errors: rowErrors, cells };
  });
  // Include skipped logical cells as retained evidence; never silently truncate.
  physical = rows.reduce(
    (sum, r) => sum + r.cells.reduce((n, c) => n + Math.max(c.positions.length, 1), 0),
    0,
  );
  ensure(physical <= L.positions, 422, 'Zakres przekracza 4000 pozycji');
  return { source_hash: createHash('sha256').update(b.content, 'utf8').digest('hex'), rows };
}
