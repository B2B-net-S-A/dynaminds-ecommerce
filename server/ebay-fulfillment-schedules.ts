import { EbayApiWait, deferEbayApiJob } from './ebay-api-limits';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool, tenantTx } from './db';
import { audit, type Actor } from './domain';
import { ensure, Problem } from './errors';
import { ebayConnectionHash } from './ebay';
import { fenceSync } from './offer-sync';
import type { IntegrationContext } from './channel-access';
import {
  previewEbayFulfillment,
  queueEbayFulfillment,
  requireEbayFulfillment,
} from './ebay-fulfillment';
export const FULFILLMENT_BATCH = 25;
export type FulfillmentAuto = { version: number; job?: any };
export const fulfillmentConfigInput = z
  .object({
    version: z.number().int().min(0),
    enabled: z.boolean(),
    confirm_external: z.boolean().default(false),
    shipped_since: z.iso.datetime(),
    carrier_mappings: z
      .array(
        z
          .object({
            local_carrier: z.string().trim().min(1).max(160),
            ebay_code: z.string().regex(/^[A-Za-z0-9_]{1,64}$/),
          })
          .strict(),
      )
      .min(1)
      .max(30),
  })
  .strict()
  .superRefine((v, c) => {
    if (new Set(v.carrier_mappings.map((m) => m.local_carrier)).size !== v.carrier_mappings.length)
      c.addIssue({
        code: 'custom',
        message: 'Powtórzony lokalny przewoźnik',
        path: ['carrier_mappings'],
      });
  });
const message = (e: unknown) =>
  e instanceof Problem ? e.message : 'Błąd przygotowania automatycznej wysyłki eBay';
