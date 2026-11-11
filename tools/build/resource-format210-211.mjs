/** Finite joint210+211 representation DATA only. No migration, Native, Startup,
 * runtime authority or activation. Legacy209/v2 and210/v3 remain unchanged.
 * Reuses the five210 Native aliases and the separate accepted211 identity row;
 * no generic alias or new codec is introduced. The 16MiB member budget is unchanged; the
 * total package budget (RESOURCE210_LIMITS) was raised from 96MiB to 128MiB on 26.10.2026
 * because the package from HEAD with migration 235 is 100666753B, 3457B over 96MiB, and
 * stage 5 needs a release built from HEAD. */
import assert from 'node:assert/strict';
import {RESOURCE209_DEFINITION,RESOURCE211_DEFINITION,RESOURCE211_ALIAS,definitions209,storage209,hasResource211Edge} from './resource-format209.mjs';
import {RESOURCE210_DEFINITION,RESOURCE210_ALIASES,RESOURCE210_LIMITS,RESOURCES210_SCHEMA,definitions210,storage210,assertStorage210Partition,assertStorage210PhysicalMembers} from './resource-format210.mjs';

export {encodeResource210,decodeResource210} from './resource-format210.mjs';
export const EMITTED210_211_SCHEMA='dynaminds-emitted-local-release/v5';
export const RESOURCES210_211_SCHEMA='dynaminds-fixed-runtime-resources/v5';
export const RESOURCE210_211_LIMITS=RESOURCE210_LIMITS;
export const RESOURCE210_211_ORIGIN=Object.freeze({status:'SOURCE_JOINT_REPRESENTATION_ONLY',native_acceptance:false,application_activation:false,installed_admission:false});
export const RESOURCE210_211_ALIASES=Object.freeze([...RESOURCE210_ALIASES,RESOURCE211_ALIAS]);
export const RESOURCE210_211_STORAGE_IDS=Object.freeze([RESOURCE209_DEFINITION.id,...RESOURCE210_ALIASES.map(a=>a.id),RESOURCE211_DEFINITION.id,RESOURCE210_DEFINITION.id]);
assert.equal(RESOURCE210_211_STORAGE_IDS.length,8);
assert.equal(new Set(RESOURCE210_211_STORAGE_IDS).size,8);
assert.equal(RESOURCE210_ALIASES.length,5);
const exact=(value,keys)=>{assert(value&&typeof value==='object'&&!Array.isArray(value));assert.deepEqual(Object.keys(value).sort(),[...keys].sort());};

/** The normal base is unchanged. Append exactly209→211→210; this describes
 * resources, not an authorization to execute that migration sequence. */
export function definitions210211(base){
 assert.equal(arguments.length,1,'joint210211-one-base-only');
 // Existing210 checks the exact177/182 definitions and base uniqueness.
 definitions210(base);
 return Object.freeze([...definitions209(base,{include211:true}),RESOURCE210_DEFINITION]);
}

/** Exactly the existing seven210 rows plus the fixed full719328B211 identity
 * alias. Source211 stays raw Native SQL; there is no fictional encode211 API. */
export function storage210211(row){
 assert.equal(arguments.length,1,'joint210211-one-storage-row-only');
 return row?.id===RESOURCE211_DEFINITION.id?storage209(row):storage210(row);
}

function baseOf(definitions){
 assert(Array.isArray(definitions)&&definitions.length>=3&&definitions.length<=4096,'joint210211-bounded-definitions');
 assert.deepEqual(definitions.slice(-3),[RESOURCE209_DEFINITION,RESOURCE211_DEFINITION,RESOURCE210_DEFINITION],'joint210211-exact209-211-210-tail');
 const base=definitions.slice(0,-3);
 assert.deepEqual(definitions,definitions210211(base),'joint210211-complete-definition-order');
 for(const alias of RESOURCE210_211_ALIASES){
  assert.deepEqual(definitions.filter(d=>d.id===alias.id),[{id:alias.id,source:alias.id.slice(4),path:alias.path,consumer:'server/db.ts'}],'joint210211-source-owned-alias-definition');
 }
 return base;
}
function prior210(contract,base){
 // Deliberate view for the unchanged210 validator, after the211 row's exact
 // cardinality and authority have been checked. Never a fallback for absence.
 return {schema:RESOURCES210_SCHEMA,definitions:definitions210(base),members:contract.members.filter(r=>r.id!==RESOURCE211_DEFINITION.id),missing:[...contract.missing]};
}

export function assertStorage210211Partition(contract,nativeContract){
 assert.equal(arguments.length,2,'joint210211-contract-and-native-only');
 exact(contract,['schema','definitions','members','missing']);
 assert.equal(contract.schema,RESOURCES210_211_SCHEMA,'joint210211-explicit-schema');
 const base=baseOf(contract.definitions);
 assert(Array.isArray(contract.members)&&contract.members.length<=4096&&Array.isArray(contract.missing)&&contract.missing.length<=4096,'joint210211-bounded-resource-roster');
 assert.equal(hasResource211Edge(nativeContract),true,'joint210211-requires-exact211-native-edge');
 for(const id of RESOURCE210_211_STORAGE_IDS){
  const rows=contract.members.filter(r=>r.id===id);
  assert.equal(rows.length,1,'joint210211-complete-eight-row-partition');
  assert(!contract.missing.includes(id),'joint210211-required-row-not-missing');
  storage210211(rows[0]);
 }
 assert.deepEqual(contract.members.filter(r=>Object.hasOwn(r,'storage')).map(r=>r.id).sort(),[...RESOURCE210_211_STORAGE_IDS].sort(),'joint210211-no-extra-storage-alias');
 assertStorage210Partition(prior210(contract,base),nativeContract);
}

/** Structural physical-file check only. The existing bounded readers still
 * authenticate every actual file. The delegated210 check counts ALL files
 * once, preserves both caps and rejects duplicate logical177/182 copies. */
export function assertStorage210211PhysicalMembers(contract,nativeContract,files){
 assert.equal(arguments.length,3,'joint210211-contract-native-files-only');
 assertStorage210211Partition(contract,nativeContract);
 const base=contract.definitions.slice(0,-3);
 const report=assertStorage210PhysicalMembers(prior210(contract,base),nativeContract,files);
 const row=contract.members.find(r=>r.id===RESOURCE211_DEFINITION.id),stored=storage209(row);
 assert(!files.some(f=>f.path===row.path),'joint210211-no-logical211-copy');
 assert.deepEqual(files.filter(f=>f.path===stored.path),[{path:stored.path,bytes:stored.bytes,sha256:stored.sha256,role:stored.role}],'joint210211-full-physical211-source');
 return Object.freeze({...report,closed_storage_rows:8,joint_native_acceptance:false,application_activation:false});
}
