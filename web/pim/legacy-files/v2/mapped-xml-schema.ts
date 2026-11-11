import { z } from 'zod';
import { catalogXmlPathValid } from '../../../../shared/catalog-xml-path';

export const CATALOG_FILE_IMPORT_LIMITS = {
  rows: 500,
  file_bytes: 2097152,
  request_bytes: 4194304,
  page_rows: 100,
  history_page: 25,
  history_per_tenant: 2000,
  preview_bytes: 8388608,
  history_bytes: 134217728,
  xml_depth: 16,
  xml_nodes: 100000,
} as const;
export const CATALOG_FILE_IMPORT_FIELDS = [
  'id',
  'sku',
  'ean',
  'name',
  'description',
  'price_minor',
  'vat_rate',
  'category',
  'active',
  'kind',
  'weight_g',
  'length_mm',
  'width_mm',
  'height_mm',
  'manufacturer',
  'attributes_json',
  'images_json',
  'bundle_components_json',
  'parent_id',
  'parent_sku',
  'variants_json',
  'translations_json',
  'inventory_json',
  'prices_json',
] as const;
export const CATALOG_FILE_IMPORT_READONLY_FIELDS = [
  'variants_json',
  'translations_json',
  'inventory_json',
  'prices_json',
] as const;
const alias = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine((v) => !/[\u0000-\u001f\u007f-\u009f]/u.test(v), 'Nieprawidłowa nazwa pola');
const xmlPath = (absolute: boolean) =>
  z
    .string()
    .min(1)
    .max(1024)
    .refine(
      (v) => catalogXmlPathValid(v, absolute, CATALOG_FILE_IMPORT_LIMITS.xml_depth),
      'Ścieżka XML wymaga jawnych nazw bez wyrażeń XPath',
    );
export const catalogMappedXmlInput = z.strictObject({
  record_path: xmlPath(true),
  fields: z
    .partialRecord(
      z.enum(CATALOG_FILE_IMPORT_FIELDS),
      z.strictObject({
        path: xmlPath(false),
        value_type: z.enum(['text', 'integer', 'decimal_money', 'boolean']).default('text'),
      }),
    )
    .refine(
      (fields) =>
        Object.keys(fields).length > 0 &&
        !CATALOG_FILE_IMPORT_READONLY_FIELDS.some((field) => Object.hasOwn(fields, field)),
      'Mapowany XML wymaga pól zapisywalnych; stany, cenniki, warianty i tłumaczenia są zabronione',
    ),
});

export type CatalogFileImportInput={xml_mapping?:z.infer<typeof catalogMappedXmlInput>};
export class MappedXmlProblem extends Error {constructor(public status:number,message:string){super(message);this.name='MappedXmlProblem';}}
export function ensure(condition:unknown,status:number,message:string):asserts condition {if(!condition)throw new MappedXmlProblem(status,message);}
