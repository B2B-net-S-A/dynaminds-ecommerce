import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
const path = 'data/odoo-images-stage059.json',
  phase = process.argv[2],
  email = 'qa-odoo-images@demo.local';
let cookie = '';
const save = (s: any) => writeFile(path, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
async function api(p: string, method = 'GET', body?: any) {
  const r = await fetch('http://127.0.0.1:4100/api' + p, {
    method,
    headers: {
      cookie,
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(p === '/orders' ? { 'idempotency-key': randomUUID() } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
  assert(r.ok, `${method} ${p}: ${r.status} ${await r.clone().text()}`);
  return (await r.json()) as any;
}
async function fingerprint(t: string, tenants: string[]) {
  const rows = (
    await pool.query(
      `SELECT to_jsonb(t)::text row FROM ${t} t WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1`,
      [tenants],
    )
  ).rows;
  return {
    count: rows.length,
    sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
  };
}
try {
  if (phase === 'baseline') {
    const prev = JSON.parse(await readFile('data/odoo-invoice-pdf-stage058.json', 'utf8')),
      tenants = (await pool.query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id),
      before: any = {};
    for (const table of [...Object.keys(prev.before), 'odoo_invoice_files'])
      before[table] = await fingerprint(table, tenants);
    await save({ tenants, before, excluded: prev.excluded });
    console.log({ tenants: tenants.length, tables: Object.keys(before).length });
  } else {
    const s = JSON.parse(await readFile(path, 'utf8'));
    if (phase === 'setup') {
      assert(!s.fixture);
      await api('/auth/signup', 'POST', {
        email,
        password: 'DynaDemo!2026',
        name: 'QA Zdjęcia Odoo',
        organization: { name: 'QA Zdjęcia Odoo 20261004', currency: 'PLN', locale: 'pl-PL' },
      });
      const membership = { tenant_id: (await api('/auth/me')).user.tenant_id };
      await api('/workspaces/plan', 'PATCH', { plan: 'enterprise' });
      const ch = await api('/integrations/odoo-example', 'POST', {}),
        warehouse = (await api('/warehouses')).data[0].id;
      const p = await api('/products', 'POST', {
        name: 'Torba QA — zdjęcie Odoo',
        sku: 'OD-PHOTO-QA-' + randomUUID().slice(0, 8),
        price: 12345,
        vat: 23,
        warehouse_id: warehouse,
        quantity: 12,
      });
      const channel = ch.channel_id;
      await pool.query(
        "INSERT INTO listings(id,tenant_id,channel_id,product_id,external_id,parent_external_id,price,status) VALUES($1,$2,$3,$4,'101','template:10',12345,'simulation')",
        [randomUUID(), membership.tenant_id, channel, p.id],
      );
      s.fixture = {
        email,
        tenant: membership.tenant_id,
        product: p.id,
        channel,
        version: p.version,
        sku: p.sku,
        warehouse,
        product_before: await api('/products/' + p.id),
      };
      await save(s);
      console.log(s.fixture);
    } else if (phase === 'flow' || phase === 'verify') {
      await api('/auth/login', 'POST', { email, password: 'DynaDemo!2026' });
      const h = await api('/health');
      assert.equal(h.schema_revision, '045_odoo_image_imports');
      if (phase === 'verify') assert.equal(h.revision, process.argv[3]);
      const f = s.fixture,
        product = await api('/products/' + f.product),
        history = (await api(`/products/${f.product}/odoo-images`)).history;
      const image = history.find((p: any) => p.state === 'applied');
      assert(image);
      assert.equal(image.mode, 'simulation');
      assert(product.images.includes(image.url));
      assert.equal(product.price, f.product_before.price);
      assert.deepEqual(product.stock, f.product_before.stock);
      assert.equal(product.version, f.version + 1);
      const bytes = Buffer.from(
        await (
          await fetch('http://127.0.0.1:4100' + image.url, { headers: { cookie } })
        ).arrayBuffer(),
      );
      assert.equal(createHash('sha256').update(bytes).digest('hex'), image.sha256);
      for (const [t, expected] of Object.entries(s.before))
        assert.deepEqual(await fingerprint(t, s.tenants), expected, t);
      assert.equal(
        (
          await pool.query(
            'SELECT 1 FROM odoo_image_imports WHERE tenant_id=ANY($1::uuid[]) LIMIT 1',
            [s.tenants],
          )
        ).rowCount,
        0,
      );
      f.preview = image.id;
      f.image = image.image_id;
      f.sha256 = image.sha256;
      const report = {
        checked_at: new Date().toISOString(),
        scope: 'native_local_Odoo_primary_image_preview_apply',
        revision: h.revision,
        schema_revision: h.schema_revision,
        provider_authenticated: false,
        provider_requests: 0,
        existing_tenants_preserved: s.tenants.length,
        stable_tables_preserved: Object.keys(s.before).length + 1,
        product_price_preserved: true,
        physical_stock_preserved: true,
        stock: product.stock,
        image_bytes: bytes.length,
        image_sha256: image.sha256,
        product_gallery: product.images,
        whole_goal_complete: false,
      };
      s.verification = report;
      await save(s);
      await writeFile(
        phase === 'verify'
          ? 'data/odoo-images-runtime-059.json'
          : 'docs/odoo-images-native-qa.json',
        JSON.stringify(report, null, 2) + '\n',
      );
      console.log(report);
    }
  }
} finally {
  await pool.end();
}
