/** 227 issue hooks in both issuing transactions (local tax-issue, Base addInvoice): the
 * NBP check runs before numbering, the record is written after it and before IMMEDIATE
 * constraints; the hash-pinned local invoice files are unchanged. Source order only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const read = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
function order(file: string, fn: string, marks: string[]) {
  const src = read(file), start = src.indexOf(fn);
  assert(start >= 0, fn);
  const at = marks.map(m => { const i = src.indexOf(m, start); assert(i > start, file + ': ' + m); return i; });
  assert.deepEqual([...at].sort((a, b) => a - b), at, file + ': ' + marks.join(' < '));
}

test('local tax-issue: NBP check before local_invoice_issue, record after it, then IMMEDIATE constraints', () => {
  order('server/tax226-local-invoices.ts', 'export async function issueLocalInvoiceWithTax', [
    'localInvoiceTaxFactsInTx(c, p.snapshot)', 'nbpRateBeforeNumberingInTx(c, p.snapshot)', "SELECT local_invoice_issue(", 'captureLocalInvoiceTaxInTx(', 'captureDocumentNbpRateInTx(', "SET CONSTRAINTS ALL IMMEDIATE"]);
});
test('Base addInvoice: same order inside its issuing transaction', () => {
  order('server/base-wire-invoices-runtime.ts', 'async issue(orderId, input)', [
    'localInvoiceTaxFactsInTx(c, snapshot)', 'nbpRateBeforeNumberingInTx(c, snapshot)', "SELECT local_invoice_issue(", 'captureLocalInvoiceTaxInTx(', 'captureDocumentNbpRateInTx(', "SET CONSTRAINTS ALL IMMEDIATE"]);
});
test('hash-pinned local invoice sources are untouched', () => {
  for (const f of ['server/local-invoices.ts', 'server/local-invoice-routes.ts', 'server/local-invoice-values.ts'])
    assert.equal(createHash('sha256').update(readFileSync(new URL('../' + f, import.meta.url))).digest('hex'), new RegExp(`"${f}": "([a-f0-9]{64})"`).exec(read('scripts/full-base-scale-http-ports.mjs'))?.[1], f);
});
