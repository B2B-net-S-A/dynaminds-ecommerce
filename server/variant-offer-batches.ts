import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { tenantTx } from './db';
import { audit, type Actor } from './domain';
import { ensure, Problem } from './errors';
import { productDeletionsAvailable, productNotDeletedSQL } from './product-deletions';
import { offerInput, previewOffer, queueOffer, offerSnapshotHash } from './offers';
import { connectionHash } from './offer-sync-policy';
import { systemActor } from './sync';
import { safeFetch } from './integrations';
import { withAllegroJobContext, type IntegrationContext } from './channel-access';
import { allegroOAuthCommitRefusalDetails } from './allegro-oauth-authority';
export const variantBatchInput = z.object({
  group_id: z.uuid(),
  warehouse_id: z.uuid(),
  price_list_id: z.uuid().optional(),
  parent_external_id: offerInput.shape.parent_external_id.unwrap(),
  operation: z.enum(['create_variant', 'publish']),
  client_key: z.uuid(),
});
export async function startVariantBatch(
  c: PoolClient,
  actor: Actor,
  channel: string,
  b: z.infer<typeof variantBatchInput>,
) {
  await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [
    'catalog:' + actor.tenantId,
  ]);
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `variant-batch:${channel}:${b.client_key}`,
  ]);
  const existing = (
    await c.query('SELECT * FROM variant_offer_batches WHERE channel_id=$1 AND client_key=$2', [
      channel,
      b.client_key,
    ])
  ).rows[0];
  const inputHash = offerSnapshotHash(b);
  if (existing) {
    ensure(
      existing.actor_id === actor.userId && existing.input_hash === inputHash,
      409,
      'Klucz operacji jest już użyty dla innych danych',
    );
    return existing;
  }
  const ch = (
    await c.query("SELECT * FROM channels WHERE id=$1 AND provider='woocommerce' FOR SHARE", [
      channel,
    ])
  ).rows[0];
  ensure(ch, 404, 'Nie znaleziono kanału WooCommerce');
  ensure(
    ch.settings.simulation || /^[1-9]\d{0,14}$/.test(b.parent_external_id),
    422,
    'Identyfikator rodzica musi być liczbą dodatnią',
  );
  // A deleted group or variant (225) is never offered.
  const deletions = await productDeletionsAvailable(c);
  ensure(
    (await c.query(`SELECT id FROM products WHERE id=$1 AND kind='group' AND ${productNotDeletedSQL(deletions, 'products')}`, [b.group_id])).rowCount,
    422,
    'Wybierz grupę wariantów',
  );
  ensure(
    (await c.query('SELECT id FROM warehouses WHERE id=$1', [b.warehouse_id])).rowCount,
    404,
    'Nie znaleziono magazynu',
  );
  const id = randomUUID(),
    job = randomUUID();
  await c.query(
    "INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key) VALUES($1,$2,'offer.variants',$3,$4)",
    [
      job,
      actor.tenantId,
      JSON.stringify({ batch_id: id, actor_id: actor.userId, channel_id: channel }),
      'variants:preview:' + id,
    ],
  );
  const row = (
    await c.query(
      `INSERT INTO variant_offer_batches(id,tenant_id,channel_id,group_id,actor_id,client_key,input_hash,connection_hash,input,job_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        id,
        actor.tenantId,
        channel,
        b.group_id,
        actor.userId,
        b.client_key,
        inputHash,
        connectionHash(ch),
        JSON.stringify(b),
        job,
      ],
    )
  ).rows[0];
  const added = await c.query(
    `INSERT INTO variant_offer_batch_items(id,tenant_id,batch_id,product_id) SELECT gen_random_uuid(),tenant_id,$2,id FROM products WHERE parent_id=$1 AND kind='variant' AND ${productNotDeletedSQL(deletions, 'products')}`,
    [b.group_id, id],
  );
  ensure(added.rowCount, 422, 'Grupa nie ma wariantów');
  await audit(c, actor, 'offer.variants.preview', id, {
    count: added.rowCount,
    operation: b.operation,
  });
  return row;
}
export async function approveVariantBatch(
  c: PoolClient,
  actor: Actor,
  id: string,
  version: number,
  external: boolean,
) {
  const b = (await c.query('SELECT * FROM variant_offer_batches WHERE id=$1 FOR UPDATE', [id]))
    .rows[0];
  ensure(b, 404, 'Nie znaleziono operacji wariantów');
  ensure(b.actor_id === actor.userId, 403, 'Operację może zatwierdzić jej autor');
  if (['queued', 'done', 'partial'].includes(b.state) && b.input.approved_version === version)
    return b;
  ensure(
    b.state === 'review' && b.version === version,
    409,
    'Podgląd zmienił się lub został już zatwierdzony',
  );
  const ch = (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [b.channel_id]))
    .rows[0];
  ensure(connectionHash(ch) === b.connection_hash, 409, 'Połączenie zmieniło się od podglądu');
  ensure(ch.settings.simulation || external, 422, 'Potwierdź zapis we wskazanym koncie sprzedaży');
  ensure(
    (
      await c.query(
        "SELECT 1 FROM variant_offer_batch_items WHERE batch_id=$1 AND state='preview' LIMIT 1",
        [id],
      )
    ).rowCount,
    422,
    'Brak poprawnych planów do zapisu',
  );
  ensure(
    !(
      await c.query(
        "SELECT 1 FROM variant_offer_batch_items i JOIN offer_plans p ON p.id=i.plan_id WHERE i.batch_id=$1 AND i.state='preview' AND (p.state<>'preview' OR p.created_at<now()-interval '30 minutes') LIMIT 1",
        [id],
      )
    ).rowCount,
    409,
    'Plany zmieniły się lub wygasły; przygotuj nową operację',
  );
  const job = await enqueue(c, actor, b, 'write');
  await c.query(
    "UPDATE variant_offer_batches SET state='queued',version=version+1,job_id=$2,input=input||jsonb_build_object('approved_version',$3::int),error=NULL,updated_at=now() WHERE id=$1",
    [id, job, version],
  );
  await audit(
    c,
    actor,
    b.kind === 'allegro_catalog' ? 'offer.allegro.batch.queue' : 'offer.variants.queue',
    id,
    { confirm_external: external },
  );
  return (await c.query('SELECT * FROM variant_offer_batches WHERE id=$1', [id])).rows[0];
}
async function enqueue(c: PoolClient, actor: Actor, b: any, stage: string) {
  const job = randomUUID();
  await c.query(
    "INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key) VALUES($1,$2,'offer.variants',$3,$4)",
    [
      job,
      actor.tenantId,
      JSON.stringify({ batch_id: b.id, actor_id: actor.userId, channel_id: b.channel_id }),
      `variants:${stage}:${b.id}:${job}`,
    ],
  );
  return job;
}
export async function variantBatchAction(
  c: PoolClient,
  actor: Actor,
  id: string,
  version: number,
  action: 'cancel' | 'retry' | 'recheck',
) {
  const b = (await c.query('SELECT * FROM variant_offer_batches WHERE id=$1 FOR UPDATE', [id]))
    .rows[0];
  ensure(b, 404, 'Nie znaleziono operacji wariantów');
  ensure(b.actor_id === actor.userId, 403, 'Operacją zarządza jej autor');
  ensure(b.version === version, 409, 'Operacja zmieniła się; odśwież widok');
  if (action === 'cancel') {
    ensure(
      ['preparing', 'review', 'queued', 'failed'].includes(b.state),
      409,
      'Operacja nie może być przerwana',
    );
    await c.query(
      "UPDATE jobs SET state='failed',lease_token=NULL,locked_at=NULL,error='Przerwano operację wariantów' WHERE id=$1 AND state IN ('running','pending')",
      [b.job_id],
    );
    await c.query(
      "UPDATE variant_offer_batch_items SET result=CASE WHEN $2 THEN coalesce(result,'{}'::jsonb)||jsonb_build_object('cancelled_state',state) ELSE result END,state='skipped',error='Przerwano przed zakolejkowaniem zapisu' WHERE batch_id=$1 AND state IN ('pending','preview')",
      [id, b.kind === 'allegro_catalog'],
    );
    await c.query(
      "UPDATE variant_offer_batches SET state='cancelled',version=version+1,updated_at=now() WHERE id=$1",
      [id],
    );
  } else {
    ensure(
      action === 'retry'
        ? b.state === 'failed' || (b.kind === 'allegro_catalog' && b.state === 'cancelled')
        : b.state === 'partial',
      409,
      'Operacja nie wymaga tej czynności',
    );
    const ch = (await c.query('SELECT * FROM channels WHERE id=$1', [b.channel_id])).rows[0];
    ensure(
      ch && connectionHash(ch) === b.connection_hash,
      409,
      'Przywróć pierwotne połączenie przed wznowieniem',
    );
    if (b.kind === 'allegro_catalog' && b.state === 'cancelled')
      await c.query(
        "UPDATE variant_offer_batch_items SET state=result->>'cancelled_state',result=result-'cancelled_state',error=NULL WHERE batch_id=$1 AND state='skipped' AND result->>'cancelled_state' IN ('pending','preview')",
        [id],
      );
    const pending = (
      await c.query(
        "SELECT 1 FROM variant_offer_batch_items WHERE batch_id=$1 AND state='pending' LIMIT 1",
        [id],
      )
    ).rowCount;
    // A failed/cancelled preparation must return to review, never implicitly approve writes.
    const state = pending || !b.input.approved_version ? 'preparing' : 'queued',
      job = await enqueue(c, actor, b, action);
    await c.query(
      'UPDATE variant_offer_batches SET state=$2,job_id=$3,version=version+1,error=NULL,updated_at=now() WHERE id=$1',
      [id, state, job],
    );
    if (action === 'recheck')
      await c.query(
        "UPDATE variant_offer_batch_items SET state='queued',error=NULL WHERE batch_id=$1 AND state='failed' AND plan_id IS NOT NULL",
        [id],
      );
  }
  await audit(
    c,
    actor,
    (b.kind === 'allegro_catalog' ? 'offer.allegro.batch.' : 'offer.variants.') + action,
    id,
    {},
  );
  return (await c.query('SELECT * FROM variant_offer_batches WHERE id=$1', [id])).rows[0];
}
// Batch -> job order is shared by cancellation and checkpoints. No HTTP in a transaction.
async function guard(c: PoolClient, job: any, policy = true) {
  const b = (
    await c.query('SELECT * FROM variant_offer_batches WHERE id=$1 FOR UPDATE', [
      job.payload.batch_id,
    ])
  ).rows[0];
  if (!b || b.job_id !== job.id || !['preparing', 'queued'].includes(b.state)) return null;
  if (
    !(
      await c.query(
        "UPDATE jobs SET locked_at=now() WHERE id=$1 AND lease_token=$2 AND state='running' RETURNING id",
        [job.id, job.lease_token],
      )
    ).rowCount
  )
    return null;
  if (policy) {
    ensure(
      (await c.query('SELECT offer_sync_is_admin($1) AS authorized', [b.actor_id])).rows[0]
        .authorized,
      403,
      'Autor utracił rolę administratora',
    );
    const ch = (await c.query('SELECT * FROM channels WHERE id=$1', [b.channel_id])).rows[0];
    ensure(
      ch && connectionHash(ch) === b.connection_hash,
      409,
      'Połączenie zmieniło się; operacja została zatrzymana',
    );
  }
  return b;
}
async function later(c: PoolClient, job: any, seconds = 0) {
  await c.query(
    "UPDATE jobs SET state='pending',attempts=0,lease_token=NULL,locked_at=NULL,run_at=now()+make_interval(secs=>$2) WHERE id=$1",
    [job.id, seconds],
  );
}
const error = (e: unknown) =>
  e instanceof Problem ? e.message : 'Nie udało się przygotować wariantu';
export async function processVariantBatch(job: any, ctx: IntegrationContext = {}) {
  ctx = withAllegroJobContext(ctx, job);
  const actor = await systemActor(job.tenant_id, job.payload.actor_id);
  const batch = await tenantTx(actor.tenantId, (c) => guard(c, job));
  if (!batch) return;
  if (batch.state === 'preparing') {
    const item = await tenantTx(
      actor.tenantId,
      async (c) =>
        (
          await c.query(
            "SELECT i.*,l.id AS listing_id,l.parent_external_id FROM variant_offer_batch_items i LEFT JOIN listings l ON l.product_id=i.product_id AND l.channel_id=$2 WHERE i.batch_id=$1 AND i.state='pending' ORDER BY i.id LIMIT 1",
            [batch.id, batch.channel_id],
          )
        ).rows[0],
    );
    if (!item) {
      await tenantTx(actor.tenantId, async (c) => {
        if (!(await guard(c, job))) return;
        await c.query(
          "UPDATE variant_offer_batches SET state='review',version=version+1,updated_at=now() WHERE id=$1",
          [batch.id],
        );
        await c.query(
          "UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL,error=NULL WHERE id=$1",
          [job.id],
        );
      });
      return;
    }
    let state = 'preview',
      plan: string | null = null,
      message: string | null = null,
      result: any = null;
    try {
      if (
        batch.kind === 'allegro_catalog' &&
        batch.input.operation === 'create_draft' &&
        item.listing_id
      ) {
        state = 'skipped';
        result = {
          reason: 'existing_mapping',
          scope: 'local_mapping',
          listing_id: item.listing_id,
        };
      } else if (batch.input.operation === 'create_variant' && item.listing_id) {
        ensure(
          item.parent_external_id === batch.input.parent_external_id,
          409,
          'Wariant jest powiązany z innym rodzicem',
        );
        state = 'skipped';
        result = {
          reason: 'existing_mapping',
          scope: 'local_mapping',
          listing_id: item.listing_id,
        };
      } else {
        ensure(
          batch.kind === 'allegro_catalog' ||
            batch.input.operation !== 'publish' ||
            (item.listing_id && item.parent_external_id === batch.input.parent_external_id),
          422,
          'Brak powiązanego wariantu pod wskazanym rodzicem',
        );
        const context: IntegrationContext = {
          ...ctx,
          transport: async (url, init) => {
            ensure(
              await tenantTx(actor.tenantId, (c) => guard(c, job)),
              409,
              'Przerwano podgląd wariantów',
            );
            return (ctx.transport ?? safeFetch)(url, init);
          },
        };
        const p = await previewOffer(
          actor,
          batch.channel_id,
          offerInput.parse({
            product_id: item.product_id,
            warehouse_id: batch.input.warehouse_id,
            operation: batch.input.operation,
            ...(batch.kind === 'allegro_catalog'
              ? batch.input.operation === 'create_draft'
                ? { allegro: item.creation_input }
                : { listing_id: item.creation_input.listing_id, price: false, stock: false }
              : { parent_external_id: batch.input.parent_external_id }),
            ...(batch.input.operation === 'publish' && batch.kind !== 'allegro_catalog'
              ? { listing_id: item.listing_id }
              : {}),
            ...(batch.input.price_list_id ? { price_list_id: batch.input.price_list_id } : {}),
          }),
          context,
        );
        plan = p.id;
      }
    } catch (e) {
      if (allegroOAuthCommitRefusalDetails(e)) throw e;
      state = 'failed';
      message = error(e);
    }
    await tenantTx(actor.tenantId, async (c) => {
      if (!(await guard(c, job))) return;
      await c.query(
        "UPDATE variant_offer_batch_items SET state=$2,plan_id=$3,error=$4,result=$5 WHERE id=$1 AND state='pending'",
        [item.id, state, plan, message, result ? JSON.stringify(result) : null],
      );
      await later(c, job);
    });
    return;
  }
  await tenantTx(actor.tenantId, async (c) => {
    // Take catalogue before batch/job so queueOffer shares the import lock order.
    await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [
      'catalog:' + actor.tenantId,
    ]);
    if (!(await guard(c, job))) return;
    const item = (
      await c.query(
        "SELECT * FROM variant_offer_batch_items WHERE batch_id=$1 AND state IN ('preview','queued') ORDER BY CASE state WHEN 'preview' THEN 0 ELSE 1 END,id LIMIT 1 FOR UPDATE",
        [batch.id],
      )
    ).rows[0];
    if (!item) {
      const failures = (
        await c.query(
          "SELECT 1 FROM variant_offer_batch_items WHERE batch_id=$1 AND state='failed' LIMIT 1",
          [batch.id],
        )
      ).rowCount;
      await c.query(
        'UPDATE variant_offer_batches SET state=$2,version=version+1,updated_at=now() WHERE id=$1',
        [batch.id, failures ? 'partial' : 'done'],
      );
      await c.query(
        "UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL,error=NULL WHERE id=$1",
        [job.id],
      );
      return;
    }
    if (item.state === 'preview') {
      // A savepoint lets one stale preview fail without losing other valid variants.
      await c.query('SAVEPOINT variant_queue');
      try {
        await queueOffer(c, actor, item.plan_id, true);
        await c.query("UPDATE variant_offer_batch_items SET state='queued' WHERE id=$1", [item.id]);
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT variant_queue');
        await c.query("UPDATE variant_offer_batch_items SET state='failed',error=$2 WHERE id=$1", [
          item.id,
          error(e),
        ]);
      }
      await c.query('RELEASE SAVEPOINT variant_queue');
      await later(c, job);
      return;
    }
    const plan = (
      await c.query('SELECT state,error,result FROM offer_plans WHERE id=$1', [item.plan_id])
    ).rows[0];
    if (plan.state === 'queued') {
      await later(c, job, 2);
      return;
    }
    await c.query('UPDATE variant_offer_batch_items SET state=$2,error=$3,result=$4 WHERE id=$1', [
      item.id,
      plan.state === 'done' && plan.result?.desired_applied ? 'done' : 'failed',
      plan.error ??
        (plan.state === 'done' && !plan.result?.desired_applied
          ? 'Uzgodniono odczyt; żądana zmiana nie jest potwierdzona'
          : null),
      plan.result ? JSON.stringify(plan.result) : null,
    ]);
    await later(c, job);
  });
}
export async function failVariantBatch(job: any, e: unknown) {
  await tenantTx(job.tenant_id, async (c) => {
    if (!(await guard(c, job, false))) return;
    const terminal =
      (e instanceof Problem && [403, 409, 422].includes(e.status)) ||
      job.attempts >= job.max_attempts;
    await c.query(
      'UPDATE jobs SET state=$2,error=$3,lease_token=NULL,locked_at=NULL,run_at=now()+make_interval(secs=>least(300,power(2,attempts)::int)) WHERE id=$1',
      [job.id, terminal ? 'failed' : 'pending', error(e)],
    );
    if (terminal)
      await c.query(
        "UPDATE variant_offer_batches SET state='failed',version=version+1,error=$2,updated_at=now() WHERE id=$1",
        [job.payload.batch_id, error(e)],
      );
  });
}
