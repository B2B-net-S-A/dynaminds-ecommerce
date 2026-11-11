import type { FastifyInstance } from 'fastify';
import { ensure } from './errors';
import * as S from './catalog-stock-control';
import * as V from './catalog-stock-control-schema';
import {stockWriterInstallationGate,type StockWriterInstallation} from './catalog-stock-writer-coverage';
export function registerCatalogStockControlRoutes(app:FastifyInstance,config:{available:boolean;readOnly:boolean;writersAvailable?:false;stockWriterInstallation?:StockWriterInstallation}){
  const actor=(r:any):V.CatalogStockControlActor=>({...r.actor,apiKeyId:r.apiScopes?r.currentUser?.api_key_id:undefined});
  const schemaGate=config.stockWriterInstallation===undefined?undefined:stockWriterInstallationGate(config.stockWriterInstallation);
  const ctx={readOnly:config.readOnly,writersAvailable:schemaGate!==undefined,schemaGate};
  app.addHook('onRequest',async(req,reply)=>{
    const path=req.url.split('?')[0].replace(/^\/api\/v1\//,'/api/');if(!path.startsWith('/api/catalog-stock-control/'))return;
    // COUNT history owns its fresh absent/healthy/torn check independently of BO activation.
    if(path==='/api/catalog-stock-control/count-documents'||path.startsWith('/api/catalog-stock-control/count-documents/'))return;
    reply.header('Cache-Control','no-store');if(req.method!=='GET')ensure(!config.readOnly,423,'Odtworzona kopia jest tylko do odczytu');
    // Only this construction-owned gate defers a redundant pool read. Every
    // matched handler keeps its FULL RR guard and independent fresh RC guard.
    // No availability, IAM, generation or certificate result is cached.
    const managedRead=req.method==='GET'&&schemaGate!==undefined&&/^\/api\/catalog-stock-control\/(?:history|catalogs\/[0-9a-f-]{36}\/source|previews\/[0-9a-f-]{36}(?:\/rows)?|operations\/[0-9a-f-]{36}|documents\/[0-9a-f-]{36}(?:\/rows|\/export)?)$/i.test(path);
    ensure(config.available&&(managedRead||await S.catalogStockControlAvailable()),503,'Kopia nie zawiera kompletnej ścisłej kontroli katalogu');
    if(req.apiScopes)ensure(req.apiScopes.includes('inventory:read')&&(req.method==='GET'||req.apiScopes.includes('inventory:write')),403,'Brak zakresów BO');
  });
  const params=(r:any,name='id')=>V.catalogStockControlUuid.parse(r.params[name]);
  const p='/api/catalog-stock-control';
  app.get(p+'/catalogs/:id/source',async r=>S.sourceCatalogStockControl(actor(r),params(r),ctx));
  app.post(p+'/catalogs/:id/previews',{bodyLimit:16384},async(r,reply)=>{const v=await S.previewCatalogStockControl(actor(r),params(r),r.body,ctx);return reply.code(v.reused?200:201).send(v);});
  app.get(p+'/previews/:id',async r=>S.catalogStockControlDetail(actor(r),'preview',params(r),ctx));
  app.get(p+'/previews/:id/rows',async r=>S.catalogStockControlRows(actor(r),'preview',params(r),r.query,ctx));
  app.post(p+'/previews/:id/commit',{bodyLimit:4096},async(r,reply)=>{const v=await S.commitCatalogStockControl(actor(r),params(r),r.body,ctx);return reply.code(v.reused?200:201).send(v);});
  app.get(p+'/operations/:id',async r=>S.catalogStockControlDetail(actor(r),'operation',params(r),ctx));
  app.get(p+'/documents/:id',async r=>S.catalogStockControlDetail(actor(r),'document',params(r),ctx));
  app.get(p+'/documents/:id/rows',async r=>S.catalogStockControlRows(actor(r),'document',params(r),r.query,ctx));
  app.get(p+'/documents/:id/export',async r=>S.exportCatalogStockControlDocument(actor(r),params(r),r.query,ctx));
  app.get(p+'/history',async r=>S.catalogStockControlHistory(actor(r),r.query,ctx));
}
