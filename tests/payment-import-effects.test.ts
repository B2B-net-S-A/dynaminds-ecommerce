import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { migrate, pool, tenantTx } from '../server/db';
import { seed } from './fixtures';
import { encrypt } from '../server/security';
import { Problem } from '../server/errors';
import type { Actor } from '../server/domain';
import {
  financialPaymentEntry,
  localFinancialContext,
  paymentInput,
  recordPayment,
  recordFinancialPaymentInTx,
  reverseFinancialPaymentInTx,
  paymentBalance,
  type FinancialPaymentEntry,
  type LocalFinancialContext,
} from '../server/payments';
import { isLocalFinancialVersion } from '../server/local-financial-policy';
import { scheduleCandidates } from '../server/automation-schedules';
import { previewStatus, statusConnection } from '../server/order-status';
import { tenantScopedOwnerQuery } from './tenant-scoped-owner-write';
import { rewriteShipmentFixture } from './shipment-identity-fixture';

assert.equal(process.env.DYNA_TEST, 'true');
const testUrl = new URL(process.env.DATABASE_URL ?? 'http://invalid');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(testUrl.hostname));
assert.match(
  testUrl.pathname,
  /^\/dynaminds_test_\d+$/,
  'Financial fixtures require disposable DB',
);
let user: string, actor: Actor, warehouse: string, channel: any;
const tx = <T>(fn: Parameters<typeof tenantTx<T>>[1]) => tenantTx(actor.tenantId, fn);
const provenance = (): LocalFinancialContext => ({
  effects: 'local_financial_only',
  provenance: {
    execution_id: randomUUID(),
    row_id: randomUUID(),
    preview_id: randomUUID(),
  },
});
const entry = (
  amount = 10000,
  extra: Partial<FinancialPaymentEntry> = {},
): FinancialPaymentEntry => ({
  kind: 'receipt',
  amount,
  currency: 'PLN',
  method: 'bank_csv',
  reference: 'CSV local financial proof',
  ...extra,
});
const isStatus = (status: number) => (e: unknown) => e instanceof Problem && e.status === status;
before(async () => {
  await migrate();
  await seed();
  user = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
});
beforeEach(async () => {
  actor = { tenantId: randomUUID(), userId: user, role: 'admin' };
  warehouse = randomUUID();
  await pool.query(
    "INSERT INTO tenants(id,name,plan) VALUES($1,'Local financial QA','enterprise')",
    [actor.tenantId],
  );
  await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [
    actor.tenantId,
    user,
  ]);
  await pool.query(
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Financial','FIN')",
    [warehouse, actor.tenantId],
  );
  channel = (
    await pool.query(
      "INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings) VALUES($1,$2,'woocommerce','Status fixture','sandbox',$3,$4) RETURNING *",
      [
        randomUUID(),
        actor.tenantId,
        encrypt({ consumer_key: 'isolated', consumer_secret: 'isolated' }),
        JSON.stringify({ store_url: 'https://example.invalid' }),
      ],
    )
  ).rows[0];
  await pool.query(
    'INSERT INTO order_status_configs(tenant_id,channel_id,actor_id,enabled,external_authorized,connection_hash) VALUES($1,$2,$3,true,true,$4)',
    [actor.tenantId, channel.id, user, statusConnection(channel)],
  );
  const email = randomUUID(),
    sms = randomUUID();
  await pool.query(
    "INSERT INTO email_templates(id,tenant_id,name,subject,body,client_key,creation_hash) VALUES($1,$2,'Financial email','Status','Status zamówienia',$3,'fixture')",
    [email, actor.tenantId, randomUUID()],
  );
  await pool.query(
    "INSERT INTO sms_templates(id,tenant_id,name,body,max_parts,client_key,creation_hash) VALUES($1,$2,'Financial SMS','Status zamówienia',1,$3,'fixture')",
    [sms, actor.tenantId, randomUUID()],
  );
  for (const trigger of [
    'payment.receipt',
    'payment.courier_collection',
    'payment.courier_remittance',
    'payment.reversal',
    'order.paid',
  ])
    await pool.query(
      "INSERT INTO automation_rules(id,tenant_id,name,trigger,action,config,enabled,actor_id) VALUES($1,$2,$3,$3,'actions',$4,true,$5)",
      [
        randomUUID(),
        actor.tenantId,
        trigger,
        JSON.stringify({
          actions: [
            { type: 'email', template_id: email, mode: 'local' },
            { type: 'sms', template_id: sms, mode: 'local' },
          ],
        }),
        user,
      ],
    );
  await pool.query(
    "INSERT INTO outbound_subscriptions(id,tenant_id,actor_id,name,mode,secret,events,enabled,approved_at) VALUES($1,$2,$3,'Financial observer','local',$4,$5,true,now())",
    [
      randomUUID(),
      actor.tenantId,
      user,
      encrypt({ secret: 'isolated' }),
      ['order.updated', 'order.status_changed'],
    ],
  );
});
after(async () => {
  await pool.end();
});
async function make(mode = 'prepaid', status = 'new', total = 10000) {
  const id = randomUUID(),
    product = randomUUID();
  await pool.query(
    "INSERT INTO products(id,tenant_id,sku,name,price) VALUES($1,$2,$3,'Financial product',10000)",
    [product, actor.tenantId, 'FIN-' + product],
  );
  await tenantScopedOwnerQuery(
    actor.tenantId,
    'INSERT INTO stock(tenant_id,warehouse_id,product_id,on_hand) VALUES($1,$2,$3,7)',
    [actor.tenantId, warehouse, product],
  );
  const order = (
    await pool.query(
      "INSERT INTO orders(id,tenant_id,number,customer_name,email,address,total,warehouse_id,portal_token,payment_mode,status,channel_id,external_id,created_at) VALUES($1,$2,$3,'Financial QA','financial@example.test',$4,$5,$6,$7,$8,$9,$10,$11,now()-interval '1 day') RETURNING *",
      [
        id,
        actor.tenantId,
        'FIN-' + id,
        JSON.stringify({ phone: '500600700' }),
        total,
        warehouse,
        randomUUID(),
        mode,
        status,
        channel.id,
        id,
      ],
    )
  ).rows[0];
  await pool.query(
    'INSERT INTO order_items(id,tenant_id,order_id,product_id,name,sku,quantity,price,vat,line_total) VALUES($1,$2,$3,$4,$5,$6,1,10000,23,10000)',
    [randomUUID(), actor.tenantId, id, product, 'Financial product', 'FIN-' + product],
  );
  return order;
}
async function shipment(order: any, dispatched = true) {
  return (
    await rewriteShipmentFixture(
      "INSERT INTO shipments(id,tenant_id,order_id,carrier,tracking_number,mode,status,channel_id,dispatched_at,cod_expected) VALUES($1,$2,$3,'DPD',$4,'sandbox','confirmed',$5,CASE WHEN $6 THEN now() END,$7) RETURNING *",
      [randomUUID(), actor.tenantId, order.id, randomUUID(), channel.id, dispatched, order.total],
    )
  ).rows[0];
}
async function write(
  order: any,
  value = entry(),
  context = provenance(),
  key: string = randomUUID(),
  request: any = { row: 1 },
) {
  return tx((c) => recordFinancialPaymentInTx(c, actor, order.id, key, request, value, context));
}
async function snapshot() {
  const result: Record<string, unknown> = {};
  for (const table of [
    'orders',
    'order_items',
    'stock',
    'shipments',
    'payment_entries',
    'order_events',
    'audit_events',
    'order_local_financial_fences',
    'jobs',
    'outbound_events',
    'outbound_deliveries',
    'email_batches',
    'email_messages',
    'sms_batches',
    'sms_messages',
    'order_status_plans',
  ])
    result[table] = (
      await pool.query(
        `SELECT to_jsonb(t) row FROM ${table} t WHERE tenant_id=$1 ORDER BY to_jsonb(t)::text`,
        [actor.tenantId],
      )
    ).rows;
  return result;
}
async function noJobs() {
  for (const table of [
    'jobs',
    'outbound_events',
    'outbound_deliveries',
    'email_batches',
    'sms_batches',
    'order_status_plans',
  ])
    assert.equal(
      (
        await pool.query(`SELECT count(*)::int n FROM ${table} WHERE tenant_id=$1`, [
          actor.tenantId,
        ])
      ).rows[0].n,
      0,
      table,
    );
}
test('two local financial receipts in one transaction advance paid, retain provenance and create zero communication/status/automation jobs', async () => {
  const o = await make('prepaid', 'new', 15000),
    first = provenance(),
    second = provenance();
  await tx(async (c) => {
    await recordFinancialPaymentInTx(
      c,
      actor,
      o.id,
      'payment-import:first',
      {},
      entry(10000),
      first,
    );
    assert.equal((await paymentBalance(c, o.id)).amount_due, 5000);
    await recordFinancialPaymentInTx(
      c,
      actor,
      o.id,
      'payment-import:second',
      {},
      entry(5000),
      second,
    );
    assert.equal((await paymentBalance(c, o.id)).amount_due, 0);
  });
  const current = (await pool.query('SELECT * FROM orders WHERE id=$1', [o.id])).rows[0];
  assert.equal(current.status, 'paid');
  assert.equal(BigInt(current.version), BigInt(o.version) + 3n);
  assert.equal(current.total, o.total);
  assert.equal(current.note, o.note);
  const events = (
    await pool.query(
      'SELECT kind,detail FROM order_events WHERE order_id=$1 ORDER BY created_at,id',
      [o.id],
    )
  ).rows;
  assert.equal(events.length, 3);
  assert.equal(events.filter((e) => e.kind === 'order.paid').length, 1);
  for (const e of events) {
    assert.equal(e.detail.effects, 'local_financial_only');
    assert.deepEqual(
      e.detail.provenance,
      e.kind === 'payment.receipt' && e.detail.amount === 10000
        ? first.provenance
        : second.provenance,
    );
  }
  const audits = (
    await pool.query(
      'SELECT action,detail FROM audit_events WHERE entity_id=$1 ORDER BY created_at,id',
      [o.id],
    )
  ).rows;
  assert.equal(audits.length, 3);
  for (const a of audits) assert.equal(a.detail.effects, 'local_financial_only');
  assert.equal(
    (await pool.query('SELECT on_hand,reserved FROM stock WHERE tenant_id=$1', [actor.tenantId]))
      .rows[0].on_hand,
    7,
  );
  await tx(async (c) => assert.equal(await isLocalFinancialVersion(c, o.id), true));
  await noJobs();
});
test('existing normal payment preserves event automation/email/SMS freezing, outbound and status scan behavior', async () => {
  const o = await make();
  await tx((c) =>
    recordPayment(
      c,
      actor,
      o.id,
      paymentInput.parse({
        client_key: randomUUID(),
        version: o.version,
        kind: 'receipt',
        amount: 10000,
        currency: 'PLN',
        reference: 'Normal payment control',
        confirmed: true,
      }),
    ),
  );
  const jobs = (
    await pool.query('SELECT kind,payload FROM jobs WHERE tenant_id=$1', [actor.tenantId])
  ).rows;
  assert.equal(jobs.filter((j) => j.kind === 'automation').length, 2);
  assert.equal(jobs.filter((j) => j.kind === 'outbound.webhook').length, 2);
  assert.equal(jobs.filter((j) => j.kind === 'order.status.scan').length, 1);
  for (const j of jobs.filter((j) => j.kind === 'automation')) {
    assert.equal(j.payload.rules.length, 1);
    assert.equal(j.payload.rules[0].config.actions[0].template_version, '1');
    assert.equal(j.payload.rules[0].config.actions[1].template_version, '1');
  }
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::int n FROM order_local_financial_fences WHERE order_id=$1',
        [o.id],
      )
    ).rows[0].n,
    0,
  );
});
test('deterministic string key replay returns original entry without version/events/jobs and rejects changed data or provenance', async () => {
  const o = await make(),
    p = provenance(),
    b = entry(10000, { shipment_id: undefined }),
    key = 'payment-import:' + p.provenance.execution_id + ':' + p.provenance.row_id + ':receipt';
  const result = await write(o, b, p, key, { hash: 'frozen', optional: undefined }),
    before = await snapshot();
  assert.deepEqual(await write(o, b, p, key, { hash: 'frozen' }), {
    entry_id: result.entry_id,
    reused: true,
  });
  assert.deepEqual(await snapshot(), before);
  await assert.rejects(write(o, entry(9000), p, key, { hash: 'frozen' }), isStatus(409));
  await assert.rejects(write(o, b, provenance(), key, { hash: 'frozen' }), isStatus(409));
  await assert.rejects(write(o, b, p, key, { hash: 'changed' }), isStatus(409));
  assert.deepEqual(await snapshot(), before);
});
test('invalid second write rolls back all prior ledger/status/version/provenance fences/events/audits in caller transaction', async () => {
  const o = await make(),
    before = await snapshot();
  await assert.rejects(
    tx(async (c) => {
      await recordFinancialPaymentInTx(
        c,
        actor,
        o.id,
        'payment-import:one',
        {},
        entry(),
        provenance(),
      );
      await recordFinancialPaymentInTx(
        c,
        actor,
        o.id,
        'payment-import:two',
        {},
        entry(100, { currency: 'EUR' }),
        provenance(),
      );
    }),
    isStatus(422),
  );
  assert.deepEqual(await snapshot(), before);
});
test('shared COD checks separate collection/remittance and enforce dispatch, expected collection and unsettled amount', async () => {
  const o = await make('cod', 'shipped'),
    s = await shipment(o);
  const collection = (amount: number) =>
    entry(amount, { kind: 'courier_collection', method: 'courier_csv', shipment_id: s.id });
  const remit = (amount: number, fee = 0) =>
    entry(amount, { kind: 'courier_remittance', method: 'bank_csv_cod', shipment_id: s.id, fee });
  await assert.rejects(write(o, remit(9800, 200)), isStatus(422));
  await assert.rejects(write(o, collection(10001)), isStatus(422));
  await write(o, collection(10000));
  await assert.rejects(write(o, collection(1)), isStatus(422));
  await assert.rejects(write(o, remit(9900, 200)), isStatus(422));
  await write(o, remit(9800, 200));
  const balance = await tx((c) => paymentBalance(c, o.id));
  assert.equal(balance.received, 10000);
  assert.equal(balance.collected, 10000);
  assert.equal(balance.remitted, 9800);
  assert.equal(balance.fees, 200);
  assert.equal(balance.courier_due, 0);
  assert.equal(
    (await pool.query('SELECT status FROM orders WHERE id=$1', [o.id])).rows[0].status,
    'shipped',
  );
  await noJobs();
  const unshipped = await make('cod'),
    us = await shipment(unshipped, false);
  await assert.rejects(
    write(
      unshipped,
      entry(10000, { kind: 'courier_collection', method: 'courier_csv', shipment_id: us.id }),
    ),
    isStatus(409),
  );
  const prepaid = await make(),
    ps = await shipment(prepaid);
  await assert.rejects(
    write(
      prepaid,
      entry(10000, { kind: 'courier_collection', method: 'courier_csv', shipment_id: ps.id }),
    ),
    isStatus(422),
  );
});
test('local reversal preserves physical status, appends negative receipt correction, fences revision and is idempotent', async () => {
  const o = await make(),
    paid = await write(o),
    p = provenance(),
    key = 'payment-import:correction';
  const reverse = () =>
    tx((c) =>
      reverseFinancialPaymentInTx(
        c,
        actor,
        o.id,
        key,
        { reason_hash: 'same' },
        { entry_id: paid.entry_id, reason: 'Correct local proof' },
        p,
      ),
    );
  const result = await reverse(),
    before = await snapshot();
  assert.deepEqual(await reverse(), { entry_id: result.entry_id, reused: true });
  assert.deepEqual(await snapshot(), before);
  await assert.rejects(
    tx((c) =>
      reverseFinancialPaymentInTx(
        c,
        actor,
        o.id,
        'payment-import:other',
        {},
        { entry_id: paid.entry_id, reason: 'Repeat correction' },
        provenance(),
      ),
    ),
    isStatus(409),
  );
  const correction = (
    await pool.query('SELECT * FROM payment_entries WHERE id=$1', [result.entry_id])
  ).rows[0];
  assert.equal(correction.kind, 'reversal');
  assert.equal(correction.amount, -10000);
  assert.equal(correction.reversal_of, paid.entry_id);
  assert.equal(
    (await pool.query('SELECT status FROM orders WHERE id=$1', [o.id])).rows[0].status,
    'paid',
  );
  assert.equal((await tx((c) => paymentBalance(c, o.id))).amount_due, 10000);
  const e = (
    await pool.query(
      "SELECT detail FROM order_events WHERE order_id=$1 AND kind='payment.reversal'",
      [o.id],
    )
  ).rows[0];
  assert.deepEqual(e.detail.provenance, p.provenance);
  await tx(async (c) => assert.equal(await isLocalFinancialVersion(c, o.id), true));
  await noJobs();
});
test('COD reversal shares remit-before-collection dependency and settles both corrections atomically', async () => {
  const o = await make('cod', 'shipped'),
    s = await shipment(o);
  const collection = await write(
    o,
    entry(10000, { kind: 'courier_collection', method: 'courier_csv', shipment_id: s.id }),
  );
  const remit = await write(
    o,
    entry(9800, { kind: 'courier_remittance', method: 'courier_csv', shipment_id: s.id, fee: 200 }),
  );
  const before = await snapshot();
  await assert.rejects(
    tx((c) =>
      reverseFinancialPaymentInTx(
        c,
        actor,
        o.id,
        'wrong-order',
        {},
        { entry_id: collection.entry_id, reason: 'Collection before remit' },
        provenance(),
      ),
    ),
    isStatus(409),
  );
  assert.deepEqual(await snapshot(), before);
  await tx(async (c) => {
    await reverseFinancialPaymentInTx(
      c,
      actor,
      o.id,
      'remit-first',
      {},
      { entry_id: remit.entry_id, reason: 'Correct remit first' },
      provenance(),
    );
    await reverseFinancialPaymentInTx(
      c,
      actor,
      o.id,
      'collection-second',
      {},
      { entry_id: collection.entry_id, reason: 'Correct collection second' },
      provenance(),
    );
  });
  const balance = await tx((c) => paymentBalance(c, o.id));
  assert.equal(balance.received, 0);
  assert.equal(balance.courier_due, 0);
  assert.equal(balance.amount_due, 10000);
  await noJobs();
});
test('shipping uncertainty blocks both local append and reversal without bypass or partial effects', async () => {
  const o = await make(),
    paid = await write(o);
  await pool.query(
    "INSERT INTO shipping_plans(id,tenant_id,order_id,channel_id,actor_id,state,input,payload,order_snapshot,phase) VALUES($1,$2,$3,$4,$5,'failed','{}','{}','{}','buy_started')",
    [randomUUID(), actor.tenantId, o.id, channel.id, user],
  );
  const before = await snapshot();
  await assert.rejects(write(o, entry(100)), isStatus(409));
  await assert.rejects(
    tx((c) =>
      reverseFinancialPaymentInTx(
        c,
        actor,
        o.id,
        'uncertain-correction',
        {},
        { entry_id: paid.entry_id, reason: 'Blocked correction' },
        provenance(),
      ),
    ),
    isStatus(409),
  );
  assert.deepEqual(await snapshot(), before);
});
test('strict local policy rejects missing provenance, wrong CSV kind/method and foreign tenant; public payment schema remains unchanged', async () => {
  assert.equal(localFinancialContext.safeParse({ effects: 'local_financial_only' }).success, false);
  assert.equal(
    localFinancialContext.safeParse({ ...provenance(), effects: 'default' }).success,
    false,
  );
  assert.equal(
    financialPaymentEntry.safeParse(entry(100, { method: 'bank_csv_cod' })).success,
    false,
  );
  assert.equal(financialPaymentEntry.safeParse(entry(100, { fee: 1 })).success, false);
  assert.equal(
    paymentInput.safeParse({ client_key: randomUUID(), version: 1, ...entry(), confirmed: true })
      .success,
    false,
  );
  const o = await make(),
    before = await snapshot();
  await assert.rejects(
    tx((c) =>
      recordFinancialPaymentInTx(
        c,
        { ...actor, role: 'viewer' },
        o.id,
        'viewer',
        {},
        entry(),
        provenance(),
      ),
    ),
    isStatus(403),
  );
  await assert.rejects(
    tenantTx(randomUUID(), (c) =>
      recordFinancialPaymentInTx(c, actor, o.id, 'foreign', {}, entry(), provenance()),
    ),
    isStatus(404),
  );
  assert.deepEqual(await snapshot(), before);
});
test('periodic schedule candidates and automatic status preview exclude the exact imported revision; next ordinary revision follows default policy', async () => {
  const o = await make();
  const run = {
    definition: { statuses: ['new', 'paid'], min_age_seconds: 0, repetition: 'each_run' },
    as_of: new Date().toISOString(),
    schedule_id: randomUUID(),
    definition_version: 1,
  };
  assert.equal(
    (await tx((c) => scheduleCandidates(c, run))).some((r) => r.id === o.id),
    true,
  );
  await write(o);
  assert.equal(
    (await tx((c) => scheduleCandidates(c, run))).some((r) => r.id === o.id),
    false,
  );
  let calls = 0;
  await assert.rejects(
    previewStatus(
      actor,
      o.id,
      {
        transport: async () => {
          calls++;
          throw new Error('Must not reach provider');
        },
      },
      { job: {}, version: 1 },
    ),
    isStatus(409),
  );
  assert.equal(calls, 0);
  await noJobs();
  await tx((c) =>
    c.query("UPDATE orders SET note='Ordinary later operator edit' WHERE id=$1", [o.id]),
  );
  assert.equal(
    (await tx((c) => scheduleCandidates(c, run))).some((r) => r.id === o.id),
    true,
  );
  await tx(async (c) => assert.equal(await isLocalFinancialVersion(c, o.id), false));
});
