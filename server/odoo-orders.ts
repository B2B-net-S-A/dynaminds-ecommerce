import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { Odoo, odooConfig, odooId, relation, type OdooFence } from './odoo';
import { ensure } from './errors';
import { erpMinor } from './odoo-accounting';
import type { Transport } from './integrations';
const timestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  .refine((v) => {
    const t = new Date(v.replace(' ', 'T') + 'Z');
    return Number.isFinite(t.getTime()) && t.toISOString().slice(0, 19).replace('T', ' ') === v;
  });
export const odooWindowSchema = z
  .object({
    from: timestamp.nullable(),
    to: timestamp,
    after: z
      .object({ date: timestamp, id: z.number().int().positive().max(2147483647) })
      .nullable(),
  })
  .strict()
  .refine(
    (v) =>
      (!v.from || v.from <= v.to) &&
      (!v.after || v.after.date <= v.to) &&
      Date.parse(v.to.replace(' ', 'T') + 'Z') <= Date.now() + 5000,
  );
export type OdooOrderWindow = z.infer<typeof odooWindowSchema>;
export const odooTimestamp = (d = new Date()) => d.toISOString().slice(0, 19).replace('T', ' ');
export function initialOdooWindow(previous?: string | null): OdooOrderWindow {
  return {
    from: previous
      ? odooTimestamp(
          new Date(Date.parse(timestamp.parse(previous).replace(' ', 'T') + 'Z') - 600000),
        )
      : null,
    to: odooTimestamp(new Date(Date.now() - 5000)),
    after: null,
  };
}
export function odooCursor(window: OdooOrderWindow) {
  return Buffer.from(JSON.stringify(window)).toString('base64url');
}
export function parseOdooCursor(cursor?: string | null) {
  if (!cursor) return initialOdooWindow();
  ensure(/^[A-Za-z0-9_-]{1,2048}$/.test(cursor), 422, 'Nieprawidłowy cursor Odoo');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    ensure(false, 422, 'Nieprawidłowy cursor Odoo');
  }
  return odooWindowSchema.parse(parsed);
}
const headerFields = [
  'id',
  'name',
  'state',
  'company_id',
  'warehouse_id',
  'currency_id',
  'partner_id',
  'partner_invoice_id',
  'partner_shipping_id',
  'order_line',
  'amount_total',
  'amount_untaxed',
  'amount_tax',
  'invoice_status',
  'invoice_ids',
  'transaction_ids',
  'picking_ids',
  'delivery_status',
  'client_order_ref',
  'note',
  'write_date',
];
const lineFields = [
  'id',
  'order_id',
  'company_id',
  'currency_id',
  'name',
  'display_type',
  'product_id',
  'product_uom_id',
  'product_uom_qty',
  'qty_delivered',
  'price_total',
  'price_subtotal',
  'price_tax',
  'discount',
  'is_downpayment',
  'is_expense',
  'write_date',
];
const partnerFields = [
  'id',
  'name',
  'email',
  'phone',
  'street',
  'street2',
  'city',
  'zip',
  'country_id',
  'commercial_partner_id',
  'company_id',
  'write_date',
];
const productFields = ['id', 'default_code', 'type', 'is_storable', 'company_id'];
const paymentFields = [
  'id',
  'reference',
  'company_id',
  'amount',
  'currency_id',
  'state',
  'operation',
  'sale_order_ids',
  'source_transaction_id',
  'child_transaction_ids',
  'write_date',
];
const pickingFields = ['id', 'company_id', 'sale_id', 'state', 'write_date'];
const currencyFields = ['id', 'name', 'decimal_places', 'rounding', 'active'];
export class OdooSales extends Odoo {
  private cfg: ReturnType<typeof odooConfig>;
  constructor(
    settings: Record<string, string>,
    credentials: Record<string, string>,
    transport: Transport,
  ) {
    super(settings, credentials, transport);
    this.cfg = odooConfig(settings, credentials);
  }
  private async many(model: string, ids: number[], fields: string[], fence?: OdooFence) {
    const unique = [...new Set(ids.map(odooId))];
    ensure(unique.length <= 1000, 422, 'Przekroczono powiązane rekordy strony Odoo');
    const rows: any[] = [];
    for (let i = 0; i < unique.length; i += 100)
      rows.push(...(await this.read(model, unique.slice(i, i + 100), fields, fence)));
    return rows;
  }
  async orders(cursor?: string | null, window?: OdooOrderWindow, fence?: OdooFence) {
    const w = odooWindowSchema.parse(window ?? parseOdooCursor(cursor));
    const domain: any[] = [
      ['company_id', '=', this.cfg.company],
      ['warehouse_id', '=', this.cfg.warehouse],
      ['state', 'in', ['sale', 'cancel']],
      ['write_date', '<=', w.to],
    ];
    if (w.from) domain.push(['write_date', '>=', w.from]);
    if (w.after)
      domain.push(
        '|',
        ['write_date', '>', w.after.date],
        '&',
        ['write_date', '=', w.after.date],
        ['id', '>', w.after.id],
      );
    const found = await this.rpc(
      'sale.order',
      'search_read',
      { domain, fields: headerFields, order: 'write_date asc,id asc', limit: 11 },
      fence,
    );
    ensure(
      found.length <= 11 && new Set(found.map((r: any) => odooId(r?.id))).size === found.length,
      502,
      'Nieprawidłowa strona zamówień Odoo',
    );
    let previous = w.after;
    for (const row of found) {
      const d = timestamp.parse(row.write_date);
      ensure(
        relation(row.company_id) === this.cfg.company &&
          relation(row.warehouse_id) === this.cfg.warehouse &&
          ['sale', 'cancel'].includes(row.state) &&
          d <= w.to &&
          (!w.from || d >= w.from) &&
          (!previous || d > previous.date || (d === previous.date && row.id > previous.id)),
        502,
        'Odoo zwróciło obcy lub powtórzony zakres zamówień',
      );
      previous = { date: d, id: row.id };
    }
    const page = found.slice(0, 10),
      data = await this.enrich(page, fence),
      last = page.at(-1),
      more = found.length > 10,
      next = last ? { ...w, after: { date: last.write_date, id: last.id } } : w;
    return { data, has_more: more, next_cursor: more ? odooCursor(next) : null, window: next };
  }
  async order(id: number, fence?: OdooFence) {
    const [row] = await this.read('sale.order', [odooId(id)], headerFields, fence);
    return (await this.enrich([row], fence))[0];
  }
  private async enrich(rows: any[], fence?: OdooFence) {
    const context = await this.catalogSettings(fence);
    if (!rows.length) return [];
    const fields = await this.rpc(
        'sale.order.line',
        'fields_get',
        { allfields: ['is_delivery'], attributes: ['type'] },
        fence,
      ),
      delivery = !!fields.is_delivery,
      lf = [...lineFields, ...(delivery ? ['is_delivery'] : [])];
    for (const row of rows) {
      ensure(
        relation(row.company_id) === this.cfg.company &&
          relation(row.warehouse_id) === this.cfg.warehouse,
        502,
        'Zamówienie Odoo pochodzi z innej firmy lub magazynu',
      );
      for (const k of ['order_line', 'transaction_ids', 'picking_ids', 'invoice_ids'])
        ensure(
          Array.isArray(row[k]) && row[k].length <= 100 && new Set(row[k]).size === row[k].length,
          422,
          'Niepełne lub zbyt duże zasoby zamówienia Odoo',
        );
    }
    const lines = await this.many(
        'sale.order.line',
        rows.flatMap((r) => r.order_line),
        lf,
        fence,
      ),
      partners = await this.many(
        'res.partner',
        rows.flatMap((r) => [
          relation(r.partner_id),
          relation(r.partner_invoice_id),
          relation(r.partner_shipping_id),
        ]),
        partnerFields,
        fence,
      ),
      products = await this.many(
        'product.product',
        lines.filter((l) => l.product_id !== false).map((l) => relation(l.product_id)),
        productFields,
        fence,
      ),
      countries = await this.many(
        'res.country',
        partners.filter((p) => p.country_id !== false).map((p) => relation(p.country_id)),
        ['id', 'code'],
        fence,
      ),
      currencies = await this.many(
        'res.currency',
        rows.map((r) => relation(r.currency_id)),
        currencyFields,
        fence,
      ),
      transactions = await this.many(
        'payment.transaction',
        rows.flatMap((r) => r.transaction_ids),
        paymentFields,
        fence,
      ),
      pickings = await this.many(
        'stock.picking',
        rows.flatMap((r) => r.picking_ids),
        pickingFields,
        fence,
      );
    const snapshots = [
      ['sale.order', rows, headerFields],
      ['sale.order.line', lines, lf],
      ['res.partner', partners, partnerFields],
      ['product.product', products, productFields],
      ['res.country', countries, ['id', 'code']],
      ['res.currency', currencies, currencyFields],
      ['payment.transaction', transactions, paymentFields],
      ['stock.picking', pickings, pickingFields],
    ] as const;
    const sort = (r: any[]) => [...r].sort((a, b) => a.id - b.id);
    for (const [model, records, cols] of snapshots)
      ensure(
        isDeepStrictEqual(
          sort(records),
          sort(
            await this.many(
              model,
              records.map((r) => r.id),
              [...cols],
              fence,
            ),
          ),
        ),
        409,
        'Dane zamówień Odoo zmieniły się podczas odczytu; pobierz stronę ponownie',
      );
    ensure(
      isDeepStrictEqual(context, await this.catalogSettings(fence)),
      409,
      'Zakres firmy/magazynu/jednostki Odoo zmienił się podczas odczytu',
    );
    return rows.map((row) => ({
      ...row,
      _dyna: {
        context,
        connection: { origin: this.cfg.origin, database: this.cfg.database },
        has_delivery_field: delivery,
        lines: row.order_line.map((id: number) => lines.find((l) => l.id === id)),
        buyer: partners.find((p) => p.id === relation(row.partner_id)),
        billing: partners.find((p) => p.id === relation(row.partner_invoice_id)),
        address: partners.find((p) => p.id === relation(row.partner_shipping_id)),
        products: sort(products).filter((p) =>
          lines.some(
            (l) =>
              row.order_line.includes(l.id) &&
              l.product_id !== false &&
              relation(l.product_id) === p.id,
          ),
        ),
        countries: sort(countries).filter((c) =>
          partners.some(
            (p) =>
              [
                relation(row.partner_id),
                relation(row.partner_invoice_id),
                relation(row.partner_shipping_id),
              ].includes(p.id) &&
              p.country_id !== false &&
              relation(p.country_id) === c.id,
          ),
        ),
        currency: currencies.find((c) => c.id === relation(row.currency_id)),
        transactions: sort(transactions).filter((t) => row.transaction_ids.includes(t.id)),
        pickings: sort(pickings).filter((p) => row.picking_ids.includes(p.id)),
      },
    }));
  }
}
export function normalizeOdooOrder(raw: any, settings: Record<string, any>, sourceLines = false) {
  const r = raw?._dyna;
  ensure(
    r &&
      Array.isArray(r.lines) &&
      Array.isArray(r.products) &&
      Array.isArray(r.transactions) &&
      Array.isArray(r.pickings) &&
      Array.isArray(r.countries),
    422,
    'Odoo wymaga odczytu powiązanych zasobów zamówienia',
  );
  const id = odooId(raw.id),
    firm = odooId(settings.company_id),
    warehouse = odooId(settings.warehouse_id),
    unit = odooId(settings.unit_id);
  ensure(
    relation(raw.company_id) === firm &&
      relation(raw.warehouse_id) === warehouse &&
      r.context?.company_id === firm &&
      r.context.warehouse_id === warehouse &&
      r.context.unit_id === unit &&
      r.connection.origin ===
        (settings.simulation ? 'https://example.odoo.com' : new URL(settings.server_url).origin) &&
      r.connection.database === (settings.simulation ? 'demo_local' : settings.database),
    422,
    'Zakres ERP zmienił się; ponownie pobierz zamówienie',
  );
  const blockers: string[] = [];
  if (raw.state !== 'sale') blockers.push('Zamówienie nie jest potwierdzoną sprzedażą w Odoo');
  if (raw.delivery_status !== false && raw.delivery_status !== 'pending')
    blockers.push('Realizacja w ERP już się rozpoczęła; uzgodnij magazyn');
  ensure(
    Array.isArray(raw.order_line) &&
      raw.order_line.length > 0 &&
      raw.order_line.length <= 100 &&
      r.lines.length === raw.order_line.length &&
      new Set(r.lines.map((l: any) => l.id)).size === r.lines.length &&
      r.lines.every((l: any) => raw.order_line.includes(odooId(l.id))),
    422,
    'Niepełne pozycje zamówienia Odoo',
  );
  ensure(
    r.currency?.id === relation(raw.currency_id) &&
      r.currency.active &&
      r.currency.decimal_places === 2 &&
      r.currency.rounding === 0.01,
    422,
    'Nieobsługiwana waluta zamówienia Odoo',
  );
  const buyer = r.buyer,
    billing = r.billing,
    address = r.address;
  for (const [p, pid] of [
    [buyer, raw.partner_id],
    [billing, raw.partner_invoice_id],
    [address, raw.partner_shipping_id],
  ])
    ensure(
      p?.id === relation(pid) && (p.company_id === false || relation(p.company_id) === firm),
      422,
      'Niezgodny kontrahent lub adres Odoo',
    );
  ensure(
    relation(buyer.commercial_partner_id) === relation(address.commercial_partner_id) &&
      relation(buyer.commercial_partner_id) === relation(billing.commercial_partner_id),
    422,
    'Adres lub dane faktury należą do innego kontrahenta',
  );
  const country = r.countries.find((c: any) => c.id === relation(address.country_id));
  ensure(country && /^[A-Z]{2}$/.test(country.code), 422, 'Brak kraju adresu Odoo');
  let shipping = 0;
  const items: any[] = [];
  for (const l of r.lines) {
    ensure(
      relation(l.order_id) === id &&
        relation(l.company_id) === firm &&
        relation(l.currency_id) === r.currency.id,
      422,
      'Pozycja należy do innego zamówienia/firmy/waluty',
    );
    const gross = erpMinor(l.price_total);
    ensure(
      erpMinor(l.price_subtotal) + erpMinor(l.price_tax) === gross,
      422,
      'Niezgodna suma VAT pozycji Odoo',
    );
    if (l.display_type) {
      ensure(
        ['line_section', 'line_note', 'line_subsection'].includes(l.display_type) &&
          gross === 0 &&
          l.product_uom_qty === 0,
        422,
        'Nieobsługiwana sekcja zamówienia Odoo',
      );
      continue;
    }
    if (l.is_downpayment || l.is_expense)
      blockers.push('Zaliczki i koszty dodatkowe wymagają osobnego rozliczenia');
    ensure(
      typeof l.qty_delivered === 'number' && Number.isFinite(l.qty_delivered),
      422,
      'Nieznana ilość dostarczona Odoo',
    );
    if (l.qty_delivered !== 0) blockers.push('Pozycja już wydana w ERP wymaga uzgodnienia');
    const product = r.products.find((p: any) => p.id === relation(l.product_id));
    ensure(
      product && (product.company_id === false || relation(product.company_id) === firm),
      422,
      'Brak produktu lub produkt innej firmy',
    );
    const quantity = l.product_uom_qty;
    ensure(
      Number.isInteger(quantity) && quantity > 0 && quantity <= 100000,
      422,
      'Import Odoo wymaga całkowitych ilości',
    );
    if (r.has_delivery_field && l.is_delivery === true) {
      ensure(
        quantity === 1 && product.type === 'service',
        422,
        'Nieprawidłowa pozycja dostawy Odoo',
      );
      shipping += gross;
      continue;
    }
    ensure(
      relation(l.product_uom_id) === unit,
      422,
      'Pozycja Odoo ma inną jednostkę niż wybrane sztuki',
    );
    if (product.type !== 'consu' || product.is_storable !== true)
      blockers.push('Usługi lub produkty bez ewidencji stanu wymagają osobnego procesu');
    if (sourceLines)
      ensure(Number.isSafeInteger(l.id) && l.id > 0, 422, 'Brak rzeczywistego ID pozycji Odoo');
    items.push({
      ...(sourceLines ? { remote_line_id: String(l.id) } : {}),
      external_id: String(product.id),
      name: l.name,
      sku: product.default_code || '',
      quantity,
      line_total: gross,
    });
  }
  ensure(
    items.length > 0 &&
      items.length <= 100 &&
      Number.isSafeInteger(shipping) &&
      shipping <= 1000000,
    422,
    'Brak produktów lub przekroczona dostawa Odoo',
  );
  const total = erpMinor(raw.amount_total);
  ensure(
    erpMinor(raw.amount_untaxed) + erpMinor(raw.amount_tax) === total &&
      items.reduce((n, i) => n + i.line_total, shipping) === total,
    422,
    'Suma pozycji Odoo różni się od kwoty zamówienia',
  );
  ensure(
    r.pickings.length === raw.picking_ids.length &&
      new Set(r.pickings.map((p: any) => p.id)).size === r.pickings.length &&
      r.pickings.every((p: any) => raw.picking_ids.includes(odooId(p.id))),
    422,
    'Niepełne transfery Odoo',
  );
  for (const p of r.pickings) {
    ensure(
      relation(p.company_id) === firm && relation(p.sale_id) === id,
      422,
      'Transfer należy do innej sprzedaży',
    );
    if (p.state === 'done') blockers.push('ERP zawiera zakończony transfer; uzgodnij realizację');
    ensure(
      ['draft', 'waiting', 'confirmed', 'assigned', 'done', 'cancel'].includes(p.state),
      422,
      'Nieznany status transferu Odoo',
    );
  }
  ensure(
    r.transactions.length === raw.transaction_ids.length &&
      new Set(r.transactions.map((t: any) => t.id)).size === r.transactions.length &&
      r.transactions.every((t: any) => raw.transaction_ids.includes(odooId(t.id))),
    422,
    'Niepełne transakcje Odoo',
  );
  let paid = 0;
  for (const t of r.transactions) {
    ensure(
      relation(t.company_id) === firm &&
        relation(t.currency_id) === r.currency.id &&
        Array.isArray(t.sale_order_ids) &&
        t.sale_order_ids.includes(id) &&
        Array.isArray(t.child_transaction_ids),
      422,
      'Nieprawidłowy zakres płatności Odoo',
    );
    ensure(
      ['draft', 'pending', 'authorized', 'done', 'cancel', 'error'].includes(t.state),
      422,
      'Nieznany status transakcji Odoo',
    );
    if (
      t.sale_order_ids.length !== 1 ||
      t.source_transaction_id !== false ||
      t.child_transaction_ids.length ||
      t.operation === 'refund'
    ) {
      blockers.push('Płatność wspólna, podzielona lub zwrot wymagają uzgodnienia');
      continue;
    }
    if (t.operation === 'validation') continue;
    if (t.state === 'done') {
      ensure(
        ['online_redirect', 'online_direct', 'online_token', 'offline'].includes(t.operation),
        422,
        'Nieobsługiwana operacja płatności',
      );
      paid += erpMinor(t.amount);
    }
  }
  ensure(
    Number.isSafeInteger(paid) && paid <= 2147483647,
    422,
    'Kwota płatności Odoo przekracza limit',
  );
  const note = String(raw.note || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    external_id: String(id),
    currency: r.currency.name,
    customer_name: address.name || buyer.name,
    email: buyer.email || billing.email || address.email,
    address: {
      street: [address.street, address.street2].filter(Boolean).join(' '),
      city: address.city || '',
      postal_code: address.zip || '',
      country: country.code,
      phone: address.phone || buyer.phone || '',
    },
    shipping_cost: shipping,
    total,
    paid: total > 0 && paid >= total,
    payment_mode: 'prepaid',
    paid_amount: paid,
    source_status: String(raw.state),
    note: `Odoo ${String(raw.name).slice(0, 100)}${raw.client_order_ref ? ' · ' + String(raw.client_order_ref).slice(0, 100) : ''}. Potwierdzenie sprzedaży nie jest potwierdzeniem wpłaty. ${note}`.slice(
      0,
      2000,
    ),
    items,
    blockers: [...new Set(blockers)],
  };
}
