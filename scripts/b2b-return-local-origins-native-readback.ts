/** Root-only QA129 Chrome readback; authoring never executes it.
 * QA_EXPECTED_REVISION=<reviewed SHA> QA129_DATABASE_NAME=dynaminds
 * DYNA_WORKER_DISABLED=true QA129_CHROME_VERIFIED=true DATABASE_URL=<loopback>
 * tsx scripts/b2b-return-local-origins-native-readback.ts verify
 * GET and UTC REPEATABLE READ READ ONLY only. No login, POST, fixture rewrite,
 * migration, provider call or inferred Chrome/restart/restore attestation.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import type { Pool, PoolClient } from 'pg';

type Row = Record<string, any>;
type Actor = { tenant: string; user: string; warehouse: string; cookie: string };
type Snapshot = Record<string, { count: number; sha256: string }>;
type Checkpoint = { buyer: Snapshot; supplier: Snapshot };
const setupPath = 'data/b2b-return-local-origins-stage129.json';
const setupReportPath = 'docs/b2b-return-local-origins-native-setup-qa.json';
const checkpointPath = 'data/b2b-return-local-origins-stage129-chrome-checkpoint.json';
const reportPath = 'docs/b2b-return-local-origins-native-chrome-qa.json';
const schema = '112_b2b_return_local_origins';
const prefix = '/b2b/dropshipping-returns';
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const bytesHash = (v: Buffer) => createHash('sha256').update(v).digest('hex');
let pool: Pool | undefined;
let step = 'preflight';

async function absent(path: string) {
  try {
    await lstat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  throw new Error('Existing output refuses checkpoint rebase');
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
  assert.equal(r.status, 200, 'GET failed; root must resolve cookie expiry, no login here');
  const text = await r.text();
  assert(Buffer.byteLength(text) <= 8 * 1024 * 1024);
  return JSON.parse(text) as Row;
}
async function health() {
  const h = await get(null, '/health');
  assert.equal(h.status, 'ok');
  assert.equal(h.mode, 'local');
  assert.equal(h.revision, process.env.QA_EXPECTED_REVISION);
  assert.equal(h.schema_revision, schema);
  assert.equal(h.restore_preview, false);
  assert.equal(h.background_workers_enabled, false);
  assert.equal(h.b2b_local_return_origins_available, true);
  assert.equal(h.b2b_dropshipping_returns_available, true);
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
      const key = ['users', 'tenants'].includes(name) ? 'id' : 'tenant_id';
      const rows = (
        await c.query(`SELECT to_jsonb(t) row FROM "${name}" t WHERE ${key}=$1 ORDER BY 1`, [
          name === 'users' ? s[side].user : s[side].tenant,
        ])
      ).rows;
      out[side][name] = { count: rows.length, sha256: hash(rows) };
    }
  return out;
}
async function rows(
  c: PoolClient,
  table: string,
  tenant: string,
  extra = '',
  args: unknown[] = [],
): Promise<Row[]> {
  assert.match(table, /^[a-z_][a-z0-9_]*$/);
  return (
    await c.query(
      `SELECT to_jsonb(t) row FROM "${table}" t WHERE tenant_id=$1 ${extra} ORDER BY 1`,
      [tenant, ...args],
    )
  ).rows.map((r) => r.row);
}
function one(values: Row[]): Row {
  assert.equal(values.length, 1);
  return values[0];
}
function unchanged(current: Snapshot, original: Snapshot, names: string[]) {
  for (const name of names) {
    assert(current[name] && original[name]);
    assert.deepEqual(current[name], original[name]);
  }
}
async function pages(actor: Actor, path: string): Promise<Row[]> {
  const all: Row[] = [],
    seen = new Set<string>();
  let cursor: string | null = null,
    total: number | undefined;
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
function strip(v: Row, keys: string[]): Row {
  return Object.fromEntries(Object.entries(v).filter(([k]) => !keys.includes(k)));
}

async function verify(s: Row, db: URL) {
  assert(pool);
  const buyer = s.buyer as Actor,
    supplier = s.supplier as Actor;
  for (const a of [buyer, supplier]) {
    for (const key of ['tenant', 'user', 'warehouse'] as const)
      assert.match(a[key], /^[a-f0-9-]{36}$/);
    assert(typeof a.cookie === 'string' && a.cookie.length > 0);
    const me = (await get(a, '/auth/me')).user;
    assert.equal(me.id, a.user);
    assert.equal(me.tenant_id, a.tenant);
    assert.equal(me.role, 'admin');
  }
  const c = await pool.connect();
  let captured: Checkpoint, evidence: Row;
  try {
    await begin(c);
    const info = (
      await c.query(`SELECT current_database() name,host(inet_server_addr()) host,
      inet_server_port() port,(SELECT name FROM migrations ORDER BY name DESC LIMIT 1) schema_revision`)
    ).rows[0];
    assert.equal(info.name, 'dynaminds');
    assert(['127.0.0.1', '::1'].includes(info.host));
    assert.equal(info.port, Number(db.port || 5432));
    assert.equal(info.schema_revision, schema);
    for (const [side, a] of [
      ['buyer', buyer],
      ['supplier', supplier],
    ] as const) {
      assert.deepEqual(
        (
          await c.query(
            `SELECT m.role,t.name FROM memberships m JOIN tenants t ON t.id=m.tenant_id
        WHERE m.tenant_id=$1 AND m.user_id=$2`,
            [a.tenant, a.user],
          )
        ).rows,
        [{ role: 'admin', name: 'QA129 mixed local origin returns ' + side }],
      );
      assert.equal(
        (
          await c.query(
            'SELECT EXISTS(SELECT 1 FROM wms_policies WHERE tenant_id=$1 AND enabled) enabled',
            [a.tenant],
          )
        ).rows[0].enabled,
        false,
      );
    }
    const origin = one(await rows(c, 'b2b_return_local_origins', buyer.tenant));
    assert.equal(origin.order_id, s.customer_order);
    assert.equal(origin.actor_id, buyer.user);
    assert.equal(origin.api_key_id, null);
    assert.deepEqual(origin.request.items, [
      { customer_item_id: s.customer_item, shipment_id: s.local_shipment, quantity: 1 },
    ]);
    assert.equal(origin.scope_hash, origin.request.scope_hash);
    const local = one(await rows(c, 'return_cases', buyer.tenant, 'AND id=$2', [origin.return_id]));
    const bridge = one(await rows(c, 'b2b_dropship_return_cases', buyer.tenant));
    assert.equal(bridge.order_id, s.customer_order);
    assert.equal(bridge.supplier_tenant_id, supplier.tenant);
    assert.equal(bridge.supplier_order_id, s.supplier_order);
    assert.equal(bridge.dropship_order_id, s.forwarding.id);
    assert.equal(bridge.link_id, s.link);
    assert.notEqual(bridge.return_id, local.id);
    const retail = one(
      await rows(c, 'return_cases', buyer.tenant, 'AND id=$2', [bridge.return_id]),
    );
    const wholesale = one(
      await rows(c, 'return_cases', supplier.tenant, 'AND id=$2', [bridge.supplier_return_id]),
    );
    assert.deepEqual(
      (await rows(c, 'return_cases', buyer.tenant)).map((r) => r.id).sort(),
      [local.id, retail.id].sort(),
    );
    assert.deepEqual(
      (await rows(c, 'return_cases', supplier.tenant)).map((r) => r.id),
      [wholesale.id],
    );
    const counterpart = one(await rows(c, 'b2b_dropship_return_supplier_cases', supplier.tenant));
    assert.equal(counterpart.case_id, bridge.id);
    assert.equal(counterpart.return_id, wholesale.id);
    assert.deepEqual(counterpart.snapshot, bridge.snapshot);
    const line = one(await rows(c, 'b2b_dropship_return_lines', buyer.tenant));
    assert.equal(line.case_id, bridge.id);
    assert.equal(line.customer_item_id, s.customer_item);
    assert.equal(line.quantity, 1);
    assert.equal(line.row.retail_refund_minor, '2500');
    assert.equal(line.row.wholesale_refund_minor, '700');
    const part = one(line.row.physical_sources);
    assert.equal(part.shipment_id, s.supplier_shipment);
    assert.equal(part.product_id, s.supplier_product);
    assert.equal(part.quantity, 1);
    for (const [r, a, oid, item, restocked, amount] of [
      [local, buyer, s.customer_order, s.customer_item, 1, 2500],
      [retail, buyer, s.customer_order, s.customer_item, 0, 2500],
      [wholesale, supplier, s.supplier_order, part.supplier_item_id, 1, 700],
    ] as const) {
      assert.equal(r.order_id, oid);
      assert.equal(r.state, 'refund_pending');
      assert.equal(r.legacy, false);
      assert.equal(r.refund_amount, amount);
      assert.equal(r.refunded_shipping, 0);
      assert.equal(r.settlement, null);
      assert.equal(r.refunded_at, null);
      assert.equal(r.received_at === null, r.id === retail.id);
      assert.equal(r.receipt === null, r.id === retail.id);
      assert.deepEqual(
        (await rows(c, 'return_items', a.tenant, 'AND return_id=$2', [r.id])).map((i) => ({
          item_id: i.item_id,
          requested: i.requested,
          accepted: i.accepted,
          restocked: i.restocked,
          refund_amount: i.refund_amount,
        })),
        [{ item_id: item, requested: 1, accepted: 1, restocked, refund_amount: amount }],
      );
      const movements = await rows(c, 'stock_movements', a.tenant, 'AND return_id=$2', [r.id]);
      assert.deepEqual(
        movements.map((m) => ({
          product_id: m.product_id,
          warehouse_id: m.warehouse_id,
          order_id: m.order_id,
          delta: m.delta,
          kind: m.kind,
          return_id: m.return_id,
        })),
        r.id === retail.id
          ? []
          : [
              {
                product_id: a === buyer ? s.buyer_product : s.supplier_product,
                warehouse_id: a.warehouse,
                order_id: oid,
                delta: 1,
                kind: 'return',
                return_id: r.id,
              },
            ],
      );
    }
    const localProof = one(await rows(c, 'b2b_return_local_proofs', buyer.tenant));
    assert.equal(localProof.origin_id, origin.id);
    assert.equal(localProof.return_id, local.id);
    assert.equal(localProof.actor_id, buyer.user);
    assert.equal(localProof.api_key_id, null);
    assert.equal(localProof.applied, true);
    assert.deepEqual(localProof.request, local.receipt);
    assert.equal(localProof.request.origin_id, origin.id);
    assert.equal(localProof.before_snapshot.head.id, local.id);
    assert.equal(localProof.before_snapshot.head.received_at, null);
    assert.equal(localProof.before_snapshot.stock[0].on_hand, 4);
    assert.equal(localProof.after_snapshot.stock[0].on_hand, 5);
    assert.equal(
      localProof.after_snapshot.bins.reduce((n: number, b: Row) => n + b.quantity, 0),
      5,
    );
    assert.deepEqual(localProof.after_snapshot.positions, localProof.before_snapshot.positions);
    for (const name of ['fragments', 'operations', 'layer_movements'])
      assert.deepEqual(localProof.after_snapshot[name], []);
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [buyer.tenant]);
    assert.deepEqual(
      (await c.query('SELECT b2b_return_local_snapshot($1) value', [local.id])).rows[0].value,
      localProof.after_snapshot,
    );
    const actions = [
      ...(await rows(c, 'b2b_dropship_return_actions', buyer.tenant)),
      ...(await rows(c, 'b2b_dropship_return_actions', supplier.tenant)),
    ];
    assert.equal(actions.length, 4);
    const actionOf = (kind: string, a: Actor) => {
      const action = one(actions.filter((r) => r.kind === kind));
      assert.equal(action.tenant_id, a.tenant);
      assert.equal(action.actor_id, a.user);
      assert.equal(action.api_key_id, null);
      return action;
    };
    const settings = actionOf('settings', supplier),
      submit = actionOf('submit', buyer),
      receive = actionOf('receive', supplier),
      reconcile = actionOf('reconcile', buyer);
    assert.deepEqual(settings.request, s.requests.supplier_return_optin.body);
    assert.equal(submit.preview_id, bridge.preview_id);
    assert.deepEqual(submit.result.case_ids, [bridge.id]);
    assert.equal(receive.case_id, bridge.id);
    assert.equal(receive.return_id, retail.id);
    assert.deepEqual(receive.request.items, [
      { supplier_item_id: part.supplier_item_id, accepted: 1, restocked: 1 },
    ]);
    assert.equal(reconcile.return_id, retail.id);
    assert.deepEqual(reconcile.result.case_ids, [bridge.id]);
    assert.deepEqual(reconcile.request.items, [{ customer_item_id: s.customer_item, accepted: 1 }]);
    const proofs = [
      ...(await rows(c, 'b2b_dropship_return_proofs', buyer.tenant)),
      ...(await rows(c, 'b2b_dropship_return_proofs', supplier.tenant)),
    ];
    assert.equal(proofs.length, 2);
    for (const [action, a, r] of [
      [receive, supplier, wholesale],
      [reconcile, buyer, retail],
    ] as const) {
      const proof = one(
        proofs.filter((p) => p.action_id === action.id && p.actor_tenant_id === action.tenant_id),
      );
      assert.equal(proof.tenant_id, a.tenant);
      assert.equal(proof.return_id, r.id);
      assert.equal(proof.actor_id, a.user);
      assert.equal(proof.kind, action.kind);
      assert.equal(proof.applied, true);
      assert.deepEqual(proof.request, action.request);
      assert.equal(proof.before_snapshot.head.id, r.id);
      assert.equal(proof.after_snapshot.head.refund_amount, r.refund_amount);
      if (action.kind === 'receive') {
        assert.equal(proof.before_snapshot.stock[0].on_hand, 18);
        const currentBins = await rows(
          c,
          'stock_locations',
          a.tenant,
          'AND warehouse_id=$2 AND product_id=$3',
          [a.warehouse, s.supplier_product],
        );
        assert.equal(
          currentBins.reduce((n, b) => n + b.quantity, 0),
          19,
        );
        assert.equal(
          proof.before_snapshot.bins.reduce((n: number, b: Row) => n + b.quantity, 0),
          18,
        );
      } else {
        assert.equal(proof.before_snapshot.stock[0].on_hand, 5);
        assert.deepEqual(proof.after_snapshot.stock, proof.before_snapshot.stock);
      }
      await c.query("SELECT set_config('app.tenant_id',$1,true)", [a.tenant]);
      assert.deepEqual(
        (await c.query('SELECT b2b_dropship_return_snapshot($1) value', [r.id])).rows[0].value,
        strip(proof.after_snapshot, ['stock']),
      );
    }
    const appendedJobs: Row[] = [];
    const automationChains = new Set<string>();
    for (const [side, a, product, qty] of [
      ['buyer', buyer, s.buyer_product, 5],
      ['supplier', supplier, s.supplier_product, 19],
    ] as const) {
      assert.deepEqual(
        (
          await c.query(
            'SELECT on_hand,reserved,available FROM stock WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3',
            [a.tenant, a.warehouse, product],
          )
        ).rows,
        [{ on_hand: qty, reserved: 0, available: qty }],
      );
      assert.equal((await rows(c, 'b2b_dropship_return_created_cases', a.tenant)).length, 0);
      const nowMoves = await rows(c, 'stock_movements', a.tenant);
      const oldMoves: Row[] = s.native_journals[side + '_movements'].map((r: Row) => r.row);
      // Born journal JSON was read on the setup connection; its timestamp text
      // may use that connection's timezone. Compare the immutable UTC baseline
      // full-row fingerprint, retaining exact timestamps including microseconds.
      const retained = (
        await c.query(
          'SELECT to_jsonb(t) row FROM stock_movements t WHERE tenant_id=$1 AND id=ANY($2::uuid[]) ORDER BY 1',
          [a.tenant, oldMoves.map((m) => m.id)],
        )
      ).rows;
      assert.deepEqual(
        { count: retained.length, sha256: hash(retained) },
        s.setup_checkpoint[side].stock_movements,
      );
      assert.equal(nowMoves.length, oldMoves.length + 1);
      assert.equal(
        nowMoves.filter((m) => !oldMoves.some((old) => old.id === m.id))[0].return_id,
        side === 'buyer' ? local.id : wholesale.id,
      );
      const dispatch = one(
        await rows(c, 'shopify_dispatch_evidence', a.tenant, 'AND shipment_id=$2', [
          s[side === 'buyer' ? 'local_shipment' : 'supplier_shipment'],
        ]),
      );
      assert.equal(
        dispatch.id,
        s.source_born[side === 'buyer' ? 'local_dispatch_evidence' : 'supplier_dispatch_evidence']
          .id,
      );
      assert.equal(dispatch.order_id, s[side === 'buyer' ? 'customer_order' : 'supplier_order']);
      assert.equal(dispatch.items.length, 1);
      assert.equal(dispatch.items[0].quantity, side === 'buyer' ? 1 : 2);
      // SQL driver dates/bigints serialize exactly as the original HTTP order.
      // Only the revision timestamp/counter are caused by genuine RMA events.
      const header = one(
        (
          await c.query('SELECT * FROM orders WHERE tenant_id=$1 AND id=$2', [
            a.tenant,
            s[side === 'buyer' ? 'customer_order' : 'supplier_order'],
          ])
        ).rows,
      );
      const original = s.source_born[side + '_order'];
      for (const [key, value] of Object.entries(header))
        if (!['version', 'updated_at'].includes(key))
          assert.deepEqual(JSON.parse(JSON.stringify(value)), original[key]);
      assert(BigInt(header.version) > BigInt(original.version));

      // Identify new jobs from exact causal RMA events, never a timestamp cutoff.
      // Every other full job row must reconstruct the immutable setup SHA/count.
      const expectedEvents =
        side === 'buyer'
          ? [
              ['return.requested', local.id],
              ['return.received', local.id],
              ['return.requested', retail.id],
              ['return.partner_accepted', retail.id],
            ]
          : [
              ['return.requested', wholesale.id],
              ['return.received', wholesale.id],
            ];
      const eventRows: Row[] = (
        await c.query(
          `SELECT * FROM order_events
        WHERE tenant_id=$1 AND order_id=$2 AND detail->>'return_id'=ANY($3::text[])
        ORDER BY created_at,id`,
          [a.tenant, header.id, expectedEvents.map((x) => x[1])],
        )
      ).rows;
      assert.deepEqual(
        eventRows.map((e) => [e.kind, e.detail.return_id]),
        expectedEvents,
      );
      assert.equal(
        BigInt(header.version),
        BigInt(original.version) + BigInt(expectedEvents.length),
      );
      const jobRows = await rows(c, 'jobs', a.tenant);
      const newIds: string[] = [];
      for (const [index, event] of eventRows.entries()) {
        const job = one(jobRows.filter((j) => j.payload?.eventId === event.id));
        assert.equal(job.tenant_id, a.tenant);
        assert.equal(job.kind, 'automation');
        assert.equal(job.state, 'pending');
        assert.equal(job.attempts, 0);
        assert.equal(job.max_attempts, 5);
        assert.equal(job.priority, 100);
        assert.equal(job.error, null);
        assert.equal(job.locked_at, null);
        assert.equal(job.lease_token, null);
        assert.equal(job.provider_wait_until, null);
        assert.equal(job.provider_wait_reason, null);
        assert.equal(job.dedup_key, 'event:' + event.id);
        assert.deepEqual(Object.keys(job.payload).sort(), [
          'context',
          'eventId',
          'orderId',
          'rules',
          'snapshot',
          'trigger',
        ]);
        assert.equal(job.payload.orderId, header.id);
        assert.equal(job.payload.trigger, event.kind);
        assert.deepEqual(job.payload.rules, []);
        const context = job.payload.context;
        assert.deepEqual(Object.keys(context).sort(), ['chain_id', 'depth', 'trace']);
        assert.match(context.chain_id, /^[a-f0-9-]{36}$/);
        assert(!automationChains.has(context.chain_id));
        automationChains.add(context.chain_id);
        assert.equal(context.depth, 0);
        assert.deepEqual(context.trace, []);
        const version = BigInt(original.version) + BigInt(index + 1);
        assert.deepEqual(job.payload.snapshot, {
          id: header.id,
          status: original.status,
          source: original.source,
          total: original.total,
          currency: original.currency,
          warehouse_id: original.warehouse_id,
          workflow_status_id: original.workflow_status_id,
          tags: original.tags,
          version: typeof original.version === 'string' ? String(version) : Number(version),
          country: original.address.country,
          item_count: original.items.reduce((n: number, i: Row) => n + i.quantity, 0),
          skus: original.items.map((i: Row) => i.sku),
        });
        newIds.push(job.id);
        appendedJobs.push({
          id: job.id,
          event_id: event.id,
          tenant_id: a.tenant,
          order_id: header.id,
          return_id: event.detail.return_id,
          trigger: event.kind,
          kind: job.kind,
          state: job.state,
          rules: 0,
        });
      }
      const originalJobs = (
        await c.query(
          'SELECT to_jsonb(t) row FROM jobs t WHERE tenant_id=$1 AND id<>ALL($2::uuid[]) ORDER BY 1',
          [a.tenant, newIds],
        )
      ).rows;
      assert.deepEqual(
        { count: originalJobs.length, sha256: hash(originalJobs) },
        s.setup_checkpoint[side].jobs,
      );
      assert.equal(jobRows.length, s.setup_checkpoint[side].jobs.count + expectedEvents.length);
    }
    assert.equal(appendedJobs.length, 6);
    const binding = one(await rows(c, 'order_source_lines', buyer.tenant));
    assert.equal(binding.id, one(s.source_born.source_bindings).id);
    assert.equal(binding.source_item_id, s.customer_item);
    assert.equal(binding.source_order_id, s.customer_order);
    assert.equal(binding.quantity, 3);
    assert.equal(binding.line_total, 7500);
    captured = await snapshot(c, s);
    const changed = new Set([
      'orders',
      'order_events',
      'audit_events',
      'jobs',
      'stock',
      'stock_locations',
      'stock_location_movements',
      'stock_movements',
      'purchasing_stock_changes',
      'return_cases',
      'return_items',
      'b2b_return_local_origins',
      'b2b_return_local_proofs',
      'b2b_dropship_return_previews',
      'b2b_dropship_return_preview_rows',
      'b2b_dropship_return_cases',
      'b2b_dropship_return_lines',
      'b2b_dropship_return_supplier_cases',
      'b2b_dropship_return_actions',
      'b2b_dropship_return_proofs',
    ]);
    for (const side of ['buyer', 'supplier'] as const) {
      assert.deepEqual(Object.keys(captured[side]), Object.keys(s.setup_checkpoint[side]));
      unchanged(
        captured[side],
        s.setup_checkpoint[side],
        Object.keys(captured[side]).filter((n) => !changed.has(n)),
      );
      unchanged(captured[side], s.setup_checkpoint[side], [
        'payment_entries',
        'shipments',
        'shopify_dispatch_evidence',
        'order_source_lines',
        'order_items',
        'order_pick_items',
        'reservations',
        'reservation_locations',
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
      ]);
      assert.equal(captured[side].return_items.count, side === 'buyer' ? 2 : 1);
      assert.equal(captured[side].b2b_return_local_origins.count, side === 'buyer' ? 1 : 0);
      assert.equal(captured[side].b2b_return_local_proofs.count, side === 'buyer' ? 1 : 0);
    }
    evidence = {
      local_return_id: local.id,
      partner_return_id: retail.id,
      supplier_return_id: wholesale.id,
      origin_id: origin.id,
      local_proof_id: localProof.id,
      case_id: bridge.id,
      preview_id: bridge.preview_id,
      actions: actions
        .filter((a) => a.kind !== 'settings')
        .map((a) => ({ id: a.id, kind: a.kind, tenant_id: a.tenant_id, actor_id: a.actor_id })),
      row: line.row,
      local_origin: origin,
      local_proof: localProof,
      partner_proofs: proofs,
      appended_jobs: appendedJobs,
    };
    await c.query('COMMIT');
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }

  step = 'api_readback';
  for (const [a, rid, kind, amount, restocked] of [
    [buyer, evidence.local_return_id, 'physical', 2500, 1],
    [buyer, evidence.partner_return_id, 'partner', 2500, 0],
    [supplier, evidence.supplier_return_id, 'physical', 700, 1],
  ] as const) {
    const r = await get(a, '/returns/' + rid);
    assert.equal(r.id, rid);
    assert.equal(r.acceptance_kind, kind);
    assert(r.accepted_at);
    assert.equal(r.refund_amount, amount);
    assert.equal(r.settlement, null);
    assert.equal(r.refunded_at, null);
    assert.equal(r.received_at === null, kind === 'partner');
    assert.equal(r.physical_received_at === null, kind === 'partner');
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].accepted, 1);
    assert.equal(r.items[0].restocked, restocked);
    const response = await get(a, prefix + '/returns/' + rid + '/context');
    assert.equal(response.current_role, 'admin');
    assert.equal(response.read_only, false);
    assert.equal(
      response.context.fulfillment_origin,
      rid === evidence.local_return_id ? 'local' : kind === 'partner' ? 'partner' : 'supplier',
    );
    if (rid === evidence.local_return_id) {
      assert.equal(response.context.local_origin.id, evidence.origin_id);
      assert.deepEqual(response.context.local_origin.items, [
        { customer_item_id: s.customer_item, shipment_id: s.local_shipment, quantity: 1 },
      ]);
      assert.deepEqual(response.context.case_refs, []);
    } else {
      assert.equal(response.context.can_receive_locally, false);
      assert.equal(response.context.local_origin, null);
      assert.deepEqual(
        response.context.case_refs.map((x: Row) => x.id),
        [evidence.case_id],
      );
    }
    assert.equal(response.context.can_select_local_origin, false);
    assert.equal(response.context.can_reconcile, false);
  }
  for (const a of [buyer, supplier]) {
    const head = (await get(a, prefix + '/cases/' + evidence.case_id)).case;
    assert.equal(head.id, evidence.case_id);
    assert.equal(head.state, 'received');
    assert.equal(head.wholesale_refund_minor, '700');
    assert(head.received_at && head.retail_reconciled_at);
    const line = one(await pages(a, prefix + '/cases/' + evidence.case_id + '/rows'));
    assert.equal(line.retail_refund_minor, '2500');
    assert.equal(line.wholesale_refund_minor, '700');
    assert.deepEqual(
      (await pages(a, prefix + '/cases/' + evidence.case_id + '/events')).map((e) => e.kind).sort(),
      ['receive', 'reconcile', 'submit'],
    );
  }
  for (const [side, a, oid, received, credit] of [
    ['buyer', buyer, s.customer_order, 7500, 5000],
    ['supplier', supplier, s.supplier_order, 1400, 700],
  ] as const) {
    const p = await get(a, '/orders/' + oid + '/payments');
    assert.deepEqual(p.data, s.native_journals[side + '_payments'].data);
    for (const [k, v] of Object.entries({
      received,
      refunded: 0,
      credit,
      nominal: received - credit,
      net: received,
      amount_due: 0,
      overpayment: credit,
    }))
      assert.equal(p.balance[k], v);
    const o = await get(a, '/orders/' + oid);
    const original = s.source_born[side + '_order'];
    for (const k of [
      'id',
      'number',
      'total',
      'shipping_cost',
      'currency',
      'status',
      'payment_mode',
      'customer_name',
      'email',
      'address',
    ])
      assert.deepEqual(o[k], original[k]);
    assert.deepEqual(o.items, original.items);
    assert.deepEqual(o.picking_items, original.picking_items);
  }
  await health();
  const end = await pool.connect();
  try {
    await begin(end);
    assert.deepEqual(
      await snapshot(end, s),
      captured,
      'Business state changed during GET readback',
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
  assert.equal(
    process.env.QA129_CHROME_VERIFIED,
    'true',
    'Root actual Chrome attestation required',
  );
  assert.notEqual(process.env.DYNA_TEST, 'true');
  assert.match(process.env.QA_EXPECTED_REVISION ?? '', /^[a-f0-9]{7,40}$/);
  const db = new URL(process.env.DATABASE_URL ?? '');
  assert(['localhost', '127.0.0.1', '[::1]'].includes(db.hostname));
  assert(['postgres:', 'postgresql:'].includes(db.protocol));
  assert.equal(db.search, '');
  assert.equal(db.pathname, '/dynaminds');
  assert.equal(process.env.QA129_DATABASE_NAME, 'dynaminds');
  const config = await lstat(process.env.DYNA_LOCAL_CONFIG_PATH ?? '.local.json');
  assert(config.isFile() && !config.isSymbolicLink() && !(config.mode & 0o077));
  await absent(checkpointPath);
  await absent(reportPath);
  const setupBytes = await privateFile(setupPath),
    setupReportBytes = await readFile(setupReportPath);
  const s: Row = JSON.parse(setupBytes.toString('utf8')),
    setupReport: Row = JSON.parse(setupReportBytes.toString('utf8'));
  assert.equal(s.stage129, true);
  assert.equal(s.setup_complete, true);
  assert.equal(s.pending, null);
  assert.equal(s.schema_revision, schema);
  assert.equal(s.runtime_revision, process.env.QA_EXPECTED_REVISION);
  assert.equal(setupReport.status, 'PASS');
  assert.equal(setupReport.revision, s.runtime_revision);
  assert.equal(setupReport.schema_revision, schema);
  assert.equal(setupReport.setup_checkpoint_sha256, hash(s.setup_checkpoint));
  await health();
  pool = (await import('../server/db')).pool;
  step = 'sql_readback';
  const { captured, evidence } = await verify(s, db);
  assert.deepEqual(await privateFile(setupPath), setupBytes);
  assert.deepEqual(await readFile(setupReportPath), setupReportBytes);
  const setup = {
    path: setupPath,
    bytes: setupBytes.length,
    sha256: bytesHash(setupBytes),
    report_sha256: bytesHash(setupReportBytes),
    checkpoint_sha256: hash(s.setup_checkpoint),
  };
  const result = {
    stage: 129,
    phase: 'native_chrome_readback',
    status: 'PASS',
    revision: s.runtime_revision,
    schema_revision: schema,
    setup_bytes_unchanged: true,
    setup,
    setup_file_sha256: setup.sha256,
    checkpoint_sha256: hash(captured),
    own_tables: {
      buyer: Object.keys(captured.buyer).length,
      supplier: Object.keys(captured.supplier).length,
    },
    sessions_excluded: true,
    background_workers_enabled: false,
    local_origin_bound: true,
    local_private_proof_applied: true,
    partner_private_proofs_applied: 2,
    buyer_stock: 5,
    supplier_stock: 19,
    reserved_both: 0,
    local_received_quantity: 1,
    local_restocked_quantity: 1,
    supplier_received_quantity: 1,
    supplier_restocked_quantity: 1,
    partner_buyer_restocked_quantity: 0,
    local_retail_credit_minor: 2500,
    partner_retail_credit_minor: 2500,
    wholesale_credit_minor: 700,
    buyer_cash_received_minor: 7500,
    supplier_cash_received_minor: 1400,
    cash_entries_exact_both_firms: true,
    original_job_rows_exact_both_firms: true,
    appended_jobs: {
      buyer: 4,
      supplier: 2,
      total: 6,
      kind: 'automation',
      state: 'pending',
      rules: 0,
      provenance:
        'Exact own RMA event ID/order/trigger, frozen order snapshot and version; all remaining full rows equal setup count/SHA',
    },
    original_commercial_lines_dispatch_evidence_and_shipments_exact: true,
    wms_mode: 'OFF',
    human_chrome_attestation: {
      confirmed: true,
      source: 'Root actual Chrome; explicit QA129_CHROME_VERIFIED=true',
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
        stage: 129,
        stage129: true,
        captured_at: new Date().toISOString(),
        runtime_revision: s.runtime_revision,
        schema_revision: schema,
        setup,
        buyer: { tenant: s.buyer.tenant, user: s.buyer.user },
        supplier: { tenant: s.supplier.tenant, user: s.supplier.user },
        checkpoint: captured,
        evidence,
        chrome_verified: true,
        chrome_human_attested: true,
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  await writeFile(reportPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(
    'QA129 Chrome readback PASS (GET and read-only SQL; no cash/provider writes)\n',
  );
} catch (error) {
  const failure = error as Error & { code?: string };
  // Only this helper's numeric frames are public; never print the assertion
  // message, actual/expected objects, HTTP payload, path or complete stack.
  const sourceFrames = Array.from(
    (failure.stack ?? '').matchAll(/b2b-return-local-origins-native-readback\.ts:(\d+):(\d+)/g),
    (frame) => ({ line: Number(frame[1]), column: Number(frame[2]) }),
  );
  process.stderr.write(
    JSON.stringify({
      stage: 129,
      phase: 'native_chrome_readback',
      status: 'FAIL',
      step,
      code: failure.code,
      source_line: sourceFrames[0]?.line ?? null,
      source_frames: sourceFrames,
      setup_rewritten: false,
      automatic_retry: false,
    }) + '\n',
  );
  process.exitCode = 1;
} finally {
  await pool?.end();
}
