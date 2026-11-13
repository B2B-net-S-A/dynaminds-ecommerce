import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { DEMO_TENANT, seed } from './fixtures';
import { wmsLotsHash } from '../server/wms-lots';
import { withoutApiKeyLastUse } from './api-key-last-use';
import {
  createInventoryBulkEditPreviewInTx,
  executeInventoryBulkEditInTx,
} from '../server/inventory-bulk-edit';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/dynaminds_test_\d+$/);
type Row = Record<string, any>;
const prefix = '/stock-file-imports';
let app: Awaited<ReturnType<typeof buildApp>>,
  admin = '',
  viewer = '',
  tenant = '',
  user = '',
  warehouse = '',
  ip = 1;
function req(
  path: string,
  method: any = 'GET',
  payload?: any,
  cookie = admin,
  target = app,
  headers: Row = {},
) {
  return target.inject({
    url: '/api' + path,
    method,
    payload,
    headers: { cookie, ...headers },
    remoteAddress: '127.5.115.' + ip,
  });
}
async function ok(
  path: string,
  method: any = 'GET',
  payload?: any,
  cookie = admin,
  status = 200,
): Promise<Row> {
  const r = await req(path, method, payload, cookie);
  assert.equal(r.statusCode, status, `${method} ${path}: ${r.body.slice(0, 600)}`);
  return r.json();
}
async function login(email: string, target = app) {
  const r = await req('/auth/login', 'POST', { email, password: 'DynaDemo!2026' }, '', target);
  assert.equal(r.statusCode, 200);
  return String(r.headers['set-cookie']).split(';')[0];
}
async function enter(email: string, target = app) {
  const cookie = await login(email, target),
    r = await req('/workspaces/switch', 'POST', { tenant_id: tenant }, cookie, target);
  assert.equal(r.statusCode, 200);
  return String(r.headers['set-cookie']).split(';')[0];
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({
    logging: process.env.STOCK_FILE_IMPORT_TEST_LOG === 'true',
    integrationTransport: async () => {
      throw Error('Local stock imports cannot contact a provider');
    },
  });
  user = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
});
beforeEach(async () => {
  ip++;
  tenant = randomUUID();
  warehouse = randomUUID();
  await pool.query(
    "INSERT INTO tenants(id,name,plan) VALUES($1,'Stock file safety','enterprise')",
    [tenant],
  );
  await pool.query(
    "INSERT INTO memberships(tenant_id,user_id,role) SELECT $1,id,CASE email WHEN 'viewer@demo.local' THEN 'viewer' ELSE 'admin' END FROM users WHERE email=ANY($2::text[])",
    [tenant, ['admin@demo.local', 'viewer@demo.local']],
  );
  await pool.query(
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Own count','SAFE')",
    [warehouse, tenant],
  );
  admin = await enter('admin@demo.local');
  viewer = await enter('viewer@demo.local');
});
after(async () => {
  try {
    await app?.close();
  } finally {
    await pool.end();
  }
});
async function snapshot(forTenant = tenant) {
  const names = (
    await pool.query(
      "SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t USING(table_schema,table_name) WHERE c.table_schema='public' AND c.column_name='tenant_id' AND t.table_type='BASE TABLE' AND c.table_name NOT IN ('sessions','memberships','api_keys') ORDER BY 1",
    )
  ).rows;
  const out: Row = {};
  for (const { table_name: n } of names) {
    assert(/^[a-z][a-z0-9_]*$/.test(n));
    out[n] = (
      await pool.query(`SELECT to_jsonb(t) row FROM "${n}" t WHERE tenant_id=$1 ORDER BY 1`, [
        forTenant,
      ])
    ).rows;
  }
  return withoutApiKeyLastUse(out);
}
const product = () =>
  ok(
    '/products',
    'POST',
    {
      name: 'Own count item',
      sku: 'SAFE-' + randomUUID(),
      price: 1234,
      warehouse_id: warehouse,
      quantity: 10,
      location: 'A-01',
    },
    admin,
    201,
  );
function input(p: Row, extra: Row = {}): Row {
  return {
    client_key: randomUUID(),
    file_name: 'own.csv',
    note: 'Explicit own physical measurement',
    definition: {
      format: 'csv',
      xml_mode: 'positions',
      delimiter: ';',
      identity: 'sku',
      identity_field: 'Kod',
      spreadsheet_safe: false,
      empty_policy: 'skip',
    },
    targets: [
      {
        warehouse_id: warehouse,
        quantity_scope: 'position',
        mapping: { quantity: 'Stan' },
        default_location: 'A-01',
      },
    ],
    resolutions: [],
    content: `Kod;Stan\n${p.sku};9`,
    ...extra,
  };
}
const consent = (p: Row) => ({
  client_key: randomUUID(),
  scope_hash: p.scope_hash,
  confirmed: true,
  ack_unknown_loss_warehouse_ids: [],
  ack_surplus_warehouse_ids: [],
});
const path = (p: Row) => prefix + '/previews/' + p.id + '/execute';
const preview = async (b: Row) =>
  (await ok(prefix + '/previews', 'POST', b, admin, 201)).preview as Row;
