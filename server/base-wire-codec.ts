/** Source component only: no route, authentication, HTTP status mapping or retries.
 * Sources: retained base-api-index-20261017.html.gz (decoded SHA256
 * 142d98570834624cf3889b1d7623410dd6f1470441481a55470f6945386cbe58),
 * base-api-client-contracts.v1.json shared_transport/common_error.
 * All ceilings and ambiguous-input refusals below are LOCAL policy, not Base claims.
 */
import { z } from 'zod';
import { Problem } from './errors';

export const BASE_WIRE_LOCAL_LIMITS = Object.freeze({
  requestBytes: 4 * 1024 * 1024,
  responseBytes: 4 * 1024 * 1024,
  depth: 32,
  nodes: 25000,
});
export type BaseWireJson = null | boolean | number | string | BaseWireJson[] | { [key: string]: BaseWireJson };
export type BaseWireRequest = {
  method: string;
  parameters: Record<string, BaseWireJson>;
  /** Deprecated form credential, NOT verified; never include it in responses/logs. */
  legacyToken?: string;
};
const methodName = z.string().min(1).max(128).regex(/^[A-Za-z][A-Za-z0-9]*$/);
const id = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
function refuse(reason: string, status = 400): never {
  // Codes are local diagnostics, deliberately not guessed Base error_code values.
  throw new Problem(status, 'Nieprawidłowa koperta Base API.', 'LOCAL_BASE_WIRE_' + reason);
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
/** Numeric transport safety only. A caller must choose zero/create semantics explicitly. */
export function parseBaseWireId(value: unknown, allowZero: boolean): number {
  const parsed = id.safeParse(value);
  if (typeof allowZero !== 'boolean' || !parsed.success || (!allowZero && parsed.data === 0)) refuse('ID');
  return parsed.data;
}
function copyJson(value: unknown): BaseWireJson {
  const active = new Set<object>();
  let nodes = 0;
  function copy(v: unknown, depth: number): BaseWireJson {
    if (++nodes > BASE_WIRE_LOCAL_LIMITS.nodes || depth > BASE_WIRE_LOCAL_LIMITS.depth) refuse('JSON_LIMIT', 413);
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number') {
      if (!Number.isFinite(v) || (Number.isInteger(v) && !Number.isSafeInteger(v))) refuse('JSON_NUMBER');
      return v;
    }
    if (!Array.isArray(v) && !object(v)) refuse('JSON_VALUE');
    if (active.has(v)) refuse('JSON_CYCLE');
    active.add(v);
    try {
      if (Array.isArray(v)) {
        if (v.length > BASE_WIRE_LOCAL_LIMITS.nodes) refuse('JSON_LIMIT', 413);
        return Array.from({ length: v.length }, (_, n) => {
          const d = Object.getOwnPropertyDescriptor(v, String(n));
          if (!d || !Object.hasOwn(d, 'value')) refuse('JSON_VALUE');
          return copy(d.value, depth + 1);
        });
      }
      const descriptors = Object.getOwnPropertyDescriptors(v);
      return Object.fromEntries(Object.entries(descriptors).map(([key, d]) => {
        if (!d.enumerable || !Object.hasOwn(d, 'value')) refuse('JSON_VALUE');
        return [key, copy(d.value, depth + 1)];
      }));
    } finally { active.delete(v); }
  }
  return copy(value, 0);
}
/** A rounded fraction/underflow must not become an apparently valid integer ID.
 * Node24 JSON source context preserves the original numeric token. */
