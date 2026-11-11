import { lockEmailQueue } from './email-actions';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { tenantReadTx, tenantTx } from './db';
import { ensure } from './errors';
import { audit } from './domain';
import { scheduleCreate, scheduleEdit, scheduleQueue } from './automation-schedule-schema';
import {
  scheduleHash,
  validateSchedule,
  cancelScheduleRuns,
  enqueueSchedule,
  previewSchedule,
} from './automation-schedules';
export function registerAutomationScheduleRoutes(app: FastifyInstance) {
  const id = (p: unknown) => z.object({ id: z.uuid() }).parse(p).id;
  const admin = (req: any) =>
    ensure(req.actor.role === 'admin', 403, 'Wymagana rola administratora');
  app.get('/api/automation-schedules', (req) =>
    tenantReadTx(req.actor.tenantId, async (c) => ({
      data: (
        await c.query(`SELECT s.*,r.state AS last_state,r.scanned AS last_scanned,r.done AS last_done,r.failed AS last_failed,r.error AS last_error
      FROM automation_schedules s LEFT JOIN LATERAL(SELECT state,scanned,done,failed,error FROM automation_schedule_runs WHERE schedule_id=s.id ORDER BY created_at DESC,id DESC LIMIT 1)r ON true ORDER BY s.name,s.id LIMIT 100`)
      ).rows,
    })),
  );
  app.post('/api/automation-schedules', (req) => {
    admin(req);
    const { client_key, ...input } = scheduleCreate.parse(req.body);
    return tenantTx(req.actor.tenantId, async (c) => {
      await lockEmailQueue(c, req.actor.tenantId);
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'automation-schedules:' + req.actor.tenantId,
      ]);
      const hash = scheduleHash(input),
        old = (
          await c.query('SELECT * FROM automation_schedules WHERE client_key=$1', [client_key])
        ).rows[0];
      if (old) {
        ensure(old.creation_hash === hash, 409, 'Klucz ponowienia ma inną konfigurację');
        return old;
      }
      ensure(
        (await c.query('SELECT count(*)::int AS n FROM automation_schedules')).rows[0].n < 100,
        422,
        'Limit 100 harmonogramów',
      );
      await validateSchedule(c, input);
      const r = (
        await c.query(
          `INSERT INTO automation_schedules(id,tenant_id,actor_id,name,enabled,definition,client_key,creation_hash,next_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $5 THEN automation_next_at($9,now()) ELSE NULL END) RETURNING *`,
          [
            randomUUID(),
            req.actor.tenantId,
            req.actor.userId,
            input.name,
            input.enabled,
            JSON.stringify(input),
            client_key,
            hash,
            JSON.stringify(input.frequency),
          ],
        )
      ).rows[0];
      await audit(c, req.actor, 'automation.schedule.create', r.id, { enabled: r.enabled });
      return r;
    });
  });
  app.patch('/api/automation-schedules/:id', (req) => {
    admin(req);
    const toggle = z
      .object({ version: z.string().regex(/^\d+$/), enabled: z.boolean() })
      .strict()
      .safeParse(req.body);
    const full = toggle.success ? null : scheduleEdit.parse(req.body);
    return tenantTx(req.actor.tenantId, async (c) => {
      await lockEmailQueue(c, req.actor.tenantId);
      const old = (
        await c.query('SELECT * FROM automation_schedules WHERE id=$1 FOR UPDATE', [id(req.params)])
      ).rows[0];
      ensure(old, 404, 'Nie znaleziono harmonogramu');
      ensure(
        old.version === (toggle.success ? toggle.data.version : full!.version),
        409,
        'Harmonogram zmienił się; odśwież dane',
      );
      const input = full
        ? (({ version, ...v }) => v)(full)
        : { ...old.definition, enabled: toggle.success && toggle.data.enabled };
      if (!toggle.success || input.enabled) await validateSchedule(c, input);
      // Switching on/off changes fencing, but preserves the once-per-definition receipts.
      const changed =
        full &&
        !isDeepStrictEqual({ ...input, enabled: false }, { ...old.definition, enabled: false });
      await cancelScheduleRuns(c, old.id);
      const r = (
        await c.query(
          `UPDATE automation_schedules SET name=$2,enabled=$3,definition=$4,actor_id=$5,version=version+1,
        definition_version=definition_version+$6,error=NULL,next_at=CASE WHEN $3 THEN automation_next_at($7,now()) ELSE NULL END,updated_at=now() WHERE id=$1 RETURNING *`,
          [
            old.id,
            input.name,
            input.enabled,
            JSON.stringify(input),
            req.actor.userId,
            changed ? 1 : 0,
            JSON.stringify(input.frequency),
          ],
        )
      ).rows[0];
      await audit(c, req.actor, 'automation.schedule.update', old.id, {
        version: r.version,
        definition_version: r.definition_version,
        enabled: r.enabled,
      });
      return r;
    });
  });
  app.post('/api/automation-schedules/:id/preview', (req) => {
    admin(req);
    z.object({})
      .strict()
      .parse(req.body ?? {});
    return tenantTx(req.actor.tenantId, async (c) => {
      await lockEmailQueue(c, req.actor.tenantId);
      const s = (
        await c.query('SELECT * FROM automation_schedules WHERE id=$1 FOR SHARE', [id(req.params)])
      ).rows[0];
      ensure(s, 404, 'Nie znaleziono harmonogramu');
      return previewSchedule(c, req.actor, s);
    });
  });
  app.post('/api/automation-schedules/:id/run', (req) => {
    admin(req);
    const b = scheduleQueue.parse(req.body);
    return tenantTx(req.actor.tenantId, async (c) => {
      await lockEmailQueue(c, req.actor.tenantId);
      const s = (
        await c.query('SELECT * FROM automation_schedules WHERE id=$1 FOR UPDATE', [id(req.params)])
      ).rows[0];
      ensure(s, 404, 'Nie znaleziono harmonogramu');
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'schedule-run:' + req.actor.tenantId + ':' + b.client_key,
      ]);
      const hash = scheduleHash({ schedule_id: s.id, version: b.version });
      const old = (
        await c.query('SELECT * FROM automation_schedule_runs WHERE client_key=$1', [b.client_key])
      ).rows[0];
      if (old) {
        ensure(old.request_hash === hash, 409, 'Klucz ponowienia dotyczy innego wykonania');
        return old;
      }
      ensure(s.version === b.version, 409, 'Harmonogram zmienił się; odśwież dane');
      return enqueueSchedule(c, req.actor, s, b.client_key, hash);
    });
  });
  app.get('/api/automation-schedules/:id/runs', (req) => {
    const q = z.object({ after: z.uuid().optional() }).parse(req.query);
    return tenantReadTx(req.actor.tenantId, async (c) => {
      const scheduleId = id(req.params);
      ensure(
        (await c.query('SELECT id FROM automation_schedules WHERE id=$1', [scheduleId])).rowCount,
        404,
        'Nie znaleziono harmonogramu',
      );
      const rows = (
        await c.query(
          `SELECT * FROM automation_schedule_runs WHERE schedule_id=$1 AND ($2::uuid IS NULL OR
        (created_at,id)<(SELECT created_at,id FROM automation_schedule_runs WHERE id=$2 AND schedule_id=$1)) ORDER BY created_at DESC,id DESC LIMIT 26`,
          [scheduleId, q.after ?? null],
        )
      ).rows;
      return { data: rows.slice(0, 25), meta: { cursor: rows.length > 25 ? rows[24].id : null } };
    });
  });
  app.get('/api/automation-schedule-runs/:id', (req) => {
    const q = z.object({ after: z.uuid().optional() }).parse(req.query);
    return tenantReadTx(req.actor.tenantId, async (c) => {
      const run = (
        await c.query(
          'SELECT r.*,j.state AS job_state,j.error AS job_error FROM automation_schedule_runs r JOIN jobs j ON (j.tenant_id,j.id)=(r.tenant_id,r.job_id) WHERE r.id=$1',
          [id(req.params)],
        )
      ).rows[0];
      ensure(run, 404, 'Nie znaleziono wykonania');
      const rows = (
        await c.query(
          'SELECT * FROM automation_schedule_items WHERE run_id=$1 AND ($2::uuid IS NULL OR order_id>$2) ORDER BY order_id LIMIT 26',
          [run.id, q.after ?? null],
        )
      ).rows;
      return {
        ...run,
        items: rows.slice(0, 25),
        meta: { cursor: rows.length > 25 ? rows[24].order_id : null },
      };
    });
  });
}
