import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyOrderMergeDelivery209Readback as verify} from './order-merge-delivery209-ordinary-readback.mjs';

const id = n => `${String(n).padStart(8, '0')}-1000-4000-8000-000000000001`;
const tenant = id(1), actor = id(2), source = id(3), target = id(4), receipt = id(5);
const date = '2026-10-18T08:00:00.000Z';
const secretAddress = {recipient_name: 'PRIVATE RECEIVER', street: 'PRIVATE STREET', city: 'PRIVATE CITY', postal_code: '00-001', country: 'PL', phone: '+48123456789'};
function fixture({mode = 'technical_merge', kind = 'address', origin = 'override', enabled = true} = {}) {
  if (kind !== 'address') origin = null;
  const effective = {kind, origin, delivery: kind === 'address' ? {...secretAddress} : null, reason: kind === 'address' ? null : kind === 'unknown' ? 'delivery_kind_unknown' : 'pickup_point_delivery',
    available: true, enabled, policy_version: '8', delivery_version: origin === 'override' ? '5' : '0', delivery_hash: kind === 'address' ? 'a'.repeat(64) : null};
  const main = {id: source, tenant_id: tenant, version: '4', portal_token: 'b'.repeat(48), portal_enabled: true, portal_expires_at: date, effective_delivery: effective};
  const after = mode === 'technical_merge' ? {...structuredClone(main), id: target, version: '1', portal_token: 'c'.repeat(48), effective_delivery: {...structuredClone(effective), enabled: false, policy_version: '1', delivery_version: origin === 'override' ? '1' : '0'}} : {...structuredClone(main), version: '5'};
  const classification = kind === 'unknown' ? 'unknown' : 'operator_confirmed';
  const access = {available: true, read_only: false, can_manage: true, order_version: after.version, policy_version: after.effective_delivery.policy_version,
    enabled: after.effective_delivery.enabled, delivery_kind: kind, classification_origin: classification, delivery_version: after.effective_delivery.delivery_version,
    effective_delivery: structuredClone(effective.delivery), reason: after.effective_delivery.enabled ? null : 'access_disabled', last_change: null};
  const row = {id: receipt, kind: 'merge_inherit', changed: true, created_at: date, before: null, after: structuredClone(effective.delivery),
    before_policy: {enabled: false, delivery_kind: 'unknown', classification_origin: 'unknown'}, after_policy: {enabled: false, delivery_kind: kind, classification_origin: classification}};
  const pages = mode === 'technical_merge' ? [{data: [row], next_cursor: null}] : [{data: [], next_cursor: null}];
  const me = {restore_preview: false, read_only: false, user: {id: actor, tenant_id: tenant, role: 'admin'}};
  const calls = []; let iam = 0, page = 0;
  const input = {expectedSchema: '209_order_merge_delivery_inheritance', mainBefore: main, targetAfter: after, executionId: id(6), previewId: id(7), scopeHash: 'd'.repeat(64), tenantId: tenant, actorId: actor, mergeMode: mode,
    async get(path) {
      calls.push(path);
      if (path === '/api/auth/me') {iam++; return structuredClone(me);}
      assert(path.startsWith('/api/orders/' + after.id + '/buyer-address-'));
      if (path.endsWith('/buyer-address-access')) return structuredClone(access);
      assert(path === '/api/orders/' + after.id + '/buyer-address-history' || path.startsWith('/api/orders/' + after.id + '/buyer-address-history?cursor='));
      return structuredClone(pages[page++]);
    }};
  return {input, main, after, access, row, pages, me, calls, get iam() {return iam;}};
}
const sensitive = ['PRIVATE RECEIVER', 'PRIVATE STREET', 'PRIVATE CITY', '+48123456789', 'b'.repeat(48), 'c'.repeat(48)];
function privateSafe(v) {const text = typeof v === 'string' ? v : JSON.stringify(v); for (const secret of sensitive) assert(!text.includes(secret), 'result/error leaked private value');}
async function refused(f, code) {
  await assert.rejects(verify(f.input), error => {assert.equal(error.code, code); privateSafe(error.message + JSON.stringify(error)); assert.equal(error.cause, undefined); return true;});
}

