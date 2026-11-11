/** Opt-in acceptance against an ALREADY accepted218+219 disposable clone.
 * Importing this file never imports db/runtime, connects, migrates, or starts a
 * service. Root selects and validates the scratch clone; this suite never makes
 * startup capabilities true by interpreting table presence as certification.
 * Fastify.inject exercises native HTTP components with a session-identity
 * fixture. This is not Chrome/rendered UI or normal app-registration acceptance.
 * Run alone: the genuine tenant transactions deliberately exercise Native gates.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Actor } from '../server/domain';
import type { BaseWireJson } from '../server/base-wire-codec';

const directExecution = !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const optedIn = directExecution && process.env.DYNA_CRM_DICTIONARY_DATABASE_TEST === 'accepted-local218-219';
test('real shared CRM dictionary UI/Base API acceptance after owner-accepted218+219', { skip: !optedIn, concurrency: false }, async t => {
  // Every selection check precedes the first runtime import. Never accept a
  // production URL, infer a default database, or create a local config file.
  assert.equal(process.env.DYNA_TEST, 'true');
  assert.equal(process.env.DYNA_CRM_DICTIONARY_ACCEPTED_218_219, 'true', 'Root must first accept BOTH installers on this clone');
  const name = process.env.DYNA_CRM_DICTIONARY_TEST_DATABASE;
  assert(name && /^dynaminds_wire(?:218|219)_disposable_\d{8}_\d{2}$/.test(name), 'Explicit disposable CRM clone required');
  const selected = new URL(process.env.DATABASE_URL ?? 'invalid://missing');
  assert(['postgres:', 'postgresql:'].includes(selected.protocol));
  assert.equal(selected.hostname, '127.0.0.1'); assert.equal(selected.port, '57084'); assert.equal(selected.username, 'postgres');
  assert.equal(selected.pathname, '/' + name); assert.equal(selected.search, ''); assert.equal(selected.hash, '');
  assert(process.env.DYNA_LOCAL_CONFIG_PATH && existsSync(process.env.DYNA_LOCAL_CONFIG_PATH), 'Select existing scratch config explicitly');
  const { pool, tenantReadTx } = await import('../server/db');
  pool.options.query_timeout = 9000;
  const { tokenHash } = await import('../server/security');
  const { authenticateBaseWireApiKey } = await import('../server/developer-api');
  const { createDefaultBaseWireCrmDispatch } = await import('../server/base-wire-crm-runtime');
  const { baseWireCrmDispatchScope } = await import('../server/base-wire-crm-dispatch');
  const { registerBaseWireCrmRoutes } = await import('../server/base-wire-crm-routes');
  const { registerCrmRoutes } = await import('../server/crm-routes');
  const { default: Fastify } = await import('fastify');
  type Owner = { tenant: string; user: string; key: string; token: string; cookie: string };
  type App = ReturnType<typeof Fastify>;
  const apps: App[] = [], issued: Owner[] = [];
  let app: App;
  async function issue(tenant: string, user: string, scopes = ['crm:read', 'crm:write']): Promise<Owner> {
    const token = 'dyna_api_' + randomBytes(32).toString('hex'), key = randomUUID();
    // CRM scopes live in base_wire218_key_scopes; api_keys keeps one ordinary scope.
    const crm = scopes.filter(s => s.startsWith('crm:')), base = scopes.filter(s => !s.startsWith('crm:'));
    await pool.query(`INSERT INTO api_keys(id,tenant_id,user_id,name,token_hash,prefix,scopes,expires_at)
      VALUES($1,$2,$3,'Disposable219 dictionary acceptance',$4,$5,$6,clock_timestamp()+interval '1 day')`,
    [key,tenant,user,tokenHash(token),token.slice(0,16),base.length ? base : ['orders:read']]);
    if (crm.length) await pool.query('INSERT INTO base_wire218_key_scopes(tenant_id,key_id,scope) SELECT $1,$2,unnest($3::text[])',[tenant,key,crm]);
    const owner = { tenant, user, key, token, cookie: 'dictionary_acceptance=' + randomUUID() }; issued.push(owner); return owner;
  }
  function harness(readOnly = false) {
    const instance = Fastify(); apps.push(instance);
    // The UI fixture supplies session identity only. Native CRM re-reads actual
    // membership/MFA policy inside tenantReadTx/tenantTx; no domain port is mocked.
    instance.addHook('preHandler', async req => {
      if (!req.url.startsWith('/api/crm/')) return;
      const owner = issued.find(x => x.cookie === req.headers.cookie); assert(owner);
      req.actor = { tenantId: owner.tenant, userId: owner.user, role: 'admin' };
    });
    registerCrmRoutes(instance, { available: true, readOnly });
    registerBaseWireCrmRoutes(instance, {
      available: true, dictionaryAvailable: true, readOnly,
      service: createDefaultBaseWireCrmDispatch({ crm218Verified: true, dictionary219Verified: true, readOnly }),
      authenticate: (token, scope) => authenticateBaseWireApiKey(token, scope, true),
    });
    return instance;
  }
  async function ui(owner: Owner, resource: 'status-groups' | 'statuses' | 'clients') {
    const r = await app.inject({ method: 'GET', url: '/api/crm/' + resource, headers: { cookie: owner.cookie } });
    assert.equal(r.statusCode, 200, r.body); return r.json().data as any[];
  }
  async function wire(owner: Owner, method: string, parameters: Record<string, BaseWireJson>, clientKey?: string, instance = app) {
    return instance.inject({ method: 'POST', url: '/connector.php',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-bltoken': owner.token, ...(clientKey ? { 'idempotency-key': clientKey } : {}) },
      payload: new URLSearchParams({ method, parameters: JSON.stringify(parameters) }).toString() });
  }
  function success(r: any): any { assert.equal(r.statusCode, 200, r.body); const d = r.json(); assert.equal(d.status, 'SUCCESS', r.body); return d; }
  function refused(r: any, status: number) { assert.equal(r.statusCode, status, r.body); const d = r.json(); assert.deepEqual(Object.keys(d).sort(), ['error_code','error_message','status']); assert.equal(d.status, 'ERROR'); assert(!/SELECT |dyna_api_|password|stack/.test(r.body)); }
  async function mapping(owner: Owner, kind: 'group' | 'status', publicId: number) {
    const table = kind === 'group' ? 'base_wire219_group_ids' : 'base_wire218_status_ids';
    const r = (await pool.query(`SELECT to_jsonb(i) value FROM public.${table} i WHERE tenant_id=$1 AND public_id=$2`, [owner.tenant,publicId])).rows;
    assert.equal(r.length, 1); return r[0].value;
  }
  async function state(owner: Owner) {
    // Whole current rows, receipts and audits: counts alone could hide edits.
    const out: Record<string, unknown> = {};
    for (const table of ['crm_status_groups','crm_statuses','crm_clients','crm_commands','base_wire219_group_ids','base_wire218_status_ids','audit_events']) {
      out[table] = (await pool.query(`SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb) value FROM public.${table} r WHERE tenant_id=$1`, [owner.tenant])).rows[0].value;
    }
    return out;
  }
  async function actor(owner: Owner, method: string): Promise<Actor> {
    const p = await authenticateBaseWireApiKey(owner.token, baseWireCrmDispatchScope(method), true);
    return { tenantId:p.tenant_id,userId:p.id,role:p.role,source:'api',apiKeyId:p.api_key_id };
  }
  const dispatch = () => createDefaultBaseWireCrmDispatch({ crm218Verified:true,dictionary219Verified:true,readOnly:false });
  const statusCode = (expected: number) => (e: any) => { assert.equal(e.status, expected); return true; };
  try {
    const context = (await pool.query('SELECT current_database() database,current_user owner,inet_server_port() port')).rows[0];
    assert.deepEqual(context, { database:name,owner:'postgres',port:57084 });
    const dependencies = (await pool.query(`SELECT to_regprocedure('public.base_wire218_authority(uuid,uuid,boolean)') IS NOT NULL authority,
      to_regclass('public.base_wire218_status_ids') IS NOT NULL status_ids,to_regclass('public.base_wire219_group_ids') IS NOT NULL group_ids`)).rows[0];
    assert.deepEqual(dependencies, { authority:true,status_ids:true,group_ids:true }, 'Prerequisites only; NOT an installer certification');
    const identities = (await pool.query(`SELECT DISTINCT ON(m.tenant_id) m.tenant_id,m.user_id FROM memberships m
      LEFT JOIN workspace_security_policies p ON p.tenant_id=m.tenant_id LEFT JOIN account_security a ON a.user_id=m.user_id
      WHERE m.role='admin' AND (coalesce(p.require_mfa,false)=false OR a.enabled_at IS NOT NULL)
      ORDER BY m.tenant_id,m.user_id LIMIT 2`)).rows;
    assert.equal(identities.length,2,'Two existing tenant admins with currently valid MFA; no fabricated users/tenants');
    const a = await issue(identities[0].tenant_id,identities[0].user_id), b = await issue(identities[1].tenant_id,identities[1].user_id);
    assert.notEqual(a.tenant,b.tenant); app = harness(); await app.ready();

    await t.test('all six methods share native UI UUIDs; update retains IDs; status delete moves clients and leaves tombstone', async () => {
      const groupKey = randomUUID(), groupName = 'G' + randomUUID().slice(0,8);
      const group = success(await wire(a,'addCrmClientStatusGroup',{name:groupName},groupKey)).group_id;
      assert(Number.isSafeInteger(group) && group>0);
      const gm = await mapping(a,'group',group); assert.equal(gm.local_id,gm.resource_id);
      assert((await ui(a,'status-groups')).some(r => r.id===gm.resource_id && r.name===groupName));
      assert(success(await wire(a,'getCrmClientStatusGroups',{})).status_groups.some((r:any) => r.group_id===group && r.name===groupName));
      const changed = 'R' + randomUUID().slice(0,8);
      assert.equal(success(await wire(a,'addCrmClientStatusGroup',{group_id:group,name:changed})).group_id,group);
      assert((await ui(a,'status-groups')).some(r=>r.id===gm.resource_id && r.name===changed && r.version===2));
      const status = success(await wire(a,'addCrmClientStatus',{name:'Dictionary subject',color:'#123456',group_id:group})).status_id;
      const sm = await mapping(a,'status',status); assert.equal(sm.local_id,sm.resource_id);
      assert((await ui(a,'statuses')).some(r=>r.id===sm.resource_id && r.group_id===gm.resource_id));
      success(await wire(a,'addCrmClientStatus',{status_id:status,name:'Updated subject',color:'#AABBCC'}));
      const current = (await ui(a,'statuses')).find(r=>r.id===sm.resource_id); assert.equal(current.name,'Updated subject'); assert.equal(current.color,'#AABBCC'); assert.equal(current.version,2);
      const listed = success(await wire(a,'getCrmClientStatuses',{})).statuses.find((r:any)=>r.id===status);
      assert.deepEqual(listed,{id:status,name:current.name,color:current.color,group_id:group,is_primary:0});
      const primary = success(await wire(a,'getCrmClientStatuses',{})).statuses.find((r:any)=>r.is_primary===1); assert(primary);
      const made = success(await wire(a,'addCrmClient',{login:'Dictionary linked '+randomUUID(),status_id:status}));
      const clientMap = (await pool.query('SELECT local_id FROM base_wire218_client_ids WHERE tenant_id=$1 AND public_id=$2',[a.tenant,made.crm_client_id])).rows[0]; assert(clientMap);
      const clientBefore = (await pool.query('SELECT to_jsonb(c) value FROM crm_clients c WHERE tenant_id=$1 AND id=$2',[a.tenant,clientMap.local_id])).rows[0].value;
      const deleteKey = randomUUID(); assert.deepEqual(success(await wire(a,'deleteCrmClientStatus',{status_id:status,target_status_id:primary.id},deleteKey)),{status:'SUCCESS'});
      const tomb = await mapping(a,'status',status); assert.equal(tomb.public_id,sm.public_id); assert.equal(tomb.resource_id,sm.resource_id); assert.equal(tomb.local_id,null);
      const primaryMap = await mapping(a,'status',primary.id);
      const detail = await app.inject({method:'GET',url:'/api/crm/clients/'+clientMap.local_id,headers:{cookie:a.cookie}}); assert.equal(detail.statusCode,200,detail.body);
      const clientAfter = detail.json().data; assert.equal(clientAfter.status_id,primaryMap.resource_id); assert.equal(clientAfter.version,clientBefore.version+1);
      const retainedClient = (await pool.query('SELECT to_jsonb(c) value FROM crm_clients c WHERE tenant_id=$1 AND id=$2',[a.tenant,clientMap.local_id])).rows[0].value;
      assert.deepEqual({...retainedClient,status_id:clientBefore.status_id,version:clientBefore.version,updated_at:clientBefore.updated_at},clientBefore,'Status migration retains every other client field');
      assert(!success(await wire(a,'getCrmClientStatuses',{})).statuses.some((r:any)=>r.id===status));
      const afterDelete = await state(a); assert.deepEqual(success(await wire(a,'deleteCrmClientStatus',{status_id:status,target_status_id:primary.id},deleteKey)),{status:'SUCCESS'}); assert.deepEqual(await state(a),afterDelete,'Deleted status ACK survives loss without touching rows/audits again');
      const child=success(await wire(a,'addCrmClientStatus',{name:'Moving child',color:'#223344',group_id:group})).status_id;
      const childMap=await mapping(a,'status',child),childBefore=(await ui(a,'statuses')).find(r=>r.id===childMap.resource_id);assert(childBefore);
      const groupDeleteKey=randomUUID();success(await wire(a,'deleteCrmClientStatusGroup',{group_id:group},groupDeleteKey));
      const main=(await ui(a,'status-groups')).find(r=>r.is_main_group===1),childAfter=(await ui(a,'statuses')).find(r=>r.id===childMap.resource_id);assert(main&&childAfter);
      assert.equal(childAfter.group_id,main.id);assert.equal(childAfter.version,childBefore.version+1);assert.deepEqual(await mapping(a,'status',child),childMap,'Group deletion relocates status without rekeying');
      const afterGroupDelete=await state(a);success(await wire(a,'deleteCrmClientStatusGroup',{group_id:group},groupDeleteKey));assert.deepEqual(await state(a),afterGroupDelete,'Deleted group keyed ACK stays durable');
      const mainWire=success(await wire(a,'getCrmClientStatusGroups',{})).status_groups.find((r:any)=>r.is_main_group===1);assert(mainWire);
      refused(await wire(a,'deleteCrmClientStatusGroup',{group_id:mainWire.group_id}),409);
      refused(await wire(a,'deleteCrmClientStatus',{status_id:primary.id,target_status_id:child}),409);assert.deepEqual(await state(a),afterGroupDelete,'Protected main/primary refusals have no effects');
      const groupTomb = await mapping(a,'group',group); assert.equal(groupTomb.public_id,gm.public_id); assert.equal(groupTomb.local_id,null); assert.equal(groupTomb.resource_id,gm.resource_id);
      const next = success(await wire(a,'addCrmClientStatusGroup',{name:groupName})).group_id; assert.notEqual(next,group,'No numeric identity resurrection');
    });

    await t.test('native session HTTP create/edit is immediately the same Base dictionary and GET allocates nothing',async()=>{
      const groupCreated=await app.inject({method:'POST',url:'/api/crm/status-groups',headers:{cookie:a.cookie},payload:{client_key:randomUUID(),name:'UI'+randomUUID().slice(0,8)}});
      assert.equal(groupCreated.statusCode,201,groupCreated.body);const localGroup=groupCreated.json().data;
      const groupMap=(await pool.query('SELECT to_jsonb(i) value FROM base_wire219_group_ids i WHERE tenant_id=$1 AND resource_id=$2',[a.tenant,localGroup.id])).rows[0]?.value;
      assert(groupMap);assert.equal(groupMap.local_id,localGroup.id);const publicGroup=Number(groupMap.public_id);assert(Number.isSafeInteger(publicGroup)&&publicGroup>0);
      const statusCreated=await app.inject({method:'POST',url:'/api/crm/statuses',headers:{cookie:a.cookie},payload:{client_key:randomUUID(),name:'Native shared status',color:'#456789',group_id:localGroup.id}});
      assert.equal(statusCreated.statusCode,201,statusCreated.body);const localStatus=statusCreated.json().data;
      const statusMap=(await pool.query('SELECT to_jsonb(i) value FROM base_wire218_status_ids i WHERE tenant_id=$1 AND resource_id=$2',[a.tenant,localStatus.id])).rows[0]?.value;
      assert(statusMap);assert.equal(statusMap.local_id,localStatus.id);const publicStatus=Number(statusMap.public_id);assert(Number.isSafeInteger(publicStatus)&&publicStatus>0);
      const edited=await app.inject({method:'PATCH',url:'/api/crm/statuses/'+localStatus.id,headers:{cookie:a.cookie},payload:{client_key:randomUUID(),version:localStatus.version,name:'Native edited status'}});
      assert.equal(edited.statusCode,200,edited.body);assert.equal(edited.json().data.id,localStatus.id);assert.equal(edited.json().data.version,localStatus.version+1);
      const before=await state(a);
      const groups=success(await wire(a,'getCrmClientStatusGroups',{})).status_groups,statuses=success(await wire(a,'getCrmClientStatuses',{})).statuses;
      assert.deepEqual(groups.find((r:any)=>r.group_id===publicGroup),{group_id:publicGroup,name:localGroup.name,is_main_group:0});
      assert.deepEqual(statuses.find((r:any)=>r.id===publicStatus),{id:publicStatus,name:'Native edited status',color:localStatus.color,group_id:publicGroup,is_primary:0});
      assert.deepEqual(await state(a),before,'Dictionary GET does not allocate identities or change native data/journal/audit');
      assert.deepEqual(await mapping(a,'group',publicGroup),groupMap);assert.deepEqual(await mapping(a,'status',publicStatus),statusMap);
    });

    await t.test('lost create ACK, concurrent keyed replay and original-key custody retain exactly one native effect', async () => {
      const key = randomUUID(), body = {name:'K'+randomUUID().slice(0,8)};
      // Deliberately discard the first response: real transaction has committed.
      const discarded=await wire(a,'addCrmClientStatusGroup',body,key);assert.equal(discarded.statusCode,200,discarded.body);
      const [one,two] = await Promise.all([wire(a,'addCrmClientStatusGroup',body,key),wire(a,'addCrmClientStatusGroup',body,key)]);
      const ack = success(one); assert.deepEqual(success(two),ack);
      const map = await mapping(a,'group',ack.group_id), rows=(await pool.query('SELECT * FROM crm_status_groups WHERE tenant_id=$1 AND id=$2',[a.tenant,map.resource_id])).rows; assert.equal(rows.length,1); assert.equal(rows[0].version,1);
      const commands=(await pool.query('SELECT to_jsonb(c) value FROM crm_commands c WHERE tenant_id=$1 AND client_key=$2',[a.tenant,key])).rows; assert.equal(commands.length,1); assert.equal(commands[0].value.request.wire_api_key_id,a.key);
      const before=await state(a); refused(await wire(a,'addCrmClientStatusGroup',{name:'different'},key),409);
      const second=await issue(a.tenant,a.user); refused(await wire(second,'addCrmClientStatusGroup',body,key),409);
      assert.deepEqual(await state(a),before); assert.deepEqual(success(await wire(a,'addCrmClientStatusGroup',body,key)),ack);
    });

    await t.test('two tenant foreign group/status IDs and delete targets refuse with whole CRM state retained',async()=>{
      const ga=success(await wire(a,'addCrmClientStatusGroup',{name:'A'+randomUUID().slice(0,8)})).group_id;
      const sa=success(await wire(a,'addCrmClientStatus',{name:'A status',color:'#123456',group_id:ga})).status_id;
      const sb=success(await wire(b,'addCrmClientStatus',{name:'B status',color:'#654321'})).status_id;
      const beforeA=await state(a),beforeB=await state(b);
      for(const [owner,method,params]of [
        [b,'addCrmClientStatusGroup',{group_id:ga,name:'foreign'}],[b,'deleteCrmClientStatusGroup',{group_id:ga}],
        [b,'addCrmClientStatus',{status_id:sa,name:'foreign'}],[b,'addCrmClientStatus',{name:'foreign',color:'#123456',group_id:ga}],
        [b,'deleteCrmClientStatus',{status_id:sa,target_status_id:sb}],[a,'deleteCrmClientStatus',{status_id:sa,target_status_id:sb}],
      ] as const) refused(await wire(owner,method,params),404);
      assert(!success(await wire(b,'getCrmClientStatusGroups',{})).status_groups.some((r:any)=>r.group_id===ga));
      assert(!success(await wire(b,'getCrmClientStatuses',{})).statuses.some((r:any)=>r.id===sa));
      assert.deepEqual(await state(a),beforeA); assert.deepEqual(await state(b),beforeB);
      const visible = await tenantReadTx(b.tenant,c=>c.query('SELECT tenant_id FROM base_wire219_group_ids')); assert(visible.rows.every(r=>r.tenant_id===b.tenant));
    });

    await t.test('fresh SQL refuses stale role, scope/revocation and MFA changes even for previously authenticated keyed ACK',async()=>{
      const key=randomUUID(),body={name:'S'+randomUUID().slice(0,8)},ack=success(await wire(a,'addCrmClientStatusGroup',body,key));
      const stale=await actor(a,'addCrmClientStatusGroup'),readActor=await actor(a,'getCrmClientStatusGroups');
      const before=await state(a),member=(await pool.query('SELECT to_jsonb(m) value FROM memberships m WHERE tenant_id=$1 AND user_id=$2',[a.tenant,a.user])).rows[0].value;
      const keyBefore=(await pool.query('SELECT to_jsonb(k) value FROM api_keys k WHERE tenant_id=$1 AND id=$2',[a.tenant,a.key])).rows[0].value;
      const crmScopes=async()=>(await pool.query('SELECT scope FROM base_wire218_key_scopes WHERE tenant_id=$1 AND key_id=$2 ORDER BY scope',[a.tenant,a.key])).rows.map(r=>r.scope);
      const setCrm=async(values:string[])=>{await pool.query('DELETE FROM base_wire218_key_scopes WHERE tenant_id=$1 AND key_id=$2',[a.tenant,a.key]);
        if(values.length)await pool.query('INSERT INTO base_wire218_key_scopes(tenant_id,key_id,scope) SELECT $1,$2,unnest($3::text[])',[a.tenant,a.key,values]);};
      const crmBefore=await crmScopes();
      const policy=(await pool.query('SELECT to_jsonb(p) value FROM workspace_security_policies p WHERE tenant_id=$1',[a.tenant])).rows[0]?.value;
      const security=(await pool.query('SELECT to_jsonb(s) value FROM account_security s WHERE user_id=$1',[a.user])).rows[0]?.value;
      try{
        // revoke_developer_access (013) revokes a demoted admin's keys: reads and writes both stop.
        for(const role of ['operator','viewer']){
          await pool.query('UPDATE memberships SET role=$3 WHERE tenant_id=$1 AND user_id=$2',[a.tenant,a.user,role]);
          await assert.rejects(()=>dispatch().execute(stale,'addCrmClientStatusGroup',body,{clientKey:key}),statusCode(403));
          await assert.rejects(()=>dispatch().execute(readActor,'getCrmClientStatusGroups',{}),statusCode(403));
          await pool.query('UPDATE memberships SET role=$3 WHERE tenant_id=$1 AND user_id=$2',[a.tenant,a.user,member.role]);
          await pool.query('UPDATE api_keys SET revoked_at=NULL WHERE tenant_id=$1 AND id=$2',[a.tenant,a.key]);
        }
        const groups=await dispatch().execute(readActor,'getCrmClientStatusGroups',{}); assert(Array.isArray(groups.status_groups));
        await setCrm(['crm:read']);
        await assert.rejects(()=>dispatch().execute(stale,'addCrmClientStatusGroup',body,{clientKey:key}),statusCode(403));
        await setCrm([]);
        await assert.rejects(()=>dispatch().execute(readActor,'getCrmClientStatusGroups',{}),statusCode(403));
        await assert.rejects(()=>dispatch().execute(stale,'addCrmClientStatusGroup',body,{clientKey:key}),statusCode(403));
        await setCrm(crmBefore);
        await pool.query('UPDATE api_keys SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2',[a.tenant,a.key]);
        await assert.rejects(()=>dispatch().execute(readActor,'getCrmClientStatusGroups',{}),statusCode(403));
        await assert.rejects(()=>dispatch().execute(stale,'addCrmClientStatusGroup',body,{clientKey:key}),statusCode(403));
        await pool.query('UPDATE api_keys SET revoked_at=NULL WHERE tenant_id=$1 AND id=$2',[a.tenant,a.key]);
        if(security)await pool.query('UPDATE account_security SET secret_encrypted=NULL,enabled_at=NULL WHERE user_id=$1',[a.user]);
        await pool.query(`INSERT INTO workspace_security_policies(tenant_id,require_mfa,changed_by) VALUES($1,true,$2)
          ON CONFLICT(tenant_id) DO UPDATE SET require_mfa=true`,[a.tenant,a.user]);
        await assert.rejects(()=>dispatch().execute(readActor,'getCrmClientStatusGroups',{}),statusCode(403));
        await assert.rejects(()=>dispatch().execute(stale,'addCrmClientStatusGroup',body,{clientKey:key}),statusCode(403));
        assert.deepEqual(await state(a),before,'No denial mutates native dictionaries, maps, clients, receipts or audit');
      }finally{
        await pool.query('UPDATE memberships SET role=$3 WHERE tenant_id=$1 AND user_id=$2',[a.tenant,a.user,member.role]);
        await pool.query(`UPDATE api_keys SET scopes=(jsonb_populate_record(NULL::public.api_keys,$3::jsonb)).scopes,
          revoked_at=(jsonb_populate_record(NULL::public.api_keys,$3::jsonb)).revoked_at WHERE tenant_id=$1 AND id=$2`,[a.tenant,a.key,JSON.stringify(keyBefore)]);
        await setCrm(crmBefore);assert.deepEqual(await crmScopes(),crmBefore);
        if(security)await pool.query(`UPDATE account_security SET secret_encrypted=(jsonb_populate_record(NULL::public.account_security,$2::jsonb)).secret_encrypted,
          enabled_at=(jsonb_populate_record(NULL::public.account_security,$2::jsonb)).enabled_at WHERE user_id=$1`,[a.user,JSON.stringify(security)]);
        if(policy)await pool.query('UPDATE workspace_security_policies SET require_mfa=$2 WHERE tenant_id=$1',[a.tenant,policy.require_mfa]);
        else await pool.query('DELETE FROM workspace_security_policies WHERE tenant_id=$1',[a.tenant]);
        assert.deepEqual((await pool.query('SELECT to_jsonb(m) value FROM memberships m WHERE tenant_id=$1 AND user_id=$2',[a.tenant,a.user])).rows[0].value,member);
        assert.deepEqual((await pool.query('SELECT to_jsonb(k) value FROM api_keys k WHERE tenant_id=$1 AND id=$2',[a.tenant,a.key])).rows[0].value,keyBefore);
        assert.deepEqual((await pool.query('SELECT to_jsonb(p) value FROM workspace_security_policies p WHERE tenant_id=$1',[a.tenant])).rows[0]?.value,policy);
        assert.deepEqual((await pool.query('SELECT to_jsonb(s) value FROM account_security s WHERE user_id=$1',[a.user])).rows[0]?.value,security);
      }
      assert.deepEqual(success(await wire(a,'addCrmClientStatusGroup',body,key)),ack,'Original ACK is reconciled only after authority returns');
    });

    await t.test('real219 RLS/ACL and immutable live/tombstone transitions refuse forbidden direct writes',async()=>{
      const flags=(await pool.query(`SELECT relrowsecurity,relforcerowsecurity,
        has_table_privilege('dyna_app','public.base_wire219_group_ids','SELECT') readable,
        has_table_privilege('dyna_app','public.base_wire219_group_ids','INSERT') insertable,
        has_table_privilege('dyna_app','public.base_wire219_group_ids','UPDATE') updatable,
        has_table_privilege('dyna_app','public.base_wire219_group_ids','DELETE') deletable,
        has_sequence_privilege('dyna_app','public.base_wire219_group_ids_public_id_seq','USAGE') sequence_usage
        FROM pg_class WHERE oid='public.base_wire219_group_ids'::regclass`)).rows[0];
      assert.deepEqual(flags,{relrowsecurity:true,relforcerowsecurity:true,readable:true,insertable:false,updatable:false,deletable:false,sequence_usage:false});
      const allBefore=(await pool.query('SELECT to_jsonb(i) value FROM base_wire219_group_ids i ORDER BY tenant_id,public_id')).rows;
      const live=allBefore.find(r=>r.value.tenant_id===a.tenant&&r.value.local_id!==null)?.value;
      const tomb=allBefore.find(r=>r.value.tenant_id===a.tenant&&r.value.local_id===null)?.value;assert(live&&tomb,'Earlier real lifecycle retained live maps and a tombstone');
      const c=await pool.connect();
      try{
        for(const [id,next,asApp,code]of [[live.resource_id,null,false,'55000'],[tomb.resource_id,tomb.resource_id,false,'55000'],[live.resource_id,null,true,'42501']] as const){
          await c.query('BEGIN');
          if(asApp){await c.query('SET LOCAL ROLE dyna_app');await c.query("SELECT set_config('app.tenant_id',$1,true)",[a.tenant]);}
          await assert.rejects(c.query('UPDATE public.base_wire219_group_ids SET local_id=$3 WHERE tenant_id=$1 AND resource_id=$2',[a.tenant,id,next]),(error:any)=>error.code===code);
          await c.query('ROLLBACK');
        }
      }finally{
        try{await c.query('ROLLBACK');}catch(error){c.release(error as Error);throw error;}
        c.release();
      }
      assert.deepEqual((await pool.query('SELECT to_jsonb(i) value FROM base_wire219_group_ids i ORDER BY tenant_id,public_id')).rows,allBefore,'All live and tombstone records retained after refusals');
    });

    await t.test('actual read-only composition preserves reads and refuses all four dictionary writes before effects',async()=>{
      const preview=harness(true); await preview.ready();const before=await state(a);
      success(await wire(a,'getCrmClientStatusGroups',{},undefined,preview)); success(await wire(a,'getCrmClientStatuses',{},undefined,preview));
      for(const [method,params]of [
        ['addCrmClientStatusGroup',{name:'readonly'}],['addCrmClientStatus',{name:'readonly',color:'#123456'}],
        ['deleteCrmClientStatusGroup',{group_id:1}],['deleteCrmClientStatus',{status_id:1,target_status_id:2}],
      ] as const)refused(await wire(a,method,params,randomUUID(),preview),423);
      assert.deepEqual(await state(a),before);
    });
  } finally {
    // Only issued scratch tokens are revoked. Preserve business receipts and
    // tombstones as evidence; deleting fixture history would mask replay bugs.
    const cleanupFailures: unknown[] = [];
    try {
      const revoked = await Promise.allSettled(issued.map(owner => Promise.resolve().then(() => pool.query(
        'UPDATE api_keys SET revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE tenant_id=$1 AND id=$2',
        [owner.tenant,owner.key],
      ))));
      for(const result of revoked)if(result.status==='rejected')cleanupFailures.push(result.reason);
    } catch(error) { cleanupFailures.push(error); } finally {
      try {
        // Promise callbacks also turn a synchronous close failure into a settled
        // rejection, allowing every other app to attempt its own cleanup.
        const closed = await Promise.allSettled(apps.map(instance => Promise.resolve().then(() => instance.close())));
        for(const result of closed)if(result.status==='rejected')cleanupFailures.push(result.reason);
      } catch(error) { cleanupFailures.push(error); } finally {
        try { await pool.end(); } catch(error) { cleanupFailures.push(error); }
      }
    }
    if(cleanupFailures.length)throw new AggregateError(cleanupFailures,'Dictionary acceptance cleanup failed; inspect every revocation/close failure');
  }
});
