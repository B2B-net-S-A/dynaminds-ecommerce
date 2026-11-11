/** Keyset cursor of a list ordered by created_at DESC, id DESC: "<UTC microseconds>|<uuid>", as in the
 * repricing history. The SQL column that feeds it is KEYSET_AT. A malformed cursor is a 422. */
import { Problem } from './errors';

export const KEYSET_AT = `to_char(e.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const CURSOR = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
export const keysetCursor = (at: string, id: string): string => `${at}|${id}`;
export function keysetAfter(after: string | undefined, message: string): { at: string | null; id: string | null } {
  if (after === undefined) return { at: null, id: null };
  const m = CURSOR.exec(after);
  if (!m || !Number.isFinite(Date.parse(m[1]!))) throw new Problem(422, message);
  return { at: m[1]!, id: m[2]! };
}
