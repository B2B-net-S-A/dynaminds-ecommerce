/** Fixed source contract data validation, never an Actor/native-ready strategy. */
import assert from 'node:assert/strict';import{createHash}from'node:crypto';
export const ORDINARY177_SCHEMA='ordinary199-keeper-consumer-credit-runtime-dual173/v1';
export const ORDINARY177_CONTRACT_SHA='b28c33f3c7f19682bc8c99b4c0153e12e7d8e4d0d6667e6cd2a8766130adfeaf';
const shapeSha='e7921fbac406445b2c21e96045e0faf9c8206878c09c667a6968471bb9f25f0a';
export function assertOrdinary177Contract(c,profile){
 assert(c&&typeof c==='object'&&!Array.isArray(c));assert.equal(c.schema,ORDINARY177_SCHEMA);
 assert.equal(createHash('sha256').update(JSON.stringify(c)).digest('hex'),shapeSha,'fixed-source-dual173-contract');
 assert.deepEqual(c.successor_profile,profile,'dual173-complete-raw-source-profile');
 assert.deepEqual(c.original_certificate.profile,c.original_profile,'dual173-original-source-profile-link');
 assert.equal(c.original_certificate.singleton,true);assert.equal(c.original_profile.functions.length,44);assert.equal(c.successor_profile.functions.length,44);
 const old=c.original_profile.functions,newer=c.successor_profile.functions;
 assert.equal(old.length,newer.length);let changed=0;
 for(let i=0;i<old.length;i++){assert.equal(old[i].signature,newer[i].signature);if(JSON.stringify(old[i])!==JSON.stringify(newer[i])){changed++;assert(['large_import173_valid()','large_import173_admit(uuid,uuid,uuid,text,text,boolean)','large_import_quota_keeper_admit173(uuid,uuid,uuid,text,text,boolean)','large_import_quota_lock_cleanup_pin173(uuid,uuid,uuid,uuid,text,text,bigint,text)','large_import_core_review173_guard()','large_import_quota_reserve173(uuid,uuid,uuid,text,text,uuid,uuid,text,text,bigint,bigint,bigint)'].includes(old[i].signature),'exact187-six-source-body-changes');assert.deepEqual(Object.fromEntries(Object.entries(old[i]).filter(([k])=>!['definition','body_sha256'].includes(k))),Object.fromEntries(Object.entries(newer[i]).filter(([k])=>!['definition','body_sha256'].includes(k))));}}
 assert.equal(changed,6);return c;
}
