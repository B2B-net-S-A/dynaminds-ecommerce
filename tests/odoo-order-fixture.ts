import assert from 'node:assert/strict';
import { demoOdooOrder } from '../server/odoo-order-example';
import { odooSettings, odooCredentials } from './odoo-fixtures';
import type { Transport } from '../server/integrations';
export { odooSettings, odooCredentials };
export function odooOrderFixture(count = 1) {
  const orders = Array.from({ length: count }, (_, i) => {
    const id = 2001 + i,
      r = demoOdooOrder(id);
    r._dyna.connection = { origin: odooSettings.server_url, database: odooSettings.database };
    r.order_line = [id * 10 + 1, id * 10 + 2];
    r._dyna.lines.forEach((l, j) => (l.id = r.order_line[j]));
    r.transaction_ids = [id * 10 + 3];
    r._dyna.transactions[0].id = r.transaction_ids[0];
    r.picking_ids = [id * 10 + 4];
    r._dyna.pickings[0].id = r.picking_ids[0];
    return r;
  });
  const calls: any[] = [];
  const state = {
    delivery: true,
    hook: undefined as undefined | ((call: any) => Promise<void>),
    edit: undefined as undefined | ((model: string, method: string, data: any) => void),
  };
  const transport: Transport = async (url, init) => {
    const [, model, method] =
      new URL(url).pathname.match(/^\/json\/2\/([^/]+)\/(read|search_read|fields_get)$/) ?? [];
    assert(model && method);
    assert.equal(new URL(url).origin, odooSettings.server_url);
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal((init.headers as any).Authorization, 'Bearer ' + odooCredentials.api_key);
    assert.equal((init.headers as any)['X-Odoo-Database'], 'qa_db');
    const args = JSON.parse(String(init.body));
    assert.deepEqual(args.context, { allowed_company_ids: [1], warehouse_id: 1, lang: 'en_US' });
    const call = { model, method, args };
    calls.push(call);
    let data: any;
    if (method === 'fields_get') {
      assert.equal(model, 'sale.order.line');
      assert.deepEqual(args.allfields, ['is_delivery']);
      assert.deepEqual(args.attributes, ['type']);
      data = state.delivery ? { is_delivery: { type: 'boolean' } } : {};
    } else {
      const all: any = {
        'sale.order': orders,
        'sale.order.line': orders.flatMap((r) => r._dyna.lines),
        'product.product': orders[0] ? orders[0]._dyna.products : demoOdooOrder()._dyna.products,
        'res.partner': [orders[0] ? orders[0]._dyna.buyer : demoOdooOrder()._dyna.buyer],
        'res.country': [{ id: 1, code: 'PL' }],
        'res.company': [{ id: 1, name: 'Firma ERP — przykład lokalny', currency_id: [1, 'PLN'] }],
        'res.currency': [{ id: 1, name: 'PLN', decimal_places: 2, rounding: 0.01, active: true }],
        'stock.warehouse': [{ id: 1, name: 'Magazyn ERP', company_id: [1, 'ERP'] }],
        'uom.uom': [{ id: 1, name: 'Units', rounding: 1 }],
        'payment.transaction': orders.flatMap((r) => r._dyna.transactions),
        'stock.picking': orders.flatMap((r) => r._dyna.pickings),
      };
      if (method === 'search_read') {
        assert.equal(model, 'sale.order');
        assert.equal(args.order, 'write_date asc,id asc');
        assert.equal(args.limit, 11);
        assert.deepEqual(args.domain.slice(0, 3), [
          ['company_id', '=', 1],
          ['warehouse_id', '=', 1],
          ['state', 'in', ['sale', 'cancel']],
        ]);
        const bound = (op: string) =>
          args.domain.find(
            (d: any) => Array.isArray(d) && d[0] === 'write_date' && d[1] === op,
          )?.[2];
        const afterId = args.domain.find((d: any) => Array.isArray(d) && d[0] === 'id')?.[2];
        data = orders
          .filter(
            (r) =>
              r.write_date <= bound('<=') &&
              (!bound('>=') || r.write_date >= bound('>=')) &&
              (!bound('>') ||
                r.write_date > bound('>') ||
                (r.write_date === bound('=') && r.id > afterId)),
          )
          .slice(0, args.limit);
      } else {
        assert.equal(method, 'read');
        assert(args.ids.length <= 100);
        data = all[model].filter((r: any) => args.ids.includes(r.id));
      }
      data = structuredClone(data).map((r: any) =>
        Object.fromEntries(args.fields.map((k: string) => [k, r[k]])),
      );
    }
    await state.hook?.(call);
    state.edit?.(model, method, data);
    return new Response(JSON.stringify(data));
  };
  return { orders, calls, state, transport };
}
