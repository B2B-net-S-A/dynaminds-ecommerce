/** Controlled actual helper tests. Synthetic AES-GCM records only; no app, PG, HTTP or Native admission. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { transformWithOxc } from 'vite';
import {
  authenticateOrderMergeDeliverySource,
  captureOrderMergeDeliverySourcesInTx,
  projectOrderMergeDeliverySnapshot,
  createOrderMergeDeliveryInheritanceEvidence,
  readOrderMergeDeliveryInheritanceEvidence,
  authenticateOrderMergeDeliveryInheritanceEvidence,
} from '../server/order-merge-delivery-inheritance';

const id = (n: number) => `${n.toString(16).padStart(8, '0')}-b000-4000-8000-000000000001`;
const tenant = id(1), sourceId = id(2), key = '12'.repeat(32);
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const canonical = (v: any): string => Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']'
  : v !== null && typeof v === 'object' ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}' : JSON.stringify(v);
const clone = <T>(value: T): T => structuredClone(value);
const corrected = {recipient_name: 'Odbiorca prywatny', street: 'Prywatna 27', city: 'Łódź', postal_code: '90-001', country: 'PL', phone: '+48123456789'};
/** Independent producer of the existing166 wire format, not the production encryptor. */
function envelope(value: unknown, options: {key?: string; text?: string} = {}) {
  const text = options.text ?? canonical(value), iv = Buffer.alloc(12, 29);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(options.key ?? key, 'hex'), iv);
  const ciphertext = Buffer.concat([iv, cipher.update(text, 'utf8'), cipher.final()]);
  const bytes = Buffer.concat([ciphertext.subarray(0, 12), cipher.getAuthTag(), ciphertext.subarray(12)]).toString('base64');
  return {delivery_override_encrypted: bytes, override_byte_count: Buffer.byteLength(text), override_sha256: sha(bytes)};
}
function frame(kind: 'address' | 'pickup_point' | 'unknown' = 'address', override: unknown = null): any {
  return {
    order: {id: sourceId, tenant_id: tenant, version: '17', status: 'new', customer_name: 'Odbiorca pierwotny', email: 'original@example.test',
      address: {street: 'Pierwotna 5', city: 'Warszawa', postal_code: '00-001', country: 'PL', phone: ''},
      portal_token: 'ab'.repeat(24), portal_enabled: true, portal_expires_at: '2030-01-01T00:00:00.000Z'},
    state: {version: '4', delivery_version: override === null ? '0' : '2', enabled: kind !== 'unknown', delivery_kind: kind,
      classification_origin: kind === 'unknown' ? 'unknown' : 'operator_confirmed',
      delivery_override_encrypted: null, override_byte_count: null, override_sha256: null, last_receipt_id: id(3),
      ...(override === null ? {} : envelope(override))},
    buyer_basis_hash: sha('synthetic source buyer basis'),
  };
}
function status(value: unknown) { return (value as {status?: number})?.status; }

test('classified original address preserves actual receiver bytes, without assuming valid carrier telephone', () => {
  const input = frame(), before = clone(input);
  const actual = authenticateOrderMergeDeliverySource(input, key);
  assert.deepEqual(actual.effective, {kind: 'address', origin: 'original', reason: null,
    delivery: {recipient_name: 'Odbiorca pierwotny', street: 'Pierwotna 5', city: 'Warszawa', postal_code: '00-001', country: 'PL', phone: ''}});
  assert.deepEqual(Object.keys(actual.snapshot).sort(), ['order_id', 'state', 'buyer_basis_hash', 'effective_kind', 'effective_hash'].sort());
  assert.equal(actual.snapshot.order_id, sourceId); assert.equal(actual.snapshot.effective_kind, 'address');
  assert.equal(actual.snapshot.effective_hash, sha(canonical(actual.effective.delivery)));
  assert.deepEqual(input, before, 'Authentication must not alter source header or policy');
});

