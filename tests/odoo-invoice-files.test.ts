import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed, DEMO_TENANT, SECOND_TENANT } from './fixtures';
import { encrypt, decrypt } from '../server/security';
import { processOdooExport, failOdooExport } from '../server/odoo-exports';
import { accountingFixture, odooSettings, odooCredentials } from './odoo-accounting-fixture';
import { readFile } from 'node:fs/promises';
import { odooPdf, pdfSha256 } from '../server/odoo-pdf-format';
const pdfBytes = await readFile('output/pdf/odoo-demo.pdf');
assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
  other: string,
  viewer: string,
  operator: string,
  warehouse: string,
  f = accountingFixture();
const req = (url: string, method: any = 'GET', payload?: any, auth = cookie) =>
  app.inject({
    url: '/api' + url,
    method,
    payload,
    headers: { cookie: auth, ...(url === '/orders' ? { 'idempotency-key': randomUUID() } : {}) },
  });
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({ integrationTransport: (u, i) => f.transport(u, i) });
  const login = async (email: string) =>
    (
      await app.inject({
        url: '/api/auth/login',
        method: 'POST',
        payload: { email, password: 'DynaDemo!2026' },
      })
    ).headers['set-cookie']!.toString().split(';')[0];
  cookie = await login('admin@demo.local');
  other = await login('other@demo.local');
  viewer = await login('viewer@demo.local');
  operator = await login('operator@demo.local');
  warehouse = (await req('/warehouses')).json().data[0].id;
});
after(async () => {
  await app.close();
  await pool.end();
});
beforeEach(async () => {
  f = accountingFixture();
  await pool.query("UPDATE jobs SET state='done',lease_token=NULL,locked_at=NULL");
});
async function fixture(simulation = false) {
  const prod = await req('/products', 'POST', {
    name: 'Invoice QA',
    sku: 'ODINV-' + randomUUID(),
    price: 12300,
    vat: 23,
    warehouse_id: warehouse,
    quantity: 10,
  });
  assert.equal(prod.statusCode, 201, prod.body);
  let r = await req('/orders', 'POST', {
    customer_name: 'Klient QA',
    email: 'invoice@example.test',
    warehouse_id: warehouse,
    items: [{ product_id: prod.json().id, quantity: 2 }],
    address: { street: 'Testowa 1', city: 'Warszawa', postal_code: '00-001', country: 'PL' },
    shipping_cost: 1499,
  });
  assert.equal(r.statusCode, 201, r.body);
  const order = r.json().id;
  await tenantTx(DEMO_TENANT, async (c) => {
    await c.query('UPDATE order_items SET line_total=22001 WHERE order_id=$1', [order]);
    await c.query('UPDATE orders SET total=23500 WHERE id=$1', [order]);
  });
  assert.equal((await req(`/orders/${order}/status`, 'PATCH', await legacySerialOrderStatusPayload((orderPath) => req(orderPath, 'GET', undefined), `/orders/${order}/status`, { status: 'paid' }))).statusCode, 200);
  r = await req(`/orders/${order}/documents`, 'POST', { kind: 'invoice' });
  assert.equal(r.statusCode, 200, r.body);
  const document = r.json();
  const ch = randomUUID();
  await tenantTx(DEMO_TENANT, (c) =>
    c.query(
      "INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings) VALUES($1,$2,'odoo','QA Odoo','live',$3,$4)",
      [
        ch,
        DEMO_TENANT,
        encrypt(odooCredentials),
        JSON.stringify({ ...odooSettings, ...(simulation ? { simulation: 'true' } : {}) }),
      ],
    ),
  );
  const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw' }).format(
    new Date(document.created_at),
  );
  const body = {
    client_key: randomUUID(),
    channel_id: ch,
    partner_id: 1,
    journal_id: 1,
    account_id: 1,
    invoice_date: day,
    due_date: day,
    shipping_vat: 23,
    taxes: [{ vat: 23, tax_id: 24 }],
  };
  return { order, document: document.id, ch, body, product: prod.json().id };
}
async function preview(x: any) {
  const r = await req(`/documents/${x.document}/odoo-export/preview`, 'POST', x.body);
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}
async function queue(p: any) {
  const r = await req(`/odoo-invoice-exports/${p.id}/queue`, 'POST', {
    confirm_data: true,
    confirm_post: true,
  });
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}
async function plan(id: string) {
  return (
    await tenantTx(DEMO_TENANT, (c) =>
      c.query('SELECT * FROM odoo_invoice_exports WHERE id=$1', [id]),
    )
  ).rows[0];
}
async function run(id: string) {
  const p = await plan(id),
    j = (
      await pool.query(
        "UPDATE jobs SET state='running',attempts=attempts+1,locked_at=now(),lease_token=$2 WHERE id=$1 RETURNING *",
        [p.job_id, randomUUID()],
      )
    ).rows[0];
  try {
    await processOdooExport(j, { transport: f.transport });
  } catch (e) {
    await failOdooExport(j, e);
  }
  return plan(id);
}
async function ready(simulation = false) {
  const x = await fixture(simulation),
    p = await preview(x);
  await queue(p);
  const done = await run(p.id);
  assert.equal(done.state, 'done');
  const attachment = {
    id: 777,
    name: 'private invoice.pdf',
    res_model: 'account.move',
    res_id: Number(done.remote_id),
    res_field: 'invoice_pdf_report_file',
    company_id: [1, 'QA ERP'],
    type: 'binary',
    mimetype: 'application/pdf',
    file_size: pdfBytes.length,
    checksum: createHash('sha1').update(pdfBytes).digest('hex'),
    write_date: '2026-10-04 10:00:00',
    datas: pdfBytes.toString('base64'),
  };
  f.models['ir.attachment'] = [attachment];
  if (!simulation)
    Object.assign(f.moves.get(Number(done.remote_id)), {
      invoice_pdf_report_id: [777, 'PDF'],
      write_date: '2026-10-04 10:00:00',
    });
  return { ...x, p: done, attachment };
}
const fileRows = async (id: string) =>
  (await pool.query('SELECT * FROM odoo_invoice_files WHERE export_id=$1', [id])).rows;
