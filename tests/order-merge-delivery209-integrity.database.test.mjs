/** Native209 metadata integrity ONLY. Import-inert/default SKIP; no install/seed/factory.
 * Root supplies one committed SOURCE compiler scratch, never preview/Main. Every mutation
 * is rolled back and all historical certificate DATA is matched to its pre209 source hash. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {native209SourceQaProfile,NATIVE209_SOURCE_QA_V1,NATIVE209_SOURCE_QA_V22} from './native209-source-qa-profile.mjs';
const enabled=process.env.DYNA_NATIVE209_GUARD_QA==='true';
const options={skip:!enabled,concurrency:false};
const SOURCE209=NATIVE209_SOURCE_QA_V1.sourceSha256;
const clientProfiles=new WeakMap();
const profileFor=c=>{const p=clientProfiles.get(c);assert(p,'explicit validated QA profile required');return p;};
const columnsFor=c=>profileFor(c).columns;
const SHA=/^[a-f0-9]{64}$/;
const hash=v=>createHash('sha256').update(typeof v==='string'||Buffer.isBuffer(v)?v:JSON.stringify(v)).digest('hex');
const exact=(v,keys)=>{assert(v&&typeof v==='object'&&!Array.isArray(v));assert.deepEqual(Object.keys(v).sort(),keys.slice().sort());};
const quote=v=>{assert(/^[a-z][a-z0-9_]{0,62}$/.test(v));return '"'+v+'"';};
const fileCut = (s) =>
  [s.dev, s.ino, s.uid, s.mode, s.nlink, s.size, s.mtimeNs, s.ctimeNs].join(
    ":",
  );
async function privateJson(file) {
  assert(
    typeof file === "string" &&
      path.isAbsolute(file) &&
      path.resolve(file) === file &&
      !/[\x00-\x1f\x7f]/.test(file),
  );
  assert.equal(await fs.realpath(file), file);
  const before = await fs.lstat(file, { bigint: true });
  assert(
    before.isFile() &&
      !before.isSymbolicLink() &&
      before.uid === BigInt(process.getuid()) &&
      before.nlink === 1n &&
      (before.mode & 0o777n) === 0o600n &&
      before.size > 0n &&
      before.size <= 16384n,
    "Private canonical single-link owner0600 locator required",
  );
  const fd = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    assert.equal(fileCut(await fd.stat({ bigint: true })), fileCut(before));
    bytes = Buffer.alloc(Number(before.size) + 1);
    let count = 0;
    for (;;) {
      const r = await fd.read(bytes, count, bytes.length - count, count);
      if (!r.bytesRead) break;
      count += r.bytesRead;
      if (count === bytes.length) break;
    }
    assert.equal(count, Number(before.size));
    assert.equal(fileCut(await fd.stat({ bigint: true })), fileCut(before));
    assert.equal(
      fileCut(await fs.lstat(file, { bigint: true })),
      fileCut(before),
    );
    assert.equal(await fs.realpath(file), file);
    return JSON.parse(bytes.subarray(0, count).toString("utf8"));
  } finally {
    bytes?.fill(0);
    await fd.close();
  }
}

export function validateNative209Locator(v){
 const keys=['schema','databaseUrl','expectedDatabase','expectedPort','ownershipMarker','expected209SqlSha256','expectedOldCertificatesSha256','receiptDirectory'];
 assert(v&&typeof v==='object');exact(v,v.schema===NATIVE209_SOURCE_QA_V22.schema?[...keys,'runtimeRevision','sourceSqlPath']:keys);
 const profile=native209SourceQaProfile(v);
 if(profile===NATIVE209_SOURCE_QA_V22)assert(path.isAbsolute(v.sourceSqlPath)&&path.resolve(v.sourceSqlPath)===v.sourceSqlPath&&!/[\x00-\x1f\x7f]/.test(v.sourceSqlPath));
 assert(typeof v.databaseUrl==='string'&&v.databaseUrl.length<4096);const u=new URL(v.databaseUrl);
 assert(['postgres:','postgresql:'].includes(u.protocol));assert.equal(u.hostname,'127.0.0.1');assert.equal(u.username,'postgres');
 assert(u.password&&!u.search&&!u.hash);assert(Number.isInteger(v.expectedPort)&&v.expectedPort>=1024&&v.expectedPort<=65535);assert.equal(u.port,String(v.expectedPort));
 assert(/^dynaminds_test_[0-9]{13}$/.test(v.expectedDatabase));assert.equal(u.pathname,'/'+v.expectedDatabase);
 assert(/^dynaminds-source209-compiler:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v.ownershipMarker));
 assert.equal(v.expected209SqlSha256,profile.sourceSha256);assert(SHA.test(v.expectedOldCertificatesSha256));
 assert(typeof v.receiptDirectory==='string'&&path.isAbsolute(v.receiptDirectory)&&path.resolve(v.receiptDirectory)===v.receiptDirectory&&!/[\x00-\x1f\x7f]/.test(v.receiptDirectory));
 return Object.freeze({...v});
}
// Read only: this path selects exactly one known Source22 byte string. It
// cannot select a different SHA or dispatch the selected file as SQL.
async function assertPinnedSource22(file,profile){
 assert.equal(profile,NATIVE209_SOURCE_QA_V22);assert.equal(await fs.realpath(file),file);
 const before=await fs.lstat(file,{bigint:true});
 assert(before.isFile()&&!before.isSymbolicLink()&&before.uid===BigInt(process.getuid())&&before.nlink===1n&&(before.mode&0o777n)===0o600n&&before.size===BigInt(profile.sourceBytes),'exact private Source22 file required');
 const fd=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW),buffer=Buffer.alloc(65536),digest=createHash('sha256');let failed=false;
 try{
  assert.equal(fileCut(await fd.stat({bigint:true})),fileCut(before));let count=0;
  while(count<=profile.sourceBytes){const length=Math.min(buffer.length,profile.sourceBytes+1-count);const r=await fd.read(buffer,0,length,count);if(!r.bytesRead)break;count+=r.bytesRead;assert(count<=profile.sourceBytes,'Source22 file grew');digest.update(buffer.subarray(0,r.bytesRead));}
  assert.equal(count,profile.sourceBytes);assert.equal(digest.digest('hex'),profile.sourceSha256);
  assert.equal(fileCut(await fd.stat({bigint:true})),fileCut(before));assert.equal(fileCut(await fs.lstat(file,{bigint:true})),fileCut(before));assert.equal(await fs.realpath(file),file);
 }catch(e){failed=true;throw e;}finally{buffer.fill(0);try{await fd.close();}catch(e){if(!failed)throw e;}}
}
async function loadNative209Locator(){try{return validateNative209Locator(await privateJson(process.env.DYNA_NATIVE209_GUARD_QA_PRIVATE));}catch{throw Error('Invalid private Native209 QA locator');}}
const runLocator=enabled?await loadNative209Locator():undefined;
const runProfile=runLocator?native209SourceQaProfile(runLocator):undefined;
const source22Options={...options,skip:!enabled||runProfile!==NATIVE209_SOURCE_QA_V22};
export const OLD_CERTIFICATES_SQL=`SELECT jsonb_build_object(
 '166',(SELECT jsonb_agg(to_jsonb(m) ORDER BY to_jsonb(m)::text) FROM public.buyer_address_manifest m),
 '188',(SELECT jsonb_agg(to_jsonb(m) ORDER BY to_jsonb(m)::text) FROM public.local_consumer_credit_manifest m),
 '207',(SELECT jsonb_agg(to_jsonb(m) ORDER BY to_jsonb(m)::text) FROM public.return_credit206_manifest m),
 '208',(SELECT jsonb_agg(to_jsonb(m) ORDER BY to_jsonb(m)::text) FROM public.return_credit208_manifest m)) snapshot`;
async function oldCertificates(c){const v=(await c.query(OLD_CERTIFICATES_SQL)).rows[0].snapshot;for(const key of ['166','188','207','208'])assert.equal(v[key].length,1);return hash(v);}
async function healthy(c,l){
 const privateFrames=(await c.query(`SELECT count(*)::int count,bool_and(NOT has_function_privilege('dyna_app',signature::regprocedure,'EXECUTE')) denied FROM unnest(ARRAY[
  'public.order_merge_delivery209_checked_projection_map(oid)',
  'public.order_merge_delivery209_predecessor_descriptor(oid,jsonb)',
  'public.order_merge_delivery209_predecessor_definition(oid,jsonb)',
  'public.order_merge_delivery209_predecessor_source(oid,jsonb)',
  'public.order_merge_delivery209_predecessor_metadata(jsonb,jsonb)']) signatures(signature)`)).rows[0];
 assert.deepEqual(privateFrames,{count:5,denied:true},'Application callers cannot supply invocation-local representation frames');
 const identity=(await c.query("SELECT public.order_merge_delivery209_predecessor_definition(p.oid)=pg_get_functiondef(p.oid) definition_literal,public.order_merge_delivery209_predecessor_source(p.oid)=p.prosrc source_literal FROM pg_proc p WHERE p.oid='public.fa3_draft_fingerprint()'::regprocedure")).rows[0];
 assert.deepEqual(identity,{definition_literal:true,source_literal:true},'Unchanged functions retain their complete actual definition and source');
 const predicates=(await c.query('SELECT public.order_merge_delivery209_valid() own209,public.buyer_address_guards() buyer166,public.partial_sale204_valid() source204,public.catalog_header205_valid() source205,public.return_credit206_guards() source207')).rows[0];
 assert.deepEqual(predicates,{own209:true,buyer166:true,source204:true,source205:true,source207:true});
 const certificates=await oldCertificates(c);assert.equal(certificates,l.expectedOldCertificatesSha256);
 return{privateFrames,identity,predicates,certificates,source18:await healthySource18Derivatives(c),fingerprint:(await c.query('SELECT public.order_merge_delivery209_fingerprint() fingerprint')).rows[0].fingerprint};
}
// Separate from healthy()'s original five-predicate shared8s gate. These are
// genuine cold/runtime entry points, not a JS profile comparison or a cached
// boolean. Each query retains the connection's existing8000ms statement budget.
// Full173/187 true does not imply the four direct ordinary184 cold capabilities:
// Source21 is known to refuse that startup cut. Historical46 receipts do not
// cover these added assertions and remain evidence for their original scope.
const FULL_RUNTIME_HELPERS=NATIVE209_SOURCE_QA_V1.fullRuntimeHelpers;
async function healthyFullRuntime(c){
 const profile=profileFor(c),helpers=profile.fullRuntimeHelpers,count=profile.legacyKeys.length;
 const budget=(await c.query("SELECT current_setting('statement_timeout') statement_timeout,current_setting('lock_timeout') lock_timeout")).rows;
 assert.deepEqual(budget,[{statement_timeout:'8s',lock_timeout:'8s'}],'Full runtime probes keep the same per-query8s budget');
 const privateRows=(await c.query("SELECT signature,NOT has_function_privilege('dyna_app',signature::regprocedure,'EXECUTE') denied FROM unnest($1::text[]) signatures(signature) ORDER BY signature",[helpers])).rows;
 assert.deepEqual(privateRows,helpers.slice().sort().map(signature=>({signature,denied:true})),'History representation adapters remain private');
 const identity=(await c.query("SELECT public.partial_sale204_predecessor_definition(p.oid)=pg_get_functiondef(p.oid) literal FROM pg_proc p WHERE p.oid='public.order_merge_delivery209_identity(uuid,uuid,uuid,text,text,boolean)'::regprocedure")).rows;
 assert.deepEqual(identity,[{literal:true}],'The typed-OID precheck preserves complete actual unchanged function text');
 const snapshot=(await c.query('SELECT public.order_merge_delivery209_validation_snapshot() snapshot,public.order_merge_delivery209_fingerprint() fingerprint')).rows[0];
 assert.equal(snapshot.snapshot.fingerprint,snapshot.fingerprint,'The same fresh metadata representation produces the complete fingerprint');
 assert(Array.isArray(snapshot.snapshot.legacy)&&snapshot.snapshot.legacy.length===count);
 assert.equal(new Set(snapshot.snapshot.legacy.map(row=>row.key)).size,count,'Snapshot preserves every complete function identity');
 if(profile===NATIVE209_SOURCE_QA_V22)assert.deepEqual(snapshot.snapshot.legacy.map(row=>row.key).sort(),profile.legacyKeys.slice().sort(),'all17source-authored identities, no observed/adopted roster');
 for(const row of snapshot.snapshot.legacy){assert.equal(row.kind,'function');assert.equal(Object.keys(row.value).length,24);}
 const shaPorts=(await c.query(`WITH frame AS MATERIALIZED (SELECT public.order_merge_delivery209_checked_projection_map() entries)
  SELECT count(*)::int count,bool_and((public.order_merge_delivery209_predecessor_source_sha(p.oid,frame.entries)
   =encode(sha256(convert_to(public.order_merge_delivery209_predecessor_source(p.oid,frame.entries),'UTF8')),'hex')) IS NOT DISTINCT FROM true) equal
  FROM frame CROSS JOIN pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND 'public.'||p.proname IN
   (SELECT split_part(value->>'key','(',1) FROM jsonb_array_elements(frame.entries))`)).rows;
 assert.deepEqual(shaPorts,[{count,equal:true}],'Every projected source hash equals the complete independently checked predecessor text');
 const probes={};
 for(const[name,sql]of[
  ['operative',"SELECT public.order_merge_delivery209_history_operative_valid(public.ordinary181_manual_basis((SELECT payload FROM public.manual_inventory_off_certificate WHERE id))) valid"],
  ['wave',"SELECT public.order_merge_delivery209_wave_valid(public.ordinary181_manual_basis((SELECT payload FROM public.manual_inventory_off_certificate WHERE id))) valid"],
  ['buyer',"SELECT public.order_merge_delivery209_buyer_guards(public.ordinary181_manual_basis((SELECT payload FROM public.manual_inventory_off_certificate WHERE id))) valid"],
  ...['pim','parents'].map(name=>[name,`WITH basis AS MATERIALIZED (
    SELECT public.ordinary181_manual_basis((SELECT payload FROM public.manual_inventory_off_certificate WHERE id)) value),
   wave AS MATERIALIZED (SELECT basis.value,public.order_merge_delivery209_wave_valid(basis.value) wave_ok FROM basis)
   SELECT public.order_merge_delivery209_history_${name}_valid(wave.value,wave.wave_ok) IS NOT DISTINCT FROM true
    AND wave.wave_ok IS NOT DISTINCT FROM true valid FROM wave`]),
  ['history_predecessor',`WITH frame AS MATERIALIZED (SELECT public.order_merge_delivery209_checked_projection_map() entries)
   SELECT public.order_merge_delivery209_history_predecessor_project(
    public.order_merge_delivery209_predecessor_metadata(public.large_import173_predecessor_map(),frame.entries),frame.entries)
    IS NOT DISTINCT FROM (SELECT predecessor_map FROM public.large_import173_certificate WHERE singleton) valid FROM frame`],
  // Exact ordinary184-cold-capability calls from profile-startup.mjs. Keep
  // them separate: strict false/NULL/missing results or57014 must fail this
  // healthy scenario, never inherit readiness from history adapters above.
  ...['pim_dictionary_valid','nested172_valid','parcel_physical_wz_valid','operative_delivery_valid']
   .map(name=>[name,'SELECT public.'+name+'() AS valid']),
  ...(profile===NATIVE209_SOURCE_QA_V22?helpers.filter(signature=>signature.startsWith('public.order_merge_delivery209_pim_')).map(signature=>{
   assert(/^public\.order_merge_delivery209_pim_(operative_valid|packed_guards|parcel_valid|issuer_guards)\(jsonb,boolean\)$/.test(signature));
   const name=signature.slice(0,signature.indexOf('('));
   return[name,`WITH frame AS MATERIALIZED (SELECT public.order_merge_delivery209_checked_projection_map() entries),
    wave AS MATERIALIZED (SELECT frame.entries,public.wave_print177_valid() wave_ok FROM frame)
    SELECT ${name}(wave.entries,wave.wave_ok) IS NOT DISTINCT FROM true
     AND wave.wave_ok IS NOT DISTINCT FROM true valid FROM wave`];
  }):[]),
  ['ordinary187','SELECT public.ordinary187_valid() valid'],
  ['large_import173','SELECT public.large_import173_valid() valid'],
 ]){
  const rows=(await c.query(sql)).rows;
  assert.deepEqual(rows,[{valid:true}],'Genuine Native runtime must be strictly true: '+name);probes[name]=true;
 }
 return{per_query_timeout_ms:8000,private_helpers:privateRows,unchanged_identity:identity,predicates:probes};
}
async function mutateOwnHistoryBody(c,signature){
 assert(profileFor(c).fullRuntimeHelpers.includes(signature));
 const beforeFingerprint=(await c.query('SELECT public.order_merge_delivery209_fingerprint() fingerprint')).rows[0].fingerprint;
 assert.equal(typeof beforeFingerprint,'string');
 const rows=(await c.query('SELECT pg_get_functiondef(p.oid) definition,p.prosrc source FROM pg_proc p WHERE p.oid=$1::regprocedure',[signature])).rows;
 assert.equal(rows.length,1);const original=rows[0].definition;
 assert.equal(typeof original,'string');assert.equal(typeof rows[0].source,'string');assert(rows[0].source.length>0);
 assert.equal(original.split(rows[0].source).length,2,'One complete source span in its deparsed definition');
 const changed=original.replace(rows[0].source,()=> '/* native209 own-helper integrity drift */'+rows[0].source);assert.notEqual(changed,original);
 await c.query(changed);
 assert.equal((await c.query('SELECT pg_get_functiondef($1::regprocedure) definition',[signature])).rows[0].definition,changed,
  'The real stored own helper body must change before the fingerprint refusal');
 const afterFingerprint=(await c.query('SELECT public.order_merge_delivery209_fingerprint() fingerprint')).rows[0].fingerprint;
 assert.notEqual(afterFingerprint,beforeFingerprint,'The complete own fingerprint must cover this private history helper body');
}
async function writeReceipt(dir,title,v){
 assert.equal(await fs.realpath(dir),dir);const s=await fs.lstat(dir);assert(s.isDirectory()&&!s.isSymbolicLink()&&s.uid===process.getuid()&&(s.mode&0o777)===0o700);
 const f=await fs.open(path.join(dir,title+'.private.json'),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try{await f.writeFile(JSON.stringify(v,null,2)+'\n');await f.sync();}finally{await f.close();}
}
const integrityCodes=new Set(['23514','42501','55000','42883','42P01','42703','42704']);
function safeFunctionStack(value){
 if(typeof value!=='string')return[];const frames=[];
 for(const line of value.slice(0,32768).split(/\r?\n/)){
  const match=/^(PL\/pgSQL|SQL) function ([A-Za-z_"][A-Za-z0-9_.$"]{0,159})(?:\([A-Za-z0-9_.,\s"\[\]]{0,320}\))? line ([0-9]{1,6})(?: at [A-Za-z ]{1,60})?$/.exec(line.trim());
  if(match)frames.push({language:match[1],function:match[2],line:Number(match[3])});if(frames.length===8)break;
 }return frames;
}
async function refused(c,sql){
 await c.query('SAVEPOINT refusal209');let result;
 try{const v=await c.query(sql);assert.equal(v.rows[0]?.valid,false,'false, never NULL/true, is an integrity refusal');result={kind:'false'};}
 catch(e){assert(integrityCodes.has(e.code),'Unexpected SQLSTATE cannot count as PASS: '+String(e.code));result={kind:'integrity_error',code:e.code};await c.query('ROLLBACK TO SAVEPOINT refusal209');}
 await c.query('RELEASE SAVEPOINT refusal209');return result;
}
async function projectionMapRefused(c,message){
 await c.query('SAVEPOINT map_data_refusal');let denied=false;
 try{await c.query('SELECT public.order_merge_delivery209_projection_map()');}
 catch(e){assert.equal(e.code,'55000','Only the intended integrity refusal counts');denied=true;await c.query('ROLLBACK TO SAVEPOINT map_data_refusal');}
 await c.query('RELEASE SAVEPOINT map_data_refusal');assert(denied,message);
}
async function projectionColumn(c,column){
 assert(['payload_octets','payload_sha256',...columnsFor(c).map(c=>c.name)].includes(column));
 const rows=(await c.query(`SELECT a.attgenerated generated,pg_get_expr(d.adbin,d.adrelid) expression FROM pg_attribute a
 LEFT JOIN pg_attrdef d ON(d.adrelid,d.adnum)=(a.attrelid,a.attnum)
 WHERE a.attrelid='public.order_merge_delivery209_projection_basis'::regclass AND a.attname=$1 AND NOT a.attisdropped`,[column])).rows;
 assert.equal(rows.length,1);return rows[0];
}
async function dropProjectionExpression(c,column){
 const before=await projectionColumn(c,column);assert.equal(before.generated,'s');assert.equal(typeof before.expression,'string');
 await c.query('ALTER TABLE public.order_merge_delivery209_projection_basis ALTER COLUMN '+quote(column)+' DROP EXPRESSION');
 assert.deepEqual(await projectionColumn(c,column),{generated:'',expression:null});
 await projectionMapRefused(c,'Direct private map cannot trust a derivative whose generation was dropped');
}
async function constantProjectionExpression(c,column){
 const before=await projectionColumn(c,column);assert.equal(before.generated,'s');
 const value=(await c.query('SELECT '+quote(column)+'::text value FROM public.order_merge_delivery209_projection_basis')).rows[0].value;
 assert(column==='payload_octets'?/^[1-9][0-9]{0,8}$/.test(value):SHA.test(value));
 const expression=column==='payload_octets'?value:"'"+value+"'::text";
 await c.query('ALTER TABLE public.order_merge_delivery209_projection_basis ALTER COLUMN '+quote(column)+' SET EXPRESSION AS ('+expression+')');
 const after=await projectionColumn(c,column);assert.equal(after.generated,'s');assert.notEqual(after.expression,before.expression);
 assert.equal((await c.query('SELECT '+quote(column)+'::text value FROM public.order_merge_delivery209_projection_basis')).rows[0].value,value,
  'Hostile generated expression intentionally preserves the source-correct value');
 await projectionMapRefused(c,'Matching derivative values cannot hide a different generated expression');
}
async function source18Metadata(c){
 return(await c.query(`SELECT w.column_name,a.attgenerated generated,a.attnotnull not_null,
  pg_get_expr(d.adbin,d.adrelid) expression,k.conname constraint_name,k.contype constraint_type,
  k.convalidated validated,pg_get_constraintdef(k.oid,true) constraint_definition
 FROM unnest($1::text[],$2::text[]) WITH ORDINALITY w(column_name,constraint_name,ordinal)
 LEFT JOIN pg_attribute a ON a.attrelid='public.order_merge_delivery209_projection_basis'::regclass
  AND a.attname=w.column_name AND NOT a.attisdropped
 LEFT JOIN pg_attrdef d ON(d.adrelid,d.adnum)=(a.attrelid,a.attnum)
 LEFT JOIN pg_constraint k ON k.conrelid=a.attrelid AND k.conname=w.constraint_name
 ORDER BY w.ordinal`,[columnsFor(c).map(c=>c.name),columnsFor(c).map(c=>c.constraint)])).rows;
}
async function healthySource18Derivatives(c){
 const rows=await source18Metadata(c);assert.equal(rows.length,columnsFor(c).length);
 for(const [i,row]of rows.entries()){
  const expected=columnsFor(c)[i];assert.equal(row.column_name,expected.name);assert.equal(row.generated,'s');
  assert.equal(row.not_null,false,'Source18 uses explicit independently authenticated nonnull CHECKs');
  assert.equal(typeof row.expression,'string');assert(row.expression.includes('payload'));
  assert.equal(row.constraint_name,expected.constraint);assert.equal(row.constraint_type,'c');assert.equal(row.validated,true);
  assert(row.constraint_definition.includes(expected.name)&&row.constraint_definition.includes('IS NOT NULL')
   &&row.constraint_definition.includes('IS DISTINCT FROM')&&row.constraint_definition.includes('payload'));
 }
 return{columns:columnsFor(c).length,validated_source_checks:columnsFor(c).length,metadata_sha256:hash(rows)};
}
async function source18ManualWriteRefusals(c){
 const result={};
 for(const {name}of columnsFor(c)){
  await c.query('SAVEPOINT generated_write209');let denied=false;
  try{await c.query('UPDATE public.order_merge_delivery209_projection_basis SET '+quote(name)+'='+quote(name));}
  catch(e){assert.equal(e.code,'428C9','Only real generated-column write refusal counts: '+name);denied=true;await c.query('ROLLBACK TO SAVEPOINT generated_write209');}
  await c.query('RELEASE SAVEPOINT generated_write209');assert(denied,'Every derivative is genuinely GENERATED ALWAYS: '+name);result[name]='428C9';
 }
 return result;
}
// Test every profile derivative independently without repeating the large
// healthy chain. Restore each probe except the final one, which remains changed
// for the scenario's real209/buyer refusal and complete outer rollback.
async function source18BatchTamper(c,kind){
 const baseline=await source18Metadata(c),probes=[];assert.equal(baseline.length,columnsFor(c).length);
 for(const [i,column]of columnsFor(c).entries()){
  await c.query('SAVEPOINT source18_probe209');
  if(kind==='drop-generation'){
   await c.query('ALTER TABLE public.order_merge_delivery209_projection_basis ALTER COLUMN '+quote(column.name)+' DROP EXPRESSION');
   assert.deepEqual(await projectionColumn(c,column.name),{generated:'',expression:null});
  }else if(kind==='same-value-generation'){
   const original=baseline[i].expression;assert.equal(typeof original,'string');
   const identity=column.kind==='array'?"'[]'::jsonb":"'{}'::jsonb";
   await c.query('ALTER TABLE public.order_merge_delivery209_projection_basis ALTER COLUMN '+quote(column.name)+' SET EXPRESSION AS (('+original+') || '+identity+')');
   const actual=await projectionColumn(c,column.name);assert.equal(actual.generated,'s');assert.notEqual(actual.expression,original);
   const value=(await c.query('SELECT '+quote(column.name)+' IS NOT DISTINCT FROM ('+original+') same FROM public.order_merge_delivery209_projection_basis')).rows;
   assert.deepEqual(value,[{same:true}],'Changed expression intentionally preserves the complete current value: '+column.name);
  }else{
   assert(['drop-check','unvalidated-check','weakened-check'].includes(kind));
   await c.query('ALTER TABLE public.order_merge_delivery209_projection_basis DROP CONSTRAINT '+quote(column.constraint));
   if(kind==='unvalidated-check'){
    assert(baseline[i].constraint_definition.startsWith('CHECK (')&&!baseline[i].constraint_definition.includes('NOT VALID'));
    await c.query('ALTER TABLE public.order_merge_delivery209_projection_basis ADD CONSTRAINT '+quote(column.constraint)+' '+baseline[i].constraint_definition+' NOT VALID');
   }else if(kind==='weakened-check')await c.query('ALTER TABLE public.order_merge_delivery209_projection_basis ADD CONSTRAINT '+quote(column.constraint)+' CHECK(true)');
   const actual=(await source18Metadata(c))[i];
   if(kind==='drop-check')assert.equal(actual.constraint_name,null);
   else if(kind==='unvalidated-check'){assert.equal(actual.constraint_name,column.constraint);assert.equal(actual.validated,false);}
   else{assert.equal(actual.validated,true);assert.notEqual(actual.constraint_definition,baseline[i].constraint_definition);}
  }
  await projectionMapRefused(c,'Fresh private map must refuse '+kind+' for '+column.name);
  probes.push({column:column.name,constraint:column.constraint,mutation:kind,direct_map_refusal:'55000'});
  if(i<columnsFor(c).length-1){
   await c.query('ROLLBACK TO SAVEPOINT source18_probe209');
   assert.deepEqual(await source18Metadata(c),baseline,'Exact metadata restored before the next independent probe');
  }
  await c.query('RELEASE SAVEPOINT source18_probe209');
 }
 return{source18_probes:probes};
}
async function removeProjectionDataGuards(c){
 await c.query('ALTER TABLE public.order_merge_delivery209_projection_basis DISABLE TRIGGER order_merge_delivery209_projection_immutable');
 // Each profile has its exact raw-derived CHECKs plus the original payload
 // byte/hash CHECK. Remove all of them deliberately in this sabotage
 // case so UPDATE really executes; a constraint/JSON-path error is never PASS.
 const rows=(await c.query("SELECT conname FROM pg_constraint WHERE conrelid='public.order_merge_delivery209_projection_basis'::regclass AND contype='c' AND pg_get_constraintdef(oid,true) LIKE '%payload%'")).rows;
 assert.equal(rows.length,columnsFor(c).length+1);const names=new Set(rows.map(r=>r.conname));
 for(const {constraint}of columnsFor(c))assert(names.has(constraint));
 for(const row of rows)await c.query('ALTER TABLE public.order_merge_delivery209_projection_basis DROP CONSTRAINT '+quote(row.conname));
}
async function sameByteProjectionTamper(c,{spoofDigest=false}={}){
 const before=(await c.query('SELECT payload_octets bytes,payload_sha256 hash FROM public.order_merge_delivery209_projection_basis')).rows[0];
 assert(Number.isInteger(before.bytes)&&before.bytes>0&&SHA.test(before.hash));
 // Keep every required key/after_check/before property valid for Source18's strict
 // builtin generated expressions; change the exact case-sensitive key VALUE.
 assert.equal((await c.query(`SELECT position('"key":"public.' in payload)>0 present FROM public.order_merge_delivery209_projection_basis`)).rows[0].present,true);
 await removeProjectionDataGuards(c);
 if(spoofDigest){
  await c.query('ALTER TABLE public.order_merge_delivery209_projection_basis ALTER COLUMN payload_sha256 DROP EXPRESSION');
  await c.query(`UPDATE public.order_merge_delivery209_projection_basis SET payload=overlay(payload placing 'P' from position('"key":"public.' in payload)+7 for 1),payload_sha256=$1`,[before.hash]);
 }else await c.query(`UPDATE public.order_merge_delivery209_projection_basis SET payload=overlay(payload placing 'P' from position('"key":"public.' in payload)+7 for 1)`);
 const after=(await c.query(`SELECT octet_length(payload) bytes,payload_octets stored_bytes,payload_sha256 stored_hash,
  encode(sha256(convert_to(payload,'UTF8')),'hex') actual_hash,payload_jsonb=payload::jsonb generated_jsonb_exact,
  position('"key":"Public.' in payload)>0 changed FROM public.order_merge_delivery209_projection_basis`)).rows[0];
 assert.equal(after.bytes,before.bytes);assert.equal(after.stored_bytes,before.bytes);assert.equal(after.generated_jsonb_exact,true);
 assert.equal(after.changed,true);assert.notEqual(after.actual_hash,before.hash,'Valid same-byte JSON really changed');
 assert.equal(after.stored_hash,spoofDigest?before.hash:after.actual_hash,
  spoofDigest?'Forged old hash is not proof when generation metadata changed':'Stored digest was genuinely recomputed with the current payload');
 await projectionMapRefused(c,spoofDigest?'Direct map must refuse spoofed derivative metadata/data':'Source-authored hash must refuse valid same-byte changed data');
}
async function scenario(title,mutate,{immutable=false,fullRuntime=false}={}){
 assert(enabled);const l=await loadNative209Locator(),profile=native209SourceQaProfile(l);
 assert.equal(hash(l),hash(runLocator),'one explicit immutable run locator, no profile switch');
 if(profile===NATIVE209_SOURCE_QA_V22)await assertPinnedSource22(l.sourceSqlPath,profile);
 else assert.equal(hash(await fs.readFile(new URL('../server/209_order_merge_delivery_inheritance.sql',import.meta.url))),profile.sourceSha256);
 // A failed or completed case cannot silently replay in this evidence directory.
 assert.equal(await fs.realpath(l.receiptDirectory),l.receiptDirectory);const ds=await fs.lstat(l.receiptDirectory);assert(ds.isDirectory()&&!ds.isSymbolicLink()&&ds.uid===process.getuid()&&(ds.mode&0o777)===0o700);
 const attempt=await fs.open(path.join(l.receiptDirectory,title+'.attempt.private.json'),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await attempt.writeFile(JSON.stringify({schema:'native209-integrity-attempt/v1',title,source209_sha256:profile.sourceSha256,started_at:new Date().toISOString()})+'\n');await attempt.sync();}finally{await attempt.close();}
 const {default:pg}=await import('pg');const c=new pg.Client({connectionString:l.databaseUrl,application_name:'dyna_native209_integrity_owned_scratch',options:'-c timezone=UTC -c jit=off -c statement_timeout=8000 -c lock_timeout=8000'});
 clientProfiles.set(c,profile);
 let connected=false,began=false,first;const receipt={schema:'dynaminds-native209-integrity-only/v1',title,source209_sha256:profile.sourceSha256,...(profile===NATIVE209_SOURCE_QA_V22?{runtime_revision:22}:{}),business_acceptance:false,no_factory:true,no_seed:true};
 try{
  await c.connect();connected=true;
  const context=(await c.query("SELECT current_database() database,current_user,session_user,host(inet_server_addr()) address,inet_server_port() port,current_setting('session_replication_role') replication_role,(SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()) owner,(SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()) marker")).rows[0];
  assert.equal(context.database,l.expectedDatabase);assert.equal(context.current_user,'postgres');assert.equal(context.session_user,'postgres');assert.equal(context.owner,'postgres');assert.equal(context.marker,l.ownershipMarker);assert.equal(context.address,'127.0.0.1');assert.equal(context.port,l.expectedPort);assert.equal(context.replication_role,'origin');receipt.context=context;
  await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');began=true;await c.query('SELECT pg_advisory_xact_lock(982376)');
  receipt.before=await healthy(c,l);
  if(fullRuntime)receipt.before.full_runtime=await healthyFullRuntime(c);
  await c.query('SAVEPOINT mutation209');
  if(immutable){
   let denied=false;try{await mutate(c);}catch(e){assert.equal(e.code,'23514');denied=true;receipt.mutation_refusal={code:e.code};await c.query('ROLLBACK TO SAVEPOINT mutation209');}
   assert(denied,'The real immutable trigger must refuse mutation');
  }else if(mutate){
   const mutation=await mutate(c);if(mutation?.startup_root_probes)receipt.startup_root_probes=mutation.startup_root_probes;if(mutation?.private_helper_probes)receipt.private_helper_probes=mutation.private_helper_probes;if(mutation?.source18_probes)receipt.source18_probes=mutation.source18_probes;receipt.refusal209=await refused(c,'SELECT public.order_merge_delivery209_valid() valid');
   receipt.refusalBuyer=await refused(c,'SELECT public.buyer_address_guards() valid');
  }else if(!fullRuntime){
   receipt.healthy_only=true;receipt.local_frame_refusals={};
   receipt.source18_generated_write_refusals=await source18ManualWriteRefusals(c);
   await c.query('SAVEPOINT null_frame209');let denied=false;
   try{await c.query("SELECT public.order_merge_delivery209_predecessor_source('public.buyer_address_guards()'::regprocedure,NULL::jsonb)");}
   catch(e){assert.equal(e.code,'55000');denied=true;await c.query('ROLLBACK TO SAVEPOINT null_frame209');}
   await c.query('RELEASE SAVEPOINT null_frame209');assert(denied);receipt.local_frame_refusals.null_scoped_frame=true;
   for(const [name,args]of [
    ['checked_projection_map','NULL::oid'],
    ['predecessor_descriptor',"'public.buyer_address_guards()'::regprocedure,'[]'::jsonb"],
    ['predecessor_definition',"'public.buyer_address_guards()'::regprocedure,'[]'::jsonb"],
    ['predecessor_source',"'public.buyer_address_guards()'::regprocedure,'[]'::jsonb"],
    ['predecessor_metadata',"'{}'::jsonb,'[]'::jsonb"],
   ]){
    await c.query('SAVEPOINT app_frame209');await c.query('SET LOCAL ROLE dyna_app');let blocked=false;
    try{await c.query('SELECT public.order_merge_delivery209_'+name+'('+args+')');}
    catch(e){assert.equal(e.code,'42501');blocked=true;await c.query('ROLLBACK TO SAVEPOINT app_frame209');}
    await c.query('RELEASE SAVEPOINT app_frame209');assert(blocked,'Application cannot inject a local projection frame');receipt.local_frame_refusals[name]='42501';
   }
  }
  await c.query('ROLLBACK TO SAVEPOINT mutation209');await c.query('RELEASE SAVEPOINT mutation209');
  receipt.after=await healthy(c,l);
  if(fullRuntime)receipt.after.full_runtime=await healthyFullRuntime(c);
  assert.deepEqual(receipt.after,receipt.before);receipt.rollback_readback_exact=true;
 }catch(e){first=e;receipt.error={name:e.name,code:e.code??null,function_stack:safeFunctionStack(e.where)};}
 finally{
  if(began){try{await c.query('ROLLBACK');receipt.transaction_rolled_back=true;}catch(e){first??=e;receipt.transaction_rolled_back=false;}}
  try{await c.end();receipt.client_closed=true;}catch(e){first??=e;receipt.client_closed=false;}
  clientProfiles.delete(c);receipt.status=first?'FAIL':'PASS';await writeReceipt(l.receiptDirectory,title,receipt);
 }
 if(first)throw first;
}

/** Source22-only negatives: every public root is independently mutated under
 * its own savepoint. No timeout, SQL error unrelated to integrity, or inability
 * to perform the intended mutation can stand in for the expected refusal.
 */
async function mutateStartupRoots(c,kind){
 const profile=profileFor(c);assert.equal(profile,NATIVE209_SOURCE_QA_V22);const probes=[];
 for(const [index,key]of profile.startupKeys.entries()){
  const name=key.slice('public.'.length,-2);assert(/^[a-z_][a-z_0-9]*$/.test(name));
  const read=async()=> (await c.query(`SELECT to_jsonb(p) descriptor,pg_get_functiondef(p.oid) definition
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=$1 ORDER BY p.oid`,[name])).rows;
  const before=await read();assert.equal(before.length,1,'one genuine current root before mutation');
  await c.query('SAVEPOINT startup_root209');
  if(kind==='body'){
   const value=before[0];assert.equal(value.definition.split(value.descriptor.prosrc).length,2);
   await c.query(value.definition.replace(value.descriptor.prosrc,()=> '/* Source22 root body drift */'+value.descriptor.prosrc));
  }else if(kind==='header')await c.query('ALTER FUNCTION public.'+quote(name)+'() COST 101');
  else if(kind==='acl')await c.query('GRANT EXECUTE ON FUNCTION public.'+quote(name)+'() TO PUBLIC');
  else{assert.equal(kind,'overload');await c.query('CREATE FUNCTION public.'+quote(name)+"(integer) RETURNS boolean LANGUAGE sql AS 'SELECT true'");}
  assert.notDeepEqual(await read(),before,'the requested complete current root metadata really changed');
  const refusal209=await refused(c,'SELECT public.order_merge_delivery209_valid() valid');
  const refusalBuyer=await refused(c,'SELECT public.buyer_address_guards() valid');
  await projectionMapRefused(c,'Source22 private frame must reject '+kind+' drift of '+key);
  probes.push({signature:key,mutation:kind,refusal209,refusalBuyer,direct_map_refusal:'55000'});
  if(index<profile.startupKeys.length-1){await c.query('ROLLBACK TO SAVEPOINT startup_root209');assert.deepEqual(await read(),before,'full root descriptor and overload roster restored before next probe');}
  await c.query('RELEASE SAVEPOINT startup_root209');
 }
 assert.equal(probes.length,7);return{startup_root_probes:probes};
}
test('native209 healthy full closed metadata and unchanged old certificates',options,()=>scenario('healthy',null));
test('native209 healthy genuine full runtime173/187 and history adapters within individual8s budgets',options,()=>scenario('healthy-full-runtime',null,{fullRuntime:true}));
for(const[name,signature]of FULL_RUNTIME_HELPERS.map(signature=>[signature.slice('public.order_merge_delivery209_'.length,signature.indexOf('(')),signature]))
 test('native209 refuses own '+name+' body drift and restores exact state',options,()=>scenario('own-'+name+'-body',c=>mutateOwnHistoryBody(c,signature)));

const mutations=[
 ['extra-own-function',async c=>{
  await c.query("CREATE FUNCTION public.order_merge_delivery209_negative_extra() RETURNS boolean LANGUAGE sql AS 'SELECT true'");
  const identity=(await c.query("SELECT public.order_merge_delivery209_constraint_definition(k.oid)=pg_get_constraintdef(k.oid,true) literal FROM pg_constraint k WHERE k.conrelid='public.buyer_address_state'::regclass AND k.contype='p'")).rows;
  assert.deepEqual(identity,[{literal:true}],'Unchanged constraint identity preserves actual definition even when209 must refuse admission');
  const text=(await c.query("SELECT public.order_merge_delivery209_predecessor_source(p.oid)=p.prosrc source_one,public.order_merge_delivery209_predecessor_source(p.oid,'[]'::jsonb)=p.prosrc source_two,public.order_merge_delivery209_predecessor_definition(p.oid)=pg_get_functiondef(p.oid) definition_one,public.order_merge_delivery209_predecessor_definition(p.oid,NULL::jsonb)=pg_get_functiondef(p.oid) definition_two FROM pg_proc p WHERE p.oid='public.fa3_draft_fingerprint()'::regprocedure")).rows;
  assert.deepEqual(text,[{source_one:true,source_two:true,definition_one:true,definition_two:true}],'Unchanged text is actual even without a projection frame; no metadata drift is normalized');
 }],
 ['missing-own-helper',c=>c.query('DROP FUNCTION public.order_merge_delivery209_identity(uuid,uuid,uuid,text,text,boolean)')],
 ['own-table-acl',c=>c.query('GRANT SELECT ON public.order_merge_delivery209_receipts TO PUBLIC')],
 ['own-table-rls',c=>c.query('ALTER TABLE public.order_merge_delivery209_receipts DISABLE ROW LEVEL SECURITY')],
 ['own-table-extra-column',c=>c.query('ALTER TABLE public.order_merge_delivery209_receipts ADD COLUMN negative_extra text')],
 ['external-deferred-disabled',c=>c.query('ALTER TABLE public.order_merge_executions DISABLE TRIGGER order_merge_delivery209_complete')],
 ['external-deferred-dropped',c=>c.query('DROP TRIGGER order_merge_delivery209_complete ON public.order_merge_executions')],
 ['external-preview-disabled',c=>c.query('ALTER TABLE public.order_merge_previews DISABLE TRIGGER order_merge_delivery209_source_preview')],
 ['legacy-body',async c=>{const row=(await c.query("SELECT pg_get_functiondef('public.buyer_address_preview_guard()'::regprocedure) definition")).rows[0];assert(row.definition.includes('BEGIN'));await c.query(row.definition.replace('BEGIN','BEGIN /* real209negativebody */'));}],
 ['legacy-header',c=>c.query('ALTER FUNCTION public.buyer_address_state_guard() VOLATILE COST 101')],
 ['legacy-acl',c=>c.query('GRANT EXECUTE ON FUNCTION public.buyer_address_guards() TO PUBLIC')],
 ['scope-overload',async c=>{
  await c.query("CREATE FUNCTION public.buyer_address_guards(integer) RETURNS boolean LANGUAGE sql AS 'SELECT true'");
  for(const signature of ['public.buyer_address_guards()','public.buyer_address_guards(integer)']){
   await c.query('SAVEPOINT typed_oid_overload209');let denied=false;
   try{await c.query('SELECT public.partial_sale204_predecessor_definition($1::regprocedure)',[signature]);}
   catch(e){assert.equal(e.code,'55000','Only the complete current scope/null-frame integrity refusal counts');denied=true;await c.query('ROLLBACK TO SAVEPOINT typed_oid_overload209');}
   await c.query('RELEASE SAVEPOINT typed_oid_overload209');
   assert(denied,'Both the original mapped OID and unexpected overload must refuse: '+signature);
  }
 }],
 ['projection-basis-rls',c=>c.query('ALTER TABLE public.order_merge_delivery209_projection_basis DISABLE ROW LEVEL SECURITY')],
 ['projection-basis-acl',c=>c.query('GRANT SELECT ON public.order_merge_delivery209_projection_basis TO PUBLIC')],
 ['projection-generated-expression-dropped',c=>c.query('ALTER TABLE public.order_merge_delivery209_projection_basis ALTER COLUMN payload_jsonb DROP EXPRESSION')],
 ['projection-octets-generation-dropped',c=>dropProjectionExpression(c,'payload_octets')],
 ['projection-sha-generation-dropped',c=>dropProjectionExpression(c,'payload_sha256')],
 ['projection-octets-generation-constant',c=>constantProjectionExpression(c,'payload_octets')],
 ['projection-sha-generation-constant',c=>constantProjectionExpression(c,'payload_sha256')],
 ['projection-sha-dropped-spoofed-data',c=>sameByteProjectionTamper(c,{spoofDigest:true})],
 ['local-frame-selected-drift',async c=>{
  const frame=(await c.query('SELECT public.order_merge_delivery209_checked_projection_map() frame')).rows[0].frame;
  await c.query('ALTER FUNCTION public.manual_inventory_off_projection_valid() COST 101');
  for(const name of ['predecessor_source','predecessor_source_sha']){
   await c.query('SAVEPOINT stale_frame209');let denied=false;
   try{await c.query("SELECT public.order_merge_delivery209_"+name+"('public.manual_inventory_off_projection_valid()'::regprocedure,$1::jsonb)",[JSON.stringify(frame)]);}
   catch(e){assert.equal(e.code,'55000');denied=true;await c.query('ROLLBACK TO SAVEPOINT stale_frame209');}
   await c.query('RELEASE SAVEPOINT stale_frame209');assert(denied,'A previously captured local frame cannot hide current selected descriptor drift: '+name);
  }
 }],
 ['missing-own-row',async c=>{await c.query('ALTER TABLE public.order_merge_delivery209_manifest DISABLE TRIGGER order_merge_delivery209_manifest_immutable');await c.query('DELETE FROM public.order_merge_delivery209_manifest');}],
 ['authored-kind-check-dropped',async c=>{const rows=(await c.query("SELECT conname FROM pg_constraint WHERE conrelid='public.buyer_address_previews'::regclass AND contype='c' AND conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='public.buyer_address_previews'::regclass AND attname='kind')]::smallint[]")).rows;assert.equal(rows.length,1);await c.query('ALTER TABLE public.buyer_address_previews DROP CONSTRAINT '+quote(rows[0].conname));}],
 ['projection-data-tamper',c=>sameByteProjectionTamper(c)],
 ['source18-all-generated-dropped',c=>source18BatchTamper(c,'drop-generation')],
 ['source18-all-generation-same-values',c=>source18BatchTamper(c,'same-value-generation')],
 ['source18-all-raw-checks-dropped',c=>source18BatchTamper(c,'drop-check')],
 ['source18-all-raw-checks-not-valid',c=>source18BatchTamper(c,'unvalidated-check')],
 ['source18-all-raw-checks-weakened',c=>source18BatchTamper(c,'weakened-check')],
 ['source18-generated-column-acl',async c=>{
  await c.query('GRANT SELECT(projection_keys) ON public.order_merge_delivery209_projection_basis TO PUBLIC');
  const granted=(await c.query("SELECT EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x WHERE a.attrelid='public.order_merge_delivery209_projection_basis'::regclass AND a.attname='projection_keys' AND NOT a.attisdropped AND x.grantee=0 AND x.privilege_type='SELECT') allowed")).rows[0];
  assert.equal(granted.allowed,true);await projectionMapRefused(c,'Column ACL is part of current full metadata');
 }],
 ['source18-immutable-trigger-disabled',async c=>{
  await c.query('ALTER TABLE public.order_merge_delivery209_projection_basis DISABLE TRIGGER order_merge_delivery209_projection_immutable');
  const state=(await c.query("SELECT tgenabled enabled FROM pg_trigger WHERE tgrelid='public.order_merge_delivery209_projection_basis'::regclass AND tgname='order_merge_delivery209_projection_immutable'")).rows;
  assert.deepEqual(state,[{enabled:'D'}]);await projectionMapRefused(c,'Stored values do not excuse missing mutation protection');
 }],
];
for(const [name,mutate]of mutations)test('native209 refuses '+name+' and restores exact state',options,()=>scenario(name,mutate));
for(const [name,sql]of[
 ['projection-immutable-update',"UPDATE public.order_merge_delivery209_projection_basis SET payload=payload"],
 ['projection-immutable-delete','DELETE FROM public.order_merge_delivery209_projection_basis'],
 ['projection-immutable-truncate','TRUNCATE public.order_merge_delivery209_projection_basis'],
 ['manifest-immutable-update',"UPDATE public.order_merge_delivery209_manifest SET profile=profile"],
])test('native209 '+name+' refuses owner mutation',options,()=>scenario(name,c=>c.query(sql),{immutable:true}));

for(const kind of ['body','header','acl','overload'])
 test('native209 Source22 all seven public startup roots refuse '+kind+' drift',source22Options,()=>scenario('source22-startup-'+kind,c=>mutateStartupRoots(c,kind)));
for(const kind of ['body','header','acl','overload'])test('native209 Source22 all13 private runtime helpers refuse '+kind+' drift',source22Options,()=>scenario('source22-helper-'+kind,async c=>{
 const helpers=profileFor(c).fullRuntimeHelpers;assert.equal(helpers.length,13);const probes=[];
 for(const [index,signature]of helpers.entries()){
  const name=signature.slice('public.'.length,signature.indexOf('('));quote(name);
  const read=async()=> (await c.query('SELECT to_jsonb(p) descriptor,pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=\'public\' AND p.proname=$1 ORDER BY p.oid',[name])).rows;
  const before=await read();assert.equal(before.length,1,'exact one source-authenticated helper before mutation');
  await c.query('SAVEPOINT private_helper209');
  if(kind==='body')await mutateOwnHistoryBody(c,signature);
  else if(kind==='header')await c.query('ALTER FUNCTION '+signature+' COST 101');
  else if(kind==='acl')await c.query('GRANT EXECUTE ON FUNCTION '+signature+' TO PUBLIC');
  else {assert.equal(kind,'overload');await c.query('CREATE FUNCTION public.'+quote(name)+"(integer) RETURNS boolean LANGUAGE sql AS 'SELECT true'");}
  assert.notDeepEqual(await read(),before,'requested helper body/header/ACL/overload mutation really happened');
  const refusal209=await refused(c,'SELECT public.order_merge_delivery209_valid() valid');
  const refusalBuyer=await refused(c,'SELECT public.buyer_address_guards() valid');
  await projectionMapRefused(c,'private frame must reject '+kind+' drift of '+signature);
  probes.push({signature,mutation:kind,refusal209,refusalBuyer,direct_map_refusal:'55000'});
  if(index<helpers.length-1){await c.query('ROLLBACK TO SAVEPOINT private_helper209');assert.deepEqual(await read(),before,'complete helper descriptor and overload roster restored');}
  await c.query('RELEASE SAVEPOINT private_helper209');
 }
 assert.equal(probes.length,13);return{private_helper_probes:probes};
}));

test('Native209 locator fails closed before IO for preview/Main, wrong ownership and SQL substitution',async()=>{
 const valid={schema:'dynaminds-owned-native209-guard-qa/v1',databaseUrl:'postgresql://postgres:not-a-real-secret@127.0.0.1:57081/dynaminds_test_1792274000000',expectedDatabase:'dynaminds_test_1792274000000',expectedPort:57081,ownershipMarker:'dynaminds-source209-compiler:11111111-1111-4111-8111-111111111111',expected209SqlSha256:SOURCE209,expectedOldCertificatesSha256:'a'.repeat(64),receiptDirectory:'/tmp/dyna209-test-private'};
 assert.equal(validateNative209Locator(valid).expectedDatabase,valid.expectedDatabase);
 const v22={...valid,schema:NATIVE209_SOURCE_QA_V22.schema,runtimeRevision:22,sourceSqlPath:'/tmp/source22-candidate.sql',expected209SqlSha256:NATIVE209_SOURCE_QA_V22.sourceSha256};
 assert.equal(native209SourceQaProfile(validateNative209Locator(valid)),NATIVE209_SOURCE_QA_V1);
 assert.equal(native209SourceQaProfile(validateNative209Locator(v22)),NATIVE209_SOURCE_QA_V22);
 assert.equal(NATIVE209_SOURCE_QA_V1.legacyKeys.length,10);assert.equal(NATIVE209_SOURCE_QA_V1.columns.length,12);assert.equal(NATIVE209_SOURCE_QA_V1.fullRuntimeHelpers.length,8);
 assert.equal(NATIVE209_SOURCE_QA_V22.legacyKeys.length,17);assert.equal(new Set(NATIVE209_SOURCE_QA_V22.legacyKeys).size,17);assert.equal(NATIVE209_SOURCE_QA_V22.columns.length,19);assert.equal(NATIVE209_SOURCE_QA_V22.fullRuntimeHelpers.length,13);
 assert.deepEqual(NATIVE209_SOURCE_QA_V22.columns.slice(2).map(c=>c.name),Array.from({length:17},(_,i)=>'before_'+i));assert.equal(NATIVE209_SOURCE_QA_V22.startupKeys.length,7);assert.equal(NATIVE209_SOURCE_QA_V22.sourceBytes,28449419);
 for(const alter of [v=>delete v.runtimeRevision,v=>v.runtimeRevision=21,v=>v.runtimeRevision=23,v=>delete v.sourceSqlPath,v=>v.sourceSqlPath='../candidate.sql',v=>v.expected209SqlSha256=SOURCE209,v=>v.expected209SqlSha256='8b5c1f90883102db9ab3d55948e7ae22da388c1d8f29e8161bc8f28032af8757',v=>v.schema='auto',v=>v.expected209SqlSha256='a'.repeat(64),v=>v.ready=true]){const wrong={...v22};alter(wrong);assert.throws(()=>validateNative209Locator(wrong));}
 assert.throws(()=>validateNative209Locator({...valid,runtimeRevision:22}));assert.throws(()=>validateNative209Locator({...valid,sourceSqlPath:v22.sourceSqlPath}));

 for(const change of [{expectedDatabase:'dynaminds_preview'},{expected209SqlSha256:'0'.repeat(64)},{ownershipMarker:'copied-marker'},{databaseUrl:valid.databaseUrl.replace('127.0.0.1','example.com')},{receiptDirectory:'../relative'}])assert.throws(()=>validateNative209Locator({...valid,...change}));
 // Actual healthyFullRuntime function, controlled SQL replies only: these
 // checks cannot certify PG permissions/Native behavior or a compiled source.
 const controlled=(profile,alter={},seen=[])=>({async query(sql){
  seen.push(sql);
  if(sql.includes("current_setting('statement_timeout')"))return{rows:[{statement_timeout:alter.budget??'8s',lock_timeout:'8s'}]};
  if(sql.includes('has_function_privilege'))return{rows:profile.fullRuntimeHelpers.slice(alter.missingHelper?1:0).sort().map(signature=>({signature,denied:true}))};
  if(sql.includes('partial_sale204_predecessor_definition'))return{rows:[{literal:true}]};
  if(sql.includes('validation_snapshot() snapshot'))return{rows:[{fingerprint:'controlled',snapshot:{fingerprint:'controlled',legacy:profile.legacyKeys.slice(0,alter.legacyCount??profile.legacyKeys.length).map((key,i)=>({kind:'function',key:alter.duplicateFrame&&i===profile.legacyKeys.length-1?profile.legacyKeys[0]:key,value:Object.fromEntries(Array.from({length:24},(_,i)=>[String(i),null]))}))}}]};
  if(sql.includes('predecessor_source_sha'))return{rows:[{count:alter.shaCount??profile.legacyKeys.length,equal:alter.shaEqual??true}]};
  if(alter.helper&&sql.includes('SELECT '+alter.helper+'(wave.entries,wave.wave_ok)')){
   if(alter.timeout){const e=Error('controlled timeout');e.code='57014';throw e;}
   return{rows:alter.missing?[]:[{valid:alter.value}]};
  }
  if(sql===alter.capability){if(alter.timeout){const e=Error('controlled timeout');e.code='57014';throw e;}return{rows:alter.missing?[]:[{valid:alter.value}]};}
  return{rows:[{valid:true}]};
 }});
 for(const profile of [NATIVE209_SOURCE_QA_V1,NATIVE209_SOURCE_QA_V22]){const seen=[],c=controlled(profile,{},seen);clientProfiles.set(c,profile);try{const r=await healthyFullRuntime(c);assert.equal(r.private_helpers.length,profile.fullRuntimeHelpers.length);assert.equal(r.per_query_timeout_ms,8000);
  const sharedQueries=seen.filter(sql=>sql.includes('(wave.entries,wave.wave_ok)'));assert.equal(sharedQueries.length,profile===NATIVE209_SOURCE_QA_V22?4:0);
  for(const sql of sharedQueries){assert(sql.includes('public.order_merge_delivery209_checked_projection_map() entries'));assert(sql.includes('public.wave_print177_valid() wave_ok'));assert(sql.includes('AND wave.wave_ok IS NOT DISTINCT FROM true'));assert(!sql.includes('true wave_ok'));}
 }finally{clientProfiles.delete(c);}}
 const sharedHelperNames=NATIVE209_SOURCE_QA_V22.fullRuntimeHelpers.filter(signature=>signature.startsWith('public.order_merge_delivery209_pim_')).map(signature=>signature.slice(0,signature.indexOf('(')));
 for(const alter of [{budget:'16s'},{missingHelper:true},{legacyCount:10},{duplicateFrame:true},{shaCount:16},{shaEqual:false},...['pim_dictionary_valid','nested172_valid','parcel_physical_wz_valid','operative_delivery_valid'].flatMap(name=>[false,null,'missing','timeout'].map(value=>({capability:'SELECT public.'+name+'() AS valid',value,missing:value==='missing',timeout:value==='timeout'}))),...sharedHelperNames.flatMap(helper=>[false,null,'missing','timeout'].map(value=>({helper,value,missing:value==='missing',timeout:value==='timeout'})))]){
  const c=controlled(NATIVE209_SOURCE_QA_V22,alter);clientProfiles.set(c,NATIVE209_SOURCE_QA_V22);
  try{await assert.rejects(healthyFullRuntime(c),e=>alter.timeout?e.code==='57014':e.code==='ERR_ASSERTION');}finally{clientProfiles.delete(c);}
 }

});
