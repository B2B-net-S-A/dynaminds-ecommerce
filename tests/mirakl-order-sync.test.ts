import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {initialMiraklOrderCheckpoint,processMiraklOrderSync,type MiraklOrderSyncRepository,type MiraklOrderSyncClaim,type MiraklOrderReaderFactory} from '../server/mirakl-order-sync';
import {MiraklReadDeferred} from '../server/mirakl';
import {Problem} from '../server/errors';
const id=(n:number)=>`${String(n).padStart(8,'0')}-1000-4000-8000-000000000001`;
const job={tenantId:id(1),jobId:id(2),leaseToken:id(3)};
const binding={tenantId:id(1),channelId:id(4),actorId:id(5),connectionHash:'a'.repeat(64),currency:'PLN' as const,requireEnabled:true};
const window={start_update_date:'2026-10-01T00:00:00Z',end_update_date:'2026-10-02T00:00:00Z'};
const source=(orderId:string)=>({id:orderId,order_id:orderId,currency_iso_code:'PLN',last_updated_date:'2026-10-01T12:00:00Z'});
const page=(offset:number,total_count:number,ids:string[])=>({data:ids.map(source),offset,total_count,has_more:offset+ids.length<total_count});
/** File-backed state survives construction of a fresh repository fixture. Atomic
 * port calls are serialized by a controlled test gate, not proof of native PG/RLS. */
async function fixture(run:(x:any)=>Promise<void>){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'mirakl-sync-contract-')),file=path.join(directory,'owned-state.json');
 let serial=Promise.resolve();const calls:string[]=[],reads:any[]=[];
 const atomic=async<T>(fn:()=>Promise<T>)=>{let release!:()=>void;const prior=serial;serial=new Promise<void>(r=>{release=r;});await prior;try{return await fn();}finally{release();}};
 const read=async()=>JSON.parse(await fs.readFile(file,'utf8'));
 const write=async(s:any)=>{const tmp=file+'.next';await fs.writeFile(tmp,JSON.stringify(s),{mode:0o600});await fs.rename(tmp,file);};
 await write({checkpoint:initialMiraklOrderCheckpoint({connectionHash:binding.connectionHash,window,max:1}),allowed:true,enabled:true,connectionHash:binding.connectionHash,leaseToken:job.leaseToken,staged:{},watermark:null,notBefore:null,clock:'2026-10-17T12:00:00Z'});
 function guardState(s:any,c:MiraklOrderSyncClaim){assert(s.allowed&&(!c.binding.requireEnabled||s.enabled),'late IAM or pause');assert.equal(s.leaseToken,c.job.leaseToken);assert.equal(s.connectionHash,c.binding.connectionHash);assert.equal(s.checkpoint.revision,c.checkpoint.revision);}
 const makeRepository=()=>{
  let loseClaim=false,loseCommit=false,loseDefer=false;
  const repository:MiraklOrderSyncRepository={
   claim:async(j,b)=>{calls.push('claim');if(loseClaim)throw Error('CONTROLLED_PRIVATE_DATABASE');const s=await read();assert.deepEqual(j,job);assert.deepEqual(b,binding);if(!s.allowed||!s.enabled)return{state:'stopped'};return{state:'claimed',checkpoint:s.checkpoint};},
   guard:async c=>{calls.push('guard');guardState(await read(),c);},
   commitPage:async(c,p)=>atomic(async()=>{calls.push('commit');const s=await read();guardState(s,c);for(const o of p.orders){assert.match(o.sourceHash,/^[a-f0-9]{64}$/);s.staged[o.source.id]={source:o.source,sourceHash:o.sourceHash};}s.checkpoint=p.next;if(p.next.finished)s.watermark=p.next.watermark;await write(s);if(loseCommit)throw Error('CONTROLLED_ACK_LOST_AFTER_COMMIT');}),
   defer:async(c,p)=>atomic(async()=>{calls.push('defer');const s=await read();guardState(s,c);s.notBefore=new Date(Date.parse(s.clock)+p.retryAfterSeconds*1000).toISOString();await write(s);if(loseDefer)throw Error('CONTROLLED_DEFER_ACK_LOST');return{notBefore:s.notBefore};}),
   fail:async(c,p)=>atomic(async()=>{calls.push('fail');const s=await read();guardState(s,c);s.failure=p.reason;await write(s);}),
  };
  return{repository,loseClaim:()=>{loseClaim=true;},loseCommit:()=>{loseCommit=true;},loseDefer:()=>{loseDefer=true;}};
 };
 const factory=(result:any,patch?:(x:any)=>Promise<void>):MiraklOrderReaderFactory=>guard=>({connectionHash:binding.connectionHash,readOrderPage:async(q:Parameters<Awaited<ReturnType<MiraklOrderReaderFactory>>['readOrderPage']>[0])=>{await guard();reads.push(structuredClone(q));if(patch)await patch(q);if(result instanceof Error)throw result;return typeof result==='function'?result(q):result;}} as any);
 const invoke=(repository:MiraklOrderSyncRepository,createReader:MiraklOrderReaderFactory)=>processMiraklOrderSync({job,binding,repository,createReader});
 const update=async(fn:(s:any)=>void)=>atomic(async()=>{const s=await read();fn(s);await write(s);});
 try{await run({file,read,write,update,calls,reads,makeRepository,factory,invoke});}finally{await fs.rm(directory,{recursive:true,force:true});}
}