test('technical public readback preserves override, separate portal policy and honest proof boundaries', async () => {
  const f = fixture(), result = await verify(f.input); assert.equal(result.status, 'VERIFIED_PUBLIC_READBACK');
  assert.equal(result.own_inheritance_receipt_id, receipt); assert.equal(result.fresh_target_portal_token_verified, true); assert.equal(result.edit_optin_not_copied, true);
  for (const field of ['parent_binding_proven', 'public_history_parent_binding_proven', 'history_actor_identity_proven', 'source_classification_origin_before_proven', 'native_acceptance', 'ui_acceptance']) assert.equal(result[field], false);
  assert.equal(result.execution_id, undefined); assert.equal(result.scope_hash, undefined); assert(Object.isFrozen(result)); privateSafe(result);
  assert.deepEqual(f.calls, ['/api/auth/me', '/api/orders/' + target + '/buyer-address-access', '/api/orders/' + target + '/buyer-address-history', '/api/auth/me']);
});
test('classified original address, pickup and unknown each use actual public shape without invented address', async () => {
  for (const shape of [{kind: 'address', origin: 'original'}, {kind: 'pickup_point'}, {kind: 'unknown'}]) {
    const f = fixture(shape); assert.equal((await verify(f.input)).effective_delivery_preserved, true);
    if (shape.kind !== 'address') assert.equal(f.row.after, null);
  }
});
test('into_main preserves sidecar versions and opt-in; no new inheritance receipt is invented', async () => {
  const f = fixture({mode: 'into_main_order'}); f.access.last_change = {created_at: date};
  f.pages[0].data = [{...f.row, id: id(9), kind: 'delivery', before: {...secretAddress}, after_policy: {...f.row.after_policy, enabled: true}}];
  const r = await verify(f.input); assert.equal(r.existing_sidecar_preserved, true); assert.equal(r.own_inheritance_receipt_id, null);
  assert.equal(r.fresh_target_portal_token_verified, false); assert.equal(r.into_main_history_unchanged_proven, false); privateSafe(r);
});
test('private source/address/token drift fails before any GET and does not enter exception diagnostics', async () => {
  for (const [change, code] of [
    [f => {f.after.effective_delivery.delivery.street = 'WRONG SECRET ADDRESS';}, 'EFFECTIVE_DELIVERY_DRIFT'],
    [f => {f.after.effective_delivery.origin = 'original';}, 'EFFECTIVE_DELIVERY_DRIFT'],
    [f => {f.after.portal_token = f.main.portal_token;}, 'TARGET_TOKEN_NOT_FRESH'],
    [f => {f.after.portal_enabled = false;}, 'GENERAL_PORTAL_POLICY_DRIFT'],
    [f => {f.after.portal_expires_at = null;}, 'GENERAL_PORTAL_POLICY_DRIFT'],
    [f => {f.main.portal_expires_at = '2026-10-18T08:00:00.000001Z'; f.after.portal_expires_at = '2026-10-18T08:00:00.000002Z';}, 'GENERAL_PORTAL_POLICY_DRIFT'],
    [f => {f.after.effective_delivery.enabled = true;}, 'INHERITED_SIDECAR_POLICY'],
    [f => {f.after.effective_delivery.delivery_version = '5';}, 'INHERITED_SIDECAR_POLICY'],
    [f => {f.input.expectedSchema = '208_consumer_return_credit_guard_dedup';}, 'INPUT_SCOPE'],
    [f => {f.after.tenant_id = id(99);}, 'ORDER_SCOPE'],
  ]) {const f = fixture(); change(f); await refused(f, code); assert.equal(f.calls.length, 0);}
});
test('into_main does not allow a rotated token, changed opt-in or advanced sidecar version', async () => {
  for (const change of [f => {f.after.portal_token = 'e'.repeat(48);}, f => {f.after.effective_delivery.enabled = false;}, f => {f.after.effective_delivery.policy_version = '9';}, f => {f.after.effective_delivery.delivery_version = '6';}]) {
    const f = fixture({mode: 'into_main_order'}); change(f); await refused(f, 'INTO_MAIN_SIDECAR_DRIFT');
  }
});
test('operator access must agree with fresh target GET and has exact public DTO shape', async () => {
  for (const [change, code] of [
    [f => {f.access.order_version = '2';}, 'ACCESS_VERSION'],
    [f => {f.access.effective_delivery.street = 'WRONG PRIVATE STREET';}, 'ACCESS_ORDER_DRIFT'],
    [f => {f.access.enabled = true;}, 'ACCESS_ORDER_DRIFT'],
    [f => {f.access.delivery_kind = 'pickup_point';}, 'ACCESS_ORDER_DRIFT'],
    [f => {f.access.available = false;}, 'ACCESS_UNAVAILABLE'],
    [f => {f.access.encrypted = 'PRIVATE DATA';}, 'ACCESS_SHAPE'],
    [f => {f.access.last_change = {created_at: date};}, 'FABRICATED_BUYER_CHANGE'],
  ]) {const f = fixture(); change(f); await refused(f, code);}
});
test('fresh technical target requires its single actual merge_inherit, never buyer/access imitation', async () => {
  for (const [change, code] of [
    [f => {f.pages[0].data = [];}, 'TARGET_HISTORY_NOT_OWN_INHERITANCE'],
    [f => {f.row.kind = 'delivery';}, 'TARGET_HISTORY_NOT_OWN_INHERITANCE'],
    [f => {f.pages[0].data.push({...f.row, id: id(99)});}, 'TARGET_HISTORY_NOT_OWN_INHERITANCE'],
    [f => {f.row.changed = false;}, 'INHERIT_RECEIPT_DELIVERY'],
    [f => {f.row.before = {...secretAddress};}, 'INHERIT_RECEIPT_DELIVERY'],
    [f => {f.row.after.street = 'WRONG PRIVATE STREET';}, 'INHERIT_RECEIPT_DELIVERY'],
    [f => {f.row.after_policy.enabled = true;}, 'INHERIT_RECEIPT_POLICY'],
    [f => {f.row.after_policy.classification_origin = 'adapter';}, 'INHERIT_RECEIPT_POLICY'],
    [f => {f.row.execution_id = id(6);}, 'HISTORY_SHAPE'],
  ]) {const f = fixture(); change(f); await refused(f, code);}
});
test('history pagination is read completely and duplicate/repeated cursors fail closed', async () => {
  const f = fixture({mode: 'into_main_order'}); f.pages.splice(0, 1, {data: [f.row], next_cursor: 'actual.opaque+cursor'}, {data: [], next_cursor: null});
  const r = await verify(f.input); assert.equal(r.history_pages, 2); assert(f.calls.some(x => x.endsWith('?cursor=actual.opaque%2Bcursor')));
  const duplicate = fixture(); duplicate.pages.splice(0, 1, {data: [duplicate.row], next_cursor: 'a'}, {data: [duplicate.row], next_cursor: null}); await refused(duplicate, 'HISTORY_DUPLICATE');
  const loop = fixture({mode: 'into_main_order'}); loop.pages.splice(0, 1, {data: [loop.row], next_cursor: 'a'}, {data: [{...loop.row, id: id(99)}], next_cursor: 'a'}); await refused(loop, 'HISTORY_CURSOR');
});
test('IAM is checked on both sides, late role/tenant/restore changes refuse acceptance', async () => {
  for (const mutate of [f => {f.me.user.role = 'viewer';}, f => {f.me.user.id = id(99);}, f => {f.me.user.tenant_id = id(99);}, f => {f.me.restore_preview = true;}, f => {f.me.read_only = true;}]) {
    const f = fixture(), get = f.input.get; f.input.get = async path => {if (path === '/api/auth/me' && f.iam === 1) mutate(f); return get(path);};
    await refused(f, 'CURRENT_IAM'); assert.equal(f.iam, 2);
  }
});
test('decoded input is captured before async reads and GET failures never expose raw errors', async () => {
  const f = fixture(), get = f.input.get;
  f.input.get = async path => {if (path === '/api/auth/me' && f.iam === 0) f.main.portal_token = 'c'.repeat(48); return get(path);};
  assert.equal((await verify(f.input)).fresh_target_portal_token_verified, true);
  const failed = fixture(); failed.input.get = async () => {throw Error(secretAddress.street + ' ' + 'c'.repeat(48));}; await refused(failed, 'IAM_GET_FAILED');
  const malformed = fixture(); Object.defineProperty(malformed.main, 'portal_token', {get() {throw Error(secretAddress.street);}}); await refused(malformed, 'PROTOCOL');
});
test('import has no transport and bounded decoded/history shapes cannot be silently accepted', async () => {
  const budget = fixture(); budget.input.get = async () => ({junk: 's'.repeat(262145)}); await refused(budget, 'GET_DTO_BUDGET');
  const history = fixture(); history.pages[0].data = Array.from({length: 21}, (_, n) => ({...history.row, id: id(n + 100)})); await refused(history, 'HISTORY_SHAPE');
  const shape = fixture(); shape.pages[0].next_cursor = ''; await refused(shape, 'HISTORY_CURSOR');
});
