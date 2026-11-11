/** Explicit irreversible import completion. No IO or authority on import. */
import {z} from 'zod';
import {ensure} from '../errors';
import type {Job} from '../../shared/large-import-dependencies/pim-large-import-job-coordinator-backend5/coordinator';
export const importFinalizationInput=z.strictObject({revision:z.number().int().min(0),plan_hash:z.string().regex(/^[a-f0-9]{64}$/),pim_batches:z.array(z.number().int().min(0).max(99999)).max(100000),confirmed:z.literal(true)});
export type ImportFinalizationInput=z.infer<typeof importFinalizationInput>;
export type ImportFinalizationAck={schema:'large-import-finalized/v1';id:string;revision:number;plan_hash:string;finalized:true};
/** Desired PIM batches are explicit; existing incomplete/uncertain attempts can never be skipped. */
export function assertFinalizableImport(job:Job,input:ImportFinalizationInput){
 const expected=importFinalizationInput.parse(input);
 ensure(job.revision===expected.revision&&job.plan_hash===expected.plan_hash,409,'Zadanie zmieniło się. Odczytaj je przed zakończeniem');
 ensure(job.approved&&job.core.length>0&&job.core.every(c=>c.execution?.ack.head.state==='done'),409,'Najpierw zakończ wszystkie partie Core');
 ensure(new Set(expected.pim_batches).size===expected.pim_batches.length,422,'Powtórzona partia PIM');
 const requested=new Set(expected.pim_batches);
 for(const n of requested)ensure(n<job.core.length,422,'Inna partia PIM');
 for(const [key,list]of Object.entries(job.pim)){
  const n=Number(key);ensure(Number.isSafeInteger(n)&&String(n)===key&&n>=0&&n<job.core.length&&list.length>0,409,'Nieprawidłowa historia PIM');
  ensure(requested.has(n),409,'Uwzględnij każdą rozpoczętą partię PIM');
  ensure(list.every(a=>(!a.previewAttempted||!!a.preview)&&(!a.applyAttempted||!!a.applied)),409,'Najpierw rozstrzygnij wcześniejszą próbę PIM');
  const last=list.at(-1)!;ensure(last.applied&&last.applyAttempted&&last.preview&&last.consent===last.preview.scope_hash&&last.applied.scope_hash===last.preview.scope_hash,409,'Najpierw zakończ wybrane partie PIM');
 }
 for(const n of requested)ensure(job.pim[n]?.at(-1)?.applied,409,'Brak zakończonej wybranej partii PIM');
 return {schema:'large-import-finalized/v1',id:job.id,revision:job.revision,plan_hash:job.plan_hash,finalized:true} as const;
}
