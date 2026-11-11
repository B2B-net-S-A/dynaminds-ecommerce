/** 229 UI: Ustawienia → KSeF (masked secret, the PUT body leaves out an empty secret, the
 * connection check), the KSeF section of an invoice (number and UPO, offline badge with deadline
 * and QR codes, send refusal shown inline, no buttons for a viewer) and "Kolejka KSeF" (overdue,
 * retry one, send all). jsdom with a controlled fetch; no HTTP or DB. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import './nbp227-ui-dom';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { KsefDocumentStatus, KsefQueuePanel, KsefSettingsPanel, configBody, readKsefDocument } from '../web/ksef229';
const { JSDOM } = createRequire(import.meta.url)('jsdom');

const D = '00000000-0000-4000-8000-000000000001', S = '00000000-0000-4000-8000-000000000002', W = '00000000-0000-4000-8000-000000000009', NIP = '5260250274';
const NUMBER = '5260250274-20261023-0123456789AB-3F', SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h1v1H0z"/></svg>';
const config = { nip: NIP, environment: 'local_fake', base_url: 'http://127.0.0.1:4239/v2', auth_method: 'token', active: true, secret: { stored: true, masked: '••••••••', fingerprint: '0123456789abcdef' },
  certificate_serial: null, offline_certificate: null, updated_at: '2026-10-23T10:00:00.000Z' };
const sub = (o: Record<string, unknown> = {}) => ({ id: S, document_id: D, document_kind: 'local_invoice', document_number: 'FV/LOK/2026/000042', nip: NIP, environment: 'local_fake', state: 'accepted',
  state_label: 'Przyjęta w KSeF', ksef_number: NUMBER, acquisition_at: '2026-10-23T10:00:00.000Z', reference_number: '20261023-EE-1', status: { code: 200, description: 'Sukces', details: [] },
  xml_sha256: 'a'.repeat(64), upo_available: true, upo_at: '2026-10-23T10:00:01.000Z', attempts: 1, last_error: null, last_attempt_at: null, offline: null, ...o });
const offline = { mode: 'offline', reason: 'KSeF niedostępny przy wysyłce (art. 106nh)', since: '2026-10-23T10:00:00.000Z', deadline: '2026-10-26', overdue: false,
  kod1: { url: 'http://127.0.0.1:4239/qr/invoice/5260250274/23-10-2026/abc', label: 'OFFLINE', svg: SVG }, kod2: null, kod2_note: 'Brak certyfikatu KSeF typu Offline w ustawieniach — KOD II nie został wygenerowany' };

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
    close: async () => { await act(async () => root.unmount()); dom.window.close(); for (const [n, d] of old) { if (d) Object.defineProperty(globalThis, n, d); else Reflect.deleteProperty(globalThis, n); } } };
}

test('helpers: document reply decoder refuses a foreign or inconsistent reply; an empty secret is left out of the PUT body', () => {
  assert.equal(readKsefDocument({ document_id: D, submission: sub(), rejected: [] }, D).submission!.ksef_number, NUMBER);
  assert.throws(() => readKsefDocument({ document_id: S, submission: null, rejected: [] }, D), /Niepełny lub obcy/);
  assert.throws(() => readKsefDocument({ document_id: D, submission: sub({ ksef_number: null }), rejected: [] }, D), /Niepełny lub obcy/);
  assert.throws(() => readKsefDocument({ document_id: D, submission: sub({ ksef_number: 'zły-numer' }), rejected: [] }, D), /Niepełny lub obcy/);
  const base = { nip: NIP, environment: 'local_fake' as const, base_url: ' http://127.0.0.1:4239/v2 ', auth_method: 'token' as const, token: '', certificate_pem: '', private_key_pem: '',
    certificate_serial: '', offline_certificate_pem: '', offline_private_key_pem: '', offline_certificate_serial: '', active: true };
  assert.deepEqual(configBody(base), { environment: 'local_fake', auth_method: 'token', active: true, base_url: 'http://127.0.0.1:4239/v2' });
  assert.equal(configBody({ ...base, token: 'nowy-token-1234' }).token, 'nowy-token-1234');
  assert.equal(configBody({ ...base, environment: 'test' }).base_url, undefined);
});

test('Ustawienia → KSeF: masked secret only, save without retyping the secret, connection check result; non-admin sees a note', async () => {
  let saved: any = null;
  const m = await mount(createElement(KsefSettingsPanel, { admin: true, readOnly: false }), (url, init) => {
    if (url === '/api/ksef229/configs') return { configs: [config] };
    if (url === `/api/ksef229/configs/${NIP}` && init.method === 'PUT') { saved = JSON.parse(init.body); return { config }; }
    if (url === `/api/ksef229/configs/${NIP}/check`) return { ok: true, problem: null, steps: [{ name: 'auth/challenge', ok: true, ms: 3 }, { name: 'auth', ok: true, ms: 9 }] };
    return { status: 404, body: { detail: 'x' } };
  });
  assert.match(m.text(), /••••••••/); assert.match(m.text(), /odcisk 0123456789abcdef/); assert.match(m.text(), /Lokalny serwer testowy/);
  await m.click('Sprawdź połączenie ' + NIP);
  assert.match(m.text(), /Połączenie z KSeF dla NIP 5260250274 działa/); assert.match(m.text(), /auth\/challenge \(3 ms\)/);
  await m.click('Zmień ' + NIP);
  const token = m.dom.window.document.querySelector('input[type=password]');
  assert.match(token.placeholder, /Zapisany/); assert.equal(token.value, '');
  await m.click('Zapisz ustawienia KSeF');
  assert.deepEqual(saved, { environment: 'local_fake', auth_method: 'token', active: true, base_url: 'http://127.0.0.1:4239/v2' }, 'the stored secret is kept, not resent');
  assert.match(m.text(), /Sekret jest zaszyfrowany/);
  await m.close();
  const v = await mount(createElement(KsefSettingsPanel, { admin: false, readOnly: false }), () => { throw Error('no fetch for non-admin'); });
  assert.match(v.text(), /Ustawienia KSeF zmienia administrator/); assert.equal(v.calls.length, 0);
  await v.close();
});

test('invoice: send to KSeF shows the number and UPO; a refusal is shown inline; offline shows badge, deadline and KOD I', async () => {
  let state: any = { document_id: D, submission: null, rejected: [] };
  const m = await mount(createElement(KsefDocumentStatus, { documentId: D, workspaceId: W, role: 'operator', readOnly: false }), (url, init) => {
    if (url === `/api/ksef229/documents/${D}`) return state;
    if (url === `/api/ksef229/documents/${D}/send` && init.method === 'POST') return state.refuse ? { status: 409, body: { detail: 'Brak aktywnych ustawień KSeF dla NIP 5260250274. Dodaj je w Ustawienia → KSeF.' } } : { ...state = { document_id: D, submission: sub(), rejected: [] }, replayed: false };
    if (url === `/api/ksef229/documents/${D}/offline`) return state = { document_id: D, submission: sub({ state: 'queued', state_label: 'Do wysłania', ksef_number: null, status: null, upo_available: false, offline: { ...offline, mode: 'offline24', deadline: '2026-10-26' } }), rejected: [] };
    return { status: 404, body: { detail: 'x' } };
  });
  assert.match(m.text(), /Nie wysłano do KSeF/);
  state.refuse = true; await m.click('Wyślij do KSeF');
  assert.match(m.text(), /Brak aktywnych ustawień KSeF dla NIP 5260250274/);
  state.refuse = false; await m.click('Wyślij do KSeF');
  assert.match(m.text(), /Przyjęta w KSeF/); assert.match(m.text(), new RegExp(NUMBER)); assert(m.button('Pobierz UPO')); assert.match(m.text(), /nie mają mocy prawnej/);
  await m.close();
  state = { document_id: D, submission: null, rejected: [] };
  const o = await mount(createElement(KsefDocumentStatus, { documentId: D, workspaceId: W, role: 'admin', readOnly: false }), (url) => url.endsWith('/offline') ? (state = { document_id: D, submission: sub({ state: 'queued', state_label: 'Do wysłania', ksef_number: null, status: null, upo_available: false, offline }), rejected: [] }) : state);
  await o.click('Tryb offline24');
  assert.match(o.text(), /offline — niedostępność KSeF · wyślij do 26\.10\.2026/); assert.match(o.text(), /KOD II nie został wygenerowany/);
  const img = o.dom.window.document.querySelector('.ksef-qr img');
  assert.equal(img.alt, 'KOD I OFFLINE'); assert(img.src.startsWith('data:image/svg+xml'));
  assert(o.button('Wyślij ponownie do KSeF'), 'an offline invoice is sent later');
  await o.close();
  const v = await mount(createElement(KsefDocumentStatus, { documentId: D, workspaceId: W, role: 'viewer', readOnly: false }), () => ({ document_id: D, submission: null, rejected: [] }));
  assert.equal(v.dom.window.document.querySelectorAll('button').length, 0); await v.close();
});

test('Kolejka KSeF: overdue deadline, retry of one, send all with the summary', async () => {
  const items = [{ id: S, document_id: D, document_number: 'FV/LOK/2026/000042', nip: NIP, state: 'queued', state_label: 'Do wysłania', issue_mode: 'offline', offline_reason: 'KSeF niedostępny', deadline: '2026-10-21',
    overdue: true, attempts: 2, last_error: 'Brak połączenia z KSeF', status: null }];
  const bodies: any[] = [];
  const m = await mount(createElement(KsefQueuePanel, { role: 'admin', readOnly: false }), (url, init) => {
    if (url === '/api/ksef229/queue') return { today: '2026-10-23', items };
    if (url === '/api/ksef229/queue/send') { bodies.push(JSON.parse(init.body)); return { attempted: 1, accepted: 1, results: [{ ok: true, message: null }] }; }
    return { status: 404, body: { detail: 'x' } };
  });
  assert.match(m.text(), /21\.10\.2026 — termin minął/); assert.match(m.text(), /Brak połączenia z KSeF/);
  await m.click('Ponów FV/LOK/2026/000042'); await m.click('Wyślij wszystkie (1)');
  assert.deepEqual(bodies, [{ ids: [S] }, {}]); assert.match(m.text(), /Wysłano 1, przyjęto w KSeF 1/);
  await m.close();
});
