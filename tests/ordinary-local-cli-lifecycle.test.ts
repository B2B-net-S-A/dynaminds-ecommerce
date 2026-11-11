import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFileSync, constants} from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
import * as crypto from 'node:crypto';
import {transformSync} from 'esbuild';
import * as rateLimitConfig from '../server/rate-limit-config';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

async function settled(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await Promise.resolve();
  }
  assert.fail('controlled lifecycle boundary was not reached');
}

/** Actual full module/main/selected/parser; only process, filesystem and factory ports are synthetic. */
function model(options: {
  holdSelection?: boolean;
  holdFactory?: boolean;
  holdListen?: boolean;
  holdClose?: boolean;
  factoryFailure?: unknown;
  listenFailure?: unknown;
  closeFailure?: unknown;
  readFailure?: unknown;
  fdCloseFailure?: unknown;
} = {}) {
  const events: string[] = [], output: string[] = [], errors: string[] = [];
  const selectionGate = deferred(), factoryGate = deferred(), listenGate = deferred(), closeGate = deferred();
  const file = '/owned/synthetic-cli-selection.json';
  const configuration = {source_fixture_only: true};
  const bytes = Buffer.from(JSON.stringify(configuration));
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const stats = {
    dev: 1n, ino: 2n, mode: 0o100600n, uid: 501n, nlink: 1n,
    size: BigInt(bytes.length), mtimeNs: 3n, ctimeNs: 4n,
    isFile: () => true, isSymbolicLink: () => false,
  };
  class ControlledProcess extends EventEmitter {
    argv: string[] = [];
    exitCode: number | undefined;
    stdout = Object.assign(new EventEmitter(), {write: (chunk: string) => { output.push(chunk); return true; }});
    stderr = Object.assign(new EventEmitter(), {write: (chunk: string) => { errors.push(chunk); return true; }});
    getuid() { return 501; }
  }
  const processPort = new ControlledProcess();
  const runtime = {
    importer: {available: false},
    app: {listen: async (binding: unknown) => {
      assert.deepEqual(binding, {host: '127.0.0.1', port: 41601});
      events.push('listen');
      if (options.holdListen) await listenGate.promise;
      if (Object.hasOwn(options, 'listenFailure')) throw options.listenFailure;
      events.push('listened');
    }},
    close: async () => {
      events.push('close');
      if (options.holdClose) await closeGate.promise;
      if (Object.hasOwn(options, 'closeFailure')) throw options.closeFailure;
      events.push('closed');
    },
  };
  const filesystem = {
    realpath: async (selected: string) => { assert.equal(selected, file); return file; },
    lstat: async (selected: string) => { assert.equal(selected, file); return stats; },
    open: async (selected: string, flags: number) => {
      assert.equal(selected, file);
      assert.equal(flags, constants.O_RDONLY | constants.O_NOFOLLOW);
      events.push('open');
      return {
        stat: async () => stats,
        readFile: async () => {
          events.push('read');
          if (options.holdSelection) await selectionGate.promise;
          if (Object.hasOwn(options, 'readFailure')) throw options.readFailure;
          return bytes;
        },
        close: async () => {
          events.push('fd.close');
          if (Object.hasOwn(options, 'fdCloseFailure')) throw options.fdCloseFailure;
        },
      };
    },
  };
  const factory = async (input: unknown, settings: unknown) => {
    assert.deepEqual(input, configuration);
    assert.deepEqual(settings, {trustedLocalUiOrigin: 'http://127.0.0.1:41601', scopedAutomationEnabled: false});
    events.push('factory');
    if (options.holdFactory) await factoryGate.promise;
    if (Object.hasOwn(options, 'factoryFailure')) throw options.factoryFailure;
    events.push('factory.done');
    return runtime;
  };
  // No Source replacements: fake argv=[] leaves the real CLI auto-entry guard inactive.
  const source = readFileSync(new URL('../server/ordinary-local-cli.ts', import.meta.url), 'utf8');
  const code = transformSync(source, {loader: 'ts', format: 'cjs', target: 'es2022'}).code;
  const module = {exports: {} as {main: (args: string[]) => Promise<void>}};
  // Real db-connection-errors module bound to the same controlled process (its log line goes to errors).
  const dbErrors = {exports: {} as Record<string, unknown>};
  new Function('module', 'exports', 'require', 'process', transformSync(readFileSync(new URL('../server/db-connection-errors.ts', import.meta.url), 'utf8'),
    {loader: 'ts', format: 'cjs', target: 'es2022'}).code)(dbErrors, dbErrors.exports, () => { throw Error('db-connection-errors imports nothing'); }, processPort);
  const requirePort = (key: string) => {
    if (key === 'node:path') return path;
    if (key === 'node:url') return url;
    if (key === 'node:fs') return {constants};
    if (key === 'node:fs/promises') return filesystem;
    if (key === 'node:crypto') return crypto;
    if (key === 'node:assert/strict') return assert;
    if (key === './ordinary-connector-policy') return {validateOrdinaryConnectorAccess: () => { throw Error('unselected connector must stay inert'); }};
    if (key === './ordinary-local-runtime') return {createOrdinaryLocalApplication: factory};
    if (key === './mirakl-read-postgres') return {MIRAKL_CONTROL_DATABASE:/^dynaminds_connector_state(?:_test_[0-9]{13})?$/};
    // Real parser; it reads this test process's environment (DYNA_RATE_LIMIT_PER_MIN unset = default 600).
    if (key === './rate-limit-config') return rateLimitConfig;
    if (key === './db-connection-errors') return dbErrors.exports;
    throw Error('unexpected import ' + key);
  };
  new Function('module', 'require', 'process', code)(module, requirePort, processPort);
  const counts = (name: string) => events.filter(x => x === name).length;
  const noSignals = () => {
    assert.equal(processPort.listenerCount('SIGINT'), 0);
    assert.equal(processPort.listenerCount('SIGTERM'), 0);
    assert.equal(processPort.stdout.listenerCount('error'), 0);
    assert.equal(processPort.stderr.listenerCount('error'), 0);
    assert.equal(processPort.listenerCount('unhandledRejection'), 0);
    assert.equal(processPort.listenerCount('uncaughtException'), 0);
  };
  assert.deepEqual(events, [], 'import alone performs no FS, factory, listen or signal registration');
  noSignals();
  return {main: module.exports.main, dbErrors: dbErrors.exports as {dbConnectionErrors: () => {total: number}}, args: [file, digest, '41601'], events, output, errors, process: processPort,
    counts, noSignals, selectionGate, factoryGate, listenGate, closeGate};
}

