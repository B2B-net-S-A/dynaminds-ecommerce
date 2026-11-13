import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool } from '../server/db';
import { seed } from './fixtures';
import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { adjustmentActor } from './stocktake-adjustments-fixture';
import { sourceCatalogStockControl, previewCatalogStockControl, commitCatalogStockControl } from '../server/catalog-stock-control';
import type { CatalogStockControlWarehouse } from '../server/catalog-stock-control-schema';
import { bootstrap151169, install152169, fixture169, facts169, physicalExact169, own169,
  consent169, wait169, type Fixture169, type Facts, type Row } from './catalog-stock-control169-fixture';

// SOURCE_AUTHORED_NOT_RUN. Root owns execution in the numeric disposable DB.
// Historical ordinary receipt is genuinely born on151 before152 installation.
// Every physical source and key is ordinary API; only deliberate IAM intrusion
// and a real orders row lock use owner SQL. No private receipt/admission seed.
let app: Awaited<ReturnType<typeof buildApp>>, providerCalls = 0;
const one = (xs: Row[]) => { assert.equal(xs.length, 1); return xs[0]; };
type Intake = Awaited<ReturnType<typeof intake>>;
let historical: Intake, historicalReceipt: Row;
const options = { integrationTransport: async () => {
  providerCalls++; throw new Error('No provider in return replay authority169');
} };
before(async () => {
  await bootstrap151169(); await seed();
  app = await buildApp(options);
  historical = await intake(false);
  await historical.ok(historical.path, 'POST', historical.body, 200, historical.key);
  historicalReceipt = one(own169(await facts169(), 'return_cases', historical.tenant));
  assert(historicalReceipt.receipt); assert.equal(historicalReceipt.received_at === null, false);
  assert.equal((await pool.query("SELECT to_regclass('public.catalog_stock_return_receipts') r")).rows[0].r, null);
  await app.close(); await install152169(); app = await buildApp(options);
});
after(async () => { try { assert.equal(providerCalls, 0); await app?.close(); } finally { await pool.end(); } });

