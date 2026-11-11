import assert from 'node:assert/strict';
import {sha,queryRef}from'./source.mjs';
import {assertCompositeInventory,compileReviewedComposite}from'./compiler.mjs';
import {readFile,lstat}from'node:fs/promises';
const reviewed=new WeakMap();
async function recheck(refs){for(const r of refs){const st=await lstat(r.path);assert(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1,'reviewed-evidence-file');if(r.privateFile)assert.equal(st.mode&0o777,0o600);assert.equal(sha(await readFile(r.path)),r.sha256,'reviewed-evidence-bytes');}}
/** Only a complete independently reviewed source+native rollback chain can mint this private authority. */
export async function createReviewedStartup(compileInput){const c=await compileReviewedComposite(compileInput);const state=structuredClone({input:{catalog_sql:c.catalog_sql,expectation_origin:'INDEPENDENT_REVIEWED_SOURCE_DDL_EXPECTATION',owner:c.expected_owner,profile:c.expected_profile,profile_sha256:c.profile_sha256,profile_native_sha256:c.profile_native_sha256},refs:c.loaded_refs});await recheck(state.refs);const handle=Object.freeze({schema:'large-import173-reviewed-startup/v1'});reviewed.set(handle,state);return handle;}
export async function inspectCompositeStartup(owner,handle){const state=reviewed.get(handle);assert(state,'startup-requires-private-reviewed-handle');await recheck(state.refs);const result=await inspectComparedProfile(owner,state.input);await recheck(state.refs);return result;}
/** Injected genuine owner reader ONLY. No default pool, SET ROLE, candidate helper call before external full-profile/body/property comparison. */
async function inspectComparedProfile(owner,input0){
 const input=structuredClone(input0);assert.equal(sha(input.catalog_sql),queryRef.sha256);assert.equal(input.expectation_origin,'INDEPENDENT_REVIEWED_SOURCE_DDL_EXPECTATION');
 assert.equal(sha(JSON.stringify(input.profile)),input.profile_sha256);assertCompositeInventory(input.profile,input.owner);
 const identity=(await owner.query("SELECT current_user::text AS current_role,session_user::text AS session_role,current_setting('role',true) AS role_setting")).rows[0];assert.equal(identity.current_role,input.owner);assert.equal(identity.session_role,input.owner);assert.equal(identity.role_setting,'none','private-keeper-owner-role-none');
 const select=input.catalog_sql.trim().replace(/;$/,'');const rows=(await owner.query(`SELECT profile,profile::text AS native_text,encode(sha256(convert_to(profile::text,'UTF8')),'hex') AS native_sha256 FROM (${select}) external173`)).rows;assert.equal(rows.length,1);
 assert.deepEqual(rows[0].profile,input.profile);assert.deepEqual(JSON.parse(rows[0].native_text),input.profile);assert.equal(sha(rows[0].native_text),input.profile_native_sha256);assert.equal(rows[0].native_sha256,input.profile_native_sha256);
 // Only now is this exact compared kernel allowed to answer its leaf/certificate predicate.
 const cert=(await owner.query('SELECT (SELECT count(*) FROM public.large_import173_certificate)::text AS count,(SELECT profile_sha256 FROM public.large_import173_certificate WHERE singleton) AS sha,public.large_import173_valid() AS valid')).rows[0];
 assert.equal(cert.count,'1');assert.equal(cert.sha,input.profile_native_sha256);assert.equal(cert.valid,true);
 return {status:'INDEPENDENT_COMPLETE173_GRAPH_AND_CERT_MATCHED',certified_graph:true,profile_native_sha256:input.profile_native_sha256,application_activation:false,
 pending:'Root independently composes genuine Actor/common-TX/head-codec/durable registry/all quota intents/native CORE-PIM/current IAM/restore gates; graph alone does not enable routes'};
}
