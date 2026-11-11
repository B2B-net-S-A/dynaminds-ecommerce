/** Source-only fifteenth210 successor. Exact accepted22b buyer DATA supplies
 * both209 and208 full descriptors. No catalogue adoption, execution or seal. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ORDER_MERGE_DELIVERY209_SOURCE_CONTRACT as parent,ORDER_MERGE_DELIVERY209_SOURCE_ORIGIN as origin} from '../../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/order-merge-delivery209-source-contract.mjs';
import {orderMergeDelivery209HistorySqlSpans as spans} from './order-merge-delivery209-history-closure.mjs';
import {deriveOrderSplit210TriggerRoster,ORDER_SPLIT210_TRIGGER_SOURCE_SHA256} from './order-split210-external-triggers.mjs';

const sha=s=>createHash('sha256').update(s).digest('hex');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const digest=v=>sha(JSON.stringify(canonical(v)));
const freeze=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;};
export const ORDER_SPLIT210_BUYER_SOURCE=freeze({
 key:'public.buyer_address_guards()',parent_decoded_sha256:'121abfe5df79f03f9d3acd38e566bbcf53c18ec0b4bf418c316632138cd37070',
 parent209_record_sha256:'a7fcbb15ba9b5bae29886c346db8ce8e3407acf46413185b996f87b6268e28a5',
 parent208_record_sha256:'49c63177a92fe4bff983abf62bd0326a4d9cb47e56ba75c1fac2a6d0df893ed3',
 parent209_source_sha256:'7f7a8a2a79b19b85b7f28f51b440173816b83a8146f11a4d383d9d161ed51c38',parent209_source_bytes:83182,
 trigger_source_sha256:ORDER_SPLIT210_TRIGGER_SOURCE_SHA256,
 raw_three_hash_boundary_actual_verified:true,later_trigger_path_native_verified:false,
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
function authoredParents(){
 assert.equal(origin.decoded_sha256,ORDER_SPLIT210_BUYER_SOURCE.parent_decoded_sha256,'accepted22b complete source contract');
 const c=parent.changes.find(c=>c.kind==='function'&&c.key===ORDER_SPLIT210_BUYER_SOURCE.key);assert(c,'accepted22b buyer binding');
 assert.equal(digest(c.after),ORDER_SPLIT210_BUYER_SOURCE.parent209_record_sha256,'complete209 buyer header/body/ACL');
 assert.equal(digest(c.before),ORDER_SPLIT210_BUYER_SOURCE.parent208_record_sha256,'complete208 buyer ancestor');
 assert.equal(sha(c.after.source),ORDER_SPLIT210_BUYER_SOURCE.parent209_source_sha256);assert.equal(Buffer.byteLength(c.after.source),83182);
 assert.equal(Object.keys(c.after).length,24);return c;
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

/** `source210`, when supplied, must be the exact authored210 business source.
 * Omission never reads files or accepts caller metadata. The SQL uses existing
 * strict210 ports; integration must seal those ports and the entire new body. */
