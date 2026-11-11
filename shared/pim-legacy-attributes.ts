/** Read codec only. Keep the historical all-string legacy branch; nested JSON retains strict codec. */
import {decodeJson,type JsonValue} from './pim-json';
export function ownDataObject(raw:unknown):Record<string,unknown>{
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||![Object.prototype,null].includes(Object.getPrototypeOf(raw))||Object.getOwnPropertySymbols(raw).length)throw Error('legacy_json_object');
 const descriptors=Object.entries(Object.getOwnPropertyDescriptors(raw));
 if(descriptors.some(([,d])=>!d.enumerable||!Object.hasOwn(d,'value')))throw Error('legacy_json_data_properties');
 return Object.fromEntries(descriptors.map(([key,d])=>[key,d.value]));
}
export function decodeLegacyAttributes(raw:unknown):Record<string,JsonValue>{
 const data=ownDataObject(raw);
 // Exact historical DTO acceptance for actual all-string JSON records, including legacy key names.
 // No source hash/version is synthesized and no nested forbidden key gains acceptance.
 if(Object.values(data).every(value=>typeof value==='string'))return structuredClone(data) as Record<string,string>;
 return decodeJson(data) as Record<string,JsonValue>;
}
