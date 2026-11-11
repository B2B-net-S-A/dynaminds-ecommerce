import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed, DEMO_TENANT, SECOND_TENANT } from './fixtures';
import { tick } from '../server/worker';
import { dispatchAutomation, processAutomation } from '../server/automations';
import { processBatch } from '../server/order-operations';
assert.equal(process.env.DYNA_TEST, 'true');
let app: FastifyInstance,
  admin: string,
  operator: string,
  viewer: string,
  other: string,
  warehouse: string,
  product: string,
  adminId: string;
const req = (url: string, method: any = 'GET', payload?: any, cookie = admin) =>
  app.inject({ url, method, payload, headers: { cookie } });
async function ok(url: string, method: any = 'GET', payload?: any, cookie = admin) {
  const r = await req(url, method, payload, cookie);
  assert.ok(r.statusCode < 300, r.body);
  return r.json();
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp();
  async function login(email: string) {
    const r = await app.inject({
      url: '/api/auth/login',
      method: 'POST',
      payload: { email, password: 'DynaDemo!2026' },
    });
    assert.equal(r.statusCode, 200, r.body);
    return r.headers['set-cookie']!.toString().split(';')[0];
  }
  admin = await login('admin@demo.local');
  operator = await login('operator@demo.local');
  viewer = await login('viewer@demo.local');
  other = await login('other@demo.local');
  warehouse = (await ok('/api/warehouses')).data[0].id;
  adminId = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
  product = (
    await ok('/api/products', 'POST', {
      name: 'Operacje testowe',
      sku: 'OPS-' + randomUUID(),
      price: 2500,
      warehouse_id: warehouse,
      quantity: 1000,
    })
  ).id;
});
beforeEach(async () => {
  await pool.query('UPDATE automation_rules SET enabled=false,version=version+1');
  await pool.query("UPDATE jobs SET state='done',lease_token=NULL");
});
after(async () => {
  await app.close();
  await pool.end();
});
async function order(status = 'new') {
  const o = await ok('/api/orders', 'POST', {
    customer_name: 'QA operacje',
    email: 'ops@example.test',
    warehouse_id: warehouse,
    items: [{ product_id: product, quantity: 1 }],
    address: { country: 'PL', city: 'Warszawa' },
  });
  if (status !== 'new') await ok('/api/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/api/orders/' + o.id + '/status', { status }));
  return o;
}
const get = (o: any) => ok('/api/orders/' + o.id);
const act = (o: any, a: any, c = admin) => ok('/api/orders/' + o.id + '/operations', 'POST', a, c);
const wf = (stage = 'paid') =>
  ok('/api/workflow-statuses', 'POST', {
    name: 'QA ' + randomUUID().slice(0, 8),
    stage,
    color: '#2563eb',
  });
const rule = (actions: any[], extra: any = {}) =>
  ok('/api/automations', 'POST', {
    name: 'Reguła ' + randomUUID().slice(0, 8),
    trigger: 'order.paid',
    actions,
    ...extra,
  });
