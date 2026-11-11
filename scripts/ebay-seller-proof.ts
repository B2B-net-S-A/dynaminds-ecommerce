// Owned synthetic local fixture. No supplier requests or real marketplace publication.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
const file = 'data/ebay-seller-stage069.json',
  phase = process.argv[2];
let cookie = '';
async function api(path: string, method = 'GET', body?: any) {
  const r = await fetch('http://127.0.0.1:4100/api' + path, {
    method,
    headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
  assert(r.ok, path + ': ' + r.status);
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
    const previous = JSON.parse(await readFile('data/ebay-creation-stage068.json', 'utf8'));
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
      const email = 'qa-ebay-seller@demo.local';
      const signed = await api('/auth/signup', 'POST', {
        email,
        password: 'DynaDemo!2026',
        name: 'QA ustawienia eBay',
        organization: { name: 'QA ustawienia eBay 069', currency: 'PLN', locale: 'pl-PL' },
      });
      const f: any = (s.fixture = { email, tenant: signed.user.tenant_id });
      await writeFile(file, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
      f.warehouse = (await api('/warehouses')).data[0].id;
      f.channel = (await api('/integrations/ebay-example', 'POST', {})).channel_id;
      await pool.query(
        'UPDATE channels SET settings=settings||\'{"marketplace_id":"EBAY_PL"}\'::jsonb WHERE id=$1 AND tenant_id=$2',
        [f.channel, f.tenant],
      );
      await api(`/integrations/${f.channel}/ebay-account/verify`, 'POST', {});
      f.sku = 'QA-EBAY-CREATE-069';
      f.remote_sku = 'QA-EXTERNAL-CREATE-069';
      f.product = (
        await api('/products', 'POST', {
          sku: f.sku,
          name: 'Ustawienia eBay DYNAMINDS QA 069',
          description: 'Produkt syntetyczny QA. Cena i dostępność po rezerwacjach.',
          images: ['https://example.test/qa069.jpg'],
          attributes: { Marka: 'QA' },
          price: 12300,
          vat: 23,
          quantity: 10,
          warehouse_id: f.warehouse,
        })
      ).id;
      f.order = (
        await api('/orders', 'POST', {
          customer_name: 'QA rezerwacja 069',
          email: 'qa@example.test',
          warehouse_id: f.warehouse,
          address: { country: 'PL' },
          items: [{ product_id: f.product, quantity: 2 }],
        })
      ).id;
      await writeFile(file, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
      console.log(f);
    } else if (phase === 'verify') {
      const f = s.fixture;
      await api('/auth/login', 'POST', { email: f.email, password: 'DynaDemo!2026' });
      const health = await api('/health');
      if (process.argv[3]) assert.equal(health.revision, process.argv[3]);
      const plans = (
        await pool.query('SELECT * FROM offer_plans WHERE tenant_id=$1 ORDER BY created_at', [
          f.tenant,
        ])
      ).rows;
      const done = plans.filter((x) => x.state === 'done');
      assert.equal(done.length, 2);
      const creation = done.find((x) => x.operation === 'create_draft'),
        publication = done.find((x) => x.operation === 'publish');
      assert(creation && publication);
      assert.equal(creation.result.scope, 'local_simulation');
      assert.equal(creation.input.ebay_creation.verify_settings, true);
      assert.equal(
        creation.remote_snapshot.ebay_seller_requirements.category.category.categoryName,
        'Akcesoria DEMO',
      );
      assert.deepEqual(creation.payload.inventory.product.aspects, {
        Marka: ['QA'],
        Kolor: ['Czarny'],
      });
      assert.deepEqual(
        (await pool.query('SELECT attributes FROM products WHERE id=$1', [f.product])).rows[0]
          .attributes,
        { Marka: 'QA' },
      );
      assert.equal(creation.result.desired_applied, true);
      assert.equal(creation.payload.sku, f.remote_sku);
      assert.equal(creation.result.ebay_creation_steps.offer_verified, true);
      assert.equal(publication.result.desired_applied, true);
      assert.equal(publication.result.ebay_publication.status, 'PUBLISHED');
      assert.equal(publication.result.ebay_publication.offer_id, creation.result.ebay_offer_id);
      const listings = (
        await pool.query('SELECT * FROM listings WHERE tenant_id=$1 AND product_id=$2', [
          f.tenant,
          f.product,
        ])
      ).rows;
      assert.equal(listings.length, 1);
      const l = listings[0];
      const snapshot = l.last_result.ebay_offer_snapshot;
      assert.equal(snapshot.status, 'PUBLISHED');
      assert.equal(snapshot.regular_price, '123.00');
      assert.equal(snapshot.currency, 'PLN');
      assert.equal(snapshot.stock_quantity, 8);
      assert.equal(snapshot.inventory.availability.shipToLocationAvailability.quantity, 8);
      assert(
        snapshot.inventory.product.description.includes('dynaminds-offer-plan:' + creation.id),
      );
      assert.equal(l.price, 12300);
      assert.equal(
        (await pool.query('SELECT price FROM products WHERE id=$1', [f.product])).rows[0].price,
        12300,
      );
      const stock = (
        await pool.query('SELECT on_hand,reserved FROM stock WHERE product_id=$1', [f.product])
      ).rows;
      assert.deepEqual(stock, [{ on_hand: 10, reserved: 2 }]);
      const differences: any[] = [];
      const allowed = [
        'audit_events',
        'listings',
        'odoo_catalog_schedules',
        'odoo_catalog_sync_runs',
        'odoo_catalog_sync_items',
      ];
      for (const [table, before] of Object.entries(s.before)) {
        const after = await fp(table, s.tenants);
        if (JSON.stringify(before) !== JSON.stringify(after)) {
          assert(allowed.includes(table), table + ' changed');
          differences.push({ table, before, after });
        }
      }
      const background = (
        await pool.query(
          "SELECT r.id,r.tenant_id,r.state,r.simulation,c.settings->>'simulation' channel_simulation FROM odoo_catalog_sync_runs r JOIN channels c ON c.id=r.channel_id WHERE r.tenant_id=ANY($1::uuid[]) AND r.created_at>$2 ORDER BY r.created_at",
          [s.tenants, s.baseline_at],
        )
      ).rows;
      if (differences.length) {
        assert(
          background.length &&
            background.every(
              (r) => r.simulation && r.channel_simulation === 'true' && r.state === 'success',
            ),
        );
        const audits = (
          await pool.query(
            'SELECT action,entity_id FROM audit_events WHERE tenant_id=ANY($1::uuid[]) AND created_at>$2',
            [s.tenants, s.baseline_at],
          )
        ).rows;
        assert(
          audits.every(
            (r) =>
              ['odoo.catalog.sync.queue', 'odoo.catalog.sync.page'].includes(r.action) &&
              background.some((b) => b.id === r.entity_id),
          ),
        );
      }
      const report = {
        checked_at: new Date().toISOString(),
        scope: 'native_local_eBay_seller_options_taxonomy_aspects_creation_publication',
        required_aspects_verified: ['Marka', 'Kolor'],
        selected_policy_names: Object.fromEntries(
          Object.entries(creation.remote_snapshot.ebay_seller_requirements.policies).map(
            ([kind, p]: any) => [kind, p.name],
          ),
        ),
        global_catalogue_attributes_preserved: true,
        revision: health.revision,
        schema_revision: health.schema_revision,
        prior_tenants_compared: s.tenants.length,
        stable_tables_preserved: Object.keys(s.before).length - differences.length,
        prior_tenant_changed_tables: differences,
        prior_tenant_background_runs: background,
        confirmed_local_creation_plans: 1,
        confirmed_local_publication_plans: 1,
        distinct_published_offers: 1,
        remote_price: snapshot.regular_price,
        remote_currency: snapshot.currency,
        remote_quantity: snapshot.stock_quantity,
        inventory_pool: 8,
        local_price: l.price,
        stock,
        provider_requests: 0,
        provider_authenticated: false,
        whole_goal_complete: false,
      };
      await writeFile(
        process.argv[3] ? 'data/ebay-seller-runtime-069.json' : 'docs/ebay-seller-native-qa.json',
        JSON.stringify(report, null, 2) + '\n',
      );
      console.log(report);
    } else throw new Error('Unknown phase');
  }
} finally {
  await pool.end();
}
