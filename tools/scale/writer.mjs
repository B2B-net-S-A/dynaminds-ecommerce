// Writes the planned dataset through the application's own code paths. Tenant setup goes through
// the real HTTP routes (buildApp + inject: signup, plan change, warehouse); bulk records go through
// the same domain functions the routes call (createProduct, createOrder, status transitions, scan,
// shipDemo, FV through the 230 preview and the 226 tax-issue, returns), each inside tenantTx, so RLS, triggers and
// guards apply exactly as in ordinary use. Must run under tsx (it imports server/*.ts).
// WMS lot tenants (A/C/E): the policy is switched on through the ordinary WMS opening (preview +
// activation; opening stock created before it becomes "opening" lots), the remaining stock arrives
// through PZ receipts (receiveWmsReceipt) in two waves, orders reserve FIFO layers in createOrder and
// scans/return receipts name the layers, as the WMS routes require.
import { randomBytes } from 'node:crypto';
import { uuidFrom } from './prng.mjs';
import { customerPlan, orderSteps, productPlan } from './plan.mjs';
import { nodeOffsetSeconds } from './simclock.mjs';
const simulatedClock = () => nodeOffsetSeconds() !== 0;

const SESSION = 'dyna_session';
const SESSION_REFRESH_MS = 2 * 3600_000;

export async function openRuntime({ connections, release }) {
  // Packaged release (schema-gated ordinary runtime, plain node); see release-runtime.mjs.
  if (release) return (await import('./release-runtime.mjs')).openReleaseRuntime({ buildRecord: release, connections });
  const db = await import('../../server/db.ts');
  db.pool.options.max = connections;
  const [{ buildApp }, domain, catalog, ws, li, tax, returns, status, wms] = await Promise.all([
    import('../../server/app.ts'), import('../../server/domain.ts'), import('../../server/catalog.ts'),
    import('../../server/workspace-routes.ts'), import('../../server/local-invoices.ts'), import('../../server/tax226-local-invoices.ts'),
    import('../../server/returns.ts'), import('../../server/legacy-return-on-command.ts'), import('../../server/wms-lots.ts')]);
  const app = await buildApp({});
  await app.ready();
  return { db, app, domain, catalog, ws, li, tax, returns, status, wms, close: async () => { await app.close(); await db.pool.end(); } };
}

const cookieOf = (res) => {
  const raw = [res.headers['set-cookie']].flat().find((v) => typeof v === 'string' && v.startsWith(SESSION + '='));
  if (!raw) throw new Error('Brak ciasteczka sesji w odpowiedzi ' + res.statusCode);
  return raw.split(';')[0].slice(SESSION.length + 1);
};
function expect(res, codes, what) {
  if (!codes.includes(res.statusCode)) throw new Error(`${what}: HTTP ${res.statusCode} ${res.body.slice(0, 300)}`);
  return res.body ? res.json() : null;
}

