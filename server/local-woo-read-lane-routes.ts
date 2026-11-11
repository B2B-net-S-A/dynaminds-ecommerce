/** Native session routes for explicitly constructed local readers; no execution endpoint. */
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {ensure} from './errors';
import type {createLocalWooReadLane} from './local-woo-read-lane';
export type LocalWooReadLane=ReturnType<typeof createLocalWooReadLane>;
export function registerLocalWooReadLaneRoutes(app:FastifyInstance,options:{lane?:LocalWooReadLane;readOnly:boolean;sessionName:string;processorRunning:()=>boolean}){
 const lane=options.lane;if(!lane)return;
 const channel=z.strictObject({channelId:z.uuid()}),detail=channel.extend({id:z.uuid()}),empty=z.strictObject({});
 const actor=(req:FastifyRequest)=>{
  ensure(!req.headers.authorization&&!!req.cookies[options.sessionName]&&!req.actor.apiKeyId&&req.apiScopes===undefined&&req.actor.source!=='api',403,'Wymagana zwykła sesja administratora');
  ensure(req.actor.role==='admin'&&req.currentUser?.id===req.actor.userId&&req.currentUser.tenant_id===req.actor.tenantId&&req.currentUser.role==='admin'&&!req.currentUser.api_key_id,403,'Wymagana aktualna sesja tej firmy');return req.actor;
 };
 const base='/api/local-fixtures/woocommerce/channels/:channelId/read-lanes';
 app.get(base,async req=>{const a=actor(req),p=channel.parse(req.params);return{scope:'selected_local_reads',provider_verified:false,...await lane.read(a,p.channelId,req.query),processor_running:options.processorRunning()};});
 app.post(base,async(req,reply)=>{
  ensure(!options.readOnly,423,'Zapis jest wyłączony w podglądzie');empty.parse(req.query);const a=actor(req),p=channel.parse(req.params);
  // Parse only the boolean required for the runtime gate; core validates the full strict command.
  const enabling=z.object({enabled:z.boolean()}).parse(req.body).enabled;ensure(!enabling||options.processorRunning(),503,'Procesor automatycznych odczytów nie został uruchomiony');
  return reply.code(201).send(await lane.configure(a,p.channelId,req.body));
 });
 // Cancel only the original command. Core serializes against configure and validates its full strict body.
 app.post(base+'/commands/cancel',async req=>{
  ensure(!options.readOnly,423,'Zapis jest wyłączony w podglądzie');empty.parse(req.query);const a=actor(req),p=channel.parse(req.params);
  return lane.cancelCommand(a,p.channelId,req.body);
 });
 // Explicitly observational POST transports the original complete command; no control/job writes.
 app.post(base+'/commands/observe',async req=>{empty.parse(req.query);const a=actor(req),p=channel.parse(req.params);return lane.observeCommand(a,p.channelId,req.body);});
 // Preview and observation do not dispatch a processor or change a job.
 app.get(base+'/occurrences/:id/abort-preview',async req=>{empty.parse(req.query);const a=actor(req),p=detail.parse(req.params);return lane.previewAbort(a,p.channelId,p.id);});
 app.post(base+'/occurrences/:id/abort',async req=>{ensure(!options.readOnly,423,'Zapis jest wyłączony w podglądzie');empty.parse(req.query);const a=actor(req),p=detail.parse(req.params);return lane.abortAttempt(a,p.channelId,p.id,req.body);});
 app.post(base+'/occurrences/:id/abort/observe',async req=>{empty.parse(req.query);const a=actor(req),p=detail.parse(req.params);return lane.observeAbort(a,p.channelId,p.id,req.body);});
 app.get(base+'/occurrences/:id',async req=>{const a=actor(req),p=detail.parse(req.params),value=await lane.readOccurrence(a,p.channelId,p.id,req.query),diagnostic=await lane.readDiagnostic(a,p.channelId,p.id);return{scope:'selected_local_reads',provider_verified:false,...value,diagnostic,processor_running:options.processorRunning()};});
}
