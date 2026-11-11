import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { Problem } from '../server/errors';
import { BASE_WIRE_LOCAL_LIMITS as limits, decodeBaseWireRequest, encodeBaseWireSuccess, encodeBaseWireError, parseBaseWireId } from '../server/base-wire-codec';
const methods = ['addCrmClient', 'getCrmClientData', 'getCrmClients'];
const request = (body: string | Buffer, contentType = 'application/x-www-form-urlencoded', httpMethod = 'POST') =>
  decodeBaseWireRequest({ httpMethod, contentType, body: typeof body === 'string' ? Buffer.from(body) : body }, methods);
const form = (parameters: unknown, method = 'addCrmClient') => new URLSearchParams({ method, parameters: JSON.stringify(parameters) }).toString();
const local = (tag: string, status = 400) => (e: unknown) => e instanceof Problem && e.status === status && e.code === 'LOCAL_BASE_WIRE_' + tag;

// The Base.com index capture is third-party material kept only in local checkouts (tools/parity/base-captures.mjs).
const indexCapture = new URL('../docs/parity/base-api-index-20261017.html.gz', import.meta.url);
const indexCaptureSkip = existsSync(indexCapture) ? false : 'Base.com/BaseLinker documentation capture not in this checkout (third-party material, kept only in local checkouts): docs/parity/base-api-index-20261017.html.gz';
test('local contract is grounded in the retained exact official transport; no implementation acceptance inferred', { skip: indexCaptureSkip }, () => {
  const raw = gunzipSync(readFileSync(indexCapture));
  assert.equal(createHash('sha256').update(raw).digest('hex'), '142d98570834624cf3889b1d7623410dd6f1470441481a55470f6945386cbe58');
  const doc = JSON.parse(readFileSync(new URL('../docs/parity/base-api-client-contracts.v1.json', import.meta.url), 'utf8'));
  assert.equal(doc.shared_transport.http_method, 'POST');
  assert.equal(doc.shared_transport.body_encoding, 'form-url-encoded');
  assert.equal(doc.shared_transport.authentication.recommended_header, 'X-BLToken');
  assert.deepEqual(doc.common_error.status.values, ['SUCCESS', 'ERROR']);
  assert.equal(doc.common_error.error_field_types, 'not_documented');
  assert.equal(doc.common_error.http_statuses, 'not_documented');
  assert.deepEqual(doc.common_error.specific_error_codes, []);
});
test('UTF-8, plus encoding, nested fields and omitted fields round-trip through the actual form decoder', () => {
  const input = { notes: 'Zażółć + & = %', custom_extra_fields: { '7': { title: 'Umowa', file: 'data:A+B/==' } }, star: 0 };
  const parsed = request(form(input), 'Application/X-Www-Form-Urlencoded; charset="UTF-8"');
  assert.equal(parsed.method, 'addCrmClient'); assert.deepEqual(parsed.parameters, input);
  assert.equal(Object.hasOwn(parsed.parameters, 'phone'), false);
  assert.equal(request('method=getCrmClients&parameters=%7B%22login%22%3A%22A+B%22%7D').parameters.login, 'A B');
});
test('deprecated form credential remains opaque, unverified and separate from parameters', () => {
  const parsed = request(form({}) + '&token=controlled-token');
  assert.equal(parsed.legacyToken, 'controlled-token'); assert.deepEqual(parsed.parameters, {});
  assert(!Object.hasOwn(parsed, 'actor')); assert(!Object.hasOwn(parsed, 'authenticated'));
  assert.throws(() => request(form({}) + '&token='), local('TOKEN'));
});
test('HTTP method/content type and the server-owned dispatch allowlist fail closed', () => {
  assert.throws(() => request(form({}), 'application/json'), local('CONTENT_TYPE', 415));
  assert.throws(() => request(form({}), 'application/x-www-form-urlencoded; charset=latin1'), local('CONTENT_TYPE', 415));
  assert.throws(() => request(form({}), undefined, 'GET'), local('HTTP_METHOD', 405));
  for (const name of ['', 'addCrmClient()', 'constructor', 'getOrders']) assert.throws(() => request(form({}, name)), local('METHOD'));
  for (const allowed of [[], ['getCrmClients', 'getCrmClients'], ['getCrmClients()']])
    assert.throws(() => decodeBaseWireRequest({ httpMethod: 'POST', contentType: 'application/x-www-form-urlencoded', body: Buffer.from(form({})) }, allowed), local('DISPATCH_CONFIGURATION', 503));
});
test('malformed/duplicate form fields and invalid raw or escaped UTF-8 refuse without echo', () => {
  for (const suffix of ['&method=addCrmClient', '&%6dethod=addCrmClient', '&parameters=%7B%7D'])
    assert.throws(() => request(form({}) + suffix), local('DUPLICATE_FORM_FIELD'));
  assert.throws(() => request(form({}) + '&extra=secret'), local('FORM_FIELD'));
  assert.throws(() => request(form({}) + '&'), local('FORM'));
  assert.throws(() => request(form({}) + '&token=%GG'), local('FORM_ENCODING'));
  assert.throws(() => request('method=getCrmClients&parameters=%FF'), local('FORM_ENCODING'));
  assert.throws(() => request(Buffer.from([0xff])), local('UTF8'));
});
test('missing/invalid parameters and JSON duplicate keys cannot silently change a command', () => {
  assert.throws(() => request('method=getCrmClients'), local('PARAMETERS'));
  for (const text of ['{', '{"notes":}', '{"notes":"secret"} trailing'])
    assert.throws(() => request('method=getCrmClients&parameters=' + encodeURIComponent(text)), local('JSON'));
  for (const input of [null, [], 1, 'text']) assert.throws(() => request(form(input)), local('PARAMETERS_OBJECT'));
  for (const text of ['{"notes":"first","notes":"second"}', '{"notes":1,"no\\u0074es":2}', '{"x":[{"a":1,"a":2}]}'])
    assert.throws(() => request('method=getCrmClients&parameters=' + encodeURIComponent(text)), local('DUPLICATE_JSON_KEY'));
  assert.deepEqual(request(form({ x: [{ a: 'colon: comma, { }' }, { a: 2 }], a: 1 })).parameters, { x: [{ a: 'colon: comma, { }' }, { a: 2 }], a: 1 });
});
test('own size/depth/node ceilings refuse oversized bodies and excessive parameter structure', () => {
  assert.throws(() => request(Buffer.alloc(limits.requestBytes + 1)), local('BODY_LIMIT', 413));
  let nested: any = {};
  for (let n = 0; n < limits.depth + 1; n++) nested = { nested };
  assert.throws(() => request(form(nested)), local('JSON_LIMIT', 413));
  assert.throws(() => request(form({ values: Array(limits.nodes).fill(0) })), local('JSON_LIMIT', 413));
});
test('integer IDs have explicit zero policy and no string coercion or unsafe-number rounding', () => {
  assert.equal(parseBaseWireId(0, true), 0); assert.equal(parseBaseWireId(1, false), 1);
  assert.equal(parseBaseWireId(Number.MAX_SAFE_INTEGER, false), Number.MAX_SAFE_INTEGER);
  for (const value of [-1, 1.5, '1', null, NaN, Infinity, 9007199254740992, 1n])
    assert.throws(() => parseBaseWireId(value, true), local('ID'));
  assert.throws(() => parseBaseWireId(0, false), local('ID'));
  for (const token of ['9007199254740993', '9007199254740991.1', '1.0000000000000001', '1e-999'])
    assert.throws(() => request('method=getCrmClientData&parameters=' + encodeURIComponent('{"crm_client_id":' + token + '}')), local('JSON_NUMBER'));
  for (const token of ['9007199254740991', '1.0', '1e3', '1.1e1', '0e999'])
    assert.equal(request('method=getCrmClientData&parameters=' + encodeURIComponent('{"crm_client_id":' + token + '}')).parameters.crm_client_id, Number(token));
});
test('success is a flat JSON envelope and cannot override reserved status/error fields', () => {
  assert.deepEqual(JSON.parse(encodeBaseWireSuccess({ crm_client_id: 3, notes: 'Żółć', custom_extra_fields: {} }).toString()),
    { status: 'SUCCESS', crm_client_id: 3, notes: 'Żółć', custom_extra_fields: {} });
  const reserved: Record<string, string>[] = [{ status: 'ERROR' }, { error_code: 'private' }, { error_message: 'private' }];
  for (const payload of reserved)
    assert.throws(() => encodeBaseWireSuccess(payload), local('SUCCESS_PAYLOAD'));
});
test('error serialization requires explicit JSON fields; never forwards Error/Problem or invents provider codes', () => {
  assert.deepEqual(JSON.parse(encodeBaseWireError({ error_code: 'REVIEWED_LOCAL_CODE', error_message: 'Bez szczegółów wewnętrznych' }).toString()),
    { status: 'ERROR', error_code: 'REVIEWED_LOCAL_CODE', error_message: 'Bez szczegółów wewnętrznych' });
  assert.deepEqual(JSON.parse(encodeBaseWireError({ error_code: 17, error_message: null }).toString()), { status: 'ERROR', error_code: 17, error_message: null });
  for (const error of [Error('private SQL/token'), new Problem(500, 'private SQL/token'), { error_code: 'X', error_message: 'Y', stack: 'private' }]) {
    try { encodeBaseWireError(error as any); assert.fail('must refuse'); }
    catch (e) { assert(local('ERROR_FIELDS')(e)); assert(!JSON.stringify(e).includes('private')); }
  }
});
test('non-JSON values/accessors/cycles refuse, shared values and __proto__ keys remain safe data', () => {
  let invoked = 0;
  const getter = Object.defineProperty({}, 'secret', { enumerable: true, get() { invoked++; return 'private'; } });
  for (const value of [getter, Error('private'), { n: undefined }, { n: Infinity }, { n: 1n }])
    assert.throws(() => encodeBaseWireSuccess(value as any));
  assert.equal(invoked, 0);
  const cycle: any = {}; cycle.next = cycle; assert.throws(() => encodeBaseWireSuccess(cycle), local('JSON_CYCLE'));
  assert.throws(() => encodeBaseWireSuccess({ text: 'x'.repeat(limits.responseBytes) }), local('RESPONSE_LIMIT', 413));
  const parsed = request('method=getCrmClients&parameters=' + encodeURIComponent('{"__proto__":{"polluted":true}}'));
  assert.equal(Object.hasOwn(parsed.parameters, '__proto__'), true); assert.equal(({} as any).polluted, undefined);
  const shared = { label: 'same' }; assert.deepEqual(JSON.parse(encodeBaseWireSuccess({ first: shared, second: shared }).toString()), { status: 'SUCCESS', first: shared, second: shared });
});