async function activate(f: Fixture169) {
  const publicSource = await f.ok('/catalog-stock-control/catalogs/' + f.primary.id + '/source');
  assert.equal(publicSource.writers_available, false); assert.equal(publicSource.activation_available, false);
  const prior = await facts169(), ctx = { writersAvailable: true };
  const { source } = await sourceCatalogStockControl(f.actor, f.primary.id, ctx);
  assert.equal(source.ready, true); assert.deepEqual(source.blockers, []);
  const { preview } = await previewCatalogStockControl(f.actor, f.primary.id, {
    client_key: randomUUID(), catalog_version: source.snapshot.catalog.version, policy_version: source.snapshot.policy.version,
    warehouse_policy_versions: source.snapshot.warehouses.map((w: CatalogStockControlWarehouse) => ({ warehouse_id: w.id, version: w.policy.version })),
    series_versions: source.snapshot.warehouses.map((w: CatalogStockControlWarehouse) => ({ warehouse_id: w.id, version: w.series.version })),
  }, ctx);
  assert.equal(preview.ready, true);
  assert.equal((await commitCatalogStockControl(f.actor, preview.id, consent169(preview), ctx)).operation.after.strict, true);
  physicalExact169(prior, await facts169());
}
async function intake(strict = true) {
  const f = await fixture169(app, false);
  let order = await f.ok('/orders', 'POST', {
    source: 'manual', customer_name: 'Own replay authority', email: 'replay169@example.test',
    address: { street: 'Own replay', city: 'Warszawa', postal_code: '00-169', country: 'PL', phone: '500000169' },
    warehouse_id: f.warehouse.id, payment_mode: 'prepaid', currency: 'PLN', shipping_cost: 0,
    items: [{ product_id: f.products[0].id, quantity: 1 }],
  }, 201);
  order = await f.ok('/orders/' + order.id);
  await f.ok('/orders/' + order.id + '/payments', 'POST', { client_key: randomUUID(), version: Number(order.version),
    kind: 'receipt', amount: order.total, currency: 'PLN', method: 'other', reference: 'Own local declaration', confirmed: true });
  await f.ok('/orders/' + order.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => f.ok(orderPath, 'GET', undefined), '/orders/' + order.id + '/status', { status: 'picking' }));
  await f.ok('/orders/' + order.id + '/scan', 'POST', { client_key: randomUUID(), code: f.products[0].sku, location: 'A-01' });
  await f.ok('/orders/' + order.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => f.ok(orderPath, 'GET', undefined), '/orders/' + order.id + '/status', { status: 'packed' }));
  await f.ok('/orders/' + order.id + '/ship-demo', 'POST', {});
  order = await f.ok('/orders/' + order.id); assert.equal(order.status, 'shipped');
  // Reservations are consumed; no requested RMA exists at real BO consent.
  if (strict) await activate(f);
  const created = await f.ok('/orders/' + order.id + '/returns', 'POST', { client_key: randomUUID(),
    reason: 'Actual ordinary replay authority', shipping_refund: 0,
    items: order.items.map((i: Row) => ({ item_id: i.id, quantity: i.quantity })),
  }, 201);
  const rma = await f.ok('/returns/' + created.id);
  const key = await f.ok('/developer/keys', 'POST', { name: 'Exact orders-write-only receive identity', scopes: ['orders:write'] }, 201);
  assert.deepEqual(one((await pool.query('SELECT scopes FROM public.api_keys WHERE tenant_id=$1 AND id=$2', [f.tenant, key.id])).rows).scopes, ['orders:write']);
  const body = { version: Number(rma.version), shipping_refund: 0, note: 'Exact saved ordinary intake body',
    items: rma.items.map((i: Row) => ({ item_id: i.item_id, accepted: i.requested, restocked: i.requested })) };
  return { ...f, order, rma, key, body, path: '/returns/' + rma.id + '/receive' };
}
async function saved(withKey = true) {
  const f = await intake();
  const beforeRows = await facts169();
  const result = await f.ok(f.path, 'POST', f.body, 200, withKey ? f.key : undefined);
  const accepted = await facts169();
  const receipt = one(own169(accepted, 'catalog_stock_return_receipts', f.tenant));
  const admission = one(own169(accepted, 'catalog_stock_return_admissions', f.tenant));
  const document = one(own169(accepted, 'catalog_stock_return_documents', f.tenant));
  assert.equal(receipt.id, admission.id); assert.equal(admission.sealed, true);
  assert.equal(admission.actor_id, f.user); assert.equal(admission.api_key_id, withKey ? f.key.id : null);
  assert.equal(admission.protocol, 'rma'); assert.deepEqual(admission.frame.request, f.body);
  assert.equal(receipt.return_id, f.rma.id); assert.equal(document.receipt_id, receipt.id);
  assert.equal(document.payload.kind, 'PZ'); assert.equal(document.payload.quantity, '1'); assert.equal(String(document.sequence), '1');
  const stock = one(own169(accepted, 'stock', f.tenant).filter(x => x.product_id === f.products[0].id && x.warehouse_id === f.warehouse.id));
  const oldStock = one(own169(beforeRows, 'stock', f.tenant).filter(x => x.product_id === f.products[0].id && x.warehouse_id === f.warehouse.id));
  assert.equal(stock.on_hand, oldStock.on_hand + 1); assert.equal(stock.reserved, oldStock.reserved);
  assert.equal(result.refund_amount, f.order.total);
  return { ...f, result, receipt, admission };
}

