/** Controlled preparation from real independently compiled21 and22b. No PG. */
import assert from 'node:assert/strict';import test from 'node:test';import{readFileSync}from'node:fs';import{gunzipSync}from'node:zlib';import{createHash}from'node:crypto';
import{ORDER_MERGE_DELIVERY209_SOURCE_CONTRACT as after}from'../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/order-merge-delivery209-source-contract.mjs';
import{ORDER_MERGE_DELIVERY209_STARTUP_KEYS as startupKeys,assertOrderMergeDelivery209StartupBeforeRecords}from'../tools/parity/order-merge-delivery209-startup-roster.mjs';
import{deriveOrderMergeDelivery209Source22Upgrade as derive,ORDER_MERGE_DELIVERY209_SOURCE22_UPGRADE_PINS as pins}from'../tools/parity/order-merge-delivery209-source22-upgrade.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');const zip=readFileSync(new URL('./fixtures/order-merge-delivery209-source21-contract.json.gz',import.meta.url));assert.equal(zip.length,2957592);assert.equal(sha(zip),'9188cfb3d23dabe095fa2af2cd4d91e805aff969f0565518d495169858f6497c');const raw=gunzipSync(zip,{maxOutputLength:pins.before_contract_bytes});assert.equal(sha(raw),pins.before_contract);const before=JSON.parse(raw);const sql=readFileSync(new URL('../server/209_order_merge_delivery_inheritance.sql',import.meta.url),'utf8');const input={beforeContract:before,afterContract:after,targetSql:sql},plan=derive(input),index=label=>plan.steps.findIndex(s=>s.label===label);

test('real source21 and promoted22b prepare exactly19 additions and25 full descriptor changes',()=>{
 assert.equal(plan.from,21);assert.equal(plan.to,22);assert.equal(plan.target_variant,'22b');assert.equal(plan.added_functions,5);assert.equal(plan.changed_functions,22);assert.equal(plan.added_columns,7);assert.equal(plan.added_checks,7);assert.equal(plan.changed_checks,3);assert.equal(plan.steps.length,70);assert.equal(plan.ddl_statements,66);assert.equal(plan.steps.reduce((n,s)=>n+s.ddl_statements,0),66);
 assert.equal(plan.steps.filter(s=>s.label.startsWith('create-private:')).length,5);assert.equal(plan.steps.filter(s=>s.label.startsWith('replace-body:')).length,22);assert.equal(plan.steps.filter(s=>s.label.startsWith('revoke-default-acl:')).length,5);
});

test('seven unchanged-in21 public routines use independently pinned source BEFORE and are replaced, never created',()=>{
 const map=new Map([...before.additions,...before.changes.map(c=>({kind:c.kind,key:c.key,value:c.after}))].map(r=>[r.key,r]));const historical=startupKeys.map(key=>{assert(!map.has(key),'delta absence is not missing installation');const c=after.changes.find(c=>c.key===key);return{kind:c.kind,key:c.key,value:c.before};});assertOrderMergeDelivery209StartupBeforeRecords(historical);
 for(const key of startupKeys){assert.equal(plan.steps.filter(s=>s.label==='replace-body:'+key).length,1);assert(!plan.steps.some(s=>s.label==='create-private:'+key));}
});

test('old10-entry payload stages nullable generated columns and NOT VALID checks before new17-entry update',()=>{
 const update=index('replace-source-payload');const payload=plan.steps[update].values[0];assert.equal(Buffer.byteLength(payload),21756960);assert.equal(sha(payload),pins.payload);const entries=JSON.parse(payload);assert.equal(entries.length,17);
 for(let ordinal=10;ordinal<=16;ordinal++){
  const column='before_'+ordinal,add=plan.steps.find(s=>s.label==='add-source-column:'+column),check=plan.steps.find(s=>s.label==='add-unvalidated-source-check:order_merge_delivery209_'+column+'_source'),validate=plan.steps.find(s=>s.label==='validate-source-check:order_merge_delivery209_'+column+'_source');
  assert(add&&check&&validate);assert(add.text.includes(`GENERATED ALWAYS AS ((((payload)::jsonb -> ${ordinal}) -> 'before'::text)) STORED`));assert(!add.text.includes('NOT NULL'));assert(check.text.endsWith(' NOT VALID'));assert(index(add.label)<update);assert(index(check.label)<update);assert(index(validate.label)>update);assert(entries[ordinal].before&&typeof entries[ordinal].before==='object');
 }
 for(const name of ['order_merge_delivery209_checks_source','order_merge_delivery209_keys_source','order_merge_delivery209_projection_basis_payload_check']){assert(index('drop-old-source-check:'+name)<index('replace-unvalidated-source-check:'+name));assert(index('replace-unvalidated-source-check:'+name)<update);assert(index('validate-source-check:'+name)>update);}
 assert.equal(plan.steps.filter(s=>s.label.startsWith('validate-source-check:')).length,10);
});

