/** SOURCE_AUTHORED / NOT_RUN. Import-safe native fixture, not an actor factory.
 * Root owns fresh numeric DB/bootstrap/config before passing the actual app/pool.
 * No SQL source-parent inserts, provider transport, migration or global-role changes.
 * Genuine catalog jobs are leased only after their ordinary refresh endpoint creates them.
 */
import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import type {FastifyInstance, InjectOptions} from 'fastify';
import type {Pool} from 'pg';

export type Row = Record<string, any>;
export type NativeActor = Awaited<ReturnType<typeof ordinarySignup>>;
export type NativeDependencies = Readonly<{
 app: FastifyInstance;
 pool: Pool;
 processB2bCatalog: (actualJob: Row) => Promise<unknown>;
}>;
const one = (rows: Row[]) => {assert.equal(rows.length, 1); return rows[0];};
let addressCounter=0;
const seller = {name:'Synthetic FA3 native seller',tax_id:'5252445767',street:'Seller street 158',postal_code:'00-158',city:'Warszawa',country:'PL'};
export const explicitBusiness = Object.freeze({kind:'business',name:'Synthetic FA3 firm bill-to',tax_id:'1234563218',address:{country:'PL',line1:'Firm billing street 158',line2:'00-158 Warszawa'}});
export const ordinaryScope = Object.freeze({cash_method:false,self_billing:false,reverse_charge:false,split_payment:false,exemption:false,new_transport:false,triangular:false,margin:false,jst:false,vat_group:false,advance:false});

/** Every authorization below is a real ordinary signup cookie. It is private and
 * must never be included in public logs, assertions, artifacts or transport bodies. */
export async function ordinarySignup(app: FastifyInstance, label: string) {
 const email='own-fa3-'+randomUUID()+'@example.invalid', password='OwnFA3!'+randomBytes(20).toString('hex');
 let cookie='';const remoteAddress='127.158.'+Math.floor(++addressCounter/250)+'.'+(addressCounter%250+1);
 async function request(path:string, method:InjectOptions['method']='GET', body?:Row, authorization?:{token:string}) {
  assert(path.startsWith('/')&&!path.startsWith('//'));
  return app.inject({url:'/api'+path,method,payload:body,remoteAddress,headers:authorization?{authorization:'Bearer '+authorization.token}:{...(cookie?{cookie}:{})}});
 }
 async function ok(path:string,method:InjectOptions['method']='GET',body?:Row,status=200,authorization?:{token:string}) {
  const r=await request(path,method,body,authorization);
  // Do not echo arbitrary response/request payload, headers, cookies or keys.
  assert.equal(r.statusCode,status,method+' '+path+' HTTP'+r.statusCode);
  return r.json() as Row;
 }
 const r=await request('/auth/signup','POST',{name:'Own native '+label,email,password,organization:{name:'Own FA3 '+label+' '+randomUUID(),currency:'PLN',locale:'pl-PL'}});
 assert.equal(r.statusCode,201);const data=r.json() as Row;
 assert(typeof r.headers['set-cookie']==='string');cookie=String(r.headers['set-cookie']).split(';')[0];
 assert(cookie.startsWith('dyna_session='));assert.equal(typeof data.user.id,'string');assert.equal(typeof data.user.tenant_id,'string');
 const warehouse=one((await ok('/warehouses')).data);
 return {email,user:data.user.id,tenant:data.user.tenant_id,warehouse,request,ok};
}

export async function sellerSeries(a:NativeActor) {
 const body={client_key:randomUUID(),name:'Source-only FA3 seller definition',prefix:'FA'+randomUUID().replaceAll('-','').slice(0,8).toUpperCase(),seller,seller_vat_status:'active_domestic',payment_terms_days:7,payment_instructions:'Own synthetic paid sale',notes:'FA3 project only, no FV/KSeF issue'};
 const r=await a.ok('/local-invoices/series','POST',body,201);
 assert.deepEqual(r.series.seller,seller);assert.equal(r.series.seller_vat_status,'active_domestic');
 return {series:r.series,body};
}

export async function paidAndShipped(a:NativeActor, orderId:string) {
 let o=await a.ok('/orders/'+orderId);assert.equal(o.status,'new');
 await a.ok('/orders/'+o.id+'/payments','POST',{client_key:randomUUID(),version:Number(o.version),kind:'receipt',amount:o.total,currency:o.currency,method:'other',reference:'Actual synthetic native FA3 payment',confirmed:true});
 await a.ok('/orders/'+o.id+'/status','PATCH',{status:'picking'});
 for(const item of o.items)for(let n=0;n<item.quantity;n++)await a.ok('/orders/'+o.id+'/scan','POST',{client_key:randomUUID(),code:item.sku,location:'A-01'});
 await a.ok('/orders/'+o.id+'/status','PATCH',{status:'packed'});
 await a.ok('/orders/'+o.id+'/ship-demo','POST',{});
 o=await a.ok('/orders/'+o.id);assert.equal(o.status,'shipped');assert.equal(o.fulfillment_kind,'sale');return o;
}

