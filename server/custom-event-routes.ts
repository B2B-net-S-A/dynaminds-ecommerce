/** AUTO-07 routes: definitions (administrator), raising for an order (administrator or operator; session or API key
 * through /api/v1) and the call history with the rule runs each call started (every member). */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { tenantReadTx, tenantTx } from './db';
import { ensure } from './errors';
import { audit, type Actor } from './domain';
import { customEventKey } from './operation-schema';
import {
  customEventInput,
  customEventUpdate,
  customEventRaiseInput,
  customEventsAvailableInTx,
  requireCustomEventsInTx,
  raiseCustomEventInTx,
} from './custom-events';

type Req = FastifyRequest & { actor: Actor };
const admin = (req: Req) => ensure(req.actor.role === 'admin', 403, 'Wymagana rola administratora');
const operate = (req: Req) => ensure(['admin', 'operator'].includes(req.actor.role), 403, 'Brak prawa obsługi zamówień');
const idParam = (p: unknown) => z.object({ id: z.uuid() }).parse(p).id;

export function registerCustomEventRoutes(app: FastifyInstance): void {
  app.get('/api/custom-events', (req) =>
    tenantReadTx((req as Req).actor.tenantId, async (c) => {
      if (!(await customEventsAvailableInTx(c))) return { available: false, data: [] };
      return { available: true, data: (await c.query('SELECT id,key,name,description,active,version,created_at,updated_at FROM custom_event_defs ORDER BY key')).rows };
    }),
  );
  app.post('/api/custom-events', (req) => {
    const r = req as Req;
    admin(r);
    const b = customEventInput.parse(req.body);
    return tenantTx(r.actor.tenantId, async (c) => {
      await requireCustomEventsInTx(c);
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['custom-event-defs:' + r.actor.tenantId]);
      ensure((await c.query('SELECT count(*)::int n FROM custom_event_defs')).rows[0].n < 50, 422, 'Limit 50 zdarzeń własnych');
      ensure(!(await c.query('SELECT 1 FROM custom_event_defs WHERE key=$1', [b.key])).rowCount, 409, 'Zdarzenie o tym kluczu już istnieje');
      const row = (await c.query(
        'INSERT INTO custom_event_defs(id,tenant_id,key,name,description,active,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$7) RETURNING *',
        [randomUUID(), r.actor.tenantId, b.key, b.name, b.description, b.active, r.actor.userId],
      )).rows[0];
      await audit(c, r.actor, 'custom_event.create', row.id, { key: b.key });
      return row;
    });
  });
  app.patch('/api/custom-events/:id', (req) => {
    const r = req as Req;
    admin(r);
    const b = customEventUpdate.parse(req.body);
    return tenantTx(r.actor.tenantId, async (c) => {
      await requireCustomEventsInTx(c);
      const row = (await c.query('SELECT * FROM custom_event_defs WHERE id=$1 FOR UPDATE', [idParam(req.params)])).rows[0];
      ensure(row, 404, 'Nie znaleziono zdarzenia własnego');
      ensure(row.version === b.version, 409, 'Zdarzenie zmieniło się, odśwież dane');
      const updated = (await c.query(
        'UPDATE custom_event_defs SET name=$2,description=$3,active=$4,version=version+1,updated_by=$5,updated_at=now() WHERE id=$1 RETURNING *',
        [row.id, b.name, b.description, b.active, r.actor.userId],
      )).rows[0];
      await audit(c, r.actor, 'custom_event.update', row.id, { active: b.active, version: updated.version });
      return updated;
    });
  });
  app.post('/api/custom-events/:key/raise', (req) => {
    const r = req as Req;
    operate(r);
    const key = z.object({ key: customEventKey }).safeParse(req.params);
    ensure(key.success, 404, 'Nie znaleziono zdarzenia własnego');
    const b = customEventRaiseInput.parse(req.body);
    return tenantTx(r.actor.tenantId, (c) => raiseCustomEventInTx(c, r.actor, b.order_id, key.data.key, b.client_key));
  });
  app.get('/api/custom-events/:id/calls', (req) => {
    const r = req as Req;
    const q = z.object({ after: z.uuid().optional() }).parse(req.query);
    return tenantReadTx(r.actor.tenantId, async (c) => {
      await requireCustomEventsInTx(c);
      const id = idParam(req.params);
      ensure((await c.query('SELECT 1 FROM custom_event_defs WHERE id=$1', [id])).rowCount, 404, 'Nie znaleziono zdarzenia własnego');
      const rows = (await c.query(
        `SELECT k.id,k.event_key,k.definition_version,k.order_id,o.number AS order_number,k.order_event_id,k.source,k.actor_id,k.api_key_id,k.operation_id,k.created_at
         FROM custom_event_calls k LEFT JOIN orders o ON o.id=k.order_id
         WHERE k.definition_id=$1 AND ($2::uuid IS NULL OR (k.created_at,k.id)<(SELECT created_at,id FROM custom_event_calls WHERE id=$2))
         ORDER BY k.created_at DESC,k.id DESC LIMIT 26`,
        [id, q.after ?? null],
      )).rows;
      const page = rows.slice(0, 25);
      const runs = page.length
        ? (await c.query(
            "SELECT event_id,rule_id,definition->>'name' AS rule_name,state,error,finished_at FROM automation_runs WHERE event_id=ANY($1::uuid[]) ORDER BY created_at,id",
            [page.map((x) => x.order_event_id)],
          )).rows
        : [];
      return {
        data: page.map((x) => ({ ...x, runs: runs.filter((run) => run.event_id === x.order_event_id).map(({ event_id: _e, ...run }) => run) })),
        meta: { cursor: rows.length > 25 ? page[24].id : null },
      };
    });
  });
}
