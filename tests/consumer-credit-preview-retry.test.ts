import test from 'node:test';
import assert from 'node:assert/strict';
import {isPreview188GuardRace,withPreview188GuardRetry} from '../server/consumer-credit-preview-retry';
const race=Object.assign(new Error('Fałszywy snapshot188'),{code:'23514'});
const realChange=Object.assign(new Error('RMA zmieniło wersję'),{code:'23514'});
const run=async(errors:unknown[],acknowledged=(_e:unknown)=>true)=>{
 let calls=0;
 const result=await withPreview188GuardRetry(async()=>{const e=errors[calls++];if(e)throw e;return 'preview';},acknowledged).catch(e=>e);
 return{result,calls};
};
test('only the SQL188 preview guard mismatch counts as the benign clock race',()=>{
 assert.equal(isPreview188GuardRace(race),true);
 assert.equal(isPreview188GuardRace(realChange),false);
 assert.equal(isPreview188GuardRace(Object.assign(new Error('Fałszywy snapshot188'),{code:'23505'})),false);
 assert.equal(isPreview188GuardRace(Object.assign(new Error('Fałszywy snapshot207'),{code:'23514'})),false);
 assert.equal(isPreview188GuardRace(undefined),false);
});
test('a rolled-back guard race is retried once and the fresh attempt decides',async()=>{
 assert.deepEqual(await run([race]),{result:'preview',calls:2});
});
test('a second race, a real RMA change or an unacknowledged rollback is never retried',async()=>{
 const twice=await run([race,race]);assert.equal(twice.result,race);assert.equal(twice.calls,2);
 const changed=await run([realChange]);assert.equal(changed.result,realChange);assert.equal(changed.calls,1);
 const raceThenChanged=await run([race,realChange]);assert.equal(raceThenChanged.result,realChange);assert.equal(raceThenChanged.calls,2);
 const unknown=await run([race],()=>false);assert.equal(unknown.result,race);assert.equal(unknown.calls,1);
});
