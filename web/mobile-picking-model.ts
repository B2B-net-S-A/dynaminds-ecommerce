import { ApiError } from './api';

export interface WaveDestination {
  order_id: string;
  number: string;
  slot: number;
  quantity: number;
  scanned: number;
  status: string;
}
export interface WaveGroup {
  product_id: string;
  sku: string;
  ean: string | null;
  name: string;
  location: string;
  quantity: number;
  scanned: number;
  destinations: WaveDestination[];
}
export interface WaveDetail {
  wave: { id: string; name: string; state: string; version: string; warehouse_name: string };
  groups: WaveGroup[];
  progress: { quantity: number; scanned: number; cancelled_orders: number };
}
export interface WaveScanInput {
  version: string;
  code: string;
  location: string;
  client_key: string;
}
export interface WaveScanReceipt {
  order_id: string;
  number: string;
  slot: number;
  sku: string;
  location: string;
}

// The same key as the desktop wave board, so an unconfirmed scan is recovered in either view.
export const waveScanStorageKey = (workspaceId: string, waveId: string): string =>
  'dyna.wave-scan.' + workspaceId + '.' + waveId;
export const groupKey = (g: Pick<WaveGroup, 'product_id' | 'location'>): string =>
  JSON.stringify([g.product_id, g.location]);

// Mirrors the server route order (server/picking-waves.ts grouped()): location, then SKU.
export function compareGroups(a: WaveGroup, b: WaveGroup): number {
  return (
    a.location.localeCompare(b.location, 'pl', { numeric: true }) ||
    a.sku.localeCompare(b.sku, 'pl', { numeric: true }) ||
    a.product_id.localeCompare(b.product_id)
  );
}

/** Remaining pick tasks in walking order; skipped tasks move to the end in the order they were skipped. */
export function pickQueue(groups: readonly WaveGroup[], skipped: readonly string[] = []): WaveGroup[] {
  const open = groups.filter((g) => g.scanned < g.quantity).sort(compareGroups);
  const later = new Map(skipped.map((key, i) => [key, i]));
  return [
    ...open.filter((g) => !later.has(groupKey(g))),
    ...open
      .filter((g) => later.has(groupKey(g)))
      .sort((a, b) => later.get(groupKey(a))! - later.get(groupKey(b))!),
  ];
}

export function pickStats(groups: readonly WaveGroup[]) {
  const tasks = groups.length,
    tasksDone = groups.filter((g) => g.scanned >= g.quantity).length;
  return {
    tasks,
    tasksDone,
    pieces: groups.reduce((n, g) => n + g.quantity, 0),
    scanned: groups.reduce((n, g) => n + g.scanned, 0),
  };
}

export const MAX_CODE_LENGTH = 80;
/** Builds the POST /api/picking-waves/:id/scans body; returns an error message instead when the code is unusable. */
export function scanPayload(
  detail: WaveDetail,
  code: string,
  location: string,
  clientKey: string,
): WaveScanInput | string {
  const trimmed = code.trim();
  if (!trimmed) return 'Zeskanuj lub wpisz kod produktu.';
  if (trimmed.length > MAX_CODE_LENGTH)
    return 'Odczytany kod ma ponad 80 znaków — to nie jest kod produktu z tej partii.';
  return { version: detail.wave.version, code: trimmed, location, client_key: clientKey };
}

/** A 4xx answer means the scan transaction was rejected and nothing was counted; anything else may have been applied. */
export const isDefinitiveRejection = (e: unknown): e is ApiError =>
  e instanceof ApiError && e.status >= 400 && e.status < 500;

export function readStored<T>(key: string): T | null {
  try {
    return JSON.parse(sessionStorage.getItem(key) ?? 'null');
  } catch {
    return null;
  }
}
export function writeStored(key: string, value: unknown | null): void {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be blocked (private mode); the pending scan stays in memory for this view.
  }
}
