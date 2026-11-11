/**
 * Keeps the address bar and the App's view state in step (Uwagi v3 §8).
 *
 * State -> address: after every view change the matching path is pushed (or replaced while booting).
 * Address -> state: back/forward, navigateTo() and the first load are applied through the App's own guards;
 * a back/forward step the App refuses is undone by pushing the previous address again.
 */
import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import {
  NAVIGATE_EVENT,
  ROUTE_EVENT,
  UUID,
  orderPath,
  orderStatusPath,
  pagePath,
  parseAppPath,
  samePath,
  writeHistory,
  type AppRoute,
  type NavigateDetail,
  type RouteOrderFilter,
  type RoutePage,
} from './app-route';

export type RouteMode = 'boot' | 'pop' | 'push';
export type OrderRef = { id: string; number: string };

export interface AppRouteSyncOptions {
  /** Office screen is showing (signed in, not the packer module). */
  enabled: boolean;
  view: { page: RoutePage; orderId: string | null; filter: RouteOrderFilter };
  /** First route; defaults to the current path. The App passes its invitation/integration overrides here. */
  initialRoute?: AppRoute;
  /** Apply a page or list route with the App's guards; false = refused. */
  apply: (route: Extract<AppRoute, { kind: 'page' | 'orders' }>, mode: RouteMode) => boolean;
  /** Open an order card; false = refused. */
  openOrder: (id: string) => boolean;
  /** Open the packer module, optionally on one order. */
  openPacking: (ref: string | null) => void;
  /** An order from the address does not exist (Polish server message). */
  onMissingOrder: (message: string) => void;
}

