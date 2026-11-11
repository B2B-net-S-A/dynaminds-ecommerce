/** Source18 -> Source21 for an isolated COPY of an existing209 database.
 * This module only prepares SQL. It does not connect, adopt metadata, update
 * historical certificates, touch business tables, or COMMIT. The operator must
 * compare the complete catalogue and all business rows before and after this
 * plan in the SAME transaction, and retain a rollback-capable original copy.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual as same} from 'node:util';

export const TRANSITION209_SOURCE_PINS=Object.freeze({
 before_contract:'2309bd86da9ac2ecbae38a56a90f0e8a5771fdf3485b4760f5b931c70dc5feeb',
 after_contract:'45c383e6af47e7f3d7ee35e92e91c147094c4bb6b60cd35cbc4a5ab506777bb6',
 sql:'95605368565cbec656fd41db95192879d450d700d13424bb7b575186c447572b',
 sql_bytes:27545803,payload:'ea53884f99cca8a1873f7ffef72279ee032fac3cf51bc8614b587657a7e27d0c',
 payload_bytes:21143856,
 before_fingerprint:'0583690fc87bbb92b77989d2c5ff520cf44a6830273a50dd3e114e122d346b24',
 after_fingerprint:'496cbd23d638ed7420dfb14274f1dd646a5028c269c9bc9f85cd60e85d10efe9',
});
const P=TRANSITION209_SOURCE_PINS,sha=b=>createHash('sha256').update(b).digest('hex');
const prefix='public.order_merge_delivery209_',table=prefix+'projection_basis';
const payloadConstraint=table+'.order_merge_delivery209_projection_basis_payload_check';
const identity=r=>r.kind+'\0'+r.key;
const functions=Object.freeze([
 'public.catalog_header205_valid()', 'public.manual_inventory_off_valid()',
 prefix+'checked_projection_map(selected_fn oid)',prefix+'fingerprint()',
 prefix+'predecessor_descriptor(fn oid)',prefix+'predecessor_descriptor(fn oid, entries jsonb)',
 prefix+'predecessor_metadata(value jsonb)',prefix+'predecessor_metadata(value jsonb, entries jsonb)',
 prefix+'projection_map()','public.ordinary187_valid()',
 'public.partial_sale204_predecessor_definition(fn oid)','public.partial_sale204_valid()',
]);
const additions=Object.freeze([
 prefix+'buyer_guards(manual_basis jsonb)',prefix+'history_operative_valid(manual_basis jsonb)',
 prefix+'history_parents_valid(manual_basis jsonb, wave_ok boolean)',prefix+'history_pim_valid(manual_basis jsonb, wave_ok boolean)',
 prefix+'history_predecessor_project(v jsonb, entries jsonb)',prefix+'predecessor_source_sha(fn oid, entries jsonb)',
 prefix+'validation_snapshot()',prefix+'wave_valid(manual_basis jsonb)',
]);
function contract(value,pin,count){
 // Authenticate the complete source output before selecting any descriptors.
 // These pins identify independently compiled sources, never a live DB digest.
 assert(value&&typeof value==='object'&&!Array.isArray(value),'source-contract-required');
 const text=JSON.stringify(value);assert(Buffer.byteLength(text)<=32*1024*1024,'source-contract-bound');
 assert.equal(sha(text),pin,'fixed-source-contract-required');
 const v=JSON.parse(text);assert.equal(v.schema,'source209-order-merge-delivery-exact-inverse/v1');
 assert.equal(v.additions.length,count);assert.equal(v.changes.length,14);assert.deepEqual(v.removed,[]);
 return v;
}
function records(e){return new Map([...e.additions,...e.changes.map(c=>({kind:c.kind,key:c.key,value:c.after}))].map(r=>[identity(r),r]));}
function bodyOnly(before,after){
 const {source:a,definition:ad,...ah}=before,{source:b,definition:bd,...bh}=after;
 assert(same(ah,bh),'literal-function-header-required');
 assert.equal(ad.split(a).length,2);assert.equal(bd,ad.replace(a,()=>b),'only-function-body-transition');
}
function payload(sql){
 assert(typeof sql==='string'&&Buffer.byteLength(sql)===P.sql_bytes,'fixed-sql-bytes');
 assert.equal(sha(sql),P.sql,'fixed-sql-source-required');
 const marker="INSERT INTO public.order_merge_delivery209_projection_basis(id,payload) VALUES(true,'";
 const first=sql.indexOf(marker);assert(first>=0&&sql.indexOf(marker,first+1)===-1,'one-source-payload');
 const start=first+marker.length,end=sql.indexOf("');\n",start);assert(end>start,'source-payload-terminator');
 const text=sql.slice(start,end).replaceAll("''", "'");
 assert.equal(Buffer.byteLength(text),P.payload_bytes);assert.equal(sha(text),P.payload,'source-payload-pin');
 return text;
}
export function deriveOrderMergeDelivery209RuntimeTransition({beforeContract,afterContract,targetSql}){
 const before=contract(beforeContract,P.before_contract,232),after=contract(afterContract,P.after_contract,240);
 assert.deepEqual(before.changes.map(c=>({kind:c.kind,key:c.key,before:c.before})),after.changes.map(c=>({kind:c.kind,key:c.key,before:c.before})),'same-literal208-predecessor');
 const old=records(before),next=records(after),changed=[],added=[];
 for(const [id,row]of next){const prior=old.get(id);if(!prior)added.push(row);else if(!same(prior,row))changed.push({before:prior,after:row});old.delete(id);}
 assert.equal(old.size,0,'no-metadata-removal');assert.deepEqual(added.map(r=>r.key).sort(),[...additions].sort());
 assert(added.every(r=>r.kind==='function'),'only-eight-new-private-functions');
 assert.deepEqual(changed.filter(r=>r.after.kind==='function').map(r=>r.after.key).sort(),[...functions].sort());
 const checks=changed.filter(r=>r.after.kind!=='function');assert.equal(checks.length,1);assert.equal(checks[0].after.kind,'constraint');assert.equal(checks[0].after.key,payloadConstraint);
 for(const row of changed.filter(r=>r.after.kind==='function'))bodyOnly(row.before.value,row.after.value);
 const {definition:oldCheck,...oldHeader}=checks[0].before.value,{definition:newCheck,...newHeader}=checks[0].after.value;
 assert(same(oldHeader,newHeader)&&newHeader.kind==='c'&&newHeader.validated===true,'literal-check-header');
 assert(typeof oldCheck==='string'&&newCheck.startsWith('CHECK ('),'source-payload-check');
 const data=payload(targetSql),steps=[];
 const step=(label,text,values=[])=>steps.push(Object.freeze({label,text,values:Object.freeze(values)}));
 step('lock-own-metadata',`LOCK TABLE ${table},public.order_merge_delivery209_manifest IN ACCESS EXCLUSIVE MODE`);
 step('source18-precondition',`DO $transition209$ BEGIN
 IF current_user<>'postgres' OR current_user IS DISTINCT FROM session_user
 OR current_setting('session_replication_role')<>'origin'
 OR NOT EXISTS(SELECT FROM public.migrations WHERE name='209_order_merge_delivery_inheritance')
 OR (SELECT count(*) FROM public.order_merge_delivery209_manifest)<>1
 OR (SELECT fingerprint FROM public.order_merge_delivery209_manifest WHERE id) IS DISTINCT FROM '${P.before_fingerprint}'
 OR public.order_merge_delivery209_valid() IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'Intact Source18 copy required' USING ERRCODE='55000'; END IF;
 END $transition209$`);
 for(const r of added){
  assert.equal(r.value.owner,'postgres');assert.equal(r.value.acl_null,false);
  assert.deepEqual(r.value.acl,[{grantor:'postgres',grantee:'postgres',privilege:'EXECUTE',grantable:false}]);
  step('create-private:'+r.key,r.value.definition.trimEnd()+';');
  step('revoke-default-acl:'+r.key,`REVOKE ALL ON FUNCTION ${r.key} FROM PUBLIC,dyna_app`);
 }
 for(const r of changed.filter(r=>r.after.kind==='function'))step('replace-body:'+r.after.key,r.after.value.definition.trimEnd()+';');
 step('replace-source-payload-check',`ALTER TABLE ${table} DROP CONSTRAINT order_merge_delivery209_projection_basis_payload_check; ALTER TABLE ${table} ADD CONSTRAINT order_merge_delivery209_projection_basis_payload_check ${newCheck} NOT VALID`);
 step('open-own-payload',`ALTER TABLE ${table} DISABLE TRIGGER order_merge_delivery209_projection_immutable`);
 step('replace-source-payload',`UPDATE ${table} SET payload=$1 WHERE id RETURNING id`,[data]);
 step('close-own-payload',`ALTER TABLE ${table} ENABLE TRIGGER order_merge_delivery209_projection_immutable`);
 step('validate-source-payload',`ALTER TABLE ${table} VALIDATE CONSTRAINT order_merge_delivery209_projection_basis_payload_check`);
 step('open-own-manifest','ALTER TABLE public.order_merge_delivery209_manifest DISABLE TRIGGER order_merge_delivery209_manifest_immutable');
 // original166 and constraints retain THIS database's historical row bytes,
 // including installation timestamps. Only a source-compiled fingerprint moves.
 step('replace-source-fingerprint','UPDATE public.order_merge_delivery209_manifest SET fingerprint=$1 WHERE id RETURNING id',[P.after_fingerprint]);
 step('close-own-manifest','ALTER TABLE public.order_merge_delivery209_manifest ENABLE TRIGGER order_merge_delivery209_manifest_immutable');
 return Object.freeze({schema:'dynaminds-source209-runtime-transition/v1',from:18,to:21,
  source_pins:P,added_functions:8,changed_functions:12,changed_checks:1,
  business_tables_written:0,historical_certificates_written:0,steps:Object.freeze(steps),
  requires_isolated_copy:true,requires_full_before_catalogue:true,requires_full_after_catalogue:true,
  requires_business_row_preservation:true,requires_full_runtime_guards:true,commit_included:false,
  application_activation:false,native_acceptance:false});
}
