/** Root-owned read-only acceptance. No provider calls, retries or business writes. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, open, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pool } from '../server/db';
const root='<workspace>/app';
const phase=process.argv[2];
const revision=process.env.QA_EXPECTED_REVISION??'';
const sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
const one=(xs:any[])=>{assert.equal(xs.length,1);return xs[0];};
async function privateRead(path:string){const s=await lstat(path);assert(s.isFile()&&!s.isSymbolicLink());assert.equal(s.mode&0o777,0o600);return readFile(path);}
async function wx(path:string,v:unknown,mode:number){const f=await open(path,'wx',mode);try{await f.writeFile(JSON.stringify(v,null,2)+'\n');await f.sync();}finally{await f.close();}}
async function get(a:any,path:string){assert(path.startsWith('/')&&!path.includes('://'));const r=await fetch('http://127.0.0.1:4100/api'+path,{headers:{cookie:a.cookie,'X-Workspace-ID':a.tenant_id},redirect:'error',cache:'no-store',signal:AbortSignal.timeout(10000)});assert.equal(r.status,200);return r.json();}
async function capture(a:any){const c=await pool.connect();try{await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await c.query("SET LOCAL TimeZone='UTC'");assert.deepEqual((await c.query('SELECT current_user role,current_database() db,host(inet_server_addr()) host,inet_server_port() port')).rows[0],{role:'postgres',db:'dynaminds',host:'127.0.0.1',port:55432});
 const names=(await c.query("SELECT table_name FROM information_schema.tables t WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name<>'sessions' AND(table_name IN('users','tenants') OR EXISTS(SELECT 1 FROM information_schema.columns k WHERE k.table_schema=t.table_schema AND k.table_name=t.table_name AND k.column_name='tenant_id')) ORDER BY table_name")).rows;
 const rows:Record<string,any[]>={},snapshot:Record<string,{count:number;sha256:string}>={};
 for(const {table_name:n}of names){assert.match(n,/^[a-z_][a-z0-9_]*$/);const key=['users','tenants'].includes(n)?'id':'tenant_id';rows[n]=(await c.query(`SELECT to_jsonb(x) row FROM "${n}" x WHERE ${key}=$1 ORDER BY 1`,[n==='users'?a.user_id:a.tenant_id])).rows.map(r=>r.row);snapshot[n]={count:rows[n].length,sha256:sha(JSON.stringify(rows[n].map(row=>({row}))))};}
 await c.query('COMMIT');return {rows,snapshot};
 }finally{await c.query('ROLLBACK').catch(()=>{});c.release();}}
function graph(a:any,rows:Record<string,any[]>,photoSha:string){const list=(n:string)=>rows[n];const order=one(list('orders'));assert.equal(order.id,a.order_id);assert.equal(order.status,'shipped');assert.equal(order.total,4401);
 const r=one(list('return_cases'));assert.equal(r.id,a.rma_id);assert.equal(r.order_id,a.order_id);assert.equal(r.state,'refund_pending');assert.equal(r.refund_amount,2700);assert.equal(r.refunded_shipping,0);assert.equal(r.remedy,'refund');assert(r.received_at);
 const s=one(list('return_assistant_sessions')),p=one(list('return_assistant_previews')),e=one(list('return_assistant_receipts')),ad=one(list('return_assistant_admissions')),ph=one(list('return_assistant_photos'));
 for(const x of[s,p,e,ad,ph])assert.equal(x.tenant_id,a.tenant_id);
 assert.equal(s.state,'completed');assert.equal(s.return_id,r.id);assert.equal(s.order_id,order.id);assert.equal(s.actor_id,a.user_id);assert.equal(s.station_id,a.station_id);
 assert.equal(p.session_id,s.id);assert.equal(e.session_id,s.id);assert.equal(e.preview_id,p.id);assert.equal(e.return_id,r.id);assert.equal(e.payload.action,'receive');assert.equal(e.scope_hash,p.scope_hash);assert.equal(ad.receipt_id,e.id);assert.equal(ad.session_id,s.id);
 assert.equal(ph.session_id,s.id);assert.equal(ph.sha256,photoSha);assert(ph.content_encrypted);assert.equal(e.payload.snapshot.photos.length,1);assert.equal(e.payload.snapshot.photos[0].sha256,photoSha);
 assert.deepEqual([e.payload.summary.requested,e.payload.summary.accepted,e.payload.summary.restocked,e.payload.summary.held,e.payload.summary.rejected,e.payload.summary.refund_minor],[3,2,1,1,1,2700]);assert.deepEqual(e.result.receipt,r.receipt);
 const ri=list('return_items');assert.equal(ri.length,2);for(const line of a.commercial_items){const item=one(ri.filter(i=>i.item_id===line.id));assert.equal(item.accepted,1);assert.equal(item.restocked,line.line_total===1000?1:0);assert.equal(item.refund_amount,line.line_total===1000?1000:1700);}
 const payments=list('payment_entries');assert.equal(payments.length,1);assert.equal(payments[0].kind,'receipt');assert.equal(payments[0].amount,4401);assert.equal(list('documents').length,0);assert.equal(r.settlement,null);assert.equal(r.refunded_at,null);
 const stock=a.components.map((c:any)=>{const st=one(list('stock').filter(x=>x.product_id===c.id&&x.warehouse_id===a.warehouse_id));assert.equal(st.reserved,0);assert.equal(st.on_hand,c.initial_quantity-2*c.recipe_quantity);const movements=list('stock_movements').filter(x=>x.product_id===c.id&&x.return_id===r.id);assert.equal(movements.length,1);assert.equal(movements[0].delta,c.recipe_quantity);return {product_id:c.id,on_hand:st.on_hand,reserved:st.reserved};});
 const fragments=list('wms_return_fragments');assert.equal(fragments.length,a.on?2:0);let knownValue=0;if(a.on){for(const f of fragments){const original=one(list('wms_issue_fragments').filter(x=>x.id===f.issue_fragment_id));assert.equal(f.return_id,r.id);assert.equal(f.layer_id,original.layer_id);assert.equal(f.product_id,original.product_id);assert.equal(Number(f.value_minor),Number(original.unit_cost_minor)*f.quantity);knownValue+=Number(f.value_minor);}assert.equal(knownValue,2000);}
 return {state:r.state,refund_minor:2700,accepted:2,restocked:1,held:1,rejected:1,receipt_id:e.id,preview_id:p.id,session_id:s.id,photo_sha256:photoSha,payment_minor:4401,cash_paid_out:0,stock,...(a.on?{known_value_minor:knownValue}:{})};}
async function main(){assert(['after-off','after-on','after-restart'].includes(phase));assert.equal(resolve(process.cwd()),root);assert.equal(process.env.DYNA_LOCAL_CONFIG_PATH,resolve(root,'.local.json'));assert.notEqual(process.env.DYNA_TEST,'true');assert.match(revision,/^[a-f0-9]{40}$/);await privateRead(resolve(root,'.local.json'));
 const setupBytes=await privateRead(resolve(root,'data/return-assistant-stage154.json')),setup=JSON.parse(setupBytes.toString());assert.equal(setup.stage,154);assert.equal(setup.complete,true);assert.equal(setup.pending,null);assert.equal(setup.actors.length,2);
 const hr=await fetch('http://127.0.0.1:4100/api/health',{signal:AbortSignal.timeout(10000)});assert.equal(hr.status,200);const h=await hr.json();assert.equal(h.revision,revision);assert.equal(h.schema_revision,'139_return_assistant');assert.equal(h.return_assistant_available,true);assert.equal(h.background_workers_enabled,false);assert.equal(h.restore_preview,false);assert.equal(h.mode,'local');
 const priorPhase=phase==='after-restart'?'after-on':phase==='after-on'?'after-off':null;
 const prior=priorPhase?JSON.parse((await privateRead(resolve(root,`data/return-assistant-checkpoint154-${priorPhase}.json`))).toString()):null;
 if(prior){assert.equal(prior.stage,154);assert.equal(prior.status,'PASS');assert.equal(prior.phase,priorPhase);assert.equal(prior.setup_file_sha256,sha(setupBytes));}
 const firms=[];for(const a of setup.actors){const captured=await capture(a);let evidence:any=null;
  if(phase==='after-off'&&a.on){for(const[n,fp]of Object.entries(a.setup_checkpoint))assert.deepEqual(captured.snapshot[n],fp,'Untouched ON fixture');assert.equal(captured.rows.return_assistant_sessions.length,0);}
  else{evidence=graph(a,captured.rows,setup.photo.sha256);const api=await get(a,'/return-assistant/receipts/'+evidence.receipt_id);assert.equal(api.receipt.id,evidence.receipt_id);assert.equal(api.return_case.state,evidence.state);assert.equal(api.session.state,'completed');assert.equal(api.receipt.can_read_value,false);const photo=await get(a,'/return-assistant/photos/'+captured.rows.return_assistant_photos[0].id+'/content');assert.equal(sha(Buffer.from(photo.content_base64,'base64')),setup.photo.sha256);assert.equal(photo.sha256,setup.photo.sha256);}
  if(prior&&(phase==='after-restart'||!a.on)){const old=one(prior.firms.filter((f:any)=>f.tenant_id===a.tenant_id));assert.deepEqual(captured.rows,old.rows);assert.deepEqual(captured.snapshot,old.snapshot);assert.deepEqual(evidence,old.evidence);}
  firms.push({tenant_id:a.tenant_id,user_id:a.user_id,order_id:a.order_id,rma_id:a.rma_id,on:a.on,...captured,evidence});
 }
 const checkpoint={stage:154,status:'PASS',phase,revision,schema_revision:h.schema_revision,setup_file_sha256:sha(setupBytes),firms};await wx(resolve(root,`data/return-assistant-checkpoint154-${phase}.json`),checkpoint,0o600);
 const report={stage:154,status:'PASS',phase,revision,schema_revision:h.schema_revision,earlier_setup_file_preserved:true,own_tables:firms.map(f=>Object.keys(f.snapshot).length),firms:firms.map(({tenant_id,on,evidence})=>({tenant_id,on,evidence})),restart_exact:phase==='after-restart',provider_calls:0,full_goal_complete:false};await wx(resolve(root,`docs/return-assistant-native154-${phase}.json`),report,0o644);process.stdout.write(JSON.stringify({status:'PASS',stage:154,phase,own_tables:report.own_tables,full_goal_complete:false})+'\n');
}
main().catch(e=>{process.stderr.write(JSON.stringify({status:'FAIL',stage:154,phase,name:e?.name??'Error',code:e?.code??null})+'\n');process.exitCode=1;}).finally(()=>pool.end());
