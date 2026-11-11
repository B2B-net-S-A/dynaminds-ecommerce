/** Pure serialization only: no application, database, worker, or storage imports. */
import {createHash} from 'node:crypto';
import {catalogFileImportPreviewInput, CATALOG_FILE_IMPORT_LIMITS, type CatalogFileImportInput} from '../../../server/catalog-file-import-schema';
import {parseCatalogFileImport} from '../../../server/catalog-file-import-parse';
import type {Batch, Manifest, XmlNode} from '../pim-large-import-stream-foundation-ui2/stream';

export const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Semantic equality for native JSONB DTOs; parser batch ID hashing remains exact ordered JSON above. */
export function canonicalDigest(value:unknown):string{const sorted=(v:unknown):unknown=>Array.isArray(v)?v.map(sorted):v!==null&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>[k,sorted(x)])):v;return digest(sorted(value));}
export function need(condition:unknown, code:string):asserts condition {if(!condition)throw new Error(code);}
export type CoreConfig=Omit<CatalogFileImportInput,'client_key'|'format'|'content'>;
const xmlText=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const xmlAttribute=(s:string)=>xmlText(s).replaceAll('"','&quot;').replaceAll('\r','&#13;').replaceAll('\n','&#10;').replaceAll('\t','&#9;');
function opening(n:{name:string;attributes:Record<string,string>}){need(/^[A-Za-z_][\w.:-]*$/.test(n.name),'xml-name');return '<'+n.name+Object.entries(n.attributes).map(([k,v])=>{need(/^[A-Za-z_][\w.:-]*$/.test(k)&&typeof v==='string','xml-attribute');return ' '+k+'="'+xmlAttribute(v)+'"';}).join('')+'>';}
function element(n:XmlNode):string{return opening(n)+n.content.map(p=>p.type==='element'?element(p.element):xmlText(p.value)).join('')+'</'+n.name+'>';}
const cell=(s:string,delimiter:string)=>{need(typeof s==='string','csv-cell');return /["\r\n]/.test(s)||s.includes(delimiter)?'"'+s.replaceAll('"','""')+'"':s;};

/** Retains every source field. Unsupported core fields refuse; they are never silently dropped. */
export function serializeNativeBatch(manifest:Manifest,batch:Batch,config:CoreConfig,clientKey:string){
 need(batch.schema==='large-core-import-parser-batch/v1'&&batch.provisional===true,'batch-schema');
 need(batch.records.length>=1&&batch.records.length<=CATALOG_FILE_IMPORT_LIMITS.rows,'native-rows');
 let content:string;
 if(manifest.format==='csv'){
  need(manifest.header&&manifest.raw_header&&manifest.header.length===manifest.raw_header.length,'csv-header');
  const delimiter=config.delimiter??',';
  content=[manifest.raw_header.map(s=>cell(s,delimiter)).join(delimiter),...batch.records.map(r=>{need(r.data.format==='csv'&&digest(r.data.header)===digest(manifest.header),'csv-header-drift');need(r.data.cells.length===manifest.header!.length,'csv-cells');return r.data.cells.map(s=>cell(s,delimiter)).join(delimiter);})].join('\n');
 }else{
  const first=batch.records[0].data;need(first.format==='xml'&&first.ancestors.length>0,'xml-ancestors');
  content=first.ancestors.map(opening).join('')+batch.records.map(r=>{need(r.data.format==='xml'&&digest(r.data.ancestors)===digest(first.ancestors),'xml-context-drift');return element(r.data.element);}).join('')+first.ancestors.slice().reverse().map(a=>'</'+a.name+'>').join('');
 }
 need(Buffer.byteLength(content,'utf8')<=CATALOG_FILE_IMPORT_LIMITS.file_bytes,'native-file-bytes');
 const parsedRequest=catalogFileImportPreviewInput.parse({...config,client_key:clientKey,format:manifest.format,content}),request={...parsedRequest,client_key:parsedRequest.client_key.toLowerCase(),warehouse_id:parsedRequest.warehouse_id.toLowerCase(),...(parsedRequest.catalog_id?{catalog_id:parsedRequest.catalog_id.toLowerCase()}: {})};
 need(Buffer.byteLength(JSON.stringify(request),'utf8')<=CATALOG_FILE_IMPORT_LIMITS.request_bytes,'native-request-bytes');
 const parsed=parseCatalogFileImport(request);need(parsed.rows.length===batch.records.length,'native-row-count');
 need(parsed.rows.every(r=>r.errors.length===0),'native-unknown-fields');
 need(!parsed.currency||parsed.currency===request.currency,'native-currency');
 const identities=parsed.rows.map(r=>{const value=r.fields[request.identity];need(typeof value==='string'&&value.trim(),'native-identity');const trimmed=value.trim();if(request.identity==='id')need(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(trimmed),'native-identity-uuid');return request.identity==='id'?trimmed.toLowerCase():trimmed;});
 return {request,identities,parsed};
}
