/** Lost PostgreSQL connections must not end the process (dry run -68: the database container restarted and both
 * release CLI processes exited on "Unhandled 'error' event ... Emitted 'error' event on Client instance").
 * No database: real pg Pool/Client objects whose 'error' events are emitted directly, plus a source check
 * that every pg Pool/Client constructed in server/ goes through watchDbPool/watchDbClient. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import pg from 'pg';
import {
  DB_UNAVAILABLE_DETAIL, dbConnectionErrors, isDbConnectionLoss, recordDbConnectionError, watchDbClient, watchDbPool,
} from '../server/db-connection-errors';

const root = join(import.meta.dirname, '..');
const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET', errno: -104, syscall: 'read' });
const terminated = () => new Error('Connection terminated unexpectedly');
const admin = () => Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01', severity: 'FATAL' });

function captureStderr<T>(fn: () => T): { lines: string[]; result: T } {
  const lines: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try { return { lines, result: fn() }; } finally { process.stderr.write = write; }
}

test('a pg Client without a listener throws its error event (the -68 crash); a watched one logs and counts it once', () => {
  const bare = new pg.Client({ connectionString: 'postgres://u:sekret@127.0.0.1:1/x' });
  assert.throws(() => bare.emit('error', reset), (e) => e === reset, 'EventEmitter error without a listener is thrown');

  const before = dbConnectionErrors().total;
  const client = watchDbClient(new pg.Client({ connectionString: 'postgres://u:sekret@127.0.0.1:1/x' }), 'test-lock');
  const { lines } = captureStderr(() => {
    assert.doesNotThrow(() => client.emit('error', reset));
    // pg emits a second error for the same dead socket when it ends.
    assert.doesNotThrow(() => client.emit('error', terminated()));
  });
  assert.equal(dbConnectionErrors().total, before + 1, 'one lost connection is counted once');
  assert.deepEqual(lines.map((l) => JSON.parse(l)), [{ event: 'DATABASE_CONNECTION_ERROR', source: 'test-lock', code: 'ECONNRESET' }]);
  assert(!lines.join('').includes('sekret') && !lines.join('').includes('read ECONNRESET'), 'no message, url or stack');
});

test('a watched Pool handles idle-client errors and errors of checked-out clients (pg-pool removes its listener on checkout)', () => {
  const pool = watchDbPool(new pg.Pool({ connectionString: 'postgres://u:sekret@127.0.0.1:1/x' }), 'test-pool');
  const checkedOut = new pg.Client();
  const idle = new pg.Client();
  const before = dbConnectionErrors();
  const { lines } = captureStderr(() => {
    // 'connect' is what pg-pool emits for every new client; the watch adds a listener that stays for its life.
    pool.emit('connect', checkedOut);
    assert.equal(checkedOut.listenerCount('error'), 1);
    assert.doesNotThrow(() => checkedOut.emit('error', admin()));
    assert.doesNotThrow(() => checkedOut.emit('error', terminated()));
    // An idle client: pg-pool re-emits on the pool with the client; counted once with the client's own listener.
    pool.emit('connect', idle);
    assert.doesNotThrow(() => idle.emit('error', reset));
    assert.doesNotThrow(() => pool.emit('error', reset, idle));
  });
  const after = dbConnectionErrors();
  assert.equal(after.total, before.total + 2);
  assert.equal(after.by_source['test-pool'], (before.by_source['test-pool'] ?? 0) + 2);
  assert.deepEqual(lines.map((l) => JSON.parse(l).code), ['57P01', 'ECONNRESET']);
});

test('connection loss is classified by code or pg wording; statement errors are not', () => {
  for (const e of [reset, admin(), terminated(), Object.assign(new Error('x'), { code: 'ECONNREFUSED' }),
    Object.assign(new Error('the database system is starting up'), { code: '57P03' }),
    new Error('Client has encountered a connection error and is not queryable'), new Error('timeout exceeded when trying to connect')])
    assert.equal(isDbConnectionLoss(e), true, String((e as Error).message));
  for (const e of [Object.assign(new Error('x'), { code: '23505' }), Object.assign(new Error('x'), { code: '57014' }), new Error('Connection terminated'),
    'ECONNRESET', null, undefined, { code: 5 }])
    assert.equal(isDbConnectionLoss(e), false, String(e));
  const { lines } = captureStderr(() => recordDbConnectionError(new Error('weird'), 'uncaught'));
  assert.deepEqual(JSON.parse(lines[0]!), { event: 'DATABASE_CONNECTION_ERROR', source: 'uncaught', code: 'UNCLASSIFIED' });
  assert.match(DB_UNAVAILABLE_DETAIL, /^Baza danych jest chwilowo niedostępna/);
});

/** Every `new pg.Pool(` / `new pg.Client(` (also `pg.default.`) in server/ outside tests, with its file:line. */
function constructions() {
  const out: { at: string; watched: boolean }[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|mjs)$/.test(e.name) && !/\.test\./.test(e.name)) {
        const text = readFileSync(p, 'utf8');
        for (const m of text.matchAll(/new\s+pg(?:\.default)?\.(?:Pool|Client)\s*\(/g)) {
          const line = text.slice(0, m.index).split('\n').length;
          out.push({ at: `${relative(root, p)}:${line}`, watched: /(?:watchDb(?:Pool|Client)|lockDbClient)\(\s*$/.test(text.slice(Math.max(0, m.index! - 40), m.index)) });
        }
      }
    }
  };
  walk(join(root, 'server'));
  return out;
}
/** Startup-only owners in the hash-pinned db.ts: an error there ends startup (the rejected query or Node's
 * uncaught default before listen), which is wanted; they never serve after listen. */
const STARTUP_ONLY = ['server/db.ts'];

test('every pg Pool and Client constructed in server/ is watched (except the two db.ts startup owners)', () => {
  const all = constructions();
  assert(all.length >= 30, 'source scan found the constructions');
  const unwatched = all.filter((c) => !c.watched && !STARTUP_ONLY.includes(c.at.split(':')[0]!));
  assert.deepEqual(unwatched.map((c) => c.at), [], 'wrap the construction: watchDbClient / lockDbClient(new pg.Client(...), source) or watchDbPool(new pg.Pool(...), source)');
  const startup = all.filter((c) => !c.watched && STARTUP_ONLY.includes(c.at.split(':')[0]!));
  assert.equal(startup.length, 2, 'db.ts: only the construction preflight and migrate() owners stay unwatched');
  assert(all.some((c) => c.watched && c.at.startsWith('server/db.ts:')), 'the ordinary pool is watched');
});
