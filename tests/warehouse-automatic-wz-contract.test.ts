/** Source-authored contract tests. Only root executes; no provider or database fixture. */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool } from '../server/db';
import { publicApiDocument } from '../server/developer-api';
import {
  automaticWzPreviewInput, automaticWzCommitInput,
  automaticWzPageQuery, automaticWzHistoryQuery,
} from '../server/warehouse-automatic-wz-schema';

assert.equal(process.env.DYNA_TEST, 'true');
after(async () => { await pool.end(); });

type Schema = {
  type?: string; format?: string; pattern?: string; const?: unknown; enum?: unknown[];
  minimum?: number; maximum?: number; minLength?: number; maxLength?: number;
  default?: unknown; required?: string[]; additionalProperties?: boolean;
  properties?: Record<string, Schema>;
};
type Parameter = { name: string; in: string; required: boolean; schema: Schema };
type Operation = {
  description: string; parameters: Parameter[];
  responses: Record<string, unknown>;
  requestBody?: { required: boolean; content: { 'application/json': { schema: Schema } } };
  'x-required-scopes': string[]; 'x-issuer-available'?: boolean; 'x-issuer-availability-path': string;
};
type Paths = Record<string, { get?: Operation; post?: Operation }>;
const base = '/warehouse-automatic-wz';
const reads = ['/options', '/previews/{id}', '/operations/{id}', '/history'];
const writes = ['/warehouses/{id}/previews', '/previews/{id}/commit'];
const document = () => publicApiDocument();
function operation(paths: Paths, suffix: string, method: 'get'|'post') {
  const op = paths[base + suffix]?.[method]; assert(op, `${method} ${suffix}`); return op;
}
function body(op: Operation) {
  assert(op.requestBody); assert.equal(op.requestBody.required, true);
  return op.requestBody.content['application/json'].schema;
}
function parameter(op: Operation, name: string, where = 'query') {
  const found = op.parameters.find(p => p.name === name && p.in === where); assert(found, name); return found;
}
function keys(schema: Schema, expected: string[]) {
  assert.equal(schema.type, 'object'); assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), [...expected].sort());
  assert.deepEqual([...(schema.required ?? [])].sort(), [...expected].sort());
}

test('167 documents exactly four reads and two configuration commands on public v1 without claiming an issuer', () => {
  const doc = document(), paths: Paths = doc.paths;
  assert.equal(doc.servers[0].url, 'http://127.0.0.1:4100/api/v1');
  const family = Object.entries(paths).filter(([path]) => path.startsWith(base + '/'));
  assert.equal(family.length, 6);
  assert.deepEqual(family.flatMap(([path, methods]) => Object.keys(methods).map(m => m + ' ' + path)).sort(),
    [...reads.map(p => 'get ' + base + p), ...writes.map(p => 'post ' + base + p)].sort());
  for (const path of reads) {
    const op = operation(paths, path, 'get');
    assert.deepEqual(op['x-required-scopes'], ['inventory:read']);
    assert.equal(op['x-issuer-available'], undefined);
    assert.equal(op['x-issuer-availability-path'], base + '/options');
    assert(op.responses['503']);
    assert.match(op.description, /jednej systemowej serii WZ na magazyn/);
    assert.match(op.description, /bez ruchów towaru, nadania numeru lub wystawienia WZ/);
    assert.match(op.description, /issuer_available odpowiedzi odzwierciedla obecność kompletnego wystawcy/);
  }
  for (const path of writes) {
    const op = operation(paths, path, 'post');
    assert.deepEqual(op['x-required-scopes'], ['inventory:read', 'inventory:write']);
    assert.match(op.description, /aktualnej roli admin/);
    assert.equal(op['x-issuer-available'], undefined, 'static OpenAPI cannot assert runtime issuer availability');
    assert.equal(op['x-issuer-availability-path'], base + '/options');
    for (const status of ['200', '201', '409', '423', '503']) assert(op.responses[status], status);
  }
  for (const path of ['/series', '/dispatch', '/emit', '/documents']) assert.equal(paths[base + path], undefined, 'No free series or unfinished emitter endpoint');
});

test('167 OpenAPI exposes exact strict preview settings, CAS version and separate confirmed commit proof', () => {
  const paths: Paths = document().paths;
  const preview = body(operation(paths, writes[0], 'post'));
  keys(preview, ['client_key', 'expected_version', 'settings']);
  assert.equal(preview.properties!.client_key.format, 'uuid');
  assert.equal(preview.properties!.expected_version.type, 'string');
  assert.equal(preview.properties!.expected_version.pattern, '^(0|[1-9][0-9]{0,18})$');
  const settings = preview.properties!.settings;
  keys(settings, ['enabled', 'moment', 'series_name', 'prefix']);
  assert.equal(settings.properties!.enabled.type, 'boolean');
  assert.equal(settings.properties!.moment.const, 'physical_dispatch');
  assert.equal(settings.properties!.series_name.minLength, 2); assert.equal(settings.properties!.series_name.maxLength, 80);
  assert.equal(settings.properties!.prefix.pattern, '^[A-Z0-9][A-Z0-9_-]{1,23}$');
  const commit = body(operation(paths, writes[1], 'post'));
  keys(commit, ['client_key', 'scope_hash', 'confirmed']);
  assert.equal(commit.properties!.client_key.format, 'uuid');
  assert.equal(commit.properties!.scope_hash.pattern, '^[a-f0-9]{64}$');
  assert.equal(commit.properties!.confirmed.const, true);
  for (const path of [...reads.filter(p => p.includes('{id}')), ...writes]) {
    const op = operation(paths, path, writes.includes(path) ? 'post' : 'get');
    const id = parameter(op, 'id', 'path'); assert.equal(id.required, true); assert.equal(id.schema.format, 'uuid');
  }
});

