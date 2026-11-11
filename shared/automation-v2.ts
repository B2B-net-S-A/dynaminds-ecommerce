/**
 * Automation rules v2 (Uwagi v3 §0): Conditions → Effects, Sellasist-style. Contract shared by the server
 * engine (server/automation-v2*.ts) and the editor (web/automation-v2*.tsx).
 *
 * Storage: an ordinary automation_rules row (trigger text, config jsonb, priority, delay_seconds, enabled),
 * so no migration is needed. A v2 rule has config.version === 2. Legacy v1 rules keep working unchanged.
 *
 * HTTP API (all under /api/automations/v2, JSON, writes by the administrator or "Automatyzacje: edycja" (267), tenant-scoped):
 *   GET    /catalog                 -> AutomationCatalog (fields with option lists, operators, effects, triggers)
 *   GET    /rules                   -> { data: AutomationRuleV2[] } ordered by priority, id
 *   POST   /rules                   body AutomationRuleInput -> AutomationRuleV2
 *   PUT    /rules/:id               body AutomationRuleInput & { version } -> AutomationRuleV2 (409 on stale version)
 *   POST   /rules/:id/copy          -> AutomationRuleV2 ("Zapisz jako nowy")
 *   DELETE /rules/:id               -> 204
 *   PATCH  /rules/order             body { ids: string[] } -> 204 (order = priority)
 *   POST   /rules/:id/preview       -> { matching: number, sample: {id,number}[] } over current orders
 *   POST   /rules/:id/test          body { order_id } -> AutomationTestResult (no effects applied)
 *   POST   /rules/:id/run           body { order_ids: string[] } -> { runs: AutomationRunSummary[] } (manual button)
 *   GET    /rules/:id/versions      -> { data: AutomationRuleVersion[] } (who, when, before/after config)
 *   GET    /runs?rule_id=&order_id= -> { data: AutomationRunSummary[] } (run log with errors)
 *   GET    /manual?order_id=        -> { data: {id,name,group}[] } rules with run.manual_button for the card/list
 *   POST   /barcode                 body { code, order } (order = id or number) -> AutomationRunSummary
 */

export type ValueType = 'list' | 'text' | 'number' | 'date' | 'bool';

export type Operator =
  | 'in'
  | 'not_in'
  | 'eq'
  | 'neq'
  | 'contains'
  | 'not_contains'
  | 'starts_with'
  | 'ends_with'
  | 'empty'
  | 'not_empty'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'between'
  | 'newer_than'
  | 'older_than'
  | 'within_last'
  | 'weekday_in'
  | 'hour_between'
  | 'is_true'
  | 'is_false';

export const OPERATORS: Record<ValueType, Operator[]> = {
  list: ['in', 'not_in'],
  text: ['eq', 'neq', 'contains', 'not_contains', 'starts_with', 'ends_with', 'empty', 'not_empty'],
  number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between'],
  date: ['newer_than', 'older_than', 'between', 'within_last', 'weekday_in', 'hour_between'],
  bool: ['is_true', 'is_false'],
};

export const OPERATOR_LABELS: Record<Operator, string> = {
  in: 'jest jednym z',
  not_in: 'nie jest żadnym z',
  eq: 'równa się',
  neq: 'różne od',
  contains: 'zawiera',
  not_contains: 'nie zawiera',
  starts_with: 'zaczyna się od',
  ends_with: 'kończy się na',
  empty: 'puste',
  not_empty: 'niepuste',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  between: 'pomiędzy',
  newer_than: 'jest nowsza niż',
  older_than: 'jest starsza niż',
  within_last: 'w ciągu ostatnich',
  weekday_in: 'dzień tygodnia',
  hour_between: 'godzina pomiędzy',
  is_true: 'tak',
  is_false: 'nie',
};

/**
 * Condition value by type:
 * - list: string[] (option values from the catalog)
 * - text: string
 * - number: number, or [from, to] for between (money in grosze, weight in grams)
 * - date: ISO string (newer/older), [iso, iso] (between), { amount, unit: 'minutes'|'hours'|'days' } (within_last,
 *   and also allowed for newer_than/older_than as a relative age), number[] 1-7 (weekday_in, Monday = 1),
 *   ['HH:MM', 'HH:MM'] (hour_between)
 * - bool: no value
 */
