import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed } from './fixtures';
import { decrypt } from '../server/security';
import {
  processOrderFieldBatchJob,
  reapOrderFieldBatchJobs,
  createOrderFieldBatchPreview,
} from '../server/order-field-batches';
import { orderFieldCsvQuote } from '../server/order-field-batches-csv';
import { parseOrderFieldBatchCsv } from '../server/order-field-batches-csv';
assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie = '',
  tenant = '',
  user = '',
  warehouse = '',
  ip = 1;
const req = (url: string, method: any = 'GET', payload?: any, auth = cookie) =>
  app.inject({
    url: '/api' + url,
    method,
    payload,
    headers: { cookie: auth },
    remoteAddress: '127.0.45.' + ip,
  });
async function ok(url: string, method: any = 'GET', payload?: any, status = 200) {
  const r = await req(url, method, payload);
  assert.equal(r.statusCode, status, r.body);
  return r.json() as any;
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp();
  const login = await req('/auth/login', 'POST', {
    email: 'admin@demo.local',
    password: 'DynaDemo!2026',
  });
  assert.equal(login.statusCode, 200, login.body);
  cookie = String(login.headers['set-cookie']).split(';')[0];
  user = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
});
test('whole-row export pages stay within5MiB for exact/sheet/JSON and every exact page reimports full Unicode without truncation', async () => {
  const defs = [];
  for (let i = 0; i < 4; i++) defs.push(await field());
  const os = await orders(90),
    emoji = '😀'.repeat(4000),
    p = await preview(
      bulk(
        os,
        defs.map((d) => ch(d, emoji)),
      ),
    ),
    ids = (
      await pool.query(
        'SELECT id FROM order_field_batch_rows WHERE preview_id=$1 ORDER BY position',
        [p.id],
      )
    ).rows.map((r) => r.id);
  assert.equal(
    (await run((await queue(p, queueBody(p, ids))).execution.id)).result.changed_orders,
    90,
  );
  for (const mode of ['csv_exact', 'csv_sheet', 'json']) {
    const seen = new Set<string>();
    let next: string | null = null,
      pages = 0;
    do {
      const result = await ok(
          '/order-field-batches/export?' +
            new URLSearchParams({
              field_ids: JSON.stringify(defs.map((d) => d.id)),
              mode,
              limit: '500',
              ...(next ? { cursor: next } : {}),
            }),
        ),
        bytes = Buffer.from(result.content_base64, 'base64');
      assert(bytes.length <= 5242880);
      assert(result.count > 0);
      pages++;
      if (mode === 'json') {
        const data = JSON.parse(bytes.toString()).data;
        assert.equal(data.length, result.count);
        for (const row of data) {
          assert(!seen.has(row.order_id));
          seen.add(row.order_id);
          assert(row.fields.every((f: any) => f.value.value === emoji));
        }
      } else {
        const config = result.config ?? {
            encoding: 'utf-8',
            delimiter: ',',
            header: true,
            identity: { kind: 'order_id', column: 0 },
            order_version_column: 1,
            fields: defs.map((d, i) => ({
              column: i + 2,
              field_id: d.id,
              definition_version: d.version,
            })),
          },
          parsed = parseOrderFieldBatchCsv(bytes, config);
        assert.equal(parsed.rows.length, result.count);
        for (const row of parsed.rows) {
          assert(!seen.has(row[0]));
          seen.add(row[0]);
          for (const cell of row.slice(2))
            assert.equal(mode === 'csv_exact' ? JSON.parse(cell).value : cell, emoji);
        }
        if (mode === 'csv_exact') {
          const imported = await preview({
            client_key: randomUUID(),
            kind: 'csv',
            policy: 'replace',
            filename: result.filename,
            content_base64: result.content_base64,
            config: result.config,
          });
          assert.equal(imported.summary.total, result.count);
          assert.equal(imported.summary.no_op, result.count);
          assert.equal(imported.summary.invalid, 0);
        }
      }
      next = result.meta.cursor;
    } while (next);
    assert.equal(seen.size, 90);
    assert(pages >= 2);
  }
});
beforeEach(async () => {
  ip++;
  tenant = randomUUID();
  warehouse = randomUUID();
  await pool.query(
    "INSERT INTO tenants(id,name,plan) VALUES($1,'Fields CSV isolated QA','enterprise')",
    [tenant],
  );
  await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [
    tenant,
    user,
  ]);
  await pool.query(
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Batch QA','BATCH')",
    [warehouse, tenant],
  );
  const r = await req('/workspaces/switch', 'POST', { tenant_id: tenant });
  assert.equal(r.statusCode, 200, r.body);
  cookie = String(r.headers['set-cookie']).split(';')[0];
});
after(async () => {
  await app?.close();
  await pool.end();
});
async function orders(n = 1) {
  return (
    await pool.query(
      "INSERT INTO orders(id,tenant_id,number,customer_name,email,warehouse_id,total,portal_token) SELECT gen_random_uuid(),$1,'BATCH-'||g,'CSV customer','csv@example.test',$2,1000,gen_random_uuid()::text FROM generate_series(1,$3)g RETURNING id,number,version::float8 version",
      [tenant, warehouse, n],
    )
  ).rows;
}
async function field(type = 'text', extra: any = {}) {
  return ok(
    '/order-fields',
    'POST',
    {
      client_key: randomUUID(),
      key: 'b_' + randomUUID().replaceAll('-', ''),
      label: 'Batch field',
      type,
      ...extra,
    },
    201,
  );
}
const ch = (d: any, value: any) => ({
  field_id: d.id,
  definition_version: d.version,
  type: d.type,
  value,
});
const bulk = (os: any[], changes: any[], policy = 'fill_unset') => ({
  client_key: randomUUID(),
  kind: 'bulk',
  policy,
  orders: os.map((o) => ({ order_id: o.id, order_version: o.version })),
  changes,
});
const csv = (os: any[], defs: any[], values: any[][], policy = 'fill_unset') => ({
  client_key: randomUUID(),
  kind: 'csv',
  policy,
  filename: 'fields.csv',
  content_base64: Buffer.from(
    [
      ['id', 'version', ...defs.map((d) => d.key)],
      ...os.map((o, i) => [o.id, String(o.version), ...values[i].map((v) => JSON.stringify(v))]),
    ]
      .map((r) => r.map(orderFieldCsvQuote).join(','))
      .join('\r\n'),
  ).toString('base64'),
  config: {
    encoding: 'utf-8',
    delimiter: ',',
    header: true,
    identity: { kind: 'order_id', column: 0 },
    order_version_column: 1,
    fields: defs.map((d, i) => ({ column: i + 2, field_id: d.id, definition_version: d.version })),
  },
});
const preview = (body: any) => ok('/order-field-batches/previews', 'POST', body, 201);
const queueBody = (p: any, ids = p.data.map((r: any) => r.row_id)) => ({
  client_key: randomUUID(),
  selected_rows: ids,
  consent: {
    scope_hash: p.scope_hash,
    selected_count: ids.length,
    policy: p.policy,
    local_only: true,
  },
});
const queue = (p: any, b = queueBody(p)) =>
  ok('/order-field-batches/previews/' + p.id + '/queue', 'POST', b, 201);