/** Idempotent per seed: an existing owner account is reused and gets a fresh ordinary session. */
export async function setupTenant(rt, tp) {
  const { app, db, ws } = rt;
  let row = (await db.pool.query('SELECT id FROM users WHERE email=$1', [tp.owner.email])).rows[0];
  let token;
  if (!row) {
    // A throwaway local test password; never printed or stored — later sessions come from loginWorkspace.
    const res = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: {
      email: tp.owner.email, name: tp.owner.name, password: randomBytes(24).toString('base64url'),
      organization: { name: tp.name, currency: 'PLN', locale: 'pl-PL' } } });
    expect(res, [201], 'signup ' + tp.slot);
    token = cookieOf(res);
    row = (await db.pool.query('SELECT id FROM users WHERE email=$1', [tp.owner.email])).rows[0];
  } else token = (await ws.loginWorkspace({ id: row.id, name: tp.owner.name, email: tp.owner.email })).token;
  const me = (await db.pool.query(
    `SELECT m.tenant_id,t.plan FROM memberships m JOIN tenants t ON t.id=m.tenant_id WHERE m.user_id=$1 AND m.role='admin' AND t.name=$2`, [row.id, tp.name])).rows;
  if (me.length !== 1) throw new Error(`Konto ${tp.slot} ma ${me.length} organizacji o nazwie ${tp.name}; oczekiwano 1`);
  const tenant = { slot: tp.slot, tenantId: me[0].tenant_id, userId: row.id, token, tokenAt: Date.now(), tp };
  const call = (method, url, payload) => app.inject({ method, url, cookies: { [SESSION]: tenant.token }, ...(payload ? { payload } : {}) });
  if (me[0].plan !== 'enterprise') expect(await call('PATCH', '/api/workspaces/plan', { plan: 'enterprise' }), [200], 'plan ' + tp.slot);
  const warehouses = expect(await call('GET', '/api/warehouses'), [200], 'warehouses').data;
  if (!warehouses.some((w) => w.code === tp.second_warehouse.code))
    expect(await call('POST', '/api/warehouses', tp.second_warehouse), [200], 'warehouse ' + tp.slot);
  const all = expect(await call('GET', '/api/warehouses'), [200], 'warehouses').data;
  const main = all.find((w) => w.code === 'MAIN'), second = all.find((w) => w.code === tp.second_warehouse.code);
  if (!main || !second) throw new Error('Brak magazynów firmy ' + tp.slot);
  tenant.warehouses = [main.id, second.id];
  tenant.actor = { tenantId: tenant.tenantId, userId: tenant.userId, role: 'admin', source: 'manual' };
  const series = await rt.li.createLocalInvoiceSeries(invoiceActor(rt, tenant), {
    client_key: tp.series.client_key, name: `Seria skali ${tp.slot}`, prefix: tp.series.prefix,
    seller: tp.seller, payment_terms_days: 14, payment_instructions: 'Przelew na rachunek firmy', notes: '', seller_vat_status: 'active_domestic' });
  tenant.seriesId = series.series.id;
  tenant.call = call;
  return tenant;
}
// A new session for every order under --simulate-days: sessions live 8 h of database time, and with the clock
// jumping a day at a time the age check alone let an expired token reach the invoice step (27.10.2026, days 71 and
// 107 of a 180-day 1 % run: 401 "Sesja lub klucz FV wygasły", no session row of that day). One login per order is cheap.
async function refreshSession(rt, tenant) {
  if (!simulatedClock() && Date.now() - tenant.tokenAt < SESSION_REFRESH_MS) return;
  tenant.token = (await rt.ws.loginWorkspace({ id: tenant.userId, name: tenant.tp.owner.name, email: tenant.tp.owner.email })).token;
  tenant.tokenAt = Date.now();
}
const nativeReq = (tenant) => ({ actor: tenant.actor, currentUser: { id: tenant.userId, tenant_id: tenant.tenantId }, headers: {}, cookies: { [SESSION]: tenant.token } });
const invoiceActor = (rt, tenant) => rt.li.localInvoiceRequestActor(nativeReq(tenant), SESSION);
const taxActor = (rt, tenant) => rt.tax.taxInvoiceActor(nativeReq(tenant), SESSION);

/** Product ids by plan index for everything already present (resume). */
export async function loadProducts(rt, tenant) {
  const ids = new Map();
  const rows = (await rt.db.pool.query("SELECT id,sku FROM products WHERE tenant_id=$1 AND sku LIKE 'SC-%'", [tenant.tenantId])).rows;
  for (const r of rows) ids.set(Number(r.sku.slice(r.sku.lastIndexOf('-') + 1)), r.id);
  return ids;
}

