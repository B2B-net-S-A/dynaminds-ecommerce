/** REPRICE-005/006 (migration 247): the channel result of a scheduled repricing run.
 * When a run batch writes prices, one row per changed product and synced listing is recorded in the
 * same transaction (expected price, currency, time of the write). Reconcile links each open row to the
 * first offer-sync plan of that listing after the write and reads its outcome: sent (queued or an
 * uncertain write), acknowledged (the channel holds the price), mismatch (written but not confirmed),
 * failed (refused) or superseded (the price changed again before the sync). offer-sync and offers are
 * not changed: the link is read from offer_plans. */
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool, tenantTx } from './db';
import { ensure } from './errors';

export const CHANNEL_STATES = ['pending', 'sent', 'acknowledged', 'mismatch', 'failed', 'superseded'] as const;
export type ChannelState = (typeof CHANNEL_STATES)[number];
export interface ChannelExpected { price: number; currency: string; applied_at: string | Date }
export interface ChannelPlan {
  id: string;
  state: string;
  phase: string;
  created_at: string | Date;
  error: string | null;
  local_snapshot: { price?: unknown; currency?: unknown } | null;
  result: { desired_applied?: unknown } | null;
}
export interface ChannelOutcome { status: ChannelState; plan_id: string | null; remote_price: number | null; error: string | null }
export type ChannelSummary = { total: number; open: number } & Record<ChannelState, number>;

const time = (v: string | Date) => new Date(v).getTime();
export function channelOutcome(expected: ChannelExpected, plan: ChannelPlan | null): ChannelOutcome {
  const none = { status: 'pending' as const, plan_id: null, remote_price: null, error: null };
  if (!plan || time(plan.created_at) < time(expected.applied_at)) return none;
  const at = { plan_id: plan.id, remote_price: null, error: null };
  if (plan.local_snapshot?.price !== expected.price || plan.local_snapshot?.currency !== expected.currency)
    return { ...at, status: 'superseded', error: 'Cena w cenniku zmieniła się przed synchronizacją' };
  if (plan.state === 'preview') return none;
  if (plan.state === 'queued' || (plan.state === 'failed' && ['write_started', 'verify'].includes(plan.phase))) return { ...at, status: 'sent' };
  if (plan.state === 'done')
    return plan.result?.desired_applied === true
      ? { ...at, status: 'acknowledged', remote_price: expected.price }
      : { ...at, status: 'mismatch', error: 'Kanał nie potwierdził ceny po zapisie (odczyt różni się od ceny cennika)' };
  return { ...at, status: 'failed', error: String(plan.error ?? '').slice(0, 500) || 'Zapis oferty nie powiódł się' };
}

export function summarizeChannel(rows: readonly { status: string; n: number }[]): ChannelSummary | null {
  const s = Object.fromEntries(CHANNEL_STATES.map((k) => [k, 0])) as Record<ChannelState, number>;
  for (const r of rows) if ((CHANNEL_STATES as readonly string[]).includes(r.status)) s[r.status as ChannelState] += Number(r.n);
  const total = CHANNEL_STATES.reduce((t, k) => t + s[k], 0);
  return total ? { total, open: s.pending + s.sent, ...s } : null;
}

export async function channelResultsAvailable(c: PoolClient): Promise<boolean> {
  return (await c.query("SELECT to_regclass('public.repricing_channel_results') IS NOT NULL AS ok")).rows[0].ok === true;
}

/** In the run batch transaction, after the prices were written: one row per changed product and
 * listing of every enabled price sync fed by this list. Without the migration nothing is recorded. */
