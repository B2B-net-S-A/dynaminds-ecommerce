import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { pool, tenantTx } from '../server/db';
import { encrypt } from '../server/security';
import { parseInboundMime } from '../server/email-inbound-mime';
let ip = 0;
/** Test-only synthetic normalized IMAP source. This is NOT transport/provider acceptance. */
export async function emailInboundFixture(app: FastifyInstance) {
  const tenant = randomUUID(),
    warehouse = randomUUID(),
    user = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id,
    remoteAddress = '127.156.0.' + ++ip;
  await pool.query(
    "INSERT INTO tenants(id,name,plan) VALUES($1,'Own inbound email test','enterprise')",
    [tenant],
  );
  await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [
    tenant,
    user,
  ]);
  await pool.query(
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Own inbound test','EMAIL')",
    [warehouse, tenant],
  );
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' },
    remoteAddress,
  });
  assert.equal(login.statusCode, 200);
  const sw = await app.inject({
    method: 'POST',
    url: '/api/workspaces/switch',
    payload: { tenant_id: tenant },
    headers: { cookie: String(login.headers['set-cookie']).split(';')[0] },
    remoteAddress,
  });
  assert.equal(sw.statusCode, 200);
  const cookie = String(sw.headers['set-cookie']).split(';')[0];
  const request = (path: string, method: any = 'GET', body?: any) =>
    app.inject({
      url: path.startsWith('/api/') ? path : '/api' + path,
      method,
      payload: body,
      headers: {
        cookie,
        ...(path === '/orders' && method === 'POST' ? { 'Idempotency-Key': randomUUID() } : {}),
      },
      remoteAddress,
    });
  const ok = async (path: string, method: any = 'GET', body?: any, status = 200): Promise<any> => {
    const r = await request(path, method, body);
    const d =
      r.statusCode === status
        ? ''
        : (() => {
            try {
              const v = r.json();
              return JSON.stringify({ title: v.title, detail: v.detail });
            } catch {
              return 'invalid response';
            }
          })();
    assert.equal(r.statusCode, status, `${method} ${path}: ${d}`);
    return r.json();
  };
  const product = await ok(
    '/products',
    'POST',
    {
      name: 'Own inbound product',
      sku: 'EMAIL-' + randomUUID(),
      price: 1000,
      quantity: 10,
      warehouse_id: warehouse,
    },
    201,
  );
  const born = await ok(
      '/orders',
      'POST',
      {
        customer_name: 'Email test buyer',
        email: 'order-buyer@example.test',
        warehouse_id: warehouse,
        items: [{ product_id: product.id, quantity: 1 }],
      },
      201,
    ),
    order = await ok('/orders/' + born.id);
  const channel = (await ok('/integrations/smtp-example', 'POST', {})).channel_id;
  const accountBody = {
    client_key: randomUUID(),
    name: 'Own synthetic normalized mailbox',
    host: '127.0.0.1',
    port: 4112,
    transport: 'local_fixture',
    folder: 'INBOX',
    smtp_channel_id: channel,
    enabled: true,
    credentials: { username: 'own-test', password: 'synthetic-not-provider' },
  };
  const account = (await ok('/email-inbound/accounts', 'POST', accountBody, 201)).account;
  return {
    app,
    tenant,
    warehouse,
    user,
    cookie,
    actor: { tenantId: tenant, userId: user, role: 'admin' as const, source: 'manual' as const },
    request,
    ok,
    product,
    order,
    channel,
    account,
    accountBody,
    remoteAddress,
  };
}
export async function normalizedInboundPreview(
  f: Awaited<ReturnType<typeof emailInboundFixture>>,
  text = 'Full source text',
  options: {
    empty?: boolean;
    uid?: string;
    uidnext?: string;
    after_uid?: string | null;
    raw?: Buffer;
  } = {},
) {
  const uid = options.uid ?? '1',
    after_uid = options.after_uid ?? null,
    fetchBody = {
      client_key: randomUUID(),
      account_version: f.account.version,
      after_uid,
      expected_uidvalidity: '156',
      limit: 1,
      confirmed_read: true,
    };
  const raw =
    options.raw ??
    Buffer.from(
      'From: Source Sender <sender@example.test>\r\nReply-To: Replies <reply@example.test>\r\nTo: Own <orders@example.test>\r\nMessage-ID: <source-156@example.test>\r\nSubject: Own source\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n' +
        text,
    );
  const parsed = await parseInboundMime(raw),
    acquisition = randomUUID(),
    preview = randomUUID();
  const hash = (x: string) => createHash('sha256').update(x).digest('hex');
  await tenantTx(f.tenant, async (c) => {
    const config = (
      await c.query("SELECT email_inbound_read($1,NULL,'transport',$2) r", [f.user, f.account.id])
    ).rows[0].r;
    const start = randomUUID();
    await c.query("SELECT email_inbound_begin($1,'fetch_begin',$2,$3,NULL,$4,$5)", [
      start,
      f.account.id,
      f.user,
      fetchBody.client_key,
      hash(start),
    ]);
    await c.query('SELECT email_inbound_store($1,$2,$3,$4)', [
      start,
      fetchBody.client_key,
      hash(start),
      { id: acquisition, request: fetchBody, config_hash: config.config_hash },
    ]);
    const finish = randomUUID();
    await c.query("SELECT email_inbound_begin($1,'fetch_finish',$2,$3,NULL,$4,$5)", [
      finish,
      acquisition,
      f.user,
      fetchBody.client_key,
      hash(finish),
    ]);
    const attachments = parsed.attachments.map((a, index) => ({
      index,
      filename: a.filename,
      mime: a.mime,
      bytes: a.bytes.length,
      sha256: a.sha256,
    }));
    const source = {
      id: randomUUID(),
      uid,
      raw_sha256: parsed.raw_sha256,
      raw_bytes: raw.length,
      headers: parsed.headers,
      text: parsed.text,
      attachments,
      content_encrypted: encrypt({
        raw_base64: raw.toString('base64'),
        attachments: parsed.attachments.map((a, index) => ({
          ...attachments[index],
          content_base64: a.bytes.toString('base64'),
        })),
      }),
    };
    const next = options.uidnext ?? String(BigInt(uid) + 1n),
      through = String(
        BigInt(next) - 1n < BigInt(after_uid ?? '0') + 1n
          ? BigInt(next) - 1n
          : BigInt(after_uid ?? '0') + 1n,
      );
    await c.query('SELECT email_inbound_store($1,$2,$3,$4)', [
      finish,
      fetchBody.client_key,
      hash(finish),
      {
        uidvalidity: '156',
        uidnext: next,
        scanned_through_uid: through,
        sources: options.empty ? [] : [source],
        preview_id: preview,
      },
    ]);
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
  });
  return (await f.ok('/email-inbound/previews/' + preview)).preview;
}
export async function inboundBusiness(f: Awaited<ReturnType<typeof emailInboundFixture>>) {
  const r: Record<string, any> = {};
  for (const name of [
    'orders',
    'order_items',
    'stock',
    'stock_locations',
    'stock_movements',
    'payment_entries',
    'documents',
    'shipments',
  ])
    r[name] = (
      await pool.query(`SELECT to_jsonb(x) row FROM ${name} x WHERE tenant_id=$1 ORDER BY 1`, [
        f.tenant,
      ])
    ).rows;
  return r;
}