const currentUrl = () => window.location.pathname + window.location.search + window.location.hash;
const splitUrl = (url: string) => {
  const at = url.search(/[?#]/);
  return at < 0 ? { path: url, rest: '' } : { path: url.slice(0, at), rest: url.slice(at) };
};

/** Resolves a number (or a uuid) from the address to the order id and number. */
export async function resolveOrderRef(ref: string): Promise<OrderRef> {
  const row = UUID.test(ref)
    ? await api<OrderRef>(`/orders/${ref.toLowerCase()}/ref`)
    : await api<OrderRef>(`/orders/by-number/${encodeURIComponent(ref)}`);
  return { id: row.id, number: row.number };
}

export function useAppRouteSync(options: AppRouteSyncOptions) {
  const opts = useRef(options);
  opts.current = options;
  const initial = useRef<AppRoute | null>(options.initialRoute ?? parseAppPath(window.location.pathname));
  // The first route only counts while the address is still the one the page was loaded with
  // (e.g. not after the packer module at /pakowanie was left for the office).
  const initialPath = useRef(window.location.pathname);
  const [booted, setBooted] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [tick, setTick] = useState(0);
  const numbers = useRef(new Map<string, string>());
  const lastUrl = useRef(currentUrl());
  const pending = useRef<{ replace: boolean; rest: string | null }>({ replace: true, rest: null });
  const serial = useRef(0);

  const remember = (ref: OrderRef) => numbers.current.set(ref.id, ref.number);
  const restore = (mode: RouteMode) => {
    // A refused back/forward step: show the previous address again (pushState, so "back" still works).
    if (mode === 'pop') writeHistory(lastUrl.current);
  };

  const handle = (route: AppRoute, mode: RouteMode) => {
    const o = opts.current;
    const run = ++serial.current;
    if (route.kind === 'packing') {
      o.openPacking(route.ref);
      return;
    }
    if (route.kind === 'unknown') {
      pending.current = { replace: true, rest: '' };
      if (!o.apply({ kind: 'page', page: 'dashboard' }, mode)) restore(mode);
      setTick((t) => t + 1);
      return;
    }
    if (route.kind === 'order') {
      const known = [...numbers.current].find(([id, n]) => n === route.ref || id === route.ref.toLowerCase());
      if (known) {
        if (!o.openOrder(known[0])) restore(mode);
        return;
      }
      setResolving(true);
      resolveOrderRef(route.ref)
        .then((ref) => {
          if (run !== serial.current) return;
          remember(ref);
          // A uuid address is replaced by the number.
          if (UUID.test(route.ref)) pending.current = { replace: true, rest: null };
          if (!opts.current.openOrder(ref.id)) restore(mode);
        })
        .catch((e: unknown) => {
          if (run !== serial.current) return;
          opts.current.onMissingOrder(e instanceof Error ? e.message : 'Nie znaleziono zamówienia.');
          pending.current = { replace: true, rest: '' };
          opts.current.apply({ kind: 'orders', filter: { status: '', workflow: '' } }, mode);
          setTick((t) => t + 1);
        })
        .finally(() => {
          if (run === serial.current) setResolving(false);
        });
      return;
    }
    if (!o.apply(route, mode)) restore(mode);
  };

  // First load, sign-in, and every return from the packer module: the address wins.
  const wasEnabled = useRef(false);
  useEffect(() => {
    const enabled = options.enabled;
    if (enabled && !wasEnabled.current) {
      const first = !booted;
      const route =
        first && initial.current && samePath(window.location.pathname, initialPath.current)
          ? initial.current
          : parseAppPath(window.location.pathname);
      const mode: RouteMode = first ? 'boot' : 'pop';
      initial.current = null;
      if (mode === 'boot') pending.current = { replace: true, rest: null };
      handle(route, mode);
      setBooted(true);
    }
    wasEnabled.current = enabled;
  }, [options.enabled]);

  useEffect(() => {
    const onPop = () => {
      if (!opts.current.enabled) return;
      handle(parseAppPath(window.location.pathname), 'pop');
      // Accepted: this is the new address. Refused: restore() already wrote the previous one.
      lastUrl.current = currentUrl();
    };
    const onNavigate = (event: Event) => {
      const detail = (event as CustomEvent<NavigateDetail>).detail;
      if (!detail || typeof detail.path !== 'string' || !detail.path.startsWith('/')) return;
      const { path, rest } = splitUrl(detail.path);
      const route = parseAppPath(path);
      if (route.kind === 'packing' || !opts.current.enabled) {
        handle(route, 'push');
        return;
      }
      if (samePath(window.location.pathname, path)) {
        if (rest) writeHistory(window.location.pathname + rest, !!detail.replace);
        return;
      }
      pending.current = { replace: !!detail.replace, rest };
      handle(route, 'push');
    };
    const onRoute = () => {
      lastUrl.current = currentUrl();
    };
    window.addEventListener('popstate', onPop);
    window.addEventListener(NAVIGATE_EVENT, onNavigate);
    window.addEventListener(ROUTE_EVENT, onRoute);
    return () => {
      window.removeEventListener('popstate', onPop);
      window.removeEventListener(NAVIGATE_EVENT, onNavigate);
      window.removeEventListener(ROUTE_EVENT, onRoute);
    };
  }, []);

  // State -> address.
  const { page, orderId, filter } = options.view;
  useEffect(() => {
    if (!options.enabled || !booted || resolving) return;
    let path: string;
    if (orderId) {
      const number = numbers.current.get(orderId);
      if (!number) {
        let live = true;
        api<OrderRef>(`/orders/${orderId}/ref`)
          .then((ref) => live && remember(ref))
          .catch(() => live && numbers.current.set(orderId, orderId))
          .finally(() => live && setTick((t) => t + 1));
        return () => {
          live = false;
        };
      }
      path = orderPath(number);
    } else path = page === 'orders' ? orderStatusPath(filter) : pagePath(page);
    const { replace, rest } = pending.current;
    pending.current = { replace: false, rest: null };
    if (!samePath(window.location.pathname, path))
      writeHistory(path + (rest ?? (replace ? window.location.search + window.location.hash : '')), replace);
    else if (rest !== null && rest !== window.location.search + window.location.hash) writeHistory(window.location.pathname + rest, replace);
    lastUrl.current = currentUrl();
  }, [options.enabled, booted, resolving, page, orderId, filter.status, filter.workflow, tick]);

  return {
    /** Remember an order's number (e.g. from a list row), so its address needs no lookup. */
    rememberOrder: (id: string, number: string) => numbers.current.set(id, number),
    resolving,
  };
}
