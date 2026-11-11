/** The 157 panel past the lifetime limit: the FV-S answer readers and the note views (no HTTP or DB). */
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const order = id(1), previewId = id(20), documentId = id(30), hash = 'c'.repeat(64);
const note = 'Limit faktur lokalnych B2C jest wyczerpany (firma ma już 2000 podglądów faktur lokalnych; limit obowiązuje dożywotnio w każdym planie). Ta faktura zostanie wystawiona w podserii FV-S: numer FV-S/FV/2026/…, a nie FV/2026/…. Treść faktury jest taka sama; korekta, KSeF i JPK obsługują ją jak każdą fakturę FV-S.';
const body = { series_id: id(8), order_version: '7', shipping_vat: 23, sell_date: '2026-10-29', buyer: { name: 'Klient Limit', street: 'Długa 5', postal_code: '00-002', city: 'Warszawa', country: 'PL' } };
const line = (no, kind, gross, net) => ({ line_no: no, kind, sku: kind === 'item' ? 'SKU-1' : '', name: kind === 'item' ? 'Produkt' : 'Dostawa', rate: '23', rate_code: '23', category: 'standard',
  gross_minor: gross, net_minor: net, vat_minor: String(BigInt(gross) - BigInt(net)), quantity: 1, unit: kind === 'item' ? 'szt.' : 'usł.', vat_rate: 23 });
const snapshot = () => ({ format: 'invoice230/v1', currency: 'PLN', procedure: 'domestic', reverse_charge: false, exemption: null, nbp: null,
  order: { id: order, number: 'ZAM-7', version: '7', status: 'shipped', currency: 'PLN', total_minor: '13300', shipping_cost_minor: '1000', payment_mode: 'prepaid' },
  seller: { name: 'Sprzedawca', street: 'Rynek 2', postal_code: '30-001', city: 'Kraków', country: 'PL', tax_id: '5260250274' },
  buyer: { kind: 'consumer', name: 'Klient Limit', address: { street: 'Długa 5', postal_code: '00-002', city: 'Warszawa', country: 'PL' }, tax_id: '', tax_id_kind: 'none', pl_vat_payer: false, email: 'k@example.test' },
  series: { id: id(8), name: 'Główna', prefix: 'FV', payment_terms_days: 14, payment_instructions: '', notes: '' },
  lines: [line(1, 'item', '12300', '10000'), line(2, 'shipping', '1000', '813')],
  categories: [{ key: '23', rate_code: '23', rate: '23', fa3_net: 'P_13_1', fa3_vat: 'P_14_1', label: '23%', net_minor: '10813', vat_minor: '2487', gross_minor: '13300' }],
  totals: { net_minor: '10813', vat_minor: '2487', gross_minor: '13300' }, mpp: { required: false, reason: 'Nabywca jest konsumentem', gross_pln_minor: null },
  sell_date: '2026-10-29', issue_date: '2026-10-29', due_date: '2026-11-12', year: 2026 });
const answer = () => ({ available: true, read_only: false, current_role: 'admin', can_read: true, can_write: true, can_create_series: false, reused: false,
  preview: { id: previewId, order_id: order, series_id: id(8), order_version: '7', scope_hash: hash, snapshot: snapshot(), expires_at: '2099-01-01T00:00:00.000Z', created_at: '2026-10-29T10:00:00.000Z' },
  invoice230: true, series: 'FV-S', series_note: note, overflow: { reason: 'previews', limit: 2000 }, issue_path: `/local-invoices/previews/${previewId}/tax-issue` });
const issued = () => ({ invoice230: true, reused: false, series: 'FV-S', series_note: 'Faktura wystawiona w podserii FV-S (numeracja 230): FV-S/FV/2026/000001.',
  document: { id: documentId, order_id: order, number: 'FV-S/FV/2026/000001', kind: 'invoice', mode: 'invoice230', created_at: '2026-10-29T10:01:00.000Z',
    data: { ...snapshot(), number: 'FV-S/FV/2026/000001', preview_id: previewId, scope_hash: hash } } });

