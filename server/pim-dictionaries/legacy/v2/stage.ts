/** SOURCE_ONLY authenticated semantic handoff. Caller must use actual PIM
 * work(actor,true), captured credential, one managed c and full prepare/LAST. */
import {z} from 'zod';import {createHash} from 'node:crypto';import type {PoolClient} from 'pg';
import {ensure} from '../../../errors';
import {catalogFileImportPreviewInput} from '../../../catalog-file-import-schema';
import {parseCatalogFileImport,assertCatalogImportJson} from '../../../catalog-file-import-parse';
import type {Actor} from '../../../domain';
import type {Dictionary,ProductSource} from '../../contract2';
import {retainCorePimFileV2,bindApprovedCorePreviewV2,stageAfterCommittedExecutionV2,typedMappingTemplateInput,type StagedCorePimFile} from './adapter';
const uuid=z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
export const pimLegacyStageV2Input=z.strictObject({core_request:catalogFileImportPreviewInput,typed_mapping:typedMappingTemplateInput,preview:z.object({id:uuid}).passthrough(),execution_id:uuid,client_key:uuid});
export type PimLegacyStageInput=z.infer<typeof pimLegacyStageV2Input>;
export type FreshPimStagePorts={dictionary:(catalogId:string)=>Promise<Dictionary>;product:(catalogId:string,productId:string)=>Promise<ProductSource>};
const stable=(v:any):any=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>[k,stable(x)])):v;
export const coreParsedRequestHash=(v:unknown)=>createHash('sha256').update(JSON.stringify(stable(v))??'undefined').digest('hex');
const same=(a:unknown,b:unknown)=>JSON.stringify(stable(a))===JSON.stringify(stable(b));
function publicHead(p:any,execution=false,preview?:any){return{id:p.id,...(execution?{preview_id:p.preview_id,state:p.state}:{}),actor_id:p.actor_id,scope_hash:p.scope_hash,total:p.total,created:p.created,updated:p.updated,unchanged:p.unchanged,invalid:p.invalid??0,ready:p.ready??true,created_at:p.created_at instanceof Date?p.created_at.toISOString():p.created_at,config:p.config??preview?.config,active_product_rules:(p.rules_snapshot??preview?.rules_snapshot??[]).length};}
/** No CREATE/INSERT/UPDATE/DELETE. Exact own tenant/canonical IDs in every read;
 * core098 grants SELECT with RLS, no RESET ROLE or new ancestor ACL/body needed. */
export async function stageLegacyFileV2InTx(c:Pick<PoolClient,'query'>,actor:Actor,catalogId:string,raw:unknown,ports:FreshPimStagePorts):Promise<StagedCorePimFile>{
 uuid.parse(catalogId);assertCatalogImportJson(raw);ensure(Buffer.byteLength(JSON.stringify(raw),'utf8')<=2097152,413,'Przekroczono żądanie drugiego etapu');const body=pimLegacyStageV2Input.parse(raw);ensure(actor.role==='admin',403,'Drugi etap wymaga administratora');const module=(await c.query("SELECT to_regclass('public.catalog_file_import_previews') IS NOT NULL AND to_regclass('public.catalog_file_import_rows') IS NOT NULL AND to_regclass('public.catalog_file_import_executions') IS NOT NULL AND to_regclass('public.catalog_file_import_execution_rows') IS NOT NULL available")).rows[0];ensure(module?.available===true,503,'Brak trwałego importu CSV/XML');
 const retained=retainCorePimFileV2(body.core_request,body.typed_mapping);ensure(retained.core_request.catalog_id===catalogId,422,'Jawny katalog nie zgadza się ze ścieżką');
 const p=(await c.query('SELECT * FROM public.catalog_file_import_previews WHERE (tenant_id,id)=($1,$2)',[actor.tenantId,body.preview.id])).rows[0];ensure(p,404,'Nie znaleziono własnego podglądu importu');ensure(p.actor_id===actor.userId,403,'Podgląd importu ma innego autora');ensure(p.ready===true&&p.invalid===0,409,'Podgląd importu nie jest kompletny');ensure(p.client_key===retained.core_request.client_key,409,'Zmieniono klucz pierwotnego podglądu');ensure(['manual','api'].includes(p.source),503,'Niekompletna proweniencja importu');
 // Native098 hashes normalized parser/config rows, not raw uploaded bytes. An
 // ignored XML path can differ while the semantic hash remains identical.
 const requestHash=coreParsedRequestHash({actor:p.actor_id,source:p.source,config:retained.config,rows:parseCatalogFileImport(retained.core_request)});ensure(requestHash===p.request_hash,409,'Plik nie odtwarza przyjętego źródła importu');ensure(same(p.config,retained.config),409,'Konfiguracja importu uległa zmianie');const preview=publicHead(p);ensure(same(body.preview,preview),409,'Zmieniono zachowany nagłówek podglądu');
 const e=(await c.query('SELECT * FROM public.catalog_file_import_executions WHERE (tenant_id,id,preview_id)=($1,$2,$3)',[actor.tenantId,body.execution_id,p.id])).rows[0];ensure(e,404,'Nie znaleziono własnego trwałego wykonania');ensure(e.state==='done'&&e.actor_id===p.actor_id&&e.scope_hash===p.scope_hash,409,'Wykonanie nie odpowiada przyjętemu podglądowi');
 const bound=bindApprovedCorePreviewV2(retained,preview);return stageAfterCommittedExecutionV2(bound,e.id,body.client_key,{...ports,execution:async(id,cursor)=>{ensure(id===e.id,409,'Zmieniono wykonanie drugiego etapu');const start=cursor===undefined?0:Number(cursor);ensure(Number.isSafeInteger(start)&&start>=0&&start<=499,422,'Niepoprawny kursor');const rows=(await c.query('SELECT * FROM public.catalog_file_import_execution_rows WHERE (tenant_id,execution_id)=($1,$2) AND index>=$3 ORDER BY index LIMIT 101',[actor.tenantId,e.id,start])).rows;return{available:true,current_role:actor.role,can_read:true,can_write:true,read_only:false,execution:publicHead(e,true,p),rows:rows.slice(0,100).map(({tenant_id:_tenant,execution_id:_execution,byte_count:_bytes,...r}:any)=>({...r,changes:r.input})),meta:{cursor:rows.length>100?String(rows[99].index+1):null}};}});
}
