import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {ensure} from './errors';
import type {createLocalWooOrderImport} from './local-woo-order-import';
export function registerLocalWooOrderImportRoutes(app:FastifyInstance,o:{lane?:ReturnType<typeof createLocalWooOrderImport>;readOnly:boolean;sessionName:string;running:()=>boolean}){
 const lane=o.lane;if(!lane)return;const params=z.strictObject({channelId:z.uuid()}),empty=z.strictObject({});
 function actor(req:FastifyRequest){ensure(!req.headers.authorization&&!!req.cookies[o.sessionName]&&!req.actor.apiKeyId&&req.apiScopes===undefined&&req.actor.source!=='api'&&req.actor.role==='admin'&&req.currentUser?.id===req.actor.userId&&req.currentUser.tenant_id===req.actor.tenantId&&req.currentUser.role==='admin'&&!req.currentUser.api_key_id,403,'Wymagana aktualna zwykła sesja administratora');return req.actor;}
 const base='/api/local-fixtures/woocommerce/channels/:channelId/order-import';
 app.get(base,async req=>{empty.parse(req.query);return{...await lane.read(actor(req),params.parse(req.params).channelId),processor_running:o.running()};});
 app.post(base+'/commands',async(req,reply)=>{ensure(!o.readOnly,423,'Podgląd nie pozwala zmieniać ustawień');empty.parse(req.query);ensure(!z.object({enabled:z.boolean()}).parse(req.body).enabled||o.running(),503,'Automatyczny czytnik nie działa');return reply.code(201).send(await lane.configure(actor(req),params.parse(req.params).channelId,req.body));});
 app.post(base+'/commands/observe',req=>{empty.parse(req.query);return lane.observe(actor(req),params.parse(req.params).channelId,req.body);});
 app.post(base+'/commands/cancel',req=>{ensure(!o.readOnly,423,'Podgląd nie pozwala zmieniać ustawień');empty.parse(req.query);return lane.cancel(actor(req),params.parse(req.params).channelId,req.body);});
}
