/** Root-operated focused test, only against an explicitly supplied scratch DB.
 * No migration/business fixture/server stop or transaction retry. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

test('a real terminated idle pool connection logs safely and the next query reconnects', async () => {
  const value = process.env.DATABASE_URL;
  assert(value, 'An explicit owned scratch DATABASE_URL is required');
  const url = new URL(value);
  assert(['postgres:', 'postgresql:'].includes(url.protocol));
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert(/^\/dynaminds_test_[a-zA-Z0-9_]+$/.test(url.pathname), 'Only a scratch test database is allowed');
  assert(process.env.DYNA_LOCAL_CONFIG_PATH, 'An explicit test configuration is required');
  const database = decodeURIComponent(url.pathname.slice(1));
  const observer = new pg.Client({ connectionString: value, connectionTimeoutMillis: 5000 });
  // Load the actual pool only after validating the explicit isolated context.
  const { pool } = await import('../server/db');
  const originalWrite = process.stderr.write.bind(process.stderr);
  const diagnostics: string[] = [];
  let observedErrors = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onIdleError: ((error: Error & { code?: unknown }) => void) | undefined;
  let connected = false;
  const capturedWrite: typeof process.stderr.write = (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ) => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    if (text.startsWith('{"event":"DATABASE_CONNECTION_ERROR",')) {
      diagnostics.push(text);
      const cb = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
      cb?.();
      return true;
    }
    if (typeof encodingOrCallback === 'function') return originalWrite(chunk, encodingOrCallback);
    if (typeof encodingOrCallback === 'string') return originalWrite(chunk, encodingOrCallback, callback);
    return originalWrite(chunk, callback);
  };
  try {
    await observer.connect(); connected = true;
    const watching = (await observer.query('SELECT current_database() db,session_user login,current_user role,pg_backend_pid() pid')).rows[0];
    assert.equal(watching.db, database); assert.equal(watching.role, watching.login);
    const client = await pool.connect();
    const own = await (async () => {
      try {
        const own: { db: string; login: string; role: string; pid: number } =
          (await client.query('SELECT current_database() db,session_user login,current_user role,pg_backend_pid() pid')).rows[0];
        assert.equal(own.db, database); assert.equal(own.login, watching.login); assert.equal(own.role, own.login);
        assert(Number.isSafeInteger(own.pid) && own.pid > 0 && own.pid !== watching.pid, 'Only the exact distinct pool backend is eligible');
        return own;
      } finally { client.release(); }
    })();
    // Prove the PID still belongs to our released connection in this database,
    // before terminating it. Never select an arbitrary ambient backend.
    const activity = (await observer.query(
      'SELECT datname,usename,state,backend_type FROM pg_stat_activity WHERE pid=$1', [own.pid],
    )).rows;
    assert.equal(activity.length, 1);
    assert.deepEqual(activity[0], { datname: database, usename: watching.login, state: 'idle', backend_type: 'client backend' });
    process.stderr.write = capturedWrite;
    const idleError = new Promise<void>((done, fail) => {
      timer = setTimeout(() => fail(new Error('Own idle backend error event was not observed')), 10000);
      onIdleError = error => {
        observedErrors += 1;
        if (error.code !== '57P01') { fail(new Error('Unexpected pool error code; details withheld')); return; }
        clearTimeout(timer); done();
      };
      pool.on('error', onIdleError);
    });
    const [terminated] = await Promise.all([
      observer.query('SELECT pg_terminate_backend($1) terminated', [own.pid]), idleError,
    ]);
    assert.equal(terminated.rows[0].terminated, true, 'The exact own released PID must terminate');
    // One fresh request, with no retry loop or replay of a business transaction.
    const next = await pool.query('SELECT 1 value,current_database() db,session_user login,pg_backend_pid() pid');
    assert.equal(next.rows[0].value, 1); assert.equal(next.rows[0].db, database);
    assert.equal(next.rows[0].login, watching.login);
    assert(Number.isSafeInteger(next.rows[0].pid) && next.rows[0].pid !== own.pid && next.rows[0].pid !== watching.pid);
    assert.equal(observedErrors, 1);
    assert(diagnostics.length === 1 && diagnostics[0] ===
      '{"event":"DATABASE_CONNECTION_ERROR","source":"pool","code":"57P01"}\n',
      'Unexpected pool diagnostic output; contents withheld');
  } finally {
    process.stderr.write = originalWrite;
    if (timer) clearTimeout(timer);
    if (onIdleError) pool.removeListener('error', onIdleError);
    await pool.end();
    if (connected) await observer.end();
  }
});
