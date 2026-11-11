import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { seed } from './fixtures';
import { releaseOrderParcelRemainderInTx } from '../server/order-parcel-release-stock';
import { receiveReturn, receiveInput, returnInput, requestReturn, decideReturn, decisionInput } from '../server/returns';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/dynaminds_test_\d+$/);
let app: Awaited<ReturnType<typeof buildApp>>, user = '', ip = 0;
before(async () => {
  await migrate(); await seed();
  app = await buildApp({ logging: process.env.ORDER_PARCEL_RELEASE_TEST_LOG === 'true', integrationTransport: async () => { throw Error('Local release cannot call a provider'); } });
  user = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
});

for (const on of [false,true]) test(`duplicate commercial prices and indivisible cents survive ${on?'ON shared bundle components':'OFF same SKU'} issue, early return and release`,async()=>{
 const f=await fixture(on,true,true), original=await snapshot(f.tenant);
 const order=await f.ok('/orders/'+f.order.id), origins=order.returns.parcel_origins;
 assert.equal(origins.length,3);assert.equal(new Set(origins.map((o:any)=>o.item_id)).size,3);
 const issued=original.order_parcel_origin_issues;assert.equal(issued.length,3);
 for(const o of origins){const line=order.items.find((i:any)=>i.id===o.item_id);assert(line);assert.equal(o.snapshot.line_total,line.line_total);assert.equal(o.snapshot.original_quantity,line.quantity);assert.equal(o.snapshot.item_id,line.id);if(on)for(const component of o.components)assert.equal(original.order_parcel_origin_fragments.filter((m:any)=>m.row.origin_id===o.origin_id&&m.row.product_id===component.product_id).reduce((sum:number,m:any)=>sum+m.row.quantity,0),o.quantity*component.quantity);}
 if(on){assert.equal(original.order_parcel_origin_fragments.length,5);for(const fragment of original.wms_issue_fragments){const maps=original.order_parcel_origin_fragments.filter((m:any)=>m.row.fragment_id===fragment.row.id);assert.equal(maps.reduce((sum:number,m:any)=>sum+m.row.quantity,0),fragment.row.quantity);for(const map of maps){assert.equal(map.row.dispatch_id,original.order_parcel_dispatches[0].row.id);assert.equal(fragment.row.operation_id,original.order_parcel_dispatches[0].row.id);}}}
 else assert.equal(original.order_parcel_origin_fragments.length,0);
 for(const p of f.components) {
  const need=on ? (p.recipe===1?3:4) : 3;
  const reservation=original.reservations.find((r:any)=>r.row.product_id===p.id).row;
  assert.equal(reservation.consumed_quantity,need);
  if(on){const mappings=original.order_parcel_origin_fragments.filter((m:any)=>m.row.product_id===p.id);assert.equal(mappings.reduce((sum:number,m:any)=>sum+m.row.quantity,0),need);assert.equal(original.wms_issue_fragments.filter((m:any)=>m.row.product_id===p.id).reduce((sum:number,m:any)=>sum+m.row.quantity,0),need);}
 }
 const r=await f.ok('/orders/'+f.order.id+'/returns','POST',{client_key:randomUUID(),reason:'Own duplicate-price origin proof',shipping_refund:0,items:origins.map((o:any)=>({item_id:o.item_id,quantity:1})),parcel_origins:origins.map((o:any)=>({item_id:o.item_id,dispatch_id:o.dispatch_id,quantity:1}))},201);
 const body:any={version:Number(r.version),shipping_refund:0,note:'Own shared-origin physical return',items:origins.map((o:any)=>({item_id:o.item_id,accepted:1,restocked:1}))};
 if(on){const policy=(await f.ok('/wms-lots')).policy,stock_versions=[];for(const p of f.components){const dto=await f.ok('/products/'+p.id);stock_versions.push({warehouse_id:f.warehouse,product_id:p.id,version:String(dto.stock.find((s:any)=>s.warehouse_id===f.warehouse).version)});}const picks=new Map<string,number>();for(const o of origins)for(const x of o.fragments)picks.set(x.fragment_id,(picks.get(x.fragment_id)??0)+x.quantity);body.wms_lots={client_key:randomUUID(),policy_version:String(policy.version),stock_versions,picks:[...picks].map(([issue_fragment_id,quantity])=>({issue_fragment_id,quantity,location:'REL-01'}))};}
 const received=await f.ok('/returns/'+r.id+'/receive','POST',body);assert.equal(received.refund_amount,3017);assert.equal(received.state,'refund_pending');
 const after=await snapshot(f.tenant);assert.deepEqual(after.order_items,original.order_items);assert.deepEqual(after.payment_entries,original.payment_entries);assert.deepEqual(after.documents,original.documents);
 const cheap=received.items.find((i:any)=>i.item_id===order.items.find((i:any)=>i.line_total===2001).id);assert.equal(cheap.refund_amount,1000);
 await f.ok('/returns/'+r.id+'/receive','POST',body);assert.deepEqual(await snapshot(f.tenant),after);
 const fresh=await f.ok('/orders/'+f.order.id),preview=(await f.ok('/order-parcel-releases/plans/'+f.plan.id+'/previews','POST',{client_key:randomUUID(),order_version:String(fresh.version)},201)).preview;
 const result=await f.ok('/order-parcel-releases/previews/'+preview.id+'/release','POST',{client_key:randomUUID(),scope_hash:preview.scope_hash,confirmed:true},201);assert.equal(result.release.receipt.summary.commercial_quantity,1);
 const closed=await snapshot(f.tenant);assert.deepEqual(closed.order_items,original.order_items);assert.deepEqual(closed.payment_entries,original.payment_entries);
 for(const table of ['documents','stock_movements','stock_location_movements','wms_operations','wms_issue_fragments','wms_return_fragments','wms_layer_movements','order_parcel_origin_issues','order_parcel_origin_fragments'])assert.deepEqual(closed[table],after[table],table+' release cannot add physical or financial effects');
 for(const p of f.components){const s=closed.stock.find((x:any)=>x.row.product_id===p.id).row;assert.equal(s.on_hand,p.quantity);assert.equal(s.reserved,0);const r=closed.reservations.find((x:any)=>x.row.product_id===p.id).row;assert.equal(r.quantity,r.consumed_quantity+r.released_quantity);assert.equal(r.released_quantity,p.recipe);}
 const final=await f.ok('/orders/'+f.order.id);assert.equal(final.status,'shipped');assert(final.returns.items.every((i:any)=>i.available===0));
});
after(async () => { try { await app?.close(); } finally { await pool.end(); } });

