import { allegroOAuthCommitRefusalDetails } from './allegro-oauth-authority';
import { AmazonApiWait, deferAmazonApiJob } from './amazon-api-limits';
import { EbayApiWait, deferEbayApiJob } from './ebay-api-limits';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool, tenantTx } from './db';
import { audit, type Actor } from './domain';
import { ensure, Problem } from './errors';
import { loadChannel, withAllegroJobContext, type IntegrationContext } from './channel-access';
import {
  desiredOffer,
  offerInput,
  offerMatches,
  previewOffer,
  queueOffer,
  offerSnapshotHash,
} from './offers';
import { syncPolicy } from './offer-sync-policy';
import { systemActor } from './sync';
import type {LocalWooStockContext} from './local-woo-stock-context';
export const OFFER_SYNC_BATCH = 25;
const message = (e: unknown) => (e instanceof Problem ? e.message : 'Błąd przeglądu oferty');
export async function fenceSync(c: PoolClient, job: any, renew = false) {
  return Boolean(
    (
      await c.query(
        renew
          ? "UPDATE jobs SET locked_at=now() WHERE id=$1 AND lease_token=$2 AND state='running' RETURNING id"
          : "SELECT id FROM jobs WHERE id=$1 AND lease_token=$2 AND state='running' FOR UPDATE",
        [job.id, job.lease_token],
      )
    ).rowCount,
  );
}
export async function enqueueOfferSync(c: PoolClient, actor: Actor, channelId: string) {
  const cfg = (
    await c.query('SELECT * FROM offer_sync_configs WHERE channel_id=$1 FOR UPDATE', [channelId])
  ).rows[0];
  ensure(cfg?.enabled, 409, 'Najpierw włącz harmonogram ofert');
  ensure(
    await syncPolicy(c, channelId, cfg.version, actor.userId),
    409,
    'Konfiguracja synchronizacji wymaga ponownego zatwierdzenia',
  );
  const current = (
    await c.query(
      "SELECT id FROM jobs WHERE kind='offer.sync' AND state IN ('pending','running') AND payload->>'channel_id'=$1",
      [channelId],
    )
  ).rows[0];
  await c.query(
    'UPDATE offer_sync_configs SET next_run_at=now()+make_interval(secs=>interval_seconds) WHERE channel_id=$1',
    [channelId],
  );
  if (current) return { id: current.id, reused: true };
  const id = randomUUID();
  await c.query(
    "INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key) VALUES($1,$2,'offer.sync',$3,$4)",
    [
      id,
      actor.tenantId,
      JSON.stringify({
        channel_id: channelId,
        actor_id: actor.userId,
        version: cfg.version,
        after: null,
        stats: { checked: 0, skipped: 0, queued: 0, unchanged: 0, waiting: 0, errors: 0 },
      }),
      'offer.sync:' + id,
    ],
  );
  await c.query('UPDATE offer_sync_configs SET last_job_id=$2,error=NULL WHERE channel_id=$1', [
    channelId,
    id,
  ]);
  await audit(c, actor, 'offer.sync.enqueue', channelId, { job_id: id, version: cfg.version });
  return { id, reused: false };
}
export async function scheduleOffersDue() {
  const due = (
    await pool.query(
      'SELECT tenant_id,channel_id,actor_id,version FROM offer_sync_configs WHERE enabled AND (next_run_at IS NULL OR next_run_at<=now()) ORDER BY next_run_at NULLS FIRST,channel_id LIMIT 20',
    )
  ).rows;
  for (const row of due) {
    try {
      const actor = await systemActor(row.tenant_id, row.actor_id);
      await tenantTx(row.tenant_id, async (c) => {
        const cfg = (
          await c.query('SELECT * FROM offer_sync_configs WHERE channel_id=$1 FOR UPDATE', [
            row.channel_id,
          ])
        ).rows[0];
        if (
          !cfg?.enabled ||
          cfg.version !== row.version ||
          (cfg.next_run_at && new Date(cfg.next_run_at).getTime() > Date.now())
        )
          return;
        await enqueueOfferSync(c, actor, row.channel_id);
      });
    } catch (e) {
      if (e instanceof Problem && [403, 409].includes(e.status))
        await tenantTx(row.tenant_id, (c) =>
          c.query(
            'UPDATE offer_sync_configs SET enabled=false,error=$3,updated_at=now() WHERE channel_id=$1 AND version=$2',
            [row.channel_id, row.version, message(e)],
          ),
        );
      else throw e;
    }
  }
}
async function saveItem(c: PoolClient, cfg: any, listingId: string, patch: any) {
  const existing = (
    await c.query(
      'SELECT * FROM offer_sync_items WHERE channel_id=$1 AND listing_id=$2 FOR UPDATE',
      [cfg.channel_id, listingId],
    )
  ).rows[0];
  const row = {
    desired_hash: null,
    verified_hash: null,
    last_checked_at: null,
    plan_id: null,
    plan_acknowledged: false,
    state: 'error',
    error: null,
    ...existing,
    ...patch,
  };
  await c.query(
    `INSERT INTO offer_sync_items(tenant_id,channel_id,listing_id,config_version,desired_hash,verified_hash,last_checked_at,plan_id,plan_acknowledged,state,error)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(tenant_id,channel_id,listing_id) DO UPDATE SET config_version=excluded.config_version,desired_hash=excluded.desired_hash,verified_hash=excluded.verified_hash,last_checked_at=excluded.last_checked_at,plan_id=excluded.plan_id,plan_acknowledged=excluded.plan_acknowledged,state=excluded.state,error=excluded.error,updated_at=now()`,
    [
      cfg.tenant_id,
      cfg.channel_id,
      listingId,
      cfg.version,
      row.desired_hash,
      row.verified_hash,
      row.last_checked_at,
      row.plan_id,
      row.plan_acknowledged,
      row.state,
      row.error,
    ],
  );
}
async function guardedSync(job: any, fn: (c: PoolClient, cfg: any) => Promise<void>, renew = false, ctx:LocalWooStockContext={}) {
  return tenantTx(job.tenant_id, async (c) => {
    const cfg = (
      await c.query('SELECT * FROM offer_sync_configs WHERE channel_id=$1 FOR SHARE', [
        job.payload.channel_id,
      ])
    ).rows[0];
    await ctx.localWooStockFence?.(c,job);
    if (
      !cfg ||
      !(await syncPolicy(c, cfg.channel_id, job.payload.version, job.payload.actor_id)) ||
      !(await fenceSync(c, job, renew))
    )
      return false;
    await fn(c, cfg);
    return true;
  });
}
export async function processOfferSync(job: any, ctx: LocalWooStockContext = {}) {
  const guarded=(j:any,fn:(c:PoolClient,cfg:any)=>Promise<void>,renew=false)=>guardedSync(j,fn,renew,ctx);
  ctx = withAllegroJobContext(ctx, job);
  const actor = await systemActor(job.tenant_id, job.payload.actor_id);
  const ch = await loadChannel(job.tenant_id, job.payload.channel_id);
  let cfg: any,
    rows: any[] = [];
  if (
    !(await guarded(
      job,
      async (c, current) => {
        cfg = current;
        rows = (
          await c.query(
            `SELECT l.* FROM listings l JOIN products p ON (p.tenant_id,p.id)=(l.tenant_id,l.product_id) WHERE l.channel_id=$1 AND l.external_id IS NOT NULL AND p.kind<>'group' AND ($2::uuid IS NULL OR l.id>$2) ORDER BY l.id LIMIT $3`,
            [ch.id, job.payload.after ?? null, OFFER_SYNC_BATCH + 1],
          )
        ).rows;
      },
      true,
    ))
  ) {
    await cancelJob(job);
    return;
  }
  const stats = { ...job.payload.stats };
  let after = job.payload.after ?? null;
  for (const listing of rows.slice(0, OFFER_SYNC_BATCH)) {
    if (!(await guarded(job, async () => {}, true))) {
      await cancelJob(job);
      return;
    }
    try {
      const input = offerInput.parse({
        operation: 'sync',
        listing_id: listing.id,
        product_id: listing.product_id,
        warehouse_id: cfg.warehouse_id,
        stock: cfg.stock,
        price: cfg.price,
        ...(listing.parent_external_id ? { parent_external_id: listing.parent_external_id } : {}),
        ...(cfg.price_list_id ? { price_list_id: cfg.price_list_id } : {}),
      });
      const local = await tenantTx(job.tenant_id, (c) => desiredOffer(c, actor, input));
      const wanted = createHash('sha256')
        .update(
          JSON.stringify({
            version: cfg.version,
            external_id: listing.external_id,
            parent: listing.parent_external_id,
            quantity: cfg.stock ? local.quantity : undefined,
            price: cfg.price ? local.p.price : undefined,
            currency: cfg.price ? local.snapshot.currency : undefined,
            vat: cfg.price ? local.p.vat : undefined,
          }),
        )
        .digest('hex');
      const result = await tenantTx(job.tenant_id, async (c) => {
        const item = (
          await c.query('SELECT * FROM offer_sync_items WHERE channel_id=$1 AND listing_id=$2', [
            ch.id,
            listing.id,
          ])
        ).rows[0];
        const plan = item?.plan_id
          ? (await c.query('SELECT * FROM offer_plans WHERE id=$1', [item.plan_id])).rows[0]
          : null;
        const active = (
          await c.query(
            "SELECT id,state,phase FROM offer_plans WHERE channel_id=$1 AND product_id=$2 AND (state='queued' OR (state='failed' AND phase IN ('write_started','verify'))) ORDER BY created_at DESC LIMIT 1",
            [ch.id, listing.product_id],
          )
        ).rows[0];
        return { item, plan, active };
      });
      if (result.active) {
        if (
          !(await guarded(job, (c, current) =>
            saveItem(c, current, listing.id, {
              state: result.active.state === 'failed' ? 'blocked' : 'waiting',
              plan_id: result.active.id,
              error:
                result.active.state === 'failed'
                  ? 'Niepewny zapis wymaga uzgodnienia w planach ofert'
                  : 'Dla produktu trwa już zapis',
            }),
          ))
        ) {
          await cancelJob(job);
          return;
        }
        stats.waiting++;
      } else {
        let item = result.item;
        if (result.plan?.state === 'done' && !item.plan_acknowledged) {
          const valid =
            result.plan.sync_version === cfg.version &&
            item.desired_hash === wanted &&
            result.plan.result?.desired_applied &&
            !result.plan.result?.local_changed;
          if (
            !(await guarded(job, (c, current) =>
              saveItem(c, current, listing.id, {
                plan_acknowledged: true,
                ...(valid
                  ? {
                      verified_hash: wanted,
                      last_checked_at: new Date(),
                      state: 'verified',
                      error: null,
                    }
                  : { verified_hash: null, last_checked_at: null }),
              }),
            ))
          ) {
            await cancelJob(job);
            return;
          }
          item = {
            ...item,
            plan_acknowledged: true,
            config_version: cfg.version,
            verified_hash: valid ? wanted : null,
            last_checked_at: valid ? new Date() : null,
            ...(valid ? { state: 'verified' } : {}),
          };
        }
        if (
          item?.config_version === cfg.version &&
          item.verified_hash === wanted &&
          item.last_checked_at &&
          Date.now() - new Date(item.last_checked_at).getTime() < cfg.verify_seconds * 1000
        ) {
          stats.skipped++;
        } else {
          const preview = await previewOffer(actor, ch.id, input, ctx, {
            version: cfg.version,
            job_id: job.id,
            lease_token: job.lease_token,
          });
          const before = ['woocommerce', 'prestashop', 'shopify', 'ebay', 'amazon'].includes(
            ch.provider,
          )
            ? preview.before
            : {
                sellingMode: { price: preview.before?.price },
                stock: preview.before?.stock,
                publication: { status: preview.before?.publication },
              };
          const unchanged = offerMatches(
            ch,
            { operation: 'sync', payload: preview.payload },
            before,
          );
          const saved = await guarded(job, async (c, current) => {
            const persisted = (
              await c.query('SELECT local_snapshot FROM offer_plans WHERE id=$1 FOR UPDATE', [
                preview.id,
              ])
            ).rows[0];
            ensure(
              offerSnapshotHash(persisted.local_snapshot) === offerSnapshotHash(local.snapshot),
              409,
              'Dane lokalne zmieniły się podczas przeglądu',
            );
            if (unchanged) {
              if (ch.provider === 'amazon')
                ensure(
                  (await c.query('SELECT amazon_offer_claim($1) claimed', [preview.id])).rows[0]
                    .claimed,
                  409,
                  'Dla regionalnego SKU Amazon istnieje oczekujący lub niepewny zapis',
                );
              const latest = await desiredOffer(c, actor, input);
              ensure(
                offerSnapshotHash(latest.snapshot) === offerSnapshotHash(persisted.local_snapshot),
                409,
                'Dane lokalne zmieniły się podczas potwierdzania',
              );
              await c.query('SELECT id FROM channels WHERE id=$1 FOR UPDATE', [ch.id]);
              ensure(
                !(
                  await c.query(
                    "SELECT id FROM offer_plans WHERE channel_id=$1 AND product_id=$2 AND (state='queued' OR (state='failed' AND phase IN ('write_started','verify')))",
                    [ch.id, listing.product_id],
                  )
                ).rowCount,
                409,
                'Dla produktu trwa już zapis',
              );
              const remoteStock = [
                'woocommerce',
                'prestashop',
                'shopify',
                'ebay',
                'amazon',
              ].includes(ch.provider)
                ? preview.before?.stock_quantity
                : preview.before?.stock?.available;
              await c.query(
                "UPDATE offer_plans SET state='done',phase='done',completed_at=now(),result=$2 WHERE id=$1",
                [
                  preview.id,
                  JSON.stringify({
                    scope: ch.settings.simulation ? 'local_simulation' : 'external_api_verified',
                    unchanged: true,
                    ...(ch.provider === 'amazon'
                      ? {
                          actual_snapshot: preview.before,
                          price_scope: 'base_B2C',
                          stock_scope: 'regional_FBM_DEFAULT',
                          buyability_verified: false,
                        }
                      : {}),
                    desired_applied: true,
                    local_changed: false,
                    requested_payload: preview.payload,
                    verified_payload: preview.payload,
                  }),
                ],
              );
              await c.query(
                "UPDATE listings SET price=CASE WHEN $2 THEN $3 ELSE price END,price_currency=CASE WHEN $2 THEN $4 ELSE price_currency END,last_result=coalesce(last_result,'{}'::jsonb)||$5::jsonb WHERE id=$1",
                [
                  listing.id,
                  cfg.price,
                  local.p.price,
                  local.snapshot.currency,
                  JSON.stringify({
                    ...(ch.provider === 'amazon'
                      ? {
                          amazon_offer_snapshot: preview.before,
                          price_scope: 'base_B2C',
                          stock_scope: 'external_availability',
                        }
                      : {}),
                    ...(ch.provider === 'shopify' ? preview.before : {}),
                    ...(ch.provider === 'ebay'
                      ? {
                          ebay_offer_snapshot: preview.before,
                          inventory_quantity:
                            preview.before?.inventory?.availability?.shipToLocationAvailability
                              ?.quantity,
                          stock_scope: 'external_availability',
                        }
                      : {}),
                    ...(remoteStock === undefined || remoteStock === null
                      ? {}
                      : { stock_quantity: remoteStock }),
                    scope: ch.settings.simulation ? 'local_simulation' : 'external_api_verified',
                  }),
                ],
              );
              if (ch.provider === 'amazon')
                await c.query('SELECT amazon_offer_release($1)', [preview.id]);
              await saveItem(c, current, listing.id, {
                desired_hash: wanted,
                verified_hash: wanted,
                last_checked_at: new Date(),
                plan_id: preview.id,
                plan_acknowledged: true,
                state: 'unchanged',
                error: null,
              });
            } else {
              const queued=await queueOffer(c, actor, preview.id, current.external_authorized);
              await ctx.localWooStockQueued?.(c,job,queued);
              await saveItem(c, current, listing.id, {
                desired_hash: wanted,
                plan_id: preview.id,
                plan_acknowledged: false,
                state: 'queued',
                error: null,
              });
            }
          });
          if (!saved) {
            await cancelJob(job);
            return;
          }
          stats[unchanged ? 'unchanged' : 'queued']++;
        }
      }
    } catch (e) {
      if (allegroOAuthCommitRefusalDetails(e)) throw e;
      if (e instanceof EbayApiWait || e instanceof AmazonApiWait) throw e;
      const saved = await guarded(job, (c, current) =>
        saveItem(c, current, listing.id, { state: 'error', error: message(e) }),
      );
      if (!saved) {
        await cancelJob(job);
        return;
      }
      stats.errors++;
    }
    stats.checked++;
    after = listing.id;
  }
  const finished = await guarded(job, async (c, current) => {
    const more = rows.length > OFFER_SYNC_BATCH;
    await c.query(
      "UPDATE jobs SET state=$2,payload=$3,attempts=0,lease_token=NULL,locked_at=NULL,error=NULL,run_at=now()+interval '1 second' WHERE id=$1",
      [job.id, more ? 'pending' : 'done', JSON.stringify({ ...job.payload, after, stats })],
    );
    if (!more)
      await c.query(
        'UPDATE offer_sync_configs SET last_run_at=now(),error=NULL WHERE channel_id=$1 AND version=$2',
        [current.channel_id, current.version],
      );
  });
  if (!finished) await cancelJob(job);
}
async function cancelJob(job: any) {
  await tenantTx(job.tenant_id, async (c) => {
    if (await fenceSync(c, job))
      await c.query(
        "UPDATE jobs SET state='done',error='Harmonogram zatrzymano lub zmieniono',lease_token=NULL,locked_at=NULL WHERE id=$1",
        [job.id],
      );
  });
}
export async function failOfferSync(job: any, e: unknown) {
  if (await deferAmazonApiJob(job, e)) return;
  if (await deferEbayApiJob(job, e)) return;
  await tenantTx(job.tenant_id, async (c) => {
    await c.query('SELECT channel_id FROM offer_sync_configs WHERE channel_id=$1 FOR UPDATE', [
      job.payload.channel_id,
    ]);
    if (!(await fenceSync(c, job))) return;
    const terminal =
      (e instanceof Problem && [403, 409, 422].includes(e.status)) ||
      job.attempts >= job.max_attempts;
    await c.query(
      'UPDATE jobs SET state=$2,error=$3,lease_token=NULL,locked_at=NULL,run_at=now()+make_interval(secs=>least(300,power(2,attempts)::int)) WHERE id=$1',
      [job.id, terminal ? 'failed' : 'pending', message(e)],
    );
    await c.query(
      'UPDATE offer_sync_configs SET error=$3,enabled=CASE WHEN $4 THEN false ELSE enabled END WHERE channel_id=$1 AND version=$2',
      [
        job.payload.channel_id,
        job.payload.version,
        message(e),
        e instanceof Problem && e.status === 403,
      ],
    );
  });
}
