import type {StagedCorePimFile} from './legacy/adapter';
import {pimLegacyStageVersionedInput as pimLegacyStageInput} from './legacy/v2/stage-dispatch';
import type {StagedCorePimFile as StagedCorePimFileV2} from './legacy/v2/adapter';
/** Root staged route integration. Native producer not yet adopted; no live registration. */
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import type {Actor} from '../domain';
import {ensure,Problem} from '../errors';
import type {Dictionary,ProductSource,Preview,Operation,History} from './contract2';
export interface PimRouteService {
 stageLegacyFile(actor:Actor,catalogId:string,input:unknown):Promise<StagedCorePimFile|StagedCorePimFileV2>;
 dictionary(actor:Actor,catalogId:string):Promise<Dictionary>;
 product(actor:Actor,catalogId:string,productId:string):Promise<ProductSource>;
 editorSource(actor:Actor,catalogId:string,productId:string):Promise<{dictionary:Dictionary;product:ProductSource}>;
 preview(actor:Actor,catalogId:string,input:unknown):Promise<Preview>;
 readPreview(actor:Actor,catalogId:string,previewId:string):Promise<Preview>;
 apply(actor:Actor,catalogId:string,previewId:string,input:{client_key:string;scope_hash:string;confirmed:true}):Promise<Operation>;
 operation(actor:Actor,catalogId:string,operationId:string):Promise<Operation>;
 history(actor:Actor,catalogId:string,cursor?:string,kind?:'dictionary'|'product_values'):Promise<History>;
}
const uuid=z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
const catalogParams=z.strictObject({catalog_id:uuid});
const productParams=z.strictObject({catalog_id:uuid,product_id:uuid});
const previewParams=z.strictObject({catalog_id:uuid,preview_id:uuid});
const operationParams=z.strictObject({catalog_id:uuid,operation_id:uuid});
const noQuery=z.strictObject({});
const historyQuery=z.strictObject({cursor:uuid.optional(),kind:z.enum(['dictionary','product_values']).optional(),limit:z.literal('50').optional()});
const applyBody=z.strictObject({client_key:uuid,scope_hash:z.string().regex(/^[a-f0-9]{64}$/),confirmed:z.literal(true)});
const base='/product-catalogs/:catalog_id/pim';
export const pimRouteDescriptors=[
 {method:'GET',path:base+'/dictionary',scopes:['products:read']},
 {method:'GET',path:base+'/products/:product_id',scopes:['products:read']},
 {method:'GET',path:base+'/products/:product_id/editor-source',scopes:['products:read']},
 {method:'POST',path:base+'/legacy-file-stage',scopes:['products:read','products:write']},
 {method:'POST',path:base+'/previews',scopes:['products:read','products:write']},
 {method:'GET',path:base+'/previews/:preview_id',scopes:['products:read']},
 {method:'POST',path:base+'/previews/:preview_id/apply',scopes:['products:read','products:write']},
 {method:'GET',path:base+'/operations/:operation_id',scopes:['products:read']},
 {method:'GET',path:base+'/history',scopes:['products:read']},
] as const;
/** Install collectPublicRoutes' onRoute hook before this registration, then call
 * its returned binder afterwards. It clones each handler and its local hooks to
 * /api/v1 without another producer or authority context. */
