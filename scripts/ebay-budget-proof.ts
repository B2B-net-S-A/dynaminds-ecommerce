// Owned local simulation only. Synthetic reservations never use a provider account.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
import { ebayRevisionScope } from '../server/ebay-revision-budget';
const file = 'data/ebay-budget-stage070.json',
  phase = process.argv[2];
let cookie = '';
async function api(p: string, method = 'GET', body?: any) {
  const r = await fetch('http://127.0.0.1:4100/api' + p, {
    method,
    headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
  assert(r.ok, p + ': ' + r.status);
  return r.json() as any;
}
async function fp(table: string, tenants: string[]) {
  assert(/^[a-z][a-z0-9_]*$/.test(table));
  const rows = (
    await pool.query(
      `SELECT to_jsonb(t)::text row FROM ${table} t WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1`,
      [tenants],
    )
  ).rows;
  return {
    count: rows.length,
    sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
  };
}
try {
  if (phase === 'baseline') {
    const previous = JSON.parse(await readFile('data/ebay-seller-stage069.json', 'utf8'));
    const tenants = (await pool.query('SELECT id FROM tenants ORDER BY id')).rows.map((x) => x.id),
      before: any = {};
    for (const table of Object.keys(previous.before)) before[table] = await fp(table, tenants);
    await writeFile(
      file,
      JSON.stringify({ tenants, before, baseline_at: new Date().toISOString() }, null, 2) + '\n',
      { mode: 0o600 },
    );
    console.log({ prior_tenants: tenants.length, stable_tables: Object.keys(before).length });
  } else {
    const s = JSON.parse(await readFile(file, 'utf8'));
    if (phase === 'setup') {
      assert(!s.fixture);
      const email = 'qa-ebay-budget@demo.local';
      const signed = await api('/auth/signup', 'POST', {
        email,
        password: 'DynaDemo!2026',
        name: 'QA limity eBay',
        organization: { name: 'QA limity eBay 070', currency: 'PLN', locale: 'pl-PL' },
      });
      const f: any = (s.fixture = { email, tenant: signed.user.tenant_id });
      await writeFile(file, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
      f.warehouse = (await api('/warehouses')).data[0].id;
      f.channel = (await api('/integrations/ebay-example', 'POST', {})).channel_id;
      await api(`/integrations/${f.channel}/ebay-account/verify`, 'POST', {});
      f.sku = 'QA-EBAY-BUDGET-070';
      f.remote_sku = 'EBAY-DEMO-SKU';
      const product = await api('/products', 'POST', {
        sku: f.sku,
        name: 'Budżet zmian eBay QA 070',
        price: 12300,
        vat: 23,
        quantity: 10,
        warehouse_id: f.warehouse,
      });
      f.product = product.id;
      f.listing = (
        await api(`/integrations/${f.channel}/mappings`, 'POST', {
          external_id: f.remote_sku,
          sku: f.sku,
        })
      ).id;
      f.order = (
        await api('/orders', 'POST', {
          customer_name: 'QA rezerwacja 070',
          email: 'qa@example.test',
          warehouse_id: f.warehouse,
          address: { country: 'PL' },
          items: [{ product_id: f.product, quantity: 2 }],
        })
      ).id;
      f.account_hash = (
        await pool.query('SELECT account_hash FROM ebay_account_bindings WHERE channel_id=$1', [
          f.channel,
        ])
      ).rows[0].account_hash;
      f.scope = ebayRevisionScope(f.account_hash, 'sandbox', f.tenant);
      f.listing_id = 'DEMO-LISTING-0';
      await pool.query(
        `INSERT INTO ebay_revision_attempts(scope_hash,listing_id,plan_id,attempted_at) SELECT $1,$2,gen_random_uuid(),clock_timestamp()-interval '1 hour' FROM generate_series(1,250)`,
        [f.scope, f.listing_id],
      );
      await writeFile(file, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
      console.log({ fixture: f, synthetic_attempts: 250 });
    } else if (phase === 'waiting') {
      const f = s.fixture;
      const p = (
        await pool.query(
          "SELECT p.*,j.state job_state,j.attempts,j.run_at FROM offer_plans p JOIN jobs j ON j.id=p.job_id WHERE p.tenant_id=$1 AND p.state='queued' ORDER BY p.created_at DESC LIMIT 1",
          [f.tenant],
        )
      ).rows[0];
      assert(
        p &&
          p.phase === 'ready' &&
          p.job_state === 'pending' &&
          p.attempts === 0 &&
          p.result.ebay_revision_wait_until,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int n FROM ebay_revision_attempts WHERE scope_hash=$1',
            [f.scope],
          )
        ).rows[0].n,
        250,
      );
      s.waits = [
        ...(s.waits ?? []),
        {
          plan: p.id,
          phase: p.phase,
          job_state: p.job_state,
          attempts: p.attempts,
          run_at: p.run_at,
          ledger_count: 250,
        },
      ];
      await writeFile(file, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
      console.log(s.waits.at(-1));
    } else if (phase === 'release') {
      const f = s.fixture;
      await pool.query(
        "UPDATE ebay_revision_attempts SET attempted_at=clock_timestamp()-interval '25 hours' WHERE scope_hash=$1",
        [f.scope],
      );
      await pool.query(
        "UPDATE jobs SET run_at=now() WHERE tenant_id=$1 AND state='pending' AND kind='offer.write'",
        [f.tenant],
      );
      console.log({ owned_simulation_budget_released: true });
    } else if (phase === 'verify') {
      const f = s.fixture;
      await api('/auth/login', 'POST', { email: f.email, password: 'DynaDemo!2026' });
      const h = await api('/health');
      if (process.argv[3]) assert.equal(h.revision, process.argv[3]);
      const plans = (
        await pool.query('SELECT * FROM offer_plans WHERE tenant_id=$1 ORDER BY created_at', [
          f.tenant,
        ])
      ).rows;
      assert.equal(s.waits.length, 2);
      const cancelled = plans.filter(
        (p) =>
          p.state === 'failed' &&
          p.phase === 'ready' &&
          p.error === 'Anulowano oczekiwanie na limit eBay',
      );
      assert.equal(cancelled.length, 1);
      const done = plans.filter((p) => p.state === 'done');
      assert.equal(done.length, 1);
      assert.equal(done[0].result.scope, 'local_simulation');
      assert.equal(done[0].result.desired_applied, true);
      const stock = (
        await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [f.product])
      ).rows;
      assert.deepEqual(stock, [{ on_hand: 10, reserved: 2 }]);
      const listing = (await pool.query('SELECT * FROM listings WHERE id=$1', [f.listing])).rows[0];
      assert.equal(listing.last_result.ebay_offer_snapshot.regular_price, '123.00');
      assert.equal(listing.last_result.stock_quantity, 8);
      const count = (
        await pool.query('SELECT count(*)::int n FROM ebay_revision_attempts WHERE scope_hash=$1', [
          f.scope,
        ])
      ).rows[0].n;
      assert.equal(count, 251);
      for (const [table, before] of Object.entries(s.before))
        assert.deepEqual(await fp(table, s.tenants), before, table + ' changed');
      const report = {
        checked_at: new Date().toISOString(),
        scope: 'native_local_eBay_shared_revision_budget',
        revision: h.revision,
        schema_revision: h.schema_revision,
        prior_tenants_compared: s.tenants.length,
        stable_tables_preserved: Object.keys(s.before).length,
        cancelled_waits: 1,
        waits_verified_before_send: s.waits,
        confirmed_syncs: 1,
        synthetic_prior_attempts: 250,
        new_revision_attempts: 1,
        stock,
        price: '123.00',
        currency: 'PLN',
        inventory_pool: 8,
        provider_requests: 0,
        provider_authenticated: false,
        whole_goal_complete: false,
      };
      await writeFile(
        process.argv[3] ? 'data/ebay-budget-runtime-070.json' : 'docs/ebay-budget-native-qa.json',
        JSON.stringify(report, null, 2) + '\n',
      );
      console.log(report);
    } else throw new Error('Unknown proof phase');
  }
} finally {
  await pool.end();
}
