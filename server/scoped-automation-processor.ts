/** Who may start the scoped rule processor (server/scoped-automation-worker.ts) in this process.
 * INSTALLATION: --scoped-automation started it for every workspace at listen; the panel only reads it.
 * WORKSPACE: ordinary runtime without global workers; a workspace admin starts or stops it for
 *   that workspace only. RAM-only: a restart stops it, and rules still need their own opt-in.
 * UNAVAILABLE: read-only copy, or a process whose global loop already processes automation jobs. */
export type ScopedProcessorMode = 'INSTALLATION' | 'WORKSPACE' | 'UNAVAILABLE';
type Loop = { close(): Promise<void> };
export interface ScopedProcessorControl {
  readonly mode: ScopedProcessorMode;
  running(tenant: string): boolean;
  start(tenant: string): Promise<void>;
  stop(tenant: string): Promise<void>;
  /** INSTALLATION only: the onListen start for all workspaces. */
  startInstallation(): void;
  close(): Promise<void>;
}
export function createScopedProcessorControl(
  mode: ScopedProcessorMode,
  launch: (tenants?: () => readonly string[]) => Loop,
): ScopedProcessorControl {
  const tenants = new Set<string>();
  let loop: Loop | undefined,
    queue: Promise<void> = Promise.resolve();
  // One start/stop at a time: a stop drains the loop before a later start creates a new one.
  const serial = (fn: () => Promise<void>) => (queue = queue.then(fn, fn));
  return {
    mode,
    // INSTALLATION keeps the earlier contract: available from construction, running once the app listens.
    running: (tenant) => mode === 'INSTALLATION' || (mode === 'WORKSPACE' && !!loop && tenants.has(tenant)),
    start: (tenant) =>
      serial(async () => {
        if (mode !== 'WORKSPACE') throw new Error('scoped-processor-not-workspace-controlled');
        tenants.add(tenant);
        loop ??= launch(() => [...tenants]);
      }),
    stop: (tenant) =>
      serial(async () => {
        if (mode !== 'WORKSPACE') throw new Error('scoped-processor-not-workspace-controlled');
        tenants.delete(tenant);
        if (!tenants.size && loop) {
          const l = loop;
          loop = undefined;
          await l.close();
        }
      }),
    startInstallation() {
      if (mode !== 'INSTALLATION' || loop) return;
      loop = launch();
    },
    close: () =>
      serial(async () => {
        tenants.clear();
        const l = loop;
        loop = undefined;
        await l?.close();
      }),
  };
}