export async function recordRunChannelInTx(c: PoolClient, tenantId: string, runId: string, previewId: string, list: { id: string; currency: string },
  rows: readonly Record<string, any>[]): Promise<number> {
  const changes = rows.filter((r) => r.state === 'change' && r.proposed_price !== null);
  if (!changes.length || !(await channelResultsAvailable(c))) return 0;
  const r = await c.query(
    `INSERT INTO repricing_channel_results(tenant_id,run_id,listing_id,preview_id,price_list_id,product_id,channel_id,expected_price,currency,applied_at)
     SELECT $1,$2,l.id,$3,$4,x.product_id,l.channel_id,x.proposed_price,$5,now()
     FROM jsonb_to_recordset($6::jsonb) AS x(product_id uuid,proposed_price integer)
     JOIN listings l ON l.product_id=x.product_id AND l.external_id IS NOT NULL
     JOIN offer_sync_configs s ON s.channel_id=l.channel_id AND s.price_list_id=$4 AND s.price AND s.enabled
     ON CONFLICT (tenant_id,run_id,listing_id) DO NOTHING`,
    [tenantId, runId, previewId, list.id, list.currency, JSON.stringify(changes)],
  );
  return r.rowCount ?? 0;
}

const PLAN = `SELECT id,state,phase,created_at,error,local_snapshot,result FROM offer_plans`;
/** Reconciles open rows (all, or of one run), least recently checked first; rows locked by another reconcile are skipped. */
export async function reconcileChannelInTx(c: PoolClient, runId: string | null, limit = 200): Promise<number> {
  const open = (
    await c.query(
      `SELECT * FROM repricing_channel_results WHERE status IN ('pending','sent') AND ($1::uuid IS NULL OR run_id=$1)
       ORDER BY checked_at NULLS FIRST,created_at,run_id,listing_id LIMIT $2 FOR UPDATE SKIP LOCKED`,
      [runId, limit],
    )
  ).rows;
  let changed = 0;
  for (const row of open) {
    const plan: ChannelPlan | null = row.plan_id
      ? (await c.query(`${PLAN} WHERE id=$1`, [row.plan_id])).rows[0] ?? null
      : (
          await c.query(
            // An unconfirmed preview is never the result: offer-sync and the UI leave such plans behind.
            `${PLAN} WHERE channel_id=$1 AND product_id=$2 AND operation='sync' AND state<>'preview' AND created_at>=$3 AND (listing_id IS NULL OR listing_id=$4)
             ORDER BY created_at,id LIMIT 1`,
            [row.channel_id, row.product_id, row.applied_at, row.listing_id],
          )
        ).rows[0] ?? null;
    const out = channelOutcome({ price: row.expected_price, currency: row.currency, applied_at: row.applied_at }, plan);
    const u = await c.query(
      `UPDATE repricing_channel_results SET status=$4,plan_id=$5,remote_price=$6,error=$7,checked_at=now(),
         updated_at=CASE WHEN (status,plan_id) IS DISTINCT FROM ($4::text,$5::uuid) THEN now() ELSE updated_at END
       WHERE (tenant_id,run_id,listing_id)=($1,$2,$3) AND (status,plan_id) IS DISTINCT FROM ($4::text,$5::uuid) RETURNING 1`,
      [row.tenant_id, row.run_id, row.listing_id, out.status, out.plan_id, out.remote_price, out.error],
    );
    if (u.rowCount) changed++;
    else await c.query('UPDATE repricing_channel_results SET checked_at=now() WHERE (tenant_id,run_id,listing_id)=($1,$2,$3)', [row.tenant_id, row.run_id, row.listing_id]);
  }
  return changed;
}

