import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool, migrate, tenantTx } from '../server/db';
import { buildApp } from '../server/app';
import { seed, SECOND_TENANT } from './fixtures';
import {
  previewBilling,
  commitBilling,
  configureBilling,
  billingState,
  renewBillingDue,
  prorated,
} from '../server/workspace-billing';
assert.equal(process.env.DYNA_TEST, 'true');
let app: Awaited<ReturnType<typeof buildApp>>;
const at = new Date('2040-10-16T12:00:00Z');
const req = (path: string, method: any = 'GET', payload?: any, cookie = '') =>
  app.inject({ url: '/api' + path, method, payload, headers: { cookie } });
before(async () => {
  await migrate();
  await seed();
});
beforeEach(async () => {
  app = await buildApp();
  await pool.query('UPDATE workspace_billing_accounts SET auto_renew=false');
  await pool.query('UPDATE workspace_plan_rates SET version=1');
});
afterEach(async () => {
  await app.close();
});
after(async () => {
  await pool.end();
});
async function fixture() {
  const r = await req('/auth/signup', 'POST', {
    email: randomUUID() + '@example.test',
    name: 'Billing QA',
    password: 'LocalBilling!2026',
    organization: { name: 'Billing ' + randomUUID().slice(0, 8) },
  });
  assert.equal(r.statusCode, 201, r.body);
  const u = r.json().user;
  return {
    actor: { tenantId: u.tenant_id, userId: u.id, role: 'admin' as const },
    cookie: r.headers['set-cookie']!.toString().split(';')[0],
  };
}
async function activate(
  f: any,
  plan: 'starter' | 'business' | 'enterprise' = 'business',
  clock = at,
) {
  const p = await previewBilling(f.actor, { kind: 'activate', plan }, clock);
  await commitBilling(f.actor, p.id, clock);
  return billingState(f.actor);
}
test('integer proration covers leap February, full month, zero and half-up rounding', () => {
  assert.equal(prorated(2900, new Date('2040-02-01Z'), new Date('2040-03-01Z')), 2900);
  assert.equal(prorated(2900, new Date('2040-02-15T12:00Z'), new Date('2040-03-01Z')), 1450);
  assert.equal(prorated(1, new Date('2040-10-16T12:00Z'), new Date('2040-11-01Z')), 1);
  assert.equal(prorated(0, at, new Date('2040-11-01Z')), 0);
  assert.throws(() => prorated(-1, at, new Date('2040-11-01Z')));
});
test('read and preview do not activate; activation atomically changes limits and appends one estimate, exact replay is free', async () => {
  const f = await fixture();
  assert.equal((await billingState(f.actor)).account, null);
  const p = await previewBilling(f.actor, { kind: 'activate', plan: 'business' }, at);
  assert.equal(p.total, 9950);
  assert.equal((await billingState(f.actor)).entries.length, 0);
  const r = await commitBilling(f.actor, p.id, at);
  assert.equal(r.amount, p.debit);
  assert.deepEqual(await commitBilling(f.actor, p.id, at), r);
  const s = await billingState(f.actor);
  assert.equal(s.current_plan, 'business');
  assert.equal(s.entries.length, 1);
  assert.equal(s.account.auto_renew, false);
});
test('parallel activation previews have one winner and one durable estimate', async () => {
  const f = await fixture();
  const ps = await Promise.all(
    ['business', 'enterprise'].map((plan) =>
      previewBilling(f.actor, { kind: 'activate', plan: plan as any }, at),
    ),
  );
  const rs = await Promise.allSettled(ps.map((p) => commitBilling(f.actor, p.id, at)));
  assert.equal(rs.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((await billingState(f.actor)).entries.length, 1);
});
test('immediate change credits remaining old price and uses frozen quote, never alters previous estimate', async () => {
  const f = await fixture();
  const before = await activate(f);
  const p = await previewBilling(f.actor, { kind: 'change', plan: 'enterprise' }, at);
  assert.equal(p.credit, -9950);
  assert.equal(p.debit, 49950);
  assert.equal(p.total, 40000);
  await commitBilling(f.actor, p.id, new Date(at.getTime() + 60000));
  const s = await billingState(f.actor);
  assert.equal(s.account.plan, 'enterprise');
  assert.equal(s.entries.length, 3);
  assert.deepEqual(
    s.entries.find((e: any) => e.id === before.entries[0].id),
    before.entries[0],
  );
});
test('expired quote, changed rate and changed configuration reject before updating plan or ledger', async () => {
  const f = await fixture();
  await activate(f);
  const p = await previewBilling(f.actor, { kind: 'change', plan: 'enterprise' }, at);
  await assert.rejects(commitBilling(f.actor, p.id, new Date(at.getTime() + 16 * 60000)), /wygasł/);
  await pool.query("UPDATE workspace_plan_rates SET version=2 WHERE plan='enterprise'");
  await assert.rejects(commitBilling(f.actor, p.id, at), /Cennik/);
  await pool.query("UPDATE workspace_plan_rates SET version=1 WHERE plan='enterprise'");
  await configureBilling(f.actor, { version: 1, auto_renew: true });
  await assert.rejects(commitBilling(f.actor, p.id, at), /zmienił/);
  assert.equal((await billingState(f.actor)).entries.length, 1);
});
test('legacy plan route participates in active billing; stale previews cannot bypass new ledger/version', async () => {
  const f = await fixture();
  const p = await previewBilling(f.actor, { kind: 'activate', plan: 'business' });
  await commitBilling(f.actor, p.id);
  const pending = await previewBilling(f.actor, { kind: 'change', plan: 'enterprise' });
  const r = await req('/workspaces/plan', 'PATCH', { plan: 'enterprise' }, f.cookie);
  assert.equal(r.statusCode, 200, r.body);
  await assert.rejects(commitBilling(f.actor, pending.id), /zmienił/);
  const s = await billingState(f.actor);
  assert.equal(s.account.plan, 'enterprise');
  assert.equal(s.entries.length, 3);
});
test('usage and held invitations are revalidated after preview; failed commit rolls back all writes', async () => {
  const f = await fixture(),
    clock = new Date();
  await activate(f, 'business', clock);
  const p = await previewBilling(f.actor, { kind: 'change', plan: 'starter' }, clock);
  for (let i = 0; i < 3; i++) {
    const r = await req(
      '/workspaces/invitations',
      'POST',
      { email: randomUUID() + '@example.test', role: 'viewer' },
      f.cookie,
    );
    assert.equal(r.statusCode, 201, r.body);
  }
  await assert.rejects(commitBilling(f.actor, p.id, clock), /limity/);
  const s = await billingState(f.actor);
  assert.equal(s.account.plan, 'business');
  assert.equal(s.entries.length, 1);
});
test('scheduled downgrade changes no current rights; one renewal applies it, resets monthly usage and is deduplicated concurrently', async () => {
  const f = await fixture();
  await activate(f);
  const p = await previewBilling(f.actor, { kind: 'schedule', plan: 'starter' }, at);
  await commitBilling(f.actor, p.id, at);
  assert.equal((await billingState(f.actor)).current_plan, 'business');
  await configureBilling(f.actor, { version: 2, auto_renew: true });
  await pool.query(
    "INSERT INTO workspace_usage(tenant_id,resource,period,used) VALUES($1,'orders','2040-10-01',2000) ON CONFLICT(tenant_id,resource,period) DO UPDATE SET used=2000",
    [f.actor.tenantId],
  );
  await Promise.all([
    renewBillingDue(new Date('2040-11-01Z')),
    renewBillingDue(new Date('2040-11-01Z')),
  ]);
  const s = await billingState(f.actor);
  assert.equal(s.account.plan, 'starter');
  assert.equal(new Date(s.account.period_end).toISOString(), new Date('2040-12-01Z').toISOString());
  assert.equal(s.entries.length, 2);
  assert.equal(s.account.next_terms, null);
});
test('blocked downgrade preserves plan/history and retries later; cancel clears it with CAS', async () => {
  const f = await fixture();
  await activate(f);
  const p = await previewBilling(f.actor, { kind: 'schedule', plan: 'starter' }, at);
  await commitBilling(f.actor, p.id, at);
  await pool.query(
    "INSERT INTO products(id,tenant_id,sku,name,price) SELECT gen_random_uuid(),$1,'SKU-'||n,'Quota product',100 FROM generate_series(1,1001) n",
    [f.actor.tenantId],
  );
  await configureBilling(f.actor, { version: 2, auto_renew: true });
  const r = await renewBillingDue(new Date('2040-11-01Z'));
  assert.equal(r.blocked, 1);
  const s = await billingState(f.actor);
  assert.equal(s.account.plan, 'business');
  assert.match(s.account.next_error, /products/);
  assert.equal(s.entries.length, 1);
  assert.deepEqual(await renewBillingDue(new Date('2040-11-01T00:01Z')), {
    renewed: 0,
    blocked: 0,
  });
  await assert.rejects(
    configureBilling(f.actor, { version: 3, cancel_scheduled: true }),
    /zmienił/,
  );
  await configureBilling(f.actor, {
    version: s.account.version,
    cancel_scheduled: true,
    auto_renew: false,
  });
  assert.equal((await billingState(f.actor)).account.next_terms, null);
});
test('price changes block automatic renewal, while manual preview explicitly accepts new terms', async () => {
  const f = await fixture();
  await activate(f);
  await configureBilling(f.actor, { version: 1, auto_renew: true });
  await pool.query("UPDATE workspace_plan_rates SET version=2 WHERE plan='business'");
  await renewBillingDue(new Date('2040-11-01Z'));
  let s = await billingState(f.actor);
  assert.match(s.account.next_error, /Cennik/);
  const p = await previewBilling(
    f.actor,
    { kind: 'renew', plan: 'business' },
    new Date('2040-11-01Z'),
  );
  await commitBilling(f.actor, p.id, new Date('2040-11-01Z'));
  s = await billingState(f.actor);
  assert.equal(s.entries.length, 2);
  assert.equal(s.account.current_terms.rate_version, 2);
});
test('disabled renewal never generates new estimates; catch-up progresses one complete calendar month each time', async () => {
  const f = await fixture();
  await activate(f);
  assert.deepEqual(await renewBillingDue(new Date('2041-01-01Z')), { renewed: 0, blocked: 0 });
  await configureBilling(f.actor, { version: 1, auto_renew: true });
  for (let i = 0; i < 3; i++) await renewBillingDue(new Date('2041-01-01Z'));
  const s = await billingState(f.actor);
  assert.equal(s.entries.length, 4);
  assert.equal(new Date(s.account.period_end).toISOString(), new Date('2041-02-01Z').toISOString());
});
test('operator reads plan but not estimate history and cannot mutate; foreign tenant cannot commit another preview', async () => {
  const f = await fixture();
  await activate(f);
  const p = await previewBilling(f.actor, { kind: 'change', plan: 'enterprise' }, at);
  const o = await fixture();
  await assert.rejects(commitBilling(o.actor, p.id, at), /Brak podglądu/);
  await pool.query("UPDATE memberships SET role='operator' WHERE user_id=$1 AND tenant_id=$2", [
    f.actor.userId,
    f.actor.tenantId,
  ]);
  const s = await billingState(f.actor);
  assert.equal(s.admin, false);
  assert.equal(s.entries.length, 0);
  await assert.rejects(commitBilling(f.actor, p.id, at), /administrator/);
  await assert.rejects(
    configureBilling(f.actor, { version: 1, auto_renew: true }),
    /administrator/,
  );
});
test('billing RLS hides other firms, app role cannot write and immutable history survives superuser mutation attempts', async () => {
  const f = await fixture();
  await activate(f);
  for (const table of [
    'workspace_billing_accounts',
    'workspace_billing_entries',
    'workspace_billing_previews',
  ]) {
    assert.equal(
      (
        await tenantTx(SECOND_TENANT, (c) =>
          c.query(`SELECT * FROM ${table} WHERE tenant_id=$1`, [f.actor.tenantId]),
        )
      ).rowCount,
      0,
    );
    await assert.rejects(
      tenantTx(f.actor.tenantId, (c) =>
        c.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [f.actor.tenantId]),
      ),
      /permission/,
    );
  }
  await assert.rejects(
    pool.query('UPDATE workspace_billing_entries SET amount=0 WHERE tenant_id=$1', [
      f.actor.tenantId,
    ]),
    /immutable/,
  );
  await assert.rejects(
    pool.query("UPDATE workspace_billing_previews SET terms='{}' WHERE tenant_id=$1", [
      f.actor.tenantId,
    ]),
    /immutable/,
  );
});
test('readonly restore blocks all billing writes before mutations', async () => {
  const f = await fixture(),
    preview = await buildApp({ readOnly: true });
  try {
    const l = await preview.inject({
      url: '/api/auth/login',
      method: 'POST',
      payload: {
        email: (await req('/auth/me', 'GET', undefined, f.cookie)).json().user.email,
        password: 'LocalBilling!2026',
      },
    });
    const cookie = l.headers['set-cookie']!.toString().split(';')[0];
    for (const [path, method] of [
      ['/workspaces/billing/preview', 'POST'],
      ['/workspaces/billing', 'PATCH'],
      ['/workspaces/billing/previews/' + randomUUID() + '/commit', 'POST'],
    ])
      assert.equal(
        (
          await preview.inject({
            url: '/api' + path,
            method: method as any,
            payload: {},
            headers: { cookie },
          })
        ).statusCode,
        423,
      );
    assert.equal((await billingState(f.actor)).account, null);
  } finally {
    await preview.close();
  }
});

