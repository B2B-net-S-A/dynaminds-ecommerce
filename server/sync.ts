import { shopifyAccountPolicy } from './shopify-oauth';
import { shopifyCredentialIdentity } from './shopify-auth-input';
import { amazonAccountPolicy } from './amazon-account';
import { amazonSyncPayload, processAmazonSync } from './amazon-order-sync';
import { ebaySyncPayload, processEbaySync } from './ebay-order-sync';
import { odooSyncPayload, processOdooSync } from './odoo-order-sync';
import { randomUUID, createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool, tenantTx } from './db';
import { ensure } from './errors';
import { stageOrders, acquireOrderFieldObservationAdmissionInTx } from './imports';
import { type Actor, audit } from './domain';
import { channelRead, loadChannel, withAllegroJobContext, type IntegrationContext } from './channel-access';
import { Shopify, type ShopifyWindow } from './shopify';
import { Allegro, WooCommerce, PrestaShop } from './integrations';
export async function systemActor(tenantId: string, userId: string): Promise<Actor> {
  const membership = (
    await pool.query('SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2', [
      tenantId,
      userId,
    ])
  ).rows[0];
  ensure(
    membership?.role === 'admin',
    403,
    'Administrator konfigurujący synchronizację nie ma już wymaganych uprawnień',
  );
  return { tenantId, userId, role: 'admin' };
}
const shopifyConnectionHash = (ch: any) =>
  createHash('sha256')
    .update(
      JSON.stringify({
        provider: ch.provider,
        mode: ch.mode,
        settings: ch.settings,
        credentials: shopifyCredentialIdentity(ch),
      }),
    )
    .digest('hex');
