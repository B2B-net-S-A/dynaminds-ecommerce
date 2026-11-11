/** Fiscal printer port (233) and its driver for the simplified local protocol DYNA-FISC/1.
 *
 * The app talks to a fiscal printer only through `FiscalPrinterDriver`. A real driver for a Posnet
 * (Thermal/XML), Elzab or Novitus protocol implements the same five operations; those protocols are
 * not in scope here. The configured model family is stored and shown, and every family is served by
 * the DYNA-FISC/1 driver, which refuses a device that does not answer HELLO with that protocol name.
 *
 * DYNA-FISC/1 — TCP on a loopback host, UTF-8, one request line and one response line, `\n` ended:
 *   HELLO                                → OK DYNA-FISC/1 UNIQUE=<numer unikatowy> DATE=<YYYY-MM-DD> PTU=A:23,B:8,C:5,D:0,E:zw,F:-,G:-
 *   PTUCHECK A:23,B:8,…                  → OK | ERR PTU_MISMATCH
 *   QUERY <job id>                       → OK NONE | OK PRINTED <number> <YYYY-MM-DD>
 *   NIP <10 digits>                      → OK            (before OPEN; printed in the receipt header)
 *   OPEN <job id>                        → OK | ERR PAPER_OUT | ERR STATE | ERR DUPLICATE <number> <date>
 *   LINE <ptu> <qty> <unit> <gross> <base64url name>  → OK | ERR PTU_MISMATCH | ERR STATE
 *   PAY <form> <amount>                  → OK
 *   CLOSE <total>                        → OK RECEIPT <number> <YYYY-MM-DD> | ERR TOTAL_MISMATCH | ERR PAPER_OUT
 *   CANCEL                               → OK
 *   DAILY                                → OK REPORT <number> <YYYY-MM-DD> <count> <A:gross:vat,…> | ERR ALREADY <number>
 * Amounts are integer grosze. A device that does not answer (connection refused, closed or timed out) is
 * OFFLINE. The job id is the receipt id; QUERY makes a retry idempotent (a job already printed is never
 * printed again). */
import net from 'node:net';
import { PTU_LETTERS, PRINTER_ERRORS, type PaymentForm, type PrinterErrorCode, type PtuLetter, type PtuTable, type PtuValue } from './receipt233-model';

export const PRINTER_PROTOCOL = 'DYNA-FISC/1';
export const MODEL_FAMILIES = Object.freeze({ posnet: 'Posnet', elzab: 'Elzab', novitus: 'Novitus' } as const);
export type ModelFamily = keyof typeof MODEL_FAMILIES;
export const LOOPBACK_HOSTS = ['127.0.0.1', '::1', 'localhost'] as const;

export type PrinterStatus = { protocol: string; unique_number: string; fiscal_date: string; ptu: PtuTable };
export type PrintJob = {
  job_id: string; buyer_nip: string | null; ptu: PtuTable;
  lines: readonly { ptu: PtuLetter; quantity: number; unit_gross_minor: string; gross_minor: string; name: string }[];
  payment: { form: PaymentForm; amount_minor: string }; total_minor: string;
};
export type PrintedReceipt = { number: string; fiscal_date: string; already_printed: boolean };
export type DailyReportResult = { number: string; fiscal_date: string; receipts: number; totals: { ptu: PtuLetter; gross_minor: string; vat_minor: string }[] };
/** The port every fiscal printer driver implements. */
export interface FiscalPrinterDriver {
  status(): Promise<PrinterStatus>;
  query(jobId: string): Promise<{ number: string; fiscal_date: string } | null>;
  printReceipt(job: PrintJob): Promise<PrintedReceipt>;
  dailyReport(): Promise<DailyReportResult>;
}
/** A printer fault. The message is the Polish text of the code plus, at most, the app's own fixed detail; bytes
 * received from the peer never enter the message (they could be the banner of another local service) and are
 * kept in `peer` for the server log only. `already`: the number of a daily report the printer already printed.
 * `uncertain`: the printer may have printed the receipt (the answer was lost after OPEN), so the job is not failed. */
export class PrinterError extends Error {
  readonly peer: string | null;
  readonly already: string | null;
  readonly uncertain: boolean;
  constructor(public readonly code: PrinterErrorCode, detail?: string, extra: { peer?: string; already?: string; uncertain?: boolean } = {}) {
    super(PRINTER_ERRORS[code].message + (detail ? ` (${detail})` : ''));
    this.name = 'PrinterError'; this.peer = extra.peer ?? null; this.already = extra.already ?? null; this.uncertain = extra.uncertain ?? false;
  }
}
/** Server-side log of a printer fault: the code and, escaped and shortened, what the peer sent. */
export function logPrinterError(e: PrinterError, where: string): void {
  process.stderr.write(`[receipt233] ${where}: ${e.code}${e.peer === null ? '' : ' peer=' + JSON.stringify(e.peer.slice(0, 200))}\n`);
}