async function fixture(on: boolean, issued = true, commercial = false, shippingCost = 0) {
  const tenant = randomUUID(), warehouse = randomUUID(), address = '127.153.0.' + ++ip;
  await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,'Own release safety','enterprise')", [tenant]);
  await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [tenant, user]);
  await pool.query("INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Own release','REL')", [warehouse, tenant]);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' }, remoteAddress: address });
  assert.equal(login.statusCode, 200);
  const switched = await app.inject({ method: 'POST', url: '/api/workspaces/switch', payload: { tenant_id: tenant }, headers: { cookie: String(login.headers['set-cookie']).split(';')[0] }, remoteAddress: address });
  assert.equal(switched.statusCode, 200);
  const cookie = String(switched.headers['set-cookie']).split(';')[0];
  const req = (path: string, method: any = 'GET', payload?: any) => app.inject({ url: '/api' + path, method, payload, headers: { cookie, ...(method === 'POST' && path === '/orders' ? { 'Idempotency-Key': randomUUID() } : {}) }, remoteAddress: address });
  const ok = async (path: string, method: any = 'GET', body?: any, status = 200): Promise<any> => { const r = await req(path, method, body); assert.equal(r.statusCode, status, `${method} ${path}: ${r.body.slice(0, 600)}`); return r.json(); };
  const components: any[] = [];
  for (const s of on ? [{ quantity: 5, recipe: 1, cost: '0' }, { quantity: 10, recipe: 2, cost: '1000' }] : [{ quantity: 5, recipe: 1, cost: '317' }]) {
    const p = await ok('/products', 'POST', { name: 'Own release physical item', sku: 'REL-' + randomUUID(), kind: 'simple', price: 10000, vat: 23, warehouse_id: warehouse, quantity: s.quantity, location: 'REL-01' }, 201);
    components.push({ ...s, id: p.id, sku: p.sku });
  }
  let sale = components[0].id;
  if (on) {
    sale = (await ok('/products', 'POST', { name: 'Own release A1 B2 bundle', sku: 'REL-B-' + randomUUID(), kind: 'bundle', price: 10000, vat: 23, warehouse_id: warehouse, quantity: 0, components: components.map(p => ({ product_id: p.id, quantity: p.recipe })) }, 201)).id;
    const lines = [];
    for (const p of components) { const dto = await ok('/products/' + p.id), s = dto.stock.find((x: any) => x.warehouse_id === warehouse); lines.push({ warehouse_id: warehouse, product_id: p.id, location: 'REL-01', quantity: p.quantity, stock_version: String(s.version), lot_code: 'REL-' + p.id, unit_cost_minor: p.cost }); }
    const opening = (await ok('/wms-lots/opening-previews', 'POST', { client_key: randomUUID(), policy_version: '0', currency: 'PLN', note: 'Own safety known zero and thousand', lines }, 201)).preview;
    assert.equal(opening.ready, true);
    await ok('/wms-lots/opening-previews/' + opening.id + '/activate', 'POST', { client_key: randomUUID(), scope_hash: opening.scope_hash, confirmed: true, ack_unknown_costs: false }, 201);
  }
  const manualLines = [{product_id:sale,quantity:2,line_total:2001},{product_id:sale,quantity:1,line_total:1700},{product_id:components[0].id,quantity:1,line_total:317}];
  let order = await ok('/orders', 'POST', { source: 'manual', customer_name: 'Own release buyer', email: 'release@example.test', address: { street: 'Testowa 153', city: 'Warszawa', postal_code: '00-153', country: 'PL', phone: '500000153' }, warehouse_id: warehouse, currency: 'PLN', payment_mode: 'prepaid', shipping_cost: shippingCost, items: commercial ? (on ? [{product_id:sale,quantity:3},{product_id:components[0].id,quantity:1}] : [{product_id:sale,quantity:4}]) : [{ product_id: sale, quantity: 3 }], ...(commercial ? {manual_lines:manualLines} : {}) }, 201);
  order = await ok('/orders/' + order.id);
  await ok('/orders/' + order.id + '/payments', 'POST', { client_key: randomUUID(), version: Number(order.version), kind: 'receipt', amount: order.total, currency: 'PLN', method: 'other', reference: 'Synthetic local ledger only', confirmed: true });
  await ok('/orders/' + order.id + '/status', 'PATCH', { status: 'picking' });
  if (on) {
    const allocations = await ok('/wms-lots/orders/' + order.id + '/allocations');
    assert.equal(allocations.data.length, 2); assert.equal(allocations.meta?.cursor ?? null, null);
    for (const a of allocations.data) { const p = components.find(p => p.id === a.product_id); assert(p); for (let i = 0; i < a.quantity; i++) await ok('/orders/' + order.id + '/scan', 'POST', { client_key: randomUUID(), code: p.sku, location: a.location, layer_id: a.layer_id }); }
  } else for (let i = 0; i < (commercial ? 4 : 3); i++) await ok('/orders/' + order.id + '/scan', 'POST', { client_key: randomUUID(), code: components[0].sku, location: 'REL-01' });
  await ok('/orders/' + order.id + '/status', 'PATCH', { status: 'packed' });
  order = await ok('/orders/' + order.id);
  if(commercial) {assert.equal(order.total,4018+shippingCost);assert.equal(order.items.length,3);assert.equal(new Set(order.items.map((i:any)=>i.id)).size,3);for(const l of manualLines) assert.equal(order.items.filter((i:any)=>i.product_id===l.product_id&&i.quantity===l.quantity&&i.line_total===l.line_total).length,1);}
  const parcelItems = commercial ? [order.items.map((i:any)=>({item_id:i.id,quantity:1})),order.items.filter((i:any)=>i.quantity===2).map((i:any)=>({item_id:i.id,quantity:1}))] : [1,2].map(quantity=>[{item_id:order.items[0].id,quantity}]);
  const preview = (await ok('/order-parcels/orders/' + order.id + '/previews', 'POST', { client_key: randomUUID(), order_version: String(order.version), protocol: 'commercial_v1', parcels: parcelItems.map(items => ({ source_kind: 'demo', items, cod_minor: 0 })) }, 201)).preview;
  const plan = (await ok('/order-parcels/previews/' + preview.id + '/apply', 'POST', { client_key: randomUUID(), scope_hash: preview.scope_hash, confirmed: true }, 201)).plan;
  if (issued) await ok('/order-parcels/plans/' + plan.id + '/parcels/0/dispatch', 'POST', { client_key: randomUUID(), scope_hash: plan.scope_hash, confirmed: true });
  order = await ok('/orders/' + order.id);
  const releasePreview = (await ok('/order-parcel-releases/plans/' + plan.id + '/previews', 'POST', { client_key: randomUUID(), order_version: String(order.version) }, 201)).preview;
  const releaseBody = { client_key: randomUUID(), scope_hash: releasePreview.scope_hash, confirmed: true };
  return { tenant, warehouse, user, on, issued, order, components, plan, releasePreview, releaseBody, req, ok, actor: { tenantId: tenant, userId: user, role: 'admin' as const } };
}

