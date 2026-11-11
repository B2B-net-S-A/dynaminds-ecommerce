import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed } from './fixtures';
import { priceMatrixImportProfileInput } from '../server/price-matrix-import-schema';
import {
  createPriceBulkEditPreviewInTx,
  executePriceBulkEditInTx,
  priceBulkEditHash,
} from '../server/price-bulk-edit';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/dynaminds_test_\d+$/);
type Row = Record<string, any>;
let app: Awaited<ReturnType<typeof buildApp>>;
let admin = '',
  viewer = '',
  other = '',
  adminId = '',
  tenant = '',
  warehouse = '',
  address = 1;
const cookies = new Map<string, string>(),
  prefix = '/price-matrix-imports';
const transport = async () => {
  throw Error('Local price imports must not call any provider');
};
function req(
  path: string,
  method: any = 'GET',
  payload?: any,
  cookie = admin,
  target = app,
  headers: Row = {},
) {
  return target.inject({
    method,
    url: '/api' + path,
    payload,
    headers: { cookie, ...headers },
    remoteAddress: '127.3.113.' + address,
  });
}
async function ok(path: string, method: any = 'GET', payload?: any, cookie = admin, status = 200) {
  const r = await req(path, method, payload, cookie);
  assert.equal(r.statusCode, status, `${method} ${path}: ${r.body.slice(0, 600)}`);
  return r.json() as Row;
}
async function login(email: string, target = app) {
  const r = await req('/auth/login', 'POST', { email, password: 'DynaDemo!2026' }, '', target);
  assert.equal(r.statusCode, 200);
  return String(r.headers['set-cookie']).split(';')[0];
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({
    integrationTransport: transport,
    logging: process.env.PRICE_MATRIX_IMPORT_TEST_LOG === 'true',
  });
  for (const email of ['admin@demo.local', 'viewer@demo.local', 'other@demo.local'])
    cookies.set(email, await login(email));
  adminId = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
});
beforeEach(async () => {
  ++address;
  tenant = randomUUID();
  warehouse = randomUUID();
  await pool.query(
    "INSERT INTO tenants(id,name,plan) VALUES($1,'Price file adversarial','enterprise')",
    [tenant],
  );
  await pool.query(
    "INSERT INTO memberships(tenant_id,user_id,role) SELECT $1,id,CASE email WHEN 'viewer@demo.local' THEN 'viewer' ELSE 'admin' END FROM users WHERE email=ANY($2::text[])",
    [tenant, [...cookies.keys()]],
  );
  await pool.query(
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Price import warehouse','PI')",
    [warehouse, tenant],
  );
  // Prior adversarial cases may rotate a workspace session or withdraw its membership.
  // Authenticate a fresh seeded actor before entering this disposable test tenant.
  for (const email of cookies.keys()) {
    const cookie = await login(email);
    const r = await req('/workspaces/switch', 'POST', { tenant_id: tenant }, cookie);
    assert.equal(r.statusCode, 200);
    cookies.set(email, String(r.headers['set-cookie']).split(';')[0]);
  }
  admin = cookies.get('admin@demo.local')!;
  viewer = cookies.get('viewer@demo.local')!;
  other = cookies.get('other@demo.local')!;
});
after(async () => {
  try {
    await app?.close();
  } finally {
    await pool.end();
  }
});
const product = () =>
  ok(
    '/products',
    'POST',
    {
      sku: 'SAFE-' + randomUUID(),
      name: 'Own price item',
      price: 1500,
      vat: 23,
      quantity: 3,
      warehouse_id: warehouse,
    },
    admin,
    201,
  );
const list = (extra: Row = {}) =>
  ok(
    '/price-lists',
    'POST',
    { name: 'Matrix ' + randomUUID(), currency: 'PLN', fallback: true, ...extra },
    admin,
    201,
  );
