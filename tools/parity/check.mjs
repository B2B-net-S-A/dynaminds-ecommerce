/** File-only inventory validation. It neither executes evidence nor grants product acceptance. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {loadEvidenceArchive,retainedEvidenceRef} from './evidence-archive.mjs';

const LEVELS = ['code', 'local', 'sandbox', 'account'];
const CLAIMS = new Map([
  ['accepted_v2', 'local'], ['accepted_local', 'local'], ['verified_local', 'local'], ['local_scoped_acceptance', 'local'],
  ['accepted_sandbox', 'sandbox'], ['accepted_account', 'account'],
]);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// `scope` is a descriptive string in both real inventories. Source discovery
// authority belongs to their schema-specific metadata, never to an absent or
// truthy label. Unknown schemas remain valid partial inputs, not full scopes.
function sourceCoverageClosed(doc) {
  let closed = false;
  if (doc.schema === 'dynaminds-base-functional-domain-inventory/v1')
    closed = object(doc.inventory_coverage) && doc.inventory_coverage.source_catalogue_exhaustive === true;
  else if (doc.schema === 'dynaminds-base-parity-integrations/v1')
    closed = object(doc.summary) && doc.summary.full_base_roster_complete === true;
  if (!closed) return false;
  // Explicit supplementary coverage claims must not contradict the authority.
  // A string scope is only a label; an object scope needs an explicit flag.
  if (doc.scope !== undefined && typeof doc.scope !== 'string' &&
      (!object(doc.scope) || doc.scope.coverage_complete !== true)) return false;
  if (Object.hasOwn(doc, 'coverage_complete') && doc.coverage_complete !== true) return false;
  for (const [metadata, field] of [[doc.summary, 'full_base_roster_complete'],
    [doc.inventory_coverage, 'source_catalogue_exhaustive']]) {
    if (metadata !== undefined && (!object(metadata) ||
        (Object.hasOwn(metadata, field) && metadata[field] !== true))) return false;
  }
  return true;
}

export async function checkInventories(inputs, {root, requireComplete = false, evidenceArchive} = {}) {
  const errors = [], inventories = [], ids = new Set(), checked = new Map();
  const error = (where, message) => errors.push({where, message});
  let archive;
  if(evidenceArchive!==undefined){try{archive=await loadEvidenceArchive(evidenceArchive,{root});}catch{error('evidence_archive','Explicit retained evidence archive is invalid or incomplete.');}}
  if (requireComplete && inputs.length === 0) error('inputs', 'A completion review needs inventories.');
  async function evidence(ref, where) {
    ref = ref?.ref ?? ref;
    if (!ref || typeof ref !== 'object' || !path.isAbsolute(ref.path ?? '') ||
        !/^[a-f0-9]{64}$/.test(ref.sha256 ?? '') || !Number.isSafeInteger(ref.bytes) || ref.bytes <= 0) {
      error(where, 'Accepted evidence needs an absolute path, SHA256 and positive byte count.');
      return;
    }
    ref=retainedEvidenceRef(archive,ref);
    const resolved = path.resolve(ref.path);
    if (root && resolved !== root && !resolved.startsWith(root + path.sep)) {
      error(where, 'Evidence must remain inside the local project.'); return;
    }
    if (checked.has(resolved)) {
      const prior = checked.get(resolved);
      if (prior.sha256 !== ref.sha256 || prior.bytes !== ref.bytes) error(where, 'Conflicting evidence pins.');
      return;
    }
    try {
      const stat = await fs.lstat(resolved);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== ref.bytes || stat.size > 32 * 1024 * 1024) {
        error(where, 'Evidence must be a bounded regular file with the declared size.'); return;
      }
      const bytes = await fs.readFile(resolved);
      if (sha(bytes) !== ref.sha256) error(where, 'Evidence SHA256 does not match.');
      else checked.set(resolved, {sha256: ref.sha256, bytes: bytes.length});
    } catch { error(where, 'Evidence is missing or unreadable.'); }
  }
  for (const {name, document: doc} of inputs) {
    const startErrors = errors.length;
    if (!doc || typeof doc.schema !== 'string' || doc.as_of !== '2026-10-17' ||
        !Array.isArray(doc.rows) || doc.rows.length === 0 || !Array.isArray(doc.coverage_gaps)) {
      error(name, 'Inventory needs schema, frozen reference date, nonempty rows and explicit coverage_gaps.'); continue;
    }
    const counts = {}, requiredOpen = [];
    for (const row of doc.rows) {
      const where = name + ':' + (row?.id ?? '?');
      if (!row || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{2,159}$/.test(row.id ?? '') || ids.has(row.id)) {
        error(where, 'Row IDs must be stable and globally unique.'); continue;
      }
      ids.add(row.id);
      if (typeof row.requirement !== 'string' || row.requirement.trim().length < 10 ||
          !Array.isArray(row.acceptance) || !row.acceptance.length ||
          row.acceptance.some(x => typeof x !== 'string' || !x.trim())) error(where, 'A concrete requirement and acceptance checks are required.');
      if (typeof row.status !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(row.status)) error(where, 'A machine-readable status is required.');
      const levels = row.evidence;
      if (!levels || LEVELS.some(level => !Array.isArray(levels[level]))) {
        error(where, 'Code, local, sandbox and account evidence must have separate arrays.'); continue;
      }
      counts[row.status] = (counts[row.status] ?? 0) + 1;
      const claimed = CLAIMS.get(row.status);
      const required = row.required_evidence_level ?? (row.provider ? 'account' : 'local');
      if (!['local', 'sandbox', 'account'].includes(required)) error(where, 'Unknown required evidence level.');
      if (claimed) {
        if (!levels[claimed].length) error(where, 'Accepted status has no evidence at its claimed level.');
        for (const ref of levels[claimed]) await evidence(ref, where + ':' + claimed);
      }
      for (const level of LEVELS) for (const entry of levels[level]) {
        const pin = entry?.ref ?? entry;
        if (pin && typeof pin === 'object' && 'sha256' in pin) await evidence(pin, where + ':' + level);
      }
      if (row.status === 'complete') {
        if (row.provider && required !== 'account') error(where, 'Provider completion requires account evidence; local scope remains separate.');
        const declared = row.verification?.[required];
        if (declared !== undefined && (typeof declared !== 'string' || !/^(accepted|verified|passed)(_|$)/.test(declared))) error(where, 'Complete status contradicts the declared verification state.');
        if (row.acceptance_state !== undefined && !['accepted', 'complete', 'passed'].includes(row.acceptance_state)) error(where, 'Complete status contradicts the acceptance state.');
        if (!levels[required]?.length) error(where, 'Complete status requires evidence at the required acceptance level.');
        for (const ref of levels[required] ?? []) await evidence(ref, where + ':' + required);
      }
      const sufficient = row.status === 'complete' || (claimed && LEVELS.indexOf(claimed) >= LEVELS.indexOf(required));
      if (!sufficient) requiredOpen.push(row.id);
    }
    const coverageClosed = doc.inventory_complete === true && doc.coverage_gaps.length === 0 && sourceCoverageClosed(doc);
    if (requireComplete && (!coverageClosed || requiredOpen.length)) error(name, 'Full coverage or required acceptance remains open.');
    inventories.push({name, rows: doc.rows.length, counts, coverage_closed: coverageClosed,
      coverage_gaps: doc.coverage_gaps.length, required_open: requiredOpen.length,
      structural_errors: errors.length - startErrors});
  }
  return {schema: 'dynaminds-parity-inventory-check/v1', valid: errors.length === 0,
    completion_review_candidate: errors.length === 0 && inventories.length === inputs.length && inventories.length > 0 &&
      inventories.every(x => x.coverage_closed && x.required_open === 0),
    acceptance_granted_by_checker: false, evidence_files_verified: checked.size, inventories, errors};
}

/** An explicit workspace boundary supports isolated checkouts. Inventory locations
 * stay relative to this tool's project; the option never discovers or rewrites inputs. */