async function snapshot(tenant: string) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); await c.query("SET LOCAL TimeZone='UTC'");
    const names = (await c.query("SELECT table_name FROM information_schema.tables t WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name<>'sessions' AND EXISTS(SELECT 1 FROM information_schema.columns k WHERE k.table_schema=t.table_schema AND k.table_name=t.table_name AND column_name='tenant_id') ORDER BY 1")).rows;
    const out: Record<string, any> = {};
    for (const { table_name: name } of names) { assert.match(name, /^[a-z_][a-z0-9_]*$/); out[name] = (await c.query(`SELECT to_jsonb(q) row FROM "${name}" q WHERE tenant_id=$1 ORDER BY 1`, [tenant])).rows; }
    await c.query('COMMIT'); return out;
  } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
}

async function prepare(c: any, f: Awaited<ReturnType<typeof fixture>>) {
  const id = randomUUID();
  assert.equal((await c.query('SELECT order_parcel_release_prepare($1,$2,$3,$4,NULL) id', [f.releasePreview.id, id, f.releaseBody, user])).rows[0].id, id);
  const scope = (await c.query('SELECT order_parcel_release_scope($1,$2,NULL) r', [id, user])).rows[0].r;
  return { id, scope };
}

for (const on of [false, true]) {
  test(`genuine ${on ? 'ON bundle' : 'OFF'} partial issue closes remainder without extra goods or cash; exact retry is effect-free`, async () => {
    const f = await fixture(on), before = await snapshot(f.tenant);
    const reply = await f.ok('/order-parcel-releases/previews/' + f.releasePreview.id + '/release', 'POST', f.releaseBody, 201);
    assert.equal(reply.release.order_status, 'shipped'); assert.equal(reply.release.receipt.physical_movement, false);
    assert.equal(reply.release.receipt.cancelled.length, 1); assert.equal(reply.release.receipt.summary.commercial_quantity, 2);
    const after = await snapshot(f.tenant);
    for (const table of ['stock_movements', 'stock_location_movements', 'wms_operations', 'wms_issue_fragments', 'wms_return_fragments', 'wms_layer_movements', 'payment_entries', 'documents', 'return_cases', 'return_items', 'order_parcel_dispatches', 'order_parcel_origin_issues', 'order_parcel_origin_fragments', 'order_items', 'order_pick_items']) assert.deepEqual(after[table], before[table], table);
    assert.equal(after.order_parcel_releases.length, 1);
    for (const p of f.components) {
      const r = after.reservations.find((x: any) => x.row.product_id === p.id).row;
      assert.equal(r.quantity, 3 * p.recipe); assert.equal(r.consumed_quantity, p.recipe); assert.equal(r.released_quantity, 2 * p.recipe); assert.equal(r.state, 'released');
      const s = after.stock.find((x: any) => x.row.product_id === p.id).row;
      assert.equal(s.on_hand, p.quantity - p.recipe); assert.equal(s.reserved, 0);
      if (on) { const pos = after.wms_layer_positions.find((x: any) => x.row.product_id === p.id).row; assert.equal(pos.quantity, p.quantity - p.recipe); assert.equal(pos.reserved, 0); }
    }
    const retry = await f.ok('/order-parcel-releases/previews/' + f.releasePreview.id + '/release', 'POST', f.releaseBody);
    assert.equal(retry.reused, true); assert.deepEqual(retry.release, reply.release); assert.deepEqual(await snapshot(f.tenant), after);
    for (const [body, status] of [[{ ...f.releaseBody, scope_hash: '0'.repeat(64) }, 409], [{ ...f.releaseBody, confirmed: false }, 422]] as [any, number][]) { assert.equal((await f.req('/order-parcel-releases/previews/' + f.releasePreview.id + '/release', 'POST', body)).statusCode, status); assert.deepEqual(await snapshot(f.tenant), after); }
    assert.equal((await f.req('/order-parcels/plans/' + f.plan.id + '/parcels/1/dispatch', 'POST', { client_key: randomUUID(), scope_hash: f.plan.scope_hash, confirmed: true })).statusCode, 409);
    assert.deepEqual(await snapshot(f.tenant), after);
  });

  test(`genuine ${on ? 'ON' : 'OFF'} wholly unissued plan cancels without physical issue`, async () => {
    const f = await fixture(on, false), before = await snapshot(f.tenant);
    const r = await f.ok('/order-parcel-releases/previews/' + f.releasePreview.id + '/release', 'POST', f.releaseBody, 201);
    assert.equal(r.release.order_status, 'cancelled'); assert.equal(r.release.receipt.cancelled.length, 2);
    const after = await snapshot(f.tenant);
    assert.equal(after.order_parcel_dispatches.length, 0);
    for (const p of f.components) { const stock = after.stock.find((x: any) => x.row.product_id === p.id).row; assert.equal(stock.on_hand, p.quantity); assert.equal(stock.reserved, 0); }
    for (const table of ['stock_movements', 'stock_location_movements', 'wms_operations', 'wms_issue_fragments', 'wms_layer_movements', 'payment_entries', 'documents']) assert.deepEqual(after[table], before[table]);
  });

  test(`${on ? 'ON' : 'OFF'} forged result cannot replace real reserved changes; genuine interrupted adapter rolls back all facts`, async () => {
    const f = await fixture(on, false), before = await snapshot(f.tenant);
    let reachedFinish = false;
    await assert.rejects(tenantTx(f.tenant, async c => { const { id, scope } = await prepare(c, f); reachedFinish = true; await c.query('SELECT order_parcel_release_finish($1,$2,$3,NULL)', [id, { operation_id: id, cancelled: scope.pending, products: scope.products, summary: scope.summary, physical_movement: false }, user]); }), (e: any) => e.code === '23514' && e.message === 'Zwolnienie nie odpowiada rzeczywistej zmianie pozostałej rezerwacji');
    assert.equal(reachedFinish, true); assert.deepEqual(await snapshot(f.tenant), before);
    let changed = false;
    await assert.rejects(tenantTx(f.tenant, async c => { const { scope } = await prepare(c, f); await releaseOrderParcelRemainderInTx(c, f.actor, scope); changed = true; assert.equal((await c.query('SELECT sum(reserved)::int n FROM stock WHERE tenant_id=$1', [f.tenant])).rows[0].n, 0); throw Error('Own deliberate rollback after genuine release'); }), /Own deliberate rollback after genuine release/);
    assert.equal(changed, true); assert.deepEqual(await snapshot(f.tenant), before);
    await assert.rejects(tenantTx(f.tenant, c => c.query('UPDATE reservations SET released_quantity=1 WHERE tenant_id=$1 AND order_id=$2', [f.tenant, f.order.id])), (e: any) => e.code === '23514' && e.message === 'Zwolnienie rezerwacji wymaga bieżącej prywatnej zgody');
    assert.deepEqual(await snapshot(f.tenant), before);
  });
}

