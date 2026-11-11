// Local API/UI proof. No eBay authentication or provider requests.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
import { decrypt } from '../server/security';
const file = 'data/ebay-oauth-stage063.json',
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
    const previous = JSON.parse(await readFile('data/ebay-offers-stage062.json', 'utf8')),
      tenants = (await pool.query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id),
      before: any = {};
    for (const t of Object.keys(previous.before)) before[t] = await fp(t, tenants);
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
      const email = 'qa-ebay-oauth@demo.local';
      const signed = await api('/auth/signup', 'POST', {
        email,
        password: 'DynaDemo!2026',
        name: 'QA OAuth eBay',
        organization: { name: 'QA OAuth eBay 063', currency: 'PLN', locale: 'pl-PL' },
      });
      const tenant = signed.user.tenant_id;
      const channel = await api('/integrations', 'POST', {
        provider: 'ebay',
        name: 'eBay QA OAuth — bez konta dostawcy',
        mode: 'sandbox',
        credentials: {
          client_id: 'QA-EBAY-OAUTH',
          client_secret: 'QA-SYNTHETIC-SECRET',
          ru_name: 'Dynaminds-QA-OAuth-RuName',
        },
        settings: { inventory_access: 'orders', price_mode: 'gross', marketplace_id: 'EBAY_DE' },
      });
      s.fixture = { email, tenant, channel: channel.id };
      console.log(s.fixture);
    } else if (phase === 'verify') {
      const f = s.fixture;
      await api('/auth/login', 'POST', { email: f.email, password: 'DynaDemo!2026' });
      const h = await api('/health');
      if (process.argv[3]) assert.equal(h.revision, process.argv[3]);
      const ch = (await pool.query('SELECT * FROM channels WHERE id=$1', [f.channel])).rows[0];
      assert.equal(ch.status, 'awaiting_oauth');
      assert(!ch.sync_enabled);
      assert.equal(ch.settings.inventory_access, 'orders');
      assert(!decrypt(ch.credentials).refresh_token);
      assert(!ch.token_expires_at);
      const states = (
        await pool.query(
          'SELECT * FROM oauth_states WHERE channel_id=$1 ORDER BY expires_at DESC',
          [f.channel],
        )
      ).rows;
      assert(states.length > 0);
      assert(states.every((r) => r.consumed_at));
      assert(
        states.some((r) =>
          r.scope.split(' ').includes('https://api.ebay.com/oauth/api_scope/sell.inventory'),
        ),
      );
      assert(states.every((r) => decrypt(r.verifier).provider === 'ebay'));
      const audit = (
        await pool.query('SELECT action FROM audit_events WHERE entity_id=$1 ORDER BY created_at', [
          f.channel,
        ])
      ).rows.map((r) => r.action);
      assert(audit.includes('ebay.oauth.start'));
      assert(audit.includes('ebay.oauth.denied'));
      assert(!audit.includes('ebay.oauth.connected'));
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
        scope: 'native_local_eBay_OAuth_consent_prepare_and_cancel',
        revision: h.revision,
        schema_revision: h.schema_revision,
        prior_tenants_compared: s.tenants.length,
        stable_tables_preserved: Object.keys(s.before).length - differences.length,
        prior_tenant_background_runs: background,
        prior_tenant_changed_tables: differences,
        channel_id: f.channel,
        pending_states: states.length,
        states_consumed: states.every((r) => r.consumed_at),
        token_saved: false,
        scope_requested: 'orders_and_inventory_write',
        schedules_paused: true,
        provider_authenticated: false,
        provider_requests: 0,
        whole_goal_complete: false,
      };
      await writeFile(
        process.argv[3] ? 'data/ebay-oauth-runtime-063.json' : 'docs/ebay-oauth-native-qa.json',
        JSON.stringify(report, null, 2) + '\n',
      );
      console.log(report);
    } else throw Error('Unknown phase');
    await writeFile(file, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
  }
} finally {
  await pool.end();
}