const publicReq = (key: Row, url: string, method: any = 'GET', body?: any) =>
  req('/v1' + url, method, body, '', app, { authorization: 'Bearer ' + key.token });
const readScopes = ['products:read', 'inventory:read'],
  writeScopes = [...readScopes, 'inventory:write'];
const mint = (scopes: string[]) =>
  ok('/developer/keys', 'POST', { name: 'Own stock import principal', scopes }, admin, 201);
async function heldStock(p: Row) {
  const c = await pool.connect();
  await c.query('BEGIN');
  await c.query(
    'SELECT * FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3 FOR UPDATE',
    [tenant, warehouse, p.id],
  );
  return c;
}
async function waitOn(c: PoolClient) {
  const pid = (await c.query('SELECT pg_backend_pid() pid')).rows[0].pid,
    deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const r = (
      await pool.query(
        "SELECT query FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))",
        [pid],
      )
    ).rows;
    if (r.some((x) => /stock|stock_file_import_prepare|inventory|wms/i.test(x.query))) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Import must genuinely wait on the held own stock row before withdrawing authority');
}
async function withdraw(sql: string, args: any[]) {
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

test('stock file foreign warehouse, product, preview and profile IDs never read or mutate another firm', async () => {
  const p = await product(),
    made = await preview(input(p)),
    profile = (
      await ok(
        prefix + '/profiles',
        'POST',
        {
          client_key: randomUUID(),
          name: 'Own private profile',
          definition: input(p).definition,
          targets: input(p).targets,
        },
        admin,
        201,
      )
    ).profile;
  const foreign = randomUUID(),
    wh = randomUUID();
  await pool.query(
    "INSERT INTO tenants(id,name,plan) VALUES($1,'Foreign stock file','enterprise')",
    [foreign],
  );
  await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [
    foreign,
    user,
  ]);
  await pool.query(
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Foreign warehouse','FOREIGN')",
    [wh, foreign],
  );
  let foreignBefore = (
    await pool.query('SELECT to_jsonb(t) row FROM stock t WHERE tenant_id=$1 ORDER BY 1', [foreign])
  ).rows;
  let ownBefore = await snapshot();
  const body = input(p);
  body.targets[0].warehouse_id = wh;
  assert.equal((await req(prefix + '/previews', 'POST', body)).statusCode, 404);
  assert.deepEqual(await snapshot(), ownBefore);
  const oldTenant = tenant;
  tenant = foreign;
  let foreignCookie: string;
  try {
    foreignCookie = await enter('admin@demo.local');
  } finally {
    tenant = oldTenant;
  }
  const foreignProduct = await req(
    '/products',
    'POST',
    {
      name: 'Actual foreign physical product',
      sku: 'FOREIGN-' + randomUUID(),
      price: 1,
      warehouse_id: wh,
      quantity: 12,
    },
    foreignCookie!,
  );
  assert.equal(foreignProduct.statusCode, 201);
  foreignBefore = (
    await pool.query('SELECT to_jsonb(t) row FROM stock t WHERE tenant_id=$1 ORDER BY 1', [foreign])
  ).rows;
  const hidden = input(p, {
    definition: { ...input(p).definition, identity: 'uuid' },
    content: `Kod;Stan\n${foreignProduct.json().id};0`,
  });
  const invalid = await preview(hidden);
  assert(invalid.summary.invalid > 0);
  const physicalBefore = (
    await pool.query('SELECT to_jsonb(t) row FROM stock t WHERE tenant_id=$1 ORDER BY 1', [tenant])
  ).rows;
  assert.equal((await req(path(invalid), 'POST', consent(invalid))).statusCode, 409);
  assert.deepEqual(
    (
      await pool.query('SELECT to_jsonb(t) row FROM stock t WHERE tenant_id=$1 ORDER BY 1', [
        tenant,
      ])
    ).rows,
    physicalBefore,
  );
  ownBefore = await snapshot();
  for (const url of [
    prefix + '/previews/' + made.id,
    prefix + '/previews/' + made.id + '/rows',
    prefix + '/profiles/' + profile.id,
  ])
    assert.equal((await req(url, 'GET', undefined, foreignCookie!)).statusCode, 404);
  assert.equal((await req(path(made), 'POST', consent(made), foreignCookie!)).statusCode, 404);
  await tenantTx(foreign, async (c) => {
    assert.equal(
      (
        await c.query('SELECT count(*)::int n FROM stock_file_import_previews WHERE id=$1', [
          made.id,
        ])
      ).rows[0].n,
      0,
    );
  });
  assert.deepEqual(
    (
      await pool.query('SELECT to_jsonb(t) row FROM stock t WHERE tenant_id=$1 ORDER BY 1', [
        foreign,
      ])
    ).rows,
    foreignBefore,
  );
  assert.deepEqual(await snapshot(), ownBefore);
});

