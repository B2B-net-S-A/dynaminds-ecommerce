/** S5 communication/portal units without a database: template tags, HTML link filter,
 * SMS rendering with order values, portal page links (VM oracle), carrier tracking links and
 * the SMS delivery status label. DB flows are in tests/messages-s5.database.test.ts. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { cleanEmailHtml, validateEmailTemplate, emailVariables } from '../server/email';
import { renderSms, validateSmsBody, smsVariables } from '../server/sms';
import { isPortalLink, portalLink, usedVariables, PORTAL_ORIGIN } from '../server/message-variables';
import { portalHtml } from '../server/portal-view';
import { trackingUrl } from '../server/portal-routes';
import { SmsDeliveryStatus } from '../web/sms-delivery';
import { messageVariables } from '../web/messages-variables';
import { trackingName } from '../web/tracking';

const token = 'a1'.repeat(24);
const order = {
  number: 'ZAM-1',
  customer_name: 'Anna',
  total: 12345,
  currency: 'PLN',
  status: 'paid',
  source: 'manual',
  address: { phone: '500100200', country: 'PL' },
};

test('the web tag list mirrors the server list (email and SMS share one set)', () => {
  assert.deepEqual(emailVariables, smsVariables);
  assert.deepEqual(messageVariables.map((v) => v.key), emailVariables);
  for (const tag of ['portal_link', 'products', 'delivery_address', 'delivery_method', 'invoice_number'])
    assert(emailVariables.includes(tag), tag);
});

test('templates accept the new tags and still reject unknown or malformed ones', () => {
  const t = validateEmailTemplate({
    name: 'Nowa odpowiedź',
    subject: 'Zamówienie {{order_number}}',
    body: 'Link: {{portal_link}} · {{products}} · {{delivery_address}} · {{delivery_method}} · {{invoice_number}}',
    html: '<p><a href="{{portal_link}}">Twoje zamówienie</a></p>',
    active: true,
    attachment: 'none',
  });
  assert.match(t.html, /href="\{\{portal_link\}\}"/);
  assert.throws(
    () => validateEmailTemplate({ ...t, body: '{{payment_link}}' }),
    /Nieznana zmienna: payment_link/,
  );
  validateSmsBody('{{order_number}} {{portal_link}} {{tracking_number}}');
  assert.throws(() => validateSmsBody('{{secret}}'), /Nieznana zmienna szablonu: secret/);
  assert.deepEqual([...usedVariables(['{{a_b}} x {{a_b}}', '{{c}}'])], ['a_b', 'c']);
});

test('HTML filter keeps only the exact local portal link over http; other http links lose href', () => {
  const link = portalLink(token);
  assert.equal(link, PORTAL_ORIGIN + '/api/public/orders/' + token);
  assert(isPortalLink(link));
  assert(!isPortalLink(link + '/x') && !isPortalLink('http://127.0.0.1:4100/api/public/orders/zz'));
  const html = cleanEmailHtml(
    `<a href="${link}">ok</a><a href="http://evil.example/">a</a><a href="HTTP://evil.example/">b</a>` +
      `<a href=" http://evil.example/">c</a><a href="h&#9;ttp://evil.example/">d</a>` +
      `<a href="${link}@evil.example">e</a><a href="https://shop.example/">f</a><a href="javascript:alert(1)">g</a>`,
  );
  assert(html.includes(`<a href="${link}">ok</a>`), html);
  assert(!/evil\.example/.test(html), html);
  assert(html.includes('<a href="https://shop.example/">f</a>'));
  assert(!html.includes('javascript'));
});

test('SMS rendering uses supplied order values and refuses a tag without data', () => {
  const values = { order_number: 'ZAM-1', customer_name: 'Anna', total: '123.45', currency: 'PLN', status: 'paid', source: 'manual', portal_link: portalLink(token) };
  const r = renderSms({ body: 'Zamówienie {{order_number}}: {{portal_link}}', max_parts: 3 }, order, values);
  assert.equal(r.payload, 'Zamówienie ZAM-1: ' + portalLink(token));
  assert.equal(r.recipient, '48500100200');
  assert.equal(renderSms({ body: '{{order_number}} {{total}}', max_parts: 1 }, order).payload, 'ZAM-1 123.45');
  assert.throws(
    () => renderSms({ body: '{{portal_link}}', max_parts: 3 }, order),
    /Brak danych zmiennej szablonu: portal_link/,
  );
});

test('carrier tracking link only for live parcels of known carriers', () => {
  assert.equal(
    trackingUrl({ carrier: 'InPost ShipX', tracking_number: '520000011395200025754311', mode: 'live' }),
    'https://inpost.pl/sledzenie-przesylek?number=520000011395200025754311',
  );
  assert.match(
    trackingUrl({ carrier: 'DPD Polska', tracking_number: '0000123456789U', mode: 'live' })!,
    /^https:\/\/tracktrace\.dpd\.com\.pl\/parcelDetails\?typ=1&p1=0000123456789U$/,
  );
  assert.equal(trackingUrl({ carrier: 'InPost ShipX', tracking_number: 'X1234', mode: 'sandbox' }), null);
  assert.equal(trackingUrl({ carrier: 'DEMO', tracking_number: 'DEMO-1', mode: 'live' }), null);
  assert.equal(trackingUrl({ carrier: 'DPD Polska', tracking_number: '12"><script>', mode: 'live' }), null);
});

type El = {
  tag: string;
  textContent: string;
  children: El[];
  hidden: boolean;
  attrs: Record<string, string>;
  href?: string;
  append: (e: El) => void;
  replaceChildren: () => void;
  setAttribute: (k: string, v: string) => void;
  [key: string]: unknown;
};
function portalDom(data: any) {
  const html = portalHtml(data, 'n1');
  // The buyer-address widget (own tests in buyer-address-portal-ui166) needs a full DOM; it is
  // detached here so the oracle covers the documents and shipments sections only.
  const script = html
    .match(/<script nonce="n1">([\s\S]*?)<\/script>/)?.[1]
    ?.replace(/const buyerAddressClient=[^\n]*\n/, '')
    .replace(/window\.addEventListener\('pagehide'[^\n]*\n/, '');
  assert(script && !script.includes('buyerAddressClient'));
  const element = (tag = 'div'): El => ({
    tag,
    textContent: '',
    children: [],
    hidden: false,
    attrs: {},
    append(e: El) {
      this.children.push(e);
    },
    replaceChildren() {
      this.children = [];
    },
    setAttribute(k: string, v: string) {
      this.attrs[k] = v;
    },
  });
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map((m) => [m[1], element()]));
  new Script(script).runInNewContext({
    Intl,
    Date,
    crypto: { randomUUID },
    location: { pathname: '/api/public/orders/' + token },
    document: { getElementById: (id: string) => elements.get(id) ?? null, createElement: element },
    fetch: async (path: string) => ({
      ok: true,
      json: async () =>
        path.endsWith('/messages') ? { available: false, read_only: true, data: [], meta: { cursor: null } } : data,
    }),
  });
  return elements;
}
test('portal page links a prepared provider PDF and a carrier tracking page', async () => {
  const data = {
    number: 'ZAM-PDF',
    fulfillment_kind: 'sale',
    status_label: 'Nadane',
    currency: 'PLN',
    total_label: '10,00 zł',
    shipping_cost: 0,
    shipping_available: 0,
    payment: { payment_mode: 'prepaid', amount_due: 0 },
    payment_as_of_merge: false,
    items: [],
    documents: [
      { id: 'd-pdf', number: 'FV/1', kind: 'invoice', mode: 'external', download: 'pdf', download_available: true },
      { id: 'd-demo', number: 'FV/DEMO', kind: 'invoice', mode: 'demo', download: 'print', download_available: true },
      { id: 'd-none', number: 'FV/2', kind: 'invoice', mode: 'external', download: null, download_available: false },
    ],
    shipments: [
      { carrier: 'InPost ShipX', tracking_number: 'T1', mode: 'live', status: 'shipped', tracking_url: 'https://inpost.pl/sledzenie-przesylek?number=T1' },
    ],
    cases: [],
    meta: { cursor: null },
    can_request: false,
    read_only: false,
  };
  const elements = portalDom(data);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(elements.get('error')?.textContent, '');
  const docs = elements.get('documents')!.children;
  const pdf = docs.find((d) => d.textContent.includes('FV/1'))!;
  assert.equal(pdf.href, '/api/public/orders/' + token + '/documents/d-pdf/file');
  assert.equal(pdf.attrs.download, '');
  assert.equal(docs.find((d) => d.textContent.includes('FV/DEMO'))!.href, '/api/public/orders/' + token + '/documents/d-demo/print');
  assert(docs.find((d) => d.textContent.includes('FV/2'))!.textContent.includes('pobranie u sprzedawcy'));
  const shipment = elements.get('shipments')!.children[0];
  const link = shipment.children.find((c) => c.tag === 'a')!;
  assert.equal(link.href, 'https://inpost.pl/sledzenie-przesylek?number=T1');
  assert.equal(link.rel, 'noreferrer noopener');
});

test('portal shows shipment statuses with the Polish labels of the admin tracking view', async () => {
  const shipment = (tracking_number: string, status: string) => ({ carrier: 'InPost ShipX', tracking_number, mode: 'live', status, tracking_url: null });
  const data = {
    number: 'ZAM-STATUS', fulfillment_kind: 'sale', status_label: 'Nadane', currency: 'PLN', total_label: '10,00 zł',
    shipping_cost: 0, shipping_available: 0, payment: { payment_mode: 'prepaid', amount_due: 0 }, payment_as_of_merge: false,
    items: [], documents: [], meta: { cursor: null }, can_request: false, read_only: false,
    shipments: [shipment('T1', 'created'), shipment('T2', 'label_ready'), shipment('T3', 'out_for_delivery'), shipment('T4', 'some_new_code')],
    cases: [{ id: 'c1', number: 'RMA/1', kind: 'complaint', remedy: 'exchange', state: 'requested', reason: 'Uszkodzony', created_at: '2026-10-27T10:00:00.000Z', items: [],
      exchange: { replacement_number: 'ZAM-W1', replacement_status: 'shipped', shipments: [{ carrier: 'DPD Polska', tracking_number: 'W1', mode: 'live', status: 'created' }] } }],
  };
  const elements = portalDom(data);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(elements.get('error')?.textContent, '');
  const lines = elements.get('shipments')!.children.map((p) => p.textContent.trim());
  assert.deepEqual(lines, [
    'InPost ShipX · T1 · Utworzona',
    'InPost ShipX · T2 · Etykieta gotowa',
    'InPost ShipX · T3 · W doręczeniu',
    'InPost ShipX · T4 · some_new_code',
  ]);
  for (const [status, line] of [['created', lines[0]], ['label_ready', lines[1]], ['out_for_delivery', lines[2]]])
    assert(line.endsWith(' · ' + trackingName(status)), 'portal and admin share one label for ' + status);
  const exchange = elements.get('cases')!.children[0].children.map((p) => p.textContent);
  assert(exchange.includes('DPD Polska · W1 · Utworzona'), exchange.join(' | '));
});

test('SMS delivery status shows the provider report label in the UI', () => {
  const html = (delivery: any, mode = 'provider_live') =>
    renderToStaticMarkup(createElement(SmsDeliveryStatus, { mode, delivery }));
  assert.match(html({ status_code: 404, needs_reconciliation: false }), /Doręczona/);
  assert.match(html({ status_code: 405, needs_reconciliation: true }), /Niedoręczona · wymaga sprawdzenia/);
  assert.match(html({ status_code: null, needs_reconciliation: false }), /Brak raportu doręczenia/);
  assert.match(html(null, 'local'), /symulacja/);
});

test('web runtime imports of server modules never load a Node builtin (Vite would blank the app)', () => {
  // A value import of a server module that imports node:crypto stops the whole Vite client at load
  // ("Module node:crypto has been externalized"); type-only imports are erased and stay allowed.
  const root = new URL('../', import.meta.url);
  const offenders: string[] = [];
  for (const name of readdirSync(new URL('web/', root))) {
    if (!/\.tsx?$/.test(name)) continue;
    const source = readFileSync(new URL('web/' + name, root), 'utf8');
    for (const m of source.matchAll(/import\s+(type\s+)?[^;]*?from\s+'\.\.\/server\/([^']+)'/g)) {
      if (m[1]) continue;
      const file = new URL('server/' + m[2].replace(/(\.ts)?$/, '.ts'), root);
      const server = readFileSync(file, 'utf8');
      if (/^import\s+(?!type\b)[^;]*from\s+'(node:[^']+|crypto|fs|path|pg)'/m.test(server)) offenders.push(name + ' → server/' + m[2]);
    }
  }
  assert.deepEqual(offenders, []);
});

test('COM-004: batch results export per recipient and re-select only messages that never left', async () => {
  const { batchResultsCsv, retryableStates } = await import('../web/messages-batch-results');
  const csv = batchResultsCsv(
    [
      { order_id: 'o1', number: 'ZAM-1', state: 'simulated', payload: { recipient: 'a@example.test', subject: 'Zamówienie "1"' } },
      { order_id: 'o2', number: 'ZAM-2', state: 'invalid', error: '=HYPERLINK("x")', payload: null },
    ],
    { simulated: 'Symulacja lokalna', invalid: 'Niepoprawna' },
    'email',
  );
  assert(csv.startsWith('\ufeff"Zamówienie";"Odbiorca";"Temat";"Wynik";"Błąd"\r\n'));
  assert(csv.includes('"ZAM-1";"a@example.test";"Zamówienie ""1""";"Symulacja lokalna";""'));
  assert(csv.includes(`"ZAM-2";"";"";"Niepoprawna";"'=HYPERLINK(""x"")"`), csv);
  const sms = batchResultsCsv([{ order_id: 'o3', number: 'Z3', state: 'failed', recipient: '48500100200', payload: 'Treść' }], {}, 'sms');
  assert(sms.includes('"Z3";"48500100200";"Treść";"failed";""'));
  assert(retryableStates.has('invalid') && retryableStates.has('failed'));
  assert(!retryableStates.has('uncertain'), 'an uncertain send may have reached the buyer');
});
