import { setTimeout } from 'node:timers/promises';
import { ensure, Problem } from './errors';
import { Odoo, odooConfig, odooId, relation, type OdooFence } from './odoo';
import type { Transport } from './integrations';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { odooPdf } from './odoo-pdf-format';
export function erpMinor(v: unknown) {
  ensure(
    typeof v === 'number' && Number.isFinite(v) && v >= 0,
    502,
    'Nieprawidłowa kwota dokumentu Odoo',
  );
  const n = Math.round(v * 100);
  ensure(
    Number.isSafeInteger(n) && n <= 2147483647 && Math.abs(v * 100 - n) < 0.00001,
    502,
    'Kwota Odoo nie jest zapisana w groszach',
  );
  return n;
}
const models = new Set([
  'res.company',
  'res.partner',
  'res.country',
  'account.journal',
  'account.account',
  'account.tax',
  'account.move',
  'account.move.line',
  'ir.attachment',
]);
const moveFields = [
  'id',
  'name',
  'state',
  'move_type',
  'company_id',
  'currency_id',
  'partner_id',
  'journal_id',
  'ref',
  'invoice_origin',
  'invoice_date',
  'invoice_date_due',
  'invoice_line_ids',
  'amount_total',
  'amount_untaxed',
  'amount_tax',
  'payment_state',
  'auto_post',
  'write_date',
];
const lineFields = [
  'id',
  'move_id',
  'name',
  'display_type',
  'quantity',
  'price_total',
  'price_subtotal',
  'account_id',
  'tax_ids',
  'discount',
  'product_uom_id',
  'currency_id',
  'company_id',
];
const clean = (v: any) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
export class OdooAccounting {
  private cfg: ReturnType<typeof odooConfig>;
  private catalog: Odoo;
  constructor(
    private settings: Record<string, string>,
    private credentials: Record<string, string>,
    private transport: Transport,
  ) {
    this.cfg = odooConfig(settings, credentials);
    this.catalog = new Odoo(settings, credentials, transport);
  }
  private async rpc(
    model: string,
    method: 'read' | 'search_read' | 'create' | 'action_post',
    args: any,
    fence?: OdooFence,
  ): Promise<any> {
    const writing = method === 'create' || method === 'action_post';
    ensure(
      models.has(model) &&
        (!writing || model === 'account.move') &&
        (method !== 'search_read' || model === 'account.move'),
      422,
      'Niedozwolona operacja księgowa Odoo',
    );
    const max = writing ? 1 : 3;
    for (let attempt = 0; attempt < max; attempt++) {
      await fence?.();
      const r = await this.transport(`${this.cfg.origin}/json/2/${model}/${method}`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(12000),
        headers: {
          Authorization: 'Bearer ' + this.cfg.key,
          'X-Odoo-Database': this.cfg.database,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          ...args,
          context: {
            allowed_company_ids: [this.cfg.company],
            warehouse_id: this.cfg.warehouse,
            lang: 'en_US',
            ...(model === 'ir.attachment' ? { bin_size: false } : {}),
            ...(writing
              ? {
                  tracking_disable: true,
                  mail_create_nosubscribe: true,
                  mail_notrack: true,
                  mail_auto_subscribe_no_notify: true,
                }
              : {}),
          },
        }),
      }).catch(() => {
        throw new Problem(502, 'Nie udało się odczytać wyniku Odoo; uzgodnij dokument');
      });
      if (!writing && [429, 502, 503, 504].includes(r.status) && attempt < max - 1) {
        const n = Number(r.headers.get('retry-after'));
        await r.body?.cancel();
        await setTimeout(
          Math.min(5000, Math.max(0, Number.isFinite(n) && n >= 0 ? n * 1000 : 200)),
        );
        continue;
      }
      if (!r.ok) {
        await r.body?.cancel();
        throw new Problem(
          [401, 403].includes(r.status) ? r.status : 502,
          'Odoo: HTTP ' + r.status + ' podczas obsługi dokumentu',
        );
      }
      const reader = r.body?.getReader();
      ensure(reader, 502, 'Brak odpowiedzi Odoo');
      let size = 0;
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const p = await reader.read();
          if (p.done) break;
          size += p.value.byteLength;
          ensure(size <= 4 * 1024 * 1024, 502, 'Dokument Odoo przekracza 4 MB');
          chunks.push(p.value);
        }
        const out = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        ensure(
          out === false || typeof out === 'number' || Array.isArray(out),
          502,
          'Nieprawidłowy wynik dokumentu Odoo',
        );
        return out;
      } catch (e) {
        if (e instanceof Problem) throw e;
        throw new Problem(502, 'Nieprawidłowy JSON Odoo');
      } finally {
        await reader.cancel();
      }
    }
    throw new Problem(502, 'Wyczerpano próby odczytu Odoo');
  }
  private async read(model: string, ids: number[], fields: string[], fence?: OdooFence) {
    const unique = [...new Set(ids.map(odooId))];
    const out: any[] = [];
    for (let i = 0; i < unique.length; i += 100) {
      const part = unique.slice(i, i + 100),
        data = await this.rpc(model, 'read', { ids: part, fields }, fence);
      ensure(
        Array.isArray(data) &&
          data.length === part.length &&
          new Set(data.map((r) => odooId(r?.id))).size === data.length &&
          data.every((r) => part.includes(r.id)),
        502,
        'Niepełne lub obce dane księgowe Odoo',
      );
      out.push(...data);
    }
    return out;
  }
  async metadata(source: any, input: any, fence?: OdooFence) {
    const context = await this.catalog.catalogSettings(fence);
    ensure(
      context.currency === source.currency,
      422,
      'Waluta faktury różni się od waluty firmy Odoo; wymagane osobne uzgodnienie FX',
    );
    const [company] = await this.read(
      'res.company',
      [this.cfg.company],
      ['id', 'name', 'vat', 'tax_calculation_rounding_method', 'write_date'],
      fence,
    );
    ensure(
      company.tax_calculation_rounding_method === 'round_per_line',
      422,
      'Globalne zaokrąglanie podatków wymaga osobnego procesu',
    );
    const [journal] = await this.read(
      'account.journal',
      [input.journal_id],
      ['id', 'name', 'type', 'active', 'company_id', 'currency_id', 'write_date'],
      fence,
    );
    ensure(
      journal.active === true &&
        journal.type === 'sale' &&
        relation(journal.company_id) === this.cfg.company &&
        (journal.currency_id === false || relation(journal.currency_id) === context.currency_id),
      422,
      'Niezgodny dziennik sprzedaży Odoo',
    );
    const [account] = await this.read(
      'account.account',
      [input.account_id],
      ['id', 'name', 'code', 'account_type', 'active', 'company_ids', 'currency_id', 'write_date'],
      fence,
    );
    ensure(
      account.active === true &&
        ['income', 'income_other'].includes(account.account_type) &&
        Array.isArray(account.company_ids) &&
        account.company_ids.includes(this.cfg.company) &&
        (account.currency_id === false || relation(account.currency_id) === context.currency_id),
      422,
      'Niezgodne konto przychodów Odoo',
    );
    const [partner] = await this.read(
      'res.partner',
      [input.partner_id],
      [
        'id',
        'name',
        'email',
        'vat',
        'street',
        'street2',
        'zip',
        'city',
        'country_id',
        'active',
        'company_id',
        'write_date',
      ],
      fence,
    );
    ensure(
      partner.active === true &&
        (partner.company_id === false || relation(partner.company_id) === this.cfg.company),
      422,
      'Kontrahent należy do innej firmy lub jest nieaktywny',
    );
    const [country] = await this.read(
      'res.country',
      [relation(partner.country_id)],
      ['id', 'code'],
      fence,
    );
    ensure(
      clean(partner.name) === clean(source.buyer.name) &&
        clean(partner.email).toLowerCase() === clean(source.buyer.email).toLowerCase() &&
        clean([partner.street, partner.street2].filter(Boolean).join(' ')) ===
          clean(source.buyer.street) &&
        clean(partner.city) === clean(source.buyer.city) &&
        clean(partner.zip) === clean(source.buyer.postal_code) &&
        country.code === source.buyer.country &&
        String(partner.vat || '')
          .replace(/^PL/, '')
          .replace(/\s/g, '') === source.buyer.tax_no,
      422,
      'Dane kontrahenta Odoo różnią się od nabywcy dokumentu; uzgodnij dane, bez automatycznego tworzenia kontaktu',
    );
    const taxes = await this.read(
      'account.tax',
      input.taxes.map((t: any) => t.tax_id),
      [
        'id',
        'name',
        'amount',
        'amount_type',
        'type_tax_use',
        'active',
        'company_id',
        'price_include',
        'children_tax_ids',
        'include_base_amount',
        'tax_exigibility',
        'write_date',
      ],
      fence,
    );
    for (const tax of taxes) {
      const mapping = input.taxes.find((t: any) => t.tax_id === tax.id);
      ensure(
        tax.active === true &&
          tax.type_tax_use === 'sale' &&
          tax.amount_type === 'percent' &&
          relation(tax.company_id) === this.cfg.company &&
          tax.amount === mapping.vat &&
          typeof tax.price_include === 'boolean' &&
          Array.isArray(tax.children_tax_ids) &&
          tax.children_tax_ids.length === 0 &&
          !tax.include_base_amount &&
          tax.tax_exigibility === 'on_invoice',
        422,
        'Podatek Odoo nie odpowiada jawnej stawce VAT',
      );
    }
    return { context, company, journal, account, partner, country, taxes };
  }
  async find(reference: string, fence?: OdooFence) {
    const rows = await this.rpc(
      'account.move',
      'search_read',
      {
        domain: [
          ['company_id', '=', this.cfg.company],
          ['move_type', '=', 'out_invoice'],
          ['ref', '=', reference],
        ],
        fields: moveFields,
        order: 'id asc',
        limit: 2,
      },
      fence,
    );
    ensure(
      Array.isArray(rows) && rows.length <= 2,
      502,
      'Nieprawidłowe uzgodnienie dokumentu Odoo',
    );
    ensure(
      rows.length <= 1,
      409,
      'Odoo zawiera więcej niż jeden dokument o tej referencji; wymagane uzgodnienie',
    );
    if (rows.length)
      ensure(
        relation(rows[0].company_id) === this.cfg.company &&
          rows[0].ref === reference &&
          rows[0].move_type === 'out_invoice',
        502,
        'Uzgodnienie zwróciło obcy dokument',
      );
    return rows[0] ?? null;
  }
  async invoice(id: number, fence?: OdooFence) {
    const [move] = await this.read('account.move', [id], moveFields, fence);
    ensure(
      Array.isArray(move.invoice_line_ids) && move.invoice_line_ids.length <= 101,
      502,
      'Niepełne pozycje dokumentu Odoo',
    );
    const lines = await this.read('account.move.line', move.invoice_line_ids, lineFields, fence);
    ensure(
      lines.every((l) => relation(l.move_id) === id),
      502,
      'Pozycja należy do innego dokumentu Odoo',
    );
    return { ...move, lines };
  }
  async create(payload: any, fence?: OdooFence) {
    const ids = await this.rpc('account.move', 'create', { vals_list: [payload] }, fence);
    ensure(Array.isArray(ids) && ids.length === 1, 502, 'Brak ID utworzonej faktury Odoo');
    return odooId(ids[0]);
  }
  async invoicePdf(id: number, fence?: OdooFence) {
    const headerFields = [
      'id',
      'name',
      'company_id',
      'move_type',
      'state',
      'ref',
      'invoice_origin',
      'write_date',
      'invoice_pdf_report_id',
    ];
    const [move] = await this.read('account.move', [odooId(id)], headerFields, fence);
    ensure(
      relation(move.company_id) === this.cfg.company &&
        move.move_type === 'out_invoice' &&
        move.state === 'posted',
      409,
      'PDF wymaga zaksięgowanej faktury wybranej firmy Odoo',
    );
    ensure(
      move.invoice_pdf_report_id,
      404,
      'Odoo nie ma zapisanego PDF tej faktury. Wygeneruj dokument w ERP bez wysyłania wiadomości i pobierz ponownie.',
    );
    ensure(
      typeof move.write_date === 'string' && move.write_date.length > 0,
      502,
      'Brak wersji faktury Odoo',
    );
    const attachmentId = relation(move.invoice_pdf_report_id);
    const fields = [
      'id',
      'name',
      'res_model',
      'res_id',
      'res_field',
      'company_id',
      'mimetype',
      'type',
      'file_size',
      'checksum',
      'write_date',
    ];
    const [before] = await this.read('ir.attachment', [attachmentId], fields, fence);
    ensure(
      before.res_model === 'account.move' &&
        before.res_id === id &&
        before.res_field === 'invoice_pdf_report_file' &&
        relation(before.company_id) === this.cfg.company &&
        before.type === 'binary' &&
        before.mimetype === 'application/pdf' &&
        Number.isInteger(before.file_size) &&
        before.file_size > 0 &&
        before.file_size <= 2097152 &&
        typeof before.checksum === 'string' &&
        /^[a-f0-9]{40}$/.test(before.checksum) &&
        typeof before.write_date === 'string' &&
        before.write_date.length > 0,
      502,
      'Załącznik Odoo nie odpowiada PDF tej faktury lub przekracza 2 MiB',
    );
    const [attachment] = await this.read(
      'ir.attachment',
      [attachmentId],
      [...fields, 'datas'],
      fence,
    );
    const { datas, ...metadata } = attachment;
    ensure(isDeepStrictEqual(before, metadata), 409, 'PDF Odoo zmienił się podczas odczytu');
    const pdf = odooPdf(datas);
    ensure(
      pdf.length === before.file_size &&
        createHash('sha1').update(pdf).digest('hex') === before.checksum,
      502,
      'Bajty PDF Odoo nie odpowiadają metadanym załącznika',
    );
    const [after] = await this.read('ir.attachment', [attachmentId], fields, fence);
    const [moveAfter] = await this.read('account.move', [id], headerFields, fence);
    ensure(
      isDeepStrictEqual(before, after) && isDeepStrictEqual(move, moveAfter),
      409,
      'PDF lub faktura Odoo zmieniły się podczas odczytu',
    );
    await fence?.();
    return {
      pdf,
      attachment_id: String(attachmentId),
      write_date: before.write_date,
      move_header: moveAfter,
    };
  }
  async post(id: number, fence?: OdooFence) {
    await this.rpc('account.move', 'action_post', { ids: [odooId(id)] }, fence);
  }
}
export function accountingPayload(reference: string, source: any, input: any, metadata: any) {
  return {
    move_type: 'out_invoice',
    company_id: metadata.context.company_id,
    currency_id: metadata.context.currency_id,
    journal_id: input.journal_id,
    partner_id: input.partner_id,
    ref: reference,
    invoice_origin: source.number,
    invoice_date: input.invoice_date,
    invoice_date_due: input.due_date,
    invoice_payment_term_id: false,
    fiscal_position_id: false,
    auto_post: 'no',
    invoice_line_ids: source.lines.map((line: any) => {
      const tax = metadata.taxes.find(
        (t: any) => t.id === input.taxes.find((t: any) => t.vat === line.vat).tax_id,
      );
      const unit = line.gross / 100 / line.quantity / (tax.price_include ? 1 : 1 + line.vat / 100);
      return [
        0,
        0,
        {
          name: line.name,
          quantity: line.quantity,
          price_unit: Number(unit.toFixed(10)),
          discount: 0,
          account_id: input.account_id,
          product_uom_id: metadata.context.unit_id,
          tax_ids: [[6, 0, [tax.id]]],
        },
      ];
    }),
  };
}
export function verifyOdooInvoice(plan: any, move: any, posted = false) {
  const { source, metadata } = plan.snapshot,
    x = plan.input;
  ensure(
    move.ref === plan.reference &&
      move.invoice_origin === source.number &&
      move.move_type === 'out_invoice' &&
      relation(move.company_id) === metadata.context.company_id &&
      relation(move.currency_id) === metadata.context.currency_id &&
      relation(move.partner_id) === x.partner_id &&
      relation(move.journal_id) === x.journal_id &&
      move.invoice_date === x.invoice_date &&
      move.invoice_date_due === x.due_date &&
      move.auto_post === 'no' &&
      ['draft', 'posted'].includes(move.state) &&
      (!posted || move.state === 'posted'),
    409,
    'Dane faktury Odoo różnią się od podglądu',
  );
  ensure(
    erpMinor(move.amount_total) === source.total &&
      erpMinor(move.amount_untaxed) ===
        source.lines.reduce(
          (n: number, l: any) => n + Math.round((l.gross * 100) / (100 + l.vat)),
          0,
        ) &&
      erpMinor(move.amount_untaxed) + erpMinor(move.amount_tax) === source.total,
    409,
    'Suma faktury Odoo różni się od źródła',
  );
  ensure(
    Array.isArray(move.lines) && move.lines.length === source.lines.length,
    409,
    'Pozycje faktury Odoo różnią się od źródła',
  );
  const keys = (line: any) =>
    JSON.stringify([line.name, line.quantity, line.gross, line.net, line.tax_id]);
  const expected = source.lines
    .map((l: any) =>
      keys({
        ...l,
        net: Math.round((l.gross * 100) / (100 + l.vat)),
        tax_id: x.taxes.find((t: any) => t.vat === l.vat).tax_id,
      }),
    )
    .sort();
  const actual = move.lines
    .map((l: any) => {
      ensure(
        l.display_type === 'product' &&
          Number.isInteger(l.quantity) &&
          l.quantity > 0 &&
          l.discount === 0 &&
          relation(l.company_id) === metadata.context.company_id &&
          relation(l.currency_id) === metadata.context.currency_id &&
          relation(l.account_id) === x.account_id &&
          relation(l.product_uom_id) === metadata.context.unit_id &&
          Array.isArray(l.tax_ids) &&
          l.tax_ids.length === 1 &&
          erpMinor(l.price_subtotal) <= erpMinor(l.price_total),
        409,
        'Niezgodna pozycja finansowa Odoo',
      );
      return keys({
        name: l.name,
        quantity: l.quantity,
        gross: erpMinor(l.price_total),
        net: erpMinor(l.price_subtotal),
        tax_id: l.tax_ids[0],
      });
    })
    .sort();
  ensure(
    JSON.stringify(actual) === JSON.stringify(expected),
    409,
    'Kwoty, VAT lub ilości pozycji Odoo różnią się od źródła',
  );
  ensure(
    !posted ||
      (typeof move.name === 'string' &&
        move.name.length > 0 &&
        move.name !== '/' &&
        move.name.length <= 200),
    502,
    'Brak numeru zaksięgowanej faktury Odoo',
  );
  return {
    id: String(odooId(move.id)),
    number: move.state === 'posted' ? move.name : null,
    state: move.state,
    total: erpMinor(move.amount_total),
    currency: source.currency,
    payment_state: String(move.payment_state ?? '').slice(0, 80),
    accounting_payment_not_imported: true,
  };
}
export function simulatedAccounting(source: any, input: any) {
  return {
    context: {
      currency: source.currency,
      currency_id: 1,
      company_id: 1,
      warehouse_id: 1,
      unit_id: 1,
    },
    company: {
      id: 1,
      name: 'Firma ERP — przykład lokalny',
      vat: 'PL5260250274',
      tax_calculation_rounding_method: 'round_per_line',
    },
    journal: { id: input.journal_id, name: 'Sprzedaż DEMO' },
    account: { id: input.account_id, name: 'Przychody DEMO' },
    partner: { id: input.partner_id, ...source.buyer },
    country: { code: source.buyer.country },
    taxes: input.taxes.map((t: any) => ({
      id: t.tax_id,
      name: `VAT ${t.vat}% DEMO`,
      amount: t.vat,
      price_include: true,
    })),
  };
}
export function simulatedInvoice(plan: any, state = 'posted') {
  const { metadata: m, source: s } = plan.snapshot,
    x = plan.input,
    id = Number(BigInt('0x' + plan.id.replaceAll('-', '').slice(0, 7)));
  const net = s.lines.reduce(
    (n: number, l: any) => n + Math.round((l.gross * 100) / (100 + l.vat)),
    0,
  );
  return {
    id,
    name: state === 'posted' ? 'DEMO-ODOO-FV/' + plan.id.slice(0, 8) : '/',
    state,
    move_type: 'out_invoice',
    company_id: [m.context.company_id, 'Firma'],
    currency_id: [m.context.currency_id, s.currency],
    partner_id: [x.partner_id, s.buyer.name],
    journal_id: [x.journal_id, 'Sprzedaż'],
    ref: plan.reference,
    invoice_origin: s.number,
    invoice_date: x.invoice_date,
    invoice_date_due: x.due_date,
    auto_post: 'no',
    amount_total: s.total / 100,
    amount_untaxed: net / 100,
    amount_tax: (s.total - net) / 100,
    payment_state: 'not_paid',
    lines: s.lines.map((l: any, i: number) => ({
      id: i + 1,
      move_id: [id, 'Faktura'],
      name: l.name,
      display_type: 'product',
      quantity: l.quantity,
      price_total: l.gross / 100,
      price_subtotal: Math.round((l.gross * 100) / (100 + l.vat)) / 100,
      account_id: [x.account_id, 'Przychody'],
      tax_ids: [x.taxes.find((t: any) => t.vat === l.vat).tax_id],
      discount: 0,
      product_uom_id: [m.context.unit_id, 'szt.'],
      currency_id: [m.context.currency_id, s.currency],
      company_id: [m.context.company_id, 'Firma'],
    })),
  };
}
