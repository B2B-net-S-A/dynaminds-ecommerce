/** SOURCE_ONLY / NOT_RUN. Root calls on a fresh TEMPLATE clone of quiet valid164.
 * No connection/config/app import at module evaluation. Caller owns client/DB;
 * this helper owns only the dynamically imported migration pool. No dump/restore
 * claim is made here; exported capture/compare support that separate root gate. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {lstat,readFile,realpath,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import type {Client} from 'pg';
type Row=Record<string,any>;
type Artifact={path:string;sha256:string};
const ledger='165_competitor_observation_portability';
const profile='164-original-to165-portable-constraints/v1';
const one=(rows:Row[])=>{assert.equal(rows.length,1);return rows[0];};
const raw=(s:Row,t:string):Row[]=>s.graph.rows[t].map((x:Row)=>x.row);
const hash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
async function pinned(a:Artifact,privateFile=false){const p=resolve(a.path),s=await lstat(p);assert(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1);assert.equal(await realpath(p),p);if(privateFile)assert.equal(s.mode&0o777,0o600);assert.match(a.sha256,/^[a-f0-9]{64}$/);assert.equal(hash(await readFile(p)),a.sha256);}
async function pinSources(pins:Record<string,string>){assert.equal(pins['server/165_competitor_observation_portability.sql'],'f7f7b806411fd082b89429152373db7a4e7742830abf9f2d35f7998fb6650422','Exact reviewed165 SQL');for(const p of ['server/db.ts','server/163_competitor_observations.sql','server/164_competitor_observation_batch_scale.sql','server/165_competitor_observation_portability.sql','data/source-drafts/competitor-observations165-portability-native.ts','data/source-drafts/b2b-financial-return162-root-capture189.ts'])assert(p in pins,'Mandatory pin '+p);for(const[path,sha256]of Object.entries(pins))await pinned({path,sha256});}
async function save(dir:string,name:string,value:unknown){const p=resolve(dir,name),b=Buffer.from(JSON.stringify(value,null,2)+'\n');await writeFile(p,b,{flag:'wx',mode:0o600});return{path:p,sha256:hash(b)};}
/** Separate whole snapshots, including exact metadata; no nested transaction. */
export async function captureCompetitorPortability165(c:Client,expectedLedger:164|165){
 const {captureDatabase,guardNames}=await import('./b2b-financial-return162-root-capture189');
 const s=await captureDatabase(c,false);assert.equal(Object.keys(s.graph.rows).length,556);assert.equal(s.graph.rows.migrations.length,expectedLedger);
 assert.deepEqual(Object.keys(s.guards).sort(),[...guardNames,'financial_return_upgrade_valid'].sort());assert(Object.values(s.guards).every(v=>v===true));
 await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');try{
  const facts:Row={};for(const zone of ['UTC','Europe/Warsaw']){await c.query("SELECT set_config('TimeZone',$1,true)",[zone]);facts[zone]=one((await c.query('SELECT competitor_observation_fingerprint() fingerprint,competitor_observation_guards() guard,competitor_observation_available() available')).rows);assert.equal(facts[zone].guard,true);assert.equal(facts[zone].available,true);}assert.deepEqual(facts.UTC,facts['Europe/Warsaw']);
  await c.query("SET LOCAL TimeZone='UTC'");
  const definitions=(await c.query("SELECT p.oid::regprocedure::text signature,pg_get_functiondef(p.oid) definition FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'competitor_observation%' ORDER BY 1")).rows;
  const functionFacts=one((await c.query("SELECT jsonb_object_agg(p.proname,jsonb_build_object('definition',pg_get_functiondef(p.oid),'body',p.prosrc,'body_sha256',encode(sha256(convert_to(p.prosrc,'UTF8')),'hex'),'owner',pg_get_userbyid(p.proowner),'acl',(SELECT jsonb_agg(jsonb_build_object('grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,'grantor',pg_get_userbyid(a.grantor),'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY a.grantee=0,pg_get_userbyid(a.grantee),pg_get_userbyid(a.grantor),a.privilege_type) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a),'app_execute',has_function_privilege('dyna_app',p.oid,'EXECUTE'))) value FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'competitor_observation%'")).rows).value;
  const triggerFacts=one((await c.query("SELECT jsonb_object_agg(t.tgname,pg_get_triggerdef(t.oid)) value FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname LIKE 'competitor_observation%'")).rows).value;
  const constraints=(await c.query("SELECT t.relname,k.conname,pg_get_constraintdef(k.oid) raw,pg_get_constraintdef(k.oid,true) canonical FROM pg_constraint k JOIN pg_class t ON t.oid=k.conrelid WHERE t.relnamespace='public'::regnamespace AND t.relname LIKE 'competitor_observation%' ORDER BY 1,2")).rows;
  await c.query('COMMIT');assert.deepEqual(await captureDatabase(c,false),s,'Quiet whole556 snapshot fence');return{...s,guards:{...s.guards,competitor_observation_guards:true},family:{facts,definitions,functionFacts,triggerFacts,constraints}};
 }catch(e){await c.query('ROLLBACK');throw e;}
}
/** Portable public catalog fields, full rows/PK/sequences/views/guards. Exact OID
 * metadata is retained in artifacts but is not a cross-database identity claim. */
