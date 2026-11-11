/** Real Fastify injection + real CRM/authority/mapping SQL. Root-only execution on
 * the exact disposable217 clone named below, never the source or actual restore.
 * This suite applies218 once. A failure requires a NEW disposable clone. No replay.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import pg from 'pg';
import { pool, tenantReadTx } from '../server/db';
import { tokenHash } from '../server/security';
import { authenticateBaseWireApiKey } from '../server/developer-api';
import { createDefaultBaseWireCrmService } from '../server/base-wire-crm-runtime';
import { registerBaseWireCrmRoutes } from '../server/base-wire-crm-routes';
import { registerCrmRoutes } from '../server/crm-routes';
import { getOrder } from '../server/domain';

// This exact disposable database was explicitly created by Root from the restored
// 217 template. Refuse before connecting anywhere else. No self-created DB/roles.
assert.equal(process.env.DYNA_TEST, 'true', 'Explicit isolated test mode required');
const selected = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
assert.equal(selected.hostname, '127.0.0.1');
assert.equal(selected.port, '57084');
assert.equal(selected.pathname, '/dynaminds_wire218s_20261022_03');
assert.equal(selected.username, 'postgres');
// This process owns only the guarded disposable test pool; ordinary reads stay9s.
pool.options.query_timeout=9000;
let app: ReturnType<typeof Fastify>;
type Owner = { cookie: string; user: any; token: string; keyId: string };
let a: Owner, b: Owner;
const owners: Owner[] = [], availableIdentities: any[] = [];
const legacy: any[] = [];
// Literal seven full guards from the Source212→217 compiler chain, plus the
// two directly diagnosed FA3/PIM gates; allnine run before and after218.
// Each one must finish inside the unchanged8sserver/9sclient ceiling.
const nativeGuards = ['ordinary187_valid','buyer_address_guards','order_merge_delivery209_valid',
  'return_credit206_guards','ordinary188_structure_valid','return_credit211_metadata_valid','large_import173_valid',
  'fa3_draft_guards','pim_dictionary_valid'] as const;
async function assertNativeGuards(c: Pick<import('pg').Client,'query'>, phase: 'before218'|'after218') {
  await c.query("SET LOCAL statement_timeout='8s'");
  for (const name of nativeGuards) {
    const started=performance.now();
    const query: import('pg').QueryConfig & {query_timeout:number}={text:'SELECT public.'+name+'() value',query_timeout:9000};
    const r=await c.query(query);
    assert.equal(r.rows.length,1,phase+':'+name);
    assert.deepEqual(r.rows[0],{value:true},phase+':'+name+' must remain the FULL predecessor guard');
    console.log(JSON.stringify({kind:'base-wire218-native-guard',phase,name,value:true,elapsed_ms:Math.round(performance.now()-started)}));
  }
}

const profile = { login: 'Wire owner ' + randomUUID(), email: randomUUID() + '@example.test', phone: '+48 123',
  notes: 'keep omitted notes', invoice_city: 'Łódź', star: 3 };
/** CRM scopes live in base_wire218_key_scopes; api_keys keeps one ordinary scope. */
async function insertKey(id: string, tenantId: string, userId: string, name: string, token: string, scopes: string[]) {
  const crm = scopes.filter((s) => s.startsWith('crm:')), base = scopes.filter((s) => !s.startsWith('crm:'));
  await pool.query(`INSERT INTO api_keys(id,tenant_id,user_id,name,token_hash,prefix,scopes,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+interval '1 day')`,
    [id,tenantId,userId,name,tokenHash(token),token.slice(0,16),base.length ? base : ['orders:read']]);
  if (crm.length) await pool.query('INSERT INTO base_wire218_key_scopes(tenant_id,key_id,scope) SELECT $1,$2,unnest($3::text[])',[tenantId,id,crm]);
}
async function own(scopes = ['crm:read', 'crm:write']) {
  const row = availableIdentities.shift(); assert(row, 'Need five existing distinct tenant admins');
  const token = 'dyna_api_' + randomBytes(32).toString('hex'), keyId = randomUUID();
  await insertKey(keyId,row.tenant_id,row.user_id,'Isolated wire218 test',token,scopes);
  const result = {cookie: 'closed_ui=' + randomUUID(), user: {id:row.user_id,tenant_id:row.tenant_id}, token, keyId};
  owners.push(result); return result;
}
function harness(readOnly = false, afterAuth?: (principal: Awaited<ReturnType<typeof authenticateBaseWireApiKey>>) => Promise<void>) {
  const instance = Fastify();
  // UI route fixture supplies a normal session actor; the real CRM role SQL still
  // checks membership. Wire authentication always uses the REAL developer token gate.
  instance.addHook('preHandler', async req => {
    if (!req.url.startsWith('/api/crm/')) return;
    const owner = owners.find(x => x.cookie === req.headers.cookie); assert(owner);
    req.actor = {tenantId:owner.user.tenant_id,userId:owner.user.id,role:'admin'};
  });
  registerCrmRoutes(instance,{available:true,readOnly});
  registerBaseWireCrmRoutes(instance,{available:true,readOnly,service:createDefaultBaseWireCrmService(),
    authenticate:async(token,scope)=>{
      const principal=await authenticateBaseWireApiKey(token,scope,true);
      // The optional race hook runs AFTER real credential SQL, before the route
      // constructs its stale actor and enters the real service transaction.
      await afterAuth?.(principal);
      return principal;
    }});
  return instance;
}
async function ui(owner: Owner, method: any, path: string, payload?: any) {
  return app.inject({ method, url: '/api/crm/' + path, payload,
    headers: { cookie: owner.cookie, 'x-workspace-id': owner.user.tenant_id } });
}
async function wire(owner: Owner, method: string, parameters: any, headers: Record<string,string> = {}) {
  return app.inject({ method: 'POST', url: '/connector.php',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-bltoken': owner.token, ...headers },
    payload: new URLSearchParams({ method, parameters: JSON.stringify(parameters) }).toString() });
}
const success = (r: any) => { assert.equal(r.statusCode, 200, r.body); const d = r.json(); assert.equal(d.status, 'SUCCESS', r.body); return d; };
const error = (r: any) => { const d = r.json(); assert.equal(d.status, 'ERROR', r.body);
  assert.deepEqual(Object.keys(d).sort(), ['error_code','error_message','status']);
  assert.equal(typeof d.error_message, 'string'); assert(!/SELECT |stack|password|dyna_api_/.test(r.body)); return d; };
