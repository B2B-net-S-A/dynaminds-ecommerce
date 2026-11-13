import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { seed } from './fixtures';
import { withoutApiKeyLastUse } from './api-key-last-use';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/dynaminds_test_\d+$/);

type Row = Record<string, any>;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let tenant = '',
  adminId = '',
  admin = '',
  viewer = '',
  ip = 1;
let providerCalls = 0;
const prefix = '/catalog/export-profiles';
const cookies = new Map<string, string>();
const transport = async () => {
  ++providerCalls;
  throw new Error('Export profiles must never call providers');
};
const request = (
  path: string,
  method: any = 'GET',
  payload?: any,
  cookie = admin,
  target = app,
  headers: Record<string, string> = {},
) => {
  assert(target);
  return target.inject({
    url: '/api' + path,
    method,
    payload,
    headers: { cookie, ...headers },
    remoteAddress: '127.0.165.' + ip,
  });
};
async function ok(path: string, method: any = 'GET', payload?: any, cookie = admin, status = 200) {
  const response = await request(path, method, payload, cookie);
  assert.equal(response.statusCode, status, `${method} ${path}: ${response.body.slice(0, 1000)}`);
  return response.json() as Row;
}
async function login(email: string, target = app) {
  const response = await request(
    '/auth/login',
    'POST',
    {
      email,
      password: 'DynaDemo!2026',
    },
    '',
    target,
  );
  assert.equal(response.statusCode, 200);
  return String(response.headers['set-cookie']).split(';')[0];
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({
    integrationTransport: transport,
    logging: process.env.CATALOG_EXPORT_PROFILE_TEST_LOG === 'true',
  });
  for (const email of ['admin@demo.local', 'viewer@demo.local'])
    cookies.set(email, await login(email));
  adminId = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
});
beforeEach(async () => {
  ++ip;
  providerCalls = 0;
  tenant = randomUUID();
  await pool.query(
    "INSERT INTO tenants(id,name,plan) VALUES($1,'Export profiles adversarial','enterprise')",
    [tenant],
  );
  await pool.query(
    `INSERT INTO memberships(tenant_id,user_id,role)
    SELECT $1,id,CASE email WHEN 'admin@demo.local' THEN 'admin' ELSE 'viewer' END
    FROM users WHERE email=ANY($2::text[])`,
    [tenant, [...cookies.keys()]],
  );
  for (const [email, cookie] of cookies) {
    const response = await request('/workspaces/switch', 'POST', { tenant_id: tenant }, cookie);
    assert.equal(response.statusCode, 200);
    cookies.set(email, String(response.headers['set-cookie']).split(';')[0]);
  }
  admin = cookies.get('admin@demo.local')!;
  viewer = cookies.get('viewer@demo.local')!;
});
after(async () => {
  try {
    await app?.close();
  } finally {
    await pool.end();
  }
});
const definition = (extra: Row = {}) => ({
  format: 'csv',
  columns: ['sku', 'name'],
  headers: { sku: 'SKU', name: 'Nazwa' },
  spreadsheet_safe: true,
  ...extra,
});
const createInput = (extra: Row = {}) => ({
  name: 'Profile ' + randomUUID(),
  definition: definition(),
  client_key: randomUUID(),
  ...extra,
});
async function key(scopes: string[]) {
  return ok('/developer/keys', 'POST', { name: 'Profile safety', scopes }, admin, 201);
}
async function snapshot() {
  const names = (
    await pool.query(`SELECT DISTINCT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables t USING(table_schema,table_name)
    WHERE c.table_schema='public' AND c.column_name='tenant_id' AND t.table_type='BASE TABLE'
    AND c.table_name NOT IN ('memberships','api_keys','outbound_subscriptions') ORDER BY 1`)
  ).rows;
  const result: Row = {};
  for (const { table_name: name } of names) {
    assert(/^[a-z][a-z0-9_]*$/.test(name));
    result[name] = (
      await pool.query(`SELECT to_jsonb(t) row FROM "${name}" t WHERE tenant_id=$1 ORDER BY 1`, [
        tenant,
      ])
    ).rows;
  }
  return withoutApiKeyLastUse(result);
}
async function waitOn(holder: PoolClient, pattern: RegExp) {
  const pid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    const waiting = (
      await pool.query(
        `SELECT query FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock'
      AND $1=ANY(pg_blocking_pids(pid))`,
        [pid],
      )
    ).rows;
    if (waiting.some((r) => pattern.test(r.query))) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.fail('Actual profile operation never waited on the independent blocker');
}
async function changeGrant(sql: string, values: unknown[]) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout='1500ms'");
    await client.query(sql, values);
    await client.query('COMMIT');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

