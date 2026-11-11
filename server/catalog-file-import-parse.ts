import { SaxesParser } from 'saxes';
import { ensure } from './errors';
import { parseCatalogMappedXmlRecords } from './catalog-mapped-xml';
import {
  CATALOG_FILE_IMPORT_FIELDS,
  CATALOG_FILE_IMPORT_LIMITS as LIMITS,
  type CatalogFileImportInput,
} from './catalog-file-import-schema';

export type ParsedCatalogImport = {
  rows: Array<{ fields: Record<string, unknown>; errors: string[] }>;
  currency: string | null;
};
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
export function assertCatalogImportJson(value: unknown, depth = 0): void {
  ensure(depth <= 16, 422, 'Struktura pliku przekracza 16 poziomów');
  if (typeof value === 'string')
    ensure(
      !value.includes('\0') && Buffer.from(value, 'utf8').toString('utf8') === value,
      422,
      'Plik wymaga poprawnego Unicode bez NUL',
    );
  else if (Array.isArray(value))
    for (const child of value) assertCatalogImportJson(child, depth + 1);
  else if (value && typeof value === 'object')
    for (const [key, child] of Object.entries(value)) {
      ensure(!forbidden.has(key), 422, 'Niedozwolony klucz w pliku');
      assertCatalogImportJson(key, depth + 1);
      assertCatalogImportJson(child, depth + 1);
    }
}
function aliases(q: CatalogFileImportInput) {
  const result = new Map<string, string>();
  for (const key of CATALOG_FILE_IMPORT_FIELDS) {
    const source = q.mapping[key] ?? key;
    ensure(!forbidden.has(source), 422, 'Niedozwolona nazwa pola');
    ensure(!result.has(source), 422, 'Mapowanie wskazuje dwukrotnie to samo pole');
    ensure(
      source === key || !CATALOG_FILE_IMPORT_FIELDS.some((k) => k === source),
      422,
      'Alias nie może przesłaniać innego pola kanonicznego',
    );
    result.set(source, key);
  }
  return result;
}
export function parseCatalogCsvRecords(content: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = '',
    quoted = false,
    closed = false;
  const field = () => {
    row.push(cell);
    cell = '';
    closed = false;
  };
  const line = () => {
    field();
    rows.push(row);
    row = [];
    ensure(rows.length <= LIMITS.rows + 1, 422, 'Plik przekracza 500 wierszy produktów');
  };
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (quoted) {
      if (ch === '"') {
        if (content[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else cell += ch;
    } else if (ch === delimiter) field();
    else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && content[i + 1] === '\n') i++;
      line();
    } else if (ch === '"') {
      ensure(!cell && !closed, 422, 'Niepoprawny cudzysłów w CSV');
      quoted = true;
    } else {
      ensure(!closed, 422, 'Dane za zamkniętym polem CSV');
      cell += ch;
    }
  }
  ensure(!quoted, 422, 'Niezamknięte pole CSV');
  if (cell || row.length || closed) line();
  return rows;
}
type XmlNode = { name: string; attrs: Record<string, string>; text: string; children: XmlNode[] };
export function parseNativeCatalogXmlRecords(content: string) {
  ensure(!/<!\s*(?:DOCTYPE|ENTITY)/i.test(content), 422, 'DTD i deklaracje encji są zabronione');
  const parser = new SaxesParser({ xmlns: false }),
    stack: XmlNode[] = [];
  let root: XmlNode | undefined,
    nodes = 0;
  parser.on('opentag', (tag) => {
    ensure(++nodes <= LIMITS.xml_nodes, 422, 'XML przekracza 100000 węzłów');
    ensure(stack.length < LIMITS.xml_depth, 422, 'XML przekracza 16 poziomów');
    const attrs: Record<string, string> = {};
    for (const [key, value] of Object.entries(tag.attributes)) {
      ensure(typeof value === 'string' && !forbidden.has(key), 422, 'Niepoprawny atrybut XML');
      attrs[key] = value as string;
    }
    const node: XmlNode = { name: tag.name, attrs, text: '', children: [] };
    ensure(!forbidden.has(node.name) && !node.name.includes(':'), 422, 'Niedozwolony tag XML');
    if (stack.length) stack.at(-1)!.children.push(node);
    else {
      ensure(!root, 422, 'XML wymaga jednego korzenia');
      root = node;
    }
    stack.push(node);
  });
  parser.on('text', (text) => {
    ensure(++nodes <= LIMITS.xml_nodes, 422, 'XML przekracza 100000 węzłów');
    if (stack.length) stack.at(-1)!.text += text;
    else ensure(!text.trim(), 422, 'Dane poza korzeniem XML');
  });
  parser.on('cdata', (text) => {
    ensure(++nodes <= LIMITS.xml_nodes, 422, 'XML przekracza 100000 węzłów');
    if (stack.length) stack.at(-1)!.text += text;
  });
  parser.on('closetag', () => {
    stack.pop();
  });
  parser.on('processinginstruction', () => {
    ensure(false, 422, 'Instrukcje przetwarzania XML są zabronione');
  });
  parser.on('error', () => {
    ensure(false, 422, 'Niepoprawny XML');
  });
  parser.write(content).close();
  ensure(root?.name === 'catalog' && !root.text.trim(), 422, 'XML wymaga korzenia catalog');
  ensure(
    Object.keys(root.attrs).every((k) => ['currency', 'price_source'].includes(k)) &&
      ['PLN', 'EUR', 'USD', 'GBP', 'CZK'].includes(root.attrs.currency) &&
      (root.attrs.price_source === undefined || root.attrs.price_source === 'catalog'),
    422,
    'Niepoprawna waluta lub źródło katalogu XML',
  );
  ensure(
    root.children.length >= 1 &&
      root.children.length <= LIMITS.rows &&
      root.children.every(
        (n) => n.name === 'product' && !n.text.trim() && !Object.keys(n.attrs).length,
      ),
    422,
    'XML wymaga od 1 do 500 produktów',
  );
  const decode = (node: XmlNode, objectEntry = false): unknown => {
    ensure(
      Object.keys(node.attrs).every((k) =>
        ['type', 'nil', ...(objectEntry ? ['key'] : [])].includes(k),
      ),
      422,
      'Nieznany atrybut pola XML',
    );
    if (node.attrs.nil !== undefined) {
      ensure(
        node.attrs.nil === 'true' &&
          node.attrs.type === undefined &&
          !node.children.length &&
          !node.text,
        422,
        'Niepoprawne null w XML',
      );
      return null;
    }
    const type = node.attrs.type;
    ensure(
      ['string', 'number', 'boolean', 'array', 'object'].includes(type),
      422,
      'Nieznany typ pola XML',
    );
    if (type === 'array' || type === 'object') {
      ensure(!node.text.trim(), 422, 'Struktura XML zawiera dodatkowy tekst');
      if (type === 'array') {
        ensure(
          node.children.every((c) => c.name === 'item'),
          422,
          'Tablica XML wymaga item',
        );
        return node.children.map((c) => decode(c));
      }
      const keys = node.children.map((c) => c.attrs.key);
      ensure(
        node.children.every((c) => c.name === 'entry') &&
          keys.every((k) => typeof k === 'string' && !forbidden.has(k)) &&
          new Set(keys).size === keys.length,
        422,
        'Powtórzone lub niepoprawne klucze XML',
      );
      return Object.fromEntries(node.children.map((c) => [c.attrs.key, decode(c, true)]));
    }
    ensure(!node.children.length, 422, 'Skalar XML nie może zawierać tagów');
    if (type === 'number') {
      ensure(
        /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(node.text) && Number.isFinite(Number(node.text)),
        422,
        'Niepoprawna liczba XML',
      );
      return Number(node.text);
    }
    if (type === 'boolean') {
      ensure(node.text === 'true' || node.text === 'false', 422, 'Niepoprawny boolean XML');
      return node.text === 'true';
    }
    return node.text;
  };
  return {
    currency: root.attrs.currency,
    rows: root.children.map((product) => {
      const names = product.children.map((c) => c.name);
      ensure(new Set(names).size === names.length, 422, 'Powtórzone pola produktu XML');
      return Object.fromEntries(product.children.map((c) => [c.name, decode(c)]));
    }),
  };
}
export function parseCatalogFileImport(q: CatalogFileImportInput): ParsedCatalogImport {
  ensure(Buffer.byteLength(q.content, 'utf8') <= LIMITS.file_bytes, 413, 'Plik przekracza 2 MiB');
  assertCatalogImportJson(q.content);
  if (q.xml_mapping) {
    ensure(
      q.format === 'xml' && Object.keys(q.mapping).length === 0,
      422,
      'Mapowany XML wymaga formatu XML i pustego zwykłego mapowania',
    );
    const rows = parseCatalogMappedXmlRecords(q.content, q.xml_mapping);
    for (const row of rows) assertCatalogImportJson(row.fields);
    return { rows, currency: q.currency };
  }
  const mapping = aliases(q),
    content = q.content.replace(/^\ufeff/, '');
  let records: Record<string, unknown>[],
    currency: string | null = null;
  if (q.format === 'xml') {
    const parsed = parseNativeCatalogXmlRecords(content);
    records = parsed.rows;
    currency = parsed.currency;
  } else {
    const [headers, ...data] = parseCatalogCsvRecords(content, q.delimiter);
    ensure(
      headers?.length &&
        headers.every((h) => h.trim() && !forbidden.has(h)) &&
        new Set(headers.map((h) => h.toLowerCase())).size === headers.length,
      422,
      'Niepoprawne lub powtórzone nagłówki CSV',
    );
    ensure(data.length >= 1 && data.length <= LIMITS.rows, 422, 'CSV wymaga od 1 do 500 produktów');
    records = data.map((row) => {
      ensure(row.length === headers.length, 422, 'Liczba pól CSV nie odpowiada nagłówkom');
      return Object.fromEntries(headers.map((h, i) => [h, row[i]]));
    });
  }
  const rows = records.map((record) => {
    const fields: Record<string, unknown> = {},
      errors: string[] = [];
    for (const [source, value] of Object.entries(record)) {
      const key = mapping.get(source);
      if (!key) {
        errors.push(`Nieznane pole: ${source}`);
        continue;
      }
      fields[key] = value;
    }
    assertCatalogImportJson(fields);
    return { fields, errors };
  });
  return { rows, currency };
}
