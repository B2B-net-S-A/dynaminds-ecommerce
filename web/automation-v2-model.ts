// Pure editor logic for automation rules v2 (Uwagi v3 §0). No React, no HTTP: the editor and tests share it.
import {
  AUTOMATION_TRIGGERS,
  CONDITION_FIELD_KEYS,
  DEFAULT_RUN,
  OPERATORS,
  OPERATOR_LABELS,
  type AutomationCatalog,
  type AutomationRuleInput,
  type AutomationRuleV2,
  type AutomationRunSummary,
  type CatalogEffect,
  type CatalogField,
  type ConditionGroup,
  type ConditionLeaf,
  type ConditionValue,
  type EffectSpec,
  type Operator,
  type ValueType,
} from '../shared/automation-v2';

export type ConditionNode = ConditionLeaf | ConditionGroup;
export type Path = number[];
/** Optional server flag: a catalog entry the engine cannot evaluate yet is shown disabled. */
export type Supportable = { supported?: boolean };
export type FieldMap = ReadonlyMap<string, CatalogField>;

export const FIELD_GROUPS: readonly string[] = Object.keys(CONDITION_FIELD_KEYS);
export const WEEKDAYS = ['Pn', 'Wt', 'Śr', 'Cz', 'Pt', 'So', 'Nd'] as const;
const MONEY_FIELDS = new Set([
  'order.total', 'order.total_without_shipping', 'payment.paid_amount', 'payment.due_amount', 'shipping.cost',
  'product.price',
]);
const UNIT_LABELS = { minutes: 'min', hours: 'godz.', days: 'dni' } as const;

export const isGroup = (n: ConditionNode): n is ConditionGroup => 'items' in n;
export const isSupported = (x: unknown): boolean => (x as Supportable | undefined)?.supported !== false;
export const newGroup = (): ConditionGroup => ({ match: 'all', items: [] });
export const fieldMap = (catalog: Pick<AutomationCatalog, 'fields'>): FieldMap =>
  new Map(catalog.fields.map((f) => [f.key, f]));

// ---------- condition tree (immutable, addressed by index paths) ----------
export function getAt(root: ConditionGroup, path: Path): ConditionNode | undefined {
  let node: ConditionNode | undefined = root;
  for (const i of path) node = node && isGroup(node) ? node.items[i] : undefined;
  return node;
}

export function updateAt(root: ConditionGroup, path: Path, fn: (n: ConditionNode) => ConditionNode): ConditionGroup {
  if (!path.length) {
    const next = fn(root);
    if (!isGroup(next)) throw new Error('Korzeń warunków musi być grupą');
    return next;
  }
  const [head, ...rest] = path;
  const child = root.items[head];
  if (!child) throw new Error('Nie ma warunku pod wskazaną ścieżką');
  const replaced = rest.length ? (isGroup(child) ? updateAt(child, rest, fn) : child) : fn(child);
  return { ...root, items: root.items.map((n, i) => (i === head ? replaced : n)) };
}

export function removeAt(root: ConditionGroup, path: Path): ConditionGroup {
  if (!path.length) throw new Error('Nie można usunąć korzenia warunków');
  const parent = path.slice(0, -1),
    index = path[path.length - 1];
  return updateAt(root, parent, (g) => (isGroup(g) ? { ...g, items: g.items.filter((_, i) => i !== index) } : g));
}

export function appendAt(root: ConditionGroup, groupPath: Path, node: ConditionNode): ConditionGroup {
  return updateAt(root, groupPath, (g) => {
    if (!isGroup(g)) throw new Error('Warunek można dodać tylko do grupy');
    return { ...g, items: [...g.items, node] };
  });
}

export function setMatch(root: ConditionGroup, groupPath: Path, match: 'all' | 'any'): ConditionGroup {
  return updateAt(root, groupPath, (g) => (isGroup(g) ? { ...g, match } : g));
}

export function toggleNegate(root: ConditionGroup, groupPath: Path): ConditionGroup {
  return updateAt(root, groupPath, (g) => {
    if (!isGroup(g)) return g;
    const { negate, ...rest } = g;
    return negate ? rest : { ...rest, negate: true };
  });
}

export function countLeaves(node: ConditionNode): number {
  return isGroup(node) ? node.items.reduce((s, n) => s + countLeaves(n), 0) : 1;
}

export function pruneEmptyGroups(root: ConditionGroup): ConditionGroup {
  const items = root.items.flatMap((n): ConditionNode[] => {
    if (!isGroup(n)) return [n];
    const pruned = pruneEmptyGroups(n);
    return pruned.items.length ? [pruned] : [];
  });
  return { ...root, items };
}

