/** Ordinary controller. The default service uses only genuine Native successor commands. */
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {ensure} from './errors';
import * as V from './return-credit206-values';
import {returnCredit206PrintHtml} from './return-credit206-print';
import type * as Service from './return-credit206-service';
export type ReturnCredit206RouteService=Pick<typeof Service,'returnCredit206Strategy'|'returnCredit206RequestActor'|'returnCredit206Available'|'returnCredit206FailedWrite'|'returnCredit206Options'|'returnCredit206Source'|'returnCredit206Preview'|'returnCredit206PreviewDetail'|'returnCredit206Issue'|'returnCredit206Detail'|'returnCredit206Register'|'returnCredit206OriginalCommand'|'returnCredit206Series'|'returnCredit206CreateSeries'>;
export async function registerReturnCredit206Routes(app:FastifyInstance,opts:{readOnly:boolean;sessionName:string;service?:ReturnCredit206RouteService}){
 const S=opts.service??await import('./return-credit206-service'),root='/api/consumer-return-credits';
 const actor=(r:any)=>S.returnCredit206RequestActor(r,opts.sessionName),id=(r:any)=>z.strictObject({id:V.creditUuid}).parse(r.params).id,empty=(v:unknown)=>z.strictObject({}).parse(v);
 const project=(v:any)=>({...v,read_only:opts.readOnly,can_preview:!opts.readOnly&&v.can_preview,can_issue:!opts.readOnly&&v.can_issue,...(v.preview?{preview:{...v.preview,can_issue:!opts.readOnly&&v.preview.can_issue}}:{})});
 app.addHook('onRequest',async(req,reply)=>{const path=req.url.split('?')[0].replace(/^\/api\/v1\//,'/api/');if(path!==root&&!path.startsWith(root+'/'))return;reply.header('Cache-Control','no-store');if(!['GET','HEAD','OPTIONS'].includes(req.method)){ensure(!opts.readOnly,423,'Kopia jest tylko do odczytu');ensure(await S.returnCredit206Available(),503,'Korekty zwrotów są niedostępne');}});
 const write=async(req:any,reply:any,work:()=>Promise<any>)=>{try{const value=await work();reply.code(value.reused?200:201);return project(value);}catch(error){const proof=S.returnCredit206FailedWrite(error);if(proof)return reply.code((error as{status?:number}).status??500).send({detail:(error as Error).message,...proof});throw error;}};
 app.get(root+'/options',async req=>{empty(req.query);return project(await S.returnCredit206Options(actor(req)));});
 app.get(root+'/orders/:id/strategy',async req=>{empty(req.query);return project(await S.returnCredit206Strategy(actor(req),id(req)));});
 app.get(root+'/orders/:id/source',async req=>{const q=z.strictObject({return_id:V.creditUuid.optional()}).parse(req.query);return project(await S.returnCredit206Source(actor(req),id(req),q.return_id));});
 app.get(root+'/series',async req=>{empty(req.query);return project(await S.returnCredit206Series(actor(req)));});
 app.post(root+'/series',async(req,reply)=>{empty(req.query);return write(req,reply,()=>S.returnCredit206CreateSeries(actor(req),V.returnCredit206SeriesInput.parse(req.body)));});
 app.post(root+'/previews',async(req,reply)=>{empty(req.query);return write(req,reply,()=>S.returnCredit206Preview(actor(req),V.returnCredit206PreviewInput.parse(req.body)));});
 app.get(root+'/previews/:id',async req=>{empty(req.query);return project(await S.returnCredit206PreviewDetail(actor(req),id(req)));});
 app.post(root+'/previews/:id/issue',async(req,reply)=>{empty(req.query);return write(req,reply,()=>S.returnCredit206Issue(actor(req),id(req),V.returnCredit206IssueInput.parse(req.body)));});
 app.get(root+'/commands/:id',async req=>{const q=z.strictObject({operation:z.enum(['preview','issue','series'])}).parse(req.query);return project(await S.returnCredit206OriginalCommand(actor(req),id(req),q.operation));});
 app.get(root+'/documents',async req=>project(await S.returnCredit206Register(actor(req),V.returnCredit206PageQuery.parse(req.query).cursor)));
 app.get(root+'/documents/:id',async req=>{empty(req.query);return project(await S.returnCredit206Detail(actor(req),id(req)));});
 app.get(root+'/documents/:id/print',async(req,reply)=>{empty(req.query);const value=await S.returnCredit206Detail(actor(req),id(req));return reply.type('text/html; charset=utf-8').header('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'").send(returnCredit206PrintHtml(value.document));});
}
