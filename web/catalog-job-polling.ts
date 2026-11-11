/** Owned read scheduler: one request at a time, polling only native queued drafts. */
export function hasQueuedCatalogJob(value: any): boolean {
  return Array.isArray(value?.data) && value.data.some((draft: any) => draft?.state === 'queued');
}
export function createCatalogJobReader<T>(options: {
  read: (signal: AbortSignal) => Promise<T>;
  accept: (value: T) => void;
  error: (error: unknown) => void;
  queued: (value: T) => boolean;
  schedule?: (fn: () => void, delay: number) => unknown;
  cancel?: (timer: unknown) => void;
}) {
  const schedule = options.schedule ?? ((fn, delay) => setTimeout(fn, delay));
  const cancel = options.cancel ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let alive = true, controller: AbortController | undefined, timer: unknown;
  let waiting: Array<(value: T | undefined) => void> = [];
  function clearTimer() { if (timer !== undefined) cancel(timer); timer = undefined; }
  async function run() {
    if (!alive || controller) return;
    clearTimer();
    const listeners = waiting; waiting = [];
    const own = new AbortController(); controller = own;
    let result: T | undefined, queued = false;
    try {
      const value = await options.read(own.signal);
      if (alive && !own.signal.aborted) {
        result = value; options.accept(value); queued = options.queued(value);
      }
    } catch (error) {
      if (alive && !own.signal.aborted) options.error(error);
    } finally {
      controller = undefined;
      for (const resolve of listeners) resolve(result);
      if (!alive) return;
      if (waiting.length) void run();
      else if (queued) timer = schedule(() => { timer = undefined; void refresh(); }, 2000);
    }
  }
  function refresh(): Promise<T | undefined> {
    if (!alive) return Promise.resolve(undefined);
    clearTimer();
    const promise = new Promise<T | undefined>((resolve) => waiting.push(resolve));
    void run();
    return promise;
  }
  return {
    refresh,
    dispose() {
      alive = false; clearTimer(); controller?.abort();
      for (const resolve of waiting) resolve(undefined);
      waiting = [];
    },
  };
}
