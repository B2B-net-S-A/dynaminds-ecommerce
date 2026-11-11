import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {preserveEvidenceArchive,extendEvidenceArchive,loadEvidenceArchive} from './evidence-archive.mjs';
import {checkInventories} from './check.mjs';
import {createScopeSnapshot} from './scope-freeze.mjs';
const run=promisify(execFile),sha=b=>createHash('sha256').update(b).digest('hex');
async function fixture(fn){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'scope-evidence-')));let n=0;
 const write=async(value,name=`document-${++n}.json`)=>{const b=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value)+'\n'),file=path.join(root,name);await fs.writeFile(file,b,{flag:'wx',mode:0o600});return{path:file,bytes:b.length,sha256:sha(b)};};
 const evidence=await write(Buffer.from('// original exactly retained\n'),'implementation.ts');
 const row={id:'mirakl.read.A01',provider:'mirakl',requirement:'Read the exact own seller identity.',acceptance:['Match the own seller ID.'],status:'unverified',evidence:{code:[evidence],local:[],sandbox:[],account:[]}};
 const docs={domains:{schema:'domains/v1',as_of:'2026-10-17',inventory_complete:false,rows:[{...row,id:'domain.ordinary',provider:undefined,evidence:{code:[],local:[],sandbox:[],account:[]}}],coverage_gaps:[]},integrations:{schema:'integrations/v1',as_of:'2026-10-17',inventory_complete:false,providers:[{id:'mirakl',name:'Mirakl'}],rows:[row],coverage_gaps:[]},providerRoster:{schema:'dynaminds-base-provider-roster/v1',inventory_complete:false,coverage_complete:false,entries:[{id:'base.mirakl',name:'Mirakl',category:'marketplace',canonical_base_url:'https://base.com/pl-PL/integracje/mirakl/'}],pages:[],coverage_gaps:[]}};
 const inputs=Object.fromEntries(await Promise.all(Object.entries(docs).map(async([name,doc])=>[name,await write(doc)])));
 const inventoryInputs=[{name:'integrations',document:docs.integrations}],request={goal:'FULL-BASE',version:1,snapshot_kind:'partial',inputs,parent:null};
 try{await fn({root,write,evidence,docs,inputs,inventoryInputs,request});}finally{await fs.rm(root,{recursive:true,force:true});}
}
test('exact retained bytes allow explicit historical verification without changing claims or legacy freeze bytes',()=>fixture(async x=>{
 const before=await createScopeSnapshot(x.request,{root:x.root}),parent=await x.write(before);
 const archive=await preserveEvidenceArchive({root:x.root,outputDirectory:x.root+'/retained',entries:[{original_ref:x.evidence,source:{kind:'file',path:x.evidence.path}}]});
 const {evidence_archive:ref,...same}=await createScopeSnapshot({...x.request,evidence_archive:archive},{root:x.root});assert.deepEqual(ref,archive);assert.equal(JSON.stringify(same),JSON.stringify(before));
 await fs.writeFile(x.evidence.path,'// later mutable implementation, different bytes\n');
 assert.equal((await checkInventories(x.inventoryInputs,{root:x.root})).valid,false);
 const checked=await checkInventories(x.inventoryInputs,{root:x.root,evidenceArchive:archive});assert.equal(checked.valid,true);assert.equal(checked.acceptance_granted_by_checker,false);assert.equal(checked.completion_review_candidate,false);assert.equal(checked.inventories[0].required_open,1);
 await assert.rejects(createScopeSnapshot({...x.request,version:2,parent},{root:x.root}),e=>e.code==='INVENTORY_INVALID');
 const successor=await createScopeSnapshot({...x.request,version:2,parent,evidence_archive:archive},{root:x.root});assert.deepEqual(successor.required_ids,before.required_ids);assert.deepEqual(successor.requirements,before.requirements);assert.equal(successor.scope_complete,false);assert.equal(successor.acceptance_granted,false);assert.deepEqual(successor.evidence_archive,archive);assert.deepEqual(successor.parent,parent);
 await fs.unlink(x.evidence.path);assert.equal((await checkInventories(x.inventoryInputs,{root:x.root,evidenceArchive:archive})).valid,true);
 assert.equal((await checkInventories(x.inventoryInputs,{root:x.root})).valid,false);
 assert.equal(JSON.stringify(x.docs.integrations.rows[0].evidence.code[0]),JSON.stringify(x.evidence));
}));
test('exact named historical Git blob can be preserved after mutable code drift; wrong or missing blob cannot',()=>fixture(async x=>{
 const repo=x.root+'/repo';await fs.mkdir(repo);await run('git',['init','-q',repo]);const original=await fs.readFile(x.evidence.path);
 const object=(await run('git',['-C',repo,'hash-object','-w',x.evidence.path])).stdout.trim();assert(/^[a-f0-9]{40}$/.test(object));
 await fs.writeFile(x.evidence.path,'// new implementation\n');const newObject=(await run('git',['-C',repo,'hash-object','-w',x.evidence.path])).stdout.trim();
 const archive=await preserveEvidenceArchive({root:x.root,outputDirectory:x.root+'/git-retained',entries:[{original_ref:x.evidence,source:{kind:'git_blob',repository:repo,object}}]});assert.equal((await checkInventories(x.inventoryInputs,{root:x.root,evidenceArchive:archive})).valid,true);
 await assert.rejects(preserveEvidenceArchive({root:x.root,outputDirectory:x.root+'/wrong',entries:[{original_ref:x.evidence,source:{kind:'git_blob',repository:repo,object:newObject}}]}),/DIGEST/);assert.equal(await fs.stat(x.root+'/wrong').then(()=>true,()=>false),false);
 await assert.rejects(preserveEvidenceArchive({root:x.root,outputDirectory:x.root+'/missing',entries:[{original_ref:x.evidence,source:{kind:'git_blob',repository:repo,object:'0'.repeat(40)}}]}));
 assert.deepEqual(await fs.readFile((await loadEvidenceArchive(archive,{root:x.root})).entries[0].retained_ref.path),original);
}));
test('changed, missing and aliased archive payloads remain refused without changed-byte fallback',()=>fixture(async x=>{
 const archive=await preserveEvidenceArchive({root:x.root,outputDirectory:x.root+'/retained',entries:[{original_ref:x.evidence,source:{kind:'file',path:x.evidence.path}}]});const value=JSON.parse(await fs.readFile(archive.path));const file=value.entries[0].retained_ref.path,before=await fs.readFile(file);
 await fs.writeFile(x.evidence.path,'// changed live file\n');await fs.writeFile(file,Buffer.alloc(before.length,65));assert.equal((await checkInventories(x.inventoryInputs,{root:x.root,evidenceArchive:archive})).valid,false);
 await fs.unlink(file);assert.equal((await checkInventories(x.inventoryInputs,{root:x.root,evidenceArchive:archive})).valid,false);await fs.symlink(x.evidence.path,file);assert.equal((await checkInventories(x.inventoryInputs,{root:x.root,evidenceArchive:archive})).valid,false);await fs.unlink(file);await fs.writeFile(file,before);
 for(const mutate of [v=>v.entries.push(structuredClone(v.entries[0])),v=>v.entries[0].retained_ref.sha256='0'.repeat(64),v=>v.entries[0].retained_ref.path='/outside/root',v=>v.acceptance_granted=true]){const bad=structuredClone(value);mutate(bad);const ref=await x.write(bad);assert.equal((await checkInventories(x.inventoryInputs,{root:x.root,evidenceArchive:ref})).valid,false);}
 const changed=await x.write({...value,schema:'invalid'});await assert.rejects(loadEvidenceArchive({...changed,sha256:archive.sha256},{root:x.root}),/DIGEST/);
 assert.equal((await checkInventories(x.inventoryInputs,{root:x.root})).valid,false);
}));
test('an archive for another historical pin never authorizes the requested evidence and output is EXCL',()=>fixture(async x=>{
 const b=Buffer.from('different historical source\n'),other=await x.write(b,'other.ts');const archive=await preserveEvidenceArchive({root:x.root,outputDirectory:x.root+'/retained',entries:[{original_ref:{...other,path:x.evidence.path},source:{kind:'file',path:other.path}}]});await fs.writeFile(x.evidence.path,'changed');
 assert.equal((await checkInventories(x.inventoryInputs,{root:x.root,evidenceArchive:archive})).valid,false);
 await assert.rejects(preserveEvidenceArchive({root:x.root,outputDirectory:x.root+'/retained',entries:[{original_ref:other,source:{kind:'file',path:other.path}}]}),e=>e.code==='EEXIST');
}));

