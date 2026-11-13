import {
  customerWorkflowBody,
  customerMessageAssignment,
} from './customer-message-workflow-schema';
import {
  receiveCustomerMessageWorkflowInTx,
  customerMessageWorkflowAvailableInTx,
  customerMessageWorkflowGrantsInTx,
  customerMessageWorkflowRoleInTx,
} from './customer-message-workflows';
import { automationOnlyEvent } from './automation-v2-triggers';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool, tenantTx } from './db';
import { audit, type Actor } from './domain';
import { ensure, Problem } from './errors';
export const customerMessageInput = z.strictObject({
  client_key: z.uuid(),
  body: customerWorkflowBody,
});
export const customerMessageStatus = z.strictObject({
  status: z.enum(['open', 'closed']),
  version: z.number().int().positive(),
});
export const customerMessageQuery = z.strictObject({
  status: z.enum(['open', 'closed']).optional(),
  order_id: z.uuid().optional(),
  cursor: z.string().max(300).optional(),
});
export const customerMessagePage = z.strictObject({ cursor: z.string().max(300).optional() });
export const customerMessageToken = z.object({ token: z.string().regex(/^[a-f0-9]{48}$/) });
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
function after(value?: string) {
  if (!value) return null;
  try {
    return z
      .tuple([z.iso.datetime(), z.uuid()])
      .parse(JSON.parse(Buffer.from(value, 'base64url').toString()));
  } catch {
    throw new Problem(422, 'Nieprawidłowy kursor wiadomości');
  }
}
const cursor = (row: any, id = 'id') =>
  Buffer.from(JSON.stringify([row.cursor_time, row[id]])).toString('base64url');
export async function customerMessageRole(c: PoolClient, a: Actor) {
  const r = (await c.query('SELECT customer_message_role($1) role', [a.userId])).rows[0]?.role;
  ensure(r, 403, 'Brak aktualnego dostępu do firmy');
  return r as Actor['role'];
}
const writer = (role: string) =>
  ensure(['admin', 'operator'].includes(role), 403, 'Wymagany aktualny administrator lub operator');
const flags = (role: string) => ({
  current_role: role,
  can_reply: ['admin', 'operator'].includes(role),
  can_note: ['admin', 'operator'].includes(role),
  can_status: ['admin', 'operator'].includes(role),
  can_assign: ['admin', 'operator'].includes(role),
});
const privateAllowed = (role: string) => ['admin', 'operator'].includes(role);
async function orderLock(c: PoolClient, id: string, write: boolean) {
  const o = (
    await c.query(
      'SELECT id,portal_token,portal_enabled,portal_expires_at FROM orders WHERE id=$1' +
        (write ? ' FOR UPDATE' : ' FOR SHARE'),
      [id],
    )
  ).rows[0];
  ensure(o, 404, 'Nie znaleziono zamówienia');
  return o;
}
async function thread(c: PoolClient, id: string) {
  const t = (await c.query('SELECT * FROM customer_message_threads WHERE id=$1', [id])).rows[0];
  ensure(t, 404, 'Nie znaleziono rozmowy');
  return t;
}
async function ownThread(c: PoolClient, id: string, write = false) {
  const t = await thread(c, id);
  await orderLock(c, t.order_id, write);
  return thread(c, id);
}
const publicMessage = (m: any) => ({
  id: m.public_id,
  kind: m.kind,
  body: m.body,
  created_at: m.created_at,
});
const staffMessage = (m: any, role: string) => ({
  id: m.id,
  kind: m.kind,
  body: m.body,
  created_at: m.created_at,
  ...(privateAllowed(role) ? { author_id: m.actor_id, author_name: m.author_name ?? null } : {}),
  ...(m.kind==='email'&&privateAllowed(role)?{email:m.inbound_email??null,received_by:m.actor_id}:{}),
});
const timeExpr = (priv: boolean) =>
  priv
    ? 't.last_message_at'
    : 'greatest(t.created_at,t.status_changed_at,coalesce(t.last_public_message_at,t.created_at))';
