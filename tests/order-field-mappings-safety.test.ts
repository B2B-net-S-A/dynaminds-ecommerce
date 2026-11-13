import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed } from './fixtures';
import { encrypt } from '../server/security';
import { demoWooOrder } from '../server/import-routes';
import {
  processOrderFieldMappingJob,
  acquireMappingOAuthInTx,
} from '../server/order-field-mappings';
import { processSourceRead } from '../server/source-payments';
import { statusConnection } from '../server/order-status';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? 'http://invalid');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/dynaminds_test_\d+$/);
let app: Awaited<ReturnType<typeof buildApp>>,
  user: string,
  addressNumber = 110;
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({
    integrationTransport: async () => {
      throw new Error('This safety suite must never contact a provider implicitly');
    },
  });
  user = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
});
after(async () => {
  await app.close();
  await pool.end();
});

async function fixture(onMissing: 'error' | 'skip' = 'error') {
  const tenant = randomUUID(),
    warehouse = randomUUID(),
    address = '127.0.43.' + ++addressNumber;
  await pool.query(
    "INSERT INTO tenants(id,name,plan) VALUES($1,'Mapping safety QA','enterprise')",
    [tenant],
  );
  await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [
    tenant,
    user,
  ]);
  await pool.query(
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Mapping safety','MSAFE')",
    [warehouse, tenant],
  );
  const login = await app.inject({
    url: '/api/auth/login',
    method: 'POST',
    payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' },
    remoteAddress: address,
  });
  assert.equal(login.statusCode, 200, login.body);
  let cookie = String(login.headers['set-cookie']).split(';')[0];
  const switched = await app.inject({
    url: '/api/workspaces/switch',
    method: 'POST',
    payload: { tenant_id: tenant },
    headers: { cookie },
    remoteAddress: address,
  });
  assert.equal(switched.statusCode, 200, switched.body);
  cookie = String(switched.headers['set-cookie']).split(';')[0];
  const req = (
    path: string,
    method: any = 'GET',
    payload?: any,
    target = app,
    headers: Record<string, string> = { cookie },
  ) => target.inject({ url: '/api' + path, method, payload, headers, remoteAddress: address });
  const ok = async (path: string, method: any = 'GET', payload?: any, status = 200) => {
    const response = await req(path, method, payload);
    assert.equal(response.statusCode, status, response.body);
    return response.json() as any;
  };
  const product = await ok(
    '/products',
    'POST',
    {
      sku: 'MSAFE-' + randomUUID(),
      name: 'Mapping safety product',
      price: 3167,
      quantity: 1000,
      warehouse_id: warehouse,
    },
    201,
  );
  const channel = (
    await pool.query(
      "INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings) VALUES($1,$2,'woocommerce','Mapping safety','sandbox',$3,$4) RETURNING *",
      [
        randomUUID(),
        tenant,
        encrypt({ consumer_key: 'isolated-map', consumer_secret: 'isolated-map' }),
        JSON.stringify({ store_url: 'https://mapping.example.test', simulation: true }),
      ],
    )
  ).rows[0];
  await ok('/integrations/' + channel.id + '/mappings', 'POST', {
    external_id: '701',
    sku: product.sku,
  });
  const field = await ok(
    '/order-fields',
    'POST',
    {
      client_key: randomUUID(),
      key: 'm_' + randomUUID().replaceAll('-', ''),
      label: 'Mapping private field',
      type: 'text',
      read_role: 'admin',
      write_role: 'admin',
    },
    201,
  );
  const mappings = [
    {
      source: { kind: 'woo_customer_note' },
      field_id: field.id,
      definition_version: field.version,
      type: 'text',
      conversion: { kind: 'direct' },
      on_missing: onMissing,
    },
  ];
  const profileBody = {
    client_key: randomUUID(),
    channel_id: channel.id,
    label: 'Mapping safety profile',
    enabled: true,
    mappings,
  };
  const profile = (await ok('/order-field-mappings/profiles', 'POST', profileBody, 201)).profile;
  let serial = 88000;
  const raw = (note = 'MAPPING-PRIVATE-SENTINEL') => ({
    ...structuredClone(demoWooOrder),
    id: ++serial,
    customer_note: note,
    date_paid: null,
    status: 'on-hold',
  });
  const sourceHeads = async () => {
    const heads: any[] = [];
    let cursor: string | undefined;
    do {
      const page = await ok(
        '/order-field-mappings/sources?channel_id=' +
          channel.id +
          (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
      );
      heads.push(...page.data);
      cursor = page.meta?.cursor;
    } while (cursor);
    return heads;
  };
  const stage = async (raws: any[]) => {
    for (let i = 0; i < raws.length; i += 50)
      await ok('/integrations/' + channel.id + '/stage-orders', 'POST', {
        data: raws.slice(i, i + 50),
      });
    return (await sourceHeads()).filter((h) =>
      raws.some((r) => String(r.id) === String(h.external_id)),
    );
  };
  const initial = async (source: any, target = profile) =>
    ok(
      '/order-field-mappings/previews',
      'POST',
      {
        client_key: randomUUID(),
        kind: 'initial',
        profile_id: target.id,
        profile_version: target.version,
        inbound_id: source.inbound_id,
        observation_id: source.observation_id,
        source_hash: source.source_hash,
        warehouse_id: warehouse,
      },
      201,
    );
  const importBody = (preview: any) => ({
    client_key: randomUUID(),
    consent: { scope_hash: preview.scope_hash, local_only: true },
  });
  const importMapped = (preview: any, body = importBody(preview)) =>
    ok('/order-field-mappings/previews/' + preview.id + '/import', 'POST', body, 201);
  const ordinary = (source: any) =>
    ok('/imports/' + source.inbound_id + '/commit', 'POST', { warehouse_id: warehouse });
  const importedSources = async (count = 1) => {
    const raws = Array.from({ length: count }, () => raw()),
      staged = await stage(raws),
      first = await ordinary(staged[0]);
    // The extra records are explicit isolated pre-existing imported orders, avoiding
    // 100 unrelated catalogue/reservation creations in a lock-order test.
    for (const source of staged.slice(1)) {
      const id = randomUUID();
      await pool.query(
        "INSERT INTO orders(id,tenant_id,number,source,external_id,channel_id,customer_name,email,address,currency,total,shipping_cost,warehouse_id,portal_token,source_snapshot) SELECT $2,tenant_id,number||'-'||$3,'woocommerce',$3,channel_id,customer_name,email,address,currency,total,shipping_cost,warehouse_id,gen_random_uuid(),source_snapshot FROM orders WHERE id=$1",
        [first.id, id, String(source.external_id)],
      );
      await pool.query(
        "UPDATE inbound_orders SET order_id=$2,state='imported',imported_hash=source_hash WHERE id=$1",
        [source.inbound_id, id],
      );
    }
    // Commit changes the inbound import metadata timestamp. Capture a current
    // source observation through the real staging path before reconciliation.
    return stage(raws);
  };
  const reconcile = (sources: any[], policy = 'fill_unset', target = profile) =>
    ok(
      '/order-field-mappings/previews',
      'POST',
      {
        client_key: randomUUID(),
        kind: 'reconcile',
        profile_id: target.id,
        profile_version: target.version,
        policy,
        orders: sources.map((s) => ({
          inbound_id: s.inbound_id,
          observation_id: s.observation_id,
          source_hash: s.source_hash,
          order_id: s.order_id,
          order_version: Number(s.order_version),
        })),
      },
      201,
    );
  const rows = async (preview: any) => {
    const result = [...preview.data];
    let cursor = preview.meta?.cursor;
    while (cursor) {
      const page = await ok(
        '/order-field-mappings/previews/' + preview.id + '?cursor=' + encodeURIComponent(cursor),
      );
      result.push(...page.data);
      cursor = page.meta?.cursor;
    }
    return result;
  };
  const queueBody = (preview: any, selected: any[]) => ({
    client_key: randomUUID(),
    selected_rows: selected.map((r) => r.row_id),
    consent: {
      scope_hash: preview.scope_hash,
      selected_count: selected.length,
      policy: preview.policy,
      local_only: true,
    },
  });
  const queue = async (preview: any) =>
    (
      await ok(
        '/order-field-mappings/previews/' + preview.id + '/queue',
        'POST',
        queueBody(preview, await rows(preview)),
        201,
      )
    ).execution;
  const key = async (scopes: string[]) =>
    (await ok('/developer/keys', 'POST', { name: 'Mapping safety scope', scopes }, 201))
      .token as string;
  const api = (path: string, token: string, method: any = 'GET', payload?: any, target = app) =>
    target.inject({
      url: '/api/v1' + path,
      method,
      payload,
      headers: { authorization: 'Bearer ' + token, 'idempotency-key': randomUUID() },
      remoteAddress: address,
    });
  return {
    tenant,
    warehouse,
    channel,
    field,
    profile,
    mappings,
    profileBody,
    raw,
    stage,
    sourceHeads,
    initial,
    importBody,
    importMapped,
    ordinary,
    importedSources,
    reconcile,
    rows,
    queueBody,
    queue,
    key,
    api,
    req,
    ok,
  };
}

