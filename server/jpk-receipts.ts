/** Cash-register sales (233) in JPK_V7: one summary row `RO` per daily fiscal report (raport dobowy) of
 * the period, built from the printer's own totals per PTU letter. The rate of a letter is the value the
 * printer had for it that day (the PTU table in the snapshots of that day's receipts, else the printer's
 * current table). A daily report that does not agree with the app's receipts ("niezgodny"), printed
 * receipts of a day without a daily report, or a letter with two rates in one day refuse the file (409)
 * with the list. The invoice issued to a receipt is marked `FP` by the V7 renderer (jpk-v7.ts).
 * Pure apart from `listJpkReceiptSalesInTx` (read-only, RLS + explicit tenant filter). */
import type { PoolClient } from 'pg';
import { JpkError, type JpkRefusal } from './jpk-model';

export type JpkPtuValue = '23' | '8' | '5' | '0' | 'zw';
/** One stored daily report with its totals per PTU letter (gross and VAT computed by the printer). */
export type JpkDailyReport = {
  id: string; printer_unique_number: string; fiscal_date: string; report_number: string; matches: boolean;
  printer_receipts: number; app_receipts: number;
  totals: { ptu: string; value: JpkPtuValue | null; conflict: boolean; gross_minor: bigint; vat_minor: bigint }[];
};
/** Printed receipts of a printer and day that have no daily report. */
export type JpkUnreportedDay = { printer_unique_number: string; fiscal_date: string; receipts: number };
export type JpkReceiptSales = { reports: JpkDailyReport[]; unreported: JpkUnreportedDay[] };
export const NO_RECEIPT_SALES: JpkReceiptSales = Object.freeze({ reports: [], unreported: [] }) as JpkReceiptSales;

/** K_ fields of a PTU rate: net, VAT (none for 0% and zw). */
export const RO_K_OF: Record<JpkPtuValue, { net: 'K_10' | 'K_13' | 'K_15' | 'K_17' | 'K_19'; vat: 'K_16' | 'K_18' | 'K_20' | null }> = {
  '23': { net: 'K_19', vat: 'K_20' }, '8': { net: 'K_17', vat: 'K_18' }, '5': { net: 'K_15', vat: 'K_16' }, '0': { net: 'K_13', vat: null }, 'zw': { net: 'K_10', vat: null },
};
/** DowodSprzedazy of the RO row: the register's unique number and the report number (unique in its fiscal memory). */
export const roNumber = (r: Pick<JpkDailyReport, 'printer_unique_number' | 'report_number'>) => `RO/${r.printer_unique_number}/${r.report_number}`;

/** The reports and days of `period` (YYYY-MM or a list of months); refuses the whole set when any cannot be expressed. */
export function checkedReceiptSales(sales: JpkReceiptSales, months: readonly string[]): JpkDailyReport[] {
  const inside = (d: string) => months.includes(d.slice(0, 7)), refusals: JpkRefusal[] = [];
  const reports = sales.reports.filter(r => inside(r.fiscal_date));
  for (const r of reports) {
    const n = `Raport dobowy ${r.report_number} z ${r.fiscal_date}, kasa ${r.printer_unique_number}`;
    if (!r.matches) refusals.push({ number: n, reason: `Raport niezgodny z paragonami aplikacji (kasa: ${r.printer_receipts} paragonów, aplikacja: ${r.app_receipts}) — wyjaśnij różnicę przed złożeniem JPK_V7` });
    for (const t of r.totals) {
      if (t.conflict) refusals.push({ number: n, reason: `Litera PTU ${t.ptu} miała tego dnia dwie różne stawki` });
      else if (t.value === null) refusals.push({ number: n, reason: `Litera PTU ${t.ptu} nie ma stawki w tablicy PTU kasy` });
      else if (t.gross_minor < 0n || t.vat_minor < 0n || t.vat_minor > t.gross_minor || (RO_K_OF[t.value].vat === null && t.vat_minor !== 0n))
        refusals.push({ number: n, reason: `Niepoprawne sumy PTU ${t.ptu} w raporcie dobowym` });
    }
  }
  for (const u of sales.unreported.filter(x => inside(x.fiscal_date)))
    refusals.push({ number: `Paragony z ${u.fiscal_date}, kasa ${u.printer_unique_number}`, reason: `${u.receipts} wydrukowanych paragonów bez raportu dobowego — wydrukuj raport dobowy` });
  if (refusals.length) throw new JpkError(409, 'Sprzedaży z kasy fiskalnej za okres nie da się ująć w JPK_V7', refusals);
  return reports;
}