test('actual main remembers SIGTERM during factory, drains once after it finishes, never listens or announces ready', async () => {
  const x = model({holdFactory: true, holdClose: true});
  const work = x.main(x.args);
  await settled(() => x.counts('factory') === 1);
  assert.equal(x.process.listenerCount('SIGTERM'), 1);
  x.process.emit('SIGTERM');
  x.process.emit('SIGTERM');
  assert.equal(x.process.listenerCount('SIGTERM'), 1, 'repeated early SIGTERM remains handled until genuine drain');
  assert.equal(x.counts('close'), 0);
  x.factoryGate.resolve();
  await settled(() => x.counts('close') === 1);
  x.process.emit('SIGTERM');
  x.process.emit('SIGTERM');
  assert.equal(x.process.listenerCount('SIGTERM'), 1, 'a second SIGTERM cannot remove protection while close is pending');
  assert.equal(x.counts('listen'), 0);
  assert.deepEqual(x.output, []);
  let returned = false;
  void work.then(() => { returned = true; });
  await Promise.resolve();
  assert.equal(returned, false, 'main waits the real close promise');
  x.closeGate.resolve();
  await work;
  assert.equal(x.counts('factory.done'), 1);
  assert.equal(x.counts('close'), 1);
  assert.equal(x.counts('fd.close'), 1);
  x.noSignals();
});

test('actual main receives SIGTERM during private selection: closes FD and returns without constructing runtime', async () => {
  const x = model({holdSelection: true});
  const work = x.main(x.args);
  await settled(() => x.counts('read') === 1);
  assert.equal(x.process.listenerCount('SIGTERM'), 1);
  x.process.emit('SIGTERM');
  x.selectionGate.resolve();
  await work;
  assert.equal(x.counts('fd.close'), 1);
  assert.equal(x.counts('factory'), 0);
  assert.equal(x.counts('listen'), 0);
  assert.equal(x.counts('close'), 0);
  assert.deepEqual(x.output, []);
  x.noSignals();
});

test('normal actual main listens once; SIGTERM plus SIGINT share one close and remove both listeners after drain', async () => {
  const x = model({holdClose: true});
  await x.main(x.args);
  assert.equal(x.counts('listen'), 1);
  assert.deepEqual(x.output.map(v => JSON.parse(v).status), ['ORDINARY_LOCAL_APP_LISTENING']);
  assert.equal(x.process.listenerCount('SIGTERM'), 1);
  x.process.emit('SIGTERM');
  x.process.emit('SIGINT');
  assert.equal(x.counts('close'), 1);
  x.closeGate.resolve();
  await settled(() => x.counts('closed') === 1 && x.process.listenerCount('SIGTERM') === 0);
  x.noSignals();
  assert.equal(x.process.exitCode, undefined);
});

