import { beginMiraklSessionAuthorityTransaction, endMiraklSessionAuthorityTransaction, prepareMiraklSessionAuthoritiesInTx, finalizeMiraklSessionAuthoritiesInTx } from './mirakl-session-authority';
import {runBoundDurableTenantTransaction187,hasAcknowledgedDurableWorkerRollback187,isDurableWorkerClientTainted187} from './large-import/durable-original-epoch';
import {beginOrderSplitTransaction,endOrderSplitTransaction,hasOrderSplitTransactionDuty,finalizeOrderSplitTransactionInTx} from './order-split-transaction';
import {assertOrderSplitCompositionInTx} from './order-split-composition';
import assert from 'node:assert/strict';
import {ensureMigrationRegistry,assertLedgerKnownToRelease,assertMigrationChecksums,recordMigrationChecksums,migrationProgramFiles,acquireMigrationLock,MigrationFailedError,type MigrationProgramFile} from './migration-bootstrap';
import {backupBeforeMigrating,migrationBackupSettings,type MigrationBackupReceipt} from './migration-backup';
import {createOrdinarySchemaTransactionGate,assertOwnedOrdinarySchemaTransactionGate,type OrdinarySchemaTransactionGate,type ReviewedStartup} from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/runtime-api';
import { readRuntimeResource } from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/runtime-resources.mjs';
import { RELEASE_MIGRATION_PROGRAM } from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/migration-manifest.mjs';
import { preflightNestedPim } from './pim-dictionaries/nested-capability';
import { beginCatalogAttributesTransaction, endCatalogAttributesTransaction } from './catalog-attributes-transaction';
import { preflightPim, beginPimTransaction, preparePimTransactionInTx, finalizePimTransactionInTx, endPimTransaction } from './pim-dictionaries/runtime';
import { drainPublicConstraintsInTx } from './public-constraint-drain';
import { beginInventoryCorrectionTransaction, endInventoryCorrectionTransaction, prepareInventoryCorrectionFinalizationInTx, finalizeInventoryCorrectionClockInTx } from './inventory-correction';
import { preflightPhysicalParcelWz,beginPhysicalParcelWzTransaction,endPhysicalParcelWzTransaction,preparePhysicalParcelWzFinalizationInTx,finalizePhysicalParcelWzInTx } from './physical-parcel-wz';
import {beginFinancialReturn162Transaction,endFinancialReturn162Transaction,finalizeFinancialReturn162InTx} from './financial-return-completion';
import { beginBuyerAddressTransaction, endBuyerAddressTransaction, finalizeBuyerAddressInTx } from './buyer-address';
import { preflightOperationalDeliveryConsumers, beginOperationalDeliveryTransaction,
  endOperationalDeliveryTransaction, finalizeOperationalDeliveryInTx } from './operational-delivery-consumers';
import { beginCompetitorObservationTransaction, endCompetitorObservationTransaction,
  finalizeCompetitorObservationAuthoritiesInTx } from './competitor-observations';
import { beginAllegroAuthorityTransaction, endAllegroAuthorityTransaction,
  finalizeAllegroAuthoritiesInTx } from './allegro-oauth-authority';
import pg, { type PoolClient } from 'pg';
import { watchDbPool } from './db-connection-errors';
import { assertDbLocksHeldInTx } from './db-lock-holder';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beginDispatchTransaction, endDispatchTransaction, finalizeDispatchActorsInTx } from './dispatch-transaction';
import { beginCatalogStockControlTransaction, endCatalogStockControlTransaction,
  catalogStockControlAdmissionInTx, finalizeCatalogStockControlActorsInTx, finalizeCatalogStockCountTerminalInTx } from './catalog-stock-control-transaction';
import {
  beginWmsTransaction,
  endWmsTransaction,
  finalizeWmsActorsInTx,
  wmsLotsAdmissionInTx,
  type WmsAdmission,
} from './wms-lots-transaction';
import {
  beginPurchasingTransaction,
  purchasingStockAdmissionInTx,
  endPurchasingTransaction,
  purchasingSourceAdmissionInTx,
} from './purchasing-transaction';
const localPath = resolve(process.env.DYNA_LOCAL_CONFIG_PATH ?? '.local.json');
if (process.env.DYNA_LOCAL_CONFIG_PATH && !existsSync(localPath))
  throw new Error('Brak konfiguracji odtworzonej kopii');
export const localConfig: { dbPassword: string; encryptionKey: string; localSmtpPort?: number } = existsSync(localPath)
  ? JSON.parse(readFileSync(localPath, 'utf8'))
  : { dbPassword: randomBytes(24).toString('hex'), encryptionKey: randomBytes(32).toString('hex') };
if (!existsSync(localPath)) writeFileSync(localPath, JSON.stringify(localConfig), { mode: 0o600 });
const databaseUrl =
  process.env.DATABASE_URL ??
  `postgres://postgres:${localConfig.dbPassword}@127.0.0.1:55432/dynaminds`;
const databaseHost = new URL(databaseUrl).hostname;
if (!['127.0.0.1', 'localhost', '[::1]'].includes(databaseHost)) {
  throw new Error('DATABASE_URL musi wskazywać lokalny PostgreSQL. Zdalna baza jest zabroniona.');
}
// Idle clients (pool 'error') and checked-out clients (one listener per client: pg-pool drops its own on
// checkout) log and count a lost connection instead of throwing it; later requests get a new connection
// without retrying any transaction (db-connection-errors.ts, dry run -68).
export const pool = watchDbPool(new pg.Pool({
  connectionString: databaseUrl,
  max: 12,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  // Wire protocol startup settings apply to every new ordinary pooled connection.
  options: "-c jit=off -c statement_timeout=8000 -c lock_timeout=8000 -c timezone=UTC",
}), 'pool');
let ordinarySchemaGate:OrdinarySchemaTransactionGate|undefined;
/** Genuine Startup only; factory invokes once after exclusive cold approval and
 * before constructing/listening app. Legacy host has no gate and stays strict. */
