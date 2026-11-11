import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicApiDocument, publicOperations } from '../server/developer-api';

test('print query transforms cannot break the complete public OpenAPI document', () => {
  const doc = publicApiDocument() as any;
  const entries = Object.entries(doc.paths).filter(([p]) => p.includes('/print-jobs/'));
  assert.equal(
    entries.reduce(
      (n, [, v]) =>
        n + Object.keys(v as object).filter((m) => ['get', 'post', 'patch'].includes(m)).length,
      0,
    ),
    32,
  );
  const listing = entries.find(([p]) => p.endsWith('/print-jobs/jobs'))![1] as any;
  assert(
    listing.get.parameters.some(
      (p: any) => p.in === 'query' && p.name === 'cursor' && p.schema.type === 'string',
    ),
  );
  assert(
    listing.get.parameters.some(
      (p: any) => p.in === 'query' && p.name === 'printer_id' && p.schema.type === 'string',
    ),
  );
  const content = entries.find(([p]) => p.endsWith('/jobs/{id}/content'))![1] as any;
  assert(
    content.get.parameters.some(
      (p: any) => p.in === 'header' && p.name === 'X-Print-Lease' && p.required,
    ),
  );
  assert.equal(
    publicOperations.find((o) => o.path === '/print-jobs/jobs/:id/content')?.scope,
    'orders:write',
  );
  const pdf = entries.find(([p]) => p.endsWith('/label-previews/{id}/pdf'))![1] as any;
  assert(
    pdf.get.parameters.some(
      (p: any) =>
        p.in === 'query' && p.name === 'workspace_id' && p.required && p.schema.format === 'uuid',
    ),
  );
  assert(pdf.get.responses['200'].content['application/pdf'].schema.format === 'binary');
  for (const path of [
    '/print-jobs/label-previews/:id/content',
    '/print-jobs/label-previews/:id/pdf',
  ])
    assert.equal(publicOperations.find((o) => o.path === path)?.scope, 'orders:write');
  const cachePdf = entries.find(([p]) => p.endsWith('/label-cache/{id}/pdf'))![1] as any;
  assert(cachePdf.get.parameters.some((p: any) => p.name === 'workspace_id' && p.required));
  assert.equal(cachePdf.get.responses['200'].content['application/pdf'].schema.format, 'binary');
  assert.deepEqual(cachePdf.get['x-required-scopes'], [
    'orders:read',
    'orders:write',
    'documents:read',
  ]);
  assert(cachePdf.get.responses['423']);
  const cacheHistory = entries.find(([p]) =>
    p.endsWith('/shipments/{id}/label-cache/history'),
  )![1] as any;
  assert(cacheHistory.get.parameters.some((p: any) => p.in === 'query' && p.name === 'cursor'));
  assert.deepEqual(cacheHistory.get['x-required-scopes'], ['orders:read']);
  const acquire = entries.find(([p]) => p.endsWith('/shipments/{id}/label-cache'))![1] as any;
  assert(acquire.post.responses['201']);
  assert(acquire.post.responses['200']);
  assert.deepEqual(acquire.post['x-required-scopes'], [
    'orders:read',
    'orders:write',
    'documents:read',
  ]);
  const batchPdf = entries.find(([p]) => p.endsWith('/label-batches/previews/{id}/pdf'))![1] as any;
  assert(batchPdf.get.parameters.some((p: any) => p.name === 'workspace_id' && p.required));
  assert.equal(batchPdf.get.responses['200'].content['application/pdf'].schema.format, 'binary');
  assert.deepEqual(batchPdf.get['x-required-scopes'], ['orders:read', 'orders:write', 'documents:read']);
  assert(batchPdf.get.responses['423']);
  const batchHistory = entries.find(([p]) => p.endsWith('/label-batches/history'))![1] as any;
  assert(batchHistory.get.parameters.some((p: any) => p.name === 'kind' && p.required));
  assert.deepEqual(batchHistory.get['x-required-scopes'], ['orders:read']);
  const batchQueue = entries.find(([p]) => p.endsWith('/label-batches/previews/{id}/queue'))![1] as any;
  assert(batchQueue.post.responses['201'] && batchQueue.post.responses['200']);
  assert.deepEqual(batchQueue.post['x-required-scopes'], ['orders:read', 'orders:write', 'documents:read']);
});
