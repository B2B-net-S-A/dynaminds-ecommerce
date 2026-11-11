import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { wmsLotsHash } from '../server/wms-lots';
import { DEMO_TENANT, seed } from './fixtures';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/dynaminds_test_\d+$/);
type Row = Record<string, any>;
let app: Awaited<ReturnType<typeof buildApp>>;
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({
    integrationTransport: async () => {
      throw Error('Identity safety is local');
    },
  });
});
after(async () => {
  try {
    await app?.close();
  } finally {
    await pool.end();
  }
});
async function snapshot(tenant: string) {
  const names = (
    await pool.query(
      "SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t USING(table_schema,table_name) WHERE c.table_schema='public' AND c.column_name='tenant_id' AND t.table_type='BASE TABLE' AND c.table_name<>'sessions' ORDER BY 1",
    )
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

test('stock identity lookup preserves full-tenant inactive/bundle ambiguity, distinct alias ownership and canonical UUID at both HTTP and typed SQL boundaries', async () => {
  const tenant = randomUUID(),
    warehouse = randomUUID();
  const user = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
  const otherBefore = await snapshot(DEMO_TENANT);
  await pool.query(
    "INSERT INTO tenants(id,name,plan) VALUES($1,'Own identity lookup safety','enterprise')",
    [tenant],
  );
  await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [
    tenant,
    user,
  ]);
  await pool.query(
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Identity warehouse','IDENTITY')",
    [warehouse, tenant],
  );
  let cookie = '';
  const req = (path: string, method: any = 'GET', payload?: any) =>
    app.inject({
      url: '/api' + path,
      method,
      payload,
      headers: { cookie },
      remoteAddress: '127.9.116.1',
    });
  const login = await req('/auth/login', 'POST', {
    email: 'admin@demo.local',
    password: 'DynaDemo!2026',
  });
  assert.equal(login.statusCode, 200);
  cookie = String(login.headers['set-cookie']).split(';')[0];
  const switched = await req('/workspaces/switch', 'POST', { tenant_id: tenant });
  assert.equal(switched.statusCode, 200);
  cookie = String(switched.headers['set-cookie']).split(';')[0];
  async function api(path: string, method: any = 'GET', payload?: any, status = 200): Promise<Row> {
    const response = await req(path, method, payload);
    assert.equal(response.statusCode, status, `${method} ${path}: ${response.body.slice(0, 500)}`);
    if (path.startsWith('/stock-file-imports'))
      assert.match(String(response.headers['cache-control']), /no-store/);
    return response.json();
  }
  async function product(extra: Row = {}) {
    const digits = String(randomInt(100_000_000_000, 1_000_000_000_000));
    const checksum = [...digits].reduce(
      (sum, digit, index) => sum + Number(digit) * (index % 2 ? 3 : 1),
      0,
    );
    return api(
      '/products',
      'POST',
      {
        name: 'Own ' + randomUUID(),
        sku: 'IDENTITY-' + randomUUID(),
        ean: digits + String((10 - (checksum % 10)) % 10),
        price: 2500,
        vat: 23,
        warehouse_id: warehouse,
        quantity: 10,
        location: 'A-01',
        ...extra,
      },
      201,
    );
  }
  function body(identity: string, value: string): Row {
    return {
      client_key: randomUUID(),
      file_name: 'identity.csv',
      note: 'Exact whole-tenant identity',
      definition: {
        format: 'csv',
        xml_mode: 'positions',
        delimiter: ';',
        identity,
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
      content: `Kod;Stan\n${value};10`,
    };
  }
  async function preview(identity: string, value: string) {
    return (await api('/stock-file-imports/previews', 'POST', body(identity, value), 201))
      .preview as Row;
  }
  async function stored(id: string): Promise<Row> {
    return (
      await pool.query(
        'SELECT payload FROM stock_file_import_previews WHERE id=$1 AND tenant_id=$2',
        [id, tenant],
      )
    ).rows[0].payload;
  }
  const consent = (p: Row) => ({
    client_key: randomUUID(),
    scope_hash: p.scope_hash,
    confirmed: true,
    ack_unknown_loss_warehouse_ids: [],
    ack_surplus_warehouse_ids: [],
  });
  const identityError = (e: any) =>
    e.code === '23514' && e.message === 'Tożsamość produktu jest niejednoznaczna';
  async function denyPrepare(p: Row) {
    const before = await snapshot(tenant);
    let reachedPrepare = false;
    await assert.rejects(
      tenantTx(tenant, async (c) => {
        reachedPrepare = true;
        await c.query('SELECT stock_file_import_prepare($1,$2,$3,$4,$5)', [
          p.id,
          randomUUID(),
          user,
          null,
          JSON.stringify(consent(p)),
        ]);
      }),
      (e: any) => e.code === '23514' && e.message === 'Niepoprawna zgoda na pomiar',
    );
    assert(reachedPrepare);
    assert.deepEqual(await snapshot(tenant), before);
  }
  async function ownerValidate(payload: Row, expectedError?: (e: any) => boolean) {
    const before = await snapshot(tenant),
      client = await pool.connect();
    let reachedValidator = false;
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
      const validate = async () => {
        reachedValidator = true;
        await client.query('SELECT stock_file_import_validate_preview($1)', [
          JSON.stringify(payload),
        ]);
      };
      if (expectedError) await assert.rejects(validate(), expectedError);
      else await validate();
    } finally {
      try {
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    }
    assert(reachedValidator);
    assert.deepEqual(await snapshot(tenant), before);
    if (expectedError) {
      let reachedStore = false;
      await assert.rejects(
        tenantTx(tenant, async (c) => {
          reachedStore = true;
          await c.query('SELECT stock_file_import_store_preview($1)', [JSON.stringify(payload)]);
        }),
        expectedError,
      );
      assert(reachedStore, 'Granted app writer must independently invoke the identity validator');
      assert.deepEqual(await snapshot(tenant), before);
    }
  }
  async function forgeChosenSnapshot(base: Row, identity: string, value: string) {
    const forged: Row = structuredClone(base);
    forged.id = randomUUID();
    forged.client_key = randomUUID();
    forged.request.client_key = forged.client_key;
    forged.definition.identity = identity;
    forged.request.definition.identity = identity;
    forged.request.content = `Kod;Stan\n${value};10`;
    forged.source_hash = createHash('sha256').update(forged.request.content, 'utf8').digest('hex');
    for (const row of forged.rows) {
      row.raw_cells.Kod = value;
      row.resolution = {
        ...row.resolution,
        identity,
        value,
        matched_historical_sku: null,
        candidates: [row.product_id],
      };
      row.errors = [];
      assert.equal(row.status, 'unchanged');
    }
    assert.equal(forged.summary.invalid, 0);
    // Product creation legitimately extends tenant-wide journals. Freeze their
    // current actual values so a stale-journal rejection cannot mask identity.
    forged.snapshot = await tenantTx(
      tenant,
      async (c) =>
        (
          await c.query('SELECT stock_file_import_snapshot($1) snapshot', [
            JSON.stringify({
              warehouse_ids: [warehouse],
              product_ids: [forged.rows[0].product_id],
            }),
          ])
        ).rows[0].snapshot,
    );
    assert.equal(
      forged.snapshot.products.length,
      1,
      'Attack freezes only the selected legitimate product',
    );
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
    return forged;
  }
  // The second candidate must participate even though it cannot be counted physically.
  for (const kind of ['inactive', 'bundle']) {
    const selected = await product();
    const readyName = await preview('name', selected.name),
      readyEan = await preview('ean', selected.ean);
    assert.equal(readyName.summary.invalid, 0);
    assert.equal(readyEan.summary.invalid, 0);
    const base = await stored(readyName.id);
    const second = await product({
      name: selected.name,
      ean: selected.ean,
      quantity: 0,
      ...(kind === 'inactive'
        ? { active: false }
        : { kind: 'bundle', components: [{ product_id: selected.id, quantity: 1 }] }),
    });
    assert.notEqual(second.id, selected.id);
    assert.equal(
      kind === 'inactive' ? second.active : second.kind,
      kind === 'inactive' ? false : 'bundle',
    );
    for (const [identity, value] of [
      ['name', selected.name],
      ['ean', selected.ean],
    ] as const) {
      const blocked = await preview(identity, value);
      assert.equal(
        blocked.summary.invalid,
        1,
        `${kind} remains an ambiguity candidate for ${identity}`,
      );
      const rows = await api('/stock-file-imports/previews/' + blocked.id + '/rows');
      assert.equal(rows.rows.length, 1);
      assert.equal(rows.rows[0].status, 'invalid');
      const before = await snapshot(tenant);
      await api(
        '/stock-file-imports/previews/' + blocked.id + '/execute',
        'POST',
        consent(blocked),
        409,
      );
      assert.deepEqual(await snapshot(tenant), before);
      // The authenticated HTTP invalid preview is also denied by the actual SQL admission.
      // Its exact consent error is separate from the reached identity guard below.
      await denyPrepare(blocked);
      // An owner-authorized direct validator reaches the same identity guard with valid
      // hashes and a real before/after, despite a caller omitting the second product.
      await ownerValidate(await forgeChosenSnapshot(base, identity, value), identityError);
    }
  }
  const p = await product(),
    q = await product();
  const current = await preview('historical_sku', p.sku);
  assert.equal(current.summary.invalid, 0);
  const currentPayload = await stored(current.id);
  assert.deepEqual(currentPayload.rows[0].resolution.candidates, [p.id]);
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::int n FROM product_sku_aliases WHERE tenant_id=$1 AND product_id=$2 AND sku=$3',
        [tenant, p.id, p.sku],
      )
    ).rows[0].n,
    1,
  );
  await ownerValidate(currentPayload); // current SKU + its durable alias counts one product.
  const qOld = q.sku;
  await api('/products/' + q.id, 'PATCH', {
    name: q.name,
    price: q.price,
    sku: 'RENAMED-' + randomUUID(),
    version: q.version,
  });
  const historical = await preview('historical_sku', qOld);
  assert.equal(historical.summary.invalid, 0);
  assert.equal((await stored(historical.id)).rows[0].product_id, q.id);
  await ownerValidate(
    await forgeChosenSnapshot(currentPayload, 'historical_sku', qOld),
    identityError,
  );
  // A cross-product current/alias collision cannot be seeded honestly: 085 reserves
  // tenant-wide historic SKU ownership even for owner SQL. Do not disable that guard.
  const beforeClaim = await snapshot(tenant);
  await api(
    '/products/' + p.id,
    'PATCH',
    { name: p.name, price: p.price, sku: qOld, version: p.version },
    409,
  );
  assert.deepEqual(await snapshot(tenant), beforeClaim);
  const upper = await preview('uuid', p.id.toUpperCase());
  assert.equal(upper.summary.invalid, 0);
  const upperPayload = await stored(upper.id);
  assert.equal(upperPayload.rows[0].resolution.value, p.id);
  assert.equal(upperPayload.rows[0].raw_cells.Kod, p.id.toUpperCase());
  await ownerValidate(upperPayload);
  assert.deepEqual(await snapshot(DEMO_TENANT), otherBefore);
});
