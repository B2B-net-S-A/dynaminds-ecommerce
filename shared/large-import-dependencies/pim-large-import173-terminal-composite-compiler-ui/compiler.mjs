import assert from 'node:assert/strict';
import {readFile,lstat} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {sourceContract,sources,queryRef,sha,canonicalSignature,readSources,admitSourceSelection} from './source.mjs';
const detach=x=>structuredClone(x),same=(a,b)=>assert.deepEqual(a,b);
const literal=x=>JSON.stringify(x).replaceAll("'","''");
const sorted=x=>[...x].sort();
export const remnantQuery=`SELECT EXISTS(SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace AND (starts_with(relname,'large_import_') OR starts_with(relname,'large_import173_')))
 OR EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND (starts_with(proname,'large_import_') OR starts_with(proname,'large_import173_')))
 OR EXISTS(SELECT 1 FROM pg_type WHERE typnamespace='public'::regnamespace AND (starts_with(typname,'large_import_') OR starts_with(typname,'large_import173_') OR starts_with(typname,'_large_import_') OR starts_with(typname,'_large_import173_')))
 OR EXISTS(SELECT 1 FROM pg_constraint WHERE connamespace='public'::regnamespace AND (starts_with(conname,'large_import_') OR starts_with(conname,'large_import173_')))
 OR EXISTS(SELECT 1 FROM pg_trigger WHERE starts_with(tgname,'large_import_') OR starts_with(tgname,'large_import173_'))
 OR EXISTS(SELECT 1 FROM pg_policy WHERE starts_with(polname,'large_import_') OR starts_with(polname,'large_import173_')) AS remnants;`;
