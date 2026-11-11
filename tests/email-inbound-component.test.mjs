import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

// Real mounted workspace with controlled HTTP, not an IMAP/SMTP, SQL or native proof.
const id = (n) => `${n.toString(16).padStart(8, '0')}-1560-4156-8156-156156156156`;
const tenant = id(1),
  user = id(2),
  context = `${tenant}:${user}:admin:false`;
const hash = 'a'.repeat(64),
  clone = (v) => structuredClone(v);
const flags = {
  available: true,
  read_only: false,
  current_role: 'admin',
  can_read: true,
  can_write: true,
  can_manage_accounts: true,
};
const headers = (i) => ({
  message_id: `<message-${i}@fixture.test>`,
  from: { name: 'Real sender', address: 'sender@fixture.test' },
  reply_to: { name: 'Reply desk', address: 'reply@fixture.test' },
  to: [{ name: 'Own inbox', address: 'inbox@fixture.test' }],
  subject: `Subject ${i}`,
  sent_at: '2026-10-06T12:00:00Z',
  in_reply_to: null,
  references: [],
});
function fixture(count = 1) {
  const f = {
    flags: clone(flags),
    writes: [],
    reads: [],
    receipts: new Map(),
    malformed: null,
    lost: false,
    order: {
      id: id(400),
      number: 'ORDER-156',
      version: '3',
      customer_name: 'Own buyer',
      email: 'wrong-order-address@fixture.invalid',
    },
  };
  f.account = {
    id: id(10),
    name: 'Own IMAP',
    host: 'imap.fixture.invalid',
    port: 993,
    transport: 'tls',
    folder: 'INBOX',
    smtp_channel_id: id(11),
    enabled: true,
    version: '1',
    has_credentials: true,
    username_masked: 'i***',
    uidvalidity: '7',
    last_uid: null,
    created_at: '2026-10-06T12:00:00Z',
    updated_at: '2026-10-06T12:00:00Z',
  };
  f.rows = Array.from({ length: count }, (_, i) => ({
    index: i,
    source_id: id(100 + i),
    uid: String(i + 1),
    raw_sha256: hash,
    raw_bytes: 100,
    headers: headers(i),
    text: i === 0 ? 'Full incoming text '.repeat(300) : `Text ${i}`,
    attachments: [],
    duplicate: false,
    message_id: null,
  }));
  f.preview = {
    id: id(200),
    acquisition_id: id(201),
    account_id: f.account.id,
    account_version: '1',
    client_key: id(202),
    scope_hash: hash,
    uidvalidity: '7',
    uidnext: String(count + 1),
    after_uid: null,
    rows: clone(f.rows),
    summary: {
      rows: count,
      new: count,
      duplicates: 0,
      raw_bytes: count * 100,
      attachment_bytes: 0,
    },
    created_at: '2026-10-06T12:00:00Z',
    expires_at: new Date(Date.now() + 900000).toISOString(),
    can_import: true,
    import_operation_id: null,
  };
  f.acquisition = {
    id: id(201),
    account_id: f.account.id,
    actor_id: user,
    api_key_id: null,
    client_key: id(202),
    account_version: '1',
    folder: 'INBOX',
    state: 'ready',
    preview_id: f.preview.id,
    uidvalidity: '7',
    uidnext: String(count + 1),
    created_at: '2026-10-06T12:00:00Z',
    updated_at: '2026-10-06T12:00:00Z',
    error_code: null,
    can_reconcile: false,
  };
  f.message = {
    id: id(300),
    source_id: f.rows[0].source_id,
    account_id: f.account.id,
    version: '1',
    state: 'unassigned',
    uid: '1',
    uidvalidity: '7',
    headers: headers(0),
    text: f.rows[0].text,
    attachments: [],
    raw_sha256: hash,
    raw_bytes: 100,
    order_id: null,
    thread_id: null,
    core_message_id: null,
    binding_id: null,
    created_at: '2026-10-06T12:00:00Z',
    can_bind: true,
    can_reply: false,
  };
  f.options = () => ({
    ...f.flags,
    limits: {},
    accounts: [clone(f.account), ...clone(f.extraAccounts ?? [])],
    smtp_channels: [
      { id: id(11), name: 'Own local SMTP', delivery: 'local_sink', mode: 'sandbox' },
    ],
  });
  f.fetch = async (url, options = {}) => {
    assert.equal(options.headers['X-Workspace-ID'], tenant);
    const u = new URL(url, 'http://127.0.0.1'),
      p = u.pathname,
      method = options.method;
    if (method === 'GET') {
      f.reads.push(url);
      if (p === '/api/auth/me')
        return Response.json({ user: { tenant_id: tenant, id: user, role: f.flags.current_role } });
      if (p === '/api/email-inbound/options') return Response.json(f.options());
      if (p === '/api/orders')
        return Response.json({ data: [clone(f.order)], meta: { cursor: null } });
      if (p === `/api/orders/${f.order.id}`) return Response.json(clone(f.order));
      if (p === '/api/email-inbound/messages')
        return Response.json({
          ...f.flags,
          data: [
            {
              ...clone(f.message),
              text: undefined,
              attachments: undefined,
              attachment_count: f.message.attachments.length,
            },
          ],
          next_cursor: null,
        });
      if (p === `/api/email-inbound/messages/${f.message.id}`)
        return Response.json({ ...f.flags, message: clone(f.message) });
      if (p.startsWith(`/api/email-inbound/messages/${f.message.id}/attachments/`)) {
        assert.equal(u.searchParams.get('workspace_id'), tenant);
        const index = Number(p.split('/').at(-2));
        assert.ok(f.contents?.[index]);
        const meta = f.message.attachments[index];
        return Response.json({
          ...f.flags,
          message_id: f.message.id,
          ...meta,
          sha256: f.badAttachment ? 'b'.repeat(64) : meta.sha256,
          content_base64: Buffer.from(f.contents[index]).toString('base64'),
        });
      }
      if (p === '/api/email-inbound/acquisitions')
        return Response.json({ ...f.flags, data: [clone(f.acquisition)], next_cursor: null });
      if (p === `/api/email-inbound/acquisitions/${f.acquisition.id}`)
        return Response.json({
          ...f.flags,
          acquisition: clone(f.acquisition),
          preview: clone(f.preview),
        });
      if (p === `/api/email-inbound/imports/${f.preview.import_operation_id}`) {
        const r = [...f.receipts.values()].find(
          (v) => v.import?.id === f.preview.import_operation_id,
        );
        assert.ok(r);
        return Response.json({ ...clone(r), ...f.flags });
      }
      if (p === '/api/email-inbound/replies')
        return Response.json({
          ...f.flags,
          data: f.reply ? [clone(f.reply)] : [],
          next_cursor: null,
        });
      if (f.reply && p === `/api/email-inbound/replies/${f.reply.id}`)
        return Response.json({ ...f.flags, reply: { ...clone(f.reply), state: 'smtp_accepted' } });
      throw Error('Unexpected read ' + url);
    }
    const b = JSON.parse(options.body);
    f.writes.push({ path: p, method, body: options.body, parsed: b });
    let result = f.receipts.get(b.client_key);
    if (result) result = { ...clone(result), reused: true };
    else {
      if (p === '/api/email-inbound/accounts') {
        assert.equal(method, 'POST');
        const { credentials, client_key, ...fields } = b;
        assert.ok(credentials.password);
        f.account = { ...f.account, ...fields };
        result = { account: clone(f.account) };
      } else if (p === `/api/email-inbound/accounts/${f.account.id}/previews`) {
        f.acquisition.client_key = b.client_key;
        f.preview.client_key = b.client_key;
        result = { acquisition: clone(f.acquisition), preview: clone(f.preview) };
      } else if (p === `/api/email-inbound/previews/${f.preview.id}/import`) {
        f.preview.import_operation_id = id(600 + f.receipts.size);
        result = {
          preview: clone(f.preview),
          import: {
            id: f.preview.import_operation_id,
            preview_id: f.preview.id,
            message_ids: f.rows.map((_, i) => id(300 + i)),
            new_count: f.rows.length,
            duplicate_count: 0,
          },
        };
      } else if (p === `/api/email-inbound/messages/${f.message.id}/bind`) {
        f.message = {
          ...f.message,
          state: 'bound',
          version: '2',
          order_id: f.order.id,
          thread_id: id(401),
          core_message_id: id(402),
          binding_id: id(403),
          can_bind: false,
          can_reply: true,
        };
        result = {
          message: clone(f.message),
          binding: {
            id: id(403),
            message_id: f.message.id,
            order_id: f.order.id,
            order_version: '3',
            thread_id: id(401),
            core_message_id: id(402),
            created_at: '2026-10-06T12:00:00Z',
          },
        };
      } else if (p === `/api/email-inbound/messages/${f.message.id}/reply-previews`) {
        assert.equal(b.recipient, 'reply@fixture.test', 'Actual Reply-To, not order email');
        f.replyPreview = {
          id: id(500),
          message_id: f.message.id,
          actor_id: user,
          api_key_id: null,
          request: clone(b),
          scope_hash: hash,
          snapshot: {
            message_version: b.version,
            order: { id: f.order.id, number: f.order.number, version: b.order_version },
            smtp_channel_id: b.smtp_channel_id,
            smtp_channel_hash: hash,
            sender: { email: 'staff@fixture.invalid', name: 'Own staff', local_sink: true },
            payload: {
              recipient: b.recipient,
              subject: b.subject,
              text: b.text,
              html: '<p>never rendered</p>',
              in_reply_to: f.message.headers.message_id,
              references: [f.message.headers.message_id],
            },
          },
          created_at: '2026-10-06T12:00:00Z',
          expires_at: new Date(Date.now() + 900000).toISOString(),
          can_queue: true,
          queued_reply_id: null,
        };
        result = { reply_preview: clone(f.replyPreview) };
      } else if (p === `/api/email-inbound/reply-previews/${id(500)}/queue`) {
        const frozen = clone(f.replyPreview);
        delete frozen.can_queue;
        delete frozen.queued_reply_id;
        f.reply = {
          id: id(501),
          preview_id: id(500),
          message_id: f.message.id,
          batch_id: id(502),
          email_message_id: id(503),
          job_id: id(504),
          state: 'queued',
          delivered: false,
          snapshot: frozen,
          created_at: '2026-10-06T12:00:00Z',
          result: null,
          error: null,
        };
        result = { reply: clone(f.reply) };
      } else throw Error('Unexpected write ' + p);
      result = { ...f.flags, ...result, operation_id: id(600 + f.receipts.size), reused: false };
      f.receipts.set(b.client_key, clone(result));
    }
    if (f.lost) throw TypeError('Controlled lost response');
    if (f.malformed === p) {
      result = clone(result);
      delete result.operation_id;
    }
    return Response.json(result, { status: 201 });
  };
  return f;
}
async function tick() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
async function until(fn, message) {
  for (let i = 0; i < 100; i++) {
    if (fn()) return;
    await tick();
  }
  assert.ok(fn(), message);
}
function button(h, text) {
  const el = [...h.container.querySelectorAll('button')].find((el) => el.textContent === text);
  assert.ok(el, text);
  return el;
}
function field(h, text) {
  const el = [...h.container.querySelectorAll('label')]
    .find((el) => el.firstChild?.textContent === text)
    ?.querySelector('input,select,textarea');
  assert.ok(el, text);
  return el;
}
function check(h, text) {
  const el = [...h.container.querySelectorAll('label')]
    .find((el) => el.textContent.startsWith(text))
    ?.querySelector('input[type=checkbox]');
  assert.ok(el, text);
  return el;
}
async function click(el) {
  assert.equal(el.disabled, false, el.textContent);
  assert.equal(el.closest('fieldset')?.disabled ?? false, false);
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}
async function value(el, v) {
  const prototype =
    el.tagName === 'SELECT'
      ? window.HTMLSelectElement.prototype
      : el.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  });
}