const definition = (extra: Row = {}) => ({
  format: 'csv',
  delimiter: ';',
  identity: 'sku',
  mapping: { identity: 'sku', price: 'price' },
  amount_mode: 'decimal',
  decimal_separator: ',',
  basis: 'gross',
  empty_policy: 'skip',
  spreadsheet_safe: false,
  native_price_mode: 'mapped',
  ...extra,
});
const input = (p: Row, ls: Row[], extra: Row = {}) => ({
  client_key: randomUUID(),
  file_name: 'matrix.csv',
  content: `sku;pln;eur\r\n${p.sku};12,34;17,00\r\n`,
  targets: ls.map((l, i) => ({
    price_list_id: l.id,
    list_version: l.version,
    definition: definition({
      mapping: { identity: 'sku', price: i ? 'eur' : 'pln' },
      basis: i ? 'gross' : 'net',
    }),
  })),
  ...extra,
});
const consent = (p: Row) => ({
  client_key: randomUUID(),
  scope_hash: p.scope_hash,
  confirmed: true as const,
  ack_missing_price_list_ids: [],
});
const path = (p: Row) => prefix + '/previews/' + p.id + '/execute';
async function preview(b: Row, cookie = admin) {
  return (await ok(prefix + '/previews', 'POST', b, cookie, 201)).preview as Row;
}
async function pair() {
  return [await list(), await list({ currency: 'EUR', fallback: false })];
}
async function snapshot() {
  // Grant withdrawal is the explicit adversarial fixture change; every business/evidence table remains protected.
  const names = (
    await pool.query(`SELECT DISTINCT c.table_name FROM information_schema.columns c JOIN information_schema.tables t USING(table_schema,table_name)
    WHERE c.table_schema='public' AND c.column_name='tenant_id' AND t.table_type='BASE TABLE'
    AND c.table_name NOT IN ('memberships','api_keys','sessions') ORDER BY 1`)
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
  return result;
}
async function waitOn(holder: PoolClient) {
  const pid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid,
    deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const rows = (
      await pool.query(
        "SELECT query FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))",
        [pid],
      )
    ).rows;
    if (
      rows.some(
        (r) => /products|price_lists/i.test(r.query) && /FOR\s+(UPDATE|SHARE)/i.test(r.query),
      )
    )
      return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail('The file execution did not genuinely wait on the held own product/list row');
}
async function grantChange(sql: string, args: unknown[]) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL statement_timeout='1500ms'");
    await c.query(sql, args);
    await c.query('COMMIT');
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}
const publicReq = (token: string, path: string, method: any = 'GET', body?: any) =>
  req('/v1' + path, method, body, '', app, { authorization: 'Bearer ' + token });
const mint = (scopes: string[]) =>
  ok('/developer/keys', 'POST', { name: 'Price file scoped key', scopes }, admin, 201);

test('strict target agreement and hostile XML/JSON cannot create partial matrix or price evidence', async () => {
  const p = await product(),
    ls = await pair(),
    body = input(p, ls),
    before = await snapshot();
  const attacks = [
    { ...body, targets: [body.targets[0]] },
    { ...body, targets: [body.targets[0], body.targets[0]] },
    {
      ...body,
      targets: body.targets.map((t: Row, i: number) => ({
        ...t,
        definition: { ...t.definition, ...(i ? { identity: 'ean' } : {}) },
      })),
    },
    { ...body, secret: 'denied' },
  ];
  for (const v of attacks) {
    const r = await req(prefix + '/previews', 'POST', v);
    assert.equal(r.statusCode, 422, r.body);
    assert.match(String(r.headers['cache-control']), /no-store/);
    assert.deepEqual(await snapshot(), before);
  }
  for (const content of [
    '<!DOCTYPE catalog [<!ENTITY x SYSTEM "file:///etc/passwd">]><catalog currency="PLN"/>',
    '<catalog>' + '<x>'.repeat(17) + 'bad' + '</x>'.repeat(17) + '</catalog>',
    '<catalog><constructor type="string">bad</constructor></catalog>',
  ]) {
    const r = await req(prefix + '/previews', 'POST', {
      ...body,
      content,
      targets: body.targets.map((t: Row) => ({
        ...t,
        definition: { ...t.definition, format: 'xml' },
      })),
    });
    assert.equal(r.statusCode, 422, r.body);
    assert.deepEqual(await snapshot(), before);
  }
  const proto = await req(
    prefix + '/previews',
    'POST',
    JSON.stringify({
      ...body,
      targets: body.targets.map((t: Row) => ({
        ...t,
        definition: {
          ...t.definition,
          mapping: JSON.parse('{"identity":"sku","price":"pln","__proto__":"bad"}'),
        },
      })),
    }),
    admin,
    app,
    { 'content-type': 'application/json' },
  );
  assert.equal(proto.statusCode, 400);
  assert.deepEqual(await snapshot(), before);
  assert.equal(
    (await req(prefix + '/previews', 'POST', { ...body, content: 'ą'.repeat(1100000) })).statusCode,
    413,
  );
  assert.deepEqual(await snapshot(), before);
});