test('stock file viewer and quantity-only API projections deeply remove original costs across heads, rows, profiles and history', async () => {
  const p = await product(),
    s = (
      await pool.query('SELECT version FROM stock WHERE tenant_id=$1 AND product_id=$2', [
        tenant,
        p.id,
      ])
    ).rows[0];
  const opening = await ok(
    '/wms-lots/opening-previews',
    'POST',
    {
      client_key: randomUUID(),
      policy_version: '0',
      currency: 'PLN',
      note: 'Known cost deep mask',
      lines: [
        {
          warehouse_id: warehouse,
          product_id: p.id,
          location: 'A-01',
          quantity: 10,
          stock_version: String(s.version),
          lot_code: 'MASK-LOT',
          unit_cost_minor: '81234567',
        },
      ],
    },
    admin,
    201,
  );
  await ok(
    '/wms-lots/opening-previews/' + opening.preview.id + '/activate',
    'POST',
    {
      client_key: randomUUID(),
      scope_hash: opening.preview.scope_hash,
      confirmed: true,
      ack_unknown_costs: false,
    },
    admin,
    201,
  );
  const lot = (
      await pool.query('SELECT lot_id FROM wms_cost_layers WHERE tenant_id=$1 AND product_id=$2', [
        tenant,
        p.id,
      ])
    ).rows[0].lot_id,
    b = input(p);
  b.targets[0].mapping = {
    quantity: 'Stan',
    lot_id: 'Partia',
    unit_cost_minor: 'Koszt',
    currency: 'Waluta',
  };
  b.content = `Kod;Stan;Partia;Koszt;Waluta\n${p.sku};9;${lot};81234567;PLN`;
  const made = await preview(b),
    profile = (
      await ok(
        prefix + '/profiles',
        'POST',
        {
          client_key: randomUUID(),
          name: 'Masked configuration',
          definition: b.definition,
          targets: b.targets,
        },
        admin,
        201,
      )
    ).profile,
    done = (await ok(path(made), 'POST', consent(made), admin, 201)).execution,
    key = await mint(readScopes),
    before = await snapshot();
  for (const url of [
    prefix + '/options',
    prefix + '/profiles',
    prefix + '/profiles/' + profile.id,
    prefix + '/previews',
    prefix + '/previews/' + made.id,
    prefix + '/previews/' + made.id + '/rows',
    prefix + '/executions',
    prefix + '/executions/' + done.id,
    prefix + '/executions/' + done.id + '/rows',
  ])
    for (const role of ['viewer', 'key']) {
      const r =
        role === 'viewer' ? await req(url, 'GET', undefined, viewer) : await publicReq(key, url);
      assert.equal(r.statusCode, 200, `${role} ${url}: ${r.body.slice(0, 400)}`);
      assert.match(String(r.headers['cache-control']), /no-store/);
      assert.equal(r.json().can_read_value, false);
      assert(
        !r.body.includes('81234567'),
        'Original and computed money must not leak in raw cells or nested basis',
      );
      if (url.endsWith('/rows'))
        for (const row of r.json().rows) {
          assert.equal(row.raw_cells, null);
          assert.equal(row.fragments, null);
          assert.equal(row.valuation, null);
          assert.equal(row.product_id, p.id);
        }
    }
  assert.equal((await req(path(made), 'POST', consent(made), viewer)).statusCode, 403);
  assert.equal((await publicReq(key, path(made), 'POST', consent(made))).statusCode, 403);
  assert.deepEqual(await snapshot(), before);
});

