import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ensure, Problem } from './errors';
import { catalogStockControlAvailable } from './catalog-stock-control';
import { enlistCatalogStockControlActorInTx } from './catalog-stock-control-transaction';
import type { CatalogStockControlActor } from './catalog-stock-control-schema';

/** Trusted server adapter. No HTTP route or physical stock writer. The SQL
 * fragment and152 validator/counter hooks must be integrated before use. */
const uuid=z.uuid().transform(v=>v.toLowerCase());
export const catalogStockReturnSource=z.object({
  return_id:uuid,
  protocol:z.enum(['rma','legacy_status','assistant_v1','destinations_v1','exchange','dropship_supplier']),
  preview_id:uuid.optional(),
  request:z.record(z.string(),z.unknown()),
}).strict().superRefine((v,c)=>{
  if(['assistant_v1','destinations_v1'].includes(v.protocol)!==Boolean(v.preview_id))
    c.addIssue({code:'custom',message:'Protokół wymaga rzeczywistego podglądu asystenta',path:['preview_id']});
});
export type CatalogStockReturnSource=z.infer<typeof catalogStockReturnSource>;
export const catalogStockReturnProof=z.object({
  assistant_receipt_id:uuid.optional(),exchange_id:uuid.optional(),
  dropship_admission_id:uuid.optional(),local_proof_id:uuid.optional(),
  parcel_receipt_return_id:uuid.optional(),wms_operation_id:uuid.optional(),
}).strict();
export type CatalogStockReturnProof=z.infer<typeof catalogStockReturnProof>;
export type CatalogStockReturnAdmission=Readonly<{id:string;tenant_id:string;return_id:string;protocol:CatalogStockReturnSource['protocol']}>;
const preparedReturn=z.object({id:uuid,tenant_id:uuid,return_id:uuid,
  protocol:catalogStockReturnSource.shape.protocol,
  requirements:z.object({admin_only:z.boolean(),scopes:z.array(z.enum([
    'orders:read','orders:write','inventory:read','inventory:write','purchasing:write',
  ])).min(1)}).strict(),
}).strict();
export type CatalogStockReturnPz={id:string;receipt_id:string;return_id:string;order_id:string;warehouse_id:string;
  kind:'PZ';number:string;year:number;sequence:string;series_id:string;row_count:number;quantity:string;wms_enabled:boolean;created_at:string};
const custody=new WeakMap<CatalogStockReturnAdmission,{client:PoolClient;actor:string;token:string}>();
const actorKey=(a:CatalogStockControlActor)=>JSON.stringify([a.tenantId,a.userId,a.apiKeyId??null,a.source??'manual']);
function check(c:PoolClient,a:CatalogStockControlActor,t:CatalogStockReturnAdmission){const s=custody.get(t);
  ensure(s&&s.client===c&&s.actor===actorKey(a)&&s.token===JSON.stringify(t)&&t.tenant_id===a.tenantId,403,'Obcy lub zmieniony token przyjęcia zwrotu');}
function sqlError(e:unknown):never{if(e instanceof Problem)throw e;const code=(e as{code?:string}).code;
  if(['55000','42P01','42703','42883'].includes(code??''))throw new Problem(503,'Niekompletny certyfikowany adapter PZ zwrotu');
  if(code==='28000')throw new Problem(401,'Klucz został cofnięty lub wygasł');
  if(code==='42501')throw new Problem(403,'Brak aktualnego uprawnienia przyjęcia zwrotu');
  if(code==='P0002')throw new Problem(404,'Nie znaleziono własnego źródła zwrotu');
  if(code==='22023')throw new Problem(422,'Rozpatrz wszystkie pozycje; ilości przyjęte i przywracane do sprzedaży nie mogą przekraczać zgłoszenia');
  if(code==='54000')throw new Problem(413,'Pełny manifest PZ zwrotu przekracza limit');
  if(['23514','23503','23505','40001','40P01'].includes(code??''))throw new Problem(409,'Źródło lub dowód przyjęcia zwrotu zmienił się');throw e;}