test('profile configuration rejects selection, secrets, unsafe aliases and ambiguous effective headers without evidence writes', async () => {
  const before = await snapshot();
  const invalid = [
    createInput({ tenant_id: randomUUID() }),
    createInput({ definition: definition({ selection: 'selected', ids: [randomUUID()] }) }),
    createInput({ definition: definition({ search: 'private filter' }) }),
    createInput({ definition: definition({ credentials: { token: 'own-sentinel' } }) }),
    createInput({ definition: definition({ columns: ['sku', 'sku'] }) }),
    createInput({ definition: definition({ headers: { description: 'Unselected' } }) }),
    createInput({ definition: definition({ headers: { sku: 'Same', name: 'Same' } }) }),
    createInput({ definition: definition({ headers: { sku: 'Same', name: 'same' } }) }),
    createInput({ definition: definition({ headers: { sku: 'name' } }) }),
    createInput({ definition: definition({ headers: { sku: 'x'.repeat(81) } }) }),
    createInput({ definition: definition({ headers: { sku: 'Bad\u0001header' } }) }),
    createInput({ definition: definition({ format: 'xml', headers: { sku: '1number' } }) }),
    createInput({ definition: definition({ format: 'xml', headers: { sku: 'a:b' } }) }),
    createInput({ definition: definition({ format: 'xml', headers: { sku: 'xmlReserved' } }) }),
    createInput({ definition: definition({ format: 'xml', headers: { sku: 'Zażółć' } }) }),
  ];
  for (const body of invalid) {
    const response = await request(prefix, 'POST', body);
    assert.equal(response.statusCode, 422, response.body.slice(0, 1000));
    assert.match(String(response.headers['cache-control']), /no-store/);
    assert.equal(response.json().profile, undefined);
    assert.equal(response.json().data, undefined);
  }
  const prototype = await request(prefix, 'POST', createInput({
    definition: definition({ headers: JSON.parse('{"__proto__":"poison"}') }),
  }));
  assert.equal(prototype.statusCode, 400, 'Prototype key is rejected by the secure JSON parser before Zod');
  assert.match(String(prototype.headers['cache-control']), /no-store/);
  assert.equal(prototype.json().profile, undefined);
  assert.equal(prototype.json().data, undefined);
  assert.deepEqual(await snapshot(), before);
  assert.equal(providerCalls, 0);
});

async function profile(body: Row = createInput()) {
  const response = await ok(prefix, 'POST', body, admin, 201);
  assert.equal(response.reused, false);
  assert(response.profile?.id);
  return response.profile as Row;
}