test('stock file public API registry uses compound inventory grants and ON adds current purchasing grants without bypassing actor binding', async () => {
  const p = await product(),
    key = await mint(writeScopes),
    missing = await mint(['inventory:read', 'inventory:write']),
    read = await mint(readScopes),
    doc = await ok('/developer/openapi');
  const paths = Object.entries(doc.paths).filter(([k]) => k.includes('/stock-file-imports'));
  assert.equal(
    paths.reduce(
      (n, [, v]) =>
        n + Object.keys(v as Row).filter((k) => ['get', 'post', 'patch'].includes(k)).length,
      0,
    ),
    13,
  );
  assert.equal((await publicReq(missing, prefix + '/options')).statusCode, 403);
  assert.equal((await publicReq(read, prefix + '/previews', 'POST', input(p))).statusCode, 403);
  const created = await publicReq(key, prefix + '/previews', 'POST', input(p));
  assert.equal(created.statusCode, 201);
  const made = created.json().preview,
    other = await mint(writeScopes),
    before = await snapshot();
  assert.equal((await publicReq(other, path(made), 'POST', consent(made))).statusCode, 409);
  assert.deepEqual(await snapshot(), before);
  assert.equal((await publicReq(key, path(made), 'POST', consent(made))).statusCode, 201);
  const s = (
      await pool.query('SELECT version,on_hand FROM stock WHERE tenant_id=$1 AND product_id=$2', [
        tenant,
        p.id,
      ])
    ).rows[0],
    opening = await ok(
      '/wms-lots/opening-previews',
      'POST',
      {
        client_key: randomUUID(),
        policy_version: '0',
        currency: 'PLN',
        note: 'Genuine current policy activation',
        lines: [
          {
            warehouse_id: warehouse,
            product_id: p.id,
            location: 'A-01',
            quantity: s.on_hand,
            stock_version: String(s.version),
            lot_code: 'CURRENT-ON',
            unit_cost_minor: '0',
          },
        ],
      },
      admin,
      201,
    );
  await ok(
    '/wms-lots/opening-previews/' + opening.preview.id + '/activate',
    'POST',
    {
      client_key: randomUUID(),
      scope_hash: opening.preview.scope_hash,
      confirmed: true,
      ack_unknown_costs: false,
    },
    admin,
    201,
  );
  const b = input(p),
    lot = (
      await pool.query('SELECT lot_id FROM wms_cost_layers WHERE tenant_id=$1 AND product_id=$2', [
        tenant,
        p.id,
      ])
    ).rows[0].lot_id;
  b.targets[0].mapping.lot_id = 'Partia';
  b.content = `Kod;Stan;Partia\n${p.sku};8;${lot}`;
  const frozen = await snapshot();
  assert.equal((await publicReq(key, prefix + '/previews', 'POST', b)).statusCode, 403);
  assert.deepEqual(await snapshot(), frozen);
  const full = await mint([...writeScopes, 'purchasing:read', 'purchasing:write']);
  assert.equal((await publicReq(full, prefix + '/previews', 'POST', b)).statusCode, 201);
});

test('stock file member withdrawal after actual stock wait rolls back all physical writes and execution evidence', async () => {
  const p = await product(),
    made = await preview(input(p)),
    before = await snapshot(),
    holder = await heldStock(p);
  let pending: ReturnType<typeof req> | undefined;
  try {
    pending = req(path(made), 'POST', consent(made));
    await waitOn(holder);
    await withdraw("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
      tenant,
      user,
    ]);
    await holder.query('ROLLBACK');
    const r = await pending;
    assert.equal(r.statusCode, 403);
    assert.deepEqual(await snapshot(), before);
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
    await pending?.catch(() => undefined);
  }
});

test('stock file revoked, expired and scope-reduced keys are rechecked after genuine held stock lock and exact replay', async () => {
  const p = await product();
  for (const kind of ['revoke', 'expire', 'scope']) {
    const key = await mint(writeScopes);
    assert.equal((await publicReq(key, prefix + '/options')).statusCode, 200);
    const previewResponse = await publicReq(key, prefix + '/previews', 'POST', input(p));
    assert.equal(previewResponse.statusCode, 201);
    const made = previewResponse.json().preview,
      before = await snapshot(),
      holder = await heldStock(p);
    let pending: ReturnType<typeof publicReq> | undefined;
    try {
      pending = publicReq(key, path(made), 'POST', consent(made));
      await waitOn(holder);
      await withdraw(
        kind === 'revoke'
          ? 'UPDATE api_keys SET revoked_at=now() WHERE id=$1'
          : kind === 'expire'
            ? "UPDATE api_keys SET expires_at=now()-interval '1 second' WHERE id=$1"
            : "UPDATE api_keys SET scopes=ARRAY['products:read','inventory:read']::text[] WHERE id=$1",
        [key.id],
      );
      await holder.query('ROLLBACK');
      assert.equal((await pending).statusCode, kind === 'scope' ? 403 : 401);
      assert.deepEqual(await snapshot(), before);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      await pending?.catch(() => undefined);
    }
  }
  const key = await mint(writeScopes),
    pr = await publicReq(key, prefix + '/previews', 'POST', input(p));
  assert.equal(pr.statusCode, 201);
  const made = pr.json().preview,
    body = consent(made);
  assert.equal((await publicReq(key, path(made), 'POST', body)).statusCode, 201);
  const accepted = await snapshot();
  await withdraw('UPDATE api_keys SET revoked_at=now() WHERE id=$1', [key.id]);
  assert.equal((await publicReq(key, path(made), 'POST', body)).statusCode, 401);
  assert.deepEqual(await snapshot(), accepted);
});

