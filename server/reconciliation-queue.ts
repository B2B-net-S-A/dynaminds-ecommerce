/** AUTO-04: one "Do uzgodnienia" queue of side effects whose outcome is unknown: the send or write
 * started and no result came back. This route only lists and points to the place where each kind is
 * resolved; it never retries, reconciles or calls a provider. SMS and email are decided in the queue
 * itself (message-outcome.ts). Shopify/Amazon/eBay fulfillment keeps
 * its own queue (integration-recovery-query.ts, Integracje → Problemy operacji). */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { tenantReadTx } from './db';
import { ensure } from './errors';

export type ReconciliationDomain = 'sms' | 'email' | 'dpd_collection' | 'shipping' | 'invoice' | 'order_status' | 'offer';
/** order_detail: the order card panel; dpd_collections / offers: their Integrations panels;
 * decide: the operator's decision in this queue (POST …/:kind/:id/decision). */
export type ReconciliationResolve = 'order_detail' | 'dpd_collections' | 'offers' | 'decide';
const LIMIT = 100;
// Each source: the uncertain-state predicate of its own schema (see the report in WORKERS-S3 doc).
const sources: { domain: ReconciliationDomain; table: string; resolve: ReconciliationResolve; sql: string }[] = [
  { domain: 'sms', table: 'sms_messages', resolve: 'decide',
    sql: "SELECT id,order_id,'SMS '||coalesce(recipient,'') label,error,coalesce(attempted_at,updated_at) at FROM sms_messages WHERE tenant_id=$1 AND state='uncertain'" },
  { domain: 'email', table: 'email_messages', resolve: 'decide',
    sql: "SELECT id,order_id,'Email '||number label,error,coalesce(attempted_at,updated_at) at FROM email_messages WHERE tenant_id=$1 AND state='uncertain'" },
  { domain: 'dpd_collection', table: 'dpd_collections', resolve: 'dpd_collections',
    sql: "SELECT id,NULL::uuid order_id,'Podjazd DPD '||requested_number label,error,updated_at at FROM dpd_collections WHERE tenant_id=$1 AND state='uncertain'" },
  { domain: 'shipping', table: 'shipping_plans', resolve: 'order_detail',
    sql: "SELECT id,order_id,'Przesyłka '||coalesce(input->>'provider','inpost') label,error,updated_at at FROM shipping_plans WHERE tenant_id=$1 AND state='failed' AND phase IN('create_started','numbers_ready','buy_started','refresh_started','created')" },
  { domain: 'invoice', table: 'invoice_plans', resolve: 'order_detail',
    sql: "SELECT id,order_id,CASE kind WHEN 'correction' THEN 'Korekta' ELSE 'Faktura' END label,error,updated_at at FROM invoice_plans WHERE tenant_id=$1 AND state='failed' AND phase IN('create_started','created')" },
  { domain: 'order_status', table: 'order_status_plans', resolve: 'order_detail',
    sql: "SELECT id,order_id,'Status w kanale: '||target label,error,updated_at at FROM order_status_plans WHERE tenant_id=$1 AND state='failed' AND phase IN('write_started','verify')" },
  // offer_plans has no updated_at; created_at is the best known time.
  { domain: 'offer', table: 'offer_plans', resolve: 'offers',
    sql: "SELECT id,NULL::uuid order_id,'Oferta: '||operation label,error,coalesce(completed_at,created_at) at FROM offer_plans WHERE tenant_id=$1 AND state='failed' AND phase IN('write_started','verify')" },
];
function reader(req: FastifyRequest) {
  const r = req as FastifyRequest & { actor: { tenantId: string; role: string; apiKeyId?: string }; apiScopes?: string[] };
  ensure(['admin', 'operator'].includes(r.actor?.role) && !r.actor.apiKeyId && !r.apiScopes, 403, 'Kolejkę do uzgodnienia widzi administrator lub operator');
  return r.actor;
}
export function registerReconciliationQueueRoutes(app: FastifyInstance) {
  app.get('/api/operations/reconciliation-queue', async (req) => {
    const a = reader(req);
    return tenantReadTx(a.tenantId, async (c) => {
      const counts: Partial<Record<ReconciliationDomain, number>> = {};
      const items: any[] = [];
      for (const s of sources) {
        if (!(await c.query('SELECT to_regclass($1) present', ['public.' + s.table])).rows[0].present) continue;
        counts[s.domain] = (await c.query(`SELECT count(*)::int n FROM (${s.sql}) x`, [a.tenantId])).rows[0].n;
        for (const r of (await c.query(`${s.sql} ORDER BY 5 DESC,1 LIMIT ${LIMIT}`, [a.tenantId])).rows)
          items.push({ domain: s.domain, resolve: s.resolve, ...r, error: r.error ? String(r.error).slice(0, 300) : null });
      }
      items.sort((x, y) => new Date(y.at).getTime() - new Date(x.at).getTime() || String(x.id).localeCompare(String(y.id)));
      const orders = [...new Set(items.map((i) => i.order_id).filter(Boolean))];
      const numbers = new Map(
        (orders.length ? (await c.query('SELECT id,number FROM orders WHERE id=ANY($1::uuid[])', [orders])).rows : []).map((o) => [o.id, o.number]),
      );
      return {
        generated_at: (await c.query('SELECT now() at')).rows[0].at,
        counts,
        items: items.slice(0, LIMIT).map((i) => ({ ...i, order_number: i.order_id ? (numbers.get(i.order_id) ?? null) : null })),
        truncated: Object.values(counts).reduce((n, v) => n + (v ?? 0), 0) > LIMIT,
        fulfillment_note: 'Realizacje Shopify, Amazon i eBay mają własną kolejkę: Integracje → Problemy operacji.',
      };
    });
  });
}
