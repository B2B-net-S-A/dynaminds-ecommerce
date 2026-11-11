import {decodeLegacyAttributes} from '../../../shared/pim-legacy-attributes';
/** Intended browser-safe sheet model; proposed contract2, no native ownership proof. */
import {PIM_LIMITS,type Dictionary,type ProductSource,type ProductRow,type Preview,type PreviewInput,type Operation,type Value} from '../dictionaries/contract2';
import {validateNamespace,validateProductBatch,resolveBindings,PimValidationError} from '../dictionaries/model3';
export {PimValidationError};
export const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,hash=/^[a-f0-9]{64}$/,utc=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;
const canon=(v:any):any=>Array.isArray(v)?v.map(canon):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>[k,canon(x)])):v;
export const same=(a:unknown,b:unknown)=>JSON.stringify(canon(a))===JSON.stringify(canon(b));
export function need(v:unknown,message='Nieprawidłowe dane arkusza'):asserts v{if(!v)throw new Error(message);}
export const version=(v:unknown,zero=false):v is string=>typeof v==='string'&&/^(0|[1-9][0-9]{0,18})$/.test(v)&&(zero||v!=='0')&&BigInt(v)<=9223372036854775807n;
export function flags(v:any){need(v&&typeof v.available==='boolean'&&typeof v.read_only==='boolean'&&typeof v.can_manage==='boolean');}
export function revision(v:any){need(v&&version(v.catalog_version)&&version(v.dictionary_version,true)&&typeof v.schema_hash==='string'&&hash.test(v.schema_hash));}
export const data=(d:Dictionary)=>({categories:d.categories,definitions:d.definitions});
export function decodeDictionary(v:any,catalogId:string):Dictionary{
 flags(v);revision(v.revision);need(v.catalog_id===catalogId&&same(v.limits,PIM_LIMITS));const d=validateNamespace({...data(v),dictionary_version:v.revision.dictionary_version});
 need(Array.isArray(v.effective_bindings)&&v.effective_bindings.length===d.categories.filter(x=>x.active).length);
 for(const c of d.categories.filter(x=>x.active))need(same(v.effective_bindings.find((b:any)=>b.category_id===c.id)?.definitions,resolveBindings(data(v),c.id)));
 return structuredClone(v);
}
export function toRow(p:ProductSource):ProductRow{return{product_id:p.product_id,product_version:p.product_version,state_version:p.state_version,source_hash:p.source_hash,category_id:p.category_id,values:structuredClone(p.values)};}
export function decodeProduct(v:any,d:Dictionary,id:string):ProductSource{
 flags(v);need(v.catalog_id===d.catalog_id&&v.product_id===id&&same(v.revision,d.revision)&&typeof v.name==='string'&&typeof v.sku==='string');
 need(v.legacy&&typeof v.legacy.category==='string'&&v.legacy.attributes&&typeof v.legacy.attributes==='object'&&!Array.isArray(v.legacy.attributes));decodeLegacyAttributes(v.legacy.attributes);
 const r=validateProductBatch(data(d),[toRow(v)]);need(r.ready);need(same(v.effective_bindings,v.category_id===null?[]:resolveBindings(data(d),v.category_id)));return structuredClone(v);
}
export function selectedIds(ids:readonly string[]):string[]{need(ids.length>=1&&ids.length<=PIM_LIMITS.product_rows&&ids.every(x=>typeof x==='string'&&uuid.test(x))&&new Set(ids).size===ids.length,'Wybierz od 1 do 500 różnych produktów');return [...ids].sort();}
export function setValue(rows:ProductRow[],productId:string,definitionId:string,value:Value|null):ProductRow[]{need(rows.some(r=>r.product_id===productId)&&(!value||value.definition_id===definitionId));return rows.map(r=>r.product_id===productId?{...r,values:[...r.values.filter(x=>x.definition_id!==definitionId),...(value?[structuredClone(value)]:[])]}:r);}
export function setCategory(rows:ProductRow[],productId:string,categoryId:string|null):ProductRow[]{need(rows.some(r=>r.product_id===productId));return rows.map(r=>r.product_id===productId?{...r,category_id:categoryId,values:[]}:r);}
export function buildRequest(d:Dictionary,sources:ProductSource[],rows:ProductRow[],clientKey:string):Extract<PreviewInput,{kind:'product_values'}>{
 need(uuid.test(clientKey)&&d.available&&!d.read_only&&d.can_manage,'Słownik nie pozwala na zapis');const ids=selectedIds(sources.map(x=>x.product_id));need(rows.length===ids.length&&same(rows.map(x=>x.product_id).sort(),ids));
 for(const r of rows){const source=sources.find(x=>x.product_id===r.product_id)!;need(same(source.revision,d.revision)&&source.catalog_id===d.catalog_id&&source.available&&!source.read_only&&source.can_manage&&r.product_version===source.product_version&&r.state_version===source.state_version&&r.source_hash===source.source_hash,'Produkt jest niedostępny lub jego wersja uległa zmianie');}
 const checked=validateProductBatch(data(d),[...rows].sort((a,b)=>a.product_id.localeCompare(b.product_id)));if(!checked.ready)throw new PimValidationError(checked.errors);
 const request={kind:'product_values' as const,client_key:clientKey,revision:structuredClone(d.revision),rows:checked.rows};need(new TextEncoder().encode(JSON.stringify(request)).byteLength<=PIM_LIMITS.request_bytes,'Arkusz przekracza dozwolony rozmiar');return request;
}
export function decodePreview(v:any,request:Extract<PreviewInput,{kind:'product_values'}>,catalog:string,actor:string):Preview{
 flags(v);revision(v.revision);need(uuid.test(v.id)&&v.catalog_id===catalog&&v.actor_id===actor&&v.kind==='product_values'&&v.client_key===request.client_key&&same(v.request,request)&&same(v.revision,request.revision)&&hash.test(v.scope_hash)&&utc.test(v.created_at)&&utc.test(v.expires_at)&&typeof v.ready==='boolean'&&typeof v.can_apply==='boolean'&&typeof v.reused==='boolean'&&(v.operation_id===null||uuid.test(v.operation_id))&&Array.isArray(v.errors)&&Array.isArray(v.product_rows)&&v.dictionary_before===null&&v.dictionary_after===null);
 for(const e of v.errors)need(Number.isSafeInteger(e.row)&&e.row>=0&&e.row<request.rows.length&&typeof e.field==='string'&&typeof e.code==='string'&&(e.definition_id===null||uuid.test(e.definition_id)));
 if(v.ready){need(!v.errors.length&&v.product_rows.length===request.rows.length);for(let i=0;i<request.rows.length;i++){const r=v.product_rows[i],original=request.rows[i];need(r.index===i&&typeof r.changed==='boolean'&&same(r.after,original)&&r.before.catalog_id===catalog&&r.before.product_id===original.product_id&&same(r.before.revision,request.revision)&&r.before.product_version===original.product_version&&r.before.state_version===original.state_version&&r.before.source_hash===original.source_hash);}}
 else need(v.product_rows.length===0&&v.errors.length>0&&!v.can_apply);
 return structuredClone(v);
}
export function decodeOperation(v:any,p:Preview,catalog:string,actor:string):Operation{
 flags(v);need(uuid.test(v.id)&&v.preview_id===p.id&&v.catalog_id===catalog&&v.actor_id===actor&&v.kind==='product_values'&&v.scope_hash===p.scope_hash&&utc.test(v.created_at)&&typeof v.reused==='boolean'&&Number.isSafeInteger(v.changed_count)&&v.changed_count>=0&&v.dictionary_before===null&&v.dictionary_after===null&&Array.isArray(v.product_rows)&&v.product_rows.length===p.product_rows.length);
 for(let i=0;i<p.product_rows.length;i++){const old=p.product_rows[i],r=v.product_rows[i];need(r.product_id===old.after.product_id&&same(r.before,toRow(old.before))&&r.after.product_id===old.after.product_id&&r.after.product_version===old.before.product_version&&version(r.after.state_version,true)&&r.after.state_version===(old.changed?(BigInt(old.before.state_version)+1n).toString():old.before.state_version)&&typeof r.after.source_hash==='string'&&hash.test(r.after.source_hash)&&r.after.category_id===old.after.category_id&&same(r.after.values,old.after.values));if(!old.changed)need(r.after.source_hash===old.before.source_hash);}
 need(v.changed_count===p.product_rows.filter(x=>x.changed).length);return structuredClone(v);
}
