/** SR4-M3: the request log never carries a secret of a URL: the PayU return secret (?s=), OAuth and
 * password-recovery queries and the buyer portal token are cut before pino writes the line. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { requestLogUrl } from '../server/request-log';

test('SR4-M3: PayU return pages and their status poll are logged without the query', () => {
  const s = 'Zq9-secret_' + 'x'.repeat(20);
  for (const url of [`/payu/return/00000000-0000-4000-8000-000000000000?s=${s}`, `/payu/return/00000000-0000-4000-8000-000000000000/status?s=${s}`, `/payu/return/abc?x=1&s=${s}`]) {
    const logged = requestLogUrl(url);
    assert.ok(!logged.includes(s), logged);
    assert.ok(!logged.includes('?'), logged);
    assert.ok(logged.startsWith('/payu/return/'), logged);
  }
});

test('SR4-M3: the earlier redactions stay; ordinary URLs are unchanged', () => {
  assert.equal(requestLogUrl('/api/oauth/allegro/callback?code=abc&state=def'), '/api/oauth/allegro/callback');
  assert.equal(requestLogUrl('/api/auth/password/reset?token=abc'), '/api/auth/password/reset');
  assert.equal(requestLogUrl('/api/public/orders/' + 'a'.repeat(48) + '/messages'), '/api/public/orders/[redacted]/messages');
  assert.equal(requestLogUrl('/api/orders?status=paid'), '/api/orders?status=paid');
  assert.equal(requestLogUrl('/payu-fake/pay/1'), '/payu-fake/pay/1');
  assert.equal(requestLogUrl('/callbacks/payu/cfg-1/notifySecret123'), '/callbacks/payu/cfg-1/[redacted]', 'the notification path secret too');
});

test('252: the Mirakl webhook path token is cut from the request log', () => {
  const token = 'Abc_' + 'z'.repeat(39);
  const logged = requestLogUrl('/callbacks/mirakl/00000000-0000-4000-8000-000000000000/' + token);
  assert.equal(logged, '/callbacks/mirakl/00000000-0000-4000-8000-000000000000/[redacted]');
  assert.ok(!logged.includes(token));
});
