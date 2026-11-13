import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed, DEMO_TENANT, SECOND_TENANT } from './fixtures';
import { registerCustomerMessageRoutes } from '../server/customer-message-routes';
import {
  customerMessageInput,
  appendCustomerOrderMessage,
  resolveCustomerMessageToken,
  publicCustomerMessageRead,
  publicCustomerMessageWrite,
} from '../server/customer-messages';
assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>,
  admin = '',
  operator = '',
  viewer = '',
  other = '',
  warehouse = '',
  user = '',
  ip = 1;
const req = (url: string, method: any = 'GET', payload?: any, auth = admin) =>
  app.inject({
    url: '/api' + url,
    method,
    payload,
    headers: { cookie: auth, 'idempotency-key': randomUUID() },
    remoteAddress: '127.0.27.' + ip,
  });
async function ok(url: string, method: any = 'GET', payload?: any, auth = admin, status = 200) {
  const r = await req(url, method, payload, auth);
  assert.equal(r.statusCode, status, r.body);
  return r.json() as any;
}
const body = (text = 'Gdzie jest moje zamówienie?') => ({ client_key: randomUUID(), body: text });
const pub = (token: string, m: any = 'GET', b?: any, cursor?: string) =>
  ok(
    '/public/orders/' +
      token +
      '/messages' +
      (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''),
    m,
    b,
    '',
    m === 'POST' ? 201 : 200,
  );
const send = (id: string, kind = 'reply', text = 'Odpowiedź w portalu', auth = admin) =>
  ok('/customer-messages/' + id + '/' + kind, 'POST', body(text), auth, 201);
