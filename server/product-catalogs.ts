import { drainPublicConstraintsInTx } from './public-constraint-drain';
import type {Pool,PoolClient} from 'pg';
import {pool,tenantTx} from './db';
import {audit} from './domain';
import {Problem,ensure} from './errors';
import * as V from './product-catalogs-schema';
export type ProductCatalogActor=V.ProductCatalogActor;
export type ProductCatalogIdentity={id:string;active:boolean;is_default:boolean;version:string};
type Grant={role:ProductCatalogActor['role'];key_valid:boolean;allowed:boolean;can_manage:boolean};
type Result=Record<string,any>;
const unavailable=()=>new Problem(503,'Niekompletne katalogi produktów');
export async function productCatalogsAvailable(c:Pool|PoolClient=pool):Promise<boolean>{
 const r=(await c.query("SELECT to_regprocedure('public.product_catalog_installed()') marker, EXISTS(SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'product_catalog%') OR EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'product_catalog_%') OR EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.products'::regclass AND attname='catalog_id' AND NOT attisdropped) partial")).rows[0];
 if(!r.marker){if(r.partial)throw unavailable();return false;}
 try{if(!(await c.query('SELECT product_catalog_guards() ok')).rows[0]?.ok)throw unavailable();return true;}
 catch(e:any){if(['42P01','42703','42883'].includes(e.code))throw unavailable();throw e;}
}
function mapError(e:any):never{
 if(e.code==='55000')throw unavailable();
 if(e.message==='Klucz katalogów jest nieaktualny')throw new Problem(401,'Klucz API został cofnięty lub wygasł');
 if(e.message==='Brak aktualnego uprawnienia katalogów')throw new Problem(403,'Brak aktualnego uprawnienia katalogów');
 if(e.code==='P0002')throw new Problem(404,e.message);
 if(['23514','23505','23503'].includes(e.code))throw new Problem(409,e.message);
 throw e;
}
async function access(c:PoolClient,a:ProductCatalogActor,writing=false,pin=false):Promise<Grant>{return(await c.query('SELECT product_catalog_require($1,$2,$3,$4) g',[a.userId,a.apiKeyId??null,writing,pin])).rows[0].g;}
function controls(r:Result,g:Grant):Result{
 const flags={available:true,read_only:false,current_role:g.role,can_read:true,can_manage:g.can_manage};
 if(r.preview){const p=r.preview;r={...r,preview:{...p,can_commit:g.can_manage&&p.ready&&!p.operation_id&&Date.parse(p.expires_at)>Date.now()}};}
 return {...r,...flags};
}
async function tx(a:ProductCatalogActor,writing:boolean,fn:(c:PoolClient)=>Promise<Result>):Promise<Result>{try{return await tenantTx(a.tenantId,async c=>{
 ensure(await productCatalogsAvailable(c),503,'Kopia nie zawiera katalogów produktów');await access(c,a,writing,false);const result=await fn(c);
 await drainPublicConstraintsInTx(c);const g=await access(c,a,writing,true);return controls(result,g);
 });}catch(e){return mapError(e);}}
