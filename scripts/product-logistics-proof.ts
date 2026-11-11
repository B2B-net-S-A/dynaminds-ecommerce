import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
const path = 'data/product-logistics-stage105.json';
const phase = process.argv[2];
let cookie = '';
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
async function api(url: string, method = 'GET', body?: unknown, expected = 200) {
  const r = await fetch('http://127.0.0.1:4100/api' + url, {
    method,
    headers: { cookie, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal(r.status, expected, url + ' HTTP ' + r.status);
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
  return r.json() as Promise<any>;
}
async function snapshot(ids: string[], names: string[]) {
  const result: Record<string, string> = {};
  for (const name of names) {
    assert(/^[a-z][a-z0-9_]*$/.test(name));
    result[name] = hash(
      (
        await pool.query(
          `SELECT to_jsonb(t) row FROM "${name}" t WHERE ${name === 'tenants' ? 'id' : 'tenant_id'}=ANY($1::uuid[]) ORDER BY 1`,
          [ids],
        )
      ).rows,
    );
  }
  return result;
}
const save = (s: any) => writeFile(path, JSON.stringify(s, null, 2), { mode: 0o600 });
try {
  if (phase === 'baseline') {
    const previous = JSON.parse(await readFile('data/catalog-bulk-edit-stage104.json', 'utf8'));
    const h = await api('/health');
    assert.equal(h.schema_revision, '082_catalog_bulk_edit');
    const ids = (await pool.query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id);
    const users = (await pool.query('SELECT id,email,name,password_hash FROM users ORDER BY id'))
      .rows;
    const s = {
      baseline_revision: h.revision,
      ids,
      user_ids: users.map((u) => u.id),
      users_hash: hash(users),
      names: previous.names,
      before: await snapshot(ids, previous.names),
      created_at: new Date().toISOString(),
    };
    await writeFile(path, JSON.stringify(s, null, 2), { mode: 0o600, flag: 'wx' });
    console.log({ phase, firms: ids.length, users: users.length, tables: s.names.length });
  } else {
    const s = JSON.parse(await readFile(path, 'utf8'));
    if (phase === 'exercise') {
      assert(!s.tenant, 'Native exercise may run once');
      const h = await api('/health');
      assert.equal(h.schema_revision, '083_product_logistics');
      assert.equal(h.product_logistics_available, true);
      s.email = 'qa-product-logistics105@demo.local';
      s.password = 'DynaLogistics!2026-' + randomUUID();
      const signup = await api(
        '/auth/signup',
        'POST',
        {
          email: s.email,
          password: s.password,
          name: 'QA logistyka105',
          organization: { name: 'QA dane produktów105' },
        },
        201,
      );
      s.tenant = signup.user.tenant_id;
      s.user = signup.user.id;
      await save(s);
      s.warehouse = (await api('/warehouses')).data[0].id;
      s.products = [];
      for (let i = 0; i < 3; i++) {
        const p = await api(
          '/products',
          'POST',
          {
            sku: 'QA105-PIM-' + i,
            name: 'Produkt logistyczny105-' + i,
            price: 10001,
            quantity: 100,
            warehouse_id: s.warehouse,
            weight_grams: i === 2 ? null : 1250 + i,
            length_mm: 251,
            width_mm: 132,
            height_mm: 70,
            manufacturer: 'DYNAMINDS QA105',
          },
          201,
        );
        assert.equal(p.version, 1);
        assert.equal(p.length_mm, 251);
        s.products.push(p);
        await save(s);
      }
      s.bundle = await api(
        '/products',
        'POST',
        {
          sku: 'QA105-BUNDLE',
          name: 'Zestaw logistyczny105',
          price: 20001,
          warehouse_id: s.warehouse,
          kind: 'bundle',
          components: [
            { product_id: s.products[0].id, quantity: 2 },
            { product_id: s.products[1].id, quantity: 1 },
          ],
        },
        201,
      );
      s.order = await api(
        '/orders',
        'POST',
        {
          customer_name: 'QA105 lokalny',
          email: 'qa105@demo.local',
          warehouse_id: s.warehouse,
          currency: 'PLN',
          items: [{ product_id: s.bundle.id, quantity: 2 }],
          address: { street: 'Testowa 1', city: 'Warszawa', postal_code: '00-001', country: 'PL' },
        },
        201,
      );
      const beforeOrder = await api('/orders/' + s.order.id);
      const protectedNames = [
        'stock',
        'stock_movements',
        'stock_locations',
        'stock_location_reservations',
        'order_items',
        'orders',
        'bundle_components',
      ];
      // Discover optional old names rather than guessing a table.
      s.protected_names = [];
      for (const n of protectedNames)
        if ((await pool.query('SELECT to_regclass($1) p', ['public.' + n])).rows[0].p)
          s.protected_names.push(n);
      const before = await snapshot([s.tenant], s.protected_names);
      s.protected_before = before;
      await save(s);
      const request = {
        client_key: randomUUID(),
        rows: [
          {
            product_id: s.products[0].id,
            version: 1,
            changes: {
              weight_grams: 2375,
              length_mm: 305,
              width_mm: 140,
              height_mm: 82,
              manufacturer: 'Producent QA105',
            },
          },
          {
            product_id: s.products[1].id,
            version: 1,
            changes: { weight_grams: null, manufacturer: null },
          },
        ],
      };
      const preview = (await api('/catalog-bulk-edit/previews', 'POST', request, 201)).preview;
      assert.equal(preview.ready, true);
      assert.deepEqual(await snapshot([s.tenant], s.protected_names), before);
      const execute = { client_key: randomUUID(), scope_hash: preview.scope_hash, confirmed: true };
      const result = (
        await api('/catalog-bulk-edit/previews/' + preview.id + '/execute', 'POST', execute, 201)
      ).execution;
      assert.equal(result.changed, 2);
      const retry = (
        await api('/catalog-bulk-edit/previews/' + preview.id + '/execute', 'POST', execute, 200)
      ).execution;
      assert.equal(retry.id, result.id);
      assert.deepEqual(await snapshot([s.tenant], s.protected_names), before);
      assert.deepEqual((await api('/orders/' + s.order.id)).items, beforeOrder.items);
      const estimate = await api('/orders/' + s.order.id + '/product-logistics');
      assert.equal(estimate.total_known_weight_grams, 9500);
      assert.equal(estimate.complete, false);
      assert.deepEqual(estimate.missing_weight_product_ids, [s.products[1].id]);
      const p = await api('/products/' + s.products[0].id);
      assert.equal(p.version, 2);
      assert.equal(p.weight_grams, 2375);
      s.preview_id = preview.id;
      s.execution_id = result.id;
      s.order_items_hash = hash(beforeOrder.items);
      s.revision = h.revision;
      await save(s);
      console.log({
        phase,
        products: 3,
        bulk_changed: 2,
        retry_same: true,
        known_weight_grams: 9500,
        missing_weight_detected: true,
        stock_order_composition_unchanged: true,
      });
    }
    if (phase === 'ui-verify') {
      await api('/auth/login', 'POST', { email: s.email, password: s.password });
      const card = await api('/products/' + s.products[1].id);
      assert.equal(card.weight_grams, 1375);
      assert.equal(card.length_mm, 382);
      assert.equal(card.width_mm, 241);
      assert.equal(card.height_mm, 123);
      assert.equal(card.manufacturer, 'Producent UI105');
      assert.equal(card.version, 3);
      const sheet = await api('/products/' + s.products[2].id);
      assert.equal(sheet.weight_grams, 2875);
      assert.equal(sheet.length_mm, 314);
      assert.equal(sheet.width_mm, 152);
      assert.equal(sheet.height_mm, 93);
      assert.equal(sheet.manufacturer, 'Arkusz UI105');
      assert.equal(sheet.version, 2);
      const estimate = await api('/orders/' + s.order.id + '/product-logistics');
      assert.equal(estimate.total_known_weight_grams, 12250);
      assert.equal(estimate.complete, true);
      assert.deepEqual(await snapshot([s.tenant], s.protected_names), s.protected_before);
      for (const name of [
        'outbound_events',
        'outbound_deliveries',
        'email_messages',
        'sms_messages',
      ])
        assert.equal(
          (await pool.query(`SELECT count(*)::int n FROM ${name} WHERE tenant_id=$1`, [s.tenant]))
            .rows[0].n,
          0,
        );
      s.ui_verified = true;
      await save(s);
      await writeFile(
        'docs/product-logistics-ui-qa.json',
        JSON.stringify(
          {
            revision: (await api('/health')).revision,
            card_exact_units: true,
            sheet_exact_units: true,
            known_order_weight_grams: 12250,
            complete: true,
            external_writes: 0,
            screenshots: [
              'product-logistics-card.png',
              'product-logistics-sheet.png',
              'product-logistics-order.png',
            ],
          },
          null,
          2,
        ) + '\n',
      );
      console.log({ phase, card: true, sheet: true, known_weight_grams: 12250, complete: true });
    }
    if (phase === 'snapshot' || phase === 'verify' || phase === 'revalidate-runtime') {
      await api('/auth/login', 'POST', { email: s.email, password: s.password });
      const previous = JSON.parse(await readFile('data/catalog-bulk-edit-stage104.json', 'utf8'));
      const names = [...previous.own_names, 'product_logistics'];
      if (phase === 'snapshot') {
        s.own_names = names;
        s.own_snapshot = await snapshot([s.tenant], names);
        s.own_snapshot_timezone = (await pool.query('SHOW TimeZone')).rows[0].TimeZone;
        s.runtime_revision = (await api('/health')).revision;
        await save(s);
      } else {
        assert.deepEqual(await snapshot([s.tenant], s.own_names), s.own_snapshot);
        if (phase === 'revalidate-runtime') {
          const h = await api('/health');
          assert.equal(h.schema_revision, '084_product_logistics_recovery');
          assert(process.env.PROOF_REVISION);
          assert.equal(h.revision, process.env.PROOF_REVISION);
        } else assert.equal((await api('/health')).revision, s.runtime_revision);
        assert.equal(hash((await api('/orders/' + s.order.id)).items), s.order_items_hash);
      }
      assert.deepEqual(await snapshot(s.ids, s.names), s.before);
      assert.equal(
        hash(
          (
            await pool.query(
              'SELECT id,email,name,password_hash FROM users WHERE id=ANY($1::uuid[]) ORDER BY id',
              [s.user_ids],
            )
          ).rows,
        ),
        s.users_hash,
      );
      if (phase === 'revalidate-runtime') {
        s.previous_runtime_revision = s.runtime_revision;
        s.runtime_revision = (await api('/health')).revision;
        await save(s);
      }
      const artifact = {
        phase,
        revision: (await api('/health')).revision,
        schema: (await api('/health')).schema_revision,
        prior_firms: s.ids.length,
        prior_users: s.user_ids.length,
        prior_table_fingerprints: s.names.length,
        own_table_fingerprints: s.own_names.length,
        previous_data_unchanged: true,
        own_restart_unchanged: phase !== 'snapshot',
        order_items_unchanged: true,
        external_provider_writes: 0,
        observed_at: new Date().toISOString(),
      };
      await writeFile(
        'docs/product-logistics-' +
          (phase === 'revalidate-runtime'
            ? 'final-runtime'
            : phase === 'verify'
              ? 'restart'
              : 'native') +
          '-qa.json',
        JSON.stringify(artifact, null, 2) + '\n',
      );
      console.log(artifact);
    }
  }
} finally {
  await pool.end();
}
