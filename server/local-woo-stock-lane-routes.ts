/** Native session routes for the construction-selected stock lane: status, a read-only Woo
 * observation preview and the operator reconciliation of an unacknowledged dispatch. No execution
 * endpoint; nothing here re-sends a provider write. */
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {ensure} from './errors';
import type {createLocalWooStockLane} from './local-woo-stock-lane';
export type LocalWooStockLane=ReturnType<typeof createLocalWooStockLane>;
export function registerLocalWooStockLaneRoutes(app:FastifyInstance,options:{lane?:LocalWooStockLane;readOnly:boolean;sessionName:string;processorRunning:()=>boolean}){
 const lane=options.lane;if(!lane)return;
 const channel=z.strictObject({channelId:z.uuid()}),empty=z.strictObject({});
 const actor=(req:FastifyRequest)=>{
  ensure(!req.headers.authorization&&!!req.cookies[options.sessionName]&&!req.actor.apiKeyId&&req.apiScopes===undefined&&req.actor.source!=='api',403,'Wymagana zwykła sesja administratora');
  ensure(req.actor.role==='admin'&&req.currentUser?.id===req.actor.userId&&req.currentUser.tenant_id===req.actor.tenantId&&req.currentUser.role==='admin'&&!req.currentUser.api_key_id,403,'Wymagana aktualna sesja tej firmy');return req.actor;
 };
 const scope=(req:FastifyRequest)=>{empty.parse(req.query);const a=actor(req),p=channel.parse(req.params);return{a,id:p.channelId};};
 const base='/api/local-fixtures/woocommerce/channels/:channelId/stock-lane';
 app.get(base,async req=>{const{a,id}=scope(req);return{scope:'selected_local_stock',provider_verified:false,...await lane.readStockLane(a,id),processor_running:options.processorRunning()};});
 // One provider GET of the uncertain offer; no DB or provider write.
 app.get(base+'/reconciliation-preview',async req=>{const{a,id}=scope(req);return lane.previewReconciliation(a,id);});
 // Core validates the full strict command, re-reads Woo and records the outcome under the claim locks.
 app.post(base+'/reconcile',async req=>{ensure(!options.readOnly,423,'Zapis jest wyłączony w podglądzie');const{a,id}=scope(req);return lane.reconcile(a,id,req.body);});
 app.post(base+'/reconcile/observe',async req=>{const{a,id}=scope(req);return lane.observeReconciliation(a,id,req.body);});
}
