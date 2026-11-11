/** Owned lightweight history. Ordinary RR/IAM FOR SHARE; SELECT only, no lease/CAS/advisory/DML. */
import{createHash}from'node:crypto';import type{FastifyRequest}from'fastify';import{ensure}from'../errors';import type{ReadPorts}from'../../shared/large-import-dependencies/pim-large-import-http-binding-ui/readonly-store';import{decodeHistorySummary,historyDate,historyUuid,type JobHistoryPage}from'../../shared/large-import-history';
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const HISTORY_SQL=`WITH selected AS MATERIALIZED (
 SELECT id,revision,state_sha256,plan_hash,created_at,lease_token,state_text::jsonb s FROM public.large_import_jobs173
 WHERE tenant_id=$1 AND actor_id=$2 AND api_key_id IS NOT DISTINCT FROM $3::uuid
 AND jsonb_array_length(state_text::jsonb->'core')>0
 AND NOT EXISTS(SELECT FROM jsonb_array_elements(state_text::jsonb->'core') b WHERE b#>>'{request,catalog_id}' IS DISTINCT FROM $4)
 AND ($5::timestamptz IS NULL OR (created_at,id)<($5::timestamptz,$6::uuid))
 ORDER BY created_at DESC,id DESC LIMIT $7
) SELECT jsonb_build_object(
 'id',id,'revision',revision,'state_sha256',state_sha256,'plan_hash',plan_hash,
 'created_at',to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'catalog_id',$4,
 'file_name',s#>'{core,0,request,file_name}','records',(s#>>'{manifest,records}')::bigint,
 'batches',jsonb_array_length(s->'core'),'approved',(s->>'approved')::boolean,
 'lease_held',lease_token IS NOT NULL,
 'previewed_batches',(SELECT count(*) FROM jsonb_array_elements(s->'core') b WHERE jsonb_typeof(b->'preview')='object'),
 'committed_batches',(SELECT count(*) FROM jsonb_array_elements(s->'core') b WHERE b#>>'{execution,ack,head,state}'='done'),
 'committed_records',(SELECT coalesce(sum((b#>>'{execution,ack,head,total}')::bigint),0) FROM jsonb_array_elements(s->'core') b WHERE b#>>'{execution,ack,head,state}'='done'),
 'rejected_batches',(SELECT count(*) FROM jsonb_array_elements(s->'core') b WHERE b#>'{preview,ack,head,ready}'='false'::jsonb),
 'unknown_attempts',(SELECT count(*) FROM jsonb_array_elements(s->'core') WITH ORDINALITY q(b,n) WHERE EXISTS(SELECT FROM jsonb_array_elements(s->'events') e WHERE e->>'kind'='core-execute-attempt' AND (e->>'batch')::int=n-1) AND jsonb_typeof(b->'execution') IS DISTINCT FROM 'object')+
 (SELECT count(*) FROM jsonb_each(s->'pim') p, jsonb_array_elements(p.value) a WHERE ((a->>'previewAttempted')::boolean AND jsonb_typeof(a->'preview') IS DISTINCT FROM 'object') OR ((a->>'applyAttempted')::boolean AND jsonb_typeof(a->'applied') IS DISTINCT FROM 'object')),
 'pim_staged',(SELECT count(*) FROM jsonb_each(s->'pim') p WHERE jsonb_typeof(p.value->(jsonb_array_length(p.value)-1)->'stage')='object'),
 'pim_previewed',(SELECT count(*) FROM jsonb_each(s->'pim') p WHERE jsonb_typeof(p.value->(jsonb_array_length(p.value)-1)->'preview')='object'),
 'pim_applied',(SELECT count(*) FROM jsonb_each(s->'pim') p WHERE jsonb_typeof(p.value->(jsonb_array_length(p.value)-1)->'applied')='object'),
 'pim_rejected',(SELECT count(*) FROM jsonb_each(s->'pim') p WHERE p.value->(jsonb_array_length(p.value)-1)#>'{stage,ready}'='false'::jsonb OR p.value->(jsonb_array_length(p.value)-1)#>'{preview,body,ready}'='false'::jsonb),
 'last_event',s->'events'->(jsonb_array_length(s->'events')-1)->'kind'
 ) summary FROM selected ORDER BY created_at DESC,id DESC`;