// ---------- leaves: operators and value shapes ----------
export type ValueShape = 'none' | 'list' | 'text' | 'number' | 'range' | 'moment' | 'date_range' | 'relative' | 'weekdays' | 'hours';

export function valueShape(type: ValueType, op: Operator): ValueShape {
  if (type === 'bool' || op === 'empty' || op === 'not_empty') return 'none';
  if (type === 'list') return 'list';
  if (type === 'text') return 'text';
  if (type === 'number') return op === 'between' ? 'range' : 'number';
  if (op === 'between') return 'date_range';
  if (op === 'within_last') return 'relative';
  if (op === 'weekday_in') return 'weekdays';
  if (op === 'hour_between') return 'hours';
  return 'moment';
}

function defaultFor(shape: ValueShape): ConditionValue | undefined {
  switch (shape) {
    case 'none': return undefined;
    case 'list': return [];
    case 'text': return '';
    case 'number': return null;
    case 'range': return null;
    case 'moment':
    case 'relative': return { amount: 1, unit: 'days' };
    case 'date_range': return ['', ''];
    case 'weekdays': return [];
    case 'hours': return ['08:00', '16:00'];
  }
}

const isRelative = (v: unknown): v is { amount: number; unit: 'minutes' | 'hours' | 'days' } =>
  !!v && typeof v === 'object' && !Array.isArray(v) && 'amount' in v && 'unit' in v;

function leafWith(leaf: ConditionLeaf, op: Operator, value: ConditionValue | undefined): ConditionLeaf {
  const { value: _drop, ...rest } = leaf;
  return value === undefined ? { ...rest, op } : { ...rest, op, value };
}

export function newLeaf(field: CatalogField): ConditionLeaf {
  const op = OPERATORS[field.type][0];
  const base = leafWith({ field: field.key, op }, op, defaultFor(valueShape(field.type, op)));
  return field.per_line ? { ...base, quantifier: 'any' } : base;
}

