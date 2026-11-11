/** Bounds current requests/work and a summary ring; total admission has no lifetime cap. */
import assert from 'node:assert/strict';
import type {FastifyInstance} from 'fastify';
import {Problem} from './errors';
declare const brand:unique symbol;
export type OrdinaryRequestLifetime=Readonly<{schema:'ordinary-request-lifetime/v1';readonly [brand]:true}>;
type Outcome={id:string;label:string;status:'fulfilled'|'rejected'};
type RequestState={finished:boolean;awaitingError:boolean;errorStageDone:boolean;pending:number;released:boolean;releaseQueued:boolean;settle:()=>void;done:Promise<void>;errorStageActive:boolean;cleanupIdentity:Function|undefined;cleanups:WeakMap<Function,Promise<void>>};
type State={closing:boolean;sealed:boolean;next:bigint;active:Set<Promise<void>>;normalActive:number;errorActive:number;responseActive:number;cleanupActive:number;errorWaiters:Array<()=>void>;requestActive:number;refusedAdmissions:number;requests:WeakMap<object,RequestState>;outcomes:Outcome[];cleanupFailed:boolean;cleanupFirst:unknown;lateFailures:number};
const apps=new WeakMap<FastifyInstance,OrdinaryRequestLifetime>();
const states=new WeakMap<OrdinaryRequestLifetime,State>();
const ACTIVE_NORMAL=128,ACTIVE_ERRORS=32,ACTIVE_REQUESTS=128,RETAINED=128;
function state(handle:OrdinaryRequestLifetime){const s=states.get(handle);assert(s,'ordinary-original-lifetime-required');return s;}
function refused(code:string){return new Problem(503,'Serwer kończy pracę lub ma zbyt wiele aktywnych żądań',code);}
export function createOrdinaryRequestLifetime():OrdinaryRequestLifetime{
 const handle=Object.freeze({schema:'ordinary-request-lifetime/v1' as const}) as OrdinaryRequestLifetime;
 states.set(handle,{closing:false,sealed:false,next:0n,active:new Set(),normalActive:0,errorActive:0,responseActive:0,cleanupActive:0,errorWaiters:[],requestActive:0,refusedAdmissions:0,requests:new WeakMap(),outcomes:[],cleanupFailed:false,cleanupFirst:undefined,lateFailures:0});return handle;
}
function release(s:State,r:RequestState){
 if(r.finished&&!r.awaitingError&&r.pending===0&&!r.released&&!r.releaseQueued){
  // Fastify schedules the next response/error hook after the previous hook callback.
  // Keep the authentic token across that continuation; every actual async body has its own pending slot.
  r.releaseQueued=true;setImmediate(()=>{r.releaseQueued=false;if(r.finished&&!r.awaitingError&&r.pending===0&&!r.released){r.released=true;s.requestActive--;s.active.delete(r.done);r.settle();}});
 }
}
/** An admitted request whose client is gone (abort, timeout, closed socket) or whose response ended. */
function ended(s:State,request:object){const r=s.requests.get(request);return !s.sealed&&r!==undefined&&(r.finished||r.released);}
/** Registered before cookie/rate-limit/auth hooks; a socket event alone cannot finish active work. */
export function admitOrdinaryRequest(handle:OrdinaryRequestLifetime,request:object){
 const s=state(handle);assert(!s.requests.has(request),'ordinary-request-already-admitted');
 if(s.closing||s.sealed){s.refusedAdmissions++;throw refused('ORDINARY_RUNTIME_CLOSING');}
 if(s.requestActive>=ACTIVE_REQUESTS){s.refusedAdmissions++;throw refused('ORDINARY_RUNTIME_PENDING_LIMIT');}
 let settle!:()=>void;const done=new Promise<void>(yes=>settle=yes);const r={finished:false,awaitingError:false,errorStageDone:false,pending:0,released:false,releaseQueued:false,settle,done,errorStageActive:false,cleanupIdentity:undefined,cleanups:new WeakMap()};
 s.requests.set(request,r);s.requestActive++;s.active.add(done);
}
export function finishOrdinaryRequest(handle:OrdinaryRequestLifetime,request:object){const s=state(handle),r=s.requests.get(request);if(r){r.finished=true;release(s,r);}}
type Slot={ready:Promise<void>|undefined;end:(failure?:{error:unknown})=>void};
/** Synchronous admission of one task; end() releases it exactly once (a callback hook ends before its done). */
function begin(s:State,label:string,request:object|undefined,errorHandler:boolean,finalErrorHandler:boolean,responseHook:boolean):Slot{
 const r=request?s.requests.get(request):undefined;
 if(request)assert(r,'ordinary-original-request-required');
 if(s.sealed||(!r&&s.closing)||r?.released||r?.finished&&!errorHandler&&!responseHook)throw refused('ORDINARY_RUNTIME_CLOSING');
 const cleanupTask=label==='http:response-cleanup';
 // These continuations already own a request slot; they never consume fresh-work capacity.
 if(!errorHandler&&!responseHook&&s.normalActive>=ACTIVE_NORMAL)throw refused('ORDINARY_RUNTIME_PENDING_LIMIT');
 if(errorHandler){assert(r&&!r.errorStageActive,'ordinary-one-error-stage-per-request');r.errorStageActive=true;}
 if(responseHook)assert(r,'ordinary-owned-response-required');
 const id=String(++s.next);let errorSlot=false;
 if(errorHandler&&s.errorActive<ACTIVE_ERRORS){s.errorActive++;errorSlot=true;}else if(!errorHandler&&cleanupTask)s.cleanupActive++;else if(!errorHandler&&responseHook)s.responseActive++;else if(!errorHandler)s.normalActive++;if(r)r.pending++;
 let settle!:()=>void;const done=new Promise<void>(yes=>settle=yes);s.active.add(done);let closed=false;
 const ready=errorHandler&&!errorSlot?new Promise<void>(yes=>{s.errorWaiters.push(()=>{s.errorActive++;errorSlot=true;yes();});}):undefined;
 return {ready,end(failure){
  if(closed)return;closed=true;
  if(failure){if(responseHook){if(!s.cleanupFailed){s.cleanupFailed=true;s.cleanupFirst=failure.error;}}else if(r&&!r.errorStageDone)r.awaitingError=true;}
  if(errorHandler){if(errorSlot)s.errorActive--;if(r)r.errorStageActive=false;const next=s.errorWaiters.shift();if(next)next();}else if(cleanupTask)s.cleanupActive--;else if(responseHook)s.responseActive--;else s.normalActive--;s.active.delete(done);s.outcomes.push({id,label,status:failure?'rejected':'fulfilled'});if(s.outcomes.length>RETAINED)s.outcomes.shift();if(r){if(finalErrorHandler){r.awaitingError=false;r.errorStageDone=true;}r.pending--;release(s,r);}settle();
 }};
}
/** Work is invoked and registered synchronously before its first await. */
async function tracked<T>(s:State,label:string,work:()=>T|PromiseLike<T>,request:object|undefined,errorHandler:boolean,finalErrorHandler=false,responseHook=false):Promise<T>{
 const slot=begin(s,label,request,errorHandler,finalErrorHandler,responseHook);
 try{
  if(slot.ready)await slot.ready;
  const value=await work();slot.end();return value;
 }catch(first){slot.end({error:first});throw first;}
}
export function runOrdinaryRequestTask<T>(handle:OrdinaryRequestLifetime|undefined,label:'http:route'|'http:authentication'|'http:hook',work:()=>T|PromiseLike<T>,request?:object):Promise<T>{
 if(handle===undefined)return (async()=>await work())();
 return tracked(state(handle),label,work,request,false);
}
export function runOrdinaryRequestError<T>(handle:OrdinaryRequestLifetime|undefined,request:object,work:()=>T|PromiseLike<T>):Promise<T>{
 if(handle===undefined)return (async()=>await work())();
 return tracked(state(handle),'http:error-handler',work,request,true,true);
}
export function hasOrdinaryRequestAdmission(handle:OrdinaryRequestLifetime|undefined,request:object){return handle!==undefined&&state(handle).requests.has(request);}
export function beginOrdinaryShutdown(handle:OrdinaryRequestLifetime){state(handle).closing=true;}
export async function drainOrdinaryRequests(handle:OrdinaryRequestLifetime){
 const s=state(handle);assert(s.closing,'ordinary-drain-needs-shutdown');
 do{if(s.active.size)await Promise.all([...s.active]);await new Promise<void>(yes=>setImmediate(yes));}while(s.active.size);
 s.sealed=true;if(s.cleanupFailed)throw s.cleanupFirst;return inspectOrdinaryRequests(handle);
}
export function inspectOrdinaryRequests(handle:OrdinaryRequestLifetime){const s=state(handle);return {closing:s.closing,sealed:s.sealed,active_tasks:s.active.size,active_requests:s.requestActive,active_requests_limit:ACTIVE_REQUESTS,refused_admissions:s.refusedAdmissions,active_normal:s.normalActive,active_errors:s.errorActive,queued_error_tasks:s.errorWaiters.length,active_response_hooks:s.responseActive,active_cleanups:s.cleanupActive,accepted_tasks:String(s.next),cleanup_failed:s.cleanupFailed,late_hook_failures:s.lateFailures,retained_outcomes:s.outcomes.slice()};}
/** Fastify's sync undefined/Reply contract must remain sync; no artificial Promise. */
function callOrdinaryRoute(handle:OrdinaryRequestLifetime,request:object,reply:object,work:()=>unknown):unknown{
 const s=state(handle),r=s.requests.get(request);assert(r,'ordinary-original-request-required');
 if(s.sealed)throw refused('ORDINARY_RUNTIME_CLOSING');
 // The client is gone (abort/timeout): the route never runs and answers nothing. A refusal here was a
 // second reply whenever a preHandler had already answered (invoice-overflow230.ts, the /issue alias).
 if(ended(s,request))return reply;
 if(s.normalActive>=ACTIVE_NORMAL)throw refused('ORDINARY_RUNTIME_PENDING_LIMIT');
 const id=String(++s.next);s.normalActive++;r.pending++;let settle!:()=>void;const done=new Promise<void>(yes=>settle=yes);s.active.add(done);let completed=false;
 const complete=(status:Outcome['status'],first?:unknown)=>{if(completed)return;completed=true;if(status==='rejected'&&!r.errorStageDone)r.awaitingError=true;s.normalActive--;r.pending--;s.active.delete(done);s.outcomes.push({id,label:'http:route',status});if(s.outcomes.length>RETAINED)s.outcomes.shift();release(s,r);settle();};
 let result:unknown;try{result=work();}catch(first){complete('rejected',first);throw first;}
 // Reply response ownership belongs to the authentic request token and response hooks.
 if(result===reply||result===null||typeof result!=='object'&&typeof result!=='function'){complete('fulfilled');return result;}
 let then:unknown;try{then=(result as {then?:unknown}).then;}catch(first){complete('rejected',first);throw first;}
 if(typeof then!=='function'){complete('fulfilled');return result;}
 if(result instanceof Promise&&then===Promise.prototype.then){
  void Promise.prototype.then.call(result,()=>complete('fulfilled'),(first:unknown)=>complete('rejected',first));return result;
 }
 // A custom thenable is consumed exactly once; Fastify receives its normalized Promise.
 const normalized=new Promise((yes,no)=>{try{(then as Function).call(result,yes,no);}catch(first){no(first);}});
 void normalized.then(()=>complete('fulfilled'),first=>complete('rejected',first));return normalized;
}
/** A failure no Fastify continuation can take any more (a done that threw outside the hook call, or a hook
 * that threw after its done): counted and logged, never an unhandled rejection that ends the process. */