test('owner after-flush stock mutation is denied by OLD+NEW release seal; stale IAM invalidates genuine completion', async () => {
  const f = await fixture(false, false), before = await snapshot(f.tenant);
  let reachedFlush = false;
  await assert.rejects(tenantTx(f.tenant, async c => { const { id, scope } = await prepare(c, f); const receipt = await releaseOrderParcelRemainderInTx(c, f.actor, scope); await c.query('SELECT order_parcel_release_finish($1,$2,$3,NULL)', [id, receipt, user]); await c.query('SET CONSTRAINTS ALL IMMEDIATE'); reachedFlush = true; await c.query('SET LOCAL ROLE postgres'); await c.query('SAVEPOINT owned_attack'); await c.query('UPDATE stock SET reserved=1 WHERE tenant_id=$1 AND product_id=$2', [f.tenant, f.components[0].id]); }), (e: any) => e.code === '23514' && e.message === 'Zwolnienie zapieczętowało końcowy stan i historię');
  assert.equal(reachedFlush, true); assert.deepEqual(await snapshot(f.tenant), before);
  let reachedReceipt = false;
  await assert.rejects(tenantTx(f.tenant, async c => { const { id, scope } = await prepare(c, f); const receipt = await releaseOrderParcelRemainderInTx(c, f.actor, scope); await c.query('SELECT order_parcel_release_finish($1,$2,$3,NULL)', [id, receipt, user]); reachedReceipt = true; await c.query('SET LOCAL ROLE postgres'); await c.query("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2", [f.tenant, user]); await c.query('SET LOCAL ROLE dyna_app'); await c.query('SET CONSTRAINTS ALL IMMEDIATE'); }), (e: any) => e.code === '23514' && e.message === 'Brak aktualnego uprawnienia do paczek');
  assert.equal(reachedReceipt, true); assert.deepEqual(await snapshot(f.tenant), before);
});