async function login(email: string, target = app) {
  const r = await target.inject({
    url: '/api/auth/login',
    method: 'POST',
    payload: { email, password: 'DynaDemo!2026' },
    remoteAddress: '127.0.27.' + ip,
  });
  assert.equal(r.statusCode, 200, r.body);
  return r.headers['set-cookie']!.toString().split(';')[0];
}
before(async () => {
  await migrate();
  if (!(await pool.query("SELECT to_regclass('public.customer_message_threads') p")).rows[0].p)
    await pool.query(
      await readFile(new URL('../server/075_customer_messages.sql', import.meta.url), 'utf8'),
    );
  await seed();
  app = await buildApp();
  if (!app.hasRoute({ method: 'GET', url: '/api/customer-messages' }))
    registerCustomerMessageRoutes(app, { available: true, readOnly: false });
  admin = await login('admin@demo.local');
  operator = await login('operator@demo.local');
  viewer = await login('viewer@demo.local');
  other = await login('other@demo.local');
  warehouse = (await ok('/warehouses')).data[0].id;
  user = (await ok('/auth/me')).user.id;
});
beforeEach(async () => {
  ip++;
  await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
    DEMO_TENANT,
    user,
  ]);
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
      sku: 'MSG-' + randomUUID(),
      name: 'Produkt kontakt QA',
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
      customer_name: 'Kupujący <script>QA</script>',
      email: 'buyer@example.test',
      warehouse_id: warehouse,
      items: [{ product_id: p.id, quantity: 1 }],
      note: 'OLD INTERNAL ORDER NOTE',
    },
    admin,
    201,
  );
  return { p, o: await ok('/orders/' + o.id), token: o.portal_token };
}
async function conversation() {
  const f = await fixture();
  await pub(f.token, 'POST', body());
  const h = await ok('/customer-messages?order_id=' + f.o.id);
  assert.equal(h.data.length, 1);
  return { ...f, thread: h.data[0] };
}
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
async function business(f: any) {
  return {
    order: (await pool.query('SELECT to_jsonb(o) d FROM orders o WHERE id=$1', [f.o.id])).rows,
    product: (await pool.query('SELECT to_jsonb(p) d FROM products p WHERE id=$1', [f.p.id])).rows,
    stock: (await pool.query('SELECT to_jsonb(s) d FROM stock s WHERE product_id=$1', [f.p.id]))
      .rows,
  };
}
test('buyer → own inbox → local portal reply → private note, with no business/order/inventory or transport side effects', async () => {
  const f = await fixture(),
    before = await business(f);
  const empty = await pub(f.token);
  assert.equal(empty.status, null);
  assert.deepEqual(empty.data, []);
  assert.equal((await ok('/customer-messages?order_id=' + f.o.id)).data.length, 0);
  const incoming = await pub(f.token, 'POST', body('<script>alert(1)</script>\nPytanie klienta'));
  assert.equal(incoming.kind, 'buyer');
  assert.match(incoming.body, /<script>/);
  assert(!('thread_id' in incoming));
  const inbox = await ok('/customer-messages?order_id=' + f.o.id),
    thread = inbox.data[0];
  assert.equal(thread.order_number, f.o.number);
  assert.equal(thread.public_message_count, 1);
  assert(inbox.can_reply && inbox.can_note && inbox.can_status);
  const reply = await send(thread.id, 'reply', 'Lokalna odpowiedź, bez email i SMS', operator);
  assert.equal(reply.kind, 'reply');
  assert.equal(reply.author_name, 'Magazynier');
  await send(thread.id, 'note', 'PRIVATE SUPPORT SECRET');
  const detail = await ok('/customer-messages/' + thread.id);
  assert.equal(detail.data.length, 3);
  assert.equal(detail.message_count, 3);
  assert.equal(detail.public_message_count, 2);
  const publicView = await pub(f.token);
  assert.equal(publicView.data.length, 2);
  const text = JSON.stringify(publicView);
  assert(!text.includes('PRIVATE SUPPORT SECRET'));
  assert(!text.includes('OLD INTERNAL ORDER NOTE'));
  for (const key of [
    'tenant_id',
    'thread_id',
    'order_id',
    'actor_id',
    'author_id',
    'author_name',
    'client_key',
    'request_hash',
    'version',
  ])
    assert(!text.includes('"' + key + '"'));
  assert.notEqual(incoming.id, detail.data.find((m: any) => m.kind === 'buyer').id);
  assert.deepEqual(await business(f), before);
  const audit = (
    await pool.query(
      "SELECT detail FROM audit_events WHERE tenant_id=$1 AND action LIKE 'customer.message.%' AND detail->>'order_id'=$2",
      [DEMO_TENANT, f.o.id],
    )
  ).rows;
  assert.equal(audit.length, 3);
  assert(!JSON.stringify(audit).includes(f.token));
  assert(!JSON.stringify(audit).includes('PRIVATE SUPPORT SECRET'));
});
test('idempotent same-key requests are immutable; replay after closing does not reopen or change CAS revision', async () => {
  const f = await conversation(),
    input = body('Kolejna wiadomość');
  const first = await pub(f.token, 'POST', input);
  let detail = await ok('/customer-messages/' + f.thread.id);
  detail = await ok('/customer-messages/' + f.thread.id, 'PATCH', {
    status: 'closed',
    version: detail.version,
  });
  const before = digest(detail);
  const again = await ok('/public/orders/' + f.token + '/messages', 'POST', input, '', 200);
  assert.equal(again.id, first.id);
  assert.equal(again.reused, true);
  assert.equal(again.status, 'closed');
  assert.equal(digest(await ok('/customer-messages/' + f.thread.id)), before);
  await ok(
    '/public/orders/' + f.token + '/messages',
    'POST',
    { ...input, body: 'Inna treść' },
    '',
    409,
  );
  const rbody = body('Portalowa odpowiedź'),
    r1 = await ok('/customer-messages/' + f.thread.id + '/reply', 'POST', rbody, admin, 201),
    snapshot = await ok('/customer-messages/' + f.thread.id);
  const r2 = await ok('/customer-messages/' + f.thread.id + '/reply', 'POST', rbody);
  assert.equal(r1.id, r2.id);
  assert.equal(digest(await ok('/customer-messages/' + f.thread.id)), digest(snapshot));
  await ok('/customer-messages/' + f.thread.id + '/note', 'POST', rbody, admin, 409);
  await ok('/customer-messages/' + f.thread.id + '/reply', 'POST', rbody, operator, 409);
  const next = await pub(f.token, 'POST', body('Nowe pytanie po zamknięciu'));
  assert.equal(next.status, 'open');
  assert.equal((await ok('/customer-messages/' + f.thread.id)).status, 'open');
});
test('viewer sees no private body/count/version/activity and cannot write; note-only threads stay hidden from public/viewer', async () => {
  const f = await conversation(),
    before = await ok('/customer-messages/' + f.thread.id, 'GET', undefined, viewer),
    history = await ok('/customer-messages?order_id=' + f.o.id, 'GET', undefined, viewer),
    publicBefore = await pub(f.token);
  assert(!('version' in before));
  assert.equal(before.can_note, false);
  await send(f.thread.id, 'note', 'NOTE HIDDEN FROM VIEWER');
  assert.deepEqual(await ok('/customer-messages/' + f.thread.id, 'GET', undefined, viewer), before);
  assert.deepEqual(
    await ok('/customer-messages?order_id=' + f.o.id, 'GET', undefined, viewer),
    history,
  );
  assert.deepEqual(await pub(f.token), publicBefore);
  for (const path of ['reply', 'note'])
    await ok('/customer-messages/' + f.thread.id + '/' + path, 'POST', body(), viewer, 403);
  await ok(
    '/customer-messages/' + f.thread.id,
    'PATCH',
    { status: 'closed', version: 2 },
    viewer,
    403,
  );
  const hidden = await fixture();
  await tenantTx(DEMO_TENANT, (c) =>
    appendCustomerOrderMessage(
      c,
      { tenantId: DEMO_TENANT, userId: user, role: 'admin' },
      hidden.o.id,
      'note',
      customerMessageInput.parse(body('Only private')),
    ),
  );
  assert.equal(
    (await ok('/customer-messages?order_id=' + hidden.o.id, 'GET', undefined, viewer)).data.length,
    0,
  );
  assert.deepEqual((await pub(hidden.token)).data, []);
  assert.equal((await pub(hidden.token)).status, null);
  const own = (await ok('/customer-messages?order_id=' + hidden.o.id)).data[0];
  await ok('/customer-messages/' + own.id, 'GET', undefined, viewer, 404);
  const publicReply = await send(own.id, 'reply', 'Pierwsza publiczna odpowiedź');
  const nowVisible = await ok('/customer-messages/' + own.id, 'GET', undefined, viewer);
  assert.equal(nowVisible.created_at, publicReply.created_at);
  assert.notEqual(nowVisible.created_at, own.created_at);
});
test('token rotation/disable/expiry are checked under own order lock, including resolved stale references', async () => {
  const f = await conversation(),
    ref = await resolveCustomerMessageToken(f.token);
  const rotated = await ok('/orders/' + f.o.id + '/portal', 'POST', {
    action: 'rotate',
    days: 30,
  });
  const token = rotated.token ?? rotated.portal_token;
  assert(token && token !== f.token);
  await ok('/public/orders/' + f.token + '/messages', 'GET', undefined, '', 404);
  await ok('/public/orders/' + f.token + '/messages', 'POST', body(), '', 404);
  await assert.rejects(publicCustomerMessageRead(ref, f.token), (e) => (e as any).status === 404);
  await assert.rejects(
    publicCustomerMessageWrite(ref, f.token, customerMessageInput.parse(body())),
    (e) => (e as any).status === 404,
  );
  assert.equal((await pub(token)).data.length, 1);
  await pool.query('UPDATE orders SET portal_enabled=false WHERE id=$1', [f.o.id]);
  await ok('/public/orders/' + token + '/messages', 'GET', undefined, '', 404);
  await ok('/public/orders/' + token + '/messages', 'POST', body(), '', 404);
  await pool.query(
    "UPDATE orders SET portal_enabled=true,portal_expires_at=now()-interval '1 second' WHERE id=$1",
    [f.o.id],
  );
  await ok('/public/orders/' + token + '/messages', 'GET', undefined, '', 404);
});
test('foreign tenant/RLS/FK/append-only privacy protect order-bound scopes and auth display names', async () => {
  const f = await conversation(),
    note = await send(f.thread.id, 'note', 'PRIVATE'),
    first = (await pool.query('SELECT * FROM customer_messages WHERE id=$1', [note.id])).rows[0];
  await ok('/customer-messages/' + f.thread.id, 'GET', undefined, other, 404);
  await ok('/customer-messages/' + f.thread.id + '/reply', 'POST', body(), other, 404);
  await ok(
    '/customer-messages/' + f.thread.id,
    'PATCH',
    { status: 'closed', version: 2 },
    other,
    404,
  );
  await tenantTx(SECOND_TENANT, async (c) => {
    assert.equal(
      (await c.query('SELECT id FROM customer_message_threads WHERE id=$1', [f.thread.id]))
        .rowCount,
      0,
    );
    assert.equal(
      (await c.query('SELECT id FROM customer_messages WHERE id=$1', [note.id])).rowCount,
      0,
    );
    assert.equal(
      (await c.query('SELECT customer_message_actor_name($1) name', [user])).rows[0].name,
      null,
    );
  });
  for (const sql of [
    "UPDATE customer_messages SET body='tamper' WHERE id=$1",
    'DELETE FROM customer_messages WHERE id=$1',
  ])
    await assert.rejects(
      tenantTx(DEMO_TENANT, (c) => c.query(sql, [note.id])),
      /permission denied/,
    );
  await assert.rejects(
    tenantTx(DEMO_TENANT, (c) =>
      c.query('UPDATE customer_message_threads SET order_id=$2,version=version+1 WHERE id=$1', [
        f.thread.id,
        randomUUID(),
      ]),
    ),
    /immutable/,
  );
  const foreignOrder = (
    await pool.query('SELECT id FROM orders WHERE tenant_id=$1 LIMIT 1', [SECOND_TENANT])
  ).rows[0]?.id;
  if (foreignOrder)
    await assert.rejects(
      tenantTx(DEMO_TENANT, (c) =>
        c.query(
          'INSERT INTO customer_messages SELECT (jsonb_populate_record(NULL::customer_messages,$1::jsonb)).*',
          [
            JSON.stringify({
              ...first,
              id: randomUUID(),
              public_id: randomUUID(),
              client_key: randomUUID(),
              order_id: foreignOrder,
            }),
          ],
        ),
      ),
      /foreign key/,
    );
});
test('status optimistic CAS rejects stale competing changes and new buyer message reopens closed thread', async () => {
  const f = await conversation(),
    d = await ok('/customer-messages/' + f.thread.id);
  const rs = await Promise.all([
    req('/customer-messages/' + f.thread.id, 'PATCH', { version: d.version, status: 'closed' }),
    req('/customer-messages/' + f.thread.id, 'PATCH', { version: d.version, status: 'open' }),
  ]);
  assert.deepEqual(rs.map((r) => r.statusCode).sort(), [200, 409]);
  const now = await ok('/customer-messages/' + f.thread.id);
  await ok('/customer-messages/' + f.thread.id, 'PATCH', {
    status: 'closed',
    version: now.version,
  });
  await pub(f.token, 'POST', body('Proszę wrócić do sprawy'));
  assert.equal((await ok('/customer-messages/' + f.thread.id)).status, 'open');
  const closed = await ok('/customer-messages?status=closed&order_id=' + f.o.id);
  assert.deepEqual(closed.data, []);
  assert.equal((await ok('/customer-messages?status=open&order_id=' + f.o.id)).data.length, 1);
});
test('strict plaintext lengths and unknown attachment/actor fields reject before creation or side effects', async () => {
  const f = await fixture();
  for (const invalid of [
    { client_key: randomUUID(), body: '' },
    { client_key: randomUUID(), body: '   ' },
    { client_key: randomUUID(), body: 'x'.repeat(4001) },
    { client_key: randomUUID(), body: 'null\0char' },
    { client_key: randomUUID(), body: 'ok', attachments: [] },
    { client_key: randomUUID(), body: 'ok', actor_id: user },
    { client_key: 'bad', body: 'ok' },
  ])
    await ok('/public/orders/' + f.token + '/messages', 'POST', invalid, '', 422);
  assert.equal((await ok('/customer-messages?order_id=' + f.o.id)).data.length, 0);
  const exact = await pub(f.token, 'POST', body('x'.repeat(4000)));
  assert.equal(exact.body.length, 4000);
  await ok('/customer-messages?cursor=bad', 'GET', undefined, admin, 422);
  await ok('/public/orders/' + f.token + '/messages?cursor=bad', 'GET', undefined, '', 422);
});
async function blockedOrder(
  f: any,
  operation: () => ReturnType<typeof req>,
  change: () => Promise<unknown>,
) {
  const c = await pool.connect();
  let pending: ReturnType<typeof req> | undefined;
  try {
    await c.query('BEGIN');
    await c.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE', [f.o.id]);
    pending = operation();
    let waiting = false;
    // A deadline, not a poll count: on a loaded runner the request reaches the fence after ~0.5 s or later.
    for (const until = Date.now() + 30000; Date.now() < until; ) {
      waiting = !!(
        await pool.query(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='transactionid' AND query LIKE 'SELECT id,portal_token%') waiting",
        )
      ).rows[0].waiting;
      if (waiting) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    assert(waiting, 'service did not reach the order fence');
    await change();
    await c.query('COMMIT');
    return await pending;
  } finally {
    await c.query('ROLLBACK');
    c.release();
    await pending;
  }
}
test('revocation while blocked on the order fence prevents reply/status and removes private reads', async () => {
  const f = await conversation();
  await send(f.thread.id, 'note', 'LOCKED PRIVATE NOTE');
  const before = (await ok('/customer-messages/' + f.thread.id)).message_count;
  let r = await blockedOrder(
    f,
    () => req('/customer-messages/' + f.thread.id + '/reply', 'POST', body()),
    () =>
      pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
        DEMO_TENANT,
        user,
      ]),
  );
  assert.equal(r.statusCode, 403, r.body);
  assert.equal(
    (await ok('/customer-messages/' + f.thread.id, 'GET', undefined, operator)).message_count,
    before,
  );
  await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
    DEMO_TENANT,
    user,
  ]);
  const d = await ok('/customer-messages/' + f.thread.id);
  r = await blockedOrder(
    f,
    () =>
      req('/customer-messages/' + f.thread.id, 'PATCH', { status: 'closed', version: d.version }),
    () =>
      pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
        DEMO_TENANT,
        user,
      ]),
  );
  assert.equal(r.statusCode, 403, r.body);
  assert.equal(
    (await ok('/customer-messages/' + f.thread.id, 'GET', undefined, operator)).status,
    'open',
  );
  await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
    DEMO_TENANT,
    user,
  ]);
  r = await blockedOrder(
    f,
    () => req('/customer-messages/' + f.thread.id),
    () =>
      pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
        DEMO_TENANT,
        user,
      ]),
  );
  assert.equal(r.statusCode, 200, r.body);
  assert(!r.body.includes('LOCKED PRIVATE NOTE'));
  assert.equal(r.json().current_role, 'viewer');
  assert(!('version' in r.json()));
});
async function cloneMessages(
  f: any,
  count: number,
  kind: 'buyer' | 'note',
  createdAt: string | undefined,
) {
  const first = (
    await pool.query('SELECT * FROM customer_messages WHERE thread_id=$1 LIMIT 1', [f.thread.id])
  ).rows[0];
  const record = {
    ...first,
    kind,
    actor_id: kind === 'note' ? user : null,
    body: kind === 'note' ? 'PRIVATE PAGINATION SECRET' : 'Public historical message',
  };
  await pool.query(
    "INSERT INTO customer_messages SELECT (jsonb_populate_record(NULL::customer_messages,$1::jsonb||jsonb_build_object('id',gen_random_uuid(),'public_id',gen_random_uuid(),'client_key',gen_random_uuid(),'created_at',coalesce($3::timestamptz,now()-interval '2 hours')))).* FROM generate_series(1,$2)",
    [JSON.stringify(record), count, createdAt ?? null],
  );
  await pool.query(
    'UPDATE customer_message_threads SET message_count=message_count+$2,public_message_count=public_message_count+$3,version=version+1 WHERE id=$1',
    [f.thread.id, count, kind === 'note' ? 0 : count],
  );
}
test('public and staff message keysets preserve microseconds/ties and never expose private cursor IDs; inbox pages are bounded', async () => {
  const f = await conversation();
  await cloneMessages(f, 27, 'buyer', '2001-01-01T00:00:00.123456Z');
  await cloneMessages(f, 26, 'note', '2001-01-01T00:00:00.123456Z');
  const staffIds = new Set<string>(),
    publicIds = new Set<string>();
  let q: string | undefined,
    pages = 0;
  do {
    const d = await ok(
      '/customer-messages/' + f.thread.id + (q ? '?cursor=' + encodeURIComponent(q) : ''),
    );
    assert(d.data.length <= 20);
    for (const m of d.data) {
      assert(!staffIds.has(m.id));
      staffIds.add(m.id);
    }
    q = d.meta.cursor;
    if (q) assert.match(JSON.parse(Buffer.from(q, 'base64url').toString())[0], /\.123456Z$/);
    pages++;
  } while (q);
  assert.equal(staffIds.size, 54);
  assert.equal(pages, 3);
  q = undefined;
  do {
    const d = await pub(f.token, 'GET', undefined, q);
    assert(d.data.length <= 20);
    assert(!JSON.stringify(d).includes('PRIVATE PAGINATION SECRET'));
    for (const m of d.data) {
      assert(!publicIds.has(m.id));
      assert(!staffIds.has(m.id));
      publicIds.add(m.id);
    }
    q = d.meta.cursor;
  } while (q);
  assert.equal(publicIds.size, 28);
  const viewerPage = await ok('/customer-messages/' + f.thread.id, 'GET', undefined, viewer);
  assert(viewerPage.data.every((m: any) => m.kind !== 'note'));
  for (let i = 0; i < 21; i++) {
    ip++;
    await conversation();
  }
  const seen = new Set<string>();
  q = undefined;
  do {
    const list = await ok('/customer-messages' + (q ? '?cursor=' + encodeURIComponent(q) : ''));
    assert(list.data.length <= 20);
    for (const t of list.data) {
      assert(!seen.has(t.id));
      seen.add(t.id);
    }
    q = list.meta.cursor;
  } while (q);
  assert.equal(
    seen.size,
    Number(
      (
        await pool.query('SELECT count(*) n FROM customer_message_threads WHERE tenant_id=$1', [
          DEMO_TENANT,
        ])
      ).rows[0].n,
    ),
  );
});
test('concurrent same-key delivery is exactly once, token/IP limits and durable per-thread hourly/daily/total bounds reject new posts', async () => {
  const f = await fixture(),
    input = body('Concurrent buyer');
  const rs = await Promise.all([
    req('/public/orders/' + f.token + '/messages', 'POST', input, ''),
    req('/public/orders/' + f.token + '/messages', 'POST', input, ''),
  ]);
  assert.deepEqual(rs.map((r) => r.statusCode).sort(), [200, 201]);
  assert.equal(rs[0].json().id, rs[1].json().id);
  const count = (await ok('/customer-messages?order_id=' + f.o.id)).data[0];
  assert.equal(count.message_count, 1);
  assert.equal(count.version, 2);
  for (let n = 0; n < 29; n++) {
    ip++;
    await pub(f.token, 'POST', body('Hourly ' + n));
  }
  ip++;
  await ok('/public/orders/' + f.token + '/messages', 'POST', body('31st'), '', 429);
  await ok('/public/orders/' + f.token + '/messages', 'POST', input, '', 200);
  const daily = await conversation();
  await cloneMessages(daily, 99, 'buyer', undefined);
  ip++;
  await ok('/public/orders/' + daily.token + '/messages', 'POST', body('101st/day'), '', 429);
  const total = await conversation();
  await cloneMessages(total, 999, 'buyer', '2001-01-01T00:00:00.123456Z');
  ip++;
  await ok('/public/orders/' + total.token + '/messages', 'POST', body('1001st/thread'), '', 429);
  await ok(
    '/customer-messages/' + total.thread.id + '/reply',
    'POST',
    body('Staff cap'),
    admin,
    429,
  );
  ip++;
  const limit = await fixture();
  let statuses = [];
  for (let i = 0; i < 21; i++)
    statuses.push(
      (await req('/public/orders/' + limit.token + '/messages', 'POST', body('IP ' + i), ''))
        .statusCode,
    );
  assert(statuses.includes(429));
  assert.equal((await ok('/customer-messages?order_id=' + limit.o.id)).data[0].message_count, 20);
});
test('restore read-only allows local public/history evidence and blocks every write; older copy returns graceful unavailable without touching module tables', async () => {
  const f = await conversation(),
    snapshot = digest(
      (
        await pool.query('SELECT to_jsonb(t) d FROM customer_message_threads t WHERE id=$1', [
          f.thread.id,
        ])
      ).rows,
    );
  const ro = await buildApp({ readOnly: true });
  if (!ro.hasRoute({ method: 'GET', url: '/api/customer-messages' }))
    registerCustomerMessageRoutes(ro, { available: true, readOnly: true });
  try {
    const auth = await login('admin@demo.local', ro);
    for (const path of [
      '/customer-messages',
      '/customer-messages/' + f.thread.id,
      '/public/orders/' + f.token + '/messages',
    ]) {
      const r = await ro.inject({ url: '/api' + path, headers: { cookie: auth } });
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(r.json().read_only, true);
    }
    for (const [path, method] of [
      ['/customer-messages/' + f.thread.id + '/reply', 'POST'],
      ['/customer-messages/' + f.thread.id + '/note', 'POST'],
      ['/customer-messages/' + f.thread.id, 'PATCH'],
      ['/public/orders/not-valid/messages', 'POST'],
    ] as const) {
      const r = await ro.inject({
        url: '/api' + path,
        method,
        payload: { invalid: true },
        headers: { cookie: auth },
      });
      assert.equal(r.statusCode, 423, r.body);
    }
  } finally {
    await ro.close();
  }
  assert.equal(
    digest(
      (
        await pool.query('SELECT to_jsonb(t) d FROM customer_message_threads t WHERE id=$1', [
          f.thread.id,
        ])
      ).rows,
    ),
    snapshot,
  );
  await pool.query(
    'ALTER TABLE customer_message_threads RENAME TO qa_hidden_customer_message_threads',
  );
  let legacy: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    legacy = await buildApp();
    if (!legacy.hasRoute({ method: 'GET', url: '/api/customer-messages' }))
      registerCustomerMessageRoutes(legacy, { available: false, readOnly: false });
    const auth = await login('admin@demo.local', legacy);
    for (const path of [
      '/customer-messages',
      '/customer-messages/not-valid',
      '/public/orders/not-valid/messages',
    ]) {
      const r: Awaited<ReturnType<typeof legacy.inject>> = await legacy.inject({
        url: '/api' + path,
        headers: { cookie: auth },
      });
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(r.json().available, false);
      assert.deepEqual(r.json().data, []);
    }
    const r = await legacy.inject({
      url: '/api/public/orders/not-valid/messages',
      method: 'POST',
      payload: {},
      headers: { cookie: auth },
    });
    assert.equal(r.statusCode, 503, r.body);
  } finally {
    await legacy?.close();
    await pool.query(
      'ALTER TABLE qa_hidden_customer_message_threads RENAME TO customer_message_threads',
    );
  }
});
