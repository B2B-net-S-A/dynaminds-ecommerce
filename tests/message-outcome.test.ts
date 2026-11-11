/** AUTO-04 unit rules for the SMS/email operator decision (no database). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messageDecision, messageRetry, sameDecision, sentState } from '../server/message-outcome';

test('"sent" takes the success state the worker writes for the mode', () => {
  assert.equal(sentState('sms', 'local'), 'simulated');
  assert.equal(sentState('sms', 'provider_test'), 'tested');
  assert.equal(sentState('sms', 'provider_live'), 'submitted');
  assert.equal(sentState('email', 'local'), 'simulated');
  assert.equal(sentState('email', 'smtp'), 'smtp_accepted');
});
test('a replay is the same outcome and reference of a manual decision; anything else conflicts', () => {
  const r = { scope: 'manual_confirmation', resolution: 'sent', provider_ref: 'ID-1' };
  assert.equal(sameDecision(r, 'sent', 'ID-1'), true);
  assert.equal(sameDecision(r, 'sent', null), false);
  assert.equal(sameDecision(r, 'not_sent', null), false);
  assert.equal(sameDecision({ ...r, provider_ref: null }, 'sent', null), true);
  assert.equal(sameDecision({ resolution: 'sent', provider_ref: 'ID-1' }, 'sent', 'ID-1'), false, 'a worker result is never a manual decision');
  assert.equal(sameDecision(null, 'sent', null), false);
});
test('the decision needs an explicit consent and evidence; references are one plain token', () => {
  const ok = { outcome: 'sent', evidence: 'Panel SMSAPI 27.10', confirmed: true };
  assert.equal(messageDecision.safeParse(ok).success, true);
  assert.equal(messageDecision.safeParse({ ...ok, provider_ref: '<a.b-1@example.test>' }).success, true);
  assert.equal(messageDecision.safeParse({ ...ok, provider_ref: '1460969715572091219' }).success, true);
  for (const bad of [
    { ...ok, confirmed: false },
    { ...ok, evidence: 'krótko' },
    { ...ok, evidence: 'x'.repeat(501) },
    { ...ok, outcome: 'delivered' },
    { ...ok, provider_ref: 'a b' },
    { ...ok, provider_ref: 'x'.repeat(201) },
    { ...ok, provider_ref: 'a\r\nb' },
    { ...ok, extra: 1 },
  ])
    assert.equal(messageDecision.safeParse(bad).success, false, JSON.stringify(bad).slice(0, 80));
  assert.equal(messageRetry.safeParse({ client_key: 'x' }).success, false);
  assert.equal(messageRetry.safeParse({ client_key: '6f1c2c1e-0d55-4b3e-9a43-3e0a8f6a1b2c' }).success, true);
});
