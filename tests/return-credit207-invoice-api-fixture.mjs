/** Opt-in genuine FV157-before-RMA fixture. No SQL business evidence and no Source207 activation. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import {assertHistory206CasesFileFresh,prepareHistory206CasesFromPreview,readHistory206PreviewLocator,HISTORY206_PREVIEW_REVISION} from './return-credit206-api-fixture.mjs';

export async function issueHistory207InvoiceBeforeReturn({ok,tenantId,order,wms,invoicePrefix='FV-ZWROT'}){
 assert(/^[A-Z0-9][A-Z0-9-]{0,11}$/.test(invoicePrefix));
 const current=await ok('/orders/'+order.id);assert.equal(current.status,'shipped');assert.equal(current.currency,'PLN');
 assert.equal(current.items.length,2);assert.deepEqual(current.items.map(i=>i.line_total).sort((a,b)=>a-b),[1000,3401]);
 const seriesReply=await ok('/local-invoices/series','POST',{client_key:randomUUID(),name:'Own ordinary consumer invoice',prefix:invoicePrefix,seller:{name:'Synthetic local seller',street:'Testowa 1',postal_code:'00-001',city:'Warszawa',country:'PL',tax_id:'5260250274'},payment_terms_days:0,payment_instructions:'',notes:'Synthetic local acceptance only',seller_vat_status:'active_domestic'},201);
 const series=seriesReply.series;assert(series?.id);
 const previewReply=await ok('/local-invoices/orders/'+current.id+'/previews','POST',{client_key:randomUUID(),series_id:series.id,order_version:String(current.version),shipping_vat:23,buyer:{kind:'consumer',name:'Synthetic local buyer',street:'Testowa 2',postal_code:'00-002',city:'Warszawa',country:'PL'},sell_date:new Date(current.created_at).toISOString().slice(0,10),tax_regime:'ordinary_domestic',consumer_sale_confirmed:true,no_special_tax_procedure_confirmed:true,not_fiscal_receipt_confirmed:true},201);
 const p=previewReply.preview;assert(p?.can_issue);assert.equal(p.order_id,current.id);assert.match(p.scope_hash,/^[a-f0-9]{64}$/);
 const issued=await ok('/local-invoices/previews/'+p.id+'/issue','POST',{client_key:randomUUID(),scope_hash:p.scope_hash,confirmed:true,local_only:true},201);
 const verify=value=>{const{document:d,receipt:r}=value;assert(d&&r);assert.equal(d.order_id,current.id);assert.equal(d.kind,'invoice');assert.equal(d.mode,'local_invoice');assert.equal(r.document_id,d.id);assert.equal(r.preview_id,p.id);assert.equal(r.scope_hash,p.scope_hash);assert.equal(r.series_id,series.id);assert.equal(d.data.currency,'PLN');assert.equal(d.data.totals.gross_minor,'4401');assert.equal(d.data.buyer.kind,'consumer');assert.equal(d.data.buyer.address.country,'PL');assert.equal(d.data.rounding_method,'gross_line_half_up');assert.equal(d.data.local_only,true);assert.equal(d.data.ksef_state,'not_submitted');assert.equal(d.data.fiscalized,false);assert.deepEqual(d.data.lines.filter(l=>l.kind==='item').map(l=>l.gross_minor).sort(),['1000','3401']);return d;};
 const d=verify(issued),read=await ok('/local-invoices/documents/'+d.id);verify(read);assert.deepEqual(read.document,issued.document);assert.deepEqual(read.receipt,issued.receipt);
 return{tenant_id:tenantId,order_id:current.id,original_document_id:d.id,original_receipt_id:issued.receipt.id,original_preview_id:p.id,original_scope_hash:p.scope_hash,wms};
}
/** Output paths must both be fresh before health/HTTP/SQL; Root runs this explicitly after review. */
export async function prepareHistory207InvoiceCasesFromPreview(locatorFile,financialCasesFile){
 const locator=await readHistory206PreviewLocator(locatorFile);assert.notEqual(locator.casesFile,financialCasesFile);
 const financialDirectory=await assertHistory206CasesFileFresh(financialCasesFile);
 await assertHistory206CasesFileFresh(locator.casesFile);const invoices=[];
 const physical=await prepareHistory206CasesFromPreview(locatorFile,{includeRejectedHistory:true,beforeReturn:async args=>{invoices.push(await issueHistory207InvoiceBeforeReturn(args));}});
 assert.equal(invoices.length,2);assert.equal(physical.length,3);
 const cases=invoices.map(invoice=>{const receipts=physical.filter(p=>p.tenant_id===invoice.tenant_id&&p.wms===invoice.wms);assert.equal(receipts.length,invoice.wms?1:2);return{...invoice,physical_receipt_id:receipts.at(-1).receipt_id,no_change_physical_receipt_id:invoice.wms?null:receipts[0].receipt_id};});
 assert.deepEqual(await assertHistory206CasesFileFresh(financialCasesFile),financialDirectory,'Financial cases parent changed during fixture work');
 await fs.writeFile(financialCasesFile,JSON.stringify({schema:'dynaminds-native-return-credit207-invoice-cases/v1',preview_revision:HISTORY206_PREVIEW_REVISION,evidence:'genuine_http_fv157_before_rma_no207_execution',cases},null,2)+'\n',{mode:0o600,flag:'wx'});
 return cases;
}
