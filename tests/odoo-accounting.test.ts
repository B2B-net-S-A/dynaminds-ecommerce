import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  OdooAccounting,
  accountingPayload,
  erpMinor,
  verifyOdooInvoice,
} from '../server/odoo-accounting';
import { exportSource, odooExportInput } from '../server/odoo-exports';
import { accountingFixture, odooSettings, odooCredentials } from './odoo-accounting-fixture';
const input = () => ({
  client_key: randomUUID(),
  channel_id: randomUUID(),
  partner_id: 1,
  journal_id: 1,
  account_id: 1,
  invoice_date: '2026-10-04',
  due_date: '2026-10-10',
  shipping_vat: 23 as const,
  taxes: [{ vat: 23 as const, tax_id: 24 }],
});
const doc = () => ({
  id: randomUUID(),
  number: 'DEMO-FV/QA',
  kind: 'invoice',
  mode: 'demo',
  created_at: '2026-10-04T12:00:00Z',
  data: {
    seller: 'QA',
    customer: 'Klient QA',
    email: 'invoice@example.test',
    address: { street: 'Testowa 1', city: 'Warszawa', postal_code: '00-001', country: 'PL' },
    currency: 'PLN',
    total: 23500,
    shipping_cost: 1499,
    items: [{ name: 'Discounted item', quantity: 2, gross: 22001, vat: 23 }],
  },
});
test('Odoo accounting handles discounted gross and both ERP tax price bases without stock/payment methods', async () => {
  for (const include of [true, false]) {
    const f = accountingFixture();
    f.models['account.tax'][0].price_include = include;
    const c = new OdooAccounting(odooSettings, odooCredentials, f.transport),
      x = input(),
      s = exportSource(doc(), x);
    const metadata = await c.metadata(s, x),
      p = { id: randomUUID(), input: x, reference: 'DYNA-QA', snapshot: { source: s, metadata } };
    const id = await c.create(accountingPayload(p.reference, s, x, metadata));
    verifyOdooInvoice(p, await c.invoice(id));
    await c.post(id);
    assert.equal(verifyOdooInvoice(p, await c.invoice(id), true).total, 23500);
    assert.equal(f.calls.filter((c) => c.method === 'create').length, 1);
    assert.equal(f.calls.filter((c) => c.method === 'action_post').length, 1);
    assert(!f.calls.some((c) => /payment|stock.move|send/.test(c.model)));
  }
});
test('Odoo accounting rejects foreign scope, buyer, grouped/cash VAT, global rounding and currency', async () => {
  const cases = [
    ['account.account', 'company_ids', [2]],
    ['account.journal', 'company_id', [2, 'Other']],
    ['res.partner', 'email', 'wrong@example.test'],
    ['account.tax', 'children_tax_ids', [2]],
    ['account.tax', 'tax_exigibility', 'on_payment'],
    ['account.tax', 'amount', 8],
    ['res.company', 'tax_calculation_rounding_method', 'round_globally'],
    ['res.currency', 'name', 'EUR'],
  ];
  for (const [m, k, v] of cases) {
    const f = accountingFixture();
    f.models[String(m)][0][String(k)] = v;
    const x = input();
    await assert.rejects(() =>
      new OdooAccounting(odooSettings, odooCredentials, f.transport).metadata(
        exportSource(doc(), x),
        x,
      ),
    );
    assert(!f.calls.some((c) => c.method === 'create'));
  }
});
test('Odoo strict source validation prevents missing address, invalid totals, unsupported corrections and dates', () => {
  const x = input();
  for (const mutate of [
    (d: any) => (d.data = null),
    (d: any) => (d.data.address = null),
    (d: any) => (d.kind = 'correction'),
    (d: any) => d.data.total++,
    (d: any) => (d.data.items[0].quantity = 0.5),
  ]) {
    const d = doc();
    mutate(d);
    assert.throws(() => exportSource(d, x));
  }
  assert.throws(() => exportSource(doc(), { ...x, invoice_date: '2026-10-03' }));
  assert.throws(() => odooExportInput.parse({ ...x, invoice_date: '2026-02-30' }));
  assert.equal(erpMinor(235.0), 23500);
  for (const v of [-1, NaN, Infinity, 1.001]) assert.throws(() => erpMinor(v));
});
test('Odoo mutation has one HTTP attempt; reads retry only with fresh fencing', async () => {
  let calls = 0,
    fences = 0;
  const c = new OdooAccounting(odooSettings, odooCredentials, async () => {
    calls++;
    return new Response('private', { status: 503, headers: { 'retry-after': '0' } });
  });
  await assert.rejects(() =>
    c.create({}, async () => {
      fences++;
    }),
  );
  assert.equal(calls, 1);
  assert.equal(fences, 1);
  await assert.rejects(
    () =>
      c.invoice(1, async () => {
        fences++;
        if (calls > 1) throw Error('revoked');
      }),
    /revoked/,
  );
  assert.equal(calls, 2);
  assert.equal(fences, 3);
});
test('Odoo invoice verification rejects changed header, totals, lines and missing posted number', async () => {
  const f = accountingFixture(),
    c = new OdooAccounting(odooSettings, odooCredentials, f.transport),
    x = input(),
    s = exportSource(doc(), x),
    metadata = await c.metadata(s, x),
    p = { input: x, reference: 'QA', snapshot: { source: s, metadata } };
  const id = await c.create(accountingPayload(p.reference, s, x, metadata));
  await c.post(id);
  const move = await c.invoice(id);
  for (const mutate of [
    (m: any) => {
      m.amount_untaxed += 0.01;
      m.amount_tax -= 0.01;
    },
    (m: any) => {
      m.lines[0].price_subtotal += 0.01;
    },
    (m: any) => (m.company_id = [2, 'Foreign']),
    (m: any) => m.amount_total++,
    (m: any) => (m.name = '/'),
    (m: any) => (m.lines[0].tax_ids = [99]),
    (m: any) => m.lines[0].quantity++,
    (m: any) => (m.invoice_date_due = '2026-11-10'),
  ]) {
    const m = structuredClone(move);
    mutate(m);
    assert.throws(() => verifyOdooInvoice(p, m, true));
  }
});
