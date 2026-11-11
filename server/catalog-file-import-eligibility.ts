/** Native CORE read inspection candidate. No pool, SQL writes, role reset or lifecycle. */
import assert from 'node:assert/strict';
import type {PoolClient} from 'pg';
import type {Actor} from './domain';
import type {CatalogFileImportInput} from './catalog-file-import-schema';
type Ref={id:string;sha256:string;byte_count:number};type Head={id:string;actor_id:string;scope_hash:string;total:number;ready:boolean;config:unknown;preview_id?:string;state?:string};type CoreAck={head:Head;witness:Ref;reused:boolean};type CorePage={head:Head;rows:{index:number;product_id:string|null;identity_value:string|null;errors:string[];[key:string]:unknown}[];next:string|null;witness:Ref};
type Json=Record<string,any>;
export type BatchInput={index:number;request:CatalogFileImportInput;preview:{ack:CoreAck;pages:CorePage[]}};
export type Facts={schema:'catalog-core-eligibility-facts/v1';index:number;preview_id:string;scope_hash:string;request_hash:string;principal:{tenantId:string;userId:string;apiKeyId:string|null;role:'admin'};source:{frame:Json;rules:Json[];allocated_absent:string[];available_images:string[]};quota:{executions:number;previews:number;history_bytes:string;preview_bytes:string;history_per_tenant:number;history_limit_bytes:number;preview_limit_bytes:number;reserved:false};preview:{head:Json;rows:Json[]}};
/** Bind ONLY to the exact current private CORE functions in the reviewed intended server module. */
export type NativeCore={body(value:unknown):CatalogFileImportInput;parse(request:CatalogFileImportInput):unknown;hash(value:unknown):string;requireModule(c:PoolClient):Promise<void>;admission(c:PoolClient,a:Actor):Promise<void>;finalGrant(c:PoolClient,a:Actor):Promise<Actor['role']>;getHead(c:PoolClient,id:string):Promise<Json>;sourceFrame(c:PoolClient,inputs:any[],config:Json,lock:boolean):Promise<Json>;rules(c:PoolClient):Promise<Json[]>;head(p:Json):Json;publicRow(p:Json):Json;quota(c:PoolClient,kind:'executions'):Promise<void>;bytes(c:PoolClient):Promise<void>;limits:{rows:number;page_rows:number;history_per_tenant:number;history_bytes:number;preview_bytes:number}};
const snapshot=<T>(x:T):T=>structuredClone(x),publicSnapshot=(x:unknown)=>JSON.parse(JSON.stringify(x));
const uuid=(x:unknown)=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(x);
export function createCoreEligibilityInspector(native:NativeCore){
 return async(c:PoolClient,a:Actor,input:BatchInput):Promise<Facts>=>{
  input=snapshot(input);assert(Number.isSafeInteger(input.index)&&input.index>=0,'eligibility-batch-index');assert(uuid(input.preview.ack.head.id),'eligibility-preview-id');
  const state=(await c.query("SELECT current_user role,current_setting('app.tenant_id',true) tenant")).rows[0];assert(state?.role==='dyna_app'&&state.tenant===a.tenantId,'eligibility-app-role-tenant');
  const q=native.body(input.request),config=((({client_key:_k,content:_c,...rest})=>rest)(q));
  await native.requireModule(c);await native.admission(c,a);assert.equal(await native.finalGrant(c,a),'admin','eligibility-current-admin');
  const p=await native.getHead(c,input.preview.ack.head.id);
  assert(p.actor_id===a.userId&&p.client_key===q.client_key&&p.source===(a.apiKeyId?'api':'manual')&&p.ready===true,'eligibility-original-ready-preview');
  const expectedRequest=native.hash({actor:a.userId,source:a.apiKeyId?'api':'manual',config,rows:native.parse(q)});
  assert.equal(p.request_hash,expectedRequest,'eligibility-native-request-hash');assert.equal(native.hash(p.config),native.hash(config),'eligibility-native-config');
  assert.equal((await c.query('SELECT count(*)::integer n FROM catalog_file_import_executions WHERE preview_id=$1',[p.id])).rows[0]?.n,0,'eligibility-preview-already-executed');
  const stored=(await c.query('SELECT * FROM catalog_file_import_rows WHERE preview_id=$1 ORDER BY index',[p.id])).rows as Json[];
  const fields=['index','product_id','resolved_product_id','operation','identity_value','sku','current_sku','matched_historical_sku','input','before','after','changed_fields','errors'];
  const rows=stored.map(r=>Object.fromEntries(fields.map(key=>[key,r[key]])));
  assert(rows.length===p.total&&p.total>=1&&p.total<=native.limits.rows,'eligibility-complete-native-rows');
  for(const [i,row] of rows.entries())assert(row.index===i&&uuid(row.product_id)&&['create','update','unchanged'].includes(row.operation)&&Array.isArray(row.errors)&&row.errors.length===0&&row.after?.id===row.product_id&&(row.operation==='create'?row.before===null&&row.resolved_product_id===null:row.before?.id===row.product_id&&row.resolved_product_id===row.product_id),'eligibility-native-allocation');
  assert.equal(native.hash({actor:p.actor_id,rows,related:p.related_snapshot,rules:p.rules_snapshot}),p.scope_hash,'eligibility-native-scope');
  const head=publicSnapshot(native.head(p)),publicRows=stored.map(r=>publicSnapshot(native.publicRow(r)));
  assert.equal(native.hash(input.preview.ack.head),native.hash(head),'eligibility-full-public-head');assert(input.preview.ack.head.scope_hash===p.scope_hash,'eligibility-preview-scope');
  assert(input.preview.pages.length>=1&&input.preview.pages.length<=Math.ceil(native.limits.rows/native.limits.page_rows),'eligibility-page-bound');let at=0;
  for(const page of input.preview.pages){assert.equal(native.hash(page.head),native.hash(head),'eligibility-page-head');assert(page.rows.length>=1&&page.rows.length<=native.limits.page_rows,'eligibility-page-count');for(const row of page.rows){assert.equal(native.hash(row),native.hash(publicRows[at++]),'eligibility-page-row');}assert.equal(page.next,at===p.total?null:String(at),'eligibility-page-cursor');}
  assert.equal(at,p.total,'eligibility-all-pages');
  assert(Array.isArray(p.related_snapshot.identity_inputs),'eligibility-source-inputs');
  const inputs=p.related_snapshot.identity_inputs.map((r:Json)=>({identity:r.identity,explicitId:r.explicitId,patch:r.patch??{},parentRef:r.parentRef,components:r.components,errors:[]}));
  const frame=await native.sourceFrame(c,inputs,p.config,true),expected=snapshot(p.related_snapshot);delete expected.identity_inputs;
  assert.equal(native.hash(frame),native.hash(expected),'eligibility-fresh-products-aliases-dependencies-catalog');const active=await native.rules(c);assert.equal(native.hash(active),native.hash(p.rules_snapshot),'eligibility-fresh-rules');
  const allocated=rows.filter(r=>r.operation==='create').map(r=>r.product_id).sort();if(allocated.length)assert.equal((await c.query('SELECT id FROM products WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[allocated])).rows.length,0,'eligibility-allocated-id-used');
  const images=[...new Set(rows.flatMap(r=>{assert(Array.isArray(r.after.images),'eligibility-images');return r.after.images.filter((s:unknown)=>{assert(typeof s==='string','eligibility-image-url');return (s as string).startsWith('/api/');}).map((s:string)=>s.split('/').at(-1)!);} ))].sort() as string[];
  for(const image of images)assert.equal((await c.query('SELECT id FROM product_images WHERE id=$1 FOR SHARE',[image])).rows.length,1,'eligibility-image-missing');
  await native.quota(c,'executions');await native.bytes(c);
  const quota=(await c.query(`SELECT (SELECT count(*)::integer FROM catalog_file_import_executions) executions,(SELECT count(*)::integer FROM catalog_file_import_previews) previews,
   (SELECT coalesce(sum(byte_count),0)::text FROM (SELECT byte_count FROM catalog_file_import_previews UNION ALL SELECT byte_count FROM catalog_file_import_rows UNION ALL SELECT byte_count FROM catalog_file_import_executions UNION ALL SELECT byte_count FROM catalog_file_import_execution_rows) q) history_bytes,
   (SELECT p.byte_count+coalesce(sum(r.byte_count),0) FROM catalog_file_import_previews p LEFT JOIN catalog_file_import_rows r ON (r.tenant_id,r.preview_id)=(p.tenant_id,p.id) WHERE p.id=$1 GROUP BY p.byte_count)::text preview_bytes`,[p.id])).rows[0];
  assert(Number.isInteger(quota?.executions)&&quota.executions>=0&&quota.executions<native.limits.history_per_tenant&&Number.isInteger(quota.previews)&&quota.previews>=1&&quota.previews<=native.limits.history_per_tenant,'eligibility-current-history-quota');
  for(const value of [quota.history_bytes,quota.preview_bytes])assert(typeof value==='string'&&/^[0-9]+$/.test(value),'eligibility-native-byte-count');assert(BigInt(quota.history_bytes)<=BigInt(native.limits.history_bytes)&&BigInt(quota.preview_bytes)<=BigInt(native.limits.preview_bytes),'eligibility-current-bytes-quota');
  assert.equal(await native.finalGrant(c,a),'admin','eligibility-final-current-admin');
  return snapshot({schema:'catalog-core-eligibility-facts/v1',index:input.index,preview_id:p.id,scope_hash:p.scope_hash,request_hash:p.request_hash,principal:{tenantId:a.tenantId,userId:a.userId,apiKeyId:a.apiKeyId??null,role:'admin'},source:{frame,rules:active,allocated_absent:allocated,available_images:images},quota:{...quota,history_per_tenant:native.limits.history_per_tenant,history_limit_bytes:native.limits.history_bytes,preview_limit_bytes:native.limits.preview_bytes,reserved:false},preview:{head,rows:publicRows}});
 };
}
