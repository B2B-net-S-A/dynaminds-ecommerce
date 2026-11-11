import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { pool, tenantTx, localConfig } from './db';
import { ensure, Problem } from './errors';
import { audit } from './domain';
import { encrypt, decrypt } from './security';
import { emailHash } from './email-hash';
import { smtpSettings, smtpReplyHeaders } from './smtp';
import { appendInboundCustomerMessageInTx } from './customer-messages';
import { fetchInboundMailbox, type InboundMailboxConfig } from './email-inbound-transport';
import * as V from './email-inbound-schema';
type Row = Record<string, any>;
export type EmailInboundActor = V.EmailInboundActor;
const tables = [
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
];
const functions = [
  'email_inbound_installed()',
  'email_inbound_guards()',
  'email_inbound_access(uuid,uuid,boolean,boolean,boolean)',
  'email_inbound_require(uuid,uuid,boolean,boolean,boolean)',
  'email_inbound_hash(jsonb)',
  'email_inbound_lock()',
  'email_inbound_budget()',
  'email_inbound_account_head(email_inbound_accounts)',
  'email_inbound_read(uuid,uuid,text,uuid,uuid,integer,jsonb)',
  'email_inbound_begin(uuid,text,uuid,uuid,uuid,uuid,text)',
  'email_inbound_store(uuid,uuid,text,jsonb)',
  'email_inbound_abandon_fetch(uuid,uuid,uuid,text)',
  'email_inbound_immutable()',
  'email_inbound_row_guard()',
  'email_inbound_complete()',
  'email_inbound_core_guard()',
  'email_inbound_core_complete()',
  'email_inbound_import_reference(uuid,uuid,uuid)',
  'email_inbound_reply_reference(uuid,uuid,uuid)',
  'email_inbound_core_message_metadata(uuid,uuid,uuid)',
  'email_inbound_worker_context(uuid,boolean)',
];
export async function inboundAvailable(c: Pool | PoolClient = pool): Promise<boolean> {
  try {
    const any = (
      await c.query(
        "SELECT EXISTS(SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace AND relname=ANY($1)) OR EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'email_inbound_%') OR EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.email_batches') AND attname='inbound_reply_preview_id' AND NOT attisdropped) present",
        [tables],
      )
    ).rows[0].present;
    if (!any) {
      if (c === pool)
        ensure(
          !(
            await c.query(
              "SELECT EXISTS(SELECT 1 FROM migrations WHERE name='141_email_inbound') installed",
            )
          ).rows[0].installed,
          503,
          'Niekompletny odbiór email',
        );
      return false;
    }
    ensure(
      (
        await c.query(
          'SELECT NOT EXISTS(SELECT 1 FROM unnest($1::text[])r(name) WHERE to_regclass(name) IS NULL) AND NOT EXISTS(SELECT 1 FROM unnest($2::text[])r(name) WHERE to_regprocedure(name) IS NULL) ok',
          [tables, functions],
        )
      ).rows[0].ok,
      503,
      'Niekompletny odbiór email',
    );
    ensure(
      (await c.query('SELECT email_inbound_installed() AND email_inbound_guards() ok')).rows[0].ok,
      503,
      'Niekompletny odbiór email',
    );
    return true;
  } catch (e) {
    if (['42P01', '42703', '42883', '42704'].includes((e as Row).code))
      throw new Problem(503, 'Niekompletny odbiór email');
    throw e;
  }
}
function mapped(e: unknown): never {
  const x = e as Row;
  if (x.code === '55000') throw new Problem(503, 'Niekompletny odbiór email');
  if (x.code === 'P0002') throw new Problem(404, 'Nie znaleziono własnego wyniku email');
  if (x.code === '23514') {
    if (x.message === 'Klucz odbioru email jest nieaktualny') throw new Problem(401, x.message);
    if (x.message === 'Brak aktualnego uprawnienia odbioru email')
      throw new Problem(403, x.message);
    throw new Problem(409, x.message ?? 'Email wymaga świeżych danych');
  }
  if (['23505', '23503', '22003'].includes(x.code))
    throw new Problem(409, 'Klucz lub źródło email jest już zajęte');
  throw e;
}
const neutral = () => ({
  available: false,
  read_only: false,
  current_role: null,
  can_read: false,
  can_write: false,
  can_manage_accounts: false,
});
async function flags(
  c: PoolClient,
  a: EmailInboundActor,
  writing: boolean,
  pin: boolean,
  manage = false,
  orders = false,
) {
  const g = (
    await c.query('SELECT email_inbound_access($1,$2,$3,$4,$5) g', [
      a.userId,
      a.apiKeyId ?? null,
      writing,
      pin,
      manage,
    ])
  ).rows[0].g;
  ensure(g.key_valid, 401, 'Klucz odbioru email jest nieaktualny');
  ensure(
    g.allowed && (!orders || g.can_order_read),
    403,
    'Brak aktualnego uprawnienia odbioru email',
  );
  return {
    available: true,
    read_only: false,
    current_role: g.role,
    can_read: true,
    can_write: g.can_write === true,
    can_manage_accounts: g.can_manage_accounts === true,
    can_order_read: g.can_order_read === true,
  };
}
function currentActions<T extends Row>(
  r: T,
  g: { can_write: boolean; can_order_read: boolean },
): T {
  const project = (v: Row) => ({
    ...v,
    ...('can_import' in v ? { can_import: v.can_import === true && g.can_write } : {}),
    ...('can_reconcile' in v ? { can_reconcile: v.can_reconcile === true && g.can_write } : {}),
    ...('can_bind' in v
      ? { can_bind: v.can_bind === true && g.can_write && g.can_order_read }
      : {}),
    ...('can_reply' in v
      ? { can_reply: v.can_reply === true && g.can_write && g.can_order_read }
      : {}),
    ...('can_queue' in v
      ? { can_queue: v.can_queue === true && g.can_write && g.can_order_read }
      : {}),
  });
  const result: Row = { ...r };
  for (const key of ['acquisition', 'preview', 'message', 'reply_preview'])
    if (r[key]) result[key] = project(r[key]);
  if (Array.isArray(r.data)) result.data = r.data.map(project);
  return result as T;
}
async function tx<T extends Row>(
  a: EmailInboundActor,
  writing: boolean,
  fn: (c: PoolClient) => Promise<T>,
  manage = false,
  orders = false,
): Promise<T & Awaited<ReturnType<typeof flags>>> {
  ensure(await inboundAvailable(), 503, 'Kopia nie zawiera odbioru email');
  try {
    return await tenantTx(a.tenantId, async (c) => {
      ensure(await inboundAvailable(c), 503, 'Kopia nie zawiera odbioru email');
      await flags(c, a, writing, false, manage, orders);
      const r = await fn(c);
      await c.query('SET CONSTRAINTS ALL IMMEDIATE');
      const finalGrant = await flags(c, a, writing, true, manage, orders);
      return { ...currentActions(r, finalGrant), ...finalGrant };
    });
  } catch (e) {
    return mapped(e);
  }
}
const id = (v: unknown) => V.inboundAccountCreateInput.shape.client_key.parse(v);
async function read(
  c: PoolClient,
  a: EmailInboundActor,
  op: string,
  rid: string | null = null,
  q: Row = {},
) {
  return (
    await c.query('SELECT email_inbound_read($1,$2,$3,$4,$5,$6,$7) r', [
      a.userId,
      a.apiKeyId ?? null,
      op,
      rid,
      q.cursor ?? null,
      q.limit ?? 50,
      q,
    ])
  ).rows[0].r as Row;
}
const requestHash = (a: EmailInboundActor, kind: string, target: string | null, b: unknown) =>
  createHmac('sha256', Buffer.from(localConfig.encryptionKey, 'hex'))
    .update(
      emailHash({
        tenant: a.tenantId,
        actor: a.userId,
        key: a.apiKeyId ?? null,
        kind,
        target,
        body: b,
      }),
    )
    .digest('hex');