test('inbound email real workspace', async (t) => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1/' }),
    saved = new Map(),
    originalFetch = globalThis.fetch;
  for (const [key, v] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    MouseEvent: dom.window.MouseEvent,
    Event: dom.window.Event,
    crypto: webcrypto,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: v });
  }
  const vite = await createServer({
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom',
    logLevel: 'error',
  });
  const { createRoot } = await import('react-dom/client'),
    ui = await vite.ssrLoadModule(path.resolve('web/email-inbound.tsx')),
    api = await vite.ssrLoadModule(path.resolve('web/api.ts'));
  const mounts = [];
  function reset() {
    api.setWorkspace(tenant);
    ui.resetEmailInboundContext('');
    ui.resetEmailInboundContext(context);
  }
  function mount(extra = {}) {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const h = {
      container,
      props: { contextKey: context, readOnly: false, ...extra },
      async render(patch = {}) {
        h.props = { ...h.props, ...patch };
        await act(async () => root.render(React.createElement(ui.EmailInboundWorkspace, h.props)));
      },
      async close() {
        await act(async () => root.unmount());
        container.remove();
      },
    };
    mounts.push(h);
    return h;
  }
  async function initial(h) {
    await h.render();
    await until(
      () =>
        h.container.textContent.includes('Odczyt wiadomości przed importem') &&
        !button(h, 'Odczytaj dostęp i konta skrzynki').disabled,
      'Fresh account access',
    );
  }
  async function fetchPreview(h, f) {
    await value(field(h, 'Konto odbioru'), f.account.id);
    await click(check(h, 'Potwierdzam odczyt wskazanej skrzynki'));
    await click(button(h, 'Przygotuj podgląd odbioru IMAP'));
    await until(
      () =>
        h.container.textContent.includes('Pełny zapisany podgląd odbioru') &&
        !button(h, 'Odczytaj dostęp i konta skrzynki').disabled,
      'Frozen IMAP preview',
    );
  }
  async function openMessage(h, f) {
    await click(button(h, 'Do powiązania'));
    await until(
      () =>
        h.container.textContent.includes('Otwórz wiadomość Subject 0') &&
        !button(h, 'Do powiązania').disabled,
      'Inbox read',
    );
    await click(button(h, 'Otwórz wiadomość Subject 0'));
    await until(
      () =>
        h.container.textContent.includes('Wiadomość nie jest powiązana') &&
        !button(h, 'Odczytaj dostęp i konta skrzynki').disabled,
      'Full message read',
    );
  }
  try {
    await t.test(
      'explicit IMAP read and all eleven messages reviewed before separate full import',
      async () => {
        reset();
        const f = fixture(11);
        globalThis.fetch = f.fetch;
        const h = mount();
        await initial(h);
        assert.equal(f.writes.length, 0);
        await fetchPreview(h, f);
        assert.equal(f.writes.length, 1);
        assert.equal(f.writes[0].parsed.confirmed_read, true);
        assert.equal(f.writes[0].parsed.expected_uidvalidity, '7');
        assert.equal(check(h, 'Sprawdziłem wszystkie wiadomości').disabled, true);
        assert.equal(button(h, 'Importuj wiadomości').disabled, true);
        assert.ok(
          h.container.textContent.includes(f.rows[0].text),
          'Full >4k safe text is visible',
        );
        assert.equal(h.container.querySelector('iframe'), null);
        await click(button(h, 'Następna strona podglądu'));
        assert.ok(h.container.textContent.includes('11. Subject 10'));
        assert.equal(f.writes.length, 1, 'Paging never imports');
        await click(check(h, 'Sprawdziłem wszystkie wiadomości'));
        await click(button(h, 'Importuj wiadomości'));
        await until(
          () => h.container.textContent.includes('Zapis importu: nowe 11'),
          'Atomic full import receipt',
        );
        assert.equal(f.writes.length, 2);
        assert.equal(f.writes[1].parsed.scope_hash, hash);
        assert.equal(f.writes[1].parsed.confirmed, true);
        await click(button(h, 'Odczytaj zapis importu'));
        await until(
          () =>
            f.reads.includes('/api/email-inbound/imports/' + f.preview.import_operation_id) &&
            !button(h, 'Odczytaj dostęp i konta skrzynki').disabled,
          'Immutable import receipt read',
        );
        assert.equal(f.writes.length, 2);
        await h.close();
      },
    );
    await t.test(
      'unassigned email searched by order number, explicitly bound and replied to actual Reply-To with independent SMTP consent',
      async () => {
        reset();
        const f = fixture(),
          opened = [];
        globalThis.fetch = f.fetch;
        const h = mount({ onOpenThread: (...args) => opened.push(args) });
        await initial(h);
        await openMessage(h, f);
        await value(field(h, 'Numer zamówienia lub klient'), 'ORDER-156');
        const searchForm = field(h, 'Numer zamówienia lub klient').closest('form');
        await act(async () =>
          searchForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
        );
        await until(
          () =>
            h.container.textContent.includes('ORDER-156 — Own buyer') &&
            !button(h, 'Odczytaj dostęp i konta skrzynki').disabled,
          'Own order search',
        );
        assert.ok(f.reads.some((p) => p.includes('search=ORDER-156')));
        await value(field(h, 'Własne zamówienie'), f.order.id);
        await until(
          () => !check(h, 'Sprawdziłem wiadomość i zamówienie').disabled,
          'Actual order detail/CAS selected',
        );
        assert.equal(button(h, 'Powiąż z zamówieniem').disabled, true);
        await click(check(h, 'Sprawdziłem wiadomość i zamówienie'));
        await click(button(h, 'Powiąż z zamówieniem'));
        await until(
          () =>
            h.container.textContent.includes('Odpowiedź email') &&
            !button(h, 'Odczytaj dostęp i konta skrzynki').disabled,
          'Email bound',
        );
        assert.equal(f.writes[0].parsed.order_version, '3');
        await click(button(h, 'Otwórz wątek zamówienia'));
        assert.deepEqual(opened[0], [f.order.id, id(401)]);
        await value(field(h, 'Treść odpowiedzi email'), 'Own plain text answer');
        await click(button(h, 'Przygotuj podgląd odpowiedzi email'));
        await until(
          () => h.container.textContent.includes('Pełny zapisany podgląd odpowiedzi SMTP'),
          'SMTP preview',
        );
        assert.equal(f.writes.length, 2);
        assert.equal(button(h, 'Dodaj odpowiedź do kolejki SMTP').disabled, true);
        assert.equal(h.container.querySelector('iframe'), null);
        assert.ok(!h.container.textContent.includes('never rendered'));
        await until(
          () => !check(h, 'Sprawdziłem nadawcę, odbiorcę').disabled,
          'Reply consent available',
        );
        await click(check(h, 'Sprawdziłem nadawcę, odbiorcę'));
        await click(button(h, 'Dodaj odpowiedź do kolejki SMTP'));
        await until(
          () => h.container.textContent.includes('Odpowiedź ma trwały wynik kolejki'),
          'Immutable reply receipt without current preview capabilities',
        );
        assert.equal(f.writes.length, 3);
        assert.ok(f.writes.every((w) => w.path.startsWith('/api/email-inbound/')));
        assert.equal(f.writes[2].parsed.confirm_external, false);
        assert.ok(!h.container.textContent.includes('Wynik operacji „Dodanie'));
        await click(button(h, 'Odczytaj wynik odpowiedzi SMTP'));
        await until(
          () =>
            h.container.textContent.includes('Przyjęta przez SMTP — doręczenie niepotwierdzone'),
          'Actual SMTP result separate from delivery',
        );
        await h.close();
      },
    );
    await t.test(
      'malformed import 2xx keeps exact request and actor lock through unmount and immutable history GET',
      async () => {
        reset();
        const f = fixture(),
          locks = [];
        f.malformed = `/api/email-inbound/previews/${f.preview.id}/import`;
        globalThis.fetch = f.fetch;
        const h = mount({ onLockedChange: (v) => locks.push(v) });
        await initial(h);
        await fetchPreview(h, f);
        await click(check(h, 'Sprawdziłem wszystkie wiadomości'));
        await click(button(h, 'Importuj wiadomości'));
        await until(
          () =>
            h.container.textContent.includes('Wynik operacji „Import') &&
            !button(h, 'Ponów dokładną próbę skrzynki').disabled,
          'Malformed success kept unknown',
        );
        const exact = clone(f.writes.at(-1));
        assert.equal(locks.at(-1), true);
        await h.close();
        const resumed = mount({ onLockedChange: (v) => locks.push(v) });
        await initial(resumed);
        await click(button(resumed, 'Odczytaj historię pobrań'));
        await until(
          () => resumed.container.textContent.includes('Otwórz odczyt z'),
          'History readable',
        );
        assert.equal(locks.at(-1), true);
        assert.ok(resumed.container.textContent.includes('Wynik operacji „Import'));
        f.malformed = null;
        await click(button(resumed, 'Ponów dokładną próbę skrzynki'));
        await until(
          () =>
            resumed.container.textContent.includes('Zapis importu: nowe 1') &&
            locks.at(-1) === false,
          'Exact replay confirmed',
        );
        assert.equal(f.writes.at(-1).body, exact.body);
        assert.equal(f.writes.at(-1).path, exact.path);
        assert.equal(f.receipts.size, 2, 'Only read+import durable operations');
        await resumed.close();
      },
    );
    await t.test(
      'account credentials are write-only and lost ACK retries identical body without creating another account',
      async () => {
        reset();
        const f = fixture();
        f.lost = true;
        globalThis.fetch = f.fetch;
        const h = mount();
        await initial(h);
        await click(button(h, 'Dodaj konto IMAP'));
        await value(field(h, 'Nazwa konta'), 'New own inbox');
        await value(field(h, 'Host serwera IMAP'), 'imap.fixture.invalid');
        await value(field(h, 'Konto odpowiedzi SMTP'), id(11));
        await value(field(h, 'Login IMAP'), 'private-login@fixture.invalid');
        await value(field(h, 'Hasło IMAP'), 'PRIVATE-ONE-TIME');
        assert.equal(field(h, 'Hasło IMAP').type, 'password');
        const form = field(h, 'Nazwa konta').closest('form');
        await act(async () =>
          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
        );
        await until(
          () =>
            h.container.textContent.includes('Wynik operacji „Zapis konta') &&
            !button(h, 'Ponów dokładną próbę skrzynki').disabled,
          'Lost account ACK retained',
        );
        const exact = clone(f.writes[0]);
        assert.ok(!h.container.textContent.includes('PRIVATE-ONE-TIME'));
        await h.close();
        const resumed = mount();
        await initial(resumed);
        assert.equal(
          resumed.container.querySelector('input[type=password]'),
          null,
          'Draft secrets are not resurrected',
        );
        f.lost = false;
        await click(button(resumed, 'Ponów dokładną próbę skrzynki'));
        await until(
          () => !resumed.container.textContent.includes('Wynik operacji „Zapis konta'),
          'Account replay confirmed',
        );
        assert.deepEqual(f.writes[1], exact);
        assert.equal(f.receipts.size, 1);
        assert.ok(!resumed.container.textContent.includes('private-login@fixture.invalid'));
        await resumed.close();
      },
    );
    await t.test(
      '408 then 429 retain the same committed import attempt and lock until explicit exact replay confirms it',
      async () => {
        reset();
        const f = fixture(),
          locks = [];
        let status = 408;
        globalThis.fetch = async (url, options) => {
          const reply = await f.fetch(url, options);
          if (options.method === 'POST' && url.endsWith('/import') && status !== null)
            return Response.json(
              {
                detail:
                  status === 408 ? 'Controlled timeout response' : 'Controlled rate limit response',
              },
              { status },
            );
          return reply;
        };
        const h = mount({ onLockedChange: (v) => locks.push(v) });
        await initial(h);
        await fetchPreview(h, f);
        await click(check(h, 'Sprawdziłem wszystkie wiadomości'));
        await click(button(h, 'Importuj wiadomości'));
        await until(
          () =>
            h.container.textContent.includes('Controlled timeout response') &&
            !button(h, 'Ponów dokładną próbę skrzynki').disabled,
          'Timeout keeps exact attempt',
        );
        const exact = clone(f.writes.at(-1));
        assert.equal(locks.at(-1), true);
        assert.equal(button(h, 'Importuj wiadomości').disabled, true);
        status = 429;
        await click(button(h, 'Ponów dokładną próbę skrzynki'));
        await until(
          () =>
            h.container.textContent.includes('Controlled rate limit response') &&
            !button(h, 'Ponów dokładną próbę skrzynki').disabled,
          'Rate limit also preserves exact attempt',
        );
        assert.equal(locks.at(-1), true);
        assert.deepEqual(f.writes.at(-1), exact);
        status = null;
        await click(button(h, 'Ponów dokładną próbę skrzynki'));
        await until(
          () => h.container.textContent.includes('Zapis importu: nowe 1') && locks.at(-1) === false,
          'Only validated exact replay releases lock',
        );
        assert.deepEqual(f.writes.at(-1), exact);
        assert.equal(
          f.receipts.size,
          2,
          'Single acquisition and single import, regardless of ambiguous HTTP responses',
        );
        await h.close();
      },
    );
    await t.test(
      'restore is read-only; ACL withdrawal before exact retry purges sensitive data and never sends retained write',
      async () => {
        reset();
        const f = fixture();
        globalThis.fetch = f.fetch;
        const h = mount({ contextKey: `${tenant}:${user}:admin:true`, readOnly: true });
        await initial(h);
        assert.equal(button(h, 'Dodaj konto IMAP').disabled, true);
        assert.equal(f.writes.length, 0);
        await h.close();
        reset();
        f.lost = true;
        const writable = mount();
        await initial(writable);
        await fetchPreviewUnknown(writable, f);
        const count = f.writes.length;
        f.flags.current_role = 'viewer';
        f.flags.can_write = false;
        f.flags.can_manage_accounts = false;
        await click(button(writable, 'Ponów dokładną próbę skrzynki'));
        await until(
          () =>
            writable.container.textContent.includes('Zmienił się użytkownik') ||
            writable.container.textContent.includes('Zmieniła się rola'),
          'Current ACL purged workspace',
        );
        assert.equal(f.writes.length, count);
        assert.ok(!writable.container.textContent.includes(f.rows[0].text));
        assert.ok(!writable.container.textContent.includes('Wynik operacji'));
        await writable.close();
      },
    );
    await t.test(
      'late old-actor mailbox response cannot publish after context replacement',
      async () => {
        reset();
        const f = fixture();
        let resolve,
          held = false;
        const hold = new Promise((r) => {
          resolve = r;
        });
        globalThis.fetch = async (url, o) => {
          if (url === '/api/email-inbound/options' && !held) {
            held = true;
            await hold;
            return Response.json(f.options());
          }
          const target = o.headers['X-Workspace-ID'];
          if (target !== tenant) {
            if (url === '/api/auth/me')
              return Response.json({ user: { tenant_id: target, id: id(902), role: 'admin' } });
            if (url === '/api/email-inbound/options')
              return Response.json({ ...flags, accounts: [], smtp_channels: [], limits: {} });
          }
          return f.fetch(url, o);
        };
        const h = mount();
        await h.render();
        await until(() => held, 'Old options held');
        const nextContext = `${id(901)}:${id(902)}:admin:false`;
        api.setWorkspace(id(901));
        await h.render({ contextKey: nextContext });
        await until(
          () => !button(h, 'Odczytaj dostęp i konta skrzynki').disabled,
          'New actor completed own read',
        );
        await act(async () => {
          resolve();
          await new Promise((r) => setTimeout(r, 0));
        });
        await tick();
        assert.ok(!h.container.textContent.includes('Own IMAP'));
        assert.equal(f.writes.length, 0);
        await h.close();
      },
    );
    await t.test(
      'UIDVALIDITY conflict never silently resets namespace; new explicit consent reads from beginning with a new key',
      async () => {
        reset();
        const f = fixture();
        f.account.last_uid = '9';
        let rejected = false;
        globalThis.fetch = async (url, o) => {
          if (o.method === 'POST' && url.endsWith('/previews') && !rejected) {
            rejected = true;
            const b = JSON.parse(o.body);
            f.writes.push({
              path: new URL(url, 'http://127.0.0.1').pathname,
              method: o.method,
              body: o.body,
              parsed: b,
            });
            return Response.json(
              { detail: 'Zmieniła się przestrzeń UID skrzynki' },
              { status: 409 },
            );
          }
          return f.fetch(url, o);
        };
        const h = mount();
        await initial(h);
        await value(field(h, 'Konto odbioru'), f.account.id);
        await click(check(h, 'Potwierdzam odczyt wskazanej skrzynki'));
        await click(button(h, 'Przygotuj podgląd odbioru IMAP'));
        await until(
          () =>
            h.container.textContent.includes('Zmieniła się przestrzeń UID') &&
            !button(h, 'Odczytaj dostęp i konta skrzynki').disabled,
          'Known conflict',
        );
        assert.equal(f.writes.length, 1);
        assert.equal(f.writes[0].parsed.after_uid, '9');
        assert.equal(f.writes[0].parsed.expected_uidvalidity, '7');
        assert.equal(check(h, 'Odczytaj nową przestrzeń UID').checked, false);
        assert.equal(button(h, 'Przygotuj podgląd odbioru IMAP').disabled, true);
        f.preview.uidvalidity = '8';
        f.acquisition.uidvalidity = '8';
        await click(check(h, 'Odczytaj nową przestrzeń UID'));
        assert.equal(
          button(h, 'Przygotuj podgląd odbioru IMAP').disabled,
          true,
          'Separate read consent still required',
        );
        await click(check(h, 'Potwierdzam odczyt wskazanej skrzynki'));
        await click(button(h, 'Przygotuj podgląd odbioru IMAP'));
        await until(
          () => h.container.textContent.includes('Pełny zapisany podgląd odbioru'),
          'Explicit new namespace preview',
        );
        assert.equal(f.writes.length, 2);
        assert.equal(f.writes[1].parsed.after_uid, null);
        assert.equal(f.writes[1].parsed.expected_uidvalidity, null);
        assert.notEqual(f.writes[1].parsed.client_key, f.writes[0].parsed.client_key);
        assert.equal(f.preview.import_operation_id, null);
        await h.close();
      },
    );
    await t.test(
      'explicit account change removes previous source, binding and reply drafts without issuing a write',
      async () => {
        reset();
        const f = fixture();
        f.extraAccounts = [
          {
            ...clone(f.account),
            id: id(15),
            name: 'Second own IMAP',
            uidvalidity: '8',
            last_uid: '4',
          },
        ];
        globalThis.fetch = f.fetch;
        const h = mount();
        await initial(h);
        await value(field(h, 'Konto odbioru'), f.account.id);
        await openMessage(h, f);
        await value(field(h, 'Numer zamówienia lub klient'), 'ORDER-156');
        const form = field(h, 'Numer zamówienia lub klient').closest('form');
        await act(async () =>
          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
        );
        await until(
          () =>
            h.container.textContent.includes('ORDER-156 — Own buyer') &&
            !button(h, 'Odczytaj dostęp i konta skrzynki').disabled,
          'Binding choices loaded',
        );
        await value(field(h, 'Własne zamówienie'), f.order.id);
        await until(
          () => !check(h, 'Sprawdziłem wiadomość i zamówienie').disabled,
          'Binding draft ready',
        );
        await click(check(h, 'Sprawdziłem wiadomość i zamówienie'));
        await value(field(h, 'Konto odbioru'), id(15));
        assert.ok(!h.container.textContent.includes(f.message.text));
        assert.ok(!h.container.textContent.includes('Powiąż z zamówieniem'));
        assert.ok(!h.container.textContent.includes('Otwórz wiadomość Subject 0'));
        assert.equal(field(h, 'Odczyt po UID — puste od początku').value, '4');
        assert.equal(f.writes.length, 0, 'Account selection never binds or fetches');
        f.message = {
          ...f.message,
          state: 'bound',
          version: '2',
          order_id: f.order.id,
          thread_id: id(401),
          core_message_id: id(402),
          binding_id: id(403),
          can_bind: false,
          can_reply: true,
        };
        await h.render({ messageId: f.message.id, focusToken: 1 });
        await until(
          () =>
            h.container.textContent.includes('Odpowiedź email') &&
            !button(h, 'Odczytaj dostęp i konta skrzynki').disabled,
          'Explicit staff message opened',
        );
        await value(field(h, 'Treść odpowiedzi email'), 'Draft from the previous account');
        await click(button(h, 'Przygotuj podgląd odpowiedzi email'));
        await until(
          () =>
            h.container.textContent.includes('Pełny zapisany podgląd odpowiedzi SMTP') &&
            !button(h, 'Odczytaj dostęp i konta skrzynki').disabled,
          'Reply preview ready',
        );
        const writes = f.writes.length;
        await value(field(h, 'Konto odbioru'), f.account.id);
        assert.ok(!h.container.textContent.includes('Draft from the previous account'));
        assert.ok(!h.container.textContent.includes('Pełny zapisany podgląd odpowiedzi SMTP'));
        assert.equal(f.writes.length, writes, 'Source change never queues the old reply');
        await h.close();
      },
    );
    await t.test(
      'attachment-only email keeps separate duplicate filename indexes and verifies authenticated own bytes before download',
      async () => {
        reset();
        const f = fixture();
        f.message.text = '';
        f.contents = [
          new TextEncoder().encode('Own first attachment'),
          new TextEncoder().encode('Own second attachment'),
        ];
        f.message.attachments = await Promise.all(
          f.contents.map(async (bytes, index) => ({
            index,
            filename: 'same-name.txt',
            mime: 'text/plain',
            bytes: bytes.length,
            sha256: [...new Uint8Array(await webcrypto.subtle.digest('SHA-256', bytes))]
              .map((v) => v.toString(16).padStart(2, '0'))
              .join(''),
          })),
        );
        const savedClick = window.HTMLAnchorElement.prototype.click,
          downloads = [];
        window.HTMLAnchorElement.prototype.click = function () {
          downloads.push(this.download);
        };
        try {
          globalThis.fetch = f.fetch;
          const h = mount();
          await initial(h);
          await openMessage(h, f);
          assert.ok(h.container.textContent.includes('(Brak treści tekstowej)'));
          await click(button(h, 'Pobierz zapisany załącznik 1: same-name.txt'));
          await until(
            () => downloads.length === 1 && !button(h, 'Odczytaj dostęp i konta skrzynki').disabled,
            'First exact attachment bytes',
          );
          await click(button(h, 'Pobierz zapisany załącznik 2: same-name.txt'));
          await until(
            () => downloads.length === 2 && !button(h, 'Odczytaj dostęp i konta skrzynki').disabled,
            'Second indexed attachment',
          );
          assert.ok(
            f.reads.some((p) => p.includes('/attachments/0/content?workspace_id=' + tenant)),
          );
          assert.ok(
            f.reads.some((p) => p.includes('/attachments/1/content?workspace_id=' + tenant)),
          );
          assert.equal(f.writes.length, 0);
          f.badAttachment = true;
          await click(button(h, 'Pobierz zapisany załącznik 2: same-name.txt'));
          await until(
            () => h.container.textContent.includes('Załącznik nie odpowiada zapisanej wiadomości'),
            'Mismatched bytes denied before download',
          );
          assert.equal(downloads.length, 2);
          await h.close();
        } finally {
          window.HTMLAnchorElement.prototype.click = savedClick;
        }
      },
    );
  } finally {
    for (const h of mounts) if (h.container.isConnected) await h.close();
    ui.resetEmailInboundContext('');
    globalThis.fetch = originalFetch;
    await vite.close();
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
  async function fetchPreviewUnknown(h, f) {
    await value(field(h, 'Konto odbioru'), f.account.id);
    await click(check(h, 'Potwierdzam odczyt wskazanej skrzynki'));
    await click(button(h, 'Przygotuj podgląd odbioru IMAP'));
    await until(
      () =>
        h.container.textContent.includes('Wynik operacji') &&
        !button(h, 'Ponów dokładną próbę skrzynki').disabled,
      'Unknown read retained',
    );
  }
});
