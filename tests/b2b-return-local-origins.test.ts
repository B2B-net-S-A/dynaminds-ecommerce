import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool, tenantTx } from '../server/db';
import { buildApp } from '../server/app';
import { receiveInput } from '../server/returns';
import { freshReturnFixture, requestRetail, returnTransport, waitForLock } from './b2b-dropshipping-returns-fixture';
import {
  createMixedHarness, freshMixedFixture, mixedStock, cash, requestMixedReturn,
  localBody, localReceive, lotsBody, prefix, type Harness, type Row, type MixedFixture,
} from './b2b-return-local-origins-fixture';

let h: Harness;
let externalHarness: Harness;
before(async () => {
  h = await createMixedHarness();
  // Two independent app contexts preserve each genuine factory's provider oracle.
  // The main harness already guards/migrates/seeds this disposable test database.
  const app = await buildApp({ integrationTransport: returnTransport.transport });
  externalHarness = { app, close: () => app.close() };
});
after(async () => {
  try { await externalHarness?.close(); }
  finally { if (h) await h.close(); else await pool.end(); }
});
function noStore(r: Row) { assert.match(String(r.headers['cache-control']), /no-store/); }
async function selectLocal(f: MixedFixture, r: Row) {
  const body = await localBody(f, r);
  const response = await f.request(prefix + '/returns/' + r.id + '/local-origin', 'POST', body);
  assert.equal(response.statusCode, 201, response.body); noStore(response);
  const selected = response.json();
  assert.equal(selected.reused, false); assert.equal(selected.context.fulfillment_origin, 'local');
  assert.equal(selected.context.can_receive_locally, true);
  assert.deepEqual(selected.origin.items, body.items);
  return { ...selected, body };
}
async function partner(f: MixedFixture, r: Row) {
  const sources = (await f.ok(prefix + '/returns/' + r.id + '/sources?limit=100')).data;
  const source = sources.find((s: Row) => s.customer_item_id === f.customerItem.id && s.dropship_order_id === f.forwarded.id);
  assert(source);
  const preview = (await f.ok(prefix + '/returns/' + r.id + '/previews', 'POST', {
    client_key: randomUUID(), version: Number(r.version), confirmed: true,
    items: [{ customer_item_id: f.customerItem.id, dropship_order_id: f.forwarded.id, quantity: 1,
      physical_sources: source.physical_sources.map((p: Row) => ({ supplier_item_id: p.supplier_item_id,
        shipment_id: p.shipment_id, ...(p.issue_fragment_id ? { issue_fragment_id: p.issue_fragment_id } : {}),
        quantity: p.quantity_per_unit })) }],
  })).preview;
  const c = (await f.ok(prefix + '/previews/' + preview.id + '/submit', 'POST', {
    client_key: randomUUID(), version: 1, scope_hash: preview.scope_hash, confirmed: true,
  })).cases[0];
  return { c, preview, source };
}

