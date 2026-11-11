import { legacySerialOrderStatusPayload } from './order-status-cas-helper';
import { readFile } from 'node:fs/promises';
import { encrypt, decrypt } from '../server/security';
import { sourceHash } from '../server/catalog-source-normalize';
import { connectionHash } from '../server/offer-sync-policy';
import { exportSource } from '../server/odoo-exports';
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SMTPServer } from 'smtp-server';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed, SECOND_TENANT } from './fixtures';
import { processEmail, emailTemplate, validateEmailTemplate } from '../server/email';
import { SmtpClient, localSmtpPassword, smtpSettings } from '../server/smtp';
import { tick } from '../server/worker';
assert.equal(process.env.DYNA_TEST, 'true');
let app: FastifyInstance,
  admin: string,
  operator: string,
  viewer: string,
  other: string,
  tenant: string,
  warehouse: string,
  product: string;
let received: string[] = [],
  rejectData = false,
  authenticated = 0;
const smtp = new SMTPServer({
  secure: false,
  disabledCommands: ['STARTTLS'],
  allowInsecureAuth: true,
  logger: false,
  onAuth(auth, _s, cb) {
    if (auth.username === 'dyna-local' && auth.password === localSmtpPassword()) {
      authenticated++;
      cb(null, { user: 'qa' });
    } else cb(new Error('Auth refused'));
  },
  onRcptTo(a, _s, cb) {
    cb(a.address.endsWith('.test') ? undefined : new Error('Only .test'));
  },
  onData(stream, _s, cb) {
    const b: Buffer[] = [];
    stream.on('data', (c) => b.push(c));
    stream.on('end', () => {
      received.push(Buffer.concat(b).toString('utf8'));
      cb(rejectData ? new Error('QA no final acceptance') : undefined);
    });
  },
});
const pdf = await readFile('output/pdf/odoo-demo.pdf');
let pdfResponse: Buffer = pdf,
  calls: string[] = [],
  invoiceHeader: any,
  mutateFetch: (() => Promise<void>) | undefined;
const transport = async (url: string, init: RequestInit) => {
  assert.equal(init.method, 'GET');
  const u = new URL(url);
  assert.equal(u.hostname, 'invoice-qa.fakturownia.pl');
  assert.equal(u.searchParams.get('api_token'), 'qa-token');
  calls.push(u.pathname);
  if (u.pathname.endsWith('.json')) return new Response(JSON.stringify(invoiceHeader));
  if (mutateFetch) await mutateFetch();
  return new Response(new Uint8Array(pdfResponse), {
    headers: { 'content-type': 'application/pdf' },
  });
};
const req = (url: string, method: any = 'GET', payload?: any, cookie = admin) =>
  app.inject({
    url,
    method,
    payload,
    headers: { cookie, 'x-workspace-id': cookie === other ? SECOND_TENANT : tenant },
  });
async function ok(url: string, method: any = 'GET', payload?: any, cookie = admin) {
  const r = await req(url, method, payload, cookie);
  assert.ok(r.statusCode < 300, r.body);
  return r.json();
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({ integrationTransport: transport });
  async function login(email: string) {
    const r = await app.inject({
      url: '/api/auth/login',
      method: 'POST',
      payload: { email, password: 'DynaDemo!2026' },
    });
    assert.equal(r.statusCode, 200, r.body);
    return r.headers['set-cookie']!.toString().split(';')[0];
  }
  admin = await login('admin@demo.local');
  operator = await login('operator@demo.local');
  viewer = await login('viewer@demo.local');
  other = await login('other@demo.local');
  await new Promise<void>((resolve, reject) => {
    smtp.once('error', reject);
    smtp.listen(1025, '127.0.0.1', resolve);
  });
});
beforeEach(async () => {
  await pool.query("UPDATE jobs SET state='done',lease_token=NULL");
  tenant = randomUUID();
  await pool.query("INSERT INTO tenants(id,name,plan) VALUES($1,'Email QA','enterprise')", [
    tenant,
  ]);
  await pool.query(
    "INSERT INTO memberships(tenant_id,user_id,role) SELECT $1,id,CASE email WHEN 'admin@demo.local' THEN 'admin' WHEN 'operator@demo.local' THEN 'operator' ELSE 'viewer' END FROM users WHERE email=ANY($2::text[])",
    [tenant, ['admin@demo.local', 'operator@demo.local', 'viewer@demo.local']],
  );
  async function switchOrg(cookie: string) {
    const r = await app.inject({
      url: '/api/workspaces/switch',
      method: 'POST',
      payload: { tenant_id: tenant },
      headers: { cookie },
    });
    assert.equal(r.statusCode, 200, r.body);
    return r.headers['set-cookie']!.toString().split(';')[0];
  }
  admin = await switchOrg(admin);
  operator = await switchOrg(operator);
  viewer = await switchOrg(viewer);
  warehouse = randomUUID();
  await pool.query("INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Email','EMAIL')", [
    warehouse,
    tenant,
  ]);
  product = (
    await ok('/api/products', 'POST', {
      sku: 'EMAIL-' + randomUUID(),
      name: 'Email QA',
      price: 12345,
      warehouse_id: warehouse,
      quantity: 10000,
    })
  ).id;
  pdfResponse = pdf;
  calls = [];
  mutateFetch = undefined;
  received = [];
  rejectData = false;
  authenticated = 0;
});
after(async () => {
  await new Promise<void>((resolve) => smtp.close(resolve));
  await app.close();
  await pool.end();
});
const template = (extra: any = {}, cookie = admin) =>
  ok(
    '/api/email/templates',
    'POST',
    {
      name: 'Informacja o zamówieniu',
      subject: 'Zamówienie {{order_number}}',
      body: 'Dzień dobry {{customer_name}}, {{total}} {{currency}}, {{status}}. Śledzenie {{tracking_number}}.',
      html: '<p>Dzień dobry <strong>{{customer_name}}</strong></p>',
      client_key: randomUUID(),
      ...extra,
    },
    cookie,
  );
