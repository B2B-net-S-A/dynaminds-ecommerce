/** AUTO-04: the operator's decision for an SMS or email whose send started and returned no result
 * (state 'uncertain'). The operator checks the provider and records "sent" (with the provider's
 * reference when known) or "not sent". Only "not sent" opens a retry, and a retry is a NEW preview
 * batch: a new message id, so a new SMSAPI idx / SMTP Message-ID, approved through the usual queue
 * route. Nothing here contacts a provider or queues a job. No migration: the decision lives in the
 * existing state/error/result columns, which the payload-immutability triggers leave writable. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool, tenantTx } from './db';
import { ensure } from './errors';
import { audit, type Actor } from './domain';
import { smsBatch, smsPrepare } from './sms';
import { emailBatch, prepareEmail } from './email';
import { lockEmailQueue } from './email-actions';
import { requireSmsLiveAuthority, smsLiveRequestAuthority } from './sms-live-authority';

export type MessageKind = 'sms' | 'email';
export type MessageOutcome = 'sent' | 'not_sent';
const PREVIEW_TTL_MS = 30 * 60000;
export const messageDecision = z
  .object({
    outcome: z.enum(['sent', 'not_sent']),
    // SMSAPI message id or an SMTP Message-ID such as <id@host>.
    provider_ref: z.string().trim().regex(/^[A-Za-z0-9._:@<>+=-]{1,200}$/).optional(),
    evidence: z.string().trim().min(10).max(500),
    confirmed: z.literal(true),
  })
  .strict();
export const messageRetry = z.object({ client_key: z.uuid() }).strict();
/** The state a confirmed "sent" takes: the success state the worker would have written for the mode. */
export function sentState(kind: MessageKind, mode: string): string {
  if (kind === 'email') return mode === 'smtp' ? 'smtp_accepted' : 'simulated';
  return mode === 'provider_live' ? 'submitted' : mode === 'provider_test' ? 'tested' : 'simulated';
}
/** A replay is the same outcome and provider reference; anything else is a second, conflicting decision. */
export function sameDecision(result: any, outcome: MessageOutcome, providerRef: string | null): boolean {
  return result?.scope === 'manual_confirmation' && result.resolution === outcome && (result.provider_ref ?? null) === providerRef;
}
const tables = { sms: { messages: 'sms_messages', batches: 'sms_batches' }, email: { messages: 'email_messages', batches: 'email_batches' } } as const;
async function locked(c: PoolClient, a: Actor, kind: MessageKind, id: string) {
  // Same lock order as processEmail: the tenant's email queue lock before the message row.
  if (kind === 'email') await lockEmailQueue(c, a.tenantId);
  const t = tables[kind];
  const m = (
    await c.query(
      `SELECT m.*,to_jsonb(b) AS batch,j.state AS job_state FROM ${t.messages} m JOIN ${t.batches} b ON(b.tenant_id,b.id)=(m.tenant_id,m.batch_id)
       LEFT JOIN jobs j ON(j.tenant_id,j.id)=(m.tenant_id,m.job_id) WHERE m.id=$1 FOR UPDATE OF m`,
      [id],
    )
  ).rows[0];
  ensure(m, 404, kind === 'sms' ? 'Nie znaleziono wiadomości SMS' : 'Nie znaleziono wiadomości email');
  return m;
}
/** SMSAPI evidence that already settles a live SMS: an accepted receipt, or a delivery report for its idx. */
async function smsLiveEvidence(c: PoolClient, id: string) {
  return (
    await c.query(
      'SELECT (SELECT provider_id IS NOT NULL FROM sms_delivery_submissions WHERE message_id=$1) accepted,EXISTS(SELECT 1 FROM sms_delivery_events WHERE message_id=$1) reported',
      [id],
    )
  ).rows[0];
}
export async function decideMessageOutcome(c: PoolClient, a: Actor, kind: MessageKind, id: string, b: z.infer<typeof messageDecision>) {
  ensure(b.outcome === 'sent' || !b.provider_ref, 422, 'Identyfikator dostawcy podaje się tylko dla wysłanej wiadomości');
  const m = await locked(c, a, kind, id),
    ref = b.provider_ref ?? null;
  if (m.state !== 'uncertain') {
    ensure(m.result?.scope === 'manual_confirmation', 409, 'Wynik tej wiadomości jest znany; nie ma czego uzgadniać');
    ensure(sameDecision(m.result, b.outcome, ref), 409, 'Wynik tej wiadomości został już rozstrzygnięty inaczej');
    return { kind, id, state: m.state, resolution: b.outcome, provider_ref: ref, replayed: true };
  }
  ensure(m.attempted_at && !['pending', 'running'].includes(m.job_state), 409, 'Wysyłka nie została rozpoczęta albo jeszcze trwa');
  if (kind === 'sms' && m.batch.mode === 'provider_live') {
    const e = await smsLiveEvidence(c, id);
    ensure(!e.accepted, 409, 'SMSAPI przyjęło tę wiadomość; wynik jest znany');
    ensure(b.outcome === 'sent' || !e.reported, 409, 'SMSAPI przysłało raport dla tej wiadomości; nie można uznać jej za niewysłaną');
  }
  const state = b.outcome === 'sent' ? sentState(kind, m.batch.mode) : 'failed';
  const result = {
    scope: 'manual_confirmation',
    resolution: b.outcome,
    provider_ref: ref,
    evidence: b.evidence,
    decided_by: a.userId,
    decided_at: new Date().toISOString(),
    previous_error: m.error ?? null,
    previous_result: m.result ?? null,
  };
  await c.query(`UPDATE ${tables[kind].messages} SET state=$2,error=$3,result=$4,updated_at=now() WHERE id=$1 AND state='uncertain'`, [
    id,
    state,
    b.outcome === 'sent' ? null : 'Operator potwierdził u dostawcy: nie wysłano. Ponowienie tylko jako nowa wysyłka.',
    JSON.stringify(result),
  ]);
  await audit(c, a, kind + '.outcome.manual', id, { outcome: b.outcome, provider_ref: ref, evidence: b.evidence, mode: m.batch.mode, state });
  return { kind, id, state, resolution: b.outcome, provider_ref: ref, replayed: false };
}
/** A retry batch that never went out (cancelled, or its preview expired) does not block another retry. */
async function retryStillOpen(c: PoolClient, kind: MessageKind, batchId: string) {
  const r = (await c.query(`SELECT state,created_at FROM ${tables[kind].batches} WHERE id=$1`, [batchId])).rows[0];
  if (!r || r.state === 'cancelled') return false;
  return r.state !== 'preview' || Date.now() - new Date(r.created_at).getTime() < PREVIEW_TTL_MS;
}
export async function retryMessage(c: PoolClient, a: Actor, kind: MessageKind, id: string, clientKey: string, live?: () => Promise<void>) {
  const m = await locked(c, a, kind, id);
  ensure(
    m.state === 'failed' && m.result?.scope === 'manual_confirmation' && m.result.resolution === 'not_sent',
    409,
    'Ponowić można tylko wiadomość potwierdzoną u dostawcy jako niewysłana',
  );
  const prior = m.result.retry;
  if (prior?.client_key === clientKey) return kind === 'sms' ? smsBatch(c, prior.batch_id) : emailBatch(c, prior.batch_id);
  ensure(!prior || !(await retryStillOpen(c, kind, prior.batch_id)), 409, 'Ponowna wysyłka tej wiadomości jest już przygotowana');
  const b = m.batch;
  let batch: any;
  if (kind === 'sms') {
    if (b.mode === 'provider_live') await live?.();
    batch = await smsPrepare(c, a, {
      template_id: b.template_id,
      template_version: String(b.template_version),
      order_ids: [m.order_id],
      mode: b.mode,
      ...(b.channel_id ? { channel_id: b.channel_id } : {}),
      ...(b.delivery_endpoint_id ? { delivery_endpoint_id: b.delivery_endpoint_id } : {}),
      client_key: clientKey,
    });
  } else {
    ensure(!b.inbound_reply_preview_id, 409, 'Odpowiedź na wiadomość klienta przygotuj ponownie w wątku');
    batch = await prepareEmail(c, a, {
      template_id: b.template_id,
      template_version: String(b.template_version),
      order_ids: [m.order_id],
      mode: b.mode,
      ...(b.channel_id ? { channel_id: b.channel_id } : {}),
      client_key: clientKey,
    });
  }
  const fresh = batch.items[0];
  await c.query(`UPDATE ${tables[kind].messages} SET result=result||$2::jsonb,updated_at=now() WHERE id=$1`, [
    id,
    JSON.stringify({ retry: { batch_id: batch.id, message_id: fresh?.id ?? null, client_key: clientKey, prepared_by: a.userId, prepared_at: new Date().toISOString() } }),
  ]);
  await audit(c, a, kind + '.outcome.retry', id, { batch_id: batch.id, message_id: fresh?.id ?? null, replaced: prior?.batch_id ?? null });
  return batch;
}
function decider(req: FastifyRequest, readOnly: boolean) {
  const r = req as FastifyRequest & { actor: Actor & { apiKeyId?: string }; apiScopes?: string[] };
  ensure(['admin', 'operator'].includes(r.actor?.role) && !r.actor.apiKeyId && !r.apiScopes, 403, 'Wynik wiadomości rozstrzyga administrator lub operator');
  ensure(!readOnly, 423, 'Podgląd kopii nie zapisuje decyzji');
  return r.actor;
}
const params = z.object({ kind: z.enum(['sms', 'email']), id: z.uuid() });
export function registerMessageOutcomeRoutes(app: FastifyInstance, o: { readOnly: boolean; sessionName: string }) {
  app.post('/api/operations/reconciliation-queue/:kind/:id/decision', (req) => {
    const a = decider(req, o.readOnly),
      p = params.parse(req.params),
      b = messageDecision.parse(req.body);
    return tenantTx(a.tenantId, (c) => decideMessageOutcome(c, a, p.kind, p.id, b));
  });
  app.post('/api/operations/reconciliation-queue/:kind/:id/retry', (req) => {
    const a = decider(req, o.readOnly),
      p = params.parse(req.params),
      b = messageRetry.parse(req.body);
    // A live SMS preview needs the same MFA session authority as /api/sms/preview.
    const live = () => requireSmsLiveAuthority(pool, smsLiveRequestAuthority(req as any, o.sessionName));
    return tenantTx(a.tenantId, (c) => retryMessage(c, a, p.kind, p.id, b.client_key, live));
  });
}
