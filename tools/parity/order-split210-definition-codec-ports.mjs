/** Finite six-site codec stage AFTER historical Source24→25→26 transforms.
 * No payload, SQL fragment, callback or verdict inputs; no SQL execution. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {orderSplit210DefinitionCodecSql} from './order-split210-definition-codec.mjs';
const fixedDecoderSql=orderSplit210DefinitionCodecSql();
const sha=value=>createHash('sha256').update(value).digest('hex');
const freeze=value=>{if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;};
export const ORDER_SPLIT210_DEFINITION_CODEC_PORTS_SOURCE=freeze({schema:'order-split210-source30-definition-codec-ports-input/v1',
 targets:[
 {
  "name": "public.order_split210_try_function_projection",
  "bytes": 3054,
  "sha256": "4f746414c760cf3580cf2498b254c756b90a2541216f28e1cc8abed298f7f1f5",
  "anchors": [
   {
    "kind": "nonlegacy_raw_after",
    "text": " SELECT v INTO entry FROM jsonb_array_elements(entries->'changes') v WHERE v->>'key'=actual->>'key';\n",
    "bytes": 101,
    "sha256": "cbaefc151ad133abcd4c3728faee6342d290ef9b39458232f5f40502fcde3a34"
   }
  ]
 },
 {
  "name": "public.order_split210_try_metadata_projection",
  "bytes": 19151,
  "sha256": "fd1e255145071623e0d33cab26be402a21abf9945d8789807464d41f3a90ce07",
  "anchors": [
   {
    "kind": "whole_raw_function_record",
    "text": "   SELECT v INTO STRICT entry FROM jsonb_array_elements(entries->'changes') v WHERE v->>'key'=order_split210_try_metadata_projection.value->>'key';\n",
    "bytes": 148,
    "sha256": "9f870fa8fb5ed06753ee9f9b291d0b80f61b7c95360152a0297c5491e1e988a1"
   },
   {
    "kind": "financial_compact_shapes",
    "text": "   SELECT v INTO STRICT entry FROM jsonb_array_elements(entries->'changes') v WHERE v->>'key'='public.financial_return_upgrade_valid()';\n",
    "bytes": 137,
    "sha256": "66444bf73fec56d71100560b4e192030a182e21419dcdf5cc0569a04ec408928"
   },
   {
    "kind": "buyer_compact_shapes_before_ancestor_augmentation",
    "text": "   SELECT v INTO STRICT entry FROM jsonb_array_elements(entries->'changes') v WHERE v->>'key'='public.buyer_address_guards()';\n",
    "bytes": 127,
    "sha256": "212cd65471cf4c063fb0a5e66378ff1fde5484609b4e91ff2967dc157659fa2c"
   },
   {
    "kind": "ordinary_compact_shapes",
    "text": "   SELECT v INTO STRICT entry FROM jsonb_array_elements(entries->'changes') v WHERE v->>'key'='public.ordinary181_financial_valid(manual_basis jsonb)';\n",
    "bytes": 152,
    "sha256": "ad82cdfda9b93a5b507ec327c91d817a36deb0d4533308a4304c29a1a3e3368b"
   },
   {
    "kind": "literal_loop_first_statement",
    "text": "   WHERE (entries->'metadata_literal_keys') ? (v->>'key') LOOP\n",
    "bytes": 63,
    "sha256": "fbf5c99c4669a16feadb4d215d78821789d92fbd9f67f898fefd3ad8cc2e5dd4"
   }
  ]
 }
],
 decoder:{bytes:3877,sha256:'00d7a85bfd5ede2d184bfa460cf8f7d8c4335cf2524b1a180ba582ec47dd4ec2'},
 sites:6,runtime_functions:2,placement:'after fixed metadata traversal, text and candidate-filter stages'});
function deriveOne(source,pin){
 assert.equal(typeof source,'string','primitive exact authored declaration');assert.equal(Buffer.byteLength(source),pin.bytes,'finite complete declaration bytes');assert.equal(sha(source),pin.sha256,'finite complete declaration SHA');
 const delimiter='$closure210$',a=source.indexOf(delimiter)+delimiter.length,b=source.lastIndexOf(delimiter);
 assert(a>=delimiter.length&&b>a&&source.endsWith(delimiter+';\n'));assert(source.startsWith('CREATE FUNCTION '+pin.name+'('));
 const decode=fixedDecoderSql.decodeEntrySql;assert.equal(Buffer.byteLength(decode),ORDER_SPLIT210_DEFINITION_CODEC_PORTS_SOURCE.decoder.bytes);assert.equal(sha(decode),ORDER_SPLIT210_DEFINITION_CODEC_PORTS_SOURCE.decoder.sha256,'fixed independently probed decoder SQL');
 const edits=pin.anchors.map(anchor=>{assert.equal(Buffer.byteLength(anchor.text),anchor.bytes);assert.equal(sha(anchor.text),anchor.sha256,'independently fixed anchor');const at=source.indexOf(anchor.text);assert(at>a&&at<b&&source.indexOf(anchor.text,at+anchor.text.length)<0,'one complete fixed insertion anchor');return {kind:anchor.kind,beforeStart:at+anchor.text.length,before:'',after:decode+'\n',anchor_sha256:anchor.sha256};}).sort((x,y)=>x.beforeStart-y.beforeStart);
 let cursor=0,sql='';for(const edit of edits){assert(edit.beforeStart>=cursor);sql+=source.slice(cursor,edit.beforeStart);edit.afterStart=sql.length;sql+=edit.after;cursor=edit.beforeStart;}sql+=source.slice(cursor);
 let inverse=sql;for(const edit of [...edits].reverse()){assert.equal(inverse.slice(edit.afterStart,edit.afterStart+edit.after.length),edit.after);inverse=inverse.slice(0,edit.afterStart)+inverse.slice(edit.afterStart+edit.after.length);}assert.equal(inverse,source,'entire CREATE/header/body/suffix inverse');
 const outEnd=sql.lastIndexOf(delimiter);assert.equal(sql.slice(0,a),source.slice(0,a));assert.equal(sql.slice(outEnd),source.slice(b));
 const bodyEdits=edits.map(edit=>({...edit,beforeStart:edit.beforeStart-a,afterStart:edit.afterStart-a}));let bodyInverse=sql.slice(a,outEnd);for(const edit of [...bodyEdits].reverse()){assert.equal(bodyInverse.slice(edit.afterStart,edit.afterStart+edit.after.length),edit.after);bodyInverse=bodyInverse.slice(0,edit.afterStart)+bodyInverse.slice(edit.afterStart+edit.after.length);}assert.equal(bodyInverse,source.slice(a,b),'complete raw body inverse');
 return {sql,proof:{name:pin.name,source_bytes:pin.bytes,source_sha256:pin.sha256,bytes:Buffer.byteLength(sql),sha256:sha(sql),edits,body_edits:bodyEdits,whole_source_inverse_verified:true,whole_body_inverse_verified:true,header_and_suffix_preserved:true}};
}
export function deriveOrderSplit210DefinitionCodecPorts(options){
 assert.equal(arguments.length,1,'one closed source-only options object');assert(options&&Object.getPrototypeOf(options)===Object.prototype);assert.deepEqual(Object.keys(options).sort(),['functionSql','metadataSql']);assert.equal(Object.getOwnPropertySymbols(options).length,0);for(const key of Object.keys(options))assert.equal(Object.getOwnPropertyDescriptor(options,key).get,undefined,'no source accessors');
 const fn=deriveOne(options.functionSql,ORDER_SPLIT210_DEFINITION_CODEC_PORTS_SOURCE.targets[0]),metadata=deriveOne(options.metadataSql,ORDER_SPLIT210_DEFINITION_CODEC_PORTS_SOURCE.targets[1]);
 assert.equal(fn.proof.edits.length,1);assert.equal(metadata.proof.edits.length,5);
 return freeze({schema:'order-split210-definition-codec-ports/v1',functionSql:fn.sql,metadataSql:metadata.sql,targets:[fn.proof,metadata.proof],source_proofs:ORDER_SPLIT210_DEFINITION_CODEC_PORTS_SOURCE,sites:6,new_runtime_functions:0,cross_invocation_cache:false,full_payload_rehydration:false,whole_source_inverse_verified:true,whole_body_inverse_verified:true,historical_metadata_chain_changed:false,source_compilation_performed:false,native_certification:false,application_activation:false,performance_acceptance:false,business_acceptance:false});
}