async function begin(
  c: PoolClient,
  a: EmailInboundActor,
  kind: string,
  target: string | null,
  b: Row,
) {
  const hash = requestHash(a, kind, target, b);
  const op = (
    await c.query('SELECT email_inbound_begin($1,$2,$3,$4,$5,$6,$7) r', [
      randomUUID(),
      kind,
      target,
      a.userId,
      a.apiKeyId ?? null,
      b.client_key,
      hash,
    ])
  ).rows[0].r;
  return { ...op, hash } as { operation_id: string; hash: string; reused: boolean; result?: Row };
}
async function store(
  c: PoolClient,
  a: EmailInboundActor,
  op: Awaited<ReturnType<typeof begin>>,
  b: Row,
  data: Row,
) {
  const result = (
    await c.query('SELECT email_inbound_store($1,$2,$3,$4) r', [
      op.operation_id,
      b.client_key,
      op.hash,
      data,
    ])
  ).rows[0].r;
  await audit(c, a, 'email.inbound.operation', op.operation_id, { kind: Object.keys(result) });
  return result as Row;
}
const replayFlags = (op: { operation_id: string; reused: boolean }) => ({
  operation_id: op.operation_id,
  reused: op.reused,
});
export async function inboundOptions(a: EmailInboundActor) {
  if (!(await inboundAvailable()))
    return { ...neutral(), accounts: [], smtp_channels: [], limits: V.EMAIL_INBOUND_LIMITS };
  return tx(a, false, async (c) => ({
    accounts: (await read(c, a, 'accounts')).data,
    smtp_channels: await read(c, a, 'smtp'),
    limits: V.EMAIL_INBOUND_LIMITS,
  }));
}
export async function inboundAccounts(a: EmailInboundActor) {
  if (!(await inboundAvailable())) return { ...neutral(), data: [], next_cursor: null };
  return tx(a, false, (c) => read(c, a, 'accounts'));
}
export async function createInboundAccount(a: EmailInboundActor, input: unknown) {
  const b = V.inboundAccountCreateInput.parse(input);
  return tx(
    a,
    true,
    async (c) => {
      const op = await begin(c, a, 'account_create', null, b);
      if (op.reused) return { ...op.result, ...replayFlags(op) };
      const { credentials, ...fields } = b;
      return {
        ...(await store(c, a, op, b, {
          ...fields,
          id: randomUUID(),
          credentials_encrypted: encrypt(credentials),
          username_masked: mask(credentials.username),
        })),
        ...replayFlags(op),
      };
    },
    true,
  );
}
export async function updateInboundAccount(a: EmailInboundActor, rid: string, input: unknown) {
  rid = id(rid);
  const b = V.inboundAccountUpdateInput.parse(input);
  return tx(
    a,
    true,
    async (c) => {
      const op = await begin(c, a, 'account_update', rid, b);
      if (op.reused) return { ...op.result, ...replayFlags(op) };
      const { credentials, ...fields } = b;
      return {
        ...(await store(c, a, op, b, {
          ...fields,
          credentials_action: credentials.action,
          credentials_encrypted:
            credentials.action === 'replace'
              ? encrypt({ username: credentials.username, password: credentials.password })
              : null,
          username_masked: credentials.action === 'replace' ? mask(credentials.username) : '',
        })),
        ...replayFlags(op),
      };
    },
    true,
  );
}
function mask(username: string) {
  return username.length < 3 ? '***' : username[0] + '***' + username.slice(-1);
}
function acquisitionHead(row: Row, g: { can_write: boolean }, a: EmailInboundActor) {
  return {
    ...row,
    account_version: String(row.account_version),
    can_reconcile:
      g.can_write &&
      row.actor_id === a.userId &&
      row.api_key_id === (a.apiKeyId ?? null) &&
      ['fetching', 'unknown', 'failed'].includes(row.state),
  };
}
async function previewView(
  c: PoolClient,
  a: EmailInboundActor,
  rid: string,
  g: { can_write: boolean },
) {
  const p = await read(c, a, 'preview', rid);
  const operation = (
    await c.query('SELECT email_inbound_import_reference($1,$2,$3) r', [
      rid,
      a.userId,
      a.apiKeyId ?? null,
    ])
  ).rows[0].r;
  return {
    id: p.id,
    acquisition_id: p.acquisition_id,
    ...p.payload,
    scope_hash: p.scope_hash,
    created_at: p.created_at,
    expires_at: p.expires_at,
    can_import:
      g.can_write &&
      p.actor_id === a.userId &&
      p.api_key_id === (a.apiKeyId ?? null) &&
      !operation &&
      Date.parse(p.expires_at) > Date.now(),
    import_operation_id: operation,
  };
}
export async function prepareInboundEmail(a: EmailInboundActor, accountId: string, input: unknown) {
  accountId = id(accountId);
  const b = V.inboundFetchInput.parse(input);
  const started = await tx(a, true, async (c) => {
    const op = await begin(c, a, 'fetch_begin', accountId, b);
    if (op.reused) {
      const ac = await read(c, a, 'acquisition', op.result!.acquisition_id);
      return { acquisition: ac, ...replayFlags(op), config: null };
    }
    const config = await read(c, a, 'transport', accountId);
    const r = await store(c, a, op, b, {
      id: randomUUID(),
      request: b,
      config_hash: config.config_hash,
    });
    return {
      acquisition: await read(c, a, 'acquisition', r.acquisition_id),
      ...replayFlags(op),
      config,
    };
  });
  if (started.reused)
    return inboundAcquisition(a, started.acquisition.id, {
      operation_id: started.operation_id,
      reused: true,
    });
  const config = started.config as Row;
  const check = async () => {
    await tx(a, true, async (c) => {
      const ac = await read(c, a, 'acquisition', started.acquisition.id);
      const current = await read(c, a, 'transport', accountId);
      ensure(
        ac.state === 'fetching' && current.config_hash === config.config_hash,
        409,
        'Konto IMAP zmieniło się podczas odczytu',
      );
      return {};
    });
  };
  try {
    const credentials = decrypt(config.credentials_encrypted) as {
      username: string;
      password: string;
    };
    const result = await fetchInboundMailbox(
      { ...config, ...credentials } as InboundMailboxConfig,
      { after_uid: b.after_uid, limit: b.limit, expected_uidvalidity: b.expected_uidvalidity },
      { beforeAuth: check, afterFetch: check },
    );
    const sources = result.messages.map((mail) => {
      const attachments = mail.attachments.map((f, index) => ({
        index,
        filename: f.filename,
        mime: f.mime,
        bytes: f.bytes.length,
        sha256: f.sha256,
      }));
      return {
        id: randomUUID(),
        uid: mail.uid,
        raw_sha256: mail.raw_sha256,
        raw_bytes: mail.raw.length,
        headers: mail.headers,
        text: mail.text,
        attachments,
        content_encrypted: encrypt({
          raw_base64: mail.raw.toString('base64'),
          attachments: mail.attachments.map((f, index) => ({
            ...attachments[index],
            content_base64: f.bytes.toString('base64'),
          })),
        }),
      };
    });
    await tx(a, true, async (c) => {
      const op = await begin(c, a, 'fetch_finish', started.acquisition.id, b);
      ensure(!op.reused, 409, 'Odczyt już zakończony');
      await store(c, a, op, b, {
        ...result,
        messages: undefined,
        sources,
        preview_id: randomUUID(),
      });
      return {};
    });
    return inboundAcquisition(a, started.acquisition.id, {
      operation_id: started.operation_id,
      reused: false,
    });
  } catch (e) {
    const x = e as Row;
    const code =
      x.code === 'UIDVALIDITY_CHANGED'
        ? 'UIDVALIDITY_CHANGED'
        : x.code?.startsWith('MIME')
          ? 'INVALID_MIME'
          : e instanceof Problem && [401, 403].includes(e.status)
            ? 'ACCESS_CHANGED'
            : 'UNKNOWN';
    await tenantTx(a.tenantId, (c) =>
      c.query('SELECT email_inbound_abandon_fetch($1,$2,$3,$4)', [
        started.acquisition.id,
        a.userId,
        a.apiKeyId ?? null,
        code,
      ]),
    ).catch(() => {});
    if (e instanceof Problem) throw e;
    throw new Problem(
      502,
      'Odczyt IMAP nie został opublikowany; sprawdź trwały wynik przed kolejną próbą',
    );
  }
}
export async function inboundAcquisition(
  a: EmailInboundActor,
  rid: string,
  operation?: { operation_id: string; reused: boolean },
) {
  return tx(a, false, async (c) => {
    const g = await flags(c, a, false, false),
      ac = await read(c, a, 'acquisition', id(rid));
    return {
      acquisition: acquisitionHead(ac, g, a),
      preview: ac.preview_id ? await previewView(c, a, ac.preview_id, g) : null,
      ...operation,
    };
  });
}
export async function inboundAcquisitions(a: EmailInboundActor, input: unknown) {
  const q = V.inboundHistoryInput.parse(input);
  return tx(a, false, async (c) => {
    const g = await flags(c, a, false, false),
      r = await read(c, a, 'acquisitions', null, q);
    return { ...r, data: r.data.map((ac: Row) => acquisitionHead(ac, g, a)) };
  });
}
export async function reconcileInboundAcquisition(
  a: EmailInboundActor,
  rid: string,
  input: unknown,
) {
  rid = id(rid);
  const b = V.inboundReconcileInput.parse(input);
  return tx(a, true, async (c) => {
    const op = await begin(c, a, 'reconcile', rid, b);
    const r = op.reused ? op.result! : await store(c, a, op, b, b);
    const g = await flags(c, a, true, false);
    return {
      acquisition: acquisitionHead(await read(c, a, 'acquisition', r.acquisition_id), g, a),
      ...replayFlags(op),
    };
  });
}
export async function inboundPreview(a: EmailInboundActor, rid: string) {
  return tx(a, false, async (c) => ({
    preview: await previewView(c, a, id(rid), await flags(c, a, false, false)),
  }));
}
export async function inboundPreviews(a: EmailInboundActor, input: unknown) {
  const q = V.inboundHistoryInput.parse(input);
  return tx(a, false, (c) => read(c, a, 'previews', null, q));
}
export async function importInboundEmail(a: EmailInboundActor, rid: string, input: unknown) {
  rid = id(rid);
  const b = V.inboundImportInput.parse(input);
  return tx(a, true, async (c) => {
    const op = await begin(c, a, 'import', rid, b);
    const r = op.reused ? op.result! : await store(c, a, op, b, b);
    return {
      ...r,
      preview: await previewView(c, a, rid, await flags(c, a, true, false)),
      ...replayFlags(op),
    };
  });
}
export async function inboundImport(a: EmailInboundActor, rid: string) {
  return tx(a, false, async (c) => {
    const op = await read(c, a, 'operation', id(rid));
    ensure(op.kind === 'import', 404, 'Nie znaleziono importu');
    return { ...op.result, operation_id: op.id };
  });
}
function messageView(m: Row, g: { can_write: boolean; can_order_read?: boolean }) {
  const { tenant_id, ...row } = m;
  return {
    ...row,
    can_bind: g.can_write && g.can_order_read === true && m.state === 'unassigned',
    can_reply: g.can_write && g.can_order_read === true && m.state === 'bound',
    attachment_count: m.attachments.length,
  };
}
export async function inboundMessages(a: EmailInboundActor, input: unknown) {
  const q = V.inboundListInput.parse(input);
  return tx(a, false, async (c) => {
    const g = await flags(c, a, false, false),
      r = await read(c, a, 'messages', null, q);
    return { ...r, data: r.data.map((m: Row) => messageView(m, g)) };
  });
}
export async function inboundMessage(a: EmailInboundActor, rid: string) {
  return tx(a, false, async (c) => ({
    message: messageView(await read(c, a, 'message', id(rid)), await flags(c, a, false, false)),
  }));
}
export async function bindInboundEmail(a: EmailInboundActor, rid: string, input: unknown) {
  rid = id(rid);
  const b = V.inboundBindInput.parse(input);
  return tx(
    a,
    true,
    async (c) => {
      const op = await begin(c, a, 'bind', rid, b);
      let r = op.result;
      if (!op.reused) {
        const m = await read(c, a, 'message', rid);
        ensure(m.version === b.version && m.state === 'unassigned', 409, 'Wiadomość zmieniła się');
        const o = (
          await c.query('SELECT id,version FROM orders WHERE id=$1 FOR UPDATE', [b.order_id])
        ).rows[0];
        ensure(o, 404, 'Nie znaleziono zamówienia');
        ensure(o.version === b.order_version, 409, 'Zamówienie zmieniło się');
        const cm = await appendInboundCustomerMessageInTx(c, a, b.order_id, {
          client_key: b.client_key,
          body: m.text,
          message_id: rid,
          headers: m.headers,
          account_id: m.account_id,
          raw_sha256: m.raw_sha256,
        });
        r = await store(c, a, op, b, { ...b, id: randomUUID(), core_message_id: cm.message.id });
      }
      const g = await flags(c, a, true, false);
      return {
        message: messageView(await read(c, a, 'message', r!.message_id), g),
        binding: await bindingView(c, a, r!.binding_id),
        ...replayFlags(op),
      };
    },
    false,
    true,
  );
}
async function bindingView(c: PoolClient, a: EmailInboundActor, rid: string) {
  const r = await read(c, a, 'binding', rid);
  return { ...r, order_version: String(r.order_version) };
}
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
async function replyPreviewView(
  c: PoolClient,
  a: EmailInboundActor,
  rid: string,
  g: { can_write: boolean; can_order_read?: boolean },
) {
  const p = await read(c, a, 'reply_preview', rid);
  const reply = (
    await c.query('SELECT email_inbound_reply_reference($1,$2,$3) r', [
      rid,
      a.userId,
      a.apiKeyId ?? null,
    ])
  ).rows[0].r;
  return {
    id: p.id,
    message_id: p.message_id,
    actor_id: p.actor_id,
    api_key_id: p.api_key_id,
    request: p.request,
    scope_hash: p.scope_hash,
    snapshot: p.payload,
    created_at: p.created_at,
    expires_at: p.expires_at,
    can_queue:
      g.can_write &&
      g.can_order_read === true &&
      p.actor_id === a.userId &&
      p.api_key_id === (a.apiKeyId ?? null) &&
      !reply &&
      Date.parse(p.expires_at) > Date.now(),
    queued_reply_id: reply,
  };
}
export async function previewInboundReply(a: EmailInboundActor, rid: string, input: unknown) {
  rid = id(rid);
  const b = V.inboundReplyPreviewInput.parse(input);
  return tx(
    a,
    true,
    async (c) => {
      const op = await begin(c, a, 'reply_preview', rid, b);
      let r = op.result;
      if (!op.reused) {
        const m = await read(c, a, 'message', rid);
        ensure(
          m.state === 'bound' && m.version === b.version,
          409,
          'Wiadomość nie jest świeżo przypisana',
        );
        ensure(
          b.recipient === (m.headers.reply_to ?? m.headers.from).address.toLowerCase(),
          422,
          'Odpowiedź wymaga adresata źródłowego Reply-To/From',
        );
        const o = (
          await c.query('SELECT id,number,version FROM orders WHERE id=$1 FOR SHARE', [m.order_id])
        ).rows[0];
        ensure(o?.version === b.order_version, 409, 'Zamówienie zmieniło się');
        const ch = (
          await c.query('SELECT * FROM channels WHERE id=$1 FOR SHARE', [b.smtp_channel_id])
        ).rows[0];
        ensure(ch?.provider === 'smtp', 422, 'Wymagane własne konto SMTP');
        const settings = smtpSettings.parse(ch.settings);
        ensure(
          settings.delivery !== 'local_sink' || ch.mode === 'sandbox',
          422,
          'Lokalny SMTP wymaga sandbox',
        );
        ensure(
          settings.delivery !== 'local_sink' || b.recipient.endsWith('.test'),
          422,
          'Lokalny SMTP wymaga adresata .test',
        );
        const channelHash = (
          await c.query('SELECT email_inbound_hash($1) h', [
            {
              mode: ch.mode,
              provider: ch.provider,
              credentials: ch.credentials,
              settings: ch.settings,
            },
          ])
        ).rows[0].h;
        const references = [
          ...m.headers.references,
          ...(m.headers.message_id ? [m.headers.message_id] : []),
        ];
        smtpReplyHeaders.parse({ in_reply_to: m.headers.message_id, references });
        const payload = {
          recipient: b.recipient,
          subject: b.subject,
          text: b.text,
          html: '<p>' + escape(b.text).replace(/\n/g, '<br>') + '</p>',
          in_reply_to: m.headers.message_id,
          references,
        };
        const snapshot = {
          message_version: m.version,
          order: { id: o.id, number: o.number, version: o.version },
          smtp_channel_id: ch.id,
          smtp_channel_hash: channelHash,
          sender: {
            email: settings.from_email,
            name: settings.from_name,
            local_sink: settings.delivery === 'local_sink',
          },
          payload,
        };
        r = await store(c, a, op, b, { id: randomUUID(), request: b, snapshot });
      }
      return {
        reply_preview: await replyPreviewView(
          c,
          a,
          r!.reply_preview_id,
          await flags(c, a, true, false),
        ),
        ...replayFlags(op),
      };
    },
    false,
    true,
  );
}
export async function inboundReplyPreview(a: EmailInboundActor, rid: string) {
  return tx(a, false, async (c) => ({
    reply_preview: await replyPreviewView(c, a, id(rid), await flags(c, a, false, false)),
  }));
}
async function replyView(c: PoolClient, a: EmailInboundActor, rid: string) {
  const r = await read(c, a, 'reply', rid);
  const em = (
    await c.query('SELECT state,result,error FROM email_messages WHERE id=$1', [r.email_message_id])
  ).rows[0];
  ensure(em, 503, 'Brak rzeczywistej wiadomości SMTP');
  return {
    ...r,
    snapshot: {
      id: r.snapshot.id,
      message_id: r.snapshot.message_id,
      actor_id: r.snapshot.actor_id,
      api_key_id: r.snapshot.api_key_id,
      request: r.snapshot.request,
      scope_hash: r.snapshot.scope_hash,
      snapshot: r.snapshot.payload,
      created_at: r.snapshot.created_at,
      expires_at: r.snapshot.expires_at,
    },
    state: em.state,
    delivered: false,
    result: em.result,
    error: em.error,
  };
}
export async function queueInboundReply(a: EmailInboundActor, rid: string, input: unknown) {
  rid = id(rid);
  const b = V.inboundReplyQueueInput.parse(input);
  return tx(
    a,
    true,
    async (c) => {
      const op = await begin(c, a, 'reply_queue', rid, b);
      let r = op.result;
      if (!op.reused) {
        const p = await read(c, a, 'reply_preview', rid);
        if (!p.payload.sender.local_sink)
          ensure(
            process.env.DYNA_ALLOW_EXTERNAL_EMAIL === 'true',
            423,
            'Zewnętrzny email wymaga autoryzacji operatora',
          );
        r = await store(c, a, op, b, {
          ...b,
          id: randomUUID(),
          batch_id: randomUUID(),
          email_message_id: randomUUID(),
          job_id: randomUUID(),
        });
      }
      return { reply: await replyView(c, a, r!.reply_id), ...replayFlags(op) };
    },
    false,
    true,
  );
}
export async function inboundReply(a: EmailInboundActor, rid: string) {
  return tx(a, false, async (c) => ({ reply: await replyView(c, a, id(rid)) }));
}
export async function inboundReplies(a: EmailInboundActor, input: unknown) {
  const q = V.inboundRepliesInput.parse(input);
  return tx(a, false, async (c) => {
    const r = await read(c, a, 'replies', null, q);
    return { ...r, data: await Promise.all(r.data.map((v: Row) => replyView(c, a, v.id))) };
  });
}
export async function inboundAttachmentContent(a: EmailInboundActor, rid: string, index: number) {
  return tx(a, false, async (c) => {
    ensure(Number.isInteger(index) && index >= 0 && index < 10, 404, 'Nie znaleziono załącznika');
    const m = await read(c, a, 'message', id(rid));
    const source = await read(c, a, 'source_content', m.source_id);
    const decoded = decrypt(source.content_encrypted) as Row;
    const f = decoded.attachments[index],
      meta = source.attachments[index];
    ensure(f && meta && f.index === index, 404, 'Nie znaleziono załącznika');
    const bytes = Buffer.from(f.content_base64, 'base64');
    ensure(
      bytes.toString('base64') === f.content_base64 &&
        bytes.length === meta.bytes &&
        createHash('sha256').update(bytes).digest('hex') === meta.sha256 &&
        f.filename === meta.filename &&
        f.mime === meta.mime,
      503,
      'Załącznik nie zgadza się z niezmiennym źródłem',
    );
    return { message_id: m.id, ...meta, content_base64: f.content_base64 };
  });
}
