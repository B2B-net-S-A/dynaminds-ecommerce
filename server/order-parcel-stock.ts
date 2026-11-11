import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Actor } from './domain';
import { ensure } from './errors';
import type { OrderParcelProduct } from './order-parcels-values';
import { enlistWmsActorInTx } from './wms-lots-transaction';
import { consumeWmsParcelLotsInTx } from './wms-lots';
import { lockWarehouseInventoryPoliciesInTx } from './warehouse-inventory-policies';

export type OrderParcelStockInput = {
  operation_id:string;plan_id:string;parcel_index:number;shipment_id:string;order_id:string;
  allocations:OrderParcelProduct[];
};

/** Only the private, current-transaction dispatch admission can consume stock. */
export async function consumeOrderParcelInTx(c:PoolClient, actor:Actor, b:OrderParcelStockInput) {
  const a=enlistWmsActorInTx(c,actor,{orders:true});
  await lockWarehouseInventoryPoliciesInTx(c, [...new Set(b.allocations.map(p => p.warehouse_id))], { sellable: true });
  const scope=(await c.query('SELECT order_parcel_dispatch_scope($1,$2,$3,$4,$5) r',
    [b.plan_id,b.parcel_index,b.operation_id,a.userId,a.apiKeyId??null])).rows[0]?.r;
  ensure(scope && scope.order_id===b.order_id && scope.receipt_id===b.operation_id &&
    scope.parcel.shipment_id===b.shipment_id && isDeepStrictEqual(scope.parcel.products,b.allocations),
    409,'Brak bieżącej zgody na dokładny zakres wydania paczki');
  ensure(b.allocations.length>0 && new Set(b.allocations.map(p=>p.product_id)).size===b.allocations.length,
    409,'Paczka wymaga jednoznacznych ilości fizycznych');
  const stock_movements:Array<{id:string;product_id:string;warehouse_id:string;quantity:number}>=[];
  const location_movements:Array<{id:string;product_id:string;warehouse_id:string;location:string;quantity:number}>=[];
  const products=[...b.allocations].sort((x,y)=>x.product_id.localeCompare(y.product_id));
  // All stock heads precede bin/layer locks, matching the existing fulfillment lock order.
  for(const p of products) {
    const s=(await c.query('SELECT on_hand,reserved FROM stock WHERE(tenant_id,warehouse_id,product_id)=($1,$2,$3) FOR UPDATE',
      [a.tenantId,p.warehouse_id,p.product_id])).rows[0];
    ensure(s && s.on_hand>=p.quantity && s.reserved>=p.quantity,409,'Brak zarezerwowanego towaru paczki');
  }
  for(const p of products) {
    ensure(Number.isSafeInteger(p.quantity) && p.quantity>0 &&
      p.locations.reduce((n,v)=>n+v.quantity,0)===p.quantity &&
      new Set(p.locations.map(v=>v.location)).size===p.locations.length,
      409,'Lokalizacje nie pokrywają dokładnej ilości paczki');
    const reservation=(await c.query(`SELECT quantity,consumed_quantity,state,coalesce((to_jsonb(r)->>'released_quantity')::integer,0) released_quantity FROM reservations r
      WHERE(tenant_id,order_id,product_id,warehouse_id)=($1,$2,$3,$4) FOR UPDATE`,
      [a.tenantId,b.order_id,p.product_id,p.warehouse_id])).rows[0];
    ensure(reservation && reservation.state==='active' && reservation.consumed_quantity+reservation.released_quantity+p.quantity<=reservation.quantity,
      409,'Paczka przekracza pozostałą rezerwację produktu');
    for(const bin of [...p.locations].sort((x,y)=>x.location<y.location?-1:x.location>y.location?1:0)) {
      const hold=(await c.query(`SELECT quantity,scanned,consumed_quantity,coalesce((to_jsonb(r)->>'released_quantity')::integer,0) released_quantity FROM reservation_locations r
        WHERE(tenant_id,order_id,product_id,warehouse_id,location)=($1,$2,$3,$4,$5) FOR UPDATE`,
        [a.tenantId,b.order_id,p.product_id,p.warehouse_id,bin.location])).rows[0];
      ensure(hold && hold.scanned===hold.quantity && Number.isSafeInteger(bin.quantity) && bin.quantity>0 &&
        hold.consumed_quantity+hold.released_quantity+bin.quantity<=hold.quantity,409,'Brak tylu skompletowanych sztuk w lokalizacji paczki');
      const changed=await c.query(`UPDATE stock_locations SET quantity=quantity-$5
        WHERE(tenant_id,warehouse_id,product_id,location)=($1,$2,$3,$4) AND quantity>=$5`,
        [a.tenantId,p.warehouse_id,p.product_id,bin.location,bin.quantity]);
      ensure(changed.rowCount===1,409,'Stan lokalizacji paczki zmienił się');
      await c.query(`UPDATE reservation_locations SET consumed_quantity=consumed_quantity+$6
        WHERE(tenant_id,order_id,product_id,warehouse_id,location)=($1,$2,$3,$4,$5)`,
        [a.tenantId,b.order_id,p.product_id,p.warehouse_id,bin.location,bin.quantity]);
      const id=randomUUID();
      await c.query(`INSERT INTO stock_location_movements(id,tenant_id,warehouse_id,product_id,location,delta,kind,order_id,operation_id)
        VALUES($1,$2,$3,$4,$5,$6,'shipment',$7,$8)`,
        [id,a.tenantId,p.warehouse_id,p.product_id,bin.location,-bin.quantity,b.order_id,b.operation_id]);
      location_movements.push({id,product_id:p.product_id,warehouse_id:p.warehouse_id,location:bin.location,quantity:bin.quantity});
    }
    const changed=await c.query(`UPDATE stock SET on_hand=on_hand-$4,reserved=reserved-$4
      WHERE(tenant_id,warehouse_id,product_id)=($1,$2,$3) AND on_hand>=$4 AND reserved>=$4`,
      [a.tenantId,p.warehouse_id,p.product_id,p.quantity]);
    ensure(changed.rowCount===1,409,'Stan lub rezerwacja paczki zmieniły się');
    const id=randomUUID();
    await c.query(`INSERT INTO stock_movements(id,tenant_id,product_id,warehouse_id,order_id,delta,kind,note)
      VALUES($1,$2,$3,$4,$5,$6,'shipment',$7)`,
      [id,a.tenantId,p.product_id,p.warehouse_id,b.order_id,-p.quantity,'parcel:'+b.operation_id]);
    stock_movements.push({id,product_id:p.product_id,warehouse_id:p.warehouse_id,quantity:p.quantity});
    await c.query(`UPDATE reservations SET consumed_quantity=consumed_quantity+$5,
      state=CASE WHEN consumed_quantity+$5=quantity THEN 'consumed' ELSE 'active' END
      WHERE(tenant_id,order_id,product_id,warehouse_id)=($1,$2,$3,$4)`,
      [a.tenantId,b.order_id,p.product_id,p.warehouse_id,p.quantity]);
  }
  const wms=await consumeWmsParcelLotsInTx(c,a,b);
  return {operation_id:b.operation_id,stock_movements,location_movements,wms};
}
