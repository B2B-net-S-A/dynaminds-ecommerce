/** The aggregate bound of the cold application catalogue is 128 MiB (134217728 B), the same in
 * every reader of that catalogue; the per-record bound stays 8 MiB. A catalogue just over the
 * former 64 MiB is read and normalized; one over 128 MiB is refused before its payload is read,
 * with the same assertion name. Controlled transport on an unconnected native Client, as in
 * packing-catalogue-normalization.test.mjs — not a PostgreSQL proof. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import pg from 'pg';
import {Socket} from 'node:net';
import {readPackingCatalogue,validateRecoverySchema,LIMITS,SCHEMA_VERSION,SQL_SHA256} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-catalogue-reader.mjs';
import {LIMITS as V7_LIMITS} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-v7-compiler-validator.mjs';
import {CONTEXT_SQL,COUNT_SQL,LENGTH_SQL,PAYLOAD_SQL,SCOPE} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-catalogue-sql.mjs';
import {SOURCE_SELECTION} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-source-selection.mjs';
import {ORDER_MERGE_DELIVERY209_INVERSE_LIMITS} from '../tools/parity/order-merge-delivery209-inverse.mjs';

const MIB=1048576,BOUND=134217728;
const countNames=['relations','indexes','sequences','inheritance','columns','constraints','policies','triggers','unsupported_internal_trigger_when','functions','types','event_triggers','default_acl','roles','role_memberships','extensions','rules','unsupported_relations','unsupported_routines','operators','operator_classes','operator_families','operator_family_operators','operator_family_procedures','access_methods','languages','extension_members','unsupported_ranges','unsupported_operator_shells','unsupported_statistics','unsupported_publications','unsupported_subscriptions','unsupported_collations','unsupported_foreign_servers','unsupported_languages'];
/** Minimal structural catalogue (required schemas, tables and functions); `pad` bytes are spread over function definitions. */
function catalogue(pad){
 const records=[];
 for(const key of SCOPE)records.push({kind:'schema',key,value:{owner:'postgres',acl_null:false,acl:[]}});
 const relation=Object.fromEntries(['owner','kind','persistence','access_method','row_security','force_row_security','replica_identity','partition','partition_bound','partition_key','options','tablespace','acl_null','acl','view'].map(k=>[k,k==='acl'?[]:null]));
 for(const key of SOURCE_SELECTION.required_tables)records.push({kind:'relation',key,value:relation});
 const fns=SOURCE_SELECTION.required_functions,per=Math.ceil(pad/fns.length);
 assert(per<LIMITS.record_bytes-4096,'fixture keeps every record under the per-record bound');
 for(const key of fns){const v=Object.fromEntries(['owner','language','kind','cost','rows','security_definer','leakproof','strict','returns_set','volatility','parallel','support','variadic','argument_names','argument_modes','arguments','result','defaults','source','binary','config','definition','acl_null','acl'].map(k=>[k,k==='acl'?[]:null]));v.definition='x'.repeat(per);records.push({kind:'function',key,value:v});}
 records.sort((a,b)=>{const x=a.kind+'\0'+a.key,y=b.kind+'\0'+b.key;return x<y?-1:x>y?1:0;});
 const counts={schemas:[...SCOPE].sort(),...Object.fromEntries(countNames.map(k=>[k,0]))};
 counts.functions=fns.length;counts.relations=SOURCE_SELECTION.required_tables.length;
 return {schema:SCHEMA_VERSION,postgres_major:18,scope:[...SCOPE],sql_sha256:SQL_SHA256,counts,records};
}
function client(rowsFor){
 const c=new pg.Client({host:'127.0.0.1',port:57081,database:'controlled_no_connection'}),stream=c.connection.stream;
 Object.defineProperty(stream,'remoteAddress',{value:'127.0.0.1'});Object.defineProperty(stream,'remotePort',{value:57081});c.processID=71;
 const context={database:'controlled_no_connection',data_directory:'/controlled',port:57081,native_start_epoch:'1792255528',owner:'postgres',role:'postgres',address:'127.0.0.1',backend_pid:71,server_version_num:'180000',read_only:'off',isolation:'read committed',timezone:'UTC',jit:'off',search_path:'pg_catalog, public',schema_lock:1,statement_timeout:'8s',lock_timeout:'8s',transaction_started_at:'2026-10-17T10:00:00Z',snapshot:'7:7:',root_xid:'7'};
 const calls=[];
 c.query=async sql=>{calls.push(sql);const rows=sql===CONTEXT_SQL?[context]:rowsFor(sql);assert(rows,'Unexpected reader SQL');c.connection.emit('readyForQuery',{status:'T'});return{rows};};
 return {c,calls,stream,selected:{database:'controlled_no_connection',data_directory:'/controlled',port:57081,native_start_epoch:'1792255528'}};
}

