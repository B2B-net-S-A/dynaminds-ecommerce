/** Trusted construction-only adapter coverage. No HTTP setter, actor/IAM cache,
 * stock writer or policy activation. BO still requires its real native gates. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {constants,type BigIntStats} from 'node:fs';
import {open,lstat,realpath} from 'node:fs/promises';
import path from 'node:path';
import {beginReviewedStartupOperation,inspectCompositeStartupInOperation,closeReviewedStartupOperation,
 recheckReviewedStartupEvidence,createOrdinarySchemaTransactionGate,assertOwnedOrdinarySchemaTransactionGate,type OrdinarySchemaTransactionGate,type ReviewedStartup} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/runtime-api';
type Entry={path:string;sha256:string;bytes:number};
// Physical42 roster includes reviewed V2 order-detail batching and additive204
// commercial document scope. Exact db migration and FA3 refusal changes are pinned;
// other original writers remain literal. db/API identities are projected
// through reviewed187 pool/188 loader and API metadata inverses. No writer guard bypass.
// The emitted manifest's complete bytegraph is independently checked by Startup;
// these pinned source identities prevent borrowing coverage for different writers.
// Mirakl successor (6fd6ebc): only db.ts current-session transaction hooks and
// domain.ts additive source enum changed. Source207 changes only the db.ts migration
// tail206→207; reviewed split hooks148d5c5/3db244a extend both transaction paths.
// Source209 adds only the next migration entry. Five3db244a presence getters are
// pinned after exact removal reproduces their old sources; other36 and all3 Native pins stay literal.
// a251dfe return receipt identity adds a readout wrapper only; the exact inverse
// is checked in coverage tests. Stock transaction gates and Native roster stay literal.
// Source236 re-pins14 drifted sources after review: deleted-product225 refusals, reason223
// readouts, read/append tx, MIG-3/6/7 migrator and API scopes add no stock write or gate bypass.
// Source238 re-pins domain.ts after review: audit() only delegates its one audit_events insert to
// insertAuditEvent (plus the audit238 key row); no stock write, stock-writer call or gate bypass.
// Source239 re-pins warehouse-wz-issuer.ts after review: prepare first asks the owner-only read-only
// wz_issuer239_prepare_skip and returns null only where the sealed prepare would; no stock write or gate bypass.
// Source244 re-pins db.ts and developer-api.ts after review: MIG-2 migrate() only reads migration_checksums after the
// ledger check and records missing rows before COMMIT; three AUTO-07 public operations; no stock write or gate bypass.
// Source245 re-pins domain.ts after review: createOrder reads the tenant default link validity
// (portal253_link_policies, read only) and adds portal_expires_at to the one orders INSERT; no stock write or gate bypass.
// Source246 re-pins domain.ts after review: new→picking also admits an order charged to B2B trade credit
// (tradeCreditReleasedInTx, one read of b2b254_trade_charges), like cash on delivery; no stock write or gate bypass.
// Source248 re-pins catalog-stock-control-transaction.ts and financial-return-completion.ts after review: inside a
// transaction each asks the owner-only guard_verdict() for its full guard (same answer or error); no stock write or gate bypass.
// Source250 re-pins wms-lots.ts, stock-file-import.ts and stocktake-adjustments.ts after review: shared WMS
// operations fence, client-key and scan stock locks, serial admission of stocktake writers; no new stock write.
// SourceMIG1 re-pins db.ts after review: migrate() waits for its 982376 fence with its own budget (SET LOCAL, then the
// session limits again) and names a failed migration of the one-transaction series; no stock write or gate bypass.
// Source251 re-pins b2b-network.ts after review: invitation, acceptance and settings ask the 251 link state
// (b2b258_link_states); a reconnect updates the b2b_links row in place; no stock write, stock-writer call or gate bypass.
// Source264 re-pins catalog-stock-control-transaction.ts after review: availability reuses the first full guard's
// 'available' within one READ ONLY REPEATABLE READ transaction (transaction-local marker); no stock write or gate bypass.
// Source270 re-pins catalog-stock-control.ts and catalog-stock-return-effects.ts after review: effect prepare/finish and
// return prepare call the stock_verdict_ copy when installed (sealed body, 248 verdict for the guard); no stock write or gate bypass.
// Source272 re-pins financial-return-completion.ts after review: the ordinary receive asks the owner-only 272 front
// door, which returns null only where the sealed financial_return_capture would; no stock write or gate bypass.
// Source273 (prepared) re-pins warehouse-wz-issuer.ts after review: a 57014 of wz_issuer239_prepare_skip schedules one
// background wz_issuer273_refresh() (own owner transaction, same verdict) and is rethrown; no stock write or gate bypass.
// SourceOpening re-pins wms-lots.ts after review: the opening row cap is per plan (enterprise 200 000) and rows
// without stock are locked and digested in SQL instead of loaded; no new stock write, stock-writer call or gate bypass.
// SourceDbErrors re-pins db.ts after review: the ordinary pool is built through watchDbPool (db-connection-errors.ts),
// which only adds 'error' listeners (idle pool + every checked-out client) that log and count a lost connection; the
// old idle-only listener is gone. Pool options, transactions and stock hooks unchanged; no stock write or gate bypass.
// SourceDbLocks re-pins db.ts after review: tenantTx calls assertDbLocksHeldInTx(c) right before COMMIT, which refuses
// the commit (rollback) when a session advisory lock of the async context was lost (one pg_locks read only under
// holdingDbLock); no stock write, stock-writer call or gate bypass.
// SourceOrderNumber re-pins domain.ts after review: createOrder runs its one orders INSERT through insertOrderWithNumberInTx,
// which redraws a taken DE-<date>-<hex> number under a savepoint; no stock write, stock-writer call or gate bypass.
// Source269 adds server/order-warehouse-transfer.ts after review: "Zmień magazyn" and the rule effect assign_warehouse admit the
// order like a reservation edit (catalog lock, inventory policies of both warehouses, LINE_BLOCKERS, WMS lots off) and call
// only the owner function order_warehouse269_transfer (269 SQL), whose one transaction returns stock.reserved and the location
// rows in the old warehouse and reserves the same quantities (stock, reservations, free bins) in the new; no other stock write.
// SourceUwagi3 re-pins domain.ts and wms-lots.ts after review (Uwagi v3 lanes, migrations 265–268, neutral publication comment;
// with 268 a new DEMO label takes over the cancelled shipments row):
// order card stage/sections, invoice data, DEMO label at packing and automation events; a WMS order line edit releases or
// resizes only that product's reservation layers/locations (no stock row write); no new stock-writer call or gate bypass.
// SourcePortalN1 re-pins return-query.ts and catalog-stock-return-effects.ts after review: a returns list page reads its
// PZ heads once (one availability verdict, one read for all rows) instead of once per row; read only, no stock write or gate bypass.
const SOURCE_ROSTER:readonly Entry[]=[{"path":"server/allegro-oauth-authority.ts","sha256":"24d0106650c30ce482fe9d96ed09ebb1895b31709e9403d55af61f6431ccb848","bytes":28207},{"path":"server/b2b-credits.ts","sha256":"549c4fb6079275bec28b2b02b825c5dbc9aca2c847589156ecc9d1f3598c84c5","bytes":18397},{"path":"server/b2b-invoices.ts","sha256":"9b700daf87ac6dd1efd6ce5213508d78ba5ecb41d71c43bb133e9a9869979d55","bytes":14341},{"path":"server/b2b-network.ts","sha256":"95d71c5f7f823ea2b984b73a94e405de64902499048ac19e244e30444144587d","bytes":47640},{"path":"server/catalog-file-import.ts","sha256":"e1bb039db95b3e23491a189ac89d3a82ec60f9b0d3b86d01b8c3c416c5b9cdf8","bytes":50847},{"path":"server/catalog-stock-control-routes.ts","sha256":"2a39f1749c43912ed038ef7b59c3da4156b81e517bed0b8e2750ea2fa0ab643a","bytes":3511},{"path":"server/catalog-stock-control-transaction.ts","sha256":"0fc4257558f003b98b6817e488685da0ff78812884c767255f4edfead41d7b40","bytes":18443},{"path":"server/catalog-stock-control.ts","sha256":"e2e2c8411f8b87bdbe2659ae15fab3118fa43fac213a5cca11ccba776e40bf0a","bytes":29701},{"path":"server/catalog-stock-count-effects.ts","sha256":"3abe5e95a026fbdeccc0d98566dc31fb20517952c2ae021f3add0415bd5e6b9a","bytes":14209},{"path":"server/catalog-stock-count-query.ts","sha256":"fbae554cbca4285529d48b9bd6ae7b157672eef8bb6b9f0e9b7a526ef3e99aab","bytes":28320},{"path":"server/catalog-stock-count-read.ts","sha256":"25868041fb19031506e6125155fba1832fc8222dcd69e57afa22badac1eff9d5","bytes":2948},{"path":"server/catalog-stock-count-routes.ts","sha256":"e6b8cb6ca053aee3042cd41f4ef311b9a55bab6fc0abf46f3b9e9fa461fe48a3","bytes":2772},{"path":"server/catalog-stock-effects.ts","sha256":"bacde0b6d1378ad33e632f5e151a5abad9e0e1bdbff9588001559fa709abb8c0","bytes":3164},{"path":"server/catalog-stock-return-effects.ts","sha256":"4869906e9b550828147e6e79871769b9128fe97f2fe4d6061d77006de734a983","bytes":10309},{"path":"server/catalog.ts","sha256":"7fe1988a3e4a5c178181ac89cb124c5bd7418007f00bc475fb88ff26d0eb2c61","bytes":29110},{"path":"server/db.ts","sha256":"01078f53f209e6e9314886e7735e6730af3dbcec3ac9849e4e8e5cac5d5bfb7c","bytes":49754},{"path":"server/developer-api.ts","sha256":"0ebcef75ff081a07bdf5b65ab4e888d26fcad3647ef549d71ce49d0b0664552d","bytes":234015},{"path":"server/dispatch-transaction.ts","sha256":"c850ead1dade41b29364408a22e047b4101fda0ed5d8292aa0125735ca316a66","bytes":3940},{"path":"server/domain.ts","sha256":"97c9165aba2352f24edbbd20bcecf76124eeceb2494dba80391d67b02de58b76","bytes":53831},{"path":"server/fa3-drafts.ts","sha256":"e2e4cfa136919e563b0906cb9bb0aa76105f048cdd19744e0ecca2caf655867d","bytes":18836},{"path":"server/financial-return-completion.ts","sha256":"b43a9629ffe12fe54a325d8678473d1eee0bcb4861bc85ce5faa269935c0e424","bytes":12727},{"path":"server/inventory-bulk-edit.ts","sha256":"cf987e0bd5823d8ca065aa8114fe77f1b9a31c55a7f8e44127d38ca5fa2a01fe","bytes":34230},{"path":"server/inventory-correction.ts","sha256":"f6f2527c7a0904d5decf7392cc4b7726dda75bc83f5ef8ecb335117a8849465a","bytes":11397},{"path":"server/legacy-return-automation-group.ts","sha256":"0122603cc284960c67f8ad5de2776e416111e03298acbff4d4f0cbac618478f8","bytes":9365},{"path":"server/legacy-return-group.ts","sha256":"c8cb510ce9d60fa31895a7176341b0ae94b02336f3178f0b7832748f245b3af0","bytes":6945},{"path":"server/manual-inventory-off-runtime.ts","sha256":"7868695fd6ed98e8376e2e58e12d67ccf07d1a22a44b751a2fb6911e5d6b2910","bytes":1495},{"path":"server/order-warehouse-transfer.ts","sha256":"3cd05074d3dfc6c43578a136175b7e5c9bbcd5973a9bfa1819581d45b8e1274c","bytes":5618},{"path":"server/purchasing.ts","sha256":"b0d6da492dc27fb8ce581801adfb3b4cfa039b7ffa08e6266f4d2b5457cdcc29","bytes":21347},{"path":"server/return-completion.ts","sha256":"1fd7129ae3bd0e29e4e77690782d9f4f65c74a87e54753d45623fb4750b56231","bytes":5585},{"path":"server/return-destination-statuses.ts","sha256":"4bf2587105730ecc04a67dfa0de6c068349e309a3df948bfcb890093b101d433","bytes":13482},{"path":"server/return-destinations.ts","sha256":"c514fd6de722755258ea0de284a784bdb511415ca36b95d211f16588152ab26c","bytes":30222},{"path":"server/return-query.ts","sha256":"f0b3872095b2f0673e2dc2a62296aacdb43716d85103b06bfea95a8aa556a6b2","bytes":4638},{"path":"server/returns.ts","sha256":"41f1d29ff26f5def0975b1a1629cc9b4665f3214d11e143afc9765526c2b8989","bytes":39475},{"path":"server/stock-file-import.ts","sha256":"6b9a28df2393883fbcfcc06bb44a09476bc1c44e84a70ca35e320334029bc6e9","bytes":47075},{"path":"server/stock-locations.ts","sha256":"51ed29a05eba3619f050c09cfc106f2295ed2eece33cbab2cdcfc119355876d5","bytes":10302},{"path":"server/stocktake-adjustments.ts","sha256":"30bc5300b414dc6b88e5a5251ecfe8a24cddbd92ec5739d349321ff8e291bfcd","bytes":30953},{"path":"server/warehouse-automatic-wz.ts","sha256":"15bf09f37674b4eedbcedf48de9ac86a29e92565c1183bd8b78e1b37cbcd7442","bytes":13307},{"path":"server/warehouse-document-register.ts","sha256":"65823c253f5c57215a61dce5b5b64bf5e1d16feea528a2f183f0783b8e8150f9","bytes":25918},{"path":"server/warehouse-inventory-policies.ts","sha256":"eca300d0b965457201ca778847de53dfdd4aaebd7c6918f418353881bd884f16","bytes":13629},{"path":"server/warehouse-wz-issuer-schema.ts","sha256":"96254688dc94202382f0cefa602a3e725562b1a94123d45df93147e4590f49a8","bytes":1590},{"path":"server/warehouse-wz-issuer.ts","sha256":"a9d23da2b028d2a491536bc457f3adfc93d3edb81cb8619432f798a49eb9f2cd","bytes":10476},{"path":"server/warehouse.ts","sha256":"47ddb680ffef2ed937858521b569a5e36771abc5c7062503df3e5dabfb7950b6","bytes":16226},{"path":"server/wms-lots.ts","sha256":"fb381a403cbfc0cad1b9970b759dd6d932d23a3c481873fecdc3d346585fd6b4","bytes":105222}];
const NATIVE_ROSTER:readonly Entry[]=[{"path":"resources/server/150_warehouse_automatic_wz.sql","sha256":"e8617aa82f088e2521e5267f79b9c25692f8a30fa9478faa5426ad7cb57a47c1","bytes":34623},{"path":"resources/server/151_warehouse_wz_issuer.sql","sha256":"0568417df09db4821a342f166e089076d79058b9b83759d36efd02a30dadd5db","bytes":52622},{"path":"resources/server/152_catalog_stock_control.sql","sha256":"52737f5284811f32607e219cd262fdf796ff097d91d18502b38465e3c6823e1e","bytes":318035}];
declare const brand:unique symbol;
export type StockWriterActivation=Readonly<{readonly [brand]:true}>;
declare const installedBrand:unique symbol;
export type StockWriterInstallation=Readonly<{readonly [installedBrand]:true}>;
type Release={releaseDirectory:string;manifestSha:string;expectedOwner:string};
type Owner={query(sql:string,params?:unknown[]):Promise<{rows:any[]}>;
 connection?:{on(name:string,listener:(message:{status:string})=>void):unknown;
 removeListener(name:string,listener:(message:{status:string})=>void):unknown}};
type State={startup:ReviewedStartup;release:Release;gate:OrdinarySchemaTransactionGate;active:boolean;claimed:boolean;busy:boolean};
const installations=new WeakMap<StockWriterInstallation,State>();
const states=new WeakMap<StockWriterActivation,State>(),owners=new WeakSet<object>(),issued=new WeakSet<object>();
const hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
const identity=(s:BigIntStats)=>[s.dev,s.ino,s.uid,s.gid,s.nlink,s.mode,s.size,s.mtimeNs,s.ctimeNs].join(':');
/** Pure source-identity check only. It cannot mint, claim or install a writer capability.
 * The private manifest reader still authenticates file identity and complete bytes first. */
