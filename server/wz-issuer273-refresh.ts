/** 273 (docs/parity/WZ-ISSUER-GEN273-20261029.md): records the WZ issuer verdict outside a request's statement budget.
 * After every cold approval the wz_issuer239_verdict() record is stale. A request heals it only when its own full guard
 * (~2.5 s idle, over 8 s under load) finishes inside the 8 s request budget and its transaction commits; otherwise every
 * later request misses again. The refresh is one owner transaction, READ COMMITTED READ WRITE, with the finite cold
 * budget, that asks wz_issuer273_refresh(): the same wz_issuer239_verdict() (a hit, or the full guard whose true it
 * records) behind a lock it never waits for. It adds no trust: any such transaction may record the verdict. */
import type { Pool } from 'pg';

/** true/false: the verdict's answer (the full guard's on a miss); null: 273 not installed, or another session refreshes. */
export async function refreshWzIssuerVerdict(p: Pool): Promise<boolean | null> {
  const c = await p.connect();
  let broken: Error | undefined;
  try {
    await c.query('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE');
    await c.query("SET LOCAL statement_timeout='120s'");
    const present = (await c.query("SELECT to_regprocedure('public.wz_issuer273_refresh()') present")).rows[0].present;
    const answer = present ? (await c.query('SELECT public.wz_issuer273_refresh() r')).rows[0].r as boolean | null : null;
    await c.query('COMMIT');
    return answer;
  } catch (e) {
    // A connection that cannot even roll back is discarded, not returned to the pool.
    await c.query('ROLLBACK').catch((r: unknown) => { broken = r instanceof Error ? r : new Error('rollback failed'); });
    throw e;
  } finally { c.release(broken); }
}

let inFlight: Promise<boolean | null> | null = null;
/** Background refresh after a request's miss ran out of its budget: at most one per process; failures are logged
 * with their SQLSTATE only (pool errors may carry connection details, see server/db.ts). */
export function scheduleWzIssuerRefresh(p: Pool): Promise<boolean | null> {
  inFlight ??= refreshWzIssuerVerdict(p).catch((e: unknown) => {
    const code = (e as { code?: unknown } | null)?.code;
    console.error(JSON.stringify({ level: 'error', step: 'wz_issuer273.refresh', code: typeof code === 'string' ? code : null }));
    return null;
  }).finally(() => { inFlight = null; });
  return inFlight;
}
