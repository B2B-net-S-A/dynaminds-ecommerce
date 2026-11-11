/** SOURCE_AUTHORED_NOT_RUN: explicit scratch-DB harness, no bootstrap or fake native rows.
 * Root supplies cases produced by ordinary API after independently installing206.
 * Importing this file does not import db/config, connect, migrate or seed. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import type {PoolClient} from 'pg';
import {readHistory206PreviewLocator} from './return-credit206-api-fixture.mjs';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export type History206Case={tenant_id:string;receipt_id:string;wms:boolean};
export const history206Enabled=process.env.DYNA_RETURN_CREDIT206_TEST==='true';
export async function history206Cases():Promise<History206Case[]>{
 assert(history206Enabled,'Explicit206 scratch opt-in required');
 const file=process.env.DYNA_RETURN_CREDIT206_CASES_FILE;assert(file,'Root must provide genuine native cases');
 const getuid=process.getuid;assert(getuid,'POSIX owner identity required');
 const stat=await fs.lstat(file);assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.uid===getuid()&&(stat.mode&0o077)===0&&stat.size>0&&stat.size<4096);
 const m=JSON.parse(await fs.readFile(file,'utf8'));
 assert.equal(m.schema,'dynaminds-native-return-credit206-cases/v1');assert(Array.isArray(m.cases)&&m.cases.length===2);
 for(const c of m.cases){assert(uuid.test(c.tenant_id)&&uuid.test(c.receipt_id)&&typeof c.wms==='boolean');
  assert.equal(Object.keys(c).sort().join(','),'receipt_id,tenant_id,wms');}
 assert.deepEqual(m.cases.map((c:History206Case)=>c.wms).sort(),[false,true]);
 assert.equal(new Set(m.cases.map((c:History206Case)=>c.tenant_id)).size,2);
 return m.cases;
}
export async function withHistory206Client<T>(work:(c:PoolClient)=>Promise<T>):Promise<T>{
 assert(history206Enabled,'Explicit206 scratch opt-in required');
 const raw=process.env.DATABASE_URL;assert(raw);const u=new URL(raw);
 assert(['localhost','127.0.0.1','[::1]'].includes(u.hostname));
 if(!/^\/dynaminds_test_\d+$/.test(u.pathname)){
  const locatorFile=process.env.DYNA_RETURN_CREDIT206_PREVIEW_LOCATOR;assert(locatorFile,'Only numeric scratch or explicit preview04 locator allowed');
  const locator=await readHistory206PreviewLocator(locatorFile);assert.equal(raw,locator.databaseUrl,'Exact preview04 copy URL required');
  assert.equal(process.env.DYNA_RETURN_CREDIT206_CASES_FILE,locator.casesFile,'Exact own preview04 cases required');
 }
 const {Client}=await import('pg');const c=new Client({connectionString:raw,options:'-c timezone=UTC -c jit=off -c statement_timeout=120000 -c lock_timeout=8000'});await c.connect();
 try{const identity=(await c.query('SELECT current_database() name,current_user,session_user')).rows[0];assert.equal(identity.name,decodeURIComponent(u.pathname.slice(1)));assert.equal(identity.current_user,'postgres');assert.equal(identity.session_user,'postgres');
  return await work(c as unknown as PoolClient);
 }finally{await c.end();}
}
const tables=['orders','order_items','return_cases','return_items','return_assistant_sessions','return_assistant_previews',
 'return_assistant_receipts','return_assistant_admissions','return_destination_admissions','return_destination_parts',
 'return_destination_arrivals','return_destination_fragments','stock','stock_locations','stock_movements','stock_location_movements',
 'wms_operations','wms_return_fragments','wms_issue_fragments','wms_cost_layers','wms_layer_positions','wms_layer_movements',
 'catalog_stock_control_effect_admissions','catalog_stock_control_effects','catalog_stock_control_effect_journals',
 'catalog_stock_return_admissions','catalog_stock_return_receipts','catalog_stock_return_documents','catalog_stock_return_rows',
 'catalog_stock_return_stock_maps','catalog_stock_return_item_maps','catalog_stock_return_layer_maps',
 'local_consumer_credit_previews','local_consumer_credit_documents','local_consumer_credit_receipts',
 'local_consumer_credit_admissions','local_consumer_credit_counters','local_consumer_credit_namespaces','documents','payment_entries'];
export async function history206Facts(c:PoolClient,tenant:string){
 assert(uuid.test(tenant));const facts:Record<string,unknown>={};
 for(const name of tables){const b=(await c.query(`SELECT count(*)::int n,coalesce(sum(pg_column_size(x)),0)::text bytes FROM public.${name} x WHERE tenant_id=$1`,[tenant])).rows[0];
  assert(b.n<=10000&&BigInt(b.bytes)<=33554432n,'Controlled fixture exceeds complete-facts budget');
  facts[name]=(await c.query(`SELECT count(*)::int n,encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text),'[]')::text,'UTF8')),'hex') sha FROM public.${name} x WHERE tenant_id=$1`,[tenant])).rows[0];}
 return facts;
}
export async function begin206(c:PoolClient,tenant:string){await c.query('BEGIN');await c.query("SELECT set_config('app.tenant_id',$1,true)",[tenant]);}
export const validate206=(c:PoolClient,id:string)=>c.query('SELECT public.return_credit206_history($1)',[id]);
export async function literal188206(c:PoolClient){const r=(await c.query(`SELECT public.local_consumer_credit_guards() guards,public.ordinary188_structure_valid() structure,
 (SELECT count(*)::int FROM pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'local_consumer_credit_')) functions`)).rows[0];assert.deepEqual(r,{guards:true,structure:true,functions:20});}