test('all22 full body replacements preserve the source headers/ACL and exact source-authored AFTER definition',()=>{
 const next=new Map([...after.additions,...after.changes.map(c=>({kind:c.kind,key:c.key,value:c.after}))].map(r=>[r.key,r]));
 for(const step of plan.steps.filter(s=>s.label.startsWith('replace-body:'))){const key=step.label.slice('replace-body:'.length);assert.equal(step.text,next.get(key).value.definition.trimEnd()+';');}
 for(const step of plan.steps.filter(s=>s.label.startsWith('create-private:'))){const key=step.label.slice('create-private:'.length),record=next.get(key);assert.equal(record.value.owner,'postgres');assert.deepEqual(record.value.acl,[{grantor:'postgres',grantee:'postgres',privilege:'EXECUTE',grantable:false}]);assert.equal(step.text,record.value.definition.trimEnd()+';');}
});

test('only own payload and compiled fingerprint are written, with closed trigger windows; no business/certificate/control resets',()=>{
 const updates=plan.steps.filter(s=>/^UPDATE\b/.test(s.text));assert.deepEqual(updates.map(s=>s.label),['replace-source-payload','replace-source-fingerprint']);assert.deepEqual(updates[1].values,[pins.after_fingerprint]);assert(!updates[1].text.includes('fingerprint()'));assert(updates.every(s=>s.text.endsWith('WHERE id RETURNING id')));
 for(const name of ['payload','manifest']){const a=index('open-own-'+name),b=index('close-own-'+name);assert.equal(b,a+2);assert(/^UPDATE\b/.test(plan.steps[a+1].text));}
 const commands=plan.steps.filter(s=>!s.label.startsWith('create-private:')&&!s.label.startsWith('replace-body:')&&s.label!=='source21-precondition');assert(commands.every(s=>!/(?:^|;)\s*(?:COMMIT|TRUNCATE|DELETE|DROP TABLE|GRANT)\b/i.test(s.text)));assert(commands.every(s=>!s.text.includes('ordinary182_runtime_generation')));assert(commands.every(s=>!s.text.includes('session_replication_role')));
 assert.equal(plan.business_tables_written,0);assert.equal(plan.historical_certificates_written,0);assert.equal(plan.commit_included,false);assert.equal(plan.native_acceptance,false);assert.equal(plan.application_activation,false);
 for(const field of ['requires_isolated_copy','requires_owner_transaction_fence','requires_full_before_catalogue','requires_full_after_catalogue','requires_full_runtime_guards','requires_all_627_before_fingerprints','requires_624_unchanged_table_fingerprints','requires_exact_own_basis_and_manifest_delta','requires_source182_full_row_transition'])assert.equal(plan[field],true);
 assert.deepEqual(plan.source182_changed_fields,['generation','validated_generation','dirty','contract_id','release_sha256','native_sha256','profile_native_sha256']);assert(Object.isFrozen(plan)&&Object.isFrozen(plan.steps)&&plan.steps.every(s=>Object.isFrozen(s)&&Object.isFrozen(s.values)));
});

test('full contract and SQL mutations refuse before producing an upgrade plan',()=>{
 const alteredBefore=structuredClone(before);alteredBefore.changes[0].after.owner='foreign';assert.throws(()=>derive({...input,beforeContract:alteredBefore}));
 const alteredAfter=structuredClone(after);alteredAfter.additions[0].value={};assert.throws(()=>derive({...input,afterContract:alteredAfter}));
 const missingBefore=structuredClone(after);missingBefore.changes=missingBefore.changes.filter(c=>c.key!==startupKeys[0]);assert.throws(()=>derive({...input,afterContract:missingBefore}));
 assert.throws(()=>derive({...input,targetSql:sql.slice(0,-1)+' '}));assert.throws(()=>derive({...input,beforeContract:after}));assert.throws(()=>derive({...input,afterContract:before}));
});
