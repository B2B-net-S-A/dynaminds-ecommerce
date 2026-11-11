/** COM-008 (migration 245): one inbox for marketplace and helpdesk conversations.
 * - connections per channel (allegro, ebay, amazon, helpdesk), created by an administrator;
 * - the connector port ingestChannelMessages: idempotent on (thread, external message id), creates the thread on
 *   the first message, links an order only by an exact order number of this tenant, reopens a closed thread;
 * - threads without an order (questions before a purchase), assignment with CAS to an eligible member,
 *   linking an order, status, private notes and reply intents. No provider is called: a reply stays 'pending'
 *   until a connector for its channel exists (INTEGRATION.md, open items). */
import { randomUUID } from 'node:crypto';
import { automationOnlyEvent } from './automation-v2-triggers';
import { messageExcerpt } from './customer-messages';
import type { PoolClient } from 'pg';
import { tenantTx } from './db';
import { audit, type Actor } from './domain';
import { ensure } from './errors';
import {
  channelConnectionInput,
  channelIngestInput,
  channelMessageInput,
  channelThreadPatch,
  channelThreadsQuery,
} from './channel-inbox253-input';

type Row = Record<string, any>;
const missing = 'Wspólna skrzynka marketplace wymaga migracji 245; ta kopia bazy jej nie ma';
async function available(c: PoolClient) {
  return (await c.query("SELECT to_regclass('public.channel253_threads') IS NOT NULL ok")).rows[0].ok === true;
}
/** The member's current role (075 SECURITY DEFINER reader), not the one cached in the session. */
async function role(c: PoolClient, a: Actor): Promise<string | null> {
  return (await c.query('SELECT customer_message_role($1) r', [a.userId])).rows[0].r;
}
async function tx<T>(a: Actor, need: 'read' | 'write' | 'admin', fn: (c: PoolClient, r: string) => Promise<T>): Promise<T> {
  return tenantTx(a.tenantId, async (c) => {
    ensure(await available(c), 409, missing);
    const r = await role(c, a);
    ensure(r, 403, 'Brak dostępu do skrzynki');
    if (need === 'write') ensure(r === 'admin' || r === 'operator', 403, 'Odpowiada administrator albo operator');
    if (need === 'admin') ensure(r === 'admin', 403, 'Wymagana rola administratora');
    return fn(c, r!);
  });
}
const THREAD = `SELECT t.*,to_char(t.last_message_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_at,c.name connection_name,o.number order_number,customer_message_actor_name(t.assigned_user_id) assigned_name,
  (SELECT count(*)::int FROM channel253_messages m WHERE m.tenant_id=t.tenant_id AND m.thread_id=t.id AND m.kind='reply' AND m.state='pending') pending_replies
  FROM channel253_threads t JOIN channel253_connections c ON (c.tenant_id,c.id)=(t.tenant_id,t.connection_id) LEFT JOIN orders o ON o.id=t.order_id`;
const thread = async (c: PoolClient, id: string) => (await c.query(THREAD + ' WHERE t.id=$1', [id])).rows[0];