const order = (extra: any = {}) =>
  ok('/api/orders', 'POST', {
    customer_name: 'QA Email',
    email: 'buyer@example.test',
    warehouse_id: warehouse,
    address: { country: 'PL' },
    items: [{ product_id: product, quantity: 2 }],
    ...extra,
  });
const preview = (t: any, orders: any[], extra: any = {}, cookie = admin) =>
  ok(
    '/api/email/preview',
    'POST',
    {
      template_id: t.id,
      template_version: t.version,
      order_ids: orders.map((o) => o.id),
      mode: 'local',
      client_key: randomUUID(),
      ...extra,
    },
    cookie,
  );
const queue = (b: any, cookie = admin) =>
  ok('/api/email/batches/' + b.id + '/queue', 'POST', { confirmed: true }, cookie);
const localChannel = async () =>
  (await ok('/api/integrations/smtp-example', 'POST', {})).channel_id;
async function drain() {
  for (let i = 0; i < 260; i++) if (!(await tick())) return;
  throw new Error('Worker did not drain');
}
async function claim(b: any) {
  const j = (
    await pool.query(
      "UPDATE jobs SET state='running',attempts=attempts+1,locked_at=now(),lease_token=$2 WHERE id=$1 RETURNING *",
      [b.items[0].job_id, randomUUID()],
    )
  ).rows[0];
  return j;
}
async function document(o: any) {
  await ok('/api/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/api/orders/' + o.id + '/status', { status: 'paid' }));
  return ok('/api/orders/' + o.id + '/documents', 'POST', { kind: 'invoice' });
}
async function externalDoc(o: any) {
  const d = await document(o),
    ch = randomUUID();
  await pool.query(
    "INSERT INTO channels(id,tenant_id,provider,name,mode,settings,credentials) VALUES($1,$2,'fakturownia','QA invoice','live',$3,$4)",
    [
      ch,
      tenant,
      JSON.stringify({ account_url: 'https://invoice-qa.fakturownia.pl' }),
      encrypt({ api_token: 'qa-token' }),
    ],
  );
  await pool.query(
    "UPDATE documents SET mode='external',channel_id=$2,external_id='778899' WHERE id=$1",
    [d.id, ch],
  );
  const payload = {
    positions: d.data.items.map((i: any) => ({
      name: i.name,
      quantity: i.quantity,
      tax: i.vat,
      total_price_gross: (i.gross / 100).toFixed(2),
    })),
    seller_tax_no: '',
    buyer_tax_no: '',
  };
  invoiceHeader = {
    ...payload,
    id: 778899,
    number: d.number,
    price_gross: (d.data.total / 100).toFixed(2),
  };
  await pool.query(
    "INSERT INTO invoice_plans(id,tenant_id,order_id,channel_id,actor_id,kind,input,payload,order_snapshot,mode,state,phase,remote_id,document_id) VALUES($1,$2,$3,$4,(SELECT id FROM users WHERE email='admin@demo.local'),'invoice','{}',$5,$6,'external','done','created','778899',$7)",
    [
      randomUUID(),
      tenant,
      o.id,
      ch,
      JSON.stringify(payload),
      JSON.stringify({ total: d.data.total }),
      d.id,
    ],
  );
  return { ...d, ch };
}
const cache = (d: any, cookie = admin) =>
  ok('/api/documents/' + d.id + '/email-file', 'POST', { confirmed: true }, cookie);
