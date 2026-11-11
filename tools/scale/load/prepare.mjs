// Unmeasured preparation of each measured command against the running release (tools/scale/load/README.md).
// Every write is prepared just before it is sent, from current state read over the ordinary API (versions,
// balances, previews, lot positions), so the strict bindings can compare the response with exact expectations.
// Each client owns a disjoint share of the dataset's candidates (index mod clients) and the orders it created,
// so clients do not race each other on the same order; races with the background workers remain real. Products and
// lot positions are shared (finite stock, profile): a stock row version read here can change before the command is
// sent, which is the pre-labelled race of lib.mjs EXPECTED_RACES (409, not retried, no-effect readback below).
import { LINE_BUCKETS, UNIT_BUCKETS } from '../plan.mjs';
import { weighted, int } from '../prng.mjs';
import { orderTotal, lineRefund, cursorBefore, negativeFragments, transferFragments, returnPicks, pickOf, uuid4, contentionRace, isContentionCommand } from './lib.mjs';

export class PrepError extends Error {
  constructor(route, status, detail) { super(`${route} ${status} ${detail ?? ''}`.slice(0, 400)); this.route = route; this.status = status; this.detail = detail; }
}
export class NotBindable extends Error {}
const DAY = 86_400_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** ctx: { slot, tenant_id, cookie, wms, main, spare, series_id, hot?, contention? }, api(method, route, path, body) → {status, json}.
 * datasetBefore: epoch ms before which the load created no order (the run start); order_detail candidates are read
 * from there, because after a phase of order_create the newest pages hold only the load's own orders.
 * ctx.hot: the tenant's frozen hot-SKU product ids (setup.mjs), half of stock_operation targets them;
 * ctx.contention[phase]: the phase's frozen finite-stock SKU, sent by the clients of lib.mjs contentionClients
 * (contentionEligible). E-mails carry the run marker and the phase: unique per command across phases and runs, so the
 * no-effect readback and the reconciliation's duplicate check see only this command (dry run 29.10.2026). */
