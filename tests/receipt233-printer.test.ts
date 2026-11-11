/** DYNA-FISC/1 driver against the local fake fiscal printer on a loopback port: status, print, NIP,
 * idempotent retry by job id, paper out → failed → retry → printed, offline, PTU mismatch, daily
 * report with VAT per PTU total. No database. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PTU_TABLE, transition, type ReceiptState } from '../server/receipt233-model';
import { attemptPrint, fiscalPrinterDriver, parsePtuWire, ptuWire, PrinterError, simplifiedProtocolDriver, type PrintJob } from '../server/receipt233-printer';
import { startFakeFiscalPrinter } from '../server/receipt233-fake-printer';

const job = (id: string, extra: Partial<PrintJob> = {}): PrintJob => ({
  job_id: id, buyer_nip: null, ptu: DEFAULT_PTU_TABLE, total_minor: '12801',
  lines: [{ ptu: 'A', quantity: 2, unit_gross_minor: '5000', gross_minor: '9999', name: 'Kubek ceramiczny „Zażółć”' }, { ptu: 'B', quantity: 1, unit_gross_minor: '2802', gross_minor: '2802', name: 'Dostawa' }],
  payment: { form: 'przelew', amount_minor: '12801' }, ...extra,
});
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('PTU wire format round-trips and refuses malformed tables', () => {
  assert.deepEqual(parsePtuWire(ptuWire(DEFAULT_PTU_TABLE)), DEFAULT_PTU_TABLE);
  assert.equal(ptuWire(DEFAULT_PTU_TABLE), 'A:23,B:8,C:5,D:0,E:zw,F:-,G:-');
  assert.equal(parsePtuWire('A:23,B:8'), null);
  assert.equal(parsePtuWire('B:23,A:8,C:5,D:0,E:zw,F:-,G:-'), null);
  assert.throws(() => simplifiedProtocolDriver({ host: '192.168.1.10', port: 9100 }), /loopback/);
});

test('fake printer: status, receipt with NIP, idempotent job, daily report', async t => {
  const p = await startFakeFiscalPrinter({ fiscal_date: '2026-10-25' });
  t.after(() => p.close());
  const d = fiscalPrinterDriver({ model_family: 'posnet', host: '127.0.0.1', port: p.port });
  assert.deepEqual(await d.status(), { protocol: 'DYNA-FISC/1', unique_number: 'DYN12345678', fiscal_date: '2026-10-25', ptu: DEFAULT_PTU_TABLE });
  const r = await d.printReceipt(job(id(1), { buyer_nip: '5260250274' }));
  assert.deepEqual(r, { number: '000001', fiscal_date: '2026-10-25', already_printed: false });
  assert.equal(p.receipts[0]!.nip, '5260250274');
  assert.equal(p.receipts[0]!.lines[0]!.name, 'Kubek ceramiczny „Zażółć”');
  // The same job again is found by QUERY, not printed twice.
  assert.deepEqual(await d.printReceipt(job(id(1))), { number: '000001', fiscal_date: '2026-10-25', already_printed: true });
  assert.equal(p.receipts.length, 1);
  assert.deepEqual(await d.query(id(1)), { number: '000001', fiscal_date: '2026-10-25' });
  assert.equal(await d.query(id(2)), null);
  await d.printReceipt(job(id(2), { total_minor: '9999', lines: [job('x').lines[0]!], payment: { form: 'karta', amount_minor: '9999' } }));
  const rep = await d.dailyReport();
  // VAT per PTU total, as a cash register computes it: A 19998 → 3739 (the per-line invoice math gives 2 × 1870 = 3740); B 2802 → 208.
  assert.deepEqual(rep, { number: '0001', fiscal_date: '2026-10-25', receipts: 2, totals: [{ ptu: 'A', gross_minor: '19998', vat_minor: '3739' }, { ptu: 'B', gross_minor: '2802', vat_minor: '208' }] });
  await assert.rejects(d.dailyReport(), (e: unknown) => e instanceof PrinterError && e.code === 'PRINTER_ERROR' && e.already === '0001' && !/ALREADY/.test(e.message));
});

test('paper out → failed → retry → printed; the state machine follows each attempt', async t => {
  const p = await startFakeFiscalPrinter({ fiscal_date: '2026-10-25' });
  t.after(() => p.close());
  const d = fiscalPrinterDriver({ model_family: 'novitus', host: '127.0.0.1', port: p.port });
  let state: ReceiptState = 'queued';
  p.setFault('paper_out');
  state = transition(state, 'sent');
  const a = await attemptPrint(d, job(id(3)));
  assert.equal(a.ok, false);
  assert.equal(!a.ok && a.code, 'PAPER_OUT');
  assert.match(!a.ok ? a.message : '', /Brak papieru/);
  state = transition(state, 'failed');
  assert.equal(p.receipts.length, 0);
  p.setFault(null);
  state = transition(transition(state, 'queued'), 'sent');
  const b = await attemptPrint(d, job(id(3)));
  assert.equal(b.ok && b.receipt.number, '000001');
  state = transition(state, 'printed');
  assert.equal(state, 'printed');
  // A retry after an unconfirmed success (e.g. the app lost the answer) returns the same receipt.
  const c = await attemptPrint(d, job(id(3)));
  assert.deepEqual(c, { ok: true, receipt: { number: '000001', fiscal_date: '2026-10-25', already_printed: true } });
  assert.equal(p.receipts.length, 1);
});

test('offline (no answer, nothing listening), PTU mismatch and a wrong total are failures', async t => {
  const p = await startFakeFiscalPrinter({ fiscal_date: '2026-10-25' });
  t.after(() => p.close());
  const d = simplifiedProtocolDriver({ host: '127.0.0.1', port: p.port, timeout_ms: 500 });
  p.setFault('offline');
  const off = await attemptPrint(d, job(id(4)));
  assert.equal(!off.ok && off.code, 'OFFLINE');
  assert.equal(!off.ok && off.uncertain, false, 'offline before OPEN: nothing can have been printed');
  p.setFault(null);
  p.setPtu({ ...DEFAULT_PTU_TABLE, A: '8', B: '23' });
  const ptu = await attemptPrint(d, job(id(4)));
  assert.equal(!ptu.ok && ptu.code, 'PTU_MISMATCH');
  p.setPtu(DEFAULT_PTU_TABLE);
  const total = await attemptPrint(d, job(id(4), { total_minor: '12800' }));
  assert.equal(!total.ok && total.code, 'TOTAL_MISMATCH');
  assert.equal(p.receipts.length, 0);
  const port = p.port;
  await p.close();
  const gone = await attemptPrint(simplifiedProtocolDriver({ host: '127.0.0.1', port, timeout_ms: 500 }), job(id(4)));
  assert.equal(!gone.ok && gone.code, 'OFFLINE');
  // The over-the-wire test control works too.
  const q = await startFakeFiscalPrinter();
  t.after(() => q.close());
  const net = await import('node:net');
  await new Promise<void>(res => { const s = net.createConnection({ host: '127.0.0.1', port: q.port }, () => s.write('FAULT PAPER_OUT\n')); s.on('data', () => { s.destroy(); res(); }); });
  const paper = await attemptPrint(simplifiedProtocolDriver({ host: '127.0.0.1', port: q.port }), job(id(5)));
  assert.equal(!paper.ok && paper.code, 'PAPER_OUT');
});

test('the answer lost after OPEN (connection dropped on CLOSE) is an uncertain OFFLINE; QUERY then finds the printed receipt', async t => {
  const net = await import('node:net');
  const p = await startFakeFiscalPrinter({ fiscal_date: '2026-10-25' });
  t.after(() => p.close());
  // Relays to the fake printer and drops the connection instead of relaying the answer to CLOSE.
  const relay = net.createServer(client => {
    const up = net.createConnection({ host: '127.0.0.1', port: p.port });
    let drop = false, buf = '';
    client.on('data', d => { buf += d.toString('utf8'); for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) { const l = buf.slice(0, i); buf = buf.slice(i + 1); drop ||= l.startsWith('CLOSE '); up.write(l + '\n'); } });
    up.on('data', d => { if (drop) { client.destroy(); up.destroy(); } else client.write(d); });
    for (const s of [client, up]) s.on('error', () => undefined);
    client.on('close', () => up.destroy());
  });
  await new Promise<void>(r => relay.listen(0, '127.0.0.1', () => r()));
  t.after(() => new Promise<void>(r => relay.close(() => r())));
  const lost = await attemptPrint(simplifiedProtocolDriver({ host: '127.0.0.1', port: (relay.address() as import('node:net').AddressInfo).port, timeout_ms: 500 }), job(id(6)));
  assert.deepEqual(!lost.ok && [lost.code, lost.uncertain], ['OFFLINE', true]);
  assert.equal(p.receipts.length, 1, 'the printer printed although the app got no answer');
  const again = await attemptPrint(simplifiedProtocolDriver({ host: '127.0.0.1', port: p.port }), job(id(6)));
  assert.deepEqual(again.ok && [again.receipt.already_printed, p.receipts.length], [true, 1]);
});

test('a peer that is not a fiscal printer: the error names no byte of its answer (no banner leaks)', async t => {
  const net = await import('node:net');
  const banner = 'SSH-2.0-OpenSSH_9.9 sekretny-baner-uslugi';
  const srv = net.createServer(s => { s.write(banner + '\n'); s.on('data', () => s.write('ERR ' + banner + '\n')); s.on('error', () => undefined); });
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
  t.after(() => new Promise<void>(r => srv.close(() => r())));
  const port = (srv.address() as import('node:net').AddressInfo).port, d = simplifiedProtocolDriver({ host: '127.0.0.1', port, timeout_ms: 500 });
  const errors: PrinterError[] = [];
  for (const op of [() => d.status(), () => d.printReceipt(job(id(9))), () => d.dailyReport(), () => d.query(id(9))])
    await op().then(() => assert.fail('no error'), (e: unknown) => { assert(e instanceof PrinterError); errors.push(e); });
  for (const e of errors) {
    assert(!/SSH|OpenSSH|sekretny|baner/.test(e.message), e.message);
    assert.match(e.message, /nieobsługiwanym protokołem|zgłosiła błąd/);
  }
  assert.equal(errors[0]!.code, 'PROTOCOL');
  assert(errors.some(e => e.peer?.includes('OpenSSH')), 'the peer bytes are kept only for the server log');
  const out = await attemptPrint(d, job(id(9)));
  assert(!out.ok && !/SSH|sekretny/.test(out.message));
});