const rows = () => pool.query('SELECT * FROM email_message_files WHERE tenant_id=$1', [tenant]);
async function odooDoc(o: any) {
  const d = await document(o),
    ch = randomUUID(),
    id = randomUUID(),
    input = {
      shipping_vat: 23,
      taxes: [{ vat: 23, tax_id: 24 }],
      partner_id: 1,
      journal_id: 1,
      account_id: 1,
      invoice_date: new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw' }).format(
        new Date(d.created_at),
      ),
      due_date: new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw' }).format(
        new Date(d.created_at),
      ),
    };
  const settings = { simulation: 'true' },
    credentials = encrypt({ api_key: 'qa-odoo' });
  await pool.query(
    "INSERT INTO channels(id,tenant_id,provider,name,mode,settings,credentials) VALUES($1,$2,'odoo','QA Odoo','sandbox',$3,$4)",
    [ch, tenant, JSON.stringify(settings), credentials],
  );
  const channel = (await pool.query('SELECT * FROM channels WHERE id=$1', [ch])).rows[0];
  await pool.query(
    "INSERT INTO odoo_invoice_exports(id,tenant_id,document_id,order_id,channel_id,actor_id,client_key,input_hash,source_hash,connection_hash,credentials_hash,reference,input,snapshot,payload,mode,state,phase,remote_id,result) VALUES($1,$2,$3,$4,$5,(SELECT id FROM users WHERE email='admin@demo.local'),$6,$7,$8,$9,$10,'QA',$11,'{}','{}','simulation','done','verified','91','{\"id\":91}')",
    [
      id,
      tenant,
      d.id,
      o.id,
      ch,
      randomUUID(),
      'a'.repeat(64),
      sourceHash(exportSource(d, input as any)),
      connectionHash(channel),
      sourceHash(channel.credentials),
      JSON.stringify(input),
    ],
  );
  await pool.query(
    "INSERT INTO odoo_invoice_files(tenant_id,export_id,actor_id,filename,size,sha256,content_encrypted,remote_attachment_id,mode) VALUES($1,$2,(SELECT id FROM users WHERE email='admin@demo.local'),'DEMO-odoo-91.pdf',$3,$4,$5,'DEMO-91','simulation')",
    [
      tenant,
      id,
      pdf.length,
      sourceHash('not-used'),
      encrypt({ pdf_base64: pdf.toString('base64') }),
    ],
  );
  const { createHash } = await import('node:crypto');
  await pool.query('UPDATE odoo_invoice_files SET sha256=$2 WHERE export_id=$1', [
    id,
    createHash('sha256').update(pdf).digest('hex'),
  ]);
  return { id, ch, d };
}
const action = (t: any) => ({ type: 'email', template_id: t.id, mode: 'local' });
async function actionPreview(t: any, o: any) {
  return ok('/api/orders/' + o.id + '/operations/preview', 'POST', action(t));
}

