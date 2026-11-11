// Local API/UI proof. No eBay authentication or provider requests.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
import { decrypt } from '../server/security';
const file = 'data/ebay-account-stage065.json',
  phase = process.argv[2];
let cookie = '';
async function api(path: string, method = 'GET', body?: any) {
  const r = await fetch('http://127.0.0.1:4100/api' + path, {
    method,
    headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
  assert(r.ok, `${path}: ${r.status}`);
  return r.json() as any;
}
async function fp(t: string, tenants: string[]) {
  assert(/^[a-z][a-z0-9_]*$/.test(t));
  const rows = (
    await pool.query(
      `SELECT to_jsonb(t)::text row FROM ${t} t WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1`,
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
    const previous = JSON.parse(await readFile('data/ebay-fulfillment-stage064.json', 'utf8')),
      tenants = (await pool.query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id),
      before: any = {};
    for (const t of [...Object.keys(previous.before), 'ebay_account_bindings'])
      before[t] = await fp(t, tenants);
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
      const email = 'qa-ebay-account@demo.local';
      const signed = await api('/auth/signup', 'POST', {
        email,
        password: 'DynaDemo!2026',
        name: 'QA konto eBay',
        organization: { name: 'QA tożsamość eBay 065', currency: 'PLN', locale: 'pl-PL' },
      });
      const tenant = signed.user.tenant_id;
      const demo = await api('/integrations/ebay-example', 'POST', {});
      const oauth = await api('/integrations', 'POST', {
        provider: 'ebay',
        name: 'eBay OAuth QA — bez konta dostawcy',
        mode: 'sandbox',
        credentials: {
          client_id: 'QA-EBAY-ACCOUNT',
          client_secret: 'QA-SYNTHETIC-SECRET',
          ru_name: 'Dynaminds-QA-RuName',
        },
        settings: { inventory_access: 'orders' },
      });
      const warehouse = (await api('/warehouses')).data[0].id;
      const product = await api('/products', 'POST', {
        sku: 'EBAY-ACCOUNT-QA-065',
        name: 'Produkt QA tożsamości eBay',
        price: 12345,
        vat: 23,
        quantity: 12,
        warehouse_id: warehouse,
      });
      s.fixture = { email, tenant, channel: demo.channel_id, oauth: oauth.id, product: product.id };
      console.log(s.fixture);
    } else if (phase === 'verify') {
      const f = s.fixture;
      await api('/auth/login', 'POST', { email: f.email, password: 'DynaDemo!2026' });
      const h = await api('/health');
      if (process.argv[3]) assert.equal(h.revision, process.argv[3]);
      const ch = (await pool.query('SELECT * FROM channels WHERE id=$1', [f.channel])).rows[0];
      assert.equal(ch.status, 'simulation');
      assert.equal(ch.settings.simulation, true);
      assert.deepEqual(decrypt(ch.credentials), {});
      const bound = await api(`/integrations/${f.channel}/ebay-account`);
      assert.equal(bound.bound, true);
      assert.equal(bound.source, 'simulation');
      assert.equal(bound.simulation, true);
      assert.equal(bound.username, 'DEMO — lokalny sprzedawca');
      assert(!('account_hash' in bound));
      const row = (
        await pool.query('SELECT * FROM ebay_account_bindings WHERE channel_id=$1', [f.channel])
      ).rows[0];
      assert.equal(row.account_hash.length, 64);
      if (f.account_hash) {
        assert.equal(row.account_hash, f.account_hash);
        assert.equal(new Date(row.created_at).toISOString(), f.binding_created_at);
      } else {
        f.account_hash = row.account_hash;
        f.binding_created_at = new Date(row.created_at).toISOString();
      }
      const audit = (
        await pool.query(
          "SELECT action,detail FROM audit_events WHERE entity_id=$1 AND action='ebay.account.verified' ORDER BY created_at",
          [f.channel],
        )
      ).rows;
      assert(audit.length >= 1);
      assert(audit.every((r) => r.detail.source === 'simulation'));
      const stock = (
        await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [f.product])
      ).rows[0];
      assert.deepEqual(stock, { on_hand: 12, reserved: 0 });
      assert.equal(
        (await pool.query('SELECT price FROM products WHERE id=$1', [f.product])).rows[0].price,
        12345,
      );
      assert.equal(
        (await pool.query('SELECT 1 FROM orders WHERE tenant_id=$1', [f.tenant])).rowCount,
        0,
      );
      assert.equal(
        (await pool.query('SELECT 1 FROM payment_entries WHERE tenant_id=$1', [f.tenant])).rowCount,
        0,
      );
      const oauth = (await pool.query('SELECT * FROM channels WHERE id=$1', [f.oauth])).rows[0];
      assert.equal(oauth.status, 'awaiting_oauth');
      assert(!decrypt(oauth.credentials).refresh_token);
      const states = (await pool.query('SELECT * FROM oauth_states WHERE channel_id=$1', [f.oauth]))
        .rows;
      assert(states.length > 0);
      assert(states.every((r) => r.consumed_at));
      assert(
        states.every((r) => r.scope.split(' ').includes('https://api.ebay.com/oauth/api_scope')),
      );
      const backgroundTables = [
        'audit_events',
        'listings',
        'odoo_catalog_schedules',
        'odoo_catalog_sync_runs',
        'odoo_catalog_sync_items',
      ];
      const differences: any[] = [];
      for (const [t, b] of Object.entries(s.before)) {
        const actual = await fp(t, s.tenants);
        if (JSON.stringify(actual) !== JSON.stringify(b)) {
          assert(backgroundTables.includes(t), t + ' unexpectedly changed for prior tenant');
          differences.push({ table: t, before: b, after: actual });
        }
      }
      const background = (
        await pool.query(
          "SELECT r.id,r.tenant_id,r.created_at,r.state,r.simulation,c.provider,c.settings->>'simulation' channel_simulation FROM odoo_catalog_sync_runs r JOIN channels c ON c.id=r.channel_id WHERE r.tenant_id=ANY($1::uuid[]) AND r.created_at>$2 ORDER BY r.created_at",
          [s.tenants, s.baseline_at],
        )
      ).rows;
      if (differences.length) {
        assert(background.length > 0);
        assert(
          background.every(
            (r) =>
              r.provider === 'odoo' &&
              r.simulation &&
              r.channel_simulation === 'true' &&
              r.state === 'success',
          ),
        );
        const newAudits = (
          await pool.query(
            'SELECT action,entity_id FROM audit_events WHERE tenant_id=ANY($1::uuid[]) AND created_at>$2',
            [s.tenants, s.baseline_at],
          )
        ).rows;
        assert(
          newAudits.every(
            (r) =>
              ['odoo.catalog.sync.queue', 'odoo.catalog.sync.page'].includes(r.action) &&
              background.some((b) => b.id === r.entity_id),
          ),
        );
      }
      const report = {
        checked_at: new Date().toISOString(),
        scope: 'native_local_eBay_account_verification_simulation_and_OAuth_cancel',
        revision: h.revision,
        schema_revision: h.schema_revision,
        prior_tenants_compared: s.tenants.length,
        stable_tables_preserved: Object.keys(s.before).length - differences.length,
        prior_tenant_background_runs: background,
        prior_tenant_changed_tables: differences,
        channel_id: f.channel,
        source: bound.source,
        username: bound.username,
        identity_reads: audit.length,
        immutable_account_hash: row.account_hash,
        stock,
        product_price: 12345,
        orders: 0,
        payments: 0,
        oauth_states_consumed: states.length,
        token_saved: false,
        provider_authenticated: false,
        provider_requests: 0,
        whole_goal_complete: false,
      };
      await writeFile(
        process.argv[3] ? 'data/ebay-account-runtime-065.json' : 'docs/ebay-account-native-qa.json',
        JSON.stringify(report, null, 2) + '\n',
      );
      console.log(report);
    } else throw Error('Unknown phase');
    await writeFile(file, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
  }
} finally {
  await pool.end();
}
