/** Actual exports and two isolated browser contexts; controlled storage/locks only. No split backend acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createServer,transformWithOxc} from 'vite';
const vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'});
const H=await vite.ssrLoadModule(path.resolve('web/order-split-custody.ts'));
const S=await vite.ssrLoadModule(path.resolve('server/order-splits-schema.ts'));await vite.close();
const id=n=>`${String(n).padStart(8,'0')}-1000-4000-8000-000000000001`,actor=id(1)+':'+id(2),source={id:id(3),version:'7',shipping_cost:50,items:[{id:id(20),quantity:5},{id:id(21),quantity:2}]};
const body={client_key:id(5),source_order_id:source.id,expected_source_version:'7',children:[{slot_id:id(10),name:'Zamówienie 1',delivery_minor:10,items:[{source_item_id:id(20),quantity:2}]},{slot_id:id(11),name:'Zamówienie 2',delivery_minor:20,items:[{source_item_id:id(20),quantity:1},{source_item_id:id(21),quantity:1}]}]};
const identities=[{slot_id:id(10),order_id:id(30)},{slot_id:id(11),order_id:id(31)}];
const copy=v=>structuredClone(v),serialized=JSON.stringify(body,null,2)+'\n';
const preview={schema:'order-split-custody/v1',actor,kind:'preview',serialized,source};
const executeBody={client_key:id(6),preview_id:id(40),scope_hash:'a'.repeat(64),confirmed:true};
const execute={...preview,kind:'execute',serialized:JSON.stringify(executeBody),preview:{id:id(40),scope_hash:'a'.repeat(64),serialized,children:identities}};
const authorization=()=>Promise.resolve({actor,can_write:true,read_only:false,restore_preview:false});
function outcome(intent=preview){
 const execution=intent.kind==='execute',head={id:execution?id(41):id(40),source_order_id:source.id,source_version:'7',source_result_version:execution?'8':'7',scope_hash:'a'.repeat(64),children:copy(identities),...(execution?{preview_id:id(40),state:'done'}:{ready:true})};
 const command={tenant_id:id(1),actor_id:id(2),api_key_id:null,operation:intent.kind,client_key:JSON.parse(intent.serialized).client_key,request:JSON.parse(intent.serialized),[execution?'execution':'preview']:head};
 const page=(requested_cursor,data,total,cursor)=>({requested_cursor,data,meta:{total,cursor}});
 const readback={source:{order_id:source.id,version:execution?'8':'7',item_count:2,shipping_cost:20},source_pages:[page(null,[{source_item_id:id(20),before_quantity:5,remaining_quantity:2}],2,'source-next'),page('source-next',[{source_item_id:id(21),before_quantity:2,remaining_quantity:1}],2,null)],children_pages:[page(null,[{...identities[0],delivery_minor:10,items:copy(body.children[0].items)}],2,'children-next'),page('children-next',[{...identities[1],delivery_minor:20,items:copy(body.children[1].items)}],2,null)]};
 return{head,command,readback};
}
function storage(patch={}){const map=new Map();return{map,getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k),...patch};}
const mutex=()=>{const held=new Set();return{async request(name,options,callback){assert.deepEqual(JSON.parse(JSON.stringify(options)),{mode:'exclusive',ifAvailable:true});if(held.has(name))return callback(null);held.add(name);try{return await callback({name,mode:'exclusive'});}finally{held.delete(name);}}};};

test('preview and execute retain exact bytes, all allocations and original preview identity across refresh',async()=>{
 for(const intent of [preview,execute]){const store=storage();H.retainSplitIntent(store,intent);assert.equal(H.readSplitIntent(store,actor).serialized,intent.serialized);assert.deepEqual(H.readSplitIntent(store,actor),intent);assert.throws(()=>H.retainSplitIntent(store,intent));const{command,readback,head}=outcome(intent);assert.deepEqual(H.verifySplitCommand(command,intent,readback),head);await H.clearSplitIntent(store,intent,command,readback,authorization);assert.equal(H.readSplitIntent(store,actor),null);}
});
test('strict request/source allowlist excludes customer or credential data and keeps byte/quantity bounds',()=>{
 for(const mutate of [
  v=>v.customer_name='not persisted',v=>v.source.email='not persisted',v=>v.source.items[0].sku='not persisted',
  v=>{const b=JSON.parse(v.serialized);b.password='not persisted';v.serialized=JSON.stringify(b);},
  v=>{const b=JSON.parse(v.serialized);b.children[0].address={street:'not persisted'};v.serialized=JSON.stringify(b);},
  v=>v.actor=id(99)+':'+id(2),v=>v.source.version='8',v=>v.source.items.push(copy(v.source.items[0])),
  v=>{const b=JSON.parse(v.serialized);b.children[1].slot_id=b.children[0].slot_id;v.serialized=JSON.stringify(b);},
  v=>{const b=JSON.parse(v.serialized);b.children[0].items[0].quantity=5;v.serialized=JSON.stringify(b);},
  v=>v.serialized=' '.repeat(S.ORDER_SPLIT_LIMITS.request_bytes)+v.serialized,
  v=>v.serialized=JSON.stringify({...body,children:[{...body.children[0],name:'ą'.repeat(600000)}]}),
 ]){const v=copy(preview);mutate(v);assert.throws(()=>H.validateSplitIntent(v,actor));}
 for(const v of [null,[],42,{kind:'preview'}, {...preview,serialized:'{broken'}])assert.throws(()=>H.validateSplitIntent(v,actor));
 assert.throws(()=>H.validateSplitIntent({...execute,preview:{...execute.preview,children:[identities[0],identities[0]]}},actor));
 assert.throws(()=>H.validateSplitIntent({...execute,preview:{...execute.preview,scope_hash:'b'.repeat(64)}},actor));
});
test('original delivery budget and retained source delivery are conserved without changing held body or key',async()=>{
 for(const intent of [preview,execute]){
  const store=storage(),o=outcome(intent);H.retainSplitIntent(store,intent);const raw=store.getItem(H.splitIntentKey(actor));
  o.readback.source.shipping_cost=21;
  await assert.rejects(H.clearSplitIntent(store,intent,o.command,o.readback,authorization));
  assert.equal(store.getItem(H.splitIntentKey(actor)),raw);assert.equal(H.readSplitIntent(store,actor).serialized,intent.serialized);
  const correct=outcome(intent);await H.clearSplitIntent(store,intent,correct.command,correct.readback,authorization);assert.equal(H.readSplitIntent(store,actor),null);
 }
 for(const budget of [29,-1,1.5,S.ORDER_SPLIT_LIMITS.delivery_minor+1])assert.throws(()=>H.validateSplitIntent({...preview,source:{...source,shipping_cost:budget}},actor));
 const changed=copy(preview);const b=JSON.parse(changed.serialized);b.children[1].delivery_minor=41;changed.serialized=JSON.stringify(b);assert.throws(()=>H.validateSplitIntent(changed,actor));
 assert.equal(JSON.parse(H.validateSplitIntent(preview,actor).serialized).client_key,body.client_key);
});
test('quota and failed persistence/readback prevent any controller dispatch',async()=>{
 for(const failure of ['quota','no-persist','read-fails']){
  const base=storage();let writes=0,dispatches=0;
  const store={...base,setItem(k,v){writes++;if(failure==='quota')throw Error('quota');if(failure!=='no-persist')base.setItem(k,v);},getItem(k){if(failure==='read-fails'&&writes)throw Error('readback unavailable');return base.getItem(k);}};
  await assert.rejects(H.withSplitCustodyLock(actor,async()=>{H.retainSplitIntent(store,preview);H.assertHeldSplitIntent(store,preview);dispatches++;},mutex()));assert.equal(dispatches,0);
 }
});
test('404, foreign command, partial pages or any source/child allocation drift keep original intent held',async()=>{
 const mutations=[
  o=>o.command={status:404},o=>o.command.tenant_id=id(99),o=>o.command.actor_id=id(99),o=>o.command.api_key_id=id(99),o=>o.command.client_key=id(99),
  o=>o.command.request.children[0].delivery_minor=11,o=>o.command.preview.source_order_id=id(99),o=>o.command.preview.children.pop(),
  o=>o.command.preview.children[0].order_id=source.id,o=>o.readback.source.order_id=id(99),o=>o.readback.source.version='9',
  o=>o.readback.source_pages.pop(),o=>o.readback.source_pages[1].requested_cursor='wrong',o=>o.readback.source_pages[1].data[0].source_item_id=id(20),
  o=>o.readback.source_pages[0].data[0].remaining_quantity=3,o=>o.readback.source_pages[1].data[0].before_quantity=3,
  o=>o.readback.children_pages.pop(),o=>o.readback.children_pages[1].meta.cursor='unfinished',o=>o.readback.children_pages[1].data[0].items.pop(),
  o=>o.readback.children_pages[0].data[0].order_id=id(99),o=>o.readback.children_pages[0].data[0].delivery_minor=99,
 ];
 for(const mutate of mutations){const store=storage(),o=outcome();H.retainSplitIntent(store,preview);mutate(o);let identityReads=0;await assert.rejects(H.clearSplitIntent(store,preview,o.command,o.readback,async()=>{identityReads++;return authorization();}));assert.equal(identityReads,0);assert.deepEqual(H.readSplitIntent(store,actor),preview);}
});
test('execute binds exact preview/scope and every original child order; done state alone cannot clear',async()=>{
 for(const mutate of [o=>o.command.execution.preview_id=id(99),o=>o.command.execution.scope_hash='b'.repeat(64),o=>o.command.execution.state='pending',o=>o.command.execution.source_result_version='7',o=>{[o.command.execution.children[0].order_id,o.command.execution.children[1].order_id]=[o.command.execution.children[1].order_id,o.command.execution.children[0].order_id];}]){
  const store=storage(),o=outcome(execute);H.retainSplitIntent(store,execute);mutate(o);await assert.rejects(H.clearSplitIntent(store,execute,o.command,o.readback,authorization));assert.deepEqual(H.readSplitIntent(store,actor),execute);
 }
});
test('slot identities form a bijection independent of UUID result/page ordering; changed slot binding remains held',async()=>{
 for(const intent of [preview,execute]){
  const store=storage(),o=outcome(intent);H.retainSplitIntent(store,intent);const originalSerialized=H.readSplitIntent(store,actor).serialized;
  o.head.children.reverse();o.readback.children_pages[1].data[0].items.reverse();[o.readback.children_pages[0].data,o.readback.children_pages[1].data]=[o.readback.children_pages[1].data,o.readback.children_pages[0].data];
  assert.equal(H.readSplitIntent(store,actor).serialized,originalSerialized);await H.clearSplitIntent(store,intent,o.command,o.readback,authorization);assert.equal(H.readSplitIntent(store,actor),null);
 }
 for(const mutate of [o=>o.head.children[1].slot_id=o.head.children[0].slot_id,o=>o.head.children[1].order_id=o.head.children[0].order_id,o=>o.head.children[1].slot_id=id(99),o=>{[o.readback.children_pages[0].data[0].order_id,o.readback.children_pages[1].data[0].order_id]=[o.readback.children_pages[1].data[0].order_id,o.readback.children_pages[0].data[0].order_id];}]){
  const store=storage(),o=outcome(execute);H.retainSplitIntent(store,execute);mutate(o);await assert.rejects(H.clearSplitIntent(store,execute,o.command,o.readback,authorization));assert.deepEqual(H.readSplitIntent(store,actor),execute);
 }
 const reordered=copy(execute);reordered.preview.children.reverse();assert.deepEqual(H.validateSplitIntent(reordered,actor).preview.children,reordered.preview.children);
});
test('final authorization is role-independent and changed actor, write grant, restore or readonly keep custody',async()=>{
 for(const patch of [{actor:id(1)+':'+id(99)},{can_write:false},{read_only:true},{restore_preview:true}]){const store=storage(),o=outcome();H.retainSplitIntent(store,preview);await assert.rejects(H.clearSplitIntent(store,preview,o.command,o.readback,async()=>({...await authorization(),...patch})));assert.deepEqual(H.readSplitIntent(store,actor),preview);}
 const store=storage(),o=outcome();H.retainSplitIntent(store,preview);await H.clearSplitIntent(store,preview,o.command,o.readback,authorization);assert.equal(H.readSplitIntent(store,actor),null);
});
test('storage swapped during final authorization cannot clear a different held key; remove/read failures are refused',async()=>{
 const other={...preview,serialized:JSON.stringify({...body,client_key:id(90)})};
 {const store=storage(),o=outcome();H.retainSplitIntent(store,preview);await assert.rejects(H.clearSplitIntent(store,preview,o.command,o.readback,async()=>{store.setItem(H.splitIntentKey(actor),JSON.stringify(other));return authorization();}));assert.deepEqual(H.readSplitIntent(store,actor),other);}
 {const store=storage({removeItem(){throw Error('blocked removal');}}),o=outcome();H.retainSplitIntent(store,preview);await assert.rejects(H.clearSplitIntent(store,preview,o.command,o.readback,authorization));assert.deepEqual(H.readSplitIntent(store,actor),preview);}
});
test('Web Locks unsupported/busy are failclosed, without queuing or reentrant callback execution',async()=>{
 let called=0;await assert.rejects(H.withSplitCustodyLock(actor,async()=>{called++;},null));await assert.rejects(H.withSplitCustodyLock(actor,async()=>{called++;},{request:async(_n,_o,cb)=>cb(null)}));assert.equal(called,0);
 const locks=mutex();await H.withSplitCustodyLock(actor,async()=>{await assert.rejects(H.withSplitCustodyLock(actor,async()=>{called++;},locks));},locks);assert.equal(called,0);
});
test('two isolated execution contexts share atomic actor lock: lost ACK cannot be overwritten or auto-replayed after refresh',async()=>{
 const sourceCode=fs.readFileSync(path.resolve('web/order-split-custody.ts'),'utf8');
 const transformed=(await transformWithOxc(sourceCode,'order-split-custody.ts')).code.replace(/^import[\s\S]*?from ['"]\.\.\/server\/order-splits-schema['"];?\s*/m,'').replace(/\nexport\s*\{[\s\S]*?\};?\s*$/,'').replace(/^export /gm,'');
 const script='const {ORDER_SPLIT_LIMITS:L,orderSplitPreviewInput,orderSplitExecuteInput}=S;'+transformed+';({readSplitIntent,retainSplitIntent,assertHeldSplitIntent,clearSplitIntent,withSplitCustodyLock})';
 const map=new Map(),store=()=>({getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)}),locks=mutex();let network=0;
 const tab=()=>vm.runInNewContext(script,{S,TextEncoder,structuredClone,navigator:{locks},fetch(){network++;throw Error('Custody module cannot access transport');}});
 const A=tab(),B=tab(),a=store(),b=store(),other={...preview,serialized:JSON.stringify({...body,client_key:id(90)})};let sendA=0,sendB=0,release;const pending=new Promise(r=>{release=r;});
 assert.equal(A.readSplitIntent(a,actor),null);assert.equal(B.readSplitIntent(b,actor),null);
 const first=A.withSplitCustodyLock(actor,async()=>{A.retainSplitIntent(a,preview);A.assertHeldSplitIntent(a,preview);sendA++;await pending;throw Error('ACK unknown');});const rejected=assert.rejects(first,/ACK unknown/);
 await assert.rejects(B.withSplitCustodyLock(actor,async()=>{B.retainSplitIntent(b,other);sendB++;}));assert.equal(sendA,1);assert.equal(sendB,0);release();await rejected;
 await assert.rejects(B.withSplitCustodyLock(actor,async()=>{B.retainSplitIntent(b,other);sendB++;}));assert.equal(sendB,0);assert.equal(JSON.stringify(tab().readSplitIntent(store(),actor)),JSON.stringify(preview));
 const o=outcome();await A.withSplitCustodyLock(actor,async()=>{await A.clearSplitIntent(a,preview,o.command,o.readback,authorization);});assert.equal(tab().readSplitIntent(store(),actor),null);assert.equal(network,0);
});
