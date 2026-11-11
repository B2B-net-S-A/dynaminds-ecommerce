import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { browserScript166, type mountBuyerAddressPortal166 } from '../server/buyer-address-portal';
import { portalHtml } from '../server/portal-view';
// The installed JSdom has no bundled declarations. Keep this typed test-only
// CommonJS boundary limited to the constructor and native DOM surface we use.
type TestWindow = Window & typeof globalThis & { BuyerAddressPortal166: { mountBuyerAddressPortal166: typeof mountBuyerAddressPortal166 } };
const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new(html: string, options: { url: string; runScripts: 'outside-only' }) => { window: TestWindow; reconfigure(options: { url: string }): void };
};

// Synthetic native wire only. No Fastify/app/db imports, listeners, providers or real fetch.
const token = 'a'.repeat(48), previewId = '11111111-1111-4111-8111-111111111111';
const receiptId = '22222222-2222-4222-8222-222222222222', scope = 'b'.repeat(64);
const now = Date.parse('2026-10-08T12:00:00Z');
const old = { recipient_name: 'Łucja Żółć', street: 'Stara 5', city: 'Łódź', postal_code: '90-001', country: 'PL', phone: '+48123456789' };
const fresh = { ...old, street: 'Nowa 12/3' };
const status = (extra = {}) => ({ available: true, read_only: false, enabled: true, can_edit: true,
  reason: null, delivery: { ...old }, revision: 'opaque-original', last_change: null, ...extra });
const preview = (extra = {}) => ({ available: true, read_only: false, id: previewId, scope_hash: scope,
  expires_at: '2026-10-08T12:10:00Z', before: { ...old }, after: { ...fresh }, changed: true,
  state: 'preview', local_only: true, reused: false, ...extra });
const applied = (extra = {}) => ({ available: true, read_only: false, id: receiptId, state: 'applied',
  changed: true, delivery: { ...fresh }, revision: 'opaque-after', created_at: '2026-10-08T12:01:00Z', reused: false, ...extra });
