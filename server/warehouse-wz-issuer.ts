/** Trusted same-client adapter. Root integrates prepare BEFORE parent row locks
 * and finish AFTER physical dispatch, then pin AFTER all deferred constraints. */
import type { PoolClient } from 'pg';
import type { Actor } from './domain';
import { ensure, Problem } from './errors';
import { prepareCatalogStockEffectInTx, finishCatalogStockEffectInTx } from './catalog-stock-control';
import { captureCatalogStockEffectJournalsInTx, catalogStockEffectProofInTx } from './catalog-stock-effects';
import type { CatalogStockEffectAdmission } from './catalog-stock-control-schema';
import { automaticWzSourceInput, type AutomaticWzSource, type AutomaticWzPhysical, type AutomaticWzDocument } from './warehouse-wz-issuer-schema';
import { pool } from './db';
import { scheduleWzIssuerRefresh } from './wz-issuer273-refresh';
// 273: a verdict miss cut by the request statement budget (57014) records nothing, so every later request would miss as
// well; one background refresh per process, with the cold budget, records the full guard's true for the next request.
const refreshAfterTimeout=(e:unknown):never=>{if(typeof e==='object'&&e!==null&&(e as {code?:unknown}).code==='57014')void scheduleWzIssuerRefresh(pool);throw e;};

const custody = new WeakMap<object, { client:PoolClient;actor:Actor;source:AutomaticWzSource;
  effect:CatalogStockEffectAdmission|null; baseline:Awaited<ReturnType<typeof captureCatalogStockEffectJournalsInTx>> }>();
