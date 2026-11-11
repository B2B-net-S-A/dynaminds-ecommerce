/** Authenticated manual public-rate reads; no persistence or financial effects. */
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {Problem,ensure} from './errors';
import {NbpExchangeRateError,type readLatestNbpTableARate} from './nbp-exchange-rates';
import type {NbpPublication} from './nbp227-model';
export type NbpRatesPort=Readonly<{currencies:readonly string[];maxAgeDays:number;read:(currency:string,signal?:AbortSignal)=>ReturnType<typeof readLatestNbpTableARate>;
 /** 227: table A of a day (end omitted) or a date range, when both routes are declared. */
 readTableA?:(currency:string,start:string,end:string|undefined,signal?:AbortSignal)=>Promise<NbpPublication[]>}>;
const query=z.strictObject({currency:z.literal('EUR')});
export function registerNbpRoutes(app:FastifyInstance,options:{readOnly:boolean;port?:NbpRatesPort}){
 const actor=(req:any)=>{ensure(req.actor?.tenantId&&req.actor?.userId,401,'Zaloguj się do systemu');ensure(req.actor.source!=='api'&&!req.actor.apiKeyId,403,'Ten odczyt wymaga sesji użytkownika');};
 app.get('/api/nbp',async req=>{actor(req);return {available:!options.readOnly&&options.port!==undefined,read_only:options.readOnly,currencies:options.readOnly?[]:options.port?.currencies??[],max_age_days:options.readOnly?null:options.port?.maxAgeDays??null};});
 app.get('/api/nbp/rate',{exposeHeadRoute:false},async(req,reply)=>{
  actor(req);ensure(!options.readOnly,423,'Połączenia z dostawcami są wyłączone w podglądzie kopii');
  const parsed=query.safeParse(req.query);if(!parsed.success)throw new Problem(422,'Wybierz obsługiwaną walutę EUR','NBP_REQUEST');
  const port=options.port;ensure(port&&port.currencies.includes(parsed.data.currency),503,'Odczyt NBP nie został włączony w tym środowisku');
  const controller=new AbortController(),abort=()=>controller.abort(),closed=()=>{if(!reply.raw.writableFinished)abort();};req.raw.once('aborted',abort);reply.raw.once('close',closed);
  try{return await port.read(parsed.data.currency,controller.signal);}
  catch(e){
   if(!(e instanceof NbpExchangeRateError))throw new Problem(502,'Nie udało się odczytać kursu NBP','NBP_RESPONSE');
   const status=e.code==='NOT_AVAILABLE'?404:e.code==='RATE_LIMITED'?429:['SOURCE_EXPIRED','FUTURE_PUBLICATION'].includes(e.code)?409:502;
   throw new Problem(status,status===404?'NBP nie opublikował kursu tej waluty':status===429?'Limit odczytów NBP. Spróbuj później':status===409?'Kurs NBP nie spełnia polityki świeżości':'Nie udało się odczytać poprawnego kursu NBP','NBP_'+e.code);
  }finally{req.raw.off('aborted',abort);reply.raw.off('close',closed);reply.header('Cache-Control','no-store');}
 });
}
