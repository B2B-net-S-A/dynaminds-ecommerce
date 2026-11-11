/**
 * Addresses of the office app (Uwagi v3 §8): every view and every order has its own URL; back and refresh work.
 *
 *   /  or /przeglad                     dashboard
 *   /zamowienia                         all orders
 *   /zamowienia/status/<slug>           one stage (fulfilmentSlugs), a category (orderStatusGroups[].slug)
 *                                       or a former group (legacyOrderStatusGroups[].slug, old links)
 *   /zamowienia/status/wlasny/<id>      custom workflow status
 *   /zamowienia/<number>                order card (a uuid is accepted too and replaced by the number)
 *   /pakowanie, /pakowanie/<number>     packer module (WMS), optionally with that order open; /wms is an alias
 *   /<slug>                             other modules, see PAGE_SLUGS
 * List filters belong in the query string: use useRouteQuery() / setRouteQuery(); the path stays the view.
 *
 * Other parts of the app navigate with navigateTo(path), which the App applies with its pending-operation
 * guards (a refused navigation leaves the address unchanged). Example: navigateTo(orderPath(order.number)).
 */
import { useEffect, useState } from 'react';
import {
  fulfilmentSlugs,
  isFulfilmentStage,
  legacyOrderStatusGroups,
  orderStatusGroups,
  type FulfilmentStage,
} from './order-stage';

export const PAGE_SLUGS = {
  dashboard: 'przeglad',
  orders: 'zamowienia',
  picking: 'kompletacja',
  returns: 'zwroty',
  paymentImports: 'przelewy',
  crm: 'klienci',
  b2bNetwork: 'siec-b2b',
  b2b: 'kontrahenci-b2b',
  pricing: 'cenniki',
  products: 'produkty',
  inventory: 'magazyny',
  wmsLots: 'partie',
  wmsStocktakes: 'inwentaryzacje',
  purchasing: 'zakupy',
  integrations: 'integracje',
  email: 'email',
  customerMessages: 'wiadomosci',
  sms: 'sms',
  automations: 'automatyzacje',
  productRules: 'reguly-produktow',
  orderFields: 'pola-zamowien',
  orderFieldBatches: 'pola-zamowien-import',
  orderFieldMappings: 'pola-zamowien-mapowania',
  documents: 'dokumenty',
  reports: 'raporty',
  audit: 'historia-operacji',
  rodo: 'rodo',
  developer: 'api-i-webhooki',
  settings: 'ustawienia',
} as const;
export type RoutePage = keyof typeof PAGE_SLUGS;

/** Same shape as OrderStatusFilter in order-status-panel.tsx: status is one stage or a comma list. */
export type RouteOrderFilter = { status: string; workflow: string };

export type AppRoute =
  | { kind: 'page'; page: RoutePage }
  | { kind: 'orders'; filter: RouteOrderFilter }
  | { kind: 'order'; ref: string }
  | { kind: 'packing'; ref: string | null }
  | { kind: 'unknown' };

const slugToPage = new Map<string, RoutePage>(
  (Object.entries(PAGE_SLUGS) as [RoutePage, string][]).map(([page, slug]) => [slug, page]),
);
const slugToStage = new Map<string, FulfilmentStage>(
  (Object.entries(fulfilmentSlugs) as [FulfilmentStage, string][]).map(([stage, slug]) => [slug, stage]),
);
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALL: RouteOrderFilter = { status: '', workflow: '' };

const decode = (segment: string): string | null => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
};

export function parseAppPath(pathname: string): AppRoute {
  const parts = pathname.split('/').filter(Boolean);
  if (!parts.length) return { kind: 'page', page: 'dashboard' };
  const [head, ...rest] = parts;
  if (head === 'wms' || head === 'pakowanie') {
    if (head === 'wms' || !rest.length) return { kind: 'packing', ref: null };
    const ref = rest.length === 1 ? decode(rest[0]) : null;
    return ref ? { kind: 'packing', ref } : { kind: 'unknown' };
  }
  if (head === PAGE_SLUGS.orders && rest.length) {
    if (rest[0] === 'status') {
      const filter = rest.length === 2 ? orderFilterFromSlug(rest[1]) : null;
      if (filter) return { kind: 'orders', filter };
      if (rest.length === 3 && rest[1] === 'wlasny' && UUID.test(rest[2]))
        return { kind: 'orders', filter: { status: '', workflow: rest[2].toLowerCase() } };
      return { kind: 'unknown' };
    }
    const ref = rest.length === 1 ? decode(rest[0]) : null;
    return ref && ref.trim() ? { kind: 'order', ref } : { kind: 'unknown' };
  }
  if (head === PAGE_SLUGS.orders) return { kind: 'orders', filter: ALL };
  const page = rest.length ? undefined : slugToPage.get(head);
  return page ? { kind: 'page', page } : { kind: 'unknown' };
}