for (const on of [false, true]) test(`genuine mixed local1/external2 keeps one commercial UUID but separate physical receipt and partner credit, WMS ${on ? 'ON' : 'OFF'}`, async () => {
  const f = await freshMixedFixture(h, on), ledger = await cash(f);
  const r = await requestMixedReturn(f), beforeSelection = await f.snapshot();
  const context = (await f.ok(prefix + '/returns/' + r.id + '/context')).context;
  assert.equal(context.fulfillment_origin, 'unselected'); assert.equal(context.local_origin, null);
  assert.equal(context.can_receive_locally, false); assert.equal(context.can_select_local_origin, true);
  const source = context.local_sources.find((s: Row) => s.customer_item_id === f.customerItem.id);
  assert(source); assert.equal(source.issued_quantity, 1); assert.equal(source.quantity_available, 1);
  assert.equal(source.shipment_id, f.localShipment);
  assert.deepEqual(await f.snapshot(), beforeSelection, 'GET never reserves an origin');
  const selected = await selectLocal(f, r), afterSelection = await f.snapshot();
  assert.deepEqual(await mixedStock(f), { on_hand: 4, reserved: 0, available: 4 });
  assert.deepEqual(await mixedStock(f, true), { on_hand: 18, reserved: 0, available: 18 });
  const replay = await f.ok(prefix + '/returns/' + r.id + '/local-origin', 'POST', selected.body);
  assert.equal(replay.reused, true); assert.equal(replay.origin.id, selected.origin.id);
  assert.deepEqual(await f.snapshot(), afterSelection);
  const current = await f.ok('/returns/' + r.id), body = await localReceive(f, current, selected.origin);
  const received = await f.ok('/returns/' + r.id + '/receive', 'POST', body);
  assert.equal(received.items[0].item_id, f.customerItem.id);
  assert.equal(received.items[0].accepted, 1); assert.equal(received.items[0].restocked, 1);
  assert.equal(received.refund_amount, 2500); assert(received.received_at);
  assert.deepEqual(await mixedStock(f), { on_hand: 5, reserved: 0, available: 5 });
  assert.deepEqual(await mixedStock(f, true), { on_hand: 18, reserved: 0, available: 18 });
  const afterReceive = await f.snapshot();
  await f.ok('/returns/' + r.id + '/receive', 'POST', body);
  assert.deepEqual(await f.snapshot(), afterReceive, 'Exact local receipt retry cannot issue a second credit or restock');
  const external = await requestMixedReturn(f), forwarded = await partner(f, external);
  assert.equal(external.items[0].item_id, r.items[0].item_id);
  const c = (await f.ok(prefix + '/cases/' + forwarded.c.id, 'GET', undefined, f.supplier.cookie)).case;
  const receive = {
    client_key: randomUUID(), version: c.version, supplier_return_version: c.supplier_return_version,
    shipping_refund_minor: 0, note: 'Own independent supplier physical return', confirmed: true,
    items: c.supplier_items.map((i: Row) => ({ supplier_item_id: i.supplier_item_id, accepted: 1, restocked: 1 })),
    ...(on ? { wms_lots: await lotsBody(f, true) } : {}),
  };
  const accepted = (await f.ok(prefix + '/cases/' + c.id + '/receive', 'POST', receive, f.supplier.cookie)).case;
  assert.equal(accepted.wholesale_refund_minor, '700');
  assert.deepEqual(await mixedStock(f), { on_hand: 5, reserved: 0, available: 5 });
  assert.deepEqual(await mixedStock(f, true), { on_hand: 19, reserved: 0, available: 19 });
  const currentRetail = await f.ok('/returns/' + external.id), beforeReconcile = await f.snapshot({ physicalOnly: true });
  const reconcile = {
    client_key: randomUUID(), version: Number(currentRetail.version),
    case_versions: [{ id: accepted.id, version: accepted.version }], shipping_refund_minor: 0,
    items: [{ customer_item_id: f.customerItem.id, accepted: 1 }], note: 'Own explicit independent partner credit', confirmed: true,
  };
  const retail = (await f.ok(prefix + '/returns/' + external.id + '/reconcile', 'POST', reconcile)).return;
  assert.equal(retail.refund_amount, 2500); assert.equal(retail.received_at, null);
  assert.equal(retail.items[0].accepted, 1); assert.equal(retail.items[0].restocked, 0);
  assert.deepEqual(await f.snapshot({ physicalOnly: true }), beforeReconcile);
  assert.deepEqual(await cash(f), ledger, 'Local and partner credits never fabricate cash');
  const afterReconcile = await f.snapshot();
  assert.equal((await f.ok(prefix + '/returns/' + external.id + '/reconcile', 'POST', reconcile)).reused, true);
  assert.deepEqual(await f.snapshot(), afterReconcile);
  const acceptedQty = (await pool.query('SELECT sum(i.accepted)::text quantity,sum(i.refund_amount)::text credit FROM return_items i WHERE tenant_id=$1 AND order_id=$2', [f.buyer.tenant, f.order.id])).rows[0];
  assert.deepEqual(acceptedQty, { quantity: '2', credit: '5000' });
  if (on) for (const side of ['buyer', 'supplier'] as const) {
    const rows = (await pool.query('SELECT r.quantity,r.value_minor::text,r.issue_fragment_id,i.layer_id original_layer,r.layer_id FROM wms_return_fragments r JOIN wms_issue_fragments i ON(i.tenant_id,i.id)=(r.tenant_id,r.issue_fragment_id) WHERE r.tenant_id=$1 ORDER BY r.id', [f[side].tenant])).rows;
    assert.equal(rows.length, 1); assert.equal(rows[0].quantity, 1); assert.equal(rows[0].value_minor, '317');
    assert.equal(rows[0].layer_id, rows[0].original_layer);
  }
});

