import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed, DEMO_TENANT, SECOND_TENANT } from './fixtures';
import { dispatchAutomation, processAutomation } from '../server/automations';
import { applyOrderAction } from '../server/order-operations';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/dynaminds_test_\d+$/);
let app: Awaited<ReturnType<typeof buildApp>>;
let admin = '',
  operator = '',
  viewer = '',
  warehouse = '',
  adminId = '',
  operatorId = '';
let address = 10,
  providerCalls = 0;
const transport = async () => {
  providerCalls++;
  throw new Error('Safety suite must not call any provider');
};
const req = (path: string, method: any = 'GET', payload?: any, cookie = admin, target = app) =>
  target.inject({
    method,
    url: '/api' + path,
    payload,
    headers: { cookie, 'idempotency-key': randomUUID() },
    remoteAddress: '127.0.103.' + address,
  });
async function ok(path: string, method: any = 'GET', payload?: any, cookie = admin, status = 200) {
  const r = await req(path, method, payload, cookie);
  assert.equal(r.statusCode, status, `${method} ${path}: expected HTTP ${status}`);
  return r.json() as any;
}
async function login(email: string, target = app) {
  const r = await req('/auth/login', 'POST', { email, password: 'DynaDemo!2026' }, '', target);
  assert.equal(r.statusCode, 200, 'Fixture login failed');
  return r.headers['set-cookie']!.toString().split(';')[0];
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({ integrationTransport: transport });
  admin = await login('admin@demo.local');
  operator = await login('operator@demo.local');
  viewer = await login('viewer@demo.local');
  adminId = (await ok('/auth/me')).user.id;
  operatorId = (await ok('/auth/me', 'GET', undefined, operator)).user.id;
  warehouse = (await ok('/warehouses')).data[0].id;
});
beforeEach(async () => {
  address++;
  providerCalls = 0;
  await pool.query('UPDATE memberships SET role=$3 WHERE tenant_id=$1 AND user_id=$2', [
    DEMO_TENANT,
    adminId,
    'admin',
  ]);
  await pool.query('UPDATE memberships SET role=$3 WHERE tenant_id=$1 AND user_id=$2', [
    DEMO_TENANT,
    operatorId,
    'operator',
  ]);
  await pool.query(
    "UPDATE automation_rules SET enabled=false,version=version+1 WHERE tenant_id=$1 AND trigger='customer_message.received' AND enabled",
    [DEMO_TENANT],
  );
});
after(async () => {
  await app.close();
  await pool.end();
});