/** Switch operator, keeping the value when its shape still fits. Throws for an operator foreign to the type. */
export function withOperator(leaf: ConditionLeaf, field: CatalogField, op: Operator): ConditionLeaf {
  if (!OPERATORS[field.type].includes(op)) throw new Error('Operator „' + OPERATOR_LABELS[op] + '” nie pasuje do pola');
  const from = valueShape(field.type, leaf.op),
    to = valueShape(field.type, op),
    v = leaf.value;
  if (from === to) return leafWith(leaf, op, v);
  if (from === 'number' && to === 'range' && typeof v === 'number') return leafWith(leaf, op, [v, v]);
  if (from === 'range' && to === 'number' && Array.isArray(v)) return leafWith(leaf, op, (v[0] as number) ?? null);
  if ((from === 'moment' || from === 'relative') && (to === 'moment' || to === 'relative') && isRelative(v))
    return leafWith(leaf, op, v);
  return leafWith(leaf, op, defaultFor(to));
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const validDate = (s: unknown) => typeof s === 'string' && s !== '' && !Number.isNaN(Date.parse(s));
const RANGE_ORDER = 'Wartość „od” musi być mniejsza lub równa „do”';

export function validateLeaf(leaf: ConditionLeaf, field: CatalogField | undefined): string | null {
  if (!field) return 'Nieznane pole warunku: ' + leaf.field;
  if (!isSupported(field)) return 'Pole „' + field.label + '” jest jeszcze nieobsługiwane przez silnik';
  if (!OPERATORS[field.type].includes(leaf.op)) return 'Operator „' + (OPERATOR_LABELS[leaf.op] ?? leaf.op) + '” nie pasuje do pola';
  const v = leaf.value;
  switch (valueShape(field.type, leaf.op)) {
    case 'none': return null;
    case 'list': {
      if (!Array.isArray(v) || !v.length) return 'Zaznacz co najmniej jedną opcję';
      const known = new Set((field.options ?? []).map((o) => o.value));
      const unknown = (v as unknown[]).filter((x) => typeof x !== 'string' || (field.options && !known.has(x)));
      return unknown.length ? 'Nieznana opcja: ' + unknown.join(', ') : null;
    }
    case 'text': return typeof v === 'string' && v.trim() ? null : 'Wpisz wartość';
    case 'number': return typeof v === 'number' && Number.isFinite(v) ? null : 'Podaj liczbę';
    case 'range':
      if (!Array.isArray(v) || v.length !== 2 || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) return 'Podaj liczby od i do';
      return (v[0] as number) <= (v[1] as number) ? null : RANGE_ORDER;
    case 'moment':
      if (isRelative(v)) return v.amount > 0 && Number.isInteger(v.amount) ? null : 'Okres musi być większy od zera';
      return validDate(v) ? null : 'Podaj datę albo okres';
    case 'relative':
      if (!isRelative(v)) return 'Podaj okres (minuty, godziny lub dni)';
      return v.amount > 0 && Number.isInteger(v.amount) ? null : 'Okres musi być większy od zera';
    case 'date_range':
      if (!Array.isArray(v) || v.length !== 2 || !v.every(validDate)) return 'Podaj datę od i do';
      return Date.parse(v[0] as string) <= Date.parse(v[1] as string) ? null : RANGE_ORDER;
    case 'weekdays':
      if (!Array.isArray(v) || !v.length) return 'Wybierz co najmniej jeden dzień tygodnia';
      return (v as unknown[]).every((d) => Number.isInteger(d) && (d as number) >= 1 && (d as number) <= 7) ? null : 'Nieprawidłowy dzień tygodnia';
    case 'hours':
      return Array.isArray(v) && v.length === 2 && v.every((h) => typeof h === 'string' && HHMM.test(h)) ? null : 'Podaj godziny w formacie GG:MM';
  }
}

export function validateConditions(root: ConditionGroup, fields: FieldMap, base: Path = []): Array<{ path: Path; message: string }> {
  return root.items.flatMap((n, i) => {
    const path = [...base, i];
    if (isGroup(n)) return validateConditions(n, fields, path);
    const message = validateLeaf(n, fields.get(n.field));
    return message ? [{ path, message }] : [];
  });
}

// ---------- effects ----------
export function newEffect(effect: CatalogEffect): EffectSpec {
  const params: Record<string, unknown> = {};
  for (const p of effect.params) {
    if (p.kind === 'bool') params[p.key] = false;
    else if (p.kind === 'multiselect') params[p.key] = [];
  }
  return { type: effect.type, params };
}

export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (from < 0 || to < 0 || from >= list.length || to >= list.length || from === to) return [...list];
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export function validateEffect(spec: EffectSpec, effect: CatalogEffect | undefined): string | null {
  if (!effect) return 'Nieznany efekt: ' + spec.type;
  if (!isSupported(effect)) return 'Efekt „' + effect.label + '” jest jeszcze nieobsługiwany';
  for (const p of effect.params) {
    const v = spec.params[p.key];
    const empty = v === undefined || v === null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length);
    if (empty) {
      if (p.required) return 'Uzupełnij: ' + p.label;
      continue;
    }
    if ((p.kind === 'number' || p.kind === 'money') && !(typeof v === 'number' && Number.isFinite(v))) return p.label + ': podaj liczbę';
    if (p.kind === 'select' && p.options && !p.options.some((o) => o.value === v)) return p.label + ': wybierz wartość z listy';
    if (p.kind === 'multiselect' && p.options && Array.isArray(v) && !v.every((x) => p.options!.some((o) => o.value === x)))
      return p.label + ': wybierz wartości z listy';
    if (p.kind === 'date' && !validDate(v)) return p.label + ': podaj datę';
  }
  return null;
}

// ---------- rule drafts ----------
export interface RuleDraft extends AutomationRuleInput {
  id?: string;
  version?: number;
  barcode?: string | null;
}

export function emptyDraft(scope: 'orders' | 'products', group = ''): RuleDraft {
  return {
    name: '',
    trigger: 'order.matches',
    enabled: true,
    config: {
      version: 2,
      group,
      scope,
      run: { ...DEFAULT_RUN },
      conditions: { match: 'all', items: [] },
      effects: [],
      stop_further: false,
    },
  };
}

export function draftFromRule(rule: AutomationRuleV2): RuleDraft {
  const { id, version, barcode, name, trigger, enabled, config } = structuredClone(rule);
  return { id, version, barcode, name, trigger, enabled, config: { ...emptyDraft(config.scope).config, ...config, run: { ...DEFAULT_RUN, ...config.run } } };
}

