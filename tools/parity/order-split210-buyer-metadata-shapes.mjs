/** Build-only buyer PIM representation. No PG, live catalogue, filesystem,
 * runtime admission or verdict. The generated branch MUST follow the existing
 * fresh full order_split210_require() and authenticated immutable DATA read. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const sha=s=>createHash('sha256').update(s).digest('hex');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const digest=v=>sha(JSON.stringify(canonical(v)));
const freeze=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;};
export const ORDER_SPLIT210_BUYER_METADATA_KEY='public.buyer_address_guards()';
export const ORDER_SPLIT210_BUYER_METADATA_SOURCE=Object.freeze({
 before_sha256:'a7fcbb15ba9b5bae29886c346db8ce8e3407acf46413185b996f87b6268e28a5',
 after_sha256:'7a9ab1f2d70f7da30e988b6f0db7f388205d5963dc998d1a4fb4be42c1a8425b',
 before_source_sha256:'7f7a8a2a79b19b85b7f28f51b440173816b83a8146f11a4d383d9d161ed51c38',
 after_source_sha256:'3c2d961def62086b605174e4c8cc6d3f54a1530f859b8affbb037de37a70d5e7',
 ancestor208_sha256:'49c63177a92fe4bff983abf62bd0326a4d9cb47e56ba75c1fac2a6d0df893ed3',
 ancestor208_source_sha256:'75ab6f265b618add8a010604d481dc0288f32514fb263b300be9abc53cde212f',
});
function capture(v,depth=0,budget={nodes:0,bytes:0}){
 assert(++budget.nodes<=100000&&depth<=32,'finite metadata JSON');
 if(v===null||typeof v==='boolean')return v;
 if(typeof v==='number'){assert(Number.isFinite(v));return v;}
 if(typeof v==='string'){budget.bytes+=Buffer.byteLength(v);assert(budget.bytes<=4194304);assert.equal(Buffer.from(v,'utf8').toString('utf8'),v);assert(!v.includes('\0'));return v;}
 assert(v&&typeof v==='object'&&[Object.prototype,null,Array.prototype].includes(Object.getPrototypeOf(v)),'plain metadata data');
 const array=Array.isArray(v),ds=Object.getOwnPropertyDescriptors(v),keys=Reflect.ownKeys(v),out=array?[]:{};
 assert(keys.every(k=>typeof k==='string'));if(array)assert(keys.length===v.length+1&&v.length<=100000,'dense finite arrays');
 for(const k of keys){if(array&&k==='length')continue;if(array)assert(/^(0|[1-9][0-9]*)$/.test(k)&&Number(k)<v.length);assert(Object.hasOwn(ds[k],'value')&&ds[k].enumerable,'metadata data properties only');budget.bytes+=Buffer.byteLength(k)+3;assert(budget.bytes<=4194304);Object.defineProperty(out,k,{value:capture(ds[k].value,depth+1,budget),enumerable:true,writable:true,configurable:true});}return out;
}
function exact(v,fields){assert.deepEqual(Reflect.ownKeys(v).sort(),fields.slice().sort(),'exact buyer source fields');}
function sourceChange(value,ancestor){
 const c=capture(value),a=capture(ancestor);assert.equal(Object.keys(a).length,24);assert.equal(digest(a),ORDER_SPLIT210_BUYER_METADATA_SOURCE.ancestor208_sha256,'source-authenticated buyer ancestor208');assert.equal(sha(a.source),ORDER_SPLIT210_BUYER_METADATA_SOURCE.ancestor208_source_sha256);exact(c,['kind','key','before','after']);assert.equal(c.kind,'function');assert.equal(c.key,ORDER_SPLIT210_BUYER_METADATA_KEY);
 for(const side of ['before','after']){assert.equal(Object.keys(c[side]).length,24);assert.equal(digest(c[side]),ORDER_SPLIT210_BUYER_METADATA_SOURCE[side+'_sha256'],'source-authenticated buyer '+side);assert.equal(sha(c[side].source),ORDER_SPLIT210_BUYER_METADATA_SOURCE[side+'_source_sha256']);}return c;
}
const fields=Object.freeze([['definition','definition'],['owner','owner'],['language','language'],['volatility','volatility'],['strict','strict'],['leakproof','leakproof'],['security_definer','security_definer'],['parallel','parallel'],['kind','kind'],['returns_set','returns_set'],['arguments','arguments'],['result','result'],['argument_modes','argument_modes'],['argument_names','argument_names'],['defaults','defaults'],['configuration','config'],['cost','cost'],['rows','rows']]);
const signatures=Object.freeze([ORDER_SPLIT210_BUYER_METADATA_KEY,ORDER_SPLIT210_BUYER_METADATA_KEY.slice(7)]);
const refs=()=>signatures.flatMap(signature=>[false,true].map(body_sha256=>({key:ORDER_SPLIT210_BUYER_METADATA_KEY,signature,body_sha256})));
function shape(value,ref){return {signature:ref.signature,...Object.fromEntries(fields.map(([to,from])=>[to,value[from]])),acl:value.acl.map(a=>[a.grantor,a.grantee,a.privilege,a.grantable]),...(ref.body_sha256?{body_sha256:sha(value.source)}:{})};}
function shapeSql(side){
 assert(['before','after','ancestor208'].includes(side));const raw="(entry->'"+side+"')",tagged="(entry->'"+side+"_check')";
 return "(jsonb_build_object('signature',item->'signature',"+fields.map(([to,from])=>"'"+to+"',"+raw+"->'"+from+"'").join(',')+",'acl',(SELECT coalesce(jsonb_agg(jsonb_build_array(a->'grantor',a->'grantee',a->'privilege',a->'grantable') ORDER BY ordinal),'[]'::jsonb) FROM jsonb_array_elements("+raw+"->'acl') WITH ORDINALITY buyer_acl(a,ordinal)))||CASE WHEN item->'body_sha256'='true'::jsonb THEN jsonb_build_object('body_sha256',"+tagged+"->'source'->1) ELSE '{}'::jsonb END)";
}
/** SOURCE-only model for controlled tests. It cannot authenticate a current DB
 * or replace the emitted branch's mandatory fresh full Native guard. */