test('viewer, incomplete public scopes and different actor or API key cannot execute an approved matrix', async () => {
  const p = await product(),
    ls = await pair(),
    body = input(p, ls),
    made = await preview(body),
    keys = [];
  for (const scopes of [
    ['products:read'],
    ['products:write'],
    ['products:read', 'products:write'],
    ['products:read', 'products:write'],
  ])
    keys.push(await mint(scopes));
  const before = await snapshot();
  assert.equal((await ok(prefix + '/options', 'GET', undefined, viewer)).can_write, false);
  assert.equal(
    (await req(prefix + '/previews', 'POST', { ...body, client_key: randomUUID() }, viewer))
      .statusCode,
    403,
  );
  assert.equal((await req(path(made), 'POST', consent(made), other)).statusCode, 409);
  for (const k of keys.slice(0, 2))
    assert.equal(
      (
        await publicReq(k.token, prefix + '/previews', 'POST', {
          ...body,
          client_key: randomUUID(),
        })
      ).statusCode,
      403,
    );
  assert.deepEqual(await snapshot(), before);
  const r = await publicReq(keys[2].token, prefix + '/previews', 'POST', {
    ...body,
    client_key: randomUUID(),
  });
  assert.equal(r.statusCode, 201, r.body);
  const accepted = await snapshot();
  assert.equal(
    (await publicReq(keys[3].token, path(r.json().preview), 'POST', consent(r.json().preview)))
      .statusCode,
    409,
  );
  assert.deepEqual(await snapshot(), accepted);
});

test('foreign price lists and evidence are hidden by HTTP and FORCE RLS, never partially accepted as matrix targets', async () => {
  const p = await product(),
    ls = await pair(),
    body = input(p, ls),
    made = await preview(body),
    foreign = randomUUID();
  await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,'Alien matrix','enterprise')", [
    foreign,
  ]);
  await pool.query(
    "INSERT INTO memberships(tenant_id,user_id,role) SELECT $1,id,'admin' FROM users WHERE email='other@demo.local'",
    [foreign],
  );
  const switched = await req('/workspaces/switch', 'POST', { tenant_id: foreign }, other);
  assert.equal(switched.statusCode, 200);
  const fc = String(switched.headers['set-cookie']).split(';')[0],
    alien = await ok(
      '/price-lists',
      'POST',
      { name: 'Alien', currency: 'EUR', fallback: false },
      fc,
      201,
    ),
    before = await snapshot();
  assert.equal((await req(prefix + '/previews/' + made.id, 'GET', undefined, fc)).statusCode, 404);
  assert.equal(
    (
      await req(prefix + '/previews', 'POST', {
        ...body,
        client_key: randomUUID(),
        targets: [
          body.targets[0],
          { ...body.targets[1], price_list_id: alien.id, list_version: alien.version },
        ],
      })
    ).statusCode,
    404,
  );
  await tenantTx(foreign, async (c) => {
    assert.equal(
      (await c.query('SELECT id FROM price_matrix_import_previews WHERE id=$1', [made.id]))
        .rowCount,
      0,
    );
  });
  assert.deepEqual(await snapshot(), before);
});

test(
  'member downgrade commits while matrix waits on its product and rolls back every list, receipt and audit',
  { timeout: 30000 },
  async () => {
    const p = await product(),
      ls = await pair(),
      made = await preview(input(p, ls)),
      before = await snapshot(),
      holder = await pool.connect();
    let pending: ReturnType<typeof req> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM products WHERE id=$1 FOR UPDATE', [p.id]);
      pending = req(path(made), 'POST', consent(made));
      await waitOn(holder);
      await grantChange("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
        tenant,
        adminId,
      ]);
      await holder.query('COMMIT');
      assert.equal((await pending).statusCode, 403);
      assert.deepEqual(await snapshot(), before);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      await pending;
      await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
        tenant,
        adminId,
      ]);
    }
  },
);

