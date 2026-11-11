import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ensure } from './errors';
import * as S from './return-assistant';
import * as V from './return-assistant-schema';
export function registerReturnAssistantRoutes(app:FastifyInstance,config:{available:boolean;readOnly:boolean}){
 const actor=(req:any):V.ReturnAssistantActor=>({...req.actor,...(req.apiScopes?{apiKeyId:req.currentUser?.api_key_id,source:'api' as const}:{})});
 const id=(req:any)=>z.strictObject({id:V.assistantUuid}).parse(req.params).id;
 const query=(req:any)=>z.strictObject({}).parse(req.query);
 const project=(v:any)=>({...v,read_only:config.readOnly,...(config.readOnly?{can_write:false,session:v.session?{...v.session,can_control:false,can_takeover:false,can_receive_locally:false}:undefined,preview:v.preview?{...v.preview,can_receive:false}:undefined}:{})});
 app.addHook('onRequest',async(req,reply)=>{const path=req.url.split('?')[0].replace(/^\/api\/v1\//,'/api/');if(path!=='/api/return-assistant'&&!path.startsWith('/api/return-assistant/'))return;if(path==='/api/return-assistant/settings'||path==='/api/return-assistant/queues'||path.startsWith('/api/return-assistant/queues/')||path==='/api/return-assistant/statuses'||path.startsWith('/api/return-assistant/statuses/'))return;reply.header('Cache-Control','no-store');if(!['GET','HEAD','OPTIONS'].includes(req.method))ensure(!config.readOnly,423,'Odtworzona kopia jest tylko do odczytu');if(path==='/api/return-assistant/options'&&['GET','HEAD'].includes(req.method))return;ensure(config.available&&await S.returnAssistantAvailable(),503,'Kopia nie zawiera kompletnego asystenta zwrotów');});
 app.get('/api/return-assistant/options',async req=>{query(req);return project(await S.returnAssistantOptions(actor(req)));});
 app.post('/api/return-assistant/sessions',async(req,reply)=>{query(req);const r=await S.startReturnAssistant(actor(req),V.returnAssistantStartInput.parse(req.body));return reply.code(r.reused?200:201).send(project(r));});
 app.get('/api/return-assistant/sessions/:id',async req=>{query(req);return project(await S.returnAssistantSessionDetail(actor(req),id(req)));});
 for(const [suffix,kind,method]of [['scans','scan','POST'],['draft','draft','PATCH'],['renew','renew','POST'],['takeover','takeover','POST'],['cancel','cancel','POST'],['photos','photo','POST']]as const){app.route({method,bodyLimit:kind==='photo'?1500000:262144,url:'/api/return-assistant/sessions/:id/'+suffix,handler:async(req,reply)=>{query(req);const r=await S.mutateReturnAssistant(actor(req),id(req),kind,req.body);return reply.code(kind==='photo'&&!r.reused?201:200).send(project(r));}});}
 app.post('/api/return-assistant/sessions/:id/previews',async(req,reply)=>{query(req);const r=await S.previewReturnAssistant(actor(req),id(req),V.returnAssistantPreviewInput.parse(req.body));return reply.code(r.reused?200:201).send(project(r));});
 app.get('/api/return-assistant/previews/:id',async req=>{query(req);return project(await S.returnAssistantPreviewDetail(actor(req),id(req)));});
 app.post('/api/return-assistant/previews/:id/receive',async(req,reply)=>{query(req);const r=await S.receiveReturnAssistant(actor(req),id(req),V.returnAssistantReceiveInput.parse(req.body));return reply.code(r.reused?200:201).send(project(r));});
 app.get('/api/return-assistant/receipts/:id',async req=>{query(req);return project(await S.returnAssistantReceiptDetail(actor(req),id(req)));});
 app.get('/api/return-assistant/photos/:id/content',async req=>{query(req);return project(await S.returnAssistantPhotoContent(actor(req),id(req)));});
 app.get('/api/return-assistant/history',async req=>project(await S.returnAssistantHistory(actor(req),V.returnAssistantHistoryInput.parse(req.query))));
}
