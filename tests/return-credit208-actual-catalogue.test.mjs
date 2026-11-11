/** File-only actual source compiler snapshot; never PG/HTTP/Native authority.
 * Run once with --max-old-space-size=1024 and pinned private compiler receipt. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {RETURN_CREDIT208_SOURCE_CONTRACT as E} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/return-credit208-source-contract.mjs';
import {projectReturnCredit208Catalogue as project} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/return-credit208-source-compatibility.mjs';
import {projectReturnCredit207Catalogue as predecessor} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/return-credit207-source-compatibility.mjs';
const locator=process.env.DYNA_SOURCE208_FULL_CATALOGUE_RECEIPT,hash=b=>createHash('sha256').update(b).digest('hex');
test('actual source208 full catalogue restores exact207 then205 and nested inactive208 identity',{skip:!locator},async()=>{
 const stat=await fs.lstat(locator);assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.uid===process.getuid()&&(stat.mode&0o777)===0o600);assert.equal(await fs.realpath(locator),locator);
 const receiptBytes=await fs.readFile(locator);assert.equal(hash(receiptBytes),E.compiler_receipt_sha256);const receipt=JSON.parse(receiptBytes);
 const ref=receipt.after208.catalogue,compressed=await fs.readFile(ref.path);assert.equal(hash(compressed),ref.sha256);assert.equal(compressed.length,ref.bytes);
 let input=JSON.parse(gunzipSync(compressed,{maxOutputLength:67108864}).toString('utf8'));assert.equal(input.sha256,E.source_catalogue_sha256.after208);
 const p=project(input);input=null;assert(p.active);assert.equal(p.catalogue.sha256,E.source_catalogue_sha256.after207);assert.equal(p.catalogue.records.length,40215);
 const old=predecessor(p.catalogue);assert(old.active);assert.equal(old.catalogue.sha256,E.source_catalogue_sha256.before205);assert.equal(old.catalogue.records.length,39676);
 assert.equal(project(old.catalogue).catalogue,old.catalogue);assert.equal(project(old.catalogue).active,false);
 const usage=process.resourceUsage();process.stdout.write(JSON.stringify({status:'ACTUAL_SOURCE_CATALOGUE_INVERSE_PASS',records_before:40243,after207:40215,after205:39676,max_rss_kib:usage.maxRSS,heap_limit_bytes:(await import('node:v8')).getHeapStatistics().heap_size_limit})+'\n');
});
