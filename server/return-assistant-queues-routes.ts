import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ensure } from './errors';
import { assistantUuid,type ReturnAssistantActor } from './return-assistant-schema';
import * as S from './return-assistant-queues';
import * as V from './return-assistant-queues-schema';
export function registerReturnAssistantQueueRoutes(app:FastifyInstance,config:{available:boolean;readOnly:boolean}){
 const actor=(req:any):ReturnAssistantActor=>({...req.actor,...(req.apiScopes?{apiKeyId:req.currentUser?.api_key_id,source:'api' as const}:{})});
 const id=(req:any)=>z.strictObject({id:assistantUuid}).parse(req.params).id;
 const empty=(req:any)=>z.strictObject({}).parse(req.query);
 const mask=(r:any)=>({...r,read_only:config.readOnly,can_write:!config.readOnly&&r.can_write,can_save_settings:!config.readOnly&&r.can_save_settings,can_manage_queue:!config.readOnly&&r.can_manage_queue});
 app.addHook('onRequest',async(req,reply)=>{const path=req.url.split('?')[0].replace(/^\/api\/v1\//,'/api/');const root='/api/return-assistant';if(path!==root+'/settings'&&path!==root+'/queues'&&!path.startsWith(root+'/queues/'))return;reply.header('Cache-Control','no-store');const writing=!['GET','HEAD','OPTIONS'].includes(req.method);if(writing)ensure(!config.readOnly,423,'Odtworzona kopia jest tylko do odczytu');const present=await S.returnAssistantQueuesAvailable();if(writing||path.startsWith(root+'/queues/'))ensure(config.available&&present,503,'Kopia nie zawiera kompletnej kolejki asystenta');if(req.apiScopes)ensure(req.apiScopes.includes('orders:read')&&(!writing||req.apiScopes.includes('orders:write')),403,'Klucz API nie ma zakresów kolejki');});
 app.get('/api/return-assistant/settings',async req=>{empty(req);return mask(await S.returnAssistantQueueSettings(actor(req)));});
 app.patch('/api/return-assistant/settings',{bodyLimit:16384},async req=>{empty(req);return mask(await S.saveReturnAssistantQueueSettings(actor(req),V.settingsInput.parse(req.body)));});
 app.post('/api/return-assistant/queues',{bodyLimit:16384},async(req,reply)=>{empty(req);const r=await S.createReturnAssistantQueue(actor(req),V.createQueueInput.parse(req.body));return reply.code(r.reused?200:201).send(mask(r));});
 app.get('/api/return-assistant/queues',async req=>mask(await S.returnAssistantQueues(actor(req),V.listQuery.parse(req.query))));
 app.get('/api/return-assistant/queues/:id',async req=>{empty(req);return mask(await S.returnAssistantQueueDetail(actor(req),id(req)));});
 app.patch('/api/return-assistant/queues/:id',{bodyLimit:16384},async req=>{empty(req);return mask(await S.updateReturnAssistantQueue(actor(req),id(req),V.updateQueueInput.parse(req.body)));});
 app.get('/api/return-assistant/queues/:id/items',async req=>mask(await S.returnAssistantQueueItems(actor(req),id(req),V.itemsQuery.parse(req.query))));
}
