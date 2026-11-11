// Local fakes of the demo instance (host loopback only; tools/demo/demo.sh starts them, the release reaches them through
// tools/demo/forward.mjs): KSeF 2.0 (server/ksef229-fake.ts) and the fiscal printer 233 (server/receipt233-fake-printer.ts).
// Neither talks to any MF host or real device. Both follow the demo database clock (libfaketime offset file), so the
// seeder can write historical days; at offset +0 they use real time.
// The printer keeps its receipt counter in <state file> across restarts and resets (a real printer never restarts its
// numbering; receipts are unique per printer, fiscal day and number).
//
//   node node_modules/tsx/dist/cli.mjs tools/demo/fakes.mts <ksef port> <printer port> <faketime.rc> <printer state.json>
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { startFakeKsef } from '../../server/ksef229-fake.ts';
import { startFakeFiscalPrinter } from '../../server/receipt233-fake-printer.ts';

const [ksefPort, printerPort] = process.argv.slice(2, 4).map(Number);
const [offsetFile, stateFile] = process.argv.slice(4, 6);
if (!(ksefPort > 1023 && printerPort > 1023 && offsetFile && stateFile)) throw new Error('usage: fakes.mts <ksef port> <printer port> <faketime.rc> <state.json>');
let offsetMs = 0;
const readOffset = () => { try { const s = readFileSync(offsetFile, 'utf8').trim(); const n = Number(s); if (Number.isFinite(n)) offsetMs = n * 1000; } catch { /* keep last */ } };
readOffset();
// The fake dates its public-key certificates from its first now() (valid 365 days): pin that one to 1.09.2026 so the
// keys are valid for the whole simulated history (from 28.09) and the demo day.
let keysEpoch = true;
const now = () => (keysEpoch ? new Date('2026-09-01T00:00:00Z') : new Date(Date.now() + offsetMs));
const warsawDay = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw' }).format(now());

export const UNIQUE = 'DMO26103001';
const ksef = await startFakeKsef({ port: ksefPort, now });
keysEpoch = false;
const printer = await startFakeFiscalPrinter({ port: printerPort, unique_number: UNIQUE });
let saved = 0;
try { saved = Number(JSON.parse(readFileSync(stateFile, 'utf8')).receipts) || 0; } catch { /* first start */ }
// Placeholders continue the numbering after a restart (only .length is used for the next number).
for (let i = 0; i < saved; i++) printer.receipts.push({ job_id: `restored-${i}`, nip: null, payment: '', lines: [], total_minor: 0n, number: String(i + 1).padStart(6, '0'), fiscal_date: '1970-01-01' } as never);
const tick = () => {
  readOffset();
  printer.setDate(offsetMs === 0 ? null as never : warsawDay());
  if (printer.receipts.length !== saved) {
    saved = printer.receipts.length;
    writeFileSync(stateFile + '.tmp', JSON.stringify({ receipts: saved }), { mode: 0o600 }); renameSync(stateFile + '.tmp', stateFile);
  }
};
tick(); setInterval(tick, 500);
console.log(JSON.stringify({ status: 'DEMO_FAKES_LISTENING', ksef: ksef.url, printer: printer.port, printer_unique_number: UNIQUE, receipts_before: saved }));
const stop = () => { void ksef.close().finally(() => process.exit(0)); };
process.once('SIGTERM', stop); process.once('SIGINT', stop);
