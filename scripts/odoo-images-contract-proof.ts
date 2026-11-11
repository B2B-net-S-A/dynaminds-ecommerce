import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
const sources = [
  {
    url: 'https://raw.githubusercontent.com/odoo/documentation/19.0/content/developer/reference/external_api.rst',
    markers: ['X-Odoo-Database', '/json/2', 'transaction'],
  },
  {
    url: 'https://raw.githubusercontent.com/odoo/odoo/19.0/addons/product/models/product_product.py',
    markers: [
      'image_variant_1920 = fields.Image',
      'image_1920 = fields.Image',
      'record.image_variant_1920 or record.product_tmpl_id.image_1920',
    ],
  },
  {
    url: 'https://raw.githubusercontent.com/odoo/odoo/19.0/odoo/addons/base/models/ir_attachment.py',
    markers: ['base64.b64encode(attach.raw', 'bin_size'],
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
  scope: 'official_public_JSON2_and_primary_image_models_Odoo19',
  provider_authenticated: false,
  JSON2_provider_requests: 0,
  sources: evidence,
};
await writeFile('docs/odoo-images-contract-qa.json', JSON.stringify(report, null, 2) + '\n');
console.log({ public_sources: evidence.length, status: 200, provider_authenticated: false });