const commerceTables = [
  'orders',
  'order_items',
  'order_pick_items',
  'reservations',
  'stock',
  'payment_entries',
  'order_events',
  'order_local_financial_fences',
  'order_field_values',
  'order_field_value_events',
];
async function snapshot(tenant: string, all = false) {
  const tables = all
    ? [
        ...commerceTables,
        'inbound_orders',
        'jobs',
        'audit_events',
        ...(
          await pool.query(
            "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'order_field_%' ORDER BY tablename",
          )
        ).rows.map((r) => r.tablename),
      ]
    : commerceTables;
  const evidence: Record<string, unknown> = {};
  for (const table of [...new Set(tables)])
    evidence[table] = (
      await pool.query(
        `SELECT to_jsonb(t) row FROM ${table} t WHERE tenant_id=$1 ORDER BY to_jsonb(t)::text`,
        [tenant],
      )
    ).rows;
  return evidence;
}
async function waitOn(pid: number, count = 1) {
  // Deadline to reach the wait, not part of it: on an ungated test database the request runs schema
  // validators first, and 5 s missed the wait once in three local runs on 13.11.2026.
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const rows = (
      await pool.query(
        "SELECT pid,query FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))",
        [pid],
      )
    ).rows;
    if (rows.length >= count) return rows;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('No actual held database lock wait observed');
}
async function withdraw(tenant: string, role = 'viewer') {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL statement_timeout='1500ms'");
    await c.query('UPDATE memberships SET role=$3 WHERE tenant_id=$1 AND user_id=$2', [
      tenant,
      user,
      role,
    ]);
    await c.query('COMMIT');
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}
// Hang guards only. On a fresh ungated test database every tenantTx runs the full schema validators;
// 13.11.2026 locally these tests took 4-55 s each (CI with two files at once: up to 52 s), so the former
// 15-20 s limits cut them off. 120 s keeps a hung lock wait visible well before the 45 min file limit.
async function claim(execution: string) {
  const r = await pool.query(
    "UPDATE jobs SET state='running',lease_token=$2,locked_at=now(),attempts=attempts+1 WHERE kind='order.fields.mapping' AND payload->>'execution_id'=$1 RETURNING *",
    [execution, randomUUID()],
  );
  assert.equal(r.rowCount, 1);
  return r.rows[0];
}

