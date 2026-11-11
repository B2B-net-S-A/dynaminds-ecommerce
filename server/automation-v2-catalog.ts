/** Automation rules v2: catalog with the tenant's option lists, and the default rule set. */
import { ORDER_CATEGORIES, orderCategoryLabels, stageCategories, workflowCategory } from '../shared/order-categories';
import { workflowCategoriesAvailable, workflowStatusSelectSql } from './workflow-status-categories';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  AUTOMATION_TRIGGERS,
  DEFAULT_RUN,
  OPERATORS,
  type AutomationCatalog,
  type AutomationConfigV2,
  type CatalogEffect,
  type CatalogField,
} from '../shared/automation-v2';
import { audit, type Actor } from './domain';
import {
  EFFECT_GROUP,
  EFFECT_LABELS,
  EXTRA_FIELD_PREFIX,
  FIELD_DEFS,
  TRIGGER_GROUPS,
  UNSUPPORTED_EFFECTS,
  UNSUPPORTED_TRIGGERS,
} from './automation-v2-fields';
import { PAYMENT_LABELS, PAYMENT_METHODS } from './sales-dimensions';
import {
  FLAG_OPTIONS,
  OPERATOR_OPTIONS,
  PARCEL_SIZE_OPTIONS,
  SITE_OPTIONS,
  deliveryMethodOptions,
} from '../shared/channel-projection';
import { V2_PREFIX } from './automation-v2-triggers';
import { SHIPMENT_STATUSES, SHIPMENT_STATUS_LABELS } from '../shared/shipment-status';
import { MAX_RULES } from './automation-v2-schema';
import { EFFECT_HANDLERS, moduleCatalogParams } from './automation-v2-effects-registry';

type Option = { group?: string; value: string; label: string };

/** People's names of the fulfilment stages (web/order-status.ts) and the panel groups they belong to. */
/** Stages grouped by the fixed status categories (shared/order-categories.ts), in the panel's order. */
export const STAGE_OPTIONS: Option[] = [
  ['paid', 'Nowe'],
  ['new', 'Nieopłacone (czeka na wpłatę)'],
  ['picking', 'W kompletacji'],
  ['packed', 'Spakowane'],
  ['ready_to_ship', 'Gotowe do nadania'],
  ['shipped', 'Nadane'],
  ['delivered', 'Dostarczone'],
  ['completed', 'Zakończone'],
  ['cancelled', 'Anulowane'],
  ['return_initiated', 'Zwrot zgłoszony'],
  ['return_received', 'Zwrot przyjęty'],
  ['return_completed', 'Zwrot zakończony'],
].map(([value, label]) => ({ group: orderCategoryLabels[stageCategories[value]], value, label }));
const STAGE_LABEL = Object.fromEntries(STAGE_OPTIONS.map((o) => [o.value, o.label]));
const PAYMENT_STATES: Option[] = [
  { value: 'unpaid', label: 'Nieopłacone' },
  { value: 'partial', label: 'Częściowo' },
  { value: 'paid', label: 'Opłacone' },
  { value: 'overpaid', label: 'Nadpłata' },
  { value: 'cod', label: 'Pobranie' },
];
/** Site and delivery method lists of the channel projection (shared/channel-projection.ts), with the tenant's shops and channel methods. */
async function channelOptions(c: PoolClient) {
  const sites = await rows(
    c,
    "SELECT DISTINCT provider,settings->>'store_url' AS store,settings->>'instance_url' AS instance FROM channels WHERE provider IN ('woocommerce','shopify','prestashop','odoo','mirakl') LIMIT 200",
  );
  const shopSites: Option[] = [];
  for (const s of sites) {
    try {
      const host = new URL(String(s.store || s.instance)).hostname.toLowerCase().replace(/^www\./, '');
      if (host && !shopSites.some((o) => o.value === host)) shopSites.push({ group: 'Sklepy i operatorzy', value: host, label: host });
    } catch {
      // A channel without a valid address has no site to choose.
    }
  }
  const dims = (await rows(c, "SELECT to_regclass('public.order_sales_dimensions') IS NOT NULL ok"))[0].ok
    ? await rows(c, "SELECT DISTINCT provider,delivery_label AS label FROM order_sales_dimensions WHERE delivery_label<>'' ORDER BY 1,2 LIMIT 300")
    : [];
  return { sites: [...SITE_OPTIONS, ...shopSites], methods: deliveryMethodOptions(dims.map((d) => ({ provider: d.provider, label: d.label }))) };
}
const CARRIER_CODES = ['created', 'confirmed', 'dispatched', 'collected_from_sender', 'in_transit', 'out_for_delivery', 'ready_to_pickup', 'delivered', 'returned_to_sender', 'canceled'];
const CARRIERS = ['InPost', 'DPD Polska', 'DHL', 'Poczta Polska', 'Symulator lokalny'];

