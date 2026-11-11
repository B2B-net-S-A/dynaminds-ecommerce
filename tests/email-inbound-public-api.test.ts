import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { publicApiDocument } from '../server/developer-api';
import { pool } from '../server/db';
after(() => pool.end());
test('public inbound API describes full explicit consent, compound scopes and readonly recovery', () => {
  const doc: any = publicApiDocument(),
    copy: any = publicApiDocument({ readOnly: true, port: 4110 });
  for (const path of [
    '/email-inbound/accounts',
    '/email-inbound/previews/{id}/import',
    '/email-inbound/messages/{id}/bind',
    '/email-inbound/messages/{id}/reply-previews',
    '/email-inbound/reply-previews/{id}/queue',
  ]) {
    const op = doc.paths[path].post;
    assert(op.requestBody.required);
    assert.equal(op.requestBody.content['application/json'].schema.additionalProperties, false);
    assert(op['x-required-scopes'].includes('communications:read'));
    assert(op['x-required-scopes'].includes('communications:write'));
    assert(op.responses['423']);
    assert(!copy.paths[path]?.post);
  }
  assert(
    doc.paths['/email-inbound/accounts'].post['x-required-scopes'].includes('integrations:write'),
  );
  assert(
    doc.paths['/email-inbound/messages/{id}/bind'].post['x-required-scopes'].includes(
      'orders:read',
    ),
  );
  const reply =
    doc.paths['/email-inbound/messages/{id}/reply-previews'].post.requestBody.content[
      'application/json'
    ].schema;
  assert(!reply.properties.template_id);
  assert(reply.required.includes('recipient'));
  assert(copy.paths['/email-inbound/messages/{id}'].get);
  assert.equal(
    doc.paths['/email-inbound/messages'].get.parameters.find((p: any) => p.name === 'limit').schema
      .maximum,
    50,
  );
  const file = doc.paths['/email-inbound/messages/{id}/attachments/{index}/content'].get;
  assert.equal(file.parameters.find((p: any) => p.name === 'index').schema.maximum, 9);
  assert(file.parameters.some((p: any) => p.name === 'workspace_id' && p.required));
  const content = file.responses['200'].content['application/json'].schema;
  assert(content.required.includes('content_base64'));
  assert.equal(content.properties.content_base64.contentEncoding, 'base64');
  assert.equal(content.properties.bytes.maximum, 2097152);
});
