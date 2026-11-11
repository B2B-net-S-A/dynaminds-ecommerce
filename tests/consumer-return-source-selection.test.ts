/** Pure selection only. No database, app construction, HTTP or native authority. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {selectConsumerReturnSource as select} from '../server/consumer-return-source-selection';
import type {ReturnCredit206Source} from '../server/return-credit206-values';

const id = (n: number) => `${String(n).padStart(8, '0')}-1000-4000-8000-000000000001`;
type History = Pick<ReturnCredit206Source, 'acceptances' | 'rejected_inspections'>;
const acceptance = (n: number, at: string) => ({return_id: id(n), receipt_id: id(n + 100), received_at: at, receipt_sequence: n, financial_hash: 'a'.repeat(64), refund_amount_minor: '1000', refunded_shipping_minor: '0', items: []});
const rejection = (n: number, at: string) => ({return_id: id(n), receipt_id: id(n + 100), completed_at: at, evidence_hash: 'b'.repeat(64)});

test('leading rejected inspection followed by an already credited acceptance defaults to the later physical acceptance', () => {
  const h = {acceptances: [acceptance(2, '2026-10-17T12:00:02.000000Z')], rejected_inspections: [rejection(1, '2026-10-17T12:00:01.000000Z')]};
  assert.equal(select(h, null), id(2));
});

test('a later rejected inspection takes precedence over an already credited acceptance, regardless of financial issue time', () => {
  const h = {acceptances: [acceptance(1, '2026-10-17T12:00:01.000000Z')], rejected_inspections: [rejection(2, '2026-10-17T12:00:02.000000Z')]};
  const withFinancialHistory = {...h, credit_families: [{document_id: id(3), receipt_id: id(4), family: 'destinations', created_at: '2026-10-17T14:00:00.000000Z'}]};
  assert.equal(select(withFinancialHistory, null), id(2));
});

test('reject-only history selects its latest actual inspection without inventing an accepted receipt', () => {
  const h: History = {acceptances: [], rejected_inspections: [rejection(2, '2026-10-17T12:00:02Z'), rejection(1, '2026-10-17T12:00:01Z')]};
  const before = structuredClone(h);
  assert.equal(select(h, null), id(2));
  assert.deepEqual(h, before);
});

test('the earliest pending financial acceptance supplied by the calculator wins over later accepted and rejected events', () => {
  const h = {acceptances: [acceptance(1, '2026-10-17T12:00:01Z'), acceptance(2, '2026-10-17T12:00:02Z')], rejected_inspections: [rejection(3, '2026-10-17T12:00:03Z')]};
  assert.equal(select(h, id(1)), id(1));
});

test('an explicit selector preserves both an older credited acceptance and a no-change inspection despite another pending return', () => {
  const h = {acceptances: [acceptance(1, '2026-10-17T12:00:01Z'), acceptance(2, '2026-10-17T12:00:03Z')], rejected_inspections: [rejection(3, '2026-10-17T12:00:02Z')]};
  assert.equal(select(h, id(2), id(1)), id(1));
  assert.equal(select(h, id(2), id(3)), id(3));
});

test('microsecond physical chronology beats UUID order and normalized fractions tie-break by receipt ID', () => {
  const h = {acceptances: [acceptance(9, '2026-10-17T12:00:01.000001Z')], rejected_inspections: [rejection(1, '2026-10-17T12:00:01.000002Z')]};
  assert.equal(select(h, null), id(1));
  const tied = {acceptances: [acceptance(9, '2026-10-17T12:00:01.1Z')], rejected_inspections: [rejection(1, '2026-10-17T12:00:01.100000Z')]};
  assert.equal(select(tied, null), id(9));
});

test('empty history, foreign explicit/pending targets and malformed physical timestamps fail closed', () => {
  assert.throws(() => select({acceptances: [], rejected_inspections: []}, null));
  const h = {acceptances: [acceptance(1, '2026-10-17T12:00:01Z')], rejected_inspections: [rejection(2, '2026-10-17T12:00:02Z')]};
  assert.throws(() => select(h, id(99)));
  assert.throws(() => select(h, null, id(99)));
  assert.throws(() => select(h, id(2)), 'A rejected inspection is not a pending financial acceptance');
  assert.throws(() => select({...h, rejected_inspections: [rejection(2, 'not-a-date')]}, null));
});
