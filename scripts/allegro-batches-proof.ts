// Only this synthetic organization is mutated; external provider HTTP is never used.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
const file = 'data/allegro-batches-stage043.json',
  email = 'qa-allegro-batch@demo.local',
  password = 'DynaDemo!2026';
const tables = Object.keys(
  JSON.parse(await readFile('data/allegro-creation-stage042.json', 'utf8')).before,
);
let state: any,
  cookie = '';
async function fingerprints(tenants: string[]) {
  const out: any = {};
  for (const table of tables) {
    assert(/^[a-z_]+$/.test(table));
    const rows = (
      await pool.query(
        'SELECT (' +
          (table === 'variant_offer_batches'
            ? "to_jsonb(t)-'kind'"
            : table === 'variant_offer_batch_items'
              ? "to_jsonb(t)-'creation_input'"
              : 'to_jsonb(t)') +
          ')::text row FROM ' +
          table +
          ' t WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1',
        [tenants],
      )
    ).rows;
    out[table] = {
      count: rows.length,
      sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
    };
  }
  return out;
}
async function api(path: string, method = 'GET', body?: any, status = 200) {
  const r = await fetch('http://127.0.0.1:4100/api' + path, {
    method,
    headers: {
      cookie,
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(path === '/orders' ? { 'idempotency-key': randomUUID() } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
  const d = await r.json();
  assert.equal(r.status, status, path + ': ' + JSON.stringify(d));
  return d;
}
const save = () => writeFile(file, JSON.stringify(state), { mode: 0o600 });
try {
  const phase = process.argv[2];
  if (phase === 'baseline') {
    const tenants = (await pool.query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id);
    state = { tenants, before: await fingerprints(tenants) };
    await save();
    console.log(JSON.stringify({ old_tenants: tenants.length, business_tables: tables.length }));
  } else {
    state = JSON.parse(await readFile(file, 'utf8'));
    if (phase === 'setup' && !state.fixture) {
      await api(
        '/auth/signup',
        'POST',
        {
          email,
          password,
          name: 'QA Partie Allegro',
          organization: { name: 'QA Partie Allegro 20261004' },
        },
        201,
      );
      state.fixture = { tenant: (await api('/auth/me')).user.tenant_id };
      await save();
    } else await api('/auth/login', 'POST', { email, password });
    const f = state.fixture;
    if (phase === 'setup') {
      assert(!f.products, 'Fixture już istnieje; użyj kolejnego etapu zamiast ponownego setupu');
      await api('/workspaces/plan', 'PATCH', { plan: 'enterprise' });
      f.warehouse = (await api('/warehouses')).data[0].id;
      f.channel = (await api('/integrations/allegro-example', 'POST', {})).channel_id;
      f.products = [];
      for (let n = 1; n <= 4; n++)
        f.products.push(
          await api(
            '/products',
            'POST',
            {
              sku: 'AL-BATCH-' + n,
              name: 'Lampa partii demonstracyjnej numer ' + n,
              price: 10000 + n,
              vat: 23,
              quantity: 20,
              warehouse_id: f.warehouse,
            },
            201,
          ),
        );
      await save();
      console.log(
        JSON.stringify({
          tenant: f.tenant,
          channel: f.channel,
          products: f.products.map((p: any) => ({ id: p.id, sku: p.sku })),
        }),
      );
    }
    if (phase === 'cancelled' || phase === 'resumed') {
      const batches = (await api('/integrations/' + f.channel + '/allegro-batches')).data;
      assert.equal(batches.length, 1);
      const report = await api('/allegro-batches/' + batches[0].id);
      assert.equal(report.batch.state, phase === 'cancelled' ? 'cancelled' : 'review');
      assert.deepEqual(report.counts, phase === 'cancelled' ? { skipped: 4 } : { preview: 4 });
      assert.equal(report.batch.input.approved_version, undefined);
      assert.equal((await api('/integrations/' + f.channel + '/offer-listings')).data.length, 0);
      assert(
        (await api('/integrations/' + f.channel + '/offers')).data.every(
          (p: any) => p.state === 'preview',
        ),
      );
      state.checks = {
        ...state.checks,
        [phase]: { checked_at: new Date().toISOString(), listing_count: 0, write_plans: 0 },
      };
      await save();
      console.log(JSON.stringify(state.checks));
    }
    if (phase === 'verify' || phase === 'runtime') {
      const batches = (await api('/integrations/' + f.channel + '/allegro-batches')).data;
      assert.equal(batches.length, 1);
      assert.equal(batches[0].state, 'done');
      const report = await api('/allegro-batches/' + batches[0].id);
      assert.deepEqual(report.counts, { done: 4 });
      const listings = (await api('/integrations/' + f.channel + '/offer-listings')).data;
      assert.equal(listings.length, 4);
      for (const p of f.products) {
        const item = report.data.find((i: any) => i.product_id === p.id),
          listing = listings.find((l: any) => l.product_id === p.id);
        assert(item && listing);
        assert.equal(item.payload.stock.available, 20);
        assert.equal(item.payload.sellingMode.price.amount, (p.price / 100).toFixed(2));
        assert.equal(item.payload.publication.status, 'INACTIVE');
        assert.equal(item.plan_result.scope, 'local_simulation');
        assert.equal(item.plan_result.desired_applied, true);
        assert.equal(listing.last_result.stock_quantity, 20);
        const stock = (
          await pool.query(
            'SELECT on_hand,reserved FROM stock WHERE tenant_id=$1 AND product_id=$2',
            [f.tenant, p.id],
          )
        ).rows[0];
        assert.deepEqual(stock, { on_hand: 20, reserved: 0 });
      }
      assert.deepEqual(await fingerprints(state.tenants), state.before);
      for (const [table, predicate] of [
        ['variant_offer_batches', "kind<>'woocommerce_variants'"],
        ['variant_offer_batch_items', "creation_input<>'{}'::jsonb"],
      ]) {
        assert.equal(
          (
            await pool.query(
              'SELECT count(*)::int n FROM ' +
                table +
                ' WHERE tenant_id=ANY($1::uuid[]) AND (' +
                predicate +
                ')',
              [state.tenants],
            )
          ).rows[0].n,
          0,
          'Migration defaults for earlier organizations: ' + table,
        );
      }
      assert(state.checks.cancelled && state.checks.resumed);
      const h = await api('/health'),
        proof = {
          checked_at: new Date().toISOString(),
          scope: 'native_local_worker_chrome_synthetic',
          browser_steps: [
            'build_batch_mappings',
            'preview_batch',
            'cancel_before_approval',
            'resume_to_review_without_writes',
            'approve_batch',
            'inspect_results',
          ],
          native_api_steps: ['fixtures', 'verify_stock_prices_and_tenant_fingerprints'],
          schema_revision: h.schema_revision,
          runtime_revision: h.revision,
          old_tenants_preserved: state.tenants.length,
          business_tables_unchanged: tables.length,
          fingerprint_scope: 'original_columns_excluding_new_kind_and_creation_input',
          migration_defaults_verified_for_prior_tenants: true,
          batch_count: 1,
          cancel_resume_without_writes: state.checks,
          confirmed_drafts: 4,
          listing_count: 4,
          stock_per_sku: 20,
          product_prices: f.products.map((p: any) => p.price),
          provider_requests: 0,
          real_payments: 0,
        };
      await writeFile(
        phase === 'runtime'
          ? 'data/allegro-batches-stage043-runtime.json'
          : 'docs/allegro-batches-qa.json',
        JSON.stringify(proof, null, 2) + '\n',
      );
      console.log(JSON.stringify(proof));
    }
  }
} finally {
  await pool.end();
}
