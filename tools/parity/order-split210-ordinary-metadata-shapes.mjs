/** Build-only ordinary PIM representation. No PG, live catalogue, filesystem,
 * runtime admission or verdict. The generated branch MUST follow the existing
 * fresh full order_split210_require() and authenticated immutable DATA read. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const sha=s=>createHash('sha256').update(s).digest('hex');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const digest=v=>sha(JSON.stringify(canonical(v)));
const freeze=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;};
export const ORDER_SPLIT210_ORDINARY_METADATA_KEY='public.ordinary181_financial_valid(manual_basis jsonb)';
export const ORDER_SPLIT210_ORDINARY_METADATA_SOURCE=Object.freeze({
 before_sha256:'85a2ac0dc5c7a46ae2db18505b4961bfc163a122dd91240490d3542967942477',
 after_sha256:'6544df1e5cd6ba444211284b3c7b3534b73ca4158a753a8c33c71de31b464674',
 before_source_sha256:'984dd5ab7e4a0312c55c32db348f05f272330f38eec5bf71df41d24eb04917c6',
 after_source_sha256:'c8ed42eaf96711e9d1068548291dc53a29d91255362eccdc40cc1dcb80b54fff',
 signature_producer_source_sha256:'d60dfa360e2cb6b240aceccec67578685f715ebda9514babc7cc0d3baecf46d1',
 signature_producer_source_bytes:141802,signature_producer_body_sha256:'0c28eea2eb88f0580540770447c3c5173657ee31f651e590e8e7985637e83f7d',
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
function exact(v,fields){assert.deepEqual(Reflect.ownKeys(v).sort(),fields.slice().sort(),'exact ordinary source fields');}
function sourceChange(value){
 const c=capture(value);exact(c,['kind','key','before','after']);assert.equal(c.kind,'function');assert.equal(c.key,ORDER_SPLIT210_ORDINARY_METADATA_KEY);
 for(const side of ['before','after']){assert.equal(Object.keys(c[side]).length,24);assert.equal(digest(c[side]),ORDER_SPLIT210_ORDINARY_METADATA_SOURCE[side+'_sha256'],'source-authenticated ordinary '+side);assert.equal(sha(c[side].source),ORDER_SPLIT210_ORDINARY_METADATA_SOURCE[side+'_source_sha256']);}return c;
}
const fields=Object.freeze([['definition','definition'],['owner','owner'],['language','language'],['volatility','volatility'],['strict','strict'],['leakproof','leakproof'],['security_definer','security_definer'],['parallel','parallel'],['kind','kind'],['returns_set','returns_set'],['arguments','arguments'],['result','result'],['argument_modes','argument_modes'],['argument_names','argument_names'],['defaults','defaults'],['configuration','config'],['cost','cost'],['rows','rows']]);
// SOURCE170 uses p.oid::regprocedure::text, whose argument identities contain
// types only. The complete descriptor key and arguments still retain the formal
// manual_basis name; they are deliberately NOT reused as PIM signatures.
const signatures=Object.freeze(['public.ordinary181_financial_valid(jsonb)','ordinary181_financial_valid(jsonb)']);
const refs=()=>signatures.flatMap(signature=>[false,true].map(body_sha256=>({key:ORDER_SPLIT210_ORDINARY_METADATA_KEY,signature,body_sha256})));
function shape(value,ref){return {signature:ref.signature,...Object.fromEntries(fields.map(([to,from])=>[to,value[from]])),acl:value.acl.map(a=>[a.grantor,a.grantee,a.privilege,a.grantable]),...(ref.body_sha256?{body_sha256:sha(value.source)}:{})};}
function shapeSql(side){
 assert(['before','after'].includes(side));const raw="(entry->'"+side+"')",tagged="(entry->'"+side+"_check')";
 return "(jsonb_build_object('signature',item->'signature',"+fields.map(([to,from])=>"'"+to+"',"+raw+"->'"+from+"'").join(',')+",'acl',(SELECT coalesce(jsonb_agg(jsonb_build_array(a->'grantor',a->'grantee',a->'privilege',a->'grantable') ORDER BY ordinal),'[]'::jsonb) FROM jsonb_array_elements("+raw+"->'acl') WITH ORDINALITY ordinary_acl(a,ordinal)))||CASE WHEN item->'body_sha256'='true'::jsonb THEN jsonb_build_object('body_sha256',"+tagged+"->'source'->1) ELSE '{}'::jsonb END)";
}
/** SOURCE-only model for controlled tests. It cannot authenticate a current DB
 * or replace the emitted branch's mandatory fresh full Native guard. */
export function projectOrderSplit210OrdinaryMetadataShape({change,value}){
 const c=sourceChange(change),v=capture(value);
 if(!v||typeof v!=='object'||Array.isArray(v)||!signatures.includes(v.signature))return null;
 for(const ref of refs()){const before=shape(c.before,ref),after=shape(c.after,ref);if(digest(v)===digest(before)||digest(v)===digest(after))return freeze(before);}
 assert.fail('exact whole source ordinary PIM metadata required');
}
/** No SQL expression arguments or arbitrary templates. Fixed aliases are the
 * existing try_metadata_projection locals: entries,entry,item,result. */
export function deriveOrderSplit210OrdinaryMetadataShapes(options){
 const o=capture(options);exact(o,['change']);const change=sourceChange(o.change),references=refs();
 const sql=`  -- Whole ordinary PIM shapes reuse SOURCE-authenticated change descriptors.
  IF value->>'signature'=ANY(ARRAY['public.ordinary181_financial_valid(jsonb)','ordinary181_financial_valid(jsonb)']::text[]) THEN
   SELECT v INTO STRICT entry FROM jsonb_array_elements(entries->'changes') v WHERE v->>'key'='public.ordinary181_financial_valid(manual_basis jsonb)';
   FOR item IN SELECT v FROM jsonb_array_elements(entries->'metadata_compact_shapes') v WHERE v->>'key'='public.ordinary181_financial_valid(manual_basis jsonb)' LOOP
    result:=${shapeSql('before')};
    IF value=${shapeSql('after')} OR value=result THEN RETURN result;END IF;
   END LOOP;
   RAISE EXCEPTION 'Split210 source closure is unsealed or changed' USING ERRCODE='55000';
  END IF;`;
 const old=references.map(ref=>({key:change.key,before:shape(change.before,ref),after:shape(change.after,ref)}));
 return freeze({key:change.key,refs:references,sql,fields:20,body_sha256_variant_fields:21,
  source_proofs:ORDER_SPLIT210_ORDINARY_METADATA_SOURCE,old_shape_bytes:Buffer.byteLength(JSON.stringify(canonical(old))),compact_ref_bytes:Buffer.byteLength(JSON.stringify(canonical(references))),
  saved_data_bytes:Buffer.byteLength(JSON.stringify(canonical(old)))-Buffer.byteLength(JSON.stringify(canonical(references))),
  projection_counts:{signatures:2,variants:4,whole_before_shapes:4,whole_after_shapes:4,acl_order:'source array ordinality'},
  requires_fresh_full210_guard:true,requires_authenticated_immutable_basis:true,new_runtime_functions:0,
  source_compilation_performed:false,native_acceptance:false,application_activation:false});
}
