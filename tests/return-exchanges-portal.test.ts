import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { portalHtml } from '../server/portal-view';

test('replacement portal loads shipments without a monetary payment-history element', async () => {
  const data = {
    number: 'WYMIANA-TEST',
    fulfillment_kind: 'replacement',
    status_label: 'Nadane',
    currency: 'PLN',
    total_label: '0,00 zł',
    shipping_cost: 0,
    shipping_available: 0,
    payment: { payment_mode: 'prepaid', amount_due: 0 },
    payment_as_of_merge: false,
    items: [],
    documents: [],
    shipments: [
      { carrier: 'DEMO', tracking_number: 'EXCHANGE-001', mode: 'demo', status: 'shipped' },
    ],
    cases: [],
    meta: { cursor: null },
    can_request: false,
    read_only: false,
  };
  const html = portalHtml(data, 'test-nonce');
  assert(html.includes('Bezpłatna wymiana reklamacyjna'));
  assert(!html.includes('id="payment-history"'));
  const script = html.match(/<script nonce="test-nonce">([\s\S]*?)<\/script>/)?.[1];
  assert(script);
  type Element = {
    textContent: string;
    children: Element[];
    hidden: boolean;
    append: (e: Element) => void;
    replaceChildren: () => void;
    setAttribute: () => void;
    [key: string]: unknown;
  };
  // The page also mounts the buyer delivery-address client (server/buyer-address-portal.ts), which needs
  // host.ownerDocument.defaultView on a real order-token path and the usual element methods.
  const pathname = '/api/public/orders/' + 'ab'.repeat(24);
  const fetchStub = async (path: string) => ({
    ok: true,
    json: async () =>
      path.endsWith('/messages')
        ? { available: false, read_only: true, data: [], meta: { cursor: null } }
        : data,
  });
  const win = { location: { pathname, href: 'http://127.0.0.1' + pathname }, fetch: fetchStub, crypto: { randomUUID }, addEventListener() {} };
  const doc: Record<string, unknown> = { defaultView: win };
  const element = (): Element => ({
    textContent: '',
    children: [],
    hidden: false,
    ownerDocument: doc,
    append(e: Element) {
      this.children.push(e);
    },
    prepend(e: Element) {
      this.children.unshift(e);
    },
    replaceChildren() {
      this.children = [];
    },
    setAttribute() {},
    addEventListener() {},
  });
  doc.createElement = element;
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map((m) => [m[1], element()]));
  // Isolated template unit oracle. This does not access a browser, API, or PostgreSQL.
  new Script(script).runInNewContext({
    Intl,
    Date,
    crypto: { randomUUID },
    location: win.location,
    window: win,
    document: Object.assign(doc, { getElementById: (id: string) => elements.get(id) ?? null }),
    fetch: fetchStub,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(elements.get('error')?.textContent, '');
  assert.equal(elements.get('return-form')?.hidden, true);
  assert(elements.get('shipments')?.children.some((e) => e.textContent.includes('EXCHANGE-001')));
  assert(elements.get('eligibility')?.textContent.includes('zamiennika'));
});
