/** Read-only Mirakl HTTP surface. Import-inert: all IAM, channel, credential, repository
 * and transport access is explicitly injected; no OMS/control DB import or account acceptance. */
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {ensure,Problem} from './errors';
import {MIRAKL_ADAPTER_STATUS,parseMiraklOrderIdsQuery,type MiraklOrder} from './mirakl';
import {createMiraklChannelReader,miraklChannelConnectionHash,parseMiraklCredentials,
  type MiraklChannel,type MiraklReadRepository} from './mirakl-channel';
import type {Transport} from './integrations';

export type MiraklReadActor=Readonly<{tenantId:string;userId:string;sessionHash:string}>;
export type MiraklReadRoutesPort={
  sessionName:string;readOnly:boolean;externalReadsEnabled:boolean;
  repository?:MiraklReadRepository;transport?:Transport;
  /** Every call MUST check current private session/user/tenant/admin membership,
   * account-version/MFA policy, then load this exact tenant/channel in a short transaction.
   * The caller's captured role is not authority. Throw on revoked/expired IAM. No HTTP in tx. */
  currentChannel(actor:MiraklReadActor,channelId:string):Promise<MiraklChannel|null>;
  decryptCredentials(ciphertext:string):unknown;
  stageOrders?(actor:MiraklReadActor,channelId:string,connectionHash:string,rows:readonly(MiraklOrder&{id:string})[]):Promise<{data:Array<{id:string;state:string;source_hash:string}>}>;
  now?:()=>number;
};
const ids=z.strictObject({id:z.uuid()});
const pageNumber=(minimum:number,maximum:number,fallback:string)=>z.string().regex(/^(0|[1-9]\d*)$/)
  .default(fallback).transform(Number).pipe(z.number().int().min(minimum).max(maximum));
const ordersQuery=z.strictObject({start_update_date:z.iso.datetime({offset:true}),
  end_update_date:z.iso.datetime({offset:true}),max:pageNumber(1,100,'50'),offset:pageNumber(0,10000,'0')})
  .refine(q=>{const span=Date.parse(q.end_update_date)-Date.parse(q.start_update_date);return span>0&&span<=31*86400000;});
const orderIdsQuery=z.strictObject({order_ids:z.string().min(1).max(16099),group:pageNumber(0,99,'0')});
const offersQuery=z.strictObject({max:pageNumber(1,100,'50'),offset:pageNumber(0,10000,'0'),connection_hash:z.string().regex(/^[a-f0-9]{64}$/).optional(),sku:z.string().min(1).max(160)
  .refine(v=>!/[\x00-\x1f\x7f]/.test(v)).optional()});
const stageQuery=z.strictObject({start_update_date:z.iso.datetime({offset:true}),end_update_date:z.iso.datetime({offset:true}),
 max:z.number().int().min(1).max(100).default(50),offset:z.number().int().min(0).max(10000).default(0)})
 .refine(q=>{const span=Date.parse(q.end_update_date)-Date.parse(q.start_update_date);return span>0&&span<=31*86400000;});
