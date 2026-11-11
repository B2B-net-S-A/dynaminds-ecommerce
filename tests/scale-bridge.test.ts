import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import path from 'node:path';

// Bridge fed through --stdin; a physical serial device and stty are not exercised here.
function get(port: number, headers: Record<string, string> = {}, method = 'GET', url = '/reading') {
  return new Promise<{ status: number; headers: Record<string, unknown>; body: any }>((ok, fail) => {
    const req = request({ host: '127.0.0.1', port, path: url, method, headers }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => ok({ status: res.statusCode!, headers: res.headers, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', fail);
    req.end();
  });
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('scale bridge serves the latest stable reading on loopback with an origin allowlist', async (t) => {
  const child = spawn(
    process.execPath,
    [path.resolve('node_modules/tsx/dist/cli.mjs'), 'scripts/scale-bridge.ts', '--stdin', '--port', '0',
      '--allow-origin', 'http://127.0.0.1:5173'],
    { stdio: ['pipe', 'pipe', 'inherit'] },
  );
  t.after(() => child.kill('SIGTERM'));
  const port = await new Promise<number>((ok, fail) => {
    let out = '';
    child.stdout.on('data', (c) => {
      out += c;
      const line = out.split('\n').find((l) => l.includes('SCALE_BRIDGE_LISTENING'));
      if (line) ok(JSON.parse(line).port);
    });
    child.once('exit', () => fail(new Error('bridge exited')));
  });

  assert.equal((await get(port)).body.status, 'no_data');

  child.stdin.write('US,GS,+  1.200kg\r\n');
  await pause(100);
  assert.equal((await get(port)).body.status, 'unstable');

  child.stdin.write('ST,GS,+  1.2');
  child.stdin.write('34kg\r\n');
  await pause(100);
  const ok = await get(port, { Origin: 'http://127.0.0.1:5173' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'stable');
  assert.equal(ok.body.grams, 1234);
  assert.equal(ok.headers['access-control-allow-origin'], 'http://127.0.0.1:5173');
  assert.equal(ok.headers['cache-control'], 'no-store');

  child.stdin.write('   500 g\r\n   500 g\r\n');
  await pause(100);
  assert.equal((await get(port)).body.status, 'unstable', 'unflagged frames need three repeats');
  child.stdin.write('   500 g\r\n');
  await pause(100);
  assert.deepEqual([(await get(port)).body.status, (await get(port)).body.grams], ['stable', 500]);

  child.stdin.write('OL,GS,+9999.999kg\r\n');
  await pause(100);
  assert.equal((await get(port)).body.status, 'overload');
  child.stdin.write('ST,GS,-  0.120kg\r\n');
  await pause(100);
  assert.equal((await get(port)).body.status, 'negative');

  const foreign = await get(port, { Origin: 'https://evil.example' });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.headers['access-control-allow-origin'], undefined);
  assert.equal((await get(port, { Host: 'scale.evil.example:' + port })).status, 421);
  assert.equal((await get(port, {}, 'POST')).status, 405);
  assert.equal((await get(port, {}, 'GET', '/other')).status, 404);
  const preflight = await get(
    port,
    { Origin: 'http://127.0.0.1:5173', 'Access-Control-Request-Private-Network': 'true' },
    'OPTIONS',
  );
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-private-network'], 'true');

  await pause(2100);
  assert.equal((await get(port)).body.status, 'stale', 'no frames for 2 s is not a current reading');
});

test('scale bridge refuses unsafe arguments', async () => {
  for (const args of [[], ['--stdin', '--baud', '115201'], ['--stdin', '--command', 'X'], ['--stdin', '--frame', '9Z9']]) {
    const code = await new Promise<number | null>((ok) => {
      const child = spawn(process.execPath, [path.resolve('node_modules/tsx/dist/cli.mjs'), 'scripts/scale-bridge.ts', ...args], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      child.once('exit', ok);
    });
    assert.equal(code, 2, args.join(' '));
  }
});
