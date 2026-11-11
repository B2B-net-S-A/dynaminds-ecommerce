/** Registration factory only. Not mounted by app/index and does not enable the
 * health feature flag. Requires the application's ordinary cookie/auth/workspace
 * middleware and error handler BEFORE registration. Transport owns fresh DB IAM,
 * managed transactions and safe DTO projection; no route supplies an admission. */
import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import {z} from 'zod';
import {ensure} from './errors';
import {ORDER_SPLIT_LIMITS as L,orderSplitPreviewInput,orderSplitExecuteInput,orderSplitUuid} from './order-splits-schema';
import {captureOrderSplitRequest,createOrderSplitTransport,type OrderSplitRequest,type OrderSplitRead} from './order-split-transport';

/** Normal server dependency injection for route tests, never a request field or
 * a callback that declares IAM/Native readiness. Production uses the real port. */
export type OrderSplitRouteTransport={
  preview:(request:OrderSplitRequest,body:unknown)=>Promise<unknown>;
  execute:(request:OrderSplitRequest,body:unknown)=>Promise<unknown>;
  read:(request:OrderSplitRequest,input:OrderSplitRead)=>Promise<unknown>;
  lineage:(request:OrderSplitRequest,orderId:string)=>Promise<unknown>;
};
type Options={sessionName:string;readOnly:boolean;transport?:OrderSplitRouteTransport};
const empty=z.strictObject({});
const commandParams=z.strictObject({key:orderSplitUuid});
const resultParams=z.strictObject({id:orderSplitUuid});
const commandQuery=z.strictObject({operation:z.enum(['preview','execute'])});
const pageQuery=z.strictObject({cursor:z.string().min(1).max(2048).optional(),limit:z.coerce.number().int().min(1).max(100).default(100)});

export function registerOrderSplitRoutes(app:FastifyInstance,options:Options){
 ensure(options&&typeof options.readOnly==='boolean'&&typeof options.sessionName==='string'&&/^dyna_session(?:_preview_\d+)?$/.test(options.sessionName),500,'Niepoprawna konfiguracja interfejsu podziału');
 const config=Object.freeze({sessionName:options.sessionName,readOnly:options.readOnly});
 const transport=options.transport??createOrderSplitTransport();
 ensure(transport&&['preview','execute','read','lineage'].every(k=>typeof transport[k as keyof OrderSplitRouteTransport]==='function'),500,'Niekompletny transport podziału');
 const captures=new WeakMap<FastifyRequest,OrderSplitRequest>();
 const guard=(write:boolean)=>async(req:FastifyRequest,reply:FastifyReply)=>{
  reply.header('Cache-Control','no-store');
  ensure(!write||!config.readOnly,423,'Ta kopia jest tylko do odczytu');
  ensure(!req.apiScopes,403,'Ten interfejs podziału wymaga sesji operatora');
  const request=captureOrderSplitRequest({actor:req.actor,currentUser:req.currentUser,headers:req.headers,cookies:req.cookies??{}},config.sessionName,{readOnly:config.readOnly});
  ensure(!write||['admin','operator'].includes(request.role),403,'Brak uprawnień zapisu podziału');
  captures.set(req,request);
 };
 const actor=(req:FastifyRequest)=>{const captured=captures.get(req);ensure(captured,401,'Brak oryginalnego żądania');return captured;};
 const prefix='/api/order-splits';
 app.get(prefix+'/orders/:id/lineage',{onRequest:guard(false)},async req=>{
  const {id}=resultParams.parse(req.params);empty.parse(req.query);
  return transport.lineage(actor(req),id);
 });
 app.post(prefix+'/previews',{bodyLimit:L.request_bytes,onRequest:guard(true)},async(req,reply)=>{
  empty.parse(req.query);const body=orderSplitPreviewInput.parse(req.body);
  //200 describes a verified result equally for a new command and exact replay.
  return reply.code(200).send(await transport.preview(actor(req),body));
 });
 app.post(prefix+'/executions',{bodyLimit:L.request_bytes,onRequest:guard(true)},async(req,reply)=>{
  empty.parse(req.query);const body=orderSplitExecuteInput.parse(req.body);
  return reply.code(200).send(await transport.execute(actor(req),body));
 });
 app.get(prefix+'/commands/:key',{onRequest:guard(false)},async req=>{
  const {key}=commandParams.parse(req.params),{operation}=commandQuery.parse(req.query);
  return transport.read(actor(req),{operation,client_key:key,view:'command'});
 });
 for(const kind of ['previews','executions'] as const){
  const operation=kind==='previews'?'preview':'execute';
  for(const view of ['head','source','source-items','children','commercial'] as const){
   app.get(prefix+'/'+kind+'/:id/'+view,{onRequest:guard(false)},async req=>{
    const {id}=resultParams.parse(req.params);
    const paginated=view==='source-items'||view==='children';
    const query=paginated?pageQuery.parse(req.query):empty.parse(req.query);
    return transport.read(actor(req),{operation,id,view,...(paginated?{query}:{})});
   });
  }
 }
}
