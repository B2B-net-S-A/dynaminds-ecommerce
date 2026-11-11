/** Local native QA106; credentials stay in ignored mode0600 state. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
const path = 'data/product-sku-stage106.json';
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
  const out: Record<string, string> = {};
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TIME ZONE 'Europe/Warsaw'");
    for (const n of names) {
      assert(/^[a-z][a-z0-9_]*$/.test(n));
      out[n] = hash(
        (
          await c.query(
            `SELECT to_jsonb(t) row FROM "${n}" t WHERE ${n === 'tenants' ? 'id' : 'tenant_id'}=ANY($1::uuid[]) ORDER BY 1`,
            [ids],
          )
        ).rows,
      );
    }
    await c.query('COMMIT');
    return out;
  } finally {
    c.release();
  }
}
const save = (s: any) => writeFile(path, JSON.stringify(s, null, 2), { mode: 0o600 });
async function preserved(s: any) {
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
}
try {
  if (phase === 'baseline') {
    const previous = JSON.parse(await readFile('data/product-logistics-stage105.json', 'utf8'));
    const health = await api('/health');
    assert.equal(health.schema_revision, '084_product_logistics_recovery');
    const ids = (await pool.query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id);
    const users = (await pool.query('SELECT id,email,name,password_hash FROM users ORDER BY id'))
      .rows;
    const names = [...previous.names, 'product_logistics'];
    const s = {
      baseline_revision: health.revision,
      ids,
      user_ids: users.map((u) => u.id),
      users_hash: hash(users),
      names,
      before: await snapshot(ids, names),
      own_names: [
        ...previous.own_names,
        'product_sku_aliases',
        'catalog_imports',
        'picking_waves',
        'picking_wave_orders',
        'picking_wave_scans',
      ],
      own_snapshot_timezone: 'Europe/Warsaw',
      created_at: new Date().toISOString(),
    };
    await writeFile(path, JSON.stringify(s, null, 2), { mode: 0o600, flag: 'wx' });
    console.log({ phase, firms: ids.length, users: users.length, tables: names.length });
  } else {
    const s = JSON.parse(await readFile(path, 'utf8'));
    const h = await api('/health');
    assert.equal(h.schema_revision, '085_product_sku');
    assert.equal(h.product_sku_edit_available, true);
    if (phase === 'exercise') {
      assert(!s.tenant);
      await preserved(s);
      s.runtime_revision = h.revision;
      s.email = 'qa-product-sku106@demo.local';
      s.password = 'DynaSku!2026-' + randomUUID();
      const signup = await api(
        '/auth/signup',
        'POST',
        {
          email: s.email,
          password: s.password,
          name: 'QA SKU106',
          organization: { name: 'QA SKU i importy106' },
        },
        201,
      );
      s.tenant = signup.user.tenant_id;
      s.user = signup.user.id;
      await save(s);
      s.warehouse = (await api('/warehouses')).data[0].id;
      s.products = [];
      for (let i = 0; i < 2; i++) {
        s.products.push(
          await api(
            '/products',
            'POST',
            {
              sku: 'QA106-SKU-' + i,
              name: 'Produkt SKU106-' + i,
              price: 1234,
              quantity: 100,
              warehouse_id: s.warehouse,
              location: 'A2',
              weight_grams: 1250,
            },
            201,
          ),
        );
        await save(s);
      }
      s.orders = [];
      for (const [index, quantity] of [
        [0, 3],
        [1, 1],
        [1, 1],
      ]) {
        s.orders.push(
          await api(
            '/orders',
            'POST',
            {
              customer_name: 'QA106',
              email: 'sku106@example.test',
              warehouse_id: s.warehouse,
              payment_mode: 'cod',
              items: [{ product_id: s.products[index].id, quantity }],
            },
            201,
          ),
        );
        await save(s);
      }
      s.protected_names = [
        'stock',
        'stock_movements',
        'orders',
        'order_items',
        'order_pick_items',
        'reservations',
        'bundle_components',
        'listings',
      ];
      s.protected_before = await snapshot([s.tenant], s.protected_names);
      await save(s);
      await writeFile(
        'docs/product-sku-native-qa.json',
        JSON.stringify(
          {
            source: h.revision,
            schema: h.schema_revision,
            prior_firms: s.ids.length,
            prior_users: s.user_ids.length,
            preserved_tables: s.names.length,
            own_products: s.products.map((p: any) => ({
              id: p.id,
              sku: p.sku,
              version: p.version,
            })),
            own_order_ids: s.orders.map((o: any) => o.id),
            protected_tables: s.protected_names,
            outcome: 'API preparation passed; UI and final acceptance pending',
          },
          null,
          2,
        ),
      );
    } else {
      assert.equal(h.revision, s.runtime_revision);
      await api('/auth/login', 'POST', { email: s.email, password: s.password });
      await preserved(s);
      if (phase === 'accept-ui') {
        assert.deepEqual(await snapshot([s.tenant], s.protected_names), s.protected_before);
        const products = await Promise.all(s.products.map((p: any) => api('/products/' + p.id)));
        assert.equal(products[0].sku, 'QA106-CURRENT-0');
        assert.equal(products[1].sku, 'QA106-CURRENT-1');
        assert.equal(products[0].version, 3);
        assert.equal(products[1].version, 2);
        const aliases = (
          await pool.query(
            'SELECT sku,product_id FROM product_sku_aliases WHERE tenant_id=$1 ORDER BY sku',
            [s.tenant],
          )
        ).rows;
        assert.equal(aliases.length, 5);
        s.aliases = aliases;
        s.ui_verified = true;
        s.current_products = products;
        s.own_snapshot = await snapshot([s.tenant], s.own_names);
        await save(s);
        await writeFile(
          'docs/product-sku-ui-qa.json',
          JSON.stringify(
            {
              source: h.revision,
              schema: h.schema_revision,
              products: products.map((p: any) => ({ id: p.id, sku: p.sku, version: p.version })),
              aliases,
              protected_tables_exact: s.protected_names,
              prior_firms: s.ids.length,
              prior_tables_exact: s.names.length,
              outcome:
                'card and fifteen-field sheet persisted; protected commerce snapshots unchanged',
            },
            null,
            2,
          ),
        );
      } else if (phase === 'fulfillment') {
        assert(s.ui_verified && !s.fulfillment_verified);
        // UI CSV may change catalogue fields; commerce is still untouched at this checkpoint.
        assert.deepEqual(await snapshot([s.tenant], s.protected_names), s.protected_before);
        const imported = await api('/products/' + s.products[0].id);
        assert.equal(imported.sku, 'QA106-CURRENT-0');
        assert.equal(imported.version, 4);
        assert.equal(imported.name, 'Produkt SKU106-0 po imporcie');
        assert.equal(imported.price, 1234);
        const imports = (
          await pool.query(
            "SELECT * FROM catalog_imports WHERE tenant_id=$1 AND status='applied'",
            [s.tenant],
          )
        ).rows;
        assert.equal(imports.length, 1);
        assert.equal(imports[0].rows[0].resolved_product_id, s.products[0].id);
        assert.equal(imports[0].rows[0].matched_historical_sku, true);
        const replay = await api('/catalog/imports/' + imports[0].id + '/apply', 'POST', {});
        assert.equal(replay.reused, true);
        assert.equal((await api('/products/' + s.products[0].id)).version, 4);
        s.ui_snapshot = s.own_snapshot;
        const original = s.orders[0];
        await api('/orders/' + original.id + '/status', 'PATCH', { status: 'picking' });
        for (const code of ['QA106-SKU-0', 'QA106-MIDDLE-0', 'QA106-CURRENT-0'])
          await api('/orders/' + original.id + '/scan', 'POST', { code, location: 'A2' });
        const picked = await api('/orders/' + original.id);
        assert.equal(picked.picking_items[0].sku, 'QA106-SKU-0');
        assert.equal(picked.picking_items[0].scanned, 3);
        const sale = (o: any) =>
          o.items.map((i: any) => [
            i.id,
            i.product_id,
            i.sku,
            i.quantity,
            i.price,
            i.line_total,
            i.vat,
            i.components,
          ]);
        assert.deepEqual(sale(picked), sale(original));
        await api('/orders/' + original.id + '/status', 'PATCH', { status: 'packed' });
        const shipped = await api('/orders/' + original.id + '/ship-demo', 'POST', {});
        assert.equal(shipped.status, 'shipped');
        assert.equal((await api('/products/' + s.products[0].id)).stock[0].on_hand, 97);
        const input = {
          warehouse_id: s.warehouse,
          order_ids: s.orders.slice(1).map((o: any) => o.id),
        };
        const preview = await api('/picking-waves/preview', 'POST', input);
        let wave = await api(
          '/picking-waves',
          'POST',
          {
            ...input,
            name: 'QA106 aliasy',
            client_key: randomUUID(),
            preview_hash: preview.preview_hash,
          },
          201,
        );
        for (const code of ['QA106-SKU-1', 'QA106-CURRENT-1'])
          wave = await api('/picking-waves/' + wave.wave.id + '/scans', 'POST', {
            version: wave.wave.version,
            client_key: randomUUID(),
            code,
            location: 'A2',
          });
        assert.equal(wave.progress.scanned, 2);
        for (const o of s.orders.slice(1)) {
          const detail = await api('/orders/' + o.id);
          assert.deepEqual(sale(detail), sale(o));
          assert.equal(detail.picking_items[0].sku, 'QA106-SKU-1');
          assert.equal(detail.picking_items[0].scanned, 1);
        }
        s.wave_id = wave.wave.id;
        s.preview_id = (
          await pool.query('SELECT id FROM catalog_bulk_edit_previews WHERE tenant_id=$1', [
            s.tenant,
          ])
        ).rows[0].id;
        s.execution_id = (
          await pool.query('SELECT id FROM catalog_bulk_edit_executions WHERE tenant_id=$1', [
            s.tenant,
          ])
        ).rows[0].id;
        s.current_products = await Promise.all(
          s.products.map((p: any) => api('/products/' + p.id)),
        );
        s.fulfillment_verified = true;
        s.own_snapshot = await snapshot([s.tenant], s.own_names);
        await save(s);
        await writeFile(
          'docs/product-sku-fulfillment-qa.json',
          JSON.stringify(
            {
              source: h.revision,
              schema: h.schema_revision,
              csv: {
                created: 0,
                updated: 1,
                current_sku: imported.sku,
                version: imported.version,
                replay: true,
              },
              ordinary: {
                order_id: original.id,
                frozen_sku: 'QA106-SKU-0',
                accepted_codes: ['QA106-SKU-0', 'QA106-MIDDLE-0', 'QA106-CURRENT-0'],
                scanned: 3,
                status: 'shipped',
                on_hand: 97,
              },
              wave: {
                id: s.wave_id,
                accepted_codes: ['QA106-SKU-1', 'QA106-CURRENT-1'],
                scanned: 2,
              },
              sale_snapshots_exact: true,
              own_tables: s.own_names.length,
              outcome: 'PASS; fulfillment is local DEMO, no provider writes',
            },
            null,
            2,
          ),
        );
      } else if (phase === 'settle') {
        assert(s.fulfillment_verified && !s.settled);
        const current = await snapshot([s.tenant], s.own_names);
        const changed = s.own_names.filter((n: string) => current[n] !== s.own_snapshot[n]);
        assert.deepEqual(changed, ['jobs']);
        const jobs = (
          await pool.query(
            'SELECT id,kind,state,attempts,error FROM jobs WHERE tenant_id=$1 ORDER BY id',
            [s.tenant],
          )
        ).rows;
        assert.equal(jobs.length, 13);
        assert(
          jobs.every(
            (j) =>
              j.kind === 'automation' && j.state === 'done' && j.attempts === 1 && j.error === null,
          ),
        );
        assert.equal(
          (
            await pool.query('SELECT count(*)::int n FROM automation_rules WHERE tenant_id=$1', [
              s.tenant,
            ])
          ).rows[0].n,
          0,
        );
        assert.equal(
          (
            await pool.query('SELECT count(*)::int n FROM automation_runs WHERE tenant_id=$1', [
              s.tenant,
            ])
          ).rows[0].n,
          0,
        );
        const report = {
          source: h.revision,
          changed_tables: changed,
          accepted_before_hash: s.own_snapshot.jobs,
          settled_hash: current.jobs,
          terminal_jobs: jobs,
          outcome:
            'Initial restart comparison detected completion of queued local automation checks only; commerce/evidence85 tables exact. Accepted explicit terminal checkpoint; another full restart required.',
        };
        await writeFile('docs/product-sku-settlement-qa.json', JSON.stringify(report, null, 2));
        s.own_pre_settlement_snapshot = s.own_snapshot;
        s.own_snapshot = current;
        s.settled = true;
        await save(s);
      } else if (phase === 'restart') {
        assert(s.ui_verified && s.own_snapshot);
        assert.deepEqual(await snapshot([s.tenant], s.own_names), s.own_snapshot);
        await writeFile(
          'docs/product-sku-restart-qa.json',
          JSON.stringify(
            {
              source: h.revision,
              schema: h.schema_revision,
              own_tables_exact: s.own_names.length,
              prior_firms: s.ids.length,
              prior_users: s.user_ids.length,
              prior_tables_exact: s.names.length,
              outcome: 'PASS',
            },
            null,
            2,
          ),
        );
      } else throw Error('Unknown phase');
    }
    console.log({ phase, source: h.revision, schema: h.schema_revision, outcome: 'PASS' });
  }
} finally {
  await pool.end();
}
