#!/usr/bin/env node
/** Classifies tests/*.test.* for CI (docs/ci/README.md):
 *   static  — no PostgreSQL; runs in "CI Gate" without a database,
 *   db      — ordinary disposable database per file (fresh name dynaminds_test_<13 digits>, port CI_DB_PORT),
 *   special — needs an environment public CI does not have (PG04 clone, dedicated cluster port, private env),
 *             or is quarantined (fails on main, "quarantine" in the config); skipped in CI and listed with
 *             a reason in every run,
 *   darwin  — static, but pins bytes only macOS produces (e.g. gzipSync output digests); runs in the
 *             "Static tests (macOS zlib)" job on macOS instead of the Linux parts ("darwin" in the config only).
 * Deterministic: reads only the file text and scripts/ci/test-classes.json (manual overrides win).
 *
 *   node scripts/ci/classify-tests.mjs                 summary (counts + special list)
 *   node scripts/ci/classify-tests.mjs --list db       one path per line (static|db|darwin|special)
 *   node scripts/ci/classify-tests.mjs --json          {static, db, darwin, special:[{file,reason}]}
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONFIG = 'scripts/ci/test-classes.json';
const TEST_FILE = /^tests\/[^/]+\.test\.(?:ts|tsx|mts|mjs)$/;

export function loadConfig(root = ROOT) {
  const config = JSON.parse(readFileSync(join(root, CONFIG), 'utf8'));
  for (const key of ['special', 'quarantine', 'darwin', 'db', 'static', 'freshDatabase', 'noGuardCache']) {
    for (const file of Object.keys(config[key] ?? {})) {
      if (!TEST_FILE.test(file)) throw new Error(`${CONFIG}: ${key} "${file}" nie jest plikiem tests/*.test.*`);
      if (!existsSync(join(root, file))) throw new Error(`${CONFIG}: ${key} "${file}" nie istnieje — usuń wpis`);
    }
  }
  return config;
}

/** Tracked test files when in git (an untracked scratch test must not reach CI), else the directory. */
export function testFiles(root = ROOT) {
  let files;
  try {
    files = execFileSync('git', ['ls-files', '-z', 'tests'], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] }).split('\0');
  } catch {
    files = readdirSync(join(root, 'tests')).map((f) => 'tests/' + f);
  }
  return files.filter((f) => TEST_FILE.test(f)).sort();
}