test('saved strict OFF ordinary169 receipt binds exact actor/key/body; same identity replay is pure, other real key and other current actor409', async () => {
  const f = await saved();
  const otherKey = await f.ok('/developer/keys', 'POST', { name: 'Different actual key same actor', scopes: ['orders:write'] }, 201);
  const otherActor = await adjustmentActor(app, f.tenant, 'other@demo.local');
  const beforeRows = await facts169();
  assert.notEqual(otherActor.user, f.user);
  // A pure replay answers the saved receipt marked reused (returnReceiveOutcome, server/returns.ts).
  assert.deepEqual(await f.ok(f.path, 'POST', f.body, 200, f.key), { ...f.result, reused: true });
  assert.deepEqual(await facts169(), beforeRows);
  assert.equal((await f.request(f.path, 'POST', f.body, otherKey)).statusCode, 409);
  assert.deepEqual(await facts169(), beforeRows);
  assert.equal((await otherActor.request(f.path, 'POST', f.body)).statusCode, 409);
  assert.deepEqual(await facts169(), beforeRows);
  assert.equal((await f.request(f.path, 'POST', { ...f.body, note: 'Changed historical receive note' }, f.key)).statusCode, 409);
  assert.deepEqual(await facts169(), beforeRows, 'No new number, admission, PZ, physical/financial/journal/session effect on any replay refusal');
  // Independently isolate actor binding: both receives now have NULL API key,
  // so a refusal cannot merely be explained by the previous non-NULL key.
  const sessionReceipt = await saved(false);
  const secondActor = await adjustmentActor(app, sessionReceipt.tenant, 'other@demo.local');
  const sessionBaseline = await facts169();
  assert.deepEqual(await sessionReceipt.ok(sessionReceipt.path, 'POST', sessionReceipt.body), { ...sessionReceipt.result, reused: true });
  assert.equal((await secondActor.request(sessionReceipt.path, 'POST', sessionReceipt.body)).statusCode, 409);
  assert.deepEqual(await facts169(), sessionBaseline, 'Same NULL key but different real current actor is independently denied');
});

test('genuine151-born ordinary receipt remains readable/replayable after152 plus BO, with literal native receipt and no169 backfill', async () => {
  // Replace only the closed app-bound HTTP helpers; the original receipt/key
  // and business rows remain genuine historical151 identities.
  const actor = await adjustmentActor(app, historical.tenant);
  const f = { ...historical, ...actor };
  assert.equal(f.user, historical.user); await activate(f);
  const beforeRows = await facts169();
  assert.deepEqual(one(own169(beforeRows, 'return_cases', f.tenant)), historicalReceipt);
  const result = await f.ok(f.path, 'POST', f.body, 200, f.key);
  assert.equal(result.id, f.rma.id); assert.deepEqual(result.receipt, f.body);
  const afterRows = await facts169(); assert.deepEqual(afterRows, beforeRows);
  for (const name of ['admissions', 'receipts', 'documents', 'rows', 'stock_maps', 'layer_maps', 'item_maps'])
    assert.deepEqual(own169(afterRows, 'catalog_stock_return_' + name, f.tenant), [], 'Historical compatibility cannot backfill169 ' + name);
});

