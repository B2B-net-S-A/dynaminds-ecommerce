import type {FastifyInstance,FastifyRequest} from 'fastify';
import {ensure} from './errors';
import {z} from 'zod';
import {assertLocalWooHttpFixture,readLocalWooHttpChannel,enrollLocalWooHttpChannel,readLocalWooHttpJob,runLocalWooHttpJobOnce,type LocalWooHttpFixture} from './local-woo-http-fixture';
import {assertLocalWooHttpRegistry,readConfiguredLocalWooChannels,localWooRegistryFixture,type LocalWooHttpRegistry} from './local-woo-http-registry';
/** Only mounted by an explicitly configured local constructor; public registration stays unchanged. */
export function registerLocalWooHttpFixtureRoutes(app:FastifyInstance,options:{fixture?:LocalWooHttpFixture;registry?:LocalWooHttpRegistry;readOnly:boolean;sessionName:string}){
 if(!options.fixture&&!options.registry)return;
 const fixture=options.fixture,registry=options.registry;
 ensure(!(fixture&&registry),500,'Wybierz jeden rejestr lokalnych sklepów');
 if(fixture)assertLocalWooHttpFixture(fixture);if(registry)assertLocalWooHttpRegistry(registry);
 const session=(req:FastifyRequest)=>{ensure(!req.headers.authorization&&req.cookies[options.sessionName]&&!req.actor.apiKeyId,403,'Wymagana zwykła sesja administratora');ensure(req.currentUser?.id===req.actor.userId&&req.currentUser.tenant_id===req.actor.tenantId&&req.currentUser.role===req.actor.role&&!req.currentUser.api_key_id&&req.apiScopes===undefined&&req.actor.source!=='api',403,'Wymagana oryginalna sesja tej firmy');return req.actor;};
 const empty=z.strictObject({}),jobParams=z.strictObject({id:z.uuid()});
 if(registry){
  const channelParams=z.strictObject({channelId:z.uuid()}),channelJobParams=channelParams.extend({id:z.uuid()});
  app.get('/api/local-fixtures/woocommerce/channels',req=>{empty.parse(req.query);return readConfiguredLocalWooChannels(registry,session(req));});
  app.get('/api/local-fixtures/woocommerce/channels/:channelId',req=>{empty.parse(req.query);const actor=session(req),{channelId}=channelParams.parse(req.params);return readLocalWooHttpChannel(localWooRegistryFixture(registry,actor,channelId),actor);});
  app.post('/api/local-fixtures/woocommerce/channels/:channelId',async(req,reply)=>{ensure(!options.readOnly,423,'Zapis jest wyłączony w podglądzie');empty.parse(req.query);const actor=session(req),{channelId}=channelParams.parse(req.params);return reply.code(201).send(await enrollLocalWooHttpChannel(localWooRegistryFixture(registry,actor,channelId),actor,req.body));});
  app.get('/api/local-fixtures/woocommerce/channels/:channelId/jobs/:id',req=>{empty.parse(req.query);const actor=session(req),{channelId,id}=channelJobParams.parse(req.params);return readLocalWooHttpJob(localWooRegistryFixture(registry,actor,channelId),actor,id);});
  app.post('/api/local-fixtures/woocommerce/channels/:channelId/jobs/:id/run-once',req=>{ensure(!options.readOnly,423,'Zapis jest wyłączony w podglądzie');empty.parse(req.query);empty.parse(req.body);const actor=session(req),{channelId,id}=channelJobParams.parse(req.params);return runLocalWooHttpJobOnce(localWooRegistryFixture(registry,actor,channelId),actor,id);});
  return;
 }
 ensure(fixture,500,'Brak lokalnego sklepu');
 app.get('/api/local-fixtures/woocommerce/jobs/:id',async req=>{empty.parse(req.query);const{id}=jobParams.parse(req.params);return readLocalWooHttpJob(fixture,session(req),id);});
 app.post('/api/local-fixtures/woocommerce/jobs/:id/run-once',async req=>{ensure(!options.readOnly,423,'Zapis jest wyłączony w podglądzie');empty.parse(req.query);empty.parse(req.body);const{id}=jobParams.parse(req.params);return runLocalWooHttpJobOnce(fixture,session(req),id);});
 app.get('/api/local-fixtures/woocommerce/channel',req=>readLocalWooHttpChannel(fixture,session(req)));
 app.post('/api/local-fixtures/woocommerce/channel',async(req,reply)=>{ensure(!options.readOnly,423,'Zapis jest wyłączony w podglądzie');const result=await enrollLocalWooHttpChannel(fixture,session(req),req.body);return reply.code(201).send(result);});
}