async function fixture() {
  const p = await ok(
    '/products',
    'POST',
    {
      sku: 'MSG-WORKFLOW-' + randomUUID(),
      name: 'Workflow safety',
      price: 3000,
      quantity: 10,
      warehouse_id: warehouse,
    },
    admin,
    201,
  );
  const o = await ok(
    '/orders',
    'POST',
    {
      customer_name: 'Workflow buyer',
      email: 'workflow-buyer@example.test',
      warehouse_id: warehouse,
      items: [{ product_id: p.id, quantity: 1 }],
      note: 'OLD-PRIVATE-ORDER-NOTE',
    },
    admin,
    201,
  );
  const send = (body = 'BUYER-PRIVATE-SENTINEL', key = randomUUID()) =>
    req('/public/orders/' + o.portal_token + '/messages', 'POST', { client_key: key, body }, '');
  const first = await send();
  assert.equal(first.statusCode, 201);
  const t = (await ok('/customer-messages?order_id=' + o.id)).data[0];
  return { o, p, t, send };
}
type F = Awaited<ReturnType<typeof fixture>>;
async function rule(actions: any[], delay_seconds = 0) {
  const input = {
    client_key: randomUUID(),
    name: 'Safety ' + randomUUID(),
    trigger: 'customer_message.received',
    enabled: true,
    priority: 50,
    delay_seconds,
    match: 'all',
    conditions: [],
    actions,
  };
  const r = await ok('/customer-message-workflows/rules', 'POST', input, admin, 201);
  return { ...r.rule, request: input };
}
async function claim(id: string) {
  return tenantTx(DEMO_TENANT, async (c) => {
    const r = (
      await c.query(
        "UPDATE jobs SET state='running',lease_token=$2,locked_at=now(),attempts=attempts+1 WHERE id=$1 AND state='pending' RETURNING *",
        [id, randomUUID()],
      )
    ).rows[0];
    assert(r, 'Expected own pending job');
    return r;
  });
}
async function dispatched(f: F) {
  const r = await f.send();
  assert.equal(r.statusCode, 201);
  const dispatcher = (
    await pool.query(
      "SELECT id FROM jobs WHERE tenant_id=$1 AND kind='automation' AND payload->>'trigger'='customer_message.received' AND payload->>'orderId'=$2 ORDER BY created_at DESC,id DESC LIMIT 1",
      [DEMO_TENANT, f.o.id],
    )
  ).rows[0];
  assert(dispatcher, 'Buyer event must have one local automation dispatcher');
  await dispatchAutomation(await claim(dispatcher.id));
  const run = (
    await pool.query(
      'SELECT * FROM automation_runs WHERE tenant_id=$1 AND order_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',
      [DEMO_TENANT, f.o.id],
    )
  ).rows[0];
  assert(run, 'Expected frozen workflow run');
  return { run, job: await claim(run.job_id) };
}
async function commerce(f: F) {
  const result: Record<string, any> = {};
  for (const table of [
    'orders',
    'order_items',
    'payment_entries',
    'reservations',
    'stock_movements',
    'shipments',
    'documents',
  ]) {
    const predicate = table === 'orders' ? 'id=$1' : 'order_id=$1';
    result[table] = (
      await pool.query(`SELECT to_jsonb(t) row FROM ${table} t WHERE ${predicate} ORDER BY 1`, [
        f.o.id,
      ])
    ).rows;
  }
  result.stock = (
    await pool.query('SELECT to_jsonb(t) row FROM stock t WHERE product_id=$1 ORDER BY 1', [f.p.id])
  ).rows;
  return result;
}
async function conversation(f: F) {
  return {
    thread: (
      await pool.query('SELECT to_jsonb(t) row FROM customer_message_threads t WHERE id=$1', [
        f.t.id,
      ])
    ).rows,
    messages: (
      await pool.query(
        'SELECT to_jsonb(t) row FROM customer_messages t WHERE thread_id=$1 ORDER BY 1',
        [f.t.id],
      )
    ).rows,
  };
}
async function orderWait(c: PoolClient) {
  const pid = (await c.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  // A deadline, not a poll count: on a loaded runner the request reaches the lock after ~1 s or later.
  for (const until = Date.now() + 30000; Date.now() < until; ) {
    const row = (
      await pool.query(
        "SELECT pid,query FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1::int=ANY(pg_blocking_pids(pid)) AND query ~ 'orders.*FOR (UPDATE|SHARE)'",
        [pid],
      )
    ).rows[0];
    if (row) return row;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail('Expected actual order row lock wait');
}
async function revoke(id: string) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL statement_timeout='1500ms'");
    await c.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
      DEMO_TENANT,
      id,
    ]);
    await c.query('COMMIT');
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}
async function assertNoExternalEffects(f: F) {
  assert.equal(providerCalls, 0);
  const jobs = (
    await pool.query(
      "SELECT kind FROM jobs WHERE tenant_id=$1 AND (payload->>'orderId'=$2 OR payload->>'order_id'=$2)",
      [DEMO_TENANT, f.o.id],
    )
  ).rows;
  assert(
    jobs.every((r) => ['automation', 'automation.run'].includes(r.kind)),
    'Workflow created a provider/status job',
  );
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::int n FROM outbound_events WHERE tenant_id=$1 AND payload::text LIKE $2',
        [DEMO_TENANT, '%' + f.o.id + '%'],
      )
    ).rows[0].n,
    0,
  );
}