test('read-only JSON-2 download verifies linked PDF and caches encrypted bytes without business writes', async () => {
  const x = await ready(),
    before = (
      await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [x.product])
    ).rows,
    oldSource = (await pool.query('SELECT * FROM documents WHERE id=$1', [x.document])).rows,
    payments = (await pool.query('SELECT * FROM payment_entries WHERE order_id=$1', [x.order]))
      .rows,
    calls = f.calls.length;
  const r = await req(`/odoo-invoice-exports/${x.p.id}/pdf`, 'POST', {});
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().sha256, pdfSha256(pdfBytes));
  assert(f.calls.slice(calls).every((c) => c.method === 'read'));
  const row = (await fileRows(x.p.id))[0];
  assert(!row.content_encrypted.includes('JVBER'));
  assert.equal(decrypt(row.content_encrypted).pdf_base64, pdfBytes.toString('base64'));
  assert.deepEqual(
    (await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [x.product])).rows,
    before,
  );
  assert.deepEqual(
    (await pool.query('SELECT * FROM documents WHERE id=$1', [x.document])).rows,
    oldSource,
  );
  assert.deepEqual(
    (await pool.query('SELECT * FROM payment_entries WHERE order_id=$1', [x.order])).rows,
    payments,
  );
  const history = await req(`/orders/${x.order}/odoo-invoices`);
  assert.equal(history.json().data[0].pdf.sha256, row.sha256);
  assert(
    !history.body.includes('content_encrypted') &&
      !history.body.includes('pdf_base64') &&
      !r.body.includes('content_encrypted'),
  );
});
test('cached PDF reads and replay work after key rotation with no provider requests, including viewer and RLS', async () => {
  const x = await ready();
  assert.equal((await req(`/odoo-invoice-exports/${x.p.id}/pdf`, 'POST', {})).statusCode, 200);
  await pool.query('UPDATE channels SET credentials=$2 WHERE id=$1', [
    x.ch,
    encrypt({ api_key: 'rotated' }),
  ]);
  const before = f.calls.length;
  const replay = await req(`/odoo-invoice-exports/${x.p.id}/pdf`, 'POST', {});
  assert.equal(replay.json().replayed, true);
  const download = await req(`/odoo-invoice-exports/${x.p.id}/pdf`, 'GET', undefined, viewer);
  assert.equal(download.statusCode, 200, download.body);
  assert.deepEqual(download.rawPayload, pdfBytes);
  assert.equal(download.headers['cache-control'], 'no-store');
  assert.equal(download.headers['x-content-type-options'], 'nosniff');
  assert.match(
    String(download.headers['content-disposition']),
    /^attachment; filename=odoo-[a-f0-9-]+\.pdf$/,
  );
  assert.equal(
    (await req(`/odoo-invoice-exports/${x.p.id}/pdf`, 'POST', {}, viewer)).statusCode,
    403,
  );
  assert.equal(
    (await req(`/odoo-invoice-exports/${x.p.id}/pdf`, 'GET', undefined, other)).statusCode,
    404,
  );
  assert.equal(
    (await req(`/odoo-invoice-exports/${x.p.id}/pdf`, 'POST', {}, other)).statusCode,
    404,
  );
  assert.equal(f.calls.length, before);
  assert.equal(
    (
      await tenantTx(SECOND_TENANT, (c) =>
        c.query('SELECT * FROM odoo_invoice_files WHERE export_id=$1', [x.p.id]),
      )
    ).rowCount,
    0,
  );
});
test('public API requires document scopes and preserves binary cached response', async () => {
  const x = await ready(true);
  const key = await req('/developer/keys', 'POST', {
    name: 'PDF test',
    scopes: ['documents:read', 'documents:write'],
  });
  assert.equal(key.statusCode, 201, key.body);
  const headers = { authorization: 'Bearer ' + key.json().token };
  const saved = await app.inject({
    method: 'POST',
    url: `/api/v1/odoo-invoice-exports/${x.p.id}/pdf`,
    headers,
    payload: {},
  });
  assert.equal(saved.statusCode, 200, saved.body);
  const read = await app.inject({
    method: 'GET',
    url: `/api/v1/odoo-invoice-exports/${x.p.id}/pdf`,
    headers,
  });
  assert.equal(read.statusCode, 200, read.body);
  assert.deepEqual(read.rawPayload, pdfBytes);
  const denied = await req('/developer/keys', 'POST', { name: 'No docs', scopes: ['orders:read'] });
  assert.equal(
    (
      await app.inject({
        method: 'GET',
        url: `/api/v1/odoo-invoice-exports/${x.p.id}/pdf`,
        headers: { authorization: 'Bearer ' + denied.json().token },
      })
    ).statusCode,
    403,
  );
});
test('missing provider PDF is explicit and does not generate, send, or cache a substitute', async () => {
  const x = await ready();
  f.moves.get(Number(x.p.remote_id)).invoice_pdf_report_id = false;
  const before = f.calls.length;
  const r = await req(`/odoo-invoice-exports/${x.p.id}/pdf`, 'POST', {});
  assert.equal(r.statusCode, 404, r.body);
  assert.equal((await fileRows(x.p.id)).length, 0);
  assert(f.calls.slice(before).every((c) => c.method === 'read' && c.model !== 'ir.attachment'));
});
test('foreign, URL, oversized, wrong field and invalid attachments fail before binary read', async () => {
  for (const change of [
    { company_id: [2, 'Other'] },
    { res_id: 888 },
    { res_model: 'res.partner' },
    { res_field: false },
    { type: 'url' },
    { mimetype: 'text/html' },
    { file_size: 2097153 },
    { checksum: 'bad' },
  ]) {
    const x = await ready();
    Object.assign(x.attachment, change);
    const before = f.calls.length;
    const r = await req(`/odoo-invoice-exports/${x.p.id}/pdf`, 'POST', {});
    assert.equal(r.statusCode, 502, r.body);
    assert.equal((await fileRows(x.p.id)).length, 0);
    assert(!f.calls.slice(before).some((c) => c.args.fields.includes('datas')));
  }
});
test('PDF bytes require canonical base64, PDF envelope, size and provider checksum', async () => {
  for (const change of [
    { datas: pdfBytes.toString('base64') + '\n' },
    { datas: Buffer.from('html').toString('base64') },
    { file_size: pdfBytes.length + 1 },
    { checksum: 'a'.repeat(40) },
  ]) {
    const x = await ready();
    Object.assign(x.attachment, change);
    assert.equal((await req(`/odoo-invoice-exports/${x.p.id}/pdf`, 'POST', {})).statusCode, 502);
    assert.equal((await fileRows(x.p.id)).length, 0);
  }
  assert.throws(() => odooPdf(Buffer.from('%PDF-1.7\nwithout EOF').toString('base64')));
  assert.throws(() => odooPdf('a'.repeat(2796208)));
});
test('attachment replacement or invoice edit during read is rejected without cache', async () => {
  for (const target of ['attachment', 'move']) {
    const x = await ready();
    f.state.hook = async (c) => {
      if (c.model === 'ir.attachment' && c.args.fields.includes('datas')) {
        if (target === 'attachment') x.attachment.write_date = '2026-10-04 11:00:00';
        else f.moves.get(Number(x.p.remote_id)).invoice_pdf_report_id = [999, 'Replacement'];
      }
    };
    assert.equal((await req(`/odoo-invoice-exports/${x.p.id}/pdf`, 'POST', {})).statusCode, 409);
    assert.equal((await fileRows(x.p.id)).length, 0);
  }
});
test('current role, key, connection and local source are rechecked before every RPC and commit', async () => {
  const user = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
  for (const target of ['role', 'key', 'settings', 'source']) {
    const x = await ready();
    let changed = false;
    f.state.hook = async (c) => {
      if (c.model !== 'ir.attachment' || !c.args.fields.includes('datas') || changed) return;
      changed = true;
      if (target === 'role')
        await pool.query("UPDATE memberships SET role='viewer' WHERE user_id=$1 AND tenant_id=$2", [
          user,
          DEMO_TENANT,
        ]);
      if (target === 'key')
        await pool.query('UPDATE channels SET credentials=$2 WHERE id=$1', [
          x.ch,
          encrypt({ api_key: 'changed' }),
        ]);
      if (target === 'settings')
        await pool.query(
          'UPDATE channels SET settings=settings||\'{"company_id":"2"}\'::jsonb WHERE id=$1',
          [x.ch],
        );
      if (target === 'source')
        await pool.query(
          "UPDATE documents SET data=jsonb_set(data,'{total}',to_jsonb((data->>'total')::integer+1)) WHERE id=$1",
          [x.document],
        );
    };
    try {
      const r = await req(`/odoo-invoice-exports/${x.p.id}/pdf`, 'POST', {});
      assert(r.statusCode >= 400, r.body);
      assert(changed);
      assert.equal((await fileRows(x.p.id)).length, 0);
    } finally {
      await pool.query("UPDATE memberships SET role='admin' WHERE user_id=$1 AND tenant_id=$2", [
        user,
        DEMO_TENANT,
      ]);
    }
  }
});
test('two concurrent captures of identical PDF leave one immutable copy and one audit entry', async () => {
  const x = await ready();
  const responses = await Promise.all([
    req(`/odoo-invoice-exports/${x.p.id}/pdf`, 'POST', {}),
    req(`/odoo-invoice-exports/${x.p.id}/pdf`, 'POST', {}),
  ]);
  responses.forEach((r) => assert.equal(r.statusCode, 200, r.body));
  assert.equal((await fileRows(x.p.id)).length, 1);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::integer n FROM audit_events WHERE action='odoo.invoice.pdf.saved' AND entity_id=$1",
        [x.p.id],
      )
    ).rows[0].n,
    1,
  );
});
test('simulation performs zero PDF provider RPCs and archived bytes detect corruption', async () => {
  const x = await ready(true),
    before = f.calls.length;
  const r = await req(`/odoo-invoice-exports/${x.p.id}/pdf`, 'POST', {});
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().mode, 'simulation');
  assert.equal(f.calls.length, before);
  assert.match(r.json().filename, /^DEMO-/);
  await pool.query('UPDATE odoo_invoice_files SET sha256=$2 WHERE export_id=$1', [
    x.p.id,
    'a'.repeat(64),
  ]);
  assert.equal((await req(`/odoo-invoice-exports/${x.p.id}/pdf`)).statusCode, 502);
  await pool.query('UPDATE odoo_invoice_files SET sha256=$2 WHERE export_id=$1', [
    x.p.id,
    pdfSha256(pdfBytes),
  ]);
});
test('preview or wrong state cannot capture PDF, body rejects arbitrary provider URL', async () => {
  const x = await fixture(),
    p = await preview(x);
  assert.equal((await req(`/odoo-invoice-exports/${p.id}/pdf`, 'POST', {})).statusCode, 409);
  assert.equal(
    (await req(`/odoo-invoice-exports/${p.id}/pdf`, 'POST', { url: 'https://example.test/' }))
      .statusCode,
    422,
  );
  assert.equal((await req(`/odoo-invoice-exports/${p.id}/pdf`)).statusCode, 404);
});
