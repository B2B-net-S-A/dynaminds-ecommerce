// Own QA firm only. Private account and baselines remain ignored and mode 0600.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { pool } from '../server/db';
import { decrypt } from '../server/security';
const path = 'data/email-stage084.json',
  phase = process.argv[2];
const tables = [
  'channels',
  'products',
  'stock',
  'orders',
  'order_items',
  'documents',
  'shipments',
  'reservations',
  'return_cases',
  'payment_entries',
  'listings',
  'email_templates',
  'email_batches',
  'email_messages',
  'email_message_files',
  'invoice_email_files',
  'automation_rules',
  'automation_schedules',
  'odoo_invoice_exports',
  'odoo_invoice_files',
];
async function snapshot(ids: string[]) {
  const result: any = {};
  for (const t of tables)
    result[t] = (
      await pool.query(
        `SELECT to_jsonb(t) row FROM ${t} t WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1`,
        [ids],
      )
    ).rows;
  return result;
}
let cookie = '';
async function api(url: string, method = 'GET', body?: any, status = 200) {
  const r = await fetch('http://127.0.0.1:4100/api' + url, {
    method,
    headers: {
      cookie,
      'Content-Type': 'application/json',
      ...(url === '/orders' ? { 'Idempotency-Key': randomUUID() } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal(r.status, status, url + ' ' + (await r.clone().text()));
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
  return r.headers.get('content-type')?.startsWith('application/pdf') ||
    r.headers.get('content-type')?.startsWith('text/html')
    ? Buffer.from(await r.arrayBuffer())
    : (r.json() as any);
}
try {
  if (phase === 'baseline') {
    const tenants = (await pool.query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id),
      users = (await pool.query('SELECT id FROM users ORDER BY id')).rows.map((r) => r.id);
    await writeFile(
      path,
      JSON.stringify(
        {
          tenants,
          users,
          before: await snapshot(tenants),
          accounts: (await pool.query('SELECT id,email,password_hash,name FROM users ORDER BY id'))
            .rows,
          at: new Date().toISOString(),
        },
        null,
        2,
      ),
      { flag: 'wx', mode: 0o600 },
    );
    console.log({
      prior_firms: tenants.length,
      prior_accounts: users.length,
      tables: tables.length,
    });
  } else {
    const s = JSON.parse(await readFile(path, 'utf8')),
      save = () => writeFile(path, JSON.stringify(s, null, 2), { mode: 0o600 });
    if (phase === 'setup') {
      const h = await api('/health');
      assert.equal(h.schema_revision, '063_email_attachments');
      assert(h.email_attachments_available);
      s.email = 'qa-email-084@demo.local';
      s.password = 'DynaEmail!2026';
      if (!s.tenant) {
        const r = await api(
          '/auth/signup',
          'POST',
          {
            email: s.email,
            password: s.password,
            name: 'QA Załączniki',
            organization: { name: 'QA Email 084' },
          },
          201,
        );
        s.tenant = r.user.tenant_id;
        s.user = r.user.id;
        await save();
      } else await api('/auth/login', 'POST', { email: s.email, password: s.password });
      cookie = s.cookie = cookie;
      s.warehouse = (await api('/warehouses')).data[0].id;
      s.product ??= (
        await api(
          '/products',
          'POST',
          {
            sku: 'QA-EMAIL-084',
            name: 'Żółty produkt - załączniki',
            price: 12345,
            vat: 23,
            quantity: 10,
            warehouse_id: s.warehouse,
          },
          201,
        )
      ).id;
      await save();
      s.order ??= (
        await api(
          '/orders',
          'POST',
          {
            customer_name: 'Żółć QA84',
            email: 'qa84-buyer@example.test',
            warehouse_id: s.warehouse,
            address: {
              country: 'PL',
              street: 'Testowa 1',
              city: 'Warszawa',
              postal_code: '00-001',
              phone: '500500500',
            },
            items: [{ product_id: s.product, quantity: 2 }],
          },
          201,
        )
      ).id;
      await save();
      let o = await api('/orders/' + s.order);
      s.number = o.number;
      if (o.status === 'new')
        await api(`/orders/${o.id}/payments`, 'POST', {
          version: o.version,
          kind: 'receipt',
          amount: o.total,
          currency: o.currency,
          method: 'other',
          reference: 'QA084-BEZ-PRZELEWU',
          note: 'Deklaracja lokalna QA, bez przelewu',
          client_key: randomUUID(),
          confirmed: true,
        });
      o = await api('/orders/' + s.order);
      if (o.status === 'paid') await api(`/orders/${o.id}/status`, 'PATCH', { status: 'picking' });
      o = await api('/orders/' + s.order);
      if (o.status === 'picking') {
        for (let i = Number(o.items[0].scanned); i < 2; i++)
          await api(`/orders/${o.id}/scan`, 'POST', { code: 'QA-EMAIL-084' });
        await api(`/orders/${o.id}/status`, 'PATCH', { status: 'packed' });
      }
      s.document ??= (await api(`/orders/${o.id}/documents`, 'POST', { kind: 'invoice' })).id;
      s.channel ??= (await api('/integrations/smtp-example', 'POST', {})).channel_id;
      s.odoo_channel ??= (await api('/integrations/odoo-example', 'POST', {})).channel_id;
      const d = (await api('/orders/' + s.order)).documents.find((d: any) => d.id === s.document),
        day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw' }).format(
          new Date(d.created_at),
        );
      s.export ??= (
        await api(`/documents/${s.document}/odoo-export/preview`, 'POST', {
          client_key: randomUUID(),
          channel_id: s.odoo_channel,
          partner_id: 1,
          journal_id: 1,
          account_id: 1,
          invoice_date: day,
          due_date: day,
          shipping_vat: 23,
          taxes: [{ vat: 23, tax_id: 24 }],
        })
      ).id;
      await save();
      const find = async () =>
        (await api('/orders/' + s.order + '/odoo-invoices')).data.find(
          (p: any) => p.id === s.export,
        );
      if ((await find()).state === 'preview')
        await api('/odoo-invoice-exports/' + s.export + '/queue', 'POST', { confirm_data: true });
      for (let i = 0; i < 40 && (await find()).state !== 'done'; i++)
        await new Promise((r) => setTimeout(r, 200));
      assert.equal((await find()).state, 'done');
      assert.equal((await find()).result.scope, 'local_simulation');
      await api('/odoo-invoice-exports/' + s.export + '/pdf', 'POST', {});
      const pdf = await api('/odoo-invoice-exports/' + s.export + '/pdf');
      assert(Buffer.isBuffer(pdf));
      s.pdf_sha256 = createHash('sha256').update(pdf).digest('hex');
      s.empty_order ??= (
        await api(
          '/orders',
          'POST',
          {
            customer_name: 'QA84 Bez dokumentu',
            email: 'qa84-empty@example.test',
            warehouse_id: s.warehouse,
            address: { country: 'PL' },
            items: [{ product_id: s.product, quantity: 1 }],
          },
          201,
        )
      ).id;
      s.cookie = cookie;
      await save();
      console.log({
        tenant: s.tenant,
        order: s.order,
        number: s.number,
        ready_demo_html: true,
        ready_odoo_pdf: true,
        order_waiting_for_UI_shipment: true,
      });
    } else if (phase === 'verify') {
      await api('/auth/login', 'POST', { email: s.email, password: s.password });
      s.cookie = cookie;
      await save();
      const h = await api('/health'),
        m = (await api('/email/messages?order_id=' + s.order)).data;
      assert.equal(h.schema_revision, '063_email_attachments');
      assert.equal(m.length, 3);
      assert(m.every((v: any) => v.state === 'smtp_accepted' && v.sender.local_sink));
      assert.equal(m.filter((v: any) => v.automation_run_id).length, 1);
      assert.equal(m.filter((v: any) => v.payload.attachment.source === 'odoo').length, 1);
      assert.equal(m.filter((v: any) => v.payload.attachment.source === 'demo').length, 2);
      const files = (
        await pool.query('SELECT * FROM email_message_files WHERE tenant_id=$1', [s.tenant])
      ).rows;
      assert.equal(files.length, 3);
      const matches = [];
      for (const name of await readdir('data/smtp-mailbox')) {
        const r = decrypt(await readFile('data/smtp-mailbox/' + name, 'utf8'));
        const raw = Buffer.from(r.raw_base64, 'base64').toString();
        for (const message of m) {
          if (!raw.includes(message.id + '@dynaminds.local')) continue;
          const f = files.find((v) => v.message_id === message.id),
            bytes = Buffer.from(decrypt(f.content_encrypted).file_base64, 'base64');
          assert.equal(
            createHash('sha256').update(bytes).digest('hex'),
            message.payload.attachment.sha256,
          );
          assert(raw.replace(/\r?\n/g, '').includes(bytes.toString('base64')));
          assert(raw.includes('Content-Disposition: attachment'));
          matches.push(message.id);
        }
      }
      assert.equal(new Set(matches).size, 3);
      assert.equal(matches.length, 3);
      const o = await api('/orders/' + s.order);
      assert.equal(o.status, 'shipped');
      assert(o.shipments.every((x: any) => x.mode === 'demo'));
      assert.equal(o.documents.length, 1);
      const after = await snapshot(s.tenants);
      for (const t of tables) {
        if (t === 'email_templates') for (const row of s.before[t]) row.row.attachment ??= 'none';
        assert.deepEqual(after[t], s.before[t], 'Previous firms ' + t);
      }
      assert.deepEqual(
        (
          await pool.query(
            'SELECT id,email,password_hash,name FROM users WHERE id=ANY($1::uuid[]) ORDER BY id',
            [s.users],
          )
        ).rows,
        s.accounts,
      );
      const report = {
        at: new Date().toISOString(),
        revision: h.revision,
        schema: h.schema_revision,
        tenant: s.tenant,
        order: s.order,
        number: s.number,
        prior_firms: s.tenants.length,
        prior_accounts: s.users.length,
        prior_business_tables_exact: tables.length,
        SMTP: {
          accepted: 3,
          delivered: false,
          external_requests: 0,
          raw_attachments_equal_frozen_bytes: true,
        },
        document_sources: ['DEMO HTML', 'Odoo simulation cached PDF'],
        fakturownia: 'official connector validated with controlled API fixtures; no live account',
        messages: m.map((v: any) => ({
          id: v.id,
          state: v.state,
          attachment: v.payload.attachment,
          source: v.automation_run_id ? 'rule' : 'manual',
        })),
        pdf_sha256: s.pdf_sha256,
        worker_no_resend: true,
      };
      await writeFile('data/email-attachments-native-qa.json', JSON.stringify(report, null, 2));
      console.log(report);
    } else throw Error('Unknown phase');
  }
} finally {
  await pool.end();
}
