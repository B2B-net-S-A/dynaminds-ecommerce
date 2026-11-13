import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { test, before, after } from 'node:test';
import { Script } from 'node:vm';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed, DEMO_TENANT, SECOND_TENANT } from './fixtures';
import { returnOverview } from '../server/returns';
import { returnPage, returnQuery } from '../server/return-query';
import { writeFile } from 'node:fs/promises';
assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  viewer: string,
  other: string,
  warehouse: string;
const req = (url: string, method: any = 'GET', payload?: any, auth = cookie) =>
  app.inject({
    url: '/api' + url,
    method,
    payload,
    headers: { cookie: auth, ...(url === '/orders' ? { 'idempotency-key': randomUUID() } : {}) },
  });
async function ok(url: string, method: any = 'GET', payload?: any) {
  const r = await req(url, method, payload);
  assert(r.statusCode < 300, r.body);
  return r.json();
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp();
  const login = async (email: string) =>
    (await req('/auth/login', 'POST', { email, password: 'DynaDemo!2026' }, '')).headers[
      'set-cookie'
    ]!.toString().split(';')[0];
  cookie = await login('admin@demo.local');
  viewer = await login('viewer@demo.local');
  other = await login('other@demo.local');
  warehouse = (await ok('/warehouses')).data[0].id;
});
after(async () => {
  await app.close();
  await pool.end();
});
async function fixture(qty = 2, ship = true) {
  const p = await ok('/products', 'POST', {
    name: 'Portal QA <script>bad()</script>',
    sku: 'PORT-' + randomUUID().slice(0, 8),
    price: 11001,
    quantity: 10,
    warehouse_id: warehouse,
  });
  const o = await ok('/orders', 'POST', {
    customer_name: 'Portal buyer',
    email: 'private@example.test',
    warehouse_id: warehouse,
    items: [{ product_id: p.id, quantity: qty }],
    shipping_cost: 1499,
    note: 'PRIVATE INTERNAL NOTE',
  });
  if (ship) {
    for (const status of ['paid', 'picking'])
      await ok('/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + o.id + '/status', { status }));
    for (let n = 0; n < qty; n++) await ok('/orders/' + o.id + '/scan', 'POST', { code: p.sku });
    await ok('/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/orders/' + o.id + '/status', { status: 'packed' }));
    await ok('/orders/' + o.id + '/ship-demo', 'POST');
    await ok('/orders/' + o.id + '/documents', 'POST', { kind: 'invoice' });
  }
  return { p, o: await ok('/orders/' + o.id) };
}
const ips = new Map<string, string>();
const pub = (token: string, path = '', method: any = 'GET', payload?: any, extra: any = {}) => {
  if (!ips.has(token)) ips.set(token, '127.0.0.' + (ips.size + 30));
  return app.inject({
    url: '/api/public/orders/' + token + path,
    method,
    payload,
    remoteAddress: ips.get(token),
    ...extra,
  });
};
const input = (o: any, qty = 1, extra: any = {}) => ({
  client_key: randomUUID(),
  kind: 'return',
  reason: 'Kupujący QA zwrot',
  items: [{ item_id: o.items[0].id, quantity: qty }],
  shipping_refund: 0,
  ...extra,
});
const receive = (r: any) => ({
  version: Number(r.version),
  note: 'Operator QA przyjął towar',
  shipping_refund: r.requested_shipping,
  items: r.items.map((i: any) => ({
    item_id: i.item_id,
    accepted: i.requested,
    restocked: i.requested,
  })),
});
test('portal jest osobną stroną z CSP, bez danych osobowych, notatek i powiązań magazynu', async () => {
  const { o } = await fixture();
  const html = await pub(o.portal_token);
  assert.equal(html.statusCode, 200);
  assert.match(html.body, /Twoje zamówienie/);
  new Script(html.body.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)![1]);
  assert.match(html.body, /&lt;script&gt;bad/);
  assert(!html.body.includes('<script>bad()'));
  assert.match(html.headers['content-security-policy']!.toString(), /frame-ancestors 'none'/);
  assert.equal(html.headers['cache-control'], 'no-store');
  assert.equal(html.headers['referrer-policy'], 'no-referrer');
  const data = (await pub(o.portal_token, '/data')).json();
  assert.equal(data.number, o.number);
  assert.equal(data.items[0].available, 2);
  assert.equal(data.documents.length, 1);
  for (const value of [
    o.email,
    o.note,
    o.portal_token,
    o.tenant_id,
    o.warehouse_id,
    o.customer_name,
  ])
    assert(!JSON.stringify(data).includes(value));
  for (const forbidden of [
    'request',
    'receipt',
    'settlement',
    'components',
    'restocked',
    'credentials',
    'actor_id',
  ])
    assert(!Object.hasOwn(data, forbidden));
});
test('kupujący zgłasza bez sesji; audit oznacza buyer, a stan i kwota sprzedaży nie zmieniają się', async () => {
  const { o, p } = await fixture();
  const r = await pub(o.portal_token, '/returns', 'POST', input(o));
  assert.equal(r.statusCode, 201, r.body);
  const id = r.json().id;
  const raw = (await pool.query('SELECT submitted_by,state FROM return_cases WHERE id=$1', [id]))
    .rows[0];
  assert.deepEqual(raw, { submitted_by: 'buyer', state: 'requested' });
  const audit = (
    await pool.query(
      "SELECT user_id,detail->>'submitted_by' AS origin FROM audit_events WHERE entity_id=$1 AND action='return.requested'",
      [id],
    )
  ).rows;
  assert.deepEqual(audit, [{ user_id: null, origin: 'buyer' }]);
  const stock = (await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [p.id]))
    .rows[0];
  assert.deepEqual(stock, { on_hand: 8, reserved: 0 });
  assert.equal((await ok('/orders/' + o.id)).total, o.total);
  assert.equal((await pub(o.portal_token, '/data')).json().items[0].available, 1);
});
test('równoczesny replay kupującego tworzy jedną sprawę; zmieniona treść i nadmiar są odrzucone', async () => {
  const { o } = await fixture();
  const b = input(o, 2);
  const results = await Promise.all(
    Array.from({ length: 8 }, () => pub(o.portal_token, '/returns', 'POST', b)),
  );
  assert(results.every((r) => r.statusCode === 201));
  assert.equal(new Set(results.map((r) => r.json().id)).size, 1);
  assert.equal(
    (await pub(o.portal_token, '/returns', 'POST', { ...b, reason: 'Inny powód' })).statusCode,
    409,
  );
  assert.equal((await pub(o.portal_token, '/returns', 'POST', input(o))).statusCode, 409);
  assert.equal((await pub(o.portal_token, '/data')).json().can_request, false);
});
test('publiczny formularz nie wybiera magazynu, nie przyjmuje towaru ani nie potwierdza wypłaty', async () => {
  const { o } = await fixture();
  assert.equal(
    (await pub(o.portal_token, '/returns', 'POST', input(o, 1, { warehouse_id: warehouse })))
      .statusCode,
    422,
  );
  const r = (await pub(o.portal_token, '/returns', 'POST', input(o))).json();
  for (const path of [
    '/returns/' + r.id + '/receive',
    '/returns/' + r.id + '/refund',
    '/returns/' + r.id + '/decision',
  ])
    assert.equal((await pub(o.portal_token, path, 'POST', {})).statusCode, 404);
  assert.equal(
    (await pub(o.portal_token, '/returns', 'POST', input(o, 1, { confirmed: true }))).statusCode,
    422,
  );
});
test('obca pozycja i dostawa ponad kwotę są odrzucane atomowo; waluta pozostaje oryginalna', async () => {
  const a = await fixture(),
    b = await fixture();
  assert.equal((await pub(a.o.portal_token, '/returns', 'POST', input(b.o))).statusCode, 422);
  assert.equal(
    (await pub(a.o.portal_token, '/returns', 'POST', input(a.o, 1, { shipping_refund: 1500 })))
      .statusCode,
    409,
  );
  assert.equal((await pub(a.o.portal_token, '/data')).json().cases.length, 0);
  await pool.query("UPDATE orders SET currency='EUR' WHERE id=$1", [a.o.id]);
  assert.equal((await pub(a.o.portal_token, '/data')).json().currency, 'EUR');
});
test('nieznany/wygasły/wyłączony link nie czyta ani nie zgłasza, sesja admina nie omija linku', async () => {
  const { o } = await fixture();
  for (const path of ['', '/data', '/returns']) {
    const post = path === '/returns';
    assert.equal(
      (await pub('0'.repeat(48), path, post ? 'POST' : 'GET', post ? input(o) : undefined))
        .statusCode,
      404,
    );
  }
  const unavailable = await pub('0'.repeat(48));
  assert.match(unavailable.headers['content-type']!.toString(), /text\/html/);
  assert.match(unavailable.body, /Link zamówienia jest niedostępny/);
  assert(!unavailable.body.includes(o.number));
  await pool.query("UPDATE orders SET portal_expires_at=now()-interval '1 second' WHERE id=$1", [
    o.id,
  ]);
  assert.equal(
    (await pub(o.portal_token, '/data', 'GET', undefined, { headers: { cookie } })).statusCode,
    404,
  );
  await pool.query('UPDATE orders SET portal_expires_at=NULL,portal_enabled=false WHERE id=$1', [
    o.id,
  ]);
  assert.equal((await pub(o.portal_token, '/returns', 'POST', input(o))).statusCode, 404);
});
test('administrator rotuje i wyłącza link tylko swojej firmy, bez ujawnienia tokenu w audycie', async () => {
  const { o } = await fixture();
  for (const auth of [viewer, other])
    assert(
      [403, 404].includes(
        (await req('/orders/' + o.id + '/portal', 'POST', { action: 'rotate' }, auth)).statusCode,
      ),
    );
  const rotated = await ok('/orders/' + o.id + '/portal', 'POST', { action: 'rotate', days: 30 });
  assert.notEqual(rotated.portal_token, o.portal_token);
  assert.equal((await pub(o.portal_token)).statusCode, 404);
  assert.equal((await pub(rotated.portal_token)).statusCode, 200);
  const audit = JSON.stringify(
    (
      await pool.query(
        "SELECT detail FROM audit_events WHERE entity_id=$1 AND action='portal.rotate'",
        [o.id],
      )
    ).rows,
  );
  assert(!audit.includes(rotated.portal_token));
  assert(!audit.includes(o.portal_token));
  await ok('/orders/' + o.id + '/portal', 'POST', { action: 'disable' });
  assert.equal((await pub(rotated.portal_token, '/returns', 'POST', input(o))).statusCode, 404);
});
test('unieważnienie linku wygrywa z rozpoczętym zgłoszeniem oczekującym na blokadę zamówienia', async () => {
  const { o } = await fixture();
  const c = await pool.connect();
  let pending: ReturnType<typeof pub> | undefined;
  try {
    await c.query('BEGIN');
    await c.query('UPDATE orders SET portal_enabled=false WHERE id=$1', [o.id]);
    pending = pub(o.portal_token, '/returns', 'POST', input(o));
    // Start inject now; observe the actual PostgreSQL waiter rather than assuming a delay.
    const result = Promise.resolve(pending);
    let waiting = false;
    for (let n = 0; n < 100; n++) {
      const r = await pool.query(
        "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query='SELECT * FROM orders WHERE id=$1 FOR UPDATE'",
      );
      if (r.rowCount) {
        waiting = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert(waiting, 'customer request did not reach the observed order lock');
    await c.query('COMMIT');
    assert.equal((await result).statusCode, 404);
    assert.equal(
      (await pool.query('SELECT count(*)::int AS n FROM return_cases WHERE order_id=$1', [o.id]))
        .rows[0].n,
      0,
    );
  } finally {
    await c.query('ROLLBACK');
    c.release();
    if (pending) await pending;
  }
});
test('portal pobiera dokument tylko swojego zamówienia i nie wywołuje dostawcy', async () => {
  const a = await fixture(),
    b = await fixture();
  const own = a.o.documents[0],
    foreign = b.o.documents[0];
  assert.equal((await pub(a.o.portal_token, '/documents/' + own.id + '/print')).statusCode, 200);
  assert.equal(
    (await pub(a.o.portal_token, '/documents/' + foreign.id + '/print')).statusCode,
    404,
  );
  assert.equal((await pub('0'.repeat(48), '/documents/' + own.id + '/print')).statusCode, 404);
  await pool.query("UPDATE documents SET mode='external' WHERE id=$1", [own.id]);
  assert.equal((await pub(a.o.portal_token, '/documents/' + own.id + '/print')).statusCode, 409);
  assert.equal(
    (await pub(a.o.portal_token, '/data')).json().documents[0].download_available,
    false,
  );
});
test('decyzja odrzucenia jest widoczna kupującemu, przyjęcie nie ujawnia notatek ani referencji', async () => {
  const { o } = await fixture();
  const r = (await pub(o.portal_token, '/returns', 'POST', input(o))).json();
  await ok('/returns/' + r.id + '/decision', 'POST', {
    version: 1,
    decision: 'reject',
    note: 'Uzasadnienie dla klienta QA',
  });
  const data = (await pub(o.portal_token, '/data')).json();
  assert.equal(data.cases[0].decision_note, 'Uzasadnienie dla klienta QA');
  assert.equal(data.items[0].available, 2);
  const next = (await pub(o.portal_token, '/returns', 'POST', input(o))).json();
  const received = await ok('/returns/' + next.id + '/receive', 'POST', {
    ...receive(await ok('/returns/' + next.id)),
    note: 'PRIVATE INTAKE',
  });
  await ok('/returns/' + next.id + '/refund', 'POST', {
    version: Number(received.version),
    amount: received.refund_amount,
    reference: 'PRIVATE BANK REF',
    confirmed: true,
  });
  const latest = (await pub(o.portal_token, '/data')).json();
  assert(!JSON.stringify(latest).includes('PRIVATE INTAKE'));
  assert(!JSON.stringify(latest).includes('PRIVATE BANK REF'));
  assert(latest.cases[0].refunded_at);
});
test('zgłoszenie przed wydaniem, obcy Origin i powyżej pięciu oczekujących są blokowane', async () => {
  const draft = await fixture(2, false);
  assert.equal(
    (await pub(draft.o.portal_token, '/returns', 'POST', input(draft.o))).statusCode,
    409,
  );
  const { o } = await fixture(6);
  assert.equal(
    (
      await pub(o.portal_token, '/returns', 'POST', input(o), {
        headers: { origin: 'https://foreign.example' },
      })
    ).statusCode,
    403,
  );
  for (let i = 0; i < 5; i++)
    assert.equal((await pub(o.portal_token, '/returns', 'POST', input(o))).statusCode, 201);
  assert.equal((await pub(o.portal_token, '/returns', 'POST', input(o))).statusCode, 409);
});
test('limit publicznych zgłoszeń jest skuteczny także dla replay', async () => {
  const { o } = await fixture();
  const b = input(o);
  for (let i = 0; i < 20; i++)
    assert.equal(
      (await pub(o.portal_token, '/returns', 'POST', b, { remoteAddress: '127.0.1.99' }))
        .statusCode,
      201,
    );
  assert.equal(
    (await pub(o.portal_token, '/returns', 'POST', b, { remoteAddress: '127.0.1.99' })).statusCode,
    429,
  );
});
test('odtworzona kopia pokazuje historię, ale nie tworzy spraw ani nie rotuje linku', async () => {
  const { o } = await fixture();
  const preview = await buildApp({ readOnly: true });
  try {
    assert.equal(
      (await preview.inject({ url: '/api/public/orders/' + o.portal_token + '/data' })).json()
        .can_request,
      false,
    );
    assert.equal(
      (
        await preview.inject({
          url: '/api/public/orders/' + o.portal_token + '/returns',
          method: 'POST',
          payload: input(o),
        })
      ).statusCode,
      423,
    );
    assert.equal(
      (
        await preview.inject({
          url: '/api/orders/' + o.id + '/portal',
          method: 'POST',
          payload: { action: 'rotate' },
          headers: { cookie },
        })
      ).statusCode,
      423,
    );
  } finally {
    await preview.close();
  }
});
async function history(order: any, count: number) {
  // Each return case runs the warehouse policy guards three times (~5 ms per row, 13.11.2026), so
  // 10000 rows in one statement passed the 8 s statement_timeout. Batches of 250 keep every trigger.
  const series = randomUUID();
  for (let from = 1; from <= count; from += 250)
    await pool.query(
      `INSERT INTO return_cases(id,tenant_id,order_id,warehouse_id,number,kind,state,reason,created_at) SELECT gen_random_uuid(),$1,$2,$3,'HIST-'||$4||'-'||n,'return','cancelled','QA history','2026-01-01 00:00:00.000000+00'::timestamptz+n*interval '1 microsecond' FROM generate_series($5::int,$6::int) n`,
      [DEMO_TENANT, order.id, warehouse, series, from, Math.min(count, from + 249)],
    );
}
test('kursor zachowuje mikrosekundy, filtry i kompletność historii starszej niż 25 spraw', async () => {
  const { o } = await fixture();
  await history(o, 61);
  let after: string | null = null;
  const ids: string[] = [];
  do {
    const response = await ok(
      '/orders/' + o.id + '/returns?limit=7' + (after ? '&after=' + encodeURIComponent(after) : ''),
    );
    ids.push(...response.cases.map((r: any) => r.id));
    after = response.meta.cursor;
  } while (after);
  assert.equal(ids.length, 61);
  assert.equal(new Set(ids).size, 61);
  const first = await ok(
    '/returns?state=cancelled&search=' + encodeURIComponent('HIST-') + '&limit=3',
  );
  assert.equal(first.data.length, 3);
  assert(first.meta.cursor);
  assert.equal(
    (await req('/returns?state=closed&search=HIST-&after=' + first.meta.cursor)).statusCode,
    422,
  );
  assert.equal((await req('/returns?after=invalid')).statusCode, 422);
  const longSearch = 'Ż'.repeat(100);
  await pool.query('UPDATE orders SET customer_name=$2 WHERE id=$1', [o.id, longSearch]);
  const path =
    '/orders/' +
    o.id +
    '/returns?limit=7&state=cancelled&kind=return&submitted_by=operator&search=' +
    longSearch;
  const longFirst = await ok(path);
  assert(longFirst.meta.cursor.length > 400);
  const longSecond = await ok(path + '&after=' + longFirst.meta.cursor);
  assert.equal(longSecond.cases.length, 7);
  assert(longSecond.cases.every((r: any) => !longFirst.cases.some((x: any) => x.id === r.id)));
  const data = (await pub(o.portal_token, '/data')).json();
  assert.equal(data.cases.length, 25);
  assert(data.meta.cursor);
  const second = (await pub(o.portal_token, '/data?after=' + data.meta.cursor)).json();
  assert.equal(second.cases.length, 25);
  assert(second.cases.every((r: any) => !data.cases.some((x: any) => x.id === r.id)));
});
test('ogólna kolejka respektuje RLS, rodzaj, źródło i zakres klucza API', async () => {
  const { o } = await fixture();
  const r = (
    await pub(o.portal_token, '/returns', 'POST', input(o, 1, { kind: 'complaint' }))
  ).json();
  const queue = await ok(
    '/returns?state=requested&kind=complaint&submitted_by=buyer&search=' + r.number,
  );
  assert.equal(queue.data.length, 1);
  assert.equal(queue.data[0].id, r.id);
  assert.equal(
    (await req('/returns?search=' + r.number, 'GET', undefined, other)).json().data.length,
    0,
  );
  const key = await ok('/developer/keys', 'POST', {
    name: 'Portal queue read QA',
    scopes: ['orders:read'],
  });
  const response = await app.inject({
    url: '/api/v1/returns?search=' + r.number,
    headers: { authorization: 'Bearer ' + key.token },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().data[0].id, r.id);
  await ok('/developer/keys/' + key.id, 'DELETE');
  const visible = await tenantTx(SECOND_TENANT, (c) =>
    c.query('SELECT id FROM return_cases WHERE id=$1', [r.id]),
  );
  assert.equal(visible.rowCount, 0);
});
test('globalne sumy, pełny proces i kolejność korekt nie zależą od widocznej strony historii', async () => {
  const { o } = await fixture();
  const r = (
    await pub(o.portal_token, '/returns', 'POST', input(o, 2, { shipping_refund: 1499 }))
  ).json();
  await ok('/returns/' + r.id + '/receive', 'POST', receive(await ok('/returns/' + r.id)));
  await pool.query("UPDATE return_cases SET created_at='2025-01-01' WHERE id=$1", [r.id]);
  await history(o, 50);
  const summary = await tenantTx(DEMO_TENANT, (c) => returnOverview(c, o.id));
  assert.equal(summary.cases.length, 25);
  assert(!summary.cases.some((x) => x.id === r.id));
  assert.equal(summary.refund_total, o.total);
  assert.equal(summary.has_partial, true);
  assert.equal(summary.all_cases_decided, false);
  assert.equal(summary.invoice_cases[0].id, r.id);
  assert.equal(
    (await req('/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => req(orderPath, 'GET', undefined), '/orders/' + o.id + '/status', { status: 'return_completed' }))).statusCode,
    409,
  );
  const full = await ok('/returns/' + r.id);
  await ok('/returns/' + r.id + '/refund', 'POST', {
    version: Number(full.version),
    amount: full.refund_amount,
    reference: 'QA-REF',
    confirmed: true,
  });
  assert.equal((await ok('/orders/' + o.id)).status, 'return_completed');
});
test('paginacja 10000 historycznych spraw ma ograniczony wynik i zapisane pomiary lokalne', async () => {
  const { o } = await fixture();
  await history(o, 10000);
  const first = await tenantTx(DEMO_TENANT, (c) =>
    returnPage(c, returnQuery.parse({ limit: 25, search: o.number })),
  );
  assert.equal(first.data.length, 25);
  let after = first.meta.cursor;
  const times: number[] = [];
  // Timers wrap only returnPage: an ungated test tenantTx also runs the full schema validators
  // (server/db.ts preflightUngatedTenantSchema) and commit guards, seconds that production never pays.
  for (let n = 0; n < 10; n++) {
    const page = await tenantTx(DEMO_TENANT, async (c) => {
      const start = performance.now();
      const result = await returnPage(c, returnQuery.parse({ limit: 25, search: o.number, after }));
      times.push(performance.now() - start);
      return result;
    });
    assert.equal(page.data.length, 25);
    after = page.meta.cursor;
  }
  const boundary = (
    await pool.query(
      'SELECT id,to_char(created_at AT TIME ZONE \'UTC\',\'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\') AS date FROM return_cases WHERE order_id=$1 ORDER BY created_at DESC,id DESC OFFSET 9974 LIMIT 1',
      [o.id],
    )
  ).rows[0];
  const deepCursor = Buffer.from(
    JSON.stringify({ ...boundary, filter: JSON.stringify([null, null, null, null, o.number]) }),
  ).toString('base64url');
  let deepMs = Infinity;
  const deep = await tenantTx(DEMO_TENANT, async (c) => {
    const deepStart = performance.now();
    const result = await returnPage(
      c,
      returnQuery.parse({ limit: 25, search: o.number, after: deepCursor }),
    );
    deepMs = performance.now() - deepStart;
    return result;
  });
  assert.equal(deep.data.length, 25);
  assert.equal(deep.meta.has_more, false);
  assert(deepMs < 2000);
  const sorted = [...times].sort((a, b) => a - b);
  const report = {
    scope:
      'isolated native PostgreSQL; 10000 cancelled cases on one synthetic order; not target Base capacity',
    case_count: 10000,
    page_size: 25,
    samples_ms: times,
    deep_page_after_row: 9975,
    deep_page_ms: deepMs,
    p95_ms: sorted[Math.ceil(0.95 * sorted.length) - 1],
    max_ms: Math.max(...times),
  };
  assert(report.max_ms < 2000, 'local query exceeded 2s');
  await writeFile('docs/portal-pagination.json', JSON.stringify(report, null, 2) + '\n');
});
