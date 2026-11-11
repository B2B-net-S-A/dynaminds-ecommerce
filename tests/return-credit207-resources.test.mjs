/** Resource wiring only. No PostgreSQL, runtime construction or Native certification. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {RESOURCE_DEFINITIONS as build} from '../tools/build/resource-definitions.mjs';
import {RESOURCE_DEFINITIONS as runtime} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/resource-definitions.mjs';

const root=new URL('../',import.meta.url);
test('both fixed resource consumers carry one exact206 and207 member without aliases',async()=>{
 assert.deepEqual(build,runtime);
 for(const source of ['server/206_return_credit_destinations_history.sql','server/207_consumer_return_credit.sql']){
  const rows=build.filter(row=>row.id==='sql:'+source||row.source===source||row.path==='resources/'+source);
  assert.deepEqual(rows,[{id:'sql:'+source,source,path:'resources/'+source,consumer:'server/db.ts'}]);
  const bytes=await fs.readFile(new URL(source,root));assert(bytes.length>0&&bytes.length<=16*1024*1024);
 }
 assert.equal(new Set(build.map(x=>x.id)).size,build.length);
 assert.equal(new Set(build.map(x=>x.path)).size,build.length);
 assert(Object.isFrozen(build)&&Object.isFrozen(runtime)&&build.every(Object.isFrozen)&&runtime.every(Object.isFrozen));
});
test('new resource wiring preserves exact literal188 business and structure sources',async()=>{
 const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
 assert.equal(hash(await fs.readFile(new URL('server/188_local_consumer_credit.sql',root))),'cfa89fad3148555c0d91c5293d5e4727ab80d589681724196b70eb8a798cfbc6');
 assert.equal(hash(await fs.readFile(new URL('server/188_consumer_credit_structure.sql',root))),'a1ab15d6196fe01f4a156a3f0f97d4080811dafe816e3b20ddd0c483ef7527db');
});
