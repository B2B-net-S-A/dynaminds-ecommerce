// Server-only durable barrier. No response token, auth cookie or request body is persisted.
import type { PoolClient } from 'pg';
import { randomUUID, createHash } from 'node:crypto';
import { pool, tenantTx } from './db';
import { ensure, Problem } from './errors';
import { assertAllegroAuthorityBinding, assertAllegroAuthorityInTx,
 enlistAllegroAuthorityInTx, allegroAuthorityIsJob, pinAllegroJobSourceInTx,
 allegroOAuthCommitRefusal, allegroAuthorityRecoveryIdentity,
 type AllegroOAuthAuthority } from './allegro-oauth-authority';

type Channel = { id: string; tenant_id: string; provider: string; mode: string;
 credentials: string; settings: Record<string, unknown> };
declare const attemptBrand: unique symbol;
export type AllegroRecoveryAttempt = Readonly<{ [attemptBrand]: true }>;
type Frame = { id: string; channel: Channel; authority: AllegroOAuthAuthority;
 grant: 'refresh_token'|'authorization_code' };
const custody = new WeakMap<AllegroRecoveryAttempt, Frame>();
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
function owned(a: AllegroRecoveryAttempt) { const f=custody.get(a); ensure(f,403,'Brak prywatnej zgody odzyskiwania OAuth'); return f; }
async function owner<T>(c: PoolClient, tenant: string, fn:()=>Promise<T>):Promise<T> {
 const context=(await c.query("SELECT current_user role,session_user owner,current_setting('app.tenant_id',true) tenant")).rows[0];
 ensure(context.owner==='postgres' && ['postgres','dyna_app'].includes(context.role) && context.tenant===tenant,
 403,'Nieprawidłowy kontekst odzyskiwania OAuth');
 const switched=context.role==='dyna_app'; let failed=false;
 try { if(switched) await c.query('RESET ROLE'); await c.query('SELECT public.allegro_oauth_recovery_require()'); return await fn(); }
 catch(e) { failed=true; if(e instanceof Problem) throw e;
  if(['55000','42P01','42703','42883','42501'].includes((e as {code?:string})?.code??''))
   throw new Problem(503,'Niekompletny moduł odzyskiwania OAuth Allegro'); throw e;
 } finally { if(switched) { if(failed) await c.query('SET LOCAL ROLE dyna_app').catch(()=>{}); else await c.query('SET LOCAL ROLE dyna_app'); } }
}
function refusal(f:Frame, message:string) {
 return allegroOAuthCommitRefusal(new Problem(503,message,'ALLEGRO_OAUTH_RECOVERY_REQUIRED'),
 {tenantId:f.channel.tenant_id,channelId:f.channel.id,
 connectionId:(f.channel.settings.oauth_connection_id as string|undefined)??null},f.authority);
}
async function enlist(c:PoolClient,f:Frame) {
 assertAllegroAuthorityBinding(f.authority,f.channel.tenant_id,f.channel.id);
 await assertAllegroAuthorityInTx(c,f.authority,f.channel.id);
 enlistAllegroAuthorityInTx(c,f.authority);
 if(allegroAuthorityIsJob(f.authority)) await pinAllegroJobSourceInTx(c,f.authority,f.channel.id);
}
/** Commit BEFORE tokens transport. Failure/unknown COMMIT acknowledgement means no HTTP. */
export async function beginAllegroRecovery(ch:Channel,authority:AllegroOAuthAuthority,
 grant:Frame['grant']):Promise<AllegroRecoveryAttempt> {
 const f:Frame={id:randomUUID(),channel:{...ch,settings:{...ch.settings}},authority,grant};
 await tenantTx(ch.tenant_id,async c=>{
  await enlist(c,f);
  await owner(c,ch.tenant_id,async()=>{
   const current=(await c.query('SELECT * FROM public.channels WHERE tenant_id=$1 AND id=$2 FOR NO KEY UPDATE',
    [ch.tenant_id,ch.id])).rows[0];
   ensure(current && current.provider==='allegro' && current.mode===ch.mode && !current.settings.simulation
    && (current.settings.oauth_connection_id??null)===(ch.settings.oauth_connection_id??null),409,
    'Połączenie Allegro zmieniło się przed zgłoszeniem');
   if(grant==='refresh_token') {
    ensure(current.credentials===ch.credentials,409,'Połączenie Allegro zmieniło się przed odświeżaniem');
    const pending=await c.query("SELECT id FROM public.allegro_oauth_recovery_attempts WHERE tenant_id=$1 AND channel_id=$2 "
     +"AND grant_type='refresh_token' AND state IN ('may_have_been_sent','refused') AND connection_id IS NOT DISTINCT FROM $3::uuid LIMIT 1",[ch.tenant_id,ch.id,current.settings.oauth_connection_id??null]);
    if(pending.rowCount) throw refusal(f,'Poprzednie zgłoszenie tokenów ma niepewny wynik; połącz konto ponownie');
   }
   const identity=allegroAuthorityRecoveryIdentity(authority,ch.tenant_id,ch.id);
   await c.query("INSERT INTO public.allegro_oauth_recovery_attempts(id,tenant_id,channel_id,actor_id,actor_kind,job_id,grant_type,mode,connection_id,credentials_hash,state) "
    +"VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'may_have_been_sent')",[f.id,ch.tenant_id,ch.id,
    identity.userId,identity.kind,identity.jobId,grant,ch.mode,current.settings.oauth_connection_id??null,hash(current.credentials)]);
  });
 });
 const token=Object.freeze({}) as AllegroRecoveryAttempt; custody.set(token,f); return token;
}
/** AFTER channel CAS, BEFORE existing final native IAM/clock/COMMIT. */
export async function commitAllegroRecoveryInTx(c:PoolClient,a:AllegroRecoveryAttempt) {
 const f=owned(a);
 await owner(c,f.channel.tenant_id,async()=>{
  const ch=(await c.query('SELECT credentials,settings FROM public.channels WHERE tenant_id=$1 AND id=$2',
   [f.channel.tenant_id,f.channel.id])).rows[0]; ensure(ch,409,'Źródło zapisu OAuth nie istnieje');
  const result=await c.query("UPDATE public.allegro_oauth_recovery_attempts SET state='committed',finished_at=clock_timestamp(),finished_xid=pg_current_xact_id(),"
   +"result_connection_id=$4,result_credentials_hash=$5,refusal_code=NULL WHERE tenant_id=$1 AND channel_id=$2 AND id=$3 AND state='may_have_been_sent'",
   [f.channel.tenant_id,f.channel.id,f.id,ch.settings.oauth_connection_id??null,hash(ch.credentials)]);
  ensure(result.rowCount===1,409,'Zgłoszenie OAuth zostało zamknięte lub zastąpione');
  if(f.grant==='authorization_code') await c.query("UPDATE public.allegro_oauth_recovery_attempts SET state='superseded',finished_at=clock_timestamp(),finished_xid=pg_current_xact_id(),"
   +"result_connection_id=$4,result_credentials_hash=NULL WHERE tenant_id=$1 AND channel_id=$2 AND id<>$3 AND state IN ('may_have_been_sent','refused') AND connection_id IS NOT DISTINCT FROM $5::uuid",
   [f.channel.tenant_id,f.channel.id,f.id,ch.settings.oauth_connection_id,(f.channel.settings.oauth_connection_id as string|undefined)??null]);
 });
}
/** Best-effort classification only. Pre-send row is already the durable barrier. */
export async function refuseAllegroRecovery(a:AllegroRecoveryAttempt,code:'response_unknown'|'local_commit_refused') {
 const f=owned(a),c=await pool.connect();
 try {
  await c.query('BEGIN'); await c.query("SELECT set_config('app.tenant_id',$1,true)",[f.channel.tenant_id]);
  await c.query("SET LOCAL statement_timeout='8s'");
  await owner(c,f.channel.tenant_id,async()=>{
   await c.query("UPDATE public.allegro_oauth_recovery_attempts SET state='refused',finished_at=clock_timestamp(),finished_xid=pg_current_xact_id(),refusal_code=$4"
    +" WHERE tenant_id=$1 AND channel_id=$2 AND id=$3 AND state='may_have_been_sent'",[f.channel.tenant_id,f.channel.id,f.id,code]);
  });
  await c.query('COMMIT');
 } catch { await c.query('ROLLBACK').catch(()=>{}); /* durable may-have-sent entry is never deleted */ }
 finally { c.release(); }
}
export function allegroRecoveryRequired(a:AllegroRecoveryAttempt) {
 return refusal(owned(a),'Wynik zgłoszenia tokenów Allegro wymaga ponownego połączenia; automatyczne ponowienie zatrzymano');
}
