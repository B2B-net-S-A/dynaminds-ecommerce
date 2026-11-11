/** Browser-only exact v1 intake reparse; frozen mapping2 projection unchanged apart from host-free byte/CSV dependencies. */
import {z} from 'zod';
import {SaxesParser} from 'saxes';
import {catalogXmlPathValid} from '../../../shared/catalog-xml-path';
import {parseCatalogCsvRecords} from '../../pim/legacy-files/v2/browser-parse';
import type {Value} from '../../pim/dictionaries/contract2';
import {same} from '../../pim/batch/model';
export const LIMITS={bytes:1048576,rows:500,fields:50,xml_depth:16,xml_nodes:100000} as const;
export class MappingError extends Error{constructor(readonly code:string,readonly row:number|null=null,readonly field:string|null=null){super(code);this.name='MappingError';}}
function check(condition:unknown,code:string,row:number|null=null,field:string|null=null):asserts condition{if(!condition)throw new MappingError(code,row,field);}
const uuid=z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),selector=z.string().min(1).max(1024),tokens=z.array(z.string().max(500)).max(200);
const product=z.discriminatedUnion('encoding',[
 z.strictObject({encoding:z.literal('uuid'),source:selector}),
 z.strictObject({encoding:z.literal('explicit'),source:selector,entries:z.array(z.strictObject({legacy:z.string().max(500),product_id:uuid})).min(1).max(500)}),
]);
const category=z.discriminatedUnion('encoding',[
 z.strictObject({encoding:z.literal('uuid_or_empty'),source:selector}),
 z.strictObject({encoding:z.literal('explicit'),source:selector,entries:z.array(z.strictObject({legacy:z.string().max(500),category_id:uuid.nullable()})).min(1).max(500)}),
]);
const base={source:selector,json_key:z.string().min(1).max(80).optional(),definition_id:uuid,missing:z.enum(['reject','unset']),unset_tokens:tokens};
const field=z.discriminatedUnion('kind',[
 z.strictObject({...base,kind:z.literal('text')}),z.strictObject({...base,kind:z.literal('decimal')}),
 z.strictObject({...base,kind:z.literal('boolean'),tokens:z.array(z.strictObject({legacy:z.string().max(500),value:z.boolean()})).min(1).max(200)}),
 z.strictObject({...base,kind:z.literal('enum'),tokens:z.array(z.strictObject({legacy:z.string().max(500),option_id:uuid})).min(1).max(200)}),
]);
export const mappingInput=z.strictObject({catalog_id:uuid,catalog_source:selector.nullable(),product,category,fields:z.array(field).max(50)});
export type Mapping=z.infer<typeof mappingInput>;
export type FileInput={format:'csv';content:string|Uint8Array;delimiter:','|';'|'\t'|'|'}|{format:'xml';content:string|Uint8Array;record_path:string};
type Node={name:string;attributes:Record<string,string>;text:string;children:Node[]};
type RecordRow={original:Record<string,string>|Node;read:(source:string)=>string|undefined;attributes:(source:string)=>Record<string,string>|undefined;unmapped:(used:Set<string>)=>string[]};
export type IntakeRow={index:number;product_id:string;category_id:string|null;values:Value[];original:Record<string,string>|Node;unmapped_fields:string[]};
export type Intake={schema:'legacy-pim-intake/v1';catalog_id:string;format:'csv'|'xml';parse_config:{format:'csv';delimiter:','|';'|'\t'|'|'}|{format:'xml';record_path:string};original_file:string;mapping:Mapping;rows:IntakeRow[]};
const forbidden=new Set(['__proto__','constructor','prototype']);
function safe(raw:unknown,depth=0):void{check(depth<=20,'mapping_depth');if(Array.isArray(raw))for(const child of raw)safe(child,depth+1);else if(raw&&typeof raw==='object')for(const[key,value]of Object.entries(raw)){check(!forbidden.has(key),'forbidden_key');safe(value,depth+1);}}
function text(input:string|Uint8Array):string{let out:string;try{out=typeof input==='string'?input:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(input);}catch{throw new MappingError('utf8');}
 check(new TextEncoder().encode(out).byteLength<=LIMITS.bytes,'file_bytes');check(!out.includes('\0')&&new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(new TextEncoder().encode(out))===out,'unicode');return out;}
