/**
 * Main menu modules and their options panels (Uwagi v3 §2). Pure data and rules; rendering is in module-nav.tsx.
 *
 * A module with two or more visible options opens an options panel next to the menu and the menu collapses to
 * an icon rail. A module with one option (or none, like Przegląd) is a plain link and the menu stays expanded.
 */
import { orderStatusPath, packingPath, type RoutePage } from './app-route';

export type NavTarget = { page: RoutePage } | { path: string };
export type NavOption = { key: string; label: string; to: NavTarget; adminOnly?: boolean };
export type NavIcon =
  | 'dashboard'
  | 'orders'
  | 'picking'
  | 'returns'
  | 'payments'
  | 'customers'
  | 'catalog'
  | 'communication'
  | 'automations'
  | 'integrations'
  | 'reports'
  | 'settings'
  | 'warehouse';
export type NavModule = {
  id: string;
  label: string;
  icon: NavIcon;
  /** Pages that belong to the module (active highlight); the first visible option is its default view. */
  pages: RoutePage[];
  options: NavOption[];
  adminOnly?: boolean;
  /** 'orders': the panel is the order status panel, not a list of options. */
  panel?: 'orders';
};

/** Pages hidden from non-administrators (as before Uwagi v3). */
export const ADMIN_PAGES: RoutePage[] = ['audit', 'developer', 'productRules', 'paymentImports', 'orderFields'];

const page = (key: RoutePage, label: string, adminOnly = ADMIN_PAGES.includes(key)): NavOption => ({
  key,
  label,
  to: { page: key },
  ...(adminOnly ? { adminOnly } : {}),
});
const stage = (key: string, label: string, status: string): NavOption => ({
  key,
  label,
  to: { path: orderStatusPath({ status, workflow: '' }) },
});

export const navModules: NavModule[] = [
  { id: 'dashboard', label: 'Przegląd', icon: 'dashboard', pages: ['dashboard'], options: [page('dashboard', 'Przegląd')] },
  {
    id: 'orders',
    label: 'Zamówienia',
    icon: 'orders',
    pages: ['orders'],
    options: [page('orders', 'Wszystkie zamówienia')],
    panel: 'orders',
  },
  {
    id: 'picking',
    label: 'Kompletacja',
    icon: 'picking',
    pages: ['picking'],
    options: [
      page('picking', 'Do skompletowania'),
      stage('picking-started', 'W trakcie kompletacji', 'picking'),
      stage('packed', 'Spakowane', 'packed'),
      { key: 'packing', label: 'Ekran pakowania', to: { path: packingPath() } },
    ],
  },
  {
    id: 'returns',
    label: 'Zwroty i reklamacje',
    icon: 'returns',
    pages: ['returns'],
    options: [
      page('returns', 'Zgłoszenia i rozliczenia'),
      stage('return_initiated', 'Zwrot zgłoszony', 'return_initiated'),
      stage('return_received', 'Zwrot przyjęty', 'return_received'),
      stage('return_completed', 'Zwrot zakończony', 'return_completed'),
    ],
  },
  {
    id: 'payments',
    label: 'Przelewy i pobrania',
    icon: 'payments',
    pages: ['paymentImports'],
    adminOnly: true,
    options: [page('paymentImports', 'Import wpłat'), stage('unpaid', 'Nieopłacone zamówienia', 'new')],
  },
  {
    id: 'customers',
    label: 'Klienci',
    icon: 'customers',
    pages: ['crm', 'b2bNetwork', 'b2b'],
    options: [page('crm', 'Klienci CRM'), page('b2bNetwork', 'Sieć B2B'), page('b2b', 'Kontrahenci B2B')],
  },
  {
    id: 'catalog',
    label: 'Asortyment',
    icon: 'catalog',
    pages: ['products', 'pricing', 'inventory', 'wmsLots', 'wmsStocktakes', 'purchasing', 'productRules'],
    options: [
      page('products', 'Produkty'),
      page('pricing', 'Cenniki'),
      page('inventory', 'Magazyny'),
      page('wmsLots', 'Partie i FIFO'),
      page('wmsStocktakes', 'Inwentaryzacje partii'),
      page('purchasing', 'Zakupy i dostawy'),
      page('productRules', 'Reguły produktów'),
    ],
  },
  {
    id: 'communication',
    label: 'Komunikacja',
    icon: 'communication',
    pages: ['customerMessages', 'email', 'sms'],
    options: [page('customerMessages', 'Wiadomości klientów'), page('email', 'Komunikacja email'), page('sms', 'Komunikacja SMS')],
  },
  {
    id: 'automations',
    label: 'Automatyzacje',
    icon: 'automations',
    pages: ['automations', 'orderFields', 'orderFieldBatches', 'orderFieldMappings'],
    options: [
      page('automations', 'Reguły i statusy własne'),
      page('orderFields', 'Pola zamówień'),
      page('orderFieldBatches', 'Pola — import i operacje'),
      page('orderFieldMappings', 'Pola — mapowania kanałów'),
    ],
  },
  {
    id: 'integrations',
    label: 'Integracje',
    icon: 'integrations',
    pages: ['integrations', 'developer'],
    options: [page('integrations', 'Kanały i usługi'), page('developer', 'API i webhooki')],
  },
  {
    id: 'reports',
    label: 'Raporty i dokumenty',
    icon: 'reports',
    pages: ['reports', 'documents', 'audit'],
    options: [page('reports', 'Raporty'), page('documents', 'Dokumenty'), page('audit', 'Historia operacji')],
  },
  {
    id: 'settings',
    label: 'Ustawienia',
    icon: 'settings',
    pages: ['settings', 'rodo'],
    options: [page('settings', 'Organizacja i konto'), page('rodo', 'RODO')],
  },
];

