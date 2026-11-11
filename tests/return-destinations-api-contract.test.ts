import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { publicApiDocument } from '../server/developer-api';
import { pool } from '../server/db';

after(async () => { await pool.end(); });
const base = '/return-destinations';
test('public intake contract exposes the genuine seven operations and current inventory grants', () => {
  const paths = publicApiDocument().paths;
  const reads = ['/options', '/returns/{id}/source', '/returns/{id}/history', '/previews/{id}', '/operations/{id}'];
  for (const path of reads) {
    const op = paths[base + path].get;
    assert.deepEqual(op['x-required-scopes'], ['orders:read', 'inventory:read']);
    assert(op.responses['503']);
  }
  for (const path of ['/returns/{id}/previews', '/previews/{id}/receive']) {
    const op = paths[base + path].post;
    assert.deepEqual(op['x-required-scopes'], ['orders:read', 'inventory:read', 'orders:write', 'inventory:write']);
    for (const status of ['200', '201', '423', '503']) assert(op.responses[status]);
    assert(op.requestBody.content['application/json'].schema.required.includes('lease_token'));
  }
});
test('history and source use explicit session custody, with no lease token in URLs', () => {
  const paths = publicApiDocument().paths;
  for (const path of ['/returns/{id}/source', '/returns/{id}/history']) {
    const op = paths[base + path].get;
    const session = op.parameters.find((p: any) => p.in === 'query' && p.name === 'session_id');
    assert.equal(session.required, true);
    assert.equal(session.schema.format, 'uuid');
    assert(!op.parameters.some((p: any) => p.name === 'lease_token'));
  }
  const history = paths[base + '/returns/{id}/history'].get;
  assert.equal(history.parameters.find((p: any) => p.name === 'limit').schema.maximum, 50);
});
test('restore contract retains all read operations and omits intake writes', () => {
  const paths = publicApiDocument({ readOnly: true }).paths;
  const intake = Object.entries(paths).filter(([path]) => path.startsWith(base + '/'));
  assert.equal(intake.length, 5);
  for (const [, methods] of intake) {
    assert(methods.get);
    assert.equal(methods.post, undefined);
  }
});
