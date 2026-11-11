/** SOURCE_DRAFT: browser-safe JSON projection only; no IO, auth, CAS or native authority. */
import {decimalCoefficient} from '../web/pim/dictionaries/model3';
export type JsonValue=null|boolean|number|string|JsonValue[]|{[key:string]:JsonValue};
export type Segment={kind:'key';key:string}|{kind:'index';index:number};
export type Lookup={state:'missing'}|{state:'present';value:JsonValue};
export type Scalar=null|boolean|number|string;
export type Codec={kind:'text'}|{kind:'json_text'}|{kind:'boolean'}|{kind:'decimal_string';scale:number}|{kind:'integer_decimal';scale:number}|{kind:'boolean_tokens';tokens:{source:Scalar;value:boolean}[]}|{kind:'enum';tokens:{source:Scalar;option_id:string}[]};
export type Projected={kind:'text';value:string}|{kind:'decimal';value:string}|{kind:'boolean';value:boolean}|{kind:'enum';option_id:string}|{kind:'unset'};
export class JsonProjectionError extends Error{constructor(readonly code:string){super(code);this.name='JsonProjectionError';}}
function need(v:unknown,code:string):asserts v{if(!v)throw new JsonProjectionError(code);}
const forbidden=new Set(['__proto__','prototype','constructor']);
const validText=(s:string)=>!/[\u0000]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(s);
/** Validate full tree before any projection; never truncates unselected fields. */
export function decodeJson(raw:unknown,limits:{bytes?:number;depth?:number;nodes?:number}={}):JsonValue{
 const maxBytes=limits.bytes??1048576,maxDepth=limits.depth??16,maxNodes=limits.nodes??100000;need(Number.isSafeInteger(maxBytes)&&maxBytes>0&&maxBytes<=2097152&&Number.isSafeInteger(maxDepth)&&maxDepth>=0&&maxDepth<=20&&Number.isSafeInteger(maxNodes)&&maxNodes>0&&maxNodes<=100000,'json_limits');
 let nodes=0;const active=new WeakSet<object>();
 function visit(v:unknown,depth:number):JsonValue{need(++nodes<=maxNodes,'json_nodes');need(depth<=maxDepth,'json_depth');
  if(v===null||typeof v==='boolean')return v;
  if(typeof v==='string'){need(validText(v),'json_unicode');return v;}
  if(typeof v==='number'){need(Number.isFinite(v),'json_number');return v;}
  need(v!==null&&typeof v==='object','json_shape');const o=v as object;need(!active.has(o),'json_cycle');active.add(o);
  try{if(Array.isArray(v)){need(Object.getPrototypeOf(v)===Array.prototype,'json_array_prototype');need(Object.getOwnPropertySymbols(v).length===0&&Object.getOwnPropertyNames(v).length===v.length+1&&Object.keys(v).length===v.length&&Object.keys(v).every((k,i)=>k===String(i)),'json_sparse_or_extra_array');return Array.from({length:v.length},(_unused,i)=>{const d=Object.getOwnPropertyDescriptor(v,String(i));need(d&&'value'in d,'json_accessor');return visit(d!.value,depth+1);});}
   need(Object.getPrototypeOf(o)===Object.prototype||Object.getPrototypeOf(o)===null,'json_object_prototype');need(Object.getOwnPropertySymbols(o).length===0,'json_symbol');const entries=Object.entries(Object.getOwnPropertyDescriptors(o));need(entries.every(([,d])=>d.enumerable&&'value'in d),'json_accessor_or_hidden');
   return Object.fromEntries(entries.map(([key,d])=>{need(validText(key)&&!forbidden.has(key),'json_key');return[key,visit(d.value,depth+1)];}));
  }finally{active.delete(o);}
 }
 const result=visit(raw,0);need(new TextEncoder().encode(JSON.stringify(result)).byteLength<=maxBytes,'json_bytes');return result;
}
/** Key "0" and index 0 differ. Slash/dot keys are literal; no inherited lookup, wildcard or array flatten. */
export function selectJson(raw:unknown,path:readonly Segment[]):Lookup{
 let value=decodeJson(raw);path=decodeJson(path) as Segment[];need(Array.isArray(path)&&path.length<=16,'path_depth');for(const segment of path){need(segment&&typeof segment==='object','path_shape');if(segment.kind==='key')need(Object.keys(segment).sort().join(',')==='key,kind'&&typeof segment.key==='string'&&segment.key.length<=1024&&validText(segment.key)&&!forbidden.has(segment.key),'path_key');else need(segment.kind==='index'&&Object.keys(segment).sort().join(',')==='index,kind'&&Number.isSafeInteger(segment.index)&&segment.index>=0&&segment.index<100000,'path_index');}
 for(const segment of path){need(segment&&typeof segment==='object','path_shape');
  if(segment.kind==='key'){need(Object.keys(segment).sort().join(',')==='key,kind'&&typeof segment.key==='string'&&segment.key.length<=1024&&validText(segment.key)&&!forbidden.has(segment.key),'path_key');need(value!==null&&typeof value==='object'&&!Array.isArray(value),'path_object');if(!Object.hasOwn(value,segment.key))return{state:'missing'};value=value[segment.key];}
  else{need(segment.kind==='index'&&Object.keys(segment).sort().join(',')==='index,kind'&&Number.isSafeInteger(segment.index)&&segment.index>=0&&segment.index<100000,'path_index');need(Array.isArray(value),'path_array');if(segment.index>=value.length)return{state:'missing'};value=value[segment.index];}
 }
 return{state:'present',value};
}
const scalarKey=(v:Scalar)=>JSON.stringify([v===null?'null':typeof v,v]);
/** Null and missing only unset when explicitly selected; false/0/empty are always present. */
export function projectSelected(raw:unknown,path:readonly Segment[],codec:Codec,absence:{missing:'reject'|'unset';null:'reject'|'unset'|'value'}):Projected{
 codec=decodeJson(codec) as Codec;absence=decodeJson(absence) as typeof absence;need(codec&&typeof codec==='object'&&!Array.isArray(codec),'codec_shape');const codecKeys=Object.keys(codec).sort().join(',');need(['text','json_text','boolean'].includes(codec.kind)?codecKeys==='kind':['decimal_string','integer_decimal'].includes(codec.kind)?codecKeys==='kind,scale':['enum','boolean_tokens'].includes(codec.kind)&&codecKeys==='kind,tokens','codec_shape');need(Object.keys(absence).sort().join(',')==='missing,null'&&['reject','unset'].includes(absence.missing)&&['reject','unset','value'].includes(absence.null),'absence_policy');const found=selectJson(raw,path);
 if(found.state==='missing'){need(absence.missing==='unset','missing_value');return{kind:'unset'};}
 const v=found.value;if(v===null){need(absence.null!=='reject','null_value');if(absence.null==='unset')return{kind:'unset'};}
 if(codec.kind==='json_text')return{kind:'text',value:JSON.stringify(v)};
 if(codec.kind==='text'){need(typeof v==='string','text_scalar');return{kind:'text',value:v as string};}
 if(codec.kind==='boolean'){need(typeof v==='boolean','boolean_scalar');return{kind:'boolean',value:v as boolean};}
 if(codec.kind==='decimal_string'){need(typeof v==='string','decimal_string');try{decimalCoefficient(v,codec.scale);}catch{throw new JsonProjectionError('decimal_canonical');}return{kind:'decimal',value:v as string};}
 if(codec.kind==='integer_decimal'){need(typeof v==='number'&&Number.isSafeInteger(v)&&!Object.is(v,-0),'decimal_unsafe_number');need(Number.isSafeInteger(codec.scale)&&codec.scale>=0&&codec.scale<=6,'decimal_scale');const value=String(v)+(codec.scale?'.'+'0'.repeat(codec.scale):'');try{decimalCoefficient(value,codec.scale);}catch{throw new JsonProjectionError('decimal_canonical');}return{kind:'decimal',value};}
 if(codec.kind==='boolean_tokens'){need(Array.isArray(codec.tokens)&&codec.tokens.length>=1&&codec.tokens.length<=200,'boolean_tokens');need(v===null||['boolean','number','string'].includes(typeof v),'boolean_token_scalar');const keys=codec.tokens.map(t=>{need(t&&typeof t==='object'&&Object.keys(t).sort().join(',')==='source,value'&&typeof t.value==='boolean','boolean_token_shape');const x=decodeJson(t.source);need(x===null||['boolean','number','string'].includes(typeof x),'boolean_token_scalar');return scalarKey(x as Scalar);});need(new Set(keys).size===keys.length,'duplicate_boolean_token');const i=keys.indexOf(scalarKey(v as Scalar));need(i>=0,'unmapped_boolean_token');return{kind:'boolean',value:codec.tokens[i].value};}
 need(codec.kind==='enum'&&Array.isArray(codec.tokens)&&codec.tokens.length>=1&&codec.tokens.length<=200,'enum_shape');need(v===null||['boolean','number','string'].includes(typeof v),'enum_scalar');
 const keys=codec.tokens.map(t=>{need(t&&typeof t==='object'&&Object.keys(t).sort().join(',')==='option_id,source','enum_token_shape');const x=decodeJson(t.source);need(x===null||['boolean','number','string'].includes(typeof x),'enum_token_scalar');need(typeof t.option_id==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(t.option_id),'enum_option_uuid');return scalarKey(x as Scalar);});need(new Set(keys).size===keys.length,'duplicate_enum_token');const index=keys.indexOf(scalarKey(v as Scalar));need(index>=0,'unmapped_enum_token');return{kind:'enum',option_id:codec.tokens[index].option_id};
}
