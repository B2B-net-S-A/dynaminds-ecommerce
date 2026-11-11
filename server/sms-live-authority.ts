import type{PoolClient}from'pg';
import{createHash}from'node:crypto';
import{DeliveryRefusal}from'./sms-delivery';
type Client=Pick<PoolClient,'query'>;
export type LiveAuthority={tenantId:string;userId:string;sessionHash:string};
export function smsLiveRequestAuthority(req:any,sessionName:string):LiveAuthority{
 if(req.actor?.role!=='admin'||req.actor.source==='api'||req.actor.apiKeyId)throw new DeliveryRefusal(403);
 const token=req.cookies?.[sessionName]??(req.headers?.authorization?.startsWith('Bearer ')?req.headers.authorization.slice(7):null);
 if(!token||token.startsWith('dyna_api'))throw new DeliveryRefusal(403);
 return{tenantId:req.actor.tenantId,userId:req.actor.userId,sessionHash:createHash('sha256').update(token).digest('hex')};
}
// Authentication pool, NOT the tenant SQL role (sessions/account_security are private).
// MFA is mandatory for live sends even if the workspace has not required it for other operations.
export async function requireSmsLiveAuthority(auth:Client,a:LiveAuthority){
 const r=await auth.query(`SELECT s.user_id FROM sessions s JOIN memberships m ON(m.tenant_id,m.user_id)=(s.tenant_id,s.user_id)
  JOIN account_security sec ON sec.user_id=s.user_id WHERE s.token_hash=$1 AND s.tenant_id=$2 AND s.user_id=$3
  AND s.expires_at>now() AND s.account_version=sec.version AND m.role='admin'
  AND sec.enabled_at IS NOT NULL AND s.mfa_verified_at>now()-interval '8 hours'`,[a.sessionHash,a.tenantId,a.userId]);
 if(r.rows.length!==1)throw new DeliveryRefusal(403);
}
export async function smsLiveJobAuthority(c:Client,batchId:string):Promise<LiveAuthority>{
 const a=(await c.query('SELECT tenant_id,actor_id,session_hash FROM sms_live_queue_authorities WHERE batch_id=$1',[batchId])).rows[0];
 if(!a)throw new DeliveryRefusal(403);
 return{tenantId:a.tenant_id,userId:a.actor_id,sessionHash:a.session_hash};
}