export function assertCompetitorPortability165Copy(source:Row,copy:Row){
 for(const k of ['guards','primary_keys','sequences','views'])assert.deepEqual(copy[k],source[k],k);
 assert.deepEqual(copy.graph.rows,source.graph.rows);assert.deepEqual(copy.graph.metadata,source.graph.metadata);
 assert.deepEqual(copy.family.facts,source.family.facts);assert.deepEqual(copy.family.definitions,source.family.definitions);assert.deepEqual(copy.family.functionFacts,source.family.functionFacts);assert.deepEqual(copy.family.triggerFacts,source.family.triggerFacts);
 assert.deepEqual(copy.family.constraints.map(({raw:_raw,...r}:Row)=>r),source.family.constraints.map(({raw:_raw,...r}:Row)=>r),'Only canonical constraint representation compared across databases');
}
function assertUpgrade(before:Row,after:Row){
 assert.deepEqual(after.guards,before.guards);for(const k of ['primary_keys','sequences','views'])assert.deepEqual(after[k],before[k]);assert.deepEqual(Object.keys(after.graph.rows),Object.keys(before.graph.rows));
 for(const[t,rows]of Object.entries(before.graph.rows)){if(t==='migrations'){assert.deepEqual(after.graph.rows[t].filter((r:Row)=>r.row.name!==ledger),rows);assert.equal(raw(after,t).filter(r=>r.name===ledger).length,1);}else if(t!=='competitor_observation_manifest')assert.deepEqual(after.graph.rows[t],rows,'All old rows '+t);}
 const old=one(raw(before,'competitor_observation_manifest')),now=one(raw(after,'competitor_observation_manifest')),cert=now.portability_upgrade;
 assert.deepEqual(Object.keys(now).sort(),[...Object.keys(old),'portability_upgrade'].sort());const {portability_upgrade:addedCertificate,...unchangedManifest}=now;assert.deepEqual(unchangedManifest,old);assert.deepEqual(addedCertificate,cert);assert.deepEqual(now.scale_upgrade,old.scale_upgrade);
 assert.equal(cert.profile,profile);assert.deepEqual(cert.original_manifest,old);assert.equal(cert.predecessor_fingerprint,old.fingerprint);assert.equal(now.fingerprint,old.fingerprint);assert.equal(now.scale_upgrade.successor_fingerprint,old.fingerprint);assert.equal(after.family.facts.UTC.fingerprint,cert.successor_fingerprint);assert.notEqual(cert.successor_fingerprint,old.fingerprint);assert.deepEqual(Object.keys(cert).sort(),['original_manifest','predecessor_fingerprint','predecessor_functions','predecessor_triggers','profile','successor_fingerprint']);assert.deepEqual(cert.predecessor_functions,before.family.functionFacts);assert.deepEqual(cert.predecessor_triggers,before.family.triggerFacts);assert.equal(Object.keys(cert.predecessor_functions).length,12);
 const allowedFunctions=new Set(['competitor_observation_fingerprint()','competitor_observation_guards()']);
 for(const section of ['tables','functions','triggers']){
  const oldMeta=before.graph.metadata[section],newMeta=after.graph.metadata[section];
  if(section==='tables')assert.deepEqual(newMeta.filter((x:Row)=>x.relname!=='competitor_observation_manifest'),oldMeta.filter((x:Row)=>x.relname!=='competitor_observation_manifest'));
  if(section==='functions')assert.deepEqual(newMeta.filter((x:Row)=>!allowedFunctions.has(x.signature)),oldMeta.filter((x:Row)=>!allowedFunctions.has(x.signature)));
  if(section==='triggers')assert.deepEqual(newMeta,oldMeta,'Portable triggers unchanged');
 }
 const oldTable=one(before.graph.metadata.tables.filter((x:Row)=>x.relname==='competitor_observation_manifest')),newTable=one(after.graph.metadata.tables.filter((x:Row)=>x.relname==='competitor_observation_manifest'));
 const column=one(newTable.columns.filter((x:Row)=>x.name==='portability_upgrade'));assert.deepEqual(column,{name:'portability_upgrade',position:oldTable.columns.length+1,type:'jsonb',not_null:false,generated:'',identity:'',default:null,collation:null,acl:[]});
 const constraint=one(newTable.constraints.filter((x:Row)=>x.name==='competitor_observation_manifest_portability_upgrade_check'));assert.equal(constraint.type,'c');assert.equal(constraint.validated,true);assert.equal(constraint.deferred,false);assert.equal(constraint.deferrable,false);
 assert.deepEqual({...newTable,columns:newTable.columns.filter((x:Row)=>x.name!=='portability_upgrade'),constraints:newTable.constraints.filter((x:Row)=>x.name!==constraint.name)},oldTable,'Only one known nullable column and its check added');
 const oldExact=before.graph.exact_metadata,newExact=after.graph.exact_metadata;
 assert.deepEqual(newExact.relations,oldExact.relations,'Every existing relation OID/owner/ACL/flags literal');
 for(const fn of oldExact.functions){const current=one(newExact.functions.filter((x:Row)=>x.oid===fn.oid));if(!allowedFunctions.has(fn.signature))assert.deepEqual(current,fn);else{
  const {prosrc:oldBody,...oldMeta}=fn.meta,{prosrc:newBody,...newMeta}=current.meta;assert.deepEqual(newMeta,oldMeta,'Replaced function keeps OID/owner/ACL/config/arguments');assert.equal(current.signature,fn.signature);assert.equal(current.definition.replace(newBody,oldBody),fn.definition,'Only function body changes');
  if(fn.signature==='competitor_observation_fingerprint()')assert.equal(newBody,oldBody.replace('pg_get_constraintdef(c.oid)','pg_get_constraintdef(c.oid,true)'));
 }}assert.equal(newExact.functions.length,oldExact.functions.length);
 for(const trigger of oldExact.triggers){const current=one(newExact.triggers.filter((x:Row)=>x.relname===trigger.relname&&x.meta.tgname===trigger.meta.tgname));if(trigger.relname==='competitor_observation_manifest'&&trigger.meta.tgname==='competitor_observation_manifest_immutable'){
  const {oid:oldOid,...oldMeta}=trigger.meta,{oid:newOid,...newMeta}=current.meta;assert.notEqual(newOid,oldOid);assert.deepEqual(newMeta,oldMeta);assert.deepEqual({...current,oid:trigger.oid,meta:trigger.meta},trigger,'Only immutable trigger OID recreated');
 }else assert.deepEqual(current,trigger);}assert.equal(newExact.triggers.length,oldExact.triggers.length);
 for(const table of oldExact.tables){const current=one(newExact.tables.filter((x:Row)=>x.oid===table.oid));if(table.relname!=='competitor_observation_manifest')assert.deepEqual(current,table);else{
  const added=one(current.columns.filter((x:Row)=>x.attname==='portability_upgrade'));assert.equal(added.atttypid,3802);assert.equal(added.attnotnull,false);assert.equal(added.atthasdef,false);assert.equal(added.attnum,table.columns.length+1);
  const newCheck=one(current.constraints.filter((x:Row)=>x.meta.conname===constraint.name));assert.equal(newCheck.meta.contype,'c');assert.equal(newCheck.meta.convalidated,true);assert.equal(newCheck.meta.conrelid,table.oid);assert.deepEqual({...current,columns:current.columns.filter((x:Row)=>x.attname!==added.attname),constraints:current.constraints.filter((x:Row)=>x.meta.conname!==constraint.name)},table,'All existing manifest exact columns/constraints/indexes/security literal');
 }}assert.equal(newExact.tables.length,oldExact.tables.length);

}
export async function runCompetitorObservations165PortabilityNative(input:{client:Client;database:string;sourceConfig:Artifact;directory:string;sources:Record<string,string>;expected164:Row}){
 assert.match(input.database,/^dynaminds_test_[0-9]{13}$/);assert.equal(process.env.DYNA_TEST,'true');assert.equal(process.env.DYNA_WORKER_DISABLED,'true');assert.equal(resolve(process.env.DYNA_LOCAL_CONFIG_PATH??''),resolve(input.sourceConfig.path));
 const u=new URL(process.env.DATABASE_URL??'');assert.equal(u.hostname,'127.0.0.1');assert.equal(u.port,'55432');assert.equal(u.pathname,'/'+input.database);assert.equal(u.username,'postgres');await pinned(input.sourceConfig,true);await pinSources(input.sources);
 const dir=resolve(input.directory),d=await lstat(dir);assert(d.isDirectory()&&!d.isSymbolicLink());assert.equal(d.mode&0o777,0o700);
 const c=input.client;assert.deepEqual(one((await c.query('SELECT current_database() db,session_user owner,inet_server_port() port')).rows),{db:input.database,owner:'postgres',port:55432});
 let runtime:typeof import('../../server/db')|undefined;let failure:unknown;let result:Row|undefined;const journal:Row[]=[];
 try{
  const before=await captureCompetitorPortability165(c,164);assertCompetitorPortability165Copy(input.expected164,before);assert.equal(raw(before,'migrations').filter(r=>r.name===ledger).length,0);const beforeArtifact=await save(dir,'before164.private.json',before);
  runtime=await import('../../server/db');await runtime.migrate();const after=await captureCompetitorPortability165(c,165);assertUpgrade(before,after);const afterArtifact=await save(dir,'after165.private.json',after);
  await runtime.migrate();assert.deepEqual(await captureCompetitorPortability165(c,165),after,'Managed migration replay is complete no-op');
  const probe=async(name:string,ddl:string)=>{await c.query('BEGIN');try{await c.query("SET LOCAL TimeZone='UTC'");await c.query(ddl);const f=one((await c.query('SELECT competitor_observation_fingerprint() fingerprint,competitor_observation_guards() guard')).rows);assert.notEqual(f.fingerprint,one(raw(after,'competitor_observation_manifest')).portability_upgrade.successor_fingerprint);assert.equal(f.guard,false);await assert.rejects(()=>c.query('SELECT competitor_observation_available()'),(e:unknown)=>(e as {code?:string}).code==='55000');journal.push({case:name,guard:false,availability_code:'55000',same_client:true,http_claim:false});}finally{await c.query('ROLLBACK');}assert.deepEqual(await captureCompetitorPortability165(c,165),after,'Full556 exact after probe rollback');};
  await probe('semantic_price_check',"ALTER TABLE public.competitor_observations DROP CONSTRAINT competitor_observations_price_gross_minor_check; ALTER TABLE public.competitor_observations ADD CONSTRAINT competitor_observations_price_gross_minor_check CHECK(price_gross_minor BETWEEN 0 AND 100000001)");
  await probe('statement_matcher_disabled','ALTER TABLE public.competitor_observations DISABLE TRIGGER competitor_observation_rows_match_request');
  await pinSources(input.sources);await pinned(input.sourceConfig,true);result={status:'ROOT_NATIVE_COMPETITOR165_INSTALL_REPLAY_ROLLBACK_PASS',database:input.database,before:beforeArtifact,after:afterArtifact,tables:556,migrations:165,guards:21,original164_manifest_and_scale_certificate_literal:true,all_old_rows_except_manifest_literal:true,managed_migration_replay:true,probes:journal,actual_dump_restore_executed:false,caller_client_and_database_closure_required:true};
 }catch(e){failure=e;}finally{if(runtime){try{await runtime.pool.end();}catch(e){failure??=e;}}}
 if(failure){await save(dir,'failure.private.json',{status:'FAILED',error_name:failure instanceof Error?failure.name:'Unknown',journal,business_acceptance:false});throw failure;}
 assert(result);await pinSources(input.sources);await pinned(input.sourceConfig,true);return await save(dir,'result.private.json',{...result,migration_pool_closed:true});
}
