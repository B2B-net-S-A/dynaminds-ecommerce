#!/usr/bin/env node
// Offline benchmark of the JS part of the cold start (no database): the packing189 cold inspection of one real
// compiled catalogue (the same pure functions normalizeOrdinaryLegacyOwnerAcls and inspectPackingColdCompartment
// run on the catalogue they read), timed per step.
//
//   node tools/scale/load/coldstart-bench.mjs <afterNNN.catalogue.private.json.gz> [--repeat 1]
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { validateRecoverySchema } from '../../../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-catalogue-reader.mjs';
import { projectPackingOrderMergeDelivery209Catalogue, comparePackingCompiledExpectation, assertPackingNativeInstallation } from '../../../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-cold-inspection.mjs';
import { PACKING189_CONTRACT } from '../../../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/packing189-cold-contract.mjs';

const { values: o, positionals: [file] } = parseArgs({ allowPositionals: true, options: { repeat: { type: 'string', default: '1' } } });
const raw = JSON.parse(gunzipSync(readFileSync(file), { maxOutputLength: 268435456 }));
const out = {};
const step = (name, fn) => { const t = performance.now(); const r = fn(); out[name] = (out[name] ?? 0) + Math.round(performance.now() - t); return r; };
for (let i = 0; i < Number(o.repeat); i++) {
  // A fresh structured copy each round: the reader returns a new snapshot for every database read.
  const input = structuredClone(raw);
  const x = step('validate', () => validateRecoverySchema(input));
  step('assert_native_installation', () => assertPackingNativeInstallation(x));
  step('project209_chain', () => projectPackingOrderMergeDelivery209Catalogue(x));
  step('compare_compiled_expectation', () => comparePackingCompiledExpectation(PACKING189_CONTRACT.dependency_compilation, x));
}
console.log(JSON.stringify({ records: raw.records.length, text_bytes: Buffer.byteLength(JSON.stringify(raw)), ms: out }));