test(
  'mapped initial import waits on actual catalogue without membership lock; downgrade rejects even no-op plans without diagnostic writes',
  { timeout: 120000 },
  async () => {
    for (const missing of [false, true]) {
      const f = await fixture(missing ? 'skip' : 'error'),
        raw = f.raw();
      if (missing) delete (raw as any).customer_note;
      const source = (await f.stage([raw]))[0],
        preview = await f.initial(source),
        body = f.importBody(preview),
        before = await snapshot(f.tenant, true),
        holder = await pool.connect();
      let pending: ReturnType<typeof f.req> | undefined;
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          'catalog:' + f.tenant,
        ]);
        const pid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
        pending = f.req('/order-field-mappings/previews/' + preview.id + '/import', 'POST', body);
        assert.match((await waitOn(pid))[0].query, /pg_advisory_xact_lock_shared/);
        await withdraw(f.tenant, 'operator');
        await waitOn(pid);
        await holder.query('COMMIT');
        const response = await pending;
        assert.equal(response.statusCode, 403, response.body);
        assert.deepEqual(await snapshot(f.tenant, true), before);
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
        await pending;
      }
    }
  },
);

test(
  'ordinary import is not retroactively opted into a profile; exact mapped replay preserves initial receipt and commerce',
  { timeout: 120000 },
  async () => {
    const f = await fixture(),
      source = (await f.stage([f.raw()]))[0],
      preview = await f.initial(source),
      ordinary = await f.ordinary(source),
      before = await snapshot(f.tenant, true);
    assert.equal(
      (
        await pool.query('SELECT count(*)::int n FROM order_field_values WHERE order_id=$1', [
          ordinary.id,
        ])
      ).rows[0].n,
      0,
    );
    const rejected = await f.req(
      '/order-field-mappings/previews/' + preview.id + '/import',
      'POST',
      f.importBody(preview),
    );
    assert.equal(rejected.statusCode, 409, rejected.body);
    // Diagnostic source issues may be recorded for conflicts; existing commerce must remain untouched.
    assert.deepEqual(
      await snapshot(f.tenant),
      Object.fromEntries(commerceTables.map((t) => [t, before[t]])),
    );
    const fresh = (await f.stage([f.raw('mapped exactly once')]))[0],
      plan = await f.initial(fresh),
      body = f.importBody(plan),
      first = await f.importMapped(plan, body),
      committed = await snapshot(f.tenant, true);
    const replay = await f.req(
      '/order-field-mappings/previews/' + plan.id + '/import',
      'POST',
      body,
    );
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().order.id, first.order.id);
    assert.equal(replay.json().execution.id, first.execution.id);
    assert.equal(replay.json().reused, true);
    assert.deepEqual(await snapshot(f.tenant, true), committed);
    const changed = await f.req('/order-field-mappings/previews/' + plan.id + '/import', 'POST', {
      ...body,
      consent: { ...body.consent, scope_hash: '0'.repeat(64) },
    });
    assert.equal(changed.statusCode, 409, changed.body);
    assert.deepEqual(await snapshot(f.tenant, true), committed);
    const values = (
      await pool.query('SELECT source,payload FROM order_field_values WHERE order_id=$1', [
        first.order.id,
      ])
    ).rows;
    assert.deepEqual(
      values.map((v) => [v.source, v.payload.value]),
      [['channel_import', 'mapped exactly once']],
    );
  },
);