/** Body for POST/PUT: trimmed, empty nested groups removed, undefined params dropped. */
export function toRuleInput(draft: RuleDraft): AutomationRuleInput {
  const { config } = draft;
  const hours = config.run.hours
    ? { ...config.run.hours, days: [...new Set(config.run.hours.days)].sort((a, b) => a - b) }
    : null;
  const clean = JSON.parse(
    JSON.stringify({
      ...config,
      group: config.group.trim(),
      run: { ...config.run, delay_minutes: Math.max(0, Math.floor(config.run.delay_minutes || 0)), hours },
      conditions: pruneEmptyGroups(config.conditions),
    }),
  );
  // The status filter belongs to 'order.status_changed'; an empty one means any status and is not sent.
  const sc = clean.status_change;
  if (draft.trigger !== 'order.status_changed' || !sc || (!sc.from?.length && !sc.to?.length)) delete clean.status_change;
  return { name: draft.name.trim(), trigger: draft.trigger, enabled: draft.enabled, config: clean };
}

export function validateDraft(draft: RuleDraft, catalog: AutomationCatalog): string[] {
  const errors: string[] = [];
  const name = draft.name.trim();
  if (name.length < 2 || name.length > 120) errors.push('Podaj nazwę reguły (2–120 znaków)');
  if (draft.trigger !== 'order.matches' && !catalog.triggers.some((t) => t.key === draft.trigger) && !(draft.trigger in AUTOMATION_TRIGGERS))
    errors.push('Nieznane zdarzenie uruchamiające');
  const { run } = draft.config;
  if (!Number.isFinite(run.delay_minutes) || run.delay_minutes < 0) errors.push('Opóźnienie musi być liczbą minut ≥ 0');
  if (run.hours) {
    if (!run.hours.days.length) errors.push('Godziny pracy: wybierz co najmniej jeden dzień');
    if (!HHMM.test(run.hours.from) || !HHMM.test(run.hours.to)) errors.push('Godziny pracy: podaj godziny w formacie GG:MM');
    else if (run.hours.from === run.hours.to) errors.push('Godziny pracy: godzina „od” i „do” nie mogą być równe');
  }
  const fields = fieldMap(catalog);
  for (const e of validateConditions(draft.config.conditions, fields))
    errors.push('Warunek ' + e.path.map((i) => i + 1).join('.') + ': ' + e.message);
  if (!draft.config.effects.length) errors.push('Dodaj co najmniej jeden efekt');
  draft.config.effects.forEach((spec, i) => {
    const msg = validateEffect(spec, catalog.effects.find((e) => e.type === spec.type));
    if (msg) errors.push('Efekt ' + (i + 1) + ': ' + msg);
  });
  return errors;
}

