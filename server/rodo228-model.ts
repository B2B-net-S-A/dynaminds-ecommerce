/** 228 RODO rules without a database: who the customer is (normalised e-mail/phone and its
 * keyed hash), how long tax documents keep the buyer data (art. 112 ustawy o VAT with
 * art. 70 § 1 Ordynacji podatkowej), how long immutable evidence is kept (art. 118 KC),
 * which fields are anonymised and which are kept, the refusal for open business, the
 * JSON scrub of known personal values and the export bundle (JSON + CSV in one ZIP). */
import { createHmac } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { z } from 'zod';
import { Problem } from './errors';

export const ANON_NAME = 'Klient zanonimizowany';
export const ANON_TEXT = 'zanonimizowano';
export const ANON_STREET = 'Zanonimizowano';
export const ANON_POSTAL = '00-000';
export const anonEmail = (orderId: string) => `anonim-${orderId.slice(0, 8)}@anonim.invalid`;
export const isAnonEmail = (v: unknown) => typeof v === 'string' && /^anonim-[0-9a-f]{8}@anonim\.invalid$/.test(v);

/** Orders in these states are still being fulfilled or settled. */
export const CLOSED_ORDER_STATUSES = ['delivered', 'completed', 'cancelled', 'return_completed'] as const;
export const OPEN_RETURN_STATES = ['requested', 'refund_pending'] as const;

export const LEGAL_BASIS = {
  tax_retention: 'art. 112 ustawy o VAT w zw. z art. 70 § 1 Ordynacji podatkowej — przechowywanie faktur i danych nabywcy do upływu terminu przedawnienia zobowiązania podatkowego (art. 6 ust. 1 lit. c RODO)',
  immutable_evidence: 'art. 6 ust. 1 lit. c i f RODO — niezmienny zapis dowodowy realizacji umowy (art. 118 KC: przedawnienie roszczeń, 6 lat, koniec roku); do anonimizacji po terminie',
} as const;
export type KeepBasis = keyof typeof LEGAL_BASIS;

export const subjectInput = z.union([
  z.strictObject({ crm_client_id: z.uuid('Nieprawidłowy identyfikator klienta CRM').transform(v => v.toLowerCase()) }),
  z.strictObject({ email: z.string().trim().toLowerCase().pipe(z.email('Nieprawidłowy adres e-mail')).refine(v => v.length <= 254, 'Nieprawidłowy adres e-mail') }),
  z.strictObject({ phone: z.string().trim().max(40).transform(v => normalPhone(v)).refine(v => v.length >= 6, 'Nieprawidłowy numer telefonu') }),
], { error: 'Wskaż klienta: crm_client_id, email albo phone' });
export type SubjectInput = z.infer<typeof subjectInput>;

export const normalEmail = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
/** Digits only; Polish numbers compare on their last 9 digits (with or without +48). */
export function normalPhone(v: unknown) {
  const d = typeof v === 'string' ? v.replace(/\D/g, '') : '';
  return d.length > 9 ? d.slice(-9) : d;
}
/** Keyed hash of a customer identifier: the register can be filtered by an e-mail or phone
 * without keeping it, and the hash cannot be reversed without the installation key. */