const createdExpr = (priv: boolean) =>
  priv
    ? 't.created_at'
    : "(SELECT min(m.created_at) FROM customer_messages m WHERE m.thread_id=t.id AND m.kind IN ('buyer','reply'))";
function threadHead(t: any, priv: boolean) {
  return {
    id: t.id,
    order_id: t.order_id,
    order_number: t.order_number,
    customer_name: t.customer_name,
    status: t.status,
    ...(priv
      ? {
          version: t.version,
          assigned_user_id: t.assigned_user_id ?? null,
          assigned_user_name: t.assigned_user_name ?? null,
        }
      : {}),
    created_at: t.visible_created_at,
    updated_at: priv ? t.updated_at : t.activity_at,
    last_message_at: priv ? t.last_message_at : t.activity_at,
    last_public_message_at: t.last_public_message_at,
    message_count: priv ? t.message_count : t.public_message_count,
    public_message_count: t.public_message_count,
  };
}
export async function customerMessageHistory(a: Actor, q: z.infer<typeof customerMessageQuery>) {
  const page = after(q.cursor);
  return tenantTx(a.tenantId, async (c) => {
    const role = await customerMessageWriteRole(c, a),
      priv = privateAllowed(role),
      activity = timeExpr(priv),
      args: any[] = [q.status ?? null, q.order_id ?? null];
    if (page) args.push(...page);
    const rows = (
      await c.query(
        `SELECT t.*,o.number order_number,o.customer_name,${priv ? "customer_message_actor_name((to_jsonb(t)->>'assigned_user_id')::uuid)" : 'NULL::text'} assigned_user_name,${activity} activity_at,${createdExpr(priv)} visible_created_at,to_char(${activity} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_time FROM customer_message_threads t JOIN orders o ON (o.tenant_id,o.id)=(t.tenant_id,t.order_id) WHERE ${priv ? 'true' : 't.public_message_count>0'} AND ($1::text IS NULL OR t.status=$1) AND ($2::uuid IS NULL OR t.order_id=$2) ${page ? `AND (${activity},t.id)<($3::timestamptz,$4::uuid)` : ''} ORDER BY ${activity} DESC,t.id DESC LIMIT 21`,
        args,
      )
    ).rows;
    return {
      ...flags(role),
      data: rows.slice(0, 20).map((t) => threadHead(t, priv)),
      meta: { cursor: rows.length > 20 ? cursor(rows[19]) : null },
    };
  });
}
export async function customerMessageDetail(
  a: Actor,
  id: string,
  query: z.infer<typeof customerMessagePage> = {},
) {
  const page = after(query.cursor);
  return tenantTx(a.tenantId, async (c) => {
    await customerMessageRole(c, a);
    const t = await ownThread(c, id);
    const role = await customerMessageWriteRole(c, a),
      priv = privateAllowed(role);
    ensure(priv || t.public_message_count > 0, 404, 'Nie znaleziono rozmowy');
    const head = (
      await c.query(
        `SELECT t.*,o.number order_number,o.customer_name,${priv ? "customer_message_actor_name((to_jsonb(t)->>'assigned_user_id')::uuid)" : 'NULL::text'} assigned_user_name,${timeExpr(priv)} activity_at,${createdExpr(priv)} visible_created_at FROM customer_message_threads t JOIN orders o ON (o.tenant_id,o.id)=(t.tenant_id,t.order_id) WHERE t.id=$1`,
        [t.id],
      )
    ).rows[0];
    const rows = (
      await c.query(
        `SELECT m.*,${priv ? 'customer_message_actor_name(m.actor_id)' : 'NULL::text'} author_name,to_char(m.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_time FROM customer_messages m  WHERE m.thread_id=$1 ${priv ? '' : "AND m.kind IN('buyer','reply')"} ${page ? 'AND (m.created_at,m.id)<($2::timestamptz,$3::uuid)' : ''} ORDER BY m.created_at DESC,m.id DESC LIMIT 21`,
        page ? [id, ...page] : [id],
      )
    ).rows;
    if(priv&&rows.some(m=>m.kind==='email'))for(const m of rows.filter(m=>m.kind==='email'))m.inbound_email=(await c.query('SELECT email_inbound_core_message_metadata($1,$2,$3) r',[m.id,a.userId,(a as Actor&{apiKeyId?:string}).apiKeyId??null])).rows[0].r;
    return {
      ...threadHead(head, priv),
      ...flags(role),
      data: rows.slice(0, 20).map((m) => staffMessage(m, role)),
      meta: { cursor: rows.length > 20 ? cursor(rows[19]) : null },
    };
  });
}
// Exported for future order automations: caller must use tenantTx and a current
// staff actor. This only writes the local portal; it never sends email or SMS.
export async function appendCustomerOrderMessage(
  c: PoolClient,
  a: Actor,
  orderId: string,
  kind: 'reply' | 'note',
  input: z.infer<typeof customerMessageInput>,
) {
  const role = await customerMessageRole(c, a);
  writer(role);
  await orderLock(c, orderId, true);
  const currentRole = await customerMessageWriteRole(c, a);
  writer(currentRole);
  const t = await ensureThread(c, a.tenantId, orderId);
  return append(c, t, kind, a.userId, customerMessageInput.parse(input), currentRole);
}
/** Trusted inbound adapter: only called inside the source binding admission.
 * No portal token/event is fabricated and the real RFC author stays separate. */