export function createPreparer({ ctx, api, r, client, clients, now = () => Date.now(), datasetBefore = null, phase = null, contentionEligible = false }) {
  const st = { products: null, detail: null, invoiceCandidates: null, returnCandidates: null, created: [], paid: [], picking: [], shipped: [], policy: null, spareLocation: null, counters: {}, contentionDone: false };
  const ok = async (method, route, path, body, codes = [200, 201]) => {
    const res = await api(method, route, path, body);
    if (!codes.includes(res.status)) throw new PrepError(`${method} ${route}`, res.status, res.json?.detail ?? res.json?.title ?? res.json?.error ?? null);
    return res.json;
  };
  const mine = (rows) => rows.filter((_, i) => i % clients === client);
  const counter = (k) => (st.counters[k] = (st.counters[k] ?? 0) + 1);
  /** Up to `max` keyset pages from `after0` (exclusive); `.end` is true when the list ended before `max`. */
  async function pages(route, base, max = 5, after0 = null) {
    const out = []; let after = after0, end = false;
    for (let i = 0; i < max; i++) {
      const j = await ok('GET', route, base + (after ? `&after=${encodeURIComponent(after)}` : ''));
      out.push(...j.data); after = j.meta?.cursor ?? null; if (!j.meta?.has_more || !after) { end = true; break; }
    }
    return Object.assign(out, { end });
  }
  // Catalogue window: three pages of 200 from a random product id (keyset `after`), wrapped to the start when the
  // list ends first, so a catalogue of thousands of SKUs is ordered evenly instead of only its first 600 products.
  async function products() {
    if (!st.products) {
      const base = `/api/products?warehouse_id=${ctx.main}&sellable=true&limit=200`, start = uuid4(r);
      const rows = await pages('/api/products', base, 3, start);
      if (rows.end && rows.length < 600) rows.push(...(await pages('/api/products', base, 3)).filter((p) => p.id <= start));
      const seen = new Set();
      st.products = rows.filter((p) => !seen.has(p.id) && seen.add(p.id) && ['simple', 'variant'].includes(p.kind) && p.active !== false && Number.isSafeInteger(p.price));
    }
    return st.products;
  }
  const order = (id) => ok('GET', '/api/orders/:id', `/api/orders/${id}`);

  // ---- reads ----------------------------------------------------------------------------------------------------
  async function orderList() {
    const historical = r() < 0.5, filtered = r() < 0.5, q = { limit: 50 };
    if (filtered) q.status = 'shipped';
    if (historical) q.after = cursorBefore(new Date(now() - 30 * DAY).toISOString());
    return { query: q, expected: { min_rows: 1, max_rows: 50 } };
  }
  async function catalogSearch() {
    const ps = await products(), p = pickOf(r, ps), sku = r() < 0.5, roll = r(), q = { limit: 50 };
    if (r() < 0.5) q.warehouse_id = ctx.main;
    if (roll < 0.5) { q.search = sku ? p.sku : p.name.split(' ').slice(-2).join(' '); return { query: q, expected: { min_rows: 1, max_rows: 50 } }; }
    if (roll < 0.75) { q.search = (sku ? 'SC-ZZ-' : 'qzxw ') + uuid4(r).slice(0, 8); return { query: q, expected: { min_rows: 0, max_rows: 0 } }; }
    q.search = sku ? p.sku.slice(0, 3) : p.name.split(' ')[0];
    return { query: q, expected: { min_rows: 1, max_rows: 50 } };
  }
  async function orderDetail() {
    // Dataset orders the load never writes (no shipped ones: invoices/returns touch them).
    // Generated orders only (note "scale:<tag>:…"): orders the load creates are written by its own pipeline and the worker.
    if (!st.detail) st.detail = mine((await pages('/api/orders', '/api/orders?status=new,paid,picking,packed,cancelled&limit=200', 3,
      datasetBefore == null ? null : cursorBefore(new Date(datasetBefore).toISOString()))).filter((o) => String(o.note ?? '').startsWith('scale:')));
    if (!st.detail.length) throw new PrepError('order_detail', 0, 'no stable dataset orders');
    const o = pickOf(r, st.detail);
    return { order_id: o.id, expected: { version: String(o.version), status: o.status, total: o.total } };
  }

  // ---- order pipeline (own orders) -------------------------------------------------------------------------------
  async function orderCreateCommand() {
    // Finite stock: products with ≥ 8 available (this client's last catalogue read, minus what it ordered since),
    // at most a quarter of that per line, so that the clients together rarely meet a real shortage.
    if (counter('catalogue') % 10 === 0) st.products = null;
    const ps = (await products()).filter((p) => Number(p.available) >= 8);
    if (ps.length < 25) throw new PrepError('order_create', 0, `only ${ps.length} products with stock ≥ 8`);
    const [lo, hi] = weighted(r, LINE_BUCKETS), lines = Math.min(int(r, lo, hi), 20), chosen = new Map();
    while (chosen.size < lines) { const p = pickOf(r, ps); if (!chosen.has(p.id)) chosen.set(p.id, p); }
    const items = [...chosen.values()].map((p) => { const [a, b] = weighted(r, UNIT_BUCKETS); return { product_id: p.id, quantity: Math.max(1, Math.min(int(r, a, b), 20, Math.floor(Number(p.available) / 4))) }; });
    for (const i of items) chosen.get(i.product_id).available = Number(chosen.get(i.product_id).available) - i.quantity;
    const shipping = r() < 0.5 ? 0 : 1299, n = counter('create');
    const body = { customer_name: `Klient obciążenia ${ctx.slot}${client}-${n}`, email: emailOf(n, ''), warehouse_id: ctx.main,
      source: 'manual', currency: 'PLN', payment_mode: 'prepaid', address: { street: `Testowa ${1 + (n % 90)}`, city: 'Poznań', postal_code: '60-001', country: 'PL', phone: '500000000' },
      shipping_cost: shipping, items, note: `load ${ctx.slot}${client}-${n}` };
    return { client_key: uuid4(r), body, expected: { total: orderTotal(items, new Map(ps.map((p) => [p.id, p.price])), shipping) } };
  }
  const created = (data) => st.created.push({ id: data.id });
  const emailOf = (n, suffix) => `${String(ctx.marker ?? 'load').toLowerCase()}-${ctx.slot.toLowerCase()}${client}-${phase ?? 'x'}-${n}${suffix}@scale.example.test`;
  // Contention command: the whole available quantity of the phase's frozen SKU (read now), one line. Demand of all
  // contention clients exceeds the stock, so all but at most one are refused by the native stock check (labelled race
  // of this command only); the readback finds no order with the command's unique e-mail.
  async function contentionCommand(plan) {
    st.contentionDone = true;
    const j = await ok('GET', '/api/inventory', `/api/inventory?warehouse_id=${ctx.main}&product_id=${plan.product_id}`);
    const quantity = Math.max(1, Math.min(20, Number(j.data?.[0]?.available ?? 0)));
    const items = [{ product_id: plan.product_id, quantity }], shipping = r() < 0.5 ? 0 : 1299, n = counter('create');
    const email = emailOf(n, '-hot');
    const body = { customer_name: `Klient obciążenia ${ctx.slot}${client}-${n} (wyścig)`, email, warehouse_id: ctx.main, source: 'manual', currency: 'PLN', payment_mode: 'prepaid',
      address: { street: `Testowa ${1 + (n % 90)}`, city: 'Poznań', postal_code: '60-001', country: 'PL', phone: '500000000' }, shipping_cost: shipping, items, note: `load ${ctx.slot}${client}-${n} contention ${phase}` };
    return { cmd: { client_key: uuid4(r), body, expected: { total: orderTotal(items, new Map([[plan.product_id, plan.price]]), shipping) } }, after: created, contention: true, race: contentionRace(plan.sku),
      noEffect: async () => !(await ok('GET', '/api/orders', `/api/orders?search=${encodeURIComponent(email)}&limit=5`)).data.some((o) => o.email === email) };
  }
  async function orderCreate() {
    const plan = ctx.contention?.[phase] ?? null;
    if (isContentionCommand({ eligible: contentionEligible, done: st.contentionDone, plan })) return contentionCommand(plan);
    return { cmd: await orderCreateCommand(), after: created };
  }
  async function createUnmeasured() {
    const c = await orderCreateCommand();
    const d = await ok('POST', '/api/orders', '/api/orders', c.body, [201]); return d;
  }
  // An own order is used for a later write only after the order.created rule's add_note has run: the worker's update
  // bumps the order version, so using the order earlier races the background worker (409 "Zamówienie zmieniło się").
  const noted = (d) => !ctx.marker || String(d.note ?? '').includes(ctx.marker);
  async function takeNew() {
    for (let i = 0; i < Math.min(5, st.created.length); i++) {
      const d = await order(st.created[i].id);
      if (noted(d)) { st.created.splice(i, 1); return d; }
    }
    const o = await createUnmeasured();
    for (const t0 = now(); now() - t0 < 120000;) { await sleep(1000); const d = await order(o.id); if (noted(d)) return d; }
    throw new PrepError('automation note', 0, 'order.created rule effect not visible within 120 s');
  }
  async function takePaid() {
    if (st.paid.length) return st.paid.shift();
    const d = await takeNew();
    await ok('PATCH', '/api/orders/:id/status', `/api/orders/${d.id}/status`, { status: 'paid', expected_version: String(d.version) });
    return { id: d.id };
  }
  async function paymentCommand() {
    const d = await takeNew(), amount = d.payment.amount_due;
    if (!(amount > 0)) throw new PrepError('payment_receipt', 0, 'nothing due');
    const key = uuid4(r);
    return { cmd: { kind: 'payment_receipt', order_id: d.id, client_key: key, body: { client_key: key, version: Number(d.version), kind: 'receipt', amount, fee: 0, currency: 'PLN',
      method: 'bank_transfer', reference: `LOAD-${d.id.slice(0, 8)}`, note: '', confirmed: true }, expected: { amount_due: 0, net: d.payment.net + amount } }, after: () => st.paid.push({ id: d.id }) };
  }
  async function statusCommand() {
    const o = await takePaid(), d = await order(o.id);
    return { cmd: { order_id: o.id, client_key: uuid4(r), body: { status: 'picking', expected_version: String(d.version) }, expected: { total: d.total } }, after: () => st.picking.push({ id: o.id }) };
  }
  /** picking → (scan every unit) → packed → ship-demo, for an own order; used when the dataset's candidates run out. */
  async function shipOwn() {
    let o = st.picking.shift();
    if (!o) { const p = await takePaid(), d = await order(p.id); await ok('PATCH', '/api/orders/:id/status', `/api/orders/${p.id}/status`, { status: 'picking', expected_version: String(d.version) }); o = p; }
    let d = await order(o.id);
    const scan = (body) => ok('POST', '/api/orders/:id/scan', `/api/orders/${o.id}/scan`, ctx.wms ? { ...body, client_key: uuid4(r) } : body);
    // One scan per reserved unit of each allocation. Lot tenants: the FIFO layers of /api/wms-lots/orders/:id/allocations
    // (the order detail's locations carry no layer, and a location may hold several layers → 422 without layer_id).
    if (ctx.wms) {
      const sku = new Map((d.picking_items ?? d.items).map((i) => [i.product_id, i.sku]));
      const rows = (await ok('GET', '/api/wms-lots/orders/:id/allocations', `/api/wms-lots/orders/${o.id}/allocations`)).data;
      for (const al of rows.filter((x) => x.state === 'active')) for (let u = 0; u < Number(al.quantity) - Number(al.scanned); u++)
        await scan({ code: sku.get(al.product_id), location: al.location, layer_id: al.layer_id });
    } else for (const it of d.picking_items ?? d.items) {
      const locs = it.locations?.length ? it.locations : [{ quantity: it.quantity, scanned: it.scanned ?? 0 }];
      for (const loc of locs) for (let u = 0; u < Number(loc.quantity) - Number(loc.scanned ?? 0); u++)
        await scan({ code: it.sku, ...(loc.location ? { location: loc.location } : {}), ...(loc.layer_id ? { layer_id: loc.layer_id } : {}) });
    }
    d = await order(o.id);
    await ok('PATCH', '/api/orders/:id/status', `/api/orders/${o.id}/status`, { status: 'packed', expected_version: String(d.version) });
    await ok('POST', '/api/orders/:id/ship-demo', `/api/orders/${o.id}/ship-demo`, {});
    return o.id;
  }

  // ---- documents --------------------------------------------------------------------------------------------------
  const hasInvoice = (d) => (d.documents ?? []).some((x) => x.kind === 'invoice') || d.invoice_committed === true;
  async function invoiceCommand() {
    if (!st.invoiceCandidates) await invoiceCandidatesLoad();
    let d;
    for (;;) {
      const id = st.invoiceCandidates.shift() ?? await shipOwn();
      d = await order(id);
      if (['shipped', 'delivered'].includes(d.status) && !hasInvoice(d) && !(d.returns?.cases?.length)) break;
    }
    // 230 preview (own FV-S sub-series), issued by the measured native /issue alias of tax-issue. Not the 157 preview: its
    // sealed budget (local_invoice_budget, 157:137) refuses a company's 2001st local invoice for life.
    const a = d.address ?? {};
    const pv = await ok('POST', '/api/invoice230/orders/:id/previews', `/api/invoice230/orders/${d.id}/previews`, { client_key: uuid4(r), series_id: ctx.series_id,
      order_version: String(d.version), shipping_vat: 23, sell_date: new Date(now()).toISOString().slice(0, 10),
      buyer: { kind: 'consumer', name: d.customer_name, address: { street: a.street || 'Testowa 1', postal_code: a.postal_code || '60-001', city: a.city || 'Poznań', country: 'PL' } } }, [201]);
    const p = pv.preview, key = uuid4(r);
    return { cmd: { kind: 'invoice230_issue', order_id: d.id, preview_id: p.id, client_key: key, body: { client_key: key, scope_hash: p.scope_hash, confirmed: true, local_only: true },
      expected: { gross_minor: String(p.snapshot.totals.gross_minor) } } };
  }

  // ---- WMS stock operations (A, C, E) --------------------------------------------------------------------------------
  async function policy() { if (!st.policy) st.policy = (await ok('GET', '/api/wms-lots', '/api/wms-lots')).policy; return st.policy; }
  async function stockVersion(warehouse, product) {
    const j = await ok('GET', '/api/inventory', `/api/inventory?warehouse_id=${warehouse}&product_id=${product}`);
    return j.data?.[0]?.version != null ? String(j.data[0].version) : '0';
  }
  const positionsOf = async (product) =>
    (await ok('GET', '/api/wms-lots/positions', `/api/wms-lots/positions?warehouse_id=${ctx.main}&product_id=${product}`)).data;
  // A lot position of a product from the catalogue window (the whole catalogue over time, like order_create), read
  // fresh just before the preview. The first pages of /positions are the lowest product ids only.
  async function position(minAvailable, hot = false) {
    const ids = hot ? ctx.hot : (await products()).filter((p) => Number(p.available) >= Math.max(1, minAvailable)).map((p) => p.id);
    for (let tries = 0; tries < 6 && ids.length; tries++) {
      const rows = (await positionsOf(pickOf(r, ids))).filter((x) => Number(x.available) >= minAvailable);
      if (rows.length) return pickOf(r, rows);
    }
    throw new PrepError('stock_operation', 0, `no lot position with available stock${hot ? ' (hot SKUs)' : ''}`);
  }
  async function previewRows(id) {
    const out = []; let cursor = null;
    for (let i = 0; i < 4; i++) { const j = await ok('GET', '/api/wms-lots/movement-previews/:id/rows', `/api/wms-lots/movement-previews/${id}/rows${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`); out.push(...j.data); cursor = j.meta?.cursor; if (!cursor) break; }
    return out;
  }
  // Half of stock_operation (every other command) on the frozen hot SKUs: competing clients read and write the same
  // stock rows, so the version races of EXPECTED_RACES are exercised deliberately (profile http.mix stock_operation).
  async function stockCommand() {
    const k = counter('stock'), hot = (ctx.hot?.length ?? 0) > 0 && k % 2 === 1;
    const out = ctx.wms ? await wmsStockCommand(k, hot) : await manualOffCommand(k, hot);
    return { ...out, hot };
  }
  // B/D (no WMS lots): manual OFF PW/RW correction of a simple product's default bin: source (revision) → preview
  // (unmeasured), apply (measured). +1 and −1 alternate; −1 only with available stock in the bin.
  async function manualOffCommand(k, hot) {
    const ids = hot ? ctx.hot : (await products()).filter((p) => p.kind === 'simple' && Number(p.available) >= 2).map((p) => p.id);
    if (!ids.length) throw new PrepError('stock_operation', 0, 'no simple product with available stock for manual OFF');
    const product = pickOf(r, ids);
    // The preview refuses (409) when the frame changed since the source read (an order reserved the product meanwhile);
    // the source is read once more, a single unmeasured retry of the preparation, never of the measured apply.
    let src, location, delta, pv;
    for (let attempt = 0; ; attempt++) {
      src = (await ok('GET', '/api/inventory/manual-corrections/source', `/api/inventory/manual-corrections/source?product_id=${product}&warehouse_id=${ctx.main}`)).source;
      location = src.stock.default_location; const bin = (src.bins ?? []).find((b) => b.location === location);
      delta = Math.floor(k / 2) % 2 === 0 && Number(src.stock.available) >= 1 && Number(bin?.available ?? 0) >= 1 ? -1 : 1;
      try {
        pv = (await ok('POST', '/api/inventory/manual-corrections/previews', '/api/inventory/manual-corrections/previews', { client_key: uuid4(r), revision: src.revision,
          product_id: product, warehouse_id: ctx.main, location, delta, note: 'Korekta testu obciążenia' }, [201])).preview;
        break;
      } catch (e) { if (attempt > 0 || !(e instanceof PrepError && e.status === 409)) throw e; }
    }
    const key = uuid4(r);
    return { cmd: { kind: 'manual_off', client_key: key, preview_id: pv.id, body: { client_key: key, scope_hash: pv.scope_hash, confirmed: true },
      expected: { product_id: product, warehouse_id: ctx.main, location, delta } },
      noEffect: async () => (await ok('GET', '/api/inventory/manual-corrections/previews/:id', `/api/inventory/manual-corrections/previews/${pv.id}`)).preview?.receipt_id === null };
  }
  async function wmsStockCommand(k, hot) {
    const pol = await policy(), variant = k % 3;
    if (variant === 2 && ctx.spare) {
      const p = await position(2, hot);
      if (!st.spareLocation) st.spareLocation = (await ok('GET', '/api/wms-lots/positions', `/api/wms-lots/positions?warehouse_id=${ctx.spare}`)).data[0]?.location ?? p.location;
      const pv = await ok('POST', '/api/wms-lots/movement-previews', '/api/wms-lots/movement-previews', { client_key: uuid4(r), policy_version: String(pol.version), kind: 'transfer',
        product_id: p.product_id, warehouse_id: ctx.main, location: p.location, destination_warehouse_id: ctx.spare, destination_location: st.spareLocation, quantity: 1,
        stock_versions: [{ warehouse_id: ctx.main, product_id: p.product_id, version: String(p.stock_version) }, { warehouse_id: ctx.spare, product_id: p.product_id, version: await stockVersion(ctx.spare, p.product_id) }],
        layer_ids: [p.layer_id], note: 'Przesunięcie testu obciążenia' }, [201]);
      if (!pv.preview.ready) throw new PrepError('wms_transfer preview', 0, JSON.stringify(pv.preview.issues).slice(0, 200));
      const key = uuid4(r);
      return { cmd: { kind: 'wms_transfer', client_key: key, preview_id: pv.preview.id, body: { client_key: key, scope_hash: pv.preview.scope_hash, confirmed: true },
        expected: { product_id: p.product_id, warehouse_id: ctx.main, destination_warehouse_id: ctx.spare, destination_location: st.spareLocation, policy_version: String(pv.preview.policy_version),
          quantity: 1, fragments: transferFragments(await previewRows(pv.preview.id)) } },
        noEffect: noEffect({ kind: 'wms_transfer', product_id: p.product_id, layer_id: p.layer_id, location: p.location, quantity: -1, before: Number(p.quantity) }) };
    }
    const negative = variant === 1, p = await position(negative ? 2 : 0, hot);
    const body = { client_key: uuid4(r), policy_version: String(pol.version), kind: 'adjustment', product_id: p.product_id, warehouse_id: ctx.main, location: p.location,
      quantity: negative ? -1 : 1, stock_versions: [{ warehouse_id: ctx.main, product_id: p.product_id, version: String(p.stock_version) }], note: 'Korekta testu obciążenia' };
    if (negative) body.layer_ids = [p.layer_id]; else Object.assign(body, { unit_cost_minor: '1000', currency: pol.currency, lot_code: `LOAD-${uuid4(r).slice(0, 8)}` });
    const pv = await ok('POST', '/api/inventory/adjust/previews', '/api/inventory/adjust/previews', body, [201]);
    if (!pv.preview.ready) throw new PrepError('wms_adjustment preview', 0, JSON.stringify(pv.preview.issues).slice(0, 200));
    const key = uuid4(r), expected = { product_id: p.product_id, warehouse_id: ctx.main, policy_version: String(pv.preview.policy_version), signed_delta: body.quantity };
    if (negative) expected.fragments = negativeFragments(await previewRows(pv.preview.id));
    return { cmd: { client_key: key, body: { protocol: 'wms_adjustment090', preview_id: pv.preview.id, client_key: key, scope_hash: pv.preview.scope_hash, confirmed: true }, expected },
      noEffect: noEffect(negative ? { kind: 'wms_adjustment', product_id: p.product_id, layer_id: p.layer_id, location: p.location, quantity: -1, before: Number(p.quantity) }
        : { kind: 'wms_adjustment', product_id: p.product_id, lot_code: body.lot_code, quantity: 1 }) };
  }

  /**
   * Readback after a refused (409) command: true = no effect confirmed, false = the effect is visible, null = cannot
   * tell (the layer moved for another reason). Unmeasured; recorded with the preparation calls.
   */
  function noEffect(spec) {
    if (spec.kind === 'return_receive') return async () => {
      const c = ((await order(spec.order_id)).returns?.cases ?? []).find((x) => x.id === spec.return_id);
      // unreceived: still 'requested' at the version the receive command carried, receipt_sequence 0 (column default)
      return c ? c.state === 'requested' && !(Number(c.receipt_sequence) > 0) && Number(c.version) === Number(spec.version) : null;
    };
    return async () => {
      const rows = await positionsOf(spec.product_id);
      if (spec.lot_code) return !rows.some((x) => x.lot_code === spec.lot_code);
      const row = rows.find((x) => x.layer_id === spec.layer_id && x.location === spec.location);
      return row && Number(row.quantity) === spec.before ? true : null;
    };
  }

  // ---- returns -------------------------------------------------------------------------------------------------------
  async function returnCommand() {
    if (!st.returnCandidates) await invoiceCandidatesLoad();
    let d, line;
    for (let guard = 0; ; guard++) {
      if (guard > 40) throw new PrepError('return_receive', 0, 'no returnable line');
      const id = st.returnCandidates[0] ?? (st.shipped.length ? st.shipped[0] : await shipOwn().then((x) => (st.shipped.push(x), x)));
      d = await order(id);
      const items = new Map(d.items.map((i) => [i.id, i]));
      line = (d.returns?.items ?? []).find((x) => x.available > 0 && (items.get(x.id)?.components ?? []).length <= 1);
      if (line) { line.order_item = items.get(line.id); break; }
      if (st.returnCandidates[0] === id) st.returnCandidates.shift(); else st.shipped.shift();
    }
    const seq = Math.max(0, ...(d.returns.cases ?? []).map((c) => Number(c.receipt_sequence ?? 0))) + 1;
    const rc = await ok('POST', '/api/orders/:id/returns', `/api/orders/${d.id}/returns`, { client_key: uuid4(r), reason: 'Zwrot w teście obciążenia', items: [{ item_id: line.id, quantity: 1 }] }, [201]);
    const key = uuid4(r), body = { version: Number(rc.version), shipping_refund: 0, note: 'Przyjęto zwrot w teście obciążenia', items: [{ item_id: line.id, accepted: 1, restocked: 1 }] };
    if (ctx.wms) {
      const pol = await policy(), product = line.order_item.product_id;
      const frags = (await ok('GET', '/api/wms-lots/orders/:id/return-fragments', `/api/wms-lots/orders/${d.id}/return-fragments`)).data;
      body.wms_lots = { client_key: key, policy_version: String(pol.version), stock_versions: [{ warehouse_id: rc.warehouse_id, product_id: product, version: await stockVersion(rc.warehouse_id, product) }],
        picks: returnPicks(frags, product, 1) };
    }
    return { cmd: { return_id: rc.id, order_id: d.id, client_key: key, body, expected: { refund_amount: lineRefund(line.line_total, line.quantity, Number(line.returned ?? 0), 1), receipt_sequence: seq } },
      noEffect: noEffect({ kind: 'return_receive', order_id: d.id, return_id: rc.id, version: rc.version }) };
  }
  // Dataset shipped orders of this client: a third for invoices (those already invoiced are skipped on read), the rest for returns.
  async function invoiceCandidatesLoad() {
    const rows = mine(await pages('/api/orders', '/api/orders?status=shipped&limit=200', 5));
    st.invoiceCandidates = rows.filter((_, i) => i % 3 === 0).map((o) => o.id); st.returnCandidates = rows.filter((_, i) => i % 3 !== 0).map((o) => o.id);
  }

  /** → { cmd, after?, noEffect? } for the bindings, or throws PrepError / NotBindable. */
  return Object.assign(prepare, { noEffect });
  async function prepare(operation) {
    switch (operation) {
      case 'order_list': return { cmd: await orderList() };
      case 'catalog_search': return { cmd: await catalogSearch() };
      case 'order_detail': return { cmd: await orderDetail() };
      case 'order_create': return orderCreate();
      case 'reserve_and_status': return statusCommand();
      case 'payment_or_document': return counter('pay') % 2 ? paymentCommand() : invoiceCommand();
      case 'stock_operation': return stockCommand();
      case 'return_receive': return returnCommand();
      default: throw new Error('unknown operation ' + operation);
    }
  }
}
