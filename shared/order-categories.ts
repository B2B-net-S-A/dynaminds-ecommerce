/**
 * Fixed status categories (Uwagi v3 §0 "Statusy: kategorie i statusy własne", wzór Sellasist): every fulfilment
 * stage and every custom status belongs to exactly one of five categories. Shared by the server (custom status
 * API, automation catalog) and the web panel.
 *
 * A stage's category is fixed here. A custom status (workflow_statuses) stores its own category in
 * workflow_status267_categories (migration 267); without a row it reads the category of its stage.
 * The fulfilment axis (orders.status, Nowe → … → Zakończone) is unchanged: a category groups, it does not move orders.
 */
export const ORDER_CATEGORIES = ['new', 'in_progress', 'completed', 'not_completed', 'other'] as const;
export type OrderCategory = (typeof ORDER_CATEGORIES)[number];

export const orderCategoryLabels: Record<OrderCategory, string> = {
  new: 'Nowe',
  in_progress: 'W realizacji',
  completed: 'Zrealizowane',
  not_completed: 'Niezrealizowane',
  other: 'Pozostałe',
};

/** Category of each fulfilment stage (client sheet: Nowe = Nowe + Nieopłacone, Zrealizowane = Wysłane, Niezrealizowane = Anulowane). */
export const stageCategories: Record<string, OrderCategory> = {
  new: 'new',
  paid: 'new',
  picking: 'in_progress',
  packed: 'in_progress',
  ready_to_ship: 'in_progress',
  shipped: 'completed',
  delivered: 'completed',
  completed: 'completed',
  cancelled: 'not_completed',
  return_initiated: 'other',
  return_received: 'other',
  return_completed: 'other',
};

export const isOrderCategory = (value: unknown): value is OrderCategory =>
  typeof value === 'string' && (ORDER_CATEGORIES as readonly string[]).includes(value);

/** The category of a custom status: its own, else the category of its stage, else Pozostałe. */
export function workflowCategory(status: { category?: unknown; stage?: string | null }): OrderCategory {
  if (isOrderCategory(status.category)) return status.category;
  return stageCategories[status.stage ?? ''] ?? 'other';
}

/** Two-level custom status: "Pakowanie / Do zebrania DPD" is "Do zebrania DPD" under the parent "Pakowanie". */
export const WORKFLOW_LEVEL_SEPARATOR = ' / ';
export function workflowNameParts(name: string): { parent: string | null; leaf: string } {
  const at = name.indexOf('/');
  if (at <= 0) return { parent: null, leaf: name.trim() };
  const parent = name.slice(0, at).trim(),
    leaf = name.slice(at + 1).trim();
  return parent && leaf ? { parent, leaf } : { parent: null, leaf: name.trim() };
}
