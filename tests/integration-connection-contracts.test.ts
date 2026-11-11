// Local connection-probe contracts (POST /api/integrations/:id/test -> client.test()).
// Fake transport only: no request leaves the process.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { syncBuiltinESMExports } from 'node:module';
import {
  Allegro,
  WooCommerce,
  PrestaShop,
  Fakturownia,
  type Transport,
} from '../server/integrations';
import { BigBuy, BigBuyRetry } from '../server/bigbuy';
import { Problem } from '../server/errors';

type Call = { url: URL; init: RequestInit };
type Reply = () => Response;
const json =
  (value: unknown, status = 200, headers: Record<string, string> = {}): Reply =>
  () =>
    new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
const raw =
  (body: string, status = 200, headers: Record<string, string> = {}): Reply =>
  () =>
    new Response(body, { status, headers });
function fake(...replies: Reply[]) {
  const calls: Call[] = [];
  const transport: Transport = async (url, init) => {
    calls.push({ url: new URL(url), init });
    const next = replies.shift();
    assert.ok(next, 'nieoczekiwane dodatkowe wywołanie dostawcy: ' + url);
    return next();
  };
  return { calls, transport };
}
const headersOf = (c: Call) => c.init.headers as Record<string, string>;
const queryOf = (c: Call) => Object.fromEntries(c.url.searchParams);
// ApiClient sleeps with node:timers/promises; the ESM binding follows the mock only after a sync.
function fakeClock(t: TestContext, now?: number) {
  t.mock.timers.enable({ apis: now === undefined ? ['setTimeout'] : ['setTimeout', 'Date'], now });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.timers.reset();
    syncBuiltinESMExports();
  });
}
async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}
function outcome<T>(p: Promise<T>) {
  return p.then(
    (value) => ({ value, error: undefined as unknown }),
    (error: unknown) => ({ value: undefined as T | undefined, error }),
  );
}
const problem = (status: number, message: string | RegExp, code?: string) => (e: unknown) => {
  assert.ok(e instanceof Problem, 'oczekiwano Problem, otrzymano ' + String(e));
  assert.equal(e.status, status);
  if (typeof message === 'string') assert.equal(e.message, message);
  else assert.match(e.message, message);
  assert.equal(e.code, code);
  return true;
};

const ALLEGRO_TOKEN = 'allegro-access-SECRET-fixture';
const WOO_KEY = 'ck_fixture';
const WOO_SECRET = 'cs_SECRET_fixture';
const PS_KEY = 'S3CRETPRESTAKEY0123456789ABCDEFG';
const FV_TOKEN = 'fv-SECRET-token-fixture';
const BB_KEY = 'bigbuy-SECRET-key-fixture';

type ApiProbe = {
  name: string;
  secret: string;
  ok: Reply;
  run: (transport: Transport) => Promise<unknown>;
  check: (c: Call) => void;
};
const apiProbes: ApiProbe[] = [
  {
    name: 'Allegro',
    secret: ALLEGRO_TOKEN,
    ok: json({ id: '42', login: 'fixture' }),
    run: (tr) =>
      new Allegro('sandbox', { access_token: ALLEGRO_TOKEN, refresh_token: 'r' }, tr).test(),
    check: (c) => {
      assert.equal(c.url.origin, 'https://api.allegro.pl.allegrosandbox.pl');
      assert.equal(c.url.pathname, '/me');
      assert.deepEqual(queryOf(c), {});
      assert.deepEqual(headersOf(c), {
        Accept: 'application/vnd.allegro.public.v1+json',
        Authorization: 'Bearer ' + ALLEGRO_TOKEN,
      });
    },
  },
  {
    name: 'WooCommerce',
    secret: WOO_SECRET,
    ok: json([{ id: 1 }]),
    run: (tr) =>
      new WooCommerce(
        { store_url: 'https://shop.example/' },
        { consumer_key: WOO_KEY, consumer_secret: WOO_SECRET },
        tr,
      ).test(),
    check: (c) => {
      assert.equal(c.url.origin, 'https://shop.example');
      assert.equal(c.url.pathname, '/wp-json/wc/v3/products');
      assert.deepEqual(queryOf(c), { per_page: '1' });
      assert.deepEqual(headersOf(c), {
        Accept: 'application/json',
        Authorization: 'Basic ' + Buffer.from(WOO_KEY + ':' + WOO_SECRET).toString('base64'),
      });
    },
  },
  {
    name: 'PrestaShop',
    secret: PS_KEY,
    ok: json({ orders: [{ id: '7', id_shop: '3' }] }),
    run: (tr) =>
      new PrestaShop(
        { store_url: 'https://presta.example/', shop_id: '3', order_state_ids: '2,3' },
        { api_key: PS_KEY },
        tr,
      ).test(),
    check: (c) => {
      assert.equal(c.url.origin, 'https://presta.example');
      assert.equal(c.url.pathname, '/api/orders');
      assert.deepEqual(queryOf(c), {
        output_format: 'JSON',
        id_shop: '3',
        display: '[id,id_shop]',
        'filter[id_shop]': '[3]',
        limit: '1',
      });
      assert.deepEqual(headersOf(c), {
        Accept: 'application/json',
        Authorization: 'Basic ' + Buffer.from(PS_KEY + ':').toString('base64'),
      });
    },
  },
  {
    name: 'Fakturownia',
    secret: FV_TOKEN,
    ok: json([]),
    run: (tr) =>
      new Fakturownia(
        { account_url: 'https://demo.fakturownia.pl/' },
        { api_token: FV_TOKEN },
        tr,
      ).test(),
    check: (c) => {
      assert.equal(c.url.origin, 'https://demo.fakturownia.pl');
      assert.equal(c.url.pathname, '/invoices.json');
      // Fakturownia authenticates with api_token in the query string, not with a header.
      assert.deepEqual(queryOf(c), {
        api_token: FV_TOKEN,
        per_page: '1',
        page: '1',
        period: 'this_month',
      });
      assert.deepEqual(headersOf(c), { Accept: 'application/json' });
    },
  },
];

