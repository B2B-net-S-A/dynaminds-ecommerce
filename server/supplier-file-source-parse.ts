import { z } from 'zod';
import { ensure } from './errors';
import { parseCatalogCsvRecords } from './catalog-file-import-parse';
import { parseCatalogMappedXmlRecords } from './catalog-mapped-xml';
import {
  SUPPLIER_FILE_SOURCE_LIMITS as LIMITS,
  supplierFileSourceConfig,
  supplierFileCurrency,
  type SupplierFileSourceConfig,
} from './supplier-file-source-schema';

export type SupplierFileSnapshot = {
  remote_product_id: string;
  remote_variant_id: string;
  sku: string;
  name: string;
  ean: string | null;
  description: string;
  images: string[];
  unit_cost: number;
  currency: z.infer<typeof supplierFileCurrency>;
  tiers: Array<{ quantity: number; unit_cost: number }>;
  quantity: number;
  active: boolean;
  handling: Array<{
    quantity: number;
    minHandlingDays: number;
    maxHandlingDays: number;
    warehouse: null;
  }>;
  condition: string;
};
export type SupplierFileSourceRow = {
  index: number;
  remote_product_id: string;
  remote_variant_id: string;
  sku: string;
  name: string;
  snapshot: SupplierFileSnapshot | null;
  errors: string[];
};
const xmlFields = {
  remote_id: 'sku',
  remote_variant_id: 'parent_sku',
  sku: 'manufacturer',
  name: 'name',
  ean: 'ean',
  description: 'description',
  cost_minor: 'price_minor',
  quantity: 'weight_g',
  handling_days: 'length_mm',
} as const;
type Field = keyof SupplierFileSourceConfig['fields'];
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);

export function parseSupplierFileSource(
  content: string,
  input: SupplierFileSourceConfig,
  sourceCurrency: string,
  max_handling_days: number,
): SupplierFileSourceRow[] {
  const config = supplierFileSourceConfig.parse(input);
  const currency = supplierFileCurrency.parse(sourceCurrency);
  z.number().int().min(0).max(365).parse(max_handling_days);
  ensure(typeof content === 'string' && content.length > 0, 422, 'Plik wymaga treści');
  ensure(Buffer.byteLength(content, 'utf8') <= LIMITS.file_bytes, 413, 'Plik przekracza 2 MiB');
  ensure(
    !content.includes('\0') && Buffer.from(content, 'utf8').toString('utf8') === content,
    422,
    'Plik wymaga poprawnego Unicode bez NUL',
  );
  let records: Array<Partial<Record<Field, string>>>;
  if (config.format === 'xml') {
    // Each supplier field has a distinct catalog key. Read text, then apply our NET/availability limits exactly once.
    const mapping = Object.fromEntries(
      Object.entries(config.fields).map(([key, definition]) => [
        xmlFields[key as Field],
        { path: definition!.path, value_type: 'text' as const },
      ]),
    );
    records = parseCatalogMappedXmlRecords(content, {
      record_path: config.record_path!,
      fields: mapping,
    }).map(
      (row) =>
        Object.fromEntries(
          Object.keys(config.fields)
            .filter((key) => Object.hasOwn(row.fields, xmlFields[key as Field]))
            .map((key) => [key, row.fields[xmlFields[key as Field]]]),
        ) as Partial<Record<Field, string>>,
    );
  } else {
    const [headers, ...data] = parseCatalogCsvRecords(
      content.replace(/^\ufeff/, ''),
      config.delimiter,
    );
    ensure(
      headers?.length &&
        headers.every(
          (h) =>
            h.trim().length > 0 && !forbidden.has(h) && !/[\u0000-\u001f\u007f-\u009f]/u.test(h),
        ) &&
        new Set(headers.map((h) => h.toLowerCase())).size === headers.length,
      422,
      'Niepoprawne lub powtórzone nagłówki CSV',
    );
    ensure(data.length >= 1 && data.length <= LIMITS.rows, 422, 'CSV wymaga od 1 do 500 wierszy');
    records = data.map((row) => {
      ensure(row.length === headers.length, 422, 'Liczba pól CSV nie odpowiada nagłówkom');
      return Object.fromEntries(
        Object.entries(config.fields)
          .filter(([, definition]) => headers.includes(definition!.path))
          .map(([key, definition]) => [key, row[headers.indexOf(definition!.path)]]),
      );
    });
  }
  const result = records.map((record, index): SupplierFileSourceRow => {
    const errors: string[] = [];
    function text(field: Field, max: number, required = false, min = 1, multiline = false) {
      const raw = record[field];
      if (raw === undefined || raw === '') {
        if (required) errors.push(`Brak wymaganego pola: ${field}`);
        return '';
      }
      const value = multiline ? raw : raw.trim();
      if (
        value.length < min ||
        value.length > max ||
        (multiline
          ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u
          : /[\u0000-\u001f\u007f-\u009f]/u
        ).test(raw)
      )
        errors.push(`Nieprawidłowy tekst: ${field}`);
      return value;
    }
    function number(
      field: 'cost_minor' | 'quantity' | 'handling_days',
      max: number,
      decimal = false,
    ) {
      const raw = record[field];
      const pattern = decimal ? /^(0|[1-9][0-9]{0,9})(?:\.[0-9]{1,2})?$/ : /^(0|[1-9][0-9]{0,9})$/;
      if (raw === undefined || !pattern.test(raw)) {
        errors.push(`Nieprawidłowa lub brakująca liczba: ${field}`);
        return null;
      }
      const [whole, fraction = ''] = raw.split('.');
      const n = decimal ? BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')) : BigInt(whole);
      if (n > BigInt(max)) {
        errors.push(`Liczba przekracza limit: ${field}`);
        return null;
      }
      return Number(n);
    }
    const remote_product_id = text('remote_id', 200, true),
      remote_variant_id = text('remote_variant_id', 200);
    const sku = text('sku', 80),
      name = text('name', 200, true, 2),
      ean = text('ean', 32) || null,
      description = text('description', 100000, false, 0, true);
    const unit_cost = number(
      'cost_minor',
      1000000000,
      config.fields.cost_minor.value_type === 'decimal_money',
    );
    const rawQuantity = number('quantity', 10000000);
    const days = config.fields.handling_days ? number('handling_days', 365) : 0;
    const snapshot: SupplierFileSnapshot | null = errors.length
      ? null
      : {
          remote_product_id,
          remote_variant_id,
          sku,
          name,
          ean,
          description,
          images: [],
          unit_cost: unit_cost!,
          currency,
          tiers: [],
          quantity: days! <= max_handling_days ? rawQuantity! : 0,
          active: true,
          handling: [
            { quantity: rawQuantity!, minHandlingDays: 0, maxHandlingDays: days!, warehouse: null },
          ],
          condition: 'nieznany',
        };
    return { index, remote_product_id, remote_variant_id, sku, name, snapshot, errors };
  });
  const identities = new Map<string, SupplierFileSourceRow[]>();
  for (const row of result) {
    const key = JSON.stringify([row.remote_product_id, row.remote_variant_id]);
    identities.set(key, [...(identities.get(key) ?? []), row]);
  }
  for (const group of identities.values())
    if (group.length > 1)
      for (const row of group) {
        row.errors.push('Powtórzony identyfikator produktu i wariantu');
        row.snapshot = null;
      }
  return result;
}