export const ptuWire = (t: PtuTable) => PTU_LETTERS.map(l => `${l}:${t[l] ?? '-'}`).join(',');
export function parsePtuWire(text: string): PtuTable | null {
  const parts = text.split(','), out: Partial<Record<PtuLetter, PtuValue>> = {};
  if (parts.length !== PTU_LETTERS.length) return null;
  for (const [i, p] of parts.entries()) {
    const m = /^([A-G]):(23|8|5|0|zw|-)$/.exec(p);
    if (!m || m[1] !== PTU_LETTERS[i]) return null;
    out[m[1] as PtuLetter] = m[2] === '-' ? null : m[2] as PtuValue;
  }
  return out as PtuTable;
}
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** One TCP conversation; every request gets one response line within `timeoutMs`. */
class Conversation {
  private buffer = '';
  private waiting: ((line: string | Error) => void) | null = null;
  private failure: Error | null = null;
  private constructor(private readonly socket: net.Socket, private readonly timeoutMs: number) {
    socket.setEncoding('utf8');
    socket.on('data', (d: string) => { this.buffer += d; this.flush(); });
    const fail = (e: Error) => { this.failure ??= e; const w = this.waiting; this.waiting = null; w?.(this.failure); };
    socket.on('error', e => fail(new PrinterError('OFFLINE', (e as NodeJS.ErrnoException).code ?? e.message)));
    socket.on('close', () => fail(new PrinterError('OFFLINE', 'połączenie zamknięte')));
  }
  static open(host: string, port: number, timeoutMs: number): Promise<Conversation> {
    return new Promise((resolve, reject) => {
      const s = net.createConnection({ host, port });
      const t = setTimeout(() => { s.destroy(); reject(new PrinterError('OFFLINE', 'brak połączenia')); }, timeoutMs);
      s.once('connect', () => { clearTimeout(t); s.removeAllListeners('error'); resolve(new Conversation(s, timeoutMs)); });
      s.once('error', e => { clearTimeout(t); reject(new PrinterError('OFFLINE', (e as NodeJS.ErrnoException).code ?? e.message)); });
    });
  }
  private flush() {
    const i = this.buffer.indexOf('\n');
    if (i < 0 || !this.waiting) return;
    const line = this.buffer.slice(0, i).replace(/\r$/, ''); this.buffer = this.buffer.slice(i + 1);
    const w = this.waiting; this.waiting = null; w(line);
  }
  request(line: string): Promise<string> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.waiting = null; reject(new PrinterError('OFFLINE', 'brak odpowiedzi')); }, this.timeoutMs);
      this.waiting = r => { clearTimeout(t); r instanceof Error ? reject(r) : resolve(r); };
      this.socket.write(line + '\n');
      this.flush();
    });
  }
  close() { this.socket.end(); this.socket.destroy(); }
}
function expectOk(line: string): string[] {
  const w = line.split(' ');
  if (w[0] === 'OK') return w.slice(1);
  if (w[0] === 'ERR') {
    const code = w[1] ?? '';
    if (code === 'PAPER_OUT' || code === 'PTU_MISMATCH' || code === 'TOTAL_MISMATCH' || code === 'OFFLINE') throw new PrinterError(code, undefined, { peer: line });
    if (code === 'ALREADY' && /^[0-9]{1,8}$/.test(w[2] ?? '') && w.length === 3) throw new PrinterError('PRINTER_ERROR', 'raport dobowy już wydrukowany', { already: w[2]! });
    throw new PrinterError('PRINTER_ERROR', undefined, { peer: line });
  }
  throw new PrinterError('PROTOCOL', undefined, { peer: line });
}
const nameWire = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