test('profile read ACL and public scope registry are distinct from administrator management', async () => {
  const p = await profile();
  const read = await key(['products:read']);
  const write = await key(['products:write']);
  const both = await key(['products:read', 'products:write']);
  for (const headers of [{}, { authorization: 'Bearer ' + read.token }] as Record<
    string,
    string
  >[]) {
    const publicPrefix = headers.authorization ? '/v1' : '';
    const cookie = headers.authorization ? '' : viewer;
    for (const path of [prefix, prefix + '/' + p.id]) {
      const response = await request(publicPrefix + path, 'GET', undefined, cookie, app, headers);
      assert.equal(response.statusCode, 200, response.body);
      assert.match(String(response.headers['cache-control']), /no-store/);
      assert.equal(response.json().can_manage, false);
      assert(!response.body.includes('request_hash'));
      assert(!response.body.includes('initial_request'));
    }
    const denied = await request(
      publicPrefix + prefix,
      'POST',
      createInput(),
      cookie,
      app,
      headers,
    );
    assert.equal(denied.statusCode, 403);
  }
  for (const path of [prefix, prefix + '/' + p.id]) {
    const response = await request('/v1' + path, 'GET', undefined, '', app, {
      authorization: 'Bearer ' + write.token,
    });
    assert.equal(response.statusCode, 403);
  }
  const before = await snapshot();
  const denied = await request('/v1' + prefix, 'POST', createInput(), '', app, {
    authorization: 'Bearer ' + write.token,
  });
  assert.equal(denied.statusCode, 403, 'Management requires both read and write context');
  assert.deepEqual(await snapshot(), before);
  const created = await request('/v1' + prefix, 'POST', createInput(), '', app, {
    authorization: 'Bearer ' + both.token,
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(providerCalls, 0);
});

test('create retry binds original actor and canonical request while explicitly returning the current edited archived profile', async () => {
  const operatorId = (await pool.query("SELECT id FROM users WHERE email='operator@demo.local'"))
    .rows[0].id;
  await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [
    tenant,
    operatorId,
  ]);
  let otherCookie = await login('operator@demo.local');
  const switched = await request('/workspaces/switch', 'POST', { tenant_id: tenant }, otherCookie);
  assert.equal(switched.statusCode, 200);
  otherCookie = String(switched.headers['set-cookie']).split(';')[0];
  const body = createInput();
  const p = await profile(body);
  const patched = await ok(prefix + '/' + p.id, 'PATCH', {
    version: p.version,
    name: 'Later current profile',
    definition: definition({ headers: { sku: 'Current SKU', name: 'Current Name' } }),
  });
  const archived = await ok(prefix + '/' + p.id + '/archive', 'POST', {
    version: patched.profile.version,
  });
  const before = await snapshot();
  const reordered = {
    client_key: body.client_key,
    definition: {
      spreadsheet_safe: true,
      headers: { name: 'Nazwa', sku: 'SKU' },
      columns: ['sku', 'name'],
      format: 'csv',
    },
    name: body.name,
  };
  const retry = await ok(prefix, 'POST', reordered);
  assert.equal(retry.reused, true);
  assert.equal(retry.profile.id, p.id);
  assert.equal(retry.profile.archived, true);
  assert.equal(String(retry.profile.version), String(archived.profile.version));
  assert.equal(retry.profile.name, 'Later current profile');
  assert.deepEqual(retry.profile.definition, patched.profile.definition);
  const changed = await request(prefix, 'POST', {
    ...body,
    name: 'Different request with same key',
  });
  assert.equal(changed.statusCode, 409);
  const collision = await request(prefix, 'POST', body, otherCookie);
  assert.equal(
    collision.statusCode,
    409,
    'A create client key cannot be adopted by another administrator',
  );
  assert.deepEqual(await snapshot(), before);
});

test(
  'membership downgrade commits while PATCH actually waits on its profile row, then rolls back profile and audit',
  { timeout: 15000 },
  async () => {
    const p = await profile();
    const before = await snapshot();
    const holder = await pool.connect();
    let pending: ReturnType<typeof request> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query(
        'SELECT id FROM catalog_export_profiles WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
        [tenant, p.id],
      );
      pending = request(prefix + '/' + p.id, 'PATCH', {
        version: p.version,
        name: 'Unauthorized edit',
        definition: definition(),
      });
      await waitOn(holder, /catalog_export_profiles/i);
      await changeGrant("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
        tenant,
        adminId,
      ]);
      await holder.query('COMMIT');
      const response = await pending;
      assert.equal(response.statusCode, 403, response.body);
      assert.deepEqual(await snapshot(), before);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      await pending?.catch(() => {});
      await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
        tenant,
        adminId,
      ]);
    }
  },
);

test(
  'late current key revoke, expiry and scope loss defeat a public PATCH authenticated before a genuine row wait',
  { timeout: 25000 },
  async () => {
    const p = await profile();
    for (const kind of ['revoke', 'expire', 'scope']) {
      const k = await key(['products:read', 'products:write']);
      const before = await snapshot();
      const holder = await pool.connect();
      let pending: ReturnType<typeof request> | undefined;
      try {
        await holder.query('BEGIN');
        await holder.query(
          'SELECT id FROM catalog_export_profiles WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
          [tenant, p.id],
        );
        pending = request(
          '/v1' + prefix + '/' + p.id,
          'PATCH',
          {
            version: p.version,
            name: 'Unauthorized public edit',
            definition: definition(),
          },
          '',
          app,
          { authorization: 'Bearer ' + k.token },
        );
        await waitOn(holder, /catalog_export_profiles/i);
        await changeGrant(
          kind === 'revoke'
            ? 'UPDATE api_keys SET revoked_at=now() WHERE id=$1'
            : kind === 'expire'
              ? "UPDATE api_keys SET expires_at=now()-interval '1 second' WHERE id=$1"
              : "UPDATE api_keys SET scopes=ARRAY['products:read']::text[] WHERE id=$1",
          [k.id],
        );
        await holder.query('COMMIT');
        const response = await pending;
        assert.equal(response.statusCode, kind === 'scope' ? 403 : 401, response.body);
        assert.deepEqual(await snapshot(), before);
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
        await pending?.catch(() => {});
      }
    }
  },
);