async function shopifyPolicy(c: PoolClient, job: any, lock = false) {
  const ch = (
    await c.query('SELECT * FROM channels WHERE id=$1' + (lock ? ' FOR SHARE' : ''), [
      job.payload.channel_id,
    ])
  ).rows[0];
  const current = (
    await c.query(
      "SELECT id FROM jobs WHERE id=$1 AND lease_token=$2 AND state='running'" +
        (lock ? ' FOR UPDATE' : ''),
      [job.id, job.lease_token],
    )
  ).rows[0];
  if (!current) return false;
  const authorized = (await c.query('SELECT offer_sync_is_admin($1) AS ok', [job.payload.actor_id]))
    .rows[0]?.ok;
  if (
    !ch ||
    !authorized ||
    (job.payload.shopify_policy.require_enabled && !ch.sync_enabled) ||
    job.payload.shopify_policy.connection_hash !== shopifyConnectionHash(ch)
  ) {
    await c.query(
      "UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL,error='Odczyt Shopify zatrzymano po zmianie konfiguracji, pauzie lub zmianie roli' WHERE id=$1",
      [job.id],
    );
    return false;
  }
  return true;
}
export async function enqueueSync(c: PoolClient, actor: Actor, id: string) {
  const ch = (await c.query('SELECT * FROM channels WHERE id=$1 FOR UPDATE', [id])).rows[0];
  ensure(
    ch &&
      ['allegro', 'woocommerce', 'prestashop', 'shopify', 'odoo', 'ebay', 'amazon'].includes(
        ch.provider,
      ),
    422,
    'Wymagany kanał sprzedaży obsługujący import',
  );
  if (ch.provider === 'amazon') await amazonAccountPolicy(c, ch);
  if (ch.provider === 'shopify') await shopifyAccountPolicy(c, ch);
  ensure(!ch.settings.simulation, 422, 'Lokalny przykład nie korzysta z API dostawcy');
  const existing = (
    await c.query(
      "SELECT id FROM jobs WHERE kind='orders.sync' AND state IN ('pending','running') AND payload->>'channel_id'=$1",
      [id],
    )
  ).rows[0];
  await c.query(
    'UPDATE channels SET next_sync_at=now()+make_interval(secs=>sync_interval) WHERE id=$1',
    [id],
  );
  if (existing) return { id: existing.id, reused: true };
  const jobId = randomUUID(),
    phase = ch.provider === 'allegro' && ch.bootstrap_done ? 'events' : 'bootstrap';
  await c.query(
    "INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key) VALUES($1,$2,'orders.sync',$3,$4)",
    [
      jobId,
      actor.tenantId,
      JSON.stringify({
        channel_id: id,
        actor_id: actor.userId,
        page: 1,
        phase,
        ...(ch.provider === 'odoo' ? odooSyncPayload(ch) : {}),
        ...(ch.provider === 'ebay' ? ebaySyncPayload(ch) : {}),
        ...(ch.provider === 'amazon' ? amazonSyncPayload(ch) : {}),
        ...(ch.provider === 'shopify'
          ? {
              shopify_window: {
                from:
                  ch.bootstrap_done && ch.event_cursor
                    ? new Date(Date.parse(ch.event_cursor) - 600000).toISOString()
                    : null,
                to: new Date(Date.now() - 5000).toISOString(),
                after: null,
                seen: [],
              },
              shopify_policy: {
                connection_hash: shopifyConnectionHash(ch),
                require_enabled: ch.sync_enabled,
              },
            }
          : {}),
      }),
      `sync:${id}:${jobId}`,
    ],
  );
  await audit(c, actor, 'integration.sync.enqueue', id, { job_id: jobId });
  return { id: jobId, reused: false };
}
export async function scheduleDue() {
  const due = (
    await pool.query(
      'SELECT id,tenant_id,sync_actor_id FROM channels WHERE sync_enabled AND (next_sync_at IS NULL OR next_sync_at<=now()) ORDER BY next_sync_at NULLS FIRST LIMIT 20',
    )
  ).rows;
  for (const ch of due) {
    try {
      const actor = await systemActor(ch.tenant_id, ch.sync_actor_id);
      await tenantTx(ch.tenant_id, async (c) => {
        const current = (
          await c.query('SELECT sync_enabled,next_sync_at FROM channels WHERE id=$1 FOR UPDATE', [
            ch.id,
          ])
        ).rows[0];
        if (
          !current?.sync_enabled ||
          (current.next_sync_at && new Date(current.next_sync_at).getTime() > Date.now())
        )
          return;
        await enqueueSync(c, actor, ch.id);
      });
    } catch (e) {
      if (e instanceof Error && 'status' in e && e.status === 403)
        await tenantTx(ch.tenant_id, (c) =>
          c.query(
            "UPDATE channels SET sync_enabled=false,status='sync_configuration_error' WHERE id=$1",
            [ch.id],
          ),
        );
      else throw e;
    }
  }
}
/** Only a construction-owned local read lane supplies this final transaction fence.
 * It runs before job/staging locks; no caller or HTTP payload selects the policy. */
