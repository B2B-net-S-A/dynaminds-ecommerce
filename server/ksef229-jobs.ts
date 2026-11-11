/** Background KSeF status job (`ksef.status`, the jobs table, no own schema): queued by a send that
 * left an invoice processed by KSeF ("sent") or uncertain (its answer lost and KSeF unreachable for
 * the check). The job only reads — it polls the invoice or looks for the file in the stored session
 * — and never sends. While KSeF still processes the invoice it fails with a Problem, so the generic
 * retry of tick() reads again with backoff (up to max_attempts); "Sprawdź status" stays available. */
import { z } from 'zod';
import { tenantTx } from './db';
import { Problem } from './errors';
import { reconcileDocument, type KsefActor, type KsefNetOptions } from './ksef229';

export const KSEF_STATUS_JOB = 'ksef.status';
export type KsefStatusJob = { id: string; tenant_id: string; payload: unknown; lease_token: string | null };
const payload = z.object({ submission_id: z.uuid(), document_id: z.uuid(), actor_id: z.uuid() });

export async function processKsefStatusJob(job: KsefStatusJob, net: KsefNetOptions = {}): Promise<void> {
  const p = payload.safeParse(job.payload);
  if (!p.success) throw new Problem(422, 'Nieprawidłowe zadanie odczytu statusu KSeF');
  const actor: KsefActor = { tenantId: job.tenant_id, userId: p.data.actor_id, role: 'operator' };
  const view = await reconcileDocument(actor, p.data.document_id, net), s = view.submission;
  // Read again only while KSeF processes it, or could not be asked (a 440 not confirmed will not change
  // by waiting; a newer submission, or none, was settled elsewhere).
  const again = s !== null && s.id === p.data.submission_id && (s.state === 'sent' || (s.state === 'queued' && s.last_error !== null && s.status?.code !== 440));
  if (again) throw new Problem(409, s.state === 'sent' ? 'KSeF jeszcze przetwarza fakturę; odczyt statusu zostanie ponowiony' : 'KSeF nie odpowiedział na odczyt; odczyt zostanie ponowiony');
  await tenantTx(job.tenant_id, c => c.query(`UPDATE jobs SET state='done',error=NULL,lease_token=NULL,locked_at=NULL,payload=jsonb_set(payload,'{result}',$3) WHERE id=$1 AND lease_token=$2`,
    [job.id, job.lease_token, JSON.stringify({ state: s?.state ?? null, ksef_number: s?.ksef_number ?? null })]));
}