test('concurrent CAS has one winner and an active casefold collision cannot overwrite another profile', async () => {
  const p = await profile();
  const responses = await Promise.all(
    ['Winner A', 'Winner B'].map((name) =>
      request(prefix + '/' + p.id, 'PATCH', {
        version: p.version,
        name,
        definition: definition(),
      }),
    ),
  );
  assert.deepEqual(responses.map((r) => r.statusCode).sort(), [200, 409]);
  const current = (await ok(prefix + '/' + p.id)).profile;
  assert.equal(BigInt(current.version), BigInt(p.version) + 1n);
  const before = await snapshot();
  const collision = await request(
    prefix,
    'POST',
    createInput({ name: current.name.toLowerCase() }),
  );
  assert.equal(collision.statusCode, 409);
  assert.deepEqual(await snapshot(), before);
  const archived = await ok(prefix + '/' + p.id + '/archive', 'POST', { version: current.version });
  await profile(createInput({ name: current.name.toLowerCase() }));
  const afterReplacement = await snapshot();
  const restore = await request(prefix + '/' + p.id + '/restore', 'POST', {
    version: archived.profile.version,
  });
  assert.equal(restore.statusCode, 409);
  assert.deepEqual(await snapshot(), afterReplacement);
});

test(
  'all 200 slots include archived profiles, last-slot admission is serialized and original create retry bypasses only the quota',
  { timeout: 20000 },
  async () => {
    const firstBody = createInput();
    const first = await profile(firstBody);
    await ok(prefix + '/' + first.id + '/archive', 'POST', { version: first.version });
    for (let n = 1; n < 199; ++n) await profile(createInput({ name: 'Quota profile ' + n }));
    const contenders = await Promise.all(
      [createInput({ name: 'Last A' }), createInput({ name: 'Last B' })].map((body) =>
        request(prefix, 'POST', body),
      ),
    );
    assert.deepEqual(contenders.map((r) => r.statusCode).sort(), [201, 429]);
    const all = await ok(prefix);
    assert.equal(all.data.length, 200);
    assert.equal(all.limit, 200);
    assert.equal(all.data.filter((p: Row) => p.archived).length, 1);
    const before = await snapshot();
    const over = await request(prefix, 'POST', createInput({ name: 'Over quota' }));
    assert.equal(over.statusCode, 429);
    const retry = await ok(prefix, 'POST', firstBody);
    assert.equal(retry.reused, true);
    assert.equal(retry.profile.id, first.id);
    assert.equal(retry.profile.archived, true);
    assert.deepEqual(await snapshot(), before);
  },
);

