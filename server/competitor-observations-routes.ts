import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {z} from 'zod';
import {ensure} from './errors';
import {createCompetitorObservationService} from './competitor-observations';
import {collectAndImportShopifyObservations} from './competitor-shopify-collector';
const listParams=z.strictObject({id:z.uuid()});
const batchParams=z.strictObject({id:z.uuid(),batch_id:z.uuid()});
const rawPage=z.strictObject({limit:z.literal('50').optional(),after:z.string().min(1).max(2048).optional(),product_id:z.uuid().optional()});
export function normalizeCompetitorObservationPage(url:string,observations:boolean){
 const q=new URLSearchParams(url.includes('?')?url.slice(url.indexOf('?')+1):''),raw:Record<string,string>={};
 for(const [key,value]of q){ensure(['limit','after',...(observations?['product_id']:[])].includes(key),422,'Nieznany parametr obserwacji');ensure(!Object.hasOwn(raw,key),422,'Powtórzony parametr obserwacji');raw[key]=value;}
 const p=rawPage.parse(raw);return {limit:50 as const,after:p.after??null,product_id:p.product_id??null};
}
function noQuery(url:string){ensure(![...new URLSearchParams(url.includes('?')?url.slice(url.indexOf('?')+1):'')].length,422,'Ta operacja nie przyjmuje parametrów');}
/** Normal/v1 public alias registration and authentication are owned by buildApp.
 * Its readonly onRequest refusal precedes JSON parsing; this module repeats it. */
export function registerCompetitorObservationRoutes(app:FastifyInstance,context:{pool:Pool;cursorKey:string;sessionName:string;readOnly:boolean}){
 const service=createCompetitorObservationService(context),base='/api/price-lists/:id/competitor-observations';
 app.post(base+'/collect/shopify',{bodyLimit:65536,onRequest:async()=>{ensure(!context.readOnly,423,'Kopia przywrócona jest tylko do odczytu');}},async(req,reply)=>{ensure(!context.readOnly,423,'Kopia przywrócona jest tylko do odczytu');noQuery(req.url);reply.header('cache-control','no-store');const result=await collectAndImportShopifyObservations(service,req,listParams.parse(req.params).id,req.body);reply.code(result.batch.reused?200:201);return result;});
 app.put(base+'/collection-schedule',{bodyLimit:65536,onRequest:async()=>{ensure(!context.readOnly,423,'Kopia przywrócona jest tylko do odczytu');}},async(req,reply)=>{ensure(!context.readOnly,423,'Kopia przywrócona jest tylko do odczytu');noQuery(req.url);reply.header('cache-control','no-store');return service.putCollectionSchedule(req,listParams.parse(req.params).id,req.body);});
 app.get(base+'/options',async(req,reply)=>{noQuery(req.url);reply.header('cache-control','no-store');return service.options(req,listParams.parse(req.params).id);});
 app.get(base+'/profile',async(req,reply)=>{noQuery(req.url);reply.header('cache-control','no-store');return service.getProfile(req,listParams.parse(req.params).id);});
 app.put(base+'/profile',async(req,reply)=>{ensure(!context.readOnly,423,'Kopia przywrócona jest tylko do odczytu');noQuery(req.url);reply.header('cache-control','no-store');return service.putProfile(req,listParams.parse(req.params).id,req.body);});
 app.post(base+'/batches',async(req,reply)=>{ensure(!context.readOnly,423,'Kopia przywrócona jest tylko do odczytu');noQuery(req.url);reply.header('cache-control','no-store');const result=await service.importBatch(req,listParams.parse(req.params).id,req.body);reply.code(result.reused?200:201);return result;});
 app.get(base+'/batches',async(req,reply)=>{reply.header('cache-control','no-store');return service.page(req,listParams.parse(req.params).id,'batches',normalizeCompetitorObservationPage(req.url,false));});
 app.get(base+'/batches/:batch_id',async(req,reply)=>{noQuery(req.url);reply.header('cache-control','no-store');const p=batchParams.parse(req.params);return service.getBatch(req,p.id,p.batch_id);});
 app.get(base+'/observations',async(req,reply)=>{reply.header('cache-control','no-store');return service.page(req,listParams.parse(req.params).id,'observations',normalizeCompetitorObservationPage(req.url,true));});
}
