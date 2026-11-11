/** Pure rules of the PayU payment session (migration 242, docs/parity/PAYU242-20261027.md): the status machine
 * for a notification or a status read, the notification signature, the peer allow-list, the secret path token,
 * the public origin and the refundable amount. No database, no network. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  decidePayu242,
  payu242PeerAllowed,
  payu242PublicOrigin,
  payu242Refundable,
  payu242ReturnSecretMatches,
  payu242SecretMatches,
  newPayu242Secret,
  PAYU242_NOTIFY_IPS,
  type Payu242SessionState,
  type Payu242Observation,
} from '../server/payu242-session';
import { verifyPayuNotification } from '../server/payment-payu-notify';
import { createPayuFake, PAYU_FAKE_SECOND_KEY } from '../server/payment-payu-fake';

const session = (over: Partial<Payu242SessionState> = {}): Payu242SessionState => ({
  extOrderId: 's-1', providerOrderId: 'SYNTH000001GUEST000P01', amount: 12345, currency: 'PLN', status: 'NEW', ...over,
});
const seen = (over: Partial<Payu242Observation> = {}): Payu242Observation => ({
  orderId: 'SYNTH000001GUEST000P01', extOrderId: 's-1', status: 'PENDING', amount: 12345, currency: 'PLN', paymentId: null, ...over,
});

test('the status machine moves forward and books exactly on COMPLETED', () => {
  assert.deepEqual(decidePayu242(session(), seen()), { outcome: 'apply', status: 'PENDING', providerOrderId: 'SYNTH000001GUEST000P01', book: false, paymentId: null });
  assert.deepEqual(decidePayu242(session({ status: 'PENDING' }), seen({ status: 'COMPLETED', paymentId: '7000000001' })),
    { outcome: 'apply', status: 'COMPLETED', providerOrderId: 'SYNTH000001GUEST000P01', book: true, paymentId: '7000000001' });
  assert.equal(decidePayu242(session({ status: 'NEW' }), seen({ status: 'COMPLETED' })).outcome, 'apply', 'NEW straight to COMPLETED is a payment');
  assert.equal(decidePayu242(session({ status: 'WAITING_FOR_CONFIRMATION' }), seen({ status: 'COMPLETED' })).outcome, 'apply');
  assert.equal(decidePayu242(session({ status: 'PENDING' }), seen({ status: 'CANCELED' })).outcome, 'apply');
  // A session whose PayU id is not stored yet (answer lost) takes it from the first matching observation.
  const d = decidePayu242(session({ providerOrderId: null }), seen({ orderId: 'SYNTH000009GUEST000P01' }));
  assert.equal(d.outcome === 'apply' && d.providerOrderId, 'SYNTH000009GUEST000P01');
});

test('replays, late and out-of-order statuses never book twice or undo a payment', () => {
  assert.deepEqual(decidePayu242(session({ status: 'COMPLETED' }), seen({ status: 'COMPLETED' })), { outcome: 'duplicate' });
  assert.deepEqual(decidePayu242(session({ status: 'COMPLETED' }), seen({ status: 'CANCELED' })), { outcome: 'ignored_terminal' });
  assert.deepEqual(decidePayu242(session({ status: 'COMPLETED' }), seen({ status: 'PENDING' })), { outcome: 'ignored_terminal' });
  assert.deepEqual(decidePayu242(session({ status: 'PENDING' }), seen({ status: 'NEW' })), { outcome: 'ignored_out_of_order' });
  assert.deepEqual(decidePayu242(session({ status: 'CANCELED' }), seen({ status: 'PENDING' })), { outcome: 'ignored_terminal' });
});

test('COMPLETED after CANCELED or REJECTED is a conflict for review, never an automatic booking', () => {
  for (const status of ['CANCELED', 'REJECTED'] as const)
    assert.deepEqual(decidePayu242(session({ status }), seen({ status: 'COMPLETED' })), { outcome: 'conflict', review: 'completed_after_canceled' });
});

test('another amount, currency or order is refused before any status is considered', () => {
  assert.deepEqual(decidePayu242(session(), seen({ amount: 12344, status: 'COMPLETED' })), { outcome: 'amount_mismatch', review: 'amount_mismatch' });
  assert.deepEqual(decidePayu242(session(), seen({ currency: 'EUR', status: 'COMPLETED' })), { outcome: 'amount_mismatch', review: 'amount_mismatch' });
  assert.deepEqual(decidePayu242(session(), seen({ extOrderId: 's-2', status: 'COMPLETED' })), { outcome: 'foreign' });
  assert.deepEqual(decidePayu242(session(), seen({ orderId: 'SYNTH000002GUEST000P01', status: 'COMPLETED' })), { outcome: 'foreign' });
  // A status read carries no extOrderId check by itself; the stored PayU id still has to match.
  assert.equal(decidePayu242(session(), seen({ extOrderId: null, status: 'COMPLETED' })).outcome, 'apply');
});

test('the notification signature covers the exact body with the second key (MD5 and SHA-256)', () => {
  const fake = createPayuFake();
  const body = JSON.stringify({ order: { orderId: 'SYNTH000001GUEST000P01', extOrderId: 's-1', status: 'COMPLETED', totalAmount: '12345', currencyCode: 'PLN' } });
  for (const algorithm of ['MD5', 'SHA-256'] as const) {
    const headers = fake.sign(body, algorithm);
    assert.equal(verifyPayuNotification(body, headers, PAYU_FAKE_SECOND_KEY).kind, 'order');
    assert.throws(() => verifyPayuNotification(body.replace('12345', '12346'), headers, PAYU_FAKE_SECOND_KEY), /Podpis/);
    assert.throws(() => verifyPayuNotification(body, headers, 'another-second-key'), /Podpis/);
  }
  assert.throws(() => verifyPayuNotification(body, {}, PAYU_FAKE_SECOND_KEY), /Podpis/);
  const md5 = createHash('md5').update(body + PAYU_FAKE_SECOND_KEY).digest('hex');
  assert.equal(fake.sign(body)['OpenPayu-Signature'].split(';')[1], 'signature=' + md5);
});

test('only PayU senders of the configured environment pass the peer check', () => {
  assert.equal(payu242PeerAllowed(PAYU242_NOTIFY_IPS.sandbox[0], 'sandbox'), true);
  assert.equal(payu242PeerAllowed('::ffff:' + PAYU242_NOTIFY_IPS.sandbox[3], 'sandbox'), true);
  assert.equal(payu242PeerAllowed(PAYU242_NOTIFY_IPS.sandbox[0], 'production'), false, 'sandbox sender for a production shop');
  assert.equal(payu242PeerAllowed(PAYU242_NOTIFY_IPS.production[0], 'sandbox'), false);
  for (const peer of ['127.0.0.1', '::1', '10.0.0.1', '', undefined, null, '185.68.14.10 '])
    assert.equal(payu242PeerAllowed(peer, 'sandbox'), false, String(peer));
});

test('the path token and the return secret compare in constant time and fail closed', () => {
  const a = newPayu242Secret(), b = newPayu242Secret();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(payu242SecretMatches(a, a), true);
  assert.equal(payu242SecretMatches(a, b), false);
  for (const bad of [undefined, null, '', a.slice(1), a + 'x']) assert.equal(payu242SecretMatches(a, bad), false);
  assert.equal(payu242SecretMatches(undefined, a), false, 'a configuration without a token refuses');
  const stored = createHash('sha256').update(a).digest('hex');
  assert.equal(payu242ReturnSecretMatches(stored, a), true);
  assert.equal(payu242ReturnSecretMatches(stored, b), false);
  assert.equal(payu242ReturnSecretMatches('x', a), false);
});

test('the public origin is HTTPS without a path; HTTP only for a loopback name under the local simulation', () => {
  assert.equal(payu242PublicOrigin('https://sklep.example.pl', false), 'https://sklep.example.pl');
  assert.equal(payu242PublicOrigin('https://sklep.example.pl/', false), 'https://sklep.example.pl');
  for (const bad of ['http://sklep.example.pl', 'https://a:b@sklep.example.pl', 'https://sklep.example.pl/x', 'https://sklep.example.pl/?a=1', 'sklep', 'javascript:alert(1)'])
    assert.throws(() => payu242PublicOrigin(bad, false), /HTTPS|pełnym/, bad);
  assert.throws(() => payu242PublicOrigin('http://payu.localhost:4242', false), /HTTPS/);
  assert.equal(payu242PublicOrigin('http://payu.localhost:4242', true), 'http://payu.localhost:4242');
  assert.throws(() => payu242PublicOrigin('http://sklep.example.pl', true), /HTTPS/, 'the simulation never opens HTTP to a real host');
});

test('the refundable amount counts started, pending and finalized refunds', () => {
  assert.equal(payu242Refundable(10000, []), 10000);
  assert.equal(payu242Refundable(10000, [{ amount: 3000, status: 'FINALIZED' }, { amount: 2000, status: 'started' }, { amount: 4000, status: 'refused' }, { amount: 1000, status: 'CANCELED' }]), 5000);
  assert.equal(payu242Refundable(10000, [{ amount: 10000, status: 'PENDING' }]), 0);
});
