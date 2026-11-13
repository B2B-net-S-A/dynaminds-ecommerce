import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { transformSync } from 'esbuild';

// Actual pg simple-query/result parser and actual getOrder body; no app/config,
// sockets, database, factory or Native admission is instantiated by these tests.
const require = createRequire(import.meta.url);
const Query = require('pg/lib/query');
const pg = require('pg');
const source = readFileSync(new URL('../server/order-detail-rows.ts', import.meta.url), 'utf8');
const domain = readFileSync(new URL('../server/domain.ts', import.meta.url), 'utf8');
const compiled = transformSync(source, { loader: 'ts', target: 'es2022', format: 'cjs' }).code;
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled)(require, module, module.exports);
const { orderDetailRows } = module.exports;
const id = '51c5e9d4-e3ae-4560-bbb2-a34e970bac5f';
const product = '925b93f5-dce5-4a96-9020-e04e9557dc22';
const fields = [['id', 2950], ['quantity', 23], ['big', 20], ['detail', 3802], ['created_at', 1184]];
function parseResults(text, rows, descriptors = rows.map(() => fields)) {
  let result;
  const q = new Query(text, (error, value) => { assert.ifError(error); result = value; });
  const sent = [];
  assert.equal(q.requiresPreparation(), false);
  assert.equal(q.submit({ parsedStatements: {}, submittedNamedStatements: {}, query: sql => sent.push(sql) }), null);
  assert.deepEqual(sent, [text]);
  rows.forEach((set, index) => {
    q.handleRowDescription({ fields: descriptors[index].map(([name, dataTypeID]) => ({ name, dataTypeID, format: 'text' })) });
    for (const fields of set) q.handleDataRow({ fields });
    q.handleCommandComplete({ text: `SELECT ${set.length}` }, {});
  });
  q.handleReadyForQuery({});
  return result;
}
const typedRow = [id, '3', '9223372036854775807', '{"lines":[1,2],"active":true}', '2026-10-16 10:00:00+00'];
function result(rows) { return { command: 'SELECT', rows, rowCount: rows.length }; }
function makeGetOrder(deps) {
  // getOrder delegates to hydrateOrder(c,id,undefined,true); evaluate both actual bodies.
  const start = domain.indexOf('async function hydrateOrder('), end = domain.indexOf('export async function createOrder(');
  assert(start >= 0 && end > start, 'actual hydrateOrder/getOrder source delimiters');
  const actual = domain.slice(start, end);
  assert(actual.length > 1000 && actual.includes('export async function getOrder('));
  const body = transformSync(actual.replace('export ', ''), { loader: 'ts', target: 'es2022', format: 'cjs' }).code;
  return new Function(...Object.keys(deps), `${body};return getOrder;`)(...Object.values(deps));
}
function harness({ exists = true, enabled = false, workflow = false, failQuery } = {}) {
  const calls = [], sql = [];
  const order = { id, tenant_id: 'tenant', workflow_status_id: workflow ? id : null, created_at: new Date('2026-10-16T10:00:00Z') };
  const sets = [result(exists ? [order] : []), result([{ sku: 'A', quantity: 3 }]), result([{ product_id: product }]), result([{ product_id: product, location: 'A-01', quantity: 3 }, { product_id: 'other', location: 'B' }]), result([{ kind: 'created' }]), result([{ mode: 'demo' }]), result([{ kind: 'invoice' }])];
  const c = { query: async (text, values) => {
    sql.push({ text, values });
    if (sql.length === 1) { assert.equal(values, undefined); if (failQuery) throw failQuery; return sets; }
    if (text.includes('workflow_statuses')) return result([{ id, name: 'Nowe' }]);
    if (text.includes('invoice_plans')) return result([{ id }]);
    if (text.includes('shipping_plans')) return result([]);
    throw Error('unexpected query');
  } };
  const fn = (name, value) => async (...args) => { assert.equal(args[0], c); calls.push(name); return value; };
  const unexpected = name => async () => assert.fail('getOrder must not use the ' + name);
  const getOrder = makeGetOrder({ orderDetailRows, ensure: (ok, status, message) => { if (!ok) throw Object.assign(Error(message), { status }); }, wmsLotsPolicyInTx: fn('wms-policy', { enabled }), effectiveDeliveryForOrderReadInTx: fn('delivery', { country: 'PL' }), effectiveDeliveryInTx: unexpected('legacy delivery read'), effectiveDeliveryForCreatedOrderInTx: unexpected('createOrder installation read'), localConfig: { encryptionKey: 'test-only' }, orderMergeClaimInTx: fn('merge', null), b2bDropshipOrderScopeInTx: fn('dropship', null), returnOverview: fn('returns', []), replacedLabelsInTx: fn('replaced-labels', []), paymentBalance: fn('payment', { due: 0 }), orderSectionsInTx: fn('sections', { section_values: { extra: { note: '' } } }), orderWithStageInTx: async (cx, card) => { assert.equal(cx, c); calls.push('stage'); return { ...card, fulfilment_stage: 'packed', payment_state: 'paid' }; } });
  return { c, getOrder, sets, sql, calls, order };
}

