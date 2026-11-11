import type {FastifyInstance} from 'fastify';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {PoolClient} from 'pg';
import {tenantTx} from './db';
import {audit, type Actor} from './domain';
import {ensure, Problem} from './errors';
import {productDeletionsAvailable, productNotDeletedSQL} from './product-deletions';
import {encrypt} from './security';
import {offerInput, previewOffer, queueOffer, processOfferJob, failOffer} from './offers';
import type {IntegrationContext} from './channel-access';

// Source-owned, unconditional denial: no transport/evaluator callback comes from the caller.
// A changed channel cannot turn this specific exercise into an external provider call.
const localOnlyContext: IntegrationContext = Object.freeze({transport: async () => {
  throw new Problem(503, 'Zewnętrzny transport jest wyłączony dla lokalnej symulacji oferty');
}});
const bodySchema = z.strictObject({request_id: z.uuid(), warehouse_id: z.uuid()});
const paramsSchema = z.strictObject({id: z.uuid()});
const sourceMarker = 'scoped-woocommerce-offer/v1';

async function freshAdmin(c: PoolClient, actor: Actor) {
  ensure((await c.query('SELECT offer_sync_is_admin($1) AS ok', [actor.userId])).rows[0]?.ok === true,
    403, 'Wymagany aktualny administrator firmy');
}

// Only the fixed native channel-limit refusal is public; no arbitrary PostgreSQL text.
function localChannelQuotaFailure(error: unknown, phase: string, ids: (string | null)[]) {
  if (phase !== 'create-local-channel' || ids.some(id => id !== null)
    || !(error instanceof Error) || (error as Error & {code?: unknown}).code !== 'P0001') return null;
  const match = /^Limit planu: channels\. Wykorzystano (0|[1-9][0-9]{0,18}), limit (0|[1-9][0-9]{0,18})\.$/.exec(error.message);
  if (!match) return null;
  return {quota_code: 'WORKSPACE_CHANNEL_LIMIT' as const,
    detail: `Limit planu: połączenia. Wykorzystano ${match[1]}, limit ${match[2]}.`};
}

/** Draft product endpoint: must be registered by real buildApp after normal authentication.
 * Does not import worker.tick, schedule jobs or execute any supplied/pre-existing job ID.
 * Ordinary route lifetime drain must cover the entire returned handler promise.
 */
