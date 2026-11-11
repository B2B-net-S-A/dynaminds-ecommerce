/** Read-only assertions of the actual IAB QA103 interactions; never prints secrets. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pool } from '../server/db';
const path = 'data/customer-message-workflows-stage103.json';
const phase = process.argv[2];
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
async function snapshot(state: any, names: string[]) {
  const result: Record<string, string> = {};
  for (const name of names) {
    assert(/^[a-z][a-z0-9_]*$/.test(name));
    result[name] = digest(
      (
        await pool.query(
          `SELECT to_jsonb(t) row FROM "${name}" t WHERE ${name === 'tenants' ? 'id' : 'tenant_id'}=$1 ORDER BY 1`,
          [state.tenant],
        )
      ).rows,
    );
  }
  return result;
}
const business = [
  'orders',
  'order_items',
  'stock',
  'reservations',
  'payment_entries',
  'shipments',
  'documents',
  'outbound_events',
  'outbound_deliveries',
  'email_messages',
  'sms_messages',
];
try {
  const state = JSON.parse(await readFile(path, 'utf8'));
  assert(state.api_acceptance);
  if (phase === 'begin') {
    assert(!state.ui_started, 'Do not repeat UI beginning');
    state.ui_started = true;
    state.ui_business_before = await snapshot(state, business);
  } else if (phase === 'preview-before') {
    assert(state.ui_started && !state.ui_preview_before);
    state.ui_preview_before = await snapshot(state, [
      ...new Set([...state.own_names, 'jobs', 'audit_events']),
    ]);
  } else if (phase === 'preview-after') {
    assert(state.ui_preview_before);
    assert.deepEqual(
      await snapshot(state, Object.keys(state.ui_preview_before)),
      state.ui_preview_before,
    );
    state.ui_preview_rollback = true;
  } else if (phase === 'finish') {
    assert(state.ui_preview_rollback && !state.ui_acceptance);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int n FROM jobs WHERE tenant_id=$1 AND state IN('pending','running')",
          [state.tenant],
        )
      ).rows[0].n,
      0,
    );
    assert.deepEqual(await snapshot(state, business), state.ui_business_before);
    const rule = (
      await pool.query(
        "SELECT * FROM automation_rules WHERE tenant_id=$1 AND name='Obsługa wiadomości QA103 UI'",
        [state.tenant],
      )
    ).rows;
    assert.equal(rule.length, 1);
    assert(rule[0].enabled);
    assert.equal(rule[0].trigger, 'customer_message.received');
    assert.deepEqual(rule[0].config.conditions, [{ field: 'total', op: 'eq', value: 15000 }]);
    assert.equal(rule[0].config.actions.length, 4);
    const runs = (
      await pool.query(
        'SELECT * FROM automation_runs WHERE tenant_id=$1 AND rule_id=$2 AND order_id=$3',
        [state.tenant, rule[0].id, state.orders[1].id],
      )
    ).rows;
    assert.equal(runs.length, 1);
    assert.equal(runs[0].state, 'done');
    assert.equal(runs[0].result.actions.length, 4);
    const thread = (
      await pool.query(
        'SELECT * FROM customer_message_threads WHERE tenant_id=$1 AND order_id=$2',
        [state.tenant, state.orders[1].id],
      )
    ).rows[0];
    assert.equal(thread.assigned_user_id, state.operator_user);
    assert.equal(thread.status, 'closed');
    const messages = (
      await pool.query(
        'SELECT * FROM customer_messages WHERE tenant_id=$1 AND thread_id=$2 ORDER BY created_at,id',
        [state.tenant, thread.id],
      )
    ).rows;
    assert.equal(messages.filter((r) => r.kind === 'buyer').length, 2);
    assert.equal(
      messages.filter(
        (r) =>
          r.kind === 'reply' && r.body === 'Odpowiedź UI QA103 — sprawdzimy realizację zamówienia.',
      ).length,
      1,
    );
    assert.equal(
      messages.filter(
        (r) =>
          r.kind === 'note' && r.body === 'Prywatna notatka UI QA103 — widoczna tylko dla obsługi.',
      ).length,
      1,
    );
    const res = await fetch(
      'http://127.0.0.1:4100/api/public/orders/' + state.orders[1].portal_token + '/messages',
    );
    assert.equal(res.status, 200);
    const data: any = await res.json();
    assert(!JSON.stringify(data).includes('Prywatna notatka'));
    assert(!('assigned_user_id' in data));
    assert.equal(data.data.filter((r: any) => r.kind === 'reply').length, 1);
    state.ui_rule_id = rule[0].id;
    state.ui_run_id = runs[0].id;
    state.ui_thread_id = thread.id;
    state.ui_acceptance = true;
    state.own_names = [
      ...new Set([
        ...state.own_names,
        'jobs',
        'audit_events',
        'outbound_events',
        'outbound_deliveries',
        'email_messages',
        'sms_messages',
      ]),
    ];
    state.own_snapshot = await snapshot(state, state.own_names);
    state.own_snapshot_version = 2;
    await writeFile(
      'docs/customer-message-workflows-ui-qa.json',
      JSON.stringify(
        {
          stage: 103,
          revision: state.runtime_revision,
          schema: '081_customer_message_workflows',
          actual_iab_interactions: true,
          rule_default_off: true,
          explicit_enable: true,
          condition_total: 15000,
          actions: 4,
          preview_exact_rollback: true,
          run_state: 'done',
          reply_count: 1,
          note_count: 1,
          assignment: true,
          thread_status: 'closed',
          public_private_note_hidden: true,
          business_unchanged: true,
          provider_effects_unchanged: true,
          own_snapshot_entries: state.own_names.length,
          goal_complete: false,
        },
        null,
        2,
      ) + '\n',
    );
  } else throw Error('Unknown UI proof phase');
  await writeFile(path, JSON.stringify(state, null, 2), { mode: 0o600 });
  console.log({ phase, verified: true });
} finally {
  await pool.end();
}