const VALUES = new Set<string>(['23', '8', '5', '0', 'zw']);
/** Daily reports with fiscal dates in [from, to], the PTU rate of each letter, and the unreported days. */
export async function listJpkReceiptSalesInTx(c: PoolClient, tenantId: string, from: string, to: string): Promise<JpkReceiptSales> {
  const present = (await c.query(`SELECT to_regclass('public.receipt233_daily_reports') IS NOT NULL AND to_regclass('public.receipt233_receipts') IS NOT NULL
    AND to_regclass('public.receipt233_printers') IS NOT NULL AS p`)).rows[0].p;
  if (!present) return { reports: [], unreported: [] };
  const rows = (await c.query(`SELECT d.id,d.printer_unique_number,to_char(d.fiscal_date,'YYYY-MM-DD') fiscal_date,d.report_number,d.matches,d.printer_receipts,d.app_receipts,
      d.printer_totals,p.ptu printer_ptu,
      (SELECT coalesce(jsonb_agg(DISTINCT jsonb_build_object('ptu',t->>'ptu','value',t->>'value')),'[]'::jsonb) FROM receipt233_receipts r, jsonb_array_elements(r.snapshot->'ptu_totals') t
        WHERE r.tenant_id=d.tenant_id AND r.printer_id=d.printer_id AND r.state='printed' AND r.fiscal_date=d.fiscal_date) receipt_ptu
     FROM receipt233_daily_reports d JOIN receipt233_printers p ON (p.tenant_id,p.id)=(d.tenant_id,d.printer_id)
     WHERE d.tenant_id=$1 AND d.fiscal_date BETWEEN $2::date AND $3::date ORDER BY d.fiscal_date,d.printer_unique_number,d.report_number`, [tenantId, from, to])).rows;
  const reports = rows.map((r): JpkDailyReport => ({
    id: r.id, printer_unique_number: r.printer_unique_number, fiscal_date: r.fiscal_date, report_number: r.report_number, matches: r.matches,
    printer_receipts: r.printer_receipts, app_receipts: r.app_receipts,
    totals: (r.printer_totals as { ptu: string; gross_minor: string; vat_minor: string }[]).map(t => {
      const seen = [...new Set((r.receipt_ptu as { ptu: string; value: string }[]).filter(x => x.ptu === t.ptu).map(x => x.value))];
      const own = seen.length ? seen : [r.printer_ptu?.[t.ptu]].filter((v): v is string => typeof v === 'string');
      return { ptu: t.ptu, value: own.length === 1 && VALUES.has(own[0]!) ? own[0] as JpkPtuValue : null, conflict: own.length > 1,
        gross_minor: BigInt(t.gross_minor), vat_minor: BigInt(t.vat_minor) };
    }),
  }));
  const unreported = (await c.query(`SELECT r.printer_unique_number,to_char(r.fiscal_date,'YYYY-MM-DD') fiscal_date,count(*)::int receipts FROM receipt233_receipts r
     WHERE r.tenant_id=$1 AND r.state='printed' AND r.fiscal_date BETWEEN $2::date AND $3::date
     AND NOT EXISTS(SELECT 1 FROM receipt233_daily_reports d WHERE (d.tenant_id,d.printer_id,d.fiscal_date)=(r.tenant_id,r.printer_id,r.fiscal_date))
     GROUP BY 1,2 ORDER BY 2,1`, [tenantId, from, to])).rows as JpkUnreportedDay[];
  return { reports, unreported };
}