test('damage consumes the local origin even without restock; absent origin, overacceptance and competing local selection all roll back', async () => {
  const f = await freshMixedFixture(h), ledger = await cash(f), r = await requestMixedReturn(f);
  const before = await f.snapshot();
  const unselected = await f.request('/returns/' + r.id + '/receive', 'POST', {
    version: Number(r.version), note: 'Own unselected damage cannot fake a physical acceptance',
    items: [{ item_id: f.customerItem.id, accepted: 1, restocked: 0 }],
  });
  assert.equal(unselected.statusCode, 409, unselected.body); noStore(unselected);
  assert.deepEqual(await f.snapshot(), before);
  const selected = await selectLocal(f, r), competing = await requestMixedReturn(f);
  const competingBody = await localBody(f, competing), beforeCompeting = await f.snapshot();
  const denied = await f.request(prefix + '/returns/' + competing.id + '/local-origin', 'POST', competingBody);
  assert.equal(denied.statusCode, 409, denied.body); noStore(denied);
  assert.deepEqual(await f.snapshot(), beforeCompeting);
  const current = await f.ok('/returns/' + r.id), damage = await localReceive(f, current, selected.origin, 0);
  const tooMuch = await f.request('/returns/' + r.id + '/receive', 'POST', {
    ...damage, items: [{ item_id: f.customerItem.id, accepted: 2, restocked: 0 }],
  });
  // Over-acceptance is refused before core receipt writes. Since 152 the catalogue-stock return prepare runs before
  // the local quota (server/catalog-stock-return-effects.ts) and refuses accepted > requested as 422.
  assert.equal(tooMuch.statusCode, 422, tooMuch.body); noStore(tooMuch);
  assert.deepEqual(await f.snapshot(), beforeCompeting);
  const received = await f.ok('/returns/' + r.id + '/receive', 'POST', damage);
  assert.equal(received.refund_amount, 2500); assert.equal(received.items[0].accepted, 1);
  assert.equal(received.items[0].restocked, 0); assert(received.received_at);
  assert.deepEqual(await mixedStock(f), { on_hand: 4, reserved: 0, available: 4 });
  assert.deepEqual(await mixedStock(f, true), { on_hand: 18, reserved: 0, available: 18 });
  const afterDamage = await f.snapshot(), refreshed = await localBody(f, await f.ok('/returns/' + competing.id));
  const exhausted = await f.request(prefix + '/returns/' + competing.id + '/local-origin', 'POST', refreshed);
  assert.equal(exhausted.statusCode, 409, exhausted.body);
  assert.deepEqual(await f.snapshot(), afterDamage);
  assert.deepEqual(await cash(f), ledger);
});

