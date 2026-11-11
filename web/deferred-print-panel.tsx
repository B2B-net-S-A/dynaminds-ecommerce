import { useEffect, useState, type ReactNode } from 'react';
import { DeferredOrderPanel } from './deferred-order-panel';
import { getPrintJobsMutationState, subscribePrintJobsLock } from './print-jobs';

// Print panels read their options when mounted and that read runs the sealed guard chain (seconds), so screens mount
// them on demand. A kept or unknown print attempt opens the panel, because it is read and resolved in a print panel.
export function DeferredPrintPanel({ contextKey, title, children }: { contextKey: string; title: string; children: ReactNode }) {
  const [locked, setLocked] = useState(() => getPrintJobsMutationState(contextKey).locked);
  useEffect(() => subscribePrintJobsLock(contextKey, setLocked), [contextKey]);
  return <DeferredOrderPanel title={title} openSignal={locked ? contextKey : undefined}>{children}</DeferredOrderPanel>;
}