export function assertStockWriterManifestCoverage(value:unknown):void{
 assert(value&&typeof value==='object','stock-writer-release-shape');
 const m=value as {emitted_sources:Entry[];files:Entry[]};assert(Array.isArray(m.emitted_sources)&&Array.isArray(m.files),'stock-writer-release-shape');
 const exact=(rows:Entry[],expected:readonly Entry[],label:string)=>{for(const pin of expected){const matches=rows.filter(row=>row.path===pin.path);assert.equal(matches.length,1,label+'-unique');assert.equal(matches[0].sha256,pin.sha256,label+'-sha');assert.equal(matches[0].bytes,pin.bytes,label+'-bytes');}};
 exact(m.emitted_sources,SOURCE_ROSTER,'stock-writer-source');exact(m.files,NATIVE_ROSTER,'stock-writer-native-resource');
}
async function manifest(release:Release){
 assert(path.isAbsolute(release.releaseDirectory)&&path.resolve(release.releaseDirectory)===release.releaseDirectory);
 assert.equal(await realpath(release.releaseDirectory),release.releaseDirectory,'stock-writer-canonical-release');
 assert(/^[a-f0-9]{64}$/.test(release.manifestSha)&&release.expectedOwner==='postgres');
 const filename=path.join(release.releaseDirectory,'release.json'),before=await lstat(filename,{bigint:true});
 assert(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1n&&before.uid===BigInt(process.getuid!())&&before.size>0n&&before.size<=2097152n,'stock-writer-release-file');
 const fd=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);let first:unknown,failed=false,value:unknown;
 try{assert.equal(identity(await fd.stat({bigint:true})),identity(before));const bytes=await fd.readFile();assert.equal(BigInt(bytes.length),before.size);
  assert.equal(hash(bytes),release.manifestSha,'stock-writer-exact-release');value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  assert.equal(identity(await fd.stat({bigint:true})),identity(before));assert.equal(identity(await lstat(filename,{bigint:true})),identity(before));assert.equal(await realpath(filename),filename);
 }catch(error){failed=true;first=error;}try{await fd.close();}catch(error){if(!failed){failed=true;first=error;}}if(failed)throw first;
 assertStockWriterManifestCoverage(value);
}
async function idle(owner:Owner){
 const connection=owner.connection;assert(connection&&typeof connection.on==='function'&&typeof connection.removeListener==='function','stock-writer-real-idle-owner');
 let status:string|undefined;const ready=(message:{status:string})=>{status=message.status;};connection.on('readyForQuery',ready);
 try{const r=(await owner.query('SHOW transaction_read_only')).rows;assert.equal(status,'I','stock-writer-idle-owner-required');assert.equal(r[0]?.transaction_read_only,'off','stock-writer-write-owner-required');}
 finally{connection.removeListener('readyForQuery',ready);}
}
/** Called only with the factory's dedicated owner and its genuine current
 * Startup after full cold activation. Source/operator configuration cannot
 * replace this owner, Startup or coverage list. Native/schema rows are read-only. */