test('one RMA cannot switch local and partner origins, including immutable actor/body replay collisions', async () => {
  const f = await freshMixedFixture(h), local = await requestMixedReturn(f);
  const sources = (await f.ok(prefix + '/returns/' + local.id + '/sources')).data;
  const external = sources.find((s: Row) => s.customer_item_id === f.customerItem.id);
  assert(external);
  const selected = await selectLocal(f, local);
  await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [f.buyer.tenant, f.supplier.user]);
  const login = await h.app.inject({ url: '/api/auth/login', method: 'POST', payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' } });
  assert.equal(login.statusCode, 200, login.body);
  const switched = await h.app.inject({ url: '/api/workspaces/switch', method: 'POST', payload: { tenant_id: f.buyer.tenant }, headers: { cookie: String(login.headers['set-cookie']).split(';')[0] } });
  assert.equal(switched.statusCode, 200, switched.body);
  const otherActor = String(switched.headers['set-cookie']).split(';')[0];
  const before = await f.snapshot();
  const actorCollision = await f.request(prefix + '/returns/' + local.id + '/local-origin', 'POST', selected.body, otherActor);
  assert.equal(actorCollision.statusCode, 409, actorCollision.body); noStore(actorCollision);
  const switchToPartner = await f.request(prefix + '/returns/' + local.id + '/previews', 'POST', {
    client_key: randomUUID(), version: Number(local.version), confirmed: true,
    items: [{ customer_item_id: f.customerItem.id, dropship_order_id: f.forwarded.id, quantity: 1,
      physical_sources: external.physical_sources.map((p: Row) => ({ supplier_item_id: p.supplier_item_id, shipment_id: p.shipment_id, quantity: p.quantity_per_unit })) }],
  });
  assert.equal(switchToPartner.statusCode, 409, switchToPartner.body);
  const collision = await f.request(prefix + '/returns/' + local.id + '/local-origin', 'POST', {
    ...selected.body, items: [{ ...selected.body.items[0], quantity: 2 }],
  });
  assert.equal(collision.statusCode, 409, collision.body);
  assert.deepEqual(await f.snapshot(), before);
  const retail = await requestMixedReturn(f), body = await localBody(f, retail), forwarded = await partner(f, retail);
  const beforeSwitch = await f.snapshot();
  body.version = Number((await f.ok('/returns/' + retail.id)).version);
  const switchToLocal = await f.request(prefix + '/returns/' + retail.id + '/local-origin', 'POST', body);
  assert.equal(switchToLocal.statusCode, 409, switchToLocal.body);
  assert.deepEqual(await f.snapshot(), beforeSwitch);
  const ctx = (await f.ok(prefix + '/returns/' + retail.id + '/context')).context;
  assert.equal(ctx.fulfillment_origin, 'partner'); assert.equal(ctx.local_origin, null);
  assert(ctx.case_refs.some((c: Row) => c.id === forwarded.c.id));
});

test('a genuinely fully external unbound RMA cannot fake physical acceptance through accepted1/restock0', async () => {
  const f = await freshReturnFixture(externalHarness), r = await requestRetail(f), before = await f.snapshot();
  const response = await f.request('/returns/' + r.id + '/receive', 'POST', {
    version: Number(r.version), note: 'Own external damage is not a local parcel receipt',
    items: [{ item_id: f.cheap.id, accepted: 1, restocked: 0 }],
  });
  assert.equal(response.statusCode, 409, response.body); noStore(response);
  assert.deepEqual(await f.snapshot(), before);
  assert.deepEqual(await f.snapshot({ physicalOnly: true }), f.buyerPhysical);
});

test('raw app INSERT cannot commit a fully external received RMA and accepted damage credit without any local origin or partner witness', async () => {
  const f = await freshReturnFixture(externalHarness), original = await requestRetail(f), before = await f.snapshot();
  const id = randomUUID(), key = randomUUID();
  const receipt = receiveInput.parse({
    version: Number(original.version), note: 'Own raw external acceptance attack', shipping_refund: 0,
    items: [{ item_id: f.cheap.id, accepted: 1, restocked: 0 }],
  });
  let attemptedHead = false;
  await assert.rejects(tenantTx(f.buyer.tenant, async (c) => {
    // Copy all genuine own header/commercial fields, changing only fresh identity
    // and the fabricated physical receipt. No foreign or malformed FK is involved.
    attemptedHead = true;
    await c.query(`INSERT INTO return_cases
      SELECT (jsonb_populate_record(NULL::return_cases,to_jsonb(r)||jsonb_build_object(
        'id',$2::uuid,'client_key',$3::uuid,'number',$4::text,
        'request',r.request||jsonb_build_object('client_key',$3::uuid),
        'state','refund_pending','version',r.version+1,'receipt_sequence',1,
        'received_at',clock_timestamp(),'receipt',$5::jsonb,'decision_note',$6::text,
        'refund_amount',1000,'refunded_shipping',0))).*
      FROM return_cases r WHERE r.tenant_id=$1 AND r.id=$7`,
      [f.buyer.tenant,id,key,'OWN-RAW-EXTERNAL-'+id,receipt,receipt.note,original.id]);
  }, { purchasingAdmission: true }), (e: any) => e.code === '23514'
    && e.message === 'Nowe zewnętrzne RMA nie może zawierać fizycznego przyjęcia');
  assert.equal(attemptedHead,true);
  assert.deepEqual(await f.snapshot(),before);

  let cleanHead = false, receiptBeforeItems = false, insertedItems = false, reachedCommit = false;
  const delayedId = randomUUID(), delayedKey = randomUUID();
  await assert.rejects(tenantTx(f.buyer.tenant, async (c) => {
    const head = await c.query(`INSERT INTO return_cases
      SELECT (jsonb_populate_record(NULL::return_cases,to_jsonb(r)||jsonb_build_object(
        'id',$2::uuid,'client_key',$3::uuid,'number',$4::text,
        'request',r.request||jsonb_build_object('client_key',$3::uuid)))).*
      FROM return_cases r WHERE r.tenant_id=$1 AND r.id=$5`,
      [f.buyer.tenant,delayedId,delayedKey,'OWN-RAW-DEFERRED-'+delayedId,original.id]);
    assert.equal(head.rowCount,1); cleanHead = true;
    // The head has no items yet, so an UPDATE-only row guard cannot discover its
    // external commercial origin. The final deferred check must still reject it.
    assert.equal((await c.query(`UPDATE return_cases SET state='refund_pending',
      received_at=clock_timestamp(),receipt=$3,decision_note=$4,receipt_sequence=1,
      version=version+1 WHERE tenant_id=$1 AND id=$2`,
      [f.buyer.tenant,delayedId,receipt,receipt.note])).rowCount,1);
    receiptBeforeItems = true;
    const lines = await c.query(`INSERT INTO return_items
      SELECT tenant_id,order_id,$2::uuid,item_id,sku,name,components,requested,0,0,0
      FROM return_items WHERE tenant_id=$1 AND return_id=$3 AND item_id=$4`,
      [f.buyer.tenant,delayedId,original.id,f.cheap.id]);
    assert.equal(lines.rowCount,1); insertedItems = true;
    assert.equal((await c.query('SELECT id FROM b2b_return_local_origins WHERE return_id=$1',[delayedId])).rowCount,0);
    reachedCommit = true;
  }, { purchasingAdmission: true }), (e: any) => e.code === '23514'
    && e.message === 'Brak pełnego dowodu przyjęcia nowego zewnętrznego RMA');
  assert.equal(cleanHead && receiptBeforeItems && insertedItems && reachedCommit,true,
    'The complete valid-FK insertion reaches deferred commit validation without a private witness');
  assert.deepEqual(await f.snapshot(),before);
  assert.deepEqual(await f.snapshot({ physicalOnly: true }),f.buyerPhysical);
});

test('raw app cannot manufacture an origin or read its private proof; genuine origin is tenant-bound and immutable', async () => {
  const f = await freshMixedFixture(h), r = await requestMixedReturn(f), selected = await selectLocal(f, r);
  const supplierOrder = await f.ok('/orders/' + f.forwarded.supplier_order_id, 'GET', undefined, f.supplier.cookie);
  const foreign = await f.ok('/orders/' + supplierOrder.id + '/returns', 'POST', {
    client_key: randomUUID(), reason: 'Own real foreign-tenant RMA for composite FK',
    items: [{ item_id: supplierOrder.items[0].id, quantity: 1 }],
  }, f.supplier.cookie);
  const before = await f.snapshot();
  await tenantTx(f.supplier.tenant, async (c) => {
    assert.equal((await c.query('SELECT id FROM b2b_return_local_origins WHERE id=$1', [selected.origin.id])).rowCount, 0);
  });
  await assert.rejects(tenantTx(f.buyer.tenant, async (c) => {
    await c.query('SELECT * FROM b2b_return_local_proofs');
  }), (e: any) => e.code === '42501');
  await assert.rejects(tenantTx(f.buyer.tenant, async (c) => {
    await c.query('INSERT INTO b2b_return_local_origins SELECT * FROM b2b_return_local_origins WHERE id=$1', [selected.origin.id]);
  }), (e: any) => e.code === '42501');
  await assert.rejects(pool.query('UPDATE b2b_return_local_origins SET id=$2 WHERE id=$1', [selected.origin.id, randomUUID()]), (e: any) => e.code === '23514');
  await assert.rejects(pool.query('DELETE FROM b2b_return_local_origins WHERE id=$1', [selected.origin.id]), (e: any) => e.code === '23514');
  const owner = await pool.connect();
  try {
    await owner.query('BEGIN');
    await assert.rejects(owner.query(`INSERT INTO b2b_return_local_origins
      (id,tenant_id,return_id,order_id,actor_id,api_key_id,client_key,request,scope_hash,snapshot,created_at)
      SELECT $2,tenant_id,$3,$4,actor_id,api_key_id,$5,request,scope_hash,snapshot,created_at
      FROM b2b_return_local_origins WHERE id=$1`,
      [selected.origin.id, randomUUID(), foreign.id, supplierOrder.id, randomUUID()]),
      (e: any) => e.code === '23503');
  } finally { await owner.query('ROLLBACK'); owner.release(); }
  const wrongOrigin = await f.request('/returns/' + r.id + '/receive', 'POST', {
    ...(await localReceive(f, await f.ok('/returns/' + r.id), selected.origin)), origin_id: randomUUID(),
  });
  assert.equal(wrongOrigin.statusCode, 409, wrongOrigin.body);
  assert.deepEqual(await f.snapshot(), before);
});

test('origin selection waits on its real own RMA and then rejects withdrawn administrator authority without a receipt or business effect', async () => {
  const f = await freshMixedFixture(h), r = await requestMixedReturn(f), body = await localBody(f, r);
  const all = await f.snapshot(), { memberships, api_keys, workspace_usage, ...before } = all;
  const holder = await pool.connect();
  let pending: ReturnType<typeof f.request> | undefined;
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM return_cases WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [f.buyer.tenant, r.id]);
    pending = f.request(prefix + '/returns/' + r.id + '/local-origin', 'POST', body);
    await waitForLock(holder, /b2b_return_local_select|return_cases/i);
    await pool.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [f.buyer.tenant, f.buyer.user]);
    await holder.query('ROLLBACK');
    const response = await pending;
    assert.equal(response.statusCode, 403, response.body); noStore(response);
    const after = await f.snapshot(), { memberships: m, api_keys: k, workspace_usage: u, ...protectedRows } = after;
    assert.deepEqual(protectedRows, before);
  } finally {
    await holder.query('ROLLBACK').catch(() => {}); holder.release(); await pending?.catch(() => {});
    await pool.query("UPDATE memberships SET role='admin' WHERE tenant_id=$1 AND user_id=$2", [f.buyer.tenant, f.buyer.user]);
  }
});