/** Products [from, to) in one ordinary transaction; skips SKUs that already exist. */
export async function writeProducts(rt, p, t, tenant, from, to, demandMap, ids, stats) {
  const { domain, catalog } = rt;
  await tenantRun(rt, tenant, stats)(async (c) => {
    for (let i = from; i < to; i++) {
      if (ids.has(i)) continue;
      const pp = productPlan(p, t, i, demandMap);
      // Lot tenants: only opening stock exists before the WMS opening; the rest comes through PZ.
      const quantity = pp.lots ? (pp.lots.opening?.quantity ?? 0) : pp.quantity;
      const body = { name: pp.name, sku: pp.sku, ean: pp.ean, price: pp.price, vat: pp.vat, category: pp.category,
        description: `Produkt syntetyczny testu skali (${pp.kind}).`, warehouse_id: tenant.warehouses[pp.warehouse],
        quantity, location: pp.location, kind: pp.kind };
      if (pp.parent !== undefined) body.parent_id = ids.get(pp.parent);
      if (pp.components) body.components = pp.components.map((x) => ({ product_id: ids.get(x.index), quantity: x.quantity }));
      const created = await catalog.createProduct(c, tenant.actor, domain.productSchema.parse(body));
      ids.set(i, created.id);
      stats.products++;
    }
  });
}

// ---- WMS lots (A/C/E) ---------------------------------------------------------------------------
const policyOf = (rt, tenant) => rt.db.tenantTx(tenant.tenantId, (c) => rt.wms.wmsLotsPolicyInTx(c), { wmsAdmission: 'read' });

/** Switch the WMS lot policy on through the ordinary opening. Every positive bin at this point is
 * planned opening stock; its lot code and cost (unknown = null) come from the plan. */
export async function enableLots(rt, p, t, tenant, ids, demandMap, stats) {
  const pol = await policyOf(rt, tenant);
  if (pol.enabled) return { already: true, policy_version: String(pol.version) };
  const byId = new Map([...ids].map(([i, id]) => [id, i]));
  const bins = (await rt.db.tenantTx(tenant.tenantId, (c) => c.query(`SELECT b.warehouse_id,b.product_id,b.location,b.quantity,s.version::text stock_version
    FROM stock_locations b JOIN stock s USING(tenant_id,warehouse_id,product_id) WHERE b.quantity>0 ORDER BY b.product_id,b.location`), { wmsAdmission: 'read' })).rows;
  const lines = bins.map((b) => {
    const i = byId.get(b.product_id), op = i === undefined ? undefined : productPlan(p, t, i, demandMap).lots?.opening;
    if (!op || op.quantity !== b.quantity) throw new Error(`Otwarcie WMS ${tenant.slot}: nieplanowany stan ${b.product_id} ${b.location} ${b.quantity}`);
    return { warehouse_id: b.warehouse_id, product_id: b.product_id, location: b.location, quantity: b.quantity, stock_version: b.stock_version,
      lot_code: op.lot_code, unit_cost_minor: op.unit_cost_minor };
  });
  stats.tx += 2;
  const pv = await rt.wms.createWmsOpeningPreview(tenant.actor, { client_key: uuidFrom(p.seed, tenant.slot, 'wms-opening-preview'),
    policy_version: String(pol.version), currency: 'PLN', note: 'Otwarcie magazynu z partiami (dane testu skali)', lines });
  if (!pv.preview.ready) throw new Error(`Otwarcie WMS ${tenant.slot} niegotowe: ${JSON.stringify(pv.preview.issues)}`);
  await rt.wms.activateWmsOpening(tenant.actor, pv.preview.id, { client_key: uuidFrom(p.seed, tenant.slot, 'wms-opening'),
    scope_hash: pv.preview.scope_hash, confirmed: true, ack_unknown_costs: lines.some((l) => l.unit_cost_minor === null) });
  stats.opening_lines += lines.length;
  return { already: false, opening_lines: lines.length, unknown_cost_lines: lines.filter((l) => l.unit_cost_minor === null).length };
}

