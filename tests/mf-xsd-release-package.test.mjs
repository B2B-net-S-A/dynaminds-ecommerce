/** Packaging half of the release XSD rule (tests/mf-xsd-release.test.ts is the runtime half): schemas/mf is a fixed
 * runtime resource in both definition copies, and the emitter refuses a package with the validator but without
 * its schemas or its locked engine. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RESOURCE_DEFINITIONS as build } from '../tools/build/resource-definitions.mjs';
import { assertReleaseXsdClosure } from '../tools/build/package-builder.mjs';
import { RESOURCE_DEFINITIONS as runtime } from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/resource-definitions.mjs';

const manifestBytes = readFileSync(new URL('../schemas/mf/manifest.json', import.meta.url));
const manifest = JSON.parse(manifestBytes.toString());

test('every vendored schema file and the manifest are fixed runtime resources consumed by server/mf-xsd.ts, in both copies', () => {
  const expected = ['manifest.json', ...manifest.files.map(f => f.path)].map(p => ({ id: 'xsd:' + p, source: 'schemas/mf/' + p, path: 'resources/schemas/mf/' + p, consumer: 'server/mf-xsd.ts' }));
  assert.deepEqual(build.filter(d => d.id.startsWith('xsd:')).map(d => ({ ...d })), expected);
  assert.deepEqual(runtime, build);
});

test('package build: an emitted mf-xsd without any schema member, the manifest pin or the locked engine refuses the package', () => {
  const row = (p, sha256, bytes) => ({ id: 'xsd:' + p, path: 'resources/schemas/mf/' + p, sha256, bytes });
  const members = [row('manifest.json', 'x', 1), ...manifest.files.map(f => row(f.path, f.sha256, f.bytes))];
  const dependencies = [{ name: 'xmllint-wasm', version: '5.3.0', integrity: 'sha512-x' }];
  const ok = { emittedSources: new Set(['server/mf-xsd.ts']), dependencies, resourceContract: { members, missing: [] }, schemaManifest: manifestBytes };
  assert.doesNotThrow(() => assertReleaseXsdClosure(ok));
  assert.doesNotThrow(() => assertReleaseXsdClosure({ ...ok, emittedSources: new Set(['server/x.ts']), dependencies: [], resourceContract: undefined, schemaManifest: undefined }), 'a package without the validator needs nothing');
  assert.throws(() => assertReleaseXsdClosure({ ...ok, resourceContract: { members: members.slice(1), missing: ['xsd:manifest.json'] } }), /deployment-xsd-missing/);
  assert.throws(() => assertReleaseXsdClosure({ ...ok, resourceContract: { members: members.slice(0, -1), missing: [] } }), /deployment-xsd-member/);
  assert.throws(() => assertReleaseXsdClosure({ ...ok, dependencies: [] }), /deployment-xsd-engine-locked/);
  assert.throws(() => assertReleaseXsdClosure({ ...ok, dependencies: [{ ...dependencies[0], version: '5.2.0' }] }), /deployment-xsd-engine-locked/);
});

