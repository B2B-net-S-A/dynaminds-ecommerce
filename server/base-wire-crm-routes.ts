import type { FastifyInstance } from 'fastify';
import type { Actor } from './domain';
import { z } from 'zod';
import { ensure } from './errors';
import type { OrdinaryRequestLifetime } from './ordinary-request-lifetime';
import { BASE_WIRE_CRM_DISPATCH_METHODS, baseWireCrmDispatchScope, isBaseWireCrmDispatchWrite } from './base-wire-crm-dispatch';
import { BASE_WIRE_CRM_DICTIONARY_METHODS } from './base-wire-crm-dictionaries';
import type { BaseWireCrmService } from './base-wire-crm';
import type { BaseWireJson } from './base-wire-codec';
import { registerBaseWireRoutes, baseWireReadObserver, type BaseWireFamily, type BaseWirePrincipal } from './base-wire-routes';
export type BaseWireCrmRouteOptions = {
  service: {
    execute(actor:Actor,method:string,parameters:Record<string,BaseWireJson>,options?:{clientKey?:string}):Promise<Record<string,BaseWireJson>>;
    file:BaseWireCrmService['file'];
  };
  authenticate(token:string,scope:'crm:read'|'crm:write'):Promise<BaseWirePrincipal>;
  available:boolean;
  /** Server startup capability only. No219 activation from request data. */
  dictionaryAvailable?:boolean;
  readOnly:boolean;
  requestLifetime?:OrdinaryRequestLifetime;
};
/** First connector.php family: 218 clients + 219 dictionaries, crm:* scopes. */
export function createBaseWireCrmFamily(opts:Pick<BaseWireCrmRouteOptions,'service'|'available'|'dictionaryAvailable'>):BaseWireFamily {
  const dictionaryAvailable=opts.dictionaryAvailable===true,available=opts.available===true,service=opts.service;
  return Object.freeze({label:'CRM',methods:BASE_WIRE_CRM_DISPATCH_METHODS,scope:baseWireCrmDispatchScope,isWrite:isBaseWireCrmDispatchWrite,available,service,
    admit(method:string){
      if(BASE_WIRE_CRM_DICTIONARY_METHODS.includes(method as typeof BASE_WIRE_CRM_DICTIONARY_METHODS[number]))
        ensure(dictionaryAvailable,503,'Słowniki Base CRM wymagają zweryfikowanego219');
    },
    routes({get,principal,admitTenant}){
      get('/connector.php/files/clients/:clientId/fields/:fieldId',async(req,reply)=>{
        ensure(available,503,'Moduł Base CRM jest niedostępny');
        const p=await principal(req,'crm:read');
        const actor:Actor={tenantId:p.tenant_id,userId:p.id,role:p.role,apiKeyId:p.api_key_id,source:'api'};
        const ids=z.object({clientId:z.string().regex(/^[1-9][0-9]*$/),fieldId:z.string().regex(/^[1-9][0-9]*$/)}).parse(req.params);
        await admitTenant(req,reply,actor.tenantId);
        const file=await service.file(actor,Number(ids.clientId),Number(ids.fieldId));
        await baseWireReadObserver()?.('CRM',actor,'file',{crm_client_id:Number(ids.clientId)});
        reply.header('Cache-Control','private, no-store').header('X-Content-Type-Options','nosniff').header('Content-Disposition',"attachment; filename*=UTF-8''"+encodeURIComponent(file.title)).type(file.mime_type);
        return reply.send(file.bytes);
      });
    }});
}
/** CRM-only connector.php (component tests). buildApp registers the registry. */
export function registerBaseWireCrmRoutes(app:FastifyInstance,opts:BaseWireCrmRouteOptions) {
  registerBaseWireRoutes(app,{families:[createBaseWireCrmFamily(opts)],authenticate:opts.authenticate,readOnly:opts.readOnly,requestLifetime:opts.requestLifetime});
}
