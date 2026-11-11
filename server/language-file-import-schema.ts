import { z } from 'zod';
import { productTranslationLocale } from './product-translation-bulk-edit-schema';

/** Parser contract only; these limits do not attest an implemented import service. */
export const LANGUAGE_FILE_IMPORT_LIMITS = {
  products: 500,
  locales: 6,
  pairs: 3000,
  page: 50,
  file_bytes: 2097152,
  request_bytes: 3145728,
  preview_bytes: 33554432,
  history_bytes: 268435456,
  history_per_tenant: 2000,
  profiles: 100,
  source_locales_per_product: 100,
  xml_nodes: 100000,
  xml_depth: 16,
  name_chars: 200,
  description_chars: 10000,
  response_bytes: 5242880,
} as const;

const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const column = z
  .string()
  .refine(
    (v) =>
      v.trim().length > 0 &&
      [...v].length <= 200 &&
      !v.includes('\0') &&
      Buffer.from(v, 'utf8').toString('utf8') === v &&
      !forbidden.has(v),
    'Niepoprawna nazwa mapowanego pola',
  );
const language = z.strictObject({
  locale: productTranslationLocale,
  mapping: z
    .strictObject({
      name: column.optional(),
      description: column.optional(),
      operation: column.optional(),
    })
    .optional(),
  empty_name: z.literal('preserve').default('preserve'),
  empty_description: z.enum(['preserve', 'clear']).default('preserve'),
});

