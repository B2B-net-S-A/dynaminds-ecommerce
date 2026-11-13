import type { FastifyRequest } from 'fastify';
import { buildApp } from '../server/app';
import { tick } from '../server/worker';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { pool, migrate, tenantTx } from '../server/db';
import { seed, DEMO_TENANT, SECOND_TENANT } from './fixtures';
import { encrypt, decrypt } from '../server/security';
import { Problem } from '../server/errors';
import type { Actor } from '../server/domain';
import { beginOAuth, finishOAuth, refreshOAuth, readScopes,
  withAllegroRequestContext, type IntegrationContext } from '../server/channel-access';

assert.equal(process.env.DYNA_TEST, 'true');
let actor: Actor;
let app: Awaited<ReturnType<typeof buildApp>>, authenticatedRequest: FastifyRequest;
before(async () => {
  await migrate();
  await seed();
  actor = { tenantId: DEMO_TENANT, role: 'admin',
    userId: (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id };
  app = await buildApp();
  app.addHook('preHandler', async req => {
    if (req.url === '/api/auth/me') authenticatedRequest = req;
  });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login',
    payload: { email: 'admin@demo.local', password: 'DynaDemo!2026' } });
  assert.equal(login.statusCode, 200);
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
  assert.equal(me.statusCode, 200);
  assert.equal(authenticatedRequest.actor.userId, actor.userId);
  assert.equal(authenticatedRequest.actor.tenantId, actor.tenantId);
});
after(async () => { await app?.close(); await pool.end(); });

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
function context(label: string, held = false) {
  const entered = deferred<void>(), release = deferred<void>();
  let calls = 0;
  const ctx: IntegrationContext = {
    oauthConfig: () => ({ clientId: 'fixture-client', clientSecret: 'fixture-secret',
      redirectUri: 'http://127.0.0.1:4100/api/oauth/allegro/callback' }),
    transport: async (url, init) => {
      assert.equal(new URL(url).pathname, '/auth/oauth/token');
      assert.equal(init.method, 'POST');
      const params = new URLSearchParams(String(init.body));
      assert(['refresh_token', 'authorization_code'].includes(params.get('grant_type')!));
      calls++;
      entered.resolve();
      if (held) await release.promise;
      return new Response(JSON.stringify({ access_token: `${label}-access`,
        refresh_token: `${label}-refresh`, expires_in: 3600, scope: readScopes }), { status: 200 });
    },
  };
  return { ctx: withAllegroRequestContext(ctx, authenticatedRequest), entered: entered.promise, release: () => release.resolve(), calls: () => calls };
}
async function channel(tenant = DEMO_TENANT) {
  const id = randomUUID();
  await tenantTx(tenant, (c) => c.query(
    `INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings,status,oauth_scopes,token_expires_at)
     VALUES($1,$2,'allegro','OAuth recovery fixture','sandbox',$3,$4,'authorized_read',$5,now()-interval '1 minute')`,
    [id, tenant, encrypt({ access_token: 'old-access', refresh_token: 'old-refresh' }),
      { simulation: false, oauth_connection_id: randomUUID(), preserved: 'configuration' }, readScopes],
  ));
  return id;
}
async function channels() {
  return (await pool.query('SELECT to_jsonb(c) row FROM channels c ORDER BY tenant_id,id')).rows;
}
async function current(id: string) {
  return (await pool.query('SELECT * FROM channels WHERE id=$1', [id])).rows[0];
}
async function start(id: string, ctx: IntegrationContext) {
  return new URL((await beginOAuth(actor, id, ctx)).url).searchParams.get('state')!;
}
async function connectedAudits(id: string) {
  return (await pool.query(
    "SELECT to_jsonb(a) row FROM audit_events a WHERE entity_id=$1 AND action='oauth.connected' ORDER BY id",
    [id],
  )).rows;
}
function conflict(error: unknown) {
  assert(error instanceof Problem);
  assert.equal(error.status, 409);
  assert.match(error.message, /^Połączenie Allegro zmieniło się podczas /);
  assert(!/access|refresh|fixture-secret|old-token/.test(error.message));
  return true;
}
// Attach rejection handling immediately: releasing a held response must not create
// an unhandled rejection before the assertions can await the result.
const outcome = <T>(p: Promise<T>) => p.then(
  (value) => ({ value, error: null }), (error: unknown) => ({ value: null, error }),
);

test('refresh cannot overwrite a reconnect completed while its token response was held', async () => {
  const id = await channel(), other = await channel(SECOND_TENANT);
  const oldOther = await current(other), refresh = context('stale', true), reconnect = context('new');
  const state = await start(id, reconnect.ctx);
  const pending = outcome(refreshOAuth(actor.tenantId, id, 'old-access', refresh.ctx));
  try {
    await refresh.entered;
    await finishOAuth(actor, state, 'new-code', reconnect.ctx);
    const accepted = await channels(), audits = await connectedAudits(id), saved = await current(id);
    assert.equal(decrypt(saved.credentials).access_token, 'new-access');
    assert.equal(audits.length, 1);
    refresh.release();
    conflict((await pending).error);
    assert.deepEqual(await channels(), accepted);
    assert.deepEqual(await connectedAudits(id), audits);
    assert.deepEqual(await current(other), oldOther);
    assert.equal(refresh.calls(), 1);
    assert.equal(reconnect.calls(), 1);
  } finally { refresh.release(); await pending; }
});

