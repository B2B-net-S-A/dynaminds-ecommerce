/** Source-owned normal/v1 binding. Caller must compose this descriptor into the central collector, never generic-clone it. */
import type {FastifyInstance,RouteOptions} from 'fastify';
import {z} from 'zod';
import {ensure} from '../../../server/errors';
import {invoke} from '../pim-large-import-http-binding-ui/routes';
import type {createOwnedDoneCoreList} from './owned-list';
declare module 'fastify'{interface FastifyContextConfig{largeImportSameParserAlias?:boolean;}}
export const doneCoreListOperation={method:'GET' as const,path:'/product-catalogs/:catalog_id/large-import/jobs',scopes:['products:read','products:write'],query:z.strictObject({limit:z.coerce.number().int().min(1).max(25).optional(),cursor:z.string().max(256).optional()})};
export async function registerOwnedDoneCoreList(app:FastifyInstance,ports:{certified():Promise<boolean>;reader:ReturnType<typeof createOwnedDoneCoreList>}){
 const ready=await ports.certified(),reader=ports.reader;
 await app.register(async child=>{
  const route:RouteOptions={method:'GET',url:'/api'+doneCoreListOperation.path,config:{largeImportSameParserAlias:true},handler:async(req,reply)=>{
   reply.header('Cache-Control','no-store');ensure(ready===true,503,'Brak certyfikowanego odczytu importów');ensure(req.currentUser&&req.actor,401,'Zaloguj się');ensure(req.actor.role==='admin',403,'Wymagana rola administratora');ensure(!req.apiScopes||req.apiScopes.includes('products:read')&&req.apiScopes.includes('products:write'),403,'Wymagany scope products:read i products:write');
   const p=z.strictObject({catalog_id:z.uuid()}).parse(req.params),q=doneCoreListOperation.query.parse(req.query);return invoke(()=>reader.list(req,p.catalog_id,q.limit,q.cursor));
  }};child.route(route);child.route({...route,url:'/api/v1'+doneCoreListOperation.path});
 });
}