/** Admin modules the accountant "Księgowa" also uses (the server admits the accountant there, migration 266). */
export const ACCOUNTANT_MODULES: readonly string[] = ['payments'];

/** Modules and options a person may see; a module without a visible option disappears. */
export function visibleModules(admin: boolean, accountant = false): NavModule[] {
  const allowed = (m: NavModule) => admin || (accountant && ACCOUNTANT_MODULES.includes(m.id));
  return navModules
    .filter((m) => allowed(m) || !m.adminOnly)
    .map((m) => ({ ...m, options: m.options.filter((o) => allowed(m) || !o.adminOnly) }))
    .filter((m) => m.options.length > 0);
}

export const hasPanel = (m: NavModule) => m.panel === 'orders' || m.options.length > 1;

export function moduleOfPage(modules: NavModule[], page: RoutePage): NavModule | undefined {
  return modules.find((m) => m.pages.includes(page));
}

/** First option of the module: where clicking the module goes when the person is elsewhere. */
export const defaultTarget = (m: NavModule): NavTarget => m.options[0].to;

/** Option highlighted for the current view: same page, or the same address for path options. */
export function isOptionActive(option: NavOption, view: { page: RoutePage; path: string; order: boolean }): boolean {
  if (view.order) return false;
  if ('page' in option.to) return option.to.page === view.page && (view.page !== 'orders' || view.path === '/zamowienia');
  return option.to.path === view.path;
}

// ---- Remembered panel visibility, per workspace and person ----------------------------------------------

export const navStorageKey = (tenantId: string, userId: string) => `dyna.nav.${tenantId}.${userId}`;

export function readPanelHidden(tenantId: string, userId: string): boolean {
  try {
    const raw = window.localStorage.getItem(navStorageKey(tenantId, userId));
    return raw ? JSON.parse(raw)?.panelHidden === true : false;
  } catch {
    return false;
  }
}

export function writePanelHidden(tenantId: string, userId: string, hidden: boolean): void {
  try {
    window.localStorage.setItem(navStorageKey(tenantId, userId), JSON.stringify({ panelHidden: hidden }));
  } catch {
    // Private mode or blocked storage: the choice lasts until reload.
  }
}