export async function resolveParityCliRoot(args, defaultRoot) {
  const flags = args.filter(arg => arg.startsWith('--root='));
  if (flags.length > 1) throw Error('Use exactly one --root=canonical-absolute-directory.');
  const root = flags.length ? flags[0].slice('--root='.length) : defaultRoot;
  if (flags.length && (!path.isAbsolute(root) || path.resolve(root) !== root ||
      /[\x00-\x1f\x7f]/.test(root) || await fs.realpath(root) !== root || !(await fs.stat(root)).isDirectory()))
    throw Error('The explicit workspace root must be a canonical absolute directory.');
  return {root, args:args.filter(arg => !arg.startsWith('--root='))};
}

export async function main(args) {
  const project = fileURLToPath(new URL('../../', import.meta.url));
  const selected = await resolveParityCliRoot(args, path.dirname(project.replace(/\/$/, '')));
  if (selected.args.some(x => x !== '--require-complete')) throw Error('Usage: check.mjs [--require-complete] [--root=canonical-absolute-directory]');
  const root = selected.root;
  const inputs = [];
  for (const name of ['domains.json', 'integrations.json']) {
    const file = path.join(project, 'docs/parity', name);
    inputs.push({name, document: JSON.parse(await fs.readFile(file, 'utf8'))});
  }
  const result = await checkInventories(inputs, {root, requireComplete: selected.args.includes('--require-complete')});
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (!result.valid) process.exitCode = 1;
  return result;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(() => {process.stderr.write('Parity inventory check failed; inspect local inventory files.\n'); process.exitCode = 1;});
}
