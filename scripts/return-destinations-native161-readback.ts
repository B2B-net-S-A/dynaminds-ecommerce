/** ROOT ONLY. Read-only supplemental proof after the original verify failed.
 * Never resumes the mutation journal, never posts, never changes its baseline.
 * PostgreSQL JSONB emits microseconds; the pg driver GET emits milliseconds.
 * Only policy-operation created_at is compared at explicit millisecond precision.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, open, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';

const ROOT = '<workspace>/app';
const REV = 'ca1f3e68221e8acdca01a77db0f2ea605d2e009a';
const journal = resolve(ROOT, 'data/return-destinations-native161-flow.json');
const config = resolve(ROOT, '.local.json');
const sha = (v: Buffer | string) => createHash('sha256').update(v).digest('hex');
async function main() {
  assert.equal(process.cwd(), ROOT);
  for (const path of [journal, config]) { const s = await lstat(path); assert(s.isFile() && !s.isSymbolicLink()); assert.equal(s.mode & 0o777, 0o600); }
  const bytes = await readFile(journal), cfg = await readFile(config), state = JSON.parse(bytes.toString()), a = state.actor;
  assert.equal(sha(bytes), process.env.QA161_JOURNAL_SHA256); assert.equal(sha(cfg), process.env.QA161_CONFIG_SHA256);
  assert.equal(state.status, 'FAILED_NO_RESUME'); assert.equal(state.pending, null); assert.equal(state.complete, false);
  assert.deepEqual(state.completed_phases, ['prepare', 'configure']); assert.equal(state.completed.length, 23);
  let gets = 0;
  async function get(path: string): Promise<any> {
    assert(path.startsWith('/') && !path.includes('://'));
    gets++;
    const r = await fetch('http://127.0.0.1:4100/api' + path, { method: 'GET', headers: { cookie: a.cookie, 'X-Workspace-ID': a.tenant_id }, redirect: 'error', signal: AbortSignal.timeout(15000) });
    assert.equal(r.status, 200); return r.json();
  }
  function flags(d: any) { assert.equal(d.available, true); assert.equal(d.read_only, false); assert.equal(d.current_role, 'admin'); assert.equal(d.can_read, true); assert.equal(d.can_manage, true); }
  const health = await get('/health'); assert.equal(health.status, 'ok'); assert.equal(health.revision, REV); assert.equal(health.schema_revision, '147_return_destination_statuses'); assert.equal(health.background_workers_enabled, false); assert.equal(health.restore_preview, false); assert.equal(health.return_destinations_available, false);
  const me = await get('/auth/me'); assert.equal(me.user.id, a.user_id); assert.equal(me.user.tenant_id, a.tenant_id); assert.equal(me.user.role, 'admin');
  const policies = await get('/warehouse-inventory-policies/options?limit=50'); flags(policies); assert.equal(policies.next_cursor, null); assert.equal(policies.warehouses.length, 2);
  const normalized: string[] = [];
  for (const kind of ['sale', 'custody']) {
    const wh = kind === 'sale' ? a.sale_warehouse_id : a.custody_warehouse_id;
    assert.deepEqual(policies.warehouses.find((w: any) => w.id === wh)?.policy, { usage: kind, enabled: true, version: '1' });
    const expected = a.policies[kind].operation, actual = await get('/warehouse-inventory-policies/operations/' + expected.id); flags(actual);
    assert.equal(Date.parse(actual.operation.created_at), Date.parse(expected.created_at));
    assert.deepEqual({ ...actual.operation, created_at: new Date(actual.operation.created_at).toISOString() }, { ...expected, created_at: new Date(expected.created_at).toISOString() });
    normalized.push(kind + '.created_at');
  }
  const statuses = await get('/return-assistant/statuses?limit=50'); flags(statuses); assert.equal(statuses.intake_available, false); assert.equal(statuses.next_cursor, null); assert.equal(statuses.data.length, 3);
  for (const kind of ['sale', 'custody', 'reject']) {
    const op = a.statuses[kind].operation;
    const detail = await get('/return-assistant/statuses/' + op.status_id), history = await get('/return-assistant/statuses/' + op.status_id + '/history?limit=50'), proof = await get('/return-assistant/statuses/operations/' + op.id);
    flags(detail); assert.deepEqual(detail.status, op.after); assert.deepEqual(statuses.data.find((v: any) => v.id === op.status_id), op.after);
    assert.equal(history.next_cursor, null); assert.equal(history.data.length, 1); assert.deepEqual(history.data[0], { id: op.id, preview_id: op.preview_id, status_id: op.status_id, kind: op.kind, version: op.after.version, created_at: op.created_at }); assert.deepEqual(proof.operation, op);
  }
  const product = await get('/products/' + a.product_id), inventory = await get('/inventory?warehouse_id=' + a.custody_warehouse_id + '&limit=50'), bins = await get('/stock-locations?warehouse_id=' + a.custody_warehouse_id + '&limit=50'), orders = await get('/orders?limit=50'), documents = await get('/warehouse-documents?limit=50');
  assert.equal(product.id, a.product_id); assert.equal(product.catalog_id, a.catalog.id); assert.equal(product.stock.length, 1); assert.equal(product.stock[0].warehouse_id, a.custody_warehouse_id); assert.equal(product.stock[0].on_hand, 3); assert.equal(product.stock[0].reserved, 0);
  assert.equal(inventory.meta.cursor, null); assert.equal(inventory.data.length, 1);
  const row = inventory.data[0];
  for (const [k,v] of Object.entries({ product_id: a.product_id, warehouse_id: a.custody_warehouse_id, on_hand: 3, reserved: 0, available: 3, physical_available: 3, sellable_available: 0, inventory_usage: 'custody', inventory_enabled: true, inventory_policy_version: '1' })) assert.equal(row[k], v);
  assert.equal(bins.meta.cursor, null); const own = bins.data.filter((b: any) => b.product_id === a.product_id); assert.equal(own.length, 1); assert.equal(own[0].location, 'QA161-CUSTODY'); assert.equal(own[0].quantity, 3); assert.equal(own[0].reserved, 0);
  assert.equal(orders.meta.cursor, null); assert.equal(orders.data.length, 0); assert.equal(documents.meta.cursor, null); assert.equal(documents.data.length, 1); assert.equal(documents.data[0].id, a.pz.id); assert.equal(documents.data[0].status, 'posted');
  assert.equal((await get('/wms-lots')).policy.enabled, false);
  assert.equal(state.completed.find((r: any) => r.label === 'custody-order-denied').response.status, 409);
  assert.equal(sha(await readFile(journal)), sha(bytes)); assert.equal(sha(await readFile(config)), sha(cfg));
  const report = { stage: 161, status: 'LOCAL_API_SUPPLEMENTAL_READBACK_PASS', runtime_revision: REV, schema_revision: health.schema_revision, tenant_id: a.tenant_id, product_id: a.product_id, custody_warehouse_id: a.custody_warehouse_id, sale_warehouse_id: a.sale_warehouse_id, status_count: 3, policy_count: 2, physical_on_hand: 3, reserved: 0, physical_available: 3, sellable_available: 0, posted_warehouse_documents: 1, own_orders: 0, custody_order_http_status: 409, confirmed_mutation_calls: state.completed.length, known_status_replays: 3, read_only_gets: gets, normalized_policy_timestamp_fields: normalized, timestamp_precision: 'milliseconds, matching pg driver; all other fields exact', original_verify_status: 'FAILED_NO_RESUME', original_journal_unchanged: true, journal_sha256: sha(bytes), config_sha256: sha(cfg), config_preserved: true, provider_requests: 0, intake_available: false, native_ui_verified_here: false, full_goal_complete: false, inventory_readback_sha256: sha(JSON.stringify({ product, inventory, bins, orders, documents })) };
  const out = await open(resolve(ROOT, 'docs/return-destinations-native161-readback.json'), 'wx', 0o644); try { await out.writeFile(JSON.stringify(report, null, 2) + '\n'); await out.sync(); } finally { await out.close(); }
  console.log(JSON.stringify({ status: report.status, read_only_gets: gets, mutations: 0 }));
}
main().catch((e: unknown) => { const at = (e instanceof Error ? e.stack ?? '' : '').match(/return-destinations-native161-readback\.ts:(\d+):(\d+)/); console.error(JSON.stringify({ status: 'READBACK_FAILED', source_line: at ? Number(at[1]) : null, private_details_withheld: true })); process.exitCode = 1; });