test('157 overflow to FV-S: answer readers and views', async t => {
  const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', logLevel: 'error' });
  try {
    const m = await vite.ssrLoadModule(path.resolve('web/local-invoice-overflow.tsx'));
    await t.test('a FV-S answer is recognised only by its invoice230 mark', () => {
      assert.equal(m.isOverflowAnswer(answer()), true);
      assert.equal(m.isOverflowAnswer({ preview: {} }), false);
      assert.equal(m.isOverflowAnswer(null), false);
    });
    await t.test('the preview must be the consumer sale the 157 form sent, with the note and the tax-issue path', () => {
      const o = m.readOverflowPreview(answer(), order, body);
      assert.equal(o.note, note); assert.equal(o.path, `/local-invoices/previews/${previewId}/tax-issue`); assert.equal(o.preview.id, previewId);
      const bad = [v => { v.series_note = ''; }, v => { v.series = 'FV'; }, v => { v.issue_path = '/elsewhere'; }, v => { v.preview.order_id = id(2); },
        v => { v.preview.snapshot.currency = 'EUR'; }, v => { v.preview.snapshot.procedure = 'oss'; }, v => { v.preview.snapshot.buyer.name = 'Inny'; },
        v => { v.preview.snapshot.buyer.address.city = 'Kraków'; }, v => { v.preview.snapshot.order.version = '8'; }, v => { v.preview.snapshot.lines.at(-1).vat_rate = 8; },
        v => { v.preview.snapshot.series.id = id(9); }, v => { v.preview.scope_hash = 'x'; }];
      for (const mutate of bad) { const v = answer(); mutate(v); assert.throws(() => m.readOverflowPreview(v, order, body), /FV-S/); }
    });
    await t.test('the issued document must be the FV-S invoice of that preview', () => {
      const o = m.readOverflowPreview(answer(), order, body), d = m.readOverflowIssue(issued(), o);
      assert.equal(d.document.number, 'FV-S/FV/2026/000001'); assert.match(d.note, /podserii FV-S/);
      for (const mutate of [v => { v.document.mode = 'local_invoice'; }, v => { v.document.number = 'FV/2026/000001'; v.document.data.number = v.document.number; },
        v => { v.document.data.preview_id = id(21); }, v => { v.document.order_id = id(2); }, v => { delete v.series_note; }]) {
        const v = issued(); mutate(v); assert.throws(() => m.readOverflowIssue(v, o), /FV-S/);
      }
    });
    await t.test('the review shows the note, the calculation and an issue button that needs consent', () => {
      const o = m.readOverflowPreview(answer(), order, body);
      const html = renderToStaticMarkup(React.createElement(m.LocalInvoiceOverflowReview, { overflow: o, canWrite: true, busy: false, consent: false, onConsent: () => {}, onIssue: () => {} }));
      assert.match(html, /Podgląd przed wystawieniem — seria FV-S/); assert.match(html, /Limit faktur lokalnych B2C jest wyczerpany/); assert.match(html, /FV-S\/FV\/2026\/…, a nie FV\/2026\/…/);
      assert.match(html, /Do zapłaty 133,00\sPLN/); assert.match(html, /<button[^>]*disabled=""[^>]*>Wystaw fakturę FV-S<\/button>/);
      const ready = renderToStaticMarkup(React.createElement(m.LocalInvoiceOverflowReview, { overflow: o, canWrite: true, busy: false, consent: true, onConsent: () => {}, onIssue: () => {} }));
      assert.doesNotMatch(ready, /disabled=""[^>]*>Wystaw fakturę FV-S/);
      const viewer = renderToStaticMarkup(React.createElement(m.LocalInvoiceOverflowReview, { overflow: o, canWrite: false, busy: false, consent: true, onConsent: () => {}, onIssue: () => {} }));
      assert.match(viewer, /disabled=""[^>]*>Wystaw fakturę FV-S/);
    });
    await t.test('the issued view names the FV-S number, the note and the print of the 230 document', () => {
      const o = m.readOverflowPreview(answer(), order, body);
      const html = renderToStaticMarkup(React.createElement(m.LocalInvoiceOverflowIssued, { issued: m.readOverflowIssue(issued(), o) }));
      assert.match(html, /Faktura FV-S\/FV\/2026\/000001/); assert.match(html, /Faktura wystawiona w podserii FV-S \(numeracja 230\)/);
      assert.match(html, new RegExp(`href="/api/invoice230/documents/${documentId}/print"`)); assert.match(html, /korekta KOR-S/);
    });
  } finally { await vite.close(); }
});
