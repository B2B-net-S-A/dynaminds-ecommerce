/** Actual app and PostgreSQL route flow: POST /mirakl/orders-stage -> offer mapping -> commit.
 * Mirakl HTTP is a controlled HTTPS/TLS fixture behind the real connector transport;
 * the A01/OR11 budget repository is in memory. No provider account, DNS or network. */
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {randomUUID} from 'node:crypto';
import type {IncomingMessage} from 'node:http';
import type {RequestOptions,request} from 'node:https';
import {buildApp} from '../server/app';
import {pool,migrate} from '../server/db';
import {seed} from './fixtures';
import {createOrdinaryConnectorTransport} from '../server/provider-read-transport';
import type {MiraklAccountCache,MiraklReadRepository} from '../server/mirakl-channel';
assert.equal(process.env.DYNA_TEST,'true');
const origin='https://import-e2e-controlled.mirakl.net',apiKey='CONTROLLED_MIRAKL_E2E_KEY';
const window={start_update_date:'2026-10-01T00:00:00Z',end_update_date:'2026-10-02T00:00:00Z'};
const account={shop_id:2000,shop_name:'Controlled shop',currency_iso_code:'PLN',shop_state:'OPEN',model:'MARKETPLACE'};
let app:any,admin:string,viewer:string,operator:string,warehouse:string,orders:unknown[]=[];
const seen:URL[]=[],claims:string[]=[];
const line=(offer:number,sku:string)=>({order_line_id:'E2E-L1-'+offer,offer_id:offer,offer_sku:sku,product_title:'Controlled product',
 quantity:2,price:20.1,shipping_price:4.9,total_price:25,order_line_state:'SHIPPING',cancelations:[],refunds:[],fees:[]});
const order=(order_id:string,offer:number,sku:string)=>({order_id,currency_iso_code:'PLN',order_state:'SHIPPING',last_updated_date:'2026-10-01T12:00:00Z',
 order_tax_mode:'TAX_INCLUDED',customer:{firstname:'Jan',lastname:'Testowy',shipping_address:{firstname:'Jan',lastname:'Testowy',
 street_1:'Testowa 1',city:'Warszawa',zip_code:'00-001',country_iso_code:'POL'}},customer_notification_email:'controlled@example.test',
 customer_debited_date:'2026-10-01T11:00:00Z',customer_directly_pays_seller:false,payment_workflow:'PAY_ON_ACCEPTANCE',payment_type:'Visa',
 fully_refunded:false,has_incident:false,price:20.1,shipping_price:4.9,total_price:25,order_lines:[line(offer,sku)]});
/** Controlled TLS socket and IncomingMessage; same shape as ordinary-connector-policy-mirakl. */
const https=((options:RequestOptions,callback:(res:IncomingMessage)=>void)=>{
 const req=Object.assign(new EventEmitter(),{end:(_body?:unknown)=>{},destroy:()=>{},setTimeout:()=>{}});
 req.end=()=>{queueMicrotask(()=>{
  const u=new URL(options.path as string,origin);seen.push(u);
  assert.equal(new Headers(options.headers as Record<string,string>).get('authorization'),apiKey);
  const data=u.pathname==='/api/account'?account:u.pathname==='/api/orders'?{orders,total_count:orders.length}:{offers:[],total_count:0};
  callback(Object.assign(Readable.from([Buffer.from(JSON.stringify(data))]),{statusCode:200,headers:{'content-type':'application/json'},
   rawHeaders:['content-type','application/json'],complete:true}) as unknown as IncomingMessage);
 });};
 queueMicrotask(()=>{const socket=Object.assign(new EventEmitter(),{encrypted:true,authorized:true,connecting:true,remoteAddress:'8.8.8.8'});
  req.emit('socket',socket);socket.connecting=false;socket.emit('secureConnect');});
 return req;
}) as unknown as typeof request;
const cache=new Map<string,MiraklAccountCache>();
const repository:MiraklReadRepository={async readAccount(k){return cache.get(k)??null;},
 async reserveRead(q){claims.push(q.operation);return{claimId:'controlled-'+claims.length};},
 async storeAccount({entry}){cache.set(entry.accountKey,structuredClone(entry));},async deferRead(){}};