test(
  'revoke, expiry and scope withdrawal after real held list lock roll back all matrix writes',
  { timeout: 45000 },
  async () => {
    for (const change of ['revoke', 'expiry', 'scope']) {
      const p = await product(),
        ls = await pair(),
        key = await mint(['products:read', 'products:write']);
      assert.equal((await publicReq(key.token, prefix + '/options')).statusCode, 200);
      const r = await publicReq(key.token, prefix + '/previews', 'POST', input(p, ls));
      assert.equal(r.statusCode, 201, r.body);
      const made = r.json().preview,
        before = await snapshot(),
        holder = await pool.connect();
      let pending: ReturnType<typeof publicReq> | undefined;
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM price_lists WHERE id=$1 FOR UPDATE', [ls[1].id]);
        pending = publicReq(key.token, path(made), 'POST', consent(made));
        await waitOn(holder);
        await grantChange(
          change === 'revoke'
            ? 'UPDATE api_keys SET revoked_at=now() WHERE id=$1'
            : change === 'expiry'
              ? "UPDATE api_keys SET expires_at=now()-interval '1 second' WHERE id=$1"
              : "UPDATE api_keys SET scopes=ARRAY['products:read']::text[] WHERE id=$1",
          [key.id],
        );
        await holder.query('COMMIT');
        assert.equal((await pending).statusCode, change === 'scope' ? 403 : 401);
        assert.deepEqual(await snapshot(), before);
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
        await pending;
      }
    }
  },
);

test('manual108 and file113 cannot bypass either linked core of a matrix; only one complete matrix receipt authorizes both', async () => {
  const p = await product(),
    ls = await pair(),
    made = await preview(input(p, ls)),
    before = await snapshot();
  for (const t of made.targets) {
    assert(t.core_preview_id);
    const core = (
      await pool.query('SELECT * FROM price_bulk_edit_previews WHERE id=$1', [t.core_preview_id])
    ).rows[0];
    assert.equal(
      (
        await req('/price-bulk-edit/previews/' + core.id + '/execute', 'POST', {
          client_key: randomUUID(),
          scope_hash: core.scope_hash,
          confirmed: true,
          ack_missing_prices: false,
        })
      ).statusCode,
      409,
    );
    assert.deepEqual(await snapshot(), before);
    await assert.rejects(
      tenantTx(tenant, (c) =>
        executePriceBulkEditInTx(
          c,
          { tenantId: tenant, userId: adminId, role: 'admin' },
          core.id,
          {
            client_key: randomUUID(),
            scope_hash: core.scope_hash,
            confirmed: true,
            ack_missing_prices: false,
          },
          'manual',
          { fileImportId: made.id },
        ),
      ),
      (e: any) => e.status === 409 && /macierzy/.test(e.message),
    );
    assert.deepEqual(await snapshot(), before);
  }
  // A file113 has its own immutable scope. Pointing its URL at a matrix UUID cannot approve the matrix.
  assert.equal(
    (
      await req('/price-file-imports/previews/' + made.id + '/execute', 'POST', {
        client_key: randomUUID(),
        scope_hash: made.scope_hash,
        confirmed: true,
        ack_missing_prices: false,
      })
    ).statusCode,
    404,
  );
  assert.deepEqual(await snapshot(), before);
  const done = await ok(path(made), 'POST', consent(made), admin, 201);
  assert.equal(done.execution.core_execution_ids.length, 2);
  for (const target of done.execution.core_execution_ids) {
    const core = (
      await pool.query('SELECT * FROM price_bulk_edit_executions WHERE id=$1', [
        target.core_execution_id,
      ])
    ).rows[0];
    assert.equal(core.actor_id, adminId);
    assert.equal(core.price_list_id, target.price_list_id);
    assert(made.targets.some((t: Row) => t.core_preview_id === core.preview_id));
  }
});

