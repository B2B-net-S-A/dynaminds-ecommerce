/** Offline XSD validation against the official MF schemas vendored in schemas/mf (manifest.json:
 * source URL, sha256, bytes, retrieval date; every file is checked against its sha256 at load). Engine:
 * xmllint-wasm (libxml2 compiled to WebAssembly, exact pin in package.json), run with --nonet; no network
 * at validation time.
 * The vendored bytes are never changed: the MF schemas import their type schemas by absolute
 * http:// URL, so only in memory, before libxml2 sees them, every schemaLocation whose file name
 * exists in the same vendored directory is replaced by that file name. A location with no
 * vendored file stays as it is and fails under --nonet (the schema does not compile).
 *
 * In a release (this module bundled into an emitted chunk) the schemas are fixed runtime resources
 * (`xsd:<manifest path>`, read through the installed resource reader) and the engine is a locked dependency.
 * A release never answers `skipped`: assertMfXsdRelease refuses the start when a schema or the engine is
 * missing, and a later failure is `invalid`, so no file leaves unchecked. `skipped` is source/dev mode only. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRuntimeResource } from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/runtime-resources.mjs';

export type MfSchema = 'FA(3)' | 'JPK_V7M(3)' | 'JPK_V7K(3)' | 'JPK_FA(4)';
export type XsdResult = { status: 'valid' } | { status: 'invalid'; errors: string } | { status: 'skipped'; reason: string };
export type XsdValidator = { available: boolean; reason: string; source: string | null; validate(xml: string): Promise<XsdResult> };

/** Directory of the vendored schemas (next to server/ in the checkout). */
export const MF_SCHEMA_ROOT = fileURLToPath(new URL('../schemas/mf/', import.meta.url));
/** The source file name survives only in the checkout; bundled into a release this module is a chunk. */
const PACKAGED = !/[\\/]server[\\/]mf-xsd\.[cm]?[jt]s$/.test(fileURLToPath(import.meta.url));
/** What a release must run: the exact package.json pin and the bytes of its WebAssembly module. */
export const MF_XSD_ENGINE = Object.freeze({ name: 'xmllint-wasm', version: '5.3.0', wasmSha256: '4e3cc21a67e8dd40ccb59822e4193fd1923b4cda08b40fe8ff8973de5eed9515' });
const MF_SCHEMAS: readonly MfSchema[] = ['FA(3)', 'JPK_V7M(3)', 'JPK_V7K(3)', 'JPK_FA(4)'];
type ManifestSchema = { dir: string; root: string; targetNamespace: string };
type Manifest = { schemas: Record<MfSchema, ManifestSchema>; files: { path: string; sha256: string; bytes: number }[] };
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Fixed schema set of one MF structure: root file and its imports, schemaLocation mapped in memory. */
type Loaded = { root: { fileName: string; contents: string }; preload: { fileName: string; contents: string }[] };
const cache = new Map<string, Loaded>();
export function localSchemaLocations(text: string, names: ReadonlySet<string>): string {
  return text.replace(/schemaLocation="(https?:\/\/[^"]*\/)([^"/]+\.xsd)"/g, (all, _base: string, name: string) => names.has(name) ? `schemaLocation="${name}"` : all);
}
function schemaSet(rootName: string, names: readonly string[], read: (name: string) => Buffer): Loaded {
  const set = new Set(names);
  const file = (fileName: string) => ({ fileName, contents: localSchemaLocations(read(fileName).toString('utf8'), set) });
  return { root: file(rootName), preload: names.filter(n => n !== rootName).map(file) };
}
function load(root: string, m: Manifest, entry: ManifestSchema): Loaded {
  const dir = join(root, entry.dir), key = dir + '\0' + entry.root, hit = cache.get(key);
  if (hit) return hit;
  const names = readdirSync(dir).filter(f => f.endsWith('.xsd')).sort();
  const loaded = schemaSet(entry.root, names, name => {
    const bytes = readFileSync(join(dir, name)), row = m.files?.find(f => f.path === entry.dir + '/' + name);
    if (row && sha256(bytes) !== row.sha256) throw new Error(`Schemat ${row.path} ma inny sha256 niż w manifeście`);
    return bytes;
  });
  cache.set(key, loaded);
  return loaded;
}
function manifest(root: string): Manifest | null {
  const f = join(root, 'manifest.json');
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) as Manifest : null;
}

type Engine = typeof import('xmllint-wasm');
let engine: Promise<Engine | null> | undefined;
// Loaded on first use: a source tree without the package reports the validator unavailable instead of failing at startup.
const xmllint = () => (engine ??= import('xmllint-wasm').then(m => (m as { default?: Engine }).default ?? m).catch(() => null));