test('a legitimate reconnect survives an intervening refresh of the same connection', async () => {
  const id = await channel(), reconnect = context('new', true), refresh = context('rotated');
  const old = await current(id), state = await start(id, reconnect.ctx);
  const pending = outcome(finishOAuth(actor, state, 'code', reconnect.ctx));
  try {
    await reconnect.entered;
    await refreshOAuth(actor.tenantId, id, 'old-access', refresh.ctx);
    const rotated = await current(id);
    assert.equal(decrypt(rotated.credentials).access_token, 'rotated-access');
    assert.equal(rotated.settings.oauth_connection_id, old.settings.oauth_connection_id);
    const all = await channels();
    reconnect.release();
    const result = await pending;
    assert.equal(result.error, null);
    const saved = await current(id);
    assert.equal(decrypt(saved.credentials).access_token, 'new-access');
    assert.notEqual(saved.settings.oauth_connection_id, old.settings.oauth_connection_id);
    assert.equal(saved.settings.preserved, old.settings.preserved);
    assert.deepEqual((await channels()).filter((r) => r.row.id !== id), all.filter((r) => r.row.id !== id));
    assert.equal((await connectedAudits(id)).length, 1);
  } finally { reconnect.release(); await pending; }
});

test('two overlapping reconnect responses cannot overwrite the connection accepted first', async () => {
  const id = await channel(), first = context('first', true), second = context('second');
  const s1 = await start(id, first.ctx), s2 = await start(id, second.ctx);
  const pending = outcome(finishOAuth(actor, s1, 'first-code', first.ctx));
  try {
    await first.entered;
    await finishOAuth(actor, s2, 'second-code', second.ctx);
    const accepted = await channels(), audits = await connectedAudits(id);
    first.release();
    conflict((await pending).error);
    assert.deepEqual(await channels(), accepted);
    assert.deepEqual(await connectedAudits(id), audits);
    assert.equal(audits.length, 1);
    assert.equal(decrypt((await current(id)).credentials).access_token, 'second-access');
  } finally { first.release(); await pending; }
});

test('refresh rechecks source identity after a real concurrent channel row-lock wait', async () => {
  const id = await channel(), refresh = context('held', true);
  const pending = outcome(refreshOAuth(actor.tenantId, id, 'old-access', refresh.ctx));
  const holder = await pool.connect();
  try {
    await refresh.entered;
    await holder.query('BEGIN');
    await holder.query("UPDATE channels SET mode='live' WHERE id=$1", [id]);
    const pid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    refresh.release();
    let observed = false;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      observed = (await pool.query(
        `SELECT EXISTS(SELECT 1 FROM pg_stat_activity
          WHERE $1::int=ANY(pg_blocking_pids(pid)) AND query LIKE 'UPDATE channels SET credentials=%') waiting`,
        [pid],
      )).rows[0].waiting;
      if (observed) break;
      await delay(20);
    }
    assert.equal(observed, true, 'Actual refresh UPDATE must wait for the channel row holder');
    await holder.query('COMMIT');
    conflict((await pending).error);
    const saved = await current(id);
    assert.equal(saved.mode, 'live');
    assert.deepEqual(decrypt(saved.credentials), { access_token: 'old-access', refresh_token: 'old-refresh' });
    assert.equal((await connectedAudits(id)).length, 0);
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
    refresh.release();
    await pending;
  }
});

for (const change of ['simulation', 'provider', 'delete'] as const) {
  test(`held refresh refuses source ${change} and preserves the resulting channel facts`, async () => {
    const id = await channel(), refresh = context('rejected', true);
    const pending = outcome(refreshOAuth(actor.tenantId, id, 'old-access', refresh.ctx));
    try {
      await refresh.entered;
      await tenantTx(actor.tenantId, (c) => c.query(change === 'simulation'
        ? "UPDATE channels SET settings=jsonb_set(settings,'{simulation}','true'::jsonb) WHERE id=$1"
        : change === 'provider' ? "UPDATE channels SET provider='woocommerce' WHERE id=$1"
        : 'DELETE FROM channels WHERE id=$1', [id]));
      const accepted = await channels();
      refresh.release();
      conflict((await pending).error);
      assert.deepEqual(await channels(), accepted);
      assert.equal((await connectedAudits(id)).length, 0);
    } finally { refresh.release(); await pending; }
  });
}

test('concurrent refreshes still rotate once and reuse the newly persisted access token', async () => {
  const id = await channel(), refresh = context('single');
  const results = await Promise.all(Array.from({ length: 14 }, () =>
    refreshOAuth(actor.tenantId, id, 'old-access', refresh.ctx)));
  assert.equal(refresh.calls(), 1);
  assert(results.every((r) => decrypt(r.credentials).access_token === 'single-access'));
  assert.equal((await connectedAudits(id)).length, 0);
});