before(async () => {
  const absent = await pool.query("SELECT to_regclass('public.base_wire218_client_ids') AS name");
  assert.equal(absent.rows[0].name,null,'Disposable must start at untouched predecessor217; no SQL replay');
  availableIdentities.push(...(await pool.query(`SELECT DISTINCT ON(m.tenant_id) m.tenant_id,m.user_id
    FROM memberships m WHERE m.role='admin' ORDER BY m.tenant_id,m.user_id LIMIT 5`)).rows);
  assert.equal(availableIdentities.length,5);
  const first = availableIdentities[0];
  for (const deleted of [false,true]) {
    const r = (await pool.query(`INSERT INTO crm_clients(tenant_id,status_id,profile,deleted_at)
      SELECT $1,id,$2::jsonb,CASE WHEN $3 THEN clock_timestamp() ELSE NULL END
      FROM crm_statuses WHERE tenant_id=$1 AND is_primary RETURNING *`,
      [first.tenant_id,JSON.stringify({login:'pre218 legacy '+randomUUID(),notes:'backfill'}),deleted])).rows[0];
    assert(r);legacy.push(r);
  }
  const prior = (await pool.query('SELECT id,scopes FROM api_keys ORDER BY id')).rows;
  // Only this explicit owner DDL query gets120sserver/121sclient. It does not
  // lend its budget or connection to HTTP/domain work or to any native guard.
  const c=new pg.Client({connectionString:selected.href,connectionTimeoutMillis:5000,query_timeout:9000,
    options:'-c jit=off -c statement_timeout=8000 -c lock_timeout=8000 -c timezone=UTC'});
  let connected=false;
  try {
    await c.connect();connected=true;
    await c.query('BEGIN');await c.query('SET LOCAL search_path TO "$user",public');
    await assertNativeGuards(c,'before218');
    // A predecessor guard may leave a local search_path; restore the normal
    // owner DDL namespace immediately before creating any successor objects.
    await c.query('SET LOCAL search_path TO "$user",public');
    await c.query("SET LOCAL statement_timeout='120s'");
    const ddl: import('pg').QueryConfig & {query_timeout:number}={
      text:readFileSync(new URL('../server/218_base_wire_crm.sql',import.meta.url),'utf8'),query_timeout:121000};
    await c.query(ddl);
    await assertNativeGuards(c,'after218');
    await c.query('COMMIT');
  } catch(e) {if(connected)try{await c.query('ROLLBACK');}catch{}throw e;} finally {await c.end();}
  assert.deepEqual((await pool.query('SELECT id,scopes FROM api_keys ORDER BY id')).rows,prior,'Existing keys gain no CRM scopes');
  assert.equal((await pool.query('SELECT count(*)::integer n FROM base_wire218_key_scopes')).rows[0].n,0,'No CRM scope is backfilled');
  for(const [kind,table] of [['client','crm_clients'],['status','crm_statuses'],['field','crm_extra_fields']]) {
    const r=await pool.query(`SELECT count(*)::integer n FROM ${table} r LEFT JOIN base_wire218_${kind}_ids i
      ON (i.tenant_id,i.resource_id,i.local_id)=(r.tenant_id,r.id,r.id) WHERE i.public_id IS NULL`);
    assert.equal(r.rows[0].n,0,'Complete backfill '+kind);
  }
  for(const row of legacy)assert.equal((await pool.query('SELECT local_id FROM base_wire218_client_ids WHERE tenant_id=$1 AND resource_id=$2',[row.tenant_id,row.id])).rows[0].local_id,row.id);
  app=harness();a=await own();b=await own();await app.ready();
});
after(async () => { await app?.close(); await pool.end(); });

test('UI create → Base list/detail/update → same UI profile; numeric identity survives edit and archive', async () => {
  const made = await ui(a, 'POST', 'clients', { client_key: randomUUID(), ...profile });
  assert.equal(made.statusCode, 201, made.body);
  const local = made.json().data;
  const list = success(await wire(a, 'getCrmClients', { page: 1, filter_email: profile.email }));
  assert.equal(list.clients.length, 1);
  const n = list.clients[0].crm_client_id;
  assert(Number.isSafeInteger(n) && n > 0);
  const detail = success(await wire(a, 'getCrmClientData', { crm_client_id: n }));
  assert.equal(detail.email, profile.email); assert.equal(detail.notes, profile.notes);
  assert(!Object.hasOwn(detail, 'data')); assert(!Object.hasOwn(detail, 'custom_extra_fields'));
  assert(!Object.hasOwn(list.clients[0], 'notes')); assert(!Object.hasOwn(list.clients[0], 'custom_extra_fields'));
  assert(!JSON.stringify(detail).includes(local.id), 'Wire should expose numeric identities');
  success(await wire(a, 'addCrmClient', { crm_client_id: n, phone: '', star: 0 }));
  const after = await ui(a, 'GET', 'clients/' + local.id);
  assert.equal(after.statusCode, 200, after.body);
  assert.equal(after.json().data.phone, ''); assert.equal(after.json().data.star, 0);
  for (const key of ['email','notes','invoice_city','login']) assert.equal(after.json().data[key], (profile as any)[key]);
  assert.equal(success(await wire(a, 'getCrmClientData', { crm_client_id: n })).crm_client_id, n);
  const removed = await ui(a, 'DELETE', 'clients/' + local.id, { client_key: randomUUID(), version: after.json().data.version });
  assert.equal(removed.statusCode, 200, removed.body);
  error(await wire(a, 'getCrmClientData', { crm_client_id: n }));
  const next = success(await wire(a, 'addCrmClient', { email: 'after-archive@example.test' })).crm_client_id;
  assert.notEqual(next, n, 'Archived numeric identity must never be reused');
});

