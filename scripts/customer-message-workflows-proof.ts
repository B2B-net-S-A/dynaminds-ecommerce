/** Local QA103. Baseline and assertions never print credentials or portal tokens. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';

const statePath = 'data/customer-message-workflows-stage103.json';
const phase = process.argv[2];
const effectTables = [
  'jobs',
  'audit_events',
  'outbound_events',
  'outbound_deliveries',
  'email_messages',
  'sms_messages',
];
const ownNames = (state: any) => [
  ...new Set([
    ...state.names,
    ...effectTables,
    'automation_rules',
    'automation_runs',
    'customer_message_workflow_receipts',
    'customer_message_workflow_requests',
    'customer_message_workflow_actions',
  ]),
];
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
let cookie = '';
async function api(path: string, method = 'GET', body?: unknown, expected = 200) {
  const response = await fetch('http://127.0.0.1:4100/api' + path, {
    method,
    headers: { cookie, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal(response.status, expected, path + ' ' + response.status);
  const newCookie = response.headers.get('set-cookie');
  if (newCookie) cookie = newCookie.split(';')[0];
  return response.json() as Promise<any>;
}
async function fingerprint(ids: string[], names: string[], normalizeAssignment = false) {
  const result: Record<string, string> = {};
  for (const name of names) {
    assert(/^[a-z][a-z0-9_]*$/.test(name));
    const projection =
      normalizeAssignment && name === 'customer_message_threads'
        ? "CASE WHEN to_jsonb(t)->>'assigned_user_id' IS NULL THEN to_jsonb(t)-'assigned_user_id' ELSE to_jsonb(t) END"
        : 'to_jsonb(t)';
    const column = name === 'tenants' ? 'id' : 'tenant_id';
    result[name] = digest(
      (
        await pool.query(
          `SELECT ${projection} row FROM "${name}" t WHERE ${column}=ANY($1::uuid[]) ORDER BY 1`,
          [ids],
        )
      ).rows,
    );
  }
  return result;
}
const save = (state: any) => writeFile(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
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
async function assertLocalWorkflowEffects(state: any) {
  const jobs = (
    await pool.query(
      "SELECT count(*) FILTER (WHERE state IN ('pending','running'))::int active,count(*) FILTER (WHERE kind NOT IN ('automation','automation.run'))::int nonlocal FROM jobs WHERE tenant_id=$1",
      [state.tenant],
    )
  ).rows[0];
  assert.equal(jobs.active, 0, 'Own jobs must be terminal');
  assert.equal(jobs.nonlocal, 0, 'Own fixture must not create provider or other jobs');
  for (const table of effectTables.slice(2))
    assert.equal(
      (await pool.query(`SELECT count(*)::int n FROM ${table} WHERE tenant_id=$1`, [state.tenant]))
        .rows[0].n,
      0,
      'Unexpected own provider effect in ' + table,
    );
  const run = (
    await pool.query('SELECT state FROM automation_runs WHERE tenant_id=$1 AND id=$2', [
      state.tenant,
      state.run.id,
    ])
  ).rows[0];
  assert.equal(run?.state, 'done', 'Accepted own workflow must remain done');
}
try {
  if (phase === 'baseline') {
    const health = await api('/health');
    assert.equal(health.schema_revision, '080_order_field_mappings');
    const previous = JSON.parse(await readFile('data/order-field-mappings-stage102.json', 'utf8'));
    const names = Object.keys(previous.ownSnapshot);
    assert.equal(names.length, 64);
    const ids = (await pool.query('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id);
    const userIds = (await pool.query('SELECT id FROM users ORDER BY id')).rows.map((r) => r.id);
    const state = {
      created_at: new Date().toISOString(),
      baseline_revision: health.revision,
      baseline_schema: health.schema_revision,
      ids,
      userIds,
      names,
      users_hash: await usersHash(userIds),
      before: await fingerprint(ids, names, true),
    };
    await writeFile(statePath, JSON.stringify(state, null, 2), { mode: 0o600, flag: 'wx' });
    console.log({
      phase,
      prior_firms: ids.length,
      prior_users: userIds.length,
      fingerprints: names.length,
    });
  } else {
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    if (phase === 'verify-previous') {
      assert.deepEqual(await fingerprint(state.ids, state.names, true), state.before);
      assert.equal(await usersHash(state.userIds), state.users_hash);
      console.log({
        phase,
        prior_firms: state.ids.length,
        prior_users: state.userIds.length,
        fingerprints: state.names.length,
        unchanged: true,
      });
    } else if (phase === 'setup') {
      assert(!state.tenant, 'Do not recreate fixture');
      const health = await api('/health');
      assert.equal(health.schema_revision, '081_customer_message_workflows');
      state.email = 'qa-customer-workflows-103@demo.local';
      state.password = 'DynaInbox!2026-' + randomUUID();
      const signup = await api(
        '/auth/signup',
        'POST',
        {
          email: state.email,
          password: state.password,
          name: 'QA obsługa103',
          organization: { name: 'QA obsługa wiadomości103' },
        },
        201,
      );
      state.tenant = signup.user.tenant_id;
      state.user = signup.user.id;
      assert(!state.ids.includes(state.tenant));
      await save(state);
      state.operator_email = 'qa-customer-operator-103@demo.local';
      state.operator_password = 'DynaOperator!2026-' + randomUUID();
      const invitation = await api(
        '/workspaces/invitations',
        'POST',
        {
          email: state.operator_email,
          role: 'operator',
        },
        201,
      );
      const operator = await api(
        '/auth/signup',
        'POST',
        {
          email: state.operator_email,
          password: state.operator_password,
          name: 'Operator obsługi QA103',
          invitation_token: invitation.token,
        },
        201,
      );
      state.operator_user = operator.user.id;
      assert.equal(operator.user.tenant_id, state.tenant);
      await save(state);
      await api('/auth/login', 'POST', { email: state.email, password: state.password });
      state.warehouse = (await api('/warehouses')).data[0].id;
      state.product = await api(
        '/products',
        'POST',
        {
          sku: 'QA103-INBOX',
          name: 'Produkt obsługi klienta103',
          price: 7500,
          quantity: 100,
          warehouse_id: state.warehouse,
        },
        201,
      );
      state.orders = [];
      for (let index = 0; index < 3; index++) {
        const order = await api(
          '/orders',
          'POST',
          {
            customer_name: 'Kupujący QA103-' + index,
            email: 'buyer103@example.test',
            warehouse_id: state.warehouse,
            items: [{ product_id: state.product.id, quantity: index + 1 }],
          },
          201,
        );
        state.orders.push(await api('/orders/' + order.id));
        await save(state);
      }
      console.log({ phase, own_firm: true, orders: state.orders.length, provider_writes: 0 });
    } else if (phase === 'exercise') {
      assert(
        state.tenant && !state.api_acceptance && !state.exercise_started,
        'Do not replay the entire exercise',
      );
      state.exercise_started = true;
      await save(state);
      await api('/auth/login', 'POST', { email: state.email, password: state.password });
      for (let attempt = 0; attempt < 40; attempt++) {
        const pending = (
          await pool.query(
            "SELECT count(*)::int n FROM jobs WHERE tenant_id=$1 AND state IN ('pending','running')",
            [state.tenant],
          )
        ).rows[0].n;
        if (!pending) break;
        assert(attempt < 39, 'Own setup jobs did not settle');
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const order = state.orders[0];
      const business = async () => {
        const result: Record<string, string> = {};
        for (const table of [
          'orders',
          'order_items',
          'stock',
          'reservations',
          'payment_entries',
          'shipments',
          'documents',
        ])
          result[table] = digest(
            (
              await pool.query(
                `SELECT to_jsonb(t) row FROM "${table}" t WHERE tenant_id=$1 ORDER BY 1`,
                [state.tenant],
              )
            ).rows,
          );
        return result;
      };
      const before = await business();
      const inbound = { client_key: randomUUID(), body: 'Pytanie przed regułą QA103' };
      state.initial_message = inbound;
      await save(state);
      await api('/public/orders/' + order.portal_token + '/messages', 'POST', inbound, 201);
      let thread = (await api('/customer-messages?order_id=' + order.id)).data[0];
      assert(thread);
      state.thread = thread.id;
      const assigned = await api('/customer-messages/' + thread.id + '/assignment', 'PATCH', {
        assigned_user_id: state.operator_user,
        version: thread.version,
      });
      assert.equal(assigned.assigned_user_id, state.operator_user);
      const ruleInput = {
        client_key: randomUUID(),
        name: 'Obsługa wiadomości QA103 API',
        trigger: 'customer_message.received',
        enabled: false,
        priority: 30,
        delay_seconds: 0,
        match: 'all',
        conditions: [{ field: 'total', op: 'eq', value: 7500 }],
        actions: [
          { type: 'customer_message_assign', assigned_user_id: state.operator_user },
          {
            type: 'customer_message_reply',
            body: 'Otrzymaliśmy Twoją wiadomość QA103. Operator sprawdzi zamówienie.',
          },
          {
            type: 'customer_message_note',
            body: 'Prywatna kontrola QA103 — nie pokazuj kupującemu.',
          },
          { type: 'customer_message_status', status: 'closed' },
        ],
      };
      state.rule_request = ruleInput;
      await save(state);
      state.rule = (await api('/customer-message-workflows/rules', 'POST', ruleInput, 201)).rule;
      await save(state);
      const previewNames = [
        ...state.names,
        'audit_events',
        'jobs',
        'automation_rules',
        'automation_runs',
        'customer_message_workflow_receipts',
        'customer_message_workflow_requests',
        'customer_message_workflow_actions',
      ];
      const replayBefore = await fingerprint([state.tenant], previewNames);
      const ruleRetry = await api('/customer-message-workflows/rules', 'POST', ruleInput);
      assert.equal(ruleRetry.reused, true);
      assert.equal(ruleRetry.rule.id, state.rule.id);
      assert.deepEqual(await fingerprint([state.tenant], previewNames), replayBefore);
      const previewBefore = await fingerprint([state.tenant], previewNames);
      const preview = await api(
        '/customer-message-workflows/rules/' + state.rule.id + '/preview',
        'POST',
        { order_id: order.id },
      );
      assert.equal(preview.allowed, true);
      assert.deepEqual(await fingerprint([state.tenant], previewNames), previewBefore);
      state.enable_request = {
        client_key: randomUUID(),
        version: state.rule.version,
        enabled: true,
      };
      await save(state);
      state.rule = (
        await api(
          '/customer-message-workflows/rules/' + state.rule.id,
          'PATCH',
          state.enable_request,
        )
      ).rule;
      const incoming = { client_key: randomUUID(), body: 'Proszę o status realizacji QA103' };
      state.workflow_incoming = incoming;
      await save(state);
      const message = await api(
        '/public/orders/' + order.portal_token + '/messages',
        'POST',
        incoming,
        201,
      );
      assert.equal(message.reused, false);
      const retry = await api(
        '/public/orders/' + order.portal_token + '/messages',
        'POST',
        incoming,
      );
      assert.equal(retry.reused, true);
      assert.equal(retry.id, message.id);
      for (let attempt = 0; attempt < 40; attempt++) {
        const runs = await api('/customer-message-workflows/runs?order_id=' + order.id);
        const done = runs.data.find(
          (row: any) => row.rule_id === state.rule.id && row.state === 'done',
        );
        if (done) {
          state.run = done;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      assert(state.run, 'Native worker did not finish own workflow');
      thread = await api('/customer-messages/' + state.thread);
      assert.equal(thread.assigned_user_id, state.operator_user);
      assert.equal(thread.status, 'closed');
      assert.equal(thread.data.filter((row: any) => row.kind === 'reply').length, 1);
      assert.equal(thread.data.filter((row: any) => row.kind === 'note').length, 1);
      const publicThread = await api('/public/orders/' + order.portal_token + '/messages');
      assert(!JSON.stringify(publicThread).includes('Prywatna kontrola'));
      assert(!('assigned_user_id' in publicThread));
      assert.equal(publicThread.data.filter((row: any) => row.kind === 'reply').length, 1);
      assert.deepEqual(await business(), before);
      const receiptCount = (
        await pool.query(
          'SELECT count(*)::int n FROM customer_message_workflow_receipts WHERE tenant_id=$1',
          [state.tenant],
        )
      ).rows[0].n;
      assert.equal(receiptCount, 1);
      await assertLocalWorkflowEffects(state);
      state.own_names = ownNames(state);
      state.own_snapshot = await fingerprint([state.tenant], state.own_names);
      state.own_snapshot_version = 2;
      state.own_snapshot_timezone = (await pool.query('SHOW TimeZone')).rows[0].TimeZone;
      state.api_acceptance = true;
      state.runtime_revision = (await api('/health')).revision;
      await save(state);
      await writeFile(
        'docs/customer-message-workflows-native-qa.json',
        JSON.stringify(
          {
            stage: 103,
            revision: state.runtime_revision,
            schema: '081_customer_message_workflows',
            own_synthetic_firm: true,
            assignment: true,
            preview_rollback: true,
            run_id: state.run.id,
            run_state: state.run.state,
            receipt_count: receiptCount,
            local_replies: 1,
            private_notes: 1,
            thread_status: thread.status,
            buyer_replay: true,
            public_private_note_hidden: true,
            business_unchanged: true,
            provider_writes: 0,
            goal_complete: false,
          },
          null,
          2,
        ),
      );
      console.log({ phase, run: 'done', replies: 1, notes: 1, receipts: 1, provider_writes: 0 });
    } else if (phase === 'strengthen') {
      assert(state.api_acceptance && state.own_snapshot && state.run?.state === 'done');
      const health = await api('/health');
      assert.equal(health.schema_revision, '081_customer_message_workflows');
      assert.equal(health.revision, state.runtime_revision);
      // Preserve the earlier acceptance first; never replace a drifted snapshot.
      assert.deepEqual(await fingerprint([state.tenant], state.own_names), state.own_snapshot);
      assert.deepEqual(await fingerprint(state.ids, state.names, true), state.before);
      assert.equal(await usersHash(state.userIds), state.users_hash);
      await assertLocalWorkflowEffects(state);
      state.own_names = ownNames(state);
      state.own_snapshot = await fingerprint([state.tenant], state.own_names);
      state.own_snapshot_version = 2;
      state.own_snapshot_timezone = (await pool.query('SHOW TimeZone')).rows[0].TimeZone;
      state.strengthened_at = new Date().toISOString();
      await save(state);
      console.log({
        phase,
        fingerprints: state.own_names.length,
        terminal_jobs: true,
        provider_effects: 0,
      });
    } else if (phase === 'verify') {
      assert(state.api_acceptance && state.own_snapshot);
      assert.equal(state.own_snapshot_version, 2, 'Run the readonly strengthen phase first');
      const health = await api('/health');
      assert.equal(health.schema_revision, '081_customer_message_workflows');
      assert.equal(health.revision, state.runtime_revision);
      assert.deepEqual(await fingerprint([state.tenant], state.own_names), state.own_snapshot);
      assert.deepEqual(await fingerprint(state.ids, state.names, true), state.before);
      assert.equal(await usersHash(state.userIds), state.users_hash);
      await assertLocalWorkflowEffects(state);
      console.log({
        phase,
        own_business: true,
        prior_firms: state.ids.length,
        prior_users: state.userIds.length,
      });
    } else throw new Error('Unknown proof phase');
  }
} finally {
  await pool.end();
}