export type ConditionValue =
  | string
  | number
  | string[]
  | number[]
  | [number, number]
  | { amount: number; unit: 'minutes' | 'hours' | 'days' }
  | null;

export interface ConditionLeaf {
  field: string;
  op: Operator;
  value?: ConditionValue;
  /** Product conditions only: any line (default) or all lines must match. */
  quantifier?: 'any' | 'all';
}

export interface ConditionGroup {
  match: 'all' | 'any';
  negate?: boolean;
  items: Array<ConditionLeaf | ConditionGroup>;
}

export interface EffectSpec {
  type: string;
  params: Record<string, unknown>;
}

export interface RunSettings {
  /** Automatic run when the order meets the conditions (trigger 'order.matches') or on the chosen event. */
  auto: boolean;
  delay_minutes: number;
  /** continuous: every time the order newly meets the conditions; once: at most once per order. */
  mode: 'continuous' | 'once';
  /** null = always. Days 1-7 (Monday = 1), Europe/Warsaw time. Outside the window the run waits for the next opening. */
  hours: { days: number[]; from: string; to: string } | null;
  manual_button: boolean;
  barcode: boolean;
}

export interface AutomationConfigV2 {
  version: 2;
  group: string;
  scope: 'orders' | 'products';
  run: RunSettings;
  conditions: ConditionGroup;
  effects: EffectSpec[];
  /** "Nie sprawdzaj kolejnych": after this rule runs for an order, lower-priority rules skip that event. */
  stop_further: boolean;
  /**
   * Trigger 'order.status_changed' only: the previous ("z") and new ("na") status. Values are fulfilment stage
   * codes (STATUS_CHANGE_STAGES) or own status ids (workflow_statuses). Missing or empty list = any status.
   */
  status_change?: { from: string[]; to: string[] };
}

export interface AutomationRuleInput {
  name: string;
  /** 'order.matches' (default mode, "gdy spełni warunki") or one of AUTOMATION_TRIGGERS keys. */
  trigger: string;
  enabled: boolean;
  config: AutomationConfigV2;
}

export interface AutomationRuleV2 extends AutomationRuleInput {
  id: string;
  priority: number;
  version: number;
  updated_at: string;
  /** Printable code that runs this rule when scanned with an order (present when run.barcode). */
  barcode: string | null;
}

export interface AutomationRuleVersion {
  version: number;
  actor: string;
  at: string;
  before: AutomationRuleInput | null;
  after: AutomationRuleInput | null;
}

export interface AutomationRunSummary {
  id: string;
  rule_id: string;
  rule_name: string;
  order_id: string | null;
  order_number: string | null;
  source: 'auto' | 'event' | 'manual' | 'barcode' | 'schedule';
  status: 'queued' | 'done' | 'skipped' | 'failed';
  reason: string | null;
  error: string | null;
  created_at: string;
}

export interface AutomationTestResult {
  matched: boolean;
  conditions: Array<{ path: string; field: string; ok: boolean; actual: unknown }>;
  effects: Array<{ type: string; would: string }>;
}

export interface CatalogField {
  key: string;
  group: string;
  label: string;
  type: ValueType;
  /** For list fields: options grouped (e.g. statuses by category); the editor shows a searchable checkbox list. */
  options?: Array<{ group?: string; value: string; label: string }>;
  /** Product-line field: supports quantifier any/all. */
  per_line?: boolean;
  hint?: string;
}

export interface CatalogEffect {
  type: string;
  group: string;
  label: string;
  /** Parameter descriptors for the editor form. */
  params: Array<{
    key: string;
    label: string;
    kind: 'text' | 'textarea' | 'number' | 'money' | 'select' | 'multiselect' | 'bool' | 'date';
    options?: Array<{ value: string; label: string }>;
    required?: boolean;
  }>;
}

export interface AutomationCatalog {
  fields: CatalogField[];
  operators: Record<ValueType, Operator[]>;
  effects: CatalogEffect[];
  /** supported:false = listed for completeness, not available yet (the editor shows it disabled). */
  triggers: Array<{ key: string; group: string; label: string; supported?: boolean; hint?: string }>;
  groups: string[];
}