export async function channelInbox(a: Actor) {
  return tenantTx(a.tenantId, async (c) => {
    if (!(await available(c))) return { available: false, connections: [], can_write: false, can_manage: false };
    const r = await role(c, a);
    ensure(r, 403, 'Brak dostępu do skrzynki');
    return {
      available: true,
      connections: (await c.query('SELECT id,channel,name,enabled,version,created_at FROM channel253_connections ORDER BY channel,name')).rows,
      can_write: r === 'admin' || r === 'operator',
      can_manage: r === 'admin',
    };
  });
}
export async function createChannelConnection(a: Actor, input: unknown) {
  const b = channelConnectionInput.parse(input);
  return tx(a, 'admin', async (c) => {
    const dup = (await c.query('SELECT 1 FROM channel253_connections WHERE channel=$1 AND name=$2', [b.channel, b.name])).rowCount;
    ensure(!dup, 409, 'Połączenie o tej nazwie już istnieje');
    const row = (
      await c.query('INSERT INTO channel253_connections(id,tenant_id,channel,name,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *', [
        randomUUID(), a.tenantId, b.channel, b.name, a.userId,
      ])
    ).rows[0];
    await audit(c, a, 'channel.connection.create', row.id, { channel: b.channel });
    return { connection: row };
  });
}
/** The connector port. Repeating a page changes nothing (duplicates are counted, not stored twice). */
export async function ingestChannelMessages(a: Actor, connectionId: string, input: unknown) {
  const b = channelIngestInput.parse(input);
  return tx(a, 'admin', async (c) => {
    const conn = (await c.query('SELECT * FROM channel253_connections WHERE id=$1 FOR SHARE', [connectionId])).rows[0];
    ensure(conn, 404, 'Nie znaleziono połączenia');
    ensure(conn.enabled, 409, 'Połączenie jest wyłączone');
    let created = 0, duplicates = 0;
    const touched = new Set<string>();
    for (const m of b.messages) {
      await c.query(
        `INSERT INTO channel253_threads(id,tenant_id,connection_id,channel,external_thread_id,subject,buyer_ref) VALUES($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (tenant_id,connection_id,external_thread_id) DO NOTHING`,
        [randomUUID(), a.tenantId, conn.id, conn.channel, m.external_thread_id, m.subject, m.buyer_ref],
      );
      const t = (await c.query('SELECT * FROM channel253_threads WHERE connection_id=$1 AND external_thread_id=$2 FOR UPDATE', [conn.id, m.external_thread_id])).rows[0];
      touched.add(t.id);
      const inserted = (
        await c.query(
          `INSERT INTO channel253_messages(id,tenant_id,thread_id,kind,state,external_message_id,client_key,body,sent_at)
           VALUES($1,$2,$3,'inbound','received',$4,$5,$6,$7)
           ON CONFLICT (tenant_id,thread_id,external_message_id) WHERE external_message_id IS NOT NULL DO NOTHING RETURNING id`,
          [randomUUID(), a.tenantId, t.id, m.external_message_id, randomUUID(), m.body, m.sent_at],
        )
      ).rows[0]?.id as string | undefined;
      if (!inserted) {
        duplicates++;
        continue;
      }
      created++;
      const order = t.order_id === null && m.order_number
        ? // Only the order of this buyer: someone else's order number from the buyer's text links nothing.
          (await c.query('SELECT id FROM orders WHERE number=$1 AND lower(email)=lower($2)', [m.order_number, m.buyer_ref])).rows[0]?.id ?? null
        : t.order_id;
      await c.query(
        `UPDATE channel253_threads SET message_count=message_count+1,version=version+1,status='open',order_id=$2,
           subject=CASE WHEN subject='' THEN $3 ELSE subject END,buyer_ref=CASE WHEN buyer_ref='' THEN $4 ELSE buyer_ref END,
           last_message_at=greatest(last_message_at,coalesce($5::timestamptz,now())),updated_at=now() WHERE id=$1`,
        [t.id, order, m.subject, m.buyer_ref, m.sent_at],
      );
      // Automation rules v2 "Wiadomość od klienta" (marketplace): only a message of a thread linked to an order.
      if (order)
        await automationOnlyEvent(c, a.tenantId, order, 'customer_message.received', {
          channel: conn.channel,
          message_id: inserted,
          excerpt: messageExcerpt(m.body),
        });
    }
    await audit(c, a, 'channel.messages.ingest', conn.id, { created, duplicates });
    return { created, duplicates, threads: touched.size };
  });
}
export async function channelThreads(a: Actor, input: unknown) {
  const q = channelThreadsQuery.parse(input);
  return tx(a, 'read', async (c) => {
    const cursor = q.cursor?.match(/^([0-9T:.+\-Z]{20,40})\|([0-9a-f-]{36})$/);
    ensure(!q.cursor || cursor, 400, 'Nieprawidłowy kursor');
    const rows = (
      await c.query(
        THREAD +
          ` WHERE ($1::text IS NULL OR t.channel=$1) AND ($2::text IS NULL OR t.status=$2)
            AND ($3::text IS NULL OR ($3='me' AND t.assigned_user_id=$4) OR ($3='none' AND t.assigned_user_id IS NULL))
            AND (NOT $5 OR t.order_id IS NULL)
            AND ($6::timestamptz IS NULL OR (t.last_message_at,t.id)<($6::timestamptz,$7::uuid))
          ORDER BY t.last_message_at DESC,t.id DESC LIMIT 51`,
        [q.channel ?? null, q.status ?? null, q.assigned ?? null, a.userId, q.unlinked === '1', cursor?.[1] ?? null, cursor?.[2] ?? null],
      )
    ).rows;
    const page = rows.slice(0, 50), last = page.at(-1);
    return { data: page, meta: { cursor: rows.length > 50 && last ? last.cursor_at + '|' + last.id : null } };
  });
}
export async function channelThread(a: Actor, id: string) {
  return tx(a, 'read', async (c, r) => {
    const t = await thread(c, id);
    ensure(t, 404, 'Nie znaleziono rozmowy');
    const messages = (
      await c.query(
        `SELECT id,kind,state,external_message_id,body,sent_at,created_at,actor_id,customer_message_actor_name(actor_id) actor_name
         FROM channel253_messages WHERE thread_id=$1 AND ($2 OR kind<>'note') ORDER BY created_at,id`,
        [id, r === 'admin' || r === 'operator'],
      )
    ).rows;
    return { thread: t, messages, can_write: r === 'admin' || r === 'operator' };
  });
}
async function eligible(c: PoolClient, user: string) {
  let after: string | null = null;
  for (let i = 0; i < 50; i++) {
    const page: Row[] = (await c.query('SELECT user_id FROM customer_message_eligible_assignees($1)', [after])).rows;
    if (page.some((p) => p.user_id === user)) return true;
    if (page.length < 101) return false;
    after = page[page.length - 1].user_id;
  }
  return false;
}
export async function changeChannelThread(a: Actor, id: string, input: unknown) {
  const b = channelThreadPatch.parse(input);
  return tx(a, 'write', async (c) => {
    const t = (await c.query('SELECT * FROM channel253_threads WHERE id=$1 FOR UPDATE', [id])).rows[0];
    ensure(t, 404, 'Nie znaleziono rozmowy');
    ensure(t.version === b.version, 409, 'Rozmowa zmieniła się w międzyczasie. Odśwież widok.');
    if (b.assigned_user_id) ensure(await eligible(c, b.assigned_user_id), 422, 'Tę rozmowę może prowadzić administrator albo operator tej firmy');
    let order = t.order_id;
    if (b.order_number !== undefined) {
      order = (await c.query('SELECT id FROM orders WHERE number=$1', [b.order_number])).rows[0]?.id;
      ensure(order, 404, 'Nie znaleziono zamówienia o tym numerze');
    } else if (b.order_id !== undefined) {
      if (b.order_id) ensure((await c.query('SELECT 1 FROM orders WHERE id=$1', [b.order_id])).rowCount, 404, 'Nie znaleziono zamówienia');
      order = b.order_id;
    }
    await c.query(
      `UPDATE channel253_threads SET status=$2,assigned_user_id=$3,order_id=$4,version=version+1,updated_at=now() WHERE id=$1`,
      [id, b.status ?? t.status, b.assigned_user_id === undefined ? t.assigned_user_id : b.assigned_user_id, order],
    );
    await audit(c, a, 'channel.thread.update', id, {
      status: b.status, assigned_user_id: b.assigned_user_id, order_id: order === t.order_id ? undefined : order,
    });
    return { thread: await thread(c, id) };
  });
}
export async function addChannelMessage(a: Actor, id: string, input: unknown) {
  const b = channelMessageInput.parse(input);
  return tx(a, 'write', (c) => appendChannelMessageInTx(c, a, id, b));
}
/** The same reply/note for a caller already inside the tenant transaction (automation rules v2): the caller has
 * checked the table exists and the actor's current role (admin or operator). A reply stays 'pending'. */