function parse<T extends z.ZodType>(schema:T,value:unknown):z.output<T>{
 const result=schema.safeParse(value);ensure(result.success,422,'Mirakl: nieprawidłowe parametry odczytu');return result.data;
}
/** Capture only actual middleware-owned manual session context, never body/query actor IDs. */
export function captureMiraklReadActor(req:FastifyRequest,sessionName:string):MiraklReadActor{
 const a=req.actor,u=req.currentUser,token=req.cookies?.[sessionName];
 ensure(a?.role==='admin'&&a.source!=='api'&&!a.apiKeyId&&req.apiScopes===undefined
   &&!req.headers.authorization&&u?.id===a.userId&&u?.tenant_id===a.tenantId
   &&u?.role==='admin'&&!u?.api_key_id&&typeof token==='string'&&token.length>0,
 403,'Mirakl: wymagana aktualna zwykła sesja administratora');
 parse(z.uuid(),a.tenantId);parse(z.uuid(),a.userId);
 return Object.freeze({tenantId:a.tenantId,userId:a.userId,
  sessionHash:createHash('sha256').update(token).digest('hex')});
}
export function registerMiraklReadRoutes(app:FastifyInstance,port:MiraklReadRoutesPort){
 ensure(typeof port.currentChannel==='function'&&typeof port.decryptCredentials==='function'
   &&typeof port.sessionName==='string'&&port.sessionName.length>0,422,'Mirakl: brak portu aktualnej autoryzacji');
 const path='/api/integrations/:id/mirakl';
 async function prepare(req:FastifyRequest){
  ensure(!port.readOnly,423,'Mirakl: odczyty dostawcy wyłączone w podglądzie kopii');
  const actor=captureMiraklReadActor(req,port.sessionName),id=parse(ids,req.params).id;
  ensure(port.externalReadsEnabled&&port.repository&&port.transport,503,'Mirakl: trwały odczyt nie jest włączony w tym uruchomieniu');
  async function current(){
   const channel=await port.currentChannel(actor,id);
   ensure(channel&&channel.tenant_id===actor.tenantId&&channel.id===id&&channel.provider==='mirakl',404,'Nie znaleziono własnego kanału Mirakl');
   return channel;
  }
  const channel=await current(),generation=miraklChannelConnectionHash(channel);
  const guard=async()=>{const latest=await current();ensure(miraklChannelConnectionHash(latest)===generation,
   409,'Mirakl: ustawienia lub poświadczenia kanału zmieniły się podczas odczytu');};
  let credentials:ReturnType<typeof parseMiraklCredentials>;
  try{credentials=parseMiraklCredentials(port.decryptCredentials(channel.credentials));}
  catch{throw new Problem(422,'Mirakl: nieprawidłowe prywatne poświadczenia kanału');}
  const reader=createMiraklChannelReader({channel,credentials,repository:port.repository,
   transport:port.transport,guard,now:port.now});
  return{actor,id,channel,generation,reader,guard};
 }
 async function read<T>(req:FastifyRequest,operation:(reader:ReturnType<typeof createMiraklChannelReader>)=>Promise<T>,expectedConnectionHash?:string){
  const {id,channel,generation,reader,guard}=await prepare(req);
  ensure(expectedConnectionHash===undefined||expectedConnectionHash===generation,409,'Mirakl: połączenie zmieniło się; rozpocznij nowy odczyt ofert');
  const result=await operation(reader);await guard();
  return{channel_id:id,connection_hash:generation,mode:channel.mode,scope:'external_read' as const,read_only:true,
   account_verified:false,provider_acceptance:false,status:MIRAKL_ADAPTER_STATUS,
   stages_orders:false,imports_orders:false,result};
 }
 const readAccount=(req:FastifyRequest)=>{
  parse(z.strictObject({}),req.query);return read(req,reader=>reader.account());
 };
 app.get(path+'/account',{logLevel:'silent'},async req=>{
  ensure(req.body===undefined,422,'Mirakl: odczyt nie przyjmuje body');return readAccount(req);
 });
 app.get(path+'/orders-preview',{logLevel:'silent'},async req=>{
  const q=parse(ordersQuery,req.query);ensure(req.body===undefined,422,'Mirakl: odczyt nie przyjmuje body');
  return read(req,reader=>reader.readOrderPage({max:q.max,offset:q.offset,
   window:{start_update_date:q.start_update_date,end_update_date:q.end_update_date}}));
 });
 app.get(path+'/orders-readback',{logLevel:'silent'},async req=>{
  const q=parse(orderIdsQuery,req.query);ensure(req.body===undefined,422,'Mirakl: odczyt nie przyjmuje body');
  const input={order_ids:q.order_ids.split(','),group:q.group};
  parseMiraklOrderIdsQuery(input); // Refuse malformed/local-limit inputs before IAM/repository/HTTP.
  return read(req,reader=>reader.readOrdersByIds(input));
 });
 app.get(path+'/offers-preview',{logLevel:'silent'},async req=>{
  const q=parse(offersQuery,req.query);ensure(req.body===undefined,422,'Mirakl: odczyt nie przyjmuje body');
  const {connection_hash,...query}=q;
  return read(req,reader=>reader.readOffers(query),connection_hash);
 });
 app.post(path+'/orders-stage',{logLevel:'silent'},async req=>{
  parse(z.strictObject({}),req.query);const q=parse(stageQuery,req.body);
  ensure(typeof port.stageOrders==='function',503,'Mirakl: kolejka importu nie jest włączona w tym uruchomieniu');
  const {actor,id,generation,reader,guard}=await prepare(req);
  const page=await reader.readOrderPage({window:{start_update_date:q.start_update_date,end_update_date:q.end_update_date},max:q.max,offset:q.offset});
  await guard();
  const staged=await port.stageOrders(actor,id,generation,page.data);
  await guard();
  return{channel_id:id,scope:'external_read_local_stage' as const,imports_orders:false,stages_orders:true,
   account_verified:false,provider_acceptance:false,offset:page.offset,total_count:page.total_count,has_more:page.has_more,data:staged.data};
 });
 return Object.freeze({readAccount});
}
