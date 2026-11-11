/** Pliki JPK panel: non-admin notice, V7M download (query, workspace header, file name),
 * 409 list of refused documents, client validation without a request, FA address,
 * a broken localStorage. jsdom with a controlled fetch; no HTTP or DB. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import './nbp227-ui-dom';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { JpkFilesPanel, jpkQuery, monthRange, previousMonth, validateJpk } from '../web/jpk-files';
const { JSDOM } = createRequire(import.meta.url)('jsdom');

type Reply = { status?: number; body: string; headers?: Record<string, string> };
const xml = (root = 'JPK') => `<?xml version="1.0" encoding="UTF-8"?><${root} xmlns="http://crd.gov.pl/wzor/2021/12/27/11148/"><Naglowek/></${root}>`;
const ok = (name: string, rows?: string): Reply => ({ body: xml(), headers: { 'content-type': 'application/xml; charset=utf-8', 'content-disposition': `attachment; filename="${name}"`, ...(rows ? { 'x-jpk-wiersze': rows } : {}) } });
const json = (status: number, body: unknown): Reply => ({ status, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

async function mount(props: { contextKey: string; admin: boolean }, route: (url: string) => Reply, opts: { brokenStorage?: boolean; storage?: Record<string, string> } = {}) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' }), old = new Map<string, PropertyDescriptor | undefined>();
  const calls: { url: string; headers: Record<string, string>; credentials: string }[] = [], downloads: string[] = [];
  for (const [k, v] of Object.entries(opts.storage ?? {})) dom.window.localStorage.setItem(k, v);
  if (opts.brokenStorage) Object.defineProperty(dom.window, 'localStorage', { configurable: true, get() { throw new dom.window.DOMException('blocked', 'SecurityError'); } });
  dom.window.HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) { downloads.push(this.download); };
  const fetch = async (url: string, init: any) => { calls.push({ url, headers: init?.headers ?? {}, credentials: init?.credentials }); const r = route(url);
    return new Response(r.body, { status: r.status ?? 200, headers: r.headers }); };
  const URLStub = Object.assign(class extends URL {}, { createObjectURL: () => 'blob:jpk', revokeObjectURL: () => {} });
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, DOMParser: dom.window.DOMParser,
    URL: URLStub, fetch, IS_REACT_ACT_ENVIRONMENT: true })) {
    old.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  const root = createRoot(dom.window.document.getElementById('root'));
  await act(async () => { root.render(createElement(JpkFilesPanel, props)); });
  const field = (label: string) => [...dom.window.document.querySelectorAll('label')].find((l: any) => l.textContent.startsWith(label))!.querySelector('input,select');
  return { dom, calls, downloads, field, text: () => dom.window.document.body.textContent as string, alert: () => dom.window.document.querySelector('[role="alert"]')?.textContent ?? '',
    buttons: () => [...dom.window.document.querySelectorAll('button')].map((b: any) => b.textContent as string),
    set: async (label: string, value: string) => { const input = field(label); const proto = input.tagName === 'SELECT' ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype;
      await act(async () => { Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); input.dispatchEvent(new dom.window.Event('change', { bubbles: true })); }); },
    click: async (label: string) => { const b = [...dom.window.document.querySelectorAll('button')].find((x: any) => x.textContent === label)!; await act(async () => { b.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); await new Promise(r => setTimeout(r, 0)); }); await act(async () => { await new Promise(r => setTimeout(r, 0)); }); },
    close: async () => { await act(async () => root.unmount()); dom.window.close(); for (const [n, d] of old) { if (d) Object.defineProperty(globalThis, n, d); else Reflect.deleteProperty(globalThis, n); } } };
}

const taxpayer = { kod_urzedu: '1471', email: 'ksiegowosc@example.pl', telefon: '', nip: '', nazwa: '', cel: '1' as const, osoba: 'niefizyczna' as const, imie: '', nazwisko: '', data_urodzenia: '', nadwyzka: '' };
const address = { wojewodztwo: 'mazowieckie', powiat: 'Warszawa', gmina: 'Warszawa', ulica: '', nr_domu: '1', nr_lokalu: '', miejscowosc: 'Warszawa', kod_pocztowy: '00-001' };

test('defaults, validation and query helpers', () => {
  assert.equal(previousMonth(new Date(2026, 0, 15)), '2025-12');
  assert.equal(previousMonth(new Date(2026, 9, 23)), '2026-09');
  assert.deepEqual(monthRange('2026-02'), { od: '2026-02-01', do: '2026-02-28' });
  assert.deepEqual(monthRange('2024-02'), { od: '2024-02-01', do: '2024-02-29' });
  const p = { okres: '2026-09', od: '2026-09-01', do: '2026-09-30' };
  assert.equal(validateJpk('v7m', taxpayer, address, p), '');
  assert.match(validateJpk('v7m', { ...taxpayer, kod_urzedu: '147' }, address, p), /4 cyfry/);
  assert.match(validateJpk('v7k', { ...taxpayer, email: '' }, address, p), /e-mail/);
  assert.match(validateJpk('v7m', { ...taxpayer, email: 'zly@' }, address, p), /poprawny adres e-mail/);
  assert.equal(validateJpk('fa', { ...taxpayer, email: '' }, address, p), '', 'FA does not need an e-mail');
  assert.match(validateJpk('v7m', { ...taxpayer, osoba: 'fizyczna' }, address, p), /imię/);
  assert.match(validateJpk('v7m', { ...taxpayer, osoba: 'fizyczna', imie: 'Jan', nazwisko: 'Kowalski' }, address, p), /datę urodzenia/);
  assert.match(validateJpk('v7m', { ...taxpayer, nadwyzka: '12,50' }, address, p), /Nadwyżka/);
  assert.match(validateJpk('fa', taxpayer, { ...address, kod_pocztowy: '00001' }, p), /NN-NNN/);
  assert.match(validateJpk('fa', taxpayer, address, { ...p, od: '2026-10-01' }), /„Od” nie może/);
  assert.equal(jpkQuery('v7m', { ...taxpayer, nadwyzka: '120' }, address, p), 'okres=2026-09&kod_urzedu=1471&email=ksiegowosc%40example.pl&cel=1&osoba=niefizyczna&nadwyzka=120');
  assert.equal(jpkQuery('fa', { ...taxpayer, nadwyzka: '120' }, address, p),
    'od=2026-09-01&do=2026-09-30&kod_urzedu=1471&cel=1&osoba=niefizyczna&wojewodztwo=mazowieckie&powiat=Warszawa&gmina=Warszawa&nr_domu=1&miejscowosc=Warszawa&kod_pocztowy=00-001');
});

test('a non-admin sees only the notice, without the form or buttons', async () => {
  const p = await mount({ contextKey: 'T1:U1:operator:false', admin: false }, () => { throw Error('no request expected'); });
  try {
    assert(p.text().includes('Pliki JPK są dostępne dla administratora finansów.'));
    assert.deepEqual(p.buttons(), []);
    assert.equal(p.dom.window.document.querySelectorAll('input').length, 0);
    assert.equal(p.calls.length, 0);
  } finally { await p.close(); }
});

test('admin downloads JPK_V7M with the workspace header and the server file name', async () => {
  const p = await mount({ contextKey: 'T1:U1:admin:false', admin: true }, () => ok('JPK_V7M-2026-09.xml', '12'));
  try {
    assert.deepEqual(p.buttons(), ['Pobierz JPK_V7M', 'Pobierz JPK_V7K', 'Pobierz JPK_FA']);
    assert.equal((p.field('Miesiąc') as any).value, previousMonth());
    assert.deepEqual({ od: (p.field('Od') as any).value, do: (p.field('Do') as any).value }, monthRange(previousMonth()));
    await p.set('Miesiąc', '2026-09');
    assert.equal((p.field('Do') as any).value, '2026-09-30', 'changing the month resets the range');
    await p.set('Kod urzędu skarbowego', '1471'); await p.set('E-mail', 'ksiegowosc@example.pl');
    await p.click('Pobierz JPK_V7M');
    assert.equal(p.calls.length, 1);
    assert.equal(p.calls[0]!.url, '/api/jpk/v7m.xml?okres=2026-09&kod_urzedu=1471&email=ksiegowosc%40example.pl&cel=1&osoba=niefizyczna');
    assert.equal(p.calls[0]!.headers['X-Workspace-ID'], 'T1');
    assert.equal(p.calls[0]!.credentials, 'same-origin');
    assert.deepEqual(p.downloads, ['JPK_V7M-2026-09.xml']);
    assert(p.text().includes('Pobrano plik JPK_V7M-2026-09.xml (12 wierszy).'), p.text());
    assert.equal(p.alert(), '');
    const saved = JSON.parse(p.dom.window.localStorage.getItem('dyna.jpk.T1:U1:admin:false'));
    assert.equal(saved.taxpayer.kod_urzedu, '1471'); assert.equal(saved.okres, undefined, 'dates are not remembered');
  } finally { await p.close(); }
});

test('remembered taxpayer and address fields come back for the same context only; foreign values are ignored', async () => {
  const storage = { 'dyna.jpk.T2:U1:admin:false': JSON.stringify({ taxpayer: { kod_urzedu: '0202', email: 'a@b.pl', osoba: 'obca', cel: 7 }, address: { gmina: 'Kraków' } }) };
  const p = await mount({ contextKey: 'T2:U1:admin:false', admin: true }, () => ok('x.xml'), { storage });
  try {
    assert.equal((p.field('Kod urzędu skarbowego') as any).value, '0202');
    assert.equal((p.field('Rodzaj podatnika') as any).value, 'niefizyczna');
    assert.equal((p.field('Cel złożenia') as any).value, '1');
    assert.equal((p.field('Gmina') as any).value, 'Kraków');
  } finally { await p.close(); }
  const other = await mount({ contextKey: 'T3:U1:admin:false', admin: true }, () => ok('x.xml'), { storage });
  try { assert.equal((other.field('Kod urzędu skarbowego') as any).value, ''); } finally { await other.close(); }
});

test('409 shows the detail and the list of refused documents', async () => {
  const p = await mount({ contextKey: 'T1:U1:admin:false', admin: true }, () => json(409, { detail: 'Nie da się przygotować JPK_V7M za 2026-09.',
    documents: [{ number: 'FV/1/09/2026', reason: 'brak NIP sprzedawcy' }, { number: 'KOR/2/09/2026', reason: 'korekta bez faktury pierwotnej' }] }));
  try {
    await p.set('Kod urzędu skarbowego', '1471'); await p.set('E-mail', 'ksiegowosc@example.pl');
    await p.click('Pobierz JPK_V7M');
    const alert = p.alert();
    assert(alert.includes('Nie da się przygotować JPK_V7M za 2026-09.'), alert);
    assert(alert.includes('Dokumenty, których nie da się ująć w pliku:'));
    const items = [...p.dom.window.document.querySelectorAll('[role="alert"] li')].map((li: any) => li.textContent);
    assert.deepEqual(items, ['FV/1/09/2026 — brak NIP sprzedawcy', 'KOR/2/09/2026 — korekta bez faktury pierwotnej']);
    assert.deepEqual(p.downloads, []);
  } finally { await p.close(); }
});

test('422 shows the server detail; a non-JPK body is not saved', async () => {
  let reply: Reply = json(422, { detail: 'Kod urzędu skarbowego 9999 nie istnieje.' });
  const p = await mount({ contextKey: 'T1:U1:admin:false', admin: true }, () => reply);
  try {
    await p.set('Kod urzędu skarbowego', '9999'); await p.set('E-mail', 'ksiegowosc@example.pl');
    await p.click('Pobierz JPK_V7K');
    assert.equal(p.alert(), 'Kod urzędu skarbowego 9999 nie istnieje.');
    reply = { ...ok('JPK_V7K.xml'), body: xml('Faktura') };
    await p.click('Pobierz JPK_V7K');
    assert.match(p.alert(), /nie jest poprawnym JPK/);
    reply = { ...ok('JPK_V7K.xml'), body: '<!DOCTYPE JPK [<!ENTITY x "y">]><JPK>&x;</JPK>' };
    await p.click('Pobierz JPK_V7K');
    assert.match(p.alert(), /nie jest poprawnym JPK/);
    assert.deepEqual(p.downloads, []);
  } finally { await p.close(); }
});

test('client validation blocks a bad kod urzędu without a request', async () => {
  const p = await mount({ contextKey: 'T1:U1:admin:false', admin: true }, () => ok('x.xml'));
  try {
    await p.set('Kod urzędu skarbowego', '14a1'); await p.set('E-mail', 'ksiegowosc@example.pl');
    await p.click('Pobierz JPK_V7M');
    assert.match(p.alert(), /4 cyfry/);
    assert.equal(p.calls.length, 0);
  } finally { await p.close(); }
});

test('JPK_FA requires the address, then sends the range and the address', async () => {
  const p = await mount({ contextKey: 'T1:U1:admin:false', admin: true }, () => ok('JPK_FA-2026-09-01_2026-09-30.xml', '1'));
  try {
    await p.set('Miesiąc', '2026-09'); await p.set('Kod urzędu skarbowego', '1471');
    await p.click('Pobierz JPK_FA');
    assert.match(p.alert(), /wymaga adresu podatnika/);
    assert.equal(p.calls.length, 0);
    for (const [label, value] of [['Województwo', 'mazowieckie'], ['Powiat', 'Warszawa'], ['Gmina', 'Warszawa'], ['Nr domu', '1'], ['Miejscowość', 'Warszawa'], ['Kod pocztowy', '00-001']]) await p.set(label!, value!);
    await p.click('Pobierz JPK_FA');
    assert.equal(p.calls.length, 1);
    assert.equal(p.calls[0]!.url, '/api/jpk/fa.xml?od=2026-09-01&do=2026-09-30&kod_urzedu=1471&cel=1&osoba=niefizyczna&wojewodztwo=mazowieckie&powiat=Warszawa&gmina=Warszawa&nr_domu=1&miejscowosc=Warszawa&kod_pocztowy=00-001');
    assert.deepEqual(p.downloads, ['JPK_FA-2026-09-01_2026-09-30.xml']);
    assert(p.text().includes('Pobrano plik JPK_FA-2026-09-01_2026-09-30.xml (1 wiersz).'), p.text());
  } finally { await p.close(); }
});

test('the panel renders and downloads when localStorage throws', async () => {
  const p = await mount({ contextKey: 'T1:U1:admin:false', admin: true }, () => ok('JPK_V7M-2026-09.xml'), { brokenStorage: true });
  try {
    assert.deepEqual(p.buttons(), ['Pobierz JPK_V7M', 'Pobierz JPK_V7K', 'Pobierz JPK_FA']);
    await p.set('Kod urzędu skarbowego', '1471'); await p.set('E-mail', 'ksiegowosc@example.pl');
    await p.click('Pobierz JPK_V7M');
    assert(p.text().includes('Pobrano plik JPK_V7M-2026-09.xml.'), p.text());
  } finally { await p.close(); }
});
