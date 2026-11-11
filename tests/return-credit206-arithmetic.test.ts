/** Synthetic financial model tests only. No native receipts, SQL, factory or API. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {LocalInvoiceSnapshot} from '../server/local-invoices';
import {localInvoiceLineAmounts} from '../server/local-invoice-values';
import {consumerCreditHash,calculateLocalConsumerCredit,ConsumerCreditError} from '../server/local-consumer-credit-arithmetic';
import {calculateReturnCredit206} from '../server/return-credit206-arithmetic';
import {returnCredit206Number,returnCredit206SeriesInput,type ReturnCredit206Source} from '../server/return-credit206-values';
function fixture(){
 const order=randomUUID(),item=randomUUID(),product=randomUUID(),document=randomUUID(),receipt=randomUUID(),preview=randomUUID(),series=randomUUID(),number='FV/OWN/2026/000001';
 const money=localInvoiceLineAmounts('3401',23),zero=localInvoiceLineAmounts('0',23);
 const snapshot:LocalInvoiceSnapshot={order:{id:order,number:'OWN-ORDER',version:'1',status:'shipped',currency:'PLN',total_minor:'3401',shipping_cost_minor:'0',payment_mode:'prepaid'},seller:{name:'Own synthetic seller',street:'Own1',postal_code:'00-001',city:'Warszawa',country:'PL',tax_id:'5260250274'},buyer:{kind:'consumer',tax_id:'',name:'Own buyer',email:'own@example.test',address:{street:'Own1',postal_code:'00-001',city:'Warszawa',country:'PL'}},series:{id:series,name:'Own FV',prefix:'OWN',payment_terms_days:0,payment_instructions:'',notes:''},currency:'PLN',lines:[{kind:'item',item_id:item,product_id:product,sku:'OWN',name:'Own actual money model',quantity:3,unit:'szt.',unit_gross_minor:'1133',discount_gross_minor:'0',rounding_gross_minor:'2',vat_rate:23,...money},{kind:'shipping',item_id:null,product_id:null,sku:'',name:'Dostawa',quantity:1,unit:'usł.',unit_gross_minor:'0',discount_gross_minor:'0',rounding_gross_minor:'0',vat_rate:23,...zero}],totals:money,vat_totals:[{vat_rate:23,...money}],rounding_method:'gross_line_half_up',tax_regime:'ordinary_domestic',consumer_sale_confirmed:true,no_special_tax_procedure_confirmed:true,not_fiscal_receipt_confirmed:true,sell_date:'2026-10-01',issue_date:'2026-10-01',due_date:'2026-10-01',year:2026};
 const hash=consumerCreditHash(snapshot),original={document:{id:document,order_id:order,kind:'invoice' as const,mode:'local_invoice' as const,number,data:{...snapshot,number,preview_id:preview,scope_hash:hash,local_only:true as const,ksef_state:'not_submitted' as const,fiscalized:false as const},created_at:'2026-10-01T09:00:00.000000Z'},receipt:{id:receipt,document_id:document,preview_id:preview,number,scope_hash:hash,snapshot}};
 const source:ReturnCredit206Source={schema:'consumer-return-credit-source/v2',original,acceptances:[],rejected_inspections:[],previous_credits:[],physical_protocols:[],credit_families:[],selected_return_id:''};
 const add=(accepted:number,refund:string,protocol:'rma'|'assistant_v1'|'destinations_v1'='destinations_v1',restocked=accepted)=>{
  const seq=source.acceptances.length+1,financial={return_id:randomUUID(),receipt_id:randomUUID(),receipt_sequence:seq,received_at:`2026-10-0${seq+1}T10:00:00.000000Z`,refund_amount_minor:refund,refunded_shipping_minor:'0',items:[{item_id:item,accepted:String(accepted),restocked:String(restocked),refund_amount_minor:refund}]};
  source.acceptances.push({...financial,financial_hash:consumerCreditHash(financial)});source.physical_protocols.push({return_id:financial.return_id,receipt_id:financial.receipt_id,protocol});source.selected_return_id=financial.return_id;return financial;
 };
 return{source,add};
}
const code=(expected:string)=>(e:unknown)=>e instanceof ConsumerCreditError&&e.code===expected;
test('actual-shaped reject-only inspection has no financial sequence and cannot block later accepted169 sequence1',()=>{
 const{source,add}=fixture(),reject={return_id:randomUUID(),receipt_id:randomUUID(),completed_at:'2026-10-02T09:00:00.000000Z',evidence_hash:'a'.repeat(64)};source.rejected_inspections.push(reject);source.selected_return_id=reject.return_id;
 const only=calculateReturnCredit206(source);assert.equal(only.status,'no_commercial_change');assert.equal(only.calculation,null);assert.equal(only.next_return_id,null);assert.equal(source.acceptances.length,0);
 const accepted=add(1,'1133');source.selected_return_id=reject.return_id;const noChange=calculateReturnCredit206(source);assert.equal(noChange.status,'no_commercial_change');assert.equal(noChange.next_return_id,accepted.return_id);
 source.selected_return_id=accepted.return_id;const real=calculateReturnCredit206(source);assert.equal(real.status,'credit_required');assert.equal(real.calculation!.receipt_sequence,1);assert.equal(real.calculation!.totals.delta.gross_minor,'-1133');assert.equal(real.physical_history_hash,noChange.physical_history_hash);assert.notEqual(real.physical_history_hash,only.physical_history_hash);
});
test('future rejected inspections change total physical audit without altering a previously issued calculation prefix',()=>{
 const{source,add}=fixture(),first=add(1,'1133'),calculation=calculateReturnCredit206(source).calculation!;
 const previous={document_id:randomUUID(),receipt_id:randomUUID(),return_id:first.return_id,return_receipt_id:first.receipt_id,receipt_sequence:1,calculation,calculation_hash:consumerCreditHash(calculation)};source.previous_credits.push(previous);source.credit_families.push({document_id:previous.document_id,receipt_id:previous.receipt_id,family:'destinations',created_at:'2026-10-02T11:00:00.000000Z'});
 const later={return_id:randomUUID(),receipt_id:randomUUID(),completed_at:'2026-10-03T10:00:00.000001Z',evidence_hash:'b'.repeat(64)};source.rejected_inspections.push(later);source.selected_return_id=later.return_id;const out=calculateReturnCredit206(source);assert.equal(out.status,'no_commercial_change');assert.notEqual(out.physical_history_hash,calculation.physical_history_hash);assert.deepEqual(source.previous_credits[0].calculation,calculation);source.selected_return_id=first.return_id;assert.equal(calculateReturnCredit206(source).status,'already_credited');
});
test('sale plus custody accepted units affect money, rejected units do not, and VAT before/after agrees',()=>{
 const{source,add}=fixture();add(2,'2267','destinations_v1',1);
 const out=calculateReturnCredit206(source).calculation!;assert.equal(out.totals.delta.gross_minor,'-2267');assert.equal(out.rows[0].after.quantity,'1');assert.equal(out.rows[0].after.gross_minor,'1134');
 for(const part of ['before','after','delta']as const)assert.equal(BigInt(out.totals[part].net_minor)+BigInt(out.totals[part].vat_minor),BigInt(out.totals[part].gross_minor));
});
test('literal legacy credit before destinations coexists with zero-change receipt and later new credit',()=>{
 const{source,add}=fixture();const first=add(1,'1133','rma'),legacyCalculation=calculateLocalConsumerCredit({original:source.original,acceptances:[source.acceptances[0]],previous_credits:[],selected_return_id:first.return_id});
 const old={document_id:randomUUID(),receipt_id:randomUUID(),return_id:first.return_id,return_receipt_id:first.receipt_id,receipt_sequence:1,calculation:legacyCalculation,calculation_hash:consumerCreditHash(legacyCalculation)};
 source.previous_credits.push(old);source.credit_families.push({document_id:old.document_id,receipt_id:old.receipt_id,family:'legacy',created_at:'2026-10-02T11:00:00.000000Z'});
 add(0,'0');add(1,'1134');const before=structuredClone(source),out=calculateReturnCredit206(source);assert.equal(out.status,'credit_required');assert.equal(out.calculation!.totals.before.gross_minor,'2268');assert.equal(out.calculation!.totals.delta.gross_minor,'-1134');assert.equal(out.calculation!.previous_chain_hash,consumerCreditHash(old));assert.deepEqual(source,before);
});
test('successor receipt replay is recognized, later credit preserves exact previous calculation and full physical chain',()=>{
 const{source,add}=fixture();add(0,'0');const first=add(1,'1133'),calculation=calculateReturnCredit206(source).calculation!;
 const old={document_id:randomUUID(),receipt_id:randomUUID(),return_id:first.return_id,return_receipt_id:first.receipt_id,receipt_sequence:2,calculation,calculation_hash:consumerCreditHash(calculation)};
 source.previous_credits.push(old);source.credit_families.push({document_id:old.document_id,receipt_id:old.receipt_id,family:'destinations',created_at:'2026-10-03T11:00:00.000000Z'});
 assert.equal(calculateReturnCredit206(source).status,'already_credited');add(1,'1134');const out=calculateReturnCredit206(source);assert.equal(out.status,'credit_required');assert.equal(out.calculation!.previous_chain_hash,consumerCreditHash(old));
 const broken=structuredClone(source);broken.previous_credits[0].calculation.totals.delta.gross_minor='-1132';assert.throws(()=>calculateReturnCredit206(broken),code('PREVIOUS_CREDIT_CALCULATION'));
});
test('a zero-change return can never acquire a fictitious document or financial sequence',()=>{
 const{source,add}=fixture(),a=add(0,'0');source.previous_credits.push({document_id:randomUUID(),receipt_id:randomUUID(),return_id:a.return_id,return_receipt_id:a.receipt_id,receipt_sequence:1,calculation:{}as never,calculation_hash:'a'.repeat(64)});source.credit_families.push({document_id:source.previous_credits[0].document_id,receipt_id:source.previous_credits[0].receipt_id,family:'destinations',created_at:'2026-10-02T11:00:00.000000Z'});
 assert.throws(()=>calculateReturnCredit206(source),code('NO_CHANGE_CANNOT_HAVE_DOCUMENT'));
});
test('later acceptance cannot skip an earlier commercial return; duplicate physical IDs and altered money refuse',()=>{
 const{source,add}=fixture();add(1,'1133');add(1,'1134');assert.equal(calculateReturnCredit206(source).status,'earlier_acceptance_required');
 const duplicate=structuredClone(source);duplicate.acceptances[1].return_id=duplicate.acceptances[0].return_id;duplicate.selected_return_id=duplicate.acceptances[0].return_id;assert.throws(()=>calculateReturnCredit206(duplicate),code('ACCEPTANCE_SEQUENCE'));
 const altered=structuredClone(source);altered.acceptances[1].refund_amount_minor='1133';assert.throws(()=>calculateReturnCredit206(altered),code('FINANCIAL_HASH'));
 const wrongCost=structuredClone(source);wrongCost.acceptances[1].items[0].refund_amount_minor='1000';const{financial_hash,...financial}=wrongCost.acceptances[1];wrongCost.acceptances[1].financial_hash=consumerCreditHash(financial);assert.throws(()=>calculateReturnCredit206(wrongCost),code('CUMULATIVE_GROSS'));
});
test('legacy credits after first destinations or mismatched family mapping cannot be silently adopted',()=>{
 const{source,add}=fixture();const a=add(1,'1133'),calculation=calculateReturnCredit206(source).calculation!;
 source.previous_credits.push({document_id:randomUUID(),receipt_id:randomUUID(),return_id:a.return_id,return_receipt_id:a.receipt_id,receipt_sequence:1,calculation,calculation_hash:consumerCreditHash(calculation)});const pc=source.previous_credits[0];source.credit_families.push({document_id:pc.document_id,receipt_id:pc.receipt_id,family:'legacy',created_at:'2026-10-02T11:00:00.000000Z'});
 assert.throws(()=>calculateReturnCredit206(source),code('LEGACY_AFTER_DESTINATION'));source.credit_families[0].family='destinations';source.credit_families[0].receipt_id=randomUUID();assert.throws(()=>calculateReturnCredit206(source),code('CREDIT_FAMILY_MAPPING'));
});
test('ordinary configurable correction series is disjoint from legacy four-component numbering',()=>{
 const input=returnCredit206SeriesInput.parse({client_key:randomUUID(),name:'Korekty zwrotów'});assert.equal(input.prefix,'KOR-ZWROT');assert.equal(returnCredit206Number(input.prefix,2026,1),'KOR-ZWROT/2026/000001');assert.equal(returnCredit206Number('ZWROTY',2026,999999),'ZWROTY/2026/999999');
 for(const prefix of ['KOR/OWN','a','..','KOR\nBAD'])assert.throws(()=>returnCredit206Number(prefix,2026,1));for(const seq of [0,1000000,1.1])assert.throws(()=>returnCredit206Number('ZWROT',2026,seq));
});
test('legacy188 credit before the first rejected inspection remains valid without any accepted destinations; later legacy issue refuses',()=>{
 const{source,add}=fixture(),accepted=add(1,'1133','rma');const calculation=calculateLocalConsumerCredit({original:source.original,acceptances:[source.acceptances[0]],previous_credits:[],selected_return_id:accepted.return_id});
 const credit={document_id:randomUUID(),receipt_id:randomUUID(),return_id:accepted.return_id,return_receipt_id:accepted.receipt_id,receipt_sequence:1,calculation,calculation_hash:consumerCreditHash(calculation)};
 source.previous_credits.push(credit);source.credit_families.push({document_id:credit.document_id,receipt_id:credit.receipt_id,family:'legacy',created_at:'2026-10-02T11:00:00.000000Z'});
 const inspection={return_id:randomUUID(),receipt_id:randomUUID(),completed_at:'2026-10-03T10:00:00.000000Z',evidence_hash:'c'.repeat(64)};source.rejected_inspections.push(inspection);source.selected_return_id=inspection.return_id;
 const out=calculateReturnCredit206(source);assert.equal(out.status,'no_commercial_change');assert.equal(out.calculation,null);assert.equal(out.next_return_id,null);assert.deepEqual(source.previous_credits[0].calculation,calculation);source.credit_families[0].created_at='2026-10-03T10:00:00.000001Z';assert.throws(()=>calculateReturnCredit206(source),code('LEGACY_AFTER_DESTINATION'));
});