test(
  'one hundred complete matrix mapping profiles are the actual SQL quota; the 101st cannot add a revision or audit',
  { timeout: 30000 },
  async () => {
    const ls = await pair(),
      targets = input({ sku: 'unused' }, ls).targets.map(({ list_version, ...t }: Row) => t);
    // Exercise the production SQL quota instead of the per-IP HTTP rate limit.
    await tenantTx(tenant, async (c) => {
      for (let i = 0; i < 100; i++) {
        const body = priceMatrixImportProfileInput.parse({
          client_key: randomUUID(),
          name: 'Bounded matrix ' + i,
          targets,
        });
        await c.query('SELECT price_matrix_import_store_profile($1,$2,$3)', [
          JSON.stringify({
            ...body,
            id: randomUUID(),
            request_hash: priceBulkEditHash({
              actor_id: adminId,
              api_key_id: null,
              request: { id: null, body },
            }),
          }),
          adminId,
          null,
        ]);
      }
    });
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int n FROM price_matrix_import_profiles WHERE tenant_id=$1',
          [tenant],
        )
      ).rows[0].n,
      100,
    );
    const before = await snapshot(),
      r = await req(prefix + '/profiles', 'POST', {
        client_key: randomUUID(),
        name: 'Overflow',
        targets,
      });
    assert.equal(r.statusCode, 429, r.body);
    assert.deepEqual(await snapshot(), before);
  },
);

test('public OpenAPI thirteen operations and live matrix routes preserve strict schemas, limits and compound scopes', async () => {
  const p = await product(),
    ls = await pair(),
    key = await mint(['products:read', 'products:write']),
    doc = (await ok('/developer/openapi')).paths as Row;
  const ops = Object.entries(doc)
    .filter(([url]) => url.includes('/price-matrix-imports/'))
    .flatMap(([url, methods]) =>
      Object.entries(methods as Row)
        .filter(([m]) => ['get', 'post', 'patch'].includes(m))
        .map(([method, value]) => ({ url, method, v: value as Row })),
    );
  assert.equal(ops.length, 13);
  for (const { method, v } of ops) {
    assert.deepEqual(
      v['x-required-scopes'],
      method === 'get' ? ['products:read'] : ['products:read', 'products:write'],
    );
    assert.equal(v['x-price-matrix-import-limits'].products, 500);
    assert.equal(v['x-price-matrix-import-limits'].cells, 4000);
    assert.equal(v['x-price-matrix-import-limits'].lists, 8);
    if (method !== 'get')
      assert.equal(v.requestBody.content['application/json'].schema.additionalProperties, false);
  }
  assert.equal((await publicReq(key.token, prefix + '/options')).statusCode, 200);
  const body = input(p, ls),
    r = await publicReq(key.token, prefix + '/previews', 'POST', body);
  assert.equal(r.statusCode, 201, r.body);
  const made = r.json().preview,
    before = await snapshot();
  assert.equal(
    (
      await publicReq(key.token, prefix + '/previews', 'POST', {
        ...body,
        client_key: randomUUID(),
        unknown: 'rejected',
      })
    ).statusCode,
    422,
  );
  assert.equal((await publicReq(key.token, prefix + '/options?unknown=1')).statusCode, 422);
  assert.deepEqual(await snapshot(), before);
  const done = await publicReq(key.token, path(made), 'POST', consent(made));
  assert.equal(done.statusCode, 201, done.body);
  for (const url of [
    prefix + '/previews',
    prefix + '/previews/' + made.id,
    prefix + '/previews/' + made.id + '/rows',
    prefix + '/executions',
    prefix + '/executions/' + done.json().execution.id,
    prefix + '/executions/' + done.json().execution.id + '/rows',
  ])
    assert.equal((await publicReq(key.token, url)).statusCode, 200);
});