test(
  'assignment actor and target may be revoked during a real order wait without stale write or audit',
  { timeout: 60000 },
  async () => {
    for (const who of ['actor', 'target']) {
      const f = await fixture(),
        before = await conversation(f),
        financial = await commerce(f),
        holder = await pool.connect();
      let pending: ReturnType<typeof req> | undefined;
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE', [f.o.id]);
        pending = req('/customer-messages/' + f.t.id + '/assignment', 'PATCH', {
          assigned_user_id: operatorId,
          version: f.t.version,
        });
        await orderWait(holder);
        await revoke(who === 'actor' ? adminId : operatorId);
        await holder.query('COMMIT');
        assert.equal((await pending).statusCode, who === 'actor' ? 403 : 422);
        assert.deepEqual(await conversation(f), before);
        assert.deepEqual(await commerce(f), financial);
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int n FROM audit_events WHERE entity_id=$1 AND action LIKE '%assign%'",
              [f.t.id],
            )
          ).rows[0].n,
          0,
        );
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
        await pending;
        await pool.query('UPDATE memberships SET role=$3 WHERE tenant_id=$1 AND user_id=$2', [
          DEMO_TENANT,
          adminId,
          'admin',
        ]);
        await pool.query('UPDATE memberships SET role=$3 WHERE tenant_id=$1 AND user_id=$2', [
          DEMO_TENANT,
          operatorId,
          'operator',
        ]);
      }
    }
  },
);

test(
  'delayed workflow checks current approving admin after the actual order wait',
  { timeout: 60000 },
  async () => {
    const f = await fixture();
    await rule([{ type: 'customer_message_note', body: 'NEW-PRIVATE-WORKFLOW-NOTE' }]);
    const { run, job } = await dispatched(f),
      before = await conversation(f),
      financial = await commerce(f),
      holder = await pool.connect();
    let pending: Promise<any> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE', [f.o.id]);
      pending = processAutomation(job);
      void pending.catch(() => {});
      await orderWait(holder);
      await revoke(adminId);
      await holder.query('COMMIT');
      await pending;
      assert.deepEqual(await conversation(f), before);
      assert.deepEqual(await commerce(f), financial);
      assert(
        ['skipped', 'failed'].includes(
          (await pool.query('SELECT state FROM automation_runs WHERE id=$1', [run.id])).rows[0]
            .state,
        ),
      );
      await assertNoExternalEffects(f);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      await pending;
    }
  },
);

test(
  'rotated, disabled and expired buyer portal consent rolls back all actions after an order wait',
  { timeout: 60000 },
  async () => {
    for (const change of ['rotate', 'disable', 'expire']) {
      const f = await fixture();
      await rule([
        { type: 'customer_message_note', body: 'NOTE-BEFORE-INVALID-REPLY' },
        { type: 'customer_message_assign', assigned_user_id: operatorId },
        { type: 'customer_message_status', status: 'closed' },
        { type: 'customer_message_reply', body: 'LOCAL-REPLY' },
      ]);
      const { run, job } = await dispatched(f),
        before = await conversation(f),
        holder = await pool.connect();
      let pending: Promise<any> | undefined;
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE', [f.o.id]);
        pending = processAutomation(job);
        void pending.catch(() => {});
        await orderWait(holder);
        await holder.query(
          change === 'rotate'
            ? 'UPDATE orders SET portal_token=$2 WHERE id=$1'
            : change === 'disable'
              ? 'UPDATE orders SET portal_enabled=false WHERE id=$1'
              : "UPDATE orders SET portal_expires_at=now()-interval '1 second' WHERE id=$1",
          change === 'rotate' ? [f.o.id, randomBytes(24).toString('hex')] : [f.o.id],
        );
        await holder.query('COMMIT');
        await pending;
        assert.deepEqual(await conversation(f), before);
        assert.equal(
          (await pool.query('SELECT state FROM automation_runs WHERE id=$1', [run.id])).rows[0]
            .state,
          'failed',
        );
        await assertNoExternalEffects(f);
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
        await pending;
      }
      await pool.query(
        "UPDATE automation_rules SET enabled=false,version=version+1 WHERE tenant_id=$1 AND trigger='customer_message.received' AND enabled",
        [DEMO_TENANT],
      );
    }
  },
);

