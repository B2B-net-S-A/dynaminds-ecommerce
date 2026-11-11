import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { demoOdooCatalog } from '../server/odoo-catalog';
import type { Transport } from '../server/integrations';
export const odooSettings = {
  server_url: 'https://erp.odoo.com',
  database: 'qa_db',
  company_id: '1',
  warehouse_id: '1',
  unit_id: '1',
  price_mode: 'net',
};
export const odooCredentials = { api_key: 'fixture_odoo_' + 'a'.repeat(32) };
export function odooFixture(count = 2) {
  const suffix = randomUUID().slice(0, 8);
  const rows = Array.from({ length: count }, (_, i) => ({
    ...demoOdooCatalog()[i % 2],
    id: 101 + i,
    default_code: 'OD-QA-' + suffix + '-' + (101 + i),
    product_template_attribute_value_ids: [101 + i],
    free_qty: 12 + i,
  }));
  const calls: any[] = [];
  const state: {
    currency: string;
    foreignWarehouse: boolean;
    hook?: () => Promise<void>;
    edit?: (model: string, method: string, data: any[], args: any) => void;
  } = { currency: 'PLN', foreignWarehouse: false };
  const transport: Transport = async (url, init) => {
    const path = new URL(url).pathname;
    const [, model, method] = path.match(/^\/json\/2\/([^/]+)\/(read|search_read)$/) ?? [];
    assert(model && method, 'Only fixed JSON-2 reads');
    assert.equal(init.method, 'POST');
    assert.equal((init.headers as any).Authorization, 'Bearer ' + odooCredentials.api_key);
    assert.equal((init.headers as any)['X-Odoo-Database'], 'qa_db');
    const args = JSON.parse(String(init.body));
    assert.deepEqual(args.context, {
      allowed_company_ids: [1],
      warehouse_id: 1,
      lang: 'en_US',
      ...(model === 'product.product' && args.fields.includes('image_1920')
        ? { bin_size: false }
        : {}),
    });
    calls.push({ model, method, args });
    const dict: any = {
      'res.company': [{ id: 1, name: 'QA Odoo', currency_id: [1, state.currency] }],
      'stock.warehouse': [
        {
          id: 1,
          name: 'QA ERP Warehouse',
          company_id: [state.foreignWarehouse ? 2 : 1, 'QA Odoo'],
        },
      ],
      'res.currency': [
        { id: 1, name: state.currency, decimal_places: 2, rounding: 0.01, active: true },
      ],
      'uom.uom': [{ id: 1, name: 'Units', rounding: 1 }],
      'product.product': rows,
      'product.template': [rows[0]?.template ?? demoOdooCatalog()[0].template],
      'product.template.attribute.value': rows.map((p) => ({
        id: p.id,
        name: p.attributes[0].value,
        attribute_id: [1, 'Kolor'],
        product_tmpl_id: [10, 'Koszulka Odoo'],
      })),
    };
    let data: any[] =
      method === 'search_read'
        ? rows.filter((p) => p.id > args.domain[0][2]).slice(0, args.limit)
        : dict[model].filter((r: any) => args.ids.includes(r.id));
    data = structuredClone(data).map((r) =>
      Object.fromEntries(args.fields.map((k: string) => [k, r[k]])),
    );
    const hook = state.hook;
    state.hook = undefined;
    await hook?.();
    state.edit?.(model, method, data, args);
    return new Response(JSON.stringify(data));
  };
  return { rows, calls, state, transport };
}
