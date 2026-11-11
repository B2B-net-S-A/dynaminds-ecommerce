/** DRAFT future Root business ledger: fixed64 total tasks; SAME original synchronous registration/shutdown/drain contract. No adoption, PG/app or readiness. */
import assert from 'node:assert/strict';
export type RouteTaskOutcome={id:number;label:string;status:'fulfilled'|'rejected';started_ms:number;finished_ms:number;error?:unknown};
export function createRouteTasks(){
 let shutdown=false,sealed=false,next=0;const active=new Set<Promise<void>>(),outcomes:RouteTaskOutcome[]=[];
 async function start<T>(label:string,work:()=>Promise<T>,errorHandler:boolean):Promise<T>{
  assert(!sealed&&(!shutdown||errorHandler),'owned-route-shutdown-new-work-refused');assert(/^[A-Za-z0-9/_:.-]{1,240}$/.test(label));assert(next<64,'owned-route-task-limit');
  const id=++next,started_ms=performance.now();let settle!:()=>void;const done=new Promise<void>(yes=>{settle=yes;});active.add(done);
  try{const value=await work();outcomes.push({id,label,status:'fulfilled',started_ms,finished_ms:performance.now()});return value;}
  catch(error){outcomes.push({id,label,status:'rejected',started_ms,finished_ms:performance.now(),error});throw error;}
  finally{active.delete(done);settle();}
 }
 function beginShutdown(){shutdown=true;}
 async function drain(){assert(shutdown,'owned-route-drain-needs-shutdown');do{if(active.size)await Promise.all([...active]);await new Promise<void>(yes=>setImmediate(yes));}while(active.size);sealed=true;assert.equal(active.size,0);assert.equal(outcomes.length,next);return{schema:'root-owned-route-task-closure/v1' as const,shutdown_started:true,complete:true,all_producer_promises_settled:true,all_error_handler_promises_settled:true,active_tasks:0,outcomes:[...outcomes].sort((a,b)=>a.id-b.id)};}
 return Object.freeze({run:<T>(label:string,work:()=>Promise<T>)=>start(label,work,false),runError:<T>(label:string,work:()=>Promise<T>)=>start(label,work,true),beginShutdown,drain,isShuttingDown:()=>shutdown,inspect:()=>({shutdown,sealed,active_tasks:active.size,accepted_tasks:next,outcomes:[...outcomes]})});
}