test('profile RLS, original-request immutability and raw JSON checks prevent foreign rows and forged configuration', async () => {
  const p = await profile();
  const otherTenant = randomUUID();
  await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,'Foreign profile','enterprise')", [
    otherTenant,
  ]);
  await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [
    otherTenant,
    adminId,
  ]);
  let foreignCookie = await login('admin@demo.local');
  const switched = await request(
    '/workspaces/switch',
    'POST',
    { tenant_id: otherTenant },
    foreignCookie,
  );
  assert.equal(switched.statusCode, 200);
  foreignCookie = String(switched.headers['set-cookie']).split(';')[0];
  const foreign = (await ok(prefix, 'POST', createInput(), foreignCookie, 201)).profile;
  const before = await snapshot();
  const hidden = await request(prefix + '/' + foreign.id);
  const nonexistent = await request(prefix + '/' + randomUUID());
  assert.equal(hidden.statusCode, 404);
  assert.equal(nonexistent.statusCode, 404);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE dyna_app');
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
    const visible = (await client.query('SELECT id FROM catalog_export_profiles ORDER BY id')).rows;
    assert.deepEqual(visible, [{ id: p.id }]);
    assert.equal(
      (
        await client.query('UPDATE catalog_export_profiles SET version=version+1 WHERE id=$1', [
          foreign.id,
        ])
      ).rowCount,
      0,
    );
    await assert.rejects(
      client.query('DELETE FROM catalog_export_profiles WHERE id=$1', [p.id]),
      (error: any) => error.code === '42501',
    );
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
  const rls = (
    await pool.query(
      "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='catalog_export_profiles'::regclass",
    )
  ).rows[0];
  assert.deepEqual(rls, { relrowsecurity: true, relforcerowsecurity: true });
  for (const bad of [
    definition({ format: null }),
    definition({ headers: { sku: 'Alias', name: 'alias' } }),
    definition({ headers: { credentials: 'Secret' } }),
    definition({ format: 'xml', headers: { sku: 'xmlRoot' } }),
    definition({ selection: 'selected', ids: [randomUUID()] }),
  ]) {
    await assert.rejects(
      pool.query('UPDATE catalog_export_profiles SET definition=$1,version=version+1 WHERE id=$2', [
        JSON.stringify(bad),
        p.id,
      ]),
      (error: any) => error.code === '23514',
    );
  }
  for (const sql of [
    "UPDATE catalog_export_profiles SET request_hash=repeat('a',64),version=version+1 WHERE id=$1",
    'UPDATE catalog_export_profiles SET client_key=gen_random_uuid(),version=version+1 WHERE id=$1',
    "UPDATE catalog_export_profiles SET initial_request=jsonb_set(initial_request,'{name}','\"Forged\"'),version=version+1 WHERE id=$1",
    'UPDATE catalog_export_profiles SET version=version+2 WHERE id=$1',
    'DELETE FROM catalog_export_profiles WHERE id=$1',
  ])
    await assert.rejects(pool.query(sql, [p.id]), (error: any) => error.code === '23514');
  await assert.rejects(
    pool.query(
      `INSERT INTO catalog_export_profiles(id,tenant_id,actor_id,client_key,request_hash,initial_request,name,definition)
    SELECT $1,tenant_id,$2,$3,request_hash,jsonb_build_object('name','Bad actor FK','definition',definition),'Bad actor FK',definition
    FROM catalog_export_profiles WHERE id=$4`,
      [randomUUID(), randomUUID(), randomUUID(), p.id],
    ),
    (error: any) => error.code === '23503',
  );
  const roundtrip = await pool.connect();
  try {
    await roundtrip.query('BEGIN');
    await roundtrip.query(
      'CREATE TEMP TABLE export_profile_roundtrip (LIKE catalog_export_profiles) ON COMMIT DROP',
    );
    const checks = (
      await roundtrip.query(`SELECT conname,pg_get_expr(conbin,conrelid) expression FROM pg_constraint
      WHERE conrelid='catalog_export_profiles'::regclass AND contype='c' ORDER BY conname`)
    ).rows;
    assert(checks.length >= 7);
    for (let n = 0; n < checks.length; ++n) {
      await roundtrip.query(
        `ALTER TABLE export_profile_roundtrip ADD CONSTRAINT check_${n} CHECK(${checks[n].expression})`,
      );
      const reparsed = (
        await roundtrip.query(
          "SELECT pg_get_expr(conbin,conrelid) expression FROM pg_constraint WHERE conrelid='pg_temp.export_profile_roundtrip'::regclass AND conname=$1",
          ['check_' + n],
        )
      ).rows[0].expression;
      assert.equal(
        reparsed,
        checks[n].expression,
        checks[n].conname + ' must survive backup deparse/reparse unchanged',
      );
    }
  } finally {
    await roundtrip.query('ROLLBACK');
    roundtrip.release();
  }
  assert.deepEqual(await snapshot(), before);
});

