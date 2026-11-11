/** Current manual-session authority for Mirakl. Import-inert: no pool, HTTP,
 * credentials, provider impersonation, or owner DML. Private auth tables are read
 * only on the actual controlled transaction client; identity pins survive until
 * its COMMIT/ROLLBACK. Ordinary tenant role is restored even on refusal. */
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {ensure,Problem} from './errors';
import {requireWorkspaceMfa} from './mfa-policy';
import type {MiraklReadActor} from './mirakl-read-routes';

export type MiraklSessionSecurity=Readonly<{accountSecurityAvailable:boolean;
 workspaceMfaPolicyAvailable:boolean;readOnly:boolean}>;
type Frame=Readonly<{actor:MiraklReadActor;security:MiraklSessionSecurity}>;
type State={frames:Frame[];prepared:boolean;completed:boolean};
const transactions=new WeakMap<PoolClient,State>();
/** Presence only; never authorization, admission or transaction readiness. */
export function hasMiraklSessionTransactionDuty(c:PoolClient){return Boolean(transactions.get(c)?.frames.length);}
const actorSchema=z.strictObject({tenantId:z.uuid(),userId:z.uuid(),sessionHash:z.string().regex(/^[a-f0-9]{64}$/)});
const securitySchema=z.strictObject({accountSecurityAvailable:z.boolean(),workspaceMfaPolicyAvailable:z.boolean(),readOnly:z.boolean()});
function frame(actor:MiraklReadActor,security:MiraklSessionSecurity):Frame{
 const a=Object.freeze(actorSchema.parse(actor)),s=Object.freeze(securitySchema.parse(security));
 ensure(!s.readOnly,423,'Mirakl: odczyty dostawcy wyłączone w podglądzie kopii');
 return Object.freeze({actor:a,security:s});
}
export function beginMiraklSessionAuthorityTransaction(c:PoolClient){
 ensure(!transactions.has(c),500,'Mirakl: kontekst transakcji już istnieje');
 transactions.set(c,{frames:[],prepared:false,completed:false});
}
export function endMiraklSessionAuthorityTransaction(c:PoolClient){transactions.delete(c);}
export function enlistMiraklSessionAuthorityInTx(c:PoolClient,actor:MiraklReadActor,security:MiraklSessionSecurity){
 const s=transactions.get(c);ensure(s&&!s.prepared&&!s.completed,500,'Mirakl: brak otwartej zarządzanej transakcji');
 const f=frame(actor,security);
 ensure(s.frames.every(x=>x.actor.tenantId===f.actor.tenantId),403,'Mirakl: zgody dotyczą różnych organizacji');
 s.frames.push(f);
}
async function owner<T>(c:PoolClient,tenantId:string,read:()=>Promise<T>,freshSnapshot=false):Promise<T>{
 const ctx=(await c.query(`SELECT current_user AS role,session_user AS owner,
  current_setting('app.tenant_id',true) AS tenant,current_setting('transaction_isolation') AS isolation`)).rows[0];
 ensure(ctx?.owner==='postgres'&&ctx.role==='dyna_app'&&ctx.tenant===tenantId,
 403,'Mirakl: nieprawidłowy kontekst transakcji');
 ensure(!freshSnapshot||ctx.isolation==='read committed',503,'Mirakl: końcowa autoryzacja wymaga bieżącego obrazu transakcji');
 let failed=false;
 try{await c.query('RESET ROLE');return await read();}
 catch(e){failed=true;if(e instanceof Problem)throw e;
  const code=(e as {code?:unknown})?.code;
  if(code==='55P03')throw new Problem(409,'Mirakl: uprawnienia są obecnie zmieniane; lokalny zapis wstrzymano','MIRAKL_SESSION_SOURCE_BUSY');
  if(['55000','42P01','42703','42883','42501'].includes(typeof code==='string'?code:''))
   throw new Problem(503,'Mirakl: moduł autoryzacji jest niekompletny');
  throw e;
 }finally{
  if(failed){try{await c.query('SET LOCAL ROLE dyna_app');}catch{/* SQL failure: caller rolls back. */}}
  else await c.query('SET LOCAL ROLE dyna_app');
 }
}
async function securityGraph(c:PoolClient,f:Frame){
 const p=(await c.query(`SELECT to_regclass('public.account_security') IS NOT NULL AS account,
  to_regclass('public.workspace_security_policies') IS NOT NULL AS mfa,
  EXISTS(SELECT 1 FROM public.migrations WHERE name='051_account_security') AS account_ledger,
  EXISTS(SELECT 1 FROM public.migrations WHERE name='057_workspace_mfa') AS mfa_ledger`)).rows[0];
 const s=f.security;
 ensure(p.account===s.accountSecurityAvailable&&p.mfa===s.workspaceMfaPolicyAvailable
  &&(!p.account_ledger||p.account)&&(!p.mfa_ledger||(p.mfa&&p.account))
  &&(!s.workspaceMfaPolicyAvailable||s.accountSecurityAvailable),503,
 'Mirakl: moduł autoryzacji zmienił się lub jest niekompletny');
}
async function currentIdentity(c:PoolClient,f:Frame,clock:string){
 const {actor:a,security:s}=f;
 const account=s.accountSecurityAvailable?'LEFT JOIN public.account_security a ON a.user_id=u.id':'';
 const policy=s.workspaceMfaPolicyAvailable?'LEFT JOIN public.workspace_security_policies p ON p.tenant_id=t.id':'';
 const current=(await c.query(`SELECT m.role${s.workspaceMfaPolicyAvailable
  ?`,coalesce(p.require_mfa,false) AND NOT(a.enabled_at IS NOT NULL
    AND s.mfa_verified_at IS NOT NULL AND s.mfa_verified_at>$4::timestamptz-interval '8 hours') AS mfa_required`:''}
  FROM public.sessions s JOIN public.users u ON u.id=s.user_id
  JOIN public.tenants t ON t.id=s.tenant_id ${account} ${policy}
  LEFT JOIN public.memberships m ON (m.tenant_id,m.user_id)=(s.tenant_id,s.user_id)
  WHERE s.token_hash=$1 AND s.user_id=$2 AND s.tenant_id=$3 AND s.expires_at>$4::timestamptz
  ${s.accountSecurityAvailable?'AND s.account_version=coalesce(a.version,0)':''}`,
 [a.sessionHash,a.userId,a.tenantId,clock])).rows[0];
 ensure(current,401,'Mirakl: sesja wygasła lub została unieważniona');
 ensure(current.role==='admin',403,'Mirakl: wymagana aktualna rola administratora');
 requireWorkspaceMfa(current);
}
/** Unlocked guard for short current-channel reads. Never substitutes terminal pins. */
export async function assertMiraklSessionAuthorityInTx(c:PoolClient,actor:MiraklReadActor,security:MiraklSessionSecurity){
 const f=frame(actor,security);
 await owner(c,f.actor.tenantId,async()=>{
  await securityGraph(c,f);
  const clock=(await c.query('SELECT clock_timestamp()::text AS checked_at')).rows[0].checked_at;
  await currentIdentity(c,f,clock);
 });
}
/** Before sibling final deadline clocks. Native writers lock users/tenants to
 * protect absent account/policy rows. Class-wise order and NOWAIT prevent cycles
 * against already held channel locks. A busy identity refuses local commit. */