/** Planned PZ documents of a lot tenant: per wave, per warehouse, chunks of at most `size` lines. */
export function receiptDocuments(p, t, demandMap, size = 500) {
  const docs = [];
  for (const wave of [1, 2])
    for (const w of [0, 1]) {
      let lines = [];
      const flush = () => { if (lines.length) docs.push({ wave, warehouse: w, chunk: docs.filter((d) => d.wave === wave && d.warehouse === w).length, lines }); lines = []; };
      for (let i = 0; i < p.perTenant[t].skus; i++) {
        const pp = productPlan(p, t, i, demandMap);
        const rc = pp.warehouse === w ? pp.lots?.receipts?.find((x) => x.wave === wave) : undefined;
        if (!rc) continue;
        lines.push({ index: i, location: pp.location, quantity: rc.quantity, lot_code: rc.lot_code, unit_cost_minor: rc.unit_cost_minor, expiry_date: rc.expiry_date });
        if (lines.length === size) flush();
      }
      flush();
    }
  return docs;
}
/** One planned PZ through the ordinary WMS receipt (its own tenantTx); skipped when already posted. */
export async function writeReceipt(rt, p, tenant, doc, ids, stats) {
  const client_key = uuidFrom(p.seed, tenant.slot, 'pz', doc.wave, doc.warehouse, doc.chunk);
  const warehouseId = tenant.warehouses[doc.warehouse];
  const pre = await rt.db.tenantTx(tenant.tenantId, async (c) => {
    if ((await c.query('SELECT 1 FROM wms_operations WHERE client_key=$1', [client_key])).rowCount) return null;
    const productIds = doc.lines.map((l) => ids.get(l.index));
    const v = new Map((await c.query('SELECT product_id,version::text v FROM stock WHERE warehouse_id=$1 AND product_id=ANY($2::uuid[])', [warehouseId, productIds])).rows.map((r) => [r.product_id, r.v]));
    const pol = await rt.wms.wmsLotsPolicyInTx(c);
    return { policy_version: String(pol.version), currency: pol.currency, stock_versions: productIds.map((id) => ({ warehouse_id: warehouseId, product_id: id, version: v.get(id) ?? '0' })) };
  }, { wmsAdmission: 'read' });
  stats.tx++;
  if (!pre) return false;
  stats.tx++;
  await rt.wms.receiveWmsReceipt(tenant.actor, { client_key, policy_version: pre.policy_version, warehouse_id: warehouseId, stock_versions: pre.stock_versions,
    lines: doc.lines.map((l) => ({ product_id: ids.get(l.index), location: l.location, quantity: l.quantity, lot_code: l.lot_code,
      unit_cost_minor: l.unit_cost_minor, currency: pre.currency, expiry_date: l.expiry_date })),
    note: `PZ testu skali: dostawa ${doc.wave}, magazyn ${doc.warehouse + 1}, część ${doc.chunk + 1}`, confirmed: true });
  stats.receipts++; stats.receipt_lines += doc.lines.length;
  return true;
}

const version = async (c, id) => (await c.query('SELECT version::text v FROM orders WHERE id=$1', [id])).rows[0].v;
export async function orderState(rt, tenant, id, o) {
  const q = (sql, args) => rt.db.pool.query(sql, args).then((r) => r.rows);
  const [order] = await q('SELECT status FROM orders WHERE id=$1 AND tenant_id=$2', [id, tenant.tenantId]);
  const invoice = (await q("SELECT 1 FROM documents WHERE order_id=$1 AND tenant_id=$2 AND kind='invoice' AND mode IN ('local_invoice','invoice230')", [id, tenant.tenantId])).length > 0;
  const ret = o.return ? (await q('SELECT id FROM return_cases WHERE client_key=$1', [uuidFrom(o.key, 'return')]))[0] : undefined;
  return { status: order.status, invoice, returnId: ret?.id };
}
/** Find orders of this batch that a previous run already created (marker in the ordinary note). */
export async function findOrders(rt, tenant, keys) {
  const rows = (await rt.db.pool.query('SELECT id,note FROM orders WHERE tenant_id=$1 AND note=ANY($2)', [tenant.tenantId, keys])).rows;
  return new Map(rows.map((r) => [r.note, r.id]));
}