// Signals that a file talks to PostgreSQL itself (or through a tests/ helper that does).
const DB_SIGNALS = [
  [/\.database\.test\./, 'nazwa *.database.test.*', 'name'],
  [/['"](?:\.\.\/)+server\/db(?:\.ts)?['"]/, 'import server/db'],
  [/\bprocess\.env\.DATABASE_URL\b|\bDATABASE_URL\b/, 'DATABASE_URL'],
  [/from\s+['"]pg['"]|require\(\s*['"]pg['"]\s*\)|import\(\s*['"]pg['"]\s*\)/, 'pakiet pg'],
  [/\bmigrate\s*\(/, 'migrate()'],
  [/\bscripts\/test\.ts\b/, 'scripts/test.ts'],
];
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
const RESOLVE_EXT = ['', '.ts', '.tsx', '.mts', '.mjs', '.js', '/index.ts', '/index.mjs'];

function resolveImport(fromFile, spec, root) {
  const base = posix.normalize(posix.join(posix.dirname(fromFile), spec));
  for (const ext of RESOLVE_EXT) {
    const cand = base + ext;
    if (existsSync(join(root, cand)) && statSync(join(root, cand)).isFile()) return cand;
  }
  // TS ESM style: './x.js' written for './x.ts'
  const stripped = base.replace(/\.(?:js|mjs)$/, '');
  for (const ext of ['.ts', '.tsx', '.mts']) if (existsSync(join(root, stripped + ext))) return stripped + ext;
  return null;
}

export function localImports(file, text, root = ROOT) {
  const out = new Set();
  for (const m of text.matchAll(IMPORT)) {
    const r = resolveImport(file, m[1], root);
    if (r) out.add(r);
  }
  return [...out];
}

/** Name every CI database gets: matches both /^dynaminds_test_\d+$/ and /^dynaminds_test_[0-9]{13}$/ guards. */
export const CI_DB_NAME_EXAMPLE = 'dynaminds_test_1731350000000';

// Variables CI provides to every db file (scripts/ci/run-db-tests.mjs); asserting them is not a special need.
const CI_ENV = new Set(['DYNA_TEST', 'DATABASE_URL', 'DYNA_TEST_PG_PORT', 'DYNA_LOCAL_CONFIG_PATH']);

function requiredEnvironment(text, ciPort) {
  // Port a file insists on: assert.equal(x.port,'57084') / assert(... x.port==='57081' ...).
  const ports = new Set();
  for (const m of text.matchAll(/assert(?:\.\w+)?\(\s*[\w.$[\]'"()!]*\.port\s*,\s*['"](\d{4,5})['"]/g)) ports.add(m[1]);
  for (const m of text.matchAll(/assert\([^;\n]*?\.port\s*===?\s*['"](\d{4,5})['"]/g)) ports.add(m[1]);
  for (const p of ports) if (Number(p) !== ciPort) return `wymaga usługi na porcie ${p} (asercja portu; klon PG04 = 57084)`;
  // Database name a file insists on (PG04 clones are named, e.g. dynaminds_m236_20261027_NN). Only URLs built
  // from DATABASE_URL / databaseUrl count — HTTP mocks assert pathnames too.
  const dbVars = new Set();
  for (const m of text.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*new URL\(\s*(?:process\.env\.DATABASE_URL|[\w.]*databaseUrl)/g)) dbVars.add(m[1]);
  const isDbUrl = (subject) => /DATABASE_URL|databaseUrl/.test(subject) || dbVars.has(subject.trim());
  for (const m of text.matchAll(/assert\.match\(\s*([^,;]*)\.pathname\s*,\s*\/((?:\\\/|[^/\n])+)\/([a-z]*)/g)) {
    if (!isDbUrl(m[1])) continue;
    let re;
    try { re = new RegExp(m[2], m[3]); } catch { continue; }
    if (!re.test('/' + CI_DB_NAME_EXAMPLE)) return `wymaga sklonowanej bazy ${m[2].replace(/\\\//g, '/')} (klon PG04)`;
  }
  for (const m of text.matchAll(/assert\.equal\(\s*([^,;]*)\.pathname\s*,\s*['"](\/[^'"]+)['"]/g)) {
    if (isDbUrl(m[1]) && m[2] !== '/' + CI_DB_NAME_EXAMPLE) return `wymaga konkretnej bazy ${m[2].slice(1)} (klon PG04)`;
  }
  // Private switches a file asserts before running: assert(process.env.X) / assert.equal(process.env.X,'true').
  for (const m of text.matchAll(/assert(?:\.ok|\.equal|\.strictEqual)?\(\s*process\.env\.([A-Z][A-Z0-9_]*)\s*[,)]/g)) {
    if (!CI_ENV.has(m[1])) return `wymaga zmiennej środowiskowej ${m[1]}`;
  }
  return null;
}

/** Requirements a tests/ helper carries: at module level (every importer inherits them) and per exported
 * function (only importers that call it), e.g. failure-helpers.ts assertS4Clone() → PG04 clone. */
function helperRequirements(text, ciPort) {
  const functions = new Map();
  let outside = text;
  for (const m of text.matchAll(/export\s+(?:async\s+)?function\s+(\w+)\s*\([^)]*\)[^{]*\{/g)) {
    let depth = 0, end = -1;
    for (let i = m.index + m[0].length - 1; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}' && --depth === 0) { end = i; break; }
    }
    if (end < 0) continue;
    const body = text.slice(m.index, end + 1);
    outside = outside.replace(body, '');
    const req = requiredEnvironment(body, ciPort);
    if (req) functions.set(m[1], req);
  }
  return { module: requiredEnvironment(outside, ciPort), functions };
}

export function classify(root = ROOT) {
  const config = loadConfig(root);
  const ciPort = Number(config.ciDatabasePort ?? 55432);
  const files = testFiles(root);
  const texts = new Map();
  const read = (f) => {
    if (!texts.has(f)) texts.set(f, readFileSync(join(root, f), 'utf8'));
    return texts.get(f);
  };
  // tests/ helpers (fixtures etc.) that touch the database make their importers db tests too.
  const helperDb = new Map();
  const helperUsesDb = (f, seen = new Set()) => {
    if (helperDb.has(f)) return helperDb.get(f);
    if (seen.has(f)) return null;
    seen.add(f);
    const text = read(f);
    let why = DB_SIGNALS.find(([re, , kind]) => kind !== 'name' && re.test(text))?.[1] ?? null;
    if (!why) {
      for (const dep of localImports(f, text, root)) {
        if (!dep.startsWith('tests/') || TEST_FILE.test(dep)) continue;
        const sub = helperUsesDb(dep, seen);
        if (sub) { why = `${dep} → ${sub}`; break; }
      }
    }
    helperDb.set(f, why);
    return why;
  };

  const helperReq = new Map();
  const inheritedRequirement = (file, text) => {
    for (const dep of localImports(file, text, root)) {
      if (!dep.startsWith('tests/') || TEST_FILE.test(dep)) continue;
      if (!helperReq.has(dep)) helperReq.set(dep, helperRequirements(read(dep), ciPort));
      const req = helperReq.get(dep);
      if (req.module) return `${req.module} (przez ${dep})`;
      for (const [fn, why] of req.functions) {
        if (new RegExp(`\\b${fn}\\s*\\(`).test(text)) return `${why} (przez ${dep} ${fn}())`;
      }
    }
    return null;
  };

  const result = { static: [], db: [], darwin: [], special: [] };
  const reasons = {};
  for (const file of files) {
    if (config.special?.[file]) { result.special.push({ file, reason: config.special[file] }); continue; }
    // Quarantine: a test that fails on main for a reason unrelated to CI; skipped like special until fixed.
    if (config.quarantine?.[file]) { result.special.push({ file, reason: 'kwarantanna — ' + config.quarantine[file] }); continue; }
    if (config.darwin?.[file]) { result.darwin.push(file); reasons[file] = 'macOS: ' + config.darwin[file]; continue; }
    if (config.static?.[file]) { result.static.push(file); reasons[file] = 'ręcznie: ' + config.static[file]; continue; }
    const text = read(file);
    let env = requiredEnvironment(text, ciPort);
    if (!env) env = inheritedRequirement(file, text);
    if (env && !config.db?.[file]) { result.special.push({ file, reason: env }); continue; }
    if (config.db?.[file]) { result.db.push(file); reasons[file] = 'ręcznie: ' + config.db[file]; continue; }
    let why = DB_SIGNALS.find(([re, , kind]) => (kind === 'name' ? re.test(file) : re.test(text)))?.[1] ?? null;
    if (!why) {
      for (const dep of localImports(file, text, root)) {
        if (!dep.startsWith('tests/') || TEST_FILE.test(dep)) continue;
        const sub = helperUsesDb(dep);
        if (sub) { why = `${dep} → ${sub}`; break; }
      }
    }
    if (why) { result.db.push(file); reasons[file] = why; } else result.static.push(file);
  }
  return { ...result, reasons };
}

function main(argv) {
  const r = classify();
  const listIdx = argv.indexOf('--list');
  if (listIdx >= 0) {
    const kind = argv[listIdx + 1];
    if (!['static', 'db', 'darwin', 'special'].includes(kind)) throw new Error('--list static|db|darwin|special');
    const rows = kind === 'special' ? r.special.map((s) => s.file) : r[kind];
    if (rows.length) process.stdout.write(rows.join('\n') + '\n');
    return;
  }
  if (argv.includes('--json')) {
    process.stdout.write(JSON.stringify({ static: r.static, db: r.db, darwin: r.darwin, special: r.special }, null, 1) + '\n');
    return;
  }
  if (argv.includes('--why')) {
    for (const [f, why] of Object.entries(r.reasons)) process.stdout.write(`${f}\t${why}\n`);
    return;
  }
  const total = r.static.length + r.db.length + r.darwin.length + r.special.length;
  console.log(`Pliki testów: ${total} — static ${r.static.length}, db ${r.db.length}, darwin ${r.darwin.length}, special ${r.special.length}`);
  console.log('Tylko na macOS (darwin, job „Static tests (macOS zlib)”):');
  for (const f of r.darwin) console.log(`  ${f} — ${r.reasons[f].slice('macOS: '.length)}`);
  console.log('Pomijane w CI (special):');
  for (const s of r.special) console.log(`  ${s.file} — ${s.reason}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
