/** SOURCE_DRAFT only; publicOperations normal/v1 descriptors are in CONTRACT.md.
 * This registration accepts injected actual service, no app/db evaluation. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ensure } from './errors';
import { capturePhysicalParcelWzAuthority, createPhysicalParcelWzService } from './physical-parcel-wz';
export function registerPhysicalParcelWzRoutes(app:FastifyInstance,opts:{available:boolean;readOnly:boolean;sessionName:string},service:ReturnType<typeof createPhysicalParcelWzService>){
 const root='/api/order-parcels',uuid=z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
 const id=(req:any)=>z.strictObject({id:uuid}).parse(req.params).id;
 const empty=(req:any)=>z.strictObject({}).parse(req.query);
 const actor=(req:any)=>capturePhysicalParcelWzAuthority(req,opts.sessionName);
 app.addHook('onRequest',async(req,reply)=>{
  const path=req.url.split('?')[0].replace(/^\/api\/v1\//,'/api/');
  if(!/^\/api\/order-parcels\/(?:plans\/[^/]+\/physical-wz\/|physical-wz\/)/.test(path))return;
  reply.header('Cache-Control','no-store');
  const write=!['GET','HEAD','OPTIONS'].includes(req.method);
  if(write)ensure(!opts.readOnly,423,'Kopia jest tylko do odczytu');
  ensure(opts.available,503,'Physical WZ mapping unavailable');
  if(req.apiScopes)ensure(req.apiScopes.includes('orders:read')&&(!write||req.apiScopes.includes('orders:write')),403,'Physical WZ key scope refused');
 });
 app.get(root+'/plans/:id/physical-wz/source',async req=>{empty(req);return service.source(actor(req),id(req),opts.readOnly);});
 app.post(root+'/plans/:id/physical-wz/previews',async(req,reply)=>{empty(req);const r=await service.preview(actor(req),id(req),req.body);reply.code(r.reused?200:201);return r;});
 app.get(root+'/physical-wz/previews/:id',async req=>{empty(req);return service.previewDetail(actor(req),id(req),opts.readOnly);});
 app.post(root+'/physical-wz/previews/:id/apply',async(req,reply)=>{empty(req);const r=await service.apply(actor(req),id(req),req.body);reply.code(r.reused?200:201);return r;});
 app.get(root+'/physical-wz/mappings/:id',async req=>{empty(req);return service.mappingDetail(actor(req),id(req),opts.readOnly);});
}
