import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed, DEMO_TENANT, SECOND_TENANT } from './fixtures';
import { encrypt } from '../server/security';
import { processOdooExport, failOdooExport } from '../server/odoo-exports';
import { accountingFixture, odooSettings, odooCredentials } from './odoo-accounting-fixture';
assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  other: string,
  viewer: string,
  operator: string,
  warehouse: string,
  f = accountingFixture();
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
  app = await buildApp({ integrationTransport: (u, i) => f.transport(u, i) });
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
  f = accountingFixture();
  await pool.query("UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL");
});
async function fixture(simulation = false) {
  const prod = await req('/products', 'POST', {
    name: 'Invoice QA',
    sku: 'ODINV-' + randomUUID(),
    price: 12300,
    vat: 23,
    warehouse_id: warehouse,
    quantity: 10,
  });
  assert.equal(prod.statusCode, 201, prod.body);
  let r = await req('/orders', 'POST', {
    customer_name: 'Klient QA',
    email: 'invoice@example.test',
    warehouse_id: warehouse,
    items: [{ product_id: prod.json().id, quantity: 2 }],
    address: { street: 'Testowa 1', city: 'Warszawa', postal_code: '00-001', country: 'PL' },
    shipping_cost: 1499,
  });
  assert.equal(r.statusCode, 201, r.body);
  const order = r.json().id;
  await tenantTx(DEMO_TENANT, async (c) => {
    await c.query('UPDATE order_items SET line_total=22001 WHERE order_id=$1', [order]);
    await c.query('UPDATE orders SET total=23500 WHERE id=$1', [order]);
  });
  assert.equal((await req(`/orders/${order}/status`, 'PATCH', await legacySerialOrderStatusPayload((orderPath) => req(orderPath, 'GET', undefined), `/orders/${order}/status`, { status: 'paid' }))).statusCode, 200);
  r = await req(`/orders/${order}/documents`, 'POST', { kind: 'invoice' });
  assert.equal(r.statusCode, 200, r.body);
  const document = r.json();
  const ch = randomUUID();
  await tenantTx(DEMO_TENANT, (c) =>
    c.query(
      "INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings) VALUES($1,$2,'odoo','QA Odoo','live',$3,$4)",
      [
        ch,
        DEMO_TENANT,
        encrypt(odooCredentials),
        JSON.stringify({ ...odooSettings, ...(simulation ? { simulation: 'true' } : {}) }),
      ],
    ),
  );
  const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw' }).format(
    new Date(document.created_at),
  );
  const body = {
    client_key: randomUUID(),
    channel_id: ch,
    partner_id: 1,
    journal_id: 1,
    account_id: 1,
    invoice_date: day,
    due_date: day,
    shipping_vat: 23,
    taxes: [{ vat: 23, tax_id: 24 }],
  };
  return { order, document: document.id, ch, body, product: prod.json().id };
}
async function preview(x: any) {
  const r = await req(`/documents/${x.document}/odoo-export/preview`, 'POST', x.body);
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}
async function queue(p: any) {
  const r = await req(`/odoo-invoice-exports/${p.id}/queue`, 'POST', {
    confirm_data: true,
    confirm_post: true,
  });
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}
async function plan(id: string) {
  return (
    await tenantTx(DEMO_TENANT, (c) =>
      c.query('SELECT * FROM odoo_invoice_exports WHERE id=$1', [id]),
    )
  ).rows[0];
}
async function run(id: string) {
  const p = await plan(id),
    j = (
      await pool.query(
        "UPDATE jobs SET state='running',attempts=attempts+1,locked_at=now(),lease_token=$2 WHERE id=$1 RETURNING *",
        [p.job_id, randomUUID()],
      )
    ).rows[0];
  try {
    await processOdooExport(j, { transport: f.transport });
  } catch (e) {
    await failOdooExport(j, e);
  }
  return plan(id);
}
const writes = () => f.calls.filter((c) => ['create', 'action_post'].includes(c.method));
test('API preview → one draft/create → one post → verified; source, stock and payment ledger remain unchanged', async () => {
  const x = await fixture(),
    before = (
      await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [x.product])
    ).rows,
    paymentBefore = (
      await pool.query(
        'SELECT to_jsonb(p) row FROM payment_entries p WHERE order_id=$1 ORDER BY id',
        [x.order],
      )
    ).rows,
    p = await preview(x);
  assert.equal(writes().length, 0);
  assert.equal(
    (await req(`/odoo-invoice-exports/${p.id}/queue`, 'POST', { confirm_data: true })).statusCode,
    422,
  );
  await queue(p);
  const result = await run(p.id);
  assert.equal(result.state, 'done', result.error);
  assert.equal(result.phase, 'verified');
  assert.equal(result.result.total, 23500);
  assert.equal(result.result.scope, 'external_api_verified');
  assert.equal(writes().length, 2);
  assert.deepEqual(
    (await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [x.product])).rows,
    before,
  );
  assert.deepEqual(
    (
      await pool.query(
        'SELECT to_jsonb(p) row FROM payment_entries p WHERE order_id=$1 ORDER BY id',
        [x.order],
      )
    ).rows,
    paymentBefore,
  );
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM documents WHERE order_id=$1', [x.order])).rows[0]
      .n,
    1,
  );
  assert.equal(
    (await req(`/orders/${x.order}/status`, 'PATCH', await legacySerialOrderStatusPayload((orderPath) => req(orderPath, 'GET', undefined), `/orders/${x.order}/status`, { status: 'cancelled' }))).statusCode,
    409,
  );
  const history = (await req(`/orders/${x.order}/odoo-invoices`)).json();
  assert.equal(history.data[0].can_control, true);
  assert.equal(history.data[0].result.number, result.result.number);
  await queue(p);
  assert.equal(writes().length, 2);
});
test('lost create response reconciles by stable reference, never duplicates provider invoice', async () => {
  const x = await fixture(),
    p = await preview(x);
  await queue(p);
  f.state.loseCreate = true;
  let r = await run(p.id);
  assert.equal(r.phase, 'create_started');
  assert.equal(r.remote_id, null);
  assert(!r.error.includes('secret'));
  r = await run(p.id);
  assert.equal(r.state, 'done', r.error);
  assert.equal(f.moves.size, 1);
  assert.equal(writes().filter((c) => c.method === 'create').length, 1);
  assert.equal(writes().filter((c) => c.method === 'action_post').length, 1);
});
test('unknown create without observable invoice blocks a second create and cancellation', async () => {
  const x = await fixture(),
    p = await preview(x);
  await queue(p);
  f.state.rejectCreate = true;
  assert.equal((await run(p.id)).phase, 'create_started');
  const r = await run(p.id);
  assert.equal(r.state, 'failed');
  assert.equal(writes().length, 1);
  assert.equal((await req(`/odoo-invoice-exports/${p.id}/cancel`, 'POST', {})).statusCode, 409);
  assert.equal((await req(`/odoo-invoice-exports/${p.id}/reconcile`, 'POST', {})).statusCode, 200);
  await run(p.id);
  assert.equal(writes().length, 1);
});
test('lost post response observes posted invoice and does not post twice', async () => {
  const x = await fixture(),
    p = await preview(x);
  await queue(p);
  f.state.losePost = true;
  assert.equal((await run(p.id)).phase, 'post_started');
  const r = await run(p.id);
  assert.equal(r.state, 'done', r.error);
  assert.equal(writes().filter((c) => c.method === 'action_post').length, 1);
});
test('unknown post still in draft blocks second post and source order cancellation', async () => {
  const x = await fixture(),
    p = await preview(x);
  await queue(p);
  f.state.rejectPost = true;
  await run(p.id);
  const r = await run(p.id);
  assert.equal(r.phase, 'post_started');
  assert.equal(r.state, 'failed');
  assert.equal(writes().length, 2);
  assert.equal(
    (await req(`/orders/${x.order}/status`, 'PATCH', await legacySerialOrderStatusPayload((orderPath) => req(orderPath, 'GET', undefined), `/orders/${x.order}/status`, { status: 'cancelled' }))).statusCode,
    409,
  );
});
test('provider amount mismatch prevents posting a created draft', async () => {
  const x = await fixture(),
    p = await preview(x);
  await queue(p);
  f.state.badGross = true;
  const r = await run(p.id);
  assert.equal(r.state, 'failed');
  assert.equal(r.phase, 'draft_saved');
  assert.equal(writes().length, 1);
});
test('ERP tax change after preview prevents any mutation', async () => {
  const x = await fixture(),
    p = await preview(x);
  await queue(p);
  f.models['account.tax'][0].write_date = '2026-10-05 00:00:00';
  const r = await run(p.id);
  assert.equal(r.state, 'failed');
  assert.equal(writes().length, 0);
});
test('tenant isolation, viewer permissions and author controls on preview, queue and history', async () => {
  const x = await fixture();
  assert.equal(
    (await req(`/documents/${x.document}/odoo-export/preview`, 'POST', x.body, other)).statusCode,
    404,
  );
  assert.equal(
    (await req(`/documents/${x.document}/odoo-export/preview`, 'POST', x.body, viewer)).statusCode,
    403,
  );
  const p = await preview(x);
  assert.equal(
    (
      await req(
        `/odoo-invoice-exports/${p.id}/queue`,
        'POST',
        { confirm_data: true, confirm_post: true },
        operator,
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (await req(`/orders/${x.order}/odoo-invoices`, 'GET', undefined, other)).statusCode,
    404,
  );
  assert.equal(
    (
      await tenantTx(SECOND_TENANT, (c) =>
        c.query('SELECT * FROM odoo_invoice_exports WHERE id=$1', [p.id]),
      )
    ).rowCount,
    0,
  );
  const ch = (await req('/odoo-invoicing/channels')).json().data.find((c: any) => c.id === x.ch);
  assert.equal(ch.credentials, undefined);
});
test('source/config changes and preview expiry require new approval', async () => {
  for (const what of ['source', 'connection', 'expiry']) {
    const x = await fixture(),
      p = await preview(x);
    await tenantTx(DEMO_TENANT, (c) =>
      what === 'source'
        ? c.query(
            "UPDATE documents SET data=jsonb_set(data,'{items,0,name}','\"Changed\"') WHERE id=$1",
            [x.document],
          )
        : what === 'connection'
          ? c.query(
              'UPDATE channels SET settings=settings||\'{"database":"changed"}\' WHERE id=$1',
              [x.ch],
            )
          : c.query(
              "UPDATE odoo_invoice_exports SET created_at=now()-interval '31 minutes' WHERE id=$1",
              [p.id],
            ),
    );
    assert.equal(
      (
        await req(`/odoo-invoice-exports/${p.id}/queue`, 'POST', {
          confirm_data: true,
          confirm_post: true,
        })
      ).statusCode,
      409,
    );
    assert.equal(writes().length, 0);
  }
});
test('role revocation while reading prevents the next provider call and write', async () => {
  const x = await fixture(),
    p = await preview(x);
  await queue(p);
  const author = p.actor_id;
  f.calls.length = 0;
  let changed = false;
  f.state.hook = async () => {
    if (!changed) {
      changed = true;
      await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
        DEMO_TENANT,
        author,
      ]);
    }
  };
  try {
    const r = await run(p.id);
    assert.equal(r.state, 'failed');
    assert.equal(f.calls.length, 1);
    assert.equal(writes().length, 0);
  } finally {
    await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
      DEMO_TENANT,
      author,
    ]);
  }
});
test('credential rotation while previewing stops further requests', async () => {
  const x = await fixture();
  f.calls.length = 0;
  let changed = false;
  f.state.hook = async () => {
    if (!changed) {
      changed = true;
      await tenantTx(DEMO_TENANT, (c) =>
        c.query('UPDATE channels SET credentials=$2 WHERE id=$1', [
          x.ch,
          encrypt({ api_key: 'rotated_' + randomUUID() }),
        ]),
      );
    }
  };
  const r = await req(`/documents/${x.document}/odoo-export/preview`, 'POST', x.body);
  assert.equal(r.statusCode, 409);
  assert.equal(f.calls.length, 1);
  assert.equal(writes().length, 0);
});
test('lease loss after create response fences persistence and posting; recovery locates the remote draft', async () => {
  const x = await fixture(),
    p = await preview(x);
  const q = await queue(p);
  let lost = false;
  f.state.hook = async (c) => {
    if (c.method === 'create' && !lost) {
      lost = true;
      await pool.query("UPDATE jobs SET lease_token=NULL,state='pending' WHERE id=$1", [q.job_id]);
    }
  };
  let r = await run(p.id);
  assert.equal(r.phase, 'create_started');
  assert.equal(r.remote_id, null);
  assert.equal(writes().length, 1);
  r = await run(p.id);
  assert.equal(r.state, 'done', r.error);
  assert.equal(writes().length, 2);
});
test('one active export per document even with two previews/concurrent approval', async () => {
  const x = await fixture(),
    p = await preview(x);
  assert.equal((await preview(x)).id, p.id);
  const p2 = await preview({ ...x, body: { ...x.body, client_key: randomUUID() } });
  const r = await Promise.all([
    req(`/odoo-invoice-exports/${p.id}/queue`, 'POST', { confirm_data: true, confirm_post: true }),
    req(`/odoo-invoice-exports/${p2.id}/queue`, 'POST', { confirm_data: true, confirm_post: true }),
  ]);
  assert.deepEqual(r.map((r) => r.statusCode).sort(), [200, 409]);
});
test('simulation performs full local export with zero provider calls and honest DEMO scope', async () => {
  const x = await fixture(true),
    p = await preview(x);
  await queue(p);
  const r = await run(p.id);
  assert.equal(r.state, 'done', r.error);
  assert.equal(r.result.scope, 'local_simulation');
  assert.match(r.result.number, /^DEMO-ODOO/);
  assert.equal(f.calls.length, 0);
});
test('two ERP invoices with same stable reference block reconciliation and a third create', async () => {
  const x = await fixture(),
    p = await preview(x);
  await queue(p);
  f.state.loseCreate = true;
  await run(p.id);
  const existing = [...f.moves.values()][0];
  f.moves.set(existing.id + 1000, { ...existing, id: existing.id + 1000 });
  const r = await run(p.id);
  assert.equal(r.state, 'failed');
  assert.match(r.error, /więcej niż jeden/);
  assert.equal(writes().length, 1);
});
test('ERP metadata change after saving draft blocks accounting post', async () => {
  const x = await fixture(),
    p = await preview(x);
  await queue(p);
  f.state.hook = async (c) => {
    if (c.method === 'create') f.models['account.account'][0].write_date = '2026-10-05 00:00:00';
  };
  const r = await run(p.id);
  assert.equal(r.state, 'failed');
  assert.equal(r.phase, 'draft_saved');
  assert.equal(writes().length, 1);
});
