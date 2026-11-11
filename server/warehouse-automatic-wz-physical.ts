import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import type { Actor } from './domain';
import { ensure } from './errors';
import { consumeLocations } from './stock-locations';
import { consumeWmsLotsInTx } from './wms-lots';

export type WholeOrderPhysicalIssue = {
  stock_movements: Array<{id:string;product_id:string;warehouse_id:string;quantity:number}>;
  location_movements: Array<{id:string;product_id:string;warehouse_id:string;location:string;quantity:number}>;
  wms: null | Array<{operation_id:string;fragment_ids:string[];layer_movement_ids:string[]}>;
};
export type WholeOrderIssueSource =
  | {kind:'shipping_plan';order_id:string;plan_id:string;shipment_id:string}
  | {kind:'demo';order_id:string;shipment_id:string};
/** Trusted server adapter only. It runs after the existing dispatch source
 * admission; a rejecting document writer rolls back the same tenantTx.
 * Neither a public request field nor a second physical stock operation. */
export type WholeOrderIssueWriter = (issue:{source:WholeOrderIssueSource;physical:WholeOrderPhysicalIssue})=>Promise<void>;
type Reservation = {tenant_id:string;order_id:string;product_id:string;warehouse_id:string;quantity:number;state:string};

/** Preserve the existing physical issue once, and return its actual identities.
 * Historical WMS operation payloads and journal provenance remain unchanged.
 * No newest-row/time/SKU matching, document writes, counters or provider calls. */
export async function consumeWholeOrderStockInTx(c:PoolClient,a:Actor,b:{order_id:string;reservations:Reservation[]}):Promise<WholeOrderPhysicalIssue> {
  ensure(b.reservations.length>0,409,'Brak aktywnych rezerwacji');
  ensure(new Set(b.reservations.map(r=>r.product_id)).size===b.reservations.length,409,'Rezerwacje wydania nie są jednoznaczne');
  const proof:WholeOrderPhysicalIssue={stock_movements:[],location_movements:[],wms:null};
  for(const r of b.reservations) {
    ensure(r.tenant_id===a.tenantId&&r.order_id===b.order_id&&r.state==='active'&&Number.isSafeInteger(r.quantity)&&r.quantity>0,409,'Nieprawidłowa własna rezerwacja wydania');
    const bins=await consumeLocations(c,a,r);
    ensure(bins.reduce((n,m)=>n+m.quantity,0)===r.quantity,409,'Ruchy lokalizacji nie pokrywają wydania');
    proof.location_movements.push(...bins);
    const changed=await c.query('UPDATE stock SET on_hand=on_hand-$4,reserved=reserved-$4 WHERE(tenant_id,product_id,warehouse_id)=($1,$2,$3) AND on_hand>=$4 AND reserved>=$4',[a.tenantId,r.product_id,r.warehouse_id,r.quantity]);
    ensure(changed.rowCount===1,409,'Stan lub rezerwacja wydania zmieniły się');
    const id=randomUUID();
    await c.query("INSERT INTO stock_movements(id,tenant_id,product_id,warehouse_id,order_id,delta,kind) VALUES($1,$2,$3,$4,$5,$6,'shipment')",[id,a.tenantId,r.product_id,r.warehouse_id,b.order_id,-r.quantity]);
    proof.stock_movements.push({id,product_id:r.product_id,warehouse_id:r.warehouse_id,quantity:r.quantity});
    const wms=await consumeWmsLotsInTx(c,a,{order_id:b.order_id,product_id:r.product_id,warehouse_id:r.warehouse_id});
    if(wms) {
      const ids=wms.fragments.map((f:any)=>f.id);
      ensure(ids.length>0&&new Set(ids).size===ids.length,409,'Brak jednoznacznych fragmentów rozchodu WMS');
      const fragments=(await c.query(`SELECT id,operation_id,quantity FROM wms_issue_fragments
        WHERE tenant_id=$1 AND id=ANY($2::uuid[]) AND order_id=$3 AND product_id=$4 AND warehouse_id=$5 ORDER BY id`,[a.tenantId,ids,b.order_id,r.product_id,r.warehouse_id])).rows;
      ensure(fragments.length===ids.length&&fragments.reduce((n,f)=>n+f.quantity,0)===r.quantity,409,'Fragmenty WMS nie pokrywają rzeczywistego wydania');
      const ops=[...new Set(fragments.map(f=>f.operation_id as string))];
      ensure(ops.length===1,409,'Wydanie produktu wymaga jednej rzeczywistej operacji WMS');
      const journals=(await c.query(`SELECT m.id,f.id fragment_id FROM wms_issue_fragments f
        JOIN wms_layer_movements m ON(m.tenant_id,m.operation_id,m.warehouse_id,m.product_id,m.location,m.layer_id)=(f.tenant_id,f.operation_id,f.warehouse_id,f.product_id,f.location,f.layer_id)
        AND m.kind='dispatch' AND m.delta=-f.quantity
        WHERE f.tenant_id=$1 AND f.id=ANY($2::uuid[]) ORDER BY f.id,m.id`,[a.tenantId,ids])).rows;
      ensure(journals.length===ids.length&&new Set(journals.map(m=>m.id)).size===ids.length&&new Set(journals.map(m=>m.fragment_id)).size===ids.length,409,'Ruchy warstw nie odpowiadają dokładnie fragmentom rozchodu');
      proof.wms??=[];
      proof.wms.push({operation_id:ops[0],fragment_ids:fragments.map(f=>f.id),layer_movement_ids:journals.map(m=>m.id)});
    }
  }
  ensure(new Set(proof.stock_movements.map(m=>m.id)).size===proof.stock_movements.length&&new Set(proof.location_movements.map(m=>m.id)).size===proof.location_movements.length,409,'Ruch wydania występuje więcej niż raz');
  return proof;
}
