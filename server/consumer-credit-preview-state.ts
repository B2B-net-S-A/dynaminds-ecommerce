/** Presentation of a persisted preview, never authorization to execute a write. */
import type {PoolClient} from 'pg';
import {ensure} from './errors';
export function consumerCreditPreviewCanIssue(
 row:{actor_id:string;api_key_id?:string|null;expires_at:Date|string;issued_document_id?:string|null},
 canWrite:boolean,actor:{userId:string;apiKeyId?:string},now=Date.now(),
):boolean{
 return canWrite&&(row.issued_document_id??null)===null&&row.actor_id===actor.userId&&
  (row.api_key_id??null)===(actor.apiKeyId??null)&&new Date(row.expires_at).getTime()>now;
}

/** Native replay returns the immutable preview row. Its issued state lives in
 * the receipt table and must be hydrated for every ordinary response path. */
export async function consumerCreditPreviewIssueState(
 c:Pick<PoolClient,'query'>,family:'legacy'|'destinations',
 row:{id:string;actor_id:string;api_key_id?:string|null;expires_at:Date|string},
 canWrite:boolean,actor:{tenantId:string;userId:string;apiKeyId?:string},
){
 ensure(family==='legacy'||family==='destinations',503,'Nieznana rodzina dokumentu');
 const table=family==='legacy'?'local_consumer_credit_receipts':'return_credit206_receipts';
 const rows=(await c.query(`SELECT document_id FROM public.${table} WHERE(tenant_id,preview_id)=($1,$2)`,[actor.tenantId,row.id])).rows;
 ensure(rows.length<=1&&(!rows.length||typeof rows[0].document_id==='string'),503,'Niepełny stan wystawionego dokumentu');
 const issued_document_id=rows[0]?.document_id??null;
 return{issued_document_id,can_issue:consumerCreditPreviewCanIssue({...row,issued_document_id},canWrite,actor)};
}
