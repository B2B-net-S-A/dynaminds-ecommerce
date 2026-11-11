import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { webcrypto, createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import React, { act, StrictMode } from 'react';

// Execute the real component, including its effects and asynchronous reads.
// A temporary historical control proves that the race actually fails before the fix.
const context = '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222:admin:false';
const order = '33333333-3333-4333-8333-333333333333';
const station = { id: '44444444-4444-4444-8444-444444444444', version: '1', code: 'QA', label: 'QA station', enabled: true };
const printer = { id: '55555555-5555-4555-8555-555555555555', version: '1', station_id: station.id, name: 'QA file output', format: 'pdf', output_mode: 'file', cups_queue: null, enabled: true };
const flags = { available: true, read_only: false, current_role: 'admin', can_read: true, can_write: true, can_manage: true };
const options = { ...flags, stations: [station], limits: {} };
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

test('revocation releases only its own read while discarding stale data', async () => {
  const cwd = process.cwd();
  const source = await fs.readFile(path.join(cwd, 'web/print-jobs.tsx'), 'utf8');
  const fixed = 'if (alive.current && scope.current === id && generation.current === n) setReading(false);';
  assert.equal(source.split(fixed).length - 1, 2, 'Both read and file cleanup must be under test.');
  const historical = source.replaceAll(fixed, 'if (current(n, e, id)) setReading(false);');
  const temp = path.join(cwd, 'web', `.qa-print-jobs-before-${process.pid}.tsx`);
  await fs.writeFile(temp, historical, { flag: 'wx' });
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1/' });
  const originals = new Map();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, MouseEvent: dom.window.MouseEvent, Event: dom.window.Event, crypto: webcrypto, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const originalFetch = globalThis.fetch;
  const vite = await createServer({ server: { middlewareMode: true, hmr: false, watch: null }, appType: 'custom', logLevel: 'error' });
  const { createRoot } = await import('react-dom/client');
  const evidence = [];
  try {
    const before = await vite.ssrLoadModule(temp);
    const after = await vite.ssrLoadModule(path.join(cwd, 'web/print-jobs.tsx'));
    for (const [name, mod] of [['historical_control', before], ['fixed', after]]) {
      for (const kind of ['metadata_read', 'file_read']) {
        let holdOptions = null;
        let requests = 0;
        globalThis.fetch = async (url, init) => {
          requests++;
          assert.equal(init.method, 'GET', 'Component test must perform no application writes.');
          if (url === '/api/auth/me') return Response.json({ user: { tenant_id: context.split(':')[0], id: context.split(':')[1], role: 'admin' } });
          if (url === '/api/print-jobs/options') {
            if (holdOptions) { const h = holdOptions; holdOptions = null; await h.promise; }
            return Response.json(options);
          }
          if (url === '/api/print-jobs/printers') return Response.json({ ...flags, printers: [printer], next_cursor: null });
          throw Error('Unexpected component request.');
        };
        const container = document.createElement('div'); document.body.append(container);
        const root = createRoot(container);
        const button = (text) => [...container.querySelectorAll('button')].find(b => b.textContent === text);
        const refresh = () => [...container.querySelectorAll('button')].find(b => /^(?:Od\u015bwie\u017c dost\u0119p i drukarki|Odczytaj dost\u0119p do drukowania)$/.test(b.textContent));
        const render = () => React.createElement(StrictMode, null, React.createElement(mod.PrintJobsPanel, { contextKey: context, readOnly: false, orderId: order }));
        try {
          await act(async () => { root.render(render()); });
          assert.equal(refresh().disabled, false, 'StrictMode initial read must finish.');
          const delayed = deferred(), hashComplete = deferred();
          if (kind === 'metadata_read') {
            holdOptions = delayed;
            await act(async () => { refresh().dispatchEvent(new MouseEvent('click', { bubbles: true })); });
          } else {
            Object.defineProperty(globalThis, 'crypto', { configurable: true, writable: true, value: { subtle: { digest: async (...args) => { const value = await webcrypto.subtle.digest(...args); hashComplete.resolve(); return value; } } } });
            const select = container.querySelector('input[type=file]').closest('fieldset').querySelector('select');
            await act(async () => { select.value = printer.id; select.dispatchEvent(new Event('change', { bubbles: true })); });
            const input = container.querySelector('input[type=file]');
            const bytes = Buffer.from('%PDF-1.4\nQA CONTROLLED FILE\n%%EOF');
            const file = { name: 'QA148.pdf', size: bytes.length, arrayBuffer: async () => { await delayed.promise; return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); } };
            Object.defineProperty(input, 'files', { configurable: true, value: [file] });
            await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
          }
          assert.equal(refresh().disabled, true, `${name}/${kind}: a real local read is held.`);
          await act(async () => { mod.purgePrintJobsAccess(context); });
          await act(async () => { delayed.resolve(); if (kind === 'file_read') await hashComplete.promise; });
          const enabled = !refresh().disabled;
          assert.equal(enabled, name === 'fixed', `${name}/${kind}: historical control must remain stuck; fixed panel must recover.`);
          assert.equal(container.textContent.includes('QA148.pdf'), false, 'Revoked file bytes must not reappear.');
          assert.equal(container.querySelector('fieldset'), null, 'Stale access must not restore the write form.');
          if (name === 'fixed') {
            await act(async () => { refresh().dispatchEvent(new MouseEvent('click', { bubbles: true })); });
            assert.equal(refresh().disabled, false);
            assert.ok(container.querySelector('fieldset'), 'Explicit current-access read restores the form.');
          }
          evidence.push({ variant: name, scenario: kind, stale_data_discarded: true, recover_button_enabled: enabled, get_requests: requests, post_requests: 0 });
        } finally { await act(async () => { root.unmount(); }); container.remove(); }
      }
    }
    // An old completion must never clear the busy state of a newer identity read.
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    const first = deferred(), second = deferred();
    let stage = 0;
    globalThis.fetch = async url => {
      if (url === '/api/auth/me') return Response.json({ user: { tenant_id: context.split(':')[0], id: context.split(':')[1], role: 'admin' } });
      if (url === '/api/print-jobs/options') { const n = stage++; if (n === 0) await first.promise; if (n === 1) await second.promise; return Response.json(options); }
      if (url === '/api/print-jobs/printers') return Response.json({ ...flags, printers: [printer], next_cursor: null });
      throw Error('Unexpected request.');
    };
    const otherOrder = '66666666-6666-4666-8666-666666666666';
    try {
      await act(async () => { root.render(React.createElement(after.PrintJobsPanel, { contextKey: context, readOnly: false, orderId: order })); });
      await act(async () => { root.render(React.createElement(after.PrintJobsPanel, { contextKey: context, readOnly: false, orderId: otherOrder })); });
      await act(async () => { first.resolve(); });
      assert.equal(container.querySelector('button').disabled, true, 'Old completion cannot release a newer held read.');
      await act(async () => { second.resolve(); });
      assert.equal(container.querySelector('button').disabled, false);
      evidence.push({ variant: 'fixed', scenario: 'newer_identity_read', old_completion_released_new_read: false, latest_completion_released_read: true });
    } finally { await act(async () => { root.unmount(); }); container.remove(); }
    if (process.env.QA148_REPORT_PATH) {
      await fs.writeFile(process.env.QA148_REPORT_PATH, JSON.stringify({ stage: 148, status: 'REAL_COMPONENT_RACE_PASS', actual_browser: false, database_used: false, external_network_used: false, source_sha256: createHash('sha256').update(source).digest('hex'), scenarios: evidence }, null, 2) + '\n', { flag: 'wx' });
    }
  } finally {
    await vite.close(); await fs.unlink(temp);
    globalThis.fetch = originalFetch;
    dom.window.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
});
