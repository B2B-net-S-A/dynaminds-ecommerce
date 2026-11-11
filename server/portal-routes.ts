import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, tenantTx } from './db';
import { audit, lockedOrder } from './domain';
import { ensure, Problem } from './errors';
import { requestReturn, returnInput, returnOverview } from './returns';
import { returnPage, returnQuery } from './return-query';
import { documentBody, portalHtml } from './portal-view';
import { paymentBalance } from './payments';
import { payu242PortalOffer } from './payu242';
import { orderMergeOriginInTx } from './order-merge-guards';
import { orderMergeBuyerPaymentBalanceInTx } from './order-merge-payments';
import { emailAttachment } from './email-attachments';
import { portalDefaultDaysInTx } from './portal-link-default253';
import { applyPortalLinkPolicy, readPortalLinkPolicy, savePortalLinkPolicy } from './portal-link-policy253';
import type { PoolClient } from 'pg';
const unavailable =
  'Plik tego dokumentu nie jest jeszcze udostępniony. Skontaktuj się ze sprzedawcą.';
const tokenSchema = z.object({ token: z.string().regex(/^[a-f0-9]{48}$/) });
const publicReturnInput = returnInput.omit({ warehouse_id: true, reason_id: true }).strict();
const stages: Record<string, string> = {
  // Codes are historical (docs/order-status-codes.md): new waits for payment, paid is ready to fulfil.
  new: 'Nieopłacone',
  paid: 'Nowe',
  picking: 'W kompletacji',
  packed: 'Spakowane',
  shipped: 'Nadane',
  delivered: 'Dostarczone',
  completed: 'Zakończone',
  cancelled: 'Anulowane',
  return_initiated: 'Zwrot zgłoszony',
  return_received: 'Zwrot przyjęty',
  return_completed: 'Zwrot zakończony',
};
async function resolveToken(params: unknown) {
  const { token } = tokenSchema.parse(params);
  const o = (
    await pool.query(
      'SELECT id,tenant_id FROM orders WHERE portal_token=$1 AND portal_enabled AND (portal_expires_at IS NULL OR portal_expires_at>now())',
      [token],
    )
  ).rows[0];
  ensure(o, 404, 'Nie znaleziono aktywnego linku zamówienia');
  return o;
}
const printable = (d: any) =>
  ['demo', 'simulation'].includes(d.mode) || (d.kind === 'proforma' && d.mode === 'local');
// Public carrier tracking pages for live parcels only; sandbox and DEMO numbers are not real.
const trackingPages: Record<string, string> = {
  'InPost ShipX': 'https://inpost.pl/sledzenie-przesylek?number=',
  'DPD Polska': 'https://tracktrace.dpd.com.pl/parcelDetails?typ=1&p1=',
};
export function trackingUrl(s: { carrier: string; tracking_number: string; mode: string }) {
  const page = trackingPages[s.carrier];
  return page && s.mode === 'live' && /^[A-Za-z0-9-]{4,40}$/.test(s.tracking_number)
    ? page + encodeURIComponent(s.tracking_number)
    : null;
}
async function present(c: PoolClient, table: string) {
  return Boolean((await c.query('SELECT to_regclass($1) present', ['public.' + table])).rows[0].present);
}
/** Provider PDFs prepared earlier by staff (Fakturownia cache from 063, verified Odoo export).
 * The portal never calls a provider; it only checks that a prepared file exists. */
async function preparedPdfDocuments(c: PoolClient, orderId: string, ids: string[]) {
  const ready = new Set<string>();
  if (!ids.length) return ready;
  if (await present(c, 'invoice_email_files'))
    for (const r of (
      await c.query(
        "SELECT DISTINCT f.document_id FROM invoice_email_files f JOIN documents d ON (d.tenant_id,d.id)=(f.tenant_id,f.document_id) WHERE d.order_id=$1 AND d.mode='external' AND d.kind='invoice' AND f.document_id=ANY($2::uuid[])",
        [orderId, ids],
      )
    ).rows)
      ready.add(r.document_id);
  if ((await present(c, 'odoo_invoice_exports')) && (await present(c, 'odoo_invoice_files')))
    for (const r of (
      await c.query(
        "SELECT DISTINCT p.document_id FROM odoo_invoice_exports p JOIN odoo_invoice_files f ON (f.tenant_id,f.export_id)=(p.tenant_id,p.id) WHERE p.order_id=$1 AND p.state='done' AND p.phase='verified' AND p.document_id=ANY($2::uuid[])",
        [orderId, ids],
      )
    ).rows)
      ready.add(r.document_id);
  return ready;
}
/** The prepared provider PDF of a document after the same validation as an email attachment
 * (current document, account and file hash), or null. The file endpoint serves only this, and
 * /data offers „Pobierz PDF” only when it is non-null. */
