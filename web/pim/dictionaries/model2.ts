/** Pure SOURCE_MODEL_ONLY. No app/db/network/IAM or active PIM endpoint. */
import { z } from 'zod';
import { PIM_LIMITS, type Category, type Definition, type ProductRow, type Value, type RowError } from './contract';

export class PimValidationError extends Error {
  constructor(readonly errors: RowError[]) { super('Invalid typed PIM input'); }
}
const fail = (code: string, field: string, row = 0, definition_id: string | null = null): never => {
  throw new PimValidationError([{ row, field, code, definition_id }]);
};
const uuid = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const unsigned = z.string().regex(/^(0|[1-9][0-9]{0,18})$/).refine(v => /^(0|[1-9][0-9]{0,18})$/.test(v) && BigInt(v) <= 9223372036854775807n);
const version = unsigned.refine(v => v !== '0');
const utf8 = (v: string) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v);
const label = z.string().min(2).max(120).refine(v => v === v.trim() && !/[\u0000-\u001f\u007f]/.test(v) && utf8(v));
const unit = z.string().min(1).max(32).refine(v => v === v.trim() && !/[\u0000-\u001f\u007f]/.test(v) && utf8(v));
const decimalShape = z.strictObject({ kind: z.literal('decimal'), scale: z.number().int().min(0).max(6), unit: unit.nullable(), minimum: z.string().max(26).nullable(), maximum: z.string().max(26).nullable() });
const definitionShape = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text'), max_length: z.number().int().min(1).max(500) }),
  decimalShape, z.strictObject({ kind: z.literal('boolean') }),
  z.strictObject({ kind: z.literal('enum'), options: z.array(z.strictObject({ id: uuid, label, active: z.boolean() })).min(1).max(PIM_LIMITS.options_per_enum) }),
]);
const definition = z.strictObject({ id: uuid, version, name: label, active: z.boolean(), shape: definitionShape });
const binding = z.strictObject({ definition_id: uuid, required: z.boolean() });
const category = z.strictObject({ id: uuid, version, parent_id: uuid.nullable(), name: label, active: z.boolean(), bindings: z.array(binding).max(PIM_LIMITS.bindings_per_category) });
const dictionaryInput = z.strictObject({ categories: z.array(category).max(PIM_LIMITS.categories), definitions: z.array(definition).max(PIM_LIMITS.definitions) });
const value = z.discriminatedUnion('kind', [
  z.strictObject({ definition_id: uuid, kind: z.literal('text'), value: z.string().max(500) }),
  z.strictObject({ definition_id: uuid, kind: z.literal('decimal'), value: z.string().max(26) }),
  z.strictObject({ definition_id: uuid, kind: z.literal('boolean'), value: z.boolean() }),
  z.strictObject({ definition_id: uuid, kind: z.literal('enum'), option_id: uuid }),
]);
const productRow = z.strictObject({ product_id: uuid, product_version: version, state_version: unsigned, source_hash: hash, category_id: uuid.nullable(), values: z.array(value).max(PIM_LIMITS.values_per_product) });
export type DictionaryData = { categories: Category[]; definitions: Definition[] };
export type ResolvedBinding = { definition_id: string; required: boolean; inherited_from: string[] };
function parse<T>(schema: z.ZodType<T>, raw: unknown, field: string, row = 0): T {
  const result = schema.safeParse(raw);
  if (!result.success) return fail('shape', field, row);
  return result.data;
}
function unique(ids: string[], field: string) {
  if (new Set(ids).size !== ids.length) fail('duplicate_id', field);
}
/** Exact fixed-scale decimal -> integer coefficient. No floats, rounding, unit conversion or exponent. */
export function decimalCoefficient(raw: unknown, scale: number): bigint {
  if (!Number.isSafeInteger(scale) || scale < 0 || scale > 6 || typeof raw !== 'string') return fail('decimal_codec', 'value');
  const re = new RegExp(`^-?(0|[1-9][0-9]{0,17})${scale === 0 ? '' : `\\.[0-9]{${scale}}`}$`);
  if (!re.test(raw)) return fail('decimal_codec', 'value');
  const coefficient = BigInt(raw.replace('.', ''));
  if (raw.startsWith('-') && coefficient === 0n) return fail('negative_zero', 'value');
  return coefficient;
}
function checkDecimalDefinition(d: Definition) {
  if (d.shape.kind !== 'decimal') return;
  const s = d.shape;
  const min = s.minimum === null ? null : decimalCoefficient(s.minimum, s.scale);
  const max = s.maximum === null ? null : decimalCoefficient(s.maximum, s.scale);
  if (min !== null && max !== null && min > max) fail('decimal_bounds', 'definitions', 0, d.id);
}
/** Detached canonical output. The function proves shape/tree only, never catalog ownership or authority. */
export function validateDictionary(raw: unknown): DictionaryData {
  const d = parse(dictionaryInput, raw, 'dictionary');
  unique(d.categories.map(c => c.id), 'categories'); unique(d.definitions.map(x => x.id), 'definitions');
  const definitions = new Map(d.definitions.map(x => [x.id, x]));
  let options = 0;
  for (const def of d.definitions) {
    checkDecimalDefinition(def);
    if (def.shape.kind === 'enum') { unique(def.shape.options.map(x => x.id), 'options'); options += def.shape.options.length; def.shape.options.sort((a, b) => a.id.localeCompare(b.id)); }
  }
  if (options > PIM_LIMITS.options_total) fail('dictionary_budget', 'options');
  const categories = new Map(d.categories.map(c => [c.id, c]));
  for (const c of d.categories) {
    unique(c.bindings.map(b => b.definition_id), 'bindings');
    for (const b of c.bindings) { const def = definitions.get(b.definition_id); if (!def || (c.active && !def.active)) fail('unknown_or_inactive_definition', 'bindings', 0, b.definition_id); }
    let current: Category | undefined = c; const seen = new Set<string>();
    while (current) {
      if (seen.has(current.id)) fail('category_cycle', 'parent_id');
      seen.add(current.id); if (seen.size > PIM_LIMITS.category_depth) fail('category_depth', 'parent_id');
      if (c.active && !current.active) fail('inactive_ancestor', 'parent_id');
      if (current.parent_id === null) break;
      current = categories.get(current.parent_id); if (!current) fail('unknown_parent', 'parent_id');
    }
    c.bindings.sort((a, b) => a.definition_id.localeCompare(b.definition_id));
  }
  d.categories.sort((a, b) => a.id.localeCompare(b.id)); d.definitions.sort((a, b) => a.id.localeCompare(b.id));
  for (const c of d.categories) if (c.active) resolveValidated(d, c.id);
  if (new TextEncoder().encode(JSON.stringify(d)).byteLength > PIM_LIMITS.response_bytes) fail('dictionary_budget', 'dictionary');
  return d;
}
function resolveValidated(d: DictionaryData, categoryId: string): ResolvedBinding[] {
  const cats = new Map(d.categories.map(c => [c.id, c]));
  let c = cats.get(categoryId); if (!c || !c.active) return fail('unknown_or_inactive_category', 'category_id');
  const out = new Map<string, ResolvedBinding>();
  while (c) {
    for (const b of c.bindings) { const old = out.get(b.definition_id); out.set(b.definition_id, { definition_id: b.definition_id, required: b.required || Boolean(old?.required), inherited_from: [...(old?.inherited_from ?? []), c.id] }); }
    c = c.parent_id === null ? undefined : cats.get(c.parent_id);
  }
  if (out.size > PIM_LIMITS.values_per_product) fail('effective_binding_budget', 'bindings');
  return [...out.values()].map(b => ({ ...b, inherited_from: b.inherited_from.sort() })).sort((a, b) => a.definition_id.localeCompare(b.definition_id));
}
export function resolveBindings(rawDictionary: unknown, categoryId: string): ResolvedBinding[] { return resolveValidated(validateDictionary(rawDictionary), parse(uuid, categoryId, 'category_id')); }
function validateRow<T extends {category_id: string | null; values: Value[]}>(d: DictionaryData, row: T): T {
  unique(row.values.map(v => v.definition_id), 'values');
  if (row.category_id === null) { if (row.values.length) fail('values_without_category', 'values'); return row; }
  const bound = new Map(resolveValidated(d, row.category_id).map(b => [b.definition_id, b]));
  const defs = new Map(d.definitions.map(x => [x.id, x]));
  for (const v of row.values) {
    const def = defs.get(v.definition_id);
    if (!bound.has(v.definition_id) || !def || !def.active) return fail('unbound_definition', 'values', 0, v.definition_id);
    if (def.shape.kind !== v.kind) fail('wrong_type', 'values', 0, v.definition_id);
    if (v.kind === 'text' && def.shape.kind === 'text') {
      if (v.value.length > def.shape.max_length || !utf8(v.value) || /[\u0000-\u001f\u007f]/.test(v.value)) fail('text_value', 'values', 0, v.definition_id);
      if (bound.get(v.definition_id)!.required && !v.value.trim()) fail('required', 'values', 0, v.definition_id);
    }
    if (v.kind === 'decimal' && def.shape.kind === 'decimal') {
      const n = decimalCoefficient(v.value, def.shape.scale), s = def.shape;
      if ((s.minimum !== null && n < decimalCoefficient(s.minimum, s.scale)) || (s.maximum !== null && n > decimalCoefficient(s.maximum, s.scale))) fail('decimal_bounds', 'values', 0, v.definition_id);
    }
    if (v.kind === 'enum' && def.shape.kind === 'enum' && !def.shape.options.some(o => o.id === v.option_id && o.active)) fail('unknown_or_inactive_option', 'values', 0, v.definition_id);
  }
  const ids = new Set(row.values.map(v => v.definition_id));
  for (const b of bound.values()) if (b.required && !ids.has(b.definition_id)) fail('required', 'values', 0, b.definition_id);
  row.values.sort((a, b) => a.definition_id.localeCompare(b.definition_id)); return row;
}
/** Full-file validation: any invalid row returns errors and NO partially accepted rows. */
export function validateProductBatch(rawDictionary: unknown, rawRows: unknown): { ready: true; rows: ProductRow[]; errors: [] } | { ready: false; rows: []; errors: RowError[] } {
  const d = validateDictionary(rawDictionary);
  if (!Array.isArray(rawRows) || rawRows.length < 1 || rawRows.length > PIM_LIMITS.product_rows) return fail('batch_budget', 'rows');
  let encoded: string; try { encoded = JSON.stringify(rawRows); } catch { return fail('shape', 'rows'); }
  if (new TextEncoder().encode(encoded).byteLength > PIM_LIMITS.request_bytes) fail('batch_budget', 'rows');
  const errors: RowError[] = [], rows: ProductRow[] = [], seen = new Set<string>();
  rawRows.forEach((raw, index) => {
    try { const row = parse(productRow, raw, 'row', index); if (seen.has(row.product_id)) fail('duplicate_product', 'product_id'); seen.add(row.product_id); rows.push(validateRow(d, row)); }
    catch (e) { if (!(e instanceof PimValidationError)) throw e; errors.push(...e.errors.map(x => ({ ...x, row: index }))); }
  });
  return errors.length ? { ready: false, rows: [], errors } : { ready: true, rows, errors: [] };
}
/** Immutable type/scale/unit policy. Usage must come from a future native locked producer, not caller authority. */
export function validateDefinitionTransition(before: Definition, after: Definition, usedOptions: readonly string[], used: boolean): Definition {
  const a = parse(definition, before, 'before'), b = parse(definition, after, 'after'); checkDecimalDefinition(a); checkDecimalDefinition(b);
  if (a.id !== b.id || a.shape.kind !== b.shape.kind) fail('immutable_definition_type', 'shape');
  if (a.shape.kind === 'decimal' && b.shape.kind === 'decimal' && (a.shape.scale !== b.shape.scale || a.shape.unit !== b.shape.unit)) fail('immutable_decimal_codec', 'shape');
  if (used && !b.active) fail('definition_in_use', 'active');
  if (a.shape.kind === 'enum' && b.shape.kind === 'enum') {
    unique(b.shape.options.map(x => x.id), 'options');
    for (const id of usedOptions) if (!b.shape.options.some(x => x.id === id && x.active)) fail('option_in_use', 'options');
  }
  return b;
}
export type LegacyRule =
  | { definition_id: string; legacy_key: string; kind: 'text' }
  | { definition_id: string; legacy_key: string; kind: 'decimal' }
  | { definition_id: string; legacy_key: string; kind: 'boolean'; tokens: Array<{ text: string; value: boolean }> }
  | { definition_id: string; legacy_key: string; kind: 'enum'; tokens: Array<{ text: string; option_id: string }> };
