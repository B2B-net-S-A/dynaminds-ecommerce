/** 227 UI: decoders, the NBP line of an invoice detail (EUR record, PLN note) and the
 * Kursy NBP panel (rates, rate for a tax point with the PLN VAT line, refusal, roles).
 * jsdom with a controlled fetch; no HTTP or DB. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import './nbp227-ui-dom';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { LocalInvoiceDocumentNbp, NbpRatesPanel, amountMinor, readDocumentNbp, readNbpRates } from '../web/nbp227-rates';
const { JSDOM } = createRequire(import.meta.url)('jsdom');

const doc = '00000000-0000-4000-8000-000000000030';
const record = { currency: 'EUR', tax_point: '2026-10-23', tax_point_basis: 'sell_date', rate_date: '2026-10-22', table_no: '206/A/NBP/2026', mid: '4.3685', rate_source: 'fetched',
  net_minor: '10000', vat_minor: '2300', gross_minor: '12300', net_pln_minor: '43685', vat_pln_minor: '10048', gross_pln_minor: '53733', captured_with_issue: true, captured_at: '2026-10-23T10:00:00.000Z',
  vat: [], line: 'Kurs NBP z dnia 22.10.2026, tabela 206/A/NBP/2026, 1 EUR = 4,3685 PLN; VAT w PLN: 100,48 zł' };
const eur = { document_id: doc, currency: 'EUR', nbp: record, note: null };
const pln = { document_id: doc, currency: 'PLN', nbp: null, note: 'Faktura w PLN — przeliczenie kursem NBP nie dotyczy.' };
const rate = (d: string, no: string, mid: string, through: string, source = 'fetched') => ({ currency: 'EUR', effective_date: d, table_no: no, mid, covered_through: through, source, fetched_at: '2026-10-23T09:00:00.000Z' });
const list = (extra = {}) => ({ currency: 'EUR', read_only: false, can_fetch: false, can_manual: true, today: '2026-10-23', rates: [rate('2026-10-22', '206/A/NBP/2026', '4.3685', '2026-10-22'), rate('2026-10-16', '202/A/NBP/2026', '4.3661', '2026-10-18', 'manual')], ...extra });

async function mount(element: any, routes: (path: string, init: any) => unknown) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' }), old = new Map<string, PropertyDescriptor | undefined>(), calls: string[] = [];
  const fetch = async (url: string, init: any) => { calls.push(init?.method && init.method !== 'GET' ? init.method + ' ' + url : url); const v = routes(url, init) as any;
    return new Response(JSON.stringify(v?.status ? v.body : v), { status: v?.status ?? 200, headers: { 'content-type': 'application/json' } }); };
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, fetch, IS_REACT_ACT_ENVIRONMENT: true })) {
    old.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  const root = createRoot(dom.window.document.getElementById('root'));
  await act(async () => { root.render(element); });
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
  const q = (s: string) => dom.window.document.querySelector(s);
  return { dom, calls, q, text: () => dom.window.document.body.textContent as string,
    set: async (label: string, value: string) => { const input = [...dom.window.document.querySelectorAll('label')].find((l: any) => l.textContent.startsWith(label))!.querySelector('input');
      await act(async () => { const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!; setter.call(input, value); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); input.dispatchEvent(new dom.window.Event('change', { bubbles: true })); }); },
    click: async (label: string) => { const b = [...dom.window.document.querySelectorAll('button')].find((x: any) => x.textContent === label)!; await act(async () => { b.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); await new Promise(r => setTimeout(r, 0)); }); await act(async () => { await new Promise(r => setTimeout(r, 0)); }); },
    close: async () => { await act(async () => root.unmount()); dom.window.close(); for (const [n, d] of old) { if (d) Object.defineProperty(globalThis, n, d); else Reflect.deleteProperty(globalThis, n); } } };
}

test('decoders accept the record and the PLN note; foreign or inconsistent replies refuse', () => {
  assert.equal(readDocumentNbp(eur, doc).nbp!.line, record.line);
  assert.deepEqual(readDocumentNbp(pln, doc), { currency: 'PLN', nbp: null, note: pln.note });
  for (const bad of [{ ...eur, document_id: '00000000-0000-4000-8000-000000000031' }, { ...eur, currency: 'PLN' }, { ...eur, nbp: { ...record, rate_date: '2026-10-23' } },
    { ...eur, nbp: { ...record, table_no: '206/A/NBP/2025' } }, { ...eur, nbp: { ...record, mid: 4.3685 } }, { ...eur, nbp: { ...record, line: 'Kurs z dnia 23.10.2026' } }, { ...pln, note: '' }])
    assert.throws(() => readDocumentNbp(bad, doc), /kursu NBP faktury/, JSON.stringify(bad).slice(0, 80));
  assert.equal(readNbpRates(list()).rates.length, 2);
  assert.throws(() => readNbpRates(list({ rates: [rate('2026-10-22', '206/A/NBP/2026', '4.36', '2026-10-22')] })), /obca lista/);
  assert.equal(amountMinor('23,00'), '2300'); assert.equal(amountMinor('1 234,5'), '123450'); assert.equal(amountMinor('0.07'), '7');
  for (const bad of ['', '-1', '1,234', 'abc']) assert.throws(() => amountMinor(bad), /kwotę VAT/);
});

test('invoice detail shows the NBP line for a foreign-currency record and the note for PLN', async () => {
  const a = await mount(createElement(LocalInvoiceDocumentNbp, { documentId: doc }), () => eur);
  try { assert.deepEqual(a.calls, [`/api/local-invoices/documents/${doc}/nbp`]); assert(a.text().includes(record.line)); assert(a.text().includes('Data obowiązku podatkowego 23.10.2026 (data sprzedaży)')); } finally { await a.close(); }
  const b = await mount(createElement(LocalInvoiceDocumentNbp, { documentId: doc }), () => pln);
  try { assert(b.text().includes('Faktura w PLN — przeliczenie kursem NBP nie dotyczy.')); assert(!b.text().includes('Kurs NBP z dnia')); } finally { await b.close(); }
  const c = await mount(createElement(LocalInvoiceDocumentNbp, { documentId: doc }), () => ({ status: 503, body: { detail: 'Kursy NBP (migracja 227) są niedostępne w tej kopii' } }));
  try { assert(c.text().includes('Kursy NBP niedostępne')); } finally { await c.close(); }
});

test('Kursy NBP panel lists rates, shows the line for a tax point, the refusal without a rate, and the manual form only for an admin', async () => {
  const choice = { currency: 'EUR', tax_point: '2026-10-23', rate: list().rates[0], refusal: null, vat_pln_minor: '10048', line: record.line };
  const p = await mount(createElement(NbpRatesPanel, { contextKey: 'T:U:admin:false', readOnly: false }), (url) => url.startsWith('/api/nbp227/rate-for') ? (url.includes('2026-10-23') ? choice
    : { ...choice, tax_point: '2026-10-09', rate: null, refusal: 'Brak kursu NBP (tabela A, EUR) sprzed daty obowiązku podatkowego 09.10.2026.', line: null }) : list());
  try {
    assert(p.text().includes('206/A/NBP/2026') && p.text().includes('4,3685 PLN') && p.text().includes('ręcznie'));
    assert(p.text().includes('Kurs ręczny') && !p.text().includes('Pobierz z NBP'), 'no fetch button without the NBP reader');
    await p.set('Data obowiązku podatkowego', '2026-10-23'); await p.set('VAT w EUR', '23,00'); await p.click('Sprawdź kurs');
    assert(p.calls.includes('/api/nbp227/rate-for?currency=EUR&tax_point=2026-10-23&vat_minor=2300'), p.calls.join());
    assert(p.text().includes(record.line));
    await p.set('Data obowiązku podatkowego', '2026-10-09'); await p.click('Sprawdź kurs');
    assert(p.q('[role="alert"]')!.textContent!.includes('Brak kursu NBP'));
  } finally { await p.close(); }
  const op = await mount(createElement(NbpRatesPanel, { contextKey: 'T:U:operator:false', readOnly: false }), () => list({ can_manual: false, can_fetch: true }));
  try { assert(!op.text().includes('Zapisz kurs ręczny')); assert(op.text().includes('Pobierz z NBP')); } finally { await op.close(); }
});
