import { externalImportReadAccessInTx } from './b2b-external-order-imports';
import type { ImportOrderOptions } from './imports';
import type { PoolClient } from 'pg';
import { tenantTx } from './db';
import type { Actor } from './domain';
import { ensure } from './errors';
import { channelRead, type IntegrationContext } from './channel-access';
import { Shopify } from './shopify';
import { shopifyAccountPolicy } from './shopify-oauth';
import {
  importConnectionHash,
  importOrder,
  shopifyOrderHash,
  stageOrders,
  acquireOrderFieldObservationAdmissionInTx,
} from './imports';
import type { MappedInitialConsent } from './order-field-mappings-schema';

export async function shopifyOrderReadPolicy(c: PoolClient, actor: Actor, ch: any) {
  ensure(ch?.provider === 'shopify', 404, 'Nie znaleziono kanału Shopify');
  await c.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [
    `shopify-oauth:${actor.tenantId}`,
  ]);
  const current = (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [ch.id])).rows[0];
  ensure(
    (await c.query('SELECT offer_sync_is_admin($1) ok', [actor.userId])).rows[0]?.ok,
    403,
    'Administrator utracił prawo importu Shopify',
  );
  ensure(
    current?.provider === 'shopify' && importConnectionHash(current) === importConnectionHash(ch),
    409,
    'Połączenie Shopify zmieniło się podczas odczytu',
  );
  await shopifyAccountPolicy(c, current);
  return current;
}
export async function readShopifyOrder(
  actor: Actor,
  ch: any,
  externalId: string,
  ctx: IntegrationContext = {},
  extraFence?: () => Promise<void>,
) {
  const fence = async () => {
    await extraFence?.();
    await tenantTx(actor.tenantId, async (c) => {
      await shopifyOrderReadPolicy(c, actor, ch);
    });
  };
  const binding = await tenantTx(actor.tenantId, async (c) => {
    await shopifyOrderReadPolicy(c, actor, ch);
    return (
      await c.query('SELECT shop_id FROM shopify_account_bindings WHERE channel_id=$1', [ch.id])
    ).rows[0];
  });
  return channelRead(
    actor.tenantId,
    ch.id,
    (client) => (client as Shopify).order(externalId, fence, binding?.shop_id),
    ctx,
    true,
    async (current) => {
      ensure(
        importConnectionHash(current) === importConnectionHash(ch),
        409,
        'Połączenie Shopify zmieniło się',
      );
      await fence();
    },
  );
}
export async function readShopifyOrders(
  actor: Actor,
  ch: any,
  cursor: string | undefined,
  ctx: IntegrationContext,
) {
  const fence = () =>
    tenantTx(actor.tenantId, async (c) => {
      await shopifyOrderReadPolicy(c, actor, ch);
    });
  return channelRead(
    actor.tenantId,
    ch.id,
    (client) => (client as Shopify).orders(cursor, undefined, fence),
    ctx,
    true,
    async (current) => {
      ensure(
        importConnectionHash(current) === importConnectionHash(ch),
        409,
        'Połączenie Shopify zmieniło się',
      );
      await fence();
    },
  );
}
export async function commitShopifyOrder(
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
    ensure(
      inbound.source_hash === expectedHash,
      409,
      'Podgląd Shopify zmienił się; odśwież kolejkę',
    );
    const ch = (await c.query('SELECT * FROM channels WHERE id=$1', [inbound.channel_id])).rows[0];
    if (!options.mappedInitial) await shopifyOrderReadPolicy(c, actor, ch);
    return { inbound, ch };
  });
  // Replaying an already imported order preserves its historical source. Later
  // provider changes are reviewed separately, never applied as new reservations.
  if (!initial.ch.settings.simulation && !initial.inbound.order_id) {
    const latest = await readShopifyOrder(
      actor,
      initial.ch,
      initial.inbound.external_id,
      ctx,
      options.externalImportConsent
        ? () => tenantTx(actor.tenantId, (c) => externalImportReadAccessInTx(c, actor))
        : undefined,
    );
    const changed = await tenantTx(actor.tenantId, async (c) => {
      if (options.externalImportConsent) await externalImportReadAccessInTx(c, actor);
      await acquireOrderFieldObservationAdmissionInTx(c, actor, 'shopify');
      await shopifyOrderReadPolicy(c, actor, initial.ch);
      // Same lock order as stageOrders: advisory key first, inbound row second.
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'shopify-order:' + actor.tenantId + ':' + initial.ch.id + ':' + initial.inbound.external_id,
      ]);
      const inbound = (await c.query('SELECT * FROM inbound_orders WHERE id=$1 FOR UPDATE', [id]))
        .rows[0];
      ensure(
        inbound?.source_hash === expectedHash,
        409,
        'Kolejka Shopify zmieniła się podczas kontroli',
      );
      if (shopifyOrderHash(latest) === shopifyOrderHash(inbound.raw)) return false;
      await stageOrders(c, actor, initial.ch, [latest]);
      return true;
    });
    ensure(
      !changed,
      409,
      'Shopify zmienił zamówienie; odśwież podgląd i ponownie zatwierdź import',
    );
  }
  return importOrder(actor, id, warehouse, expectedHash, importConnectionHash(initial.ch), options);
}
