/**
 * In-app notifications of the v2 effect notify_team, without a migration: each notification is an audit_events row
 * (action 'automation.notification', entity_id = recipient). "Read" is an appended marker, never an edit:
 * 'automation.notification.read' (entity_id = notification, user_id = reader) or
 * 'automation.notification.read_all' (entity_id = user_id = reader; everything older is read).
 *   GET  /api/automations/v2/notifications            -> { unread, data: AutomationNotification[] } (last 30 days, 50)
 *   POST /api/automations/v2/notifications/:id/read   -> { ok, unread }
 *   POST /api/automations/v2/notifications/read-all   -> { ok, unread: 0 }
 *   GET  /api/automations/v2/rules/:id/webhook-secret -> { secret, header, algorithm } (admin; HMAC key of URL webhooks)
 */
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { tenantReadTx, tenantTx } from './db';
import { audit } from './domain';
import { ensure } from './errors';
import { ruleWebhookSecret } from './outbound-webhooks';
import { NOTIFICATION_ACTION } from './automation-v2-effects-comm';

const READ = NOTIFICATION_ACTION + '.read';
const READ_ALL = NOTIFICATION_ACTION + '.read_all';
const id = (p: unknown) => z.object({ id: z.uuid() }).parse(p).id;

/** SQL predicate "n is read by $1" for a notification row aliased n. */
const isRead = `(EXISTS(SELECT 1 FROM audit_events r WHERE r.action='${READ}' AND r.entity_id=n.id AND r.user_id=$1)
  OR n.created_at<=coalesce((SELECT max(a.created_at) FROM audit_events a WHERE a.action='${READ_ALL}' AND a.entity_id=$1 AND a.user_id=$1),'-infinity'))`;
const mine = `n.action='${NOTIFICATION_ACTION}' AND n.entity_id=$1 AND n.created_at>now()-interval '30 days'`;

async function unread(c: PoolClient, userId: string): Promise<number> {
  return (await c.query(`SELECT count(*)::int n FROM audit_events n WHERE ${mine} AND NOT ${isRead}`, [userId])).rows[0].n;
}

export function registerAutomationV2NotificationRoutes(app: FastifyInstance, base: string) {
  app.get(base + '/notifications', (req) =>
    tenantReadTx(req.actor.tenantId, async (c) => {
      const rows = (
        await c.query(`SELECT n.id,n.created_at,n.detail,${isRead} AS read FROM audit_events n WHERE ${mine} ORDER BY n.created_at DESC,n.id DESC LIMIT 50`, [
          req.actor.userId,
        ])
      ).rows;
      return {
        unread: await unread(c, req.actor.userId),
        data: rows.map((r) => ({
          id: r.id,
          created_at: new Date(r.created_at).toISOString(),
          rule_name: String(r.detail?.rule_name ?? ''),
          order_id: r.detail?.order_id ?? null,
          order_number: r.detail?.order_number ?? null,
          message: String(r.detail?.message ?? ''),
          /** Effect merge_orders: the proposed set, opened in the merge panel of the order list. */
          merge_order_ids: Array.isArray(r.detail?.merge_order_ids) ? (r.detail.merge_order_ids as string[]) : null,
          read: r.read === true,
        })),
      };
    }),
  );

  app.post(base + '/notifications/read-all', (req) =>
    tenantTx(req.actor.tenantId, async (c) => {
      await audit(c, req.actor, READ_ALL, req.actor.userId, {});
      return { ok: true, unread: 0 };
    }),
  );

  app.post(base + '/notifications/:id/read', (req) => {
    const notification = id(req.params);
    return tenantTx(req.actor.tenantId, async (c) => {
      const n = (await c.query(`SELECT n.id,${isRead} AS read FROM audit_events n WHERE n.id=$2 AND ${mine}`, [req.actor.userId, notification])).rows[0];
      ensure(n, 404, 'Nie znaleziono powiadomienia');
      if (!n.read) await audit(c, req.actor, READ, notification, {});
      return { ok: true, unread: await unread(c, req.actor.userId) };
    });
  });

  app.get(base + '/rules/:id/webhook-secret', (req) => {
    ensure(req.actor.role === 'admin', 403, 'Wymagana rola administratora');
    const ruleId = id(req.params);
    return tenantTx(req.actor.tenantId, async (c) => {
      const r = (await c.query("SELECT id FROM automation_rules WHERE id=$1 AND config->>'version'='2'", [ruleId])).rows[0];
      ensure(r, 404, 'Nie znaleziono reguły');
      await audit(c, req.actor, 'automation.v2.webhook_secret.read', ruleId, {});
      return {
        secret: ruleWebhookSecret(req.actor.tenantId, ruleId),
        header: 'X-Dyna-Signature',
        algorithm: 'v1=HMAC-SHA256(sekret, X-Dyna-Timestamp + "." + treść żądania)',
      };
    });
  });
}