test('a genuine current-transaction local prepare cannot certify forged acceptance and credit without the actual stock, bin, journal and WMS receipt', async () => {
  const f = await freshMixedFixture(h, true), r = await requestMixedReturn(f), selected = await selectLocal(f, r);
  const current = await f.ok('/returns/' + r.id), body = receiveInput.parse(await localReceive(f, current, selected.origin));
  assert.equal(body.origin_id, selected.origin.id);
  const before = await f.snapshot();
  let prepared = false, forged = false, reachedFinish = false;
  await assert.rejects(tenantTx(f.buyer.tenant, async (c) => {
    const proof = (await c.query('SELECT b2b_return_local_prepare($1,$2,NULL,$3) id', [r.id, f.buyer.user, body])).rows[0].id;
    assert(proof); prepared = true;
    assert.equal((await c.query('UPDATE return_items SET accepted=1,restocked=1,refund_amount=2500 WHERE tenant_id=$1 AND return_id=$2 AND item_id=$3', [f.buyer.tenant, r.id, f.customerItem.id])).rowCount, 1);
    assert.equal((await c.query("UPDATE return_cases r SET state='refund_pending',received_at=clock_timestamp(),receipt=$3,receipt_sequence=(SELECT coalesce(max(other.receipt_sequence),0)+1 FROM return_cases other WHERE other.tenant_id=r.tenant_id AND other.order_id=r.order_id AND other.id<>r.id),refunded_shipping=0,refund_amount=2500,decision_note=$4,version=version+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2", [f.buyer.tenant, r.id, body, body.note])).rowCount, 1);
    forged = true; reachedFinish = true;
    await c.query('SELECT b2b_return_local_finish($1)', [proof]);
  }, { purchasingAdmission: true }), (e: any) => e.code === '23514');
  assert.equal(prepared && forged && reachedFinish, true, 'The real finish, not an incidental malformed body, rejects fabricated physical evidence');
  assert.deepEqual(await f.snapshot(), before);
  assert.deepEqual(await mixedStock(f), { on_hand: 4, reserved: 0, available: 4 });
  assert.deepEqual(await mixedStock(f, true), { on_hand: 18, reserved: 0, available: 18 });
});

