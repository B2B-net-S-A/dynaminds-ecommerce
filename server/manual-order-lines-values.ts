import { z } from 'zod';
import { ensure } from './errors';

export const manualOrderLines = z.array(z.strictObject({
 product_id:z.uuid().transform(v=>v.toLowerCase()),
 quantity:z.number().int().min(1).max(100000),
 line_total:z.number().int().min(0).max(2147483647),
})).min(1).max(100);
export type ManualOrderLine=z.infer<typeof manualOrderLines>[number];
type Input={source:string;price_list_id?:string;items:{product_id:string;quantity:number}[];manual_lines?:ManualOrderLine[]};
/** Distinct commercial lines are explicit; physical custody remains their exact aggregate. */
export function manualOrderLinesIssue(input:Input):string|null{
 if(input.manual_lines===undefined)return null;
 if(!['manual','demo'].includes(input.source))return 'Ręczne pozycje wymagają lokalnego źródła zamówienia';
 if(input.price_list_id!==undefined)return 'Ręcznych kwot pozycji nie można łączyć z cennikiem';
 const requested=new Map<string,number>(),actual=new Map<string,number>();
 for(const i of input.items){const id=i.product_id.toLowerCase();requested.set(id,(requested.get(id)??0)+i.quantity);}
 for(const i of input.manual_lines){const id=i.product_id.toLowerCase();actual.set(id,(actual.get(id)??0)+i.quantity);}
 if(requested.size!==actual.size||[...requested].some(([id,q])=>actual.get(id)!==q))return 'Ręczne pozycje nie pokrywają dokładnych ilości zamówienia';
 if([...actual.values()].some(q=>!Number.isSafeInteger(q)||q<1||q>100000))return 'Za duża ilość produktu';
 return null;
}
export function prepareManualOrderLines(input:Input,internal:{sourceTotals?:unknown;importFragments?:unknown;replacementAdmissionId?:unknown;externalIntentLines?:unknown;externalImportIntentLines?:unknown;mappedInitial?:unknown}={}){
 if(input.manual_lines===undefined)return null;
 ensure(!Object.values(internal).some(v=>v!==undefined),422,'Ręczne pozycje nie łączą się z importem, wymianą ani intencją zewnętrzną');
 const lines=manualOrderLines.parse(input.manual_lines);const issue=manualOrderLinesIssue({...input,manual_lines:lines});ensure(!issue,422,issue??'Niepoprawne ręczne pozycje');
 const totals=new Map<string,number>();for(const l of lines)totals.set(l.product_id,(totals.get(l.product_id)??0)+l.line_total);
 ensure([...totals.values()].every(v=>Number.isSafeInteger(v)&&v<=2147483647),422,'Wartość pozycji przekracza limit');
 return {lines,totals};
}
