import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool, migrate, tenantTx } from '../server/db';
import { buildApp } from '../server/app';
import { seed, DEMO_TENANT, SECOND_TENANT } from './fixtures';
import { encrypt } from '../server/security';
import { processIntegrationJob } from '../server/sync';
import { odooOrderFixture, odooSettings, odooCredentials } from './odoo-order-fixture';
assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  other: string,
  viewer: string,
  warehouse: string,
  f = odooOrderFixture();
const req = (p: string, method: any = 'GET', payload?: any, auth = cookie) =>
  app.inject({ url: '/api' + p, method, payload, headers: { cookie: auth } });
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
  warehouse = (await req('/warehouses')).json().data[0].id;
});
after(async () => {
  await app.close();
  await pool.end();
});
beforeEach(async () => {
  f = odooOrderFixture();
  await pool.query("UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL");
});
async function fixture(quantity = 100, simulation = false) {
  const p = await req('/products', 'POST', {
    name: 'Local ERP product',
    sku: 'ODSO-' + randomUUID().slice(0, 8),
    warehouse_id: warehouse,
    quantity,
    price: 9999,
    vat: 23,
  });
  assert.equal(p.statusCode, 201, p.body);
  let ch: string;
  if (simulation) ch = (await req('/integrations/odoo-example', 'POST', {})).json().channel_id;
  else {
    ch = randomUUID();
    await tenantTx(DEMO_TENANT, (c) =>
      c.query(
        "INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings) VALUES($1,$2,'odoo','QA orders ERP','live',$3,$4)",
        [ch, DEMO_TENANT, encrypt(odooCredentials), JSON.stringify(odooSettings)],
      ),
    );
  }
  const link = await req(`/integrations/${ch}/mappings`, 'POST', {
    external_id: '101',
    sku: p.json().sku,
  });
  assert.equal(link.statusCode, 200, link.body);
  return { ch, product: p.json().id };
}
async function pull(ch: string, cursor?: string, page = 1) {
  const r = await req(`/integrations/${ch}/fetch-orders`, 'POST', {
    page,
    ...(cursor ? { cursor } : {}),
  });
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}
async function rows(ch: string) {
  const r = await req(`/integrations/${ch}/imports`);
  assert.equal(r.statusCode, 200, r.body);
  return r.json().data;
}
async function commit(ch: string, record?: any) {
  const r = record ?? (await rows(ch))[0];
  return req(`/imports/${r.id}/commit`, 'POST', {
    warehouse_id: warehouse,
    expected_hash: r.source_hash,
  });
}
async function runSync(id: string) {
  const j = (
    await pool.query(
      "UPDATE jobs SET state='running',attempts=attempts+1,locked_at=now(),lease_token=$2 WHERE id=$1 RETURNING *",
      [id, randomUUID()],
    )
  ).rows[0];
  await processIntegrationJob(j, { transport: f.transport });
  return (await pool.query('SELECT * FROM jobs WHERE id=$1', [id])).rows[0];
}
test('Odoo API pull → revalidated import → one reservation and source payment, preserving ERP totals and mapping', async () => {
  const x = await fixture();
  await pull(x.ch);
  const r = await commit(x.ch);
  assert.equal(r.statusCode, 200, r.body);
  const o = r.json();
  assert.equal(o.source, 'odoo');
  assert.equal(o.total, 10109);
  assert.equal(o.items[0].line_total, 8610);
  assert.equal(o.status, 'paid');
  assert.equal(o.items[0].quantity, 2);
  assert.equal(o.source_snapshot.odoo.number, 'S-ODOO-DEMO-2001');
  assert.equal(
    (await pool.query('SELECT reserved FROM stock WHERE product_id=$1', [x.product])).rows[0]
      .reserved,
    2,
  );
  assert.equal(
    (await pool.query('SELECT amount FROM payment_entries WHERE order_id=$1', [o.id])).rows[0]
      .amount,
    10109,
  );
  const again = await commit(x.ch);
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(again.json().id, o.id);
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM payment_entries WHERE order_id=$1', [o.id]))
      .rows[0].n,
    1,
  );
  assert(f.calls.every((c) => ['read', 'search_read', 'fields_get'].includes(c.method)));
});
test('authorized payment is not a receipt; partial done payment preserves outstanding balance', async () => {
  for (const state of ['authorized', 'done']) {
    const x = await fixture();
    f.orders[0]._dyna.transactions[0].state = state;
    f.orders[0]._dyna.transactions[0].amount = 50;
    await pull(x.ch);
    const r = await commit(x.ch);
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().status, 'new');
    const p = (
      await pool.query('SELECT amount FROM payment_entries WHERE order_id=$1', [r.json().id])
    ).rows;
    assert.deepEqual(p, state === 'done' ? [{ amount: 5000 }] : []);
  }
});
test('changes before commit update preview and require another approval, without stock reservation', async () => {
  const x = await fixture();
  await pull(x.ch);
  const old = (await rows(x.ch))[0];
  f.orders[0]._dyna.transactions[0].state = 'authorized';
  const first = await commit(x.ch, old);
  assert.equal(first.statusCode, 409, first.body);
  assert.equal(
    (await pool.query('SELECT reserved FROM stock WHERE product_id=$1', [x.product])).rows[0]
      .reserved,
    0,
  );
  const next = (await rows(x.ch))[0];
  assert.notEqual(next.source_hash, old.source_hash);
  assert.equal((await commit(x.ch, old)).statusCode, 409);
  const r = await commit(x.ch, next);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().status, 'new');
});
test('already delivered ERP order, shared payment and unlinked product cannot reserve stock', async () => {
  for (const kind of ['delivered', 'shared', 'mapping']) {
    const x = await fixture();
    if (kind === 'delivered') f.orders[0]._dyna.lines[0].qty_delivered = 1;
    if (kind === 'shared') f.orders[0]._dyna.transactions[0].sale_order_ids.push(999);
    if (kind === 'mapping')
      await tenantTx(DEMO_TENANT, (c) =>
        c.query('DELETE FROM listings WHERE channel_id=$1', [x.ch]),
      );
    await pull(x.ch);
    const r = await commit(x.ch);
    assert.equal(r.statusCode, 422, r.body);
    assert.equal(
      (await pool.query('SELECT reserved FROM stock WHERE product_id=$1', [x.product])).rows[0]
        .reserved,
      0,
    );
    f = odooOrderFixture();
  }
});
test('insufficient stock rolls back imported order and source payment', async () => {
  const x = await fixture(1);
  await pull(x.ch);
  const r = await commit(x.ch);
  assert.equal(r.statusCode, 409, r.body);
  const record = (await rows(x.ch))[0];
  assert.equal(record.order_id, null);
  assert.equal(
    (await pool.query('SELECT reserved FROM stock WHERE product_id=$1', [x.product])).rows[0]
      .reserved,
    0,
  );
});
test('source changes after import flag reconciliation without rewriting local fulfillment or payment ledger', async () => {
  const x = await fixture();
  await pull(x.ch);
  const r = await commit(x.ch);
  assert.equal(r.statusCode, 200, r.body);
  const original = r.json();
  f.orders[0].state = 'cancel';
  await pull(x.ch);
  const changed = (await rows(x.ch))[0];
  assert.equal(changed.state, 'imported');
  assert.equal(changed.source_changed, true);
  assert.equal((await commit(x.ch)).statusCode, 409);
  const current = (await req('/orders/' + original.id)).json();
  assert.equal(current.status, 'paid');
  assert.equal(current.total, original.total);
  assert.equal(
    (
      await pool.query('SELECT count(*)::int n FROM payment_entries WHERE order_id=$1', [
        original.id,
      ])
    ).rows[0].n,
    1,
  );
});
test('API rejects another tenant/viewer and forged mapping, unsupported cursor or missing approval hash', async () => {
  const x = await fixture();
  assert.equal(
    (await req(`/integrations/${x.ch}/fetch-orders`, 'POST', {}, other)).statusCode,
    404,
  );
  assert.equal(
    (await req(`/integrations/${x.ch}/fetch-orders`, 'POST', {}, viewer)).statusCode,
    403,
  );
  assert.equal(
    (
      await req(`/integrations/${x.ch}/mappings`, 'POST', {
        external_id: 'template:10',
        sku: 'unknown',
      })
    ).statusCode,
    422,
  );
  assert.equal(
    (await req(`/integrations/${x.ch}/fetch-orders`, 'POST', { cursor: 'abcd' })).statusCode,
    422,
  );
  await pull(x.ch);
  const r = (await rows(x.ch))[0];
  assert.equal(
    (await req(`/imports/${r.id}/commit`, 'POST', { warehouse_id: warehouse })).statusCode,
    422,
  );
  assert.equal(
    (
      await tenantTx(SECOND_TENANT, (c) =>
        c.query('SELECT * FROM inbound_orders WHERE id=$1', [r.id]),
      )
    ).rowCount,
    0,
  );
});
test('queue checkpoint stages 21 orders in three pages, advances watermark only at completion and deduplicates overlap', async () => {
  f = odooOrderFixture(21);
  const x = await fixture();
  const job = (await req(`/integrations/${x.ch}/sync`, 'POST', {})).json();
  let j = await runSync(job.id);
  assert.equal(j.state, 'pending');
  assert.equal(
    (await pool.query('SELECT event_cursor FROM channels WHERE id=$1', [x.ch])).rows[0]
      .event_cursor,
    null,
  );
  assert.equal((await rows(x.ch)).length, 10);
  j = await runSync(job.id);
  assert.equal(j.state, 'pending');
  j = await runSync(job.id);
  assert.equal(j.state, 'done');
  assert.equal((await rows(x.ch)).length, 21);
  const channel = (await pool.query('SELECT * FROM channels WHERE id=$1', [x.ch])).rows[0];
  assert.equal(channel.bootstrap_done, true);
  assert.equal(channel.event_cursor, j.payload.odoo_window.to);
  // Timestamp ties and an explicit overlapping window must not create inbound duplicates.
  await pool.query("UPDATE channels SET event_cursor='2026-10-04 10:05:00' WHERE id=$1", [x.ch]);
  const again = (await req(`/integrations/${x.ch}/sync`, 'POST', {})).json();
  for (let i = 0; i < 3; i++) await runSync(again.id);
  assert.equal((await rows(x.ch)).length, 21);
});
test('pausing scheduled Odoo reads blocks provider calls and staging', async () => {
  const x = await fixture();
  assert.equal(
    (await req(`/integrations/${x.ch}/sync`, 'PATCH', { enabled: true, interval: 300 })).statusCode,
    200,
  );
  const job = (await req(`/integrations/${x.ch}/sync`, 'POST', {})).json();
  await req(`/integrations/${x.ch}/sync`, 'PATCH', { enabled: false, interval: 300 });
  const j = await runSync(job.id);
  assert.equal(j.state, 'done');
  assert.match(j.error, /pauzie/);
  assert.equal(f.calls.length, 0);
  assert.equal((await rows(x.ch)).length, 0);
});
test('credential rotation during page fetch fences remaining reads and prevents staging', async () => {
  const x = await fixture();
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
  const r = await req(`/integrations/${x.ch}/fetch-orders`, 'POST', {});
  assert.equal(r.statusCode, 409, r.body);
  assert.equal(f.calls.length, 1);
  assert.equal((await rows(x.ch)).length, 0);
});
test('role revocation during queue read stops next RPC and page persistence', async () => {
  const x = await fixture(),
    job = (await req(`/integrations/${x.ch}/sync`, 'POST', {})).json();
  const actor = (await pool.query('SELECT payload FROM jobs WHERE id=$1', [job.id])).rows[0].payload
    .actor_id;
  let changed = false;
  f.state.hook = async () => {
    if (!changed) {
      changed = true;
      await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [
        DEMO_TENANT,
        actor,
      ]);
    }
  };
  try {
    await assert.rejects(() => runSync(job.id));
    assert.equal(f.calls.length, 1);
    assert.equal(
      (await pool.query('SELECT count(*)::int n FROM inbound_orders WHERE channel_id=$1', [x.ch]))
        .rows[0].n,
      0,
    );
  } finally {
    await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [
      DEMO_TENANT,
      actor,
    ]);
  }
});
test('lease replacement during remote read prevents local checkpoint and staging', async () => {
  const x = await fixture(),
    job = (await req(`/integrations/${x.ch}/sync`, 'POST', {})).json();
  let changed = false;
  f.state.hook = async () => {
    if (!changed) {
      changed = true;
      await pool.query("UPDATE jobs SET lease_token=NULL,state='pending' WHERE id=$1", [job.id]);
    }
  };
  await assert.rejects(() => runSync(job.id));
  assert.equal(f.calls.length, 1);
  assert.equal((await rows(x.ch)).length, 0);
  f.state.hook = undefined;
  const next = await runSync(job.id);
  assert.equal(next.state, 'done');
  assert.equal((await rows(x.ch)).length, 1);
});
test('simulation imports the complete local ERP example without any provider request', async () => {
  const x = await fixture(100, true);
  const r = await req(`/integrations/${x.ch}/odoo-order-example`, 'POST', {});
  assert.equal(r.statusCode, 200, r.body);
  const imported = await commit(x.ch);
  assert.equal(imported.statusCode, 200, imported.body);
  assert.equal(imported.json().source, 'odoo');
  assert.equal(imported.json().total, 10109);
  assert.equal(f.calls.length, 0);
  assert.equal((await req(`/integrations/${x.ch}/sync`, 'POST', {})).statusCode, 422);
});
