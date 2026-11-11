import assert from 'node:assert/strict';
import { before, beforeEach, after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { seed } from './fixtures';
import { processPaymentImportJob } from '../server/payment-imports';

assert.equal(process.env.DYNA_TEST, 'true');
assert.match(new URL(process.env.DATABASE_URL!).pathname, /^\/dynaminds_test_\d+$/);
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  user: string,
  tenant: string,
  warehouse: string;
const req = (path: string, method: any = 'GET', payload?: any) =>
  app.inject({ url: '/api' + path, method, payload, headers: { cookie } });
async function ok(path: string, method: any = 'GET', payload?: any) {
  const r = await req(path, method, payload);
  assert(r.statusCode < 300, r.body);
  return r.json();
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp();
  const r = await app.inject({
    url: '/api/auth/login',
    method: 'POST',
    payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' },
  });
  assert.equal(r.statusCode, 200);
  cookie = String(r.headers['set-cookie']).split(';')[0];
  user = (await ok('/auth/me')).user.id;
});
beforeEach(async () => {
  tenant = randomUUID();
  warehouse = randomUUID();
  await pool.query(
    "INSERT INTO tenants(id,name,plan) VALUES($1,'Import batches QA','enterprise')",
    [tenant],
  );
  await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [
    tenant,
    user,
  ]);
  await pool.query(
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Batches','BATCH')",
    [warehouse, tenant],
  );
  const r = await req('/workspaces/switch', 'POST', { tenant_id: tenant });
  assert.equal(r.statusCode, 200, r.body);
  cookie = String(r.headers['set-cookie']).split(';')[0];
});
after(async () => {
  await app.close();
  await pool.end();
});
async function fixture(rows: number) {
  const product = await ok('/products', 'POST', {
    sku: 'BANK-BATCH-' + randomUUID(),
    name: 'Batch amount',
    price: 100,
    quantity: 200,
    warehouse_id: warehouse,
  });
  const order = await ok('/orders', 'POST', {
    customer_name: 'Batch QA',
    email: 'batch@example.test',
    warehouse_id: warehouse,
    items: [{ product_id: product.id, quantity: rows }],
    address: { country: 'PL' },
  });
  const ns = await ok('/payment-imports/namespaces', 'POST', {
    client_key: randomUUID(),
    label: 'Batch ledger',
    source_kind: 'bank_statement',
  });
  const profile = await ok('/payment-imports/profiles', 'POST', {
    client_key: randomUUID(),
    definition: {
      name: 'Batch CSV',
      description: 'Local test',
      source_kind: 'bank_statement',
      source_namespace_id: ns.id,
      transaction_id_scope: 'namespace',
      mode: 'bank_receipt',
      encoding: 'utf-8',
      delimiter: ';',
      header: true,
      skip_records: 0,
      decimal_separator: ',',
      grouping_separator: 'none',
      sign: 'credit_positive',
      date_format: 'YYYY-MM-DD',
      columns: {
        transaction_id: { index: 0 },
        booking_date: { index: 1 },
        amount: { index: 2 },
        reference: [{ index: 3 }],
        order_reference: { index: 3 },
      },
      fixed_currency: 'PLN',
      match: { kind: 'order_number', extraction: 'whole_field' },
    },
  });
  const csv =
    'tx;date;amount;order\n' +
    Array.from({ length: rows }, (_, i) => 'BATCH-' + i + ';2026-10-05;1,00;' + order.number).join(
      '\n',
    );
  const file = await ok('/payment-imports/uploads', 'POST', {
    client_key: randomUUID(),
    profile_id: profile.id,
    profile_version: profile.version,
    filename: 'batches.csv',
    content_base64: Buffer.from(csv).toString('base64'),
  });
  const p = await ok('/payment-imports/previews', 'POST', {
    client_key: randomUUID(),
    file_id: file.file_id,
    profile_id: profile.id,
    profile_version: profile.version,
  });
  const all = (
    await pool.query(
      'SELECT row_id FROM payment_import_rows WHERE tenant_id=$1 AND preview_id=$2 ORDER BY row_id',
      [tenant, p.id],
    )
  ).rows.map((r) => r.row_id);
  assert.equal(p.summary.counts.ready, rows);
  assert.equal(all.length, rows);
  return { order, product, p, all };
}
const queueBody = (f: any, ids: string[]) => ({
  client_key: randomUUID(),
  version: f.p.version,
  row_ids: ids,
  scope_hash: f.p.scope_hash,
  confirmed: true,
  local_ledger_only: true,
});
async function claim(e: any) {
  return (
    await pool.query(
      "UPDATE jobs SET state='running',attempts=attempts+1,locked_at=now(),lease_token=$2 WHERE id=$1 RETURNING *",
      [e.job_id, randomUUID()],
    )
  ).rows[0];
}

