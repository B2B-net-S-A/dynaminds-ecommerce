import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {registerNativeB2bInvoiceFa3Routes} from './fa3-xml-routes';
import {ensure} from './errors';
import {b2bInvoiceOptions,b2bInvoicePreview,b2bInvoicePreviewDetail,b2bInvoiceIssue,b2bInvoiceDetail,b2bInvoicePrint,b2bInvoiceRegister,b2bInvoiceModuleAvailable,b2bInvoiceRequestActor,b2bInvoicePreviewInput,b2bInvoiceIssueInput,b2bInvoicePageQuery} from './b2b-invoices';
export function registerB2bInvoiceRoutes(app:FastifyInstance,opts:{readOnly:boolean;sessionName:string}){
 const root='/api/b2b-invoices',id=(p:unknown)=>z.strictObject({id:z.uuid().transform(s=>s.toLowerCase())}).parse(p).id,noQuery=(q:unknown)=>z.strictObject({}).parse(q),actor=(r:any)=>b2bInvoiceRequestActor(r,opts.sessionName);
 app.addHook('onRequest',async(r,p)=>{const path=r.url.split('?')[0].replace(/^\/api\/v1\//,'/api/');if(path!==root&&!path.startsWith(root+'/'))return;p.header('Cache-Control','no-store');if(!['GET','HEAD','OPTIONS'].includes(r.method)){
  ensure(!opts.readOnly,423,'Kopia tylko do odczytu');ensure(await b2bInvoiceModuleAvailable(),503,'WystawienieFV niedostępne');
 }});
 app.get(root+'/options',async r=>{noQuery(r.query);const v=await b2bInvoiceOptions(actor(r));return{...v,read_only:opts.readOnly,can_preview:!opts.readOnly&&v.can_preview,can_issue:!opts.readOnly&&v.can_issue};});
 app.post(root+'/projects/:id/previews',async(r,p)=>{noQuery(r.query);const v=await b2bInvoicePreview(actor(r),id(r.params),b2bInvoicePreviewInput.parse(r.body));p.code(v.reused?200:201);return v.preview;});
 app.get(root+'/previews/:id',async r=>{noQuery(r.query);const v=await b2bInvoicePreviewDetail(actor(r),id(r.params));return{...v.preview,can_issue:!opts.readOnly&&v.preview.can_issue};});
 app.post(root+'/previews/:id/issue',async(r,p)=>{noQuery(r.query);const v=await b2bInvoiceIssue(actor(r),id(r.params),b2bInvoiceIssueInput.parse(r.body));p.code(v.reused?200:201);return v;});
 app.get(root+'/documents',async r=>b2bInvoiceRegister(actor(r),b2bInvoicePageQuery.parse(r.query)));
 app.get(root+'/documents/:id',async r=>{noQuery(r.query);return b2bInvoiceDetail(actor(r),id(r.params));});
 app.get(root+'/documents/:id/print',async(r,p)=>{noQuery(r.query);const html=await b2bInvoicePrint(actor(r),id(r.params));return p.type('text/html; charset=utf-8').header('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'self'").send(html);});
 registerNativeB2bInvoiceFa3Routes(app,{sessionName:opts.sessionName});
}