for (const on of [false, true]) test(`issued-origin early RMA, real ${on ? 'ON bundle' : 'OFF'} restock, then cancel unissued remainder preserves original commercial sale and cash`, async () => {
 const f = await fixture(on), original = await snapshot(f.tenant);
 const order = await f.ok('/orders/' + f.order.id), origin = order.returns.parcel_origins[0];
 assert.equal(order.status, 'packed'); assert.equal(order.returns.parcel_origins_required, true);
 assert.equal(order.returns.items[0].available, 1); assert.equal(origin.available, 1);
 const draft = { client_key: randomUUID(), reason: 'Own early issued-origin return', shipping_refund: 0, items: [{ item_id: origin.item_id, quantity: 1 }], parcel_origins: [{ item_id: origin.item_id, dispatch_id: origin.dispatch_id, quantity: 1 }] };
 const excessive = { ...draft, items: [{item_id:origin.item_id,quantity:2}],parcel_origins:[{item_id:origin.item_id,dispatch_id:origin.dispatch_id,quantity:2}] };
 assert.equal((await f.req('/orders/' + f.order.id + '/returns','POST',excessive)).statusCode,409);
 assert.deepEqual(await snapshot(f.tenant),original);
 const unbound = { ...draft } as any; delete unbound.parcel_origins;
 assert.equal((await f.req('/orders/' + f.order.id + '/returns','POST',unbound)).statusCode,409);
 assert.deepEqual(await snapshot(f.tenant),original);
 const r = await f.ok('/orders/' + f.order.id + '/returns','POST',draft,201);
 assert.equal(r.state,'requested'); assert.equal(r.parcel_origins.length,1);
 const claimed = await snapshot(f.tenant);
 assert.deepEqual(claimed.stock,original.stock);assert.deepEqual(claimed.payment_entries,original.payment_entries);
 assert.equal((await f.ok('/orders/' + f.order.id)).returns.items[0].available,0);
 const body: any = {version:Number(r.version),shipping_refund:0,note:'Own genuine receive before pending dispatch',items:[{item_id:origin.item_id,accepted:1,restocked:1}]};
 if(on) {
  const policy = (await f.ok('/wms-lots')).policy;
  const stock_versions = [];
  for(const p of f.components) { const dto = await f.ok('/products/' + p.id), s = dto.stock.find((s:any)=>s.warehouse_id===f.warehouse);stock_versions.push({warehouse_id:f.warehouse,product_id:p.id,version:String(s.version)}); }
  body.wms_lots={client_key:randomUUID(),policy_version:String(policy.version),stock_versions,picks:origin.fragments.map((x:any)=>({issue_fragment_id:x.fragment_id,quantity:x.quantity,location:'REL-01'}))};
 }
 const received = await f.ok('/returns/' + r.id + '/receive','POST',body);
 assert.equal(received.state,'refund_pending');assert.equal(received.refund_amount,10000);
 const afterReturn = await snapshot(f.tenant);
 assert.equal(afterReturn.order_parcel_return_receipts.length,1);
 assert.deepEqual(afterReturn.payment_entries,original.payment_entries);assert.deepEqual(afterReturn.documents,original.documents);
 assert.deepEqual(afterReturn.order_items,original.order_items);assert.deepEqual(afterReturn.order_parcel_dispatches,original.order_parcel_dispatches);
 assert.equal((await f.ok('/orders/' + f.order.id)).status,'packed');
 for(const p of f.components) {const s=afterReturn.stock.find((x:any)=>x.row.product_id===p.id).row;assert.equal(s.on_hand,p.quantity);assert.equal(s.reserved,2*p.recipe);}
 await f.ok('/returns/' + r.id + '/receive','POST',body);
 assert.deepEqual(await snapshot(f.tenant),afterReturn,'Exact receive replay has no second quantity, claim or credit');
 assert.equal((await f.req('/order-parcel-releases/previews/' + f.releasePreview.id + '/release','POST',f.releaseBody)).statusCode,409);
 assert.deepEqual(await snapshot(f.tenant),afterReturn,'Old release preview cannot absorb changed return stock');
 const freshOrder=await f.ok('/orders/' + f.order.id);
 const preview=(await f.ok('/order-parcel-releases/plans/' + f.plan.id + '/previews','POST',{client_key:randomUUID(),order_version:String(freshOrder.version)},201)).preview;
 await f.ok('/order-parcel-releases/previews/' + preview.id + '/release','POST',{client_key:randomUUID(),scope_hash:preview.scope_hash,confirmed:true},201);
 const closed=await snapshot(f.tenant);
 for(const p of f.components){const s=closed.stock.find((x:any)=>x.row.product_id===p.id).row;assert.equal(s.on_hand,p.quantity);assert.equal(s.reserved,0);const reservation=closed.reservations.find((x:any)=>x.row.product_id===p.id).row;assert.equal(reservation.quantity,3*p.recipe);assert.equal(reservation.consumed_quantity,p.recipe);assert.equal(reservation.released_quantity,2*p.recipe);}
 assert.deepEqual(closed.payment_entries,original.payment_entries);assert.deepEqual(closed.documents,original.documents);
 assert.deepEqual(closed.order_items,original.order_items);assert.equal(closed.return_cases[0].row.refund_amount,10000);
 const final=await f.ok('/orders/' + f.order.id);assert.equal(final.status,'shipped');assert.equal(final.returns.items[0].available,0);
});

