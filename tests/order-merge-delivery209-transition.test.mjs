/** Real Source18 witness -> reviewed Source21. SQL preparation only, no PG. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {deriveOrderMergeDelivery209RuntimeTransition as derive,TRANSITION209_SOURCE_PINS as pins} from '../tools/parity/order-merge-delivery209-transition.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const zipped=readFileSync(new URL('./fixtures/order-merge-delivery209-source18-contract.json.gz',import.meta.url));
assert.equal(zipped.length,2792134);assert.equal(sha(zipped),'0e51f0cae47c8ad5dfacd5c25e59180278f4f8187455f617f599d2c079f1a3fb');
const raw=gunzipSync(zipped,{maxOutputLength:21402960});assert.equal(raw.length,21402960);assert.equal(sha(raw),pins.before_contract);
// Historical test-only witnesses retained BEFORE promotion to Source22b. Never
// import the current runtime contract/SQL here: this regression remains18→21.
// These two compressed fixtures are not in the runtime import/package closure.
function source21Fixture(name,compressedBytes,compressedSha,decodedBytes,decodedSha){
 const bytes=readFileSync(new URL('./fixtures/'+name,import.meta.url));
 assert.equal(bytes.length,compressedBytes);assert.equal(sha(bytes),compressedSha);
 const decoded=gunzipSync(bytes,{maxOutputLength:decodedBytes});
 assert.equal(decoded.length,decodedBytes);assert.equal(sha(decoded),decodedSha);
 return decoded;
}
const before=JSON.parse(raw),after=JSON.parse(source21Fixture('order-merge-delivery209-source21-contract.json.gz',
 2957592,'9188cfb3d23dabe095fa2af2cd4d91e805aff969f0565518d495169858f6497c',22468966,pins.after_contract));
const sql=source21Fixture('order-merge-delivery209-source21.sql.gz',
 3764957,'8dac72843340a384da3cb5e49d1d84844ef973d6431f576ff0ef287c3ed0b09e',pins.sql_bytes,pins.sql).toString('utf8');
const input={beforeContract:before,afterContract:after,targetSql:sql};
test('real historical witness prepares exactly eight additions, twelve body replacements and one source payload check',()=>{
 const p=derive(input);assert.equal(p.steps.length,38);assert.equal(p.added_functions,8);assert.equal(p.changed_functions,12);assert.equal(p.changed_checks,1);
 assert.equal(p.steps.filter(s=>s.label.startsWith('create-private:')).length,8);
 assert.equal(p.steps.filter(s=>s.label.startsWith('replace-body:')).length,12);
 assert.equal(p.steps.filter(s=>s.label.startsWith('revoke-default-acl:')).length,8);
 assert(p.steps.filter(s=>s.label.startsWith('create-private:')).every(s=>s.text.startsWith('CREATE OR REPLACE FUNCTION public.order_merge_delivery209_')));
 const payload=p.steps.find(s=>s.label==='replace-source-payload');assert.equal(payload.values.length,1);
 assert.equal(Buffer.byteLength(payload.values[0]),pins.payload_bytes);assert.equal(sha(payload.values[0]),pins.payload);
 assert(Object.isFrozen(p)&&Object.isFrozen(p.steps)&&p.steps.every(s=>Object.isFrozen(s)&&Object.isFrozen(s.values)));
});
test('plan preserves business rows and historical certificates; no commit, observed reseal or original166 replacement',()=>{
 const p=derive(input),updates=p.steps.filter(s=>/^UPDATE\b/.test(s.text));assert.deepEqual(updates.map(s=>s.label),['replace-source-payload','replace-source-fingerprint']);
 // Routine bodies contain historical SQL text as DATA. Check the statements
 // dispatched by this plan, not words inside those complete pinned bodies.
 const commands=p.steps.filter(s=>!s.label.startsWith('create-private:')&&!s.label.startsWith('replace-body:')&&s.label!=='source18-precondition');
 assert(commands.every(s=>!/(?:^|;)\s*(?:COMMIT|TRUNCATE|DELETE|DROP TABLE|INSERT INTO|GRANT)\b/i.test(s.text)));
 assert(p.steps.every(s=>!/^UPDATE[^;]*SET[^;]*\b(?:original166|constraints)\s*=/i.test(s.text)));
 const seal=updates[1];assert.deepEqual(seal.values,[pins.after_fingerprint]);assert(!seal.text.includes('fingerprint()'));
 for(const table of ['payload','manifest']){
  const open=table==='payload'?'open-own-payload':'open-own-manifest',close=table==='payload'?'close-own-payload':'close-own-manifest';
  const a=p.steps.findIndex(s=>s.label===open),b=p.steps.findIndex(s=>s.label===close);assert(b>a);
  assert.equal(p.steps.slice(a+1,b).length,1);assert(/^UPDATE\b/.test(p.steps[a+1].text));
 }
 assert.equal(p.business_tables_written,0);assert.equal(p.historical_certificates_written,0);assert.equal(p.commit_included,false);
 for(const key of ['requires_isolated_copy','requires_full_before_catalogue','requires_full_after_catalogue','requires_business_row_preservation','requires_full_runtime_guards'])assert.equal(p[key],true);
 assert.equal(p.native_acceptance,false);assert.equal(p.application_activation,false);
});
test('changed full source contracts and SQL cannot prepare a fresh transition',()=>{
 const old=structuredClone(before);old.changes[0].after.source+=' altered';
 assert.throws(()=>derive({...input,beforeContract:old}),e=>e.code==='ERR_ASSERTION'&&String(e.message).includes('fixed-source-contract-required'));
 const next=structuredClone(after);next.additions[0].value.owner='foreign';
 assert.throws(()=>derive({...input,afterContract:next}),e=>e.code==='ERR_ASSERTION'&&String(e.message).includes('fixed-source-contract-required'));
 assert.throws(()=>derive({...input,targetSql:sql.slice(0,-1)+' '}),e=>e.code==='ERR_ASSERTION'&&String(e.message).includes('fixed-sql-source-required'));
 assert.throws(()=>derive({...input,beforeContract:after}),e=>e.code==='ERR_ASSERTION');
});