for (const p of apiProbes) {
  const readOnly = (calls: Call[]) => {
    for (const c of calls) {
      assert.equal(c.init.method, 'GET', p.name + ': sonda nie może zapisywać u dostawcy');
      assert.equal(c.init.body, undefined);
      p.check(c);
    }
  };
  const noSecret = (e: unknown) => {
    assert.ok(e instanceof Error);
    assert.ok(!e.message.includes(p.secret), p.name + ': sekret w komunikacie błędu');
    return true;
  };

  test(`${p.name}.test(): jeden GET z dokładnym URL i nagłówkiem uwierzytelnienia`, async () => {
    const m = fake(p.ok);
    await p.run(m.transport);
    assert.equal(m.calls.length, 1);
    readOnly(m.calls);
  });

  test(`${p.name}.test(): 401 -> Problem 401 PROVIDER_HTTP_UNAUTHORIZED bez ponowienia`, async () => {
    const m = fake(json({ error: 'invalid_token', echo: p.secret }, 401));
    await assert.rejects(
      p.run(m.transport),
      (e) =>
        problem(401, 'API dostawcy: HTTP 401', 'PROVIDER_HTTP_UNAUTHORIZED')(e) && noSecret(e),
    );
    assert.equal(m.calls.length, 1);
    readOnly(m.calls);
  });

  test(`${p.name}.test(): 403 -> Problem 502 bez kodu i bez ponowienia`, async () => {
    const m = fake(json({ error: 'forbidden', echo: p.secret }, 403));
    await assert.rejects(
      p.run(m.transport),
      (e) => problem(502, 'API dostawcy: HTTP 403')(e) && noSecret(e),
    );
    assert.equal(m.calls.length, 1);
  });

  test(`${p.name}.test(): niepoprawny JSON -> Problem 502 bez ponowienia`, async () => {
    const m = fake(raw('{"broken":', 200, { 'content-type': 'application/json' }));
    await assert.rejects(
      p.run(m.transport),
      problem(502, 'Nieprawidłowa odpowiedź JSON dostawcy'),
    );
    assert.equal(m.calls.length, 1);
  });

  test(`${p.name}.test(): 429 z Retry-After czeka dokładnie tyle i ponawia ten sam GET`, async (t) => {
    fakeClock(t);
    const m = fake(json({ error: 'rate' }, 429, { 'retry-after': '2' }), p.ok);
    const done = outcome(p.run(m.transport));
    await settle();
    assert.equal(m.calls.length, 1);
    t.mock.timers.tick(1999);
    await settle();
    assert.equal(m.calls.length, 1, 'ponowienie przed upływem Retry-After');
    t.mock.timers.tick(1);
    await settle();
    assert.equal(m.calls.length, 2);
    const r = await done;
    assert.equal(r.error, undefined);
    readOnly(m.calls);
    assert.equal(m.calls[0].url.href, m.calls[1].url.href);
  });

  test(`${p.name}.test(): 5xx -> 3 próby (300 ms, 600 ms), potem Problem 502`, async (t) => {
    fakeClock(t);
    const m = fake(json({}, 503), json({}, 502), json({ echo: p.secret }, 500));
    const done = outcome(p.run(m.transport));
    await settle();
    assert.equal(m.calls.length, 1);
    t.mock.timers.tick(299);
    await settle();
    assert.equal(m.calls.length, 1);
    t.mock.timers.tick(1);
    await settle();
    assert.equal(m.calls.length, 2);
    t.mock.timers.tick(599);
    await settle();
    assert.equal(m.calls.length, 2);
    t.mock.timers.tick(1);
    await settle();
    assert.equal(m.calls.length, 3);
    const r = await done;
    // The final 5xx falls through to the generic !res.ok branch, not the "po ponowieniach" message.
    problem(502, 'API dostawcy: HTTP 500')(r.error);
    noSecret(r.error);
    readOnly(m.calls);
  });
}

