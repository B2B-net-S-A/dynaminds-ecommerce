/** Mirakl MMP Seller writes (migration 252, docs/parity/MIRAKL252-20261028.md). Import-inert, transport-injected.
 * OF24 POST /api/offers (update price/quantity of existing offers), OF02 GET /api/offers/imports/{id},
 * OF03 GET /api/offers/imports/{id}/error_report, OR21 PUT /api/orders/{id}/accept, OR23 PUT /api/orders/{id}/tracking,
 * OR24 PUT /api/orders/{id}/ship. Shapes follow the public Seller API documentation; no operator has confirmed them
 * (no public sandbox — czeka na dostawcę). Every answer is classified into exactly one of: acknowledged, refused
 * (nothing applied: 400/401/403/404/409/422), deferred (429 with Retry-After, nothing applied) or uncertain (no answer,
 * timeout, 5xx, unreadable body after the request left): an uncertain write is never repeated blindly, the caller
 * reconciles it by readback first. Remote bodies never reach logs or the caller beyond fixed, bounded fields. */
import { z } from 'zod';
import { ensure, Problem } from './errors';
import type { Transport } from './integrations';
import { miraklInstance } from './mirakl';

export class MiraklWriteRefused extends Problem {
  constructor(readonly providerStatus: number, message: string) { super(422, message, 'MIRAKL_WRITE_REFUSED'); }
}
export class MiraklWriteDeferred extends Problem {
  constructor(readonly seconds: number) { super(429, 'Mirakl: zapis odroczony przez limit dostawcy', 'MIRAKL_WRITE_DEFERRED'); }
}
export class MiraklWriteUncertain extends Problem {
  constructor() { super(502, 'Mirakl: brak potwierdzenia zapisu; wynik zostanie uzgodniony odczytem', 'MIRAKL_WRITE_UNCERTAIN'); }
}
const sku = z.string().min(1).max(160).refine(v => !/[\x00-\x1f\x7f";]/.test(v));
const orderId = z.string().min(1).max(160).refine(v => !/[\x00-\x1f\x7f/?#%,]/.test(v));
export const miraklOfferLine = z.strictObject({ shop_sku: sku, price_minor: z.number().int().min(0).max(2147483647), quantity: z.number().int().min(0).max(10000000) });
export type MiraklOfferLine = z.infer<typeof miraklOfferLine>;
export const miraklTracking = z.strictObject({
  carrier_code: z.string().min(1).max(50).regex(/^[A-Za-z0-9_-]+$/).optional(),
  carrier_name: z.string().min(1).max(100).refine(v => !/[\x00-\x1f\x7f]/.test(v)).optional(),
  carrier_url: z.url({ protocol: /^https$/ }).max(500).optional(),
  tracking_number: z.string().min(1).max(100).regex(/^[A-Za-z0-9._/ -]+$/),
}).refine(t => t.carrier_code || t.carrier_name, 'Podaj kod lub nazwę przewoźnika');
export type MiraklTracking = z.infer<typeof miraklTracking>;
const settingsSchema = z.object({ instance_url: z.string().transform(miraklInstance), shop_id: z.string().regex(/^[1-9]\d{0,15}$/) });
const importSchema = z.object({ import_id: z.number().int().positive().safe(), status: z.string().min(1).max(60),
  lines_read: z.number().int().min(0).max(1000000).optional(), lines_in_success: z.number().int().min(0).max(1000000).optional(),
  lines_in_error: z.number().int().min(0).max(1000000).optional(), has_error_report: z.boolean().optional() });
export type MiraklImportStatus = { import_id: string; status: string; done: boolean; failed: boolean; lines_read: number; lines_in_success: number; lines_in_error: number; has_error_report: boolean };
/** Decimal of a minor-unit amount, exact for 2 places (the OR11/OF21 parser reads it back with miraklMoney). */
export const miraklPrice = (minor: number) => Number((minor / 100).toFixed(2));

export function createMiraklWriter(input: { settings: unknown; apiKey: string; transport: Transport; timeoutMs?: number }) {
  const s = settingsSchema.safeParse(input.settings);
  ensure(s.success, 422, 'Mirakl: nieprawidłowa konfiguracja kanału');
  ensure(typeof input.apiKey === 'string' && /^[\x21-\x7e]{1,4096}$/.test(input.apiKey), 422, 'Mirakl: nieprawidłowy klucz sklepu');
  ensure(typeof input.transport === 'function', 422, 'Mirakl: wymagany jawny transport');
  const { instance_url, shop_id } = s.data, timeoutMs = input.timeoutMs ?? 15000;
  async function call(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, accept = 'application/json'): Promise<{ status: number; text: string }> {
    const u = new URL(instance_url + path);
    u.searchParams.set('shop_id', shop_id);
    const headers: Record<string, string> = { Authorization: input.apiKey, Accept: accept };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let r: Response;
    // A referenced timer (AbortSignal.timeout is unref'd): a hanging answer always ends as 'uncertain'.
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      r = await input.transport(u.toString(), { method, redirect: 'error', headers, body: body === undefined ? undefined : JSON.stringify(body), signal: abort.signal });
    } catch { throw new MiraklWriteUncertain(); } finally { clearTimeout(timer); }
    let status: number;
    try { status = r.status; } catch { throw new MiraklWriteUncertain(); }
    if (!Number.isInteger(status) || status < 100 || status > 599 || r.redirected) throw new MiraklWriteUncertain();
    if (status === 429) {
      const h = r.headers.get('retry-after');
      const seconds = h && /^\d{1,9}$/.test(h) ? Math.max(1, Number(h)) : 60;
      try { await r.body?.cancel(); } catch { /* redacted */ }
      throw new MiraklWriteDeferred(seconds);
    }
    if (status >= 500) { try { await r.body?.cancel(); } catch { /* redacted */ } throw new MiraklWriteUncertain(); }
    let text = '';
    try {
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 256 * 1024) throw new Error('too large');
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch { if (status < 300) throw new MiraklWriteUncertain(); }
    if ([400, 401, 403, 404, 409, 422].includes(status)) {
      // Only a fixed message per status; the provider text stays out of the database and the logs.
      const message = status === 401 || status === 403 ? 'Mirakl: klucz sklepu odrzucony lub brak dostępu do sklepu'
        : status === 404 ? 'Mirakl: zamówienie lub zasób nie istnieje u operatora' : 'Mirakl: operator odrzucił zapis (stan lub dane)';
      throw new MiraklWriteRefused(status, message);
    }
    if (status < 200 || status >= 300) throw new MiraklWriteUncertain();
    return { status, text };
  }
  const jsonOf = (text: string): unknown => { try { return JSON.parse(text); } catch { throw new MiraklWriteUncertain(); } };
  return Object.freeze({
    /** OF24: update price and quantity of existing offers (update_delete=update). Creation needs a product reference. */
    async submitOffers(lines: readonly MiraklOfferLine[]): Promise<{ import_id: string }> {
      const v = z.array(miraklOfferLine).min(1).max(100).parse(lines);
      ensure(new Set(v.map(l => l.shop_sku)).size === v.length, 422, 'Mirakl: powtórzony SKU w jednej paczce ofert');
      const r = await call('POST', '/api/offers', { offers: v.map(l => ({ shop_sku: l.shop_sku, price: miraklPrice(l.price_minor), quantity: l.quantity, update_delete: 'update' })) });
      const p = z.object({ import_id: z.number().int().positive().safe() }).safeParse(jsonOf(r.text));
      if (!p.success) throw new MiraklWriteUncertain();
      return { import_id: String(p.data.import_id) };
    },
    /** OF02 (one import). COMPLETE/FAILED are terminal; any other status is still processing. */
    async importStatus(importId: string): Promise<MiraklImportStatus> {
      ensure(/^[1-9]\d{0,18}$/.test(importId), 422, 'Mirakl: nieprawidłowy import');
      const r = await call('GET', '/api/offers/imports/' + importId);
      const p = importSchema.safeParse(jsonOf(r.text));
      if (!p.success || String(p.data.import_id) !== importId) throw new MiraklWriteUncertain();
      const d = p.data;
      return { import_id: importId, status: d.status, done: d.status === 'COMPLETE' || d.status === 'FAILED', failed: d.status === 'FAILED',
        lines_read: d.lines_read ?? 0, lines_in_success: d.lines_in_success ?? 0, lines_in_error: d.lines_in_error ?? 0, has_error_report: d.has_error_report ?? false };
    },
    /** OF03: the CSV error report reduced to at most 100 SKUs with a fixed-length message each. */
    async importErrors(importId: string): Promise<{ shop_sku: string; message: string }[]> {
      ensure(/^[1-9]\d{0,18}$/.test(importId), 422, 'Mirakl: nieprawidłowy import');
      const r = await call('GET', '/api/offers/imports/' + importId + '/error_report', undefined, 'text/csv');
      const rows = r.text.split(/\r?\n/).filter(Boolean).slice(1, 101);
      return rows.map(row => {
        const cells = row.split(';').map(c => c.replace(/^"|"$/g, ''));
        return { shop_sku: (cells[0] ?? '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 160), message: (cells.at(-1) ?? '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200) };
      });
    },
    /** OR21: accept every line of a WAITING_ACCEPTANCE order. */
    async acceptOrder(id: string, lineIds: readonly string[]): Promise<void> {
      const o = orderId.parse(id), lines = z.array(z.string().min(1).max(160)).min(1).max(100).parse(lineIds);
      await call('PUT', '/api/orders/' + encodeURIComponent(o) + '/accept', { order_lines: lines.map(l => ({ accepted: true, id: l })) });
    },
    /** OR23: set carrier and tracking number; a PUT of the same values is idempotent. */
    async setTracking(id: string, tracking: MiraklTracking): Promise<void> {
      const o = orderId.parse(id), t = miraklTracking.parse(tracking);
      await call('PUT', '/api/orders/' + encodeURIComponent(o) + '/tracking', t);
    },
    /** OR24: confirm shipment (SHIPPING -> SHIPPED). */
    async shipOrder(id: string): Promise<void> {
      await call('PUT', '/api/orders/' + encodeURIComponent(orderId.parse(id)) + '/ship');
    },
  });
}
export type MiraklWriter = ReturnType<typeof createMiraklWriter>;
