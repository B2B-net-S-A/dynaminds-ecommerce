import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
const sources = [
  {
    url: 'https://raw.githubusercontent.com/odoo/documentation/19.0/content/developer/reference/external_api.rst',
    markers: ['X-Odoo-Database', '/json/2', 'search_read'],
  },
  {
    url: 'https://raw.githubusercontent.com/odoo/odoo/19.0/addons/product/models/product_product.py',
    markers: ['lst_price', 'product_template_attribute_value_ids'],
  },
  {
    url: 'https://raw.githubusercontent.com/odoo/odoo/19.0/addons/product/models/product_template.py',
    markers: ['product_variant_count', 'currency_id'],
  },
  {
    url: 'https://raw.githubusercontent.com/odoo/odoo/19.0/addons/stock/models/product.py',
    markers: ['free_qty', 'warehouse_id', 'is_storable'],
  },
  {
    url: 'https://raw.githubusercontent.com/odoo/odoo/19.0/addons/product/models/product_template_attribute_value.py',
    markers: ['attribute_id', 'product_tmpl_id'],
  },
  {
    url: 'https://raw.githubusercontent.com/odoo/odoo/19.0/addons/uom/models/uom_uom.py',
    markers: ['rounding'],
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
await writeFile('docs/odoo-contract-qa.json', JSON.stringify(report, null, 2) + '\n');
console.log({ public_sources: evidence.length, status: 200, provider_authenticated: false });
