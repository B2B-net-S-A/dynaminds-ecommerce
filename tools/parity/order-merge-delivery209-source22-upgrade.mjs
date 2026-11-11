/** Fixed Source21 -> reviewed Source22b, for an isolated COPY only.
 * Pure SQL preparation: no database, observed reseal, business UPDATE or COMMIT.
 * The operator must authenticate full catalogues and all627 table fingerprints
 * in the same owner transaction; this plan does not grant runtime acceptance. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual as same} from 'node:util';
import {ORDER_MERGE_DELIVERY209_STARTUP_KEYS,assertOrderMergeDelivery209StartupBeforeRecords} from './order-merge-delivery209-startup-roster.mjs';

export const ORDER_MERGE_DELIVERY209_SOURCE22_UPGRADE_PINS=Object.freeze({
 before_contract:'45c383e6af47e7f3d7ee35e92e91c147094c4bb6b60cd35cbc4a5ab506777bb6',before_contract_bytes:22468966,
 after_contract:'121abfe5df79f03f9d3acd38e566bbcf53c18ec0b4bf418c316632138cd37070',after_contract_bytes:23317916,
 sql:'0e03d091e3ccb1b9f42c0890215f70e78055403a5451ff040428b96f152c024a',sql_bytes:28449419,
 payload:'ed45aecdcf4d959c7ff636cd315a12162316f030cb1e382e7e82e5ed6eb4a2d4',payload_bytes:21756960,
 before_fingerprint:'496cbd23d638ed7420dfb14274f1dd646a5028c269c9bc9f85cd60e85d10efe9',
 after_fingerprint:'a3adaee6c7d362e466c3494cf41c46de7b85676e56affaf22809da9161dbb82e',
 native_receipt:'9942cd0f31631af320c535b424a0c41ee7a3ad912faba64a964b44da8d0f5989',
 native_review:'c3083fdf081056ef7085cae2423ecfa7233d37722769a9dfe32b37e2326737c1',
});
const P=ORDER_MERGE_DELIVERY209_SOURCE22_UPGRADE_PINS,sha=value=>createHash('sha256').update(value).digest('hex');
const prefix='public.order_merge_delivery209_',table=prefix+'projection_basis',id=r=>r.kind+'\0'+r.key;
const newFunctions=Object.freeze(['issuer_guards','operative_valid','packed_guards','parcel_valid'].map(name=>prefix+'pim_'+name+'(entries jsonb, wave_ok boolean)').concat(prefix+'startup_operative_valid(entries jsonb)'));
const changedFunctions=Object.freeze([
 prefix+'checked_projection_map(selected_fn oid)',prefix+'history_predecessor_project(v jsonb, entries jsonb)',
 prefix+'predecessor_definition(fn oid)',prefix+'predecessor_definition(fn oid, entries jsonb)',
 prefix+'predecessor_descriptor(fn oid)',prefix+'predecessor_descriptor(fn oid, entries jsonb)',
 prefix+'predecessor_metadata(value jsonb)',prefix+'predecessor_metadata(value jsonb, entries jsonb)',
 prefix+'predecessor_source(fn oid)',prefix+'predecessor_source(fn oid, entries jsonb)',
 prefix+'predecessor_source_sha(fn oid, entries jsonb)',prefix+'projection_map()',prefix+'validation_snapshot()',prefix+'wave_valid(manual_basis jsonb)',
 ...ORDER_MERGE_DELIVERY209_STARTUP_KEYS,'public.partial_sale204_predecessor_definition(fn oid)',
]);
const newColumns=Object.freeze(Array.from({length:7},(_,i)=>'before_'+(i+10)));
const newChecks=Object.freeze(newColumns.map(name=>'order_merge_delivery209_'+name+'_source'));
const changedChecks=Object.freeze(['order_merge_delivery209_checks_source','order_merge_delivery209_keys_source','order_merge_delivery209_projection_basis_payload_check']);
function contract(value,pin,bytes,additions,changes){
 assert(value&&typeof value==='object'&&!Array.isArray(value),'fixed source contract required');
 const text=JSON.stringify(value);assert(Buffer.byteLength(text)<=33554432,'bounded source contract');assert.equal(Buffer.byteLength(text),bytes);assert.equal(sha(text),pin,'fixed source contract required');
 const result=JSON.parse(text);assert.equal(result.schema,'source209-order-merge-delivery-exact-inverse/v1');assert.equal(result.additions.length,additions);assert.equal(result.changes.length,changes);assert.deepEqual(result.removed,[]);return result;
}
function records(c){const rows=[...c.additions,...c.changes.map(c=>({kind:c.kind,key:c.key,value:c.after}))],map=new Map(rows.map(r=>[id(r),r]));assert.equal(rows.length,map.size);return map;}
function bodyOnly(before,after){const{source,definition,...header}=before,{source:next,definition:nextDefinition,...nextHeader}=after;assert(same(header,nextHeader),'literal function headers and ACL required');assert.equal(definition.split(source).length,2);assert.equal(nextDefinition,definition.replace(source,()=>next),'only the complete function body changes');}
function checkHeader(value){const{definition,...header}=value;assert.deepEqual(header,{deferrable:false,deferred:false,inheritance_count:0,kind:'c',local:true,no_inherit:false,validated:true});assert.equal(typeof definition,'string');assert(definition.startsWith('CHECK ('));}
function extractPayload(sql,after){
 assert.equal(typeof sql,'string');assert.equal(Buffer.byteLength(sql),P.sql_bytes);assert.equal(sha(sql),P.sql,'fixed target SQL required');
 const marker="INSERT INTO public.order_merge_delivery209_projection_basis(id,payload) VALUES(true,'",start=sql.indexOf(marker);assert(start>=0&&sql.indexOf(marker,start+1)===-1,'one source payload');const begin=start+marker.length,end=sql.indexOf("');\n",begin);assert(end>begin);const text=sql.slice(begin,end).replaceAll("''", "'");assert.equal(Buffer.byteLength(text),P.payload_bytes);assert.equal(sha(text),P.payload);
 const map=JSON.parse(text);assert(Array.isArray(map)&&map.length===17);assert.equal(new Set(map.map(r=>r.key)).size,17);const functions=new Map(after.changes.filter(r=>r.kind==='function').map(r=>[r.key,r]));
 for(const row of map){assert.deepEqual(Object.keys(row).sort(),['after','after_check','before','key']);const expected=functions.get(row.key);assert(expected);assert(same(row.before,expected.before)&&same(row.after,expected.after),'all17 complete source before/after records');const check=structuredClone(row.after);for(const field of ['source','definition'])check[field]=['sha256-utf8-text/v1',check[field]===null?null:sha(check[field])];assert(same(row.after_check,check),'complete current descriptor check leaves');}
 return text;
}
export function deriveOrderMergeDelivery209Source22Upgrade({beforeContract,afterContract,targetSql}){
 const before=contract(beforeContract,P.before_contract,P.before_contract_bytes,240,14),after=contract(afterContract,P.after_contract,P.after_contract_bytes,259,21);
 const nextChanges=new Map(after.changes.map(r=>[id(r),r]));for(const row of before.changes){const next=nextChanges.get(id(row));assert(next&&same(row.before,next.before),'literal208 ancestry unchanged');}
 const old=records(before),next=records(after);
 // Source21 did not change these seven public routines: they are absent from
 // its delta contract. Authenticate their literal E204 AFTER (=21 BEFORE22)
 // independently; absence must never be mistaken for seven new CREATEs.
 const startupBefore=ORDER_MERGE_DELIVERY209_STARTUP_KEYS.map(key=>{const row=after.changes.find(r=>r.kind==='function'&&r.key===key);assert(row);return{kind:row.kind,key,value:row.before};});assertOrderMergeDelivery209StartupBeforeRecords(startupBefore);
 for(const row of startupBefore){assert(!old.has(id(row)));old.set(id(row),row);}
 const added=[],changed=[];for(const[key,row]of next){const previous=old.get(key);if(!previous)added.push(row);else if(!same(previous,row))changed.push({before:previous,after:row});old.delete(key);}assert.equal(old.size,0,'no metadata removed');
 assert.deepEqual(added.filter(r=>r.kind==='function').map(r=>r.key).sort(),[...newFunctions].sort());assert.deepEqual(added.filter(r=>r.kind==='column').map(r=>r.key).sort(),newColumns.map(n=>table+'.'+n).sort());assert.deepEqual(added.filter(r=>r.kind==='constraint').map(r=>r.key).sort(),newChecks.map(n=>table+'.'+n).sort());assert.equal(added.length,19);
 const functions=changed.filter(r=>r.after.kind==='function'),checks=changed.filter(r=>r.after.kind==='constraint');assert.deepEqual(functions.map(r=>r.after.key).sort(),[...changedFunctions].sort());assert.deepEqual(checks.map(r=>r.after.key).sort(),changedChecks.map(n=>table+'.'+n).sort());assert.equal(changed.length,25);
 for(const row of functions)bodyOnly(row.before.value,row.after.value);for(const row of checks){checkHeader(row.before.value);checkHeader(row.after.value);const{definition:a,...x}=row.before.value,{definition:b,...y}=row.after.value;assert(same(x,y));assert.notEqual(a,b);}
 const data=extractPayload(targetSql,after),steps=[];const step=(label,text,values=[],ddl=0)=>steps.push(Object.freeze({label,text,values:Object.freeze(values),ddl_statements:ddl}));
 step('lock-own-source-metadata',`LOCK TABLE ${table},public.order_merge_delivery209_manifest IN ACCESS EXCLUSIVE MODE`);
 step('source21-precondition',`DO $upgrade22$ BEGIN
 IF current_user<>'postgres' OR current_user IS DISTINCT FROM session_user OR current_setting('session_replication_role')<>'origin'
 OR NOT EXISTS(SELECT FROM public.migrations WHERE name='209_order_merge_delivery_inheritance')
 OR (SELECT count(*) FROM public.order_merge_delivery209_manifest)<>1
 OR (SELECT fingerprint FROM public.order_merge_delivery209_manifest WHERE id) IS DISTINCT FROM '${P.before_fingerprint}'
 OR public.order_merge_delivery209_valid() IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'Intact Source21 copy required' USING ERRCODE='55000';END IF;END $upgrade22$`);
 for(const[nameIndex,name]of newColumns.entries()){
  const value=added.find(r=>r.kind==='column'&&r.key===table+'.'+name).value;
  assert.deepEqual(value,{acl:[],acl_null:true,collation:null,compression:'',default:`(((payload)::jsonb -> ${nameIndex+10}) -> 'before'::text)`,foreign_options:null,generated:'s',identity:'',not_null:false,options:null,position:nameIndex+18,statistics:null,storage:'x',type:'jsonb'});
  step('add-source-column:'+name,`ALTER TABLE ${table} ADD COLUMN ${name} jsonb GENERATED ALWAYS AS (${value.default}) STORED`,[],1);
 }
 for(const name of newChecks){const value=added.find(r=>r.kind==='constraint'&&r.key===table+'.'+name).value;checkHeader(value);step('add-unvalidated-source-check:'+name,`ALTER TABLE ${table} ADD CONSTRAINT ${name} ${value.definition} NOT VALID`,[],1);}
 for(const name of changedChecks){const row=checks.find(r=>r.after.key===table+'.'+name);step('drop-old-source-check:'+name,`ALTER TABLE ${table} DROP CONSTRAINT ${name}`,[],1);step('replace-unvalidated-source-check:'+name,`ALTER TABLE ${table} ADD CONSTRAINT ${name} ${row.after.value.definition} NOT VALID`,[],1);}
 for(const row of added.filter(r=>r.kind==='function')){assert.equal(row.value.owner,'postgres');assert.equal(row.value.acl_null,false);assert.deepEqual(row.value.acl,[{grantor:'postgres',grantee:'postgres',privilege:'EXECUTE',grantable:false}]);step('create-private:'+row.key,row.value.definition.trimEnd()+';',[],1);step('revoke-default-acl:'+row.key,`REVOKE ALL ON FUNCTION ${row.key} FROM PUBLIC,dyna_app`,[],1);}
 for(const row of functions)step('replace-body:'+row.after.key,row.after.value.definition.trimEnd()+';',[],1);
 step('open-own-payload',`ALTER TABLE ${table} DISABLE TRIGGER order_merge_delivery209_projection_immutable`,[],1);
 step('replace-source-payload',`UPDATE ${table} SET payload=$1 WHERE id RETURNING id`,[data]);
 step('close-own-payload',`ALTER TABLE ${table} ENABLE TRIGGER order_merge_delivery209_projection_immutable`,[],1);
 for(const name of [...newChecks,...changedChecks])step('validate-source-check:'+name,`ALTER TABLE ${table} VALIDATE CONSTRAINT ${name}`,[],1);
 step('open-own-manifest','ALTER TABLE public.order_merge_delivery209_manifest DISABLE TRIGGER order_merge_delivery209_manifest_immutable',[],1);
 step('replace-source-fingerprint','UPDATE public.order_merge_delivery209_manifest SET fingerprint=$1 WHERE id RETURNING id',[P.after_fingerprint]);
 step('close-own-manifest','ALTER TABLE public.order_merge_delivery209_manifest ENABLE TRIGGER order_merge_delivery209_manifest_immutable',[],1);
 const ddlCount=steps.reduce((sum,step)=>sum+step.ddl_statements,0);assert.equal(ddlCount,66);
 return Object.freeze({schema:'dynaminds-source209-source22-upgrade/v1',from:21,to:22,target_variant:'22b',source_pins:P,
  added_functions:5,changed_functions:22,added_columns:7,added_checks:7,changed_checks:3,ddl_statements:ddlCount,steps:Object.freeze(steps),
  requires_isolated_copy:true,requires_owner_transaction_fence:true,requires_full_before_catalogue:true,requires_full_after_catalogue:true,requires_full_runtime_guards:true,
  requires_all_627_before_fingerprints:true,requires_624_unchanged_table_fingerprints:true,requires_exact_own_basis_and_manifest_delta:true,requires_source182_full_row_transition:true,
  source182_changed_fields:Object.freeze(['generation','validated_generation','dirty','contract_id','release_sha256','native_sha256','profile_native_sha256']),
  business_tables_written:0,historical_certificates_written:0,commit_included:false,native_acceptance:false,application_activation:false});
}
