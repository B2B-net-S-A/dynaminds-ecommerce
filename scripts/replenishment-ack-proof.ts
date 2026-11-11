/** Host-native QA118B, invoked only by the human/root operator.
 * setup creates an independent firm, two products and two suppliers ONLY.
 * Chrome creates PLN/EUR policies, previews and executes through the ACK proxy.
 * before-retry reads the committed lost-ACK result; verify compares after the
 * manual exact retry. after-flow reads a later PLN PZ6 + two-product NOP.
 * No phase sends policy/preview/execute/PO/receipt mutations or retries.
 * Required: QA_EXPECTED_REVISION=<actual health revision>; API localhost:4100.
 * Private state is wx/0600. An unresolved setup request requires manual readback;
 * setup never reruns or guesses an outcome. Public reports contain no secrets.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import type { PoolClient } from 'pg';
import { pool } from '../server/db';

type Json = Record<string, any>;
type Checkpoint = Record<string, { count: number; sha256: string }>;
const phase = process.argv[2];
assert(['setup', 'before-retry', 'verify', 'after-flow'].includes(phase));
const revision = process.env.QA_EXPECTED_REVISION;
assert(revision && /^[a-f0-9]{7,40}$/.test(revision));
const path = 'data/replenishment-ack-stage118.json';
const primaryPath = 'data/replenishment-stage118.json';
const schema = '099_replenishment_plans';
const sha = (x: string | Buffer) => createHash('sha256').update(x).digest('hex');
const hash = (v: unknown) => sha(JSON.stringify(v));
const primaryHash = sha(await readFile(primaryPath));

async function save(s: Json, fresh = false) {
  if (!fresh) {
    const stat = await lstat(path);
    assert(stat.isFile() && !stat.isSymbolicLink());
    assert.equal(stat.mode & 0o077, 0);
  }
  await writeFile(path, JSON.stringify(s, null, 2), { mode: 0o600, flag: fresh ? 'wx' : 'w' });
}
async function call(s: Json, endpoint: string, method = 'GET', body?: unknown, status = 200) {
  const response = await fetch('http://127.0.0.1:4100/api' + endpoint, {
    method,
    signal: AbortSignal.timeout(15000),
    headers: {
      ...(s.cookie ? { cookie: s.cookie, 'X-Workspace-ID': s.tenant } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  // Do not print response bodies: an authentication response can contain secrets.
  assert.equal(response.status, status, `${method} ${endpoint} unexpected status`);
  if (endpoint.startsWith('/replenishment/'))
    assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  return { response, data: (await response.json()) as Json };
}
async function setupPost(s: Json, endpoint: string, body: Json) {
  assert(!s.pending, 'Unresolved setup outcome: perform explicit manual readback');
  s.pending = { endpoint, body };
  await save(s);
  const result = (await call(s, endpoint, 'POST', body, 201)).data;
  s.pending = null;
  await save(s);
  return result;
}
async function ownSnapshot(c: PoolClient, s: Json): Promise<Checkpoint> {
  const names = (
    await c.query<{ name: string }>(
      `SELECT c.relname name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relkind IN ('r','p') AND
       (c.relname IN ('tenants','users') OR EXISTS
        (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='tenant_id' AND NOT a.attisdropped))
       ORDER BY c.relname`,
    )
  ).rows.map((r) => r.name);
  const checkpoint: Checkpoint = {};
  for (const name of names) {
    assert(/^[a-z_][a-z0-9_]*$/.test(name));
    // Sessions may legitimately be added by Chrome. Worker jobs are mutable and
    // are verified separately; all OMS/WMS/stock/proof/audit/event tables remain.
    if (['sessions', 'jobs'].includes(name)) continue;
    const field = ['tenants', 'users'].includes(name) ? 'id' : 'tenant_id';
    const rows = (
      await c.query(`SELECT to_jsonb(t) row FROM public."${name}" t WHERE ${field}=$1 ORDER BY 1`, [
        name === 'users' ? s.user : s.tenant,
      ])
    ).rows;
    checkpoint[name] = { count: rows.length, sha256: hash(rows) };
  }
  return checkpoint;
}
async function inspect(s: Json, partial: boolean) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    const policies = (
      await c.query('SELECT * FROM replenishment_policies WHERE tenant_id=$1 ORDER BY product_id', [
        s.tenant,
      ])
    ).rows;
    assert.equal(policies.length, 2);
    for (const currency of ['pln', 'eur']) {
      const p = policies.find((r) => r.product_id === s.products[currency].id);
      assert(p);
      const d = p.definition;
      assert.deepEqual(
        [
          p.warehouse_id,
          d.enabled,
          d.minimum_quantity,
          d.target_quantity,
          d.minimum_order_quantity,
          d.order_multiple,
          d.supplier_id,
          d.currency,
          d.unit_cost_minor,
        ],
        [
          s.warehouse.id,
          true,
          5,
          10,
          1,
          1,
          s.suppliers[currency].id,
          currency.toUpperCase(),
          currency === 'pln' ? 125 : 250,
        ],
      );
      assert(d.cost_confirmed_at && d.cost_valid_until);
    }
    const previews = (
      await c.query(
        'SELECT * FROM replenishment_previews WHERE tenant_id=$1 ORDER BY created_at,id',
        [s.tenant],
      )
    ).rows;
    const executions = (
      await c.query(
        'SELECT * FROM replenishment_executions WHERE tenant_id=$1 ORDER BY created_at,id',
        [s.tenant],
      )
    ).rows;
    assert.equal(previews.length, partial ? 2 : 1);
    assert.equal(executions.length, partial ? 2 : 1);
    const first = executions[0];
    assert.equal(first.actor_id, s.user);
    assert.equal(first.source, 'manual');
    assert.equal(first.preview_id, previews[0].id);
    assert.deepEqual(first.summary, {
      total: 2,
      purchase: 2,
      unchanged: 0,
      invalid: 0,
      conflicts: 0,
    });
    assert.equal(first.groups.length, 2);
    const poRows = (
      await c.query('SELECT * FROM purchase_orders WHERE tenant_id=$1 ORDER BY id', [s.tenant])
    ).rows;
    assert.equal(poRows.length, 2);
    const poIDs: string[] = [];
    for (const key of ['pln', 'eur']) {
      const group = first.groups.find((g: Json) => g.currency === key.toUpperCase());
      assert(group);
      assert.equal(group.supplier_id, s.suppliers[key].id);
      assert.deepEqual(group.product_ids, [s.products[key].id]);
      assert.equal(group.total_minor, key === 'pln' ? '1250' : '2500');
      const po = poRows.find((r) => r.id === group.purchase_order_id);
      assert(po);
      assert.equal(po.replenishment_execution_id, first.id);
      assert.equal(po.replenishment_group_index, group.index);
      assert.equal(po.warehouse_id, s.warehouse.id);
      assert.equal(po.currency, key.toUpperCase());
      assert.equal(po.state, partial && key === 'pln' ? 'partial' : 'draft');
      assert.equal(po.version, partial && key === 'pln' ? 3 : 1);
      poIDs.push(po.id);
      const lines = (
        await c.query('SELECT * FROM purchase_order_lines WHERE tenant_id=$1 AND order_id=$2', [
          s.tenant,
          po.id,
        ])
      ).rows;
      assert.equal(lines.length, 1);
      assert.deepEqual(
        [
          lines[0].product_id,
          lines[0].quantity,
          lines[0].unit_cost,
          lines[0].received_quantity,
          lines[0].closed_quantity,
        ],
        [s.products[key].id, 10, key === 'pln' ? 125 : 250, partial && key === 'pln' ? 6 : 0, 0],
      );
      const stock = (
        await c.query(
          'SELECT on_hand,reserved,available FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3',
          [s.tenant, s.warehouse.id, s.products[key].id],
        )
      ).rows[0];
      assert.deepEqual(stock, {
        on_hand: partial && key === 'pln' ? 6 : 0,
        reserved: 0,
        available: partial && key === 'pln' ? 6 : 0,
      });
    }
    const approved = (
      await c.query(
        'SELECT * FROM replenishment_rows WHERE tenant_id=$1 AND preview_id=$2 ORDER BY index',
        [s.tenant, previews[0].id],
      )
    ).rows;
    const results = (
      await c.query(
        'SELECT * FROM replenishment_execution_rows WHERE tenant_id=$1 AND execution_id=$2 ORDER BY index',
        [s.tenant, first.id],
      )
    ).rows;
    assert.equal(approved.length, 2);
    assert.equal(results.length, 2);
    for (let i = 0; i < 2; i++) {
      assert.equal(approved[i].status, 'purchase');
      assert.equal(approved[i].result.recommended_quantity, '10');
      assert.equal(results[i].preview_row_id, approved[i].id);
      for (const k of ['input', 'snapshot', 'result', 'status', 'errors', 'warnings'])
        assert.deepEqual(results[i][k], approved[i][k]);
    }
    if (partial) {
      assert.equal(executions[1].preview_id, previews[1].id);
      assert.deepEqual(executions[1].groups, []);
      assert.deepEqual(executions[1].summary, {
        total: 2,
        purchase: 0,
        unchanged: 2,
        invalid: 0,
        conflicts: 0,
      });
      const next = (
        await c.query(
          'SELECT * FROM replenishment_rows WHERE tenant_id=$1 AND preview_id=$2 ORDER BY index',
          [s.tenant, previews[1].id],
        )
      ).rows;
      assert.equal(next.length, 2);
      for (const row of next) {
        assert.equal(row.status, 'unchanged');
        assert.equal(row.result.projected_available, '10');
        assert.equal(row.result.recommended_quantity, '0');
        const isPln = row.product_id === s.products.pln.id;
        assert(isPln || row.product_id === s.products.eur.id);
        assert.equal(row.result.available, isPln ? '6' : '0');
        assert.equal(row.result.incoming_draft_quantity, isPln ? '0' : '10');
        assert.equal(row.result.incoming_ordered_quantity, isPln ? '4' : '0');
      }
    }
    const receipts = (
      await c.query('SELECT * FROM purchase_receipts WHERE tenant_id=$1', [s.tenant])
    ).rows;
    assert.equal(receipts.length, partial ? 1 : 0);
    if (partial) {
      assert.equal(
        receipts[0].order_id,
        first.groups.find((g: Json) => g.currency === 'PLN').purchase_order_id,
      );
      const receivedLines = (
        await c.query(
          'SELECT product_id,quantity FROM purchase_receipt_lines WHERE tenant_id=$1 AND receipt_id=$2',
          [s.tenant, receipts[0].id],
        )
      ).rows;
      assert.deepEqual(receivedLines, [{ product_id: s.products.pln.id, quantity: 6 }]);
      const document = (
        await c.query(
          'SELECT kind,status,warehouse_id FROM warehouse_documents WHERE tenant_id=$1 AND id=$2',
          [s.tenant, receipts[0].document_id],
        )
      ).rows[0];
      assert.deepEqual(document, {
        kind: 'receipt',
        status: 'posted',
        warehouse_id: s.warehouse.id,
      });
    }
    assert.equal(
      Number(
        (
          await c.query(
            "SELECT count(*) FROM jobs WHERE tenant_id=$1 AND (state='failed' OR error IS NOT NULL)",
            [s.tenant],
          )
        ).rows[0].count,
      ),
      0,
    );
    const checkpoint = await ownSnapshot(c, s);
    await c.query('COMMIT');
    return {
      checkpoint,
      preview_id: first.preview_id,
      execution_id: first.id,
      policy_ids: policies.map((p) => p.id),
      generated_po_ids: poIDs,
      execute_body: { client_key: first.client_key, scope_hash: first.scope_hash, confirmed: true },
      preview_ids: previews.map((p) => p.id),
      execution_ids: executions.map((p) => p.id),
    };
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}
async function publicReadback(s: Json, result: Awaited<ReturnType<typeof inspect>>) {
  for (const [kind, ids] of [
    ['previews', result.preview_ids],
    ['executions', result.execution_ids],
  ] as const)
    for (const id of ids) {
      const head = (await call(s, `/replenishment/${kind}/${id}`)).data;
      const rows = (await call(s, `/replenishment/${kind}/${id}/rows`)).data;
      assert.equal(rows.scope_hash, head[kind === 'previews' ? 'preview' : 'execution'].scope_hash);
      assert.equal(rows.data.length, 2);
      assert.equal(rows.meta.cursor, null);
    }
}
try {
  const health = (await call({}, '/health')).data;
  assert.equal(health.revision, revision);
  assert.equal(health.schema_revision, schema);
  assert.equal(health.replenishment_plans_available, true);
  assert.equal(health.restore_preview, false);
  if (phase === 'setup') {
    const suffix = randomUUID().slice(0, 8);
    const s: Json = {
      stage: 118,
      case: 'B_LOST_ACK_TWO_CURRENCIES',
      runtime_revision: revision,
      schema_revision: schema,
      original_primary_sha256: primaryHash,
      setup_complete: false,
      pending: null,
      email: `qa118b-ack-${suffix}@demo.local`,
      password: process.env.QA_NATIVE_TEST_PASSWORD ?? `DynaQa118B!${randomUUID()}`,
      products: {},
      suppliers: {},
    };
    await save(s, true);
    s.pending = 'signup';
    await save(s);
    const signup = await call(
      {},
      '/auth/signup',
      'POST',
      {
        email: s.email,
        password: s.password,
        name: 'QA118B ACK',
        organization: { name: `QA118B Dwie waluty ${suffix}`, currency: 'PLN', locale: 'pl-PL' },
      },
      201,
    );
    assert(signup.response.headers.get('set-cookie'));
    s.cookie = signup.response.headers.get('set-cookie')!.split(';')[0];
    s.tenant = signup.data.user.tenant_id;
    s.user = signup.data.user.id;
    s.pending = null;
    await save(s);
    s.warehouse = (await call(s, '/warehouses')).data.data[0];
    assert(s.warehouse?.id);
    for (const key of ['pln', 'eur']) {
      s.products[key] = await setupPost(s, '/products', {
        sku: `QA118B-${key.toUpperCase()}-${suffix}`,
        name: `QA118B Produkt ${key.toUpperCase()} ${suffix}`,
        price: 1999,
        quantity: 0,
        warehouse_id: s.warehouse.id,
      });
      await save(s);
      s.suppliers[key] = await setupPost(s, '/suppliers', {
        name: `QA118B Dostawca ${key.toUpperCase()} ${suffix}`,
        code: `QA118B-${key.toUpperCase()}-${suffix}`,
      });
      await save(s);
    }
    for (const table of [
      'replenishment_policies',
      'replenishment_previews',
      'replenishment_executions',
      'purchase_orders',
    ])
      assert.equal(
        Number(
          (await pool.query(`SELECT count(*) FROM ${table} WHERE tenant_id=$1`, [s.tenant])).rows[0]
            .count,
        ),
        0,
      );
    s.setup_complete = true;
    await save(s);
    await writeFile(
      'docs/replenishment-ack-setup-qa.json',
      JSON.stringify(
        {
          status: 'PASS_SETUP_ONLY',
          revision,
          schema_revision: schema,
          tenant: s.tenant,
          product_ids: Object.values(s.products).map((p: any) => p.id),
          supplier_ids: Object.values(s.suppliers).map((p: any) => p.id),
          policy_writes: 0,
          plan_writes: 0,
          purchase_order_writes: 0,
          expected_quantities: [10, 10],
          expected_totals: { PLN: '1250', EUR: '2500' },
          chrome_lost_ack_verified: false,
          provider_operations: false,
        },
        null,
        2,
      ),
    );
  } else {
    const stat = await lstat(path);
    assert(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0);
    const s: Json = JSON.parse(await readFile(path, 'utf8'));
    assert(s.stage === 118 && s.setup_complete && !s.pending);
    assert(
      s.runtime_revision === revision ||
        (phase === 'after-flow' && process.env.QA_VERIFY_RESTART === 'true'),
      'A changed revision requires explicit read-only restart verification',
    );
    assert.equal(s.original_primary_sha256, primaryHash);
    const me = (await call(s, '/auth/me')).data;
    assert.equal(me.user.id, s.user);
    assert.equal(me.user.tenant_id, s.tenant);
    assert.equal(me.user.role, 'admin');
    const partial = phase === 'after-flow';
    if (phase === 'before-retry') assert(!s.retry_checkpoint, 'Before-retry evidence is immutable');
    else assert(s.retry_checkpoint, 'Capture before-retry first');
    if (partial)
      assert(s.retry_verified, 'Verify the manual exact retry before later receipt writes');
    const result = await inspect(s, partial);
    if (phase === 'verify') {
      assert.deepEqual(result.checkpoint, s.retry_checkpoint);
      assert.deepEqual(result.execute_body, s.execute_body);
    }
    await publicReadback(s, result);
    assert.deepEqual((await inspect(s, partial)).checkpoint, result.checkpoint);
    if (phase === 'before-retry') {
      Object.assign(s, result);
      delete s.checkpoint;
      s.retry_checkpoint = result.checkpoint;
      s.own_names = Object.keys(result.checkpoint);
      s.own_snapshot_timezone = 'UTC';
    } else if (phase === 'verify') s.retry_verified = true;
    else {
      if (s.final_business_checkpoint)
        assert.deepEqual(result.checkpoint, s.final_business_checkpoint);
      s.final_business_checkpoint ??= result.checkpoint;
      s.after_flow_verified = true;
    }
    await save(s);
    await writeFile(
      `docs/replenishment-ack-${phase}-qa.json`,
      JSON.stringify(
        {
          status: phase === 'before-retry' ? 'PASS_BEFORE_MANUAL_RETRY' : 'PASS_READBACK',
          revision,
          schema_revision: schema,
          tenant: s.tenant,
          original_setup_revision: s.runtime_revision,
          restart_verified: phase === 'after-flow' && process.env.QA_VERIFY_RESTART === 'true',
          preview_id: result.preview_id,
          execution_id: result.execution_id,
          generated_po_ids: result.generated_po_ids,
          purchase_orders: 2,
          currencies: ['PLN', 'EUR'],
          checkpoint_tables: Object.keys(result.checkpoint).length,
          checkpoint_sha256: hash(result.checkpoint),
          original_primary_unchanged: true,
          exact_retry_no_effects: phase === 'verify',
          partial_received_quantity: partial ? 6 : null,
          next_nop_verified: partial,
          chrome_lost_ack_verified: false,
          chrome_evidence: 'Requires independent Chrome and response-drop-proxy evidence',
          excluded_mutable_tables: ['sessions', 'jobs'],
          own_failed_jobs: 0,
          provider_operations: false,
          full_goal_complete: false,
        },
        null,
        2,
      ),
    );
  }
  assert.equal(sha(await readFile(primaryPath)), primaryHash, 'Original QA118 state changed');
  console.log(
    JSON.stringify({ phase, status: 'PASS_SOURCE_PHASE_READBACK', primary_unchanged: true }),
  );
} finally {
  try {
    assert.equal(sha(await readFile(primaryPath)), primaryHash, 'Original QA118 state changed');
  } finally {
    await pool.end();
  }
}
