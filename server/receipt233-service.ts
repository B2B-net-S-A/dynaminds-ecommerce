/** Request-level fiscal receipt operations (233). Each database step runs in the identity frame of the
 * native FV (session or API key, role, MFA; writes need admin/operator and documents:write; the printer
 * configuration needs admin) in its own tenant transaction; the printer is spoken to between them, so a
 * slow or offline printer never holds a transaction open. Printer I/O is serialized per printer in
 * this process. */
import { z } from 'zod';
import type { LocalInvoiceActor } from './local-invoice-values';
import { taxInvoiceFlags, taxInvoiceTransaction } from './tax226-local-invoices';
import { ensure, Problem } from './errors';
import { receiptRequest, samePtuTable } from './receipt233-model';
import { attemptPrint, fiscalPrinterDriver, logPrinterError, PrinterError, type FiscalPrinterDriver, type ModelFamily } from './receipt233-printer';
import {
  activePrinterInTx, claimReceiptInTx, dailyReportOfInTx, dailyReportsInTx, orderReceiptInTx, printerInput, printersInTx, receiptCalculationInTx, receiptInTx,
  receiptRegisterInTx, recordReceiptOutcomeInTx, requireReceipt233, savePrinterInTx, storeDailyReportInTx, storeReceiptInTx,
} from './receipt233';

export type DriverFactory = (cfg: { model_family: ModelFamily; host: string; port: number }) => FiscalPrinterDriver;
let driverFactory: DriverFactory = cfg => fiscalPrinterDriver(cfg);
/** Tests replace the driver (e.g. a shorter timeout); production uses the DYNA-FISC/1 driver of the config. */
export function setReceipt233DriverFactory(f: DriverFactory | null): void { driverFactory = f ?? (cfg => fiscalPrinterDriver(cfg)); }
const queues = new Map<string, Promise<unknown>>();
function serialized<T>(printerId: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(printerId) ?? Promise.resolve(), next = prev.catch(() => undefined).then(fn);
  queues.set(printerId, next);
  void next.finally(() => { if (queues.get(printerId) === next) queues.delete(printerId); }).catch(() => undefined);
  return next;
}
const flags = async (c: Parameters<typeof taxInvoiceFlags>[0], a: LocalInvoiceActor, w: boolean) => {
  const f = await taxInvoiceFlags(c, a, w);
  return { ...f, can_configure: f.can_write && f.current_role === 'admin' };
};

/** Order view: the receipt (or what it would be and why it cannot be printed), the active printer. */
export async function receipt233OrderState(a: LocalInvoiceActor, orderId: string, q: { payment_form?: string; buyer_nip?: string; shipping_vat?: string }) {
  const b = z.strictObject({ payment_form: receiptRequest.shape.payment_form.optional(), buyer_nip: receiptRequest.shape.buyer_nip.optional(),
    shipping_vat: z.enum(['0', '5', '8', '23']).transform(Number).optional() }).parse(q);
  return taxInvoiceTransaction(a, false, async c => {
    await requireReceipt233(c);
    const receipt = await orderReceiptInTx(c, orderId), printer = await activePrinterInTx(c);
    const calc = receipt ? null : await receiptCalculationInTx(c, orderId, b as never);
    return { ...(await flags(c, a, false)), printer, receipt, calculation: calc ? { snapshot: calc.snapshot, blockers: calc.blockers, printable: !calc.blockers.length && Boolean(calc.snapshot) } : null };
  });
}
async function printNow(a: LocalInvoiceActor, id: string, retry: boolean) {
  const claim = await taxInvoiceTransaction(a, true, c => claimReceiptInTx(c, a, id, retry));
  if (claim) {
    const outcome = await serialized(claim.printer.id, () => attemptPrint(driverFactory(claim.printer), claim.job));
    await taxInvoiceTransaction(a, true, c => recordReceiptOutcomeInTx(c, a, id, outcome));
  }
  return taxInvoiceTransaction(a, false, async c => ({ ...(await flags(c, a, false)), receipt: await receiptInTx(c, id) }));
}
/** Confirmed receipt of an order: stored queued, then printed at once. A replay of the same client_key
 * returns its job; a job not yet printed is attempted again. */
export async function receipt233Print(a: LocalInvoiceActor, orderId: string, input: unknown) {
  const b = receiptRequest.parse(input);
  const r = await taxInvoiceTransaction(a, true, c => storeReceiptInTx(c, a, orderId, b));
  const v = await printNow(a, r.id, r.reused);
  return { ...v, reused: r.reused };
}
export async function receipt233Retry(a: LocalInvoiceActor, id: string, input: unknown) {
  z.strictObject({ confirmed: z.literal(true, 'Potwierdź ponowienie druku paragonu') }).parse(input);
  return printNow(a, id, true);
}
export async function receipt233Detail(a: LocalInvoiceActor, id: string) {
  return taxInvoiceTransaction(a, false, async c => { await requireReceipt233(c); return { ...(await flags(c, a, false)), receipt: await receiptInTx(c, id) }; });
}
export async function receipt233Register(a: LocalInvoiceActor, f: { order_id?: string; fiscal_date?: string }) {
  return taxInvoiceTransaction(a, false, async c => { await requireReceipt233(c); return { ...(await flags(c, a, false)), data: await receiptRegisterInTx(c, f) }; });
}