test('real AES-GCM override is authenticated and only encrypted state plus digest enters durable source snapshot', () => {
  const input = frame('address', corrected), before = clone(input);
  const {snapshot, effective} = authenticateOrderMergeDeliverySource(input, key);
  assert.equal(effective.origin, 'override'); assert.deepEqual(effective.delivery, corrected);
  assert.equal(snapshot.effective_hash, sha(canonical(corrected)));
  assert.equal(snapshot.state.delivery_override_encrypted, input.state.delivery_override_encrypted);
  const serialized = JSON.stringify(snapshot);
  for (const secret of [...Object.values(corrected), input.order.email, input.order.portal_token]) {
    // Country occurs as syntax elsewhere only if the helper starts storing raw address material.
    if (secret.length > 3) assert(!serialized.includes(secret), 'No plaintext receiver, original email or portal token in stored snapshot');
  }
  assert.deepEqual(input, before);
});

test('unknown and pickup-point classification remain explicit and never become a guessed postal address', () => {
  for (const kind of ['unknown', 'pickup_point'] as const) {
    const input = frame(kind); if (kind === 'pickup_point') input.order.address.locker_code = 'LOD01A';
    const actual = authenticateOrderMergeDeliverySource(input, key);
    assert.deepEqual(actual.effective, {kind, origin: null, delivery: null,
      reason: kind === 'unknown' ? 'delivery_kind_unknown' : 'pickup_point_delivery'});
    assert.equal(actual.snapshot.effective_kind, kind);
    assert.equal(actual.snapshot.effective_hash, null);
  }
});

test('source policy change without orders.version and same raw receiver with different overrides changes frozen scope material', () => {
  const first = frame('address', corrected), changed = clone(first);
  changed.state.version = '5'; changed.state.enabled = false;
  const a = authenticateOrderMergeDeliverySource(first, key).snapshot;
  const b = authenticateOrderMergeDeliverySource(changed, key).snapshot;
  assert.equal(first.order.version, changed.order.version); assert.notEqual(sha(canonical(a)), sha(canonical(b)));
  const other = frame('address', {...corrected, street: 'Inna 19'});
  assert.deepEqual(first.order, other.order);
  const c = authenticateOrderMergeDeliverySource(other, key).snapshot;
  assert.notEqual(a.effective_hash, c.effective_hash);
});

test('one-bit GCM tag/ciphertext tamper is refused even with recomputed public ciphertext hash', () => {
  for (const offset of [12, 28]) {
    const input = frame('address', corrected), bytes = Buffer.from(input.state.delivery_override_encrypted, 'base64');
    bytes[offset] ^= 1; input.state.delivery_override_encrypted = bytes.toString('base64');
    input.state.override_sha256 = sha(input.state.delivery_override_encrypted);
    assert.throws(() => authenticateOrderMergeDeliverySource(input, key), e => status(e) === 503);
  }
});

test('wrong key, envelope byte-count/hash and noncanonical authenticated JSON cannot be accepted', () => {
  const wrong = frame('address', corrected);
  assert.throws(() => authenticateOrderMergeDeliverySource(wrong, '34'.repeat(32)), e => status(e) === 503);
  for (const mutate of [(s: any) => {s.override_byte_count++;}, (s: any) => {s.override_sha256 = '0'.repeat(64);},
    (s: any) => Object.assign(s, envelope(corrected, {text: JSON.stringify(corrected)}))]) {
    const input = frame('address', corrected); mutate(input.state);
    assert.throws(() => authenticateOrderMergeDeliverySource(input, key), e => status(e) === 503);
  }
});

test('authenticated but foreign-country, noncanonical correction or pickup contradiction refuses without echoing private input', () => {
  const examples = [frame('address', {...corrected, country: 'DE'}), frame('address', {...corrected, street: ' Prywatna 27 '}), frame('pickup_point', corrected)];
  const locker = frame('address', corrected); locker.order.address.locker_code = 'LOD01A'; examples.push(locker);
  for (const input of examples) {
    assert.throws(() => authenticateOrderMergeDeliverySource(input, key), e => {
      assert([422, 503].includes(status(e)!));
      const message = String(e); for (const field of [corrected.recipient_name, corrected.street, corrected.phone, input.order.portal_token]) assert(!message.includes(field));
      return true;
    });
  }
});

