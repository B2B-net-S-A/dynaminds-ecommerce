import {assertOwnedOrdinarySchemaTransactionGate,type OrdinarySchemaTransactionGate} from '../../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/runtime-api';
import { drainPublicConstraintsInTx } from '../public-constraint-drain';
/** Import-safe managed lifecycle. Root must preflight before borrowing a pool
 * connection, begin immediately after BEGIN/scoping, prepare after all sibling
 * waits, then execute only no-lock sibling clocks/PIM LAST followed by COMMIT. */
import type {Client,PoolClient} from 'pg';
import {Problem} from '../errors';
type Reader=Pick<Client|PoolClient,'query'>;
const transactions=new WeakMap<PoolClient,{available:boolean;prepared:boolean;started:boolean;generation?:OrdinarySchemaTransactionGate}>();
/** Presence only; never authorization, admission or transaction readiness. */
export function hasPimTransactionDuty(c:PoolClient){return Boolean(transactions.get(c)?.started);}
export async function preflightPim(owner:Reader):Promise<boolean>{
 const own=(await owner.query("SELECT EXISTS(SELECT FROM pg_class WHERE relnamespace='public'::regnamespace AND starts_with(relname,'pim_dictionary_')) OR EXISTS(SELECT FROM pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'pim_dictionary_')) OR EXISTS(SELECT FROM pg_trigger WHERE starts_with(tgname,'pim_dictionary_')) OR EXISTS(SELECT FROM pg_constraint WHERE starts_with(conname,'pim_dictionary_')) remnants,EXISTS(SELECT FROM public.migrations WHERE name LIKE '%pim_dictionar%') ledger")).rows[0];
 if(!own.remnants&&!own.ledger)return false;
 if(!own.remnants||!own.ledger||!(await owner.query("SELECT to_regprocedure('public.pim_dictionary_valid()') IS NOT NULL present")).rows[0].present)throw new Problem(503,'Niekompletny moduł PIM');
 if((await owner.query('SELECT public.pim_dictionary_valid() valid')).rows[0].valid!==true)throw new Problem(503,'Niekompletny moduł PIM');return true;
}
export function beginPimTransaction(c:PoolClient,available:boolean,generation?:OrdinarySchemaTransactionGate){if(generation)assertOwnedOrdinarySchemaTransactionGate(generation);if(transactions.has(c))throw new Problem(503,'Powtórzony kontekst PIM');transactions.set(c,{available,prepared:false,started:false,generation});}
export function requirePimTransaction(c:PoolClient){const tx=transactions.get(c);if(!tx?.available)throw new Problem(503,'Brak zarządzanej transakcji PIM');tx.prepared=false;tx.started=true;}
/** Producer-local reset after an earlier sibling public drain. Exactly four
 * PIM completion names and five PIM deferrable FK names are reset. Private
 * LAST and all sibling constraint modes remain unchanged; managed c required. */
export async function deferPimProducerConstraintsInTx(c:PoolClient):Promise<void>{
 const tx=transactions.get(c);
 if(!tx?.available||!tx.started)throw new Problem(503,'Brak zarządzanego producenta PIM');
 tx.prepared=false;
 await c.query('SET CONSTRAINTS public."pim_dictionary_preview_complete",public."pim_dictionary_admission_complete",public."pim_dictionary_operation_complete",public."pim_dictionary_state_complete",public."pim_dictionary_admission_operation",public."pim_dictionary_head_operation",public."pim_dictionary_state_operation",public."pim_dictionary_operations_tenant_id_id_fkey",public."pim_dictionary_categories_tenant_id_catalog_id_parent_id_fkey" DEFERRED');
}
export async function preparePimTransactionInTx(c:PoolClient):Promise<boolean>{const tx=transactions.get(c);if(!tx)throw new Problem(503,'Brak kontekstu PIM');if(!tx.available)return false;
 // No context exists in unrelated ordinary transactions. Logical readonly PIM
 // reads register actual fresh authority, so they do have a temporary context.
 if(!tx.started){tx.prepared=true;return false;}
 await c.query(tx.generation?'SELECT public.ordinary184_pim_prepare()':'SELECT public.pim_dictionary_prepare()');
 await c.query('SET CONSTRAINTS pim_dictionary_preview_complete,pim_dictionary_admission_complete,pim_dictionary_operation_complete,pim_dictionary_state_complete IMMEDIATE');
 tx.prepared=true;return true;
}
export async function finalizePimTransactionInTx(c:PoolClient){const tx=transactions.get(c);if(!tx)throw new Problem(503,'Brak kontekstu PIM');if(!tx.available)return;if(!tx.prepared)throw new Problem(503,'Brak końcowego sprawdzenia PIM');
 if(tx.started)await c.query('SELECT public.pim_dictionary_last_clock()');
}
export function endPimTransaction(c:PoolClient){transactions.delete(c);}

/** Managed caller drain: private PIM commit marker remains deferred until LAST. */
export async function preparePimPublicConstraintsInTx(c:PoolClient){
 await preparePimTransactionInTx(c);
 return drainPublicConstraintsInTx(c);
}

/** Fixed managed entrypoint; request cannot choose a function name or cadence. */
export async function beginPimTransactionInTx(c:PoolClient){const tx=transactions.get(c);if(!tx?.available||!tx.started)throw new Problem(503,'Brak zarządzanego producenta PIM');await c.query(tx.generation?'SELECT public.ordinary184_pim_begin()':'SELECT public.pim_dictionary_begin()');}
