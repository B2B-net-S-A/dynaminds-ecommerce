/** Supplier remote feed schedules on a fresh PG04 clone (AUTO-02, AUTO-09): two
 * schedulers on the same due time and a restarted process queue exactly one fetch.
 * The scheduler only queues; no fetch or provider call happens in this test. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool } from '../server/db';
import { seed } from './fixtures';
import { scheduleSupplierRemoteFeedsDue } from '../server/supplier-remote-feeds';
assert.equal(process.env.DYNA_TEST, 'true');
assert.match(new URL(process.env.DATABASE_URL!).pathname, /^\/dynaminds_s3b_20261027_\d{2}$/);
let app: Awaited<ReturnType<typeof buildApp>>, cookie = '', tenant = '';
const req = (path: string, method: any = 'GET', payload?: any) =>
  app.inject({ url: '/api' + path, method, payload, headers: { cookie }, remoteAddress: '127.118.9.1' });
async function ok(path: string, method: any = 'GET', payload?: any) {
  const r = await req(path, method, payload);
  assert([200, 201].includes(r.statusCode), path + ': ' + r.body);
  return r.json();
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({ integrationTransport: async () => assert.fail('Unexpected provider call') });
  const r = await req('/auth/signup', 'POST', {
    name: 'Remote feed QA',
    organization: { name: 'Remote feed schedules QA', currency: 'PLN', locale: 'pl-PL' },
    email: `remote-${randomUUID()}@demo.local`,
    password: 'RemoteFeedTests!2026',
  });
  assert.equal(r.statusCode, 201, r.body);
  cookie = String(r.headers['set-cookie']).split(';')[0]!;
  tenant = r.json().user.tenant_id;
});
after(async () => {
  await app.close();
  await pool.end();
});
// The schedule's scope trigger needs the tenant context, as in the app transaction.
async function due(source: string) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
    await c.query("UPDATE supplier_file_feed_schedules SET next_at=now()-interval '1 minute' WHERE source_id=$1", [source]);
    await c.query('COMMIT');
  } finally {
    c.release();
  }
}
const fetches = async (source: string) =>
  (await pool.query('SELECT id,state FROM supplier_file_fetch_runs WHERE source_id=$1', [source])).rows;

test('two schedulers and a restart on the same due time queue one remote fetch', async () => {
  const supplier = await ok('/suppliers', 'POST', { name: 'Hurtownia zdalna', code: 'REMOTE' });
  const s = (
    await ok('/supplier-file-sources', 'POST', {
      client_key: randomUUID(),
      supplier_id: supplier.id,
      name: 'Feed CSV',
      language: 'pl',
      currency: 'PLN',
      max_handling_days: 2,
      config: {
        format: 'csv',
        delimiter: ';',
        fields: {
          remote_id: { path: 'ID', value_type: 'text' },
          sku: { path: 'SKU', value_type: 'text' },
          name: { path: 'Nazwa', value_type: 'text' },
          cost_minor: { path: 'Koszt', value_type: 'decimal_money' },
          quantity: { path: 'Stan', value_type: 'integer' },
        },
      },
    })
  ).source;
  const remote = (
    await ok('/supplier-file-sources/' + s.id + '/remote', 'PATCH', {
      client_key: randomUUID(),
      version: 0,
      source_version: s.version,
      url: 'https://supplier.example/feed.csv',
      auth: { action: 'clear' },
      scope: 'delta',
      confirmed: true,
    })
  ).remote;
  assert.equal(remote.configured, true);
  const current = (await ok('/supplier-file-sources/' + s.id + '/feed-schedule')).schedule;
  const schedule = (
    await ok('/supplier-file-sources/' + s.id + '/feed-schedule', 'PATCH', {
      client_key: randomUUID(),
      version: 0,
      source_version: current.source_version,
      remote_version: current.remote_version,
      enabled: true,
      interval_minutes: 30,
      confirmed: true,
      publish: {},
    })
  ).schedule;
  assert.equal(schedule.enabled, true);
  await due(s.id);
  await Promise.all([scheduleSupplierRemoteFeedsDue(), scheduleSupplierRemoteFeedsDue()]);
  assert.equal((await fetches(s.id)).length, 1, 'one of the two schedulers queues the fetch');
  // Restarted process, same term (the fetch is still queued): nothing new.
  await scheduleSupplierRemoteFeedsDue();
  assert.equal((await fetches(s.id)).length, 1);
  const cfg = (await pool.query('SELECT * FROM supplier_file_feed_schedules WHERE source_id=$1', [s.id])).rows[0];
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.error_code, null);
  // Even if the term were due again while the first fetch is open, the open fetch blocks a second one.
  await due(s.id);
  await Promise.all([scheduleSupplierRemoteFeedsDue(), scheduleSupplierRemoteFeedsDue()]);
  assert.equal((await fetches(s.id)).length, 1);
});