test(
  'buyer replay freezes one receipt; wrong lease and completed replay cannot duplicate local actions or leak private data',
  { timeout: 60000 },
  async () => {
    const f = await fixture(),
      definition = await rule([
        { type: 'customer_message_reply', body: 'LOCAL-PUBLIC-REPLY' },
        { type: 'customer_message_note', body: 'SECRET-WORKFLOW-NOTE' },
        { type: 'customer_message_assign', assigned_user_id: operatorId },
        { type: 'customer_message_status', status: 'closed' },
      ]);
    const subscription = await ok(
      '/developer/webhooks',
      'POST',
      { name: 'Workflow safety local sink', mode: 'local', events: ['order.updated'] },
      admin,
      201,
    );
    await ok('/developer/webhooks/' + subscription.id + '/enable', 'POST', {
      confirm_destination: 'local',
    });
    const key = randomUUID();
    assert.equal((await f.send('BUYER-TRIGGER-BODY', key)).statusCode, 201);
    const sourceBefore = (
      await pool.query(
        'SELECT to_jsonb(t) row FROM customer_message_workflow_receipts t WHERE order_id=$1 ORDER BY 1',
        [f.o.id],
      )
    ).rows;
    assert.equal(sourceBefore.length, 1);
    assert.equal((await f.send('BUYER-TRIGGER-BODY', key)).statusCode, 200);
    assert.deepEqual(
      (
        await pool.query(
          'SELECT to_jsonb(t) row FROM customer_message_workflow_receipts t WHERE order_id=$1 ORDER BY 1',
          [f.o.id],
        )
      ).rows,
      sourceBefore,
    );
    const frozen = (
      await pool.query(
        "SELECT * FROM jobs WHERE tenant_id=$1 AND kind='automation' AND payload->>'orderId'=$2 AND payload->>'trigger'='customer_message.received'",
        [DEMO_TENANT, f.o.id],
      )
    ).rows;
    assert.equal(frozen.length, 1);
    const source = JSON.stringify(
      frozen.map((j) => ({ snapshot: j.payload.snapshot, context: j.payload.context })),
    );
    for (const secret of [
      'BUYER-TRIGGER-BODY',
      f.o.portal_token,
      'assigned_user_id',
      'SECRET-WORKFLOW-NOTE',
    ])
      assert(!source.includes(secret));
    assert(!JSON.stringify(frozen).includes(f.o.portal_token));
    await dispatchAutomation(await claim(frozen[0].id));
    const run = (
        await pool.query('SELECT * FROM automation_runs WHERE order_id=$1 AND rule_id=$2', [
          f.o.id,
          definition.id,
        ])
      ).rows[0],
      job = await claim(run.job_id),
      before = await conversation(f),
      financial = await commerce(f);
    await processAutomation({ ...job, lease_token: randomUUID() });
    assert.deepEqual(await conversation(f), before);
    await processAutomation(job);
    const done = await conversation(f);
    assert.equal(done.messages.length, before.messages.length + 2);
    await processAutomation(job);
    assert.deepEqual(await conversation(f), done);
    assert.deepEqual(await commerce(f), financial);
    const projections = [
      await req('/customer-messages/' + f.t.id, 'GET', undefined, viewer),
      await req('/customer-messages?order_id=' + f.o.id, 'GET', undefined, viewer),
      await req('/public/orders/' + f.o.portal_token + '/messages', 'GET', undefined, ''),
      await req('/automations', 'GET', undefined, viewer),
      await req('/automation-runs', 'GET', undefined, viewer),
      await req('/orders/' + f.o.id, 'GET', undefined, viewer),
    ];
    for (const p of projections) {
      assert.equal(p.statusCode, 200);
      for (const secret of ['SECRET-WORKFLOW-NOTE', 'assigned_user_id', 'assigned_user_name'])
        assert(!p.body.includes(secret), 'Private workflow data leaked from a projection');
    }
    assert.equal(
      (await req('/customer-message-workflows/runs/' + run.id, 'GET', undefined, viewer))
        .statusCode,
      403,
    );
    await assertNoExternalEffects(f);
  },
);