test('stock file malformed and extra authoritative fields fail without evidence; readOnly blocks mutations before JSON parse', async () => {
  const p = await product(),
    b = input(p),
    made = await preview(b),
    profile = (
      await ok(
        prefix + '/profiles',
        'POST',
        {
          client_key: randomUUID(),
          name: 'Readonly own map',
          definition: b.definition,
          targets: b.targets,
        },
        admin,
        201,
      )
    ).profile,
    before = await snapshot();
  for (const bad of [
    { ...b, client_key: randomUUID(), before: { quantity: 999 } },
    { ...b, client_key: randomUUID(), targets: [{ ...b.targets[0], product_id: p.id }] },
    { ...b, client_key: randomUUID(), definition: { ...b.definition, delta: true } },
    {
      ...b,
      client_key: randomUUID(),
      resolutions: [
        {
          source_index: 0,
          warehouse_id: warehouse,
          positions: [
            { location: 'A-01', quantity: 9, lot: null, unit_cost_minor: '1.5', currency: 'PLN' },
          ],
        },
      ],
    },
  ]) {
    const r = await req(prefix + '/previews', 'POST', bad);
    assert.equal(r.statusCode, 422);
    assert.match(String(r.headers['cache-control']), /no-store/);
  }
  assert.deepEqual(await snapshot(), before);
  const ro = await buildApp({
    readOnly: true,
    integrationTransport: async () => {
      throw Error('Readonly local test');
    },
  });
  try {
    const cookie = await enter('admin@demo.local', ro),
      baseline = await snapshot();
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
    assert.deepEqual(await snapshot(), baseline);
  } finally {
    await ro.close();
  }
});

test('stock file FORCE RLS and immutable evidence cannot be forged by app INSERT or by owner changing approved snapshots', async () => {
  const p = await product(),
    made = await preview(input(p)),
    before = await snapshot();
  for (const table of [
    'stock_file_import_previews',
    'stock_file_import_executions',
    'stock_file_import_profiles',
    'stock_file_import_profile_revisions',
    'stock_file_import_admissions',
    'stock_file_import_core_witnesses',
    'stock_file_import_epochs',
  ]) {
    const flags = (
      await pool.query(
        'SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',
        [table],
      )
    ).rows[0];
    assert.deepEqual(flags, { relrowsecurity: true, relforcerowsecurity: true });
    assert.equal(
      (await pool.query("SELECT has_table_privilege('dyna_app',$1,'INSERT') allowed", [table]))
        .rows[0].allowed,
      false,
    );
  }
  for (const table of ['stock_file_import_admissions', 'stock_file_import_core_witnesses'])
    await assert.rejects(
      tenantTx(tenant, (c) => c.query(`SELECT * FROM ${table}`)),
      (e: any) => e.code === '42501',
    );
  await assert.rejects(
    tenantTx(tenant, (c) =>
      c.query(
        'INSERT INTO stock_file_import_previews SELECT * FROM stock_file_import_previews WHERE id=$1',
        [made.id],
      ),
    ),
    (e: any) => e.code === '42501',
  );
  await assert.rejects(
    pool.query('UPDATE stock_file_import_previews SET file_name=$2 WHERE id=$1', [
      made.id,
      'forged.csv',
    ]),
    (e: any) => e.code === '23514',
  );
  assert.deepEqual(await snapshot(), before);
});

test('stock file typed SQL rejects a forged physical before and incomplete genuine admission at commit', async () => {
  const p = await product(),
    made = await preview(input(p)),
    stored = (
      await pool.query('SELECT payload FROM stock_file_import_previews WHERE id=$1', [made.id])
    ).rows[0].payload,
    before = await snapshot();
  for (const attack of ['physical-before', 'hidden-invalid']) {
    const forged = structuredClone(stored);
    forged.id = randomUUID();
    forged.client_key = randomUUID();
    forged.request.client_key = forged.client_key;
    forged.request_hash = wmsLotsHash({
      actor_id: user,
      api_key_id: null,
      source: 'manual',
      kind: 'preview',
      parent_id: null,
      request: forged.request,
    });
    if (attack === 'physical-before') forged.rows[0].before.quantity = 999;
    else {
      // A retained invalid row may never disguise a ready head and bypass source derivation.
      forged.rows[0].status = 'invalid';
      forged.rows[0].errors = ['Retained invalid physical count'];
      forged.rows[0].input.quantity = 1;
      forged.rows[0].after.quantity = 1;
      assert.equal(forged.summary.invalid, 0);
    }
    delete forged.scope_hash;
    forged.scope_hash = wmsLotsHash(forged);
    let reachedStore = false;
    await assert.rejects(
      tenantTx(tenant, async (c) => {
        reachedStore = true;
        await c.query('SELECT stock_file_import_store_preview($1)', [JSON.stringify(forged)]);
      }),
      (e: any) => e.code === '23514',
    );
    assert(reachedStore, attack);
    assert.deepEqual(await snapshot(), before);
  }
  let reachedCommit = false;
  await assert.rejects(
    tenantTx(
      tenant,
      async (c) => {
        await c.query('SELECT stock_file_import_prepare($1,$2,$3,$4,$5)', [
          made.id,
          randomUUID(),
          user,
          null,
          JSON.stringify(consent(made)),
        ]);
        reachedCommit = true;
        // A real admission without all new children and the parent receipt must never commit.
      },
      { purchasingAdmission: true },
    ),
    (e: any) =>
      e.code === '23503' &&
      e.constraint === 'stock_file_import_admissions_tenant_id_execution_id_fkey',
  );
  assert(reachedCommit);
  assert.deepEqual(await snapshot(), before);
});