const json = (v: unknown, code = 200) => new Response(JSON.stringify(v), { status: code, headers: { 'Content-Type': 'application/json' } });
type Call = { path: string; method: string; wire: string | null };
test('actual portal HTML nonce script mounts unavailable address without PII and retains old contact/returns reads', async () => {
  const d = { number: 'ZAM/1', status_label: 'Nowe', total_label: '10,00 zł', currency: 'PLN',
    payment: { payment_mode: 'prepaid', amount_due: 1000 }, items: [] };
  const dom = new JSDOM(portalHtml(d, 'controlled-nonce'), { url: `http://qa166.localhost/api/public/orders/${token}`, runScripts: 'outside-only' });
  const calls: string[] = [];
  dom.window.fetch = (async input => {
    const path = String(input); calls.push(path);
    if (path.endsWith('/address')) return json({ available: false, read_only: false, enabled: false, can_edit: false, reason: 'module_unavailable', delivery: null, revision: null, last_change: null });
    if (path.endsWith('/messages')) return json({ available: false, read_only: false, data: [], meta: { cursor: null } });
    if (path.endsWith('/data')) return json({ ...d, shipping_cost: 0, shipments: [], documents: [], can_request: false, read_only: false, shipping_available: 0, cases: [], meta: { cursor: null } });
    assert.fail('Unexpected portal path');
  }) as typeof fetch;
  try {
    const scripts = [...dom.window.document.querySelectorAll('script')]; assert.equal(scripts.length, 1); assert.equal(scripts[0].nonce, 'controlled-nonce');
    assert(!/\bimport\s|\bexport\s/.test(scripts[0].textContent!)); dom.window.eval(scripts[0].textContent!);
    await until(() => calls.length === 3 && dom.window.document.querySelector('#buyer-delivery-address')!.textContent!.includes('niedostępna'));
    assert.equal(dom.window.document.querySelector('#buyer-delivery-address input[name=street]')!.getAttribute('value'), null);
    assert(!dom.window.document.querySelector('#buyer-delivery-address')!.textContent!.includes(old.street));
    assert(calls.some(x=>x.endsWith('/messages'))); assert(calls.some(x=>x.endsWith('/data')));
    dom.window.dispatchEvent(new dom.window.Event('pagehide')); assert.equal(dom.window.document.querySelector('#buyer-delivery-address')!.textContent, '');
  } finally { dom.window.close(); }
});
async function until(check: () => boolean) {
  for (let i = 0; i < 80; i++) { if (check()) return; await new Promise<void>(r => setImmediate(r)); }
  assert.ok(check(), 'Controlled UI did not settle');
}
async function setup(handler: (call: Call, calls: Call[]) => Response | Promise<Response> = c =>
  json(c.method === 'GET' ? status() : c.path.endsWith('/apply') ? applied() : preview(), c.method === 'GET' ? 200 : 201)) {
  const dom = new JSDOM('<section id="address"></section>', { url: `http://qa166.localhost/api/public/orders/${token}`, runScripts: 'outside-only' });
  const host = dom.window.document.querySelector<HTMLElement>('#address')!;
  const calls: Call[] = []; let key = 0;
  const fakeFetch: typeof fetch = async (input, init) => {
    assert.equal(typeof input, 'string');
    const path = String(input);
    assert.ok(path.startsWith(`/api/public/orders/${token}/address`));
    assert.equal(init?.credentials, 'omit'); assert.equal(init?.cache, 'no-store'); assert.equal(init?.redirect, 'error');
    const call = { path, method: init?.method ?? 'GET', wire: typeof init?.body === 'string' ? init.body : null };
    if (call.method === 'POST') assert.equal(new Headers(init?.headers).get('Content-Type'), 'application/json');
    calls.push(call); return handler(call, calls);
  };
  dom.window.eval(browserScript166);
  const client = dom.window.BuyerAddressPortal166.mountBuyerAddressPortal166(host, { fetch: fakeFetch, now: () => now,
    newKey: () => `33333333-3333-4333-8333-${String(++key).padStart(12, '0')}` });
  await client.ready;
  const button = (text: string) => [...host.querySelectorAll('button')].find(b => b.textContent === text)!;
  const field = (name: string) => host.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
  const consent = () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  const change = (name: string, value: string) => { field(name).value = value; field(name).dispatchEvent(new dom.window.Event('input', { bubbles: true })); };
  const submit = () => host.querySelector('form')!.requestSubmit();
  const posts = () => calls.filter(c => c.method === 'POST');
  const cleanup = () => { client.destroy(); dom.window.close(); };
  return { dom, host, client, calls, button, field, consent, change, submit, posts, cleanup };
}
async function checkPreview(x: Awaited<ReturnType<typeof setup>>) {
  x.change('street', fresh.street); x.submit();
  await until(() => x.host.querySelectorAll('table tr').length === 7);
}

test('full six-field comparison and separate unchecked consent; edit/new preview resets consent', async () => {
  const x = await setup(); try {
    await checkPreview(x);
    assert.equal(x.host.querySelectorAll('table td').length, 18);
    assert.equal(x.consent().checked, false); assert.equal(x.button('Zapisz adres dostawy').disabled, true);
    x.button('Zapisz adres dostawy').click(); assert.equal(x.posts().length, 1);
    x.consent().checked = true; x.consent().dispatchEvent(new x.dom.window.Event('change'));
    assert.equal(x.button('Zapisz adres dostawy').disabled, false);
    x.change('street', fresh.street); assert.equal(x.consent().checked, false);
    assert.equal(x.host.querySelectorAll('table').length, 0);
    x.submit(); await until(() => x.host.querySelectorAll('table').length === 1);
    assert.equal(x.consent().checked, false); assert.equal(x.posts().length, 2);
    x.consent().checked = true; x.consent().dispatchEvent(new x.dom.window.Event('change'));
    x.button('Zapisz adres dostawy').click(); await until(() => x.host.textContent!.includes('został zapisany'));
    assert.equal(x.posts().length, 3);
    assert.deepEqual(JSON.parse(x.posts()[2].wire!), { client_key: '33333333-3333-4333-8333-000000000003',
      scope_hash: scope, confirmed: true, local_only: true });
    assert.equal(x.dom.window.localStorage.length, 0);
    assert.ok(!x.host.textContent!.includes(token));
  } finally { x.cleanup(); }
});

