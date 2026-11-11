/** Build-time sixteenth Source210 successor only. No filesystem/DB/runtime
 * source compiler, observed expectation, seal or admission. Full24 BEFORE is
 * constructed from pinned executable204 and independently checked E204.after. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {orderMergeDelivery209HistorySqlSpans as spans} from './order-merge-delivery209-history-closure.mjs';
import {deriveOrderSplit210TriggerRoster,ORDER_SPLIT210_TRIGGER_SOURCE_SHA256} from './order-split210-external-triggers.mjs';
const sha=s=>createHash('sha256').update(s).digest('hex');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const digest=v=>sha(JSON.stringify(canonical(v)));
const freeze=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;};
export const ORDER_SPLIT210_FINANCIAL_SOURCE=freeze({
 key:'public.financial_return_upgrade_valid()',source204_sha256:'410fe04993d1e5c714319146bae29370ef8e2bda445d5ccac38e6c626bdcbc82',source204_bytes:13279659,
 source204_header_line:9465,body_bytes:67979,body_sha256:'88144ddbcac918c40b0c2ea8ad5997461388b484a5a740ae220c370477ee38a7',
 full24_value_sha256:'7f3cfbe609e30b603c93f220273c54a2f1f9637b81fcea4540cef2372e51c199',full_record_sha256:'ce9a2cbb81aaaf6c4a6fd3d5dca9666bb98124af99182292a6352c7de775f522',
 source204_contract_decoded_sha256:'65004e2ccd59799b0bc55db9a3c4debdfec1ffe564856a9c06fd9b05600be771',trigger_source_sha256:ORDER_SPLIT210_TRIGGER_SOURCE_SHA256,
 runtime_reproduction_performed:false,native_verified:false,
});
const knownHashes=Object.freeze([
 ['158','public.fa3_draft_fingerprint()','98e864adebce59dc7da7f1e46cecddcf5028bc1de05db5dea1e0d0800ca56a30'],
 ['159','public.b2b_invoice_fingerprint()','b3dff2ee8934549828eb4c029298375802022e618d42027b57f3dea3ea4f57d3'],
 ['160','public.b2b_credit_fingerprint()','9e3766d47014f65190e470b4aa4ac70d54bc96ce094493408480a41026564a0b'],
]);
const boundKeys=Object.freeze(['order_items','order_pick_items','orders','reservation_locations','reservations','stock','stock_location_movements','stock_locations','stock_movements','wms_layer_movements','wms_layer_positions','wms_reservation_layers'].map(table=>'public.'+table+'.order_split210_bound'));
const quoted=s=>"'"+s.replaceAll("'","''")+"'";
function executablePositions(source,needle,{start=0,end=source.length}={}){
 const executable=[];let pos=0;for(const s of spans(source)){if(s.executable)executable.push([pos,pos+s.text.length]);pos+=s.text.length;}
 const out=[];for(let at=source.indexOf(needle,start);at>=0&&at+needle.length<=end;at=source.indexOf(needle,at+needle.length))if(executable.some(([a,b])=>a<=at&&at<b))out.push(at);return out;
}
function authoredBefore(input){
 assert.equal(typeof input,'string','literal204 source input');assert.equal(Buffer.byteLength(input),ORDER_SPLIT210_FINANCIAL_SOURCE.source204_bytes,'literal204 complete bytes');assert.equal(sha(input),ORDER_SPLIT210_FINANCIAL_SOURCE.source204_sha256,'literal204 full file pin');
 const matches=[...input.matchAll(/^CREATE OR REPLACE FUNCTION public\.financial_return_upgrade_valid\(\)/gm)];assert.equal(matches.length,1,'one true executable declaration, never quoted history');
 const at=matches[0].index,tag='$function$',open=input.indexOf('AS '+tag,at)+'AS '.length;assert(open>at);const close=input.indexOf(tag+';',open+tag.length);assert(close>open);
 const header="CREATE OR REPLACE FUNCTION public.financial_return_upgrade_valid()\n RETURNS boolean\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO 'pg_catalog', 'public'\n SET \"TimeZone\" TO 'UTC'\nAS ";
 assert.equal(input.slice(at,open),header,'entire literal header');assert.equal(input.slice(0,at).split('\n').length,9465);
 const source=input.slice(open+tag.length,close);assert.equal(Buffer.byteLength(source),67979);assert.equal(sha(source),ORDER_SPLIT210_FINANCIAL_SOURCE.body_sha256);
 const value={owner:'postgres',language:'plpgsql',kind:'f',cost:100,rows:0,security_definer:true,leakproof:false,strict:false,returns_set:false,volatility:'v',parallel:'u',support:null,variadic:null,argument_names:null,argument_modes:null,arguments:'',result:'boolean',defaults:null,source,binary:null,config:['search_path=pg_catalog, public','TimeZone=UTC'],definition:header+tag+source+tag+'\n',acl_null:false,acl:[{grantor:'postgres',grantee:'postgres',privilege:'EXECUTE',grantable:false}]};
 assert.equal(Object.keys(value).length,24);assert.equal(digest(value),ORDER_SPLIT210_FINANCIAL_SOURCE.full24_value_sha256,'complete source204/E204 full24');assert.equal(digest({kind:'function',key:ORDER_SPLIT210_FINANCIAL_SOURCE.key,value}),ORDER_SPLIT210_FINANCIAL_SOURCE.full_record_sha256);
 return value;
}
function familyBoundTargets(source,start,end){
 const tables=boundKeys.map(key=>key.split('.')[1]),groups=[];
 const branchMarkers=knownHashes.map(([family])=>{const marker="WHEN '"+family+"' THEN";const positions=executablePositions(source,marker,{start,end});assert.equal(positions.length,1,'one literal financial family branch');return{family,start:positions[0]};});
 for(let i=0;i<branchMarkers.length;i++){
  const branch=source.slice(branchMarkers[i].start,i+1<branchMarkers.length?branchMarkers[i+1].start:end),family=branchMarkers[i].family;
  const marker="FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND (",finish=") AND c.relkind IN('r','p')),\n 'functions',";
  const a=branch.indexOf(marker),b=branch.indexOf(finish,a);assert(a>=0&&b>a&&branch.indexOf(marker,a+1)<0,'one complete source-authored financial table predicate');
  const predicate=branch.slice(a+marker.length,b),lists=[...predicate.matchAll(/c\.relname IN\(([^)]+)\)/g)],prefixes=[...predicate.matchAll(/c\.relname LIKE '([^']+)' ESCAPE '\\'/g)];
  assert.equal(lists.length,1,'one exact financial explicit table list');
  const literals=text=>{assert(/^'[a-z_0-9]+'(?:,'[a-z_0-9]+')*$/.test(text),'literal table names only');return[...text.matchAll(/'([^']+)'/g)].map(m=>m[1]);};
  const explicit=literals(lists[0][1]);let residual=predicate.replace(lists[0][0],'');
  for(const p of prefixes){assert(/^[a-z][a-z0-9]*(?:\\_[a-z0-9]+)+\\_%$/.test(p[1]),'exact literal-prefix LIKE grammar');residual=residual.replace(p[0],'');}
  assert.equal(residual.replace(/\s|OR/g,''),'','all source predicate terms accounted for');
  const tableTargets=tables.filter(table=>explicit.includes(table)||prefixes.some(p=>table.startsWith(p[1].slice(0,-1).replaceAll('\\_','_'))));
  const memberships=[...branch.matchAll(/SELECT tr\.tgfoid FROM pg_trigger tr JOIN pg_class rel ON rel\.oid=tr\.tgrelid WHERE rel\.relnamespace='public'::regnamespace AND NOT tr\.tgisinternal AND rel\.relname IN\(([^)]+)\)/g)];
  assert.equal(memberships.length,1,'one complete trigger-derived function membership');
  const membershipTargets=tables.filter(table=>literals(memberships[0][1]).includes(table));
  const targets=[...new Set([...tableTargets,...membershipTargets])].sort();
  assert.deepEqual(tableTargets.slice().sort(),family==='160'?['order_items','orders','stock_location_movements','stock_movements','wms_layer_movements']:['order_items','orders'],'independent complete table-predicate intersection');
  assert.deepEqual(membershipTargets.slice().sort(),['order_items','orders'],'independent complete function-membership intersection');
  groups.push({family,table_targets:tableTargets.slice().sort(),function_targets:membershipTargets.slice().sort(),targets});
 }
 assert.equal(groups.reduce((n,g)=>n+g.targets.length,0),9,'bounded2/2/5 source classifications across three statements');
 return groups;
}


function auditBooleanSelectors(source,start,end){
 const names=['financial_return_upgrade_valid','buyer_address_guards'],families=[];
 const markers=knownHashes.map(([family])=>({family,at:executablePositions(source,"WHEN '"+family+"' THEN",{start,end})[0]}));
 for(let i=0;i<markers.length;i++){
  const {family,at}=markers[i],branch=source.slice(at,i+1<markers.length?markers[i+1].at:end);
  const queries=executablePositions(branch,"FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND ((");assert.equal(queries.length,1,'one complete financial function selector per family');
  const line=branch.slice(queries[0],branch.indexOf('\n',queries[0]));
  const prefixStart="FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND ((",split=') OR p.oid IN(';
  const splitAt=line.indexOf(split);assert(splitAt>prefixStart.length);const predicate=line.slice(prefixStart.length,splitAt);
  const terms=[...predicate.matchAll(/p\.proname LIKE '([^']+)' ESCAPE '\\'/g)];assert(terms.length>0);let residual=predicate;
  const prefixes=terms.map(term=>{assert(/^[a-z][a-z0-9]*(?:\\_[a-z0-9]+)+\\_%$/.test(term[1]),'literal function prefix only');residual=residual.replace(term[0],'');return term[1].slice(0,-1).replaceAll('\\_','_');});
  assert.equal(residual.replace(/\s|OR/g,''),'','all function-name predicates accounted for');
  const membership=line.slice(splitAt+split.length);
  assert(/^SELECT tr\.tgfoid FROM pg_trigger tr JOIN pg_class rel ON rel\.oid=tr\.tgrelid WHERE rel\.relnamespace='public'::regnamespace AND NOT tr\.tgisinternal AND rel\.relname IN\('[a-z_]+'(?:,'[a-z_]+')*\)\)\)\),$/.test(membership),'only genuine trigger-returning function membership supplements name prefixes');
  const selected=names.filter(name=>prefixes.some(prefix=>name.startsWith(prefix)));assert.deepEqual(selected,[],'neither boolean raw-CASE name is selected in historical158/159/160 families');
  const rawCases=executablePositions(branch,"CASE WHEN p.oid IN('public.financial_return_upgrade_valid()'::regprocedure,'public.buyer_address_guards()'::regprocedure)");
  assert.equal(rawCases.length,family==='160'?0:1,'raw CASE belongs only to158/159;160 retains its existing manual projector');
  families.push({family,function_prefixes:prefixes,raw_case_count:rawCases.length,raw_boolean_names_selected_by_prefix:selected,other_membership:'pg_trigger.tgfoid (returns trigger, not boolean)'});
 }
 const own="FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND starts_with(p.proname,'financial_return_'))";
 assert.equal(executablePositions(source,own).length,1,'one financial162 own-namespace selector');assert(executablePositions(source,own)[0]>end);
 return{families,financial162:{function_prefix:'financial_return_',raw_boolean_names_selected:['financial_return_upgrade_valid'],buyer_selected:false,source_and_definition_side:'current/raw; original162 self-normalization retained'},buyer_projection_required_in_raw_cases:false};
}
export function deriveOrderSplit210FinancialSuccessor(options={}){
 assert(options&&typeof options==='object'&&!Array.isArray(options));assert(Reflect.ownKeys(options).length===2&&Reflect.ownKeys(options).every(k=>['source204','source210'].includes(k)),'closed source-only financial inputs');
 for(const key of ['source204','source210']){const d=Object.getOwnPropertyDescriptor(options,key);assert(d&&Object.hasOwn(d,'value'),'source data properties only');}
 if(Object.hasOwn(options,'source210')){
  const d=Object.getOwnPropertyDescriptor(options,'source210');assert(d&&Object.hasOwn(d,'value'),'source210 data property required');
  const roster=deriveOrderSplit210TriggerRoster({source210:d.value});assert.equal(roster.counts.external_bound,12);assert.equal(roster.counts.external_deferred,0);assert.deepEqual(roster.groups.external_bound,boundKeys,'complete authored external bound identities');
 }
 const before=authoredBefore(options.source204),source=before.source,edits=[];
 const add=(needle,replacement,count,kind,range)=>{const matches=executablePositions(source,needle,range);assert.equal(matches.length,count,'exact executable '+kind+' sites');for(const beforeStart of matches)edits.push({kind,beforeStart,before:needle,after:replacement});};
 const rawHash="WHERE p.oid IS NULL OR encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') IS DISTINCT FROM expected.body_sha) THEN RETURN false;END IF;";
 const projectedHash="WHERE p.oid IS NULL OR encode(sha256(convert_to(public.order_split210_try_function_projection(p.oid)->>'source','UTF8')),'hex') IS DISTINCT FROM expected.body_sha) THEN RETURN false;END IF;";
 for(const [family,key,hash]of knownHashes)assert(source.includes("('"+family+"','"+key+"','"+hash+"')"),'literal three family identities and expected hashes unchanged');
 add(rawHash,projectedHash,1,'raw_three_family_hash');
 const familyStart=source.indexOf(" FOREACH family214 IN ARRAY ARRAY['158','159','160'] LOOP"),familyEnd=source.indexOf('\n END LOOP;',familyStart);
 assert(familyStart>=0&&familyEnd>familyStart,'closed existing three-family metadata reconstruction');
 const family={start:familyStart,end:familyEnd};
 const groups=familyBoundTargets(source,familyStart,familyEnd);
 assert(!source.includes('split210_financial_bound_candidates')&&!source.includes('split210_financial_bound_verified'),'fresh statement-local CTE names');
 const cte=`WITH split210_financial_bound_candidates AS MATERIALIZED(
   SELECT t.oid FROM pg_catalog.pg_trigger t
   JOIN pg_catalog.pg_class rel ON rel.oid=t.tgrelid
   JOIN pg_catalog.pg_namespace n ON n.oid=rel.relnamespace
   JOIN(VALUES ${groups.flatMap(g=>g.targets.map(table=>'('+quoted(g.family)+','+quoted(table)+",'order_split210_bound')")).join(',')}) declared(family_code,table_name,trigger_name)
    ON declared.family_code=family214 AND declared.table_name=rel.relname AND declared.trigger_name=t.tgname
   WHERE n.nspname='public'
  ),split210_financial_bound_verified AS MATERIALIZED(
   SELECT oid FROM split210_financial_bound_candidates WHERE public.order_split210_is_added_trigger(oid)
  )
  SELECT CASE family214`;
 add('SELECT CASE family214',cte,1,'statement_local_bound_classification',family);
 const table="FROM pg_trigger tr WHERE tr.tgrelid=c.oid AND NOT tr.tgisinternal";
 const exclude=' AND NOT EXISTS(SELECT FROM split210_financial_bound_verified verified WHERE verified.oid=tr.oid)';
 add(table,table+exclude,3,'financial_table_trigger_selector',family);
 const membership="FROM pg_trigger tr JOIN pg_class rel ON rel.oid=tr.tgrelid WHERE rel.relnamespace='public'::regnamespace AND NOT tr.tgisinternal";
 add(membership,membership+exclude,3,'financial_trigger_function_membership',family);
 edits.sort((a,b)=>a.beforeStart-b.beforeStart);
 let cursor=0,afterSource='';for(const e of edits){assert(e.beforeStart>=cursor,'disjoint exact source edits');afterSource+=source.slice(cursor,e.beforeStart);e.afterStart=afterSource.length;afterSource+=e.after;cursor=e.beforeStart+e.before.length;}afterSource+=source.slice(cursor);
 let inverse=afterSource;for(const e of [...edits].reverse()){assert.equal(inverse.slice(e.afterStart,e.afterStart+e.after.length),e.after);inverse=inverse.slice(0,e.afterStart)+e.before+inverse.slice(e.afterStart+e.after.length);}assert.equal(inverse,source,'whole original204 source byte inverse');
 // Preserve current financial self source/definition on the same side. The
 // later original162 normalization must replace the COMPLETE current body.
 const rawSelf="SELECT prosrc INTO STRICT source219 FROM pg_proc WHERE oid='public.financial_return_upgrade_valid()'::regprocedure;";
 assert.equal(executablePositions(source,rawSelf).length,1);assert.equal(executablePositions(afterSource,rawSelf).length,1);
 const rawCase="CASE WHEN p.oid IN('public.financial_return_upgrade_valid()'::regprocedure,'public.buyer_address_guards()'::regprocedure) THEN pg_get_functiondef(p.oid) ELSE public.partial_sale204_predecessor_definition(p.oid) END";
 assert.equal(executablePositions(source,rawCase).length,3);assert.equal(executablePositions(afterSource,rawCase).length,3);
 const selfStart=executablePositions(source,rawSelf)[0];assert.equal(afterSource.slice(afterSource.indexOf(rawSelf)),source.slice(selfStart),'entire financial162 self normalization and final certificate tail remain literal');
 const selectorAudit=auditBooleanSelectors(source,familyStart,familyEnd);
 assert.equal(before.definition.split(source).length,2,'one complete function body in definition');
 const after={...before,source:afterSource,definition:before.definition.replace(source,()=>afterSource)};
 const {source:bs,definition:bd,...bh}=before,{source:as,definition:ad,...ah}=after;assert.equal(digest(bh),digest(ah),'literal full header and ACL preserved');
 const change={kind:'function',key:ORDER_SPLIT210_FINANCIAL_SOURCE.key,before,after};
 return freeze({schema:'order-split210-financial-successor-candidate/v1',change,sql:after.definition+';\n',edits,
  source_proofs:ORDER_SPLIT210_FINANCIAL_SOURCE,projection_counts:{raw_three_family_hash:1,statement_local_bound_classification:1,financial_table_trigger_selector:3,financial_trigger_function_membership:3,raw_self_source_preserved:1,raw_self_definition_selectors_preserved:3},
  statement_local_bound_targets:groups,raw_boolean_selector_audit:selectorAudit,strict_bound_classifications:{per_family:groups.map(g=>g.targets.length),three_statement_total:9,maximum_per_statement:5,cross_statement_cache:false},
  source_bytes_before:Buffer.byteLength(source),source_bytes_after:Buffer.byteLength(afterSource),source_after_sha256:sha(afterSource),whole_source_inverse_verified:true,
  target_metadata_adopted:false,assembled:false,source_compilation_performed:false,native_certification:false,application_activation:false});
}