test('167 query documentation bounds options/history and keeps own warehouse selection explicit', () => {
  const paths: Paths = document().paths;
  for (const path of ['/options', '/history']) {
    const op = operation(paths, path, 'get');
    const limit = parameter(op, 'limit'); assert.equal(limit.schema.minimum, 1); assert.equal(limit.schema.maximum, 50); assert.equal(limit.schema.default, 50);
    assert.equal(parameter(op, 'cursor').schema.format, 'uuid');
    assert.equal(parameter(op, 'cursor').required, false);
    assert(!op.parameters.some(p => ['tenant_id', 'actor_id', 'api_key_id'].includes(p.name)));
  }
  const history = operation(paths, '/history', 'get');
  assert.equal(parameter(history, 'warehouse_id').schema.format, 'uuid');
  assert.deepEqual(parameter(history, 'kind').schema.enum, ['preview', 'operation']);
  assert.equal(parameter(history, 'kind').schema.default, 'operation');
  assert.deepEqual(operation(paths, '/options', 'get').parameters.map(p => p.name).sort(), ['cursor', 'limit']);
  assert.deepEqual(history.parameters.map(p => p.name).sort(), ['cursor', 'kind', 'limit', 'warehouse_id']);
});

test('167 actual input parsers reject unconfirmed, unversioned, hidden-principal and unsupported scheduling commands', () => {
  const preview = { client_key: randomUUID(), expected_version: '0', settings: { enabled: true, moment: 'physical_dispatch', series_name: 'Own WZ', prefix: 'OWN-WZ' } };
  assert.equal(automaticWzPreviewInput.safeParse(preview).success, true);
  for (const bad of [
    { ...preview, expected_version: 0 }, { ...preview, expected_version: '01' },
    { ...preview, expected_version: '-1' }, { ...preview, expected_version: '9223372036854775807' },
    { ...preview, expected_version: 'invalid' }, { ...preview, tenant_id: randomUUID() },
    { ...preview, actor_id: randomUUID() }, { ...preview, api_key_id: randomUUID() },
    { ...preview, settings: { ...preview.settings, moment: 'order_completed' } },
    { ...preview, settings: { ...preview.settings, series_id: randomUUID() } },
    { ...preview, settings: { ...preview.settings, series_name: 'Bad\uD800' } },
    { ...preview, settings: { ...preview.settings, enabled: 'true' } },
  ]) assert.equal(automaticWzPreviewInput.safeParse(bad).success, false);
  const commit = { client_key: randomUUID(), scope_hash: 'a'.repeat(64), confirmed: true };
  assert.equal(automaticWzCommitInput.safeParse(commit).success, true);
  for (const bad of [{ ...commit, confirmed: false }, { ...commit, confirmed: 'true' },
    { client_key: commit.client_key, scope_hash: commit.scope_hash }, { ...commit, scope_hash: 'a'.repeat(63) },
    { ...commit, scope_hash: 'A'.repeat(64) }, { ...commit, client_key: 'not-uuid' },
    { ...commit, skip: true }, { ...commit, warehouse_id: randomUUID() }])
    assert.equal(automaticWzCommitInput.safeParse(bad).success, false);
  for (const bad of [{ limit: '0' }, { limit: '51' }, { cursor: 'other' }, { page: '1' }, { tenant_id: randomUUID() }])
    assert.equal(automaticWzPageQuery.safeParse(bad).success, false);
  for (const bad of [{ kind: 'document' }, { warehouse_id: 'other' }, { limit: '51' }, { actor_id: randomUUID() }])
    assert.equal(automaticWzHistoryQuery.safeParse(bad).success, false);
});

test('167 restored OpenAPI retains complete GET contract and hides both configuration writers', () => {
  const doc = publicApiDocument({ readOnly: true, port: 4198 }), paths: Paths = doc.paths;
  assert.equal(doc.servers[0].url, 'http://localhost:4198/api/v1');
  for (const path of reads) {
    const op = operation(paths, path, 'get');
    assert.equal(op['x-issuer-available'], undefined);
    assert.equal(op['x-issuer-availability-path'], base + '/options');
    assert.deepEqual(op['x-required-scopes'], ['inventory:read']);
  }
  for (const path of writes) assert.equal(paths[base + path], undefined);
  const family = Object.entries(paths).filter(([path]) => path.startsWith(base + '/'));
  assert.equal(family.length, 4);
  for (const [, methods] of family) assert.deepEqual(Object.keys(methods), ['get']);
});