const MAX_ERRORS = 10;
/** libxml2 names elements as {namespace}Name; the namespace is noise in a Polish message. */
const tidy = (m: string) => m.replace(/\{[^}]*\}/g, '').replace(/^\s*Schemas (validity|parser) (error|warning)\s*:\s*/, '').replace(/\s+/g, ' ').trim();

/** A DTD (entities), a BOM or a processing instruction is never part of an MF file; refused before the parser sees it. */
function forbidden(xml: string): XsdResult | null {
  if (xml.charCodeAt(0) === 0xfeff) return { status: 'invalid', errors: 'Plik zaczyna się znacznikiem BOM' };
  if (/<!DOCTYPE/i.test(xml)) return { status: 'invalid', errors: 'Plik zawiera deklarację DTD' };
  // Only the XML declaration; a processing instruction is not part of an MF file either.
  if (/<\?/.test(xml.replace(/^<\?xml\s[^?]*\?>/, ''))) return { status: 'invalid', errors: 'Plik zawiera instrukcję przetwarzania' };
  return null;
}
async function runEngine(lib: Engine, loaded: Loaded, xml: string): Promise<XsdResult> {
  const r = await lib.validateXML({
    xml: [{ fileName: 'dokument.xml', contents: xml }], schema: [loaded.root], preload: loaded.preload,
    // FA(3) schema compile and a month of JPK rows need more than the 32 MiB default.
    maxMemoryPages: 256 * lib.memoryPages.MiB, modifyArguments: args => ['--nonet', ...args],
  });
  if (r.valid) return { status: 'valid' };
  const errors = r.errors.map(e => tidy(e.message)).filter(Boolean);
  return { status: 'invalid', errors: (errors.length ? errors.slice(0, MAX_ERRORS) : [tidy(r.rawOutput)]).join('\n').slice(0, 4000) };
}
/** Exit codes other than "invalid": the schema did not compile, out of memory, worker failure, a changed schema. */
const engineFailure = (e: unknown): XsdResult => ({ status: 'invalid', errors: 'Walidator XSD nie zakończył się poprawnie: ' + tidy(String((e as Error)?.message ?? e)).slice(0, 400) });

