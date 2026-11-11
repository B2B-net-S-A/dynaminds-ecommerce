// Explicitly local, synthetic QA. Uses documented demo credentials; never prints credentials.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { pool } from '../server/db';
import { tokenHash } from '../server/security';
import { apiScopes } from '../server/developer-api';
assert.equal(process.env.DYNA_QA_RUN, 'stage012', 'Wymagana jawna zgoda na lokalny proces QA');
let cookie = '';
async function adminRequest(path: string, body: unknown, method = 'POST') {
  const r = await fetch('http://127.0.0.1:4100/api' + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await r.json();
  assert(r.ok, `${path}: ${r.status}`);
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
  return data;
}
await adminRequest('/auth/login', { email: 'admin@demo.local', password: 'DynaDemo!2026' });
await adminRequest('/workspaces/switch', { tenant_id: '96fa8749-1da7-46f7-9997-c4527c2474bf' });
const qaKey = await adminRequest('/developer/keys', {
  name: 'QA HTTP stage012',
  scopes: [...apiScopes],
  expires_days: 1,
});
try {
  const token = qaKey.token;
  const tenant = (
    await pool.query(
      'SELECT t.id,t.name FROM api_keys k JOIN tenants t ON t.id=k.tenant_id WHERE k.token_hash=$1 AND k.revoked_at IS NULL AND k.expires_at>now()',
      [tokenHash(token)],
    )
  ).rows[0];
  assert.equal(
    tenant?.name,
    'QA SaaS 20261004',
    'Klucz musi dotyczyć wyłącznie syntetycznej firmy QA',
  );
  const sub = (
    await pool.query(
      "SELECT id FROM outbound_subscriptions WHERE tenant_id=$1 AND name='QA API — skrzynka lokalna' AND mode='local' AND enabled AND revoked_at IS NULL",
      [tenant.id],
    )
  ).rows;
  assert.equal(sub.length, 1, 'Wymagana włączona skrzynka lokalna utworzona w UI');
  const baseline = (
    await pool.query(
      'SELECT t.id,t.name,count(o.id)::int AS orders FROM tenants t LEFT JOIN orders o ON o.tenant_id=t.id WHERE t.id<>$1 GROUP BY t.id,t.name ORDER BY t.id',
      [tenant.id],
    )
  ).rows;
  const observations: { method: string; path: string; status: number }[] = [];
  async function request(
    path: string,
    method = 'GET',
    body?: unknown,
    extra: Record<string, string> = {},
  ) {
    const r = await fetch('http://127.0.0.1:4100/api/v1' + path, {
      method,
      headers: {
        Authorization: 'Bearer ' + token,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...extra,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    observations.push({ method, path, status: r.status });
    const data = await r.json();
    return { status: r.status, data };
  }
  async function ok(path: string, method = 'GET', body?: unknown, extra?: Record<string, string>) {
    const r = await request(path, method, body, extra);
    assert([200, 201].includes(r.status), `${method} ${path}: ${r.status} ${r.data.detail ?? ''}`);
    return r.data;
  }
  const warehouse = (await ok('/warehouses')).data.find((w: any) => w.code === 'MAIN');
  assert(warehouse);
  const sku = 'API-QA-' + randomUUID().slice(0, 8);
  const p = await ok('/products', 'POST', {
    name: 'QA — pełny proces publicznego API',
    sku,
    price: 12345,
    quantity: 5,
    warehouse_id: warehouse.id,
  });
  const body = {
    customer_name: 'QA Kupujący API',
    email: 'buyer-api@example.test',
    warehouse_id: warehouse.id,
    shipping_cost: 1499,
    items: [{ product_id: p.id, quantity: 2 }],
  };
  const idem = { 'Idempotency-Key': randomUUID() };
  assert.equal((await request('/orders', 'POST', body)).status, 422);
  const order = await ok('/orders', 'POST', body, idem);
  const replay = await ok('/orders', 'POST', body, idem);
  assert.equal(order.id, replay.id);
  const stock = async () =>
    (await ok('/inventory?product_id=' + p.id + '&warehouse_id=' + warehouse.id)).data.find(
      (s: any) => s.product_id === p.id && s.warehouse_id === warehouse.id,
    );
  assert.equal((await stock()).reserved, 2);
  const status = (s: string) => ok('/orders/' + order.id + '/status', 'PATCH', { status: s });
  await status('paid');
  await status('picking');
  assert.equal(
    (await request('/orders/' + order.id + '/status', 'PATCH', { status: 'packed' })).status,
    409,
  );
  await ok('/orders/' + order.id + '/scan', 'POST', { code: sku });
  await ok('/orders/' + order.id + '/scan', 'POST', { code: sku });
  await status('packed');
  await ok('/orders/' + order.id + '/ship-demo', 'POST', {});
  await ok('/orders/' + order.id + '/documents', 'POST', { kind: 'invoice' });
  await status('delivered');
  await status('completed');
  await status('return_initiated');
  await status('return_received');
  await ok('/orders/' + order.id + '/documents', 'POST', { kind: 'correction' });
  await status('return_completed');
  await ok('/orders/' + order.id + '/operations', 'POST', {
    type: 'add_note',
    note: 'QA zakończone — treść notatki nie trafia do webhooka.',
  });
  const final = await ok('/orders/' + order.id),
    inventory = await stock();
  assert.equal(final.status, 'return_completed');
  assert.equal(final.total, 26189);
  assert.equal(inventory.on_hand, 5);
  assert.equal(inventory.reserved, 0);
  assert.equal(final.documents.length, 2);
  assert(final.documents.every((d: any) => d.mode === 'demo'));
  assert.equal(final.shipments[0].mode, 'demo');
  let deliveries: any[] = [];
  for (let n = 0; n < 30; n++) {
    deliveries = (
      await pool.query(
        "SELECT d.id,d.state,d.response_status,j.attempts,e.event_type,i.delivery_id AS receipt_id FROM outbound_deliveries d JOIN outbound_events e ON (e.tenant_id,e.id)=(d.tenant_id,d.event_id) JOIN jobs j ON (j.tenant_id,j.id)=(d.tenant_id,d.job_id) LEFT JOIN local_webhook_inbox i ON (i.tenant_id,i.delivery_id)=(d.tenant_id,d.id) WHERE d.tenant_id=$1 AND d.subscription_id=$2 AND e.payload->'order'->>'id'=$3 ORDER BY d.created_at,d.id",
        [tenant.id, sub[0].id, order.id],
      )
    ).rows;
    if (
      deliveries.length >= 13 &&
      deliveries.every((d) => d.state === 'delivered' && d.receipt_id === d.id)
    )
      break;
    await setTimeout(1000);
  }
  assert.equal(deliveries.length, 13);
  assert.equal(new Set(deliveries.map((d) => d.event_type)).size, 4);
  assert(
    deliveries.every(
      (d) => d.state === 'delivered' && d.response_status === 202 && d.receipt_id === d.id,
    ),
  );
  const after = (
    await pool.query(
      'SELECT t.id,t.name,count(o.id)::int AS orders FROM tenants t LEFT JOIN orders o ON o.tenant_id=t.id WHERE t.id<>$1 GROUP BY t.id,t.name ORDER BY t.id',
      [tenant.id],
    )
  ).rows;
  assert.deepEqual(after, baseline);
  const quotas = (
    await pool.query(
      'SELECT resource,used::int FROM workspace_usage WHERE tenant_id=$1 ORDER BY resource',
      [tenant.id],
    )
  ).rows;
  await adminRequest('/developer/keys/' + qaKey.id, undefined, 'DELETE');
  assert.equal((await request('/orders')).status, 401);
  const report = {
    checked_at: new Date().toISOString(),
    mode: 'native HTTP + PostgreSQL + running worker; no injected transport',
    organization: tenant,
    product: { id: p.id, sku },
    order: {
      id: order.id,
      number: order.number,
      status: final.status,
      total: final.total,
      currency: final.currency,
    },
    inventory: { on_hand: inventory.on_hand, reserved: inventory.reserved },
    documents: final.documents.map((d: any) => ({
      id: d.id,
      kind: d.kind,
      mode: d.mode,
      number: d.number,
    })),
    shipment: { mode: final.shipments[0].mode },
    idempotency_replay: true,
    packing_guard: true,
    revoked_key_http_status: 401,
    deliveries,
    observations,
    unrelated_organizations_preserved: after,
    quotas,
  };
  await writeFile('docs/developer-qa.json', JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify({
      order: report.order,
      inventory: report.inventory,
      deliveries: deliveries.length,
      all_delivered: true,
      other_organizations_unchanged: true,
    }),
  );
} finally {
  await adminRequest('/developer/keys/' + qaKey.id, undefined, 'DELETE').catch(() => {});
  await adminRequest('/auth/logout', {}).catch(() => {});
  await pool.end();
}