async function owner<R>(c:PoolClient,a:CatalogStockControlActor,work:()=>Promise<R>):Promise<R>{
  const p=(await c.query("SELECT session_user owner,current_user role,current_setting('app.tenant_id',true) tenant")).rows[0];
  ensure(p.owner==='postgres'&&['postgres','dyna_app'].includes(p.role)&&p.tenant===a.tenantId,403,'Nieprawidłowy kontekst przyjęcia zwrotu');
  if(p.role==='dyna_app')await c.query('RESET ROLE');let failed=false;
  try{return await work();}catch(e){failed=true;return sqlError(e);}finally{
    if(p.role==='dyna_app'){if(failed)await c.query('SET LOCAL ROLE dyna_app').catch(()=>{});else await c.query('SET LOCAL ROLE dyna_app');}
  }
}
/** Call BEFORE assistant/exchange/local quota, order/parcel/RMA row locks.
 * SQL derives WH/products and numbers; request has no quantity/cost authority
 * beyond the existing canonical core/preview certificate. */
export async function prepareCatalogStockReturnInTx(c:PoolClient,a:CatalogStockControlActor,input:CatalogStockReturnSource):Promise<CatalogStockReturnAdmission|null>{
  const b=catalogStockReturnSource.parse(input);
  return owner(c,a,async()=>{
    if(!await catalogStockControlAvailable(c))return null;
    await c.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('catalog:'||$1,0))",[a.tenantId]);
    // 270: when installed, the stock_verdict_ copy of the sealed prepare (same body; its catalog guard, frame and effect
    // admission ask the 248 verdict: same answer or error); before 270, the sealed function.
    const fn=(await c.query('SELECT to_regprocedure($1) IS NOT NULL installed',['public.stock_verdict_return_prepare(uuid,uuid,jsonb)'])).rows[0].installed?'stock_verdict_return_prepare':'catalog_stock_return_prepare';
    const raw=(await c.query(`SELECT public.${fn}($1,$2,$3::jsonb) admission`,[a.userId,a.apiKeyId??null,JSON.stringify(b)])).rows[0].admission;
    if(raw===null){
      // Historical receipts and nonstrict OFF writes still need the enclosing
      // source's fresh authority after any order/RMA wait; no number is born.
      const requirements=preparedReturn.shape.requirements.parse((await c.query(
        'SELECT public.catalog_stock_return_access($1,$2,$3,$4) requirements',
        [a.userId,a.apiKeyId??null,b.return_id,b.protocol],
      )).rows[0].requirements);
      enlistCatalogStockControlActorInTx(c,a,{adminOnly:requirements.admin_only,scopes:requirements.scopes});
      return null;
    }
    const prepared=preparedReturn.parse(raw);
    const result=Object.freeze({id:prepared.id,tenant_id:prepared.tenant_id,
      return_id:prepared.return_id,protocol:prepared.protocol});
    enlistCatalogStockControlActorInTx(c,a,{adminOnly:prepared.requirements.admin_only,
      scopes:prepared.requirements.scopes});
    custody.set(result,{client:c,actor:actorKey(a),token:JSON.stringify(result)});
    return result;
  });
}
/** Call after every genuine139/148/120/111/112/138 parent exists and all core
 * writes are complete, before terminal validation/IAM. No physical writer. */
export async function finishCatalogStockReturnInTx(c:PoolClient,a:CatalogStockControlActor,t:CatalogStockReturnAdmission|null,input:CatalogStockReturnProof):Promise<{documents:CatalogStockReturnPz[]}>{
  if(!t)return{documents:[]};check(c,a,t);const b=catalogStockReturnProof.parse(input);
  const result=await owner(c,a,async()=>(await c.query('SELECT public.catalog_stock_return_finish($1,$2,$3,$4::jsonb) receipt',[a.userId,a.apiKeyId??null,t.id,JSON.stringify(b)])).rows[0].receipt as{documents:CatalogStockReturnPz[]});
  custody.delete(t);return result;
}
/** Only for an observed native exact replay after waiting; SQL requires the
 * entire physical witness unchanged and unwinds only unused own numbers. */
