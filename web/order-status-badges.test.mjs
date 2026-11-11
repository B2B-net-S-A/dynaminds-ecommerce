/** Order stage and payment badges: label always as text, semantic class, neutral fallback; CSS hex = contract. */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
test('order status badges render label and semantic class; CSS colours match web/order-stage.ts', async (t) => {
  const dom = new JSDOM('<body/>', { url: 'http://127.0.0.1:4106/' }), prior = new Map();
  for (const [k, v] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    prior.set(k, Object.getOwnPropertyDescriptor(globalThis, k));
    Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: v });
  }
  const vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', logLevel: 'error' });
  const contract = await vite.ssrLoadModule(path.resolve('web/order-stage.ts'));
  const { FulfilmentBadge, PaymentBadge, stageOf, paymentStateOf } = await vite.ssrLoadModule(path.resolve('web/order-status-badges.tsx'));
  const { createRoot } = await import('react-dom/client');
  async function render(Component, props) {
    const el = document.createElement('div');
    document.body.append(el);
    const root = createRoot(el);
    await act(async () => root.render(React.createElement(Component, props)));
    const span = el.firstElementChild, out = { className: span.className, text: span.textContent };
    await act(async () => root.unmount());
    el.remove();
    return out;
  }
  try {
    await t.test('every fulfilment stage shows its label with its stage class', async () => {
      for (const [stage, label] of Object.entries(contract.fulfilmentLabels))
        assert.deepEqual(await render(FulfilmentBadge, { stage }), { className: `order-badge order-stage-${stage}`, text: label });
      assert.equal((await render(FulfilmentBadge, { stage: 'new' })).text, 'Czeka na wpłatę');
      assert.equal((await render(FulfilmentBadge, { stage: 'ready_to_ship' })).text, 'Gotowe do nadania');
    });
    await t.test('every payment state shows its label with its payment class', async () => {
      for (const [state, label] of Object.entries(contract.paymentLabels))
        assert.deepEqual(await render(PaymentBadge, { state }), { className: `order-badge order-pay-${state}`, text: label });
    });
    await t.test('an unknown value shows the raw value in a neutral badge', async () => {
      assert.deepEqual(await render(FulfilmentBadge, { stage: 'on_hold' }), { className: 'order-badge order-unknown', text: 'on_hold' });
      assert.deepEqual(await render(PaymentBadge, { state: 'refunded' }), { className: 'order-badge order-unknown', text: 'refunded' });
    });
    await t.test('stage and payment state come from the payload, with fallbacks for older payloads', () => {
      assert.equal(stageOf({ status: 'packed', fulfilment_stage: 'ready_to_ship' }), 'ready_to_ship');
      assert.equal(stageOf({ status: 'packed' }), 'packed');
      assert.equal(paymentStateOf({ payment_state: 'partial', payment: { amount_due: 0, net: 100 } }), 'partial');
      assert.equal(paymentStateOf({ payment: { amount_due: 0, net: 100 } }), 'paid');
      assert.equal(paymentStateOf({ payment: { amount_due: 100, net: 0 } }), 'unpaid');
      assert.equal(paymentStateOf({ payment: { amount_due: 40, net: 60 } }), 'partial');
      assert.equal(paymentStateOf({ payment: { amount_due: 0, net: 120, overpayment: 20 } }), 'overpaid');
      assert.equal(paymentStateOf({ payment_mode: 'cod', payment: { amount_due: 100, net: 0 } }), 'cod');
      assert.equal(paymentStateOf({ payment: { net: 50, nominal: 100 } }), 'partial');
      assert.equal(paymentStateOf({ total: 100 }), 'unpaid', 'no ledger summary: the total is owed');
    });
    await t.test('CSS colour of every stage and payment class equals the contract hex', () => {
      const css = readFileSync(path.resolve('web/order-status.css'), 'utf8');
      const declared = (prefix) => Object.fromEntries([...css.matchAll(new RegExp(`\\.${prefix}-(\\w+)\\s*\\{\\s*--order-status-color:\\s*(#[0-9a-fA-F]{6})\\s*;`, 'g'))].map((m) => [m[1], m[2].toUpperCase()]));
      const upper = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.toUpperCase()]));
      assert.deepEqual(declared('order-stage'), upper(contract.fulfilmentColors));
      assert.deepEqual(declared('order-pay'), upper(contract.paymentColors));
    });
  } finally {
    await vite.close();
    for (const [k, d] of prior) d ? Object.defineProperty(globalThis, k, d) : delete globalThis[k];
  }
});