test('readOnly refuses all malformed mutations before parse; torn114 returns neutral options and preserves old108/113 reads', async () => {
  const p = await product(),
    ls = await pair(),
    made = await preview(input(p, ls)),
    profile = (
      await ok(
        prefix + '/profiles',
        'POST',
        {
          client_key: randomUUID(),
          name: 'Read only profile',
          targets: input(p, ls).targets.map(({ list_version, ...t }: Row) => t),
        },
        admin,
        201,
      )
    ).profile;
  async function enter(target: Awaited<ReturnType<typeof buildApp>>) {
    const c = await login('admin@demo.local', target),
      r = await req('/workspaces/switch', 'POST', { tenant_id: tenant }, c, target);
    assert.equal(r.statusCode, 200);
    return String(r.headers['set-cookie']).split(';')[0];
  }
  const ro = await buildApp({ readOnly: true, integrationTransport: transport });
  try {
    const cookie = await enter(ro),
      before = await snapshot();
    assert.equal(
      (await req(prefix + '/previews/' + made.id, 'GET', undefined, cookie, ro)).statusCode,
      200,
    );
    for (const [url, method] of [
      [prefix + '/previews', 'POST'],
      [path(made), 'POST'],
      [prefix + '/profiles', 'POST'],
      [prefix + '/profiles/' + profile.id, 'PATCH'],
    ]) {
      const r = await req(url, method, '{', cookie, ro, { 'content-type': 'application/json' });
      assert.equal(r.statusCode, 423);
      assert.match(String(r.headers['cache-control']), /no-store/);
    }
    assert.deepEqual(await snapshot(), before);
  } finally {
    await ro.close();
  }
  await pool.query(
    'ALTER TABLE price_matrix_import_executions RENAME TO price_matrix_import_executions_hidden_test',
  );
  let old: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    old = await buildApp({ integrationTransport: transport });
    const cookie = await enter(old),
      before = await snapshot();
    const opts = await req(prefix + '/options', 'GET', undefined, cookie, old);
    assert.equal(opts.statusCode, 200);
    assert.equal(opts.json().available, false);
    assert.equal(
      (
        await req(prefix + '/previews', 'POST', '{', cookie, old, {
          'content-type': 'application/json',
        })
      ).statusCode,
      503,
    );
    assert.equal((await req('/price-bulk-edit', 'GET', undefined, cookie, old)).statusCode, 200);
    assert.equal(
      (await req('/price-file-imports/options', 'GET', undefined, cookie, old)).statusCode,
      200,
    );
    assert.deepEqual(await snapshot(), before);
  } finally {
    try {
      await old?.close();
    } finally {
      await pool.query(
        'ALTER TABLE price_matrix_import_executions_hidden_test RENAME TO price_matrix_import_executions',
      );
    }
  }
});

function matrixPayload(row: Row, patch: Row = {}) {
  const {
    id,
    client_key,
    request_hash,
    file_name,
    source_hash,
    source,
    targets,
    rows,
    warnings,
    summary,
  } = row;
  const value = {
    id,
    client_key,
    request_hash,
    file_name,
    source_hash,
    source,
    targets,
    rows,
    warnings,
    summary,
    ...patch,
  };
  return { ...value, scope_hash: priceBulkEditHash(value) };
}
const storeMatrix = (c: PoolClient, value: Row) =>
  c.query('SELECT price_matrix_import_store_preview($1,$2,$3)', [
    JSON.stringify(value),
    adminId,
    null,
  ]);

