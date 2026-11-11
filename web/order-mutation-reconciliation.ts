import { ApiError } from './api';
/** A lost response/JSON parse or server failure leaves the mutation outcome
 * unknown. Refresh closes the detail write gate synchronously; never resend.
 * Definite client/domain rejections keep their existing UI/status handling.
 */
export function reconcileUnknownOrderMutation(error: unknown, refresh: () => void): boolean {
  if (error instanceof ApiError && error.status < 500) return false;
  refresh();
  return true;
}
