import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app';
import { pool, migrate } from '../server/db';
import { seed, DEMO_TENANT, SECOND_TENANT } from './fixtures';
assert.equal(process.env.DYNA_TEST, 'true');

let app: FastifyInstance, admin: string, viewer: string, other: string;
let own: { id: string; number: string; status: string; version: string };
let foreign: { id: string; number: string };
const get = (url: string, cookie?: string) => app.inject({ url, headers: cookie ? { cookie } : {} });

before(async () => {
  await migrate();
  await seed();
  app = await buildApp();
  const login = async (email: string) => {
    const r = await app.inject({ url: '/api/auth/login', method: 'POST', payload: { email, password: 'DynaDemo!2026' } });
    assert.equal(r.statusCode, 200, r.body);
    return r.headers['set-cookie']!.toString().split(';')[0];
  };
  admin = await login('admin@demo.local');
  viewer = await login('viewer@demo.local');
  other = await login('other@demo.local');
  own = (await pool.query('SELECT id,number,status,version FROM orders WHERE tenant_id=$1 ORDER BY number LIMIT 1', [DEMO_TENANT])).rows[0];
  foreign = (await pool.query('SELECT id,number FROM orders WHERE tenant_id=$1 ORDER BY number LIMIT 1', [SECOND_TENANT])).rows[0];
  assert.ok(own, 'seed has an order in the demo workspace');
});
after(async () => {
  await app.close();
});

test('numer zamówienia z adresu prowadzi do jego identyfikatora w tej samej organizacji', async () => {
  const r = await get('/api/orders/by-number/' + encodeURIComponent(own.number), admin);
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json(), { id: own.id, number: own.number, status: own.status, version: own.version });
  // Viewers navigate too: the lookup is a read.
  assert.equal((await get('/api/orders/by-number/' + encodeURIComponent(own.number), viewer)).statusCode, 200);
  const ref = await get('/api/orders/' + own.id + '/ref', admin);
  assert.equal(ref.statusCode, 200, ref.body);
  assert.equal(ref.json().number, own.number);
});

test('nieznany numer, cudza organizacja i brak sesji kończą się odmową bez danych', async () => {
  const missing = await get('/api/orders/by-number/NIE-MA-TAKIEGO', admin);
  assert.equal(missing.statusCode, 404);
  assert.match(missing.json().error ?? missing.body, /Nie znaleziono zamówienia NIE-MA-TAKIEGO/);
  // SQL text in the number is only a value.
  assert.equal((await get("/api/orders/by-number/" + encodeURIComponent("x' OR '1'='1"), admin)).statusCode, 404);
  if (foreign) {
    assert.equal((await get('/api/orders/by-number/' + encodeURIComponent(foreign.number), admin)).statusCode === 200 &&
      (await get('/api/orders/by-number/' + encodeURIComponent(foreign.number), admin)).json().id === foreign.id, false);
    assert.equal((await get('/api/orders/' + foreign.id + '/ref', admin)).statusCode, 404);
  }
  assert.equal((await get('/api/orders/by-number/' + encodeURIComponent(own.number), other)).json().id === own.id, false);
  assert.equal((await get('/api/orders/' + own.id + '/ref', other)).statusCode, 404);
  assert.equal((await get('/api/orders/by-number/' + encodeURIComponent(own.number))).statusCode, 401);
  assert.equal((await get('/api/orders/not-a-uuid/ref', admin)).statusCode, 422);
  // Fastify refuses over-long path parameters before the handler (414); the schema caps the rest.
  assert.ok([414, 422].includes((await get('/api/orders/by-number/' + 'X'.repeat(121), admin)).statusCode));
});
