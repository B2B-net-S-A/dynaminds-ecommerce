import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool, migrate, tenantTx } from '../server/db';
import { seed } from './fixtures';
import {
  emailInboundFixture,
  normalizedInboundPreview,
  inboundBusiness,
} from './email-inbound-fixture';
assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/dynaminds_test_\d+$/);
let app: Awaited<ReturnType<typeof buildApp>>;
before(async () => {
  await migrate();
  await seed();
  app = await buildApp();
});
after(async () => {
  await app?.close();
  await pool.end();
});
test('restore refuses malformed account/fetch/import/bind/reply writes before parsing in both aliases, but allows metadata reads', async () => {
  const f = await emailInboundFixture(app),
    readonly = await buildApp({ readOnly: true, previewPort: 4196 }),
    before = await inboundBusiness(f);
  try {
    const denied = await readonly.inject({
      url: '/api/email-inbound/options',
      headers: { cookie: f.cookie },
      remoteAddress: f.remoteAddress,
    });
    assert.equal(denied.statusCode, 401);
    const login = await readonly.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' },
      remoteAddress: f.remoteAddress,
    });
    assert.equal(login.statusCode, 200);
    const sw = await readonly.inject({
      method: 'POST',
      url: '/api/workspaces/switch',
      payload: { tenant_id: f.tenant },
      headers: { cookie: String(login.headers['set-cookie']).split(';')[0] },
      remoteAddress: f.remoteAddress,
    });
    assert.equal(sw.statusCode, 200);
    const readonlyCookie = String(sw.headers['set-cookie']).split(';')[0];
    for (const prefix of ['/api', '/api/v1']) {
      for (const [method, path] of [
        ['POST', '/accounts'],
        ['PATCH', '/accounts/' + f.account.id],
        ['POST', '/accounts/' + f.account.id + '/previews'],
        ['POST', '/acquisitions/' + randomUUID() + '/reconcile'],
        ['POST', '/previews/' + randomUUID() + '/import'],
        ['POST', '/messages/' + randomUUID() + '/bind'],
        ['POST', '/messages/' + randomUUID() + '/reply-previews'],
        ['POST', '/reply-previews/' + randomUUID() + '/queue'],
      ] as const) {
        const r = await readonly.inject({
          url: prefix + '/email-inbound' + path,
          method,
          payload: '{',
          headers: { cookie: readonlyCookie, 'content-type': 'application/json' },
          remoteAddress: f.remoteAddress,
        });
        assert.equal(r.statusCode, 423);
        assert.match(String(r.headers['cache-control']), /no-store/);
      }
      const r = await readonly.inject({
        url: prefix + '/email-inbound/options',
        headers: { cookie: readonlyCookie },
        remoteAddress: f.remoteAddress,
      });
      assert.equal(r.statusCode, 200);
      assert.equal(r.json().read_only, true);
      assert.equal(r.json().can_write, false);
      assert.equal(r.json().can_manage_accounts, false);
    }
  } finally {
    await readonly.close();
  }
  assert.deepEqual(await inboundBusiness(f), before);
});
test('disabled deferred core proof or missing typed helper fails closed, including direct guarded writer', async () => {
  const f = await emailInboundFixture(app),
    c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('ALTER TABLE customer_messages DISABLE TRIGGER email_inbound_core_complete');
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [f.tenant]);
    await assert.rejects(
      c.query("SELECT email_inbound_begin($1,'account_create',NULL,$2,NULL,$3,$4)", [
        randomUUID(),
        f.user,
        randomUUID(),
        'a'.repeat(64),
      ]),
      (e: any) => e.code === '55000' && e.message === 'Niekompletny odbiór email',
    );
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
  const signature = 'email_inbound_import_reference(uuid,uuid,uuid)';
  await pool.query(`ALTER FUNCTION ${signature} RENAME TO qa156_hidden_reference`);
  try {
    const r = await f.request('/email-inbound/options');
    assert.equal(r.statusCode, 503);
    const malformed = await f.request(
      '/email-inbound/previews/' + randomUUID() + '/import',
      'POST',
      '{',
    );
    assert.equal(malformed.statusCode, 503);
  } finally {
    await pool.query(
      'ALTER FUNCTION qa156_hidden_reference(uuid,uuid,uuid) RENAME TO email_inbound_import_reference',
    );
  }
});
test('typed normalized UID window rejects impossible cursor without leaving source/acquisition rows', async () => {
  const f = await emailInboundFixture(app),
    before = (
      await pool.query(
        'SELECT to_jsonb(x) row FROM email_inbound_acquisitions x WHERE tenant_id=$1',
        [f.tenant],
      )
    ).rows;
  await assert.rejects(
    normalizedInboundPreview(f, '', { empty: true, uidnext: '2', after_uid: '2' }),
    (e: any) => e.code === '23514' && e.message === 'Nieprawidłowe okno UID',
  );
  assert.deepEqual(
    (
      await pool.query(
        'SELECT to_jsonb(x) row FROM email_inbound_acquisitions x WHERE tenant_id=$1',
        [f.tenant],
      )
    ).rows,
    before,
  );
});
test('unknown durable intent requires explicit reconcile and original account/body/principal; no implicit new GET', async () => {
  const f = await emailInboundFixture(app),
    request = {
      client_key: randomUUID(),
      account_version: f.account.version,
      after_uid: null,
      expected_uidvalidity: null,
      limit: 1,
      confirmed_read: true,
    },
    aid = randomUUID();
  await tenantTx(f.tenant, async (c) => {
    const config = (
        await c.query("SELECT email_inbound_read($1,NULL,'transport',$2) r", [f.user, f.account.id])
      ).rows[0].r,
      op = randomUUID(),
      h = 'b'.repeat(64);
    await c.query("SELECT email_inbound_begin($1,'fetch_begin',$2,$3,NULL,$4,$5)", [
      op,
      f.account.id,
      f.user,
      request.client_key,
      h,
    ]);
    await c.query('SELECT email_inbound_store($1,$2,$3,$4)', [
      op,
      request.client_key,
      h,
      { id: aid, request, config_hash: config.config_hash },
    ]);
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
  });
  await tenantTx(f.tenant, (c) =>
    c.query("SELECT email_inbound_abandon_fetch($1,$2,NULL,'UNKNOWN')", [aid, f.user]),
  );
  const before = (
    await pool.query('SELECT count(*) n FROM email_inbound_acquisitions WHERE tenant_id=$1', [
      f.tenant,
    ])
  ).rows[0].n;
  const blocked = await f.request('/email-inbound/accounts/' + f.account.id + '/previews', 'POST', {
    ...request,
    client_key: randomUUID(),
  });
  assert.equal(blocked.statusCode, 409);
  assert.equal(
    (
      await pool.query('SELECT count(*) n FROM email_inbound_acquisitions WHERE tenant_id=$1', [
        f.tenant,
      ])
    ).rows[0].n,
    before,
  );
  const rb = { client_key: randomUUID(), confirmed_abandon: true },
    resolved = await f.ok('/email-inbound/acquisitions/' + aid + '/reconcile', 'POST', rb);
  assert.equal(resolved.acquisition.state, 'abandoned');
  assert.equal(
    (await f.ok('/email-inbound/acquisitions/' + aid + '/reconcile', 'POST', rb)).reused,
    true,
  );
});
test('actual wholly absent141 is neutral on GET/HEAD and denies malformed writes before parse in both aliases', async () => {
  const f = await emailInboundFixture(app),
    tables = [
      'email_inbound_accounts',
      'email_inbound_acquisitions',
      'email_inbound_sources',
      'email_inbound_previews',
      'email_inbound_messages',
      'email_inbound_bindings',
      'email_inbound_reply_previews',
      'email_inbound_replies',
      'email_inbound_operations',
      'email_inbound_admissions',
    ],
    functions = (
      await pool.query(
        "SELECT oid,proname FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'email_inbound_%' ORDER BY oid",
      )
    ).rows,
    marker = (
      await pool.query(
        "SELECT name,applied_at::text AS applied_at FROM migrations WHERE name='141_email_inbound'",
      )
    ).rows[0];
  assert(marker);
  assert(functions.length >= 20);
  const c = await pool.connect();
  let hidden = false;
  try {
    await c.query('BEGIN');
    for (const fn of functions) {
      assert.match(fn.proname, /^email_inbound_[a-z_]+$/);
      const signature = (await c.query('SELECT $1::oid::regprocedure::text signature', [fn.oid]))
        .rows[0].signature;
      await c.query(`ALTER FUNCTION ${signature} RENAME TO qa156_hidden_${fn.oid}`);
    }
    for (const table of tables)
      await c.query(`ALTER TABLE ${table} RENAME TO qa156_hidden_${table}`);
    await c.query(
      'ALTER TABLE email_batches RENAME COLUMN inbound_reply_preview_id TO qa156_hidden_origin',
    );
    await c.query("DELETE FROM migrations WHERE name='141_email_inbound'");
    await c.query('COMMIT');
    hidden = true;
    for (const prefix of ['/api', '/api/v1']) {
      for (const method of ['GET', 'HEAD'] as const) {
        const r = await app.inject({
          url: prefix + '/email-inbound/options',
          method,
          headers: { cookie: f.cookie },
          remoteAddress: f.remoteAddress,
        });
        assert.equal(r.statusCode, 200);
        if (method === 'GET') {
          assert.equal(r.json().available, false);
          assert.deepEqual(r.json().accounts, []);
        } else assert.equal(r.body, '');
      }
      const r = await app.inject({
        url: prefix + '/email-inbound/accounts',
        method: 'POST',
        payload: '{',
        headers: { cookie: f.cookie, 'content-type': 'application/json' },
        remoteAddress: f.remoteAddress,
      });
      assert.equal(r.statusCode, 503);
    }
  } finally {
    if (hidden) {
      await c.query('BEGIN');
      for (const table of tables)
        await c.query(`ALTER TABLE qa156_hidden_${table} RENAME TO ${table}`);
      await c.query(
        'ALTER TABLE email_batches RENAME COLUMN qa156_hidden_origin TO inbound_reply_preview_id',
      );
      for (const fn of functions) {
        const signature = (await c.query('SELECT $1::oid::regprocedure::text signature', [fn.oid]))
          .rows[0].signature;
        await c.query(`ALTER FUNCTION ${signature} RENAME TO ${fn.proname}`);
      }
      await c.query('INSERT INTO migrations(name,applied_at) VALUES($1,$2)', [
        marker.name,
        marker.applied_at,
      ]);
      await c.query('COMMIT');
    } else await c.query('ROLLBACK');
    c.release();
  }
});
test('one reply admission cannot certify an additional orphan SMTP batch; the complete genuine graph rolls back', async () => {
  const f = await emailInboundFixture(app),
    p = await normalizedInboundPreview(f),
    im = await f.ok(
      '/email-inbound/previews/' + p.id + '/import',
      'POST',
      { client_key: randomUUID(), scope_hash: p.scope_hash, confirmed: true },
      201,
    ),
    m = (await f.ok('/email-inbound/messages/' + im.import.message_ids[0])).message;
  const b = await f.ok(
      '/email-inbound/messages/' + m.id + '/bind',
      'POST',
      {
        client_key: randomUUID(),
        version: m.version,
        order_id: f.order.id,
        order_version: f.order.version,
        confirmed: true,
      },
      201,
    ),
    rp = (
      await f.ok(
        '/email-inbound/messages/' + m.id + '/reply-previews',
        'POST',
        {
          client_key: randomUUID(),
          version: b.message.version,
          order_version: f.order.version,
          smtp_channel_id: f.channel,
          recipient: 'reply@example.test',
          subject: 'Explicit source reply',
          text: 'No orphan batch',
        },
        201,
      )
    ).reply_preview;
  const facts = async () => {
      const r: Record<string, any> = {};
      for (const table of [
        'email_batches',
        'email_messages',
        'jobs',
        'email_inbound_replies',
        'email_inbound_operations',
        'email_inbound_admissions',
      ])
        r[table] = (
          await pool.query(`SELECT to_jsonb(x) r FROM ${table} x WHERE tenant_id=$1 ORDER BY 1`, [
            f.tenant,
          ])
        ).rows;
      return r;
    },
    before = await facts();
  await assert.rejects(
    tenantTx(f.tenant, async (c) => {
      const op = randomUUID(),
        ck = randomUUID(),
        h = 'c'.repeat(64),
        batch = randomUUID();
      await c.query("SELECT email_inbound_begin($1,'reply_queue',$2,$3,NULL,$4,$5)", [
        op,
        rp.id,
        f.user,
        ck,
        h,
      ]);
      await c.query('SELECT email_inbound_store($1,$2,$3,$4)', [
        op,
        ck,
        h,
        {
          client_key: ck,
          scope_hash: rp.scope_hash,
          confirmed: true,
          confirm_external: false,
          id: randomUUID(),
          batch_id: batch,
          email_message_id: randomUUID(),
          job_id: randomUUID(),
        },
      ]);
      await c.query(
        'INSERT INTO email_batches(id,tenant_id,actor_id,template_id,template_version,channel_id,channel_hash,mode,client_key,request_hash,state,external_allowed,inbound_reply_preview_id,inbound_api_key_id) SELECT $2,tenant_id,actor_id,template_id,template_version,channel_id,channel_hash,mode,$3,request_hash,state,external_allowed,inbound_reply_preview_id,inbound_api_key_id FROM email_batches WHERE id=$1',
        [batch, randomUUID(), randomUUID()],
      );
      await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    }),
    (e: any) =>
      e.code === '23514' && e.message === 'Brak dokładnej bijekcji partii odpowiedzi SMTP',
  );
  assert.deepEqual(await facts(), before);
});
