/** Build-only financial PIM representation. No PG, live catalogue, filesystem,
 * runtime admission or verdict. The generated branch MUST follow the existing
 * fresh full order_split210_require() and authenticated immutable DATA read. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const sha=s=>createHash('sha256').update(s).digest('hex');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const digest=v=>sha(JSON.stringify(canonical(v)));
const freeze=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;};
export const ORDER_SPLIT210_FINANCIAL_METADATA_KEY='public.financial_return_upgrade_valid()';
export const ORDER_SPLIT210_FINANCIAL_METADATA_SOURCE=Object.freeze({
 before_sha256:'7f3cfbe609e30b603c93f220273c54a2f1f9637b81fcea4540cef2372e51c199',
 after_sha256:'c18d0962847ab27e3bb56aeeb488c40413af7a825f5877a11eaa91a77bc7f5a4',
 before_source_sha256:'88144ddbcac918c40b0c2ea8ad5997461388b484a5a740ae220c370477ee38a7',
 after_source_sha256:'3688e1900b4a4db0bb0753e28924bb0475ad286fb373d6a46027689bb00b5e8e',
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
function exact(v,fields){assert.deepEqual(Reflect.ownKeys(v).sort(),fields.slice().sort(),'exact financial source fields');}
function sourceChange(value){
 const c=capture(value);exact(c,['kind','key','before','after']);assert.equal(c.kind,'function');assert.equal(c.key,ORDER_SPLIT210_FINANCIAL_METADATA_KEY);
 for(const side of ['before','after']){assert.equal(Object.keys(c[side]).length,24);assert.equal(digest(c[side]),ORDER_SPLIT210_FINANCIAL_METADATA_SOURCE[side+'_sha256'],'source-authenticated financial '+side);assert.equal(sha(c[side].source),ORDER_SPLIT210_FINANCIAL_METADATA_SOURCE[side+'_source_sha256']);}return c;
}
const fields=Object.freeze([['definition','definition'],['owner','owner'],['language','language'],['volatility','volatility'],['strict','strict'],['leakproof','leakproof'],['security_definer','security_definer'],['parallel','parallel'],['kind','kind'],['returns_set','returns_set'],['arguments','arguments'],['result','result'],['argument_modes','argument_modes'],['argument_names','argument_names'],['defaults','defaults'],['configuration','config'],['cost','cost'],['rows','rows']]);
const signatures=Object.freeze([ORDER_SPLIT210_FINANCIAL_METADATA_KEY,ORDER_SPLIT210_FINANCIAL_METADATA_KEY.slice(7)]);
const refs=()=>signatures.flatMap(signature=>[false,true].map(body_sha256=>({key:ORDER_SPLIT210_FINANCIAL_METADATA_KEY,signature,body_sha256})));
function shape(value,ref){return {signature:ref.signature,...Object.fromEntries(fields.map(([to,from])=>[to,value[from]])),acl:value.acl.map(a=>[a.grantor,a.grantee,a.privilege,a.grantable]),...(ref.body_sha256?{body_sha256:sha(value.source)}:{})};}
function shapeSql(side){
 assert(['before','after'].includes(side));const raw="(entry->'"+side+"')",tagged="(entry->'"+side+"_check')";
 return "(jsonb_build_object('signature',item->'signature',"+fields.map(([to,from])=>"'"+to+"',"+raw+"->'"+from+"'").join(',')+",'acl',(SELECT coalesce(jsonb_agg(jsonb_build_array(a->'grantor',a->'grantee',a->'privilege',a->'grantable') ORDER BY ordinal),'[]'::jsonb) FROM jsonb_array_elements("+raw+"->'acl') WITH ORDINALITY financial_acl(a,ordinal)))||CASE WHEN item->'body_sha256'='true'::jsonb THEN jsonb_build_object('body_sha256',"+tagged+"->'source'->1) ELSE '{}'::jsonb END)";
}
/** SOURCE-only model for controlled tests. It cannot authenticate a current DB
 * or replace the emitted branch's mandatory fresh full Native guard. */
export function projectOrderSplit210FinancialMetadataShape({change,value}){
 const c=sourceChange(change),v=capture(value);
 if(!v||typeof v!=='object'||Array.isArray(v)||!signatures.includes(v.signature))return null;
 for(const ref of refs()){const before=shape(c.before,ref),after=shape(c.after,ref);if(digest(v)===digest(before)||digest(v)===digest(after))return freeze(before);}
 assert.fail('exact whole source financial PIM metadata required');
}
/** No SQL expression arguments or arbitrary templates. Fixed aliases are the
 * existing try_metadata_projection locals: entries,entry,item,result. */
export function deriveOrderSplit210FinancialMetadataShapes(options){
 const o=capture(options);exact(o,['change']);const change=sourceChange(o.change),references=refs();
 const sql=`  -- Whole financial PIM shapes reuse SOURCE-authenticated change descriptors.
  IF value->>'signature'=ANY(ARRAY['public.financial_return_upgrade_valid()','financial_return_upgrade_valid()']::text[]) THEN
   SELECT v INTO STRICT entry FROM jsonb_array_elements(entries->'changes') v WHERE v->>'key'='public.financial_return_upgrade_valid()';
   FOR item IN SELECT v FROM jsonb_array_elements(entries->'metadata_compact_shapes') v WHERE v->>'key'='public.financial_return_upgrade_valid()' LOOP
    result:=${shapeSql('before')};
    IF value=${shapeSql('after')} OR value=result THEN RETURN result;END IF;
   END LOOP;
   RAISE EXCEPTION 'Split210 source closure is unsealed or changed' USING ERRCODE='55000';
  END IF;`;
 const old=references.map(ref=>({key:change.key,before:shape(change.before,ref),after:shape(change.after,ref)}));
 return freeze({key:change.key,refs:references,sql,fields:20,body_sha256_variant_fields:21,
  source_proofs:ORDER_SPLIT210_FINANCIAL_METADATA_SOURCE,old_shape_bytes:Buffer.byteLength(JSON.stringify(canonical(old))),compact_ref_bytes:Buffer.byteLength(JSON.stringify(canonical(references))),
  saved_data_bytes:Buffer.byteLength(JSON.stringify(canonical(old)))-Buffer.byteLength(JSON.stringify(canonical(references))),
  projection_counts:{signatures:2,variants:4,whole_before_shapes:4,whole_after_shapes:4,acl_order:'source array ordinality'},
  requires_fresh_full210_guard:true,requires_authenticated_immutable_basis:true,new_runtime_functions:0,
  source_compilation_performed:false,native_acceptance:false,application_activation:false});
}
