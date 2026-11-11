import{ORDER_MERGE_DELIVERY209_SOURCE_CONTRACT as E209}from'./order-merge-delivery209-source-contract.mjs';
import{projectHeaderMetadata205Descriptor}from'./header205-source-compatibility.mjs';
/** Pure Source209→205→204 descriptor composition before any187 Native dispatch. No install/cache/authority. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {PACKING204_SOURCE_CONTRACT as E} from './packing204-source-contract.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const exact=(x,keys)=>{assert(x&&typeof x==='object'&&!Array.isArray(x));assert.deepEqual(Object.keys(x).sort(),keys.slice().sort());};
const matches=E.changes.filter(r=>r.kind==='function'&&r.key==='public.ordinary187_valid()');assert.equal(matches.length,1,'durable204-exact-Source187-target');
const target=structuredClone(matches[0]),beforeSha=sha(target.before.source);
assert.deepEqual(canonical(Object.fromEntries(Object.entries(target.before).filter(([k])=>!['source','definition'].includes(k)))),canonical(Object.fromEntries(Object.entries(target.after).filter(([k])=>!['source','definition'].includes(k)))),'durable204-Source-header-ACL-preserved');
const matches209=E209.changes.filter(r=>r.kind==='function'&&r.key==='public.ordinary187_valid()');assert.equal(matches209.length,1,'durable209-exact-Source187-target');
const target209=matches209[0];
const header=v=>Object.fromEntries(Object.entries(v).filter(([k])=>!['source','definition'].includes(k)));
assert.deepEqual(canonical(header(target209.before)),canonical(header(target209.after)),'durable209-entire-source-header-ACL-preserved');
assert.deepEqual(canonical(projectHeaderMetadata205Descriptor('public.ordinary187_valid()',target209.before).descriptor),canonical(target.after),'durable209-source-before-binds-exact205-204-chain');
const anchorSha='cf6cd0842767e01717a84efe8b4d5c7611b687f11d6f110f10dd93c9e0c46d5f';
const roster=["ordinary187_approve","ordinary187_enter","ordinary187_journal_usage","ordinary187_owner_abandon_empty","ordinary187_owner_closed","ordinary187_owner_closed_complete","ordinary187_owner_context","ordinary187_owner_cut","ordinary187_owner_cut_header","ordinary187_owner_cut_page","ordinary187_owner_io_arm","ordinary187_owner_io_drain","ordinary187_owner_member","ordinary187_owner_member_finish","ordinary187_owner_member_xid","ordinary187_owner_open","ordinary187_owner_original","ordinary187_owner_original_drained","ordinary187_owner_pin","ordinary187_owner_poison","ordinary187_private_valid","ordinary187_profile_project","ordinary187_resource_guard","ordinary187_seal","ordinary187_valid"];
/** Entire pg_catalog function descriptor in exactly the Source catalogue schema.
 * Only builtin metadata readers; no ordinary187/public Native helper invocation. */
export const DURABLE187_DESCRIPTOR204_SQL=`SELECT jsonb_build_object(
 'owner',pg_get_userbyid(p.proowner),'language',l.lanname,'kind',p.prokind,'cost',p.procost,'rows',p.prorows,
 'security_definer',p.prosecdef,'leakproof',p.proleakproof,'strict',p.proisstrict,'returns_set',p.proretset,
 'volatility',p.provolatile,'parallel',p.proparallel,'support',CASE WHEN p.prosupport=0 THEN NULL ELSE p.prosupport::regprocedure::text END,
 'variadic',CASE WHEN p.provariadic=0 THEN NULL ELSE format_type(p.provariadic,NULL) END,
 'argument_names',p.proargnames,'argument_modes',p.proargmodes,'arguments',pg_get_function_arguments(p.oid),
 'result',pg_get_function_result(p.oid),'defaults',pg_get_expr(p.proargdefaults,0),'source',p.prosrc,'binary',p.probin,
 'config',p.proconfig,'definition',pg_get_functiondef(p.oid),'acl_null',p.proacl IS NULL,
 'acl',(SELECT coalesce(jsonb_agg(jsonb_build_object('grantor',pg_get_userbyid(a.grantor),'grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY a.grantor::regrole::text,CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END,a.privilege_type,a.is_grantable),'[]'::jsonb)
 FROM aclexplode(CASE WHEN cardinality(coalesce(p.proacl,acldefault('f',p.proowner)))=0 THEN NULL::aclitem[] ELSE coalesce(p.proacl,acldefault('f',p.proowner)) END) a)) AS descriptor,
 (SELECT count(*)::integer FROM pg_proc sibling WHERE sibling.pronamespace=p.pronamespace AND sibling.proname=p.proname) AS overloads,
 (p.proallargtypes IS NULL AND p.protrftypes IS NULL AND p.prosqlbody IS NULL) AS supported
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
 WHERE n.nspname='public' AND p.oid=to_regprocedure('public.ordinary187_valid()')`;
