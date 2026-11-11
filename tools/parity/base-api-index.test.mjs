import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {parseBaseApiIndex,main} from './base-api-index.mjs';
const row=(method='getOrders',href='index.php?method='+method)=>`<tr><td><b><a href="${href}">${method}</a></b></td><td>Not copied into the inventory.</td></tr>`;
const html=(rows=row(),tail='')=>Buffer.from(`<div class="main_text"><div class="header">Orders</div><h3>Orders</h3><table>${rows}</table><div class="header">Order returns</div><h3>Returns</h3><table>${row('getOrderReturns')}</table>${tail}</div>`);
test('separate same-named groups retain family identity and no implementation acceptance follows enumeration',()=>{
 const x=parseBaseApiIndex(html());assert.equal(x.index_entries,2);assert.deepEqual(x.families,{Orders:1,'Order returns':1});assert.equal(x.methods[1].source_url,'https://api.baselinker.com/index.php?method=getOrderReturns');
 assert.equal(x.methods[0].id,'BASE-API-getOrders');assert.equal(x.index_snapshot_enumerated,true);assert.equal(x.full_contract_inventory_complete,false);assert.equal(x.implementation_coverage_measured,false);assert.equal(x.acceptance_granted,false);assert(x.methods.every(m=>m.contract_reviewed===false&&m.acceptance_granted===false));
 assert(!JSON.stringify(x).includes('Not copied'));
});
test('duplicate, hidden or moved method entries refuse instead of silently shrinking the index',()=>{
 assert.throws(()=>parseBaseApiIndex(html(row()+row())),/duplicate-method/);
 assert.throws(()=>parseBaseApiIndex(html(row(),'<a href="index.php?method=hiddenMethod">hiddenMethod</a>')),/unclassified-method/);
 assert.throws(()=>parseBaseApiIndex(Buffer.from('<div class="main_text"><table>'+row()+'</table></div>')),/family-and-group/);
 assert.throws(()=>parseBaseApiIndex(Buffer.from('<div class="main_text"></div>')),/nonempty-method-index/);
});
test('foreign hosts, alternate paths, extra arguments and mismatched labels cannot become official methods',()=>{
 for(const href of ['https://evil.example/index.php?method=getOrders','/connector.php?method=getOrders','index.php?method=getOrders&other=1','index.php?method=getOrders&method=getOrders','index.php?method=getOrders#x','index.php?method=setOrderFields'])assert.throws(()=>parseBaseApiIndex(html(row('getOrders',href))));
 assert.throws(()=>parseBaseApiIndex(html(row('get_Orders'))));
});
test('UTF8 and document size are bounded; scripts remain inert and no external resource is fetched',()=>{
 assert.throws(()=>parseBaseApiIndex(Buffer.from([0xff])));assert.throws(()=>parseBaseApiIndex(Buffer.alloc(2*1024*1024+1)));
 const x=parseBaseApiIndex(html(row(),'<script>throw Error("must not run")</script><img src="https://invalid.example/a">'));
 assert.equal(x.index_entries,2);
});
test('file-only CLI uses exclusive output and cannot overwrite source or a prior inventory',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'base-api-index-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const input=path.join(directory,'index.html'),output=path.join(directory,'inventory.json');await fs.writeFile(input,html());
 assert.equal((await main([input,output])).index_entries,2);assert.equal((await fs.stat(output)).mode&0o777,0o600);
 const before=await fs.readFile(output);await assert.rejects(()=>main([input,output]));assert.deepEqual(await fs.readFile(output),before);await assert.rejects(()=>main([input,input]));assert.deepEqual(await fs.readFile(input),html());
});