test(
  'withdrawn assignment target or revised rule invalidates a frozen run without local side effects',
  { timeout: 60000 },
  async () => {
    for (const change of ['target', 'rule']) {
      const f = await fixture(),
        r = await rule([
          { type: 'customer_message_note', body: 'ATOMIC-PRIVATE-NOTE' },
          { type: 'customer_message_assign', assigned_user_id: operatorId },
        ]),
        { run, job } = await dispatched(f),
        before = await conversation(f);
      if (change === 'target') await revoke(operatorId);
      else
        await ok('/customer-message-workflows/rules/' + r.id, 'PATCH', {
          client_key: randomUUID(),
          version: r.version,
          enabled: false,
        });
      await processAutomation(job);
      assert.deepEqual(await conversation(f), before);
      assert(
        ['skipped', 'failed'].includes(
          (await pool.query('SELECT state FROM automation_runs WHERE id=$1', [run.id])).rows[0]
            .state,
        ),
      );
      await pool.query("UPDATE memberships SET role='operator' WHERE tenant_id=$1 AND user_id=$2", [
        DEMO_TENANT,
        operatorId,
      ]);
      await pool.query(
        "UPDATE automation_rules SET enabled=false,version=version+1 WHERE tenant_id=$1 AND trigger='customer_message.received' AND enabled",
        [DEMO_TENANT],
      );
    }
  },
);

test(
  'workflow-only actions reject general operations and direct helper calls lacking a buyer receipt',
  { timeout: 60000 },
  async () => {
    const f = await fixture(),
      action = { type: 'customer_message_note', body: 'NO-CONTEXT-PRIVATE-NOTE' },
      before = await conversation(f),
      financial = await commerce(f);
    assert(
      [403, 409, 422].includes(
        (await req('/orders/' + f.o.id + '/operations', 'POST', action)).statusCode,
      ),
    );
    const preview = await req('/orders/' + f.o.id + '/operations/preview', 'POST', action);
    assert.equal(preview.statusCode, 200);
    assert.equal((preview.json() as any).allowed, false);
    assert.equal(typeof (preview.json() as any).error, 'string');
    assert(
      [403, 409, 422].includes(
        (await req('/orders/batches/preview', 'POST', { order_ids: [f.o.id], action })).statusCode,
      ),
    );
    await assert.rejects(
      tenantTx(DEMO_TENANT, (c) =>
        applyOrderAction(
          c,
          { tenantId: DEMO_TENANT, userId: adminId, role: 'admin' },
          f.o.id,
          action as any,
        ),
      ),
      (e: any) => [403, 409, 422].includes(e.status),
    );
    assert.deepEqual(await conversation(f), before);
    assert.deepEqual(await commerce(f), financial);
  },
);

test(
  'workflow action must match its frozen run index and plain preview flag cannot mint workflow consent',
  { timeout: 60000 },
  async () => {
    const f = await fixture(),
      action = { type: 'customer_message_note', body: 'FROZEN-APPROVED-NOTE' };
    await rule([action]);
    const { run } = await dispatched(f),
      before = await conversation(f),
      actor = { tenantId: DEMO_TENANT, userId: adminId, role: 'admin' as const };
    await assert.rejects(
      tenantTx(DEMO_TENANT, (c) =>
        applyOrderAction(c, actor, f.o.id, { ...action, body: 'COUNTERFEIT-ACTION-BODY' } as any, {
          chain_id: randomUUID(),
          depth: 0,
          trace: [],
          operation: { kind: 'rule', id: run.id, action_index: 0 },
        }),
      ),
      (e: any) => [403, 409, 422].includes(e.status),
    );
    await assert.rejects(
      tenantTx(DEMO_TENANT, (c) =>
        applyOrderAction(c, actor, f.o.id, action as any, {
          chain_id: randomUUID(),
          depth: 0,
          trace: [],
          preview: true,
        }),
      ),
      (e: any) => [403, 409, 422].includes(e.status),
    );
    assert.deepEqual(await conversation(f), before);
  },
);

