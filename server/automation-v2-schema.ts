/** Automation rules v2: input validation of AutomationRuleInput (shared/automation-v2.ts). */
import { z } from 'zod';
import {
  AUTOMATION_TRIGGERS,
  OPERATORS,
  STATUS_CHANGE_STAGES,
  type AutomationRuleInput,
  type ConditionGroup,
  type ConditionLeaf,
  type ValueType,
} from '../shared/automation-v2';
import { EFFECT_GROUP, EXTRA_FIELD_PREFIX, UNSUPPORTED_EFFECTS, UNSUPPORTED_TRIGGERS, fieldMeta } from './automation-v2-fields';
import { EFFECT_HANDLERS } from './automation-v2-effects-registry';

export const MAX_RULES = 100;
export const MAX_LEAVES = 50;
export const MAX_DEPTH = 4;
export const MAX_EFFECTS = 20;

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Godzina w formacie GG:MM');
const runSettings = z.strictObject({
  auto: z.boolean(),
  delay_minutes: z.number().int().min(0).max(10080),
  mode: z.enum(['continuous', 'once']),
  hours: z
    .strictObject({
      days: z.array(z.number().int().min(1).max(7)).min(1).max(7)
        .refine((d) => new Set(d).size === d.length, 'Powtórzony dzień tygodnia'),
      from: time,
      to: time,
    })
    .refine((h) => h.from !== h.to, 'Godziny „od” i „do” muszą się różnić')
    .nullable(),
  manual_button: z.boolean(),
  barcode: z.boolean(),
});

const relative = z.strictObject({ amount: z.number().positive().max(100000), unit: z.enum(['minutes', 'hours', 'days']) });
const leaf = z.strictObject({
  field: z.string().min(3).max(120),
  op: z.string(),
  value: z.unknown().optional(),
  quantifier: z.enum(['any', 'all']).optional(),
});
type RawGroup = { match: 'all' | 'any'; negate?: boolean; items: Array<z.infer<typeof leaf> | RawGroup> };
const group: z.ZodType<RawGroup> = z.lazy(() =>
  z.strictObject({
    match: z.enum(['all', 'any']),
    negate: z.boolean().optional(),
    items: z.array(z.union([group, leaf])).max(MAX_LEAVES),
  }),
);
const effect = z.strictObject({ type: z.string().min(2).max(40), params: z.record(z.string(), z.unknown()).default({}) });

