import { automationOnlyEvent } from './automation-v2-triggers';
import { shipmentStatusOf } from '../shared/shipment-status';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool, tenantTx } from './db';
import { audit, transition, type Actor } from './domain';
import { ensure, Problem } from './errors';
import { loadChannel, type IntegrationContext } from './channel-access';
import { InPost, safeFetch } from './integrations';
import { trackingConnection, trackingReady, trackingSupported } from './tracking-connection';
import { DpdInfo } from './dpd-info';
import { Dhl } from './carrier-dhl';
import { PocztaPolskaTracking } from './carrier-pocztapolska-tracking';
import { decrypt } from './security';
import { fenceSync } from './offer-sync';
import { systemActor } from './sync';
export const TRACKING_BATCH = 50;
export const TRACKING_BACKLOG = 200;
export const trackingTerminal = ['delivered', 'returned_to_sender', 'canceled'];
export const trackingEligible = `s.dispatched_at IS NOT NULL AND s.channel_id IS NOT NULL
 AND coalesce(s.tracking_data->>'status','') NOT IN ('delivered','returned_to_sender','canceled')
 AND least(s.created_at,coalesce(s.tracking_provider_created_at,s.created_at))>now()-interval '45 days'`;
const errorMessage = (e: unknown) => (e instanceof Problem ? e.message : 'Błąd odczytu trackingu');
async function completeTracking(c: PoolClient, job: any, result: any) {
  if (!job) return;
  await c.query(
    "UPDATE jobs SET state='done',error=NULL,payload=jsonb_set(payload,'{result}',$3),lease_token=NULL,locked_at=NULL WHERE id=$1 AND lease_token=$2",
    [
      job.id,
      job.lease_token,
      JSON.stringify({
        status: result.status,
        scope: result.scope,
        applied: result.applied,
        reason: result.reason,
      }),
    ],
  );
}
async function policy(c: PoolClient, job: any, renew = false) {
  const cfg = (
    await c.query('SELECT * FROM tracking_configs WHERE channel_id=$1 FOR SHARE', [
      job.payload.channel_id,
    ])
  ).rows[0];
  const ch = (
    await c.query('SELECT provider,mode,settings,credentials FROM channels WHERE id=$1', [
      job.payload.channel_id,
    ])
  ).rows[0];
  const admin = (await c.query('SELECT offer_sync_is_admin($1) AS ok', [job.payload.actor_id]))
    .rows[0]?.ok;
  ensure(
    cfg?.enabled &&
      cfg.version === job.payload.version &&
      cfg.actor_id === job.payload.actor_id &&
      admin &&
      trackingSupported(ch) &&
      trackingReady(ch) &&
      (ch.settings.simulation || cfg.external_authorized) &&
      trackingConnection(ch) === cfg.connection_hash,
    409,
    'Harmonogram trackingu wyłączono lub zmieniono; zatwierdź go ponownie',
  );
  ensure(await fenceSync(c, job, renew), 409, 'Dzierżawa trackingu wygasła');
  return cfg;
}
async function guarded(job: any, renew = false) {
  return tenantTx(job.tenant_id, (c) => policy(c, job, renew));
}
export async function enqueueTracking(
  c: PoolClient,
  actor: Actor,
  channelId: string,
  force = false,
) {
  const cfg = (
    await c.query('SELECT * FROM tracking_configs WHERE channel_id=$1 FOR UPDATE', [channelId])
  ).rows[0];
  ensure(cfg?.enabled, 409, 'Najpierw włącz automatyczny tracking');
  const ch = (
    await c.query('SELECT provider,mode,settings,credentials FROM channels WHERE id=$1', [
      channelId,
    ])
  ).rows[0];
  ensure(
    cfg.actor_id === actor.userId &&
      (await c.query('SELECT offer_sync_is_admin($1) AS ok', [actor.userId])).rows[0]?.ok &&
      trackingSupported(ch) &&
      trackingConnection(ch) === cfg.connection_hash &&
      trackingReady(ch) &&
      (ch.settings.simulation || cfg.external_authorized),
    409,
    'Konfiguracja trackingu wymaga ponownego zatwierdzenia',
  );
  const pending = (
    await c.query(
      "SELECT count(*)::int AS n FROM jobs WHERE kind='shipping.tracking' AND state IN ('pending','running') AND payload->>'channel_id'=$1",
      [channelId],
    )
  ).rows[0].n;
  const slots = Math.max(0, Math.min(TRACKING_BATCH, TRACKING_BACKLOG - pending));
  const rows = (
    await c.query(
      `SELECT s.id FROM shipments s WHERE s.channel_id=$1 AND ${trackingEligible}
    AND ($2 OR s.tracking_next_at IS NULL OR s.tracking_next_at<=now())
    AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.kind='shipping.tracking' AND j.state IN ('pending','running') AND j.payload->>'shipment_id'=s.id::text)
    ORDER BY s.tracking_next_at NULLS FIRST,s.id LIMIT $3 FOR UPDATE OF s SKIP LOCKED`,
      [channelId, force, slots],
    )
  ).rows;
  for (const row of rows) {
    const id = randomUUID();
    await c.query(
      "INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key,priority) VALUES($1,$2,'shipping.tracking',$3,$4,80)",
      [
        id,
        actor.tenantId,
        JSON.stringify({
          shipment_id: row.id,
          channel_id: channelId,
          actor_id: actor.userId,
          version: cfg.version,
        }),
        'shipping.tracking:' + id,
      ],
    );
    await c.query(
      'UPDATE shipments SET tracking_job_id=$2,tracking_next_at=now()+make_interval(secs=>$3),tracking_error=NULL WHERE id=$1',
      [row.id, id, cfg.interval_seconds],
    );
  }
  return { queued: rows.length, batch_limit: TRACKING_BATCH, pending_limit: TRACKING_BACKLOG };
}
export async function scheduleTrackingDue() {
  const due = (
    await pool.query(`SELECT DISTINCT cfg.tenant_id,cfg.channel_id,cfg.actor_id,cfg.version FROM tracking_configs cfg
    JOIN shipments s ON (s.tenant_id,s.channel_id)=(cfg.tenant_id,cfg.channel_id) WHERE cfg.enabled AND ${trackingEligible}
    AND (s.tracking_next_at IS NULL OR s.tracking_next_at<=now())
    AND (SELECT count(*) FROM jobs j WHERE j.tenant_id=cfg.tenant_id AND j.kind='shipping.tracking' AND j.state IN ('pending','running') AND j.payload->>'channel_id'=cfg.channel_id::text)<${TRACKING_BACKLOG}
    AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.tenant_id=s.tenant_id AND j.kind='shipping.tracking' AND j.state IN ('pending','running') AND j.payload->>'shipment_id'=s.id::text)
    ORDER BY cfg.channel_id LIMIT 20`)
  ).rows;
  for (const row of due) {
    try {
      const actor = await systemActor(row.tenant_id, row.actor_id);
      await tenantTx(row.tenant_id, async (c) => {
        const cfg = (
          await c.query('SELECT * FROM tracking_configs WHERE channel_id=$1 FOR UPDATE', [
            row.channel_id,
          ])
        ).rows[0];
        if (!cfg?.enabled || cfg.version !== row.version) return;
        await enqueueTracking(c, actor, row.channel_id);
      });
    } catch (e) {
      if (e instanceof Problem && [403, 409].includes(e.status))
        await tenantTx(row.tenant_id, (c) =>
          c.query(
            'UPDATE tracking_configs SET enabled=false,error=$3,updated_at=now() WHERE channel_id=$1 AND version=$2',
            [row.channel_id, row.version, errorMessage(e)],
          ),
        );
      else throw e;
    }
  }
}
export function normalizeTracking(raw: any, s: any, simulation: boolean) {
  const statusValid = (v: any) => typeof v === 'string' && /^[a-z][a-z0-9_]{0,98}$/.test(v);
  const validDate = (v: any) => typeof v === 'string' && Number.isFinite(new Date(v).getTime());
  ensure(
    raw &&
      raw.tracking_number === s.tracking_number &&
      statusValid(raw.status) &&
      Array.isArray(raw.tracking_details) &&
      raw.tracking_details.length <= 200 &&
      raw.tracking_details.every((x: any) => x && statusValid(x.status) && validDate(x.datetime)) &&
      (raw.updated_at === undefined || validDate(raw.updated_at)) &&
      (raw.created_at === undefined || validDate(raw.created_at)),
    502,
    'Nieprawidłowy tracking InPost',
  );
  const details = raw.tracking_details.map((x: any) => ({
    status: x.status,
    datetime: new Date(x.datetime).toISOString(),
  }));
  const dates = details.map((x: any) => new Date(x.datetime).getTime());
  if (raw.updated_at) dates.push(new Date(raw.updated_at).getTime());
  return {
    tracking_number: s.tracking_number,
    status: raw.status,
    tracking_details: details,
    provider_updated_at: dates.length ? new Date(Math.max(...dates)).toISOString() : null,
    provider_created_at: raw.created_at ? new Date(raw.created_at).toISOString() : null,
    scope: simulation ? 'local_simulation' : 'external_api_verified',
  };
}
// Request revisions fence manual/automatic races. The order lock always precedes the shipment lock.
export async function readShipmentTracking(
  actor: Actor,
  shipmentId: string,
  ctx: IntegrationContext = {},
  demoStatus?: string,
  job?: any,
) {
  const initial = await tenantTx(actor.tenantId, async (c) => {
    if (job) await policy(c, job, true);
    const found = (await c.query('SELECT * FROM shipments WHERE id=$1', [shipmentId])).rows[0];
    ensure(found?.channel_id, 404, 'Nie znaleziono przesyłki');
    await c.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE', [found.order_id]);
    const s = (await c.query('SELECT * FROM shipments WHERE id=$1 FOR UPDATE', [shipmentId]))
      .rows[0];
    if (job)
      ensure(
        s.channel_id === job.payload.channel_id && s.dispatched_at && s.tracking_job_id === job.id,
        409,
        'Nieaktualne zadanie trackingu',
      );
    if (
      job &&
      (trackingTerminal.includes(s.tracking_data?.status) ||
        Date.now() -
          Math.min(
            new Date(s.created_at).getTime(),
            new Date(s.tracking_provider_created_at ?? s.created_at).getTime(),
          ) >=
          45 * 86400000)
    ) {
      const result = {
        status: s.tracking_data?.status ?? s.status,
        scope:
          s.tracking_data?.scope ?? (s.mode === 'demo' ? 'local_simulation' : 'external_pending'),
        applied: false,
        reason: 'Tracking zakończony lub wygasły',
      };
      await completeTracking(c, job, result);
      return { ...s, tracking_skip: result };
    }
    s.tracking_revision++;
    await c.query('UPDATE shipments SET tracking_revision=$2 WHERE id=$1', [
      s.id,
      s.tracking_revision,
    ]);
    return s;
  });
  if (initial.tracking_skip) return initial.tracking_skip;
  const ch = await loadChannel(actor.tenantId, initial.channel_id);
  ensure(
    trackingReady(ch),
    422,
    'Tracking wymaga trybu live oraz danych dostępowych przewoźnika; sandbox obsługuje tylko przykład lokalny',
  );
  ensure(
    ch.settings.simulation || !demoStatus,
    422,
    'Symulacja jest dostępna tylko w przykładzie lokalnym',
  );
  const hash = trackingConnection(ch);
  const checkBeforeRead = async () => {
    if (job) await guarded(job, true);
    ensure(
      trackingConnection(await loadChannel(actor.tenantId, ch.id)) === hash,
      409,
      'Połączenie trackingu zmieniło się',
    );
  };
  const transport = async (url: string, init: RequestInit) => {
    await checkBeforeRead();
    return (ctx.transport ?? safeFetch)(url, init);
  };
  // DHL and Poczta Polska time their own requests: the policy and account are checked once before the
  // read (outside that budget) and again in the write transaction below; the read itself is idempotent.
  const carrierRead = async () => {
    await checkBeforeRead();
    return ctx.transport ?? safeFetch;
  };
  const raw = ch.settings.simulation
    ? {
        tracking_number: initial.tracking_number,
        status:
          demoStatus ??
          initial.tracking_demo_status ??
          initial.tracking_data?.status ??
          initial.status,
        tracking_details: [
          {
            status:
              demoStatus ??
              initial.tracking_demo_status ??
              initial.tracking_data?.status ??
              initial.status,
            datetime: new Date().toISOString(),
          },
        ],
      }
    : ch.provider === 'dpd'
      ? await new DpdInfo(decrypt(ch.credentials), transport).tracking(initial)
      : ch.provider === 'dhl'
        ? await new Dhl(ch.mode, ch.settings, decrypt(ch.credentials), await carrierRead()).tracking(initial)
        : ch.provider === 'pocztapolska'
          ? await new PocztaPolskaTracking(decrypt(ch.credentials), await carrierRead()).tracking(initial)
          : await new InPost(ch.mode, {}, transport).tracking(initial.tracking_number);
  // DPD, DHL and Poczta Polska return the stored tracking shape already; InPost and the example are normalized.
  const result =
    ['dpd', 'dhl', 'pocztapolska'].includes(ch.provider) && !ch.settings.simulation
      ? raw
      : normalizeTracking(raw, initial, Boolean(ch.settings.simulation));
  return tenantTx(actor.tenantId, async (c) => {
    const cfg = job ? await policy(c, job) : null;
    const currentChannel = (
      await c.query(
        'SELECT provider,mode,settings,credentials FROM channels WHERE id=$1 FOR SHARE',
        [ch.id],
      )
    ).rows[0];
    ensure(
      currentChannel && trackingConnection(currentChannel) === hash,
      409,
      'Połączenie trackingu zmieniło się',
    );
    const order = (await c.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [initial.order_id]))
      .rows[0];
    const s = (await c.query('SELECT * FROM shipments WHERE id=$1 FOR UPDATE', [shipmentId]))
      .rows[0];
    ensure(
      s && s.channel_id === initial.channel_id && s.tracking_number === initial.tracking_number,
      409,
      'Przesyłka zmieniła się',
    );
    if (s.tracking_revision !== initial.tracking_revision) {
      const skipped = { ...result, applied: false, reason: 'Nowszy odczyt już rozpoczęty' };
      await completeTracking(c, job, skipped);
      return skipped;
    }
    const previous = s.tracking_data;
    const older =
      previous?.provider_updated_at &&
      result.provider_updated_at &&
      new Date(result.provider_updated_at) < new Date(previous.provider_updated_at);
    const terminalRegression =
      trackingTerminal.includes(previous?.status) &&
      !trackingTerminal.includes(result.status) &&
      !(['dpd', 'dhl', 'pocztapolska'].includes(ch.provider) && previous?.status === 'delivered' && result.return_leg);
    const undatedChange =
      previous?.provider_updated_at &&
      !result.provider_updated_at &&
      previous.status !== result.status;
    if (older || terminalRegression || undatedChange) {
      const skipped = { ...result, applied: false, reason: 'Zachowano nowszy lub końcowy status' };
      await completeTracking(c, job, skipped);
      return skipped;
    }
    await c.query(
      'UPDATE shipments SET status=$2,tracking_data=$3,tracking_at=now(),tracking_error=NULL,tracking_provider_created_at=coalesce($4,tracking_provider_created_at),tracking_next_at=CASE WHEN $5 THEN NULL ELSE now()+make_interval(secs=>$6) END WHERE id=$1',
      [
        s.id,
        result.status,
        JSON.stringify(result),
        result.provider_created_at,
        trackingTerminal.includes(result.status),
        cfg?.interval_seconds ?? 3600,
      ],
    );
    if (previous?.status !== result.status)
      await automationOnlyEvent(c, actor.tenantId, order.id, 'shipment.status_changed', { shipment_id: s.id, from: previous?.status ?? null, to: result.status, status: shipmentStatusOf(result.status) });
    let orderChanged = false;
    // Physical dispatch has already consumed stock. Tracking never repeats that action or settles COD.
    if (
      cfg?.mark_delivered &&
      result.status === 'delivered' &&
      s.dispatched_at &&
      order.status === 'shipped' &&
      !(await c.query("SELECT id FROM shipments WHERE order_id=$1 AND (dispatched_at IS NULL OR status IS DISTINCT FROM 'delivered') LIMIT 1", [order.id])).rowCount
    ) {
      await transition(c, actor, order.id, 'delivered');
      orderChanged = true;
    }
    if (previous?.status !== result.status || orderChanged || !job)
      await audit(c, actor, 'shipping.tracking', s.id, {
        scope: result.scope,
        status: result.status,
        automatic: Boolean(job),
        order_changed: orderChanged,
      });
    const applied = { ...result, applied: true, order_changed: orderChanged };
    await completeTracking(c, job, applied);
    return applied;
  });
}
export async function processTracking(job: any, ctx: IntegrationContext = {}) {
  const actor = await systemActor(job.tenant_id, job.payload.actor_id);
  await guarded(job, true);
  await readShipmentTracking(actor, job.payload.shipment_id, ctx, undefined, job);
}

export async function failTracking(job: any, e: unknown) {
  await tenantTx(job.tenant_id, async (c) => {
    if (!(await fenceSync(c, job))) return;
    const terminal =
      (e instanceof Problem && [403, 404, 409, 422].includes(e.status)) ||
      job.attempts >= job.max_attempts;
    await c.query(
      'UPDATE jobs SET state=$2,error=$3,lease_token=NULL,locked_at=NULL,run_at=now()+make_interval(secs=>least(300,power(2,attempts)::int)) WHERE id=$1',
      [job.id, terminal ? 'failed' : 'pending', errorMessage(e)],
    );
    await c.query(
      "UPDATE shipments SET tracking_error=$2,tracking_next_at=CASE WHEN $3 THEN now()+interval '1 hour' ELSE tracking_next_at END WHERE id=$1 AND tracking_job_id=$4",
      [job.payload.shipment_id, errorMessage(e), terminal, job.id],
    );
  });
}
