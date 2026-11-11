import {Client as CanonicalHistoryOwnerClient} from 'pg';
/** Typed source-only V4 stream consumer, not installed Native authority.
 * Caller supplies the SAME canonical dedicated owner client in its genuine
 * RRRO transaction/root lease and the authentic Native epoch token. This helper
 * neither opens/adopts clients nor begins/ends transactions or mints authority.
 * Callbacks may observe a partial stream; only the final return proves complete.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

export type HistoryKind = 'epoch'|'original'|'member'|'io';
export type HistoryRow = Readonly<{
 root_key:string; epoch:string; id:string; kind:HistoryKind;
 // Native owns principal validation. This reader does not attest caller Actors.
 tenant_id:unknown; actor_id:unknown; api_key_id:unknown;
 payload_text:string; payload_sha256:string; payload_capacity:string;
 metadata_charge:string; objects_charge:string;
}>;
export interface OwnerHistoryClient {
 query(text:string,values:unknown[]):Promise<{rows:Array<{value:unknown}>}>;
}
export type CompleteHistoryHeader = {
 schema:'ordinary187-complete-cut/v1'; root_key:string; epoch:string; snapshot:string;
 rows:string; payload_bytes:string; metadata_charge:string; objects_charge:string;
 chain_sha256:string; protocol_only:true; full_FS_census:false; public_ready:false;
};
export type CompleteHistoryResult = CompleteHistoryHeader & {complete:true};
export type HistoryOptions = {
 root:string; epoch:string; token:string;
 onRow(row:HistoryRow):void|Promise<void>;
 signal:Pick<AbortSignal,'throwIfAborted'>; maxRows?:number;
};
type Cursor = Pick<HistoryRow,'epoch'|'kind'|'id'>;
type RecordValue = Record<string,unknown>;
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
function record(value:unknown):RecordValue {
 assert(value!==null&&typeof value==='object'&&!Array.isArray(value));
 return value as RecordValue;
}
function uint(value:unknown):asserts value is string {
 assert(typeof value==='string'&&/^(0|[1-9][0-9]*)$/.test(value));
}
const compare=(a:Cursor,b:Cursor)=>BigInt(a.epoch)!==BigInt(b.epoch)
 ?(BigInt(a.epoch)<BigInt(b.epoch)?-1:1)
 :a.kind!==b.kind?(a.kind<b.kind?-1:1):a.id<b.id?-1:a.id===b.id?0:1;

export async function readCompleteHistory(c:OwnerHistoryClient,{
 root,epoch,token,onRow,signal,maxRows=1000000,
}:HistoryOptions):Promise<CompleteHistoryResult> {
 assert(/^[a-f0-9]{64}$/.test(root)&&/^[1-9][0-9]*$/.test(epoch)&&/^[a-f0-9]{64}$/.test(token));
 assert(typeof onRow==='function'&&signal&&typeof signal.throwIfAborted==='function'
  &&Number.isSafeInteger(maxRows)&&maxRows>=1&&maxRows<=1000000);
 const args=[root,epoch,token];
 const header=async()=>{
  signal.throwIfAborted();
  const r=await c.query('SELECT public.ordinary187_owner_cut_header($1,$2,$3) value',args);
  assert(r.rows.length===1);return record(r.rows[0]!.value);
 };
 const h=await header();
 assert(h.schema==='ordinary187-complete-cut/v1'&&h.root_key===root&&h.epoch===epoch
  &&typeof h.snapshot==='string'&&h.protocol_only===true&&h.full_FS_census===false&&h.public_ready===false);
 for(const k of ['rows','payload_bytes','metadata_charge','objects_charge'])uint(h[k]);
 const selected=h as CompleteHistoryHeader;
 assert(BigInt(selected.rows)>0n&&BigInt(selected.rows)<=BigInt(maxRows)
  &&typeof h.chain_sha256==='string'&&/^[a-f0-9]{64}$/.test(h.chain_sha256));
 let cursor:Cursor|null=null,count=0n,bytes=0n,metadata=0n,objects=0n;
 let chain=sha('ordinary187-complete-cut/v1\n'+root+'\n'+epoch);
 while(true){
  signal.throwIfAborted();
  const result=await c.query('SELECT public.ordinary187_owner_cut_page($1,$2,$3,$4,$5,$6,$7) value',
   [...args,cursor?.epoch??null,cursor?.kind??null,cursor?.id??null,16]);
  assert(result.rows.length===1);const p=record(result.rows[0]!.value);
  assert(p.schema==='ordinary187-complete-cut-page/v1'&&p.root_key===root&&p.epoch===epoch
   &&p.snapshot===h.snapshot&&Array.isArray(p.rows)&&p.rows.length<=16
   &&Buffer.byteLength(JSON.stringify(p))<=1048576);
  const page=p.rows as unknown[];let pageBytes=0;
  if(page.length===0)break;
  for(const value of page){
   const item=record(value);assert(typeof item.encoded==='string');
   pageBytes+=Buffer.byteLength(item.encoded);assert(pageBytes<=1048576);
   const r=record(JSON.parse(item.encoded));
   assert.deepEqual(Object.keys(r).sort(),[
    'root_key','epoch','id','kind','tenant_id','actor_id','api_key_id','payload_text',
    'payload_sha256','payload_capacity','metadata_charge','objects_charge',
   ].sort());
   assert(r.root_key===root&&r.epoch===item.epoch&&r.kind===item.kind&&r.id===item.id
    &&typeof r.epoch==='string'&&/^[1-9][0-9]*$/.test(r.epoch)&&BigInt(r.epoch)<=BigInt(epoch)
    &&typeof r.kind==='string'&&['epoch','original','member','io'].includes(r.kind)
    &&typeof r.id==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(r.id));
   for(const k of ['payload_capacity','metadata_charge','objects_charge'])uint(r[k]);
   assert(typeof r.payload_text==='string'&&sha(r.payload_text)===r.payload_sha256);
   const held=r as unknown as HistoryRow;
   assert(!cursor||compare(cursor,held)<0,'duplicate/reordered page');
   const n=Buffer.byteLength(held.payload_text);
   assert(n<=32768&&BigInt(held.payload_capacity)>=BigInt(n)&&BigInt(held.payload_capacity)<=32768n);
   assert(BigInt(held.metadata_charge)===2n*(BigInt(held.payload_capacity)+(held.kind==='member'?1024n:0n))
    &&BigInt(held.objects_charge)===(held.kind==='member'?4n:2n));
   count++;assert(count<=BigInt(selected.rows));bytes+=BigInt(n);
   metadata+=BigInt(held.metadata_charge);objects+=BigInt(held.objects_charge);
   chain=sha(chain+'\n'+item.encoded);await onRow(Object.freeze(held));
   cursor={epoch:held.epoch,kind:held.kind,id:held.id};
  }
 }
 assert(count===BigInt(selected.rows)&&bytes===BigInt(selected.payload_bytes)
  &&metadata===BigInt(selected.metadata_charge)&&objects===BigInt(selected.objects_charge)
  &&chain===selected.chain_sha256,'incomplete whole history');
 assert.deepEqual(await header(),h,'changed root/snapshot/header');
 return {...selected,complete:true,protocol_only:true,full_FS_census:false,public_ready:false};
}

/** Same strict principal, terminal state, request-lineage, identity, payload and
 * charge predicates as the existing whole protocol auditor. The Native stream
 * supplies complete membership; this auditor still supplies terminal semantics.
 * requestHashes must originate from the caller's authenticated Source lineage,
 * never an automatically generated whitelist of the journal being inspected.
 */
