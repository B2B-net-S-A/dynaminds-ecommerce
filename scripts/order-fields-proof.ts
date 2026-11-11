import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';

const statePath = 'data/order-fields-stage100.json';
const phase = process.argv[2];
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const tables = [
  'products',
  'stock',
  'stock_movements',
  'orders',
  'order_items',
  'order_pick_items',
  'order_events',
  'reservations',
  'shipments',
  'shipping_plans',
  'documents',
  'return_cases',
  'return_items',
  'payment_entries',
  'channels',
  'warehouses',
  'memberships',
  'workspace_usage',
  'workspace_billing_accounts',
  'workspace_billing_entries',
  'product_translations',
  'ai_catalog_drafts',
  'deepl_catalog_drafts',
  'deepl_catalog_batches',
  'shopify_translation_plans',
  'shopify_translation_batches',
  'customer_message_threads',
  'customer_messages',
  'product_rules',
  'product_rule_revisions',
  'product_rule_runs',
  'product_rule_items',
  'product_rule_causes',
  'payment_import_namespaces',
  'payment_import_profiles',
  'payment_import_profile_revisions',
  'payment_import_files',
  'payment_import_upload_requests',
  'payment_import_previews',
  'payment_import_rows',
  'payment_import_executions',
  'payment_import_execution_rows',
  'payment_import_claims',
  'payment_import_receipts',
  'order_local_financial_fences',
];
const fieldTables = [
  'order_field_definitions',
  'order_field_definition_revisions',
  'order_field_options',
  'order_field_values',
  'order_field_value_events',
  'order_field_files',
  'order_field_requests',
];
async function ownFields(tenant: string) {
  const result: Record<string, string> = {};
  for (const table of fieldTables)
    result[table] = hash(
      (
        await pool.query(`SELECT to_jsonb(t) row FROM ${table} t WHERE tenant_id=$1 ORDER BY 1`, [
          tenant,
        ])
      ).rows,
    );
  return result;
}
async function fingerprints(ids: string[]) {
  const result: Record<string, string> = {};
  for (const table of tables)
    result[table] = hash(
      (
        await pool.query(
          `SELECT to_jsonb(t) row FROM ${table} t WHERE tenant_id=ANY($1::uuid[]) ORDER BY 1`,
          [ids],
        )
      ).rows,
    );
  result.tenants = hash(
    (
      await pool.query(
        'SELECT to_jsonb(t) row FROM tenants t WHERE id=ANY($1::uuid[]) ORDER BY 1',
        [ids],
      )
    ).rows,
  );
  return result;
}
let cookie = '';
async function api(path: string, method = 'GET', body?: unknown, expected = 200) {
  const response = await fetch('http://127.0.0.1:4100/api' + path, {
    method,
    headers: { cookie, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal(response.status, expected, path + ' ' + response.status);
  if (response.headers.get('set-cookie'))
    cookie = response.headers.get('set-cookie')!.split(';')[0];
  return response.json() as Promise<any>;
}
try {
  if (phase === 'baseline') {
    const health = await api('/health');
    assert.equal(health.schema_revision, '077_payment_imports');
    assert.equal(
      (await pool.query("SELECT to_regclass('public.order_field_definitions') present")).rows[0]
        .present,
      null,
    );
    const ids = (await pool.query('SELECT id FROM tenants ORDER BY id')).rows.map((row) => row.id);
    const users = (await pool.query('SELECT id,email,name,password_hash FROM users ORDER BY id'))
      .rows;
    await writeFile(
      statePath,
      JSON.stringify(
        {
          ids,
          userIds: users.map((row) => row.id),
          usersHash: hash(users),
          baseline_revision: health.revision,
          before: await fingerprints(ids),
        },
        null,
        2,
      ),
      { flag: 'wx', mode: 0o600 },
    );
    console.log({
      phase,
      prior_firms: ids.length,
      prior_users: users.length,
      business_tables: tables.length,
    });
  } else {
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    const save = () => writeFile(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
    const health = await api('/health');
    assert.equal(health.schema_revision, '078_order_fields');
    if (process.env.PROOF_REVISION) assert.equal(health.revision, process.env.PROOF_REVISION);
    if (phase === 'setup') {
      assert(!state.tenant);
      state.email = 'qa-fields-100@demo.local';
      state.password = 'DynaOrderFields!2026';
      const signup = await api(
        '/auth/signup',
        'POST',
        {
          email: state.email,
          password: state.password,
          name: 'QA pola 100',
          organization: { name: 'QA pola zamówień 100' },
        },
        201,
      );
      state.tenant = signup.user.tenant_id;
      state.user = signup.user.id;
      await save();
      assert(!state.ids.includes(state.tenant));
      state.warehouse = (await api('/warehouses')).data[0].id;
      state.product = await api(
        '/products',
        'POST',
        {
          sku: 'QA100-FIELDS',
          name: 'Kubek pól dodatkowych',
          price: 4200,
          quantity: 100,
          warehouse_id: state.warehouse,
        },
        201,
      );
      state.order = await api(
        '/orders',
        'POST',
        {
          customer_name: 'Lokalny test pól100',
          email: 'qa100@example.test',
          warehouse_id: state.warehouse,
          items: [{ product_id: state.product.id, quantity: 1 }],
        },
        201,
      );
      state.setupJobIds = (
        await pool.query('SELECT id FROM jobs WHERE tenant_id=$1 ORDER BY id', [state.tenant])
      ).rows.map((row) => row.id);
      await save();
      console.log({ phase, new_own_firm: true, order_number: state.order.number });
    } else if (phase === 'exercise') {
      assert(state.order && !state.fields);
      await api('/auth/login', 'POST', { email: state.email, password: state.password });
      const first = randomUUID(),
        second = randomUUID();
      const optionList = [
        { id: first, label: 'Standard', enabled: true },
        { id: second, label: 'Prezent', enabled: true },
      ];
      const specs = [
        {
          key: 'qa_instruction',
          label: 'Instrukcja pakowania',
          type: 'text',
          config: { max_length: 4000 },
        },
        { key: 'qa_exact_number', label: 'Dokładna liczba', type: 'number', config: { scale: 6 } },
        { key: 'qa_delivery', label: 'Wariant dostawy', type: 'select', options: optionList },
        { key: 'qa_contact', label: 'Sposób kontaktu', type: 'radio', options: optionList },
        { key: 'qa_extras', label: 'Dodatki', type: 'multi_select', options: optionList },
        { key: 'qa_date', label: 'Termin realizacji', type: 'date' },
        { key: 'qa_file', label: 'Załącznik zamówienia', type: 'file' },
      ];
      state.fields = [];
      for (const spec of specs) {
        const definition = await api(
          '/order-fields',
          'POST',
          { client_key: randomUUID(), ...spec },
          201,
        );
        assert(definition.id && definition.version === 1);
        state.fields.push(definition);
        await save();
      }
      const png =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jOvsAAAAASUVORK5CYII=';
      state.file = await api(
        '/order-field-files',
        'POST',
        {
          client_key: randomUUID(),
          order_id: state.order.id,
          field_id: state.fields[6].id,
          definition_version: 1,
          filename: 'QA100-załącznik.png',
          content_base64: png,
        },
        201,
      );
      const values = [
        'Zapakuj osobno — Żółć',
        '999999999999.123456',
        first,
        second,
        [first, second].sort(),
        '2028-02-29',
        state.file.id,
      ];
      const changes = state.fields.map((definition: any, index: number) => ({
        field_id: definition.id,
        definition_version: 1,
        type: definition.type,
        value: values[index],
      }));
      const current = await api('/orders/' + state.order.id);
      const body = { client_key: randomUUID(), order_version: Number(current.version), changes };
      const applied = await api('/orders/' + state.order.id + '/fields', 'PATCH', body);
      assert(applied.changed && applied.order_version === Number(current.version) + 1);
      const replay = await api('/orders/' + state.order.id + '/fields', 'PATCH', body);
      assert(replay.reused && replay.order_version === applied.order_version);
      const stale = await api(
        '/orders/' + state.order.id + '/fields',
        'PATCH',
        {
          ...body,
          client_key: randomUUID(),
          changes: [{ ...changes[0], value: 'Stara wersja' }],
        },
        409,
      );
      assert.equal(stale.status, 409);
      const projected = await api(
        '/orders?' +
          new URLSearchParams({
            field_columns: JSON.stringify(state.fields.map((definition: any) => definition.id)),
            field_filters: JSON.stringify([
              {
                field_id: state.fields[1].id,
                definition_version: 1,
                operator: 'gte',
                value: '999999999999.123456',
              },
            ]),
          }),
      );
      assert.equal(projected.data.length, 1);
      assert.equal(projected.data[0].extra_fields.length, 7);
      const download = await fetch(
        'http://127.0.0.1:4100/api/order-field-files/' + state.file.id + '/download',
        { headers: { cookie } },
      );
      assert.equal(download.status, 200);
      assert.equal(Buffer.from(await download.arrayBuffer()).toString('base64'), png);
      const rows = (
        await pool.query(
          'SELECT type,payload FROM order_field_values WHERE tenant_id=$1 AND order_id=$2 ORDER BY type',
          [state.tenant, state.order.id],
        )
      ).rows;
      assert.equal(rows.length, 7);
      assert.equal(rows.find((row) => row.type === 'number').payload.value, '999999999999.123456');
      state.apiAcceptance = {
        all_seven_types: true,
        exact_decimal: true,
        leap_date: true,
        patch_replay: true,
        stale_order_zero_writes: true,
        typed_filter_columns: true,
        private_file_download_exact: true,
      };
      await save();
      console.log({ phase, ...state.apiAcceptance });
    } else if (phase === 'observe') {
      assert(state.apiAcceptance?.all_seven_types);
      const uiDefinition = (
        await pool.query(
          "SELECT id FROM order_field_definitions WHERE tenant_id=$1 AND key='customer_case'",
          [state.tenant],
        )
      ).rows[0];
      assert(uiDefinition, 'Native designer definition must exist');
      const uiOrder = (
        await pool.query(
          "SELECT id,number,version,status FROM orders WHERE tenant_id=$1 AND email='qa100-new@example.test'",
          [state.tenant],
        )
      ).rows;
      assert.equal(uiOrder.length, 1, 'Native create must produce exactly one order');
      assert.equal(Number(uiOrder[0].version), 1, 'Initial fields do not bump create revision');
      state.uiOrder = uiOrder[0];
      const customerValues = (
        await pool.query(
          'SELECT order_id,payload FROM order_field_values WHERE tenant_id=$1 AND field_id=$2 ORDER BY order_id',
          [state.tenant, uiDefinition.id],
        )
      ).rows;
      assert.equal(customerValues.length, 2);
      assert.equal(
        customerValues.find((row) => row.order_id === state.order.id).payload.value,
        'ZGŁ-100-0001',
      );
      assert.equal(
        customerValues.find((row) => row.order_id === state.uiOrder.id).payload.value,
        'ZGŁ-100-0002',
      );
      const instruction = (
        await pool.query(
          'SELECT payload FROM order_field_values WHERE tenant_id=$1 AND order_id=$2 AND field_id=$3',
          [state.tenant, state.order.id, state.fields[0].id],
        )
      ).rows[0];
      assert.equal(instruction.payload.value, 'Zapakuj osobno — sprawdzono w panelu QA100');
      const jobs = (
        await pool.query('SELECT id,kind,payload FROM jobs WHERE tenant_id=$1 ORDER BY id', [
          state.tenant,
        ])
      ).rows;
      const createJobs = jobs.filter((job) => !state.setupJobIds.includes(job.id));
      assert.equal(createJobs.length, 1, 'Only the native new-order event may add a job');
      assert.equal(createJobs[0].kind, 'automation');
      assert.equal(createJobs[0].payload.trigger, 'order.created');
      assert.equal(createJobs[0].payload.orderId, state.uiOrder.id);
      assert.deepEqual(createJobs[0].payload.rules, [], 'No provider action configured');
      const createEvent = (
        await pool.query(
          'SELECT id FROM order_events WHERE tenant_id=$1 AND order_id=$2 AND id=$3 AND kind=$4',
          [state.tenant, state.uiOrder.id, createJobs[0].payload.eventId, 'order.created'],
        )
      ).rows;
      assert.equal(createEvent.length, 1, 'Create job must reference the actual order event');
      assert.deepEqual(
        jobs.filter((job) => state.setupJobIds.includes(job.id)).map((job) => job.id),
        state.setupJobIds,
        'Field changes must not queue broad provider effects',
      );
      const order = (
        await pool.query(
          'SELECT status,total,payment_mode FROM orders WHERE tenant_id=$1 AND id=$2',
          [state.tenant, state.order.id],
        )
      ).rows[0];
      assert.equal(order.status, state.order.status);
      assert.equal(order.total, state.order.total);
      const stock = (
        await pool.query(
          'SELECT on_hand,reserved FROM stock WHERE tenant_id=$1 AND product_id=$2',
          [state.tenant, state.product.id],
        )
      ).rows[0];
      assert.equal(stock.on_hand, 100);
      assert.equal(stock.reserved, 2);
      state.uiAcceptance = {
        designer_create: true,
        atomic_two_value_edit: true,
        history_visible: true,
        filter_and_column: true,
        order_initial_field_create: true,
        initial_order_version: 1,
      };
      state.observedFields = await ownFields(state.tenant);
      await save();
      console.log({
        phase,
        field_tables: fieldTables.length,
        normal_order_created_jobs: createJobs.length,
        no_provider_jobs_from_field_changes: true,
        stock_and_fulfillment_preserved: true,
      });
    } else if (phase === 'verify') {
      assert.deepEqual(await fingerprints(state.ids), state.before);
      assert.equal(
        hash(
          (
            await pool.query(
              'SELECT id,email,name,password_hash FROM users WHERE id=ANY($1::uuid[]) ORDER BY id',
              [state.userIds],
            )
          ).rows,
        ),
        state.usersHash,
      );
      assert(state.observedFields, 'Observe module state before restart verification');
      assert.deepEqual(await ownFields(state.tenant), state.observedFields);
      const report = {
        phase,
        previous_firms_preserved: state.ids.length,
        previous_users_preserved: state.userIds.length,
        business_tables_preserved: tables.length,
        revision: health.revision,
        schema_revision: health.schema_revision,
        native_api: state.apiAcceptance ?? null,
        native_ui: state.uiAcceptance ?? null,
        field_tables_preserved: fieldTables.length,
        no_provider_jobs_from_field_changes: true,
        external_provider_verified: false,
        goal_complete: false,
      };
      await writeFile('docs/order-fields-native-qa.json', JSON.stringify(report, null, 2) + '\n');
      console.log(report);
    } else throw Error('Unknown proof phase');
  }
} finally {
  await pool.end();
}