test('all100 selected receipts on one baseline commit atomically with one paid transition and no import side effects', async () => {
  const started = performance.now(),
    f = await fixture(100),
    before = (
      await pool.query('SELECT on_hand,reserved FROM stock WHERE tenant_id=$1 AND product_id=$2', [
        tenant,
        f.product.id,
      ])
    ).rows;
  const e = await ok('/payment-imports/previews/' + f.p.id + '/queue', 'POST', queueBody(f, f.all));
  assert.equal(e.selected_count, 100);
  await processPaymentImportJob(await claim(e));
  const done = await ok('/payment-imports/executions/' + e.id),
    o = await ok('/orders/' + f.order.id);
  assert.equal(done.state, 'done');
  assert.equal(done.result.ledger_entries, 100);
  assert.equal(o.status, 'paid');
  assert.equal(o.payment.received, 10000);
  assert.equal(o.payment.amount_due, 0);
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::int n FROM payment_import_receipts WHERE execution_id=$1',
        [e.id],
      )
    ).rows[0].n,
    100,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM order_events WHERE order_id=$1 AND kind='order.paid'",
        [o.id],
      )
    ).rows[0].n,
    1,
  );
  assert.deepEqual(
    (
      await pool.query('SELECT on_hand,reserved FROM stock WHERE tenant_id=$1 AND product_id=$2', [
        tenant,
        f.product.id,
      ])
    ).rows,
    before,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM jobs WHERE tenant_id=$1 AND kind NOT IN ('automation','payment.import')",
        [tenant],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM jobs WHERE tenant_id=$1 AND kind='automation'",
        [tenant],
      )
    ).rows[0].n,
    1,
    'Only original order.created event, no import events dispatch',
  );
  console.log(
    JSON.stringify({
      scope: 'synthetic100rowlocalbankbatch',
      selected: 100,
      elapsed_ms: Math.round(performance.now() - started),
      provider_calls: 0,
    }),
  );
});

test('21 simultaneous scopes admit exactly20 executions, capacity rejection rolls back job and claim, cancel releases reserved identities', async () => {
  const f = await fixture(21),
    responses = await Promise.all(
      f.all.map((id: string) =>
        req('/payment-imports/previews/' + f.p.id + '/queue', 'POST', queueBody(f, [id])),
      ),
    );
  assert.equal(
    responses.filter((r) => r.statusCode === 200).length,
    20,
    responses.map((r) => r.body).join('\n'),
  );
  assert.equal(responses.filter((r) => r.statusCode === 409).length, 1);
  for (const table of ['payment_import_executions', 'payment_import_claims'])
    assert.equal(
      (await pool.query(`SELECT count(*)::int n FROM ${table} WHERE tenant_id=$1`, [tenant]))
        .rows[0].n,
      20,
    );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM jobs WHERE tenant_id=$1 AND kind='payment.import'",
        [tenant],
      )
    ).rows[0].n,
    20,
  );
  assert.equal(
    (
      await pool.query('SELECT count(*)::int n FROM payment_entries WHERE order_id=$1', [
        f.order.id,
      ])
    ).rows[0].n,
    0,
  );
  for (const response of responses.filter((r) => r.statusCode === 200)) {
    const e = response.json();
    const result = await ok('/payment-imports/executions/' + e.id + '/cancel', 'POST', {
      client_key: randomUUID(),
    });
    assert.equal(result.state, 'cancelled');
  }
  assert.equal(
    (
      await pool.query('SELECT count(*)::int n FROM payment_import_claims WHERE tenant_id=$1', [
        tenant,
      ])
    ).rows[0].n,
    0,
  );
});

test('worker waits on actual order lock while role withdrawal commits; stale actor applies zero entries', async () => {
  const f = await fixture(1),
    e = await ok('/payment-imports/previews/' + f.p.id + '/queue', 'POST', queueBody(f, f.all)),
    job = await claim(e),
    holder = await pool.connect();
  let work: Promise<any> | undefined;
  try {
    await holder.query('BEGIN');
    const pid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    await holder.query('SELECT id FROM orders WHERE id=$1 FOR UPDATE', [f.order.id]);
    work = processPaymentImportJob(job);
    let blocked = false;
    for (let i = 0; i < 100; i++) {
      blocked = Boolean(
        (
          await pool.query(
            'SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1::int=ANY(pg_blocking_pids(pid))',
            [pid],
          )
        ).rowCount,
      );
      if (blocked) break;
      await setTimeout(10);
    }
    assert(blocked, 'Worker must be observed blocked on holder order');
    const revoke = pool.query(
      "UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2",
      [tenant, user],
    );
    const revoked = await Promise.race([
      revoke.then(() => true),
      setTimeout(1000).then(() => false),
    ]);
    assert(revoked, 'Role withdrawal must commit while worker waits on order');
    await holder.query('COMMIT');
    const outcome = await work;
    assert.equal(outcome.state, 'conflict');
    assert.equal(
      (
        await pool.query('SELECT count(*)::int n FROM payment_entries WHERE order_id=$1', [
          f.order.id,
        ])
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int n FROM payment_import_receipts WHERE execution_id=$1',
          [e.id],
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int n FROM payment_import_claims WHERE execution_id=$1',
          [e.id],
        )
      ).rows[0].n,
      0,
    );
  } finally {
    await holder.query('ROLLBACK').catch(() => {});
    holder.release();
    await work?.catch(() => {});
  }
});
