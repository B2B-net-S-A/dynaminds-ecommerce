import assert from 'node:assert/strict';
/** Test-only preparation for legacy SERIAL domain contracts. No write or retry.
 * Explicit expected_version is untouched, including missing/malformed/stale assertions.
 * Concurrent tests must capture one common version before their barrier instead.
 */
export async function legacySerialOrderStatusPayload(
 readOwnOrder: (orderPath: string) => Promise<any>, statusPath: string, payload: Record<string, any>,
): Promise<Record<string, any>> {
 if (Object.prototype.hasOwnProperty.call(payload, 'expected_version')) return payload;
 assert.match(statusPath, /^(?:\/api(?:\/v1)?)?\/orders\/[^/]+\/status$/);
 const orderPath=statusPath.slice(0,-'/status'.length), orderId=orderPath.slice(orderPath.lastIndexOf('/')+1);
 const response=await readOwnOrder(orderPath);
 const reply=typeof response?.json==='function';
 if(reply) assert.equal(response.statusCode,200,'Version preparation requires an authorized own-order GET');
 const order=reply?response.json():response;
 assert.equal(order?.id,orderId,'Version must belong to this original own order');
 const v=typeof order.version==='string'?order.version:
  Number.isSafeInteger(order.version)?String(order.version):'';
 assert.match(v,/^[1-9][0-9]{0,18}$/);
 assert.equal(v.trim(),v); assert(BigInt(v)<=9223372036854775807n);
 return {...payload,expected_version:v};
}
