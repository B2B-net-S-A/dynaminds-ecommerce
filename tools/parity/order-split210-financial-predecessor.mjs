/** Two closed source-authored financial folds. No DB/catalogue observation,
 * arbitrary family fallback, runtime admission or complete210 verdict. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {orderMergeDelivery209HistorySqlSpans as spans} from './order-merge-delivery209-history-closure.mjs';
import {ORDER_SPLIT210_FINANCIAL_SOURCE} from './order-split210-financial-successor.mjs';
const sha=s=>createHash('sha256').update(s).digest('hex');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const digest=v=>sha(JSON.stringify(canonical(v)));
const freeze=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;};
const key='public.financial_return_upgrade_valid()';
export const ORDER_SPLIT210_FINANCIAL_PREDECESSOR_SOURCE=freeze({
 source204_bytes:13279659,source204_sha256:'410fe04993d1e5c714319146bae29370ef8e2bda445d5ccac38e6c626bdcbc82',
 partial204_body_bytes:2065358,partial204_body_sha256:'6ba739f0385b54de793798e1f3af41a8983e0c2bedbe95d54e36642ea7cdc5b4',
 manual169_body_bytes:741,manual169_body_sha256:'3f9350c6420b07f033f9adc35eed9bab1c9ea5d493fdebb5664cd71725bdd949',
 original189_body_bytes:67329,original189_body_sha256:'161443a20b774a89b72cb2153809b87bb1b7ecbcbbc114bc23543e2b3f02d39f',
 current204_body_bytes:67979,current204_body_sha256:'88144ddbcac918c40b0c2ea8ad5997461388b484a5a740ae220c370477ee38a7',
});
function positions(source,needle){let offset=0;const executable=[];for(const p of spans(source)){if(p.executable)executable.push([offset,offset+p.text.length]);offset+=p.text.length;}
 const result=[];for(let at=source.indexOf(needle);at>=0;at=source.indexOf(needle,at+needle.length))if(executable.some(([a,b])=>a<=at&&at<b))result.push(at);return result;}
function one(source,needle){const p=positions(source,needle);assert.equal(p.length,1,'one actual executable source site');return p[0];}
function routine(source,name,args){
 const marker='FUNCTION public.'+name+'('+args+')',starts=[];
 for(const m of source.matchAll(/^CREATE(?: OR REPLACE)? FUNCTION public\.[a-z_0-9]+\([^\n]*\)/gm))if(m[0].endsWith(marker))starts.push(m.index);
 assert.equal(starts.length,1,'one literal authored routine declaration');
 const at=starts[0],open=source.indexOf('AS $function$',at);assert(open>at&&open-at<500,'closed deparser function header');
 const start=open+'AS $function$'.length,end=source.indexOf('$function$;',start);assert(end>start);
 const header=source.slice(at,start),body=source.slice(start,end);assert(Buffer.byteLength(body)<=8388608,'selected routine bound');return{header,body};
}
function value(header,source){return{owner:'postgres',language:'plpgsql',kind:'f',cost:100,rows:0,security_definer:true,leakproof:false,strict:false,returns_set:false,volatility:'v',parallel:'u',support:null,variadic:null,argument_names:null,argument_modes:null,arguments:'',result:'boolean',defaults:null,source,binary:null,config:['search_path=pg_catalog, public','TimeZone=UTC'],definition:header+source+'$function$\n',acl_null:false,acl:[{grantor:'postgres',grantee:'postgres',privilege:'EXECUTE',grantable:false}]};}
/** Source204's strict partial projector selects its literal189 body. Its
 * manual169 projector excludes this name from both special branches, so the
 * source-parent definition is the complete current204 definition instead. */
