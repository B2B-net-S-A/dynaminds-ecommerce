// QA owns only the new tenant and its explicitly synthetic simulation application bucket.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool, migrate } from '../server/db';
import { ebaySimulationApplication, ebayApiScope } from '../server/ebay-api-limits';
const file = 'data/ebay-api-stage071.json',
  phase = process.argv[2];
let cookie = '';
async function api(p: string, method = 'GET', body?: any) {
  const r = await fetch('http://127.0.0.1:4100/api' + p, {
    method,
    headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
  assert(r.ok, p + ':' + r.status);
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
  if (phase === 'migrate') {
    await migrate();
    console.log({ local_migration_050_applied: true });
  } else if (phase === 'baseline') {
    const old = JSON.parse(await readFile('data/ebay-budget-stage070.json', 'utf8')),
      tenants = (await pool.query('SELECT id FROM tenants ORDER BY id')).rows.map((x) => x.id),
      before: any = {};
    for (const table of Object.keys(old.before)) before[table] = await fp(table, tenants);
    await writeFile(
      file,
      JSON.stringify({ tenants, before, baseline_at: new Date().toISOString() }, null, 2) + '\n',
      { mode: 0o600, flag: 'wx' },
    );
    console.log({ prior_tenants: tenants.length, stable_tables: Object.keys(before).length });
  } else {
    const s = JSON.parse(await readFile(file, 'utf8'));
    if (phase === 'setup') {
      assert(!s.fixture);
      const email = 'qa-ebay-api@demo.local',
        signed = await api('/auth/signup', 'POST', {
          email,
          password: 'DynaDemo!2026',
          name: 'QA kontrola API',
          organization: { name: 'QA API eBay 071', currency: 'PLN', locale: 'pl-PL' },
        }),
        f: any = (s.fixture = { email, tenant: signed.user.tenant_id });
      await writeFile(file, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
      f.warehouse = (await api('/warehouses')).data[0].id;
      f.channel = (await api('/integrations/ebay-example', 'POST', {})).channel_id;
      await api(`/integrations/${f.channel}/ebay-account/verify`, 'POST', {});
      f.sku = 'QA-EBAY-API-071';
      f.product = (
        await api('/products', 'POST', {
          sku: f.sku,
          name: 'Kontrola API eBay QA 071',
          price: 12300,
          vat: 23,
          quantity: 10,
          warehouse_id: f.warehouse,
        })
      ).id;
      f.listing = (
        await api(`/integrations/${f.channel}/mappings`, 'POST', {
          external_id: 'EBAY-DEMO-SKU',
          sku: f.sku,
        })
      ).id;
      f.order = (
        await api('/orders', 'POST', {
          customer_name: 'QA rezerwacja 071',
          email: 'qa@example.test',
          warehouse_id: f.warehouse,
          address: { country: 'PL' },
          items: [{ product_id: f.product, quantity: 2 }],
        })
      ).id;
      f.app_hash = ebaySimulationApplication(f.tenant, 'sandbox');
      f.scope = ebayApiScope(f.app_hash, 'inventory');
      await pool.query(
        "INSERT INTO ebay_api_buckets(scope_hash,app_hash,family,cooldown_until,last_429_at,limited_responses) VALUES($1,$2,'inventory',now()+interval '1 hour',now(),1)",
        [f.scope, f.app_hash],
      );
      await writeFile(file, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
      console.log({ fixture: f, synthetic_429: true });
    } else if (phase === 'waiting') {
      const p = (
        await pool.query(
          "SELECT p.id,p.phase,p.state,j.state job_state,j.attempts,j.provider_wait_until,j.run_at FROM offer_plans p JOIN jobs j ON j.id=p.job_id WHERE p.tenant_id=$1 AND p.state='queued' ORDER BY p.created_at DESC LIMIT 1",
          [s.fixture.tenant],
        )
      ).rows[0];
      assert(
        p &&
          p.phase === 'ready' &&
          p.job_state === 'pending' &&
          p.attempts === 0 &&
          p.provider_wait_until,
      );
      s.waits = [...(s.waits ?? []), p];
      await writeFile(file, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
      console.log(p);
    } else if (phase === 'release') {
      assert.equal(s.waits.length, 2);
      await pool.query(
        "UPDATE ebay_api_buckets SET cooldown_until='-infinity' WHERE scope_hash=$1",
        [s.fixture.scope],
      );
      await pool.query(
        "UPDATE jobs SET run_at=now() WHERE tenant_id=$1 AND state='pending' AND kind='offer.write'",
        [s.fixture.tenant],
      );
      console.log({ owned_simulation_cooldown_released: true });
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
      const cancelled = plans.filter((p) => p.state === 'failed' && p.phase === 'ready'),
        done = plans.filter((p) => p.state === 'done');
      assert.equal(cancelled.length, 1);
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
      assert.equal(
        (
          await pool.query('SELECT count(*)::int n FROM ebay_api_leases WHERE scope_hash=$1', [
            f.scope,
          ])
        ).rows[0].n,
        0,
      );
      const status = await api(`/integrations/${f.channel}/ebay/api-limits`);
      assert.equal(status.scope, 'local_simulation');
      assert.equal(status.families[0].cooldown_until, null);
      const changes = [];
      for (const [table, before] of Object.entries(s.before)) {
        const after = await fp(table, s.tenants);
        if (JSON.stringify(after) !== JSON.stringify(before))
          changes.push({ table, before, after });
      }
      const report = {
        checked_at: new Date().toISOString(),
        scope: 'native_local_ebay_application_api_control',
        revision: h.revision,
        schema_revision: h.schema_revision,
        prior_tenants_compared: s.tenants.length,
        stable_tables_compared: Object.keys(s.before).length,
        prior_table_changes: changes,
        waits_before_send: s.waits,
        cancelled_waits: 1,
        confirmed_syncs: 1,
        stock,
        price: '123.00',
        inventory_pool: 8,
        status,
        synthetic_429_injected: true,
        provider_requests: 0,
        provider_authenticated: false,
        whole_goal_complete: false,
      };
      await writeFile(
        process.argv[3] ? 'data/ebay-api-runtime-071.json' : 'docs/ebay-api-native-qa.json',
        JSON.stringify(report, null, 2) + '\n',
      );
      console.log(report);
    } else throw Error('Unknown proof phase');
  }
} finally {
  await pool.end();
}