export function subjectHash(key: string, tenantId: string, kind: 'email' | 'phone' | 'crm', value: string) {
  return createHmac('sha256', 'rodo228:' + key).update(tenantId + '\0' + kind + '\0' + value).digest('hex');
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const iso = (d: Date) => d.toISOString().slice(0, 10);
export function warsawDay(d: Date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
export function addDays(day: string, n: number) {
  if (!DAY.test(day)) throw new Problem(500, 'Nieprawidłowa data');
  const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return iso(d);
}
const asDay = (v: unknown) => (typeof v === 'string' && DAY.test(v.slice(0, 10)) ? v.slice(0, 10) : null);
/** Tax point of a document: the sale date, or the issue date when issued before the sale
 * (art. 19a ust. 1 and art. 106i ustawy o VAT); without dates the day it was created. */
export function documentTaxPoint(data: Record<string, unknown> | null | undefined, createdAt: Date | string) {
  const sell = asDay(data?.sell_date) ?? asDay(data?.sale_date), issue = asDay(data?.issue_date);
  const created = typeof createdAt === 'string' ? asDay(createdAt) ?? warsawDay(new Date(createdAt)) : warsawDay(createdAt);
  if (sell && issue) return issue < sell ? issue : sell;
  return sell ?? issue ?? created;
}
/** Last day the buyer data of a document must be kept. The VAT for a month is due on the
 * 25th of the next month (art. 103 ust. 1); the liability expires 5 years after the end of
 * the year in which it was due (art. 70 § 1 Ordynacji). So a December tax point is kept a
 * year longer than the rest of its year. */
export function taxRetentionEnd(taxPoint: string) {
  if (!DAY.test(taxPoint)) throw new Problem(500, 'Nieprawidłowa data obowiązku podatkowego');
  const y = Number(taxPoint.slice(0, 4)), m = Number(taxPoint.slice(5, 7));
  const dueYear = m === 12 ? y + 1 : y;
  return `${dueYear + 5}-12-31`;
}
/** Immutable evidence of a contract: claims expire after 6 years, at the end of a year (art. 118 KC). */
export function evidenceRetentionEnd(day: string) {
  if (!DAY.test(day)) throw new Problem(500, 'Nieprawidłowa data');
  return `${Number(day.slice(0, 4)) + 6}-12-31`;
}
export const dueOn = (retentionEnd: string) => addDays(retentionEnd, 1);
export const maxDay = (days: (string | null | undefined)[]) => days.filter((d): d is string => !!d).sort().at(-1) ?? null;

/** Fields of an order, split by whether a tax document of the order is still in retention. */
export const ORDER_FIELDS = {
  invoice_buyer: ['customer_name', 'address.street', 'address.city', 'address.postal_code', 'address.country'],
  contact: ['email', 'address.phone', 'note', 'source_snapshot', 'b2b_snapshot'],
} as const;
export function classifyOrderFields(taxRetentionEndDay: string | null, today: string) {
  const retained = taxRetentionEndDay !== null && taxRetentionEndDay >= today;
  return {
    retained,
    anonymise: retained ? [...ORDER_FIELDS.contact] : [...ORDER_FIELDS.invoice_buyer, ...ORDER_FIELDS.contact],
    keep: retained ? [...ORDER_FIELDS.invoice_buyer] : [],
  };
}
/** CRM profile keys holding personal data; star, contractor_id and the status are not personal. */
export const CRM_PERSONAL_KEYS = ['login', 'phone', 'email', 'notes', 'invoice_company', 'invoice_fullname', 'invoice_address', 'invoice_postcode', 'invoice_city', 'invoice_state',
  'invoice_tax_id', 'delivery_company', 'delivery_fullname', 'delivery_address', 'delivery_postcode', 'delivery_city', 'delivery_state'] as const;

export type Blockers = { openOrders: { number: string; status: string }[]; openReturns: { number: string; state: string }[]; unsettled: { number: string; amount_due: string; overpayment: string; courier_due: string }[] };
/** 409 with the Polish reason when the customer still has open business. */
export function assertAnonymisable(b: Blockers) {
  const parts: string[] = [];
  const list = (xs: string[]) => xs.slice(0, 5).join(', ') + (xs.length > 5 ? ` i ${xs.length - 5} więcej` : '');
  if (b.openOrders.length) parts.push('otwarte zamówienia: ' + list(b.openOrders.map(o => `${o.number} (${STATUS_PL[o.status] ?? o.status})`)));
  if (b.openReturns.length) parts.push('otwarte zwroty: ' + list(b.openReturns.map(r => `${r.number} (${r.state === 'requested' ? 'zgłoszony' : 'czeka na zwrot pieniędzy'})`)));
  if (b.unsettled.length) parts.push('nierozliczone płatności w zamówieniach: ' + list(b.unsettled.map(u => u.number)));
  if (parts.length) throw new Problem(409, 'Nie można zanonimizować danych klienta — ' + parts.join('; ') + '. Zakończ te sprawy i spróbuj ponownie.');
}
const STATUS_PL: Record<string, string> = { new: 'czeka na wpłatę', paid: 'nowe', picking: 'kompletacja', packed: 'spakowane', shipped: 'wysłane', return_initiated: 'zwrot zgłoszony', return_received: 'zwrot przyjęty' };

/** Uwagi v3 §6: order history with values. Kinds whose detail keeps the values before/after of a section
 * edit, and the fields of each section that are personal data (amounts, methods and codes are not). */
export const HISTORY_VALUE_KINDS = ['order.section_edited', 'order.customer_updated'] as const;
export const HISTORY_PERSONAL_FIELDS: Record<string, readonly string[]> = {
  customer: ['name', 'customer_name', 'company', 'email', 'phone', 'street', 'postal_code', 'city'],
  delivery_address: ['recipient', 'street', 'postal_code', 'city'],
  invoice: ['buyer', 'nip', 'street', 'postal_code', 'city'],
  payment: ['reference'],
  extra: ['note'],
};
/** The history detail with every personal value (before, after and the values snapshot) replaced. */
export function anonymiseHistoryDetail(kind: string, detail: unknown): { value: unknown; changed: boolean } {
  if (!(HISTORY_VALUE_KINDS as readonly string[]).includes(kind) || !detail || typeof detail !== 'object') return { value: detail, changed: false };
  const d = detail as Record<string, any>, section = kind === 'order.customer_updated' ? 'customer' : String(d.section ?? '');
  const personal = HISTORY_PERSONAL_FIELDS[section] ?? [];
  if (!personal.length) return { value: detail, changed: false };
  let changed = false;
  const anon = (v: unknown) => { if (typeof v === 'string' && v !== '' && v !== ANON_TEXT) { changed = true; return ANON_TEXT; } return v; };
  const changes = Array.isArray(d.changes)
    ? d.changes.map((x: any) => (x && personal.includes(x.field) ? { ...x, before: anon(x.before), after: anon(x.after) } : x))
    : d.changes;
  const values = d.values && typeof d.values === 'object'
    ? Object.fromEntries(Object.entries(d.values).map(([k, v]) => [k, personal.includes(k) ? anon(v) : v]))
    : d.values;
  return { value: { ...d, ...(d.changes !== undefined ? { changes } : {}), ...(d.values !== undefined ? { values } : {}) }, changed };
}
/** Personal values to remove from free JSON. Short values are ignored so they do not hit unrelated text. */
export function needlesOf(values: unknown[]) {
  const out = new Set<string>();
  for (const v of values) if (typeof v === 'string') { const t = v.trim(); if (t.length >= 5 && !isAnonEmail(t) && t !== ANON_NAME && t !== ANON_STREET) out.add(t); }
  return [...out].sort((a, b) => b.length - a.length);
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Replaces every occurrence of a needle (case-insensitive) in strings of a JSON value. */
export function scrubJson(value: unknown, needles: string[]): { value: unknown; changed: boolean } {
  if (!needles.length) return { value, changed: false };
  const re = new RegExp(needles.map(escapeRe).join('|'), 'gi');
  let changed = false;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') { const n = v.replace(re, `[${ANON_TEXT}]`); if (n !== v) changed = true; return n; }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  const out = walk(value);
  return { value: out, changed };
}
export const containsNeedle = (value: unknown, needles: string[]) => scrubJson(value, needles).changed;

/** Plan digest input: canonical JSON with sorted keys. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter(k => (v as any)[k] !== undefined).map(k => JSON.stringify(k) + ':' + canonical((v as any)[k])).join(',') + '}';
  return JSON.stringify(v ?? null);
}

/** Flat CSV of the export: one row per value (sekcja, rekord, pole, wartość). Cells that a
 * spreadsheet would run as a formula get a leading apostrophe. */
export function exportCsv(bundle: Record<string, unknown>) {
  const rows: string[][] = [['sekcja', 'rekord', 'pole', 'wartosc']];
  const cell = (s: string) => { const t = /^[=+\-@\t\r]/.test(s) ? "'" + s : s; return /[",\n\r;]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  const flat = (section: string, record: string, prefix: string, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) { for (const [k, x] of Object.entries(v)) flat(section, record, prefix ? prefix + '.' + k : k, x); return; }
    if (Array.isArray(v) && v.some(x => x && typeof x === 'object')) { v.forEach((x, i) => flat(section, record, `${prefix}[${i}]`, x)); return; }
    rows.push([section, record, prefix, v === null || v === undefined ? '' : Array.isArray(v) ? v.join(' | ') : String(v)]);
  };
  for (const [section, value] of Object.entries(bundle)) {
    if (Array.isArray(value)) value.forEach((r, i) => flat(section, String((r as any)?.id ?? (r as any)?.number ?? i + 1), '', r));
    else flat(section, '1', '', value);
  }
  return '﻿' + rows.map(r => r.map(cell).join(';')).join('\r\n') + '\r\n';
}

/** A ZIP archive (stored, no compression) of a few small files. */
export function zipStore(files: { name: string; data: Buffer }[], at = new Date()) {
  const dosTime = (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | Math.floor(at.getUTCSeconds() / 2);
  const dosDate = ((at.getUTCFullYear() - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate();
  const locals: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8'), crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.data.length, 18); local.writeUInt32LE(f.data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(20, 6); head.writeUInt16LE(0x0800, 8); head.writeUInt16LE(0, 10);
    head.writeUInt16LE(dosTime, 12); head.writeUInt16LE(dosDate, 14); head.writeUInt32LE(crc, 16); head.writeUInt32LE(f.data.length, 20);
    head.writeUInt32LE(f.data.length, 24); head.writeUInt16LE(name.length, 28); head.writeUInt32LE(offset, 42);
    locals.push(local, name, f.data); central.push(head, name);
    offset += 30 + name.length + f.data.length;
  }
  const dir = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}