function exactIntegerToken(token: string, value: number): boolean {
  const m = /^(-?)([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(token);
  if (!m || !Number.isSafeInteger(value)) return false;
  let digits = (m[2] + (m[3] ?? '')).replace(/^0+/, '');
  if (!digits) return value === 0;
  const exponent = Number(m[4] ?? '0') - (m[3]?.length ?? 0);
  if (!Number.isSafeInteger(exponent)) return false;
  if (exponent < 0) {
    const split = digits.length + exponent;
    if (split <= 0 || /[^0]/.test(digits.slice(split))) return false;
    digits = digits.slice(0, split);
  } else {
    if (digits.length + exponent > 16) return false;
    digits += '0'.repeat(exponent);
  }
  return (m[1] + digits) === String(value);
}
function parseParameters(text: string): Record<string, BaseWireJson> {
  let parsed: unknown;
  try {
    const parse = JSON.parse as (text: string, reviver: (key: string, value: unknown, context?: { source?: string }) => unknown) => unknown;
    parsed = parse(text, (_key, value, context) => {
      if (typeof value === 'number' && Number.isInteger(value) &&
          (typeof context?.source !== 'string' || !exactIntegerToken(context.source, value))) refuse('JSON_NUMBER');
      return value;
    });
  } catch (e) { if (e instanceof Problem) throw e; refuse('JSON'); }
  // JSON.parse silently replaces duplicate keys. Reject this ambiguity, including
  // escaped duplicate names, without altering valid original values/omissions.
  const stack: ({ keys: Set<string>; key: boolean } | null)[] = [];
  for (const match of text.matchAll(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]/g)) {
    const token = match[0];
    if (token === '{') stack.push({ keys: new Set(), key: true });
    else if (token === '[') stack.push(null);
    else if (token === '}' || token === ']') stack.pop();
    else {
      const top = stack.at(-1);
      if (token === ',' && top) top.key = true;
      else if (token === ':' && top) top.key = false;
      else if (token.startsWith('"') && top?.key) {
        const key: string = JSON.parse(token);
        if (top.keys.has(key)) refuse('DUPLICATE_JSON_KEY');
        top.keys.add(key);
      }
    }
    if (stack.length > BASE_WIRE_LOCAL_LIMITS.depth) refuse('JSON_LIMIT', 413);
  }
  if (!object(parsed)) refuse('PARAMETERS_OBJECT');
  return copyJson(parsed) as Record<string, BaseWireJson>;
}
/** allowedMethods is a server-owned dispatch allowlist, never request input.
 * This parses credentials only as opaque legacy data: the caller must authenticate
 * X-BLToken/the principal separately. No own REST token is automatically accepted.
 */
export function decodeBaseWireRequest(
  input: { httpMethod: string; contentType: string; body: Buffer },
  allowedMethods: readonly string[],
): BaseWireRequest {
  if (input.httpMethod !== 'POST') refuse('HTTP_METHOD', 405);
  if (!/^application\/x-www-form-urlencoded(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(input.contentType)) refuse('CONTENT_TYPE', 415);
  if (!Buffer.isBuffer(input.body)) refuse('BODY');
  if (input.body.length > BASE_WIRE_LOCAL_LIMITS.requestBytes) refuse('BODY_LIMIT', 413);
  if (!Array.isArray(allowedMethods) || !allowedMethods.length || new Set(allowedMethods).size !== allowedMethods.length || !allowedMethods.every(m => methodName.safeParse(m).success)) refuse('DISPATCH_CONFIGURATION', 503);
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input.body); } catch { refuse('UTF8'); }
  const fields = new Map<string, string>();
  for (const pair of text.split('&')) {
    const at = pair.indexOf('=');
    if (at < 1) refuse('FORM');
    let name: string, value: string;
    try {
      name = decodeURIComponent(pair.slice(0, at).replace(/\+/g, ' '));
      value = decodeURIComponent(pair.slice(at + 1).replace(/\+/g, ' '));
    } catch { refuse('FORM_ENCODING'); }
    if (!['method', 'parameters', 'token'].includes(name)) refuse('FORM_FIELD');
    if (fields.has(name)) refuse('DUPLICATE_FORM_FIELD');
    fields.set(name, value);
  }
  const parsedMethod = methodName.safeParse(fields.get('method'));
  if (!parsedMethod.success || !allowedMethods.includes(parsedMethod.data)) refuse('METHOD');
  const parameters = fields.get('parameters');
  if (parameters === undefined) refuse('PARAMETERS');
  const legacyToken = fields.get('token');
  if (legacyToken !== undefined && (!legacyToken || /[\x00-\x20\x7f]/.test(legacyToken))) refuse('TOKEN');
  return { method: parsedMethod.data, parameters: parseParameters(parameters),
    ...(legacyToken === undefined ? {} : { legacyToken }) };
}
function bytes(value: unknown): Buffer {
  const b = Buffer.from(JSON.stringify(copyJson(value)), 'utf8');
  if (b.length > BASE_WIRE_LOCAL_LIMITS.responseBytes) refuse('RESPONSE_LIMIT', 413);
  return b;
}
export function encodeBaseWireSuccess(payload: Record<string, BaseWireJson>): Buffer {
  if (!object(payload) || ['status', 'error_code', 'error_message'].some(k => Object.hasOwn(payload, k))) refuse('SUCCESS_PAYLOAD');
  const safe = copyJson(payload) as Record<string, BaseWireJson>;
  return bytes({ status: 'SUCCESS', ...safe });
}
/** Error field types/codes/HTTP mapping are undocumented. Accept only explicit
 * JSON values from the future reviewed mapper; never serialize an Error/Problem.
 */
export function encodeBaseWireError(fields: { error_code: BaseWireJson; error_message: BaseWireJson }): Buffer {
  if (!object(fields) || Object.keys(fields).sort().join() !== 'error_code,error_message') refuse('ERROR_FIELDS');
  const safe = copyJson(fields) as typeof fields;
  return bytes({ status: 'ERROR', error_code: safe.error_code, error_message: safe.error_message });
}