test(
  'profile approving admin may be withdrawn during catalogue wait while executing admin remains authorized',
  { timeout: 120000 },
  async () => {
    const f = await fixture(),
      executor = (await pool.query("SELECT id FROM users WHERE email='other@demo.local'")).rows[0]
        .id;
    await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [
      f.tenant,
      executor,
    ]);
    const login = await app.inject({
      url: '/api/auth/login',
      method: 'POST',
      payload: { email: 'other@demo.local', password: 'DynaDemo!2026' },
      remoteAddress: '127.0.44.20',
    });
    assert.equal(login.statusCode, 200, login.body);
    const switcher = await app.inject({
      url: '/api/workspaces/switch',
      method: 'POST',
      payload: { tenant_id: f.tenant },
      headers: { cookie: String(login.headers['set-cookie']).split(';')[0] },
      remoteAddress: '127.0.44.20',
    });
    assert.equal(switcher.statusCode, 200, switcher.body);
    const cookie = String(switcher.headers['set-cookie']).split(';')[0],
      source = (await f.stage([f.raw()]))[0];
    const response = await f.req(
      '/order-field-mappings/previews',
      'POST',
      {
        client_key: randomUUID(),
        kind: 'initial',
        profile_id: f.profile.id,
        profile_version: f.profile.version,
        inbound_id: source.inbound_id,
        observation_id: source.observation_id,
        source_hash: source.source_hash,
        warehouse_id: f.warehouse,
      },
      app,
      { cookie },
    );
    assert.equal(response.statusCode, 201, response.body);
    const preview = response.json(),
      before = await snapshot(f.tenant, true),
      holder = await pool.connect();
    let pending: ReturnType<typeof f.req> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'catalog:' + f.tenant,
      ]);
      const pid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      pending = f.req(
        '/order-field-mappings/previews/' + preview.id + '/import',
        'POST',
        f.importBody(preview),
        app,
        { cookie },
      );
      await waitOn(pid);
      await withdraw(f.tenant, 'operator');
      assert.equal(
        (
          await pool.query('SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2', [
            f.tenant,
            executor,
          ])
        ).rows[0].role,
        'admin',
      );
      await waitOn(pid);
      await holder.query('COMMIT');
      const result = await pending;
      assert.equal(result.statusCode, 403, result.body);
      assert.deepEqual(await snapshot(f.tenant, true), before);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      await pending;
    }
  },
);

test(
  'queue waits on the last of 100 existing orders before grants and withdrawn admin admits no execution',
  { timeout: 120000 },
  async () => {
    const f = await fixture(),
      sources = await f.importedSources(100),
      preview = await f.reconcile(sources),
      body = f.queueBody(preview, await f.rows(preview)),
      last = [...sources].sort((a, b) => a.order_id.localeCompare(b.order_id)).at(-1)!,
      before = await snapshot(f.tenant, true),
      holder = await pool.connect();
    let pending: ReturnType<typeof f.req> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE', [last.order_id]);
      const pid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      pending = f.req('/order-field-mappings/previews/' + preview.id + '/queue', 'POST', body);
      assert.match((await waitOn(pid))[0].query, /orders.*FOR UPDATE/);
      await withdraw(f.tenant);
      await waitOn(pid);
      await holder.query('COMMIT');
      const response = await pending;
      assert.equal(response.statusCode, 403, response.body);
      assert.deepEqual(await snapshot(f.tenant, true), before);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      await pending;
    }
  },
);

test(
  'worker final grant after actual order wait rejects all 100 field and financial changes',
  { timeout: 120000 },
  async () => {
    const f = await fixture(),
      sources = await f.importedSources(100),
      preview = await f.reconcile(sources),
      execution = await f.queue(preview),
      job = await claim(execution.id),
      before = await snapshot(f.tenant),
      last = [...sources].sort((a, b) => a.order_id.localeCompare(b.order_id)).at(-1)!,
      holder = await pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE', [last.order_id]);
      const pid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      pending = processOrderFieldMappingJob(job);
      assert.match((await waitOn(pid))[0].query, /orders.*FOR UPDATE/);
      await withdraw(f.tenant);
      await waitOn(pid);
      await holder.query('COMMIT');
      await pending;
      assert.deepEqual(await snapshot(f.tenant), before);
      assert.equal(
        (await pool.query('SELECT state,lease_token FROM jobs WHERE id=$1', [job.id])).rows[0]
          .lease_token,
        null,
      );
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      await pending;
    }
  },
);

test(
  'last stale order rolls back queued 100; valid worker and duplicate/wrong leases produce one local application',
  { timeout: 60000 },
  async () => {
    const f = await fixture(),
      sources = await f.importedSources(100),
      preview = await f.reconcile(sources),
      execution = await f.queue(preview);
    await pool.query('UPDATE orders SET updated_at=now() WHERE id=$1', [
      [...sources].sort((a, b) => a.order_id.localeCompare(b.order_id)).at(-1)!.order_id,
    ]);
    const before = await snapshot(f.tenant),
      job = await claim(execution.id);
    await processOrderFieldMappingJob(job);
    assert.deepEqual(await snapshot(f.tenant), before);
    const control = await fixture(),
      ready = await control.importedSources(2),
      plan = await control.reconcile(ready),
      accepted = await control.queue(plan),
      claimed = await claim(accepted.id);
    const untouched = await snapshot(control.tenant, true);
    await processOrderFieldMappingJob({ ...claimed, lease_token: randomUUID() });
    assert.deepEqual(await snapshot(control.tenant, true), untouched);
    await processOrderFieldMappingJob(claimed);
    const values = (
      await pool.query('SELECT source,payload FROM order_field_values WHERE tenant_id=$1', [
        control.tenant,
      ])
    ).rows;
    assert.equal(values.length, 2);
    assert(
      values.every(
        (v) => v.source === 'channel_import' && v.payload.value === 'MAPPING-PRIVATE-SENTINEL',
      ),
    );
    const done = await snapshot(control.tenant, true);
    await processOrderFieldMappingJob(claimed);
    await processOrderFieldMappingJob({ ...claimed, lease_token: randomUUID() });
    assert.deepEqual(await snapshot(control.tenant, true), done);
  },
);

