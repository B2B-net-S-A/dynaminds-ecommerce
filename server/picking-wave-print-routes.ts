import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {ensure} from './errors';
import {prepareWavePrint,queueWavePrint,readWavePrintPreview,readWavePrintPreviewByKey,readWavePrintContent} from './picking-wave-print';
const params=z.strictObject({id:z.uuid(),preview_id:z.uuid().optional(),client_key:z.uuid().optional()});
const empty=z.strictObject({});
export function registerPickingWavePrintRoutes(app:FastifyInstance,options:{available:boolean;readOnly:boolean}){
 function gate(req:any,writing:boolean){ensure(options.available,503,'Partie kompletacji są niedostępne');
 ensure(req.actor,401,'Wymagane logowanie');ensure(['admin','operator','viewer'].includes(req.actor.role),403,'Brak uprawnienia');
 if(writing){ensure(!options.readOnly,423,'Kopia jest tylko do odczytu');ensure(req.actor.role!=='viewer',403,'Konto ma uprawnienia tylko do odczytu');}
 // Existing public auth middleware still owns API-key scopes. No new alias here.
 if(req.actor.apiKeyId){ensure(req.apiScopes?.includes('orders:read'),403,'Brak zakresu orders:read');if(writing)ensure(req.apiScopes?.includes('orders:write'),403,'Brak zakresu orders:write');}
 }
 const read=(f:(req:any,p:z.infer<typeof params>)=>Promise<any>)=>async(req:any,reply:any)=>{gate(req,false);empty.parse(req.query);const p=params.parse(req.params);reply.header('cache-control','private, no-store');const r=await f(req,p);return options.readOnly&&r.preview?{...r,preview:{...r.preview,can_queue:false}}:r;};
 app.get('/api/picking-waves/:id/print-previews/by-key/:client_key',read((r,p)=>readWavePrintPreviewByKey(r.actor,p.id,p.client_key!)));
 app.get('/api/picking-waves/:id/print-previews/:preview_id',read((r,p)=>readWavePrintPreview(r.actor,p.id,p.preview_id!)));
 app.get('/api/picking-waves/:id/print-previews/:preview_id/content',read((r,p)=>readWavePrintContent(r.actor,p.id,p.preview_id!)));
 app.post('/api/picking-waves/:id/print-previews',async(req:any,reply)=>{gate(req,true);empty.parse(req.query);const p=params.parse(req.params);reply.header('cache-control','private, no-store');const r=await prepareWavePrint(req.actor,p.id,req.body);return reply.code(r.reused?200:201).send(r);});
 app.post('/api/picking-waves/:id/print-previews/:preview_id/queue',async(req:any,reply)=>{gate(req,true);empty.parse(req.query);const p=params.parse(req.params);reply.header('cache-control','private, no-store');const r=await queueWavePrint(req.actor,p.id,p.preview_id!,req.body);return reply.code(r.reused?200:201).send(r);});
}
