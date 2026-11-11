import type { PoolClient } from 'pg';
import type { AuditActor, Actor } from './domain';
import { ensure, Problem } from './errors';
import { allocateParcelReturnFragments, decideParcelReturnClaims, type ParcelReturnClaim } from './order-parcel-return-values';

export async function parcelReturnRequiredInTx(c: PoolClient, orderId: string): Promise<boolean> {
  const present = (await c.query("SELECT to_regclass('order_parcel_plans') IS NOT NULL p")).rows[0].p;
  if (!present) return false;
  const required = (await c.query("SELECT EXISTS(SELECT 1 FROM order_parcel_plans WHERE order_id=$1 AND payload->>'protocol'='commercial_v1') r", [orderId])).rows[0].r;
  if (!required) return false;
  const installed = (await c.query("SELECT to_regprocedure('order_parcel_return_installed()') IS NOT NULL p")).rows[0].p;
  ensure(installed && (await c.query('SELECT order_parcel_return_installed() p')).rows[0].p, 503, 'Niekompletny moduł pochodzenia zwrotów');
  return true;
}

export async function parcelReturnOriginsInTx(c: PoolClient, orderId: string, returnId?: string) {
  if (!await parcelReturnRequiredInTx(c, orderId)) return { required: false, origins: [] as any[] };
  const origins = (await c.query(`SELECT o.id origin_id,o.item_id,d.dispatch_id,o.parcel_index,o.shipment_id,d.quantity,o.snapshot->'components' components,o.snapshot,
    coalesce((SELECT sum(CASE WHEN r.state='requested' THEN cl.quantity WHEN r.state IN('refund_pending','closed') THEN coalesce((SELECT sum((x->>'accepted')::int) FROM order_parcel_return_receipts z CROSS JOIN LATERAL jsonb_array_elements(z.payload->'decisions') x WHERE z.return_id=cl.return_id AND x->>'origin_id'=cl.origin_id::text),0) ELSE 0 END) FROM order_parcel_return_claims cl JOIN return_cases r ON(r.tenant_id,r.id)=(cl.tenant_id,cl.return_id) WHERE cl.origin_id=o.id AND($2::uuid IS NULL OR cl.return_id<>$2)),0)::int committed,
    coalesce((SELECT jsonb_agg(jsonb_build_object('fragment_id',f.fragment_id,'product_id',f.product_id,'quantity',f.quantity,'available',greatest(0,f.quantity-coalesce((SELECT sum((x->>'quantity')::int) FROM order_parcel_return_receipts z CROSS JOIN LATERAL jsonb_array_elements(z.payload->'fragments') x WHERE x->>'origin_id'=o.id::text AND x->>'fragment_id'=f.fragment_id::text),0))) ORDER BY f.product_id,f.fragment_id) FROM order_parcel_origin_fragments f WHERE(f.tenant_id,f.origin_id,f.dispatch_id)=(o.tenant_id,o.id,d.dispatch_id)),'[]') fragments,
    cl.quantity requested,cl.ordinal
    FROM order_parcel_commercial_origins o JOIN order_parcel_origin_issues d ON(d.tenant_id,d.origin_id)=(o.tenant_id,o.id)
    LEFT JOIN order_parcel_return_claims cl ON(cl.tenant_id,cl.origin_id,cl.return_id)=(o.tenant_id,o.id,$2)
    WHERE o.order_id=$1 AND($2::uuid IS NULL OR cl.return_id=$2) ORDER BY cl.ordinal NULLS LAST,o.parcel_index,o.item_id`, [orderId, returnId ?? null])).rows;
  return { required: true, origins: origins.map(o => ({ ...o, available: Math.max(0, o.quantity - o.committed) })) };
}

