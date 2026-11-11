import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

test('idle database pool errors are handled without exposing error or client details', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'dyna-pool-error-'));
  const config = resolve(dir, 'local.json');
  try {
    await writeFile(config, JSON.stringify({
      dbPassword: 'SYNTHETIC_CONFIG_PASSWORD_DO_NOT_LOG', encryptionKey: 'a'.repeat(64),
    }), { mode: 0o600 });
    // A separate process tests the real module listener without a connection,
    // business fixture or interference with any other suite's shared pool.
    const source = `
      const { pool } = await import(${JSON.stringify(pathToFileURL(resolve('server/db.ts')).href)});
      // Two idle clients: one lost connection is logged once per client (db-connection-errors.ts).
      const client = { password: 'SYNTHETIC_CLIENT_SECRET_DO_NOT_LOG' }, other = { password: 'SYNTHETIC_CLIENT_SECRET_DO_NOT_LOG' };
      const error = Object.assign(new Error('SYNTHETIC_MESSAGE_SECRET_DO_NOT_LOG'), {
        code: '57P01', detail: 'SYNTHETIC_DETAIL_SECRET_DO_NOT_LOG',
        connectionParameters: { password: 'SYNTHETIC_CONNECTION_SECRET_DO_NOT_LOG' }
      });
      pool.emit('error', error, client);
      pool.emit('error', Object.assign(new Error('SYNTHETIC_OTHER_SECRET_DO_NOT_LOG'), {
        code: 'SYNTHETIC_UNKNOWN_SECRET_DO_NOT_LOG'
      }), other);
      await pool.end();
      process.stdout.write('POOL_ERROR_PROCESS_SURVIVED\\n');
    `;
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((done, fail) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
        cwd: process.cwd(),
        env: { ...process.env, DYNA_LOCAL_CONFIG_PATH: config,
          DATABASE_URL: 'postgres://postgres:SYNTHETIC_URL_PASSWORD_DO_NOT_LOG@127.0.0.1:1/dynaminds_test_pool_error' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      const timeout = setTimeout(() => { child.kill(); fail(new Error('Pool error child timed out')); }, 10000);
      child.stdout.on('data', chunk => { stdout += String(chunk); });
      child.stderr.on('data', chunk => { stderr += String(chunk); });
      child.on('error', error => { clearTimeout(timeout); fail(error); });
      child.on('close', code => { clearTimeout(timeout); done({ code, stdout, stderr }); });
    });
    assert.equal(result.code, 0, 'Sanitized idle errors must not terminate the process');
    assert.equal(result.stdout, 'POOL_ERROR_PROCESS_SURVIVED\n');
    // Assert only allowlisted output. A failed assertion must not print stderr
    // containing a regression's credentials or client internals.
    assert(result.stderr ===
      '{"event":"DATABASE_CONNECTION_ERROR","source":"pool","code":"57P01"}\n' +
      '{"event":"DATABASE_CONNECTION_ERROR","source":"pool","code":"UNCLASSIFIED"}\n',
      'Unexpected database pool diagnostics; details withheld');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
