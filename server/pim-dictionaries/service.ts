import {stageLegacyFileVersionedInTx as stageLegacyFileInTx,pimLegacyStageVersionedInput as pimLegacyStageInput} from './legacy/v2/stage-dispatch';
import {MappingError} from './legacy/mapping';
import {HandoffError} from './legacy/adapter';
export {pimLegacyStageInput};
/** Import-safe staged native-backed preview projection. No app/db/runtime effects.
 * NOT_APPLY_READY: complete package peer/seal/adoption/native gates OPEN.
 * Actual native frames, not caller dictionaries, are validation authority here. */
import assert from 'node:assert/strict';
import {requirePimTransaction,deferPimProducerConstraintsInTx,beginPimTransactionInTx} from './runtime';
import {createHash} from 'node:crypto';
import type {Client,PoolClient} from 'pg';
import {ensure,Problem} from '../errors';
import {PIM_LIMITS} from './contract2';
import {PimValidationError} from './model3';
import type {Actor} from '../domain';
import {z} from 'zod';
import {validateNamespace,validateProductBatch,validateDictionary,validateDefinitionTransition,resolveBindings} from './model3';
import type {DictionaryChange,PreviewInput,ProductRow} from './contract2';
type Connection=Pick<Client|PoolClient,'query'>;
type Request={actor:Actor;currentUser?:{id:string;tenant_id:string};headers:{authorization?:string;'x-workspace-id'?:string|string[]};cookies:Record<string,string|undefined>};
const authority=new WeakMap<Actor,string>();
export function capturePimAuthority(request:Request,sessionName:string):Actor{
 assert(/^dyna_session(?:_preview_\d+)?$/.test(sessionName));assert.equal(request.currentUser?.id,request.actor.userId);assert.equal(request.currentUser?.tenant_id,request.actor.tenantId);
 if(request.headers['x-workspace-id'])assert.equal(request.headers['x-workspace-id'],request.actor.tenantId);
 const actor=Object.freeze({...request.actor}),raw=actor.apiKeyId?request.headers.authorization?.replace(/^Bearer /,''):(request.cookies[sessionName]??request.headers.authorization?.replace(/^Bearer /,''));assert(raw);if(actor.apiKeyId)assert(/^dyna_api_[a-f0-9]{64}$/.test(raw));authority.set(actor,createHash('sha256').update(raw).digest('hex'));return actor;
}
export async function verifyPimIdentity(c:Connection,actor:Actor,write:boolean,pin=false){const credential=authority.get(actor);assert(credential,'Actual request authority required');return(await c.query('SELECT public.pim_dictionary_identity($1,$2,$3,$4,$5,$6,$7) proof',[actor.tenantId,actor.userId,actor.apiKeyId??null,credential,actor.role,write,pin])).rows[0].proof;}
const uuid=z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
const version=z.string().regex(/^(0|[1-9][0-9]{0,18})$/).refine(v=>BigInt(v)<=9223372036854775807n),hash=z.string().regex(/^[a-f0-9]{64}$/);
const revision=z.strictObject({catalog_version:version.refine(v=>v!=='0'),dictionary_version:version,schema_hash:hash});
const typedValue=z.discriminatedUnion('kind',[z.strictObject({definition_id:uuid,kind:z.literal('text'),value:z.string().max(500)}),z.strictObject({definition_id:uuid,kind:z.literal('decimal'),value:z.string().max(26)}),z.strictObject({definition_id:uuid,kind:z.literal('boolean'),value:z.boolean()}),z.strictObject({definition_id:uuid,kind:z.literal('enum'),option_id:uuid})]);
const definitionShape=z.discriminatedUnion('kind',[z.strictObject({kind:z.literal('text'),max_length:z.number().int().min(1).max(500)}),z.strictObject({kind:z.literal('decimal'),scale:z.number().int().min(0).max(6),unit:z.string().min(1).max(32).nullable(),minimum:z.string().max(26).nullable(),maximum:z.string().max(26).nullable()}),z.strictObject({kind:z.literal('boolean')}),z.strictObject({kind:z.literal('enum'),options:z.array(z.strictObject({id:uuid,label:z.string().min(2).max(120),active:z.boolean()})).min(1).max(200)})]);
const rowsInput=z.array(z.strictObject({product_id:uuid,product_version:version.refine(v=>v!=='0'),state_version:version,source_hash:hash,category_id:uuid.nullable(),values:z.array(typedValue).max(50)})).min(1).max(500);
const binding=z.strictObject({definition_id:uuid,required:z.boolean()});
const change=z.discriminatedUnion('kind',[z.strictObject({kind:z.literal('category_create'),id:uuid,parent_id:uuid.nullable(),name:z.string()}),z.strictObject({kind:z.literal('category_update'),id:uuid,version:version.refine(v=>v!=='0'),parent_id:uuid.nullable(),name:z.string(),active:z.boolean()}),z.strictObject({kind:z.literal('definition_create'),id:uuid,name:z.string(),shape:definitionShape}),z.strictObject({kind:z.literal('definition_update'),id:uuid,version:version.refine(v=>v!=='0'),name:z.string(),active:z.boolean(),shape:definitionShape}),z.strictObject({kind:z.literal('category_bindings'),id:uuid,version:version.refine(v=>v!=='0'),bindings:z.array(binding).max(50)})]);
const requestShape=z.discriminatedUnion('kind',[z.strictObject({kind:z.literal('product_values'),client_key:uuid,revision,rows:rowsInput}),z.strictObject({kind:z.literal('dictionary'),client_key:uuid,revision,changes:z.array(change).min(1).max(100)})]);
export const pimPreviewInput=requestShape;
const stable=(value:unknown):string=>Array.isArray(value)?'['+value.map(stable).join(',')+']':value&&typeof value==='object'?'{'+Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>JSON.stringify(k)+':'+stable(v)).join(',')+'}':JSON.stringify(value);
/** Locked real DB frame; GET never creates head/state. Writable locks use namespace
 * gate before scoped products sortedUUID. Root must use actual owner bridge. */
