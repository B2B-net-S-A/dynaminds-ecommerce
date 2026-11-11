import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ensure } from './errors';
import {
  assertCatalogImportJson,
  parseCatalogCsvRecords,
  parseNativeCatalogXmlRecords,
} from './catalog-file-import-parse';
import {
  productTranslationLocale,
  productTranslationTexts,
} from './product-translation-bulk-edit-schema';
import {
  LANGUAGE_FILE_IMPORT_LIMITS as L,
  languageFileImportDefinition,
  type LanguageFileImportDefinition,
  type LanguageFileImportCell,
  type LanguageFileImportPatch,
  type LanguageFileImportRow,
  type ParsedLanguageFile,
} from './language-file-import-schema';

const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const nativeEntry = z.strictObject({
  locale: productTranslationLocale,
  name: z.string(),
  description: z.string(),
  version: z.number().int().positive().max(2147483647).optional(),
});
type Language = LanguageFileImportDefinition['languages'][number];

/** Identity fields have an exact one-prefix inverse in explicit safe mode.
 * Text encoding is noninjective: literal apostrophes can collide with exporter
 * prefixes. Preserve them with an issue unless an explicit policy decides.
 * Importing catalog-export itself would pull in database/service dependencies.
 */
function safeText(
  value: string,
  field: 'id' | 'sku' | 'ean' | 'name' | 'description',
  d: LanguageFileImportDefinition,
  issues: string[],
) {
  if (!d.spreadsheet_safe || !value.startsWith("'")) return value;
  const original = value.slice(1);
  if (original && ['id', 'sku', 'ean'].includes(field)) return original;
  if (
    original &&
    (/^[\s]*[=+\-@]/u.test(original) ||
      /^[\t\r\n]/u.test(original) ||
      /^[\s]*[+-]?\d+(?:[.,]\d+)?(?:[eE][+-]?\d+)?[\s]*$/u.test(original))
  ) {
    if (d.spreadsheet_text_prefix === 'decode_export') return original;
    if (d.spreadsheet_text_prefix === 'reject_ambiguous')
      issues.push(
        `${field}: niejednoznaczny prefiks arkusza; wybierz decode_export albo preserve_literal`,
      );
  }
  return value;
}

function readIdentity(
  record: Record<string, unknown>,
  d: LanguageFileImportDefinition,
  issues: string[],
) {
  const value = record[d.mapping.identity];
  if (typeof value !== 'string') {
    issues.push('Identyfikator wymaga pola tekstowego');
    return null;
  }
  const field = d.identity === 'uuid' ? 'id' : d.identity === 'historical_sku' ? 'sku' : d.identity;
  const decoded = safeText(value, field, d, issues);
  if (!decoded.trim()) {
    issues.push('Brak identyfikatora produktu');
    return null;
  }
  if (d.identity === 'uuid') {
    const parsed = z.uuid().safeParse(decoded);
    if (!parsed.success) {
      issues.push('Niepoprawny UUID produktu');
      return null;
    }
    return parsed.data.toLowerCase();
  }
  if ([...decoded].length > 200) {
    issues.push('Identyfikator przekracza 200 znaków Unicode');
    return null;
  }
  return decoded;
}

function validatePatch(patch: LanguageFileImportPatch, issues: string[]) {
  for (const field of ['name', 'description'] as const) {
    if (patch[field] === undefined) continue;
    const parsed = productTranslationTexts.shape[field].safeParse(patch[field]);
    if (!parsed.success) issues.push(...parsed.error.issues.map((i) => `${field}: ${i.message}`));
  }
}

function columnCell(
  record: Record<string, unknown>,
  l: Language,
  d: LanguageFileImportDefinition,
): LanguageFileImportCell {
  const issues: string[] = [];
  const patch: LanguageFileImportPatch = {};
  const mapping = l.mapping!;
  const op = mapping.operation === undefined ? '' : record[mapping.operation];
  if (op !== '' && op !== 'none' && op !== 'set' && op !== 'remove') {
    issues.push('Operacja wymaga set, remove lub none');
    return { locale: l.locale, operation: 'none', issues };
  }
  // An explicit no-op ignores all text values, including ambiguous prefixes.
  if (op === 'none') return { locale: l.locale, operation: 'none', issues };
  for (const field of ['name', 'description'] as const) {
    const source = mapping[field];
    if (source === undefined) continue;
    const value = record[source];
    if (typeof value !== 'string') {
      issues.push(`${field}: wymagane pole tekstowe`);
      continue;
    }
    const decoded = safeText(value, field, d, issues);
    if (decoded !== '' || (field === 'description' && l.empty_description === 'clear'))
      patch[field] = decoded;
  }
  if (op === 'remove') {
    for (const field of ['name', 'description'] as const) {
      const source = mapping[field];
      if (source !== undefined && record[source] !== '')
        issues.push(`remove nie przyjmuje niepustego pola ${field}`);
    }
    return { locale: l.locale, operation: 'remove', issues };
  }
  if (Object.keys(patch).length === 0) {
    if (op === 'set') issues.push('Jawne set wymaga niepustego patch');
    return { locale: l.locale, operation: 'none', issues };
  }
  validatePatch(patch, issues);
  return { locale: l.locale, operation: 'set', patch, issues };
}

