import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed, DEMO_TENANT } from './fixtures';
import { encrypt } from '../server/security';
import { processInvoice, failInvoice, invoiceMinor, nip } from '../server/invoices';
import { Fakturownia } from '../server/integrations';
import { tick } from '../server/worker';
assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  other: string,
  viewer: string,
  operator: string,
  warehouse: string;
const store = new Map<string, any>(),
  calls: { method: string; url: string; body: any }[] = [];
let next = 40000,
  lostCreate = false,
  rejectedCreate = false,
  badPdf = false,
  wrongTotal = false,
  paginated = false;
let mutateRead: ((r: any) => any) | undefined;
const json = (body: any, status = 200) => new Response(JSON.stringify(body), { status });
const transport = async (url: string, init: RequestInit) => {
  const u = new URL(url),
    method = init.method ?? 'GET',
    body = init.body ? JSON.parse(String(init.body)) : null;
  calls.push({ method, url, body });
  assert.equal(u.hostname, 'invoice-fixture.fakturownia.pl');
  if (u.pathname.endsWith('.pdf'))
    return new Response(badPdf ? '<html>error</html>' : '%PDF-1.4\nfixture', {
      headers: { 'content-type': 'application/pdf' },
    });
  if (method === 'POST') {
    assert.equal(u.pathname, '/invoices.json');
    assert.equal(body.api_token, 'fixture-token');
    assert.equal(body.invoice.oid_unique, 'yes');
    assert.equal(body.invoice.gov_send, undefined);
    assert.equal(body.invoice.exclude_from_stock_level, true);
    assert.equal(body.invoice.income, '1');
    if (rejectedCreate) throw new Error('provider detail fixture-token');
    const r = {
      ...body.invoice,
      id: next++,
      number: 'FV-QA/' + next,
      price_gross: (
        body.invoice.positions.reduce(
          (n: number, i: any) => n + invoiceMinor(i.total_price_gross),
          0,
        ) / 100
      ).toFixed(2),
      status: 'issued',
      token: 'private-document-token',
      gov_status: null,
      gov_id: null,
    };
    store.set(String(r.id), r);
    if (lostCreate) {
      lostCreate = false;
      throw new Error('lost response fixture-token');
    }
    return json(r, 201);
  }
  assert.equal(method, 'GET');
  assert.equal(u.searchParams.get('api_token'), 'fixture-token');
  if (u.pathname === '/invoices.json') {
    assert.equal(u.searchParams.get('period'), 'all');
    assert.equal(u.searchParams.get('include_positions'), 'true');
    return json(
      paginated && u.searchParams.get('page') === '1'
        ? Array.from({ length: 100 }, (_, i) => ({ id: i + 1, oid: 'different' }))
        : [...store.values()].filter((r) => r.oid === u.searchParams.get('oid')),
    );
  }
  const r = store.get(u.pathname.split('/').at(-1)!.replace('.json', ''));
  if (!r) return json({}, 404);
  return json(
    mutateRead ? mutateRead(structuredClone(r)) : wrongTotal ? { ...r, price_gross: '1.00' } : r,
  );
};
const req = (url: string, method: any = 'GET', payload?: any, auth = cookie) =>
  app.inject({
    url: '/api' + url,
    method,
    payload,
    headers: { cookie: auth, ...(url === '/orders' ? { 'idempotency-key': randomUUID() } : {}) },
  });
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({ integrationTransport: transport });
  const login = async (email: string) =>
    (
      await app.inject({
        url: '/api/auth/login',
        method: 'POST',
        payload: { email, password: 'DynaDemo!2026' },
      })
    ).headers['set-cookie']!.toString().split(';')[0];
  cookie = await login('admin@demo.local');
  other = await login('other@demo.local');
  viewer = await login('viewer@demo.local');
  operator = await login('operator@demo.local');
  warehouse = (await req('/warehouses')).json().data[0].id;
});
after(async () => {
  await app.close();
  await pool.end();
});
beforeEach(async () => {
  calls.length = 0;
  store.clear();
  lostCreate = rejectedCreate = badPdf = wrongTotal = paginated = false;
  mutateRead = undefined;
  await pool.query("UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL");
});
async function fixture(mode = 'live') {
  const p = await req('/products', 'POST', {
    name: 'Pozycja z rabatem QA',
    sku: 'INV-' + randomUUID(),
    price: 12300,
    vat: 23,
    warehouse_id: warehouse,
    quantity: 10,
  });
  assert.equal(p.statusCode, 201, p.body);
  const created = await req('/orders', 'POST', {
    customer_name: 'Klient QA',
    email: 'invoice@example.test',
    warehouse_id: warehouse,
    items: [{ product_id: p.json().id, quantity: 2 }],
    address: { street: 'Testowa 1', city: 'Warszawa', postal_code: '00-001' },
    shipping_cost: 1499,
  });
  assert.equal(created.statusCode, 201, created.body);
  const id = created.json().id;
  assert.equal(
    (await req('/orders/' + id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => req(orderPath, 'GET', undefined), '/orders/' + id + '/status', { status: 'paid' }))).statusCode,
    200,
  );
  // Real historical gross line snapshot with an uneven discount; invoice must not recompute unit price.
  await tenantTx(DEMO_TENANT, async (c) => {
    await c.query('UPDATE order_items SET line_total=22001 WHERE order_id=$1', [id]);
    await c.query('UPDATE orders SET total=23500 WHERE id=$1', [id]);
  });
  const o = (await req('/orders/' + id)).json();
  const ch = randomUUID();
  await tenantTx(DEMO_TENANT, (c) =>
    c.query(
      'INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        ch,
        DEMO_TENANT,
        'fakturownia',
        'Konto QA',
        mode,
        encrypt({ api_token: 'fixture-token' }),
        JSON.stringify({ account_url: 'https://invoice-fixture.fakturownia.pl' }),
      ],
    ),
  );
  const b = {
    channel_id: ch,
    kind: 'invoice',
    seller: {
      name: 'Sprzedawca QA',
      tax_no: '5252445767',
      street: 'Sprzedażowa 1',
      city: 'Warszawa',
      postal_code: '00-001',
    },
    buyer: {
      name: 'Klient QA',
      tax_no: '',
      street: 'Testowa 1',
      city: 'Warszawa',
      postal_code: '00-001',
      email: 'invoice@example.test',
    },
    issue_date: '2026-10-04',
    sell_date: '2026-10-03',
    payment_to: '2026-10-10',
    payment_type: 'transfer',
    item_vat: o.items.map((i: any) => ({ item_id: i.id, vat: 8 })),
    shipping_vat: 8,
  };
  return { o, ch, b, product: p.json().id };
}
async function preview(f: any, auth = cookie) {
  const r = await req('/orders/' + f.o.id + '/invoicing/preview', 'POST', f.b, auth);
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}
async function queue(id: string, auth = cookie) {
  const r = await req(
    '/invoice-plans/' + id + '/queue',
    'POST',
    { confirm_external: true, confirm_data: true },
    auth,
  );
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}
async function plan(id: string) {
  return (
    await tenantTx(DEMO_TENANT, (c) => c.query('SELECT * FROM invoice_plans WHERE id=$1', [id]))
  ).rows[0];
}
async function run(id: string, lease = randomUUID()) {
  const p = await plan(id),
    job = (
      await pool.query(
        "UPDATE jobs SET state='running',attempts=attempts+1,locked_at=now(),lease_token=$2 WHERE id=$1 RETURNING *",
        [p.job_id, lease],
      )
    ).rows[0];
  try {
    await processInvoice(job, { transport });
  } catch (e) {
    await failInvoice(job, e);
  }
  return plan(id);
}
const posts = () => calls.filter((c) => c.method === 'POST').length;
test('faktura: rzeczywiste grosze po rabacie, oddzielny VAT dostawy, GET weryfikacji i lokalny PDF proxy', async () => {
  const f = await fixture(),
    p = await preview(f);
  assert.equal(p.payload.positions[0].total_price_gross, '220.01');
  assert.equal(p.payload.positions[0].quantity, 2);
  assert.equal(p.payload.positions[0].tax, 8);
  assert.equal(p.payload.positions[1].total_price_gross, '14.99');
  assert.equal(calls.length, 0);
  const q = await queue(p.id);
  assert.equal((await queue(p.id)).job_id, q.job_id);
  const done = await run(p.id);
  assert.equal(done.state, 'done');
  assert.equal(posts(), 1);
  assert.equal(done.result.scope, 'external_api_verified');
  const doc = (await req('/orders/' + f.o.id))
    .json()
    .documents.find((d: any) => d.id === done.document_id);
  assert.equal(doc.data.total, 23500);
  assert.equal(doc.mode, 'external');
  assert.equal(JSON.stringify(doc).includes('private-document-token'), false);
  const pdf = await req('/documents/' + doc.id + '/print');
  assert.equal(pdf.statusCode, 200, pdf.body);
  assert.equal(pdf.headers['content-type'], 'application/pdf');
  assert.equal(pdf.headers['cache-control'], 'no-store');
  assert.ok(pdf.body.startsWith('%PDF-'));
  assert.equal(posts(), 1);
  const stock = (await req('/inventory?product_id=' + f.product))
    .json()
    .data.find((s: any) => s.product_id === f.product);
  assert.equal(stock.on_hand, 10);
  assert.equal(stock.reserved, 2);
});
test('zerwana odpowiedź POST: trwała faza, odzyskanie OID i paginacja, bez drugiej faktury', async () => {
  const p = await preview(await fixture());
  await queue(p.id);
  lostCreate = true;
  assert.equal((await run(p.id)).phase, 'create_started');
  assert.equal(posts(), 1);
  paginated = true;
  assert.equal((await run(p.id)).state, 'done');
  assert.equal(posts(), 1);
  assert.ok(calls.some((c) => new URL(c.url).searchParams.get('page') === '2'));
});
test('niepewny POST bez dokumentu w API blokuje nowy plan, anulowanie i drugi POST; jawne uzgodnienie tylko czyta', async () => {
  const f = await fixture(),
    p = await preview(f);
  await queue(p.id);
  rejectedCreate = true;
  await run(p.id);
  const failed = await run(p.id);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.phase, 'create_started');
  assert.equal(posts(), 1);
  assert.equal(JSON.stringify(failed).includes('fixture-token'), false);
  assert.equal((await req('/invoice-plans/' + p.id + '/cancel', 'POST')).statusCode, 409);
  const p2 = await preview(f);
  assert.equal(
    (
      await req('/invoice-plans/' + p2.id + '/queue', 'POST', {
        confirm_external: true,
        confirm_data: true,
      })
    ).statusCode,
    409,
  );
  assert.equal((await req('/invoice-plans/' + p.id + '/reconcile', 'POST')).statusCode, 200);
  await run(p.id);
  assert.equal(posts(), 1);
});
test('zmiana kwoty po POST nie udaje poprawnej faktury; odczyty nie ponawiają zapisu', async () => {
  const p = await preview(await fixture());
  await queue(p.id);
  wrongTotal = true;
  const failed = await run(p.id);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.phase, 'created');
  assert.equal(failed.document_id, null);
  assert.equal(posts(), 1);
  await req('/invoice-plans/' + p.id + '/reconcile', 'POST');
  await run(p.id);
  assert.equal(posts(), 1);
});
test('VAT, pozycje, NIP, daty, PL/PLN i suma zamówienia są weryfikowane przed API', async () => {
  const f = await fixture();
  for (const patch of [
    { seller: { ...f.b.seller, tax_no: '5252445768' } },
    { issue_date: '2026-02-30' },
    { payment_to: '2026-01-01' },
    { item_vat: [] },
    { item_vat: [{ item_id: randomUUID(), vat: 8 }] },
    { item_vat: [{ item_id: f.o.items[0].id, vat: 22 }] },
  ])
    assert.equal(
      (await req('/orders/' + f.o.id + '/invoicing/preview', 'POST', { ...f.b, ...patch }))
        .statusCode,
      422,
    );
  await pool.query("UPDATE orders SET currency='EUR' WHERE id=$1", [f.o.id]);
  assert.equal(
    (await req('/orders/' + f.o.id + '/invoicing/preview', 'POST', f.b)).statusCode,
    422,
  );
  await pool.query("UPDATE orders SET currency='PLN',total=1 WHERE id=$1", [f.o.id]);
  assert.equal(
    (await req('/orders/' + f.o.id + '/invoicing/preview', 'POST', f.b)).statusCode,
    409,
  );
  assert.equal(calls.length, 0);
});
test('oddzielne potwierdzenia danych i zapisu zewnętrznego również dla sandbox konta Fakturowni', async () => {
  const p = await preview(await fixture('sandbox'));
  assert.equal(
    (await req('/invoice-plans/' + p.id + '/queue', 'POST', { confirm_external: true })).statusCode,
    422,
  );
  assert.equal(
    (await req('/invoice-plans/' + p.id + '/queue', 'POST', { confirm_data: true })).statusCode,
    422,
  );
  assert.equal(calls.length, 0);
});
test('dwa zatwierdzenia różnych podglądów konkurują o jeden dokument, a snapshot zmiany nie przechodzi', async () => {
  const f = await fixture(),
    p = await preview(f),
    p2 = await preview(f);
  const results = await Promise.all(
    [p, p2].map((p) =>
      req('/invoice-plans/' + p.id + '/queue', 'POST', {
        confirm_data: true,
        confirm_external: true,
      }),
    ),
  );
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
  const f2 = await fixture(),
    stale = await preview(f2);
  await pool.query('UPDATE orders SET shipping_cost=1500,total=23501 WHERE id=$1', [f2.o.id]);
  assert.equal(
    (
      await req('/invoice-plans/' + stale.id + '/queue', 'POST', {
        confirm_data: true,
        confirm_external: true,
      })
    ).statusCode,
    409,
  );
});
test('pełna korekta używa pierwotnych kwot i VAT oraz dokładnego before/after, nie porusza zapasów', async () => {
  const f = await fixture(),
    p = await preview(f);
  await queue(p.id);
  const invoice = await run(p.id);
  await pool.query("UPDATE orders SET status='return_received' WHERE id=$1", [f.o.id]);
  const wrong = {
    ...f,
    b: {
      ...f.b,
      kind: 'correction',
      correction_reason: 'Zwrot QA',
      buyer: { ...f.b.buyer, name: 'Inny nabywca' },
    },
  };
  assert.equal(
    (await req('/orders/' + f.o.id + '/invoicing/preview', 'POST', wrong.b)).statusCode,
    409,
  );
  f.b = { ...f.b, kind: 'correction', correction_reason: 'Zwrot QA' } as any;
  const p2 = await preview(f);
  assert.equal(p2.payload.from_invoice_id, invoice.remote_id);
  assert.equal(p2.payload.positions[0].quantity, -2);
  assert.equal(p2.payload.positions[0].total_price_gross, '-220.01');
  assert.equal(p2.payload.positions[0].correction_after_attributes.quantity, 0);
  await queue(p2.id);
  const corrected = await run(p2.id);
  assert.equal(corrected.state, 'done');
  assert.equal(posts(), 2);
  const doc = (await req('/orders/' + f.o.id))
    .json()
    .documents.find((d: any) => d.id === corrected.document_id);
  assert.equal(doc.data.total, -23500);
  assert.equal(doc.data.original.id, invoice.document_id);
});
test('korekta wymaga przyjętego zwrotu oraz istniejącej faktury na tym samym koncie', async () => {
  const f = await fixture();
  f.b = { ...f.b, kind: 'correction' } as any;
  assert.equal(
    (await req('/orders/' + f.o.id + '/invoicing/preview', 'POST', f.b)).statusCode,
    409,
  );
  await pool.query("UPDATE orders SET status='return_received' WHERE id=$1", [f.o.id]);
  assert.equal(
    (await req('/orders/' + f.o.id + '/invoicing/preview', 'POST', f.b)).statusCode,
    409,
  );
});
test('RLS i role chronią podgląd, plan, PDF oraz odczyt statusu; tylko autor zatwierdza', async () => {
  const f = await fixture(),
    p = await preview(f);
  assert.equal(
    (await req('/orders/' + f.o.id + '/invoicing', 'GET', undefined, other)).statusCode,
    404,
  );
  assert.equal(
    (
      await req(
        '/invoice-plans/' + p.id + '/queue',
        'POST',
        { confirm_data: true, confirm_external: true },
        viewer,
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await req(
        '/invoice-plans/' + p.id + '/queue',
        'POST',
        { confirm_data: true, confirm_external: true },
        operator,
      )
    ).statusCode,
    403,
  );
  await queue(p.id);
  const done = await run(p.id);
  assert.equal(
    (await req('/documents/' + done.document_id + '/print', 'GET', undefined, other)).statusCode,
    404,
  );
  assert.equal(
    (await req('/documents/' + done.document_id + '/provider-status', 'POST', {}, viewer))
      .statusCode,
    403,
  );
});
test('DEMO dokumenty i symulacja konektora współistnieją; worker nie łączy się z dostawcą', async () => {
  const f = await fixture();
  f.b.channel_id = (await req('/invoicing/example', 'POST')).json().id;
  assert.equal(
    (await req('/orders/' + f.o.id + '/documents', 'POST', { kind: 'invoice' })).statusCode,
    200,
  );
  const p = await preview(f);
  const q = await req('/invoice-plans/' + p.id + '/queue', 'POST', { confirm_data: true });
  assert.equal(q.statusCode, 200, q.body);
  for (let n = 0; n < 10 && (await plan(p.id)).state !== 'done'; n++) await tick({ transport });
  const done = await plan(p.id);
  assert.equal(done.state, 'done');
  assert.equal(done.result.scope, 'local_simulation');
  assert.equal(calls.length, 0);
  const docs = (await req('/orders/' + f.o.id)).json().documents;
  assert.deepEqual(docs.map((d: any) => d.mode).sort(), ['demo', 'simulation']);
  assert.ok((await req('/documents/' + done.document_id + '/print')).body.includes('DEMO'));
  const live = await preview({ ...f, b: { ...f.b, channel_id: f.ch } });
  await queue(live.id);
  assert.equal((await run(live.id)).state, 'done');
});
test('odczyt KSeF odzwierciedla API, nie wysyła do KSeF i nie ujawnia tokenu dokumentu', async () => {
  const p = await preview(await fixture());
  await queue(p.id);
  const done = await run(p.id);
  const r = store.get(done.remote_id);
  r.gov_status = 'processing';
  r.gov_id = null;
  const status = await req('/documents/' + done.document_id + '/provider-status', 'POST');
  assert.equal(status.statusCode, 200, status.body);
  assert.equal(status.json().gov_status, 'processing');
  assert.equal(status.json().gov_id, null);
  assert.equal(posts(), 1);
  assert.equal(status.body.includes('private-document-token'), false);
  r.gov_status = 'ok';
  r.gov_id = 'FIXTURE-KSEF';
  const status2 = await req('/documents/' + done.document_id + '/provider-status', 'POST');
  assert.equal(status2.json().gov_id, 'FIXTURE-KSEF');
  assert.equal(posts(), 1);
});
test('HTML pod nazwą PDF jest odrzucany i nie zmienia dokumentu', async () => {
  const p = await preview(await fixture());
  await queue(p.id);
  const done = await run(p.id);
  badPdf = true;
  assert.equal((await req('/documents/' + done.document_id + '/print')).statusCode, 502);
  assert.equal((await plan(p.id)).state, 'done');
});
test('nieaktualna dzierżawa oraz cofnięcie roli zatrzymują API; plan bez wysłanego POST można anulować', async () => {
  const f = await fixture(),
    p = await preview(f, operator);
  await queue(p.id, operator);
  const job = (
    await pool.query(
      "UPDATE jobs SET state='running',lease_token=$2,attempts=1 WHERE id=$1 RETURNING *",
      [(await plan(p.id)).job_id, randomUUID()],
    )
  ).rows[0];
  await processInvoice({ ...job, lease_token: randomUUID() }, { transport });
  assert.equal(calls.length, 0);
  const actorId = job.payload.actor_id;
  await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
    DEMO_TENANT,
    actorId,
  ]);
  try {
    const failed = await run(p.id);
    assert.equal(failed.state, 'failed');
    assert.equal(failed.phase, 'ready');
    assert.equal(calls.length, 0);
  } finally {
    await pool.query("UPDATE memberships SET role='operator' WHERE tenant_id=$1 AND user_id=$2", [
      DEMO_TENANT,
      actorId,
    ]);
  }
  assert.equal(
    (await req('/invoice-plans/' + p.id + '/cancel', 'POST', {}, operator)).statusCode,
    200,
  );
});
test('anulowanie zamówienia z fakturą lub niepewnym zapisem nie omija procesu korekty', async () => {
  const f = await fixture(),
    p = await preview(f);
  await queue(p.id);
  assert.equal(
    (await req('/orders/' + f.o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => req(orderPath, 'GET', undefined), '/orders/' + f.o.id + '/status', { status: 'cancelled' }))).statusCode,
    409,
  );
  await run(p.id);
  assert.equal(
    (await req('/orders/' + f.o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => req(orderPath, 'GET', undefined), '/orders/' + f.o.id + '/status', { status: 'cancelled' }))).statusCode,
    409,
  );
});
test('konwersja kwot nie akceptuje zaokrągleń ani danych nienumerycznych; suma kontrolna NIP', () => {
  assert.equal(invoiceMinor('0.01'), 1);
  assert.equal(invoiceMinor('-220.01'), -22001);
  assert.equal(invoiceMinor(12.99), 1299);
  for (const v of ['1.234', '', null, 'NaN', '1e3']) assert.throws(() => invoiceMinor(v));
  assert.equal(nip.safeParse('5252445767').success, true);
  assert.equal(nip.safeParse('5252445768').success, false);
});
test('odczyt po utworzeniu musi zwrócić zapisane ID, nie wystarcza identyczny OID i kwota', async () => {
  const p = await preview(await fixture());
  await queue(p.id);
  mutateRead = (r) => ({ ...r, id: r.id + 1000 });
  const failed = await run(p.id);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.document_id, null);
  assert.equal(failed.phase, 'created');
  assert.equal(posts(), 1);
  mutateRead = undefined;
  await req('/invoice-plans/' + p.id + '/reconcile', 'POST');
  assert.equal((await run(p.id)).state, 'done');
  assert.equal(posts(), 1);
});
test('niezależna zmiana VAT, ilości lub pozycji przy zachowaniu sumy nie jest przyjmowana', async () => {
  for (const key of ['tax', 'quantity', 'name']) {
    const p = await preview(await fixture());
    await queue(p.id);
    mutateRead = (r) => {
      r.positions[0][key] = key === 'name' ? 'Inny towar' : key === 'tax' ? 23 : 3;
      return r;
    };
    const failed = await run(p.id);
    assert.equal(failed.state, 'failed');
    assert.equal(failed.document_id, null);
  }
  assert.equal(posts(), 3);
});
test('duplikaty OID w historii nie są arbitralnie wybierane i nie powodują POST', async () => {
  const p = await preview(await fixture());
  await queue(p.id);
  store.set('1', { id: 1, oid: p.payload.oid });
  store.set('2', { id: 2, oid: p.payload.oid });
  const failed = await run(p.id);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.phase, 'ready');
  assert.equal(posts(), 0);
});
test('dzierżawa po ostatniej próbie jest oznaczona jako błąd i wymaga uzgodnienia', async () => {
  const p = await preview(await fixture());
  await queue(p.id);
  await pool.query(
    "UPDATE jobs SET state='running',attempts=max_attempts,locked_at=now()-interval '3 minutes',lease_token=$2 WHERE id=$1",
    [(await plan(p.id)).job_id, randomUUID()],
  );
  await tick({ transport });
  const failed = await plan(p.id);
  assert.equal(failed.state, 'failed');
  assert.equal(calls.length, 0);
});

