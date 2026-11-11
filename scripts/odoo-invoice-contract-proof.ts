import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
const sources = [
  {
    url: 'https://raw.githubusercontent.com/odoo/documentation/19.0/content/developer/reference/external_api.rst',
    markers: ['X-Odoo-Database', '/json/2', 'transaction'],
  },
  {
    url: 'https://raw.githubusercontent.com/odoo/odoo/19.0/addons/rpc/controllers/json2.py',
    markers: ['result.ids', 'signature.bind'],
  },
  {
    url: 'https://raw.githubusercontent.com/odoo/odoo/19.0/addons/account/models/account_account.py',
    markers: ['company_ids', 'income_other'],
  },
  {
    url: 'https://raw.githubusercontent.com/odoo/odoo/19.0/addons/account/models/account_move.py',
    markers: ['invoice_line_ids', 'invoice_date_due', 'action_post', '_post(soft=False)'],
  },
  {
    url: 'https://raw.githubusercontent.com/odoo/odoo/19.0/addons/account/models/account_move_line.py',
    markers: ['product_uom_id', 'price_total', 'price_subtotal', 'display_type'],
  },
  {
    url: 'https://raw.githubusercontent.com/odoo/odoo/19.0/addons/account/models/account_tax.py',
    markers: ['price_include', 'tax_exigibility', 'include_base_amount'],
  },
  {
    url: 'https://raw.githubusercontent.com/odoo/odoo/19.0/addons/account/models/account_journal.py',
    markers: ["('sale', 'Sales')", 'company_id', 'currency_id'],
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
await writeFile('docs/odoo-invoice-contract-qa.json', JSON.stringify(report, null, 2) + '\n');
console.log({ public_sources: evidence.length, status: 200, provider_authenticated: false });
