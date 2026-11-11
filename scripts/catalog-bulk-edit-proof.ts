/** QA104 local native proof, dedicated private state. No credentials printed. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
const statePath = 'data/catalog-bulk-edit-stage104.json';
const phase = process.argv[2];
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
let cookie = '';
async function api(path: string, method = 'GET', body?: unknown, status = 200) {
  const r = await fetch('http://127.0.0.1:4100/api' + path, {
    method,
    headers: { cookie, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal(r.status, status, path + ' HTTP' + r.status);
  const c = r.headers.get('set-cookie');
  if (c) cookie = c.split(';')[0];
  return r.json() as Promise<any>;
}
async function snapshot(ids: string[], names: string[]) {
  const result: Record<string, string> = {};
  for (const name of names) {
    assert(/^[a-z][a-z0-9_]*$/.test(name));
    result[name] = digest(
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
async function assertNoOutbound(tenant: string) {
  for (const name of ['outbound_events', 'outbound_deliveries', 'email_messages', 'sms_messages'])
    assert.equal(
      (await pool.query(`SELECT count(*)::int n FROM ${name} WHERE tenant_id=$1`, [tenant])).rows[0]
        .n,
      0,
      name,
    );
}
const save = (s: any) => writeFile(statePath, JSON.stringify(s, null, 2), { mode: 0o600 });
async function usersHash(ids: string[]) {
  return digest(
    (
      await pool.query(
        'SELECT id,email,name,password_hash FROM users WHERE id=ANY($1::uuid[]) ORDER BY id',
        [ids],
      )
    ).rows,
  );
}
try {
  if (phase === 'baseline') {
    const h = await api('/health');
    assert.equal(h.schema_revision, '081_customer_message_workflows');
    const previous = JSON.parse(
      await readFile('data/customer-message-workflows-stage103.json', 'utf8'),
    );
    const names = previous.names as string[];
    assert.equal(names.length, 64);
    const ids = (await pool.query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id);
    const userIds = (await pool.query('SELECT id FROM users ORDER BY id')).rows.map((r) => r.id);
    const state = {
      created_at: new Date().toISOString(),
      baseline_revision: h.revision,
      baseline_schema: h.schema_revision,
      ids,
      userIds,
      names,
      before: await snapshot(ids, names),
      users_hash: await usersHash(userIds),
      own_base_names: previous.own_names,
    };
    await writeFile(statePath, JSON.stringify(state, null, 2), { mode: 0o600, flag: 'wx' });
    console.log({
      phase,
      prior_firms: ids.length,
      prior_users: userIds.length,
      business_fingerprints: names.length,
    });
  } else {
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    if (phase === 'verify-previous') {
      assert.deepEqual(await snapshot(state.ids, state.names), state.before);
      assert.equal(await usersHash(state.userIds), state.users_hash);
      console.log({
        phase,
        prior_firms: state.ids.length,
        prior_users: state.userIds.length,
        unchanged: true,
      });
    } else if (phase === 'setup') {
      assert(!state.tenant, 'Do not recreate own fixture');
      assert.equal((await api('/health')).schema_revision, '082_catalog_bulk_edit');
      state.email = 'qa-catalog-bulk-104@demo.local';
      state.password = 'DynaCatalog!2026-' + randomUUID();
      const signup = await api(
        '/auth/signup',
        'POST',
        {
          email: state.email,
          password: state.password,
          name: 'QA arkusz104',
          organization: { name: 'QA arkusz produktów104' },
        },
        201,
      );
      state.tenant = signup.user.tenant_id;
      state.user = signup.user.id;
      await save(state);
      state.warehouse = (await api('/warehouses')).data[0].id;
      state.products = [];
      for (let i = 0; i < 3; i++) {
        const p = await api(
          '/products',
          'POST',
          {
            sku: 'QA104-SHEET-' + i,
            name: 'Produkt arkusza104-' + i,
            ean: '10400000000' + i,
            price: 10001 + i,
            quantity: 100,
            warehouse_id: state.warehouse,
            category: 'Przed edycją104',
            description: 'Opis przed104',
            attributes: { material: 'bawełna', keep: 'zachowaj' },
            images: [],
            active: true,
          },
          201,
        );
        state.products.push(p);
        await save(state);
      }
      state.image = await api(
        '/product-images',
        'POST',
        {
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lU8AAAAASUVORK5CYII=',
        },
        201,
      );
      await save(state);
      state.bundle = await api(
        '/products',
        'POST',
        {
          sku: 'QA104-SHEET-BUNDLE',
          name: 'Zestaw arkusza104',
          kind: 'bundle',
          price: 20002,
          quantity: 0,
          warehouse_id: state.warehouse,
          components: [{ product_id: state.products[0].id, quantity: 2 }],
          category: 'Zestaw104',
        },
        201,
      );
      await save(state);
      state.order = await api(
        '/orders',
        'POST',
        {
          customer_name: 'Kupujący arkusz QA104',
          email: 'sheet104@example.test',
          warehouse_id: state.warehouse,
          items: [{ product_id: state.products[0].id, quantity: 1 }],
        },
        201,
      );
      await save(state);
      console.log({ phase, own_firm: true, products: 4, orders: 1, provider_writes: 0 });
    } else if (phase === 'exercise' || phase === 'exercise-resume-before-rule') {
      if (phase === 'exercise')
        assert(
          state.tenant && !state.exercise_started && !state.api_acceptance,
          'Do not rerun native exercise',
        );
      else {
        assert(
          state.tenant &&
            state.exercise_started &&
            !state.rule_request &&
            !state.rule &&
            !state.preview &&
            !state.execution &&
            !state.new_order &&
            !state.api_acceptance,
          'Only resume the proven pre-effect QA failure',
        );
        for (const name of [
          'product_rules',
          'catalog_bulk_edit_previews',
          'catalog_bulk_edit_rows',
          'catalog_bulk_edit_executions',
          'catalog_bulk_edit_execution_rows',
        ])
          assert.equal(
            (
              await pool.query(`SELECT count(*)::int n FROM ${name} WHERE tenant_id=$1`, [
                state.tenant,
              ])
            ).rows[0].n,
            0,
            name,
          );
        state.qa_resume_reason = 'Pre-effect proof table name corrected from offers to listings';
      }
      state.exercise_started = true;
      await save(state);
      await api('/auth/login', 'POST', { email: state.email, password: state.password });
      const settle = async () => {
        for (let n = 0; n < 60; n++) {
          const pending = (
            await pool.query(
              "SELECT count(*)::int n FROM jobs WHERE tenant_id=$1 AND state IN('pending','running')",
              [state.tenant],
            )
          ).rows[0].n;
          if (!pending) return;
          await new Promise((r) => setTimeout(r, 500));
        }
        throw Error('Own jobs did not settle');
      };
      await settle();
      const businessTables = [
        'orders',
        'order_items',
        'order_pick_items',
        'stock',
        'stock_movements',
        'reservations',
        'shipments',
        'documents',
        'listings',
        'bundle_components',
      ];
      const before = await snapshot([state.tenant], businessTables);
      state.rule_request = {
        client_key: randomUUID(),
        confirm_future_changes: true,
        definition: {
          name: 'Reguła aktualizacji arkusza QA104',
          event: 'product.updated',
          enabled: true,
          priority: 50,
          conditions: [{ field: 'sku', op: 'eq', value: state.products[0].sku }],
          actions: [{ type: 'set_attribute', key: 'processed', value: 'yes104' }],
        },
      };
      await save(state);
      state.rule = await api('/product-rules', 'POST', state.rule_request);
      await save(state);
      const ids = [...state.products.map((p: any) => p.id), state.bundle.id];
      const selected = await api('/catalog-bulk-edit/selection?ids=' + ids.join(','));
      assert.equal(selected.data.length, 4);
      state.preview_request = {
        client_key: randomUUID(),
        rows: [
          {
            product_id: state.products[0].id,
            version: state.products[0].version,
            changes: {
              name: 'Produkt po arkuszu QA104',
              ean: '1041041041041',
              price: 12501,
              vat: 8,
              category: 'Po edycji104',
              description: 'Opis po arkuszu104',
              attributes: { qa: 'native104', keep: 'zachowaj' },
              images: [state.image.url],
              active: true,
            },
          },
          {
            product_id: state.products[1].id,
            version: state.products[1].version,
            changes: { name: state.products[1].name },
          },
          {
            product_id: state.products[2].id,
            version: state.products[2].version,
            changes: { ean: '', description: '', attributes: {}, price: 0, active: false },
          },
          { product_id: state.bundle.id, version: state.bundle.version, changes: { price: 22222 } },
        ],
      };
      await save(state);
      const previewNames = [
        ...new Set([
          ...state.own_base_names,
          'bundle_components',
          'product_rules',
          'product_rule_revisions',
          'product_rule_runs',
          'product_rule_items',
          'product_rule_causes',
        ]),
      ];
      const previewBefore = await snapshot([state.tenant], previewNames);
      state.preview = (
        await api('/catalog-bulk-edit/previews', 'POST', state.preview_request, 201)
      ).preview;
      await save(state);
      assert(state.preview.ready);
      assert.equal(state.preview.changed, 3);
      assert.equal(state.preview.unchanged, 1);
      assert.equal(state.preview.active_product_rules, 1);
      assert.deepEqual(await snapshot([state.tenant], previewNames), previewBefore);
      const retryBefore = await snapshot(
        [state.tenant],
        [...previewNames, 'catalog_bulk_edit_previews', 'catalog_bulk_edit_rows'],
      );
      const retry = await api('/catalog-bulk-edit/previews', 'POST', state.preview_request);
      assert(retry.reused);
      assert.equal(retry.preview.id, state.preview.id);
      assert.deepEqual(
        await snapshot(
          [state.tenant],
          [...previewNames, 'catalog_bulk_edit_previews', 'catalog_bulk_edit_rows'],
        ),
        retryBefore,
      );
      const rows = await api('/catalog-bulk-edit/previews/' + state.preview.id + '/rows');
      assert.equal(rows.data.length, 4);
      assert.equal(rows.meta.cursor, null);
      assert.deepEqual(
        rows.data.find((r: any) => r.product_id === state.products[2].id).after.attributes,
        {},
      );
      state.execute_request = {
        client_key: randomUUID(),
        scope_hash: state.preview.scope_hash,
        confirmed: true,
      };
      await save(state);
      state.execution = (
        await api(
          '/catalog-bulk-edit/previews/' + state.preview.id + '/execute',
          'POST',
          state.execute_request,
          201,
        )
      ).execution;
      await save(state);
      assert.equal(state.execution.state, 'done');
      assert.equal(state.execution.changed, 3);
      assert.equal(state.execution.unchanged, 1);
      await settle();
      const p0 = await api('/products/' + state.products[0].id);
      assert.equal(p0.price, 12501);
      assert.equal(p0.name, 'Produkt po arkuszu QA104');
      assert.equal(p0.attributes.processed, 'yes104');
      assert.equal(p0.version, state.products[0].version + 2);
      assert.deepEqual(p0.images, [state.image.url]);
      const p1 = await api('/products/' + state.products[1].id);
      assert.equal(p1.version, state.products[1].version);
      assert.equal(p1.price, state.products[1].price);
      const p2 = await api('/products/' + state.products[2].id);
      assert.equal(p2.price, 0);
      assert.equal(p2.active, false);
      assert.equal(p2.ean, '');
      assert.equal(p2.description, '');
      assert.deepEqual(p2.attributes, {});
      const bundle = await api('/products/' + state.bundle.id);
      assert.equal(bundle.price, 22222);
      assert.equal(bundle.components.length, 1);
      assert.equal(bundle.components[0].quantity, 2);
      assert.deepEqual(await snapshot([state.tenant], businessTables), before);
      state.own_names = [
        ...new Set([
          ...state.own_base_names,
          'bundle_components',
          'product_rules',
          'product_rule_revisions',
          'product_rule_runs',
          'product_rule_items',
          'product_rule_causes',
          'catalog_bulk_edit_previews',
          'catalog_bulk_edit_rows',
          'catalog_bulk_edit_executions',
          'catalog_bulk_edit_execution_rows',
        ]),
      ];
      const effectsBefore = await snapshot([state.tenant], state.own_names);
      const execRetry = await api(
        '/catalog-bulk-edit/previews/' + state.preview.id + '/execute',
        'POST',
        state.execute_request,
      );
      assert(execRetry.reused);
      assert.equal(execRetry.execution.id, state.execution.id);
      assert.deepEqual(await snapshot([state.tenant], state.own_names), effectsBefore);
      const history = await api('/catalog-bulk-edit/executions');
      assert.equal(history.data.length, 1);
      assert.equal(history.data[0].id, state.execution.id);
      const results = await api('/catalog-bulk-edit/executions/' + state.execution.id + '/rows');
      assert.equal(results.data.length, 4);
      assert.equal(results.meta.cursor, null);
      for (const name of [
        'outbound_events',
        'outbound_deliveries',
        'email_messages',
        'sms_messages',
      ])
        assert.equal(
          (
            await pool.query(`SELECT count(*)::int n FROM ${name} WHERE tenant_id=$1`, [
              state.tenant,
            ])
          ).rows[0].n,
          0,
        );
      state.new_order = await api(
        '/orders',
        'POST',
        {
          customer_name: 'Nowa cena QA104',
          email: 'next104@example.test',
          warehouse_id: state.warehouse,
          items: [{ product_id: state.products[0].id, quantity: 1 }],
        },
        201,
      );
      assert.equal(state.new_order.total, 12501);
      await save(state);
      await settle();
      await assertNoOutbound(state.tenant);
      assert.equal((await api('/orders/' + state.order.id)).total, 10001);
      state.api_acceptance = true;
      state.runtime_revision = (await api('/health')).revision;
      state.own_snapshot = await snapshot([state.tenant], state.own_names);
      state.own_snapshot_timezone = (await pool.query('SHOW TimeZone')).rows[0].TimeZone;
      await save(state);
      assert.deepEqual(await snapshot(state.ids, state.names), state.before);
      assert.equal(await usersHash(state.userIds), state.users_hash);
      await writeFile(
        'docs/catalog-bulk-edit-native-qa.json',
        JSON.stringify(
          {
            stage: 104,
            revision: state.runtime_revision,
            schema: '082_catalog_bulk_edit',
            own_synthetic_firm: true,
            products: 4,
            changed: 3,
            unchanged: 1,
            nine_fields: true,
            preview_no_business_effect: true,
            preview_retry: true,
            execute_retry: true,
            execution_state: 'done',
            native_product_rule_worker: true,
            old_order_snapshot_unchanged: true,
            new_order_total: 12501,
            stock_and_components_unchanged_during_edit: true,
            explicit_clear: true,
            provider_effects: 0,
            goal_complete: false,
          },
          null,
          2,
        ) + '\n',
      );
      console.log({
        phase,
        changed: 3,
        unchanged: 1,
        worker_rule_done: true,
        old_order_unchanged: true,
        new_order_total: 12501,
        provider_effects: 0,
      });
    } else if (phase === 'verify') {
      assert(state.api_acceptance && state.own_snapshot);
      await assertNoOutbound(state.tenant);
      const h = await api('/health');
      assert.equal(h.schema_revision, '082_catalog_bulk_edit');
      assert.equal(h.revision, state.runtime_revision);
      assert.deepEqual(await snapshot([state.tenant], state.own_names), state.own_snapshot);
      assert.deepEqual(await snapshot(state.ids, state.names), state.before);
      assert.equal(await usersHash(state.userIds), state.users_hash);
      console.log({
        phase,
        own_fingerprints: state.own_names.length,
        prior_firms: state.ids.length,
        prior_users: state.userIds.length,
        unchanged: true,
      });
    } else throw new Error('Unknown phase');
  }
} finally {
  await pool.end();
}
