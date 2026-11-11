import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Actor } from './domain';
import type { PriceBulkEditInput } from './price-bulk-edit-schema';
import { createPriceBulkEditPreviewInTx,executePriceBulkEditInTx } from './price-bulk-edit';
import { ensure,Problem } from './errors';

/** No read/write fallback when a partially installed family is present. */
export async function assertProductRulePriceTagsInTx(c:PoolClient){
  const marker=(await c.query("SELECT to_regprocedure('public.product_rule_price_tags_guards()') p")).rows[0].p;
  ensure(marker,503,'Kopia nie zawiera reguł cen i tagów');
  ensure((await c.query('SELECT public.product_rule_price_tags_guards() ok')).rows[0].ok,503,'Niekompletny moduł reguł cen i tagów');
}
/** Native core admission: literal request must derive from the genuine queued rule items. */
export async function assertProductRulePriceChildInTx(c:PoolClient,a:Actor,runId:string|undefined,b:PriceBulkEditInput){
  await assertProductRulePriceTagsInTx(c);
  ensure(runId&&!a.apiKeyId,403,'Brak własnego rodzica reguły cen');
  const r=(await c.query("SELECT r.*,j.state job_state,j.kind job_kind FROM product_rule_runs r JOIN jobs j ON(j.tenant_id,j.id)=(r.tenant_id,r.job_id) WHERE r.id=$1",[runId])).rows[0];
  ensure(r&&r.state==='queued'&&r.job_state==='running'&&r.job_kind==='product.rules',409,'Reguła cen nie ma aktywnego zadania');
  ensure(r.origin==='manual'?r.queued_actor===a.userId:r.rules.some((x:any)=>x.approved_by===a.userId),403,'Obcy zatwierdzający wykonanie cen');
  const frozen=(await c.query('SELECT product_id,source_version,source,projected FROM product_rule_items WHERE run_id=$1 ORDER BY product_id',[runId])).rows;
  const expected=frozen.filter((i:any)=>Object.hasOwn(i.projected.price_targets??{},b.price_list_id));
  ensure(expected.length===b.rows.length&&expected.length>0,409,'Ceny nie odpowiadają pełnym pozycjom reguły');
  for(const i of expected){
    const row=b.rows.find(x=>x.product_id===i.product_id),target=i.source.price_targets?.[b.price_list_id];
    ensure(row&&target&&row.operation==='set'&&row.basis==='gross'&&row.product_version===i.source_version&&row.amount_minor===i.projected.price_targets[b.price_list_id]&&b.list_version===target.frame.list.version,409,'Cena lub wersja nie odpowiada zatwierdzonej regule');
  }
}
export async function executeProductRulePricesInTx(c:PoolClient,a:Actor,run:any,rows:any[]){
  const ids=[...new Set<string>(rows.flatMap(i=>Object.keys(i.projected.price_targets??{})))].sort();
  const result:{price_list_id:string;preview_id:string;execution_id:string}[]=[];
  for(const id of ids){
    const selected=rows.filter(i=>Object.hasOwn(i.projected.price_targets??{},id));
    const input:PriceBulkEditInput={client_key:randomUUID(),price_list_id:id,list_version:selected[0].source.price_targets[id].frame.list.version,
      rows:selected.map(i=>({product_id:i.product_id,product_version:i.source_version,operation:'set',basis:'gross',amount_minor:i.projected.price_targets[id]}))};
    const internal={productRuleRunId:run.id};
    const p=await createPriceBulkEditPreviewInTx(c,a,input,'product_rule',internal);
    ensure(p.preview.ready,409,'Natywny podgląd cen nie jest gotowy');
    const e=await executePriceBulkEditInTx(c,a,p.preview.id,{client_key:randomUUID(),scope_hash:p.preview.scope_hash,confirmed:true,ack_missing_prices:false},'product_rule',internal);
    const child={price_list_id:id,preview_id:p.preview.id,execution_id:e.execution.id};
    await c.query('INSERT INTO product_rule_price_executions(tenant_id,run_id,price_list_id,preview_id,execution_id) VALUES($1,$2,$3,$4,$5)',[a.tenantId,run.id,id,child.preview_id,child.execution_id]);
    result.push(child);
  }
  return result;
}
/** Pins all real consenting owners, then schema; no writer/hydration follows. */
export async function pinProductRulePriceTagsInTx(c:PoolClient,a:Actor,run:any){
  await c.query('SET CONSTRAINTS ALL IMMEDIATE');
  try{await c.query('SELECT public.product_rule_price_tags_pin($1,$2)',[run.id,a.userId]);}catch(e){
    const code=(e as {code?:string}).code;if(code==='42501')throw new Problem(403,'Cofnięto zgodę administratora');if(code==='55000')throw new Problem(503,'Niekompletny moduł reguł cen i tagów');throw e;
  }
}