export type CompleteProtocolAuditOptions = Omit<HistoryOptions,'onRow'> & {
 tenantId:string; userId:string; requestHashes:readonly string[];
 maxPayloadBytes?:number;
};
export async function auditCompleteProtocolHistory(c:OwnerHistoryClient,input:CompleteProtocolAuditOptions){
 const {tenantId,userId,requestHashes,maxPayloadBytes=256*1024*1024,...options}=input;
 const uuid=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
 assert(uuid(tenantId)&&uuid(userId)&&Array.isArray(requestHashes)&&requestHashes.length>0&&requestHashes.length<=1000000);
 assert(requestHashes.every(h=>typeof h==='string'&&/^[a-f0-9]{64}$/.test(h))&&new Set(requestHashes).size===requestHashes.length,'complete-audit-authenticated-lineage-shape');
 assert(Number.isSafeInteger(maxPayloadBytes)&&maxPayloadBytes>0&&maxPayloadBytes<=256*1024*1024);
 const known=new Set(requestHashes),counts={epoch:0,original:0,member:0,io:0};
 let currentEpoch:string|undefined,epochPresent=false,payloadBytes=0n;
 const ids=new Set<string>();
 const complete=await readCompleteHistory(c,{...options,onRow(row){
  assert(row.root_key===options.root&&row.tenant_id===tenantId&&row.actor_id===userId&&row.api_key_id===null,'protocol-exact-principal-root');
  if(row.epoch!==currentEpoch){assert(currentEpoch===undefined||epochPresent,'protocol-historical-epoch-required');currentEpoch=row.epoch;epochPresent=false;ids.clear();}
  assert(!ids.has(row.id),'protocol-duplicate');ids.add(row.id);
  const p=record(JSON.parse(row.payload_text));
  const terminal=row.kind==='epoch'?'CLOSED':row.kind==='original'?'DRAINED':row.kind==='io'?'DRAINED':null;
  assert(terminal?p.state===terminal:typeof p.state==='string'&&['COMMITTED','ROLLED_BACK'].includes(p.state),'protocol-unresolved-history');
  if(row.kind==='epoch'){assert(!epochPresent,'protocol-duplicate-epoch');epochPresent=true;}
  else assert(epochPresent,'protocol-historical-epoch-required');
  if(row.kind==='original')assert(typeof p.original_hash==='string'&&known.has(p.original_hash),'protocol-original-request-lineage');
  payloadBytes+=BigInt(Buffer.byteLength(row.payload_text));assert(payloadBytes<=BigInt(maxPayloadBytes),'complete-audit-payload-budget');
  counts[row.kind]++;
 }});
 assert(epochPresent&&payloadBytes===BigInt(complete.payload_bytes),'complete-audit-terminal-membership');
 return Object.freeze({schema:'source-complete-protocol-audit/v1' as const,root_key:complete.root_key,epoch:complete.epoch,
  counts,rows:complete.rows,payload_bytes:complete.payload_bytes,metadata:complete.metadata_charge,objects:complete.objects_charge,
  native_chain_sha256:complete.chain_sha256,complete_stream:true as const,all_history_closed:true as const,
  business_ACK_proved:false as const,full_FS_census:false as const,public_authority:false as const});
}

