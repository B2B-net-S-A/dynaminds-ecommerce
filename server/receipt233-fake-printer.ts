/** Local fake fiscal printer speaking DYNA-FISC/1 (see receipt233-printer.ts) on a loopback port, for
 * tests and the local browser check. No hardware. It keeps its own fiscal memory (receipts per job id,
 * the daily report per fiscal date), computes VAT per PTU total as a cash register does, and can be
 * told to fail: `paper_out` (OPEN/CLOSE answer ERR PAPER_OUT), `offline` (the connection is closed
 * without an answer) or a PTU table that differs from the configuration. The test control command
 * `FAULT PAPER_OUT|OFFLINE|NONE` does the same over the wire. */
import net from 'node:net';
import { grossLineAmounts } from './invoice230-model';
import { DEFAULT_PTU_TABLE, PTU_LETTERS, type PtuLetter, type PtuTable } from './receipt233-model';
import { PRINTER_PROTOCOL, parsePtuWire, ptuWire } from './receipt233-printer';

export type FakeFault = 'paper_out' | 'offline' | null;
export type FakeReceipt = { job_id: string; number: string; fiscal_date: string; nip: string | null; total_minor: bigint; payment: string;
  lines: { ptu: PtuLetter; quantity: number; unit_gross_minor: bigint; gross_minor: bigint; name: string }[] };
export type FakePrinter = {
  port: number; unique_number: string; receipts: FakeReceipt[]; reports: { number: string; fiscal_date: string }[];
  setFault(f: FakeFault): void; setPtu(t: PtuTable): void; setDate(d: string): void; close(): Promise<void>;
};
const warsawToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(new Date());

export function startFakeFiscalPrinter(o: { port?: number; unique_number?: string; ptu?: PtuTable; fiscal_date?: string } = {}): Promise<FakePrinter> {
  const unique = o.unique_number ?? 'DYN12345678';
  let fault: FakeFault = null, ptu: PtuTable = o.ptu ?? DEFAULT_PTU_TABLE, date: string | null = o.fiscal_date ?? null;
  const receipts: FakeReceipt[] = [], reports: { number: string; fiscal_date: string; count: number; totals: string }[] = [];
  const today = () => date ?? warsawToday();
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.setEncoding('utf8');
    let buffer = '', nip: string | null = null, open: Omit<FakeReceipt, 'number' | 'fiscal_date' | 'total_minor'> | null = null;
    const answer = (line: string): string | null => {
      const [cmd = '', ...a] = line.split(' ');
      if (cmd === 'FAULT') { fault = a[0] === 'PAPER_OUT' ? 'paper_out' : a[0] === 'OFFLINE' ? 'offline' : null; return 'OK'; }
      if (fault === 'offline') return null;
      switch (cmd) {
        case 'HELLO': return `OK ${PRINTER_PROTOCOL} UNIQUE=${unique} DATE=${today()} PTU=${ptuWire(ptu)}`;
        case 'PTUCHECK': { const t = parsePtuWire(a[0] ?? ''); return t && PTU_LETTERS.every(l => t[l] === ptu[l]) ? 'OK' : 'ERR PTU_MISMATCH'; }
        case 'QUERY': { const r = receipts.find(x => x.job_id === a[0]); return r ? `OK PRINTED ${r.number} ${r.fiscal_date}` : 'OK NONE'; }
        case 'NIP': if (open || !/^\d{10}$/.test(a[0] ?? '')) return 'ERR STATE'; nip = a[0]!; return 'OK';
        case 'OPEN': {
          if (open || !a[0]) return 'ERR STATE';
          const dup = receipts.find(x => x.job_id === a[0]);
          if (dup) return `ERR DUPLICATE ${dup.number} ${dup.fiscal_date}`;
          if (fault === 'paper_out') return 'ERR PAPER_OUT';
          open = { job_id: a[0], nip, payment: '', lines: [] }; nip = null; return 'OK';
        }
        case 'LINE': {
          if (!open) return 'ERR STATE';
          const [letter, q, unit, gross, name] = a;
          if (!PTU_LETTERS.includes(letter as PtuLetter) || ptu[letter as PtuLetter] === null) return 'ERR PTU_MISMATCH';
          if (!/^\d{1,6}$/.test(q ?? '') || !/^\d{1,12}$/.test(unit ?? '') || !/^\d{1,12}$/.test(gross ?? '') || !name) return 'ERR STATE';
          open.lines.push({ ptu: letter as PtuLetter, quantity: Number(q), unit_gross_minor: BigInt(unit!), gross_minor: BigInt(gross!), name: Buffer.from(name, 'base64url').toString('utf8') });
          return 'OK';
        }
        case 'PAY': if (!open || !a[0] || !/^\d{1,12}$/.test(a[1] ?? '')) return 'ERR STATE'; open.payment = `${a[0]} ${a[1]}`; return 'OK';
        case 'CLOSE': {
          if (!open) return 'ERR STATE';
          const total = open.lines.reduce((s, l) => s + l.gross_minor, 0n);
          if (String(total) !== a[0]) { open = null; return 'ERR TOTAL_MISMATCH'; }
          if (fault === 'paper_out') { open = null; return 'ERR PAPER_OUT'; }
          const r: FakeReceipt = { ...open, total_minor: total, number: String(receipts.length + 1).padStart(6, '0'), fiscal_date: today() };
          receipts.push(r); open = null;
          return `OK RECEIPT ${r.number} ${r.fiscal_date}`;
        }
        case 'CANCEL': open = null; return 'OK';
        case 'DAILY': {
          const d = today(), old = reports.find(r => r.fiscal_date === d);
          if (old) return `ERR ALREADY ${old.number}`;
          const day = receipts.filter(r => r.fiscal_date === d), sums = new Map<PtuLetter, bigint>();
          for (const r of day) for (const l of r.lines) sums.set(l.ptu, (sums.get(l.ptu) ?? 0n) + l.gross_minor);
          // A cash register computes VAT on the PTU total of the day.
          const totals = PTU_LETTERS.filter(l => sums.has(l)).map(l => {
            const v = ptu[l], g = sums.get(l)!;
            return `${l}:${g}:${v === null || v === 'zw' || v === '0' ? 0n : grossLineAmounts(g, v).vat}`;
          }).join(',');
          const rep = { number: String(reports.length + 1).padStart(4, '0'), fiscal_date: d, count: day.length, totals };
          reports.push(rep);
          return `OK REPORT ${rep.number} ${d} ${rep.count} ${totals}`;
        }
        default: return 'ERR UNKNOWN';
      }
    };
    socket.on('data', (d: string) => {
      buffer += d;
      for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
        const line = buffer.slice(0, i).replace(/\r$/, ''); buffer = buffer.slice(i + 1);
        const r = answer(line);
        if (r === null) { socket.destroy(); return; }
        socket.write(r + '\n');
      }
    });
    socket.on('error', () => undefined);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port ?? 0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({
        port, unique_number: unique, receipts, reports,
        setFault: f => { fault = f; }, setPtu: t => { ptu = t; }, setDate: d => { date = d; },
        close: () => new Promise(r => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
      });
    });
  });
}
