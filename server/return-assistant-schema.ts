import { z } from 'zod';
import type { Actor } from './domain';
import { returnWmsLots } from './wms-lots-workflow-schema';
export type ReturnAssistantActor = Actor & { apiKeyId?: string };
export const RETURN_ASSISTANT_LIMITS = { sessions:2000,previews:2000,receipts:2000,operations:10000,photos_per_session:10,photo_bytes:1048576,snapshot_bytes:4194304,retained_bytes:67108864,parts:200,lines:100,lease_seconds:900,preview_seconds:900,page:50 } as const;
export const assistantUuid=z.uuid().transform(v=>v.toLowerCase());
export const assistantVersion=z.string().regex(/^[1-9][0-9]{0,18}$/).refine(v=>/^[1-9][0-9]{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n,'Nieprawidłowa wersja');
const text=(v:string)=>!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\p{Cs}]/u.test(v);
const codeText=(v:string)=>text(v)&&!/[\r\n\t]/.test(v);
const client={client_key:assistantUuid};const lease={...client,version:assistantVersion,lease_token:assistantUuid};
export const returnAssistantStartInput=z.strictObject({...client,return_number:z.string().trim().min(1).max(80).refine(codeText,'Nieprawidłowy numer RMA'),station_id:assistantUuid,station_version:assistantVersion,lease_token:assistantUuid});
export const returnAssistantScanInput=z.strictObject({...lease,code:z.string().trim().min(1).max(200).refine(codeText,'Nieprawidłowy kod'),item_id:assistantUuid.optional()});
export const returnAssistantPart=z.strictObject({part_id:assistantUuid,item_id:assistantUuid,status:z.enum(['sale','hold','reject']),quantity:z.number().int().min(1).max(100000)});
export const returnAssistantDraftInput=z.strictObject({...lease,parts:z.array(returnAssistantPart).max(200),note:z.string().trim().min(3).max(2000).refine(text,'Nieprawidłowa notatka'),shipping_refund:z.number().int().min(0).max(1000000),origin_id:assistantUuid.optional(),wms_lots:returnWmsLots.optional()}).refine(v=>new Set(v.parts.map(p=>p.part_id)).size===v.parts.length,'Powtórzona część');
export const returnAssistantLeaseInput=z.strictObject(lease);
export const returnAssistantPreviewInput=returnAssistantLeaseInput;
export const returnAssistantPhotoInput=z.strictObject({...lease,item_id:assistantUuid,part_id:assistantUuid.optional(),mime:z.enum(['image/png','image/jpeg']),content_base64:z.string().min(4).max(Math.ceil(1048576/3)*4)});
export const returnAssistantReceiveInput=z.strictObject({...client,scope_hash:z.string().regex(/^[a-f0-9]{64}$/),confirmed:z.literal(true),lease_token:assistantUuid});
export const returnAssistantHistoryInput=z.strictObject({return_id:assistantUuid,cursor:assistantUuid.optional(),limit:z.coerce.number().int().min(1).max(50).default(50)});
export type ReturnAssistantPart=z.infer<typeof returnAssistantPart>;
/** Pure commercial conservation: no single-unit expansion, no component barcode inference. */
export function deriveReturnAssistantDecision(lines:{item_id:string;requested:number}[],scanned:{item_id:string;quantity:number}[],parts:ReturnAssistantPart[],complete=true){
 const known=new Map(lines.map(l=>[l.item_id,l.requested]));const inspected=new Map(scanned.map(s=>[s.item_id,s.quantity]));
 if(known.size!==lines.length||!known.size||new Set(parts.map(p=>p.part_id)).size!==parts.length||parts.length>200)throw new Error('Nieprawidłowe pozycje kontroli');
 const totals=new Map<string,{total:number;accepted:number;restocked:number}>();
 for(const p of parts){if(!known.has(p.item_id)||!Number.isSafeInteger(p.quantity)||p.quantity<1||!['sale','hold','reject'].includes(p.status))throw new Error('Obca lub nieprawidłowa część kontroli');const s=totals.get(p.item_id)??{total:0,accepted:0,restocked:0};s.total+=p.quantity;if(p.status!=='reject')s.accepted+=p.quantity;if(p.status==='sale')s.restocked+=p.quantity;totals.set(p.item_id,s);}
 return [...known].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([item_id,requested])=>{const t=totals.get(item_id)??{total:0,accepted:0,restocked:0};if(t.total>requested||(complete&&t.total!==requested)||t.accepted>(inspected.get(item_id)??0))throw new Error('Ilości wymagają pełnej zgodnej kontroli');return {item_id,accepted:t.accepted,restocked:t.restocked};});
}