/** Order steps split where the application itself opens transactions: the local FV preview and issue
 * (previewLocalInvoice, issueLocalInvoiceWithTax) always run in their own tenantTx. */
export function orderSegments(o) {
  const steps = orderSteps(o), i = steps.indexOf('invoice'), r = steps.indexOf('return_request');
  const pre = steps.filter((s) => s !== 'invoice' && !s.startsWith('return_'));
  return { pre, invoice: i >= 0 ? ['invoice'] : [], post: r >= 0 ? steps.slice(r) : [] };
}
/** Fresh slot for a planned order; a previous run's committed state is read back first (resume). */
export async function orderSlot(rt, tenant, o, existingId) {
  if (!existingId) return { id: undefined, state: { status: 'new', invoice: false, returnId: undefined } };
  return { id: existingId, state: await orderState(rt, tenant, existingId, o) };
}
/** One ordinary transaction of this tenant; counted, because source-mode tenantTx carries schema preflights. */
export function tenantRun(rt, tenant, stats) {
  return (fn) => { stats.tx++; return rt.db.tenantTx(tenant.tenantId, fn); };
}

/** Invoice of a shipped order: 230 preview (POST /api/invoice230/orders/:id/previews) issued through the tax-issue
 * (POST /api/local-invoices/previews/:id/tax-issue dispatches a 230 preview to its own FV-S sub-series). Not the 157
 * preview: the sealed 157 budget (local_invoice_budget, 157:137) refuses a company's 2001st local invoice for life,
 * and the full plan has ~7 400 per company (run full02, 29.10). The order version is a plain read (the preview
 * re-checks it under its own lock); preview and issue each run in the application's own transaction. */
export async function issueOrderInvoice(rt, tenant, o, id, cust) {
  const ver = (await rt.db.pool.query('SELECT version::text v FROM orders WHERE id=$1 AND tenant_id=$2', [id, tenant.tenantId])).rows[0].v;
  const a = taxActor(rt, tenant);
  const pv = await rt.i230.invoice230Preview(a, id, { client_key: uuidFrom(o.key, 'invoice230-preview'), series_id: tenant.seriesId,
    order_version: ver, shipping_vat: 23, sell_date: new Date().toISOString().slice(0, 10),
    buyer: { kind: 'consumer', name: cust.name, address: { street: cust.address.street, postal_code: cust.address.postal_code, city: cust.address.city, country: 'PL' } } });
  await rt.tax.issueLocalInvoiceWithTax(a, pv.preview.id, { client_key: uuidFrom(o.key, 'invoice230-issue'),
    scope_hash: pv.preview.scope_hash, confirmed: true, local_only: true });
}

/** Drives one planned order through `steps`. `run(fn)` supplies the transaction: a fresh tenantTx per
 * step (ordinary request granularity) or the caller's batch transaction. Each step checks the
 * current state first, so a rerun continues from the last committed step. */
