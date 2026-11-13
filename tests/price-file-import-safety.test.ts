import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed } from './fixtures';
import { withoutApiKeyLastUse } from './api-key-last-use';
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
  prefix = '/price-file-imports';
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
    logging: process.env.PRICE_FILE_IMPORT_TEST_LOG === 'true',
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
const list = () =>
  ok(
    '/price-lists',
    'POST',
    { name: 'Safe ' + randomUUID(), currency: 'PLN', fallback: true },
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
const input = (p: Row, l: Row, extra: Row = {}) => ({
  client_key: randomUUID(),
  price_list_id: l.id,
  list_version: l.version,
  file_name: 'safe.csv',
  content: `sku;price\r\n${p.sku};12,34\r\n`,
  definition: definition(),
  ...extra,
});
const consent = (p: Row) => ({
  client_key: randomUUID(),
  scope_hash: p.scope_hash,
  confirmed: true as const,
  ack_missing_prices: false,
});
const path = (p: Row) => prefix + '/previews/' + p.id + '/execute';
async function preview(b: Row, cookie = admin) {
  return (await ok(prefix + '/previews', 'POST', b, cookie, 201)).preview as Row;
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
  return withoutApiKeyLastUse(result);
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
function filePayload(row: Row, patch: Row = {}) {
  const {
    id,
    client_key,
    request_hash,
    price_list_id,
    file_name,
    source_hash,
    source,
    definition,
    list_snapshot,
    warnings,
    summary,
    rows,
    core_preview_id,
  } = row;
  const payload = {
    id,
    client_key,
    request_hash,
    price_list_id,
    file_name,
    source_hash,
    source,
    definition,
    list_snapshot,
    warnings,
    summary,
    rows,
    core_preview_id,
    ...patch,
  };
  return { ...payload, scope_hash: priceBulkEditHash(payload) };
}
const store = (c: PoolClient, v: Row) =>
  c.query('SELECT price_file_import_store_preview($1,$2,$3)', [JSON.stringify(v), adminId, null]);

test('malicious XML, prototype fields, byte limits and noncanonical money never partially write file or core evidence', async () => {
  const p = await product(),
    l = await list(),
    base = input(p, l),
    before = await snapshot();
  for (const content of [
    '<!DOCTYPE catalog [<!ENTITY x SYSTEM "file:///etc/passwd">]><catalog currency="PLN"/>',
    '<catalog currency="PLN">' + '<x>'.repeat(17) + 'bad' + '</x>'.repeat(17) + '</catalog>',
    '<catalog currency="PLN"><constructor type="string">bad</constructor></catalog>',
  ]) {
    const r = await req(prefix + '/previews', 'POST', {
      ...base,
      client_key: randomUUID(),
      content,
      definition: definition({ format: 'xml' }),
    });
    assert.equal(r.statusCode, 422);
    assert.match(String(r.headers['cache-control']), /no-store/);
    assert.deepEqual(await snapshot(), before);
  }
  const tooLarge = await req(prefix + '/previews', 'POST', {
    ...base,
    content: 'ą'.repeat(1100000),
  });
  assert.equal(tooLarge.statusCode, 413);
  assert.deepEqual(await snapshot(), before);
  const proto = await req(
    prefix + '/previews',
    'POST',
    JSON.stringify({
      ...base,
      definition: {
        ...base.definition,
        mapping: JSON.parse('{"identity":"sku","price":"price","__proto__":"bad"}'),
      },
    }),
    admin,
    app,
    { 'content-type': 'application/json' },
  );
  assert.equal(proto.statusCode, 400);
  assert.deepEqual(await snapshot(), before);
  for (const value of ['1e2', 'NaN', '-1', '1,001', '1.234,00', '1000000,01']) {
    const made = await preview({
      ...base,
      client_key: randomUUID(),
      content: `sku;price\r\n${p.sku};${value}\r\n`,
    });
    assert.equal(made.summary.ready, false);
    const frozen = await snapshot();
    assert.equal((await req(path(made), 'POST', consent(made))).statusCode, 409);
    assert.deepEqual(await snapshot(), frozen);
  }
});

test('viewer and compound API scopes, actor-bound retry and cross-tenant IDs cannot authorize a price file write', async () => {
  const p = await product(),
    l = await list(),
    body = input(p, l),
    made = await preview(body);
  const keys = [];
  for (const scopes of [['products:read'], ['products:write']]) keys.push(await mint(scopes));
  const before = await snapshot();
  assert.equal((await ok(prefix + '/options', 'GET', undefined, viewer)).can_write, false);
  assert.equal(
    (await req(prefix + '/previews', 'POST', { ...body, client_key: randomUUID() }, viewer))
      .statusCode,
    403,
  );
  assert.equal((await req(path(made), 'POST', consent(made), other)).statusCode, 409);
  for (const k of keys) {
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
  }
  const foreign = randomUUID();
  await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,'Foreign file','enterprise')", [
    foreign,
  ]);
  await pool.query(
    "INSERT INTO memberships(tenant_id,user_id,role) SELECT $1,id,'admin' FROM users WHERE email='other@demo.local'",
    [foreign],
  );
  const switched = await req('/workspaces/switch', 'POST', { tenant_id: foreign }, other);
  assert.equal(switched.statusCode, 200);
  const foreignCookie = String(switched.headers['set-cookie']).split(';')[0];
  const alien = await ok(
    '/price-lists',
    'POST',
    { name: 'Foreign list', currency: 'PLN', fallback: true },
    foreignCookie,
    201,
  );
  assert.equal(
    (await req(prefix + '/previews/' + made.id, 'GET', undefined, foreignCookie)).statusCode,
    404,
  );
  assert.equal(
    (
      await req(prefix + '/previews', 'POST', {
        ...body,
        client_key: randomUUID(),
        price_list_id: alien.id,
      })
    ).statusCode,
    404,
  );
  await tenantTx(foreign, async (c) => {
    assert.equal(
      (await c.query('SELECT id FROM price_file_import_previews WHERE id=$1', [made.id])).rowCount,
      0,
    );
    await assert.rejects(
      c.query(
        'INSERT INTO price_file_import_previews SELECT(jsonb_populate_record(NULL::price_file_import_previews,$1::jsonb)).*',
        [
          JSON.stringify(
            (
              await pool.query(
                'SELECT to_jsonb(p) p FROM price_file_import_previews p WHERE id=$1',
                [made.id],
              )
            ).rows[0].p,
          ),
        ],
      ),
      (e: any) => e.code === '42501',
    );
  });
  assert.deepEqual(await snapshot(), before);
  const first = await mint(['products:read', 'products:write']),
    second = await mint(['products:read', 'products:write']);
  const publicPreview = await publicReq(first.token, prefix + '/previews', 'POST', {
    ...body,
    client_key: randomUUID(),
  });
  assert.equal(publicPreview.statusCode, 201, publicPreview.body);
  const apiPlan = publicPreview.json().preview,
    approvedByFirst = await snapshot();
  assert.equal(
    (await publicReq(second.token, path(apiPlan), 'POST', consent(apiPlan))).statusCode,
    409,
  );
  assert.deepEqual(await snapshot(), approvedByFirst);
});

