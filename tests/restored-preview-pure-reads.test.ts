/** Actual GET callbacks, read helpers and tenantReadTx with closed pool/SQL ports.
 * These tests verify composition and fail-closed guards, not actual PG RLS or latency.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { z } from 'zod';
import { ensure, Problem } from '../server/errors';

const read = (path: string) => readFileSync(new URL('../server/' + path, import.meta.url), 'utf8');
function section(source: string, first: string, next: string) {
  const a = source.indexOf(first), b = source.indexOf(next, a + first.length);
  assert(a >= 0 && b > a, 'Actual source section missing');
  return source.slice(a, b);
}
function load(source: string, imports: Record<string, any> = {}, bindings: Record<string, any> = {}) {
  const module = { exports: {} as any };
  const code = transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
  new Function('module', 'exports', 'require', ...Object.keys(bindings), code)(
    module, module.exports, (key: string) => {
      assert(Object.hasOwn(imports, key), 'Unexpected source dependency: ' + key);
      return imports[key];
    }, ...Object.values(bindings),
  );
  return module.exports;
}
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const own = id(1), foreign = id(2), warehouse = id(3), product = id(4), order = id(5), channel = id(6);
const unavailable = () => { throw Error('Unexpected writer/provider dependency'); };
const writer = new Error('Controlled writer admission must remain separate');
const sellability = load(read('warehouse-sellability.ts'));
const policySchema = load(read('warehouse-inventory-policies-schema.ts'), { zod: { z } });
const merge = load(read('order-merge-guards.ts'), { './errors': { ensure } });
// c41d5da: snapshot reads hide deleted products through the actual pure 225 helpers.
const productDeletions = load(read('product-deletions.ts'), { './errors': { ensure } });
const commercial = load(read('commercial-sale-scope.ts'), { zod: { z }, './errors': { ensure } });
const mergePayments = load(read('order-merge-payments.ts'), {
  './errors': { ensure }, './commercial-sale-scope': commercial,
});
const payments = load(section(read('payments.ts'), 'export async function paymentBalance(', 'async function replay('), {}, {
  ...merge, ...mergePayments,
});
const sourcePaymentsSource = read('source-payments.ts');
const sourcePayments = load(
  section(sourcePaymentsSource, 'export const sourceProviders =', 'function sourceValue(') +
  section(sourcePaymentsSource, 'export async function sourceHistory(', 'export async function applySourceCheck('), {}, { ensure },
);
const presta = load(section(read('prestashop-status.ts'), 'export const psStatusKeys =', 'export function psResourceKey('), {}, { z, ensure });
const statusSource = read('order-status.ts');
const status = load(
  section(statusSource, 'export const statusMappings:', 'const hash =') +
  section(statusSource, 'export function mappingsFor(', 'export function commerceHash(') +
  section(statusSource, 'export async function statusOrder(', 'function observed('),
  {}, { ensure, ...merge, psStatusMap: presta.psStatusMap, psId: unavailable },
);

function fixture(options: { gated?: boolean; installed?: boolean; partial?: boolean; guard?: boolean; merged?: boolean;
  paymentMerged?: boolean; commercialPlan?: boolean; paymentRows?: number; provider?: string } = {}) {
  const calls: string[] = [], queries: { sql: string; values: any[]; role: string; tenant: string | null }[] = [];
  const state = {
    role: 'postgres', tenant: null as string | null, readOnly: false,
    connections: 0, writes: 0, released: false, failSQL: '', failure: new Error('Controlled read failure'),
    gateFailure: null as Error | null, sourceAmount: '1230',
  };
  const stock = { warehouse_id: warehouse, product_id: product, on_hand: 10, reserved: 2, available: 8, version: '4' };
  const sourceOrder = { id: order, channel_id: channel, tenant_id: own, source: 'woocommerce', external_id: '31',
    status: 'paid', version: '4', total: 1230, shipping_cost: 0, currency: 'PLN', payment_mode: 'prepaid', source_snapshot: { items: [{ id: '29' }] } };
  const sourceChannel = { id: channel, name: 'Own shop', provider: options.provider ?? 'woocommerce', mode: 'live', settings: {} as Record<string, any> };
  const plan = { id: id(7), order_id: order, channel_id: channel, state: 'done' };
  const client = {
    release(destroy?: boolean) { calls.push(destroy ? 'destroy' : 'release'); state.released = true; },
    async query(sql: string, values: any[] = []) {
      queries.push({ sql, values: structuredClone(values), role: state.role, tenant: state.tenant });
      if (state.failSQL && sql.includes(state.failSQL)) throw state.failure;
      if (sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ') { calls.push('begin'); return { rows: [] }; }
      if (sql === 'SET TRANSACTION READ ONLY') { state.readOnly = true; return { rows: [] }; }
      if (sql === 'SET LOCAL ROLE dyna_app') { state.role = 'dyna_app'; return { rows: [] }; }
      if (sql === 'RESET ROLE') { state.role = 'postgres'; return { rows: [] }; }
      if (sql === "SET LOCAL statement_timeout='8s'") return { rows: [] };
      if (sql === 'COMMIT' || sql === 'ROLLBACK') { calls.push(sql); return { rows: [] }; }
      assert(state.readOnly, 'Business reads must follow READ ONLY');
      assert.match(sql, /^(?:SELECT|WITH)\b/);
      assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP|FOR SHARE|pg_advisory)\b/i);
      if (sql === "SELECT set_config('app.tenant_id',$1,true)") { state.tenant = values[0]; return { rows: [] }; }
      if (sql.startsWith('SELECT current_user role')) return { rows: [{ role: state.role, owner: 'postgres', tenant: state.tenant }] };
      if (sql.includes("to_regprocedure('public.warehouse_inventory_policy_installed()')")) {
        assert.equal(state.role, 'postgres');
        return { rows: [{ marker: options.installed === false ? null : 'warehouse_inventory_policy_installed',
          partial: options.partial ?? options.installed !== false, migration_table: 'migrations' }] };
      }
      if (sql.includes("name='146_warehouse_inventory_policies'")) return { rows: [{ installed: options.installed !== false }] };
      if (sql === 'SELECT public.warehouse_inventory_policy_guards() ok') {
        assert.equal(state.role, 'postgres'); return { rows: [{ ok: options.guard !== false }] };
      }
      assert.equal(state.role, 'dyna_app', 'Business rows must be queried with tenant RLS role');
      let rows: any[];
      if (sql === "SELECT nullif(current_setting('app.tenant_id',true),'') AS tenant") rows = [{ tenant: state.tenant }];
      else if (sql === "SELECT current_setting('transaction_read_only') ro") rows = [{ ro: state.readOnly ? 'on' : 'off' }];
      else if (sql.startsWith("SELECT current_setting('transaction_read_only') ro,current_setting('transaction_isolation')"))
        rows = [{ ro: 'on', isolation: 'repeatable read', role: state.role, tenant: state.tenant }];
      else if (sql === "SELECT to_regclass('public.product_deletions225') present") rows = [{ present: 'product_deletions225' }];
      else if (sql.includes("to_regclass('public.order_merge_claims')")) rows = [{ available: Boolean(options.paymentMerged) }];
      else if (sql.startsWith('SELECT source_order_id,target_order_id,execution_id,merge_mode FROM order_merge_claims'))
        rows = options.paymentMerged && state.tenant === own ? [{ source_order_id: order, target_order_id: id(20) }] : [];
      else if (sql === 'SELECT * FROM orders WHERE tenant_id=$1 AND id=$2') rows = state.tenant === own && values[0] === own && values[1] === order ? [sourceOrder] : [];
      else if (sql.startsWith('SELECT count(*)::integer AS n FROM orders')) rows = [{ n: state.tenant === own ? 1 : 0 }];
      else if (sql.startsWith('SELECT 1 FROM payment_entries')) rows = [];
      else if (sql.startsWith('SELECT coalesce(sum(p.amount) FILTER')) rows = [{ received: '1230', refunded: '0', collected: '0', remitted: '0', fees: '0' }];
      else if (sql.startsWith('SELECT coalesce(sum(refund_amount)')) rows = [{ n: '0' }];
      else if (sql.startsWith('SELECT id,tenant_id,order_id,payload FROM order_parcel_plans'))
        rows = options.commercialPlan ? [{ id: id(30), tenant_id: own, order_id: order, payload: { protocol: 'commercial_v1' } }] : [];
      else if (sql.startsWith('SELECT public.partial_sale204_valid()')) rows = [{ valid: false, commercial: true, release: true }];
      else if (sql.startsWith('SELECT header FROM order_merge_origins')) rows = [{ header: sourceOrder }];
      else if (sql.startsWith('SELECT p.*,r.kind AS reversed_kind')) {
        assert.deepEqual(values[0], [order]);
        assert.match(sql, /ORDER BY p.created_at DESC,p.id DESC LIMIT 51$/);
        rows = Array.from({ length: options.paymentRows ?? 1 }, (_, n) => ({ id: id(100 + n), order_id: order, amount: 1230, method: 'source_import' }));
      } else if (sql === 'SELECT id,channel_id FROM orders WHERE id=$1') rows = state.tenant === own && values[0] === order ? [{ id: order, channel_id: channel }] : [];
      else if (sql.startsWith('SELECT id,state,source_amount,previous_amount')) rows = [{ id: id(8), state: 'applied', source_amount: 1230 }];
      else if (sql.startsWith("SELECT id,state,error,attempts FROM jobs WHERE kind='payment.source.read'")) rows = [{ id: id(9), state: 'done', error: null, attempts: 0 }];
      else if (sql.startsWith('SELECT\n    coalesce(sum(p.amount)')) rows = [{ source: state.sourceAmount, manual: '0', corrected: false }];
      else if (sql === 'SELECT id,provider FROM channels WHERE id=$1') rows = state.tenant === own && values[0] === channel ? [{ id: channel, provider: 'woocommerce' }] : [];
      else if (sql.startsWith('SELECT enabled,interval_seconds,version,cursor,next_at,error FROM source_payment_configs')) rows = [{ enabled: false, interval_seconds: 60, version: 2, cursor: null, next_at: null, error: null }];
      else if (sql.startsWith('WITH warehouse_policy_map')) {
        assert.match(sql, /s\.warehouse_id=\$1 AND s\.product_id=ANY\(\$2::uuid\[\]\) AND NOT EXISTS\(SELECT 1 FROM product_deletions225 pd225 WHERE \(pd225\.tenant_id,pd225\.product_id\)=\(p\.tenant_id,p\.id\)\)/);
        rows = state.tenant === own && values[0] === warehouse && values[1].includes(product) ? [stock] : [];
      } else if (sql === 'SELECT * FROM orders WHERE id=$1') {
        rows = state.tenant === own && values[0] === order ? [{ ...sourceOrder,
          ...(options.merged ? { source_snapshot: { items: [] }, total: 9999 } : {}) }] : [];
      } else if (sql.includes("to_regclass('public.order_merge_origins')")) rows = [{ available: Boolean(options.merged) }];
      else if (sql === 'SELECT header,items FROM order_merge_origins WHERE order_id=$1') rows = [{ header: sourceOrder, items: [] }];
      else if (sql.startsWith('SELECT id,name,provider,mode,settings')) rows = state.tenant === own && values[0] === channel ? [sourceChannel] : [];
      else if (sql.startsWith('SELECT * FROM order_status_configs')) rows = [{ channel_id: channel, version: '2', enabled: false }];
      else if (sql.startsWith('SELECT * FROM order_status_plans')) {
        assert.match(sql, /ORDER BY created_at DESC,id DESC LIMIT 25$/); rows = [plan];
      } else if (sql.startsWith("SELECT id,state,error,attempts,payload->'stats'")) {
        assert.match(sql, /ORDER BY created_at DESC,id DESC LIMIT 10$/); rows = [{ id: id(22), state: 'done', attempts: 0, stats: { checked: 1 } }];
      } else if (sql.startsWith('SELECT p.*,o.number FROM order_status_plans')) {
        assert.match(sql, /ORDER BY p.created_at DESC,p.id DESC LIMIT 25$/); rows = [{ ...plan, number: 'ORD-OWN' }];
      } else throw Error('Unexpected controlled query: ' + sql);
      return { rows: structuredClone(rows), rowCount: rows.length };
    },
  };
  const gate = {
    async reserve(c: any) {
      assert.equal(c, client); calls.push('reserve');
      return { async enter() { calls.push('enter'); if (state.gateFailure) throw state.gateFailure; },
        async close() { calls.push('close'); } };
    },
  };
  const db = load(section(read('db.ts'), 'export async function tenantReadTx<', '/** Lookup-only source provenance.'), {}, {
    pool: { connect: async () => { state.connections++; state.released = false; return client; } },
    ordinarySchemaGate: options.gated ? gate : undefined, assert,
    assertOwnedOrdinarySchemaTransactionGate: (g: any) => assert.equal(g, gate),
  });
  const tenantTx = async () => { state.writes++; throw writer; };
  const transactionModules = Object.fromEntries(['./catalog-stock-control-transaction', './wms-lots-transaction', './purchasing-transaction']
    .map(name => [name, new Proxy({}, { get: () => unavailable })]));
  const policies = load(read('warehouse-inventory-policies.ts'), { ...transactionModules,
    './db': { pool: { connect: unavailable } }, './errors': { ensure, Problem }, zod: { z },
    './warehouse-inventory-policies-schema': policySchema });
  // fabcc20: inventory.ts also hosts the legacy delta writer (randomUUID, audit); a GET must never reach them.
  const inventory = load(read('inventory.ts'), { zod: { z }, './errors': { Problem, ensure },
    'node:crypto': { randomUUID: unavailable }, './domain': { audit: unavailable }, './product-deletions': productDeletions,
    './warehouse-inventory-policies': policies, './warehouse-sellability': sellability });
  const routes = new Map<string, any>();
  const app = Object.fromEntries(['get', 'post', 'patch'].map(method => [method,
    (path: string, handler: any) => routes.set(method.toUpperCase() + ' ' + path, handler)]));
  // Execute the exact app registration; importing buildApp itself would initialize unrelated app dependencies.
  const snapshot = section(read('app.ts'), "  app.get('/api/inventory/snapshot',", "  app.post('/api/inventory/adjust/previews',");
  load(snapshot, {}, { app, ...inventory, tenantReadTx: db.tenantReadTx, tenantTx });
  const routeModule = load(read('order-status-routes.ts'), {
    zod: { z }, './db': { tenantTx, tenantReadTx: db.tenantReadTx }, './errors': { ensure },
    './prestashop-status': presta,
    './domain': { audit: unavailable }, './channel-access': { withAllegroRequestContext: unavailable },
    './order-status': { ...status, previewStatus: unavailable, queueStatus: unavailable, reconcileStatus: unavailable,
      statusConnection: unavailable, requireStatusScope: unavailable },
  });
  routeModule.registerOrderStatusRoutes(app);
  load(read('payment-routes.ts'), { zod: { z }, './db': { tenantTx, tenantReadTx: db.tenantReadTx },
    './payments': { ...payments, recordPayment: unavailable, reversePayment: unavailable, paymentInput: z.any(), reversalInput: z.any() },
  }).registerPaymentRoutes(app);
  load(read('source-payment-routes.ts'), { zod: { z }, './db': { tenantTx, tenantReadTx: db.tenantReadTx },
    './errors': { ensure }, './domain': { audit: unavailable }, './order-status': { statusConnection: unavailable },
    './imports': { stageOrders: unavailable }, './source-payments': { ...sourcePayments, queueSourceRead: unavailable, applySourceCheck: unavailable },
  }).registerSourcePaymentRoutes(app);
  const request = (patch: any = {}) => ({ actor: { tenantId: own, userId: id(8), role: 'admin' },
    params: { id: order }, query: { warehouse_id: warehouse, product_ids: product }, ...patch });
  const call = async (path: string, patch: any = {}) => routes.get(path)(request(patch));
  return { state, calls, queries, stock, sourceOrder, sourceChannel, plan, request, call };
}

const SNAPSHOT = 'GET /api/inventory/snapshot', STATUS = 'GET /api/orders/:id/channel-status';
const problem = (code: number) => (e: unknown) => e instanceof Problem && e.status === code;

test('snapshot uses actual RR READ ONLY runner and fresh policy guard, retaining tenant role, filter and duplicate handling', async () => {
  for (const gated of [false, true]) {
    const f = fixture({ gated });
    const result = await f.call(SNAPSHOT, { query: { warehouse_id: warehouse, product_ids: `${product},${product},${id(99)}` } });
    assert.deepEqual(result, { data: [f.stock], meta: { requested: 2, found: 1 } });
    const frame = f.queries.findIndex(q => q.sql.startsWith('WITH warehouse_policy_map'));
    assert(f.queries.slice(0, frame).some(q => q.sql === 'SELECT public.warehouse_inventory_policy_guards() ok'));
    assert.match(f.queries[frame].sql, /public\.warehouse_inventory_policy\(w.tenant_id,w.id\)/);
    assert.equal(f.queries[frame].tenant, own); assert.equal(f.queries[frame].role, 'dyna_app');
    assert.equal(f.state.writes, 0); assert(f.state.released);
    assert.deepEqual(f.calls, gated ? ['reserve', 'begin', 'enter', 'COMMIT', 'close', 'release'] : ['begin', 'COMMIT', 'release']);
  }
});

test('snapshot rejects partial or invalid policy metadata and query errors without data read or writer fallback', async () => {
  for (const options of [{ installed: false, partial: true }, { guard: false }]) {
    const f = fixture(options); await assert.rejects(f.call(SNAPSHOT), problem(503));
    assert(!f.queries.some(q => q.sql.startsWith('WITH warehouse_policy_map')));
    assert.equal(f.state.role, 'dyna_app'); assert(f.calls.includes('ROLLBACK')); assert(f.state.released); assert.equal(f.state.writes, 0);
  }
  const f = fixture({ gated: true }); f.state.failSQL = 'warehouse_inventory_policy_guards()';
  await assert.rejects(f.call(SNAPSHOT), e => e === f.state.failure);
  assert.deepEqual(f.calls, ['reserve', 'begin', 'enter', 'ROLLBACK', 'close', 'release']);
});

test('whole legacy policy absence remains supported; foreign tenant/filter yields empty and malformed input never opens a transaction', async () => {
  const f = fixture({ installed: false });
  await f.call(SNAPSHOT);
  assert.match(f.queries.find(q => q.sql.startsWith('WITH warehouse_policy_map'))!.sql, /jsonb_build_object\('usage','sale'/);
  for (const patch of [{ actor: { tenantId: foreign, role: 'viewer' } }, { query: { warehouse_id: id(99), product_ids: product } }])
    assert.deepEqual(await f.call(SNAPSHOT, patch), { data: [], meta: { requested: 1, found: 0 } });
  const connections = f.state.connections;
  await assert.rejects(f.call(SNAPSHOT, { query: { warehouse_id: warehouse, product_ids: 'bad' } }));
  assert.equal(f.state.connections, connections); assert.equal(f.state.writes, 0);
});

test('channel status retains actual merge-origin mapping, config and bounded local plans in one read transaction with no provider', async () => {
  const f = fixture({ gated: true, merged: true });
  const result = await f.call(STATUS);
  assert.equal(result.target, 'processing'); assert.equal(result.reason, null);
  assert.equal(result.local_status, 'paid'); assert.equal(result.local_version, '4');
  assert.deepEqual(result.config, { channel_id: channel, version: '2', enabled: false });
  assert.deepEqual(result.data, [f.plan]);
  assert(f.queries.some(q => q.sql === 'SELECT header,items FROM order_merge_origins WHERE order_id=$1'));
  assert(f.queries.filter(q => /^(SELECT \* FROM orders|SELECT id,name|SELECT \* FROM order_status)/.test(q.sql))
    .every(q => q.tenant === own && q.role === 'dyna_app'));
  assert.equal(f.state.writes, 0); assert.deepEqual(f.calls, ['reserve', 'begin', 'enter', 'COMMIT', 'close', 'release']);
});

test('channel status preserves admin gate, missing/foreign 404, invalid identity and fail-closed read errors', async () => {
  const f = fixture();
  await assert.rejects(f.call(STATUS, { actor: { tenantId: own, role: 'viewer' } }), problem(403));
  assert.equal(f.state.connections, 0);
  for (const patch of [{ actor: { tenantId: foreign, role: 'admin' } }, { params: { id: id(99) } }])
    await assert.rejects(f.call(STATUS, patch), problem(404));
  assert(!f.queries.some(q => q.sql.includes('FROM channels')));
  await assert.rejects(f.call(STATUS, { params: { id: 'bad' } }));
  f.state.failSQL = 'FROM order_status_configs';
  await assert.rejects(f.call(STATUS), e => e === f.state.failure);
  assert.equal(f.state.writes, 0); assert(f.state.released); assert.equal(f.calls.at(-2), 'ROLLBACK');
});

test('ordinary read lease refusal never runs callback or retries as a writer; mutation route still uses writer port', async () => {
  const f = fixture({ gated: true }); f.state.gateFailure = new Error('Current schema read admission refused');
  await assert.rejects(f.call(STATUS), e => e === f.state.gateFailure);
  assert(!f.queries.some(q => q.sql.includes('FROM orders')));
  assert.deepEqual(f.calls, ['reserve', 'begin', 'enter', 'ROLLBACK', 'close', 'destroy']);
  await assert.rejects(f.call('POST /api/channel-status-plans/:id/cancel'), e => e === writer);
  assert.equal(f.state.writes, 1);
});

test('payment history executes actual balance/merge/read-only commercial graph and keeps 50+1 cursor boundary', async () => {
  for (const paymentMerged of [false, true]) {
    const f = fixture({ gated: true, paymentMerged, merged: paymentMerged, paymentRows: 51 });
    const result = await f.call('GET /api/orders/:id/payments', { query: { before: id(999) }, actor: { tenantId: own, role: 'viewer' } });
    assert.equal(result.balance.currency, 'PLN'); assert.equal(result.balance.received, 1230); assert.equal(result.balance.amount_due, 0);
    assert.equal(result.data.length, 50); assert.equal(result.next, id(149));
    assert(f.queries.some(q => q.sql.startsWith('SELECT id,tenant_id,order_id,payload FROM order_parcel_plans')));
    assert.deepEqual(f.queries.find(q => q.sql.startsWith('SELECT p.*,r.kind AS reversed_kind'))!.values, [[order], id(999)]);
    assert.equal(f.state.writes, 0); assert.deepEqual(f.calls, ['reserve', 'begin', 'enter', 'COMMIT', 'close', 'release']);
  }
});

test('payment history refuses invalid commercial read guards, foreign orders and invalid cursor without writer fallback', async () => {
  const f = fixture({ commercialPlan: true });
  await assert.rejects(f.call('GET /api/orders/:id/payments', { query: {} }), problem(503));
  assert(f.queries.some(q => q.sql.startsWith('SELECT public.partial_sale204_valid()')));
  assert(!f.queries.some(q => q.sql.startsWith('SELECT p.*,r.kind AS reversed_kind')));
  for (const patch of [{ actor: { tenantId: foreign, role: 'admin' }, query: {} }, { query: { before: 'bad' } }]) {
    const x = fixture(); await assert.rejects(x.call('GET /api/orders/:id/payments', patch));
    assert.equal(x.state.writes, 0); assert(x.calls.includes('ROLLBACK')); assert(x.state.released);
  }
});

test('source history and schedule read keep original totals, checks, jobs and config without provider or queue', async () => {
  const f = fixture({ gated: true });
  const history = await f.call('GET /api/orders/:id/source-payments');
  assert.deepEqual(history.totals, { amount: 1230, manual: 0, corrected: false });
  assert.deepEqual(history.channel, { id: channel, name: 'Own shop', provider: 'woocommerce', simulation: false });
  assert.deepEqual(history.data, [{ id: id(8), state: 'applied', source_amount: 1230 }]);
  assert.deepEqual(history.job, { id: id(9), state: 'done', error: null, attempts: 0 });
  const schedule = await f.call('GET /api/integrations/:id/payment-sync', { params: { id: channel } });
  assert.deepEqual(schedule, { config: { enabled: false, interval_seconds: 60, version: 2, cursor: null, next_at: null, error: null } });
  assert.equal(f.state.writes, 0); assert.equal(f.calls.filter(x => x === 'COMMIT').length, 2); assert(f.state.released);
});

test('source payment reads preserve admin and own scope, malformed IDs, totals validation and original SQL errors', async () => {
  for (const path of ['GET /api/orders/:id/source-payments', 'GET /api/integrations/:id/payment-sync']) {
    const f = fixture();
    await assert.rejects(f.call(path, { actor: { tenantId: own, role: 'viewer' } }), problem(403));
    assert.equal(f.state.connections, 0);
    await assert.rejects(f.call(path, { actor: { tenantId: foreign, role: 'admin' } }), problem(404));
    await assert.rejects(f.call(path, { params: { id: 'bad' } }));
    f.state.failSQL = path.includes('/integrations/') ? 'FROM channels' : 'FROM source_payment_checks';
    await assert.rejects(f.call(path, { params: { id: path.includes('/integrations/') ? channel : order } }), e => e === f.state.failure);
    assert.equal(f.state.writes, 0); assert(f.state.released); assert(f.calls.includes('ROLLBACK'));
  }
  const f = fixture(); f.state.sourceAmount = '-1';
  await assert.rejects(f.call('GET /api/orders/:id/source-payments'), problem(409)); assert.equal(f.state.writes, 0);
});

test('payment record, reverse and source read/apply/configuration mutations retain the writer transaction', async () => {
  const f = fixture();
  for (const path of ['POST /api/orders/:id/payments', 'POST /api/orders/:id/payments/reverse',
    'POST /api/orders/:id/source-payments/read', 'POST /api/source-payment-checks/:id/apply', 'PATCH /api/integrations/:id/payment-sync']) {
    const body = path.includes('/apply') ? { version: 1, confirmed: true }
      : path.startsWith('PATCH') ? { version: 0, enabled: false, interval_seconds: 60 } : {};
    await assert.rejects(f.call(path, { body }), e => e === writer);
  }
  assert.equal(f.state.writes, 5); assert.equal(f.state.connections, 0);
});

test('channel status configuration read preserves local mappings, own config and 10 jobs/25 plans bounds', async () => {
  const f = fixture({ gated: true });
  const result = await f.call('GET /api/integrations/:id/order-status', { params: { id: channel } });
  assert.deepEqual(result.channel, f.sourceChannel);
  assert.deepEqual(result.mappings, { paid: 'processing', picking: 'processing', packed: 'processing', shipped: 'completed', delivered: 'completed', completed: 'completed', cancelled: 'cancelled' });
  assert.deepEqual(result.config, { channel_id: channel, version: '2', enabled: false });
  assert.deepEqual(result.jobs, [{ id: id(22), state: 'done', attempts: 0, stats: { checked: 1 } }]);
  assert.deepEqual(result.data, [{ ...f.plan, number: 'ORD-OWN' }]);
  assert.equal(f.queries.filter(q => q.sql.includes('FROM channels') || q.sql.includes('FROM order_status') || q.sql.includes('FROM jobs')).length, 4);
  assert.equal(f.state.writes, 0); assert.deepEqual(f.calls, ['reserve', 'begin', 'enter', 'COMMIT', 'close', 'release']);
});

test('PrestaShop configuration GET retains optional pure map parsing; scoped denials and mutation writer boundary remain', async () => {
  const path = 'GET /api/integrations/:id/order-status', f = fixture({ provider: 'prestashop' }), req = { params: { id: channel } };
  assert.deepEqual((await f.call(path, req)).mappings, {});
  f.sourceChannel.settings.status_mappings = { paid: '1', picking: '1', packed: '1', shipped: '2', delivered: '2', completed: '2', cancelled: '3' };
  assert.deepEqual((await f.call(path, req)).mappings, f.sourceChannel.settings.status_mappings);
  f.sourceChannel.settings.status_mappings.cancelled = '2';
  assert.deepEqual((await f.call(path, req)).mappings, {});
  const x = fixture();
  await assert.rejects(x.call(path, { ...req, actor: { tenantId: own, role: 'viewer' } }), problem(403));
  assert.equal(x.state.connections, 0);
  for (const patch of [{ ...req, actor: { tenantId: foreign, role: 'admin' } }, { params: { id: id(99) } }])
    await assert.rejects(x.call(path, patch), problem(404));
  await assert.rejects(x.call(path, { params: { id: 'bad' } }));
  await assert.rejects(fixture({ provider: 'other' }).call(path, req), problem(404));
  x.state.failSQL = "payload->'stats'";
  await assert.rejects(x.call(path, req), e => e === x.state.failure); assert.equal(x.state.writes, 0);
  await assert.rejects(x.call('PATCH /api/integrations/:id/order-status', { ...req, body: { version: 0, enabled: false } }), e => e === writer);
  assert.equal(x.state.writes, 1);
});