export function projectOrderSplit210BuyerMetadataShape({change,ancestor208,value}){
 const c=sourceChange(change,ancestor208),a=capture(ancestor208),v=capture(value);
 if(!v||typeof v!=='object'||Array.isArray(v)||!signatures.includes(v.signature))return null;
 for(const ref of refs()){const before=shape(c.before,ref),after=shape(c.after,ref);if(digest(v)===digest(before)||digest(v)===digest(after))return freeze(before);if(digest(v)===digest(shape(a,ref)))return freeze(v);}
 assert.fail('exact whole source buyer PIM metadata required');
}
/** No SQL expression arguments or arbitrary templates. Fixed aliases are the
 * existing try_metadata_projection locals: entries,entry,item,result. Existing
 * raw/tagged buyer ancestor records are reused; tagged/raw/scalar outer209
 * branches remain the caller's literal source. This branch follows those
 * whole-record cases and precedes the generic PIM metadata array gate. */
export function deriveOrderSplit210BuyerMetadataShapes(options){
 const o=capture(options);exact(o,['change','ancestor208']);const change=sourceChange(o.change,o.ancestor208),ancestor208=capture(o.ancestor208),references=refs();
 const sql=`  -- Whole buyer PIM shapes reuse SOURCE-authenticated change descriptors.
  IF value->>'signature'=ANY(ARRAY['public.buyer_address_guards()','buyer_address_guards()']::text[]) THEN
   SELECT v INTO STRICT entry FROM jsonb_array_elements(entries->'changes') v WHERE v->>'key'='public.buyer_address_guards()';
   SELECT entry||jsonb_build_object('ancestor208',v->'value') INTO STRICT entry FROM jsonb_array_elements(entries->'metadata_ancestor_records') v WHERE v->>'kind'='function' AND v->>'key'='public.buyer_address_guards()' AND jsonb_typeof(v->'value'->'source')='string' AND jsonb_typeof(v->'value'->'definition')='string';
   SELECT entry||jsonb_build_object('ancestor208_check',v->'value') INTO STRICT entry FROM jsonb_array_elements(entries->'metadata_ancestor_records') v WHERE v->>'kind'='function' AND v->>'key'='public.buyer_address_guards()' AND jsonb_typeof(v->'value'->'source')='array' AND jsonb_typeof(v->'value'->'definition')='array';
   FOR item IN SELECT v FROM jsonb_array_elements(entries->'metadata_compact_shapes') v WHERE v->>'key'='public.buyer_address_guards()' LOOP
    result:=${shapeSql('before')};
    IF value=${shapeSql('after')} OR value=result THEN RETURN result;END IF;
    result:=${shapeSql('ancestor208')};IF value=result THEN RETURN value;END IF;
   END LOOP;
   RAISE EXCEPTION 'Split210 source closure is unsealed or changed' USING ERRCODE='55000';
  END IF;`;
 const old=references.map(ref=>({key:change.key,before:shape(change.before,ref),after:shape(change.after,ref)})),oldAncestors=references.map(ref=>shape(ancestor208,ref));
 const bytes=v=>Buffer.byteLength(JSON.stringify(canonical(v))),oldBytes=bytes(old)+bytes(oldAncestors),newBytes=bytes(references);
 return freeze({key:change.key,refs:references,sql,fields:20,body_sha256_variant_fields:21,
  source_proofs:ORDER_SPLIT210_BUYER_METADATA_SOURCE,old_shape_bytes:oldBytes,old_before_after_shape_bytes:bytes(old),old_ancestor_shape_bytes:bytes(oldAncestors),compact_ref_bytes:newBytes,
  saved_data_bytes:oldBytes-newBytes,
  projection_counts:{signatures:2,variants:4,whole_before_shapes:4,whole_after_shapes:4,whole_ancestor208_shapes:4,acl_order:'source array ordinality'},
  requires_fresh_full210_guard:true,requires_authenticated_immutable_basis:true,new_runtime_functions:0,
  source_compilation_performed:false,native_acceptance:false,application_activation:false});
}
