/** Read presentation over the already verified complete physical source.
 * No financial calculation, receipt mutation, IAM or write authority. */
import type {ReturnCredit206Source} from './return-credit206-values';

type History = Pick<ReturnCredit206Source, 'acceptances' | 'rejected_inspections'>;
function check(value: unknown): asserts value {
  if (!value) throw Error('Nie można wybrać zwrotu z pełnej historii przyjęć.');
}
function instant(value: string): string {
  check(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value) && Number.isFinite(Date.parse(value)));
  // Native uses UTC microseconds. Date.getTime() would discard the final three
  // digits and could select a different event when receipts share a millisecond.
  return value.replace(/(?:\.(\d{1,6}))?Z$/, (_match, fraction = '') => '.' + fraction.padEnd(6, '0') + 'Z');
}

export function selectConsumerReturnSource(
  history: History,
  nextReturnId: string | null,
  requestedReturnId?: string,
): string {
  const events = [
    ...history.acceptances.map(a => ({returnId: a.return_id, receiptId: a.receipt_id, at: instant(a.received_at)})),
    ...history.rejected_inspections.map(r => ({returnId: r.return_id, receiptId: r.receipt_id, at: instant(r.completed_at)})),
  ];
  check(events.length > 0);
  if (requestedReturnId !== undefined) {
    check(events.some(e => e.returnId === requestedReturnId));
    return requestedReturnId;
  }
  if (nextReturnId !== null) {
    check(history.acceptances.some(a => a.return_id === nextReturnId));
    return nextReturnId;
  }
  let latest = events[0];
  for (const event of events.slice(1)) {
    if (event.at > latest.at || (event.at === latest.at && event.receiptId > latest.receiptId)) latest = event;
  }
  return latest.returnId;
}