async function commitOwnOffFile(
  c: PoolClient,
  made: Row,
  body: Row,
  transformPayload?: (payload: Row) => void | Promise<void>,
) {
  const p = (await c.query('SELECT payload FROM stock_file_import_previews WHERE id=$1', [made.id]))
      .rows[0].payload,
    eid = randomUUID(),
    a = { tenantId: tenant, userId: user, role: 'admin' as const },
    links: Row[] = [];
  await c.query('SELECT stock_file_import_prepare($1,$2,$3,$4,$5)', [
    made.id,
    eid,
    user,
    null,
    JSON.stringify(body),
  ]);
  for (const target of p.targets)
    for (const child of target.children) {
      const records = p.rows.filter(
        (r: Row) =>
          r.warehouse_id === target.warehouse_id &&
          r.input.operation === 'count' &&
          r.position &&
          r.product_id,
      );
      const core = await createInventoryBulkEditPreviewInTx(
        c,
        a,
        {
          client_key: child.create_key,
          warehouse_id: target.warehouse_id,
          note: p.note,
          rows: records.map((r: Row) => ({
            product_id: r.product_id,
            product_version: r.product_version,
            stock_version: r.before.present ? r.before.stock_version : null,
            location: r.location,
            operation: 'count' as const,
            quantity: r.input.quantity,
          })),
        },
        'manual',
        { stockFileImportId: made.id, previewId: child.id },
      );
      const execution = await executeInventoryBulkEditInTx(
        c,
        a,
        child.id,
        { client_key: child.execute_key, scope_hash: core.preview.scope_hash, confirmed: true },
        'manual',
        { stockFileImportId: made.id },
      );
      links.push({
        warehouse_id: target.warehouse_id,
        mode: 'off',
        core_preview_id: child.id,
        core_execution_id: execution.execution.id,
      });
    }
  const after = (
    await c.query('SELECT stock_file_import_snapshot($1) snapshot', [
      JSON.stringify({
        warehouse_ids: p.targets.map((t: Row) => t.warehouse_id),
        product_ids: p.snapshot.products.map((t: Row) => t.id),
      }),
    ])
  ).rows[0].snapshot;
  const request_hash = wmsLotsHash({
    actor_id: user,
    api_key_id: null,
    source: 'manual',
    kind: 'execute',
    parent_id: made.id,
    request: body,
  });
  const rows = p.rows.map((r: Row) => {
    if (!r.after) return r;
    const stock = after.stock.find(
      (s: Row) => s.warehouse_id === r.warehouse_id && s.product_id === r.product_id,
    );
    return {
      ...r,
      after: {
        ...r.after,
        present: Boolean(stock),
        warehouse_on_hand: stock?.on_hand ?? 0,
        warehouse_reserved: stock?.reserved ?? 0,
        stock_version: stock?.version ?? null,
      },
    };
  });
  const payload: Row = {
    ...p,
    rows,
    id: eid,
    preview_id: made.id,
    client_key: body.client_key,
    actor_id: user,
    api_key_id: null,
    request_hash,
    execute_request: body,
    links,
    snapshot: after,
  };
  if (transformPayload) await transformPayload(payload);
  await c.query('SELECT stock_file_import_store_execution($1)', [JSON.stringify(payload)]);
  return { id: eid, payload };
}