test('SQL matrix evidence is FORCE RLS/immutable/private and genuine new cores cannot certify forged money or incomplete targets', async () => {
  const p = await product(),
    ls = await pair(),
    made = await preview(input(p, ls)),
    row = (await pool.query('SELECT * FROM price_matrix_import_previews WHERE id=$1', [made.id]))
      .rows[0],
    before = await snapshot();
  for (const table of [
    'price_matrix_import_previews',
    'price_matrix_import_executions',
    'price_matrix_import_profiles',
    'price_matrix_import_profile_revisions',
    'price_matrix_import_core_witnesses',
    'price_matrix_import_targets',
    'price_matrix_import_execution_targets',
  ]) {
    assert.deepEqual(
      (
        await pool.query(
          'SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',
          [table],
        )
      ).rows[0],
      { relrowsecurity: true, relforcerowsecurity: true },
    );
    assert.equal(
      (await pool.query("SELECT has_table_privilege('dyna_app',$1,'INSERT') allowed", [table]))
        .rows[0].allowed,
      false,
    );
  }
  await assert.rejects(
    tenantTx(tenant, (c) => c.query('SELECT * FROM price_matrix_import_core_witnesses')),
    (e: any) => e.code === '42501',
  );
  await assert.rejects(
    pool.query('UPDATE price_matrix_import_previews SET file_name=$2 WHERE id=$1', [
      made.id,
      'forged.csv',
    ]),
    (e: any) => e.code === '23514',
  );
  await assert.rejects(
    tenantTx(tenant, (c) =>
      storeMatrix(c, matrixPayload(row, { id: randomUUID(), client_key: randomUUID() })),
    ),
    (e: any) => e.code === '23514',
  );
  assert.deepEqual(await snapshot(), before);
  for (const attack of ['money', 'identity', 'missing-target']) {
    let reachedStore = false;
    await assert.rejects(
      tenantTx(tenant, async (c) => {
        const actor = { tenantId: tenant, userId: adminId, role: 'admin' as const },
          targets: Row[] = [],
          matrixId = randomUUID();
        // Both typed core creations and their current transaction certificates are genuine.
        for (const t of row.targets) {
          const client_key = randomUUID(),
            l = ls.find((l) => l.id === t.price_list_id)!;
          const core = (
            await createPriceBulkEditPreviewInTx(c, actor, {
              client_key,
              price_list_id: l.id,
              list_version: l.version,
              rows: [
                {
                  product_id: p.id,
                  product_version: p.version,
                  operation: 'set',
                  basis: t.definition.basis,
                  amount_minor: l.id === ls[0].id ? 1234 : 1700,
                },
              ],
            })
          ).preview;
          const dbcore = (
            await c.query('SELECT * FROM price_bulk_edit_previews WHERE id=$1', [core.id])
          ).rows[0];
          targets.push({
            ...t,
            core_preview_id: core.id,
            core_client_key: client_key,
            list_snapshot: dbcore.list_snapshot,
            repricing_snapshot: dbcore.repricing_snapshot,
            warnings: dbcore.warnings,
          });
        }
        const request = input(p, ls, { client_key: randomUUID() }),
          rows = structuredClone(row.rows);
        if (attack === 'money') {
          rows[0].raw_cells.eur = '999,00';
          request.content = `sku;pln;eur\r\n${p.sku};12,34;999,00\r\n`;
        }
        if (attack === 'identity') {
          rows[0].raw_cells.sku = 'forged-sku';
          request.content = 'sku;pln;eur\r\nforged-sku;12,34;17,00\r\n';
        }
        request.targets.sort((a: Row, b: Row) => a.price_list_id.localeCompare(b.price_list_id));
        const payload = matrixPayload(row, {
          id: matrixId,
          client_key: request.client_key,
          request_hash: priceBulkEditHash({ actor_id: adminId, api_key_id: null, request }),
          source_hash: createHash('sha256').update(request.content).digest('hex'),
          targets: attack === 'missing-target' ? targets.slice(0, 1) : targets,
          rows,
        });
        reachedStore = true;
        await storeMatrix(c, payload);
      }),
      (e: any) =>
        e.code === '23514' &&
        (attack === 'missing-target' ||
          e.message ===
            (attack === 'money'
              ? 'Źródłowa cena różni się od zatwierdzonej'
              : 'Źródłowy identyfikator różni się od rozwiązania')),
    );
    assert.equal(
      reachedStore,
      true,
      'Reject the actual typed store after genuine two-core creation, not a malformed earlier request',
    );
    assert.deepEqual(await snapshot(), before);
  }
});