test(
  'reconcile order wait does not lock inbound first: source-example staging may commit on held order',
  { timeout: 120000 },
  async () => {
    const f = await fixture(),
      sources = await f.importedSources(),
      source = sources[0],
      preview = await f.reconcile(sources),
      body = f.queueBody(preview, await f.rows(preview)),
      holder = await pool.connect();
    let pending: ReturnType<typeof f.req> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM orders WHERE id=$1 FOR SHARE', [source.order_id]);
      const pid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      pending = f.req('/order-field-mappings/previews/' + preview.id + '/queue', 'POST', body);
      assert.match((await waitOn(pid))[0].query, /orders.*FOR UPDATE/);
      const total = (await pool.query('SELECT total FROM orders WHERE id=$1', [source.order_id]))
        .rows[0].total;
      const example = await f.req(
        '/orders/' + source.order_id + '/source-payments/example',
        'POST',
        { amount: total },
      );
      assert.equal(example.statusCode, 200, example.body);
      await waitOn(pid);
      await holder.query('COMMIT');
      const response = await pending;
      assert.equal(response.statusCode, 409, response.body);
      assert.equal(
        (
          await pool.query('SELECT count(*)::int n FROM order_field_values WHERE tenant_id=$1', [
            f.tenant,
          ])
        ).rows[0].n,
        0,
      );
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      await pending;
    }
  },
);

test(
  'source-payment provider GET with and without approved auto apply never executes a mapping',
  { timeout: 120000 },
  async () => {
    for (const automatic of [false, true]) {
      const f = await fixture(),
        source = (await f.importedSources())[0],
        order = source.order_id,
        ch = { ...f.channel, settings: { store_url: 'https://mapping.example.test' } };
      await pool.query('UPDATE channels SET settings=$2 WHERE id=$1', [
        ch.id,
        JSON.stringify(ch.settings),
      ]);
      const connection = statusConnection(ch);
      await pool.query(
        'INSERT INTO source_payment_configs(tenant_id,channel_id,actor_id,enabled,interval_seconds,connection_hash,external_authorized) VALUES($1,$2,$3,true,60,$4,true)',
        [f.tenant, ch.id, user, connection],
      );
      const job = (
        await pool.query(
          "INSERT INTO jobs(id,tenant_id,kind,payload,dedup_key,state,lease_token,locked_at,attempts) VALUES($1,$2,'payment.source.read',$3,$4,'running',$5,now(),1) RETURNING *",
          [
            randomUUID(),
            f.tenant,
            JSON.stringify({
              order_id: order,
              channel_id: ch.id,
              actor_id: user,
              automatic,
              config_version: 1,
              connection_hash: connection,
            }),
            randomUUID(),
            randomUUID(),
          ],
        )
      ).rows[0];
      const raw = (
        await pool.query('SELECT raw FROM inbound_orders WHERE id=$1', [source.inbound_id])
      ).rows[0].raw;
      raw.customer_note = 'fresh GET must not map';
      raw.date_paid = '2026-10-05T12:00:00';
      raw.status = 'processing';
      let calls = 0;
      await processSourceRead(job, {
        transport: async (url, init) => {
          assert.equal(init.method ?? 'GET', 'GET');
          assert.equal(new URL(url).pathname, '/wp-json/wc/v3/orders/' + source.external_id);
          calls++;
          return new Response(JSON.stringify(raw), { status: 200 });
        },
      });
      assert.equal(calls, 1);
      assert.equal(
        (
          await pool.query('SELECT count(*)::int n FROM order_field_values WHERE tenant_id=$1', [
            f.tenant,
          ])
        ).rows[0].n,
        0,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int n FROM order_field_value_events WHERE tenant_id=$1',
            [f.tenant],
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int n FROM jobs WHERE tenant_id=$1 AND kind='order.fields.mapping'",
            [f.tenant],
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        (await pool.query('SELECT count(*)::int n FROM payment_entries WHERE order_id=$1', [order]))
          .rows[0].n,
        automatic ? 1 : 0,
      );
      assert.equal(
        (
          await pool.query('SELECT source_hash FROM inbound_orders WHERE id=$1', [
            source.inbound_id,
          ])
        ).rows[0].source_hash,
        source.source_hash,
      );
    }
  },
);

