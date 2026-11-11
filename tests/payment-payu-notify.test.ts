import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Problem } from '../server/errors';
import {
  decidePayuNotification,
  parsePayuSignature,
  payuSignatureValid,
  verifyPayuNotification,
  type PayuSession,
} from '../server/payment-payu-notify';
import { PayU } from '../server/payment-payu';
import { createPayuFake, PAYU_FAKE_POS, PAYU_FAKE_SECOND_KEY, PAYU_FAKE_SECRET } from '../server/payment-payu-fake';
// SYNTHETIC notifications (fixtures and fake); the second key is a synthetic test value, not a PayU secret.
const KEY = PAYU_FAKE_SECOND_KEY;
const fixture = (name: string) => readFileSync(new URL(`./fixtures/payu/${name}.json`, import.meta.url), 'utf8');
const sign = (body: string, algorithm = 'MD5', key = KEY) =>
  `sender=checkout;signature=${createHash(algorithm === 'MD5' ? 'md5' : 'sha256').update(body + key).digest('hex')};algorithm=${algorithm};content=DOCUMENT`;
const problem = (status: number, code: RegExp) => (e: unknown) => e instanceof Problem && e.status === status && code.test(e.code ?? '');
const session = (over: Partial<PayuSession> = {}): PayuSession => ({
  extOrderId: 'sess-fixture-1',
  orderId: 'FIXT9ZZ1ABC251026GUEST000P01',
  amount: 12345,
  currency: 'PLN',
  status: 'NEW',
  ...over,
});

test('signature header: MD5 and SHA-256 accepted, everything else refused', () => {
  const body = fixture('notification-order-completed');
  assert.equal(parsePayuSignature(sign(body)).algorithm, 'MD5');
  assert.equal(parsePayuSignature(sign(body, 'SHA-256')).algorithm, 'SHA-256');
  assert.ok(payuSignatureValid(body, sign(body), KEY));
  assert.ok(payuSignatureValid(body, sign(body, 'SHA-256'), KEY));
  assert.ok(payuSignatureValid(body, sign(body, 'SHA-256').replace('SHA-256', 'SHA256'), KEY));
  for (const bad of [
    null,
    '',
    'sender=checkout;algorithm=MD5',
    'signature=abc;algorithm=MD5',
    sign(body).replace('MD5', 'SHA1'),
    sign(body, 'SHA-256').replace('SHA-256', 'MD5'), // 64-hex digest under MD5: wrong length
    sign(body, 'MD5', 'other-second-key'),
    sign(body + ' '),
  ])
    assert.equal(payuSignatureValid(body, bad, KEY), false, String(bad));
  assert.equal(payuSignatureValid(body, sign(body, 'MD5', ''), ''), false);
});

test('verified order notification from the SYNTHETIC fixture; tampered body or bad signature rejected', () => {
  const body = fixture('notification-order-completed');
  const n = verifyPayuNotification(body, { 'OpenPayu-Signature': sign(body) }, KEY);
  assert.deepEqual(n, {
    kind: 'order',
    orderId: 'FIXT9ZZ1ABC251026GUEST000P01',
    extOrderId: 'sess-fixture-1',
    status: 'COMPLETED',
    amount: 12345,
    currency: 'PLN',
    paymentId: '7000000001',
  });
  assert.equal(verifyPayuNotification(body, new Headers({ 'X-OpenPayu-Signature': sign(body, 'SHA-256') }), KEY).kind, 'order');
  const tampered = body.replace('"12345"', '"1"');
  assert.throws(() => verifyPayuNotification(tampered, { 'OpenPayu-Signature': sign(body) }, KEY), problem(401, /PAYU_SIGNATURE/));
  assert.throws(() => verifyPayuNotification(body, {}, KEY), problem(401, /PAYU_SIGNATURE/));
  assert.throws(() => verifyPayuNotification(body, { 'OpenPayu-Signature': sign(body, 'MD5', 'x') }, KEY), problem(401, /PAYU_SIGNATURE/));
  assert.throws(() => verifyPayuNotification('', {}, KEY), problem(413, /SIZE/));
  const notJson = 'not json';
  assert.throws(() => verifyPayuNotification(notJson, { 'OpenPayu-Signature': sign(notJson) }, KEY), problem(400, /INVALID/));
  const odd = JSON.stringify({ order: { orderId: 'X1234567', extOrderId: 's', status: 'WEIRD', totalAmount: '1', currencyCode: 'PLN' } });
  assert.throws(() => verifyPayuNotification(odd, { 'OpenPayu-Signature': sign(odd) }, KEY), problem(400, /INVALID/));
});

