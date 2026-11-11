/** Extracted unchanged RRRO UTC issued graph reader for the166 invoice gate.
 * No fixture/server runtime imports. Whole database preservation belongs to root. */
import assert from 'node:assert/strict';
import type {Pool} from 'pg';
type Row=Record<string,any>;
export async function issuedPrivateGraph159(pool:Pool,tenant:string,documentId:string){
 const c=await pool.connect();
 try{
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await c.query("SET LOCAL TimeZone='UTC'");
  const rows=(await c.query(`SELECT to_jsonb(p) preview,to_jsonb(a) admission,to_jsonb(r) receipt,to_jsonb(d) document,
   to_jsonb(counter) counter,to_jsonb(ns) namespace FROM b2b_invoice_receipts r
   JOIN b2b_invoice_previews p ON(p.tenant_id,p.id)=(r.tenant_id,r.preview_id)
   JOIN b2b_invoice_admissions a ON(a.tenant_id,a.id)=(r.tenant_id,r.id)
   JOIN documents d ON(d.tenant_id,d.id)=(r.tenant_id,r.document_id)
   JOIN b2b_invoice_counters counter ON(counter.tenant_id,counter.series_id,counter.year)=(r.tenant_id,r.series_id,r.year)
   JOIN b2b_invoice_namespaces ns ON(ns.tenant_id,ns.series_id)=(r.tenant_id,r.series_id)
   WHERE(r.tenant_id,r.document_id)=($1,$2)`,[tenant,documentId])).rows;
  assert.equal(rows.length,1);await c.query('COMMIT');return rows[0] as {preview:Row;admission:Row;receipt:Row;document:Row;counter:Row;namespace:Row};
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
