import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ensure } from './errors';
import { stocktakeAdjustmentsAvailable } from './stocktake-adjustments';
import * as S from './warehouse-document-register';
import * as V from './warehouse-document-register-schema';

export function registerWarehouseDocumentRegisterRoutes(app:FastifyInstance,config:{available:boolean;readOnly:boolean}) {
  const prefix='/api/warehouse-document-register',ctx={readOnly:config.readOnly};
  const actor=(req:any):V.WarehouseRegisterActor=>({...req.actor,...(req.apiScopes?{apiKeyId:req.currentUser?.api_key_id,source:'api' as const}:{})});
  app.addHook('onRequest',async(req,reply)=>{
    const path=req.url.split('?')[0].replace(/^\/api\/v1\//,'/api/');if(path!==prefix&&!path.startsWith(prefix+'/'))return;
    reply.header('Cache-Control','no-store');
    if(!['GET','HEAD','OPTIONS'].includes(req.method)){
      ensure(!config.readOnly,423,'Odtworzona kopia jest tylko do odczytu');
      ensure(false,405,'Rejestr dokumentów jest tylko do odczytu');
    }
    ensure(config.available&&await stocktakeAdjustmentsAvailable(),503,'Rejestr wymaga kompletnego modułu149');
    if(req.apiScopes)ensure(req.apiScopes.includes('inventory:read'),403,'Brak zakresu odczytu magazynu');
  });
  app.get(prefix,req=>S.warehouseDocumentRegister(actor(req),req.query,ctx));
  app.get(prefix+'/:origin/:id',req=>{
    z.strictObject({}).parse(req.query);const p=V.warehouseRegisterParams.parse(req.params);
    return S.warehouseDocumentRegisterDetail(actor(req),p.origin,p.id,ctx);
  });
  app.get(prefix+'/:origin/:id/export',req=>{
    const p=V.warehouseRegisterParams.parse(req.params);
    return S.warehouseDocumentRegisterExport(actor(req),p.origin,p.id,req.query,ctx);
  });
}