export function installOrdinarySchemaRuntime(startup:ReviewedStartup){
 if(ordinarySchemaGate)throw new Error('Ordinary schema runtime already installed');
 ordinarySchemaGate=createOrdinarySchemaTransactionGate(startup);
 assertOwnedOrdinarySchemaTransactionGate(ordinarySchemaGate);
 const selected=new URL(databaseUrl);
 if(selected.protocol!=='postgres:'||selected.username!=='postgres'||!['127.0.0.1','localhost','[::1]'].includes(selected.hostname)||!/^\/[A-Za-z0-9_]+$/.test(selected.pathname)||selected.search!==''||selected.hash!=='')throw new Error('Ordinary construction PIM selected database mismatch');
 ordinaryConstructionPimScope={gate:ordinarySchemaGate,databaseUrl,owner:'postgres',database:selected.pathname.slice(1),port:Number(selected.port||5432),open:true,busy:false,owners:new Set()};
}
type OrdinaryConstructionPimScope={gate:OrdinarySchemaTransactionGate;databaseUrl:string;owner:'postgres';database:string;port:number;open:boolean;busy:boolean;owners:Set<pg.Client>;pending?:Promise<Readonly<{pimAvailable:boolean;nestedAvailable:boolean;orderSplitsAvailable:boolean}>>};
let ordinaryConstructionPimScope:OrdinaryConstructionPimScope|undefined;
/** Source210 availability is an actual Native check inside the existing owned
 * construction lease. A namespace fragment is corruption, never availability. */
