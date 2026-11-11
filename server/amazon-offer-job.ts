import { amazonAccountPolicy } from './amazon-account';
import pg, { type PoolClient } from 'pg';
import { holdingDbLock, lockDbClient } from './db-lock-holder';
import { z } from 'zod';
import { pool, tenantTx } from './db';
import { audit, type Actor } from './domain';
import { ensure, Problem } from './errors';
import { channelRead, type IntegrationContext } from './channel-access';
import { Amazon } from './amazon';
import { safeFetch } from './integrations';
import { desiredOffer, offerSnapshotHash } from './offers';
import { offerConnectionHash, requireSyncPolicy, syncPolicy } from './offer-sync-policy';
import {
  amazonOfferIdentity,
  requireAmazonWrite,
  readAmazonOffer,
  simulationAmazonOffer,
  simulationAmazonPatch,
  amazonOfferMatches,
  amazonPreserved,
  AmazonOfferWait,
} from './amazon-offers';

async function guard(c: PoolClient, job: any, actor: Actor, initial: any, write = false) {
  const header = (
    await c.query('SELECT sync_version FROM offer_plans WHERE id=$1', [job.payload.plan_id])
  ).rows[0];
  if (write && header?.sync_version)
    await requireSyncPolicy(c, initial.id, header.sync_version, actor.userId);
  ensure(
    (
      await c.query(
        "UPDATE jobs SET locked_at=now() WHERE id=$1 AND lease_token=$2 AND state='running' RETURNING id",
        [job.id, job.lease_token],
      )
    ).rowCount,
    409,
    'Dzierżawa zapisu Amazon wygasła',
  );
  await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [
    'catalog:' + actor.tenantId,
  ]);
  const ch = (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [initial.id])).rows[0];
  const plan = (
    await c.query('SELECT * FROM offer_plans WHERE id=$1 FOR UPDATE', [job.payload.plan_id])
  ).rows[0];
  ensure(
    plan?.state === 'queued' &&
      plan.job_id === job.id &&
      plan.actor_id === actor.userId &&
      plan.channel_id === initial.id,
    409,
    'Plan Amazon nie jest aktywny',
  );
  await amazonAccountPolicy(c, ch);
  ensure(
    ch && plan.input.amazon_identity_hash === amazonOfferIdentity(ch),
    409,
    'Konto lub dane dostępu Amazon zmieniły się; przywróć pierwotne połączenie przed uzgodnieniem',
  );
  ensure(
    (await c.query('SELECT offer_sync_is_admin($1) authorized', [actor.userId])).rows[0].authorized,
    403,
    'Autor utracił rolę administratora',
  );
  const listing = (await c.query('SELECT * FROM listings WHERE id=$1 FOR SHARE', [plan.listing_id]))
    .rows[0];
  ensure(
    listing &&
      listing.channel_id === ch.id &&
      listing.product_id === plan.product_id &&
      listing.external_id === plan.remote_id,
    409,
    'Powiązanie Amazon zmieniło się; przywróć je przed uzgodnieniem',
  );
  ensure(
    (await c.query('SELECT amazon_offer_claim($1) claimed', [plan.id])).rows[0].claimed,
    409,
    'Regionalne SKU Amazon ma inny oczekujący lub niepewny zapis',
  );
  if (write) {
    requireAmazonWrite(ch);
    ensure(
      plan.phase === 'ready',
      409,
      'Amazon: zapis już rozpoczęty; dozwolony jest tylko odczyt wyniku',
    );
    ensure(
      plan.input.sync_connection_hash === offerConnectionHash(ch),
      409,
      'Konfiguracja Amazon zmieniła się przed zapisem',
    );
    if (plan.sync_version) await requireSyncPolicy(c, ch.id, plan.sync_version, actor.userId);
    const local = await desiredOffer(c, actor, plan.input, true);
    ensure(
      offerSnapshotHash(local.snapshot) === offerSnapshotHash(plan.local_snapshot),
      409,
      'Cena lub stan lokalny zmieniły się; przygotuj nowy plan',
    );
  }
  return { plan, ch, listing };
}
export async function processAmazonOfferJob(
  job: any,
  actor: Actor,
  ch: any,
  ctx: IntegrationContext = {},
) {
  let start = await tenantTx(actor.tenantId, (c) => guard(c, job, actor, ch));
  const key = await tenantTx(
    actor.tenantId,
    async (c) =>
      (await c.query('SELECT amazon_offer_scope($1) scope', [start.plan.id])).rows[0].scope,
  );
  const lock = lockDbClient(new pg.Client({ connectionString: pool.options.connectionString }), 'amazon-offer-job');
  await lock.connect();
  try {
    return await holdingDbLock(lock, async () => {
    // Session lock spans network IO; quota and tenant transactions never do.
    ensure(
      (
        await lock.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) locked', [
          'amazon-write:' + key,
        ])
      ).rows[0].locked,
      409,
      'Dla regionalnego SKU Amazon trwa uzgadnianie',
    );
    start = await tenantTx(actor.tenantId, (c) => guard(c, job, actor, ch));
    let plan = start.plan;
    const fence = () =>
      tenantTx(actor.tenantId, async (c) => {
        await guard(c, job, actor, ch);
      });
    const checkpoint = () =>
      tenantTx(actor.tenantId, async (c) => {
        const current = await guard(c, job, actor, ch, true);
        await c.query(
          "UPDATE offer_plans SET phase='write_started',result=coalesce(result,'{}'::jsonb)||jsonb_build_object('write_started_at',clock_timestamp()) WHERE id=$1",
          [current.plan.id],
        );
      });
    let actual: any;
    const invoke = async (client?: Amazon) => {
      const read = () =>
        client
          ? readAmazonOffer(client, plan.remote_id, plan.input.stock, fence)
          : Promise.resolve(simulationAmazonOffer(ch, start.listing));
      if (plan.phase === 'ready') {
        await tenantTx(actor.tenantId, async (c) => {
          await guard(c, job, actor, ch, true);
        });
        const before = await read();
        ensure(
          offerSnapshotHash(before) === offerSnapshotHash(plan.remote_snapshot),
          409,
          'Oferta Amazon zmieniła się od podglądu; przygotuj nowy plan',
        );
        if (!amazonOfferMatches(before, plan.payload)) {
          if (client) {
            await client.token(fence);
            // The controlled transport consumes the PATCH permit before invoking checkpoint.
            const ack = await client.patchListing(plan.remote_id, plan.payload, fence);
            const parsed = z
              .object({
                sku: z.string(),
                status: z.enum(['ACCEPTED', 'INVALID']),
                submissionId: z.string().min(1).max(200),
                issues: z
                  .array(
                    z
                      .object({ code: z.string(), message: z.string(), severity: z.string() })
                      .passthrough(),
                  )
                  .max(1000)
                  .default([]),
              })
              .safeParse(ack);
            ensure(
              parsed.success && parsed.data.sku === plan.remote_id,
              502,
              'Nieprawidłowe potwierdzenie PATCH Amazon; wynik wymaga odczytu',
            );
            if (parsed.data.status === 'INVALID') {
              await tenantTx(actor.tenantId, async (c) => {
                await guard(c, job, actor, ch);
                await c.query(
                  "UPDATE offer_plans SET state='failed',phase='ready',error='Amazon odrzucił zmianę',result=coalesce(result,'{}'::jsonb)||$2::jsonb WHERE id=$1",
                  [plan.id, JSON.stringify({ amazon_ack: 'INVALID', issues: parsed.data.issues })],
                );
                await c.query(
                  "UPDATE jobs SET state='failed',error='Amazon odrzucił zmianę',lease_token=NULL,locked_at=NULL WHERE id=$1",
                  [job.id],
                );
                await c.query('SELECT amazon_offer_release($1)', [plan.id]);
              });
              return;
            }
            await tenantTx(actor.tenantId, async (c) => {
              await guard(c, job, actor, ch);
              await c.query(
                "UPDATE offer_plans SET phase='verify',result=coalesce(result,'{}'::jsonb)||$2::jsonb WHERE id=$1",
                [
                  plan.id,
                  JSON.stringify({
                    submission_id: parsed.data.submissionId,
                    amazon_ack: 'ACCEPTED',
                    submission_issues: parsed.data.issues,
                  }),
                ],
              );
            });
          } else {
            await checkpoint();
            actual = simulationAmazonPatch(before, plan.payload);
            // Persist the simulated remote response independently of job finalization so lease loss can reconcile it.
            await tenantTx(actor.tenantId, async (c) => {
              await guard(c, job, actor, ch);
              await c.query(
                "UPDATE listings SET last_result=coalesce(last_result,'{}'::jsonb)||jsonb_build_object('amazon_offer_snapshot',$2::jsonb) WHERE id=$1",
                [plan.listing_id, JSON.stringify(actual)],
              );
              await c.query(
                "UPDATE offer_plans SET phase='verify',result=coalesce(result,'{}'::jsonb)||jsonb_build_object('amazon_ack','ACCEPTED','submission_id','DEMO-'||id::text) WHERE id=$1",
                [plan.id],
              );
            });
          }
        } else actual = before;
      }
      if (!actual) actual = await read();
      const desired = amazonOfferMatches(actual, plan.payload);
      const preserved =
        amazonPreserved(actual, plan.payload) ===
        amazonPreserved(plan.remote_snapshot, plan.payload);
      if ((!desired || !preserved) && !job.payload.accept_observed) {
        const current = await tenantTx(actor.tenantId, (c) => guard(c, job, actor, ch));
        plan = current.plan;
        const since = Date.parse(plan.result?.write_started_at ?? plan.created_at);
        if (Date.now() - since > 3600000 || !preserved)
          throw new Problem(
            409,
            !preserved
              ? 'Pozostałe atrybuty Amazon zmieniły się podczas przetwarzania; uzgodnij wynik bez ponawiania zapisu'
              : 'Amazon nie potwierdził całej zmiany w ciągu godziny; uzgodnij wynik bez ponawiania zapisu',
          );
        throw new AmazonOfferWait(new Date(Date.now() + 30000).toISOString());
      }
      await tenantTx(actor.tenantId, async (c) => {
        const current = await guard(c, job, actor, ch);
        const local = await desiredOffer(c, actor, current.plan.input, true);
        const changed =
          offerSnapshotHash(local.snapshot) !== offerSnapshotHash(current.plan.local_snapshot);
        const active = current.plan.sync_version
          ? await syncPolicy(c, ch.id, current.plan.sync_version, actor.userId)
          : true;
        const result = {
          scope: ch.settings.simulation
            ? 'local_simulation'
            : desired && preserved
              ? 'external_api_verified'
              : 'external_api_observed',
          desired_applied: desired && preserved,
          local_changed: changed,
          automatic_paused: !active,
          actual_snapshot: actual,
          requested_payload: plan.payload,
          verified_payload: desired && preserved ? plan.payload : null,
          price_scope: 'base_B2C',
          stock_scope: 'regional_FBM_DEFAULT',
          buyability_verified: false,
          unchanged: current.plan.phase === 'ready',
          ...current.plan.result,
        };
        await c.query(
          "UPDATE listings SET price=CASE WHEN $2 THEN $3 ELSE price END,price_currency=CASE WHEN $2 THEN $4 ELSE price_currency END,warehouse_id=$5,status='synced',last_result=coalesce(last_result,'{}'::jsonb)||$6::jsonb WHERE id=$1",
          [
            plan.listing_id,
            plan.input.price,
            actual.base_price_minor,
            actual.currency,
            plan.warehouse_id,
            JSON.stringify({
              amazon_offer_snapshot: actual,
              stock_quantity: actual.stock_quantity,
              scope: result.scope,
              price_scope: result.price_scope,
            }),
          ],
        );
        await c.query(
          "UPDATE offer_plans SET state='done',phase='done',completed_at=now(),error=NULL,result=$2 WHERE id=$1",
          [plan.id, JSON.stringify(result)],
        );
        await c.query(
          "UPDATE jobs SET state='done',error=NULL,lease_token=NULL,locked_at=NULL,provider_wait_until=NULL,provider_wait_reason=NULL WHERE id=$1",
          [job.id],
        );
        await c.query('SELECT amazon_offer_release($1)', [plan.id]);
        await audit(c, actor, 'offer.amazon.verified', plan.id, {
          scope: result.scope,
          base_price_minor: actual.base_price_minor,
          current_b2c_price_minor: actual.current_b2c_price_minor,
          regional_markets: actual.regional_markets,
          stock_quantity: actual.stock_quantity,
          local_changed: changed,
          automatic_paused: !active,
        });
      });
    };
    if (ch.settings.simulation) await invoke();
    else
      await channelRead(
        actor.tenantId,
        ch.id,
        async (client) => {
          ensure(client instanceof Amazon, 422, 'Wymagany kanał Amazon');
          await invoke(client);
        },
        {
          ...ctx,
          transport: async (url, init) => {
            if (init.method === 'PATCH') {
              await checkpoint();
            } else await fence();
            return (ctx.transport ?? safeFetch)(url, init);
          },
        },
        false,
        async () => {
          await fence();
        },
      );
    });
  } finally {
    await lock.end();
  }
}
export async function deferAmazonOfferWait(job: any, error: unknown) {
  if (!(error instanceof AmazonOfferWait)) return false;
  return Boolean(
    (
      await pool.query(
        "UPDATE jobs SET state='pending',attempts=GREATEST(0,attempts-1),run_at=$3,provider_wait_until=$3,provider_wait_reason='amazon.listing.processing',error=$4,lease_token=NULL,locked_at=NULL WHERE id=$1 AND lease_token=$2 AND state='running'",
        [job.id, job.lease_token, error.until, error.message],
      )
    ).rowCount,
  );
}