async function extendedParent(x){
 const second=await x.write(Buffer.from('// second historically referenced file\n'),'second-implementation.ts');
 x.docs.integrations.rows[0].evidence.code.push(second);
 const inputs={...x.inputs,integrations:await x.write(x.docs.integrations)};
 const firstArchive=await preserveEvidenceArchive({root:x.root,outputDirectory:x.root+'/parent-retained',entries:[{original_ref:x.evidence,source:{kind:'file',path:x.evidence.path}}]});
 const request={...x.request,inputs,evidence_archive:firstArchive};
 const parentValue=await createScopeSnapshot(request,{root:x.root}),parent=await x.write(parentValue);
 const secondArchive=await preserveEvidenceArchive({root:x.root,outputDirectory:x.root+'/next-retained',entries:[{original_ref:second,source:{kind:'file',path:second.path}}]});
 const previous=JSON.parse(await fs.readFile(firstArchive.path)),current=JSON.parse(await fs.readFile(secondArchive.path));
 const extended=await x.write({...current,entries:[...previous.entries,...current.entries]});
 return {second,request,parentValue,parent,previous,current,extended};
}
test('successor extends an existing parent archive after another historical file drifts without replacing any mapping',()=>fixture(async x=>{
 const f=await extendedParent(x);
 await fs.writeFile(x.evidence.path,'// later first implementation\n');
 await fs.writeFile(f.second.path,'// later second implementation\n');
 await assert.rejects(createScopeSnapshot({...f.request,version:2,parent:f.parent},{root:x.root}),e=>e.code==='INVENTORY_INVALID');
 const result=await createScopeSnapshot({...f.request,version:2,parent:f.parent,evidence_archive:f.extended},{root:x.root});
 assert.deepEqual(result.requirements,f.parentValue.requirements);assert.deepEqual(result.required_ids,f.parentValue.required_ids);
 assert.deepEqual(result.parent,f.parent);assert.deepEqual(result.evidence_archive,f.extended);assert.equal(result.scope_complete,false);assert.equal(result.acceptance_granted,false);
 assert.deepEqual(JSON.parse(await fs.readFile(f.request.evidence_archive.path)),f.previous);
}));
test('extended archives refuse removed mapping, replacement retained location/provenance or changed bytes even if live files still match',()=>fixture(async x=>{
 const f=await extendedParent(x),base=JSON.parse(await fs.readFile(f.extended.path));
 const copy=await x.write(await fs.readFile(x.evidence.path),'same-bytes-other-location.ts');
 for(const mutate of [
  d=>d.entries.shift(),
  d=>{d.entries[0].retained_ref=copy;},
  d=>{d.entries[0].source={kind:'file',path:copy.path};},
 ]){
  const d=structuredClone(base);mutate(d);const ref=await x.write(d);
  await assert.rejects(createScopeSnapshot({...f.request,version:2,parent:f.parent,evidence_archive:ref},{root:x.root}),e=>e.code==='PARENT_EVIDENCE_ARCHIVE_CHANGED');
 }
 const file=base.entries[0].retained_ref.path;await fs.writeFile(file,Buffer.alloc(base.entries[0].retained_ref.bytes,65));
 await assert.rejects(createScopeSnapshot({...f.request,version:2,parent:f.parent,evidence_archive:f.extended},{root:x.root}),e=>e.code==='EVIDENCE_ARCHIVE_DIGEST');
}));
test('extendEvidenceArchive keeps every parent row verbatim, retains only the new pin and refuses re-mapping a parent pin',()=>fixture(async x=>{
 const f=await extendedParent(x);
 const extended=await extendEvidenceArchive({root:x.root,parent:f.request.evidence_archive,outputDirectory:x.root+'/extended',entries:[{original_ref:f.second,source:{kind:'file',path:f.second.path}}]});
 const value=JSON.parse(await fs.readFile(extended.path));assert.equal(value.entries.length,2);assert.deepEqual(value.entries[0],f.previous.entries[0]);
 assert.deepEqual(value.entries[1].original_ref,f.second);assert.equal(value.entries[1].retained_ref.path,x.root+'/extended/new-retained/'+f.second.sha256+'.bin');
 assert.deepEqual((await fs.readdir(x.root+'/extended/new-retained')).sort(),[f.second.sha256+'.bin']);
 await fs.writeFile(x.evidence.path,'// later first implementation\n');await fs.writeFile(f.second.path,'// later second implementation\n');
 const result=await createScopeSnapshot({...f.request,version:2,parent:f.parent,evidence_archive:extended},{root:x.root});
 assert.deepEqual(result.requirements,f.parentValue.requirements);assert.deepEqual(result.evidence_archive,extended);assert.equal(result.acceptance_granted,false);
 await assert.rejects(extendEvidenceArchive({root:x.root,parent:extended,outputDirectory:x.root+'/again',entries:[{original_ref:x.evidence,source:{kind:'file',path:x.evidence.path}}]}),e=>e.code==='EVIDENCE_ARCHIVE_DUPLICATE');
 assert.equal(await fs.stat(x.root+'/again').then(()=>true,()=>false),false);
 await assert.rejects(extendEvidenceArchive({root:x.root,parent:{...extended,sha256:'0'.repeat(64)},outputDirectory:x.root+'/forged',entries:[{original_ref:f.second,source:{kind:'file',path:f.second.path}}]}),/DIGEST/);
}));