test('Allegro.test(): tryb inny niż sandbox używa produkcyjnego hosta, zwraca treść /me', async () => {
  const m = fake(json({ id: '42', login: 'fixture' }));
  const me = await new Allegro('live', { access_token: ALLEGRO_TOKEN }, m.transport).test();
  assert.deepEqual(me, { id: '42', login: 'fixture' });
  assert.equal(m.calls[0].url.href, 'https://api.allegro.pl/me');
});

test('Allegro.test(): 204 zwraca null bez czytania treści', async () => {
  const m = fake(() => new Response(null, { status: 204 }));
  assert.equal(await new Allegro('sandbox', { access_token: ALLEGRO_TOKEN }, m.transport).test(), null);
  assert.equal(m.calls.length, 1);
});

test('ApiClient backoff (sonda Allegro): Retry-After obcięty do 5 s', async (t) => {
  fakeClock(t);
  const m = fake(json({}, 429, { 'retry-after': '120' }), json({ id: '1' }));
  const done = outcome(new Allegro('sandbox', { access_token: ALLEGRO_TOKEN }, m.transport).test());
  await settle();
  t.mock.timers.tick(4999);
  await settle();
  assert.equal(m.calls.length, 1);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(m.calls.length, 2);
  assert.equal((await done).error, undefined);
});

test('ApiClient backoff (sonda Allegro): Retry-After jako data HTTP lub 0 -> domyślne 300 ms', async (t) => {
  fakeClock(t);
  for (const header of [new Date(Date.now() + 60_000).toUTCString(), '0', 'soon']) {
    const m = fake(json({}, 429, { 'retry-after': header }), json({ id: '1' }));
    const done = outcome(new Allegro('sandbox', { access_token: ALLEGRO_TOKEN }, m.transport).test());
    await settle();
    t.mock.timers.tick(299);
    await settle();
    assert.equal(m.calls.length, 1, header);
    t.mock.timers.tick(1);
    await settle();
    assert.equal(m.calls.length, 2, header);
    assert.equal((await done).error, undefined);
  }
});

test('ApiClient: trzy kolejne 429 -> Problem 502 HTTP 429 po 3 próbach', async (t) => {
  fakeClock(t);
  const r429 = json({}, 429, { 'retry-after': '1' });
  const m = fake(r429, r429, r429);
  const done = outcome(
    new WooCommerce(
      { store_url: 'https://shop.example' },
      { consumer_key: WOO_KEY, consumer_secret: WOO_SECRET },
      m.transport,
    ).test(),
  );
  for (let i = 0; i < 2; i++) {
    await settle();
    t.mock.timers.tick(1000);
  }
  const r = await done;
  assert.equal(m.calls.length, 3);
  problem(502, 'API dostawcy: HTTP 429')(r.error);
});

test('ApiClient: zapis tym samym klientem (POST Fakturownia) nie jest ponawiany po 5xx', async () => {
  const m = fake(json({}, 503));
  const c = new Fakturownia(
    { account_url: 'https://demo.fakturownia.pl' },
    { api_token: FV_TOKEN },
    m.transport,
  );
  await assert.rejects(c.createInvoice({ kind: 'vat' }), problem(502, 'API dostawcy: HTTP 503'));
  assert.equal(m.calls.length, 1);
  assert.equal(m.calls[0].init.method, 'POST');
});

