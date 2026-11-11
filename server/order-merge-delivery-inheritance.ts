/** Import-inert authenticated delivery projection. No credential or SQL-role authority is issued here. */
import {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ensure, Problem } from './errors';
import {
  effectiveDelivery166,
  validateBuyerDeliveryAddress166,
} from './buyer-delivery-address';
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const canonical = (v: any): string =>
  Array.isArray(v)
    ? '[' + v.map(canonical).join(',') + ']'
    : v !== null && typeof v === 'object'
      ? '{' +
        Object.keys(v)
          .sort()
          .map((k) => JSON.stringify(k) + ':' + canonical(v[k]))
          .join(',') +
        '}'
      : JSON.stringify(v);
const uuid = z.uuid(),
  hash = z.string().regex(/^[a-f0-9]{64}$/),
  version = z
    .string()
    .regex(/^(0|[1-9][0-9]{0,18})$/)
    .refine((v) => BigInt(v) <= 9223372036854775807n);
export const orderMergeDeliveryState = z
  .strictObject({
    version,
    delivery_version: version,
    enabled: z.boolean(),
    delivery_kind: z.enum(['address', 'pickup_point', 'unknown']),
    classification_origin: z.enum(['unknown', 'operator_confirmed', 'adapter']),
    delivery_override_encrypted: z.string().max(22000).nullable(),
    override_byte_count: z.number().int().min(1).max(16384).nullable(),
    override_sha256: hash.nullable(),
    last_receipt_id: uuid.nullable(),
  })
  .refine(
    (s) =>
      [
        s.delivery_override_encrypted,
        s.override_byte_count,
        s.override_sha256,
      ].every((v) => v === null) ||
      [
        s.delivery_override_encrypted,
        s.override_byte_count,
        s.override_sha256,
      ].every((v) => v !== null),
  );
const address = z
  .object({
    street: z.string().max(800),
    city: z.string().max(400),
    postal_code: z.string().max(80),
    country: z.string().length(2),
    phone: z.string().max(64),
    locker_code: z.string().max(800).optional(),
  })
  .passthrough();
const order = z
  .object({
    id: uuid,
    tenant_id: uuid,
    version,
    customer_name: z.string().max(800),
    email: z.string().max(800),
    address,
  })
  .passthrough();