test('parcel RMA binds shipping consent and seals OLD tenant plus physical bin history after real receive',async()=>{
 const f=await fixture(false), target=await fixture(false,false);
 const origin=(await f.ok('/orders/'+f.order.id)).returns.parcel_origins[0];
 const draft=returnInput.parse({client_key:randomUUID(),reason:'Own sealed RMA source',shipping_refund:0,items:[{item_id:origin.item_id,quantity:1}],parcel_origins:[{item_id:origin.item_id,dispatch_id:origin.dispatch_id,quantity:1}]});
 const before=await snapshot(f.tenant);let admitted=false;
 await assert.rejects(tenantTx(f.tenant,async c=>{const rid=randomUUID();await c.query('SELECT order_parcel_return_request($1,$2,$3,NULL,$4)',[f.order.id,rid,user,draft]);admitted=true;await c.query("INSERT INTO return_cases(id,tenant_id,order_id,warehouse_id,number,kind,reason,client_key,request,requested_shipping) VALUES($1,$2,$3,$4,$5,'return',$6,$7,$8,1)",[rid,f.tenant,f.order.id,f.warehouse,'FORGED-'+rid,draft.reason,draft.client_key,draft]);}), (e:any)=>e.code==='23514'&&e.message==='Nieprawidłowe nowe zgłoszenie z paczek');
 assert(admitted);assert.deepEqual(await snapshot(f.tenant),before);
 const r=await f.ok('/orders/'+f.order.id+'/returns','POST',draft,201), requested=await snapshot(f.tenant);
 const body=receiveInput.parse({version:Number(r.version),shipping_refund:0,note:'Own complete native physical receive',items:[{item_id:origin.item_id,accepted:1,restocked:1}]});
 for(const attack of ['old-tenant','bin-journal']){let received=false;
  await assert.rejects(tenantTx(f.tenant,async c=>{await receiveReturn(c,{...f.actor,source:'manual'},r.id,body);received=true;await c.query('SET LOCAL ROLE postgres');
   if(attack==='old-tenant')await c.query('UPDATE stock SET tenant_id=$1,warehouse_id=$2,product_id=$3 WHERE tenant_id=$4 AND product_id=$5',[target.tenant,target.warehouse,target.components[0].id,f.tenant,f.components[0].id]);
   else await c.query("INSERT INTO stock_location_movements(tenant_id,warehouse_id,product_id,location,delta,kind) VALUES($1,$2,$3,'ZWROT',1,'stock_in')",[f.tenant,f.warehouse,f.components[0].id]);
  }),(e:any)=>e.code==='23514'&&e.message==='Dowód pochodzenia RMA zamknął zapisy tej transakcji');
  assert(received,attack+' reached actual receive');assert.deepEqual(await snapshot(f.tenant),requested,attack+' exact rollback');
 }
 let beforeProof=false;
 await assert.rejects(tenantTx(f.tenant,async c=>{
  const originalQuery=c.query.bind(c);
  (c as any).query=async(...args:any[])=>{if(!beforeProof&&String(args[0]).startsWith('SELECT order_parcel_return_finish_receive(')){beforeProof=true;await originalQuery("INSERT INTO stock_location_movements(tenant_id,warehouse_id,product_id,location,delta,kind) VALUES($1,$2,$3,'ZWROT',1,'stock_in')",[f.tenant,f.warehouse,f.components[0].id]);}return (originalQuery as any)(...args);};
  try{await receiveReturn(c,{...f.actor,source:'manual'},r.id,body);}finally{c.query=originalQuery;}
 }),(e:any)=>(e.status===409||e.code==='23514')&&e.message==='Dziennik lokalizacji nie odpowiada rzeczywistemu przyjęciu');
 assert(beforeProof);assert.deepEqual(await snapshot(f.tenant),requested,'Extra bin history before certificate also rolls back real goods and credit');
 const accepted=await f.ok('/returns/'+r.id+'/receive','POST',body);assert.equal(accepted.refund_amount,10000);
});