test(
  'public mapping configuration and import require separate scopes; orders-write source label cannot opt into channel profile',
  { timeout: 120000 },
  async () => {
    const f = await fixture(),
      profile = (
        await f.ok('/order-field-mappings/profiles/' + f.profile.id, 'PATCH', {
          client_key: randomUUID(),
          version: f.profile.version,
          label: f.profile.label,
          enabled: true,
          mappings: [{ ...f.mappings[0], source: { kind: 'woo_meta', key: 'private_mapping' } }],
        })
      ).profile,
      raw: any = f.raw('Ordinary public order note');
    raw.meta_data = [{ id: 1, key: 'private_mapping', value: 'MAPPING-PRIVATE-SENTINEL' }];
    const source = (await f.stage([raw]))[0],
      plan = await f.initial(source, profile),
      body = f.importBody(plan),
      orders = await f.key(['orders:write']),
      fields = await f.key(['order-fields:read', 'order-fields:write']),
      write = await f.key(['order-fields:write']),
      admin = await f.key(['order-fields:admin']),
      all = await f.key([
        'orders:write',
        'order-fields:read',
        'order-fields:write',
        'order-fields:admin',
      ]);
    for (const token of [orders, fields, write]) {
      const r = await f.api('/order-field-mappings/profiles', token, 'POST', {
        ...f.profileBody,
        client_key: randomUUID(),
      });
      assert.equal(r.statusCode, 403, r.body);
      assert(!r.body.includes('MAPPING-PRIVATE-SENTINEL'));
    }
    const missingRead = await f.api('/order-field-mappings/profiles/' + f.profile.id, admin);
    assert.equal(missingRead.statusCode, 403, missingRead.body);
    for (const token of [orders, fields, write]) {
      const r = await f.api(
        '/order-field-mappings/previews/' + plan.id + '/import',
        token,
        'POST',
        body,
      );
      assert.equal(r.statusCode, 403, r.body);
    }
    const direct = await f.api('/orders', orders, 'POST', {
      customer_name: 'Explicit public API creation',
      email: 'mapping-api@example.test',
      warehouse_id: f.warehouse,
      source: 'woocommerce',
      items: [
        {
          product_id: (await pool.query('SELECT id FROM products WHERE tenant_id=$1', [f.tenant]))
            .rows[0].id,
          quantity: 1,
        },
      ],
    });
    assert.equal(direct.statusCode, 201, direct.body);
    assert.equal(
      (
        await pool.query('SELECT count(*)::int n FROM order_field_values WHERE order_id=$1', [
          direct.json().id,
        ])
      ).rows[0].n,
      0,
    );
    const accepted = await f.api(
      '/order-field-mappings/previews/' + plan.id + '/import',
      all,
      'POST',
      body,
    );
    assert.equal(accepted.statusCode, 201, accepted.body);
    assert(!accepted.json().order.initial_fields);
    assert(!JSON.stringify(accepted.json().order).includes('MAPPING-PRIVATE-SENTINEL'));
    await withdraw(f.tenant, 'operator');
    for (const path of [
      '/order-field-mappings/profiles/' + f.profile.id,
      '/order-field-mappings/profiles/' + f.profile.id + '/revisions',
      '/order-field-mappings/sources/' + source.observation_id,
      '/order-field-mappings/previews/' + plan.id,
    ]) {
      const r = await f.req(path);
      assert.equal(r.statusCode, 403, r.body);
      assert(!r.body.includes('MAPPING-PRIVATE-SENTINEL'));
    }
  },
);

test(
  'SQL failure on the final selected order rolls back previous 99 local applications',
  { timeout: 120000 },
  async () => {
    const f = await fixture(),
      sources = await f.importedSources(100),
      preview = await f.reconcile(sources),
      execution = await f.queue(preview),
      job = await claim(execution.id),
      before = await snapshot(f.tenant);
    await pool.query('CREATE SEQUENCE mapping_safety_write_count');
    await pool.query('GRANT USAGE,SELECT ON SEQUENCE mapping_safety_write_count TO dyna_app');
    await pool.query(
      `CREATE FUNCTION mapping_safety_last_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.tenant_id='${f.tenant}'::uuid AND nextval('mapping_safety_write_count')=100 THEN RAISE EXCEPTION 'MAPPING_SAFETY_FINAL_SQL_FAILURE' USING ERRCODE='23514'; END IF; RETURN NEW; END $$`,
    );
    await pool.query(
      'CREATE TRIGGER mapping_safety_last_failure BEFORE INSERT OR UPDATE ON order_field_values FOR EACH ROW EXECUTE FUNCTION mapping_safety_last_failure()',
    );
    try {
      const outcome = await processOrderFieldMappingJob(job).then(
        () => ({ error: undefined }),
        (error) => ({ error }),
      );
      const settled = (await pool.query('SELECT state,error FROM jobs WHERE id=$1', [job.id]))
        .rows[0];
      assert.equal(outcome.error, undefined, 'The worker settles a failed local transaction');
      assert.equal(settled.state, 'failed');
      assert.equal(
        Number(
          (await pool.query('SELECT last_value FROM mapping_safety_write_count')).rows[0]
            .last_value,
        ),
        100,
        'Nontransactional counter proves 99 SQL applications preceded the real final failure',
      );
      assert.deepEqual(await snapshot(f.tenant), before);
      assert.equal(
        (
          await pool.query('SELECT count(*)::int n FROM order_field_values WHERE tenant_id=$1', [
            f.tenant,
          ])
        ).rows[0].n,
        0,
      );
    } finally {
      await pool.query('DROP TRIGGER mapping_safety_last_failure ON order_field_values');
      await pool.query('DROP FUNCTION mapping_safety_last_failure()');
      await pool.query('DROP SEQUENCE mapping_safety_write_count');
    }
  },
);

