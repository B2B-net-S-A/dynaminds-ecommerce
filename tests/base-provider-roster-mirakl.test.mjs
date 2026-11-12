/** File-only inventory mapping checks. No adapter import, network, database or provider acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parseSync} from 'vite';

const root=fileURLToPath(new URL('../',import.meta.url));
const bytes=p=>fs.readFileSync(root+p);
const read=p=>JSON.parse(bytes(p));
const sha=b=>createHash('sha256').update(b).digest('hex');
const digest=v=>sha(JSON.stringify(v));
const priorPath='docs/parity/scope-inputs/v2/base-provider-roster.json';
const prior=read(priorPath),current=read('docs/parity/base-provider-roster.json');
const entryId='base.catalog.marketplace.mirakl';
const RECORDED_AT='0917896cbf08c46202937fab2dc5293adc22e0b9';
// The public repository starts from a single snapshot commit, so RECORDED_AT exists only in checkouts with the
// private history. Without it the recorded-bytes check is skipped with this reason; the structural checks still run.
const historySkip=(()=>{try{execFileSync('git',['-C',root,'cat-file','-e',RECORDED_AT+'^{commit}'],{stdio:'ignore'});return false;}catch{return 'commit '+RECORDED_AT.slice(0,7)+' (recorded mapping sources) is not in this checkout: the public repository has no history before its snapshot';}})();
const recorded=p=>execFileSync('git',['-C',root,'cat-file','blob',RECORDED_AT+':'+p],{maxBuffer:64*1024*1024});
// Recorded bytes from history when present; otherwise the checkout file, accepted only while it still equals the pin.
const recordedOrTree=ref=>{if(!historySkip)return recorded(ref.path);const b=bytes(ref.path);assert.equal(sha(b),ref.sha256,'Recorded source changed in the checkout and history is unavailable: '+ref.path);return b;};
const parsed=p=>{const value=parseSync(p,bytes(p).toString('utf8'),{lang:'ts'});assert.equal(value.errors.length,0);return value.program;};
function nodes(source,predicate){const found=[];function visit(n){if(!n||typeof n!=='object')return;if(typeof n.type==='string'&&predicate(n))found.push(n);for(const value of Object.values(n))if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')visit(value);}visit(source);return found;}
function prop(n,key){const p=n.properties.find(x=>x.type==='Property'&&(x.key.name??x.key.value)===key);assert(p,'Missing source property '+key);return p.value;}

test('only the existing Mirakl family mapping changes; all captured entries/cards and frozen denominator remain exact',()=>{
 assert.equal(sha(bytes(priorPath)),'b4c1ea152a16bdd2186c56d46d706299ad77ac3007798487b66fa16177e3915a');
 assert.equal(current.entries.length,2060);assert.equal(current.catalog_cards.length,2056);
 const copy=structuredClone(current);
 copy.as_of=prior.as_of;copy.summary=structuredClone(prior.summary);
 copy.entries.find(e=>e.id===entryId).registry_relationship=structuredClone(prior.entries.find(e=>e.id===entryId).registry_relationship);
 copy.registry_matching.pop();delete copy.registry_mapping_supplements;
 assert.equal(digest(copy),digest(prior),'An unrelated historical roster fact changed');
 const scope=read('docs/parity/scope.v2.json');
 assert.equal(sha(bytes('docs/parity/scope-inputs/v2/base-provider-roster.json')),scope.inputs.providerRoster.sha256);
 assert.equal(scope.scope_complete,false);assert.equal(current.inventory_complete,false);assert.equal(current.coverage_complete,false);
});

test('mapping sources are exact at the commit that recorded them',{skip:historySkip},()=>{
 // The supplement pins its sources as recorded in its own commit (0917896, 2026-10-18). Those are
 // historical facts, so their exact bytes are verified in that commit, not in the later-edited checkout.
 const update=current.registry_mapping_supplements[0];
 for(const ref of [update.catalogue_source,update.registry_source,...update.adapter_sources,update.operation_inventory_source]){
  const b=recorded(ref.path);assert.equal(b.length,ref.bytes);assert.equal(sha(b),ref.sha256,'Recorded mapping source differs: '+ref.path);
 }
});

test('mapping binds the captured exact family card to the real registered Seller reader and existing operation rows',()=>{
 const update=current.registry_mapping_supplements[0];assert.equal(current.registry_mapping_supplements.length,1);
 assert.equal(update.as_of,'2026-10-18');assert.equal(update.kind,'source_only_family_registry_mapping');
 // The inventory is read from the recorded bytes (recordedOrTree). Every structural check after that runs on
 // the current code, so the mapping must still hold today.
 const card=prior.catalog_cards.find(c=>c.ordinal===update.catalogue_card_ordinal);
 assert.equal(card.entry_id,entryId);assert.equal(card.catalog_id,'mirakl');assert.equal(card.name,'Mirakl');
 assert.deepEqual(card.urls,['https://base.com/pl-PL/integracje/mirakl/']);assert.equal(card.attributes['data-tags'],'Mirakl');
 const registry=parsed('server/integrations.ts');
 const array=nodes(registry,n=>n.type==='VariableDeclarator'&&n.id.name==='registry')[0].init;
 assert.equal(array.type,'ArrayExpression');
 const provider=array.elements.find(n=>n.type==='ObjectExpression'&&prop(n,'id').value==='mirakl');assert(provider);
 assert.equal(prop(provider,'name').value,'Mirakl Seller');
 assert.equal(prop(provider,'docs').value,'https://developer.mirakl.com/content/product/mmp/rest/seller');
 const implemented=prop(provider,'implemented').elements.map(x=>x.value),planned=prop(provider,'planned').elements.map(x=>x.value);
 const inventory=JSON.parse(recordedOrTree(update.operation_inventory_source)),rows=inventory.rows.filter(x=>x.provider==='mirakl');
 assert.deepEqual(update.operation_ids,rows.map(x=>x.id));assert.equal(rows.length,11);
 // Derived, not hand-listed: the registry declares implemented exactly the inventory's code-wired rows
 // (7 since L2 3b3abab, previously only the three reads) plus the rows the L4 result record (registry step v8,
 // migration 252) moves, and planned exactly the remaining rows.
 const wired=rows.filter(x=>x.status==='dev_wired_acceptance_unverified').map(x=>x.operation);
 const recordedPlanned=rows.filter(x=>!wired.includes(x.operation));
 assert.deepEqual(recordedPlanned.map(x=>x.status),Array(rows.length-wired.length).fill('planned_acceptance_unverified'));
 // v8: the L4 record names its local tests; each must still exist under that exact title in the current checkout.
 // The record grants no acceptance: every moved operation stays local-fake only (czeka na dostawcę).
 const l4=read('docs/parity/integrations-wave1-gap-20261025.json').work_breakdown.find(x=>x.lane==='L4').result_20261028;
 assert(l4,'L4 result record (registry step v8)');assert.equal(l4.acceptance_granted,false);
 const v8=l4.registry_changes.mirakl;
 assert.deepEqual(v8.to_implemented,recordedPlanned.map(x=>x.operation));assert.deepEqual(v8.still_planned,[]);
 assert.deepEqual(Object.keys(l4.local_tests).sort(),[...v8.to_implemented].sort());
 for(const [operation,list] of Object.entries(l4.local_tests)){assert(list.length>0,operation);for(const t of list){
  const src=bytes(t.file).toString('utf8');assert(src.includes("test('"+t.title+"'"),'Missing local test for '+operation+': '+t.file+' '+t.title);}}
 assert.deepEqual(implemented,[...wired,...v8.to_implemented]);assert.deepEqual(planned,[]);
 const note=prop(provider,'note').value;
 for(const phrase of ['symulacji','czeka na dostawcę'])assert(note.includes(phrase),'Registry note must say: '+phrase);
 for(const operation of ['account.read.A01','orders.read.OR11','offers.read.OF21'])assert(implemented.includes(operation));
 const channel=parsed('server/mirakl-channel.ts'),routes=parsed('server/mirakl-read-routes.ts'),app=parsed('server/app.ts');
 assert.equal(nodes(channel,n=>n.type==='FunctionDeclaration'&&n.id?.name==='createMiraklChannelReader').length,1);
 assert.equal(nodes(routes,n=>n.type==='FunctionDeclaration'&&n.id?.name==='registerMiraklReadRoutes').length,1);
 assert.equal(nodes(app,n=>n.type==='CallExpression'&&n.callee.name==='registerMiraklReadRoutes').length,1);
 const generic=nodes(registry,n=>n.type==='SwitchCase'&&n.test?.value==='mirakl');
 assert.equal(generic.length,1);assert(generic[0].consequent[0].type==='ThrowStatement','Generic connector must not silently bypass channel admission');
 assert.equal(current.entries.find(x=>x.id===entryId).registry_relationship.provider_id,'mirakl');
 assert.equal(current.registry_matching.at(-1).registry_provider_id,'mirakl');
 assert.equal(current.registry_matching.length,inventory.providers.length);assert.equal(current.summary.current_registry_providers,15);
 assert.equal(current.summary.registry_primary_Base_matches,12,'Listing-only family match must not become a fetched primary detail match');
});

test('family membership never propagates an operation, instance mapping or acceptance to the 182 tagged cards',()=>{
 const family=prior.catalog_cards.filter(c=>(c.attributes['data-tags']??'').toLowerCase().split(/\s+/).includes('mirakl'));
 assert.equal(family.length,182);
 const oldById=new Map(prior.entries.map(x=>[x.id,x]));
 for(const card of family){if(card.entry_id!==entryId)assert.equal(digest(current.entries.find(x=>x.id===card.entry_id)),digest(oldById.get(card.entry_id)));}
 const mapped=current.entries.find(x=>x.id===entryId),u=current.registry_mapping_supplements[0];
 assert.equal(mapped.registry_relationship.scope,'family_only');assert.equal(mapped.registry_relationship.operation_acceptance_granted,false);
 assert.equal(mapped.operations_discovery,'pending_not_invented');assert.equal(mapped.acceptance_granted,false);
 assert.equal(u.instance_mappings_created,0);assert.equal(u.operation_rows_created,0);assert.equal(u.acceptance_granted,false);
 assert(current.entries.every(x=>x.acceptance_granted===false&&x.operations_discovery==='pending_not_invented'));
 assert.equal(current.entries.filter(x=>x.registry_relationship.kind==='not_operation_mapped_in_roster_phase').length,1994);
 assert.equal(current.coverage_gaps.length,7);assert(current.coverage_gaps.every(x=>x.closed===false));
});
