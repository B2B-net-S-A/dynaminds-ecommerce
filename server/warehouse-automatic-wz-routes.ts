import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ensure } from './errors';
import * as S from './warehouse-automatic-wz';
import * as V from './warehouse-automatic-wz-schema';

/** Not mounted by this foundation. Root owns normal/v1 and auth descriptors. */
export function registerWarehouseAutomaticWzRoutes(app: FastifyInstance, config: { available: boolean; readOnly: boolean }) {
  const prefix='/api/warehouse-automatic-wz',ctx={readOnly:config.readOnly};
  const actor=(req:any):V.AutomaticWzActor=>({...req.actor,...(req.apiScopes?{apiKeyId:req.currentUser?.api_key_id}:{})});
  const id=(req:any)=>z.strictObject({id:V.automaticWzUuid}).parse(req.params).id;
  const empty=(req:any)=>z.strictObject({}).parse(req.query);
  app.addHook('onRequest',async(req,reply)=>{
    const path=req.url.split('?')[0].replace(/^\/api\/v1\//,'/api/');
    if(path!==prefix&&!path.startsWith(prefix+'/'))return;
    reply.header('Cache-Control','no-store');
    const writing=!['GET','HEAD','OPTIONS'].includes(req.method);
    if(writing)ensure(!config.readOnly,423,'Odtworzona kopia jest tylko do odczytu');
    const present=await S.warehouseAutomaticWzAvailable();
    if(writing||path!==prefix+'/options')ensure(config.available&&present,503,'Kopia nie zawiera automatycznych WZ');
    const scopes=req.apiScopes;
    if(scopes)ensure(scopes.includes('inventory:read')&&(!writing||scopes.includes('inventory:write')),403,'Brak zakresów automatycznych WZ');
  });
  app.get(prefix+'/options',req=>S.warehouseAutomaticWzOptions(actor(req),V.automaticWzPageQuery.parse(req.query),ctx));
  app.post(prefix+'/warehouses/:id/previews',{bodyLimit:16384},async(req,reply)=>{
    empty(req);const r=await S.previewWarehouseAutomaticWz(actor(req),id(req),V.automaticWzPreviewInput.parse(req.body),ctx);return reply.code(r.reused?200:201).send(r);
  });
  app.get(prefix+'/previews/:id',req=>{empty(req);return S.warehouseAutomaticWzDetail(actor(req),'preview',id(req),ctx);});
  app.post(prefix+'/previews/:id/commit',{bodyLimit:16384},async(req,reply)=>{
    empty(req);const r=await S.commitWarehouseAutomaticWz(actor(req),id(req),V.automaticWzCommitInput.parse(req.body),ctx);return reply.code(r.reused?200:201).send(r);
  });
  app.get(prefix+'/operations/:id',req=>{empty(req);return S.warehouseAutomaticWzDetail(actor(req),'operation',id(req),ctx);});
  app.get(prefix+'/history',req=>S.warehouseAutomaticWzHistory(actor(req),V.automaticWzHistoryQuery.parse(req.query),ctx));
}