test('a fresh public compound-write key succeeds before a real RMA wait but revoked or reduced grants cannot commit local origin selection', async () => {
  const f = await freshMixedFixture(h);
  const scopes = ['products:read', 'inventory:read', 'orders:read', 'purchasing:read', 'inventory:write', 'orders:write', 'purchasing:write'];
  for (const mutation of ['revoke', 'scope'] as const) {
    const r = await requestMixedReturn(f);
    const key = await f.ok('/developer/keys', 'POST', { name: 'Own local origin ' + mutation, scopes, expires_days: 30 });
    assert(/^dyna_api_[a-f0-9]{64}$/.test(key.token));
    const headers = { authorization: 'Bearer ' + key.token, 'X-Workspace-ID': f.buyer.tenant };
    const read = await h.app.inject({ url: '/api/v1' + prefix + '/returns/' + r.id + '/context', headers });
    assert.equal(read.statusCode, 200, read.body); noStore(read);
    const source = read.json().context.local_sources.find((s: Row) => s.customer_item_id === f.customerItem.id);
    assert(source);
    const body = { client_key: randomUUID(), version: Number(r.version), scope_hash: read.json().context.local_scope_hash,
      confirmed: true, items: [{ customer_item_id: f.customerItem.id, shipment_id: source.shipment_id, quantity: 1 }] };
    const snapshot = await f.snapshot(), { api_keys, memberships, workspace_usage, ...before } = snapshot;
    const holder = await pool.connect();
    let pending: ReturnType<typeof f.request> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM return_cases WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [f.buyer.tenant, r.id]);
      pending = h.app.inject({ url: '/api/v1' + prefix + '/returns/' + r.id + '/local-origin', method: 'POST', headers, payload: body });
      await waitForLock(holder, /b2b_return_local_select|return_cases/i);
      await pool.query(mutation === 'revoke' ? 'UPDATE api_keys SET revoked_at=now() WHERE id=$1' : 'UPDATE api_keys SET scopes=$2::text[] WHERE id=$1', mutation === 'revoke' ? [key.id] : [key.id, scopes.filter((s) => s !== 'inventory:write')]);
      await holder.query('ROLLBACK');
      const refused = await pending;
      assert.equal(refused.statusCode, mutation === 'revoke' ? 401 : 403, refused.body); noStore(refused);
      const after = await f.snapshot(), { api_keys: k, memberships: m, workspace_usage: u, ...protectedRows } = after;
      assert.deepEqual(protectedRows, before);
    } finally {
      await holder.query('ROLLBACK').catch(() => {}); holder.release(); await pending?.catch(() => {});
    }
  }
});