async function partialFixture() {
  const f = await fixture(),
    p = await preview(f);
  await queue(p.id);
  const invoice = await run(p.id);
  assert.equal(invoice.state, 'done');
  for (const status of ['picking'])
    assert.equal((await req('/orders/' + f.o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => req(orderPath, 'GET', undefined), '/orders/' + f.o.id + '/status', { status }))).statusCode, 200);
  for (let n = 0; n < 2; n++)
    assert.equal(
      (await req('/orders/' + f.o.id + '/scan', 'POST', { code: f.o.items[0].sku })).statusCode,
      200,
    );
  assert.equal(
    (await req('/orders/' + f.o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => req(orderPath, 'GET', undefined), '/orders/' + f.o.id + '/status', { status: 'packed' }))).statusCode,
    200,
  );
  assert.equal((await req('/orders/' + f.o.id + '/ship-demo', 'POST')).statusCode, 200);
  return { f, invoice };
}
async function acceptPartial(f: any, shipping = 0) {
  const request = await req('/orders/' + f.o.id + '/returns', 'POST', {
    client_key: randomUUID(),
    kind: 'return',
    reason: 'QA częściowy zwrot',
    shipping_refund: shipping,
    items: [{ item_id: f.o.items[0].id, quantity: 1 }],
  });
  assert.equal(request.statusCode, 201, request.body);
  const r = request.json();
  const received = await req('/returns/' + r.id + '/receive', 'POST', {
    version: Number(r.version),
    note: 'QA przyjęcie',
    shipping_refund: shipping,
    items: [{ item_id: f.o.items[0].id, accepted: 1, restocked: 1 }],
  });
  assert.equal(received.statusCode, 200, received.body);
  return received.json();
}
async function partialPreview(f: any, r: any) {
  const response = await req('/orders/' + f.o.id + '/invoicing/preview', 'POST', {
    ...f.b,
    kind: 'correction',
    return_id: r.id,
    correction_reason: 'Częściowy zwrot QA',
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}
test('dwie częściowe korekty zachowują grosz rabatu, kolejność przed/po, osobne OID i limit dostawy', async () => {
  const { f, invoice } = await partialFixture(),
    a = await acceptPartial(f),
    p = await partialPreview(f, a);
  assert.equal(p.payload.positions.length, 1);
  assert.equal(p.payload.positions[0].quantity, -1);
  assert.equal(p.payload.positions[0].total_price_gross, '-110.00');
  assert.equal(p.payload.positions[0].correction_before_attributes.quantity, 2);
  assert.equal(p.payload.positions[0].correction_after_attributes.quantity, 1);
  assert.equal(p.payload.positions[0].correction_after_attributes.total_price_gross, '110.01');
  await queue(p.id);
  const first = await run(p.id);
  assert.equal(first.state, 'done');
  const b = await acceptPartial(f, 1499),
    q = await partialPreview(f, b);
  assert.notEqual(q.payload.oid, p.payload.oid);
  assert.equal(q.payload.from_invoice_id, invoice.remote_id);
  assert.equal(q.payload.positions[0].total_price_gross, '-110.01');
  assert.equal(q.payload.positions[0].correction_before_attributes.quantity, 1);
  assert.equal(q.payload.positions[0].correction_before_attributes.total_price_gross, '110.01');
  assert.equal(q.payload.positions[0].correction_after_attributes.quantity, 0);
  assert.equal(q.payload.positions[0].correction_after_attributes.total_price_gross, '0.00');
  assert.equal(q.payload.positions[1].total_price_gross, '-14.99');
  await queue(q.id);
  const second = await run(q.id);
  assert.equal(second.state, 'done');
  const docs = (await req('/orders/' + f.o.id)).json().documents.filter((d: any) => d.return_id);
  assert.equal(docs.length, 2);
  assert.equal(
    docs.reduce((n: number, d: any) => n + d.data.total, 0),
    -23500,
  );
  assert.deepEqual(
    docs.map((d: any) => d.data.items[0].quantity),
    [1, 1],
  );
  assert.equal(posts(), 3);
});
test('utrata odpowiedzi częściowej korekty blokuje następną i uzgadnia zapis bez drugiego POST', async () => {
  const { f } = await partialFixture(),
    a = await acceptPartial(f),
    p = await partialPreview(f, a);
  await queue(p.id);
  lostCreate = true;
  const uncertain = await run(p.id);
  assert.equal(uncertain.state, 'queued');
  assert.equal(uncertain.phase, 'create_started');
  const b = await acceptPartial(f);
  assert.equal(
    (
      await req('/orders/' + f.o.id + '/invoicing/preview', 'POST', {
        ...f.b,
        kind: 'correction',
        return_id: b.id,
      })
    ).statusCode,
    409,
  );
  assert.equal(posts(), 2);
  assert.equal((await run(p.id)).state, 'done');
  assert.equal(posts(), 2);
  const next = await partialPreview(f, b);
  await queue(next.id);
  assert.equal((await run(next.id)).state, 'done');
  assert.equal(posts(), 3);
});
test('druga sprawa nie może ominąć kolejności, a pełna korekta nie może nadpisać częściowych', async () => {
  const { f } = await partialFixture(),
    a = await acceptPartial(f),
    b = await acceptPartial(f);
  assert.equal(
    (
      await req('/orders/' + f.o.id + '/invoicing/preview', 'POST', {
        ...f.b,
        kind: 'correction',
        return_id: b.id,
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (await req('/orders/' + f.o.id + '/invoicing/preview', 'POST', { ...f.b, kind: 'correction' }))
      .statusCode,
    409,
  );
  const p = await partialPreview(f, a),
    duplicate = await partialPreview(f, a);
  await queue(p.id);
  assert.equal(
    (
      await req('/invoice-plans/' + duplicate.id + '/queue', 'POST', {
        confirm_data: true,
        confirm_external: true,
      })
    ).statusCode,
    409,
  );
  assert.equal((await run(p.id)).state, 'done');
  assert.equal(
    (
      await req('/invoice-plans/' + duplicate.id + '/queue', 'POST', {
        confirm_data: true,
        confirm_external: true,
      })
    ).statusCode,
    409,
  );
});
test('Fakturownia odrzuca zmienione przed/po częściowej korekty zamiast potwierdzić dokument', async () => {
  const { f } = await partialFixture(),
    a = await acceptPartial(f),
    p = await partialPreview(f, a);
  await queue(p.id);
  mutateRead = (r) => {
    if (r.kind === 'correction')
      r.positions[0].correction_after_attributes.total_price_gross = '0.00';
    return r;
  };
  const failed = await run(p.id);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.document_id, null);
  mutateRead = undefined;
  assert.equal((await req('/invoice-plans/' + p.id + '/reconcile', 'POST')).statusCode, 200);
  assert.equal((await run(p.id)).state, 'done');
  assert.equal(posts(), 2);
});
