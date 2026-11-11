import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {ensure} from './errors';
import {captureManualOffAuthority,createManualOffService} from './manual-inventory-off';
/** Register before bindPublicRoutes; descriptors below are required for v1 aliases. */
export function registerManualOffRoutes(app:FastifyInstance,opts:{sessionName:string;available:boolean;readOnly:boolean},service:ReturnType<typeof createManualOffService>){
 const root='/api/inventory/manual-corrections',idSchema=z.strictObject({id:z.string().uuid()});
 const id=(req:any)=>idSchema.parse(req.params).id;
 const query=(req:any)=>{const url=new URL(req.url,'http://local.invalid'),out:Record<string,string>={};for(const[k,v]of url.searchParams){ensure(!(k in out),422,'Duplicate manual query key');out[k]=v;}return out;};
 const empty=(req:any)=>z.strictObject({}).parse(query(req));
 app.addHook('onRequest',async(req,reply)=>{
  const path=req.url.split('?')[0].replace(/^\/api\/v1\//,'/api/');if(!path.startsWith(root+'/'))return;
  reply.header('Cache-Control','no-store');const writing=!['GET','HEAD','OPTIONS'].includes(req.method);
  if(writing)ensure(!opts.readOnly,423,'Kopia jest tylko do odczytu');ensure(opts.available,503,'Manual OFF unavailable');
  if(req.apiScopes)ensure(req.apiScopes.includes('inventory:read')&&(!writing||req.apiScopes.includes('inventory:write')),403,'Manual inventory API scope refused');
 });
 const actor=(req:any)=>captureManualOffAuthority(req,opts.sessionName);
 app.get(root+'/source',async req=>service.source(actor(req),query(req)));
 app.post(root+'/previews',async(req,reply)=>{empty(req);const r=await service.preview(actor(req),req.body);reply.code(r.reused?200:201);return r;});
 app.get(root+'/previews/:id',async req=>{empty(req);return service.previewDetail(actor(req),id(req));});
 app.post(root+'/previews/:id/apply',async(req,reply)=>{empty(req);const r=await service.apply(actor(req),id(req),req.body);reply.code(r.reused?200:201);return r;});
 app.get(root+'/receipts/:id',async req=>{empty(req);return service.receiptDetail(actor(req),id(req));});
 app.get(root+'/receipts',async req=>service.history(actor(req),query(req)));
}