test('stock file sealed private validation rejects owner admission, epoch and witness tampering before and after deferred flush through SAVEPOINT', async () => {
  const p = await product(),
    made = await preview(input(p)),
    before = await snapshot(),
    otherBefore = await snapshot(DEMO_TENANT);
  const attacks = [
    {
      name: 'admission-before',
      sql: "UPDATE stock_file_import_admissions SET before_snapshot=jsonb_set(before_snapshot,'{stock}','[]'::jsonb) WHERE tenant_id=$1 AND execution_id=$2",
    },
    {
      name: 'admission-after',
      sql: "UPDATE stock_file_import_admissions SET after_snapshot=jsonb_set(after_snapshot,'{stock}','[]'::jsonb) WHERE tenant_id=$1 AND execution_id=$2",
    },
    {
      name: 'admission-request',
      sql: "UPDATE stock_file_import_admissions SET request=jsonb_set(request,'{confirmed}','false'::jsonb) WHERE tenant_id=$1 AND execution_id=$2",
    },
    {
      name: 'source-epoch',
      sql: 'UPDATE stock_file_import_epochs SET version=version+1 WHERE tenant_id=$1 AND product_id=$2',
    },
    {
      name: 'core-witness',
      sql: 'DELETE FROM stock_file_import_core_witnesses WHERE tenant_id=$1 AND preview_id=$2',
    },
  ];
  for (const phase of ['before-flush', 'after-flush'])
    for (const attack of attacks) {
      let reachedParent = false,
        reachedOwnerWrite = false,
        reachedFlush = false;
      await assert.rejects(
        tenantTx(
          tenant,
          async (c) => {
            await c.query('SAVEPOINT own_private_parent');
            const receipt = await commitOwnOffFile(c, made, consent(made));
            reachedParent = true;
            await c.query('RELEASE SAVEPOINT own_private_parent');
            if (phase === 'after-flush') {
              await c.query('SET CONSTRAINTS ALL IMMEDIATE');
              reachedFlush = true;
            }
            // App has no private-table DML: deliberately exercise the actual owner
            // role, not a 42501 shortcut mistaken for immutable evidence protection.
            await c.query('SET LOCAL ROLE postgres');
            assert.equal(
              (await c.query("SELECT current_setting('role') role")).rows[0].role,
              'postgres',
            );
            await c.query('SAVEPOINT own_private_tamper');
            const id =
              attack.name === 'source-epoch'
                ? p.id
                : attack.name === 'core-witness'
                  ? made.id
                  : receipt.id;
            const table =
              attack.name === 'source-epoch'
                ? 'stock_file_import_epochs'
                : attack.name === 'core-witness'
                  ? 'stock_file_import_core_witnesses'
                  : 'stock_file_import_admissions';
            const column =
              attack.name === 'source-epoch'
                ? 'product_id'
                : attack.name === 'core-witness'
                  ? 'preview_id'
                  : 'execution_id';
            assert(
              (
                await c.query(
                  `SELECT count(*)::int n FROM ${table} WHERE tenant_id=$1 AND ${column}=$2`,
                  [tenant, id],
                )
              ).rows[0].n > 0,
            );
            reachedOwnerWrite = true;
            await c.query(attack.sql, [tenant, id]);
          },
          { purchasingAdmission: true },
        ),
        (e: any) =>
          e.code === '23514' &&
          e.message ===
            (attack.name.startsWith('admission-')
              ? 'Dowód wykonania wymaga zatwierdzonej prywatnej walidacji'
              : 'Zatwierdzony cały import stanów jest zapieczętowany'),
      );
      assert(reachedParent, `${phase}/${attack.name}: genuine parent store must complete`);
      assert(reachedOwnerWrite, `${phase}/${attack.name}: actual owner DML must be reached`);
      assert.equal(reachedFlush, phase === 'after-flush');
      assert.deepEqual(await snapshot(), before);
      assert.deepEqual(await snapshot(DEMO_TENANT), otherBefore);
    }
});

test('stock file canonical receipt indices reject duplicated or omitted rows in preview and genuine two-product execution without effects', async () => {
  const p = await product(),
    q = await product();
  const made = await preview(input(p, { content: `Kod;Stan\n${p.sku};9\n${q.sku};8` }));
  const stored = (
    await pool.query('SELECT payload FROM stock_file_import_previews WHERE id=$1', [made.id])
  ).rows[0].payload;
  assert.equal(stored.rows.length, 2);
  assert.deepEqual(
    stored.rows.map((row: Row) => row.index),
    [0, 1],
  );
  assert.notEqual(stored.rows[0].product_id, stored.rows[1].product_id);
  const before = await snapshot(),
    otherBefore = await snapshot(DEMO_TENANT);
  const orderedError = (e: any) =>
    e.code === '23514' && e.message === 'Indeksy wierszy importu stanów są niekanoniczne';
  for (const attack of ['duplicate-receipt', 'missing-index']) {
    const forged: Row = structuredClone(stored);
    forged.id = randomUUID();
    forged.client_key = randomUUID();
    forged.request.client_key = forged.client_key;
    if (attack === 'duplicate-receipt') forged.rows[1] = structuredClone(forged.rows[0]);
    else forged.rows[1].index = 2;
    forged.request_hash = wmsLotsHash({
      actor_id: user,
      api_key_id: null,
      source: 'manual',
      kind: 'preview',
      parent_id: null,
      request: forged.request,
    });
    delete forged.scope_hash;
    forged.scope_hash = wmsLotsHash(forged);
    let reachedPreviewStore = false;
    // A malformed preview is rejected before it can admit any physical children.
    await assert.rejects(
      tenantTx(tenant, async (c) => {
        reachedPreviewStore = true;
        await c.query('SELECT stock_file_import_store_preview($1)', [JSON.stringify(forged)]);
      }),
      orderedError,
    );
    assert(reachedPreviewStore, attack);
    assert.deepEqual(await snapshot(), before);
    let reachedFullChildren = false,
      reachedParentStore = false;
    await assert.rejects(
      tenantTx(
        tenant,
        async (c) => {
          await c.query('SAVEPOINT own_index_children');
          await commitOwnOffFile(c, made, consent(made), (payload) => {
            assert.equal(payload.rows.length, 2);
            assert.equal(payload.links.length, 1);
            assert.deepEqual(payload.snapshot.stock.map((row: Row) => row.on_hand).sort(), [8, 9]);
            reachedFullChildren = true;
            if (attack === 'duplicate-receipt') payload.rows[1] = structuredClone(payload.rows[0]);
            else payload.rows[1].index = 2;
            // All source/actor/consent hashes, genuine core receipts, actual stock,
            // bins and journals remain intact; only the ordered receipt is forged.
            reachedParentStore = true;
          });
        },
        { purchasingAdmission: true },
      ),
      orderedError,
    );
    assert(reachedFullChildren, attack);
    assert(reachedParentStore, attack);
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(await snapshot(DEMO_TENANT), otherBefore);
  }
});

