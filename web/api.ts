import { fulfilmentLabels } from './order-stage';
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}
let activeWorkspace: string | null = null;
let workspaceEpoch = 0;
export function setWorkspace(id: string | null) {
  // Another organization (or none) starts from the default region until its user arrives.
  if (id !== activeWorkspace) setRegion(null);
  activeWorkspace = id;
  ++workspaceEpoch;
}
/** The workspace sent as X-Workspace-ID, for the few raw fetches (file downloads) outside api(). */
export const currentWorkspace = (): string | null => activeWorkspace;
export async function api<T = any>(
  path: string,
  method = 'GET',
  body?: unknown,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
  onScopedResponse?: (data: unknown, response: Readonly<{ok: boolean; status: number; workspace: string | null}>) => void,
): Promise<T> {
  const scoped = path !== '/health';
  const workspace = scoped ? activeWorkspace : null;
  const epoch = workspaceEpoch;
  const res = await fetch('/api' + path, {
    method,
    ...(signal ? { signal } : {}),
    credentials: 'same-origin',
    headers: {
      ...(workspace ? { 'X-Workspace-ID': workspace } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(method === 'POST' && path === '/orders'
        ? { 'Idempotency-Key': crypto.randomUUID() }
        : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json();
  // Record only original response evidence; this observer cannot waive the scope rejection below.
  if (scoped) onScopedResponse?.(data, Object.freeze({ok: res.ok, status: res.status, workspace}));
  if (scoped && (workspace !== activeWorkspace || epoch !== workspaceEpoch))
    throw new Error('Organizacja została zmieniona. Odśwież widok.');
  if (!res.ok) {
    if (scoped && res.status === 401 && data.code === 'AUTH_SESSION_EXPIRED') {
      window.dispatchEvent(new CustomEvent('dyna:session-expired', { detail: { workspace } }));
      // Expiry synchronously suspends the workspace; do not purge unknown writes as a domain denial.
      if (workspace !== activeWorkspace || epoch !== workspaceEpoch)
        throw new Error('Sesja wygasła. Zaloguj się ponownie.');
    }
    if (data.code === 'MFA_REQUIRED')
      window.dispatchEvent(new CustomEvent('dyna:mfa-required', { detail: { workspace } }));
    throw new ApiError(data.detail ?? 'Nie udało się wykonać operacji', res.status, data.code);
  }
  return data;
}
/** Tenant region (ACCOUNT-002): locale and currency of the signed-in organization from
 * /api/auth/me; amounts and dates follow it. Unknown or missing values fall back to pl-PL/PLN. */
export type Region = { locale: string; currency: string };
const LOCALES = ['pl-PL', 'en-GB', 'de-DE', 'cs-CZ'];
const DEFAULT_REGION: Region = Object.freeze({ locale: 'pl-PL', currency: 'PLN' });
let region: Region = DEFAULT_REGION;
export function setRegion(source?: { locale?: unknown; currency?: unknown } | null) {
  const locale = typeof source?.locale === 'string' && LOCALES.includes(source.locale) ? source.locale : DEFAULT_REGION.locale;
  const currency = typeof source?.currency === 'string' && /^[A-Z]{3}$/.test(source.currency) ? source.currency : DEFAULT_REGION.currency;
  region = Object.freeze({ locale, currency });
}
export const currentRegion = (): Region => region;
export const money = (n: number, currency = region.currency) =>
  new Intl.NumberFormat(region.locale, { style: 'currency', currency }).format(n / 100);
export const date = (s: string) =>
  new Date(s).toLocaleString(region.locale, {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
// Order status codes (orders.status) with their labels from web/order-stage.ts, so lists, filters and the card
// read the same words: new is a prepaid order waiting for payment ("Czeka na wpłatę"), paid is an order ready to
// fulfil ("Nowe"). Only stored codes are keys: the derived 'ready_to_ship' is not, as automation stages iterate them.
export const statusNames: Record<string, string> = Object.fromEntries(
  (
    ['new', 'paid', 'picking', 'packed', 'shipped', 'delivered', 'completed', 'cancelled', 'return_initiated', 'return_received', 'return_completed'] as const
  ).map((s) => [s, fulfilmentLabels[s]]),
);