async function checkedPdf(c: PoolClient, orderId: string, d: { id: string; mode: string }) {
  for (const attachment of d.mode === 'external' ? ['invoice', 'odoo_invoice'] : ['odoo_invoice']) {
    try {
      const candidate = await emailAttachment(c, { attachment }, { id: orderId });
      if (candidate?.meta.document_id === d.id && candidate?.meta.content_type === 'application/pdf')
        return candidate;
    } catch (e) {
      if (!(e instanceof Problem)) throw e;
    }
  }
  return null;
}
const customerCase = (r: any) => ({
  id: r.id,
  number: r.number,
  kind: r.kind,
  remedy: r.remedy ?? 'refund',
  exchange: r.exchange
    ? {
        replacement_number: r.exchange.replacement_order?.number,
        replacement_status: r.exchange.replacement_order?.status,
        shipments: (r.exchange.replacement_order?.shipments ?? []).map((s: any) => ({
          carrier: s.carrier,
          tracking_number: s.tracking_number,
          mode: s.mode,
          status: s.status,
        })),
      }
    : null,
  state: r.state,
  reason: r.reason,
  created_at: r.created_at,
  received_at: r.received_at,
  accepted_at: r.accepted_at ?? r.received_at ?? null,
  acceptance_kind: r.acceptance_kind ?? (r.received_at ? 'physical' : null),
  refunded_at: r.refunded_at,
  refund_amount: r.refund_amount,
  settlement_amount: r.settlement?.amount ?? null,
  decision_note: ['rejected', 'cancelled'].includes(r.state) ? r.decision_note : '',
  items: r.items.map((i: any) => ({
    name: i.name,
    sku: i.sku,
    requested: i.requested,
    accepted: i.accepted,
  })),
});
export function registerPortalRoutes(
  app: FastifyInstance,
  {
    readOnly,
    printLayout,
  }: {
    readOnly: boolean;
    printLayout: (title: string, body: string, nativeProforma?: boolean) => string;
  },
) {
  async function data(params: unknown, query: unknown) {
    const ref = await resolveToken(params),
      q = z
        .object({ after: z.string().max(1600).optional() })
        .strict()
        .parse(query);
    return tenantTx(ref.tenant_id, async (c) => {
      let o = (
        await c.query(
          "SELECT number,status,total,currency,shipping_cost,to_jsonb(o)->>'fulfillment_kind' fulfillment_kind FROM orders o WHERE id=$1",
          [ref.id],
        )
      ).rows[0];
      const origin = await orderMergeOriginInTx(c, ref.id);
      const historical = origin?.header.portal_token === tokenSchema.parse(params).token;
      const buyerPayment = historical ? await orderMergeBuyerPaymentBalanceInTx(c, ref.id) : null;
      if (historical)
        o = Object.fromEntries(
          ['number', 'status', 'total', 'currency', 'shipping_cost'].map((key) => [
            key,
            origin.header[key],
          ]),
        );
      const overview = await returnOverview(c, ref.id, returnQuery.parse(q));
      const money = (n: number) =>
        new Intl.NumberFormat('pl-PL', { style: 'currency', currency: o.currency }).format(n / 100);
      const docRows = (
        await c.query(
          'SELECT id,number,kind,mode FROM documents WHERE order_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100',
          [ref.id],
        )
      ).rows;
      const pdf = await preparedPdfDocuments(c, ref.id, docRows.map((d) => d.id));
      const documents = [];
      for (const d of docRows) {
        // A prepared provider PDF (Fakturownia, Odoo) wins over the local DEMO print, but only
        // when the file endpoint would serve it; a stale file is not offered as a button.
        const download =
          pdf.has(d.id) && (await checkedPdf(c, ref.id, d)) ? 'pdf' : printable(d) ? 'print' : null;
        documents.push({ ...d, download, download_available: download !== null });
      }
      const shipments = (
        await c.query(
          'SELECT carrier,tracking_number,mode,status FROM shipments WHERE order_id=$1 ORDER BY created_at',
          [ref.id],
        )
      ).rows.map((s) => ({ ...s, tracking_url: trackingUrl(s) }));
      const balance = historical ? buyerPayment!.balance : await paymentBalance(c, ref.id);
      // 242: „Zapłać przez PayU” only for a current, writable link of a prepaid sale with an open balance.
      const payu = await payu242PortalOffer(c, { orderId: ref.id, order: o, balance, writable: !readOnly && !historical });
      return {
        ...o,
        payu,
        payment: ((b) => ({
          payment_mode: b.payment_mode,
          received: b.received,
          refunded: b.refunded,
          credit: b.credit,
          amount_due: b.amount_due,
          overpayment: b.overpayment,
        }))(balance),
        payment_as_of_merge: buyerPayment?.payment_as_of_merge ?? false,
        status_label: historical
          ? 'Realizacja przeniesiona przez łączenie zamówień'
          : o.fulfillment_kind === 'replacement' && o.status === 'paid'
            ? 'Gotowe do kompletacji'
            : (stages[o.status] ?? o.status),
        total_label: money(o.total),
        read_only: readOnly || historical,
        items: (historical
          ? origin.items.map((i: any) => ({ ...i, available: 0 }))
          : overview.items
        ).map((i: any) => ({
          id: i.id,
          name: i.name,
          sku: i.sku,
          quantity: i.quantity,
          available: i.available,
          gross: i.line_total,
          gross_label: money(i.line_total),
        })),
        shipping_available: historical ? 0 : overview.shipping_available,
        can_request:
          !readOnly &&
          !historical &&
          o.fulfillment_kind !== 'replacement' &&
          [
            'shipped',
            'delivered',
            'completed',
            'return_initiated',
            'return_received',
            'return_completed',
          ].includes(o.status) &&
          overview.items.some((i) => i.available > 0),
        cases: historical ? [] : overview.cases.map(customerCase),
        meta: historical ? { has_more: false, cursor: null } : overview.meta,
        documents: historical ? [] : documents,
        shipments: historical ? [] : shipments,
      };
    });
  }
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/api/public/orders/'))
      reply.header('X-Robots-Tag', 'noindex, nofollow').header('X-Frame-Options', 'DENY');
  });
  app.get(
    '/api/public/orders/:token',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      let d;
      try {
        d = await data(req.params, {});
      } catch (e) {
        if (!(e instanceof Problem) || e.status !== 404) throw e;
        return reply
          .code(404)
          .header(
            'Content-Security-Policy',
            "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
          )
          .type('text/html')
          .send(
            '<!doctype html><html lang="pl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link zamówienia niedostępny</title><main><h1>Link zamówienia jest niedostępny</h1><p>Link wygasł, został wyłączony albo zastąpiony nowym. Skontaktuj się ze sprzedawcą, aby otrzymać aktualny link.</p><p>DYNAMINDS Ecommerce</p></main></html>',
          );
      }
      const nonce = randomBytes(18).toString('base64');
      reply.header(
        'Content-Security-Policy',
        `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
      );
      return reply.type('text/html').send(portalHtml(d, nonce));
    },
  );
  app.get(
    '/api/public/orders/:token/data',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    (req) => data(req.params, req.query),
  );
  app.post(
    '/api/public/orders/:token/returns',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const ref = await resolveToken(req.params),
        input = publicReturnInput.parse(req.body);
      const r = await tenantTx(ref.tenant_id, async (c) => {
        // Re-check link under the same order lock as intake and reset/disable; stale authorization cannot win a race.
        const o = await lockedOrder(c, ref.id);
        const { token } = tokenSchema.parse(req.params);
        const origin = await orderMergeOriginInTx(c, ref.id);
        ensure(
          origin?.header.portal_token !== token,
          409,
          'Ten link przedstawia pierwotne zamówienie. Realizacja została przeniesiona przez łączenie.',
        );
        ensure(
          o.portal_token === token &&
            o.portal_enabled &&
            (!o.portal_expires_at || o.portal_expires_at > new Date()),
          404,
          'Nie znaleziono aktywnego linku zamówienia',
        );
        return requestReturn(
          c,
          { tenantId: ref.tenant_id, userId: null },
          ref.id,
          input,
          false,
          'buyer',
        );
      });
      return reply.code(201).send(customerCase(r));
    },
  );
  app.get('/api/public/orders/:token/documents/:id/print', async (req, reply) => {
    const ref = await resolveToken(req.params),
      { id } = z.object({ id: z.uuid() }).parse(req.params);
    return tenantTx(ref.tenant_id, async (c) => {
      const origin = await orderMergeOriginInTx(c, ref.id);
      ensure(
        origin?.header.portal_token !== tokenSchema.parse(req.params).token,
        409,
        'Pierwotny link zamówienia nie udostępnia dokumentów łącznej realizacji',
      );
      const d = (await c.query('SELECT * FROM documents WHERE id=$1 AND order_id=$2', [id, ref.id]))
        .rows[0];
      ensure(d, 404, 'Nie znaleziono dokumentu tego zamówienia');
      ensure(printable(d), 409, 'Pobranie dokumentu dostawcy wymaga kontaktu ze sprzedawcą');
      return reply
        .type('text/html')
        .send(printLayout(d.number, documentBody(d), d.kind === 'proforma' && d.mode === 'local'));
    });
  });
  app.get(
    '/api/public/orders/:token/documents/:id/file',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const ref = await resolveToken(req.params),
        { id } = z.object({ id: z.uuid() }).parse(req.params),
        { token } = tokenSchema.parse(req.params);
      const file = await tenantTx(ref.tenant_id, async (c) => {
        const origin = await orderMergeOriginInTx(c, ref.id);
        ensure(
          origin?.header.portal_token !== token,
          409,
          'Pierwotny link zamówienia nie udostępnia dokumentów łącznej realizacji',
        );
        const d = (await c.query('SELECT * FROM documents WHERE id=$1 AND order_id=$2', [id, ref.id]))
          .rows[0];
        ensure(d, 404, 'Nie znaleziono dokumentu tego zamówienia');
        ensure((await preparedPdfDocuments(c, ref.id, [d.id])).has(d.id), 409, unavailable);
        const f = await checkedPdf(c, ref.id, d);
        ensure(f, 409, unavailable);
        await audit(c, { tenantId: ref.tenant_id, userId: null }, 'portal.document.download', d.id, {
          source: f.meta.source,
          size: f.meta.size,
        });
        return { bytes: f.bytes, number: d.number };
      });
      return reply
        .type('application/pdf')
        .header('Cache-Control', 'no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
        .header(
          'Content-Disposition',
          `attachment; filename="faktura-${file.number.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80)}.pdf"`,
        )
        .send(file.bytes);
    },
  );
  app.post('/api/orders/:id/portal', async (req) => {
    ensure(req.actor.role === 'admin', 403, 'Wymagana rola administratora');
    const { id } = z.object({ id: z.uuid() }).parse(req.params),
      b = z
        .object({
          action: z.enum(['rotate', 'disable']),
          days: z.number().int().min(1).max(365).optional(),
        })
        .strict()
        .parse(req.body);
    return tenantTx(req.actor.tenantId, async (c) => {
      await lockedOrder(c, id);
      // 245 (COM-PORTAL-4): without explicit days a new link takes the tenant's default validity, else 90 days.
      const days = b.days ?? (await portalDefaultDaysInTx(c)) ?? 90;
      const row = (
        await c.query(
          b.action === 'disable'
            ? 'UPDATE orders SET portal_enabled=false WHERE id=$1 RETURNING portal_enabled,portal_expires_at'
            : 'UPDATE orders SET portal_token=$2,portal_enabled=true,portal_expires_at=now()+make_interval(days=>$3) WHERE id=$1 RETURNING portal_token,portal_enabled,portal_expires_at',
          b.action === 'disable' ? [id] : [id, randomBytes(24).toString('hex'), days],
        )
      ).rows[0];
      await audit(c, req.actor, 'portal.' + b.action, id, {
        days: b.action === 'rotate' ? days : undefined,
      });
      return row;
    });
  });
  // 245 (COM-PORTAL-4): the administrator's default validity of buyer links.
  app.get('/api/portal/link-policy', (req) => readPortalLinkPolicy(req.actor));
  app.put('/api/portal/link-policy', (req) => savePortalLinkPolicy(req.actor, req.body));
  app.post('/api/portal/link-policy/apply', (req) => applyPortalLinkPolicy(req.actor, req.body));
}