function bindHistorical(extension){
 assert(extension&&extension.original_certificate_unchanged===true&&extension.per_operation_IAM_unchanged===true&&extension.native_admission_cache===false&&extension.catalogue_preinspection_before_any_187_dispatch===true,'durable204-historical-boundary');
 assert.deepEqual(extension.public_helper_roster,roster,'durable204-original-public-roster');
 assert.equal(sha(extension.independent_descriptor_sql),anchorSha,'durable204-unchanged-entire-historical-anchorSQL');
 assert(Array.isArray(extension.helpers));const hs=extension.helpers.filter(h=>h.name==='ordinary187_valid');assert.equal(hs.length,1,'durable204-one-original-anchor');const h=hs[0],v=target.before;
 const expected={signature:'ordinary187_valid()',arguments:v.arguments,result:v.result,language:v.language,owner:v.owner,security_definer:v.security_definer,strict:v.strict,leakproof:v.leakproof,parallel:v.parallel,kind:v.kind,returns_set:v.returns_set,cost:v.cost,rows:v.rows,volatility:v.volatility,argument_modes:v.argument_modes,argument_names:v.argument_names,defaults:v.defaults,configuration:v.config,acl:v.acl.map(a=>[a.grantor,a.grantee,a.privilege,a.grantable]),body_sha256:beforeSha,name:'ordinary187_valid'};
 assert.deepEqual(canonical(h),canonical(expected),'durable204-full-original-anchor-bound-to-Source-before');
 return extension.independent_descriptor_sql;
}
/** No observation mints authority. Only the literal204/205/209 Source descriptors are accepted;
 * any mixed/unknown body, definition, header, ACL, overload or extra field refuses. */
export function projectDurable187Descriptor204Sql(extension,observation){
 const sql=bindHistorical(extension);exact(observation,['descriptor','overloads','supported']);assert.equal(observation.overloads,1,'durable204-no-overload');assert.equal(observation.supported,true,'durable204-no-unsupported-function-axes');
 let current=canonical(observation.descriptor);const before=canonical(target.before),after=canonical(target.after);
 if(JSON.stringify(current)===JSON.stringify(before))return sql;
 // Authenticate the WHOLE209 descriptor before its narrow source-owned inverse.
 // Keep the observed source hash separately: the final pg_catalog anchor must
 // verify the actual current209 body, never the virtual205/204 representation.
 const observedSourceSha=sha(observation.descriptor.source);
 const predecessor209=JSON.stringify(current)===JSON.stringify(canonical(target209.after))?target209.before:observation.descriptor;
 const successor=projectHeaderMetadata205Descriptor('public.ordinary187_valid()',predecessor209);current=canonical(successor.descriptor);
 assert.deepEqual(current,after,'durable204-fresh-entire-current-Source-descriptor');
 const prefix="p.oid=to_regprocedure('public.ordinary187_valid()') AND (SELECT count(*) FROM pg_proc sibling WHERE sibling.pronamespace=p.pronamespace AND sibling.proname=p.proname)=1 AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='";
 const needle=prefix+beforeSha+"'";assert.equal(sql.split(needle).length,2,'durable204-context-exact-one-anchor');
 return sql.replace(needle,prefix+observedSourceSha+"'");
}
/** Same actual owner already admitted by caller's identity/schema-lock cold TX.
 * Fresh descriptor query completes before the separately submitted anchor query. */
export async function prepareDurable187Descriptor204Sql(owner,extension){
 bindHistorical(extension);assert(owner&&typeof owner.query==='function','durable204-owner-reader-required');
 const rows=(await owner.query(DURABLE187_DESCRIPTOR204_SQL)).rows;assert(Array.isArray(rows)&&rows.length===1,'durable204-one-fresh-descriptor');
 return projectDurable187Descriptor204Sql(extension,rows[0]);
}
