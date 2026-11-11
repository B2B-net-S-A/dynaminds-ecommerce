import type { PoolClient } from 'pg';
import type { AuditActor } from './domain';
import type { PackingActor } from './packing-workstation-schema';
import { ensure } from './errors';
import { createHash } from 'node:crypto';
import { paymentBalance } from './payments';
export function packingStableHash(v: any): string {
  const canonical = (x: any): any =>
    Array.isArray(x)
      ? x.map(canonical)
      : x && typeof x === 'object'
        ? Object.fromEntries(
            Object.keys(x)
              .sort()
              .filter((k) => x[k] !== undefined)
              .map((k) => [k, canonical(x[k])]),
          )
        : x;
  return createHash('sha256')
    .update(JSON.stringify(canonical(v)))
    .digest('hex');
}
export type PackingTransitionContext = {
  receipt_id: string;
  preview_id: string;
  scope_hash: string;
  session_id?: string | null;
};
export type PackingScanContext = {
  session_id: string;
  session_version: string;
  lease_generation: string;
  lease_token_hash: string;
};
export async function packingWorkstationAvailable(c: PoolClient) {
  return Boolean(
    (await c.query("SELECT to_regclass('public.packing_receipts') IS NOT NULL AS available"))
      .rows[0].available,
  );
}
export async function assertPackingActorInTx(
  c: PoolClient,
  a: PackingActor,
  write = false,
  adminOnly = false,
) {
  ensure(await packingWorkstationAvailable(c), 503, 'Kopia nie zawiera stanowiska pakowania');
  const role = (await c.query('SELECT packing_current_role($1,$2) AS role', [a.userId, write]))
    .rows[0].role as string | null;
  ensure(role, 403, 'Brak bieżącego dostępu do firmy');
  ensure(
    !write || role === 'admin' || (!adminOnly && role === 'operator'),
    403,
    'Brak uprawnień do pakowania',
  );
  if (write && a.apiKeyId) {
    const grant = (
      await c.query('SELECT packing_key_grant($1,$2,$3) AS grant_result', [
        a.userId,
        a.apiKeyId,
        Boolean(a.requireProductsRead),
      ])
    ).rows[0].grant_result;
    ensure(grant !== 'invalid', 401, 'Klucz API został odwołany lub wygasł');
    ensure(grant === 'ok', 403, 'Klucz API nie ma zakresów zamówień');
  }
  return role;
}
export async function packingFulfillmentHashInTx(c: PoolClient, o: any, statusOverride?: string) {
  return (
    await c.query('SELECT packing_fulfillment_hash($1,$2) AS hash', [
      typeof o === 'string' ? o : o.id,
      statusOverride ?? null,
    ])
  ).rows[0].hash as string;
}
export async function assertNoActivePackingInTx(c: PoolClient, orderId: string) {
  if (!(await packingWorkstationAvailable(c))) return;
  ensure(
    !(
      await c.query("SELECT 1 FROM packing_sessions WHERE order_id=$1 AND state='active'", [
        orderId,
      ])
    ).rowCount,
    409,
    'Zamówienie ma aktywną sesję pakowania',
  );
}
export async function assertPackingScanInTx(
  c: PoolClient,
  a: PackingActor,
  o: any,
  ctx?: PackingScanContext,
) {
  if (!(await packingWorkstationAvailable(c))) return;
  const s = (
    await c.query(
      "SELECT *,expires_at>clock_timestamp() AS valid FROM packing_sessions WHERE order_id=$1 AND state='active'",
      [o.id],
    )
  ).rows[0];
  if (!s) {
    ensure(!ctx, 409, 'Kontekst skanu nie ma aktywnej sesji');
    return;
  }
  ensure(
    ctx &&
      s.id === ctx.session_id &&
      s.version === ctx.session_version &&
      s.lease_generation === ctx.lease_generation &&
      s.lease_token_hash === ctx.lease_token_hash &&
      s.owner_id === a.userId &&
      s.valid,
    409,
    'Skan wymaga bieżącej własnej sesji i lease',
  );
}
export async function assertPackingTransitionInTx(
  c: PoolClient,
  a: PackingActor,
  o: any,
  ctx?: PackingTransitionContext,
) {
  if (!(await packingWorkstationAvailable(c))) return;
  const active = (
    await c.query("SELECT id FROM packing_sessions WHERE order_id=$1 AND state='active'", [o.id])
  ).rows[0];
  const policy = (
    await c.query(
      'SELECT require_parcel_profile FROM packing_policies WHERE tenant_id=$1 FOR SHARE',
      [a.tenantId],
    )
  ).rows[0];
  if (!ctx) {
    ensure(!active, 409, 'Zakończ pakowanie w aktywnej sesji');
    ensure(!policy?.require_parcel_profile, 409, 'Polityka wymaga dowodu pomiaru paczki');
    return;
  }
  const r = (
    await c.query(
      `SELECT r.*,p.scope_hash,p.session_id,p.ready,p.actor_id AS preview_actor FROM packing_receipts r JOIN packing_previews p ON (p.tenant_id,p.id)=(r.tenant_id,r.preview_id) WHERE r.id=$1 AND r.order_id=$2`,
      [ctx.receipt_id, o.id],
    )
  ).rows[0];
  ensure(
    r &&
      r.kind === 'finish' &&
      r.preview_id === ctx.preview_id &&
      r.scope_hash === ctx.scope_hash &&
      r.actor_id === a.userId &&
      r.preview_actor === a.userId &&
      r.ready &&
      r.before_order_version === String(o.version) &&
      r.before_fulfillment_hash === (await packingFulfillmentHashInTx(c, o)),
    409,
    'Nieprawidłowy kontekst zakończenia pakowania',
  );
  const s = (
    await c.query('SELECT * FROM packing_sessions WHERE id=$1 AND order_id=$2', [
      r.session_id,
      o.id,
    ])
  ).rows[0];
  ensure(
    s && s.state === 'finished' && s.owner_id === a.userId,
    409,
    'Brak autentycznej zakończonej sesji',
  );
  ensure(!(active && active.id !== s.id), 409, 'Zamówienie ma inną aktywną sesję');
}
export async function cancelPackingForOrderInTx(c: PoolClient, a: AuditActor, o: any) {
  if (!(await packingWorkstationAvailable(c))) return;
  await c.query(
    "UPDATE packing_sessions SET state='cancelled',version=version+1,finished_at=clock_timestamp() WHERE order_id=$1 AND state='active'",
    [o.id],
  );
}
export async function packingReceiptCurrentInTx(c: PoolClient, o: any, receiptId?: string) {
  if (!(await packingWorkstationAvailable(c)))
    return { receipt: null, profile: null, current: false, stale_reasons: ['MODULE_UNAVAILABLE'] };
  const profile =
    (await c.query('SELECT * FROM order_packing_profiles WHERE order_id=$1', [o.id])).rows[0] ??
    null;
  const receipt = profile
    ? ((
        await c.query('SELECT * FROM packing_receipts WHERE id=$1 AND order_id=$2', [
          receiptId ?? profile.receipt_id,
          o.id,
        ])
      ).rows[0] ?? null)
    : null;
  const stale_reasons: string[] = [];
  if (!profile || !receipt) stale_reasons.push('NO_PROFILE');
  else {
    if (profile.receipt_id !== receipt.id) stale_reasons.push('REPLACED_RECEIPT');
    if (profile.revision !== receipt.profile_revision)
      stale_reasons.push('PROFILE_REVISION_CHANGED');
    if (o.status !== 'packed') stale_reasons.push('ORDER_NOT_PACKED');
    if (String(o.version) !== receipt.after_order_version)
      stale_reasons.push('ORDER_VERSION_CHANGED');
    if (receipt.after_fulfillment_hash !== (await packingFulfillmentHashInTx(c, o)))
      stale_reasons.push('FULFILLMENT_CHANGED');
    if (receipt.full_snapshot.payment_hash !== packingStableHash(await paymentBalance(c, o.id)))
      stale_reasons.push('PAYMENT_CHANGED');
  }
  return { receipt, profile, current: stale_reasons.length === 0, stale_reasons };
}
