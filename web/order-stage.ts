/**
 * Order status vocabulary for people (Uwagi v3 §1, §5, §7, §8). Shared by navigation, list, card and filters.
 *
 * Fulfilment stage = orders.status, except 'ready_to_ship' ("Gotowe do nadania"), which the server derives
 * for a packed order with an undispatched label (server/order-stage.ts). Code `new` is a prepaid order still
 * waiting for its payment: it is not "Nowe" yet (that is code `paid`); the panel lists it as "Nieopłacone".
 * Payment state is a separate indicator.
 */
import { ORDER_CATEGORIES, orderCategoryLabels, stageCategories, type OrderCategory } from '../shared/order-categories';

export type FulfilmentStage =
  | 'new'
  | 'paid'
  | 'picking'
  | 'packed'
  | 'ready_to_ship'
  | 'shipped'
  | 'delivered'
  | 'completed'
  | 'return_initiated'
  | 'return_received'
  | 'return_completed'
  | 'cancelled';

export type PaymentState = 'unpaid' | 'paid' | 'partial' | 'overpaid' | 'cod';

export const fulfilmentLabels: Record<FulfilmentStage, string> = {
  new: 'Czeka na wpłatę',
  paid: 'Nowe',
  picking: 'W kompletacji',
  packed: 'Spakowane',
  ready_to_ship: 'Gotowe do nadania',
  shipped: 'Nadane',
  delivered: 'Dostarczone',
  completed: 'Zakończone',
  return_initiated: 'Zwrot zgłoszony',
  return_received: 'Zwrot przyjęty',
  return_completed: 'Zwrot zakończony',
  cancelled: 'Anulowane',
};

export const paymentLabels: Record<PaymentState, string> = {
  unpaid: 'Nieopłacone',
  paid: 'Opłacone',
  partial: 'Częściowo',
  overpaid: 'Nadpłata',
  cod: 'Pobranie',
};

/** Semantic colours from the client's "Statusy" sheet; red only for states that need a reaction. */
export const fulfilmentColors: Record<FulfilmentStage, string> = {
  new: '#8A94A6',
  paid: '#2F6FDE',
  picking: '#D98C00',
  packed: '#E0661B',
  ready_to_ship: '#0F8B8D',
  shipped: '#0F8B8D',
  delivered: '#2E9D4F',
  completed: '#1F6B3A',
  return_initiated: '#8A4FC7',
  return_received: '#8A4FC7',
  return_completed: '#8A4FC7',
  cancelled: '#D23B3B',
};

export const paymentColors: Record<PaymentState, string> = {
  unpaid: '#D23B3B',
  paid: '#2E9D4F',
  partial: '#8A94A6',
  overpaid: '#8A94A6',
  cod: '#8A94A6',
};

/** The main path shown on the card's timeline. */
export const fulfilmentPath: FulfilmentStage[] = [
  'paid',
  'picking',
  'packed',
  'ready_to_ship',
  'shipped',
  'delivered',
  'completed',
];

export interface OrderStatusGroup {
  key: string;
  label: string;
  slug: string;
  stages: FulfilmentStage[];
}

const categorySlugs: Record<OrderCategory, string> = {
  // 'nowe' is the slug of the stage Nowe (fulfilmentSlugs.paid), so the category needs its own.
  new: 'kategoria-nowe',
  in_progress: 'w-realizacji',
  completed: 'zrealizowane',
  not_completed: 'niezrealizowane',
  other: 'pozostale',
};

/**
 * The five status categories of the "Zamówienia" panel (shared/order-categories.ts, Sellasist pattern);
 * a category is a filter over its stages, not a status. Nowe comes before Nieopłacone (code `new`).
 */
const panelStageOrder: FulfilmentStage[] = ['paid', 'new', ...fulfilmentPath.slice(1), 'cancelled', 'return_initiated', 'return_received', 'return_completed'];
export const orderStatusGroups: OrderStatusGroup[] = ORDER_CATEGORIES.map((key) => ({
  key,
  label: orderCategoryLabels[key],
  slug: categorySlugs[key],
  stages: panelStageOrder.filter((s) => stageCategories[s] === key),
}));

/** Groups of the panel before the categories; their slugs stay valid so old links still open the same orders. */
export const legacyOrderStatusGroups: OrderStatusGroup[] = [
  { key: 'todo', label: 'Do realizacji', slug: 'do-realizacji', stages: ['paid', 'picking', 'packed', 'ready_to_ship'] },
  { key: 'shipping', label: 'Wysyłka', slug: 'wysylka', stages: ['shipped', 'delivered', 'completed'] },
  {
    key: 'returns',
    label: 'Zwroty i anulowane',
    slug: 'zwroty-i-anulowane',
    stages: ['return_initiated', 'return_received', 'return_completed', 'cancelled'],
  },
  { key: 'payments', label: 'Płatności', slug: 'platnosci', stages: ['new'] },
];

/**
 * Colours offered for a custom status: the stage colours, each named by its meaning, so a colour is never
 * the only signal (the swatch always shows its label).
 */
export const statusPalette: Array<{ color: string; label: string }> = [
  { color: fulfilmentColors.cancelled, label: 'Czerwony — wymaga reakcji' },
  { color: fulfilmentColors.paid, label: 'Niebieski — nowe' },
  { color: fulfilmentColors.picking, label: 'Bursztynowy — kompletacja' },
  { color: fulfilmentColors.packed, label: 'Pomarańczowy — spakowane' },
  { color: fulfilmentColors.shipped, label: 'Morski — wysyłka' },
  { color: fulfilmentColors.delivered, label: 'Zielony — dostarczone' },
  { color: fulfilmentColors.completed, label: 'Ciemnozielony — zakończone' },
  { color: fulfilmentColors.return_initiated, label: 'Fioletowy — zwroty' },
  { color: fulfilmentColors.new, label: 'Szary — oczekuje' },
];

/** URL slug of each stage: /zamowienia/status/<slug>. */
export const fulfilmentSlugs: Record<FulfilmentStage, string> = {
  new: 'nieoplacone',
  paid: 'nowe',
  picking: 'w-kompletacji',
  packed: 'spakowane',
  ready_to_ship: 'gotowe-do-nadania',
  shipped: 'nadane',
  delivered: 'dostarczone',
  completed: 'zakonczone',
  return_initiated: 'zwrot-zgloszony',
  return_received: 'zwrot-przyjety',
  return_completed: 'zwrot-zakonczony',
  cancelled: 'anulowane',
};

/** Label in the panel: code `new` is listed under the category Nowe as "Nieopłacone". */
export const panelLabel = (stage: FulfilmentStage): string =>
  stage === 'new' ? 'Nieopłacone' : fulfilmentLabels[stage];

export const isFulfilmentStage = (value: string): value is FulfilmentStage =>
  Object.prototype.hasOwnProperty.call(fulfilmentLabels, value);

export const fulfilmentLabel = (value: string): string =>
  isFulfilmentStage(value) ? fulfilmentLabels[value] : value;
