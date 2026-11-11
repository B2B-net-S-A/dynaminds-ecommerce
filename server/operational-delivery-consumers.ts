import { drainPublicConstraintsInTx } from './public-constraint-drain';
/** Managed167 consumer adapter. No top-level app/db evaluation.
 * SQL-role proof authenticates source tuples, not HTTP credentials or GCM plaintext.
 * Caller starts a writable transaction even for zero-persistent-DML reads, supplies
 * actual request custody, enlists before native frame calls, and finalizes LAST.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ensure, Problem } from './errors';
import type { Actor } from './domain';
import type { BuyerAddressRequest } from './buyer-address';
import { deliveryBindingInTx } from './buyer-address';
import {
  validateBuyerDeliveryAddress166,
  type BuyerDeliveryAddress166,
} from './buyer-delivery-address';

type Binding = { version: string; hash: string; delivery: BuyerDeliveryAddress166 };
type Authority =
  | { actor: Actor; hash: string; worker?: never }
  | {
      actor: Actor;
      hash?: never;
      worker: {
        client: PoolClient;
        intentId: string;
        orderId: string;
        basisHash: string;
        previewKey: string;
        queueKey: string;
      };
    };
type Duty = {
  authority: Authority;
  orderId: string;
  consumer: 'label' | 'parcel';
  key: string;
  binding: Binding;
};
const authorities = new WeakMap<Actor, Authority>();
type Transaction = { duties: Duty[]; available: boolean | undefined };
const transactions = new WeakMap<PoolClient, Transaction>();
/** Presence only; never authorization, admission or transaction readiness. */
export function hasOperationalDeliveryTransactionDuty(c:PoolClient){return Boolean(transactions.get(c)?.duties.length);}
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
function canonical(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object')
    return (
      '{' +
      Object.entries(v)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => JSON.stringify(k) + ':' + canonical(x))
        .join(',') +
      '}'
    );
  ensure(
    v === null || ['string', 'number', 'boolean'].includes(typeof v),
    422,
    'Invalid operative JSON',
  );
  return JSON.stringify(v);
}
function keyBytes(key: string) {
  ensure(/^[a-f0-9]{64}$/.test(key), 500, 'Missing operational encryption key');
  return Buffer.from(key, 'hex');
}
function encrypt(v: unknown, key: string) {
  const plain = Buffer.from(canonical(v), 'utf8');
  ensure(plain.length <= 16384, 413, 'Operational receiver evidence too large');
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', keyBytes(key), iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const encrypted = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
  return { encrypted, bytes: plain.length, digest: sha(encrypted) };
}
function decrypt(enc: string, bytes: number, digest: string, key: string): unknown {
  ensure(
    typeof enc === 'string' &&
      enc.length <= 22000 &&
      bytes > 0 &&
      bytes <= 16384 &&
      sha(enc) === digest,
    503,
    'Corrupt operational envelope',
  );
  const raw = Buffer.from(enc, 'base64');
  ensure(
    raw.toString('base64') === enc && raw.length === bytes + 28,
    503,
    'Corrupt operational envelope',
  );
  try {
    const decipher = createDecipheriv('aes-256-gcm', keyBytes(key), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const plain = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
    ensure(
      plain.length === bytes && Buffer.from(plain.toString('utf8'), 'utf8').equals(plain),
      503,
      'Invalid operational plaintext',
    );
    return JSON.parse(plain.toString('utf8'));
  } catch {
    throw new Problem(503, 'Cannot authenticate operational receiver evidence');
  }
}
/** Clone only the actual request actor after matching trusted current-user context.
 * Hash stays private; neither raw credentials nor ciphertext appears in errors. */
export function captureOperationalDeliveryAuthority(
  req: BuyerAddressRequest,
  sessionName: string,
): Actor {
  ensure(
    req.currentUser?.id === req.actor.userId && req.currentUser.tenant_id === req.actor.tenantId,
    401,
    'Operational actor context changed',
  );
  const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
  const credential = req.actor.apiKeyId ? bearer : (req.cookies[sessionName] ?? bearer);
  ensure(
    typeof credential === 'string' && credential.length > 0 && credential.length <= 4096,
    401,
    'Missing operational credential',
  );
  const actor = Object.freeze({ ...req.actor });
  authorities.set(actor, { actor, hash: sha(credential) });
  return actor;
}
/** Stored156 intention supplies the actor. This is a same-client worker admission,
 * not an HTTP actor clone or a credential substitute. Call after genuine native
 * resolve-frame and before the generated DEMO preview/queue. */
export async function captureOperationalPackedWorkerInTx(
  c: PoolClient,
  tenantId: string,
  intentId: string,
): Promise<Actor> {
  ensure(transactions.has(c), 500, 'Packed worker requires managed transaction');
  ensure(await operationalDeliveryConsumersAvailable(c), 503, 'Operational worker module absent');
  const row = (
    await c.query('SELECT operative_delivery_worker_head($1,$2) head', [tenantId, intentId])
  ).rows[0];
  const b = row.head.basis;
  ensure(
    b?.tenant_id === tenantId && b.intent_id === intentId,
    409,
    'Packed worker provenance changed',
  );
  const actor: Actor = Object.freeze({ tenantId, userId: b.actor_id, role: 'admin' });
  authorities.set(actor, {
    actor,
    worker: {
      client: c,
      intentId,
      orderId: b.order_id,
      basisHash: row.head.hash,
      previewKey: b.preview_key,
      queueKey: b.queue_key,
    },
  });
  return actor;
}
/** Supply the trusted owner preflight result obtained BEFORE borrowing this
 * transaction client. No additional pooled connection is borrowed in this TX. */
export function beginOperationalDeliveryTransaction(c: PoolClient, available?: boolean) {
  ensure(!transactions.has(c), 500, 'Operational transaction already begun');
  transactions.set(c, { duties: [], available });
}
export function endOperationalDeliveryTransaction(c: PoolClient) {
  transactions.delete(c);
}
/** Root calls this with its owner metadata reader BEFORE pool.connect/tenantTx.
 * This catches the ledger-only torn state even if every own symbol is deleted.
 * It never evaluates app/db modules or borrows another connection internally. */
export async function preflightOperationalDeliveryConsumers(
  owner: Pick<PoolClient, 'query'>,
): Promise<boolean> {
  return operationalDeliveryConsumersAvailable(owner);
}
export async function operationalDeliveryConsumersAvailable(
  c: Pick<PoolClient, 'query'>,
): Promise<boolean> {
  const { rows } = await c.query(
    `SELECT current_user role,EXISTS(SELECT FROM pg_class WHERE relnamespace='public'::regnamespace AND starts_with(relname,'operative_delivery_')) OR EXISTS(SELECT FROM pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'operative_delivery_')) OR EXISTS(SELECT FROM pg_trigger WHERE starts_with(tgname,'operative_delivery_')) remnants,to_regprocedure('public.operative_delivery_valid()') IS NOT NULL helper`,
  );
  const state = rows[0];
  if (state.role === 'dyna_app') {
    const prechecked = transactions.get(c as PoolClient)?.available;
    if (!state.remnants) {
      // Unknown absence is not proof that the private ledger is absent. The
      // owner preflight must have proved total absence before borrowing c.
      ensure(prechecked === false, 503, 'Unverified operational consumer absence');
      return false;
    }
    ensure(prechecked !== false, 503, 'Operational module changed after preflight');
  } else {
    // Owner/recovery readers may inspect the private ledger on this SAME client.
    const installed = (
      await c.query(
        "SELECT EXISTS(SELECT FROM migrations WHERE name='167_operational_delivery_consumers') installed",
      )
    ).rows[0].installed;
    if (!state.remnants) {
      ensure(!installed, 503, 'Torn operational consumer ledger');
      return false;
    }
    ensure(installed, 503, 'Torn operational consumer ledger');
  }
  ensure(state.helper, 503, 'Torn operational consumer module');
  // The own SECURITY DEFINER validator includes its actual private ledger and
  // complete certificate proof. No app ledger privilege is introduced.
  ensure(
    (await c.query('SELECT operative_delivery_valid() ok')).rows[0].ok,
    503,
    'Torn operational consumer module',
  );
  return true;
}
export async function enlistOperationalDeliveryInTx(
  c: PoolClient,
  args: {
    actor: Actor;
    orderId: string;
    consumer: 'label' | 'parcel';
    clientKey: string;
    encryptionKey: string;
    write: boolean;
    persistEvidence?: boolean;
  },
): Promise<Binding | null> {
  const duties = transactions.get(c)?.duties;
  ensure(duties, 500, 'Operational consumer requires managed transaction');
  if (!(await operationalDeliveryConsumersAvailable(c))) return null;
  if (args.consumer === 'parcel') {
    const plan = (
      await c.query(
        "SELECT payload->'source' ? 'operative_delivery' bound FROM order_parcel_plans WHERE(tenant_id,order_id)=($1,$2)",
        [args.actor.tenantId, args.orderId],
      )
    ).rows[0];
    // Accepted legacy plans keep their original immutable receiver. No new
    // corrected evidence is attached to a legacy dispatch/replay.
    if (plan && !plan.bound) return null;
  }
  const binding = await deliveryBindingInTx(
    c,
    args.actor.tenantId,
    args.orderId,
    args.encryptionKey,
  );
  if (!binding) return null;
  // Legacy/absent/unchanged receiver paths retain their existing native IAM.
  // Every genuine corrected receiver still needs exact managed actor custody.
  const a = authorities.get(args.actor);
  ensure(a, 500, 'Operational consumer requires managed request custody');
  if (a.worker)
    ensure(
      a.worker.client === c &&
        args.consumer === 'label' &&
        args.orderId === a.worker.orderId &&
        args.write &&
        args.persistEvidence !== false &&
        [a.worker.previewKey, a.worker.queueKey].includes(args.clientKey),
      409,
      'Packed worker receiver scope changed',
    );
  // Native caller acquires its print quota/warehouse-policy locks before enlisting;
  // admission acquires its existing order lock. Never invert print→order ordering.
  const source = (
    await c.query(
      'SELECT buyer_address_current_state($1,$2) state,buyer_address_buyer_basis($1,$2) basis',
      [args.actor.tenantId, args.orderId],
    )
  ).rows[0];
  const evidence = {
    profile: 'operational-receiver/v1',
    tenant_id: args.actor.tenantId,
    order_id: args.orderId,
    consumer: args.consumer,
    client_key: args.clientKey,
    actor_id: args.actor.userId,
    api_key_id: args.actor.apiKeyId ?? null,
    binding,
    receipt_id: source.state.last_receipt_id,
    buyer_basis_hash: source.basis,
    override_sha256: source.state.override_sha256,
    ...(a.worker
      ? { worker_intent_id: a.worker.intentId, worker_basis_hash: a.worker.basisHash }
      : {}),
  };
  const sealed = encrypt(evidence, args.encryptionKey);
  const actual = (
    await (a.worker
      ? c.query('SELECT operative_delivery_worker_admit($1,$2,$3,$4::jsonb,$5,$6,$7) binding', [
          args.actor.tenantId,
          a.worker.intentId,
          args.clientKey,
          JSON.stringify(binding.delivery),
          sealed.encrypted,
          sealed.bytes,
          sealed.digest,
        ])
      : c.query(
          'SELECT operative_delivery_admit($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14) binding',
          [
            args.actor.tenantId,
            args.orderId,
            args.actor.userId,
            args.actor.apiKeyId ?? null,
            a.hash,
            args.actor.role,
            args.write,
            args.consumer,
            args.clientKey,
            JSON.stringify(binding.delivery),
            sealed.encrypted,
            sealed.bytes,
            sealed.digest,
            args.persistEvidence ?? args.write,
          ],
        ))
  ).rows[0].binding;
  if (a.worker)
    ensure(
      (
        await c.query('SELECT operative_delivery_worker_head($1,$2) head', [
          args.actor.tenantId,
          a.worker.intentId,
        ])
      ).rows[0].head.hash === a.worker.basisHash,
      409,
      'Packed worker consent changed during admission',
    );
  ensure(
    canonical(actual) === canonical(binding),
    409,
    'Operational delivery changed during admission',
  );
  duties.push({
    authority: a,
    orderId: args.orderId,
    consumer: args.consumer,
    key: args.encryptionKey,
    binding,
  });
  return binding;
}
export async function finalizeOperationalDeliveryInTx(c: PoolClient) {
  const duties = transactions.get(c)?.duties;
  if (!duties?.length) return;
  await drainPublicConstraintsInTx(c);
  for (const d of duties)
    ensure(
      canonical(await deliveryBindingInTx(c, d.authority.actor.tenantId, d.orderId, d.key)) ===
        canonical(d.binding),
      409,
      'Operational receiver changed',
    );
  // Native terminal PINs session/key/user/policy and compares complete current
  // source after waits, then rereads authority at the current server clock.
  await c.query('SELECT operative_delivery_terminal()');
}
/** Owner read-only restore registry. Historical evidence need not equal today's
 * current sidecar; each envelope binds its immutable receipt and original basis. */
export async function validateRecoveredOperationalDeliveries(
  c: Pick<PoolClient, 'query'>,
  key: string,
): Promise<{ records: number }> {
  if (!(await operationalDeliveryConsumersAvailable(c))) return { records: 0 };
  let count = 0,
    after: string | null = null;
  for (;;) {
    const rows: Array<Record<string, any>> = (
      await c.query(
        `SELECT e.*,r.after_state,o.address,o.customer_name,o.email,buyer_address_hash(operative_delivery_worker_basis(e.tenant_id,e.worker_intent_id)) actual_worker_hash,buyer_address_hash(jsonb_build_object('tenant_id',o.tenant_id,'order_id',o.id,'customer_name',o.customer_name,'email',o.email,'address',o.address)) actual_basis FROM operative_delivery_evidence e JOIN buyer_address_receipts r ON(r.tenant_id,r.order_id,r.id)=(e.tenant_id,e.order_id,e.receipt_id) JOIN orders o ON(o.tenant_id,o.id)=(e.tenant_id,e.order_id) WHERE($1::uuid IS NULL OR e.id>$1) ORDER BY e.id LIMIT 100`,
        [after],
      )
    ).rows;
    if (!rows.length) break;
    for (const r of rows) {
      const v = decrypt(r.evidence_encrypted, r.evidence_bytes, r.evidence_sha256, key) as Record<
        string,
        any
      >;
      ensure(
        v &&
          typeof v === 'object' &&
          !Array.isArray(v) &&
          Object.keys(v).sort().join(',') ===
            'actor_id,api_key_id,binding,buyer_basis_hash,client_key,consumer,order_id,override_sha256,profile,receipt_id,tenant_id' +
              (r.worker_intent_id ? ',worker_basis_hash,worker_intent_id' : ''),
        503,
        'Invalid recovered operational evidence',
      );
      ensure(
        v.profile === 'operational-receiver/v1' &&
          v.tenant_id === r.tenant_id &&
          v.order_id === r.order_id &&
          v.consumer === r.consumer &&
          v.client_key === r.client_key &&
          v.actor_id === r.actor_id &&
          v.api_key_id === r.api_key_id &&
          v.receipt_id === r.receipt_id &&
          v.buyer_basis_hash === r.buyer_basis_hash &&
          v.override_sha256 === r.override_sha256 &&
          (r.worker_intent_id
            ? v.worker_intent_id === r.worker_intent_id &&
              v.worker_basis_hash === r.worker_basis_hash &&
              r.actual_worker_hash === r.worker_basis_hash &&
              r.consumer === 'label' &&
              r.api_key_id === null
            : r.worker_basis_hash === null),
        503,
        'Operational evidence tuple differs',
      );
      ensure(
        v.binding &&
          typeof v.binding === 'object' &&
          !Array.isArray(v.binding) &&
          Object.keys(v.binding).sort().join(',') === 'delivery,hash,version' &&
          r.actual_basis === r.buyer_basis_hash,
        503,
        'Operational binding/buyer basis differs',
      );
      const savedOverride = decrypt(
        r.after_state.delivery_override_encrypted,
        r.after_state.override_byte_count,
        r.after_state.override_sha256,
        key,
      );
      let delivery: BuyerDeliveryAddress166;
      try {
        delivery = validateBuyerDeliveryAddress166(v.binding?.delivery, {
          originalCountry: r.address.country,
          deliveryKind: 'address',
        });
      } catch {
        throw new Problem(503, 'Invalid recovered operational delivery semantics');
      }
      ensure(
        canonical(delivery) === canonical(savedOverride) &&
          canonical(delivery) === canonical(v.binding.delivery) &&
          v.binding.version === String(r.delivery_version) &&
          v.binding.hash === r.delivery_hash &&
          sha(canonical(delivery)) === r.delivery_hash &&
          r.after_state.delivery_version === String(r.delivery_version) &&
          r.after_state.override_sha256 === r.override_sha256,
        503,
        'Operational delivery lineage differs',
      );
      count++;
    }
    after = String(rows.at(-1)!.id);
  }
  ensure(
    (await c.query('SELECT count(*)::integer n FROM operative_delivery_evidence')).rows[0].n ===
      count,
    503,
    'Incomplete operational evidence graph',
  );
  return { records: count };
}