test(
  'source receipts enforce own tenant, composite scope and immutable evidence at SQL boundary',
  { timeout: 60000 },
  async () => {
    const f = await fixture();
    await rule([{ type: 'customer_message_note', body: 'SQL-PRIVATE-NOTE' }]);
    const { run, job } = await dispatched(f);
    const receipts = (
      await pool.query('SELECT * FROM customer_message_workflow_receipts WHERE order_id=$1', [
        f.o.id,
      ])
    ).rows;
    assert.equal(receipts.length, 1);
    assert(!JSON.stringify(receipts).includes(f.o.portal_token));
    const flags = (
      await pool.query(
        "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='customer_message_workflow_receipts'::regclass",
      )
    ).rows[0];
    assert(flags.relrowsecurity && flags.relforcerowsecurity);
    assert.equal(
      (
        await tenantTx(SECOND_TENANT, (c) =>
          c.query('SELECT message_id FROM customer_message_workflow_receipts WHERE order_id=$1', [
            f.o.id,
          ]),
        )
      ).rowCount,
      0,
    );
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await assert.rejects(
        c.query(
          "UPDATE automation_runs SET definition=jsonb_set(definition,'{actor_id}',to_jsonb($2::text)) WHERE id=$1",
          [run.id, randomUUID()],
        ),
        /immutable/i,
      );
      await c.query('ROLLBACK');
      await processAutomation(job);
      assert.equal(
        (await pool.query('SELECT state FROM automation_runs WHERE id=$1', [run.id])).rows[0].state,
        'done',
      );
      for (const query of [
        "UPDATE automation_runs SET result='{}' WHERE id=$1",
        'DELETE FROM automation_runs WHERE id=$1',
      ]) {
        await c.query('BEGIN');
        await assert.rejects(c.query(query, [run.id]), /immutable/i);
        await c.query('ROLLBACK');
      }
      const legacy = await ok('/automations', 'POST', {
        name: 'Legacy delete probe',
        trigger: 'order.created',
        enabled: false,
        actions: [{ type: 'add_note', note: 'Legacy note' }],
      });
      const oldEvent = (
        await pool.query(
          "SELECT id FROM order_events WHERE order_id=$1 AND kind='order.created' ORDER BY created_at,id LIMIT 1",
          [f.o.id],
        )
      ).rows[0];
      assert(oldEvent, 'Fixture must have its ordinary order-created event');
      const legacyRun = randomUUID();
      await c.query('BEGIN');
      await c.query(
        'INSERT INTO automation_runs(id,tenant_id,rule_id,rule_version,event_id,order_id,job_id,definition,snapshot,context) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [
          legacyRun,
          DEMO_TENANT,
          legacy.id,
          legacy.version,
          oldEvent.id,
          f.o.id,
          job.id,
          JSON.stringify({ trigger: 'order.created', actor_id: adminId }),
          '{}',
          '{}',
        ],
      );
      assert.equal(
        (await c.query('DELETE FROM automation_runs WHERE id=$1 RETURNING id', [legacyRun]))
          .rowCount,
        1,
        'Targeted protection must preserve ordinary legacy deletion',
      );
      await c.query('ROLLBACK');
      const other = await fixture(),
        eventId = randomUUID(),
        messageId = randomUUID();
      await c.query('BEGIN');
      await c.query(
        "INSERT INTO customer_messages(id,public_id,tenant_id,order_id,thread_id,kind,actor_id,client_key,request_hash,body) VALUES($1,$2,$3,$4,$5,'buyer',NULL,$6,$7,$8)",
        [
          messageId,
          randomUUID(),
          DEMO_TENANT,
          other.o.id,
          other.t.id,
          randomUUID(),
          'b'.repeat(64),
          'Composite FK fixture',
        ],
      );
      await c.query(
        'INSERT INTO order_events(id,tenant_id,order_id,kind,detail) VALUES($1,$2,$3,$4,$5)',
        [eventId, DEMO_TENANT, f.o.id, 'customer_message.received', '{}'],
      );
      await assert.rejects(
        c.query(
          'INSERT INTO customer_message_workflow_receipts(tenant_id,order_id,thread_id,message_id,event_id,portal_token_hash) VALUES($1,$2,$3,$4,$5,$6)',
          [DEMO_TENANT, f.o.id, f.t.id, messageId, eventId, 'a'.repeat(64)],
        ),
        (e: any) => e.code === '23503',
      );
      await c.query('ROLLBACK');
      for (const query of [
        'DELETE FROM customer_message_workflow_receipts WHERE order_id=$1',
        'UPDATE customer_message_workflow_receipts SET order_id=order_id WHERE order_id=$1',
      ]) {
        await c.query('BEGIN');
        await assert.rejects(c.query(query, [f.o.id]), /immutable|append-only/i);
        await c.query('ROLLBACK');
      }
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  },
);

