import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {z} from 'zod';
import {ensure} from './errors';
import {createBuyerAddressService} from './buyer-address';

const orderParams=z.strictObject({id:z.uuid()});
const tokenParams=z.strictObject({token:z.string().regex(/^[a-f0-9]{48}$/)});
const previewParams=tokenParams.extend({id:z.uuid()});
function noQuery(url:string){ensure(!new URLSearchParams(url.split('?')[1]??'').size,422,'Ta operacja nie przyjmuje parametrów');}
/** Public token routes are separate from authenticated operator/v1 aliases.
 * buildApp refuses readonly mutations in onRequest before parsing the body. */
export function registerBuyerAddressRoutes(app:FastifyInstance,context:{pool:Pool;encryptionKey:string;sessionName:string;readOnly:boolean}){
 const service=createBuyerAddressService(context);
 const write=()=>ensure(!context.readOnly,423,'Podgląd kopii jest tylko do odczytu');
 const jsonOnly=(req:{headers:Record<string,unknown>})=>ensure(typeof req.headers['content-type']==='string'&&/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']),415,'Wymagany jest JSON');
 app.get('/api/orders/:id/buyer-address-access',async(req,reply)=>{
  noQuery(req.url);reply.header('Cache-Control','no-store');return service.status(req,orderParams.parse(req.params).id);
 });
 app.patch('/api/orders/:id/buyer-address-access',{bodyLimit:16384},async(req,reply)=>{
  write();noQuery(req.url);jsonOnly(req);reply.header('Cache-Control','no-store');const result=await service.adminAccess(req,orderParams.parse(req.params).id,req.body);return result;
 });
 app.get('/api/orders/:id/buyer-address-history',async(req,reply)=>{
  reply.header('Cache-Control','no-store');return service.history(req,orderParams.parse(req.params).id,req.query);
 });
 const base='/api/public/orders/:token/address';
 app.get(base,{config:{rateLimit:{max:60,timeWindow:'1 minute'}}},async(req,reply)=>{
  noQuery(req.url);reply.header('Cache-Control','no-store');return service.overview(tokenParams.parse(req.params).token);
 });
 app.post(base+'/previews',{bodyLimit:16384,config:{rateLimit:{max:10,timeWindow:'1 minute'}}},async(req,reply)=>{
  write();noQuery(req.url);jsonOnly(req);reply.header('Cache-Control','no-store');const result=await service.publicPreview(tokenParams.parse(req.params).token,req.body);reply.code(result.statusCode??201);return result.body;
 });
 app.get(base+'/previews/:id',{config:{rateLimit:{max:60,timeWindow:'1 minute'}}},async(req,reply)=>{
  noQuery(req.url);reply.header('Cache-Control','no-store');const p=previewParams.parse(req.params);return service.publicReadPreview(p.token,p.id);
 });
 app.post(base+'/previews/:id/apply',{bodyLimit:16384,config:{rateLimit:{max:10,timeWindow:'1 minute'}}},async(req,reply)=>{
  write();noQuery(req.url);jsonOnly(req);reply.header('Cache-Control','no-store');const p=previewParams.parse(req.params),result=await service.publicApply(p.token,p.id,req.body);reply.code(result.statusCode??201);return result.body;
 });
}
