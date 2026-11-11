export const READ_POLL_INTERVAL_MS = 15_000;
export const READ_POLL_BACKOFF_MS = 60_000;

export type ReadPollingEnvironment = {
  now: () => number;
  visible: () => boolean;
  setTimer: (callback: () => void, delay: number) => unknown;
  clearTimer: (timer: unknown) => void;
  subscribeVisibility: (callback: () => void) => () => void;
};

/** A read-only scheduler. Explicit reads share the gate but bypass hidden/cooldown policy. */
export function createReadPolling(
  read: (current: () => boolean) => Promise<void>,
  environment: ReadPollingEnvironment,
  onError: (error: unknown) => void,
) {
  let cancelled = false, started = false;
  let timer: unknown = null, inFlight: Promise<void> | null = null;
  let queuedExplicit: Promise<void> | null = null;
  let blockedUntil = 0;
  let unsubscribe = () => {};
  const current = () => !cancelled;
  function clear() {
    if (timer !== null) environment.clearTimer(timer);
    timer = null;
  }
  function schedule() {
    clear();
    if (cancelled || !started || inFlight || !environment.visible()) return;
    timer = environment.setTimer(() => {
      timer = null;
      if (!cancelled && environment.visible())
        void run(false).catch(error => { if (!cancelled) onError(error); });
    }, Math.max(READ_POLL_INTERVAL_MS, blockedUntil - environment.now()));
  }
  function run(explicit = true): Promise<void> {
    if (cancelled) return Promise.resolve();
    if (inFlight) {
      if (!explicit) return inFlight;
      // A manual post-write refresh must observe a GET started after that write.
      // Coalesce repeated explicit reads into one fresh follow-up, without overlap.
      if (!queuedExplicit) {
        const queued: Promise<void> = inFlight.catch(() => {}).then(() => {
          // This queued read is now running. A later explicit read must queue
          // behind it, and this promise must never clear that newer queue.
          if (queuedExplicit === queued) queuedExplicit = null;
          return run();
        });
        queuedExplicit = queued;
      }
      return queuedExplicit;
    }
    if (!explicit && (!environment.visible() || environment.now() < blockedUntil)) {
      schedule();
      return Promise.resolve();
    }
    clear();
    // Defer invocation so the gate exists even if the task completes synchronously.
    inFlight = Promise.resolve().then(() => {
      if (!cancelled) return read(current);
    }).catch((error: unknown) => {
      if ((error as { status?: unknown } | null)?.status === 429)
        blockedUntil = Math.max(blockedUntil, environment.now() + READ_POLL_BACKOFF_MS);
      throw error;
    }).finally(() => {
      inFlight = null;
      schedule();
    });
    return inFlight;
  }
  return {
    run,
    start() {
      if (started || cancelled) return;
      started = true;
      unsubscribe = environment.subscribeVisibility(schedule);
      // The initial read remains immediate, including an initially hidden tab.
      void run().catch(error => { if (!cancelled) onError(error); });
    },
    cancel() { cancelled = true; clear(); unsubscribe(); },
  };
}

/** Wait for every sibling GET before releasing the polling gate, even on an early 429. */
export async function readTogether<T extends readonly unknown[]>(
  reads: { [K in keyof T]: Promise<T[K]> },
): Promise<T> {
  const results = await Promise.allSettled(reads);
  const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failures.length) throw (failures.find(r => r.reason?.status === 429) ?? failures[0]).reason;
  return results.map(r => (r as PromiseFulfilledResult<unknown>).value) as unknown as T;
}
