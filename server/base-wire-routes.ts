import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { Actor } from './domain';
import { z, ZodError } from 'zod';
import { Problem, ensure } from './errors';
import { hasOrdinaryRequestAdmission, runOrdinaryRequestError, type OrdinaryRequestLifetime } from './ordinary-request-lifetime';
import type { ApiScope } from './developer-api';
import { BASE_WIRE_LOCAL_LIMITS, decodeBaseWireRequest, encodeBaseWireError, encodeBaseWireSuccess, type BaseWireJson } from './base-wire-codec';
export type BaseWirePrincipal = {id:string;tenant_id:string;role:Actor['role'];api_key_id:string;scopes:string[]};
export type BaseWireRouteContext = {
  /** Extra GET route in the shared connector child: same headers and error envelope. */
  get(url:string,handler:(req:FastifyRequest,reply:FastifyReply)=>Promise<unknown>):void;
  /** X-BLToken only, server-selected scope, X-Workspace-Id must match the key. */
  principal(req:FastifyRequest,scope:ApiScope):Promise<BaseWirePrincipal>;
  /** The same per-tenant limit as POST /connector.php (one bucket per tenant), after authentication. */
  admitTenant(req:FastifyRequest,reply:FastifyReply,tenant:string):Promise<void>;
};
/** One Base API method family on the single connector.php. Every field is a
 * server startup decision; request data never selects capability or scope. */
export type BaseWireFamily = Readonly<{
  /** Local Polish label, e.g. 'CRM' ("Żądanie CRM odrzucone."). */
  label:string;
  methods:readonly string[];
  /** Required scope: crm:* from base_wire218_key_scopes, others from api_keys.scopes. */
  scope(method:string):ApiScope;
  isWrite(method:string):boolean;
  available:boolean;
  /** Optional per-method startup capability gate, checked before authentication. */
  admit?(method:string):void;
  /** Startup opt-in: the family's native writer re-verifies the authenticated
   * key at COMMIT (credential custody), so it receives that credential. Never
   * persist, log or echo it. Families without this flag never see it. */
  nativeCredentialCustody?:boolean;
  service:{execute(actor:Actor,method:string,parameters:Record<string,BaseWireJson>,options:{clientKey?:string;credential?:string}):Promise<Record<string,BaseWireJson>>};
  routes?(context:BaseWireRouteContext):void;
}>;
export type BaseWireRouteOptions = {
  families:readonly BaseWireFamily[];
  authenticate(token:string,scope:ApiScope,ip?:string):Promise<BaseWirePrincipal>;
  readOnly:boolean;
  requestLifetime?:OrdinaryRequestLifetime;
};
/** Startup composition: a method belongs to exactly one family. */
export function createBaseWireFamilyRegistry(input:readonly BaseWireFamily[]) {
  ensure(Array.isArray(input)&&input.length>0,503,'Brak rodzin metod Base API');
  const families=Object.freeze([...input]),owners=new Map<string,BaseWireFamily>();
  for(const family of families){
    ensure(family&&Array.isArray(family.methods)&&family.methods.length>0,503,'Rodzina Base API bez metod');
    for(const method of family.methods){ensure(!owners.has(method),503,'Metoda Base API zarejestrowana dwukrotnie');owners.set(method,family);}
  }
  return Object.freeze({families,methods:Object.freeze([...owners.keys()]),
    family(method:string){const family=owners.get(method);if(!family)throw new Problem(400,'Nieznana metoda Base API','LOCAL_BASE_WIRE_METHOD');return family;}});
}
function token(header:unknown,legacy?:string) {
  ensure(header===undefined||typeof header==='string',401,'Nieprawidłowy X-BLToken');
  if(header!==undefined){ensure(header.length>0&&!/[\s\x00-\x1f\x7f]/.test(header),401,'Nieprawidłowy X-BLToken');ensure(!legacy||legacy===header,401,'Niejednoznaczne poświadczenia');return header;}
  ensure(legacy,401,'Brak X-BLToken');return legacy;
}
// A raw PostgreSQL/driver text some native mappers pass through (constraint, relation, SQL,
// identifiers) or a credential is never a business reason: the generic text is used instead.
const INTERNAL=/\b(violates|constraint|duplicate key|relation|column|syntax|sql|select|insert|update|delete|null value|permission denied|stack|function|trigger)\b|dyna_api_|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** The safe Polish reason of a 4xx Problem, or '' when it is not one. */
export function baseWireSafeReason(message:string) {
  const text=String(message??'').replace(/[\x00-\x1f\x7f]+/g,' ').trim();
  return !text||INTERNAL.test(text)?'':text.slice(0,300);
}
/** Error codes/HTTP mapping here are explicitly LOCAL policy; never echo input,
 * a credential, SQL error or exception message. No invented Base error code.
 * A 4xx Problem carries its Polish business reason (the same `detail` the native
 * REST API returns for that refusal); validation (Zod), Fastify/parser 4xx and
 * every 5xx keep the generic text. */
