/** Genuine native signup/order/address correction for the later restore-preview acceptance. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import pg from 'pg';
import {captureDatabase} from '../data/source-drafts/b2b-financial-return162-root-capture189';
const hash=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex');
const bytes=await readFile(resolve(process.argv[2]));assert.equal(hash(bytes),'c199ba86890044152bfb51b6e7443a111a3cb08c102637ff6ca1be2066682e64');const input=JSON.parse(bytes.toString());assert.equal(input.database,'dynaminds_test_1791434457369');
const cfgBytes=await readFile(input.configuration.path);assert.equal(hash(cfgBytes),input.configuration.sha256);const cfg=JSON.parse(cfgBytes.toString());
Object.assign(process.env,input.environment);process.env.DYNA_TEST='true';process.env.DYNA_IMAGE_DIR=input.images;
const directory=resolve(input.directory,'readonly-fixture1');await mkdir(directory,{mode:0o700});
async function save(n:string,v:unknown){const path=resolve(directory,n),bytes=Buffer.from(JSON.stringify(v,null,2)+'\n');await writeFile(path,bytes,{flag:'wx',mode:0o600});return{path,sha256:hash(bytes)};}
const make=()=>new pg.Client({host:'127.0.0.1',port:55432,user:'postgres',password:cfg.dbPassword,database:input.database});
async function capture(){const c=make();try{await c.connect();const r=await captureDatabase(c,false);assert.equal((await c.query('SELECT operative_delivery_valid() ok')).rows[0].ok,true);return r;}finally{await c.end();}}
const before=await capture(),beforeRef=await save('before.private.json',before);assert.equal(before.graph.rows.migrations.length,167);assert.equal(Object.keys(before.graph.rows).length,562);
const savedFetch=globalThis.fetch;let providerCalls=0;globalThis.fetch=async()=>{++providerCalls;throw Error('External fetch forbidden');};
const {pool}=await import('../server/db');const {buildApp}=await import('../server/app');const app=await buildApp({logging:false,backgroundWorkersEnabled:false,integrationTransport:async()=>{++providerCalls;throw Error('Provider transport forbidden');}});
let cookie='',result:unknown,failure:unknown;
async function ok(path:string,method:any='GET',payload?:any,status=200){const r=await app.inject({url:'/api'+path,method,payload,headers:cookie?{cookie}:{},remoteAddress:'127.0.167.21'});assert.equal(r.statusCode,status,'Genuine readonly fixture endpoint status');return r.json();}
try{
 const email='readonly167-'+randomUUID()+'@example.test',password='Readonly167!'+randomUUID();
 const signup=await app.inject({url:'/api/auth/signup',method:'POST',payload:{email,password,name:'Readonly167 operator',organization:{name:'Readonly167 '+randomUUID()}},remoteAddress:'127.0.167.21'});assert.equal(signup.statusCode,201);
 const cookies=signup.headers['set-cookie'];cookie=String(Array.isArray(cookies)?cookies[0]:cookies).split(';')[0];assert(cookie.startsWith('dyna_session='));
 const me=await ok('/auth/me'),tenant=(await ok('/workspaces')).data[0],warehouse=(await ok('/warehouses')).data[0];
 const product=await ok('/products','POST',{sku:'RO167-'+randomUUID(),name:'Readonly167 product',price:10000,vat:23,warehouse_id:warehouse.id,quantity:10,location:'A-01'},201);
 const original={recipient_name:'Original readonly167 buyer',street:'Original Road 5',city:'Gdansk',postal_code:'80-001',country:'PL',phone:'+48555123001'};
 const expected_delivery={recipient_name:'Corrected readonly167 receiver',street:'Preview Road 12',city:'Lodz',postal_code:'90-001',country:'PL',phone:'+48555123002'};
 const order=await ok('/orders','POST',{customer_name:original.recipient_name,email:'readonly-buyer167@example.test',warehouse_id:warehouse.id,payment_mode:'cod',shipping_cost:0,address:{street:original.street,city:original.city,postal_code:original.postal_code,country:original.country,phone:original.phone},items:[{product_id:product.id,quantity:1}]},201);
 await ok('/orders/'+order.id+'/buyer-address-access','PATCH',{version:Number(order.version),policy_version:0,enabled:true,delivery_kind:'address',confirmed_delivery_kind:true});
 const publicUrl='/public/orders/'+order.portal_token+'/address',status=await ok(publicUrl),preview=await ok(publicUrl+'/previews','POST',{client_key:randomUUID(),revision:status.revision,delivery:expected_delivery},201);
 await ok(publicUrl+'/previews/'+preview.id+'/apply','POST',{client_key:randomUUID(),scope_hash:preview.scope_hash,confirmed:true,local_only:true},201);
 assert.deepEqual((await ok('/orders/'+order.id)).effective_delivery.delivery,expected_delivery);
 const source=(await ok('/order-parcels/orders/'+order.id+'/source')).source;assert.deepEqual(source.operative_delivery.delivery,expected_delivery);assert.equal(source.active_plan_id,null);
 const fixture=await save('credentials.private.json',{email,password,tenant_id:tenant.id,user_id:me.user.id,order_id:order.id,expected_delivery});
 const after=await capture(),afterRef=await save('after.private.json',after);
 for(const[name,rows]of Object.entries(before.graph.rows)as[string,any[]][]){const next=new Set(after.graph.rows[name].map((r:any)=>hash(JSON.stringify(r))));for(const row of rows)assert(next.has(hash(JSON.stringify(row))),'Every existing row retained: '+name);}
 assert.deepEqual(after.graph.exact_metadata,before.graph.exact_metadata);assert.equal(hash(await readFile(input.configuration.path)),input.configuration.sha256);assert.equal(providerCalls,0);
 result={status:'ROOT_GENUINE167_READONLY_FIXTURE_PASS',database:input.database,fixture,before:beforeRef,after:afterRef,old_rows_and_metadata_retained:true,provider_requests:0,no_fake_credentials_or_session:true};
}catch(e){failure=e;await save('failure.private.json',{name:(e as any)?.name,message:(e as any)?.message,code:(e as any)?.code});}
finally{const closed=await Promise.allSettled([app.close(),pool.end()]);globalThis.fetch=savedFetch;assert(closed.every(r=>r.status==='fulfilled'));}
if(failure){console.log(JSON.stringify({status:'ROOT_GENUINE167_READONLY_FIXTURE_FAILED',directory}));process.exitCode=1;}else console.log(JSON.stringify({status:'ROOT_GENUINE167_READONLY_FIXTURE_PASS',result:await save('result.private.json',result)}));
