type Lane = {cycle:()=>Promise<unknown>;close:()=>Promise<void>};

/** One serial loop for the construction-selected local stores. No job reclaim. */
export function startLocalWooReadWorker(lane: Lane) {
  let closing = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> | undefined;
  let failure = false;
  let firstError: unknown;
  let closePromise: Promise<void> | undefined;

  function schedule() {
    if (closing || failure) return;
    timer = setTimeout(run, 1000);
    timer.unref();
  }

  function run() {
    timer = undefined;
    if (closing || failure) return;
    active = Promise.resolve().then(async () => {
      if (closing) { active = undefined; return; }
      try {
        await lane.cycle();
      } catch (error) {
        // A failed outer cycle cannot be silently restarted. Lane-level uncertain
        // outcomes already remain durable and appear in the normal history.
        failure = true;
        firstError = error;
      } finally {
        active = undefined;
        schedule();
      }
    });
  }

  schedule();
  return Object.freeze({
    inspect: () => ({running: !closing && !failure, busy: !!active, failed: failure}),
    close() {
      return closePromise ??= (async () => {
        closing = true;
        if (timer) clearTimeout(timer);
        timer = undefined;
        // close() seals claims immediately, then drains the same in-flight cycle.
        let drainFailed = false;
        let drainError: unknown;
        let drainWork: Promise<void>;
        try { drainWork = lane.close(); }
        catch (error) { drainFailed = true; drainError = error; drainWork = Promise.resolve(); }
        const drained = drainWork.catch(error => {
          drainFailed = true;
          drainError = error;
        });
        await Promise.all([active, drained]);
        if (failure) throw firstError;
        if (drainFailed) throw drainError;
      })();
    },
  });
}