export async function prepareStockWriterActivation(owner:Owner,startup:ReviewedStartup,input0:Release):Promise<StockWriterActivation>{
 const release=structuredClone(input0);assert.deepEqual(Object.keys(release).sort(),['expectedOwner','manifestSha','releaseDirectory']);
 assert(!owners.has(owner)&&!issued.has(startup),'stock-writer-construction-already-used');owners.add(owner);issued.add(startup);
 let operation:Awaited<ReturnType<typeof beginReviewedStartupOperation>>|undefined,began=false,failed=false,first:unknown;
 try{
  operation=await beginReviewedStartupOperation(startup);await idle(owner);await manifest(release);
  await owner.query('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');began=true;
  await owner.query('SELECT pg_advisory_xact_lock(982376)');
  const context=(await owner.query('SELECT session_user owner,current_user role')).rows[0];assert(context?.owner===release.expectedOwner&&context.role===release.expectedOwner,'stock-writer-genuine-owner-context');
  await inspectCompositeStartupInOperation(owner,startup,operation);
  const guards=(await owner.query('SELECT public.catalog_stock_control_guards() control,public.warehouse_automatic_wz_guards() automatic,public.warehouse_wz_issuer_guards() issuer')).rows;
  assert.equal(guards.length,1);assert(guards[0].control===true&&guards[0].automatic===true&&guards[0].issuer===true,'stock-writer-native-coverage-required');
  await manifest(release);const evidence=await closeReviewedStartupOperation(startup,operation);operation=undefined;
  assert.equal(evidence.release_manifest_sha256,release.manifestSha,'stock-writer-same-startup-release');
  await owner.query('COMMIT');began=false;
 }catch(error){failed=true;first=error;}
 if(began)try{await owner.query('ROLLBACK');}catch(error){if(!failed){failed=true;first=error;}}
 if(operation)try{await closeReviewedStartupOperation(startup,operation);}catch(error){if(!failed){failed=true;first=error;}}
 owners.delete(owner);if(failed)throw first;
 const capability=Object.freeze({}) as StockWriterActivation;const gate=createOrdinarySchemaTransactionGate(startup);assertOwnedOrdinarySchemaTransactionGate(gate);states.set(capability,{startup,release,gate,active:true,claimed:false,busy:false});return capability;
}
/** Private buildApp intake, once before its first pool query. This installs
 * metadata availability only; native BO access, versions, complete source and
 * fresh early/late user/session/member/key checks remain unchanged per TX. */