export function nativePreviewBody(order:Row, series:Row, buyer:Row) {
 return {client_key:randomUUID(),order_id:order.id,order_version:String(order.version),seller_series_id:series.id,sale_date:new Date(order.created_at).toISOString().slice(0,10),buyer,shipping_vat:8,
  zero_basis:order.items.filter((i:Row)=>i.vat===0).map((i:Row)=>({item_id:i.id,basis:'Ordinary domestic zero-rated synthetic source, not VAT exemption'})),ordinary_scope:{...ordinaryScope},confirmed_ordinary_domestic_business_sale:true};
}

/** Explicit firm NIP/address is approved separately from historical ship-to.
 * Different product IDs preserve actual commercial row IDs (createOrder merges
 * duplicate product IDs). Gross values deliberately cross VAT and cent boundaries. */
export async function ordinaryShippedFixture(d:NativeDependencies) {
 const actor=await ordinarySignup(d.app,'ordinary firm'),products:Row[]=[];
 for(const [price,vat]of [[1001,23],[1501,8],[2001,0]])products.push(await actor.ok('/products','POST',{name:'Frozen <FA3 item> '+vat,sku:'FA3-'+randomUUID(),price,vat,warehouse_id:actor.warehouse.id,quantity:5,location:'A-01'},201));
 const source=await actor.ok('/orders','POST',{source:'manual',customer_name:'Historical ship-to receiver',email:actor.email,address:{street:'Different receiving street 9',postal_code:'00-159',city:'Warszawa',country:'PL',phone:'500000158'},warehouse_id:actor.warehouse.id,payment_mode:'prepaid',currency:'PLN',shipping_cost:999,items:products.map((p,n)=>({product_id:p.id,quantity:n===0?2:1}))},201);
 const order=await paidAndShipped(actor,source.id);assert.equal(order.total,6503);assert.equal(order.items.length,3);assert.equal(order.b2b_account_id,null);assert.equal(order.b2b_snapshot,null);
 const {series,body:seriesBody}=await sellerSeries(actor);
 return {actor,products,order,series,seriesBody,body:nativePreviewBody(order,series,{kind:'ordinary_explicit',party:explicitBusiness,confirmed:true})};
}

/** Native108 supplier protocol: real account activation/invite/accept, actual
 * catalog worker/publication/import, actual quote+checkout+typed supplier bridge,
 * then supplier payment/scan/dispatch. Neither private parent nor quote is seeded. */
