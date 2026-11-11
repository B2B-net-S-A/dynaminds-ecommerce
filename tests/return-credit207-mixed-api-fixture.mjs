/** Import-inert mixed fixture. All invoice/return/credit history is created by ordinary HTTP05.
 * The reused fixture may seed only its own tenant/IAM; receipt IDs here come from public HTTP, never proof SQL. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {assertHistory206CasesFileFresh,prepareHistory206CasesFromPreview,readHistory206PreviewLocator,HISTORY206_PREVIEW_REVISION} from './return-credit206-api-fixture.mjs';
import {issueHistory207InvoiceBeforeReturn} from './return-credit207-invoice-api-fixture.mjs';

export async function createHistory207LegacyBeforeDestinations({ok,tenantId,order,wms,onProgress=async()=>{}}){
 assert.equal(wms,false,'Mixed ordinary legacy fixture currently uses explicit OFF stock');assert.equal(typeof onProgress,'function');
 const invoice=await issueHistory207InvoiceBeforeReturn({ok,tenantId,order,wms,invoicePrefix:'FVZWR-'+randomUUID().slice(0,6).toUpperCase()});
 await onProgress({phase:'original_invoice_issued',invoice});
 const cheap=order.items.find(i=>i.line_total===1000),expensive=order.items.find(i=>i.line_total===3401);assert(cheap&&expensive);assert.equal(cheap.quantity,1);assert.equal(expensive.quantity,2);
 const requestKey=randomUUID();await onProgress({phase:'before_ordinary_rma',client_key:requestKey,order_id:order.id});
 let rma=await ok('/orders/'+order.id+'/returns','POST',{client_key:requestKey,reason:'Zwrot jednej pozycji',shipping_refund:0,items:[{item_id:cheap.id,quantity:1}]},201);rma=await ok('/returns/'+rma.id);assert.equal(rma.items.length,1);
 const receive={version:Number(rma.version),shipping_refund:0,note:'Przyjęcie jednej pozycji do magazynu',items:[{item_id:cheap.id,accepted:1,restocked:1}]};
 await onProgress({phase:'before_ordinary_receive',return_id:rma.id,request:receive});rma=await ok('/returns/'+rma.id+'/receive','POST',receive);
 assert.equal(rma.state,'refund_pending');assert.equal(rma.refund_amount,1000);assert.equal(rma.refunded_shipping,0);assert.equal(rma.receipt_sequence,1);assert(rma.received_at);assert(Array.isArray(rma.stock_receipts)&&rma.stock_receipts.length>0);const physical=[...new Set(rma.stock_receipts.map(r=>r.receipt_id))];assert.equal(physical.length,1);
 await onProgress({phase:'ordinary_rma_received',return_id:rma.id,physical_receipt_id:physical[0]});
 const source=await ok('/local-consumer-credits/orders/'+order.id+'/source');assert.equal(source.available,true);assert.equal(source.eligible,true);assert.equal(source.next_return_id,rma.id);assert.equal(source.previous_credits.length,0);assert.equal(source.calculation.totals.delta.gross_minor,'-1000');assert.equal(source.calculation.totals.after.gross_minor,'3401');assert.equal(source.calculation.return_receipt_id,physical[0]);
 const body={client_key:randomUUID(),original_document_id:invoice.original_document_id,return_id:rma.id,expected_return_version:source.current_return_version,reason:'Zwrot jednej pozycji',ordinary_domestic_confirmed:true,local_only:true};
 await onProgress({phase:'before_legacy_preview',operation:'preview',client_key:body.client_key,original_document_id:body.original_document_id,request:body});const prepared=await ok('/local-consumer-credits/previews','POST',body,201);assert.equal(prepared.reused,false);assert.equal(prepared.preview.can_issue,true);assert.deepEqual(prepared.preview.snapshot.calculation,source.calculation);
 const issueBody={client_key:randomUUID(),scope_hash:prepared.preview.scope_hash,confirmed:true,local_only:true};await onProgress({phase:'before_legacy_issue',operation:'issue',client_key:issueBody.client_key,preview_id:prepared.preview.id,request:issueBody});
 const issued=await ok('/local-consumer-credits/previews/'+prepared.preview.id+'/issue','POST',issueBody,201),d=issued.document,r=issued.receipt;
 assert.equal(issued.reused,false);assert.equal(d.mode,'local_consumer_credit');assert.equal(d.kind,'correction');assert.equal(d.original_document_id,invoice.original_document_id);assert.equal(d.return_id,rma.id);assert.equal(r.document_id,d.id);assert.equal(r.preview_id,prepared.preview.id);assert.equal(r.return_receipt_id,physical[0]);assert.equal(r.scope_hash,prepared.preview.scope_hash);assert.equal(d.data.calculation.totals.before.gross_minor,'4401');assert.equal(d.data.calculation.totals.delta.gross_minor,'-1000');assert.equal(d.data.calculation.totals.after.gross_minor,'3401');assert.equal(d.data.local_only,true);assert.equal(d.data.ksef_state,'not_submitted');assert.equal(d.data.fiscalized,false);
 const detail=await ok('/local-consumer-credits/documents/'+d.id);assert.deepEqual(detail.document,d);assert.deepEqual(detail.receipt,r);const command=await ok('/local-consumer-credits/commands/'+issueBody.client_key+'?operation=issue');assert.deepEqual(command.document,d);assert.deepEqual(command.receipt,r);
 const result={...invoice,legacy_return_id:rma.id,legacy_return_receipt_id:physical[0],legacy_document_id:d.id,legacy_receipt_id:r.id,legacy_preview_id:prepared.preview.id,legacy_scope_hash:prepared.preview.scope_hash,legacy_preview_client_key:body.client_key,legacy_issue_client_key:issueBody.client_key,legacy_preview_request:body,legacy_issue_request:issueBody,legacy_preview:prepared.preview,legacy_document:d,legacy_receipt:r};
 await onProgress({phase:'legacy_credit_issued_before_any_destinations',case:result});
 return{case:result,extension:{return_items:[{item_id:expensive.id,quantity:2}],expected_commercial_minor:1700}};
}

export async function prepareHistory207MixedCaseFromPreview(locatorFile,mixedCasesFile,{onProgress=async()=>{}}={}){
 assert.equal(typeof onProgress,'function');const locator=await readHistory206PreviewLocator(locatorFile);assert.notEqual(locator.casesFile,mixedCasesFile);const directory=await assertHistory206CasesFileFresh(mixedCasesFile);await assertHistory206CasesFileFresh(locator.casesFile);let mixed;
 const observations=[];
 const physical=await prepareHistory206CasesFromPreview(locatorFile,{modes:[false],includeRejectedHistory:true,httpReceiptIdsOnly:true,beforeReturn:async args=>{const created=await createHistory207LegacyBeforeDestinations({...args,onProgress});mixed=created.case;return created.extension;},onReceived:async({tenantId,rma,received,rejectedOnly,receiptId})=>{
  assert.equal(tenantId,mixed.tenant_id);assert(new Date(received.operation.created_at)>=new Date(mixed.legacy_document.created_at));assert.equal(received.return_case.refund_amount,rejectedOnly?0:1700);assert.equal(received.return_case.receipt_sequence,rejectedOnly?0:2);
  const observation={return_id:rma.id,receipt_id:receiptId,assistant_receipt_id:received.operation.id,rejected_only:rejectedOnly,operation:received.operation,return_case:received.return_case};observations.push(observation);await onProgress({phase:rejectedOnly?'rejected_inspection_completed':'later_destinations_received',observation});
 }});
 assert(mixed);assert.equal(physical.length,2);assert.equal(observations.length,2);assert.equal(observations[0].rejected_only,true);assert.equal(observations[1].rejected_only,false);
 const result={schema:'dynaminds-native-return-credit207-mixed-case/v1',preview_revision:HISTORY206_PREVIEW_REVISION,evidence:'genuine_http_fv157_rma169_credit188_before_rejected148_then_destinations169_no207_execution',expected:{original_gross_minor:'4401',legacy_delta_minor:'-1000',legacy_after_minor:'3401',successor_delta_minor:'-1700',remaining_minor:'1701'},case:{...mixed,no_change_physical_receipt_id:observations[0].receipt_id,physical_receipt_id:observations[1].receipt_id,later_return_id:observations[1].return_id,later_assistant_receipt_id:observations[1].assistant_receipt_id},observations};
 assert.deepEqual(await assertHistory206CasesFileFresh(mixedCasesFile),directory);await fs.writeFile(mixedCasesFile,JSON.stringify(result,null,2)+'\n',{mode:0o600,flag:'wx'});return result;
}
