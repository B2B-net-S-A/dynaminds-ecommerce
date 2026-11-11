/** Four literal-source Native210 deltas only. No SQL execution/activation.
 * No import of the large E204/E205 constants or full catalogue is required. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {deriveOrderSplit210WmsSuccessor} from './order-split210-wms-successor.mjs';

const sha=s=>createHash('sha256').update(s).digest('hex');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'
 ?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const digest=v=>sha(JSON.stringify(canonical(v)));
const freeze=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;};
export const ORDER_SPLIT210_OBSERVER_SOURCES=freeze({
 source160_sha256:'9e10964380e481990c7522c19a89f62cd45cafd7c4a28864b302e337fb0c5926',
 source169_sha256:'4cbf0d955d5bef53b8385836779d6ec50fb5d12520d5c0def95eee8b0da054ce',
 source204_sha256:'410fe04993d1e5c714319146bae29370ef8e2bda445d5ccac38e6c626bdcbc82',
 // First two full headers/definitions independently equal E204.changes.AFTER.
 e204_decoded_json_sha256:'65004e2ccd59799b0bc55db9a3c4debdfec1ffe564856a9c06fd9b05600be771',
 before_records:{
  'public.fa3_draft_fingerprint()':'277834d629070c855204dce2747a6057d79bb105d09982816a153247dc7f4644',
  'public.b2b_invoice_fingerprint()':'d6ee3ec5a57f420bdd9fd8d7124ea9d583b0fba0a961c04af4a86e0604bf7dbc',
  // Derived from169 CREATE OR REPLACE and160's private function ACL, not DB.
  'public.b2b_credit_fingerprint()':'21d9498657ffe7d2ecefa261e28c573dd33b9acfb17f9b710dc44f1b4267966b',
 },
});
const observers=[
 {name:'fa3_draft_fingerprint',unit:'source204',tag:'$function$',family:'partial204'},
 {name:'b2b_invoice_fingerprint',unit:'source204',tag:'$function$',family:'partial204'},
 {name:'b2b_credit_fingerprint',unit:'source169',tag:'$$',family:'manual169'},
];
const sourceCap=16*1024*1024;
function pinned(value,expected,label){assert.equal(typeof value,'string',label);assert(Buffer.byteLength(value)<=sourceCap,label+' finite source cap');assert.equal(sha(value),expected,label+' literal source pin');}
function definition(name,source){return 'CREATE OR REPLACE FUNCTION public.'+name+'()\n RETURNS text\n LANGUAGE sql\n SECURITY DEFINER\n SET search_path TO \'pg_catalog\', \'public\'\nAS $function$'+source+'$function$\n';}
function extract(source,{name,tag,unit}){
 const marker='CREATE OR REPLACE FUNCTION public.'+name+'()';
 const positions=[...source.matchAll(new RegExp('^'+marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'gm'))];
 assert.equal(positions.length,1,'one authored declaration '+name);
 const start=positions[0].index,open=source.indexOf(tag,start),close=source.indexOf(tag,open+tag.length);
 assert(open>start&&close>open,'literal source function dollar bounds');
 const header=source.slice(start,open);
 assert.equal(header,unit==='source204'
  ?definition(name,'').split('$function$')[0]
  :marker+' RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS ',
 'entire literal SQL header, no implicit privilege/header change');
 assert.equal(source.slice(close+tag.length,close+tag.length+1),';','complete source function terminator');
 return source.slice(open+tag.length,close);
}
function beforeRecord(spec,source){
 const body=extract(source,spec);
 // Defaults follow the exact SQL declaration; explicit160 REVOKE fixes the ACL.
 const value={owner:'postgres',language:'sql',kind:'f',cost:100,rows:0,security_definer:true,
  leakproof:false,strict:false,returns_set:false,volatility:'v',parallel:'u',support:null,variadic:null,
  argument_names:null,argument_modes:null,arguments:'',result:'text',defaults:null,source:body,binary:null,
  config:['search_path=pg_catalog, public'],definition:definition(spec.name,body),acl_null:false,
  acl:[{grantor:'postgres',grantee:'postgres',privilege:'EXECUTE',grantable:false}]};
 const record={kind:'function',key:'public.'+spec.name+'()',value};
 assert.equal(digest(record),ORDER_SPLIT210_OBSERVER_SOURCES.before_records[record.key],'complete source-derived predecessor pin');
 return record;
}

/** SQL body lexical spans. Literals/comments are preserved, never searched for
 * observer sites. This is a bounded transformer, not a PostgreSQL parser. */
export function orderSplit210ObserverSpans(source){
 assert.equal(typeof source,'string');assert(Buffer.byteLength(source)<=8388608);
 const out=[];let i=0,start=0;
 const emit=(end,executable)=>{if(end>start)out.push({executable,text:source.slice(start,end)});start=end;};
 while(i<source.length){let end;
  if(source.startsWith('--',i)){end=source.indexOf('\n',i+2);if(end<0)end=source.length;}
  else if(source.startsWith('/*',i)){let depth=1;end=i+2;while(depth&&end<source.length){if(source.startsWith('/*',end)){depth++;end+=2;}else if(source.startsWith('*/',end)){depth--;end+=2;}else end++;}assert.equal(depth,0,'closed SQL comment');}
  else if(source[i]==="'"||source[i]==='"'){
   const q=source[i],escaped=q==="'"&&/[Ee]/.test(source[i-1]??'')&&!/[A-Za-z_0-9]/.test(source[i-2]??'');end=i+1;let closed=false;
   while(end<source.length){if(escaped&&source[end]==='\\'){end+=2;continue;}if(source[end]===q){if(source[end+1]===q){end+=2;continue;}end++;closed=true;break;}end++;}assert(closed,'closed SQL quoted token');
  }else{const d=/^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.exec(source.slice(i));if(d){const close=source.indexOf(d[0],i+d[0].length);assert(close>=0,'closed SQL dollar literal');end=close+d[0].length;}}
  if(end!==undefined){emit(i,true);emit(end,false);i=end;}else i++;
 }
 emit(source.length,true);assert.equal(out.map(s=>s.text).join(''),source);return out;
}
/** Pure partial derivation. Its four private210 ports MUST be implemented and
 * source-authenticated before SQL assembly. No arbitrary predicate/SQL callback. */
