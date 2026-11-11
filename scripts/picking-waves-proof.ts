// One isolated local QA company. Credentials stay in ignored data/, never in receipts.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
const file = 'data/picking-waves-stage079.json';
const tables = [
  'channels',
  'products',
  'stock',
  'orders',
  'order_items',
  'reservations',
  'documents',
  'shipments',
  'return_cases',
  'return_items',
  'payment_entries',
  'listings',
  'purchase_orders',
  'purchase_order_lines',
  'picking_waves',
  'picking_wave_orders',
  'picking_wave_scans',
];
let cookie = '';
async function api(path: string, method = 'GET', payload?: unknown, status = 200) {
  const r = await fetch('http://127.0.0.1:4100/api' + path, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(payload ? { 'content-type': 'application/json' } : {}),
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  const b = (await r.json()) as any;
  assert.equal(r.status, status, path + ':' + JSON.stringify(b));
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
  return b;
}
async function fingerprints(tenants: string[]) {
  const out: Record<string, unknown> = {};
  for (const table of tables) {
    const rows = (
      await pool.query(
        `SELECT to_jsonb(t)::text row FROM ${table} t WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1`,
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
async function save(f: any) {
  await writeFile(file, JSON.stringify(f, null, 2), { mode: 0o600 });
}
try {
  const mode = process.argv[2],
    health = await api('/health');
  assert.equal(health.schema_revision, '058_picking_waves');
  if (mode === 'setup') {
    assert(!existsSync(file), 'One-time QA fixture already exists');
    const tenants = (await pool.query('SELECT id FROM tenants ORDER BY id')).rows.map((t) => t.id);
    const f: any = {
      tenants,
      before: await fingerprints(tenants),
      email: 'qa-picking-waves@demo.local',
      password: 'DynaWaves!2026',
      created_at: new Date().toISOString(),
    };
    const auth = await api(
      '/auth/signup',
      'POST',
      {
        name: 'QA kompletacji zbiorczej',
        email: f.email,
        password: f.password,
        organization: { name: 'QA Kompletacja zbiorcza 079' },
      },
      201,
    );
    f.tenant = auth.user.tenant_id;
    f.user = auth.user.id;
    f.warehouse = (await api('/warehouses')).data[0].id;
    f.product = await api(
      '/products',
      'POST',
      {
        sku: 'QA-WAVE-079',
        ean: '5901234123457',
        name: 'QA zbiorcza kompletacja / organizer',
        price: 15000,
        quantity: 12,
        warehouse_id: f.warehouse,
        location: 'A2',
      },
      201,
    );
    const bin = (
      await api('/stock-locations?warehouse_id=' + f.warehouse + '&product_id=' + f.product.id)
    ).data[0];
    await api('/stock-location-moves', 'POST', {
      warehouse_id: f.warehouse,
      product_id: f.product.id,
      location: 'A2',
      destination: 'A10',
      quantity: 6,
      expected_version: bin.version,
      client_key: randomUUID(),
      note: 'QA dwa miejsca pobrania',
    });
    f.orders = [];
    for (let i = 0; i < 2; i++)
      f.orders.push(
        await api(
          '/orders',
          'POST',
          {
            warehouse_id: f.warehouse,
            customer_name: 'QA Koszyk ' + (i + 1),
            email: 'qa@example.test',
            address: { street: 'Testowa 1', postcode: '00-001', city: 'Warszawa', country: 'PL' },
            payment_mode: 'cod',
            items: [{ product_id: f.product.id, quantity: 4 }],
          },
          201,
        ),
      );
    f.cookie = cookie;
    await save(f);
    console.log(
      JSON.stringify({
        setup: true,
        previous_firms: tenants.length,
        orders: f.orders.length,
        units: 8,
        tenant: f.tenant,
      }),
    );
  } else {
    const f = JSON.parse(await readFile(file, 'utf8'));
    cookie = f.cookie;
    assert.equal((await api('/auth/me')).user.tenant_id, f.tenant);
    const waves = (await api('/picking-waves?warehouse_id=' + f.warehouse + '&state=all')).data;
    assert.equal(waves.length, 1, 'Exactly one own UI wave');
    f.wave = waves[0].id;
    const wave = await api('/picking-waves/' + f.wave);
    assert.equal(wave.progress.quantity, 8);
    assert.equal(wave.progress.scanned, 8);
    assert.equal(wave.wave.state, 'completed');
    assert.equal(wave.scans.length, 8);
    assert.deepEqual(
      wave.groups.map((g: any) => [g.location, g.quantity, g.scanned]),
      [
        ['A2', 2, 2],
        ['A10', 6, 6],
      ],
    );
    if (mode === 'finalize') {
      assert(!f.finalized, 'One-time own QA fulfillment already completed');
      const a = f.orders[0];
      const beforePack = await api('/orders/' + a.id);
      if (beforePack.status === 'picking')
        await api('/orders/' + a.id + '/status', 'PATCH', { status: 'packed' });
      else
        assert(
          ['packed', 'shipped'].includes(beforePack.status),
          'Only our own prepared QA order may be fulfilled',
        );
      if (beforePack.status !== 'shipped') await api('/orders/' + a.id + '/ship-demo', 'POST', {});
      const documentState = await api('/orders/' + a.id);
      const doc =
        documentState.documents.find((d: any) => d.kind === 'invoice') ??
        (await api('/orders/' + a.id + '/documents', 'POST', { kind: 'invoice' }));
      f.document = doc.id;
      const full = await api('/orders/' + a.id);
      assert.equal(full.status, 'shipped');
      const r = await api(
        '/orders/' + a.id + '/returns',
        'POST',
        {
          client_key: randomUUID(),
          reason: 'QA zwrot po zbiorczej kompletacji',
          items: [{ item_id: full.items[0].id, quantity: 1 }],
        },
        201,
      );
      await api('/returns/' + r.id + '/receive', 'POST', {
        version: Number(r.version),
        shipping_refund: 0,
        note: 'QA zwrot do magazynu',
        items: [{ item_id: full.items[0].id, accepted: 1, restocked: 1 }],
      });
      f.return = r.id;
      f.finalized = true;
    }
    const stock = (
      await api('/inventory/snapshot?warehouse_id=' + f.warehouse + '&product_ids=' + f.product.id)
    ).data[0];
    assert.equal(stock.on_hand, f.finalized ? 9 : 12);
    assert.equal(stock.reserved, f.finalized ? 4 : 8);
    assert.equal((await api('/orders/' + f.orders[1].id)).status, 'picking');
    const currentFingerprints = await fingerprints(f.tenants);
    let background: any = null;
    if (
      mode === 'runtime' &&
      JSON.stringify(currentFingerprints.listings) !== JSON.stringify(f.before.listings)
    ) {
      // Accept only the two independently audited hourly Odoo observation updates; never a blanket exclusion.
      const diffs = JSON.parse(await readFile('data/picking-waves-drift079.json', 'utf8'));
      assert.equal(diffs.length, 2);
      const overlay: Record<string, unknown> = {};
      for (const d of diffs) {
        assert.deepEqual(d.columns, ['last_result']);
        const oldResult = structuredClone(d.before.last_result),
          newResult = structuredClone(d.after.last_result);
        assert.equal(newResult.odoo_catalog_sync.scope, 'local_simulation');
        for (const key of ['run_id', 'observed_at']) {
          delete oldResult.odoo_catalog_sync[key];
          delete newResult.odoo_catalog_sync[key];
        }
        assert.deepEqual(newResult, oldResult);
        const actual = (
          await pool.query('SELECT last_result FROM listings WHERE id=$1 AND tenant_id=$2', [
            d.id,
            d.tenant,
          ])
        ).rows[0];
        assert.deepEqual(
          actual.last_result,
          d.after.last_result,
          'A later change needs a new independent audit',
        );
        const job = (
          await pool.query(
            "SELECT id FROM jobs WHERE tenant_id=$1 AND kind='odoo.catalog.sync' AND state='done' AND payload->>'run_id'=$2",
            [d.tenant, d.after.last_result.odoo_catalog_sync.run_id],
          )
        ).rows[0];
        assert(job);
        overlay[d.id] = d.before.last_result;
      }
      const rows = (
        await pool.query(
          `SELECT (to_jsonb(t)||CASE WHEN $2::jsonb ? t.id::text THEN jsonb_build_object('last_result',$2::jsonb->t.id::text) ELSE '{}'::jsonb END)::text row FROM listings t WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1`,
          [f.tenants, JSON.stringify(overlay)],
        )
      ).rows;
      assert.deepEqual(
        {
          count: rows.length,
          sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
        },
        f.before.listings,
      );
      for (const table of tables.filter((t) => t !== 'listings'))
        assert.deepEqual(currentFingerprints[table], f.before[table]);
      background = {
        source: 'previous_hourly_odoo_local_simulation',
        changed_rows: 2,
        changed_paths: [
          'last_result.odoo_catalog_sync.run_id',
          'last_result.odoo_catalog_sync.observed_at',
        ],
        other_16_tables_exact: true,
        all_other_listing_fields_exact: true,
      };
    } else assert.deepEqual(currentFingerprints, f.before);
    f.cookie = cookie;
    await save(f);
    const receipt = {
      checked_at: new Date().toISOString(),
      revision: health.revision,
      schema: health.schema_revision,
      own_tenant: f.tenant,
      wave: f.wave,
      orders: 2,
      units: 8,
      scanned: 8,
      natural_locations: ['A2', 'A10'],
      completed: true,
      one_order_fulfilled: f.finalized ?? false,
      shipment_mode: 'DEMO',
      invoice_created: !!f.document,
      return_received: !!f.return,
      remaining_order_status: 'picking',
      stock: { on_hand: stock.on_hand, reserved: stock.reserved },
      previous_firms_unchanged: background ? null : f.tenants.length,
      previous_firms_compared: f.tenants.length,
      audited_background_change: background,
      business_tables_fingerprinted: tables.length,
      provider_http: 0,
      paid_operations: 0,
    };
    await writeFile(
      mode === 'runtime'
        ? 'data/picking-waves-runtime079.json'
        : 'docs/picking-waves-native-qa.json',
      JSON.stringify(receipt, null, 2) + '\n',
    );
    console.log(JSON.stringify(receipt));
  }
} finally {
  await pool.end();
}
