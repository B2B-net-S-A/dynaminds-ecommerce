import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed, SECOND_TENANT } from './fixtures';
import { STOCKTAKE_SCAN_LIMITS } from '../server/stocktake-scans-schema';
import { backendPid, waitForLockEdge } from './lock-edge-helper';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/dynaminds_(?:test_\d+|(?:stk29|lk29|p277|m26[123])_202610(?:29|30)_\d{2})$/);
type Engine = 'wms' | 'quantity';
type Row = Record<string, any>;
let app: Awaited<ReturnType<typeof buildApp>>,
  tenant = '',
  warehouse = '',
  adminId = '',
  operatorId = '',
  ip = 1,
  calls = 0;
const cookies = new Map<string, string>();
const tables = [
  'products',
  'stock',
  'stock_locations',
  'stock_movements',
  'stock_location_movements',
  'orders',
  'order_items',
  'order_pick_items',
  'reservations',
  'reservation_locations',
  'wms_lots',
  'wms_cost_layers',
  'wms_layer_positions',
  'wms_reservation_layers',
  'wms_layer_movements',
  'wms_issue_fragments',
  'wms_return_fragments',
  'wms_operations',
  'stocktakes',
  'stocktake_lines',
  'stocktake_measurements',
  'wms_stocktakes',
  'wms_stocktake_lines',
  'wms_stocktake_scope_layers',
  'wms_stocktake_measurements',
  'wms_stocktake_measurement_layers',
  'stocktake_scan_receipts',
  'audit_events',
  'jobs',
  'outbound_events',
  'outbound_deliveries',
  'email_messages',
  'sms_messages',
];
const auth = (email = 'admin@demo.local') => cookies.get(email)!;
const transport = async () => {
  ++calls;
  throw Error('Scanning cannot invoke a provider');
};
const req = (
  path: string,
  method: any = 'GET',
  payload?: any,
  cookie = auth(),
  target = app,
  headers: Record<string, string> = {},
) =>
  target.inject({
    url: '/api' + path,
    method,
    payload,
    headers: { cookie, ...headers },
    remoteAddress: '127.0.152.' + ip,
  });
