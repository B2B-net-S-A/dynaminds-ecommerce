/** Browser-only whole intake verification. No authority/CAS is derived from file content. */
import {decodeJson,projectSelected,type JsonValue,type Segment,type Codec} from '../../../../shared/pim-json';
import {parseMappingV2,type MappingV2,type Selector} from '../../../../shared/pim-legacy-mapping-v2';
import {previewCanonicalRows} from './browser-parse';
import type {CatalogFileImportInput} from '../../../../server/catalog-file-import-schema';
import type {Value} from '../../dictionaries/contract2';
import {decodeDictionary,decodeProduct,buildRequest} from '../../batch/model';
import {prepareTypedRows,validatePlan} from '../../files/model';
import {need,same,type CoreCustody,coreRequest} from '../handoff';
export type NestedIntake={schema:'legacy-pim-intake/v2';catalog_id:string;original_request:Record<string,unknown>;original_file:string;mapping:MappingV2;rows:{index:number;product_id:string;category_id:string|null;values:Value[];original:Record<string,JsonValue>;unmapped_fields:string[]}[]};
/** Canonical typed selectors are opaque review descriptors; no delimiter parsing or authority hash.
 * A selected container covers its full subtree. Partial selectors cover only their exact path;
 * wholly unused siblings are reported once as complete subtrees, including empty containers. */
export function unmappedPathsV2(original:Record<string,JsonValue>,selected:readonly Selector[]):string[]{
 const prefix=(a:readonly Segment[],b:readonly Segment[])=>a.length<=b.length&&a.every((s,i)=>s.kind===b[i].kind&&(s.kind==='key'?s.key===(b[i] as {kind:'key';key:string}).key:s.index===(b[i] as {kind:'index';index:number}).index));
 const descriptors:string[]=[];
 function visit(value:JsonValue,selector:Selector){
  const paths=selected.filter(s=>s.source===selector.source).map(s=>s.path);
  if(paths.some(path=>prefix(path,selector.path)))return;
  const below=paths.some(path=>prefix(selector.path,path));
  const children:Array<[Segment,JsonValue]>=Array.isArray(value)?value.map((v,index)=>[{kind:'index',index},v]):value!==null&&typeof value==='object'?Object.entries(value).map(([key,v])=>[{kind:'key',key},v]):[];
  if(!below||children.length===0){descriptors.push(JSON.stringify(selector));return;}
  for(const[segment,child]of children)visit(child,{source:selector.source,path:[...selector.path,segment]});
 }
 for(const[source,value]of Object.entries(original))visit(value,{source,path:[]});
 return descriptors.sort();
}

export function expectedNestedIntake(custody:CoreCustody,raw:unknown):NestedIntake {
 const q=coreRequest(custody.serialized_request),mapping=parseMappingV2(raw);
 need(mapping.catalog_id===q.catalog_id&&mapping.product_source===q.identity,'Mapa musi używać tożsamości i katalogu zapisanego importu');
 const records=previewCanonicalRows(q as CatalogFileImportInput);
 need(records.length===custody.rows.length&&records.length===custody.execution.total,'Nie odczytano całego pliku');
 const selected:Selector[]=[{source:mapping.product_source,path:[]},mapping.category.selector,...mapping.fields.map(f=>f.selector)];
 const rows=records.map((original,index)=>{
  const select=(s:Selector,c:Codec,a:MappingV2['fields'][number]['absence'])=>projectSelected(original,[{kind:'key',key:s.source},...s.path],c,a);
  const category=select(mapping.category.selector,{kind:'text'},{missing:'reject',null:'reject'});
  need(category.kind==='text','Kategoria wymaga dokładnego tekstu');
  const entry=mapping.category.entries.find(e=>e.source===category.value);need(entry,'Wybierz kategorię dla każdej wartości z pliku');
  const values:Value[]=[];for(const f of mapping.fields){const value=select(f.selector,f.codec,f.absence);if(value.kind!=='unset')values.push({...value,definition_id:f.definition_id} as Value);}
  return{index,product_id:custody.rows[index].product_id!,category_id:entry.category_id,values,original,unmapped_fields:unmappedPathsV2(original,selected)};
 });
 return{schema:'legacy-pim-intake/v2',catalog_id:q.catalog_id,original_request:structuredClone(q),original_file:q.content,mapping,rows};
}
export function verifyNestedStage(raw:any,custody:CoreCustody,mapping:MappingV2,key:string):NestedIntake {
 need(raw?.schema==='committed-core-file-pim-stage/v2','Odpowiedź nie potwierdza jawnego drugiego formatu mapy');
 need(same(raw.execution,{id:custody.execution.id,preview_id:custody.preview.id,scope_hash:custody.preview.scope_hash,total:custody.execution.total}));
 need(typeof raw.prepared?.ready==='boolean','Brak pełnego wyniku sprawdzenia mapy');
 const expected=expectedNestedIntake(custody,mapping);
 // Complete semantic original tree, exact raw file/request, UUIDs and all unused siblings.
 need(same(raw.prepared.intake,expected),'Drugi etap zmienił zachowany plik, mapę lub pełny zakres wierszy');
 if(!raw.prepared.ready){need(!Object.hasOwn(raw.prepared,'request')&&!Object.hasOwn(raw.prepared,'dictionary')&&!Object.hasOwn(raw.prepared,'sources'),'Odmowa nie może zawierać częściowego planu zapisu');const errors=raw.prepared.errors;need(Array.isArray(errors)&&errors.length>0&&errors.every(e=>e&&Number.isSafeInteger(e.row)&&e.row>=0&&e.row<expected.rows.length&&typeof e.field==='string'&&typeof e.code==='string'&&(e.definition_id===null||typeof e.definition_id==='string')),'Brak pełnych błędów walidacji');}
 else{need(raw.prepared.dictionary&&Array.isArray(raw.prepared.sources)&&raw.prepared.sources.length===expected.rows.length&&raw.prepared.request?.kind==='product_values','Niepełne świeże źródła mapowania');
 const dictionary=decodeDictionary(raw.prepared.dictionary,expected.catalog_id),sources=expected.rows.map((row,i)=>decodeProduct(raw.prepared.sources[i],dictionary,row.product_id));
 const plan=validatePlan({schema:'pim-values/v1',catalog_id:expected.catalog_id,rows:expected.rows.map(r=>({catalog_id:expected.catalog_id,product_id:r.product_id,category_id:r.category_id,values:r.values}))},expected.catalog_id),review=prepareTypedRows(dictionary,sources,plan);
 need(review.ready&&same(buildRequest(dictionary,sources,review.rows,key),raw.prepared.request),'Drugi etap nie potwierdza całej walidacji i źródeł parametrów');
 }
 return structuredClone(expected);
}