export function projectOrderSplit210ObserverSource(source,family){
 assert(['partial204','manual169'].includes(family),'fixed predecessor family required');
 const old=family==='partial204'?'public.partial_sale204_predecessor_definition':'public.manual_inventory_off_projected_definition';
 const count={trigger_filters:0,function_filters:0,predecessor_definitions:0};
 let result=orderSplit210ObserverSpans(source).map(s=>{
  if(!s.executable)return s.text;
  return s.text.replace(/\bAND NOT tr\.tgisinternal\b/g,v=>{count.trigger_filters++;return v+' AND NOT public.order_split210_is_added_trigger(tr.oid)';})
   .replace(/\bFROM pg_proc p WHERE p\.pronamespace=/g,v=>{count.function_filters++;return 'FROM pg_proc p WHERE NOT public.order_split210_is_added_trigger_function(p.oid) AND p.pronamespace=';})
   .replace(family==='partial204'?/\bpublic\.partial_sale204_predecessor_definition\(p\.oid\)/g:/\b(?:public\.)?manual_inventory_off_projected_definition\(p\.oid\)/g,
    ()=>{count.predecessor_definitions++;return "public.order_split210_predecessor_definition(p.oid,'"+family+"')";});
 }).join('');
 assert.deepEqual(count,{trigger_filters:2,function_filters:1,predecessor_definitions:1},'closed observer query site roster');
 // SQL-language functions may contain multiple statements; last SELECT remains
 // the actual fingerprint. require() must RAISE on drift, never return a flag.
 result='\n SELECT public.order_split210_require();'+result;
 return {source:result,sites:count,legacy_definition_function:old};
}

export function deriveOrderSplit210Predecessor({source104,source108,source160,source169,source204}){
 pinned(source160,ORDER_SPLIT210_OBSERVER_SOURCES.source160_sha256,'Source160');
 pinned(source169,ORDER_SPLIT210_OBSERVER_SOURCES.source169_sha256,'Source169');
 pinned(source204,ORDER_SPLIT210_OBSERVER_SOURCES.source204_sha256,'Source204');
 assert(source160.includes("EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,dyna_app',fn.sig)"),'source160 private function seal');
 const grant=source160.match(/^GRANT EXECUTE ON FUNCTION ([^;]+) TO dyna_app;/gm);
 assert(grant&&grant.every(g=>!g.includes('b2b_credit_fingerprint(')),'no app fingerprint grant');
 const wms=deriveOrderSplit210WmsSuccessor({source104,source108}),changes=[],sites=[];
 for(const spec of observers){
  const r=beforeRecord(spec,spec.unit==='source204'?source204:source169),projected=projectOrderSplit210ObserverSource(r.value.source,spec.family);
  assert.equal(r.value.definition.split(r.value.source).length,2,'one complete body in definition');
  const after={...r.value,source:projected.source,definition:r.value.definition.replace(r.value.source,()=>projected.source)};
  changes.push({kind:r.kind,key:r.key,before:r.value,after});sites.push({key:r.key,...projected.sites,legacy_definition_function:projected.legacy_definition_function});
 }
 changes.push(...wms.changes);
 return freeze({schema:'order-split210-four-predecessor-deltas/v1',source_inputs:{...ORDER_SPLIT210_OBSERVER_SOURCES,...wms.source_inputs},
  changes,projection_sites:sites,full_changed_keys:changes.map(c=>c.key),
  required_private_ports:[
   {key:'public.order_split210_require()',contract:'RAISE on missing/extra/drift/partial namespace or changed literal parent certificates; no boolean admission'},
   {key:'public.order_split210_is_added_trigger(fn oid)',contract:'true only for exact authored full current trigger records; no prefix exclusion; require fresh closed210'},
   {key:'public.order_split210_is_added_trigger_function(fn oid)',contract:'true only for exact full current added bound-guard routine; no prefix exclusion; require fresh closed210'},
   {key:'public.order_split210_predecessor_definition(fn oid, family text)',contract:'fixed partial204/manual169 composition: authenticate complete current AFTER, then preserve the selected old projector result; raw parent209 definition alone is insufficient'},
  ],
  remaining_old_function_keys:[
   ...['predecessor_descriptor','predecessor_definition','predecessor_source','predecessor_metadata'].flatMap(n=>
    n==='predecessor_metadata'?['public.order_merge_delivery209_'+n+'(value jsonb)','public.order_merge_delivery209_'+n+'(value jsonb, entries jsonb)']
     :['public.order_merge_delivery209_'+n+'(fn oid)','public.order_merge_delivery209_'+n+'(fn oid, entries jsonb)']),
   'public.order_merge_delivery209_fingerprint()',
  ],
  complete_thirteen_change_closure:false,source_compilation_performed:false,native_certification:false,application_activation:false});
}