export async function claimStockWriterActivation(capability:StockWriterActivation):Promise<StockWriterInstallation>{
 const s=states.get(capability);assert(s?.active&&!s.claimed&&!s.busy,'stock-writer-owned-unclaimed-capability');s.busy=true;
 try{const closure=await recheckReviewedStartupEvidence(s.startup);assert(s.active&&!s.claimed,'stock-writer-capability-closed');assert('release_manifest_sha256'in closure&&closure.release_manifest_sha256===s.release.manifestSha,'stock-writer-current-package');await manifest(s.release);assert(s.active,'stock-writer-capability-closed');s.claimed=true;const installation=Object.freeze({}) as StockWriterInstallation;installations.set(installation,s);return installation;}
 catch(error){s.active=false;throw error;}finally{s.busy=false;}
}
/** After Fastify close/request drain; never before a live operation's native pin. */
export function disposeStockWriterActivation(capability:StockWriterActivation){const s=states.get(capability);assert(s,'stock-writer-owned-capability');s.active=false;}

/** Route registration receives only this genuine claimed installation; no bool
 * or caller callback can supply a schema gate. */
export function stockWriterInstallationGate(installation:StockWriterInstallation):OrdinarySchemaTransactionGate{const s=installations.get(installation);assert(s?.active&&s.claimed,'stock-writer-genuine-installation');assertOwnedOrdinarySchemaTransactionGate(s.gate);return s.gate;}
