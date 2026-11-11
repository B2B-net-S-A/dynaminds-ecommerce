import type { PoolClient } from 'pg';
import { z } from 'zod';
import { localConfig, pool, tenantTx } from './db';
import type { Actor } from './domain';
import { ensure, Problem } from './errors';
import { customerMessageWriteRole } from './customer-messages';
import { logPersonalDataAccess } from './rodo228';

// One timeline per order (or per buyer email across their recent orders): outbound email,
// SMS, portal conversation and inbound email bound to the order. Read-only.
// The buyer scope reaches the buyer's other orders (SR4-M4): a viewer gets their metadata only
// (no body, subject or address); admin/operator get the content and each such read writes one
// RODO access-register row (228) naming the orders, the buyer kept as the hash of the e-mail.
const BUYER_READ = { purpose: 'Obsługa klienta — historia komunikacji kupującego', resource: 'GET /api/orders/:id/communication?scope=customer' };
export const orderCommunicationQuery = z.strictObject({
  scope: z.enum(['order', 'customer']).default('order'),
  channel: z.enum(['email', 'sms', 'portal']).optional(),
  cursor: z.string().max(300).optional(),
});
export const CUSTOMER_ORDER_LIMIT = 20;
const PAGE = 30;
function after(value?: string) {
  if (!value) return null;
  try {
    return z
      .tuple([z.iso.datetime(), z.uuid()])
      .parse(JSON.parse(Buffer.from(value, 'base64url').toString()));
  } catch {
    throw new Problem(422, 'Nieprawidłowy kursor historii komunikacji');
  }
}
async function present(c: PoolClient, table: string) {
  return Boolean((await c.query('SELECT to_regclass($1) present', ['public.' + table])).rows[0].present);
}
type Source = { sql: string; channel: 'email' | 'sms' | 'portal' };
export async function orderCommunication(
  a: Actor,
  orderId: string,
  q: z.infer<typeof orderCommunicationQuery>,
  portalAvailable: boolean,
  accessRegister = false,
) {
  const page = after(q.cursor);
  const result = await tenantTx(a.tenantId, async (c) => {
    // RLS keeps the order and every source inside the caller's tenant.
    const o = (await c.query('SELECT id,number,email FROM orders WHERE id=$1', [orderId])).rows[0];
    ensure(o, 404, 'Nie znaleziono zamówienia');
    const portal = portalAvailable && (await present(c, 'customer_messages'));
    // Private kinds (staff notes, inbound email) follow the same current role as the inbox.
    const role = portal ? await customerMessageWriteRole(c, a) : a.role;
    const privileged = ['admin', 'operator'].includes(role);
    const email = String(o.email ?? '').trim();
    const orders =
      q.scope === 'customer' && email
        ? (
            await c.query(
              'SELECT id,number,status,created_at FROM orders WHERE lower(email)=lower($1) ORDER BY (id=$2) DESC,created_at DESC,id DESC LIMIT $3',
              [email, o.id, CUSTOMER_ORDER_LIMIT],
            )
          ).rows
        : (await c.query('SELECT id,number,status,created_at FROM orders WHERE id=$1', [o.id])).rows;
    const sources: Source[] = [];
    if (await present(c, 'email_messages'))
      sources.push({
        channel: 'email',
        sql: "SELECT 'email' channel,m.id,m.order_id,m.created_at at,'out' direction,m.state,m.payload->>'subject' title,left(m.payload->>'text',600) body,m.payload->>'recipient' party FROM email_messages m WHERE m.order_id=ANY($1::uuid[]) AND m.state NOT IN ('draft','invalid')",
      });
    if (await present(c, 'sms_messages'))
      sources.push({
        channel: 'sms',
        sql: "SELECT 'sms' channel,m.id,m.order_id,m.created_at at,'out' direction,m.state,NULL::text title,left(m.payload,600) body,m.recipient party FROM sms_messages m WHERE m.order_id=ANY($1::uuid[]) AND m.state NOT IN ('draft','invalid')",
      });
    if (portal)
      sources.push({
        channel: 'portal',
        sql: `SELECT CASE WHEN m.kind='email' THEN 'email' ELSE 'portal' END channel,m.id,m.order_id,m.created_at at,CASE m.kind WHEN 'buyer' THEN 'in' WHEN 'email' THEN 'in' WHEN 'note' THEN 'internal' ELSE 'out' END direction,m.kind state,NULL::text title,left(m.body,600) body,NULL::text party FROM customer_messages m WHERE m.order_id=ANY($1::uuid[]) ${privileged ? '' : "AND m.kind IN ('buyer','reply')"}`,
      });
    const chosen = sources.filter(
      (s) => !q.channel || s.channel === q.channel || (q.channel === 'email' && s.channel === 'portal'),
    );
    const ids = orders.map((r) => r.id);
    const rows = chosen.length
      ? (
          await c.query(
            `SELECT x.*,to_char(x.at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_time FROM (${chosen.map((s) => s.sql).join(' UNION ALL ')}) x WHERE ($2::text IS NULL OR x.channel=$2) ${page ? 'AND (x.at,x.id)<($3::timestamptz,$4::uuid)' : ''} ORDER BY x.at DESC,x.id DESC LIMIT ${PAGE + 1}`,
            page ? [ids, q.channel ?? null, ...page] : [ids, q.channel ?? null],
          )
        ).rows
      : [];
    const numbers = new Map(orders.map((r) => [r.id, r.number]));
    const buyerScope = q.scope === 'customer' && Boolean(email);
    const hide = (r: { order_id: string }) => buyerScope && !privileged && r.order_id !== o.id;
    const view = {
      order: { id: o.id, number: o.number },
      scope: q.scope,
      customer: {
        email_known: Boolean(email),
        orders: orders.map((r) => ({ id: r.id, number: r.number, status: r.status, created_at: r.created_at })),
        order_limit: CUSTOMER_ORDER_LIMIT,
      },
      portal_available: portal,
      private_visible: privileged && portal,
      data: rows.slice(0, PAGE).map((r) => ({
        id: r.id,
        channel: r.channel,
        direction: r.direction,
        state: r.state,
        order_id: r.order_id,
        order_number: numbers.get(r.order_id) ?? null,
        at: r.at,
        title: hide(r) ? null : r.title,
        body: hide(r) ? null : r.body,
        party: hide(r) ? null : r.party,
      })),
      content_hidden: buyerScope && !privileged,
      meta: {
        cursor:
          rows.length > PAGE
            ? Buffer.from(JSON.stringify([rows[PAGE - 1].cursor_time, rows[PAGE - 1].id])).toString('base64url')
            : null,
      },
    };
    return { view, register: buyerScope && privileged ? { email, ids: orders.map((r) => String(r.id)) } : null };
  });
  // Written after the read in its own append transaction, before the content leaves (fails closed).
  if (result.register && accessRegister)
    await logPersonalDataAccess(pool, a, localConfig.encryptionKey, [
      { action: 'read', ...BUYER_READ, email: result.register.email, order_count: result.register.ids.length, detail: { order_id: orderId, order_ids: result.register.ids } },
    ]);
  return result.view;
}
