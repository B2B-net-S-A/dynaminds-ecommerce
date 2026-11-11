/** Controlled DTO/order tests only; these do not prove an API-created mixed Native history. */
import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {createHistory207LegacyBeforeDestinations} from './return-credit207-mixed-api-fixture.mjs';
function fixture(config={}){
 const tenant=randomUUID(),cheap=randomUUID(),expensive=randomUUID(),order={id:randomUUID(),version:'1',status:'shipped',currency:'PLN',created_at:'2026-10-17T12:00:00Z',items:[{id:cheap,quantity:1,line_total:1000},{id:expensive,quantity:2,line_total:3401}]},calls=[],progress=[];
 const fv={id:randomUUID(),order_id:order.id,kind:'invoice',mode:'local_invoice',created_at:'2026-10-17T12:01:00Z',data:{currency:'PLN',totals:{gross_minor:'4401'},buyer:{kind:'consumer',address:{country:'PL'}},rounding_method:'gross_line_half_up',local_only:true,ksef_state:'not_submitted',fiscalized:false,lines:[{kind:'item',gross_minor:'1000'},{kind:'item',gross_minor:'3401'}]}};
 const fvPreview={id:randomUUID(),order_id:order.id,scope_hash:'a'.repeat(64),can_issue:true},fvSeries=randomUUID(),fvReceipt={id:randomUUID(),document_id:fv.id,preview_id:fvPreview.id,scope_hash:fvPreview.scope_hash,series_id:fvSeries};
 const rma={id:randomUUID(),items:[{item_id:cheap,requested:1}],version:'1'},physical=randomUUID(),calculation={return_receipt_id:physical,totals:{before:{gross_minor:'4401'},delta:{gross_minor:config.wrongCredit?'-999':'-1000'},after:{gross_minor:'3401'}}},legacyPreview={id:randomUUID(),can_issue:true,scope_hash:'b'.repeat(64),snapshot:{calculation}},legacyDocument={id:randomUUID(),kind:'correction',mode:'local_consumer_credit',original_document_id:fv.id,return_id:rma.id,created_at:'2026-10-17T12:02:00Z',data:{calculation,local_only:true,ksef_state:'not_submitted',fiscalized:false}},legacyReceipt={id:randomUUID(),document_id:null,preview_id:legacyPreview.id,return_receipt_id:physical,scope_hash:legacyPreview.scope_hash};legacyReceipt.document_id=legacyDocument.id;
 const ok=async(url,method='GET',body=undefined,status=200)=>{calls.push({url,method,body,status});assert(!url.includes('/return-destinations/'),'No destinations before genuine legacy credit');
  if(url==='/orders/'+order.id)return order;
  if(url==='/local-invoices/series'){assert.match(body.prefix,/^FVZWR-[A-F0-9]{6}$/);assert.equal(status,201);return{series:{id:fvSeries}};}
  if(url==='/local-invoices/orders/'+order.id+'/previews')return{preview:fvPreview};
  if(url==='/local-invoices/previews/'+fvPreview.id+'/issue')return{document:fv,receipt:fvReceipt};
  if(url==='/local-invoices/documents/'+fv.id)return{document:fv,receipt:fvReceipt};
  if(url==='/orders/'+order.id+'/returns'){assert.deepEqual(body.items,[{item_id:cheap,quantity:1}]);assert.equal(status,201);return rma;}
  if(url==='/returns/'+rma.id)return rma;
  if(url==='/returns/'+rma.id+'/receive'){assert.deepEqual(body.items,[{item_id:cheap,accepted:1,restocked:1}]);assert.equal(status,200);return{...rma,state:'refund_pending',refund_amount:1000,refunded_shipping:0,received_at:'2026-10-17T12:01:30Z',receipt_sequence:1,stock_receipts:[{receipt_id:physical}]};}
  if(url==='/local-consumer-credits/orders/'+order.id+'/source')return{available:true,eligible:true,next_return_id:rma.id,current_return_version:'2',previous_credits:[],calculation};
  if(url==='/local-consumer-credits/previews'){assert.equal(body.original_document_id,fv.id);assert.equal(body.expected_return_version,'2');return{reused:false,preview:legacyPreview};}
  if(url==='/local-consumer-credits/previews/'+legacyPreview.id+'/issue'){if(config.uncertainIssue)throw Error('Controlled unconfirmed issue');return{reused:false,document:legacyDocument,receipt:legacyReceipt};}
  if(url==='/local-consumer-credits/documents/'+legacyDocument.id||url.startsWith('/local-consumer-credits/commands/'))return{document:legacyDocument,receipt:legacyReceipt};
  throw Error('Unexpected controlled route');
 };
 return{ok,tenantId:tenant,order,wms:false,onProgress:async p=>progress.push(p),calls,progress,cheap,expensive,physical};
}
test('legacy fixture orders FV → ordinary169 → issued188 and returns only the remaining expensive line for future148',async()=>{
 const f=fixture(),result=await createHistory207LegacyBeforeDestinations(f);assert.deepEqual(result.extension,{return_items:[{item_id:f.expensive,quantity:2}],expected_commercial_minor:1700});assert.equal(result.case.legacy_return_receipt_id,f.physical);assert.equal(result.case.legacy_document.data.calculation.totals.delta.gross_minor,'-1000');assert.equal(result.case.legacy_document.data.calculation.totals.after.gross_minor,'3401');assert.equal(f.progress.at(-1).phase,'legacy_credit_issued_before_any_destinations');
 const phases=f.progress.map(p=>p.phase);assert(phases.indexOf('original_invoice_issued')<phases.indexOf('before_ordinary_receive'));assert(phases.indexOf('ordinary_rma_received')<phases.indexOf('before_legacy_issue'));assert(!f.calls.some(c=>c.url.includes('/return-destinations/')));
 const previewCall=f.calls.find(c=>c.url==='/local-consumer-credits/previews'),issueCall=f.calls.find(c=>c.url==='/local-consumer-credits/previews/'+result.case.legacy_preview_id+'/issue');
 assert.deepEqual(result.case.legacy_preview_request,previewCall.body);assert.deepEqual(result.case.legacy_issue_request,issueCall.body);assert.equal(result.case.legacy_preview.id,result.case.legacy_preview_id);assert.equal(result.case.legacy_preview.can_issue,true);assert.equal(result.case.legacy_preview_request.client_key,result.case.legacy_preview_client_key);assert.equal(result.case.legacy_issue_request.client_key,result.case.legacy_issue_client_key);
 assert.deepEqual(f.progress.find(p=>p.phase==='before_legacy_preview').request,previewCall.body);assert.deepEqual(f.progress.find(p=>p.phase==='before_legacy_issue').request,issueCall.body);
});
test('wrong legacy minor delta refuses before any legacy preview/issue command',async()=>{const f=fixture({wrongCredit:true});await assert.rejects(createHistory207LegacyBeforeDestinations(f));assert(!f.calls.some(c=>c.method==='POST'&&c.url.startsWith('/local-consumer-credits/')));});
test('unconfirmed legacy issue is not retried and its original key is preserved before sending',async()=>{const f=fixture({uncertainIssue:true});await assert.rejects(createHistory207LegacyBeforeDestinations(f),/unconfirmed issue/);const calls=f.calls.filter(c=>c.method==='POST'&&c.url.startsWith('/local-consumer-credits/')&&c.url.endsWith('/issue'));assert.equal(calls.length,1);assert.equal(f.progress.at(-1).phase,'before_legacy_issue');assert.equal(f.progress.at(-1).client_key,calls[0].body.client_key);});
test('unsupported WMS mode refuses before any HTTP operation',async()=>{const f=fixture();await assert.rejects(createHistory207LegacyBeforeDestinations({...f,wms:true}),/explicit OFF/);assert.equal(f.calls.length,0);});