test(
  'public workflow keys need both read scopes, all four write scopes and a current admin; rule keys bind exact input',
  { timeout: 60000 },
  async () => {
    const f = await fixture();
    const issue = async (scopes: string[]) =>
      (await ok('/developer/keys', 'POST', { name: 'Workflow scope safety', scopes }, admin, 201))
        .token as string;
    const api = (token: string, path: string, method: any = 'GET', payload?: any) =>
      app.inject({
        method,
        url: '/api/v1' + path,
        payload,
        headers: { authorization: 'Bearer ' + token, 'idempotency-key': randomUUID() },
        remoteAddress: '127.0.103.' + address,
      });
    const communicationOnly = await issue(['communications:write']),
      readOne = await issue(['automations:read']),
      readBoth = await issue(['automations:read', 'communications:read']),
      all = await issue([
        'automations:read',
        'automations:write',
        'communications:read',
        'communications:write',
      ]);
    const communicationRead = await issue(['communications:read']),
      communicationReadWrite = await issue(['communications:read', 'communications:write']);
    const assignment = '/customer-messages/' + f.t.id + '/assignment';
    const assignmentBody = { assigned_user_id: operatorId, version: f.t.version };
    assert.equal(
      (await api(communicationOnly, assignment, 'PATCH', assignmentBody)).statusCode,
      403,
    );
    assert.equal(
      (await api(communicationReadWrite, assignment, 'PATCH', assignmentBody)).statusCode,
      200,
    );
    const readThread = await api(communicationRead, '/customer-messages/' + f.t.id);
    assert.equal(readThread.statusCode, 200);
    for (const flag of ['can_assign', 'can_reply', 'can_note', 'can_status'])
      assert.equal((readThread.json() as any)[flag], false);
    assert.equal(
      (await api(communicationOnly, '/customer-message-workflows/rules', 'POST', {})).statusCode,
      403,
    );
    assert.equal((await api(readOne, '/customer-message-workflows')).statusCode, 403);
    const metadata = await api(readBoth, '/customer-message-workflows');
    assert.equal(metadata.statusCode, 200);
    assert((metadata.json() as any).can_read && !(metadata.json() as any).can_admin);
    const input = {
      client_key: randomUUID(),
      name: 'Public scopes safety',
      trigger: 'customer_message.received',
      enabled: true,
      actions: [{ type: 'customer_message_note', body: 'SCOPE-PRIVATE-NOTE' }],
    };
    assert.equal(
      (await api(readBoth, '/customer-message-workflows/rules', 'POST', input)).statusCode,
      403,
    );
    const first = await api(all, '/customer-message-workflows/rules', 'POST', input);
    assert.equal(first.statusCode, 201);
    const replay = await api(all, '/customer-message-workflows/rules', 'POST', input);
    assert.equal(replay.statusCode, 200);
    assert((replay.json() as any).reused);
    assert.equal((replay.json() as any).rule.id, (first.json() as any).rule.id);
    assert.equal(
      (
        await api(all, '/customer-message-workflows/rules', 'POST', {
          ...input,
          actions: [{ type: 'customer_message_note', body: 'DIFFERENT-PRIVATE-NOTE' }],
        })
      ).statusCode,
      409,
    );
    await pool.query("UPDATE memberships SET role='operator' WHERE tenant_id=$1 AND user_id=$2", [
      DEMO_TENANT,
      adminId,
    ]);
    try {
      assert.equal(
        (
          await api(all, '/customer-message-workflows/rules', 'POST', {
            ...input,
            client_key: randomUUID(),
          })
        ).statusCode,
        401,
        'Demoting an admin revokes its API keys through the existing membership trigger',
      );
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int n FROM api_keys WHERE tenant_id=$1 AND user_id=$2 AND revoked_at IS NULL',
            [DEMO_TENANT, adminId],
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        (
          await req(
            '/customer-message-workflows/rules',
            'POST',
            { ...input, client_key: randomUUID() },
            admin,
          )
        ).statusCode,
        403,
        'The still-valid cookie must independently enforce the current operator role',
      );
    } finally {
      await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
        DEMO_TENANT,
        adminId,
      ]);
    }
  },
);

