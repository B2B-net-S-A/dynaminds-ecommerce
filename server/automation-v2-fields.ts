/**
 * Automation rules v2: static description of condition fields, effects and triggers (labels in Polish).
 * Option lists come from the tenant's data in server/automation-v2-catalog.ts.
 */
import {
  AUTOMATION_TRIGGERS,
  CONDITION_FIELD_KEYS,
  EFFECT_TYPES,
  type ValueType,
} from '../shared/automation-v2';
import type { FieldMeta } from './automation-v2-eval';

export interface FieldDef extends FieldMeta {
  key: string;
  group: string;
  label: string;
  hint?: string;
  /** Amounts in grosze. */
  unit?: 'money';
  /** false: the field is listed but cannot be sourced locally yet (never matches). */
  supported?: false;
}

type Def = [key: string, label: string, type: ValueType, extra?: Partial<FieldDef>];

const DEFS: Def[] = [
  ['order.created_at', 'Data złożenia', 'date'],
  ['order.status', 'Status realizacji', 'list', { hint: 'Etap zamówienia, w tym „Gotowe do nadania”' }],
  ['order.workflow_status', 'Własny status', 'list'],
  ['order.total', 'Wartość z dostawą', 'number', { unit: 'money', hint: 'Kwota w groszach' }],
  ['order.total_without_shipping', 'Wartość bez dostawy', 'number', { unit: 'money', hint: 'Kwota w groszach' }],
  ['order.currency', 'Waluta', 'list'],
  ['order.line_count', 'Liczba pozycji', 'number'],
  ['order.quantity_total', 'Liczba sztuk', 'number'],
  ['order.weight', 'Waga', 'number', { hint: 'Gramy, z logistyki produktu' }],
  ['order.time_in_status', 'W bieżącym statusie od', 'date', { hint: 'Użyj „jest starsza niż” z liczbą godzin lub dni' }],
  ['order.customer_comment', 'Komentarz klienta', 'text', { hint: 'Wiadomość kupującego z kanału; w zamówieniu ręcznym notatka zamówienia' }],
  ['order.internal_note', 'Notatka wewnętrzna', 'text'],
  ['order.tags', 'Tagi', 'list'],
  ['order.extra_field', 'Pole dodatkowe', 'text', { hint: 'Wybierz konkretne pole z listy „Pole dodatkowe: …”' }],
  ['order.merged_or_split', 'Połączone / podzielone', 'list'],
  ['source.channel', 'Kanał sprzedaży', 'list'],
  ['source.account', 'Konto kanału', 'list'],
  ['source.site', 'Kraj / wersja serwisu', 'list', { hint: 'np. allegro.pl, allegro.cz, amazon.de; dla sklepu jego adres' }],
  ['source.flags', 'Oznaczenia z serwisu', 'list', { hint: 'Allegro Smart, dostawa ekspresowa, zamówienie firmowe (także z NIP w zamówieniu)' }],
  ['source.ship_by', 'Wyślij do (termin z serwisu)', 'date', { hint: 'Termin z Allegro, Amazon, eBay i Mirakl' }],
  ['payment.state', 'Status płatności', 'list'],
  ['payment.method', 'Forma płatności', 'list'],
  ['payment.operator', 'Operator płatności', 'list', { hint: 'Z kanału, a w innych zamówieniach z zarejestrowanej wpłaty albo formy płatności' }],
  ['payment.cod', 'Za pobraniem', 'bool'],
  ['payment.paid_amount', 'Wpłacono', 'number', { unit: 'money', hint: 'Kwota w groszach' }],
  ['payment.due_amount', 'Do zapłaty', 'number', { unit: 'money', hint: 'Kwota w groszach' }],
  ['payment.unpaid_for', 'Nieopłacone od', 'date', { hint: 'Puste, gdy opłacone; użyj „jest starsza niż”' }],
  ['shipping.method', 'Sposób wysyłki', 'list', { hint: 'Metody sklepu i serwisów na jednej liście; wariant „pobranie” dla zamówień za pobraniem' }],
  ['shipping.carrier', 'Przewoźnik', 'list'],
  ['shipping.pickup_point', 'Punkt odbioru / paczkomat', 'text'],
  ['shipping.cost', 'Koszt dostawy', 'number', { unit: 'money', hint: 'Kwota w groszach' }],
  ['shipping.has_shipment', 'Ma przesyłkę', 'bool'],
  ['shipping.shipment_status', 'Status przesyłki', 'list'],
  ['shipping.parcel_size', 'Gabaryt paczki', 'list', { hint: 'Z przesyłki u przewoźnika albo wyliczony z wymiarów i wagi produktów (InPost A/B/C)' }],
  ['customer.email', 'E-mail / login', 'text'],
  ['customer.wants_invoice', 'Chce fakturę', 'bool'],
  ['customer.previous_orders', 'Wcześniejsze zamówienia', 'number', { hint: 'Po adresie e-mail' }],
  ['customer.previous_returns', 'Wcześniejsze zwroty', 'number', { hint: 'Po adresie e-mail' }],
  ['customer.crm_group', 'Status / grupa w CRM', 'list'],
  ['customer.has_phone', 'Podał telefon', 'bool'],
  ['address.country', 'Kraj dostawy', 'list'],
  ['address.postal_code', 'Kod pocztowy', 'text'],
  ['address.city', 'Miasto', 'text'],
  ['address.differs_from_invoice', 'Adres dostawy inny niż do faktury', 'bool'],
  ['product.sku', 'SKU', 'text', { per_line: true }],
  ['product.ean', 'EAN', 'text', { per_line: true }],
  ['product.name', 'Nazwa produktu', 'text', { per_line: true }],
  ['product.category', 'Kategoria', 'text', { per_line: true }],
  ['product.manufacturer', 'Producent', 'text', { per_line: true }],
  ['product.quantity', 'Ilość w pozycji', 'number', { per_line: true }],
  ['product.price', 'Cena jednostkowa', 'number', { per_line: true, unit: 'money', hint: 'Kwota w groszach' }],
  ['product.stock_sufficient', 'Stan wystarcza', 'bool', { per_line: true }],
  ['product.kind', 'Rodzaj produktu', 'list', { per_line: true }],
  ['warehouse.id', 'Magazyn', 'list'],
  ['warehouse.external_fulfilment', 'Realizacja zewnętrzna (MCF)', 'bool'],
  ['documents.issued', 'Wystawiono dokument', 'bool'],
  ['documents.kind', 'Rodzaj dokumentu', 'list'],
  ['time.now', 'Teraz', 'date', { hint: 'Dzień tygodnia lub godzina (Europe/Warsaw)' }],
  ['time.cutoff', 'Złożono przed godziną odcięcia', 'date', { hint: 'Godzina złożenia; użyj „godzina pomiędzy”' }],
  ['history.rule_ran', 'Reguła już wykonana', 'list'],
  ['history.template_sent', 'Wysłano już szablon', 'list'],
];

