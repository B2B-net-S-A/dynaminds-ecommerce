/** Source-only ordinary181 financial successor. Literal Source204 + authored210
 * inputs only: no catalogue adoption, SQL execution, seal or admission. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {orderMergeDelivery209HistorySqlSpans as spans} from './order-merge-delivery209-history-closure.mjs';
import {deriveOrderSplit210TriggerRoster,ORDER_SPLIT210_TRIGGER_SOURCE_SHA256} from './order-split210-external-triggers.mjs';

const sha=s=>createHash('sha256').update(s).digest('hex');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const digest=v=>sha(JSON.stringify(canonical(v)));
const freeze=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;};
const key='public.ordinary181_financial_valid(manual_basis jsonb)';
const header='CREATE OR REPLACE FUNCTION '+key+'\n RETURNS boolean\n LANGUAGE plpgsql\n STABLE SECURITY DEFINER\n SET search_path TO \'pg_catalog\', \'public\'\n SET "TimeZone" TO \'UTC\'\nAS $function$';
const families=freeze([
 {family:'158',key:'public.fa3_draft_fingerprint()',sha256:'98e864adebce59dc7da7f1e46cecddcf5028bc1de05db5dea1e0d0800ca56a30'},
 {family:'159',key:'public.b2b_invoice_fingerprint()',sha256:'b3dff2ee8934549828eb4c029298375802022e618d42027b57f3dea3ea4f57d3'},
]);
const boundKeys=Object.freeze(['order_items','order_pick_items','orders','reservation_locations','reservations','stock','stock_location_movements','stock_locations','stock_movements','wms_layer_movements','wms_layer_positions','wms_reservation_layers'].map(t=>'public.'+t+'.order_split210_bound'));
export const ORDER_SPLIT210_ORDINARY_FINANCIAL_SOURCE=freeze({key,
 source204_bytes:13279659,source204_sha256:'410fe04993d1e5c714319146bae29370ef8e2bda445d5ccac38e6c626bdcbc82',
 source210_sha256:ORDER_SPLIT210_TRIGGER_SOURCE_SHA256,
 metadata_signatures:['public.ordinary181_financial_valid(jsonb)','ordinary181_financial_valid(jsonb)'],
 before_source_bytes:57589,before_source_sha256:'984dd5ab7e4a0312c55c32db348f05f272330f38eec5bf71df41d24eb04917c6',
 partial204_body_bytes:2065358,partial204_body_sha256:'6ba739f0385b54de793798e1f3af41a8983e0c2bedbe95d54e36642ea7cdc5b4',
 manual169_body_bytes:741,manual169_body_sha256:'3f9350c6420b07f033f9adc35eed9bab1c9ea5d493fdebb5664cd71725bdd949',
 original189_body_bytes:57433,original189_body_sha256:'fd006bb71a55d60fcc83feb0fa2e86f4d68064660c3f48e4b44b1d6d7e4f7bc4',
 before_definition_sha256:'b3b3237ef40a2d2f89cbb160aad4b27a4691392e8ba96dd253b59a1d82d7cffc',
 before_full24_value_sha256:'85a2ac0dc5c7a46ae2db18505b4961bfc163a122dd91240490d3542967942477',
 before_full24_record_sha256:'7c597f876c6239cca6a46f2c8a18d4956834ee1b38d015d091e8de19cfac372e',
});
function positions(source,needle,{start=0,end=source.length}={}){
 let offset=0;const executable=[];for(const s of spans(source)){if(s.executable)executable.push([offset,offset+s.text.length]);offset+=s.text.length;}
 const result=[];for(let at=source.indexOf(needle,start);at>=0&&at+needle.length<=end;at=source.indexOf(needle,at+needle.length))if(executable.some(([a,b])=>a<=at&&at<b))result.push(at);return result;
}
function routine(program,name,args){
 const pattern='^CREATE(?: OR REPLACE)? FUNCTION public\\.'+name+'\\('+args+'\\)\\n',matches=[...program.matchAll(new RegExp(pattern,'gm'))];assert.equal(matches.length,1,'one literal routine declaration');
 const at=matches[0].index,open=program.indexOf('AS $function$',at)+'AS $function$'.length;assert(open>at&&open-at<500,'closed declared header');const end=program.indexOf('$function$;',open);assert(end>open);const body=program.slice(open,end);assert(Buffer.byteLength(body)<=8388608,'selected source bound');return{header:program.slice(at,open),body};
}
function sourceBefore(program){
 const pin=ORDER_SPLIT210_ORDINARY_FINANCIAL_SOURCE;assert.equal(typeof program,'string');assert.equal(Buffer.byteLength(program),pin.source204_bytes);assert.equal(sha(program),pin.source204_sha256,'entire literal Source204 required');
 const current=routine(program,'ordinary181_financial_valid','manual_basis jsonb'),source=current.body;assert.equal(current.header,header,'entire declared header');assert.equal(Buffer.byteLength(source),pin.before_source_bytes);assert.equal(sha(source),pin.before_source_sha256);
 const value={owner:'postgres',language:'plpgsql',kind:'f',cost:100,rows:0,security_definer:true,leakproof:false,strict:false,returns_set:false,volatility:'s',parallel:'u',support:null,variadic:null,argument_names:['manual_basis'],argument_modes:null,arguments:'manual_basis jsonb',result:'boolean',defaults:null,source,binary:null,config:['search_path=pg_catalog, public','TimeZone=UTC'],definition:header+source+'$function$\n',acl_null:false,acl:[{grantor:'postgres',grantee:'postgres',privilege:'EXECUTE',grantable:false}]};
 assert.equal(Object.keys(value).length,24);assert.equal(sha(value.definition),pin.before_definition_sha256);assert.equal(digest(value),pin.before_full24_value_sha256);assert.equal(digest({kind:'function',key,value}),pin.before_full24_record_sha256,'source-authored full24 record');return value;
}
function predecessorFamilies(program,before){
 const pin=ORDER_SPLIT210_ORDINARY_FINANCIAL_SOURCE,partial=routine(program,'partial_sale204_predecessor_definition','fn oid');assert.equal(Buffer.byteLength(partial.body),pin.partial204_body_bytes);assert.equal(sha(partial.body),pin.partial204_body_sha256);
 const marker=" WHEN 'public.ordinary181_financial_valid(jsonb)'::regprocedure THEN",sites=positions(partial.body,marker);assert.equal(sites.length,1,'one executable strict Source204 case');const at=sites[0],literal=' original:=$old204$',open=partial.body.indexOf(literal,at),end=partial.body.indexOf('$old204$;',open+literal.length);assert(open>at&&end>open,'complete fixed historical source literal');
 const guard=" IF p.prosrc IS NULL OR octet_length(p.prosrc) IS DISTINCT FROM 57589 OR encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') IS DISTINCT FROM '984dd5ab7e4a0312c55c32db348f05f272330f38eec5bf71df41d24eb04917c6' THEN RAISE EXCEPTION '204 changed body drift' USING ERRCODE='55000';END IF;",head=partial.body.slice(at+marker.length,open);assert(head.startsWith('\n'+guard+'\n expected:='),'exact complete current-source refusal');const expected=/\n expected:='([^']+)'::jsonb;\n$/.exec(head);assert(expected,'one complete literal descriptor header');const omit=v=>Object.fromEntries(Object.entries(v).filter(([k])=>!['source','definition'].includes(k)));assert.deepEqual(JSON.parse(expected[1]),omit(before),'all current header/ACL fields independently bound');
 const source=partial.body.slice(open+literal.length,end);assert.equal(Buffer.byteLength(source),pin.original189_body_bytes);assert.equal(sha(source),pin.original189_body_sha256,'literal204 original source, not assumed181');assert.equal(positions(partial.body,' RETURN replace(pg_get_functiondef(fn),p.prosrc,original);').length,1);
 const before204={...before,source,definition:header+source+'$function$\n'};assert.equal(digest(before204),'8dcc5f0d6bddd5de66eeb947eaeb8f6e88e49c085fc1e52a2cd849e815fd5653','complete authored Source189 ancestor');
 const manual=routine(program,'manual_inventory_off_projected_definition','fn oid');assert.equal(Buffer.byteLength(manual.body),pin.manual169_body_bytes);assert.equal(sha(manual.body),pin.manual169_body_sha256);const delegates=[...manual.body.matchAll(/'public\.([a-z_0-9]+)\([^']*\)'::regprocedure/g)].map(m=>m[1]);assert.deepEqual(delegates,['local_invoice_frame','local_invoice_fingerprint','fa3_draft_fingerprint','b2b_invoice_fingerprint']);assert(manual.body.includes("p.proname IN('catalog_stock_control_effect_prepare','catalog_stock_control_effect_validate','catalog_stock_control_guards','b2b_credit_fingerprint')"));assert(!manual.body.includes('ordinary181_financial_valid'));assert.equal(positions(manual.body,' ELSE pg_get_functiondef(p.oid) END FROM pg_proc p WHERE p.oid=fn').length,1);
 return{before204,families:{partial204:{[key]:before204.definition},manual169:{[key]:before.definition}},family_source_proofs:{partial204_original_source_sha256:sha(source),partial204_original_full24_sha256:digest(before204),manual169_identity_source_sha256:sha(before.source),manual169_four_delegates:delegates,manual169_other_name_count:4}};
}
function targets(statement,boundTables){
 const tableStart="FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND (",tableEnd=") AND c.relkind IN('r','p')),\n 'functions',";
 const at=statement.indexOf(tableStart),end=statement.indexOf(tableEnd,at);assert(at>=0&&end>at&&statement.indexOf(tableStart,at+1)<0,'one complete family table predicate');
 const predicate=statement.slice(at+tableStart.length,end),lists=[...predicate.matchAll(/c\.relname IN\(([^)]+)\)/g)],prefixes=[...predicate.matchAll(/c\.relname LIKE '([^']+)' ESCAPE '\\'/g)];
 assert.equal(lists.length,1);const literals=s=>{assert(/^'[a-z_0-9]+'(?:,'[a-z_0-9]+')*$/.test(s),'literal table list');return[...s.matchAll(/'([^']+)'/g)].map(m=>m[1]);};
 const explicit=literals(lists[0][1]);let residual=predicate.replace(lists[0][0],'');for(const p of prefixes){assert(/^[a-z][a-z0-9]*(?:\\_[a-z0-9]+)+\\_%$/.test(p[1]),'literal table-prefix grammar');residual=residual.replace(p[0],'');}assert.equal(residual.replace(/\s|OR/g,''),'','whole table predicate accounted for');
 const tableTargets=boundTables.filter(t=>explicit.includes(t)||prefixes.some(p=>t.startsWith(p[1].slice(0,-1).replaceAll('\\_','_'))));
 const memberships=[...statement.matchAll(/SELECT tr\.tgfoid FROM pg_trigger tr JOIN pg_class rel ON rel\.oid=tr\.tgrelid WHERE rel\.relnamespace='public'::regnamespace AND NOT tr\.tgisinternal AND rel\.relname IN\(([^)]+)\)/g)];assert.equal(memberships.length,1,'one full trigger function membership');
 const functionTargets=boundTables.filter(t=>literals(memberships[0][1]).includes(t));assert.deepEqual(tableTargets,['order_items','orders'],'source-derived table intersection');assert.deepEqual(functionTargets,['order_items','orders'],'source-derived function intersection');return{table_targets:tableTargets,function_targets:functionTargets,targets:[...tableTargets]};
}
/** Only existing literal assembly inputs are accepted. Families are extracted
 * from Source204's exact strict CASE and manual169's four+four exclusions. */