// This test exercises a real native queue, worker claim/reaper and second claim.
// Aging locked_at is an explicit fixture clock setup; lease tokens come only
// from tick(), not from an injected permission or fabricated source parent.
test('known-response refusal fences a replacement native lease before refresh unlock', { timeout: 60000 }, async () => {
  const id = await channel(), held = context('takeover', true);
  // Any pending automation job left by the seed (the seed's rules are disabled and
  // events with no rules queue none, server/events.ts) is postponed before the
  // purity baseline: both real worker claims must select the target, including
  // after the reaper resets its run_at.
  const seeded = (await pool.query("SELECT id,kind,payload FROM jobs WHERE state='pending' ORDER BY id")).rows;
  assert(seeded.every(j => j.kind === 'automation' && Array.isArray(j.payload.rules)));
  await pool.query("UPDATE jobs SET run_at=clock_timestamp()+interval '1 hour' WHERE id=ANY($1::uuid[])",
    [seeded.map(j => j.id)]);
  const queued = await app.inject({ method: 'POST', url: '/api/integrations/' + id + '/sync',
    headers: { cookie: authenticatedRequest.headers.cookie! } });
  assert.equal(queued.statusCode, 200);
  const jobId = queued.json().id as string;
  const acceptedChannels = await channels();
  const oldJobs = (await pool.query('SELECT to_jsonb(j) row FROM jobs j WHERE id<>$1 ORDER BY id', [jobId])).rows;
  const first = outcome(tick(held.ctx));
  let replacement: ReturnType<typeof outcome<boolean>> | undefined;
  try {
    let tokenTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        held.entered,
        first.then(async result => {
          const state = (await pool.query('SELECT state,attempts,error FROM jobs WHERE id=$1', [jobId])).rows[0];
          assert.fail('Native worker ended before token HTTP: ' + JSON.stringify({
            value: result.value, error: result.error instanceof Error ? result.error.message : null, job: state,
          }));
        }),
        new Promise<never>((_, reject) => {
          tokenTimer = setTimeout(() => reject(new Error('Native worker did not reach token HTTP within five seconds')), 5000);
        }),
      ]);
    } finally { if (tokenTimer) clearTimeout(tokenTimer); }
    const oldLease = (await pool.query('SELECT lease_token,state,attempts FROM jobs WHERE id=$1', [jobId])).rows[0];
    assert.equal(oldLease.state, 'running'); assert.equal(oldLease.attempts, 1);
    await pool.query("UPDATE jobs SET locked_at=clock_timestamp()-interval '3 minutes' WHERE id=$1 AND lease_token=$2",
      [jobId,oldLease.lease_token]);
    replacement = outcome(tick(held.ctx));
    let newLease: string | undefined, observed = false;
    const deadline = Date.now()+5000;
    while (Date.now()<deadline) {
      const currentJob = (await pool.query('SELECT lease_token,state,attempts FROM jobs WHERE id=$1', [jobId])).rows[0];
      if (currentJob.lease_token && currentJob.lease_token!==oldLease.lease_token) {
        newLease=currentJob.lease_token;
        assert.equal(currentJob.state,'running'); assert.equal(currentJob.attempts,2);
        observed=(await pool.query("SELECT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid "
          + "WHERE l.locktype='advisory' AND NOT l.granted AND l.objsubid=1 "
          + "AND l.classid=((hashtextextended($1,0)>>32)&4294967295)::oid "
          + "AND l.objid=(hashtextextended($1,0)&4294967295)::oid "
          + "AND cardinality(pg_blocking_pids(a.pid))>0 "
          + "AND a.query LIKE 'SELECT pg_advisory_lock(hashtextextended($1,0))%') waiting",
          ['oauth:'+actor.tenantId+':'+id])).rows[0].waiting;
        if (observed) break;
      }
      await delay(20);
    }
    assert(newLease && observed, 'Replacement lease must really wait on the exact channel refresh advisory');
    const nativePayload = (await pool.query('SELECT payload FROM jobs WHERE id=$1', [jobId])).rows[0].payload;
    held.release();
    const results = await Promise.all([first,replacement]);
    assert(results.every(r=>r.error===null && r.value===true));
    assert.equal(held.calls(),1,'Replacement must remint source after advisory wait, never send a second token HTTP');
    const saved=(await pool.query('SELECT * FROM jobs WHERE id=$1', [jobId])).rows[0];
    assert.equal(saved.state,'failed'); assert.equal(saved.attempts,2); assert.equal(saved.lease_token,null);
    const source=acceptedChannels.find(r=>r.row.id===id)!.row;
    assert.deepEqual(saved.payload,{...nativePayload,allegro_oauth_commit_refused:{
      channel_id:id,connection_id:source.settings.oauth_connection_id}});
    assert.deepEqual(await channels(),acceptedChannels);
    assert.deepEqual((await pool.query('SELECT to_jsonb(j) row FROM jobs j WHERE id<>$1 ORDER BY id', [jobId])).rows,oldJobs);
    assert.equal((await connectedAudits(id)).length,0);
    assert.equal(decrypt((await current(id)).credentials).access_token,'old-access');
  } finally { held.release(); await first; if(replacement) await replacement; }
});
