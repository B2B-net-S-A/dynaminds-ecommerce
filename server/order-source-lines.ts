import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AuditActor } from './domain';
import { ensure } from './errors';

const lineInput = z
  .object({
    source_item_id: z.uuid(),
    remote_line_id: z.string().min(1).max(200),
    external_product_id: z.string().min(1).max(160),
    product_id: z.uuid(),
    listing_id: z.uuid(),
    quantity: z.number().int().min(1).max(100000),
    line_total: z.number().int().min(0).max(2147483647),
    mapping_evidence: z.record(z.string(), z.unknown()),
  })
  .strict();
const bindingInput = z
  .object({
    channel_id: z.uuid(),
    inbound_id: z.uuid(),
    source_order_id: z.uuid(),
    source_hash: z.string().regex(/^[0-9a-f]{64}$/),
    lines: z.array(lineInput).min(1).max(100),
  })
  .strict();
export type OrderSourceLineBinding = z.infer<typeof bindingInput>;

export async function orderSourceLinesAvailable(c: Pool | PoolClient): Promise<boolean> {
  return Boolean(
    (
      await c.query(`SELECT to_regclass('public.order_source_lines') IS NOT NULL
    AND to_regprocedure('public.order_source_line_guard()') IS NOT NULL
    AND to_regprocedure('public.order_source_line_complete()') IS NOT NULL AS available`)
    ).rows[0].available,
  );
}

/** Called once after the inbound order is linked, in the same import transaction.
 * Legacy imported orders deliberately have no inferred/backfilled bindings. */
export async function bindOrderSourceLinesInTx(
  c: PoolClient,
  a: Pick<AuditActor, 'tenantId'>,
  input: OrderSourceLineBinding,
): Promise<void> {
  const b = bindingInput.parse(input);
  ensure(
    await orderSourceLinesAvailable(c),
    503,
    'Kopia nie zawiera trwałych powiązań pozycji źródłowych',
  );
  ensure(
    new Set(b.lines.map((l) => l.remote_line_id)).size === b.lines.length &&
      new Set(b.lines.map((l) => l.source_item_id)).size === b.lines.length,
    422,
    'Powtórzone źródłowe lub lokalne ID pozycji',
  );
  ensure(
    Buffer.byteLength(JSON.stringify(b)) <= 2 * 1024 * 1024,
    413,
    'Powiązania pozycji przekraczają limit',
  );
  await c.query(
    `INSERT INTO order_source_lines(id,tenant_id,channel_id,inbound_id,source_order_id,source_item_id,
    remote_line_id,external_product_id,product_id,listing_id,quantity,line_total,source_hash,mapping_evidence)
    SELECT (r->>'id')::uuid,$1,$2,$3,$4,(r->>'source_item_id')::uuid,r->>'remote_line_id',r->>'external_product_id',
      (r->>'product_id')::uuid,(r->>'listing_id')::uuid,(r->>'quantity')::integer,(r->>'line_total')::integer,$5,r->'mapping_evidence'
    FROM jsonb_array_elements($6::jsonb) r`,
    [
      a.tenantId,
      b.channel_id,
      b.inbound_id,
      b.source_order_id,
      b.source_hash,
      JSON.stringify(b.lines.map((l) => ({ id: randomUUID(), ...l }))),
    ],
  );
}