test('partial override tuples and malformed state identity/version are rejected instead of interpreted as no override', () => {
  for (const change of [
    (f: any) => {f.state.override_sha256 = null;},
    (f: any) => {f.state.override_byte_count = null;},
    (f: any) => {f.state.delivery_override_encrypted = null;},
    (f: any) => {f.state.delivery_kind = 'parcel_address';},
    (f: any) => {f.state.version = '-1';},
    (f: any) => {f.state.last_receipt_id = 'not-an-id';},
    (f: any) => {f.order.tenant_id = 'not-an-id';},
    (f: any) => {f.order.version = '9223372036854775808';},
    (f: any) => {f.buyer_basis_hash = 'not-a-digest';},
  ]) {
    const input = frame('address', corrected); change(input);
    assert.throws(() => authenticateOrderMergeDeliverySource(input, key), 'Malformed source cannot produce a usable scope snapshot');
  }
});

test('actual capture reads exact tenant/order166 state and basis, refuses foreign/duplicate/oversized scopes before SQL', async () => {
  const a = frame('address', corrected), b = frame('pickup_point'); b.order.id = id(20);
  const calls: unknown[][] = [], byId = new Map([a, b].map(f => [f.order.id, f]));
  const c = {async query(sql: string, args: any[]) {
    assert.equal(sql, 'SELECT buyer_address_current_state($1,$2) state,buyer_address_buyer_basis($1,$2) basis');
    assert.equal(args[0], tenant); const f = byId.get(args[1]); assert(f);
    calls.push(clone(args)); return {rows: [{state: clone(f.state), basis: f.buyer_basis_hash}]};
  }} as any;
  const actual = await captureOrderMergeDeliverySourcesInTx(c, tenant, [a.order, b.order], key);
  assert.deepEqual(actual.map(f => [f.order_id, f.effective_kind]), [[sourceId, 'address'], [id(20), 'pickup_point']]);
  assert.deepEqual(calls, [[tenant, sourceId], [tenant, id(20)]]);
  assert.deepEqual(actual, [a, b].map(f => authenticateOrderMergeDeliverySource(f, key).snapshot));
  const noSql = {async query() {assert.fail('Invalid scope must be rejected before SQL');}} as any;
  for (const orders of [[], [a.order, a.order], [{...a.order, tenant_id: id(99)}], Array.from({length: 101}, (_, n) => ({...a.order, id: id(100 + n)}))])
    await assert.rejects(captureOrderMergeDeliverySourcesInTx(noSql, tenant, orders, key), e => status(e) === 503);
  await assert.rejects(captureOrderMergeDeliverySourcesInTx({async query() {return {rows: []};}} as any, tenant, [a.order], key), e => status(e) === 503);
  const malformed = clone(a.state); malformed.override_sha256 = '0'.repeat(64);
  await assert.rejects(captureOrderMergeDeliverySourcesInTx({async query() {return {rows: [{state: malformed, basis: a.buyer_basis_hash}]};}} as any, tenant, [a.order], key), e => status(e) === 503);
});

test('stored source projection authenticates real override but refuses changed digest, classification and source pointer', () => {
  const source = frame('address', corrected), saved = authenticateOrderMergeDeliverySource(source, key).snapshot;
  assert.deepEqual(projectOrderMergeDeliverySnapshot(source.order, clone(saved), key).delivery, corrected);
  for (const mutate of [
    (s: any) => {s.order_id = id(100);},
    (s: any) => {s.effective_hash = '0'.repeat(64);},
    (s: any) => {s.effective_kind = 'pickup_point';},
    (s: any) => {s.extra = true;},
  ]) {
    const changed = clone(saved); mutate(changed);
    assert.throws(() => projectOrderMergeDeliverySnapshot(source.order, changed, key), e => status(e) === 503);
  }
  const otherHeader = {...source.order, address: {...source.order.address, country: 'DE'}};
  assert.throws(() => projectOrderMergeDeliverySnapshot(otherHeader, saved, key), e => status(e) === 503);
});

function inheritance(source = frame('address', corrected)): any {
  return {tenant_id: tenant, execution_id: id(30), merge_preview_id: id(31), scope_hash: sha('original immutable merge scope'), source, target_order_id: id(32)};
}
function asEvidenceEnvelope(value: unknown) {
  const e = envelope(value);
  return {encrypted: e.delivery_override_encrypted, byte_count: e.override_byte_count, sha256: e.override_sha256};
}

