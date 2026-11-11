/** Small actual PostgreSQL authority test. Explicit private local locator only;
 * creates and drops its own metadata-only DB, never boots OMS or edits locator DB. */
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {Pool,type PoolClient} from 'pg';
import {Problem} from '../server/errors';
import {beginMiraklSessionAuthorityTransaction as begin,endMiraklSessionAuthorityTransaction as end,
 enlistMiraklSessionAuthorityInTx as enlist,prepareMiraklSessionAuthoritiesInTx as prepare,
 finalizeMiraklSessionAuthoritiesInTx as finalize,assertMiraklSessionAuthorityInTx as guard} from '../server/mirakl-session-authority';
const locator=process.env.DYNA_MIRAKL_CONTROL_TEST_PRIVATE;
const options={skip:!locator};
const name='dynaminds_mirakl_authority_test_'+Date.now();
const actor=Object.freeze({tenantId:randomUUID(),userId:randomUUID(),sessionHash:createHash('sha256').update(randomUUID()).digest('hex')});
const security=Object.freeze({accountSecurityAvailable:true,workspaceMfaPolicyAvailable:true,readOnly:false});
let admin:Pool,pool:Pool;
before(async()=>{
 if(!locator)return;
 const value=JSON.parse(await readFile(locator,'utf8')),url=new URL(value.databaseUrl);
 assert(['postgres:','postgresql:'].includes(url.protocol));assert(['localhost','127.0.0.1'].includes(url.hostname));
 assert.equal(url.username,'postgres');assert.equal(url.port,'57081');assert.equal(url.search,'');assert.equal(url.hash,'');
 url.pathname='/postgres';admin=new Pool({connectionString:url.href,max:2});
 const r=(await admin.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname='dyna_app'")).rows[0];
 assert(r&&!r.rolsuper&&!r.rolbypassrls,'Existing restricted dyna_app required, no global role writes');
 assert(/^dynaminds_mirakl_authority_test_[0-9]+$/.test(name));await admin.query(`CREATE DATABASE "${name}"`);
 url.pathname='/'+name;pool=new Pool({connectionString:url.href,max:6,options:'-c statement_timeout=5000 -c lock_timeout=1000'});
 await pool.query(`CREATE TABLE migrations(name text PRIMARY KEY);
  CREATE TABLE users(id uuid PRIMARY KEY);CREATE TABLE tenants(id uuid PRIMARY KEY);
  CREATE TABLE memberships(user_id uuid REFERENCES users,tenant_id uuid REFERENCES tenants,role text,PRIMARY KEY(user_id,tenant_id));
  CREATE TABLE sessions(token_hash text PRIMARY KEY,user_id uuid REFERENCES users,tenant_id uuid REFERENCES tenants,
   expires_at timestamptz NOT NULL,account_version bigint NOT NULL,mfa_verified_at timestamptz);
  CREATE TABLE account_security(user_id uuid PRIMARY KEY REFERENCES users,version bigint NOT NULL,enabled_at timestamptz);
  CREATE TABLE workspace_security_policies(tenant_id uuid PRIMARY KEY REFERENCES tenants,require_mfa boolean NOT NULL);
  CREATE TABLE channels(id uuid PRIMARY KEY,tenant_id uuid,status text);CREATE TABLE audit_events(action text);
  REVOKE ALL ON users,sessions,tenants,memberships,account_security,workspace_security_policies,migrations FROM PUBLIC,dyna_app;
  GRANT SELECT,UPDATE ON channels TO dyna_app;GRANT INSERT ON audit_events TO dyna_app;
  INSERT INTO migrations VALUES('051_account_security'),('057_workspace_mfa')`);
 await pool.query('INSERT INTO users VALUES($1)',[actor.userId]);await pool.query('INSERT INTO tenants VALUES($1)',[actor.tenantId]);
 await pool.query("INSERT INTO memberships VALUES($1,$2,'admin')",[actor.userId,actor.tenantId]);
 await pool.query("INSERT INTO sessions VALUES($1,$2,$3,clock_timestamp()+interval '1 hour',0,clock_timestamp())",[actor.sessionHash,actor.userId,actor.tenantId]);
 await pool.query('INSERT INTO account_security VALUES($1,0,clock_timestamp())',[actor.userId]);
 await pool.query('INSERT INTO workspace_security_policies VALUES($1,false)',[actor.tenantId]);
 await pool.query("INSERT INTO channels VALUES($1,$2,'original')",[actor.tenantId,actor.tenantId]);
});
after(async()=>{if(pool)await pool.end();if(admin){if(/^dynaminds_mirakl_authority_test_[0-9]+$/.test(name))await admin.query(`DROP DATABASE IF EXISTS "${name}"`);await admin.end();}});
async function tx(){const c=await pool.connect();await c.query('BEGIN');await c.query('SET LOCAL ROLE dyna_app');
 await c.query("SELECT set_config('app.tenant_id',$1,true)",[actor.tenantId]);begin(c);return c;}
async function close(c:PoolClient){end(c);await c.query('ROLLBACK');c.release();}
const isStatus=(status:number)=>(e:unknown)=>e instanceof Problem&&e.status===status;
async function stage(c:PoolClient){await c.query("UPDATE channels SET status='verified' WHERE id=$1",[actor.tenantId]);await c.query("INSERT INTO audit_events VALUES('integration.test')");enlist(c,actor,security);}
async function unchanged(){assert.equal((await pool.query('SELECT status FROM channels')).rows[0].status,'original');assert.equal((await pool.query('SELECT count(*)::int n FROM audit_events')).rows[0].n,0);}

test('actual dyna_app cannot read private sessions; exact-client owner read restores role and tenant',options,async()=>{
 const c=await tx();try{await guard(c,actor,security);await stage(c);await prepare(c);await finalize(c);
  assert.deepEqual((await c.query("SELECT current_user role,current_setting('app.tenant_id') tenant")).rows[0],{role:'dyna_app',tenant:actor.tenantId});
  // Helper never widens persistent access.
  assert.equal((await c.query("SELECT has_table_privilege(current_user,'sessions','SELECT') ok")).rows[0].ok,false);
 }finally{await close(c);}await unchanged();
});

test('wrong transaction tenant and unregistered lifecycle refuse before owner metadata reads',options,async()=>{
 const c=await tx();try{await c.query("SELECT set_config('app.tenant_id',$1,true)",[randomUUID()]);await assert.rejects(guard(c,actor,security),isStatus(403));
  assert.equal((await c.query('SELECT current_user role')).rows[0].role,'dyna_app');
 }finally{await close(c);}
 const d=await pool.connect();try{assert.throws(()=>enlist(d,actor,security),isStatus(500));await assert.rejects(finalize(d),isStatus(500));}finally{d.release();}
});

test('committed session revocation after prior guard rolls back staged status and audit',options,async()=>{
 const c=await tx();try{await guard(c,actor,security);await stage(c);
  await pool.query('DELETE FROM sessions WHERE token_hash=$1',[actor.sessionHash]);
  await assert.rejects(prepare(c),isStatus(401));assert.equal((await c.query('SELECT current_user role')).rows[0].role,'dyna_app');
 }finally{await close(c);await pool.query("INSERT INTO sessions VALUES($1,$2,$3,clock_timestamp()+interval '1 hour',0,clock_timestamp())",[actor.sessionHash,actor.userId,actor.tenantId]);}
 await unchanged();
});

test('demotion and account-version drift committed after provider read refuse final authorization',options,async()=>{
 for(const mutation of ['role','version']){
  const c=await tx();try{await guard(c,actor,security);await stage(c);
   if(mutation==='role')await pool.query("UPDATE memberships SET role='viewer' WHERE user_id=$1",[actor.userId]);
   else await pool.query('UPDATE account_security SET version=1 WHERE user_id=$1',[actor.userId]);
   await prepare(c);await assert.rejects(finalize(c),isStatus(mutation==='role'?403:401));
   assert.equal((await c.query('SELECT current_user role')).rows[0].role,'dyna_app');
  }finally{await close(c);await pool.query("UPDATE memberships SET role='admin' WHERE user_id=$1",[actor.userId]);await pool.query('UPDATE account_security SET version=0 WHERE user_id=$1',[actor.userId]);}
  await unchanged();
 }
});

test('new MFA requirement and stale proof are checked from actual database at final clock',options,async()=>{
 const c=await tx();try{await guard(c,actor,security);await stage(c);
  await pool.query('UPDATE workspace_security_policies SET require_mfa=true');
  await pool.query("UPDATE sessions SET mfa_verified_at=clock_timestamp()-interval '9 hours'");
  await prepare(c);await assert.rejects(finalize(c),(e:any)=>e instanceof Problem&&e.code==='MFA_REQUIRED');
 }finally{await close(c);await pool.query('UPDATE workspace_security_policies SET require_mfa=false');await pool.query('UPDATE sessions SET mfa_verified_at=clock_timestamp()');}
 await unchanged();
});

test('session expiry during sibling work is refused by terminal DB clock despite successful pinning',options,async()=>{
 await pool.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '250 milliseconds'");
 const c=await tx();try{await stage(c);await prepare(c);await c.query('SELECT pg_sleep(0.35)');await assert.rejects(finalize(c),isStatus(401));}
 finally{await close(c);await pool.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '1 hour'");}await unchanged();
});

test('NOWAIT identity pin refuses native writer conflict without deadlock or local commit',options,async()=>{
 const writer=await pool.connect(),c=await tx();try{await writer.query('BEGIN');await writer.query('SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE',[actor.userId]);
  await stage(c);const t=Date.now();await assert.rejects(prepare(c),(e:any)=>e instanceof Problem&&e.status===409&&e.code==='MIRAKL_SESSION_SOURCE_BUSY');
  assert(Date.now()-t<900,'NOWAIT must not wait for native user writer');
 }finally{await close(c);await writer.query('ROLLBACK');writer.release();}await unchanged();
});

test('pins protect session/account/membership/policy updates and absent-policy native tenant anchor until rollback',options,async()=>{
 const c=await tx(),writer=await pool.connect();try{await stage(c);await prepare(c);
  for(const sql of ['SELECT token_hash FROM sessions FOR UPDATE NOWAIT','SELECT user_id FROM account_security FOR UPDATE NOWAIT',
   'SELECT user_id FROM memberships FOR UPDATE NOWAIT','SELECT tenant_id FROM workspace_security_policies FOR UPDATE NOWAIT']){
   await writer.query('BEGIN');try{await assert.rejects(writer.query(sql),(e:any)=>e.code==='55P03');}finally{await writer.query('ROLLBACK');}
  }
 }finally{await close(c);writer.release();}
 await pool.query('DELETE FROM workspace_security_policies');const d=await tx(),w=await pool.connect();try{await stage(d);await prepare(d);
  await w.query('BEGIN');await assert.rejects(w.query('SELECT id FROM tenants FOR UPDATE NOWAIT'),(e:any)=>e.code==='55P03');
 }finally{await close(d);await w.query('ROLLBACK');w.release();await pool.query('INSERT INTO workspace_security_policies VALUES($1,false)',[actor.tenantId]);}await unchanged();
});

test('torn security graph is refused; no optional missing-table fallback or readonly provider authority',options,async()=>{
 const c=await tx();try{await assert.rejects(guard(c,actor,{...security,workspaceMfaPolicyAvailable:false}),isStatus(503));
  await assert.rejects(guard(c,actor,{...security,readOnly:true}),isStatus(423));
  assert.equal((await c.query('SELECT current_user role')).rows[0].role,'dyna_app');
 }finally{await close(c);}
});


test('actual channel-lock wait plus concurrent logout cannot commit old provider status/audit',options,async()=>{
 const blocker=await pool.connect(),c=await tx();let pending:Promise<void>|undefined;
 try{await blocker.query('BEGIN');await blocker.query('SELECT id FROM channels FOR UPDATE');
  await guard(c,actor,security);const pid=(await c.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  pending=stage(c);let locked=false;const until=Date.now()+1000;
  while(Date.now()<until){locked=(await pool.query("SELECT wait_event_type='Lock' AND query LIKE 'UPDATE channels%' AS blocked FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0]?.blocked===true;
   if(locked)break;await new Promise(r=>setTimeout(r,5));}
  assert(locked,'Actual channel DML must be waiting, not merely an unstarted promise');
  await pool.query('DELETE FROM sessions WHERE token_hash=$1',[actor.sessionHash]);
  await blocker.query('COMMIT');await pending;pending=undefined;await assert.rejects(prepare(c),isStatus(401));
 }finally{await blocker.query('ROLLBACK');if(pending)await pending.catch(()=>{});await close(c);blocker.release();
  await pool.query("INSERT INTO sessions VALUES($1,$2,$3,clock_timestamp()+interval '1 hour',0,clock_timestamp()) ON CONFLICT DO NOTHING",[actor.sessionHash,actor.userId,actor.tenantId]);}
 await unchanged();
});

test('terminal authority refuses repeatable-read snapshot and duplicate/frozen lifecycle',options,async()=>{
 const c=await pool.connect();try{await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');await c.query('SET LOCAL ROLE dyna_app');
  await c.query("SELECT set_config('app.tenant_id',$1,true)",[actor.tenantId]);begin(c);enlist(c,actor,security);
  await assert.rejects(prepare(c),isStatus(503));assert.throws(()=>enlist(c,actor,security),isStatus(500));
 }finally{await close(c);}
 const d=await tx();try{await stage(d);await prepare(d);await finalize(d);await assert.rejects(finalize(d),isStatus(500));}finally{await close(d);}
});
