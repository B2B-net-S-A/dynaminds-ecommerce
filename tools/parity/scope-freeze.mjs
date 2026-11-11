/** File-only scope snapshots. A complete scope is not accepted implementation. */
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {checkInventories,resolveParityCliRoot} from './check.mjs';
import {loadEvidenceArchive,retainedEvidenceRef} from './evidence-archive.mjs';

const SCHEMA = 'dynaminds-parity-scope-snapshot/v1';
const LEVELS = ['local', 'sandbox', 'account'];
const SOURCES = ['domains', 'integrations', 'providerRoster'];
const MAX = 8 * 1024 * 1024;
const sha = b => createHash('sha256').update(b).digest('hex');
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export class ScopeFreezeError extends Error {
  constructor(code) { super(code); this.name = 'ScopeFreezeError'; this.code = code; }
}
const need = (v, code) => { if (!v) throw new ScopeFreezeError(code); };
const keys = (v, wanted) => object(v) && Object.keys(v).sort().join(',') === [...wanted].sort().join(',');
const absolute = v => typeof v === 'string' && path.isAbsolute(v) && path.resolve(v) === v;
const id = v => typeof v === 'string' && v.length > 0 && v.length <= 240 && !/[\u0000-\u001f]/.test(v);
const within = (p, root) => p !== root && p.startsWith(root + path.sep);
const identity = s => [s.dev,s.ino,s.mode,s.uid,s.nlink,s.size,s.mtimeNs,s.ctimeNs].join(':');

