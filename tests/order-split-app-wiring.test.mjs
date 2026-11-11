/** Actual app/db/UI source with controlled dependencies only. No real database,
 * construction lease, HTTP server, Native210 or browser acceptance is claimed. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import React from 'react';
import {transformWithOxc} from 'vite';
const db=readFileSync(new URL('../server/db.ts',import.meta.url),'utf8');
const app=readFileSync(new URL('../server/app.ts',import.meta.url),'utf8');
const main=readFileSync(new URL('../web/main.tsx',import.meta.url),'utf8');
function span(s,a,b){const x=s.indexOf(a),y=s.indexOf(b,x+a.length);assert(x>=0&&y>x);return s.slice(x,y);}
const js=async(s,file='actual-split-wiring.ts')=>(await transformWithOxc(s,file,{jsx:{runtime:'classic'}})).code.replace(/^export /gm,'');
const helper=await js(span(db,'async function preflightOrderSplitConstruction(', '/** Construction-only owner.'));
const construction=await js(span(db,'export async function preflightOrdinaryConstructionPim(', '/** Synchronously seals'));
const rows=v=>({rows:v});
const present={present:true,manifest:'order_split210_manifest',guard:'order_split210_valid()'};
function probe(metadata=[present],value=[{available:true}]){
 const queries=[];const c={async query(sql){queries.push(sql);if(sql==="SET LOCAL statement_timeout TO '8s'")return rows([]);if(queries.length===2)return rows(metadata);if(value instanceof Error)throw value;return rows(value);}};
 const run=new Function(helper+';return preflightOrderSplitConstruction;')();return {queries,run:()=>run(c)};
}
test('actual construction probe: absent209 installation never calls split Native guard',async()=>{
 const p=probe([{present:false,manifest:null,guard:null}]);assert.equal(await p.run(),false);assert.equal(p.queries.length,2);
 for(const catalog of ['pg_class','pg_proc','pg_type','pg_constraint','pg_trigger'])assert(p.queries[1].includes('pg_catalog.'+catalog));
 assert(p.queries[1].includes("'_order_split210_'"));
});
test('actual construction probe: namespace fragment, malformed roster and contradictory absence refuse',async()=>{
 for(const metadata of [[],[present,present],[{...present,guard:null}],[{...present,manifest:null}],[{present:false,manifest:present.manifest,guard:null}],[{...present,present:'true'}],[{...present,extra:true}]]){
  const p=probe(metadata);await assert.rejects(p.run());assert.equal(p.queries.length,2);
 }
});
test('actual construction probe: only one exact Native boolean true enables; false/errors cannot hide corruption',async()=>{
 const good=probe();assert.equal(await good.run(),true);assert.equal(good.queries[2],'SELECT public.order_split210_valid() AS available');
 for(const value of [[],[{available:false}],[{available:null}],[{available:'true'}],[{available:1}],[{available:true,extra:1}],[{available:true},{available:true}]])await assert.rejects(probe([present],value).run(),/Invalid split210 Native installation/);
 const original=Error('ACTUAL_NATIVE_FAILURE');await assert.rejects(probe([present],original).run(),e=>e===original);
});
function owned({installed=true,metadata=present,guard=true,guardError,rollbackError}={}){
 const events=[];const scope=installed?{open:true,busy:false,databaseUrl:'postgres://controlled',owner:'postgres',database:'controlled',port:57084,owners:new Set(),gate:{async reserve(c){events.push('reserve');return{async enter(){events.push('enter');},async close(){events.push('lease-close');}};}}}:undefined;
 class Client{async connect(){events.push('connect');}async end(){events.push('end');}async query(sql){
  events.push(sql);
  if(sql.startsWith('SELECT current_user'))return rows([{owner:'postgres',session_owner:'postgres',database:'controlled',port:57084,address:'127.0.0.1'}]);
  if(sql.startsWith('SELECT\n'))return rows([metadata]);
  if(sql==='SELECT public.order_split210_valid() AS available'){if(guardError!==undefined)throw guardError;return rows([{available:guard}]);}
  if(sql==='ROLLBACK'&&rollbackError)throw rollbackError;
  return rows([]);
 }}
 const ports={pg:{Client},ordinaryConstructionPimScope:scope,assert,assertOwnedOrdinarySchemaTransactionGate:g=>assert.equal(g,scope.gate),preflightPim:async()=>{events.push('pim');return true;},preflightNestedPim:async(c,available)=>{assert.equal(available,true);events.push('nested');return false;}};
 const run=new Function(...Object.keys(ports),helper+construction+';return preflightOrdinaryConstructionPim;')(...Object.values(ports));
 return{run,events,scope};
}
test('actual owned preflight extends the original result inside same READ ONLY lease and closes without COMMIT',async()=>{
 const h=owned();assert.deepEqual(await h.run(),{pimAvailable:true,nestedAvailable:false,orderSplitsAvailable:true});
 const e=h.events;assert.equal(e.filter(v=>v==="SET LOCAL statement_timeout TO '8s'").length,1);assert(e.indexOf('nested')<e.indexOf("SET LOCAL statement_timeout TO '8s'"));assert(e.indexOf("SET LOCAL statement_timeout TO '8s'")<e.findIndex(v=>v.startsWith('SELECT\n')));assert(e.indexOf('reserve')<e.indexOf('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY'));assert(e.indexOf('enter')<e.indexOf('pim'));assert(e.indexOf('nested')<e.indexOf('SELECT public.order_split210_valid() AS available'));
 assert.deepEqual(e.slice(-3),['ROLLBACK','lease-close','end']);assert(!e.includes('COMMIT'));assert.equal(h.scope.busy,false);assert.equal(h.scope.owners.size,0);
 const absent=owned({metadata:{present:false,manifest:null,guard:null}});assert.equal((await absent.run()).orderSplitsAvailable,false);
 const legacy=owned({installed:false});assert.equal(await legacy.run(),undefined);assert.deepEqual(legacy.events,[]);
});
test('actual owned preflight fails startup, preserves primary even falsy errors and always tears down',async()=>{
 for(const options of [{guard:false},{metadata:{...present,guard:null}},{guardError:0,rollbackError:Error('SECONDARY_ROLLBACK')}]){
  const h=owned(options);let failed=false,error;try{await h.run();}catch(e){failed=true;error=e;}assert(failed);if(options.guardError===0)assert.equal(error,0);
  assert.deepEqual(h.events.slice(-3),['ROLLBACK','lease-close','end']);assert.equal(h.scope.busy,false);assert.equal(h.scope.owners.size,0);
 }
});
test('actual app registration and health use strict computed construction result; no route test-port override',()=>{
 const select=span(app,'const orderSplitsIsAvailable =','\n  const pimDictionaries');
 const registration=app.match(/^  if \(orderSplitsIsAvailable\) registerOrderSplitRoutes\(app, \{ readOnly, sessionName \}\);$/m)?.[0];assert(registration);
 for(const result of [undefined,{}, {orderSplitsAvailable:false},{orderSplitsAvailable:'true'},{orderSplitsAvailable:true}]){
  const calls=[];const enabled=new Function('constructionPim','app','readOnly','sessionName','registerOrderSplitRoutes',select+registration+';return orderSplitsIsAvailable;')(result,{},true,'dyna_session',(...args)=>calls.push(args));
  assert.equal(enabled,result?.orderSplitsAvailable===true);assert.equal(calls.length,Number(enabled));if(enabled)assert.deepEqual(calls[0][1],{readOnly:true,sessionName:'dyna_session'});
 }
 assert(app.includes('order_splits_available: orderSplitsIsAvailable,'));
});
const card=readFileSync(new URL('../web/order-card.tsx',import.meta.url),'utf8');
const wrapperJs=await js(span(card,'function OrderSplitDetailPanel(', '\nexport function OrderDetail('),'actual-order-detail-split.tsx');
const OrderSplitPanel=()=>null;
const wrapper=new Function('React','OrderSplitPanel',wrapperJs+';return OrderSplitDetailPanel;')(React,OrderSplitPanel);
const original={id:'source',version:9,currency:'PLN',shipping_cost:7,customer_token:'PRIVATE',items:[{id:'line',name:'Towar',sku:'SKU',quantity:3,price:123,line_total:369,cost:99}]};
test('actual order detail wrapper maps public current source, strict availability and readOnly to existing panel',()=>{
 for(const available of [false,undefined,'true'])assert.equal(wrapper({available,order:null}),null);
 const element=wrapper({available:true,order:original,contextKey:'tenant:user:operator',readOnly:true});assert.equal(element.type,OrderSplitPanel);
 assert.deepEqual(element.props.source,{order_id:'source',version:'9',currency:'PLN',shipping_cost:7,items:[{id:'line',name:'Towar',sku:'SKU',quantity:3,price:123,line_total:369}]});
 assert.equal(element.props.readOnly,true);assert.equal(element.props.contextKey,'tenant:user:operator');assert(!JSON.stringify(element.props).includes('PRIVATE'));assert(!Object.hasOwn(element.props.source.items[0],'cost'));
});
test('actual retained-source result navigation re-reads source before opening and preserves existing guarded panel',()=>{
 const calls=[];const element=wrapper({available:true,order:original,contextKey:'scope',readOnly:false,onRefresh:()=>calls.push('reload'),onOpenOrder:id=>calls.push(id)});
 element.props.onOpenOrder(original.id);assert.deepEqual(calls,['reload','source']);
 const mount=span(card,'<OrderSplitDetailPanel available={splitAvailable}', '<BuyerAddressPanel');
 for(const lock of ['readOnly','!write','detailWriteBlocked','warehousePolicyWriteBlocked','orderPrintLocked','inboundLocked'])assert(mount.includes(lock));
 assert(main.includes('orderSplitCapability?.scope===currentActorScope&&orderSplitCapability.available===true'));
});
test('actual health/me callback requires strict runtime flag and matching current tenant/user/role/restore state',()=>{
 const code=span(main,'const sameImportContext=','\n          const ownImportAvailable');
 const user={id:'user',tenant_id:'tenant',role:'operator'};const me={user:{...user},restore_preview:false};
 for(const [h,scoped,expected]of [[{order_splits_available:true,restore_preview:false},me,true],[{order_splits_available:'true',restore_preview:false},me,false],[{order_splits_available:true},me,false],[{order_splits_available:true,restore_preview:false},{...me,user:{...user,tenant_id:'foreign'}},false],[{order_splits_available:true,restore_preview:false},{...me,restore_preview:true},false],[{order_splits_available:true,restore_preview:false},null,false]]){
  let saved;new Function('user','h','scoped','currentActorScope','setOrderSplitCapability',code)(user,h,scoped,'scope',v=>saved=v);assert.deepEqual(saved,{scope:'scope',available:expected});
 }
});
