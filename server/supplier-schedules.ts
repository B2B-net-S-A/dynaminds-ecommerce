import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { pool, tenantTx } from './db';
import { ensure, Problem } from './errors';
import { audit, type Actor } from './domain';
import { bigbuyId } from './bigbuy';
import { supplierSource, supplierSourceConnection, supplierConnection } from './supplier-catalog';
import { startSupplierBulk } from './supplier-bulk';
export const supplierScheduleInput = z
  .object({
    version: z.number().int().min(0),
    enabled: z.boolean(),
    interval_minutes: z.number().int().min(30).max(10080),
    page_size: z.number().int().min(1).max(10000),
    taxonomy: bigbuyId.nullable().default(null),
  })
  .strict();
export const supplierScheduleRunInput = z
  .object({ version: z.number().int().positive(), client_key: z.uuid() })
  .strict();
async function cancelScheduled(c: PoolClient, sourceId: string) {
  const runs = (
    await c.query(
      "UPDATE supplier_bulk_runs SET state='cancelled',error='Harmonogram wyłączono lub zmieniono',finished_at=now(),version=version+1 WHERE source_id=$1 AND schedule_version IS NOT NULL AND state='queued' RETURNING job_id",
      [sourceId],
    )
  ).rows;
  await c.query(
    "UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL,error='Harmonogram wyłączono lub zmieniono' WHERE id=ANY($1::uuid[])",
    [runs.map((r) => r.job_id)],
  );
}
async function enqueue(c: PoolClient, a: Actor, cfg: any, clientKey: string) {
  ensure(cfg.enabled, 409, 'Harmonogram jest wyłączony');
  const s = await supplierSource(c, cfg.source_id, true),
    ch = await supplierSourceConnection(c, s);
  ensure(
    supplierConnection(s, ch) === cfg.connection_hash,
    409,
    'Połączenie hurtowni zmieniło się; zapisz ponownie harmonogram',
  );
  ensure(
    (await c.query('SELECT offer_sync_is_admin($1) ok', [cfg.actor_id])).rows[0].ok,
    403,
    'Autor harmonogramu utracił rolę administratora',
  );
  ensure(
    (await c.query("SELECT count(*)::int n FROM jobs WHERE (state='pending' OR state='running')")).rows[0]
      .n < 1000,
    409,
    'Kolejka firmy jest pełna',
  );
  const run = await startSupplierBulk(c, { ...a, userId: cfg.actor_id }, cfg.source_id, {
    client_key: clientKey,
    page_size: cfg.page_size,
    ...(cfg.taxonomy ? { taxonomy: cfg.taxonomy } : {}),
  });
  // The source lock prevents execution or configuration changes until this transaction commits.
  if (!run.replayed) {
    await c.query('UPDATE supplier_bulk_runs SET schedule_version=$2 WHERE id=$1', [
      run.id,
      cfg.version,
    ]);
    await c.query(
      'UPDATE supplier_schedules SET last_bulk_id=$2,last_finished_at=NULL,error=NULL,next_at=now()+make_interval(mins=>interval_minutes),updated_at=now() WHERE source_id=$1',
      [cfg.source_id, run.id],
    );
  } else {
    ensure(
      (await c.query('SELECT schedule_version FROM supplier_bulk_runs WHERE id=$1', [run.id]))
        .rows[0].schedule_version === cfg.version,
      409,
      'Klucz ponowienia dotyczy innego wykonania',
    );
  }
  await audit(c, a, 'supplier.schedule.queue', cfg.source_id, {
    bulk_id: run.id,
    schedule_version: cfg.version,
    replayed: !!run.replayed,
  });
  return run;
}
export async function scheduleSuppliersDue() {
  // Reconcile terminal runs, including expired leases. Only the current definition controls its next run.
  await pool.query(`UPDATE supplier_schedules s SET last_finished_at=r.finished_at,next_at=r.finished_at+make_interval(mins=>s.interval_minutes),
 error=CASE WHEN r.state='success' AND r.rejected=0 THEN NULL WHEN r.state='success' THEN 'Odczyt zakończony z odrzuconymi pozycjami: '||r.rejected::text ELSE coalesce(r.error,'Odczyt przerwany') END,updated_at=now()
 FROM supplier_bulk_runs r WHERE s.enabled AND (s.tenant_id,s.last_bulk_id)=(r.tenant_id,r.id) AND s.version=r.schedule_version AND r.state<>'queued' AND r.finished_at IS NOT NULL AND s.last_finished_at IS DISTINCT FROM r.finished_at`);
  const candidates = (
    await pool.query(
      `SELECT s.tenant_id,s.source_id FROM supplier_schedules s WHERE s.enabled AND s.next_at<=now() AND NOT EXISTS(SELECT 1 FROM supplier_bulk_runs r WHERE (r.tenant_id,r.source_id)=(s.tenant_id,s.source_id) AND r.state='queued') ORDER BY s.next_at,s.source_id LIMIT 20`,
    )
  ).rows;
  for (const candidate of candidates)
    await tenantTx(candidate.tenant_id, async (c) => {
      const s = (
        await c.query('SELECT * FROM supplier_sources WHERE id=$1 FOR UPDATE SKIP LOCKED', [
          candidate.source_id,
        ])
      ).rows[0];
      if (!s) return;
      const cfg = (
        await c.query(
          'SELECT * FROM supplier_schedules WHERE source_id=$1 AND enabled AND next_at<=now() FOR UPDATE',
          [s.id],
        )
      ).rows[0];
      if (
        !cfg ||
        (
          await c.query("SELECT 1 FROM supplier_bulk_runs WHERE source_id=$1 AND state='queued'", [
            s.id,
          ])
        ).rowCount
      )
        return;
      const a: Actor = { tenantId: candidate.tenant_id, userId: cfg.actor_id, role: 'admin' };
      try {
        await c.query('SAVEPOINT supplier_enqueue');
        await enqueue(c, a, cfg, randomUUID());
        await c.query('RELEASE SAVEPOINT supplier_enqueue');
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT supplier_enqueue');
        await c.query('RELEASE SAVEPOINT supplier_enqueue');
        if (!(e instanceof Problem)) throw e;
        const terminal = !(e.status === 409 && e.message === 'Kolejka firmy jest pełna');
        await c.query(
          "UPDATE supplier_schedules SET enabled=CASE WHEN $2 THEN false ELSE enabled END,next_at=CASE WHEN $2 THEN NULL ELSE now()+interval '1 minute' END,error=$3,version=version+CASE WHEN $2 THEN 1 ELSE 0 END,updated_at=now() WHERE source_id=$1",
          [s.id, terminal, e.message],
        );
        await audit(
          c,
          a,
          terminal ? 'supplier.schedule.suspended' : 'supplier.schedule.deferred',
          s.id,
          { error: e.message },
        );
      }
    });
}
export function registerSupplierScheduleRoutes(app: FastifyInstance) {
  const id = (r: any) => z.object({ id: z.uuid() }).parse(r.params).id;
  app.get('/api/supplier-sources/:id/schedule', (r) =>
    tenantTx(r.actor.tenantId, async (c) => {
      await supplierSource(c, id(r));
      const cfg =
        (
          await c.query(
            `SELECT s.*,r.state last_state,r.published last_published,r.rejected last_rejected,r.error last_error FROM supplier_schedules s LEFT JOIN supplier_bulk_runs r ON(s.tenant_id,s.last_bulk_id)=(r.tenant_id,r.id) WHERE s.source_id=$1`,
            [id(r)],
          )
        ).rows[0] ?? null;
      return { schedule: cfg };
    }),
  );
  app.put('/api/supplier-sources/:id/schedule', (r) => {
    ensure(r.actor.role === 'admin', 403, 'Wymagana rola administratora');
    const b = supplierScheduleInput.parse(r.body);
    return tenantTx(r.actor.tenantId, async (c) => {
      const s = await supplierSource(c, id(r), true),
        old = (
          await c.query('SELECT * FROM supplier_schedules WHERE source_id=$1 FOR UPDATE', [s.id])
        ).rows[0];
      ensure((old?.version ?? 0) === b.version, 409, 'Harmonogram zmienił się; odśwież dane');
      ensure(
        s.kind !== 'file',
        422,
        'Harmonogram pobierania źródła plikowego nie jest jeszcze dostępny',
      );
      let connectionHash = old?.connection_hash ?? '';
      if (b.enabled) connectionHash = supplierConnection(s, await supplierSourceConnection(c, s));
      await cancelScheduled(c, s.id);
      const cfg = (
        await c.query(
          `INSERT INTO supplier_schedules(tenant_id,source_id,actor_id,enabled,interval_minutes,page_size,taxonomy,connection_hash,next_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $4 THEN now()+make_interval(mins=>$5) ELSE NULL END)
   ON CONFLICT(tenant_id,source_id) DO UPDATE SET actor_id=excluded.actor_id,enabled=excluded.enabled,interval_minutes=excluded.interval_minutes,page_size=excluded.page_size,taxonomy=excluded.taxonomy,connection_hash=excluded.connection_hash,next_at=excluded.next_at,version=supplier_schedules.version+1,last_finished_at=NULL,error=NULL,updated_at=now() RETURNING *`,
          [
            r.actor.tenantId,
            s.id,
            r.actor.userId,
            b.enabled,
            b.interval_minutes,
            b.page_size,
            b.taxonomy,
            connectionHash,
          ],
        )
      ).rows[0];
      await audit(c, r.actor, 'supplier.schedule.updated', s.id, {
        version: cfg.version,
        enabled: cfg.enabled,
        interval_minutes: cfg.interval_minutes,
        page_size: cfg.page_size,
        taxonomy: cfg.taxonomy,
      });
      return { schedule: cfg };
    });
  });
  app.post('/api/supplier-sources/:id/schedule/run', (r) => {
    ensure(r.actor.role === 'admin', 403, 'Wymagana rola administratora');
    const b = supplierScheduleRunInput.parse(r.body);
    return tenantTx(r.actor.tenantId, async (c) => {
      const s = await supplierSource(c, id(r), true),
        cfg = (
          await c.query('SELECT * FROM supplier_schedules WHERE source_id=$1 FOR UPDATE', [s.id])
        ).rows[0];
      ensure(cfg && cfg.version === b.version, 409, 'Harmonogram zmienił się; odśwież dane');
      return enqueue(c, r.actor, cfg, b.client_key);
    });
  });
}