export async function appendInboundCustomerMessageInTx(c:PoolClient,a:Actor,orderId:string,input:{client_key:string;body:string;message_id:string;headers:unknown;account_id:string;raw_sha256:string}){
  ensure(typeof input.body==='string'&&input.body.length<=20000,422,'Niepoprawny pełny tekst email');
  writer(await customerMessageRole(c,a));await orderLock(c,orderId,true);
  const t=await ensureThread(c,a.tenantId,orderId);
  const role=await customerMessageRole(c,a);writer(role);
  return append(c,t,'email',a.userId,{client_key:input.client_key,body:input.body},role);
}
async function ensureThread(c: PoolClient, tenantId: string, orderId: string) {
  const old = (await c.query('SELECT * FROM customer_message_threads WHERE order_id=$1', [orderId]))
    .rows[0];
  if (old) return old;
  return (
    await c.query(
      'INSERT INTO customer_message_threads(id,tenant_id,order_id) VALUES($1,$2,$3) RETURNING *',
      [randomUUID(), tenantId, orderId],
    )
  ).rows[0];
}
async function append(
  c: PoolClient,
  t: any,
  kind: 'buyer' | 'reply' | 'note' | 'email',
  actorId: string | null,
  input: z.infer<typeof customerMessageInput>,
  role = 'admin',
  portalToken?: string,
): Promise<{ message: any; reused: boolean; status: string }> {
  const requestHash = hash({ kind, actorId, body: input.body });
  const existing = (
    await c.query('SELECT * FROM customer_messages WHERE thread_id=$1 AND client_key=$2', [
      t.id,
      input.client_key,
    ])
  ).rows[0];
  if (existing) {
    ensure(
      existing.request_hash === requestHash,
      409,
      'Klucz wiadomości wykorzystano dla innych danych',
    );
    return {
      message: kind === 'buyer' ? publicMessage(existing) : staffMessage(existing, role),
      reused: true,
      status: t.status,
    };
  }
  ensure(t.message_count < 1000, 429, 'Rozmowa osiągnęła limit 1000 wiadomości');
  const recent = (
    await c.query(
      "SELECT count(*) FILTER(WHERE created_at>now()-interval '1 hour')::int hourly,count(*)::int daily FROM customer_messages WHERE thread_id=$1 AND kind=$2 AND created_at>now()-interval '1 day'",
      [t.id, kind],
    )
  ).rows[0];
  ensure(
    recent.hourly < (kind === 'buyer' ? 30 : 100) && recent.daily < (kind === 'buyer' ? 100 : 500),
    429,
    'Limit wiadomości rozmowy; spróbuj później',
  );
  const m = (
    await c.query(
      'INSERT INTO customer_messages(id,public_id,tenant_id,order_id,thread_id,kind,actor_id,client_key,request_hash,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
      [
        randomUUID(),
        randomUUID(),
        t.tenant_id,
        t.order_id,
        t.id,
        kind,
        actorId,
        input.client_key,
        requestHash,
        input.body,
      ],
    )
  ).rows[0];
  await c.query(
    "UPDATE customer_message_threads SET version=version+1,message_count=message_count+1,public_message_count=public_message_count+$2,last_message_at=now(),last_public_message_at=CASE WHEN $2=1 THEN now() ELSE last_public_message_at END,status=CASE WHEN $3 IN('buyer','email') THEN 'open' ELSE status END,status_changed_at=CASE WHEN $3 IN('buyer','email') AND status='closed' THEN now() ELSE status_changed_at END,updated_at=now() WHERE id=$1",
    [t.id, kind === 'note'||kind==='email' ? 0 : 1, kind],
  );
  await audit(c, { tenantId: t.tenant_id, userId: actorId }, 'customer.message.' + kind, m.id, {
    order_id: t.order_id,
    thread_id: t.id,
    delivery: kind === 'reply' ? 'local_portal' : kind === 'note' ? 'private_note' : kind==='email'?'inbound_email':'buyer_portal',
  });
  if (kind === 'buyer' && portalToken)
    await receiveCustomerMessageWorkflowInTx(c, t.tenant_id, t.order_id, t.id, m.id, portalToken);
  // Automation rules v2 "Wiadomość od klienta": every new buyer message of the order, independent of the
  // message workflows above (they keep their own receipts and rules).
  if (kind === 'buyer' || kind === 'email')
    await automationOnlyEvent(c, t.tenant_id, t.order_id, 'customer_message.received', {
      channel: kind === 'email' ? 'email' : 'portal',
      message_id: m.id,
      excerpt: messageExcerpt(input.body),
    });
  return {
    message: kind === 'buyer' ? publicMessage(m) : staffMessage(m, role),
    reused: false,
    status: kind === 'buyer' ? 'open' : t.status,
  };
}
/** Short single-line excerpt of a message for the order history (the full text stays in the thread). */
export function messageExcerpt(body: string, max = 120): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  // Never end on half of a surrogate pair: a lone surrogate is not valid jsonb text (order_events.detail).
  const cut = flat.slice(0, max - 1);
  return (/[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut) + '…';
}
export async function writeCustomerMessage(
  a: Actor,
  id: string,
  kind: 'reply' | 'note',
  input: z.infer<typeof customerMessageInput>,
) {
  return tenantTx(a.tenantId, async (c) => {
    const role = await customerMessageRole(c, a);
    writer(role);
    const t = await ownThread(c, id, true);
    const currentRole = await customerMessageWriteRole(c, a);
    writer(currentRole);
    const result = await append(c, t, kind, a.userId, input, currentRole);
    if (result.message.kind !== 'buyer')
      result.message = {
        ...result.message,
        author_name:
          (await c.query('SELECT customer_message_actor_name($1) name', [a.userId])).rows[0]
            ?.name ?? null,
      };
    return result;
  });
}
export async function changeCustomerMessageStatus(
  a: Actor,
  id: string,
  input: z.infer<typeof customerMessageStatus>,
) {
  await tenantTx(a.tenantId, async (c) => {
    const role = await customerMessageRole(c, a);
    writer(role);
    const t = await ownThread(c, id, true);
    writer(await customerMessageWriteRole(c, a));
    ensure(t.version === input.version, 409, 'Rozmowa zmieniła się; odśwież historię');
    const result = await c.query(
      'UPDATE customer_message_threads SET status=$2,version=version+1,status_changed_at=now(),last_message_at=now(),updated_at=now() WHERE id=$1 AND version=$3 RETURNING id',
      [id, input.status, input.version],
    );
    ensure(result.rowCount, 409, 'Rozmowa zmieniła się');
    await audit(c, a, 'customer.message.status', id, { status: input.status });
  });
  return customerMessageDetail(a, id);
}
export async function resolveCustomerMessageToken(token: string) {
  const ref = (
    await pool.query(
      'SELECT id,tenant_id FROM orders WHERE portal_token=$1 AND portal_enabled AND (portal_expires_at IS NULL OR portal_expires_at>now())',
      [token],
    )
  ).rows[0];
  ensure(ref, 404, 'Nie znaleziono aktywnego linku zamówienia');
  return ref;
}
export async function publicCustomerMessageRead(
  ref: { id: string; tenant_id: string },
  token: string,
  query: z.infer<typeof customerMessagePage> = {},
) {
  const page = after(query.cursor);
  return tenantTx(ref.tenant_id, async (c) => {
    const o = await orderLock(c, ref.id, false);
    ensure(
      o.portal_token === token &&
        o.portal_enabled &&
        (!o.portal_expires_at || o.portal_expires_at > new Date()),
      404,
      'Nie znaleziono aktywnego linku zamówienia',
    );
    const t = (
      await c.query(
        'SELECT id,status FROM customer_message_threads WHERE order_id=$1 AND public_message_count>0',
        [ref.id],
      )
    ).rows[0];
    if (!t) return { status: null, data: [], meta: { cursor: null } };
    const rows = (
      await c.query(
        `SELECT public_id,kind,body,created_at,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_time FROM customer_messages WHERE thread_id=$1 AND kind IN ('buyer','reply') ${page ? 'AND (created_at,public_id)<($2::timestamptz,$3::uuid)' : ''} ORDER BY created_at DESC,public_id DESC LIMIT 21`,
        page ? [t.id, ...page] : [t.id],
      )
    ).rows;
    return {
      status: t.status,
      data: rows.slice(0, 20).map(publicMessage),
      meta: { cursor: rows.length > 20 ? cursor(rows[19], 'public_id') : null },
    };
  });
}
export async function publicCustomerMessageWrite(
  ref: { id: string; tenant_id: string },
  token: string,
  input: z.infer<typeof customerMessageInput>,
) {
  return tenantTx(ref.tenant_id, async (c) => {
    const o = await orderLock(c, ref.id, true);
    ensure(
      o.portal_token === token &&
        o.portal_enabled &&
        (!o.portal_expires_at || o.portal_expires_at > new Date()),
      404,
      'Nie znaleziono aktywnego linku zamówienia',
    );
    const t = await ensureThread(c, ref.tenant_id, ref.id);
    return append(c, t, 'buyer', null, input, 'admin', token);
  });
}