export async function appendChannelMessageInTx(c: PoolClient, a: Actor, id: string, input: unknown) {
  const b = channelMessageInput.parse(input);
  {
    const t = (await c.query('SELECT id FROM channel253_threads WHERE id=$1 FOR UPDATE', [id])).rows[0];
    ensure(t, 404, 'Nie znaleziono rozmowy');
    const prior = (await c.query('SELECT * FROM channel253_messages WHERE thread_id=$1 AND client_key=$2', [id, b.client_key])).rows[0];
    if (prior) {
      ensure(prior.kind === b.kind && prior.body === b.body && prior.actor_id === a.userId, 409, 'Ten klucz użyto dla innej wiadomości');
      return { message: prior, reused: true };
    }
    const message = (
      await c.query(
        `INSERT INTO channel253_messages(id,tenant_id,thread_id,kind,state,actor_id,client_key,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [randomUUID(), a.tenantId, id, b.kind, b.kind === 'reply' ? 'pending' : 'note', a.userId, b.client_key, b.body],
      )
    ).rows[0];
    await c.query(
      `UPDATE channel253_threads SET message_count=message_count+1,version=version+1,updated_at=now(),
         last_message_at=CASE WHEN $2 THEN now() ELSE last_message_at END WHERE id=$1`,
      [id, b.kind === 'reply'],
    );
    await audit(c, a, 'channel.message.' + b.kind, message.id, { thread_id: id });
    return { message, reused: false };
  }
}
export async function orderChannelThreads(a: Actor, orderId: string) {
  return tenantTx(a.tenantId, async (c) => {
    if (!(await available(c))) return { available: false, data: [] };
    ensure(await role(c, a), 403, 'Brak dostępu do skrzynki');
    return { available: true, data: (await c.query(THREAD + ' WHERE t.order_id=$1 ORDER BY t.last_message_at DESC,t.id DESC LIMIT 20', [orderId])).rows };
  });
}
