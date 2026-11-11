import type { Pool,PoolClient } from 'pg';
import { ensure,Problem } from './errors';
import type { CommercialComponent,CommercialParcelItem } from './order-parcel-commercial-values';
const tables=['order_parcel_commercial_origins','order_parcel_origin_issues','order_parcel_origin_fragments'];
const incomplete='Pochodzenie handlowe paczek jest niekompletne';
export async function orderParcelCommercialOriginsAvailable(c:Pool|PoolClient):Promise<boolean>{
 try{
  const p=(await c.query(`SELECT current_user role,EXISTS(SELECT 1 FROM unnest($1::text[]) name WHERE to_regclass(name) IS NOT NULL) OR EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'order_parcel_commercial_%') artifacts`,[tables])).rows[0];
  if(!p.artifacts){if(p.role!=='dyna_app')ensure(!(await c.query("SELECT EXISTS(SELECT 1 FROM migrations WHERE name='136_order_parcel_commercial_origins') installed")).rows[0].installed,503,incomplete);return false;}
  ensure((await c.query("SELECT to_regprocedure('order_parcel_commercial_guards()') IS NOT NULL AND to_regprocedure('order_parcel_commercial_installed()') IS NOT NULL ok")).rows[0].ok,503,incomplete);
  const g=(await c.query('SELECT order_parcel_commercial_guards() ok,order_parcel_commercial_installed() installed')).rows[0];ensure(g.ok&&g.installed,503,incomplete);return true;
 }catch(e){if(['42P01','42703','42883'].includes((e as {code?:string}).code??''))throw new Problem(503,incomplete);throw e;}
}
export type OrderParcelIssuedCommercialOrigin={origin_id:string;item_id:string;dispatch_id:string;parcel_index:number;shipment_id:string;quantity:number;components:CommercialComponent[];fragments:{fragment_id:string;product_id:string;quantity:number}[];snapshot:CommercialParcelItem};
/** Actual receipts only: RMA claims and available capacity belong to their own protocol. */
export async function orderParcelCommercialOriginsInTx(c:PoolClient,orderId:string):Promise<OrderParcelIssuedCommercialOrigin[]>{
 if(!await orderParcelCommercialOriginsAvailable(c))return [];
 return (await c.query(`SELECT o.id origin_id,o.item_id,i.dispatch_id,o.parcel_index,o.shipment_id,i.quantity,o.snapshot->'components' components,o.snapshot,
 coalesce((SELECT jsonb_agg(jsonb_build_object('fragment_id',m.fragment_id,'product_id',m.product_id,'quantity',m.quantity) ORDER BY m.product_id,m.fragment_id) FROM order_parcel_origin_fragments m WHERE(m.tenant_id,m.origin_id,m.dispatch_id)=(o.tenant_id,o.id,i.dispatch_id)),'[]') fragments
 FROM order_parcel_commercial_origins o JOIN order_parcel_origin_issues i ON(i.tenant_id,i.origin_id)=(o.tenant_id,o.id)
 WHERE o.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND o.order_id=$1 ORDER BY o.item_id,o.parcel_index,o.id`,[orderId])).rows;
}
export async function orderParcelCancelledInTx(c:PoolClient,planId:string):Promise<Map<number,string>>{
 if(!(await c.query("SELECT to_regclass('order_parcel_releases') IS NOT NULL available")).rows[0].available)return new Map();
 const rows=(await c.query(`SELECT r.id,pending->>'index' parcel_index FROM order_parcel_releases r CROSS JOIN LATERAL jsonb_array_elements(r.payload->'pending') pending WHERE r.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND r.plan_id=$1`,[planId])).rows;
 return new Map(rows.map(r=>[Number(r.parcel_index),r.id]));
}