export async function customerMessageWriteRole(c: PoolClient, a: Actor) {
  return (await customerMessageWorkflowAvailableInTx(c))
    ? customerMessageWorkflowRoleInTx(c, a)
    : customerMessageRole(c, a);
}
export async function customerMessageAssignees(a: Actor, cursor?: string) {
  return tenantTx(a.tenantId, async (c) => {
    const role = await customerMessageWorkflowRoleInTx(c, a);
    if (!privateAllowed(role)) return { ...flags(role), data: [], meta: { cursor: null } };
    const rows = (
      await c.query('SELECT * FROM customer_message_eligible_assignees($1)', [cursor ?? null])
    ).rows;
    return {
      ...flags(role),
      data: rows.slice(0, 100),
      meta: { cursor: rows.length > 100 ? rows[99].user_id : null },
    };
  });
}
export async function changeCustomerMessageAssignment(
  a: Actor,
  id: string,
  input: z.infer<typeof customerMessageAssignment>,
) {
  await tenantTx(a.tenantId, async (c) => {
    const t = await ownThread(c, id, true);
    await c.query('SELECT id FROM customer_message_threads WHERE id=$1 FOR UPDATE', [id]);
    await customerMessageWorkflowGrantsInTx(c, a, [input.assigned_user_id]);
    ensure(t.version === input.version, 409, 'Rozmowa zmieniła się; odśwież historię');
    if ((t.assigned_user_id ?? null) === input.assigned_user_id) return;
    await c.query(
      'UPDATE customer_message_threads SET assigned_user_id=$2,version=version+1,updated_at=now(),last_message_at=now() WHERE id=$1',
      [id, input.assigned_user_id],
    );
    await audit(c, a, 'customer.message.assignment', id, {
      assigned_user_id: input.assigned_user_id,
    });
  });
  return customerMessageDetail(a, id);
}