test('lost apply ACK preserves exact RAM body/key, allows explicit replay after native revision changes', async () => {
  let committed = false, writes = 0;
  const x = await setup(c => {
    if (c.method === 'GET') return json(committed ? status({ delivery: fresh, revision: 'opaque-after', can_edit: false, reason: 'fulfillment_started' }) : status());
    if (!c.path.endsWith('/apply')) return json(preview(), 201);
    if (++writes === 1) { committed = true; throw Error('synthetic lost ACK; private body MUST NOT render'); }
    return json(applied({ reused: true }));
  }); try {
    await checkPreview(x); x.consent().checked = true; x.consent().dispatchEvent(new x.dom.window.Event('change'));
    x.button('Zapisz adres dostawy').click(); await until(() => x.host.textContent!.includes('niepewny'));
    assert.equal(x.button('Ponów ten sam zapis').hidden, false); assert.equal(x.field('street').disabled, true);
    assert.equal(x.button('Odśwież adres dostawy').disabled, true);
    const first = x.posts()[1].wire;
    x.button('Ponów ten sam zapis').click(); await until(() => x.host.textContent!.includes('został zapisany'));
    assert.equal(x.posts()[2].wire, first); assert.equal(writes, 2);
    assert.ok(!x.host.textContent!.includes('private body')); assert.equal(x.dom.window.localStorage.length, 0);
  } finally { x.cleanup(); }
});

test('preview unknown ACK or malformed success retains exact attempt for explicit recovery, no automatic POST', async () => {
  let writes = 0;
  const x = await setup(c => c.method === 'GET' ? json(status()) : json(++writes === 1 ? preview({ after: { ...fresh, street: 'Obcy adres' } }) : preview({ reused: true }), 201));
  try {
    x.change('street', fresh.street); x.submit(); await until(() => x.host.textContent!.includes('niepewny'));
    assert.equal(x.posts().length, 1); assert.equal(x.host.querySelectorAll('table').length, 0);
    const first = x.posts()[0].wire; x.button('Ponów ten sam zapis').click();
    await until(() => x.host.querySelectorAll('table').length === 1);
    assert.equal(x.posts()[1].wire, first); assert.equal(x.consent().checked, false);
  } finally { x.cleanup(); }
});

test('404 purges address/draft/preview/pending and never echoes provider error or token', async () => {
  let fail = false;
  const x = await setup(c => c.method === 'GET' ? json(status()) : fail ? json({ detail: token + ' private address' }, 404) : json(preview(), 201));
  try {
    await checkPreview(x); fail = true; x.consent().checked = true; x.consent().dispatchEvent(new x.dom.window.Event('change'));
    x.button('Zapisz adres dostawy').click(); await until(() => x.host.textContent!.includes('Link jest niedostępny'));
    assert.equal(x.field('street').value, ''); assert.equal(x.host.querySelectorAll('table').length, 0);
    assert.equal(x.button('Ponów ten sam zapis').hidden, true);
    assert.ok(!x.host.textContent!.includes(old.street)); assert.ok(!x.host.textContent!.includes(token));
  } finally { x.cleanup(); }
});

test('fresh native readonly fence prevents POST; explicit opt-out hides fields; 422 permits correction', async () => {
  let blocked = false;
  const x = await setup(c => c.method === 'GET' ? json(blocked ? status({ read_only: true, can_edit: false, reason: 'read_only' }) : status()) : json({}, 422));
  try {
    x.change('street', fresh.street); x.submit(); await until(() => x.host.textContent!.includes('Sprawdź pola'));
    assert.equal(x.posts().length, 1); assert.equal(x.field('street').disabled, false);
    blocked = true; x.submit(); await until(() => x.host.textContent!.includes('Podgląd kopii'));
    assert.equal(x.posts().length, 1); assert.equal(x.host.querySelector('form')!.hidden, true);
  } finally { x.cleanup(); }
  const hidden = await setup(() => json(status({ enabled: false, can_edit: false, reason: 'access_disabled', delivery: null, revision: null })));
  try { assert.equal(hidden.host.querySelector('form')!.hidden, true); assert.equal(hidden.field('street').value, '');
    hidden.submit(); assert.equal(hidden.posts().length, 0); } finally { hidden.cleanup(); }
});

test('409 obtains fresh native state, clears consent and requires a new preview; never auto applies', async () => {
  let reads = 0;
  const x = await setup(c => c.method === 'GET' ? json(++reads >= 3 ? status({ delivery: { ...old, street: 'Aktualny 8' }, revision: 'opaque-current' }) : status()) : json({}, 409));
  try {
    x.change('street', fresh.street); x.submit(); await until(() => x.host.textContent!.includes('Sprawdź nowy podgląd'));
    assert.equal(x.posts().length, 1); assert.equal(x.field('street').value, 'Aktualny 8');
    assert.equal(x.consent().checked, false); assert.equal(x.host.querySelectorAll('table').length, 0);
    assert.equal(x.button('Ponów ten sam zapis').hidden, true);
  } finally { x.cleanup(); }
});