test('OFF commercial RMA request replay and new/replayed decisions pin current IAM after hydration',async()=>{
 const f=await fixture(false),origin=(await f.ok('/orders/'+f.order.id)).returns.parcel_origins[0];
 const draft=returnInput.parse({client_key:randomUUID(),reason:'Own late IAM request',items:[{item_id:origin.item_id,quantity:1}],parcel_origins:[{item_id:origin.item_id,dispatch_id:origin.dispatch_id,quantity:1}]});
 const r=await f.ok('/orders/'+f.order.id+'/returns','POST',draft,201);
 const decision=decisionInput.parse({version:Number(r.version),decision:'reject',note:'Own late IAM decision'});
 for(const mode of ['request-replay','decision-new','decision-replay']){
  if(mode==='decision-replay')await tenantTx(f.tenant,c=>decideReturn(c,f.actor,r.id,decision));
  const before=await snapshot(f.tenant);let hydrated=false;
  await assert.rejects(tenantTx(f.tenant,async c=>{
   const originalQuery=c.query.bind(c);
   (c as any).query=async (...args:any[])=>{const result=await (originalQuery as any)(...args);if(!hydrated&&args[0]==='SELECT * FROM return_cases WHERE id=$1'){hydrated=true;await originalQuery('SET LOCAL ROLE postgres');await originalQuery("UPDATE memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2",[f.tenant,user]);await originalQuery('SET LOCAL ROLE dyna_app');}return result;};
   try{if(mode==='request-replay')return await requestReturn(c,f.actor,f.order.id,draft);return await decideReturn(c,f.actor,r.id,decision);}finally{c.query=originalQuery;}
  }),(e:any)=>(e.status===403||e.code==='23514')&&e.message==='Brak aktualnego uprawnienia do paczek');
  assert(hydrated,mode+' reached real hydration');assert.deepEqual(await snapshot(f.tenant),before,mode+' exact rollback');
 }
});