/** Returns an executable ordered capture specification, but does not open connections or execute it. */
export function prepareCompositeCapture(selection){
 const selected=admitSourceSelection(selection);
 const contract=sourceContract(),loaded=readSources();
 // Keep the kernel before current-admit so the certificate rowtype and leaf exist at SQL function creation.
 // No kernel invocation or certificate INSERT before every added descriptor is captured.
 const ddl=loaded.map(x=>x.sql).join('\n'),catalog=readFileSync(queryRef.path,'utf8');
 const capture_sql="SET LOCAL search_path=pg_catalog,public; SET LOCAL TimeZone='UTC'; SET LOCAL standard_conforming_strings=on;\n"+ddl+'\nSELECT profile,profile::text AS native_text,encode(sha256(convert_to(profile::text,\'UTF8\')),\'hex\') AS native_sha256 FROM ('+catalog.trim().replace(/;$/,'')+') composite173;';
 return {schema:'large-import173-composite-capture/v1',selection:selected,source_graph:contract.source_graph,source_contract_sha256:sha(JSON.stringify(contract)),catalog_query:queryRef,
 settings:{search_path:'pg_catalog,public',TimeZone:'UTC',standard_conforming_strings:'on'},
 prerequisites:{original_583_rows_sequences_literal:true,parent_guards:28,zones:['UTC','Europe/Warsaw'],protected_baseline:'actual Root-owned latest closed union',exclusive_owner:true,reserved_families_absent:true},
 remnant_sql:remnantQuery,capture_sql,capture_sql_sha256:sha(capture_sql),ddl_sql:ddl,ddl_sha256:sha(ddl),catalog_sql:readFileSync(queryRef.path,'utf8'),
 transaction:'ROOT_BEGIN_REPEATABLE_READ_DDL_AND_EXACT_QUERY_THEN_ALWAYS_ROLLBACK',certificate_rows_inserted:0,ledger_rows_appended:0,activation:'NOT_APPLY_READY'};
}
/** Source inventory checks are additional to mandatory full independently reviewed native deparse equality. */
export function assertCompositeInventory(profile0,owner0){
 const p=detach(profile0),owner=owner0,c=sourceContract();assert(typeof owner==='string'&&owner!=='dyna_app'&&owner!=='PUBLIC');
 same(sorted(p.relations.map(t=>t.name)),sorted(c.relations.map(t=>t.name)));
 // Generated index names are bound by mandatory independently reviewed native profile, not guessed truncation of long names.
 const expectedIndexes=p.relations.flatMap(t=>t.indexes.map(i=>i.name));assert.equal(new Set(expectedIndexes).size,expectedIndexes.length);
 for(const i of c.indexes){const t=p.relations.find(t=>t.name===i.relation);assert(t?.indexes.some(x=>x.name===i.name),'missing exact explicit index');}
 same(sorted(p.classes.map(t=>t.name)),sorted([...c.relations.map(t=>t.name),...expectedIndexes]));
 same(sorted(p.types.map(t=>t.name)),sorted(c.relations.flatMap(t=>[t.name,'_'+t.name])));
 same(sorted(p.functions.map(f=>canonicalSignature(f.signature))),sorted(c.functions.map(f=>f.signature)));
 for(const f of c.functions){const a=p.functions.find(x=>canonicalSignature(x.signature)===f.signature);for(const k of ['body_sha256','result','language','security_definer','volatility','strict','configuration','defaults'])same(a[k],f[k]);
 for(const [k,v]of Object.entries({owner,leakproof:false,parallel:'u',kind:'f',returns_set:false}))same(a[k],v);
 same(a.acl.map(x=>x.slice()).sort(),[[owner,owner,'EXECUTE',false],...(f.app_execute?[[owner,'dyna_app','EXECUTE',false]]:[])].sort());}
 for(const t of c.relations){const a=p.relations.find(x=>x.name===t.name);assert(a);same(a.owner,owner);same(a.kind,'r');same(a.persistence,'p');same(a.columns.length,t.columns.length);
 for(let i=0;i<t.columns.length;i++){const col=t.columns[i],native=a.columns[i];same(native.name,col.name);same(native.type,col.type==='timestamptz'?'timestamp with time zone':col.type);same(native.not_null,col.not_null);same(native.position,i+1);same(native.dropped,false);same(native.identity,'');same(native.generated,'');same(native.has_missing,false);same(native.missing_value,null);same(native.acl,[]);}
 const kinds={n:t.columns.filter(x=>x.not_null).length,c:t.checks,p:1,u:t.unique,f:t.foreign_keys};same(a.constraints.length,Object.values(kinds).reduce((x,y)=>x+y,0));for(const[k,n]of Object.entries(kinds))same(a.constraints.filter(x=>x.kind===k).length,n);
 for(const k of a.constraints){assert(k.validated&&k.enforced&&k.local&&!k.period&&!k.deferrable&&!k.deferred&&k.parent===null&&k.inheritance_count===0);}
 const isCert=t.module==='kernel',isQuota=t.module==='quota'||t.module==='terminal';same(a.rls,!isCert);same(a.force_rls,!isCert);same(a.policies.length,isCert?0:1);same(a.triggers.length,c.triggers.filter(x=>x.relation===t.name).length);
 for(const tr of c.triggers.filter(x=>x.relation===t.name)){const n=a.triggers.find(x=>x.name===tr.name);assert(n);same(canonicalSignature(n.function),tr.function);same(n.type,tr.type);same(n.enabled,'O');same(n.arguments_hex,'');same(n.parent,null);same(n.deferrable,false);same(n.deferred,false);}
 const app=isCert||isQuota?[]:['INSERT','SELECT',...(['large_import_jobs173','large_import_blobs173'].includes(t.name)?['UPDATE']:[])];same(sorted(a.acl.filter(x=>x[1]==='dyna_app').map(x=>x[2])),sorted(app));assert(a.acl.every(x=>x[0]===owner&&[owner,'dyna_app'].includes(x[1])&&!x[3]));
 const pol=a.policies[0];if(pol){same(pol.roles,isQuota?['PUBLIC']:['dyna_app']);same(pol.command,'*');same(pol.permissive,true);same(pol.using,pol.check);}
 same(a.indexes.length,1+t.unique+c.indexes.filter(i=>i.relation===t.name).length);same(a.indexes.filter(i=>i.primary).length,1);same(a.indexes.filter(i=>i.unique&&!i.primary).length,t.unique);
 const pk=a.constraints.find(k=>k.kind==='p');same(pk.columns,t.primary);
assert(a.indexes.every(i=>i.owner===owner&&i.valid&&i.ready&&i.live&&i.access_method==='btree'&&!i.clustered&&!i.replica_identity&&i.options===null));
 }
 for(const x of p.classes){same(x.owner,owner);same(x.persistence,'p');same(x.kind,c.relations.some(t=>t.name===x.name)?'r':'i');}
 same(p.ri.length,c.counts.ri);assert(p.ri.every(x=>x.enabled==='O'&&!x.deferrable&&!x.deferred));
 for(const kind of ['constraints','triggers','policies'])assert(p.reserved[kind].every(x=>c.relations.some(t=>t.name===x.relation.replace(/^public\./,''))));
 assert(p.namespace&&Array.isArray(p.default_acl)&&Array.isArray(p.roles)&&Array.isArray(p.memberships));
 return {status:'COMPOSITE_SOURCE_STRUCTURE_VERIFIED',descriptor_parity:'REQUIRES_INDEPENDENT_EXACT_PROFILE',counts:c.counts};
}
async function checked(ref,refs,privateFile=false){assert(ref&&typeof ref.path==='string'&&/^[a-f0-9]{64}$/.test(ref.sha256));const s=await lstat(ref.path);assert(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1);if(privateFile)assert.equal(s.mode&0o777,0o600);const b=await readFile(ref.path);assert.equal(sha(b),ref.sha256);refs.push({...detach(ref),privateFile});return b;}
async function json(ref,refs,privateFile=false){return JSON.parse((await checked(ref,refs,privateFile)).toString('utf8'));}
/** Root supplies explicitly reviewed immutable evidence refs; no connection, app, certificate, migration or write is performed here. */
export async function compileReviewedComposite(input0){
 const input=detach(input0),refs=[];
 const selectedFile=await json(input.selection_ref,refs);same(selectedFile,input.selection);
 const contract=sourceContract(),capture=prepareCompositeCapture(input.selection);
 assert.equal(input.authorization,'ROOT_AUTHORIZED_PURE_173_COMPOSITE_COMPILATION_NO_PG');
 for(const r of [...input.selection.source_manifests,input.selection.quota_peer,input.selection.terminal_peer,input.selection.publisher_peer])await checked(r,refs);
 for(const s of sources)await checked(s.ref,refs);const query=await checked(queryRef,refs);
 const expectation=await json(input.expectation,refs,true),authority=await json(input.authority_peer,refs,true),proof=await json(input.native_proof,refs,true),peer=await json(input.native_peer,refs,true);
 assert.equal(expectation.schema,'large-import173-independent-composite-expectation/v1');same(expectation.source_graph,contract.source_graph);same(expectation.catalog_query,queryRef);same(expectation.source_contract_sha256,capture.source_contract_sha256);same(expectation.origin,'INDEPENDENT_REVIEWED_SOURCE_DDL_EXPECTATION');
 assert.equal(authority.status,'EXTERNAL_173_COMPOSITE_SOURCE_EXPECTATION_REVIEWED');same(authority.expectation,input.expectation);same(authority.source_graph,contract.source_graph);same(authority.catalog_query,queryRef);same(authority.concrete_remaining_source_blockers,[]);same(authority.selection,input.selection_ref);same(authority.arbitrary_installation_after_authority,false);
 const authorityManifest=await json(input.authority_manifest,refs);assert.equal(authorityManifest.status,'FROZEN_173_COMPOSITE_SOURCE_NATIVE_EXPECTATION_AUTHORITY');same(authority.pins_sha256,input.authority_manifest.sha256);/* The separately hashed authority peer binds this manifest; including that peer here would create a SHA fixed-point cycle. */assert(authorityManifest.files.some(r=>r.path===input.expectation.path&&r.sha256===input.expectation.sha256));for(const r of authorityManifest.files)await checked(r,refs);
 same(proof.status,'ROOT173_COMPOSITE_EXACT_QUERY_ROLLBACK_PROOF');same(proof.source_graph,contract.source_graph);same(proof.selection,input.selection_ref);same(proof.ddl_sha256,capture.ddl_sha256);same(proof.catalog_query,queryRef);same(proof.profile_sha256,sha(JSON.stringify(expectation.profile)));same(proof.profile,expectation.profile_ref);same(proof.no_certificate_install,true);same(proof.rolled_back,true);
 same(peer.status,'ARTIFACT_ONLY_173_COMPOSITE_PROFILE_ROLLBACK_VERIFIED');same(peer.proof,input.native_proof);same(peer.result,proof.result);same(peer.terminal,proof.terminal);same(peer.profile,proof.profile);same(peer.source_graph,contract.source_graph);same(peer.concrete_remaining_blockers,[]);same(peer.full_583_preserved,true);same(peer.guards_28_both_zones,true);same(peer.complete_custody,true);
 const result=await json(proof.result,refs,true),terminal=await json(proof.terminal,refs,true),raw=await json(proof.profile,refs,true);
 same(result.status,'ROOT173_EXPANDED_SOURCE_DDL_EXACT_QUERY_ROLLBACK_CLOSED_PASS');same(result.error,null);same(result.cleanup_errors,[]);same(result.source_graph,contract.source_graph);same(result.selection,input.selection_ref);same(result.source_contract_sha256,capture.source_contract_sha256);same(result.ddl_sha256,capture.ddl_sha256);same(result.source_inventory_verified,true);same(result.profile,proof.profile);assert(result.transaction_rolled_back&&result.all_clients_closed);same(result.identity.role,expectation.owner);same(result.app_invocations,0);same(result.provider_calls,0);same(result.certificate_rows_inserted,0);same(result.ledger_rows_appended,0);
 same(terminal.result,proof.result);same(terminal.exit_code,0);same(terminal.ok,true);assert(terminal.artifacts.some(r=>r.path===proof.profile.path&&r.sha256===proof.profile.sha256));for(const r of terminal.artifacts)await checked(r,refs,true);
 const resultCapture=await json(result.capture_spec,refs,true);same(resultCapture,capture);same(raw.query,queryRef);
 same(raw.profile,expectation.profile);same(JSON.parse(raw.native_text),raw.profile);same(sha(raw.native_text),raw.native_sha256);same(sha(JSON.stringify(raw.profile)),proof.profile_sha256);
 same(proof.profile_native_sha256,raw.native_sha256);same(authority.profile_sha256,proof.profile_sha256);same(authority.profile_native_sha256,raw.native_sha256);assertCompositeInventory(raw.profile,expectation.owner);
 // Review matrix is separately pinned; native capture is evidence, never its own permission to alter expected descriptors.
 await checked(authority.review_matrix,refs,true);
 const sql=capture.ddl_sql+'\nDO $composite173$ DECLARE expected jsonb:=\''+literal(expectation.profile)+'\'::jsonb; actual jsonb; BEGIN\n'+
 " IF current_user<>session_user THEN RAISE EXCEPTION 'Owner-only composite173 bootstrap' USING ERRCODE='42501';END IF;\n"+
 " actual:=public.large_import173_metadata();IF actual IS DISTINCT FROM expected OR encode(sha256(convert_to(actual::text,'UTF8')),'hex')<>'"+raw.native_sha256+"' OR public.large_import173_parents_valid() IS DISTINCT FROM true THEN RAISE EXCEPTION 'Complete source-certified173 graph differs' USING ERRCODE='23514';END IF;\n"+
 " INSERT INTO public.large_import173_certificate SELECT true,expected,encode(sha256(convert_to(expected::text,'UTF8')),'hex'),public.large_import173_predecessor_map(),encode(sha256(convert_to(public.large_import173_predecessor_map()::text,'UTF8')),'hex'),'"+sources[0].ref.sha256+"';\n"+
 " IF (SELECT count(*) FROM public.large_import173_certificate)<>1 OR public.large_import173_valid() IS DISTINCT FROM true THEN RAISE EXCEPTION 'Complete173 post-seal refusal' USING ERRCODE='23514';END IF;\nEND $composite173$;\n";
 for(const r of [...refs])await checked(r,[],r.privateFile); // distinct custody paths retained; byte equality never requires path alias
 return {schema:'large-import173-reviewed-composite-bootstrap/v1',sql,sql_sha256:sha(sql),catalog_sql:query.toString('utf8'),source_graph:contract.source_graph,profile_sha256:proof.profile_sha256,profile_native_sha256:raw.native_sha256,evidence:input,loaded_refs:refs,expected_owner:expectation.owner,expected_profile:detach(expectation.profile),expected_certificate_rows:1,ledger:'NOT_APPENDED',activation:'NOT_APPLY_READY',native_install_restore_IAM_quota_hooks:'OPEN'};
}