function unique(xs:string[],code:string):void{check(new Set(xs).size===xs.length,code);}
function parseMapping(raw:unknown,format:FileInput['format']):Mapping{safe(raw);const result=mappingInput.safeParse(raw);check(result.success,'mapping_shape');const m=result.data;check(new TextEncoder().encode(JSON.stringify(m)).byteLength<=LIMITS.bytes,'mapping_bytes');
 unique(m.fields.map(f=>f.definition_id),'duplicate_definition');unique(m.fields.map(f=>JSON.stringify([f.source,f.json_key??null])),'duplicate_selector');for(const f of m.fields)if(f.json_key!==undefined)check(!forbidden.has(f.json_key),'forbidden_key');
 for(const f of m.fields){unique(f.unset_tokens,'duplicate_unset_token');if(f.kind==='boolean'||f.kind==='enum'){unique(f.tokens.map(t=>t.legacy),'duplicate_token');check(!f.tokens.some(t=>f.unset_tokens.includes(t.legacy)),'ambiguous_token');}}
 for(const id of[m.product,m.category])if(id.encoding==='explicit')unique(id.entries.map(e=>e.legacy),'duplicate_identity_token');
 for(const source of[...(m.catalog_source===null?[]:[m.catalog_source]),m.product.source,m.category.source,...m.fields.map(f=>f.source)])check(format==='xml'?catalogXmlPathValid(source,false,LIMITS.xml_depth):!forbidden.has(source)&&!/[\x00-\x1f\x7f]/.test(source),'invalid_selector');return m;}
function attributeObject(raw:unknown):Record<string,string>{safe(raw);check(raw&&typeof raw==='object'&&!Array.isArray(raw),'attributes_shape');const x=raw as Record<string,unknown>;check(Object.keys(x).length<=50&&Object.keys(x).every(k=>k.length>=1&&k.length<=80)&&Object.values(x).every(v=>typeof v==='string'),'attributes_shape');return x as Record<string,string>;}
function attributeJson(text:string):Record<string,string>{let raw:unknown;try{raw=JSON.parse(text);}catch{throw new MappingError('attributes_json');}return attributeObject(raw);}
function csvRecords(content:string,delimiter:Extract<FileInput,{format:'csv'}>['delimiter']):RecordRow[]{check([',',';','\t','|'].includes(delimiter),'delimiter');const[header,...rows]=parseCatalogCsvRecords(content.replace(/^\ufeff/,''),delimiter);
 check(header?.length&&header.length<=1000,'csv_header');check(header.every(h=>h.length>0&&!forbidden.has(h)),'csv_header');unique(header.map(h=>h.toLowerCase()),'duplicate_header');check(rows.length>=1&&rows.length<=LIMITS.rows,'row_count');
 return rows.map((values,index)=>{check(values.length===header.length,'csv_columns',index);const original=Object.fromEntries(header.map((h,i)=>[h,values[i]]));return{original,read:source=>Object.hasOwn(original,source)?original[source]:undefined,attributes:source=>Object.hasOwn(original,source)?attributeJson(original[source]):undefined,unmapped:used=>header.filter(h=>!used.has(h)).sort()};});}
function xmlRecords(content:string,path:string):RecordRow[]{check(catalogXmlPathValid(path,true,LIMITS.xml_depth),'record_path');check(!/<!\s*(DOCTYPE|ENTITY)/i.test(content),'xml_dtd');const stack:Node[]=[],records:Node[]=[];let nodes=0,root:Node|undefined;const count=()=>check(++nodes<=LIMITS.xml_nodes,'xml_nodes');const parser=new SaxesParser({xmlns:true});
 parser.on('error',()=>{throw new MappingError('xml_syntax');});parser.on('doctype',()=>{throw new MappingError('xml_dtd');});parser.on('processinginstruction',()=>{throw new MappingError('xml_processing_instruction');});parser.on('comment',count);
 parser.on('opentag',tag=>{count();check(stack.length<LIMITS.xml_depth,'xml_depth');check(tag.name.split(':').every(x=>!forbidden.has(x)),'xml_name');const attributes:Record<string,string>=Object.create(null);
  for(const attr of Object.values(tag.attributes)){count();check(typeof attr!=='string','xml_attribute');check(attr.name.split(':').every(x=>!forbidden.has(x)),'xml_name');attributes[attr.name]=attr.value;}
  const n:Node={name:tag.name,attributes,text:'',children:[]};if(stack.length)stack.at(-1)!.children.push(n);else{check(!root,'xml_root');root=n;}stack.push(n);
  if('/'+stack.map(x=>x.name).join('/')===path){records.push(n);check(records.length<=LIMITS.rows,'row_count');}
 });
 const add=(value:string)=>{count();if(stack.length)stack.at(-1)!.text+=value;else check(!value.trim(),'xml_outside_text');};parser.on('text',add);parser.on('cdata',add);parser.on('closetag',()=>{stack.pop();});parser.write(content).close();check(root&&records.length>=1,'xml_record_scope');
 function nodeAt(n:Node,source:string):Node|undefined{const parts=source.split('/');let current=[n];for(const part of parts){check(!part.startsWith('@'),'attributes_container');current=current.flatMap(x=>x.children.filter(c=>c.name===part));check(current.length<=1,'ambiguous_xml_path');}return current[0];}
 function pick(n:Node,source:string):string|undefined{const parts=source.split('/');let current=[n];for(const[p,part]of parts.entries()){if(part.startsWith('@')){check(p===parts.length-1,'invalid_selector');check(current.length<=1,'ambiguous_xml_path');return current[0]?.attributes[part.slice(1)];}current=current.flatMap(x=>x.children.filter(c=>c.name===part));check(current.length<=1,'ambiguous_xml_path');}const node=current[0];if(!node)return undefined;check(!node.children.length,'xml_nonscalar');return node.text;}
 function leaves(n:Node,prefix=''):string[]{return[...Object.keys(n.attributes).map(a=>prefix+'@'+a),...n.children.flatMap(c=>c.children.length?leaves(c,prefix+c.name+'/'):[prefix+c.name,...Object.keys(c.attributes).map(a=>prefix+c.name+'/@'+a)])];}
 return records.map(n=>({original:n,read:source=>pick(n,source),attributes:source=>{const container=nodeAt(n,source);if(!container)return undefined;if(!container.children.length)return attributeJson(container.text);check(same(container.attributes,{type:'object'})&&!container.text.trim(),'attributes_shape');const entries:Record<string,string>=Object.create(null);for(const e of container.children){check(e.name==='entry'&&Object.keys(e.attributes).sort().join(',')==='key,type'&&e.attributes.type==='string'&&!e.children.length&&!Object.hasOwn(entries,e.attributes.key),'attributes_shape');entries[e.attributes.key]=e.text;}return attributeObject(entries);},unmapped:used=>[...new Set(leaves(n))].filter(p=>!used.has(p)).sort()}));}