export function deriveOrderSplit210OrdinaryFinancialSuccessor(options){
 assert(options&&Object.getPrototypeOf(options)===Object.prototype,'plain source inputs required');const ds=Object.getOwnPropertyDescriptors(options);assert.deepEqual(Reflect.ownKeys(ds).sort(),['source204','source210'],'closed source204/source210 inputs');for(const k of ['source204','source210'])assert(Object.hasOwn(ds[k],'value')&&ds[k].enumerable,'source data properties required');
 const before=sourceBefore(ds.source204.value),familyProof=predecessorFamilies(ds.source204.value,before),source=before.source,roster=deriveOrderSplit210TriggerRoster({source210:ds.source210.value});
 assert.deepEqual(roster.groups.external_bound,boundKeys);assert.equal(roster.counts.external_deferred,0);const boundTables=boundKeys.map(k=>k.split('.')[1]);
 assert(!source.includes('split210_bound_candidates')&&!source.includes('split210_bound_verified'),'fresh local CTE names');
 const edits=[],groups=[];const add=(needle,replacement,kind,range)=>{const found=positions(source,needle,range);assert.equal(found.length,1,'one executable '+kind);edits.push({kind,beforeStart:found[0],before:needle,after:replacement});};
 const cte=`WITH split210_bound_candidates AS MATERIALIZED(
   SELECT t.oid FROM pg_catalog.pg_trigger t
   JOIN pg_catalog.pg_class rel ON rel.oid=t.tgrelid
   JOIN pg_catalog.pg_namespace n ON n.oid=rel.relnamespace
   JOIN(VALUES ('order_items','order_split210_bound'),('orders','order_split210_bound')) declared(table_name,trigger_name)
    ON declared.table_name=rel.relname AND declared.trigger_name=t.tgname
   WHERE n.nspname='public'
  ),split210_bound_verified AS MATERIALIZED(
   SELECT oid FROM split210_bound_candidates WHERE public.order_split210_is_added_trigger(oid)
  )
  SELECT jsonb_build_object(`;
 const table='FROM pg_trigger tr WHERE tr.tgrelid=c.oid AND NOT tr.tgisinternal',membership="FROM pg_trigger tr JOIN pg_class rel ON rel.oid=tr.tgrelid WHERE rel.relnamespace='public'::regnamespace AND NOT tr.tgisinternal",exclude=' AND NOT EXISTS(SELECT FROM split210_bound_verified verified WHERE verified.oid=tr.oid)';
 for(const family of families){
  const hash="encode(sha256(convert_to((SELECT prosrc FROM pg_proc WHERE oid='"+family.key+"'::regprocedure),'UTF8')),'hex')",guard=' IF '+hash+" IS DISTINCT FROM '"+family.sha256+"' THEN RETURN false;END IF;";
  const guardAt=positions(source,guard);assert.equal(guardAt.length,1,'exact financial hash refusal');const select=guardAt[0]+guard.length+'\n '.length;assert.equal(source.slice(select,select+26),'SELECT jsonb_build_object(');
  const end=source.indexOf(') INTO financial214;',select);assert(end>select);const range={start:select,end:end+') INTO financial214;'.length},statement=source.slice(range.start,range.end);
  groups.push({family:family.family,...targets(statement,boundTables)});
  add(hash,"public.order_merge_delivery209_predecessor_source_sha('"+family.key+"'::regprocedure,NULL::jsonb)",'raw_financial_source_hash',{start:guardAt[0],end:select});
  add('SELECT jsonb_build_object(',cte,'statement_local_bound_classification',range);
  add(table,table+exclude,'financial_table_trigger_selector',range);add(membership,membership+exclude,'financial_trigger_function_membership',range);
 }
 edits.sort((a,b)=>a.beforeStart-b.beforeStart);assert.equal(edits.length,8);let cursor=0,afterSource='';for(const e of edits){assert(e.beforeStart>=cursor,'disjoint executable edits');afterSource+=source.slice(cursor,e.beforeStart);e.afterStart=afterSource.length;afterSource+=e.after;cursor=e.beforeStart+e.before.length;}afterSource+=source.slice(cursor);
 let inverse=afterSource;for(const e of [...edits].reverse()){assert.equal(inverse.slice(e.afterStart,e.afterStart+e.after.length),e.after);inverse=inverse.slice(0,e.afterStart)+e.before+inverse.slice(e.afterStart+e.after.length);}assert.equal(inverse,source,'entire literal Source204 function inverse');
 const last=edits.at(-1);assert.equal(afterSource.slice(last.afterStart+last.after.length),source.slice(last.beforeStart+last.before.length),'all later financial/header/source/NULL checks stay literal');
 const after={...before,source:afterSource,definition:header+afterSource+'$function$\n'},omit=v=>Object.fromEntries(Object.entries(v).filter(([k])=>!['source','definition'].includes(k)));assert.deepEqual(omit(after),omit(before));
 return freeze({schema:'order-split210-ordinary-financial-successor-candidate/v1',change:{kind:'function',key,before,after},families:familyProof.families,before204:familyProof.before204,family_source_proofs:familyProof.family_source_proofs,sql:after.definition+';\n',edits,source_proofs:ORDER_SPLIT210_ORDINARY_FINANCIAL_SOURCE,
  projection_counts:{raw_financial_source_hash:2,statement_local_bound_classification:2,financial_table_trigger_selector:2,financial_trigger_function_membership:2},statement_local_bound_targets:groups,
  strict_bound_classifications:{per_statement:[2,2],two_statement_total:4,maximum_per_statement:2,cross_statement_cache:false},
  source_bytes_before:Buffer.byteLength(source),source_bytes_after:Buffer.byteLength(afterSource),source_after_sha256:sha(afterSource),whole_source_inverse_verified:true,
  target_metadata_adopted:false,assembled:false,source_compilation_performed:false,native_certification:false,application_activation:false});
}
