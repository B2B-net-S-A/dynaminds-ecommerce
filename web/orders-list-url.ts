/**
 * Order list state in the page URL, so back and refresh keep the filters (Uwagi v3 §3).
 * The list reads and writes the query string through the app router (web/app-route.ts), which owns the path:
 * the status lives in the path (/zamowienia/status/<slug>) whenever the path can express it.
 */
import { orderStatusPath, setRouteQuery } from './app-route';

export function readListQuery(): URLSearchParams {
  try {
    return new URLSearchParams(location.search);
  } catch {
    return new URLSearchParams();
  }
}

/** True when the status filter has its own address, so the query must not repeat it. */
export const statusInPath = (filter: { status: string; workflow: string }): boolean =>
  orderStatusPath(filter) !== '/zamowienia';

/** Replaces the query string (no new history entry per filter change); the path and hash stay. */
export function writeListQuery(query: URLSearchParams): void {
  try {
    setRouteQuery(query, { replace: true });
  } catch {
    // Without history (embedded preview) the filters still work, they are just not kept in the URL.
  }
}