test(
  'source A to B to A, connection change, profile revision and definition revision invalidate initial consent',
  { timeout: 120000 },
  async () => {
    for (const change of ['epoch', 'connection', 'profile', 'definition']) {
      const f = await fixture(),
        raw = f.raw(),
        source = (await f.stage([raw]))[0],
        preview = await f.initial(source);
      if (change === 'epoch') {
        await f.stage([{ ...raw, customer_note: 'intermediate observation B' }]);
        const final = (await f.stage([raw]))[0];
        assert.equal(final.source_hash, source.source_hash);
        assert.notEqual(final.observation_id, source.observation_id);
      } else if (change === 'connection') {
        await pool.query(
          "UPDATE channels SET settings=jsonb_set(settings,'{store_url}',to_jsonb('https://replacement.example.test'::text)) WHERE id=$1",
          [f.channel.id],
        );
      } else if (change === 'profile') {
        await f.ok('/order-field-mappings/profiles/' + f.profile.id, 'PATCH', {
          client_key: randomUUID(),
          version: f.profile.version,
          label: f.profile.label,
          enabled: false,
          mappings: f.mappings,
        });
      } else {
        await f.ok('/order-fields/' + f.field.id, 'PATCH', {
          version: f.field.version,
          label: 'Revised definition',
          enabled: f.field.enabled,
          display: f.field.display,
          position: f.field.position,
          read_role: f.field.read_role,
          write_role: f.field.write_role,
          required_on: f.field.required_on,
          config: f.field.config,
          options: f.field.options,
        });
      }
      const before = await snapshot(f.tenant),
        response = await f.req(
          '/order-field-mappings/previews/' + preview.id + '/import',
          'POST',
          f.importBody(preview),
        );
      assert.equal(response.statusCode, 409, response.body);
      assert.deepEqual(await snapshot(f.tenant), before);
    }
  },
);

test('an extra valid own preview selection inserted after consent cannot widen a running execution', async () => {
  const f = await fixture(),
    sources = await f.importedSources(2),
    preview = await f.reconcile(sources),
    rows = await f.rows(preview),
    body = f.queueBody(preview, [rows[0]]),
    execution = (
      await f.ok('/order-field-mappings/previews/' + preview.id + '/queue', 'POST', body, 201)
    ).execution;
  await tenantTx(f.tenant, (c) =>
    c.query(
      'INSERT INTO order_field_mapping_execution_rows(tenant_id,execution_id,preview_id,row_id) VALUES($1,$2,$3,$4)',
      [f.tenant, execution.id, preview.id, rows[1].row_id],
    ),
  );
  const before = await snapshot(f.tenant),
    job = await claim(execution.id);
  await processOrderFieldMappingJob(job);
  assert.equal(
    (
      await pool.query('SELECT state FROM order_field_mapping_executions WHERE id=$1', [
        execution.id,
      ])
    ).rows[0].state,
    'conflict',
  );
  assert.deepEqual(await snapshot(f.tenant), before);
});

test('direct SQL cannot cross tenant/profile/preview scope or rewrite source, revisions and terminal evidence', async () => {
  const f = await fixture(),
    sources = await f.importedSources(),
    preview = await f.reconcile(sources),
    execution = await f.queue(preview),
    another = await f.reconcile(sources),
    otherRow = (await f.rows(another))[0],
    foreign = await fixture();
  await assert.rejects(
    tenantTx(f.tenant, (c) =>
      c.query(
        'INSERT INTO order_field_mapping_execution_rows(tenant_id,execution_id,preview_id,row_id) VALUES($1,$2,$3,$4)',
        [f.tenant, execution.id, another.id, otherRow.row_id],
      ),
    ),
    /foreign key constraint/,
  );
  for (const [table, where, args] of [
    ['order_field_mapping_revisions', 'profile_id=$1', [f.profile.id]],
    ['order_field_source_observations', 'id=$1', [sources[0].observation_id]],
    ['order_field_mapping_previews', 'id=$1', [preview.id]],
    ['order_field_mapping_rows', 'preview_id=$1', [preview.id]],
    ['order_field_mapping_execution_rows', 'execution_id=$1', [execution.id]],
  ] as [string, string, string[]][]) {
    await assert.rejects(pool.query(`DELETE FROM ${table} WHERE ${where}`, args), /append-only/);
    assert.equal(
      (
        await tenantTx(foreign.tenant, (c) =>
          c.query(`SELECT count(*)::int n FROM ${table} WHERE ${where}`, args),
        )
      ).rows[0].n,
      0,
    );
  }
  await assert.rejects(
    tenantTx(foreign.tenant, (c) =>
      c.query(
        "INSERT INTO order_field_mapping_profiles(id,tenant_id,channel_id,provider,label,enabled,mappings,connection_hash,approved_by) VALUES($1,$2,$3,'woocommerce','Wrong tenant',true,$4,$5,$6)",
        [
          randomUUID(),
          foreign.tenant,
          f.channel.id,
          JSON.stringify(f.mappings),
          '0'.repeat(64),
          user,
        ],
      ),
    ),
    /foreign key constraint/,
  );
  await processOrderFieldMappingJob(await claim(execution.id));
  await assert.rejects(
    pool.query("UPDATE order_field_mapping_executions SET state='cancelled' WHERE id=$1", [
      execution.id,
    ]),
    /terminal immutable/,
  );
  const rls = (
    await pool.query(
      'SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname=ANY($1::text[])',
      [
        [
          'order_field_mapping_profiles',
          'order_field_mapping_revisions',
          'order_field_source_observations',
          'order_field_mapping_previews',
          'order_field_mapping_rows',
          'order_field_mapping_executions',
          'order_field_mapping_execution_rows',
        ],
      ],
    )
  ).rows;
  assert.equal(rls.length, 7);
  assert(rls.every((r) => r.relrowsecurity && r.relforcerowsecurity));
});

