import {scheduledShopifyDefinition,scheduledCollectionProfileVersion,assertCollectionSourcesMatchProfile} from './competitor-shopify-schedule';
import {collectShopifyCompetitorObservations} from './competitor-shopify-collector';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tenantTx } from './db';
import { ensure, Problem } from './errors';
import { audit, type Actor } from './domain';
import { repricingRows, applyRepricingPrices } from './repricing';
import { historyAfter, historyCursor } from './repricing-rules';
import { channelSummaries, reconcileRepricingChannelDue, recordRunChannelInTx, registerRepricingChannelRoutes } from './repricing-channel';
export const repricingScheduleInput = z
  .object({
    version: z.number().int().min(0),
    enabled: z.boolean(),
    rule_config_version: z.number().int().positive(),
    interval_minutes: z.number().int().min(5).max(10080),
    batch_size: z.number().int().min(1).max(200).default(100),
    confirmed: z.boolean().default(false),
  })
  .strict()
  .refine((b) => !b.enabled || b.confirmed, 'Potwierdź automatyczne zmiany cen w tym cenniku');
export const repricingScheduleRunInput = z
  .object({ version: z.number().int().positive(), client_key: z.uuid() })
  .strict();
export const repricingRunCancelInput = z.object({ confirmed: z.literal(true) }).strict();
async function locks(c: PoolClient, listId: string) {
  await c.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('catalog:'||current_setting('app.tenant_id'),0))");
  const list = (await c.query('SELECT * FROM price_lists WHERE id=$1 FOR UPDATE', [listId]))
    .rows[0];
  ensure(list, 404, 'Nie znaleziono cennika');
  const rule = (
    await c.query('SELECT * FROM repricing_rules WHERE price_list_id=$1 FOR UPDATE', [listId])
  ).rows[0];
  ensure(rule, 404, 'Nie skonfigurowano repricingu');
  const cfg = (
    await c.query('SELECT * FROM repricing_schedules WHERE price_list_id=$1 FOR UPDATE', [listId])
  ).rows[0];
  return { list, rule, cfg };
}
async function cancelActive(c: PoolClient, listId: string, error: string) {
  const rows = (
    await c.query(
      "UPDATE repricing_runs SET state=CASE WHEN changed>0 THEN 'partial' ELSE 'cancelled' END,error=$2,finished_at=now() WHERE price_list_id=$1 AND state='queued' RETURNING job_id",
      [listId, error],
    )
  ).rows;
  await c.query(
    "UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL,error=$2 WHERE id=ANY($1::uuid[])",
    [rows.map((r) => r.job_id), error],
  );
}
// Caller holds price_lists first. Definition edits require fresh administrator authorization;
// input updates may be consumed by the next run without reauthorizing the same definition.
export async function cancelRepricingRunsInTx(c:PoolClient,listId:string,error:string){await cancelActive(c,listId,error);}
export async function invalidateRepricingSchedule(c: PoolClient, listId: string, error: string) {
  await c.query('SELECT price_list_id FROM repricing_schedules WHERE price_list_id=$1 FOR UPDATE', [
    listId,
  ]);
  await cancelActive(c, listId, error);
  await c.query(
    'UPDATE repricing_schedules SET enabled=false,version=version+1,next_at=NULL,error=$2,updated_at=now() WHERE price_list_id=$1 AND enabled',
    [listId, error],
  );
}
async function authorize(c: PoolClient, list: any, rule: any, cfg: any) {
  ensure(cfg?.enabled, 409, 'Harmonogram jest wyłączony');
  ensure(list.active && rule.config.enabled, 409, 'Cennik lub reguła jest nieaktywna');
  ensure(
    rule.config_version === cfg.rule_config_version,
    409,
    'Definicja reguły zmieniła się; zapisz harmonogram ponownie',
  );
  ensure(
    (await c.query('SELECT offer_sync_is_admin($1) ok', [cfg.actor_id])).rows[0].ok,
    403,
    'Autor harmonogramu utracił rolę administratora',
  );
}
async function enqueue(c: PoolClient, a: Actor, list: any, rule: any, cfg: any, key: string) {
  const old = (await c.query('SELECT * FROM repricing_runs WHERE client_key=$1', [key])).rows[0];
  if (old) {
    ensure(
      old.price_list_id === list.id && old.schedule_version === cfg.version,
      409,
      'Klucz przebiegu dotyczy innego harmonogramu',
    );
    return { ...old, replayed: true };
  }
  await authorize(c, list, rule, cfg);
  ensure(
    !(
      await c.query("SELECT 1 FROM repricing_runs WHERE price_list_id=$1 AND state='queued'", [
        list.id,
      ])
    ).rowCount,
    409,
    'Przebieg repricingu już trwa',
  );
  ensure(
    (await c.query("SELECT count(*)::int n FROM jobs WHERE (state='pending' OR state='running')")).rows[0]
      .n < 1000,
    409,
    'Kolejka firmy jest pełna',
  );
  const range = (
      await c.query(
        'SELECT count(*)::int total,max(product_id::text)::uuid upper_id FROM repricing_inputs WHERE price_list_id=$1',
        [list.id],
      )
    ).rows[0],
    id = randomUUID(),
    job = randomUUID();
  const collection=scheduledShopifyDefinition(rule.config);
  let collectionProfileVersion:number|undefined;
  if(collection){const profile=(await c.query('SELECT * FROM competitor_observation_profiles WHERE price_list_id=$1',[list.id])).rows[0];
    ensure(profile,409,'Brak profilu konkurencji');assertCollectionSourcesMatchProfile(collection,profile,list.currency);
    collectionProfileVersion=profile.version;
  }
  await c.query(
    "INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key) VALUES($1,$2,'pricing.reprice',$3,$4)",
    [job, a.tenantId, JSON.stringify({ run_id: id, ...(collection?{collection_profile_version:collectionProfileVersion}:{}) }), 'pricing.reprice:' + id],
  );
  const run = (
    await c.query(
      'INSERT INTO repricing_runs(id,tenant_id,price_list_id,actor_id,client_key,job_id,schedule_version,rule_version,initial_list_version,expected_list_version,batch_size,upper_id,total) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11,$12) RETURNING *',
      [
        id,
        a.tenantId,
        list.id,
        cfg.actor_id,
        key,
        job,
        cfg.version,
        rule.version,
        list.version,
        cfg.batch_size,
        range.upper_id,
        range.total,
      ],
    )
  ).rows[0];
  await c.query(
    'UPDATE repricing_schedules SET last_run_id=$2,next_at=NULL,error=NULL,updated_at=now() WHERE price_list_id=$1',
    [list.id, id],
  );
  await audit(c, a, 'repricing.schedule.queue', id, {
    price_list_id: list.id,
    total: range.total,
    schedule_version: cfg.version,
  });
  return run;
}
async function frame(c: PoolClient, job: any) {
  const peek = (
    await c.query('SELECT price_list_id FROM repricing_runs WHERE id=$1', [job.payload.run_id])
  ).rows[0];
  if (!peek) return null;
  const base = await locks(c, peek.price_list_id);
  const run = (
    await c.query('SELECT * FROM repricing_runs WHERE id=$1 FOR UPDATE', [job.payload.run_id])
  ).rows[0];
  if (
    run.state !== 'queued' ||
    !(
      await c.query(
        "SELECT id FROM jobs WHERE id=$1 AND state='running' AND lease_token=$2 FOR UPDATE",
        [job.id, job.lease_token],
      )
    ).rowCount
  )
    return null;
  ensure(run.job_id === job.id, 409, 'Zadanie nie dotyczy tego przebiegu');
  return { ...base, run };
}
async function finish(c: PoolClient, run: any, state: string, error: string | null) {
  const row = (
    await c.query(
      'UPDATE repricing_runs SET state=$2,error=$3,finished_at=now() WHERE id=$1 RETURNING *',
      [run.id, state === 'failed' && run.changed > 0 ? 'partial' : state, error],
    )
  ).rows[0];
  await c.query('UPDATE jobs SET state=$2,lease_token=NULL,locked_at=NULL,error=$3 WHERE id=$1', [
    run.job_id,
    state === 'success' ? 'done' : 'failed',
    error,
  ]);
  await c.query(
    'UPDATE repricing_schedules SET next_at=now()+make_interval(mins=>interval_minutes),error=$3,updated_at=now() WHERE price_list_id=$1 AND enabled AND version=$2 AND last_run_id=$4',
    [run.price_list_id, run.schedule_version, error, run.id],
  );
  await audit(
    c,
    { tenantId: run.tenant_id, userId: run.actor_id, role: 'admin' },
    'repricing.schedule.finished',
    run.id,
    { state: row.state, scanned: row.scanned, changed: row.changed, blocked: row.blocked, error },
  );
}
export async function processRepricing(job: any) {
  await tenantTx(job.tenant_id, async (c) => {
    const f = await frame(c, job);
    if (!f) return;
    const { list, rule, cfg, run } = f;
    await authorize(c, list, rule, cfg);
    ensure(
      cfg.version === run.schedule_version && cfg.actor_id === run.actor_id,
      409,
      'Harmonogram został zmieniony',
    );
    ensure(
      rule.version === run.rule_version,
      409,
      'Dane wejściowe repricingu zmieniły się; następny przebieg użyje nowych danych',
    );
    ensure(
      list.version === run.expected_list_version,
      409,
      'Cennik zmienił się pomiędzy partiami; przebieg zatrzymany',
    );
    const collection=scheduledShopifyDefinition(rule.config);
    if(collection&&run.scanned===0){
      const {enlistCompetitorCollectionWorkerInTx,importScheduledCompetitorObservationsInTx}=await import('./competitor-observations');
      await enlistCompetitorCollectionWorkerInTx(c,job,list.id); // native current author + exact job lease before provider GET
      const profile=(await c.query('SELECT * FROM competitor_observation_profiles WHERE price_list_id=$1 FOR UPDATE',[list.id])).rows[0];
      ensure(profile&&profile.version===scheduledCollectionProfileVersion(job.payload),409,'Profil konkurencji zmienił się');
      assertCollectionSourcesMatchProfile(collection,profile,list.currency);
      const collected=await collectShopifyCompetitorObservations(collection.sources);
      const imported=await importScheduledCompetitorObservationsInTx(c,job,list.id,{client_key:run.id,profile_version:profile.version,
        observations:collected.observations,local_observations_confirmed:true});
      if(collection.mode==='collection_only'){await finish(c,run,'success',null);return;}
      // The SAME committed observation transition supplies the new rule version.
      // This never accepts unrelated input drift or caller-supplied fast-forward.
      const advanced=(await c.query("UPDATE repricing_runs SET rule_version=$2 WHERE id=$1 AND rule_version=$3 AND state='queued' RETURNING rule_version",[run.id,imported.rule_version,run.rule_version])).rows[0];
      ensure(advanced,409,'Przebieg zmienił się podczas kolekcji');
      run.rule_version=advanced.rule_version;rule.version=advanced.rule_version;
    }
    const page = (
      await c.query(
        'SELECT product_id FROM repricing_inputs WHERE price_list_id=$1 AND ($2::uuid IS NULL OR product_id>$2) AND product_id<=$3 ORDER BY product_id LIMIT $4',
        [list.id, run.cursor, run.upper_id, run.batch_size + 1],
      )
    ).rows;
    const ids = page.slice(0, run.batch_size).map((i) => i.product_id);
    if (!ids.length) {
      await finish(c, run, 'success', null);
      return;
    }
    if (rule.config.strategy === 'competitor_rank') {
      const { enlistCompetitorRankingWorkerInTx } = await import('./competitor-observations');
      await enlistCompetitorRankingWorkerInTx(c, job.tenant_id, run.actor_id);
    }
    const rows = await repricingRows(c, job.tenant_id, list, rule, ids),
      blocked = rows.filter((i) => i.state === 'blocked').length;
    const change = blocked
      ? { changed: 0, version: list.version }
      : await applyRepricingPrices(c, job.tenant_id, list, rows);
    const preview = randomUUID();
    await c.query(
      "INSERT INTO repricing_previews(id,tenant_id,price_list_id,client_key,product_ids,rule_version,list_version,currency,result,state,applied_at,applied_list_version,schedule_run_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,CASE WHEN $10='applied' THEN now() ELSE NULL END,$11,$12)",
      [
        preview,
        job.tenant_id,
        list.id,
        randomUUID(),
        ids,
        rule.version,
        list.version,
        list.currency,
        JSON.stringify(rows),
        blocked ? 'preview' : 'applied',
        blocked ? null : change.version,
        run.id,
      ],
    );
    const updated = (
      await c.query(
        'UPDATE repricing_runs SET cursor=$2,scanned=scanned+$3,changed=changed+$4,unchanged=unchanged+$5,blocked=blocked+$6,skipped=skipped+$8,expected_list_version=$7 WHERE id=$1 RETURNING *',
        [
          run.id,
          ids.at(-1),
          ids.length,
          change.changed,
          blocked ? 0 : rows.filter((i) => i.state === 'unchanged').length,
          blocked,
          change.version,
          // REPRICE-004: manually excluded SKUs are skipped, not unchanged.
          blocked ? rows.length - blocked : rows.filter((i) => i.state === 'override').length,
        ],
      )
    ).rows[0];
    // REPRICE-005: the written prices await their channel result (same transaction as the write).
    const channelRows = blocked ? 0 : await recordRunChannelInTx(c, job.tenant_id, run.id, preview, list, rows);
    await audit(
      c,
      { tenantId: job.tenant_id, userId: run.actor_id, role: 'admin' },
      'repricing.schedule.batch',
      run.id,
      {
        preview_id: preview,
        count: ids.length,
        changed: change.changed,
        blocked,
        list_version: change.version,
        channel_rows: channelRows,
      },
    );
    if (blocked) {
      await finish(
        c,
        updated,
        'failed',
        'Partia zawiera zablokowane SKU; ceny tej partii nie zostały zmienione',
      );
      return;
    }
    if (page.length <= run.batch_size) {
      await finish(c, updated, 'success', null);
      return;
    }
    await c.query(
      "UPDATE jobs SET state='pending',attempts=0,lease_token=NULL,locked_at=NULL,run_at=now(),error=NULL WHERE id=$1",
      [job.id],
    );
  });
}
export async function failRepricing(job: any, error: unknown) {
  await tenantTx(job.tenant_id, async (c) => {
    const f = await frame(c, job);
    if (!f) return;
    const { run, list, rule, cfg } = f;
    if (error instanceof Problem) {
      await finish(c, run, 'failed', error.message);
      if (
        error.status === 403 ||
        !list.active ||
        !rule.config.enabled ||
        rule.config_version !== cfg?.rule_config_version
      )
        await invalidateRepricingSchedule(c, list.id, error.message);
    } else if (job.attempts >= job.max_attempts)
      await finish(c, run, 'failed', 'Błąd przetwarzania repricingu po ostatniej próbie');
    else
      await c.query(
        "UPDATE jobs SET state='pending',lease_token=NULL,locked_at=NULL,error='Błąd przetwarzania repricingu',run_at=now()+make_interval(secs=>least(300,power(2,attempts)::int)) WHERE id=$1",
        [job.id],
      );
  });
}
export async function scheduleRepricingDue() {
  // Lease recovery is reconciled outside tick's job-lock transaction to keep lock order consistent.
  await pool.query(
    "UPDATE repricing_runs r SET state=CASE WHEN r.changed>0 THEN 'partial' ELSE 'failed' END,error='Dzierżawa zadania repricingu wygasła',finished_at=now() FROM jobs j WHERE (r.tenant_id,r.job_id)=(j.tenant_id,j.id) AND r.state='queued' AND j.state='failed'",
  );
  await pool.query(
    "UPDATE repricing_schedules s SET next_at=r.finished_at+make_interval(mins=>s.interval_minutes),error=r.error,updated_at=now() FROM repricing_runs r WHERE (s.tenant_id,s.last_run_id)=(r.tenant_id,r.id) AND s.enabled AND s.version=r.schedule_version AND s.next_at IS NULL AND r.state<>'queued'",
  );
  const due = (
    await pool.query(
      "SELECT tenant_id,price_list_id FROM repricing_schedules s WHERE enabled AND next_at<=now() AND NOT EXISTS(SELECT 1 FROM repricing_runs r WHERE (r.tenant_id,r.price_list_id)=(s.tenant_id,s.price_list_id) AND r.state='queued') ORDER BY next_at,price_list_id LIMIT 20",
    )
  ).rows;
  for (const row of due)
    await tenantTx(row.tenant_id, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [`catalog:${row.tenant_id}`]);
      if (
        !(
        await c.query('SELECT id FROM price_lists WHERE id=$1 FOR UPDATE SKIP LOCKED', [
            row.price_list_id,
          ])
        ).rowCount
      )
        return;
      const { list, rule, cfg } = await locks(c, row.price_list_id);
      if (
        !cfg?.enabled ||
        !cfg.next_at ||
        new Date(cfg.next_at).getTime() > Date.now() ||
        (
          await c.query("SELECT 1 FROM repricing_runs WHERE price_list_id=$1 AND state='queued'", [
            list.id,
          ])
        ).rowCount
      )
        return;
      const a: Actor = { tenantId: row.tenant_id, userId: cfg.actor_id, role: 'admin' };
      try {
        await c.query('SAVEPOINT reprice_enqueue');
        await enqueue(c, a, list, rule, cfg, randomUUID());
        await c.query('RELEASE SAVEPOINT reprice_enqueue');
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT reprice_enqueue');
        await c.query('RELEASE SAVEPOINT reprice_enqueue');
        if (!(e instanceof Problem)) throw e;
        if (e.message === 'Kolejka firmy jest pełna')
          await c.query(
            "UPDATE repricing_schedules SET next_at=now()+interval '1 minute',error=$2,updated_at=now() WHERE price_list_id=$1",
            [list.id, e.message],
          );
        else await invalidateRepricingSchedule(c, list.id, e.message);
        await audit(c, a, 'repricing.schedule.deferred', list.id, { error: e.message });
      }
    });
  // REPRICE-005: link written prices with their offer-sync plans after the scheduling work (no-op without
  // migration 247); a failing tenant is reported to the worker supervisor without stopping the others.
  await reconcileRepricingChannelDue();
}
export function registerRepricingScheduleRoutes(app: FastifyInstance) {
  registerRepricingChannelRoutes(app);
  const id = (p: unknown) => z.object({ id: z.uuid() }).parse(p).id;
  const admin = (r: any) => ensure(r.actor.role === 'admin', 403, 'Wymagana rola administratora');
  const page = z.object({
    after: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  });
  const runsQuery = z.object({
    after: z.string().max(100).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    state: z.enum(['queued', 'success', 'failed', 'partial', 'cancelled']).optional(),
  });
  app.get('/api/price-lists/:id/repricing/schedule', (r) =>
    tenantTx(r.actor.tenantId, async (c) => {
      ensure(
        (await c.query('SELECT 1 FROM price_lists WHERE id=$1', [id(r.params)])).rowCount,
        404,
        'Nie znaleziono cennika',
      );
      const cfg =
        (
          await c.query(
            'SELECT s.*,r.state last_state,r.scanned last_scanned,r.changed last_changed,r.blocked last_blocked FROM repricing_schedules s LEFT JOIN repricing_runs r ON(s.tenant_id,s.last_run_id)=(r.tenant_id,r.id) WHERE s.price_list_id=$1',
            [id(r.params)],
          )
        ).rows[0] ?? null;
      const rule=(await c.query('SELECT config FROM repricing_rules WHERE price_list_id=$1',[id(r.params)])).rows[0];
      return { schedule: cfg,purpose:rule?(scheduledShopifyDefinition(rule.config)?.mode??'repricing'):'repricing' };
    }),
  );
  app.put('/api/price-lists/:id/repricing/schedule', (r) => {
    admin(r);
    const b = repricingScheduleInput.parse(r.body);
    return tenantTx(r.actor.tenantId, async (c) => {
      const { list, rule, cfg } = await locks(c, id(r.params));
      ensure((cfg?.version ?? 0) === b.version, 409, 'Harmonogram zmienił się; odśwież dane');
      ensure(
        !b.enabled ||
          (list.active && rule.config.enabled && rule.config_version === b.rule_config_version),
        409,
        'Cennik lub definicja reguły zmieniły się; odśwież dane',
      );
      await cancelActive(
        c,
        list.id,
        'Harmonogram wyłączono lub zmieniono; wcześniejsze partie pozostają zastosowane',
      );
      const next = (
        await c.query(
          'INSERT INTO repricing_schedules(tenant_id,price_list_id,actor_id,enabled,rule_config_version,interval_minutes,batch_size,next_at) VALUES($1,$2,$3,$4,$5,$6,$7,CASE WHEN $4 THEN now()+make_interval(mins=>$6) ELSE NULL END) ON CONFLICT(tenant_id,price_list_id) DO UPDATE SET actor_id=excluded.actor_id,enabled=excluded.enabled,rule_config_version=excluded.rule_config_version,interval_minutes=excluded.interval_minutes,batch_size=excluded.batch_size,next_at=excluded.next_at,version=repricing_schedules.version+1,error=NULL,updated_at=now() RETURNING *',
          [
            r.actor.tenantId,
            list.id,
            r.actor.userId,
            b.enabled,
            b.rule_config_version,
            b.interval_minutes,
            b.batch_size,
          ],
        )
      ).rows[0];
      await audit(c, r.actor, 'repricing.schedule.configure', list.id, {
        version: next.version,
        enabled: next.enabled,
        rule_config_version: next.rule_config_version,
        interval_minutes: next.interval_minutes,
        batch_size: next.batch_size,
      });
      return { schedule: next };
    });
  });
  app.post('/api/price-lists/:id/repricing/schedule/run', (r) => {
    admin(r);
    const b = repricingScheduleRunInput.parse(r.body);
    return tenantTx(r.actor.tenantId, async (c) => {
      const { list, rule, cfg } = await locks(c, id(r.params));
      ensure(cfg?.version === b.version, 409, 'Harmonogram zmienił się; odśwież dane');
      return enqueue(c, r.actor, list, rule, cfg, b.client_key);
    });
  });
  app.get('/api/price-lists/:id/repricing/runs', (r) =>
    tenantTx(r.actor.tenantId, async (c) => {
      const listId = id(r.params),
        q = runsQuery.parse(r.query),
        after = historyAfter(q.after);
      ensure(
        (await c.query('SELECT 1 FROM price_lists WHERE id=$1', [listId])).rowCount,
        404,
        'Nie znaleziono cennika',
      );
      // Newest first (REPRICE-006); the cursor carries created_at in microseconds and id.
      const rows = (
        await c.query(
          `SELECT *,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at FROM repricing_runs
           WHERE price_list_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid)) AND ($4::text IS NULL OR state=$4::text)
           ORDER BY created_at DESC,id DESC LIMIT $5`,
          [listId, after.at, after.id, q.state ?? null, q.limit + 1],
        )
      ).rows;
      const last = rows.length > q.limit ? rows[q.limit - 1] : null;
      const shown = rows.slice(0, q.limit).map(({ cursor_at, ...row }) => row);
      const channel = await channelSummaries(c, 'run_id', shown.map((r) => r.id));
      return {
        data: shown.map((r) => ({ ...r, channel: channel.get(r.id) ?? null })),
        meta: { cursor: last ? historyCursor(last.cursor_at, last.id) : null },
      };
    }),
  );
  app.get('/api/repricing-runs/:id', (r) =>
    tenantTx(r.actor.tenantId, async (c) => {
      const run = (await c.query('SELECT * FROM repricing_runs WHERE id=$1', [id(r.params)]))
        .rows[0];
      ensure(run, 404, 'Nie znaleziono przebiegu');
      const q = page.parse(r.query);
      const rows = (
        await c.query(
          'SELECT id,state,list_version,applied_list_version,created_at,result FROM repricing_previews WHERE schedule_run_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3',
          [run.id, q.after ?? null, q.limit + 1],
        )
      ).rows;
      return {
        run,
        data: rows.slice(0, q.limit),
        meta: { cursor: rows.length > q.limit ? rows[q.limit - 1].id : null },
      };
    }),
  );
  app.post('/api/repricing-runs/:id/cancel', (r) => {
    admin(r);
    repricingRunCancelInput.parse(r.body);
    return tenantTx(r.actor.tenantId, async (c) => {
      const peek = (
        await c.query('SELECT price_list_id FROM repricing_runs WHERE id=$1', [id(r.params)])
      ).rows[0];
      ensure(peek, 404, 'Nie znaleziono przebiegu');
      const { list, cfg } = await locks(c, peek.price_list_id);
      const run = (
        await c.query('SELECT * FROM repricing_runs WHERE id=$1 FOR UPDATE', [id(r.params)])
      ).rows[0];
      if (run.state === 'queued') {
        await cancelActive(
          c,
          list.id,
          'Przebieg anulowano; wcześniejsze partie pozostają zastosowane',
        );
        await c.query(
          'UPDATE repricing_schedules SET next_at=CASE WHEN enabled THEN now()+make_interval(mins=>interval_minutes) ELSE NULL END,error=$2,updated_at=now() WHERE price_list_id=$1 AND version=$3',
          [list.id, 'Przebieg anulowano', cfg.version],
        );
        await audit(c, r.actor, 'repricing.schedule.cancel', run.id, { changed: run.changed });
      }
      return (await c.query('SELECT * FROM repricing_runs WHERE id=$1', [run.id])).rows[0];
    });
  });
}