test('one page persists numeric checkpoint; a new repository/reader resumes it and only final page advances watermark',()=>fixture(async x=>{
 let r=x.makeRepository();assert.deepEqual(await x.invoke(r.repository,x.factory(page(0,2,['FIRST']))),{status:'page_committed',staged:1});
 let s=await x.read();assert.equal(s.checkpoint.offset,1);assert.equal(s.checkpoint.revision,1);assert.equal(s.watermark,null);assert.equal(s.checkpoint.watermark,null);assert(!JSON.stringify(s).includes('next_cursor'));
 r=x.makeRepository();assert.deepEqual(await x.invoke(r.repository,x.factory(page(1,2,['SECOND']))),{status:'complete',staged:1});s=await x.read();assert.deepEqual(Object.keys(s.staged),['FIRST','SECOND']);assert.equal(s.watermark,window.end_update_date);assert.equal(s.checkpoint.offset,2);
 const count=x.reads.length;assert.deepEqual(await x.invoke(x.makeRepository().repository,x.factory(page(0,1,['WRONG']))),{status:'already_complete'});assert.equal(x.reads.length,count);
 assert.deepEqual(x.reads.map((q:any)=>q.offset),[0,1]);
}));
test('page commit ACK loss preserves durable staging and completed checkpoint without a failure overwrite or another read',()=>fixture(async x=>{
 const r=x.makeRepository();r.loseCommit();await assert.rejects(x.invoke(r.repository,x.factory(page(0,1,['ONLY']))),(e:any)=>e instanceof Problem&&e.code==='MIRAKL_SYNC_COMMIT_UNCONFIRMED'&&!e.message.includes('CONTROLLED'));
 assert.equal(x.calls.filter((c:string)=>c==='fail').length,0);assert.equal(Object.keys((await x.read()).staged).length,1);
 assert.deepEqual(await x.invoke(x.makeRepository().repository,x.factory(page(0,1,['ONLY']))),{status:'already_complete'});assert.equal(x.reads.length,1);
}));
test('durable cooldown defers same job without advancing checkpoint and survives fresh repository construction',()=>fixture(async x=>{
 const r=x.makeRepository();assert.deepEqual(await x.invoke(r.repository,x.factory(new MiraklReadDeferred(120))),{status:'deferred',notBefore:'2026-10-17T12:02:00.000Z'});
 const s=await x.read();assert.equal(s.notBefore,'2026-10-17T12:02:00.000Z');assert.equal(s.checkpoint.offset,0);assert.equal(s.watermark,null);assert.deepEqual(s.staged,{});
 const fresh=x.makeRepository();assert(fresh.repository);assert.equal((await x.read()).notBefore,s.notBefore);assert.equal(x.calls.filter((c:string)=>c==='defer').length,1);
}));
test('claim/defer unknown acknowledgements are redacted; no provider follows unknown claim and no stale failure follows defer ACK loss',()=>fixture(async x=>{
 const r=x.makeRepository();r.loseClaim();await assert.rejects(x.invoke(r.repository,x.factory(page(0,1,['NONE']))),(e:any)=>e instanceof Problem&&e.code==='MIRAKL_SYNC_CLAIM_UNCONFIRMED'&&!e.message.includes('PRIVATE'));assert.equal(x.reads.length,0);
 const d=x.makeRepository();d.loseDefer();await assert.rejects(x.invoke(d.repository,x.factory(new MiraklReadDeferred(120))),(e:any)=>e instanceof Problem&&e.code==='MIRAKL_SYNC_STATE_UNCONFIRMED');assert.equal((await x.read()).checkpoint.revision,0);assert.equal(x.calls.filter((c:string)=>c==='fail').length,0);
}));
test('paused/revoked work does not read, late revocation/config/lease change cannot stage or advance watermark',()=>fixture(async x=>{
 await x.update((s:any)=>{s.enabled=false;});assert.deepEqual(await x.invoke(x.makeRepository().repository,x.factory(page(0,1,['NONE']))),{status:'stopped'});assert.equal(x.reads.length,0);
 for(const change of [(s:any)=>{s.allowed=false;},(s:any)=>{s.connectionHash='b'.repeat(64);},(s:any)=>{s.leaseToken=id(80);}]){
  await x.update((s:any)=>{s.allowed=true;s.enabled=true;s.connectionHash=binding.connectionHash;s.leaseToken=job.leaseToken;});
  await assert.rejects(x.invoke(x.makeRepository().repository,x.factory(page(0,1,['DENIED']),()=>x.update(change))),(e:any)=>e instanceof Problem&&e.code==='MIRAKL_SYNC_STATE_UNCONFIRMED');
  const s=await x.read();assert.deepEqual(s.staged,{});assert.equal(s.checkpoint.offset,0);assert.equal(s.watermark,null);
 }
}));
test('wrong offset, duplicate IDs, altered totals/currency/window and huge windows fail before any page commit',()=>fixture(async x=>{
 const r=x.makeRepository();await x.invoke(r.repository,x.factory(page(0,2,['FIRST'])));
 const cases=[page(0,2,['SECOND']),page(1,2,['FIRST']),page(1,3,['SECOND']),{...page(1,2,['SECOND']),has_more:true},{...page(1,2,['SECOND']),data:[]},page(1,10001,['SECOND']),{...page(1,2,['SECOND']),data:[{...source('SECOND'),currency_iso_code:'EUR'}]},{...page(1,2,['SECOND']),data:[{...source('SECOND'),last_updated_date:'2026-10-03T00:00:00Z'}]}];
 for(const bad of cases){assert.deepEqual(await x.invoke(x.makeRepository().repository,x.factory(bad)),{status:'failed',reason:'PAGE_REJECTED'});const s=await x.read();assert.equal(s.checkpoint.offset,1);assert.deepEqual(Object.keys(s.staged),['FIRST']);assert.equal(s.watermark,null);}
}));
test('lower-bound overlap is valid; raw staging retains source metadata',()=>fixture(async x=>{
 const row={...source('OLDER'),last_updated_date:'2026-09-30T23:59:00Z',payment_type:'Opaque method',source_field:'retained'};
 assert.deepEqual(await x.invoke(x.makeRepository().repository,x.factory({...page(0,1,['OLDER']),data:[row]})),{status:'complete',staged:1});assert.equal((await x.read()).staged.OLDER.source.source_field,'retained');
}));
test('malformed/foreign checkpoint and reader binding cannot be reused as another channel or cursor authority',()=>fixture(async x=>{
 const c=initialMiraklOrderCheckpoint({connectionHash:binding.connectionHash,window});
 for(const patch of [{schema:'legacy-other-provider'},{seenIds:['fake']},{connectionHash:'b'.repeat(64)},{revision:1},{offset:1},{next_cursor:{offset:1}}]){
  await x.update((s:any)=>{s.checkpoint={...c,...patch};});await assert.rejects(x.invoke(x.makeRepository().repository,x.factory(page(0,1,['NONE']))));assert.equal(x.reads.length,0);
 }
 await x.update((s:any)=>{s.checkpoint=c;});const wrong:MiraklOrderReaderFactory=()=>({connectionHash:'b'.repeat(64),readOrderPage:async()=>{assert.fail('foreign reader must not run');}});
 assert.deepEqual(await x.invoke(x.makeRepository().repository,wrong),{status:'failed',reason:'READ_FAILED'});assert.deepEqual((await x.read()).staged,{});
}));


test('empty completed window advances the terminal watermark atomically without staging a fabricated order',()=>fixture(async x=>{
 assert.deepEqual(await x.invoke(x.makeRepository().repository,x.factory(page(0,0,[]))),{status:'complete',staged:0});
 const s=await x.read();assert.equal(s.checkpoint.totalCount,0);assert.equal(s.checkpoint.offset,0);assert.equal(s.checkpoint.finished,true);assert.equal(s.watermark,window.end_update_date);assert.deepEqual(s.staged,{});
}));
test('two controlled callers cannot commit the same checkpoint twice or overwrite the winner after stale CAS',()=>fixture(async x=>{
 let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});let entered=0;
 const hold=async()=>{entered++;if(entered===2)release();await gate;};
 const a=x.invoke(x.makeRepository().repository,x.factory(page(0,1,['SAME']),hold));
 const b=x.invoke(x.makeRepository().repository,x.factory(page(0,1,['SAME']),hold));
 const results=await Promise.allSettled([a,b]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);
 const s=await x.read();assert.deepEqual(Object.keys(s.staged),['SAME']);assert.equal(s.checkpoint.revision,1);assert.equal(s.watermark,window.end_update_date);assert.equal(s.failure,undefined);
}));
