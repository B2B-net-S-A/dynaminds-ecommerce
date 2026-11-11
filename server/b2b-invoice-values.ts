/** Authored159 pure frozen representation. No source, numbering, provider or IAM lookup. */
import {z} from 'zod';
import {ensure} from './errors';
import {b2bFa3Date,b2bFa3DraftSchema,b2bFa3DraftHash,validateB2bFa3Draft,type B2bFa3Draft} from './fa3-draft-model';
import {localInvoiceSeriesInput} from './local-invoice-values';
const uuid=z.uuid().transform(s=>s.toLowerCase()),hash=z.string().regex(/^[a-f0-9]{64}$/);
export const b2bInvoicePreviewInput=z.strictObject({client_key:uuid,project_id:uuid,issue_date:b2bFa3Date,local_only:z.literal(true),confirmed_project_snapshot:z.literal(true)});
export const b2bInvoiceIssueInput=z.strictObject({client_key:uuid,scope_hash:hash,confirmed:z.literal(true),local_only:z.literal(true)});
export const b2bInvoicePageQuery=z.strictObject({limit:z.coerce.number().int().min(1).max(50).default(50),cursor:z.string().min(1).max(2048).optional()});
const snapshotSchema=z.strictObject({schema:z.literal('b2b-local-invoice/v1'),project_id:uuid,project_receipt_id:uuid,project_hash:hash,project_scope_hash:hash,
 fiscal_snapshot:b2bFa3DraftSchema,order_number:z.string().min(1).max(200),series_id:uuid,series_definition:localInvoiceSeriesInput.omit({client_key:true}),series_command_hash:hash,
 issue_date:b2bFa3Date,sale_date:b2bFa3Date,due_date:b2bFa3Date,payment_mode:z.enum(['prepaid','cod']),local_only:z.literal(true),ksef_state:z.literal('not_submitted'),fiscalized:z.literal(false)});
const issuedSchema=snapshotSchema.extend({number:z.string().regex(/^FV-B2B\/[A-Z0-9][A-Z0-9-]{0,11}\/(?:20[0-4][0-9]|2050)\/[0-9]{6}$/),year:z.number().int().min(2006).max(2050),sequence:z.number().int().min(1).max(999999),preview_id:uuid,scope_hash:hash});
export type B2bInvoiceSnapshot=z.infer<typeof snapshotSchema>;
export type B2bInvoiceData=z.infer<typeof issuedSchema>;
export type B2bInvoiceDocument={id:string;order_id:string;kind:'invoice';mode:'b2b_invoice';number:string;data:B2bInvoiceData;created_at:string};
export type B2bInvoicePreview={id:string;project_id:string;order_id:string;scope_hash:string;expires_at:string;snapshot:B2bInvoiceSnapshot;can_issue:boolean};
export type B2bInvoiceReceipt={id:string;document_id:string;preview_id:string;project_id:string;project_receipt_id:string;client_key:string;scope_hash:string;year:number;sequence:number;number:string;issued_at:string};
export function validateB2bInvoiceSnapshot(value:unknown):B2bInvoiceSnapshot{
 const s=snapshotSchema.parse(value);const d=validateB2bFa3Draft(s.fiscal_snapshot);
 ensure(s.project_hash===b2bFa3DraftHash(d)&&s.sale_date===d.sale_date&&s.issue_date>=s.sale_date&&d.lines.every(l=>l.rounding_gross_minor==='0'),409,'Niepełny albo nieobsługiwany zamrożony manifest FV');
 const seller=s.series_definition.seller;
 ensure(d.seller.name===seller.name&&d.seller.tax_id===seller.tax_id&&d.seller.address.country===seller.country&&d.seller.address.line1===seller.street&&d.seller.address.line2===seller.postal_code+' '+seller.city,409,'Sprzedawca nie odpowiada prawdziwej serii');
 const due=new Date(s.issue_date+'T12:00:00Z');due.setUTCDate(due.getUTCDate()+s.series_definition.payment_terms_days);
 ensure(due.toISOString().slice(0,10)===s.due_date,409,'Termin nie odpowiada rzeczywistym warunkom serii');return s;
}
export function validateB2bInvoiceData(value:unknown):B2bInvoiceData{
 const d=issuedSchema.parse(value);const {number,year,sequence,preview_id,scope_hash,...s}=d;validateB2bInvoiceSnapshot(s);
 ensure(year===Number(s.issue_date.slice(0,4))&&number===`FV-B2B/${s.series_definition.prefix}/${year}/${String(sequence).padStart(6,'0')}`,409,'Numer nie odpowiada natywnej serii/rokowi');return d;
}
export function validateB2bInvoiceDocument(d:B2bInvoiceDocument){
 ensure(d.kind==='invoice'&&d.mode==='b2b_invoice'&&uuid.safeParse(d.id).success&&uuid.safeParse(d.order_id).success,409,'Niepoprawne pochodzenie FV');
 const s=validateB2bInvoiceData(d.data);ensure(d.number===s.number&&d.order_id===s.fiscal_snapshot.source.order_id,409,'Niezgodny dokument i snapshot');return d;
}
export function b2bInvoiceVatBuckets(d:B2bFa3Draft){
 const buckets=new Map<string,{net:bigint;vat:bigint;gross:bigint}>();for(const r of validateB2bFa3Draft(d).lines){const b=buckets.get(r.vat_code)??{net:0n,vat:0n,gross:0n};b.net+=BigInt(r.net_minor);b.vat+=BigInt(r.vat_minor);b.gross+=BigInt(r.gross_minor);buckets.set(r.vat_code,b);}
 return [...buckets].sort(([a],[b])=>(a==='0 KR'?0:Number(a))-(b==='0 KR'?0:Number(b))).map(([vat_code,b])=>({vat_code,net_minor:b.net.toString(),vat_minor:b.vat.toString(),gross_minor:b.gross.toString()}));
}
