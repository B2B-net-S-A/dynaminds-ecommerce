// The generator inside a packaged release (manifest section 2): the release's own ordinary factory
// (runtime/server/ordinary-local-runtime.mjs → createOrdinaryLocalApplication: real migrate(), cold
// validation, installOrdinarySchemaRuntime) and the release's emitted chunks for the domain functions the
// writer calls. A chunk is the module instance the factory already loaded (same file URL), so tenantTx runs
// behind the installed schema gate: no per-transaction schema preflight, as in the measured release.
// Chunks are located through the build's esbuild metafile (beside the package, pinned by sha256 in
// release-build.json); a missing module or export refuses before any write.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const VIRTUAL = '.deployment-emitted-not-written/';
// Source module → exports the writer uses (writer.mjs names them rt.<key>.<export>).
export const RELEASE_MODULES = {
  db: ['server/db.ts', ['tenantTx', 'pool']],
  domain: ['server/domain.ts', ['createOrder', 'scan', 'shipDemo', 'productSchema', 'orderSchema']],
  catalog: ['server/catalog.ts', ['createProduct']],
  ws: ['server/workspace-routes.ts', ['loginWorkspace']],
  li: ['server/local-invoices.ts', ['createLocalInvoiceSeries', 'localInvoiceRequestActor', 'previewLocalInvoice']],
  tax: ['server/tax226-local-invoices.ts', ['issueLocalInvoiceWithTax', 'taxInvoiceActor']],
  // 230 preview of the dataset invoices; issued through the same tax-issue (issueLocalInvoiceWithTax dispatches a 230 preview).
  i230: ['server/invoice230-service.ts', ['invoice230Preview']],
  returns: ['server/returns.ts', ['getReturn', 'receiveReturn', 'recordRefund', 'requestReturn', 'returnInput']],
  status: ['server/legacy-return-on-command.ts', ['transitionDirectLegacyOnReturnInTx']],
  wms: ['server/wms-lots.ts', ['activateWmsOpening', 'createWmsOpeningPreview', 'receiveWmsReceipt', 'wmsLotsPolicyInTx']],
};

/** Release identity from release-build.json, re-verified against the bytes on disk. */
export function readReleaseBuild(path) {
  const rec = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(rec.schema, 'dyna-scale-release-build/v1', 'release-build.json expected');
  const dir = rec.release_directory;
  assert.equal(realpathSync(dir), dir, 'release directory must be canonical');
  assert.equal(sha(readFileSync(dir + '/release.json')), rec.release_manifest_sha256, 'release.json sha256 differs from the build record');
  assert.equal(sha(readFileSync(rec.metafile)), rec.metafile_sha256, 'esbuild metafile sha256 differs from the build record');
  return rec;
}

/** Output chunk (inside the package) of each source module, with the exports present in it. */
export function locateChunks(metafile, release, modules = RELEASE_MODULES) {
  const closure = new Set(JSON.parse(readFileSync(release + '/release.json', 'utf8')).emitted_output_closure.files);
  const out = {};
  for (const [key, [source, names]] of Object.entries(modules)) {
    const hits = Object.entries(metafile.outputs).filter(([o, v]) => closure.has(o) && v.inputs?.[source]?.bytesInOutput > 0);
    assert.equal(hits.length, 1, `${source}: expected one emitted chunk, found ${hits.length}`);
    const [output, v] = hits[0], exports = new Set(v.exports);
    const missing = names.filter((n) => !exports.has(n));
    assert.deepEqual(missing, [], `${source}: exports missing in ${output}`);
    assert(output.startsWith(VIRTUAL));
    out[key] = { source, chunk: 'runtime/' + output.slice(VIRTUAL.length), names };
  }
  return out;
}

/** factoryOptions: the factory's own options (e.g. { scopedAutomationEnabled: true } for the recovery drill). */
export async function openReleaseRuntime({ buildRecord, connections, factoryOptions }) {
  const rec = readReleaseBuild(buildRecord), dir = rec.release_directory;
  const chunks = locateChunks(JSON.parse(readFileSync(rec.metafile, 'utf8')), dir);
  const { createOrdinaryLocalApplication } = await import(pathToFileURL(dir + '/runtime/server/ordinary-local-runtime.mjs').href);
  const local = await createOrdinaryLocalApplication({ releaseDirectory: dir, manifestSha: rec.release_manifest_sha256, expectedOwner: 'postgres',
    databaseUrl: process.env.DATABASE_URL, localConfigurationPath: realpathSync(process.env.DYNA_LOCAL_CONFIG_PATH), revision: rec.release_manifest_sha256 },
    factoryOptions);
  const rt = {};
  for (const [key, c] of Object.entries(chunks)) {
    const m = await import(pathToFileURL(dir + '/' + c.chunk).href);
    rt[key] = Object.fromEntries(c.names.map((n) => [n, m[n]]));
  }
  rt.db.pool.options.max = connections;
  // The factory app reads DYNA_RATE_LIMIT_PER_MIN from this process (inherited; scale-pg.sh netns-node passes it).
  // Recorded as the app reports it; null for a release before 29.10 (fixed 600, no field).
  const health = await local.app.inject({ method: 'GET', url: '/api/health' });
  if (health.statusCode !== 200) { await local.close(); throw new Error(`release /api/health: HTTP ${health.statusCode}`); }
  return { ...rt, app: local.app, close: () => local.close(),
    release: { commit: rec.commit, release_manifest_sha256: rec.release_manifest_sha256, package_tree_sha256: rec.package_tree_sha256,
      rate_limit: health.json().rate_limit ?? null,
      factory_ms: local.timings, chunks: Object.fromEntries(Object.entries(chunks).map(([k, c]) => [k, c.chunk])) } };
}