const legacyRule = z.discriminatedUnion('kind', [
  z.strictObject({ definition_id: uuid, legacy_key: z.string().min(1).max(80), kind: z.literal('text') }),
  z.strictObject({ definition_id: uuid, legacy_key: z.string().min(1).max(80), kind: z.literal('decimal') }),
  z.strictObject({ definition_id: uuid, legacy_key: z.string().min(1).max(80), kind: z.literal('boolean'), tokens: z.array(z.strictObject({ text: z.string().max(500), value: z.boolean() })).min(1).max(200) }),
  z.strictObject({ definition_id: uuid, legacy_key: z.string().min(1).max(80), kind: z.literal('enum'), tokens: z.array(z.strictObject({ text: z.string().max(500), option_id: uuid })).min(1).max(200) }),
]);
/** Explicit source-key/token mapping only. Returns every unmapped source key; preserves original bytes. */
export function mapLegacyAttributes(rawDictionary: unknown, source: { category: string; attributes: Record<string, string> }, categoryId: string, rules: LegacyRule[]): { category_id: string; values: Value[]; unmapped_keys: string[]; original: typeof source } {
  // Zod records discard this own key; reject BEFORE parsing rather than silently rewriting legacy evidence.
  if (source && typeof source === 'object' && source.attributes && typeof source.attributes === 'object' && Object.hasOwn(source.attributes, '__proto__')) return fail('unsupported_legacy_key', 'legacy.attributes');
  const legacy = parse(z.strictObject({ category: z.string().max(80), attributes: z.record(z.string().min(1).max(80), z.string().max(500)).refine(x => Object.keys(x).length <= 50) }), source, 'legacy');
  rules = parse(z.array(legacyRule).max(50), rules, 'rules');
  unique(rules.map(r => r.definition_id), 'rules'); unique(rules.map(r => r.legacy_key), 'rules');
  const values: Value[] = rules.map(rule => {
    if (!Object.hasOwn(legacy.attributes, rule.legacy_key)) return fail('missing_legacy_key', 'rules', 0, rule.definition_id);
    const text = legacy.attributes[rule.legacy_key]!;
    if (rule.kind === 'text' || rule.kind === 'decimal') return { definition_id: rule.definition_id, kind: rule.kind, value: text };
    if (!Array.isArray(rule.tokens)) return fail('explicit_token_map_required', 'rules');
    unique(rule.tokens.map(t => t.text), 'tokens');
    const token = rule.tokens.find(t => t.text === text); if (!token) return fail('unmapped_legacy_token', 'rules', 0, rule.definition_id);
    return rule.kind === 'boolean' ? { definition_id: rule.definition_id, kind: 'boolean', value: (token as { value: boolean }).value } : { definition_id: rule.definition_id, kind: 'enum', option_id: (token as { option_id: string }).option_id };
  });
  const d = validateDictionary(rawDictionary);
  const row = parse(z.strictObject({ category_id: uuid, values: z.array(value).max(50) }), { category_id: categoryId, values }, 'mapping');
  validateRow(d, row);
  return { category_id: categoryId, values: row.values, unmapped_keys: Object.keys(legacy.attributes).filter(k => !rules.some(r => r.legacy_key === k)).sort(), original: legacy };
}
