/** Independent CRM boundary checks through real public parsers; no database or HTTP. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import * as cryptoModule from 'node:crypto';
import { transformSync } from 'esbuild';
import { z } from 'zod';
import { ensure, Problem } from '../server/errors';

const id = (n: number) => `42000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const schemaSource = readFileSync(new URL('../server/crm-schema.ts', import.meta.url), 'utf8');
const source = readFileSync(new URL('../server/crm.ts', import.meta.url), 'utf8');
function evaluate(text: string, ports: Record<string, unknown>) {
  const module = { exports: {} as any };
  const code = transformSync(text, { loader: 'ts', format: 'cjs', target: 'node22' }).code;
  new Function('require', 'module', 'exports', code)((name: string) => {
    assert(Object.hasOwn(ports, name), `Unexpected import: ${name}`);
    return ports[name];
  }, module, module.exports);
  return module.exports;
}
const schema = evaluate(schemaSource, { zod: { z } });
const forbidden = () => assert.fail('These parser checks must not use SQL, encryption or audit');
const crm = evaluate(source, {
  './base-wire-crm-authority': evaluate(readFileSync(new URL('../server/base-wire-crm-authority.ts', import.meta.url), 'utf8'), {'./errors': {ensure}}),
  'node:crypto': cryptoModule,
  zod: { z },
  './db': { tenantTx: forbidden, tenantReadTx: forbidden },
  './domain': { audit: forbidden },
  './security': { encrypt: forbidden, decrypt: forbidden },
  './errors': { ensure },
  './crm-schema': schema,
  './crm-field-definitions': evaluate(readFileSync(new URL('../server/crm-field-definitions.ts',import.meta.url),'utf8'),{zod:{z},'./errors':{ensure}}),
});
const controlled422 = (error: unknown) => error instanceof Problem && error.status === 422;
const field = (editor_type: string, options: string[] = []) => ({ editor_type, options });

test('client partial updates distinguish omission, empty text and numeric zero without changing input', () => {
  const body = { client_key: id(1), version: 3, star: 0, email: '', contractor_id: 0 };
  const before = structuredClone(body);
  const op = crm.parseCrmOperation('PATCH', `/api/crm/clients/${id(2)}`, body);
  assert.equal(op.kind, 'clients.patch');
  assert.equal(op.id, id(2));
  assert.deepEqual(op.body, before);
  assert(!Object.hasOwn(op.body, 'notes'));
  assert(!Object.hasOwn(op.body, 'status_id'));
  assert.deepEqual(body, before);
  assert.throws(() => crm.parseCrmOperation('PATCH', `/api/crm/clients/${id(2)}`, {
    client_key: id(1), version: 3,
  }));
  assert.throws(() => crm.parseCrmOperation('PATCH', `/api/crm/clients/${id(2)}`, {
    ...body, notes: null,
  }));
});

test('dictionary update retains omitted group and rejects client-supplied protection/order flags', () => {
  const body = { client_key: id(3), version: 2, color: '#abcdef' };
  const op = crm.parseCrmOperation('PATCH', `/api/crm/statuses/${id(4)}`, body);
  assert(!Object.hasOwn(op.body, 'group_id'));
  assert(!Object.hasOwn(op.body, 'name'));
  for (const injected of [{ is_primary: false }, { position: 0 }, { tenant_id: id(8) }]) {
    assert.throws(() => crm.parseCrmOperation('PATCH', `/api/crm/statuses/${id(4)}`, {
      ...body, ...injected,
    }));
  }
  assert.throws(() => crm.parseCrmOperation('POST', '/api/crm/status-groups', {
    client_key: id(1), name: 'Forged', is_main_group: true,
  }));
});

test('operational UUIDs use database identity while the original request remains untouched', () => {
  const lower = 'abcdef00-abcd-4000-8000-abcdefabcdef', upper = lower.toUpperCase();
  const body = { client_key: upper, version: 2, target_status_id: lower };
  const before = structuredClone(body);
  const op = crm.parseCrmOperation('DELETE', `/api/crm/statuses/${upper}`, body);
  assert.equal(op.id, lower);
  assert.equal(op.body.target_status_id, lower);
  assert.equal(op.id, op.body.target_status_id);
  assert.deepEqual(body, before);
  const patch = crm.parseCrmOperation('PATCH', `/api/crm/clients/${upper}`, {
    client_key: id(1), version: 2, status_id: upper,
  });
  assert.equal(patch.id, lower);
  assert.equal(patch.body.status_id, lower);
});

test('seven editor types retain their values; explicit empty text clears each type', () => {
  const cases: [string, unknown, string[]?][] = [
    ['text', 'literal <text>'], ['number', 0], ['select', 'Premium', ['Standard', 'Premium']],
    ['checkbox', [], ['E-mail', 'Telefon']], ['radio', 'Telefon', ['E-mail', 'Telefon']],
    ['date', '2024-02-29'],
  ];
  for (const [type, value, options] of cases) {
    assert.deepEqual(crm.validateCrmExtraValue(field(type, options), value), value);
  }
  for (const type of ['text', 'number', 'select', 'checkbox', 'radio', 'date', 'file']) {
    assert.equal(crm.validateCrmExtraValue(field(type), ''), '');
  }
  for (const [type, value] of [['number', '0'], ['checkbox', false], ['checkbox', ['E-mail', 'E-mail']],
    ['select', 'Other'], ['radio', 'Other'], ['text', null]] as const) {
    assert.throws(() => crm.validateCrmExtraValue(field(type, ['E-mail', 'Telefon']), value));
  }
});

test('impossible dates yield controlled refusal rather than leaking RangeError or normalizing dates', () => {
  for (const value of ['2026-99-99', '2026-02-29', '2024-02-30', '2026-00-01', '2026-13-01']) {
    assert.throws(() => crm.validateCrmExtraValue(field('date'), value), controlled422);
  }
  assert.equal(crm.validateCrmExtraValue(field('date'), '2024-02-29'), '2024-02-29');
});

test('file uses the retained title/file-data-prefix contract and canonical base64, never arbitrary URLs', () => {
  const bytes = Buffer.from('%PDF-1.7\nowned CRM attachment');
  const upload = { title: 'agreement.pdf', file: `data:${bytes.toString('base64')}` };
  const before = structuredClone(upload), parsed = crm.parseCrmFile(upload);
  assert.equal(parsed.title, upload.title);
  assert.deepEqual(parsed.bytes, bytes);
  assert.equal(parsed.mime_type, 'application/pdf');
  assert.equal(parsed.sha256, createDigest(bytes));
  assert.deepEqual(upload, before);
  for (const invalid of [
    { title: upload.title, data: upload.file },
    { title: upload.title, file: 'https://example.invalid/file.pdf' },
    { title: upload.title, file: 'data:application/pdf;base64,' + bytes.toString('base64') },
    { title: upload.title, file: 'data:' + bytes.toString('base64').replace(/=/g, '') },
    { title: 'bad\r\nname.pdf', file: upload.file },
    { title: '../file.pdf', file: upload.file },
    { title: 'x'.repeat(41), file: upload.file },
    { title: upload.title, file: 'data:' },
  ]) assert.throws(() => crm.parseCrmFile(invalid));
  for (const [title, bytes] of [
    ['clients.csv', Buffer.from('name,email\nAla,ala@example.test\n')],
    ['archive.zip', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 1, 2, 3])],
    ['page.html', Buffer.from('<script>alert(1)</script>')],
  ] as const) {
    const parsed = crm.parseCrmFile({ title, file: 'data:' + bytes.toString('base64') });
    assert.equal(parsed.mime_type, 'application/octet-stream');
    assert.deepEqual(parsed.bytes, bytes);
    assert.equal(parsed.sha256, createDigest(bytes));
  }
});

function createDigest(bytes: Buffer) {
  // This independently checks bytes returned by the real decoder, not its SQL or storage implementation.
  return cryptoModule.createHash('sha256').update(bytes).digest('hex');
}
test('local declared decimal file limit accepts exactly the limit and rejects the next byte', () => {
  assert.equal(schema.CRM_FILE_MAX_BYTES, 2_000_000);
  const bytes = Buffer.alloc(schema.CRM_FILE_MAX_BYTES, 65);
  Buffer.from('%PDF-').copy(bytes);
  const parsed = crm.parseCrmFile({ title: 'limit.pdf', file: 'data:' + bytes.toString('base64') });
  assert.equal(parsed.bytes.length, 2_000_000);
  const larger = Buffer.concat([bytes, Buffer.from('A')]);
  assert.throws(() => crm.parseCrmFile({ title: 'large.pdf', file: 'data:' + larger.toString('base64') }));
  assert.equal(crm.CRM_POLICY.file_limit_basis, 'LOCAL_DECIMAL_BYTES_NOT_BASE_WIRE');
  assert.equal(crm.CRM_POLICY.scalar_serialization, 'LOCAL_TYPED_JSON_NOT_BASE_WIRE');
});

test('extra fields require explicit detail include; lists reject unsupported include and preserve exact filter values', () => {
  assert.equal(schema.crmDetail.parse({}).include_custom_extra_fields, 'false');
  assert.equal(schema.crmDetail.parse({ include_custom_extra_fields: 'true' }).include_custom_extra_fields, 'true');
  assert.throws(() => schema.crmDetail.parse({ include_custom_extra_fields: true }));
  assert.throws(() => schema.crmList.parse({ include_custom_extra_fields: 'true' }));
  const query = schema.crmList.parse({ page: '2', limit: '100', email: 'part', client_id: id(7) });
  assert.equal(query.page, 2);
  assert.equal(query.limit, 100);
  assert.equal(query.email, 'part');
  assert.equal(query.client_id, id(7));
  assert.throws(() => schema.crmList.parse({ page: 0 }));
  assert.throws(() => schema.crmList.parse({ limit: 101 }));
});

test('operation parser keeps exact method/path boundary and cannot reinterpret a foreign route as a command', () => {
  const body = { client_key: id(1), version: 1 };
  for (const [method, path] of [
    ['GET', '/api/crm/clients'], ['POST', '/api/crm/clients/'],
    ['DELETE', `/api/crm/clients/${id(2)}?x=1`],
    ['DELETE', `/api/crm/clients/${id(2)}/files/${id(3)}`],
    ['POST', `/api/orders/${id(2)}`], ['PATCH', '/api/crm/clients/invalid'],
  ]) assert.throws(() => crm.parseCrmOperation(method, path, body));
});
