import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { validatePrintContent, printPrinterCreateInput, printJobCreateInput, printJobAckInput, printVersion, PRINT_JOB_LIMITS } from '../server/print-job-values';
const encoded = (s: string) => Buffer.from(s).toString('base64');
const label = '^XA^FO20,20^A0N,24,24^FDQA145 DEMO^FS^XZ';
const job = () => ({ client_key: randomUUID(), order_id: randomUUID(), order_version: '1', station_id: randomUUID(), station_version: '1', printer_id: randomUUID(), printer_version: '1', source_kind: 'manual', format: 'zpl', content_base64: encoded(label), copies: 1, confirmed: true });
test('frozen label digest covers exact bytes and rejects noncanonical base64', () => {
  const v = validatePrintContent(encoded(label), 'zpl');
  assert.equal(v.content_bytes, Buffer.byteLength(label));
  assert.equal(v.content_sha256, createHash('sha256').update(label).digest('hex'));
  for (const bad of [encoded(label) + '\n', 'Zg=', 'Zg===', 'Zh==', '']) assert.throws(() => validatePrintContent(bad, 'zpl'));
});
test('raw printer configuration, filesystem, network and hidden copy commands are refused', () => {
  for (const command of ['^PQ99', '^DFR:secret.ZPL', '^XFR:secret.ZPL', '^CC!', '^CT!', '^NC1', '~DGR:logo,0,0,', '^JUS', '^CWZ,R:file.TTF']) {
    assert.throws(() => validatePrintContent(encoded('^XA' + command + '^FDdemo^FS^XZ'), 'zpl'), command);
  }
  assert.throws(() => validatePrintContent(encoded(label + label), 'zpl'));
  assert.throws(() => validatePrintContent(encoded('^XA^FDdemo\0^FS^XZ'), 'zpl'));
});
test('PDF requires its envelope and refuses known active or encoded action names', () => {
  validatePrintContent(encoded('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n'), 'pdf');
  for (const action of ['/JavaScript', '/JS', '/Launch', '/OpenAction', '/AA', '/EmbeddedFile', '/J#53']) {
    assert.throws(() => validatePrintContent(encoded('%PDF-1.4\n' + action + '\n%%EOF\n'), 'pdf'));
  }
  assert.throws(() => validatePrintContent(encoded('%PDF-1.4\ntruncated'), 'pdf'));
});
test('large bounded content validates without regex stack failure and over-limit content is refused', () => {
  const pdf = '%PDF-1.4\n%' + 'x'.repeat(PRINT_JOB_LIMITS.content_bytes - 20) + '\n%%EOF';
  assert.doesNotThrow(() => validatePrintContent(encoded(pdf), 'pdf'));
  assert.throws(() => validatePrintContent(encoded('%PDF-1.4\n' + 'x'.repeat(PRINT_JOB_LIMITS.content_bytes) + '\n%%EOF'), 'pdf'));
});
test('reprint, copy limit, station versions and command input remain explicit', () => {
  assert.equal(printJobCreateInput.safeParse(job()).success, true);
  for (const b of [{ copies: 0 }, { copies: 11 }, { confirmed: false }, { order_version: '0' }, { retry_of_job_id: randomUUID() }, { reprint_confirmed: true }, { command: 'lp' }]) assert.equal(printJobCreateInput.safeParse({ ...job(), ...b }).success, false);
  assert.equal(printJobCreateInput.safeParse({ ...job(), retry_of_job_id: randomUUID(), reprint_confirmed: true }).success, true);
  for (const v of ['nope', '-1', '1e4', '9223372036854775808']) assert.equal(printVersion.safeParse(v).success, false);
});
test('printer queues and output evidence cannot carry paths or shell commands', () => {
  const p = { client_key: randomUUID(), station_id: randomUUID(), station_version: '1', name: 'QA145', format: 'pdf', output_mode: 'cups', cups_queue: 'QA145_Printer', enabled: true };
  assert.equal(printPrinterCreateInput.safeParse(p).success, true);
  for (const cups_queue of ['../printer', '-o', 'x;touch file', '$(whoami)', 'host/printer']) assert.equal(printPrinterCreateInput.safeParse({ ...p, cups_queue }).success, false);
  const ack = { client_key: randomUUID(), version: '2', lease_token: randomUUID(), result: 'file_saved', content_sha256: 'a'.repeat(64), artifact_name: 'owned.zpl' };
  assert.equal(printJobAckInput.safeParse(ack).success, true);
  assert.equal(printJobAckInput.safeParse({ ...ack, artifact_name: '../owned.zpl' }).success, false);
  assert.equal(printJobAckInput.safeParse({ ...ack, spool_job_id: 'printer-1' }).success, false);
  assert.equal(printJobAckInput.safeParse({ ...ack, result: 'printed' }).success, false);
});