async function sql<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) {
    const x = e as { code?: string; message?: string };
    if (x.code === '55000') throw new Problem(503, 'Niekompletny moduł pochodzenia zwrotów');
    if (['23514', '23503', '23505'].includes(x.code ?? '')) {
      if (x.message === 'Klucz paczek jest nieaktualny') throw new Problem(401, x.message);
      if (x.message === 'Brak aktualnego uprawnienia do paczek') throw new Problem(403, x.message);
      throw new Problem(409, x.message ?? 'Pochodzenie zwrotu zmieniło się');
    }
    throw e;
  }
}
function actor(a: AuditActor): Actor {
  ensure(a.userId && a.role && a.role !== 'viewer', 403, 'Zwrot z częściowej wysyłki wymaga uprawnienia operatora');
  return { ...a, userId: a.userId, role: a.role, source: a.source === 'api' ? 'api' : 'manual' };
}
async function pin(c: PoolClient, a: Actor) {
  const g = (await sql(() => c.query('SELECT order_parcel_access($1,$2,true,true) g', [a.userId, a.apiKeyId ?? null]))).rows[0].g;
  ensure(g.key_valid, 401, 'Klucz paczek jest nieaktualny');
  ensure(g.allowed, 403, 'Brak aktualnego uprawnienia do paczek');
}
export async function finishParcelReturnAccessInTx(c: PoolClient, a: AuditActor, enabled: boolean) {
  if (!enabled) return;
  await sql(() => c.query('SET CONSTRAINTS ALL IMMEDIATE'));
  await pin(c, actor(a));
}
export async function lockParcelReturnOrderInTx(c: PoolClient, a: AuditActor, orderId: string) {
  if (!await parcelReturnRequiredInTx(c, orderId)) return false;
  const current = actor(a);
  await sql(() => c.query('SELECT order_parcel_return_lock($1,$2,$3)', [orderId, current.userId, current.apiKeyId ?? null]));
  return true;
}
export async function prepareParcelReturnDecisionInTx(c: PoolClient, a: AuditActor, orderId: string, returnId: string, input: unknown) {
  if (!await parcelReturnRequiredInTx(c, orderId)) return false;
  const current = actor(a);
  await sql(() => c.query('SELECT order_parcel_return_decision($1,$2,$3,$4)', [returnId, current.userId, current.apiKeyId ?? null, input]));
  return true;
}
export async function prepareParcelReturnRequestInTx(c: PoolClient, a: AuditActor, orderId: string, returnId: string, input: unknown, legacy: boolean, submittedBy: string) {
  if (!await parcelReturnRequiredInTx(c, orderId)) {
    ensure(!(input as any)?.parcel_origins, 409, 'Zamówienie nie ma zatwierdzonego pochodzenia handlowego paczek');
    return false;
  }
  ensure(!legacy && submittedBy === 'operator', 409, 'Ten zwrot z paczki obsłuż przez jawną sprawę operatora');
  const current = actor(a);
  await sql(() => c.query('SELECT order_parcel_return_request($1,$2,$3,$4,$5)', [orderId, returnId, current.userId, current.apiKeyId ?? null, input]));
  return true;
}
export async function finishParcelReturnRequestInTx(c: PoolClient, a: AuditActor, returnId: string, enabled: boolean) {
  if (!enabled) return;
  const current = actor(a);
  await sql(() => c.query('SELECT order_parcel_return_finish_request($1,$2,$3)', [returnId, current.userId, current.apiKeyId ?? null]));
  await sql(() => c.query('SET CONSTRAINTS ALL IMMEDIATE'));
  await pin(c, current);
}
export async function prepareParcelReturnReceiveInTx(c: PoolClient, a: Actor, orderId: string, returnId: string, input: any) {
  const scope = await parcelReturnOriginsInTx(c, orderId, returnId);
  if (!scope.required) return false;
  const claims: ParcelReturnClaim[] = scope.origins.map(o => ({ ...o, quantity: o.requested }));
  ensure(claims.length > 0, 409, 'Brak potwierdzonego źródła zgłoszenia');
  const decisions = decideParcelReturnClaims(claims, input.items);
  const wms = (await c.query('SELECT EXISTS(SELECT 1 FROM wms_policies WHERE enabled) p')).rows[0].p;
  const fragments = wms ? allocateParcelReturnFragments(claims, decisions, input.wms_lots?.picks ?? []) : [];
  await sql(() => c.query('SELECT order_parcel_return_prepare_receive($1,$2,$3,$4,$5)', [returnId, a.userId, a.apiKeyId ?? null, input, { decisions, fragments }]));
  return true;
}
/** Creates the actual native receipt and physical seal; outer core/replacement
 * writes must already be complete before this phase. No flush or IAM PIN. */
export async function completeParcelReturnReceiveInTx(c: PoolClient, a: Actor, returnId: string, enabled: boolean): Promise<string | null> {
  if (!enabled) return null;
  await sql(() => c.query('SELECT order_parcel_return_finish_receive($1,$2,$3)', [returnId, a.userId, a.apiKeyId ?? null]));
  return returnId;
}
/** Native current actor/key PIN only; the outer coordinator owns the terminal
 * full constraint flush after all native receipts and remaining writes. */
export async function pinParcelReturnReceiveInTx(c: PoolClient, a: Actor, enabled: boolean) {
  if (!enabled) return;
  await pin(c, a);
}
/** Existing standalone callers retain complete → ALL IMMEDIATE → fresh PIN. */
export async function finishParcelReturnReceiveInTx(c: PoolClient, a: Actor, returnId: string, enabled: boolean) {
  if (!enabled) return;
  await completeParcelReturnReceiveInTx(c, a, returnId, enabled);
  await sql(() => c.query('SET CONSTRAINTS ALL IMMEDIATE'));
  await pinParcelReturnReceiveInTx(c, a, enabled);
}
