/** Real registry + private capture + finalizer exports, controlled query port.
 * No genuine managed lease, SQL execution, commit or Native acceptance proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'vite';
import path from 'node:path';
const vite=await createServer({server:{middlewareMode:true,hmr:false,ws:false,watch:null},appType:'custom',logLevel:'error'});
const T=await vite.ssrLoadModule(path.resolve('server/order-split-transaction.ts'));
const Transport=await vite.ssrLoadModule(path.resolve('server/order-split-transport.ts'));
await vite.close();
const id=n=>`${String(n).padStart(8,'0')}-1000-4000-8000-000000000001`;
function request(raw='PRIVATE_SESSION'){
 return Transport.captureOrderSplitRequest({actor:{tenantId:id(1),userId:id(2),role:'operator',source:'manual'},currentUser:{id:id(2),tenant_id:id(1),role:'operator'},headers:{},cookies:{dyna_session:raw}},'dyna_session',{readOnly:false});
}
function port({error,hold}={}){
 let role='dyna_app',tenant=id(1),finalized=false;const calls=[];
 const frame={owner:'postgres',root:'100',started:'2026-10-18 00:00:00+00',pid:'55',read_only:'off'};
 const c={async query(sql,args=[]){
  calls.push({sql,args:[...args],role});
  const rows=v=>({rows:v,rowCount:v.length});
  if(sql.includes('split210:context'))return rows([{...frame,role,tenant}]);
  if(sql.includes('buyer_address_identity(')){
   assert.equal(finalized,false,'No post-final IAM data read');
   return rows([{proof:{role:'operator',account_version:'1',policy:null}}]);
  }
  if(sql.includes('pg_get_userbyid(relowner)'))return rows([{...frame,role,tenant,relation_owner:'postgres'}]);
  if(sql==='RESET ROLE'){role='postgres';return rows([]);}
  if(sql.startsWith("SELECT set_config('app.tenant_id'")){tenant=args[0];return rows([]);}
  if(sql==='SET LOCAL ROLE dyna_app'){role='dyna_app';return rows([]);}
  if(sql.includes('order_split210_finalize(')){
   assert.equal(role,'postgres');if(hold)await hold;
   if(error){const e=Error('PRIVATE_NATIVE');e.code=error;throw e;}
   finalized=true;return rows([{order_split210_finalize:''}]);
  }
  assert.fail('Unexpected query '+sql);
 }};
 return{c,calls,finals:()=>calls.filter(v=>v.sql.includes('order_split210_finalize('))};
}

test('actual captured preview/execute duty survives unrelated inner cleanup and invokes the real fixed finalizer once',async()=>{
 for(const kind of ['preview','execute']){
  const p=port(),a=request('PRIVATE_'+kind);T.beginOrderSplitTransaction(p.c);
  assert.equal(T.hasOrderSplitTransactionDuty(p.c),false);
  T.enlistOrderSplitTransaction(p.c,a,kind,id(3));T.enlistOrderSplitTransaction(p.c,a,kind,id(3));
  // An inner producer returning does not clear the outer manager's ledger.
  await(async()=>{try{return 'body result';}finally{assert.equal(T.hasOrderSplitTransactionDuty(p.c),true);}})();
  await T.finalizeOrderSplitTransactionInTx(p.c);
  assert.equal(p.finals().length,1);
  assert.deepEqual(p.finals()[0].args,[kind,id(3),a.userId,null,createHash('sha256').update('PRIVATE_'+kind).digest('hex'),'operator']);
  assert(!JSON.stringify(p.calls).includes('PRIVATE_'+kind));
  await assert.rejects(T.finalizeOrderSplitTransactionInTx(p.c));
  assert.throws(()=>T.enlistOrderSplitTransaction(p.c,a,kind,id(3)));
  T.endOrderSplitTransaction(p.c);assert.equal(T.hasOrderSplitTransactionDuty(p.c),false);
 }
});

test('one command only: foreign request handle, command ID, kind and client cannot replace an existing duty',async()=>{
 const p=port(),foreign=port(),a=request(),other=request();T.beginOrderSplitTransaction(p.c);
 assert.throws(()=>T.beginOrderSplitTransaction(p.c));
 assert.throws(()=>T.enlistOrderSplitTransaction(foreign.c,a,'preview',id(3)));
 T.enlistOrderSplitTransaction(p.c,a,'preview',id(3));
 for(const [actor,kind,head] of [[other,'preview',id(3)],[{...a},'preview',id(3)],[a,'execute',id(3)],[a,'preview',id(4)],[a,'other',id(3)],[a,'preview','bad']]){
  assert.throws(()=>T.enlistOrderSplitTransaction(p.c,actor,kind,head));
 }
 await T.finalizeOrderSplitTransactionInTx(p.c);assert.deepEqual(p.finals()[0].args.slice(0,2),['preview',id(3)]);
 assert.equal(foreign.calls.length,0);T.endOrderSplitTransaction(p.c);
});

test('copied handle cannot become authority: actual finalizer rejects before a DB query; failure cannot retry',async()=>{
 const p=port(),a=request();T.beginOrderSplitTransaction(p.c);T.enlistOrderSplitTransaction(p.c,{...a},'preview',id(3));
 await assert.rejects(T.finalizeOrderSplitTransactionInTx(p.c),e=>e.status===401);
 await assert.rejects(T.finalizeOrderSplitTransactionInTx(p.c));
 assert.equal(p.calls.length,0);assert.equal(T.hasOrderSplitTransactionDuty(p.c),true);
 T.endOrderSplitTransaction(p.c);assert.equal(T.hasOrderSplitTransactionDuty(p.c),false);
});

test('Native denial stays held, rejects retry/concurrent finalization and can only be cleared by actual manager cleanup',async()=>{
 let release;const hold=new Promise(resolve=>{release=resolve;}),p=port({error:'28000',hold}),a=request();
 T.beginOrderSplitTransaction(p.c);T.enlistOrderSplitTransaction(p.c,a,'execute',id(3));
 const pending=T.finalizeOrderSplitTransactionInTx(p.c);
 await assert.rejects(T.finalizeOrderSplitTransactionInTx(p.c));
 assert.throws(()=>T.enlistOrderSplitTransaction(p.c,a,'execute',id(3)));
 release();await assert.rejects(pending,e=>e.status===401&&!e.message.includes('PRIVATE_NATIVE'));
 await assert.rejects(T.finalizeOrderSplitTransactionInTx(p.c));assert.equal(p.finals().length,1);
 assert.equal(T.hasOrderSplitTransactionDuty(p.c),true);T.endOrderSplitTransaction(p.c);
 await assert.rejects(T.finalizeOrderSplitTransactionInTx(p.c));
});

test('empty transaction has no Native/data query; end permits a new lifecycle without retaining an old command',async()=>{
 const p=port();T.beginOrderSplitTransaction(p.c);await T.finalizeOrderSplitTransactionInTx(p.c);
 assert.equal(p.calls.length,0);await assert.rejects(T.finalizeOrderSplitTransactionInTx(p.c));
 T.endOrderSplitTransaction(p.c);T.beginOrderSplitTransaction(p.c);
 assert.equal(T.hasOrderSplitTransactionDuty(p.c),false);
 T.enlistOrderSplitTransaction(p.c,request(),'execute',id(4));await T.finalizeOrderSplitTransactionInTx(p.c);
 assert.deepEqual(p.finals()[0].args.slice(0,2),['execute',id(4)]);T.endOrderSplitTransaction(p.c);
});
