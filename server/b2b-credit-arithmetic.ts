/** NEW WIP162 compatible schema successor / NOT_RUN. Pure arithmetic only: no DB, identity, source
 * authentication, numbering, payment, provider, XML or issuance capability. */
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {b2bFa3Date,b2bFa3DraftSchema,b2bFa3DraftHash,validateB2bFa3Draft,type B2bFa3Draft} from './fa3-draft-model';
import {localInvoiceSeriesInput} from './local-invoice-values';
const MAX=9223372036854775807n;
export const B2B_CORRECTION_LIMITS={acceptances:1000,input_bytes:33554432,output_bytes:1048576} as const;
const uuid=z.uuid().transform(s=>s.toLowerCase()),hash=z.string().regex(/^[a-f0-9]{64}$/);
const amount=z.string().max(19).regex(/^(0|[1-9][0-9]*)$/).refine(s=>/^(0|[1-9][0-9]*)$/.test(s)&&s.length<=19&&BigInt(s)<=MAX);
const timestamp=z.string().regex(/^\d{4}-\d{2}-\d{2}T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]{1,6})?(?:Z|\+00:00)$/).refine(s=>{const d=new Date(s.slice(0,10)+'T12:00:00Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===s.slice(0,10);});
const series=localInvoiceSeriesInput.omit({client_key:true});
const dataSchema=z.strictObject({schema:z.literal('b2b-local-invoice/v1'),project_id:uuid,project_receipt_id:uuid,project_hash:hash,project_scope_hash:hash,
 fiscal_snapshot:b2bFa3DraftSchema,order_number:z.string().min(1).max(200),series_id:uuid,series_definition:series,series_command_hash:hash,
 issue_date:b2bFa3Date,sale_date:b2bFa3Date,due_date:b2bFa3Date,payment_mode:z.enum(['prepaid','cod']),local_only:z.literal(true),ksef_state:z.literal('not_submitted'),fiscalized:z.literal(false),
 number:z.string().min(1).max(100),year:z.number().int().min(2006).max(2050),sequence:z.number().int().min(1).max(999999),preview_id:uuid,scope_hash:hash});
const originalSchema=z.strictObject({document:z.strictObject({id:uuid,order_id:uuid,kind:z.literal('invoice'),mode:z.literal('b2b_invoice'),number:z.string().min(1).max(100),data:dataSchema,created_at:timestamp}),
 receipt:z.strictObject({id:uuid,document_id:uuid,preview_id:uuid,project_id:uuid,project_receipt_id:uuid,client_key:uuid,scope_hash:hash,year:z.number().int(),sequence:z.number().int(),number:z.string().min(1).max(100),issued_at:timestamp})});
/** Immutable received financial projection, not the later mutable RMA head.
 * Actual private169 receipt/admission authentication is REQUIRED in the caller. */
export const b2bNativeReturnFinancialSchema=z.strictObject({tenant_id:uuid,order_id:uuid,return_id:uuid,number:z.string().min(1).max(200),receipt_sequence:z.number().int().min(1).max(2147483647),
 kind:z.enum(['return','complaint']),received_state:z.literal('refund_pending'),remedy:z.literal('refund'),legacy:z.boolean(),acceptance_kind:z.enum(['physical','financial_no_restock']),received_at:timestamp,
 refund_amount_minor:amount,refunded_shipping_minor:amount,items:z.array(z.strictObject({item_id:uuid,accepted:amount,restocked:amount,refund_amount_minor:amount})).min(1).max(100),
 native_proof:z.strictObject({kind:z.enum(['catalog_stock_return169','financial_return162']),receipt_id:uuid,admission_id:uuid,receipt_snapshot_hash:hash,financial_hash:hash})}).superRefine((a,c)=>{
 if((a.acceptance_kind==='physical')!==(a.native_proof.kind==='catalog_stock_return169'))
  c.addIssue({code:'custom',message:'Acceptance/proof parent discriminator differs'});
 if(a.acceptance_kind==='financial_no_restock'&&(a.items.some(i=>i.restocked!=='0')||!a.items.some(i=>BigInt(i.accepted)>0n)))
  c.addIssue({code:'custom',message:'Financial-only receipt needs positive accepted and zero restocked'});
});
export type B2bNativeReturnFinancial=z.infer<typeof b2bNativeReturnFinancialSchema>;
export type B2bCorrectionOriginal=z.infer<typeof originalSchema>;
export type CorrectionAmounts={quantity:string;gross_minor:string;net_minor:string;vat_minor:string};
export type CorrectionMoney=Omit<CorrectionAmounts,'quantity'>;
export type B2bCorrectionRow={ordinal:number;line_id:string;source_item_id:string|null;kind:'item'|'shipping';name:string;unit:string;vat_code:'0 KR'|'5'|'8'|'23';zero_domestic_basis:string|null;
 affected:boolean;before:CorrectionAmounts;after:CorrectionAmounts;delta:CorrectionAmounts};
export type B2bCorrectionCalculation={schema:'b2b-invoice-correction-calculation/v1';state:'unnumbered_calculation';currency:'PLN';tax_method:'gross_line_half_up';shipping_credit_scope:'native_refunded_shipping_value_only';
 original:{document_id:string;receipt_id:string;number:string;scope_hash:string;fiscal_snapshot_hash:string;issued_basis_hash:string};
 acceptance:{return_id:string;number:string;receipt_sequence:number;receipt_id:string;admission_id:string;receipt_snapshot_hash:string;financial_hash:string;received_at:string};
 fiscal_snapshot:B2bFa3Draft;previous_chain_hash:string;rows:B2bCorrectionRow[];totals:{before:CorrectionMoney;after:CorrectionMoney;delta:CorrectionMoney};
 vat_buckets:{vat_code:B2bCorrectionRow['vat_code'];before:CorrectionMoney;after:CorrectionMoney;delta:CorrectionMoney}[]};
export type B2bPreviousCredit={document_id:string;receipt_id:string;original_document_id:string;original_receipt_id:string;return_id:string;return_receipt_id:string;receipt_sequence:number;
 calculation:B2bCorrectionCalculation;calculation_hash:string};
const previousSchema=z.strictObject({document_id:uuid,receipt_id:uuid,original_document_id:uuid,original_receipt_id:uuid,return_id:uuid,return_receipt_id:uuid,
 receipt_sequence:z.number().int().min(1).max(2147483647),calculation:z.unknown(),calculation_hash:hash});
const inputSchema=z.strictObject({original:originalSchema,acceptance_manifest:z.strictObject({count:z.number().int().min(1).max(B2B_CORRECTION_LIMITS.acceptances),financial_history_hash:hash}),
 acceptances:z.array(b2bNativeReturnFinancialSchema).min(1).max(B2B_CORRECTION_LIMITS.acceptances),previous_credits:z.array(previousSchema).max(B2B_CORRECTION_LIMITS.acceptances),selected_return_id:uuid,
 shipping_credit_scope:z.literal('native_refunded_shipping_value_only')});
export type B2bCorrectionInput=Omit<z.infer<typeof inputSchema>,'previous_credits'>&{previous_credits:B2bPreviousCredit[]};
export class B2bCorrectionError extends Error{constructor(public readonly code:'INVALID_INPUT'|'SOURCE_MISMATCH'|'INCOMPLETE_HISTORY'|'CREDIT_CHAIN_MISMATCH'|'BYTES_EXCEEDED',message:string){super(message);this.name='B2bCorrectionError';}}
function check(ok:unknown,code:B2bCorrectionError['code'],message:string):asserts ok{if(!ok)throw new B2bCorrectionError(code,message);}
function canonical(x:unknown):unknown{return Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>[k,canonical(v)])):x;}
/** Consistency checksum only. A public hash is NEVER a native authority proof. */
export function b2bCorrectionHash(value:unknown){return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');}
function bounded(x:unknown,limit:number){let text:string;try{text=JSON.stringify(x);}catch{throw new B2bCorrectionError('INVALID_INPUT','Wejście nie jest pełnym JSON');}check(typeof text==='string'&&Buffer.byteLength(text,'utf8')<=limit,'BYTES_EXCEEDED','Pełny manifest przekracza budżet; nie wolno obcinać');}
function signed(n:bigint){check(n>=-MAX&&n<=MAX,'SOURCE_MISMATCH','Kwota/ilość poza int64');return n.toString();}
function money(gross:bigint,rate:bigint):CorrectionMoney{check(gross>=0n,'SOURCE_MISMATCH','Ujemny pozostały stan FV');const d=100n+rate,vat=(2n*gross*rate+d)/(2n*d);return {gross_minor:signed(gross),net_minor:signed(gross-vat),vat_minor:signed(vat)};}
function minus(a:CorrectionMoney,b:CorrectionMoney):CorrectionMoney{return {gross_minor:signed(BigInt(a.gross_minor)-BigInt(b.gross_minor)),net_minor:signed(BigInt(a.net_minor)-BigInt(b.net_minor)),vat_minor:signed(BigInt(a.vat_minor)-BigInt(b.vat_minor))};}
function sum(rows:CorrectionMoney[]):CorrectionMoney{const n=rows.reduce((a,r)=>({gross:a.gross+BigInt(r.gross_minor),net:a.net+BigInt(r.net_minor),vat:a.vat+BigInt(r.vat_minor)}),{gross:0n,net:0n,vat:0n});return {gross_minor:signed(n.gross),net_minor:signed(n.net),vat_minor:signed(n.vat)};}
function validateOriginal(o:B2bCorrectionOriginal){
 const d=o.document.data,r=o.receipt,s=d.series_definition.seller;let f:B2bFa3Draft;try{f=validateB2bFa3Draft(d.fiscal_snapshot);}catch{throw new B2bCorrectionError('SOURCE_MISMATCH','Niepełne kwoty/VAT/tożsamości oryginalnego manifestu');}
 check(d.project_hash===b2bFa3DraftHash(f)&&d.sale_date===f.sale_date&&d.issue_date>=d.sale_date&&f.lines.every(l=>l.rounding_gross_minor==='0'),'SOURCE_MISMATCH','Nieobsługiwany oryginalny snapshot159');
 check(f.seller.name===s.name&&f.seller.tax_id===s.tax_id&&f.seller.address.country===s.country&&f.seller.address.line1===s.street&&f.seller.address.line2===s.postal_code+' '+s.city,'SOURCE_MISMATCH','Sprzedawca nie odpowiada oryginalnej serii');
 const due=new Date(d.issue_date+'T12:00:00Z');due.setUTCDate(due.getUTCDate()+d.series_definition.payment_terms_days);
 check(d.due_date===due.toISOString().slice(0,10)&&d.year===Number(d.issue_date.slice(0,4))&&d.number===`FV-B2B/${d.series_definition.prefix}/${d.year}/${String(d.sequence).padStart(6,'0')}`,'SOURCE_MISMATCH','Niezgodny numer/termin oryginalnej FV');
 check(o.document.order_id===f.source.order_id&&o.document.number===d.number&&r.document_id===o.document.id&&r.preview_id===d.preview_id&&r.project_id===d.project_id&&r.project_receipt_id===d.project_receipt_id&&r.scope_hash===d.scope_hash&&r.number===d.number&&r.year===d.year&&r.sequence===d.sequence,'SOURCE_MISMATCH','Niepełne połączenie FV i consumption receipt159');
 return f;
}
/** Returns one complete calculation for the earliest genuinely uncredited
 * physical refund acceptance. All previous calculations are recomputed. Caller
 * MUST authenticate full native history/credit receipts under actual locks. */
export function calculateB2bInvoiceCorrection(value:unknown):{calculation:B2bCorrectionCalculation;calculation_hash:string;scope_hash:string}{
 bounded(value,B2B_CORRECTION_LIMITS.input_bytes);const parsed=inputSchema.safeParse(value);check(parsed.success,'INVALID_INPUT','Niepełny lub nieobsługiwany protokół korekty');const x=parsed.data;
 const fiscal=validateOriginal(x.original),original=x.original.document,receipt=x.original.receipt;
 check(x.acceptance_manifest.count===x.acceptances.length&&x.acceptance_manifest.financial_history_hash===b2bCorrectionHash(x.acceptances),'INCOMPLETE_HISTORY','Niepełny manifest wszystkich przyjęć');
 const selected=x.previous_credits.length;check(selected<x.acceptances.length&&x.acceptances[selected].return_id===x.selected_return_id,'INCOMPLETE_HISTORY','Wybierz najwcześniejsze nieskorygowane przyjęcie');
 const lineByItem=new Map(fiscal.lines.filter(l=>l.kind==='item').map(l=>[l.source_item_id!,l]));
 const accepted=new Map<string,bigint>();let shipping=0n,chain=b2bCorrectionHash({original_document_id:original.id,original_receipt_id:receipt.id});
 const unique=new Set<string>(),creditIds=new Set<string>();let result:B2bCorrectionCalculation|undefined;
 for(const [i,a]of x.acceptances.entries()){
  check(a.receipt_sequence===i+1&&!unique.has(a.return_id)&&!unique.has(a.native_proof.receipt_id)&&a.native_proof.receipt_id===a.native_proof.admission_id,'INCOMPLETE_HISTORY','Powtórzone/brakujące przyjęcie lub admission');unique.add(a.return_id);unique.add(a.native_proof.receipt_id);
  check(a.tenant_id===fiscal.source.tenant_id&&a.order_id===original.order_id&&a.received_at.slice(0,10)>=original.data.issue_date,'SOURCE_MISMATCH','Obcy lub wcześniejszy niż FV zwrot');
  const {native_proof,...financial}=a;check(native_proof.financial_hash===b2bCorrectionHash(financial),'SOURCE_MISMATCH','Niezgodny zamrożony financial projection169');
  const beforeAccepted=new Map(accepted),beforeShipping=shipping,itemIds=new Set<string>();let refund=0n,units=0n;
  for(const it of a.items){const l=lineByItem.get(it.item_id);check(l&&!itemIds.has(it.item_id),'SOURCE_MISMATCH','Obca/powtórzona pozycja komercyjna');itemIds.add(it.item_id);
   const q=BigInt(l.quantity),n=BigInt(it.accepted),prior=accepted.get(it.item_id)??0n;
   check(n<=100000n&&BigInt(it.restocked)<=n&&prior+n<=q,'SOURCE_MISMATCH','Przyjęcie przekracza oryginalną ilość');
   const gross=BigInt(l.gross_minor),expected=gross*(prior+n)/q-gross*prior/q;
   check(BigInt(it.refund_amount_minor)===expected,'SOURCE_MISMATCH','Kwota zwrotu nie odpowiada natywnej alokacji narastającej');accepted.set(it.item_id,prior+n);refund+=expected;units+=n;
  }
  shipping+=BigInt(a.refunded_shipping_minor);refund+=BigInt(a.refunded_shipping_minor);
  check(units>0n&&shipping<=BigInt(fiscal.source.shipping_gross_minor)&&refund===BigInt(a.refund_amount_minor),'SOURCE_MISMATCH','Niezgodny refund/dostawa lub brak przyjętych sztuk');
  if(i>selected)continue; // Still validate the FULL later native history above.
  const rows:B2bCorrectionRow[]=fiscal.lines.map(l=>{
   const q=BigInt(l.quantity),g=BigInt(l.gross_minor),rate=l.vat_code==='0 KR'?0n:BigInt(l.vat_code);
   const prior=l.kind==='shipping'?beforeShipping:(beforeAccepted.get(l.source_item_id!)??0n),current=l.kind==='shipping'?shipping:(accepted.get(l.source_item_id!)??0n);
   const beforeGross=l.kind==='shipping'?g-prior:g-g*prior/q,afterGross=l.kind==='shipping'?g-current:g-g*current/q;
   const bq=l.kind==='shipping'?1n:q-prior,aq=l.kind==='shipping'?1n:q-current,b=money(beforeGross,rate),after=money(afterGross,rate);
   return {ordinal:l.ordinal,line_id:l.line_id,source_item_id:l.source_item_id,kind:l.kind,name:l.name,unit:l.unit,vat_code:l.vat_code,zero_domestic_basis:l.zero_domestic_basis,
    affected:prior!==current,before:{quantity:signed(bq),...b},after:{quantity:signed(aq),...after},delta:{quantity:signed(aq-bq),...minus(after,b)}};
  });
  const before=sum(rows.map(r=>r.before)),after=sum(rows.map(r=>r.after));
  const c:B2bCorrectionCalculation={schema:'b2b-invoice-correction-calculation/v1',state:'unnumbered_calculation',currency:'PLN',tax_method:'gross_line_half_up',shipping_credit_scope:x.shipping_credit_scope,
   original:{document_id:original.id,receipt_id:receipt.id,number:original.number,scope_hash:original.data.scope_hash,fiscal_snapshot_hash:original.data.project_hash,issued_basis_hash:b2bCorrectionHash(x.original)},
   acceptance:{return_id:a.return_id,number:a.number,receipt_sequence:a.receipt_sequence,receipt_id:native_proof.receipt_id,admission_id:native_proof.admission_id,receipt_snapshot_hash:native_proof.receipt_snapshot_hash,financial_hash:native_proof.financial_hash,received_at:a.received_at},
   fiscal_snapshot:fiscal,previous_chain_hash:chain,rows,totals:{before,after,delta:minus(after,before)},vat_buckets:[...new Set(rows.map(r=>r.vat_code))].sort((a,b)=>(a==='0 KR'?0:Number(a))-(b==='0 KR'?0:Number(b))).map(vat_code=>{
    const bucket=rows.filter(r=>r.vat_code===vat_code),b=sum(bucket.map(r=>r.before)),e=sum(bucket.map(r=>r.after));return {vat_code,before:b,after:e,delta:minus(e,b)};
   })};
  check(BigInt(c.totals.delta.gross_minor)===-refund,'SOURCE_MISMATCH','Korekta nie odpowiada całemu przyjęciu');
  if(i<selected){const p=x.previous_credits[i];check(p.original_document_id===original.id&&p.original_receipt_id===receipt.id&&p.return_id===a.return_id&&p.return_receipt_id===native_proof.receipt_id&&p.receipt_sequence===a.receipt_sequence&&!creditIds.has(p.document_id)&&!creditIds.has(p.receipt_id)&&p.document_id!==original.id&&p.receipt_id!==receipt.id,'CREDIT_CHAIN_MISMATCH','Obce/powtórzone poprzednie correction receipts');
   creditIds.add(p.document_id);creditIds.add(p.receipt_id);check(p.calculation_hash===b2bCorrectionHash(c)&&b2bCorrectionHash(p.calculation)===p.calculation_hash,'CREDIT_CHAIN_MISMATCH','Poprzednia korekta nie jest pełnym narastającym obliczeniem');chain=b2bCorrectionHash({previous_chain_hash:chain,credit:p});
  }else result=c;
 }
 check(result,'INCOMPLETE_HISTORY','Brak wybranego przyjęcia');bounded(result,B2B_CORRECTION_LIMITS.output_bytes);
 const calculation_hash=b2bCorrectionHash(result);return {calculation:result,calculation_hash,scope_hash:b2bCorrectionHash({original:x.original,acceptance_manifest:x.acceptance_manifest,previous_credits:x.previous_credits,selected_return_id:x.selected_return_id,shipping_credit_scope:x.shipping_credit_scope,calculation_hash})};
}
