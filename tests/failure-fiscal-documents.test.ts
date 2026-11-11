/** S4 failure tests of fiscal documents: the fiscal receipt print (RES-18) against the local fake printer
 * (server/receipt233-fake-printer.ts) when the process dies after the claim, after the printer printed
 * but before the outcome was stored, and when the printer's answer to CLOSE is lost; a double click;
 * and parallel issue of 230 invoices in one series (RES-02). Zero double effects means: one receipt in
 * the printer's fiscal memory per order, and no invoice while it is unknown whether a receipt exists.
 * Run on a fresh clone dynaminds_s4_20261025_NN (tests/failure-helpers.ts). */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { pool } from '../server/db';
import { Problem } from '../server/errors';
import { startFakeFiscalPrinter, type FakePrinter } from '../server/receipt233-fake-printer';
import { fiscalPrinterDriver } from '../server/receipt233-printer';
import { claimReceiptInTx, storeReceiptInTx } from '../server/receipt233';
import { setReceipt233DriverFactory } from '../server/receipt233-service';
import { taxInvoiceTransaction } from '../server/tax226-local-invoices';
import { assertS4Clone, lostAnswerProxy, relaxPoolTimeouts } from './failure-helpers';
import { call, fiscalApp, fiscalOwner, frameActor, issue157, issue230, ok, preview230, refused, series, shippedOrder, type Owner, type Res, type Series } from './failure-helpers-fiscal';

assertS4Clone();
relaxPoolTimeouts();
pool.options.query_timeout = 120000;
const KEY_NAME = 'Isolated S4 fiscal failure test';
const UNIQUE = 'DYN23340001';
let app: FastifyInstance, printer: FakePrinter, a: Owner, s: Series;

before(async () => {
  assert.notEqual((await pool.query("SELECT to_regclass('public.receipt233_receipts') n")).rows[0].n, null, 'clone needs 233');
  assert.equal((await pool.query('SELECT count(*)::int n FROM api_keys WHERE name=$1', [KEY_NAME])).rows[0].n, 0, 'Fresh clone required; no rerun');
  a = await fiscalOwner(KEY_NAME);
  printer = await startFakeFiscalPrinter({ unique_number: UNIQUE });
  app = await fiscalApp();
  ok(await call(app, a, 'PUT', '/api/receipt233/printer', { name: 'Kasa S4', model_family: 'posnet', host: '127.0.0.1', port: printer.port, unique_number: UNIQUE }));
  s = await series(a);
});
after(async () => {
  setReceipt233DriverFactory(null);
  await app?.close();
  await printer?.close();
  await pool.end();
});

const print = (local: string, key = randomUUID()) => call(app, a, 'POST', `/api/receipt233/orders/${local}/receipts`, { client_key: key, payment_form: 'karta', confirmed: true });
const retry = (id: string) => call(app, a, 'POST', `/api/receipt233/receipts/${id}/retry`, { confirmed: true });
const inPrinter = (id: string) => printer.receipts.filter((r) => r.job_id === id);
const receiptOf = async (local: string) => (await pool.query('SELECT * FROM receipt233_receipts WHERE order_id=$1', [local])).rows[0];
const audits = async (id: string) =>
  (await pool.query("SELECT action,detail FROM audit_events WHERE entity_id=$1 AND action LIKE 'receipt233.%' ORDER BY created_at", [id])).rows;
/** The 157 issue refuses through a 409 response or a Problem of its preview. */
async function refused157(local: string, pattern: RegExp) {
  let r: Res | undefined;
  try { r = await issue157(app, a, s, local); }
  catch (e) { assert(e instanceof Problem && e.status === 409, String(e)); assert.match(e.message, pattern); return; }
  refused(r, 409, pattern);
}
/** "Old process": the receipt is stored and claimed (state sent, committed), then the process dies. */
async function claimedThenCrashed(local: string) {
  const actor = frameActor(a);
  const stored = await taxInvoiceTransaction(actor, true, (c) => storeReceiptInTx(c, actor, local, { client_key: randomUUID(), payment_form: 'karta', buyer_nip: null, shipping_vat: 23, confirmed: true } as never));
  const claim = await taxInvoiceTransaction(actor, true, (c) => claimReceiptInTx(c, actor, stored.id, false));
  assert(claim);
  return { id: stored.id, claim };
}

test('restart po COMMIT przejęcia (sent), przed drukarką: faktury odmawiane, „Ponów druk” drukuje dokładnie raz', async () => {
  const local = await shippedOrder(a, 4100, 's4-sent@example.test');
  const { id } = await claimedThenCrashed(local);
  assert.deepEqual([(await receiptOf(local)).state, (await receiptOf(local)).attempts, inPrinter(id).length], ['sent', 1, 0]);
  // While the outcome is unknown, no invoice documents the same sale.
  refused(await preview230(app, a, s, local), 409, /w trakcie druku/);
  await refused157(local, /w trakcie druku/);
  // A second receipt for the order is refused; the operator retries the job instead.
  refused(await print(local), 409, /w kolejce druku/);
  const r = ok(await retry(id)).receipt;
  assert.deepEqual([r.state, r.attempts, inPrinter(id).length, r.number], ['printed', 1, 1, inPrinter(id)[0]!.number]);
  assert.equal(ok(await retry(id)).receipt.state, 'printed');
  assert.equal(inPrinter(id).length, 1, 'printed once');
  const send = (await audits(id)).filter((x) => x.action === 'receipt233.send');
  assert.deepEqual(send.map((x) => x.detail.recovery), [false, true], 'the retry is recorded as a recovery of the same attempt');
});