test('a listening main logs a late unhandled rejection and keeps serving; startup and stop leave the Node default', async () => {
  const x = model({holdFactory: true, holdClose: true});
  const work = x.main(x.args);
  await settled(() => x.counts('factory') === 1);
  // Before listening a rejection is a startup failure: no guard masks it.
  assert.equal(x.process.listenerCount('unhandledRejection'), 0);
  x.factoryGate.resolve();
  await work;
  assert.equal(x.process.listenerCount('unhandledRejection'), 1);
  const late = Object.assign(new Error('Cannot write headers after they are sent to the client: /api/x?token=sekret'), {code: 'ERR_HTTP_HEADERS_SENT'});
  x.process.emit('unhandledRejection', late, Promise.resolve());
  x.process.emit('unhandledRejection', 'plain text reason', Promise.resolve());
  assert.deepEqual(x.errors.map(v => JSON.parse(v)), [
    {status: 'ORDINARY_LOCAL_UNHANDLED_REJECTION', name: 'Error', code: 'ERR_HTTP_HEADERS_SENT'},
    {status: 'ORDINARY_LOCAL_UNHANDLED_REJECTION', name: 'string'},
  ]);
  assert(!x.errors.join('').includes('sekret'));
  assert.equal(x.process.exitCode, undefined);
  assert.equal(x.counts('close'), 0, 'one late request error does not stop the server');
  x.process.emit('SIGTERM');
  x.closeGate.resolve();
  await settled(() => x.counts('closed') === 1 && x.process.listenerCount('SIGTERM') === 0);
  x.noSignals();
});

test('a listening main keeps serving on a lost database connection nobody listened to; other uncaught errors still end it', async () => {
  const x = model({holdFactory: true, holdClose: true});
  const work = x.main(x.args);
  await settled(() => x.counts('factory') === 1);
  // Before listening an uncaught exception is a startup failure: no guard masks it.
  assert.equal(x.process.listenerCount('uncaughtException'), 0);
  x.factoryGate.resolve();
  await work;
  assert.equal(x.process.listenerCount('uncaughtException'), 1);
  // What dry run -68 died on: pg Client 'error' without a listener (57P01, then the terminated socket).
  const admin = Object.assign(new Error('terminating connection due to administrator command password=sekret'), {code: '57P01'});
  x.process.emit('uncaughtException', admin, 'uncaughtException');
  x.process.emit('uncaughtException', new Error('Connection terminated unexpectedly'), 'uncaughtException');
  x.process.emit('uncaughtException', Object.assign(new Error('read ECONNRESET'), {code: 'ECONNRESET'}), 'uncaughtException');
  assert.deepEqual(x.errors.map(v => JSON.parse(v)), [
    {event: 'DATABASE_CONNECTION_ERROR', source: 'uncaught', code: '57P01'},
    {event: 'DATABASE_CONNECTION_ERROR', source: 'uncaught', code: 'CONNECTION_TERMINATED'},
    {event: 'DATABASE_CONNECTION_ERROR', source: 'uncaught', code: 'ECONNRESET'},
  ]);
  assert.equal(x.dbErrors.dbConnectionErrors().total, 3);
  assert(!x.errors.join('').includes('sekret'));
  assert.equal(x.counts('close'), 0, 'a lost database connection does not stop the server');
  assert.equal(x.process.exitCode, undefined);
  // Anything else is not masked: the listener steps aside and rethrows, so Node ends the process.
  const bug = new TypeError('controlled programming error');
  assert.throws(() => x.process.emit('uncaughtException', bug, 'uncaughtException'), e => e === bug);
  assert.equal(x.process.listenerCount('uncaughtException'), 0);
  x.process.emit('SIGTERM');
  x.closeGate.resolve();
  await settled(() => x.counts('closed') === 1 && x.process.listenerCount('SIGTERM') === 0);
  x.noSignals();
});