test('read-only profiles hide management and reject every write before malformed JSON while copied export remains readable', async () => {
  const p = await profile();
  const read = await key(['products:read']);
  let ro: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    ro = await buildApp({ readOnly: true, integrationTransport: transport });
    let cookie = await login('admin@demo.local', ro);
    const switched = await request('/workspaces/switch', 'POST', { tenant_id: tenant }, cookie, ro);
    assert.equal(switched.statusCode, 200);
    cookie = String(switched.headers['set-cookie']).split(';')[0];
    const before = await snapshot();
    for (const path of [prefix, prefix + '/' + p.id]) {
      const response = await request(path, 'GET', undefined, cookie, ro);
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().read_only, true);
      assert.equal(response.json().can_manage, false);
      const publicRead = await request('/v1' + path, 'GET', undefined, '', ro, {
        authorization: 'Bearer ' + read.token,
      });
      assert.equal(publicRead.statusCode, 200, publicRead.body);
      assert.equal(publicRead.json().can_manage, false);
    }
    for (const [path, method] of [
      [prefix, 'POST'],
      [prefix + '/' + p.id, 'PATCH'],
      [prefix + '/' + p.id + '/archive', 'POST'],
      [prefix + '/' + p.id + '/restore', 'POST'],
    ]) {
      const response = await request(path, method, '{', cookie, ro, {
        'content-type': 'application/json',
      });
      assert.equal(response.statusCode, 423, 'Readonly must reject before malformed-body parsing');
      assert.match(String(response.headers['cache-control']), /no-store/);
    }
    const exported = await request(
      '/v1/catalog/exports/file',
      'POST',
      {
        ...p.definition,
        selection: 'filtered',
      },
      '',
      ro,
      { authorization: 'Bearer ' + read.token },
    );
    assert.equal(exported.statusCode, 200, exported.body);
    assert.equal(exported.body.replace(/^\ufeff/, ''), '"SKU","Nazwa"\r\n');
    assert.deepEqual(await snapshot(), before);
  } finally {
    await ro?.close();
  }
});

test('copies without 096 expose unavailable profiles and 503 writes while the existing 114 exporter stays usable', async () => {
  let old: Awaited<ReturnType<typeof buildApp>> | undefined;
  let renamed = false;
  const p = await profile();
  const before = await snapshot();
  try {
    await pool.query(
      'ALTER TABLE catalog_export_profiles RENAME TO catalog_export_profiles_hidden_safety',
    );
    renamed = true;
    old = await buildApp({ integrationTransport: transport });
    const metadata = await request(prefix, 'GET', undefined, admin, old);
    assert.equal(metadata.statusCode, 200, metadata.body);
    assert.equal(metadata.json().available, false);
    assert.equal(metadata.json().can_manage, false);
    assert.deepEqual(metadata.json().data, []);
    for (const [path, method, body] of [
      [prefix, 'POST', createInput()],
      [
        prefix + '/' + p.id,
        'PATCH',
        { version: p.version, name: 'Old unavailable', definition: definition() },
      ],
      [prefix + '/' + p.id + '/archive', 'POST', { version: p.version }],
      [prefix + '/' + p.id + '/restore', 'POST', { version: p.version }],
    ] as const) {
      const response = await request(path, method, body, admin, old);
      assert.equal(response.statusCode, 503, response.body);
    }
    const file = await request(
      '/catalog/exports/file',
      'POST',
      {
        selection: 'filtered',
        format: 'csv',
        columns: ['sku', 'name'],
        spreadsheet_safe: false,
      },
      admin,
      old,
    );
    assert.equal(file.statusCode, 200, file.body);
    assert.equal(
      file.body,
      '"sku","name"\r\n',
      'Unconfigured 114 default column names/bytes remain exact',
    );
  } finally {
    await old?.close();
    if (renamed)
      await pool.query(
        'ALTER TABLE catalog_export_profiles_hidden_safety RENAME TO catalog_export_profiles',
      );
  }
  assert.deepEqual(await snapshot(), before);
  assert.equal(providerCalls, 0);
});

test('applying a profile copies its definition and later edits or archive cannot silently change the download', async () => {
  const p = await profile();
  const copied = JSON.parse(JSON.stringify(p.definition));
  const edited = await ok(prefix + '/' + p.id, 'PATCH', {
    version: p.version,
    name: 'Changed after application',
    definition: definition({
      headers: { sku: 'ChangedSKU', name: 'ChangedName' },
      spreadsheet_safe: false,
    }),
  });
  await ok(prefix + '/' + p.id + '/archive', 'POST', { version: edited.profile.version });
  const before = await snapshot();
  const file = await request('/catalog/exports/file', 'POST', { ...copied, selection: 'filtered' });
  assert.equal(file.statusCode, 200, file.body);
  assert.equal(file.body, '\ufeff"SKU","Nazwa"\r\n');
  const liveBinding = await request('/catalog/exports/file', 'POST', {
    ...copied,
    selection: 'filtered',
    profile_id: p.id,
  });
  assert.equal(liveBinding.statusCode, 422, 'No hidden profile reference is accepted by download');
  assert.deepEqual(await snapshot(), before);
});
