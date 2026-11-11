/** Real numeric-scratch Native207 proof. No app factory, business seed SQL or preview/Main mutation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {calculateReturnCredit206} from '../server/return-credit206-arithmetic.ts';
const enabled=process.env.DYNA_RETURN_CREDIT207_TEST==='true',options={skip:!enabled};
async function fixture(){
 assert(enabled);const file=process.env.DYNA_RETURN_CREDIT207_SCRATCH_LOCATOR;assert(file);
 const s=await fs.lstat(file);assert(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===process.getuid()&&(s.mode&511)===384&&s.size<16384);
 const v=JSON.parse(await fs.readFile(file,'utf8'));assert.equal(v.schema,'dynaminds-owned-native207-scratch/v1');const u=new URL(v.databaseUrl);
 assert.equal(u.hostname,'127.0.0.1');assert.match(u.pathname,/^\/dynaminds_test_\d+$/);assert.equal(u.username,'postgres');
 const m=JSON.parse(await fs.readFile(v.financialCasesFile,'utf8'));assert.equal(m.schema,'dynaminds-native-return-credit207-invoice-cases/v1');assert.equal(m.evidence,'genuine_http_fv157_before_rma_no207_execution');assert.equal(m.cases.length,2);
 const rejectedOnly=v.rejectOnlyCasesFile?JSON.parse(await fs.readFile(v.rejectOnlyCasesFile,'utf8')):null;
 if(rejectedOnly){assert.equal(rejectedOnly.schema,'dynaminds-native-return-credit207-reject-only-case/v1');assert.equal(rejectedOnly.evidence,m.evidence);}
 const c=new pg.Client({connectionString:v.databaseUrl,options:'-c timezone=UTC -c jit=off -c statement_timeout=120000 -c lock_timeout=8000'});await c.connect();
 assert.deepEqual((await c.query('SELECT current_database() name,current_user,session_user')).rows[0],{name:u.pathname.slice(1),current_user:'postgres',session_user:'postgres'});
 return{c,cases:m.cases,rejectedOnly:rejectedOnly?.case};
}
async function authority(c,f){
 const r=(await c.query('SELECT r.actor_id,s.token_hash FROM local_invoice_receipts r JOIN sessions s ON(s.tenant_id,s.user_id)=(r.tenant_id,r.actor_id) WHERE(r.tenant_id,r.id)=($1,$2) AND s.expires_at>clock_timestamp() ORDER BY s.expires_at DESC LIMIT 1',[f.tenant_id,f.original_receipt_id])).rows[0];
 assert(r,'Genuine unexpired API-created session required');return r;
}
async function tx(c,f,a,work){await c.query('BEGIN');try{await c.query("SELECT set_config('app.tenant_id',$1,true),set_config('local_invoice.identity_hash',$2,true)",[f.tenant_id,a.token_hash]);const result=await work();await c.query('SET CONSTRAINTS ALL IMMEDIATE');await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}}
async function app(c,work){await c.query('SET LOCAL ROLE dyna_app');let failed=false;try{return await work();}catch(e){failed=true;throw e;}finally{if(!failed)await c.query('RESET ROLE');}}
const native=async(c,sql,args)=>(await app(c,()=>c.query(sql,args))).rows[0].value;
const createSeries=(c,a,b)=>native(c,'SELECT public.return_credit206_series_create($1::jsonb,$2,NULL) value',[JSON.stringify(b),a.actor_id]);
const preview=(c,a,b)=>native(c,'SELECT public.return_credit206_preview($1::jsonb,$2,NULL) value',[JSON.stringify(b),a.actor_id]);
const issue=(c,a,p,b)=>native(c,'SELECT public.return_credit206_issue($1,$2::jsonb,$3,NULL) value',[p.id,JSON.stringify(b),a.actor_id]);
const source=(c,f,id)=>c.query('SELECT public.return_credit206_source($1,$2) value',[f.original_document_id,id]).then(r=>r.rows[0].value);
const physicalTables=['orders','order_items','return_cases','return_items','return_assistant_sessions','return_assistant_previews','return_assistant_receipts','return_assistant_admissions','return_destination_admissions','return_destination_parts','return_destination_arrivals','return_destination_fragments','stock','stock_locations','stock_movements','stock_location_movements','wms_operations','wms_return_fragments','wms_issue_fragments','wms_cost_layers','wms_layer_positions','wms_layer_movements','catalog_stock_control_effect_admissions','catalog_stock_control_effects','catalog_stock_control_effect_journals','catalog_stock_return_admissions','catalog_stock_return_receipts','catalog_stock_return_documents','catalog_stock_return_rows','catalog_stock_return_stock_maps','catalog_stock_return_item_maps','catalog_stock_return_layer_maps'];
async function facts(c,t){const out={};for(const table of [...physicalTables,'return_credit206_series','return_credit206_previews','return_credit206_documents','return_credit206_receipts','return_credit206_counters','return_credit206_namespaces','return_credit206_admissions','documents','payment_entries']){
 const size=(await c.query(`SELECT count(*)::int n,coalesce(sum(pg_column_size(x)),0)::text bytes FROM public.${table} x WHERE tenant_id=$1`,[t])).rows[0];assert(size.n<=10000&&BigInt(size.bytes)<=33554432n,'Full facts budget');
 out[table]=(await c.query(`SELECT count(*)::int n,encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text),'[]')::text,'UTF8')),'hex') sha FROM public.${table} x WHERE tenant_id=$1`,[t])).rows[0];}return out;}
const physical=f=>Object.fromEntries([...physicalTables,'documents','payment_entries'].map(k=>[k,f[k]]));
async function literal(c){assert.deepEqual((await c.query('SELECT public.local_consumer_credit_guards() guards,public.ordinary188_structure_valid() structure,public.return_credit206_guards() successor')).rows[0],{guards:true,structure:true,successor:true});}
const violation=e=>e.code==='23514';
async function actualDecision(c,f,a,id){return tx(c,f,a,async()=>{const graph=await source(c,f,id),decision=calculateReturnCredit206(graph),native=(await c.query('SELECT public.return_credit206_calculate($1::jsonb) value',[JSON.stringify(graph)])).rows[0].value;assert.deepEqual(native,decision,'Native calculation and independent arithmetic parity');return{graph,decision};});}

test('actual genuine reject-only148 source has no accepted169 sequence, preview, number, refund or stock effect',options,async()=>{
 const{c,rejectedOnly:f}=await fixture();try{assert(f,'Genuine reject-only case required');const a=await authority(c,f),r=(await c.query('SELECT return_id FROM return_assistant_receipts WHERE(tenant_id,id)=($1,$2)',[f.tenant_id,f.no_change_physical_receipt_id])).rows[0];assert(r);const before=await facts(c,f.tenant_id),{graph,decision}=await actualDecision(c,f,a,r.return_id);
 assert.equal(graph.acceptances.length,0);assert.equal(graph.rejected_inspections.length,1);assert.equal(decision.status,'no_commercial_change');assert.equal(decision.calculation,null);assert.equal(decision.next_return_id,null);assert.deepEqual(await facts(c,f.tenant_id),before);
 await assert.rejects(tx(c,f,a,async()=>preview(c,a,{client_key:randomUUID(),original_document_id:f.original_document_id,return_id:r.return_id,expected_return_version:String((await c.query('SELECT version FROM return_cases WHERE(tenant_id,id)=($1,$2)',[f.tenant_id,r.return_id])).rows[0].version),series_id:randomUUID(),expected_series_version:'1',reason:'Pełne odrzucenie kontroli',ordinary_domestic_confirmed:true,local_only:true})),e=>violation(e)&&/No new commercial correction is available/.test(e.message));
 assert.deepEqual(await facts(c,f.tenant_id),before);await literal(c);
 }finally{await c.end();}
});

test('actual Native207 OFF/ON source parity, strict consent, separate namespace, issue and exact replay commit',options,async()=>{
 const{c,cases}=await fixture();try{for(const f of cases){const a=await authority(c,f);await literal(c);
 const returnId=(await c.query('SELECT return_id FROM catalog_stock_return_receipts WHERE(tenant_id,id)=($1,$2)',[f.tenant_id,f.physical_receipt_id])).rows[0].return_id;
 const{graph,decision}=await actualDecision(c,f,a,returnId);assert.equal(decision.status,'credit_required');assert.equal(decision.calculation.totals.delta.gross_minor,'-2700');
 if(f.no_change_physical_receipt_id){const rejected=(await c.query('SELECT return_id FROM return_assistant_receipts WHERE(tenant_id,id)=($1,$2)',[f.tenant_id,f.no_change_physical_receipt_id])).rows[0].return_id;const audit=await actualDecision(c,f,a,rejected);assert.equal(audit.decision.status,'no_commercial_change');assert.equal(audit.decision.next_return_id,returnId);assert.equal(decision.calculation.receipt_sequence,1);assert.equal(graph.rejected_inspections.length,1);}
 const sb={client_key:randomUUID(),name:'Korekty zwrotów',prefix:f.wms?'ZWROT-ON':'ZWROT-OFF'};
 const series=await tx(c,f,a,()=>createSeries(c,a,sb));assert.equal(series.reused,false);
 const pb={client_key:randomUUID(),original_document_id:f.original_document_id,return_id:returnId,expected_return_version:String((await c.query('SELECT version FROM return_cases WHERE(tenant_id,id)=($1,$2)',[f.tenant_id,returnId])).rows[0].version),series_id:series.id,expected_series_version:String(series.version),reason:'Zwrot części pozycji',ordinary_domestic_confirmed:true,local_only:true};
 if(f.wms){const before=await facts(c,f.tenant_id);await assert.rejects(tx(c,f,a,async()=>{const collision=await createSeries(c,a,{...sb,client_key:randomUUID(),prefix:'ZWROT-OFF'});const p=await preview(c,a,{...pb,client_key:randomUUID(),series_id:collision.id});await issue(c,a,p,{client_key:randomUUID(),scope_hash:p.scope_hash,confirmed:true,local_only:true});}),e=>violation(e)&&/Numeracja/.test(e.message));assert.deepEqual(await facts(c,f.tenant_id),before,'Foreign global seller-prefix namespace cannot allocate or remain partially written');}
 const beforePhysical=physical(await facts(c,f.tenant_id)),p=await tx(c,f,a,()=>preview(c,a,pb));assert.equal(p.reused,false);assert.deepEqual(p.snapshot.calculation,decision.calculation);assert.equal(p.snapshot.physical_history_hash,decision.physical_history_hash);
 const ib={client_key:randomUUID(),scope_hash:p.scope_hash,confirmed:true,local_only:true},beforeConsent=await facts(c,f.tenant_id);
 for(const bad of [{...ib,confirmed:false},{...ib,local_only:false},{...ib,unknown:true},{...ib,scope_hash:'0'.repeat(64)}])await assert.rejects(tx(c,f,a,()=>issue(c,a,p,bad)),violation);
 await assert.rejects(tx(c,f,a,()=>preview(c,a,{...pb,reason:'Inna treść pod tym samym kluczem'})),violation);assert.deepEqual(await facts(c,f.tenant_id),beforeConsent);
 const other=cases.find(x=>x.tenant_id!==f.tenant_id),otherActor=await authority(c,other);
 await assert.rejects(tx(c,other,otherActor,()=>issue(c,otherActor,p,ib)),e=>e.code==='P0002');
 await assert.rejects(tx(c,other,otherActor,()=>preview(c,otherActor,{...pb,client_key:randomUUID()})),e=>e.code==='P0002');assert.deepEqual(await facts(c,f.tenant_id),beforeConsent);
 const r=await tx(c,f,a,()=>issue(c,a,p,ib));assert.equal(r.reused,false);assert.equal(r.number,sb.prefix+'/'+r.year+'/000001');const committed=await facts(c,f.tenant_id);assert.deepEqual(physical(committed),beforePhysical,'Financial correction cannot alter physical or payment facts');
 const replay=await tx(c,f,a,()=>issue(c,a,p,ib));assert.equal(replay.reused,true);assert.equal(replay.document_id,r.document_id);assert.deepEqual(await facts(c,f.tenant_id),committed,'Replay cannot allocate number, document or refund');
 await assert.rejects(tx(c,f,a,()=>issue(c,a,p,{...ib,scope_hash:'f'.repeat(64)})),violation);assert.deepEqual(await facts(c,f.tenant_id),committed);
 assert.equal((await actualDecision(c,f,a,returnId)).decision.status,'already_credited');await literal(c);
 }}finally{await c.end();}
});

test('actual Native207 rollback and current membership revocation preserve exact financial and physical facts',options,async()=>{
 const{c,cases}=await fixture();try{for(const f of cases){const a=await authority(c,f),before=await facts(c,f.tenant_id);
 await assert.rejects(tx(c,f,a,async()=>{await createSeries(c,a,{client_key:randomUUID(),name:'Seria wycofana',prefix:'ROLLBACK'});throw new Error('Controlled transaction abort');}),/Controlled transaction abort/);assert.deepEqual(await facts(c,f.tenant_id),before);
 await assert.rejects(tx(c,f,a,async()=>{await c.query("UPDATE memberships SET role='viewer' WHERE(tenant_id,user_id)=($1,$2)",[f.tenant_id,a.actor_id]);await createSeries(c,a,{client_key:randomUUID(),name:'Odmowa zapisu',prefix:'DENIED'});}),e=>e.code==='42501');assert.deepEqual(await facts(c,f.tenant_id),before);await literal(c);
 }}finally{await c.end();}
});

test('actual rejected148 reader rejects foreign authority and corrupted witnesses, snapshots, result, typed parts and immutable revisions; rollback restores full facts',options,async()=>{
 const{c,cases,rejectedOnly}=await fixture();try{for(const f of [rejectedOnly,cases.find(x=>x.no_change_physical_receipt_id)]){assert(f);const a=await authority(c,f),eid=f.no_change_physical_receipt_id;
 await tx(c,f,a,async()=>{
  const before=await facts(c,f.tenant_id);await c.query('SELECT public.return_credit206_rejected_history($1)',[eid]);
  for(const sql of [
   "UPDATE return_destination_admissions SET witnesses='[{\"table\":\"stock\",\"row\":{}}]'::jsonb WHERE(tenant_id,receipt_id)=($1,$2)",
   "UPDATE return_destination_admissions SET after_snapshot=jsonb_set(after_snapshot,'{stock,0,quantity}',to_jsonb((after_snapshot#>>'{stock,0,quantity}')::integer+1)) WHERE(tenant_id,receipt_id)=($1,$2)",
   "UPDATE return_assistant_receipts SET result=jsonb_set(result,'{refund_amount}','1'::jsonb) WHERE(tenant_id,id)=($1,$2)",
   "UPDATE return_destination_parts SET quantity=quantity+1 WHERE(tenant_id,receipt_id,id)=(SELECT tenant_id,receipt_id,id FROM return_destination_parts WHERE(tenant_id,receipt_id)=($1,$2) ORDER BY id LIMIT 1)",
   "UPDATE return_destination_status_revisions SET settings=jsonb_set(settings,'{name}','\"Changed immutable historical name\"'::jsonb) WHERE(tenant_id,id)=(SELECT tenant_id,status_revision_id FROM return_destination_parts WHERE(tenant_id,receipt_id)=($1,$2) ORDER BY id LIMIT 1)",
   "UPDATE return_destination_admissions SET after_snapshot=jsonb_set(after_snapshot,ARRAY['return_cases',(SELECT (ordinality-1)::text FROM jsonb_array_elements(after_snapshot->'return_cases')WITH ORDINALITY r(value,ordinality) WHERE value->>'id'=return_id::text),'receipt_sequence'],'1'::jsonb) WHERE(tenant_id,receipt_id)=($1,$2)",
  ]){
   await c.query('SAVEPOINT rejected_corruption');await c.query("SET LOCAL session_replication_role='replica'");assert.equal((await c.query(sql,[f.tenant_id,eid])).rowCount,1);
   await c.query("SET LOCAL session_replication_role='origin'");await literal(c);await assert.rejects(c.query('SELECT public.return_credit206_rejected_history($1)',[eid]),violation);
   await c.query('ROLLBACK TO rejected_corruption');assert.deepEqual(await facts(c,f.tenant_id),before);await c.query('SELECT public.return_credit206_rejected_history($1)',[eid]);
  }
  await c.query('SAVEPOINT rejected_role');await c.query('SET LOCAL ROLE dyna_app');await assert.rejects(c.query('SELECT public.return_credit206_rejected_history($1)',[eid]),e=>e.code==='42501');await c.query('ROLLBACK TO rejected_role');
  const other=cases.find(x=>x.tenant_id!==f.tenant_id);await c.query('SAVEPOINT rejected_tenant');await c.query("SELECT set_config('app.tenant_id',$1,true)",[other.tenant_id]);await assert.rejects(c.query('SELECT public.return_credit206_rejected_history($1)',[eid]),violation);await c.query('ROLLBACK TO rejected_tenant');
  assert.deepEqual(await facts(c,f.tenant_id),before);
 });
 }}finally{await c.end();}
});
