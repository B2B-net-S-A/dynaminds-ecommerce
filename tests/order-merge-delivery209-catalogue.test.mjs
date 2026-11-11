/** SMALL SYNTHETIC full catalogue memberships, not source-compiled E209,
 * Native acceptance or business proof. Real authored core supplies eight FKs. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {ORDER_MERGE_DELIVERY209_CHANGED_FUNCTION_KEYS as keys}
 from '../tools/parity/order-merge-delivery209-inverse.mjs';
import {ORDER_MERGE_DELIVERY209_CHECK_EXPRESSIONS as expressions} from '../tools/parity/order-merge-delivery209-constraints.mjs';
import {projectOrderMergeDelivery209Catalogue as project} from '../tools/parity/order-merge-delivery209-catalogue.mjs';
import {validateRecoverySchema,compareRecoverySchemas,SCHEMA_VERSION,SQL_SHA256} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-catalogue-reader.mjs';
import {SCOPE} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-catalogue-sql.mjs';
import {SOURCE_SELECTION} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-source-selection.mjs';
const source209Business=readFileSync(new URL('../tools/parity/order-merge-delivery209-business.sql',import.meta.url),'utf8'),options={source209Business};
const copy=structuredClone,id=r=>r.kind+'\0'+r.key,sort=rows=>rows.sort((a,b)=>id(a)<id(b)?-1:id(a)>id(b)?1:0);
const freeze=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;};
const acl=[{grantor:'postgres',grantee:'postgres',privilege:'EXECUTE',grantable:false}];
const fn=(source='BEGIN RETURN true;END')=>({owner:'postgres',language:'plpgsql',kind:'f',cost:100,rows:0,security_definer:true,leakproof:false,strict:false,returns_set:false,volatility:'s',parallel:'u',support:null,variadic:null,argument_names:null,argument_modes:null,arguments:'',result:'boolean',defaults:null,source,binary:null,config:['search_path=pg_catalog, public'],definition:'CREATE FUNCTION synthetic() RETURNS boolean AS $$'+source+'$$ LANGUAGE plpgsql',acl_null:false,acl:copy(acl)});
const relation=()=>({owner:'postgres',kind:'r',persistence:'p',access_method:'heap',row_security:true,force_row_security:true,replica_identity:'d',partition:false,partition_bound:null,partition_key:null,options:null,tablespace:null,acl_null:false,acl:[],view:null});
const constraint=(kind,definition,deferred=false)=>({kind,deferrable:deferred,deferred,validated:true,local:true,inheritance_count:0,no_inherit:true,definition});
const trigger=(name,func,type,deferred=false)=>({internal:false,name,enabled:'O',type,function:func,attributes:[],arguments:'',constraint:deferred?name:null,constraint_relation:null,deferrable:deferred,deferred,has_when:false,old_table:null,new_table:null,definition:'SYNTHETIC COMPILED-DEFINITION PLACEHOLDER '+name});
// Independent literal declarations from the authored receipt table.
const fkOracle=[
 ['tenant_id,execution_id','order_merge_executions','tenant_id,id',false],
 ['tenant_id,merge_preview_id','order_merge_previews','tenant_id,id',false],
 ['tenant_id,source_order_id','orders','tenant_id,id',false],['tenant_id,target_order_id','orders','tenant_id,id',false],
 ['actor_id','users','id',false],['tenant_id,api_key_id','api_keys','tenant_id,id',false],
 ['tenant_id,target_order_id,preview_id','buyer_address_previews','tenant_id,order_id,id',true],
 ['tenant_id,target_order_id,receipt_id','buyer_address_receipts','tenant_id,order_id,id',true],
];
function fixture(){
 const changes=keys.map((key,i)=>({kind:'function',key,before:fn('BEGIN RETURN '+i+';END'),after:fn('BEGIN RETURN '+(i+10)+';END')}));
 for(const table of ['buyer_address_previews','buyer_address_receipts'])for(const role of ['kind','actor'])changes.push({kind:'constraint',key:'public.'+table+'.synthetic_'+role+'_check',before:constraint('c',expressions[role+'_before']),after:constraint('c',expressions[role+'_after'])});
 const additions=['receipts','manifest','projection_basis'].map(s=>({kind:'relation',key:'public.order_merge_delivery209_'+s,value:relation()}));
 additions.push({kind:'function',key:'public.order_merge_delivery209_projection_map()',value:fn()});
 additions.push({kind:'type',key:'public._order_merge_delivery209_receipts',value:{owner:'postgres',kind:'b',category:'A',defined:true,not_null:false,base:null,element:'order_merge_delivery209_receipts',default:null,collation:null,enum_labels:[],acl_null:true,acl:[],default_expression:null,length:-1,by_value:false,preferred:false,delimiter:',',relation:null,subscript:'array_subscript_handler(internal)',array:null,input:'array_in(cstring,oid,integer)',output:'array_out(anyarray)',receive:'array_recv(internal,oid,integer)',send:'array_send(anyarray)',modifier_input:null,modifier_output:null,analyze:'array_typanalyze(internal)',alignment:'d',storage:'x',modifier:-1,dimensions:0}});
 additions.push({kind:'trigger',key:'public.order_merge_previews.order_merge_delivery209_source_preview',value:trigger('order_merge_delivery209_source_preview','order_merge_delivery209_preview_guard()',7)});
 additions.push({kind:'trigger',key:'public.order_merge_executions.order_merge_delivery209_complete',value:trigger('order_merge_delivery209_complete','order_merge_delivery209_complete()',5,true)});
 additions.push({kind:'constraint',key:'public.order_merge_executions.order_merge_delivery209_complete',value:constraint('t','TRIGGER DEFERRABLE INITIALLY DEFERRED',true)});
 fkOracle.forEach(([columns,target,remote,deferred],i)=>{
  // Names deliberately need not preserve namespace prefix (real PG truncates).
  const name=i===6?'order_merge_delivery209_rece_tenant_target_preview_fkey':'synthetic_fk_'+i;
  additions.push({kind:'constraint',key:'public.order_merge_delivery209_receipts.'+name,value:constraint('f',`FOREIGN KEY (${columns.split(',').join(', ')}) REFERENCES ${target}(${remote.split(',').join(', ')})`+(deferred?' DEFERRABLE INITIALLY DEFERRED':''),deferred)});
  for(const [action,type,table,opposite]of [['check_ins',5,'order_merge_delivery209_receipts',target],['check_upd',17,'order_merge_delivery209_receipts',target],['noaction_del',9,target,'order_merge_delivery209_receipts'],['noaction_upd',17,target,'order_merge_delivery209_receipts']]){
   const func='"RI_FKey_'+action+'"()';additions.push({kind:'trigger',key:`public.${table}.internal:${name}:${func}:${type}:`,value:{internal:true,name:null,enabled:'O',type,function:func,attributes:[],arguments:'',constraint:name,constraint_relation:opposite,deferrable:deferred,deferred,has_when:false,old_table:null,new_table:null,definition:null}});
  }
 });
 const unrelated=[{kind:'function',key:'public.unrelated_order_merge_delivery209_mention()',value:fn('BEGIN RETURN true; /* order_merge_delivery209_receipts */END')}];
 additions.push({kind:'column',key:'public.order_merge_delivery209_receipts.id',value:{position:1,type:'uuid',not_null:true,generated:'',identity:'',storage:'p',compression:'',statistics:-1,options:null,foreign_options:null,collation:null,default:null,acl_null:true,acl:[]}});
 additions.push({kind:'index',key:'public.order_merge_delivery209_receipts_pkey',value:{table:'order_merge_delivery209_receipts',unique:true,primary:true,exclusion:false,immediate:true,clustered:false,valid:true,ready:true,live:true,replica_identity:false,nulls_not_distinct:false,definition:'SYNTHETIC INDEX'}});
 additions.push({kind:'policy',key:'public.order_merge_delivery209_receipts.synthetic_owner',value:{command:'*',permissive:true,roles:['postgres'],using:'true',check:'true'}});
 const base=[...SCOPE.map(key=>({kind:'schema',key,value:{owner:'postgres',acl_null:false,acl:[]}})),...SOURCE_SELECTION.required_tables.map(key=>({kind:'relation',key,value:relation()})),...SOURCE_SELECTION.required_functions.map(key=>({kind:'function',key,value:fn()}))];
 unrelated.push(...base);
 const expected={schema:'source209-order-merge-delivery-exact-inverse/v1',additions:sort(additions),changes,removed:[]};
 const before=sort([...changes.map(c=>({kind:c.kind,key:c.key,value:copy(c.before)})),...copy(unrelated)]);
 const after=sort([...changes.map(c=>({kind:c.kind,key:c.key,value:copy(c.after)})),...copy(additions),...copy(unrelated)]);
 return {expected,before:seal(before),after:seal(after),unrelated};
}

