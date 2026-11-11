import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { seed } from './fixtures';

assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>;
let fixtureAddress = 1;
before(async () => {
  await migrate();
  await seed();
  app = await buildApp();
});
after(async () => {
  try {
    if (app) await app.close();
  } finally {
    await pool.end();
  }
});
const req = (
  path: string,
  method: any = 'GET',
  payload?: unknown,
  headers: Record<string, string> = {},
) =>
  app.inject({
    url: path,
    method,
    payload: payload as any,
    headers,
    remoteAddress: '127.0.40.' + fixtureAddress,
  });
async function ok(
  path: string,
  method: any = 'GET',
  payload?: unknown,
  headers: Record<string, string> = {},
) {
  const result = await req(path, method, payload, headers);
  assert(result.statusCode < 300, result.body);
  return result.json();
}
async function fixture() {
  fixtureAddress++;
  const result = await req('/api/auth/signup', 'POST', {
    email: 'field-public-' + randomUUID() + '@example.test',
    password: 'FieldPublic!2026',
    name: 'QA private fields',
    organization: { name: 'QA public fields ' + randomUUID() },
  });
  assert.equal(result.statusCode, 201, result.body);
  const user = result.json().user;
  const headers = { cookie: String(result.headers['set-cookie']).split(';')[0] };
  const warehouse = (await ok('/api/warehouses', 'GET', undefined, headers)).data[0].id;
  const product = await ok(
    '/api/products',
    'POST',
    {
      warehouse_id: warehouse,
      sku: 'FIELD-' + randomUUID(),
      name: 'Scoped field product',
      price: 1000,
      quantity: 100,
    },
    headers,
  );
  const definition = await ok(
    '/api/order-fields',
    'POST',
    {
      client_key: randomUUID(),
      key: 'private_instruction',
      type: 'text',
      label: 'Prywatna instrukcja',
      read_role: 'admin',
      write_role: 'admin',
    },
    headers,
  );
  const body = {
    customer_name: 'QA scoped fields',
    email: 'qa-scoped@example.test',
    warehouse_id: warehouse,
    items: [{ product_id: product.id, quantity: 1 }],
    initial_fields: [
      {
        field_id: definition.id,
        definition_version: 1,
        type: 'text',
        value: 'PRIVATE-FIELD-SENTINEL',
      },
    ],
  };
  const order = await ok('/api/orders', 'POST', body, headers);
  const key = async (scopes: string[]) => {
    const created = await ok('/api/developer/keys', 'POST', { name: 'QA scopes', scopes }, headers);
    return { authorization: 'Bearer ' + created.token };
  };
  return { user, headers, definition, body, order, key };
}
test('orders scopes cannot read, filter or create private fields; explicit field read can', async () => {
  const f = await fixture();
  const basic = await f.key(['orders:read', 'orders:write']);
  for (const path of ['/api/v1/orders', '/api/v1/orders/' + f.order.id]) {
    const response = await req(path, 'GET', undefined, basic);
    assert.equal(response.statusCode, 200, response.body);
    assert(!response.body.includes('PRIVATE-FIELD-SENTINEL'));
    assert(!response.body.includes('private_instruction'));
  }
  assert.equal(
    (await req('/api/v1/orders/' + f.order.id + '/fields', 'GET', undefined, basic)).statusCode,
    403,
  );
  const query =
    '/api/v1/orders?' + new URLSearchParams({ field_columns: JSON.stringify([f.definition.id]) });
  assert.equal((await req(query, 'GET', undefined, basic)).statusCode, 403);
  const before = (
    await pool.query('SELECT count(*)::int n FROM orders WHERE tenant_id=$1', [f.user.tenant_id])
  ).rows[0].n;
  const denied = await req('/api/v1/orders', 'POST', f.body, {
    ...basic,
    'idempotency-key': randomUUID(),
  });
  assert.equal(denied.statusCode, 403, denied.body);
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM orders WHERE tenant_id=$1', [f.user.tenant_id]))
      .rows[0].n,
    before,
  );
  const scoped = await f.key(['orders:read', 'order-fields:read']);
  const fields = await req('/api/v1/orders/' + f.order.id + '/fields', 'GET', undefined, scoped);
  assert.equal(fields.statusCode, 200, fields.body);
  assert(fields.body.includes('PRIVATE-FIELD-SENTINEL'));
  const columns = await req(query, 'GET', undefined, scoped);
  assert.equal(columns.statusCode, 200, columns.body);
  assert(columns.body.includes('PRIVATE-FIELD-SENTINEL'));
});
test('typed public write records API provenance without putting values in general order events', async () => {
  const f = await fixture();
  const scoped = await f.key(['orders:read', 'orders:write', 'order-fields:write']);
  const created = await req('/api/v1/orders', 'POST', f.body, {
    ...scoped,
    'idempotency-key': randomUUID(),
  });
  assert.equal(created.statusCode, 201, created.body);
  assert(!created.body.includes('PRIVATE-FIELD-SENTINEL'));
  const order = created.json();
  const initialEntry = (
    await pool.query(
      'SELECT source FROM order_field_values WHERE tenant_id=$1 AND order_id=$2 AND field_id=$3',
      [f.user.tenant_id, order.id, f.definition.id],
    )
  ).rows[0];
  assert.equal(initialEntry.source, 'api');
  const patched = await req(
    '/api/v1/orders/' + order.id + '/fields',
    'PATCH',
    {
      client_key: randomUUID(),
      order_version: Number(order.version),
      changes: [
        {
          field_id: f.definition.id,
          definition_version: 1,
          type: 'text',
          value: 'PRIVATE-API-WRITE',
        },
      ],
    },
    scoped,
  );
  assert.equal(patched.statusCode, 200, patched.body);
  assert(!patched.body.includes('PRIVATE-API-WRITE'));
  assert(!patched.body.includes('PRIVATE-FIELD-SENTINEL'));
  const entry = (
    await pool.query(
      'SELECT source FROM order_field_values WHERE tenant_id=$1 AND order_id=$2 AND field_id=$3',
      [f.user.tenant_id, order.id, f.definition.id],
    )
  ).rows[0];
  assert.equal(entry.source, 'api');
  const events = (
    await pool.query('SELECT detail FROM order_events WHERE tenant_id=$1 AND order_id=$2', [
      f.user.tenant_id,
      order.id,
    ])
  ).rows;
  assert(!JSON.stringify(events).includes('PRIVATE-'));
  const audit = (
    await pool.query(
      "SELECT detail FROM audit_events WHERE tenant_id=$1 AND action='order.fields_changed'",
      [f.user.tenant_id],
    )
  ).rows;
  assert(!JSON.stringify(audit).includes('PRIVATE-'));
});
test('orders-only bearer creates a field-free order; team/admin defaults require field-write scope and cookie defaults remain local', async () => {
  const f = await fixture(),
    defs = [];
  for (const role of ['team', 'admin'])
    defs.push(
      await ok(
        '/api/order-fields',
        'POST',
        {
          client_key: randomUUID(),
          key: 'default_' + role,
          label: 'Default ' + role,
          type: 'text',
          read_role: role,
          write_role: role === 'admin' ? 'admin' : 'operator',
          required_on: ['manual_create'],
          config: { default: 'PRIVATE-DEFAULT-' + role },
        },
        f.headers,
      ),
    );
  const { initial_fields, ...body } = f.body,
    basic = await f.key(['orders:read', 'orders:write']),
    scoped = await f.key(['orders:read', 'orders:write', 'order-fields:write']);
  for (const emptyFields of [false, true]) {
    const headers = { ...basic, 'idempotency-key': randomUUID() },
      requestBody = emptyFields ? { ...body, initial_fields: [] } : body,
      created = await req('/api/v1/orders', 'POST', requestBody, headers);
    assert.equal(created.statusCode, 201, created.body);
    assert(!created.body.includes('PRIVATE-DEFAULT-'));
    const order = created.json();
    assert.equal(Number(order.version), 1);
    const entries = (
      await pool.query('SELECT * FROM order_field_values WHERE tenant_id=$1 AND order_id=$2', [
        f.user.tenant_id,
        order.id,
      ])
    ).rows;
    assert.deepEqual(entries, []);
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int n FROM order_field_value_events WHERE tenant_id=$1 AND order_id=$2',
          [f.user.tenant_id, order.id],
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int n FROM audit_events WHERE tenant_id=$1 AND entity_id=$2 AND action='order.fields_changed'",
          [f.user.tenant_id, order.id],
        )
      ).rows[0].n,
      0,
    );
    {
      const replay = await req('/api/v1/orders', 'POST', requestBody, headers);
      assert.equal(replay.statusCode, 200, replay.body);
      assert.equal(replay.json().id, order.id);
      assert(!replay.body.includes('PRIVATE-DEFAULT-'));
    }
    for (const path of ['/api/v1/orders/' + order.id, '/api/v1/orders']) {
      const read = await req(path, 'GET', undefined, basic);
      assert.equal(read.statusCode, 200, read.body);
      assert(!read.body.includes('PRIVATE-DEFAULT-'));
    }
  }
  for (const [headers, source] of [
    [f.headers, 'manual'],
    [scoped, 'api'],
  ] as const) {
    const created = await req(
      headers === f.headers ? '/api/orders' : '/api/v1/orders',
      'POST',
      body,
      { ...headers, ...(source === 'api' ? { 'idempotency-key': randomUUID() } : {}) },
    );
    assert.equal(created.statusCode, 201, created.body);
    assert(!created.body.includes('PRIVATE-DEFAULT-'));
    const order = created.json();
    assert.equal(Number(order.version), 1);
    const values = (
      await pool.query(
        'SELECT field_id,payload,source FROM order_field_values WHERE tenant_id=$1 AND order_id=$2 ORDER BY field_id',
        [f.user.tenant_id, order.id],
      )
    ).rows;
    assert.equal(values.length, 2);
    for (const def of defs) {
      const v = values.find((v) => v.field_id === def.id);
      assert.equal(v.payload.value, def.config.default);
      assert.equal(v.source, source);
    }
    const events = (
      await pool.query('SELECT detail FROM order_events WHERE tenant_id=$1 AND order_id=$2', [
        f.user.tenant_id,
        order.id,
      ])
    ).rows;
    assert(!JSON.stringify(events).includes('PRIVATE-DEFAULT-'));
    const audit = (
      await pool.query('SELECT detail FROM audit_events WHERE tenant_id=$1 AND entity_id=$2', [
        f.user.tenant_id,
        order.id,
      ])
    ).rows;
    assert(!JSON.stringify(audit).includes('PRIVATE-DEFAULT-'));
  }
});
test('field configuration scope is separate from value writes and OpenAPI describes typed operations', async () => {
  const f = await fixture();
  const scoped = await f.key(['order-fields:write']);
  assert.equal(
    (
      await req(
        '/api/v1/order-fields',
        'POST',
        {
          client_key: randomUUID(),
          key: 'unexpected',
          type: 'text',
          label: 'Denied',
        },
        scoped,
      )
    ).statusCode,
    403,
  );
  const schema = await ok('/api/v1/openapi');
  assert(schema.paths['/orders/{id}/fields'].patch.requestBody.content['application/json'].schema);
  assert.equal(schema.paths['/order-field-files/{id}/download'].get.summary, 'order-fields:read');
  assert(schema.paths['/orders'].get.parameters.some((p: any) => p.name === 'field_columns'));
  assert(
    schema.paths['/orders'].post.requestBody.content['application/json'].schema.properties
      .initial_fields,
  );
});
test('restored-copy field flags disable writes and mutation rejection precedes malformed body parsing', async () => {
  const f = await fixture();
  const preview = await buildApp({ readOnly: true, previewPort: 4102 });
  try {
    const login = await preview.inject({
      url: '/api/auth/login',
      method: 'POST',
      payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' },
    });
    assert.equal(login.statusCode, 200, login.body);
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    const data = await preview.inject({ url: '/api/order-fields', headers: { cookie } });
    assert.equal(data.statusCode, 200, data.body);
    assert.equal(data.json().can_write, false);
    assert.equal(data.json().can_admin, false);
    for (const [url, method] of [
      ['/api/order-fields', 'POST'],
      ['/api/order-fields/' + f.definition.id, 'PATCH'],
      ['/api/order-fields/' + f.definition.id, 'DELETE'],
      ['/api/orders/' + f.order.id + '/fields', 'PATCH'],
      ['/api/order-field-files', 'POST'],
    ] as const) {
      const result = await preview.inject({
        url,
        method,
        payload: { invalid: true },
        headers: { cookie },
      });
      assert.equal(result.statusCode, 423, result.body);
    }
  } finally {
    await preview.close();
  }
});
test('schema without field module supports safe GET availability and normal orders, with explicit fields rejected', async () => {
  // This terminal case owns an isolated suite database; it never alters the live workspace.
  const f = await fixture();
  await pool.query(
    'DROP TABLE order_field_requests,order_field_value_events,order_field_values,order_field_files,order_field_options,order_field_definition_revisions,order_field_definitions CASCADE',
  );
  const old = await buildApp();
  try {
    for (const url of [
      '/api/order-fields',
      '/api/orders/' + f.order.id + '/fields',
      '/api/orders/' + f.order.id + '/fields/history',
    ]) {
      const result = await old.inject({ url, headers: f.headers });
      assert.equal(result.statusCode, 200, result.body);
      assert.equal(result.json().available, false);
      assert.equal(result.json().can_write, false);
    }
    const missing = await old.inject({
      url: '/api/order-fields',
      method: 'POST',
      payload: { invalid: true },
      headers: f.headers,
    });
    assert.equal(missing.statusCode, 503, missing.body);
    const explicit = await old.inject({
      url: '/api/orders',
      method: 'POST',
      payload: f.body,
      headers: f.headers,
    });
    assert.equal(explicit.statusCode, 503, explicit.body);
    const { initial_fields, ...body } = f.body;
    const legacy = await old.inject({
      url: '/api/orders',
      method: 'POST',
      payload: body,
      headers: f.headers,
    });
    assert.equal(legacy.statusCode, 201, legacy.body);
  } finally {
    await old.close();
  }
});