/** Exact refs, no symlink traversal, same file before/open/after; no private-data discovery. */
async function pinned(ref, root, parseJSON = true) {
  need(keys(ref, ['path','sha256','bytes']) && absolute(ref.path) && within(ref.path, root) &&
    /^[a-f0-9]{64}$/.test(ref.sha256) && Number.isSafeInteger(ref.bytes) && ref.bytes > 0 && ref.bytes <= MAX, 'INPUT_REF');
  need(await fs.realpath(ref.path) === ref.path, 'INPUT_CANONICAL');
  const before = await fs.lstat(ref.path, {bigint:true});
  need(before.isFile() && !before.isSymbolicLink() && before.size === BigInt(ref.bytes), 'INPUT_FILE');
  const fd = await fs.open(ref.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let failed = false;
  try {
    need(identity(await fd.stat({bigint:true})) === identity(before), 'INPUT_IDENTITY');
    const bytes = await fd.readFile();
    need(bytes.length === ref.bytes && sha(bytes) === ref.sha256, 'INPUT_DIGEST');
    need(identity(await fd.stat({bigint:true})) === identity(before) &&
      identity(await fs.lstat(ref.path, {bigint:true})) === identity(before) && await fs.realpath(ref.path) === ref.path, 'INPUT_IDENTITY');
    return parseJSON ? JSON.parse(new TextDecoder('utf8', {fatal:true}).decode(bytes)) : null;
  } catch (e) { failed = true; throw e; }
  finally { try { await fd.close(); } catch (e) { if (!failed) throw e; } }
}

// Progress and evidence may change without changing the functional denominator.
// All other fields, including future contract fields, are normative by default.
const PROGRESS_FIELDS = new Set(['id','status','evidence','verification','acceptance_state','full_goal_acceptance',
  'implementation_assessment','registry_declaration','review_note','bound_scope','docs','planned_gap','required_evidence_level']);
function normativeDefinition(value, progressFields = PROGRESS_FIELDS) {
  const result = Object.fromEntries(Object.entries(value).filter(([key]) => !progressFields.has(key)));
  if (object(result.operation_contract)) {
    result.operation_contract = Object.fromEntries(Object.entries(result.operation_contract)
      .filter(([key]) => key !== 'discovery_status'));
  }
  return result;
}
const operationDefinition = row => normativeDefinition(row);
// Gaps have no separately lifted evidence level or operation definition. Keep
// bound_scope/docs/required_evidence_level and future contract fields normative.
const GAP_PROGRESS_FIELDS = new Set(['id','status','evidence','verification','acceptance_state','full_goal_acceptance',
  'implementation_assessment','registry_declaration','review_note','closed','resolution']);
/** Top-level named *_gaps arrays are declared scope collections. Resolved companions
 * retain the original collection identity; unknown contract fields remain normative. */
function gapCollections(document) {
  need(Array.isArray(document.coverage_gaps), 'COVERAGE_GAPS');
  return Object.entries(document).filter(([name]) => /^(?:[A-Za-z][A-Za-z0-9_]*_)?gaps$/.test(name)).map(([name, gaps]) => {
    need(Array.isArray(gaps), 'COVERAGE_GAPS');
    const resolved = name.startsWith('resolved_');
    return {collection:resolved ? name.slice('resolved_'.length) : name, state:resolved ? 'resolved' : 'open', gaps};
  });
}

function requiredScope(documents) {
  const records = [], seen = new Set();
  const add = (source, kind, name, definition, required_evidence_level = null, state = null) => {
    need(id(name), 'REQUIRED_ID');
    const key = `${source}:${kind}:${name}`;
    need(!seen.has(key), 'DUPLICATE_REQUIRED_ID'); seen.add(key);
    records.push({key, source, kind, id:name, definition, required_evidence_level, state});
  };
  for (const source of ['domains','integrations']) {
    const doc = documents[source];
    for (const row of doc.rows) {
      const level = row.required_evidence_level ?? (row.provider ? 'account' : 'local');
      need(LEVELS.includes(level), 'REQUIRED_LEVEL');
      add(source, 'operation', row.id, operationDefinition(row), level);
    }
  }
  const integrations = documents.integrations;
  need(Array.isArray(integrations.providers), 'REGISTRY_PROVIDERS');
  for (const p of integrations.providers) add('integrations', 'registry_provider', p.id, {name:p.name ?? p.id});
  const roster = documents.providerRoster;
  need(roster.schema === 'dynaminds-base-provider-roster/v1' && Array.isArray(roster.entries) && roster.entries.length > 0 &&
    Array.isArray(roster.pages), 'ROSTER_SCHEMA');
  for (const p of roster.entries) {
    need(typeof p.name === 'string' && p.name && id(p.category), 'ROSTER_PROVIDER');
    const url = new URL(p.canonical_base_url);
    need(url.origin === 'https://base.com' && !url.username && !url.password && !url.search && !url.hash, 'ROSTER_URL');
    const level = p.required_evidence_level ?? (p.id?.startsWith('base.platform.') ? 'local' : 'account');
    need(LEVELS.includes(level), 'REQUIRED_LEVEL');
    add('providerRoster', 'provider', p.id, {name:p.name, category:p.category, canonical_base_url:p.canonical_base_url}, level);
  }
  for (const p of roster.pages) add('providerRoster', 'category', p.id, {label:p.label ?? p.id, url:p.url ?? null});
  for (const label of roster.provenance?.main_catalog?.taxonomy_buckets ?? []) {
    need(id(label), 'CATEGORY_LABEL');
    add('providerRoster', 'taxonomy', sha(label), {label});
  }
  for (const source of SOURCES) {
    const doc = documents[source];
    for (const {collection, state, gaps} of gapCollections(doc)) {
      for (const gap of gaps) {
        need(object(gap), 'GAP_OBJECT');
        const requirement = gap.requirement ?? gap.description;
        need(typeof requirement === 'string' && requirement.trim(), 'GAP_REQUIREMENT');
        if (state === 'resolved') need(gap.closed === true && typeof gap.resolution === 'string' && gap.resolution.trim() &&
          Array.isArray(gap.evidence) && gap.evidence.length > 0, 'GAP_RESOLUTION');
        add(source, 'gap', gap.id, {collection, contract:normativeDefinition(gap, GAP_PROGRESS_FIELDS)}, null, state);
      }
    }
  }
  return records.sort((a,b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

function idsFor(records) {
  return Object.fromEntries(SOURCES.map(source => [source,
    records.filter(r => r.source === source).map(r => r.key)]));
}

// Discovery source codes are metadata, never operation/provider requirements.
// Keep their exact case and separate variants even when names or logos match.
function catalogueInventory(roster, ref, allowAbsent = false) {
  const catalog = roster.autocomplete_catalog;
  if (catalog === undefined && allowAbsent) return null;
  need(object(catalog) && Array.isArray(catalog.entries) && object(catalog.source), 'CATALOGUE_INVENTORY');
  const source = catalog.source;
  need(source.url === 'https://base.com/ajax/getFullList.php' && source.method === 'GET' &&
    source.http_status === 200 && source.authenticated === false && source.business_operation === false &&
    /^\d{4}-\d{2}-\d{2}$/.test(source.observed_on) && /^[a-f0-9]{64}$/.test(source.sha256_response_bytes) &&
    Number.isSafeInteger(source.response_bytes) && source.response_bytes > 0 &&
    typeof source.raw_response_persisted === 'boolean', 'CATALOGUE_SOURCE');
  const seen = new Set(), entries = catalog.entries.map(entry => {
    need(keys(entry, ['code','name','logo']) && id(entry.code) && id(entry.name) &&
      typeof entry.logo === 'string' && entry.logo.length > 0 && !/[\u0000-\u001f]/.test(entry.logo), 'CATALOGUE_ENTRY');
    need(!seen.has(entry.code), 'CATALOGUE_DUPLICATE_CODE'); seen.add(entry.code);
    return {code:entry.code, name:entry.name, logo:entry.logo};
  }).sort((a,b) => a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
  return {schema:'dynaminds-parity-catalogue-inventory/v1', source_ref:structuredClone(ref),
    source_pointer:'/autocomplete_catalog', recorded_source:structuredClone(source), entries,
    identity_resolution:'unresolved', provider_operations_inferred:false, raw_response_revalidated:false,
    boundary:'Pinned roster metadata preserves recorded source codes; the recorded HTTP hash is not a new verification of raw response bytes or provider availability.'};
}
function validateParent(parent, root) {
  need(parent?.schema === SCHEMA && Number.isSafeInteger(parent.version) && parent.version >= 1 && id(parent.goal) &&
    ['partial','complete'].includes(parent.snapshot_kind) && parent.acceptance_granted === false && parent.inventory_mutated === false &&
    Array.isArray(parent.requirements) && parent.requirements.length > 0, 'PARENT_SCHEMA');
  need(parent.version === 1 ? parent.parent === null :
    keys(parent.parent, ['path','sha256','bytes']) && absolute(parent.parent.path) && within(parent.parent.path, root) &&
    /^[a-f0-9]{64}$/.test(parent.parent.sha256) && Number.isSafeInteger(parent.parent.bytes) && parent.parent.bytes > 0 && parent.parent.bytes <= MAX,
    'PARENT_ANCESTRY');
  const seen = new Set();
  for (const r of parent.requirements) {
    need(object(r) && SOURCES.includes(r.source) && id(r.kind) && id(r.id) &&
      r.key === `${r.source}:${r.kind}:${r.id}` && !seen.has(r.key) && object(r.definition) &&
      (r.required_evidence_level === null || LEVELS.includes(r.required_evidence_level)) &&
      (r.state === null || ['open','resolved'].includes(r.state)), 'PARENT_REQUIREMENT');
    seen.add(r.key);
  }
  need(JSON.stringify(parent.required_ids) === JSON.stringify(idsFor(parent.requirements)), 'PARENT_REQUIRED_IDS');
}

async function loadScopeInputs(inputs, root, evidenceArchive) {
  need(keys(inputs, SOURCES), 'INPUTS_SCHEMA');
  const documents = {};
  for (const source of SOURCES) documents[source] = await pinned(inputs[source], root);
  const archive=evidenceArchive===undefined?undefined:await loadEvidenceArchive(evidenceArchive,{root});
  const checked = await checkInventories(['domains','integrations'].map(name => ({name, document:documents[name]})), {root,...(evidenceArchive===undefined?{}:{evidenceArchive})});
  need(checked.valid, 'INVENTORY_INVALID');
  const requirements = requiredScope(documents);
  for (const source of SOURCES) for (const {state, gaps} of gapCollections(documents[source]))
    if (state === 'resolved') for (const gap of gaps) for (const ref of gap.evidence) await pinned(retainedEvidenceRef(archive,ref), root, false);
  const roster = documents.providerRoster;
  const scopeClosed = checked.inventories.every(x => x.coverage_closed) && roster.inventory_complete === true &&
    roster.coverage_complete === true && roster.summary?.full_base_roster_complete !== false &&
    requirements.every(r => r.kind !== 'gap' || r.state === 'resolved');
  return {documents, checked, requirements, scopeClosed};
}

/** Partial snapshots are valid before acceptance; complete means complete scope only. */
export async function createScopeSnapshot(request, {root} = {}) {
  need(absolute(root) && await fs.realpath(root) === root, 'ROOT_CANONICAL');
  const catalogueEnabled = object(request) && Object.hasOwn(request, 'catalogue_inventory_version');
  const archiveEnabled=object(request)&&Object.hasOwn(request,'evidence_archive');
  need(keys(request,['goal','version','snapshot_kind','inputs','parent',...(catalogueEnabled?['catalogue_inventory_version']:[]),...(archiveEnabled?['evidence_archive']:[])])&&
    (!catalogueEnabled||request.catalogue_inventory_version===1)&&id(request.goal)&&
    Number.isSafeInteger(request.version)&&request.version>=1&&['partial','complete'].includes(request.snapshot_kind)&&keys(request.inputs,SOURCES),'REQUEST_SCHEMA');
  const {documents, checked, requirements, scopeClosed} = await loadScopeInputs(request.inputs, root,request.evidence_archive);
  const catalogue = catalogueEnabled ? catalogueInventory(documents.providerRoster, request.inputs.providerRoster) : null;
  const byKey = new Map(requirements.map(r => [r.key,r]));
  let parent = null;
  if (request.parent === null) need(request.version === 1, 'GENESIS_VERSION');
  else {
    parent = await pinned(request.parent, root); validateParent(parent, root);
    need(parent.goal === request.goal && request.version === parent.version + 1, 'PARENT_LINEAGE');
    // Verify one bounded parent cut from its own pinned inputs; never follow an
    // unbounded ancestry chain or trust self-declared requirements alone.
    let priorEvidenceArchive = parent.evidence_archive ?? request.evidence_archive;
    if (parent.evidence_archive !== undefined && request.evidence_archive !== undefined) {
      // A successor may retain an additional historical file after code drift.
      // Every parent mapping (including provenance and exact retained location)
      // must survive; a new archive cannot replace or remove old authority.
      await loadEvidenceArchive(parent.evidence_archive, {root});
      const previous = await pinned(parent.evidence_archive, root);
      const current = await pinned(request.evidence_archive, root);
      need(previous.entries.every(entry => current.entries.some(next =>
        JSON.stringify(next) === JSON.stringify(entry))), 'PARENT_EVIDENCE_ARCHIVE_CHANGED');
      priorEvidenceArchive = request.evidence_archive;
    }
    const prior = await loadScopeInputs(parent.inputs, root,priorEvidenceArchive);
    need(parent.as_of === prior.documents.domains.as_of &&
      JSON.stringify(parent.requirements) === JSON.stringify(prior.requirements) &&
      parent.scope_complete === prior.scopeClosed && (parent.snapshot_kind !== 'complete' || prior.scopeClosed),
      'PARENT_DERIVED_SCOPE');
    const parentHasCatalogue = Object.hasOwn(parent, 'catalogue_inventory');
    if (parentHasCatalogue || catalogueEnabled || prior.documents.providerRoster.autocomplete_catalog !== undefined) {
      const priorCatalogue = catalogueInventory(prior.documents.providerRoster, parent.inputs.providerRoster, !parentHasCatalogue);
      if (parentHasCatalogue) {
        need(JSON.stringify(parent.catalogue_inventory) === JSON.stringify(priorCatalogue), 'PARENT_DERIVED_CATALOGUE');
        need(catalogueEnabled, 'CATALOGUE_DISABLED');
      }
      // Legacy output stays byte-exact, but known codes still cannot disappear
      // by stripping the optional metadata from a rehashed parent snapshot.
      const currentCatalogue = catalogue ?? catalogueInventory(documents.providerRoster, request.inputs.providerRoster, true);
      const codes = new Set(currentCatalogue?.entries.map(entry => entry.code));
      for (const entry of priorCatalogue?.entries ?? []) need(codes.has(entry.code), 'CATALOGUE_CODE_REMOVED');
    }
    for (const before of parent.requirements) {
      const after = byKey.get(before.key);
      need(after, 'REQUIRED_REMOVED');
      need(JSON.stringify(before.definition) === JSON.stringify(after.definition), 'REQUIRED_REDEFINED');
      need(before.required_evidence_level === null || after.required_evidence_level !== null &&
        LEVELS.indexOf(after.required_evidence_level) >= LEVELS.indexOf(before.required_evidence_level), 'REQUIRED_LEVEL_DOWNGRADE');
    }
  }
  if (request.snapshot_kind === 'complete') need(scopeClosed, 'SCOPE_STILL_PARTIAL');
  return {schema:SCHEMA, as_of:documents.domains.as_of, goal:request.goal, version:request.version,
    snapshot_kind:request.snapshot_kind, scope_complete:scopeClosed, parent:structuredClone(request.parent),
    inputs:structuredClone(request.inputs), required_ids:idsFor(requirements), requirements,
    changes:{added:requirements.filter(r => !parent?.requirements.some(p => p.key === r.key)).map(r => r.key), removed:[]},
    inventory_check:{valid:checked.valid, coverage_closed:checked.inventories.map(x => ({name:x.name, closed:x.coverage_closed})),
      evidence_files_verified:checked.evidence_files_verified}, acceptance_granted:false, inventory_mutated:false,
    review_required:true, boundary:'A complete scope snapshot does not accept code, UI, contracts, sandbox, accounts or full Goal.',
    ...(catalogueEnabled ? {catalogue_inventory:catalogue} : {}),
    ...(archiveEnabled ? {evidence_archive:structuredClone(request.evidence_archive)} : {})};
}

/** ABI: node scope-freeze.mjs REQUEST_PATH REQUEST_SHA [--root=canonical-absolute-directory]. */
export async function main(args) {
  const selected = await resolveParityCliRoot(args, path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'));
  args = selected.args;
  need(args.length === 2 && absolute(args[0]) && /^[a-f0-9]{64}$/.test(args[1]), 'CLI_ABI');
  const root = selected.root;
  const stat = await fs.lstat(args[0]);
  const envelope = await pinned({path:args[0],sha256:args[1],bytes:stat.size}, root);
  need(keys(envelope, ['schema','snapshot','output']) && envelope.schema === 'dynaminds-parity-scope-freeze-request/v1' &&
    absolute(envelope.output) && within(envelope.output,root) && await fs.realpath(path.dirname(envelope.output)) === path.dirname(envelope.output), 'CLI_REQUEST');
  const manifest = await createScopeSnapshot(envelope.snapshot, {root});
  const bytes = Buffer.from(JSON.stringify(manifest,null,2)+'\n');
  need(bytes.length <= MAX, 'OUTPUT_LIMIT');
  const fd = await fs.open(envelope.output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let failed = false;
  try { await fd.writeFile(bytes); await fd.sync(); }
  catch (e) { failed = true; throw e; }
  finally { try { await fd.close(); } catch (e) { if (!failed) throw e; } }
  const result = {status:'SCOPE_SNAPSHOT_WRITTEN_NOT_ACCEPTANCE',ref:{path:envelope.output,sha256:sha(bytes),bytes:bytes.length},
    snapshot_kind:manifest.snapshot_kind, acceptance_granted:false};
  process.stdout.write(JSON.stringify(result)+'\n'); return result;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch(e => { process.stderr.write(JSON.stringify({status:'SCOPE_FREEZE_REFUSED',code:e instanceof ScopeFreezeError?e.code:'FILE_OR_JSON_ERROR'})+'\n');process.exitCode=1; });