test('factory rejects after an early stop: actual main preserves error identity and removes handlers without fake close/listen', async () => {
  for (const first of [Object.assign(new Error('controlled factory'), {code: 'FACTORY_TEST'}), 0]) {
    const x = model({holdFactory: true, factoryFailure: first});
    const work = x.main(x.args);
    const rejected = assert.rejects(work, e => e === first);
    await settled(() => x.counts('factory') === 1);
    x.process.emit('SIGTERM');
    x.factoryGate.resolve();
    await rejected;
    assert.equal(x.counts('close'), 0);
    assert.equal(x.counts('listen'), 0);
    assert.deepEqual(x.output, []);
    x.noSignals();
  }
});

test('listen failure plus cleanup failure retains the original listen error and attempts close once', async () => {
  const first = Object.assign(new Error('controlled listen'), {code: 'LISTEN_TEST'});
  const x = model({listenFailure: first, closeFailure: new Error('secondary cleanup')});
  await assert.rejects(x.main(x.args), e => e === first);
  assert.equal(x.counts('factory.done'), 1);
  assert.equal(x.counts('listen'), 1);
  assert.equal(x.counts('close'), 1);
  assert.deepEqual(x.output, []);
  x.noSignals();
});

test('normal signal close failure sets exitCode1, drains once and removes all handlers', async () => {
  const x = model({closeFailure: new Error('controlled close')});
  await x.main(x.args);
  x.process.emit('SIGTERM');
  x.process.emit('SIGINT');
  await settled(() => x.process.exitCode === 1);
  assert.equal(x.counts('close'), 1);
  x.noSignals();
});

test('signal during awaited listen suppresses LISTENING and uses the same close promise', async () => {
  const x = model({holdListen: true, holdClose: true});
  const work = x.main(x.args);
  await settled(() => x.counts('listen') === 1);
  x.process.emit('SIGTERM');
  assert.equal(x.counts('close'), 1);
  x.listenGate.resolve();
  await Promise.resolve();
  assert.deepEqual(x.output, []);
  x.closeGate.resolve();
  await work;
  assert.equal(x.counts('close'), 1);
  x.noSignals();
});

test('private selection IO failure preserves primary through FD-close failure and never calls factory', async () => {
  const first = Object.assign(new Error('controlled read'), {code: 'EIO'});
  const x = model({readFailure: first, fdCloseFailure: new Error('secondary fd close')});
  await assert.rejects(x.main(x.args), e => e === first);
  assert.equal(x.counts('fd.close'), 1);
  assert.equal(x.counts('factory'), 0);
  assert.deepEqual(x.output, []);
  x.noSignals();
});

test('invalid actual CLI arguments refuse before IO, signals or factory', async () => {
  const x = model();
  await assert.rejects(x.main([...x.args, '--unknown']));
  assert.deepEqual(x.events, []);
  x.noSignals();
});

test('stdout EPIPE after ready closes once and handles repeated output errors while close is pending', async () => {
  const x = model({holdClose: true});
  await x.main(x.args);
  const first = Object.assign(new Error('controlled stdout'), {code: 'EPIPE'});
  assert.doesNotThrow(() => x.process.stdout.emit('error', first));
  assert.equal(x.process.exitCode, 1);
  assert.equal(x.counts('close'), 1);
  assert.doesNotThrow(() => x.process.stderr.emit('error', Object.assign(new Error('secondary output'), {code: 'EPIPE'})));
  x.process.emit('SIGTERM');
  assert.equal(x.counts('close'), 1);
  assert.equal(x.process.stdout.listenerCount('error'), 1);
  x.closeGate.resolve();
  await settled(() => x.counts('closed') === 1 && x.process.stdout.listenerCount('error') === 0);
  assert.equal(x.counts('close'), 1);
  x.noSignals();
});

test('stdout EPIPE during factory is remembered, drains returned runtime and preserves primary error', async () => {
  const x = model({holdFactory: true, holdClose: true, closeFailure: new Error('secondary close')});
  const first = Object.assign(new Error('controlled stdout before factory returns'), {code: 'EPIPE'});
  const work = x.main(x.args);
  const rejected = assert.rejects(work, e => e === first);
  await settled(() => x.counts('factory') === 1);
  assert.doesNotThrow(() => x.process.stdout.emit('error', first));
  assert.equal(x.process.exitCode, 1);
  assert.equal(x.counts('close'), 0);
  x.factoryGate.resolve();
  await settled(() => x.counts('close') === 1);
  assert.doesNotThrow(() => x.process.stdout.emit('error', new Error('secondary output during close')));
  x.closeGate.resolve();
  await rejected;
  assert.equal(x.counts('close'), 1);
  assert.equal(x.counts('listen'), 0);
  assert.deepEqual(x.output, []);
  x.noSignals();
});