test('restart po wydruku, przed zapisem wyniku: ponowienie pyta drukarkę (QUERY) i zapisuje ten sam paragon bez drugiego druku', async () => {
  const local = await shippedOrder(a, 4200, 's4-printed@example.test');
  const { id, claim } = await claimedThenCrashed(local);
  // The old process reached the printer: the receipt is in the fiscal memory, the outcome never stored.
  const printed = await fiscalPrinterDriver({ model_family: 'posnet', host: '127.0.0.1', port: printer.port }).printReceipt(claim.job);
  assert.equal(printed.already_printed, false);
  assert.equal((await receiptOf(local)).state, 'sent');
  const r = ok(await retry(id)).receipt;
  assert.deepEqual([r.state, r.number, r.attempts, inPrinter(id).length], ['printed', printed.number, 1, 1]);
  const last = (await audits(id)).at(-1)!;
  assert.equal(last.action, 'receipt233.printed');
  assert.equal(last.detail.already_printed, true);
});

test('utracona odpowiedź drukarki na CLOSE: ponowienie nie drukuje drugi raz i zapisuje numer z pamięci drukarki', async () => {
  const local = await shippedOrder(a, 4300, 's4-lost-close@example.test');
  const proxy = await lostAnswerProxy(printer.port, (line) => line.startsWith('CLOSE '));
  try {
    setReceipt233DriverFactory((cfg) => fiscalPrinterDriver({ ...cfg, port: proxy.port }));
    const first = ok(await print(local), 201).receipt;
    assert.equal(proxy.lost(), 1);
    assert.equal(inPrinter(first.id).length, 1, 'the printer printed although the app got no answer');
    assert.notEqual(first.state, 'printed');
    setReceipt233DriverFactory(null);
    const r = ok(await retry(first.id)).receipt;
    assert.deepEqual([r.state, r.number, inPrinter(first.id).length], ['printed', inPrinter(first.id)[0]!.number, 1]);
  } finally {
    setReceipt233DriverFactory(null);
    await proxy.close();
  }
});

test('utracona odpowiedź drukarki na CLOSE: dopóki wynik nieznany, paragon nie jest „Błąd druku” i faktura jest odmawiana', async () => {
  const local = await shippedOrder(a, 4400, 's4-lost-close-invoice@example.test');
  const proxy = await lostAnswerProxy(printer.port, (line) => line.startsWith('CLOSE '));
  try {
    setReceipt233DriverFactory((cfg) => fiscalPrinterDriver({ ...cfg, port: proxy.port }));
    const first = ok(await print(local), 201).receipt;
    setReceipt233DriverFactory(null);
    assert.equal(inPrinter(first.id).length, 1);
    // Outcome unknown: the job must stay in print (retry asks the printer first) and no invoice may be
    // prepared for the sale. Both observed together, so a failure shows the whole current behaviour.
    const invoice = await preview230(app, a, s, local);
    assert.deepEqual([first.state, invoice.statusCode], ['sent', 409], 'receipt state and 230 preview status after the lost CLOSE answer: ' + invoice.body.slice(0, 200));
    await refused157(local, /w trakcie druku/);
  } finally {
    setReceipt233DriverFactory(null);
    await proxy.close();
  }
});

test('podwójne kliknięcie „Drukuj” (ten sam client_key) i dwa różne żądania naraz: jeden paragon w drukarce, bez 500', async () => {
  for (const sameKey of [true, false]) {
    const local = await shippedOrder(a, sameKey ? 4500 : 4600, `s4-double-${sameKey}@example.test`);
    const key = randomUUID();
    const before = printer.receipts.length;
    const answers = await Promise.all([print(local, sameKey ? key : randomUUID()), print(local, sameKey ? key : randomUUID()), print(local, sameKey ? key : randomUUID())]);
    for (const r of answers) assert([200, 201, 409].includes(r.statusCode), r.statusCode + ' ' + r.body);
    assert(answers.some((r) => r.statusCode === 201));
    const row = await receiptOf(local);
    assert.equal(row.state, 'printed');
    assert.equal(printer.receipts.length - before, 1, 'one receipt in the fiscal memory');
    assert.equal(inPrinter(row.id).length, 1);
  }
});

test('RES-02: równoległe wystawienie faktur 230 w jednej serii daje kolejne numery bez luk i duplikatów (także pierwsze w nowej serii)', async () => {
  const fresh = await series(a);
  const orders = [];
  for (let n = 0; n < 4; n++) orders.push(await shippedOrder(a, 5000 + n, `s4-series-${n}@example.test`));
  const issued: Res[] = [];
  // Round 1: the series has no counter row yet; round 2: the counter exists.
  for (const pair of [orders.slice(0, 2), orders.slice(2)]) issued.push(...(await Promise.all(pair.map((o) => issue230(app, a, fresh, o)))));
  const statuses = issued.map((r) => r.statusCode);
  assert.deepEqual(statuses.filter((x) => x !== 201 && x !== 409), [], 'no server error: ' + issued.map((r) => r.body).join(' | '));
  const docs = (await pool.query('SELECT number,sequence FROM invoice230_documents WHERE series_id=$1 ORDER BY sequence', [fresh.id])).rows;
  assert.deepEqual(docs.map((d) => d.sequence), docs.map((_, i) => i + 1), 'numbers without gaps');
  assert.equal(new Set(docs.map((d) => d.number)).size, docs.length);
  // A refused concurrent first issue (counter race) is retryable and then takes the next number.
  for (const [i, r] of issued.entries()) if (r.statusCode !== 201) assert.equal((await issue230(app, a, fresh, orders[i]!)).statusCode, 201);
  const all = (await pool.query('SELECT sequence FROM invoice230_documents WHERE series_id=$1 ORDER BY sequence', [fresh.id])).rows.map((d) => d.sequence);
  assert.deepEqual(all, [1, 2, 3, 4]);
});
