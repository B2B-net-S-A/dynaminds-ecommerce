import { z } from 'zod';
import { Problem, ensure } from './errors';
import { adjustmentUuid } from './stocktake-adjustments-schema';

// Reads only the frozen publication produced by the reviewed WMS publisher.
// Does not establish IAM, migrate, hydrate current PIM or write physical state.
const unsigned=z.string().regex(/^(?:0|[1-9][0-9]{0,39})$/);
const positive=unsigned.refine(v=>BigInt(v)>0n);
const signed=z.string().regex(/^(?:0|-?[1-9][0-9]{0,39})$/);
const row=z.strictObject({ordinal:z.number().int().min(0),product_id:adjustmentUuid,warehouse_id:adjustmentUuid,
 location:z.string(),sku:z.string(),name:z.string(),quantity:positive,delta:signed,
 stock_movement_id:adjustmentUuid,location_movement_id:adjustmentUuid,layer_movement_id:adjustmentUuid,
 operation_id:adjustmentUuid,layer_id:adjustmentUuid,lot_id:adjustmentUuid,
 unit_cost_minor:unsigned.nullable(),value_minor:unsigned.nullable(),currency:z.string().regex(/^[A-Z]{3}$/),exponent:z.number().int().min(0).max(6)});
const publication=z.strictObject({id:adjustmentUuid,protocol:z.literal('wms_adjustment'),preview_id:adjustmentUuid,
 operation_id:adjustmentUuid,warehouse_document_id:adjustmentUuid,kind:z.enum(['PW','RW']),number:z.string().min(1),
 series_id:adjustmentUuid,year:z.number().int().min(1).max(9999),sequence:positive,
 warehouse:z.strictObject({id:adjustmentUuid,name:z.string(),code:z.string()}),quantity:positive,
 row_count:z.number().int().min(1).max(10000),rows:z.array(row).min(1).max(10000),
 created_at:z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|\+00:00)$/),
 summary:z.strictObject({quantity:positive,known_quantity:unsigned,zero_cost_quantity:unsigned,unknown_quantity:unsigned,
 known_value_minor:unsigned,signed_known_value_minor:signed,currency:z.string().regex(/^[A-Z]{3}$/),exponent:z.number().int().min(0).max(6)})});
export type WarehouseWmsCorrectionRow=Omit<z.infer<typeof row>,'unit_cost_minor'|'value_minor'|'currency'|'exponent'> & {
 origin:'wms_correction';kind:'PW'|'RW';unit_cost_minor?:string|null;value_minor?:string|null;currency?:string;exponent?:number};
export type WarehouseWmsCorrectionSummary={quantity:string;pw_quantity:string;rw_quantity:string;currency?:string;exponent?:number;
 known_pw_minor?:string;known_rw_minor?:string;unknown_pw_quantity?:string;unknown_rw_quantity?:string;
 known_quantity?:string;zero_cost_quantity?:string;unknown_quantity?:string;known_value_minor?:string;signed_known_value_minor?:string};
const head=publication.omit({rows:true});
export function assertWarehouseWmsCorrectionValues(summary:unknown){
 const s=summary as {known_value_minor:string;signed_known_value_minor:string},maximum=9223372036854775807n;
 ensure(BigInt(s.known_value_minor)<=maximum&&BigInt(s.signed_known_value_minor)>=-maximum-1n&&BigInt(s.signed_known_value_minor)<=maximum,413,'Wartość korekty przekracza obsługiwany zakres int64');
}
function int64Head(d:z.infer<typeof head>,values=false){
 const maximum=9223372036854775807n;
 for(const v of [d.quantity,d.sequence,d.summary.known_quantity,d.summary.zero_cost_quantity,d.summary.unknown_quantity])
  ensure(BigInt(v)<=maximum,413,'Wartość korekty przekracza obsługiwany zakres int64');
 const signedValue=BigInt(d.summary.signed_known_value_minor);
 if(values)assertWarehouseWmsCorrectionValues(d.summary);
 ensure(d.summary.quantity===d.quantity&&BigInt(d.summary.known_quantity)+BigInt(d.summary.unknown_quantity)===BigInt(d.quantity)&&
  BigInt(d.summary.zero_cost_quantity)<=BigInt(d.summary.known_quantity)&&signedValue===(d.kind==='PW'?1n:-1n)*BigInt(d.summary.known_value_minor),409,'Niezgodne podsumowanie korekty');
 return d;
}
export function warehouseWmsCorrectionHead(raw:unknown,values=false){
 const parsed=head.safeParse(raw);if(!parsed.success)throw new Problem(409,'Niepełny nagłówek korekty WMS');return int64Head(parsed.data,values);
}
export function warehouseWmsCorrectionPublication(raw:unknown){
 const parsed=publication.safeParse(raw);if(!parsed.success)throw new Problem(409,'Niepełny zapisany dokument korekty WMS');
 const d=parsed.data;const {rows:ignored,...h}=d;int64Head(h);const sign=d.kind==='PW'?1n:-1n;let quantity=0n,known=0n,unknown=0n,zero=0n;
 const layers=new Set<string>();
 for(const [i,r] of d.rows.entries()){
  ensure(r.ordinal===i&&r.warehouse_id===d.warehouse.id&&r.operation_id===d.operation_id&&!layers.has(r.layer_movement_id),409,'Obcy lub powielony wiersz korekty WMS');
  layers.add(r.layer_movement_id);const q=BigInt(r.quantity);
  ensure(q<=2147483647n&&(r.unit_cost_minor===null||BigInt(r.unit_cost_minor)<=9223372036854775807n),413,'Wiersz korekty przekracza obsługiwany zakres');
  ensure(BigInt(r.delta)===sign*q&&r.currency===d.summary.currency&&r.exponent===d.summary.exponent,409,'Niezgodny znak lub waluta korekty WMS');
  quantity+=q;
  if(r.unit_cost_minor===null){ensure(r.value_minor===null,409,'Nieznany koszt korekty utracił NULL');unknown+=q;}
  else{const value=q*BigInt(r.unit_cost_minor);ensure(r.value_minor!==null&&BigInt(r.value_minor)===value,409,'Niezgodna wartość korekty WMS');known+=value;if(r.unit_cost_minor==='0')zero+=q;}
 }
 ensure(d.row_count===d.rows.length&&BigInt(d.quantity)===quantity&&BigInt(d.summary.quantity)===quantity&&
  BigInt(d.summary.known_quantity)===quantity-unknown&&BigInt(d.summary.zero_cost_quantity)===zero&&
  BigInt(d.summary.unknown_quantity)===unknown&&BigInt(d.summary.known_value_minor)===known&&
  BigInt(d.summary.signed_known_value_minor)===sign*known,409,'Niepełny manifest lub suma korekty WMS');
 return d;
}
export function warehouseWmsCorrectionSummary(d:Pick<z.infer<typeof publication>,'kind'|'quantity'|'summary'>):WarehouseWmsCorrectionSummary{
 return {pw_quantity:d.kind==='PW'?d.quantity:'0',rw_quantity:d.kind==='RW'?d.quantity:'0',...d.summary,
  known_pw_minor:d.kind==='PW'?d.summary.known_value_minor:'0',known_rw_minor:d.kind==='RW'?d.summary.known_value_minor:'0',
  unknown_pw_quantity:d.kind==='PW'?d.summary.unknown_quantity:'0',unknown_rw_quantity:d.kind==='RW'?d.summary.unknown_quantity:'0'};
}
