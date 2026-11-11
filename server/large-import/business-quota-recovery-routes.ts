/** Normal admin recovery only. Independent certified capability; no public API-key alias or importer-ready override. */
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {ensure} from '../errors';
import {invoke} from '../../shared/large-import-dependencies/pim-large-import-http-binding-ui/routes';
import {assertBusinessQuotaRecoveryPort,inspectBusinessQuotaRecovery,renewBusinessQuotaRecovery,renewalExpectation,type BusinessQuotaRecoveryPort} from './business-quota-recovery';
const params=z.strictObject({catalog_id:z.uuid(),id:z.uuid()}),empty=z.strictObject({});
function permission(req:FastifyRequest){ensure(req.currentUser&&req.actor,401,'Zaloguj się');ensure(req.actor.role==='admin',403,'Wymagana rola administratora');ensure(req.actor.apiKeyId==null&&req.currentUser.api_key_id==null&&!req.apiScopes,403,'Odzyskiwanie wymaga bieżącej sesji administratora');}
export async function registerBusinessQuotaRecoveryRoutes(app:FastifyInstance,options:{readOnly:boolean;port?:BusinessQuotaRecoveryPort}){
 const readOnly=options.readOnly,port=options.port;if(port)assertBusinessQuotaRecoveryPort(port);
 const base='/api/product-catalogs/:catalog_id/large-import/jobs/:id/quota';
 const admitted=(req:FastifyRequest,write:boolean)=>{permission(req);if(write)ensure(!readOnly,423,'Ta kopia jest tylko do odczytu');ensure(port,503,'Brak certyfikowanego odzyskiwania czasu rezerwacji');assertBusinessQuotaRecoveryPort(port);};
 app.get(base+'/renewal-preview',async(req,reply)=>{reply.header('Cache-Control','no-store');admitted(req,false);return invoke(async()=>{params.parse(req.params);empty.parse(req.query);return inspectBusinessQuotaRecovery(port!,req);});});
 app.post(base+'/renew', {bodyLimit:2048,onRequest:async req=>admitted(req,true)},async(req,reply)=>{
  reply.header('Cache-Control','no-store');return invoke(async()=>{params.parse(req.params);empty.parse(req.query);const expected=renewalExpectation.parse(req.body),abort=new AbortController(),cancel=()=>abort.abort();req.raw.once('aborted',cancel);if(req.raw.aborted)cancel();
   try{return await renewBusinessQuotaRecovery(port!,req,expected,abort.signal);}finally{req.raw.removeListener('aborted',cancel);}
  });
 });
}
