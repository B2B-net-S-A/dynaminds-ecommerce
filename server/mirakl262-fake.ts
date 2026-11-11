/** Local, stateful stand-in for one Mirakl MMP Seller instance (migration 252, docs/parity/MIRAKL252-20261028.md).
 * SYNTHETIC: request and response shapes are authored from the public Seller API documentation (A01, OR11, OR21,
 * OR23, OR24, OF21, OF24, OF02, OF03), not recorded from an operator. No network; used by tests and by the local
 * simulation (DYNA_MIRAKL_FAKE=local). Mirakl has no public sandbox: each operator runs its own *.mirakl.net. */
import type { Transport } from './integrations';

export const MIRAKL262_FAKE_ORIGIN = 'https://p262-fake.mirakl.net';
export const MIRAKL262_FAKE_SHOP = '2000';
export const MIRAKL262_FAKE_KEY = 'synthetic-mirakl-shop-key';
export type MiraklFakeFailure =
  | { kind: 'hang' }
  | { kind: 'throw' }
  | { kind: 'http'; status: number; body?: unknown; retryAfter?: string }
  // ACK loss: the fake applies the change, then the answer never arrives (or arrives as a bare 500).
  | { kind: 'commit_then_hang' }
  | { kind: 'commit_then_500' };
export type MiraklFakeLine = { order_line_id: string; offer_id: number; offer_sku: string; product_title: string; quantity: number;
  price: number; shipping_price: number; total_price: number; order_line_state: string };
export type MiraklFakeOrder = { order_id: string; order_state: string; last_updated_date: string; lines: MiraklFakeLine[];
  customer_debited_date: string | null; tracking: { carrier_code?: string; carrier_name?: string; carrier_url?: string; tracking_number: string } | null };
export type MiraklFakeOffer = { offer_id: number; shop_sku: string; product_sku: string; product_title: string; price: number; quantity: number; active: boolean };
export type MiraklFakeImport = { import_id: number; status: 'WAITING' | 'RUNNING' | 'COMPLETE' | 'FAILED'; lines_read: number;
  lines_in_success: number; lines_in_error: number; errors: { shop_sku: string; message: string }[]; date_created: string; pending: unknown[] };
export type MiraklFakeOptions = { origin?: string; shopId?: string; apiKey?: string; now?: () => number;
  // Imports finish after this many OF02 reads (Mirakl imports are asynchronous); 0 = complete on creation.
  importReadsUntilComplete?: number };

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const err = (status: number, message: string) => json(status, { status, message: 'SYNTHETIC ' + message });
const money = (n: number) => Math.round(n * 100) / 100;

