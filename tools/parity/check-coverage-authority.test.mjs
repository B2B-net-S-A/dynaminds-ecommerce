/** File-only completeness authority. No business/evidence execution or scope mutation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {checkInventories} from './check.mjs';

const schemas = {
  domains: 'dynaminds-base-functional-domain-inventory/v1',
  integrations: 'dynaminds-base-parity-integrations/v1',
};
function inventory(kind) {
  return {
    schema: schemas[kind], as_of: '2026-10-17',
    scope: 'A descriptive label cannot grant coverage_complete.',
    inventory_complete: true, coverage_gaps: [],
    ...(kind === 'domains' ? {inventory_coverage: {source_catalogue_exhaustive: true}}
      : {summary: {full_base_roster_complete: true}}),
    rows: [{id: 'COV-' + kind, requirement: 'Preserve one controlled scoped operation.',
      acceptance: ['Inspect its independently pinned result.'], status: 'unverified',
      evidence: {code: [], local: [], sandbox: [], account: []}}],
  };
}
async function checked(kind, document, requireComplete = false, options = {}) {
  return checkInventories([{name: kind, document}], {...options, requireComplete});
}
async function incomplete(kind, document) {
  const ordinary = await checked(kind, document);
  assert.equal(ordinary.valid, true, 'Partial inputs remain structurally usable');
  assert.equal(ordinary.inventories[0].coverage_closed, false);
  assert.equal(ordinary.completion_review_candidate, false);
  assert.equal(ordinary.acceptance_granted_by_checker, false);
  const strict = await checked(kind, document, true);
  assert.equal(strict.valid, false, 'The existing strict completion path refuses incomplete discovery');
}

test('each real schema requires its own explicit boolean source-discovery authority', async () => {
  for (const kind of Object.keys(schemas)) {
    const good = inventory(kind), metadata = kind === 'domains' ? 'inventory_coverage' : 'summary';
    const flag = kind === 'domains' ? 'source_catalogue_exhaustive' : 'full_base_roster_complete';
    assert.equal((await checked(kind, good)).inventories[0].coverage_closed, true);
    for (const value of [undefined, null, false, 'true', 'false', 1, {}, []]) {
      const bad = structuredClone(good);
      if (value === undefined) delete bad[metadata][flag]; else bad[metadata][flag] = value;
      await incomplete(kind, bad);
    }
    for (const value of [undefined, null, 'complete', true, []]) {
      const bad = structuredClone(good);
      if (value === undefined) delete bad[metadata]; else bad[metadata] = value;
      await incomplete(kind, bad);
    }
    for (const value of [undefined, null, false, 'true', 1]) {
      const bad = structuredClone(good);
      if (value === undefined) delete bad.inventory_complete; else bad.inventory_complete = value;
      await incomplete(kind, bad);
    }
  }
});

test('scope labels are not coverage flags and supplementary malformed or contradictory flags never close discovery', async () => {
  for (const kind of Object.keys(schemas)) {
    const good = inventory(kind);
    for (const label of ['complete', 'coverage_complete=true', 'false']) {
      const labelled = {...good, scope: label};
      assert.equal((await checked(kind, labelled)).inventories[0].coverage_closed, true, 'The schema authority decides, not label text');
      delete labelled[kind === 'domains' ? 'inventory_coverage' : 'summary'];
      await incomplete(kind, labelled);
    }
    for (const value of [null, false, 'true', {}, []]) {
      await incomplete(kind, {...good, scope: {coverage_complete: value}});
      await incomplete(kind, {...good, coverage_complete: value});
    }
    await incomplete(kind, {...good, scope: {}});
    assert.equal((await checked(kind, {...good, scope: {coverage_complete: true}})).inventories[0].coverage_closed, true);
    if (kind === 'domains') await incomplete(kind, {...good, summary: {full_base_roster_complete: false}});
    else await incomplete(kind, {...good, inventory_coverage: {source_catalogue_exhaustive: false}});
  }
  const unknown = inventory('domains'); unknown.schema = 'unreviewed-inventory/v9';
  await incomplete('unknown', unknown);
});

test('legitimate complete schema inputs retain pinned-evidence acceptance gating and never grant product acceptance', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'parity-source-authority-'));
  try {
    const bytes = Buffer.from('{"controlled_file_fixture":true}\n'), file = path.join(root, 'evidence.json');
    await fs.writeFile(file, bytes, {flag: 'wx'});
    const ref = {path: file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')};
    for (const kind of Object.keys(schemas)) {
      const document = inventory(kind);
      document.rows[0].status = 'accepted_local'; document.rows[0].evidence.local = [ref];
      const result = await checked(kind, document, true, {root});
      assert.equal(result.valid, true); assert.equal(result.completion_review_candidate, true);
      assert.equal(result.evidence_files_verified, 1); assert.equal(result.acceptance_granted_by_checker, false);
      document.coverage_gaps = ['An additional surface remains unreviewed.'];
      await incomplete(kind, document);
    }
  } finally { await fs.rm(root, {recursive: true, force: true}); }
});

test('actual frozen v4 source metadata remains partial and its snapshot/input bytes remain unchanged', async () => {
  const project = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
  const root = path.resolve(project, '../..'), scopePath = path.join(project, 'docs/parity/scope.v4.json');
  const scopeBytes = await fs.readFile(scopePath), scope = JSON.parse(scopeBytes);
  const inputs = [], retained = [];
  for (const name of ['domains', 'integrations']) {
    const bytes = await fs.readFile(scope.inputs[name].path);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), scope.inputs[name].sha256);
    retained.push({path: scope.inputs[name].path, bytes}); inputs.push({name, document: JSON.parse(bytes)});
  }
  const result = await checkInventories(inputs, {root, evidenceArchive: scope.evidence_archive});
  // This smoke checks coverage only. Historical evidence pins are still fully
  // enforced; neither valid=true nor a waiver of stale Mirakl files is assumed.
  assert.equal(result.inventories.length, inputs.length);
  for (const input of inputs) {
    const checked = result.inventories.find(row => row.name === input.name); assert(checked);
    assert.equal(checked.rows, input.document.rows.length);
    assert.equal(checked.coverage_gaps, input.document.coverage_gaps.length);
  }
  assert(result.inventories.every(x => x.coverage_closed === false));
  assert.equal(result.completion_review_candidate, false); assert.equal(result.acceptance_granted_by_checker, false);
  assert.equal(scope.scope_complete, false); assert.equal(scope.acceptance_granted, false);
  assert((await fs.readFile(scopePath)).equals(scopeBytes));
  for (const ref of retained) assert((await fs.readFile(ref.path)).equals(ref.bytes));
});
