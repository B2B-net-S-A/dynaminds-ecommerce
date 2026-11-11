import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { pool } from '../server/db';

export type AdjustmentTestRow = Record<string, any>;
let ip = 0;

// Metadata belongs solely to a fresh disposable tenant. Physical quantities,
// openings, counts, reviews and adjustments always use ordinary business API.
export async function adjustmentActor(app: FastifyInstance, tenant: string, email = 'admin@demo.local') {
  const remoteAddress = '127.164.0.' + ++ip;
  const user = (await pool.query('SELECT id FROM users WHERE email=$1', [email])).rows[0].id;
  await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin') ON CONFLICT(tenant_id,user_id) DO UPDATE SET role='admin'", [tenant, user]);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'DynaDemo!2026' }, remoteAddress });
  assert.equal(login.statusCode, 200);
  const switched = await app.inject({ method: 'POST', url: '/api/workspaces/switch', payload: { tenant_id: tenant }, headers: { cookie: String(login.headers['set-cookie']).split(';')[0] }, remoteAddress });
  assert.equal(switched.statusCode, 200);
  const cookie = String(switched.headers['set-cookie']).split(';')[0];
  const request = (path: string, method: any = 'GET', body?: any, key?: AdjustmentTestRow) => app.inject({
    url: '/api' + (key ? '/v1' : '') + path, method, payload: body, remoteAddress,
    headers: key ? { authorization: 'Bearer ' + key.token } : { cookie },
  });
  const ok = async (path: string, method: any = 'GET', body?: any, status = 200, key?: AdjustmentTestRow): Promise<AdjustmentTestRow> => {
    const reply = await request(path, method, body, key);
    assert.equal(reply.statusCode, status, `${method} ${path}: HTTP ${reply.statusCode}`);
    return reply.json();
  };
  const actor = { tenantId: tenant, userId: user, role: 'admin' as const, source: 'manual' as const };
  return { tenant, user, cookie, actor, request, ok };
}

export async function stocktakeAdjustmentFixture(app: FastifyInstance, on = false, existingTenant?: string) {
  const tenant = existingTenant ?? randomUUID();
  if (!existingTenant) await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,'Own adjustment164','enterprise')", [tenant]);
  const f = await adjustmentActor(app, tenant);
  const warehouse = await f.ok('/warehouses', 'POST', { name: 'Own counted warehouse164', code: 'ADJ-' + randomUUID().slice(0, 8) });
  const products: AdjustmentTestRow[] = [];
  for (const cost of ['0', '1000', null]) {
    const p = await f.ok('/products', 'POST', { name: 'Counted cost ' + String(cost), sku: 'ADJ-' + randomUUID(), price: 1501, vat: 23, warehouse_id: warehouse.id, quantity: 4, location: 'A-01' }, 201);
    const bins = (await f.ok(`/stock-locations?warehouse_id=${warehouse.id}&product_id=${p.id}`)).data;
    assert.equal(bins.length, 1);
    await f.ok('/stock-location-moves', 'POST', { warehouse_id: warehouse.id, product_id: p.id, location: 'A-01', destination: 'B-02', quantity: 2, expected_version: String(bins[0].version), client_key: randomUUID(), note: 'Genuine two-bin opening' });
    products.push({ ...p, cost });
  }
  if (on) {
    const lines: AdjustmentTestRow[] = [];
    for (const p of products) {
      const stock = (await pool.query('SELECT version FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3', [tenant, warehouse.id, p.id])).rows[0];
      for (const location of ['A-01', 'B-02']) lines.push({ product_id: p.id, warehouse_id: warehouse.id, location, quantity: 2, stock_version: String(stock.version), lot_code: 'ADJ-' + randomUUID(), unit_cost_minor: p.cost });
    }
    const opening = (await f.ok('/wms-lots/opening-previews', 'POST', { client_key: randomUUID(), policy_version: '0', currency: 'PLN', note: 'Known zero, known and unknown genuine opening', lines }, 201)).preview;
    assert.equal(opening.ready, true);
    await f.ok('/wms-lots/opening-previews/' + opening.id + '/activate', 'POST', { client_key: randomUUID(), scope_hash: opening.scope_hash, confirmed: true, ack_unknown_costs: true }, 201);
  }
  return { ...f, warehouse, products, on };
}
export type AdjustmentFixture = Awaited<ReturnType<typeof stocktakeAdjustmentFixture>>;

export async function countedAdjustmentSource(f: AdjustmentFixture, mode: 'mixed'|'nop'|'shortage'|'surplus' = 'mixed', blind = false) {
  const path = f.on ? '/wms-lots/stocktakes' : '/stocktakes';
  const born = await f.ok(path, 'POST', { client_key: randomUUID(), warehouse_id: f.warehouse.id, name: 'Genuine physical count164', blind, ...(f.on ? { policy_version: '1' } : {}) }, f.on ? 201 : 200);
  const h = f.on ? born.stocktake : born;
  const detail = await f.ok(path + '/' + h.id + (f.on ? '/lines' : ''));
  const lines: AdjustmentTestRow[] = f.on ? detail.data : detail.lines;
  assert.equal(lines.length, 6); if (f.on) assert.equal(detail.meta.cursor, null);
  const measured = lines.map(l => ({ id: l.id, version: String(l.version),
    ...(f.on ? { basis_token: l.basis_token } : { expected_stock_version: String(l.current_stock_version) }),
    quantity: Number(l.current_quantity) + (mode === 'nop' ? 0 : mode === 'mixed' ? (l.location === 'A-01' ? -1 : 1) : mode === 'shortage' ? (l.location === 'A-01' ? -1 : 0) : (l.location === 'A-01' ? 1 : 0)),
  }));
  await f.ok(path + '/' + h.id + '/counts', 'POST', { client_key: randomUUID(), note: 'Actual measured quantities, no raw stock writes', lines: measured }, f.on ? 201 : 200);
  const current = await f.ok(path + '/' + h.id);
  let version: string, reviewHash: string | null = null, reviewId: string | null = null, scopeHash: string | null = null;
  if (f.on) {
    const surplus = lines.filter(l => measured.find(x => x.id === l.id)!.quantity > Number(l.current_quantity)).map(l => ({ line_id: l.id, unit_cost_minor: f.products.find(p => p.id === l.product_id)!.cost ?? '1000', currency: 'PLN' }));
    const review = (await f.ok(path + '/' + h.id + '/reviews', 'POST', { client_key: randomUUID(), version: String(current.stocktake.version), note: 'Separate review of all physical differences', surplus }, 201)).review;
    version = String(review.stocktake_version); reviewId = review.id; scopeHash = review.scope_hash;
  } else {
    const reviewed = await f.ok(path + '/' + h.id + '/review', 'POST', { version: String(current.version) });
    version = String(reviewed.version); reviewHash = reviewed.review_hash;
  }
  return { id: h.id as string, source_kind: f.on ? 'wms' as const : 'quantity' as const, version, review_hash: reviewHash, review_id: reviewId, scope_hash: scopeHash, lines, measured, mode };
}
