/** Import-safe genuine nonstrict ON fixture. Root-only native HTTP execution.
 * No SQL policy/session manufacture, provider, app import, seed or migration. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {FastifyInstance,InjectOptions} from 'fastify';
export async function createInventoryOnPublicFixture(args:{app:FastifyInstance;save:(name:string,value:unknown)=>Promise<unknown>;remoteAddress:string}){
 const credentials={email:'inventory-on-'+randomUUID()+'@example.test',password:'InventoryOn!'+randomUUID()};let cookie='';let serial=0;
 async function request(path:string,method:InjectOptions['method']='GET',payload?:InjectOptions['payload'],status=200){const index=serial++;await args.save('on-fixture-intent-'+index+'.private.json',{path,method,payload});const r=await args.app.inject({url:'/api'+path,method,payload,headers:cookie?{cookie}:{},remoteAddress:args.remoteAddress});await args.save('on-fixture-response-'+index+'.private.json',{status:r.statusCode,headers:r.headers,body:r.body});assert.equal(r.statusCode,status,'Genuine ON fixture '+method+' '+path);return r;}
 const signup=await request('/auth/signup','POST',{...credentials,name:'Manual inventory local QA',organization:{name:'Inventory ON public QA '+randomUUID()}},201);const set=signup.headers['set-cookie'];assert(set);cookie=String(Array.isArray(set)?set[0]:set).split(';')[0];assert(cookie.startsWith('dyna_session='));
 const me=(await request('/auth/me')).json();assert.equal(me.user.role,'admin');const tenant=me.user.tenant_id,user=me.user.id;
 const warehouses=(await request('/warehouses')).json().data;assert.equal(warehouses.length,1);const warehouse=warehouses[0];
 const product=(await request('/products','POST',{sku:'MANUAL-ON-'+randomUUID(),name:'Physical manual ON correction',price:987,vat:23,warehouse_id:warehouse.id,quantity:10,location:'A-01'},201)).json();
 const metadata=(await request('/wms-lots')).json();assert.equal(metadata.policy.enabled,false);const scope=(await request('/wms-lots/opening-scope')).json();assert.deepEqual(scope.active_blockers,[]);assert.equal(scope.meta.cursor,null);assert.equal(scope.data.length,1);
 const bin=scope.data[0];assert.equal(bin.product_id,product.id);assert.equal(bin.warehouse_id,warehouse.id);assert.equal(bin.location,'A-01');assert.equal(bin.quantity,10);
 const previewRequest={client_key:randomUUID(),policy_version:metadata.policy.version,currency:'PLN',note:'Explicit local fixture opening stock cost',lines:[{warehouse_id:bin.warehouse_id,product_id:bin.product_id,location:bin.location,quantity:bin.quantity,stock_version:bin.stock_version,lot_code:'OPEN-'+randomUUID(),unit_cost_minor:'100'}]};
 const preview=(await request('/wms-lots/opening-previews','POST',previewRequest,201)).json().preview;assert.equal(preview.ready,true);const consent={client_key:randomUUID(),scope_hash:preview.scope_hash,confirmed:true,ack_unknown_costs:false};
 const activation=(await request('/wms-lots/opening-previews/'+preview.id+'/activate','POST',consent,201)).json();assert.equal(activation.reused,false);assert.equal((await request('/wms-lots')).json().policy.enabled,true);
 const key=(await request('/developer/keys','POST',{name:'Public inventory ON acceptance',scopes:['inventory:read','inventory:write','purchasing:read','purchasing:write'],expires_days:1},201)).json();assert.equal(typeof key.token,'string');assert(key.token.startsWith('dyna_api_'));
 const fixture={tenantId:tenant,userId:user,ownerCookie:cookie,sessionName:'dyna_session',apiToken:key.token,productId:product.id,warehouseId:warehouse.id,location:'A-01',strict:false,currency:'PLN' as const};
 await args.save('on-public-fixture.private.json',{credentials,fixture,product,warehouse,scope,preview_request:previewRequest,preview,activation_request:consent,activation,key_id:key.id});return fixture;
}