const req=(url:string,method:any='GET',payload?:any,cookie=admin)=>app.inject({url,method,payload,headers:{cookie}});
async function api(url:string,method:any='GET',body?:any,cookie=admin){const r=await req(url,method,body,cookie);assert(r.statusCode<300,r.body);return r.json();}
before(async()=>{
 await migrate();await seed();
 app=await buildApp({miraklReadRepository:repository,ordinaryConnectorTransport:createOrdinaryConnectorTransport(
  {providers:[{provider:'mirakl',instanceUrl:origin,shopId:'2000',access:'read'}]},{resolve:async()=>[{address:'8.8.8.8',family:4}],request:https})});
 const login=async(email:string)=>(await req('/api/auth/login','POST',{email,password:'DynaDemo!2026'},'')).headers['set-cookie'].toString().split(';')[0];
 admin=await login('admin@demo.local');viewer=await login('viewer@demo.local');operator=await login('operator@demo.local');
 warehouse=(await api('/api/warehouses')).data[0].id;
});
after(async()=>{try{await app?.close();}finally{await pool.end();}});
const channel=async()=>(await api('/api/integrations','POST',{provider:'mirakl',name:'Mirakl E2E',mode:'live',
 credentials:{api_key:apiKey},settings:{instance_url:origin,shop_id:'2000',currency:'PLN'}})).id;
const product=async(sku:string)=>api('/api/products','POST',{sku,name:'Mirakl '+sku,price:2010,vat:23,warehouse_id:warehouse,quantity:10});
async function stage(ch:string,raw:unknown){
 orders=[raw];seen.length=claims.length=0;
 const r=await api(`/api/integrations/${ch}/mirakl/orders-stage`,'POST',{...window,max:1});
 assert.equal(r.scope,'external_read_local_stage');assert.equal(r.stages_orders,true);assert.equal(r.imports_orders,false);assert.equal(r.provider_acceptance,false);
 assert.equal(r.data.length,1);assert.equal(r.data[0].state,'staged');assert.match(r.data[0].source_hash,/^[a-f0-9]{64}$/);
 return r.data[0] as {id:string;state:string;source_hash:string};
}
const commit=(id:string,body:any,cookie=admin)=>req(`/api/imports/${id}/commit`,'POST',body,cookie);
const listings=async(ch:string)=>(await pool.query('SELECT external_id,product_id FROM listings WHERE channel_id=$1 ORDER BY external_id',[ch])).rows;

test('Mirakl offer mapping links offer_id (not offer_sku) to a local SKU; unknown SKU, wrong offer and non-admin are refused',async()=>{
 const ch=await channel(),suffix=randomUUID().slice(0,8),offer=Number('7'+String(Date.now()).slice(-8));
 const sameSku='MKL-OFFER-'+suffix,target=await product('MKL-LOCAL-'+suffix),lookalike=await product(sameSku);
 const staged=await stage(ch,order('SKU-'+suffix,offer,sameSku));
 const queue=await api(`/api/integrations/${ch}/imports`);
 const row=queue.data.find((x:any)=>x.id===staged.id);
 assert.deepEqual(row.normalized.items.map((i:any)=>({external_id:i.external_id,sku:i.sku,remote_line_id:i.remote_line_id})),
  [{external_id:String(offer),sku:sameSku,remote_line_id:'E2E-L1-'+offer}]);
 assert.deepEqual(queue.mappings,[]);
 // offer_sku equal to a local product SKU is not an implicit link: import needs a listing for offer_id.
 const unmapped=await commit(staged.id,{warehouse_id:warehouse,expected_hash:staged.source_hash});
 assert.equal(unmapped.statusCode,422,unmapped.body);assert.match(unmapped.json().detail,new RegExp('Brak powiązania oferty '+offer));
 const path=`/api/integrations/${ch}/mappings`;
 const unknown=await req(path,'POST',{external_id:String(offer),sku:'MKL-MISSING-'+suffix});
 assert.equal(unknown.statusCode,422);assert.equal(unknown.json().detail,'Nie znaleziono produktu o podanym SKU w tej organizacji');
 for(const cookie of [viewer,operator])assert.equal((await req(path,'POST',{external_id:String(offer),sku:target.sku},cookie)).statusCode,403);
 for(const body of [{external_id:'',sku:target.sku},{external_id:String(offer),sku:''},{external_id:String(offer)}])
  assert.equal((await req(path,'POST',body)).statusCode,422,JSON.stringify(body));
 assert.deepEqual(await listings(ch),[]);
 // A listing for a different offer does not satisfy this order line.
 await api(path,'POST',{external_id:String(offer+1),sku:target.sku});
 const mismatch=await commit(staged.id,{warehouse_id:warehouse,expected_hash:staged.source_hash});
 assert.equal(mismatch.statusCode,422,mismatch.body);assert.match(mismatch.json().detail,new RegExp('Brak powiązania oferty '+offer));
 const mapping=await api(path,'POST',{external_id:String(offer),sku:target.sku});
 assert.equal(mapping.product_id,target.id);assert.equal(mapping.status,'linked');assert.equal(mapping.external_id,String(offer));
 const linked=(await api(`/api/integrations/${ch}/imports`)).mappings.find((m:any)=>m.external_id===String(offer));
 assert.equal(linked.sku,target.sku);
 const imported=await commit(staged.id,{warehouse_id:warehouse,expected_hash:staged.source_hash});
 assert.equal(imported.statusCode,200,imported.body);
 const items=(await pool.query('SELECT product_id,quantity FROM order_items WHERE order_id=$1',[imported.json().id])).rows;
 assert.deepEqual(items,[{product_id:target.id,quantity:2}]);assert.notEqual(items[0].product_id,lookalike.id);
});

