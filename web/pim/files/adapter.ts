/** Intended file lane uses the SAME RAM attempt registry and native preview paths as the sheet. */
import {PimBatchController} from '../batch/controller';
import type {PimContext,PimTransport} from '../editor';
import {prepareTypedRows,validatePlan,type FilePlan,type Prepared} from './model';
export class PimTypedFileSession{
 readonly controller:PimBatchController;private readonly plan:FilePlan;
 constructor(context:PimContext,catalogId:string,plan:FilePlan,transport:PimTransport){this.plan=validatePlan(plan,catalogId);this.controller=new PimBatchController(context,catalogId,this.plan.rows.map(r=>r.product_id),transport);}
 configure(blocked:boolean,onChanged?:()=>void){this.controller.configure(blocked,onChanged);}
 async load():Promise<Prepared>{await this.controller.load();return this.review();}
 review():Prepared{const v=this.controller.snapshot();if(!v.dictionary||v.sources.length!==this.plan.rows.length)return{ready:false,rows:[],errors:[{row:0,field:'source',code:'read_required',definition_id:null}]};return prepareTypedRows(v.dictionary,v.sources,this.plan);}
 /** Stages full replacement in memory only. Explicit preview() remains a separate user action. */
 stage(){const r=this.review();if(!r.ready)return r;this.controller.replaceRows(r.rows);return r;}
 preview(){return this.controller.preview();}
 consent(confirmed:boolean){this.controller.consent(confirmed);}
 apply(){return this.controller.apply();}
 retry(){return this.controller.retry();}
 destroy(){this.controller.destroy();}
}
