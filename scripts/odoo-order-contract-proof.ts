import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
const sources = [
  {
    url: 'https://raw.githubusercontent.com/odoo/documentation/19.0/content/developer/reference/external_api.rst',
    markers: ['X-Odoo-Database', '/json/2', 'transaction'],
  },
  {
    url: 'https://raw.githubusercontent.com/odoo/odoo/19.0/addons/sale/models/sale_order.py',
    markers: ['amount_paid', 'authorized', 'transaction_ids'],
  },
  {
    url: 'https://raw.githubusercontent.com/odoo/odoo/19.0/addons/sale/models/sale_order_line.py',
    markers: ['product_uom_id', 'qty_delivered', 'price_total'],
  },
  {
    url: 'https://raw.githubusercontent.com/odoo/odoo/19.0/addons/sale_stock/models/sale_order.py',
    markers: ['warehouse_id', 'delivery_status', 'picking_ids'],
  },
  {
    url: 'https://raw.githubusercontent.com/odoo/odoo/19.0/addons/delivery/models/sale_order_line.py',
    markers: ['is_delivery'],
  },
  {
    url: 'https://raw.githubusercontent.com/odoo/odoo/19.0/addons/payment/models/payment_transaction.py',
    markers: ['child_transaction_ids', 'source_transaction_id', 'company_id'],
  },
  {
    url: 'https://raw.githubusercontent.com/odoo/odoo/19.0/addons/sale/models/payment_transaction.py',
    markers: ['sale_order_ids'],
  },
  {
    url: 'https://raw.githubusercontent.com/odoo/odoo/19.0/addons/sale_stock/models/stock.py',
    markers: ['sale_id'],
  },
  {
    url: 'https://raw.githubusercontent.com/odoo/odoo/19.0/odoo/orm/models.py',
    markers: ['def fields_get', 'allfields', 'attributes'],
  },
];
const evidence = await Promise.all(
  sources.map(async (s) => {
    const r = await fetch(s.url, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw Error('Public contract HTTP ' + r.status + ' ' + s.url);
    const body = await r.text();
    for (const marker of s.markers)
      if (!body.includes(marker)) throw Error('Missing marker ' + marker);
    return {
      url: s.url,
      http_status: r.status,
      bytes: Buffer.byteLength(body),
      sha256: createHash('sha256').update(body).digest('hex'),
      field_markers_verified: s.markers,
    };
  }),
);
const report = {
  checked_at: new Date().toISOString(),
  scope: 'official_public_documentation_and_model_sources_Odoo19',
  provider_authenticated: false,
  JSON2_provider_requests: 0,
  sources: evidence,
};
await writeFile('docs/odoo-order-contract-qa.json', JSON.stringify(report, null, 2) + '\n');
console.log({ public_sources: evidence.length, status: 200, provider_authenticated: false });