test('WooCommerce.test(): nie sprawdza kształtu odpowiedzi, zwraca { ok: true }', async () => {
  const m = fake(json({ not: 'an array' }));
  const r = await new WooCommerce(
    { store_url: 'https://shop.example' },
    { consumer_key: WOO_KEY, consumer_secret: WOO_SECRET },
    m.transport,
  ).test();
  assert.deepEqual(r, { ok: true });
});

test('WooCommerce.test(): odpowiedź powyżej 5 MB -> Problem 502 (komunikat ogólny JSON)', async () => {
  const m = fake(raw('[' + '1,'.repeat(3 * 1024 * 1024) + '1]'));
  await assert.rejects(
    new WooCommerce(
      { store_url: 'https://shop.example' },
      { consumer_key: WOO_KEY, consumer_secret: WOO_SECRET },
      m.transport,
    ).test(),
    // The size ensure() runs inside the try whose catch rewrites every error to this message.
    problem(502, 'Nieprawidłowa odpowiedź JSON dostawcy'),
  );
  assert.equal(m.calls.length, 1);
});

const psSettings = { store_url: 'https://presta.example', shop_id: '3', order_state_ids: '2,3' };
test('PrestaShop: konstruktor odrzuca zły klucz, sklep i statusy bez żadnego wywołania', () => {
  const m = fake();
  for (const [settings, creds] of [
    [psSettings, { api_key: 'short' }],
    [psSettings, { api_key: PS_KEY.slice(0, 31) + '-' }],
    [psSettings, {}],
    [{ ...psSettings, shop_id: '0' }, { api_key: PS_KEY }],
    [{ ...psSettings, shop_id: 'abc' }, { api_key: PS_KEY }],
    [{ ...psSettings, order_state_ids: '' }, { api_key: PS_KEY }],
    [{ ...psSettings, order_state_ids: '2,x' }, { api_key: PS_KEY }],
  ] as [Record<string, string>, Record<string, string>][])
    assert.throws(
      () => new PrestaShop(settings, creds, m.transport),
      (e) => e instanceof Problem && e.status === 422 && !e.message.includes(PS_KEY),
    );
  assert.equal(m.calls.length, 0);
});

test('PrestaShop.test(): pusta lista [] jest poprawna, zwraca scope orders_read', async () => {
  const m = fake(json([]));
  const r = await new PrestaShop(psSettings, { api_key: PS_KEY }, m.transport).test();
  assert.deepEqual(r, { ok: true, scope: 'orders_read' });
  assert.equal(m.calls.length, 1);
});

test('PrestaShop.test(): zły kształt odpowiedzi -> Problem 502 bez ponowienia', async () => {
  for (const body of [
    { orders: [{ id: '1' }, { id: '2' }] },
    { products: [] },
    { orders: [['1']] },
    {},
  ]) {
    const m = fake(json(body));
    await assert.rejects(
      new PrestaShop(psSettings, { api_key: PS_KEY }, m.transport).test(),
      (e) => e instanceof Problem && e.status === 502,
      JSON.stringify(body),
    );
    assert.equal(m.calls.length, 1);
  }
});

test('PrestaShop.test(): nieprawidłowe id w odpowiedzi dostawcy -> Problem 422 (psId)', async () => {
  // Provider data passes through psId(), whose ensure() uses 422, so a bad remote id is reported as 422.
  const m = fake(json({ orders: [{ id: 'x' }] }));
  await assert.rejects(
    new PrestaShop(psSettings, { api_key: PS_KEY }, m.transport).test(),
    problem(422, 'Nieprawidłowy identyfikator PrestaShop'),
  );
  assert.equal(m.calls.length, 1);
});

test('Fakturownia.test(): klasa nie sprawdza domeny konta (strażnik jest tylko w trasie tworzenia)', async () => {
  // server/app.ts requires *.fakturownia.pl when a channel is created; the client itself trusts settings.
  const m = fake(json([]));
  await new Fakturownia(
    { account_url: 'https://invoices.example' },
    { api_token: FV_TOKEN },
    m.transport,
  ).test();
  assert.equal(m.calls[0].url.origin, 'https://invoices.example');
});

const bigbuy = (transport: Transport, mode = 'sandbox', key = BB_KEY) =>
  new BigBuy(mode, { api_key: key }, transport);
