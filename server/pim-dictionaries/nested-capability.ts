/** Owner-pool startup metadata gate only. Never grant app-role access to private172 helpers. */
import type {Client,PoolClient} from 'pg';
import {Problem} from '../errors';
type OwnerReader=Pick<Client|PoolClient,'query'>;
const absent=()=>new Problem(503,'Obsługa zagnieżdżonych parametrów jest niekompletna.');
export async function preflightNestedPim(ownerReader:OwnerReader,pimAvailable:boolean):Promise<boolean>{
 try{
  // Include stray relations/indexes/types/functions/triggers/constraints/policies; the leaf
  // certifies exact current attributes. A near172 ledger marker is torn, never absence.
  const row=(await ownerReader.query(`SELECT
   EXISTS(SELECT FROM pg_class WHERE relnamespace='public'::regnamespace AND starts_with(relname,'nested172_'))
   OR EXISTS(SELECT FROM pg_type WHERE typnamespace='public'::regnamespace AND starts_with(typname,'nested172_'))
   OR EXISTS(SELECT FROM pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'nested172_'))
   OR EXISTS(SELECT FROM pg_trigger WHERE starts_with(tgname,'nested172_'))
   OR EXISTS(SELECT FROM pg_constraint WHERE starts_with(conname,'nested172_'))
   OR EXISTS(SELECT FROM pg_policy WHERE starts_with(polname,'nested172_')) remnants,
   (SELECT count(*)::integer FROM public.migrations WHERE name LIKE '172%') marker_count,
   (SELECT count(*)::integer FROM public.migrations WHERE name='172_pim_nested_json') ledger_count,
   to_regclass('public.nested172_certificate') IS NOT NULL certificate_present,
   to_regprocedure('public.nested172_valid()') IS NOT NULL validator_present`)).rows[0];
  if(!row||typeof row.remnants!=='boolean'||!Number.isSafeInteger(row.marker_count)||row.marker_count<0||typeof row.certificate_present!=='boolean'||typeof row.validator_present!=='boolean'||!Number.isSafeInteger(row.ledger_count)||row.ledger_count<0)throw absent();
  if(!row.remnants&&row.marker_count===0&&row.ledger_count===0&&!row.certificate_present&&!row.validator_present)return false;
  if(pimAvailable!==true||!row.remnants||row.marker_count!==1||row.ledger_count!==1||!row.certificate_present||!row.validator_present)throw absent();
  const witness=(await ownerReader.query('SELECT (SELECT count(*)::integer FROM public.nested172_certificate) certificate_count,public.nested172_valid() valid')).rows[0];
  if(!witness||witness.certificate_count!==1||witness.valid!==true)throw absent();
  return true;
 }catch(error){
  // Invalid/torn metadata is not advertised. Do not expose catalog SQL/errors to public health.
  if(error instanceof Problem&&error.status===503)throw error;
  throw absent();
 }
}