export function registerPimRoutes(app:FastifyInstance,{service,captureActor,available,readOnly,nestedAvailable=false}:{service:PimRouteService;captureActor:(req:FastifyRequest)=>Actor;available:boolean;readOnly:boolean;nestedAvailable?:boolean}){
 async function invoke<T>(work:()=>Promise<T>):Promise<T>{try{return await work();}catch(error){
  if(error instanceof Problem)throw error;
  const code=(error as {code?:string})?.code;
  if(code==='P0002')throw new Problem(404,'Nie znaleziono własnego katalogu, produktu lub dokumentu parametrów.');
  if(code==='28000')throw new Problem(401,'Sesja lub klucz API wygasł.');
  if(code==='42501')throw new Problem(403,'Brak aktualnych uprawnień do parametrów produktów.');
  if(code==='40001')throw new Problem(409,'Dane lub uprawnienia uległy zmianie. Odczytaj podgląd ponownie.');
  if(code==='54000')throw new Problem(413,'Pełne źródło parametrów przekracza dozwolony rozmiar.');
  if(code==='55000')throw new Problem(503,'Schemat parametrów jest niekompletny.');
  throw error;
 }}
 function actor(req:FastifyRequest,write:boolean){
  ensure(available,503,'Słowniki parametrów nie są dostępne w tej bazie.');
  const actor=captureActor(req),scopes=(req as FastifyRequest&{apiScopes?:string[]}).apiScopes;
  if(actor.apiKeyId)ensure(Array.isArray(scopes)&&['products:read',...(write?['products:write']:[])].every(s=>scopes.includes(s)),403,'Brak uprawnień API do parametrów produktów.');
  if(write)ensure(actor.role==='admin',403,'Zmiana parametrów wymaga administratora.');
  return actor;
 }
 const writeOpts={bodyLimit:1048576,onRequest:async(_req:FastifyRequest,reply:import('fastify').FastifyReply)=>{if(readOnly)return reply.code(423).send({status:423,title:'Odtworzona kopia jest tylko do odczytu.'});if(!available)return reply.code(503).send({status:503,title:'Słowniki parametrów nie są dostępne w tej bazie.'});}};
 app.get('/api'+base+'/dictionary',async req=>{const a=actor(req,false),p=catalogParams.parse(req.params);noQuery.parse(req.query);return invoke(()=>service.dictionary(a,p.catalog_id));});
 app.get('/api'+base+'/products/:product_id',async req=>{const a=actor(req,false),p=productParams.parse(req.params);noQuery.parse(req.query);return invoke(()=>service.product(a,p.catalog_id,p.product_id));});
 app.get('/api'+base+'/products/:product_id/editor-source',async req=>{const a=actor(req,false),p=productParams.parse(req.params);noQuery.parse(req.query);return invoke(()=>service.editorSource(a,p.catalog_id,p.product_id));});
 app.post('/api'+base+'/legacy-file-stage',{...writeOpts,bodyLimit:2097152},async(req,reply)=>{const a=actor(req,true),p=catalogParams.parse(req.params);noQuery.parse(req.query);reply.header('Cache-Control','no-store');const body=pimLegacyStageInput.parse(req.body);if('schema' in body.typed_mapping&&body.typed_mapping.schema==='legacy-pim-mapping/v2')ensure(nestedAvailable,503,'Mapowanie struktur nie jest dostępne w tej bazie.');return invoke(()=>service.stageLegacyFile(a,p.catalog_id,body));});
 app.post('/api'+base+'/previews',writeOpts,async(req,reply)=>{const a=actor(req,true),p=catalogParams.parse(req.params);noQuery.parse(req.query);const result=await invoke(()=>service.preview(a,p.catalog_id,req.body));return reply.code(result.reused?200:201).send(result);});
 app.get('/api'+base+'/previews/:preview_id',async req=>{const a=actor(req,false),p=previewParams.parse(req.params);noQuery.parse(req.query);return invoke(()=>service.readPreview(a,p.catalog_id,p.preview_id));});
 app.post('/api'+base+'/previews/:preview_id/apply',writeOpts,async(req,reply)=>{const a=actor(req,true),p=previewParams.parse(req.params);noQuery.parse(req.query);const body=applyBody.parse(req.body),result=await invoke(()=>service.apply(a,p.catalog_id,p.preview_id,body));return reply.code(result.reused?200:201).send(result);});
 app.get('/api'+base+'/operations/:operation_id',async req=>{const a=actor(req,false),p=operationParams.parse(req.params);noQuery.parse(req.query);return invoke(()=>service.operation(a,p.catalog_id,p.operation_id));});
 app.get('/api'+base+'/history',async req=>{const a=actor(req,false),p=catalogParams.parse(req.params),q=historyQuery.parse(req.query);return invoke(()=>service.history(a,p.catalog_id,q.cursor,q.kind));});
}