const bbCheck = (c: Call, origin = 'https://api.sandbox.bigbuy.eu') => {
  assert.equal(c.init.method, 'GET');
  assert.equal(c.init.body, undefined);
  assert.equal(c.url.origin, origin);
  assert.equal(c.url.pathname, '/rest/catalog/taxonomies.json');
  assert.deepEqual(queryOf(c), { firstLevel: '' });
  assert.deepEqual(headersOf(c), { Authorization: 'Bearer ' + BB_KEY, Accept: 'application/json' });
};

test('BigBuy.test(): jeden GET taxonomies.json?firstLevel= z Bearer, wynik read_only', async () => {
  const m = fake(json([{ id: 1 }, { id: 2 }]));
  assert.deepEqual(await bigbuy(m.transport).test(), { read_only: true, categories: 2 });
  assert.equal(m.calls.length, 1);
  bbCheck(m.calls[0]);
  const live = fake(json([]));
  await bigbuy(live.transport, 'live').test();
  bbCheck(live.calls[0], 'https://api.bigbuy.eu');
});

test('BigBuy: nieznane środowisko lub zły klucz -> błąd bez wywołania dostawcy', async () => {
  const m = fake();
  assert.throws(() => bigbuy(m.transport, 'production'), problem(422, 'Nieprawidłowe środowisko BigBuy'));
  for (const key of ['', 'with space', 'line\nbreak'])
    await assert.rejects(bigbuy(m.transport, 'sandbox', key).test(), (e) => {
      assert.ok(e instanceof Error);
      // bigbuyToken is a zod schema, so a bad key surfaces as ZodError (not Problem).
      assert.equal(e.name, 'ZodError');
      return true;
    });
  assert.equal(m.calls.length, 0);
});

test('BigBuy.test(): 401 -> Problem 401 bez kodu PROVIDER_HTTP_UNAUTHORIZED, 403 -> 502', async () => {
  for (const [status, expected] of [
    [401, 401],
    [403, 502],
    [404, 502],
  ]) {
    const m = fake(json({ echo: BB_KEY }, status));
    await assert.rejects(bigbuy(m.transport).test(), (e) => {
      problem(expected, 'BigBuy: HTTP ' + status)(e);
      assert.ok(!(e as Error).message.includes(BB_KEY));
      return true;
    });
    assert.equal(m.calls.length, 1);
  }
});

test('BigBuy.test(): niepoprawny JSON, nie-tablica, ponad 5 MB -> Problem 502', async () => {
  for (const [reply, message] of [
    [raw('{"x":'), 'Nieprawidłowy JSON BigBuy'],
    [json({ id: 1 }), 'Nieprawidłowe kategorie BigBuy'],
    [raw('[' + '1,'.repeat(3 * 1024 * 1024) + '1]'), 'Odpowiedź BigBuy przekracza 5 MB'],
  ] as [Reply, string][]) {
    const m = fake(reply);
    await assert.rejects(bigbuy(m.transport).test(), problem(502, message));
    assert.equal(m.calls.length, 1);
  }
});

test('BigBuy.test(): 429/5xx nie są ponawiane w procesie, tylko BigBuyRetry z sekundami', async (t) => {
  const now = Date.UTC(2026, 9, 25, 12, 0, 0);
  fakeClock(t, now);
  const cases: [number, Record<string, string>, number, number][] = [
    [429, { 'retry-after': '120' }, 429, 120],
    [429, { 'retry-after': '1' }, 429, 5],
    [429, { 'retry-after': '999999' }, 429, 86400],
    [429, { 'retry-after': new Date(now + 90_000).toUTCString() }, 429, 90],
    [429, { 'retry-after': new Date(now - 90_000).toUTCString() }, 429, 5],
    [429, { 'retry-after': 'soon' }, 429, 60],
    [429, {}, 429, 60],
    [503, {}, 502, 60],
    [500, { 'retry-after': '30' }, 502, 30],
  ];
  for (const [status, headers, problemStatus, seconds] of cases) {
    const m = fake(json({}, status, headers));
    await assert.rejects(bigbuy(m.transport).test(), (e) => {
      assert.ok(e instanceof BigBuyRetry, JSON.stringify(headers));
      assert.equal(e.status, problemStatus);
      assert.equal(e.seconds, seconds, JSON.stringify(headers));
      return true;
    });
    assert.equal(m.calls.length, 1, 'BigBuy nie ponawia sam: ' + JSON.stringify(headers));
    bbCheck(m.calls[0]);
  }
});