test('Mirakl orders.import end-to-end: trusted OR11 stage, review queue, offer mapping and Mirakl commit branch create one order',async()=>{
 const ch=await channel(),suffix=randomUUID().slice(0,8),offer=Number('8'+String(Date.now()).slice(-8)),orderId='E2E-'+suffix;
 const local=await product('MKL-E2E-'+suffix);cache.clear(); // cold account cache: A01 runs before OR11
 const staged=await stage(ch,order(orderId,offer,'SRC-'+suffix));
 // Actual connector traffic: A01 then one OR11 page for the own shop; no automatic continuation or write.
 assert.deepEqual(seen.map(u=>u.pathname),['/api/account','/api/orders']);assert.deepEqual(claims,['A01','OR11']);
 const q=seen[1].searchParams;assert.equal(q.get('shop_id'),'2000');assert.equal(q.get('max'),'1');assert.equal(q.get('offset'),'0');
 assert.equal(q.get('start_update_date'),window.start_update_date);assert.equal(q.get('end_update_date'),window.end_update_date);
 const inbound=(await pool.query('SELECT external_id,state,source_hash,raw,normalized,order_id FROM inbound_orders WHERE id=$1',[staged.id])).rows[0];
 assert.equal(inbound.external_id,orderId);assert.equal(inbound.state,'staged');assert.equal(inbound.source_hash,staged.source_hash);
 assert.equal(inbound.order_id,null);assert.match(inbound.raw._dyna_mirakl.connection_hash,/^[a-f0-9]{64}$/);
 assert.equal(inbound.normalized.total,2500);assert.deepEqual(inbound.normalized.blockers,[]);
 assert.equal((await pool.query("SELECT count(*)::int n FROM audit_events WHERE action='integration.mirakl.orders.stage' AND entity_id=$1",[ch])).rows[0].n,1);
 // The generic manual staging route is closed for Mirakl.
 assert.equal((await req(`/api/integrations/${ch}/stage-orders`,'POST',{data:[order(orderId,offer,'SRC')]})).statusCode,422);
 await api(`/api/integrations/${ch}/mappings`,'POST',{external_id:String(offer),sku:local.sku});
 // Mirakl commit branch requires the reviewed hash and an admin session before importOrder.
 const missingHash=await commit(staged.id,{warehouse_id:warehouse});
 assert.equal(missingHash.statusCode,422);assert.equal(missingHash.json().detail,'Potwierdź aktualny podgląd Mirakl');
 assert.equal((await commit(staged.id,{warehouse_id:warehouse,expected_hash:'0'.repeat(64)})).statusCode,409);
 assert.equal((await commit(staged.id,{warehouse_id:warehouse,expected_hash:staged.source_hash},viewer)).statusCode,403);
 assert.equal((await pool.query('SELECT order_id FROM inbound_orders WHERE id=$1',[staged.id])).rows[0].order_id,null);
 const r=await commit(staged.id,{warehouse_id:warehouse,expected_hash:staged.source_hash});assert.equal(r.statusCode,200,r.body);
 const created=r.json();assert.equal(created.source,'mirakl');assert.equal(created.total,2500);assert.equal(created.shipping_cost,490);
 const after=(await pool.query('SELECT state,order_id,imported_hash FROM inbound_orders WHERE id=$1',[staged.id])).rows[0];
 assert.equal(after.state,'imported');assert.equal(after.order_id,created.id);assert.equal(after.imported_hash,staged.source_hash);
 assert.deepEqual((await pool.query('SELECT product_id,quantity FROM order_items WHERE order_id=$1',[created.id])).rows,[{product_id:local.id,quantity:2}]);
 // Repeating the same reviewed commit returns the existing order without a second one.
 const again=await commit(staged.id,{warehouse_id:warehouse,expected_hash:staged.source_hash});assert.equal(again.statusCode,200,again.body);
 assert.equal(again.json().id,created.id);
 assert.equal((await pool.query("SELECT count(*)::int n FROM orders WHERE source='mirakl' AND id IN (SELECT order_id FROM inbound_orders WHERE channel_id=$1)",[ch])).rows[0].n,1);
 // Import never contacted Mirakl again.
 assert.deepEqual(seen.map(u=>u.pathname),['/api/account','/api/orders']);
});