export async function derivePimPreviewInTx(c:Connection,actor:Actor,catalogId:string,raw:unknown){
 uuid.parse(catalogId);const request=requestShape.parse(raw) as PreviewInput;ensure(Buffer.byteLength(JSON.stringify(request),'utf8')<=1048576,413,'Przekroczono rozmiar żądania PIM');await verifyPimIdentity(c,actor,true);
 const frame=(await c.query('SELECT public.pim_dictionary_source($1,$2,$3,true) frame',[actor.tenantId,catalogId,request])).rows[0].frame;
 const dictionary=validateNamespace({dictionary_version:frame.revision.dictionary_version,...frame.dictionary});ensure(stable(request.revision)===stable(frame.revision),409,'Wersja katalogu lub słownika PIM zmieniła się');
 if(request.kind==='product_values'){
  const sources=new Map<string,any>(frame.sources.map((source:any)=>[source.product_id,source]));
  for(const r of request.rows){const s=sources.get(r.product_id)!;ensure(r.product_version===s.product_version&&r.state_version===s.state_version&&r.source_hash===s.source_hash,409,'Źródło produktu PIM zmieniło się');}
  const valid=validateProductBatch({categories:dictionary.categories,definitions:dictionary.definitions},request.rows);const nativeErrors=(await c.query('SELECT public.pim_dictionary_row_errors($1::jsonb,$2::jsonb) errors',[frame.dictionary,JSON.stringify(request.rows)])).rows[0].errors;ensure((nativeErrors.length===0)===valid.ready,503,'Niezgodność walidatorów PIM');
  return{request,frame,ready:valid.ready,errors:nativeErrors,product_rows:valid.ready?valid.rows.map((r,index)=>({index,before:sources.get(r.product_id),after:r,changed:stable({category_id:r.category_id,values:r.values})!==stable({category_id:sources.get(r.product_id).category_id,values:sources.get(r.product_id).values})})):[],dictionary_before:null,dictionary_after:null};
 }
 const next=structuredClone({categories:dictionary.categories,definitions:dictionary.definitions});
 // Exact change keys are checked before actual-scope dictionary projection.
 const ids=new Set<string>();for(const change of request.changes){ensure(!ids.has(change.id),422,'Każdy element słownika wymaga jednej pełnej zmiany');ids.add(change.id);const category=next.categories.find(x=>x.id===change.id),definition=next.definitions.find(x=>x.id===change.id);
  if(change.kind==='category_create'){ensure(!category,409,'Kategoria PIM już istnieje');next.categories.push({id:change.id,version:'1',parent_id:change.parent_id,name:change.name,active:true,bindings:[]});}
  else if(change.kind==='definition_create'){ensure(!definition,409,'Definicja PIM już istnieje');next.definitions.push({id:change.id,version:'1',name:change.name,active:true,shape:change.shape});}
  else if(change.kind==='category_update'||change.kind==='category_bindings'){ensure(category,409,'Nie znaleziono bieżącej kategorii PIM');ensure(category.version===change.version,409,'Wersja kategorii PIM zmieniła się');if(change.kind==='category_update')Object.assign(category,{parent_id:change.parent_id,name:change.name,active:change.active});else category.bindings=change.bindings;}
  else if(change.kind==='definition_update'){ensure(definition,409,'Nie znaleziono bieżącej definicji PIM');ensure(definition.version===change.version,409,'Wersja definicji PIM zmieniła się');Object.assign(definition,{name:change.name,active:change.active,shape:change.shape});}
  else assert.fail('Unknown dictionary change');
 }
 const checked=validateDictionary(next);
 for(const c of checked.categories){const prior=dictionary.categories.find(x=>x.id===c.id);if(prior&&stable(prior)!==stable(c))c.version=(BigInt(prior.version)+1n).toString();}
 for(const d of checked.definitions){const prior=dictionary.definitions.find(x=>x.id===d.id);if(prior&&stable(prior)!==stable(d))d.version=(BigInt(prior.version)+1n).toString();}
 // Entire assigned catalog scope, never active-remainder-only or silent truncation.
 const assigned=frame.sources.map((s:any)=>s.product_id) as string[];const live=assigned.map(product_id=>({product_id}));ensure(live.length<=500,413,'Przekroczono pełny zakres walidacji PIM');const sourceRows:ProductRow[]=[];
 for(const r of live){const s=frame.sources.find((source:any)=>source.product_id===r.product_id);assert(s);sourceRows.push({product_id:r.product_id,product_version:s.product_version,state_version:s.state_version,source_hash:s.source_hash,category_id:s.category_id,values:s.values});}
 for(const before of dictionary.definitions){const after=checked.definitions.find(x=>x.id===before.id);assert(after);const values=sourceRows.flatMap(r=>r.values.filter(v=>v.definition_id===before.id));validateDefinitionTransition(before,after,values.filter(v=>v.kind==='enum').map(v=>v.option_id),values.length>0);}
 const valid=sourceRows.length?validateProductBatch(checked,sourceRows):{ready:true as const,rows:[],errors:[]};const nativeErrors=sourceRows.length?(await c.query('SELECT public.pim_dictionary_row_errors($1::jsonb,$2::jsonb) errors',[checked,JSON.stringify(sourceRows)])).rows[0].errors:[];ensure((nativeErrors.length===0)===valid.ready,503,'Niezgodność walidacji produktów dotkniętych PIM');
 return{request,frame,ready:valid.ready,errors:nativeErrors,product_rows:[],dictionary_before:{categories:dictionary.categories,definitions:dictionary.definitions},dictionary_after:checked};
}