const rows = async (c: PoolClient, sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows;

export async function buildCatalog(c: PoolClient): Promise<AutomationCatalog> {
  const [workflows, channels, warehouses, tags, currencies, countries, carriers, shipStatuses, emailT, smsT, crm, fields, options, rules, members, hooks, groups] =
    await Promise.all([
      workflowCategoriesAvailable(c).then((k) => rows(c, workflowStatusSelectSql(k) + ' ORDER BY w.stage,w.name,w.id LIMIT 200')),
      rows(c, 'SELECT id,provider,name FROM channels ORDER BY provider,name,id LIMIT 200'),
      rows(c, 'SELECT id,name FROM warehouses ORDER BY name,id LIMIT 200'),
      rows(c, 'SELECT DISTINCT t FROM (SELECT unnest(tags) t FROM orders ORDER BY updated_at DESC LIMIT 5000) x ORDER BY t LIMIT 200'),
      rows(c, "SELECT DISTINCT currency v FROM orders UNION SELECT unnest(ARRAY['PLN','EUR','USD','GBP','CZK']) ORDER BY 1"),
      rows(c, "SELECT DISTINCT address->>'country' v FROM orders WHERE address->>'country' ~ '^[A-Z]{2}$' UNION SELECT 'PL' ORDER BY 1 LIMIT 100"),
      rows(c, 'SELECT DISTINCT carrier v FROM shipments ORDER BY 1 LIMIT 50'),
      rows(c, 'SELECT DISTINCT status v FROM shipments ORDER BY 1 LIMIT 50'),
      rows(c, 'SELECT id,name,active FROM email_templates ORDER BY name,id LIMIT 200'),
      rows(c, 'SELECT id,name,active FROM sms_templates ORDER BY name,id LIMIT 200'),
      c
        .query("SELECT to_regclass('public.crm_statuses') IS NOT NULL ok")
        .then(async (r) =>
          r.rows[0].ok
            ? rows(c, 'SELECT s.id,s.name,g.name AS group_name FROM crm_statuses s JOIN crm_status_groups g ON (g.tenant_id,g.id)=(s.tenant_id,s.group_id) ORDER BY g.name,s.position,s.id LIMIT 200')
            : [],
        ),
      rows(c, 'SELECT id,key,type,label,version FROM order_field_definitions WHERE enabled ORDER BY position,key LIMIT 200'),
      rows(c, 'SELECT o.id,o.field_id,o.label FROM order_field_options o JOIN order_field_definitions d ON (d.tenant_id,d.id)=(o.tenant_id,o.field_id) WHERE d.enabled AND o.enabled ORDER BY o.label LIMIT 2000'),
      rows(c, `SELECT id,name,config->>'group' AS grp FROM automation_rules WHERE trigger LIKE 'v2:%' AND NOT coalesce((config->>'deleted')::boolean,false) ORDER BY priority,id LIMIT 200`),
      rows(c, 'SELECT user_id id,name,role FROM customer_message_eligible_assignees(NULL) ORDER BY name LIMIT 200'),
      rows(c, 'SELECT id,name FROM outbound_subscriptions WHERE enabled AND revoked_at IS NULL AND approved_at IS NOT NULL ORDER BY name,id LIMIT 100'),
      rows(c, `SELECT DISTINCT config->>'group' g FROM automation_rules WHERE trigger LIKE 'v2:%' AND config->>'group' IS NOT NULL AND NOT coalesce((config->>'deleted')::boolean,false) ORDER BY 1 LIMIT 100`),
    ]);
  const channel = await channelOptions(c);
  // Custom statuses in their category (267), in category order.
  const workflowOptions = [...workflows]
    .sort((a, b) => ORDER_CATEGORIES.indexOf(workflowCategory(a)) - ORDER_CATEGORIES.indexOf(workflowCategory(b)))
    .map((w) => ({
      group: orderCategoryLabels[workflowCategory(w)],
      value: w.id,
      label: w.name + (w.active ? '' : ' (nieaktywny)'),
    }));
  const providers = [...new Set(['manual', 'demo', ...channels.map((ch) => ch.provider)])];
  const templateOptions = [
    ...emailT.map((t) => ({ group: 'E-mail', value: t.id, label: t.name })),
    ...smsT.map((t) => ({ group: 'SMS', value: t.id, label: t.name })),
  ];
  const listOptions: Record<string, Option[]> = {
    'order.status': STAGE_OPTIONS,
    'order.workflow_status': workflowOptions,
    'order.currency': currencies.map((r) => ({ value: r.v, label: r.v })),
    'order.tags': tags.map((r) => ({ value: r.t, label: r.t })),
    'order.merged_or_split': [
      { value: 'merged', label: 'Powstało z połączenia' },
      { value: 'merge_origin', label: 'Zostało dołączone do innego' },
      { value: 'split', label: 'Podzielone' },
    ],
    'source.channel': providers.map((p) => ({ value: p, label: p === 'manual' ? 'Ręczne' : p === 'demo' ? 'DEMO' : p })),
    'source.account': channels.map((ch) => ({ group: ch.provider, value: ch.id, label: ch.name })),
    'source.site': channel.sites,
    'source.flags': FLAG_OPTIONS,
    'payment.state': PAYMENT_STATES,
    'payment.method': PAYMENT_METHODS.map((m) => ({ value: m, label: PAYMENT_LABELS[m] })),
    'payment.operator': OPERATOR_OPTIONS,
    'shipping.method': channel.methods,
    'shipping.parcel_size': PARCEL_SIZE_OPTIONS,
    'shipping.carrier': [...new Set([...CARRIERS, ...carriers.map((r) => r.v)])].map((v) => ({ value: v, label: v })),
    'shipping.shipment_status': [
      ...SHIPMENT_STATUSES.map((v) => ({ group: 'Status przewoźnika', value: v as string, label: SHIPMENT_STATUS_LABELS[v] })),
      ...[...new Set([...CARRIER_CODES, ...shipStatuses.map((r) => r.v)])]
        .filter((v) => !(SHIPMENT_STATUSES as readonly string[]).includes(v))
        .map((v) => ({ group: 'Kod przewoźnika', value: v, label: v === 'canceled' ? 'canceled (etykieta anulowana)' : v })),
    ],
    'customer.crm_group': crm.map((s) => ({ group: s.group_name, value: s.id, label: s.name })),
    'address.country': countries.map((r) => ({ value: r.v, label: r.v })),
    'product.kind': [
      { value: 'simple', label: 'Prosty' },
      { value: 'variant', label: 'Wariant' },
      { value: 'bundle', label: 'Zestaw' },
      { value: 'group', label: 'Grupa' },
    ],
    'warehouse.id': warehouses.map((w) => ({ value: w.id, label: w.name })),
    'documents.kind': [
      { value: 'invoice', label: 'Faktura' },
      { value: 'correction', label: 'Korekta' },
    ],
    'history.rule_ran': rules.map((r) => ({ group: r.grp ?? 'Ogólne', value: r.id, label: r.name })),
    'history.template_sent': templateOptions,
  };
  const fieldList: Array<CatalogField & { supported?: false; unit?: 'money' }> = FIELD_DEFS.filter((f) => f.key !== 'order.extra_field').map((f) => ({
    key: f.key,
    group: f.group,
    label: f.label,
    type: f.type,
    ...(listOptions[f.key] ? { options: listOptions[f.key] } : {}),
    ...(f.per_line ? { per_line: true } : {}),
    ...(f.hint ? { hint: f.hint } : {}),
    ...(f.unit ? { unit: f.unit } : {}),
    ...(f.supported === false ? { supported: false as const } : {}),
  }));
  for (const d of fields) {
    const type = d.type === 'number' ? 'number' : d.type === 'date' ? 'date' : ['select', 'radio', 'multi_select'].includes(d.type) ? 'list' : d.type === 'file' ? 'bool' : 'text';
    fieldList.push({
      key: EXTRA_FIELD_PREFIX + d.key,
      group: 'Zamówienie',
      label: `Pole dodatkowe: ${d.label}`,
      type,
      ...(type === 'list' ? { options: options.filter((o) => o.field_id === d.id).map((o) => ({ value: o.id, label: o.label })) } : {}),
      ...(d.type === 'file' ? { hint: 'Czy dołączono plik' } : {}),
    });
  }
  const sel = (o: Option[]) => o.map(({ value, label }) => ({ value, label }));
  const templates = (list: any[]) => list.filter((t) => t.active).map((t) => ({ value: t.id, label: t.name }));
  const P: Record<string, CatalogEffect['params']> = {
    set_status: [{ key: 'status', label: 'Status', kind: 'select', options: sel(STAGE_OPTIONS.filter((o) => o.value !== 'ready_to_ship')), required: true }],
    set_workflow: [{ key: 'status_id', label: 'Własny status', kind: 'select', options: workflows.filter((w) => w.active).map((w) => ({ value: w.id, label: w.name })), required: true }],
    set_payment: [
      { key: 'state', label: 'Płatność', kind: 'select', options: [{ value: 'paid', label: 'Opłacone (zapisz brakującą wpłatę)' }], required: true },
      { key: 'method', label: 'Forma wpłaty', kind: 'select', options: [
        { value: 'bank_transfer', label: 'Przelew' }, { value: 'cash', label: 'Gotówka' }, { value: 'card', label: 'Karta' }, { value: 'other', label: 'Inna' },
      ] },
    ],
    add_tag: [{ key: 'tag', label: 'Tag', kind: 'text', required: true }],
    remove_tag: [{ key: 'tag', label: 'Tag', kind: 'select', options: sel(listOptions['order.tags']), required: true }],
    set_extra_field: [
      { key: 'field_id', label: 'Pole', kind: 'select', options: fields.filter((d) => d.type !== 'file').map((d) => ({ value: d.id, label: d.label })), required: true },
      { key: 'value', label: 'Wartość (puste = wyczyść)', kind: 'text' },
    ],
    add_note: [{ key: 'note', label: 'Notatka', kind: 'textarea', required: true }],
    assign_user: [{ key: 'user_id', label: 'Osoba', kind: 'select', options: members.map((m) => ({ value: m.id, label: m.name })), required: true }],
    set_priority: [{ key: 'priority', label: 'Priorytet', kind: 'select', options: [
      { value: 'high', label: 'Wysoki' }, { value: 'normal', label: 'Normalny' }, { value: 'low', label: 'Niski' },
    ], required: true }],
    issue_document: [{ key: 'kind', label: 'Dokument', kind: 'select', options: [{ value: 'invoice', label: 'Faktura' }], required: true }],
    send_tracking: [{ key: 'template_id', label: 'Szablon e-mail', kind: 'select', options: templates(emailT), required: true }],
    send_document: [{ key: 'template_id', label: 'Szablon e-mail', kind: 'select', options: templates(emailT), required: true }],
    email: [{ key: 'template_id', label: 'Szablon e-mail', kind: 'select', options: templates(emailT), required: true }],
    request_review: [{ key: 'template_id', label: 'Szablon e-mail', kind: 'select', options: templates(emailT), required: true }],
    sms: [{ key: 'template_id', label: 'Szablon SMS', kind: 'select', options: templates(smsT), required: true }],
    notify_team: [{ key: 'message', label: 'Treść powiadomienia', kind: 'textarea', required: true }],
    webhook: [{ key: 'subscription_id', label: 'Zatwierdzony webhook', kind: 'select', options: hooks.map((h) => ({ value: h.id, label: h.name })), required: true }],
    run_rule: [{ key: 'rule_id', label: 'Reguła', kind: 'select', options: rules.map((r) => ({ value: r.id, label: r.name })), required: true }],
  };
  Object.assign(P, await moduleCatalogParams(c));
  const effects = [...EFFECT_GROUP.entries()].map(([type, group]) => ({
    type,
    group,
    label: EFFECT_LABELS[type] ?? type,
    params: P[type] ?? [],
    ...(UNSUPPORTED_EFFECTS[type] && !EFFECT_HANDLERS[type] ? { supported: false as const, hint: UNSUPPORTED_EFFECTS[type] } : {}),
  }));
  const triggers = Object.entries(AUTOMATION_TRIGGERS).map(([key, label]) => ({
    key,
    group: TRIGGER_GROUPS[key] ?? 'Zamówienie',
    label,
    ...(UNSUPPORTED_TRIGGERS[key] ? { supported: false as const, hint: UNSUPPORTED_TRIGGERS[key] } : {}),
  }));
  return {
    fields: fieldList,
    operators: OPERATORS,
    effects,
    triggers,
    // Names of the tenant's existing rule groups ("Grupa akcji").
    groups: groups.map((g) => g.g).filter(Boolean),
  };
}

/** Editor group of the rules the system ships with. */
export const DEFAULT_GROUP = 'Domyślne';
/** Days after delivery before „Dostarczone → Zakończone” closes the order (people edit it in the rule). */
export const COMPLETE_AFTER_DAYS = 14;
/** Defaults of the first one-time seed, which recorded no keys. */
const LEGACY_DEFAULT_KEYS = ['paid_to_new', 'delivered_tracking'];
/**
 * Carrier statuses that prove the parcel left the shop: the handover and every later stage. InPost ShipX statuses are
 * stored verbatim; DPD, DHL and Poczta Polska are normalized to collected_from_sender / in_transit / out_for_delivery /
 * ready_to_pickup / delivered (server/shipment-status-labels.ts, server/base-wire-fulfillment.ts).
 */
/** Carrier groups (shared/shipment-status.ts) meaning the parcel left the sender: picked up, on its way, waiting in the point, delivered. */
const HANDED_OVER = ['picked_up', 'in_transit', 'ready_to_pickup', 'delivered'];

export type DefaultRule = { key: string; name: string; trigger: string; config: AutomationConfigV2 };

/**
 * The status model of Uwagi v3 §1 and §7 that the engine does not already enforce in code. `key` is the stable identity
 * of a default (people rename and edit the rule); ensureDefaultRulesInTx records it in the `automation.v2.defaults` audit.
 */
export function defaultRules(): DefaultRule[] {
  const base = { version: 2 as const, scope: 'orders' as const, group: DEFAULT_GROUP, stop_further: false };
  return [
    {
      // A prepaid order paid online at import, or paid later by transfer, becomes "Nowe". advancePaid already does this
      // when a payment is recorded; the rule covers orders that arrive paid, and re-checks so it never transitions twice.
      key: 'paid_to_new',
      name: 'Opłacone → Nowe',
      trigger: 'order.matches',
      config: {
        ...base,
        run: { ...DEFAULT_RUN },
        conditions: {
          match: 'all',
          items: [
            { field: 'order.status', op: 'in', value: ['new'] },
            { field: 'payment.state', op: 'in', value: ['paid', 'overpaid'] },
          ],
        },
        effects: [{ type: 'set_status', params: { status: 'paid' } }],
      },
    },
    {
      // §7: shipped from carrier data. The carrier reports the parcel on its way while the order still waits for the
      // handover ("Gotowe do nadania": packed with an undispatched label); set_status dispatches that label like "Nadaj".
      key: 'shipped_tracking',
      name: 'Nadane z danych przewoźnika',
      trigger: 'shipment.status_changed',
      config: {
        ...base,
        run: { ...DEFAULT_RUN },
        conditions: {
          match: 'all',
          items: [
            { field: 'order.status', op: 'in', value: ['ready_to_ship'] },
            { field: 'shipping.shipment_status', op: 'in', value: HANDED_OVER },
          ],
        },
        effects: [{ type: 'set_status', params: { status: 'shipped' } }],
      },
    },
    {
      // §7: delivered from carrier tracking. Tracking with "mark delivered" on already transitions; the condition
      // (still shipped) then fails, so there is no second transition.
      key: 'delivered_tracking',
      name: 'Dostarczone (śledzenie przesyłki)',
      trigger: 'shipment.status_changed',
      config: {
        ...base,
        run: { ...DEFAULT_RUN },
        conditions: {
          match: 'all',
          items: [
            { field: 'order.status', op: 'in', value: ['shipped'] },
            { field: 'shipping.shipment_status', op: 'in', value: ['delivered'] },
          ],
        },
        effects: [{ type: 'set_status', params: { status: 'delivered' } }],
      },
    },
    {
      // Closes a delivered order after the return window. The periodic time check (scheduleV2TimeChecks) re-evaluates
      // order.matches rules with relative dates; "W bieżącym statusie od" counts from the delivery.
      key: 'completed_after_delivery',
      name: `Dostarczone → Zakończone po ${COMPLETE_AFTER_DAYS} dniach`,
      trigger: 'order.matches',
      config: {
        ...base,
        run: { ...DEFAULT_RUN },
        conditions: {
          match: 'all',
          items: [
            { field: 'order.status', op: 'in', value: ['delivered'] },
            { field: 'order.time_in_status', op: 'older_than', value: { amount: COMPLETE_AFTER_DAYS, unit: 'days' } },
          ],
        },
        effects: [{ type: 'set_status', params: { status: 'completed' } }],
      },
    },
  ];
}

/**
 * Seeds each default rule the tenant has never had (admin only, within the rule limit). Idempotent: the keys given are
 * read from the `automation.v2.defaults` audit entries, so an edited, renamed, disabled or deleted default is never
 * re-created. The first seed recorded no keys: a tenant it reached (audit entry) or skipped (it already had its own v2
 * rule) counts as having LEGACY_DEFAULT_KEYS, as before.
 */
export async function ensureDefaultRulesInTx(c: PoolClient, actor: Actor): Promise<boolean> {
  if (actor.role !== 'admin') return false;
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['rules:' + actor.tenantId]);
  const s = (
    await c.query(
      `SELECT coalesce((SELECT array_agg(DISTINCT k) FROM audit_events a CROSS JOIN LATERAL jsonb_array_elements_text(
                CASE WHEN jsonb_typeof(a.detail->'keys')='array' THEN a.detail->'keys' ELSE '[]'::jsonb END) k
              WHERE a.action='automation.v2.defaults' AND a.entity_id=$1),'{}') AS keys,
              EXISTS(SELECT 1 FROM audit_events WHERE action='automation.v2.defaults' AND entity_id=$1)
                OR EXISTS(SELECT 1 FROM automation_rules WHERE trigger LIKE 'v2:%') AS legacy,
              (SELECT count(*)::int FROM automation_rules WHERE trigger LIKE 'v2:%' AND config->>'version'='2'
                AND NOT coalesce((config->>'deleted')::boolean,false)) AS live,
              (SELECT coalesce(max(priority),-1)::int FROM automation_rules WHERE trigger LIKE 'v2:%') AS top`,
      [actor.tenantId],
    )
  ).rows[0];
  const given = new Set<string>([...s.keys, ...(s.legacy ? LEGACY_DEFAULT_KEYS : [])]);
  // A default that does not fit the rule limit stays unrecorded and is seeded once there is room.
  const missing = defaultRules().filter((r) => !given.has(r.key)).slice(0, Math.max(MAX_RULES - s.live, 0));
  if (!missing.length) return false;
  for (const [i, r] of missing.entries()) {
    const id = randomUUID();
    // A new tenant gets the defaults in order, enabled; an upgrade adds them after the tenant's own rules, disabled,
    // so a firm already working never has status changes switched on behind its back (the administrator enables them).
    const enabled = !s.legacy;
    await c.query(
      "INSERT INTO automation_rules(id,tenant_id,name,trigger,action,config,enabled,priority,delay_seconds,actor_id) VALUES($1,$2,$3,$4,'actions',$5,$6,$7,0,$8)",
      [id, actor.tenantId, r.name, V2_PREFIX + r.trigger, JSON.stringify(r.config), enabled, Math.min(s.top + 1 + i, 100), actor.userId],
    );
    await audit(c, actor, 'automation.v2.version', id, { version: '1', before: null, after: { name: r.name, trigger: r.trigger, enabled, config: r.config } });
  }
  await audit(c, actor, 'automation.v2.defaults', actor.tenantId, { rules: missing.length, keys: missing.map((r) => r.key) });
  return true;
}
