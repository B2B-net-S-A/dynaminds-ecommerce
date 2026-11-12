/** Local staging (tools/staging/refresh.sh, smoke.mjs; docs/staging.md): argument and configuration refusals with
 * their trace, and the smoke against a fake demo — no Docker, no demo, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { smoke, readCredentials } from '../tools/staging/smoke.mjs';

const REFRESH = fileURLToPath(new URL('../tools/staging/refresh.sh', import.meta.url));
const SMOKE = fileURLToPath(new URL('../tools/staging/smoke.mjs', import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), 'staging-refresh-'));
const run = (args, env) => spawnSync('bash', [REFRESH, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

test('refresh.sh parses', () => {
  execFileSync('bash', ['-n', REFRESH]);
});

test('unknown argument: exit 2, no trace', () => {
  const trace = join(tmp(), 'odswiezenie.ok');
  const r = run(['--force'], { STAGING_TRACE: trace });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /nieznany argument --force/);
  assert.equal(existsSync(trace), false);
});

test('dry run with a missing source repository: exit 2, no trace', () => {
  const dir = tmp(), trace = join(dir, 'odswiezenie.ok');
  const r = run(['--dry-run'], { STAGING_TRACE: trace, STAGING_SOURCE_REPO: join(dir, 'missing') });
  assert.equal(r.status, 2);
  assert.equal(existsSync(trace), false);
});

test('real run without the public remote: exit 2 and a failed trace', () => {
  const dir = tmp(), trace = join(dir, 'slady', 'odswiezenie.ok'), repo = join(dir, 'repo');
  execFileSync('git', ['init', '-q', repo]);
  const r = run([], { STAGING_TRACE: trace, STAGING_SOURCE_REPO: repo, STAGING_REMOTE: '' });
  assert.equal(r.status, 2);
  const lines = readFileSync(trace, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const t = JSON.parse(lines[0]);
  assert.equal(t.v, 1);
  assert.equal(t.rutyna, 'odswiezenie');
  assert.equal(t.stan, 'failed');
  assert.equal(t.kod, 2);
  assert.ok(t.powod && t.powod.length > 0);
  assert.match(t.koniec, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
});

const USERS = [
  { key: 'owner', email: 'owner@demo.example', password: 'fake-owner-pass' },
  { key: 'warehouse', email: 'wh@demo.example', password: 'fake-wh-pass' },
];

function fakeDemo({ healthStatus = 200, health = { status: 'ok' } } = {}) {
  const sessions = new Set();
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d)).on('end', () => {
      const json = (code, v, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(v)); };
      const cookie = /dyna_session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
      if (req.method === 'GET' && req.url === '/api/health') return json(healthStatus, health);
      if (req.method === 'POST' && req.url === '/api/auth/login') {
        const { email, password } = JSON.parse(body);
        const u = USERS.find((x) => x.email === email && x.password === password);
        if (!u) return json(401, { error: 'Nieprawidłowy e-mail lub hasło' });
        const s = 's-' + u.key; sessions.add(s);
        return json(200, { user: { email } }, { 'set-cookie': `dyna_session=${s}; Path=/; HttpOnly` });
      }
      if (req.method === 'GET' && req.url === '/api/auth/me') return sessions.has(cookie) ? json(200, { user: {} }) : json(401, {});
      if (req.method === 'POST' && req.url === '/api/auth/logout') { sessions.delete(cookie); return json(200, {}); }
      json(404, {});
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

test('smoke: health and every login green', async () => {
  const { server, base } = await fakeDemo();
  try {
    const r = await smoke(base, USERS);
    assert.deepEqual(r, { ok: true, health: 'ok', logins: { owner: 'ok', warehouse: 'ok' } });
  } finally { server.close(); }
});

test('smoke: a wrong password fails that account only', async () => {
  const { server, base } = await fakeDemo();
  try {
    const r = await smoke(base, [USERS[0], { ...USERS[1], password: 'wrong-password' }]);
    assert.equal(r.ok, false);
    assert.deepEqual(r.logins, { owner: 'ok', warehouse: 'logowanie HTTP 401' });
  } finally { server.close(); }
});

test('smoke: health other than 200/"ok" fails', async () => {
  for (const opts of [{ healthStatus: 503, health: { status: 'degraded' } }, { health: { status: 'starting' } }]) {
    const { server, base } = await fakeDemo(opts);
    try { assert.equal((await smoke(base, USERS)).ok, false); } finally { server.close(); }
  }
});

test('smoke: no answer from the demo fails without throwing', async () => {
  const r = await smoke('http://127.0.0.1:9', USERS, { timeoutMs: 2000 });
  assert.equal(r.ok, false);
  assert.match(r.health, /brak odpowiedzi/);
});

test('smoke CLI prints no e-mail or password, exit 0 / 1', async () => {
  const dir = tmp(), creds = join(dir, 'credentials.json');
  writeFileSync(creds, JSON.stringify({ users: USERS }), { mode: 0o600 });
  const { server, base } = await fakeDemo();
  try {
    // Async spawn: spawnSync would block the event loop the fake server answers on.
    const runCli = (file) => new Promise((resolve) => {
      const p = spawn(process.execPath, [SMOKE, '--base', base, '--credentials', file]);
      let out = '';
      p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
      p.on('close', (status) => resolve({ status, out }));
    });
    const ok = await runCli(creds);
    assert.equal(ok.status, 0, ok.out);
    for (const u of USERS) { assert.ok(!ok.out.includes(u.password)); assert.ok(!ok.out.includes(u.email)); }
    writeFileSync(creds, JSON.stringify({ users: [{ ...USERS[0], password: 'fake-not-this-one' }] }));
    const bad = await runCli(creds);
    assert.equal(bad.status, 1);
    assert.ok(!bad.out.includes('fake-not-this-one'));
  } finally { server.close(); }
});

test('credentials: broken file is refused without quoting it', () => {
  const dir = tmp(), creds = join(dir, 'credentials.json');
  writeFileSync(creds, '{"users":[{"key":"owner","email":"a@b.example","password":"fake-sekret-123"}');
  assert.throws(() => readCredentials(creds), (e) => !e.message.includes('fake-sekret-123'));
  const r = spawnSync(process.execPath, [SMOKE, '--base', 'http://127.0.0.1:9', '--credentials', creds], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.ok(!(r.stdout + r.stderr).includes('fake-sekret-123'));
  writeFileSync(creds, JSON.stringify({ users: [{ key: 'owner', email: 'a@b.example' }] }));
  assert.throws(() => readCredentials(creds), /niepełne konto/);
});

test('smoke CLI: unknown argument and a flag without its value are told apart', () => {
  const cli = (...a) => spawnSync(process.execPath, [SMOKE, ...a], { encoding: 'utf8' });
  const unknown = cli('--host', 'x');
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /nieznany argument --host/);
  const missing = cli('--base', 'http://127.0.0.1:9', '--credentials');
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /brak wartości dla --credentials/);
  const swallowed = cli('--base', '--credentials', 'x.json');
  assert.equal(swallowed.status, 2);
  assert.match(swallowed.stderr, /brak wartości dla --base/);
});