function nativeCells(record: Record<string, unknown>, d: LanguageFileImportDefinition) {
  const issues: string[] = [];
  let value = record[d.mapping.translations_json!];
  if (d.format === 'csv') {
    try {
      if (typeof value !== 'string') throw new Error();
      value = JSON.parse(value);
      assertCatalogImportJson(value);
    } catch {
      issues.push('translations_json wymaga poprawnej tablicy JSON');
      value = null;
    }
  }
  const entries: Array<z.infer<typeof nativeEntry>> = [];
  if (!Array.isArray(value)) {
    if (!issues.length)
      issues.push('translations_json wymaga tablicy; null lub brak pola jest błędem');
  } else if (value.length > L.source_locales_per_product) {
    issues.push(`translations_json przekracza ${L.source_locales_per_product} języków produktu`);
  } else {
    const locales = new Set<string>();
    value.forEach((entry, index) => {
      const parsed = nativeEntry.safeParse(entry);
      if (!parsed.success) {
        issues.push(
          `translations_json[${index}]: niepoprawny obiekt locale/name/description/version`,
        );
        return;
      }
      if (locales.has(parsed.data.locale))
        issues.push(`translations_json[${index}]: powtórzony język po normalizacji`);
      locales.add(parsed.data.locale);
      const textIssues: string[] = [];
      validatePatch(
        {
          ...(parsed.data.name === '' ? {} : { name: parsed.data.name }),
          description: parsed.data.description,
        },
        textIssues,
      );
      issues.push(...textIssues.map((i) => `translations_json[${index}]: ${i}`));
      entries.push(parsed.data);
    });
  }
  // A malformed array never exposes a partially applicable subset of its entries.
  if (issues.length)
    return {
      issues,
      cells: d.languages.map((l): LanguageFileImportCell => ({
        locale: l.locale,
        operation: 'none',
        issues: ['Niepoprawne źródło języków; brak częściowego zastosowania'],
      })),
      skipped_locales: [] as string[],
      source_translation_versions: {} as Record<string, number | null>,
    };
  const selected = new Set(d.languages.map((l) => l.locale));
  const byLocale = new Map(entries.map((e) => [e.locale, e]));
  const cells = d.languages.map((l): LanguageFileImportCell => {
    const entry = byLocale.get(l.locale);
    if (!entry) return { locale: l.locale, operation: 'none', issues: [] };
    const patch: LanguageFileImportPatch = {};
    if (entry.name !== '') patch.name = entry.name;
    if (entry.description !== '' || l.empty_description === 'clear')
      patch.description = entry.description;
    return Object.keys(patch).length
      ? { locale: l.locale, operation: 'set', patch, issues: [] }
      : { locale: l.locale, operation: 'none', issues: [] };
  });
  return {
    issues,
    cells,
    skipped_locales: entries
      .map((e) => e.locale)
      .filter((l) => !selected.has(l))
      .sort(),
    source_translation_versions: Object.fromEntries(
      entries.map((e) => [e.locale, e.version ?? null]),
    ),
  };
}

/** Pure parsing only: does not resolve products, read CAS, create previews or mutate DB. */
export function parseLanguageFile(
  content: string,
  definition: LanguageFileImportDefinition,
): ParsedLanguageFile {
  const d = languageFileImportDefinition.parse(definition);
  ensure(Buffer.byteLength(content, 'utf8') <= L.file_bytes, 413, 'Plik przekracza 2 MiB');
  assertCatalogImportJson(content);
  const source_hash = createHash('sha256').update(content, 'utf8').digest('hex');
  const interpreted = content.replace(/^\ufeff/, '');
  let records: Array<{ raw: Record<string, unknown>; issues: string[] }>;
  if (d.format === 'xml') {
    records = parseNativeCatalogXmlRecords(interpreted).rows.map((raw) => ({ raw, issues: [] }));
  } else {
    const [headers, ...data] = parseCatalogCsvRecords(interpreted, d.delimiter);
    ensure(
      headers?.length &&
        headers.every((h) => h.trim() && !forbidden.has(h)) &&
        new Set(headers.map((h) => h.toLowerCase())).size === headers.length,
      422,
      'Niepoprawne lub powtórzone nagłówki CSV',
    );
    const required = [
      d.mapping.identity,
      ...(d.mode === 'translations_json'
        ? [d.mapping.translations_json!]
        : d.languages.flatMap((l) =>
            Object.values(l.mapping!).filter((v): v is string => typeof v === 'string'),
          )),
    ];
    ensure(
      required.every((h) => headers.includes(h)),
      422,
      'Brak mapowanego nagłówka CSV',
    );
    records = data.map((row) => ({
      raw: Object.fromEntries(headers.map((h, i) => [h, row[i]])),
      issues: row.length === headers.length ? [] : ['Liczba pól CSV nie odpowiada nagłówkom'],
    }));
  }
  ensure(
    records.length >= 1 && records.length <= L.products,
    422,
    'Plik wymaga od 1 do 500 produktów',
  );
  const rows: LanguageFileImportRow[] = records.map(({ raw, issues }, index) => {
    const identity = readIdentity(raw, d, issues);
    if (d.mode === 'translations_json') {
      const parsed = nativeCells(raw, d);
      return {
        row_number: index + 1,
        identity,
        raw_cells: raw,
        ...parsed,
        issues: [...issues, ...parsed.issues],
      };
    }
    return {
      row_number: index + 1,
      identity,
      raw_cells: raw,
      cells: d.languages.map((l) => columnCell(raw, l, d)),
      issues,
      skipped_locales: [],
      source_translation_versions: {},
    };
  });
  const sourceIdentities = new Map<string, LanguageFileImportRow[]>();
  for (const row of rows) {
    if (row.identity === null) continue;
    const group = sourceIdentities.get(row.identity) ?? [];
    group.push(row);
    sourceIdentities.set(row.identity, group);
  }
  for (const group of sourceIdentities.values())
    if (group.length > 1)
      for (const row of group) row.issues.push('Powtórzony identyfikator źródłowy');
  return { source_hash, rows };
}
