/** File-only regression of scope v6: three wave-1 providers added OPEN; no app, SQL or HTTP. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createScopeSnapshot} from './scope-freeze.mjs';
import {checkInventories} from './check.mjs';

const D = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const root = path.resolve(D, '../..');
const base = D + '/docs/parity';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = async file => JSON.parse(await fs.readFile(file));
const parentBytes = await fs.readFile(base + '/scope.v5.json');
const parent = JSON.parse(parentBytes);
const current = await read(base + '/scope.v6.json');
const envelope = await read(base + '/scope.v6.request.json');
const frozen = await read(parent.inputs.integrations.path);
const integrations = await read(current.inputs.integrations.path);
// The frozen request keeps its pinned archive. After a pinned file changes, revalidation
// borrows only FILE storage from the append-only successor archive named by the pointer
// (docs/parity/scope-inputs/v6/README.md); requirements, statuses and acceptance stay v6.
const revalidation = (await read(base + '/evidence-archives/revalidation.json')).archive;
const replay = {...envelope.snapshot, evidence_archive: revalidation};
const NEW = {
  ksef: ['connection', 'invoice.send.fa3', 'invoice.status', 'invoice.upo', 'invoice.number', 'offline.mode', 'invoices.received.download'],
  pocztapolska: ['connection', 'shipment.create', 'label.pdf', 'tracking.read', 'pickup_point', 'cod'],
  dhl: ['connection', 'shipment.create', 'label.pdf', 'tracking.read', 'pickup.book', 'cod', 'points.search'],
};
const WAVE1 = ['allegro', 'amazon', 'ebay', 'mirakl', 'shopify', 'woocommerce', 'prestashop', 'dpd', 'inpost',
  'pocztapolska', 'dhl', 'fakturownia', 'odoo', 'ksef', 'bigbuy', 'smsapi', 'smtp', 'deepl'];
const addedKeys = [
  ...Object.entries(NEW).flatMap(([p, ops]) => ops.map(op => `integrations:operation:integration.${p}.${op}`)),
  ...Object.keys(NEW).map(p => `integrations:registry_provider:${p}`),
].sort();

async function changedIntegrations(mutate, work) {
  const dir = await fs.mkdtemp(base + '/.scope-v6-negative-');
  try {
    const doc = structuredClone(integrations); mutate(doc);
    const bytes = Buffer.from(JSON.stringify(doc) + '\n'), file = dir + '/integrations.json';
    await fs.writeFile(file, bytes, {flag: 'wx', mode: 0o600});
    await work({...replay, inputs: {...envelope.snapshot.inputs,
      integrations: {path: file, bytes: bytes.length, sha256: sha(bytes)}}});
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
}

test('v6 pins v5 as parent and keeps all 2589 v5 records byte-for-value; only 23 wave-1 keys are added', () => {
  assert.equal(parentBytes.length, 2305202);
  assert.equal(sha(parentBytes), 'be41647bb854567524ef236166225961f52b5e028f7a98552a716b4750b6aca3');
  assert.deepEqual(current.parent, {path: base + '/scope.v5.json', bytes: parentBytes.length, sha256: sha(parentBytes)});
  assert.equal(current.version, 6);
  assert.equal(current.requirements.length, 2612);
  const byKey = new Map(current.requirements.map(r => [r.key, r]));
  for (const old of parent.requirements) assert.deepEqual(byKey.get(old.key), old);
  assert.deepEqual([...current.changes.added].sort(), addedKeys);
  assert.deepEqual(current.changes.removed, []);
  assert.deepEqual(current.inputs.domains, parent.inputs.domains);
  assert.deepEqual(current.inputs.providerRoster, parent.inputs.providerRoster);
  assert.deepEqual(current.catalogue_inventory, parent.catalogue_inventory);
  assert.deepEqual(current.evidence_archive, parent.evidence_archive);
  const gaps = current.requirements.filter(row => row.kind === 'gap');
  assert.equal(gaps.length, 33);
  assert(gaps.every(row => row.state === 'open'));
});

test('v6 integrations input = frozen v2 input plus three providers; wave-1 roster is the 18 Goal providers', () => {
  assert.equal(frozen.rows.length, 324);
  assert.deepEqual(integrations.rows.slice(0, 324), frozen.rows);
  assert.deepEqual(integrations.providers.slice(0, 15), frozen.providers);
  assert.deepEqual(integrations.coverage_gaps, frozen.coverage_gaps);
  assert.deepEqual(integrations.cross_cutting_gaps, frozen.cross_cutting_gaps);
  assert.deepEqual(integrations.providers.map(p => p.id).sort(), [...WAVE1].sort());
  for (const [provider, ops] of Object.entries(NEW)) {
    const p = integrations.providers.find(row => row.id === provider);
    assert.equal(p.registry_line, null);
    assert.deepEqual(p.registry_implemented, []);
    assert.deepEqual(p.registry_planned, ops);
    const rows = integrations.rows.filter(row => row.provider === provider);
    assert.deepEqual(rows.map(row => row.operation), ops);
    for (const row of rows) {
      assert.equal(row.status, 'planned_acceptance_unverified');
      assert.equal(row.required_evidence_level, 'account');
      for (const level of ['code', 'local', 'sandbox', 'account']) assert.deepEqual(row.evidence[level], []);
      assert.equal(row.acceptance.length, 4);
      const req = current.requirements.find(r => r.key === `integrations:operation:${row.id}`);
      assert.equal(req.required_evidence_level, 'account');
      assert.equal(req.definition.operation_contract.discovery_status, undefined);
    }
  }
});

test('the existing generator reproduces v6 exactly, inventories stay valid and complete scope is refused', async () => {
  assert.equal(envelope.schema, 'dynaminds-parity-scope-freeze-request/v1');
  assert.equal(envelope.output, base + '/scope.v6.json');
  const frozenArchive = await read(current.evidence_archive.path), nextArchive = await read(revalidation.path);
  for (const row of frozenArchive.entries) assert(nextArchive.entries.some(next => JSON.stringify(next) === JSON.stringify(row)));
  assert.deepEqual(await createScopeSnapshot(replay, {root}), {...current, evidence_archive: revalidation});
  assert.equal(current.snapshot_kind, 'partial');
  assert.equal(current.scope_complete, false);
  assert.equal(current.acceptance_granted, false);
  assert.equal(current.inventory_mutated, false);
  const inputs = [{name: 'domains', document: await read(current.inputs.domains.path)}, {name: 'integrations', document: integrations}];
  const checked = await checkInventories(inputs, {root, evidenceArchive: revalidation});
  assert.equal(checked.valid, true);
  assert.deepEqual(checked.errors, []);
  assert.equal(checked.evidence_files_verified, 89);
  assert.equal(checked.acceptance_granted_by_checker, false);
  await assert.rejects(createScopeSnapshot({...replay, snapshot_kind: 'complete'}, {root}),
    error => error.code === 'SCOPE_STILL_PARTIAL');
  assert(!JSON.stringify([envelope, current]).includes('/local-builds/'));
});

test('successor path refuses edits, removal and level downgrade of inherited integration rows', async () => {
  await changedIntegrations(d => { d.rows[0].requirement += ' changed'; },
    q => assert.rejects(createScopeSnapshot(q, {root}), e => e.code === 'REQUIRED_REDEFINED'));
  await changedIntegrations(d => { d.rows.shift(); },
    q => assert.rejects(createScopeSnapshot(q, {root}), e => e.code === 'REQUIRED_REMOVED'));
  await changedIntegrations(d => { d.rows.find(r => r.provider === 'inpost').required_evidence_level = 'local'; },
    q => assert.rejects(createScopeSnapshot(q, {root}), e => e.code === 'REQUIRED_LEVEL_DOWNGRADE'));
});