async function claimed(id: string) {
  return (
    await pool.query(
      "UPDATE jobs SET state='running',attempts=attempts+1,locked_at=now(),lease_token=$2 WHERE id=(SELECT job_id FROM order_field_batch_executions WHERE id=$1) RETURNING *",
      [id, randomUUID()],
    )
  ).rows[0];
}
async function run(id: string) {
  await processOrderFieldBatchJob(await claimed(id));
  return ok('/order-field-batches/executions/' + id);
}
async function counts() {
  return (
    await pool.query(
      'SELECT (SELECT count(*)::int FROM order_field_values WHERE tenant_id=$1) values,(SELECT count(*)::int FROM order_field_value_events WHERE tenant_id=$1) history,(SELECT count(*)::int FROM order_events WHERE tenant_id=$1) events,(SELECT count(*)::int FROM payment_entries WHERE tenant_id=$1) ledger,(SELECT count(*)::int FROM jobs WHERE tenant_id=$1) jobs',
      [tenant],
    )
  ).rows[0];
}
test('bulk protects existing empty/zero/list values, atomic replace/no-op and source/history do not create provider effects', async () => {
  const text = await field(),
    number = await field('number', { config: { scale: 2 } }),
    multi = await field('multi_select'),
    os = await orders(2);
  await ok('/orders/' + os[0].id + '/fields', 'PATCH', {
    client_key: randomUUID(),
    order_version: 1,
    changes: [ch(text, ''), ch(number, '0.00'), ch(multi, [])],
  });
  os[0].version = 2;
  const p = await preview(bulk(os, [ch(text, 'new'), ch(number, '1.00'), ch(multi, [])]));
  assert.equal(p.summary.ready, 1);
  assert.equal(p.summary.no_op, 1);
  assert.equal(p.data.find((r: any) => r.order_id === os[0].id).skipped.length, 3);
  const before = await counts(),
    q = await queue(p),
    done = await run(q.execution.id);
  assert.equal(done.state, 'done');
  assert.equal(done.result.changed_orders, 1);
  assert.equal(done.result.no_op_orders, 1);
  assert.equal((await counts()).events, before.events);
  assert.equal((await counts()).ledger, before.ledger);
  const jobs = (await pool.query('SELECT kind,payload FROM jobs WHERE tenant_id=$1', [tenant]))
    .rows;
  assert.deepEqual(
    jobs.map((j) => j.kind),
    ['order.fields.batch'],
  );
  assert.deepEqual(jobs[0].payload, { execution_id: q.execution.id });
  assert.equal(
    (
      await pool.query('SELECT source FROM order_field_values WHERE tenant_id=$1 AND order_id=$2', [
        tenant,
        os[1].id,
      ])
    ).rows[0].source,
    'manual',
  );
  const again = await preview(
    bulk([{ ...os[1], version: 2 }], [ch(text, 'new'), ch(number, '1.00'), ch(multi, [])]),
  );
  const base = await counts(),
    noop = await run((await queue(again)).execution.id);
  assert.equal(noop.result.changed_orders, 0);
  assert.equal((await counts()).history, base.history);
});
test('CSV5000 frozen rows page50, exact100 selection executes once and source remains encrypted', async () => {
  const d = await field(),
    os = await orders(5000),
    input = csv(
      os,
      [d],
      os.map((_, i) => [{ operation: 'set', value: 'CSV' + i }]),
    ),
    p = await preview(input);
  assert.equal(p.summary.total, 5000);
  assert.equal(p.summary.ready, 5000);
  assert.equal(p.data.length, 50);
  assert(p.meta.cursor);
  const next = await ok(
    '/order-field-batches/previews/' + p.id + '?cursor=' + encodeURIComponent(p.meta.cursor),
  );
  assert.equal(next.data[0].position, 50);
  const raw = (
    await pool.query(
      'SELECT encrypted_bytes,byte_count FROM order_field_batch_previews WHERE id=$1',
      [p.id],
    )
  ).rows[0];
  assert.equal(decrypt(raw.encrypted_bytes).content_base64, input.content_base64);
  assert.equal(raw.byte_count, Buffer.from(input.content_base64, 'base64').length);
  assert(!JSON.stringify(p).includes('encrypted_bytes'));
  const ids = (
      await pool.query(
        'SELECT id FROM order_field_batch_rows WHERE preview_id=$1 ORDER BY position LIMIT 100',
        [p.id],
      )
    ).rows.map((r) => r.id),
    body = queueBody(p, ids),
    q = await queue(p, body),
    replay = await ok('/order-field-batches/previews/' + p.id + '/queue', 'POST', body);
  assert.equal(replay.execution.id, q.execution.id);
  const done = await run(q.execution.id);
  assert.equal(done.state, 'done');
  assert.equal(done.result.changed_orders, 100);
  assert.equal((await counts()).values, 100);
  assert.equal((await counts()).history, 100);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM order_field_values WHERE tenant_id=$1 AND source='csv_import'",
        [tenant],
      )
    ).rows[0].n,
    100,
  );
  await processOrderFieldBatchJob({
    ...(await claimed(q.execution.id)),
    lease_token: randomUUID(),
  });
  assert.equal((await counts()).history, 100);
  assert.equal(
    (
      await req('/order-field-batches/previews/' + p.id + '/queue', 'POST', {
        ...body,
        selected_rows: [...ids, ids[0]],
        consent: { ...body.consent, selected_count: 100 },
      })
    ).statusCode,
    422,
  );
});
test('stale last order blocks queue100, and worker stale/last-write failure rolls back every value/history/version', async () => {
  const d = await field(),
    os = await orders(100),
    p = await preview(bulk(os, [ch(d, 'atomic')]));
  await pool.query('UPDATE orders SET version=version+1 WHERE id=$1', [os.at(-1).id]);
  assert.equal(
    (
      await req(
        '/order-field-batches/previews/' + p.id + '/queue',
        'POST',
        queueBody(
          p,
          p.data.map((r: any) => r.row_id),
        ),
      )
    ).statusCode,
    201,
  ); // the stale row is outside first page; execute separate fullscope below
  const selected = (
    await pool.query(
      'SELECT id FROM order_field_batch_rows WHERE preview_id=$1 ORDER BY position',
      [p.id],
    )
  ).rows.map((r) => r.id);
  assert.equal(
    (await req('/order-field-batches/previews/' + p.id + '/queue', 'POST', queueBody(p, selected)))
      .statusCode,
    409,
  );
  assert.equal((await counts()).values, 0);
  const fresh = await preview(
      bulk(
        os.map((o) => ({ ...o, version: o.id === os.at(-1).id ? 2 : 1 })),
        [ch(d, 'atomic')],
      ),
    ),
    ids = (
      await pool.query(
        'SELECT id FROM order_field_batch_rows WHERE preview_id=$1 ORDER BY position',
        [fresh.id],
      )
    ).rows.map((r) => r.id),
    q = await queue(fresh, queueBody(fresh, ids));
  await pool.query('UPDATE orders SET version=version+1 WHERE id=$1', [os.at(-1).id]);
  const result = await run(q.execution.id);
  assert.equal(result.state, 'conflict');
  assert.equal((await counts()).values, 0);
  assert.equal((await counts()).history, 0);
});
test('CSV duplicates/conflicting version/malformed cells and own-file scope become explicit nonqueueable exceptions', async () => {
  const d = await field(),
    f = await field('file'),
    os = await orders(2),
    p = await preview(
      csv(
        [os[0], os[0]],
        [d],
        [[{ operation: 'set', value: 'first' }], [{ operation: 'set', value: 'last' }]],
      ),
    );
  assert.equal(p.summary.conflict, 2);
  assert.equal(
    (await req('/order-field-batches/previews/' + p.id + '/queue', 'POST', queueBody(p)))
      .statusCode,
    409,
  );
  const upload = await ok(
    '/order-field-files',
    'POST',
    {
      client_key: randomUUID(),
      order_id: os[0].id,
      field_id: f.id,
      definition_version: 1,
      filename: 'file.pdf',
      content_base64: Buffer.from('%PDF-1.4\n%%EOF').toString('base64'),
    },
    201,
  );
  const wrong = await preview(
    csv(
      os,
      [f],
      os.map(() => [{ operation: 'set', value: upload.id }]),
    ),
  );
  assert.equal(wrong.summary.ready, 1);
  assert.equal(wrong.summary.invalid, 1);
  const clear = await preview(
    bulk(os, [{ field_id: d.id, definition_version: 1, operation: 'clear' }]),
  );
  assert.equal(clear.summary.invalid, 2);
});
test('exact export roundtrips all seven types/fullUnicode/fileUUID, sheet neutralizes formulas, JSON carries no filebytes', async () => {
  const opts = [{ id: randomUUID(), label: 'Choice' }],
    defs = [
      await field(),
      await field('number', { config: { scale: 6 } }),
      await field('select', { options: opts }),
      await field('radio', { options: opts }),
      await field('multi_select', { options: opts }),
      await field('date'),
      await field('file'),
    ],
    os = await orders(),
    file = await ok(
      '/order-field-files',
      'POST',
      {
        client_key: randomUUID(),
        order_id: os[0].id,
        field_id: defs[6].id,
        definition_version: 1,
        filename: 'file.pdf',
        content_base64: Buffer.from('%PDF-1.4\n%%EOF').toString('base64'),
      },
      201,
    ),
    values = [
      '😀'.repeat(4000),
      '999999999999.123456',
      opts[0].id,
      opts[0].id,
      [opts[0].id],
      '2024-02-29',
      file.id,
    ];
  await ok('/orders/' + os[0].id + '/fields', 'PATCH', {
    client_key: randomUUID(),
    order_version: 1,
    changes: defs.map((d, i) => ch(d, values[i])),
  });
  const qs = new URLSearchParams({
      field_ids: JSON.stringify(defs.map((d) => d.id)),
      order_ids: JSON.stringify(os.map((o) => o.id)),
      mode: 'csv_exact',
    }),
    exported = await ok('/order-field-batches/export?' + qs);
  assert.equal(exported.count, 1);
  const p = await preview({
    client_key: randomUUID(),
    kind: 'csv',
    policy: 'replace',
    filename: exported.filename,
    content_base64: exported.content_base64,
    config: exported.config,
  });
  assert.equal(p.summary.no_op, 1);
  assert.equal((await run((await queue(p)).execution.id)).result.changed_orders, 0);
  const json = await ok(
    '/order-field-batches/export?' +
      new URLSearchParams({ ...Object.fromEntries(qs), mode: 'json' }),
  );
  const decoded = Buffer.from(json.content_base64, 'base64').toString();
  assert(!decoded.includes('encrypted_bytes'));
  assert(!decoded.includes('content_base64'));
  assert(decoded.includes(file.id));
  await ok('/orders/' + os[0].id + '/fields', 'PATCH', {
    client_key: randomUUID(),
    order_version: 2,
    changes: [ch(defs[0], '\t=HYPERLINK("evil")')],
  });
  const sheet = await ok(
    '/order-field-batches/export?' +
      new URLSearchParams({ ...Object.fromEntries(qs), mode: 'csv_sheet' }),
  );
  assert(Buffer.from(sheet.content_base64, 'base64').toString().includes("'\t=HYPERLINK"));
});
test('lease, cancellation, expiry/reaper and exact immutable replay never repeat committed effects', async () => {
  const d = await field(),
    os = await orders(2),
    p = await preview(bulk(os, [ch(d, 'cancel')])),
    b = queueBody(p),
    q = await queue(p, b),
    job = await claimed(q.execution.id);
  await processOrderFieldBatchJob({ ...job, lease_token: randomUUID() });
  assert.equal((await counts()).values, 0);
  const cancelled = await ok(
    '/order-field-batches/executions/' + q.execution.id + '/cancel',
    'POST',
    {},
  );
  assert.equal(cancelled.state, 'cancelled');
  await processOrderFieldBatchJob(job);
  assert.equal((await counts()).values, 0);
  assert.equal(
    (await ok('/order-field-batches/previews/' + p.id + '/queue', 'POST', b)).execution.id,
    q.execution.id,
  );
  const p2 = await preview(bulk(os, [ch(d, 'reap')])),
    q2 = await queue(p2);
  await pool.query(
    "UPDATE jobs SET state='failed' WHERE id=(SELECT job_id FROM order_field_batch_executions WHERE id=$1)",
    [q2.execution.id],
  );
  await reapOrderFieldBatchJobs();
  assert.equal((await ok('/order-field-batches/executions/' + q2.execution.id)).state, 'failed');
  await assert.rejects(
    tenantTx(tenant, (c) =>
      c.query("UPDATE order_field_batch_executions SET state='done' WHERE id=$1", [
        q2.execution.id,
      ]),
    ),
    /immutable|check constraint/,
  );
  await assert.rejects(
    tenantTx(tenant, (c) =>
      c.query('DELETE FROM order_field_batch_rows WHERE preview_id=$1', [p.id]),
    ),
    /permission denied/,
  );
});
test('bounded activepreview quota preserves exact replay and rejects changedbody under oldkey', async () => {
  const d = await field(),
    os = await orders(),
    body = bulk(os, [ch(d, 'limit')]),
    p = await preview(body);
  for (let i = 0; i < 19; i++)
    await createOrderFieldBatchPreview(
      { tenantId: tenant, userId: user, role: 'admin' },
      bulk(os, [ch(d, 'p' + i)]) as any,
    );
  const replay = await ok('/order-field-batches/previews', 'POST', body);
  assert.equal(replay.id, p.id);
  assert.equal(replay.reused, true);
  assert.equal(
    (await req('/order-field-batches/previews', 'POST', bulk(os, [ch(d, 'over')]))).statusCode,
    429,
  );
  assert.equal(
    (await req('/order-field-batches/previews', 'POST', { ...body, changes: [ch(d, 'changed')] }))
      .statusCode,
    409,
  );
});
test('last actual SQL-write failure rolls back all hundred orders and closes the execution without replay', async () => {
  const d = await field(),
    os = await orders(100),
    p = await preview(bulk(os, [ch(d, 'fail-last')])),
    ids = (
      await pool.query(
        'SELECT id FROM order_field_batch_rows WHERE preview_id=$1 ORDER BY position',
        [p.id],
      )
    ).rows.map((r) => r.id),
    q = await queue(p, queueBody(p, ids));
  await pool.query(
    `CREATE FUNCTION batch_last_write_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.order_id='${os.at(-1).id}'::uuid THEN RAISE EXCEPTION 'controlled last write failure';END IF;RETURN NEW;END $$`,
  );
  await pool.query(
    'CREATE TRIGGER batch_last_write_failure BEFORE INSERT ON order_field_values FOR EACH ROW EXECUTE FUNCTION batch_last_write_failure()',
  );
  try {
    const done = await run(q.execution.id);
    assert.equal(done.state, 'failed');
    assert.equal((await counts()).values, 0);
    assert.equal((await counts()).history, 0);
    assert.equal(
      (
        await pool.query('SELECT count(*)::int n FROM orders WHERE tenant_id=$1 AND version<>1', [
          tenant,
        ])
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int n FROM audit_events WHERE tenant_id=$1 AND action='order.fields_changed'",
          [tenant],
        )
      ).rows[0].n,
      0,
    );
  } finally {
    await pool.query('DROP TRIGGER batch_last_write_failure ON order_field_values');
    await pool.query('DROP FUNCTION batch_last_write_failure()');
  }
  const replay = await run(q.execution.id);
  assert.equal(replay.state, 'failed');
  assert.equal((await counts()).values, 0);
});
test('export500 exact keyset and queued20 capacity preserve immutable retry scopes', async () => {
  const d = await field(),
    os = await orders(501),
    a = await ok(
      '/order-field-batches/export?' +
        new URLSearchParams({ field_ids: JSON.stringify([d.id]), mode: 'json', limit: '500' }),
    );
  assert.equal(a.count, 500);
  assert(a.meta.cursor);
  const b = await ok(
    '/order-field-batches/export?' +
      new URLSearchParams({
        field_ids: JSON.stringify([d.id]),
        mode: 'json',
        limit: '500',
        cursor: a.meta.cursor,
      }),
  );
  assert.equal(b.count, 1);
  const data = [
    ...JSON.parse(Buffer.from(a.content_base64, 'base64').toString()).data,
    ...JSON.parse(Buffer.from(b.content_base64, 'base64').toString()).data,
  ];
  assert.equal(new Set(data.map((o) => o.order_id)).size, 501);
  const p = await preview(bulk([os[0]], [ch(d, 'capacity')])),
    firstBody = queueBody(p),
    first = await queue(p, firstBody);
  for (let i = 0; i < 19; i++) await queue(p);
  assert.equal(
    (await req('/order-field-batches/previews/' + p.id + '/queue', 'POST', queueBody(p)))
      .statusCode,
    429,
  );
  assert.equal(
    (await ok('/order-field-batches/previews/' + p.id + '/queue', 'POST', firstBody)).execution.id,
    first.execution.id,
  );
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM jobs WHERE tenant_id=$1', [tenant])).rows[0].n,
    20,
  );
});
