// Local fakes for the stage-3 rehearsal (loopback only): fiscal printer 233, KSeF 229 send + 243 purchase
// (one purchase fake; it forwards 229 routes to its inner fake), plus a loopback control port:
//   GET /date?d=YYYY-MM-DD, GET /ksef-mode?m=ok|unavailable|reject, POST /purchase {number,date,gross?,buyer,seller?,kind?,korRefs?,permanentStorageDate?}, GET /stats
// usage (from the repo): node node_modules/tsx/dist/cli.mjs tools/parity/stage3-fakes.mts <printer port> <ksef port> <control port>
// The fiscal printer port must be the control port - 2 (stage3-acceptance.mjs configures the printer that way).
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
const REPO = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const { startFakeFiscalPrinter } = await import(REPO + '/server/receipt233-fake-printer.ts');
const { startFakeKsefPurchase } = await import(REPO + '/server/ksef229-fake-purchase.ts');
const { receivedFa3 } = await import(REPO + '/tests/ksef-purchase-fixtures.ts');
const [pp, kp, cp] = process.argv.slice(2).map(Number);
const printer = await startFakeFiscalPrinter({ port: pp, unique_number: 'DYN23300227' });
const ksef = await startFakeKsefPurchase({ port: kp });
createServer(async (req, res) => {
  const u = new URL(req.url!, 'http://x');
  try {
    if (u.pathname === '/date') printer.setDate(u.searchParams.get('d')!);
    else if (u.pathname === '/ksef-mode') ksef.inner.setMode(u.searchParams.get('m') as never);
    else if (u.pathname === '/purchase') {
      let b = ''; for await (const c of req) b += c;
      const o = JSON.parse(b);
      const at = new Date(o.permanentStorageDate);
      const r = ksef.addReceivedInvoice({ xml: receivedFa3({ number: o.number, date: o.date, gross: o.gross, buyer: o.buyer, seller: o.seller, kind: o.kind, korRefs: o.korRefs }),
        permanentStorageDate: at, invoicingDate: at, issueDate: o.date });
      res.end(JSON.stringify({ ok: true, ksef_number: r.ksefNumber, hash: r.hash, gross: r.gross, net: r.net, vat: r.vat,
        xml_sha256: createHash('sha256').update(r.xml).digest('hex') })); return;
    } else if (u.pathname !== '/stats') throw new Error('unknown');
    res.end(JSON.stringify({ ok: true, printer_receipts: printer.receipts.length, reports: printer.reports.length, ksef: ksef.inner.stats(), ksef_invoices: ksef.inner.invoices().length,
      purchase_received: ksef.received().length, ksef_url: ksef.url }));
  } catch (e) { res.statusCode = 400; res.end(String((e as Error)?.stack ?? e)); }
}).listen(cp, '127.0.0.1', () => console.log(JSON.stringify({ printer: printer.port, ksef: ksef.url, control: cp })));