test(
  'membership withdrawal commits during a real product wait and rolls back both metadata and price core writes',
  { timeout: 30000 },
  async () => {
    const p = await product(),
      l = await list(),
      made = await preview(input(p, l)),
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
  'current API key revoke, expiry and lost write scope are checked after the genuine held price list',
  { timeout: 45000 },
  async () => {
    for (const change of ['revoke', 'expiry', 'scope']) {
      const p = await product(),
        l = await list(),
        k = await mint(['products:read', 'products:write']);
      assert.equal((await publicReq(k.token, prefix + '/options')).statusCode, 200);
      const r = await publicReq(k.token, prefix + '/previews', 'POST', input(p, l));
      assert.equal(r.statusCode, 201, r.body);
      const made = r.json().preview,
        before = await snapshot(),
        holder = await pool.connect();
      let pending: ReturnType<typeof publicReq> | undefined;
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM price_lists WHERE id=$1 FOR UPDATE', [l.id]);
        pending = publicReq(k.token, path(made), 'POST', consent(made));
        await waitOn(holder);
        await grantChange(
          change === 'revoke'
            ? 'UPDATE api_keys SET revoked_at=now() WHERE id=$1'
            : change === 'expiry'
              ? "UPDATE api_keys SET expires_at=now()-interval '1 second' WHERE id=$1"
              : "UPDATE api_keys SET scopes=ARRAY['products:read']::text[] WHERE id=$1",
          [k.id],
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

test('linked file core previews cannot be executed through manual108; successful file and core receipts commit exactly together', async () => {
  const p = await product(),
    l = await list(),
    made = await preview(input(p, l));
  const head = (await pool.query('SELECT * FROM price_file_import_previews WHERE id=$1', [made.id]))
    .rows[0];
  assert(head.core_preview_id);
  const core = (
    await pool.query('SELECT * FROM price_bulk_edit_previews WHERE id=$1', [head.core_preview_id])
  ).rows[0];
  const before = await snapshot();
  assert.equal(
    (await req('/price-bulk-edit/previews/' + core.id + '/execute', 'POST', consent(core)))
      .statusCode,
    409,
  );
  assert.deepEqual(await snapshot(), before);
  const done = await ok(path(made), 'POST', consent(made), admin, 201);
  const pair = (
    await pool.query(
      `SELECT f.actor_id,p.price_list_id,f.preview_id,c.actor_id core_actor,c.price_list_id core_list,c.preview_id core_preview FROM price_file_import_executions f JOIN price_file_import_previews p ON (p.tenant_id,p.id)=(f.tenant_id,f.preview_id) JOIN price_bulk_edit_executions c ON (c.tenant_id,c.id)=(f.tenant_id,f.core_execution_id) WHERE f.id=$1`,
      [done.execution.id],
    )
  ).rows[0];
  assert.equal(pair.actor_id, pair.core_actor);
  assert.equal(pair.price_list_id, pair.core_list);
  assert.equal(pair.preview_id, made.id);
  assert.equal(pair.core_preview, head.core_preview_id);
});

test('SQL immutable/FORCE RLS evidence refuses unrelated core, forged source cells and mutation after a genuine deferred flush', async () => {
  const p = await product(),
    l = await list(),
    made = await preview(input(p, l)),
    before = await snapshot();
  for (const table of [
    'price_file_import_previews',
    'price_file_import_executions',
    'price_file_import_profiles',
    'price_file_import_profile_revisions',
    'price_file_import_core_witnesses',
  ]) {
    const r = (
      await pool.query(
        'SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',
        [table],
      )
    ).rows[0];
    assert.deepEqual(r, { relrowsecurity: true, relforcerowsecurity: true });
    assert.equal(
      (await pool.query("SELECT has_table_privilege('dyna_app',$1,'INSERT') allowed", [table]))
        .rows[0].allowed,
      false,
    );
  }
  await assert.rejects(
    tenantTx(tenant, (c) => c.query('SELECT * FROM price_file_import_core_witnesses')),
    (e: any) => e.code === '42501',
  );
  await assert.rejects(
    pool.query('UPDATE price_file_import_previews SET file_name=$2 WHERE id=$1', [
      made.id,
      'rewrite.csv',
    ]),
    (e: any) => e.code === '23514' && /immutable|niezmien/i.test(e.message),
  );
  const manual = await ok(
    '/price-bulk-edit/previews',
    'POST',
    {
      client_key: randomUUID(),
      price_list_id: l.id,
      list_version: l.version,
      rows: [
        {
          product_id: p.id,
          product_version: p.version,
          operation: 'set',
          basis: 'gross',
          amount_minor: 900,
        },
      ],
    },
    admin,
    201,
  );
  const afterManual = await snapshot(),
    row = (await pool.query('SELECT * FROM price_file_import_previews WHERE id=$1', [made.id]))
      .rows[0];
  await assert.rejects(
    tenantTx(tenant, (c) =>
      store(
        c,
        filePayload(row, {
          id: randomUUID(),
          client_key: randomUUID(),
          core_preview_id: manual.preview.id,
        }),
      ),
    ),
    (e: any) => e.code === '23514' && /nowego zakresu cen/.test(e.message),
  );
  assert.deepEqual(await snapshot(), afterManual);
  await assert.rejects(
    tenantTx(tenant, (c) =>
      store(
        c,
        filePayload(row, {
          id: randomUUID(),
          client_key: randomUUID(),
          core_preview_id: null,
          rows: [],
          summary: { total: 1, changed: 1, unchanged: 0, invalid: 0, conflicts: 0, ready: true },
        }),
      ),
    ),
    (e: any) => e.code === '23514',
  );
  assert.deepEqual(await snapshot(), afterManual);
  // Genuine new core and current-xid witness: the only false fact is source money/identity.
  for (const attack of ['money', 'identity']) {
    let reachedStore = false;
    await assert.rejects(
      tenantTx(tenant, async (c) => {
        const fileId = randomUUID(),
          actor = { tenantId: tenant, userId: adminId, role: 'admin' as const };
        const core = (
          await createPriceBulkEditPreviewInTx(c, actor, {
            client_key: fileId,
            price_list_id: l.id,
            list_version: l.version,
            rows: [
              {
                product_id: p.id,
                product_version: p.version,
                operation: 'set',
                basis: 'gross',
                amount_minor: 1234,
              },
            ],
          })
        ).preview;
        const raw = structuredClone(row.rows);
        raw[0].raw_cells[attack === 'money' ? 'price' : 'sku'] =
          attack === 'money' ? '999,00' : 'forged-sku';
        const request = {
          ...input(p, l),
          client_key: randomUUID(),
          content: `sku;price\r\n${raw[0].raw_cells.sku};${raw[0].raw_cells.price}\r\n`,
        };
        const payload = filePayload(row, {
          id: fileId,
          client_key: request.client_key,
          request_hash: priceBulkEditHash({ actor_id: adminId, api_key_id: null, request }),
          source_hash: createHash('sha256').update(request.content).digest('hex'),
          core_preview_id: core.id,
          rows: raw,
          list_snapshot: core.list_snapshot,
          warnings: core.warnings,
        });
        reachedStore = true;
        await store(c, payload);
      }),
      (e: any) => e.code === '23514',
    );
    assert.equal(reachedStore, true, 'Reject source mismatch after genuine own core creation');
    assert.deepEqual(await snapshot(), afterManual);
  }
  // Early constraint flush cannot make an approved current-TX receipt immune to a later price mutation.
  let reachedFlush = false;
  await assert.rejects(
    tenantTx(tenant, async (c) => {
      const core = (
          await pool.query('SELECT scope_hash FROM price_bulk_edit_previews WHERE id=$1', [
            row.core_preview_id,
          ])
        ).rows[0],
        body = consent(made),
        actor = { tenantId: tenant, userId: adminId, role: 'admin' as const };
      const result = await executePriceBulkEditInTx(
        c,
        actor,
        row.core_preview_id,
        { ...body, scope_hash: core.scope_hash },
        'manual',
        { fileImportId: made.id },
      );
      const v = {
        id: randomUUID(),
        preview_id: made.id,
        client_key: body.client_key,
        request_hash: priceBulkEditHash({
          actor_id: adminId,
          api_key_id: null,
          request: { preview_id: made.id, ...body },
        }),
        scope_hash: made.scope_hash,
        core_execution_id: result.execution.id,
        ack_missing_prices: false,
      };
      await c.query('SELECT price_file_import_store_execution($1,$2,$3)', [
        JSON.stringify(v),
        adminId,
        null,
      ]);
      await c.query('SET CONSTRAINTS ALL IMMEDIATE');
      reachedFlush = true;
      await c.query(
        'UPDATE price_list_items SET price=999 WHERE tenant_id=$1 AND price_list_id=$2 AND product_id=$3',
        [tenant, l.id, p.id],
      );
    }),
    (e: any) => e.code === '23514',
  );
  assert.equal(
    reachedFlush,
    true,
    'A fully genuine file execution must pass before the late raw mutation',
  );
  assert.deepEqual(await snapshot(), afterManual);
  assert(before.price_file_import_previews);
});

test('evidence byte and one hundred mapping-profile quotas are enforced by the real SQL writers', async () => {
  const p = await product(),
    l = await list(),
    made = await preview(input(p, l)),
    row = (await pool.query('SELECT * FROM price_file_import_previews WHERE id=$1', [made.id]))
      .rows[0],
    before = await snapshot();
  const huge = structuredClone(row.rows);
  assert(Array.isArray(huge) && huge.length === 1);
  huge[0].raw_cells.extra = 'x'.repeat(8388609);
  await assert.rejects(
    tenantTx(tenant, (c) =>
      store(c, filePayload(row, { id: randomUUID(), client_key: randomUUID(), rows: huge })),
    ),
    (e: any) => e.code === '23514' && /pełny podgląd/.test(e.message),
  );
  assert.deepEqual(await snapshot(), before);
  async function put(c: PoolClient) {
    const body = {
      client_key: randomUUID(),
      name: 'Own bounded profile ' + randomUUID(),
      definition: definition(),
    };
    return c.query('SELECT price_file_import_store_profile($1,$2,$3)', [
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
  await tenantTx(tenant, async (c) => {
    for (let i = 0; i < 100; i++) await put(c);
  });
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::int n FROM price_file_import_profiles WHERE tenant_id=$1',
        [tenant],
      )
    ).rows[0].n,
    100,
  );
  const full = await snapshot();
  await assert.rejects(
    tenantTx(tenant, put),
    (e: any) => e.code === 'P0001' && /Limit profili/.test(e.message),
  );
  assert.deepEqual(await snapshot(), full);
});

test('public registry exposes all thirteen operations with strict schemas and live compound products grants', async () => {
  const p = await product(),
    l = await list(),
    k = await mint(['products:read', 'products:write']);
  const doc = (await ok('/developer/openapi')).paths as Row;
  const operations = Object.entries(doc)
    .filter(([path]) => path.includes('/price-file-imports/'))
    .flatMap(([path, methods]) =>
      Object.entries(methods as Row)
        .filter(([method]) => ['get', 'post', 'patch'].includes(method))
        .map(([method, value]) => ({ path, method, value: value as Row })),
    );
  assert.equal(operations.length, 13);
  for (const { method, value } of operations) {
    assert.deepEqual(
      value['x-required-scopes'],
      method === 'get' ? ['products:read'] : ['products:read', 'products:write'],
    );
    assert.equal(value['x-price-file-import-limits'].rows, 500);
    assert.equal(value['x-price-file-import-limits'].file_bytes, 2097152);
    if (method !== 'get')
      assert.equal(
        value.requestBody.content['application/json'].schema.additionalProperties,
        false,
      );
  }
  const options = await publicReq(k.token, prefix + '/options');
  assert.equal(options.statusCode, 200);
  assert.equal(options.json().can_write, true);
  const body = input(p, l),
    r = await publicReq(k.token, prefix + '/previews', 'POST', body);
  assert.equal(r.statusCode, 201, r.body);
  const made = r.json().preview;
  assert.equal((await publicReq(k.token, prefix + '/previews/' + made.id)).statusCode, 200);
  assert.equal(
    (await publicReq(k.token, prefix + '/previews/' + made.id + '/rows')).statusCode,
    200,
  );
  const before = await snapshot();
  assert.equal(
    (
      await publicReq(k.token, prefix + '/previews', 'POST', {
        ...body,
        client_key: randomUUID(),
        secret: 'not-allowed',
      })
    ).statusCode,
    422,
  );
  assert.equal((await publicReq(k.token, prefix + '/options?unknown=1')).statusCode, 422);
  assert.deepEqual(await snapshot(), before);
  const executed = await publicReq(k.token, path(made), 'POST', consent(made));
  assert.equal(executed.statusCode, 201, executed.body);
  const id = executed.json().execution.id;
  for (const url of [
    prefix + '/previews',
    prefix + '/executions',
    prefix + '/executions/' + id,
    prefix + '/executions/' + id + '/rows',
  ])
    assert.equal((await publicReq(k.token, url)).statusCode, 200);
});

test('readonly malformed writes fail before parse, absent/torn113 leaves ordinary108 readable without bypassing new writes', async () => {
  const p = await product(),
    l = await list(),
    made = await preview(input(p, l));
  async function enter(target: Awaited<ReturnType<typeof buildApp>>) {
    const c = await login('admin@demo.local', target),
      r = await req('/workspaces/switch', 'POST', { tenant_id: tenant }, c, target);
    assert.equal(r.statusCode, 200);
    return String(r.headers['set-cookie']).split(';')[0];
  }
  const ro = await buildApp({ readOnly: true, integrationTransport: transport });
  try {
    const c = await enter(ro),
      before = await snapshot();
    assert.equal(
      (await req(prefix + '/previews/' + made.id, 'GET', undefined, c, ro)).statusCode,
      200,
    );
    for (const url of [prefix + '/previews', path(made), prefix + '/profiles']) {
      const r = await req(url, 'POST', '{', c, ro, { 'content-type': 'application/json' });
      assert.equal(r.statusCode, 423);
      assert.match(String(r.headers['cache-control']), /no-store/);
    }
    assert.deepEqual(await snapshot(), before);
  } finally {
    await ro.close();
  }
  await pool.query(
    'ALTER TABLE price_file_import_executions RENAME TO price_file_import_executions_hidden_test',
  );
  let old: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    old = await buildApp({ integrationTransport: transport });
    const c = await enter(old),
      before = await snapshot();
    const meta = await req(prefix + '/options', 'GET', undefined, c, old);
    assert.equal(meta.statusCode, 200);
    assert.equal(meta.json().available, false);
    assert.equal(
      (await req(prefix + '/previews', 'POST', '{', c, old, { 'content-type': 'application/json' }))
        .statusCode,
      503,
    );
    assert.equal((await req('/price-bulk-edit', 'GET', undefined, c, old)).statusCode, 200);
    assert.deepEqual(await snapshot(), before);
  } finally {
    try {
      await old?.close();
    } finally {
      await pool.query(
        'ALTER TABLE price_file_import_executions_hidden_test RENAME TO price_file_import_executions',
      );
    }
  }
});
