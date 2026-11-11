import type { PoolClient } from 'pg';
import type { Actor } from './domain';
import { z } from 'zod';
import { ensure } from './errors';
import { isDeepStrictEqual } from 'node:util';

export const ORDER_PARCEL_RELEASE_LIMITS = { previews: 2000, releases: 2000, snapshot_bytes: 4194304, history_bytes: 67108864, preview_ttl_seconds: 900 } as const;
const id = z.uuid().transform(v => v.toLowerCase());
const version = z.string().regex(/^[1-9][0-9]{0,18}$/).refine(v => /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n);
export const orderParcelReleasePreviewInput = z.strictObject({ client_key: id, order_version: version });
export const orderParcelReleaseInput = z.strictObject({ client_key: id, scope_hash: z.string().regex(/^[a-f0-9]{64}$/), confirmed: z.literal(true) });
export type ReleaseProduct = { product_id: string; warehouse_id: string; quantity: number; locations: { location: string; quantity: number }[]; lot_holds: { layer_id: string; location: string; quantity: number }[] };
export type OrderParcelReleaseScope = { operation_id: string; plan_id: string; order_id: string; pending: { index: number; shipment_id: string; items: Record<string, any>[] }[]; products: ReleaseProduct[]; summary: { pending_parcels: number; commercial_quantity: number; physical_quantity: number; issued_parcels: number }; wms_enabled: boolean };

/** Q is the historical reserved quantity. C and L never rewrite Q or historical scans. */
export function parcelReservationRemainder(quantity: number, consumed: number, released: number) {
  ensure([quantity, consumed, released].every(Number.isSafeInteger) && quantity > 0 && consumed >= 0 && released >= 0 && consumed + released <= quantity, 409, 'Niespójne ilości rezerwacji paczek');
  return quantity - consumed - released;
}
export function parcelReservationState(quantity: number, consumed: number, released: number): 'active' | 'consumed' | 'released' {
  const remaining = parcelReservationRemainder(quantity, consumed, released);
  return remaining > 0 ? 'active' : released > 0 ? 'released' : 'consumed';
}