test('actual inheritance evidence is encrypted, self-authenticates all classified kinds, and omits portal credentials from its source header', () => {
  for (const source of [frame('unknown'), frame('pickup_point'), frame(), frame('address', corrected)]) {
    const context = inheritance(source), before = clone(context);
    const a = createOrderMergeDeliveryInheritanceEvidence(context, key), b = createOrderMergeDeliveryInheritanceEvidence(context, key);
    assert.deepEqual(Object.keys(a).sort(), ['encrypted', 'byte_count', 'sha256'].sort());
    assert.notEqual(a.encrypted, b.encrypted, 'Fresh AEAD IV, not reuse of a source or previous proof ciphertext');
    for (const value of [corrected.street, corrected.phone, context.source.order.email, context.source.order.portal_token]) assert(!JSON.stringify(a).includes(value));
    const result = authenticateOrderMergeDeliveryInheritanceEvidence(a, context, key);
    assert.deepEqual(readOrderMergeDeliveryInheritanceEvidence(a, key), result);
    assert.equal(result.target_order_id, id(32)); assert.equal(result.source.order.id, sourceId);
    for (const key of ['portal_token', 'portal_enabled', 'portal_expires_at']) assert(!Object.hasOwn(result.source.order, key));
    assert.deepEqual(result.source_effective, authenticateOrderMergeDeliverySource(source, key).effective);
    assert.deepEqual(context, before);
  }
});

test('context substitution and state changes with the same order version cannot reuse an authentic historical proof', () => {
  const expected = inheritance(), e = createOrderMergeDeliveryInheritanceEvidence(expected, key);
  for (const mutate of [
    (v: any) => {v.tenant_id = id(100);},
    (v: any) => {v.execution_id = id(100);},
    (v: any) => {v.merge_preview_id = id(100);},
    (v: any) => {v.scope_hash = '0'.repeat(64);},
    (v: any) => {v.target_order_id = id(100);},
    (v: any) => {v.source.order.id = id(100);},
    (v: any) => {v.source.order.version = '18';},
    (v: any) => {v.source.order.email = 'another@example.test';},
    (v: any) => {v.source.state.version = '5'; v.source.state.enabled = false;},
    (v: any) => {v.source.buyer_basis_hash = '0'.repeat(64);},
  ]) {
    const changed = clone(expected); mutate(changed);
    assert.throws(() => authenticateOrderMergeDeliveryInheritanceEvidence(e, changed, key), e => status(e) === 503);
  }
  const self = inheritance(); self.target_order_id = sourceId;
  assert.throws(() => createOrderMergeDeliveryInheritanceEvidence(self, key), e => status(e) === 503);
});

test('recovery authenticates the encrypted complete proof and recomputes its semantics instead of trusting duplicated hashes or plaintext', () => {
  const expected = inheritance(), e = createOrderMergeDeliveryInheritanceEvidence(expected, key);
  const valid = readOrderMergeDeliveryInheritanceEvidence(e, key);
  for (const mutate of [
    (v: any) => {v.source_effective.delivery.street = 'Podmieniona 44';},
    (v: any) => {v.source_frame.effective_hash = '0'.repeat(64);},
    (v: any) => {v.source_frame.state.enabled = false;},
    (v: any) => {v.source.order.portal_enabled = true;},
    (v: any) => {v.schema = 'unrelated-evidence/v1';},
  ]) {
    // Stored JSON has independent duplicated tuples; do not preserve in-memory aliases.
    const changed = JSON.parse(JSON.stringify(valid)); mutate(changed);
    const authenticatedButInvalid = asEvidenceEnvelope(changed);
    assert.throws(() => readOrderMergeDeliveryInheritanceEvidence(authenticatedButInvalid, key), e => status(e) === 503);
  }
  for (const offset of [12, 28]) {
    const bytes = Buffer.from(e.encrypted, 'base64'); bytes[offset] ^= 1; const encrypted = bytes.toString('base64');
    assert.throws(() => readOrderMergeDeliveryInheritanceEvidence({...e, encrypted, sha256: sha(encrypted)}, key), e => status(e) === 503);
  }
  assert.throws(() => readOrderMergeDeliveryInheritanceEvidence(e, '34'.repeat(32)), e => status(e) === 503);
});