test('wire creates intentionally identical profiles independently; local idempotency key reconciles only the exact original', async () => {
  const body = { crm_client_id: 0, login: 'Repeated intentional create' };
  const first = success(await wire(a, 'addCrmClient', body));
  const second = success(await wire(a, 'addCrmClient', body));
  assert.notEqual(first.crm_client_id, second.crm_client_id);
  const key = randomUUID(), h = { 'idempotency-key': key };
  const once = success(await wire(a, 'addCrmClient', { login: 'Local keyed create' }, h));
  assert.deepEqual(success(await wire(a, 'addCrmClient', { login: 'Local keyed create' }, h)), once);
  error(await wire(a, 'addCrmClient', { login: 'Changed original' }, h));
  // Another current key of the SAME user/tenant has its own custody. It may not
  // take over the original key's command even with identical body/clientKey.
  const beforeCommand=(await pool.query('SELECT * FROM crm_commands WHERE tenant_id=$1 AND client_key=$2',[a.user.tenant_id,key])).rows[0];
  assert(beforeCommand);
  const profileId=beforeCommand.response.data.id;
  const beforeProfile=(await pool.query('SELECT * FROM crm_clients WHERE tenant_id=$1 AND id=$2',[a.user.tenant_id,profileId])).rows[0];
  const secondKey=randomUUID(),secondToken='dyna_api_'+randomBytes(32).toString('hex');
  await insertKey(secondKey,a.user.tenant_id,a.user.id,'Second same-user CRM key',secondToken,['crm:read','crm:write']);
  const theft=await wire({...a,token:secondToken,keyId:secondKey},'addCrmClient',{login:'Local keyed create'},h);
  error(theft);assert.equal(theft.statusCode,409);
  assert.deepEqual((await pool.query('SELECT * FROM crm_commands WHERE tenant_id=$1 AND client_key=$2',[a.user.tenant_id,key])).rows[0],beforeCommand,'Whole original receipt retained');
  assert.deepEqual((await pool.query('SELECT * FROM crm_clients WHERE tenant_id=$1 AND id=$2',[a.user.tenant_id,profileId])).rows[0],beforeProfile,'Whole current profile retained');
  assert.deepEqual(success(await wire(a,'addCrmClient',{login:'Local keyed create'},h)),once,'Original key still reconciles its own exact ACK');
  const local = await ui(a, 'GET', 'clients?login=Local%20keyed%20create');
  assert.equal(local.json().data.length, 1);
});

test('Base pagination returns 100 then page2 without duplicates or another tenant, omitting notes/extras', async () => {
  const marker='page-fixture-'+randomUUID()+'-';
  const seeded=(await pool.query(`WITH inserted AS (
    INSERT INTO crm_clients(tenant_id,status_id,profile)
    SELECT $1,s.id,jsonb_build_object('login',$2||n::text,'notes','private note')
    FROM crm_statuses s CROSS JOIN generate_series(1,102) n WHERE s.tenant_id=$1 AND s.is_primary
    RETURNING id) SELECT id FROM inserted`,[a.user.tenant_id,marker])).rows;
  assert.equal(seeded.length,102);
  const ids=(await pool.query('SELECT public_id FROM base_wire218_client_ids WHERE tenant_id=$1 AND resource_id=ANY($2::uuid[])',[a.user.tenant_id,seeded.map(r=>r.id)])).rows.map(r=>Number(r.public_id));
  success(await wire(b, 'addCrmClient', { login: marker+'foreign' }));
  const p1 = success(await wire(a, 'getCrmClients', { page: 1, filter_login: marker })).clients;
  const p2 = success(await wire(a, 'getCrmClients', { page: 2, filter_login: marker })).clients;
  assert.equal(p1.length, 100); assert.equal(p2.length, 2);
  assert.deepEqual([...p1,...p2].map((r: any) => r.crm_client_id).sort((x,y)=>x-y), ids.sort((x,y)=>x-y));
  for (const r of [...p1,...p2]) { assert(!Object.hasOwn(r,'notes')); assert(!Object.hasOwn(r,'custom_extra_fields')); }
});

test('numeric identities and partial updates cannot read or modify another tenant; missing/invalid IDs yield codec envelope', async () => {
  const n = success(await wire(a, 'addCrmClient', { login: 'tenant-private', notes: 'private' })).crm_client_id;
  error(await wire(b, 'getCrmClientData', { crm_client_id: n }));
  error(await wire(b, 'addCrmClient', { crm_client_id: n, notes: 'foreign overwrite' }));
  assert.equal(success(await wire(a, 'getCrmClientData', { crm_client_id: n })).notes, 'private');
  for (const id of [0,-1,1.5,'1',null,Number.MAX_SAFE_INTEGER+1]) error(await wire(a,'getCrmClientData',{crm_client_id:id}));
  error(await wire(a, 'getCrmClientData', {}));
  for (const page of [0,-1,1.5,'2']) error(await wire(a, 'getCrmClients', { page }));
});