/** No on_hand/bin quantity, stock movement or WMS operation is written here. */
export async function releaseOrderParcelRemainderInTx(c: PoolClient, a: Actor & { apiKeyId?: string }, b: OrderParcelReleaseScope) {
  const scope = (await c.query('SELECT order_parcel_release_scope($1,$2,$3) r', [b.operation_id, a.userId, a.apiKeyId ?? null])).rows[0]?.r;
  ensure(scope && isDeepStrictEqual(scope, b), 409, 'Brak bieżącej zgody na pełne zwolnienie paczek');
  const { enlistWmsActorInTx } = await import('./wms-lots-transaction');
  a = enlistWmsActorInTx(c, a, { orders: true });
  const products = [...b.products].sort((x, y) => x.warehouse_id.localeCompare(y.warehouse_id) || x.product_id.localeCompare(y.product_id));
  ensure(products.length > 0 && new Set(products.map(p => p.warehouse_id + ':' + p.product_id)).size === products.length, 409, 'Zwolnienie wymaga jednoznacznych produktów');
  for (const p of products) {
    const stock = (await c.query('SELECT reserved FROM stock WHERE (tenant_id,warehouse_id,product_id)=($1,$2,$3) FOR UPDATE', [a.tenantId, p.warehouse_id, p.product_id])).rows[0];
    ensure(stock && Number.isSafeInteger(p.quantity) && p.quantity > 0 && stock.reserved >= p.quantity, 409, 'Rezerwacja zapasu nie pokrywa zwolnienia');
  }
  for (const p of products) {
    const r = (await c.query('SELECT * FROM reservations WHERE (tenant_id,order_id,product_id,warehouse_id)=($1,$2,$3,$4) FOR UPDATE', [a.tenantId, b.order_id, p.product_id, p.warehouse_id])).rows[0];
    ensure(r && r.state === 'active' && parcelReservationRemainder(r.quantity, r.consumed_quantity, r.released_quantity) === p.quantity, 409, 'Zwolnienie nie pokrywa całej pozostałej rezerwacji');
    ensure(p.locations.reduce((n, l) => n + l.quantity, 0) === p.quantity && new Set(p.locations.map(l => l.location)).size === p.locations.length, 409, 'Lokalizacje nie pokrywają zwolnienia');
    for (const l of [...p.locations].sort((x, y) => Buffer.compare(Buffer.from(x.location), Buffer.from(y.location)))) {
      const old = (await c.query('SELECT * FROM reservation_locations WHERE (tenant_id,order_id,product_id,warehouse_id,location)=($1,$2,$3,$4,$5) FOR UPDATE', [a.tenantId, b.order_id, p.product_id, p.warehouse_id, l.location])).rows[0];
      ensure(old && old.scanned === old.quantity && parcelReservationRemainder(old.quantity, old.consumed_quantity, old.released_quantity) === l.quantity, 409, 'Zwolnienie lokalizacji nie odpowiada pozostałym skanom');
      await c.query('UPDATE reservation_locations SET released_quantity=released_quantity+$6 WHERE (tenant_id,order_id,product_id,warehouse_id,location)=($1,$2,$3,$4,$5)', [a.tenantId, b.order_id, p.product_id, p.warehouse_id, l.location, l.quantity]);
    }
    if (b.wms_enabled) {
      ensure(p.lot_holds.reduce((n, l) => n + l.quantity, 0) === p.quantity && new Set(p.lot_holds.map(l => l.layer_id + ':' + l.location)).size === p.lot_holds.length, 409, 'Warstwy nie pokrywają zwolnienia');
      for (const l of [...p.lot_holds].sort((x, y) => x.layer_id.localeCompare(y.layer_id) || Buffer.compare(Buffer.from(x.location), Buffer.from(y.location)))) {
        const old = (await c.query('SELECT * FROM wms_reservation_layers WHERE (tenant_id,order_id,product_id,warehouse_id,location,layer_id)=($1,$2,$3,$4,$5,$6) FOR UPDATE', [a.tenantId, b.order_id, p.product_id, p.warehouse_id, l.location, l.layer_id])).rows[0];
        ensure(old && old.state === 'active' && old.scanned === old.quantity && parcelReservationRemainder(old.quantity, old.consumed_quantity, old.released_quantity) === l.quantity, 409, 'Zwolnienie warstwy nie odpowiada pozostałej rezerwacji');
        const changed = await c.query('UPDATE wms_layer_positions SET reserved=reserved-$6,version=version+1 WHERE (tenant_id,warehouse_id,product_id,location,layer_id)=($1,$2,$3,$4,$5) AND reserved>=$6', [a.tenantId, p.warehouse_id, p.product_id, l.location, l.layer_id, l.quantity]);
        ensure(changed.rowCount === 1, 409, 'Rezerwacja warstwy zmieniła się');
        await c.query("UPDATE wms_reservation_layers SET released_quantity=released_quantity+$7,state='released' WHERE (tenant_id,order_id,product_id,warehouse_id,location,layer_id)=($1,$2,$3,$4,$5,$6)", [a.tenantId, b.order_id, p.product_id, p.warehouse_id, l.location, l.layer_id, l.quantity]);
      }
    } else ensure(p.lot_holds.length === 0, 409, 'WMS OFF nie zwalnia warstw');
    const changed = await c.query('UPDATE stock SET reserved=reserved-$4 WHERE (tenant_id,warehouse_id,product_id)=($1,$2,$3) AND reserved>=$4', [a.tenantId, p.warehouse_id, p.product_id, p.quantity]);
    ensure(changed.rowCount === 1, 409, 'Zapas zwolnienia zmienił rezerwację');
    await c.query("UPDATE reservations SET released_quantity=released_quantity+$5,state='released' WHERE (tenant_id,order_id,product_id,warehouse_id)=($1,$2,$3,$4)", [a.tenantId, b.order_id, p.product_id, p.warehouse_id, p.quantity]);
  }
  return { operation_id: b.operation_id, cancelled: b.pending, products: b.products, summary: b.summary, physical_movement: false as const };
}
