import type {FastifyInstance, FastifyRequest} from 'fastify';
import {z} from 'zod';
import {ensure} from './errors';
import {createLocalWooFlow} from './local-woo-flow';

const params=z.strictObject({id:z.uuid()});
const command=z.strictObject({request_id:z.uuid(),step:z.enum(['order-stage','listing-sync','cancel-status'])});
const empty=z.strictObject({});

/** Register only after the actual app's authentication/tenant/CSRF hooks.
 * Code-owned service construction; no caller evaluator, ready flag or job/lease input.
 */
export function registerLocalWooFlowRoutes(app:FastifyInstance, options:{readOnly:boolean;sessionName:string}) {
  const readOnly=z.boolean().parse(options.readOnly);
  const sessionName=z.string().min(1).max(160).parse(options.sessionName);
  const service=createLocalWooFlow();
  function originalSession(req:FastifyRequest) {
    const a=req.actor,u=req.currentUser;
    ensure(a?.role==='admin' && a.source!=='api' && !a.apiKeyId && req.apiScopes===undefined
      && !u?.api_key_id && u?.id===a.userId && u.tenant_id===a.tenantId && u.role===a.role
      && typeof req.cookies?.[sessionName]==='string' && req.cookies[sessionName].length>0,
      403,'Wymagana oryginalna sesja administratora tej firmy; API key jest niedozwolony');
    return a; // Exact actual req.actor, never a DTO or second capture.
  }
  app.get('/api/integrations/:id/local-woo-flow',async(req,reply)=>{
    const a=originalSession(req),{id}=params.parse(req.params);
    empty.parse(req.query);
    reply.header('Cache-Control','no-store');
    return service.read(a,id);
  });
  app.post('/api/integrations/:id/local-woo-flow/steps',async(req,reply)=>{
    const a=originalSession(req),{id}=params.parse(req.params);
    ensure(!readOnly,423,'Kopia jest tylko do odczytu');
    empty.parse(req.query);
    const body=command.parse(req.body);
    reply.header('Cache-Control','no-store');
    // The entire real processor promise belongs to ordinary request lifetime.
    return service.run(a,{...body,channel_id:id});
  });
  app.get('/api/integrations/:id/local-woo-flow/current-sync',async(req,reply)=>{
    const a=originalSession(req),{id}=params.parse(req.params);empty.parse(req.query);reply.header('Cache-Control','no-store');return service.readCurrent(a,id);
  });
  app.get('/api/integrations/:id/local-woo-flow/current-sync/:request_id',async(req,reply)=>{
    const a=originalSession(req),{id,request_id}=z.strictObject({id:z.uuid(),request_id:z.uuid()}).parse(req.params);empty.parse(req.query);reply.header('Cache-Control','no-store');return service.readCurrent(a,id,request_id);
  });
  app.post('/api/integrations/:id/local-woo-flow/current-sync/previews',async(req,reply)=>{
    const a=originalSession(req),{id}=params.parse(req.params);ensure(!readOnly,423,'Kopia jest tylko do odczytu');empty.parse(req.query);
    const body=z.strictObject({request_id:z.uuid()}).parse(req.body);reply.header('Cache-Control','no-store');return service.previewCurrent(a,{...body,channel_id:id});
  });
  app.post('/api/integrations/:id/local-woo-flow/current-sync/queue',async(req,reply)=>{
    const a=originalSession(req),{id}=params.parse(req.params);ensure(!readOnly,423,'Kopia jest tylko do odczytu');empty.parse(req.query);
    const body=z.strictObject({request_id:z.uuid(),plan_id:z.uuid(),predecessor:z.discriminatedUnion('kind',[
      z.strictObject({kind:z.literal('initial')}),z.strictObject({kind:z.enum(['legacy','current']),request_id:z.uuid(),plan_id:z.uuid(),job_id:z.uuid()})])}).parse(req.body);
    reply.header('Cache-Control','no-store');return service.queueCurrent(a,{...body,channel_id:id});
  });
  // Full pending operation drain is owned by this installation, before app/pool close.
  app.addHook('onClose',async()=>{await service.close();});
}