export async function driveOrder(rt, p, t, tenant, o, ids, slot, steps, run, stats) {
  const { domain, status: st, returns } = rt;
  const a = tenant.actor, state = slot.state;
  await refreshSession(rt, tenant);
  const move = async (to) => {
    await run(async (c) => st.transitionDirectLegacyOnReturnInTx(c, a, slot.id, to, await version(c, slot.id)));
    state.status = to; stats.steps++;
  };
  for (const step of steps) {
    const id = slot.id;
    if (step === 'create') {
      if (id) continue;
      const cust = customerPlan(p, t, o.customer);
      const input = domain.orderSchema.parse({ customer_name: cust.name, email: cust.email, warehouse_id: tenant.warehouses[o.warehouse],
        address: cust.address, shipping_cost: o.shipping_cost, note: o.key,
        items: o.lines.map((l) => ({ product_id: ids.get(l.index), quantity: l.quantity })) });
      slot.id = (await run((c) => domain.createOrder(c, a, input))).id;
      stats.orders++; stats.steps++;
    } else if (step === 'pay') { if (state.status === 'new') await move('paid'); }
    else if (step === 'pick') { if (state.status === 'paid') await move('picking'); }
    else if (step === 'scan') {
      if (state.status !== 'picking') continue;
      await run(async (c) => {
        if (tenant.lots) {
          // Lot tenants: every reserved FIFO layer is scanned by name (one call per unit, as the scanner does).
          const layers = (await c.query(`SELECT p.sku,a.location,a.layer_id,a.quantity,a.scanned FROM wms_reservation_layers a
            JOIN order_pick_items p ON (p.order_id,p.product_id)=(a.order_id,a.product_id)
            WHERE a.order_id=$1 AND a.state='active' ORDER BY p.sku,a.location,a.layer_id`, [id])).rows;
          for (const l of layers)
            for (let u = l.scanned; u < l.quantity; u++) {
              await domain.scan(c, a, id, l.sku, l.location, undefined, { client_key: uuidFrom(o.key, 'scan', l.sku, l.location, l.layer_id, u), layer_id: l.layer_id });
              stats.scans++;
            }
          return;
        }
        const items = (await c.query('SELECT product_id,sku,quantity,scanned FROM order_pick_items WHERE order_id=$1 ORDER BY sku', [id])).rows;
        for (const it of items) {
          const loc = (await c.query('SELECT location FROM reservation_locations WHERE order_id=$1 AND product_id=$2 ORDER BY location LIMIT 1', [id, it.product_id])).rows[0]?.location;
          for (let u = it.scanned; u < it.quantity; u++) {
            await domain.scan(c, a, id, it.sku, loc, undefined, { client_key: uuidFrom(o.key, 'scan', it.sku, u) });
            stats.scans++;
          }
        }
      });
      stats.steps++;
    } else if (step === 'pack') { if (state.status === 'picking') await move('packed'); }
    else if (step === 'ship') { if (state.status === 'packed') { await run((c) => domain.shipDemo(c, a, id)); state.status = 'shipped'; stats.steps++; } }
    else if (step === 'cancel') { if (state.status === 'new' || state.status === 'paid') await move('cancelled'); }
    else if (step === 'invoice') {
      if (state.invoice) continue;
      stats.tx += 2;
      await issueOrderInvoice(rt, tenant, o, id, customerPlan(p, t, o.customer));
      state.invoice = true; stats.invoices++; stats.steps += 2;
    } else if (step === 'return_request') {
      if (state.returnId) continue;
      state.returnId = await run(async (c) => {
        const items = (await c.query('SELECT id FROM order_items WHERE order_id=$1 AND product_id=$2', [id, ids.get(o.lines[o.return.line].index)])).rows;
        const r = await returns.requestReturn(c, a, id, returns.returnInput.parse({ client_key: uuidFrom(o.key, 'return'),
          reason: 'Towar nie spełnił oczekiwań klienta', items: [{ item_id: items[0].id, quantity: o.return.quantity }] }));
        return r.id;
      });
      stats.returns++; stats.steps++;
    } else if (step === 'return_receive') {
      await run(async (c) => {
        const r = await returns.getReturn(c, state.returnId);
        if (r.state !== 'requested') return;
        const input = { version: Number(r.version), shipping_refund: 0, note: 'Przyjęto zwrot w magazynie',
          items: r.items.map((x) => ({ item_id: x.item_id, accepted: x.requested, restocked: x.requested })) };
        if (tenant.lots) input.wms_lots = await returnLots(rt, c, o, id, state.returnId);
        await returns.receiveReturn(c, a, state.returnId, input);
        stats.steps++;
      });
    } else if (step === 'return_refund') {
      await run(async (c) => {
        const r = await returns.getReturn(c, state.returnId);
        if (r.state !== 'refund_pending') return;
        await returns.recordRefund(c, a, state.returnId, { version: Number(r.version), amount: r.settlement_amount, reference: 'Zwrot przelewem ' + o.key.slice(-12), confirmed: true });
        stats.refunds++; stats.steps++;
      });
    }
  }
}