// Source isolation executes the exact production function; importing buyer-address would
// evaluate db/bootstrap. Lexical ports below are controlled, not substitutes for Native209 QA.
const buyerSource = readFileSync(new URL('../server/buyer-address.ts', import.meta.url), 'utf8');
const nativeBegin = buyerSource.indexOf('export async function inheritOrderMergeBuyerAddressInTx(');
const nativeEnd = buyerSource.indexOf('\nexport async function finalizeBuyerAddressInTx(', nativeBegin);
assert(nativeBegin >= 0 && nativeEnd > nativeBegin, 'Actual production native wrapper is present');
const nativeJs = (await transformWithOxc(buyerSource.slice(nativeBegin, nativeEnd).replace(/^export /, ''), 'controlled-merge-inheritance.ts')).code;
function ensure(value: unknown, status: number, message: string): asserts value {if (!value) throw Object.assign(new Error(message), {status});}
function nativeHarness(options: {noAuthority?: boolean; denyIdentityAt?: number; failNative?: boolean; status?: 'new'|'paid'|'picking'|'packed'; portalDisabled?: boolean; patchResult?: (v: any) => void; patchTarget?: (v: any) => void} = {}) {
  const input = inheritance(), actor = Object.freeze({tenantId: tenant, userId: id(40), apiKeyId: id(41), role: 'admin'});
  input.source.order.status = options.status ?? 'new';
  if (options.portalDisabled) {input.source.order.portal_enabled = false; input.source.order.portal_expires_at = null;}
  const credentialHash = sha('synthetic captured credential'), authorities = new WeakMap([[actor, {hash: credentialHash}]]);
  if (options.noAuthority) authorities.delete(actor);
  const target = clone(input.source); target.order.id = input.target_order_id; target.order.version = '1';
  target.order.portal_token = 'cd'.repeat(24);
  Object.assign(target.state, {version: '1', delivery_version: '1', enabled: false, last_receipt_id: id(42)});
  const result = {receipt_id: id(42), preview_id: id(43), target_order_id: input.target_order_id,
    source_order_id: input.source.order.id, source_buyer_basis_hash: input.source.buyer_basis_hash,
    source_state: clone(input.source.state), before_state: {...frame('unknown').state, version: '0', last_receipt_id: null}, after_state: clone(target.state)};
  options.patchResult?.(result); options.patchTarget?.(target);
  const events: string[] = [], calls: any[][] = [], duties: any[][] = []; let identityCalls = 0;
  const c = {async query(sql: string, args: any[]) {
    assert.equal(sql, 'SELECT order_merge_delivery209_inherit($1,$2,$3,$4,$5,$6,$7,$8) proof');
    calls.push(clone(args)); events.push('native');
    if (options.failNative) throw Object.assign(new Error('controlled native refusal'), {status: 409});
    return {rows: [{proof: clone(result)}]};
  }};
  const identityResult = {role: 'admin', scope_ok: true};
  const fn = new Function('ensure', 'authorities', 'context', 'identity', 'createOrderMergeDeliveryInheritanceEvidence', 'frame', 'authenticateOrderMergeDeliverySource', 'effective', 'duty', 'nativeError', 'sha', 'canonical', 'utc', nativeJs + '; return inheritOrderMergeBuyerAddressInTx;')(
    ensure, authorities,
    async (client: unknown, t: string) => {assert.equal(client, c); assert.equal(t, tenant); events.push('context');},
    async (client: unknown, a: unknown, write: boolean, pin: boolean) => {assert.equal(client, c); assert.equal(a, actor); assert.equal(write, true); assert.equal(pin, true); identityCalls++; events.push('iam' + identityCalls); ensure(identityCalls !== options.denyIdentityAt, 403, 'current IAM revoked'); return clone(identityResult);},
    createOrderMergeDeliveryInheritanceEvidence,
    async (client: unknown, t: string, orderId: string) => {assert.equal(client, c); assert.equal(t, tenant); assert.equal(orderId, input.target_order_id); events.push('target'); return clone(target);},
    authenticateOrderMergeDeliverySource,
    (f: any, k: string) => authenticateOrderMergeDeliverySource(f, k).effective,
    async (...args: any[]) => {duties.push(args); events.push('duty');},
    (e: unknown) => {throw e;}, sha, canonical, (value: Date|string) => new Date(value).toISOString(),
  );
  return {fn, c, actor, input, result, target, credentialHash, calls, events, duties, identityResult};
}

