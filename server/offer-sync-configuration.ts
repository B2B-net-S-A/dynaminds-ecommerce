/** Shared ordinary configuration behavior. Native214 registration/acceptance belongs to normal release wiring. */
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {amazonAccountPolicy} from './amazon-account';
import {requireAmazonWrite} from './amazon-offers';
import {requireEbayWrite} from './ebay';
import {shopifyId} from './shopify';
import {ensure} from './errors';
import {audit,type Actor} from './domain';
import {offerConnectionHash as connectionHash} from './offer-sync-policy';
export const offerSyncInput = z
  .object({
    version: z.number().int().min(0),
    enabled: z.boolean(),
    warehouse_id: z.uuid(),
    price_list_id: z.uuid().nullable().default(null),
    stock: z.boolean(),
    price: z.boolean(),
    interval_seconds: z.number().int().min(30).max(86400),
    verify_seconds: z.number().int().min(60).max(86400),
    confirm_external: z.boolean().default(false),
  })
  .strict()
  .refine((b) => b.stock || b.price, { message: 'Wybierz cenę lub stan' })
  .refine((b) => b.price || !b.price_list_id, { message: 'Cennik dotyczy ceny' });
export type OfferSyncConfigurationInput=z.infer<typeof offerSyncInput>;
export async function lockOfferSyncConfigurationInTx(c:PoolClient,actor:Actor,channelId:string){
 await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['offer-sync-config:'+actor.tenantId+':'+channelId]);
}
export async function requireOfferSyncAdministratorInTx(c:PoolClient,actor:Actor){
 ensure(actor.role==='admin',403,'Wymagana rola administratora');
 ensure((await c.query('SELECT public.offer_sync_is_admin($1) AS authorized',[actor.userId])).rows[0]?.authorized===true,403,'Administrator utracił prawo konfiguracji synchronizacji');
}
export async function configureOfferSyncInTx(c:PoolClient,actor:Actor,channelId:string,b:OfferSyncConfigurationInput){
 await lockOfferSyncConfigurationInTx(c, actor, channelId);
 await requireOfferSyncAdministratorInTx(c, actor);
 const previous = (
   await c.query('SELECT * FROM offer_sync_configs WHERE channel_id=$1 FOR UPDATE', [
     channelId,
   ])
 ).rows[0];
 const ch = (await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [channelId]))
   .rows[0];
 ensure(
   ch &&
     ['woocommerce', 'allegro', 'prestashop', 'shopify', 'ebay', 'amazon'].includes(
       ch.provider,
     ),
   404,
   'Nie znaleziono kanału ofert',
 );
 if (ch.provider === 'amazon' && b.enabled) {
   await amazonAccountPolicy(c, ch);
   requireAmazonWrite(ch);
 }
 if (ch.provider === 'ebay' && b.enabled) requireEbayWrite(ch);
 if (ch.provider === 'shopify' && b.enabled && b.stock)
   shopifyId(ch.settings.inventory_location_id, 'Location');
 ensure((previous?.version ?? 0) === b.version, 409, 'Konfigurację zmieniono; odśwież dane');
 ensure(
   !b.enabled || ch.settings.simulation || b.confirm_external,
   422,
   'Potwierdź cykliczny zapis do tego konta dostawcy',
 );
 ensure(
   (await c.query('SELECT id FROM warehouses WHERE id=$1', [b.warehouse_id])).rowCount,
   404,
   'Nie znaleziono magazynu',
 );
 if (b.price_list_id) {
   const list = (
     await c.query('SELECT active FROM price_lists WHERE id=$1', [b.price_list_id])
   ).rows[0];
   ensure(list, 404, 'Nie znaleziono cennika');
   ensure(!b.enabled || list.active, 409, 'Cennik jest nieaktywny');
 }
 const config = (
   await c.query(
     `INSERT INTO offer_sync_configs(tenant_id,channel_id,actor_id,enabled,warehouse_id,price_list_id,stock,price,interval_seconds,verify_seconds,external_authorized,connection_hash,next_run_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now()) ON CONFLICT(channel_id) DO UPDATE SET actor_id=excluded.actor_id,enabled=excluded.enabled,warehouse_id=excluded.warehouse_id,price_list_id=excluded.price_list_id,stock=excluded.stock,price=excluded.price,interval_seconds=excluded.interval_seconds,verify_seconds=excluded.verify_seconds,external_authorized=excluded.external_authorized,connection_hash=excluded.connection_hash,version=offer_sync_configs.version+1,next_run_at=now(),updated_at=now(),error=NULL RETURNING *`,
     [
       actor.tenantId,
       channelId,
       actor.userId,
       b.enabled,
       b.warehouse_id,
       b.price_list_id,
       b.stock,
       b.price,
       b.interval_seconds,
       b.verify_seconds,
       b.enabled && !ch.settings.simulation && b.confirm_external,
       connectionHash(ch),
     ],
   )
 ).rows[0];
 // Selected local Woo stock lane (local-woo-stock-lane.ts marks its work in payload.local_woo_stock): work it
 // never dispatched sent nothing anywhere, so it ends done with the cause, not failed (a failed owned job holds
 // the lane). Work it dispatched stays with the lane: it finishes a write that left, ends work without any
 // provider write itself, or keeps the unacknowledged dispatch for operator reconciliation.
 const laneCancelled = await c.query(
   `UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL,error=$3 WHERE tenant_id=$1 AND state='pending' AND attempts=0 AND lease_token IS NULL AND payload->>'channel_id'=$2 AND payload->'local_woo_stock'->>'schema'='local-woo-stock-owned/v1' AND (kind='offer.sync' OR (kind='offer.write' AND id IN (SELECT job_id FROM offer_plans WHERE channel_id=$2::uuid AND sync_version IS NOT NULL AND state='queued' AND phase='ready'))) RETURNING id`,
   [actor.tenantId, channelId, 'Harmonogram stanów wstrzymano lub zmieniono; zadanie anulowane bez skutku u dostawcy'],
 );
 // Pending dispatches are stopped. Already dispatched requests keep their verification job.
 await c.query(
   `UPDATE jobs SET state='failed',lease_token=NULL,locked_at=NULL,error='Harmonogram ofert wyłączono lub zmieniono' WHERE tenant_id=$1 AND state IN ('pending','running') AND NOT (state='running' AND payload->'local_woo_stock' IS NOT NULL) AND ((kind='offer.sync' AND payload->>'channel_id'=$2) OR (kind='offer.write' AND id IN (SELECT job_id FROM offer_plans WHERE channel_id=$2::uuid AND sync_version IS NOT NULL AND state='queued' AND phase='ready')))`,
   [actor.tenantId, channelId],
 );
 await c.query(
   "UPDATE offer_plans SET state='conflict',error='Harmonogram ofert wyłączono lub zmieniono' WHERE channel_id=$1 AND sync_version IS NOT NULL AND state='queued' AND phase='ready' AND NOT EXISTS(SELECT FROM jobs j WHERE j.id=offer_plans.job_id AND j.state='running' AND j.payload->'local_woo_stock' IS NOT NULL)",
   [channelId],
 );
 if (laneCancelled.rowCount)
   await audit(c, actor, 'local_woo.stock.cancel', channelId, {
     channel_id: channelId,
     version: config.version,
     job_ids: laneCancelled.rows.map((r: any) => r.id).sort(),
     outcome: 'NO_EFFECT_CANCELLED',
     provider_writes: 0,
     automatic_retry: false,
   });
 await audit(c, actor, 'offer.sync.configure', channelId, {
   version: config.version,
   enabled: b.enabled,
   stock: b.stock,
   price: b.price,
   external_authorized: config.external_authorized,
 });
 return config;
}