const source = z.strictObject({
  order,
  state: orderMergeDeliveryState,
  buyer_basis_hash: hash,
});
export type OrderMergeDeliverySource = {
  order: Record<string, any>;
  state: z.infer<typeof orderMergeDeliveryState>;
  buyer_basis_hash: string;
};
export type OrderMergeDeliveryFrame = {
  order_id: string;
  state: z.infer<typeof orderMergeDeliveryState>;
  buyer_basis_hash: string;
  effective_kind: 'address' | 'pickup_point' | 'unknown';
  effective_hash: string | null;
};
export type OrderMergeDeliveryEnvelope = {
  encrypted: string;
  byte_count: number;
  sha256: string;
};
function unseal(e: OrderMergeDeliveryEnvelope, key: string): unknown {
  try {
    ensure(
      /^[a-f0-9]{64}$/.test(key) &&
        Number.isInteger(e.byte_count) &&
        e.byte_count > 0 &&
        e.byte_count <= 16384 &&
        typeof e.encrypted === 'string' &&
        e.encrypted.length <= 22000 &&
        digest(e.encrypted) === e.sha256,
      503,
      'Uszkodzony dowód adresu',
    );
    const b = Buffer.from(e.encrypted, 'base64');
    ensure(
      b.length === e.byte_count + 28 && b.toString('base64') === e.encrypted,
      503,
      'Uszkodzona otoczka adresu',
    );
    const d = createDecipheriv(
      'aes-256-gcm',
      Buffer.from(key, 'hex'),
      b.subarray(0, 12),
    );
    d.setAuthTag(b.subarray(12, 28));
    const bytes = Buffer.concat([d.update(b.subarray(28)), d.final()]);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      v = JSON.parse(text);
    ensure(
      bytes.length === e.byte_count && canonical(v) === text,
      503,
      'Niekononiczny dowód adresu',
    );
    return v;
  } catch {
    throw new Problem(503, 'Uwierzytelnienie dowodu adresu nie powiodło się');
  }
}
function seal(v: unknown, key: string): OrderMergeDeliveryEnvelope {
  const text = canonical(v);
  ensure(
    /^[a-f0-9]{64}$/.test(key) && Buffer.byteLength(text) <= 16384,
    503,
    'Niepoprawny zakres dowodu adresu',
  );
  const iv = randomBytes(12),
    c = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv),
    body = Buffer.concat([c.update(text, 'utf8'), c.final()]),
    encrypted = Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
  return {
    encrypted,
    byte_count: Buffer.byteLength(text),
    sha256: digest(encrypted),
  };
}
export function authenticateOrderMergeDeliverySource(
  input: OrderMergeDeliverySource,
  key: string,
) {
  try {
    const f = source.parse(input),
      s = f.state;
    let override: unknown = null;
    if (s.delivery_override_encrypted !== null) {
      override = unseal(
        {
          encrypted: s.delivery_override_encrypted,
          byte_count: s.override_byte_count!,
          sha256: s.override_sha256!,
        },
        key,
      );
      const valid = validateBuyerDeliveryAddress166(override, {
        originalCountry: f.order.address.country,
        deliveryKind: s.delivery_kind,
      });
      ensure(
        canonical(valid) === canonical(override),
        503,
        'Niekononiczny zapis adresu',
      );
    }
    const effective = effectiveDelivery166({
      original: f.order,
      sidecarOverride: override,
      deliveryKind: s.delivery_kind,
    });
    const snapshot: OrderMergeDeliveryFrame = {
      order_id: f.order.id,
      state: structuredClone(s),
      buyer_basis_hash: f.buyer_basis_hash,
      effective_kind: effective.kind,
      effective_hash:
        effective.delivery === null
          ? null
          : digest(canonical(effective.delivery)),
    };
    return { snapshot, effective };
  } catch {
    throw new Problem(503, 'Niepoprawny zapis operacyjnego adresu źródła');
  }
}
/** Caller already holds parent-order locks, also used by the existing166 writers. */
export async function captureOrderMergeDeliverySourcesInTx(
  c: Pick<PoolClient, 'query'>,
  tenantId: string,
  orders: Record<string, any>[],
  key: string,
): Promise<OrderMergeDeliveryFrame[]> {
  ensure(
    orders.length > 0 &&
      orders.length <= 100 &&
      new Set(orders.map((o) => o.id)).size === orders.length &&
      orders.every((o) => o.tenant_id === tenantId),
    503,
    'Niepoprawny zakres źródeł adresu',
  );
  const out: OrderMergeDeliveryFrame[] = [];
  for (const o of orders) {
    const r = (
      await c.query(
        'SELECT buyer_address_current_state($1,$2) state,buyer_address_buyer_basis($1,$2) basis',
        [tenantId, o.id],
      )
    ).rows[0];
    ensure(r, 503, 'Brak stanu źródła adresu');
    out.push(
      authenticateOrderMergeDeliverySource(
        { order: o, state: r.state, buyer_basis_hash: r.basis },
        key,
      ).snapshot,
    );
  }
  return out;
}
export function projectOrderMergeDeliverySnapshot(
  order: Record<string, any>,
  snapshot: OrderMergeDeliveryFrame,
  key: string,
) {
  ensure(order.id === snapshot.order_id, 503, 'Niezgodne źródło adresu');
  const actual = authenticateOrderMergeDeliverySource(
    {
      order,
      state: snapshot.state,
      buyer_basis_hash: snapshot.buyer_basis_hash,
    },
    key,
  );
  ensure(
    canonical(actual.snapshot) === canonical(snapshot),
    503,
    'Niezgodny zamrożony adres',
  );
  return actual.effective;
}
export type OrderMergeDeliveryInheritanceContext = {
  tenant_id: string;
  execution_id: string;
  merge_preview_id: string;
  scope_hash: string;
  source: OrderMergeDeliverySource;
  target_order_id: string;
};
const context = z.strictObject({
  tenant_id: uuid,
  execution_id: uuid,
  merge_preview_id: uuid,
  scope_hash: hash,
  source,
  target_order_id: uuid,
});
function payload(input: OrderMergeDeliveryInheritanceContext, key: string) {
  const p = context.parse(input),
    a = authenticateOrderMergeDeliverySource(p.source, key),
    o = p.source.order;
  ensure(
    o.tenant_id === p.tenant_id && o.id !== p.target_order_id,
    503,
    'Niezgodne powiązanie dziedziczenia adresu',
  );
  return {
    schema: 'order-merge-delivery-inheritance/v1' as const,
    tenant_id: p.tenant_id,
    execution_id: p.execution_id,
    merge_preview_id: p.merge_preview_id,
    scope_hash: p.scope_hash,
    target_order_id: p.target_order_id,
    source: {
      order: {
        id: o.id,
        tenant_id: o.tenant_id,
        version: o.version,
        customer_name: o.customer_name,
        email: o.email,
        address: o.address,
      },
      state: a.snapshot.state,
      buyer_basis_hash: a.snapshot.buyer_basis_hash,
    },
    source_frame: a.snapshot,
    source_effective: a.effective,
  };
}
export function createOrderMergeDeliveryInheritanceEvidence(
  input: OrderMergeDeliveryInheritanceContext,
  key: string,
) {
  return seal(payload(input, key), key);
}
/** Self-authentication is not admission; caller must additionally bind this context to own immutable209/parent execution. */
export function readOrderMergeDeliveryInheritanceEvidence(
  envelope: OrderMergeDeliveryEnvelope,
  key: string,
) {
  const v = unseal(envelope, key) as any;
  try {
    ensure(
      v && v.schema === 'order-merge-delivery-inheritance/v1',
      503,
      'Nieznany dowód dziedziczenia',
    );
    const expected = payload(
      {
        tenant_id: v.tenant_id,
        execution_id: v.execution_id,
        merge_preview_id: v.merge_preview_id,
        scope_hash: v.scope_hash,
        target_order_id: v.target_order_id,
        source: v.source,
      },
      key,
    );
    ensure(
      canonical(v) === canonical(expected),
      503,
      'Niezgodny dowód dziedziczenia',
    );
    return expected;
  } catch {
    throw new Problem(503, 'Niepoprawny dowód dziedziczenia adresu');
  }
}
export function authenticateOrderMergeDeliveryInheritanceEvidence(
  envelope: OrderMergeDeliveryEnvelope,
  expected: OrderMergeDeliveryInheritanceContext,
  key: string,
) {
  const v = readOrderMergeDeliveryInheritanceEvidence(envelope, key);
  ensure(
    canonical(v) === canonical(payload(expected, key)),
    503,
    'Zmieniony kontekst dziedziczenia adresu',
  );
  return v;
}
