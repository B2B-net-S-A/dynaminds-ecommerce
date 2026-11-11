/** Pure source-authored physical DATA codec. No IO, SQL execution or runtime authority. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const freeze=value=>{if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;};
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const text=value=>JSON.stringify(canonical(value));
const sha=value=>createHash('sha256').update(value).digest('hex');
const marker=Object.freeze(['order-split210-after-definition/v1']);
const logicalSchema='order-split210-projection-basis/v1';
const physicalSchema='order-split210-projection-basis/definition-codec-v1';
const fields=Object.freeze(['owner','language','kind','cost','rows','security_definer','leakproof','strict','returns_set','volatility','parallel','support','variadic','argument_names','argument_modes','arguments','result','defaults','source','binary','config','definition','acl_null','acl'].sort());
// Literal ordered roster independently checked against source-authored22 changes.
const keys=Object.freeze(["public.fa3_draft_fingerprint()","public.b2b_invoice_fingerprint()","public.b2b_credit_fingerprint()","public.wms_row_guard()","public.order_merge_delivery209_validation_snapshot()","public.order_merge_delivery209_predecessor_descriptor(fn oid)","public.order_merge_delivery209_predecessor_definition(fn oid)","public.order_merge_delivery209_predecessor_source(fn oid)","public.order_merge_delivery209_predecessor_metadata(value jsonb)","public.order_merge_delivery209_predecessor_descriptor(fn oid, entries jsonb)","public.order_merge_delivery209_predecessor_definition(fn oid, entries jsonb)","public.order_merge_delivery209_predecessor_source(fn oid, entries jsonb)","public.order_merge_delivery209_predecessor_metadata(value jsonb, entries jsonb)","public.order_merge_delivery209_predecessor_source_sha(fn oid, entries jsonb)","public.buyer_address_guards()","public.financial_return_upgrade_valid()","public.order_merge_delivery209_history_operative_valid(manual_basis jsonb)","public.order_merge_delivery209_buyer_guards(manual_basis jsonb)","public.order_merge_delivery209_startup_operative_valid(entries jsonb)","public.ordinary181_financial_valid(manual_basis jsonb)","public.ordinary181_credit_calculate(projection_ok boolean)","public.ordinary180_projection_valid(b jsonb)"]);
export const ORDER_SPLIT210_DEFINITION_CODEC=freeze({schema:'order-split210-definition-codec/v1',logical_schema:logicalSchema,physical_schema:physicalSchema,marker,keys,descriptor_fields:fields,changes:22,new_runtime_functions:0,cross_invocation_cache:false});
const suffix='$function$\n',delimiter='$function$',asMarker='AS $function$';
function plain(value){return value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;}
function jsonValue(value,seen=new Set()){
 if(value===null||typeof value==='string'||typeof value==='boolean')return;
 if(typeof value==='number'){assert(Number.isFinite(value),'finite JSON number');return;}
 assert(typeof value==='object'&&!seen.has(value),'acyclic plain JSON only');seen.add(value);
 assert(Array.isArray(value)||plain(value),'plain JSON container only');assert.equal(Object.getOwnPropertySymbols(value).length,0);
 for(const key of Object.keys(value)){assert(Object.getOwnPropertyDescriptor(value,key).get===undefined,'no JSON accessors');jsonValue(value[key],seen);}
 if(Array.isArray(value))assert.equal(Object.keys(value).length,value.length,'no sparse arrays or extra properties');seen.delete(value);
}
function header(before){
 assert.equal(typeof before.source,'string');assert.equal(typeof before.definition,'string');
 assert(!before.source.includes(delimiter),'source must not collide with fixed delimiter');
 const at=before.definition.indexOf(asMarker);assert(at>=0&&before.definition.indexOf(asMarker,at+asMarker.length)<0,'one complete definition header');
 const result=before.definition.slice(0,at+asMarker.length);assert.equal(before.definition,result+before.source+suffix,'complete raw BEFORE binding');return result;
}
function checkEntry(entry,index,physical){
 assert(plain(entry));assert.equal(entry.kind,'function');assert.equal(entry.key,keys[index],'exact ordered source roster');
 for(const value of [entry.before,entry.after]){assert(plain(value));assert.deepEqual(Object.keys(value).sort(),fields,'complete24-field descriptor');}
 const prefix=header(entry.before);assert(prefix.startsWith('CREATE OR REPLACE FUNCTION '+entry.key.slice(0,entry.key.indexOf('('))+'('),'named source header');
 assert.equal(typeof entry.after.source,'string');assert(!entry.after.source.includes(delimiter),'AFTER source delimiter collision');
 const other=value=>Object.fromEntries(Object.entries(value).filter(([key])=>key!=='source'&&key!=='definition'));
 assert.deepEqual(other(entry.after),other(entry.before),'all22 original header and ACL fields');
 if(physical)assert.deepEqual(entry.after.definition,marker,'exact closed version marker');
 else assert.equal(entry.after.definition,prefix+entry.after.source+suffix,'complete raw AFTER binding');
 return prefix;
}
function validate(data,physical){
 jsonValue(data);assert(plain(data));assert.equal(data.schema,physical?physicalSchema:logicalSchema,'exact DATA representation version');
 assert(Array.isArray(data.changes)&&data.changes.length===22,'exact22 changes');
 return data.changes.map((entry,index)=>checkEntry(entry,index,physical));
}
export function encodeOrderSplit210DefinitionData(data){
 validate(data,false);const result=structuredClone(data);result.schema=physicalSchema;
 for(const entry of result.changes)entry.after.definition=[...marker];return freeze(result);
}
export function decodeOrderSplit210DefinitionData(data){
 const headers=validate(data,true),result=structuredClone(data);result.schema=logicalSchema;
 result.changes.forEach((entry,index)=>{entry.after.definition=headers[index]+entry.after.source+suffix;});validate(result,false);return freeze(result);
}
export function decodeOrderSplit210DefinitionEntry(entry){
 jsonValue(entry);assert(plain(entry));const index=keys.indexOf(entry.key);assert(index>=0,'closed source entry key');
 const prefix=checkEntry(entry,index,true),result=structuredClone(entry);result.after.definition=prefix+result.after.source+suffix;checkEntry(result,index,false);return freeze(result);
}
const quote=value=>"'"+value.replaceAll("'","''")+"'";
const json=value=>quote(JSON.stringify(value))+'::jsonb';
function sqlEntryValid(e,ordinal){
 const before=`(${e}->'before')`,after=`(${e}->'after')`,bs=`(${e}#>>'{before,source}')`,bd=`(${e}#>>'{before,definition}')`,as=`(${e}#>>'{after,source}')`;
 const prefix=`substring(${bd} FROM 1 FOR position(${quote(asMarker)} IN ${bd})+length(${quote(asMarker)})-1)`;
 const roster=ordinal?`${e}->>'key'=(${json(keys)}->>(${ordinal}-1))`:`${json(keys)} ? (${e}->>'key')`;
 const simple=`jsonb_typeof(${e})='object' AND ${e}->>'kind'='function' AND ${roster} AND jsonb_typeof(${before})='object' AND jsonb_typeof(${after})='object' AND jsonb_typeof(${before}->'source')='string' AND jsonb_typeof(${before}->'definition')='string' AND jsonb_typeof(${after}->'source')='string'`;
 const detail=`(SELECT jsonb_agg(c31_codec_fields.c31_field ORDER BY c31_codec_fields.c31_field COLLATE "C") FROM jsonb_object_keys(${before}) AS c31_codec_fields(c31_field))=${json(fields)} AND (SELECT jsonb_agg(c31_codec_fields.c31_field ORDER BY c31_codec_fields.c31_field COLLATE "C") FROM jsonb_object_keys(${after}) AS c31_codec_fields(c31_field))=${json(fields)} AND (${after}-'source'-'definition')=(${before}-'source'-'definition') AND ${after}->'definition'=${json(marker)} AND position(${quote(delimiter)} IN ${bs})=0 AND position(${quote(delimiter)} IN ${as})=0 AND position(${quote(asMarker)} IN ${bd})>0 AND (length(${bd})-length(replace(${bd},${quote(asMarker)},'')))/length(${quote(asMarker)})=1 AND ${bd}=${prefix}||${bs}||${quote(suffix)} AND starts_with(${prefix},'CREATE OR REPLACE FUNCTION '||split_part(${e}->>'key','(',1)||'(')`;
 return `(CASE WHEN ${simple} THEN coalesce((${detail}),false) ELSE false END)`;
}
function sqlEntryDecode(e){const bd=`(${e}#>>'{before,definition}')`;return `jsonb_set(${e},'{after,definition}',to_jsonb(substring(${bd} FROM 1 FOR position(${quote(asMarker)} IN ${bd})+length(${quote(asMarker)})-1)||(${e}#>>'{after,source}')||${quote(suffix)}),false)`;}
/** Blocks use only already-existing entries/entry variables. No new callee or
 * local declarations. Full-payload decoding is OPTIONAL; selected entry decoding
 * avoids reconstructing all large definitions for tagged/family-only readers.
 * A fresh independent whole515 guard must authenticate the executing code/data
 * before either block. These checks do not confer that authority themselves. */