/** Existing operator privilege, not an old epoch token or a new command
 * capability. Caller must retain its genuine current schema fence/admin
 * admission and exact root session lock across snapshot and later CAS.
 * Read-only complete protocol semantics never substitute for FS/business census.
 */
export type SourceOriginalLineage={original_hash:string;tenantId:string;userId:string;apiKeyId:string|null};
export type HistoricalProtocolOptions={sourceLineage?:readonly SourceOriginalLineage[];root:string;tenantId:string;userId:string;requestHashes:readonly string[];signal:AbortSignal;maxRows?:number;maxPayloadBytes?:number};
export const HISTORICAL_BOUND_SQL="SELECT count(*)::text rows,coalesce(sum(octet_length(payload_text)),0)::text payload_bytes,coalesce(sum(metadata_charge),0)::text metadata_charge,coalesce(sum(objects_charge),0)::text objects_charge,coalesce(max(octet_length(payload_text)),0)::text largest_payload,coalesce(max(payload_capacity),0)::text largest_capacity,max(epoch)::text max_epoch,(SELECT count(*)::text FROM ordinary187_private.contexts WHERE root_key=$1) contexts,pg_current_snapshot()::text snapshot FROM ordinary187_private.journal WHERE root_key=$1";
export const HISTORICAL_PAGE_SQL="SELECT root_key,epoch::text,id::text,kind,tenant_id::text,actor_id::text,api_key_id::text,payload_text,payload_sha256,payload_capacity::text,metadata_charge::text,objects_charge::text FROM ordinary187_private.journal WHERE root_key=$1 AND($2::bigint IS NULL OR(epoch,kind COLLATE \"C\",id)>($2::bigint,$3::text COLLATE \"C\",$4::uuid)) ORDER BY ordinary187_private.journal.epoch,kind COLLATE \"C\",id LIMIT 8";
export async function auditPrivilegedCurrentProtocolHistory(c:OwnerHistoryClient,input:HistoricalProtocolOptions){
 assert(c instanceof CanonicalHistoryOwnerClient,'historical-real-canonical-owner-required');
 const x={...input,requestHashes:[...input.requestHashes],...(input.sourceLineage?{sourceLineage:structuredClone(input.sourceLineage)}:{})},maxRows=x.maxRows??1000000,maxBytes=x.maxPayloadBytes??256*1024*1024;
 const uuid=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
 assert(/^[a-f0-9]{64}$/.test(x.root)&&uuid(x.tenantId)&&uuid(x.userId));assert(Number.isSafeInteger(maxRows)&&maxRows>0&&maxRows<=1000000&&Number.isSafeInteger(maxBytes)&&maxBytes>0&&maxBytes<=256*1024*1024);
 assert(x.requestHashes.length>0&&x.requestHashes.length<=1000000&&x.requestHashes.every(h=>typeof h==='string'&&/^[a-f0-9]{64}$/.test(h))&&new Set(x.requestHashes).size===x.requestHashes.length,'historical-authenticated-lineage-required');
 const known=new Set(x.requestHashes),sourceScopes=new Map<string,string>(),scopes=new Set<string>();const scopeKey=(tenant:unknown,user:unknown,api:unknown)=>JSON.stringify([tenant,user,api]);
 if(x.sourceLineage!==undefined){assert(x.sourceLineage.length===known.size,'historical-source-lineage-complete-set');for(const r of x.sourceLineage){assert(Object.keys(r).sort().join(',')==='apiKeyId,original_hash,tenantId,userId'&&known.has(r.original_hash)&&uuid(r.tenantId)&&uuid(r.userId)&&(r.apiKeyId===null||uuid(r.apiKeyId))&&!sourceScopes.has(r.original_hash),'historical-source-lineage-scope');const key=scopeKey(r.tenantId,r.userId,r.apiKeyId);sourceScopes.set(r.original_hash,key);scopes.add(key);}}
 const kb=Buffer.from(x.root,'hex'),keys=[kb.readInt32BE(0),kb.readInt32BE(4)];
 const signal=AbortSignal.any([x.signal,AbortSignal.timeout(120000)]),query=(text:string,values:unknown[]=[])=>{signal.throwIfAborted();const config={text,values,query_timeout:8000};return c.query(config);};
 const session=async()=>{const r=(await query("SELECT current_user role,session_user owner,current_setting('role') role_setting,current_setting('transaction_read_only') ro,current_setting('transaction_isolation') isolation,EXISTS(SELECT FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND mode='ExclusiveLock' AND granted AND objsubid=2 AND classid::bigint=($1::bigint&4294967295) AND objid::bigint=($2::bigint&4294967295)) root_held,EXISTS(SELECT FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND mode='ShareLock' AND granted AND objsubid=1 AND classid=0 AND objid=982376) schema_held",keys)).rows;assert(r.length===1&&r[0]?.role==='postgres'&&r[0].owner==='postgres'&&r[0].role_setting==='none'&&r[0].ro==='on'&&r[0].isolation==='repeatable read'&&r[0].root_held===true&&r[0].schema_held===true,'historical-owner-RRRO-held-root-and-schema');return r[0];};
 const opening=await session();
 const bound=async()=>{const rows=(await query(HISTORICAL_BOUND_SQL,[x.root])).rows;assert(rows.length===1);const h=rows[0];for(const k of ['rows','payload_bytes','metadata_charge','objects_charge','largest_payload','largest_capacity','contexts'])uint(h[k]);assert(BigInt(h.rows)>0n&&BigInt(h.rows)<=BigInt(maxRows)&&BigInt(h.payload_bytes)<=BigInt(maxBytes)&&BigInt(h.largest_payload)<=32768n&&BigInt(h.largest_capacity)<=32768n&&h.contexts==='0'&&typeof h.max_epoch==='string'&&/^[1-9][0-9]*$/.test(h.max_epoch)&&typeof h.snapshot==='string','historical-complete-scalar-bound');return h;};
 const header=await bound();let cursor:Cursor|null=null,epochPresent=false,epoch:string|undefined,n=0n,bytes=0n,metadata=0n,objects=0n,chain=sha('source-owner-whole-history/v1\n'+x.root);const counts={epoch:0,original:0,member:0,io:0},ids=new Set<string>();
 while(true){
  const result=await query(HISTORICAL_PAGE_SQL,[x.root,cursor?.epoch??null,cursor?.kind??null,cursor?.id??null]);assert(Array.isArray(result.rows)&&result.rows.length<=8);
  const page=result.rows.slice();while(Buffer.byteLength(JSON.stringify(page))>1048576){assert(page.length>1,'historical-single-row-wire-bound');page.pop();}
  if(page.length===0)break;
  for(const raw of page){const r=record(raw);assert.deepEqual(Object.keys(r).sort(),['root_key','epoch','id','kind','tenant_id','actor_id','api_key_id','payload_text','payload_sha256','payload_capacity','metadata_charge','objects_charge'].sort());
   assert(r.root_key===x.root&&(x.sourceLineage?scopes.has(scopeKey(r.tenant_id,r.actor_id,r.api_key_id)):r.tenant_id===x.tenantId&&r.actor_id===x.userId&&r.api_key_id===null),'protocol-exact-principal-root');assert(typeof r.epoch==='string'&&/^[1-9][0-9]*$/.test(r.epoch)&&uuid(r.id)&&typeof r.kind==='string'&&['epoch','original','member','io'].includes(r.kind));
   const row=r as unknown as HistoryRow;assert(!cursor||compare(cursor,row)<0,'historical-duplicate-or-reordered');
   if(epoch!==row.epoch){assert(epoch===undefined||epochPresent,'protocol-historical-epoch-required');epoch=row.epoch;epochPresent=false;ids.clear();}assert(!ids.has(row.id),'protocol-duplicate');ids.add(row.id);
   assert(typeof row.payload_text==='string'&&typeof row.payload_sha256==='string'&&sha(row.payload_text)===row.payload_sha256,'protocol-payload-hash');for(const k of ['payload_capacity','metadata_charge','objects_charge'])uint(r[k]);
   const size=Buffer.byteLength(row.payload_text);assert(size<=32768&&BigInt(row.payload_capacity)>=BigInt(size)&&BigInt(row.payload_capacity)<=32768n,'protocol-capacity');assert(BigInt(row.metadata_charge)===2n*(BigInt(row.payload_capacity)+(row.kind==='member'?1024n:0n))&&BigInt(row.objects_charge)===(row.kind==='member'?4n:2n),'protocol-native-charge');
   const p=record(JSON.parse(row.payload_text)),terminal=row.kind==='epoch'?'CLOSED':row.kind==='original'?'DRAINED':row.kind==='io'?'DRAINED':null;assert(terminal?p.state===terminal:typeof p.state==='string'&&['COMMITTED','ROLLED_BACK'].includes(p.state),'protocol-unresolved-history');
   if(row.kind==='epoch'){assert(!epochPresent,'protocol-duplicate-epoch');epochPresent=true;}else assert(epochPresent,'protocol-historical-epoch-required');if(row.kind==='original')assert(typeof p.original_hash==='string'&&known.has(p.original_hash)&&(!x.sourceLineage||sourceScopes.get(p.original_hash)===scopeKey(row.tenant_id,row.actor_id,row.api_key_id)),'protocol-original-request-lineage');
   n++;bytes+=BigInt(size);metadata+=BigInt(row.metadata_charge);objects+=BigInt(row.objects_charge);assert(n<=BigInt(header.rows)&&bytes<=BigInt(maxBytes),'historical-whole-membership-bound');counts[row.kind]++;chain=sha(chain+'\n'+JSON.stringify(row));cursor={epoch:row.epoch,kind:row.kind,id:row.id};
  }
 }
 assert(epochPresent&&cursor?.epoch===header.max_epoch&&n===BigInt(header.rows)&&bytes===BigInt(header.payload_bytes)&&metadata===BigInt(header.metadata_charge)&&objects===BigInt(header.objects_charge),'historical-no-omission-entire-root');
 assert.deepEqual(await bound(),header,'historical-header-snapshot-drift');assert.deepEqual(await session(),opening,'historical-owner-root-fence-changed');
 return Object.freeze({schema:'source-owner-complete-protocol-history/v1' as const,root_key:x.root,rows:header.rows,payload_bytes:header.payload_bytes,metadata_charge:header.metadata_charge,objects_charge:header.objects_charge,max_epoch:header.max_epoch,counts,source_history_sha256:chain,complete_stream:true as const,all_history_closed:true as const,protocol_only:true as const,business_ACK_proved:false as const,full_FS_census:false as const,public_authority:false as const});
}
