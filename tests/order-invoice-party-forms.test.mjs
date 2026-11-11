/** Uwagi v3 §6 follow-up: the document forms prefill the buyer from the invoice data edited on the order card
 * (section_values.invoice of the card payload) and keep their previous defaults when nothing was edited. */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer } from 'vite';

const id = '11111111-1111-4111-8111-111111111111';
const address = { street: 'Wojska Polskiego 11', city: 'Szczecin', postal_code: '70-470', country: 'PL', phone: '600100200' };
const unedited = { buyer: '', nip: '', street: '', postal_code: '', city: '', country: 'PL', wants_invoice: false };
const order = (invoice = unedited) => ({ id, version: '3', status: 'shipped', currency: 'PLN', customer_name: 'Monika Kozłowska', email: 'm@example.test', address, section_values: { invoice } });
const company = { wants_invoice: true, buyer: 'Firma B sp. z o.o.', nip: '5260250274', street: 'Prosta 20', postal_code: '00-850', city: 'Warszawa', country: 'PL' };

test('FV-S, receipt and local B2C invoice prefill', async (t) => {
  const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', logLevel: 'error' });
  t.after(() => vite.close());
  const fvs = await vite.ssrLoadModule(path.resolve('web/invoice230.tsx'));
  const receipt = await vite.ssrLoadModule(path.resolve('web/receipt233.tsx'));
  const local = await vite.ssrLoadModule(path.resolve('web/local-invoices.tsx'));

  // Nothing edited: the previous defaults (FV-S from the order customer, no NIP, an empty B2C form).
  const plain = fvs.invoice230InitialForm(order());
  assert.deepEqual([plain.type, plain.name, plain.street, plain.taxId], ['consumer', 'Monika Kozłowska', address.street, '']);
  assert.equal(receipt.receipt233InitialNip(order()), '');
  assert.equal(receipt.receipt233InitialNip({ id }), '');
  assert.deepEqual(local.localInvoiceInitialBuyer(order()), { kind: 'consumer', name: '', street: '', postal_code: '', city: '', country: 'PL' });
  assert.equal(local.localInvoiceInitialBuyer(undefined).name, '');

  // A Polish company with a NIP: FV-S as „Firma z Polski”, the NIP on the receipt, no consumer B2C invoice.
  const pl = fvs.invoice230InitialForm(order(company));
  assert.deepEqual([pl.type, pl.name, pl.street, pl.postal_code, pl.city, pl.country, pl.taxId], ['pl', 'Firma B sp. z o.o.', 'Prosta 20', '00-850', 'Warszawa', 'PL', '5260250274']);
  assert.deepEqual(fvs.invoice230FormProblems({ ...pl, seriesId: id }, [{ id, name: 'Główna', prefix: 'FV' }]), []);
  assert.equal(receipt.receipt233InitialNip(order({ ...company, nip: 'PL 526-025-02-74' })), '5260250274');
  assert.equal(local.localInvoiceInitialBuyer(order(company)).name, '');

  // An EU company: FV-S „Firma z UE” with its VAT ID; no Polish NIP on the receipt.
  const eu = fvs.invoice230InitialForm(order({ ...company, nip: 'DE123456789', street: 'Ring 5', postal_code: '20095', city: 'Hamburg', country: 'DE' }));
  assert.deepEqual([eu.type, eu.country, eu.taxId], ['eu', 'DE', 'DE123456789']);
  assert.equal(receipt.receipt233InitialNip(order({ ...company, nip: 'DE123456789', country: 'DE' })), '');

  // A consumer buyer without a NIP: consumer FV-S and a prefilled B2C invoice.
  const person = { ...company, buyer: 'Jan Nowak', nip: '' };
  assert.deepEqual([fvs.invoice230InitialForm(order(person)).type, fvs.invoice230InitialForm(order(person)).name], ['consumer', 'Jan Nowak']);
  assert.deepEqual(local.localInvoiceInitialBuyer(order(person)), { kind: 'consumer', name: 'Jan Nowak', street: 'Prosta 20', postal_code: '00-850', city: 'Warszawa', country: 'PL' });
});