test('destroy or token-page change while fresh access is held prevents send and late PII rendering', async () => {
  for (const action of ['destroy', 'navigate'] as const) {
    let release!: (r: Response) => void;
    const x = await setup((c, calls) => calls.length === 2 ? new Promise<Response>(r => { release = r; }) : json(status()));
    try {
      x.change('street', fresh.street); x.submit(); await until(() => typeof release === 'function');
      if (action === 'destroy') x.client.destroy(); else x.dom.reconfigure({ url: `http://qa166.localhost/api/public/orders/${'c'.repeat(48)}` });
      release(json(status())); await new Promise<void>(r => setImmediate(r));
      assert.equal(x.posts().length, 0); assert.ok(!x.host.textContent!.includes(old.street));
      assert.ok(!x.host.textContent!.includes(fresh.street));
    } finally { x.cleanup(); }
  }
});


test('replay receipt A after genuine later B preserves current B/revision and labels A historical', async () => {
  const later = { ...old, street: 'Najnowszy adres B 45' };
  let committedA = false, writes = 0, disabled = false;
  const x = await setup(c => {
    if (c.method === 'GET') return json(disabled ? status({ enabled: false, can_edit: false, reason: 'access_disabled', delivery: null, revision: null }) : committedA ? status({ delivery: later, revision: 'opaque-later-B' }) : status());
    if (!c.path.endsWith('/apply')) return json(committedA ? preview({ before: later }) : preview(), 201);
    if (++writes === 1) { committedA = true; throw Error('synthetic ACK lost after A committed'); }
    return json(applied({ reused: true }));
  });
  try {
    await checkPreview(x); x.consent().checked = true; x.consent().dispatchEvent(new x.dom.window.Event('change'));
    x.button('Zapisz adres dostawy').click(); await until(() => x.host.textContent!.includes('niepewny'));
    const firstWire = x.posts()[1].wire;
    x.button('Ponów ten sam zapis').click(); await until(() => x.host.textContent!.includes('Potwierdzenie jest historyczne'));
    assert.equal(x.posts().length, 3); assert.equal(writes, 2); assert.equal(x.posts()[2].wire, firstWire);
    const current = x.host.querySelector('[data-buyer-address-current]')!;
    const history = x.host.querySelector('[data-buyer-address-history]')!;
    assert.ok(current.textContent!.includes(later.street)); assert.ok(!current.textContent!.includes(fresh.street));
    assert.ok(history.textContent!.includes(fresh.street));
    assert.ok(history.textContent!.includes('historia, nie aktualny adres'));
    assert.equal(x.field('street').value, later.street); assert.equal(x.button('Ponów ten sam zapis').hidden, true);
    assert.equal(x.consent().checked, false); assert.equal(x.dom.window.localStorage.length, 0);
    // New preview must bind latest B revision/before, proving receipt A did not replace state B.
    const observed: unknown[] = [];
    x.change('street', fresh.street); x.submit();
    await until(() => x.posts().length === 4 && x.host.querySelectorAll('table').length === 1);
    observed.push(JSON.parse(x.posts()[3].wire!));
    assert.equal((observed[0] as { revision: string }).revision, 'opaque-later-B');
    assert.equal(x.posts().filter(p => p.path.endsWith('/apply')).length, 2);
    const beforeRefreshPosts = x.posts().length;
    disabled = true; x.button('Odśwież adres dostawy').click();
    await until(() => x.host.textContent!.includes('Sprzedawca nie udostępnił korekty'));
    assert.equal(x.posts().length, beforeRefreshPosts);
    assert.equal(x.host.querySelector('[data-buyer-address-current]')!.textContent, '');
    assert.equal(x.host.querySelector('[data-buyer-address-history]')!.textContent, '');
    assert.equal(x.field('street').value, ''); assert.equal(x.host.querySelectorAll('table').length, 0);
    assert.ok(!x.host.textContent!.includes(old.recipient_name));
    assert.ok(!x.host.textContent!.includes(fresh.street)); assert.ok(!x.host.textContent!.includes(later.street));
    assert.equal(x.button('Ponów ten sam zapis').hidden, true);
  } finally { x.cleanup(); }
});
