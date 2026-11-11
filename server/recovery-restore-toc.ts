/** Preserve dump ordering, deferring only actual event-trigger TOC entries.
 * This lets pg_restore and owner-default ACL restoration finish before the
 * restored database starts tracking subsequent DDL. No live trigger is disabled.
 */
export function splitRestoreEventTriggers(toc: string) {
  const ordinary: string[] = [], deferred: string[] = [];
  const event = /^\d+;\s+\d+\s+\d+\s+(?:EVENT TRIGGER\s|(?:COMMENT|SECURITY LABEL)\s+-\s+EVENT TRIGGER\s)/;
  for (const line of toc.split('\n')) (event.test(line) ? deferred : ordinary).push(line);
  return { ordinary: ordinary.join('\n') + '\n', deferred: deferred.join('\n') + '\n', entries: deferred.length };
}
