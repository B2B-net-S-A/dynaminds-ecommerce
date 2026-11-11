/** AUTHORED, NOT RUN. No connection unless explicit scratch opt-in and genuine case manifest.
 * Root prepares OFF/ON148 sale+custody+reject cases through ordinary API; no fake proof INSERT.
 * Source206 does not register a writer: this tests only the private native reader. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {history206Enabled,history206Cases,withHistory206Client,history206Facts,begin206,validate206,literal188206} from './return-credit206-history-fixture';
const options={skip:!history206Enabled};
test('206 genuine historical OFF/ON148 with sale/custody/reject and multiple WH is read-only; literal188 remains closed',options,async()=>{
 const cases=await history206Cases();await withHistory206Client(async c=>{for(const f of cases){
  await begin206(c,f.tenant_id);try{
   const native=(await c.query(`SELECT count(*) FILTER(WHERE effect='sale')::int sale,count(*) FILTER(WHERE effect='custody')::int custody,
    count(*) FILTER(WHERE decision='reject')::int reject,count(DISTINCT warehouse_id)::int warehouses
    FROM return_destination_parts WHERE tenant_id=$1 AND receipt_id=(SELECT assistant_receipt_id FROM catalog_stock_return_receipts WHERE(tenant_id,id)=($1,$2))`,[f.tenant_id,f.receipt_id])).rows[0];
   assert(native.sale>0&&native.custody>0&&native.reject>0&&native.warehouses>=2,'Genuine complete split fixture is required');
   const wms=(await c.query('SELECT wms_operation_id FROM catalog_stock_return_receipts WHERE(tenant_id,id)=($1,$2)',[f.tenant_id,f.receipt_id])).rows[0];assert.equal(wms.wms_operation_id!==null,f.wms);
   await literal188206(c);const before=await history206Facts(c,f.tenant_id);
   await validate206(c,f.receipt_id);await validate206(c,f.receipt_id);
   assert.deepEqual(await history206Facts(c,f.tenant_id),before);await literal188206(c);
   await c.query('SAVEPOINT old188');await assert.rejects(c.query('SELECT public.local_consumer_credit_history($1)',[f.receipt_id]),(e:any)=>e.code==='23514');await c.query('ROLLBACK TO old188');
  }finally{await c.query('ROLLBACK');}
 }});
});
test('206 missing, foreign-tenant and application-role calls cannot borrow native history authority',options,async()=>{
 const [f,other]=await history206Cases();await withHistory206Client(async c=>{
  await begin206(c,other.tenant_id);try{await assert.rejects(validate206(c,f.receipt_id),(e:any)=>e.code==='23514');}finally{await c.query('ROLLBACK');}
  await begin206(c,f.tenant_id);try{
   await c.query('SAVEPOINT missing');await assert.rejects(validate206(c,randomUUID()),(e:any)=>e.code==='23514');await c.query('ROLLBACK TO missing');
   await c.query('SAVEPOINT role');await c.query('SET LOCAL ROLE dyna_app');await assert.rejects(validate206(c,f.receipt_id),(e:any)=>e.code==='42501');await c.query('ROLLBACK TO role');
   await validate206(c,f.receipt_id);
  }finally{await c.query('ROLLBACK');}
 });
});
test('206 detects tainted lineage, omitted arrival, PZ quantity and WMS value; all mutations roll back',options,async()=>{
 const cases=await history206Cases();await withHistory206Client(async c=>{for(const f of cases){
  await begin206(c,f.tenant_id);try{
   const before=await history206Facts(c,f.tenant_id);await validate206(c,f.receipt_id);
   const corruptions=[
    `UPDATE return_destination_admissions SET payload=jsonb_set(payload,'{plan,summary,commercial_credit_minor}',to_jsonb((payload#>>'{plan,summary,commercial_credit_minor}')::bigint+1)) WHERE tenant_id=$1 AND receipt_id=(SELECT assistant_receipt_id FROM catalog_stock_return_receipts WHERE(tenant_id,id)=($1,$2))`,
    `DELETE FROM return_destination_arrivals WHERE(tenant_id,id)=(SELECT tenant_id,id FROM return_destination_arrivals WHERE tenant_id=$1 AND receipt_id=(SELECT assistant_receipt_id FROM catalog_stock_return_receipts WHERE(tenant_id,id)=($1,$2)) ORDER BY id LIMIT 1)`,
    `UPDATE catalog_stock_return_rows SET quantity=quantity+1 WHERE(tenant_id,id)=(SELECT x.tenant_id,x.id FROM catalog_stock_return_rows x JOIN catalog_stock_return_documents d ON(d.tenant_id,d.id)=(x.tenant_id,x.document_id) WHERE(d.tenant_id,d.receipt_id)=($1,$2) ORDER BY x.id LIMIT 1)`,
    ...(f.wms?[`UPDATE wms_return_fragments SET value_minor=coalesce(value_minor,0)+1 WHERE(tenant_id,id)=(SELECT f.tenant_id,f.id FROM wms_return_fragments f JOIN catalog_stock_return_receipts r ON(r.tenant_id,r.wms_operation_id)=(f.tenant_id,f.operation_id) WHERE(r.tenant_id,r.id)=($1,$2) ORDER BY f.id LIMIT 1)`]:[]),
   ];
   for(const sql of corruptions){
    await c.query('SAVEPOINT corruption206');
    // Controlled owner corruption in numeric scratch or the exact opted-in synthetic preview copy only.
    // Restore origin before invoking the validator, so metadata/origin refusal
    // cannot masquerade as rejection of the corrupted historical evidence.
    await c.query("SET LOCAL session_replication_role='replica'");assert.equal((await c.query(sql,[f.tenant_id,f.receipt_id])).rowCount,1);
    await c.query("SET LOCAL session_replication_role='origin'");await literal188206(c);
    await assert.rejects(validate206(c,f.receipt_id),(e:any)=>e.code==='23514');
    await c.query('ROLLBACK TO corruption206');assert.deepEqual(await history206Facts(c,f.tenant_id),before);await validate206(c,f.receipt_id);
   }
  }finally{await c.query('ROLLBACK');}
 }});
});