test('read-only local provenance stays readable; torn112 fails closed and restoring its function preserves the ordinary RMA path', async () => {
  const f = await freshMixedFixture(h), r = await requestMixedReturn(f), body = await localBody(f, r);
  const readonly = await buildApp({ readOnly: true });
  try {
    assert.equal((await readonly.inject({ url: '/api' + prefix + '/returns/' + r.id + '/context', headers: { cookie: f.buyer.cookie } })).statusCode, 401);
    const login = await readonly.inject({ url: '/api/auth/login', method: 'POST', payload: { email: 'other@demo.local', password: 'DynaDemo!2026' } });
    assert.equal(login.statusCode, 200, login.body);
    const switched = await readonly.inject({ url: '/api/workspaces/switch', method: 'POST', payload: { tenant_id: f.buyer.tenant }, headers: { cookie: String(login.headers['set-cookie']).split(';')[0] } });
    assert.equal(switched.statusCode, 200, switched.body);
    const cookie = String(switched.headers['set-cookie']).split(';')[0], before = await f.snapshot();
    const context = await readonly.inject({ url: '/api' + prefix + '/returns/' + r.id + '/context', headers: { cookie } });
    assert.equal(context.statusCode, 200, context.body); assert.equal(context.json().read_only, true);
    assert.equal(context.json().context.can_select_local_origin, false);
    for (const path of [prefix + '/returns/' + r.id + '/local-origin', '/returns/' + r.id + '/receive']) {
      const refusal = await readonly.inject({ url: '/api' + path, method: 'POST', headers: { cookie, 'content-type': 'application/json' }, payload: '{' });
      assert.equal(refusal.statusCode, 423, refusal.body); noStore(refusal);
    }
    assert.deepEqual(await f.snapshot(), before);
  } finally { await readonly.close(); }
  let older: Awaited<ReturnType<typeof buildApp>> | undefined;
  let ordinaryBody: Row | undefined, ordinaryId: string | undefined;
  await pool.query('ALTER FUNCTION b2b_return_local_select(uuid,uuid,uuid,jsonb) RENAME TO qa_missing_local_select');
  try {
    older = await buildApp();
    const before = await f.snapshot();
    const unavailable = await older.inject({ url: '/api' + prefix + '/returns/' + r.id + '/local-origin', method: 'POST', headers: { cookie: f.buyer.cookie }, payload: body });
    assert.equal(unavailable.statusCode, 503, unavailable.body); noStore(unavailable);
    assert.deepEqual(await f.snapshot(), before);
    // The supplier's ordinary own sale has no externally fulfilled retail origin.
    const supplierOrder = await f.ok('/orders/' + f.forwarded.supplier_order_id, 'GET', undefined, f.supplier.cookie);
    const ordinary = await older.inject({ url: '/api/orders/' + supplierOrder.id + '/returns', method: 'POST', headers: { cookie: f.supplier.cookie }, payload: { client_key: randomUUID(), reason: 'Own old schema ordinary sale', items: [{ item_id: supplierOrder.items[0].id, quantity: 1 }] } });
    assert.equal(ordinary.statusCode, 201, ordinary.body);
    const rma = ordinary.json();
    ordinaryId = rma.id;
    ordinaryBody = { version: Number(rma.version), shipping_refund: 0, note: 'Own ordinary physical receipt remains available', items: [{ item_id: supplierOrder.items[0].id, accepted: 1, restocked: 1 }] };
    const beforeReceipt = await f.snapshot();
    const refused = await older.inject({ url: '/api/returns/' + rma.id + '/receive', method: 'POST', headers: { cookie: f.supplier.cookie }, payload: ordinaryBody });
    assert.equal(refused.statusCode, 503, refused.body); noStore(refused);
    assert.deepEqual(await f.snapshot(), beforeReceipt, 'Installed but torn provenance is never silently bypassed');
    assert.deepEqual(await mixedStock(f), { on_hand: 4, reserved: 0, available: 4 });
    assert.deepEqual(await mixedStock(f, true), { on_hand: 18, reserved: 0, available: 18 });
  } finally {
    try { await older?.close(); } finally {
      await pool.query('ALTER FUNCTION qa_missing_local_select(uuid,uuid,uuid,jsonb) RENAME TO b2b_return_local_select');
    }
  }
  assert(ordinaryId && ordinaryBody);
  await f.ok('/returns/' + ordinaryId + '/receive', 'POST', ordinaryBody, f.supplier.cookie);
  assert.deepEqual(await mixedStock(f), { on_hand: 4, reserved: 0, available: 4 });
  assert.deepEqual(await mixedStock(f, true), { on_hand: 19, reserved: 0, available: 19 });
});

