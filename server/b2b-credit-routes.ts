import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {ensure} from './errors';
import {b2bCreditOptions,b2bCreditSource,b2bCreditPreview,b2bCreditPreviewDetail,b2bCreditIssue,b2bCreditDetail,b2bCreditPrint,b2bCreditRegister,b2bCreditModuleAvailable,b2bCreditRequestActor,b2bCreditPreviewInput,b2bCreditIssueInput,b2bCreditPageQuery} from './b2b-credits';
export function registerB2bCreditRoutes(app:FastifyInstance,opts:{readOnly:boolean;sessionName:string}){
 const root='/api/b2b-corrections',id=(p:unknown)=>z.strictObject({id:z.uuid().transform(s=>s.toLowerCase())}).parse(p).id,noQuery=(q:unknown)=>z.strictObject({}).parse(q),actor=(r:any)=>b2bCreditRequestActor(r,opts.sessionName);
 app.addHook('onRequest',async(r,p)=>{const path=r.url.split('?')[0].replace(/^\/api\/v1\//,'/api/');if(path!==root&&!path.startsWith(root+'/'))return;p.header('Cache-Control','no-store');if(!['GET','HEAD','OPTIONS'].includes(r.method)){
  ensure(!opts.readOnly,423,'Kopia tylko do odczytu');ensure(await b2bCreditModuleAvailable(),503,'WystawienieFV niedostępne');
 }});
 app.get(root+'/options',async r=>{noQuery(r.query);const v=await b2bCreditOptions(actor(r));return{...v,read_only:opts.readOnly,can_preview:!opts.readOnly&&v.can_preview,can_issue:!opts.readOnly&&v.can_issue};});
 app.get(root+'/documents/:id/source',async r=>{noQuery(r.query);return b2bCreditSource(actor(r),id(r.params));});
 app.post(root+'/previews',async(r,p)=>{noQuery(r.query);const v=await b2bCreditPreview(actor(r),b2bCreditPreviewInput.parse(r.body));p.code(v.reused?200:201);return v.preview;});
 app.get(root+'/previews/:id',async r=>{noQuery(r.query);const v=await b2bCreditPreviewDetail(actor(r),id(r.params));return{...v.preview,can_issue:!opts.readOnly&&v.preview.can_issue};});
 app.post(root+'/previews/:id/issue',async(r,p)=>{noQuery(r.query);const v=await b2bCreditIssue(actor(r),id(r.params),b2bCreditIssueInput.parse(r.body));p.code(v.reused?200:201);return v;});
 app.get(root+'/documents',async r=>b2bCreditRegister(actor(r),b2bCreditPageQuery.parse(r.query)));
 app.get(root+'/documents/:id',async r=>{noQuery(r.query);return b2bCreditDetail(actor(r),id(r.params));});
 app.get(root+'/documents/:id/print',async(r,p)=>{noQuery(r.query);const html=await b2bCreditPrint(actor(r),id(r.params));return p.type('text/html; charset=utf-8').header('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'self'").send(html);});
}
