/** 228 UI: the customer card section (non-admin note, preview with kept fields and dates,
 * confirmation only after the checkbox, the 409 reason) and the RODO page (register with
 * actor, due list). jsdom with a controlled fetch; no HTTP or DB. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import './nbp227-ui-dom';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { RodoCustomerPanel, RodoPage, readPreview, summarise, fieldLabel, tableLabel } from '../web/rodo228';
const { JSDOM } = createRequire(import.meta.url)('jsdom');

const T = '00000000-0000-4000-8000-000000000001', C = '00000000-0000-4000-8000-000000000002', R = '00000000-0000-4000-8000-000000000003', O = '00000000-0000-4000-8000-000000000004';
const keep = (table: string, fields: string[], basis = 'tax_retention', end = '2031-12-31', due = '2032-01-01') => ({ table, row: O, order_id: O, fields, basis, legal_basis: basis === 'tax_retention' ? 'art. 112 ustawy o VAT' : 'art. 118 KC',
  retention_end: end, due_on: due, reason: basis === 'tax_retention' ? 'Dokument podatkowy w okresie przechowywania' : 'Niezmienny zapis' });
const preview = { request_id: R, state: 'previewed', plan_sha256: 'a'.repeat(64), plan: { today: '2026-10-23', crm_client_ids: [C], orders: [{ id: O, number: 'DE-20261012-C57FFB69', tax_retention_end: '2031-12-31' }],
  anonymise: [{ table: 'orders', row: O, order_id: O, fields: ['email', 'address.phone', 'note'] }, { table: 'crm_clients', row: C, fields: ['profile.email'] }],
  keep: [keep('orders', ['customer_name', 'address.street']), keep('documents', ['data (nabywca, adres, e-mail)']), keep('documents', ['data (nabywca, adres, e-mail)']), keep('shopify_dispatch_evidence', ['receiver'], 'immutable_evidence', '2032-12-31', '2033-01-01')] } };

async function mount(element: any, routes: (path: string, init: any) => unknown) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' }), old = new Map<string, PropertyDescriptor | undefined>(), calls: { url: string; init: any }[] = [];
  const fetch = async (url: string, init: any) => { calls.push({ url, init }); const v = routes(url, init) as any;
    return new Response(JSON.stringify(v?.status ? v.body : v), { status: v?.status ?? 200, headers: { 'content-type': 'application/json' } }); };
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, fetch, IS_REACT_ACT_ENVIRONMENT: true })) {
    old.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  const root = createRoot(dom.window.document.getElementById('root'));
  const settle = async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
  await act(async () => { root.render(element); }); await settle();
  const button = (label: string) => [...dom.window.document.querySelectorAll('button')].find((x: any) => x.textContent === label) as any;
  return { dom, calls, button, text: () => dom.window.document.body.textContent as string,
    click: async (label: string) => { const b = button(label); assert(b, label); await act(async () => { b.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); }); await settle(); },
    check: async () => { const i = dom.window.document.querySelector('input[type=checkbox]'); await act(async () => { i.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); }); await settle(); },
    close: async () => { await act(async () => root.unmount()); dom.window.close(); for (const [n, d] of old) { if (d) Object.defineProperty(globalThis, n, d); else Reflect.deleteProperty(globalThis, n); } } };
}

test('helpers: preview decoder, grouping and field names', () => {
  assert.equal(readPreview(preview).request_id, R);
  assert.throws(() => readPreview({ ...preview, plan_sha256: 'x' }), /Niepełny podgląd/);
  assert.throws(() => readPreview({ ...preview, plan: { ...preview.plan, keep: [{ ...preview.plan.keep[0], due_on: '1.1.2032' }] } }), /Niepełny podgląd/);
  assert.deepEqual(summarise(preview.plan.keep as any).map(g => g.count), [1, 2, 1]);
  assert.equal(fieldLabel('address.phone'), 'telefon'); assert.equal(fieldLabel('profile.invoice_tax_id'), 'profil: invoice tax id');
  // 231: FV-S invoices (230) and the KSeF file are named in Polish in the preview.
  assert.deepEqual(['invoice230_documents', 'invoice230_previews', 'ksef229_submissions'].map(tableLabel), ['Faktura FV-S (B2B, EUR, ZW/NP/OO/OSS)', 'Podgląd faktury FV-S', 'Plik faktury wysłany do KSeF']);
  assert.deepEqual(['buyer_tax_id', 'snapshot.buyer', 'xml', 'upo_xml'].map(fieldLabel), ['NIP / numer VAT UE nabywcy', 'dane nabywcy', 'plik FA(3)', 'UPO']);
});
test('customer card: non-admin sees only the note, no request', async () => {
  const m = await mount(createElement(RodoCustomerPanel, { subject: { crm_client_id: C }, tenantId: T, admin: false, readOnly: false }), () => { throw Error('no call'); });
  assert.match(m.text(), /dostępne dla administratora/); assert.equal(m.calls.length, 0); assert.equal(m.button('Przygotuj anonimizację'), undefined);
  await m.close();
});
test('customer card: preview lists what is anonymised and kept with dates; confirm only after the checkbox', async () => {
  let changed = 0;
  const m = await mount(createElement(RodoCustomerPanel, { subject: { crm_client_id: C }, tenantId: T, admin: true, readOnly: false, onChanged: () => changed++ }), (url, init) => {
    if (url === '/api/rodo228/anonymisation/preview') { assert.deepEqual(JSON.parse(init.body), { crm_client_id: C }); return preview; }
    if (url === `/api/rodo228/anonymisation/${R}/confirm`) { assert.deepEqual(JSON.parse(init.body), { plan_sha256: 'a'.repeat(64) }); return { request_id: R, state: 'completed', replayed: false, result: { anonymised: 2, kept: 4 } }; }
    throw Error(url);
  });
  await m.click('Przygotuj anonimizację');
  const t = m.text();
  assert.match(t, /Zostanie zanonimizowane/); assert.match(t, /Zamówienie1e-mail, telefon, uwagi/); assert.match(t, /Profil klienta CRM1profil: email/);
  assert.match(t, /Zostanie zachowane/); assert.match(t, /Faktura lub korekta/); assert.match(t, /Przepisy podatkowe/); assert.match(t, /31\.12\.2031/); assert.match(t, /01\.01\.2032/);
  assert.match(t, /Zapis dowodowy/); assert.match(t, /01\.01\.2033/); assert.match(t, /Faktura lub korekta DE-20261012-C57FFB69 \(2 zapisy\)/);
  assert.match(t, /przechowywane do 31\.12\.2031 · anonimizacja od 01\.01\.2032/); assert.match(t, /Dowód wysyłki Shopify DE-20261012-C57FFB69: odbiorca/);
  assert.equal(m.button('Zanonimizuj dane klienta').disabled, true);
  await m.check();
  assert.equal(m.button('Zanonimizuj dane klienta').disabled, false);
  await m.click('Zanonimizuj dane klienta');
  assert.match(m.text(), /Dane klienta zanonimizowano\. Zmienione zapisy: 2\. Zachowane do terminu: 4/);
  assert.equal(changed, 1);
  assert.deepEqual(m.calls.map(c => c.url), ['/api/rodo228/anonymisation/preview', `/api/rodo228/anonymisation/${R}/confirm`]);
  await m.close();
});
test('customer card: 409 shows the Polish reason; a read-only copy disables the actions', async () => {
  const reason = 'Nie można zanonimizować danych klienta — otwarte zamówienia: DE-1 (nowe). Zakończ te sprawy i spróbuj ponownie.';
  const m = await mount(createElement(RodoCustomerPanel, { subject: { email: 'a@example.com' }, tenantId: T, admin: true, readOnly: false }), () => ({ status: 409, body: { detail: reason } }));
  await m.click('Przygotuj anonimizację');
  assert.equal(m.dom.window.document.querySelector('[role=alert]').textContent, reason);
  await m.close();
  const ro = await mount(createElement(RodoCustomerPanel, { subject: { email: 'a@example.com' }, tenantId: T, admin: true, readOnly: true }), () => { throw Error('no call'); });
  assert.equal(ro.button('Przygotuj anonimizację').disabled, true); assert.equal(ro.button('Pobierz dane klienta (JSON + CSV)').disabled, true);
  await ro.close();
});
test('RODO page: register rows with actor and key, then the due list', async () => {
  const m = await mount(createElement(RodoPage, { tenantId: T, admin: true, readOnly: false }), url => {
    if (url.startsWith('/api/rodo228/access-log')) return { data: [{ id: 'r1', accessed_at: '2026-10-23T10:00:00.000Z', actor: 'Anna Admin', actor_id: C, api_key: 'Sklep (dyna_api_1234…)', channel: 'api', action: 'read',
      purpose: 'Integracja — odczyt klienta przez Base API (connector.php)', resource: 'connector.php getCrmClientData', crm_client_id: C, order_count: 1 }], next: null };
    if (url === '/api/rodo228/retained?due=1') return { today: '2033-01-02', data: [{ request_id: R, item_no: 1, source_table: 'orders', row_ref: O, order_number: 'DE-1', fields: ['customer_name'], basis: 'tax_retention',
      retention_end: '2031-12-31', due_on: '2032-01-01', overdue: true }] };
    throw Error(url);
  });
  assert.match(m.text(), /Anna Admin/); assert.match(m.text(), /klucz Sklep/); assert.match(m.text(), /Odczyt/); assert.match(m.text(), /API/);
  await m.click('Do anonimizacji po terminie');
  assert.match(m.text(), /01\.01\.2032 — po terminie/); assert.match(m.text(), /DE-1/);
  await m.close();
});
