/** Actual production replay/enlist/finalizer bodies with controlled transaction ports. No PG or Native acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { transformWithOxc } from 'vite';

const merge = fs.readFileSync(new URL('../server/order-merges.ts', import.meta.url), 'utf8');
const buyer = fs.readFileSync(new URL('../server/buyer-address.ts', import.meta.url), 'utf8');
function section(text, start, end) {
  const a = text.indexOf(start), b = text.indexOf(end, a + start.length);
  assert(a >= 0 && b > a, 'Exact production function boundaries');
  return text.slice(a, b).replace(/^export /, '');
}
const transform = async (s) => (await transformWithOxc(s, 'controlled-merge-replay.ts')).code;
const previewJs = await transform(section(merge, 'export async function createOrderMergePreview(', '\nasync function load('));
const executeJs = await transform(section(merge, 'export async function executeOrderMerge(', '\nexport async function orderMergeHistory('));
const enlistJs = await transform(section(buyer, 'export async function enlistOrderMergeBuyerAddressActorInTx(', '\n/** Same managed MERGE transaction'));
const finalizeJs = await transform(section(buyer, 'export async function finalizeBuyerAddressInTx(', '\nasync function effectiveDeliveryWithInstallationInTx('));
const dutyJs = await transform(section(buyer, 'async function duty(', '\nexport async function enlistOrderMergeBuyerAddressActorInTx('));
const schema = fs.readFileSync(new URL('../server/order-merges-schema.ts', import.meta.url), 'utf8');
const schemaJs = await transform(schema.replace("import { z } from 'zod';", '').replaceAll('export ', ''));
const S = new Function('z', schemaJs + ';return {ORDER_MERGE_LIMITS,orderMergePreviewInput,orderMergeExecuteInput};')(z);
const id = (n) => `${String(n).padStart(8, '0')}-1000-4000-8000-000000000001`;
const actor = Object.freeze({ tenantId: id(1), userId: id(2), role: 'admin' });
const sha = (s) => createHash('sha256').update(s).digest('hex');
const canonical = (v) => JSON.stringify(v);
const ensure = (v, status, message) => { if (!v) throw Object.assign(Error(message), { status }); };

function harness(kind, options = {}) {
  const calls = [], tx = { duties: [] }, authorities = new WeakMap([[actor, { hash: 'actual-request-token-hash' }]]);
  const input = kind === 'preview'
    ? { client_key: id(3), main_order_id: id(4), order_ids_to_merge: [id(5)], merge_mode: 'technical_merge', sum_delivery_costs: false }
    : { client_key: id(3), preview_id: id(6), scope_hash: 'a'.repeat(64), confirmed: true };
  const row = { id: id(7), main_order_id: id(4), target_order_id: id(8), request_hash: options.wrongBody ? 'other-body' : 'exact-body' };
  const expectedOrder = kind === 'preview' ? row.main_order_id : row.target_order_id;
  // The replay duty captures today's state even when the original command is historical.
  const currentFrame = { order: { tenant_id: actor.tenantId, id: expectedOrder, version: '42', status: 'delivered' }, state: { version: '9', enabled: false }, buyer_basis_hash: 'current-basis' };
  const c = { async query(sql, args) {
    if (sql.startsWith('SELECT * FROM order_merge_')) {
      assert.equal(sql, `SELECT * FROM order_merge_${kind === 'preview' ? 'previews' : 'executions'} WHERE client_key=$1`);
      assert.deepEqual(args, [input.client_key]); calls.push('lookup'); return { rows: [row] };
    }
    assert.match(sql, /^SELECT buyer_address_terminal\(/);
    assert.deepEqual(args.slice(0, 6), [actor.tenantId, actor.userId, null, 'actual-request-token-hash', 'admin', true]);
    const [terminal] = JSON.parse(args[6]);
    assert.equal(terminal.order_id, expectedOrder); assert.equal(terminal.order_version, '42');
    assert.equal(terminal.require_policy, false); assert.equal(terminal.eligibility, false);
    calls.push('terminal'); return { rows: [{ ok: true }] };
  } };
  const txs = new WeakMap([[c, tx]]);
  const context = async (client, tenant) => { assert.equal(client, c); assert.equal(tenant, actor.tenantId); return tx; };
  const frame = async (client, tenant, orderId) => { assert.equal(client, c); assert.equal(tenant, actor.tenantId); assert.equal(orderId, expectedOrder); calls.push('current-frame'); return currentFrame; };
  const identity = async (client, a, write, pin = false) => {
    assert.equal(client, c); assert.equal(a, actor); assert.equal(write, true);
    assert.equal(authorities.get(a)?.hash, 'actual-request-token-hash');
    calls.push(pin ? 'identity-pinned' : 'identity-final');
    ensure(!(options.revoked && (!options.late || calls.includes('dto'))), 401, 'request credential revoked');
    return { user_id: a.userId, tenant_id: a.tenantId, account_version: options.changedIdentity && calls.includes('dto') ? '2' : '1' };
  };
  const effective = () => { calls.push('effective'); return { kind: 'address' }; };
  const duty = new Function('context', 'effective', dutyJs + ';return duty;')(context, effective);
  const enlist = new Function('authorities', 'ensure', 'sha', 'canonical', 'identity', 'duty', 'frame', enlistJs + ';return enlistOrderMergeBuyerAddressActorInTx;')(authorities, ensure, sha, canonical, identity, duty, frame);
  const finalizer = new Function('txs', 'drainPublicConstraintsInTx', 'identity', 'context', 'frame', 'ensure', 'canonical', 'effective', 'sha', finalizeJs + ';return finalizeBuyerAddressInTx;')(txs, async (client) => { assert.equal(client, c); calls.push('constraints'); }, identity, context, frame, ensure, canonical, effective, sha);
  const tenantTx = async (tenant, work, opts) => {
    assert.equal(tenant, actor.tenantId); assert.deepEqual(opts, { purchasingAdmission: true });
    calls.push('tx'); const result = await work(c); await finalizer(c); calls.push('commit'); return result;
  };
  const ports = { S, ensure, bounded: (v) => v, early: async (a, write) => { assert.equal(a, actor); assert.equal(write, true); calls.push('early'); }, tenantTx,
    available: async () => calls.push('available'), access: async (client, a, write) => { assert.equal(client, c); assert.equal(a, actor); assert.equal(write, true); calls.push('access'); return { role: 'admin', manage: true }; },
    admission: async () => calls.push('admission'), requestHash: (a, body) => { assert.equal(a, actor); assert.deepEqual(body, input); calls.push('exact-body'); return 'exact-body'; },
    enlistOrderMergeBuyerAddressActorInTx: enlist, localConfig: { encryptionKey: 'a'.repeat(64) }, flags: () => ({ can_read: true }), head: (r) => { assert.equal(r, row); calls.push('dto'); return { id: r.id }; }, writeTx: { purchasingAdmission: true } };
  const fn = new Function(...Object.keys(ports), (kind === 'preview' ? previewJs : executeJs) + `;return ${kind === 'preview' ? 'createOrderMergePreview' : 'executeOrderMerge'};`)(...Object.values(ports));
  return { run: () => fn(actor, input), calls, tx, expectedOrder };
}

for (const kind of ['preview', 'execute']) {
  test(`${kind} exact replay enlists genuine request before DTO and finalizes current archival frame before commit`, async () => {
    const h = harness(kind), result = await h.run();
    assert.equal(result.reused, true); assert.equal(h.tx.duties.length, 1);
    assert.equal(h.tx.duties[0].actor, actor); assert.equal(h.tx.duties[0].orderId, h.expectedOrder);
    assert(h.calls.indexOf('exact-body') < h.calls.indexOf('identity-pinned'));
    assert(h.calls.indexOf('identity-pinned') < h.calls.indexOf('dto'));
    assert(h.calls.indexOf('dto') < h.calls.indexOf('constraints'));
    assert(h.calls.indexOf('identity-final') < h.calls.indexOf('terminal'));
    assert.equal(h.calls.at(-1), 'commit');
  });
  test(`${kind} revoked request refuses before DTO; late revocation or identity change prevents commit`, async () => {
    for (const options of [{ revoked: true }, { revoked: true, late: true }, { changedIdentity: true }]) {
      const h = harness(kind, options); await assert.rejects(h.run(), (e) => [401, 409].includes(e.status));
      assert(!h.calls.includes('commit')); if (!options.late && !options.changedIdentity) assert(!h.calls.includes('dto'));
    }
  });
  test(`${kind} changed original body refuses before custody/identity enlist`, async () => {
    const h = harness(kind, { wrongBody: true }); await assert.rejects(h.run(), (e) => e.status === 409);
    assert.equal(h.tx.duties.length, 0); assert(!h.calls.includes('dto')); assert(!h.calls.includes('commit'));
  });
}