export function createOwnedJobHistory(input:ReadPorts){const ports={...input},used=new WeakSet<object>();return{async list(req:FastifyRequest,catalog:string,limit=20,cursor?:string):Promise<JobHistoryPage>{
 ensure(historyUuid.test(catalog)&&Number.isSafeInteger(limit)&&limit>=1&&limit<=25,422,'Nieprawidłowy zakres historii');const actor=ports.capture(req);ensure(actor.role==='admin',403,'Wymagana rola administratora');const binding=digest([actor.tenantId,actor.userId,actor.apiKeyId??null,catalog,limit]);let at:string|null=null,id:string|null=null;
 if(cursor){ensure(cursor.length<=512&&/^[A-Za-z0-9_-]+$/.test(cursor),422,'Nieprawidłowy kursor');let v:unknown;try{v=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));}catch{ensure(false,422,'Nieprawidłowy kursor');}const x=v as {at:string;id:string;binding:string};ensure(x&&JSON.stringify(Object.keys(x).sort())===JSON.stringify(['at','binding','id'])&&historyDate(x.at)&&historyUuid.test(x.id)&&x.binding===binding&&Buffer.from(JSON.stringify(x)).toString('base64url')===cursor,422,'Kursor należy do innego zakresu');at=x.at;id=x.id;}
 let c:Awaited<ReturnType<ReadPorts['connect']>>['c']|undefined,owned=false,started=false,failed=false,first:unknown,result:JobHistoryPage|undefined;const report=(phase:'rollback'|'close')=>{try{ports.cleanupFailure(phase);}catch{}};
 try{const connected=await ports.connect(actor);c=connected.c;ensure(!used.has(c),503,'Wymagane świeże połączenie');used.add(c);owned=true;const p=connected.scope;ensure(p.tenantId===actor.tenantId&&p.userId===actor.userId&&p.apiKeyId===(actor.apiKeyId??null),403,'Inny właściciel historii');await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');started=true;await ports.admit(c,actor,false);
 const state=(await c.query("SELECT current_user role,current_setting('app.tenant_id',true) tenant")).rows[0];ensure(state?.role==='dyna_app'&&state.tenant===p.tenantId,403,'Inna firma lub rola');const rows=(await c.query(HISTORY_SQL,[p.tenantId,p.userId,p.apiKeyId,catalog,at,id,limit+1])).rows;ensure(rows.length<=limit+1,503,'Nadmierna strona historii');
 const items=rows.slice(0,limit).map(r=>{try{return decodeHistorySummary(r.summary,catalog);}catch{ensure(false,503,'Niepełny natywny opis zadania');}});const ids=new Set();for(let n=0;n<items.length;n++){const j=items[n]!;ensure(!ids.has(j.id),503,'Powtórzone zadanie');ids.add(j.id);const previous=n?items[n-1]!:{created_at:at,id};ensure(!previous.created_at||j.created_at<previous.created_at||j.created_at===previous.created_at&&j.id<previous.id!,503,'Inny porządek historii');}
 const last=items.at(-1)!;result={schema:'large-import-owned-history/v1',catalog_id:catalog,items:items as NonNullable<typeof items[number]>[],next:rows.length>limit?Buffer.from(JSON.stringify({at:last.created_at,id:last.id,binding})).toString('base64url'):null};ensure(Buffer.byteLength(JSON.stringify(result))<=1048576,413,'Pełna strona historii przekracza limit');await ports.admit(c,actor,false);await c.query('COMMIT');started=false;
 }catch(e){failed=true;first=e;if(c&&started)try{await c.query('ROLLBACK');}catch{report('rollback');}}finally{if(c&&owned)try{await c.end();}catch(e){report('close');if(!failed){failed=true;first=e;}}}if(failed)throw first;return result!;
}};}
