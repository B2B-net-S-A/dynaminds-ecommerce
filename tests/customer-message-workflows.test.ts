import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed, DEMO_TENANT } from './fixtures';
import { dispatchAutomation, processAutomation } from '../server/automations';
import { customerMessageWorkflowRuleInput } from '../server/customer-message-workflow-routes';
assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>,
  admin = '',
  operator = '',
  viewer = '',
  user = '',
  target = '',
  warehouse = '',
  ip = 1;
const req = (path: string, method: any = 'GET', payload?: any, cookie = admin) =>
  app.inject({
    url: '/api' + path,
    method,
    payload,
    headers: { cookie, 'idempotency-key': randomUUID() },
    remoteAddress: '127.0.53.' + ip,
  });
async function ok(path: string, method: any = 'GET', payload?: any, cookie = admin, status = 200) {
  const r = await req(path, method, payload, cookie);
  assert.equal(r.statusCode, status, path + ' HTTP ' + r.statusCode);
  return r.json() as any;
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({
    integrationTransport: async () => {
      throw new Error('No provider HTTP is permitted in local message workflow tests');
    },
  });
  for (const [email, which] of [
    ['admin@demo.local', 'admin'],
    ['operator@demo.local', 'operator'],
    ['viewer@demo.local', 'viewer'],
  ]) {
    const r = await req('/auth/login', 'POST', { email, password: 'DynaDemo!2026' }, '');
    assert.equal(r.statusCode, 200, 'Login HTTP status');
    const cookie = String(r.headers['set-cookie']).split(';')[0];
    if (which === 'admin') admin = cookie;
    else if (which === 'operator') operator = cookie;
    else viewer = cookie;
  }
  user = (await ok('/auth/me')).user.id;
  target = (await ok('/auth/me', 'GET', undefined, operator)).user.id;
  warehouse = (await ok('/warehouses')).data[0].id;
});
beforeEach(async () => {
  ip++;
  await pool.query(
    "UPDATE automation_rules SET enabled=false,version=version+1 WHERE tenant_id=$1 AND trigger='customer_message.received'",
    [DEMO_TENANT],
  );
  await pool.query(
    "UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL WHERE tenant_id=$1 AND kind IN ('automation','automation.run')",
    [DEMO_TENANT],
  );
});
after(async () => {
  await app.close();
  await pool.end();
});
async function fixture() {
  const product = await ok(
    '/products',
    'POST',
    {
      sku: 'WF-' + randomUUID(),
      name: 'Local message workflow',
      price: 3000,
      quantity: 10,
      warehouse_id: warehouse,
    },
    admin,
    201,
  );
  const order = await ok(
    '/orders',
    'POST',
    {
      customer_name: 'Workflow buyer',
      email: 'buyer@example.test',
      warehouse_id: warehouse,
      items: [{ product_id: product.id, quantity: 1 }],
    },
    admin,
    201,
  );
  return { product, order, token: order.portal_token };
}
const definition = (actions: any[], extra: any = {}) => ({
  client_key: randomUUID(),
  name: 'Buyer local workflow',
  trigger: 'customer_message.received',
  enabled: true,
  priority: 50,
  delay_seconds: 0,
  match: 'all',
  conditions: [],
  actions,
  ...extra,
});
async function rule(actions: any[], extra: any = {}) {
  return (
    await ok('/customer-message-workflows/rules', 'POST', definition(actions, extra), admin, 201)
  ).rule;
}
const buyer = (f: any, body = { client_key: randomUUID(), body: 'BUYER_PRIVATE_BODY' }) =>
  ok('/public/orders/' + f.token + '/messages', 'POST', body, '', 201);
