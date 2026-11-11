import {capturePhysicalParcelWzAuthority} from './physical-parcel-wz';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from './db';
import { ensure } from './errors';
import { captureOperationalDeliveryAuthority } from './operational-delivery-consumers';
import * as P from './order-parcels';
import * as V from './order-parcels-values';
export function registerOrderParcelRoutes(app:FastifyInstance,opts:{available:boolean;readOnly:boolean;sessionName:string}){
 const root='/api/order-parcels';const actor=(req:any):V.OrderParcelActor=>capturePhysicalParcelWzAuthority(req,opts.sessionName,captureOperationalDeliveryAuthority(req,opts.sessionName));
 const id=(req:any)=>z.strictObject({id:V.parcelUuid}).parse(req.params).id;
 const empty=(req:any)=>z.strictObject({}).parse(req.query);
 const mask=(r:any)=>({...r,read_only:opts.readOnly,can_write:!opts.readOnly&&r.can_write,...(r.source?{source:{...r.source,can_preview:!opts.readOnly&&r.source.can_preview}}:{}),...(r.preview?{preview:{...r.preview,can_apply:!opts.readOnly&&r.preview.can_apply}}:{})});
 app.addHook('onRequest',async(req,reply)=>{const path=req.url.split('?')[0].replace(/^\/api\/v1\//,'/api/');if(!path.startsWith(root+'/'))return;reply.header('Cache-Control','no-store');const write=!['GET','HEAD','OPTIONS'].includes(req.method);if(write){ensure(!opts.readOnly,423,'Kopia jest tylko do odczytu');ensure(opts.available&&await P.orderParcelsAvailable(pool),503,'Kopia nie zawiera przydziałów paczek');}if(req.apiScopes)ensure(req.apiScopes.includes('orders:read')&&(!write||req.apiScopes.includes('orders:write')),403,'Klucz API nie ma zakresów paczek');});
 app.get(root+'/orders/:id/source',async req=>{empty(req);await P.orderParcelsAvailable(pool);if(!opts.available)return {available:false,read_only:opts.readOnly,current_role:null,can_read:false,can_write:false,source:null,commercial_available:false,limits:V.ORDER_PARCEL_LIMITS};return mask(await P.orderParcelSource(actor(req),id(req)));});
 app.post(root+'/orders/:id/previews',async(req,reply)=>{empty(req);const r=await P.createOrderParcelPreview(actor(req),id(req),V.orderParcelPreviewInput.parse(req.body));reply.code(r.reused?200:201);return mask(r);});
 app.get(root+'/previews/:id',async req=>{empty(req);return mask(await P.orderParcelPreviewDetail(actor(req),id(req)));});
 app.post(root+'/previews/:id/apply',async(req,reply)=>{empty(req);const r=await P.applyOrderParcelPlan(actor(req),id(req),V.orderParcelApplyInput.parse(req.body));reply.code(r.reused?200:201);return mask(r);});
 app.get(root+'/plans/:id',async req=>{empty(req);return mask(await P.orderParcelPlanDetail(actor(req),id(req)));});
 app.post(root+'/plans/:id/parcels/:index/dispatch',async req=>{empty(req);const p=z.strictObject({id:V.parcelUuid,index:V.orderParcelIndex}).parse(req.params);return mask(await P.dispatchOrderParcel(actor(req),p.id,p.index,V.orderParcelDispatchInput.parse(req.body)));});
 app.get(root+'/orders/:id/history',async req=>mask(await P.orderParcelHistory(actor(req),id(req),V.orderParcelHistoryInput.parse(req.query))));
}
