/** 243 UI (Dokumenty → "Faktury zakupowe (KSeF)"): amount and filter helpers, the list decoder refusing a reply with
 * a file or a foreign shape, the viewer seeing no write button, the operator's "Pobierz teraz", filters sent as the
 * query, the detail with the KOR chain and the workflow PATCH carrying the version. jsdom with a controlled fetch. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import './nbp227-ui-dom';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { PurchaseInvoicesPanel, amountPl, filterQuery, readPurchaseList } from '../web/ksef243';
const { JSDOM } = createRequire(import.meta.url)('jsdom');

const ID = '00000000-0000-4000-8000-000000000001', ORIG = '00000000-0000-4000-8000-000000000002', NIP = '1234563218';
const item = (o: Record<string, unknown> = {}) => ({ id: ID, buyer_nip: NIP, ksef_number: '5260250995-20261020-0123456789AB-07', seller_nip: '5260250995', seller_name: 'Hurtownia Testowa sp. z o.o.',
  invoice_number: 'FZ/7/10/2026', fa3_kind: 'KOR', issue_date: '2026-10-20', currency: 'PLN', net_total: '-100050', vat_total: '-23012', gross_total: '-123062', split_payment: true, reverse_charge: false,
  payment_due_date: '2026-11-03', status: 'new', status_label: 'Nowa', accounting_ref: null, version: 3, legal_hold: false, retain_until: '2032-12-31', corrected: false, ...o });
const status = (o: Record<string, unknown> = {}) => ({ read_only: false, can_configure: false, can_fetch: false, can_reopen: false, configs: [{ nip: NIP, environment: 'local_fake', active: true }],
  syncs: [{ nip: NIP, enabled: true, date_type: 'PermanentStorage', start_from: '2026-10-01T00:00:00.000Z', completed_up_to: '2026-10-27T10:00:00.000Z', window_open: false, running: false,
    last_run_at: '2026-10-27T10:00:00.000Z', last_ok_at: '2026-10-27T10:00:00.000Z', last_error: null, rate_limited_until: null, invoices: 1, new_invoices: 1, open_rejects: 0, next_run_at: null, events: [] }], ...o });
const detail = { ...item(), note: null, sale_date: '2026-10-19', correction_reason: 'Rabat posprzedażowy', xml_bytes: 2000, invoice_hash: 'x'.repeat(43) + '=', permanent_storage_date: '2026-10-20T10:00:00.000Z',
  rates: [{ rate_code: '23', net: '-100050', vat: '-23012', vat_pln: null }],
  corrects: [{ ordinal: 1, ref_invoice_number: 'FZ/1/10/2026', ref_issue_date: '2026-10-01', ref_ksef_number: null, problem: null, invoice_id: ORIG, ksef_number: '5260250995-20261001-AAAAAAAAAAAA-00' }], corrected_by: [] };

async function mount(element: any, routes: (path: string, init: any) => unknown) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' }), old = new Map<string, PropertyDescriptor | undefined>(), calls: { url: string; init: any }[] = [];
  const fetch = async (url: string, init: any) => { calls.push({ url, init }); const v = routes(url, init ?? {}) as any;
    return new Response(JSON.stringify(v?.http ? v.body : v), { status: v?.http ?? 200, headers: { 'content-type': 'application/json' } }); };
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, fetch, IS_REACT_ACT_ENVIRONMENT: true })) {
    old.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  const root = createRoot(dom.window.document.getElementById('root'));
  const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
  await act(async () => { root.render(element); }); await settle();
  const button = (label: string) => [...dom.window.document.querySelectorAll('button')].find((x: any) => x.textContent === label) as any;
  return { dom, calls, button, settle, text: () => dom.window.document.body.textContent as string,
    click: async (label: string) => { const b = button(label); assert(b, label); await act(async () => { b.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); }); await settle(); },
    close: async () => { await act(async () => root.unmount()); dom.window.close(); for (const [n, d] of old) { if (d) Object.defineProperty(globalThis, n, d); else Reflect.deleteProperty(globalThis, n); } } };
}

test('helpers: Polish amounts with sign, the filter query without empty values, a list reply with a file is refused', () => {
  assert.equal(amountPl('-123062', 'PLN'), '-1 230,62 PLN');
  assert.equal(amountPl('5'), '0,05');
  assert.equal(amountPl('123456789'), '1 234 567,89');
  assert.equal(filterQuery({ nip: '', seller: ' Hurt ', status: 'new', kind: '', from: '2026-10-01', to: '', q: '' }, { before: '2026-10-20~' + ID }), `?seller=Hurt&status=new&from=2026-10-01&before=2026-10-20%7E${ID}`);
  assert.equal(readPurchaseList({ items: [item()], next: null }).items.length, 1);
  assert.throws(() => readPurchaseList({ items: [{ ...item(), xml: '<Faktura/>' }], next: null }), /Niepełna lista/);
  assert.throws(() => readPurchaseList({ items: [item({ ksef_number: 'zły' })], next: null }), /Niepełna lista/);
});

test('viewer: list, badges and detail with the KOR chain; no fetch, package or workflow button', async () => {
  const m = await mount(createElement(PurchaseInvoicesPanel, { readOnly: false }), url => {
    if (url === '/api/ksef243/status') return status();
    if (url === '/api/ksef243/rejects') return { items: [] };
    if (url.startsWith('/api/ksef243/invoices?') || url === '/api/ksef243/invoices') return { items: [item()], next: null };
    if (url === '/api/ksef243/invoices/' + ID) return detail;
    return { http: 404, body: { detail: 'x' } };
  });
  assert.match(m.text(), /Faktury zakupowe \(KSeF\)/); assert.match(m.text(), /-1 230,62 PLN/); assert.match(m.text(), /KOR/); assert.match(m.text(), /MPP/);
  for (const label of ['Pobierz teraz', 'Pobierz paczkę (CSV + XML)']) assert.equal(m.button(label), undefined, label);
  await m.click('FZ/7/10/2026');
  assert.match(m.text(), /Koryguje:FZ\/1\/10\/2026 z 01\.10\.2026/); assert.match(m.text(), /Rabat posprzedażowy/);
  assert.ok(m.button('Pobierz XML'));
  for (const label of ['Zaakceptuj', 'Oznacz jako zaksięgowaną', 'Pomiń']) assert.equal(m.button(label), undefined, label);
  await m.close();
});

test('operator: "Pobierz teraz" runs the fetch, filters go to the query, "Zaakceptuj" sends the version', async () => {
  let patched: any = null, ran = 0;
  const m = await mount(createElement(PurchaseInvoicesPanel, { readOnly: false }), (url, init) => {
    if (url === '/api/ksef243/status') return status({ can_fetch: true });
    if (url === '/api/ksef243/rejects') return { items: [] };
    if (url === `/api/ksef243/sync/${NIP}/run`) { ran++; return { outcome: 'ok', stored: 4, rejected: 1, message: null, done: true }; }
    if (url.startsWith('/api/ksef243/invoices?') || url === '/api/ksef243/invoices') return { items: [item()], next: null };
    if (url === '/api/ksef243/invoices/' + ID && init.method === 'PATCH') { patched = JSON.parse(init.body); return { ...detail, status: 'accepted', status_label: 'Zaakceptowana', version: 4 }; }
    if (url === '/api/ksef243/invoices/' + ID) return detail;
    return { http: 404, body: { detail: 'x' } };
  });
  await m.click('Pobierz teraz');
  assert.equal(ran, 1); assert.match(m.text(), /Pobrano 4 nowych faktur, odrzucono 1\./);
  const seller = m.dom.window.document.querySelector('.ksef-purchase-filters input') as any;
  await act(async () => { const set = Object.getOwnPropertyDescriptor(m.dom.window.HTMLInputElement.prototype, 'value')!.set!; set.call(seller, 'Hurtownia'); seller.dispatchEvent(new m.dom.window.Event('input', { bubbles: true })); });
  await m.click('Szukaj');
  assert.ok(m.calls.some(c => c.url === '/api/ksef243/invoices?seller=Hurtownia'), m.calls.map(c => c.url).join(' '));
  await m.click('FZ/7/10/2026');
  await m.click('Zaakceptuj');
  assert.deepEqual(patched, { version: 3, status: 'accepted' });
  assert.match(m.text(), /Zaakceptowana/);
  await m.close();
});
