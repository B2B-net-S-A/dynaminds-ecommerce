// This fixture is local-only. Example channels never invoke provider HTTP.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { pool } from '../server/db';
const file = 'data/allegro-publishing-stage044.json',
  email = 'qa-allegro-publish@demo.local',
  password = 'DynaDemo!2026';
const tables = Object.keys(
  JSON.parse(await readFile('data/allegro-batches-stage043.json', 'utf8')).before,
);
let state: any,
  cookie = '';
async function fingerprints(tenants: string[]) {
  const out: any = {};
  for (const t of tables) {
    assert(/^[a-z_]+$/.test(t));
    const rows = (
      await pool.query(
        'SELECT to_jsonb(t)::text row FROM ' + t + ' t WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1',
        [tenants],
      )
    ).rows;
    out[t] = {
      count: rows.length,
      sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
    };
  }
  return out;
}
async function api(path: string, method = 'GET', body?: any, status = 200) {
  const r = await fetch('http://127.0.0.1:4100/api' + path, {
    method,
    headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
  const d = await r.json();
  assert.equal(r.status, status, path + ': ' + JSON.stringify(d));
  return d;
}
const save = () => writeFile(file, JSON.stringify(state), { mode: 0o600 });
async function waitBatch(id: string, want: string) {
  for (let n = 0; n < 50; n++) {
    const d = await api('/allegro-batches/' + id);
    if (d.batch.state === want) return d;
    assert(!['partial', 'failed'].includes(d.batch.state), JSON.stringify(d));
    await setTimeout(500);
  }
  assert.fail('Local batch did not reach ' + want);
}
try {
  const phase = process.argv[2];
  if (phase === 'baseline') {
    const tenants = (await pool.query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id);
    state = { tenants, before: await fingerprints(tenants) };
    await save();
    console.log(JSON.stringify({ tenants: tenants.length, tables: tables.length }));
  } else {
    state = JSON.parse(await readFile(file, 'utf8'));
    if (phase === 'setup') {
      assert(!state.fixture, 'Do not repeat setup on an existing fixture');
      await api(
        '/auth/signup',
        'POST',
        {
          email,
          password,
          name: 'QA Publikacja Allegro',
          organization: { name: 'QA Publikacja Allegro 20261004' },
        },
        201,
      );
      const f: any = (state.fixture = { tenant: (await api('/auth/me')).user.tenant_id });
      await save();
      await api('/workspaces/plan', 'PATCH', { plan: 'enterprise' });
      f.warehouse = (await api('/warehouses')).data[0].id;
      f.channel = (await api('/integrations/allegro-example', 'POST', {})).channel_id;
      f.products = [];
      for (let n = 1; n <= 3; n++)
        f.products.push(
          await api(
            '/products',
            'POST',
            {
              sku: 'AL-PUBLISH-' + n,
              name: 'Publikacja demonstracyjna numer ' + n,
              price: 12000 + n,
              vat: 23,
              quantity: 12,
              warehouse_id: f.warehouse,
            },
            201,
          ),
        );
      const ids = Array.from(
        { length: 5 },
        (_, n) => '10000000-0000-4000-8000-00000000000' + (n + 1),
      );
      const allegro = {
        product_id: ids[0],
        shipping_rate_id: ids[1],
        return_policy_id: ids[2],
        implied_warranty_id: ids[3],
        responsible_producer_id: ids[4],
        handling_time: 'PT24H',
        safety_information: 'Syntetyczne informacje bezpieczeństwa QA.',
        parameters: [{ id: '11323', valuesIds: ['11323_1'] }],
      };
      f.drafts = (
        await api(
          '/integrations/' + f.channel + '/allegro-batches',
          'POST',
          {
            name: 'Szkice do publikacji QA',
            warehouse_id: f.warehouse,
            client_key: randomUUID(),
            items: f.products.map((p: any) => ({ product_id: p.id, allegro })),
          },
          201,
        )
      ).id;
      await save();
      const review = await waitBatch(f.drafts, 'review');
      await api('/allegro-batches/' + f.drafts + '/queue', 'POST', {
        version: review.batch.version,
      });
      await waitBatch(f.drafts, 'done');
      f.listings = (await api('/integrations/' + f.channel + '/offer-listings')).data;
      assert.equal(f.listings.length, 3);
      await save();
      console.log(
        JSON.stringify({
          tenant: f.tenant,
          channel: f.channel,
          sku: f.products.map((p: any) => p.sku),
        }),
      );
    } else await api('/auth/login', 'POST', { email, password });
    const f = state.fixture;
    if (['cancelled', 'resumed', 'verify', 'runtime'].includes(phase)) {
      const batches = (await api('/integrations/' + f.channel + '/allegro-batches')).data.filter(
        (b: any) => b.input.operation === 'publish',
      );
      assert.equal(batches.length, 1);
      const report = ['verify', 'runtime'].includes(phase)
        ? await waitBatch(batches[0].id, 'done')
        : await api('/allegro-batches/' + batches[0].id);
      if (phase === 'cancelled' || phase === 'resumed') {
        assert.equal(report.batch.state, phase === 'cancelled' ? 'cancelled' : 'review');
        assert.deepEqual(report.counts, phase === 'cancelled' ? { skipped: 3 } : { preview: 3 });
        assert.equal(report.batch.input.approved_version, undefined);
        const listings = (await api('/integrations/' + f.channel + '/offer-listings')).data;
        assert.equal(listings.length, 3);
        assert(listings.every((l: any) => l.last_result.status === 'INACTIVE'));
        state.checks = {
          ...state.checks,
          [phase]: { checked_at: new Date().toISOString(), active_offers: 0 },
        };
        await save();
        console.log(JSON.stringify(state.checks));
      } else {
        assert.equal(report.batch.state, 'done');
        assert.deepEqual(report.counts, { done: 3 });
        assert(state.checks.cancelled && state.checks.resumed);
        const listings = (await api('/integrations/' + f.channel + '/offer-listings')).data;
        assert.equal(listings.length, 3);
        for (const l of f.listings) {
          const final = listings.find((v: any) => v.id === l.id),
            item = report.data.find((v: any) => v.product_id === l.product_id);
          assert.equal(final.external_id, l.external_id);
          assert.equal(final.last_result.status, 'ACTIVE');
          assert.equal(final.last_result.stock_quantity, 12);
          assert.equal(final.price, l.price);
          assert.deepEqual(item.payload, { publication: { status: 'ACTIVE' } });
          assert.equal(item.plan_result.scope, 'local_simulation');
          assert.equal(item.plan_result.desired_applied, true);
          assert.deepEqual(
            (
              await pool.query(
                'SELECT on_hand,reserved FROM stock WHERE tenant_id=$1 AND product_id=$2',
                [f.tenant, l.product_id],
              )
            ).rows[0],
            { on_hand: 12, reserved: 0 },
          );
        }
        assert.deepEqual(await fingerprints(state.tenants), state.before);
        const h = await api('/health'),
          proof = {
            checked_at: new Date().toISOString(),
            scope: 'native_local_worker_chrome_synthetic',
            browser_steps: [
              'choose_existing_offers',
              'preview_publication',
              'cancel',
              'resume_without_approval',
              'approve',
              'inspect_results',
            ],
            native_api_steps: [
              'create_synthetic_drafts',
              'verify_ids_status_prices_stock_and_tenant_fingerprints',
            ],
            schema_revision: h.schema_revision,
            runtime_revision: h.revision,
            old_tenants_preserved: state.tenants.length,
            business_tables_unchanged: tables.length,
            full_row_fingerprints: true,
            publication_batch: 1,
            confirmed_publications: 3,
            listing_count: 3,
            stock_per_sku: 12,
            prices: f.products.map((p: any) => p.price),
            cancel_resume_without_publication: state.checks,
            provider_requests: 0,
            real_payments: 0,
          };
        await writeFile(
          phase === 'runtime'
            ? 'data/allegro-publishing-stage044-runtime.json'
            : 'docs/allegro-publishing-qa.json',
          JSON.stringify(proof, null, 2) + '\n',
        );
        console.log(JSON.stringify(proof));
      }
    }
  }
} finally {
  await pool.end();
}