export async function abandonCatalogStockReturnInTx(c:PoolClient,a:CatalogStockControlActor,t:CatalogStockReturnAdmission|null):Promise<void>{
  if(!t)return;check(c,a,t);await owner(c,a,async()=>{await c.query('SELECT public.catalog_stock_return_abandon($1,$2,$3)',[a.userId,a.apiKeyId??null,t.id]);});custody.delete(t);
}
/** Read heads only after the caller's RLS-qualified RMA read. Values and the
 * private journal/provenance graph are never added to the ordinary order API. */
export async function catalogStockReturnDocumentsInTx(c:PoolClient,returnId:string):Promise<CatalogStockReturnPz[]>{
  const id=uuid.parse(returnId);
  const own=(await c.query('SELECT tenant_id FROM return_cases WHERE id=$1',[id])).rows[0];
  ensure(own,404,'Nie znaleziono własnego zwrotu');
  const actor:CatalogStockControlActor={tenantId:own.tenant_id,userId:null,source:'system'};
  return owner(c,actor,async()=>{
    if(!await catalogStockControlAvailable(c))return[];
    const rows=(await c.query('SELECT payload FROM public.catalog_stock_return_documents WHERE tenant_id=$1 AND return_id=$2 ORDER BY warehouse_id,id LIMIT 101',[own.tenant_id,id])).rows;
    ensure(rows.length<=100,413,'Przyjęcie zwrotu obejmuje zbyt wiele magazynów');
    return rows.map(row=>row.payload as CatalogStockReturnPz);
  });
}
/** Page variant of catalogStockReturnDocumentsInTx: one availability verdict and one read for all returns
 * of a list page instead of one guard per row (13.11.2026 on a test database: 370-580 ms per row, 9-15 s per page of 25). */
export async function catalogStockReturnDocumentsForReturnsInTx(c:PoolClient,returnIds:string[]):Promise<Map<string,CatalogStockReturnPz[]>>{
  const ids=[...new Set(returnIds.map(id=>uuid.parse(id)))],documents=new Map<string,CatalogStockReturnPz[]>();
  if(!ids.length)return documents;
  const own=(await c.query('SELECT count(*)::int n,array_agg(DISTINCT tenant_id) tenants FROM return_cases WHERE id=ANY($1::uuid[])',[ids])).rows[0];
  ensure(own.n===ids.length,404,'Nie znaleziono własnego zwrotu');
  ensure(own.tenants.length===1,403,'Nieprawidłowy kontekst przyjęcia zwrotu');
  const actor:CatalogStockControlActor={tenantId:own.tenants[0],userId:null,source:'system'};
  return owner(c,actor,async()=>{
    if(!await catalogStockControlAvailable(c))return documents;
    const over=(await c.query('SELECT 1 FROM public.catalog_stock_return_documents WHERE tenant_id=$1 AND return_id=ANY($2::uuid[]) GROUP BY return_id HAVING count(*)>100 LIMIT 1',[actor.tenantId,ids])).rows.length;
    ensure(!over,413,'Przyjęcie zwrotu obejmuje zbyt wiele magazynów');
    const rows=(await c.query('SELECT return_id,payload FROM public.catalog_stock_return_documents WHERE tenant_id=$1 AND return_id=ANY($2::uuid[]) ORDER BY return_id,warehouse_id,id',[actor.tenantId,ids])).rows;
    for(const row of rows)documents.set(row.return_id,[...(documents.get(row.return_id)??[]),row.payload as CatalogStockReturnPz]);
    return documents;
  });
}
