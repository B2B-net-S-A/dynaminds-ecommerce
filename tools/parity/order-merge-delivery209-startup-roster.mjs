/** Literal Source204 AFTER records, used as BEFORE for the explicit Source22 layer.
 * This finite source witness grants no runtime admission or observed-data authority. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

export const ORDER_MERGE_DELIVERY209_STARTUP_KEYS=Object.freeze([
 'public.pim_dictionary_valid()',
 'public.nested172_valid()',
 'public.parcel_physical_wz_valid()',
 'public.operative_delivery_valid()',
 'public.wave_print177_valid()',
 'public.cooperation171_valid()',
 'public.packed_label_print_guards()',
]);
export const ORDER_MERGE_DELIVERY209_STARTUP_BEFORE_RECORD_SHA256=Object.freeze([
 'ebc04cddc144fcd4e6aeacb0839e12c89822ad5d75dacc6ea74081d37d43b11f',
 'fb920d7f48488ecc51e5b5880ee5ffb0a9767dca618b170416b773fe98ffa62e',
 '7631b4bce67f53fbd59129164e9fe78b6ab416a5872e9e25bf1d49ea44098ac5',
 'e3b83a58a6ba6885459608307fb65005d57c4f63dcef7b9f48b50de4d1cef5b6',
 '3cf6651d302f632c98f7ec2ffc1c148e6f5fb43a1469163de4660cbe1fb217b4',
 '30a4c0f54bb2998220994b1ff6905343a5a5fc4c10c69a1fe74e2296b42e59fd',
 'e73e89464f0adff093a3f1ec84f0db0cea2ce927c70953ca2a2893222d3af25e',
]);
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
 ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;

export function assertOrderMergeDelivery209StartupBeforeRecords(records){
 assert(Array.isArray(records)&&records.length===ORDER_MERGE_DELIVERY209_STARTUP_KEYS.length,'exact source-authored startup records');
 assert.deepEqual(records.map(record=>record.key),ORDER_MERGE_DELIVERY209_STARTUP_KEYS,'ordered startup source identities');
 for(let index=0;index<records.length;index++){
  const record=records[index];
  assert.deepEqual(Object.keys(record).sort(),['key','kind','value']);
  assert.equal(record.kind,'function');assert.equal(Object.keys(record.value).length,24);
  const digest=createHash('sha256').update(JSON.stringify(canonical(record))).digest('hex');
  assert.equal(digest,ORDER_MERGE_DELIVERY209_STARTUP_BEFORE_RECORD_SHA256[index],'literal complete Source204 AFTER record');
 }
 return true;
}