const counter={relation:'relations',index:'indexes',column:'columns',constraint:'constraints',function:'functions',trigger:'triggers',policy:'policies',type:'types'};
const countKeys='relations,indexes,sequences,inheritance,columns,constraints,policies,triggers,unsupported_internal_trigger_when,functions,types,event_triggers,default_acl,roles,role_memberships,extensions,rules,unsupported_relations,unsupported_routines,operators,operator_classes,operator_families,operator_family_operators,operator_family_procedures,access_methods,languages,extension_members,unsupported_ranges,unsupported_operator_shells,unsupported_statistics,unsupported_publications,unsupported_subscriptions,unsupported_collations,unsupported_foreign_servers,unsupported_languages'.split(',');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const hash=v=>createHash('sha256').update(v).digest('hex');
function reseal(input){const {sha256,...body}=structuredClone(input);return {...body,sha256:hash(JSON.stringify(canonical(body)))};}
function seal(rows){
 const counts=Object.fromEntries(countKeys.map(k=>[k,0]));counts.schemas=[...SCOPE].sort();
 for(const row of rows)if(counter[row.kind])counts[counter[row.kind]]++;
 return reseal({schema:SCHEMA_VERSION,postgres_major:18,scope:[...SCOPE],sql_sha256:SQL_SHA256,counts,records:sort(rows)});
}