// ---------- search ----------
export function normalizeSearch(s: string): string {
  return s.toLowerCase().replace(/ł/g, 'l').normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

export function groupedSearch<T>(
  items: readonly T[],
  query: string,
  text: (t: T) => string,
  group: (t: T) => string,
  order: readonly string[],
): Array<{ group: string; items: T[] }> {
  const q = normalizeSearch(query).split(/\s+/).filter(Boolean);
  const byGroup = new Map<string, T[]>();
  for (const item of items) {
    const hay = normalizeSearch(text(item));
    if (!q.every((w) => hay.includes(w))) continue;
    const g = group(item);
    byGroup.set(g, [...(byGroup.get(g) ?? []), item]);
  }
  const rank = (g: string) => (order.includes(g) ? order.indexOf(g) : order.length);
  return [...byGroup.entries()]
    .map(([g, list], i) => ({ group: g, items: list, i }))
    .sort((a, b) => rank(a.group) - rank(b.group) || a.i - b.i)
    .map(({ group: g, items: list }) => ({ group: g, items: list }));
}

// ---------- money ----------
export const isMoneyField = (field: CatalogField | undefined): boolean =>
  !!field && (MONEY_FIELDS.has(field.key) || (field as CatalogField & { unit?: string }).unit === 'money');

export function zlToGrosze(s: string): number | null {
  const t = s.replace(/zł|\s/gi, '').replace(',', '.');
  if (!/^-?\d+(\.\d{0,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

export function groszeToZl(n: number | null | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '';
  return (n / 100).toFixed(2).replace('.', ',');
}

// ---------- descriptions ----------
function formatNumber(n: unknown, field: CatalogField | undefined): string {
  if (typeof n !== 'number') return '?';
  if (isMoneyField(field)) return groszeToZl(n) + ' zł';
  return field?.key === 'order.weight' ? n + ' g' : String(n);
}

const formatDate = (s: unknown) => (validDate(s) ? new Date(s as string).toLocaleString('pl-PL', { dateStyle: 'short', timeStyle: 'short' }) : '?');

export function weekdaysLabel(days: readonly number[]): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  const contiguous = sorted.length > 2 && sorted.every((d, i) => i === 0 || d === sorted[i - 1] + 1);
  if (contiguous) return WEEKDAYS[sorted[0] - 1] + '–' + WEEKDAYS[sorted[sorted.length - 1] - 1];
  return sorted.map((d) => WEEKDAYS[d - 1] ?? '?').join(', ');
}

export function describeValue(leaf: ConditionLeaf, field: CatalogField | undefined): string {
  const v = leaf.value;
  switch (field ? valueShape(field.type, leaf.op) : 'text') {
    case 'none': return '';
    case 'list': return (Array.isArray(v) ? (v as string[]) : []).map((x) => field?.options?.find((o) => o.value === x)?.label ?? x).join(', ');
    case 'number': return formatNumber(v, field);
    case 'range': return Array.isArray(v) ? formatNumber(v[0], field) + ' – ' + formatNumber(v[1], field) : '?';
    case 'moment':
    case 'relative': return isRelative(v) ? v.amount + ' ' + UNIT_LABELS[v.unit] : formatDate(v);
    case 'date_range': return Array.isArray(v) ? formatDate(v[0]) + ' – ' + formatDate(v[1]) : '?';
    case 'weekdays': return weekdaysLabel(Array.isArray(v) ? (v as number[]) : []);
    case 'hours': return Array.isArray(v) ? v.join('–') : '?';
    default: return String(v ?? '');
  }
}

export function describeLeaf(leaf: ConditionLeaf, fields: FieldMap): string {
  const field = fields.get(leaf.field),
    label = field?.label ?? leaf.field,
    op = OPERATOR_LABELS[leaf.op] ?? leaf.op,
    all = leaf.quantifier === 'all' ? ' (wszystkie produkty)' : '';
  if (field?.type === 'bool') return label + ': ' + op + all;
  const value = describeValue(leaf, field);
  if (!value) return label + ' ' + op + all;
  return label + ' ' + op + (field?.type === 'list' ? ': ' : ' ') + value + all;
}

export function describeTree(root: ConditionGroup, fields: FieldMap): string {
  if (!root.items.length) return 'Bez warunków';
  const inner = (g: ConditionGroup): string =>
    g.items
      .map((n) => (isGroup(n) ? (n.negate ? 'NIE ' : '') + '(' + inner(n) + ')' : describeLeaf(n, fields)))
      .join(g.match === 'all' ? ' i ' : ' lub ');
  return root.negate ? 'NIE (' + inner(root) + ')' : inner(root);
}

export function describeEffect(spec: EffectSpec, catalog: Pick<AutomationCatalog, 'effects'>): string {
  const effect = catalog.effects.find((e) => e.type === spec.type);
  if (!effect) return spec.type;
  const values = effect.params.flatMap((p) => {
    const v = spec.params[p.key];
    if (v === undefined || v === null || v === '' || v === false || (Array.isArray(v) && !v.length)) return [];
    if (p.kind === 'bool') return [p.label];
    if (p.kind === 'money') return [groszeToZl(v as number) + ' zł'];
    const label = (x: unknown) => p.options?.find((o) => o.value === x)?.label ?? String(x);
    return [Array.isArray(v) ? v.map(label).join(', ') : label(v)];
  });
  return values.length ? effect.label + ': ' + values.join(', ') : effect.label;
}

export function triggerLabel(key: string, catalog: Pick<AutomationCatalog, 'triggers'>): string {
  return catalog.triggers.find((t) => t.key === key)?.label ?? AUTOMATION_TRIGGERS[key] ?? key;
}

export function runSummary(rule: AutomationRuleInput, catalog: Pick<AutomationCatalog, 'triggers'>): string {
  const run = rule.config.run,
    parts = [triggerLabel(rule.trigger, catalog)];
  if (run.auto) {
    let auto = 'samoczynnie' + (run.delay_minutes > 0 ? ' po ' + run.delay_minutes + ' min' : '');
    auto += ', ' + (run.mode === 'once' ? 'jednorazowo' : 'ciągle');
    if (run.hours) auto += ', ' + weekdaysLabel(run.hours.days) + ' ' + run.hours.from + '–' + run.hours.to;
    parts.push(auto);
  } else parts.push('bez uruchamiania samoczynnego');
  if (run.manual_button) parts.push('przycisk ręczny');
  if (run.barcode) parts.push('kod kreskowy');
  return parts.join(' · ');
}

export function groupRules<T extends AutomationRuleInput>(rules: readonly T[]): Array<{ group: string; rules: T[] }> {
  const groups = new Map<string, T[]>();
  for (const r of rules) {
    const g = r.config.group?.trim() || 'Bez grupy';
    groups.set(g, [...(groups.get(g) ?? []), r]);
  }
  return [...groups.entries()].map(([group, list]) => ({ group, rules: list }));
}

export function moveRuleId(ids: readonly string[], id: string, targetId: string, place: 'before' | 'after'): string[] {
  if (id === targetId || !ids.includes(id) || !ids.includes(targetId)) return [...ids];
  const rest = ids.filter((x) => x !== id);
  const at = rest.indexOf(targetId) + (place === 'after' ? 1 : 0);
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

// ---------- version log ----------
export interface VersionDiff {
  created: boolean;
  deleted: boolean;
  conditionsAdded: string[];
  conditionsRemoved: string[];
  effectsAdded: string[];
  effectsRemoved: string[];
  other: string[];
}

function leaves(root: ConditionGroup | undefined): ConditionLeaf[] {
  return root ? root.items.flatMap((n) => (isGroup(n) ? leaves(n) : [n])) : [];
}

function multisetDiff(a: string[], b: string[]): string[] {
  const left = [...a];
  return b.filter((x) => {
    const i = left.indexOf(x);
    if (i < 0) return true;
    left.splice(i, 1);
    return false;
  });
}

export function versionDiff(
  before: AutomationRuleInput | null,
  after: AutomationRuleInput | null,
  catalog: AutomationCatalog,
): VersionDiff {
  const fields = fieldMap(catalog);
  const conds = (r: AutomationRuleInput | null) => leaves(r?.config.conditions).map((l) => describeLeaf(l, fields));
  const effs = (r: AutomationRuleInput | null) => (r?.config.effects ?? []).map((e) => describeEffect(e, catalog));
  const other: string[] = [];
  if (before && after) {
    const yes = (b: boolean) => (b ? 'tak' : 'nie');
    const cmp = (label: string, a: string, b: string) => a !== b && other.push(label + ': ' + a + ' → ' + b);
    cmp('Nazwa', before.name, after.name);
    cmp('Aktywna', yes(before.enabled), yes(after.enabled));
    cmp('Grupa', before.config.group || '—', after.config.group || '—');
    cmp('Uruchamianie', runSummary(before, catalog), runSummary(after, catalog));
    cmp('Logika warunków', logicLabel(before), logicLabel(after));
    cmp('Nie sprawdzaj kolejnych', yes(before.config.stop_further), yes(after.config.stop_further));
    if (JSON.stringify(effs(before)) !== JSON.stringify(effs(after)) && multisetDiff(effs(before), effs(after)).length === 0 && multisetDiff(effs(after), effs(before)).length === 0)
      other.push('Zmieniono kolejność efektów');
  }
  return {
    created: !before && !!after,
    deleted: !!before && !after,
    conditionsAdded: multisetDiff(conds(before), conds(after)),
    conditionsRemoved: multisetDiff(conds(after), conds(before)),
    effectsAdded: multisetDiff(effs(before), effs(after)),
    effectsRemoved: multisetDiff(effs(after), effs(before)),
    other,
  };
}

function logicLabel(r: AutomationRuleInput): string {
  const c = r.config.conditions;
  return (c.negate ? 'NIE ' : '') + (c.match === 'all' ? 'wszystkie (I)' : 'dowolny (LUB)');
}

// ---------- manual runs ----------
export function runResultText(ruleName: string, runs: readonly AutomationRunSummary[]): { text: string; error: boolean } {
  const head = '„' + ruleName + '”: ';
  if (!runs.length) return { text: head + 'brak zamówień do uruchomienia', error: true };
  const of = (s: AutomationRunSummary['status']) => runs.filter((r) => r.status === s);
  const done = of('done').length,
    queued = of('queued').length,
    skipped = of('skipped'),
    failed = of('failed'),
    parts: string[] = [];
  const detail = (r: AutomationRunSummary, text: string | null) =>
    ' (' + (r.order_number ? r.order_number + ': ' : '') + (text ?? 'bez szczegółów') + ')';
  if (done) parts.push('wykonano ' + done);
  if (queued) parts.push('w kolejce ' + queued);
  if (skipped.length) parts.push('pominięto ' + skipped.length + detail(skipped[0], skipped[0].reason));
  if (failed.length) parts.push('błąd ' + failed.length + detail(failed[0], failed[0].error));
  return { text: head + parts.join(', '), error: failed.length > 0 };
}
