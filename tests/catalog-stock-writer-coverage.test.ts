/** No app factory, SQL, startup constructor, capability minting or provider calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {assertStockWriterManifestCoverage,claimStockWriterActivation,stockWriterInstallationGate} from '../server/catalog-stock-writer-coverage';
const root=new URL('../',import.meta.url);
const source=await readFile(new URL('server/catalog-stock-writer-coverage.ts',root),'utf8');
const roster=(name:string):{path:string;sha256:string;bytes:number}[]=>JSON.parse(source.match(new RegExp('const '+name+':readonly Entry\\[\\]=(\\[.*?\\]);'))![1]);
const sourceRoster=roster('SOURCE_ROSTER'),nativeRoster=roster('NATIVE_ROSTER');
const pin=async(path:string)=>{const bytes=await readFile(new URL(path.replace(/^resources\//,''),root));return{path,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length};};
const actual={emitted_sources:await Promise.all(sourceRoster.map(e=>pin(e.path))),files:await Promise.all(nativeRoster.map(e=>pin(e.path)))};
const rejects=(value:unknown,label:string)=>assert.throws(()=>assertStockWriterManifestCoverage(value),e=>e instanceof assert.AssertionError&&e.message.includes(label));
// Source248 re-pinned catalog-stock-control-transaction.ts and financial-return-completion.ts: each full guard call inside a
// transaction asks guard_verdict(). Reversing those edits reproduces the pre-248 (reviewed246) bytes exactly (used by later reversals too).
const source248Edits:Record<string,readonly (readonly [string,string])[]>={"server/catalog-stock-control-transaction.ts":[["ledger,\n    to_regprocedure('public.guard_verdict(text)') verdict`)).rows[0];","ledger`)).rows[0];"],["  // 248: inside a transaction the same verdict, reused while the cold-approved schema and the guard's basis are\n  // unchanged; the Pool (startup, outside any transaction) keeps the full guard.\n  const guard=p.verdict&&'release' in c?\"SELECT public.guard_verdict('catalog_stock_control_guards') ok\":'SELECT public.catalog_stock_control_guards() ok';\n  return p.ledger&&(await c.query(guard)).rows[0].ok?'available':'unavailable';","  return p.ledger&&(await c.query('SELECT public.catalog_stock_control_guards() ok')).rows[0].ok?'available':'unavailable';"]],"server/financial-return-completion.ts":[[" artifacts,to_regprocedure('public.guard_verdict(text)') verdict\")).rows[0];"," artifacts\")).rows[0];"],[" // 248: the same verdict, reused while the cold-approved schema and the guard's basis are unchanged.\n ensure((await c.query(p.verdict?\"SELECT public.guard_verdict('financial_return_guards') ok\":'SELECT public.financial_return_guards() ok')).rows[0].ok===true"," ensure((await c.query('SELECT public.financial_return_guards() ok')).rows[0].ok===true"]]};
// Source264 re-pinned catalog-stock-control-transaction.ts: one block (264 note, snapshot probe, reuse wrapper) replaces
// the old exported header, which became availabilityByGuard(). Reversing it reproduces the Source248 bytes exactly.
const header264="/** Diagnostic only: unavailable must never be treated as absent by a writer. */\nexport async function catalogStockControlAvailabilityInTx(c:Pool|PoolClient):Promise<CatalogStockControlAvailability>{\n";
const reverse264=(path:string,text:string)=>{if(path!=='server/catalog-stock-control-transaction.ts')return text;
 const start='// 264: a READ ONLY REPEATABLE READ/SERIALIZABLE transaction',end='async function availabilityByGuard(c:Pool|PoolClient):Promise<CatalogStockControlAvailability>{\n';
 assert.equal(text.split(start).length,2,'one declared 264 block');assert.equal(text.split(end).length,2,'one declared 264 block end');
 const a=text.indexOf(start),b=text.indexOf(end)+end.length;assert(a<b);return text.slice(0,a)+header264+text.slice(b);};
// Source272 re-pinned financial-return-completion.ts: the ordinary receive asks the owner-only 272 front door when
// installed. Reversing those edits reproduces the Source248 (and pre-272) bytes exactly.
const source272Edits:Record<string,readonly (readonly [string,string])[]>={"server/financial-return-completion.ts":[[" // 272: the ordinary-receipt front door answers NULL only where the sealed capture would, and is the sealed capture otherwise.\n const saved=await owner(c,async()=>{const front=(await c.query(\"SELECT to_regprocedure('public.return_receipt272_financial_capture(uuid,uuid,text,uuid,jsonb)') IS NOT NULL f\")).rows[0].f===true;\n  return (await c.query(front?'SELECT public.return_receipt272_financial_capture($1,$2,$3,$4,$5::jsonb) frame':'SELECT public.financial_return_capture($1,$2,$3,$4,$5::jsonb) frame',[a.userId,a.apiKeyId??null,hash,source.return_id,JSON.stringify(source.request)])).rows[0].frame;});\n"," const saved=await owner(c,async()=>(await c.query('SELECT public.financial_return_capture($1,$2,$3,$4,$5::jsonb) frame',[a.userId,a.apiKeyId??null,hash,source.return_id,JSON.stringify(source.request)])).rows[0].frame);\n"]]};
const reverse272=(path:string,text:string)=>{for(const[from,to]of source272Edits[path]??[]){assert.equal(text.split(from).length,2,'one declared 272 edit');text=text.replace(from,()=>to);}return text;};
const reverse248=(path:string,text:string)=>{text=reverse264(path,reverse272(path,text));for(const[from,to]of source248Edits[path]??[]){assert.equal(text.split(from).length,2,'one declared 248 edit');text=text.replace(from,()=>to);}return text;};
test('reviewedMIG1 migrator and split-hook successors match all actual42 sources and3 literal native resources',()=>{
 assert.equal(sourceRoster.length,42);assert.equal(nativeRoster.length,3);
 assert.equal(assertStockWriterManifestCoverage(actual),undefined);
 assert.deepEqual(sourceRoster.find(e=>e.path==='server/db.ts'),{path:'server/db.ts',sha256:'01078f53f209e6e9314886e7735e6730af3dbcec3ac9849e4e8e5cac5d5bfb7c',bytes:49754});
 assert.deepEqual(sourceRoster.find(e=>e.path==='server/developer-api.ts'),{path:'server/developer-api.ts',sha256:'0ebcef75ff081a07bdf5b65ab4e888d26fcad3647ef549d71ce49d0b0664552d',bytes:234015});
 assert.deepEqual(sourceRoster.find(e=>e.path==='server/domain.ts'),{path:'server/domain.ts',sha256:'cff5ac7f6333e8ab47bd406abe05fc007e4cc4891d33434dd0e658a7a7126f2c',bytes:48283});

 assert.deepEqual(sourceRoster.find(e=>e.path==='server/warehouse-wz-issuer.ts'),{path:'server/warehouse-wz-issuer.ts',sha256:'a9d23da2b028d2a491536bc457f3adfc93d3edb81cb8619432f798a49eb9f2cd',bytes:10476});
});
// SourceDbLocks re-pinned db.ts: tenantTx checks the held session locks right before COMMIT (db-lock-holder.ts).
// Reversing those edits reproduces the SourceDbErrors bytes exactly, and that pin stays refused.
const EDITS_DBLOCK=[["import { assertDbLocksHeldInTx } from './db-lock-holder';\n",""],["    // Work under a session advisory lock (holdingDbLock) commits only while that lock is still held.\n    await assertDbLocksHeldInTx(c);\n",""]] as const;
const undoDbLocks=(text:string)=>{for(const[from,to]of EDITS_DBLOCK){assert.equal(text.split(from).length,2,'one declared db-locks edit');text=text.replace(from,()=>to);}return text;};
test('the db-locks db.ts re-pin reverses exactly to its SourceDbErrors pin, which remains refused',async()=>{
 const text=undoDbLocks(await readFile(new URL('server/db.ts',root),'utf8'));
 assert.equal(Buffer.byteLength(text),49558);assert.equal(createHash('sha256').update(text).digest('hex'),'5d485e5bbcc035a01d6daec023274d74d28727284ac53a93eaa3c4047b69bd86');
 const cut=structuredClone(actual);Object.assign(cut.emitted_sources.find(e=>e.path==='server/db.ts')!,{sha256:'5d485e5bbcc035a01d6daec023274d74d28727284ac53a93eaa3c4047b69bd86',bytes:49558});rejects(cut,'stock-writer-source-sha');
});
// SourceDbErrors re-pinned db.ts: the ordinary pool is built through watchDbPool (lost-connection listeners only).
// Reversing those edits reproduces the SourceMIG1 bytes exactly, and that pin stays refused.
const EDITS_DBERR=[["import { watchDbPool } from './db-connection-errors';\n",""],["// Idle clients (pool 'error') and checked-out clients (one listener per client: pg-pool drops its own on\n// checkout) log and count a lost connection instead of throwing it; later requests get a new connection\n// without retrying any transaction (db-connection-errors.ts, dry run -68).\nexport const pool = watchDbPool(new pg.Pool({","export const pool = new pg.Pool({"],["}), 'pool');\n","});\n// pg removes an idle client before emitting this event. A listener keeps a\n// PostgreSQL restart from becoming an uncaught EventEmitter error; later\n// requests can obtain a new connection without retrying any transaction.\npool.on('error', (error: Error & { code?: unknown }) => {\n  const safeCodes = [\n    '57P01', '57P02', '57P03', '08001', '08003', '08006',\n    'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT',\n  ];\n  const code = typeof error.code === 'string' && safeCodes.includes(error.code)\n    ? error.code\n    : 'UNCLASSIFIED';\n  // Never log the error, message, stack or client: they may contain credentials.\n  process.stderr.write(JSON.stringify({ event: 'DATABASE_POOL_IDLE_ERROR', code }) + '\\n');\n});\n"]] as const;
const undoDbErrors=(text:string)=>{for(const[from,to]of EDITS_DBERR){assert.equal(text.split(from).length,2,'one declared db-errors edit');text=text.replace(from,()=>to);}return text;};
test('the db-errors db.ts re-pin reverses exactly to its SourceMIG1 pin, which remains refused',async()=>{
 const text=undoDbErrors(undoDbLocks(await readFile(new URL('server/db.ts',root),'utf8')));
 assert.equal(Buffer.byteLength(text),49916);assert.equal(createHash('sha256').update(text).digest('hex'),'2ed6525ba4b254b5106408896244fcb95bf219e74b379a41d376304be5fdc6bd');
 const cut=structuredClone(actual);Object.assign(cut.emitted_sources.find(e=>e.path==='server/db.ts')!,{sha256:'2ed6525ba4b254b5106408896244fcb95bf219e74b379a41d376304be5fdc6bd',bytes:49916});rejects(cut,'stock-writer-source-sha');
});
// SourceMIG1 re-pinned db.ts: migrate() waits for its fence with its own budget (acquireMigrationLock) and names a
// failed migration (MigrationFailedError). Reversing those edits reproduces the Source244 bytes exactly, and that pin stays refused.
const EDITS_MIG1=[["import {ensureMigrationRegistry,assertLedgerKnownToRelease,assertMigrationChecksums,recordMigrationChecksums,migrationProgramFiles,acquireMigrationLock,MigrationFailedError,type MigrationProgramFile} from './migration-bootstrap';\n","import {ensureMigrationRegistry,assertLedgerKnownToRelease,assertMigrationChecksums,recordMigrationChecksums,migrationProgramFiles,type MigrationProgramFile} from './migration-bootstrap';\n"],["export async function migrate(options: { lockWaitMs?: number } = {}) {\n","export async function migrate() {\n"],["    // MIG-1: one transaction for the whole pending series under the 982376 fence; a second instance waits for it.\n    await c.query('BEGIN');\n    await acquireMigrationLock(c, options.lockWaitMs);\n","    await c.query('BEGIN');\n    await c.query('SELECT pg_advisory_xact_lock(982376)');\n"],["      if (!done.rowCount) try {\n","      if (!done.rowCount) {\n"],["      } catch (e) {\n        // MIG-1: the series is one transaction, so a failure of any migration rolls all of them back (catch below).\n        throw new MigrationFailedError(name, file.slice(2), program.map(([n]) => n).filter((n) => !applied.has(n)), e);\n      }\n","      }\n"]]as const;
const undoMig1=(text:string)=>{for(const[from,to]of EDITS_MIG1){assert.equal(text.split(from).length,2,'one declared MIG-1 edit');text=text.replace(from,()=>to);}return text;};
test('the MIG-1 db.ts re-pin reverses exactly to its Source244 pin, which remains refused',async()=>{
 const text=undoMig1(undoDbErrors(undoDbLocks(await readFile(new URL('server/db.ts',root),'utf8'))));
 assert.equal(Buffer.byteLength(text),49465);assert.equal(createHash('sha256').update(text).digest('hex'),'4a318ef60780988f4c974eb0ccab0a47469e48e741db4514f2b264fd5cd042a6');
 const cut=structuredClone(actual);Object.assign(cut.emitted_sources.find(e=>e.path==='server/db.ts')!,{sha256:'4a318ef60780988f4c974eb0ccab0a47469e48e741db4514f2b264fd5cd042a6',bytes:49465});rejects(cut,'stock-writer-source-sha');
});
// Source244 re-pinned db.ts (MIG-2: migrate() reads migration_checksums after the ledger check and records missing
// rows before COMMIT) and developer-api.ts (three AUTO-07 public operations). Reversing those edits reproduces the
// Source243 bytes exactly, and those pins stay refused.
test('the 244 db.ts and developer-api.ts re-pins reverse exactly to their Source243 pins, which remain refused',async()=>{
 for(const[path,edits,sha256,bytes]of[
  ['server/db.ts',[
   ["import {ensureMigrationRegistry,assertLedgerKnownToRelease,assertMigrationChecksums,recordMigrationChecksums,migrationProgramFiles,type MigrationProgramFile} from './migration-bootstrap';\n",
    "import {ensureMigrationRegistry,assertLedgerKnownToRelease} from './migration-bootstrap';\n"],
   ["  // MIG-2: the program's executed files, read at most once and only when the checksum register exists.\n  let programFiles: Promise<MigrationProgramFile[]> | undefined;\n  const checksumFiles = () => (programFiles ??= migrationProgramFiles(program, (file) => readRuntimeResource('sql:server/' + file, import.meta.url)));\n",
    ""],
   ["    // MIG-2: an applied migration whose file changed since it was recorded is refused the same way (migration 244).\n    await assertMigrationChecksums(c, checksumFiles);\n",
    ""],
   ["    // MIG-2: every executed file without a record gets one before the series commits.\n    await recordMigrationChecksums(c, checksumFiles, applied);\n",
    ""],
  ]as const,'430fb682686ea9632225d2aa42bd1349c877dca124c7cb2cd83242454aa10384',48726],
  ['server/developer-api.ts',[
   ["import { customEventRaiseInput } from './custom-events';\n",
    ""],
   ["  // AUTO-07: own events (migration 244). Raising needs the caller's client_key; the same key = the same call.\n  op('GET', '/custom-events', 'orders:read'),\n  op('POST', '/custom-events/:key/raise', 'orders:write', customEventRaiseInput),\n  op('GET', '/custom-events/:id/calls', 'orders:read'),\n",
    ""],
  ]as const,'395afaf62451fd82a909a4a711790ca9ae491b1faf59fb83b553141a6d377292',233663],
 ]as const){
  let text=await readFile(new URL(path,root),'utf8');
  if(path==='server/db.ts')text=undoMig1(undoDbErrors(undoDbLocks(text)));
  for(const[from,to]of edits){assert.equal(text.split(from).length,2,'one declared 244 edit');text=text.replace(from,()=>to);}
  assert.equal(Buffer.byteLength(text),bytes);assert.equal(createHash('sha256').update(text).digest('hex'),sha256);
  const cut=structuredClone(actual);Object.assign(cut.emitted_sources.find(e=>e.path===path)!,{sha256,bytes});rejects(cut,'stock-writer-source-sha');
 }
});
// Source251 re-pinned b2b-network.ts: the invitation, acceptance and settings routes ask the 251 link state.
// Reversing those four edits reproduces the Source236 bytes exactly, and that pin stays refused.
test('the 251 b2b-network.ts re-pin reverses exactly to its Source236 pin, which remains refused',async()=>{
 assert.deepEqual(sourceRoster.find(e=>e.path==='server/b2b-network.ts'),{path:'server/b2b-network.ts',sha256:'95d71c5f7f823ea2b984b73a94e405de64902499048ac19e244e30444144587d',bytes:47640});
 let text=await readFile(new URL('server/b2b-network.ts',root),'utf8');
 for(const[from,to]of[
  ["import { networkLinkDisconnectedInTx, reconnectNetworkLinkInTx, assertNetworkLinkConnectedInTx } from './b2b-network-link-state';\n",''],
  ["        ).rowCount ||\n          // 251 (B2B-002): a disconnected link is reconnected by a new invitation to the same company.\n          (await networkLinkDisconnectedInTx(c, a.id)),\n",
   "        ).rowCount,\n"],
  ["      // 251 (B2B-002): a disconnected link of this account reconnects in place, for the same buyer company only.\n      const reconnected = await reconnectNetworkLinkInTx(c, r.actor, { supplierTenantId: ref.tenant_id, accountId: a.id, invitationId: i.id, supplierName });\n      if (reconnected) return reconnected;\n",''],
  ["      // 251 (B2B-002): a disconnected link stays paused until the supplier's new invitation reconnects it.\n      await assertNetworkLinkConnectedInTx(c, l);\n",''],
 ]as const){assert.equal(text.split(from).length,2,'one declared 251 edit');text=text.replace(from,()=>to);}
 assert.equal(Buffer.byteLength(text),46875);assert.equal(createHash('sha256').update(text).digest('hex'),'aaa4d590ea5f571c1f7480314b7d0ae28efdd8af0362467a9b4a059df11e5b64');
 const cut=structuredClone(actual);Object.assign(cut.emitted_sources.find(e=>e.path==='server/b2b-network.ts')!,{sha256:'aaa4d590ea5f571c1f7480314b7d0ae28efdd8af0362467a9b4a059df11e5b64',bytes:46875});rejects(cut,'stock-writer-source-sha');
});
// Source273 (prepared) re-pinned warehouse-wz-issuer.ts: a 57014 of wz_issuer239_prepare_skip schedules one background
// wz_issuer273_refresh() and is rethrown. Reversing those edits reproduces the Source239 bytes exactly (used by the 239
// reversal below), and that pin stays refused.
const EDITS_273=[
 ["import { pool } from './db';\nimport { scheduleWzIssuerRefresh } from './wz-issuer273-refresh';\n// 273: a verdict miss cut by the request statement budget (57014) records nothing, so every later request would miss as\n// well; one background refresh per process, with the cold budget, records the full guard's true for the next request.\nconst refreshAfterTimeout=(e:unknown):never=>{if(typeof e==='object'&&e!==null&&(e as {code?:unknown}).code==='57014')void scheduleWzIssuerRefresh(pool);throw e;};\n",''],
 ["args).catch(refreshAfterTimeout)).rows[0].skip===true)return null;\n","args)).rows[0].skip===true)return null;\n"],
]as const;
const undo273=(text:string)=>{for(const[from,to]of EDITS_273){assert.equal(text.split(from).length,2,'one declared 273 edit');text=text.replace(from,()=>to);}return text;};
test('the 273 warehouse-wz-issuer.ts re-pin reverses exactly to its Source239 pin, which remains refused',async()=>{
 const text=undo273(await readFile(new URL('server/warehouse-wz-issuer.ts',root),'utf8'));
 assert.equal(Buffer.byteLength(text),9950);assert.equal(createHash('sha256').update(text).digest('hex'),'26e08844399c9b1e92d3fb4b58f95657155cfe648faae840231b0403f8583c95');
 const cut=structuredClone(actual);Object.assign(cut.emitted_sources.find(e=>e.path==='server/warehouse-wz-issuer.ts')!,{sha256:'26e08844399c9b1e92d3fb4b58f95657155cfe648faae840231b0403f8583c95',bytes:9950});rejects(cut,'stock-writer-source-sha');
});
// Source239 re-pinned warehouse-wz-issuer.ts: prepareAutomaticWzInTx asks wz_issuer239_prepare_skip before the
// sealed prepare. Reversing those edits reproduces the Source238 bytes exactly, and that pin stays refused.
test('the 239 warehouse-wz-issuer.ts re-pin reverses exactly to its Source238 pin, which remains refused',async()=>{
 let text=undo273(await readFile(new URL('server/warehouse-wz-issuer.ts',root),'utf8'));
 for(const[from,to]of[
  [`    const {present,skip}=(await c.query("SELECT to_regprocedure('public.warehouse_wz_issuer_prepare(uuid,uuid,jsonb)') present,to_regprocedure('public.wz_issuer239_prepare_skip(uuid,uuid,jsonb)') skip")).rows[0];\n`,
   `    const present=(await c.query("SELECT to_regprocedure('public.warehouse_wz_issuer_prepare(uuid,uuid,jsonb)') present")).rows[0].present;\n`],
  ["    const args=[a.userId,a.apiKeyId??null,JSON.stringify(source)];\n    // 239: the sealed prepare would return NULL (dispatched, or no enabled configuration) after the same, reused, integrity verdict.\n    if(skip&&(await c.query('SELECT public.wz_issuer239_prepare_skip($1,$2,$3::jsonb) skip',args)).rows[0].skip===true)return null;\n    return (await c.query('SELECT public.warehouse_wz_issuer_prepare($1,$2,$3::jsonb) id',args)).rows[0].id as string|null;\n",
   "    return (await c.query('SELECT public.warehouse_wz_issuer_prepare($1,$2,$3::jsonb) id',[a.userId,a.apiKeyId??null,JSON.stringify(source)])).rows[0].id as string|null;\n"],
 ]as const){assert.equal(text.split(from).length,2,'one declared 239 edit');text=text.replace(from,()=>to);}
 assert.equal(Buffer.byteLength(text),9590);assert.equal(createHash('sha256').update(text).digest('hex'),'7a921146adea559e750e10b2eb8e32958ae5e6093f0dabad1c7235a5538dbcd9');
 const cut=structuredClone(actual);Object.assign(cut.emitted_sources.find(e=>e.path==='server/warehouse-wz-issuer.ts')!,{sha256:'7a921146adea559e750e10b2eb8e32958ae5e6093f0dabad1c7235a5538dbcd9',bytes:9590});rejects(cut,'stock-writer-source-sha');
});
// SourceOpening re-pinned wms-lots.ts: the opening row cap comes from the plan (wmsLotOpeningRowsInTx), rows without stock
// are locked and digested in SQL (count + sha256) instead of loaded, metadata reports opening_rows. Reversing those four
// edits reproduces the Source250 bytes (a74cc7d6..., 95 861 B) exactly, and that pin stays refused.
const EDITS_OPENING=[
 ["import { wmsLotLimitsInTx, wmsLotOpeningRowsInTx, wmsLotsEvidenceBudgetInTx, wmsLotsQuotaInTx } from './wms-lots-limits';\n",
  "import { wmsLotLimitsInTx, wmsLotsEvidenceBudgetInTx, wmsLotsQuotaInTx } from './wms-lots-limits';\n"],
 ["/** Rows without stock (stock on_hand=0 and reserved=0, bin quantity=0) create no layer and raise no\n * blocker. They are still locked (one ordered statement per table, as before) and bound into the scope\n * hash, but as a count and a SQL digest instead of rows, so a 100 000 SKU catalogue keeps the snapshot,\n * the stored preview and its detail small. The digest covers every column the rows had, so any change\n * that invalidated the opening before (version, SKU, name, kind) still does. */\nconst zeroStock = 's.on_hand=0 AND s.reserved=0';\nfunction splitZero(rows: Row[]) {\n  const { total, zero, digest } = rows[0];\n  return {\n    total: Number(total),\n    zero: { rows: Number(zero), digest },\n    rows: rows\n      .filter((r) => r.warehouse_id !== null)\n      .map(({ total: _total, zero: _zero, digest: _digest, ...r }) => r),\n  };\n}\nasync function openingSnapshot(c: PoolClient, lock = false) {\n  const limit = await wmsLotOpeningRowsInTx(c);\n  const stock = splitZero(\n    (\n      await c.query(`WITH s AS MATERIALIZED (SELECT s.warehouse_id,s.product_id,s.on_hand,s.reserved,s.version,\n    p.sku,p.name,p.kind,p.version product_version FROM stock s JOIN products p\n    ON (p.tenant_id,p.id)=(s.tenant_id,s.product_id) ORDER BY s.warehouse_id,s.product_id\n    ${lock ? 'FOR UPDATE OF s' : ''}),\n    z AS (SELECT count(*)::text total,(count(*) FILTER (WHERE ${zeroStock}))::text zero,\n    encode(sha256(convert_to(coalesce(string_agg(json_build_array(s.warehouse_id,s.product_id,s.version,s.sku,s.name,s.kind,s.product_version)::text,\n    E'\\\\n' ORDER BY s.warehouse_id,s.product_id) FILTER (WHERE ${zeroStock}),''),'UTF8')),'hex') digest FROM s)\n    SELECT z.total,z.zero,z.digest,s.* FROM z LEFT JOIN s ON NOT (${zeroStock}) ORDER BY s.warehouse_id,s.product_id`)\n    ).rows,\n  );\n  ensure(stock.total <= limit, 413, 'Otwarcie obejmuje za dużo stanów');\n  const bins = splitZero(\n    (\n      await c.query(`WITH b AS MATERIALIZED (SELECT b.warehouse_id,b.product_id,b.location,b.quantity,\n    s.version stock_version,p.sku,p.name FROM stock_locations b JOIN stock s\n    USING(tenant_id,warehouse_id,product_id) JOIN products p ON (p.tenant_id,p.id)=(b.tenant_id,b.product_id)\n    ORDER BY b.warehouse_id,b.product_id,b.location COLLATE \"C\" ${lock ? 'FOR UPDATE OF b' : ''}),\n    z AS (SELECT count(*)::text total,(count(*) FILTER (WHERE b.quantity=0))::text zero,\n    encode(sha256(convert_to(coalesce(string_agg(json_build_array(b.warehouse_id,b.product_id,b.location,b.stock_version,b.sku,b.name)::text,\n    E'\\\\n' ORDER BY b.warehouse_id,b.product_id,b.location COLLATE \"C\") FILTER (WHERE b.quantity=0),''),'UTF8')),'hex') digest FROM b)\n    SELECT z.total,z.zero,z.digest,b.* FROM z LEFT JOIN b ON b.quantity<>0\n    ORDER BY b.warehouse_id,b.product_id,b.location COLLATE \"C\"`)\n    ).rows,\n  );\n  ensure(bins.total <= limit, 413, 'Otwarcie obejmuje za dużo lokalizacji');\n  const stocks = stock.rows;\n",
  "async function openingSnapshot(c: PoolClient, lock = false) {\n  const stocks = (\n    await c.query(`SELECT s.warehouse_id,s.product_id,s.on_hand,s.reserved,s.version,\n    p.sku,p.name,p.kind,p.version product_version FROM stock s JOIN products p\n    ON (p.tenant_id,p.id)=(s.tenant_id,s.product_id) ORDER BY s.warehouse_id,s.product_id\n    ${lock ? 'FOR UPDATE OF s' : ''}`)\n  ).rows;\n  ensure(stocks.length <= S.WMS_LOT_LIMITS.physical_rows, 413, 'Otwarcie obejmuje za dużo stanów');\n  const bins = (\n    await c.query(`SELECT b.warehouse_id,b.product_id,b.location,b.quantity,\n    s.version stock_version,p.sku,p.name FROM stock_locations b JOIN stock s\n    USING(tenant_id,warehouse_id,product_id) JOIN products p ON (p.tenant_id,p.id)=(b.tenant_id,b.product_id)\n    ORDER BY b.warehouse_id,b.product_id,b.location COLLATE \"C\" ${lock ? 'FOR UPDATE OF b' : ''}`)\n  ).rows;\n  ensure(\n    bins.length <= S.WMS_LOT_LIMITS.physical_rows,\n    413,\n    'Otwarcie obejmuje za dużo lokalizacji',\n  );\n"],
 ["  const snapshot = {\n    policy: await wmsLotsPolicyInTx(c),\n    stocks,\n    bins: bins.rows,\n    zero_stock: { stocks: stock.zero, bins: bins.zero },\n    active,\n    blockers,\n  };\n",
  "  const snapshot = { policy: await wmsLotsPolicyInTx(c), stocks, bins, active, blockers };\n"],
 ["        limits: {\n          ...S.WMS_LOT_LIMITS,\n          ...(await wmsLotLimitsInTx(c)),\n          opening_rows: await wmsLotOpeningRowsInTx(c),\n        },\n",
  "        limits: { ...S.WMS_LOT_LIMITS, ...(await wmsLotLimitsInTx(c)) },\n"],
]as const;
const reverseOpening=(path:string,text:string)=>{if(path!=='server/wms-lots.ts')return text;
 for(const[from,to]of EDITS_OPENING){assert.equal(text.split(from).length,2,'one declared opening edit');text=text.replace(from,()=>to);}return text;};
test('the opening wms-lots.ts re-pin reverses exactly to the Source250 bytes and that pin stays refused',async()=>{
 const text=reverseOpening('server/wms-lots.ts',await readFile(new URL('server/wms-lots.ts',root),'utf8'));
 assert.equal(Buffer.byteLength(text),95861);assert.equal(createHash('sha256').update(text).digest('hex'),'a74cc7d661bf552cb9cf08da2ce1ca66daad62b20ef3ca4b97aff2f11981ba5c');
 assert.deepEqual(sourceRoster.find(e=>e.path==='server/wms-lots.ts'),{path:'server/wms-lots.ts',sha256:'dc86556aec0b6e73e7452e03ec4168344b197781c7c098a7912b92862ef84116',bytes:97981});
 const cut=structuredClone(actual);Object.assign(cut.emitted_sources.find(e=>e.path==='server/wms-lots.ts')!,{sha256:'a74cc7d661bf552cb9cf08da2ce1ca66daad62b20ef3ca4b97aff2f11981ba5c',bytes:95861});rejects(cut,'stock-writer-source-sha');
});
// Source250 re-pinned wms-lots.ts (shared operations fence for receipts/movements, serial opening preview, client-key
// lock before priorOperation/priorPreview, scan pins its stock row FOR SHARE), stock-file-import.ts and
// stocktake-adjustments.ts (stocktake writes admit 'serial'). Reversing those edits reproduces the pre-250 (Source236) bytes
// exactly, and those pins stay refused.
test('the 250 wms-lots.ts, stock-file-import.ts and stocktake-adjustments.ts re-pins reverse exactly and the old pins stay refused',async()=>{
 for(const[path,edits,sha256,bytes]of[
  ['server/wms-lots.ts',[
   ["/** Writers share the tenant operations fence, so the same key sent twice at once waits here for the\n * first transaction and then replays its committed result instead of failing on UNIQUE(client_key). */\nasync function lockClientKey(c: PoolClient, a: WmsActor, kind: 'operation' | 'preview', key: string) {\n  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [\n    'wms.' + kind + '-key:' + a.tenantId + ':' + key,\n  ]);\n}\n",''],
   ["  await lockClientKey(c, a, 'operation', context.client_key);\n",''],
   ["  // A scan changes no stock row, so it pins it shared: no writer can commit a stock change while\n  // this transaction's deferred wms_consistency check compares the stock row with its positions.\n  await c.query('SELECT 1 FROM stock WHERE warehouse_id=$1 AND product_id=$2 FOR SHARE', [\n    r.warehouse_id,\n    b.product_id,\n  ]);\n",''],
   ["/** shared for receipts and movements (row locks decide); serial/activation for the whole-tenant\n * opening, chosen at the tenantTx admission (a later upgrade is refused with 409). */\nasync function admit(c: PoolClient, a: WmsActor, mode: 'shared' | 'serial' | 'activation' = 'shared') {","async function admit(c: PoolClient, a: WmsActor, activation = false) {"],
   ["  await wmsLotsAdmissionInTx(c, a, mode);\n","  await wmsLotsAdmissionInTx(c, a, activation ? 'activation' : 'shared');\n"],
   ["  await c.query(\n    `SELECT pg_advisory_xact_lock${mode === 'shared' ? '_shared' : ''}(hashtextextended($1,0))`,\n    ['wms.operations:' + a.tenantId],\n  );\n","  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [\n    'wms.operations:' + a.tenantId,\n  ]);\n"],
   ["  await lockClientKey(c, a, 'preview', body.client_key);\n",''],
   ["    await admit(c, a, 'serial');\n","    await admit(c, a);\n"],
   ["  }, { wmsAdmission: 'serial' });\n}\nexport async function activateWmsOpening","  });\n}\nexport async function activateWmsOpening"],
   ["      await admit(c, a, 'activation');\n","      await admit(c, a, true);\n"],
  ],'1bd47b5a2d41eddd98577bf0e775b0760622bae04e49d040bbe6f2cfa78743bf',94695],
  ['server/stock-file-import.ts',[["wmsAdmission: writing ? 'serial' : 'read'","wmsAdmission: writing ? 'shared' : 'read'"]],'735fceaaa72ed439471b328398c5d0152146993a8b0a637474bcbab01e45b4b1',47075],
  ['server/stocktake-adjustments.ts',[["{wmsAdmission:access.writing?'serial':'read'}","{wmsAdmission:access.writing?'shared':'read'}"]],'c6fd2ac6c9de981733d590f5e61f1608d8f854ed9ba4bc202bdeac58c3e4f60a',30953],
 ]as const){
  let text=reverseOpening(path,await readFile(new URL(path,root),'utf8'));
  for(const[from,to]of edits){assert.equal(text.split(from).length,2,'one declared 250 edit in '+path);text=text.replace(from,()=>to);}
  assert.equal(Buffer.byteLength(text),bytes,path);assert.equal(createHash('sha256').update(text).digest('hex'),sha256,path);
  const cut=structuredClone(actual);Object.assign(cut.emitted_sources.find(e=>e.path===path)!,{sha256,bytes});rejects(cut,'stock-writer-source-sha');
 }
});
// Source245 re-pinned domain.ts: createOrder reads the tenant default link validity (portal253_link_policies) and adds
// portal_expires_at to the one orders INSERT. Reversing those edits reproduces the Source238 bytes exactly.
const EDITS245=[
 ["import { portalDefaultDaysInTx } from './portal-link-default253';\n",''],
 ["  // 245 (COM-PORTAL-4): the tenant's default link validity; null = no end date, as before 245.\n  const portalDays = await portalDefaultDaysInTx(c);\n",''],
 ["fulfillment_kind,replacement_return_id,portal_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'replacement',$15,now()+make_interval(days=>$16::int))","fulfillment_kind,replacement_return_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'replacement',$15)"],
 ["portal_token,payment_mode,portal_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now()+make_interval(days=>$15::int))'","portal_token,payment_mode) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)'"],
 ["      ...(replacement ? [replacement.return_id] : []),\n      portalDays,\n","      ...(replacement ? [replacement.return_id] : []),\n"],
]as const;
const undo245=(text:string)=>{for(const[from,to]of EDITS245){assert.equal(text.split(from).length,2,'one declared 245 edit');text=text.replace(from,()=>to);}return text;};
// Source246 re-pinned domain.ts: new→picking also admits an order on B2B trade credit (tradeCreditReleasedInTx).
// Reversing those two edits reproduces the Source245 bytes exactly, and the Source245 pin stays refused.
const EDITS246=[
 ["import { tradeCreditReleasedInTx } from './b2b-trade-credit-release';\n",''],
 ["(o.payment_mode === 'cod' || (await tradeCreditReleasedInTx(c, id)))","o.payment_mode === 'cod'"],
]as const;
const undo246=(text:string)=>{for(const[from,to]of EDITS246){assert.equal(text.split(from).length,2,'one declared 246 edit');text=text.replace(from,()=>to);}return text;};
// SourceOrderNumber re-pinned domain.ts: createOrder runs its one orders INSERT through insertOrderWithNumberInTx
// (a taken number is redrawn under a savepoint). Reversing those edits reproduces the Source246 bytes exactly.
const EDITS_ORDER_NUMBER=[
 ["import { insertOrderWithNumberInTx } from './order-number';\n",''],
 ['  const id = replacement?.replacement_order_id ?? randomUUID();\n','  const id = replacement?.replacement_order_id ?? randomUUID(),\n    number = `DE-${new Date().toISOString().slice(0, 10).replaceAll(\'-\', \'\')}-${randomBytes(4).toString(\'hex\').toUpperCase()}`;\n'],
 ['  // A taken DE-<date>-<hex> number is redrawn under a savepoint, never surfaced (order-number.ts).\n  await insertOrderWithNumberInTx(c, (number) => c.query(\n','  await c.query(\n'],
 ['      portalDays,\n    ],\n  ));\n','      portalDays,\n    ],\n  );\n'],
]as const;
const undoOrderNumber=(text:string)=>{for(const[from,to]of EDITS_ORDER_NUMBER){assert.equal(text.split(from).length,2,'one declared order-number edit');text=text.replace(from,()=>to);}return text;};
test('the order-number domain.ts re-pin reverses exactly to its Source246 pin, which remains refused',async()=>{
 const text=undoOrderNumber(await readFile(new URL('server/domain.ts',root),'utf8'));
 assert.equal(Buffer.byteLength(text),48209);assert.equal(createHash('sha256').update(text).digest('hex'),'4c81ee257911e5abfb3c56599a8519bd48180110957db24d603401d188b3e800');
 const cut=structuredClone(actual);Object.assign(cut.emitted_sources.find(e=>e.path==='server/domain.ts')!,{sha256:'4c81ee257911e5abfb3c56599a8519bd48180110957db24d603401d188b3e800',bytes:48209});rejects(cut,'stock-writer-source-sha');
});
test('the 246 domain.ts re-pin reverses exactly to its Source245 pin, which remains refused',async()=>{
 const text=undo246(undoOrderNumber(await readFile(new URL('server/domain.ts',root),'utf8')));
 assert.equal(Buffer.byteLength(text),48095);assert.equal(createHash('sha256').update(text).digest('hex'),'88346c0e8f7448fd7bb5bb2b63786e26990dc8d9090a3b3d1866f226ae55ffc8');
 const cut=structuredClone(actual);Object.assign(cut.emitted_sources.find(e=>e.path==='server/domain.ts')!,{sha256:'88346c0e8f7448fd7bb5bb2b63786e26990dc8d9090a3b3d1866f226ae55ffc8',bytes:48095});rejects(cut,'stock-writer-source-sha');
});
test('the 245 domain.ts re-pin reverses exactly to its Source238 pin, which remains refused',async()=>{
 const text=undo245(undo246(undoOrderNumber(await readFile(new URL('server/domain.ts',root),'utf8'))));
 assert.equal(Buffer.byteLength(text),47754);assert.equal(createHash('sha256').update(text).digest('hex'),'678de217e3cdd4d083c3def2d5fead107e26f89252eeb16fd9ce60f50c655859');
 const cut=structuredClone(actual);Object.assign(cut.emitted_sources.find(e=>e.path==='server/domain.ts')!,{sha256:'678de217e3cdd4d083c3def2d5fead107e26f89252eeb16fd9ce60f50c655859',bytes:47754});rejects(cut,'stock-writer-source-sha');
});
// Source238 re-pinned domain.ts: audit() delegates its insert to insertAuditEvent (238 key row). Reversing
// that one edit (after the 246 and 245 edits) reproduces the Source236 bytes exactly, and the Source236 pin stays refused.
test('the 238 domain.ts re-pin reverses exactly to its Source236 pin, which remains refused',async()=>{
 let text=undo245(undo246(undoOrderNumber(await readFile(new URL('server/domain.ts',root),'utf8'))));
 for(const[from,to]of[
  ["import { insertAuditEvent } from './audit-log';\n",''],
  ["  // 238: an API key actor also leaves its key (audit238_event_keys) in the same statement.\n  await insertAuditEvent(c, a, action, id, detail);\n",
   "  await c.query(\n    'INSERT INTO audit_events(id,tenant_id,user_id,action,entity_id,detail) VALUES($1,$2,$3,$4,$5,$6)',\n    [randomUUID(), a.tenantId, a.userId, action, id, JSON.stringify(detail)],\n  );\n"],
 ]as const){assert.equal(text.split(from).length,2,'one declared 238 edit');text=text.replace(from,()=>to);}
 assert.equal(Buffer.byteLength(text),47766);assert.equal(createHash('sha256').update(text).digest('hex'),'5cde3923fc96767f406ca42ecc8852d3344da32a06c570ab0bd4772688f6dc98');
 const cut=structuredClone(actual);Object.assign(cut.emitted_sources.find(e=>e.path==='server/domain.ts')!,{sha256:'5cde3923fc96767f406ca42ecc8852d3344da32a06c570ab0bd4772688f6dc98',bytes:47766});rejects(cut,'stock-writer-source-sha');
});
// Source209/a251dfe pins re-pinned by Source236 after a per-file review of every change
// since each pin (no new stock write or gate bypass). They stay refused, never a fallback.
const PRE236_PINS=[
 ['server/b2b-network.ts','b00a63a943e494b3f4f7bcf9059d42662f9313e260694cfd03992819f1fe221c',42115],
 ['server/catalog-file-import.ts','bddd733d90f9cc75acb6e5c48aa18e186527d3a40c4aea3170dc2cfdd09c17cc',50440],
 ['server/catalog.ts','114a0b95083f2ec4e77251db6f2983a7f6a49896fb90d9a853924095d34157bb',28181],
 ['server/db.ts','9e90b0385150a1ebc8476b5a2b612e3061f66364194b60bcb54ddf17bc8e528f',42365],
 ['server/developer-api.ts','73b6b9d18abecae79e5e13fffdeb7a620deab9eb06f2bf865172bc3f1659b86b',229352],
 ['server/domain.ts','fae7b853a3ca8dc2328058356dbb4c2e52d462a7c2a8f29a2b75aa767ec1e476',47587],
 ['server/fa3-drafts.ts','09b256c00b59ac8ae72549ff266d7578ca4d8ab9aad359019c72a42e6d57dca8',18691],
 ['server/inventory-bulk-edit.ts','de732ab4ae67c9618f8ac10f088b04f5ca2b9c13a8e85b68a34245a133e9ebca',33961],
 ['server/purchasing.ts','49bc8f82237e04340a3a8f8597525334972762680aa0b81ab392dbfbdadb0d13',21211],
 ['server/return-query.ts','6370b5681d89a712e9aa763b6c7b75c5b82a0fefb39f4baae959d26cdcf508e6',4516],
 ['server/returns.ts','0f32350c256f88cf88e1d7f3cf5d5b2a4d75e86d19741d4121f1473d8cdbef0a',39085],
 ['server/stock-file-import.ts','ee163d00e7c9a2844cbf52f2acd95887094028f57090faa6b23e01b255da2258',46808],
 ['server/warehouse.ts','592908ec669c994149a4830ff9fd4c01e08377ec8940cfbb3280903f3445cf43',15954],
 ['server/wms-lots.ts','71be7fdb5b68502f1c3b14c52d273c615ab790e47cf034dae866909746982e5f',96400],
]as const;
test('the exact fourteen pre236 source pins are re-pinned and remain refused',()=>{
 assert.equal(new Set(PRE236_PINS.map(([path])=>path)).size,14);
 for(const [path,sha256,bytes]of PRE236_PINS){
  assert.notDeepEqual(sourceRoster.find(e=>e.path===path),{path,sha256,bytes});
  const cut=structuredClone(actual);Object.assign(cut.emitted_sources.find(e=>e.path===path)!,{sha256,bytes});rejects(cut,'stock-writer-source-sha');
 }
});
test('obsolete pre207 and pre-Mirakl source pins remain refused rather than allowing a broad source fallback',()=>{
 for(const [path,sha256,bytes]of [
  ['server/db.ts','d939539e7b085446869f7ce81ae0d534c236fab7aff914b03047ab708f38350b',39840],
  ['server/db.ts','f9b41936b43ce69b1b99fcdd0765d80669a22f107956fd6dd31ce23df6a4e397',42341],
  ['server/db.ts','57fb0d26b1b7eeaa857f781c8e575a3ad4e9d43ab6e82cdd9c56282bb3f8f171',39746],
  ['server/db.ts','35f7084c683b7f6bde18735d0cfdf18becb95b21a44b667130d1b047bd624543',38979],
  ['server/db.ts','c3e06f257cdb57c3c0653267fdb4287c0d30c5856dcfedc0faffea2d9e9b2e14',38881],
  ['server/db.ts','bca15986835a52fd7a72ddf57ab5fc25dd61bc564318c49bf177fa43cb25611d',38709],
  ['server/db.ts','d4bce0edc7b79490e35bbc0639a793c119f0ee0aaca5f5c1dc47b10811b49267',38125],
  ['server/domain.ts','981780268e018ff477a2bc29541d2fb39287bb3ec5329f08c7c77f373e078db0',47569],
 ]as const){const cut=structuredClone(actual);Object.assign(cut.emitted_sources.find(e=>e.path===path)!,{sha256,bytes});rejects(cut,'stock-writer-source-sha');}
});
test('missing, duplicate, unrelated source SHA and exact byte-count drift all refuse coverage',()=>{
 const missing=structuredClone(actual);missing.emitted_sources=missing.emitted_sources.filter(e=>e.path!=='server/db.ts');rejects(missing,'stock-writer-source-unique');
 const duplicate=structuredClone(actual);duplicate.emitted_sources.push({...duplicate.emitted_sources[0]});rejects(duplicate,'stock-writer-source-unique');
 const changed=structuredClone(actual);changed.emitted_sources.find(e=>e.path==='server/warehouse.ts')!.sha256='a'.repeat(64);rejects(changed,'stock-writer-source-sha');
 const length=structuredClone(actual);length.emitted_sources.find(e=>e.path==='server/db.ts')!.bytes++;rejects(length,'stock-writer-source-bytes');
});
test('native missing/duplicate/hash/bytes mismatches and malformed manifests still refuse',()=>{
 const missing=structuredClone(actual);missing.files.shift();rejects(missing,'stock-writer-native-resource-unique');
 const duplicate=structuredClone(actual);duplicate.files.push({...duplicate.files[0]});rejects(duplicate,'stock-writer-native-resource-unique');
 const changed=structuredClone(actual);changed.files[0].sha256='a'.repeat(64);rejects(changed,'stock-writer-native-resource-sha');
 const length=structuredClone(actual);length.files[0].bytes++;rejects(length,'stock-writer-native-resource-bytes');
 for(const malformed of [null,{}, {emitted_sources:{},files:[]}])rejects(malformed,'stock-writer-release-shape');
});
test('successful pure coverage validation cannot supply a writer capability or installation',async()=>{
 assertStockWriterManifestCoverage(actual);
 await assert.rejects(claimStockWriterActivation({}as never),e=>e instanceof assert.AssertionError&&e.message.includes('stock-writer-owned-unclaimed-capability'));
 assert.throws(()=>stockWriterInstallationGate({}as never),e=>e instanceof assert.AssertionError&&e.message.includes('stock-writer-genuine-installation'));
});

// Source270 re-pinned catalog-stock-control.ts and catalog-stock-return-effects.ts: effect prepare/finish and return prepare
// call the stock_verdict_ copy when installed. Reversing those edits reproduces their literal pins exactly.
const source270Edits:Record<string,readonly (readonly [string,string])[]>={"server/catalog-stock-control.ts":[["// 270: when installed, the stock_verdict_ copy of a sealed adapter (the same body asking the 248 verdict for the catalog\n// guard: same answer or error) instead of the sealed function, whose body runs the full guard; before 270, the sealed one.\nasync function installed270(c:PoolClient,signature:string):Promise<boolean>{return (await c.query('SELECT to_regprocedure($1) IS NOT NULL installed',[signature])).rows[0].installed;}\n",""],["  const token=await owner(c,async()=>{const fn=await installed270(c,'public.stock_verdict_effect_prepare(uuid,uuid,jsonb)')?'stock_verdict_effect_prepare':'catalog_stock_control_effect_prepare';\n    return (await c.query(`SELECT public.${fn}($1,$2,$3::jsonb) token`,[a.userId,a.apiKeyId??null,JSON.stringify(source)])).rows[0].token;}) as V.CatalogStockEffectAdmission|null;\n","  const token=await owner(c,async()=>(await c.query('SELECT public.catalog_stock_control_effect_prepare($1,$2,$3::jsonb) token',[a.userId,a.apiKeyId??null,JSON.stringify(source)])).rows[0].token) as V.CatalogStockEffectAdmission|null;\n"],["export async function finishCatalogStockEffectInTx(c:PoolClient,a:V.CatalogStockControlActor,token:V.CatalogStockEffectAdmission|null,proof:V.CatalogStockEffectProof){if(token){assertToken(c,a,token);await owner(c,async()=>{const fn=await installed270(c,'public.stock_verdict_effect_finish(uuid,uuid,uuid,jsonb)')?'stock_verdict_effect_finish':'catalog_stock_control_effect_finish';await c.query(`SELECT public.${fn}($1,$2,$3,$4::jsonb)`,[a.userId,a.apiKeyId??null,token.id,JSON.stringify(proof)]);});tokens.delete(token);}}\n","export async function finishCatalogStockEffectInTx(c:PoolClient,a:V.CatalogStockControlActor,token:V.CatalogStockEffectAdmission|null,proof:V.CatalogStockEffectProof){if(token){assertToken(c,a,token);await owner(c,async()=>{await c.query('SELECT public.catalog_stock_control_effect_finish($1,$2,$3,$4::jsonb)',[a.userId,a.apiKeyId??null,token.id,JSON.stringify(proof)]);});tokens.delete(token);}}\n"]],"server/catalog-stock-return-effects.ts":[["    // 270: when installed, the stock_verdict_ copy of the sealed prepare (same body; its catalog guard, frame and effect\n    // admission ask the 248 verdict: same answer or error); before 270, the sealed function.\n    const fn=(await c.query('SELECT to_regprocedure($1) IS NOT NULL installed',['public.stock_verdict_return_prepare(uuid,uuid,jsonb)'])).rows[0].installed?'stock_verdict_return_prepare':'catalog_stock_return_prepare';\n    const raw=(await c.query(`SELECT public.${fn}($1,$2,$3::jsonb) admission`,[a.userId,a.apiKeyId??null,JSON.stringify(b)])).rows[0].admission;\n","    const raw=(await c.query('SELECT public.catalog_stock_return_prepare($1,$2,$3::jsonb) admission',[a.userId,a.apiKeyId??null,JSON.stringify(b)])).rows[0].admission;\n"]]};
const reverse270=(path:string,text:string)=>{for(const[from,to]of source270Edits[path]??[]){assert.equal(text.split(from).length,2,'one declared 270 edit');text=text.replace(from,()=>to);}return text;};
test('the 270 re-pins reverse exactly to their literal pins, which remain refused',async()=>{
 for(const[path,sha256,bytes]of [['server/catalog-stock-control.ts','a37ebf48c1ceabe920ebf48ad27e7bb16942589ddcd7223017200a7f8800531d',29004],['server/catalog-stock-return-effects.ts','a56ab5b2977b9fbb23c963a76788c2e8dc993651f463d949ecc811469d5e99d5',8218]] as const){
  const prior=Buffer.from(reverse270(path,await readFile(new URL(path,root),'utf8')));assert.equal(prior.length,bytes);assert.equal(createHash('sha256').update(prior).digest('hex'),sha256);
  const cut=structuredClone(actual);Object.assign(cut.emitted_sources.find(e=>e.path===path)!,{sha256,bytes});rejects(cut,'stock-writer-source-sha');
 }
});

test('the 272 re-pin reverses exactly to its pre-272 pin, which remains refused',async()=>{
 for(const[path,sha256,bytes]of [["server/financial-return-completion.ts","a61101fb0dad183c13c72201aab767ab1e6e959a3bfbad86f05d1226b3416dec",12341]] as const){
  const prior=Buffer.from(reverse272(path,await readFile(new URL(path,root),'utf8')));assert.equal(prior.length,bytes);assert.equal(createHash('sha256').update(prior).digest('hex'),sha256);
  const cut=structuredClone(actual);Object.assign(cut.emitted_sources.find(e=>e.path===path)!,{sha256,bytes});rejects(cut,'stock-writer-source-sha');
 }
});
test('the 264 re-pin reverses exactly to its Source248 pin, which remains refused',async()=>{
 const path='server/catalog-stock-control-transaction.ts',sha256='ccf8dbc0f60a6601ca959d5202da88fe85681451443dd08c8b6472854e7700ef',bytes=15908;
 const prior=Buffer.from(reverse264(path,await readFile(new URL(path,root),'utf8')));assert.equal(prior.length,bytes);assert.equal(createHash('sha256').update(prior).digest('hex'),sha256);
 const cut=structuredClone(actual);Object.assign(cut.emitted_sources.find(e=>e.path===path)!,{sha256,bytes});rejects(cut,'stock-writer-source-sha');
});
test('the 248 re-pins reverse exactly to their pre-248 pins, which remain refused',async()=>{
 for(const[path,sha256,bytes]of [["server/catalog-stock-control-transaction.ts", "6b69b0f53b232dfdb204e6432d23c9d33ec3eb991815396b90f9164fabed96fc", 15542], ["server/financial-return-completion.ts", "45fca034bd5059808f5ad9197af4f8f4e560994c7a76ac1ac9154b00f6c58400", 12115]] as const){
  const prior=Buffer.from(reverse248(path,await readFile(new URL(path,root),'utf8')));assert.equal(prior.length,bytes);assert.equal(createHash('sha256').update(prior).digest('hex'),sha256);
  const cut=structuredClone(actual);Object.assign(cut.emitted_sources.find(e=>e.path===path)!,{sha256,bytes});rejects(cut,'stock-writer-source-sha');
 }
});
test('the five mixed-duty presence getters reverse exactly to their literal old writer pins',async()=>{
 const comment='/** Presence only; never authorization, admission or transaction readiness. */\n';
 const witnesses=[
  ['server/allegro-oauth-authority.ts','export function hasAllegroAuthorityTransactionDuty(c:PoolClient){return Boolean(registry.get(c)?.authorities.size || registry.get(c)?.jobPins.size);}',27978,'ccca36ea47f74875ad6370c242f7cf550862ce40148f454dbfc9696664d1e9b0'],
  ['server/catalog-stock-control-transaction.ts','export function hasCatalogStockControlTransactionDuty(c:PoolClient){return Boolean(contexts.get(c)?.actors.size || contexts.get(c)?.countTerminals.size);}',15308,'18076981a548025b662e9eb21eff67b2ab789467ceaa1cb37eff65aaa7edca0f'],
  ['server/dispatch-transaction.ts','export function hasDispatchTransactionDuty(c:PoolClient){return Boolean(grants.get(c)?.size);}',3766,'f0079edf72b896cda75d0617fad4ae8cd45fecf4d38b695acb81e1dfedcf4b25'],
  ['server/financial-return-completion.ts','export function hasFinancialReturn162TransactionDuty(c:PoolClient){return Boolean(transactions.get(c)?.claimed || transactions.get(c)?.duties.length);}',11884,'a03f402dd1dd367048c4a29bc9d0afebe6461a186bacc1954e8f30d344cc5b09'],
  ['server/inventory-correction.ts','export function hasInventoryCorrectionTransactionDuty(c:PoolClient){return Boolean(managed.get(c)?.duties.length);}',11202,'b46d2dbb8ebd467964b1e334056e8d6468cbd78fab066e018d055da168e5caff'],
 ]as const;
 for(const [path,body,bytes,sha256]of witnesses){
  const text=reverse248(path,await readFile(new URL(path,root),'utf8')),addition=comment+body+'\n';assert.equal(text.split(addition).length,2);
  const prior=Buffer.from(text.replace(addition,''));assert.equal(prior.length,bytes);assert.equal(createHash('sha256').update(prior).digest('hex'),sha256);
  const obsolete=structuredClone(actual);Object.assign(obsolete.emitted_sources.find(r=>r.path===path)!,{sha256,bytes});rejects(obsolete,'stock-writer-source-sha');
 }
});


test('atomic return outcome wrapper reverses exactly to the pinned prior stock writer',async()=>{
 const live=await readFile(new URL('server/returns.ts',root),'utf8');
 // 060d31a adds only the optional 223 reason choice (own tables); reversing it reproduces the a251dfe pin.
 let source=live;for(const added of [
  "import { attachReturnReasonInTx, returnReasonChoicesInTx } from './return-reasons223';\n",
  '  // Optional 223 dictionary choice; the free-text reason stays the native text (none = "other").\n  reason_id: z.uuid().optional(),\n',
  '    reason_choice: (await returnReasonChoicesInTx(c, [id])).get(id) ?? null,\n',
  '  if (input.reason_id !== undefined) await attachReturnReasonInTx(c, a, id, input.reason_id);\n',
 ]){assert.equal(source.split(added).length,2,'one declared 223 edit');source=source.replace(added,'');}
 assert.equal(Buffer.byteLength(source),39085);assert.equal(createHash('sha256').update(source).digest('hex'),'0f32350c256f88cf88e1d7f3cf5d5b2a4d75e86d19741d4121f1473d8cdbef0a');
 const addition=`// Older accepted history may lack a sequenced receipt identity. Preserve replay
// readback, but never manufacture an identity or report a new unsequenced receipt.
function returnReceiveOutcome<T extends Record<string, any>>(result: T, reused: boolean) {
  const identity = typeof result.id === 'string' &&
    Number.isInteger(result.receipt_sequence) && result.receipt_sequence > 0
    ? { return_id: result.id, receipt_sequence: result.receipt_sequence } : null;
  ensure(reused || identity, 503, 'Brak trwałej tożsamości nowego przyjęcia zwrotu');
  return { ...result, reused, receive_receipt: identity };
}
`;
 const changes=[
  [addition,''],
  ['    return returnReceiveOutcome(result, true);','    return result;'],
  ['    return returnReceiveOutcome(result, false);','    return result;'],
  ['  const result = await getReturn(c, id);\n  return returnReceiveOutcome(result, false);\n}\nexport async function decideReturn(', '  return getReturn(c, id);\n}\nexport async function decideReturn('],
 ] as const;
 let prior=source;for(const[from,to]of changes){assert.equal(prior.split(from).length,2,'one declared source edit');prior=prior.replace(from,()=>to);}
 assert.equal(Buffer.byteLength(prior),38350);assert.equal(createHash('sha256').update(prior).digest('hex'),'cce7b2cb21659c1637a44f5394f28cb74aadd9fed1a00ecabd2acad8ed42c7a0');
 assert.deepEqual(sourceRoster.find(r=>r.path==='server/returns.ts'),{path:'server/returns.ts',sha256:'41f1d29ff26f5def0975b1a1629cc9b4665f3214d11e143afc9765526c2b8989',bytes:39475});
 const obsolete=structuredClone(actual);Object.assign(obsolete.emitted_sources.find(r=>r.path==='server/returns.ts')!,{sha256:'cce7b2cb21659c1637a44f5394f28cb74aadd9fed1a00ecabd2acad8ed42c7a0',bytes:38350});rejects(obsolete,'stock-writer-source-sha');
});

// The 2e35002 db.ts is history: later migrator commits changed db.ts, so the SMTP
// inverse starts from these exact pinned bytes, not from the live file.
const SMTP2E35002_DB={bytes:42365,sha256:'9e90b0385150a1ebc8476b5a2b612e3061f66364194b60bcb54ddf17bc8e528f',gzip_base64:'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'};
test('owner-private SMTP port preserves the complete committed genuine split preflight source',async()=>{
 const bytes=gunzipSync(Buffer.from(SMTP2E35002_DB.gzip_base64,'base64'),{maxOutputLength:SMTP2E35002_DB.bytes});
 assert.equal(bytes.length,SMTP2E35002_DB.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),SMTP2E35002_DB.sha256);
 const marker='; localSmtpPort?: number';assert.equal((await readFile(new URL('server/db.ts',root),'utf8')).split(marker).length,2);
 const current=bytes.toString('utf8');assert.equal(current.split(marker).length,2);
 const original=current.replace(marker,'');
 assert.equal(Buffer.byteLength(original),42341);
 assert.equal(createHash('sha256').update(original).digest('hex'),'f9b41936b43ce69b1b99fcdd0765d80669a22f107956fd6dd31ce23df6a4e397');
});