test('full catalogue inverse normalizes all14 replacements and matches the independently sealed predecessor canonical AND serialized representation',()=>{
 const f=fixture(),saved=JSON.stringify(f.after),expected=validateRecoverySchema(f.before),result=project(f.after,f.expected,options);
 assert.equal(result.active,true);assert.equal(result.mode,'active209_inverse');assert.equal(result.changed_records,14);
 assert.equal(result.removed_records,f.expected.additions.length);assert.equal(result.authority,false);
 assert.equal(result.catalogue.sha256,expected.sha256);assert.equal(JSON.stringify(result.catalogue),JSON.stringify(expected));
 assert.equal(compareRecoverySchemas(result.catalogue,expected).equal,true);assert.equal(validateRecoverySchema(result.catalogue),result.catalogue);
 assert.equal(JSON.stringify(f.after),saved);assert(!Object.isFrozen(f.after),'Caller input is not frozen in place');
 assert(Object.isFrozen(result)&&Object.isFrozen(result.removed_counts));
 for(const [kind,count]of Object.entries(counter)){
  const n=f.expected.additions.filter(r=>r.kind===kind).length;assert(n>0,'Exercise subtraction for all eight kinds');
  assert.equal(result.removed_counts[count],n);assert.equal(result.catalogue.counts[count],f.after.counts[count]-n);
 }
 assert.equal(result.catalogue.counts.schemas.join(','),f.after.counts.schemas.join(','));
});

test('object insertion order, nested numeric keys and text escaping have the same canonical digest and final reader serialization',()=>{
 const f=fixture();
 // A deliberately synthetic but schema-valid nested JSON value exercises the
 // canonical serializer's numeric object-key rule, independently of SQL data.
 const nested={'10':'ten','2':'two','01':'one',['__proto__']:'data',z:'ą\n"\\\u0000'};
 for(const side of ['before','after']){
  const raw=copy(f[side]);raw.records.find(r=>r.key==='public.unrelated_order_merge_delivery209_mention()').value.defaults=nested;f[side]=reseal(raw);
 }
 const reverse=v=>Array.isArray(v)?v.map(reverse):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).reverse().map(k=>[k,reverse(v[k])])):v;
 const reversed=reverse(f.after),result=project(reversed,f.expected,options),expected=validateRecoverySchema(f.before);
 assert.equal(result.catalogue.sha256,expected.sha256);assert.equal(JSON.stringify(result.catalogue),JSON.stringify(expected));
 assert.equal(Object.keys(result.catalogue.records[0]).join(','),'key,kind,value');
 assert.equal(JSON.stringify(reversed),JSON.stringify(reverse(f.after)),'Foreign property order is not mutated');
});

test('inactive209 preserves validated owned identity and requires literal14 BEFORE records; explicit pre205 remains unchanged comparison only',()=>{
 const f=fixture(),owned=validateRecoverySchema(f.before),result=project(owned,f.expected,options);
 assert.equal(result.catalogue,owned);assert.equal(result.active,false);assert.equal(result.mode,'absent209_on205');assert.equal(result.authority,false);
 assert(Object.values(result.removed_counts).every(n=>n===0));assert(!Object.hasOwn(result,'ready'));
 const changedIds=new Set(f.expected.changes.map(id)),earlier=seal(f.before.records.filter(r=>!changedIds.has(id(r)))),oldOwned=validateRecoverySchema(earlier);
 assert.throws(()=>project(oldOwned,f.expected,options),'Default cannot guess a missing205 means earlier catalogue');
 const old=project(oldOwned,f.expected,{...options,phase:'pre205_identity'});
 assert.equal(old.catalogue,oldOwned);assert.equal(old.mode,'pre205_identity');assert.equal(old.active,false);assert.equal(old.authority,false);
 assert.equal(JSON.stringify(old.catalogue),JSON.stringify(oldOwned));
 assert.throws(()=>project(owned,f.expected,{...options,phase:'pre205_identity'}));
});

