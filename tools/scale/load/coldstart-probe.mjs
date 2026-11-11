#!/usr/bin/env node
// Cold start probe (inside the database container's network namespace, like setup.mjs): builds the packaged
// release's ordinary factory once and records every PostgreSQL query the release sends during construction
// (start, end, client, first 200 characters of the text), so tools/scale/load/coldstart.mjs can split the
// factory time into phases. Measurement only: the release's own pg module is observed, never altered in effect
// (the wrapper forwards every call unchanged and only timestamps its settlement).
//
//   node tools/scale/load/coldstart-probe.mjs --release <release-build.json> --out <trace.ndjson> [--scoped-automation]
import { appendFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { readReleaseBuild } from '../release-runtime.mjs';

const { values: a } = parseArgs({ options: { release: { type: 'string' }, out: { type: 'string' }, 'scoped-automation': { type: 'boolean', default: false } } });
for (const k of ['release', 'out']) if (!a[k]) throw new Error(`--${k} required`);
const rec = readReleaseBuild(a.release), dir = rec.release_directory;
const pg = createRequire(dir + '/runtime/server/ordinary-local-runtime.mjs')('pg');
const t0 = performance.now(), ms = () => Math.round((performance.now() - t0) * 10) / 10;
const write = (row) => appendFileSync(a.out, JSON.stringify(row) + '\n', { mode: 0o600 });
const ids = new WeakMap(); let nextId = 1;
const original = pg.Client.prototype.query;
pg.Client.prototype.query = function (config, values, callback) {
  const text = typeof config === 'string' ? config : config?.text;
  if (typeof text !== 'string') return original.call(this, config, values, callback);
  if (!ids.has(this)) ids.set(this, nextId++);
  const row = { kind: 'q', c: ids.get(this), s: ms(), t: text.replace(/\s+/g, ' ').trim().slice(0, 200) };
  const done = (ok) => write({ ...row, e: ms(), ok });
  const cb = typeof values === 'function' ? values : callback;
  if (cb) {
    const wrapped = (err, res) => { done(!err); return cb(err, res); };
    return typeof values === 'function' ? original.call(this, config, wrapped) : original.call(this, config, values, wrapped);
  }
  const r = original.call(this, config, values);
  if (r && typeof r.then === 'function') r.then(() => done(true), () => done(false));
  return r;
};
write({ kind: 'start', at: Date.now(), release: rec.release_manifest_sha256, commit: rec.commit });
const { createOrdinaryLocalApplication } = await import(pathToFileURL(dir + '/runtime/server/ordinary-local-runtime.mjs').href);
write({ kind: 'imported', s: ms() });
const local = await createOrdinaryLocalApplication({ releaseDirectory: dir, manifestSha: rec.release_manifest_sha256, expectedOwner: 'postgres',
  databaseUrl: process.env.DATABASE_URL, localConfigurationPath: realpathSync(process.env.DYNA_LOCAL_CONFIG_PATH), revision: rec.release_manifest_sha256 },
  a['scoped-automation'] ? { scopedAutomationEnabled: true } : {});
write({ kind: 'factory', s: ms(), timings: local.timings });
await local.app.listen({ host: '127.0.0.1', port: 0 });
write({ kind: 'listening', s: ms() });
await local.close();
write({ kind: 'closed', s: ms() });
console.log(JSON.stringify({ status: 'COLDSTART_PROBE_DONE', factory: local.timings, listening_ms: ms() }));
