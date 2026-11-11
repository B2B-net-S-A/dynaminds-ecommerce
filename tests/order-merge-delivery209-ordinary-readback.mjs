/** Import-inert, GET-only public readback. No credentials, writes, fixtures or Native proof. */
const SCHEMA = '209_order_merge_delivery_inheritance';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const ADDRESS = ['recipient_name', 'street', 'city', 'postal_code', 'country', 'phone'];
const POLICY = ['enabled', 'delivery_kind', 'classification_origin'];
const ACCESS = ['available', 'read_only', 'can_manage', 'order_version', 'policy_version', 'enabled', 'delivery_kind', 'classification_origin', 'delivery_version', 'effective_delivery', 'reason', 'last_change'];
const ROW = ['id', 'kind', 'changed', 'created_at', 'before', 'after', 'before_policy', 'after_policy'];
class ReadbackError extends Error {constructor(code) {super('MERGE_DELIVERY_READBACK_' + code); this.code = code;}}
const fail = code => {throw new ReadbackError(code);};
const check = (ok, code) => {if (!ok) fail(code);};
const object = v => !!v && typeof v === 'object' && !Array.isArray(v);
function exact(v, keys, code) {check(object(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k)), code);}
function same(a, b) {
  if (a === b) return true;
  if (!object(a) || !object(b)) return false;
  const keys = Object.keys(a); return keys.length === Object.keys(b).length && keys.every(k => Object.hasOwn(b, k) && same(a[k], b[k]));
}
const version = v => typeof v === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(v) && BigInt(v) <= 9223372036854775807n;
const stamp = v => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(v) && Number.isFinite(Date.parse(v));
function address(v) {
  if (v === null) return;
  exact(v, ADDRESS, 'ADDRESS_SHAPE');
  for (const k of ADDRESS) check(typeof v[k] === 'string' && v[k].length <= ({recipient_name: 800, street: 800, city: 400, postal_code: 80, country: 2, phone: 64}[k]), 'ADDRESS_SHAPE');
  check(/^[A-Z]{2}$/.test(v.country), 'ADDRESS_SHAPE');
}
function policy(v) {exact(v, POLICY, 'POLICY_SHAPE'); check(typeof v.enabled === 'boolean' && ['address', 'pickup_point', 'unknown'].includes(v.delivery_kind) && ['unknown', 'operator_confirmed', 'adapter'].includes(v.classification_origin) && (v.delivery_kind === 'unknown') === (v.classification_origin === 'unknown'), 'POLICY_SHAPE');}
function effective(v) {
  exact(v, ['kind', 'origin', 'delivery', 'reason', 'delivery_version', 'delivery_hash', 'available', 'policy_version', 'enabled'], 'EFFECTIVE_SHAPE');
  check(object(v) && ['address', 'pickup_point', 'unknown'].includes(v.kind) && v.available === true && typeof v.enabled === 'boolean' && version(v.policy_version) && version(v.delivery_version), 'EFFECTIVE_SHAPE');
  check(v.delivery_hash === null || typeof v.delivery_hash === 'string' && SHA.test(v.delivery_hash), 'EFFECTIVE_SHAPE');
  address(v.delivery);
  if (v.kind === 'address') check(['original', 'override'].includes(v.origin) && v.delivery !== null && v.reason === null && typeof v.delivery_hash === 'string', 'EFFECTIVE_SHAPE');
  else check(v.origin === null && v.delivery === null && v.delivery_hash === null && v.reason === (v.kind === 'unknown' ? 'delivery_kind_unknown' : 'pickup_point_delivery'), 'EFFECTIVE_SHAPE');
}
function order(v, tenantId) {
  check(object(v) && UUID.test(v.id) && v.tenant_id === tenantId && version(String(v.version)), 'ORDER_SCOPE');
  check(typeof v.portal_token === 'string' && /^[a-f0-9]{48}$/.test(v.portal_token) && typeof v.portal_enabled === 'boolean' && (v.portal_expires_at === null || stamp(v.portal_expires_at)), 'PORTAL_SHAPE');
  effective(v.effective_delivery);
}
function access(v, o) {
  exact(v, ACCESS, 'ACCESS_SHAPE'); check(v.available === true && v.read_only === false && v.can_manage === true, 'ACCESS_UNAVAILABLE');
  check(version(v.order_version) && v.order_version === String(o.version) && version(v.policy_version) && version(v.delivery_version), 'ACCESS_VERSION');
  policy({enabled: v.enabled, delivery_kind: v.delivery_kind, classification_origin: v.classification_origin}); address(v.effective_delivery);
  check(v.policy_version === o.effective_delivery.policy_version && v.delivery_version === o.effective_delivery.delivery_version && v.enabled === o.effective_delivery.enabled && v.delivery_kind === o.effective_delivery.kind && same(v.effective_delivery, o.effective_delivery.delivery), 'ACCESS_ORDER_DRIFT');
  check(v.reason === null || typeof v.reason === 'string' && v.reason.length <= 200, 'ACCESS_SHAPE');
  if (v.last_change !== null) {exact(v.last_change, ['created_at'], 'ACCESS_SHAPE'); check(stamp(v.last_change.created_at), 'ACCESS_SHAPE');}
}
function row(v) {
  exact(v, ROW, 'HISTORY_SHAPE'); check(UUID.test(v.id) && ['access', 'delivery', 'merge_inherit'].includes(v.kind) && typeof v.changed === 'boolean' && stamp(v.created_at), 'HISTORY_SHAPE');
  address(v.before); address(v.after); policy(v.before_policy); policy(v.after_policy);
}
/** get(path) returns a decoded ordinary authenticated GET DTO; parent retains
 * health/revision, original-command custody, transport bounds and durable sink. */