async function drain() {
  for (let i = 0; i < 150; i++) if (!(await tick())) return;
  assert.fail('Kolejka nie wygasła w 150 krokach');
}
async function runs(o: any) {
  return (
    await pool.query('SELECT * FROM automation_runs WHERE order_id=$1 ORDER BY created_at,id', [
      o.id,
    ])
  ).rows;
}
async function batch(ids: string[], action: any) {
  return ok('/api/orders/batches/preview', 'POST', { order_ids: ids, action });
}
async function queue(b: any, c = admin) {
  return ok('/api/order-batches/' + b.id + '/queue', 'POST', { confirmed: true }, c);
}
async function claim(kind: string) {
  const r = (
    await pool.query(
      "UPDATE jobs SET state='running',lease_token=$2,locked_at=now(),attempts=attempts+1 WHERE id=(SELECT id FROM jobs WHERE state='pending' AND kind=$1 ORDER BY run_at,priority,created_at,id LIMIT 1) RETURNING *",
      [kind, randomUUID()],
    )
  ).rows[0];
  assert.ok(r, 'Brak zadania ' + kind);
  return r;
}
test('własne statusy: role, RLS i powiązania między firmami', async () => {
  const s = await wf(),
    o = await order();
  assert.equal(
    (await req('/api/workflow-statuses', 'POST', { name: 'Nie', stage: 'paid' }, operator))
      .statusCode,
    403,
  );
  assert.equal(
    (
      await req(
        '/api/orders/' + o.id + '/operations',
        'POST',
        { type: 'set_workflow', status_id: s.id },
        viewer,
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await req(
        '/api/orders/' + o.id + '/operations',
        'POST',
        { type: 'set_workflow', status_id: s.id },
        other,
      )
    ).statusCode,
    404,
  );
  assert.equal(
    (await ok('/api/workflow-statuses', 'GET', undefined, other)).data.some(
      (v: any) => v.id === s.id,
    ),
    false,
  );
  assert.equal(
    (
      await req(
        '/api/automations',
        'POST',
        {
          name: 'Obcy',
          trigger: 'order.paid',
          actions: [{ type: 'set_workflow', status_id: s.id }],
        },
        other,
      )
    ).statusCode,
    422,
  );
  await tenantTx(SECOND_TENANT, async (c) => {
    assert.equal(
      (await c.query('SELECT * FROM workflow_statuses WHERE id=$1', [s.id])).rowCount,
      0,
    );
    await assert.rejects(
      () =>
        c.query('INSERT INTO workflow_statuses(id,tenant_id,name,stage) VALUES($1,$2,$3,$4)', [
          randomUUID(),
          DEMO_TENANT,
          'Obcy',
          'paid',
        ]),
      /row-level security/,
    );
  });
});
test('własny status nie obchodzi kompletacji i nadania; zgodny etap jest przypisywany', async () => {
  const paid = await wf(),
    packed = await wf('packed'),
    shipped = await wf('shipped'),
    o = await order();
  await act(o, { type: 'set_workflow', status_id: paid.id });
  assert.equal((await get(o)).status, 'paid');
  assert.equal((await get(o)).workflow_status.name, paid.name);
  await ok('/api/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/api/orders/' + o.id + '/status', { status: 'picking' }));
  assert.equal(
    (
      await req('/api/orders/' + o.id + '/operations', 'POST', {
        type: 'set_workflow',
        status_id: packed.id,
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await req('/api/orders/' + o.id + '/operations', 'POST', {
        type: 'set_workflow',
        status_id: shipped.id,
      })
    ).statusCode,
    409,
  );
  assert.equal((await get(o)).status, 'picking');
});
test('zmiana zwykłego etapu usuwa poprzednią etykietę; edycja statusu jest wersjonowana', async () => {
  const s = await wf(),
    o = await order();
  await act(o, { type: 'set_workflow', status_id: s.id });
  assert.equal(
    (await req('/api/workflow-statuses/' + s.id, 'PATCH', { ...s, stage: 'picking' })).statusCode,
    409,
  );
  const edited = await ok('/api/workflow-statuses/' + s.id, 'PATCH', {
    ...s,
    name: s.name + ' nowy',
  });
  assert.equal((await req('/api/workflow-statuses/' + s.id, 'PATCH', s)).statusCode, 409);
  await ok('/api/workflow-statuses/' + s.id, 'PATCH', { ...edited, active: false });
  assert.equal((await get(o)).workflow_status.active, false);
  assert.equal(
    (
      await req('/api/orders/' + o.id + '/operations', 'POST', {
        type: 'set_workflow',
        status_id: s.id,
      })
    ).statusCode,
    422,
  );
  await ok('/api/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/api/orders/' + o.id + '/status', { status: 'picking' }));
  assert.equal((await get(o)).workflow_status_id, null);
});
test('tagi są idempotentne, notatki mają nowe linie i limit, viewer nie zapisuje', async () => {
  const o = await order();
  await act(o, { type: 'add_tag', tag: 'Pilne' }, operator);
  const after = await get(o);
  await act(o, { type: 'add_tag', tag: 'Pilne' });
  assert.equal((await get(o)).version, after.version);
  await act(o, { type: 'add_note', note: 'Pierwsza' });
  await act(o, { type: 'add_note', note: 'Druga' });
  assert.equal((await get(o)).note, 'Pierwsza\nDruga');
  await act(o, { type: 'remove_tag', tag: 'Pilne' });
  assert.deepEqual((await get(o)).tags, []);
  await pool.query('UPDATE orders SET note=$2 WHERE id=$1', [o.id, 'a'.repeat(20000)]);
  assert.equal(
    (await req('/api/orders/' + o.id + '/operations', 'POST', { type: 'add_note', note: 'x' }))
      .statusCode,
    422,
  );
  assert.equal(
    (
      await req(
        '/api/orders/' + o.id + '/operations',
        'POST',
        { type: 'add_tag', tag: 'Nie' },
        viewer,
      )
    ).statusCode,
    403,
  );
});
test('AND: wartości, kraj, magazyn i SKU ze zdarzenia sterują trzema akcjami', async () => {
  const sku = (await pool.query('SELECT sku FROM products WHERE id=$1', [product])).rows[0].sku;
  const s = await wf('picking');
  await rule(
    [
      { type: 'add_tag', tag: 'Pilne' },
      { type: 'add_note', note: 'Przyjęte' },
      { type: 'set_workflow', status_id: s.id },
    ],
    {
      conditions: [
        { field: 'source', op: 'eq', value: 'manual' },
        { field: 'total', op: 'gte', value: 2500 },
        { field: 'country', op: 'eq', value: 'PL' },
        { field: 'warehouse_id', op: 'eq', value: warehouse },
        { field: 'sku', op: 'contains', value: sku },
        { field: 'item_count', op: 'eq', value: 1 },
      ],
    },
  );
  const o = await order('paid');
  await drain();
  const result = await get(o);
  assert.equal(result.status, 'picking');
  assert.equal(result.workflow_status_id, s.id);
  assert.deepEqual(result.tags, ['Pilne']);
  assert.equal(result.note, 'Przyjęte');
  assert.equal((await runs(o))[0].state, 'done');
});
test('OR i niespełnione warunki mają jawne wyniki bez przypadkowych zapisów', async () => {
  await rule([{ type: 'add_note', note: 'Tak' }], {
    match: 'any',
    conditions: [
      { field: 'total', op: 'gte', value: 99999 },
      { field: 'source', op: 'eq', value: 'manual' },
    ],
  });
  await rule([{ type: 'add_note', note: 'Nie' }], {
    conditions: [{ field: 'tag', op: 'contains', value: 'brak' }],
  });
  const o = await order('paid');
  await drain();
  assert.equal((await get(o)).note, 'Tak');
  const r = await runs(o);
  assert.equal(r.filter((v) => v.state === 'done').length, 1);
  assert.equal(r.filter((v) => v.state === 'skipped').length, 1);
});
test('automatyczne paid i własny status paid nie tworzą brakującej wpłaty', async () => {
  const paid = await wf();
  for (const action of [
    { type: 'set_status', status: 'paid' },
    { type: 'set_workflow', status_id: paid.id },
  ]) {
    const r = await rule([{ type: 'add_note', note: 'Nie zapisuj bez wpłaty' }, action], {
      trigger: 'order.created',
    });
    const o = await order();
    await drain();
    const result = await get(o),
      run = (await runs(o)).find((v) => v.rule_id === r.id);
    assert.equal(result.status, 'new');
    assert.equal(result.workflow_status_id, null);
    assert.equal(result.note, '');
    assert.equal(result.payment.received, 0);
    assert.equal(result.payment.amount_due, result.total);
    assert.equal(
      (await pool.query('SELECT count(*)::int AS n FROM payment_entries WHERE order_id=$1', [o.id]))
        .rows[0].n,
      0,
    );
    assert.equal(run.state, 'failed');
    assert.match(run.error, /Automatyzacja nie może potwierdzić brakującej wpłaty/);
    await pool.query('UPDATE automation_rules SET enabled=false WHERE id=$1', [r.id]);
  }
});
test('błąd drugiej akcji cofa notatkę, tagi, zdarzenia i audyt całej reguły', async () => {
  await rule([
    { type: 'add_note', note: 'Nie może zostać' },
    { type: 'set_status', status: 'packed' },
  ]);
  const o = await order('paid');
  await drain();
  const result = await get(o);
  assert.equal(result.note, '');
  assert.equal(result.status, 'paid');
  assert.equal(
    result.events.some((e: any) => e.kind === 'order.note_added'),
    false,
  );
  assert.equal((await runs(o))[0].state, 'failed');
});
test('wyłączenie lub edycja po zdarzeniu nie wykonuje starej konfiguracji', async () => {
  const r = await rule([{ type: 'add_note', note: 'Stare' }]),
    o = await order('paid');
  await ok('/api/automations/' + r.id, 'PATCH', { enabled: false, version: r.version });
  await drain();
  assert.equal((await get(o)).note, '');
  assert.match((await runs(o))[0].result.reason, /wyłączona/);
  const r2 = await rule([{ type: 'add_note', note: 'Przed zmianą' }]),
    o2 = await order('paid');
  await ok('/api/automations/' + r2.id, 'PATCH', {
    name: r2.name,
    trigger: r2.trigger,
    actions: [{ type: 'add_note', note: 'Po zmianie' }],
    version: r2.version,
  });
  assert.equal(
    (await req('/api/automations/' + r2.id, 'PATCH', { enabled: false, version: r2.version }))
      .statusCode,
    409,
  );
  await drain();
  assert.equal((await get(o2)).note, '');
});
test('reguły utworzone po zdarzeniu nie działają wstecz', async () => {
  const o = await order('paid');
  await rule([{ type: 'add_note', note: 'Wstecz' }]);
  await drain();
  assert.equal((await get(o)).note, '');
  assert.equal((await runs(o)).length, 0);
});
test('opóźnienie jest trwałe, warunki są migawką zdarzenia, nie aktualnymi tagami', async () => {
  await rule([{ type: 'add_note', note: 'Opóźnione' }], {
    delay_seconds: 60,
    conditions: [{ field: 'tag', op: 'not_contains', value: 'Późniejszy' }],
  });
  const o = await order('paid');
  await drain();
  const r = (await runs(o))[0];
  assert.equal(r.state, 'queued');
  assert.equal((await get(o)).note, '');
  const j = (await pool.query('SELECT * FROM jobs WHERE id=$1', [r.job_id])).rows[0];
  assert.ok(new Date(j.run_at).getTime() > Date.now() + 45000);
  await act(o, { type: 'add_tag', tag: 'Późniejszy' });
  await pool.query('UPDATE jobs SET run_at=now() WHERE id=$1', [j.id]);
  await drain();
  assert.equal((await get(o)).note, 'Opóźnione');
});
test('fencing i konkurencyjne workery wykonują akcję dokładnie raz', async () => {
  await rule([{ type: 'add_note', note: 'Raz' }]);
  const o = await order('paid');
  const parent = await claim('automation');
  await dispatchAutomation(parent);
  await dispatchAutomation(parent);
  await drain();
  const rs = await runs(o);
  assert.equal(rs.length, 1);
  const o2 = await order('paid');
  for (let i = 0; i < 5; i++) await Promise.all([tick(), tick(), tick()]);
  await drain();
  assert.equal((await get(o2)).note, 'Raz');
  assert.equal((await runs(o2)).length, 1);
  const o3 = await order('paid');
  await drain();
  const run = (await runs(o3))[0];
  const job = (await pool.query('SELECT * FROM jobs WHERE id=$1', [run.job_id])).rows[0];
  await processAutomation({ ...job, lease_token: randomUUID() });
  assert.equal((await get(o3)).note, 'Raz');
});
test('łańcuch własnych statusów zatrzymuje powtarzającą się regułę', async () => {
  const a = await wf(),
    b = await wf();
  await rule(
    [
      { type: 'set_workflow', status_id: b.id },
      { type: 'add_note', note: 'B' },
    ],
    {
      trigger: 'order.workflow_changed',
      conditions: [{ field: 'workflow_status_id', op: 'eq', value: a.id }],
    },
  );
  await rule(
    [
      { type: 'set_workflow', status_id: a.id },
      { type: 'add_note', note: 'A' },
    ],
    {
      trigger: 'order.workflow_changed',
      conditions: [{ field: 'workflow_status_id', op: 'eq', value: b.id }],
    },
  );
  const o = await order();
  await act(o, { type: 'set_workflow', status_id: a.id });
  await drain();
  assert.equal((await get(o)).note, 'B\nA');
  assert.ok((await runs(o)).some((r) => /powtarzającą/.test(r.result?.reason ?? '')));
});
test('opóźniona zmiana etapu nie nadpisuje późniejszej pracy operatora', async () => {
  await rule([
    { type: 'add_note', note: 'Nie zapisuj' },
    { type: 'set_status', status: 'picking' },
  ]);
  const o = await order('paid');
  await ok('/api/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/api/orders/' + o.id + '/status', { status: 'cancelled' }));
  await drain();
  assert.equal((await get(o)).note, '');
  assert.equal((await get(o)).status, 'cancelled');
  assert.match((await runs(o))[0].result.reason, /Etap zamówienia zmienił/);
});
test('utrata roli administratora blokuje wcześniej zakolejkowaną regułę', async () => {
  await rule([{ type: 'add_note', note: 'Nie' }]);
  const o = await order('paid');
  try {
    await pool.query("UPDATE memberships SET role='viewer' WHERE user_id=$1 AND tenant_id=$2", [
      adminId,
      DEMO_TENANT,
    ]);
    await drain();
    assert.equal(
      (await pool.query('SELECT note FROM orders WHERE id=$1', [o.id])).rows[0].note,
      '',
    );
    assert.match((await runs(o))[0].result.reason, /uprawnień/);
  } finally {
    await pool.query("UPDATE memberships SET role='admin' WHERE user_id=$1 AND tenant_id=$2", [
      adminId,
      DEMO_TENANT,
    ]);
  }
});
test('podgląd reguły nie zmienia zamówienia, zdarzeń, audytu ani kolejki', async () => {
  const r = await rule([
      { type: 'add_tag', tag: 'Preview' },
      { type: 'add_note', note: 'Preview' },
    ]),
    o = await order('paid');
  const before = await get(o),
    counts = await pool.query(
      'SELECT (SELECT count(*) FROM jobs) AS jobs,(SELECT count(*) FROM audit_events) AS audit',
    );
  const p = await ok('/api/automations/' + r.id + '/preview', 'POST', { order_id: o.id });
  assert.equal(p.allowed, true);
  assert.deepEqual(await get(o), before);
  assert.deepEqual(
    (
      await pool.query(
        'SELECT (SELECT count(*) FROM jobs) AS jobs,(SELECT count(*) FROM audit_events) AS audit',
      )
    ).rows,
    counts.rows,
  );
});
test('podgląd masowy używa rzeczywistych kontroli, bez zapisania statusów i rezerwacji', async () => {
  const a = await order('paid'),
    b = await order();
  const p = await batch([a.id, b.id], { type: 'set_status', status: 'picking' });
  assert.equal(p.items.filter((i: any) => i.allowed).length, 1);
  assert.equal((await get(a)).status, 'paid');
  assert.equal((await get(b)).status, 'new');
  assert.equal(
    (await req('/api/order-batches/' + p.id + '/queue', 'POST', { confirmed: false })).statusCode,
    422,
  );
  await queue(p);
  await drain();
  const result = await ok('/api/order-batches/' + p.id);
  assert.equal(result.state, 'done');
  assert.equal(result.items.filter((i: any) => i.state === 'done').length, 1);
  assert.equal(result.items.filter((i: any) => i.state === 'skipped').length, 1);
  assert.equal((await get(a)).status, 'picking');
  assert.equal((await get(b)).status, 'new');
});
test('zmiana zamówienia po podglądzie powoduje pominięcie, także po zmianie i cofnięciu tagu', async () => {
  const a = await order(),
    b = await order(),
    p = await batch([a.id, b.id], { type: 'add_note', note: 'Masowo' });
  await act(a, { type: 'add_tag', tag: 'X' });
  await act(a, { type: 'remove_tag', tag: 'X' });
  await queue(p);
  await drain();
  const result = await ok('/api/order-batches/' + p.id);
  assert.equal(result.items.find((i: any) => i.order_id === a.id).state, 'skipped');
  assert.equal((await get(a)).note, '');
  assert.equal((await get(b)).note, 'Masowo');
});
test('operacje ponad 10 pozycji wznawiają kolejne partie i replay nie powtarza notatki', async () => {
  const os = [];
  for (let i = 0; i < 13; i++) os.push(await order());
  const b = await batch(
    os.map((o) => o.id),
    { type: 'add_note', note: 'Partia' },
  );
  await queue(b);
  await queue(b);
  const j = await claim('orders.batch');
  await processBatch(j);
  const middle = await ok('/api/order-batches/' + b.id);
  assert.equal(middle.state, 'queued');
  assert.equal(middle.items.filter((i: any) => i.state === 'done').length, 10);
  await processBatch(j);
  assert.equal(
    (await ok('/api/order-batches/' + b.id)).items.filter((i: any) => i.state === 'done').length,
    10,
  );
  await drain();
  assert.equal((await ok('/api/order-batches/' + b.id)).state, 'done');
  for (const o of os) assert.equal((await get(o)).note, 'Partia');
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM jobs WHERE kind='orders.batch' AND payload->>'batch_id'=$1",
        [b.id],
      )
    ).rows[0].n,
    1,
  );
});
test('masowe anulowanie zwalnia rezerwację dokładnie raz', async () => {
  const o = await order(),
    before = (
      await pool.query('SELECT reserved FROM stock WHERE product_id=$1 AND warehouse_id=$2', [
        product,
        warehouse,
      ])
    ).rows[0].reserved;
  const p = await batch([o.id], { type: 'set_status', status: 'cancelled' });
  await queue(p);
  await drain();
  await queue(p);
  await drain();
  const after = (
    await pool.query('SELECT reserved FROM stock WHERE product_id=$1 AND warehouse_id=$2', [
      product,
      warehouse,
    ])
  ).rows[0].reserved;
  assert.equal(after, before - 1);
  assert.equal((await get(o)).status, 'cancelled');
});
test('operacje masowe: obce ID, duplikaty, role, autor i wygasły podgląd są odrzucane', async () => {
  const o = await order();
  assert.equal(
    (
      await req('/api/orders/batches/preview', 'POST', {
        order_ids: [o.id, o.id],
        action: { type: 'add_tag', tag: 'X' },
      })
    ).statusCode,
    422,
  );
  assert.equal(
    (
      await req('/api/orders/batches/preview', 'POST', {
        order_ids: [o.id, randomUUID()],
        action: { type: 'add_tag', tag: 'X' },
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await req(
        '/api/orders/batches/preview',
        'POST',
        { order_ids: [o.id], action: { type: 'add_tag', tag: 'X' } },
        viewer,
      )
    ).statusCode,
    403,
  );
  const p = await batch([o.id], { type: 'add_tag', tag: 'X' });
  assert.equal((await req('/api/order-batches/' + p.id, 'GET', undefined, other)).statusCode, 404);
  assert.equal(
    (await req('/api/order-batches/' + p.id + '/queue', 'POST', { confirmed: true }, operator))
      .statusCode,
    403,
  );
  await pool.query("UPDATE order_batches SET created_at=now()-interval '31 minutes' WHERE id=$1", [
    p.id,
  ]);
  assert.equal(
    (await req('/api/order-batches/' + p.id + '/queue', 'POST', { confirmed: true })).statusCode,
    409,
  );
});
test('nieaktualna dzierżawa i cofnięta rola nie zapisują partii', async () => {
  const o = await order(),
    p = await batch([o.id], { type: 'add_tag', tag: 'Nie' });
  await queue(p);
  const j = await claim('orders.batch');
  await processBatch({ ...j, lease_token: randomUUID() });
  assert.deepEqual((await get(o)).tags, []);
  await pool.query("UPDATE jobs SET state='pending',lease_token=NULL WHERE id=$1", [j.id]);
  try {
    await pool.query("UPDATE memberships SET role='viewer' WHERE user_id=$1 AND tenant_id=$2", [
      adminId,
      DEMO_TENANT,
    ]);
    await drain();
    const result = (await pool.query('SELECT * FROM order_batches WHERE id=$1', [p.id])).rows[0];
    assert.equal(result.state, 'failed');
    assert.deepEqual(
      (await pool.query('SELECT tags FROM orders WHERE id=$1', [o.id])).rows[0].tags,
      [],
    );
    assert.equal(
      (await pool.query('SELECT state FROM order_batch_items WHERE batch_id=$1', [p.id])).rows[0]
        .state,
      'skipped',
    );
  } finally {
    await pool.query("UPDATE memberships SET role='admin' WHERE user_id=$1 AND tenant_id=$2", [
      adminId,
      DEMO_TENANT,
    ]);
  }
});
test('listy filtrują własny status i tagi, historia ma izolowaną paginację', async () => {
  const s = await wf(),
    o = await order();
  await act(o, { type: 'set_workflow', status_id: s.id });
  await act(o, { type: 'add_tag', tag: 'FILTER' });
  const list = await ok('/api/orders?workflow_status_id=' + s.id + '&tag=FILTER');
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0].workflow_status.name, s.name);
  assert.equal((await req('/api/automation-runs?after=bad')).statusCode, 422);
  assert.equal((await ok('/api/automation-runs', 'GET', undefined, other)).data.length, 0);
  assert.equal((await ok('/api/order-batches', 'GET', undefined, other)).data.length, 0);
});
test('liczniki panelu statusów zgadzają się z listą zamówień i są izolowane', async () => {
  const s = await wf(),
    before = await ok('/api/orders/status-counts'),
    o = await order();
  await act(o, { type: 'set_workflow', status_id: s.id });
  const st = (await get(o)).status;
  const after = await ok('/api/orders/status-counts');
  assert.equal(after.total, before.total + 1);
  assert.equal(after.statuses[st], (before.statuses[st] ?? 0) + 1);
  assert.equal(after.workflow[s.id], 1);
  const all = (await ok('/api/orders?limit=200&status=' + st)).data;
  if (all.length < 200) assert.equal(all.length, after.statuses[st]);
  assert.equal((await ok('/api/orders?workflow_status_id=' + s.id)).data.length, 1);
  const row = (await ok('/api/orders?workflow_status_id=' + s.id)).data[0];
  assert.equal(row.first_item_name, 'Operacje testowe');
  assert.equal(row.line_count, 1);
  assert.equal(row.quantity_total, 1);
  assert.equal(row.item_count, 1);
  assert.equal(row.payment_mode, 'prepaid');
  const { balance } = await ok('/api/orders/' + o.id + '/payments');
  assert.equal(row.payment_received, balance.net);
  assert.equal(row.amount_due, balance.amount_due);
  assert.equal(row.payment_summary, undefined);
  await ok('/api/workflow-statuses/' + s.id, 'PATCH', { ...s, active: false });
  assert.equal((await ok('/api/orders/status-counts')).workflow[s.id], undefined);
  const foreign = await ok('/api/orders/status-counts', 'GET', undefined, other);
  assert.equal(foreign.workflow[s.id], undefined);
  assert.equal(foreign.total, Object.values(foreign.statuses).reduce((a: number, b: any) => a + b, 0));
  assert.equal((await app.inject({ url: '/api/orders/status-counts' })).statusCode, 401);
});
test('zmiana znaczenia własnego statusu po podglądzie nie wykonuje innej operacji', async () => {
  const s = await wf(),
    o = await order(),
    b = await batch([o.id], { type: 'set_workflow', status_id: s.id });
  await ok('/api/workflow-statuses/' + s.id, 'PATCH', { ...s, stage: 'cancelled' });
  await queue(b);
  await drain();
  const result = await ok('/api/order-batches/' + b.id);
  assert.equal(result.items[0].state, 'failed');
  assert.match(result.items[0].error, /status zmienił/);
  assert.equal((await get(o)).status, 'new');
  const target = await wf('picking');
  await rule([
    { type: 'add_note', note: 'Nie zapisuj' },
    { type: 'set_workflow', status_id: target.id },
  ]);
  const a = await order('paid');
  await ok('/api/workflow-statuses/' + target.id, 'PATCH', { ...target, stage: 'cancelled' });
  await drain();
  assert.equal((await get(a)).status, 'paid');
  assert.equal((await get(a)).note, '');
  assert.equal((await runs(a))[0].state, 'failed');
});
test('priorytet decyduje o kolejności przejmowania zadań tego samego zdarzenia', async () => {
  await rule([{ type: 'add_note', note: 'HIGH' }], { priority: 80 });
  const low = await rule([{ type: 'add_note', note: 'LOW' }], { priority: 10 });
  const o = await order('paid');
  while (
    (await pool.query("SELECT id FROM jobs WHERE kind='automation' AND state='pending'")).rowCount
  ) {
    await dispatchAutomation(await claim('automation'));
  }
  const j = await claim('automation.run');
  const r = (await pool.query('SELECT rule_id FROM automation_runs WHERE job_id=$1', [j.id]))
    .rows[0];
  assert.equal(r.rule_id, low.id);
  await processAutomation(j);
  await drain();
  assert.equal((await get(o)).note, 'LOW\nHIGH');
});
test('wyczerpana dzierżawa daje końcowy błąd historii zamiast wiecznego oczekiwania', async () => {
  await rule([{ type: 'add_note', note: 'Nie' }]);
  const o = await order('paid');
  while (
    (await pool.query("SELECT id FROM jobs WHERE kind='automation' AND state='pending'")).rowCount
  )
    await dispatchAutomation(await claim('automation'));
  const j = await claim('automation.run');
  await pool.query(
    "UPDATE jobs SET attempts=max_attempts,locked_at=now()-interval '3 minutes' WHERE id=$1",
    [j.id],
  );
  await drain();
  assert.equal((await runs(o))[0].state, 'failed');
  assert.equal((await get(o)).note, '');
  const b = await batch([o.id], { type: 'add_note', note: 'Nie' });
  await queue(b);
  const jb = await claim('orders.batch');
  await pool.query(
    "UPDATE jobs SET attempts=max_attempts,locked_at=now()-interval '3 minutes' WHERE id=$1",
    [jb.id],
  );
  await drain();
  const result = await ok('/api/order-batches/' + b.id);
  assert.equal(result.state, 'failed');
  assert.equal(result.items[0].state, 'skipped');
});
test('rozgałęzione reguły mają wspólny limit 100 wykonań i jawny wynik zatrzymania', async () => {
  for (let i = 0; i < 10; i++)
    await rule([{ type: 'add_note', note: 'Łańcuch ' + i }], { trigger: 'order.note_added' });
  const o = await order();
  await act(o, { type: 'add_note', note: 'START' });
  let drained = false;
  for (let i = 0; i < 400; i++)
    if (!(await tick())) {
      drained = true;
      break;
    }
  assert.ok(drained, 'Rozgałęzienie nie zatrzymało kolejki');
  const rs = await runs(o),
    real = rs.filter((r) => !r.definition.limit_notice),
    notices = rs.filter((r) => r.definition.limit_notice);
  assert.equal(real.length, 100);
  assert.ok(notices.length > 0);
  assert.ok(notices.every((r) => r.state === 'skipped' && r.result.suppressed_rules > 0));
  assert.ok((await get(o)).note.split('\n').length <= 101);
});
test('AUTO-06: grupy warunków AND/OR działają przez prawdziwy worker', async () => {
  const sku = (await pool.query('SELECT sku FROM products WHERE id=$1', [product])).rows[0].sku;
  const yes = await rule([{ type: 'add_tag', tag: 'Grupa' }], {
    conditions: [
      { field: 'source', op: 'eq', value: 'manual' },
      {
        group: {
          match: 'any',
          conditions: [
            { field: 'country', op: 'eq', value: 'DE' },
            { field: 'sku', op: 'contains', value: sku },
          ],
        },
      },
    ],
  });
  const no = await rule([{ type: 'add_note', note: 'Nie grupa' }], {
    match: 'any',
    conditions: [
      { field: 'total', op: 'gte', value: 99999999 },
      {
        group: {
          match: 'all',
          conditions: [
            { field: 'country', op: 'eq', value: 'PL' },
            { field: 'currency', op: 'eq', value: 'EUR' },
          ],
        },
      },
    ],
  });
  assert.deepEqual(yes.config.conditions[1].group.match, 'any');
  const o = await order('paid');
  await drain();
  const result = await get(o);
  assert.deepEqual(result.tags, ['Grupa']);
  assert.equal(result.note, '');
  const r = await runs(o);
  assert.equal(r.find((v) => v.rule_id === yes.id).state, 'done');
  assert.equal(r.find((v) => v.rule_id === no.id).state, 'skipped');
  assert.equal(r.find((v) => v.rule_id === yes.id).definition.conditions[1].group.conditions.length, 2);
  const listed = (await ok('/api/automations')).data.find((v: any) => v.id === yes.id);
  assert.equal(listed.definition.conditions[1].group.match, 'any');
});
test('AUTO-06: grupy są ograniczone, a odwołania w grupie sprawdzane w firmie', async () => {
  const foreign = (await ok('/api/warehouses', 'GET', undefined, other)).data[0].id;
  assert.notEqual(foreign, warehouse);
  const base = { name: 'Grupa limit', trigger: 'order.paid', actions: [{ type: 'add_note', note: 'X' }] };
  const leaf = { field: 'source', op: 'eq', value: 'manual' };
  const foreignGroup = await req('/api/automations', 'POST', {
    ...base,
    conditions: [{ group: { match: 'all', conditions: [{ field: 'warehouse_id', op: 'eq', value: foreign }] } }],
  });
  assert.equal(foreignGroup.statusCode, 422, foreignGroup.body);
  assert.match(foreignGroup.json().detail ?? foreignGroup.body, /spoza organizacji/);
  const nested = await req('/api/automations', 'POST', {
    ...base,
    conditions: [{ group: { match: 'all', conditions: [{ group: { match: 'any', conditions: [leaf] } }] } }],
  });
  assert.equal(nested.statusCode, 422, nested.body);
  const tooMany = await req('/api/automations', 'POST', {
    ...base,
    conditions: [leaf, { group: { match: 'any', conditions: Array.from({ length: 10 }, () => leaf) } }],
  });
  assert.equal(tooMany.statusCode, 422, tooMany.body);
  assert.match(tooMany.body, /10 warunków/);
  const empty = await req('/api/automations', 'POST', { ...base, conditions: [{ group: { match: 'all', conditions: [] } }] });
  assert.equal(empty.statusCode, 422, empty.body);
  const extra = await req('/api/automations', 'POST', {
    ...base,
    conditions: [{ group: { match: 'all', conditions: [leaf], depth: 2 } }],
  });
  assert.equal(extra.statusCode, 422, extra.body);
  const r = await rule([{ type: 'add_note', note: 'OK' }]);
  const patched = await req('/api/automations/' + r.id, 'PATCH', {
    ...base,
    version: r.version,
    conditions: [{ group: { match: 'any', conditions: [{ field: 'warehouse_id', op: 'eq', value: foreign }] } }],
  });
  assert.equal(patched.statusCode, 422, patched.body);
});
test('AUTO-06: podgląd pokazuje łańcuch warunków, akcji i zależnych reguł bez zmian', async () => {
  const s = await wf('picking');
  const main = await rule(
    [
      { type: 'add_tag', tag: 'Łańcuch' },
      { type: 'set_workflow', status_id: s.id },
    ],
    {
      delay_seconds: 30,
      conditions: [
        { field: 'source', op: 'eq', value: 'manual' },
        {
          group: {
            match: 'any',
            conditions: [
              { field: 'country', op: 'eq', value: 'DE' },
              { field: 'total', op: 'gte', value: 1 },
            ],
          },
        },
      ],
    },
  );
  const tagged = await rule([{ type: 'add_note', note: 'Po tagu' }], {
    trigger: 'order.tags_changed',
    delay_seconds: 120,
    priority: 5,
    conditions: [{ field: 'tag', op: 'contains', value: 'Łańcuch' }],
  });
  const staged = await rule([{ type: 'add_note', note: 'Po etapie' }], { trigger: 'order.picking' });
  const disabled = await rule([{ type: 'add_note', note: 'Wyłączona' }], { trigger: 'order.tags_changed', enabled: false });
  const self = await rule([{ type: 'add_note', note: 'Siebie' }], { trigger: 'order.note_added' });
  const o = await order('paid');
  await drain();
  const before = await get(o),
    counts = async () =>
      (
        await pool.query(
          'SELECT (SELECT count(*) FROM jobs) AS jobs,(SELECT count(*) FROM audit_events) AS audit,(SELECT count(*) FROM automation_runs) AS runs,(SELECT count(*) FROM order_events) AS events',
        )
      ).rows;
  const was = await counts();
  const p = await ok('/api/automations/' + main.id + '/preview', 'POST', { order_id: o.id });
  assert.equal(p.matched, true);
  const chain = p.chain;
  assert.equal(chain.trigger, 'order.paid');
  assert.equal(chain.delay_seconds, 30);
  assert.equal(chain.depth_limit, 8);
  assert.equal(chain.conditions[0].matched, true);
  assert.equal(chain.conditions[1].group.matched, true);
  assert.deepEqual(chain.conditions[1].group.conditions.map((c: any) => c.matched), [false, true]);
  assert.deepEqual(chain.actions[0].emits.map((e: any) => e.trigger), ['order.tags_changed']);
  const deps = chain.actions[0].emits[0].rules;
  assert.ok(deps.some((d: any) => d.id === tagged.id && d.delay_seconds === 120 && d.priority === 5 && d.estimate === false));
  assert.ok(!deps.some((d: any) => d.id === disabled.id || d.id === main.id));
  assert.deepEqual(chain.actions[1].emits.map((e: any) => e.trigger), ['order.picking', 'order.workflow_changed']);
  assert.ok(chain.actions[1].emits[0].rules.some((d: any) => d.id === staged.id && d.estimate === true));
  const sp = await ok('/api/automations/' + self.id + '/preview', 'POST', { order_id: o.id });
  assert.equal(sp.chain.actions[0].emits[0].skips_self, true);
  assert.ok(!sp.chain.actions[0].emits[0].rules.some((d: any) => d.id === self.id));
  assert.deepEqual(await get(o), before);
  assert.deepEqual(await counts(), was);
});
