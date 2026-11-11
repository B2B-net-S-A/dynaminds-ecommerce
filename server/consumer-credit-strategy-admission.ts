/** Admission for the ordinary legacy HTTP writers, not Native/IAM authority.
 * Called inside their existing authenticated tenant transaction and owner scope.
 * Historical SQL188 stays literal; exact original replays remain native reads. */
import type {PoolClient} from 'pg';
import {isDeepStrictEqual} from 'node:util';
import {ensure} from './errors';
import {localInvoiceRequestHash,type LocalInvoiceActor} from './local-invoice-values';

export async function assertLegacyConsumerCreditWriteAdmission(
 c:Pick<PoolClient,'query'>,a:LocalInvoiceActor,operation:'preview'|'issue',resourceId:string,
 body:{client_key:string},
):Promise<void>{
 ensure(operation==='preview'||operation==='issue',422,'Nieznana operacja korekty');
 const context=(await c.query("SELECT session_user owner,current_user role,current_setting('app.tenant_id',true) tenant")).rows[0];
 ensure(context?.owner==='postgres'&&context.role==='postgres'&&context.tenant===a.tenantId,403,'Nieprawidłowy kontekst korekty');
 // Preserve Native188's lock order; then serialize against receive148 on the order.
 await c.query('SELECT public.local_invoice_locks()');
 const target=operation==='preview'
  ?await c.query("SELECT d.order_id FROM public.documents d JOIN public.local_invoice_receipts r ON(r.tenant_id,r.document_id)=(d.tenant_id,d.id) WHERE(d.tenant_id,d.id)=($1,$2) AND d.kind='invoice' AND d.mode='local_invoice'",[a.tenantId,resourceId])
  :await c.query('SELECT order_id FROM public.local_consumer_credit_previews WHERE(tenant_id,id)=($1,$2)',[a.tenantId,resourceId]);
 ensure(target.rows.length===1,404,'Nie znaleziono własnego źródła korekty');
 const orderId=target.rows[0].order_id;
 ensure((await c.query('SELECT id FROM public.orders WHERE(tenant_id,id)=($1,$2) FOR UPDATE',[a.tenantId,orderId])).rows.length===1,404,'Nie znaleziono własnego zamówienia');
 const table=operation==='preview'?'local_consumer_credit_previews':'local_consumer_credit_receipts';
 const originals=(await c.query(`SELECT * FROM public.${table} WHERE(tenant_id,client_key)=($1,$2)`,[a.tenantId,body.client_key])).rows;
 ensure(originals.length<=1,503,'Niepełna historia oryginalnej operacji');
 if(originals.length){
  const original=originals[0],resource=operation==='preview'?original.original_document_id:original.preview_id;
  const hash=localInvoiceRequestHash(a.tenantId,a.userId,a.apiKeyId??null,'consumer-credit-'+operation,resourceId,body);
  ensure(resource===resourceId&&original.order_id===orderId&&original.actor_id===a.userId&&
   (original.api_key_id??null)===(a.apiKeyId??null)&&original.request_hash===hash&&isDeepStrictEqual(original.request,body),409,'Oryginalny klucz korekty ma inne dane');
  return;
 }
 // The private148 admission table is itself a trusted family marker. Include
 // incomplete evidence conservatively; never require received_at/169, since a
 // genuine all-rejected inspection has neither. No dependency on installed207.
 const destination=(await c.query('SELECT EXISTS(SELECT FROM public.return_destination_admissions WHERE(tenant_id,order_id)=($1,$2)) present',[a.tenantId,orderId])).rows[0];
 ensure(destination&&typeof destination.present==='boolean',503,'Nie można potwierdzić historii zwrotu');
 ensure(!destination.present,409,'Historia zwrotu wymaga procesu korekty do zwrotu konsumenckiego');
}
