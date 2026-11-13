/** A schema guard evaluated through guard_verdict() that cannot run on this database: a module it checks was
 * removed or is torn, so the guard raises 55000 (object_not_in_prerequisite_state, e.g. "209 complete source
 * installation required") or 42883 (undefined_function, a helper it calls is gone) instead of answering false.
 * That is an incomplete module, like a guard answering false, so the request is refused with 503 and nothing is
 * written (its transaction rolled back). Only errors raised inside guard_verdict() count; message and PL/pgSQL
 * context stay in the server log. */
export const INCOMPLETE_MODULE_DETAIL = 'Niekompletny moduł bazy danych; kontrola schematu nie może się wykonać';

export function incompleteModuleGuardError(err: unknown): boolean {
  try {
    if (!err || typeof err !== 'object') return false;
    const { code, where } = err as { code?: unknown; where?: unknown };
    return (code === '55000' || code === '42883') && typeof where === 'string' && /\bguard_verdict\(text\)/.test(where);
  } catch {
    return false;
  }
}
