import assert from 'node:assert/strict';
import test from 'node:test';
import {startLocalWooReadWorker} from '../server/local-woo-read-worker';

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

test('scheduler waits for real due polling and never overlaps a slow cycle', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let calls = 0, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const worker = startLocalWooReadWorker({cycle: async () => { calls++; await held; return []; }, close: async () => { release(); }});
  assert.equal(calls, 0);
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(calls, 1);
  t.mock.timers.tick(60000);
  assert.equal(calls, 1);
  assert.equal(worker.inspect().busy, true);
  release(); await flush();
  t.mock.timers.tick(999); assert.equal(calls, 1);
  t.mock.timers.tick(1); await flush(); assert.equal(calls, 2);
  await worker.close();
  t.mock.timers.tick(60000); assert.equal(calls, 2);
});

test('close seals claims immediately, drains active work, and shares one close promise', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let release!: () => void, closed = 0, finished = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  const worker = startLocalWooReadWorker({cycle: async () => { await held; finished = true; return []; }, close: async () => { closed++; await held; }});
  t.mock.timers.tick(1000);
  await flush();
  const first = worker.close(), second = worker.close();
  assert.equal(first, second); await flush(); assert.equal(closed, 1);
  assert.equal(worker.inspect().running, false); assert.equal(finished, false);
  release(); await first;
  assert.equal(finished, true);
});

test('outer cycle failure stops polling instead of automatically repeating an uncertain action', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let calls = 0;
  const worker = startLocalWooReadWorker({cycle: async () => { calls++; throw Error('unknown'); }, close: async () => {}});
  t.mock.timers.tick(1000); await flush();
  assert.deepEqual(worker.inspect(), {running: false, busy: false, failed: true});
  t.mock.timers.tick(60000); assert.equal(calls, 1);
  await assert.rejects(worker.close(), /unknown/);
});

test('close before the first tick prevents all work and propagates drain failure', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let calls = 0;
  const worker = startLocalWooReadWorker({cycle: async () => { calls++; return []; }, close: async () => {throw Error('drain failed');}});
  await assert.rejects(worker.close(), /drain failed/);
  t.mock.timers.tick(60000); assert.equal(calls, 0);
});

test('a synchronous cycle refusal clears busy and stops without another timer', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let calls = 0;
  const worker = startLocalWooReadWorker({cycle: () => {calls++; throw Error('closed');}, close: async () => {}});
  t.mock.timers.tick(1000); await flush();
  assert.deepEqual(worker.inspect(), {running: false, busy: false, failed: true});
  t.mock.timers.tick(60000); assert.equal(calls, 1);
  await assert.rejects(worker.close(), /closed/);
});

test('shutdown between timer and queued microtask starts no cycle', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let calls = 0;
  const worker = startLocalWooReadWorker({cycle: async () => {calls++; return [];}, close: async () => {}});
  t.mock.timers.tick(1000);
  await worker.close();
  assert.equal(calls, 0);
  assert.deepEqual(worker.inspect(), {running: false, busy: false, failed: false});
});

test('a falsy primary cycle failure survives a later drain failure', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const worker = startLocalWooReadWorker({cycle: async () => {throw 0;}, close: async () => {throw Error('cleanup');}});
  t.mock.timers.tick(1000); await flush();
  await assert.rejects(worker.close(), error => error === 0);
});