export function createMiraklFake(opts: MiraklFakeOptions = {}) {
  const origin = opts.origin ?? MIRAKL262_FAKE_ORIGIN;
  const shopId = opts.shopId ?? MIRAKL262_FAKE_SHOP;
  const apiKey = opts.apiKey ?? MIRAKL262_FAKE_KEY;
  const now = opts.now ?? (() => Date.now());
  const readsUntilComplete = opts.importReadsUntilComplete ?? 1;
  const orders = new Map<string, MiraklFakeOrder>();
  const offers = new Map<string, MiraklFakeOffer>();
  const imports = new Map<number, MiraklFakeImport & { reads: number }>();
  const failures: { failure: MiraklFakeFailure; route?: string }[] = [];
  const calls: { method: string; path: string; query: string; body: string | null }[] = [];
  let seq = 0;
  const stamp = () => new Date(now()).toISOString();
  const hang = (signal?: AbortSignal | null) =>
    new Promise<Response>((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted'))));
  const orderView = (o: MiraklFakeOrder) => {
    const price = money(o.lines.reduce((s, l) => s + l.price, 0)), ship = money(o.lines.reduce((s, l) => s + l.shipping_price, 0));
    const hidden = o.order_state === 'WAITING_ACCEPTANCE';
    return {
      order_id: o.order_id, currency_iso_code: 'PLN', order_state: o.order_state, last_updated_date: o.last_updated_date,
      order_tax_mode: 'TAX_INCLUDED',
      // Mirakl hides the buyer until the order is accepted and debited.
      customer: hidden ? { firstname: 'Jan', lastname: 'Testowy' } : { firstname: 'Jan', lastname: 'Testowy', shipping_address: {
        firstname: 'Jan', lastname: 'Testowy', street_1: 'Testowa 1', city: 'Warszawa', zip_code: '00-001', country_iso_code: 'POL' } },
      ...(hidden ? {} : { customer_notification_email: 'buyer-' + o.order_id.toLowerCase() + '@example.test' }),
      customer_debited_date: o.customer_debited_date, customer_directly_pays_seller: false, payment_workflow: 'PAY_ON_ACCEPTANCE',
      payment_type: 'SYNTHETIC', fully_refunded: false, has_incident: false, price, shipping_price: ship, total_price: money(price + ship),
      order_lines: o.lines.map(l => ({ ...l, cancelations: [], refunds: [], fees: [] })),
      shipping_tracking: o.tracking?.tracking_number ?? null, shipping_carrier_code: o.tracking?.carrier_code ?? null,
    };
  };
  const offerView = (o: MiraklFakeOffer) => ({ ...o, currency_iso_code: 'PLN', state_code: '11' });
  const touch = (o: MiraklFakeOrder) => { o.last_updated_date = stamp(); };
  function handle(method: string, u: URL, body: string): Response {
    const q = u.searchParams, path = u.pathname;
    if (q.get('shop_id') !== shopId) return err(403, 'Shop not accessible with this key');
    let m: RegExpMatchArray | null;
    if (method === 'GET' && path === '/api/account')
      return json(200, { shop_id: Number(shopId), shop_name: 'Sklep testowy Mirakl (SYMULACJA)', currency_iso_code: 'PLN', shop_state: 'OPEN', model: 'MARKETPLACE' });
    if (method === 'GET' && path === '/api/orders') {
      let list = [...orders.values()];
      const ids = q.get('order_ids');
      if (ids !== null) list = list.filter(o => ids.split(',').includes(o.order_id));
      else {
        const start = Date.parse(q.get('start_update_date') ?? ''), end = Date.parse(q.get('end_update_date') ?? '');
        list = list.filter(o => Date.parse(o.last_updated_date) >= start && Date.parse(o.last_updated_date) <= end);
      }
      const offset = Number(q.get('offset') ?? 0), max = Number(q.get('max') ?? 10);
      return json(200, { orders: list.slice(offset, offset + max).map(orderView), total_count: list.length });
    }
    if (method === 'GET' && path === '/api/offers') {
      const sku = q.get('sku');
      const list = [...offers.values()].filter(o => sku === null || o.shop_sku === sku);
      const offset = Number(q.get('offset') ?? 0), max = Number(q.get('max') ?? 10);
      return json(200, { offers: list.slice(offset, offset + max).map(offerView), total_count: list.length });
    }
    if (method === 'POST' && path === '/api/offers') {
      let req: any;
      try { req = JSON.parse(body); } catch { return err(400, 'Invalid JSON'); }
      if (!Array.isArray(req?.offers) || req.offers.length === 0) return err(400, 'offers required');
      const id = 9000 + ++seq;
      imports.set(id, { import_id: id, status: readsUntilComplete ? 'WAITING' : 'COMPLETE', lines_read: req.offers.length, lines_in_success: 0,
        lines_in_error: 0, errors: [], date_created: stamp(), pending: req.offers, reads: 0 });
      if (!readsUntilComplete) apply(imports.get(id)!);
      return json(201, { import_id: id });
    }
    if (method === 'GET' && (m = path.match(/^\/api\/offers\/imports\/(\d+)$/))) {
      const i = imports.get(Number(m[1]));
      if (!i) return err(404, 'Import not found');
      if (i.status !== 'COMPLETE' && ++i.reads >= readsUntilComplete) apply(i);
      else if (i.status === 'WAITING') i.status = 'RUNNING';
      const { pending: _p, reads: _r, errors: _e, ...view } = i;
      return json(200, { ...view, has_error_report: i.lines_in_error > 0 });
    }
    if (method === 'GET' && (m = path.match(/^\/api\/offers\/imports\/(\d+)\/error_report$/))) {
      const i = imports.get(Number(m[1]));
      if (!i || i.status !== 'COMPLETE' || !i.lines_in_error) return err(404, 'No error report');
      const csv = '"shop-sku";"error-message"\n' + i.errors.map(e => `"${e.shop_sku}";"${e.message}"`).join('\n') + '\n';
      return new Response(csv, { status: 200, headers: { 'Content-Type': 'text/csv; charset=UTF-8' } });
    }
    if (method === 'PUT' && (m = path.match(/^\/api\/orders\/([^/]+)\/(accept|tracking|ship)$/))) {
      const o = orders.get(decodeURIComponent(m[1]));
      if (!o) return err(404, 'Order not found');
      let req: any = {};
      if (m[2] !== 'ship') { try { req = JSON.parse(body); } catch { return err(400, 'Invalid JSON'); } }
      if (m[2] === 'accept') {
        if (o.order_state !== 'WAITING_ACCEPTANCE') return err(400, 'Order is not waiting for acceptance');
        const lines = Array.isArray(req.order_lines) ? req.order_lines : [];
        if (lines.length !== o.lines.length || !o.lines.every(l => lines.some((x: any) => x?.id === l.order_line_id && typeof x.accepted === 'boolean')))
          return err(400, 'Every order line must be accepted or refused');
        const accepted = lines.every((x: any) => x.accepted);
        for (const l of o.lines) l.order_line_state = accepted ? 'SHIPPING' : 'REFUSED';
        o.order_state = accepted ? 'SHIPPING' : 'REFUSED';
        if (accepted) o.customer_debited_date = stamp();
        touch(o);
        return new Response(null, { status: 204 });
      }
      if (m[2] === 'tracking') {
        if (!['SHIPPING', 'SHIPPED'].includes(o.order_state)) return err(400, 'Tracking can be set on SHIPPING or SHIPPED orders');
        if (typeof req.tracking_number !== 'string' || !req.tracking_number) return err(400, 'tracking_number required');
        o.tracking = { carrier_code: req.carrier_code, carrier_name: req.carrier_name, carrier_url: req.carrier_url, tracking_number: req.tracking_number };
        touch(o);
        return new Response(null, { status: 204 });
      }
      if (o.order_state !== 'SHIPPING') return err(400, 'Order is not in SHIPPING state');
      o.order_state = 'SHIPPED';
      for (const l of o.lines) l.order_line_state = 'SHIPPED';
      touch(o);
      return new Response(null, { status: 204 });
    }
    return err(404, 'Not found');
  }
  function apply(i: MiraklFakeImport & { reads: number }) {
    i.status = 'COMPLETE';
    for (const raw of i.pending as any[]) {
      const offer = offers.get(raw?.shop_sku);
      if (!offer) { i.errors.push({ shop_sku: String(raw?.shop_sku), message: 'The offer does not exist; product reference required to create it' }); continue; }
      if (typeof raw.price !== 'number' || raw.price < 0 || !Number.isInteger(raw.quantity) || raw.quantity < 0) {
        i.errors.push({ shop_sku: offer.shop_sku, message: 'Invalid price or quantity' }); continue;
      }
      offer.price = raw.price; offer.quantity = raw.quantity;
      i.lines_in_success++;
    }
    i.lines_in_error = i.errors.length;
    i.pending = [];
  }
  const transport: Transport = async (url, init) => {
    const u = new URL(url);
    if (u.origin !== origin) throw new Error('SYNTHETIC fake: foreign host ' + u.host);
    const method = String(init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    const body = typeof init.body === 'string' ? init.body : null;
    calls.push({ method, path: u.pathname, query: u.search, body });
    const at = failures.findIndex(f => !f.route || `${method} ${u.pathname}`.startsWith(f.route));
    const failure = at >= 0 ? failures.splice(at, 1)[0].failure : null;
    if (failure?.kind === 'throw') throw new TypeError('fetch failed');
    if (failure?.kind === 'hang') return hang(init.signal);
    if (failure?.kind === 'http')
      return json(failure.status, failure.body ?? { message: 'SYNTHETIC' }, failure.retryAfter ? { 'Retry-After': failure.retryAfter } : {});
    // Mirakl Seller API: the raw shop key in Authorization (no Bearer prefix).
    const res = headers.get('authorization') !== apiKey ? err(401, 'Unauthorized') : handle(method, u, body ?? '');
    if (failure?.kind === 'commit_then_hang') return hang(init.signal);
    if (failure?.kind === 'commit_then_500') return new Response('', { status: 500 });
    return res;
  };
  return {
    origin, shopId, apiKey, transport, orders, offers, imports, calls,
    fail(failure: MiraklFakeFailure, route?: string) { failures.push({ failure, route }); },
    /** An order the operator created; WAITING_ACCEPTANCE until OR21, SHIPPING once debited. */
    addOrder(input: { order_id: string; state?: 'WAITING_ACCEPTANCE' | 'SHIPPING'; lines: { sku: string; quantity: number; price: number; title?: string }[] }) {
      const state = input.state ?? 'SHIPPING';
      const o: MiraklFakeOrder = { order_id: input.order_id, order_state: state, last_updated_date: stamp(),
        customer_debited_date: state === 'SHIPPING' ? stamp() : null, tracking: null,
        lines: input.lines.map((l, n) => ({ order_line_id: input.order_id + '-' + (n + 1), offer_id: offers.get(l.sku)?.offer_id ?? 3000 + ++seq,
          offer_sku: l.sku, product_title: l.title ?? 'Produkt ' + l.sku, quantity: l.quantity, price: money(l.price * l.quantity), shipping_price: 0,
          total_price: money(l.price * l.quantity), order_line_state: state })) };
      orders.set(o.order_id, o);
      return o;
    },
    addOffer(input: { shop_sku: string; price: number; quantity: number; title?: string }) {
      const o: MiraklFakeOffer = { offer_id: 3000 + ++seq, shop_sku: input.shop_sku, product_sku: 'MP-' + input.shop_sku,
        product_title: input.title ?? 'Oferta ' + input.shop_sku, price: input.price, quantity: input.quantity, active: true };
      offers.set(o.shop_sku, o);
      return o;
    },
  };
}
export type MiraklFake = ReturnType<typeof createMiraklFake>;
