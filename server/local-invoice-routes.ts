import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {pool} from './db';
import {ensure} from './errors';
import {localInvoicesAvailable,localInvoiceRequestActor,localInvoiceOptions,listLocalInvoiceSeries,createLocalInvoiceSeries,previewLocalInvoice,issueLocalInvoice,localInvoicePreviewDetail,localInvoiceDetail,localInvoiceRegister} from './local-invoices';
import {localInvoiceSeriesInput,localInvoicePreviewInput,localInvoiceIssueInput,localInvoicePageQuery} from './local-invoice-values';
import {localInvoicePrintHtml} from './local-invoice-print';
export function registerLocalInvoiceRoutes(app:FastifyInstance,opts:{readOnly:boolean;sessionName:string}) {
 const root='/api/local-invoices',id=(p:unknown)=>z.strictObject({id:z.uuid().transform(v=>v.toLowerCase())}).parse(p).id,noQuery=(q:unknown)=>z.strictObject({}).parse(q);
 const actor=(r:any)=>localInvoiceRequestActor(r,opts.sessionName);
 const project=(v:any)=>({...v,read_only:opts.readOnly,...(typeof v.can_write==='boolean'?{can_write:!opts.readOnly&&v.can_write,can_create_series:!opts.readOnly&&v.can_create_series}:{}),...(v.preview?{preview:{...v.preview,can_issue:!opts.readOnly&&v.preview.can_issue}}:{})});
 app.addHook('onRequest',async(req,reply)=>{const path=req.url.split('?')[0].replace(/^\/api\/v1\//,'/api/');if(path!==root&&!path.startsWith(root+'/'))return;reply.header('Cache-Control','no-store');
  if(!['GET','HEAD','OPTIONS'].includes(req.method)){ensure(!opts.readOnly,423,'Kopia jest tylko do odczytu');ensure(await localInvoicesAvailable(pool),503,'Lokalne FV są niedostępne');}
 });
 app.get(root+'/options',async r=>{noQuery(r.query);return project(await localInvoiceOptions(actor(r)));});
 app.get(root+'/series',async r=>project(await listLocalInvoiceSeries(actor(r),r.query)));
 app.post(root+'/series',async(r,p)=>{noQuery(r.query);const v=await createLocalInvoiceSeries(actor(r),localInvoiceSeriesInput.parse(r.body));p.code(v.reused?200:201);return project(v);});
 app.post(root+'/orders/:id/previews',async(r,p)=>{noQuery(r.query);const v=await previewLocalInvoice(actor(r),id(r.params),localInvoicePreviewInput.parse(r.body));p.code(v.reused?200:201);return project(v);});
 app.get(root+'/previews/:id',async r=>{noQuery(r.query);return project(await localInvoicePreviewDetail(actor(r),id(r.params)));});
 app.post(root+'/previews/:id/issue',async(r,p)=>{noQuery(r.query);const v=await issueLocalInvoice(actor(r),id(r.params),localInvoiceIssueInput.parse(r.body));p.code(v.reused?200:201);return project(v);});
 app.get(root+'/documents',async r=>project(await localInvoiceRegister(actor(r),localInvoicePageQuery.parse(r.query))));
 app.get(root+'/documents/:id',async r=>{noQuery(r.query);return project(await localInvoiceDetail(actor(r),id(r.params)));});
 app.get(root+'/documents/:id/print',async(r,p)=>{noQuery(r.query);const v=await localInvoiceDetail(actor(r),id(r.params));return p.type('text/html; charset=utf-8').header('Cache-Control','no-store').send(localInvoicePrintHtml(v.document));});
}