test('actual native wrapper pins captured current actor, sends only encrypted evidence, verifies its own target and enlists final IAM duty', async () => {
  const h = nativeHarness(), actual = await h.fn(h.c, h.actor, h.input, key);
  assert.deepEqual(actual, h.result); assert.deepEqual(h.events, ['context', 'iam1', 'native', 'target', 'iam2', 'duty']);
  assert.equal(h.calls.length, 1); const args = h.calls[0];
  assert.deepEqual(args.slice(0, 5), [h.input.execution_id, h.actor.userId, h.actor.apiKeyId, h.credentialHash, 'admin']);
  const proof = authenticateOrderMergeDeliveryInheritanceEvidence({encrypted: args[5], byte_count: args[6], sha256: args[7]}, h.input, key);
  assert.deepEqual(proof.source_effective.delivery, corrected);
  for (const secret of [corrected.street, corrected.phone, h.input.source.order.portal_token]) assert(!JSON.stringify(args).includes(secret));
  assert.equal(h.duties.length, 1);
  const [client, target, usedKey, authority, flags] = h.duties[0];
  assert.equal(client, h.c); assert.equal(target.order.id, h.input.target_order_id); assert.equal(usedKey, key);
  assert.equal(target.state.enabled, false); assert.notEqual(target.state.last_receipt_id, h.input.source.state.last_receipt_id);
  assert.equal(target.order.portal_enabled, h.input.source.order.portal_enabled);
  assert.equal(target.order.portal_expires_at, h.input.source.order.portal_expires_at);
  assert.notEqual(target.order.portal_token, h.input.source.order.portal_token);
  assert.deepEqual(authority, {actor: h.actor, hash: h.credentialHash, write: true, initial: sha(canonical(h.identityResult))});
  assert.deepEqual(flags, {requirePolicy: false});
});

test('all four merge statuses preserve general portal policy but never copy buyer-edit opt-in or portal token', async () => {
  for (const status of ['new', 'paid', 'picking', 'packed'] as const) for (const portalDisabled of [false, true]) {
    const h = nativeHarness({status, portalDisabled}); await h.fn(h.c, h.actor, h.input, key);
    assert.equal(h.calls.length, 1); assert.equal(h.duties.length, 1);
    const target = h.duties[0][1];
    assert.equal(target.order.status, status); assert.equal(target.state.enabled, false);
    assert.equal(target.order.portal_enabled, !portalDisabled);
    assert.equal(target.order.portal_expires_at, h.input.source.order.portal_expires_at);
    assert.notEqual(target.order.portal_token, h.input.source.order.portal_token);
  }
});

test('missing authority, foreign tenant and revoked initial IAM cannot reach Native dispatch', async () => {
  for (const h of [nativeHarness({noAuthority: true}), nativeHarness({denyIdentityAt: 1})]) {
    await assert.rejects(h.fn(h.c, h.actor, h.input, key), e => [401, 403].includes(status(e)!));
    assert.equal(h.calls.length, 0); assert.equal(h.duties.length, 0);
  }
  const h = nativeHarness(); h.input.tenant_id = id(99);
  await assert.rejects(h.fn(h.c, h.actor, h.input, key), e => status(e) === 403);
  assert.equal(h.calls.length, 0); assert.deepEqual(h.events, []);
});

test('mismatched native binding, target receipt/state, opt-in or late revocation refuses without retry or successful duty', async () => {
  const variants = [
    {patchResult: (v: any) => {v.target_order_id = id(99);}},
    {patchResult: (v: any) => {v.source_order_id = id(99);}},
    {patchResult: (v: any) => {v.source_buyer_basis_hash = '0'.repeat(64);}},
    {patchResult: (v: any) => {v.source_state.version = '5';}},
    {patchTarget: (v: any) => {v.state.last_receipt_id = id(99);}},
    {patchTarget: (v: any) => {v.state.enabled = true;}},
    {patchTarget: (v: any) => {v.order.portal_enabled = false;}},
    {patchTarget: (v: any) => {v.order.portal_expires_at = null;}},
    {patchTarget: (v: any) => {v.order.portal_token = 'ab'.repeat(24);}},
    {denyIdentityAt: 2}, {failNative: true},
  ];
  for (const options of variants) {
    const h = nativeHarness(options);
    await assert.rejects(h.fn(h.c, h.actor, h.input, key), e => [403, 409, 503].includes(status(e)!));
    assert.equal(h.calls.length, 1, 'Exactly one original Native invocation, no replay');
    assert.equal(h.duties.length, 0);
  }
});
