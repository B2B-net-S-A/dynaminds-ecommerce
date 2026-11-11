/** File-only exact source derivation; not a SQL compiler or Native acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {HEADER205_SOURCE_CONTRACT as E205} from '../../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/header205-source-contract.mjs';
import {RECORDS_SQL} from '../../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-catalogue-sql.mjs';
import {deriveOrderMergeDelivery209Bodies,deriveOrderMergeDelivery209FingerprintRecords,assembleOrderMergeDelivery209} from './order-merge-delivery209-source.mjs';
import {deriveOrderMergeDelivery209Predecessor,orderMergeDelivery209SqlSpans,projectOrderMergeDelivery209Source,projectOrderMergeDelivery209Descriptor,projectOrderMergeDelivery209FunctionCheck} from './order-merge-delivery209-predecessor.mjs';
const source166=readFileSync(new URL('../../server/166_buyer_address_sidecar.sql',import.meta.url),'utf8');
const buyer=deriveOrderMergeDelivery209Bodies({source166});
const candidate=deriveOrderMergeDelivery209Predecessor({changes:buyer,source166});
// Frozen actual Source17 producer, not observed catalogue data. Its full emitted
// program pin is checked below. Reuse already-loaded dependency values only.
const source17Producer=gunzipSync(Buffer.from('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','base64'),{maxOutputLength:65536}).toString('utf8');
assert.equal(createHash('sha256').update(source17Producer).digest('hex'),'490a634ede1adcabecee518938d0b8c0ee053aa314d8aee2d0228b50f0a8ac58');
const source17Executable=source17Producer.replace(/^import[^\n]*;\n/gm,'').replace(/\bexport function\b/g,'function');assert(!/^\s*import /m.test(source17Executable));
const source17Derive=Function('assert','createHash','E205','RECORDS_SQL','deriveOrderMergeDelivery209Bodies',source17Executable+';return deriveOrderMergeDelivery209Predecessor;')(assert,createHash,E205,RECORDS_SQL,deriveOrderMergeDelivery209Bodies);
const source17Candidate=source17Derive({changes:buyer,source166});
const historicalSql=candidate.sql.replace(/(\$checked209\$|\$local_descriptor209\$|\$local_metadata209\$)([\s\S]*?)\1/g,(_all,tag)=>tag+source17Candidate.sql.split(tag)[1]+tag);

const sha=v=>createHash('sha256').update(v).digest('hex');
const liveFunctionQuery=RECORDS_SQL.split('\n').find(s=>s.startsWith(" UNION ALL SELECT 'function',")).replace(/^ UNION ALL /,'').replace("WHERE n.nspname IN ('public','ordinary187_private')",'WHERE p.oid=fn');
const textLeaf=expression=>"jsonb_build_array('sha256-utf8-text/v1',encode(sha256(convert_to("+expression+",'UTF8')),'hex'))";
const checkFunctionQuery=liveFunctionQuery.replace("'source',p.prosrc","'source',"+textLeaf('p.prosrc')).replace("'definition',pg_catalog.pg_get_functiondef(p.oid)","'definition',"+textLeaf('pg_catalog.pg_get_functiondef(p.oid)'));
const inlineCompactWanted="FROM generate_series(1,10) ordinal(value)\n  CROSS JOIN LATERAL(SELECT ordinal.value ordinal,jsonb_build_object('key',jsonb_extract_path(entries,(ordinal.value-1)::text,'key'),'after_check',jsonb_extract_path(entries,(ordinal.value-1)::text,'after_check')) entry) wanted";
const compactSelect='SELECT wanted.entry,bindings.total,bindings.member_oid,projected.key,projected.value,wanted.ordinal';
const compactWanted="WITH wanted AS MATERIALIZED(\n   SELECT ordinal.value ordinal,jsonb_build_object('key',jsonb_extract_path(entries,(ordinal.value-1)::text,'key'),'after_check',jsonb_extract_path(entries,(ordinal.value-1)::text,'after_check')) entry\n   FROM generate_series(1,10) ordinal(value)\n  )\n  "+compactSelect+'\n  FROM wanted';
const recordsetWanted="WITH wanted AS MATERIALIZED(\n   SELECT a.ordinal::integer ordinal,jsonb_build_object('key',a.key,'after_check',a.after_check) entry\n   FROM ROWS FROM(jsonb_to_recordset(entries) AS(key text,after_check jsonb)) WITH ORDINALITY AS a(key,after_check,ordinal)\n  )\n  "+compactSelect+'\n  FROM wanted';
const reverseRecordsetWanted=(body,tag)=>{
 if(tag==='local_descriptor209')return body;
 assert.equal(body.split(recordsetWanted).length,2,'exactly one complete typed extraction block per validator');
 return body.replace(recordsetWanted,compactWanted);
};
const reverseMaterializedWanted=(body,tag)=>{
 body=reverseRecordsetWanted(body,tag);
 if(tag==='local_descriptor209')return body;
 assert.equal(body.split(compactWanted).length,2,'only the exact four compact extraction CTEs are reversed');
 return body.replace(compactWanted,compactSelect+'\n  '+inlineCompactWanted);
};
const oldBindingValidation=(selected='')=>`-- Validate ALL10 current bindings before returning any projected descriptor.
 FOR entry IN SELECT value FROM jsonb_array_elements(entries) LOOP
  SELECT count(*),min(p.oid::bigint)::oid INTO total,member_oid FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND 'public.'||p.proname=split_part(entry->>'key','(',1);
  IF total<>1 THEN RAISE EXCEPTION '209 complete predecessor scope required' USING ERRCODE='55000';END IF;
  SELECT key,value INTO actual_key,live FROM(${liveFunctionQuery.replace('WHERE p.oid=fn','WHERE p.oid=member_oid')}) projected(kind,key,value);
  IF actual_key IS DISTINCT FROM entry->>'key' OR live IS DISTINCT FROM entry->'after'
   THEN RAISE EXCEPTION '209 exact complete successor descriptor required' USING ERRCODE='55000';END IF;${selected?'\n  '+selected:''}
 END LOOP;`;

const reverseNestedExtraction=(body,tag)=>{
 body=reverseMaterializedWanted(body,tag);
 if(tag==='local_descriptor209'){
  // The measured literal193 selected-entry path is already restored.
  return body;
 }else{
  assert.equal(body.split(inlineCompactWanted).length,2,'exactly one known compact binding extraction is reversed');
  body=body.replace(inlineCompactWanted,'FROM jsonb_array_elements(entries) WITH ORDINALITY wanted(entry,ordinal)');
  if(tag==='descriptor209'){
   const current="selected_before:=jsonb_extract_path(entries,(binding_ordinal-1)::text,'before');";
   assert.equal(body.split(current).length,2);body=body.replace(current,"selected_before:=entry->'before';");
  }
 }
 return body;
};

test('actual four source-derived buyer changes produce exactly six complete205 successors without changing old inputs',()=>{
 assert.equal(candidate.changes.length,6);assert.deepEqual(candidate.changes.map(c=>c.key),[...E205.changes.map(c=>c.key),'public.catalog_header205_valid()']);
 assert.equal(candidate.helper_keys.length,6);assert.equal(candidate.source_compilation_performed,false);assert.equal(candidate.application_activation,false);assert.equal(candidate.native_certification,false);
 const expected=[...E205.changes.map(c=>c.after),E205.additions[0].value];
 for(let i=0;i<expected.length;i++){
  const c=candidate.changes[i];assert.deepEqual(c.before,expected[i]);
  const {source,definition,...header}=c.after,{source:oldSource,definition:oldDefinition,...oldHeader}=c.before;
  assert.deepEqual(header,oldHeader,'No header/ACL/security/owner changes');assert.notEqual(sha(source),sha(oldSource));
  assert.equal(definition,oldDefinition.replace(oldSource,()=>source));
 }
});

test('all literal/comment historical bytes remain exact in every real205 function, including deeply nested old definitions',()=>{
 for(const c of candidate.changes){
  const before=orderMergeDelivery209SqlSpans(c.before.source),after=orderMergeDelivery209SqlSpans(c.after.source);
  assert.deepEqual(after.filter(x=>!x.executable).map(x=>x.text),before.filter(x=>!x.executable).map(x=>x.text),c.key+' historical evidence unchanged');
  const exec=after.filter(x=>x.executable).map(x=>x.text).join(' ');
  assert(!/\b(?:[a-z_]+\.)?prosrc\b/i.test(exec),'No unprojected source read');
  assert(!/\bpg_get_functiondef\s*\(/i.test(exec),'No unprojected complete definition read');
 }
 const ordinary=candidate.projection_counts.find(c=>c.key==='public.ordinary187_valid()');assert.equal(ordinary.metadata_reads,2);
 const direct=candidate.projection_counts.find(c=>c.key==='public.partial_sale204_valid()');assert.equal(direct.source_reads,1,'Direct36 hash aggregation is actually projected');
});

test('SQL lexer preserves doubled/E strings, dollar literals, nested comments and quoted identifiers while transforming actual source reads',()=>{
 const source=`SELECT p.prosrc,pg_get_functiondef(p.oid),public.large_import173_metadata();\n-- prosrc pg_get_functiondef(x)\n/* outer /* prosrc */ pg_get_functiondef(x) */\nSELECT 'prosrc ''pg_get_functiondef(x)''',E'escaped\\\' prosrc',"prosrc",$old$prosrc pg_get_functiondef(x)$old$,q.prosrc;`;
 const projected=projectOrderMergeDelivery209Source(source);
 assert.equal(projected.counts.source_reads,2);assert.equal(projected.counts.definition_reads,1);assert.equal(projected.counts.metadata_reads,1);
 assert.deepEqual(orderMergeDelivery209SqlSpans(projected.source).filter(x=>!x.executable).map(x=>x.text),orderMergeDelivery209SqlSpans(source).filter(x=>!x.executable).map(x=>x.text));
 for(const invalid of ["SELECT 'unfinished",'SELECT $$unfinished','SELECT /* unfinished'])assert.throws(()=>orderMergeDelivery209SqlSpans(invalid));
});

test('descriptor projection rejects before/mixed/changed header/source/ACL, missing row and overload instead of adopting caller metadata',()=>{
 const changes=[...buyer,...candidate.changes],records=changes.map(c=>({kind:'function',key:c.key,value:structuredClone(c.after)}));
 for(const c of changes)assert.deepEqual(projectOrderMergeDelivery209Descriptor(records,changes,c.key),c.before);
 const selected=changes.find(c=>c.key==='public.partial_sale204_predecessor_definition(fn oid)');assert(selected);
 for(const mutate of [
  rows=>{rows.find(r=>r.key===selected.key).value=structuredClone(selected.before);},
  rows=>{rows.find(r=>r.key===selected.key).value.source+='\n';},
  rows=>{rows.find(r=>r.key===selected.key).value.security_definer=false;},
  rows=>{rows.find(r=>r.key===selected.key).value.acl=[];},
  rows=>{rows.push({...structuredClone(rows.find(r=>r.key===selected.key)),key:'public.partial_sale204_predecessor_definition(fn text)'});},
  rows=>{rows.splice(rows.findIndex(r=>r.key===selected.key),1);},
  rows=>{rows.find(r=>r.key===buyer[0].key).value=structuredClone(buyer[0].before);},
 ]){const changed=structuredClone(records);mutate(changed);assert.throws(()=>projectOrderMergeDelivery209Descriptor(changed,changes,selected.key));}
});

test('generated ordinary projectors are exact AFTER-only, full-reader based, nonrecursive in authority and revoked from application callers',()=>{
 const sql=candidate.sql;
 for(const token of ['SELECT key,value INTO actual_key,live','actual_key IS DISTINCT FROM entry','live IS DISTINCT FROM entry','RETURN selected_before','p.proallargtypes','p.protrftypes','p.prosqlbody'])assert(sql.includes(token),token);
 assert(!sql.includes('OR live IS NOT DISTINCT FROM entry->\'before\''));
 assert(sql.includes('Validate ALL10'));assert(!sql.includes('PERFORM public.order_merge_delivery209_predecessor_descriptor(fn)'));
 const descriptor=sql.slice(sql.indexOf('CREATE FUNCTION public.order_merge_delivery209_predecessor_descriptor('),sql.indexOf('CREATE FUNCTION public.order_merge_delivery209_predecessor_definition('));
 const guard=descriptor.indexOf('public.order_merge_delivery209_valid() IS DISTINCT FROM true'),batch=descriptor.indexOf('FOR entry,total,member_oid,actual_key,live,binding_ordinal IN');
 assert(guard>=0&&batch>guard,'Fresh complete metadata admission precedes the batch, with both boundaries present');
 for(const name of candidate.helper_keys)assert(sql.includes('REVOKE ALL ON FUNCTION '+name));
 assert(!sql.includes('UPDATE public.buyer_address_manifest'));assert(!sql.includes('UPDATE public.ordinary187_'));assert(!sql.includes('set_config('));
 // Sources of six successors refer to fixed helper names, never to its body/hash; no self-digest cycle.
 for(const c of candidate.changes)assert(!c.after.source.includes('public.order_merge_delivery209_projection_map()'));
});

test('six sealed invocations acquire one fresh local frame and all190 reads use it without a session cache',()=>{
 let reads=0;
 for(const c of candidate.changes){
  const executable=orderMergeDelivery209SqlSpans(c.after.source).filter(s=>s.executable).map(s=>s.text).join(' ');
  const captures=[...executable.matchAll(/merge_delivery209_local_frame:=public\.order_merge_delivery209_checked_projection_map\((fn)?\);/g)];
  assert.equal(captures.length,1);assert.equal(captures[0][1],c.key.includes('predecessor_definition')?'fn':undefined);
  assert.match(executable,/BEGIN\s+merge_delivery209_local_frame:=/i);
  assert.equal([...executable.matchAll(/merge_delivery209_local_frame\s*:=/g)].length,1);
  const projected=[...executable.matchAll(/order_merge_delivery209_predecessor_(source|definition|metadata)\(/g)];
  reads+=projected.length;
  assert.equal(projected.length,candidate.projection_counts.find(x=>x.key===c.key).source_reads+candidate.projection_counts.find(x=>x.key===c.key).definition_reads+candidate.projection_counts.find(x=>x.key===c.key).metadata_reads);
  for(const match of projected){const rest=executable.slice(match.index);assert.match(rest,/^[^(]+\((?:(?:p|q)\.)?oid, merge_delivery209_local_frame\)|^[^(]+\(fn, merge_delivery209_local_frame\)|^[^(]+\(public\.large_import173_(?:metadata|predecessor_map)\(\), merge_delivery209_local_frame\)/);}
  assert(!executable.includes('set_config('));
 }
 assert.equal(reads,190);
 const checked=candidate.sql.split('$checked209$')[1];
 assert(checked.indexOf('THEN RETURN NULL;END IF')<checked.indexOf('public.order_merge_delivery209_valid()'),'unscoped fn identity does not construct a frame');
 assert(checked.includes("live IS DISTINCT FROM entry->'after_check'"));assert(checked.includes('Validate ALL10'));
 for(const signature of ['checked_projection_map(oid)','predecessor_descriptor(oid,jsonb)','predecessor_definition(oid,jsonb)','predecessor_source(oid,jsonb)','predecessor_metadata(jsonb,jsonb)'])assert(candidate.sql.includes('REVOKE ALL ON FUNCTION public.order_merge_delivery209_'+signature+' FROM PUBLIC,dyna_app;'));
 const local=candidate.sql.split('$local_descriptor209$')[1];
 assert(local.indexOf('RETURN live;')<local.indexOf('jsonb_typeof(entries)'));
 assert(local.includes("live IS DISTINCT FROM entry->'after_check'"));assert(local.includes('IF total<>1'));
 assert(!local.includes('jsonb_array_elements(entries)'),'selected lookup does not materialize every large descriptor');
 for(const[c,index]of [...buyer,...candidate.changes].map((c,i)=>[c,i]))assert(local.includes("WHEN '"+c.key+"' THEN entries->"+index));
 assert(local.includes("entry->>'key' IS DISTINCT FROM actual_key"),'index and full identity must agree');
});

test('outside exact ten names identity projection preserves every actual metadata field even when209 bindings drift',()=>{
 const changes=[...buyer,...candidate.changes];
 const before={language:'plpgsql',source:' RETURN false; -- actual changed body',definition:'actual changed definition',acl:[{grantee:'PUBLIC',privilege:'EXECUTE'}],owner:'postgres',cost:7};
 const key='public.fa3_draft_fingerprint()',record={kind:'function',key,value:before};
 // Deliberately no valid209 records: no inverse is performed, so no trust is conferred.
 assert.deepEqual(projectOrderMergeDelivery209Descriptor([record],changes,key),before);
 assert.notEqual(projectOrderMergeDelivery209Descriptor([record],changes,key),before);
 const nearKey='public.buyer_address_guards_extra()';
 assert.deepEqual(projectOrderMergeDelivery209Descriptor([{...record,key:nearKey}],changes,nearKey),before);
 assert.throws(()=>projectOrderMergeDelivery209Descriptor([],changes,key));
 const scopedKey=changes[0].key;
 assert.throws(()=>projectOrderMergeDelivery209Descriptor([{...record,key:scopedKey}],changes,scopedKey),'matching name still validates all ten');
 const rows=changes.map(c=>({kind:c.kind,key:c.key,value:structuredClone(c.after)}));
 const overload=scopedKey.replace('()','(extra text)');rows.push({...record,key:overload});
 assert.throws(()=>projectOrderMergeDelivery209Descriptor(rows,changes,overload),'any matching name, including overload, refuses drift');
});

test('emitted unchanged descriptor and metadata identity paths precede expensive authority/map work; scoped paths remain complete',()=>{
 const sql=candidate.sql;
 const descriptor=sql.slice(sql.indexOf('CREATE FUNCTION public.order_merge_delivery209_predecessor_descriptor('),sql.indexOf('CREATE FUNCTION public.order_merge_delivery209_predecessor_definition('));
 const metadata=sql.slice(sql.indexOf('CREATE FUNCTION public.order_merge_delivery209_predecessor_metadata('),sql.indexOf('REVOKE ALL ON FUNCTION'));
 const names=[...buyer,...candidate.changes].map(c=>c.key.slice(7,c.key.indexOf('(')));
 assert.equal(names.length,10);
 for(const name of names){assert(descriptor.includes("'"+name+"'"));assert(metadata.includes("'"+name+"'"));}
 assert(descriptor.includes("n.nspname='public' AND p.proname=ANY(ARRAY["));
 const actualReturn=descriptor.indexOf('RETURN live;'),guard=descriptor.indexOf('public.order_merge_delivery209_valid()');
 assert(actualReturn>0&&actualReturn<guard,'return full unmodified live metadata before209 checks');
 assert(descriptor.indexOf('SELECT count(*) OVER(),id,payload IS NOT NULL')>guard);
 assert.match(descriptor,/actual_key IS DISTINCT FROM entry->>'key' OR live IS DISTINCT FROM entry->'after_check'/);
 const identityReturn=metadata.indexOf('THEN RETURN value;END IF;'),metadataGuard=metadata.indexOf('public.order_merge_delivery209_valid()');
 assert(identityReturn>0&&identityReturn<metadataGuard,'original JSON value returned before map parsing');
 assert(metadata.includes('WHERE strpos(result,name)>0'),'name occurrence is conservative, not an acceptance flag');
 assert.equal(metadata.match(/SELECT count\(\*\) OVER\(\),id,payload IS NOT NULL/g)?.length,1,'one fresh generated-row read for relevant metadata');
 assert(!metadata.includes('predecessor_descriptor('),'no second parse through nested descriptor');
 for(const body of [descriptor,metadata]){
  assert(body.includes(recordsetWanted));
  assert(body.includes("IF total IS DISTINCT FROM 1 THEN RAISE EXCEPTION"));
  assert(body.includes("live IS DISTINCT FROM entry->'after_check'"));
  assert(!body.includes('set_config('));
 }
});

test('all four text readers return actual unscoped pg_proc text before any full JSON descriptor, with missing OID refusal',()=>{
 const names=[...buyer,...candidate.changes].map(c=>c.key.slice(7,c.key.indexOf('(')));
 for(const local of [false,true])for(const field of ['source','definition']){
  const tag=(local?'local_':'')+(field==='source'?'source209':'definition209');
  const parts=candidate.sql.split('$'+tag+'$');assert.equal(parts.length,3,tag);
  const body=parts[1];
  const expectedScope="SELECT n.nspname='public' AND p.proname=ANY(ARRAY["+names.map(n=>"'"+n+"'").join(',')+"]::text[]) INTO scoped FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE p.oid=fn;";
  assert(body.includes(expectedScope),'PUBLIC plus exact names: overloads remain scoped, lookalike/foreign names do not');
  const missing="IF NOT FOUND THEN RAISE EXCEPTION '209 missing unchanged function' USING ERRCODE='55000';END IF;";
  assert.equal(body.split(missing).length-1,2,'Missing/NULL OID is refused on both actual reads, never returned as a successful null');
  const raw=field==='source'?'p.prosrc':'pg_catalog.pg_get_functiondef(p.oid)';
  const expectedIdentity=`IF scoped IS DISTINCT FROM true THEN
  -- Identity text only: preserve current bytes, without JSON expansion or admission.
  SELECT ${raw} INTO actual FROM pg_catalog.pg_proc p WHERE p.oid=fn;
  ${missing}
  RETURN actual;
 END IF;`;
  assert(body.includes(expectedIdentity),'unchanged text is returned without a transformation');
  const strictReturn=`RETURN public.order_merge_delivery209_predecessor_descriptor(fn${local?',entries':''})->>'${field}';`;
  assert(body.includes(strictReturn));assert(body.indexOf('RETURN actual;')<body.indexOf(strictReturn));
  const identity=body.slice(0,body.indexOf(strictReturn));
  for(const expensive of ['jsonb_build','jsonb_array','projection_map(','order_merge_delivery209_valid(','predecessor_descriptor(','replace(','sha256(','convert_to('])assert(!identity.includes(expensive),expensive+' must not run on identity text reads');
  assert.equal(body.split('predecessor_descriptor(').length-1,1,'all scoped reads delegate exactly once to the existing full-descriptor validator');
  assert.match(parts[0].slice(parts[0].lastIndexOf('CREATE FUNCTION')),new RegExp('predecessor_'+field+'\\(fn oid'+(local?',entries jsonb':'')+'\\) RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $'));
 }
});

test('Source17 historical generated reads retain their complete predecessor source-byte witnesses',()=>{
 // Independently captured from the reviewed pre-optimization generator. These
 // complete bodies include the full reader, exact AFTER comparisons and ACL
 // shape checks; a raw text shortcut must not weaken those separate APIs.
 const expected={
  descriptor209:'b326c18e00bae10ecc029ab6b3b398020e5cf95be2c3d9b6c4377fcd4c942ac0',
  local_descriptor209:'f25e051da9db1a743d5a93bb2d42cf4bfbb777700bbeea0537be5d9a2428dc43',
  checked209:'44968a13bacacbb447390dbfabd50ad817ff2e5836bd940557c504ab1123ff04',
  metadata209:'3f19e5dcaaf10aa3bbaf6d1b70c030e7333b893a889b91bba4ac0b0582d4baaf',
  local_metadata209:'db02dce3a388dbc4bbf4c05eb15815fd7d2f05006200a00388984034f595f608',
 };
 for(const [tag,digest] of Object.entries(expected)){
  let body=reverseNestedExtraction(historicalSql.split('$'+tag+'$')[1],tag);
  if(tag==='local_descriptor209'){
   const names=[...buyer,...candidate.changes].map(c=>c.key.slice(7,c.key.indexOf('(')));
   const scope=" SELECT n.nspname='public' AND p.proname=ANY(ARRAY["+names.map(n=>"'"+n+"'").join(',')+"]::text[]) INTO scoped FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE p.oid=fn;\n";
   const missing="IF live IS NULL THEN RAISE EXCEPTION '209 missing unchanged function' USING ERRCODE='55000';END IF;";
   const current=scope+" IF scoped IS DISTINCT FROM true THEN\n  SELECT key,value INTO actual_key,live FROM("+liveFunctionQuery+") projected(kind,key,value);\n  "+missing+"\n  RETURN live;\n END IF;\n SELECT key,value INTO actual_key,live FROM("+checkFunctionQuery+") projected(kind,key,value);\n "+missing+'\n';
   const previous=" SELECT key,value INTO actual_key,live FROM("+liveFunctionQuery+") projected(kind,key,value);\n "+missing+'\n'+scope+' IF scoped IS DISTINCT FROM true THEN RETURN live;END IF;\n';
   assert.equal(body.split(current).length,2,'only selected verification uses compact text leaves; unscoped full identity stays literal');
   body=body.replace(current,previous).replace("live IS DISTINCT FROM entry->'after_check'","live IS DISTINCT FROM entry->'after'");
  }
  if(['descriptor209','checked209','metadata209','local_metadata209'].includes(tag)){
   const variables='binding_ordinal integer;validated integer;';
   assert.equal(body.split(variables).length,2);body=body.replace(variables,'');
   const start=body.indexOf('-- Validate ALL10 current bindings'),last=" IF validated<>10 THEN RAISE EXCEPTION '209 complete predecessor scope required' USING ERRCODE='55000';END IF;";
   const end=body.indexOf(last,start)+last.length;assert(start>=0&&end>start);
   body=body.slice(0,start)+oldBindingValidation(tag==='descriptor209'?"IF member_oid=fn THEN selected_before:=entry->'before';END IF;":'')+body.slice(end);
  }
  if(['descriptor209','checked209','metadata209'].includes(tag)){
   const variables='source_id boolean;payload_present boolean;payload_bytes integer;payload_hash text;';
   assert.equal(body.split(variables).length,2);body=body.replace(variables,'');
   const encoding="current_setting('server_encoding') IS DISTINCT FROM 'UTF8' OR ";
   assert.equal(body.split(encoding).length,2);body=body.replace(encoding,'');
   const rowRead="SELECT count(*) OVER(),id,payload IS NOT NULL,payload_octets,payload_sha256,payload_jsonb INTO total,source_id,payload_present,payload_bytes,payload_hash,entries FROM public.order_merge_delivery209_projection_basis;\n IF total IS DISTINCT FROM 1 OR source_id IS DISTINCT FROM true OR payload_present IS DISTINCT FROM true OR entries IS NULL\n  OR payload_bytes IS DISTINCT FROM "+candidate.projection_basis.bytes+" OR payload_hash IS DISTINCT FROM '"+candidate.projection_basis.sha256+"'\n  THEN RAISE EXCEPTION '209 exact source projection basis required' USING ERRCODE='55000';END IF;";
   assert.equal(body.split(rowRead).length,2);
   body=body.replace(rowRead,'entries:=public.order_merge_delivery209_projection_map();');
  }
  assert.equal(sha(body),digest,tag+' all unrelated source bytes remain literal');
 }
 assert.deepEqual(candidate.projection_counts.map(c=>[c.source_reads,c.definition_reads,c.metadata_reads]),[
  [9,1,0],[7,1,0],[70,2,0],[83,0,2],[1,0,0],[14,0,0],
 ]);
 for(const c of candidate.changes){
  assert.deepEqual(orderMergeDelivery209SqlSpans(c.after.source).filter(s=>!s.executable).map(s=>s.text),orderMergeDelivery209SqlSpans(c.before.source).filter(s=>!s.executable).map(s=>s.text));
 }
});

test('exactly three sealed generated reads keep their own fresh validation and all ten current bindings; direct map remains independently protected',()=>{
 const direct=candidate.sql.split('$map209$')[1];
 const directRead=direct.slice(direct.indexOf('SELECT count(*) OVER()'),direct.indexOf('\n RETURN parsed_value;'));
 assert(direct.includes('public.order_merge_delivery209_valid()'));
 for(const tag of ['descriptor209','metadata209','checked209']){
  const body=candidate.sql.split('$'+tag+'$')[1];
  assert.equal(body.split('public.order_merge_delivery209_valid()').length-1,1,'one fresh full metadata validation per sealed invocation');
  assert(!body.includes('projection_map()'),'no redundant independent map validation is dispatched');
  const read=tag==='checked209'?body.slice(body.indexOf('SELECT count(*) OVER(),id,payload IS NOT NULL'),body.indexOf(' SELECT jsonb_agg(')):directRead.replaceAll('parsed_value','entries');assert(read.length>0);if(tag!=='checked209')assert.equal(body.split(read).length-1,1,'same count/id/NULL/generatedbytes/SHA row checks as independently protected map');else{assert(read.includes('projection_keys,projection_checks'));assert(!read.includes('payload_jsonb'));assert(read.includes("jsonb_array_length(source_keys)<>10"));assert(read.includes("jsonb_array_length(source_checks)<>10"));}
  assert(body.indexOf('public.order_merge_delivery209_valid()')<body.indexOf(read));
  assert(body.indexOf(read)<body.indexOf('Validate ALL10 current bindings'));
  assert(body.includes('source_id boolean;payload_present boolean;payload_bytes integer;payload_hash text;'));
  assert(body.includes("current_setting('server_encoding') IS DISTINCT FROM 'UTF8'"));
  for(const token of ['IF total IS DISTINCT FROM 1','live IS DISTINCT FROM entry->\'after_check\'',recordsetWanted])assert(body.includes(token));
 }
 assert(!candidate.sql.includes('unchecked_projection'));assert(!candidate.sql.includes('set_config('));
 // No new routine/capability is introduced by source-template reuse.
 assert.equal((candidate.sql.match(/CREATE FUNCTION public\.order_merge_delivery209_/g)??[]).length,10);
});

test('all four binding validators batch one canonical current descriptor query without dropping missing or overloaded entries',()=>{
 const keys=[...buyer,...candidate.changes].map(c=>c.key);
 const expectedKeys='ARRAY['+keys.map(k=>"'"+k+"'").join(',')+']::text[]';
 const completeQuery=checkFunctionQuery.replace('WHERE p.oid=fn','WHERE bindings.total=1 AND p.oid=bindings.member_oid');
 for(const tag of ['descriptor209','metadata209','checked209','local_metadata209']){
  const body=candidate.sql.split('$'+tag+'$')[1],start=body.indexOf('-- Validate ALL10'),end=body.indexOf(' IF validated<>10',start),batch=body.slice(start,end);
  assert(batch.includes("IF jsonb_typeof(entries) IS DISTINCT FROM 'array' OR jsonb_array_length(entries)<>10"));
  assert.equal(batch.split('FOR entry,total,member_oid,actual_key,live,binding_ordinal IN').length-1,1);
  assert.equal(batch.split(recordsetWanted).length-1,1);
  assert(batch.includes("CROSS JOIN LATERAL(\n   SELECT count(*) total,min(p.oid::bigint)::oid member_oid FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND 'public.'||p.proname=split_part(wanted.entry->>'key','(',1)\n  ) bindings"));
  assert(batch.includes('LEFT JOIN LATERAL('+completeQuery+') projected(kind,key,value) ON true'),'the complete ordinary RECORDS_SQL descriptor is bound to counted currentOID, only when count=1');
  assert(batch.includes("entry->>'key' IS DISTINCT FROM ("+expectedKeys+')[binding_ordinal]'));
  assert(batch.includes('IF binding_ordinal NOT BETWEEN 1 AND 10'));
  const loop=batch.slice(batch.lastIndexOf('\n LOOP'));
  assert(!loop.includes('SELECT '),'no per-entry SPI descriptor or count queries remain');
  assert(loop.includes('IF total IS DISTINCT FROM 1'));assert(loop.includes("actual_key IS DISTINCT FROM entry->>'key' OR live IS DISTINCT FROM entry->'after_check'"));
  assert(body.includes("IF validated<>10 THEN RAISE EXCEPTION"));
  assert(!batch.includes('ORDER BY wanted'));assert(!batch.includes('ORDER BY binding_ordinal'),'no wide entry sort is introduced');
  if(tag==='descriptor209')assert(loop.indexOf('IF member_oid=fn THEN selected_before')>loop.indexOf("live IS DISTINCT FROM entry->'after_check'"));
 }
});

test('source-key ordinal roster refuses malformed, missing, duplicate, substituted or reordered frames',()=>{
 const keys=[...buyer,...candidate.changes].map(c=>c.key);
 const roster=entries=>Array.isArray(entries)&&entries.length===10&&entries.every((entry,i)=>entry&&entry.key===keys[i]);
 const valid=keys.map(key=>({key}));assert(roster(valid));
 for(const invalid of [null,{},'array',[],valid.slice(1),[...valid,valid[0]],valid.map((e,i)=>i===9?valid[0]:e),valid.map((e,i)=>i===3?{key:keys[3]+'extra'}:e),valid.map((e,i)=>i===2?{}:e),valid.map((e,i)=>i===2?null:e),[valid[1],valid[0],...valid.slice(2)]])assert(!roster(invalid));
 // This pure roster oracle is linked to the emitted SQL checks above; it is
 // not evidence of PostgreSQL parsing, execution or Native acceptance.
});

test('source-authored after_check preserves every current header field and tags only complete UTF8 text leaves',()=>{
 const source='Łódź 😀 e\u0301\n\\123',definition='CREATE FUNCTION café() RETURNS text AS $$'+source+'$$ LANGUAGE sql;';
 const input={...structuredClone(buyer[0].after),source,definition};
 const actual=projectOrderMergeDelivery209FunctionCheck(input),expected=structuredClone(input);
 expected.source=['sha256-utf8-text/v1','3deb8fc66c573f8c403537d57befb393e5d3759be3dafe6a42808a9c391e77ba'];
 expected.definition=['sha256-utf8-text/v1','9674609b224be29f5950816cfde7c8f78d573e17825169bc56dc1476a9db98db'];
 assert.deepEqual(actual,expected,'Independent Python hashlib UTF8 vectors include combining text, nonASCII, astral bytes and literal escapes');
 assert.equal(input.source,source);assert.equal(input.definition,definition,'Projection never mutates source-owned descriptor');
 assert.deepEqual(Object.keys(actual),Object.keys(input));
 for(const key of Object.keys(input).filter(k=>!['source','definition'].includes(k))){
  const changed=structuredClone(input);changed[key]=['unexpected-current-field',key];
  assert.notDeepEqual(projectOrderMergeDelivery209FunctionCheck(changed),actual,'No metadata field may be dropped: '+key);
  delete changed[key];assert.notDeepEqual(projectOrderMergeDelivery209FunctionCheck(changed),actual,'Missing current header remains distinct: '+key);
 }
 const extra={...input,unexpected_current_header:null};assert.notDeepEqual(projectOrderMergeDelivery209FunctionCheck(extra),actual);
 for(const change of [v=>v+' ',v=>v.replace('e\u0301','é'),v=>v+'\r\n',v=>v.replace('\\123','\\124')])for(const field of ['source','definition']){
  const changed={...input,[field]:change(input[field])};assert.notDeepEqual(projectOrderMergeDelivery209FunctionCheck(changed),actual,'Complete raw text drift cannot normalize away: '+field);
 }
});

test('NULL text tags remain distinct from empty/text-null and reject missing, nontext or invalid UTF8 leaves',()=>{
 const descriptor={owner:'postgres',source:null,definition:null,config:null,cost:100};
 const checked=projectOrderMergeDelivery209FunctionCheck(descriptor);
 assert.deepEqual(checked,{owner:'postgres',source:['sha256-utf8-text/v1',null],definition:['sha256-utf8-text/v1',null],config:null,cost:100});
 for(const field of ['source','definition'])for(const text of ['','null','NULL'])assert.notDeepEqual(projectOrderMergeDelivery209FunctionCheck({...descriptor,[field]:text}),checked);
 for(const field of ['source','definition']){
  const missing={...descriptor};delete missing[field];assert.throws(()=>projectOrderMergeDelivery209FunctionCheck(missing));
  for(const invalid of [undefined,0,false,{},[],String.fromCharCode(0xd800)])assert.throws(()=>projectOrderMergeDelivery209FunctionCheck({...descriptor,[field]:invalid}));
 }
 for(const invalid of [null,[],0,'descriptor'])assert.throws(()=>projectOrderMergeDelivery209FunctionCheck(invalid));
});

test('immutable map expected checks derive from each exact source AFTER, while full historical descriptors remain available',()=>{
 const inserted=/INSERT INTO public\.order_merge_delivery209_projection_basis\(id,payload\) VALUES\(true,'([\s\S]*)'\);\n$/.exec(candidate.preambleSql);assert(inserted);
 const entries=JSON.parse(inserted[1].replaceAll("''","'")),changes=[...buyer,...candidate.changes];assert.equal(entries.length,10);
 for(let i=0;i<changes.length;i++){
  const entry=entries[i],change=changes[i];assert.deepEqual(Object.keys(entry),['key','before','after','after_check']);
  assert.equal(entry.key,change.key);assert.deepEqual(entry.before,change.before);assert.deepEqual(entry.after,change.after);
  const expected={...change.after,source:['sha256-utf8-text/v1',sha(change.after.source)],definition:['sha256-utf8-text/v1',sha(change.after.definition)]};
  assert.deepEqual(entry.after_check,expected);assert.deepEqual(projectOrderMergeDelivery209FunctionCheck(change.after),expected);
 }
 const local=candidate.sql.split('$local_descriptor209$')[1];
 assert(local.includes('SELECT key,value INTO actual_key,live FROM('+checkFunctionQuery+') projected(kind,key,value);'));
 assert(local.indexOf('RETURN live;')<local.indexOf('FROM('+checkFunctionQuery+')'),'Unscoped raw identity returns the ordinary full descriptor before selected verification');
 assert(local.includes("live IS DISTINCT FROM entry->'after_check'"));assert(local.includes('RETURN selected_before;'));
 for(const tag of ['metadata209','local_metadata209']){
  const body=candidate.sql.split('$'+tag+'$')[1];assert(body.includes("after_value:=entry->'after'->>field;before_value:=entry->'before'->>field;"),'Historical replacements use complete original text, not a digest');
 }
 for(const token of ['coalesce(','substr(','left(','current_setting(','set_config('])assert(!checkFunctionQuery.includes(token)||liveFunctionQuery.includes(token),'No new lossy projection or caller-controlled authority');
});

test('large literal map is immutable owner-only table DATA; the small STABLE reader verifies current metadata and derived row every time',()=>{
 const p=candidate.preambleSql,s=candidate.sql,b=candidate.projection_basis;
 for(const text of ['CREATE TABLE public.order_merge_delivery209_projection_basis','payload text NOT NULL CHECK','PRIMARY KEY DEFAULT true CHECK(id)','FORCE ROW LEVEL SECURITY','TO postgres USING(true) WITH CHECK(true)','REVOKE ALL ON public.order_merge_delivery209_projection_basis FROM PUBLIC,dyna_app','BEFORE UPDATE OR DELETE','BEFORE TRUNCATE'])assert(p.includes(text),text);
 const match=/INSERT INTO public\.order_merge_delivery209_projection_basis\(id,payload\) VALUES\(true,'([\s\S]*)'\);\n$/.exec(p);assert(match);
 const payload=match[1].replaceAll("''","'");assert.equal(Buffer.byteLength(payload),b.bytes);assert.equal(sha(payload),b.sha256);
 const parsed=JSON.parse(payload);assert.equal(parsed.length,10);assert.deepEqual(parsed.map(x=>x.key),[...buyer,...candidate.changes].map(x=>x.key));
 const open=s.indexOf('$map209$'),end=s.indexOf('$map209$',open+8),body=s.slice(open+8,end);
 assert(Buffer.byteLength(body)<2048,'Map payload does not enter routine source/definition catalogue twice');
 assert(s.includes('projection_map() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER'));
 assert(body.includes('total IS DISTINCT FROM 1'));assert(body.includes('payload_bytes IS DISTINCT FROM '+b.bytes));assert(body.includes(b.sha256));assert(body.includes('RETURN parsed_value;'));
 assert(!body.includes('IMMUTABLE'));assert(!s.includes(payload.slice(0,1024)),'No duplicate giant constant in any function body');
});

test('stored map JSONB, byte count and SHA are PostgreSQL-generated from exact immutable text, never caller-provided or a cached verdict',()=>{
 const preamble=candidate.preambleSql,body=candidate.sql.split('$map209$')[1];
 assert.match(preamble,/payload_jsonb jsonb GENERATED ALWAYS AS \(payload::jsonb\) STORED NOT NULL/);
 assert.match(preamble,/payload_octets integer GENERATED ALWAYS AS \(pg_catalog\.octet_length\(payload\)\) STORED NOT NULL/);
 const shaExpression="pg_catalog.encode(pg_catalog.sha256(pg_catalog.decode(pg_catalog.replace(payload COLLATE \"C\",pg_catalog.chr(92),pg_catalog.repeat(pg_catalog.chr(92),2)),'escape')),'hex')";
 assert(preamble.includes('payload_sha256 text GENERATED ALWAYS AS ('+shaExpression+') STORED NOT NULL'));
 const insert=/INSERT INTO public\.order_merge_delivery209_projection_basis\(([^)]+)\) VALUES\(true,'([\s\S]*)'\);\n$/.exec(preamble);assert(insert);
 assert.equal(insert[1],'id,payload','Source INSERT cannot supply any of the three generated representations');
 const payload=insert[2].replaceAll("''","'");assert.equal(Buffer.byteLength(payload),candidate.projection_basis.bytes);assert.equal(sha(payload),candidate.projection_basis.sha256);
 const original=JSON.stringify(JSON.parse(payload).map(({after_check,...entry})=>entry));
 assert.equal(Buffer.byteLength(original),21143626);assert.equal(sha(original),'ea1bcf90d63f24e17a1a996ec69e3f29668d0f31568f27ac77679909cb551bc2','All10 complete before/after entries remain literal; only source-authored after_check is added');
 assert.match(body,/SELECT count\(\*\) OVER\(\),id,payload IS NOT NULL,payload_octets,payload_sha256,payload_jsonb INTO total,source_id,payload_present,payload_bytes,payload_hash,parsed_value FROM public\.order_merge_delivery209_projection_basis;/);
 assert(body.includes('total IS DISTINCT FROM 1 OR source_id IS DISTINCT FROM true OR payload_present IS DISTINCT FROM true OR parsed_value IS NULL'));
 const bytes='payload_bytes IS DISTINCT FROM '+candidate.projection_basis.bytes,hash="payload_hash IS DISTINCT FROM '"+candidate.projection_basis.sha256+"'";
 assert(body.includes(bytes)&&body.includes(hash),'Fresh source-derived count/length/SHA validation remains on every invocation');
 assert(body.indexOf(bytes)<body.indexOf('RETURN parsed_value;'));assert(body.indexOf(hash)<body.indexOf('RETURN parsed_value;'));
 assert(!body.includes('::jsonb'),'No21MiB runtime JSON parse remains in the reader');
 for(const token of ['set_config(','CREATE TEMP','cached','RETURN true','convert_to(','sha256(','octet_length('])assert(!body.includes(token));
 const fullFingerprint=deriveOrderMergeDelivery209FingerprintRecords();
 assert(fullFingerprint.includes("'generated',a.attgenerated"),'Stored-generation kind participates in complete metadata fingerprint');
 assert(fullFingerprint.includes("'default',pg_catalog.pg_get_expr(d.adbin,d.adrelid)"),'Exact generation expression participates in complete metadata fingerprint');
});

test('direct map reads require fresh complete metadata before accepting derivatives, and reject every NULL or wrong row identity',()=>{
 const preamble=candidate.preambleSql,body=candidate.sql.split('$map209$')[1];
 const fresh="IF current_setting('server_encoding') IS DISTINCT FROM 'UTF8' OR public.order_merge_delivery209_valid() IS DISTINCT FROM true THEN RAISE EXCEPTION '209 exact generated projection required' USING ERRCODE='55000';END IF;";
 assert(body.includes(fresh));assert(body.indexOf(fresh)<body.indexOf('SELECT count(*) OVER()'));
 assert(preamble.indexOf("current_setting('server_encoding') IS DISTINCT FROM 'UTF8'")<preamble.indexOf('CREATE TABLE'));
 assert.equal((body.match(/current_setting\(/g)??[]).length,1,'Only the fixed database encoding is read, never caller-owned session cache or flags');
 for(const refusal of ['total IS DISTINCT FROM 1','source_id IS DISTINCT FROM true','payload_present IS DISTINCT FROM true','parsed_value IS NULL','payload_bytes IS DISTINCT FROM '+candidate.projection_basis.bytes,"payload_hash IS DISTINCT FROM '"+candidate.projection_basis.sha256+"'"])assert(body.includes(refusal),refusal);
 assert(body.indexOf('RETURN parsed_value;')>body.indexOf('payload_hash IS DISTINCT FROM'));
 assert(!body.includes('::jsonb'));assert(!body.includes('payload_value'),'No full text reparse/hash or caller-supplied verdict remains');
});

test('immutable escape-byte derivation preserves UTF8, literal backslashes, octal-looking text and control bytes',()=>{
 // Independent byte oracle for PostgreSQL encode.c esc_decode: ordinary bytes
 // are copied; a doubled backslash emits one. This is not a PG/compiler claim.
 const escapeDecode=bytes=>{const out=[];for(let i=0;i<bytes.length;i++){
  if(bytes[i]!==92){out.push(bytes[i]);continue;}
  if(bytes[i+1]===92){out.push(92);i++;continue;}
  if(bytes[i+1]>=48&&bytes[i+1]<=51&&bytes[i+2]>=48&&bytes[i+2]<=55&&bytes[i+3]>=48&&bytes[i+3]<=55){out.push((bytes[i+1]-48)*64+(bytes[i+2]-48)*8+bytes[i+3]-48);i+=3;continue;}
  throw new Error('Invalid escape');
 }return Buffer.from(out);};
 for(const text of ['',JSON.stringify({city:'Łódź',emoji:'😀',combining:'e\u0301'}),'\\123\\x00\\n\\','\r\n\t','中文𐀀','"quote"\\\\end']){
  const utf8=Buffer.from(text,'utf8'),derived=escapeDecode(Buffer.from(text.replaceAll('\\','\\\\'),'utf8'));
  assert.deepEqual(derived,utf8);assert.equal(sha(derived),sha(utf8));assert.equal(derived.length,Buffer.byteLength(text));
 }
 assert.notDeepEqual(escapeDecode(Buffer.from('\\123')),Buffer.from('\\123'),'Doubling every backslash is necessary, not an optional normalization');
 const generated=candidate.preambleSql.split('payload_sha256 text GENERATED ALWAYS AS (')[1].split(') STORED NOT NULL')[0];
 for(const token of ['convert_to(','textsend(','current_setting(','SELECT','IMMUTABLE'])assert(!generated.includes(token));
 for(const token of ['pg_catalog.encode(','pg_catalog.sha256(','pg_catalog.decode(','pg_catalog.replace(payload COLLATE "C",pg_catalog.chr(92),pg_catalog.repeat(pg_catalog.chr(92),2))'])assert(generated.includes(token));
});

test('caller substitutions to any source-derived input or source166 pin fail before generating SQL',()=>{
 assert.throws(()=>deriveOrderMergeDelivery209Predecessor({changes:buyer.slice(1),source166}));
 const altered=structuredClone(buyer);altered[0].after.source+='\n';assert.throws(()=>deriveOrderMergeDelivery209Predecessor({changes:altered,source166}));
 assert.throws(()=>deriveOrderMergeDelivery209Predecessor({changes:buyer,source166:source166+'\n'}));
});


test('Source17 historical nested binding paths preserve source193 byte witnesses',()=>{
 // Captured independently from the complete HEAD/source193 generator before
 // this patch. Reverse only the named expression changes, not a whole loop.
 const before={
  descriptor209:'ac37ab0956772ef59be38b5cb4065fc9c532c5197ee930b0494399c4fe87a725',
  metadata209:'fc3d9bbe939fa420a11cc57628669d3f49be40d1f41b4bac8bbfeceaef34b275',
  checked209:'c4547b4b06337480a2f0431fad1bdf7793142ea1b73c4ef0a0236242401c6405',
  local_descriptor209:'5b0670b84dc02b70f287976d407d6b8ce96436b62b6847066e36cd30480dee86',
  local_metadata209:'f4430768ae7beacd51afadca85927431f4b8509a23591a383d29e7593eec4efc',
 };
 for(const[tag,digest]of Object.entries(before))assert.equal(sha(reverseNestedExtraction(historicalSql.split('$'+tag+'$')[1],tag)),digest,tag);
 assert.deepEqual(candidate.projection_basis,{bytes:21150718,sha256:'78364713a307b888c634f74c6f0c37e63c77b8aab62cca922099555bbd4c6287'});
});

test('four compact binding validators stay materialized; stored selected history still requires complete current comparison',()=>{
 for(const tag of ['descriptor209','metadata209','checked209','local_metadata209']){
  const body=candidate.sql.split('$'+tag+'$')[1];
  const start=body.indexOf('-- Validate ALL10'),end=body.indexOf(' IF validated<>10',start),batch=body.slice(start,end);
  assert.equal(batch.split(recordsetWanted).length,2);
  assert(!batch.includes('jsonb_array_elements(entries)'));
  assert(!batch.includes("'before',"));assert(!batch.includes("'after',"));
  assert(!/entries\s*->/.test(batch),'no giant intermediate array element');
  if(tag==='descriptor209'){
   const selected="selected_before:=jsonb_extract_path(entries,(binding_ordinal-1)::text,'before');";
   assert.equal(batch.split(selected).length,2);
   assert(batch.indexOf(selected)>batch.indexOf("live IS DISTINCT FROM entry->'after_check'"));
  }
 }
 const local=candidate.sql.split('$local_descriptor209$')[1];
 assert(local.includes('entry jsonb'));
 for(const part of ["entry->>'key' IS DISTINCT FROM actual_key","live IS DISTINCT FROM entry->'after_check'","RETURN selected_before;"])assert(local.includes(part));
 assert(local.indexOf('RETURN selected_before;')>local.indexOf('209 exact current descriptor required'));
 // Metadata replacement intentionally retains its old complete-string loop;
 // it is outside this narrow optimization and covered by the byte witness.
 for(const tag of ['metadata209','local_metadata209'])assert(candidate.sql.split('$'+tag+'$')[1].includes('FOR entry IN SELECT v FROM jsonb_array_elements(entries) a(v) LOOP'));
});


test('four current materialized bindings and Source17 sourcee538 witnesses remain intact',()=>{
 const before={
  descriptor209:'e382fbfcd9ef1cf0175f47803879886082e50c7b0e6feeaa54673f4f4890c257',
  metadata209:'b8477b10aca31218c665d26e5e72ff712d3f9e091f8eaec47fb7682ce68cc3aa',
  checked209:'57b3e0b87c61e0f99f8bb246a86416542539b437eda06b083e82e8766f43928e',
  local_descriptor209:'5b0670b84dc02b70f287976d407d6b8ce96436b62b6847066e36cd30480dee86',
  local_metadata209:'49b82ccb072ca8a05377495e309e1f6c21baae6292f8de62e80f3c0c658e4765',
 };
 for(const[tag,digest]of Object.entries(before)){
  const body=candidate.sql.split('$'+tag+'$')[1];
  assert.equal(sha(reverseMaterializedWanted(historicalSql.split('$'+tag+'$')[1],tag)),digest,tag+' historical Source17 materialization boundary');
  if(tag==='local_descriptor209')continue;
  const begin=body.indexOf('WITH wanted AS MATERIALIZED('),end=body.indexOf('\n  SELECT wanted.entry',begin);
  assert(begin>0&&end>begin);
  const materialized=body.slice(begin,end);
  assert(materialized.includes('FROM ROWS FROM(jsonb_to_recordset(entries) AS(key text,after_check jsonb)) WITH ORDINALITY AS a(key,after_check,ordinal)'));
  assert(!materialized.includes('pg_proc'));assert(!materialized.includes("'before'"));assert(!materialized.includes("'after'"));
  assert.equal((materialized.match(/jsonb_extract_path\(/g)??[]).length,0);assert(materialized.includes('a.ordinal::integer ordinal'));
  const scan=body.slice(end,body.indexOf('\n LOOP',end));
  assert(scan.includes('FROM wanted'));assert(!scan.includes('jsonb_extract_path('),'large frame extraction cannot inline into pg_proc predicate');
  assert(scan.includes('bindings.total=1 AND p.oid=bindings.member_oid'));
 }
});


test('Source17 historical restoration changes only literal193 local descriptor and reverses to entire pinned47 SQL',()=>{
 const body=source17Candidate.sql.split('$local_descriptor209$')[1];
 assert.equal(sha(body),'5b0670b84dc02b70f287976d407d6b8ce96436b62b6847066e36cd30480dee86','independently pinned193 literal source');
 const keys=[...buyer,...candidate.changes].map(c=>c.key);
 const oldEntry=' entry:=CASE actual_key '+keys.map((k,i)=>"WHEN '"+k+"' THEN entries->"+i).join(' ')+' ELSE NULL END;';
 const priorOrdinal=' binding_index:=CASE actual_key '+keys.map((k,i)=>"WHEN '"+k+"' THEN "+i).join(' ')+' ELSE NULL END;';
 assert.equal(body.split(oldEntry).length,2);
 const prior=body.replace(oldEntry,priorOrdinal)
  .replace('actual_key text;entry jsonb;','actual_key text;binding_index integer;')
  .replace("entry IS NULL OR entry->>'key' IS DISTINCT FROM actual_key OR live IS DISTINCT FROM entry->'after_check'","binding_index IS NULL OR jsonb_extract_path_text(entries,binding_index::text,'key') IS DISTINCT FROM actual_key OR live IS DISTINCT FROM jsonb_extract_path(entries,binding_index::text,'after_check')")
  .replace("RETURN entry->'before';","RETURN jsonb_extract_path(entries,binding_index::text,'before');");
 assert.equal(sha(prior),'f6205d9af868504f5b31c73bcab533e10e09dadb82317e3eac76d06b15d50f2d');
 const core=readFileSync(new URL('./order-merge-delivery209-business.sql',import.meta.url),'utf8');
 const assembled=assembleOrderMergeDelivery209({source166,core,predecessor:source17Candidate});
 assert.equal(assembled.sql.split('$local_descriptor209$'+body+'$local_descriptor209$').length,2);
 let reversed=assembled.sql.replace('$local_descriptor209$'+body+'$local_descriptor209$','$local_descriptor209$'+prior+'$local_descriptor209$');
 assert.equal(reversed.split(recordsetWanted).length,5);reversed=reversed.split(recordsetWanted).join(compactWanted);
 assert.equal(sha(reversed),'47f80aefca82af2eca5d4e755f221ea0b86d046fb4af0a41f578fa7d66e483f5','no business/ACL/seal/budget/map or other helper byte changed');
 assert.equal(candidate.sql.match(/WITH wanted AS MATERIALIZED\(/g)?.length,4);
 assert.deepEqual(candidate.projection_basis,{bytes:21150718,sha256:'78364713a307b888c634f74c6f0c37e63c77b8aab62cca922099555bbd4c6287'});
});


test('Source17 historical recordset extraction reverses four bodies to entire pinned67 SQL',()=>{
 const core=readFileSync(new URL('./order-merge-delivery209-business.sql',import.meta.url),'utf8');
 const assembled=assembleOrderMergeDelivery209({source166,core,predecessor:source17Candidate});
 assert.equal(assembled.sql.split(recordsetWanted).length,5);
 assert.equal(sha(assembled.sql.split(recordsetWanted).join(compactWanted)),'67e5bc59e288d7529a62c1f12bf2a680d6ba3f45d158ababce2fbb4b2e0be150','all historical ten functions, map DATA, ACL/seal/budgets and other routines remain byteexact');
 assert.equal(candidate.sql.match(/WITH wanted AS MATERIALIZED\(/g)?.length,4);
 assert.equal(sha(source17Candidate.sql.split('$local_descriptor209$')[1]),'5b0670b84dc02b70f287976d407d6b8ce96436b62b6847066e36cd30480dee86');
 assert.deepEqual(candidate.projection_basis,{bytes:21150718,sha256:'78364713a307b888c634f74c6f0c37e63c77b8aab62cca922099555bbd4c6287'});
});


test('Source18 adds only twelve builtin data derivatives and changes three private bodies; reverse restores entire source-authored17 SQL',()=>{
 const core=readFileSync(new URL('./order-merge-delivery209-business.sql',import.meta.url),'utf8');
 const baseline=assembleOrderMergeDelivery209({source166,core,predecessor:source17Candidate});
 assert.equal(sha(baseline.sql),'e489b9f30b0a8d26582f40d4fb103da32b346a89ad6eb9c78fe0b9356a9cd1cd');
 assert.equal(historicalSql,source17Candidate.sql,'every non-replaced helper/source/ACL byte remains literal Source17');
 assert.deepEqual(candidate.changes,source17Candidate.changes,'six complete legacy AFTER/BEFORE descriptors and all190 source readsites unchanged');
 assert.deepEqual(candidate.projection_counts,source17Candidate.projection_counts);
 assert.deepEqual(candidate.projection_basis,{bytes:21150718,sha256:'78364713a307b888c634f74c6f0c37e63c77b8aab62cca922099555bbd4c6287'});
 const marker=',\n -- Source18 independently checked builtin derivatives.\n ',start=candidate.preambleSql.indexOf(marker),end=candidate.preambleSql.indexOf('\n);',start);
 assert(start>0&&end>start);assert.equal(candidate.preambleSql.split(marker).length,2);
 const restoredPreamble=candidate.preambleSql.slice(0,start)+candidate.preambleSql.slice(end);
 assert.equal(restoredPreamble,source17Candidate.preambleSql,'whole raw DATA/schema/RLS/trigger/INSERT bytes retained outside the named derivatives');
 const restored=assembleOrderMergeDelivery209({source166,core,predecessor:{...candidate,sql:historicalSql,preambleSql:restoredPreamble}});
 assert.equal(restored.sql,baseline.sql);assert.equal(sha(restored.sql),'e489b9f30b0a8d26582f40d4fb103da32b346a89ad6eb9c78fe0b9356a9cd1cd');
 assert.deepEqual(candidate.helper_keys,source17Candidate.helper_keys,'no new callable helper/capability');
});

test('twelve STORED values use only raw payload and builtin projection; independent NULL-safe raw CHECKs enforce the stored derivation',()=>{
 const ddl=candidate.preambleSql.slice(0,candidate.preambleSql.indexOf('INSERT INTO'));
 const contracts=[
  ['projection_keys',"jsonb_path_query_array(payload::jsonb,'strict $[*].key'::jsonpath)",'array','order_merge_delivery209_keys_source'],
  ['projection_checks',"jsonb_path_query_array(payload::jsonb,'strict $[*].after_check'::jsonpath)",'array','order_merge_delivery209_checks_source'],
  ...Array.from({length:10},(_,i)=>['before_'+i,"((payload::jsonb)->"+i+"->'before')",'object','order_merge_delivery209_before_'+i+'_source']),
 ];
 for(const[name,expression,kind,constraint]of contracts){
  assert.equal(ddl.split(name+' jsonb GENERATED ALWAYS AS ('+expression+') STORED CONSTRAINT '+constraint).length,2,name+' has one authored stored builtin expression');
  const check="CHECK("+name+" IS NOT NULL AND "+name+' IS NOT DISTINCT FROM '+expression+" AND jsonb_typeof("+name+")='"+kind+"'"+(kind==='array'?' AND jsonb_array_length('+name+')=10':'')+')';
  assert(ddl.includes('CONSTRAINT '+constraint+' '+check),name+' is independently verified against raw payload at write time');
  assert(!expression.includes('payload_jsonb'));assert(!expression.includes('order_merge_delivery209_'));
 }
 assert.equal((ddl.match(/CONSTRAINT order_merge_delivery209_(?:keys|checks|before_\d)_source CHECK\(/g)??[]).length,12);
 // Source-only descriptor/DDL proof. PostgreSQL parsing, stored-row mutation
 // adversaries and compiled metadata counts are reserved for actual compiler/QA.
 assert(ddl.includes('ALTER TABLE public.order_merge_delivery209_projection_basis FORCE ROW LEVEL SECURITY'));
 assert(ddl.includes('order_merge_delivery209_projection_immutable BEFORE UPDATE OR DELETE'));
 assert(ddl.includes('order_merge_delivery209_projection_no_truncate BEFORE TRUNCATE'));
});

test('fresh factory returns only small exact bindings after current complete validation; selected BEFORE fetch keeps current full descriptor/roster and source cut',()=>{
 const checked=candidate.sql.split('$checked209$')[1],guard=checked.indexOf('public.order_merge_delivery209_valid()'),read=checked.indexOf('SELECT count(*) OVER(),id,payload IS NOT NULL'),all=checked.indexOf('Validate ALL10 current bindings'),ret=checked.indexOf('RETURN entries;');
 assert(guard>0&&read>guard&&all>read&&ret>all);assert(!checked.includes('payload_jsonb'));assert(!checked.includes("'before'"));assert(!checked.includes("'after'"));
 assert(checked.includes("SELECT jsonb_agg(jsonb_build_object('key',source_keys->i,'after_check',source_checks->i) ORDER BY i) INTO entries FROM generate_series(0,9) item(i);"));
 for(const token of ["total IS DISTINCT FROM 1","source_id IS DISTINCT FROM true","payload_present IS DISTINCT FROM true","payload_bytes IS DISTINCT FROM 21150718","payload_hash IS DISTINCT FROM '78364713a307b888c634f74c6f0c37e63c77b8aab62cca922099555bbd4c6287'","jsonb_typeof(source_keys) IS DISTINCT FROM 'array'","jsonb_array_length(source_keys)<>10","jsonb_typeof(source_checks) IS DISTINCT FROM 'array'","jsonb_array_length(source_checks)<>10"])assert(checked.includes(token),token);
 const local=candidate.sql.split('$local_descriptor209$')[1],selected=local.indexOf('209 exact current descriptor required'),stored=local.indexOf('SELECT count(*) OVER(),id,payload IS NOT NULL'),returned=local.indexOf('RETURN selected_before;');
 assert(local.includes('FROM('+checkFunctionQuery+') projected(kind,key,value)'));
 assert(selected>0&&stored>selected&&returned>stored);
 assert(local.includes("IF total<>1 OR entry IS NULL OR entry->>'key' IS DISTINCT FROM actual_key OR live IS DISTINCT FROM entry->'after_check'"));
 const keys=[...buyer,...candidate.changes].map(c=>c.key);
 const exactCase='CASE actual_key '+keys.map((key,i)=>"WHEN '"+key+"' THEN before_"+i).join(' ')+' ELSE NULL END';
 assert.equal(local.split(exactCase).length,2,'one typed source-key CASE selects one stored predecessor column');
 assert(local.includes("jsonb_typeof(selected_before) IS DISTINCT FROM 'object'"));
 for(const token of ["total IS DISTINCT FROM 1","source_id IS DISTINCT FROM true","payload_present IS DISTINCT FROM true","payload_bytes IS DISTINCT FROM 21150718","payload_hash IS DISTINCT FROM '78364713a307b888c634f74c6f0c37e63c77b8aab62cca922099555bbd4c6287'"])assert(local.slice(stored).includes(token),token);
 assert(!local.includes('payload_jsonb'));assert(!local.includes('EXECUTE '));assert(!local.includes('set_config('));
});

test('rare local metadata replacement validates ALL10 compact bindings before fresh complete source-basis read and preserves full-string replacement',()=>{
 const body=candidate.sql.split('$local_metadata209$')[1],all=body.indexOf('Validate ALL10 current bindings'),count=body.indexOf('IF validated<>10'),guard=body.indexOf('public.order_merge_delivery209_valid()'),read=body.indexOf('SELECT count(*) OVER(),id,payload IS NOT NULL'),loop=body.indexOf('FOR entry IN SELECT v FROM jsonb_array_elements(entries)');
 assert(all>0&&count>all&&guard>count&&read>guard&&loop>read);
 assert(body.includes('payload_sha256,payload_jsonb INTO total,source_id,payload_present,payload_bytes,payload_hash,entries'));
 assert(body.includes("after_value:=entry->'after'->>field;before_value:=entry->'before'->>field;"));
 assert(body.includes('result:=replace(result,to_jsonb(after_value)::text,to_jsonb(before_value)::text);'));
 assert(body.includes('FOREACH field IN ARRAY ARRAY[\'source\',\'definition\']'));
 assert.equal(candidate.projection_counts.find(c=>c.key==='public.ordinary187_valid()').metadata_reads,2);
});