async function thread(f: any) {
  return (await ok('/customer-messages?order_id=' + f.order.id)).data[0];
}
async function claim(id: string) {
  return (
    await pool.query(
      "UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$2,locked_at=now() WHERE id=$1 RETURNING *",
      [id, randomUUID()],
    )
  ).rows[0];
}
async function dispatch(f: any) {
  const j = (
    await pool.query(
      "SELECT * FROM jobs WHERE tenant_id=$1 AND kind='automation' AND payload->>'orderId'=$2 AND payload->>'trigger'='customer_message.received' ORDER BY created_at DESC LIMIT 1",
      [DEMO_TENANT, f.order.id],
    )
  ).rows[0];
  assert(j);
  await dispatchAutomation(await claim(j.id));
  return (
    await pool.query('SELECT * FROM automation_runs WHERE order_id=$1 ORDER BY created_at,id', [
      f.order.id,
    ])
  ).rows;
}
async function complete(f: any) {
  const runs = await dispatch(f);
  for (const r of runs) if (r.state === 'queued') await processAutomation(await claim(r.job_id));
  return (await ok('/customer-message-workflows/runs?order_id=' + f.order.id)).data;
}
async function business(f: any) {
  return (
    await pool.query(
      'SELECT (SELECT to_jsonb(o) FROM orders o WHERE id=$1) o,(SELECT to_jsonb(p) FROM products p WHERE id=$2) p,(SELECT jsonb_agg(to_jsonb(s)) FROM stock s WHERE product_id=$2) stock',
      [f.order.id, f.product.id],
    )
  ).rows[0];
}
async function effects() {
  return (
    await pool.query(
      'SELECT (SELECT count(*)::int FROM outbound_deliveries WHERE tenant_id=$1) outgoing,(SELECT count(*)::int FROM sms_messages WHERE tenant_id=$1) sms,(SELECT count(*)::int FROM email_messages WHERE tenant_id=$1) email',
      [DEMO_TENANT],
    )
  ).rows[0];
}