export async function supplierDropshipFixture(d:NativeDependencies) {
 const supplier=await ordinarySignup(d.app,'supplier'),buyer=await ordinarySignup(d.app,'purchasing firm');
 const product=await supplier.ok('/products','POST',{name:'Actual supplier product',sku:'SUP-FA3-'+randomUUID(),price:1900,vat:23,warehouse_id:supplier.warehouse.id,quantity:20,location:'A-01'},201);
 const list=await supplier.ok('/price-lists','POST',{name:'Actual wholesale PLN '+randomUUID(),currency:'PLN'},201);
 await supplier.ok('/price-lists/'+list.id+'/items','PUT',{version:list.version,items:[{product_id:product.id,price:700}]});
 const accountBody={name:explicitBusiness.name,email:buyer.email,tax_id:explicitBusiness.tax_id,warehouse_id:supplier.warehouse.id,price_list_id:list.id,address:{street:explicitBusiness.address.line1,city:'Warszawa',postal_code:'00-158',country:'PL'},min_total:0,min_quantity:1,quantity_step:1,shipping_cost:0,payment_mode:'prepaid'};
 const account=await supplier.ok('/b2b/accounts','POST',accountBody,201);
 const enabled=await supplier.ok('/b2b/accounts/'+account.id,'PATCH',{...accountBody,version:account.version,active:true,confirmed:true});
 const invite=await supplier.ok('/b2b/accounts/'+account.id+'/network-invite','POST',{version:enabled.version,recipient_email:buyer.email,confirmed:true});
 const link=await buyer.ok('/b2b/network/accept','POST',{token:invite.token,confirmed:true});const base='/b2b/network/links/'+link.id;
 const run=await buyer.ok(base+'/refresh','POST',{client_key:randomUUID(),confirmed:true});
 let done=false;
 for(let page=0;page<5;page++) {
  const saved=one((await d.pool.query('SELECT * FROM b2b_catalog_runs WHERE id=$1 AND tenant_id=$2',[run.id,buyer.tenant])).rows);
  if(saved.state==='done'){done=true;break;}assert.equal(saved.state,'queued');
  const lease=randomUUID(),job=one((await d.pool.query("UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$2,locked_at=clock_timestamp() WHERE id=$1 AND tenant_id=$3 AND state='pending' RETURNING *",[saved.job_id,lease,buyer.tenant])).rows);
  assert.equal(job.payload.run_id,run.id);assert.equal(job.payload.link_id,link.id);assert.equal(job.kind,'b2b.catalog');
  // Real native processor owns publication, run transition and lease completion.
  await d.processB2bCatalog(job);
 }
 if(!done)done=one((await d.pool.query('SELECT state FROM b2b_catalog_runs WHERE id=$1',[run.id])).rows).state==='done';assert(done);
 const item=one((await buyer.ok(base+'/catalog')).data.filter((i:Row)=>i.source_product_id===product.id));
 const imported=await buyer.ok(base+'/catalog/'+item.id+'/product','POST',{version:item.version,sku:'BUY-FA3-'+randomUUID(),sale_price:2500,warehouse_id:buyer.warehouse.id,confirmed:true});
 const local=await buyer.ok('/products/'+imported.product_id);
 const receipt=await buyer.ok('/warehouse-documents','POST',{kind:'receipt',warehouse_id:buyer.warehouse.id,reference:'Native buyer source stock',note:'Synthetic fixture before dropship quote',lines:[{product_id:local.id,quantity:5,location:'A-01'}]},201);
 await buyer.ok('/warehouse-documents/'+receipt.id+'/post','POST',{version:receipt.version});
 const customer=await buyer.ok('/orders','POST',{source:'manual',customer_name:'Consumer receiving a wholesale supplier parcel',email:buyer.email,address:{street:'Consumer receiving street 9',postal_code:'00-159',city:'Warszawa',country:'PL',phone:'500000159'},warehouse_id:buyer.warehouse.id,payment_mode:'prepaid',currency:'PLN',shipping_cost:900,items:[{product_id:local.id,quantity:2}]},201);
 const quoteBody={client_key:randomUUID(),customer_order_id:customer.id,items:[{customer_item_id:one(customer.items).id,quantity:2,mappings:[{product_id:local.id,catalog_item_id:item.id}]}]};
 const quote=(await buyer.ok(base+'/dropshipping/quotes','POST',quoteBody,201)).quote;
 assert.equal(quote.wholesale.bill_to.tax_id,explicitBusiness.tax_id);assert.equal(quote.wholesale.total_minor,'1400');assert.notDeepEqual(quote.receiver.address,quote.wholesale.bill_to.address);
 const consent={client_key:randomUUID(),scope_hash:quote.scope_hash,confirmed:true,confirmed_receiver:true};
 const parent=(await buyer.ok(base+'/dropshipping/quotes/'+quote.id+'/checkout','POST',consent,201)).order;
 const order=await paidAndShipped(supplier,parent.supplier_order_id);assert.equal(order.total,1400);assert.equal(order.items.length,1);assert.equal(one(order.items).quantity,2);
 // Three native readbacks share an owned READ ONLY UTC transaction. Preserve
 // literal PostgreSQL microseconds and every field; no Date coercion/omission.
 const native=await d.pool.connect();let bridge:Row,actualParent:Row,actualQuote:Row;
 try {
  await native.query('BEGIN READ ONLY');await native.query("SET LOCAL TimeZone='UTC'");
  bridge=one((await native.query('SELECT to_jsonb(s) row FROM b2b_dropship_supplier_orders s WHERE(tenant_id,order_id)=($1,$2)',[supplier.tenant,order.id])).rows).row;
  actualParent=one((await native.query('SELECT to_jsonb(s) row FROM b2b_dropship_orders s WHERE(tenant_id,id)=($1,$2)',[buyer.tenant,parent.id])).rows).row;
  actualQuote=one((await native.query('SELECT to_jsonb(s) row FROM b2b_dropship_quotes s WHERE(tenant_id,id)=($1,$2)',[buyer.tenant,quote.id])).rows).row;
  await native.query('COMMIT');
 }catch(error){await native.query('ROLLBACK');throw error;}finally{native.release();}
 assert.equal(actualParent.supplier_order_id,order.id);assert.equal(actualParent.supplier_tenant_id,supplier.tenant);assert.equal(actualParent.customer_order_id,customer.id);assert.equal(actualParent.quote_id,quote.id);assert.equal(actualParent.state,'ordered');
 assert.equal(bridge.buyer_tenant_id,buyer.tenant);assert.equal(bridge.dropship_order_id,parent.id);assert.deepEqual(bridge.bill_to,actualQuote.snapshot.wholesale.bill_to);assert.deepEqual(bridge.receiver,actualQuote.snapshot.receiver);
 const {series,body:seriesBody}=await sellerSeries(supplier);
 return {actor:supplier,buyer,product,local,customer,account:enabled,list,link,catalogRun:run,quote,quoteBody,parent,actualParent,actualQuote,bridge,order,series,seriesBody,body:nativePreviewBody(order,series,{kind:'dropship_frozen'})};
}
