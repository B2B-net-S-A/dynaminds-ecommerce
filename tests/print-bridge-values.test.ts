import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import {
  printBridgeConfig, printBridgeMode, printBridgeFileName, verifyPrintBridgeBytes,
  printBridgeCupsArgs, printBridgeCupsReference, printBridgeJournalDecision,
  printBridgeSafeFailure, PRINT_BRIDGE_MAX_BYTES,
} from '../server/print-bridge-values';

test('private bridge configuration cannot redirect credentials or silently enable cookie auth', () => {
  const valid = { api_token: 'dyna_test_fixture_only', tenant_id: randomUUID(), printer_id: randomUUID() };
  assert.equal(printBridgeConfig.safeParse(valid).success, true);
  for (const attack of [
    { ...valid, api_url: 'https://attacker.test' },
    { ...valid, output_dir: '/etc' },
    { ...valid, api_token: 'secret\r\nHost: attacker.test' },
    { ...valid, cookie: 'session=fake' },
    { tenant_id: valid.tenant_id, printer_id: valid.printer_id, cookie: 'session=fake' },
  ]) assert.equal(printBridgeConfig.safeParse(attack).success, false);
  assert.equal(printBridgeConfig.safeParse({ tenant_id: valid.tenant_id, printer_id: valid.printer_id,
    cookie: 'session=fixture', local_fixture: true }).success, true);
});
test('bridge output filenames bind the immutable job/hash/format and reject traversal', () => {
  const id = randomUUID(), hash = 'a'.repeat(64);
  assert.equal(printBridgeFileName(id.toUpperCase(), hash, 'pdf'), `${id}-${hash}.pdf`);
  for (const tuple of [ ['../../private', hash, 'pdf'], [id, '../secret', 'pdf'],
    [id, hash, '../zpl'], [id, hash.toUpperCase(), 'pdf'] ])
    assert.throws(() => printBridgeFileName(...tuple as [string, string, string]));
});
test('content verification rejects a changed or truncated spool and format spoofing', () => {
  const pdf = Buffer.from('%PDF-1.7\nfixture\n%%EOF\n');
  const hash = createHash('sha256').update(pdf).digest('hex');
  verifyPrintBridgeBytes(pdf, 'pdf', hash, pdf.length);
  assert.throws(() => verifyPrintBridgeBytes(pdf.subarray(0, -1), 'pdf', hash, pdf.length));
  const changed = Buffer.from(pdf); changed[9] ^= 1;
  assert.throws(() => verifyPrintBridgeBytes(changed, 'pdf', hash, pdf.length));
  assert.throws(() => verifyPrintBridgeBytes(pdf, 'zpl', hash, pdf.length));
  for (const name of ['/JavaScript', '/J#53', '/Launch', '/EmbeddedFile']) {
    const active = Buffer.from(`%PDF-1.7\n${name}\n%%EOF`);
    assert.throws(() => verifyPrintBridgeBytes(active, 'pdf', createHash('sha256').update(active).digest('hex'), active.length));
  }
  const oversized = Buffer.alloc(PRINT_BRIDGE_MAX_BYTES + 1);
  assert.throws(() => verifyPrintBridgeBytes(oversized, 'pdf', createHash('sha256').update(oversized).digest('hex'), oversized.length));
});
test('ZPL verification preserves printable bytes and rejects device/copy commands', () => {
  const zpl = Buffer.from('^XA^FO10,20^FDOWN^FS^XZ');
  verifyPrintBridgeBytes(zpl, 'zpl', createHash('sha256').update(zpl).digest('hex'), zpl.length);
  for (const value of [Buffer.from('^XA unfinished'), Buffer.from('^XA\0^XZ'), Buffer.from([0xff]),
    Buffer.from('^XA^PQ10^XZ'), Buffer.from('^XA~JA^XZ'), Buffer.from('^XA^ZZdata^XZ'), Buffer.from('^XA^FDŻółć^FS^XZ')])
    assert.throws(() => verifyPrintBridgeBytes(value, 'zpl', createHash('sha256').update(value).digest('hex'), value.length));
});
test('CUPS uses literal argv with bounded copies and refuses remote queues or shell options', () => {
  const path = '/controlled/with spaces/own.pdf';
  assert.deepEqual(printBridgeCupsArgs('QA_LOCAL', 2, path), ['-d', 'QA_LOCAL', '-n', '2', path]);
  for (const queue of ['-o', 'printer@remote', 'ipp://host', 'a;touch /tmp/x', 'x\ny'])
    assert.throws(() => printBridgeCupsArgs(queue, 1, path));
  for (const copies of [0, 11, 1.5]) assert.throws(() => printBridgeCupsArgs('QA_LOCAL', copies, path));
  assert.throws(() => printBridgeCupsArgs('QA_LOCAL', 1, '-f'));
  assert.equal(printBridgeCupsReference('request id is QA_LOCAL-23 (1 file(s))\n', 'QA_LOCAL'), 'QA_LOCAL-23');
  for (const output of ['printed', 'request id is OTHER-23 (1 file(s))',
    'request id is QA_LOCAL-EXTRA-23 (1 file(s))', 'request id is QA_LOCAL-23 (1 file(s))\nextra'])
    assert.throws(() => printBridgeCupsReference(output, 'QA_LOCAL'));
});
test('restart or watch cannot claim/dispatch again when claim or physical dispatch is unresolved', () => {
  for (const state of ['claim_intent', 'claimed', 'dispatch_intent', 'ack_intent'] as const)
    for (const mode of ['once', 'watch'] as const)
      assert.equal(printBridgeJournalDecision(state, mode), 'manual_reconcile');
  assert.equal(printBridgeJournalDecision('ack_intent', 'retry-ack'), 'retry_saved_ack');
  for (const state of ['claim_intent', 'claimed', 'dispatch_intent', 'complete', 'empty'] as const)
    assert.equal(printBridgeJournalDecision(state, 'retry-ack'), 'manual_reconcile');
  assert.equal(printBridgeJournalDecision('complete', 'watch'), 'next_claim');
  assert.equal(printBridgeJournalDecision('dispatch_intent', 'reconcile'), 'read_saved_job');
  assert.equal(printBridgeJournalDecision('reconciled', 'watch'), 'next_claim');
});
test('default is one claim; error reporting cannot echo credentials or printer output', () => {
  assert.equal(printBridgeMode([]), 'once');
  assert.equal(printBridgeMode(['--watch']), 'watch');
  for (const args of [['--watch', '--once'], ['--host', 'attacker'], ['--retry-print']])
    assert.throws(() => printBridgeMode(args));
  const secret = 'Bearer private_fixture_token; session=private_fixture_cookie';
  const err = Object.assign(new Error(secret), { code: secret, stdout: secret });
  const result = printBridgeSafeFailure(err);
  assert.equal(result, 'PRINT_BRIDGE_STOPPED_MANUAL_RECONCILIATION_REQUIRED');
  assert(!result.includes('Bearer') && !result.includes('session='));
});
