/** The release cold-catalogue chain, marker query and marker parity derived from the one release migration list.
 * Controlled projector ports for every manifest row; a new row is covered without editing this file. No PG/app. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {RELEASE_MIGRATIONS} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/migration-manifest.mjs';
import * as REGISTRY from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/release-cold-projectors.mjs';
import {projectReleaseColdChain,RELEASE_COLD_MARKER_SQL,assertReleaseColdMarkers} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-cold-inspection.mjs';
const H=new URL('../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/',import.meta.url);
const label=m=>m.cold.key.replaceAll('_','-');
// active: number -> boolean; projectors record the order and the catalogue each one receives.
function chain(active={}){
 const seen=[],ports={};
 [...RELEASE_MIGRATIONS].reverse().forEach((m,i)=>{ports[m.cold.project]=value=>{assert.deepEqual(value,{step:i});seen.push(m.number);return{catalogue:{step:i+1},active:active[m.number]===true};};});
 return{seen,run:()=>projectReleaseColdChain({step:0},ports)};
}
const allActive=Object.fromEntries(RELEASE_MIGRATIONS.map(m=>[m.number,true]));

test('the projector registry re-exports exactly one compiled inverse per manifest row from its named contract pair',()=>{
 const text=readFileSync(new URL('release-cold-projectors.mjs',H),'utf8');
 const lines=[...text.matchAll(/^export\{(\w+)\}from'\.\/([a-z0-9-]+-source-compatibility\.mjs)';$/gm)].map(m=>[m[1],m[2]]);
 assert.deepEqual(lines,RELEASE_MIGRATIONS.map(m=>[m.cold.project,m.cold.compatibility]),'one re-export line per manifest row, in manifest order');
 assert.deepEqual(Object.keys(REGISTRY).sort(),RELEASE_MIGRATIONS.map(m=>m.cold.project).sort());
 for(const m of RELEASE_MIGRATIONS){assert.equal(typeof REGISTRY[m.cold.project],'function',m.cold.project);for(const f of [m.cold.compatibility,m.cold.source_contract])assert(existsSync(new URL(f,H)),f);}
});
test('the chain projects newest first, giving each compiled inverse the catalogue its successor left',()=>{
 for(const active of [{},allActive]){const c=chain(active),r=c.run();
  assert.deepEqual(c.seen,[...RELEASE_MIGRATIONS].reverse().map(m=>m.number));assert.deepEqual(r.catalogue,{step:RELEASE_MIGRATIONS.length});
  assert.deepEqual(Object.keys(r.active),RELEASE_MIGRATIONS.map(m=>m.cold.key+'_active'));assert(Object.values(r.active).every(v=>v===(active===allActive)));}
 assert.throws(()=>projectReleaseColdChain({step:0},{}),/release-cold-projector-missing/);
});
RELEASE_MIGRATIONS.forEach((m,i)=>{
 const previous=RELEASE_MIGRATIONS[i-1];
 if(previous&&m.cold.requires)test(`${m.number} activity requires ${previous.number} activity in the cold chain`,()=>{
  // Rows up to m active except its predecessor: m is the only row whose predecessor is inactive.
  const upTo=k=>Object.fromEntries(RELEASE_MIGRATIONS.slice(0,k).map(x=>[x.number,true]));
  assert.throws(()=>chain({...upTo(i+1),[previous.number]:false}).run(),new RegExp(': '+label(m)+'-requires'+previous.number+'$'));
  assert.doesNotThrow(()=>chain(upTo(i-1)).run());assert.equal(chain(upTo(i+1)).run().active[m.cold.key+'_active'],true);
 });
 else test(`${m.number} activity does not require a predecessor (legacy chain row)`,()=>{
  const only={[m.number]:true};assert.equal(chain(only).run().active[m.cold.key+'_active'],true);
 });
 test(`${m.number} marker is read in the held query and must equal its projected activity strictly`,()=>{
  assert(RELEASE_COLD_MARKER_SQL.includes(",EXISTS(SELECT FROM public.migrations WHERE name='"+m.name+"') AS "+m.cold.marker+"_present"));
  const off=Object.fromEntries(RELEASE_MIGRATIONS.map(x=>[x.cold.marker+'_present',false])),idle={};
  assertReleaseColdMarkers(off,idle);assertReleaseColdMarkers({...off,[m.cold.marker+'_present']:true},{[m.cold.key+'_active']:true});
  for(const v of [undefined,false,null,0,1,'true'])assert.throws(()=>assertReleaseColdMarkers({...off,[m.cold.marker+'_present']:v},{[m.cold.key+'_active']:true}),new RegExp(label(m)+'-migration-marker'));
  assert.throws(()=>assertReleaseColdMarkers({...off,[m.cold.marker+'_present']:true},idle),new RegExp(label(m)+'-migration-marker'));
 });
});
test('the marker query lists every release migration once, in ledger order',()=>{
 const names=[...RELEASE_COLD_MARKER_SQL.matchAll(/name='([a-z0-9_]+)'\) AS ([a-z0-9_]+)_present/g)].map(x=>[x[1],x[2]]);
 assert.deepEqual(names,RELEASE_MIGRATIONS.map(m=>[m.name,m.cold.marker]));
 const source=readFileSync(new URL('packing189-cold-inspection.mjs',H),'utf8');
 assert.match(source,/AS delivery209_present"\+RELEASE_COLD_MARKER_SQL\+"/);assert.match(source,/ assertReleaseColdMarkers\(rows\[0\],successor209\);/);
 assert.match(source,/ const chain=projectReleaseColdChain\(original\),owned=chain\.catalogue;/);assert.match(source,/ result=Object\.freeze\(\{\.\.\.result,\.\.\.chain\.active\}\);/);
});
