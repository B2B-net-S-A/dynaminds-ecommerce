/** Cold start (B4): the release cold chain re-validates the full catalogue (~47k records, ~67 MB canonical text)
 * once per release migration, twice per start. A record the reader has already normalized and deeply frozen
 * is reused as is (same canonical text, same node/depth budget); every check of the reader keeps running and
 * the digest stays the sha256 of exactly the same canonical bytes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { validateRecoverySchema, LIMITS } from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-catalogue-reader.mjs';
import { digest212, freeze212 } from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/local-woo-read212-source-contract.mjs';
import { projectReleaseColdChain } from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-cold-inspection.mjs';

const fixture = process.env.DYNA_COLDSTART_CATALOGUE ?? fileURLToPath(new URL('../../../local-builds/full-base-preview-20261017/m253-source-20261028-01/after253.catalogue.private.json.gz', import.meta.url));
const skip = !existsSync(fixture) && 'real compiled catalogue not present (DYNA_COLDSTART_CATALOGUE)';
const load = () => JSON.parse(gunzipSync(readFileSync(fixture), { maxOutputLength: 268435456 }));
// Reference spelling of the canonical bytes, independent of the module under test.
const sorted = (v) => Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v;
const reference = (v) => createHash('sha256').update(JSON.stringify(sorted(v))).digest('hex');
const body = ({ sha256, ...rest }) => rest;
const rebound = (x, records) => { const b = { ...body(x), records }; return { ...b, sha256: reference(b) }; };

test('a projected catalogue reuses the already validated records and keeps the exact digest', { skip }, () => {
  const x = validateRecoverySchema(load());
  assert.equal(x.sha256, reference(body(x)));
  // As a projector does: a new body over the same record objects (an inverse that removes nothing).
  const records = [...x.records];
  const t = performance.now();
  const y = validateRecoverySchema(rebound(x, records));
  const ms = performance.now() - t;
  assert.notEqual(y, x);
  assert.equal(y.sha256, x.sha256);
  assert.equal(y.records.length, x.records.length);
  // Same immutable record objects, not fresh canonical copies.
  for (let i = 0; i < records.length; i++) assert.equal(y.records[i], records[i]);
  assert(Object.isFrozen(y) && Object.isFrozen(y.records) && y.records.every(Object.isFrozen));
  assert(ms < 1500, `re-validation of a shared catalogue took ${Math.round(ms)} ms`);
});

test('reuse keeps every reader check: order, duplicates, digest, depth and node budgets', { skip }, () => {
  const x = validateRecoverySchema(load());
  const swapped = [...x.records]; [swapped[3], swapped[4]] = [swapped[4], swapped[3]];
  assert.throws(() => validateRecoverySchema(rebound(x, swapped)), /recovery-canonical-order/);
  const dup = [...x.records]; dup[4] = dup[3];
  assert.throws(() => validateRecoverySchema(rebound(x, dup)), /recovery-duplicate-object|recovery-canonical-order/);
  assert.throws(() => validateRecoverySchema({ ...body(x), records: [...x.records], sha256: '0'.repeat(64) }), /recovery-snapshot-integrity/);
  // A record nested 63 deep passes the per-record bound but not the whole-catalogue bound (two levels above it).
  const i = x.records.findIndex((r) => r.kind === 'relation');
  let deep = 'x'; for (let d = 0; d < LIMITS.json_depth - 3; d++) deep = [deep];
  const r = { ...x.records[i], value: { ...x.records[i].value, options: deep } };
  const deepRecords = x.records.map((q, j) => (j === i ? r : q));
  assert.throws(() => validateRecoverySchema(rebound(x, deepRecords)), /recovery-json-bounds/);
});

test('each record is read once: an accessor index cannot pass a sealed record and substitute another', { skip }, () => {
  const x = validateRecoverySchema(load());
  const k = x.records.findIndex((r) => r.kind === 'relation'), orig = x.records[k];
  const evil = { kind: orig.kind, key: orig.key, value: { owner: 'attacker' } };
  const rows = [...x.records]; let reads = 0;
  Object.defineProperty(rows, k, { enumerable: true, get() { return ++reads === 1 ? orig : evil; } });
  const y = validateRecoverySchema({ ...body(x), records: rows, sha256: x.sha256 });
  assert.equal(reads, 1);
  assert.notEqual(y.records[k], evil);
  assert.equal(y.records[k], orig);
  assert.equal(y.sha256, reference(body(y)));
});

test('digest212 and freeze212 of a body with reader records equal the reference spelling', { skip }, () => {
  const x = validateRecoverySchema(load());
  const b = { ...body(x), records: x.records.slice(0, 500).concat([{ kind: 'zz', key: 'new', value: { a: [1, { c: 2, b: undefined }], d: null } }]) };
  assert.equal(digest212(b), createHash('sha256').update(JSON.stringify(sorted(b))).digest('hex'));
  const t = performance.now(); const f = freeze212({ catalogue: x, active: false }); const ms = performance.now() - t;
  assert(Object.isFrozen(f) && f.catalogue === x);
  assert(ms < 200, `freeze of an already frozen catalogue took ${Math.round(ms)} ms`);
});

test('the release cold chain over the full catalogue stays exact and fits the cold start budget', { skip }, () => {
  const x = validateRecoverySchema(load());
  const t = performance.now(); const chain = projectReleaseColdChain(x); const ms = performance.now() - t;
  assert.equal(chain.catalogue.sha256, reference(body(chain.catalogue)));
  assert(Object.values(chain.active).every((v) => v === true));
  assert(ms < 20000, `cold chain took ${Math.round(ms)} ms`);
});
