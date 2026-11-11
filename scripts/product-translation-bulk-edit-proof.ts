/** Local QA109. Credentials/state remain ignored mode0600; baseline is never replaced. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { pool } from '../server/db';

const statePath = 'data/product-translation-bulk-edit-stage109.json';
const phase = process.argv[2];
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
let cookie = '';
let listingOverrides: { id: string; run_id: string; observed_at: string }[] = [];
async function api(path: string, method = 'GET', body?: unknown, status = 200) {
  const r = await fetch('http://127.0.0.1:4100/api' + path, {
    method,
    headers: { cookie, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal(
    r.status,
    status,
    path + ': ' + r.status + (r.status !== status ? ' ' + (await r.text()) : ''),
  );
  const next = r.headers.get('set-cookie');
  if (next) cookie = next.split(';')[0];
  return r.json() as Promise<any>;
}
const save = (state: any) => writeFile(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
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
  'product_translations',
  'ai_catalog_drafts',
  'deepl_catalog_drafts',
  'deepl_catalog_batches',
  'shopify_translation_plans',
  'shopify_translation_observations',
  'shopify_translation_simulations',
  'shopify_translation_claims',
  'shopify_translation_batches',
  'shopify_translation_batch_items',
  'price_bulk_edit_previews',
  'price_bulk_edit_rows',
  'price_bulk_edit_executions',
  'price_bulk_edit_execution_rows',
];
async function snapshot(ids: string[], names: string[]) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    const result: Record<string, string> = {};
    for (const name of names) {
      assert(/^[a-z][a-z0-9_]*$/.test(name));
      // 088 adds only a nullable manual FK to old rows; absence/null is explicitly normalized.
      const row =
        name === 'product_translations'
          ? "to_jsonb(t)-'manual_receipt_id'"
          : name === 'listings' && listingOverrides.length
            ? "CASE WHEN o.id IS NULL THEN to_jsonb(t) ELSE jsonb_set(jsonb_set(to_jsonb(t),'{last_result,odoo_catalog_sync,run_id}',to_jsonb(o.run_id)),'{last_result,odoo_catalog_sync,observed_at}',to_jsonb(o.observed_at)) END"
            : 'to_jsonb(t)';
      const scope =
        name === 'shopify_translation_claims'
          ? 'EXISTS(SELECT 1 FROM shopify_translation_plans p WHERE p.id=t.plan_id AND p.tenant_id=ANY($1::uuid[]))'
          : `${name === 'tenants' ? 't.id' : 't.tenant_id'}=ANY($1::uuid[])`;
      const overridden = name === 'listings' && listingOverrides.length > 0;
      result[name] = hash(
        (
          await c.query(
            `SELECT ${row} row FROM "${name}" t ${overridden ? 'LEFT JOIN jsonb_to_recordset($2::jsonb)o(id uuid,run_id text,observed_at text) ON o.id=t.id' : ''} WHERE ${scope} ORDER BY 1`,
            overridden ? [ids, JSON.stringify(listingOverrides)] : [ids],
          )
        ).rows,
      );
    }
    await c.query('COMMIT');
    return result;
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}
try {
  const health = (await (await fetch('http://127.0.0.1:4100/api/health')).json()) as any;
  if (phase === 'baseline') {
    assert.equal(health.schema_revision, '087_price_bulk_edit');
    const ids = (await pool.query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id);
    const users = (await pool.query('SELECT to_jsonb(u) row FROM users u ORDER BY id')).rows;
    const state = {
      baseline_revision: health.revision,
      created_at: new Date().toISOString(),
      ids,
      user_ids: users.map((u) => u.row.id),
      users_hash: hash(users),
      protected_names: protectedNames,
      before: await snapshot(ids, protectedNames),
    };
    await writeFile(statePath, JSON.stringify(state, null, 2), { mode: 0o600, flag: 'wx' });
    console.log({
      phase,
      earlier_firms: ids.length,
      earlier_users: users.length,
      business_tables: protectedNames.length,
    });
  } else {
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    // Explicitly traced pre-existing local Odoo schedule: only two volatile
    // observation fields in two known rows are compared to their original values.
    // The original full-table baseline and initial mismatch are retained.
    listingOverrides = state.listing_overrides ?? [];
    assert.deepEqual(await snapshot(state.ids, state.protected_names), state.before);
    const users = (
      await pool.query('SELECT to_jsonb(u) row FROM users u WHERE id=ANY($1::uuid[]) ORDER BY id', [
        state.user_ids,
      ])
    ).rows;
    assert.equal(hash(users), state.users_hash);
    if (phase === 'preserved') {
      console.log({
        phase,
        status: 'PASS',
        earlier_firms: state.ids.length,
        earlier_users: state.user_ids.length,
        business_tables: state.protected_names.length,
        exact_business_tables: state.protected_names.length - (listingOverrides.length ? 1 : 0),
        traced_listing_observation_fields: listingOverrides.length * 2,
      });
    } else if (phase === 'prepare') {
      assert.equal(health.schema_revision, '088_product_translation_bulk_edit');
      assert(health.product_translation_bulk_edit_available);
      assert(!state.tenant, 'QA109 already created; do not repeat signup or partial preparation');
      state.runtime_revision = health.revision;
      state.email = 'qa-manual-languages109-' + randomUUID().slice(0, 8) + '@demo.local';
      state.password = 'DynaLanguages!2026-' + randomUUID();
      const signup = await api(
        '/auth/signup',
        'POST',
        {
          email: state.email,
          password: state.password,
          name: 'QA arkusz języków109',
          organization: { name: 'QA języki109' },
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
      for (let i = 0; i < 3; i++) {
        state.products.push(
          await api(
            '/products',
            'POST',
            {
              name: ['Wersja DeepL QA109', 'Nowe języki QA109', 'Usunięcie wersji QA109'][i],
              sku: 'LANG109-' + i,
              price: 10001,
              vat: 23,
              warehouse_id: state.warehouse,
              quantity: 30,
              location: 'L109',
            },
            201,
          ),
        );
        await save(state);
      }
      state.old_order = await api(
        '/orders',
        'POST',
        {
          customer_name: 'Kupujący przed edycją QA109',
          email: 'buyer-languages109@example.test',
          warehouse_id: state.warehouse,
          items: [{ product_id: state.products[0].id, quantity: 2 }],
        },
        201,
      );
      state.locales = ['en-us', 'de', 'fr'];
      state.deepLChannel = (await api('/integrations/deepl-example', 'POST', {})).channel_id;
      state.deepLDraft = await api(
        '/products/' + state.products[0].id + '/deepl/preview',
        'POST',
        {
          version: state.products[0].version,
          client_key: randomUUID(),
          channel_id: state.deepLChannel,
          source_lang: 'pl',
          target_lang: 'en-us',
        },
        201,
      );
      await save(state);
      await writeFile(
        'docs/product-translation-bulk-native-qa.json',
        JSON.stringify(
          {
            status: 'PREPARED; provider fixture and UI acceptance pending',
            revision: health.revision,
            schema: health.schema_revision,
            tenant: state.tenant,
            products: state.products.map((p: any) => ({
              id: p.id,
              sku: p.sku,
              version: p.version,
            })),
            locales: state.locales,
            provider_fixture: 'Own local DeepL simulation only; no provider verification',
            earlier_firms: state.ids.length,
            earlier_users: state.user_ids.length,
            business_tables: state.protected_names.length,
          },
          null,
          2,
        ) + '\n',
      );
      console.log({ phase, products: 3, locales: 3, simulation: true, provider_verified: false });
    } else if (phase === 'seed') {
      assert.equal(health.schema_revision, '088_product_translation_bulk_edit');
      assert(state.tenant && state.deepLDraft && !state.fixture_seeded);
      cookie = state.cookie;
      let draft = (await api('/products/' + state.products[0].id + '/deepl')).data.find(
        (d: any) => d.id === state.deepLDraft.id,
      );
      assert(draft && draft.simulation, 'This fixture must remain a local simulation');
      if (draft.state === 'prepared')
        await api('/deepl/drafts/' + draft.id + '/queue', 'POST', {
          confirm_external: true,
          max_characters: 10200,
        });
      for (let i = 0; i < 40 && !['ready', 'applied'].includes(draft.state); i++) {
        await delay(250);
        draft = (await api('/products/' + state.products[0].id + '/deepl')).data.find(
          (d: any) => d.id === state.deepLDraft.id,
        );
      }
      assert(['ready', 'applied'].includes(draft.state), draft.state);
      await api('/deepl/drafts/' + draft.id + '/apply', 'POST', {
        approve: true,
        version: state.products[0].version,
        name: 'Original translation QA109',
        description: 'Description reviewed from local DeepL simulation QA109',
      });
      const product = await api('/products/' + state.products[2].id);
      state.seed_preview_key ??= randomUUID();
      state.seed_execute_key ??= randomUUID();
      await save(state);
      const p = await api(
        '/product-translation-bulk-edit/previews',
        'POST',
        {
          client_key: state.seed_preview_key,
          locales: ['en-us'],
          rows: [
            {
              product_id: product.id,
              product_version: product.version,
              locale: 'en-us',
              translation_version: null,
              operation: 'set',
              patch: {
                name: 'Version to remove QA109',
                description: 'Keep this text in immutable history after remove',
              },
            },
          ],
        },
        201,
      );
      assert(p.preview.ready);
      const e = await api(
        '/product-translation-bulk-edit/previews/' + p.preview.id + '/execute',
        'POST',
        {
          client_key: state.seed_execute_key,
          scope_hash: p.preview.scope_hash,
          confirmed: true,
          ack_missing_translations: false,
        },
        201,
      );
      state.seed_execution = e.execution.id;
      state.products = await Promise.all(state.products.map((p: any) => api('/products/' + p.id)));
      state.stable_names = [
        'tenants',
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
        'ai_catalog_drafts',
        'deepl_catalog_drafts',
        'deepl_catalog_batches',
      ];
      state.stable_before = await snapshot([state.tenant], state.stable_names);
      state.product_before = state.products;
      state.fixture_seeded = true;
      await save(state);
      await writeFile(
        'docs/product-translation-bulk-fixture-qa.json',
        JSON.stringify(
          {
            status: 'LOCAL_FIXTURE_READY; UI acceptance pending',
            revision: health.revision,
            schema: health.schema_revision,
            products: state.products.map((p: any) => ({
              id: p.id,
              sku: p.sku,
              version: p.version,
            })),
            locales: state.locales,
            local_deepl_applied_draft: state.deepLDraft.id,
            manual_seed_execution: state.seed_execution,
            provider_verified: false,
            earlier_firms: state.ids.length,
            earlier_users: state.user_ids.length,
            business_tables: state.protected_names.length,
          },
          null,
          2,
        ) + '\n',
      );
      console.log({
        phase,
        products: 3,
        locales: 3,
        source_deepl_simulation: true,
        manual_seed: true,
        provider_verified: false,
      });
    } else if (['accept-ui', 'checkpoint', 'restart'].includes(phase)) {
      assert(state.fixture_seeded);
      cookie = state.cookie;
      assert.deepEqual(await snapshot([state.tenant], state.stable_names), state.stable_before);
      const executions = (await api('/product-translation-bulk-edit/executions')).data;
      const matches = executions.filter((e: any) => e.total === 9 && e.id !== state.seed_execution);
      assert.equal(matches.length, 1, 'Exactly one actual UI matrix execution');
      const head = (await api('/product-translation-bulk-edit/executions/' + matches[0].id))
        .execution;
      assert.equal(head.total, 9);
      assert.equal(head.changed_pairs, 5);
      assert.equal(head.unchanged_pairs, 4);
      assert.equal(head.changed_products, 3);
      assert.equal(head.missing_after_count, 5);
      assert.equal(head.ack_missing_translations, true);
      const rows: any[] = [];
      let cursor: string | null = null;
      do {
        const page = await api(
          '/product-translation-bulk-edit/executions/' +
            head.id +
            '/rows' +
            (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''),
        );
        assert(page.data.length <= 50);
        rows.push(...page.data);
        cursor = page.meta.cursor;
      } while (cursor);
      assert.equal(rows.length, 9);
      assert.deepEqual(
        rows.map((r) => r.index),
        Array.from({ length: 9 }, (_, i) => i),
      );
      assert.equal(new Set(rows.map((r) => r.id)).size, 9);
      const currentProducts = await Promise.all(
        state.products.map((p: any) => api('/products/' + p.id)),
      );
      for (let i = 0; i < currentProducts.length; i++) {
        assert.equal(currentProducts[i].version, state.product_before[i].version + 1);
        assert.deepEqual(
          { ...currentProducts[i], version: state.product_before[i].version },
          state.product_before[i],
        );
      }
      const currentTranslations = (
        await pool.query(
          'SELECT product_id,locale,name,description,version,manual_receipt_id,ai_draft_id,deepl_draft_id FROM product_translations WHERE tenant_id=$1 ORDER BY product_id,locale',
          [state.tenant],
        )
      ).rows;
      assert.equal(currentTranslations.length, 4);
      const p0 = currentTranslations.find(
        (t) => t.product_id === state.products[0].id && t.locale === 'en-us',
      );
      assert.equal(p0.name, 'Manual name after DeepL QA109');
      assert.equal(p0.description, 'Description reviewed from local DeepL simulation QA109');
      assert.equal(p0.version, 2);
      const p1 = currentTranslations.find(
        (t) => t.product_id === state.products[1].id && t.locale === 'en-us',
      );
      assert.equal(p1.name, 'New English version QA109');
      assert.equal(p1.description, 'New English description QA109\nSecond line retained.');
      for (const t of currentTranslations) {
        assert(t.manual_receipt_id && !t.ai_draft_id && !t.deepl_draft_id);
        assert(
          rows.some(
            (r) =>
              r.id === t.manual_receipt_id &&
              r.product_id === t.product_id &&
              r.locale === t.locale,
          ),
        );
        if (t.locale === 'de') {
          assert.equal(t.name, 'Deutscher Name QA109');
          assert.equal(t.description, '');
          assert.equal(t.version, 1);
        }
      }
      const removed = rows.find(
        (r) => r.product_id === state.products[2].id && r.locale === 'en-us',
      );
      assert.equal(removed.input.operation, 'remove');
      assert.equal(removed.before.name, 'Version to remove QA109');
      assert.equal(removed.after.present, false);
      assert(!currentTranslations.some((t) => t.product_id === state.products[2].id));
      assert.equal(
        rows.find((r) => r.product_id === state.products[0].id && r.locale === 'en-us').before
          .provenance.kind,
        'deepl',
      );
      const protectedOwn = [
        ...new Set([
          ...state.stable_names,
          'products',
          'product_translations',
          'product_translation_bulk_edit_previews',
          'product_translation_bulk_edit_rows',
          'product_translation_bulk_edit_executions',
          'product_translation_bulk_edit_execution_rows',
        ]),
      ];
      const current = await snapshot([state.tenant], protectedOwn);
      if (phase === 'restart') {
        assert(state.checkpoint);
        assert.deepEqual(current, state.checkpoint);
        assert.deepEqual(rows, state.ui_rows);
      } else {
        state.ui_execution = head.id;
        state.ui_rows = rows;
        state.checkpoint = current;
        state.checkpoint_names = protectedOwn;
        await save(state);
      }
      const recovery = await readFile('docs/product-translation-bulk-recovery-qa.json', 'utf8')
        .then((text) => JSON.parse(text))
        .catch((error) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
      const recoveryChecked = Boolean(
        recovery?.status === 'PASS' &&
        recovery.revision === health.revision &&
        recovery.schema === health.schema_revision &&
        recovery.ui_execution === head.id &&
        recovery.ui_receipt_rows === rows.length &&
        recovery.own_preview_removed === true,
      );
      const report = {
        stage: 109,
        status:
          phase === 'restart'
            ? recoveryChecked
              ? 'UI/API/restart/recovery PASS'
              : 'UI/API/restart PASS; recovery pending'
            : 'UI/API PASS; restart and recovery pending',
        revision: health.revision,
        schema: health.schema_revision,
        tenant: state.tenant,
        ui_execution: head.id,
        ui_matrix: {
          products: 3,
          locales: 3,
          rows: 9,
          changed_pairs: 5,
          unchanged_pairs: 4,
          changed_products: 3,
          missing_after: 5,
        },
        current_manual_translations: 4,
        deepL_description_preserved: true,
        multiline_description_exact: true,
        removed_text_preserved_in_history: true,
        product_versions_increased_once: true,
        own_prior_business_tables_exact: state.stable_names.length,
        restart_checked: phase === 'restart',
        restart_tables: protectedOwn.length,
        recovery_checked: recoveryChecked,
        recovery_evidence: recoveryChecked ? 'product-translation-bulk-recovery-qa.json' : null,
        earlier_firms: state.ids.length,
        earlier_users: state.user_ids.length,
        earlier_business_tables_exact:
          state.protected_names.length - (listingOverrides.length ? 1 : 0),
        traced_listing_observation_fields: listingOverrides.length * 2,
        provider_verified: false,
        goal_complete: false,
      };
      await writeFile(
        'docs/product-translation-bulk-native-qa.json',
        JSON.stringify(report, null, 2) + '\n',
      );
      console.log({
        phase,
        status: 'PASS',
        pairs: rows.length,
        current_manual_translations: currentTranslations.length,
        protected_own_tables: protectedOwn.length,
      });
    } else throw new Error('Unknown QA phase');
  }
} finally {
  await pool.end();
}