export function deriveOrderSplit210FinancialPredecessors(options){
 assert(options&&Object.getPrototypeOf(options)===Object.prototype);const ds=Object.getOwnPropertyDescriptors(options);assert.deepEqual(Reflect.ownKeys(ds),['source204']);assert(Object.hasOwn(ds.source204,'value')&&ds.source204.enumerable,'source data property');
 const source=ds.source204.value,pin=ORDER_SPLIT210_FINANCIAL_PREDECESSOR_SOURCE;
 assert.equal(typeof source,'string');assert.equal(Buffer.byteLength(source),pin.source204_bytes);assert.equal(sha(source),pin.source204_sha256,'entire literal204 source');
 const current=routine(source,'financial_return_upgrade_valid','');
 const header="CREATE OR REPLACE FUNCTION public.financial_return_upgrade_valid()\n RETURNS boolean\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO 'pg_catalog', 'public'\n SET \"TimeZone\" TO 'UTC'\nAS $function$";
 assert.equal(current.header,header);assert.equal(Buffer.byteLength(current.body),pin.current204_body_bytes);assert.equal(sha(current.body),pin.current204_body_sha256);
 const currentValue=value(header,current.body);assert.equal(Object.keys(currentValue).length,24);assert.equal(digest(currentValue),ORDER_SPLIT210_FINANCIAL_SOURCE.full24_value_sha256,'complete source204 financial descriptor');
 const partial=routine(source,'partial_sale204_predecessor_definition','fn oid');assert.equal(Buffer.byteLength(partial.body),pin.partial204_body_bytes);assert.equal(sha(partial.body),pin.partial204_body_sha256);
 const marker=" WHEN 'public.financial_return_upgrade_valid()'::regprocedure THEN",at=one(partial.body,marker);
 const originalMarker=' original:=$old204$',originalAt=partial.body.indexOf(originalMarker,at),end=partial.body.indexOf('$old204$;',originalAt+originalMarker.length);assert(originalAt>at&&end>originalAt);
 const head=partial.body.slice(at+marker.length,originalAt),expectedSource=" IF p.prosrc IS NULL OR octet_length(p.prosrc) IS DISTINCT FROM 67979 OR encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') IS DISTINCT FROM '88144ddbcac918c40b0c2ea8ad5997461388b484a5a740ae220c370477ee38a7' THEN RAISE EXCEPTION '204 changed body drift' USING ERRCODE='55000';END IF;";
 assert(head.startsWith('\n'+expectedSource+'\n expected:='));
 const match=/\n expected:='([^']+)'::jsonb;\n$/.exec(head);assert(match,'entire scoped header/ACL literal');const expected=JSON.parse(match[1]),{source:unusedSource,definition:unusedDefinition,...headers}=currentValue;assert.deepEqual(expected,headers,'all current fields except source/definition remain checked');
 const original=partial.body.slice(originalAt+originalMarker.length,end);assert.equal(Buffer.byteLength(original),pin.original189_body_bytes);assert.equal(sha(original),pin.original189_body_sha256);
 one(partial.body,' RETURN replace(pg_get_functiondef(fn),p.prosrc,original);');
 const manual=routine(source,'manual_inventory_off_projected_definition','fn oid');assert.equal(Buffer.byteLength(manual.body),pin.manual169_body_bytes);assert.equal(sha(manual.body),pin.manual169_body_sha256);
 const delegates=[...manual.body.matchAll(/'public\.([a-z_0-9]+)\([^']*\)'::regprocedure/g)].map(m=>m[1]);assert.deepEqual(delegates,['local_invoice_frame','local_invoice_fingerprint','fa3_draft_fingerprint','b2b_invoice_fingerprint']);
 assert(manual.body.includes("p.proname IN('catalog_stock_control_effect_prepare','catalog_stock_control_effect_validate','catalog_stock_control_guards','b2b_credit_fingerprint')"));assert(!manual.body.includes('financial_return_upgrade_valid'));one(manual.body,' ELSE pg_get_functiondef(p.oid) END FROM pg_proc p WHERE p.oid=fn');
 const before204=value(header,original);
 assert.notEqual(before204.definition,currentValue.definition);assert.deepEqual(Object.fromEntries(Object.entries(before204).filter(([k])=>!['source','definition'].includes(k))),headers);
 return freeze({schema:'order-split210-financial-predecessor-families/v1',families:{partial204:{[key]:before204.definition},manual169:{[key]:currentValue.definition}},before204,current_before:currentValue,
  source_proofs:pin,paths:{partial204:'source204 strict financial CASE: whole67979 body/header/ACL -> literal source189 body67329',manual169:'source204 four-delegate and four-name branches exclude financial -> current source204 identity'},
  source_compilation_performed:false,native_certification:false,application_activation:false});
}