export type AutomaticWzAdmission = Readonly<{ id:string|null;enabled:boolean }>;
async function owner<T>(c:PoolClient,a:Actor,fn:()=>Promise<T>):Promise<T> {
  const row=(await c.query("SELECT current_user role,session_user owner,current_setting('app.tenant_id',true) tenant")).rows[0];
  ensure(row.owner==='postgres'&&row.tenant===a.tenantId&&['postgres','dyna_app'].includes(row.role),403,'Brak własnej transakcji wystawienia WZ');
  if(row.role==='dyna_app')await c.query('RESET ROLE');
  let failed=false;
  try{return await fn();}catch(e){
    failed=true;
    if(e instanceof Problem)throw e;
    const code=typeof e==='object'&&e!==null&&'code' in e?(e as {code?:unknown}).code:undefined;
    const controlled:Record<string,{status:number;message:string}>={
      '55000':{status:503,message:'Niekompletny wystawca automatycznego WZ'},
      '54000':{status:413,message:'Pełny zakres automatycznego WZ przekracza limit'},
      '42501':{status:403,message:'Brak aktualnego prawa wydania WZ'},
      '28000':{status:401,message:'Klucz wydania WZ został cofnięty lub wygasł'},
      '23514':{status:409,message:'Zakres automatycznego WZ nie odpowiada rzeczywistemu wydaniu'},
      '23503':{status:409,message:'Powiązania automatycznego WZ zmieniły się'},
      '23505':{status:409,message:'Automatyczny WZ dla tego źródła już istnieje'},
    };
    const refusal=typeof code==='string'&&Object.hasOwn(controlled,code)?controlled[code]:undefined;
    if(refusal)throw new Problem(refusal.status,refusal.message);
    throw e;
  }
  finally{if(row.role==='dyna_app') {if(failed)await c.query('SET LOCAL ROLE dyna_app').catch(()=>{});else await c.query('SET LOCAL ROLE dyna_app');}}
}
export async function prepareAutomaticWzInTx(c:PoolClient,a:Actor,input:AutomaticWzSource):Promise<AutomaticWzAdmission> {
  const source=automaticWzSourceInput.parse(input);
  const scope = (await c.query(source.kind === 'parcel'
    ? `SELECT DISTINCT (p->>'warehouse_id')::uuid warehouse_id,(p->>'product_id')::uuid product_id
       FROM public.order_parcel_allocations l CROSS JOIN LATERAL jsonb_array_elements(l.payload->'products') p
       WHERE l.tenant_id=$1 AND l.order_id=$2 AND l.plan_id=$3 AND l.index=$4 AND l.shipment_id=$5
       ORDER BY warehouse_id,product_id LIMIT 10001`
    : `SELECT DISTINCT warehouse_id,product_id FROM public.reservations
       WHERE tenant_id=$1 AND order_id=$2 AND state='active' ORDER BY warehouse_id,product_id LIMIT 10001`,
    source.kind === 'parcel' ? [a.tenantId,source.order_id,source.plan_id,source.parcel_index,source.shipment_id]
      : [a.tenantId,source.order_id])).rows;
  ensure(scope.length <= 10000,413,'Pełny zakres wydania magazynowego przekracza limit');
  const effect = scope.length ? await prepareCatalogStockEffectInTx(c,a,{ source_kind:'dispatch',
    source_id:source.shipment_id,warehouse_ids:[...new Set(scope.map(r => r.warehouse_id as string))].sort(),
    product_ids:[...new Set(scope.map(r => r.product_id as string))].sort(),
  }) : null;
  const baseline=await captureCatalogStockEffectJournalsInTx(c,effect);
  const id=await owner(c,a,async()=>{
    const {present,skip}=(await c.query("SELECT to_regprocedure('public.warehouse_wz_issuer_prepare(uuid,uuid,jsonb)') present,to_regprocedure('public.wz_issuer239_prepare_skip(uuid,uuid,jsonb)') skip")).rows[0];
    if(!present){
      const artifacts=(await c.query(`SELECT EXISTS(SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'warehouse_wz_issuer_%')
        OR EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'warehouse_wz_issuer_%')
        OR EXISTS(SELECT 1 FROM public.migrations WHERE name='151_warehouse_wz_issuer') partial,
        to_regprocedure('public.warehouse_automatic_wz_guards()') foundation,
        EXISTS(SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'warehouse_automatic_wz_%')
        OR EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'warehouse_automatic_wz_%')
        OR EXISTS(SELECT 1 FROM public.migrations WHERE name='150_warehouse_automatic_wz') foundation_partial`)).rows[0];
      ensure(!artifacts.partial,503,'Niekompletny wystawca WZ');
      if(!artifacts.foundation){ensure(!artifacts.foundation_partial,503,'Niekompletna konfiguracja WZ');return null;}
      ensure((await c.query('SELECT public.warehouse_automatic_wz_guards() valid')).rows[0].valid,503,'Niekompletna konfiguracja WZ');
      const configured=(await c.query(`SELECT EXISTS(SELECT 1 FROM public.warehouse_automatic_wz_configurations cfg
        WHERE cfg.tenant_id=$1 AND cfg.settings->>'enabled'='true' AND cfg.warehouse_id IN (
        SELECT warehouse_id FROM public.reservations WHERE tenant_id=$1 AND order_id=$2 AND state='active' AND $3<>'parcel'
        UNION ALL SELECT (p->>'warehouse_id')::uuid FROM public.order_parcel_allocations l CROSS JOIN LATERAL jsonb_array_elements(l.payload->'products') p
        WHERE l.tenant_id=$1 AND l.order_id=$2 AND l.plan_id=$4::uuid AND l.index=$5 AND l.shipment_id=$6 AND $3='parcel')) configured`,
        [a.tenantId,source.order_id,source.kind,'plan_id' in source?source.plan_id:null,'parcel_index' in source?source.parcel_index:null,source.shipment_id])).rows[0].configured;
      ensure(!configured,503,'Wystawca WZ jest niedostępny dla włączonej konfiguracji');return null;
    }
    const args=[a.userId,a.apiKeyId??null,JSON.stringify(source)];
    // 239: the sealed prepare would return NULL (dispatched, or no enabled configuration) after the same, reused, integrity verdict.
    if(skip&&(await c.query('SELECT public.wz_issuer239_prepare_skip($1,$2,$3::jsonb) skip',args).catch(refreshAfterTimeout)).rows[0].skip===true)return null;
    return (await c.query('SELECT public.warehouse_wz_issuer_prepare($1,$2,$3::jsonb) id',args)).rows[0].id as string|null;
  });
  ensure(!effect || id!==null,409,'Ścisły katalog wymaga włączenia automatycznego WZ dla magazynów wydania');
  const result=Object.freeze({id,enabled:id!==null});custody.set(result,{client:c,actor:{...a},source,effect,baseline});return result;
}
export async function finishAutomaticWzInTx(c:PoolClient,a:Actor,admission:AutomaticWzAdmission,b:{source:AutomaticWzSource;physical:AutomaticWzPhysical}):Promise<AutomaticWzDocument[]> {
  const retained=custody.get(admission);
  ensure(retained&&retained.client===c&&retained.actor.tenantId===a.tenantId&&retained.actor.userId===a.userId&&retained.actor.apiKeyId===a.apiKeyId,409,'Brak zachowanej zgody wystawienia WZ');
  ensure(JSON.stringify(automaticWzSourceInput.parse(b.source))===JSON.stringify(retained.source),409,'Źródło wystawienia WZ zmieniło się');
  if(!admission.enabled)return [];
  return owner(c,a,async()=>{
    const physical={...b.physical};
    if(physical.wms&&!Array.isArray(physical.wms)){
      const parcel=physical.wms;
      const rows=(await c.query(`SELECT m.id FROM public.wms_issue_fragments f JOIN public.wms_layer_movements m
        ON(m.tenant_id,m.operation_id,m.warehouse_id,m.product_id,m.location,m.layer_id)=(f.tenant_id,f.operation_id,f.warehouse_id,f.product_id,f.location,f.layer_id)
        AND m.kind='dispatch' AND m.delta=-f.quantity WHERE f.tenant_id=$1 AND f.operation_id=$2 AND f.id=ANY($3::uuid[]) ORDER BY m.id`,[a.tenantId,parcel.operation_id,parcel.fragment_ids])).rows;
      ensure(rows.length===parcel.fragment_ids.length&&new Set(rows.map(r=>r.id)).size===rows.length,409,'Niepełny dowód warstw WZ');
      physical.wms=[{operation_id:parcel.operation_id,fragment_ids:parcel.fragment_ids,layer_movement_ids:rows.map(r=>r.id)}];
    }
    const documents = (await c.query('SELECT public.warehouse_wz_issuer_finish($1,$2,$3,$4::jsonb) documents',[a.userId,a.apiKeyId??null,admission.id,JSON.stringify(physical)])).rows[0].documents as AutomaticWzDocument[];
    if (retained.effect && retained.baseline) {
      ensure(documents.length > 0 && documents.every(d => d.receipt_id === documents[0].receipt_id) &&
        retained.effect.source.warehouse_ids.every(id => documents.some(d => d.warehouse.id === id)),
        409,'Brak pełnego WZ dla wszystkich magazynów ścisłego wydania');
      await finishCatalogStockEffectInTx(c,a,retained.effect,
        await catalogStockEffectProofInTx(c,retained.baseline,{receipt_id:documents[0].receipt_id}));
    }
    return documents;
  });
}
/** Mandatory terminal fence even when WMS is OFF. Caller runs ALL IMMEDIATE
 * first, hydrates its complete response, invokes this, then COMMIT without reads. */
export async function pinAutomaticWzActorInTx(c:PoolClient,a:Actor):Promise<void> {
  await owner(c,a,async()=>{await c.query('SELECT public.warehouse_wz_issuer_require()');
    const g=(await c.query('SELECT public.warehouse_wz_issuer_access($1,$2,true) g',[a.userId,a.apiKeyId??null])).rows[0].g;
    ensure(g.key_valid,401,'Klucz wydania WZ został cofnięty lub wygasł');ensure(g.allowed,403,'Brak aktualnego prawa wydania WZ');});
}