test(
  'Shopify OAuth shared admission observes a queued exclusive writer before acquiring any inbound lock',
  { timeout: 120000 },
  async () => {
    const f = await fixture(),
      source = (await f.stage([f.raw()]))[0],
      before = await snapshot(f.tenant, true),
      initial = await pool.connect(),
      oauth = await pool.connect(),
      reconcile = await pool.connect();
    let writer: Promise<unknown> | undefined, reader: Promise<unknown> | undefined;
    try {
      await initial.query('BEGIN');
      await acquireMappingOAuthInTx(initial, { tenantId: f.tenant }, 'shopify');
      await initial.query('SELECT id FROM inbound_orders WHERE id=$1 FOR UPDATE', [
        source.inbound_id,
      ]);
      const initialPid = (await initial.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      await oauth.query('BEGIN');
      const writerPid = (await oauth.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      writer = oauth.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'shopify-oauth:' + f.tenant,
      ]);
      assert.match((await waitOn(initialPid))[0].query, /pg_advisory_xact_lock\(/);
      await reconcile.query('BEGIN');
      const readerPid = (await reconcile.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      reader = acquireMappingOAuthInTx(reconcile, { tenantId: f.tenant }, 'shopify');
      assert.match((await waitOn(writerPid))[0].query, /pg_advisory_xact_lock_shared/);
      assert.equal(
        (await pool.query('SELECT $1=ANY(pg_blocking_pids($2)) blocked', [writerPid, readerPid]))
          .rows[0].blocked,
        true,
        'Later compatible shared reader is soft-blocked by the queued exclusive writer',
      );
      // With the gate acquired before inbound, this reader holds no inbound row
      // needed by the first reader; releasing the first permits normal progress.
      await initial.query('COMMIT');
      await writer;
      assert.equal(
        (await pool.query('SELECT $1=ANY(pg_blocking_pids($2)) blocked', [writerPid, readerPid]))
          .rows[0].blocked,
        true,
      );
      await oauth.query('COMMIT');
      await reader;
      await reconcile.query('SELECT id FROM inbound_orders WHERE id=$1 FOR UPDATE', [
        source.inbound_id,
      ]);
      await reconcile.query('COMMIT');
      assert.deepEqual(await snapshot(f.tenant, true), before);
    } finally {
      await initial.query('ROLLBACK');
      initial.release();
      await oauth.query('ROLLBACK');
      oauth.release();
      await reconcile.query('ROLLBACK');
      reconcile.release();
      await Promise.allSettled([writer, reader]);
    }
  },
);

test('readonly and physically missing B2 tables expose GET capability and reject writes before malformed parsing', async () => {
  const f = await fixture(),
    source = (await f.stage([f.raw()]))[0],
    preview = await f.initial(source),
    token = await f.key([
      'orders:write',
      'order-fields:read',
      'order-fields:write',
      'order-fields:admin',
    ]),
    readOnly = await buildApp({ readOnly: true });
  try {
    const metadata = await f.api(
      '/order-field-mappings/metadata',
      token,
      'GET',
      undefined,
      readOnly,
    );
    assert.equal(metadata.statusCode, 200, metadata.body);
    assert.equal(metadata.json().available, true);
    assert.equal(metadata.json().read_only, true);
    assert.equal(metadata.json().can_import, false);
    assert.equal(metadata.json().can_reconcile, false);
    for (const path of [
      '/order-field-mappings/profiles',
      '/order-field-mappings/previews',
      '/order-field-mappings/previews/' + preview.id + '/import',
    ]) {
      const response = await f.api(path, token, 'POST', { malformed: true }, readOnly);
      assert.equal(response.statusCode, 423, response.body);
    }
  } finally {
    await readOnly.close();
  }
  // Only the guarded disposable database is modified; this is the terminal test.
  for (const table of [
    'order_field_mapping_profiles',
    'order_field_mapping_revisions',
    'order_field_source_observations',
    'order_field_mapping_previews',
    'order_field_mapping_rows',
    'order_field_mapping_executions',
    'order_field_mapping_execution_rows',
  ])
    await pool.query(`ALTER TABLE ${table} RENAME TO absent_${table}`);
  const old = await buildApp();
  try {
    const metadata = await f.api('/order-field-mappings/metadata', token, 'GET', undefined, old);
    assert.equal(metadata.statusCode, 200, metadata.body);
    assert.equal(metadata.json().available, false);
    const response = await f.api(
      '/order-field-mappings/previews',
      token,
      'POST',
      { malformed: true },
      old,
    );
    assert.equal(response.statusCode, 503, response.body);
  } finally {
    await old.close();
  }
});