function lateFailure(s:State,request:object,error:unknown){
 s.lateFailures++;
 try{(request as {log?:{error?:(o:object,m:string)=>void}}).log?.error?.({err:error,code:'ORDINARY_LATE_HOOK_FAILURE'},'ordinary request hook failed after its continuation');}catch{}
}
/** Async AND callback hook bodies retain their slot until actual completion. A callback hook keeps Fastify's
 * own ordering: its slot ends, then the real done runs inside the same call. A reply finished by synchronous
 * hooks is therefore written before the caller continues (reply.sent then refuses a second reply with
 * FST_ERR_REP_ALREADY_SENT), and a throwing done reaches Fastify's try/catch around the hook, as unwrapped. */
function hook(original:Function,handle:OrdinaryRequestLifetime,arity:number,errorHook=false,responseHook=false){
 const label=errorHook?'http:error-hook':responseHook?'http:response-hook':'http:hook';
 const run=<T>(request:object,work:()=>T|PromiseLike<T>)=>tracked(state(handle),label,work,request,errorHook,false,responseHook);
 // A request hook of an ended request continues without running: a refusal would start a second reply
 // next to one already in flight. Error and response hooks keep running (they finish that reply).
 const skip=(request:object)=>!errorHook&&!responseHook&&ended(state(handle),request);
 if(original.length>=arity)return function(this:unknown,...args:unknown[]){
  const s=state(handle),request=args[0] as object,done=args[arity-1] as (...values:unknown[])=>void;
  if(skip(request)){done();return;}
  let slot:Slot;
  try{slot=begin(s,label,request,errorHook,false,responseHook);}catch(first){done(first);return;}
  let called=false,inCall=true;
  args[arity-1]=(...values:unknown[])=>{
   if(called)return;called=true;slot.end(values[0]?{error:values[0]}:undefined);
   if(inCall){done(...values);return;}
   try{done(...values);}catch(first){lateFailure(s,request,first);}
  };
  /** A throw of the hook body; continued: its done had already run. */
  const invoke=()=>{try{original.apply(this,args);return undefined;}catch(error){const continued=called;if(!called){called=true;slot.end({error});}return {error,continued};}};
  if(!slot.ready){try{const thrown=invoke();if(thrown)throw thrown.error;}finally{inCall=false;}return;}
  // Waiting for an error slot: the hook body runs later, outside Fastify's call.
  inCall=false;
  void slot.ready.then(()=>{
   const thrown=invoke();if(!thrown)return;
   if(thrown.continued){lateFailure(s,request,thrown.error);return;}
   try{done(thrown.error);}catch(second){lateFailure(s,request,second);}
  });
 };
 return function(this:unknown,...args:unknown[]){return skip(args[0] as object)?Promise.resolve(undefined):run(args[0] as object,()=>original.apply(this,args));};
}
export function installOrdinaryRequestLifetime(app:FastifyInstance,handle:OrdinaryRequestLifetime){
 state(handle);assert(!apps.has(app),'ordinary-app-lifetime-already-installed');apps.set(app,handle);
 // Central alias verification compares literal function identity after onRoute.
 // Each installation owns its own memo; foreign wrappers remain foreign functions.
 const memo=new Map<string,WeakMap<Function,Function>>(),owned=new WeakMap<Function,string>();
 function wrapper<T extends Function>(kind:string,original:T,make:(source:T)=>T):T{
  const ownKind=owned.get(original);if(ownKind!==undefined){assert.equal(ownKind,kind,'ordinary-wrapper-semantic-role-mismatch');return original;}
  let cache=memo.get(kind);if(!cache){cache=new WeakMap();memo.set(kind,cache);}const prior=cache.get(original);if(prior)return prior as T;
  const made=make(original);cache.set(original,made);owned.set(made,kind);return made;
 }
 const wrappedHook=(original:Function,arity:number,errorHook:boolean,responseHook:boolean)=>wrapper(
  `hook:${arity}:${errorHook}:${responseHook}`,original,source=>hook(source,handle,arity,errorHook,responseHook));
 app.addHook('onRequest',(request,reply,done)=>{try{admitOrdinaryRequest(handle,request);
  const ended=()=>finishOrdinaryRequest(handle,request);reply.raw.once('close',ended);
  reply.raw.once('finish',()=>reply.raw.removeListener('close',ended));done();}catch(first){done(first as Error);}});
 app.addHook('onError',(request,_reply,_error,done)=>{
  const s=state(handle),r=s.requests.get(request);
  // After the final error stage Fastify routes later errors (e.g. onSend refused on a closed
  // socket) to its default/fallback handler, which never clears awaitingError: waiting would hold the slot forever.
  if(r&&!r.released&&!s.sealed&&!r.errorStageDone)r.awaitingError=true;
  done();
 });
 app.addHook('onResponse',(request,_reply,done)=>{finishOrdinaryRequest(handle,request);done();});
 app.addHook('onTimeout',(request,_reply,done)=>{finishOrdinaryRequest(handle,request);done();});
 app.addHook('onRequestAbort',(request,done)=>{finishOrdinaryRequest(handle,request);done();});
 app.addHook('onRoute',options=>{
  const original=options.handler;
  options.handler=wrapper('route',original,source=>function(request,reply){return callOrdinaryRoute(handle,request,reply,()=>source.call(this,request,reply));});
  const record=options as unknown as Record<string,unknown>;
  for(const name of ['onRequest','preParsing','preValidation','preHandler','onError','onSend','onResponse'] as const){
   const value=record[name];if(value===undefined)continue;
   const arity=['preParsing','onError','onSend'].includes(name)?4:3;
   record[name]=Array.isArray(value)?value.map(f=>wrappedHook(f,arity,name==='onError',name==='onResponse')):wrappedHook(value as Function,arity,name==='onError',name==='onResponse');
  }
 });
 const addHook=app.addHook;
 app.addHook=function(this:FastifyInstance,name:string,original:Function){
  const arity=['preParsing','onError','onSend'].includes(name)?4:3;
  const requestHook=['onRequest','preParsing','preValidation','preHandler','onError','onSend','onResponse'].includes(name);
  return (addHook as Function).call(this,name,requestHook?wrappedHook(original,arity,name==='onError',name==='onResponse'):original);
 } as typeof app.addHook;
}

/** Fixed catalog/sales disposal callback identity joins one pending cleanup for its admitted request. */
export function trackOrdinaryResponseCleanup(app:FastifyInstance,request:object,dispose:()=>Promise<void>):Promise<void>{
 const handle=apps.get(app);if(!handle)return (async()=>await dispose())();
 const s=state(handle),r=s.requests.get(request);assert(r,'ordinary-original-cleanup-request-required');
 const existing=r.cleanups.get(dispose);if(existing)return existing;
 assert(r.cleanupIdentity===undefined,'ordinary-one-fixed-file-cleanup-per-request');r.cleanupIdentity=dispose;
 let yes!:(value:void)=>void,no!:(error:unknown)=>void;const joined=new Promise<void>((resolve,reject)=>{yes=resolve;no=reject;});r.cleanups.set(dispose,joined);
 void tracked(s,'http:response-cleanup',dispose,request,false,false,true).then(yes,no);return joined;
}
