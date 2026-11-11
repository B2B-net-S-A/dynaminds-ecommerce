import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool, tenantTx } from './db';
import { audit, type Actor } from './domain';
import { ensure, Problem } from './errors';
import { dpdConnection } from './dpd-shipping';
import { previewCollectionTx, queueCollectionTx } from './dpd-collections';

const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const pickupScheduleInput = z
  .object({
    version: z.number().int().min(0),
    enabled: z.boolean(),
    time,
    weekdays: z
      .array(z.number().int().min(1).max(7))
      .min(1)
      .max(7)
      .refine((days) => new Set(days).size === days.length),
    business_days: z.number().int().min(0).max(7),
    from: time,
    to: time,
    confirm_external: z.boolean().default(false),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.from >= v.to)
      ctx.addIssue({ code: 'custom', message: 'Godzina od musi być przed godziną do' });
    const minutes = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
    if (v.business_days === 0 && minutes(v.from) <= minutes(v.time) + 15)
      ctx.addIssue({
        code: 'custom',
        message: 'Podjazd tego samego dnia musi zaczynać się ponad 15 minut po uruchomieniu',
      });
  });
export function scheduledPickupDate(due: Date, businessDays: number) {
  const date = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Warsaw',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(due);
  const d = new Date(date + 'T12:00:00Z');
  for (let n = 0; n < businessDays;) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (![0, 6].includes(d.getUTCDay())) n++;
  }
  return d.toISOString().slice(0, 10);
}
async function lockAccount(c: PoolClient, tenant: string, channel: string) {
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'dpd-collections:' + tenant + ':' + channel,
  ]);
  const ch = (
    await c.query("SELECT * FROM channels WHERE id=$1 AND provider='dpd' FOR SHARE", [channel])
  ).rows[0];
  ensure(ch, 404, 'Nie znaleziono konta DPD');
  return ch;
}
async function stopPending(c: PoolClient, channel: string) {
  const stopped = (
    await c.query(
      `UPDATE dpd_collections SET state='cancelled',error='Harmonogram wyłączono lub zmieniono',updated_at=now()
    WHERE channel_id=$1 AND schedule_run_id IS NOT NULL AND state='queued' AND phase='ready' RETURNING id,job_id`,
      [channel],
    )
  ).rows;
  await c.query('DELETE FROM dpd_pickup_claims WHERE collection_id=ANY($1::uuid[])', [
    stopped.map((r) => r.id),
  ]);
  await c.query(
    "UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL,error='Harmonogram wyłączono lub zmieniono' WHERE id=ANY($1::uuid[])",
    [stopped.map((r) => r.job_id)],
  );
  return stopped.length;
}
async function eligible(c: PoolClient, channel: string) {
  return (
    await c.query(
      `SELECT p.id,p.input->'sender' sender FROM shipping_plans p
    WHERE p.channel_id=$1 AND p.state='ready' AND p.input->>'provider'='dpd'
    AND NOT EXISTS(SELECT 1 FROM dpd_pickup_claims cl WHERE (cl.tenant_id,cl.plan_id)=(p.tenant_id,p.id))
    ORDER BY p.created_at,p.id LIMIT 2001`,
      [channel],
    )
  ).rows;
}
export async function scheduleDpdPickupsDue(now = new Date()) {
  const candidates = (
    await pool.query(
      `SELECT tenant_id,channel_id FROM dpd_pickup_schedules
    WHERE enabled AND next_at<=$1 ORDER BY next_at,channel_id LIMIT 20`,
      [now],
    )
  ).rows;
  for (const candidate of candidates)
    await tenantTx(candidate.tenant_id, async (c) => {
      const ch = await lockAccount(c, candidate.tenant_id, candidate.channel_id);
      const cfg = (
        await c.query(
          'SELECT * FROM dpd_pickup_schedules WHERE channel_id=$1 AND enabled AND next_at<=$2 FOR UPDATE',
          [ch.id, now],
        )
      ).rows[0];
      if (!cfg) return;
      const actor: Actor = { tenantId: candidate.tenant_id, userId: cfg.actor_id, role: 'admin' };
      const role = (
        await pool.query('SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2', [
          actor.tenantId,
          actor.userId,
        ])
      ).rows[0]?.role;
      if (role !== 'admin' || dpdConnection(ch) !== cfg.connection_hash) {
        const reason =
          role !== 'admin'
            ? 'Autor utracił rolę administratora'
            : 'Połączenie DPD zmieniło się; zapisz ponownie harmonogram';
        await stopPending(c, ch.id);
        await c.query(
          'UPDATE dpd_pickup_schedules SET enabled=false,next_at=NULL,error=$2,version=version+1,updated_at=now() WHERE channel_id=$1',
          [ch.id, reason],
        );
        await audit(c, actor, 'dpd.pickup.schedule.suspended', ch.id, { reason });
        return;
      }
      const due = new Date(cfg.next_at),
        definition = cfg.definition;
      const next = (
        await c.query('SELECT automation_next_at($1,$2) value', [
          {
            kind: 'daily',
            timezone: 'Europe/Warsaw',
            time: definition.time,
            weekdays: definition.weekdays,
          },
          now,
        ])
      ).rows[0].value;
      const id = randomUUID();
      if (now.getTime() - due.getTime() > 15 * 60000) {
        await c.query(
          "INSERT INTO dpd_pickup_runs(id,tenant_id,channel_id,version,scheduled_for,state) VALUES($1,$2,$3,$4,$5,'missed') ON CONFLICT DO NOTHING",
          [id, actor.tenantId, ch.id, cfg.version, due],
        );
        await c.query(
          "UPDATE dpd_pickup_schedules SET next_at=$2,error='Pominięto termin starszy niż 15 minut; nie zamówiono podjazdu wstecz',updated_at=now() WHERE channel_id=$1",
          [ch.id, next],
        );
        await audit(c, actor, 'dpd.pickup.schedule.missed', ch.id, { scheduled_for: due });
        return;
      }
      await c.query('SAVEPOINT pickup_schedule');
      try {
        const rows = await eligible(c, ch.id),
          selected = rows.slice(0, 2000),
          groups = new Map<string, string[]>();
        for (const row of selected) {
          const sender = JSON.stringify(row.sender);
          if (!groups.has(sender)) groups.set(sender, []);
          groups.get(sender)!.push(row.id);
        }
        const batchCount = [...groups.values()].reduce(
          (n, ids) => n + Math.ceil(ids.length / 200),
          0,
        );
        ensure(batchCount <= 20, 409, 'Ponad 20 partii nadawców; obsłuż część paczek ręcznie');
        const backlog = (
          await c.query("SELECT count(*)::int n FROM jobs WHERE (state='pending' OR state='running')")
        ).rows[0].n;
        ensure(backlog + batchCount <= 1000, 409, 'Kolejka firmy jest pełna');
        const inserted = (
          await c.query(
            `INSERT INTO dpd_pickup_runs(id,tenant_id,channel_id,version,scheduled_for,state,count,remaining)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING id`,
            [
              id,
              actor.tenantId,
              ch.id,
              cfg.version,
              due,
              rows.length ? 'queued' : 'empty',
              selected.length,
              Math.max(0, rows.length - 2000),
            ],
          )
        ).rowCount;
        if (inserted) {
          const collections = [];
          for (const ids of groups.values())
            for (let start = 0; start < ids.length; start += 200) {
              const p = await previewCollectionTx(c, actor, ch.id, {
                kind: 'pickup',
                client_key: randomUUID(),
                plan_ids: ids.slice(start, start + 200),
                date: scheduledPickupDate(due, definition.business_days),
                from: definition.from,
                to: definition.to,
              });
              await c.query(
                'UPDATE dpd_collections SET schedule_run_id=$2,schedule_version=$3 WHERE id=$1',
                [p.id, id, cfg.version],
              );
              await queueCollectionTx(c, actor, p.id, true);
              collections.push(p.id);
            }
          await c.query('UPDATE dpd_pickup_runs SET collection_ids=$2 WHERE id=$1', [
            id,
            collections,
          ]);
          await audit(c, actor, 'dpd.pickup.schedule.queued', ch.id, {
            run_id: id,
            count: selected.length,
            batches: collections.length,
          });
        }
        await c.query(
          'UPDATE dpd_pickup_schedules SET next_at=$2,error=$3,updated_at=now() WHERE channel_id=$1',
          [
            ch.id,
            next,
            rows.length > 2000
              ? 'Pozostały paczki ponad limit 2000; co najmniej 1 do kolejnego terminu'
              : null,
          ],
        );
        await c.query('RELEASE SAVEPOINT pickup_schedule');
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT pickup_schedule');
        if (!(e instanceof Problem)) throw e;
        await c.query('RELEASE SAVEPOINT pickup_schedule');
        await c.query(
          'UPDATE dpd_pickup_schedules SET next_at=$2,error=$3,updated_at=now() WHERE channel_id=$1',
          [ch.id, next, e.message],
        );
        await audit(c, actor, 'dpd.pickup.schedule.deferred', ch.id, { error: e.message });
      }
    });
}
export function registerDpdPickupScheduleRoutes(app: FastifyInstance) {
  const id = (r: any) => z.object({ id: z.uuid() }).parse(r.params).id;
  app.get('/api/integrations/:id/dpd-pickup-schedule', (r) =>
    tenantTx(r.actor.tenantId, async (c) => {
      const channel = id(r);
      ensure(
        (await c.query("SELECT id FROM channels WHERE id=$1 AND provider='dpd'", [channel]))
          .rowCount,
        404,
        'Nie znaleziono konta DPD',
      );
      const schedule =
        (await c.query('SELECT * FROM dpd_pickup_schedules WHERE channel_id=$1', [channel]))
          .rows[0] ?? null;
      const rows = await eligible(c, channel);
      const runs = (
        await c.query(
          `SELECT x.*,coalesce((SELECT jsonb_agg(jsonb_build_object('id',p.id,'state',p.state,'error',p.error,'remote_id',p.remote_id)) FROM dpd_collections p WHERE p.schedule_run_id=x.id),'[]') collections
      FROM dpd_pickup_runs x WHERE channel_id=$1 ORDER BY created_at DESC,id DESC LIMIT 20`,
          [channel],
        )
      ).rows;
      return { schedule, eligible: rows.length, eligible_capped: rows.length === 2001, runs };
    }),
  );
  app.put('/api/integrations/:id/dpd-pickup-schedule', (r) => {
    ensure(r.actor.role === 'admin', 403, 'Harmonogram konfiguruje administrator');
    const b = pickupScheduleInput.parse(r.body);
    return tenantTx(r.actor.tenantId, async (c) => {
      const ch = await lockAccount(c, r.actor.tenantId, id(r));
      const old = (
        await c.query('SELECT * FROM dpd_pickup_schedules WHERE channel_id=$1 FOR UPDATE', [ch.id])
      ).rows[0];
      ensure((old?.version ?? 0) === b.version, 409, 'Harmonogram zmienił się; odśwież');
      ensure(
        !b.enabled || ch.settings.simulation || b.confirm_external,
        422,
        'Potwierdź automatyczne podjazdy według umowy DPD',
      );
      const { version, enabled, confirm_external, ...definition } = b;
      const hash = dpdConnection(ch);
      const stopped = await stopPending(c, ch.id);
      const next = enabled
        ? (
            await c.query('SELECT automation_next_at($1,now()) value', [
              { kind: 'daily', timezone: 'Europe/Warsaw', time: b.time, weekdays: b.weekdays },
            ])
          ).rows[0].value
        : null;
      const schedule = (
        await c.query(
          `INSERT INTO dpd_pickup_schedules(tenant_id,channel_id,actor_id,enabled,definition,connection_hash,next_at)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(tenant_id,channel_id) DO UPDATE SET actor_id=excluded.actor_id,enabled=excluded.enabled,definition=excluded.definition,connection_hash=excluded.connection_hash,next_at=excluded.next_at,error=NULL,version=dpd_pickup_schedules.version+1,updated_at=now() RETURNING *`,
          [
            r.actor.tenantId,
            ch.id,
            r.actor.userId,
            enabled,
            JSON.stringify(definition),
            hash,
            next,
          ],
        )
      ).rows[0];
      await audit(c, r.actor, 'dpd.pickup.schedule.updated', ch.id, {
        version: schedule.version,
        enabled,
        confirmed: confirm_external,
        stopped,
      });
      return { schedule, stopped };
    });
  });
}
