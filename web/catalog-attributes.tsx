import type {ReactNode} from 'react';
import {decodeLegacyAttributes} from '../shared/pim-legacy-attributes';
import {decodeCatalogAttributes} from '../shared/catalog-attributes';
import type {JsonValue} from '../shared/pim-json';

/** Read/display only; never changes keys, values, versions, source hashes or scope. */
export function attributeValueText(value:unknown):string{
 if(value===undefined)return '(nie podano)';
 if(typeof value==='string')return value===''?'(pusty tekst)':value;
 if(value===null)return 'Jawny null';
 if(typeof value==='boolean')return value?'Tak (boolean)':'Nie (boolean)';
 if(typeof value==='number'&&Number.isFinite(value))return String(value);
 return JSON.stringify(decodeLegacyAttributes({value}).value,null,2);
}
export function attributeValuesEqual(before:JsonValue,after:JsonValue):boolean{
 if(before===after)return true;
 if(Array.isArray(before)||Array.isArray(after))return Array.isArray(before)&&Array.isArray(after)&&before.length===after.length&&before.every((value,index)=>attributeValuesEqual(value,after[index]!));
 if(before===null||after===null||typeof before!=='object'||typeof after!=='object')return false;
 const keys=Object.keys(before);return keys.length===Object.keys(after).length&&keys.every(key=>Object.hasOwn(after,key)&&attributeValuesEqual(before[key]!,after[key]!));
}
function valueNode(value:JsonValue):ReactNode{
 if(Array.isArray(value))return value.length?<ol start={0}>{value.map((item,index)=><li key={index}><span>Element [{index}]</span>{valueNode(item)}</li>)}</ol>:<span>Pusta lista []</span>;
 if(value!==null&&typeof value==='object')return Object.keys(value).length?<dl>{Object.entries(value).map(([key,item])=><div key={key}><dt>{key===''?'Klucz "" (pusty)':key}</dt><dd>{valueNode(item)}</dd></div>)}</dl>:<span>Pusty obiekt {`{}`}</span>;
 return <span style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{typeof value==='string'?'Tekst: ':typeof value==='number'?'Liczba: ':''}{attributeValueText(value)}</span>;
}
export function CatalogAttributesRead({attributes}:{attributes:unknown}){
 try{const full=decodeLegacyAttributes(attributes);return <dl className="catalog-attributes">{Object.entries(full).map(([key,value])=><div key={key}><dt>{key===''?'Klucz "" (pusty)':key}</dt><dd>{valueNode(value)}</dd></div>)}</dl>;}catch{return <p role="alert">Niepełne parametry produktu. Odczytaj źródło ponownie; danych nie zastąpiono pustym obiektem.</p>;}
}
export function seedCatalogAttributes(attributes:unknown):{rows:[string,string][];json:string|null}{
 const full=decodeLegacyAttributes(attributes);
 return Object.values(full).every(value=>typeof value==='string')&&Object.keys(full).every(key=>key!==''&&key===key.trim())?{rows:Object.entries(full) as [string,string][],json:null}:{rows:[],json:JSON.stringify(full,null,2)};
}
export function parseCatalogAttributesEdit(text:string){
 let value:unknown;try{value=JSON.parse(text);}catch{throw Error('Parametry: wymagany poprawny pełny obiekt JSON. Nic nie zostało zapisane.');}
 try{return decodeCatalogAttributes(value);}catch{throw Error('Parametry wymagają pełnego obiektu JSON: maksymalnie 1 MiB, 16 poziomów i 100000 węzłów. Dotychczasowe parametry tekstowe zachowują limit 50 nazw po 80 znaków i wartości po 500 znaków. Nic nie zostało zapisane.');}
}
export function flatAttributesJson(rows:readonly [string,string][]):string{
 const retained=rows.filter(([key,value])=>key!==''||value!=='');
 if(retained.some(([key])=>key==='')||new Set(retained.map(([key])=>key)).size!==retained.length)throw Error('Parametry wymagają unikalnych niepustych nazw; struktury nie zmieniono.');
 return JSON.stringify(decodeCatalogAttributes(Object.fromEntries(retained)),null,2);
}
export function CatalogAttributesJsonInput({value,onChange}:{value:string;onChange:(value:string)=>void}){
 let error='';try{parseCatalogAttributesEdit(value);}catch(e){error=(e as Error).message;}
 return <div><label>Pełna struktura parametrów JSON<textarea aria-label="Pełna struktura parametrów JSON" rows={10} value={value} aria-invalid={!!error} aria-describedby="catalog-attributes-json-help" onChange={e=>onChange(e.target.value)}/></label><p id="catalog-attributes-json-help">Zachowaj cały obiekt. false, null, pusty tekst, listy i obiekty są różnymi wartościami. {`{}`} jawnie usuwa wszystkie parametry. Zapis produktu nadal wymaga bieżącej wersji i uprawnień.</p>{error&&<p role="alert">{error}</p>}</div>;
}