export function registerLocalSimulationOfferRoutes(app: FastifyInstance, options: {readOnly: boolean}) {
  const readOnly = options.readOnly;
  app.post('/api/products/:id/local-simulation-offer', async (req, reply) => {
    const input = bodySchema.parse(req.body), params = paramsSchema.parse(req.params);
    // Exact real req.actor retained; no body principal, role or startup/capability is accepted.
    const actor = req.actor;
    ensure(!readOnly, 423, 'Kopia jest tylko do odczytu');
    ensure(actor.role === 'admin' && !req.apiScopes, 403, 'Wymagana sesja administratora; API-key scope nie jest tu włączony');
    const requestId = input.request_id.toLowerCase(), productId = params.id.toLowerCase();
    const warehouseId = input.warehouse_id.toLowerCase();
    let channelId: string | null = null, planId: string | null = null, jobId: string | null = null;
    let claimedJob: any = null, phase = 'create-local-channel';
    try {
      channelId = await tenantTx(actor.tenantId, async c => {
        await freshAdmin(c, actor);
        await c.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [actor.tenantId]);
        // Refuse ambiguous delivery/reuse; never resume or repair a prior request here.
        ensure(!(await c.query("SELECT id FROM channels WHERE tenant_id=$1 AND settings->>'local_offer_request_id'=$2",
          [actor.tenantId, requestId])).rowCount, 409, 'Ten request ma już zapisany kanał; odczytaj wynik zamiast ponawiać');
        ensure((await c.query(`SELECT id FROM products WHERE tenant_id=$1 AND id=$2 AND ${productNotDeletedSQL(await productDeletionsAvailable(c), 'products')}`, [actor.tenantId, productId])).rowCount,
          404, 'Nie znaleziono własnego produktu');
        const id = randomUUID();
        await c.query(`INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings,status,sync_enabled)
          VALUES($1,$2,'woocommerce',$3,'sandbox',$4,$5,'simulation',false)`,
          [id, actor.tenantId, 'WooCommerce — lokalna symulacja ' + requestId, encrypt({}), JSON.stringify({
            simulation: true, local_offer_source: sourceMarker, local_offer_request_id: requestId,
            local_offer_actor_id: actor.userId,
          })]);
        await audit(c, actor, 'integration.woocommerce.scoped_simulation', id, {request_id: requestId, scope: 'local_simulation'});
        return id;
      });
      phase = 'preview-own-offer';
      const preview = await previewOffer(actor, channelId, offerInput.parse({product_id: productId,
        warehouse_id: warehouseId, operation: 'create_draft'}), localOnlyContext);
      planId = preview.id;
      ensure(preview.scope === 'local_simulation' && preview.state === 'preview', 409, 'Podgląd nie jest lokalną symulacją');
      phase = 'queue-and-claim-only-new-job';
      claimedJob = await tenantTx(actor.tenantId, async c => {
        await freshAdmin(c, actor);
        // Literal queueOffer writer order: catalogue shared lock -> plan row -> channel row.
        await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', ['catalog:' + actor.tenantId]);
        const ownPlan = (await c.query(`SELECT actor_id,channel_id,product_id,warehouse_id,operation,state,job_id
          FROM offer_plans WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [actor.tenantId, planId])).rows[0];
        ensure(ownPlan?.actor_id === actor.userId && ownPlan.channel_id === channelId
          && ownPlan.product_id === productId && ownPlan.warehouse_id === warehouseId
          && ownPlan.operation === 'create_draft' && ownPlan.state === 'preview' && ownPlan.job_id === null,
          409, 'Wyłącznie nowy własny podgląd bez wcześniej utworzonego zadania');
        const channel = (await c.query('SELECT provider,mode,settings,sync_enabled FROM channels WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
          [actor.tenantId, channelId])).rows[0];
        ensure(channel?.provider === 'woocommerce' && channel.mode === 'sandbox' && channel.settings.simulation === true
          && channel.settings.local_offer_source === sourceMarker && channel.settings.local_offer_request_id === requestId
          && channel.settings.local_offer_actor_id === actor.userId && channel.sync_enabled === false,
          409, 'Własny kanał symulacji zmienił się');
        const queued = await queueOffer(c, actor, planId!, false);
        jobId = queued.job_id;
        const job = (await c.query('SELECT * FROM jobs WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
          [actor.tenantId, jobId])).rows[0];
        ensure(job?.kind === 'offer.write' && job.state === 'pending' && Number(job.attempts) === 0
          && job.lease_token === null && job.payload.plan_id === planId && job.payload.channel_id === channelId
          && job.payload.actor_id === actor.userId && Object.keys(job.payload).sort().join(',') === 'actor_id,channel_id,plan_id',
          409, 'Dozwolone jest wyłącznie to nowe, własne i jeszcze nieuruchomione zadanie');
        const claimed = (await c.query(`UPDATE jobs SET state='running',attempts=1,max_attempts=1,
          locked_at=now(),lease_token=$3,provider_wait_until=NULL,provider_wait_reason=NULL
          WHERE tenant_id=$1 AND id=$2 AND kind='offer.write' AND state='pending' AND attempts=0
          RETURNING *`, [actor.tenantId, jobId, randomUUID()])).rows[0];
        ensure(claimed, 409, 'Dzierżawa własnego zadania nie została przyznana');
        // INSERT/queue/lease COMMIT together; the general worker cannot claim a pending window.
        return claimed;
      });
      phase = 'actual-existing-offer-job';
      await processOfferJob(claimedJob, localOnlyContext);
      phase = 'actual-local-plan-job-listing-readback';
      const result = await tenantTx(actor.tenantId, async c => {
        await freshAdmin(c, actor);
        const plan = (await c.query('SELECT state,phase,result,listing_id,remote_id FROM offer_plans WHERE tenant_id=$1 AND id=$2',
          [actor.tenantId, planId])).rows[0];
        const job = (await c.query('SELECT state,attempts,max_attempts,lease_token FROM jobs WHERE tenant_id=$1 AND id=$2',
          [actor.tenantId, jobId])).rows[0];
        const listing = (await c.query(`SELECT id,channel_id,product_id,external_id,status,warehouse_id,price,price_currency
          FROM listings WHERE tenant_id=$1 AND id=$2`, [actor.tenantId, plan?.listing_id])).rows[0];
        ensure(plan?.state === 'done' && plan.phase === 'done' && plan.result?.scope === 'local_simulation'
          && plan.result.desired_applied === true && job?.state === 'done' && Number(job.attempts) === 1
          && Number(job.max_attempts) === 1 && job.lease_token === null
          && listing?.channel_id === channelId && listing.product_id === productId && listing.warehouse_id === warehouseId
          && listing.status === 'simulation' && listing.external_id === 'DEMO-' + planId
          && plan.remote_id === listing.external_id, 409, 'Nie potwierdzono dokładnego wyniku lokalnej oferty');
        return listing;
      });
      return reply.code(201).send({status: 'OWNED_WOO_LOCAL_SIMULATION_OFFER_DONE', scope: 'local_simulation',
        request_id: requestId, channel_id: channelId, plan_id: planId, job_id: jobId, listing: result,
        provider_verified: false, preexisting_jobs_executed: false});
    } catch (firstError) {
      let failureClose: 'NOT_CLAIMED' | 'ATTEMPTED' | 'FAILED' = 'NOT_CLAIMED';
      if (claimedJob) {
        try { await failOffer(claimedJob, firstError); failureClose = 'ATTEMPTED'; }
        catch { failureClose = 'FAILED'; }
      }
      // Preserve the first failure and committed IDs. A readback/late-IAM failure can follow real completion.
      // failOffer uses the original lease fence; max_attempts=1 prevents automatic requeue for this Woo job.
      const quota = localChannelQuotaFailure(firstError, phase, [channelId, planId, jobId]);
      return reply.code(quota ? 409 : firstError instanceof Problem ? firstError.status : 500).send({
        status: 'OWNED_WOO_LOCAL_SIMULATION_OFFER_FAILED', phase, request_id: requestId,
        channel_id: channelId, plan_id: planId, job_id: jobId, effects_unknown: true,
        first_error_kind: firstError instanceof Error ? firstError.name : 'UnknownError',
        owned_failure_close: failureClose, automatic_retry: false, provider_verified: false,
        ...(quota ?? {}),
      });
    }
  });
}
