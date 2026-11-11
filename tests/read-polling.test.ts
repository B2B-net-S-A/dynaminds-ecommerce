import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadPolling, readTogether, type ReadPollingEnvironment } from '../web/read-polling';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function clock() {
  let now = 0, visible = true, next = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const listeners = new Set<() => void>();
  const environment: ReadPollingEnvironment = {
    now: () => now,
    visible: () => visible,
    setTimer(callback, delay) { const id = ++next; timers.set(id, { at: now + delay, callback }); return id; },
    clearTimer(id) { timers.delete(id as number); },
    subscribeVisibility(callback) { listeners.add(callback); return () => { listeners.delete(callback); }; },
  };
  return {
    environment,
    timers, listeners,
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at; timers.delete(due[0]); due[1].callback(); await settle();
      }
      now = end; await settle();
    },
    async visible(value: boolean) { visible = value; for (const notify of listeners) notify(); await settle(); },
  };
}

test('initial read stays immediate; hidden tabs pause and scheduled/manual reads never overlap', async () => {
  const time = clock(), requests: { promise: Promise<void>; resolve: (value: void) => void }[] = [];
  await time.visible(false);
  const errors: unknown[] = [];
  const polling = createReadPolling(async () => {
    const request = deferred(); requests.push(request); await request.promise;
  }, time.environment, error => errors.push(error));
  polling.start(); await settle();
  assert.equal(requests.length, 1, 'initial read still runs in an initially hidden tab');
  requests[0].resolve(); await settle();
  await time.advance(120_000); assert.equal(requests.length, 1);
  await time.visible(true);
  await time.advance(14_999); assert.equal(requests.length, 1);
  await time.advance(1); assert.equal(requests.length, 2);
  const explicit = polling.run();
  assert.equal(polling.run(), explicit, 'repeated manual reads coalesce into one fresh follow-up');
  await time.advance(90_000); assert.equal(requests.length, 2, 'slow GET outlives multiple polling intervals');
  requests[1].resolve(); await settle();
  assert.equal(requests.length, 3, 'manual refresh starts after the older GET settles');
  await time.advance(90_000); assert.equal(requests.length, 3);
  requests[2].resolve(); await explicit;
  await time.advance(15_000); assert.equal(requests.length, 4);
  polling.cancel(); requests[3].resolve(); await settle();
  assert.deepEqual(errors, []);
});

test('429 waits at least sixty seconds and visibility changes cannot bypass cooldown', async () => {
  const time = clock(); let calls = 0;
  const errors: unknown[] = [];
  const polling = createReadPolling(async () => {
    calls++; if (calls === 1) throw { status: 429 };
  }, time.environment, error => errors.push(error));
  polling.start(); await settle();
  assert.equal(errors.length, 1);
  await time.advance(30_000); await time.visible(false); await time.visible(true);
  await time.advance(29_999); assert.equal(calls, 1);
  await time.advance(1); assert.equal(calls, 2);
  await time.advance(14_999); assert.equal(calls, 2);
  await time.advance(1); assert.equal(calls, 3);
  polling.cancel();
});

test('a second manual refresh during the first follow-up waits for a newer GET', async () => {
  const time = clock(), requests: { promise: Promise<void>; resolve: (value: void) => void }[] = [];
  const polling = createReadPolling(async () => {
    const request = deferred(); requests.push(request); await request.promise;
  }, time.environment, error => assert.fail(String(error)));
  polling.start(); await settle(); // held A
  let firstDone = false, secondDone = false;
  const first = polling.run().then(() => { firstDone = true; }); // queues B
  requests[0].resolve(); await settle();
  assert.equal(requests.length, 2); // B has started before the second write/refresh
  const secondQueued = polling.run(); // must queue C, not return B
  const second = secondQueued.then(() => { secondDone = true; });
  assert.equal(polling.run(), secondQueued, 'another refresh while B runs coalesces into C');
  await time.advance(90_000); assert.equal(requests.length, 2);
  assert.equal(firstDone, false); assert.equal(secondDone, false);
  requests[1].resolve(); await first; await settle();
  assert.equal(requests.length, 3); assert.equal(firstDone, true); assert.equal(secondDone, false);
  assert.equal(polling.run() === secondQueued, false, 'finished queue B cannot retain or clear queue C');
  // This last explicit call queued D while C runs. Cancelling must suppress D.
  polling.cancel(); requests[2].resolve(); await second; await settle();
  assert.equal(secondDone, true); assert.equal(requests.length, 3);
});

test('explicit user read works during cooldown and hidden state without scheduling hidden retries', async () => {
  const time = clock(); let calls = 0;
  const polling = createReadPolling(async () => {
    calls++; if (calls === 1) throw { status: 429 };
  }, time.environment, () => {});
  polling.start(); await settle(); await time.visible(false);
  await polling.run(); assert.equal(calls, 2);
  await time.advance(120_000); assert.equal(calls, 2);
  polling.cancel();
});

test('cancel invalidates an in-flight result and removes timers and visibility listener', async () => {
  const time = clock(), request = deferred(); let published = 0, calls = 0;
  const polling = createReadPolling(async current => {
    calls++; await request.promise; if (current()) published++;
  }, time.environment, () => assert.fail('cancelled read must not report an error'));
  polling.start(); await settle(); polling.cancel();
  request.resolve(); await settle();
  assert.equal(published, 0); assert.equal(time.timers.size, 0); assert.equal(time.listeners.size, 0);
  await time.advance(120_000); await time.visible(false); await time.visible(true);
  await polling.run(); assert.equal(calls, 1);
});

test('early 429 in parallel GETs retains gate until every sibling settles', async () => {
  const time = clock(), sibling = deferred<string>(); let calls = 0, errors = 0;
  const polling = createReadPolling(async () => {
    calls++; await readTogether([Promise.reject({ status: 429 }), sibling.promise]);
  }, time.environment, () => { errors++; });
  polling.start(); await settle();
  await time.advance(120_000); assert.equal(calls, 1);
  assert.equal(errors, 0, 'the sibling is still owned by the unfinished read');
  sibling.resolve('finished'); await settle(); assert.equal(errors, 1);
  await time.advance(59_999); assert.equal(calls, 1);
  polling.cancel();
});

test('cancellation suppresses a late rejection and a replacement controller runs independently', async () => {
  const time = clock(), old = deferred(); let errors = 0, fresh = 0;
  const polling = createReadPolling(async () => old.promise, time.environment, () => { errors++; });
  polling.start(); await settle(); polling.cancel();
  const replacement = createReadPolling(async () => { fresh++; }, time.environment, () => { errors++; });
  replacement.start(); await settle(); old.reject({ status: 429 }); await settle();
  assert.equal(errors, 0); assert.equal(fresh, 1);
  await time.advance(15_000); assert.equal(fresh, 2);
  replacement.cancel();
});
