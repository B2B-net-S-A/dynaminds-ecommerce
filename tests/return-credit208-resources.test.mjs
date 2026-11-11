/** File/resource wiring only. No app import, PostgreSQL, factory or Native acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {RESOURCE_DEFINITIONS as build} from '../tools/build/resource-definitions.mjs';
import {RESOURCE_DEFINITIONS as runtime} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/resource-definitions.mjs';
import {readRuntimeResource} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/runtime-resources.mjs';
import {sourceDdlMigrationPlan} from '../tools/build/source-ddl-migration-plan.mjs';

const project=new URL('../',import.meta.url),read=file=>fs.readFile(new URL(file,project)),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const migration='208_consumer_return_credit_guard_dedup',source='server/'+migration+'.sql',entry={id:'sql:'+source,source,path:'resources/'+source,consumer:'server/db.ts'};
const resourceLine='  '+JSON.stringify(entry)+',\n',migrationLine="      ['208_consumer_return_credit_guard_dedup', './208_consumer_return_credit_guard_dedup.sql'],\n";
const oldDb={path:'server/db.ts',sha256:'c3e06f257cdb57c3c0653267fdb4287c0d30c5856dcfedc0faffea2d9e9b2e14',bytes:38881};

// The release XSD rows (schemas/mf with its manifest, consumer server/mf-xsd.ts) are appended after the last 208-era
// definition; they are reversed literally here, so the hash below still witnesses the bytes of every previous row.
const xsdPaths=['manifest.json',...JSON.parse((await read('schemas/mf/manifest.json')).toString('utf8')).files.map(f=>f.path)];
const xsdRows=xsdPaths.map(p=>',\n  {\n    "id": "xsd:'+p+'",\n    "source": "schemas/mf/'+p+'",\n    "path": "resources/schemas/mf/'+p+'",\n    "consumer": "server/mf-xsd.ts"\n  }').join('');

test('build and runtime register exactly one fixed208 member and preserve every previous definition byte',async()=>{
 assert.deepEqual(build,runtime);assert.deepEqual(build.filter(row=>row.id===entry.id||row.source===entry.source||row.path===entry.path),[entry]);
 assert.deepEqual(build.slice(0,3).map(row=>row.source),[source,'server/207_consumer_return_credit.sql','server/206_return_credit_destinations_history.sql']);
 assert.equal(new Set(build.map(row=>row.id)).size,build.length);assert.equal(new Set(build.map(row=>row.path)).size,build.length);assert.equal(new Set(build.map(row=>row.source)).size,build.length);
 assert(Object.isFrozen(build)&&Object.isFrozen(runtime)&&build.every(Object.isFrozen)&&runtime.every(Object.isFrozen));
 for(const file of ['tools/build/resource-definitions.mjs','shared/large-import-dependencies/pim-large-import173-business-traversal-ui/resource-definitions.mjs']){
  const text=(await read(file)).toString('utf8').replace(xsdRows,'');assert.equal(text.split(resourceLine).length,2);assert.equal(hash(text.replace(resourceLine,'')),'0c053c4528b23f5f65f06e7bcf2e9203d10eea2f97513c8e6517cd19875096cc');
 }
});
// Reverse ONLY the two separately reviewed split-hook commits148d5c5/3db244a.
// Intermediate whole-source hashes make this a literal lineage witness, not a
// refreshed snapshot or permission to accept different transaction-manager code.
const removeExact=(text,part,count=1)=>{assert.equal(text.split(part).length,count+1);return text.split(part).join('');};
// Source209 db.ts (ebf1880) is history: 3314290 and later commits changed db.ts beyond the
// 209 append, so the lineage below starts from these exact bytes, not from the live file.
const SOURCE209_DB={
  "bytes": 39840,
  "sha256": "d939539e7b085446869f7ce81ae0d534c236fab7aff914b03047ab708f38350b",
  "gzip_base64": "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"
};
function source209Db(){const bytes=gunzipSync(Buffer.from(SOURCE209_DB.gzip_base64,'base64'),{maxOutputLength:SOURCE209_DB.bytes});assert.equal(bytes.length,SOURCE209_DB.bytes);assert.equal(hash(bytes),SOURCE209_DB.sha256);return bytes.toString('utf8');}
function historical208Db(current){
 let text=removeExact(current,"      ['209_order_merge_delivery_inheritance', './209_order_merge_delivery_inheritance.sql'],\n");
 assert.equal(Buffer.byteLength(text),39746);assert.equal(hash(text),'57fb0d26b1b7eeaa857f781c8e575a3ad4e9d43ab6e82cdd9c56282bb3f8f171','209 append reverses to exact3db244a');
 text=removeExact(text,"import {assertOrderSplitCompositionInTx} from './order-split-composition';\n");
 text=removeExact(text,'    assertOrderSplitCompositionInTx(c);\n',2);
 assert.equal(Buffer.byteLength(text),39591);assert.equal(hash(text),'804eec0e179430a1fd759a473b692d43996fe6ef6bf05cb425c5ecda4f80ffc3','exact148d5c5 before mixed-duty guard');
 text=removeExact(text,"import {beginOrderSplitTransaction,endOrderSplitTransaction,hasOrderSplitTransactionDuty,finalizeOrderSplitTransactionInTx} from './order-split-transaction';\n");
 text=removeExact(text,'    beginOrderSplitTransaction(c);\n',2);
 assert.equal(text.split('catch(e){endOrderSplitTransaction(c);activeManagedSchemaTransactions').length,2);
 text=text.replace('catch(e){endOrderSplitTransaction(c);activeManagedSchemaTransactions','catch(e){activeManagedSchemaTransactions');
 assert.equal(text.split('finally{endOrderSplitTransaction(c);activeManagedSchemaTransactions').length,2);
 text=text.replace('finally{endOrderSplitTransaction(c);activeManagedSchemaTransactions','finally{activeManagedSchemaTransactions');
 text=removeExact(text,'    endOrderSplitTransaction(c);\n');
 text=removeExact(text,`    // Split's fixed current-request boundary follows ALL sibling work and the
    // complete public drain, even when this transaction never started PIM.
    if(hasOrderSplitTransactionDuty(c)){
      await drainPublicConstraintsInTx(c);
      await finalizeOrderSplitTransactionInTx(c);
    }
`);
 assert.equal(Buffer.byteLength(text),38979);assert.equal(hash(text),'35f7084c683b7f6bde18735d0cfdf18becb95b21a44b667130d1b047bd624543','exact historical208 source');return text;
}
test('208 retains the entire historical207 program; exact209 append and reviewed split hooks reverse byte-for-byte',async()=>{
 const text=source209Db(),plan=sourceDdlMigrationPlan(text);assert.equal(plan.length,200);
 assert.deepEqual(plan.slice(-5).map(row=>row.name),['205_header_metadata_projection','206_return_credit_destinations_history','207_consumer_return_credit',migration,'209_order_merge_delivery_inheritance']);
 // Migrations are append-only: the current program must keep the exact Source209 prefix.
 assert.deepEqual(sourceDdlMigrationPlan((await read('server/db.ts')).toString('utf8')).slice(0,plan.length),plan);
 const historical=historical208Db(text);assert.deepEqual(sourceDdlMigrationPlan(historical),plan.slice(0,-1));
 const predecessor=Buffer.from(removeExact(historical,migrationLine));assert.equal(predecessor.length,oldDb.bytes);assert.equal(hash(predecessor),oldDb.sha256);
 assert.deepEqual(sourceDdlMigrationPlan(predecessor.toString('utf8')),plan.slice(0,-2));
});
test('the actual fixed source resource reader returns frozenV2 bytes and rejects aliases or unrelated consumers',async()=>{
 const bytes=await readRuntimeResource(entry.id,new URL('server/db.ts',project));assert.deepEqual(bytes,await read(source));assert.equal(bytes.length,471074);assert.equal(hash(bytes),'a0091c26296575ea5b9b97fc794535e79bbcbfa056dcfa2ac33bab96c0c226a8');
 await assert.rejects(readRuntimeResource('sql:server/208_consumer_return_credit.sql',new URL('server/db.ts',project)),/resource-id-unavailable/);
 await assert.rejects(readRuntimeResource(entry.id,new URL('server/return-credit206-service.ts',project)),/not-original-source-consumer/);
});
test('coverage restores the literal207 snapshot after exact six207, a251dfe and thirteen236 source-pin and comment lineage changes',async()=>{
 const text=(await read('server/catalog-stock-writer-coverage.ts')).toString('utf8'),roster=JSON.parse(text.match(/const SOURCE_ROSTER:readonly Entry\[\]=(\[[^\n]+\]);/)[1]),native=JSON.parse(text.match(/const NATIVE_ROSTER:readonly Entry\[\]=(\[[^\n]+\]);/)[1]);
 assert.equal(roster.length,43);assert.equal(native.length,3);const db=await read('server/db.ts'),current={path:'server/db.ts',sha256:hash(db),bytes:db.length};assert.deepEqual(roster.filter(row=>row.path==='server/db.ts'),[current]);assert.equal(text.split(JSON.stringify(current)).length,2);
 let historical=text;
 // Source269 added the pin of server/order-warehouse-transfer.ts (a new writer front, not a re-pin) and its comment;
 // both go first.
 const source269Pin=roster.find(r=>r.path==='server/order-warehouse-transfer.ts');assert(source269Pin);
 assert.equal(historical.split(','+JSON.stringify(source269Pin)).length,2);historical=historical.replace(','+JSON.stringify(source269Pin),'');
 const source269Comment="// Source269 adds server/order-warehouse-transfer.ts after review: \"Zmie\u0144 magazyn\" and the rule effect assign_warehouse admit the\n// order like a reservation edit (catalog lock, inventory policies of both warehouses, LINE_BLOCKERS, WMS lots off) and call\n// only the owner function order_warehouse269_transfer (269 SQL), whose one transaction returns stock.reserved and the location\n// rows in the old warehouse and reserves the same quantities (stock, reservations, free bins) in the new; no other stock write.\n";
 assert.equal(historical.split(source269Comment).length,2);historical=historical.replace(source269Comment,'');
 // SourceDbLocks re-pinned db.ts (tenantTx checks held session locks before COMMIT) and added its comment, which goes first.
 const sourceDbLocksComment="// SourceDbLocks re-pins db.ts after review: tenantTx calls assertDbLocksHeldInTx(c) right before COMMIT, which refuses\n// the commit (rollback) when a session advisory lock of the async context was lost (one pg_locks read only under\n// holdingDbLock); no stock write, stock-writer call or gate bypass.\n";
 assert.equal(historical.split(sourceDbLocksComment).length,2);historical=historical.replace(sourceDbLocksComment,'');
 // SourceDbErrors re-pinned db.ts (the ordinary pool is built through watchDbPool; db.ts is reversed to208 with the
 // prior pins below) and added its comment, which goes first.
 const sourceDbErrorsComment="// SourceDbErrors re-pins db.ts after review: the ordinary pool is built through watchDbPool (db-connection-errors.ts),\n// which only adds 'error' listeners (idle pool + every checked-out client) that log and count a lost connection; the\n// old idle-only listener is gone. Pool options, transactions and stock hooks unchanged; no stock write or gate bypass.\n";
 assert.equal(historical.split(sourceDbErrorsComment).length,2);historical=historical.replace(sourceDbErrorsComment,'');
 // SourceOrderNumber re-pinned domain.ts (createOrder redraws a taken order number under a savepoint) and added its
 // comment, which goes first; domain.ts returns to its Source246 pin.
 const source246Domain={path:'server/domain.ts',sha256:'4c81ee257911e5abfb3c56599a8519bd48180110957db24d603401d188b3e800',bytes:48209},domainOrderNumber=roster.find(r=>r.path==='server/domain.ts');
 assert.notDeepEqual(domainOrderNumber,source246Domain);assert.equal(historical.split(JSON.stringify(domainOrderNumber)).length,2);historical=historical.replace(JSON.stringify(domainOrderNumber),JSON.stringify(source246Domain));
 const sourceOrderNumberComment='// SourceOrderNumber re-pins domain.ts after review: createOrder runs its one orders INSERT through insertOrderWithNumberInTx,\n// which redraws a taken DE-<date>-<hex> number under a savepoint; no stock write, stock-writer call or gate bypass.\n';
 assert.equal(historical.split(sourceOrderNumberComment).length,2);historical=historical.replace(sourceOrderNumberComment,'');
 // SourceOpening re-pinned wms-lots.ts and added its comment, which goes first; wms-lots.ts returns to its Source250 pin.
 const source250WmsLots={path:'server/wms-lots.ts',sha256:'a74cc7d661bf552cb9cf08da2ce1ca66daad62b20ef3ca4b97aff2f11981ba5c',bytes:95861},wmsOpening=roster.find(r=>r.path==='server/wms-lots.ts');
 assert.notDeepEqual(wmsOpening,source250WmsLots);assert.equal(historical.split(JSON.stringify(wmsOpening)).length,2);historical=historical.replace(JSON.stringify(wmsOpening),JSON.stringify(source250WmsLots));
 const sourceOpeningComment='// SourceOpening re-pins wms-lots.ts after review: the opening row cap is per plan (enterprise 200 000) and rows\n// without stock are locked and digested in SQL instead of loaded; no new stock write, stock-writer call or gate bypass.\n';
 assert.equal(historical.split(sourceOpeningComment).length,2);historical=historical.replace(sourceOpeningComment,'');
 const priorPins=[oldDb,
 {path:'server/allegro-oauth-authority.ts',sha256:'ccca36ea47f74875ad6370c242f7cf550862ce40148f454dbfc9696664d1e9b0',bytes:27978},
 {path:'server/catalog-stock-control-transaction.ts',sha256:'18076981a548025b662e9eb21eff67b2ab789467ceaa1cb37eff65aaa7edca0f',bytes:15308},
 {path:'server/dispatch-transaction.ts',sha256:'f0079edf72b896cda75d0617fad4ae8cd45fecf4d38b695acb81e1dfedcf4b25',bytes:3766},
 {path:'server/financial-return-completion.ts',sha256:'a03f402dd1dd367048c4a29bc9d0afebe6461a186bacc1954e8f30d344cc5b09',bytes:11884},
 {path:'server/inventory-correction.ts',sha256:'b46d2dbb8ebd467964b1e334056e8d6468cbd78fab066e018d055da168e5caff',bytes:11202}];
 for(const before of priorPins){const after=roster.find(r=>r.path===before.path);assert(after);assert.equal(historical.split(JSON.stringify(after)).length,2);historical=historical.replace(JSON.stringify(after),JSON.stringify(before));}
 // Source236 re-pinned14 reviewed sources; db.ts is already reversed to208 above. The other
 // thirteen return to their exact pre236 pins (returns.ts first to its a251dfe pin).
 const pre236Pins=[
 {path:'server/b2b-network.ts',sha256:'b00a63a943e494b3f4f7bcf9059d42662f9313e260694cfd03992819f1fe221c',bytes:42115},
 {path:'server/catalog-file-import.ts',sha256:'bddd733d90f9cc75acb6e5c48aa18e186527d3a40c4aea3170dc2cfdd09c17cc',bytes:50440},
 {path:'server/catalog.ts',sha256:'114a0b95083f2ec4e77251db6f2983a7f6a49896fb90d9a853924095d34157bb',bytes:28181},
 {path:'server/developer-api.ts',sha256:'73b6b9d18abecae79e5e13fffdeb7a620deab9eb06f2bf865172bc3f1659b86b',bytes:229352},
 {path:'server/domain.ts',sha256:'fae7b853a3ca8dc2328058356dbb4c2e52d462a7c2a8f29a2b75aa767ec1e476',bytes:47587},
 {path:'server/fa3-drafts.ts',sha256:'09b256c00b59ac8ae72549ff266d7578ca4d8ab9aad359019c72a42e6d57dca8',bytes:18691},
 {path:'server/inventory-bulk-edit.ts',sha256:'de732ab4ae67c9618f8ac10f088b04f5ca2b9c13a8e85b68a34245a133e9ebca',bytes:33961},
 {path:'server/purchasing.ts',sha256:'49bc8f82237e04340a3a8f8597525334972762680aa0b81ab392dbfbdadb0d13',bytes:21211},
 {path:'server/return-query.ts',sha256:'6370b5681d89a712e9aa763b6c7b75c5b82a0fefb39f4baae959d26cdcf508e6',bytes:4516},
 {path:'server/returns.ts',sha256:'0f32350c256f88cf88e1d7f3cf5d5b2a4d75e86d19741d4121f1473d8cdbef0a',bytes:39085},
 {path:'server/stock-file-import.ts',sha256:'ee163d00e7c9a2844cbf52f2acd95887094028f57090faa6b23e01b255da2258',bytes:46808},
 {path:'server/warehouse.ts',sha256:'592908ec669c994149a4830ff9fd4c01e08377ec8940cfbb3280903f3445cf43',bytes:15954},
 {path:'server/wms-lots.ts',sha256:'71be7fdb5b68502f1c3b14c52d273c615ab790e47cf034dae866909746982e5f',bytes:96400}];
 // Source272 re-pinned financial-return-completion.ts (reversed with the other prior pins above) and added its comment,
 // which goes first.
 const source272Comment="// Source272 re-pins financial-return-completion.ts after review: the ordinary receive asks the owner-only 272 front\n// door, which returns null only where the sealed financial_return_capture would; no stock write or gate bypass.\n";
 assert.equal(historical.split(source272Comment).length,2);historical=historical.replace(source272Comment,'');
 // Source270 re-pinned catalog-stock-control.ts and catalog-stock-return-effects.ts (both literal before it) and added
 // its comment, which goes first; the two return to their literal pins.
 for(const before of [{path:'server/catalog-stock-control.ts',sha256:'a37ebf48c1ceabe920ebf48ad27e7bb16942589ddcd7223017200a7f8800531d',bytes:29004},
  {path:'server/catalog-stock-return-effects.ts',sha256:'a56ab5b2977b9fbb23c963a76788c2e8dc993651f463d949ecc811469d5e99d5',bytes:8218}]){
  const after=roster.find(r=>r.path===before.path);assert.notDeepEqual(after,before);assert.equal(historical.split(JSON.stringify(after)).length,2);historical=historical.replace(JSON.stringify(after),JSON.stringify(before));
 }
 const source270Comment="// Source270 re-pins catalog-stock-control.ts and catalog-stock-return-effects.ts after review: effect prepare/finish and\n// return prepare call the stock_verdict_ copy when installed (sealed body, 248 verdict for the guard); no stock write or gate bypass.\n";
 assert.equal(historical.split(source270Comment).length,2);historical=historical.replace(source270Comment,'');
 // Source264 re-pinned catalog-stock-control-transaction.ts (reversed with the other prior pins above) and added its
 // comment, which goes first.
 const source264Comment="// Source264 re-pins catalog-stock-control-transaction.ts after review: availability reuses the first full guard's\n// 'available' within one READ ONLY REPEATABLE READ transaction (transaction-local marker); no stock write or gate bypass.\n";
 assert.equal(historical.split(source264Comment).length,2);historical=historical.replace(source264Comment,'');
 // Source251 re-pinned b2b-network.ts (invitation, acceptance and settings ask the 251 link state) and added
 // its comment, which goes first; b2b-network.ts returns to its Source236 pin, then with the others to its pre236 pin.
 const source236Network={path:'server/b2b-network.ts',sha256:'aaa4d590ea5f571c1f7480314b7d0ae28efdd8af0362467a9b4a059df11e5b64',bytes:46875},network251=roster.find(r=>r.path==='server/b2b-network.ts');
 assert.notDeepEqual(network251,source236Network);assert.equal(historical.split(JSON.stringify(network251)).length,2);historical=historical.replace(JSON.stringify(network251),JSON.stringify(source236Network));
 const source251Comment='// Source251 re-pins b2b-network.ts after review: invitation, acceptance and settings ask the 251 link state\n// (b2b258_link_states); a reconnect updates the b2b_links row in place; no stock write, stock-writer call or gate bypass.\n';
 assert.equal(historical.split(source251Comment).length,2);historical=historical.replace(source251Comment,'');
 // SourceMIG1 re-pinned db.ts (already reversed to208 above) and added its comment, which goes first.
 const sourceMig1Comment="// SourceMIG1 re-pins db.ts after review: migrate() waits for its 982376 fence with its own budget (SET LOCAL, then the\n// session limits again) and names a failed migration of the one-transaction series; no stock write or gate bypass.\n";
 assert.equal(historical.split(sourceMig1Comment).length,2);historical=historical.replace(sourceMig1Comment,'');
 // Source250 re-pinned wms-lots.ts, stock-file-import.ts and stocktake-adjustments.ts and added its comment, which go
 // first; the three return to their Source236 pins (and from there to pre236 below).
 const source236Of250=[
  {path:'server/wms-lots.ts',sha256:'1bd47b5a2d41eddd98577bf0e775b0760622bae04e49d040bbe6f2cfa78743bf',bytes:94695},
  {path:'server/stock-file-import.ts',sha256:'735fceaaa72ed439471b328398c5d0152146993a8b0a637474bcbab01e45b4b1',bytes:47075},
  {path:'server/stocktake-adjustments.ts',sha256:'c6fd2ac6c9de981733d590f5e61f1608d8f854ed9ba4bc202bdeac58c3e4f60a',bytes:30953}];
 for(const before of source236Of250){
  const after=before.path==='server/wms-lots.ts'?source250WmsLots:roster.find(r=>r.path===before.path);assert.notDeepEqual(after,before);assert.equal(historical.split(JSON.stringify(after)).length,2);historical=historical.replace(JSON.stringify(after),JSON.stringify(before));
 }
 const source250Comment='// Source250 re-pins wms-lots.ts, stock-file-import.ts and stocktake-adjustments.ts after review: shared WMS\n// operations fence, client-key and scan stock locks, serial admission of stocktake writers; no new stock write.\n';
 assert.equal(historical.split(source250Comment).length,2);historical=historical.replace(source250Comment,'');
 // Source248 re-pinned catalog-stock-control-transaction.ts and financial-return-completion.ts (reversed with the other
 // prior pins above) and added its comment, which goes first.
 const source248Comment="// Source248 re-pins catalog-stock-control-transaction.ts and financial-return-completion.ts after review: inside a\n// transaction each asks the owner-only guard_verdict() for its full guard (same answer or error); no stock write or gate bypass.\n";
 assert.equal(historical.split(source248Comment).length,2);historical=historical.replace(source248Comment,'');
 // Source246 re-pinned domain.ts (new->picking admits an order on trade credit) and added its comment, which goes
 // first; domain.ts returns to its Source245 pin.
 const source245Domain={path:'server/domain.ts',sha256:'88346c0e8f7448fd7bb5bb2b63786e26990dc8d9090a3b3d1866f226ae55ffc8',bytes:48095},domain246=source246Domain;
 assert.notDeepEqual(domain246,source245Domain);assert.equal(historical.split(JSON.stringify(domain246)).length,2);historical=historical.replace(JSON.stringify(domain246),JSON.stringify(source245Domain));
 const source246Comment='// Source246 re-pins domain.ts after review: new→picking also admits an order charged to B2B trade credit\n// (tradeCreditReleasedInTx, one read of b2b254_trade_charges), like cash on delivery; no stock write or gate bypass.\n';
 assert.equal(historical.split(source246Comment).length,2);historical=historical.replace(source246Comment,'');
 // Source245 re-pinned domain.ts (createOrder reads the tenant default link validity) and added its comment, which goes
 // first; domain.ts returns to its Source238 pin.
 const source238Domain={path:'server/domain.ts',sha256:'678de217e3cdd4d083c3def2d5fead107e26f89252eeb16fd9ce60f50c655859',bytes:47754},domain245=source245Domain;
 assert.notDeepEqual(domain245,source238Domain);assert.equal(historical.split(JSON.stringify(domain245)).length,2);historical=historical.replace(JSON.stringify(domain245),JSON.stringify(source238Domain));
 const source245Comment='// Source245 re-pins domain.ts after review: createOrder reads the tenant default link validity\n// (portal253_link_policies, read only) and adds portal_expires_at to the one orders INSERT; no stock write or gate bypass.\n';
 assert.equal(historical.split(source245Comment).length,2);historical=historical.replace(source245Comment,'');
 // Source244 re-pinned db.ts (already reversed to208 above) and developer-api.ts (with the pre236 pins below) and
 // added its comment, which goes first.
 const source244Comment='// Source244 re-pins db.ts and developer-api.ts after review: MIG-2 migrate() only reads migration_checksums after the\n// ledger check and records missing rows before COMMIT; three AUTO-07 public operations; no stock write or gate bypass.\n';
 assert.equal(historical.split(source244Comment).length,2);historical=historical.replace(source244Comment,'');
 // Source273 (prepared) re-pinned warehouse-wz-issuer.ts (a 57014 of the skip schedules one background refresh) and
 // added its comment, which goes first; warehouse-wz-issuer.ts returns to its Source239 pin.
 const issuer239={path:'server/warehouse-wz-issuer.ts',sha256:'26e08844399c9b1e92d3fb4b58f95657155cfe648faae840231b0403f8583c95',bytes:9950},issuer273=roster.find(r=>r.path==='server/warehouse-wz-issuer.ts');
 assert.notDeepEqual(issuer273,issuer239);assert.equal(historical.split(JSON.stringify(issuer273)).length,2);historical=historical.replace(JSON.stringify(issuer273),JSON.stringify(issuer239));
 const source273Comment='// Source273 (prepared) re-pins warehouse-wz-issuer.ts after review: a 57014 of wz_issuer239_prepare_skip schedules one\n// background wz_issuer273_refresh() (own owner transaction, same verdict) and is rethrown; no stock write or gate bypass.\n';
 assert.equal(historical.split(source273Comment).length,2);historical=historical.replace(source273Comment,'');
 // Source239 re-pinned warehouse-wz-issuer.ts (wz_issuer239_prepare_skip before the sealed prepare) and added its
 // comment; it returns to its literal pin first.
 const source238Issuer={path:'server/warehouse-wz-issuer.ts',sha256:'7a921146adea559e750e10b2eb8e32958ae5e6093f0dabad1c7235a5538dbcd9',bytes:9590};
 assert.notDeepEqual(issuer239,source238Issuer);assert.equal(historical.split(JSON.stringify(issuer239)).length,2);historical=historical.replace(JSON.stringify(issuer239),JSON.stringify(source238Issuer));
 const source239Comment='// Source239 re-pins warehouse-wz-issuer.ts after review: prepare first asks the owner-only read-only\n// wz_issuer239_prepare_skip and returns null only where the sealed prepare would; no stock write or gate bypass.\n';
 assert.equal(historical.split(source239Comment).length,2);historical=historical.replace(source239Comment,'');
 // Source238 re-pinned domain.ts (audit() delegates to insertAuditEvent) and added its comment; it returns to
 // its Source236 pin first, then with the other thirteen to its pre236 pin.
 const source236Domain={path:'server/domain.ts',sha256:'5cde3923fc96767f406ca42ecc8852d3344da32a06c570ab0bd4772688f6dc98',bytes:47766},domain238=source238Domain;
 assert.notDeepEqual(domain238,source236Domain);assert.equal(historical.split(JSON.stringify(domain238)).length,2);historical=historical.replace(JSON.stringify(domain238),JSON.stringify(source236Domain));
 const source238Comment='// Source238 re-pins domain.ts after review: audit() only delegates its one audit_events insert to\n// insertAuditEvent (plus the audit238 key row); no stock write, stock-writer call or gate bypass.\n';
 assert.equal(historical.split(source238Comment).length,2);historical=historical.replace(source238Comment,'');
 for(const before of pre236Pins){const after=before.path==='server/domain.ts'?source236Domain:before.path==='server/b2b-network.ts'?source236Network:source236Of250.find(r=>r.path===before.path)??roster.find(r=>r.path===before.path);assert(after);assert.notDeepEqual(after,before);assert.equal(historical.split(JSON.stringify(after)).length,2);historical=historical.replace(JSON.stringify(after),JSON.stringify(before));}
 const source236Comment='// Source236 re-pins14 drifted sources after review: deleted-product225 refusals, reason223\n// readouts, read/append tx, MIG-3/6/7 migrator and API scopes add no stock write or gate bypass.\n';
 assert.equal(historical.split(source236Comment).length,2);historical=historical.replace(source236Comment,'');
 // 69ba8fd re-pinned returns.ts38350→39085 for the a251dfe receipt wrapper and added its comment.
 const a251dfePin={path:'server/returns.ts',sha256:'0f32350c256f88cf88e1d7f3cf5d5b2a4d75e86d19741d4121f1473d8cdbef0a',bytes:39085};
 assert.equal(historical.split(JSON.stringify(a251dfePin)).length,2);historical=historical.replace(JSON.stringify(a251dfePin),JSON.stringify({path:'server/returns.ts',sha256:'cce7b2cb21659c1637a44f5394f28cb74aadd9fed1a00ecabd2acad8ed42c7a0',bytes:38350}));
 const a251dfeComment='// a251dfe return receipt identity adds a readout wrapper only; the exact inverse\n// is checked in coverage tests. Stock transaction gates and Native roster stay literal.\n';
 assert.equal(historical.split(a251dfeComment).length,2);historical=historical.replace(a251dfeComment,'');
 const currentComment='// tail206→207; reviewed split hooks148d5c5/3db244a extend both transaction paths.\n// Source209 adds only the next migration entry. Five3db244a presence getters are\n// pinned after exact removal reproduces their old sources; other36 and all3 Native pins stay literal.\n';
 assert.equal(historical.split(currentComment).length,2);historical=historical.replace(currentComment,'// tail206→207; the other41 current sources and all3 native pins remain literal.\n');
 assert.equal(hash(historical),'eba15ee0a8b5766ba7f6e054dc4d8759186f6cfa137bbe199246bd4b7f8edcd2');
 for(const pin of native)assert.equal(hash(await read(pin.path.replace(/^resources\//,''))),pin.sha256);
});
test('old188 business/structure and206/207 sources remain exactly their reviewed bytes',async()=>{
 for(const [file,expected]of Object.entries({'server/188_local_consumer_credit.sql':'cfa89fad3148555c0d91c5293d5e4727ab80d589681724196b70eb8a798cfbc6','server/188_consumer_credit_structure.sql':'a1ab15d6196fe01f4a156a3f0f97d4080811dafe816e3b20ddd0c483ef7527db','server/206_return_credit_destinations_history.sql':'1c79cbeaff631408370dd9908e73fb092d8e5ca4bf86a874e91072e9f0388bd4','server/207_consumer_return_credit.sql':'8abe73aec97e294860f918c7285c016444fce15322bf03148926f41041076172'}))assert.equal(hash(await read(file)),expected,file);
});
