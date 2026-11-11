import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ensure } from './errors';
import { pool } from './db';
import * as P from './packed-label-print';
export function registerPackedLabelPrintRoutes(app:FastifyInstance,opts:{available:boolean;readOnly:boolean}){
 const root='/api/print-jobs/packed-labels';const id=(r:any)=>z.strictObject({id:z.uuid()}).parse(r.params).id;
 const flags=(v:any)=>({...v,read_only:opts.readOnly,can_manage:!opts.readOnly&&v.can_manage,can_write:!opts.readOnly&&v.can_write});
 app.addHook('onRequest',async(req,reply)=>{const path=req.url.split('?')[0].replace(/^\/api\/v1\//,'/api/');if(path!==root&&!path.startsWith(root+'/'))return;reply.header('Cache-Control','no-store');
 const write=!['GET','HEAD','OPTIONS'].includes(req.method);if(write)ensure(!opts.readOnly,423,'Kopia jest tylko do odczytu');
 ensure(!req.apiScopes,403,'Zgoda przyszłych wydruków wymaga zwykłej sesji');
 if(write)ensure(opts.available&&await P.packedLabelPrintAvailable(pool),503,'Automatyczny druk nie jest dostępny');});
 app.get(root+'/options',async req=>{z.strictObject({}).parse(req.query);return flags(await P.packedLabelPrintOptions(req.actor));});
 app.get(root+'/intentions',async req=>flags(await P.packedLabelPrintIntentions(req.actor,req.query)));
 app.post(root+'/previews',async(req,reply)=>{z.strictObject({}).parse(req.query);const r=await P.previewPackedLabelPrint(req.actor,req.body);reply.code(201);return flags(r);});
 app.post(root+'/previews/:id/approve',async(req,reply)=>{z.strictObject({}).parse(req.query);const r=await P.approvePackedLabelPrint(req.actor,id(req),req.body);reply.code(r.reused?200:201);return flags(r);});
 app.post(root+'/intentions/:id/resolve',async req=>{z.strictObject({}).parse(req.query);z.strictObject({}).parse(req.body);await P.resolvePackedLabelPrint(req.actor.tenantId,id(req),req.actor);return flags(await P.packedLabelPrintIntentions(req.actor,{}));});
}
