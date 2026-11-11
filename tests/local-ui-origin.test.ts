// Source-authored only. Root executes in the existing fresh numeric PG runner.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { pool } from '../server/db';
import { validateTrustedLocalUiOrigin } from '../server/local-ui-origin';
import { bootstrap151169 } from './catalog-stock-control169-fixture';
import { seed } from './fixtures';

assert.equal(process.env.DYNA_TEST, 'true');
const trusted = 'http://qa169.localhost:5169';
let app: Awaited<ReturnType<typeof buildApp>>;
let defaults: Awaited<ReturnType<typeof buildApp>>;
let providers = 0;
let address = 1;
const nextAddress = () => '127.169.0.' + address++;
before(async () => {
  await bootstrap151169(); await seed();
  const transport = async () => { providers++; throw Error('No providers in local origin tests'); };
  app = await buildApp({ trustedLocalUiOrigin: trusted, integrationTransport: transport });
  defaults = await buildApp({ integrationTransport: transport });
});
after(async () => {
  try { await app?.close(); await defaults?.close(); assert.equal(providers, 0); }
  finally { await pool.end(); }
});

test('trusted local origins require exact canonical loopback host and explicit port', () => {
  for (const origin of [trusted, 'https://qa169.localhost:5169', 'http://localhost:5169',
    'http://a.b.localhost:5169', 'http://127.0.0.1:5169', 'http://[::1]:5169'])
    assert.equal(validateTrustedLocalUiOrigin(origin), origin);
  for (const origin of ['null', '*', 'https://example.com:5169', 'http://localhost.evil:5169',
    'http://evil-localhost:5169', 'http://-qa.localhost:5169', 'http://localhost.:5169',
    'http://127.0.0.2:5169', 'http://127.1:5169', 'http://[::2]:5169',
    'ftp://localhost:5169', 'http://localhost', 'http://localhost:80', 'https://localhost:443',
    'http://localhost:0', 'http://localhost:65536',
    'http://localhost:05169', 'http://LOCALHOST:5169', ' http://localhost:5169',
    'http://localhost:5169/', 'http://localhost:5169/path', 'http://localhost:5169?x=1',
    'http://localhost:5169#x', 'http://user@localhost:5169', 'http://user:pass@localhost:5169'])
    assert.throws(() => validateTrustedLocalUiOrigin(origin), TypeError, origin);
});

test('invalid construction options are rejected before app initialization', async () => {
  for (const origin of ['https://external.example:5169', 'null', 'http://localhost:5169/path'])
    await assert.rejects(buildApp({ trustedLocalUiOrigin: origin }), TypeError);
});

test('exact configured origin permits real signup and login without rewriting Origin', async () => {
  const email = 'origin-' + randomUUID() + '@example.invalid', password = 'OriginQA!2026-' + randomUUID();
  const signup = await app.inject({ method: 'POST', url: '/api/auth/signup', remoteAddress: nextAddress(), headers: { origin: trusted },
    payload: { email, password, name: 'Local UI origin QA',
      organization: { name: 'Local origin QA', currency: 'PLN', locale: 'pl-PL' } } });
  assert.equal(signup.statusCode, 201, signup.body);
  assert(signup.headers['set-cookie']);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: nextAddress(), headers: { origin: trusted },
    payload: { email, password } });
  assert.equal(login.statusCode, 200, login.body);
  assert.equal(login.json().user.id, signup.json().user.id);
});

test('other hosts, ports and opaque null origin remain denied on login and signup', async () => {
  for (const origin of ['http://other.localhost:5169', 'http://qa169.localhost:5170',
    'http://localhost:5169', 'https://qa169.localhost:5169', 'http://external.example:5169', 'null']) {
    for (const url of ['/api/auth/login', '/api/auth/signup']) {
      const reply = await app.inject({ method: 'POST', url, remoteAddress: nextAddress(), headers: { origin }, payload: {} });
      assert.equal(reply.statusCode, 403, origin + ' ' + url);
      assert.equal(reply.json().detail, 'Niedozwolone pochodzenie żądania');
    }
  }
});

test('default origins remain allowed and trusted option does not change default construction', async () => {
  for (const instance of [app, defaults]) {
    for (const origin of ['http://localhost:5173', 'http://127.0.0.1:5173',
      'http://localhost:4100', 'http://127.0.0.1:4100']) {
      const reply = await instance.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: nextAddress(), headers: { origin }, payload: {} });
      assert.equal(reply.statusCode, 422, origin + ': auth schema reached');
    }
  }
  assert.equal((await defaults.inject({ method: 'POST', url: '/api/auth/login',
    remoteAddress: nextAddress(), headers: { origin: trusted }, payload: {} })).statusCode, 403);
});