test('wymagana faktura zatrzymuje podgląd, bez SMTP i zapisanych plików', async () => {
  const o = await order(),
    t = await template({ attachment: 'invoice' }),
    b = await preview(t, [o]);
  assert.equal(b.items[0].state, 'invalid');
  assert.match(b.items[0].error, /nie ma faktury/);
  assert.equal(
    (await req('/api/email/batches/' + b.id + '/queue', 'POST', { confirmed: true })).statusCode,
    409,
  );
  assert.equal((await rows()).rowCount, 0);
  assert.equal(received.length, 0);
});
test('DEMO HTML jest szyfrowany, escapowany i pobierany z dokładnego podglądu', async () => {
  const o = await order({ customer_name: 'Żółć <script>alert(1)</script>' });
  await document(o);
  const b = await preview(await template({ attachment: 'invoice' }), [
      await ok('/api/orders/' + o.id),
    ]),
    f = (await rows()).rows[0];
  assert.equal(b.items[0].payload.attachment.content_type, 'text/html');
  assert(!JSON.stringify(b).includes('file_base64'));
  assert(!f.content_encrypted.includes('Żółć'));
  const r = await req('/api/email/messages/' + b.items[0].id + '/attachment');
  assert.equal(r.statusCode, 200);
  assert.match(r.headers['content-disposition'] as string, /attachment; filename="DEMO/);
  assert.match(r.body, /Żółć &lt;script&gt;/);
  assert(!r.body.includes('<script>'));
  assert.match(r.body, /DEMO - dokument testowy/);
  assert.equal(Buffer.byteLength(r.body), f.size);
});
test('realny protokół SMTP otrzymuje MIME załącznika z identycznymi bajtami', async () => {
  const o = await order();
  await document(o);
  const t = await template({ attachment: 'invoice' }),
    ch = await localChannel();
  let b = await preview(t, [await ok('/api/orders/' + o.id)], { mode: 'smtp', channel_id: ch });
  const bytes = (await req('/api/email/messages/' + b.items[0].id + '/attachment')).rawPayload;
  b = await queue(b);
  await drain();
  assert.equal(received.length, 1);
  assert.match(received[0], /multipart\/mixed/);
  assert.match(received[0], /Content-Disposition: attachment/);
  assert(received[0].replace(/\r?\n/g, '').includes(bytes.toString('base64')));
  assert.equal((await ok('/api/email/batches/' + b.id)).items[0].state, 'smtp_accepted');
  await queue(b);
  await drain();
  assert.equal(received.length, 1);
});
test('zmiana faktury po podglądzie blokuje kolejkę, chociaż wersja zamówienia nie zmieniła się', async () => {
  const o = await order(),
    d = await document(o),
    b = await preview(await template({ attachment: 'invoice' }), [await ok('/api/orders/' + o.id)]);
  await pool.query("UPDATE documents SET number=number||'-zmiana' WHERE id=$1", [d.id]);
  assert.equal(
    (await req('/api/email/batches/' + b.id + '/queue', 'POST', { confirmed: true })).statusCode,
    409,
  );
  assert.equal(received.length, 0);
});
test('zmiana dokumentu po kolejce zatrzymuje worker przed attempted_at', async () => {
  const o = await order(),
    d = await document(o),
    b = await queue(
      await preview(await template({ attachment: 'invoice' }), [await ok('/api/orders/' + o.id)], {
        mode: 'smtp',
        channel_id: await localChannel(),
      }),
    );
  await pool.query("UPDATE documents SET number=number||'-zmiana' WHERE id=$1", [d.id]);
  await drain();
  const m = (await ok('/api/email/batches/' + b.id)).items[0];
  assert.equal(m.state, 'failed');
  assert.equal(m.attempted_at, null);
  assert.equal(received.length, 0);
});
test('szyfrowany plik wiadomości nie ma uprawnień UPDATE lub DELETE', async () => {
  const o = await order();
  await document(o);
  const b = await preview(await template({ attachment: 'invoice' }), [
    await ok('/api/orders/' + o.id),
  ]);
  for (const sql of [
    'UPDATE email_message_files SET filename=filename',
    'DELETE FROM email_message_files',
  ])
    await assert.rejects(
      tenantTx(tenant, (c) => c.query(sql)),
      /permission denied/,
    );
  assert.equal((await rows()).rowCount, 1);
  assert.equal((await ok('/api/email/batches/' + b.id)).items.length, 1);
});
test('korupcja zaszyfrowanego pliku blokuje kolejkę i pobranie', async () => {
  const o = await order();
  await document(o);
  const b = await preview(await template({ attachment: 'invoice' }), [
    await ok('/api/orders/' + o.id),
  ]);
  const original = (await rows()).rows[0].content_encrypted;
  try {
    await pool.query('UPDATE email_message_files SET content_encrypted=$2 WHERE message_id=$1', [
      b.items[0].id,
      encrypt({ file_base64: Buffer.from('different').toString('base64') }),
    ]);
    assert.equal(
      (await req('/api/email/batches/' + b.id + '/queue', 'POST', { confirmed: true })).statusCode,
      409,
    );
    assert.equal(
      (await req('/api/email/messages/' + b.items[0].id + '/attachment')).statusCode,
      409,
    );
  } finally {
    await pool.query('UPDATE email_message_files SET content_encrypted=$2 WHERE message_id=$1', [
      b.items[0].id,
      original,
    ]);
  }
});
test('obca firma i anonimowy użytkownik nie pobierają załącznika; viewer firmy czyta', async () => {
  const o = await order();
  await document(o);
  const b = await preview(await template({ attachment: 'invoice' }), [
      await ok('/api/orders/' + o.id),
    ]),
    url = '/api/email/messages/' + b.items[0].id + '/attachment';
  assert.equal((await req(url, 'GET', undefined, other)).statusCode, 404);
  assert.equal((await req(url, 'GET', undefined, '')).statusCode, 401);
  assert.equal((await req(url, 'GET', undefined, viewer)).statusCode, 200);
  assert.equal(
    (
      await tenantTx(SECOND_TENANT, (c) =>
        c.query('SELECT * FROM email_message_files WHERE message_id=$1', [b.items[0].id]),
      )
    ).rowCount,
    0,
  );
});
test('PDF Fakturowni wymaga przygotowania; nie zastępuje go dokument DEMO', async () => {
  const o = await order();
  await document(o); // Insert an additional external document, keeping DEMO.
  const source = (await pool.query('SELECT * FROM documents WHERE order_id=$1', [o.id])).rows[0],
    id = randomUUID(),
    ch = randomUUID();
  await pool.query(
    "INSERT INTO channels(id,tenant_id,provider,name,mode,settings,credentials) VALUES($1,$2,'fakturownia','QA','live',$3,$4)",
    [
      ch,
      tenant,
      JSON.stringify({ account_url: 'https://invoice-qa.fakturownia.pl' }),
      encrypt({ api_token: 'qa-token' }),
    ],
  );
  await pool.query(
    "INSERT INTO documents(id,tenant_id,order_id,number,kind,mode,data,channel_id,external_id) VALUES($1,$2,$3,'FV-QA','invoice','external',$4,$5,'77')",
    [id, tenant, o.id, JSON.stringify(source.data), ch],
  );
  const b = await preview(await template({ attachment: 'invoice' }), [
    await ok('/api/orders/' + o.id),
  ]);
  assert.equal(b.items[0].state, 'invalid');
  assert.match(b.items[0].error, /przygotuj/);
  assert.equal(calls.length, 0);
});
test('PDF Fakturowni jest pobierany tylko GET i zapisany raz pod hashem źródła', async () => {
  const o = await order(),
    d = await externalDoc(o),
    a = await cache(d),
    b = await cache(d);
  assert.equal(a.cached, false);
  assert.equal(b.cached, true);
  assert.deepEqual(calls, [
    '/invoices/778899.json',
    '/invoices/778899.pdf',
    '/invoices/778899.json',
  ]);
  const p = await preview(await template({ attachment: 'invoice' }), [
      await ok('/api/orders/' + o.id),
    ]),
    r = await req('/api/email/messages/' + p.items[0].id + '/attachment');
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.rawPayload, pdf);
  assert.equal(p.items[0].payload.attachment.source, 'fakturownia');
});
test('równoległe pobrania PDF deduplikują cache', async () => {
  const o = await order(),
    d = await externalDoc(o);
  const [a, b] = await Promise.all([cache(d), cache(d)]);
  assert.equal(a.sha256, b.sha256);
  assert.equal(
    (await pool.query('SELECT * FROM invoice_email_files WHERE tenant_id=$1', [tenant])).rowCount,
    1,
  );
});
test('Fakturownia odrzuca niepełny PDF i przekroczenie 2 MiB bez cache', async () => {
  const o = await order(),
    d = await externalDoc(o);
  for (const p of [
    Buffer.from('%PDF-1.4\nmissing EOF'),
    Buffer.concat([
      Buffer.from('%PDF-1.4\n'),
      Buffer.alloc(2 * 1024 * 1024),
      Buffer.from('\n%%EOF'),
    ]),
  ]) {
    pdfResponse = p;
    assert.equal(
      (await req('/api/documents/' + d.id + '/email-file', 'POST', { confirmed: true })).statusCode,
      502,
    );
  }
  assert.equal(
    (await pool.query('SELECT * FROM invoice_email_files WHERE tenant_id=$1', [tenant])).rowCount,
    0,
  );
});
test('zmiana konta podczas pobierania odrzuca wynik; brak pliku', async () => {
  const o = await order(),
    d = await externalDoc(o);
  mutateFetch = async () => {
    await pool.query('UPDATE channels SET credentials=$2 WHERE id=$1', [
      d.ch,
      encrypt({ api_token: 'new' }),
    ]);
  };
  assert.equal(
    (await req('/api/documents/' + d.id + '/email-file', 'POST', { confirmed: true })).statusCode,
    409,
  );
  assert.equal(
    (await pool.query('SELECT * FROM invoice_email_files WHERE tenant_id=$1', [tenant])).rowCount,
    0,
  );
});
test('zmiana źródła dokumentu podczas pobierania odrzuca wynik', async () => {
  const o = await order(),
    d = await externalDoc(o);
  mutateFetch = async () => {
    await pool.query("UPDATE documents SET number=number||'-x' WHERE id=$1", [d.id]);
  };
  assert.equal(
    (await req('/api/documents/' + d.id + '/email-file', 'POST', { confirmed: true })).statusCode,
    409,
  );
});
test('viewer i obca firma nie uruchamiają pobrania; operator może przygotować PDF', async () => {
  const o = await order(),
    d = await externalDoc(o),
    url = '/api/documents/' + d.id + '/email-file';
  assert.equal((await req(url, 'POST', { confirmed: true }, viewer)).statusCode, 403);
  assert.equal((await req(url, 'POST', { confirmed: true }, other)).statusCode, 404);
  assert.equal((await req(url, 'POST', {}, admin)).statusCode, 422);
  assert.equal(calls.length, 0);
  assert.equal((await cache(d, operator)).content_type, 'application/pdf');
});
test('rotacja konta unieważnia gotowy cache faktury', async () => {
  const o = await order(),
    d = await externalDoc(o);
  await cache(d);
  await pool.query('UPDATE channels SET credentials=$2 WHERE id=$1', [
    d.ch,
    encrypt({ api_token: 'changed' }),
  ]);
  assert.equal(
    (await preview(await template({ attachment: 'invoice' }), [await ok('/api/orders/' + o.id)]))
      .items[0].state,
    'invalid',
  );
});
test('PDF Odoo używa przypiętego eksportu i identycznych zapisanych bajtów', async () => {
  const o = await order({
      address: { street: 'Testowa 1', city: 'Warszawa', postal_code: '00-001', country: 'PL' },
    }),
    x = await odooDoc(o),
    p = await preview(await template({ attachment: 'odoo_invoice' }), [
      await ok('/api/orders/' + o.id),
    ]);
  assert.equal(p.items[0].state, 'draft');
  assert.equal(p.items[0].payload.attachment.export_id, x.id);
  assert.deepEqual(
    (await req('/api/email/messages/' + p.items[0].id + '/attachment')).rawPayload,
    pdf,
  );
});
test('Odoo bez gotowego pliku i po zmianie konta zatrzymuje podgląd', async () => {
  const o = await order({
      address: { street: 'Testowa 1', city: 'Warszawa', postal_code: '00-001', country: 'PL' },
    }),
    x = await odooDoc(o),
    t = await template({ attachment: 'odoo_invoice' });
  await pool.query('UPDATE channels SET credentials=$2 WHERE id=$1', [
    x.ch,
    encrypt({ api_key: 'changed' }),
  ]);
  assert.equal((await preview(t, [await ok('/api/orders/' + o.id)])).items[0].state, 'invalid');
  await pool.query('DELETE FROM odoo_invoice_files WHERE export_id=$1', [x.id]);
  const p = await preview(t, [await ok('/api/orders/' + o.id)]);
  assert.equal(p.items[0].state, 'invalid');
  assert.match(p.items[0].error, /gotowy PDF/);
});
test('akcja email i preview reguły cofają również zaszyfrowany załącznik', async () => {
  const o = await order();
  await document(o);
  const t = await template({ attachment: 'invoice' }),
    p = await actionPreview(t, await ok('/api/orders/' + o.id));
  assert.equal(p.allowed, true);
  assert.equal(p.result[0].email.payload.attachment.source, 'demo');
  assert.equal((await rows()).rowCount, 0);
  const r = await ok('/api/automations', 'POST', {
    name: 'QA invoice',
    trigger: 'order.created',
    actions: [action(t)],
  });
  const rp = await ok('/api/automations/' + r.id + '/preview', 'POST', { order_id: o.id });
  assert.equal(rp.allowed, true);
  assert.equal((await rows()).rowCount, 0);
});
test('operacja masowa dołącza gotowe faktury i pomija zamówienie bez dokumentu', async () => {
  const o = await order(),
    empty = await order();
  await document(o);
  const t = await template({ attachment: 'invoice' });
  const p = await ok('/api/orders/batches/preview', 'POST', {
    order_ids: [o.id, empty.id],
    action: action(t),
  });
  assert.equal(p.items.filter((i: any) => i.allowed).length, 1);
  await ok('/api/order-batches/' + p.id + '/queue', 'POST', { confirmed: true });
  await drain();
  const b = await ok('/api/order-batches/' + p.id);
  assert.equal(b.state, 'done');
  assert.equal((await rows()).rowCount, 1);
});
test('SMTP ignoruje ścieżki i URL; wymagany jest bufor i bezpieczna nazwa', async () => {
  const client = new SmtpClient(
    {
      delivery: 'local_sink',
      host: '127.0.0.1',
      port: 1025,
      from_email: 'orders@example.test',
      from_name: 'QA',
    },
    { username: 'dyna-local', password: localSmtpPassword() },
  );
  for (const attachment of [
    { filename: 'x.pdf', content_type: 'application/pdf', content: 'file:///etc/passwd' },
    { filename: 'x.pdf\r\nBCC:x', content_type: 'application/pdf', content: pdf },
    { filename: 'x.pdf', content_type: 'application/pdf', content: Buffer.alloc(2097153) },
  ])
    await assert.rejects(
      client.send({
        id: randomUUID(),
        recipient: 'buyer@example.test',
        subject: 'QA',
        text: 'QA',
        html: '<p>QA</p>',
        attachment,
      } as any),
    );
  assert.equal(received.length, 0);
});
test('limit 20 MiB partii cofa wszystkie wiadomości i pliki', async () => {
  pdfResponse = Buffer.concat([
    Buffer.from('%PDF-1.4\n'),
    Buffer.alloc(1900000, 32),
    Buffer.from('\n%%EOF'),
  ]);
  const orders = [];
  for (let i = 0; i < 12; i++) {
    const o = await order(),
      d = await externalDoc(o);
    await cache(d);
    orders.push(await ok('/api/orders/' + o.id));
  }
  const t = await template({ attachment: 'invoice' }),
    r = await req('/api/email/preview', 'POST', {
      template_id: t.id,
      template_version: t.version,
      order_ids: orders.map((o) => o.id),
      mode: 'local',
      client_key: randomUUID(),
    });
  assert.equal(r.statusCode, 422);
  assert.match(r.body, /20 MiB/);
  assert.equal((await rows()).rowCount, 0);
  assert.equal(
    (await pool.query('SELECT * FROM email_messages WHERE tenant_id=$1', [tenant])).rowCount,
    0,
  );
});
test('zmiana zewnętrznej faktury pomiędzy odczytami blokuje zapis PDF', async () => {
  const o = await order(),
    d = await externalDoc(o);
  mutateFetch = async () => {
    invoiceHeader = { ...invoiceHeader, status: 'updated' };
  };
  assert.equal(
    (await req('/api/documents/' + d.id + '/email-file', 'POST', { confirmed: true })).statusCode,
    409,
  );
  assert.equal(
    (await pool.query('SELECT * FROM invoice_email_files WHERE tenant_id=$1', [tenant])).rowCount,
    0,
  );
});
test('niezgodne kwoty i ID Fakturowni odrzucają PDF przed pobraniem', async () => {
  const o = await order(),
    d = await externalDoc(o);
  invoiceHeader = { ...invoiceHeader, price_gross: '1.00' };
  assert.equal(
    (await req('/api/documents/' + d.id + '/email-file', 'POST', { confirmed: true })).statusCode,
    409,
  );
  assert(!calls.some((c) => c.endsWith('.pdf')));
});
test('reguła po przygotowaniu faktury zapisuje jeden załącznik i kompletny email', async () => {
  const o = await order();
  await document(o);
  const t = await template({ attachment: 'invoice' });
  await ok('/api/automations', 'POST', {
    name: 'QA invoice rule',
    trigger: 'order.picking',
    actions: [action(t), { type: 'add_note', note: 'Po emailu' }],
  });
  await ok('/api/orders/' + o.id + '/status', 'PATCH', await legacySerialOrderStatusPayload((orderPath) => ok(orderPath, 'GET', undefined), '/api/orders/' + o.id + '/status', { status: 'picking' }));
  await drain();
  const m = (await ok('/api/email/messages?order_id=' + o.id)).data[0];
  assert.equal(m.state, 'simulated');
  assert(m.automation_run_id);
  assert.equal(m.payload.attachment.source, 'demo');
  assert.equal((await rows()).rowCount, 1);
});
test('harmonogram przechowuje załącznik razem z intencją i nie dubluje go przy replay', async () => {
  const o = await order();
  await document(o);
  const t = await template({ attachment: 'invoice' });
  const s = await ok('/api/automation-schedules', 'POST', {
    name: 'QA invoice schedule',
    enabled: true,
    frequency: { kind: 'interval', seconds: 3600 },
    statuses: ['paid'],
    min_age_seconds: 0,
    actions: [action(t)],
    client_key: randomUUID(),
  });
  const request = { version: s.version, client_key: randomUUID(), confirmed: true };
  const r = await ok('/api/automation-schedules/' + s.id + '/run', 'POST', request);
  await drain();
  const replay = await ok('/api/automation-schedules/' + s.id + '/run', 'POST', request);
  assert.equal(replay.id, r.id);
  const m = (await ok('/api/email/messages?order_id=' + o.id)).data[0];
  assert.equal(m.state, 'simulated');
  assert(m.automation_schedule_run_id);
  assert.equal((await rows()).rowCount, 1);
});
test('niepewne SMTP nie ponawia wiadomości ani nie zastępuje zamrożonego pliku', async () => {
  const o = await order();
  await document(o);
  const b = await queue(
    await preview(await template({ attachment: 'invoice' }), [await ok('/api/orders/' + o.id)], {
      mode: 'smtp',
      channel_id: await localChannel(),
    }),
  );
  rejectData = true;
  const f = (await rows()).rows[0];
  await drain();
  assert.equal((await ok('/api/email/batches/' + b.id)).items[0].state, 'uncertain');
  assert.equal(received.length, 1);
  await queue(b);
  await drain();
  assert.equal(received.length, 1);
  assert.deepEqual((await rows()).rows[0], f);
});
test('API v1 chroni plik zakresem communications:read i zachowuje bajty MIME', async () => {
  const o = await order();
  await document(o);
  const p = await preview(await template({ attachment: 'invoice' }), [
      await ok('/api/orders/' + o.id),
    ]),
    url = '/api/v1/email/messages/' + p.items[0].id + '/attachment';
  const read = (
    await ok('/api/developer/keys', 'POST', { name: 'QA read', scopes: ['communications:read'] })
  ).token;
  const write = (
    await ok('/api/developer/keys', 'POST', { name: 'QA write', scopes: ['orders:write'] })
  ).token;
  assert.equal(
    (await app.inject({ url, headers: { authorization: 'Bearer ' + write } })).statusCode,
    403,
  );
  const r = await app.inject({ url, headers: { authorization: 'Bearer ' + read } });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(
    r.rawPayload,
    (await req('/api/email/messages/' + p.items[0].id + '/attachment')).rawPayload,
  );
});
test('100 faktur w partii: zamrożone pliki, kolejka i symulacja z pomiarem', async () => {
  // Seed the scale dataset directly in this disposable database; exercise the real preview/queue/worker below.
  const o = await order(),
    d = await document(o);
  const sourceOrder = (await pool.query('SELECT to_jsonb(o) row FROM orders o WHERE id=$1', [o.id]))
    .rows[0].row;
  const sourceDocument = (
    await pool.query('SELECT to_jsonb(d) row FROM documents d WHERE id=$1', [d.id])
  ).rows[0].row;
  const orders = [o];
  for (let i = 1; i < 100; i++) {
    const id = randomUUID();
    await pool.query(
      'INSERT INTO orders SELECT (jsonb_populate_record(NULL::orders,$1::jsonb)).*',
      [
        JSON.stringify({
          ...sourceOrder,
          id,
          number: 'QA-SCALE-' + id,
          portal_token:
            randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '').slice(0, 16),
        }),
      ],
    );
    await pool.query(
      'INSERT INTO documents SELECT (jsonb_populate_record(NULL::documents,$1::jsonb)).*',
      [
        JSON.stringify({
          ...sourceDocument,
          id: randomUUID(),
          order_id: id,
          number: 'DEMO-SCALE-' + id,
        }),
      ],
    );
    orders.push({ id });
  }
  const t = await template({ attachment: 'invoice' }),
    start = performance.now(),
    b = await preview(t, orders);
  assert.equal(b.items.filter((m: any) => m.state === 'draft').length, 100);
  assert.equal((await rows()).rowCount, 100);
  await queue(b);
  await drain();
  const done = await ok('/api/email/batches/' + b.id);
  assert(done.items.every((m: any) => m.state === 'simulated'));
  console.log(
    JSON.stringify({
      scale_fixture: '100_local_invoice_attachments',
      elapsed_ms: Math.round(performance.now() - start),
      files: 100,
      bytes: done.items.reduce((n: number, m: any) => n + m.payload.attachment.size, 0),
      SMTP_requests: 0,
    }),
  );
});
test('zewnętrzny SMTP odrzuca dokumenty DEMO i PDF symulatora przed połączeniem', async () => {
  const o = await order({
    address: { street: 'Testowa 1', city: 'Warszawa', postal_code: '00-001', country: 'PL' },
  });
  await odooDoc(o);
  const ch = await ok('/api/integrations', 'POST', {
    provider: 'smtp',
    name: 'QA external blocked',
    mode: 'sandbox',
    settings: {
      host: 'smtp.example.com',
      port: '587',
      from_email: 'qa@example.test',
      from_name: 'QA',
    },
    credentials: { username: 'qa-only', password: 'not-a-provider-credential' },
  });
  for (const attachment of ['invoice', 'odoo_invoice']) {
    const p = await preview(await template({ attachment }), [await ok('/api/orders/' + o.id)], {
      mode: 'smtp',
      channel_id: ch.id,
    });
    assert.equal(p.items[0].state, 'invalid');
    assert.match(p.items[0].error, /rzeczywistego dokumentu/);
  }
  assert.equal(received.length, 0);
  assert.equal((await rows()).rowCount, 0);
});
test('starszy podgląd z DEMO nie przejdzie zatwierdzenia w zewnętrznym SMTP', async () => {
  const o = await order();
  await document(o);
  const p = await preview(await template({ attachment: 'invoice' }), [
    await ok('/api/orders/' + o.id),
  ]);
  const ch = await ok('/api/integrations', 'POST', {
    provider: 'smtp',
    name: 'QA historical guard',
    mode: 'sandbox',
    settings: {
      host: 'smtp.example.com',
      port: '587',
      from_email: 'qa@example.test',
      from_name: 'QA',
    },
    credentials: { username: 'qa-only', password: 'not-a-provider-credential' },
  });
  const row = (await pool.query('SELECT * FROM channels WHERE id=$1', [ch.id])).rows[0];
  const { emailChannelHash } = await import('../server/email-hash');
  await pool.query(
    "UPDATE email_batches SET mode='smtp',channel_id=$2,channel_hash=$3 WHERE id=$1",
    [p.id, ch.id, emailChannelHash(row)],
  );
  const old = process.env.DYNA_ALLOW_EXTERNAL_EMAIL;
  process.env.DYNA_ALLOW_EXTERNAL_EMAIL = 'true';
  try {
    const r = await req('/api/email/batches/' + p.id + '/queue', 'POST', {
      confirmed: true,
      confirm_external: true,
    });
    assert.equal(r.statusCode, 422);
    assert.match(r.body, /rzeczywistego dokumentu/);
  } finally {
    if (old === undefined) delete process.env.DYNA_ALLOW_EXTERNAL_EMAIL;
    else process.env.DYNA_ALLOW_EXTERNAL_EMAIL = old;
  }
  assert.equal(received.length, 0);
  assert.equal((await ok('/api/email/batches/' + p.id)).state, 'preview');
});
test('backup odtwarza obie tabele plików, paginację i wykrywa uszkodzoną treść', async () => {
  const { createBackup, restoreBackup, restoreDatabaseName, localDatabase } =
    await import('../server/recovery');
  const { mkdir, rm } = await import('node:fs/promises'),
    dir = 'data/test-email-file-backup-' + randomUUID();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  let database: string | undefined;
  const ids = [];
  for (let i = 0; i < 13; i++) {
    const o = await order(),
      d = await externalDoc(o);
    await cache(d);
    ids.push(await ok('/api/orders/' + o.id));
  }
  const b = await preview(await template({ attachment: 'invoice' }), ids),
    own = (await rows()).rows;
  const cached = (
    await pool.query(
      'SELECT * FROM invoice_email_files WHERE tenant_id=$1 ORDER BY document_id,source_hash',
      [tenant],
    )
  ).rows;
  assert.equal(own.length, 13);
  assert.equal(cached.length, 13);
  try {
    const backup = await createBackup({ directory: dir }),
      r = await restoreBackup(backup.file, { directory: dir + '/restore' });
    database = restoreDatabaseName(r.database);
    assert(r.row_fingerprints_match && r.schema_fingerprint_match);
    assert(r.encrypted_records_verified >= 26);
    assert.deepEqual(
      (
        await pool.query(
          `SELECT * FROM email_message_files WHERE tenant_id=$1 ORDER BY message_id`,
          [tenant],
        )
      ).rows,
      own.sort((a: any, b: any) => a.message_id.localeCompare(b.message_id)),
    );
    const pg = await import('pg'),
      client = new pg.default.Client({ ...localDatabase(), database });
    await client.connect();
    try {
      assert.deepEqual(
        (
          await client.query(
            'SELECT * FROM invoice_email_files WHERE tenant_id=$1 ORDER BY document_id,source_hash',
            [tenant],
          )
        ).rows,
        cached,
      );
      assert.equal(
        (await client.query('SELECT * FROM email_message_files WHERE tenant_id=$1', [tenant]))
          .rowCount,
        13,
      );
    } finally {
      await client.end();
    }
    await pool.query('DROP DATABASE ' + database + ' WITH (FORCE)');
    database = undefined;
    const f = own[0];
    await pool.query('UPDATE email_message_files SET content_encrypted=$2 WHERE message_id=$1', [
      f.message_id,
      encrypt({ file_base64: Buffer.from('corrupt').toString('base64') }),
    ]);
    try {
      const bad = await createBackup({ directory: dir });
      await assert.rejects(
        restoreBackup(bad.file, { directory: dir + '/invalid-restore' }),
        /załącznik|metadanym/,
      );
    } finally {
      await pool.query('UPDATE email_message_files SET content_encrypted=$2 WHERE message_id=$1', [
        f.message_id,
        f.content_encrypted,
      ]);
    }
    assert.equal((await ok('/api/email/batches/' + b.id)).items.length, 13);
  } finally {
    if (database) await pool.query('DROP DATABASE ' + database + ' WITH (FORCE)');
    await rm(dir, { recursive: true, force: true });
  }
});