/** Categories first: "Zrealizowane" and the former "Wysyłka" cover the same stages and the category names them. */
const routeGroups = [...orderStatusGroups, ...legacyOrderStatusGroups];

/** A stage slug, a category slug or a former group slug; null when the slug is unknown. */
export function orderFilterFromSlug(slug: string): RouteOrderFilter | null {
  const stage = slugToStage.get(slug);
  if (stage) return { status: stage, workflow: '' };
  const group = routeGroups.find((g) => g.slug === slug);
  return group ? { status: group.stages.join(','), workflow: '' } : null;
}

/** /zamowienia/status/<slug> for a stage or a category, /zamowienia/status/wlasny/<id>, or /zamowienia. */
export function orderStatusPath(filter: RouteOrderFilter): string {
  if (filter.workflow) return '/zamowienia/status/wlasny/' + encodeURIComponent(filter.workflow);
  if (!filter.status) return '/zamowienia';
  if (isFulfilmentStage(filter.status)) return '/zamowienia/status/' + fulfilmentSlugs[filter.status];
  const group = routeGroups.find((g) => g.stages.join(',') === filter.status);
  // A comma list that is not a group has no address of its own; the list of all orders is the honest fallback.
  return group ? '/zamowienia/status/' + group.slug : '/zamowienia';
}

export const orderPath = (numberOrId: string) => '/zamowienia/' + encodeURIComponent(numberOrId);
export const packingPath = (number?: string | null) => (number ? '/pakowanie/' + encodeURIComponent(number) : '/pakowanie');
export const pagePath = (page: RoutePage) => (page === 'dashboard' ? '/' : '/' + PAGE_SLUGS[page]);

/** Paths are equal for the router: '/' and '/przeglad' are the same view. */
export const samePath = (a: string, b: string) => {
  const norm = (p: string) => (p === '/przeglad' ? '/' : p.replace(/\/+$/, '') || '/');
  return norm(a) === norm(b);
};

// ---- Navigation requests from anywhere in the app ------------------------------------------------------

export const NAVIGATE_EVENT = 'dyna:navigate';
export const ROUTE_EVENT = 'dyna:route';
export type NavigateDetail = { path: string; replace?: boolean };

/** Ask the App to show `path` (it applies its guards first). Query and hash may be part of `path`. */
export function navigateTo(path: string, options: { replace?: boolean } = {}): void {
  window.dispatchEvent(new CustomEvent<NavigateDetail>(NAVIGATE_EVENT, { detail: { path, replace: options.replace } }));
}

/** Writes the address and tells useRouteQuery() subscribers; the App calls this, other code uses navigateTo. */
export function writeHistory(url: string, replace = false): void {
  const current = window.location.pathname + window.location.search + window.location.hash;
  if (current !== url) {
    if (replace) window.history.replaceState(null, '', url);
    else window.history.pushState(null, '', url);
  }
  window.dispatchEvent(new Event(ROUTE_EVENT));
}

// ---- Query string for list filters ---------------------------------------------------------------------

/** Current query parameters (a copy). */
export const getRouteQuery = (): URLSearchParams => new URLSearchParams(window.location.search);

/**
 * Replace the query string of the current view. Empty values are dropped. Default `replace: true`, so typing
 * in a filter does not flood the history; pass `{ replace: false }` for a deliberate step the back button undoes.
 */
export function setRouteQuery(
  params: URLSearchParams | Record<string, string | null | undefined>,
  options: { replace?: boolean } = {},
): void {
  const next = new URLSearchParams();
  const entries = params instanceof URLSearchParams ? [...params.entries()] : Object.entries(params);
  for (const [k, v] of entries) if (v !== null && v !== undefined && v !== '') next.append(k, v);
  const search = next.toString();
  writeHistory(window.location.pathname + (search ? '?' + search : '') + window.location.hash, options.replace ?? true);
}

/** Query parameters of the current address; re-renders on back/forward and on every app navigation. */
export function useRouteQuery(): URLSearchParams {
  const [search, setSearch] = useState(() => window.location.search);
  useEffect(() => {
    const sync = () => setSearch(window.location.search);
    window.addEventListener('popstate', sync);
    window.addEventListener(ROUTE_EVENT, sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener(ROUTE_EVENT, sync);
    };
  }, []);
  return new URLSearchParams(search);
}
