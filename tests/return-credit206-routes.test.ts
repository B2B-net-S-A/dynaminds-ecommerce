/** Actual controller with a controlled service. No application factory, DB or native acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {randomUUID} from 'node:crypto';
import {ZodError} from 'zod';
import {Problem} from '../server/errors';
import {registerReturnCredit206Routes,type ReturnCredit206RouteService} from '../server/return-credit206-routes';
const tenant=randomUUID(),user=randomUUID(),order=randomUUID(),ret=randomUUID(),series=randomUUID(),preview=randomUUID();
const prefix='/api/consumer-return-credits';
const body=()=>({client_key:randomUUID(),original_document_id:randomUUID(),return_id:ret,expected_return_version:'3',series_id:series,expected_series_version:'1',reason:'Zwrot towaru',ordinary_domestic_confirmed:true,local_only:true});
function service(){const calls:{name:string;args:any[]}[]=[];let previewFailure:Error|undefined,reused=false;
 const call=(name:string,reply:unknown)=>(...args:any[])=>{calls.push({name,args});return Promise.resolve(reply);};
 const S={
  returnCredit206RequestActor(req:any,sessionName:string){calls.push({name:'actor',args:[sessionName]});assert.equal(req.actor.tenantId,tenant);return req.actor;},
  returnCredit206Strategy:call('strategy',{order_id:order,strategy:'destinations',available:false}),
  returnCredit206Available:call('available',true),returnCredit206FailedWrite:()=>undefined,
  returnCredit206Options:call('options',{available:true,can_read:true,can_preview:true,can_issue:true}),
  returnCredit206Source:call('source',{available:true,can_read:true,can_preview:true,can_issue:true,eligible:false,eligibility_reason:'no_commercial_change',calculation:null,next_return_id:randomUUID()}),
  async returnCredit206Preview(...args:any[]){calls.push({name:'preview',args});if(previewFailure)throw previewFailure;return{available:true,can_read:true,can_preview:true,can_issue:true,reused,preview:{id:preview,can_issue:true}};},
  returnCredit206PreviewDetail:call('previewDetail',{available:true,can_issue:true,preview:{id:preview,can_issue:true}}),
  returnCredit206Issue:call('issue',{available:true,reused:false}),returnCredit206Detail:call('detail',{}),returnCredit206Register:call('register',{data:[],next_cursor:null}),
  returnCredit206OriginalCommand:call('command',{operation:'preview',client_key:'controlled'}),returnCredit206Series:call('series',{data:[]}),returnCredit206CreateSeries:call('createSeries',{reused:false}),
 }as unknown as ReturnCredit206RouteService;
 return{S,calls,fail:(e:Error)=>{previewFailure=e;},reuse:()=>{reused=true;}};
}
async function app(readOnly=false){const h=service(),a=Fastify();a.setErrorHandler((e,_r,p)=>{p.code(e instanceof ZodError?422:e instanceof Problem?e.status:500).send({detail:e instanceof Error?e.message:"Unknown controlled error"});});a.addHook('onRequest',async req=>{(req as any).actor={tenantId:tenant,userId:user,role:'admin'};});await registerReturnCredit206Routes(a,{readOnly,sessionName:'controlled_session',service:h.S});return{a,...h};}
test('read-only preview projects every write permission off and refuses writes before service availability or commands',async()=>{
 const h=await app(true);try{const r=await h.a.inject(prefix+'/previews/'+preview);assert.equal(r.statusCode,200);assert.equal(r.json().can_issue,false);assert.equal(r.json().preview.can_issue,false);assert.equal(r.headers['cache-control'],'no-store');h.calls.length=0;
 for(const path of ['/series','/previews','/previews/'+preview+'/issue']){const write=await h.a.inject({url:prefix+path,method:'POST',payload:body()});assert.equal(write.statusCode,423);}assert.deepEqual(h.calls,[]);
 }finally{await h.a.close();}
});
test('actual preview route passes exact series/current version and the middleware actor; reused command returns200',async()=>{
 const h=await app();try{const b=body(),r=await h.a.inject({url:prefix+'/previews',method:'POST',payload:b});assert.equal(r.statusCode,201);const call=h.calls.find(c=>c.name==='preview')!;assert.deepEqual(call.args[1],b);assert.equal(call.args[0].tenantId,tenant);assert(h.calls.some(c=>c.name==='actor'&&c.args[0]==='controlled_session'));
 h.reuse();assert.equal((await h.a.inject({url:prefix+'/previews',method:'POST',payload:b})).statusCode,200);
 }finally{await h.a.close();}
});
test('missing series, body actor injection, unknown query and malformed IDs never reach a financial command',async()=>{
 const h=await app();try{for(const selected of [(()=>{const b=body();delete(b as any).series_id;return b;})(),{...body(),actor:{tenantId:randomUUID()}}]){assert.equal((await h.a.inject({url:prefix+'/previews',method:'POST',payload:selected})).statusCode,422);}
 assert.equal((await h.a.inject(prefix+'/orders/'+order+'/source?actor='+user)).statusCode,422);assert.equal((await h.a.inject(prefix+'/orders/not-uuid/source')).statusCode,422);assert(!h.calls.some(c=>['preview','issue','createSeries','source'].includes(c.name)));
 }finally{await h.a.close();}
});
test('uncertain command result is never retried or relabeled as failed-before-write; recovery is an exact-key read',async()=>{
 const h=await app();try{const b=body(),error=new Problem(503,'Niepotwierdzony wynik');Object.assign(error,{write_outcome:'failed_before_write'});h.fail(error);
 const r=await h.a.inject({url:prefix+'/previews',method:'POST',payload:b});assert.equal(r.statusCode,503);assert.equal(r.json().write_outcome,undefined);assert.equal(h.calls.filter(c=>c.name==='preview').length,1);
 assert.equal((await h.a.inject(prefix+'/commands/'+b.client_key+'?operation=preview')).statusCode,200);const read=h.calls.find(c=>c.name==='command')!;assert.deepEqual(read.args.slice(1),[b.client_key,'preview']);assert.equal(h.calls.filter(c=>c.name==='preview').length,1);
 }finally{await h.a.close();}
});
test('no-commercial-change source stays a read with no invoice, series, payment or refund side effect',async()=>{
 const h=await app();try{const r=await h.a.inject(prefix+'/orders/'+order+'/source?return_id='+ret);assert.equal(r.statusCode,200);assert.equal(r.json().eligibility_reason,'no_commercial_change');assert.equal(r.json().calculation,null);assert.deepEqual(h.calls.map(c=>c.name),['actor','source']);}
 finally{await h.a.close();}
});
test('ordinary series uses business defaults and preserves its original command operation',async()=>{
 const h=await app();try{const b={client_key:randomUUID(),name:'Korekty zwrotów'};const r=await h.a.inject({url:prefix+'/series',method:'POST',payload:b});assert.equal(r.statusCode,201);assert.equal(h.calls.find(c=>c.name==='createSeries')!.args[1].prefix,'KOR-ZWROT');
 await h.a.inject(prefix+'/commands/'+b.client_key+'?operation=series');assert.equal(h.calls.find(c=>c.name==='command')!.args[2],'series');}
 finally{await h.a.close();}
});

test('explicit unavailable destinations strategy cannot become an implicit legacy or financial command',async()=>{const h=await app();try{const r=await h.a.inject(prefix+'/orders/'+order+'/strategy');assert.equal(r.statusCode,200);assert.equal(r.json().strategy,'destinations');assert.equal(r.json().available,false);assert.deepEqual(h.calls.map(c=>c.name),['actor','strategy']);}finally{await h.a.close();}});