export async function prepareMiraklSessionAuthoritiesInTx(c:PoolClient){
 const s=transactions.get(c);ensure(s&&!s.prepared&&!s.completed,500,'Mirakl: brak otwartego kontekstu autoryzacji');
 s.prepared=true;if(!s.frames.length)return;
 const frames=[...s.frames].sort((a,b)=>a.actor.userId.localeCompare(b.actor.userId)||a.actor.sessionHash.localeCompare(b.actor.sessionHash));
 await owner(c,frames[0].actor.tenantId,async()=>{
  for(const f of frames)await securityGraph(c,f);
  const users=[...new Set(frames.map(f=>f.actor.userId))].sort();
  const tenants=[...new Set(frames.map(f=>f.actor.tenantId))].sort();
  for(const id of users)ensure((await c.query('SELECT id FROM public.users WHERE id=$1 FOR SHARE NOWAIT',[id])).rowCount,401,'Mirakl: konto nie istnieje');
  for(const {actor:a} of [...frames].sort((a,b)=>a.actor.sessionHash.localeCompare(b.actor.sessionHash)))
   ensure((await c.query('SELECT token_hash FROM public.sessions WHERE token_hash=$1 AND user_id=$2 AND tenant_id=$3 FOR SHARE NOWAIT',
   [a.sessionHash,a.userId,a.tenantId])).rowCount,401,'Mirakl: sesja wygasła');
  for(const id of tenants)ensure((await c.query('SELECT id FROM public.tenants WHERE id=$1 FOR SHARE NOWAIT',[id])).rowCount,403,'Mirakl: brak organizacji');
  for(const id of [...new Set(frames.filter(f=>f.security.accountSecurityAvailable).map(f=>f.actor.userId))].sort())
   await c.query('SELECT user_id FROM public.account_security WHERE user_id=$1 FOR SHARE NOWAIT',[id]);
  for(const id of [...new Set(frames.filter(f=>f.security.workspaceMfaPolicyAvailable).map(f=>f.actor.tenantId))].sort())
   await c.query('SELECT tenant_id FROM public.workspace_security_policies WHERE tenant_id=$1 FOR SHARE NOWAIT',[id]);
  for(const {actor:a} of frames)await c.query('SELECT role FROM public.memberships WHERE tenant_id=$1 AND user_id=$2 FOR SHARE NOWAIT',[a.tenantId,a.userId]);
 },true);
}
/** After all sibling waits, immediately before COMMIT/ACK. No new row locks. */
export async function finalizeMiraklSessionAuthoritiesInTx(c:PoolClient){
 const s=transactions.get(c);ensure(s&&s.prepared&&!s.completed,500,'Mirakl: brak przygotowanej końcowej autoryzacji');
 s.completed=true;if(!s.frames.length)return;
 await owner(c,s.frames[0].actor.tenantId,async()=>{
  for(const f of s.frames)await securityGraph(c,f);
  const clock=(await c.query('SELECT clock_timestamp()::text AS checked_at')).rows[0].checked_at;
  for(const f of s.frames)await currentIdentity(c,f,clock);
 },true);
}