async function preflightOrderSplitConstruction(c:pg.Client):Promise<boolean>{
 // The original PIM construction preflight keeps its own budget; only these
 // final split probes use the ordinary Native8s limit until outer ROLLBACK.
 await c.query("SET LOCAL statement_timeout TO '8s'");
 const rows=(await c.query(`SELECT
  EXISTS(SELECT FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND starts_with(c.relname,'order_split210_'))
  OR EXISTS(SELECT FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND starts_with(p.proname,'order_split210_'))
  OR EXISTS(SELECT FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND(starts_with(t.typname,'order_split210_') OR starts_with(t.typname,'_order_split210_')))
  OR EXISTS(SELECT FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_namespace n ON n.oid=k.connamespace WHERE n.nspname='public' AND starts_with(k.conname,'order_split210_'))
  OR EXISTS(SELECT FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND starts_with(t.tgname,'order_split210_')) AS present,
  to_regclass('public.order_split210_manifest')::text AS manifest,
  to_regprocedure('public.order_split210_valid()')::text AS guard`)).rows;
 if(rows.length!==1||Object.keys(rows[0]).sort().join('|')!=='guard|manifest|present'||typeof rows[0].present!=='boolean')throw new Error('Invalid split210 construction metadata');
 const p=rows[0];
 if(!p.present){if(p.manifest!==null||p.guard!==null)throw new Error('Partial split210 construction metadata');return false;}
 if(typeof p.manifest!=='string'||!p.manifest||typeof p.guard!=='string'||!p.guard)throw new Error('Partial split210 construction metadata');
 const current=(await c.query('SELECT public.order_split210_valid() AS available')).rows;
 if(current.length!==1||Object.keys(current[0]).join('|')!=='available'||current[0].available!==true)throw new Error('Invalid split210 Native installation');
 return true;
}
/** Construction-only owner. No caller Reader, Actor, capabilities or proof input. */
export async function preflightOrdinaryConstructionPim(statementTimeoutMs:number=120000):Promise<Readonly<{pimAvailable:boolean;nestedAvailable:boolean;orderSplitsAvailable:boolean}>|undefined>{
 const scope=ordinaryConstructionPimScope;
 if(!scope?.open)return undefined; // unchanged legacy full-pool preflights outside ordinary construction
 if(scope.busy)throw new Error('Ordinary construction PIM preflight already active');
 // This per-statement budget belongs only to the dedicated construction owner.
 // Ordinary pooled/API clients retain their independent 8s statement and lock limits.
 assert(Number.isSafeInteger(statementTimeoutMs)&&statementTimeoutMs>=8000&&statementTimeoutMs<=120000,'Ordinary construction PIM statement timeout must be an integer from 8000 to 120000 ms');
 assertOwnedOrdinarySchemaTransactionGate(scope.gate);
 scope.busy=true;
 let c:pg.Client;
 try{c=new pg.Client({connectionString:scope.databaseUrl,connectionTimeoutMillis:5000,options:`-c jit=off -c statement_timeout=${statementTimeoutMs} -c lock_timeout=8000 -c timezone=UTC`});}catch(e){scope.busy=false;throw e;}
 scope.owners.add(c);
 const pending=(async()=>{
  let failed=false,first:unknown,beginAttempted=false,lease:Awaited<ReturnType<OrdinarySchemaTransactionGate['reserve']>>|undefined,result:Readonly<{pimAvailable:boolean;nestedAvailable:boolean;orderSplitsAvailable:boolean}>|undefined;
  const failure=(e:unknown)=>{if(!failed){failed=true;first=e;}};
  try{
   await c.connect();
   const rows=(await c.query('SELECT current_user::text owner,session_user::text session_owner,current_database() database,inet_server_port() port,host(inet_server_addr()) address')).rows;
   const identity=rows[0];
   if(rows.length!==1||identity?.owner!==scope.owner||identity.session_owner!==scope.owner||identity.database!==scope.database||identity.port!==scope.port||!['127.0.0.1','::1'].includes(identity.address))throw new Error('Ordinary construction PIM owner identity mismatch');
   lease=await scope.gate.reserve(c); // genuine idle reservation before transaction/snapshot
   beginAttempted=true;await c.query('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
   await lease.enter();
   const pimAvailable=await preflightPim(c);
   const nestedAvailable=await preflightNestedPim(c,pimAvailable);
   const orderSplitsAvailable=await preflightOrderSplitConstruction(c);
   result=Object.freeze({pimAvailable,nestedAvailable,orderSplitsAvailable}); // actual complete validators; never gate=>true
  }catch(e){failure(e);}
  if(beginAttempted)try{await c.query('ROLLBACK');}catch(e){failure(e);}
  if(lease)try{await lease.close();}catch(e){failure(e);}
  try{await c.end();scope.owners.delete(c);}catch(e){failure(e);}
  if(failed)throw first;
  return result!;
 })();
 scope.pending=pending;
 try{return await pending;}finally{scope.pending=undefined;scope.busy=false;}
}
/** Synchronously seals new construction reads, then drains any owned in-flight client. */
export async function sealOrdinaryConstructionPimScope():Promise<void>{
 const scope=ordinaryConstructionPimScope;if(!scope)return;scope.open=false;
 let failed=false,first:unknown;
 if(scope.pending)try{await scope.pending;}catch(e){failed=true;first=e;}
 for(const c of scope.owners)try{await c.end();scope.owners.delete(c);}catch(e){if(!failed){failed=true;first=e;}}
 if(failed)throw first;
}

/** Server-selected metadata reads only. The database rejects DML; no writer
 * admission/context is created and no request can choose this runner. */
export async function tenantReadTx<T>(
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const c = await pool.connect();let lease:Awaited<ReturnType<OrdinarySchemaTransactionGate['reserve']>>|undefined,destroy=false,firstError:unknown;
  try {
    if(ordinarySchemaGate){try{lease=await ordinarySchemaGate.reserve(c);}catch(e){destroy=true;throw e;}}
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await c.query('SET TRANSACTION READ ONLY');
    if(lease){try{await lease.enter();}catch(e){destroy=true;throw e;}}
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
    await c.query("SET LOCAL statement_timeout='8s'");
    if(ordinarySchemaGate){
      assert(!activeOrderReadTransactions.has(c),'order-read-transaction-already-active');
      activeOrderReadTransactions.set(c,{tenantId,gate:ordinarySchemaGate,identity:Object.freeze({}),proofs:new Set()});
    }
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (e) {
    firstError=e;try{await c.query('ROLLBACK');}catch{destroy=true;}throw e;
  } finally {
    const active=activeOrderReadTransactions.get(c);
    for(const proof of active?.proofs??[])orderReadInstallationProofs.delete(proof);
    activeOrderReadTransactions.delete(c);
    let cleanup:unknown;try{await lease?.close();}catch(e){destroy=true;cleanup=e;}
    c.release(destroy);if(cleanup!==undefined&&firstError===undefined)throw cleanup;
  }
}
/** Append-only side records written beside a read (228 personal-data access register):
 * one short read-write transaction as dyna_app in the tenant, inside the ordinary schema
 * lease when that runtime is installed. No domain admission or finalisation hooks run, so
 * callers only INSERT into their own append-only tables; every other write uses tenantTx. */
export async function tenantAppendTx<T>(
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const c = await pool.connect();let lease:Awaited<ReturnType<OrdinarySchemaTransactionGate['reserve']>>|undefined,destroy=false,firstError:unknown;
  try {
    if(ordinarySchemaGate){try{lease=await ordinarySchemaGate.reserve(c);}catch(e){destroy=true;throw e;}}
    await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    if(lease){try{await lease.enter();}catch(e){destroy=true;throw e;}}
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
    await c.query("SET LOCAL statement_timeout='8s'");
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (e) {
    firstError=e;try{await c.query('ROLLBACK');}catch{destroy=true;}throw e;
  } finally {
    let cleanup:unknown;try{await lease?.close();}catch(e){destroy=true;cleanup=e;}
    c.release(destroy);if(cleanup!==undefined&&firstError===undefined)throw cleanup;
  }
}
type OrderReadTransaction={tenantId:string;gate:OrdinarySchemaTransactionGate;identity:object;proofs:Set<object>};
const activeOrderReadTransactions=new WeakMap<PoolClient,OrderReadTransaction>();
declare const orderReadInstallationBrand:unique symbol;
export type OrderReadInstallation=Readonly<{[orderReadInstallationBrand]:true}>;
const orderReadInstallationProofs=new WeakMap<object,{client:PoolClient;active:OrderReadTransaction;fact:object}>();
/** Only the actual pool client registered inside tenantReadTx can mint this fact.
 * It authenticates installation only, never an actor, order or business verdict. */
export async function prepareOrderReadInstallationInTx(c:PoolClient,tenantId:string):Promise<OrderReadInstallation|undefined>{
 const active=activeOrderReadTransactions.get(c);if(!active||active.tenantId!==tenantId)return undefined;
 assertOwnedOrdinarySchemaTransactionGate(active.gate);
 const fact=await active.gate.prepareReadInstallation(c,tenantId,active.identity);if(!fact)return undefined;
 assert(activeOrderReadTransactions.get(c)===active,'order-read-transaction-ended-during-prepare');
 const proof=Object.freeze({}) as OrderReadInstallation;orderReadInstallationProofs.set(proof,{client:c,active,fact});active.proofs.add(proof);return proof;
}
export async function consumeOrderReadInstallationInTx(c:PoolClient,tenantId:string,proof:OrderReadInstallation){
 const held=orderReadInstallationProofs.get(proof);
 assert(held&&held.client===c&&held.active.tenantId===tenantId&&activeOrderReadTransactions.get(c)===held.active,'order-read-current-private-proof-required');
 orderReadInstallationProofs.delete(proof);held.active.proofs.delete(proof);
 assertOwnedOrdinarySchemaTransactionGate(held.active.gate);
 await held.active.gate.consumeReadInstallation(c,tenantId,held.active.identity,held.fact);
}
/** Lookup-only source provenance. Only tenantTx's actual pool.connect result can be registered.
 * No caller token/configuration/function can register a client. */
const originalTenantPoolClients187=new WeakMap<object,{tenantId:string;work:unknown}>();
export function requireOriginalTenantPoolLease187(c:object,tenantId:string):object{
 const issued=originalTenantPoolClients187.get(c);assert(issued&&issued.tenantId===tenantId,'epoch187-original-managed-pool-client');return issued;
}
export function requireOriginalTenantPoolClient187(c:object,tenantId:string){
 const lease=requireOriginalTenantPoolLease187(c,tenantId);
 const selected=new URL(databaseUrl);assert(selected.protocol==='postgres:'&&selected.username==='postgres'&&/^\/[A-Za-z0-9_]+$/.test(selected.pathname)&&selected.search===''&&selected.hash==='','epoch187-original-pool-selected-database');
 return Object.freeze({tenantId,database:selected.pathname.slice(1),port:Number(selected.port||5432),lease,gate:ordinarySchemaGate});
}
type ActiveManagedSchemaTransaction=Readonly<{tenantId:string;gate:OrdinarySchemaTransactionGate;identity:object;installation?:object}>;
const activeManagedSchemaTransactions=new WeakMap<PoolClient,ActiveManagedSchemaTransaction>();
/** Private mint, reached only by tenantTx's genuine acquired and entered pool client. */
async function beginActiveManagedSchemaTransaction(c:PoolClient,tenantId:string,gate:OrdinarySchemaTransactionGate|undefined,prepareInstallation=false){
 if(!gate)return;
 assertOwnedOrdinarySchemaTransactionGate(gate);
 assert(!activeManagedSchemaTransactions.has(c),'managed-schema-transaction-already-active');
 const installation=prepareInstallation?await gate.prepareInstallation(c,tenantId):undefined;
 activeManagedSchemaTransactions.set(c,Object.freeze({tenantId,gate,identity:Object.freeze({}),installation}));
}
/** Lookup only: no caller can register a client or supply a READY boolean. */
export function inspectActiveManagedSchemaTransaction(c:PoolClient,tenantId:string){
 const held=activeManagedSchemaTransactions.get(c);
 return held?.tenantId===tenantId?held:undefined;
}
/** Lookup-only installation proof, never an Actor/policy/data verdict. */
export async function inspectActiveManagedInstallation(c:PoolClient,tenantId:string){
 const held=inspectActiveManagedSchemaTransaction(c,tenantId);if(!held?.installation)return undefined;
 await held.gate.verifyInstallation(c,tenantId,held.installation);
 return Object.freeze({buyer:true as const,catalog:true as const});
}
const acknowledgedTenantRollbacks = new WeakMap<object, {tenantId: string; work: unknown}>();
/** Read-only provenance from this module's actual pre-COMMIT rollback. */
export function hasAcknowledgedTenantRollback(error: unknown, tenantId: string, work: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const proof = acknowledgedTenantRollbacks.get(error);
  return !!proof && proof.tenantId === tenantId && proof.work === work;
}
/** Without the startup gate (source/dev/test) every tenantTx runs the full schema validators.
 * They get the gated startup's 120 s budget (preflightOrdinaryConstructionPim) on one short
 * owner READ ONLY transaction, released before the tenant client is borrowed. SET LOCAL ends
 * with the transaction, so tenant work keeps its 8 s statement and lock limits. Not cached. */
async function preflightUngatedTenantSchema(){
  const c = await pool.connect();let destroy=false;
  try {
    await c.query('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
    await c.query("SET LOCAL statement_timeout='120s'");
    const pimAvailable = await preflightPim(c);
    const nestedCatalogAvailable = await preflightNestedPim(c,pimAvailable);
    const physicalWzAvailable = await preflightPhysicalParcelWz(c);
    const operationalAvailable = await preflightOperationalDeliveryConsumers(c);
    await c.query('COMMIT');
    return {pimAvailable,nestedCatalogAvailable,physicalWzAvailable,operationalAvailable};
  } catch (e) {
    try{await c.query('ROLLBACK');}catch{destroy=true;}throw e;
  } finally {
    c.release(destroy);
  }
}
export async function tenantTx<T>(
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>,
  options: { wmsAdmission?: WmsAdmission; purchasingAdmission?: boolean; catalogStockControlAdmission?: 'shared' | 'activation' } = {},
): Promise<T> {
  // Private installation metadata is checked before borrowing the transaction
  // client; no second pooled connection is acquired while tenant locks are held.
  const gate=ordinarySchemaGate;
  const {pimAvailable,nestedCatalogAvailable,physicalWzAvailable,operationalAvailable} = gate
    ?{pimAvailable:true,nestedCatalogAvailable:true,physicalWzAvailable:true,operationalAvailable:true}
    :await preflightUngatedTenantSchema();
  const c = await pool.connect();
  // This private ledger is created only for the actual borrowed normal-pool client.
  // Active original187 never falls through to the legacy transaction on rejection.
  originalTenantPoolClients187.set(c,Object.freeze({tenantId,work:fn}));
  let durable:Promise<T>|undefined;
  try{durable=runBoundDurableTenantTransaction187(c,tenantId,async()=>{
   try{
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
    await c.query("SET LOCAL statement_timeout='8s'");
    beginPimTransaction(c,pimAvailable,gate);
    beginCatalogAttributesTransaction(c,nestedCatalogAvailable);
    beginFinancialReturn162Transaction(c);
    beginCompetitorObservationTransaction(c);
    beginBuyerAddressTransaction(c);
    beginOperationalDeliveryTransaction(c, operationalAvailable);
    beginPhysicalParcelWzTransaction(c,physicalWzAvailable);
    beginInventoryCorrectionTransaction(c);
    beginWmsTransaction(c);
    beginPurchasingTransaction(c);
    beginDispatchTransaction(c);
    beginCatalogStockControlTransaction(c);
    beginAllegroAuthorityTransaction(c);
    beginMiraklSessionAuthorityTransaction(c);
    await beginActiveManagedSchemaTransaction(c,tenantId,gate);
    beginOrderSplitTransaction(c);
    await wmsLotsAdmissionInTx(c, { tenantId }, options.wmsAdmission ?? 'shared');
    if (options.purchasingAdmission) await purchasingSourceAdmissionInTx(c, { tenantId });
    else await purchasingStockAdmissionInTx(c, { tenantId });
    // Freeze catalog stock-control lifecycle before any caller source/stock lock.
    await catalogStockControlAdmissionInTx(c, { tenantId }, options.catalogStockControlAdmission ?? 'shared');
    const result = await fn(c);
    assertOrderSplitCompositionInTx(c);
    // Pin the full PIM source/identity before any persistent constraint drain.
    const pimStarted = await preparePimTransactionInTx(c);
    if (pimStarted) await drainPublicConstraintsInTx(c);
    await finalizeWmsActorsInTx(c);
    await finalizeCatalogStockControlActorsInTx(c);
    await finalizeDispatchActorsInTx(c);
    await finalizeCatalogStockCountTerminalInTx(c);
    // Last clock follows every sibling constraint/hydration/IAM wait.
    await prepareMiraklSessionAuthoritiesInTx(c);
    await prepareInventoryCorrectionFinalizationInTx(c);
    await preparePhysicalParcelWzFinalizationInTx(c);
    await finalizeAllegroAuthoritiesInTx(c);
    await finalizeFinancialReturn162InTx(c);
    await finalizeCompetitorObservationAuthoritiesInTx(c);
    await finalizeBuyerAddressInTx(c);
    // Operational receiver authority/source/clock follows every sibling wait.
    await finalizeOperationalDeliveryInTx(c);
    await finalizePhysicalParcelWzInTx(c);
    // No lock/source/constraint wait follows this public correction clock gate.
    await finalizeInventoryCorrectionClockInTx(c);
    // Only no-wait native deadline gates follow the complete sibling waits.
    await finalizePimTransactionInTx(c);
    await finalizeMiraklSessionAuthoritiesInTx(c);
    return result;
   }finally{
    activeManagedSchemaTransactions.delete(c);
    endPimTransaction(c);
    endCatalogAttributesTransaction(c);
    endFinancialReturn162Transaction(c);
    endCompetitorObservationTransaction(c);
    endBuyerAddressTransaction(c);
    endOperationalDeliveryTransaction(c);
    endPhysicalParcelWzTransaction(c);
    endInventoryCorrectionTransaction(c);
    endWmsTransaction(c);
    endPurchasingTransaction(c);
    endDispatchTransaction(c);
    endCatalogStockControlTransaction(c);
    endAllegroAuthorityTransaction(c);
    endMiraklSessionAuthorityTransaction(c);
   }
  });}catch(e){endOrderSplitTransaction(c);activeManagedSchemaTransactions.delete(c);originalTenantPoolClients187.delete(c);try{c.release(true);}catch{/* preserve original synchronous dispatch/guard error */}throw e;}
  if(durable){let failed=false,first:unknown;
   try{return await durable;}catch(e){failed=true;first=e;if(e&&typeof e==='object'){acknowledgedTenantRollbacks.delete(e);if(hasAcknowledgedDurableWorkerRollback187(e,c))acknowledgedTenantRollbacks.set(e,{tenantId,work:fn});}throw e;}
   finally{endOrderSplitTransaction(c);activeManagedSchemaTransactions.delete(c);originalTenantPoolClients187.delete(c);try{c.release(isDurableWorkerClientTainted187(c));}catch(e){if(!failed)throw e;/* preserve original business/transport error */}}
  }
  originalTenantPoolClients187.delete(c);
  let commitAttempted = false,destroy=false,firstError:unknown,lease:Awaited<ReturnType<OrdinarySchemaTransactionGate['reserve']>>|undefined;
  try {
    if(gate){try{lease=await gate.reserve(c);}catch(e){destroy=true;throw e;}}
    await c.query('BEGIN');
    if(lease){try{await lease.enter();}catch(e){destroy=true;throw e;}}
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
    await c.query("SET LOCAL statement_timeout='8s'");
    beginPimTransaction(c,pimAvailable,gate);
    beginCatalogAttributesTransaction(c,nestedCatalogAvailable);
    beginFinancialReturn162Transaction(c);
    beginCompetitorObservationTransaction(c);
    beginBuyerAddressTransaction(c);
    beginOperationalDeliveryTransaction(c, operationalAvailable);
    beginPhysicalParcelWzTransaction(c,physicalWzAvailable);
    beginInventoryCorrectionTransaction(c);
    beginWmsTransaction(c);
    beginPurchasingTransaction(c);
    beginDispatchTransaction(c);
    beginCatalogStockControlTransaction(c);
    beginAllegroAuthorityTransaction(c);
    beginMiraklSessionAuthorityTransaction(c);
    await beginActiveManagedSchemaTransaction(c,tenantId,gate,true);
    beginOrderSplitTransaction(c);
    await wmsLotsAdmissionInTx(c, { tenantId }, options.wmsAdmission ?? 'shared');
    if (options.purchasingAdmission) await purchasingSourceAdmissionInTx(c, { tenantId });
    else await purchasingStockAdmissionInTx(c, { tenantId });
    // Freeze catalog stock-control lifecycle before any caller source/stock lock.
    await catalogStockControlAdmissionInTx(c, { tenantId }, options.catalogStockControlAdmission ?? 'shared');
    const result = await fn(c);
    assertOrderSplitCompositionInTx(c);
    // Pin the full PIM source/identity before any persistent constraint drain.
    const pimStarted = await preparePimTransactionInTx(c);
    if (pimStarted) await drainPublicConstraintsInTx(c);
    await finalizeWmsActorsInTx(c);
    await finalizeCatalogStockControlActorsInTx(c);
    await finalizeDispatchActorsInTx(c);
    await finalizeCatalogStockCountTerminalInTx(c);
    // Last clock follows every sibling constraint/hydration/IAM wait.
    await prepareMiraklSessionAuthoritiesInTx(c);
    await prepareInventoryCorrectionFinalizationInTx(c);
    await preparePhysicalParcelWzFinalizationInTx(c);
    await finalizeAllegroAuthoritiesInTx(c);
    await finalizeFinancialReturn162InTx(c);
    await finalizeCompetitorObservationAuthoritiesInTx(c);
    await finalizeBuyerAddressInTx(c);
    // Operational receiver authority/source/clock follows every sibling wait.
    await finalizeOperationalDeliveryInTx(c);
    await finalizePhysicalParcelWzInTx(c);
    // No lock/source/constraint wait follows this public correction clock gate.
    await finalizeInventoryCorrectionClockInTx(c);
    // Only no-wait native deadline gates follow the complete sibling waits.
    await finalizePimTransactionInTx(c);
    await finalizeMiraklSessionAuthoritiesInTx(c);
    // Split's fixed current-request boundary follows ALL sibling work and the
    // complete public drain, even when this transaction never started PIM.
    if(hasOrderSplitTransactionDuty(c)){
      await drainPublicConstraintsInTx(c);
      await finalizeOrderSplitTransactionInTx(c);
    }
    // Work under a session advisory lock (holdingDbLock) commits only while that lock is still held.
    await assertDbLocksHeldInTx(c);
    commitAttempted = true;
    await c.query('COMMIT');
    return result;
  } catch (e) {
    if (e && typeof e === 'object') acknowledgedTenantRollbacks.delete(e);
    firstError=e;let rollbackAck=false;try{await c.query('ROLLBACK');rollbackAck=true;}catch{destroy=true;}
    if (rollbackAck && !commitAttempted && e && typeof e === 'object')
      acknowledgedTenantRollbacks.set(e, {tenantId, work: fn});
    throw e;
  } finally {
    endOrderSplitTransaction(c);
    activeManagedSchemaTransactions.delete(c);
    endPimTransaction(c);
    endCatalogAttributesTransaction(c);
    endFinancialReturn162Transaction(c);
    endCompetitorObservationTransaction(c);
    endBuyerAddressTransaction(c);
    endOperationalDeliveryTransaction(c);
    endPhysicalParcelWzTransaction(c);
    endInventoryCorrectionTransaction(c);
    endWmsTransaction(c);
    endPurchasingTransaction(c);
    endDispatchTransaction(c);
    endCatalogStockControlTransaction(c);
    endAllegroAuthorityTransaction(c);
    endMiraklSessionAuthorityTransaction(c);
    let cleanup:unknown;try{await lease?.close();}catch(e){destroy=true;cleanup=e;}
    c.release(destroy);if(cleanup!==undefined&&firstError===undefined)throw cleanup;
  }
}
let lastBackup: MigrationBackupReceipt | undefined;
/** The backup the last migrate() of this process took before applying migrations (MIG-3), if any. */
export async function migrate(options: { lockWaitMs?: number } = {}) {
  // MIG-3 settings are read before connecting: an invalid setting never reaches the database.
  const backupSettings = migrationBackupSettings(), target = new URL(databaseUrl);
  // Controlled owner DDL has its own finite budget and never lends a client to HTTP.
  // Ordinary pool and cold generation approval retain their separate 8s limits.
  const c = new pg.Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5000,
    options: "-c jit=off -c statement_timeout=120000 -c lock_timeout=8000 -c timezone=UTC",
  });
  let connected = false;
  let firstError: unknown;
  const program: [string, string][] = [];
  // MIG-2: the program's executed files, read at most once and only when the checksum register exists.
  let programFiles: Promise<MigrationProgramFile[]> | undefined;
  const checksumFiles = () => (programFiles ??= migrationProgramFiles(program, (file) => readRuntimeResource('sql:server/' + file, import.meta.url)));
  try {
    await c.connect();
    connected = true;
    // Literal pairs up to 209; every later migration comes from the one release list
    // (migration-manifest.mjs, see docs/parity/MIGRATIONS-S1-20261026.md).
    // MIG-1: one transaction for the whole pending series under the 982376 fence; a second instance waits for it.
    await c.query('BEGIN');
    await acquireMigrationLock(c, options.lockWaitMs);
    await ensureMigrationRegistry(c);
    for (const [name, file] of [
      ['001_foundation', './schema.sql'],
      ['002_imports', './002_imports.sql'],
      ['003_sync', './003_sync.sql'],
      ['004_catalog', './004_catalog.sql'],
      ['005_warehouse', './005_warehouse.sql'],
      ['006_offers', './006_offers.sql'],
      ['007_offer_indexes', './007_offer_indexes.sql'],
      ['008_shipping', './008_shipping.sql'],
      ['009_invoices', './009_invoices.sql'],
      ['010_operations', './010_operations.sql'],
      ['011_automation_chain_index', './011_automation_chain_index.sql'],
      ['012_workspaces', './012_workspaces.sql'],
      ['013_developer_api', './013_developer_api.sql'],
      ['014_returns', './014_returns.sql'],
      ['015_buyer_portal', './015_buyer_portal.sql'],
      ['016_pricing', './016_pricing.sql'],
      ['017_offer_sync', './017_offer_sync.sql'],
      ['018_catalog_sources', './018_catalog_sources.sql'],
      ['019_variable_offers', './019_variable_offers.sql'],
      ['020_tracking', './020_tracking.sql'],
      ['021_purchasing', './021_purchasing.sql'],
      ['022_order_status', './022_order_status.sql'],
      ['023_payments', './023_payments.sql'],
      ['024_source_payments', './024_source_payments.sql'],
      ['025_stock_locations', './025_stock_locations.sql'],
      ['026_automation_schedules', './026_automation_schedules.sql'],
      ['027_sms', './027_sms.sql'],
      ['028_sms_automations', './028_sms_automations.sql'],
      ['029_stocktakes', './029_stocktakes.sql'],
      ['030_supplier_catalog', './030_supplier_catalog.sql'],
      ['031_supplier_bulk', './031_supplier_bulk.sql'],
      ['032_supplier_schedules', './032_supplier_schedules.sql'],
      ['033_repricing', './033_repricing.sql'],
      ['034_repricing_schedules', './034_repricing_schedules.sql'],
      ['035_allegro_batches', './035_allegro_batches.sql'],
      ['036_dpd_collections', './036_dpd_collections.sql'],
      ['037_dpd_pickup_schedules', './037_dpd_pickup_schedules.sql'],
      ['038_b2b', './038_b2b.sql'],
      ['039_b2b_network', './039_b2b_network.sql'],
      ['040_b2b_network_orders', './040_b2b_network_orders.sql'],
      ['041_b2b_network_returns', './041_b2b_network_returns.sql'],
      ['042_odoo_invoice_exports', './042_odoo_invoice_exports.sql'],
      ['043_odoo_catalog_sync', './043_odoo_catalog_sync.sql'],
      ['044_odoo_invoice_files', './044_odoo_invoice_files.sql'],
      ['045_odoo_image_imports', './045_odoo_image_imports.sql'],
      ['046_ebay_fulfillment', './046_ebay_fulfillment.sql'],
      ['047_ebay_accounts', './047_ebay_accounts.sql'],
      ['048_ebay_fulfillment_schedules', './048_ebay_fulfillment_schedules.sql'],
      ['049_ebay_revision_budget', './049_ebay_revision_budget.sql'],
      ['050_ebay_api_limits', './050_ebay_api_limits.sql'],
      ['051_account_security', './051_account_security.sql'],
      ['052_amazon_api_limits', './052_amazon_api_limits.sql'],
      ['053_amazon_catalog', './053_amazon_catalog.sql'],
      ['054_amazon_offers', './054_amazon_offers.sql'],
      ['055_amazon_oauth', './055_amazon_oauth.sql'],
      ['056_integration_workspace', './056_integration_workspace.sql'],
      ['057_workspace_mfa', './057_workspace_mfa.sql'],
      ['058_picking_waves', './058_picking_waves.sql'],
      ['059_amazon_fulfillment', './059_amazon_fulfillment.sql'],
      ['060_password_recovery', './060_password_recovery.sql'],
      ['061_email', './061_email.sql'],
      ['062_email_actions', './062_email_actions.sql'],
      ['063_email_attachments', './063_email_attachments.sql'],
      ['064_shopify_fulfillment', './064_shopify_fulfillment.sql'],
      ['065_shopify_oauth', './065_shopify_oauth.sql'],
      ['066_shopify_webhooks', './066_shopify_webhooks.sql'],
      ['067_shopify_subscriptions', './067_shopify_subscriptions.sql'],
      ['068_workspace_billing', './068_workspace_billing.sql'],
      ['069_prestashop_status', './069_prestashop_status.sql'],
      ['070_catalog_ai', './070_catalog_ai.sql'],
      ['071_deepl', './071_deepl.sql'],
      ['072_deepl_batches', './072_deepl_batches.sql'],
      ['073_shopify_translations', './073_shopify_translations.sql'],
      ['074_shopify_translation_batches', './074_shopify_translation_batches.sql'],
      ['075_customer_messages', './075_customer_messages.sql'],
      ['076_product_rules', './076_product_rules.sql'],
      ['077_payment_imports', './077_payment_imports.sql'],
      ['078_order_fields', './078_order_fields.sql'],
      ['079_order_field_batches', './079_order_field_batches.sql'],
      ['080_order_field_mappings', './080_order_field_mappings.sql'],
      ['081_customer_message_workflows', './081_customer_message_workflows.sql'],
      ['082_catalog_bulk_edit', './082_catalog_bulk_edit.sql'],
      ['083_product_logistics', './083_product_logistics.sql'],
      ['084_product_logistics_recovery', './084_product_logistics_recovery.sql'],
      ['085_product_sku', './085_product_sku.sql'],
      ['086_inventory_bulk_edit', './086_inventory_bulk_edit.sql'],
      ['087_price_bulk_edit', './087_price_bulk_edit.sql'],
      ['088_product_translation_bulk_edit', './088_product_translation_bulk_edit.sql'],
      ['089_packing_workstation', './089_packing_workstation.sql'],
      ['090_wms_lots', './090_wms_lots.sql'],
      ['091_wms_lot_packing', './091_wms_lot_packing.sql'],
      ['092_wms_stocktakes', './092_wms_stocktakes.sql'],
      ['093_wms_validation_scopes', './093_wms_validation_scopes.sql'],
      ['094_wms_stocktake_scans', './094_wms_stocktake_scans.sql'],
      ['095_stocktake_scan_recovery', './095_stocktake_scan_recovery.sql'],
      ['096_catalog_export_profiles', './096_catalog_export_profiles.sql'],
      ['097_catalog_export_sources', './097_catalog_export_sources.sql'],
      ['098_catalog_file_imports', './098_catalog_file_imports.sql'],
      ['099_replenishment_plans', './099_replenishment_plans.sql'],
      ['100_replenishment_forecast', './100_replenishment_forecast.sql'],
      ['101_replenishment_append', './101_replenishment_append.sql'],
      ['102_replenishment_automations', './102_replenishment_automations.sql'],
      ['103_order_merges', './103_order_merges.sql'],
      ['104_order_merge_custody', './104_order_merge_custody.sql'],
      ['105_order_merge_guards', './105_order_merge_guards.sql'],
      ['106_order_source_lines', './106_order_source_lines.sql'],
      ['107_shopify_source_fulfillment', './107_shopify_source_fulfillment.sql'],
      ['108_b2b_dropshipping', './108_b2b_dropshipping.sql'],
      ['109_b2b_external_order_intents', './109_b2b_external_order_intents.sql'],
      ['110_b2b_external_order_imports', './110_b2b_external_order_imports.sql'],
      ['111_b2b_dropshipping_returns', './111_b2b_dropshipping_returns.sql'],
      ['112_b2b_return_local_origins', './112_b2b_return_local_origins.sql'],
      ['113_price_file_imports', './113_price_file_imports.sql'],
      ['114_price_matrix_imports', './114_price_matrix_imports.sql'],
      ['115_stock_file_imports', './115_stock_file_imports.sql'],
      ['116_stock_file_import_validation', './116_stock_file_import_validation.sql'],
      ['117_language_file_imports', './117_language_file_imports.sql'],
      ['118_supplier_file_sources', './118_supplier_file_sources.sql'],
      ['119_supplier_remote_feeds', './119_supplier_remote_feeds.sql'],
      ['120_return_exchanges', './120_return_exchanges.sql'],
      ['121_return_exchange_frame_scope', './121_return_exchange_frame_scope.sql'],
      ['122_return_exchange_hashes', './122_return_exchange_hashes.sql'],
      ['123_return_exchange_substitutions', './123_return_exchange_substitutions.sql'],
      ['124_payment_import_allocations', './124_payment_import_allocations.sql'],
      [
        '125_payment_import_allocation_source_projection',
        './125_payment_import_allocation_source_projection.sql',
      ],
      [
        '126_payment_import_allocation_cod_balances',
        './126_payment_import_allocation_cod_balances.sql',
      ],
      ['127_proformas', './127_proformas.sql'],
      ['128_proforma_batches', './128_proforma_batches.sql'],
      ['129_print_jobs', './129_print_jobs.sql'],
      ['130_shipment_label_prints', './130_shipment_label_prints.sql'],
      ['131_shipment_label_cache', './131_shipment_label_cache.sql'],
      ['132_shipment_label_batches', './132_shipment_label_batches.sql'],
      ['133_order_shipments', './133_order_shipments.sql'],
      ['134_order_parcels', './134_order_parcels.sql'],
      ['135_order_parcel_completion_fix', './135_order_parcel_completion_fix.sql'],
      ['136_order_parcel_commercial_origins', './136_order_parcel_commercial_origins.sql'],
      ['137_order_parcel_releases', './137_order_parcel_releases.sql'],
      ['138_order_parcel_returns', './138_order_parcel_returns.sql'],
      ['139_return_assistant', './139_return_assistant.sql'],
      ['140_return_assistant_queues', './140_return_assistant_queues.sql'],
      ['141_email_inbound', './141_email_inbound.sql'],
      ['142_product_catalogs', './142_product_catalogs.sql'],
      ['143_catalog_export_catalogs', './143_catalog_export_catalogs.sql'],
      ['144_b2b_catalog_scopes', './144_b2b_catalog_scopes.sql'],
      ['145_order_merge_counters', './145_order_merge_counters.sql'],
      ['146_warehouse_inventory_policies', './146_warehouse_inventory_policies.sql'],
      ['147_return_destination_statuses', './147_return_destination_statuses.sql'],
      ['148_return_destinations', './148_return_destinations.sql'],
      ['149_stocktake_adjustments', './149_stocktake_adjustments.sql'],
      ['150_warehouse_automatic_wz', './150_warehouse_automatic_wz.sql'],
      ['151_warehouse_wz_issuer', './151_warehouse_wz_issuer.sql'],
      ['152_catalog_stock_control', './152_catalog_stock_control.sql'],
      ['153_allegro_oauth_recovery', './153_allegro_oauth_recovery.sql'],
      ['154_product_rule_price_tags', './154_product_rule_price_tags.sql'],
      ['155_product_rule_schedules', './155_product_rule_schedules.sql'],
      ['156_packed_label_print', './156_packed_label_print.sql'],
      ['157_local_invoices', './157_local_invoices.sql'],
      ['158_fa3_draft_native', './158_fa3_draft_native.sql'],
      ['159_b2b_invoice', './159_b2b_invoice.sql'],
      ['160_b2b_credit', './160_b2b_credit.sql'],
      ['161_credit_source', './161_credit_source.sql'],
      ['162_financial_return', './162_financial_return.sql'],
      ['163_competitor_observations', './163_competitor_observations.sql'],
      ['164_competitor_observation_batch_scale', './164_competitor_observation_batch_scale.sql'],
      ['165_competitor_observation_portability', './165_competitor_observation_portability.sql'],
      ['166_buyer_address_sidecar', './166_buyer_address_sidecar.sql'],
      ['167_operational_delivery_consumers', './167_operational_delivery_consumers.sql'],
      ['168_physical_parcel_wz', './168_physical_parcel_wz.sql'],
      ['169_manual_inventory_off', './169_manual_inventory_off.sql'],
      ['170_pim_dictionaries', './170_pim_dictionaries.sql'],
      ['171_pim_physical_cooperation', './171_pim_physical_cooperation.sql'],
      ['172_pim_nested_json', './172_pim_nested_json.sql'],
      ['173_large_catalog_import_birth', './173_large_catalog_import_birth.sql'],
      ['174_packing_photos', './174_packing_photos.sql'],
      ['175_integration_verification_history_index', './175_integration_verification_history_index.sql'],
      ['176_product_image_library_indexes', './176_product_image_library_indexes.sql'],
      ['177_picking_wave_print', './177_picking_wave_print.sql'],
      ['178_large_import_wave_print_compatibility', './178_large_import_wave_print_compatibility.sql'],
      ['179_shared_manual_guard_dag', './179_shared_manual_guard_dag.sql'],
      ['180_consistent_history_guard_dag', './180_consistent_history_guard_dag.sql'],
      ['181_same_root_guard_observations', './181_same_root_guard_observations.sql'],
      ['182_cold_schema_runtime_admission', './182_cold_schema_runtime_admission.sql'],
      ['183_original_key_recovery', './183_original_key_recovery.sql'],
      ['184_ordinary_schema_admission', './184_ordinary_schema_admission.sql'],
      ['185_private_keeper_generation', './185_private_keeper_generation.sql'],
      ['186_core_review_alias_binding', './186_core_review_alias_binding.sql'],
      ['187_durable_original_writer_epoch', './187_durable_original_writer_epoch.sql'],
      ['188_local_consumer_credit', './188_local_consumer_credit.sql'],
      ['198_original_keeper_resource_context', './198_original_keeper_resource_context.sql'],
      ['189_packing_required_order_fields', './189_packing_required_order_fields.sql'],
      ['200_sms_delivery_submission', './200_sms_delivery_submission.sql'],
      ['201_complete_history_empty_bootstrap', './201_complete_history_empty_bootstrap.sql'],
      ['202_owned_business_quota_expiry_renewal', './202_owned_business_quota_expiry_renewal.sql'],
      ['203_known_partial_core_quota_renewal', './203_known_partial_core_quota_renewal.sql'],
      ['204_partial_commercial_sale_scope', './204_partial_commercial_sale_scope.sql'],
      ['205_header_metadata_projection', './205_header_metadata_projection.sql'],
      ['206_return_credit_destinations_history', './206_return_credit_destinations_history.sql'],
      ['207_consumer_return_credit', './207_consumer_return_credit.sql'],
      ['208_consumer_return_credit_guard_dedup', './208_consumer_return_credit_guard_dedup.sql'],
      ['209_order_merge_delivery_inheritance', './209_order_merge_delivery_inheritance.sql'],
      ...RELEASE_MIGRATION_PROGRAM,
    ]) { program.push([name, file]); }
    // MIG-6: a database migrated by a newer release is refused before anything is applied.
    await assertLedgerKnownToRelease(c, program.map(([name]) => name));
    // MIG-2: an applied migration whose file changed since it was recorded is refused the same way (migration 244).
    await assertMigrationChecksums(c, checksumFiles);
    // MIG-3: pending migrations on an existing history are applied only after a successful local backup.
    const applied = new Set((await c.query('SELECT name FROM migrations')).rows.map((r) => r.name as string));
    lastBackup = await backupBeforeMigrating({ applied: applied.size, pending: program.map(([name]) => name).filter((name) => !applied.has(name)), settings: backupSettings, target: { database: target.pathname.slice(1), port: Number(target.port || 5432) } });
    for (const [name, file] of program) {
      const done = await c.query('SELECT 1 FROM migrations WHERE name=$1', [name]);
      if (!done.rowCount) try {
        await c.query((await readRuntimeResource('sql:server/' + file.slice(2), import.meta.url)).toString('utf8'));
        if (name === '198_original_keeper_resource_context')
          await c.query((await readRuntimeResource('sql:server/199_keeper_private_cold.sql', import.meta.url)).toString('utf8'));
        if (name === '188_local_consumer_credit')
          await c.query((await readRuntimeResource('sql:server/188_consumer_credit_structure.sql', import.meta.url)).toString('utf8'));
        if (name === '092_wms_stocktakes')
          await c.query(
            (await readRuntimeResource('sql:server/wms-stocktake-invariants.sql', import.meta.url)).toString('utf8'),
          );
        if (name === '108_b2b_dropshipping')
          await c.query(
            (await readRuntimeResource('sql:server/108_b2b_dropship_dispatch.sql', import.meta.url)).toString('utf8'),
          );
        await c.query('INSERT INTO migrations(name) VALUES($1)', [name]);
      } catch (e) {
        // MIG-1: the series is one transaction, so a failure of any migration rolls all of them back (catch below).
        throw new MigrationFailedError(name, file.slice(2), program.map(([n]) => n).filter((n) => !applied.has(n)), e);
      }
    }
    // MIG-2: every executed file without a record gets one before the series commits.
    await recordMigrationChecksums(c, checksumFiles, applied);
    await c.query('COMMIT');
  } catch (e) {
    firstError = e;
    if (connected) try { await c.query('ROLLBACK'); } catch { /* Original migration refusal is primary. */ }
    throw e;
  } finally {
    try { await c.end(); } catch (closeError) { if (firstError === undefined) throw closeError; }
  }
}
export function lastMigrationBackup(): MigrationBackupReceipt | undefined { return lastBackup; }
