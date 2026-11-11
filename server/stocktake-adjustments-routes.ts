import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ensure } from './errors';
import * as S from './stocktake-adjustments';
import * as V from './stocktake-adjustments-schema';

export function registerStocktakeAdjustmentRoutes(app:FastifyInstance,config:{available:boolean;readOnly:boolean}) {
  const prefix='/api/stocktake-adjustments';const ctx={readOnly:config.readOnly};
  const actor=(req:any):V.AdjustmentActor=>({...req.actor,...(req.apiScopes?{apiKeyId:req.currentUser?.api_key_id,source:'api' as const}:{})});
  const id=(req:any)=>z.strictObject({id:V.adjustmentUuid}).parse(req.params).id;
  const empty=(req:any)=>z.strictObject({}).parse(req.query);
  app.addHook('onRequest',async(req,reply)=>{
    const path=req.url.split('?')[0].replace(/^\/api\/v1\//,'/api/');
    if(path!==prefix&&!path.startsWith(prefix+'/'))return;
    reply.header('Cache-Control','no-store');
    const writing=!['GET','HEAD','OPTIONS'].includes(req.method);
    if(writing)ensure(!config.readOnly,423,'Odtworzona kopia jest tylko do odczytu');
    const available=await S.stocktakeAdjustmentsAvailable();
    if(writing||path!==prefix+'/options')ensure(config.available&&available,503,'Kopia nie zawiera dokumentów spisu');
    const scopes=req.apiScopes;
    if(scopes)ensure(['inventory:read',...(writing?['inventory:write']:[])].every(s=>scopes.includes(s)),403,'Brak zakresów dokumentów spisu');
  });
  app.get(prefix+'/options',async req=>{empty(req);return S.stocktakeAdjustmentOptions(actor(req),ctx);});
  app.post(prefix+'/series',{bodyLimit:V.STOCKTAKE_ADJUSTMENT_LIMITS.request_bytes},async(req,reply)=>{
    empty(req);const r=await S.createStocktakeAdjustmentSeries(actor(req),V.adjustmentSeriesInput.parse(req.body),ctx);return reply.code(r.reused?200:201).send(r);
  });
  app.get(prefix+'/sources/:source_kind/:id',async req=>{empty(req);const p=V.adjustmentSourceParams.parse(req.params);return S.stocktakeAdjustmentSource(actor(req),p.source_kind,p.id,ctx);});
  app.post(prefix+'/previews',{bodyLimit:V.STOCKTAKE_ADJUSTMENT_LIMITS.request_bytes},async(req,reply)=>{
    empty(req);const r=await S.previewStocktakeAdjustment(actor(req),V.adjustmentPreviewInput.parse(req.body),ctx);return reply.code(r.reused?200:201).send(r);
  });
  app.get(prefix+'/previews/:id',async req=>{empty(req);return S.stocktakeAdjustmentPreview(actor(req),id(req),ctx);});
  app.get(prefix+'/previews/:id/rows',async req=>S.stocktakeAdjustmentPreviewRows(actor(req),id(req),V.adjustmentRowsQuery.parse(req.query),ctx));
  app.post(prefix+'/previews/:id/post',{bodyLimit:V.STOCKTAKE_ADJUSTMENT_LIMITS.request_bytes},async(req,reply)=>{
    empty(req);const r=await S.postStocktakeAdjustment(actor(req),id(req),V.adjustmentPostInput.parse(req.body),ctx);return reply.code(r.reused?200:201).send(r);
  });
  app.get(prefix+'/receipts/:id',async req=>{empty(req);return S.stocktakeAdjustmentReceipt(actor(req),id(req),ctx);});
  app.get(prefix+'/documents',async req=>S.stocktakeAdjustmentDocuments(actor(req),V.adjustmentHistoryQuery.parse(req.query),ctx));
  app.get(prefix+'/register',async req=>S.stocktakeAdjustmentRegister(actor(req),V.adjustmentRegisterQuery.parse(req.query),ctx));
  app.get(prefix+'/documents/:id',async req=>{empty(req);return S.stocktakeAdjustmentDocument(actor(req),id(req),ctx);});
  app.get(prefix+'/documents/:id/export',async req=>S.stocktakeAdjustmentDocumentExport(actor(req),id(req),req.query,ctx));
  app.get(prefix+'/documents/:id/rows',async req=>S.stocktakeAdjustmentDocumentRows(actor(req),id(req),V.adjustmentRowsQuery.parse(req.query),ctx));
}