test('stock file complete typed child chain seals physical state after early flush and SAVEPOINT without blocking later transactions', async () => {
  const p = await product(),
    made = await preview(input(p)),
    body = consent(made),
    before = await snapshot();
  let reachedFlush = false;
  await assert.rejects(
    tenantTx(
      tenant,
      async (c) => {
        await c.query('SAVEPOINT own_file_child');
        await commitOwnOffFile(c, made, body);
        await c.query('RELEASE SAVEPOINT own_file_child');
        await c.query('SET CONSTRAINTS ALL IMMEDIATE');
        reachedFlush = true;
        await c.query(
          'UPDATE stock SET on_hand=on_hand+1 WHERE warehouse_id=$1 AND product_id=$2',
          [warehouse, p.id],
        );
      },
      { purchasingAdmission: true },
    ),
    (e: any) => e.code === '23514',
  );
  assert(
    reachedFlush,
    'The full genuine child/parent receipt must pass all deferred checks before the forbidden later mutation',
  );
  assert.deepEqual(await snapshot(), before);
  // Existing manual core API cannot execute a child ID merely reserved by the file preview.
  const payload = (
      await pool.query('SELECT payload FROM stock_file_import_previews WHERE id=$1', [made.id])
    ).rows[0].payload,
    child = payload.targets[0].children[0];
  const bypass = await req('/inventory-bulk-edit/previews/' + child.id + '/execute', 'POST', {
    client_key: child.execute_key,
    scope_hash: made.scope_hash,
    confirmed: true,
  });
  assert.equal(bypass.statusCode, 409);
  assert.deepEqual(await snapshot(), before);
  await ok(path(made), 'POST', body, admin, 201);
  const current = (
    await pool.query(
      'SELECT version FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3',
      [tenant, warehouse, p.id],
    )
  ).rows[0];
  const later = await ok(
    '/stock-location-counts',
    'POST',
    {
      warehouse_id: warehouse,
      product_id: p.id,
      location: 'A-01',
      expected_version: String(current.version),
      client_key: randomUUID(),
      note: 'Normal later manual transaction',
      quantity: 8,
    },
    admin,
    200,
  );
  assert.equal(later.kind, 'count');
  assert.equal(later.data.find((bin: Row) => bin.location === 'A-01')?.quantity, 8);
  const laterStock = (
    await pool.query(
      'SELECT on_hand,version FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3',
      [tenant, warehouse, p.id],
    )
  ).rows[0];
  assert.equal(laterStock.on_hand, 8);
  assert.equal(BigInt(laterStock.version), BigInt(current.version) + 1n);
});

test('stock file torn installed prepare capability fails closed while legacy warehouse reads remain available', async () => {
  const p = await product(),
    made = await preview(input(p)),
    before = await snapshot();
  await pool.query(
    'ALTER FUNCTION stock_file_import_prepare(uuid,uuid,uuid,uuid,jsonb) RENAME TO stock_file_import_prepare_hidden_test',
  );
  let old: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    old = await buildApp({
      integrationTransport: async () => {
        throw Error('No providers');
      },
    });
    const cookie = await enter('admin@demo.local', old);
    const checks: Array<[string, 'GET' | 'POST', Row | undefined]> = [
      [prefix + '/options', 'GET', undefined],
      [prefix + '/previews/' + made.id, 'GET', undefined],
      [path(made), 'POST', consent(made)],
    ];
    for (const [url, method, body] of checks) {
      const r = await req(url, method, body, cookie, old);
      assert.equal(r.statusCode, 503);
      assert.match(String(r.headers['cache-control']), /no-store/);
    }
    assert.equal(
      (
        await req(
          '/stock-locations?warehouse_id=' + warehouse + '&product_id=' + p.id,
          'GET',
          undefined,
          cookie,
          old,
        )
      ).statusCode,
      200,
    );
    assert.deepEqual(await snapshot(), before);
  } finally {
    try {
      await old?.close();
    } finally {
      await pool.query(
        'ALTER FUNCTION stock_file_import_prepare_hidden_test(uuid,uuid,uuid,uuid,jsonb) RENAME TO stock_file_import_prepare',
      );
    }
  }
});
