/** File-only regression of scope v7: PayU (portal payments) added OPEN; no app, SQL or HTTP. */
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
const parentBytes = await fs.readFile(base + '/scope.v6.json');
const parent = JSON.parse(parentBytes);
const current = await read(base + '/scope.v7.json');
const envelope = await read(base + '/scope.v7.request.json');
const previous = await read(parent.inputs.integrations.path);
const integrations = await read(current.inputs.integrations.path);
// The frozen request keeps its pinned archive. After a pinned file changes, revalidation
// borrows only FILE storage from the append-only successor archive named by the pointer
// (docs/parity/scope-inputs/v7/README.md); requirements, statuses and acceptance stay v7.
const revalidation = (await read(base + '/evidence-archives/revalidation.json')).archive;
const replay = {...envelope.snapshot, evidence_archive: revalidation};
const OPS = ['connection', 'order.create', 'order.status', 'notification.receive', 'refund.create', 'refund.status',
  'payout.reconcile', 'order.cancel'];
const MUTATIONS = ['order.create', 'refund.create', 'order.cancel'];
const addedKeys = [...OPS.map(op => `integrations:operation:integration.payu.${op}`), 'integrations:registry_provider:payu'].sort();

async function changedIntegrations(mutate, work) {
  const dir = await fs.mkdtemp(base + '/.scope-v7-negative-');
  try {
    const doc = structuredClone(integrations); mutate(doc);
    const bytes = Buffer.from(JSON.stringify(doc) + '\n'), file = dir + '/integrations.json';
    await fs.writeFile(file, bytes, {flag: 'wx', mode: 0o600});
    await work({...replay, inputs: {...envelope.snapshot.inputs,
      integrations: {path: file, bytes: bytes.length, sha256: sha(bytes)}}});
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
}

test('v7 pins v6 as parent and keeps all 2612 v6 records byte-for-value; only 9 PayU keys are added', () => {
  assert.equal(parentBytes.length, 2351722);
  assert.equal(sha(parentBytes), '910ca6af86d539718c8227682946821799ece21b2ae5e7563f1a1486db205b90');
  assert.deepEqual(current.parent, {path: base + '/scope.v6.json', bytes: parentBytes.length, sha256: sha(parentBytes)});
  assert.equal(current.version, 7);
  assert.equal(parent.requirements.length, 2612);
  assert.equal(current.requirements.length, 2621);
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

test('v7 integrations input = v6 input plus PayU; new rows are planned at account level with empty evidence', () => {
  assert.equal(previous.rows.length, 344);
  assert.deepEqual(integrations.rows.slice(0, 344), previous.rows);
  assert.deepEqual(integrations.providers.slice(0, 18), previous.providers);
  assert.deepEqual(integrations.coverage_gaps, previous.coverage_gaps);
  assert.deepEqual(integrations.cross_cutting_gaps, previous.cross_cutting_gaps);
  assert.deepEqual(integrations.providers.map(p => p.id).slice(18), ['payu']);
  const p = integrations.providers.find(row => row.id === 'payu');
  assert.equal(p.registry_line, null);
  assert.deepEqual(p.registry_implemented, []);
  assert.deepEqual(p.registry_planned, OPS);
  assert.equal(p.scope_addition.version, 7);
  assert.match(p.boundary, /Sandbox PayU jest publiczny/);
  const rows = integrations.rows.filter(row => row.provider === 'payu');
  assert.deepEqual(rows.map(row => row.operation), OPS);
  for (const row of rows) {
    assert.equal(row.status, 'planned_acceptance_unverified');
    assert.equal(row.required_evidence_level, 'account');
    for (const level of ['code', 'local', 'sandbox', 'account']) assert.deepEqual(row.evidence[level], []);
    assert.equal(row.acceptance.length, 4);
    assert.equal(row.acceptance_state.ack_loss, MUTATIONS.includes(row.operation) ? 'pending' : 'pending_or_read_only_not_applicable');
    assert.match(row.acceptance[2], MUTATIONS.includes(row.operation) ? /^ACK-loss payu\// : /^Utrata odpowiedzi payu\//);
    const req = current.requirements.find(r => r.key === `integrations:operation:${row.id}`);
    assert.equal(req.required_evidence_level, 'account');
    assert.equal(req.definition.operation_contract.discovery_status, undefined);
  }
  assert.match(rows.find(r => r.operation === 'notification.receive').requirement, /OpenPayu-Signature/);
  assert.match(rows.find(r => r.operation === 'order.create').requirement, /extOrderId/);
});

test('the existing generator reproduces v7 exactly, inventories stay valid and complete scope is refused', async () => {
  assert.equal(envelope.schema, 'dynaminds-parity-scope-freeze-request/v1');
  assert.equal(envelope.output, base + '/scope.v7.json');
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

test('successor path refuses edits, removal and level downgrade of inherited rows, including v6 additions', async () => {
  await changedIntegrations(d => { d.rows[0].requirement += ' changed'; },
    q => assert.rejects(createScopeSnapshot(q, {root}), e => e.code === 'REQUIRED_REDEFINED'));
  await changedIntegrations(d => { d.rows.find(r => r.provider === 'dhl').requirement += ' changed'; },
    q => assert.rejects(createScopeSnapshot(q, {root}), e => e.code === 'REQUIRED_REDEFINED'));
  await changedIntegrations(d => { d.rows.shift(); },
    q => assert.rejects(createScopeSnapshot(q, {root}), e => e.code === 'REQUIRED_REMOVED'));
  await changedIntegrations(d => { d.rows = d.rows.filter(r => r.provider !== 'ksef'); },
    q => assert.rejects(createScopeSnapshot(q, {root}), e => e.code === 'REQUIRED_REMOVED'));
  await changedIntegrations(d => { d.rows.find(r => r.provider === 'inpost').required_evidence_level = 'local'; },
    q => assert.rejects(createScopeSnapshot(q, {root}), e => e.code === 'REQUIRED_LEVEL_DOWNGRADE'));
  await changedIntegrations(d => { d.rows.find(r => r.provider === 'pocztapolska').required_evidence_level = 'sandbox'; },
    q => assert.rejects(createScopeSnapshot(q, {root}), e => e.code === 'REQUIRED_LEVEL_DOWNGRADE'));
});