/** Worker tick (from scheduleRepricingDue): open rows of every tenant, bounded. */
export async function reconcileRepricingChannelDue(): Promise<void> {
  const present = (await pool.query("SELECT to_regclass('public.repricing_channel_results') IS NOT NULL AS ok")).rows[0].ok;
  if (!present) return;
  const tenants = (
    await pool.query("SELECT DISTINCT tenant_id FROM repricing_channel_results WHERE status IN ('pending','sent') LIMIT 20")
  ).rows;
  const failed: string[] = [];
  for (const t of tenants) {
    try {
      await tenantTx(t.tenant_id, (c) => reconcileChannelInTx(c, null, 200));
    } catch (e) {
      failed.push(`${t.tenant_id}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300));
    }
  }
  if (failed.length) throw new Error(`Uzgodnienie wyniku kanału repricingu nie powiodło się (${failed.length}): ${failed.join('; ')}`);
}

/** Channel summaries keyed by run id or by preview id (null when nothing was recorded). */
export async function channelSummaries(c: PoolClient, key: 'run_id' | 'preview_id', ids: readonly string[]): Promise<Map<string, ChannelSummary | null>> {
  if (!ids.length || !(await channelResultsAvailable(c))) return new Map();
  const rows = (
    await c.query(`SELECT ${key} AS id,status,count(*)::int n FROM repricing_channel_results WHERE ${key}=ANY($1::uuid[]) GROUP BY 1,2`, [ids])
  ).rows;
  return new Map(ids.map((id) => [id, summarizeChannel(rows.filter((r) => r.id === id))]));
}

export function registerRepricingChannelRoutes(app: FastifyInstance): void {
  const id = (p: unknown) => z.object({ id: z.uuid() }).parse(p).id;
  const q = z.object({
    status: z.enum(CHANNEL_STATES).optional(),
    after: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  });
  const read = async (c: PoolClient, runId: string, query: z.infer<typeof q>) => {
    ensure((await c.query('SELECT 1 FROM repricing_runs WHERE id=$1', [runId])).rowCount, 404, 'Nie znaleziono przebiegu');
    if (!(await channelResultsAvailable(c))) return { available: false, summary: null, data: [], meta: { cursor: null } };
    const rows = (
      await c.query(
        `SELECT r.listing_id,r.product_id,r.channel_id,r.preview_id,r.expected_price,r.currency,r.status,r.plan_id,r.remote_price,r.error,
           r.applied_at,r.checked_at,p.sku,ch.name channel_name,ch.provider,l.external_id
         FROM repricing_channel_results r JOIN products p ON (p.tenant_id,p.id)=(r.tenant_id,r.product_id)
         JOIN channels ch ON (ch.tenant_id,ch.id)=(r.tenant_id,r.channel_id) JOIN listings l ON (l.tenant_id,l.id)=(r.tenant_id,r.listing_id)
         WHERE r.run_id=$1 AND ($2::text IS NULL OR r.status=$2) AND ($3::uuid IS NULL OR r.listing_id>$3)
         ORDER BY r.listing_id LIMIT $4`,
        [runId, query.status ?? null, query.after ?? null, query.limit + 1],
      )
    ).rows;
    return {
      available: true,
      summary: (await channelSummaries(c, 'run_id', [runId])).get(runId) ?? null,
      data: rows.slice(0, query.limit),
      meta: { cursor: rows.length > query.limit ? rows[query.limit - 1].listing_id : null },
    };
  };
  app.get('/api/repricing-runs/:id/channel', (r) => tenantTx(r.actor.tenantId, (c) => read(c, id(r.params), q.parse(r.query))));
  app.post('/api/repricing-runs/:id/channel/reconcile', (r) => {
    ensure(r.actor.role !== 'viewer', 403, 'Konto ma uprawnienia tylko do odczytu');
    z.object({}).strict().parse(r.body ?? {});
    return tenantTx(r.actor.tenantId, async (c) => {
      const runId = id(r.params);
      ensure((await c.query('SELECT 1 FROM repricing_runs WHERE id=$1', [runId])).rowCount, 404, 'Nie znaleziono przebiegu');
      ensure(await channelResultsAvailable(c), 503, 'Kopia nie zawiera wyników kanału repricingu (migracja 247)');
      const changed = await reconcileChannelInTx(c, runId, 500);
      return { changed, ...(await read(c, runId, q.parse({}))) };
    });
  });
}
