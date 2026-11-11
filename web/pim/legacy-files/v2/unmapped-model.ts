/** Pure v2 review presentation. No hashes, mapping, transport, custody or mutations. */
import {decodeJson,type JsonValue} from '../../../../shared/pim-json';
import type {Selector} from '../../../../shared/pim-legacy-mapping-v2';
export type UnmappedReview={original:Record<string,JsonValue>;descriptors:string[];fields:{descriptor:string;selector:Selector;label:string;value:JsonValue;summary:string}[]};
/** JSON quoting here quotes individual literal names, never interprets dots/slashes/brackets. */
export function readableSelectorLabel(s:Selector):string{return 'Pole '+JSON.stringify(s.source)+s.path.map(x=>x.kind==='key'?' → klucz '+JSON.stringify(x.key):' → element ['+x.index+']').join('');}
export function keptValueLabel(value:JsonValue):string{
 if(value===null)return 'Jawny null';
 if(typeof value==='boolean')return value?'Tak (boolean)':'Nie (boolean)';
 if(typeof value==='string')return value===''?'Pusty tekst':'Tekst: '+value;
 if(typeof value==='number')return 'Liczba: '+String(value);
 if(Array.isArray(value))return value.length===0?'Pusta lista':'Zachowana lista ('+value.length+' elementów)';
 return Object.keys(value).length===0?'Pusty obiekt':'Zachowany obiekt ('+Object.keys(value).length+' pól)';
}
/** Review descriptors describe every retained own path, including names too long for mapping.
 * Mapping request selector budgets are intentionally NOT widened. Presence in the same fully
 * validated original tree below constrains the display path; canonical producer spelling is exact. */
function displaySelector(descriptor:string):Selector{
 const decoded=decodeJson(JSON.parse(descriptor),{bytes:2097152});
 if(decoded===null||typeof decoded!=='object'||Array.isArray(decoded)||Object.keys(decoded).sort().join(',')!=='path,source'||typeof decoded.source!=='string'||!Array.isArray(decoded.path))throw Error('unmapped_descriptor_shape');
 const path=decoded.path.map(segment=>{
  if(segment===null||typeof segment!=='object'||Array.isArray(segment))throw Error('unmapped_descriptor_segment');
  if(segment.kind==='key'&&Object.keys(segment).sort().join(',')==='key,kind'&&typeof segment.key==='string')return{kind:'key' as const,key:segment.key};
  if(segment.kind==='index'&&Object.keys(segment).sort().join(',')==='index,kind'&&typeof segment.index==='number'&&Number.isSafeInteger(segment.index)&&segment.index>=0)return{kind:'index' as const,index:segment.index};
  throw Error('unmapped_descriptor_segment');
 });
 const selector={source:decoded.source,path};if(JSON.stringify(selector)!==descriptor)throw Error('noncanonical_unmapped_descriptor');return selector;
}
export function buildUnmappedReview(originalRaw:unknown,descriptorRaw:unknown):UnmappedReview{
 const original=decodeJson(originalRaw);if(original===null||typeof original!=='object'||Array.isArray(original))throw Error('unmapped_original_object');
 const descriptors=decodeJson(descriptorRaw,{bytes:2097152});if(!Array.isArray(descriptors)||descriptors.some(x=>typeof x!=='string'))throw Error('unmapped_descriptors');
 const strings=descriptors as string[];if(new Set(strings).size!==strings.length)throw Error('duplicate_unmapped_descriptor');
 const fields=strings.map(descriptor=>{
  const selector=displaySelector(descriptor);
  let value:JsonValue=original;
  // Traverse the already validated complete tree once; no repeated whole-tree decode per path.
  for(const s of [{kind:'key' as const,key:selector.source},...selector.path]){
   if(s.kind==='key'){if(value===null||typeof value!=='object'||Array.isArray(value)||!Object.hasOwn(value,s.key))throw Error('unmapped_path_missing');value=value[s.key];}
   else{if(!Array.isArray(value)||s.index>=value.length)throw Error('unmapped_path_missing');value=value[s.index];}
  }
  return{descriptor,selector,label:readableSelectorLabel(selector),value,summary:keptValueLabel(value)};
 });
 return{original,descriptors:strings,fields};
}
