/** File-only authoring guards, not SQL execution or runtime acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {parsers} from 'prettier/plugins/acorn';
const root=new URL('../',import.meta.url),read=p=>fs.readFile(new URL(p,root),'utf8');
const sha=s=>createHash('sha256').update(s).digest('hex');
const source=await read('server/206_return_credit_destinations_history.sql');
const sql=source.replace(/--[^\n]*/g,'');
const old=await read('server/188_local_consumer_credit.sql');
const functions=[...source.matchAll(/CREATE FUNCTION public\.(\w+)\(eid uuid\) RETURNS void/g)].map(m=>m[1]);
test('206 preserves literal148/152/188 source and188 structure catalogue, with exactly two new private readers',async()=>{
 const pins={
  'server/148_return_destinations.sql':'286c07846c2c71176d291eec21c40b1bf32a7d2faa8b155ecf408a2d080c60f1',
  'server/152_catalog_stock_control.sql':'52737f5284811f32607e219cd262fdf796ff097d91d18502b38465e3c6823e1e',
  'server/188_local_consumer_credit.sql':'cfa89fad3148555c0d91c5293d5e4727ab80d589681724196b70eb8a798cfbc6',
  'server/188_consumer_credit_structure.sql':'a1ab15d6196fe01f4a156a3f0f97d4080811dafe816e3b20ddd0c483ef7527db',
 };
 for(const [file,pin]of Object.entries(pins))assert.equal(sha(await read(file)),pin,file);
 assert.deepEqual(functions,['return_credit206_parent','return_credit206_history']);
 assert.doesNotMatch(sql,/CREATE\s+OR\s+REPLACE|CREATE\s+(TABLE|TRIGGER)|\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|GRANT)\b/i);
 assert.match(sql,/REVOKE ALL ON FUNCTION public\.return_credit206_parent\(uuid\),public\.return_credit206_history\(uuid\) FROM PUBLIC,dyna_app/);
 const alterations=[...sql.matchAll(/ALTER FUNCTION\s+([^\s]+)/g)].map(m=>m[1]);
 assert.deepEqual(alterations,['public.return_credit206_parent(uuid)','public.return_credit206_history(uuid)']);
});
test('206 cannot turn a browser protocol label into native148 authority',()=>{
 for(const atom of ['a.txid=pg_current_xact_id()','d.after_snapshot IS NULL','aa.receipt_id IS NULL','ea.sealed',
  "a.protocol IS DISTINCT FROM 'destinations_v1'",'d.actor_id,d.api_key_id,d.transaction_id','a.actor_id,a.api_key_id,a.txid',
  'p.private_scope_nonce','d.request_hash IS DISTINCT FROM public.return_assistant_hash',"s.state='completed'",'public.return_destination_plan(d.payload',
  'plan IS DISTINCT FROM d.payload',"'206 incomplete native parent148 lineage'","'206 native immutable commercial result differs'"]){assert(source.includes(atom),atom);}
 assert.doesNotMatch(sql,/return_destination_(prepare|finish|frame|physical_validate)\s*\(/);
});
test('206 source retains all prior188 physical proof checks and activates exact148 arrival maps',()=>{
 const start=' -- Only immutable received birth is used for original request version checks.';
 const stop=" IF false THEN";
 const oldBody=old.slice(old.indexOf(start),old.indexOf(stop));
 const expected=oldBody.replace("OR op.warehouse_document_id IS NOT NULL OR op.purchase_receipt_id IS NOT NULL OR op.request IS DISTINCT FROM a.frame->'request' THEN",
  "OR op.warehouse_document_id IS NOT NULL OR op.purchase_receipt_id IS NOT NULL\n    OR op.request IS DISTINCT FROM(SELECT x->'request' FROM public.return_destination_admissions da CROSS JOIN LATERAL jsonb_array_elements(da.after_snapshot->'wms_operations')x\n       WHERE(da.tenant_id,da.receipt_id)=(a.tenant_id,r.assistant_receipt_id) AND x->>'id'=r.wms_operation_id::text) THEN");
 assert(source.includes(expected),'All188 birth/item/PZ/stock/bin/layer quantity/cost checks must survive exactly, except native WMS request projection');
 assert.match(source,/IF a\.protocol='destinations_v1' THEN[\s\S]*Brak dokładnych part-arrival map148/);
 assert(source.includes('ar.quantity IS DISTINCT FROM(SELECT sum(im.quantity)'));
 assert(source.includes('im.arrival_id'));
});
test('206 binds every sale/custody/reject part, arrival, native WMS fragment and sealed152 journal',()=>{
 for(const message of ['full typed sale/custody/reject parts differ','full typed arrivals differ','full native WMS fragment bijection differs',
  'sealed birth/current journal set differs','sealed152/169 native journal birth differs','native destination WMS operation differs'])assert(source.includes('206 '+message),message);
 for(const atom of ["jsonb_array_elements(plan->'parts')","jsonb_array_elements(plan->'arrivals')","jsonb_array_elements(plan->'private_fragment_effects')",
  'df.arrival_id,df.receipt_id,df.part_id','d.before_snapshot->nm','d.after_snapshot->nm','ea.before_frame->journal_key','e.after_frame->journal_key',
  "'stock_movement_ids','stock_movements','stock_journals'","'location_movement_ids','stock_location_movements','bin_journals'",
  "'layer_movement_ids','wms_layer_movements','layer_journals'",'bytes>33554432','rowcount>10000'])assert(source.includes(atom),atom);
});
test('206 uses genuine destination WMS request at birth and preserves188 guard decisions',()=>{
 assert(source.includes("jsonb_build_object('protocol','destinations_v1','admission_id',d.receipt_id"));
 assert(source.includes("d.after_snapshot->'wms_operations' @> jsonb_build_array(to_jsonb(op))"));
 assert(source.includes("'206 OFF cannot introduce WMS provenance'"));
 assert(source.includes("public.ordinary188_structure_valid() IS DISTINCT FROM true"));
 assert(source.includes("'206 must preserve literal188 profile'"));
});
test('206 DB fixture is opt-in, refuses Main/nonlocal DB and never bootstraps native proofs on import',async()=>{
 const fixture=await read('tests/return-credit206-history-fixture.ts'),contract=await read('tests/return-credit206-history.database.test.ts');
 assert(fixture.includes("process.env.DYNA_RETURN_CREDIT206_TEST==='true'"));assert(fixture.includes('dynaminds_test_\\d+'));
 assert(fixture.includes("['localhost','127.0.0.1','[::1]']"));assert(fixture.includes("await import('pg')"));
 assert.doesNotMatch(fixture,/from ['"].*server\/db|\bmigrate\s*\(|\bseed\s*\(|INSERT INTO/i);
 assert(contract.includes('skip:!history206Enabled'));
 assert(contract.includes("SET LOCAL session_replication_role='origin'"));
 assert(contract.includes('await literal188206(c);'));
 assert(contract.includes('ROLLBACK TO corruption206'));
});
test('206 ordinary API fixture is import-inert and SQL writes only isolated tenant/IAM metadata',async()=>{
 const fixture=await read('tests/return-credit206-api-fixture.mjs');
 const imported=await import('./return-credit206-api-fixture.mjs');assert.equal(typeof imported.prepareHistory206Cases,'function');
 assert(fixture.includes('dynaminds_test_\\d+'));
 // Execute only the actual parameter defaults, mode validation and loop header.
 // Business-loop contents, imports and every SQL/HTTP/file operation stay unexecuted.
 const tree=parsers.acorn.parse(fixture),text=node=>fixture.slice(node.start,node.end);
 const functions=tree.body.map(n=>n.type==='ExportNamedDeclaration'?n.declaration:n).filter(n=>n?.type==='FunctionDeclaration');
 const driver=functions.find(f=>f.id?.name==='prepareHistory206Cases');
 const wrapper=functions.find(f=>f.id?.name==='prepareHistory206CasesFromPreview');
 assert(driver?.body&&wrapper?.body,'Both fixture entrypoints required');
 const parameters=f=>f.params.map(text).join(',');
 const defaultModes=f=>new Function(`return function(${parameters(f)}){return modes;}`)();
 assert.deepEqual(defaultModes(driver)({}),[false,true],'Default fixture must cover OFF then ON');
 assert.deepEqual(defaultModes(wrapper)(),[false,true],'Preview wrapper must default to both modes');
 const loops=[];const visit=node=>{if(!node||typeof node!=='object')return;if(node.type==='ForOfStatement'&&node.right.type==='Identifier'&&node.right.name==='modes')loops.push(node);for(const value of Object.values(node)){if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')visit(value);}};
 visit(driver.body);assert.equal(loops.length,1,'Modes must drive one actual business loop');
 const loop=loops[0];assert.equal(loop.left.type,'VariableDeclaration');
 assert.equal(loop.left.declarations.length,1);const binding=loop.left.declarations[0].id;
 assert.equal(binding.type,'Identifier');
 const validation=driver.body.body.slice(0,driver.body.body.findIndex(s=>s.type!=='ExpressionStatement'));
 assert(validation.length>0,'Original pre-IO validation must remain');
 const header=fixture.slice(loop.start,loop.body.start);
 const probe=new Function('assert',`return function(${parameters(driver)}){
  const __coverageModesSeen=[];${validation.map(text).join('\n')}
  ${header}{__coverageModesSeen.push(${binding.name});}return __coverageModesSeen;
 }`)(assert);
 assert.deepEqual(probe({}),[false,true],'Default loop must actually visit OFF and ON');
 for(const modes of [[false],[true],[true,false]])assert.deepEqual(probe({modes}),modes);
 for(const modes of [[],[false,false],[true,true],[false,true,false],['false'],[null],null])assert.throws(()=>probe({modes}),'Invalid mode selection must fail before fixture work');
 const writes=[...fixture.matchAll(/INSERT INTO\s+([a-z_]+)/g)].map(x=>x[1]);assert.deepEqual(writes,['tenants','memberships']);
 assert.doesNotMatch(fixture,/\b(UPDATE|DELETE|TRUNCATE)\b|session_replication_role|catalog_stock_return_(prepare|finish)/);
 for(const path of ['/wms-lots/opening-previews','/catalog-stock-control/catalogs/','/return-assistant/sessions','/return-destinations/returns/','/receive'])assert(fixture.includes(path));
 assert(fixture.includes("['sale','custody','reject']"));assert(fixture.includes("['0','1000',null]"));
});
