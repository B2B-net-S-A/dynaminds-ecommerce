import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {ensure} from './errors';
import {fa3DraftOptions,fa3DraftOrderSource,fa3DraftPreview,fa3DraftApprove,fa3DraftPreviewDetail,fa3DraftProjectDetail,fa3DraftProjects,
 fa3DraftPreviewInput,fa3DraftApproveInput,fa3DraftPageQuery,fa3DraftRequestActor,fa3DraftModuleAvailable} from './fa3-drafts';
export function registerFa3DraftRoutes(app:FastifyInstance,opts:{readOnly:boolean;sessionName:string}){
 const root='/api/b2b-fa3',id=(p:unknown)=>z.strictObject({id:z.uuid().transform(v=>v.toLowerCase())}).parse(p).id;
 const noQuery=(q:unknown)=>z.strictObject({}).parse(q),actor=(r:any)=>fa3DraftRequestActor(r,opts.sessionName);
 app.addHook('onRequest',async(req,reply)=>{const path=req.url.split('?')[0].replace(/^\/api\/v1\//,'/api/');if(path!==root&&!path.startsWith(root+'/'))return;
  reply.header('Cache-Control','no-store');if(!['GET','HEAD','OPTIONS'].includes(req.method)){
   ensure(!opts.readOnly,423,'Kopia tylko do odczytu');ensure(await fa3DraftModuleAvailable(),503,'Zatwierdzanie projektu B2B niedostępne');
  }
 });
 app.get(root+'/options',async r=>{noQuery(r.query);const v=await fa3DraftOptions(actor(r));return{...v,read_only:opts.readOnly,can_prepare:!opts.readOnly&&v.can_prepare,can_approve:!opts.readOnly&&v.can_approve};});
 app.get(root+'/orders/:id/source',async r=>{noQuery(r.query);return fa3DraftOrderSource(actor(r),id(r.params));});
 app.post(root+'/orders/:id/previews',async(r,p)=>{noQuery(r.query);const v=await fa3DraftPreview(actor(r),id(r.params),fa3DraftPreviewInput.parse(r.body));p.code(v.reused?200:201);return v.preview;});
 app.get(root+'/previews/:id',async r=>{noQuery(r.query);const v=await fa3DraftPreviewDetail(actor(r),id(r.params));return{...v.preview,can_approve:!opts.readOnly&&v.preview.can_approve};});
 app.post(root+'/previews/:id/approve',async(r,p)=>{noQuery(r.query);const v=await fa3DraftApprove(actor(r),id(r.params),fa3DraftApproveInput.parse(r.body));p.code(v.reused?200:201);return v;});
 app.get(root+'/projects',async r=>fa3DraftProjects(actor(r),fa3DraftPageQuery.parse(r.query)));
 app.get(root+'/projects/:id',async r=>{noQuery(r.query);return fa3DraftProjectDetail(actor(r),id(r.params));});
}