test('same-transaction completeness rejects one-core receipts and a genuine two-core flush seals both lists against late raw writes', async () => {
  const p = await product(),
    ls = await pair(),
    made = await preview(input(p, ls)),
    row = (await pool.query('SELECT * FROM price_matrix_import_previews WHERE id=$1', [made.id]))
      .rows[0],
    before = await snapshot();
  async function commitMatrix(c: PoolClient, omitSecond: boolean) {
    const body = consent(made),
      actor = { tenantId: tenant, userId: adminId, role: 'admin' as const },
      ids: Row[] = [];
    await c.query('SELECT price_matrix_import_prepare_execution($1,$2,$3)', [
      made.id,
      adminId,
      null,
    ]);
    for (const t of row.targets) {
      const cp = (
        await c.query('SELECT * FROM price_bulk_edit_previews WHERE id=$1', [t.core_preview_id])
      ).rows[0];
      const result = await executePriceBulkEditInTx(
        c,
        actor,
        cp.id,
        {
          client_key: randomUUID(),
          scope_hash: cp.scope_hash,
          confirmed: true,
          ack_missing_prices: false,
        },
        'manual',
        { matrixImportId: made.id },
      );
      ids.push({ price_list_id: t.price_list_id, core_execution_id: result.execution.id });
      if (omitSecond) break;
    }
    const payload = {
      id: randomUUID(),
      preview_id: made.id,
      client_key: body.client_key,
      scope_hash: made.scope_hash,
      request_hash: priceBulkEditHash({
        actor_id: adminId,
        api_key_id: null,
        request: { preview_id: made.id, ...body },
      }),
      core_execution_ids: ids,
      ack_missing_price_list_ids: [],
    };
    if (omitSecond) reachedPartial = true;
    await c.query('SELECT price_matrix_import_store_execution($1,$2,$3)', [
      JSON.stringify(payload),
      adminId,
      null,
    ]);
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
  }
  let reachedPartial = false;
  await assert.rejects(
    tenantTx(tenant, async (c) => {
      await commitMatrix(c, true);
    }),
    (e: any) => e.code === '23514',
  );
  assert.equal(reachedPartial, true);
  assert.deepEqual(await snapshot(), before);
  let reachedFlush = false;
  await assert.rejects(
    tenantTx(tenant, async (c) => {
      await commitMatrix(c, false);
      reachedFlush = true;
      await c.query(
        'UPDATE price_list_items SET price=999 WHERE tenant_id=$1 AND price_list_id=$2 AND product_id=$3',
        [tenant, ls[1].id, p.id],
      );
    }),
    (e: any) => e.code === '23514',
  );
  assert.equal(
    reachedFlush,
    true,
    'Both genuine cores and matrix receipt must pass deferred validation before testing a later write',
  );
  assert.deepEqual(await snapshot(), before);
  // Owner setup has genuine foreign FK targets. Reassigning the row must still seal OLD own scope.
  const foreign = randomUUID(),
    foreignList = randomUUID(),
    foreignProduct = randomUUID();
  await pool.query(
    "INSERT INTO tenants(id,name,plan) VALUES($1,'Owner seal foreign','enterprise')",
    [foreign],
  );
  await pool.query(
    "INSERT INTO products(id,tenant_id,sku,name,price) VALUES($1,$2,$3,'Foreign seal product',100)",
    [foreignProduct, foreign, 'SEAL-' + randomUUID()],
  );
  await pool.query(
    "INSERT INTO price_lists(id,tenant_id,name,currency,fallback) VALUES($1,$2,'Foreign seal list','EUR',false)",
    [foreignList, foreign],
  );
  const owner = await pool.connect();
  let reachedOwnerFlush = false;
  try {
    await owner.query('BEGIN');
    await owner.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
    await assert.rejects(
      (async () => {
        await commitMatrix(owner, false);
        reachedOwnerFlush = true;
        await owner.query(
          'UPDATE price_list_items SET tenant_id=$1,price_list_id=$2,product_id=$3 WHERE tenant_id=$4 AND price_list_id=$5 AND product_id=$6',
          [foreign, foreignList, foreignProduct, tenant, ls[1].id, p.id],
        );
      })(),
      (e: any) =>
        e.code === '23514' &&
        e.message ===
          'Nie można zmienić źródeł cen po zatwierdzonym wykonaniu macierzy w tej transakcji',
    );
  } finally {
    await owner.query('ROLLBACK');
    owner.release();
  }
  assert.equal(
    reachedOwnerFlush,
    true,
    'Owner path must flush a genuine receipt before reassignment',
  );
  assert.deepEqual(await snapshot(), before);
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM price_list_items WHERE tenant_id=$1', [foreign]))
      .rows[0].n,
    0,
  );
});