/** Full-file parse and explicit token mapping only: never trusts file versions/hash or guesses labels/SKU. */
export function parseLegacyIntake(file:FileInput,rawMapping:unknown):Intake{check(file.format==='csv'||file.format==='xml','format');const original=text(file.content),mapping=parseMapping(rawMapping,file.format),records=file.format==='csv'?csvRecords(original,file.delimiter):xmlRecords(original,file.record_path);const used=new Set([...(mapping.catalog_source===null?[]:[mapping.catalog_source]),mapping.product.source,mapping.category.source,...mapping.fields.map(f=>f.source)]);
 const rows=records.map((r,index):IntakeRow=>{if(mapping.catalog_source!==null)check(r.read(mapping.catalog_source)===mapping.catalog_id,'foreign_catalog',index);const p=r.read(mapping.product.source),c=r.read(mapping.category.source);check(p!==undefined,'missing_product',index);check(c!==undefined,'missing_category',index);
  const pid=mapping.product.encoding==='uuid'?p:mapping.product.entries.find(x=>x.legacy===p)?.product_id;check(uuid.safeParse(pid).success,'unmapped_product',index);
  const cid=mapping.category.encoding==='uuid_or_empty'?(c===''?null:c):mapping.category.entries.find(x=>x.legacy===c)?.category_id;check(cid===null||uuid.safeParse(cid).success,'unmapped_category',index);
  const values:Value[]=[];for(const f of mapping.fields){const attributes=f.json_key===undefined?undefined:r.attributes(f.source);const raw=f.json_key===undefined?r.read(f.source):attributes&&Object.hasOwn(attributes,f.json_key)?attributes[f.json_key]:undefined;if(raw===undefined){check(f.missing==='unset','missing_value',index,f.source);continue;}if(f.unset_tokens.includes(raw))continue;
   if(f.kind==='text'||f.kind==='decimal')values.push({definition_id:f.definition_id,kind:f.kind,value:raw});else{const token=f.tokens.find(t=>t.legacy===raw);check(token,'unmapped_value',index,f.source);values.push(f.kind==='boolean'?{definition_id:f.definition_id,kind:'boolean',value:(token as{value:boolean}).value}:{definition_id:f.definition_id,kind:'enum',option_id:(token as{option_id:string}).option_id});}}
  return{index,product_id:pid!,category_id:cid!,values:values.sort((a,b)=>a.definition_id.localeCompare(b.definition_id)),original:structuredClone(r.original),unmapped_fields:[...r.unmapped(used),...[...new Set(mapping.fields.filter(f=>f.json_key!==undefined).map(f=>f.source))].flatMap(source=>Object.keys(r.attributes(source)??{}).filter(key=>!mapping.fields.some(f=>f.source===source&&f.json_key===key)).map(key=>source+'/json-key:'+key))].sort()};
 });unique(rows.map(r=>r.product_id),'duplicate_product');return{schema:'legacy-pim-intake/v1',catalog_id:mapping.catalog_id,format:file.format,parse_config:file.format==='csv'?{format:'csv',delimiter:file.delimiter}:{format:'xml',record_path:file.record_path},original_file:original,mapping,rows};}

/** Original identity tokens, never guessed UUIDs; bind by actual durable execution ordinal. */
export function legacyProductTokens(file:FileInput,source:string):string[]{const content=text(file.content),records=file.format==='csv'?csvRecords(content,file.delimiter):xmlRecords(content,file.record_path);return records.map((r,i)=>{const token=r.read(source);check(typeof token==='string','missing_product',i);return token;});}