test('every reader of the cold catalogue uses the same 128 MiB aggregate bound; per-record and node bounds unchanged',()=>{
 assert.equal(LIMITS.encoded_bytes,BOUND);assert.equal(V7_LIMITS.encoded_bytes,BOUND);assert.equal(ORDER_MERGE_DELIVERY209_INVERSE_LIMITS.encoded_bytes,BOUND);
 for(const L of [LIMITS,V7_LIMITS])assert.deepEqual({...L,encoded_bytes:0},{records:100000,rows_per_catalogue:50000,encoded_bytes:0,record_bytes:8388608,json_nodes:1000000,json_depth:64});
 assert.deepEqual({...ORDER_MERGE_DELIVERY209_INVERSE_LIMITS,encoded_bytes:0},{records:100000,record_bytes:8388608,encoded_bytes:0,json_nodes:1000000,json_depth:64});
 const framing=readFileSync(new URL('../tools/parity/order-merge-delivery209-comparison-framing.mjs',import.meta.url),'utf8');
 assert.match(framing,/const LIMITS=Object\.freeze\(\{nodes:1000000,depth:64,records:100000,recordBytes:8388608,bytes:134217728\}\);/);
 const metadata=readFileSync(new URL('../tools/parity/order-merge-delivery209-metadata.mjs',import.meta.url),'utf8');
 assert.match(metadata,/assert\(budget\.bytes<=134217728,'metadata bytes'\)/);assert.match(metadata,/assert\(encoded\+4096<=134217728,'aggregate source catalogue bound'\)/);
 assert(!/67108864/.test(framing+metadata),'no stale 64 MiB catalogue bound');
});

test('a catalogue just over the former 64 MiB bound is read and normalized',async()=>{
 const value=catalogue(64*MIB+512*1024),payload=value.records.map(record=>({record:JSON.stringify(record)}));
 const encoded=payload.reduce((n,r)=>n+Buffer.byteLength(r.record),0);
 assert(encoded+payload.length*2+4096>64*MIB,'over the former bound');assert(encoded+payload.length*2+4096<=BOUND);
 const {c,calls,stream,selected}=client(sql=>sql===COUNT_SQL?[value.counts]:sql===LENGTH_SQL?[{records:payload.length,encoded_bytes:String(encoded),largest_record:String(Math.max(...payload.map(r=>Buffer.byteLength(r.record))))}]:sql===PAYLOAD_SQL?payload:null);
 try{
  const read=await readPackingCatalogue(c,selected);
  assert.equal(read.records.length,value.records.length);
  const normalized=validateRecoverySchema(read);assert.equal(normalized.sha256,read.sha256);
  assert.match(normalized.sha256,/^[0-9a-f]{64}$/);assert(read.records.every(r=>r.kind!=='function'||r.value.definition.length>3*MIB),'the padded definitions were read back whole');
  assert.deepEqual(calls,[CONTEXT_SQL,COUNT_SQL,LENGTH_SQL,PAYLOAD_SQL,COUNT_SQL,CONTEXT_SQL]);
 }finally{stream.destroy();}
});

test('a catalogue over 128 MiB is refused before its payload with recovery-aggregate-prepayload-bound; exactly at the bound passes the pre-check',async()=>{
 const value=catalogue(0),records=value.records.length;
 for(const [encoded,refused] of [[BOUND-(records*2+4096)+1,true],[BOUND+1,true],[200*MIB,true],[BOUND-(records*2+4096),false]]){
  const {c,calls,stream,selected}=client(sql=>sql===COUNT_SQL?[value.counts]:sql===LENGTH_SQL?[{records,encoded_bytes:String(encoded),largest_record:'1024'}]:sql===PAYLOAD_SQL?[]:null);
  try{
   if(refused){
    await assert.rejects(readPackingCatalogue(c,selected),/recovery-aggregate-prepayload-bound/,String(encoded));
    assert.deepEqual(calls,[CONTEXT_SQL,COUNT_SQL,LENGTH_SQL],'the payload is never requested');
   }else{
    // The pre-check passes; the empty controlled payload then fails the exact row count, not the bound.
    await assert.rejects(readPackingCatalogue(c,selected),e=>!/prepayload-bound/.test(String(e?.message)));
    assert(calls.includes(PAYLOAD_SQL));
   }
  }finally{stream.destroy();}
 }
});
