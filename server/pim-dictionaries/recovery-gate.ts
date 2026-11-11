/** Import-safe owner recovery gate. No pool/app/config/provider at import. */
import type {Client,Pool,PoolClient} from 'pg';
import {ensure} from '../errors';
import {preflightPim} from './runtime';
import {validateRecoveredPim} from './recovery';
type Reader=Pick<Client|PoolClient,'query'>;
export type RecoveredPimCounts={available:boolean;previews:number;operations:number};
/** Existing restore owns this RRRO transaction; this helper never commits it.
 * Genuine pre170 absence is neutral; ledger-only or partial remnants fail closed.
 * These are semantic plaintext records, not AES envelope count increments. */
export async function validateRecoveredPimIfAvailableInTx(c:Reader):Promise<RecoveredPimCounts>{
 const ctx=(await c.query("SELECT current_user=session_user AS owner,current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS readonly,current_setting('TimeZone') AS zone")).rows[0];
 ensure(ctx.owner===true&&ctx.isolation==='repeatable read'&&ctx.readonly==='on'&&ctx.zone==='UTC',503,'Walidacja odtworzonego PIM wymaga transakcji właściciela RR READ ONLY UTC');
 if(!await preflightPim(c))return{available:false,previews:0,operations:0};
 return{available:true,...await validateRecoveredPim(c)};
}
/** Run before exposing a readonly app. It borrows one owner connection outside
 * any tenant transaction and releases it on every acquired-client path. */
export async function validateRecoveredPimBeforeReadonly(owner:Pick<Pool,'connect'>):Promise<RecoveredPimCounts>{
 const c=await owner.connect();let discard=false;
 try{
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await c.query("SET LOCAL TimeZone='UTC'");
  const result=await validateRecoveredPimIfAvailableInTx(c);
  await c.query('COMMIT');
  return result;
 }catch(error){
  // Preserve the first native semantic error if PostgreSQL already aborted.
  try{await c.query('ROLLBACK');}catch{discard=true;/* Original error remains authoritative; discard the unsafe connection. */}
  throw error;
 }finally{c.release(discard);}
}