test('refund notification parses refund id, amount and FINALIZED status', () => {
  const body = fixture('notification-refund-finalized');
  const n = verifyPayuNotification(body, { 'openpayu-signature': sign(body) }, KEY);
  assert.equal(n.kind, 'refund');
  if (n.kind === 'refund') assert.deepEqual([n.refundId, n.extRefundId, n.amount, n.status], ['5000001', 'ret-fixture-1', 2345, 'FINALIZED']);
  assert.throws(() => decidePayuNotification(session(), n), problem(422, /KIND/));
});

test('replayed notification is idempotent: one receipt for many deliveries', () => {
  const body = fixture('notification-order-completed');
  const ledger: string[] = [];
  let s = session({ status: 'PENDING' });
  for (let i = 0; i < 3; i++) {
    const d = decidePayuNotification(s, verifyPayuNotification(body, { 'OpenPayu-Signature': sign(body) }, KEY));
    if (d.outcome === 'apply') {
      s = { ...s, status: d.status, orderId: d.orderId };
      if (d.bookReceipt) ledger.push(`receipt:${d.paymentId}:${s.amount}`);
    }
    assert.equal(d.outcome, i === 0 ? 'apply' : 'duplicate');
  }
  assert.deepEqual(ledger, ['receipt:7000000001:12345']);
});

test('out-of-order and post-terminal statuses are ignored; amount, currency and foreign ids are refused', () => {
  const n = (status: string, over: Record<string, string> = {}) => {
    const body = fixture('notification-order-completed').replace('"status": "COMPLETED"', `"status": "${status}"`);
    const changed = Object.entries(over).reduce((b, [from, to]) => b.replace(from, to), body);
    return verifyPayuNotification(changed, { 'OpenPayu-Signature': sign(changed) }, KEY);
  };
  assert.deepEqual(decidePayuNotification(session({ status: 'WAITING_FOR_CONFIRMATION' }), n('PENDING')), { outcome: 'ignored', reason: 'out_of_order' });
  assert.deepEqual(decidePayuNotification(session({ status: 'COMPLETED' }), n('CANCELED')), { outcome: 'ignored', reason: 'terminal' });
  assert.equal(decidePayuNotification(session({ status: 'NEW', orderId: null }), n('PENDING')).outcome, 'apply');
  assert.throws(() => decidePayuNotification(session(), n('COMPLETED', { '"12345"': '"12344"' })), problem(409, /PAYU_AMOUNT_MISMATCH/));
  assert.throws(() => decidePayuNotification(session(), n('COMPLETED', { '"PLN"': '"EUR"' })), problem(409, /PAYU_AMOUNT_MISMATCH/));
  assert.throws(() => decidePayuNotification(session({ extOrderId: 'other' }), n('COMPLETED')), problem(409, /PAYU_FOREIGN/));
  assert.throws(() => decidePayuNotification(session({ orderId: 'OTHER0000001' }), n('COMPLETED')), problem(409, /PAYU_FOREIGN/));
});

test('end to end with the fake: create, buyer pays, signed notification verified and applied once', async () => {
  const fake = createPayuFake();
  const client = new PayU('sandbox', { pos_id: PAYU_FAKE_POS }, { client_secret: PAYU_FAKE_SECRET }, fake.transport, { sleep: async () => {} });
  const created = await client.createOrder({
    extOrderId: 'sess-e2e',
    description: 'Zamówienie SYNTH-E2E',
    currency: 'EUR',
    amount: 500,
    customerIp: '::1',
    notifyUrl: 'https://sklep.example/api/public/payu/notify',
    continueUrl: 'https://sklep.example/zamowienie/e2e',
    buyer: { email: 'k@example.invalid' },
    products: [{ name: 'A', unitPrice: 250, quantity: 2 }],
  });
  fake.setStatus(created.orderId, 'COMPLETED');
  for (const algorithm of ['MD5', 'SHA-256'] as const) {
    const { body, headers } = fake.orderNotification(created.orderId, algorithm);
    const d = decidePayuNotification(
      { extOrderId: 'sess-e2e', orderId: created.orderId, amount: 500, currency: 'EUR', status: algorithm === 'MD5' ? 'NEW' : 'COMPLETED' },
      verifyPayuNotification(body, headers, KEY),
    );
    assert.equal(d.outcome, algorithm === 'MD5' ? 'apply' : 'duplicate');
  }
});