test('header token is authoritative; cookie alone, expired/revoked keys, wrong workspace and unscoped key refuse', async () => {
  const plain = new URLSearchParams({method:'getCrmClients',parameters:'{"page":1}'}).toString();
  error(await app.inject({ method:'POST',url:'/connector.php',headers:{'content-type':'application/x-www-form-urlencoded',cookie:a.cookie},payload:plain }));
  error(await wire(a,'getCrmClients',{page:1},{'x-workspace-id':b.user.tenant_id}));
  const token='dyna_api_'+randomBytes(32).toString('hex');
  await pool.query("INSERT INTO api_keys(id,tenant_id,user_id,name,token_hash,prefix,scopes,expires_at) VALUES($1,$2,$3,'No CRM',$4,$5,ARRAY['orders:read'],clock_timestamp()+interval '1 day')",[randomUUID(),a.user.tenant_id,a.user.id,tokenHash(token),token.slice(0,16)]);
  error(await wire({...a,token},'getCrmClients',{page:1}));
  const revoked = await own();
  await pool.query('UPDATE api_keys SET revoked_at=clock_timestamp() WHERE id=$1',[revoked.keyId]);
  error(await wire(revoked,'getCrmClients',{page:1}));
  const expired = await own();
  await pool.query("UPDATE api_keys SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[expired.keyId]);
  error(await wire(expired,'getCrmClients',{page:1}));
});

test('a key revoked after real authentication cannot write through the stale actor returned to the wire route',async()=>{
  const keyBefore=(await pool.query('SELECT to_jsonb(k) value FROM api_keys k WHERE tenant_id=$1 AND id=$2',[a.user.tenant_id,a.keyId])).rows[0].value;
  assert.equal(keyBefore.revoked_at,null);
  const crmSnapshot=async()=>(await pool.query(`SELECT jsonb_build_object(
    'clients',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.id),'[]'::jsonb) FROM crm_clients c WHERE c.tenant_id=$1),
    'commands',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.client_key),'[]'::jsonb) FROM crm_commands c WHERE c.tenant_id=$1),
    'identities',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.public_id),'[]'::jsonb) FROM base_wire218_client_ids c WHERE c.tenant_id=$1),
    'audits',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.id),'[]'::jsonb) FROM audit_events c WHERE c.tenant_id=$1)
  ) value`,[a.user.tenant_id])).rows[0].value;
  const before=await crmSnapshot(),clientKey=randomUUID();let authenticated=0;
  const racing=harness(false,async principal=>{
    authenticated++;
    assert.equal(principal.api_key_id,a.keyId);assert.equal(principal.tenant_id,a.user.tenant_id);assert.equal(principal.id,a.user.id);
    assert(principal.scopes.includes('crm:read')&&principal.scopes.includes('crm:write'));
    const revoked=await pool.query('UPDATE api_keys SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND revoked_at IS NULL RETURNING id',[a.user.tenant_id,a.keyId]);
    assert.equal(revoked.rowCount,1,'Actual revocation commits before service authority SQL');
  });
  try{
    await racing.ready();
    const r=await racing.inject({method:'POST',url:'/connector.php',
      headers:{'content-type':'application/x-www-form-urlencoded','x-bltoken':a.token,'idempotency-key':clientKey},
      payload:new URLSearchParams({method:'addCrmClient',parameters:JSON.stringify({login:'Denied stale actor '+clientKey})}).toString()});
    error(r);assert.equal(r.statusCode,403,r.body);
    assert.equal(authenticated,1,'The real loader succeeded once, then the in-transaction authority refused');
    assert.deepEqual(await crmSnapshot(),before,'Every existing profile, journal, numeric identity and audit is retained; no new CRM row');
  }finally{
    try{await racing.close();}finally{
      // Restore the precise original timestamp through PostgreSQL, including
      // microseconds; do not reset any other mutable key fields or hide drift.
      const restored=await pool.query(`UPDATE api_keys SET revoked_at=(jsonb_populate_record(NULL::public.api_keys,$3::jsonb)).revoked_at
        WHERE tenant_id=$1 AND id=$2 RETURNING id`,[a.user.tenant_id,a.keyId,JSON.stringify(keyBefore)]);
      assert.equal(restored.rowCount,1);
      assert.deepEqual((await pool.query('SELECT to_jsonb(k) value FROM api_keys k WHERE tenant_id=$1 AND id=$2',[a.user.tenant_id,a.keyId])).rows[0].value,keyBefore,'Whole original key restored');
    }
  }
  success(await wire(a,'getCrmClients',{page:1}));
  assert.deepEqual(await crmSnapshot(),before,'A normal real-auth read still adds no CRM data');
});

test('live membership downgrade/revocation governs wire independently of cached principal; no write in readonly preview', async () => {
  const owner = await own();
  const made = success(await wire(owner,'addCrmClient',{login:'current-IAM'}));
  // revoke_developer_access (013) revokes every key of a demoted admin, so the
  // cached principal must lose both reads and writes on the very next request.
  await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2",[owner.user.tenant_id,owner.user.id]);
  assert.notEqual((await pool.query('SELECT revoked_at FROM api_keys WHERE id=$1',[owner.keyId])).rows[0].revoked_at,null);
  const demotedRead=await wire(owner,'getCrmClientData',{crm_client_id:made.crm_client_id});error(demotedRead);assert.equal(demotedRead.statusCode,401);
  error(await wire(owner,'addCrmClient',{crm_client_id:made.crm_client_id,login:'forbidden'}));
  await pool.query('DELETE FROM memberships WHERE tenant_id=$1 AND user_id=$2',[owner.user.tenant_id,owner.user.id]);
  error(await wire(owner,'getCrmClientData',{crm_client_id:made.crm_client_id}));
  assert.equal((await pool.query("SELECT count(*)::integer n FROM crm_clients WHERE tenant_id=$1 AND profile->>'login'='forbidden'",[owner.user.tenant_id])).rows[0].n,0);
  const preview = harness(true);
  try {
    const r = await preview.inject({method:'POST',url:'/connector.php',headers:{'content-type':'application/x-www-form-urlencoded','x-bltoken':a.token},
      payload:new URLSearchParams({method:'addCrmClient',parameters:'{"login":"must-not-write"}'}).toString()});
    error(r);
  } finally { await preview.close(); }
  assert.equal((await ui(a,'GET','clients?login=must-not-write')).json().data.length,0);
});

test('invalid form/JSON/method errors are safe Base envelopes without provider/token/SQL details', async () => {
  for (const payload of ['method=getCrmClients&parameters=%7B','method=notSupported&parameters=%7B%7D',
    'method=getCrmClients&method=addCrmClient&parameters=%7B%7D',
    'method=getCrmClients&parameters=%7B%22page%22%3A1%2C%22page%22%3A2%7D']) {
    error(await app.inject({method:'POST',url:'/connector.php',headers:{'content-type':'application/x-www-form-urlencoded','x-bltoken':a.token},payload}));
  }
});

test('real218 backfill covers active+archived clients; RLS, tenant FK and immutable identity ACLs are enforced by PostgreSQL',async()=>{
  const maps=['base_wire218_client_ids','base_wire218_status_ids','base_wire218_field_ids'];
  for(const name of maps) {
    const flags=(await pool.query(`SELECT relrowsecurity,relforcerowsecurity,
      has_table_privilege('dyna_app',$1,'SELECT') AS readable,
      has_table_privilege('dyna_app',$1,'INSERT') AS insertable,
      has_table_privilege('dyna_app',$1,'UPDATE') AS updatable,
      has_table_privilege('dyna_app',$1,'DELETE') AS deletable
      FROM pg_class WHERE oid=$1::regclass`,[name])).rows[0];
    assert.deepEqual(flags,{relrowsecurity:true,relforcerowsecurity:true,readable:true,insertable:false,updatable:false,deletable:false});
    const rows=await tenantReadTx(a.user.tenant_id,c=>c.query('SELECT tenant_id FROM '+name));
    assert(rows.rows.length>0);assert(rows.rows.every(r=>r.tenant_id===a.user.tenant_id));
  }
  const bStatus=(await pool.query('SELECT id FROM crm_statuses WHERE tenant_id=$1 AND is_primary',[b.user.tenant_id])).rows[0].id;
  const c=await pool.connect();try {
    await c.query('BEGIN');
    await assert.rejects(c.query('INSERT INTO base_wire218_status_ids(tenant_id,resource_id,local_id) VALUES($1,$2,$2)',[a.user.tenant_id,bStatus]),(e:any)=>e.code==='23503');
    await c.query('ROLLBACK');
    await c.query('BEGIN');await c.query('SET LOCAL ROLE dyna_app');await c.query("SELECT set_config('app.tenant_id',$1,true)",[a.user.tenant_id]);
    await assert.rejects(c.query('INSERT INTO base_wire218_status_ids(tenant_id,resource_id,local_id) VALUES($1,$2,NULL)',[a.user.tenant_id,randomUUID()]),(e:any)=>e.code==='42501');
    await c.query('ROLLBACK');
  } finally {
    // Even an unexpected assertion/query error must not return an aborted
    // transaction to this isolated suite's pool. Destroy on failed rollback.
    try {await c.query('ROLLBACK');} catch(e) {c.release(e as Error);throw e;}
    c.release();
  }
  const allocated=(await pool.query('SELECT count(*)::integer n FROM base_wire218_client_ids')).rows[0].n;
  success(await wire(a,'getCrmClients',{page:1}));
  assert.equal((await pool.query('SELECT count(*)::integer n FROM base_wire218_client_ids')).rows[0].n,allocated,'GET performs no allocation/backfill');
});

test('real trigger allocates UI dictionaries/field identities and deleted dictionary keeps its never-reused tombstone',async()=>{
  const made=await ui(a,'POST','statuses',{client_key:randomUUID(),name:'Wire temporary',color:'#123456'});
  assert.equal(made.statusCode,201,made.body);const status=made.json().data;
  const row=(await pool.query('SELECT * FROM base_wire218_status_ids WHERE tenant_id=$1 AND resource_id=$2',[a.user.tenant_id,status.id])).rows[0];
  assert(row&&Number(row.public_id)>0);assert.equal(row.local_id,status.id);
  const primary=(await pool.query('SELECT id FROM crm_statuses WHERE tenant_id=$1 AND is_primary',[a.user.tenant_id])).rows[0].id;
  const removed=await ui(a,'DELETE','statuses/'+status.id,{client_key:randomUUID(),version:status.version,target_status_id:primary});
  assert.equal(removed.statusCode,200,removed.body);
  const tomb=(await pool.query('SELECT * FROM base_wire218_status_ids WHERE tenant_id=$1 AND resource_id=$2',[a.user.tenant_id,status.id])).rows[0];
  assert.equal(tomb.public_id,row.public_id);assert.equal(tomb.local_id,null);assert.equal(tomb.resource_id,status.id);
  const field=await ui(a,'POST','field-definitions',{client_key:randomUUID(),name:'Wire numeric field',editor_type:'number',options:[]});
  assert.equal(field.statusCode,201,field.body);
  const mapping=(await pool.query('SELECT * FROM base_wire218_field_ids WHERE tenant_id=$1 AND resource_id=$2',[a.user.tenant_id,field.json().data.id])).rows[0];
  assert(mapping&&Number(mapping.public_id)>0);
});

test('explicit extra-field include maps numeric IDs and authenticated private files; default reads omit all extras',async()=>{
  const fields=(await pool.query("SELECT id,editor_type FROM crm_extra_fields WHERE tenant_id=$1 AND archived_at IS NULL AND editor_type IN('number','file') ORDER BY position,id",[a.user.tenant_id])).rows;
  const number=fields.find(r=>r.editor_type==='number'),file=fields.find(r=>r.editor_type==='file');assert(number&&file);
  const bytes=Buffer.from('%PDF-1.7\nprivate wire CRM test attachment');
  const made=await ui(a,'POST','clients',{client_key:randomUUID(),login:'Extra fixture '+randomUUID(),custom_extra_fields:{
    [number.id]:0,[file.id]:{title:'agreement.pdf',file:'data:'+bytes.toString('base64')},
  }});assert.equal(made.statusCode,201,made.body);
  const local=made.json().data.id;
  const id=Number((await pool.query('SELECT public_id FROM base_wire218_client_ids WHERE tenant_id=$1 AND local_id=$2',[a.user.tenant_id,local])).rows[0].public_id);
  const mappings=(await pool.query('SELECT resource_id,public_id FROM base_wire218_field_ids WHERE tenant_id=$1 AND resource_id=ANY($2::uuid[])',[a.user.tenant_id,[number.id,file.id]])).rows;
  const numberId=String(mappings.find(r=>r.resource_id===number.id).public_id),fileId=String(mappings.find(r=>r.resource_id===file.id).public_id);
  const plain=success(await wire(a,'getCrmClientData',{crm_client_id:id}));assert(!Object.hasOwn(plain,'custom_extra_fields'));
  const shown=success(await wire(a,'getCrmClientData',{crm_client_id:id,include_custom_extra_fields:true}));
  assert.equal(shown.custom_extra_fields[numberId],0);
  // An exact explicit-key replay must validate the redacted retained file
  // request, not compare upload base64 against its journal digest representation.
  const key=randomUUID(),command={login:'Wire keyed upload '+randomUUID(),custom_extra_fields:{
    [fileId]:{title:'agreement.pdf',file:'data:'+bytes.toString('base64')},
  }},headers={'idempotency-key':key};
  const filesBefore=(await pool.query('SELECT count(*)::integer n FROM crm_files WHERE tenant_id=$1',[a.user.tenant_id])).rows[0].n;
  const keyed=success(await wire(a,'addCrmClient',command,headers));
  assert.deepEqual(success(await wire(a,'addCrmClient',structuredClone(command),headers)),keyed);
  assert.equal((await pool.query('SELECT count(*)::integer n FROM crm_files WHERE tenant_id=$1',[a.user.tenant_id])).rows[0].n,filesBefore+1);
  const journal=(await pool.query('SELECT actor_id,request,response FROM crm_commands WHERE tenant_id=$1 AND client_key=$2',[a.user.tenant_id,key])).rows[0];
  assert.equal(journal.actor_id,a.user.id);assert(!JSON.stringify(journal.request).includes(bytes.toString('base64')));
  assert.equal(typeof journal.request.wire_request_sha256,'string');
  assert.equal((await ui(a,'GET','clients?login='+encodeURIComponent(command.login))).json().data.length,1);
  const value=shown.custom_extra_fields[fileId];assert.deepEqual(Object.keys(value).sort(),['title','url']);assert.equal(value.title,'agreement.pdf');
  assert(!JSON.stringify(shown).includes(bytes.toString('base64')));
  assert.equal(value.url,`/connector.php/files/clients/${id}/fields/${fileId}`);
  const got=await app.inject({method:'GET',url:value.url,headers:{'x-bltoken':a.token}});
  assert.equal(got.statusCode,200,got.body);assert.deepEqual(got.rawPayload,bytes);
  assert.equal(got.headers['x-content-type-options'],'nosniff');assert(String(got.headers['content-disposition']).startsWith('attachment;'));
  error(await app.inject({method:'GET',url:value.url,headers:{'x-bltoken':b.token}}));
  error(await app.inject({method:'GET',url:value.url}));
});

test('real wire delete archives the same linked CRM profile, retains full existing order history/identity/files and enforces fresh authority',async()=>{
  // Reuse a real existing own order from the restored217 substrate. Do not seed
  // orders or bypass createOrder/PIM/reservation/finance admissions for this test.
  const candidate=(await pool.query(`SELECT o.id FROM orders o WHERE o.tenant_id=$1
    AND NOT EXISTS(SELECT 1 FROM crm_order_links l WHERE (l.tenant_id,l.order_id)=(o.tenant_id,o.id))
    ORDER BY o.created_at,o.id LIMIT 1`,[a.user.tenant_id])).rows[0];
  assert(candidate,'The disposable217 substrate needs an existing unlinked own order; no unsafe order seed is provided');
  const field=(await pool.query("SELECT id FROM crm_extra_fields WHERE tenant_id=$1 AND editor_type='file' AND archived_at IS NULL ORDER BY position,id LIMIT 1",[a.user.tenant_id])).rows[0];
  assert(field,'The real CRM needs one active file definition');
  const bytes=Buffer.from('retained,private\nwire-delete,fixture\n');
  const made=await ui(a,'POST','clients',{client_key:randomUUID(),login:'Native delete subject '+randomUUID(),
    email:'before-delete@example.test',custom_extra_fields:{[field.id]:{title:'retained.csv',file:'data:'+bytes.toString('base64')}}});
  assert.equal(made.statusCode,201,made.body);let client=made.json().data;
  const mapped=(await pool.query('SELECT to_jsonb(i) value FROM base_wire218_client_ids i WHERE tenant_id=$1 AND resource_id=$2',[a.user.tenant_id,client.id])).rows[0].value;
  const id=Number(mapped.public_id),fieldId=Number((await pool.query('SELECT public_id FROM base_wire218_field_ids WHERE tenant_id=$1 AND resource_id=$2',[a.user.tenant_id,field.id])).rows[0].public_id);
  const orderDto=()=>tenantReadTx(a.user.tenant_id,c=>getOrder(c,candidate.id));
  // Complete existing rows, not just counts/selected columns. All identifiers
  // and table names are fixed by this test, never provided by a wire request.
  const orderRows=async()=>{
    const result:Record<string,unknown>={};
    for(const table of ['orders','order_items','order_events','reservations','stock_movements','shipments','documents','payment_entries']){
      result[table]=(await pool.query(`SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb) value
        FROM public.${table} r WHERE tenant_id=$1 AND ${table==='orders'?'id':'order_id'}=$2`,[a.user.tenant_id,candidate.id])).rows[0].value;
    }
    return result;
  };
  const oldOrder=await orderDto(),oldRows=await orderRows();
  const linked=await ui(a,'POST','clients/'+client.id+'/orders',{client_key:randomUUID(),version:client.version,order_id:candidate.id});
  assert.equal(linked.statusCode,200,linked.body);client=linked.json().data;
  assert.deepEqual(await orderDto(),oldOrder);assert.deepEqual(await orderRows(),oldRows);
  const oldLinks=(await pool.query('SELECT to_jsonb(l) value FROM crm_order_links l WHERE tenant_id=$1 AND order_id=$2 ORDER BY client_id',[a.user.tenant_id,candidate.id])).rows;
  assert.equal(oldLinks.length,1);assert.equal(oldLinks[0].value.client_id,client.id);
  const journalKey=randomUUID(),body={crm_client_id:id},headers={'idempotency-key':journalKey};
  const targetSnapshot=async()=>(await pool.query(`SELECT jsonb_build_object(
    'client',(SELECT to_jsonb(c) FROM crm_clients c WHERE c.tenant_id=$1 AND c.id=$2),
    'identity',(SELECT to_jsonb(i) FROM base_wire218_client_ids i WHERE i.tenant_id=$1 AND i.resource_id=$2),
    'values',(SELECT coalesce(jsonb_agg(to_jsonb(v) ORDER BY v.field_id),'[]'::jsonb) FROM crm_values v WHERE v.tenant_id=$1 AND v.client_id=$2),
    'files',(SELECT coalesce(jsonb_agg(to_jsonb(f) ORDER BY f.id),'[]'::jsonb) FROM crm_files f WHERE f.tenant_id=$1 AND f.client_id=$2),
    'commands',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.client_key),'[]'::jsonb) FROM crm_commands c WHERE c.tenant_id=$1),
    'audits',(SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.id),'[]'::jsonb) FROM audit_events e WHERE e.tenant_id=$1)
  ) value`,[a.user.tenant_id,client.id])).rows[0].value;
  const initial=await targetSnapshot();
  const fileUrl=success(await wire(a,'getCrmClientData',{crm_client_id:id,include_custom_extra_fields:true})).custom_extra_fields[fieldId].url;
  const attachment=await app.inject({method:'GET',url:fileUrl,headers:{'x-bltoken':a.token}});
  assert.equal(attachment.statusCode,200,attachment.body);assert.deepEqual(attachment.rawPayload,bytes);
  // Both foreign ownership and a real read-only API key must fail before delete.
  const foreign=await wire(b,'deleteCrmClient',body);error(foreign);assert.equal(foreign.statusCode,404);
  const readToken='dyna_api_'+randomBytes(32).toString('hex'),readKey=randomUUID();
  await insertKey(readKey,a.user.tenant_id,a.user.id,'Isolated delete read-only key',readToken,['crm:read']);
  let racing:ReturnType<typeof harness>|undefined,preview:ReturnType<typeof harness>|undefined;
  const keyBefore=(await pool.query('SELECT to_jsonb(k) value FROM api_keys k WHERE tenant_id=$1 AND id=$2',[a.user.tenant_id,a.keyId])).rows[0].value;
  try{
    const readOnlyOwner={...a,token:readToken,keyId:readKey};
    success(await wire(readOnlyOwner,'getCrmClientData',{crm_client_id:id}));
    const noScope=await wire(readOnlyOwner,'deleteCrmClient',body);error(noScope);assert.equal(noScope.statusCode,403);
    preview=harness(true);
    const paused=await preview.inject({method:'POST',url:'/connector.php',headers:{'content-type':'application/x-www-form-urlencoded','x-bltoken':a.token},
      payload:new URLSearchParams({method:'deleteCrmClient',parameters:JSON.stringify(body)}).toString()});
    error(paused);assert.equal(paused.statusCode,423);
    racing=harness(false,async principal=>{
      assert.equal(principal.api_key_id,a.keyId);assert.equal(principal.tenant_id,a.user.tenant_id);
      assert(principal.scopes.includes('crm:write'));
      const revoked=await pool.query('UPDATE api_keys SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND revoked_at IS NULL RETURNING id',[a.user.tenant_id,a.keyId]);
      assert.equal(revoked.rowCount,1);
    });
    const stale=await racing.inject({method:'POST',url:'/connector.php',headers:{'content-type':'application/x-www-form-urlencoded','x-bltoken':a.token,...headers},
      payload:new URLSearchParams({method:'deleteCrmClient',parameters:JSON.stringify(body)}).toString()});
    error(stale);assert.equal(stale.statusCode,403);
    assert.deepEqual(await targetSnapshot(),initial,'Foreign/read-only/stale authority has no profile/journal/audit/file effect');
    assert.deepEqual(await orderRows(),oldRows);
  }finally{
    try{
      const closed=await Promise.allSettled([racing?.close(),preview?.close()]);
      for(const result of closed)if(result.status==='rejected')throw result.reason;
    }finally{
      // Restore the original key exactly, including timestamp precision. The
      // extra read key remains as an explicitly revoked disposable fixture.
      await pool.query(`UPDATE api_keys SET revoked_at=(jsonb_populate_record(NULL::public.api_keys,$3::jsonb)).revoked_at
        WHERE tenant_id=$1 AND id=$2`,[a.user.tenant_id,a.keyId,JSON.stringify(keyBefore)]);
      await pool.query('UPDATE api_keys SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2',[a.user.tenant_id,readKey]);
      assert.deepEqual((await pool.query('SELECT to_jsonb(k) value FROM api_keys k WHERE tenant_id=$1 AND id=$2',[a.user.tenant_id,a.keyId])).rows[0].value,keyBefore);
    }
  }
  assert.deepEqual(success(await wire(a,'deleteCrmClient',body,headers)),{status:'SUCCESS'});
  const archived=await targetSnapshot();assert(archived.client.deleted_at);assert.equal(archived.client.version,client.version+1);
  assert.deepEqual({...archived.client,version:initial.client.version,deleted_at:initial.client.deleted_at,updated_at:initial.client.updated_at},initial.client,'Only the native soft-delete fields change');
  assert.deepEqual(archived.identity,mapped);assert.deepEqual(archived.values,initial.values);assert.deepEqual(archived.files,initial.files);
  const receipt=archived.commands.filter((r:any)=>r.client_key===journalKey);assert.equal(receipt.length,1);
  assert.equal(receipt[0].request.method,'DELETE');assert.deepEqual(receipt[0].response,{data:{id:client.id,deleted:true}});
  assert.deepEqual(await orderDto(),oldOrder);assert.deepEqual(await orderRows(),oldRows);
  assert.deepEqual((await pool.query('SELECT to_jsonb(l) value FROM crm_order_links l WHERE tenant_id=$1 AND order_id=$2 ORDER BY client_id',[a.user.tenant_id,candidate.id])).rows,oldLinks);
  assert.equal((await ui(a,'GET','clients/'+client.id)).statusCode,404);
  assert.equal((await wire(a,'getCrmClientData',body)).statusCode,404);
  assert.equal((await app.inject({method:'GET',url:fileUrl,headers:{'x-bltoken':a.token}})).statusCode,404);
  assert.deepEqual(success(await wire(a,'getCrmClients',{filter_crm_client_id:id})).clients,[]);
  assert.deepEqual(await targetSnapshot(),archived,'GET after archive neither allocates IDs nor mutates retained history');
  assert.deepEqual(success(await wire(a,'deleteCrmClient',body,headers)),{status:'SUCCESS'});
  assert.deepEqual(await targetSnapshot(),archived,'Exact keyed replay does not delete again, add receipts or increment the version');
});

test('real field discovery uses numeric IDs for the same native seven editors; local ARRAY/active-only policy preserves archived values and fresh read authority',async()=>{
  // Retained table/example choose ARRAY; prose is ambiguous. Active-only is a
  // local217 policy, not proof of Base archive or scalar/2MB serialization.
  const created=await ui(a,'POST','field-definitions',{client_key:randomUUID(),name:'Wire definition '+randomUUID(),editor_type:'select',options:['Pilne','Zwykłe']});
  assert.equal(created.statusCode,201,created.body);const definition=created.json().data;
  const mapping=(await pool.query('SELECT to_jsonb(i) value FROM base_wire218_field_ids i WHERE tenant_id=$1 AND resource_id=$2',[a.user.tenant_id,definition.id])).rows[0].value;
  const fieldId=Number(mapping.public_id);assert(Number.isSafeInteger(fieldId)&&fieldId>0);
  const native=(await ui(a,'GET','extra-fields')).json().data;
  const maps=(await pool.query('SELECT local_id,public_id::text public_id FROM base_wire218_field_ids WHERE tenant_id=$1 AND local_id IS NOT NULL',[a.user.tenant_id])).rows;
  const publicId=new Map(maps.map(r=>[r.local_id,Number(r.public_id)]));
  const expected=native.filter((r:any)=>!r.archived).map((r:any)=>({extra_field_id:publicId.get(r.extra_field_id),name:r.name,editor_type:r.editor_type,
    ...(['select','checkbox','radio'].includes(r.editor_type)?{options:r.options}:{})}));
  assert.deepEqual(new Set(expected.map((r:any)=>r.editor_type)),new Set(['text','number','select','checkbox','radio','date','file']));
  for(const row of expected)assert(Number.isSafeInteger(row.extra_field_id)&&row.extra_field_id>0);
  const snapshot=async()=>(await pool.query(`SELECT jsonb_build_object(
    'definitions',(SELECT coalesce(jsonb_agg(to_jsonb(f) ORDER BY f.id),'[]'::jsonb) FROM crm_extra_fields f WHERE f.tenant_id=$1),
    'maps',(SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.public_id),'[]'::jsonb) FROM base_wire218_field_ids i WHERE i.tenant_id=$1),
    'values',(SELECT coalesce(jsonb_agg(to_jsonb(v) ORDER BY v.client_id,v.field_id),'[]'::jsonb) FROM crm_values v WHERE v.tenant_id=$1),
    'commands',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.client_key),'[]'::jsonb) FROM crm_commands c WHERE c.tenant_id=$1),
    'audits',(SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.id),'[]'::jsonb) FROM audit_events e WHERE e.tenant_id=$1)
  ) value`,[a.user.tenant_id])).rows[0].value;
  const before=await snapshot(),shown=success(await wire(a,'getCrmClientExtraFields',{}));
  assert.deepEqual(shown,{status:'SUCCESS',extra_fields:expected});assert.deepEqual(await snapshot(),before,'Definition GET never allocates public identities or edits definitions/values/journal/audit');
  const other=success(await wire(b,'getCrmClientExtraFields',{}));
  assert(!other.extra_fields.some((r:any)=>r.extra_field_id===fieldId||r.name===definition.name));
  const client=success(await wire(a,'addCrmClient',{login:'Keep archived wire value',custom_extra_fields:{[fieldId]:'Pilne'}})).crm_client_id;
  const archived=await ui(a,'PATCH','field-definitions/'+definition.id,{client_key:randomUUID(),version:definition.version,archived:true});
  assert.equal(archived.statusCode,200,archived.body);
  const afterArchive=await snapshot();
  assert(!success(await wire(a,'getCrmClientExtraFields',{})).extra_fields.some((r:any)=>r.extra_field_id===fieldId));
  assert.equal(success(await wire(a,'getCrmClientData',{crm_client_id:client,include_custom_extra_fields:true})).custom_extra_fields[fieldId],'Pilne');
  assert.deepEqual((await pool.query('SELECT to_jsonb(i) value FROM base_wire218_field_ids i WHERE tenant_id=$1 AND resource_id=$2',[a.user.tenant_id,definition.id])).rows[0].value,mapping);
  const preview=harness(true);let racing:ReturnType<typeof harness>|undefined;
  const keyBefore=(await pool.query('SELECT to_jsonb(k) value FROM api_keys k WHERE tenant_id=$1 AND id=$2',[a.user.tenant_id,a.keyId])).rows[0].value;
  try{
    const read=await preview.inject({method:'POST',url:'/connector.php',headers:{'content-type':'application/x-www-form-urlencoded','x-bltoken':a.token},
      payload:new URLSearchParams({method:'getCrmClientExtraFields',parameters:'{}'}).toString()});
    assert.deepEqual(success(read).extra_fields,expected.filter((r:any)=>r.extra_field_id!==fieldId));
    racing=harness(false,async principal=>{
      assert.equal(principal.api_key_id,a.keyId);assert(principal.scopes.includes('crm:read'));
      const revoked=await pool.query('UPDATE api_keys SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND revoked_at IS NULL RETURNING id',[a.user.tenant_id,a.keyId]);assert.equal(revoked.rowCount,1);
    });
    const stale=await racing.inject({method:'POST',url:'/connector.php',headers:{'content-type':'application/x-www-form-urlencoded','x-bltoken':a.token},
      payload:new URLSearchParams({method:'getCrmClientExtraFields',parameters:'{}'}).toString()});
    error(stale);assert.equal(stale.statusCode,403);
    assert.deepEqual(await snapshot(),afterArchive);
  }finally{
    try{
      const closed=await Promise.allSettled([preview.close(),racing?.close()]);for(const result of closed)if(result.status==='rejected')throw result.reason;
    }finally{
      await pool.query(`UPDATE api_keys SET revoked_at=(jsonb_populate_record(NULL::public.api_keys,$3::jsonb)).revoked_at
        WHERE tenant_id=$1 AND id=$2`,[a.user.tenant_id,a.keyId,JSON.stringify(keyBefore)]);
      assert.deepEqual((await pool.query('SELECT to_jsonb(k) value FROM api_keys k WHERE tenant_id=$1 AND id=$2',[a.user.tenant_id,a.keyId])).rows[0].value,keyBefore);
    }
  }
  assert.deepEqual(success(await wire(a,'getCrmClientExtraFields',{})).extra_fields,expected.filter((r:any)=>r.extra_field_id!==fieldId));
  assert.deepEqual(await snapshot(),afterArchive);
});