async function ok(
  path: string,
  method: any = 'GET',
  body?: any,
  cookie?: string,
  target = app,
  headers: Record<string, string> = {},
) {
  const r = await req(path, method, body, cookie, target, headers);
  assert(r.statusCode >= 200 && r.statusCode < 300, `${method} ${path}: ${r.statusCode}`);
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
    logging: process.env.STOCKTAKE_SCAN_TEST_LOG === 'true',
  });
  for (const email of ['admin@demo.local', 'operator@demo.local', 'viewer@demo.local'])
    cookies.set(email, await login(email));
  adminId = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
  operatorId = (await pool.query("SELECT id FROM users WHERE email='operator@demo.local'")).rows[0]
    .id;
});
beforeEach(async () => {
  ++ip;
  calls = 0;
  tenant = randomUUID();
  warehouse = randomUUID();
  await pool.query(
    "INSERT INTO tenants(id,name,plan) VALUES($1,'Scan adversarial fixture','enterprise')",
    [tenant],
  );
  await pool.query(
    `INSERT INTO memberships(tenant_id,user_id,role) SELECT $1,id,CASE email WHEN 'admin@demo.local' THEN 'admin' WHEN 'operator@demo.local' THEN 'operator' ELSE 'viewer' END FROM users WHERE email=ANY($2::text[])`,
    [tenant, [...cookies.keys()]],
  );
  for (const [email, cookie] of cookies) {
    const r = await req('/workspaces/switch', 'POST', { tenant_id: tenant }, cookie);
    assert.equal(r.statusCode, 200);
    cookies.set(email, String(r.headers['set-cookie']).split(';')[0]);
  }
  await pool.query(
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Scanner warehouse','SCAN')",
    [warehouse, tenant],
  );
});
after(async () => {
  try {
    await app?.close();
  } finally {
    await pool.end();
  }
});
async function snapshot() {
  const out: Row = {};
  for (const table of tables)
    out[table] = (
      await pool.query(`SELECT to_jsonb(t) row FROM ${table} t WHERE tenant_id=$1 ORDER BY 1`, [
        tenant,
      ])
    ).rows;
  return out;
}
async function fixture(engine: Engine) {
  const p = await ok('/products', 'POST', {
    sku: 'SAFE-' + randomUUID(),
    ean: '000012345',
    name: 'Physical scanner fixture',
    price: 1370,
    warehouse_id: warehouse,
    quantity: 13,
    location: 'A-01',
  });
  if (engine === 'wms') {
    const version = (
      await pool.query('SELECT version FROM stock WHERE tenant_id=$1 AND product_id=$2', [
        tenant,
        p.id,
      ])
    ).rows[0].version;
    const { preview } = await ok('/wms-lots/opening-previews', 'POST', {
      client_key: randomUUID(),
      policy_version: '0',
      currency: 'PLN',
      note: 'Adversarial controlled opening',
      lines: [
        {
          warehouse_id: warehouse,
          product_id: p.id,
          location: 'A-01',
          quantity: 13,
          stock_version: version,
          lot_code: 'SAFE-LOT',
          unit_cost_minor: '317',
        },
      ],
    });
    assert(preview.ready);
    await ok('/wms-lots/opening-previews/' + preview.id + '/activate', 'POST', {
      client_key: randomUUID(),
      scope_hash: preview.scope_hash,
      confirmed: true,
      ack_unknown_costs: false,
    });
  }
  const prefix = engine === 'wms' ? '/wms-lots/stocktakes' : '/stocktakes';
  const result = await ok(prefix, 'POST', {
    client_key: randomUUID(),
    warehouse_id: warehouse,
    name: 'Blind safe scanner count',
    blind: true,
    ...(engine === 'wms' ? { policy_version: '1' } : {}),
  });
  const h = result.stocktake ?? result;
  return {
    engine,
    p,
    id: h.id,
    base: prefix + '/' + h.id,
    headTable: engine === 'wms' ? 'wms_stocktakes' : 'stocktakes',
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const resolver = (f: Fixture, cookie = auth(), headers: Record<string, string> = {}) =>
  ok(
    (headers.authorization ? '/v1' : '') +
      f.base +
      '/scan-candidates?' +
      new URLSearchParams({ code: f.p.ean, location: 'A-01', limit: '100' }),
    'GET',
    undefined,
    cookie,
    app,
    headers,
  );
async function candidate(f: Fixture, cookie = auth(), headers: Record<string, string> = {}) {
  const r = await resolver(f, cookie, headers);
  assert.equal(r.data.length, 1);
  return r.data[0] as Row;
}
const startBody = (f: Fixture, c: Row) => ({
  client_key: randomUUID(),
  line_id: c.line_id,
  version: c.line_version,
  basis_token: c.basis_token,
  code: f.p.ean,
  location: c.location,
  resolution_token: c.resolution_token,
  expires_at: c.expires_at,
  confirmed_zero: true,
  confirmed_reset: false,
  note: 'Explicit safe zero measurement',
});
const incrementBody = (f: Fixture, c: Row) => ({
  client_key: randomUUID(),
  line_id: c.line_id,
  version: c.line_version,
  basis_token: c.basis_token,
  generation_id: c.generation_id,
  code: f.p.ean,
  location: c.location,
  resolution_token: c.resolution_token,
  expires_at: c.expires_at,
  increment: 1,
});
// The request first spends its schema preflight (10-18 s on a loaded PG04 without the startup
// gate) before it reaches the held resource; wait for that exact lock edge, not a fixed 3 s.
// A held advisory key must be the ungranted key itself, a held row the holder's row lock.
async function waitOn(c: PoolClient, lockSql: string, args: unknown[], pending: ReturnType<typeof req>) {
  await waitForLockEdge(
    pool,
    {
      blocker: await backendPid(c),
      query: /stocktake|\bstock\b|\busers\b|pg_advisory_xact_lock/i,
      advisoryKey: /pg_advisory_xact_lock/.test(lockSql) ? String(args[0]) : undefined,
    },
    [pending],
  );
}
async function blocked(
  lockSql: string,
  args: unknown[],
  request: () => ReturnType<typeof req>,
  changeSql: string,
  changeArgs: unknown[],
  expected: number,
) {
  const before = await snapshot(),
    blocker = await pool.connect();
  let pending: ReturnType<typeof req> | undefined;
  try {
    await blocker.query('BEGIN');
    await blocker.query(lockSql, args);
    pending = request();
    await waitOn(blocker, lockSql, args, pending);
    const grant = await pool.connect();
    try {
      await grant.query('BEGIN');
      await grant.query("SET LOCAL statement_timeout='1500ms'");
      await grant.query(changeSql, changeArgs);
      await grant.query('COMMIT');
    } finally {
      await grant.query('ROLLBACK');
      grant.release();
    }
    await blocker.query('COMMIT');
    assert.equal((await pending).statusCode, expected);
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
    await pending;
  }
  assert.deepEqual(
    await snapshot(),
    before,
    'Late denial must rollback linked measurement, count, header, receipt, audit and all physical effects',
  );
  assert.equal(calls, 0);
}
function hidden(v: any) {
  if (Array.isArray(v)) {
    v.forEach(hidden);
    return;
  }
  if (!v || typeof v !== 'object') return;
  for (const [k, child] of Object.entries(v)) {
    assert(
      !/^(original_quantity|current_quantity|basis_quantity|basis_hash|source_snapshot|request_hash|actor_id|actor_name|request|snapshot|reserved|warehouse_on_hand|unit_cost_minor|value_minor|known_minor|unknown_quantity|layers|layer_ids|layer_id|basis)$/.test(
        k,
      ),
      'Blind scan leaked ' + k,
    );
    hidden(child);
  }
}
for (const engine of ['wms', 'quantity'] as const) {
  test(
    engine +
      ': start denies an operator downgraded while actual header lock is held, without saving zero',
    async () => {
      const f = await fixture(engine),
        cookie = auth('operator@demo.local'),
        body = startBody(f, await candidate(f, cookie));
      await blocked(
        `SELECT * FROM ${f.headTable} WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
        [tenant, f.id],
        () => req(f.base + '/scan-start', 'POST', body, cookie),
        "UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2",
        [tenant, operatorId],
        403,
      );
    },
  );
  test(
    engine + ': measurement actor-FK wait does not pin membership before late withdrawal',
    async () => {
      const f = await fixture(engine),
        cookie = auth('operator@demo.local');
      await ok(f.base + '/scan-start', 'POST', startBody(f, await candidate(f, cookie)), cookie);
      const body = incrementBody(f, await candidate(f, cookie));
      await blocked(
        'SELECT * FROM users WHERE id=$1 FOR UPDATE',
        [operatorId],
        () => req(f.base + '/scans', 'POST', body, cookie),
        "UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2",
        [tenant, operatorId],
        403,
      );
    },
  );
  test(
    engine +
      ': public write grant is rechecked after real physical wait for revoke, expiry and removed write scope',
    { timeout: 600000 },
    async () => {
      const f = await fixture(engine);
      for (const mode of ['revoked', 'expired', 'scope']) {
        const key = await ok('/developer/keys', 'POST', {
            name: 'Scan late ' + mode,
            scopes: ['inventory:read', 'inventory:write'],
          }),
          headers = { authorization: 'Bearer ' + key.token },
          c = await candidate(f, '', headers),
          body = startBody(f, c);
        const change =
          mode === 'revoked'
            ? 'UPDATE api_keys SET revoked_at=clock_timestamp() WHERE id=$1'
            : mode === 'expired'
              ? "UPDATE api_keys SET expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1"
              : "UPDATE api_keys SET scopes=ARRAY['inventory:read']::text[] WHERE id=$1";
        await blocked(
          'SELECT * FROM stock WHERE tenant_id=$1 AND product_id=$2 FOR UPDATE',
          [tenant, f.p.id],
          () => req('/v1' + f.base + '/scan-start', 'POST', body, '', app, headers),
          change,
          [key.id],
          mode === 'scope' ? 403 : 401,
        );
      }
    },
  );
  test(
    engine + ': resolver read scope withdrawn during catalog wait returns no identifiers or tokens',
    async () => {
      const f = await fixture(engine),
        key = await ok('/developer/keys', 'POST', {
          name: 'Read-only resolver',
          scopes: ['inventory:read'],
        }),
        headers = { authorization: 'Bearer ' + key.token };
      await blocked(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        ['catalog:' + tenant],
        () =>
          req(
            '/v1' +
              f.base +
              '/scan-candidates?' +
              new URLSearchParams({ code: f.p.ean, location: 'A-01' }),
            'GET',
            undefined,
            '',
            app,
            headers,
          ),
        "UPDATE api_keys SET scopes=ARRAY['products:read']::text[] WHERE id=$1",
        [key.id],
        403,
      );
    },
  );
  test(
    engine +
      ': blind operator/viewer projection, wrong-actor HMAC, strict increment and public compound scopes',
    async () => {
      const f = await fixture(engine),
        operator = auth('operator@demo.local'),
        c = await candidate(f, operator),
        body = startBody(f, c);
      hidden(await resolver(f, operator));
      hidden(await resolver(f, auth('viewer@demo.local')));
      const before = await snapshot();
      assert.equal((await req(f.base + '/scan-start', 'POST', body)).statusCode, 409);
      assert.equal(
        (await req(f.base + '/scan-start', 'POST', body, auth('viewer@demo.local'))).statusCode,
        403,
      );
      assert.deepEqual(await snapshot(), before);
      const zero = await ok(f.base + '/scan-start', 'POST', body, operator);
      hidden(zero);
      const measured = await snapshot();
      hidden(await ok(f.base + '/scan-start', 'POST', body, operator));
      assert.deepEqual(await snapshot(), measured);
      if (engine === 'quantity') {
        const legacy = await ok(f.base + '/measurements', 'GET', undefined, operator);
        for (const measurement of legacy.data)
          for (const line of measurement.result.lines ?? [])
            assert.equal(
              Object.hasOwn(line, 'basis_hash'),
              false,
              'Legacy OFF history must not leak private scan bases',
            );
        const internal = (
          await pool.query(
            'SELECT client_key,inputs,note FROM stocktake_measurements WHERE id=$1',
            [zero.scan.measurement_id],
          )
        ).rows[0];
        // Trusted test-only lookup reconstructs the genuine old request. Public
        // legacy replay must not expose the internal scan measurement result.
        assert.equal(
          (
            await req(
              f.base + '/counts',
              'POST',
              { client_key: internal.client_key, lines: internal.inputs, note: internal.note },
              operator,
            )
          ).statusCode,
          409,
        );
        assert.deepEqual(await snapshot(), measured);
      }
      hidden(await ok(f.base + '/scans', 'GET', undefined, auth('viewer@demo.local')));
      hidden(await ok(f.base + '/scans/' + zero.scan.id, 'GET', undefined, operator));
      const next = incrementBody(f, await candidate(f, operator));
      for (const changed of [
        { increment: 2 },
        { increment: -1 },
        { quantity: 1 },
        { previous_count: 0 },
        { target_quantity: 1 },
      ])
        assert.equal(
          (await req(f.base + '/scans', 'POST', { ...next, ...changed }, operator)).statusCode,
          422,
        );
      assert.deepEqual(await snapshot(), measured);
      const onlyWrite = await ok('/developer/keys', 'POST', {
          name: 'Write without read',
          scopes: ['inventory:write'],
        }),
        writeHeaders = { authorization: 'Bearer ' + onlyWrite.token };
      assert.equal(
        (
          await req(
            '/v1' + f.base + '/scan-candidates?code=' + f.p.ean + '&location=A-01',
            'GET',
            undefined,
            '',
            app,
            writeHeaders,
          )
        ).statusCode,
        403,
      );
      assert.equal(
        (await req('/v1' + f.base + '/scan-start', 'POST', {}, '', app, writeHeaders)).statusCode,
        403,
      );
      const readOnly = await ok('/developer/keys', 'POST', {
          name: 'Read without write',
          scopes: ['inventory:read'],
        }),
        readHeaders = { authorization: 'Bearer ' + readOnly.token };
      assert.equal(
        (await req('/v1' + f.base + '/scan-metadata', 'GET', undefined, '', app, readHeaders))
          .statusCode,
        200,
      );
      assert.equal(
        (await req('/v1' + f.base + '/scans', 'POST', {}, '', app, readHeaders)).statusCode,
        403,
      );
    },
  );
}
test('both engines: restore readonly and missing094 reject malformed JSON before parsing while old stocktake reads remain', async () => {
  const f = await fixture('quantity'),
    key = await ok('/developer/keys', 'POST', {
      name: 'Readonly/missing scan capability',
      scopes: ['inventory:read', 'inventory:write'],
    }),
    headers = { authorization: 'Bearer ' + key.token };
  let readonly: Awaited<ReturnType<typeof buildApp>> | undefined,
    older: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    readonly = await buildApp({
      readOnly: true,
      previewPort: 4117,
      integrationTransport: transport,
    });
    const meta = await ok(
      '/v1' + f.base + '/scan-metadata',
      'GET',
      undefined,
      '',
      readonly,
      headers,
    );
    assert(meta.read_only);
    assert.equal(meta.can_scan, false);
    assert.equal(meta.can_resolve, true);
    for (const path of [
      f.base + '/scan-start',
      f.base + '/scans',
      '/wms-lots/stocktakes/' + randomUUID() + '/scan-start',
      '/wms-lots/stocktakes/' + randomUUID() + '/scans',
    ]) {
      const r = await req('/v1' + path, 'POST', '{bad', '', readonly, {
        ...headers,
        'content-type': 'application/json',
      });
      assert.equal(r.statusCode, 423);
      assert.match(String(r.headers['cache-control']), /no-store/);
    }
    await pool.query(
      'ALTER TABLE stocktake_scan_receipts RENAME TO stocktake_scan_receipts_safety_missing',
    );
    older = await buildApp({ integrationTransport: transport });
    const metadata = await ok(f.base + '/scan-metadata', 'GET', undefined, auth(), older);
    assert.equal(metadata.available, false);
    assert.equal(metadata.can_scan, false);
    for (const suffix of ['/scan-start', '/scans'])
      assert.equal(
        (
          await req(f.base + suffix, 'POST', '{bad', auth(), older, {
            'content-type': 'application/json',
          })
        ).statusCode,
        503,
      );
    assert.equal((await req(f.base, 'GET', undefined, auth(), older)).statusCode, 200);
  } finally {
    await older?.close();
    await readonly?.close();
    if (
      (
        await pool.query(
          "SELECT to_regclass('public.stocktake_scan_receipts_safety_missing') present",
        )
      ).rows[0].present
    )
      await pool.query(
        'ALTER TABLE stocktake_scan_receipts_safety_missing RENAME TO stocktake_scan_receipts',
      );
  }
});
async function insertClone(c: PoolClient, value: Row) {
  const columns = (
    await c.query(
      `SELECT a.attname,t.typname FROM pg_attribute a JOIN pg_type t ON t.oid=a.atttypid WHERE a.attrelid='stocktake_scan_receipts'::regclass AND a.attnum>0 AND NOT a.attisdropped AND a.attgenerated='' ORDER BY a.attnum`,
    )
  ).rows;
  return c.query(
    `INSERT INTO stocktake_scan_receipts(${columns.map((v) => '"' + v.attname + '"').join(',')}) VALUES(${columns.map((_, i) => '$' + (i + 1)).join(',')})`,
    columns.map((v) =>
      v.typname === 'jsonb' && value[v.attname] !== null
        ? JSON.stringify(value[v.attname])
        : value[v.attname],
    ),
  );
}
for (const engine of ['wms', 'quantity'] as const) {
  test(
    engine +
      ': populated receipt immutability/RLS and forged arithmetic, code and foreign source cannot bypass linked measurement',
    async () => {
      const f = await fixture(engine),
        zero = await ok(f.base + '/scan-start', 'POST', startBody(f, await candidate(f))),
        increment = await ok(f.base + '/scans', 'POST', incrementBody(f, await candidate(f)));
      const flags = (
        await pool.query(
          "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='stocktake_scan_receipts'::regclass",
        )
      ).rows[0];
      assert(flags.relrowsecurity && flags.relforcerowsecurity);
      assert.equal(
        (
          await pool.query(
            "SELECT has_table_privilege('dyna_app','stocktake_scan_receipts','UPDATE') yes",
          )
        ).rows[0].yes,
        false,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT has_table_privilege('dyna_app','stocktake_scan_receipts','DELETE') yes",
          )
        ).rows[0].yes,
        false,
      );
      await tenantTx(SECOND_TENANT, async (c) =>
        assert.equal(
          (await c.query('SELECT * FROM stocktake_scan_receipts WHERE tenant_id=$1', [tenant]))
            .rowCount,
          0,
        ),
      );
      const before = await snapshot();
      for (const sql of [
        'UPDATE stocktake_scan_receipts SET counted=counted WHERE id=$1',
        'DELETE FROM stocktake_scan_receipts WHERE id=$1',
      ])
        await assert.rejects(pool.query(sql, [increment.scan.id]), (e: any) => e.code === '23514');
      const original = (
        await pool.query('SELECT * FROM stocktake_scan_receipts WHERE id=$1', [increment.scan.id])
      ).rows[0];
      const arithmetic: Row = {
        ...original,
        id: randomUUID(),
        client_key: randomUUID(),
        before_line_version: original.after_line_version,
        after_line_version: (BigInt(original.after_line_version) + 1n).toString(),
        previous_count: 1,
        counted: 2,
        prior_scan_id: original.id,
      };
      arithmetic.request = {
        ...arithmetic.request,
        client_key: arithmetic.client_key,
        version: arithmetic.before_line_version,
      };
      arithmetic.result = {
        ...arithmetic.result,
        id: arithmetic.id,
        before_line_version: arithmetic.before_line_version,
        after_line_version: arithmetic.after_line_version,
        previous_count: 1,
        counted: 2,
      };
      // All existing typed measurement FKs remain valid, but that genuine
      // measurement never recorded 2: the INSERT must fail, not invent evidence.
      await assert.rejects(
        tenantTx(tenant, (c) => insertClone(c, arithmetic)),
        (e: any) => e.code === '23514',
      );
      const start = (
          await pool.query('SELECT * FROM stocktake_scan_receipts WHERE id=$1', [zero.scan.id])
        ).rows[0],
        id = randomUUID(),
        clientKey = start.client_key;
      // Retain the genuine deterministic measurement key. The BEFORE INSERT
      // identifier guard must reject these before the existing client-key unique
      // constraint; otherwise an unrelated source-key error would mask the bug.
      const forgedCode = {
        ...start,
        id,
        client_key: clientKey,
        generation_id: id,
        code: 'UNRELATED-CODE',
        source_snapshot: { ...start.source_snapshot, current_sku: null, current_ean: null },
        request: { ...start.request, client_key: clientKey, code: 'UNRELATED-CODE' },
        result: { ...start.result, id, generation_id: id, code: 'UNRELATED-CODE' },
      };
      // NULL OR semantics must not turn the identifier guard into acceptance.
      await assert.rejects(
        tenantTx(tenant, (c) => insertClone(c, forgedCode)),
        (e: any) => e.code === '23514',
      );
      const inventedIdentifier = {
        ...forgedCode,
        source_snapshot: { ...start.source_snapshot, current_ean: 'UNRELATED-CODE' },
      };
      // A self-consistent invented non-NULL identifier snapshot also fails: the
      // private snapshot must match the genuine scoped product, not just itself.
      await assert.rejects(
        tenantTx(tenant, (c) => insertClone(c, inventedIdentifier)),
        (e: any) => e.code === '23514',
      );
      const inventedMatch = {
        ...start,
        id,
        client_key: clientKey,
        generation_id: id,
        matched_by: ['sku_alias'],
        request: { ...start.request, client_key: clientKey },
        result: { ...start.result, id, generation_id: id, matched_by: ['sku_alias'] },
      };
      await assert.rejects(
        tenantTx(tenant, (c) => insertClone(c, inventedMatch)),
        (e: any) => e.code === '23514',
      );
      // A distinct typed line avoids the existing (engine,line,after_version)
      // unique key, so this tests the genuine composite source FK itself.
      const foreign: Row = {
        ...start,
        id: randomUUID(),
        client_key: randomUUID(),
        ...(engine === 'wms'
          ? { wms_stocktake_id: randomUUID(), wms_line_id: randomUUID() }
          : { quantity_stocktake_id: randomUUID(), quantity_line_id: randomUUID() }),
      };
      foreign.generation_id = foreign.id;
      foreign.request = { ...foreign.request, client_key: foreign.client_key };
      foreign.result = { ...foreign.result, id: foreign.id, generation_id: foreign.id };
      await assert.rejects(
        tenantTx(tenant, (c) => insertClone(c, foreign)),
        (e: any) => e.code === '23503',
      );
      const fk = (
        await pool.query(
          `SELECT count(*)::int n FROM pg_constraint WHERE conrelid='stocktake_scan_receipts'::regclass AND contype='f' AND pg_get_constraintdef(oid) LIKE '%tenant_id,%'`,
        )
      ).rows[0].n;
      assert(
        fk >= 9,
        'Typed parent, product, measurement and same-line generation are genuine composite FKs',
      );
      const measurementTable =
        engine === 'wms' ? 'wms_stocktake_measurements' : 'stocktake_measurements';
      await assert.rejects(
        pool.query(`DELETE FROM ${measurementTable} WHERE id=$1`, [increment.scan.measurement_id]),
        (e: any) => e.code === '23514',
      );
      assert.deepEqual(await snapshot(), before);
    },
  );
  test(
    engine +
      ': body/HMAC bounds and role-bound cursors fail without partial counts or history truncation',
    async () => {
      const f = await fixture(engine),
        first = await ok(f.base + '/scan-start', 'POST', startBody(f, await candidate(f)));
      await ok(f.base + '/scans', 'POST', incrementBody(f, await candidate(f)));
      const current = await candidate(f),
        body = incrementBody(f, current),
        before = await snapshot();
      for (const changed of [
        { expires_at: new Date(Date.now() + 86400000).toISOString() },
        { expires_at: '2000-01-01T00:00:00.000Z' },
        { resolution_token: 'a'.repeat(64) },
        { basis_token: 'b'.repeat(64) },
      ])
        assert.equal(
          (await req(f.base + '/scans', 'POST', { ...body, ...changed })).statusCode,
          409,
        );
      for (const code of ['12\u000012', '12\n12', 'x'.repeat(81)])
        assert.equal(
          (
            await req(
              f.base + '/scan-candidates?' + new URLSearchParams({ code, location: 'A-01' }),
            )
          ).statusCode,
          422,
        );
      // URLSearchParams would replace a lone surrogate before transport. JSON
      // preserves the escaped invalid scalar and exercises the actual body guard.
      assert.equal(
        (await req(f.base + '/scans', 'POST', { ...body, code: '\ud800' })).statusCode,
        422,
      );
      assert.equal(
        (await req(f.base + '/scans', 'POST', { ...body, extra: '😀'.repeat(5000) })).statusCode,
        413,
      );
      assert.deepEqual(await snapshot(), before);
      const page = await ok(f.base + '/scans?limit=1');
      assert.equal(page.data.length, 1);
      assert(page.meta.cursor);
      assert.equal(
        (
          await req(
            f.base + '/scans?limit=1&cursor=' + encodeURIComponent(page.meta.cursor),
            'GET',
            undefined,
            auth('viewer@demo.local'),
          )
        ).statusCode,
        409,
      );
      const replay = await ok(f.base + '/scan-start', 'POST', {
        ...startBody(f, current),
        ...(
          await pool.query('SELECT request FROM stocktake_scan_receipts WHERE id=$1', [
            first.scan.id,
          ])
        ).rows[0].request,
      });
      assert(replay.reused);
      assert.deepEqual(replay.scan, first.scan);
      assert.deepEqual(await snapshot(), before);
    },
  );
  test(
    engine +
      ': reduced isolated receipt threshold exercises genuine quota rollback and exact retry without claiming default capacity',
    async () => {
      const f = await fixture(engine),
        mutableLimits = STOCKTAKE_SCAN_LIMITS as { receipts_per_stocktake: number },
        original = mutableLimits.receipts_per_stocktake;
      // Explicit test configuration only: actual HTTP/SQL receipts and linked
      // measurements still use the production path. No 100000-row fixture or
      // default-limit/capacity claim is made, and the export is always restored.
      try {
        mutableLimits.receipts_per_stocktake = 1;
        const body = startBody(f, await candidate(f)),
          first = await ok(f.base + '/scan-start', 'POST', body),
          before = await snapshot();
        assert.equal(
          (await req(f.base + '/scans', 'POST', incrementBody(f, await candidate(f)))).statusCode,
          429,
        );
        assert.deepEqual(await snapshot(), before);
        const retry = await ok(f.base + '/scan-start', 'POST', body);
        assert(retry.reused);
        assert.deepEqual(retry.scan, first.scan);
        assert.deepEqual(await snapshot(), before);
      } finally {
        mutableLimits.receipts_per_stocktake = original;
      }
    },
  );
}
