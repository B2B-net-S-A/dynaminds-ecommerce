import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed } from './fixtures';
import { decrypt } from '../server/security';
import { registerOrderFieldRoutes } from '../server/order-field-routes';
import { orderFieldListScopeInTx, projectOrderFieldColumnsInTx } from '../server/order-fields';
assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>,
  admin = '',
  operator = '',
  viewer = '',
  tenant = '',
  user = '',
  warehouse = '',
  product = '',
  ip = 1;
const cookies: Record<string, string> = {};
const req = (url: string, method: any = 'GET', payload?: any, auth = admin, target = app) =>
  target.inject({
    url: '/api' + url,
    method,
    payload,
    headers: { cookie: auth, 'idempotency-key': randomUUID() },
    remoteAddress: '127.0.39.' + ip,
  });
async function ok(url: string, method: any = 'GET', payload?: any, auth = admin, status = 200) {
  const r = await req(url, method, payload, auth);
  assert.equal(r.statusCode, status, r.body);
  return r.json() as any;
}
before(async () => {
  await migrate();
  if (!(await pool.query("SELECT to_regclass('public.order_field_definitions') p")).rows[0].p)
    await pool.query(
      await readFile(new URL('../server/078_order_fields.sql', import.meta.url), 'utf8'),
    );
  await seed();
  app = await buildApp();
  if (!app.hasRoute({ method: 'GET', url: '/api/order-fields' }))
    registerOrderFieldRoutes(app, { available: true, readOnly: false });
  for (const role of ['admin', 'operator', 'viewer']) {
    const r = await app.inject({
      url: '/api/auth/login',
      method: 'POST',
      payload: { email: role + '@demo.local', password: 'DynaDemo!2026' },
      remoteAddress: '127.0.39.' + ip,
    });
    assert.equal(r.statusCode, 200, r.body);
    cookies[role] = String(r.headers['set-cookie']).split(';')[0];
  }
  user = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
});
beforeEach(async () => {
  ip++;
  tenant = randomUUID();
  warehouse = randomUUID();
  await pool.query(
    "INSERT INTO tenants(id,name,plan) VALUES($1,'Additional fields focused QA','enterprise')",
    [tenant],
  );
  await pool.query(
    "INSERT INTO memberships(tenant_id,user_id,role) SELECT $1,id,split_part(email,'@',1) FROM users WHERE email IN ('admin@demo.local','operator@demo.local','viewer@demo.local')",
    [tenant],
  );
  await pool.query(
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Fields QA','FIELDS')",
    [warehouse, tenant],
  );
  for (const role of ['admin', 'operator', 'viewer']) {
    const switched = await req('/workspaces/switch', 'POST', { tenant_id: tenant }, cookies[role]);
    assert.equal(switched.statusCode, 200, switched.body);
    cookies[role] = String(switched.headers['set-cookie']).split(';')[0];
  }
  admin = cookies.admin;
  operator = cookies.operator;
  viewer = cookies.viewer;
  const p = await ok(
    '/products',
    'POST',
    {
      sku: 'FIELD-' + randomUUID(),
      name: 'Produkt pola QA',
      price: 1000,
      quantity: 100,
      warehouse_id: warehouse,
    },
    admin,
    201,
  );
  product = p.id;
});
after(async () => {
  await app?.close();
  await pool.end();
});
const orderBody = (fields?: any[]) => ({
  customer_name: 'Field customer',
  email: 'field@example.test',
  warehouse_id: warehouse,
  items: [{ product_id: product, quantity: 1 }],
  ...(fields ? { initial_fields: fields } : {}),
});
async function order(fields?: any[]) {
  const o = await ok('/orders', 'POST', orderBody(fields), admin, 201);
  return { ...o, version: Number(o.version) };
}
const defBody = (type = 'text', extra: any = {}) => ({
  client_key: randomUUID(),
  key: 'f_' + randomUUID().replaceAll('-', ''),
  label: 'Pole testowe',
  type,
  ...extra,
});
async function field(type = 'text', extra: any = {}) {
  return ok('/order-fields', 'POST', defBody(type, extra), admin, 201);
}
const change = (d: any, value: any) => ({
  field_id: d.id,
  definition_version: d.version,
  type: d.type,
  value,
});
const patch = (o: any, changes: any[], extra: any = {}) => ({
  client_key: randomUUID(),
  order_version: Number(o.version ?? o.order_version),
  changes,
  ...extra,
});
function edited(d: any, extra: any = {}) {
  return {
    version: d.version,
    label: d.label,
    enabled: d.enabled,
    display: d.display,
    position: d.position,
    read_role: d.read_role,
    write_role: d.write_role,
    required_on: d.required_on,
    config: d.config,
    options: d.options,
    ...extra,
  };
}
async function value(id: string, fieldId: string) {
  const d = await ok('/orders/' + id + '/fields');
  return d.data.find((r: any) => r.definition.id === fieldId)?.value;
}
async function counts(orderId: string) {
  return (
    await pool.query(
      'SELECT (SELECT count(*)::int FROM order_field_values WHERE order_id=$1) vals,(SELECT count(*)::int FROM order_field_value_events WHERE order_id=$1) history,(SELECT version FROM orders WHERE id=$1) version,(SELECT count(*)::int FROM order_events WHERE order_id=$1) events,(SELECT count(*)::int FROM audit_events WHERE entity_id=$1) audits,(SELECT count(*)::int FROM jobs WHERE tenant_id=$2) jobs',
      [orderId, tenant],
    )
  ).rows[0];
}
test('seven types use exact frozen values; empty/zero/list distinguish unset; one version bump and no transport/event effects', async () => {
  const options = [
      { id: randomUUID(), label: 'Pierwszy' },
      { id: randomUUID(), label: 'Drugi' },
    ],
    text = await field(),
    number = await field('number', { config: { scale: 2 } }),
    select = await field('select', { options }),
    radio = await field('radio', { options }),
    multi = await field('multi_select', { options }),
    date = await field('date'),
    file = await field('file'),
    o = await order();
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
    'base64',
  );
  const upload = await ok(
    '/order-field-files',
    'POST',
    {
      client_key: randomUUID(),
      order_id: o.id,
      field_id: file.id,
      definition_version: 1,
      filename: 'dowód.png',
      content_base64: png.toString('base64'),
    },
    admin,
    201,
  );
  const before = await counts(o.id),
    r = await ok(
      '/orders/' + o.id + '/fields',
      'PATCH',
      patch(o, [
        change(text, ''),
        change(number, '0.00'),
        change(select, options[0].id),
        change(radio, options[1].id),
        change(multi, []),
        change(date, '2024-02-29'),
        change(file, upload.id),
      ]),
    );
  assert.equal(r.changed, true);
  assert.equal(r.order_version, o.version + 1);
  assert.equal((await value(o.id, text.id)).value, '');
  assert.equal((await value(o.id, number.id)).value, '0.00');
  assert.deepEqual((await value(o.id, multi.id)).value, []);
  assert.deepEqual((await value(o.id, select.id)).options_snapshot, [
    { id: options[0].id, label: 'Pierwszy' },
  ]);
  const after = await counts(o.id);
  assert.equal(after.vals, 7);
  assert.equal(after.history, 7);
  assert.equal(after.events, before.events);
  assert.equal(after.jobs, before.jobs);
  assert.equal(after.audits, before.audits + 1);
  const raw = (
    await pool.query('SELECT encrypted_bytes FROM order_field_files WHERE id=$1', [upload.id])
  ).rows[0];
  assert.deepEqual(Buffer.from(decrypt(raw.encrypted_bytes).content_base64, 'base64'), png);
  assert(!raw.encrypted_bytes.includes(png.toString('base64')));
  const download = await req('/order-field-files/' + upload.id + '/download');
  assert.equal(download.statusCode, 200);
  assert.deepEqual(download.rawPayload, png);
  assert.equal(download.headers['x-content-type-options'], 'nosniff');
  assert.equal(download.headers['cache-control'], 'no-store');
  assert.match(String(download.headers['content-disposition']), /^attachment;/);
});
test('exact decimals accept eighteen digits across scales and reject floats/rounding/negative zero atomically', async () => {
  const integer = await field('number', { config: { scale: 0 } }),
    fraction = await field('number', {
      config: { scale: 6, min: '-999999999999.999999', max: '999999999999.999999' },
    }),
    o = await order();
  let r = await ok(
    '/orders/' + o.id + '/fields',
    'PATCH',
    patch(o, [change(integer, '999999999999999999'), change(fraction, '999999999999.999999')]),
  );
  assert.equal((await value(o.id, integer.id)).value, '999999999999999999');
  for (const bad of ['1000000000000000000', '01', '+1', '1.0', '-0', 1]) {
    const before = await counts(o.id),
      b = patch({ version: r.order_version }, [change(integer, bad)]);
    const result = await req('/orders/' + o.id + '/fields', 'PATCH', b);
    assert.equal(result.statusCode, 422, result.body);
    assert.deepEqual(await counts(o.id), before);
  }
  for (const bad of ['1.00000', '1.0000001', '-0.000000', '1000000000000.000000']) {
    const result = await req(
      '/orders/' + o.id + '/fields',
      'PATCH',
      patch({ version: r.order_version }, [change(fraction, bad)]),
    );
    assert.equal(result.statusCode, 422, result.body);
  }
});
test('typed validation rejects malformed dates/text/foreign options/duplicates/null and rolls back last invalid field', async () => {
  const text = await field('text', { config: { max_length: 3 } }),
    date = await field('date'),
    select = await field('select', { options: [{ id: randomUUID(), label: 'A' }] }),
    multi = await field('multi_select', { options: [{ id: randomUUID(), label: 'M' }] }),
    o = await order();
  for (const ch of [
    change(text, 'four'),
    change(text, 'a\0'),
    change(date, '2023-02-29'),
    change(date, '0000-01-01'),
    change(date, '2024-13-01'),
    change(select, randomUUID()),
    change(multi, [multi.options[0].id, multi.options[0].id]),
    change(text, null),
  ]) {
    const before = await counts(o.id),
      r = await req('/orders/' + o.id + '/fields', 'PATCH', patch(o, [change(text, 'ok'), ch]));
    assert.equal(r.statusCode, 422, r.body);
    assert.deepEqual(await counts(o.id), before);
  }
  const dupe = await req(
    '/orders/' + o.id + '/fields',
    'PATCH',
    patch(o, [change(text, 'a'), change(text, 'b')]),
  );
  assert.equal(dupe.statusCode, 422);
});
test('definition CAS, immutable type/key/options, retirement preserve original value and revision history', async () => {
  const option = { id: randomUUID(), label: 'Dawna etykieta' },
    d = await field('select', { options: [option] }),
    o = await order();
  let r = await ok('/orders/' + o.id + '/fields', 'PATCH', patch(o, [change(d, option.id)]));
  const retired = await ok(
    '/order-fields/' + d.id,
    'PATCH',
    edited(d, { label: 'Nowe pole', options: [{ ...option, enabled: false }] }),
  );
  assert.equal(retired.version, 2);
  assert.equal((await value(o.id, d.id)).options_snapshot[0].label, option.label);
  assert.equal((await req('/order-fields/' + d.id, 'PATCH', edited(d))).statusCode, 409);
  assert.equal(
    (await req('/order-fields/' + d.id, 'PATCH', { ...edited(retired), type: 'text' })).statusCode,
    422,
  );
  assert.equal(
    (
      await req(
        '/order-fields/' + d.id,
        'PATCH',
        edited(retired, { options: [{ ...option, label: 'Nowa etykieta' }] }),
      )
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await req(
        '/orders/' + o.id + '/fields',
        'PATCH',
        patch({ version: r.order_version }, [change(retired, option.id)]),
      )
    ).statusCode,
    422,
  );
  const disabled = await ok('/order-fields/' + d.id, 'DELETE', { version: 2 });
  assert.equal(disabled.enabled, false);
  assert.equal((await value(o.id, d.id)).value, option.id);
  const history = await ok('/orders/' + o.id + '/fields/history');
  assert.equal(history.data[0].definition_snapshot.label, 'Pole testowe');
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::int n FROM order_field_definition_revisions WHERE field_id=$1',
        [d.id],
      )
    ).rows[0].n,
    3,
  );
  await assert.rejects(
    tenantTx(tenant, (c) =>
      c.query("UPDATE order_field_definition_revisions SET snapshot='{}' WHERE field_id=$1", [
        d.id,
      ]),
    ),
    /permission denied/,
  );
});
test('same key replay, changed body conflict, CAS concurrent writes and no-op preserve exact count/version', async () => {
  const d = await field(),
    o = await order(),
    body = patch(o, [change(d, 'first')]),
    first = await ok('/orders/' + o.id + '/fields', 'PATCH', body),
    before = await counts(o.id);
  const replay = await ok('/orders/' + o.id + '/fields', 'PATCH', body);
  assert.equal(replay.reused, true);
  assert.deepEqual(await counts(o.id), before);
  assert.equal(
    (
      await req('/orders/' + o.id + '/fields', 'PATCH', {
        ...body,
        changes: [change(d, 'changed')],
      })
    ).statusCode,
    409,
  );
  const noop = await ok(
    '/orders/' + o.id + '/fields',
    'PATCH',
    patch({ version: first.order_version }, [change(d, 'first')]),
  );
  assert.equal(noop.changed, false);
  assert.deepEqual(await counts(o.id), before);
  const parallel = await Promise.all([
    req(
      '/orders/' + o.id + '/fields',
      'PATCH',
      patch({ version: first.order_version }, [change(d, 'second')]),
    ),
    req(
      '/orders/' + o.id + '/fields',
      'PATCH',
      patch({ version: first.order_version }, [change(d, 'third')]),
    ),
  ]);
  assert.deepEqual(parallel.map((r) => r.statusCode).sort(), [200, 409]);
  const clear = await ok(
    '/orders/' + o.id + '/fields',
    'PATCH',
    patch({ version: first.order_version + 1 }, [
      { field_id: d.id, definition_version: 1, operation: 'clear' },
    ]),
  );
  assert.equal(clear.order_version, first.order_version + 2);
  assert.equal(await value(o.id, d.id), null);
});
test('initial fields/defaults/required apply atomically in order create without extra version bump; import unaffected', async () => {
  const required = await field('text', { required_on: ['manual_create'] }),
    number = await field('number', { config: { scale: 2, default: '0.00' } });
  const before = (
    await pool.query('SELECT count(*)::int n FROM orders WHERE tenant_id=$1', [tenant])
  ).rows[0].n;
  const missing = await req('/orders', 'POST', orderBody());
  assert.equal(missing.statusCode, 422, missing.body);
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM orders WHERE tenant_id=$1', [tenant])).rows[0].n,
    before,
  );
  const o = await order([change(required, '')]);
  assert.equal(o.version, 1);
  assert.equal((await value(o.id, number.id)).value, '0.00');
  assert.equal((await value(o.id, required.id)).value, '');
  const imported = await ok('/orders', 'POST', { ...orderBody(), source: 'shopify' }, admin, 201);
  assert.equal(await value(imported.id, number.id), null);
  assert.equal(
    (await req('/order-fields', 'POST', defBody('file', { required_on: ['manual_create'] })))
      .statusCode,
    422,
  );
  // pack_complete is a supported requirement once 189 is installed (full migrate above).
  const packed = await field('text', { required_on: ['pack_complete'] });
  assert.deepEqual(packed.required_on, ['pack_complete']);
});
test('current role projection covers values, defaults, history, list filters/columns and file access', async () => {
  const team = await field(),
    priv = await field('text', {
      read_role: 'admin',
      write_role: 'admin',
      config: { default: 'PRIVATE DEFAULT' },
    }),
    f = await field('file', { read_role: 'admin', write_role: 'admin' }),
    o = await order();
  await ok(
    '/orders/' + o.id + '/fields',
    'PATCH',
    patch(o, [change(team, 'visible'), change(priv, 'SECRET')]),
  );
  const operatorDetail = await ok('/orders/' + o.id + '/fields', 'GET', undefined, operator);
  assert(!JSON.stringify(operatorDetail).includes('SECRET'));
  assert(!operatorDetail.data.some((r: any) => r.definition.id === priv.id));
  assert(
    !JSON.stringify(await ok('/order-fields', 'GET', undefined, viewer)).includes(
      'PRIVATE DEFAULT',
    ),
  );
  assert.equal(
    (await ok('/orders/' + o.id + '/fields/history', 'GET', undefined, viewer)).data.length,
    1,
  );
  assert.equal(
    (
      await req(
        '/orders/' + o.id + '/fields',
        'PATCH',
        patch({ version: 2 }, [change(team, 'x')]),
        viewer,
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await req(
        '/orders/' + o.id + '/fields',
        'PATCH',
        patch({ version: 2 }, [change(priv, 'x')]),
        operator,
      )
    ).statusCode,
    403,
  );
  for (const auth of [operator, viewer]) {
    assert.equal(
      (
        await req(
          '/orders?field_columns=' + encodeURIComponent(JSON.stringify([priv.id])),
          'GET',
          undefined,
          auth,
        )
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await req(
          '/orders?field_filters=' +
            encodeURIComponent(
              JSON.stringify([{ field_id: priv.id, definition_version: 1, operator: 'is_set' }]),
            ),
          'GET',
          undefined,
          auth,
        )
      ).statusCode,
      403,
    );
  }
  const file = await ok(
    '/order-field-files',
    'POST',
    {
      client_key: randomUUID(),
      order_id: o.id,
      field_id: f.id,
      definition_version: 1,
      filename: 'private.pdf',
      content_base64: Buffer.from('%PDF-1.4\n%%EOF').toString('base64'),
    },
    admin,
    201,
  );
  assert.equal(
    (await req('/order-field-files/' + file.id + '/download', 'GET', undefined, operator))
      .statusCode,
    403,
  );
  assert.equal((await req('/orders/' + o.id)).json().extra_fields, undefined);
});
test('typed AND filters combine existing search, handle retired options and escape literal wildcards', async () => {
  const text = await field(),
    num = await field('number', { config: { scale: 2 } }),
    date = await field('date'),
    multi = await field('multi_select', { options: [{ id: randomUUID(), label: 'M' }] }),
    a = await order(),
    b = await order();
  await ok(
    '/orders/' + a.id + '/fields',
    'PATCH',
    patch(a, [
      change(text, 'abc%_ literal'),
      change(num, '12.30'),
      change(date, '2024-01-01'),
      change(multi, [multi.options[0].id]),
    ]),
  );
  await ok(
    '/orders/' + b.id + '/fields',
    'PATCH',
    patch(b, [change(text, 'abcXX literal'), change(num, '12.29')]),
  );
  const filters = [
    { field_id: text.id, definition_version: 1, operator: 'contains', value: 'abc%_' },
    { field_id: num.id, definition_version: 1, operator: 'gte', value: '12.30' },
    { field_id: date.id, definition_version: 1, operator: 'lte', value: '2024-01-01' },
    {
      field_id: multi.id,
      definition_version: 1,
      operator: 'contains_option',
      value: multi.options[0].id,
    },
  ];
  const query =
    '/orders?search=Field&field_filters=' +
    encodeURIComponent(JSON.stringify(filters)) +
    '&field_columns=' +
    encodeURIComponent(JSON.stringify([text.id, num.id]));
  const result = await ok(query);
  assert.deepEqual(
    result.data.map((o: any) => o.id),
    [a.id],
  );
  assert.equal(result.data[0].extra_fields[1].value, '12.30');
  const unset = await ok(
    '/orders?field_filters=' +
      encodeURIComponent(
        JSON.stringify([{ field_id: date.id, definition_version: 1, operator: 'is_unset' }]),
      ),
  );
  assert.deepEqual(
    unset.data.map((o: any) => o.id),
    [b.id],
  );
  assert.equal(
    (
      await req(
        '/orders?field_filters=' +
          encodeURIComponent(
            JSON.stringify([
              { field_id: num.id, definition_version: 1, operator: 'contains', value: 'foo' },
            ]),
          ),
      )
    ).statusCode,
    422,
  );
});
test('file rejects untrusted formats/foreign bindings and retries immutable bytes; tenant integrity and ACLs hold', async () => {
  const f = await field('file'),
    text = await field(),
    o = await order(),
    other = await order(),
    body = {
      client_key: randomUUID(),
      order_id: o.id,
      field_id: f.id,
      definition_version: 1,
      filename: 'proof.pdf',
      content_base64: Buffer.from('%PDF-1.4\n%%EOF').toString('base64'),
    };
  const saved = await ok('/order-field-files', 'POST', body, admin, 201);
  assert.equal((await ok('/order-field-files', 'POST', body)).reused, true);
  assert.equal(
    (await req('/order-field-files', 'POST', { ...body, filename: 'changed.pdf' })).statusCode,
    409,
  );
  assert.equal(
    (await req('/orders/' + other.id + '/fields', 'PATCH', patch(other, [change(f, saved.id)])))
      .statusCode,
    422,
  );
  for (const raw of ['<svg/>', '<script>x</script>', 'MZexecutable'])
    assert.equal(
      (
        await req('/order-field-files', 'POST', {
          ...body,
          client_key: randomUUID(),
          content_base64: Buffer.from(raw).toString('base64'),
        })
      ).statusCode,
      422,
    );
  assert.equal(
    (
      await req('/order-field-files', 'POST', {
        ...body,
        client_key: randomUUID(),
        field_id: text.id,
      })
    ).statusCode,
    422,
  );
  await assert.rejects(
    tenantTx(tenant, (c) => c.query('DELETE FROM order_field_files WHERE id=$1', [saved.id])),
    /permission denied/,
  );
  const foreignTenant = randomUUID();
  await pool.query("INSERT INTO tenants(id,name) VALUES($1,'Foreign')", [foreignTenant]);
  const actor = { tenantId: foreignTenant, userId: user, role: 'admin' as const };
  await tenantTx(foreignTenant, async (c) => {
    assert.equal(
      (await c.query('SELECT * FROM order_field_files WHERE id=$1', [saved.id])).rows.length,
      0,
    );
    assert.equal(
      (await c.query('SELECT * FROM order_field_values WHERE order_id=$1', [o.id])).rows.length,
      0,
    );
  });
});
test('bounded history cursor preserves microseconds and never repeats IDs across pages', async () => {
  const d = await field(),
    o = await order();
  let version = o.version;
  for (let i = 0; i < 23; i++) {
    const r = await ok(
      '/orders/' + o.id + '/fields',
      'PATCH',
      patch({ version }, [change(d, String(i))]),
    );
    version = r.order_version;
  }
  await pool
    .query(
      "UPDATE order_field_value_events SET created_at='2026-10-05T12:00:00.123456Z' WHERE order_id=$1",
      [o.id],
    )
    .then(
      () => assert.fail('immutable event accepted update'),
      () => {},
    );
  await pool.query(
    `INSERT INTO order_field_value_events(id,tenant_id,order_id,field_id,definition_version,actor_id,definition_snapshot,before_payload,after_payload,source,request_hash,created_at)
    SELECT gen_random_uuid(),e.tenant_id,e.order_id,e.field_id,e.definition_version,e.actor_id,e.definition_snapshot,e.before_payload,e.after_payload,e.source,e.request_hash,'2099-01-01T00:00:00Z'::timestamptz+g*interval '1 microsecond' FROM (SELECT * FROM order_field_value_events WHERE order_id=$1 LIMIT 1)e CROSS JOIN generate_series(1,23)g`,
    [o.id],
  );
  const a = await ok('/orders/' + o.id + '/fields/history');
  assert.equal(a.data.length, 20);
  assert(a.meta.cursor);
  const b = await ok(
    '/orders/' + o.id + '/fields/history?cursor=' + encodeURIComponent(a.meta.cursor),
  );
  assert.equal(b.data.length, 20);
  const c = await ok(
    '/orders/' + o.id + '/fields/history?cursor=' + encodeURIComponent(b.meta.cursor),
  );
  assert.equal(c.data.length, 6);
  assert.equal(new Set([...a.data, ...b.data, ...c.data].map((e: any) => e.id)).size, 46);
});
test('UTF-8 character bounds, file bytes/count quota and immutable staging replay remain bounded', async () => {
  const text = await field(),
    f = await field('file'),
    o = await order(),
    emoji = '😀'.repeat(4000);
  const r = await ok('/orders/' + o.id + '/fields', 'PATCH', patch(o, [change(text, emoji)]));
  assert.equal((await value(o.id, text.id)).value, emoji);
  for (const bad of ['x'.repeat(4001), '\ud800']) {
    assert.equal(
      (
        await req(
          '/orders/' + o.id + '/fields',
          'PATCH',
          patch({ version: r.order_version }, [change(text, bad)]),
        )
      ).statusCode,
      422,
    );
  }
  const body = {
      client_key: randomUUID(),
      order_id: o.id,
      field_id: f.id,
      definition_version: 1,
      filename: 'proof.pdf',
      content_base64: Buffer.from('%PDF-1.4\n%%EOF').toString('base64'),
    },
    saved = await ok('/order-field-files', 'POST', body, admin, 201);
  const large = Buffer.alloc(5242881, 32);
  large.write('%PDF-1.4');
  large.write('%%EOF', large.length - 5);
  assert.equal(
    (
      await req('/order-field-files', 'POST', {
        ...body,
        client_key: randomUUID(),
        content_base64: large.toString('base64'),
      })
    ).statusCode,
    422,
  );
  await pool.query(
    'INSERT INTO order_field_files(id,tenant_id,order_id,field_id,definition_version,actor_id,client_key,request_hash,filename,mime_type,byte_count,file_hash,encrypted_bytes) SELECT gen_random_uuid(),tenant_id,order_id,field_id,definition_version,actor_id,gen_random_uuid(),request_hash,filename,mime_type,byte_count,file_hash,encrypted_bytes FROM order_field_files CROSS JOIN generate_series(1,99) WHERE id=$1',
    [saved.id],
  );
  assert.equal(
    (await req('/order-field-files', 'POST', { ...body, client_key: randomUUID() })).statusCode,
    429,
  );
  assert.equal((await ok('/order-field-files', 'POST', body)).reused, true);
});
test('200-order list projection is batched and respects explicit columns', async () => {
  const d = await field();
  await pool.query(
    "INSERT INTO orders(id,tenant_id,number,customer_name,email,warehouse_id,total,portal_token) SELECT gen_random_uuid(),$1,'FIELD-PAGE-'||g,'Field paging','paging@example.test',$2,0,gen_random_uuid()::text FROM generate_series(1,200)g",
    [tenant, warehouse],
  );
  const r = await ok(
    '/orders?limit=200&field_columns=' + encodeURIComponent(JSON.stringify([d.id])),
  );
  assert.equal(r.data.length, 200);
  assert(r.data.every((o: any) => o.extra_fields.length === 1 && o.extra_fields[0].value === null));
  let calls = 0;
  await tenantTx(tenant, async (c) => {
    const proxied = new Proxy(c, {
      get(target, prop) {
        if (prop === 'query')
          return (...args: any[]) => {
            calls++;
            return (target.query as any).apply(target, args);
          };
        return Reflect.get(target, prop);
      },
    });
    await projectOrderFieldColumnsInTx(
      proxied,
      { tenantId: tenant, userId: user, role: 'admin' },
      r.data.map((o: any) => o.id),
      [d.id],
    );
  });
  assert(calls <= 5, 'Projection must use a constant bounded number of queries');
});
test('ordinary field edit exits local financial revision fence, no-op keeps it and no unrelated ledger/stock mutation', async () => {
  const d = await field(),
    o = await order();
  await pool.query(
    'INSERT INTO order_local_financial_fences(tenant_id,order_id,order_version) VALUES($1,$2,$3)',
    [tenant, o.id, o.version],
  );
  const baseline = (
    await pool.query('SELECT on_hand,reserved,version FROM stock WHERE product_id=$1', [product])
  ).rows;
  const r = await ok('/orders/' + o.id + '/fields', 'PATCH', patch(o, [change(d, 'local')]));
  assert.equal(r.order_version, o.version + 1);
  const fence = (
    await pool.query('SELECT order_version FROM order_local_financial_fences WHERE order_id=$1', [
      o.id,
    ])
  ).rows[0];
  assert.equal(Number(fence.order_version), o.version);
  assert.deepEqual(
    (await pool.query('SELECT on_hand,reserved,version FROM stock WHERE product_id=$1', [product]))
      .rows,
    baseline,
  );
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM payment_entries WHERE order_id=$1', [o.id]))
      .rows[0].n,
    0,
  );
});
test('definitions exact create replay and limits reject unsafe defaults, options/config/type policies', async () => {
  const body = defBody('number', { config: { scale: 2, default: '1.00' } }),
    first = await ok('/order-fields', 'POST', body, admin, 201);
  assert.equal((await ok('/order-fields', 'POST', body)).id, first.id);
  assert.equal((await req('/order-fields', 'POST', { ...body, label: 'changed' })).statusCode, 409);
  for (const b of [
    defBody('number', { config: { scale: 2, default: '1.0' } }),
    defBody('text', { read_role: 'admin', write_role: 'operator' }),
    defBody('text', { config: { javascript: 'evil' } }),
    defBody('file', { config: { default: randomUUID() } }),
  ])
    assert.equal((await req('/order-fields', 'POST', b)).statusCode, 422);
  assert.equal((await req('/order-fields', 'POST', defBody(), operator)).statusCode, 403);
});
