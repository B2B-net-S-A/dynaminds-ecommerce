import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {checkInventories} from './check.mjs';

const row = (patch = {}) => ({id: 'DOM-orders-create', requirement: 'Create an order through the ordinary user interface.',
  status: 'unverified', acceptance: ['Verify the order and its reservation after restart.'],
  evidence: {code: ['server/orders.ts'], local: [], sandbox: [], account: []}, ...patch});
const input = (rows, patch = {}) => [{name: 'test', document: {schema: 'dynaminds-base-functional-domain-inventory/v1', as_of: '2026-10-17', rows,
  inventory_coverage: {source_catalogue_exhaustive: true},
  inventory_complete: false, coverage_gaps: ['Provider roster discovery remains open.'], ...patch}}];

test('valid partial inventory never implies full coverage; strict completion refuses it', async () => {
  const result = await checkInventories(input([row()]));
  assert(result.valid); assert.equal(result.completion_review_candidate, false); assert.equal(result.acceptance_granted_by_checker, false);
  const strict = await checkInventories(input([row()]), {requireComplete: true});
  assert.equal(strict.valid, false);
});
test('duplicate IDs and missing evidence levels are rejected', async () => {
  assert.equal((await checkInventories(input([row(), row()]))).valid, false);
  const missingLevels = await checkInventories(input([row({evidence: {code: [], local: []}})]));
  assert.equal(missingLevels.valid, false);
});
test('code alone cannot grant accepted local or provider status', async () => {
  for (const status of ['accepted_v2', 'accepted_local', 'accepted_sandbox', 'accepted_account', 'complete']) {
    assert.equal((await checkInventories(input([row({status})]))).valid, false);
  }
});
test('pinned local evidence is verified, and does not stand in for provider account acceptance', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dyna-parity-check-'));
  try {
    const file = path.join(root, 'local-result.json'), bytes = Buffer.from('{"passed":true}\n');
    await fs.writeFile(file, bytes);
    const ref = {path: file, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length};
    const evidence = {code: [], local: [ref], sandbox: [], account: []};
    const local = row({status: 'accepted_local', evidence});
    const closed = input([local], {inventory_complete: true, coverage_gaps: []});
    assert.equal((await checkInventories(closed, {root, requireComplete: true})).completion_review_candidate, true);
    const provider = input([row({...local, provider: 'example'})], {inventory_complete: true, coverage_gaps: []});
    assert.equal((await checkInventories(provider, {root, requireComplete: true})).valid, false);
    await fs.writeFile(file, Buffer.from('{"passed":null}\n'));
    assert.equal((await checkInventories(closed, {root})).valid, false);
  } finally {await fs.rm(root, {recursive: true, force: true});}
});
test('nested scoped evidence is hashed and contradictory provider completion is refused', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dyna-parity-nested-'));
  try {
    const file=path.join(root,'result.json'),bytes=Buffer.from('{"passed":true}\n');await fs.writeFile(file,bytes);
    const ref={path:file,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length};
    const evidence={code:[],local:[{ref,scope:'Only a local process'}],sandbox:[],account:[]};
    const scoped=row({status:'local_scoped_acceptance',provider:'example',evidence});
    const checked=await checkInventories(input([scoped]),{root});assert(checked.valid);assert.equal(checked.evidence_files_verified,1);
    const conflict=row({...scoped,status:'complete',required_evidence_level:'local',verification:{account:'unverified'}});
    assert.equal((await checkInventories(input([conflict],{inventory_complete:true,coverage_gaps:[]}),{root,requireComplete:true})).valid,false);
    const contradictoryRoster=input([row({status:'accepted_local',evidence})],{inventory_complete:true,coverage_gaps:[],summary:{full_base_roster_complete:false}});
    assert.equal((await checkInventories(contradictoryRoster,{root,requireComplete:true})).valid,false);
    await fs.writeFile(file,'changed');assert.equal((await checkInventories(input([scoped]),{root})).valid,false);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('actual nested CLI uses explicit canonical workspace root without accepting completion or bypassing evidence pins',async()=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'dyna parity CLI '))),execute=promisify(execFile);
  try{
    const project=path.join(root,'development','isolated checkout'),tools=path.join(project,'tools/parity'),docs=path.join(project,'docs/parity');
    await fs.mkdir(tools,{recursive:true});await fs.mkdir(docs,{recursive:true});for(const name of ['check.mjs','evidence-archive.mjs'])await fs.copyFile(new URL('./'+name,import.meta.url),path.join(tools,name));
    const proof=path.join(root,'shared proof.json'),bytes=Buffer.from('{"controlled_local_scope":true}');await fs.writeFile(proof,bytes);
    const evidence={code:[],local:[{path:proof,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length}],sandbox:[],account:[]};
    for(const [file,id]of [['domains.json','DOM-CLI-one'],['integrations.json','INT-CLI-one']])await fs.writeFile(path.join(docs,file),JSON.stringify(input([row({id,status:'accepted_local',evidence})])[0].document));
    const entry=path.join(tools,'check.mjs'),run=(...args)=>execute(process.execPath,[entry,...args],{timeout:10000,maxBuffer:32768});
    await assert.rejects(run(),e=>e.code===1&&JSON.parse(e.stdout).errors.every(x=>x.message==='Evidence must remain inside the local project.'));
    const accepted=JSON.parse((await run('--root='+root)).stdout);assert.equal(accepted.valid,true);assert.equal(accepted.evidence_files_verified,1);assert.equal(accepted.completion_review_candidate,false);assert.equal(accepted.acceptance_granted_by_checker,false);
    await assert.rejects(run('--require-complete','--root='+root),e=>e.code===1&&JSON.parse(e.stdout).completion_review_candidate===false);
    const alias=path.join(root,'aliased-root');await fs.symlink(root,alias);
    for(const args of [['--root=relative'],['--root='+root+'/.'],['--root='+alias],['--root='+proof],['--root='+root,'--root='+root],['--root='+root,'--unknown']])await assert.rejects(run(...args),e=>e.code===1);
    await fs.appendFile(proof,'changed');await assert.rejects(run('--root='+root),e=>e.code===1&&JSON.parse(e.stdout).errors.some(x=>x.message.includes('declared size')));
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
