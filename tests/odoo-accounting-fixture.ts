import assert from 'node:assert/strict';
import type { Transport } from '../server/integrations';
import { odooSettings, odooCredentials } from './odoo-fixtures';
export { odooSettings, odooCredentials };
export function accountingFixture() {
  const calls: any[] = [];
  const moves = new Map<number, any>();
  const lines = new Map<number, any>();
  const models: any = {
    'res.company': [
      {
        id: 1,
        name: 'QA ERP',
        currency_id: [1, 'PLN'],
        vat: 'PL5260250274',
        tax_calculation_rounding_method: 'round_per_line',
        write_date: '2026-10-04 10:00:00',
      },
    ],
    'stock.warehouse': [{ id: 1, name: 'ERP', company_id: [1, 'QA ERP'] }],
    'res.currency': [{ id: 1, name: 'PLN', decimal_places: 2, rounding: 0.01, active: true }],
    'uom.uom': [{ id: 1, name: 'Units', rounding: 1 }],
    'res.country': [{ id: 1, code: 'PL' }],
    'res.partner': [
      {
        id: 1,
        name: 'Klient QA',
        email: 'invoice@example.test',
        vat: false,
        street: 'Testowa 1',
        street2: false,
        zip: '00-001',
        city: 'Warszawa',
        country_id: [1, 'Poland'],
        company_id: false,
        active: true,
        write_date: '2026-10-04 10:00:00',
      },
    ],
    'account.journal': [
      {
        id: 1,
        name: 'Sprzedaż QA',
        type: 'sale',
        active: true,
        company_id: [1, 'QA ERP'],
        currency_id: false,
        write_date: '2026-10-04 10:00:00',
      },
    ],
    'account.account': [
      {
        id: 1,
        name: 'Przychody QA',
        code: '700',
        account_type: 'income',
        active: true,
        company_ids: [1],
        currency_id: false,
        write_date: '2026-10-04 10:00:00',
      },
    ],
    'account.tax': [
      {
        id: 24,
        name: 'VAT23',
        amount: 23,
        amount_type: 'percent',
        type_tax_use: 'sale',
        active: true,
        company_id: [1, 'QA ERP'],
        price_include: true,
        children_tax_ids: [],
        include_base_amount: false,
        tax_exigibility: 'on_invoice',
        write_date: '2026-10-04 10:00:00',
      },
    ],
  };
  const state = {
    loseCreate: false,
    rejectCreate: false,
    losePost: false,
    rejectPost: false,
    badGross: false,
    hook: undefined as undefined | ((call: any) => Promise<void>),
  };
  let next = 10000;
  const transport: Transport = async (url, init) => {
    const [, model, method] = new URL(url).pathname.match(/^\/json\/2\/([^/]+)\/([^/]+)$/) ?? [];
    const args = JSON.parse(String(init.body)),
      writing = ['create', 'action_post'].includes(method);
    assert.equal(new URL(url).origin, odooSettings.server_url);
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal((init.headers as any).Authorization, 'Bearer ' + odooCredentials.api_key);
    assert.equal((init.headers as any)['X-Odoo-Database'], odooSettings.database);
    assert.deepEqual(args.context, {
      allowed_company_ids: [1],
      warehouse_id: 1,
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
    });
    const call = { model, method, args };
    calls.push(call);
    await state.hook?.(call);
    const json = (v: any) => new Response(JSON.stringify(v));
    if (method === 'create') {
      assert.equal(model, 'account.move');
      assert.equal(args.ids, undefined);
      assert.equal(args.vals_list.length, 1);
      if (state.rejectCreate) throw Error('unknown api key fixture');
      const p = args.vals_list[0],
        id = next++;
      assert.equal(p.move_type, 'out_invoice');
      assert.equal(p.auto_post, 'no');
      assert.equal(p.invoice_payment_term_id, false);
      assert.equal(p.fiscal_position_id, false);
      assert.equal(p.company_id, 1);
      assert.equal(p.currency_id, 1);
      let net = 0,
        total = 0;
      const lids = p.invoice_line_ids.map((command: any) => {
        assert.equal(command[0], 0);
        assert.equal(command[1], 0);
        const l = command[2],
          tax = models['account.tax'].find((t: any) => t.id === l.tax_ids[0][2][0]),
          lid = next++;
        const raw = l.quantity * l.price_unit,
          gross = tax.price_include ? raw : raw * (1 + tax.amount / 100);
        const subtotal =
          Math.round((tax.price_include ? raw / (1 + tax.amount / 100) : raw) * 100) / 100;
        const lineTotal = Math.round(gross * 100) / 100;
        net += Math.round(subtotal * 100);
        total += Math.round(lineTotal * 100);
        lines.set(lid, {
          ...l,
          id: lid,
          display_type: 'product',
          move_id: [id, 'Invoice'],
          company_id: [1, 'ERP'],
          currency_id: [1, 'PLN'],
          account_id: [l.account_id, 'Revenue'],
          product_uom_id: [l.product_uom_id, 'Units'],
          tax_ids: [tax.id],
          price_subtotal: subtotal,
          price_total: lineTotal,
        });
        return lid;
      });
      moves.set(id, {
        ...p,
        id,
        name: '/',
        state: 'draft',
        company_id: [p.company_id, 'ERP'],
        currency_id: [p.currency_id, 'PLN'],
        partner_id: [p.partner_id, 'Buyer'],
        journal_id: [p.journal_id, 'Sales'],
        invoice_line_ids: lids,
        amount_total: total / 100,
        amount_untaxed: net / 100,
        amount_tax: (total - net) / 100,
        payment_state: 'not_paid',
      });
      if (state.loseCreate) {
        state.loseCreate = false;
        throw Error('lost secret result');
      }
      return json([id]);
    }
    if (method === 'action_post') {
      assert.equal(model, 'account.move');
      const m = moves.get(args.ids[0]);
      assert(m);
      if (!state.rejectPost) {
        m.state = 'posted';
        m.name = 'FV-QA/' + m.id;
      }
      if (state.losePost || state.rejectPost) {
        state.losePost = false;
        throw Error('lost post response secret');
      }
      return json(false);
    }
    let rows: any[];
    if (method === 'search_read') {
      assert.equal(model, 'account.move');
      assert.equal(args.limit, 2);
      assert.deepEqual(args.domain.slice(0, 2), [
        ['company_id', '=', 1],
        ['move_type', '=', 'out_invoice'],
      ]);
      rows = [...moves.values()].filter((m) => m.ref === args.domain[2][2]).slice(0, 2);
    } else {
      assert.equal(method, 'read');
      rows = (
        model === 'account.move'
          ? [...moves.values()]
          : model === 'account.move.line'
            ? [...lines.values()]
            : models[model]
      ).filter((r: any) => args.ids.includes(r.id));
    }
    rows = structuredClone(rows).map((r) =>
      Object.fromEntries(args.fields.map((k: string) => [k, r[k]])),
    );
    if (state.badGross && model === 'account.move') rows.forEach((r) => (r.amount_total = 0.01));
    return json(rows);
  };
  return { transport, calls, models, moves, lines, state };
}