type Loss = 'revoke' | 'expiry' | 'scope' | 'viewer';
async function heldAuthority(f: Intake, loss: Loss, replay: boolean) {
  const beforeRows = await facts169(), originalKey = one(own169(beforeRows, 'api_keys', f.tenant).filter(x => x.id === f.key.id));
  const originalMember = one(own169(beforeRows, 'memberships', f.tenant).filter(x => x.user_id === f.user));
  assert.equal(originalKey.revoked_at, null);
  assert.equal(typeof originalKey.expires_at, 'string');
  assert(Date.parse(originalKey.expires_at) > Date.now(), 'Ordinary HTTP-issued key has its real future expiry');
  const blocker = await pool.connect(), authority = await pool.connect();
  let pending: ReturnType<Fixture169['request']> | undefined;
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM public.orders WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [f.tenant, f.order.id]);
    const pid = (await blocker.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    pending = f.request(f.path, 'POST', f.body, f.key);
    const waiter = await wait169(pid, /SELECT \* FROM orders WHERE id=\$1 FOR UPDATE/i);
    assert.notEqual(waiter, pid, 'Authenticated ordinary receive is actually waiting on the source order');
    if (loss === 'viewer') await authority.query("UPDATE public.memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [f.tenant, f.user]);
    else if (loss === 'revoke') await authority.query('UPDATE public.api_keys SET revoked_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2', [f.tenant, f.key.id]);
    else if (loss === 'expiry') await authority.query("UPDATE public.api_keys SET expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND id=$2", [f.tenant, f.key.id]);
    else await authority.query("UPDATE public.api_keys SET scopes=ARRAY['orders:read']::text[] WHERE tenant_id=$1 AND id=$2", [f.tenant, f.key.id]);
    const withdrawn = await facts169(), changedKey = one(own169(withdrawn, 'api_keys', f.tenant).filter(x => x.id === f.key.id));
    assert.deepEqual(withdrawn.api_keys.filter(x => x.row.id !== f.key.id), beforeRows.api_keys.filter(x => x.row.id !== f.key.id));
    if (loss === 'viewer') {
      const member = one(own169(withdrawn, 'memberships', f.tenant).filter(x => x.user_id === f.user));
      assert.deepEqual(member, { ...originalMember, role: 'viewer' });
      assert.equal(typeof changedKey.revoked_at, 'string');
      assert.deepEqual(changedKey, { ...originalKey, revoked_at: changedKey.revoked_at }, '013 genuine role change revokes only this own key');
    } else if (loss === 'scope') assert.deepEqual(changedKey, { ...originalKey, scopes: ['orders:read'] });
    else {
      const field = loss === 'expiry' ? 'expires_at' : 'revoked_at';
      assert.equal(typeof changedKey[field], 'string'); assert(changedKey[field]);
      assert.deepEqual(changedKey, { ...originalKey, [field]: changedKey[field] });
    }
    assert.deepEqual(withdrawn, { ...beforeRows, api_keys: withdrawn.api_keys,
      ...(loss === 'viewer' ? { memberships: withdrawn.memberships } : {}) }, 'Only the exact deliberate committed authority change is visible while source remains blocked');
    await blocker.query('COMMIT');
    const response = await pending;
    assert.equal(response.statusCode, loss === 'viewer' || loss === 'scope' ? 403 : 401, response.body);
    assert.deepEqual(await facts169(), withdrawn, `${replay ? 'Replay' : 'Fresh intake'} denied after actual source wait must roll back the complete business/number/certificate graph, retaining exact committed IAM baseline`);
  } finally {
    await blocker.query('ROLLBACK').catch(() => {}); blocker.release();
    if (pending) await pending.catch(() => {});
    if (loss === 'viewer') await authority.query('UPDATE public.memberships SET role=$3 WHERE tenant_id=$1 AND user_id=$2', [f.tenant, f.user, originalMember.role]);
    // Preserve actual six-digit timestamp text from UTC JSONB capture; never
    // round a persisted auth timestamp through a JavaScript Date.
    await authority.query('UPDATE public.api_keys SET revoked_at=$3::timestamptz,expires_at=$4::timestamptz,scopes=$5::text[] WHERE tenant_id=$1 AND id=$2',
      [f.tenant, f.key.id, originalKey.revoked_at, originalKey.expires_at, originalKey.scopes]);
    authority.release();
  }
  assert.deepEqual(await facts169(), beforeRows, 'Exact isolated IAM repair restores the entire original database');
}

for (const loss of ['revoke', 'expiry', 'scope', 'viewer'] as const)
  test(`saved strict OFF replay waits on actual order then ${loss} refuses late authority with full row/session purity`, async () => {
    const f = await saved(); await heldAuthority(f, loss, true);
  });

test('fresh strict OFF intake waits on actual order then scope withdrawal rolls back allocated PZ counter/admission and all physical/credit rows', async () => {
  const f = await intake();
  assert.deepEqual(own169(await facts169(), 'catalog_stock_return_receipts', f.tenant), []);
  await heldAuthority(f, 'scope', false);
  assert.deepEqual(own169(await facts169(), 'catalog_stock_return_receipts', f.tenant), []);
});