/** WMS part of a lot tenant's return receipt: restock exactly what was issued, fragment by fragment. */
async function returnLots(rt, c, o, orderId, returnId) {
  const wh = (await c.query('SELECT warehouse_id FROM return_cases WHERE id=$1', [returnId])).rows[0].warehouse_id;
  const need = (await c.query(`SELECT (x->>'product_id')::uuid product_id,sum(i.requested*(x->>'quantity')::int)::int qty
    FROM return_items i CROSS JOIN LATERAL jsonb_array_elements(i.components) x WHERE i.return_id=$1 GROUP BY 1 ORDER BY 1`, [returnId])).rows;
  const frags = (await c.query(`SELECT f.id,f.product_id,f.location,(f.quantity-coalesce((SELECT sum(x.quantity) FROM wms_return_fragments x
    WHERE x.issue_fragment_id=f.id),0))::int left_qty FROM wms_issue_fragments f WHERE f.order_id=$1 ORDER BY f.product_id,f.id`, [orderId])).rows;
  const picks = [], stock_versions = [];
  for (const n of need) {
    let rem = n.qty;
    for (const f of frags) {
      if (!rem) break;
      if (f.product_id !== n.product_id || f.left_qty <= 0) continue;
      const q = Math.min(rem, f.left_qty);
      picks.push({ issue_fragment_id: f.id, quantity: q, location: f.location });
      rem -= q;
    }
    if (rem) throw new Error(`Zwrot ${o.key}: brak wydanych fragmentów dla ${n.product_id}`);
    const v = (await c.query('SELECT version::text v FROM stock WHERE warehouse_id=$1 AND product_id=$2', [wh, n.product_id])).rows[0]?.v ?? '0';
    stock_versions.push({ warehouse_id: wh, product_id: n.product_id, version: v });
  }
  const pol = await rt.wms.wmsLotsPolicyInTx(c);
  return { client_key: uuidFrom(o.key, 'return-wms'), policy_version: String(pol.version), stock_versions, picks };
}

/** A batch of planned orders. tx-mode "step": every step in its own tenantTx, as ordinary requests.
 * tx-mode "batch": all pre-invoice steps of the batch in one tenantTx, invoices in their own
 * application transactions, then all return steps in one tenantTx (same functions, fewer commits). */
export async function writeOrderBatch(rt, p, t, tenant, batch, ids, existing, txMode, stats) {
  const own = tenantRun(rt, tenant, stats);
  const slots = [];
  for (const o of batch) slots.push(await orderSlot(rt, tenant, o, existing.get(o.key)));
  if (txMode === 'step') {
    for (let k = 0; k < batch.length; k++) await driveOrder(rt, p, t, tenant, batch[k], ids, slots[k], orderSteps(batch[k]), own, stats);
    return;
  }
  const inBatch = (segment) => own(async (c) => {
    for (let k = 0; k < batch.length; k++) {
      const steps = orderSegments(batch[k])[segment];
      if (steps.length) await driveOrder(rt, p, t, tenant, batch[k], ids, slots[k], steps, (fn) => fn(c), stats);
    }
  });
  await inBatch('pre');
  for (let k = 0; k < batch.length; k++) await driveOrder(rt, p, t, tenant, batch[k], ids, slots[k], orderSegments(batch[k]).invoice, own, stats);
  if (!batch.some((o) => o.return)) return;
  // Lot tenants: one return receipt per transaction, as the route does. A WMS return leaves the
  // deferred WMS consistency triggers IMMEDIATE for the rest of its transaction, so a second return
  // in the same transaction fails on its first stock update ("WMS nie zgadza się ze stanem…").
  if (tenant.lots) {
    for (let k = 0; k < batch.length; k++) {
      const steps = orderSegments(batch[k]).post;
      if (steps.length) await own((c) => driveOrder(rt, p, t, tenant, batch[k], ids, slots[k], steps, (fn) => fn(c), stats));
    }
    return;
  }
  await inBatch('post');
}
