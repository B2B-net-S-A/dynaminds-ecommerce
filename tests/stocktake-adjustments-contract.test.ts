import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../server/db';
import { publicApiDocument } from '../server/developer-api';

assert.equal(process.env.DYNA_TEST, 'true');
after(async () => { await pool.end(); });

const base = '/stocktake-adjustments';
const reads = ['/options', '/sources/{source_kind}/{id}', '/previews/{id}',
  '/previews/{id}/rows', '/receipts/{id}', '/documents', '/documents/{id}', '/documents/{id}/rows'];
const writes = ['/series', '/previews', '/previews/{id}/post'];

test('public stocktake document contract includes complete read and single-post protocol with source-dependent authority', () => {
  const paths = publicApiDocument().paths as Record<string, any>;
  for (const path of reads) {
    const op = paths[base + path]?.get;
    assert(op, path);
    assert.deepEqual(op['x-required-scopes'], ['inventory:read']);
    assert.deepEqual(op['x-value-required-scopes'], ['purchasing:read']);
    assert.equal(op['x-value-required-role'], 'admin');
    assert.equal(op['x-source-required-scopes'], undefined, 'quantity-only reads remain available with redacted costs');
  }
  const source = paths[base + '/sources/{source_kind}/{id}'].get;
  assert.deepEqual(source.parameters.find((p: any) => p.name === 'source_kind').schema,
    { type: 'string', enum: ['quantity', 'wms'] });
  assert.equal(source['x-active-preview-required-role'], 'admin', 'blind counts must not disclose expected stock');
  for (const path of writes) {
    const op = paths[base + path]?.post;
    assert(op, path);
    assert.deepEqual(op['x-required-scopes'], ['inventory:read', 'inventory:write']);
    assert(op.responses['201'] && op.responses['200'] && op.responses['423'] && op.responses['503']);
    if (path === '/series') assert.equal(op['x-source-required-scopes'], undefined);
    else assert.deepEqual(op['x-source-required-scopes'], { quantity: [], wms: ['purchasing:read', 'purchasing:write'] });
  }
  for (const path of ['/previews/{id}/rows', '/documents/{id}/rows']) {
    const parameters = paths[base + path].get.parameters;
    assert.equal(parameters.find((p: any) => p.name === 'limit').schema.maximum, 100);
    assert(parameters.some((p: any) => p.name === 'cursor'));
  }
  const history = paths[base + '/documents'].get.parameters;
  assert.equal(history.find((p: any) => p.name === 'limit').schema.maximum, 50);
  assert(history.some((p: any) => p.name === 'stocktake_id'));
});

test('restored public contract retains stocktake document and receipt history without publishing mutation routes', () => {
  const doc = publicApiDocument({ readOnly: true, port: 4198 });
  const paths = doc.paths as Record<string, any>;
  for (const path of reads) assert(paths[base + path]?.get, path);
  for (const path of writes) assert.equal(paths[base + path]?.post, undefined, path);
  for (const [path, methods] of Object.entries(paths).filter(([path]) => path.startsWith(base + '/')))
    assert.deepEqual(Object.keys(methods), ['get'], path);
  assert.equal(doc.servers[0].url, 'http://localhost:4198/api/v1');
});