/** Field keys by catalog group (Uwagi v3 §0 "Warunki"). The server owns the option lists and evaluation. */
export const CONDITION_FIELD_KEYS = {
  Zamówienie: [
    'order.created_at', 'order.status', 'order.workflow_status', 'order.total', 'order.total_without_shipping',
    'order.currency', 'order.line_count', 'order.quantity_total', 'order.weight', 'order.time_in_status',
    'order.customer_comment', 'order.internal_note', 'order.tags', 'order.extra_field', 'order.merged_or_split',
  ],
  Źródło: ['source.channel', 'source.account', 'source.site', 'source.flags', 'source.ship_by'],
  Płatność: [
    'payment.state', 'payment.method', 'payment.operator', 'payment.cod', 'payment.paid_amount',
    'payment.due_amount', 'payment.unpaid_for',
  ],
  Wysyłka: [
    'shipping.method', 'shipping.carrier', 'shipping.pickup_point', 'shipping.cost', 'shipping.has_shipment',
    'shipping.shipment_status', 'shipping.parcel_size',
  ],
  Klient: [
    'customer.email', 'customer.wants_invoice', 'customer.previous_orders', 'customer.previous_returns',
    'customer.crm_group', 'customer.has_phone',
  ],
  Adres: ['address.country', 'address.postal_code', 'address.city', 'address.differs_from_invoice'],
  Produkty: [
    'product.sku', 'product.ean', 'product.name', 'product.category', 'product.manufacturer', 'product.quantity',
    'product.price', 'product.stock_sufficient', 'product.kind',
  ],
  Magazyn: ['warehouse.id', 'warehouse.external_fulfilment'],
  Dokumenty: ['documents.issued', 'documents.kind'],
  Czas: ['time.now', 'time.cutoff'],
  Historia: ['history.rule_ran', 'history.template_sent'],
} as const;

/** Effect types by catalog group (Uwagi v3 §0 "Efekty"). */
export const EFFECT_TYPES = {
  'Status i organizacja': [
    'set_status', 'set_workflow', 'set_payment', 'add_tag', 'remove_tag', 'set_extra_field', 'add_note',
    'assign_user', 'assign_warehouse', 'set_priority', 'merge_orders', 'split_order', 'cancel_order',
  ],
  Wysyłka: ['set_delivery_method', 'create_shipment', 'print_label', 'send_tracking'],
  Dokumenty: ['issue_document', 'send_document'],
  Komunikacja: ['email', 'sms', 'marketplace_message', 'notify_team', 'request_review'],
  'Magazyn i integracje': ['reserve_stock', 'release_stock', 'supplier_order', 'send_to_fulfilment', 'webhook'],
  Sterowanie: ['run_rule'],
} as const;

/** Event triggers besides 'order.matches' (Uwagi v3 §0 "Zdarzenia"). */
export const AUTOMATION_TRIGGERS: Record<string, string> = {
  'order.matches': 'Gdy zamówienie spełni warunki',
  'order.created': 'Nowe zamówienie',
  'order.status_changed': 'Zmiana statusu zamówienia',
  'order.section_edited': 'Edycja zamówienia (sekcja)',
  'order.cancelled': 'Anulowanie zamówienia',
  'payment.changed': 'Opłacenie / zmiana statusu płatności',
  'order.all_scanned': 'Zeskanowano wszystkie produkty',
  'order.item_missing': 'Brak produktu przy kompletacji',
  'stock.changed': 'Zmiana stanu magazynowego',
  'shipment.created': 'Utworzenie przesyłki',
  'shipment.cancelled': 'Anulowanie etykiety',
  'shipment.status_changed': 'Zmiana statusu przesyłki u przewoźnika',
  'document.issued': 'Wystawienie faktury / paragonu / korekty',
  'return.registered': 'Zgłoszenie zwrotu lub reklamacji',
  'customer_message.received': 'Wiadomość od klienta',
  'time.schedule': 'Upływ czasu / harmonogram',
};

/** Stage codes allowed in config.status_change: stored order stages ('ready_to_ship' is derived, not a status change). */
export const STATUS_CHANGE_STAGES = [
  'new', 'paid', 'picking', 'packed', 'shipped', 'delivered', 'completed', 'cancelled',
  'return_initiated', 'return_received', 'return_completed',
] as const;

export const DEFAULT_RUN: RunSettings = {
  auto: true,
  delay_minutes: 0,
  mode: 'continuous',
  hours: null,
  manual_button: false,
  barcode: false,
};