export async function receipt233Printer(a: LocalInvoiceActor) {
  return taxInvoiceTransaction(a, false, async c => { await requireReceipt233(c); return { ...(await flags(c, a, false)), printer: await activePrinterInTx(c), printers: await printersInTx(c) }; });
}
export async function receipt233SavePrinter(a: LocalInvoiceActor, input: unknown) {
  return taxInvoiceTransaction(a, true, async c => {
    const f = await flags(c, a, true);
    ensure(f.can_configure, 403, 'Konfigurację drukarki fiskalnej zmienia administrator');
    const printer = await savePrinterInTx(c, a, input);
    return { ...f, printer, printers: await printersInTx(c) };
  });
}
/** Connection test of the saved active printer (any reading role), or of a configuration being edited (admin only, as
 * saving it: a draft names an arbitrary loopback port). HELLO, the unique number and the PTU table; peer bytes are never returned. */
export async function receipt233TestPrinter(a: LocalInvoiceActor, input: unknown) {
  const draft = input && typeof input === 'object' && Object.keys(input).length ? printerInput.parse(input) : null;
  const cfg = await taxInvoiceTransaction(a, draft !== null, async c => {
    await requireReceipt233(c);
    if (draft) ensure((await flags(c, a, true)).can_configure, 403, 'Konfigurację drukarki fiskalnej sprawdza i zmienia administrator');
    const p = draft ?? await activePrinterInTx(c);
    ensure(p, 409, 'Brak aktywnej drukarki fiskalnej do sprawdzenia');
    return { id: (p as { id?: string }).id ?? 'draft:' + p.host + ':' + p.port, model_family: p.model_family, host: p.host, port: p.port, unique_number: p.unique_number, ptu: p.ptu };
  });
  try {
    const s = await serialized(cfg.id, () => driverFactory(cfg).status());
    const problems = [...(s.unique_number !== cfg.unique_number ? [`Drukarka zgłasza numer unikatowy ${s.unique_number}, a konfiguracja ${cfg.unique_number}`] : []),
      ...(!samePtuTable(s.ptu, cfg.ptu) ? ['Stawki PTU w drukarce nie zgadzają się z konfiguracją'] : [])];
    return { ok: problems.length === 0, status: s, problems };
  } catch (e) {
    if (e instanceof PrinterError) { logPrinterError(e, 'test'); return { ok: false, status: null, problems: [e.message], code: e.code }; }
    throw e;
  }
}
/** Daily fiscal report: printed on the active printer and stored with the app's sums of that day. */
export async function receipt233DailyReport(a: LocalInvoiceActor, input: unknown) {
  z.strictObject({ confirmed: z.literal(true, 'Potwierdź wydruk raportu dobowego') }).parse(input);
  const printer = await taxInvoiceTransaction(a, true, async c => {
    await requireReceipt233(c);
    const p = await activePrinterInTx(c);
    ensure(p, 409, 'Brak aktywnej drukarki fiskalnej');
    return p;
  });
  const driver = driverFactory(printer);
  let rep;
  try { rep = await serialized(printer.id, () => driver.dailyReport()); }
  catch (e) {
    if (!(e instanceof PrinterError)) throw e;
    logPrinterError(e, 'daily');
    if (e.already !== null) {
      const day = (await serialized(printer.id, () => driver.status())).fiscal_date;
      const old = await taxInvoiceTransaction(a, false, c => dailyReportOfInTx(c, printer.id, day));
      ensure(old, 409, `Raport dobowy za ${day} został już wydrukowany na drukarce, ale nie ma go w aplikacji — przepisz go z wydruku`);
      return taxInvoiceTransaction(a, false, async c => ({ ...(await flags(c, a, false)), report: old, reused: true }));
    }
    throw new Problem(e.code === 'OFFLINE' || e.code === 'PAPER_OUT' ? 503 : 502, e.message);
  }
  return taxInvoiceTransaction(a, true, async c => {
    const old = await dailyReportOfInTx(c, printer.id, rep.fiscal_date);
    ensure(!old, 409, `Raport dobowy za ${rep.fiscal_date} jest już zapisany`);
    return { ...(await flags(c, a, true)), report: await storeDailyReportInTx(c, a, printer, rep), reused: false };
  });
}
export async function receipt233DailyReports(a: LocalInvoiceActor) {
  return taxInvoiceTransaction(a, false, async c => { await requireReceipt233(c); return { ...(await flags(c, a, false)), data: await dailyReportsInTx(c) }; });
}
