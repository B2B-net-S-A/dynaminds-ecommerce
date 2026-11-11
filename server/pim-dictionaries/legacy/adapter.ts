/** SOURCE_ONLY. Inject authenticated GET ports; no app/db import, request mutation or business POST. */
import {z} from 'zod';
import {catalogFileImportPreviewInput,type CatalogFileImportInput} from '../../catalog-file-import-schema';
import {assertCatalogImportJson,parseCatalogFileImport} from '../../catalog-file-import-parse';
import {mappingInput,parseLegacyIntake,prepareAfterSourceReads,LIMITS,type FileInput,type Prepared} from './mapping';
import type {Dictionary,ProductSource} from '../contract2';
import {same} from './batch-codec';
const uuid=z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
export class HandoffError extends Error {constructor(readonly code:string){super(code);this.name='HandoffError';}}
function check(v:unknown,code:string):asserts v {if(!v)throw new HandoffError(code);}
export const typedMappingTemplateInput=mappingInput.omit({product:true}).extend({product_source:z.string().min(1).max(1024)});
export type TypedMappingTemplate=z.infer<typeof typedMappingTemplateInput>;
type OriginalIdentity={index:number;raw:string;normalized:string};
export type RetainedCorePimFile={schema:'core-file-pim-handoff/v1';original_request:unknown;core_request:CatalogFileImportInput;config:Record<string,unknown>;file:FileInput;typed_mapping:TypedMappingTemplate;identities:OriginalIdentity[]};
const count=z.number().int().min(0).max(500);
const headShape=z.object({id:uuid,actor_id:uuid,scope_hash:z.string().regex(/^[a-f0-9]{64}$/),config:z.record(z.string(),z.unknown()),total:count.min(1),created:count,updated:count,unchanged:count,invalid:z.literal(0),ready:z.literal(true),created_at:z.string().refine(s=>Number.isFinite(Date.parse(s)))}).passthrough();
const previewHeadShape=headShape;
const executionHeadShape=headShape.extend({preview_id:uuid,state:z.literal('done')});
export type BoundCorePimFile={schema:'approved-core-file-pim-handoff/v1';retained:RetainedCorePimFile;preview:Record<string,unknown> & z.infer<typeof previewHeadShape>};
function freeze<T>(x:T):T {if(x&&typeof x==='object'){for(const value of Object.values(x))freeze(value);Object.freeze(x);}return x;}
function normalizedConfig(q:CatalogFileImportInput):Record<string,unknown>{const {content:_content,client_key:_key,...config}=q;return config;}
/** Explicit current mapping opt-in: retain supplied original request and bytes, never append fields to the core request. */
export function retainCorePimFile(rawCoreRequest:unknown,rawTypedMapping:unknown):RetainedCorePimFile {
 assertCatalogImportJson(rawCoreRequest);assertCatalogImportJson(rawTypedMapping);
 const q=catalogFileImportPreviewInput.parse(structuredClone(rawCoreRequest));
 q.client_key=q.client_key.toLowerCase();q.warehouse_id=q.warehouse_id.toLowerCase();if(q.catalog_id)q.catalog_id=q.catalog_id.toLowerCase();
 const typed=typedMappingTemplateInput.parse(structuredClone(rawTypedMapping));
 check(q.catalog_id===typed.catalog_id,'explicit_catalog_required');check(Buffer.byteLength(q.content,'utf8')<=LIMITS.bytes,'file_bytes');
 const source=q.xml_mapping?q.xml_mapping.fields[q.identity]?.path:(q.mapping[q.identity]??q.identity);
 check(typed.product_source===source,'core_identity_selector');
 if(q.xml_mapping)check(q.xml_mapping.fields[q.identity]?.value_type==='text','identity_text_required');
 const file:FileInput=q.format==='csv'?{format:'csv',content:q.content,delimiter:q.delimiter}:{format:'xml',content:q.content,record_path:q.xml_mapping?.record_path??'/catalog/product'};
 const parsed=parseCatalogFileImport(q);check(parsed.rows.length>=1&&parsed.rows.length<=LIMITS.rows,'row_count');
 const identities=parsed.rows.map((row,index)=>{check(row.errors.length===0,'core_parse_errors');const value=row.fields[q.identity];check(typeof value==='string'&&value.length<=500,'identity_text_required');const normalized=q.identity==='id'?z.uuid().parse(value).toLowerCase():value.trim();check(normalized.length>0,'empty_identity');return{index,raw:value,normalized};});
 check(new Set(identities.map(x=>x.raw)).size===identities.length&&new Set(identities.map(x=>x.normalized)).size===identities.length,'duplicate_identity');
 return freeze({schema:'core-file-pim-handoff/v1',original_request:structuredClone(rawCoreRequest),core_request:q,config:normalizedConfig(q),file,typed_mapping:typed,identities});
}
function verifyRetained(retained:RetainedCorePimFile):void {check(same(retainCorePimFile(retained.original_request,retained.typed_mapping),retained),'retained_drift');}
/** The port caller passes the actual core preview head; this helper does not fabricate/authenticate a receipt. */
export function bindApprovedCorePreview(retained:RetainedCorePimFile,actualHead:unknown):BoundCorePimFile {
 verifyRetained(retained);const head=previewHeadShape.parse(actualHead);
 check(head.total===retained.identities.length&&head.created+head.updated+head.unchanged===head.total,'preview_counts');check(same(head.config,retained.config),'preview_config');
 return freeze({schema:'approved-core-file-pim-handoff/v1',retained:structuredClone(retained),preview:structuredClone(head)});
}
const version=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const rowShape=z.object({index:count.max(499),product_id:uuid,operation:z.enum(['create','update','unchanged']),identity_value:z.string(),before:z.record(z.string(),z.unknown()).nullable(),after:z.record(z.string(),z.unknown()),before_version:version.nullable(),after_version:version,errors:z.array(z.unknown()).length(0)}).passthrough();
const pageShape=z.object({available:z.literal(true),can_read:z.literal(true),execution:executionHeadShape,rows:z.array(rowShape).min(1).max(100),meta:z.strictObject({cursor:z.string().regex(/^(?:0|[1-9][0-9]{0,2})$/).nullable()})}).passthrough();
export type StagePorts={execution:(executionId:string,cursor?:string)=>Promise<unknown>;dictionary:(catalogId:string)=>Promise<Dictionary>;product:(catalogId:string,productId:string)=>Promise<ProductSource>};
export type StagedCorePimFile={schema:'committed-core-file-pim-stage/v1';execution:{id:string;preview_id:string;scope_hash:string;total:number};prepared:Prepared};
/** ALL immutable done pages must match before the first PIM GET. No PIM POST/consent/apply here. */
export async function stageAfterCommittedExecution(bound:BoundCorePimFile,executionId:string,clientKey:string,ports:StagePorts):Promise<StagedCorePimFile> {
 uuid.parse(executionId);uuid.parse(clientKey);check(same(bindApprovedCorePreview(bound.retained,bound.preview),bound),'bound_drift');
 let cursor:string|undefined;let originalHead:z.infer<typeof executionHeadShape>|undefined;const rows:Array<z.infer<typeof rowShape>>=[];
 for(let pageIndex=0;pageIndex<5;pageIndex++){
  const rawPage=await ports.execution(executionId,cursor);check(Buffer.byteLength(JSON.stringify(rawPage),'utf8')<=4194304,'execution_page_bytes');const page=pageShape.parse(rawPage);const head=page.execution;
  check(head.id===executionId&&head.preview_id===bound.preview.id&&head.actor_id===bound.preview.actor_id&&head.scope_hash===bound.preview.scope_hash,'execution_identity');
  check(same(head.config,bound.retained.config),'execution_config');for(const key of ['total','created','updated','unchanged'] as const)check(head[key]===bound.preview[key],'execution_counts');
  if(originalHead)check(same(originalHead,head),'execution_head_drift');else originalHead=head;
  for(const row of page.rows){check(row.index===rows.length,'execution_ordinal');const identity=bound.retained.identities[row.index];check(identity&&row.identity_value===identity.normalized,'execution_identity_value');check(row.after.id===row.product_id&&row.after.version===row.after_version,'execution_after');
   if(row.operation==='create')check(row.before===null&&row.before_version===null&&row.after_version===1,'execution_create');
   else check(row.before!==null&&row.before.id===row.product_id&&row.before.version===row.before_version&&row.before_version!==null&&row.after_version===row.before_version+(row.operation==='update'?1:0),'execution_versions');
   rows.push(row);check(rows.length<=head.total,'execution_overflow');
  }
  if(page.meta.cursor===null){check(rows.length===head.total,'execution_incomplete');break;}
  check(page.rows.length===100&&rows.length<head.total&&page.meta.cursor===String(rows.length),'execution_cursor');cursor=page.meta.cursor;
 }
 check(originalHead&&rows.length===originalHead.total,'execution_incomplete');check(new Set(rows.map(r=>r.product_id)).size===rows.length,'duplicate_product');
 for(const [operation,key]of [['create','created'],['update','updated'],['unchanged','unchanged']] as const)check(rows.filter(row=>row.operation===operation).length===originalHead[key],'execution_operation_counts');
 const {product_source,...template}=bound.retained.typed_mapping;
 const intake=parseLegacyIntake(bound.retained.file,{...template,product:{encoding:'explicit',source:product_source,entries:rows.map(row=>({legacy:bound.retained.identities[row.index].raw,product_id:row.product_id}))}});
 check(intake.rows.every((row,i)=>row.product_id===rows[i].product_id),'typed_ordinal');
 const prepared=await prepareAfterSourceReads(intake,clientKey,{dictionary:ports.dictionary,product:ports.product});
 return{schema:'committed-core-file-pim-stage/v1',execution:{id:executionId,preview_id:originalHead.preview_id,scope_hash:originalHead.scope_hash,total:originalHead.total},prepared};
}