test('commercial RMA positive shipping pool counts requested cases, releases rejected claims and bounds actual credit',async()=>{
 const f=await fixture(false,true,true,200),order=await f.ok('/orders/'+f.order.id),origins=order.returns.parcel_origins;
 const draft=(o:any,amount:number)=>({client_key:randomUUID(),reason:'Own original delivery amount',shipping_refund:amount,items:[{item_id:o.item_id,quantity:1}],parcel_origins:[{item_id:o.item_id,dispatch_id:o.dispatch_id,quantity:1}]});
 const first=await f.ok('/orders/'+f.order.id+'/returns','POST',draft(origins[0],150),201),before=await snapshot(f.tenant);
 assert.equal((await f.req('/orders/'+f.order.id+'/returns','POST',draft(origins[1],100))).statusCode,409);assert.deepEqual(await snapshot(f.tenant),before);
 await f.ok('/returns/'+first.id+'/decision','POST',{version:Number(first.version),decision:'reject',note:'Own release requested delivery claim'});
 const second=await f.ok('/orders/'+f.order.id+'/returns','POST',draft(origins[1],200),201),requested=await snapshot(f.tenant);
 const bad={version:Number(second.version),shipping_refund:201,note:'Own delivery beyond original price',items:[{item_id:origins[1].item_id,accepted:1,restocked:0}]};
 assert.equal((await f.req('/returns/'+second.id+'/receive','POST',bad)).statusCode,409);assert.deepEqual(await snapshot(f.tenant),requested);
 const accepted=await f.ok('/returns/'+second.id+'/receive','POST',{...bad,shipping_refund:200});
 const line=order.items.find((i:any)=>i.id===origins[1].item_id);assert.equal(accepted.refund_amount,Math.floor(line.line_total/line.quantity)+200);
 const after=await snapshot(f.tenant);for(const table of ['stock','stock_locations','stock_movements','stock_location_movements','payment_entries','documents'])assert.deepEqual(after[table],requested[table],table+' accepted without restock keeps goods/cash unchanged');
 const exhausted=await snapshot(f.tenant);assert.equal((await f.req('/orders/'+f.order.id+'/returns','POST',draft(origins[2],1))).statusCode,409);assert.deepEqual(await snapshot(f.tenant),exhausted);
});