export async function storePimPreviewInTx(c:Connection,actor:Actor,catalogId:string,raw:unknown){const request=pimPreviewInput.parse(raw);const credential=authority.get(actor);assert(credential);const prior=(await c.query('SELECT public.pim_dictionary_find_preview($1,$2,$3,$4,$5,$6,$7) value',[actor.tenantId,catalogId,actor.userId,actor.apiKeyId??null,credential,actor.role,request])).rows[0].value;if(prior)return prior;const projection=await derivePimPreviewInTx(c,actor,catalogId,request);return(await c.query('SELECT public.pim_dictionary_store_preview($1,$2,$3,$4,$5,$6,$7,$8) preview',[actor.tenantId,catalogId,actor.userId,actor.apiKeyId??null,credential,actor.role,projection.request,projection])).rows[0].preview;}
export type PimServiceDependencies={transaction:<T>(actor:Actor,write:boolean,work:(c:PoolClient)=>Promise<T>)=>Promise<T>;sessionName:string;readOnly:boolean;cursorKey:string};
export function createPimService(deps:PimServiceDependencies){
 const caps=(actor:Actor,proof:any)=>({available:true,read_only:deps.readOnly,can_manage:!deps.readOnly&&actor.role==='admin'&&(!actor.apiKeyId||proof.scopes?.includes('products:write'))});
 const dictionaryDto=(catalogId:string,revision:any,dictionary:any,flags:any)=>({...flags,catalog_id:catalogId,revision,categories:dictionary.categories,definitions:dictionary.definitions,effective_bindings:dictionary.categories.filter((x:any)=>x.active).map((x:any)=>({category_id:x.id,definitions:resolveBindings(dictionary,x.id)})),limits:PIM_LIMITS});
 const productDto=(source:any,revision:any,dictionary:any,flags:any)=>({...source,...flags,revision,effective_bindings:source.category_id===null?[]:resolveBindings(dictionary,source.category_id)});
 const previewDto=(actor:Actor,proof:any,p:any)=>{const{_frame,_expired,_api_key_id,_source_current,_after_revision,...result}=p,flags=caps(actor,proof);return{...result,...flags,can_apply:!deps.readOnly&&flags.can_manage&&p.actor_id===actor.userId&&_api_key_id===(actor.apiKeyId??null)&&p.ready&&p.operation_id===null&&_expired===false&&_source_current===true,product_rows:p.product_rows.map((r:any)=>({...r,before:productDto(r.before,p.revision,_frame.dictionary,flags)})),dictionary_before:p.dictionary_before===null?null:dictionaryDto(p.catalog_id,p.revision,p.dictionary_before,flags),dictionary_after:p.dictionary_after===null?null:dictionaryDto(p.catalog_id,_after_revision,p.dictionary_after,flags)};};
 const operationDto=(actor:Actor,proof:any,o:any)=>{const{_expected_source,_before_revision,_after_revision,...result}=o,flags=caps(actor,proof);return{...result,...flags,dictionary_before:o.dictionary_before===null?null:dictionaryDto(o.catalog_id,_before_revision,o.dictionary_before,flags),dictionary_after:o.dictionary_after===null?null:dictionaryDto(o.catalog_id,_after_revision,o.dictionary_after,flags)};};
 const work=async<T>(actor:Actor,write:boolean,fn:(c:PoolClient,proof:any)=>Promise<T>):Promise<T>=>{if(write&&deps.readOnly)throw new Problem(423,'Tryb tylko do odczytu');try{return await deps.transaction(actor,write,async c=>{requirePimTransaction(c);if(write)await deferPimProducerConstraintsInTx(c);await beginPimTransactionInTx(c);const proof=await verifyPimIdentity(c,actor,write);await c.query('SELECT public.pim_dictionary_enlist($1,NULL,$2,$3,$4,$5,$6,NULL,NULL,NULL)',[actor.tenantId,actor.userId,actor.apiKeyId??null,authority.get(actor),actor.role,write]);const result=await fn(c,proof);ensure(Buffer.byteLength(JSON.stringify(result),'utf8')<=PIM_LIMITS.response_bytes,413,'Przekroczono pełny rozmiar odpowiedzi PIM');return result;});}catch(error){if(error instanceof Problem)throw error;const code=(error as {code?:string}).code;if(code==='P0002')throw new Problem(404,'Nie znaleziono zasobu PIM');if(code==='28000')throw new Problem(401,'Sesja lub klucz wygasł');if(code==='42501')throw new Problem(403,'Brak bieżących uprawnień PIM');if(code==='40001'||code==='23505')throw new Problem(409,'Źródło lub identyfikator operacji PIM zmienił się');if(code==='55000')throw new Problem(503,'Niekompletny moduł PIM');if(code==='54000')throw new Problem(413,'Przekroczono pełny zakres PIM');if(code==='23514'||error instanceof z.ZodError||error instanceof PimValidationError||error instanceof MappingError||error instanceof HandoffError)throw new Problem(422,'Niepoprawne dane PIM');throw error;}};
 const nativeArgs=(a:Actor,cid:string,id:string|null)=>{assert(authority.has(a));return[a.tenantId,cid,a.userId,a.apiKeyId??null,authority.get(a),a.role,id];};
 return{
  captureActor:(request:Request)=>capturePimAuthority(request,deps.sessionName),
  dictionary:(actor:Actor,catalogId:string)=>work(actor,false,async(c,proof)=>{uuid.parse(catalogId);const f=(await c.query('SELECT public.pim_dictionary_frame($1,$2,true) frame',[actor.tenantId,catalogId])).rows[0].frame;return dictionaryDto(catalogId,f.revision,validateDictionary(f.dictionary),caps(actor,proof));}),
  product:(actor:Actor,catalogId:string,productId:string)=>work(actor,false,async(c,proof)=>{uuid.parse(productId);uuid.parse(catalogId);const f=(await c.query('SELECT public.pim_dictionary_frame($1,$2,true) frame',[actor.tenantId,catalogId])).rows[0].frame,s=(await c.query('SELECT public.pim_dictionary_product_frame($1,$2,$3,true) frame',[actor.tenantId,catalogId,productId])).rows[0].frame;return productDto(s,f.revision,validateDictionary(f.dictionary),caps(actor,proof));}),
  editorSource:(actor:Actor,catalogId:string,productId:string)=>work(actor,false,async(c,proof)=>{uuid.parse(productId);uuid.parse(catalogId);const f=(await c.query('SELECT public.pim_dictionary_frame($1,$2,true) frame',[actor.tenantId,catalogId])).rows[0].frame,s=(await c.query('SELECT public.pim_dictionary_product_frame($1,$2,$3,true) frame',[actor.tenantId,catalogId,productId])).rows[0].frame;const dictionary=validateDictionary(f.dictionary),flags=caps(actor,proof);return{dictionary:dictionaryDto(catalogId,f.revision,dictionary,flags),product:productDto(s,f.revision,dictionary,flags)};}),
  stageLegacyFile:(actor:Actor,catalogId:string,input:unknown)=>work(actor,true,async(c,proof)=>{
   uuid.parse(catalogId);const flags=caps(actor,proof);
   // Request-local only: the native pinned frame holds this catalog's namespace
   // advisory/catalog/head locks until the enclosing managed transaction ends.
   let namespace:Promise<{revision:any;dictionary:ReturnType<typeof validateDictionary>}>|undefined;
   const loadNamespace=(cid:string)=>{
    uuid.parse(cid);ensure(cid===catalogId,422,'Katalog drugiego etapu nie zgadza się z zakresem');
    return namespace??=(async()=>{const f=(await c.query('SELECT public.pim_dictionary_frame($1,$2,true) frame',[actor.tenantId,cid])).rows[0].frame;return{revision:structuredClone(f.revision),dictionary:validateDictionary(f.dictionary)};})();
   };
   return stageLegacyFileInTx(c,actor,catalogId,input,{
    dictionary:async cid=>{const f=await loadNamespace(cid);return structuredClone(dictionaryDto(cid,f.revision,f.dictionary,flags));},
    product:async(cid,pid)=>{uuid.parse(pid);const f=await loadNamespace(cid),s=(await c.query('SELECT public.pim_dictionary_product_frame($1,$2,$3,true) frame',[actor.tenantId,cid,pid])).rows[0].frame;return structuredClone(productDto(s,f.revision,f.dictionary,flags));}
   });
  }),
  preview:(actor:Actor,catalogId:string,input:unknown)=>work(actor,true,async(c,proof)=>previewDto(actor,proof,await storePimPreviewInTx(c,actor,catalogId,input))),
  readPreview:(actor:Actor,catalogId:string,previewId:string)=>work(actor,false,async(c,proof)=>{uuid.parse(previewId);uuid.parse(catalogId);return previewDto(actor,proof,(await c.query('SELECT public.pim_dictionary_read_preview($1,$2,$3,$4,$5,$6,$7) value',nativeArgs(actor,catalogId,previewId))).rows[0].value);}),
  apply:(actor:Actor,catalogId:string,previewId:string,input:unknown)=>work(actor,true,async(c,proof)=>{uuid.parse(previewId);uuid.parse(catalogId);const body=z.strictObject({client_key:uuid,scope_hash:hash,confirmed:z.literal(true)}).parse(input);return operationDto(actor,proof,(await c.query('SELECT public.pim_dictionary_apply($1,$2,$3,$4,$5,$6,$7,$8) value',[...nativeArgs(actor,catalogId,previewId),body])).rows[0].value);}),
  operation:(actor:Actor,catalogId:string,operationId:string)=>work(actor,false,async(c,proof)=>{uuid.parse(operationId);uuid.parse(catalogId);return operationDto(actor,proof,(await c.query('SELECT public.pim_dictionary_read_operation($1,$2,$3,$4,$5,$6,$7) value',nativeArgs(actor,catalogId,operationId))).rows[0].value);}),
  history:(actor:Actor,catalogId:string,cursor?:string,kind?:'dictionary'|'product_values')=>work(actor,false,async(c)=>{uuid.parse(catalogId);if(cursor)uuid.parse(cursor);if(kind)z.enum(['dictionary','product_values']).parse(kind);return(await c.query('SELECT public.pim_dictionary_history($1,$2,$3,$4,$5,$6,$7,$8) value',[...nativeArgs(actor,catalogId,cursor??null),kind??null])).rows[0].value;}),
 };
}