function sqlBlocks(){
 const basic=`jsonb_typeof(entries)='object' AND entries->>'schema'=${quote(physicalSchema)} AND jsonb_typeof(entries->'changes')='array'`;
 const valid=`CASE WHEN ${basic} THEN jsonb_array_length(entries->'changes')=22 AND NOT EXISTS(SELECT FROM jsonb_array_elements(entries->'changes') WITH ORDINALITY c31_codec(v,ordinal) WHERE NOT ${sqlEntryValid('c31_codec.v','c31_codec.ordinal::integer')}) ELSE false END`;
 const decodeAssignmentSql=`IF (${valid}) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Split210 closed definition DATA required' USING ERRCODE='55000';END IF;\nentries:=jsonb_set(jsonb_set(entries,'{schema}',${json(logicalSchema)},false),'{changes}',(SELECT jsonb_agg(${sqlEntryDecode('c31_codec.v')} ORDER BY c31_codec.ordinal) FROM jsonb_array_elements(entries->'changes') WITH ORDINALITY c31_codec(v,ordinal)),false);`;
 const decodeEntrySql=`IF ${sqlEntryValid('entry')} IS DISTINCT FROM true THEN RAISE EXCEPTION 'Split210 closed definition entry required' USING ERRCODE='55000';END IF;\nentry:=${sqlEntryDecode('entry')};`;
 return {decodeAssignmentSql,decodeEntrySql};
}
export function orderSplit210DefinitionCodecSql(){assert.equal(arguments.length,0);return freeze(sqlBlocks());}
export function deriveOrderSplit210DefinitionCodec(data){
 const physicalData=encodeOrderSplit210DefinitionData(data),decoded=decodeOrderSplit210DefinitionData(physicalData);assert.equal(text(decoded),text(data),'entire canonical logical DATA inverse');
 const logical=text(data),physical=text(physicalData),blocks=sqlBlocks();
 return freeze({schema:'order-split210-definition-codec-source-candidate/v1',physicalData,logical_data:{bytes:Buffer.byteLength(logical),sha256:sha(logical)},physical_data:{bytes:Buffer.byteLength(physical),sha256:sha(physical)},saved_bytes:Buffer.byteLength(logical)-Buffer.byteLength(physical),...blocks,whole_canonical_inverse_proven:true,raw_before_preserved:true,after_source_preserved:true,source_compilation_performed:false,native_certification:false,application_activation:false,performance_acceptance:false});
}