const GROUP_OF = new Map<string, string>(
  Object.entries(CONDITION_FIELD_KEYS).flatMap(([group, keys]) => keys.map((k) => [k, group] as [string, string])),
);

export const FIELD_DEFS: FieldDef[] = DEFS.map(([key, label, type, extra]) => ({
  key,
  group: GROUP_OF.get(key) ?? 'Zamówienie',
  label,
  type,
  ...extra,
}));

const BY_KEY = new Map(FIELD_DEFS.map((f) => [f.key, f]));
export const EXTRA_FIELD_PREFIX = 'order.extra_field.';

/** Static field metadata; dynamic extra fields resolve through the OrderContext. */
export function fieldMeta(key: string): FieldDef | undefined {
  return BY_KEY.get(key);
}

export const EFFECT_GROUP = new Map<string, string>(
  Object.entries(EFFECT_TYPES).flatMap(([group, types]) => types.map((t) => [t, group] as [string, string])),
);

export const EFFECT_LABELS: Record<string, string> = {
  set_status: 'Zmień status realizacji',
  set_workflow: 'Ustaw własny status',
  set_payment: 'Oznacz płatność',
  add_tag: 'Dodaj tag',
  remove_tag: 'Usuń tag',
  set_extra_field: 'Ustaw pole dodatkowe',
  add_note: 'Dodaj notatkę',
  assign_user: 'Przypisz pracownika',
  assign_warehouse: 'Przypisz magazyn',
  set_priority: 'Ustaw priorytet',
  merge_orders: 'Połącz z innymi otwartymi zamówieniami tego samego klienta',
  split_order: 'Podziel zamówienie',
  cancel_order: 'Anuluj zamówienie',
  set_delivery_method: 'Zmień sposób wysyłki',
  create_shipment: 'Utwórz przesyłkę / etykietę',
  print_label: 'Drukuj etykietę na drukarce',
  send_tracking: 'Wyślij numer przesyłki',
  issue_document: 'Wystaw dokument',
  send_document: 'Wyślij dokument',
  email: 'Wyślij e-mail',
  sms: 'Wyślij SMS',
  marketplace_message: 'Wyślij wiadomość przez marketplace',
  notify_team: 'Powiadom zespół',
  request_review: 'Poproś o opinię',
  reserve_stock: 'Zarezerwuj stan',
  release_stock: 'Zwolnij rezerwację',
  supplier_order: 'Utwórz zamówienie do dostawcy',
  send_to_fulfilment: 'Przekaż do fulfillmentu (Amazon MCF)',
  webhook: 'Wywołaj webhook (ERP / księgowość)',
  run_rule: 'Uruchom inną regułę',
};

