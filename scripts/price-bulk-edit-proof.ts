/** Local QA108. Generated credentials live only in ignored mode0600 state. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';

const statePath = 'data/price-bulk-edit-stage108.json';
const phase = process.argv[2];
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
let cookie = '';
async function api(path: string, method = 'GET', body?: unknown, status = 200) {
  const response = await fetch('http://127.0.0.1:4100/api' + path, {
    method,
    headers: { cookie, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal(
    response.status,
    status,
    path +
      ': ' +
      response.status +
      (response.status !== status ? ' ' + (await response.text()) : ''),
  );
  const nextCookie = response.headers.get('set-cookie');
  if (nextCookie) cookie = nextCookie.split(';')[0];
  return response.json() as Promise<any>;
}
async function snapshot(ids: string[], names: string[]) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    const result: Record<string, string> = {};
    for (const name of names) {
      assert(/^[a-z][a-z0-9_]*$/.test(name));
      result[name] = hash(
        (
          await client.query(
            `SELECT to_jsonb(t) row FROM "${name}" t WHERE ${name === 'tenants' ? 'id' : 'tenant_id'}=ANY($1::uuid[]) ORDER BY 1`,
            [ids],
          )
        ).rows,
      );
    }
    await client.query('COMMIT');
    return result;
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}
const save = (state: any) => writeFile(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
async function preserved(state: any) {
  assert.deepEqual(await snapshot(state.ids, state.protected_names), state.before);
  const users = (
    await pool.query('SELECT to_jsonb(u) row FROM users u WHERE id=ANY($1::uuid[]) ORDER BY id', [
      state.user_ids,
    ])
  ).rows;
  assert.equal(hash(users), state.users_hash);
}

async function allSelection(ids: string[], listId: string) {
  const rows: any[] = [];
  let frozenList: any;
  for (let start = 0; start < ids.length; start += 50) {
    let cursor: string | null = null;
    do {
      const response = await api(
        '/price-bulk-edit/selection?price_list_id=' +
          listId +
          '&ids=' +
          ids.slice(start, start + 50).join(',') +
          (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
      );
      if (frozenList) assert.deepEqual(response.list, frozenList);
      frozenList = response.list;
      rows.push(...response.data);
      cursor = response.meta.cursor;
    } while (cursor);
  }
  assert.equal(rows.length, ids.length);
  assert.equal(new Set(rows.map((row) => row.product_id)).size, ids.length);
  assert.deepEqual(rows.map((row) => row.product_id).sort(), [...ids].sort());
  return { rows, list: frozenList };
}
async function allRows(path: string) {
  const rows: any[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const response = await api(path + (cursor ? '?cursor=' + cursor : ''));
    for (const row of response.data) {
      assert.equal(
        row.index,
        rows.length,
        'Receipt indices must be contiguous without repeated pages',
      );
      rows.push(row);
    }
    cursor = response.meta.cursor;
    if (cursor) {
      assert(!cursors.has(cursor), 'A receipt cursor repeated');
      cursors.add(cursor);
    }
  } while (cursor);
  return rows;
}
async function execute(preview: any, ack = false) {
  const body = {
    client_key: randomUUID(),
    scope_hash: preview.scope_hash,
    confirmed: true,
    ack_missing_prices: ack,
  };
  const response = await api(
    '/price-bulk-edit/previews/' + preview.id + '/execute',
    'POST',
    body,
    201,
  );
  const replay = await api('/price-bulk-edit/previews/' + preview.id + '/execute', 'POST', body);
  assert(replay.reused);
  assert.equal(replay.execution.id, response.execution.id);
  assert.deepEqual(replay.execution, response.execution);
  return response.execution;
}

try {
  if (phase === 'baseline') {
    const health = await api('/health');
    assert.equal(health.schema_revision, '086_inventory_bulk_edit');
    const ids = (await pool.query('SELECT id FROM tenants ORDER BY id')).rows.map((row) => row.id);
    const users = (await pool.query('SELECT to_jsonb(u) row FROM users u ORDER BY id')).rows;
    const protectedNames = [
      'tenants',
      'products',
      'price_lists',
      'price_list_items',
      'orders',
      'order_items',
      'reservations',
      'reservation_locations',
      'stock',
      'stock_locations',
      'stock_movements',
      'stock_location_movements',
      'stock_location_operations',
      'listings',
      'offer_plans',
      'shipments',
      'documents',
    ];
    const state = {
      baseline_revision: health.revision,
      created_at: new Date().toISOString(),
      ids,
      user_ids: users.map((user) => user.row.id),
      users_hash: hash(users),
      protected_names: protectedNames,
      before: await snapshot(ids, protectedNames),
    };
    await writeFile(statePath, JSON.stringify(state, null, 2), { mode: 0o600, flag: 'wx' });
    console.log({
      phase,
      earlier_firms: ids.length,
      earlier_users: users.length,
      exact_business_tables: protectedNames.length,
    });
  } else {
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    const health = await api('/health');
    assert.equal(health.schema_revision, '087_price_bulk_edit');
    assert.equal(health.price_bulk_edit_available, true);
    await preserved(state);
    if (phase === 'prepare') {
      assert(!state.tenant, 'QA108 is already prepared; do not create another workspace');
      state.runtime_revision = health.revision;
      state.email = 'qa-price-sheet108-' + randomUUID().slice(0, 8) + '@demo.local';
      state.password = 'DynaPrices!2026-' + randomUUID();
      const signup = await api(
        '/auth/signup',
        'POST',
        {
          email: state.email,
          password: state.password,
          name: 'QA arkusz cen108',
          organization: { name: 'QA cenniki108' },
        },
        201,
      );
      state.tenant = signup.user.tenant_id;
      state.user = signup.user.id;
      state.cookie = cookie;
      await save(state);
      await api('/workspaces/plan', 'PATCH', { plan: 'business' });
      state.warehouse = (await api('/warehouses')).data[0].id;
      state.products = [];
      for (let index = 0; index < 3; index++) {
        state.products.push(
          await api(
            '/products',
            'POST',
            {
              name: ['Cena netto QA108', 'Dziedziczenie QA108', 'Własna cena zero QA108'][index],
              sku: 'PRICE108-' + index,
              price: 10001,
              vat: [23, 8, 0][index],
              warehouse_id: state.warehouse,
              quantity: 30,
              location: 'C108',
            },
            201,
          ),
        );
      }
      state.pln = await api(
        '/price-lists',
        'POST',
        {
          name: 'Hurt PLN QA108',
          currency: 'PLN',
          fallback: true,
          adjustment_bps: 500,
          adjustment_amount: 19,
        },
        201,
      );
      state.pln = await api('/price-lists/' + state.pln.id + '/items', 'PUT', {
        version: state.pln.version,
        items: state.products.map((product: any, index: number) => ({
          product_id: product.id,
          price: index === 2 ? 0 : 15000,
        })),
      });
      state.eur = await api(
        '/price-lists',
        'POST',
        { name: 'Eksport EUR QA108', currency: 'EUR' },
        201,
      );
      state.eur = await api('/price-lists/' + state.eur.id + '/items', 'PUT', {
        version: state.eur.version,
        items: state.products.map((product: any) => ({ product_id: product.id, price: 999 })),
      });
      state.old_order = await api(
        '/orders',
        'POST',
        {
          customer_name: 'Kupujący QA108',
          email: 'buyer108@example.test',
          warehouse_id: state.warehouse,
          currency: 'EUR',
          price_list_id: state.eur.id,
          payment_mode: 'cod',
          items: [{ product_id: state.products[0].id, quantity: 2 }],
        },
        201,
      );
      state.stable_names = [
        'products',
        'orders',
        'order_items',
        'reservations',
        'reservation_locations',
        'stock',
        'stock_locations',
        'stock_movements',
        'stock_location_movements',
        'listings',
        'offer_plans',
        'shipments',
        'documents',
      ];
      state.stable_before = await snapshot([state.tenant], state.stable_names);
      await save(state);
      await writeFile(
        'docs/price-bulk-edit-native-qa.json',
        JSON.stringify(
          {
            status: 'PREPARED; UI and execution acceptance pending',
            revision: health.revision,
            schema: health.schema_revision,
            tenant: state.tenant,
            products: state.products.map((product: any) => ({
              id: product.id,
              sku: product.sku,
              vat: product.vat,
              version: product.version,
            })),
            price_lists: [state.pln, state.eur].map((list: any) => ({
              id: list.id,
              name: list.name,
              currency: list.currency,
              version: list.version,
            })),
            old_order: state.old_order.id,
            earlier_firms: state.ids.length,
            earlier_users: state.user_ids.length,
            business_tables_exact: state.protected_names.length,
          },
          null,
          2,
        ),
      );
      console.log({
        phase,
        tenant: state.tenant,
        products: 3,
        lists: 2,
        frozen_order: state.old_order.id,
      });
    } else if (phase === 'accept-ui') {
      cookie = state.cookie;
      assert.deepEqual(await snapshot([state.tenant], state.stable_names), state.stable_before);
      const selected = await allSelection(
        state.products.map((product: any) => product.id),
        state.pln.id,
      );
      const bySku = new Map<string, any>(selected.rows.map((row: any) => [row.sku, row]));
      assert.equal(bySku.get('PRICE108-0').override_price, 12301);
      assert.equal(bySku.get('PRICE108-1').override_present, false);
      assert.equal(bySku.get('PRICE108-1').effective_price, 10520);
      assert.equal(bySku.get('PRICE108-2').override_price, 0);
      assert.equal(selected.list.version, 3);
      const history = await api('/price-bulk-edit/executions');
      assert.equal(history.data.length, 1);
      state.ui_execution = history.data[0];
      const rows = await allRows('/price-bulk-edit/executions/' + state.ui_execution.id + '/rows');
      assert.equal(rows.length, 3);
      assert.equal(state.ui_execution.changed, 2);
      assert.equal(state.ui_execution.unchanged, 1);
      const netRow = rows.find((row: any) => row.sku === 'PRICE108-0');
      assert.equal(netRow.input.basis, 'net');
      assert.equal(netRow.input.amount_minor, 10001);
      assert.equal(netRow.before.vat, 23);
      assert.equal(netRow.after.override_price, 12301);
      const removedRow = rows.find((row: any) => row.sku === 'PRICE108-1');
      assert.equal(removedRow.input.operation, 'remove');
      assert.equal(removedRow.after.override_present, false);
      assert.equal(removedRow.after.source, 'rule');
      assert.equal(removedRow.after.effective_price, 10520);
      const zeroRow = rows.find((row: any) => row.sku === 'PRICE108-2');
      assert.equal(zeroRow.input.operation, 'none');
      assert.equal(zeroRow.status, 'unchanged');
      assert.equal(zeroRow.after.override_present, true);
      assert.equal(zeroRow.after.override_price, 0);
      state.ui_verified = true;
      await save(state);
      console.log({
        phase,
        net_10001_to_gross_12301: true,
        remove_to_rule_10520: true,
        own_zero_retained: true,
        pim_stock_old_order_exact: true,
      });
    } else if (phase === 'exercise') {
      cookie = state.cookie;
      assert(state.ui_verified && !state.exercised);
      assert.deepEqual(await snapshot([state.tenant], state.stable_names), state.stable_before);
      const foreign = await allSelection([state.products[0].id], state.eur.id);
      const preview = (
        await api(
          '/price-bulk-edit/previews',
          'POST',
          {
            client_key: randomUUID(),
            price_list_id: state.eur.id,
            list_version: foreign.list.version,
            rows: [
              {
                product_id: state.products[0].id,
                product_version: state.products[0].version,
                operation: 'remove',
              },
            ],
          },
          201,
        )
      ).preview;
      assert(preview.ready && preview.missing_after_count === 1);
      await api(
        '/price-bulk-edit/previews/' + preview.id + '/execute',
        'POST',
        { client_key: randomUUID(), scope_hash: preview.scope_hash, confirmed: true },
        422,
      );
      state.eur_execution = await execute(preview, true);
      const missing = await allSelection([state.products[0].id], state.eur.id);
      assert.equal(missing.rows[0].effective_price, null);
      assert.equal(missing.rows[0].override_present, false);
      assert.deepEqual(await snapshot([state.tenant], state.stable_names), state.stable_before);
      assert.deepEqual(
        (await api('/orders/' + state.old_order.id)).pricing_snapshot,
        state.old_order.pricing_snapshot,
      );
      const quote = await api('/pricing/quote', 'POST', {
        price_list_id: state.pln.id,
        product_ids: [state.products[0].id, state.products[1].id],
      });
      assert.deepEqual(
        quote.items.map((item: any) => item.price).sort((a: number, b: number) => a - b),
        [10520, 12301],
      );
      state.new_order = await api(
        '/orders',
        'POST',
        {
          customer_name: 'Nowa wycena QA108',
          email: 'newbuyer108@example.test',
          warehouse_id: state.warehouse,
          currency: 'PLN',
          price_list_id: state.pln.id,
          payment_mode: 'cod',
          items: [{ product_id: state.products[0].id, quantity: 1 }],
        },
        201,
      );
      assert.equal(state.new_order.items[0].price, 12301);
      assert.equal(state.new_order.pricing_snapshot.list.version, 3);
      state.bulk_ids = Array.from({ length: 500 }, () => randomUUID());
      await save(state);
      await pool.query(
        "INSERT INTO products(id,tenant_id,sku,name,price,vat) SELECT id,$1,'PRICE108-BULK-'||id,'Synthetic price batch108',10001,23 FROM unnest($2::uuid[]) id",
        [state.tenant, state.bulk_ids],
      );
      state.bulk_list = await api(
        '/price-lists',
        'POST',
        { name: 'Partia 500 QA108', currency: 'PLN', fallback: true },
        201,
      );
      const batch = await allSelection(state.bulk_ids, state.bulk_list.id);
      const began = performance.now();
      const bulkPreview = (
        await api(
          '/price-bulk-edit/previews',
          'POST',
          {
            client_key: randomUUID(),
            price_list_id: state.bulk_list.id,
            list_version: batch.list.version,
            rows: batch.rows.map((row: any) => ({
              product_id: row.product_id,
              product_version: row.product_version,
              operation: 'set',
              basis: 'gross',
              amount_minor: 11001,
            })),
          },
          201,
        )
      ).preview;
      const previewMs = performance.now() - began;
      assert(bulkPreview.ready && bulkPreview.changed === 500);
      const executeBegan = performance.now();
      state.bulk_execution = await execute(bulkPreview);
      const executeAndReplayMs = performance.now() - executeBegan;
      const bulkRows = await allRows(
        '/price-bulk-edit/executions/' + state.bulk_execution.id + '/rows',
      );
      assert.equal(bulkRows.length, 500);
      assert.deepEqual(bulkRows.map((row) => row.product_id).sort(), [...state.bulk_ids].sort());
      assert(
        bulkRows.every((row) => row.status === 'changed' && row.after.override_price === 11001),
      );
      const finalBatch = await allSelection(state.bulk_ids, state.bulk_list.id);
      assert.equal(finalBatch.list.version, 2);
      assert(finalBatch.rows.every((row) => row.override_price === 11001));
      await preserved(state);
      state.exercised = true;
      await save(state);
      await writeFile(
        'docs/price-bulk-edit-execution-qa.json',
        JSON.stringify(
          {
            status: 'PASS',
            revision: health.revision,
            schema: health.schema_revision,
            ui_execution: state.ui_execution.id,
            eur_execution: state.eur_execution.id,
            missing_without_ack_status: 422,
            eur_missing_after_ack: true,
            exact_replay: true,
            old_order_snapshot_exact: true,
            pim_stock_sales_exact_before_new_order: true,
            new_order_id: state.new_order.id,
            new_order_price: 12301,
            batch: {
              products: 500,
              changed: 500,
              execution_rows: bulkRows.length,
              list_version_before: 1,
              list_version_after: 2,
              preview_ms: previewMs,
              execute_and_exact_replay_ms: executeAndReplayMs,
              execution_id: state.bulk_execution.id,
              scope:
                'One synthetic native tenant/list; not sustained or cross-tenant capacity proof',
            },
            earlier_firms: state.ids.length,
            earlier_users: state.user_ids.length,
            exact_business_tables: state.protected_names.length,
          },
          null,
          2,
        ),
      );
      console.log({
        phase,
        missing_ack: true,
        new_order_price: 12301,
        batch_changed: 500,
        preview_ms: Math.round(previewMs),
        execute_and_replay_ms: Math.round(executeAndReplayMs),
      });
    } else if (phase === 'checkpoint') {
      assert(state.exercised && state.ui_verified);
      const jobs = (
        await pool.query(
          'SELECT state,count(*)::int n FROM jobs WHERE tenant_id=$1 GROUP BY state ORDER BY state',
          [state.tenant],
        )
      ).rows;
      assert(
        jobs.length > 0 && jobs.every((row) => row.state === 'done'),
        'Own jobs must settle before exact checkpoint',
      );
      state.own_names = [
        'tenants',
        ...(
          await pool.query(
            "SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id' ORDER BY table_name",
          )
        ).rows.map((row) => row.table_name),
      ];
      state.own_snapshot = await snapshot([state.tenant], state.own_names);
      state.runtime_revision = health.revision;
      await save(state);
      console.log({
        phase,
        revision: state.runtime_revision,
        own_tables: state.own_names.length,
        jobs,
      });
    } else if (phase === 'restart') {
      assert(state.exercised && state.own_snapshot);
      assert.equal(health.revision, state.runtime_revision);
      assert.deepEqual(await snapshot([state.tenant], state.own_names), state.own_snapshot);
      cookie = state.cookie;
      const history = await api('/price-bulk-edit/executions');
      assert.equal(history.data.length, 3);
      await writeFile(
        'docs/price-bulk-edit-restart-qa.json',
        JSON.stringify(
          {
            status: 'PASS',
            revision: health.revision,
            schema: health.schema_revision,
            own_tables_exact: state.own_names.length,
            earlier_firms: state.ids.length,
            earlier_users: state.user_ids.length,
            business_tables_exact: state.protected_names.length,
            executions: history.data.length,
            extra_login_created: false,
          },
          null,
          2,
        ),
      );
      console.log({
        phase,
        tables_exact: state.own_names.length,
        execution_history: history.data.length,
      });
    } else if (phase === 'preserved') {
      console.log({
        phase,
        exact_business_tables: state.protected_names.length,
        earlier_firms: state.ids.length,
        earlier_users: state.user_ids.length,
      });
    } else {
      throw new Error('Unknown phase: ' + phase);
    }
  }
} finally {
  await pool.end();
}
