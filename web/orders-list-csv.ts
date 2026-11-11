/**
 * CSV export of the selected orders, built in the browser from the list rows (Uwagi v3 §3):
 * Polish headers, `;` separator, CRLF, UTF-8 BOM so Excel opens Polish characters correctly.
 */
import { fulfilmentLabel, paymentLabels, type PaymentState } from './order-stage';

export interface OrderCsvRow {
  number: string;
  created_at: string;
  source: string;
  external_id?: string | null;
  customer_name: string;
  email?: string | null;
  address?: { phone?: string; city?: string; postal_code?: string; country?: string; street?: string } | null;
  first_item_name?: string | null;
  line_count?: number | null;
  quantity_total?: number | null;
  status: string;
  fulfilment_stage?: string | null;
  payment_state?: PaymentState | null;
  total: number | string;
  shipping_cost?: number | string | null;
  currency: string;
  note?: string | null;
}

const HEADERS = [
  'Numer zamówienia',
  'Data dodania',
  'Kanał sprzedaży',
  'Zewnętrzne ID',
  'Klient',
  'E-mail',
  'Telefon',
  'Ulica',
  'Kod pocztowy',
  'Miasto',
  'Kraj',
  'Produkty',
  'Liczba pozycji',
  'Liczba sztuk',
  'Status',
  'Płatność',
  'Wartość',
  'Koszt wysyłki',
  'Waluta',
  'Notatka',
];

/** Minor units → "1234,50" (decimal comma, no thousands separator, so spreadsheets read a number). */
export const csvAmount = (minor: number | string | null | undefined) => {
  const n = Number(minor ?? 0);
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(Math.round(n));
  return `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')}`;
};

const csvDate = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const parts = new Intl.DateTimeFormat('pl-PL', {
    timeZone: 'Europe/Warsaw',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(d);
  const p = (t: string) => parts.find((x) => x.type === t)?.value ?? '';
  return `${p('year')}-${p('month')}-${p('day')} ${p('hour')}:${p('minute')}`;
};

/** Quotes a cell when needed; a leading = + - @ is prefixed with ' so a spreadsheet does not run it as a formula. */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[";\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function ordersCsv(rows: OrderCsvRow[], sourceLabel: (source: string) => string = (s) => s): string {
  const lines = rows.map((o) =>
    [
      o.number,
      csvDate(o.created_at),
      sourceLabel(o.source),
      o.external_id ?? '',
      o.customer_name,
      o.email ?? '',
      o.address?.phone ?? '',
      o.address?.street ?? '',
      o.address?.postal_code ?? '',
      o.address?.city ?? '',
      o.address?.country ?? '',
      o.first_item_name ?? '',
      o.line_count ?? 0,
      o.quantity_total ?? 0,
      fulfilmentLabel(o.fulfilment_stage ?? o.status),
      o.payment_state ? paymentLabels[o.payment_state] : '',
      csvAmount(o.total),
      csvAmount(o.shipping_cost),
      o.currency,
      o.note ?? '',
    ]
      .map(csvCell)
      .join(';'),
  );
  return '﻿' + [HEADERS.join(';'), ...lines].join('\r\n') + '\r\n';
}

/** Saves the CSV through a temporary link; the file name carries the local date. */
export function downloadOrdersCsv(csv: string, now = new Date()): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `zamowienia-${now.toLocaleDateString('sv-SE')}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