export const automationRuleV2Input = z.strictObject({
  name: z.string().trim().min(2).max(120),
  trigger: z.string().default('order.matches'),
  enabled: z.boolean().default(true),
  config: z.strictObject({
    version: z.literal(2),
    group: z.string().trim().max(60).default('Ogólne'),
    scope: z.enum(['orders', 'products']).default('orders'),
    run: runSettings,
    conditions: group,
    effects: z.array(effect).min(1, 'Dodaj co najmniej jeden efekt').max(MAX_EFFECTS),
    stop_further: z.boolean().default(false),
    status_change: z
      .strictObject({ from: z.array(z.string().min(1).max(64)).max(100), to: z.array(z.string().min(1).max(64)).max(100) })
      .optional(),
  }),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Polish message for an invalid status_change, or null. Own status ids are checked against the tenant by the route. */
export function statusChangeProblem(trigger: string, sc: { from: string[]; to: string[] } | undefined): string | null {
  if (!sc) return null;
  if (trigger !== 'order.status_changed' && (sc.from.length || sc.to.length))
    return 'Statusy „z” i „na” ustawisz tylko dla zdarzenia „Zmiana statusu zamówienia”';
  for (const v of [...sc.from, ...sc.to])
    if (!(STATUS_CHANGE_STAGES as readonly string[]).includes(v) && !UUID.test(v)) return `Nieznany status „${v}” w zmianie statusu`;
  return null;
}

const isGroup = (v: unknown): v is RawGroup => !!v && typeof v === 'object' && Array.isArray((v as RawGroup).items);
const iso = (v: unknown) => typeof v === 'string' && v.length <= 40 && !Number.isNaN(new Date(v).getTime());
const isHhmm = (v: unknown) => typeof v === 'string' && time.safeParse(v).success;

/** Polish message for an invalid value of the operator, or null when it fits. */
export function leafProblem(type: ValueType, l: ConditionLeaf): string | null {
  if (!(OPERATORS[type] as string[]).includes(l.op)) return `Operator „${l.op}” nie pasuje do pola ${l.field}`;
  const v = l.value;
  if (type === 'bool' || l.op === 'empty' || l.op === 'not_empty') return null;
  if (type === 'list')
    return Array.isArray(v) && v.length >= 1 && v.length <= 200 && v.every((x) => typeof x === 'string' && x.length <= 200)
      ? null
      : `Wybierz co najmniej jedną wartość pola ${l.field}`;
  if (type === 'text') return typeof v === 'string' && v.length <= 500 ? null : `Wpisz tekst warunku ${l.field}`;
  if (type === 'number') {
    if (l.op === 'between')
      return Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number' && Number.isFinite(x))
        ? null
        : `Podaj dwie liczby dla pola ${l.field}`;
    return typeof v === 'number' && Number.isFinite(v) ? null : `Podaj liczbę dla pola ${l.field}`;
  }
  // date
  if (l.op === 'weekday_in')
    return Array.isArray(v) && v.length >= 1 && v.every((x) => Number.isInteger(x) && (x as number) >= 1 && (x as number) <= 7)
      ? null
      : 'Wybierz dni tygodnia (1–7)';
  if (l.op === 'hour_between')
    return Array.isArray(v) && v.length === 2 && v.every(isHhmm) ? null : 'Podaj godziny GG:MM–GG:MM';
  if (l.op === 'between') return Array.isArray(v) && v.length === 2 && v.every(iso) ? null : 'Podaj dwie daty';
  if (l.op === 'within_last') return relative.safeParse(v).success ? null : 'Podaj liczbę minut, godzin lub dni';
  return iso(v) || relative.safeParse(v).success ? null : 'Podaj datę lub wiek (np. 2 dni)';
}

export interface ValidatedRule extends AutomationRuleInput {}

/**
 * Parses and checks a rule. `extraTypes` are the tenant's order fields (order.extra_field.<key>).
 * Throws a ZodError-like Problem through the caller's ensure.
 */
export function parseRuleV2(raw: unknown, extraTypes: Record<string, ValueType>): { rule?: ValidatedRule; error?: string } {
  const parsed = automationRuleV2Input.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { error: `Nieprawidłowa reguła (${first.path.join('.') || 'treść'}): ${first.message}` };
  }
  const r = parsed.data;
  if (!(r.trigger in AUTOMATION_TRIGGERS)) return { error: `Nieznany wyzwalacz ${r.trigger}` };
  if (UNSUPPORTED_TRIGGERS[r.trigger]) return { error: `Wyzwalacz niedostępny: ${UNSUPPORTED_TRIGGERS[r.trigger]}` };
  if (r.config.scope !== 'orders') return { error: 'Reguły produktów ustawisz w module „Reguły produktów”' };
  const sc = statusChangeProblem(r.trigger, r.config.status_change);
  if (sc) return { error: sc };
  let leaves = 0;
  const walk = (g: RawGroup, depth: number): string | null => {
    if (depth > MAX_DEPTH) return `Najwyżej ${MAX_DEPTH} poziomy zagnieżdżenia grup`;
    for (const item of g.items) {
      if (isGroup(item)) {
        const e = walk(item, depth + 1);
        if (e) return e;
        continue;
      }
      leaves++;
      const l = item as ConditionLeaf;
      const meta = fieldMeta(l.field);
      const type = meta?.type ?? (l.field.startsWith(EXTRA_FIELD_PREFIX) ? extraTypes[l.field] : undefined);
      if (!type) return `Nieznane pole warunku ${l.field}`;
      if (meta?.supported === false) return `Pole ${meta.label} jest niedostępne`;
      if (l.quantifier && !meta?.per_line) return `Kwantyfikator „każdy/dowolny” dotyczy tylko pól produktów`;
      const e = leafProblem(type, l);
      if (e) return e;
    }
    return null;
  };
  const e = walk(r.config.conditions, 1);
  if (e) return { error: e };
  if (leaves > MAX_LEAVES) return { error: `Reguła może mieć najwyżej ${MAX_LEAVES} warunków` };
  for (const ef of r.config.effects) {
    if (!EFFECT_GROUP.has(ef.type)) return { error: `Nieznany efekt ${ef.type}` };
    if (UNSUPPORTED_EFFECTS[ef.type] && !EFFECT_HANDLERS[ef.type]) return { error: `Efekt niedostępny: ${UNSUPPORTED_EFFECTS[ef.type]}` };
  }
  if (!r.config.run.auto && !r.config.run.manual_button && !r.config.run.barcode)
    return { error: 'Włącz uruchamianie automatyczne, przycisk lub kod kreskowy' };
  // An empty status filter means "any": stored without it, like a rule written before the filter existed.
  const { status_change, ...config } = r.config;
  const keep = status_change && (status_change.from.length || status_change.to.length) ? { status_change } : {};
  return { rule: { ...r, config: { ...config, ...keep, conditions: r.config.conditions as ConditionGroup } } };
}
