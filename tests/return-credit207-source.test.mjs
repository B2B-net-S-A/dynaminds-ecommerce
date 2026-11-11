/** File-only source review. This does not parse/execute SQL or certify Native metadata. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {sourceDdlMigrationPlan} from '../tools/build/source-ddl-migration-plan.mjs';
const root=new URL('../',import.meta.url),read=p=>fs.readFile(new URL(p,root),'utf8');
const source=await read('server/207_consumer_return_credit.sql'),hash=s=>createHash('sha256').update(s).digest('hex');
test('new namespace leaves literal188 and prior destinations physical source untouched',async()=>{
 assert.equal(hash(await read('server/188_local_consumer_credit.sql')),'cfa89fad3148555c0d91c5293d5e4727ab80d589681724196b70eb8a798cfbc6');
 assert.equal(hash(await read('server/188_consumer_credit_structure.sql')),'a1ab15d6196fe01f4a156a3f0f97d4080811dafe816e3b20ddd0c483ef7527db');
 assert.equal(hash(await read('server/206_return_credit_destinations_history.sql')),'1c79cbeaff631408370dd9908e73fb092d8e5ca4bf86a874e91072e9f0388bd4');
 assert.doesNotMatch(source,/CREATE OR REPLACE|ALTER FUNCTION|ALTER TABLE public\.local_consumer_credit_|(?:INSERT INTO|UPDATE|DELETE FROM)\s+(?:public\.)?local_consumer_credit_/i);
 const functions=[...source.matchAll(/^CREATE FUNCTION ([^\s(]+)/gm)].map(m=>m[1]);assert(functions.length>20);assert(functions.every(n=>n.startsWith('public.return_credit206_')));
 const tables=[...source.matchAll(/^CREATE TABLE ([^\s(]+)/gm)].map(m=>m[1]);assert.equal(tables.length,8);assert(tables.every(n=>n.startsWith('public.return_credit206_')));
});
test('new source binds full mixed financial history and actual native destinations lineage',()=>{
 for(const atom of ["aa.protocol='destinations_v1' AND aa.sealed",'public.return_credit206_physical_history(rr.id)',
  "PERFORM public.local_consumer_credit_history(eid)","PERFORM public.return_credit206_history(eid)",
  "'legacy' family FROM public.local_consumer_credit_receipts","'destinations' family FROM public.return_credit206_receipts",
  "ORDER BY receipt_sequence,id LOOP","'physical_protocols',protocols,'credit_families',families",'cr.previous_receipt_id IS DISTINCT FROM prev'])assert(source.includes(atom),atom);
 assert(!source.includes('FOREIGN KEY(tenant_id,previous_receipt_id) REFERENCES public.return_credit206_receipts'),'mixed previous pointer is guarded by union lineage, not a self-only FK');
});
test('no-commercial-change receipts advance physical hash but never allocate a financial document or number',()=>{
 const start=source.indexOf('IF units=0 AND shipping=prior_shipping THEN'),end=source.indexOf("rowsj:='[]'",start),branch=source.slice(start,end);
 for(const atom of ['selected_no_change:=true','selected_physical:=physical','ix:=ix+1;CONTINUE','No-change return cannot have a fictitious document'])assert(branch.includes(atom),atom);
 assert(!/INSERT|UPDATE|nextval|sequence\s*:=/i.test(branch));
 assert(source.includes("'schema','consumer-return-credit-calculation/v2','physical_history_hash',physical"));
 assert(source.includes("IF decision->>'status'<>'credit_required' THEN RAISE EXCEPTION"));
});
test('ordinary series and separate counter cannot borrow legacy numbering or swallow source changes',()=>{
 for(const atom of ['CREATE TABLE public.return_credit206_series','REFERENCES public.return_credit206_series(tenant_id,id)',
  "num:=v_prefix||'/'||yr::text||'/'||lpad(seq::text,6,'0')",'chosen.version::text IS DISTINCT FROM',
  "f IS DISTINCT FROM p.snapshot",'FOR UPDATE;seq:=coalesce(seq,0)+1','pg_advisory_xact_lock','public.ordinary188_structure_valid()'])assert(source.includes(atom),atom);
 assert(!source.includes("num:='KOR/'"));assert(!source.includes('KOR148/'));
});
test('reviewed207 activation remains the exact198-entry prefix before literal208 and209 successors',async()=>{
 const db=await read('server/db.ts'),resources=await read('tools/build/resource-definitions.mjs');
 // 35a89ca and later append 211+ (append-only): the reviewed program stays the exact 200-entry Source209 prefix.
 const current=sourceDdlMigrationPlan(db),entries=current.slice(0,200);assert(current.length>=200);assert.equal(hash(JSON.stringify(entries)),'41979be48cd905f2b261627956d64a55c19d13a77924a4fd3aab91fb7d298588');
 assert.equal(entries.length,200);const prior207=entries.slice(0,198);assert.equal(prior207.length,198);assert.equal(hash(JSON.stringify(prior207)),'6df1709017511265754b2de10243d51538d96109386e2ce41fbd368da601bc58');assert.equal(prior207.at(-3).name,'205_header_metadata_projection');
 assert.deepEqual(prior207.slice(-2).map(x=>x.name),['206_return_credit_destinations_history','207_consumer_return_credit']);assert.deepEqual(entries.slice(198),[{name:'208_consumer_return_credit_guard_dedup',file:'208_consumer_return_credit_guard_dedup.sql'},{name:'209_order_merge_delivery_inheritance',file:'209_order_merge_delivery_inheritance.sql'}]);
 for(const file of ['206_return_credit_destinations_history.sql','207_consumer_return_credit.sql'])assert(resources.includes(file));
 assert(source.includes('separately reviewed exact Native207 catalogue/resource successor'));
});

test('preview expiry uses one exact stamp for both immutable timestamps',()=>{
 const preview=source.slice(source.indexOf('CREATE FUNCTION public.return_credit206_preview('),source.indexOf('CREATE FUNCTION public.return_credit206_issue('));
 assert(preview.includes('stamp timestamptz'));assert(preview.includes('stamp:=clock_timestamp()'));assert(preview.includes('snapshot,created_at,expires_at)'));assert(preview.includes("f,stamp,stamp+interval '15 minutes')"));assert(!preview.includes("clock_timestamp()+interval '15 minutes'"));
});