export const languageFileImportDefinition = z
  .strictObject({
    format: z.enum(['csv', 'xml']),
    mode: z.enum(['columns', 'translations_json']),
    delimiter: z.enum([';', ',', '\t', '|']).default(';'),
    spreadsheet_safe: z.boolean().default(false),
    spreadsheet_text_prefix: z
      .enum(['reject_ambiguous', 'decode_export', 'preserve_literal'])
      .default('reject_ambiguous'),
    identity: z.enum(['uuid', 'sku', 'historical_sku', 'ean', 'name']),
    mapping: z.strictObject({
      identity: column,
      translations_json: column.optional(),
    }),
    languages: z.array(language).min(1).max(LANGUAGE_FILE_IMPORT_LIMITS.locales),
  })
  .superRefine((b, ctx) => {
    const issue = (path: Array<string | number>, message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    if (new Set(b.languages.map((l) => l.locale)).size !== b.languages.length)
      issue(['languages'], 'Powtórzony język po normalizacji');
    if (b.mode === 'columns') {
      if (b.format !== 'csv') issue(['format'], 'Mapowane kolumny wymagają CSV');
      if (b.mapping.translations_json !== undefined)
        issue(['mapping', 'translations_json'], 'Kolumny nie przyjmują translations_json');
      b.languages.forEach((l, i) => {
        if (!l.mapping || !Object.values(l.mapping).some((v) => typeof v === 'string'))
          issue(['languages', i, 'mapping'], 'Wybierz co najmniej jedno pole języka');
      });
    } else {
      if (b.mapping.translations_json === undefined)
        issue(['mapping', 'translations_json'], 'Wymagane pole translations_json');
      b.languages.forEach((l, i) => {
        if (l.mapping !== undefined)
          issue(['languages', i, 'mapping'], 'Tablica języków nie przyjmuje mapowania kolumn');
      });
    }
    if (b.format === 'xml') {
      if (b.delimiter !== ';') issue(['delimiter'], 'XML wymaga kanonicznego separatora ;');
      if (b.spreadsheet_safe) issue(['spreadsheet_safe'], 'XML nie ma prefiksów arkusza');
      const identityField = {
        uuid: 'id',
        sku: 'sku',
        historical_sku: 'sku',
        ean: 'ean',
        name: 'name',
      }[b.identity];
      if (b.mapping.identity !== identityField)
        issue(['mapping', 'identity'], 'XML wymaga natywnego pola identyfikatora');
      if (b.mapping.translations_json !== 'translations_json')
        issue(['mapping', 'translations_json'], 'XML wymaga natywnego translations_json');
    }
  })
  .transform((b) => ({
    ...b,
    languages: [...b.languages].sort((a, c) =>
      a.locale < c.locale ? -1 : a.locale > c.locale ? 1 : 0,
    ),
  }));

export type LanguageFileImportDefinition = z.infer<typeof languageFileImportDefinition>;
export type LanguageFileImportPatch = { name?: string; description?: string };
export type LanguageFileImportCell = {
  locale: string;
  operation: 'set' | 'remove' | 'none';
  patch?: LanguageFileImportPatch;
  issues: string[];
};
export type LanguageFileImportRow = {
  /** Logical data-record ordinal, starting at one; CSV header is excluded. */
  row_number: number;
  identity: string | null;
  raw_cells: Record<string, unknown>;
  cells: LanguageFileImportCell[];
  issues: string[];
  skipped_locales: string[];
  /** Historical source metadata only; never the current translation CAS. */
  source_translation_versions: Record<string, number | null>;
};
export type ParsedLanguageFile = {
  source_hash: string;
  rows: LanguageFileImportRow[];
};

const importId = z.uuid().transform((v) => v.toLowerCase());
const importVersion = z.number().int().positive().max(2147483647);
const importText = (max: number) =>
  z
    .string()
    .transform((v) => v.trim())
    .refine(
      (v) =>
        v.trim().length > 0 &&
        [...v].length <= max &&
        !v.includes('\0') &&
        Buffer.from(v, 'utf8').toString('utf8') === v,
      'Wymagany poprawny niepusty tekst Unicode',
    );
export const languageFileImportPreviewInput = z.strictObject({
  client_key: importId,
  content: z
    .string()
    .refine(
      (v) => Buffer.byteLength(v, 'utf8') <= LANGUAGE_FILE_IMPORT_LIMITS.file_bytes,
      'Plik przekracza 2 MiB',
    ),
  definition: languageFileImportDefinition,
  profile: z.strictObject({ id: importId, version: importVersion }).optional(),
});
export const languageFileImportExecuteInput = z.strictObject({
  client_key: importId,
  scope_hash: z.string().regex(/^[a-f0-9]{64}$/),
  confirmed: z.literal(true),
  ack_missing_locale_codes: z
    .array(productTranslationLocale)
    .max(LANGUAGE_FILE_IMPORT_LIMITS.locales)
    .default([])
    .refine((v) => new Set(v).size === v.length, 'Powtórzone potwierdzenie języka')
    .transform((v) => [...v].sort()),
});
export const languageFileImportProfileInput = z.strictObject({
  client_key: importId,
  name: importText(120),
  definition: languageFileImportDefinition,
});
export const languageFileImportProfileUpdateInput = languageFileImportProfileInput.extend({
  version: importVersion,
  archived: z.boolean(),
});
export const languageFileImportOptionsQuery = z.strictObject({
  cursor: productTranslationLocale.optional(),
});
export const languageFileImportPageQuery = z.strictObject({
  cursor: z.string().min(1).max(400).optional(),
});
export const languageFileImportRowsQuery = z.strictObject({
  cursor: z
    .string()
    .regex(/^(0|[1-9][0-9]{0,3})$/)
    .refine((v) => Number(v) < 3000)
    .optional(),
});
export type LanguageFileImportActor =
  import('./product-translation-bulk-edit').ProductTranslationBulkEditActor;
export type LanguageFileImportInput = z.infer<typeof languageFileImportPreviewInput>;
export type LanguageFileImportExecuteInput = z.infer<typeof languageFileImportExecuteInput>;
export type LanguageFileImportSummary = {
  source_rows: number;
  product_count: number;
  total_pairs: number;
  changed_pairs: number;
  unchanged_pairs: number;
  skipped_pairs: number;
  changed_products: number;
  invalid: number;
  conflicts: number;
  missing_after_count: number;
  skipped_locale_entries: number;
  ready: boolean;
};
export type LanguageFileImportLocaleSummary = LanguageFileImportSummary & { locale: string };
export type LanguageFileImportFileRow = {
  index: number;
  source_index: number;
  locale: string;
  raw_cells: Record<string, unknown>;
  resolution: {
    identity: LanguageFileImportDefinition['identity'];
    value: string | null;
    matched_historical_sku: boolean;
  };
  product_id: string | null;
  sku: string | null;
  kind: string | null;
  product_name: string | null;
  product_version: number | null;
  input: import('./product-translation-bulk-edit-schema').ProductTranslationBulkEditRow | null;
  before: import('./product-translation-bulk-edit').TranslationSnapshot | null;
  after: import('./product-translation-bulk-edit').TranslationSnapshot | null;
  status: 'changed' | 'unchanged' | 'invalid' | 'conflict';
  skip_reason: string | null;
  errors: string[];
  core_index: number | null;
  receipt_id: string | null;
  source_translation_version: number | null;
  skipped_locales: string[];
};
export type LanguageFileImportExecutionRow = LanguageFileImportFileRow & {
  core_receipt_id: string;
  before_product_version: number;
  after_product_version: number;
};
export type LanguageFileImportProfile = {
  id: string;
  version: number;
  name: string;
  definition: LanguageFileImportDefinition;
  archived: boolean;
  created_at: string;
  updated_at: string;
};
export type LanguageFileImportPreviewHead = {
  id: string;
  created_at: string;
  source_hash: string;
  scope_hash: string;
  definition: LanguageFileImportDefinition;
  profile_snapshot: Pick<LanguageFileImportProfile, 'id' | 'version' | 'name'> | null;
  summary: LanguageFileImportSummary;
  per_locale: LanguageFileImportLocaleSummary[];
  core_preview_id: string | null;
  executed_execution_id: string | null;
  can_execute: boolean;
};
export type LanguageFileImportExecutionHead = LanguageFileImportPreviewHead & {
  preview_id: string;
  core_execution_id: string;
  state: 'done';
  ack_missing_locale_codes: string[];
};