export async function verifyOrderMergeDelivery209Readback(input) {
  try {return await verify(input);} catch (error) {if (error instanceof ReadbackError) throw error; fail('PROTOCOL');}
}
async function verify(input) {
  exact(input, ['expectedSchema', 'mainBefore', 'targetAfter', 'executionId', 'previewId', 'scopeHash', 'tenantId', 'actorId', 'mergeMode', 'get'], 'INPUT_SHAPE');
  const {expectedSchema, executionId, previewId, scopeHash, tenantId, actorId, mergeMode, get} = input;
  const snapshot = v => structuredClone(Object.fromEntries(['id', 'tenant_id', 'version', 'portal_token', 'portal_enabled', 'portal_expires_at', 'effective_delivery'].map(k => [k, v?.[k]])));
  const main = snapshot(input.mainBefore), target = snapshot(input.targetAfter);
  check(expectedSchema === SCHEMA && [tenantId, actorId, executionId, previewId].every(v => typeof v === 'string' && UUID.test(v)) && typeof scopeHash === 'string' && SHA.test(scopeHash) && ['technical_merge', 'into_main_order'].includes(mergeMode) && typeof get === 'function', 'INPUT_SCOPE');
  order(main, tenantId); order(target, tenantId);
  check((main.id !== target.id) === (mergeMode === 'technical_merge'), 'TARGET_IDENTITY');
  const original = main.effective_delivery, actual = target.effective_delivery;
  check(original.kind === actual.kind && original.origin === actual.origin && original.reason === actual.reason && same(original.delivery, actual.delivery) && original.delivery_hash === actual.delivery_hash, 'EFFECTIVE_DELIVERY_DRIFT');
  check(target.portal_enabled === main.portal_enabled && target.portal_expires_at === main.portal_expires_at, 'GENERAL_PORTAL_POLICY_DRIFT');
  if (mergeMode === 'technical_merge') {
    check(target.portal_token !== main.portal_token, 'TARGET_TOKEN_NOT_FRESH');
    check(actual.enabled === false && actual.policy_version === '1' && actual.delivery_version === (original.origin === 'override' ? '1' : '0'), 'INHERITED_SIDECAR_POLICY');
  } else check(target.portal_token === main.portal_token && actual.enabled === original.enabled && actual.policy_version === original.policy_version && actual.delivery_version === original.delivery_version, 'INTO_MAIN_SIDECAR_DRIFT');
  async function read(path, code) {
    let v; try {v = await get(path);} catch {fail(code);}
    // Bound decoded DTO as a second defensive boundary; never retain or emit it.
    try {check(Buffer.byteLength(JSON.stringify(v)) <= 262144, 'GET_DTO_BUDGET');} catch {fail('GET_DTO_BUDGET');}
    return v;
  }
  async function iam() {
    const me = await read('/api/auth/me', 'IAM_GET_FAILED');
    check(me?.restore_preview === false && me.read_only !== true && me.user?.tenant_id === tenantId && me.user.id === actorId && me.user.role === 'admin', 'CURRENT_IAM');
  }
  await iam();
  const descriptor = await read('/api/orders/' + target.id + '/buyer-address-access', 'ACCESS_GET_FAILED'); access(descriptor, target);
  if (mergeMode === 'technical_merge') check(descriptor.last_change === null && descriptor.reason === 'access_disabled', 'FABRICATED_BUYER_CHANGE');
  const ids = new Set(), cursors = new Set(); let cursor = null, pages = 0, inherited = 0, buyerChanges = 0, accessChanges = 0, receiptId = null;
  do {
    check(pages++ < 100, 'HISTORY_PAGE_BUDGET');
    const page = await read('/api/orders/' + target.id + '/buyer-address-history' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''), 'HISTORY_GET_FAILED');
    exact(page, ['data', 'next_cursor'], 'HISTORY_SHAPE'); check(Array.isArray(page.data) && page.data.length <= 20, 'HISTORY_SHAPE');
    for (const r of page.data) {
      row(r); check(!ids.has(r.id), 'HISTORY_DUPLICATE'); ids.add(r.id);
      if (r.kind === 'delivery') buyerChanges++;
      if (r.kind === 'access') accessChanges++;
      if (r.kind === 'merge_inherit') {
        inherited++; receiptId = r.id;
        if (mergeMode === 'technical_merge') {
          check(r.changed === true && r.before === null && same(r.after, original.delivery), 'INHERIT_RECEIPT_DELIVERY');
          check(same(r.before_policy, {enabled: false, delivery_kind: 'unknown', classification_origin: 'unknown'}) && same(r.after_policy, {enabled: false, delivery_kind: descriptor.delivery_kind, classification_origin: descriptor.classification_origin}), 'INHERIT_RECEIPT_POLICY');
        }
      }
    }
    check(page.next_cursor === null || typeof page.next_cursor === 'string' && page.next_cursor.length > 0 && page.next_cursor.length <= 4096, 'HISTORY_CURSOR');
    if (page.next_cursor !== null) {check(page.data.length > 0 && !cursors.has(page.next_cursor), 'HISTORY_CURSOR'); cursors.add(page.next_cursor);}
    cursor = page.next_cursor;
  } while (cursor !== null);
  if (mergeMode === 'technical_merge') check(inherited === 1 && buyerChanges === 0 && accessChanges === 0 && ids.size === 1, 'TARGET_HISTORY_NOT_OWN_INHERITANCE');
  await iam();
  return Object.freeze({schema: 'dynaminds-order-merge-delivery209-public-readback/v1', status: 'VERIFIED_PUBLIC_READBACK', schema_revision: SCHEMA,
    tenant_id: tenantId, actor_id: actorId, source_order_id: main.id, target_order_id: target.id, merge_mode: mergeMode,
    effective_delivery_preserved: true, general_portal_policy_preserved: true, fresh_target_portal_token_verified: mergeMode === 'technical_merge',
    edit_optin_not_copied: mergeMode === 'technical_merge', existing_sidecar_preserved: mergeMode === 'into_main_order',
    history_rows: ids.size, history_pages: pages, own_inheritance_receipt_id: mergeMode === 'technical_merge' ? receiptId : null,
    parent_binding_proven: false, public_history_parent_binding_proven: false, history_actor_identity_proven: false, source_classification_origin_before_proven: false,
    into_main_history_unchanged_proven: false, native_acceptance: false, ui_acceptance: false});
}
