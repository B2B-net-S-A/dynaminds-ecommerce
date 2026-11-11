/** Root-only QA128 readback. Authoring does not execute this helper.
 * QA_EXPECTED_REVISION=<reviewed SHA> QA128_DATABASE_NAME=dynaminds
 * DYNA_WORKER_DISABLED=true QA128_CHROME_VERIFIED=true DATABASE_URL=<loopback>
 * tsx scripts/b2b-dropshipping-returns-native-readback.ts verify
 * GET + repeatable-read, read-only SQL only. No login, retry POST, migration or setup rewrite.
 * QA128_CHROME_VERIFIED is the root's human UI attestation, never inferred from SQL.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import type { Pool, PoolClient } from 'pg';

type Row = Record<string, any>;
type Actor = { tenant: string; user: string; warehouse: string; cookie: string };
type Fingerprint = { count: number; sha256: string };
type Snapshot = Record<string, Fingerprint>;
type Checkpoint = { buyer: Snapshot; supplier: Snapshot };
const setupPath = 'data/b2b-dropshipping-returns-stage128.json';
const setupReportPath = 'docs/b2b-dropshipping-returns-native-setup-qa.json';
const checkpointPath = 'data/b2b-dropshipping-returns-stage128-chrome-checkpoint.json';
const reportPath = 'docs/b2b-dropshipping-returns-native-chrome-qa.json';
const prefix = '/b2b/dropshipping-returns';
const physical = [
  'stock',
  'stock_locations',
  'stock_location_movements',
  'stock_location_operations',
  'stock_movements',
  'reservations',
  'reservation_locations',
  'order_pick_items',
  'warehouse_documents',
  'warehouse_document_lines',
  'wms_operations',
  'wms_lots',
  'wms_cost_layers',
  'wms_layer_positions',
  'wms_reservation_layers',
  'wms_layer_movements',
  'wms_issue_fragments',
  'wms_return_fragments',
  'shipments',
];
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const bytesHash = (v: Buffer) => createHash('sha256').update(v).digest('hex');
let pool: Pool | undefined;
let step = 'no_write_preflight';

async function absent(path: string) {
  try {
    await lstat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  throw new Error('Existing output refuses rerun or checkpoint rebase');
}
async function privateFile(path: string) {
  const st = await lstat(path);
  assert(st.isFile() && !st.isSymbolicLink() && (st.mode & 0o777) === 0o600);
  assert(st.size <= 32 * 1024 * 1024);
  return readFile(path);
}
async function get(actor: Actor | null, route: string): Promise<Row> {
  assert(route.startsWith('/') && !route.startsWith('//'));
  const r = await fetch('http://127.0.0.1:4100/api' + route, {
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
    headers: actor ? { cookie: actor.cookie, 'X-Workspace-ID': actor.tenant } : {},
  });
  assert.equal(r.status, 200, 'GET failed; expired cookie must be resolved by root, no login here');
  const text = await r.text();
  assert(Buffer.byteLength(text) <= 8 * 1024 * 1024);
  return JSON.parse(text) as Row;
}
async function health() {
  const h = await get(null, '/health');
  assert.equal(h.status, 'ok');
  assert.equal(h.mode, 'local');
  assert.equal(h.revision, process.env.QA_EXPECTED_REVISION);
  assert.equal(h.schema_revision, '111_b2b_dropshipping_returns');
  assert.equal(h.restore_preview, false);
  assert.equal(h.background_workers_enabled, false);
  assert.equal(h.b2b_dropshipping_returns_available, true);
  return h;
}
async function begin(c: PoolClient) {
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await c.query("SET LOCAL TIME ZONE 'UTC'");
  assert.equal((await c.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'on');
}
async function snapshot(c: PoolClient, s: Row): Promise<Checkpoint> {
  const names: string[] = (
    await c.query(`SELECT t.table_name FROM information_schema.tables t
    JOIN information_schema.columns k USING(table_schema,table_name)
    WHERE t.table_schema='public' AND t.table_type='BASE TABLE' AND k.column_name='tenant_id'
    AND t.table_name<>'sessions' UNION SELECT 'users' UNION SELECT 'tenants' ORDER BY 1`)
  ).rows.map((r) => r.table_name);
  const out: Checkpoint = { buyer: {}, supplier: {} };
  for (const side of ['buyer', 'supplier'] as const)
    for (const name of names) {
      assert.match(name, /^[a-z_][a-z0-9_]*$/);
      const key = name === 'users' || name === 'tenants' ? 'id' : 'tenant_id';
      const rows = (
        await c.query(`SELECT to_jsonb(t) row FROM "${name}" t WHERE ${key}=$1 ORDER BY 1`, [
          name === 'users' ? s[side].user : s[side].tenant,
        ])
      ).rows;
      out[side][name] = { count: rows.length, sha256: hash(rows) };
    }
  return out;
}
function exactSubset(current: Snapshot, original: Snapshot, names: string[]) {
  for (const name of names) {
    assert(current[name] && original[name], 'Required fingerprint missing');
    assert.deepEqual(current[name], original[name], 'Required original records changed');
  }
}
async function pages(actor: Actor, path: string): Promise<Row[]> {
  let cursor: string | null = null;
  const all: Row[] = [],
    seen = new Set<string>();
  let total: number | undefined;
  do {
    const r = await get(
      actor,
      path +
        (path.includes('?') ? '&' : '?') +
        'limit=100' +
        (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
    );
    assert.equal(r.current_role, 'admin');
    assert.equal(r.read_only, false);
    assert(Array.isArray(r.data) && r.data.length <= 100);
    assert(Number.isSafeInteger(r.meta.total) && r.meta.total >= 0 && r.meta.total <= 10000);
    if (total === undefined) total = r.meta.total;
    else assert.equal(r.meta.total, total);
    all.push(...r.data);
    assert(all.length <= total!);
    cursor = r.meta.cursor;
    assert(cursor === null || typeof cursor === 'string');
    if (cursor) {
      assert(!seen.has(cursor));
      seen.add(cursor);
    }
  } while (cursor);
  assert.equal(all.length, total);
  return all;
}

async function verify(s: Row, db: URL) {
  assert(pool);
  const buyer = s.buyer as Actor,
    supplier = s.supplier as Actor;
  for (const actor of [buyer, supplier]) {
    for (const field of ['tenant', 'user', 'warehouse'] as const)
      assert.match(actor[field], /^[a-f0-9-]{36}$/);
    assert(typeof actor.cookie === 'string' && actor.cookie.length > 0);
    const me = (await get(actor, '/auth/me')).user;
    assert.equal(me.id, actor.user);
    assert.equal(me.tenant_id, actor.tenant);
    assert.equal(me.role, 'admin');
  }
  const c = await pool.connect();
  let captured: Checkpoint;
  let evidence: Row;
  try {
    await begin(c);
    const info = (
      await c.query(`SELECT current_database() name,host(inet_server_addr()) host,
      inet_server_port() port,(SELECT name FROM migrations ORDER BY name DESC LIMIT 1) schema_revision`)
    ).rows[0];
    assert.equal(info.name, 'dynaminds');
    assert(['127.0.0.1', '::1'].includes(info.host));
    assert.equal(info.port, Number(db.port || 5432));
    assert.equal(info.schema_revision, '111_b2b_dropshipping_returns');
    for (const [side, actor] of [
      ['buyer', buyer],
      ['supplier', supplier],
    ] as const) {
      const rows = (
        await c.query(
          `SELECT m.role,t.name FROM memberships m JOIN tenants t
        ON t.id=m.tenant_id WHERE m.tenant_id=$1 AND m.user_id=$2`,
          [actor.tenant, actor.user],
        )
      ).rows;
      assert.deepEqual(rows, [{ role: 'admin', name: 'QA128 direct customer returns ' + side }]);
    }
    const returns = [] as Row[];
    for (const [actor, order, suffix] of [
      [buyer, s.customer_order, 'D560D74B'],
      [supplier, s.supplier_order, 'FB982E32'],
    ] as const) {
      const rows = (
        await c.query(
          `SELECT * FROM return_cases WHERE tenant_id=$1 AND order_id=$2
        AND number LIKE $3 ORDER BY id`,
          [actor.tenant, order, '%' + suffix],
        )
      ).rows;
      assert.equal(rows.length, 1);
      returns.push(rows[0]);
    }
    const [retail, wholesale] = returns;
    for (const [r, amount] of [
      [retail, 1000],
      [wholesale, 700],
    ] as const) {
      assert.equal(r.state, 'refund_pending');
      assert.equal(r.refund_amount, amount);
      assert.equal(r.refunded_shipping, 0);
      assert.equal(r.settlement, null);
      assert.equal(r.refunded_at, null);
    }
    assert.equal(retail.received_at, null);
    assert.equal(retail.receipt, null);
    assert(wholesale.received_at && wholesale.receipt);
    const bridge = (
      await c.query(
        `SELECT * FROM b2b_dropship_return_cases
      WHERE tenant_id=$1 AND return_id=$2 AND supplier_tenant_id=$3 AND supplier_return_id=$4`,
        [buyer.tenant, retail.id, supplier.tenant, wholesale.id],
      )
    ).rows;
    assert.equal(bridge.length, 1);
    const h = bridge[0];
    assert.equal(h.order_id, s.customer_order);
    assert.equal(h.supplier_order_id, s.supplier_order);
    assert.equal(h.dropship_order_id, s.forwarding);
    assert.equal(h.link_id, s.link);
    const supplierProjection = (
      await c.query(
        `SELECT * FROM b2b_dropship_return_supplier_cases
      WHERE tenant_id=$1 AND return_id=$2`,
        [supplier.tenant, wholesale.id],
      )
    ).rows;
    assert.equal(supplierProjection.length, 1);
    assert.equal(supplierProjection[0].case_id, h.id);
    assert.deepEqual(supplierProjection[0].snapshot, h.snapshot);
    const lines = (
      await c.query(
        `SELECT * FROM b2b_dropship_return_lines WHERE tenant_id=$1
      AND case_id=$2 ORDER BY index`,
        [buyer.tenant, h.id],
      )
    ).rows;
    assert.equal(lines.length, 1);
    const line = lines[0];
    assert.equal(line.customer_item_id, s.cheap_customer_item);
    assert.equal(line.quantity, 1);
    assert.equal(line.row.retail_refund_minor, '1000');
    assert.equal(line.row.wholesale_refund_minor, '700');
    assert.equal(line.row.physical_sources.length, 1);
    const part = line.row.physical_sources[0];
    assert.equal(part.shipment_id, s.supplier_shipment);
    assert.equal(part.quantity, 1);
    assert.equal(part.product_id, s.supplier_product);
    for (const [r, actor, item, restocked, amount] of [
      [retail, buyer, s.cheap_customer_item, 0, 1000],
      [wholesale, supplier, part.supplier_item_id, 1, 700],
    ] as const) {
      const items = (
        await c.query(
          `SELECT item_id,requested,accepted,restocked,refund_amount
        FROM return_items WHERE tenant_id=$1 AND return_id=$2 ORDER BY item_id`,
          [actor.tenant, r.id],
        )
      ).rows;
      assert.deepEqual(items, [
        { item_id: item, requested: 1, accepted: 1, restocked, refund_amount: amount },
      ]);
    }
    const actions = (
      await c.query(
        `SELECT * FROM b2b_dropship_return_actions
      WHERE tenant_id=ANY($1::uuid[]) ORDER BY kind,id`,
        [[buyer.tenant, supplier.tenant]],
      )
    ).rows;
    assert.equal(actions.length, 4);
    const actionOf = (kind: string, actor: Actor) => {
      const a = actions.filter((a) => a.kind === kind);
      assert.equal(a.length, 1);
      assert.equal(a[0].tenant_id, actor.tenant);
      assert.equal(a[0].actor_id, actor.user);
      return a[0];
    };
    const settings = actionOf('settings', supplier),
      submit = actionOf('submit', buyer),
      receive = actionOf('receive', supplier),
      reconcile = actionOf('reconcile', buyer);
    assert.deepEqual(settings.request, s.requests.supplier_return_optin.body);
    assert.equal(submit.preview_id, h.preview_id);
    assert.deepEqual(submit.result.case_ids, [h.id]);
    assert.equal(receive.case_id, h.id);
    assert.equal(receive.return_id, retail.id);
    assert.equal(receive.request.items.length, 1);
    assert.deepEqual(receive.request.items[0], {
      supplier_item_id: part.supplier_item_id,
      accepted: 1,
      restocked: 1,
    });
    assert.equal(reconcile.return_id, retail.id);
    assert.deepEqual(reconcile.result.case_ids, [h.id]);
    assert.deepEqual(reconcile.request.items, [
      { customer_item_id: s.cheap_customer_item, accepted: 1 },
    ]);
    const allProofs = (
      await c.query(
        `SELECT id FROM b2b_dropship_return_proofs
      WHERE tenant_id=ANY($1::uuid[]) ORDER BY id`,
        [[buyer.tenant, supplier.tenant]],
      )
    ).rows;
    assert.equal(allProofs.length, 2);
    for (const [action, tenant, rid] of [
      [receive, supplier.tenant, wholesale.id],
      [reconcile, buyer.tenant, retail.id],
    ] as const) {
      const proofs = (
        await c.query(
          `SELECT * FROM b2b_dropship_return_proofs
        WHERE actor_tenant_id=$1 AND action_id=$2`,
          [action.tenant_id, action.id],
        )
      ).rows;
      assert.equal(proofs.length, 1);
      const proof = proofs[0];
      assert.equal(proof.tenant_id, tenant);
      assert.equal(proof.return_id, rid);
      assert.equal(proof.actor_id, action.actor_id);
      assert.equal(proof.kind, action.kind);
      assert.equal(proof.applied, true);
      assert.deepEqual(proof.request, action.request);
      assert(proof.before_snapshot && proof.after_snapshot);
      assert.equal(proof.before_snapshot.head.id, rid);
      assert.equal(proof.after_snapshot.head.id, rid);
      assert.equal(proof.after_snapshot.head.refund_amount, action.kind === 'receive' ? 700 : 1000);
    }
    // Creation witnesses prove same-transaction bind and are deleted by the
    // deferred cleanup trigger at commit. Durable receipt/acceptance proofs above remain.
    for (const actor of [buyer, supplier]) {
      const witnesses = (
        await c.query(
          `SELECT return_id FROM b2b_dropship_return_created_cases
        WHERE tenant_id=$1 ORDER BY return_id`,
          [actor.tenant],
        )
      ).rows;
      assert.equal(witnesses.length, 0, 'Transaction-only creation witness leaked after commit');
    }
    const movement = (
      await c.query(
        `SELECT product_id,warehouse_id,order_id,delta,kind,return_id
      FROM stock_movements WHERE tenant_id=$1 AND return_id=$2 ORDER BY id`,
        [supplier.tenant, wholesale.id],
      )
    ).rows;
    assert.deepEqual(movement, [
      {
        product_id: s.supplier_product,
        warehouse_id: supplier.warehouse,
        order_id: s.supplier_order,
        delta: 1,
        kind: 'return',
        return_id: wholesale.id,
      },
    ]);
    for (const [actor, product, qty] of [
      [buyer, s.buyer_product, 0],
      [supplier, s.supplier_product, 18],
    ] as const) {
      const stock = (
        await c.query(
          `SELECT on_hand,reserved,available FROM stock
        WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3`,
          [actor.tenant, actor.warehouse, product],
        )
      ).rows;
      assert.deepEqual(stock, [{ on_hand: qty, reserved: 0, available: qty }]);
    }
    captured = await snapshot(c, s);
    for (const side of ['buyer', 'supplier'] as const) {
      exactSubset(captured[side], s.setup_checkpoint[side], [
        'payment_entries',
        'shipments',
        'order_items',
        'order_pick_items',
        'reservations',
        'reservation_locations',
      ]);
    }
    exactSubset(
      captured.supplier,
      s.setup_checkpoint.supplier,
      physical.filter(
        (name) =>
          !['stock', 'stock_locations', 'stock_location_movements', 'stock_movements'].includes(
            name,
          ),
      ),
    );
    exactSubset(captured.buyer, s.buyer_physical_born, physical);
    exactSubset(captured.buyer, s.setup_checkpoint.buyer, physical);
    evidence = {
      buyer_return_id: retail.id,
      supplier_return_id: wholesale.id,
      case_id: h.id,
      preview_id: h.preview_id,
      actions: actions.map((a) => ({
        id: a.id,
        kind: a.kind,
        tenant_id: a.tenant_id,
        actor_id: a.actor_id,
      })),
      row: line.row,
    };
    await c.query('COMMIT');
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
  step = 'api_readback';
  const retail = await get(buyer, '/returns/' + evidence.buyer_return_id);
  const wholesale = await get(supplier, '/returns/' + evidence.supplier_return_id);
  assert.equal(retail.acceptance_kind, 'partner');
  assert(retail.accepted_at);
  assert.equal(retail.received_at, null);
  assert.equal(retail.physical_received_at, null);
  assert.equal(retail.partner_acceptance.kind, 'partner');
  assert.deepEqual(retail.partner_acceptance.case_ids, [evidence.case_id]);
  assert.equal(wholesale.acceptance_kind, 'physical');
  assert(wholesale.physical_received_at);
  const contexts: Row[] = [];
  for (const [actor, rid] of [
    [buyer, evidence.buyer_return_id],
    [supplier, evidence.supplier_return_id],
  ] as const) {
    const r = await get(actor, prefix + '/returns/' + rid + '/context');
    assert.equal(r.current_role, 'admin');
    assert.equal(r.read_only, false);
    assert.equal(r.context.can_receive_locally, false);
    contexts.push(r.context);
    const head = (await get(actor, prefix + '/cases/' + evidence.case_id)).case;
    assert.equal(head.state, 'received');
    assert.equal(head.wholesale_refund_minor, '700');
    assert(head.received_at && head.retail_reconciled_at);
    const rows = await pages(actor, prefix + '/cases/' + evidence.case_id + '/rows');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].retail_refund_minor, '1000');
    assert.equal(rows[0].wholesale_refund_minor, '700');
    const events = await pages(actor, prefix + '/cases/' + evidence.case_id + '/events');
    assert.deepEqual(events.map((e) => e.kind).sort(), ['receive', 'reconcile', 'submit']);
  }
  assert.equal(contexts[0].can_reconcile, false);
  assert.deepEqual(
    contexts[0].case_refs.map((r: Row) => r.id),
    [evidence.case_id],
  );
  for (const [actor, oid, received, credit, nominal] of [
    [buyer, s.customer_order, 4200, 1000, 3200],
    [supplier, s.supplier_order, 2100, 700, 1400],
  ] as const) {
    const b = (await get(actor, '/orders/' + oid + '/payments')).balance;
    for (const [key, expected] of Object.entries({
      received,
      refunded: 0,
      credit,
      nominal,
      net: received,
      amount_due: 0,
      overpayment: credit,
    }))
      assert.equal(b[key], expected);
  }
  await health();
  const end = await pool.connect();
  try {
    await begin(end);
    assert.deepEqual(
      await snapshot(end, s),
      captured,
      'Own business state changed during read-only verification',
    );
    await end.query('COMMIT');
  } finally {
    await end.query('ROLLBACK').catch(() => {});
    end.release();
  }
  return { captured, evidence };
}

try {
  assert.equal(process.argv[2], 'verify');
  assert.equal(process.env.DYNA_WORKER_DISABLED, 'true');
  assert.equal(process.env.QA128_CHROME_VERIFIED, 'true', 'Root human Chrome attestation required');
  assert.notEqual(process.env.DYNA_TEST, 'true');
  assert.match(process.env.QA_EXPECTED_REVISION ?? '', /^[a-f0-9]{7,40}$/);
  const db = new URL(process.env.DATABASE_URL ?? '');
  assert(['localhost', '127.0.0.1', '[::1]'].includes(db.hostname));
  assert(['postgres:', 'postgresql:'].includes(db.protocol));
  assert.equal(db.search, '');
  assert.equal(db.pathname, '/dynaminds');
  assert.equal(process.env.QA128_DATABASE_NAME, 'dynaminds');
  const config = await lstat(process.env.DYNA_LOCAL_CONFIG_PATH ?? '.local.json');
  assert(config.isFile() && !config.isSymbolicLink() && !(config.mode & 0o077));
  await absent(checkpointPath);
  await absent(reportPath);
  const setupBytes = await privateFile(setupPath),
    setupReportBytes = await readFile(setupReportPath);
  const s: Row = JSON.parse(setupBytes.toString('utf8'));
  const setupReport: Row = JSON.parse(setupReportBytes.toString('utf8'));
  assert.equal(s.stage128, true);
  assert.equal(s.setup_complete, true);
  assert.equal(s.pending, null);
  assert.equal(s.schema_revision, '111_b2b_dropshipping_returns');
  assert.equal(s.runtime_revision, process.env.QA_EXPECTED_REVISION);
  assert.equal(setupReport.status, 'PASS');
  assert.equal(setupReport.revision, s.runtime_revision);
  assert.equal(setupReport.schema_revision, s.schema_revision);
  assert.equal(setupReport.setup_checkpoint_sha256, hash(s.setup_checkpoint));
  await health();
  pool = (await import('../server/db')).pool;
  step = 'sql_readback';
  const { captured, evidence } = await verify(s, db);
  assert.deepEqual(await privateFile(setupPath), setupBytes, 'Immutable setup file changed');
  assert.deepEqual(await readFile(setupReportPath), setupReportBytes, 'Setup report changed');
  const unchangedSetup = {
    bytes: setupBytes.length,
    sha256: bytesHash(setupBytes),
    report_sha256: bytesHash(setupReportBytes),
    checkpoint_sha256: hash(s.setup_checkpoint),
  };
  const result = {
    stage: 128,
    phase: 'native_chrome_readback',
    status: 'PASS',
    revision: process.env.QA_EXPECTED_REVISION,
    schema_revision: s.schema_revision,
    background_workers_enabled: false,
    setup_bytes_unchanged: true,
    setup: unchangedSetup,
    own_tables: {
      buyer: Object.keys(captured.buyer).length,
      supplier: Object.keys(captured.supplier).length,
    },
    checkpoint_sha256: hash(captured),
    buyer_physical_tables: physical.length,
    buyer_physical_exact: true,
    cash_entries_exact_both_firms: true,
    supplier_shipments_and_picks_exact: true,
    buyer_stock: 0,
    supplier_stock: 18,
    retail_credit_minor: 1000,
    wholesale_credit_minor: 700,
    retail_acceptance_kind: 'partner',
    buyer_physical_received: false,
    supplier_received_quantity: 1,
    supplier_restocked_quantity: 1,
    human_chrome_attestation: {
      confirmed: true,
      source: 'Root actual Chrome actions; explicit QA128_CHROME_VERIFIED=true',
      independently_inferred_from_sql: false,
    },
    lost_ack_verified: false,
    restart_verified: false,
    restore_verified: false,
    live_provider_verified: false,
    bank_payment_verified: false,
    full_goal_complete: false,
  };
  step = 'save_separate_checkpoint';
  await writeFile(
    checkpointPath,
    JSON.stringify(
      {
        stage128: true,
        captured_at: new Date().toISOString(),
        runtime_revision: result.revision,
        schema_revision: s.schema_revision,
        setup: unchangedSetup,
        buyer: { tenant: s.buyer.tenant, user: s.buyer.user },
        supplier: { tenant: s.supplier.tenant, user: s.supplier.user },
        checkpoint: captured,
        evidence,
        chrome_human_attested: true,
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  await writeFile(reportPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write('QA128 Chrome readback PASS (no database writes)\n');
} catch (error) {
  const failure = error as Error & { code?: string };
  const location = failure.stack?.match(
    /b2b-dropshipping-returns-native-readback\.ts:(\d+):\d+/,
  )?.[1];
  process.stderr.write(
    JSON.stringify({
      stage: 128,
      phase: 'native_chrome_readback',
      status: 'FAIL',
      step,
      code: failure.code,
      source_line: location ? Number(location) : null,
      setup_rewritten: false,
      automatic_retry: false,
    }) + '\n',
  );
  process.exitCode = 1;
} finally {
  await pool?.end();
}
