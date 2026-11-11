/** Background fetch of purchase invoices (`ksef.purchase.fetch`, the jobs table; migration 243). One pending job per
 * NIP: a run (runPurchaseFetch, bounded below the 2-minute reaper of running jobs) marks its job done and queues the
 * next one — 30 min after a complete run, at once after an unfinished one, at Retry-After after a 429, with a
 * capped backoff after KSeF failures. KSeF problems never fail the job (the chain would stop after max_attempts);
 * only an unexpected database error is left to the generic retry of tick(). */
import { z } from 'zod';
import { tenantTx } from './db';
import { Problem } from './errors';
import { ensureFetchJobInTx, runPurchaseFetch, type Ksef243Options, type PurchaseRunResult } from './ksef243';
import { KSEF_PURCHASE_FETCH_JOB, nextPurchaseRunDelayMs } from './ksef243-model';

export { KSEF_PURCHASE_FETCH_JOB };
export type KsefPurchaseJob = { id: string; tenant_id: string; payload: unknown; lease_token: string | null };
const payload = z.object({ nip: z.string().regex(/^[0-9]{10}$/), actor_id: z.uuid(), failures: z.number().int().min(0).max(1000).default(0) });

export async function processKsefPurchaseFetchJob(job: KsefPurchaseJob, o: Ksef243Options = {}): Promise<PurchaseRunResult | null> {
  const p = payload.safeParse(job.payload);
  if (!p.success) throw new Problem(422, 'Nieprawidłowe zadanie pobierania faktur zakupowych');
  const { nip, actor_id, failures } = p.data;
  let r: PurchaseRunResult | null = null;
  try { r = await runPurchaseFetch({ tenantId: job.tenant_id, userId: actor_id, role: 'operator' }, nip, o); }
  catch (e) { if (!(e instanceof Problem && e.status === 404)) throw e; } // settings removed: the chain ends
  const failed = r !== null && ['rate_limited', 'unavailable', 'refused', 'error'].includes(r.outcome);
  const delay = r === null ? null : nextPurchaseRunDelayMs({ outcome: r.outcome, retryAfterMs: r.retry_after_ms, failures });
  await tenantTx(job.tenant_id, async c => {
    await c.query(`UPDATE jobs SET state='done',error=NULL,lease_token=NULL,locked_at=NULL,payload=jsonb_set(payload,'{result}',$3) WHERE id=$1 AND lease_token=$2`,
      [job.id, job.lease_token, JSON.stringify(r ? { outcome: r.outcome, pages: r.pages, stored: r.stored, rejected: r.rejected, completed_up_to: r.completed_up_to } : { outcome: 'removed' })]);
    if (delay !== null) await ensureFetchJobInTx(c, job.tenant_id, actor_id, nip, delay, failed && r!.outcome !== 'rate_limited' ? failures + 1 : 0);
  });
  return r;
}