export function deriveOrderSplit210BuyerSuccessor(options={}){
 assert(options&&typeof options==='object'&&!Array.isArray(options));assert(Object.keys(options).every(k=>k==='source210'),'closed source-only buyer inputs');
 if(Object.hasOwn(options,'source210')){
  const d=Object.getOwnPropertyDescriptor(options,'source210');assert(d&&Object.hasOwn(d,'value'),'source210 data property required');
  const roster=deriveOrderSplit210TriggerRoster({source210:d.value});assert.equal(roster.counts.external_bound,12);assert.equal(roster.counts.external_deferred,0);assert.deepEqual(roster.groups.external_bound,boundKeys,'complete authored external bound identities');
 }
 const p=authoredParents(),before=p.after,source=before.source,edits=[];
 const add=(needle,replacement,count,kind,range)=>{const matches=executablePositions(source,needle,range);assert.equal(matches.length,count,'exact executable '+kind+' sites');for(const beforeStart of matches)edits.push({kind,beforeStart,before:needle,after:replacement});};
 const rawHash="WHERE p.oid IS NULL OR encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') IS DISTINCT FROM expected.body_sha) THEN RETURN false;END IF;";
 const projectedHash="WHERE p.oid IS NULL OR encode(sha256(convert_to(public.order_split210_try_function_projection(p.oid)->>'source','UTF8')),'hex') IS DISTINCT FROM expected.body_sha) THEN RETURN false;END IF;";
 for(const [family,key,hash]of knownHashes)assert(source.includes("('"+family+"','"+key+"','"+hash+"')"),'literal three family identities and expected hashes unchanged');
 add(rawHash,projectedHash,1,'raw_three_family_hash');
 const familyStart=source.indexOf(" FOREACH family214 IN ARRAY ARRAY['158','159','160'] LOOP"),familyEnd=source.indexOf('\n END LOOP;',familyStart);
 assert(familyStart>=0&&familyEnd>familyStart,'closed existing three-family metadata reconstruction');
 const family={start:familyStart,end:familyEnd};
 const groups=familyBoundTargets(source,familyStart,familyEnd);
 assert(!source.includes('split210_bound_candidates')&&!source.includes('split210_bound_verified'),'fresh statement-local CTE names');
 const cte=`WITH split210_bound_candidates AS MATERIALIZED(
   SELECT t.oid FROM pg_catalog.pg_trigger t
   JOIN pg_catalog.pg_class rel ON rel.oid=t.tgrelid
   JOIN pg_catalog.pg_namespace n ON n.oid=rel.relnamespace
   JOIN(VALUES ${groups.flatMap(g=>g.targets.map(table=>'('+quoted(g.family)+','+quoted(table)+",'order_split210_bound')")).join(',')}) declared(family_code,table_name,trigger_name)
    ON declared.family_code=family214 AND declared.table_name=rel.relname AND declared.trigger_name=t.tgname
   WHERE n.nspname='public'
  ),split210_bound_verified AS MATERIALIZED(
   SELECT oid FROM split210_bound_candidates WHERE public.order_split210_is_added_trigger(oid)
  )
  SELECT CASE family214`;
 add('SELECT CASE family214',cte,1,'statement_local_bound_classification',family);
 const table="FROM pg_trigger tr WHERE tr.tgrelid=c.oid AND NOT tr.tgisinternal";
 const exclude=' AND NOT EXISTS(SELECT FROM split210_bound_verified verified WHERE verified.oid=tr.oid)';
 add(table,table+exclude,3,'financial_table_trigger_selector',family);
 const membership="FROM pg_trigger tr JOIN pg_class rel ON rel.oid=tr.tgrelid WHERE rel.relnamespace='public'::regnamespace AND NOT tr.tgisinternal";
 add(membership,membership+exclude,3,'financial_trigger_function_membership',family);
 edits.sort((a,b)=>a.beforeStart-b.beforeStart);
 let cursor=0,afterSource='';for(const e of edits){assert(e.beforeStart>=cursor,'disjoint exact source edits');afterSource+=source.slice(cursor,e.beforeStart);e.afterStart=afterSource.length;afterSource+=e.after;cursor=e.beforeStart+e.before.length;}afterSource+=source.slice(cursor);
 let inverse=afterSource;for(const e of [...edits].reverse()){assert.equal(inverse.slice(e.afterStart,e.afterStart+e.after.length),e.after);inverse=inverse.slice(0,e.afterStart)+e.before+inverse.slice(e.afterStart+e.after.length);}assert.equal(inverse,source,'whole original209 source byte inverse');
 // Keep BOTH raw self leaves on the same side. The inherited guard deliberately
 // normalizes its full current definition with its full current raw body before
 // comparing the literal166 self definition. Do not wrap the entire buyer JSON.
 const rawSelf="SELECT prosrc INTO STRICT buyer_source251 FROM pg_proc WHERE oid='public.buyer_address_guards()'::regprocedure;";
 assert.equal(executablePositions(source,rawSelf).length,1);assert.equal(executablePositions(afterSource,rawSelf).length,1);
 const rawSelfDefinition="CASE WHEN p.oid IN('public.financial_return_upgrade_valid()'::regprocedure,'public.buyer_address_guards()'::regprocedure) THEN pg_get_functiondef(p.oid) ELSE public.partial_sale204_predecessor_definition(p.oid) END";
 assert.equal(executablePositions(source,rawSelfDefinition).length,4);assert.equal(executablePositions(afterSource,rawSelfDefinition).length,4);
 assert.equal(before.definition.split(source).length,2,'one complete function body in definition');
 const after={...before,source:afterSource,definition:before.definition.replace(source,()=>afterSource)};
 const {source:bs,definition:bd,...bh}=before,{source:as,definition:ad,...ah}=after;assert.equal(digest(bh),digest(ah),'literal full header and ACL preserved');
 const change={kind:'function',key:ORDER_SPLIT210_BUYER_SOURCE.key,before,after};
 return freeze({schema:'order-split210-buyer-successor-candidate/v1',change,before208:p.before,sql:after.definition+';\n',edits,
  source_proofs:ORDER_SPLIT210_BUYER_SOURCE,projection_counts:{raw_three_family_hash:1,statement_local_bound_classification:1,financial_table_trigger_selector:3,financial_trigger_function_membership:3,raw_self_source_preserved:1,raw_self_definition_selectors_preserved:4},
  statement_local_bound_targets:groups,strict_bound_classifications:{per_family:groups.map(g=>g.targets.length),three_statement_total:9,maximum_per_statement:5,cross_statement_cache:false},
  source_bytes_before:Buffer.byteLength(source),source_bytes_after:Buffer.byteLength(afterSource),source_after_sha256:sha(afterSource),whole_source_inverse_verified:true,
  target_metadata_adopted:false,assembled:false,source_compilation_performed:false,native_certification:false,application_activation:false});
}
