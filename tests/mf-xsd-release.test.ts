/** A release must not hand out FA(3)/JPK files without the XSD check: the schemas travel as fixed runtime
 * resources (schemas/mf with its manifest, sha256 checked at load), the engine as a locked dependency, and a
 * release without either refuses to start (Polish message). Source/dev mode may keep `pominieta`. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MF_SCHEMA_ROOT, MF_XSD_ENGINE, assertMfXsdRelease, mfXsdReleaseValidator, mfXsdValidator, type MfXsdReleaseDeps,
} from '../server/mf-xsd';

const manifestBytes = readFileSync(join(MF_SCHEMA_ROOT, 'manifest.json'));
const manifest = JSON.parse(manifestBytes.toString()) as { schemas: Record<string, { dir: string; root: string }>; files: { path: string; sha256: string; bytes: number }[] };
const golden = readFileSync(new URL('./fa3-golden/fv-consumer.xml', import.meta.url), 'utf8');
const realEngine = () => import('xmllint-wasm').then(m => (m as { default?: unknown }).default ?? m) as ReturnType<MfXsdReleaseDeps['engine']>;
const engineDir = new URL('../node_modules/xmllint-wasm/', import.meta.url);

/** The release as the installed reader would give it: id -> bytes, nothing else. */
function deps(over: Partial<MfXsdReleaseDeps> = {}, tamper: (id: string, b: Buffer) => Buffer = (_i, b) => b): MfXsdReleaseDeps {
  return {
    read: async id => { assert.ok(id.startsWith('xsd:'), id); return tamper(id, readFileSync(join(MF_SCHEMA_ROOT, id.slice(4)))); },
    engine: realEngine,
    engineFiles: async () => ({
      version: JSON.parse(readFileSync(new URL('package.json', engineDir), 'utf8')).version,
      wasm: readFileSync(new URL('xmllint.wasm', engineDir)),
    }),
    ...over,
  };
}
const refused = (p: Promise<unknown>, what: RegExp) => assert.rejects(p, (e: Error & { code?: string }) => {
  assert.equal(e.code, 'MF_XSD_RELEASE_INCOMPLETE');
  assert.match(e.message, /^Odmowa uruchomienia: wydanie nie ma kompletnej walidacji XSD/);
  assert.match(e.message, what);
  return true;
});

test('the engine pin of the release is the exact package.json pin and the installed wasm', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.dependencies['xmllint-wasm'], MF_XSD_ENGINE.version);
  assert.equal(MF_XSD_ENGINE.version, '5.3.0');
});

test('a complete release passes the startup check: manifest sha256, engine version and wasm, a real validation', async () => {
  await assertMfXsdRelease(deps());
});

test('a missing or changed schema, a missing manifest or a missing engine refuses the start with a Polish message', async () => {
  const missing = (name: string) => (id: string, b: Buffer) => { if (id === name) throw new Error('runtime-resource-unavailable:' + id); return b; };
  await refused(assertMfXsdRelease(deps({}, missing('xsd:manifest.json'))), /manifest/);
  await refused(assertMfXsdRelease(deps({}, missing('xsd:FA/3/schemat.xsd'))), /FA\/3\/schemat\.xsd/);
  await refused(assertMfXsdRelease(deps({}, (id, b) => id === 'xsd:JPK_V7M/3/schemat.xsd' ? Buffer.concat([b, Buffer.from(' ')]) : b)), /JPK_V7M\/3\/schemat\.xsd/);
  await refused(assertMfXsdRelease(deps({ engine: async () => null })), /xmllint-wasm/);
  await refused(assertMfXsdRelease(deps({ engineFiles: async () => { throw new Error('ENOENT'); } })), /xmllint-wasm/);
  await refused(assertMfXsdRelease(deps({ engineFiles: async () => ({ version: '5.2.0', wasm: Buffer.alloc(1) }) })), /5\.3\.0/);
  const good = await deps().engineFiles();
  await refused(assertMfXsdRelease(deps({ engineFiles: async () => ({ version: good.version, wasm: Buffer.concat([good.wasm, Buffer.alloc(1)]) }) })), /xmllint\.wasm/);
});

test('the release validator reads the resources, validates, and fails closed: never `skipped` once installed', async () => {
  const v = mfXsdReleaseValidator('FA(3)', deps());
  assert.equal(v.available, true);
  assert.deepEqual(await v.validate(golden), { status: 'valid' });
  assert.equal((await v.validate(golden.replace(/<P_15>[^<]*<\/P_15>/, ''))).status, 'invalid');
  assert.equal((await mfXsdReleaseValidator('FA(3)', deps({}, (id, b) => { if (id.endsWith('schemat.xsd')) throw new Error('gone'); return b; })).validate(golden)).status, 'invalid');
  assert.equal((await mfXsdReleaseValidator('FA(3)', deps({ engine: async () => null })).validate(golden)).status, 'invalid');
});

test('source mode: a schema changed against the manifest sha256 is not accepted; an intact copy validates', async () => {
  const entry = manifest.schemas['FA(3)']!, inFa = manifest.files.filter(f => f.path.startsWith(entry.dir + '/'));
  const copy = () => {
    const root = mkdtempSync(join(tmpdir(), 'mf-xsd-sha-'));
    mkdirSync(join(root, entry.dir), { recursive: true });
    for (const f of inFa) writeFileSync(join(root, f.path), readFileSync(join(MF_SCHEMA_ROOT, f.path)));
    writeFileSync(join(root, 'manifest.json'), JSON.stringify({ schemas: { 'FA(3)': entry }, files: inFa }));
    return root;
  };
  const intact = copy(), changed = copy();
  try {
    assert.deepEqual(await mfXsdValidator('FA(3)', intact).validate(golden), { status: 'valid' });
    writeFileSync(join(changed, entry.dir, entry.root), readFileSync(join(changed, entry.dir, entry.root)).toString() + ' ');
    const r = await mfXsdValidator('FA(3)', changed).validate(golden);
    assert.equal(r.status, 'invalid'); assert.match((r as { errors: string }).errors, /sha256/);
  } finally { for (const root of [intact, changed]) rmSync(root, { recursive: true, force: true }); }
});

test('the startup factories check the release after the resources are installed and before the database module', () => {
  for (const f of ['server/ordinary-local-runtime.ts', 'server/local-import-runtime.ts']) {
    const s = readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    const installed = s.indexOf('await installRuntimeResources('), checked = s.indexOf('await assertMfXsdRelease()'), db = s.indexOf("await import('./db')");
    assert.ok(installed > 0 && checked > installed && db > checked, f);
  }
});

test('the operator sees the Polish refusal on the start failure line', async () => {
  const { ordinaryLocalStartFailure } = await import('../server/ordinary-local-cli');
  const e = await assertMfXsdRelease(deps({ engine: async () => null })).catch(x => x as Error & { code: string });
  const line = ordinaryLocalStartFailure(e);
  assert.equal(line.code, 'MF_XSD_RELEASE_INCOMPLETE'); assert.match(line.message!, /Odmowa uruchomienia/);
});
