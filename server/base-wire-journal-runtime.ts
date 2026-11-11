/** Native port of the Base journal family: 221 log IDs over order_events and
 * invoice/correction documents, numeric 220 identities for every reference. */
import type { PoolClient } from 'pg';
import type { Actor } from './domain';
import { ensure } from './errors';
import { tenantTx, tenantReadTx } from './db';
import { parseBaseWireId } from './base-wire-codec';
import { BASE_WIRE_JOURNAL_EVENT_TYPES, createBaseWireJournalService, type BaseWireJournalNative } from './base-wire-journal';

function publicNumber(raw: unknown, allowZero = false): number {
  ensure(typeof raw === 'string' && /^(0|[1-9][0-9]*)$/.test(raw) && BigInt(raw) <= BigInt(Number.MAX_SAFE_INTEGER), 503, 'Brak trwałej tożsamości Base; wymagany poprawny bootstrap 220/221');
  return parseBaseWireId(Number(raw), allowZero);
}
// A detail value is only looked up when it is a UUID; anything else gives object_id 0.
const uuidOf = (expr: string) => `(CASE WHEN (${expr}) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (${expr})::uuid END)`;
const KINDS = BASE_WIRE_JOURNAL_EVENT_TYPES.map(r => r.kind), TYPES = BASE_WIRE_JOURNAL_EVENT_TYPES.map(r => r.log_type),
  OBJECTS = BASE_WIRE_JOURNAL_EVENT_TYPES.map(r => r.object);

export function createBaseWireJournalNative(c: PoolClient, actor: Actor): BaseWireJournalNative {
  return {
    async allocate() { await c.query('SELECT public.base_wire221_allocate_journal()'); },
    async entries(f) {
      // order.shipped without a shipment is a stage transition (18); every other kind follows the table.
      const rows = (await c.query(`SELECT x.log_id::text AS log_id,o.public_id::text AS order_id,x.log_type,coalesce(x.object_id,0)::text AS object_id,
          floor(extract(epoch FROM x.created_at))::bigint::text AS date FROM (
          SELECT j.log_id,e.order_id,e.created_at,y.log_type,CASE y.object
            WHEN 'merged_order' THEN (SELECT s.public_id FROM base_wire220_order_ids s WHERE s.tenant_id=e.tenant_id AND s.local_id=${uuidOf("e.detail->'source_ids'->>0")})
            WHEN 'package' THEN (SELECT p.public_id FROM base_wire220_package_ids p WHERE p.tenant_id=e.tenant_id AND p.local_id=${uuidOf("coalesce(e.detail->>'shipmentId',e.detail->>'shipment_id')")})
            WHEN 'status' THEN (SELECT w.public_id FROM base_wire220_order_status_ids w WHERE w.tenant_id=e.tenant_id AND w.local_id=${uuidOf("e.detail->>'to'")}) END AS object_id
          FROM base_wire221_journal_ids j JOIN order_events e ON(e.tenant_id,e.id)=(j.tenant_id,j.event_id)
          JOIN unnest($2::text[],$3::int[],$4::text[]) m(kind,log_type,object) ON m.kind=e.kind
          CROSS JOIN LATERAL (SELECT CASE WHEN e.kind='order.shipped' AND NOT e.detail ? 'shipmentId' THEN 18 ELSE m.log_type END AS log_type,
            CASE WHEN e.kind='order.shipped' AND NOT e.detail ? 'shipmentId' THEN 'none' ELSE m.object END AS object) y
          WHERE j.tenant_id=$1 AND j.log_id>$5::bigint
          UNION ALL
          SELECT j.log_id,d.order_id,d.created_at,7,i.public_id FROM base_wire221_journal_ids j JOIN documents d ON(d.tenant_id,d.id)=(j.tenant_id,j.document_id)
          JOIN base_wire220_invoice_ids i ON(i.tenant_id,i.local_id)=(d.tenant_id,d.id)
          WHERE j.tenant_id=$1 AND j.log_id>$5::bigint
        ) x JOIN base_wire220_order_ids o ON(o.tenant_id,o.local_id)=($1,x.order_id)
        WHERE x.created_at>=now()-interval '3 days' AND ($6::int[] IS NULL OR x.log_type=ANY($6)) AND ($7::bigint IS NULL OR o.public_id=$7)
        ORDER BY x.log_id LIMIT $8`,
      [actor.tenantId, KINDS, TYPES, OBJECTS, f.after, f.types ?? null, f.order_public_id ?? null, f.limit])).rows;
      return rows.map(r => ({ log_id: publicNumber(r.log_id), order_public_id: publicNumber(r.order_id), log_type: Number(r.log_type),
        object_id: publicNumber(r.object_id, true), date: Number(r.date) }));
    },
  };
}
export function createDefaultBaseWireJournalService(opts: { readOnly: boolean }) {
  return createBaseWireJournalService({
    transaction: (actor, writing, work) => (writing ? tenantTx : tenantReadTx)(actor.tenantId, work),
    native: (c, actor) => createBaseWireJournalNative(c, actor),
    allocateOnRead: opts.readOnly !== true,
  });
}
