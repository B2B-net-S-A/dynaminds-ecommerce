import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
const phase = process.argv[2];
const statePath = 'data/order-field-batches-stage101.json';
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
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
const previousFieldTables = [
  'order_field_definitions',
  'order_field_definition_revisions',
  'order_field_options',
  'order_field_values',
  'order_field_value_events',
  'order_field_files',
  'order_field_requests',
];

const previousTables = [...tables, ...previousFieldTables];
const batchTables = [
  'order_field_batch_previews',
  'order_field_batch_rows',
  'order_field_batch_executions',
  'order_field_batch_execution_rows',
];
async function fingerprints(ids: string[], scope = previousTables) {
  const result: Record<string, string> = {};
  for (const table of scope)
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
async function api(
  path: string,
  method = 'GET',
  body?: unknown,
  expected: number | number[] = 200,
) {
  const r = await fetch('http://127.0.0.1:4100/api' + path, {
    method,
    headers: { cookie, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert(
    (Array.isArray(expected) ? expected : [expected]).includes(r.status),
    path + ' ' + r.status,
  );
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
  return r.json() as Promise<any>;
}
try {
  if (phase === 'baseline') {
    const health = await api('/health');
    assert.equal(health.schema_revision, '078_order_fields');
    assert.equal(
      (await pool.query("SELECT to_regclass('public.order_field_batch_previews') present")).rows[0]
        .present,
      null,
    );
    const ids = (await pool.query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id);
    const users = (await pool.query('SELECT id,email,name,password_hash FROM users ORDER BY id'))
      .rows;
    await writeFile(
      statePath,
      JSON.stringify(
        {
          ids,
          userIds: users.map((r) => r.id),
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
      business_tables: previousTables.length,
    });
  } else if (phase === 'setup') {
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    assert(!state.tenant, 'Do not recreate setup');
    const save = () => writeFile(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
    state.email = 'qa-field-batches-101@demo.local';
    state.password = 'DynaFieldBatch!2026';
    const signup = await api(
      '/auth/signup',
      'POST',
      {
        email: state.email,
        password: state.password,
        name: 'QA pola CSV101',
        organization: { name: 'QA pola CSV i bulk101' },
      },
      201,
    );
    state.tenant = signup.user.tenant_id;
    state.user = signup.user.id;
    assert(!state.ids.includes(state.tenant));
    await save();
    state.warehouse = (await api('/warehouses')).data[0].id;
    state.product = await api(
      '/products',
      'POST',
      {
        sku: 'QA101-FIELDS',
        name: 'Kubek wymiany pól',
        price: 4200,
        quantity: 100,
        warehouse_id: state.warehouse,
      },
      201,
    );
    state.orders = [];
    for (const n of [1, 2])
      state.orders.push(
        await api(
          '/orders',
          'POST',
          {
            customer_name: 'Lokalny CSV101 ' + n,
            email: 'qa101-' + n + '@example.test',
            warehouse_id: state.warehouse,
            items: [{ product_id: state.product.id, quantity: 1 }],
          },
          201,
        ),
      );
    const one = randomUUID(),
      two = randomUUID();
    state.options = [one, two];
    state.fields = [];
    for (const [key, label, type, config, options] of [
      ['csv_text', 'Instrukcja CSV', 'text', {}, []],
      ['csv_number', 'Dokładna liczba CSV', 'number', { scale: 6 }, []],
      [
        'csv_select',
        'Lista CSV',
        'select',
        {},
        [
          { id: one, label: 'Standard', enabled: true },
          { id: two, label: 'Prezent', enabled: true },
        ],
      ],
      [
        'csv_radio',
        'Kontakt CSV',
        'radio',
        {},
        [
          { id: one, label: 'Standard', enabled: true },
          { id: two, label: 'Prezent', enabled: true },
        ],
      ],
      [
        'csv_multi',
        'Opcje CSV',
        'multi_select',
        {},
        [
          { id: one, label: 'Standard', enabled: true },
          { id: two, label: 'Prezent', enabled: true },
        ],
      ],
      ['csv_date', 'Data CSV', 'date', {}, []],
      ['csv_file', 'Plik CSV', 'file', {}, []],
    ] as const)
      state.fields.push(
        await api(
          '/order-fields',
          'POST',
          {
            client_key: randomUUID(),
            key,
            label,
            type,
            config,
            options,
            read_role: 'team',
            write_role: 'operator',
          },
          201,
        ),
      );
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cFyoAAAAASUVORK5CYII=';
    state.files = [];
    for (const o of state.orders)
      state.files.push(
        await api(
          '/order-field-files',
          'POST',
          {
            client_key: randomUUID(),
            order_id: o.id,
            field_id: state.fields[6].id,
            definition_version: 1,
            filename: 'QA101-' + o.id + '.png',
            content_base64: png,
          },
          201,
        ),
      );
    state.setupJobs = (
      await pool.query('SELECT id,kind,payload FROM jobs WHERE tenant_id=$1 ORDER BY id', [
        state.tenant,
      ])
    ).rows;
    await save();
    console.log({
      phase,
      new_qa_firm: true,
      orders: state.orders.length,
      field_types: state.fields.length,
      private_files: state.files.length,
    });
  } else if (phase === 'exercise') {
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    assert(state.files?.length === 2);
    assert(!state.apiAcceptance);
    assert(!state.previews?.length, 'Partial exercise requires review before resuming');
    const save = () => writeFile(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
    const health = await api('/health');
    assert.equal(health.schema_revision, '079_order_field_batches');
    if (process.env.PROOF_REVISION) assert.equal(health.revision, process.env.PROOF_REVISION);
    await api('/auth/login', 'POST', { email: state.email, password: state.password });
    const fields = state.fields.map((d: any, i: number) => ({
      column: i + 2,
      field_id: d.id,
      definition_version: d.version,
    }));
    const config = {
      encoding: 'utf-8',
      delimiter: ';',
      header: true,
      identity: { kind: 'order_id', column: 0 },
      order_version_column: 1,
      fields,
    };
    const csvCell = (v: unknown) => '"' + String(v).replaceAll('"', '""') + '"';
    const wire = (value: unknown) => JSON.stringify({ operation: 'set', value });
    const text = '=SUM(1,2)\nŻółć i instrukcja CSV101';
    const csv = [
      ['order_id', 'order_version', ...state.fields.map((d: any) => 'field.' + d.key)]
        .map(csvCell)
        .join(';'),
      ...state.orders.map((o: any, i: number) =>
        [
          o.id,
          String(o.version),
          ...[
            text,
            '999999999999.123456',
            state.options[0],
            state.options[1],
            [],
            '2028-02-29',
            state.files[i].id,
          ].map(wire),
        ]
          .map(csvCell)
          .join(';'),
      ),
    ].join('\r\n');
    state.csvPayload = Buffer.from(csv, 'utf8').toString('base64');
    state.previews = [];
    state.executions = [];
    const wait = async (id: string) => {
      for (let n = 0; n < 100; n++) {
        const result = await api('/order-field-batches/executions/' + id);
        if (result.state !== 'queued') {
          assert.equal(result.state, 'done', JSON.stringify(result));
          return result;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw Error('Own execution did not complete');
    };
    const queue = async (p: any, concurrent = false) => {
      const body = {
        client_key: randomUUID(),
        selected_rows: p.data.map((r: any) => r.row_id),
        consent: {
          scope_hash: p.scope_hash,
          selected_count: p.data.length,
          policy: p.policy,
          local_only: true,
        },
      };
      const responses = concurrent
        ? await Promise.all([
            api('/order-field-batches/previews/' + p.id + '/queue', 'POST', body, [200, 201]),
            api('/order-field-batches/previews/' + p.id + '/queue', 'POST', body, [200, 201]),
          ])
        : [await api('/order-field-batches/previews/' + p.id + '/queue', 'POST', body, 201)];
      assert(responses[0].execution.id);
      if (concurrent) assert.equal(responses[0].execution.id, responses[1].execution.id);
      state.executions.push(responses[0].execution.id);
      await save();
      return wait(responses[0].execution.id);
    };
    const p = await api(
      '/order-field-batches/previews',
      'POST',
      {
        client_key: randomUUID(),
        kind: 'csv',
        policy: 'fill_unset',
        filename: 'QA101-siedem-typow.csv',
        content_base64: state.csvPayload,
        config,
      },
      201,
    );
    assert.equal(p.summary.ready, 2);
    assert.equal(p.data.length, 2);
    state.previews.push(p.id);
    await save();
    await queue(p, true);
    for (const [i, o] of state.orders.entries()) {
      const d = await api('/orders/' + o.id + '/fields');
      assert.equal(d.order_version, Number(o.version) + 1);
      assert.equal(d.data.length, 7);
      const expected = [
        text,
        '999999999999.123456',
        state.options[0],
        state.options[1],
        [],
        '2028-02-29',
        state.files[i].id,
      ];
      for (const [j, f] of state.fields.entries())
        assert.deepEqual(
          d.data.find((r: any) => r.definition.id === f.id).value.value,
          expected[j],
        );
    }
    const qs = new URLSearchParams({
      field_ids: JSON.stringify(state.fields.map((d: any) => d.id)),
      mode: 'csv_exact',
      limit: '1',
    });
    const first = await api('/order-field-batches/export?' + qs.toString());
    assert.equal(first.count, 1);
    assert(first.meta.cursor);
    const firstBytes = Buffer.from(first.content_base64, 'base64');
    assert.equal(createHash('sha256').update(firstBytes).digest('hex'), first.sha256);
    assert(firstBytes.toString('utf8').includes('999999999999.123456'));
    assert(first.config);
    qs.set('cursor', first.meta.cursor);
    const second = await api('/order-field-batches/export?' + qs.toString());
    assert.equal(second.count, 1);
    assert.equal(second.meta.cursor, null);
    state.exportHashes = [first.sha256, second.sha256];
    for (const ex of [first, second]) {
      const np = await api(
        '/order-field-batches/previews',
        'POST',
        {
          client_key: randomUUID(),
          kind: 'csv',
          policy: 'fill_unset',
          filename: ex.filename,
          content_base64: ex.content_base64,
          config: ex.config,
        },
        201,
      );
      assert.equal(np.summary.no_op, 1);
      state.previews.push(np.id);
      await save();
      await queue(np);
    }
    const beforeBulk = await Promise.all(
      state.orders.map((o: any) => api('/orders/' + o.id + '/fields')),
    );
    for (const d of beforeBulk)
      assert.equal(d.order_version, 2, 'No-op round-trip must not bump version');
    const sheet = await api(
      '/order-field-batches/export?' +
        new URLSearchParams({
          field_ids: JSON.stringify([state.fields[0].id]),
          mode: 'csv_sheet',
          limit: '2',
        }),
    );
    assert(
      Buffer.from(sheet.content_base64, 'base64').toString('utf8').includes("'=SUM"),
      'Spreadsheet export must neutralize formula prefix',
    );
    const json = await api(
      '/order-field-batches/export?' +
        new URLSearchParams({
          field_ids: JSON.stringify(state.fields.map((d: any) => d.id)),
          mode: 'json',
          limit: '2',
        }),
    );
    assert(
      Buffer.from(json.content_base64, 'base64').toString('utf8').includes('999999999999.123456'),
    );
    const bp = await api(
      '/order-field-batches/previews',
      'POST',
      {
        client_key: randomUUID(),
        kind: 'bulk',
        policy: 'replace',
        orders: beforeBulk.map((d: any) => ({
          order_id: d.order_id,
          order_version: d.order_version,
        })),
        changes: [
          {
            field_id: state.fields[0].id,
            definition_version: 1,
            type: 'text',
            value: 'Zweryfikowano w lokalnym API CSV101',
          },
        ],
      },
      201,
    );
    assert.equal(bp.summary.ready, 2);
    state.previews.push(bp.id);
    await save();
    await queue(bp);
    state.apiAcceptance = {
      all_seven_csv_types: true,
      private_file_scope: true,
      exact_decimal: true,
      leap_date: true,
      concurrent_queue_replay: true,
      export_two_keyset_pages: true,
      exact_csv_round_trip: true,
      no_op_versions_preserved: true,
      sheet_formula_neutralized: true,
      json_exact_decimal: true,
      bulk_two_orders: true,
    };
    state.api_revision = health.revision;
    await writeFile(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
    console.log({ phase, ...state.apiAcceptance });
  } else if (phase === 'ui-fixture') {
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    assert(state.apiAcceptance);
    await api('/auth/login', 'POST', { email: state.email, password: state.password });
    const orders = await Promise.all(
      state.orders.map((o: any) => api('/orders/' + o.id + '/fields')),
    );
    const csvCell = (v: unknown) => '"' + String(v).replaceAll('"', '""') + '"';
    const csv =
      [
        ['order_id', 'order_version', 'field.csv_text'],
        ...orders.map((o: any) => [
          o.order_id,
          String(o.order_version),
          JSON.stringify({ operation: 'set', value: 'Zapisano przez wybór CSV w panelu 101' }),
        ]),
      ]
        .map((row) => row.map(csvCell).join(';'))
        .join('\r\n') + '\r\n';
    await writeFile('data/QA101-ui-fields.csv', csv, { mode: 0o600 });
    console.log({ phase, own_orders: orders.length, mapped_field: state.fields[0].key });
  } else if (phase === 'ui-observe') {
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    assert(state.apiAcceptance);
    await api('/auth/login', 'POST', { email: state.email, password: state.password });
    for (const order of state.orders) {
      const values = await api('/orders/' + order.id + '/fields');
      assert.equal(values.order_version, 5);
      assert.equal(
        values.data.find((r: any) => r.definition.id === state.fields[0].id).value.value,
        'Zapisano przez wybór CSV w panelu 101',
      );
      assert.equal(
        values.data.find((r: any) => r.definition.id === state.fields[1].id).value.value,
        '999999999999.123456',
      );
    }
    const exports: any[] = [];
    const q = new URLSearchParams({
      field_ids: JSON.stringify([state.fields[0].id, state.fields[1].id]),
      order_ids: JSON.stringify(state.orders.map((o: any) => o.id)),
      mode: 'csv_exact',
      limit: '1',
    });
    for (const filename of ['order-fields.csv', 'order-fields (1).csv']) {
      const expected = await api('/order-field-batches/export?' + q);
      const bytes = await readFile('<home>/Downloads/' + filename);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), expected.sha256);
      assert.deepEqual(bytes, Buffer.from(expected.content_base64, 'base64'));
      exports.push({ filename, byte_count: bytes.length, sha256: expected.sha256 });
      if (expected.meta.cursor) q.set('cursor', expected.meta.cursor);
      else assert.equal(filename, 'order-fields (1).csv');
    }
    state.uiAcceptance = {
      browser: 'Codex IAB',
      bulk_two_orders: true,
      explicit_csv_file_chooser: true,
      explicit_mapping: true,
      frozen_before_after: true,
      exact_selection_and_consent: true,
      queue_and_done_result: true,
      both_order_versions: 5,
      csv_two_orders: true,
      exact_export_two_pages: true,
      downloaded_files_byte_exact: exports,
      download_event_bridge_timed_out: true,
      filesystem_bytes_verified: true,
      user_chrome_profile_verified: false,
    };
    await writeFile(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
    await writeFile(
      'docs/order-field-batches-ui-qa.json',
      JSON.stringify(
        { stage: 101, revision: (await api('/health')).revision, ...state.uiAcceptance },
        null,
        2,
      ) + '\n',
    );
    console.log({ phase, ui_values_and_downloads_verified: true, exported_pages: exports.length });
  } else if (phase === 'observe' || phase === 'verify') {
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    assert(state.apiAcceptance);
    const health = await api('/health');
    assert.equal(health.schema_revision, '079_order_field_batches');
    if (process.env.PROOF_REVISION) assert.equal(health.revision, process.env.PROOF_REVISION);
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
    const ownScope = [...previousFieldTables, ...batchTables];
    const own = await fingerprints([state.tenant], ownScope);
    if (phase === 'observe') {
      const jobs = (
        await pool.query('SELECT id,kind,payload FROM jobs WHERE tenant_id=$1 ORDER BY id', [
          state.tenant,
        ])
      ).rows;
      const oldIds = state.setupJobs.map((j: any) => j.id);
      const newJobs = jobs.filter((j) => !oldIds.includes(j.id));
      assert(
        newJobs.every(
          (j) => j.kind === 'order.fields.batch' && typeof j.payload.execution_id === 'string',
        ),
      );
      const executions = (
        await pool.query(
          'SELECT id,job_id,state FROM order_field_batch_executions WHERE tenant_id=$1 ORDER BY id',
          [state.tenant],
        )
      ).rows;
      assert.equal(newJobs.length, executions.length);
      assert(
        executions.every((e) =>
          newJobs.some((j) => j.id === e.job_id && j.payload.execution_id === e.id),
        ),
      );
      const stock = (
        await pool.query(
          'SELECT on_hand,reserved FROM stock WHERE tenant_id=$1 AND product_id=$2',
          [state.tenant, state.product.id],
        )
      ).rows[0];
      assert.equal(stock.on_hand, 100);
      assert.equal(stock.reserved, 2);
      state.observedOwn = own;
      state.executionCount = executions.length;
      await writeFile(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
      console.log({
        phase,
        previous_firms: state.ids.length,
        previous_tables: previousTables.length,
        own_field_tables: ownScope.length,
        executions: executions.length,
        no_provider_jobs: true,
      });
    } else {
      assert(state.observedOwn);
      assert.deepEqual(own, state.observedOwn);
      const report = {
        stage: 101,
        phase,
        revision: health.revision,
        schema_revision: health.schema_revision,
        previous_firms_preserved: state.ids.length,
        previous_users_preserved: state.userIds.length,
        business_tables_preserved: previousTables.length,
        own_field_tables_preserved: ownScope.length,
        native_api_revision: state.api_revision,
        native_api: state.apiAcceptance,
        native_ui: state.uiAcceptance ?? null,
        executions: state.executionCount,
        no_provider_jobs_from_field_changes: true,
        external_provider_verified: false,
        goal_complete: false,
      };
      await writeFile(
        'docs/order-field-batches-native-qa.json',
        JSON.stringify(report, null, 2) + '\n',
      );
      console.log(report);
    }
  } else throw Error('Proof phase not implemented: ' + phase);
} finally {
  await pool.end();
}