export function baseWireError(error:unknown,writing=false,label?:string) {
  const fastifyStatus=error && typeof error==='object' && 'statusCode' in error ? (error as {statusCode:unknown}).statusCode : undefined;
  const status=error instanceof Problem?error.status:error instanceof ZodError?422:typeof fastifyStatus==='number'&&Number.isInteger(fastifyStatus)&&fastifyStatus>=400&&fastifyStatus<500?fastifyStatus:500;
  const code=error instanceof Problem&&error.code?.startsWith('LOCAL_BASE_WIRE_')?error.code:
    status>=500&&writing?'LOCAL_BASE_WIRE_OUTCOME_UNCONFIRMED':'LOCAL_BASE_WIRE_'+status;
  const reason=error instanceof Problem&&status<500?baseWireSafeReason(error.message):'';
  return {status,body:encodeBaseWireError({error_code:code,error_message:status>=500?'Operacja nie została potwierdzona. Nie ponawiaj automatycznie.':reason||'Żądanie '+(label??'Base API')+' odrzucone.'})};
}
/** Observer of successful connector.php reads (228 personal-data access register). Only
 * buildApp installs it; it runs after the read and before the reply, so a read that cannot
 * be recorded is not returned. */
export type BaseWireReadObserver=(label:string,actor:Actor,method:string,payload:unknown)=>Promise<void>;
let readObserver:BaseWireReadObserver|null=null;
export function observeBaseWireReads(observer:BaseWireReadObserver|null){readObserver=observer;}
export const baseWireReadObserver=()=>readObserver;
export function registerBaseWireRoutes(app:FastifyInstance,opts:BaseWireRouteOptions) {
  const registry=createBaseWireFamilyRegistry(opts.families);
  // Encapsulation preserves every existing JSON/body parser and REST route.
  app.register(async wire=>{
    // Retained docs say100/min but do not define the quota key. Local policy:
    // one authenticated tenant across its keys and ALL families on this app,
    // process-local LRU (5000 entries, reset on restart/eviction). Keep the parent's600/IP gate.
    if(!wire.hasDecorator('createRateLimit'))await wire.register(rateLimit,{global:false,cache:5000});
    const tenants=new WeakMap<FastifyRequest,string>(),labels=new WeakMap<FastifyRequest,string>();
    const limitOptions={max:100,timeWindow:60000,cache:5000,allowList:()=>false,
      keyGenerator:(req:FastifyRequest)=>{const tenant=tenants.get(req);ensure(tenant,503,'Brak uwierzytelnionej firmy limitu API');return tenant;}};
    const checkTenantLimit=wire.createRateLimit(limitOptions);
    async function admitTenant(req:FastifyRequest,reply:FastifyReply,tenant:string){
      tenants.set(req,tenant);
      const result=await checkTenantLimit(req);
      if(!result.isAllowed){
        reply.header('X-RateLimit-Limit',result.max).header('X-RateLimit-Remaining',result.remaining).header('X-RateLimit-Reset',result.ttlInSeconds);
        if(result.isExceeded){reply.header('Retry-After',Math.max(1,result.ttlInSeconds));throw new Problem(429,'Limit żądań Base API','LOCAL_BASE_WIRE_RATE_LIMIT');}
      }
    }
    async function principal(req:FastifyRequest,scope:ApiScope,legacy?:string,credential=token(req.headers['x-bltoken'],legacy)){
      const p=await opts.authenticate(credential,scope,req.ip);
      ensure(req.headers['x-workspace-id']===undefined||req.headers['x-workspace-id']===p.tenant_id,409,'Organizacja nie odpowiada kluczowi API');
      return p;
    }
    wire.addHook('onRequest',async(_req,reply)=>{reply.header('Cache-Control','private, no-store');reply.header('X-Content-Type-Options','nosniff');});
    wire.addContentTypeParser('application/x-www-form-urlencoded',{parseAs:'buffer',bodyLimit:BASE_WIRE_LOCAL_LIMITS.requestBytes},(_req,body,done)=>done(null,body));
    wire.setErrorHandler((error,req,reply)=>{
      const respond=()=>{const result=baseWireError(error,false,labels.get(req));return reply.header('Cache-Control','private, no-store').header('X-Content-Type-Options','nosniff').code(result.status).type('application/json; charset=utf-8').send(result.body);};
      // The child handler owns final error completion, just like buildApp's root
      // handler. Parser/hook/file errors must release their admitted request.
      return hasOrdinaryRequestAdmission(opts.requestLifetime,req)
        ? runOrdinaryRequestError(opts.requestLifetime,req,respond) : respond();
    });
    wire.route({method:wire.supportedMethods.filter(method=>method!=='POST'),url:'/connector.php',exposeHeadRoute:false,
      handler:async(_req,reply)=>{reply.header('Allow','POST');throw new Problem(405,'Base API wymaga POST','LOCAL_BASE_WIRE_HTTP_METHOD');}});
    wire.post('/connector.php',{bodyLimit:BASE_WIRE_LOCAL_LIMITS.requestBytes},async(req,reply)=>{
      let writing=false,label:string|undefined;
      try{
        const request=decodeBaseWireRequest({httpMethod:req.method,contentType:String(req.headers['content-type']??''),body:req.body as Buffer},registry.methods);
        const family=registry.family(request.method);label=family.label;
        writing=family.isWrite(request.method);
        ensure(family.available,503,'Moduł Base '+family.label+' jest niedostępny');ensure(!writing||!opts.readOnly,423,'Podgląd kopii jest tylko do odczytu');
        family.admit?.(request.method);
        const credential=token(req.headers['x-bltoken'],request.legacyToken);
        const p=await principal(req,family.scope(request.method),request.legacyToken,credential);
        const actor:Actor={tenantId:z.uuid().parse(p.tenant_id),userId:z.uuid().parse(p.id),role:z.enum(['admin','operator','viewer']).parse(p.role),apiKeyId:z.uuid().parse(p.api_key_id),source:'api'};
        const key=req.headers['idempotency-key'];ensure(key===undefined||typeof key==='string',422,'Nieprawidłowy klucz polecenia');
        const clientKey=key===undefined?undefined:z.uuid().parse(key);
        await admitTenant(req,reply,actor.tenantId);
        const payload=await family.service.execute(actor,request.method,request.parameters,family.nativeCredentialCustody===true?{clientKey,credential}:{clientKey});
        if(!writing&&readObserver)await readObserver(family.label,actor,request.method,payload);
        reply.header('Cache-Control','private, no-store').type('application/json; charset=utf-8');
        return reply.send(encodeBaseWireSuccess(payload));
      }catch(error){const result=baseWireError(error,writing,label);return reply.code(result.status).type('application/json; charset=utf-8').send(result.body);}
    });
    for(const family of registry.families){
      const context:BaseWireRouteContext={principal:(req,scope)=>principal(req,scope),admitTenant,
        get:(url,handler)=>{wire.get(url,async(req,reply)=>{labels.set(req,family.label);return handler(req,reply);});}};
      family.routes?.(context);
    }
  });
}
