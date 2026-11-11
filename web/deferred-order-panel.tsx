import { useEffect, useRef, useState, type ReactNode } from 'react';

/** Defer secondary reads until opened. Keep a started panel mounted so closing
 * its disclosure cannot discard a draft, pending write or native read guard. */
export function DeferredOrderPanel({ title, children, openSignal }: { title: string; children: ReactNode; openSignal?: unknown }) {
  const [started, setStarted] = useState(false);
  const details = useRef<HTMLDetailsElement>(null);
  // A new explicit routing/recovery signal opens once; ordinary refreshes and
  // manual collapse keep their state until the signal changes again.
  useEffect(() => {
    if (openSignal !== undefined) {
      setStarted(true);
      if (details.current) details.current.open = true;
    }
  }, [openSignal]);
  return (
    <details ref={details} className="panel ops-panel" onToggle={event => {
      if (event.currentTarget.open) setStarted(true);
    }}>
      <summary>{title}</summary>
      {started ? children : null}
    </details>
  );
}