/** Effects that cannot run safely from a rule yet: listed with supported:false and a reason. */
export const UNSUPPORTED_EFFECTS: Record<string, string> = {
  // Every order reserves its physical lines with location rows (createOrder), and the app role cannot move them:
  // the warehouse of a reservation row is sealed (146_warehouse_inventory_policies: "Tożsamość fizycznego stanu
  // magazynu jest stała"), location rows are never deleted (no DELETE grant), a released reservation keeps them in
  // a foreign key (025_stock_locations.sql), and the key (tenant, order, product) allows no second reservation in
  // another warehouse. Proven by tests/automation-v2-assign-warehouse.database.test.ts.
  assign_warehouse:
    'Rezerwacje zamówienia są trwale przypięte do magazynu, w którym powstały, i baza nie pozwala ich przenieść; magazyn ustala się przy tworzeniu zamówienia',
};

export const TRIGGER_GROUPS: Record<string, string> = {
  'order.matches': 'Warunki',
  'order.created': 'Zamówienie',
  'order.status_changed': 'Zamówienie',
  'order.section_edited': 'Zamówienie',
  'order.cancelled': 'Zamówienie',
  'payment.changed': 'Płatność',
  'order.all_scanned': 'Kompletacja',
  'order.item_missing': 'Kompletacja',
  'stock.changed': 'Magazyn',
  'shipment.created': 'Wysyłka',
  'shipment.cancelled': 'Wysyłka',
  'shipment.status_changed': 'Wysyłka',
  'document.issued': 'Dokumenty',
  'return.registered': 'Zwroty',
  'customer_message.received': 'Komunikacja',
  'time.schedule': 'Czas',
};

/**
 * Triggers the engine cannot raise yet are listed as supported:false. All events are raised today: item missing
 * (order-item-missing.ts), stock change (automation-v2-stock.ts), label cancel (shipment-cancel.ts), carrier status
 * (tracking.ts, shipment-demo-status.ts) and customer message (customer-messages.ts, channel-inbox253.ts).
 */
export const UNSUPPORTED_TRIGGERS: Record<string, string> = {};

export const TRIGGER_KEYS = Object.keys(AUTOMATION_TRIGGERS);