test(
  'readonly writes fail before parse and physically missing081 retains ordinary messages without workflows',
  // Two extra buildApp() runs (read-only and missing 081); each runs the schema guards again (up to ~30 s).
  { timeout: 180000 },
  async () => {
    const f = await fixture(),
      readonly = await buildApp({ readOnly: true, integrationTransport: transport });
    try {
      const previewAdmin = await login('admin@demo.local', readonly);
      for (const path of [
        '/customer-message-workflows/rules',
        '/customer-messages/' + f.t.id + '/assignment',
      ])
        assert.equal(
          (
            await req(
              path,
              path.endsWith('assignment') ? 'PATCH' : 'POST',
              {},
              previewAdmin,
              readonly,
            )
          ).statusCode,
          423,
        );
      const metadataResponse = await req(
        '/customer-message-workflows',
        'GET',
        undefined,
        previewAdmin,
        readonly,
      );
      assert.equal(metadataResponse.statusCode, 200);
      const metadata = metadataResponse.json() as any;
      assert(metadata.read_only && !metadata.can_admin);
      const detailResponse = await req(
        '/customer-messages/' + f.t.id,
        'GET',
        undefined,
        previewAdmin,
        readonly,
      );
      assert.equal(detailResponse.statusCode, 200);
      const detail = detailResponse.json() as any;
      for (const key of ['can_assign', 'can_reply', 'can_note', 'can_status'])
        assert.equal(detail[key], false);
    } finally {
      await readonly.close();
    }
    const tables = [
      'customer_message_workflow_receipts',
      'customer_message_workflow_requests',
      'customer_message_workflow_actions',
    ];
    let old: Awaited<ReturnType<typeof buildApp>> | undefined;
    try {
      for (const table of tables)
        await pool.query(`ALTER TABLE ${table} RENAME TO ${table}_safety_hidden`);
      old = await buildApp({ integrationTransport: transport });
      const r = await req('/customer-message-workflows', 'GET', undefined, admin, old);
      assert.equal(r.statusCode, 200);
      assert.equal((r.json() as any).available, false);
      assert.equal(
        (await req('/customer-message-workflows/rules', 'POST', {}, admin, old)).statusCode,
        503,
      );
      assert.equal(
        (await req('/customer-messages/' + f.t.id + '/assignment', 'PATCH', {}, admin, old))
          .statusCode,
        503,
      );
      const ordinary = await req(
        '/public/orders/' + f.o.portal_token + '/messages',
        'POST',
        { client_key: randomUUID(), body: 'Old075 ordinary buyer message' },
        '',
        old,
      );
      assert.equal(ordinary.statusCode, 201);
    } finally {
      await old?.close();
      for (const table of [...tables].reverse())
        await pool.query(`ALTER TABLE ${table}_safety_hidden RENAME TO ${table}`);
    }
  },
);
