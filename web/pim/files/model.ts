/** SOURCE_DRAFT: browser-safe typed file codec, not an adopted catalog importer/feed. */
import {SaxesParser} from 'saxes';
import type {Dictionary,ProductSource,ProductRow,Value,RowError} from '../dictionaries/contract2';
import {validateProductBatch} from '../dictionaries/model3';
import {decodeDictionary,decodeProduct,toRow,uuid,same,selectedIds} from '../batch/model';
export const FILE_LIMITS={bytes:1048576,products:500,values:50,xml_depth:3,xml_nodes:26001} as const;
export const CSV_HEADER=['catalog_id','product_id','category_id','values_json'] as const;
export type FileRow={catalog_id:string;product_id:string;category_id:string|null;values:Value[]};
export type FilePlan={schema:'pim-values/v1';catalog_id:string;rows:FileRow[]};
export class TypedFileError extends Error{constructor(readonly code:string,message:string,readonly row:number|null=null){super(message);this.name='TypedFileError';}}
function fail(code:string,message:string,row:number|null=null):never{throw new TypedFileError(code,message,row);}
function check(v:unknown,code='file_shape',message='Nieprawidłowy plik typowanych parametrów',row:number|null=null):asserts v{if(!v)fail(code,message,row);}
function exact(v:unknown,keys:string[],row:number|null=null):asserts v is Record<string,unknown>{check(v&&typeof v==='object'&&!Array.isArray(v)&&same(Object.keys(v).sort(),[...keys].sort()),'field_set','Niedozwolone lub brakujące pola',row);}
function value(v:unknown,row:number):Value{
 check(v&&typeof v==='object'&&!Array.isArray(v),'value_shape','Wartość wymaga jawnego typu',row);const x=v as Record<string,unknown>;
 check(typeof x.definition_id==='string'&&uuid.test(x.definition_id),'definition_id','Wymagany UUID definicji',row);
 if(x.kind==='text'||x.kind==='decimal'){exact(x,['definition_id','kind','value'],row);check(typeof x.value==='string','value_type','Tekst i liczba dziesiętna muszą być ciągiem znaków',row);}
 else if(x.kind==='boolean'){exact(x,['definition_id','kind','value'],row);check(typeof x.value==='boolean','value_type','Wartość logiczna wymaga true lub false',row);}
 else if(x.kind==='enum'){exact(x,['definition_id','kind','option_id'],row);check(typeof x.option_id==='string'&&uuid.test(x.option_id),'option_id','Wymagany UUID opcji',row);}
 else fail('value_kind','Nieznany typ wartości',row);
 return structuredClone(x) as Value;
}
function bytes(input:string|Uint8Array):string{
 let text:string;try{text=typeof input==='string'?input:new TextDecoder('utf-8',{fatal:true}).decode(input);}catch{fail('utf8','Plik musi być poprawnym UTF-8');}
 check(new TextEncoder().encode(text).byteLength<=FILE_LIMITS.bytes,'file_bytes','Plik przekracza 1 MiB');
 check(!/\u0000/.test(text)&&!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text),'unicode','Niedozwolony znak Unicode');return text.charCodeAt(0)===0xfeff?text.slice(1):text;
}
export function validatePlan(raw:unknown,catalogId:string):FilePlan{
 check(uuid.test(catalogId),'catalog_id','Wymagany UUID katalogu');exact(raw,['schema','catalog_id','rows']);
 check(raw.schema==='pim-values/v1'&&raw.catalog_id===catalogId&&Array.isArray(raw.rows),'catalog_scope','Plik musi wskazywać wybrany katalog');
 check(raw.rows.length>=1&&raw.rows.length<=FILE_LIMITS.products,'product_count','Plik musi zawierać od 1 do 500 produktów');
 const ids=new Set<string>();const rows=raw.rows.map((r:unknown,i:number)=>{exact(r,['catalog_id','product_id','category_id','values'],i);
 check(r.catalog_id===catalogId&&typeof r.product_id==='string'&&uuid.test(r.product_id)&&!ids.has(r.product_id),'product_id','Wymagany unikalny UUID produktu w wybranym katalogu',i);ids.add(r.product_id);
 check(r.category_id===null||typeof r.category_id==='string'&&uuid.test(r.category_id),'category_id','Kategoria wymaga UUID lub jawnego braku',i);
 check(Array.isArray(r.values)&&r.values.length<=FILE_LIMITS.values,'values','Produkt może mieć do 50 wartości',i);const values=r.values.map(v=>value(v,i));
 check(new Set(values.map(v=>v.definition_id)).size===values.length,'duplicate_definition','Powtórzona definicja w jednym produkcie',i);
 return{catalog_id:catalogId,product_id:r.product_id,category_id:r.category_id,values} as FileRow;});
 return{schema:'pim-values/v1',catalog_id:catalogId,rows};
}
/** RFC-style CSV preserves quoted commas/newlines/empty strings; reads all records before validation. */
function records(text:string):string[][]{
 const out:string[][]=[];let row:string[]=[],field='',quoted=false,closed=false;const cell=()=>{row.push(field);field='';closed=false;};const line=()=>{cell();out.push(row);row=[];check(out.length<=FILE_LIMITS.products+1,'product_count','Plik przekracza 500 produktów');};
 for(let i=0;i<text.length;i++){const c=text[i];if(quoted){if(c==='"'){if(text[i+1]==='"'){field+='"';i++;}else{quoted=false;closed=true;}}else field+=c;continue;}
 if(c==='"'){check(field===''&&!closed,'csv_quote','Nieprawidłowy cudzysłów CSV');quoted=true;}else if(c===',')cell();else if(c==='\n'||c==='\r'){if(c==='\r'&&text[i+1]==='\n')i++;line();}else{check(!closed,'csv_quote','Znak po zamknięciu pola CSV');field+=c;}}
 check(!quoted,'csv_quote','Niezamknięte pole CSV');if(field!==''||row.length||closed)line();return out;
}
export function parseTypedCsv(input:string|Uint8Array,catalogId:string):FilePlan{
 const rows=records(bytes(input));check(same(rows[0],CSV_HEADER),'csv_header','Wymagany dokładny nagłówek typowanego CSV');
 return validatePlan({schema:'pim-values/v1',catalog_id:catalogId,rows:rows.slice(1).map((r,i)=>{check(r.length===4,'csv_columns','Nieprawidłowa liczba kolumn',i);let values:unknown;try{values=JSON.parse(r[3]);}catch{fail('values_json','Nieprawidłowa tablica values_json',i);}return{catalog_id:r[0],product_id:r[1],category_id:r[2]===''?null:r[2],values};})},catalogId);
}
export function parseTypedXml(input:string|Uint8Array,catalogId:string):FilePlan{
 const text=bytes(input);check(!/<!DOCTYPE|<!ENTITY|<\?/i.test(text),'xml_declaration','DTD, encje i instrukcje przetwarzania są niedozwolone');
 const rows:FileRow[]=[];let depth=0,nodes=0,root=false,current:FileRow|null=null,currentValue:Record<string,unknown>|null=null,content='';
 const parser=new SaxesParser({xmlns:false});const attrs=(tag:any,keys:string[])=>{check(same(Object.keys(tag.attributes).sort(),[...keys].sort()),'xml_attributes','Nieprawidłowy zestaw atrybutów XML');return tag.attributes as Record<string,string>;};
 parser.on('error',()=>fail('xml_syntax','Nieprawidłowy XML'));parser.on('doctype',()=>fail('xml_declaration','DTD jest niedozwolone'));parser.on('processinginstruction',()=>fail('xml_declaration','Instrukcje XML są niedozwolone'));parser.on('comment',()=>fail('xml_shape','Komentarze XML są niedozwolone'));
 parser.on('opentag',tag=>{check(++depth<=FILE_LIMITS.xml_depth&&++nodes<=FILE_LIMITS.xml_nodes,'xml_bounds','Przekroczone granice XML');
  if(depth===1){check(!root&&tag.name==='pim_values','xml_root','Wymagany korzeń pim_values');root=true;const a=attrs(tag,['schema','catalog_id']);check(a.schema==='pim-values/v1'&&a.catalog_id===catalogId,'catalog_scope','Nieprawidłowy katalog lub schemat');}
  else if(depth===2){check(tag.name==='product'&&current===null,'xml_shape','Wymagany element product');const a=attrs(tag,['product_id','category_id']);current={catalog_id:catalogId,product_id:a.product_id,category_id:a.category_id||null,values:[]};}
  else{check(tag.name==='value'&&current&&!currentValue,'xml_shape','Wymagany element value');const kind=tag.attributes.kind;const a=attrs(tag,kind==='enum'?['definition_id','kind','option_id']:['definition_id','kind']);currentValue={...a};content='';}});
 const add=(s:string)=>{if(depth===3)content+=s;else check(!s.trim(),'xml_text','Tekst poza wartością jest niedozwolony');};parser.on('text',add);parser.on('cdata',add);
 parser.on('closetag',()=>{if(depth===3){check(current&&currentValue);if(currentValue.kind==='boolean'){check(content==='true'||content==='false','boolean','Wartość logiczna wymaga true lub false',rows.length);currentValue.value=content==='true';}else if(currentValue.kind!=='enum')currentValue.value=content;else check(content==='','enum_text','Opcja wymaga UUID, nie etykiety');current.values.push(value(currentValue,rows.length));currentValue=null;check(current.values.length<=FILE_LIMITS.values,'values','Przekroczono 50 wartości');}
  else if(depth===2){check(current);rows.push(current);current=null;check(rows.length<=FILE_LIMITS.products,'product_count','Plik przekracza 500 produktów');}depth--;});
 parser.write(text).close();check(root&&depth===0,'xml_root','Brak pełnego dokumentu XML');return validatePlan({schema:'pim-values/v1',catalog_id:catalogId,rows},catalogId);
}
export type Prepared={ready:true;rows:ProductRow[];errors:[]} | {ready:false;rows:[];errors:RowError[]};
export function prepareTypedRows(dictionary:Dictionary,sources:ProductSource[],input:FilePlan):Prepared{
 const plan=validatePlan(input,dictionary.catalog_id);let d:Dictionary;try{d=decodeDictionary(dictionary,dictionary.catalog_id);check(d.available,'dictionary_access','Słownik jest niedostępny');}catch{return{ready:false,rows:[],errors:[{row:0,field:'dictionary',code:'source_invalid',definition_id:null}]};}
 check(same(selectedIds(sources.map(x=>x.product_id)),selectedIds(plan.rows.map(x=>x.product_id))),'source_scope','Odczyt musi obejmować dokładnie wszystkie produkty pliku');
 const errors:RowError[]=[];const rows:ProductRow[]=plan.rows.map((r,i)=>{const s=sources.find(x=>x.product_id===r.product_id)!;
 try{check(s.available,'source_access','Produkt jest niedostępny');decodeProduct(s,d,r.product_id);}catch{const prior=validateProductBatch({categories:d.categories,definitions:d.definitions},[toRow(s)]);if(!prior.ready)errors.push(...prior.errors.map(e=>({...e,row:i})));else errors.push({row:i,field:'source',code:'source_invalid',definition_id:null});}
 return{...toRow(s),category_id:r.category_id,values:structuredClone(r.values)};});
 if(errors.length)return{ready:false,rows:[],errors};const result=validateProductBatch({categories:d.categories,definitions:d.definitions},rows);return result.ready?{ready:true,rows:result.rows,errors:[]}:{ready:false,rows:[],errors:result.errors};
}
const csv=(s:string)=>/[",\r\n]/.test(s)?'"'+s.replaceAll('"','""')+'"':s;
const xml=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;').replaceAll('\r','&#13;').replaceAll('\n','&#10;');
export function encodeTypedCsv(input:FilePlan):string{const p=validatePlan(input,input.catalog_id);const text=[CSV_HEADER.join(','),...p.rows.map(r=>[r.catalog_id,r.product_id,r.category_id??'',JSON.stringify(r.values)].map(csv).join(','))].join('\r\n')+'\r\n';bytes(text);return text;}
export function encodeTypedXml(input:FilePlan):string{const p=validatePlan(input,input.catalog_id);const text='<pim_values schema="pim-values/v1" catalog_id="'+p.catalog_id+'">'+p.rows.map(r=>'<product product_id="'+r.product_id+'" category_id="'+(r.category_id??'')+'">'+r.values.map(v=>'<value definition_id="'+v.definition_id+'" kind="'+v.kind+'"'+(v.kind==='enum'?' option_id="'+v.option_id+'"/>':('>'+xml(v.kind==='boolean'?String(v.value):v.value)+'</value>'))).join('')+'</product>').join('')+'</pim_values>';bytes(text);return text;}
export function prepareTypedExport(d:Dictionary,sources:ProductSource[],policy:{require_category:boolean}):{ready:true;plan:FilePlan;csv:string;xml:string;errors:[]}|{ready:false;errors:RowError[];plan:null;csv:null;xml:null}{
 check(policy&&typeof policy.require_category==='boolean','export_policy','Eksport wymaga jawnej polityki kategorii');
 const rows=[...sources].sort((a,b)=>a.product_id<b.product_id?-1:a.product_id>b.product_id?1:0).map(s=>({catalog_id:s.catalog_id,product_id:s.product_id,category_id:s.category_id,values:structuredClone(s.values)}));
 const p=validatePlan({schema:'pim-values/v1',catalog_id:d.catalog_id,rows},d.catalog_id);const checked=prepareTypedRows(d,sources,p);const errors:RowError[]=checked.ready?[]:checked.errors;
 if(policy.require_category)p.rows.forEach((r,i)=>{if(r.category_id===null)errors.push({row:i,field:'category_id',code:'category_required_for_export',definition_id:null});});
 if(errors.length)return{ready:false,errors,plan:null,csv:null,xml:null};return{ready:true,plan:p,csv:encodeTypedCsv(p),xml:encodeTypedXml(p),errors:[]};
}
