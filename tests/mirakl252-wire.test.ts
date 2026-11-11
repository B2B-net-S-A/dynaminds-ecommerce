/** Mirakl writes (252) against the local fake: OF24/OF02/OF03, OR21/OR23/OR24, answer classification
 * (acknowledged / refused / deferred / uncertain) and the fake's own reads used for reconciliation. No network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMiraklFake, MIRAKL262_FAKE_ORIGIN, MIRAKL262_FAKE_KEY } from '../server/mirakl262-fake';
import { createMiraklWriter, MiraklWriteDeferred, MiraklWriteRefused, MiraklWriteUncertain, miraklPrice } from '../server/mirakl262-wire';

const settings = { instance_url: MIRAKL262_FAKE_ORIGIN, shop_id: '2000', currency: 'PLN' };
const setup = (o: { importReadsUntilComplete?: number } = {}) => {
  const fake = createMiraklFake(o);
  return { fake, w: createMiraklWriter({ settings, apiKey: MIRAKL262_FAKE_KEY, transport: fake.transport, timeoutMs: 200 }) };
};

test('OF24 updates existing offers asynchronously; OF02 reports completion and OF03 the unknown SKU', async () => {
  const { fake, w } = setup();
  fake.addOffer({ shop_sku: 'SKU-1', price: 10, quantity: 1 });
  const { import_id } = await w.submitOffers([{ shop_sku: 'SKU-1', price_minor: 12345, quantity: 7 }, { shop_sku: 'NOPE', price_minor: 100, quantity: 1 }]);
  assert.match(import_id, /^\d+$/);
  const post = fake.calls.find(c => c.method === 'POST')!;
  assert.deepEqual(JSON.parse(post.body!), { offers: [{ shop_sku: 'SKU-1', price: 123.45, quantity: 7, update_delete: 'update' }, { shop_sku: 'NOPE', price: 1, quantity: 1, update_delete: 'update' }] });
  assert.equal(post.query, '?shop_id=2000');
  const st = await w.importStatus(import_id);
  assert.deepEqual([st.done, st.failed, st.lines_in_success, st.lines_in_error, st.has_error_report], [true, false, 1, 1, true]);
  assert.deepEqual(fake.offers.get('SKU-1')!.price, 123.45);
  const errors = await w.importErrors(import_id);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].shop_sku, 'NOPE');
});

test('OF24 refuses a duplicate SKU and out-of-range values before any HTTP', async () => {
  const { fake, w } = setup();
  await assert.rejects(w.submitOffers([{ shop_sku: 'A', price_minor: 1, quantity: 1 }, { shop_sku: 'A', price_minor: 2, quantity: 1 }]), (e: any) => e.status === 422);
  await assert.rejects(w.submitOffers([{ shop_sku: 'A', price_minor: -1, quantity: 1 }]));
  await assert.rejects(w.submitOffers([]));
  assert.equal(fake.calls.length, 0);
});

test('OR21 accept, OR23 tracking, OR24 ship move the order; a wrong state is refused, nothing applied', async () => {
  const { fake, w } = setup();
  fake.addOrder({ order_id: 'MO-1', state: 'WAITING_ACCEPTANCE', lines: [{ sku: 'SKU-1', quantity: 1, price: 10 }] });
  await assert.rejects(w.shipOrder('MO-1'), (e: any) => e instanceof MiraklWriteRefused && e.providerStatus === 400);
  await w.acceptOrder('MO-1', ['MO-1-1']);
  assert.equal(fake.orders.get('MO-1')!.order_state, 'SHIPPING');
  await assert.rejects(w.acceptOrder('MO-1', ['MO-1-1']), MiraklWriteRefused);
  await w.setTracking('MO-1', { carrier_code: 'DPD', tracking_number: '0000123' });
  await w.setTracking('MO-1', { carrier_code: 'DPD', tracking_number: '0000123' });
  assert.equal(fake.orders.get('MO-1')!.tracking!.tracking_number, '0000123');
  await w.shipOrder('MO-1');
  assert.equal(fake.orders.get('MO-1')!.order_state, 'SHIPPED');
  await assert.rejects(w.shipOrder('UNKNOWN'), (e: any) => e instanceof MiraklWriteRefused && e.providerStatus === 404);
  await assert.rejects(w.acceptOrder('a/b', ['x']));
  await assert.rejects(w.setTracking('MO-1', { tracking_number: 'X' } as any), 'carrier required');
});

test('answers are classified: 429 deferred, 5xx/timeout/throw uncertain (even when the fake applied it), 401 refused', async () => {
  const { fake, w } = setup();
  fake.addOrder({ order_id: 'MO-2', lines: [{ sku: 'S', quantity: 1, price: 5 }] });
  fake.fail({ kind: 'http', status: 429, retryAfter: '42' });
  await assert.rejects(w.shipOrder('MO-2'), (e: any) => e instanceof MiraklWriteDeferred && e.seconds === 42);
  assert.equal(fake.orders.get('MO-2')!.order_state, 'SHIPPING', 'a deferred write applied nothing');
  fake.fail({ kind: 'commit_then_500' });
  await assert.rejects(w.shipOrder('MO-2'), MiraklWriteUncertain);
  assert.equal(fake.orders.get('MO-2')!.order_state, 'SHIPPED', 'the change landed although the answer was lost');
  fake.fail({ kind: 'commit_then_hang' });
  await assert.rejects(w.setTracking('MO-2', { carrier_name: 'Poczta', tracking_number: 'PP1' }), MiraklWriteUncertain);
  fake.fail({ kind: 'throw' });
  await assert.rejects(w.shipOrder('MO-2'), MiraklWriteUncertain);
  const bad = createMiraklWriter({ settings, apiKey: 'wrong-key', transport: fake.transport });
  await assert.rejects(bad.shipOrder('MO-2'), (e: any) => e instanceof MiraklWriteRefused && e.providerStatus === 401 && !/SYNTHETIC/.test(e.message));
});

test('the writer refuses a non-Mirakl instance and the price conversion is exact', () => {
  assert.throws(() => createMiraklWriter({ settings: { ...settings, instance_url: 'https://evil.example.com' }, apiKey: 'k', transport: async () => new Response() }));
  assert.equal(miraklPrice(12345), 123.45);
  assert.equal(miraklPrice(10), 0.1);
  assert.equal(miraklPrice(2147483647), 21474836.47);
});
