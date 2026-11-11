import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {ensure} from './errors';
import * as S from './product-catalogs';
import * as V from './product-catalogs-schema';
export function registerProductCatalogRoutes(app:FastifyInstance,config:{available:boolean;readOnly:boolean}){
 const actor=(req:any):V.ProductCatalogActor=>({...req.actor,...(req.apiScopes?{apiKeyId:req.currentUser?.api_key_id,source:'api'}:{})});
 const id=(req:any)=>z.strictObject({id:z.uuid()}).parse(req.params).id.toLowerCase();
 const empty=(req:any)=>z.strictObject({}).parse(req.query);
 const mask=(r:any)=>({...r,read_only:config.readOnly,can_manage:!config.readOnly&&r.can_manage,...(r.preview?{preview:{...r.preview,can_commit:!config.readOnly&&r.preview.can_commit}}:{})});
 app.addHook('onRequest',async(req,reply)=>{
 const path=req.url.split('?')[0].replace(/^\/api\/v1\//,'/api/');const prefix='/api/product-catalogs';if(path!==prefix&&!path.startsWith(prefix+'/'))return;
 reply.header('Cache-Control','no-store');const writing=!['GET','HEAD','OPTIONS'].includes(req.method);if(writing)ensure(!config.readOnly,423,'Odtworzona kopia jest tylko do odczytu');
 const available=await S.productCatalogsAvailable();if(writing||path!==prefix+'/options')ensure(config.available&&available,503,'Kopia nie zawiera kompletnych katalogów produktów');
 if(req.apiScopes)ensure(req.apiScopes.includes('products:read')&&(!writing||req.apiScopes.includes('products:write')),403,'Klucz nie ma zakresów katalogu');
 });
 app.get('/api/product-catalogs/options',async req=>{empty(req);return mask(await S.productCatalogOptions(actor(req)));});
 app.get('/api/product-catalogs',async req=>mask(await S.productCatalogList(actor(req),V.productCatalogListQuery.parse(req.query))));
 app.get('/api/product-catalogs/previews',async req=>mask(await S.productCatalogHistory(actor(req),V.productCatalogHistoryQuery.parse(req.query))));
 app.get('/api/product-catalogs/:id',async req=>{empty(req);return mask(await S.productCatalogDetail(actor(req),id(req)));});
 app.get('/api/product-catalogs/previews/:id',async req=>{empty(req);return mask(await S.productCatalogPreview(actor(req),id(req)));});
 app.get('/api/product-catalogs/operations/:id',async req=>{empty(req);return mask(await S.productCatalogOperation(actor(req),id(req)));});
 app.post('/api/product-catalogs/previews',{bodyLimit:65536},async(req,reply)=>{empty(req);const r=await S.previewProductCatalog(actor(req),V.productCatalogPreviewInput.parse(req.body));return reply.code(r.reused?200:201).send(mask(r));});
 app.post('/api/product-catalogs/previews/:id/commit',{bodyLimit:16384},async(req,reply)=>{empty(req);const r=await S.commitProductCatalog(actor(req),id(req),V.productCatalogCommitInput.parse(req.body));return reply.code(r.reused?200:201).send(mask(r));});
}