/** DYNA-FISC/1 driver of a printer at a loopback host:port. */
export function simplifiedProtocolDriver(cfg: { host: string; port: number; timeout_ms?: number }): FiscalPrinterDriver {
  if (!(LOOPBACK_HOSTS as readonly string[]).includes(cfg.host)) throw new PrinterError('PROTOCOL', 'drukarka musi być pod adresem lokalnym (loopback)');
  const timeout = cfg.timeout_ms ?? 5000;
  const run = async <T>(fn: (c: Conversation) => Promise<T>): Promise<T> => {
    const c = await Conversation.open(cfg.host, cfg.port, timeout);
    try { return await fn(c); } finally { c.close(); }
  };
  const hello = async (c: Conversation): Promise<PrinterStatus> => {
    const line = await c.request('HELLO'), m = /^OK (\S+) UNIQUE=([A-Z]{3}[0-9]{8}) DATE=(\d{4}-\d{2}-\d{2}) PTU=(\S+)$/.exec(line);
    if (!m || m[1] !== PRINTER_PROTOCOL) throw new PrinterError('PROTOCOL', undefined, { peer: line });
    const ptu = parsePtuWire(m[4]!);
    if (!ptu) throw new PrinterError('PROTOCOL', 'tabela PTU');
    return { protocol: m[1], unique_number: m[2]!, fiscal_date: m[3]!, ptu };
  };
  const query = async (c: Conversation, jobId: string) => {
    const w = expectOk(await c.request('QUERY ' + jobId));
    if (w[0] === 'NONE') return null;
    if (w[0] === 'PRINTED' && /^[0-9]{1,8}$/.test(w[1] ?? '') && DAY.test(w[2] ?? '')) return { number: w[1]!, fiscal_date: w[2]! };
    throw new PrinterError('PROTOCOL', 'QUERY');
  };
  return {
    status: () => run(hello),
    query: jobId => run(c => query(c, jobId)),
    printReceipt: job => run(async c => {
      await hello(c);
      expectOk(await c.request('PTUCHECK ' + ptuWire(job.ptu)));
      const done = await query(c, job.job_id);
      if (done) return { ...done, already_printed: true };
      if (job.buyer_nip) expectOk(await c.request('NIP ' + job.buyer_nip));
      expectOk(await c.request('OPEN ' + job.job_id));
      try {
        for (const l of job.lines) expectOk(await c.request(`LINE ${l.ptu} ${l.quantity} ${l.unit_gross_minor} ${l.gross_minor} ${nameWire(l.name)}`));
        expectOk(await c.request(`PAY ${job.payment.form} ${job.payment.amount_minor}`));
        const w = expectOk(await c.request('CLOSE ' + job.total_minor));
        if (w[0] !== 'RECEIPT' || !/^[0-9]{1,8}$/.test(w[1] ?? '') || !DAY.test(w[2] ?? '')) throw new PrinterError('PROTOCOL', 'CLOSE');
        return { number: w[1]!, fiscal_date: w[2]!, already_printed: false };
      } catch (e) {
        // An open receipt is cancelled on the printer. A lost connection or answer after OPEN is uncertain: the
        // printer may have closed (printed) the receipt, so only a later QUERY tells the outcome.
        if (e instanceof PrinterError && e.code === 'OFFLINE') throw new PrinterError('OFFLINE', 'odpowiedź utracona po otwarciu paragonu', { peer: e.peer ?? undefined, uncertain: true });
        await c.request('CANCEL').catch(() => undefined);
        throw e;
      }
    }),
    dailyReport: () => run(async c => {
      await hello(c);
      const w = expectOk(await c.request('DAILY'));
      const totals = (w[4] ?? '').split(',').filter(Boolean).map(x => {
        const m = /^([A-G]):(\d{1,12}):(\d{1,12})$/.exec(x);
        if (!m) throw new PrinterError('PROTOCOL', 'DAILY');
        return { ptu: m[1] as PtuLetter, gross_minor: m[2]!, vat_minor: m[3]! };
      });
      if (w[0] !== 'REPORT' || !/^[0-9]{1,8}$/.test(w[1] ?? '') || !DAY.test(w[2] ?? '') || !/^\d{1,8}$/.test(w[3] ?? '')) throw new PrinterError('PROTOCOL', 'DAILY');
      return { number: w[1]!, fiscal_date: w[2]!, receipts: Number(w[3]), totals };
    }),
  };
}
/** The driver of a configured printer (every family is served by DYNA-FISC/1 in this version). */
export function fiscalPrinterDriver(cfg: { model_family: ModelFamily; host: string; port: number }, timeoutMs?: number): FiscalPrinterDriver {
  return simplifiedProtocolDriver({ host: cfg.host, port: cfg.port, timeout_ms: timeoutMs });
}

export type PrintOutcome = { ok: true; receipt: PrintedReceipt } | { ok: false; code: PrinterErrorCode; message: string; uncertain: boolean };
/** One print attempt as the job runner records it: the printed receipt or the printer error (never throws for a printer fault). */
export async function attemptPrint(driver: FiscalPrinterDriver, job: PrintJob): Promise<PrintOutcome> {
  try { return { ok: true, receipt: await driver.printReceipt(job) }; }
  catch (e) {
    if (e instanceof PrinterError) { logPrinterError(e, 'print'); return { ok: false, code: e.code, message: e.message, uncertain: e.uncertain }; }
    return { ok: false, code: 'PRINTER_ERROR', message: PRINTER_ERRORS.PRINTER_ERROR.message, uncertain: false };
  }
}