test('explicit expectation/source are always required, including identity; neither a past result nor matching SHA authenticates a later expectation',()=>{
 const f=fixture(),owned=validateRecoverySchema(f.after);project(owned,f.expected,options);
 assert.throws(()=>project(owned));assert.throws(()=>project(owned,f.expected));
 assert.throws(()=>project(owned,f.expected,{...options,source209Business:source209Business+'\n'}));
 const wrong=copy(f.expected);wrong.changes[0].after.source+=' tamper';assert.throws(()=>project(owned,wrong,options));
 const missing=copy(f.expected);missing.additions.pop();assert.throws(()=>project(owned,missing,options));
 assert.throws(()=>project(validateRecoverySchema(f.before),undefined,options));
});

test('caller mutation cannot poison catalogue, replacement values or removed counts; fresh equal foreign snapshots are independently normalized',()=>{
 const f=fixture(),saved=JSON.stringify(f.after),result=project(f.after,f.expected,options),serialized=JSON.stringify(result.catalogue);
 f.after.records[0].value.definition='caller changed';f.expected.changes[0].before.source='caller changed';
 assert.equal(JSON.stringify(result.catalogue),serialized);assert.throws(()=>{result.catalogue.records[0].value.definition='poison';});
 assert.throws(()=>{result.removed_counts.functions=999;});
 const fresh=fixture(),other=project(JSON.parse(saved),fresh.expected,options);
 assert.notEqual(other.catalogue,result.catalogue);assert.equal(JSON.stringify(other.catalogue),serialized);
 assert.equal(other.authority,false);
});

test('every count mismatch, integrity/query/schema corruption and unknown extra root field is rejected before projection',()=>{
 const f=fixture();for(const count of Object.values(counter)){
  const bad=copy(f.after);bad.counts[count]++;assert.throws(()=>project(reseal(bad),f.expected,options));
 }
 for(const mutate of [x=>x.sha256='0'.repeat(64),x=>x.sql_sha256='0'.repeat(64),x=>x.schema='foreign',x=>x.postgres_major=17,x=>x.scope.reverse(),x=>x.ready=true]){
  const bad=copy(f.after);mutate(bad);assert.throws(()=>project(bad,f.expected,options));
 }
});

test('missing/extra209 rows, overloads and complete descriptor/header drift remain refused despite a valid full catalogue digest',()=>{
 const f=fixture();
 const missing=f.after.records.filter(r=>r.key!=='public.order_merge_delivery209_projection_map()');assert.throws(()=>project(seal(missing),f.expected,options));
 const extra=copy(f.after.records);extra.push({kind:'function',key:'public.order_merge_delivery209_unreviewed()',value:fn()});assert.throws(()=>project(seal(extra),f.expected,options));
 const overload=copy(f.after.records);overload.push({kind:'function',key:'public.buyer_address_guards(extra text)',value:fn()});assert.throws(()=>project(seal(overload),f.expected,options));
 for(const field of ['owner','source','definition','config','acl']){
  const bad=copy(f.after.records),row=bad.find(r=>r.key===keys[0]);row.value[field]=field==='acl'?[]:field==='config'?['search_path=foreign']:'tampered';assert.throws(()=>project(seal(bad),f.expected,options));
 }
});

test('representation output cannot acquire actual reader transaction context or advertise source/Native acceptance',async()=>{
 const {inspectPackingCatalogueContext}=await import('../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-catalogue-reader.mjs');
 const f=fixture(),result=project(f.after,f.expected,options);
 assert.throws(()=>inspectPackingCatalogueContext(result.catalogue),/owned-catalogue-required/);
 assert.deepEqual(Object.keys(result).sort(),['catalogue','mode','active','removed_records','changed_records','removed_counts','authority'].sort());
 assert.equal(result.authority,false);assert(!Object.hasOwn(result,'nativeAcceptance'));assert(!Object.hasOwn(result,'source_compilation_proven'));
});