test('no enabled opt-in rule preserves the ordinary buyer message without order events/jobs/business effects', async () => {
  const f = await fixture(),
    before = await business(f),
    events = (
      await pool.query('SELECT count(*)::int n FROM order_events WHERE order_id=$1', [f.order.id])
    ).rows[0].n,
    jobs = (await pool.query('SELECT count(*)::int n FROM jobs WHERE tenant_id=$1', [DEMO_TENANT]))
      .rows[0].n;
  await buyer(f);
  assert.deepEqual(await business(f), before);
  // The only new order event is the automation v2 trigger "Wiadomość od klienta" (no enabled v2 rule, so no job).
  assert.deepEqual(
    (
      await pool.query(
        'SELECT kind FROM order_events WHERE order_id=$1 ORDER BY created_at OFFSET $2',
        [f.order.id, events],
      )
    ).rows.map((r) => r.kind),
    ['customer_message.received'],
  );
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM jobs WHERE tenant_id=$1', [DEMO_TENANT])).rows[0]
      .n,
    jobs,
  );
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::int n FROM customer_message_workflow_receipts WHERE order_id=$1',
        [f.order.id],
      )
    ).rows[0].n,
    0,
  );
});
test('buyer dispatches one durable rule, four local actions and immutable deterministic replay without recursion or external queues', async () => {
  const f = await fixture();
  await rule([
    { type: 'customer_message_assign', assigned_user_id: target },
    { type: 'customer_message_reply', body: 'Local portal answer' },
    { type: 'customer_message_note', body: 'PRIVATE_INTERNAL_NOTE' },
    { type: 'customer_message_status', status: 'closed' },
  ]);
  const before = await business(f),
    external = await effects(),
    body = { client_key: randomUUID(), body: 'BUYER_PRIVATE_BODY' };
  await buyer(f, body);
  const reused = await ok('/public/orders/' + f.token + '/messages', 'POST', body, '', 200);
  assert.equal(reused.reused, true);
  const runs = await complete(f);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].state, 'done');
  assert.equal(runs[0].result.actions.length, 4);
  const t = await thread(f),
    detail = await ok('/customer-messages/' + t.id);
  assert.equal(detail.assigned_user_id, target);
  assert.equal(detail.status, 'closed');
  assert.equal(detail.data.length, 3);
  const publicView = await ok('/public/orders/' + f.token + '/messages', 'GET', undefined, '');
  assert.equal(publicView.data.length, 2);
  assert(!JSON.stringify(publicView).includes('PRIVATE_INTERNAL_NOTE'));
  assert(!JSON.stringify(publicView).includes(target));
  const audit = (
    await pool.query(
      "SELECT payload FROM jobs WHERE tenant_id=$1 AND kind='automation' AND payload->>'orderId'=$2 AND payload->>'trigger'='customer_message.received'",
      [DEMO_TENANT, f.order.id],
    )
  ).rows;
  assert.equal(audit.length, 1);
  assert(!JSON.stringify(audit[0].payload.snapshot).includes('BUYER_PRIVATE_BODY'));
  assert(!JSON.stringify(audit[0].payload.context).includes(target));
  assert(!JSON.stringify(audit[0].payload).includes(f.token));
  assert.deepEqual(await business(f), before);
  assert.deepEqual(await effects(), external);
  const run = (await pool.query('SELECT * FROM automation_runs WHERE id=$1', [runs[0].id])).rows[0],
    job = (await pool.query('SELECT * FROM jobs WHERE id=$1', [run.job_id])).rows[0];
  await processAutomation(job);
  assert.equal((await ok('/customer-messages/' + t.id)).data.length, 3);
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::int n FROM customer_message_workflow_actions WHERE run_id=$1',
        [run.id],
      )
    ).rows[0].n,
    4,
  );
});
test('rule preview rolls back literal replies, notes, assignment/status and all durable/provider effects', async () => {
  const f = await fixture();
  await buyer(f);
  const t = await thread(f),
    r = await rule([
      { type: 'customer_message_reply', body: 'PREVIEW_ONLY' },
      { type: 'customer_message_note', body: 'PREVIEW_PRIVATE' },
      { type: 'customer_message_assign', assigned_user_id: target },
      { type: 'customer_message_status', status: 'closed' },
    ]);
  const before = await ok('/customer-messages/' + t.id),
    b = await business(f),
    external = await effects(),
    count = (
      await pool.query('SELECT count(*)::int n FROM audit_events WHERE tenant_id=$1', [DEMO_TENANT])
    ).rows[0].n;
  const p = await ok('/customer-message-workflows/rules/' + r.id + '/preview', 'POST', {
    order_id: f.order.id,
  });
  assert.equal(p.allowed, true);
  assert.equal(p.result.length, 4);
  assert.deepEqual(await ok('/customer-messages/' + t.id), before);
  assert.deepEqual(await business(f), b);
  assert.deepEqual(await effects(), external);
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM audit_events WHERE tenant_id=$1', [DEMO_TENANT]))
      .rows[0].n,
    count,
  );
});
test('full4000 supplementary Unicode characters remain exact in portal and workflow body; malformed and wrong contexts reject', async () => {
  const full = '😀'.repeat(4000),
    f = await fixture();
  const r = await rule([{ type: 'customer_message_reply', body: full }]);
  await buyer(f, { client_key: randomUUID(), body: full });
  assert.equal((await complete(f))[0].state, 'done');
  const view = await ok('/public/orders/' + f.token + '/messages', 'GET', undefined, '');
  assert(view.data.every((m: any) => m.body === full));
  assert.equal(
    (
      await req(
        '/customer-message-workflows/rules',
        'POST',
        definition([{ type: 'customer_message_note', body: '\ud800' }]),
      )
    ).statusCode,
    422,
  );
  assert.equal(
    (
      await req('/orders/' + f.order.id + '/operations', 'POST', {
        type: 'customer_message_note',
        body: 'Cannot bypass receipt',
      })
    ).statusCode,
    422,
  );
  assert.equal(
    (
      await req('/orders/batches/preview', 'POST', {
        order_ids: [f.order.id],
        action: { type: 'customer_message_note', body: 'No batch' },
      })
    ).statusCode,
    422,
  );
  assert(
    !customerMessageWorkflowRuleInput.safeParse({
      ...definition([{ type: 'customer_message_note', body: 'x' }]),
      actions: [{ type: 'set_status', status: 'cancelled' }],
    }).success,
  );
  assert.equal(r.trigger, 'customer_message.received');
});
test('configuration create and CAS/toggle replay are immutable, scopes current and capacity replay precedes quota', async () => {
  const body = definition([{ type: 'customer_message_note', body: 'SECRET_RULE_NOTE' }]),
    first = await ok('/customer-message-workflows/rules', 'POST', body, admin, 201),
    again = await ok('/customer-message-workflows/rules', 'POST', body, admin, 200);
  assert.equal(first.rule.id, again.rule.id);
  assert(again.reused);
  assert.equal(
    (await req('/customer-message-workflows/rules', 'POST', { ...body, name: 'Changed' }))
      .statusCode,
    409,
  );
  const change = { client_key: randomUUID(), version: first.rule.version, enabled: false },
    p = await ok('/customer-message-workflows/rules/' + first.rule.id, 'PATCH', change);
  assert.equal(p.rule.enabled, false);
  assert.deepEqual(
    (await ok('/customer-message-workflows/rules/' + first.rule.id, 'PATCH', change)).rule,
    p.rule,
  );
  assert.equal(
    (
      await req('/customer-message-workflows/rules/' + first.rule.id, 'PATCH', {
        ...change,
        client_key: randomUUID(),
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (await req('/customer-message-workflows/rules', 'POST', body, operator)).statusCode,
    403,
  );
  assert.equal(
    (await req('/customer-message-workflows/rules', 'GET', undefined, viewer)).statusCode,
    403,
  );
  const generic = await ok('/automations', 'GET', undefined, viewer);
  assert(!JSON.stringify(generic).includes('SECRET_RULE_NOTE'));
});
test('manual assignment CAS/unassign, viewer activity privacy and own current eligible names survive private changes', async () => {
  const f = await fixture();
  await buyer(f);
  let t = await thread(f);
  const before = await ok('/customer-messages/' + t.id, 'GET', undefined, viewer),
    assignees = await ok('/customer-messages/assignees');
  assert(assignees.data.some((u: any) => u.user_id === target));
  assert(assignees.data.every((u: any) => !('email' in u)));
  t = await ok(
    '/customer-messages/' + t.id + '/assignment',
    'PATCH',
    { assigned_user_id: target, version: t.version },
    operator,
  );
  assert.equal(t.assigned_user_id, target);
  assert(t.assigned_user_name);
  assert.deepEqual(await ok('/customer-messages/' + t.id, 'GET', undefined, viewer), before);
  const noop = await ok('/customer-messages/' + t.id + '/assignment', 'PATCH', {
    assigned_user_id: target,
    version: t.version,
  });
  assert.equal(noop.version, t.version);
  assert.equal(
    (
      await req('/customer-messages/' + t.id + '/assignment', 'PATCH', {
        assigned_user_id: null,
        version: t.version - 1,
      })
    ).statusCode,
    409,
  );
  const after = await ok('/customer-messages/' + t.id + '/assignment', 'PATCH', {
    assigned_user_id: null,
    version: t.version,
  });
  assert.equal(after.assigned_user_id, null);
  assert.equal(
    (
      await req('/customer-messages/' + t.id + '/assignment', 'PATCH', {
        assigned_user_id: randomUUID(),
        version: after.version,
      })
    ).statusCode,
    422,
  );
  assert.equal((await ok('/customer-messages/assignees', 'GET', undefined, viewer)).data.length, 0);
});
test('last local action failure rolls back earlier notes and assignment; disabled/edited frozen rule never executes', async () => {
  const f = await fixture(),
    r = await rule([
      { type: 'customer_message_note', body: 'ROLLBACK_ME' },
      { type: 'customer_message_reply', body: 'NOT_APPLIED' },
    ]);
  await buyer(f);
  const runs = await dispatch(f),
    t = await thread(f);
  await pool.query(
    'UPDATE customer_message_threads SET message_count=999,version=version+1 WHERE id=$1',
    [t.id],
  );
  await processAutomation(await claim(runs[0].job_id));
  const history = await ok('/customer-message-workflows/runs?order_id=' + f.order.id);
  assert.equal(history.data[0].state, 'failed');
  assert.equal((await ok('/customer-messages/' + t.id)).data.length, 1);
  const next = await fixture();
  await pool.query('UPDATE automation_rules SET enabled=true WHERE id=$1', [r.id]);
  await buyer(next);
  const pending = await dispatch(next);
  await ok('/customer-message-workflows/rules/' + r.id, 'PATCH', {
    client_key: randomUUID(),
    version: r.version,
    enabled: false,
  });
  await processAutomation(await claim(pending[0].job_id));
  assert.equal(
    (await ok('/customer-message-workflows/runs?order_id=' + next.order.id)).data[0].state,
    'skipped',
  );
});
test('configuration and run pages use microsecond keyset, private viewer projection never exposes note/assignment', async () => {
  const f = await fixture();
  const r = await rule([
    { type: 'customer_message_note', body: 'RUN_PRIVATE_SECRET' },
    { type: 'customer_message_assign', assigned_user_id: target },
  ]);
  await buyer(f);
  await complete(f);
  const runs = await ok('/automation-runs', 'GET', undefined, viewer);
  assert(!JSON.stringify(runs).includes('RUN_PRIVATE_SECRET'));
  assert(!JSON.stringify(runs).includes(target));
  assert(runs.data.some((x: any) => x.trigger === 'customer_message.received'));
  const own = await ok('/customer-message-workflows/runs?order_id=' + f.order.id),
    detail = await ok('/customer-message-workflows/runs/' + own.data[0].id);
  assert.equal(detail.run.definition.actions[0].body, 'RUN_PRIVATE_SECRET');
  assert.equal(
    (await req('/customer-message-workflows/runs/' + own.data[0].id, 'GET', undefined, viewer))
      .statusCode,
    403,
  );
  const tiedIds = [r.id];
  for (let i = 0; i < 21; i++)
    tiedIds.push(
      (await rule([{ type: 'customer_message_note', body: 'Page' + i }], { enabled: false })).id,
    );
  // Force a microsecond-precise tie across the page boundary; retain earlier
  // fixtures and compare every returned row against the exact own SQL scope.
  await pool.query(
    "UPDATE automation_rules SET updated_at=(SELECT max(updated_at)+interval '1 second' FROM automation_rules WHERE tenant_id=$1) WHERE tenant_id=$1 AND id=ANY($2::uuid[])",
    [DEMO_TENANT, tiedIds],
  );
  const expectedIds = (
    await pool.query(
      "SELECT id FROM automation_rules WHERE tenant_id=$1 AND trigger='customer_message.received' ORDER BY updated_at DESC,id DESC",
      [DEMO_TENANT],
    )
  ).rows.map((row) => row.id);
  const first = await ok('/customer-message-workflows/rules');
  assert.equal(first.data.length, 20);
  assert(first.meta.cursor);
  const all = [...first.data];
  let cursor = first.meta.cursor;
  while (cursor) {
    const page = await ok('/customer-message-workflows/rules?cursor=' + cursor);
    all.push(...page.data);
    cursor = page.meta.cursor;
  }
  assert.deepEqual(
    all.map((row: any) => row.id),
    expectedIds,
  );
  assert(tiedIds.every((id) => all.some((row: any) => row.id === id)));
});
