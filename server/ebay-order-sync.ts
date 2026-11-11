import { externalImportReadAccessInTx } from './b2b-external-order-imports';
import type { ImportOrderOptions } from './imports';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { tenantTx } from './db';
import { type Actor, audit } from './domain';
import { ensure } from './errors';
import type { IntegrationContext } from './channel-access';
import { Ebay, initialEbayWindow } from './ebay';
import { channelRead } from './channel-access';
import { stageOrders, importSourceHash, importConnectionHash, importOrder } from './imports';
export const ebayOrdersHash = importConnectionHash;
export async function ebayReadPolicy(c: PoolClient, actor: Actor, ch: any) {
  const current = (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [ch.id])).rows[0];
  ensure(
    (await c.query('SELECT offer_sync_is_admin($1) ok', [actor.userId])).rows[0]?.ok,
    403,
    'Administrator utracił prawo importu eBay',
  );
  ensure(
    current?.provider === 'ebay' && ebayOrdersHash(current) === ebayOrdersHash(ch),
    409,
    'Połączenie eBay zmieniło się podczas odczytu',
  );
  return current;
}
async function read<T>(
  actor: Actor,
  ch: any,
  ctx: IntegrationContext,
  fn: (client: Ebay) => Promise<T>,
  fence?: () => Promise<void>,
) {
  return channelRead(
    actor.tenantId,
    ch.id,
    (client) => fn(client as Ebay),
    ctx,
    true,
    async (current) => {
      ensure(ebayOrdersHash(current) === ebayOrdersHash(ch), 409, 'Połączenie eBay zmieniło się');
      await tenantTx(actor.tenantId, (c) => ebayReadPolicy(c, actor, ch));
      await fence?.();
    },
  );
}
export async function readEbayOrders(
  actor: Actor,
  ch: any,
  cursor: string | undefined,
  ctx: IntegrationContext,
) {
  const fence = () =>
    tenantTx(actor.tenantId, async (c) => {
      await ebayReadPolicy(c, actor, ch);
    });
  return read(actor, ch, ctx, (client) => client.orders(cursor, undefined, fence));
}
export async function commitEbayOrder(
  actor: Actor,
  id: string,
  warehouse: string,
  expectedHash: string,
  ctx: IntegrationContext,
  options: ImportOrderOptions = {},
) {
  const initial = await tenantTx(actor.tenantId, async (c) => {
    if (options.externalImportConsent) await externalImportReadAccessInTx(c, actor);
    const inbound = (await c.query('SELECT * FROM inbound_orders WHERE id=$1', [id])).rows[0];
    ensure(inbound, 404, 'Nie znaleziono zamówienia');
    ensure(inbound.source_hash === expectedHash, 409, 'Podgląd eBay zmienił się; odśwież kolejkę');
    const ch = (await c.query('SELECT * FROM channels WHERE id=$1', [inbound.channel_id])).rows[0];
    ensure(ch?.provider === 'ebay', 422, 'Wymagane źródło eBay');
    await ebayReadPolicy(c, actor, ch);
    return { inbound, ch };
  });
  if (!initial.ch.settings.simulation) {
    const fence = () =>
      tenantTx(actor.tenantId, async (c) => {
        if (options.externalImportConsent) await externalImportReadAccessInTx(c, actor);
        await ebayReadPolicy(c, actor, initial.ch);
      });
    const latest = await read(
      actor,
      initial.ch,
      ctx,
      (client) => client.order(initial.inbound.external_id, fence),
      options.externalImportConsent
        ? () => tenantTx(actor.tenantId, (c) => externalImportReadAccessInTx(c, actor))
        : undefined,
    );
    const changed = await tenantTx(actor.tenantId, async (c) => {
      if (options.externalImportConsent) await externalImportReadAccessInTx(c, actor);
      await ebayReadPolicy(c, actor, initial.ch);
      const inbound = (
        await c.query('SELECT source_hash FROM inbound_orders WHERE id=$1 FOR UPDATE', [id])
      ).rows[0];
      ensure(
        inbound?.source_hash === expectedHash,
        409,
        'Kolejka eBay zmieniła się podczas kontroli',
      );
      if (importSourceHash(latest) === expectedHash) return false;
      await stageOrders(c, actor, initial.ch, [latest]);
      return true;
    });
    ensure(!changed, 409, 'eBay zmienił zamówienie; odśwież podgląd i ponownie zatwierdź import');
  }
  return importOrder(actor, id, warehouse, expectedHash, ebayOrdersHash(initial.ch), options);
}
export function ebaySyncPayload(ch: any) {
  return {
    ebay_window: initialEbayWindow(ch.bootstrap_done ? ch.event_cursor : null),
    ebay_policy: { connection_hash: ebayOrdersHash(ch), require_enabled: ch.sync_enabled },
  };
}
export async function processEbaySync(job: any, actor: Actor, ch: any, ctx: IntegrationContext) {
  ensure(job.payload.ebay_window && job.payload.ebay_policy, 422, 'Brak checkpointu zamówień eBay');
  const guard = async (c: PoolClient, renew = false) => {
    const current = (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [ch.id]))
        .rows[0],
      j = (
        await c.query(
          "SELECT id FROM jobs WHERE id=$1 AND lease_token=$2 AND state='running' FOR UPDATE",
          [job.id, job.lease_token],
        )
      ).rows[0];
    if (!j) return false;
    if (
      !current ||
      current.provider !== 'ebay' ||
      current.settings.simulation ||
      !(await c.query('SELECT offer_sync_is_admin($1) ok', [actor.userId])).rows[0]?.ok ||
      ebayOrdersHash(current) !== job.payload.ebay_policy.connection_hash ||
      (job.payload.ebay_policy.require_enabled && !current.sync_enabled)
    ) {
      await c.query(
        "UPDATE jobs SET state='done',error='Odczyt eBay zatrzymano po zmianie roli, konfiguracji lub pauzie',lease_token=NULL,locked_at=NULL WHERE id=$1",
        [job.id],
      );
      return false;
    }
    if (renew) await c.query('UPDATE jobs SET locked_at=now() WHERE id=$1', [job.id]);
    return true;
  };
  const fence = async () =>
    ensure(
      await tenantTx(job.tenant_id, (c) => guard(c, true)),
      409,
      'Zatrzymano odczyt zamówień eBay',
    );
  if (!(await tenantTx(job.tenant_id, (c) => guard(c, true)))) return;
  const result = await read(
    actor,
    ch,
    ctx,
    (client) => client.orders(undefined, job.payload.ebay_window, fence),
    fence,
  );
  ensure(
    !result.data.some((o: any) => (job.payload.ebay_previous_ids ?? []).includes(o.id)),
    502,
    'Powtórzona strona zamówień eBay',
  );
  ensure(
    !result.has_more || job.payload.page < 20000,
    422,
    'Przekroczono milion zamówień okna eBay; zawęź import historyczny',
  );
  await tenantTx(job.tenant_id, async (c) => {
    if (!(await guard(c))) return;
    await stageOrders(c, actor, ch, result.data);
    await c.query(
      'UPDATE channels SET event_cursor=CASE WHEN $2 THEN event_cursor ELSE $3 END,bootstrap_done=bootstrap_done OR NOT $2,last_sync_at=CASE WHEN $2 THEN last_sync_at ELSE now() END WHERE id=$1',
      [ch.id, result.has_more, result.window.to],
    );
    await c.query(
      'UPDATE jobs SET state=$2,attempts=0,payload=$3,error=NULL,lease_token=NULL,locked_at=NULL,run_at=now() WHERE id=$1',
      [
        job.id,
        result.has_more ? 'pending' : 'done',
        JSON.stringify({
          ...job.payload,
          ebay_window: result.window,
          ebay_previous_ids: result.data.map((o: any) => o.id),
          page: job.payload.page + 1,
        }),
      ],
    );
    await c.query(
      "INSERT INTO integration_runs(id,tenant_id,channel_id,operation,status,detail) VALUES($1,$2,$3,'orders.sync',$4,$5)",
      [
        randomUUID(),
        job.tenant_id,
        ch.id,
        result.has_more ? 'page_done' : 'done',
        JSON.stringify({
          page: job.payload.page,
          count: result.data.length,
          window: result.window,
          scope: 'marketplace_read_local_stage',
        }),
      ],
    );
    await audit(c, actor, 'ebay.orders.page', ch.id, {
      count: result.data.length,
      has_more: result.has_more,
    });
  });
}