const capabilities={tenant_unique_sku:true,tenant_wms_policy:true,product_transfer:false,default_change:false,negative_stock:false,per_catalog_wms:false} as const;
export async function productCatalogOptions(a:ProductCatalogActor){
 if(!await productCatalogsAvailable())return {available:false,read_only:false,current_role:null,can_read:false,can_manage:false,catalogs:[],warehouses:[],price_lists:[],languages:[],limits:V.PRODUCT_CATALOG_LIMITS,capabilities};
 return tx(a,false,async c=>({...await read(c,a,'options'),limits:V.PRODUCT_CATALOG_LIMITS,capabilities}));
}
async function read(c:PoolClient,a:ProductCatalogActor,step:string,id:string|null=null,q:{cursor?:string;limit?:number;kind?:string}={}){return(await c.query('SELECT product_catalog_read($1,$2,$3,$4,$5,$6,$7::jsonb) r',[a.userId,a.apiKeyId??null,step,id,q.cursor??null,q.limit??50,JSON.stringify(q)])).rows[0].r as Result;}
export const productCatalogList=(a:ProductCatalogActor,q:unknown={})=>{const b=V.productCatalogListQuery.parse(q);return tx(a,false,c=>read(c,a,'list',null,b));};
export const productCatalogDetail=(a:ProductCatalogActor,id:string)=>tx(a,false,c=>read(c,a,'detail',id));
export const productCatalogPreview=(a:ProductCatalogActor,id:string)=>tx(a,false,c=>read(c,a,'preview',id));
export const productCatalogOperation=(a:ProductCatalogActor,id:string)=>tx(a,false,c=>read(c,a,'operation',id));
export const productCatalogHistory=(a:ProductCatalogActor,q:unknown={})=>{const b=V.productCatalogHistoryQuery.parse(q);return tx(a,false,c=>read(c,a,'history',null,b));};
export function previewProductCatalog(a:ProductCatalogActor,input:unknown){const b=V.productCatalogPreviewInput.parse(input);return tx(a,true,async c=>{
 const r=(await c.query('SELECT product_catalog_write($1,$2,$3,$4,$5::jsonb) r',[a.userId,a.apiKeyId??null,'preview',null,JSON.stringify(b)])).rows[0].r;
 if(!r.reused)await audit(c,a,'product_catalog.previewed',r.preview.id,{kind:b.kind});return r;
});}
export function commitProductCatalog(a:ProductCatalogActor,id:string,input:unknown){const b=V.productCatalogCommitInput.parse(input);return tx(a,true,async c=>{
 const r=(await c.query('SELECT product_catalog_write($1,$2,$3,$4,$5::jsonb) r',[a.userId,a.apiKeyId??null,'commit',id,JSON.stringify(b)])).rows[0].r;
 if(!r.reused)await audit(c,a,'product_catalog.committed',r.catalog.id,{operation_id:r.operation.id,preview_id:id});
 // Fully hydrate persisted results before the outer transaction's final IAM pin.
 const operation=await read(c,a,'operation',r.operation.id);const current=await read(c,a,'detail',r.catalog.id);return {...operation,...current,reused:r.reused};
});}
async function helper<T>(c:PoolClient,fn:()=>Promise<T>,absent:T):Promise<T>{try{if(!await productCatalogsAvailable(c))return absent;return await fn();}catch(e){return mapError(e);}}
export function defaultProductCatalogInTx(c:PoolClient):Promise<string|null>{return helper(c,async()=>((await c.query('SELECT product_catalog_resolve(NULL) c')).rows[0].c as ProductCatalogIdentity).id,null);}
export function resolveProductCatalogInTx(c:PoolClient,catalogId?:string|null):Promise<ProductCatalogIdentity|null>{return helper(c,async()=>{const r=(await c.query('SELECT product_catalog_resolve($1) c',[catalogId??null])).rows[0].c as ProductCatalogIdentity;ensure(r.active,409,'Katalog jest nieaktywny');return r;},null);}
export function assertProductCatalogInTx(c:PoolClient,productIds:string[],catalogId?:string|null):Promise<string|null>{return helper(c,async()=>(await c.query('SELECT product_catalog_assert_products($1::uuid[],$2) id',[productIds,catalogId??null])).rows[0].id,null);}
const resource=(c:PoolClient,id:string|null,kind:string,value:string)=>helper(c,async()=>{await c.query('SELECT product_catalog_assert_resource($1,$2,$3)',[id,kind,value]);},undefined);
export const assertProductCatalogWarehouseInTx=(c:PoolClient,id:string|null,warehouseId:string)=>resource(c,id,'warehouse',warehouseId);
export const assertProductCatalogPriceListInTx=(c:PoolClient,id:string|null,priceListId:string)=>resource(c,id,'price_list',priceListId);
export const assertProductCatalogLanguageInTx=(c:PoolClient,id:string|null,locale:string)=>resource(c,id,'language',locale);

export function productCatalogOptionsInTx(c:PoolClient):Promise<{catalogs:Result[];warehouses:Result[];price_lists:Result[];languages:string[]}|null>{return helper(c,async()=>(await c.query('SELECT product_catalog_options_in_tx() r')).rows[0].r,null);}
