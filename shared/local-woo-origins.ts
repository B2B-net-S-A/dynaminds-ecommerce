/** Finite owned local stores only. These origins grant no channel, IAM or credential authority. */
export const LOCAL_WOO_ORIGIN = 'https://localhost:8443' as const;
export const LOCAL_WOO_SCALE_ORIGINS = Object.freeze([
  'https://localhost:18443',
  'https://localhost:18444',
  'https://localhost:18445',
  'https://localhost:18446',
  'https://localhost:18447',
] as const);
export const LOCAL_WOO_ORIGINS = Object.freeze([
  LOCAL_WOO_ORIGIN, 'https://localhost:8444', ...LOCAL_WOO_SCALE_ORIGINS,
] as const);
export type LocalWooOrigin = typeof LOCAL_WOO_ORIGINS[number];
export const MAX_LOCAL_WOO_STORES = 5;
export function isLocalWooOrigin(value: unknown): value is LocalWooOrigin {
  return typeof value === 'string' && (LOCAL_WOO_ORIGINS as readonly string[]).includes(value);
}
