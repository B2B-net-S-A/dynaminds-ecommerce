import {pimLegacyStageVersionedInput as pimLegacyStageInput} from './legacy/v2/stage-dispatch';
import {extendStageOpenApiV2,nestedLegacyJsonSchema} from './legacy/v2/openapi';
import {mappingInput} from './legacy/mapping';
/** Pure API documentation/input codecs. Native source, IAM and semantic closure
 * remain authoritative; this module evaluates no app/db/provider code. */
import {z} from 'zod';
import {PIM_LIMITS} from './contract2';
type Schema=Record<string,any>;
const uuid={type:'string',format:'uuid',pattern:'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'};
const hash={type:'string',pattern:'^[a-f0-9]{64}$'};
const version={type:'string',pattern:'^(0|[1-9][0-9]{0,18})$',description:'Canonical decimal string bounded by native signed int64 (9223372036854775807). No numeric JSON coercion.'};
const positiveVersion={...version,pattern:'^[1-9][0-9]{0,18}$'};
const utc6={type:'string',format:'date-time',pattern:'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{6}Z$'};
const bool={type:'boolean'},text={type:'string'};
const nullable=(schema:Schema):Schema=>({anyOf:[schema,{type:'null'}]});
const object=(properties:Record<string,Schema>):Schema=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const array=(items:Schema,maxItems:number):Schema=>({type:'array',items,maxItems});
const revision=object({catalog_version:positiveVersion,dictionary_version:version,schema_hash:hash});
const binding=object({definition_id:uuid,required:bool});
const resolvedBinding=object({definition_id:uuid,required:bool,inherited_from:array(uuid,PIM_LIMITS.category_depth)});
const label={type:'string',minLength:2,maxLength:120};
const decimal={type:'string',maxLength:26,description:'Canonical fixed-scale decimal string. Native definition fixes scale0–6, unit, bounds and18-digit integral budget; no floats, exponent or negative zero.'};
const shape={oneOf:[
 object({kind:{const:'text'},max_length:{type:'integer',minimum:1,maximum:500}}),
 object({kind:{const:'decimal'},scale:{type:'integer',minimum:0,maximum:6},unit:nullable({type:'string',minLength:1,maxLength:32}),minimum:nullable(decimal),maximum:nullable(decimal)}),
 object({kind:{const:'boolean'}}),
 object({kind:{const:'enum'},options:{...array(object({id:uuid,label,active:bool}),PIM_LIMITS.options_per_enum),minItems:1}}),
]};
const value={oneOf:[
 object({definition_id:uuid,kind:{const:'text'},value:{type:'string',maxLength:500,description:'Optional empty text is distinct from unset. Native required bindings reject ECMAScript-whitespace-only text; max lengths count UTF16 units.'}}),
 object({definition_id:uuid,kind:{const:'decimal'},value:decimal}),
 object({definition_id:uuid,kind:{const:'boolean'},value:{...bool,description:'false is a supplied valid boolean, not unset.'}}),
 object({definition_id:uuid,kind:{const:'enum'},option_id:uuid}),
]};
const category=object({id:uuid,version:positiveVersion,parent_id:nullable(uuid),name:label,active:bool,bindings:array(binding,PIM_LIMITS.bindings_per_category)});
const definition=object({id:uuid,version:positiveVersion,name:label,active:bool,shape});
const capabilities={available:bool,read_only:bool,can_manage:bool};
const limits=object(Object.fromEntries(Object.entries(PIM_LIMITS).map(([key,number])=>[key,{const:number}])));
const dictionary=object({...capabilities,catalog_id:uuid,revision,categories:array(category,PIM_LIMITS.categories),definitions:array(definition,PIM_LIMITS.definitions),effective_bindings:array(object({category_id:uuid,definitions:array(resolvedBinding,PIM_LIMITS.bindings_per_category)}),PIM_LIMITS.categories),limits});
const productRow=object({product_id:uuid,product_version:positiveVersion,state_version:version,source_hash:hash,category_id:nullable(uuid),values:array(value,PIM_LIMITS.values_per_product)});
const product=object({...capabilities,catalog_id:uuid,product_id:uuid,sku:text,name:text,revision,product_version:positiveVersion,state_version:version,source_hash:hash,category_id:nullable(uuid),values:array(value,PIM_LIMITS.values_per_product),legacy:object({category:text,attributes:{type:'object',additionalProperties:nestedLegacyJsonSchema}}),effective_bindings:array(resolvedBinding,PIM_LIMITS.bindings_per_category)});
const change={oneOf:[
 object({kind:{const:'category_create'},id:uuid,parent_id:nullable(uuid),name:text}),
 object({kind:{const:'category_update'},id:uuid,version:positiveVersion,parent_id:nullable(uuid),name:text,active:bool}),
 object({kind:{const:'definition_create'},id:uuid,name:text,shape}),
 object({kind:{const:'definition_update'},id:uuid,version:positiveVersion,name:text,active:bool,shape}),
 object({kind:{const:'category_bindings'},id:uuid,version:positiveVersion,bindings:array(binding,PIM_LIMITS.bindings_per_category)}),
]};
const previewRequest={oneOf:[
 object({kind:{const:'dictionary'},client_key:uuid,revision,changes:{...array(change,PIM_LIMITS.dictionary_changes),minItems:1}}),
 object({kind:{const:'product_values'},client_key:uuid,revision,rows:{...array(productRow,PIM_LIMITS.product_rows),minItems:1}}),
]};
const preview=object({...capabilities,id:uuid,catalog_id:uuid,actor_id:uuid,kind:{enum:['dictionary','product_values']},client_key:uuid,revision,request:previewRequest,scope_hash:hash,created_at:utc6,expires_at:utc6,ready:bool,can_apply:bool,reused:bool,operation_id:nullable(uuid),errors:array(object({row:{type:'integer',minimum:0,maximum:499},field:text,code:text,definition_id:nullable(uuid)}),500),product_rows:array(object({index:{type:'integer',minimum:0,maximum:499},before:product,after:productRow,changed:bool}),PIM_LIMITS.product_rows),dictionary_before:nullable(dictionary),dictionary_after:nullable(dictionary)});
const operation=object({...capabilities,id:uuid,preview_id:uuid,catalog_id:uuid,actor_id:uuid,kind:{enum:['dictionary','product_values']},scope_hash:hash,created_at:utc6,reused:bool,changed_count:{type:'integer',minimum:0,maximum:500},product_rows:array(object({product_id:uuid,before:productRow,after:productRow}),PIM_LIMITS.product_rows),dictionary_before:nullable(dictionary),dictionary_after:nullable(dictionary)});
const history=object({data:array(object({id:uuid,kind:{enum:['dictionary','product_values']},created_at:utc6,operation_id:nullable(uuid),ready:bool}),50),meta:object({cursor:nullable(uuid),limit:{const:50}})});
const rawIntakeValue={oneOf:[object({definition_id:uuid,kind:{const:'text'},value:{type:'string',maxLength:1048576}}),object({definition_id:uuid,kind:{const:'decimal'},value:{type:'string',maxLength:1048576}}),object({definition_id:uuid,kind:{const:'boolean'},value:bool}),object({definition_id:uuid,kind:{const:'enum'},option_id:uuid})]};
const stageIntake=object({schema:{const:'legacy-pim-intake/v1'},catalog_id:uuid,format:{enum:['csv','xml']},parse_config:{oneOf:[object({format:{const:'csv'},delimiter:{enum:[',',';','	','|']}}),object({format:{const:'xml'},record_path:text})]},original_file:{type:'string',description:'Caller supplied bytes; no historical byte authentication.'},mapping:z.toJSONSchema(mappingInput,{io:'input',unrepresentable:'any'}),rows:array(object({index:{type:'integer',minimum:0,maximum:499},product_id:uuid,category_id:nullable(uuid),values:array(rawIntakeValue,50),original:{type:'object',description:'Detached full caller CSV record or XML node, unchanged by mapping.',additionalProperties:true},unmapped_fields:{type:'array',items:text,description:'All unmapped selectors; complete response2MiB budget, no silently truncated list.'}}),500)});
const editorSource=object({dictionary,product});
export const pimResponseSchemas={dictionary,product,editorSource,preview,operation,history};
const inputUuid=z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
export const pimApplyInput=z.strictObject({client_key:inputUuid,scope_hash:z.string().regex(/^[a-f0-9]{64}$/),confirmed:z.literal(true)});
export const pimHistoryQuery=z.strictObject({cursor:inputUuid.optional(),kind:z.enum(['dictionary','product_values']).optional(),limit:z.literal('50').optional()});
const base='/product-catalogs/:catalog_id/pim';
const json=(schema:Schema,description:string)=>({description,content:{'application/json':{schema}}});
export function applyPimOpenApiContract(document:Record<string,any>,method:string,path:string):void{
 if(!path.startsWith(base+'/'))return;
 if(path===base+'/legacy-file-stage'){document.description='Read-only semantic handoff from a completed core CSV/XML execution. Current products read/write and admin/MFA are required. No typed preview/apply is performed: inspect the full stage, then submit a separate typed preview and consent. Native core hash binds normalized parser/config rows, not original byte or capture-time equality; retained file bytes are supplied by the caller. No atomic coupling.';document['x-required-scopes']=['products:read','products:write'];document['x-current-admin-required']=true;document['x-strict-query']=true;document['x-query-schema']=z.toJSONSchema(z.strictObject({}),{io:'input'});document['x-limits']={request_bytes:2097152,response_bytes:2097152,file_bytes:1048576,rows:500};document['x-read-only-stage-post']=true;document['x-legacy-catalog-coupling']='not_atomic';document.requestBody={required:true,content:{'application/json':{schema:z.toJSONSchema(pimLegacyStageInput,{io:'input',unrepresentable:'any'})}}};document.responses={'200':json(object({schema:{const:'committed-core-file-pim-stage/v1'},execution:object({id:uuid,preview_id:uuid,scope_hash:hash,total:{type:'integer',minimum:1,maximum:500}}),prepared:{oneOf:[object({ready:{const:true},intake:stageIntake,request:previewRequest.oneOf[1],sources:array(product,500)}),object({ready:{const:false},intake:stageIntake,rows:{type:'array',maxItems:0},errors:array(object({row:{type:'integer',minimum:0,maximum:499},field:text,code:text,definition_id:nullable(uuid)}),500)})]}}),'Complete read-stage; no durable typed changes.'),'401':{description:'Expired/revoked current authority'},'403':{description:'Missing current products read/write or admin/MFA'},'404':{description:'Missing or foreign durable core preview/execution'},'409':{description:'Retained normalized source/client_key/head differs from accepted execution'},'413':{description:'Full2MiB request or response /1MiB file/500row budget exceeded'},'422':{description:'Malformed mapping or source rows'},'423':{description:'Readonly copies refuse POST before parsing'},'503':{description:'Torn/unavailable PIM or core import family'}};extendStageOpenApiV2(document,{dictionary,product,request:previewRequest.oneOf[1]});return;}
 const writing=method==='POST';
 document['x-required-scopes']=writing?['products:read','products:write']:['products:read'];
 document['x-current-admin-required']=writing;document['x-strict-query']=true;document['x-limits']=PIM_LIMITS;
 document['x-query-schema']=z.toJSONSchema(path===base+'/history'?pimHistoryQuery:z.strictObject({}),{io:'input',unrepresentable:'any'});
 document['x-preview-revision']='top/request/dictionary_before=baseline CAS; dictionary_after=predicted native head+1 only if changed plus projected native schema hash; namespace birth0→1';
 document['x-legacy-catalog-coupling']='not_atomic';document['x-native-text-length-unit']='UTF16';
 document.description='Typed sidecar dictionaries and full replacement values, with explicit preview and separate confirmed consent. Native complete source/version/hash and current IAM are checked after waits. Decimal strings keep definition scale/unit; boolean false is real, unset is omitted from values, enum values use stable active option UUIDs. Legacy free category/attributes remain literal; no automatic mapping or atomic guarantee with the existing CSV/XML catalog writer, export/feed or raw product edits. Namespace0 GET is empty and creates no row; preview dictionary_after predicts1 without applying it. Exact operation replay rechecks current IAM while retaining accepted historical content.';
 document.parameters=(document.parameters??[]).filter((parameter:any)=>parameter.in!=='query');
 for(const parameter of document.parameters)if(parameter.in==='path')parameter.schema=uuid;
 if(path===base+'/history')for(const[name,schema]of Object.entries(document['x-query-schema'].properties??{}))document.parameters.push({in:'query',name,required:false,schema});
 document.responses={
  '401':{description:'Current session/key expired or revoked, including late native PIN/clock.'},
  '403':{description:'Missing current read/write scopes, required admin role or MFA.'},
  '404':{description:'Unknown or foreign catalog/product/preview/operation/scoped cursor.'},
  '409':{description:'Stale full source/CAS, conflicting client_key/consent, applied preview or expired native preview; no partial write.'},
  '413':{description:'Full request/scope/response exceeds finite budgets; no silent truncation.'},
  '422':{description:'Invalid strict input/scalars/UUID/query/confirmed consent. Semantically invalid values can instead produce a ready=false full preview.'},
  '503':{description:'Missing/torn native module, manifest or predecessor lineage.'},
 };
 if(writing)document.responses['423']={description:'Read-only copy refuses before JSON parser or schema validation, including v1 alias.'};
 const schema=path===base+'/products/:product_id/editor-source'?editorSource:path===base+'/dictionary'?dictionary:path===base+'/products/:product_id'?product:path===base+'/history'?history:path===base+'/operations/:operation_id'||path.endsWith('/apply')?operation:preview;
 if(writing){
  const reused=structuredClone(schema),created=structuredClone(schema);reused.properties.reused={const:true};created.properties.reused={const:false};
  document.responses['200']=json(reused,path.endsWith('/apply')?'Exact accepted operation retry, reused=true; fresh current IAM, accepted history retained without mutable CAS/source/TTL replay checks or duplicate effects.':'Exact immutable preview retry, reused=true; can_apply is computed from current authority, source and expiry; no duplicate preview birth.');
  document.responses['201']=json(created,path.endsWith('/apply')?'New immutable approved operation, reused=false.':'New immutable preview, reused=false; no typed state mutation yet.');
 }else document.responses['200']=json(schema,'Complete own native DTO. Read-only preview can_apply=false; historical operations remain detached from current source and are accessed with fresh IAM.');
}