/** What the release gives this module; the real one reads the installed package, tests pass their own. */
export type MfXsdReleaseDeps = {
  read(id: string): Promise<Buffer>;
  engine(): Promise<Engine | null>;
  engineFiles(): Promise<{ version: string; wasm: Buffer }>;
};
const releaseDeps: MfXsdReleaseDeps = {
  read: id => readRuntimeResource('xsd:' + id.slice(4), import.meta.url),
  engine: xmllint,
  async engineFiles() {
    const packageFile = createRequire(import.meta.url).resolve('xmllint-wasm/package.json');
    return { version: (JSON.parse(readFileSync(packageFile, 'utf8')) as { version: string }).version, wasm: readFileSync(join(dirname(packageFile), 'xmllint.wasm')) };
  },
};
class MfXsdReleaseError extends Error {
  readonly code = 'MF_XSD_RELEASE_INCOMPLETE';
  constructor(detail: string) {
    super(`Odmowa uruchomienia: wydanie nie ma kompletnej walidacji XSD Ministerstwa Finansów (${detail}). Takie wydanie nie może wydawać plików FA(3) ani JPK; zainstaluj kompletne wydanie (schemas/mf oraz ${MF_XSD_ENGINE.name} ${MF_XSD_ENGINE.version}).`);
    this.name = 'MfXsdReleaseError';
  }
}
type ReleaseSchemas = { manifest: Manifest; bytes: ReadonlyMap<string, Buffer> };
/** Reads the manifest and every listed file through the resource reader; each file checked against its sha256. */
async function readReleaseSchemas(read: MfXsdReleaseDeps['read']): Promise<ReleaseSchemas> {
  let m: Manifest;
  try { m = JSON.parse((await read('xsd:manifest.json')).toString('utf8')) as Manifest; }
  catch { throw new MfXsdReleaseError('brak schemas/mf/manifest.json'); }
  const bytes = new Map<string, Buffer>();
  for (const row of m.files ?? []) {
    let b: Buffer;
    try { b = await read('xsd:' + row.path); } catch { throw new MfXsdReleaseError(`brak schematu ${row.path}`); }
    if (b.length !== row.bytes || sha256(b) !== row.sha256) throw new MfXsdReleaseError(`schemat ${row.path} ma inne bajty niż w manifeście`);
    bytes.set(row.path, b);
  }
  for (const schema of MF_SCHEMAS) {
    const e = m.schemas?.[schema];
    if (!e || !bytes.has(e.dir + '/' + e.root)) throw new MfXsdReleaseError(`manifest nie wskazuje schematu ${schema}`);
  }
  return { manifest: m, bytes };
}
const releaseSchemas = new WeakMap<MfXsdReleaseDeps, Promise<ReleaseSchemas>>();
function schemasOf(deps: MfXsdReleaseDeps): Promise<ReleaseSchemas> {
  let p = releaseSchemas.get(deps);
  if (!p) releaseSchemas.set(deps, p = readReleaseSchemas(deps.read));
  return p;
}
function releaseSet(s: ReleaseSchemas, schema: MfSchema): Loaded {
  const e = s.manifest.schemas[schema], prefix = e.dir + '/';
  const names = [...s.bytes.keys()].filter(p => p.startsWith(prefix) && !p.slice(prefix.length).includes('/')).map(p => p.slice(prefix.length)).sort();
  return schemaSet(e.root, names, name => s.bytes.get(prefix + name)!);
}
/** The validator of an installed release: fails closed, a problem here is `invalid`, never `skipped`. */
export function mfXsdReleaseValidator(schema: MfSchema, deps: MfXsdReleaseDeps = releaseDeps): XsdValidator {
  let loaded: Loaded | undefined;
  return {
    available: true, reason: '', source: 'xsd:' + schema,
    async validate(xml: string): Promise<XsdResult> {
      const refused = forbidden(xml);
      if (refused) return refused;
      try {
        const lib = await deps.engine();
        if (!lib) return { status: 'invalid', errors: `Brak biblioteki walidatora XSD (${MF_XSD_ENGINE.name}) w wydaniu` };
        loaded ??= releaseSet(await schemasOf(deps), schema);
        return await runEngine(lib, loaded, xml);
      } catch (e) { return engineFailure(e); }
    },
  };
}
const SMOKE_XSD = '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:element name="t" type="xs:string"/></xs:schema>';
/** Startup of a release, after the resources are installed and before the database module. Source mode: nothing to do. */
export async function assertMfXsdRelease(deps?: MfXsdReleaseDeps): Promise<void> {
  if (!deps && !PACKAGED) return;
  const d = deps ?? releaseDeps;
  await schemasOf(d);
  let files: { version: string; wasm: Buffer };
  try { files = await d.engineFiles(); } catch { throw new MfXsdReleaseError(`brak biblioteki ${MF_XSD_ENGINE.name}`); }
  if (files.version !== MF_XSD_ENGINE.version) throw new MfXsdReleaseError(`${MF_XSD_ENGINE.name} ${files.version} zamiast ${MF_XSD_ENGINE.version}`);
  if (sha256(files.wasm) !== MF_XSD_ENGINE.wasmSha256) throw new MfXsdReleaseError(`${MF_XSD_ENGINE.name}: xmllint.wasm ma inne bajty niż ${MF_XSD_ENGINE.version}`);
  const lib = await d.engine();
  if (!lib) throw new MfXsdReleaseError(`nie można załadować biblioteki ${MF_XSD_ENGINE.name}`);
  let smoke: XsdResult;
  try { smoke = await runEngine(lib, { root: { fileName: 't.xsd', contents: SMOKE_XSD }, preload: [] }, '<t>1</t>'); } catch (e) { smoke = engineFailure(e); }
  if (smoke.status !== 'valid') throw new MfXsdReleaseError(`${MF_XSD_ENGINE.name} nie wykonał próbnej walidacji`);
}

export function mfXsdValidator(schema: MfSchema, root = MF_SCHEMA_ROOT): XsdValidator {
  if (PACKAGED && root === MF_SCHEMA_ROOT) return mfXsdReleaseValidator(schema);
  const m = manifest(root), entry = m?.schemas[schema], dir = entry ? join(root, entry.dir) : null;
  if (!m || !entry || !dir || !existsSync(join(dir, entry.root))) {
    const reason = `Brak oficjalnego schematu ${schema} w repozytorium (schemas/mf/manifest.json).`;
    return { available: false, reason, source: null, validate: async () => ({ status: 'skipped', reason }) };
  }
  const source = join(dir, entry.root);
  return {
    available: true, reason: '', source,
    async validate(xml: string): Promise<XsdResult> {
      const refused = forbidden(xml);
      if (refused) return refused;
      const lib = await xmllint();
      if (!lib) return { status: 'skipped', reason: 'Brak biblioteki walidatora XSD (xmllint-wasm)' };
      try { return await runEngine(lib, load(root, m, entry), xml); } catch (e) { return engineFailure(e); }
    },
  };
}

/** Validators per structure, created once (schemas are read on the first validation). */
const shared = new Map<MfSchema, XsdValidator>();
export function sharedMfXsdValidator(schema: MfSchema): XsdValidator {
  let v = shared.get(schema);
  if (!v) shared.set(schema, v = mfXsdValidator(schema));
  return v;
}
/** First reported error, for a one-line Polish refusal. */
export const firstXsdError = (r: Extract<XsdResult, { status: 'invalid' }>) => r.errors.split('\n')[0]!.slice(0, 300);