test('a blocked real local receipt and competing origin selection share upfront admission without order-to-budget deadlock or duplicate physical acceptance', async () => {
  const f = await freshMixedFixture(h), r = await requestMixedReturn(f), selected = await selectLocal(f, r);
  const competing = await requestMixedReturn(f), selectionBody = await localBody(f, competing);
  const receiptBody = await localReceive(f, await f.ok('/returns/' + r.id), selected.origin);
  const ledger = await cash(f), holder = await pool.connect();
  let receive: ReturnType<typeof f.request> | undefined;
  let select: ReturnType<typeof f.request> | undefined;
  const blocked = async (blockingPid: number, query: RegExp) => {
    // 30 s, not 5 s: on a loaded runner the receipt reaches the held order much later than locally.
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const rows = (await pool.query(
        "SELECT pid,query,wait_event FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))",
        [blockingPid],
      )).rows;
      const row = rows.find((row: Row) => query.test(row.query));
      if (row) return row;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail('The expected own order/admission blocker chain was not observed');
  };
  try {
    await holder.query('BEGIN');
    const holderPid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    await holder.query('SELECT id FROM orders WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [f.buyer.tenant, f.order.id]);
    receive = f.request('/returns/' + r.id + '/receive', 'POST', receiptBody);
    const receiving = await blocked(holderPid, /\borders\b/i);
    select = f.request(prefix + '/returns/' + competing.id + '/local-origin', 'POST', selectionBody);
    // The network writer also admits purchase sources before its own local-return
    // budget. Either published admission may be the first one blocked by receive;
    // require its exact outer query and the same real receiving PID as blocker.
    const selecting = await blocked(receiving.pid,
      /^(?:SELECT (?:public\.)?purchasing_source_admit\(\)|SELECT pg_advisory_xact_lock\(hashtextextended\(\$1,0\)\)|SELECT b2b_return_local_select\()/i);
    assert.notEqual(receiving.pid, selecting.pid);
    assert.equal(selecting.wait_event, 'advisory');
    const admission = /purchasing_source_admit/i.test(selecting.query) ? 'purchasing_source_admit'
      : /b2b_return_local_select/i.test(selecting.query) ? 'b2b_return_local_select' : 'pg_advisory_xact_lock';
    console.info('Own local-origin concurrency proof', { receive_wait: 'own_order', selection_wait: admission, wait_event: selecting.wait_event });
    await holder.query('ROLLBACK');
    const [received, denied] = await Promise.all([receive, select]);
    assert.equal(received.statusCode, 200, received.body);
    assert.equal(denied.statusCode, 409, denied.body); noStore(denied);
    assert.equal(received.json().refund_amount, 2500);
    assert.deepEqual(await mixedStock(f), { on_hand: 5, reserved: 0, available: 5 });
    assert.deepEqual(await mixedStock(f, true), { on_hand: 18, reserved: 0, available: 18 });
    assert.deepEqual(await cash(f), ledger);
    const rows = (await pool.query(
      'SELECT (SELECT count(*)::int FROM b2b_return_local_origins WHERE tenant_id=$1) origins,(SELECT count(*)::int FROM b2b_return_local_proofs WHERE tenant_id=$1 AND applied) proofs,(SELECT sum(delta)::int FROM stock_movements WHERE tenant_id=$1 AND return_id=$2 AND kind=\'return\') restored',
      [f.buyer.tenant, r.id],
    )).rows[0];
    assert.deepEqual(rows, { origins: 1, proofs: 1, restored: 1 });
    const after = await f.snapshot();
    await f.ok('/returns/' + r.id + '/receive', 'POST', receiptBody);
    assert.deepEqual(await f.snapshot(), after);
  } finally {
    await holder.query('ROLLBACK').catch(() => {}); holder.release();
    await Promise.allSettled([receive, select].filter(Boolean));
  }
});
