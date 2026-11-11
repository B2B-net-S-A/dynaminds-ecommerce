import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
const sources = [
  {
    url: 'https://raw.githubusercontent.com/odoo/documentation/19.0/content/developer/reference/external_api.rst',
    markers: ['X-Odoo-Database', '/json/2', 'transaction'],
  },
  {
    url: 'https://raw.githubusercontent.com/odoo/odoo/19.0/addons/account/models/account_move.py',
    markers: [
      'invoice_pdf_report_id = fields.Many2one',
      'invoice_pdf_report_file = fields.Binary',
      'invoice_pdf.raw',
    ],
  },
  {
    url: 'https://raw.githubusercontent.com/odoo/odoo/19.0/odoo/addons/base/models/ir_attachment.py',
    markers: [
      'base64.b64encode(attach.raw',
      'human_size(attach.file_size)',
      'hashlib.sha1',
      'res_field = fields.Char',
      'default=lambda self: self.env.company',
    ],
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
await writeFile('docs/odoo-invoice-pdf-contract-qa.json', JSON.stringify(report, null, 2) + '\n');
console.log({ public_sources: evidence.length, status: 200, provider_authenticated: false });