test('history pagination uses date and ID cursor with no duplicate or missing entries', async () => {
  const f = await fixture();
  await activate(f);
  for (let i = 0; i < 16; i++) {
    const p = await previewBilling(
      f.actor,
      { kind: 'change', plan: i % 2 ? 'business' : 'enterprise' },
      at,
    );
    await commitBilling(f.actor, p.id, at);
  }
  const first = await billingState(f.actor);
  assert.equal(first.entries.length, 30);
  assert(first.next_cursor);
  const second = await billingState(f.actor, first.next_cursor);
  assert.equal(second.entries.length, 3);
  assert.equal(second.next_cursor, null);
  assert.equal(new Set([...first.entries, ...second.entries].map((e) => e.id)).size, 33);
});
test('an invalid due account is deferred without preventing another firm renewal', async () => {
  const bad = await fixture(),
    good = await fixture();
  await activate(bad);
  await activate(good);
  await configureBilling(bad.actor, { version: 1, auto_renew: true });
  await configureBilling(good.actor, { version: 1, auto_renew: true });
  await pool.query("UPDATE workspace_billing_accounts SET current_terms='{}' WHERE tenant_id=$1", [
    bad.actor.tenantId,
  ]);
  const r = await renewBillingDue(new Date('2040-11-01Z'));
  assert.deepEqual(r, { renewed: 1, blocked: 1 });
  assert.equal((await billingState(bad.actor)).entries.length, 1);
  assert.equal((await billingState(good.actor)).entries.length, 2);
});

test('clock used for expiry also determines whether an invitation still reserves a seat', async () => {
  const f = await fixture();
  await activate(f);
  await configureBilling(f.actor, { version: 1, auto_renew: true });
  for (let i = 0; i < 3; i++) {
    const r = await req(
      '/workspaces/invitations',
      'POST',
      { email: randomUUID() + '@example.test', role: 'viewer' },
      f.cookie,
    );
    assert.equal(r.statusCode, 201, r.body);
  }
  const p = await previewBilling(f.actor, { kind: 'schedule', plan: 'starter' }, at);
  assert.equal(p.blockers.length, 0);
  await commitBilling(f.actor, p.id, at);
  assert.deepEqual(await renewBillingDue(new Date('2040-11-01Z'), f.actor.tenantId), {
    renewed: 1,
    blocked: 0,
  });
  await assert.rejects(previewBilling(f.actor, { kind: 'change', plan: 'business' }, at), /cofnąć/);
});
