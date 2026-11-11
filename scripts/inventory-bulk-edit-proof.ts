/** Native QA107. Password/cookie persist only in ignored mode0600 state. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
import { verifyInventoryPreservation } from './inventory-preservation';
const path = 'data/inventory-bulk-edit-stage107.json',
  phase = process.argv[2];
let cookie = '';
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
async function api(url: string, method = 'GET', body?: unknown, expected = 200) {
  const r = await fetch('http://127.0.0.1:4100/api' + url, {
    method,
    headers: { cookie, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal(
    r.status,
    expected,
    url + ' HTTP ' + r.status + (r.status !== expected ? ' ' + (await r.text()) : ''),
  );
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
  return r.json() as Promise<any>;
}
async function snapshot(ids: string[], names: string[]) {
  const out: Record<string, string> = {},
    c = await pool.connect();
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
  s.preservation_proof = await verifyInventoryPreservation(s, undefined, { saveReport: true });
}

async function selection(ids: string[], warehouse: string) {
  return (
    await api('/inventory-bulk-edit/selection?warehouse_id=' + warehouse + '&ids=' + ids.join(','))
  ).data;
}
try {
  if (phase === 'baseline') {
    const h = await api('/health');
    assert.equal(h.schema_revision, '085_product_sku');
    const ids = (await pool.query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id);
    const users = (await pool.query('SELECT to_jsonb(u) row FROM users u ORDER BY id')).rows;
    const names = [
      'tenants',
      ...(
        await pool.query(
          "SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id' ORDER BY table_name",
        )
      ).rows.map((r) => r.table_name),
    ];
    const s = {
      baseline_revision: h.revision,
      ids,
      user_ids: users.map((u) => u.row.id),
      users_hash: hash(users),
      names,
      before: await snapshot(ids, names),
      created_at: new Date().toISOString(),
    };
    await writeFile(path, JSON.stringify(s, null, 2), { mode: 0o600, flag: 'wx' });
    console.log({ phase, firms: ids.length, users: users.length, tables: names.length });
  } else {
    const s = JSON.parse(await readFile(path, 'utf8')),
      h = await api('/health');
    assert.equal(h.schema_revision, '086_inventory_bulk_edit');
    assert.equal(h.inventory_bulk_edit_available, true);
    if (phase === 'review-operational') {
      assert(!s.tenant && !s.strict_names);
      const current = await snapshot(s.ids, s.names);
      const changed = s.names.filter((n: string) => current[n] !== s.before[n]);
      assert.deepEqual(changed.sort(), ['jobs', 'order_status_configs']);
      s.operational_exclusions = changed;
      s.strict_names = s.names.filter((n: string) => !changed.includes(n));
      s.operational_observed_hashes = Object.fromEntries(
        changed.map((n: string) => [n, current[n]]),
      );
      await preserved(s);
      await writeFile(
        'docs/inventory-bulk-edit-preservation-qa.json',
        JSON.stringify(
          {
            observed_tables: s.names.length,
            exact_static_tables: s.strict_names.length,
            changed_operational_tables: changed,
            original_baseline_retained: true,
            reason:
              'Active scheduleStatusesDue updates next_run_at/last_job_id every60s and creates/finishes order.status.scan jobs. No broad exact-preservation claim for these two operational tables. Actual backup verifies every table against its own source manifest.',
            source: 'server/order-status.ts scheduleStatusesDue; server/worker.ts tick',
            preserved_users: s.user_ids.length,
          },
          null,
          2,
        ),
      );
      await save(s);
      console.log({ phase, exact_tables: s.strict_names.length, operational_exclusions: changed });
    } else if (phase === 'exercise') {
      await preserved(s);
      assert(!s.tenant);
      s.runtime_revision = h.revision;
      s.email = 'qa-inventory-sheet107-' + randomUUID().slice(0, 8) + '@demo.local';
      s.password = 'DynaInventory!2026-' + randomUUID();
      const signup = await api(
        '/auth/signup',
        'POST',
        {
          email: s.email,
          password: s.password,
          name: 'QA arkusz magazynowy107',
          organization: { name: 'QA stany i lokalizacje107' },
        },
        201,
      );
      s.tenant = signup.user.tenant_id;
      s.user = signup.user.id;
      await save(s);
      await api('/workspaces/plan', 'PATCH', { plan: 'business' });
      s.warehouse = (await api('/warehouses')).data[0].id;
      s.second_warehouse = (
        await api('/warehouses', 'POST', { name: 'Magazyn drugi QA107', code: 'QA107-2' })
      ).id;
      s.products = [];
      for (let n = 0; n < 3; n++)
        s.products.push(
          await api(
            '/products',
            'POST',
            {
              name: ['Pomiar stanów QA107', 'Przesunięcie QA107', 'Drugi magazyn QA107'][n],
              sku: 'INVENTORY107-' + n,
              price: 1234,
              warehouse_id: s.warehouse,
              quantity: [100, 50, 0][n],
              location: 'A2',
            },
            201,
          ),
        );
      s.order = await api(
        '/orders',
        'POST',
        {
          customer_name: 'Kupujący QA107',
          email: 'buyer107@example.test',
          warehouse_id: s.warehouse,
          payment_mode: 'cod',
          items: [
            { product_id: s.products[0].id, quantity: 3 },
            { product_id: s.products[1].id, quantity: 2 },
          ],
        },
        201,
      );
      s.initial_rows = await selection(
        s.products.slice(0, 2).map((p: any) => p.id),
        s.warehouse,
      );
      s.reservation_before = (
        await pool.query(
          'SELECT to_jsonb(r) row FROM reservation_locations r WHERE tenant_id=$1 ORDER BY 1',
          [s.tenant],
        )
      ).rows;
      s.own_names = [
        ...s.names,
        'inventory_bulk_edit_previews',
        'inventory_bulk_edit_rows',
        'inventory_bulk_edit_executions',
        'inventory_bulk_edit_execution_rows',
      ];
      await save(s);
      await writeFile(
        'docs/inventory-bulk-edit-native-qa.json',
        JSON.stringify(
          {
            phase,
            runtime_revision: h.revision,
            schema: h.schema_revision,
            preserved_firms: s.ids.length,
            preserved_users: s.user_ids.length,
            preserved_tables: s.preservation_proof.original_tables_verified,
            preservation: s.preservation_proof,
            products: s.products.map((p: any) => ({ id: p.id, sku: p.sku, version: p.version })),
            warehouse: s.warehouse,
            second_warehouse: s.second_warehouse,
            order_id: s.order.id,
            status: 'PREPARED; UI count and move acceptance pending',
          },
          null,
          2,
        ),
      );
      console.log({ phase, tenant: s.tenant, products: 3, order: s.order.id });
    } else {
      await preserved(s);
      if (phase !== 'restart')
        await api('/auth/login', 'POST', { email: s.email, password: s.password });
      if (phase === 'accept-ui') {
        const rows = await selection(
          s.products.slice(0, 2).map((p: any) => p.id),
          s.warehouse,
        );
        assert.deepEqual(
          rows.map((r: any) => [r.sku, r.location, r.quantity, r.reserved]),
          [
            ['INVENTORY107-0', 'A2', 120, 3],
            ['INVENTORY107-1', 'A2', 43, 2],
            ['INVENTORY107-1', 'B1', 7, 0],
          ],
        );
        assert.deepEqual(
          (
            await pool.query(
              'SELECT to_jsonb(r) row FROM reservation_locations r WHERE tenant_id=$1 ORDER BY 1',
              [s.tenant],
            )
          ).rows,
          s.reservation_before,
        );
        for (const p of s.products) {
          const current = await api('/products/' + p.id);
          assert.equal(current.version, p.version);
          assert.equal(current.price, p.price);
          assert.equal(current.sku, p.sku);
        }
        assert.deepEqual((await api('/orders/' + s.order.id)).items, s.order.items);
        const history = await api('/inventory-bulk-edit/executions');
        assert.equal(history.data.length, 1);
        s.ui_execution = history.data[0];
        s.ui_verified = true;
        await save(s);
        console.log({ phase, execution: s.ui_execution.id, reservation_and_pim_exact: true });
      } else if (phase === 'fulfillment') {
        assert(s.ui_verified && !s.fulfilled);
        const [row] = await selection([s.products[2].id], s.second_warehouse);
        assert.equal(row.stock_version, null);
        const input = {
          client_key: randomUUID(),
          warehouse_id: s.second_warehouse,
          note: 'QA107 początkowy pomiar drugiego magazynu',
          rows: [
            {
              product_id: row.product_id,
              product_version: row.product_version,
              location: row.location,
              stock_version: null,
              operation: 'count',
              quantity: 5,
            },
          ],
        };
        const preview = (await api('/inventory-bulk-edit/previews', 'POST', input, 201)).preview;
        assert(preview.ready);
        const body = { client_key: randomUUID(), scope_hash: preview.scope_hash, confirmed: true };
        const execution = await api(
          '/inventory-bulk-edit/previews/' + preview.id + '/execute',
          'POST',
          body,
          201,
        );
        const replay = await api(
          '/inventory-bulk-edit/previews/' + preview.id + '/execute',
          'POST',
          body,
        );
        assert(replay.reused);
        assert.equal(replay.execution.id, execution.execution.id);
        assert.equal((await selection([s.products[2].id], s.second_warehouse))[0].quantity, 5);
        assert.equal((await selection([s.products[2].id], s.warehouse))[0].quantity, 0);
        await api('/orders/' + s.order.id + '/status', 'PATCH', { status: 'picking' });
        for (let n = 0; n < 2; n++)
          for (let q = 0; q < [3, 2][n]; q++)
            await api('/orders/' + s.order.id + '/scan', 'POST', {
              code: s.products[n].sku,
              location: 'A2',
            });
        await api('/orders/' + s.order.id + '/status', 'PATCH', { status: 'packed' });
        await api('/orders/' + s.order.id + '/ship-demo', 'POST', {});
        assert.equal((await selection([s.products[0].id], s.warehouse))[0].warehouse_on_hand, 117);
        assert.equal((await selection([s.products[1].id], s.warehouse))[0].warehouse_on_hand, 48);
        const returned = await api(
          '/orders/' + s.order.id + '/returns',
          'POST',
          {
            client_key: randomUUID(),
            reason: 'QA107 fizyczny zwrot',
            items: [
              {
                item_id: s.order.items.find((i: any) => i.product_id === s.products[0].id).id,
                quantity: 1,
              },
            ],
          },
          201,
        );
        await api('/returns/' + returned.id + '/receive', 'POST', {
          version: Number(returned.version),
          shipping_refund: 0,
          note: 'QA107 przyjęcie',
          items: [{ item_id: returned.items[0].item_id, accepted: 1, restocked: 1 }],
        });
        assert.equal((await selection([s.products[0].id], s.warehouse))[0].warehouse_on_hand, 118);
        const order = await api('/orders/' + s.order.id);
        assert.equal(order.status, 'shipped');
        assert.deepEqual(
          order.items.map(({ scanned, ...i }: any) => i),
          s.order.items.map(({ scanned, ...i }: any) => i),
        );
        assert(order.items.every((i: any) => i.scanned === i.quantity));
        s.fulfilled = true;
        s.return_id = returned.id;
        s.second_execution = execution.execution.id;
        await save(s);
        await writeFile(
          'docs/inventory-bulk-edit-fulfillment-qa.json',
          JSON.stringify(
            {
              phase,
              revision: h.revision,
              order_id: s.order.id,
              return_id: returned.id,
              second_warehouse_execution: execution.execution.id,
              exact_replay: true,
              frozen_sale_exact: true,
              counts_after_ship_and_return: [118, 48, 5],
              local_only: true,
            },
            null,
            2,
          ),
        );
        console.log({ phase, shipped_and_return_received: true });
      } else if (phase === 'accept-fulfillment') {
        assert(s.ui_verified && !s.fulfilled);
        const order = await api('/orders/' + s.order.id);
        assert.equal(order.status, 'shipped');
        assert.deepEqual(
          order.items.map(({ scanned, ...i }: any) => i),
          s.order.items.map(({ scanned, ...i }: any) => i),
        );
        assert(order.items.every((i: any) => i.scanned === i.quantity));
        assert.equal((await selection([s.products[0].id], s.warehouse))[0].warehouse_on_hand, 118);
        assert.equal((await selection([s.products[1].id], s.warehouse))[0].warehouse_on_hand, 48);
        assert.equal((await selection([s.products[2].id], s.second_warehouse))[0].quantity, 5);
        assert.equal((await selection([s.products[2].id], s.warehouse))[0].quantity, 0);
        const history = await api('/inventory-bulk-edit/executions');
        assert.equal(history.data.length, 2);
        const other = history.data.find((e: any) => e.id !== s.ui_execution.id);
        assert(other);
        const rows = (
          await pool.query(
            'SELECT id,received_at,state FROM return_cases WHERE tenant_id=$1 AND order_id=$2',
            [s.tenant, s.order.id],
          )
        ).rows;
        assert.equal(rows.length, 1);
        assert(rows[0].received_at);
        assert.equal(rows[0].state, 'refund_pending');
        const accepted = (
          await pool.query(
            'SELECT requested,accepted,restocked FROM return_items WHERE tenant_id=$1 AND return_id=$2',
            [s.tenant, rows[0].id],
          )
        ).rows;
        assert.deepEqual(accepted, [{ requested: 1, accepted: 1, restocked: 1 }]);
        s.fulfilled = true;
        s.return_id = rows[0].id;
        s.second_execution = other.id;
        await save(s);
        await writeFile(
          'docs/inventory-bulk-edit-fulfillment-qa.json',
          JSON.stringify(
            {
              phase,
              revision: h.revision,
              order_id: s.order.id,
              return_id: s.return_id,
              second_warehouse_execution: other.id,
              frozen_sale_exact: true,
              scanned_quantities: [3, 2],
              counts_after_ship_and_return: [118, 48, 5],
              local_only: true,
              note: 'Actions completed in fulfillment phase; its final comparison incorrectly included mutable scanned progress. This read-only phase verifies every frozen field and expected progress without repeating any stock/return operation.',
            },
            null,
            2,
          ),
        );
        console.log({ phase, shipped_and_return_received: true });
      } else if (phase === 'checkpoint') {
        assert(s.fulfilled);
        const pending = (
          await pool.query(
            "SELECT id,state FROM jobs WHERE tenant_id=$1 AND state NOT IN ('done','failed')",
            [s.tenant],
          )
        ).rows;
        assert.equal(
          pending.length,
          0,
          'Own asynchronous jobs still running; reobserve without restart',
        );
        s.jobs = (
          await pool.query(
            'SELECT id,kind,state,attempts,error FROM jobs WHERE tenant_id=$1 ORDER BY id',
            [s.tenant],
          )
        ).rows;
        assert(s.jobs.every((j: any) => j.state === 'done' && j.error === null));
        s.own_snapshot = await snapshot([s.tenant], s.own_names);
        s.checkpoint_revision = h.revision;
        await save(s);
        console.log({ phase, own_tables: s.own_names.length, settled_jobs: s.jobs.length });
      } else if (phase === 'restart') {
        assert(s.own_snapshot);
        assert.deepEqual(await snapshot([s.tenant], s.own_names), s.own_snapshot);
        if (s.runtime_revision !== h.revision) {
          assert.equal(
            h.revision,
            process.env.PROOF_REVISION,
            'Explicit reviewed runtime revision required',
          );
          s.prior_runtime_revision = s.runtime_revision;
          s.runtime_revision = h.revision;
          await save(s);
        }
        await writeFile(
          'docs/inventory-bulk-edit-restart-qa.json',
          JSON.stringify(
            {
              revision: h.revision,
              schema: h.schema_revision,
              preserved_firms: s.ids.length,
              preserved_users: s.user_ids.length,
              preserved_tables: s.preservation_proof.original_tables_verified,
              preservation: s.preservation_proof,
              own_tables_exact: s.own_names.length,
              jobs: s.jobs,
              status: 'PASS',
            },
            null,
            2,
          ),
        );
        console.log({ phase, status: 'PASS', own_tables: s.own_names.length });
      } else throw new Error('Unknown phase');
    }
  }
} finally {
  await pool.end();
}
