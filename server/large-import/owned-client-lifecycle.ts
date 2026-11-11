/** Private concrete-client lifetime. No connections, native authorization or app work at import. */
import assert from 'node:assert/strict';
type Endable={end():Promise<void>};
export function createOwnedClientLifecycle<C extends Endable>(connect:()=>Promise<C>,diagnostic:(e:unknown)=>void){
 const active=new Set<C>(),used=new WeakSet<C>(),pending=new Set<Promise<C>>();let closing=false,closed:Promise<void>|undefined;
 const report=(e:unknown)=>{try{diagnostic(e);}catch{}};
 function acquire(initialize:(c:C)=>Promise<void>):Promise<C>{
  assert(!closing,'local-runtime-closing');
  // Enter pending synchronously before the connector can run, including its initializer.
  // close waits this lifetime; late returned clients are owned and ended before rejection.
  const task=Promise.resolve().then(async()=>{
   const c=await connect();assert(!used.has(c),'local-owner-reused-client');used.add(c);active.add(c);
   const originalEnd=c.end.bind(c);let ending:Promise<void>|undefined,ended=false;
   c.end=()=>{if(ended)return Promise.resolve();if(ending)return ending;
    ending=Promise.resolve().then(originalEnd).then(()=>{ended=true;active.delete(c);},e=>{report(e);throw e;}).finally(()=>{ending=undefined;});return ending;
   };
   let failed=false,first:unknown;
   try{assert(!closing,'local-runtime-closing');await initialize(c);assert(!closing,'local-runtime-closing');return c;}
   catch(e){failed=true;first=e;}
   finally{if(failed)try{await c.end();}catch(e){report(e);}}
   throw first;
  });
  pending.add(task);void task.then(()=>pending.delete(task),()=>pending.delete(task));return task;
 }
 function closeAll():Promise<void>{
  if(closed)return closed;closing=true;
  closed=(async()=>{let failed=false,first:unknown;
   // No new acquisition can enter after closing. Expected failed acquisitions preserve their
   // own first cause; any returned client is either already closed or still in active below.
   await Promise.allSettled([...pending]);
   for(const c of [...active])try{await c.end();}catch(e){if(!failed){failed=true;first=e;}}
   assert.equal(pending.size,0,'local-pending-connections-after-close');
   if(failed)throw first;assert.equal(active.size,0,'local-active-connections-after-close');
  })();return closed;
 }
 return {acquire,closeAll,isClosing:()=>closing,counts:()=>({pending:pending.size,active:active.size})};
}
