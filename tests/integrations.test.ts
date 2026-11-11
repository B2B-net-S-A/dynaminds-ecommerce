import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Allegro,
  WooCommerce,
  InPost,
  Fakturownia,
  ApiClient,
  validateRemoteUrl,
  type Transport,
} from '../server/integrations';
function capture(responses: unknown[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const transport: Transport = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(responses.shift()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, transport };
}
test('WooCommerce: Basic auth, zamówienia, produkty i aktualizacja — kontrakt lokalny', async () => {
  const m = capture([[{ id: 1 }], [{ id: 2 }], { id: 2, stock_quantity: 7 }]);
  const c = new WooCommerce(
    { store_url: 'https://shop.example' },
    { consumer_key: 'ck_fixture', consumer_secret: 'cs_fixture' },
    m.transport,
  );
  assert.equal((await c.orders(2)).page, 2);
  assert.match(m.calls[0].url, /wp-json\/wc\/v3\/orders/);
  assert.match(m.calls[0].url, /page=2/);
  assert.equal(
    (m.calls[0].init.headers as any).Authorization,
    'Basic ' + Buffer.from('ck_fixture:cs_fixture').toString('base64'),
  );
  await c.products();
  await c.updateProduct(2, { stock_quantity: 7, regular_price: '12.99' });
  assert.equal(m.calls[2].init.method, 'PUT');
  assert.deepEqual(JSON.parse(m.calls[2].init.body as string), {
    stock_quantity: 7,
    regular_price: '12.99',
  });
});
test('Allegro: poprawny sandbox, paginacja i kontrakt odświeżenia OAuth', async () => {
  const m = capture([
    { checkoutForms: [{ id: 'form' }], totalCount: 100 },
    { offers: [], totalCount: 0 },
    { access_token: 'next', refresh_token: 'rotated' },
  ]);
  const c = new Allegro(
    'sandbox',
    { access_token: 'fixture', refresh_token: 'refresh', client_id: 'id', client_secret: 'secret' },
    m.transport,
  );
  const orders = await c.orders(50);
  assert.equal(orders.has_more, true);
  assert.match(m.calls[0].url, /api.allegro.pl.allegrosandbox.pl\/order\/checkout-forms/);
  assert.equal((m.calls[0].init.headers as any).Accept, 'application/vnd.allegro.public.v1+json');
  await c.offers();
  const refresh = await c.refresh('sandbox');
  assert.equal(refresh.refresh_token, 'rotated');
  assert.equal(m.calls[2].init.method, 'POST');
  assert.match(m.calls[2].init.body as string, /grant_type=refresh_token/);
});
test('InPost: publiczne punkty bez tokena i organizacje z tokenem', async () => {
  const m = capture([{ items: [{ name: 'WAW01' }] }, { items: [] }]);
  const c = new InPost('live', { access_token: 'fixture' }, m.transport);
  assert.equal((await c.points('Warszawa')).items[0].name, 'WAW01');
  assert.match(m.calls[0].url, /\/v1\/points/);
  assert.ok(!(m.calls[0].init.headers as any).Authorization);
  await c.test();
  assert.equal((m.calls[1].init.headers as any).Authorization, 'Bearer fixture');
});
test('Fakturownia: odczyt i tworzenie faktury — wyłącznie kontrakt lokalny', async () => {
  const m = capture([[], { id: 77 }]);
  const c = new Fakturownia(
    { account_url: 'https://demo.fakturownia.pl' },
    { api_token: 'fixture' },
    m.transport,
  );
  await c.invoices(3);
  assert.match(m.calls[0].url, /page=3/);
  assert.match(m.calls[0].url, /api_token=fixture/);
  const d = await c.createInvoice({ kind: 'vat', buyer_name: 'Test', positions: [] });
  assert.equal(d.id, 77);
  assert.equal(JSON.parse(m.calls[1].init.body as string).api_token, 'fixture');
});
test('retry dotyczy bezpiecznych odczytów, nie powtarza zapisów po błędzie', async () => {
  let n = 0;
  const c = new ApiClient('https://api.example', {}, async () => {
    n++;
    return n === 1 ? new Response('{}', { status: 429 }) : new Response('{}', { status: 200 });
  });
  await c.request('/test');
  assert.equal(n, 2);
  n = 0;
  await assert.rejects(() => c.request('/test', { method: 'POST', body: { x: 1 } }), /HTTP 429/);
  assert.equal(n, 1);
});
test('transport nie ujawnia treści odpowiedzi dostawcy zawierającej sekrety', async () => {
  const c = new ApiClient(
    'https://api.example',
    {},
    async () => new Response('{"api_token":"secret"}', { status: 401 }),
  );
  await assert.rejects(
    () => c.request('/test'),
    (e) => e instanceof Error && e.message === 'API dostawcy: HTTP 401',
  );
});
test('konfiguracja blokuje adresy lokalne, HTTP i dane uwierzytelniające w URL', async () => {
  for (const url of [
    'http://example.com',
    'https://127.0.0.1',
    'https://localhost',
    'https://user:pass@example.com',
    'https://example.com?api_token=secret',
  ])
    await assert.rejects(() => validateRemoteUrl(url));
});
