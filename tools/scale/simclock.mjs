// Simulated clock for --simulate-days. The dedicated Docker PostgreSQL (tools/scale/docker) preloads
// libfaketime, which reads a relative offset ("-15552000" = seconds) from a bind-mounted file; every
// server process re-reads it at most once per second (FAKETIME_CACHE_DURATION=1). The generator
// writes the same offset to that file and to this process' Date, so now()/clock_timestamp() in the
// database and Date.now() in the application code agree on the simulated day. Monotonic clocks
// (performance.now, timers, PostgreSQL latches) stay real.
import { mkdirSync, renameSync, writeFileSync, readFileSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { hostname } from 'node:os';

export const DAY_MS = 86_400_000;
const RealDate = globalThis.Date;
export const realNow = () => RealDate.now();
export const realIso = () => new RealDate(RealDate.now()).toISOString();

/** Simulated day k of the plan window: [start + k days, start + k+1 days); orders of day k use that day. */
export function dayWindow(p, k) {
  const start = Date.parse(p.asOf) - p.days * DAY_MS;
  return { from: start + k * DAY_MS, to: start + (k + 1) * DAY_MS };
}
/** Day index of an ISO instant inside the plan window (clamped to [0, days-1]). */
export function dayOf(p, iso) {
  const start = Date.parse(p.asOf) - p.days * DAY_MS;
  return Math.min(p.days - 1, Math.max(0, Math.floor((Date.parse(iso) - start) / DAY_MS)));
}
/** Contiguous [from, to) order-index ranges per day; orders are planned with growing placed_at. */
export function dayRanges(p, t, placedAt) {
  const n = p.perTenant[t].orders, out = Array.from({ length: p.days }, () => [n, n]);
  let j = 0;
  for (let k = 0; k < p.days; k++) {
    const from = j;
    while (j < n && dayOf(p, placedAt(j)) === k) j++;
    out[k] = [from, j];
  }
  if (j !== n) throw new Error('placed_at nie rośnie z indeksem zamówienia');
  return out;
}

/** Offset in whole seconds that makes "real now" read as `targetMs`. */
export const offsetSeconds = (targetMs, now = realNow()) => Math.round((targetMs - now) / 1000);
export const formatOffset = (s) => (s < 0 ? '-' : '+') + Math.abs(s);
export function parseOffset(text) {
  const m = /^\s*([+-])(\d+)\s*$/.exec(text);
  if (!m) throw new Error('Nieznany format przesunięcia czasu: ' + JSON.stringify(text));
  return (m[1] === '-' ? -1 : 1) * Number(m[2]);
}
export function readOffsetFile(path) { return parseOffset(readFileSync(path, 'utf8')); }
export function writeOffsetFile(path, seconds) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, formatOffset(seconds) + '\n', { mode: 0o644 });
  renameSync(tmp, path);
}

/** The offset file moves the clock of the whole instance: one simulating generator at a time. */
// The lock holds "<hostname> <pid>". A pid is only meaningful on the host that wrote it: the generator in a
// container (scale-pg.sh netns-node: the server container's hostname, fixed name, one such container at a time) gets the same
// low pid after every restart, so a lock with our own hostname and pid is a leftover of a killed run.
export function acquireClockLock(file) {
  const lock = file + '.lock', host = hostname();
  for (let k = 0; k < 2; k++) {
    try { const fd = openSync(lock, 'wx', 0o600); writeFileSync(fd, `${host} ${process.pid}`); closeSync(fd); return () => { try { unlinkSync(lock); } catch {} }; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const [a, b] = readFileSync(lock, 'utf8').trim().split(' '), owner = b === undefined ? host : a, pid = Number(b ?? a);
      if (owner !== host) throw new Error(`Zegar instancji zajął proces ${pid} na ${owner} (${lock}); jeśli ten bieg nie żyje, usuń plik blokady`);
      let alive = false;
      if (pid !== process.pid) try { process.kill(pid, 0); alive = true; } catch (err) { alive = err.code === 'EPERM'; }
      if (alive) throw new Error(`Zegar instancji jest używany przez proces ${pid} (${lock})`);
      unlinkSync(lock); // stale lock of a dead process
    }
  }
  throw new Error('Nie udało się zająć ' + lock);
}

let offsetMs = 0;
/** Replace the global Date once; later calls only move the offset. Arguments to new Date(x) are untouched. */
export function installNodeClock() {
  if (globalThis.Date !== RealDate) return;
  class SimDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(RealDate.now() + offsetMs); else super(...args); }
    static now() { return RealDate.now() + offsetMs; }
  }
  globalThis.Date = SimDate;
}
export function setNodeOffset(seconds) { offsetMs = seconds * 1000; }
export const nodeOffsetSeconds = () => offsetMs / 1000;

/**
 * Move both clocks to `targetMs` and wait until a fresh database session reports it.
 * Call only at a barrier: no statement in flight (PostgreSQL timeouts are scheduled on the wall clock).
 */
export async function setSimulatedTime({ file, targetMs, probe, toleranceMs = 5000, timeoutMs = 30000 }) {
  const s = offsetSeconds(targetMs);
  writeOffsetFile(file, s);
  setNodeOffset(s);
  const until = realNow() + timeoutMs;
  for (;;) {
    await new Promise((r) => setTimeout(r, 1200));
    const dbMs = await probe();
    const expected = realNow() + s * 1000;
    if (Math.abs(dbMs - expected) <= toleranceMs) return { offset_seconds: s, db_now: new RealDate(dbMs).toISOString(), node_now: new Date().toISOString() };
    if (realNow() > until) throw new Error(`Zegar bazy nie podążył za plikiem ${file}: baza ${new RealDate(dbMs).toISOString()}, oczekiwano ${new RealDate(expected).toISOString()}`);
  }
}
