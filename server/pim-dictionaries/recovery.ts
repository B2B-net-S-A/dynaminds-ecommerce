/** Root staged RRRO historical validator. Import safe; no pool or application import. */
import assert from 'node:assert/strict';
import type {PoolClient} from 'pg';
export async function validateRecoveredPim(c:Pick<PoolClient,'query'>){
 const ctx=(await c.query("SELECT current_user=session_user AS owner,current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS readonly")).rows[0];
 assert.equal(ctx.owner,true);assert.equal(ctx.isolation,'repeatable read');assert.equal(ctx.readonly,'on');
 assert.equal((await c.query('SELECT public.pim_dictionary_valid() ok')).rows[0].ok,true,'Complete native PIM metadata and predecessor lineage');
 const before=(await c.query("SELECT current_setting('app.tenant_id',true) tenant")).rows[0].tenant;
 let previews=0,operations=0,completed=false;
 try{
  const tenants=(await c.query('SELECT DISTINCT tenant_id FROM (SELECT tenant_id FROM public.pim_dictionary_previews UNION SELECT tenant_id FROM public.pim_dictionary_operations) lineage ORDER BY tenant_id')).rows;
  for(const {tenant_id}of tenants){
   await c.query("SELECT set_config('app.tenant_id',$1,true)",[tenant_id]);
   for(const {id}of(await c.query('SELECT id FROM public.pim_dictionary_previews WHERE tenant_id=$1 ORDER BY id',[tenant_id])).rows){await c.query('SELECT public.pim_dictionary_validate_preview($1,$2)',[tenant_id,id]);previews++;}
   for(const {id}of(await c.query('SELECT id FROM public.pim_dictionary_operations WHERE tenant_id=$1 ORDER BY id',[tenant_id])).rows){await c.query('SELECT public.pim_dictionary_validate_operation($1,$2,true)',[tenant_id,id]);operations++;}
  }
  completed=true;
 }finally{if(completed)await c.query("SELECT set_config('app.tenant_id',$1,true)",[before??'']);}
 // On failure the caller rolls back its RRRO transaction. Do not issue a query
 // in an already aborted transaction and replace the first semantic error.
 return{previews,operations};
}