test('actual pg simple-query returns all seven independently typed rowsets', async () => {
  let calls = 0;
  const c = { query: async text => { calls++; return parseResults(text, Array.from({ length: 7 }, () => [typedRow])); } };
  const rows = await orderDetailRows(c, id);
  assert.equal(calls, 1);
  for (const set of Object.values(rows)) {
    assert.equal(set.rows[0].quantity, 3);
    assert.equal(set.rows[0].big, '9223372036854775807');
    assert.deepEqual(set.rows[0].detail, { lines: [1, 2], active: true });
    assert(set.rows[0].created_at instanceof Date);
    assert.equal(set.rows[0].created_at.toISOString(), '2026-10-16T10:00:00.000Z');
  }
});

test('same SELECT order, allocation join/predicate and ordering as existing reads', async () => {
  let sql;
  await orderDetailRows({ query: async text => { sql = text; return Array.from({ length: 7 }, () => result([])); } }, id);
  const parts = sql.trim().split(';').map(s => s.trim()).filter(Boolean);
  assert.equal(parts.length, 7);
  const key = `${pg.escapeLiteral(id)}::uuid`;
  assert.deepEqual(parts, [
    `SELECT * FROM orders WHERE id=${key}`,
    `SELECT * FROM order_items WHERE order_id=${key} ORDER BY sku`,
    `SELECT * FROM order_pick_items WHERE order_id=${key} ORDER BY sku`,
    `SELECT a.*,r.state FROM reservation_locations a JOIN reservations r USING(tenant_id,order_id,product_id,warehouse_id) WHERE a.order_id=${key} AND (NULL::uuid IS NULL OR a.product_id=NULL::uuid) ORDER BY a.product_id,a.location`,
    `SELECT * FROM order_events WHERE order_id=${key} ORDER BY created_at,id`,
    `SELECT * FROM shipments WHERE order_id=${key}`,
    `SELECT * FROM documents WHERE order_id=${key} ORDER BY created_at`,
  ]);
  const allocations = readFileSync(new URL('../server/stock-locations.ts', import.meta.url), 'utf8');
  assert(allocations.includes(parts[3].replaceAll(key, '$1').replace('(NULL::uuid IS NULL OR a.product_id=NULL::uuid)', '($2::uuid IS NULL OR a.product_id=$2)')));
});

test('SQL literal escaping keeps hostile values within seven quoted UUID casts', async () => {
  for (const hostile of ["x';COMMIT;--", "x\\'; SELECT 1;--", "'\n$$;SET ROLE postgres;$$", 'ą😀']) {
    let sql;
    await orderDetailRows({ query: async text => { sql = text; return Array.from({ length: 7 }, () => result([])); } }, hostile);
    // Removing each independently encoded complete literal leaves only fixed SQL.
    const fixed = sql.replaceAll(`${pg.escapeLiteral(hostile)}::uuid`, 'UUID_LITERAL');
    assert.equal(fixed.split(';').length - 1, 7);
    assert(!fixed.includes(hostile));
    assert(!/COMMIT|SET ROLE|SELECT 1/.test(fixed));
  }
});

for (const enabled of [false, true]) for (const workflow of [false, true]) {
  test(`actual getOrder keeps DTO and later guards enabled=${enabled}, workflow=${workflow}`, async () => {
    const h = harness({ enabled, workflow });
    const out = await h.getOrder(h.c, id);
    assert.deepEqual(out, { ...h.order, effective_delivery: { country: 'PL' }, merge_claim: null, dropshipping: null, ...(enabled ? { wms_lots_enabled: true } : {}), workflow_status: workflow ? { id, name: 'Nowe' } : null, invoice_committed: true, shipping_active: false, items: [{ sku: 'A', quantity: 3 }], picking_items: [{ product_id: product, locations: [{ product_id: product, location: 'A-01', quantity: 3 }] }], events: [{ kind: 'created' }], shipments: [{ mode: 'demo' }], replaced_labels: [], documents: [{ kind: 'invoice' }], returns: [], payment: { due: 0 }, section_values: { extra: { note: '' } }, fulfilment_stage: 'packed', payment_state: 'paid' });
    assert.deepEqual(h.calls, ['wms-policy', 'delivery', 'merge', 'dropship', 'replaced-labels', 'returns', 'payment', 'sections', 'stage']);
    assert.equal(h.sql.length, workflow ? 4 : 3);
    assert(out.created_at instanceof Date);
  });
}

test('missing order keeps 404 and does not run any later guards', async () => {
  const h = harness({ exists: false });
  await assert.rejects(h.getOrder(h.c, id), { status: 404 });
  assert.equal(h.sql.length, 1);
  assert.deepEqual(h.calls, []);
});

test('SQL failure remains the original error and no later work runs', async () => {
  const failure = Object.assign(Error('modeled SQL failure'), { code: '57014' });
  const h = harness({ failQuery: failure });
  await assert.rejects(h.getOrder(h.c, id), error => error === failure);
  assert.equal(h.sql.length, 1);
  assert.deepEqual(h.calls, []);
});

test('partial, reordered-command and malformed result shapes fail closed', async () => {
  for (const wrong of [result([]), [], Array.from({ length: 6 }, () => result([])), Array.from({ length: 8 }, () => result([])), [...Array.from({ length: 6 }, () => result([])), { command: 'UPDATE', rows: [] }], [...Array.from({ length: 6 }, () => result([])), { command: 'SELECT', rows: null }]]) {
    await assert.rejects(orderDetailRows({ query: async () => wrong }, id), /order-detail-complete-rowsets/);
  }
});
