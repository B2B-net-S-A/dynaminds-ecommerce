import {financialReturn162AvailableInTx} from './financial-return-completion';
import {validateFinancialReturn162Received,validateFinancialReturn162Historical} from './financial-return-values';
/** Staged160 historical financial collector with complete typed own160 chain.
 * Not a standalone issuance grant: the fixed managed160 coordinator performs
 * native admission and last terminal authority on the same transaction. */
import type {PoolClient} from 'pg';
import type {B2bFa3NativeActor} from './fa3-draft-source';
import {z} from 'zod';
import {ensure} from './errors';
import {calculateB2bInvoiceCorrection,b2bCorrectionHash,b2bNativeReturnFinancialSchema,type B2bPreviousCredit,type B2bCorrectionInput,type B2bCorrectionOriginal,type B2bNativeReturnFinancial} from './b2b-credit-arithmetic';
const uuid=z.uuid().transform(s=>s.toLowerCase());
export const b2bCorrectionSourceInput=z.strictObject({document_id:uuid,return_id:uuid});
type Row=Record<string,any>;
const MAX_BYTES=33554432;
function one(rows:Row[]){ensure(rows.length===1,503,'Niepełna kardynalność natywnego dowodu');return rows[0];}
function same(a:unknown,b:unknown){return b2bCorrectionHash(a)===b2bCorrectionHash(b);}
function minor(v:unknown){const s=String(v);ensure(s.length<=19&&/^(0|[1-9][0-9]*)$/.test(s)&&BigInt(s)<=9223372036854775807n,503,'Niekanoniczna natywna kwota/ilość');return s;}
function omit(x:Row,keys:string[]){return Object.fromEntries(Object.entries(x).filter(([k])=>!keys.includes(k)));}
function safeJson(x:unknown):void{if(typeof x==='number')ensure(Number.isSafeInteger(x),413,'Natywny JSON wymaga bezstratnej projekcji dużego integer');else if(Array.isArray(x))x.forEach(safeJson);else if(x&&typeof x==='object')Object.values(x).forEach(safeJson);}
function budget(x:unknown){ensure(Buffer.byteLength(JSON.stringify(x),'utf8')<=MAX_BYTES,413,'Pełne finansowe źródło przekracza32MiB; brak obcięcia');safeJson(x);}
type Context={tenant:string;root:string;started:string;pid:number;owner:string};
async function context(c:PoolClient,a:B2bFa3NativeActor):Promise<Context>{
 const r=one((await c.query(`SELECT current_setting('app.tenant_id',true) tenant,pg_current_xact_id()::text root,
 transaction_timestamp()::text started,pg_backend_pid() pid,session_user owner,current_user role,
 current_setting('TimeZone') timezone,pg_get_userbyid(relowner) relation_owner FROM pg_class WHERE oid='public.orders'::regclass`)).rows);
 ensure(r.tenant===a.tenantId&&r.role==='dyna_app'&&r.owner!=='dyna_app'&&r.owner===r.relation_owner&&r.timezone==='UTC',403,'Brak własnej zarządzanej transakcji/roli UTC');return {tenant:r.tenant,root:r.root,started:r.started,pid:r.pid,owner:r.owner};
}
async function nativeAccess(c:PoolClient,a:B2bFa3NativeActor){
 const {b2bFa3NativeIdentityHash}=await import('./fa3-draft-source');
 const {fa3DraftOwnerInTx}=await import('./fa3-draft-access');
 const h=b2bFa3NativeIdentityHash(a); // Actual request WeakMap/session/key, never a body actor.
 await fa3DraftOwnerInTx(c,async()=>{
  const p=one((await c.query(`SELECT to_regprocedure('public.b2b_invoice_require(uuid,uuid,text,boolean,boolean)') IS NOT NULL original,
   to_regprocedure('public.catalog_stock_return_require()') IS NOT NULL history,
   to_regprocedure('public.b2b_dropship_return_acceptance(uuid)') IS NOT NULL partner_helper`)).rows);
  ensure(p.original&&p.history&&p.partner_helper,503,'Brak pełnego natywnego oryginału/finansowego źródła169');
  await c.query('SELECT public.b2b_invoice_require($1,$2,$3,false,false)',[a.userId,a.apiKeyId??null,h]);
  await c.query('SELECT public.catalog_stock_return_require()');
 });
}
async function originalInTx(c:PoolClient,a:B2bFa3NativeActor,id:string){
 // Native RLS/access precedes every owner-only publication/evidence query.
 ensure((await c.query("SELECT id FROM documents WHERE(tenant_id,id)=($1,$2) AND kind='invoice' AND mode='b2b_invoice'",[a.tenantId,id])).rowCount,404,'Brak własnej wystawionejFV159');
 const {fa3DraftOwnerInTx}=await import('./fa3-draft-access');
 return fa3DraftOwnerInTx(c,async()=>{
  const raw=one((await c.query(`SELECT to_jsonb(d) document,to_jsonb(r) receipt,to_jsonb(p) preview,to_jsonb(a) admission,
   to_jsonb(project) project,to_jsonb(pr) project_receipt,to_jsonb(source_preview) source_preview,
   to_jsonb(s) series,to_jsonb(cmd) series_command,(r.root_xid=pg_current_xact_id() AND r.transaction_started_at=transaction_timestamp()) current_admission
   FROM documents d JOIN b2b_invoice_receipts r ON(r.tenant_id,r.document_id)=(d.tenant_id,d.id)
   JOIN b2b_invoice_previews p ON(p.tenant_id,p.id)=(r.tenant_id,r.preview_id)
   JOIN b2b_invoice_admissions a ON(a.tenant_id,a.id)=(r.tenant_id,r.id)
   JOIN fa3_draft_projects project ON(project.tenant_id,project.id)=(r.tenant_id,r.project_id)
   JOIN fa3_draft_receipts pr ON(pr.tenant_id,pr.id,pr.project_id)=(r.tenant_id,r.project_receipt_id,project.id)
   JOIN fa3_draft_previews source_preview ON(source_preview.tenant_id,source_preview.id)=(project.tenant_id,project.preview_id)
   JOIN local_invoice_series s ON(s.tenant_id,s.id)=(r.tenant_id,r.series_id)
   JOIN local_invoice_series_commands cmd ON(cmd.tenant_id,cmd.series_id)=(s.tenant_id,s.id)
   WHERE(d.tenant_id,d.id)=($1,$2)`,[a.tenantId,id])).rows);budget(raw);
  ensure(raw.current_admission===false,409,'Oryginał musi być rzeczywiście zakończonym historical issued159');
  const d=raw.document,r=raw.receipt,p=raw.preview,ad=raw.admission,f=d.data.fiscal_snapshot;
  ensure(same(r.snapshot,d.data)&&same(p.snapshot,omit(d.data,['number','year','sequence','preview_id','scope_hash']))&&same(raw.project.draft,f)&&same(raw.source_preview.draft,f)&&raw.project.draft_hash===d.data.project_hash&&raw.project.scope_hash===d.data.project_scope_hash,503,'Niespójny immutable oryginał159/158');
  ensure(raw.project.state==='approved_project'&&raw.project.issued===false&&raw.project.ksef_state==='not_submitted'&&raw.project_receipt.scope_hash===raw.project.scope_hash,503,'Obcy consumption rodzic projektu');
  ensure(ad.document_id===d.id&&ad.project_id===raw.project.id&&ad.preview_id===p.id&&ad.number===d.number&&same(ad.request,r.request)&&ad.root_xid===r.root_xid&&ad.transaction_started_at===r.transaction_started_at,503,'Niepełne rzeczywiste przyjęcie wystawienia159');
  ensure(same(raw.series.definition,d.data.series_definition)&&raw.series_command.request_hash===d.data.series_command_hash&&raw.series.request_hash===raw.series_command.request_hash&&same(p.source,raw.source_preview.source),503,'Obca rzeczywista seria/źródło oryginału');
  const original:B2bCorrectionOriginal={document:{id:d.id,order_id:d.order_id,kind:d.kind,mode:d.mode,number:d.number,data:d.data,created_at:d.created_at},receipt:{id:r.id,document_id:r.document_id,preview_id:r.preview_id,project_id:r.project_id,project_receipt_id:r.project_receipt_id,client_key:r.client_key,scope_hash:r.scope_hash,year:r.year,sequence:r.sequence,number:r.number,issued_at:r.issued_at}};
  return {original,raw};
 });
}
function proveJournalSets(g:Row){
 const receipt=g.receipt,ad=g.admission,ea=g.effect_admission,e=g.effect;
 ensure(ad.sealed===true&&ea.sealed===true&&ea.source_kind==='return'&&ea.source_id===ad.return_id&&ad.txid===ea.txid&&ad.actor_id===ea.actor_id&&(ad.api_key_id??null)===(ea.api_key_id??null)&&e.operation_id===receipt.wms_operation_id,503,'Niepełny sealed fizyczny rodzic169');
 for(const [kind,key]of [['stock','stock_movement_ids'],['bin','location_movement_ids'],['layer','layer_movement_ids']] as const){
  const ids:unknown=receipt.proof[key];ensure(Array.isArray(ids)&&ids.length<=10000&&new Set(ids).size===ids.length&&ids.every(id=>uuid.safeParse(id).success)&&same(ids,e.proof[key]),503,'Obce/brakujące journal ID169');
  const before:Row[]=ea.before_frame[kind+'_journals'],after:Row[]=e.after_frame[kind+'_journals'];ensure(Array.isArray(before)&&Array.isArray(after),503,'Brak pełnego zapieczętowanego frame152');
  const old=new Map(before.map(j=>[j.id,j]));ensure(old.size===before.length&&new Set(after.map(j=>j.id)).size===after.length&&before.every(j=>after.some(n=>n.id===j.id&&same(n,j))),503,'Zmieniono zamkniętą historię152');
  const born=after.filter(j=>!old.has(j.id));ensure(same(born.map(j=>j.id).sort(),[...ids].sort()),503,'Dowód nie obejmuje pełnego born journalset');
  const links:Row[]=g.journals.filter((j:Row)=>j.kind===kind);ensure(links.length===ids.length&&same(links.map(j=>j.journal_id).sort(),[...ids].sort()),503,'Niepełny typed effect journal receipt');
  for(const link of links){const actual=link.actual,witness=born.find(j=>j.id===link.journal_id);ensure(actual&&witness&&same(actual,witness)&&actual.tenant_id===ad.tenant_id,503,'Historyczny dziennik różni się od sealed frame');
   if(kind==='stock')ensure(actual.return_id===ad.return_id&&actual.order_id===ad.order_id&&actual.kind==='return'&&actual.delta>0,503,'Obcy fizyczny stock journal');
   if(kind==='bin')ensure(actual.kind==='stock_in'&&actual.delta>0,503,'Obcy incoming bin journal');
   if(kind==='layer')ensure(actual.operation_id===receipt.wms_operation_id&&actual.delta>0,503,'Obca przyjęta warstwa');
  }
 }
 ensure(receipt.proof.location_movement_ids.length>0&&receipt.proof.stock_movement_ids.length>0,409,'Brak rzeczywistego dodatniego physical receipt169');
}
function financial(g:Row):B2bNativeReturnFinancial{
 if(g.financial_receipt){
  const r=g.financial_receipt,ad=g.financial_admission;
  ensure(g.receipt===null&&g.admission===null&&g.effect_admission===null&&g.effect===null&&ad&&g.financial_current===false,409,'Exactly one completed typed native parent required');
  const historical={return_case:g.current_case,items:g.items,original:r.snapshot.original};
  validateFinancialReturn162Historical(r.snapshot,historical);
  const expected=validateFinancialReturn162Received(ad.before_frame,r.snapshot,r.physical_after);
  ensure(ad.id===r.id&&ad.tenant_id===r.tenant_id&&ad.return_id===r.return_id&&ad.order_id===r.order_id
   &&ad.original_document_id===r.original_document_id&&ad.original_receipt_id===r.original_receipt_id
   &&same(r.physical_before,r.physical_after)&&same(r.physical_before,ad.before_frame.physical)
   &&same(r.financial,expected.financial)&&r.financial_hash===expected.financial_hash,503,'Incomplete native financial received tuple162');
  return b2bNativeReturnFinancialSchema.parse({...r.financial,native_proof:{kind:'financial_return162',receipt_id:r.id,admission_id:ad.id,receipt_snapshot_hash:b2bCorrectionHash(r.snapshot),financial_hash:r.financial_hash}});
 }
 ensure(g.current_admission===false,409,'Przyjęcie169 musi być zakończonym historycznym źródłem');
 const current=g.current_case,saved=g.receipt.snapshot.return_case,items:Row[]=g.receipt.snapshot.items,ad=g.admission;
 ensure(['rma','legacy_status'].includes(ad.protocol)&&g.receipt.assistant_receipt_id===null&&g.receipt.exchange_id===null&&g.receipt.dropship_admission_id===null&&g.receipt.local_proof_id===null&&g.receipt.parcel_receipt_return_id===null,409,'Ten protokół wymaga własnego historycznego financial validator');
 ensure(saved.state==='refund_pending'&&saved.remedy==='refund'&&saved.received_at!==null&&['refund_pending','closed'].includes(current.state),409,'Nieobsługiwany lifecycle/remedy przyjęcia');
 ensure(same(omit(saved,['state','version','updated_at','refunded_at','settlement']),omit(current,['state','version','updated_at','refunded_at','settlement']))&&BigInt(current.version)>=BigInt(saved.version)&&same(items,g.items),503,'Zmieniła się immutable received financial projection');
 ensure(saved.id===ad.return_id&&saved.order_id===ad.order_id&&saved.tenant_id===ad.tenant_id&&same(saved.receipt,ad.frame.request)&&BigInt(saved.version)===BigInt(ad.frame.return_case.version)+1n,503,'Obcy snapshot/request/version faktycznego przyjęcia');
 const expected:Row[]=ad.frame.items;ensure(Array.isArray(expected)&&expected.length===items.length,503,'Brak wszystkich requested commercial items');
 for(const item of items){const old=expected.find(x=>x.item_id===item.item_id),request=ad.frame.request.items.find((x:Row)=>x.item_id===item.item_id);ensure(old&&request&&same(omit(item,['accepted','restocked','refund_amount']),omit(old,['accepted','restocked','refund_amount']))&&request.accepted===item.accepted&&request.restocked===item.restocked,503,'Obca receptura/przyjęta ilość komercyjna');}
 proveJournalSets(g);
 if(g.receipt.wms_operation_id!==null){const op=g.operation;ensure(op&&op.id===g.receipt.wms_operation_id&&op.kind==='return'&&op.tenant_id===ad.tenant_id&&op.order_id===ad.order_id&&op.return_id===ad.return_id&&op.warehouse_document_id===null&&op.purchase_receipt_id===null&&same(op.request,ad.frame.request),503,'Obca historyczna operacja WMS');}
 else ensure(g.receipt.proof.layer_movement_ids.length===0,503,'Warstwy bez rzeczywistego native parent');
 const f={tenant_id:saved.tenant_id,order_id:saved.order_id,return_id:saved.id,number:saved.number,receipt_sequence:saved.receipt_sequence,kind:saved.kind,received_state:'refund_pending' as const,remedy:'refund' as const,legacy:saved.legacy,acceptance_kind:'physical' as const,received_at:saved.received_at,refund_amount_minor:minor(saved.refund_amount),refunded_shipping_minor:minor(saved.refunded_shipping),items:items.map(item=>({item_id:item.item_id,accepted:minor(item.accepted),restocked:minor(item.restocked),refund_amount_minor:minor(item.refund_amount)}))};
 return b2bNativeReturnFinancialSchema.parse({...f,native_proof:{kind:'catalog_stock_return169',receipt_id:g.receipt.id,admission_id:ad.id,receipt_snapshot_hash:b2bCorrectionHash(g.receipt.snapshot),financial_hash:b2bCorrectionHash(f)}});
}
async function load(c:PoolClient,a:B2bFa3NativeActor,b:z.infer<typeof b2bCorrectionSourceInput>){
 await nativeAccess(c,a);const invoice=await originalInTx(c,a,b.document_id),order=invoice.original.document.order_id;
 // Genuine own order/source locks serialize native requested/receive/refund paths.
 ensure((await c.query('SELECT id FROM orders WHERE(tenant_id,id)=($1,$2) FOR SHARE',[a.tenantId,order])).rowCount,404,'Brak własnego rodzica FV');
 ensure((await c.query('SELECT id FROM return_cases WHERE(tenant_id,order_id,id)=($1,$2,$3)',[a.tenantId,order,b.return_id])).rowCount,404,'Brak własnego RMA tejFV');
 const {fa3DraftOwnerInTx}=await import('./fa3-draft-access');
 const graph=await fa3DraftOwnerInTx(c,async()=>{
  const financialInstalled=await financialReturn162AvailableInTx(c);
  const commercial=(await c.query('SELECT id,quantity::text quantity,line_total::text gross,vat::text vat FROM order_items WHERE(tenant_id,order_id)=($1,$2) ORDER BY id LIMIT 101 FOR SHARE',[a.tenantId,order])).rows;
  const frozen=invoice.original.document.data.fiscal_snapshot.lines.filter(l=>l.kind==='item');
  ensure(commercial.length===frozen.length&&commercial.every(i=>frozen.some(l=>l.source_item_id===i.id&&l.quantity===i.quantity&&l.gross_minor===i.gross&&(l.vat_code==='0 KR'?'0':l.vat_code)===i.vat)),409,'Zmieniło się natywne commercial allocation źródło pierwotnejFV');
  // Only the exact installed typed160 family can supply previous corrections.
  // Legacy/external/unknown modes remain refused; own current insertion is not a historical credit.
  await c.query('SELECT public.b2b_credit_require($1,$2,$3,false,false)',[a.userId,a.apiKeyId??null,(await import('./fa3-draft-source')).b2bFa3NativeIdentityHash(a)]);
  ensure(!(await c.query(`SELECT 1 FROM documents d WHERE(d.tenant_id,d.order_id)=($1,$2) AND d.kind='correction' AND(d.mode<>'b2b_correction' OR NOT EXISTS(SELECT FROM b2b_credit_receipts r WHERE(r.tenant_id,r.document_id,r.original_document_id)=(d.tenant_id,d.id,$3)))
   UNION ALL SELECT 1 FROM invoice_plans WHERE(tenant_id,order_id)=($1,$2) AND kind='correction' AND state NOT IN('preview','cancelled') LIMIT 1`,[a.tenantId,order,b.document_id])).rowCount,409,'Obca/legacy korekta wymaga osobnego protokołu');
  const credits=(await c.query(`SELECT to_jsonb(d) document,to_jsonb(r) receipt,to_jsonb(p) preview,to_jsonb(ad) admission FROM b2b_credit_receipts r
   JOIN documents d ON(d.tenant_id,d.id)=(r.tenant_id,r.document_id)
   JOIN b2b_credit_previews p ON(p.tenant_id,p.id)=(r.tenant_id,r.preview_id)
   JOIN b2b_credit_admissions ad ON(ad.tenant_id,ad.id)=(r.tenant_id,r.id)
   WHERE(r.tenant_id,r.original_document_id)=($1,$2) AND NOT(r.root_xid=pg_current_xact_id() AND r.transaction_started_at=transaction_timestamp() AND r.backend_pid=pg_backend_pid())
   ORDER BY r.receipt_sequence,r.id LIMIT 1001`,[a.tenantId,b.document_id])).rows;
  ensure(credits.length<=1000,413,'Pełny łańcuch korekt przekracza1000');
  for(const g of credits)await c.query('SELECT public.b2b_credit_previous($1)',[g.document.id]);
  const previous:B2bPreviousCredit[]=credits.map(g=>{const d=g.document,r=g.receipt,p=g.preview,ad=g.admission;
   ensure(d.kind==='correction'&&d.mode==='b2b_correction'&&d.return_id===r.return_id&&d.order_id===order&&r.original_document_id===b.document_id&&r.original_receipt_id===invoice.original.receipt.id&&r.return_receipt_id===p.return_receipt_id&&same(d.data,r.snapshot)&&same(p.snapshot,omit(d.data,['number','year','sequence','preview_id','scope_hash']))&&ad.document_id===d.id&&ad.preview_id===p.id&&ad.id===r.id&&same(ad.request,r.request)&&ad.root_xid===r.root_xid&&ad.transaction_started_at===r.transaction_started_at,503,'Niepełny własny historical credit160');
   ensure(r.previous_receipt_id===(credits.indexOf(g)>0?credits[credits.indexOf(g)-1].receipt.id:null)&&r.calculation_hash===b2bCorrectionHash(d.data.calculation),503,'Obcy/spliced typed previous credit');
   return {document_id:d.id,receipt_id:r.id,original_document_id:r.original_document_id,original_receipt_id:r.original_receipt_id,return_id:r.return_id,return_receipt_id:r.return_receipt_id??r.financial_return_receipt_id,receipt_sequence:r.receipt_sequence,calculation:d.data.calculation,calculation_hash:r.calculation_hash};});
  budget(credits);
  const heads=(await c.query('SELECT id FROM return_cases WHERE(tenant_id,order_id)=($1,$2) AND(received_at IS NOT NULL OR receipt_sequence>0) ORDER BY receipt_sequence,id LIMIT 1001 FOR SHARE',[a.tenantId,order])).rows;
  ensure(heads.length<=1000,413,'Niepełna/nadmierna historia przyjęć');
  ensure(heads.length>0,409,'Brak zakończonego przyjęcia do korekty');
  // A true partner acceptance has no physical timestamp. Refuse before collection.
  ensure(!(await c.query("SELECT 1 FROM return_cases rc WHERE(rc.tenant_id,rc.order_id)=($1,$2) AND rc.received_at IS NULL AND public.b2b_dropship_return_acceptance(rc.id) IS NOT NULL LIMIT 1",[a.tenantId,order])).rowCount,409,'Partner credit wymaga własnego accepted financial validator');
  const bytes=one((await c.query(`SELECT coalesce(sum(coalesce(octet_length(to_jsonb(r)::text),0)+coalesce(octet_length(to_jsonb(a)::text),0)+coalesce(octet_length(to_jsonb(ea)::text),0)+coalesce(octet_length(to_jsonb(e)::text),0)${financialInstalled?'+coalesce(octet_length(to_jsonb(fr)::text),0)+coalesce(octet_length(to_jsonb(fa)::text),0)':''}),0)::text bytes
   FROM return_cases rc ${financialInstalled?`LEFT JOIN financial_return_receipts fr ON(fr.tenant_id,fr.return_id)=(rc.tenant_id,rc.id)
   LEFT JOIN financial_return_admissions fa ON(fa.tenant_id,fa.id)=(fr.tenant_id,fr.id)`:''}
   LEFT JOIN catalog_stock_return_receipts r ON(r.tenant_id,r.return_id)=(rc.tenant_id,rc.id)
   LEFT JOIN catalog_stock_return_admissions a ON(a.tenant_id,a.id)=(r.tenant_id,r.id)
   LEFT JOIN catalog_stock_control_effect_admissions ea ON(ea.tenant_id,ea.id)=(a.tenant_id,a.id)
   LEFT JOIN catalog_stock_control_effects e ON(e.tenant_id,e.admission_id)=(ea.tenant_id,ea.id)
   WHERE rc.tenant_id=$1 AND rc.id=ANY($2::uuid[])`,[a.tenantId,heads.map(r=>r.id)])).rows);
  ensure(BigInt(bytes.bytes)<=BigInt(MAX_BYTES),413,'Pełny native169 graph przekracza32MiB');
  const rows=(await c.query(`SELECT to_jsonb(rc) current_case,${financialInstalled?`to_jsonb(fr) financial_receipt,to_jsonb(fa) financial_admission,
   (fa.root_xid=pg_current_xact_id() AND fa.transaction_started_at=transaction_timestamp() AND fa.backend_pid=pg_backend_pid()) financial_current,`:'NULL::jsonb financial_receipt,NULL::jsonb financial_admission,NULL::boolean financial_current,'}
   to_jsonb(r) receipt,to_jsonb(a) admission,to_jsonb(ea) effect_admission,to_jsonb(e) effect,(a.txid=pg_current_xact_id() AND r.created_at=transaction_timestamp()) current_admission,
   (SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY item_id),'[]') FROM return_items i WHERE(i.tenant_id,i.return_id)=(rc.tenant_id,rc.id)) items,
   (SELECT to_jsonb(op) FROM wms_operations op WHERE(op.tenant_id,op.id)=(r.tenant_id,r.wms_operation_id)) operation,
   (SELECT coalesce(jsonb_agg(jsonb_build_object('kind',j.kind,'journal_id',j.journal_id,'actual',CASE j.kind WHEN 'stock' THEN(SELECT to_jsonb(m) FROM stock_movements m WHERE(m.tenant_id,m.id)=(j.tenant_id,j.stock_movement_id)) WHEN 'bin' THEN(SELECT to_jsonb(m) FROM stock_location_movements m WHERE(m.tenant_id,m.id)=(j.tenant_id,j.location_movement_id)) ELSE(SELECT to_jsonb(m) FROM wms_layer_movements m WHERE(m.tenant_id,m.id)=(j.tenant_id,j.layer_movement_id)) END) ORDER BY j.kind,j.journal_id),'[]') FROM catalog_stock_control_effect_journals j WHERE(j.tenant_id,j.admission_id)=(r.tenant_id,r.id)) journals
   FROM return_cases rc ${financialInstalled?`LEFT JOIN financial_return_receipts fr ON(fr.tenant_id,fr.return_id)=(rc.tenant_id,rc.id)
   LEFT JOIN financial_return_admissions fa ON(fa.tenant_id,fa.id)=(fr.tenant_id,fr.id)`:''}
   LEFT JOIN catalog_stock_return_receipts r ON(r.tenant_id,r.return_id)=(rc.tenant_id,rc.id)
   LEFT JOIN catalog_stock_return_admissions a ON(a.tenant_id,a.id)=(r.tenant_id,r.id)
   LEFT JOIN catalog_stock_control_effect_admissions ea ON(ea.tenant_id,ea.id)=(a.tenant_id,a.id)
   LEFT JOIN catalog_stock_control_effects e ON(e.tenant_id,e.admission_id)=(ea.tenant_id,ea.id)
   WHERE rc.tenant_id=$1 AND rc.id=ANY($2::uuid[]) ORDER BY rc.receipt_sequence,rc.id`,[a.tenantId,heads.map(r=>r.id)])).rows;
  ensure(rows.length===heads.length&&rows.every(r=>(r.receipt&&r.admission&&r.effect_admission&&r.effect&&!r.financial_receipt&&!r.financial_admission)||(!r.receipt&&!r.admission&&!r.effect_admission&&!r.effect&&r.financial_receipt&&r.financial_admission)),409,'Incomplete/conflicting complete native169/162 history; no retrofit');
  for(const r of rows)if(r.financial_receipt){
   ensure(r.financial_receipt.original_document_id===b.document_id&&r.financial_receipt.original_receipt_id===invoice.original.receipt.id,503,'Foreign financial original159');
   await c.query('SELECT public.financial_return_credit_parent($1,$2,NULL,$3)',[b.document_id,r.current_case.id,r.financial_receipt.id]);
  }
  budget(rows);return {rows,previous,credits};
 });
 const acceptances=graph.rows.map(financial),input:B2bCorrectionInput={original:invoice.original,acceptance_manifest:{count:acceptances.length,financial_history_hash:b2bCorrectionHash(acceptances)},acceptances,previous_credits:graph.previous,selected_return_id:b.return_id,shipping_credit_scope:'native_refunded_shipping_value_only'};
 const private_basis={invoice:invoice.raw,returns:graph.rows,credits:graph.credits};budget(private_basis);
 const arithmetic=calculateB2bInvoiceCorrection(input);return {input,arithmetic,private_basis};
}
declare const brand:unique symbol;
export type B2bCorrectionSourceHandle=Readonly<{[brand]:true}>;
type State={c:PoolClient;a:B2bFa3NativeActor;context:Context;request:z.infer<typeof b2bCorrectionSourceInput>;source:Awaited<ReturnType<typeof load>>};
const custody=new WeakMap<B2bCorrectionSourceHandle,State>();
export async function prepareB2bCorrectionHistoryInTx(c:PoolClient,a:B2bFa3NativeActor,request:unknown):Promise<B2bCorrectionSourceHandle>{
 const b=b2bCorrectionSourceInput.parse(request),ctx=await context(c,a),source=await load(c,a,b),token=Object.freeze({}) as B2bCorrectionSourceHandle;
 custody.set(token,{c,a,context:ctx,request:b,source});return token;
}
/** Internal RAM candidate BEFORE an actual managed terminal hook. Not an issue
 * grant or a client DTO. No serializer may publish this as an authorized preview. */
export async function claimB2bCorrectionHistoryCandidateInTx(c:PoolClient,a:B2bFa3NativeActor,t:B2bCorrectionSourceHandle){
 const s=custody.get(t);ensure(s&&s.c===c&&s.a===a,403,'Obcy klient/actor/history handle');const now=await context(c,a);
 ensure(s.context.root===now.root&&s.context.started===now.started&&s.context.pid===now.pid,409,'Inna transakcja źródła korekty');
 const fresh=await load(c,a,s.request);ensure(same(fresh,s.source),409,'Zmienił się cały natywny financial graph');
 return {state:'historical_source_candidate_not_an_issue_admission' as const,input:structuredClone(fresh.input),...structuredClone(fresh.arithmetic)};
}
/** Rollback-only idempotent revocation: no SQL, no number, no private row. */
export function discardB2bCorrectionHistory(c:PoolClient,a:B2bFa3NativeActor,t:B2bCorrectionSourceHandle){const s=custody.get(t);if(s)ensure(s.c===c&&s.a===a,403,'Obcy rollback collector');custody.delete(t);}