async function admin(c: PoolClient, a: Actor) {
  ensure(
    (await c.query('SELECT offer_sync_is_admin($1) ok', [a.userId])).rows[0]?.ok,
    403,
    'Wymagana aktualna rola administratora',
  );
}
export async function fulfillmentAutoPolicy(
  c: PoolClient,
  a: Actor,
  ch: any,
  auto?: FulfillmentAuto,
  shipment?: any,
  carrierCode?: string,
) {
  if (!auto) return;
  if (auto.job)
    ensure(await fenceSync(c, auto.job, true), 409, 'Wygasła dzierżawa przeglądu wysyłek');
  await admin(c, a);
  const cfg = (
    await c.query('SELECT * FROM ebay_fulfillment_configs WHERE channel_id=$1 FOR SHARE', [ch.id])
  ).rows[0];
  ensure(
    cfg?.enabled &&
      cfg.version === auto.version &&
      cfg.actor_id === a.userId &&
      cfg.connection_hash === ebayConnectionHash(ch) &&
      (ch.settings.simulation || cfg.external_authorized),
    409,
    'Automatyzację wysyłek wyłączono lub zmieniono',
  );
  requireEbayFulfillment(ch);
  const binding = (
    await c.query('SELECT mode,source FROM ebay_account_bindings WHERE channel_id=$1', [ch.id])
  ).rows[0];
  ensure(
    binding &&
      binding.mode === ch.mode &&
      binding.source === (ch.settings.simulation ? 'simulation' : 'trading'),
    409,
    'Najpierw sprawdź tożsamość konta eBay',
  );
  ensure(
    !(
      await c.query(
        'SELECT 1 FROM oauth_states WHERE channel_id=$1 AND consumed_at IS NULL AND expires_at>now()',
        [ch.id],
      )
    ).rowCount,
    409,
    'Najpierw zakończ lub anuluj OAuth eBay',
  );
  if (shipment) {
    const code = cfg.carrier_mappings.find(
      (m: any) => m.local_carrier === shipment.carrier,
    )?.ebay_code;
    ensure(
      code && (!carrierCode || carrierCode === code),
      422,
      'Brak zgodnego mapowania przewoźnika do eBay',
    );
    ensure(
      new Date(shipment.dispatched_at) >= new Date(cfg.shipped_since),
      409,
      'Przesyłka poza okresem automatyzacji',
    );
  }
  return cfg;
}
export async function configureFulfillment(
  a: Actor,
  id: string,
  b: z.infer<typeof fulfillmentConfigInput>,
) {
  return tenantTx(a.tenantId, async (c) => {
    await admin(c, a);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      'ebay-fulfillment-config:' + a.tenantId + ':' + id,
    ]);
    const ch = (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [id])).rows[0];
    ensure(ch?.provider === 'ebay', 404, 'Nie znaleziono eBay');
    if (b.enabled) {
      ensure(
        Date.parse(b.shipped_since) <= Date.now() &&
          Date.parse(b.shipped_since) >= Date.now() - 90 * 86400000,
        422,
        'Wybierz początek nie starszy niż 90 dni',
      );
      ensure(
        ch.settings.simulation || b.confirm_external,
        422,
        'Potwierdź automatyczne przekazywanie wysyłek do eBay',
      );
      requireEbayFulfillment(ch);
      ensure(
        (
          await c.query(
            'SELECT 1 FROM ebay_account_bindings WHERE channel_id=$1 AND mode=$2 AND source=$3',
            [id, ch.mode, ch.settings.simulation ? 'simulation' : 'trading'],
          )
        ).rowCount,
        409,
        'Najpierw sprawdź tożsamość konta eBay',
      );
      ensure(
        !(
          await c.query(
            'SELECT 1 FROM oauth_states WHERE channel_id=$1 AND consumed_at IS NULL AND expires_at>now()',
            [id],
          )
        ).rowCount,
        409,
        'Najpierw zakończ lub anuluj OAuth eBay',
      );
    }
    // Lock jobs before touching queued plans, matching the worker's lease ordering.
    await c.query(
      `SELECT id FROM jobs WHERE state IN ('pending','running') AND ((kind='ebay.fulfillment.scan' AND payload->>'channel_id'=$1) OR (kind='ebay.fulfillment' AND id IN (SELECT job_id FROM ebay_fulfillment_plans WHERE channel_id=$1::uuid AND config_version IS NOT NULL AND state='queued' AND phase='ready'))) ORDER BY id FOR UPDATE`,
      [id],
    );
    const old = (
      await c.query('SELECT * FROM ebay_fulfillment_configs WHERE channel_id=$1 FOR UPDATE', [id])
    ).rows[0];
    ensure((old?.version ?? 0) === b.version, 409, 'Konfigurację zmieniono; odśwież dane');
    await c.query(
      `UPDATE jobs SET state='failed',lease_token=NULL,locked_at=NULL,error='Konfigurację wysyłek zmieniono' WHERE state IN ('pending','running') AND ((kind='ebay.fulfillment.scan' AND payload->>'channel_id'=$1) OR (kind='ebay.fulfillment' AND id IN (SELECT job_id FROM ebay_fulfillment_plans WHERE channel_id=$1::uuid AND config_version IS NOT NULL AND state='queued' AND phase='ready')))`,
      [id],
    );
    await c.query(
      "UPDATE ebay_fulfillment_plans SET state='conflict',error='Konfigurację wysyłek zmieniono',updated_at=now() WHERE channel_id=$1 AND config_version IS NOT NULL AND state='queued' AND phase='ready'",
      [id],
    );
    const cfg = (
      await c.query(
        `INSERT INTO ebay_fulfillment_configs(tenant_id,channel_id,actor_id,enabled,external_authorized,connection_hash,carrier_mappings,shipped_since,next_run_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $4 THEN now() END) ON CONFLICT(channel_id) DO UPDATE SET actor_id=excluded.actor_id,enabled=excluded.enabled,external_authorized=excluded.external_authorized,connection_hash=excluded.connection_hash,carrier_mappings=excluded.carrier_mappings,shipped_since=excluded.shipped_since,next_run_at=excluded.next_run_at,version=ebay_fulfillment_configs.version+1,error=NULL,updated_at=now() RETURNING *`,
        [
          a.tenantId,
          id,
          a.userId,
          b.enabled,
          b.enabled && b.confirm_external,
          ebayConnectionHash(ch),
          JSON.stringify(b.carrier_mappings),
          b.shipped_since,
        ],
      )
    ).rows[0];
    await audit(c, a, 'ebay.fulfillment.configure', id, {
      enabled: cfg.enabled,
      version: cfg.version,
      external_authorized: cfg.external_authorized,
    });
    return cfg;
  });
}
export async function scheduleEbayFulfillmentsDue() {
  const due = (
    await pool.query(
      'SELECT tenant_id,channel_id,version FROM ebay_fulfillment_configs WHERE enabled AND (next_run_at IS NULL OR next_run_at<=now()) ORDER BY next_run_at NULLS FIRST,channel_id LIMIT 20',
    )
  ).rows;
  for (const r of due)
    await tenantTx(r.tenant_id, async (c) => {
      const cfg = (
        await c.query('SELECT * FROM ebay_fulfillment_configs WHERE channel_id=$1 FOR UPDATE', [
          r.channel_id,
        ])
      ).rows[0];
      if (
        !cfg?.enabled ||
        cfg.version !== r.version ||
        (cfg.next_run_at && new Date(cfg.next_run_at).getTime() > Date.now())
      )
        return;
      const existing = (
        await c.query(
          "SELECT id FROM jobs WHERE kind='ebay.fulfillment.scan' AND payload->>'channel_id'=$1 AND state IN ('pending','running')",
          [r.channel_id],
        )
      ).rows[0];
      const id = existing?.id ?? randomUUID();
      if (!existing)
        await c.query(
          "INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key) VALUES($1,$2,'ebay.fulfillment.scan',$3,$4)",
          [
            id,
            r.tenant_id,
            JSON.stringify({
              channel_id: r.channel_id,
              actor_id: cfg.actor_id,
              version: cfg.version,
              cutoff: new Date().toISOString(),
              after: null,
              stats: { checked: 0, queued: 0, skipped: 0, errors: 0 },
            }),
            'ebay.fulfillment.scan:' + id,
          ],
        );
      await c.query(
        "UPDATE ebay_fulfillment_configs SET next_run_at=now()+interval '60 seconds',last_job_id=$2 WHERE channel_id=$1",
        [r.channel_id, id],
      );
    });
}
export async function processEbayFulfillmentScan(job: any, ctx: IntegrationContext = {}) {
  const a: Actor = { tenantId: job.tenant_id, userId: job.payload.actor_id, role: 'admin' },
    auto = { job, version: job.payload.version };
  const check = () =>
    tenantTx(a.tenantId, async (c) => {
      const ch = (
        await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [job.payload.channel_id])
      ).rows[0];
      ensure(ch?.provider === 'ebay', 404, 'Nie znaleziono eBay');
      const cfg = await fulfillmentAutoPolicy(c, a, ch, auto);
      return { ch, cfg };
    });
  const { ch, cfg } = await check();
  const rows = await tenantTx(
    a.tenantId,
    async (c) =>
      (
        await c.query(
          `SELECT DISTINCT ON(o.id) o.id,s.id shipment_id,s.carrier FROM orders o JOIN shipments s ON (s.tenant_id,s.order_id)=(o.tenant_id,o.id) WHERE o.source='ebay' AND o.channel_id=$1 AND o.status IN ('shipped','delivered','completed') AND o.id>coalesce($2::uuid,'00000000-0000-0000-0000-000000000000'::uuid) AND s.dispatched_at>=$3 AND s.dispatched_at<=$4 AND NOT EXISTS(SELECT 1 FROM ebay_fulfillment_receipts r WHERE (r.tenant_id,r.channel_id,r.config_version,r.order_id)=(o.tenant_id,o.channel_id,$5,o.id)) ORDER BY o.id,s.created_at,s.id LIMIT $6`,
          [
            ch.id,
            job.payload.after,
            cfg.shipped_since,
            job.payload.cutoff,
            auto.version,
            FULFILLMENT_BATCH + 1,
          ],
        )
      ).rows,
  );
  const stats = { ...job.payload.stats };
  let after = job.payload.after,
    backpressure = false;
  for (const o of rows.slice(0, FULFILLMENT_BATCH)) {
    await check();
    const pending = await tenantTx(
      a.tenantId,
      async (c) =>
        (
          await c.query(
            "SELECT count(*)::int n FROM ebay_fulfillment_plans WHERE channel_id=$1 AND state='queued'",
            [ch.id],
          )
        ).rows[0].n,
    );
    if (pending >= 100) {
      backpressure = true;
      break;
    }
    let state = 'skipped',
      error: string | null = null,
      planId: string | null = null;
    const existing = await tenantTx(
      a.tenantId,
      async (c) =>
        (
          await c.query(
            "SELECT id FROM ebay_fulfillment_plans WHERE order_id=$1 AND (state IN ('done','queued') OR state IN ('failed','conflict') AND phase IN ('write_started','verify')) LIMIT 1",
            [o.id],
          )
        ).rows[0],
    );
    if (existing) stats.skipped++;
    else
      try {
        const code = cfg.carrier_mappings.find(
          (m: any) => m.local_carrier === o.carrier,
        )?.ebay_code;
        ensure(code, 422, 'Brak mapowania lokalnego przewoźnika do eBay');
        const p = await previewEbayFulfillment(a, o.id, { shipping_carrier_code: code }, ctx, auto);
        planId = p.id;
        await queueEbayFulfillment(a, p.id, true, auto);
        state = 'queued';
        stats.queued++;
      } catch (e) {
        if (e instanceof EbayApiWait) throw e;
        await check(); // Revoked role/config/lease stops the whole scan, never becomes a per-order receipt.
        state = 'conflict';
        error = message(e);
        stats.errors++;
      }
    await tenantTx(a.tenantId, async (c) => {
      const current = (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [ch.id]))
        .rows[0];
      await fulfillmentAutoPolicy(c, a, current, auto);
      await c.query(
        'INSERT INTO ebay_fulfillment_receipts(tenant_id,channel_id,config_version,order_id,shipment_id,plan_id,state,error) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING',
        [a.tenantId, ch.id, auto.version, o.id, o.shipment_id, planId, state, error],
      );
      stats.checked++;
      after = o.id;
      await c.query('UPDATE jobs SET payload=$2 WHERE id=$1', [
        job.id,
        JSON.stringify({ ...job.payload, after, stats }),
      ]);
    });
  }
  await tenantTx(a.tenantId, async (c) => {
    const current = (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [ch.id]))
      .rows[0];
    await fulfillmentAutoPolicy(c, a, current, auto);
    const more = backpressure || rows.length > FULFILLMENT_BATCH;
    await c.query(
      "UPDATE jobs SET state=$2,payload=$3,attempts=CASE WHEN $2='pending' THEN 0 ELSE attempts END,lease_token=NULL,locked_at=NULL,error=NULL,run_at=now()+make_interval(secs=>$4) WHERE id=$1",
      [
        job.id,
        more ? 'pending' : 'done',
        JSON.stringify({ ...job.payload, after, stats }),
        backpressure ? 10 : 0,
      ],
    );
    if (!more)
      await c.query(
        'UPDATE ebay_fulfillment_configs SET last_run_at=now(),error=NULL WHERE channel_id=$1 AND version=$2',
        [ch.id, auto.version],
      );
    await audit(c, a, 'ebay.fulfillment.scan', job.id, { ...stats, more, backpressure });
  });
}
export async function failEbayFulfillmentScan(job: any, e: unknown) {
  if (await deferEbayApiJob(job, e)) return;
  await tenantTx(job.tenant_id, async (c) => {
    if (!(await fenceSync(c, job))) return;
    const terminal = e instanceof Problem && [403, 404, 409, 422].includes(e.status),
      failed = terminal || job.attempts >= job.max_attempts;
    await c.query(
      "UPDATE jobs SET state=$2,error=$3,lease_token=NULL,locked_at=NULL,run_at=now()+interval '30 seconds' WHERE id=$1",
      [job.id, failed ? 'failed' : 'pending', message(e)],
    );
    if (failed)
      await c.query(
        'UPDATE ebay_fulfillment_configs SET error=$2,enabled=false,external_authorized=false,next_run_at=NULL WHERE channel_id=$1 AND version=$3',
        [job.payload.channel_id, message(e), job.payload.version],
      );
  });
}