export type LocalWooReadLaneStageContext = IntegrationContext & {
  localWooReadLaneBeforeStage?: (c: PoolClient, job: any) => Promise<void>;
  localWooReadLaneAfterStage?: (c:PoolClient,job:any,created:readonly {id:string;state:string;source_hash:string}[])=>Promise<void>;
};
export async function processIntegrationJob(job: any, ctx: LocalWooReadLaneStageContext = {}) {
  ctx = withAllegroJobContext(ctx, job);
  const actor = await systemActor(job.tenant_id, job.payload.actor_id);
  const ch = await loadChannel(job.tenant_id, job.payload.channel_id);
  if (ch.provider === 'amazon' && job.kind === 'orders.sync')
    return processAmazonSync(job, actor, ch, ctx);
  if (ch.provider === 'ebay' && job.kind === 'orders.sync')
    return processEbaySync(job, actor, ch, ctx);
  if (ch.provider === 'odoo' && job.kind === 'orders.sync')
    return processOdooSync(job, actor, ch, ctx);
  if (job.kind === 'webhook.stage') {
    const delivery = await tenantTx(
      job.tenant_id,
      async (c) =>
        (await c.query('SELECT * FROM webhook_deliveries WHERE id=$1', [job.payload.delivery_id]))
          .rows[0],
    );
    ensure(delivery && delivery.channel_id === ch.id, 422, 'Brak dostarczonego webhooka');
    const latest = ch.settings.simulation
      ? delivery.payload
      : await channelRead(
          actor.tenantId,
          ch.id,
          (client) => (client as WooCommerce).order(delivery.payload.id),
          ctx,
        );
    await tenantTx(job.tenant_id, async (c) => {
      const current = (
        await c.query(
          "SELECT id FROM jobs WHERE id=$1 AND lease_token=$2 AND state='running' FOR UPDATE",
          [job.id, job.lease_token],
        )
      ).rows[0];
      if (!current) return;
      await stageOrders(c, actor, ch, [latest]);
      await c.query(
        "UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL,error=NULL WHERE id=$1",
        [job.id],
      );
      await audit(c, actor, 'webhook.processed', delivery.id, { channel_id: ch.id });
    });
    return;
  }
  let localPagination:import('./local-woo-orders-read').LocalWooOrdersRead['pagination']|undefined;
  let rows: any[] = [],
    more = false,
    nextPhase = job.payload.phase,
    cursor = ch.event_cursor,
    prestaAfter = job.payload.prestashop_after,
    shopifyWindow = job.payload.shopify_window;
  if (
    ch.provider === 'allegro' &&
    job.payload.phase === 'bootstrap' &&
    job.payload.page === 1 &&
    !ch.event_cursor
  ) {
    const stats = await channelRead(
      actor.tenantId,
      ch.id,
      (client) => (client as Allegro).eventStats(),
      ctx,
    );
    cursor = stats.latestEvent?.id ?? null;
  }
  if (ch.provider === 'shopify') {
    ensure(shopifyWindow && job.payload.shopify_policy, 422, 'Brak checkpointu Shopify');
    if (!(await tenantTx(job.tenant_id, (c) => shopifyPolicy(c, job, true)))) return;
    const result = await channelRead(
      actor.tenantId,
      ch.id,
      (client) =>
        (client as Shopify).orders(
          shopifyWindow.after,
          shopifyWindow as ShopifyWindow,
          async () => {
            ensure(
              await tenantTx(job.tenant_id, (c) => shopifyPolicy(c, job, true)),
              409,
              'Zatrzymano odczyt Shopify',
            );
          },
        ),
      ctx,
    );
    rows = result.data;
    more = result.has_more;
    const seen = shopifyWindow.seen ?? [];
    ensure(
      !more ||
        (result.next_cursor && !seen.includes(result.next_cursor) && job.payload.page < 20000),
      502,
      'Brak postępu synchronizacji Shopify',
    );
    shopifyWindow = {
      ...shopifyWindow,
      after: result.next_cursor,
      seen: result.next_cursor ? [...seen, result.next_cursor].slice(-20) : seen,
    };
    if (!more) cursor = shopifyWindow.to;
  } else if (job.payload.phase === 'events') {
    const result = await channelRead<any>(
      actor.tenantId,
      ch.id,
      (client) => (client as Allegro).events(ch.event_cursor ?? undefined),
      ctx,
    );
    ensure(Array.isArray(result.events), 502, 'Nieprawidłowy dziennik zdarzeń Allegro');
    // A small batch bounds the lease duration. Duplicate events and checkout IDs are harmless.
    const ids = [
      ...new Set<string>(result.events.map((e: any) => String(e.order?.checkoutForm?.id ?? ''))),
    ];
    ensure(ids.every(Boolean), 502, 'Brak identyfikatora formularza w zdarzeniu Allegro');
    rows = await Promise.all(
      ids.map((id) =>
        channelRead(actor.tenantId, ch.id, (client) => (client as Allegro).order(id), ctx),
      ),
    );
    cursor = result.events.at(-1)?.id ?? ch.event_cursor;
    more = result.events.length > 0;
  } else {
    const result = await channelRead<{ data: any[]; has_more: boolean; next_id?: string; pagination?:import('./local-woo-orders-read').LocalWooOrdersRead['pagination'] }>(
      actor.tenantId,
      ch.id,
      (client) =>
        client instanceof PrestaShop
          ? client.orders(1, job.payload.prestashop_after ?? '0')
          : client instanceof WooCommerce
            ? ctx.localWooOrdersRead ? ctx.localWooOrdersRead(ch.id) : client.orders(job.payload.page)
            : (client as Allegro).orders((job.payload.page - 1) * 50),
      ctx,
    );
    rows = result.data;
    more = result.has_more;
    if(ch.provider==='woocommerce'&&ctx.localWooOrdersRead){ensure(job.payload.page===1&&result.pagination?.complete===true&&more===false,502,'Nie potwierdzono pełnego odczytu zamówień WooCommerce');localPagination=result.pagination;}
    if (ch.provider === 'prestashop') prestaAfter = result.next_id ?? prestaAfter;
    ensure(
      !more || job.payload.page < (ch.provider === 'prestashop' ? 20000 : 200),
      422,
      'Przekroczono limit początkowego odczytu. Wymagany import historyczny',
    );
    if (!more && ch.provider === 'allegro') {
      more = true;
      nextPhase = 'events';
    }
  }
  await tenantTx(job.tenant_id, async (c) => {
    // Keep the selected channel/control/occurrence/dispatch authorization and
    // staging in one transaction, before locking the job row.
    if (ch.provider === 'woocommerce') await ctx.localWooReadLaneBeforeStage?.(c, job);
    const current = (
      await c.query(
        "SELECT id FROM jobs WHERE id=$1 AND lease_token=$2 AND state='running' FOR UPDATE",
        [job.id, job.lease_token],
      )
    ).rows[0];
    if (!current) return;
    // Source quota must precede Shopify channel guards and inbound staging.
    await acquireOrderFieldObservationAdmissionInTx(c, actor, ch.provider);
    if (ch.provider === 'shopify' && !(await shopifyPolicy(c, job, true))) return;
    const created:{id:string;state:string;source_hash:string}[]=[];
    await stageOrders(c, actor, ch, rows,ch.provider==='woocommerce'&&ctx.localWooReadLaneAfterStage?row=>created.push(row):undefined);
    if(ch.provider==='woocommerce')await ctx.localWooReadLaneAfterStage?.(c,job,created);
    await c.query(
      'UPDATE channels SET event_cursor=$1,bootstrap_done=bootstrap_done OR $2,last_sync_at=CASE WHEN $3 THEN last_sync_at ELSE now() END WHERE id=$4',
      [cursor, nextPhase === 'events' || (ch.provider === 'shopify' && !more), more, ch.id],
    );
    await c.query(
      `UPDATE jobs SET state=$1,attempts=0,payload=$2,lease_token=NULL,locked_at=NULL,error=NULL,run_at=now() WHERE id=$3`,
      [
        more ? 'pending' : 'done',
        JSON.stringify({
          ...job.payload,
          phase: nextPhase,
          ...(ch.provider === 'shopify' ? { shopify_window: shopifyWindow } : {}),
          ...(ch.provider === 'prestashop' ? { prestashop_after: prestaAfter } : {}),
          page: job.payload.phase === nextPhase ? job.payload.page + 1 : 1,
        }),
        job.id,
      ],
    );
    await c.query(
      'INSERT INTO integration_runs(id,tenant_id,channel_id,operation,status,detail) VALUES($1,$2,$3,$4,$5,$6)',
      [
        randomUUID(),
        job.tenant_id,
        ch.id,
        'orders.sync',
        more ? 'page_done' : 'done',
        JSON.stringify({
          page: job.payload.page,
          phase: job.payload.phase,
          count: rows.length,
          cursor,
          ...(localPagination?{pagination:localPagination}:{}),
        }),
      ],
    );
  });
}
