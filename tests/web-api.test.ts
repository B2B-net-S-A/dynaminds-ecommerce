import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { api, setWorkspace } from '../web/api';

const originalFetch = globalThis.fetch;
const originalWindow = (globalThis as any).window;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWindow === undefined) delete (globalThis as any).window;
  else (globalThis as any).window = originalWindow;
  setWorkspace(null);
});
test('global health capabilities survive login/workspace changes without a tenant header', async () => {
  setWorkspace('before-login');
  let complete!: (r: Response) => void;
  globalThis.fetch = async (_url, init) => {
    assert.equal((init?.headers as Record<string, string>)['X-Workspace-ID'], undefined);
    return new Promise((r) => {
      complete = r;
    });
  };
  const pending = api('/health');
  setWorkspace('after-login');
  complete(Response.json({ workspace_mfa_available: true, restore_preview: true }));
  assert.deepEqual(await pending, { workspace_mfa_available: true, restore_preview: true });
});
test('stale tenant response cannot gate another organization or expose its data', async () => {
  const events: Event[] = [];
  (globalThis as any).window = new EventTarget();
  window.addEventListener('dyna:mfa-required', (e) => events.push(e));
  setWorkspace('first');
  let complete!: (r: Response) => void;
  globalThis.fetch = async (_url, init) => {
    assert.equal((init?.headers as Record<string, string>)['X-Workspace-ID'], 'first');
    return new Promise((r) => {
      complete = r;
    });
  };
  const pending = api('/products');
  setWorkspace('second');
  complete(Response.json({ code: 'MFA_REQUIRED', detail: 'First firm policy' }, { status: 403 }));
  await assert.rejects(pending, /Organizacja została zmieniona/);
  assert.equal(events.length, 0);
});
test('current tenant MFA denial dispatches a scoped gate event and still rejects the operation', async () => {
  (globalThis as any).window = new EventTarget();
  let workspace: string | undefined;
  window.addEventListener('dyna:mfa-required', (e) => {
    workspace = (e as CustomEvent).detail.workspace;
  });
  setWorkspace('protected');
  globalThis.fetch = async () =>
    Response.json({ code: 'MFA_REQUIRED', detail: 'Confirm MFA' }, { status: 403 });
  await assert.rejects(api('/orders'), /Confirm MFA/);
  assert.equal(workspace, 'protected');
});
test('definitive HTTP rejection exposes status; a lost transport response stays distinguishable', async () => {
  globalThis.fetch = async () => Response.json({ detail: 'Preview changed' }, { status: 409 });
  await assert.rejects(
    api('/picking-waves', 'POST', {}),
    (e: any) => e.status === 409 && e.message === 'Preview changed',
  );
  globalThis.fetch = async () => {
    throw new TypeError('Connection lost');
  };
  await assert.rejects(
    api('/picking-waves', 'POST', {}),
    (e: any) => e.status === undefined && e.message === 'Connection lost',
  );
});
