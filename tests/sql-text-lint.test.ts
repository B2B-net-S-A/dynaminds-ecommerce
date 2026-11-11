/** SQL-injection audit B (29.10.2026): the app logs in as superuser `postgres` and drops to `dyna_app` with
 * SET LOCAL ROLE per transaction, so an injected `RESET ROLE` would run as superuser. Every `.query(` in server/
 * and shared/ must take SQL text that is a literal or is built only from constants (tests/sql-text-lint.ts); the
 * few reviewed exceptions are in tests/sql-text-allowlist.json with a reason each. No database. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Linter, sourceFiles, type Site } from './sql-text-lint';
import { review3 } from './sql-text-lint-review3';

const root = path.join(import.meta.dirname, '..');
const allow = JSON.parse(fs.readFileSync(path.join(root, 'tests/sql-text-allowlist.json'), 'utf8')) as {
  entries: { file: string; fn: string | null; key: string; class: string; why: string }[];
};
const allowed = (s: Site) => allow.entries.some((e) => e.file === s.file && e.fn === s.fn && e.key === s.key);
const show = (s: Site) => `${s.file}:${s.line} ${s.fn ?? '(module)'} key=${s.key}\n    ${s.text}\n    ← ${s.reason}`;

const files = sourceFiles(root);
const sites = new Linter(root, files).sites();

test('every .query() SQL text in server/ and shared/ is a literal, built from constants, or reviewed', () => {
  const open = sites.filter((s) => s.verdict === 'dynamic' && !allowed(s));
  assert.deepEqual(open.map(show), [], 'SQL text built from non-constant data: use $n parameters or a whitelist, or review it into tests/sql-text-allowlist.json');
});

test('the allow-list is current: every entry matches a dynamic site and carries a reason', () => {
  for (const e of allow.entries) {
    assert.ok(e.why.length >= 40 && e.class, `${e.file} ${e.fn}: entry without a reason`);
    assert.ok(sites.some((s) => s.verdict === 'dynamic' && s.file === e.file && s.fn === e.fn && s.key === e.key),
      `${e.file} ${e.fn} ${e.key}: no such dynamic site any more (fixed or edited); remove or re-review the entry`);
  }
});

test('the scan sees the whole corpus (a lexer regression would silently find nothing)', () => {
  assert.ok(files.length > 900, 'files ' + files.length);
  assert.ok(sites.length > 8000, 'sites ' + sites.length);
  assert.ok(sites.filter((s) => s.verdict === 'literal').length > 7000);
  assert.ok(sites.filter((s) => s.verdict === 'constant').length > 600);
});

/** Lint in-memory sources (fixtures under server/__sqli/) and return the verdicts of their .query() sites. */
function lint(sources: Record<string, string>): Site[] {
  return new Linter(root, [], sources).sites();
}
const one = (src: string, more: Record<string, string> = {}) => {
  const all = lint({ 'server/__sqli/a.ts': src, ...more }).filter((s) => s.file.startsWith('server/__sqli/'));
  assert.equal(all.length, 1, 'one site expected, got ' + all.length);
  return all[0]!;
};
const route2 = (body: string, pre = '') => `${pre}\n` + route(body);
const route = (body: string) => `import { app } from '../app';\napp.post('/x', async (req: any) => { const c: any = req.c;\n${body}\n});`;

// Each payload would change the statement, e.g. x = "1; RESET ROLE; DROP TABLE orders; --".
const injected: [string, string, Record<string, string>?][] = [
  ['template with a request value', route("await c.query(`SELECT * FROM t WHERE a='${req.body.x}'`);")],
  ['concatenation', route("await c.query('SELECT * FROM t WHERE a=' + req.query.id);")],
  ['WHERE builder fed by push', route("const where: string[] = ['tenant_id=$1'];\nif (req.body.name) where.push(`name='${req.body.name}'`);\nawait c.query('SELECT * FROM t WHERE ' + where.join(' AND '), []);")],
  ['object property appended', route("const f = { sql: 'a=$1', params: [1] as unknown[] };\nf.sql += ` AND b=${req.body.b}`;\nawait c.query(`SELECT 1 FROM t WHERE ${f.sql}`, f.params);")],
  ['helper returning SQL from its parameter', "function eq(col: string, v: string) { return `${col}='${v}'`; }\nexport async function list(c: any, q: { s: string }) { return c.query(`SELECT 1 FROM t WHERE ${eq('a', q.s)}`); }\nimport { app } from '../app';\napp.get('/x', async (req: any) => list(req.c, req.query));"],
  ['map over request data', route("await c.query(`SELECT ${req.body.cols.map((x: string) => `${x}`).join(',')} FROM t`);")],
  ['imported builder', "import { build } from './b';\nimport { app } from '../app';\napp.get('/x', async (req: any) => req.c.query(build(req.query.order)));", { 'server/__sqli/b.ts': "export function build(order: string) { return 'SELECT * FROM t ORDER BY ' + order; }" }],
  ['array filled through an alias', route("const where = ['true'];\nconst alias = where;\nalias.push(req.body.w);\nawait c.query('SELECT 1 WHERE ' + where.join(' AND '));")],
  ['.length of a parsed JSON body ({"length":"1;…"})', route("await c.query(`SELECT 1 LIMIT ${req.body.items.length}`);")],
  ['destructured request field', route("const { col } = req.body;\nawait c.query(`SELECT ${col} FROM t`);")],
  ['default parameter overridden by the caller', "async function pick(c: any, col = 'id') { return c.query(`SELECT ${col} FROM t`); }\nimport { app } from '../app';\napp.get('/x', async (req: any) => pick(req.c, req.query.col));"],
  ['one unsafe ternary branch', route("await c.query(`SELECT 1 FROM t ORDER BY ${req.body.desc ? 'a DESC' : req.body.order}`);")],
  ['String() / toString() of request data', route("await c.query('SELECT ' + String(req.body.n) + ',' + req.body.m.toString());")],
  ['column names from Object.keys(body)', route("const keys = Object.keys(req.body);\nawait c.query(`UPDATE t SET ${keys.map((k, i) => `${k}=$${i + 1}`).join(',')}`, Object.values(req.body));")],
  ['for…of over request data', route("const parts: string[] = [];\nfor (const p of req.body.parts) parts.push(p);\nawait c.query('SELECT ' + parts.join(','));")],
  ['let reassigned', route("let sql = 'SELECT 1';\nif (req.body.extra) sql = sql + ' UNION ' + req.body.extra;\nawait c.query(sql);")],
  ['object form text', route("await c.query({ text: `SELECT ${req.body.x}`, values: [] });")],
  ['function passed as a value (callers unknown)', "async function run(c: any, sql: string) { return c.query(sql); }\nexport const handlers = { run };"],
  ['exported helper without a caller here (called by a script)', "export async function exec(c: any, sql: string) { return c.query(sql); }"],
  ['object built from a spread of the body', route("const o = { ...req.body };\nawait c.query(`SELECT ${o.col} FROM t`);")],
  ['new Array of request values', route("await c.query('SELECT ' + new Array(req.body.a, req.body.b).join(','));")],
  ['generic call (its <> are not a comparison)', "function raw<T>(v: T) { return 'SELECT ' + String(v); }\nimport { app } from '../app';\napp.get('/x', async (req: any) => req.c.query(raw<string>(req.query.x)));"],
  // found by the security review of this lint (29.10): callers it could not see, mutation it did not track
  ['default import of a helper', "export default function run(c: any, sql: string) { return c.query(sql); }\nrun(null, 'SELECT 1');", { 'server/__sqli/b.ts': "import r from './a';\nimport { app } from '../app';\napp.get('/x', async (req: any) => r(req.c, req.query.q));" }],
  ['barrel re-export `export { run } from`', "export function run(c: any, sql: string) { return c.query(sql); }\nrun(null, 'SELECT 1');", { 'server/__sqli/idx.ts': "export { run } from './a';", 'server/__sqli/b.ts': "import { run } from './idx';\nimport { app } from '../app';\napp.get('/x', async (req: any) => run(req.c, req.query.q));" }],
  ['barrel `export * from`', "export function run(c: any, sql: string) { return c.query(sql); }\nrun(null, 'SELECT 1');", { 'server/__sqli/idx.ts': "export * from './a';", 'server/__sqli/b.ts': "import { run } from './idx';\nimport { app } from '../app';\napp.get('/x', async (req: any) => run(req.c, req.query.q));" }],
  ['method taken as a value', "const svc = { run: (c: any, sql: string) => c.query(sql) };\nsvc.run(null, 'SELECT 1');\nconst f = svc.run;\nimport { app } from '../app';\napp.get('/x', async (req: any) => f(req.c, req.query.q));"],
  ['method destructured', "const svc = { run: (c: any, sql: string) => c.query(sql) };\nsvc.run(null, 'SELECT 1');\nconst { run } = svc;\nimport { app } from '../app';\napp.get('/x', async (req: any) => run(req.c, req.query.q));"],
  ['method called by a string key', "const svc = { run: (c: any, sql: string) => c.query(sql) };\nsvc.run(null, 'SELECT 1');\nimport { app } from '../app';\napp.get('/x', async (req: any) => svc['run'](req.c, req.query.q));"],
  ['method passed as a callback', "const svc = { run: (sql: string) => db.query(sql) };\nconst db: any = null;\nsvc.run('SELECT 1');\nimport { app } from '../app';\napp.get('/x', async (req: any) => Promise.resolve(req.query.q).then(svc.run));"],
  ['ternary-of-arrays filled by a helper', "function fill(a: string[], v: string) { a.push(v); }\n" + route("const where = req.body.k ? ['a'] : ['b'];\nfill(where, req.body.x);\nawait c.query('SELECT 1 WHERE ' + where.join(' AND '));")],
  ['split() array filled by a helper', "function fill(a: string[], v: string) { a.push(v); }\n" + route("const where = 'a,b'.split(',');\nfill(where, req.body.x);\nawait c.query('SELECT ' + where.join(','));")],
  ['helper named like a built-in (add)', "function add(a: string[], v: string) { a.push(v); }\n" + route("const where = ['1=1'];\nadd(where, req.body.x);\nawait c.query('SELECT 1 WHERE ' + where.join(' AND '));")],
  ['array kept in another array and filled through it', route("const where = ['1=1'];\nconst holder: string[][] = [];\nholder.push(where);\nholder[0]!.push(req.body.x);\nawait c.query('SELECT 1 WHERE ' + where.join(' AND '));")],
  ['reduce accumulator filled in the callback', route("const parts = [1, 2].reduce((acc: string[], i) => { acc.push(req.body.x); return acc; }, []);\nawait c.query('SELECT ' + parts.join(','));")],
  ['parameter filled in a callee', "function addX(p: string[], v: string) { p.push(v); }\nfunction build(parts: string[], v: string) { addX(parts, v); return parts.join(','); }\n" + route("await c.query('SELECT ' + build(['a'], req.body.x));")],
  ['exported object changed by an importer', "export const CFG = { order: 'id' };\nexport async function list(c: any) { return c.query(`SELECT * FROM t ORDER BY ${CFG.order}`); }\nlist(null);", { 'server/__sqli/b.ts': "import { CFG } from './a';\nimport { app } from '../app';\napp.get('/x', async (req: any) => { CFG.order = req.query.o; });" }],
  ['exported array pushed by an importer', "export const W: string[] = ['1=1'];\nexport async function list(c: any) { return c.query('SELECT 1 WHERE ' + W.join(' AND ')); }\nlist(null);", { 'server/__sqli/b.ts': "import { W } from './a';\nimport { app } from '../app';\napp.get('/x', async (req: any) => { W.push(req.query.o); });" }],
  ['valueOf() of request data', route("await c.query('SELECT ' + req.body.x.valueOf());")],
  ['.length of a property a spread can override', route("const o = { list: ['a'], ...req.body };\nawait c.query(`SELECT 1 LIMIT ${o.list.length}`);")],
  ['query through .call', route("await c.query.call(c, 'SELECT ' + req.body.x);")],
  ['query by a string key', route("await c['query']('SELECT ' + req.body.x);")],
  // second review round (29.10): aliases through returns/identity/?:, wrapped receivers, member calls by name,
  // nested object aliases, computed-key callers

  ['return where (same file)', route2("const where: string[] = ['1=1'];\nfunction get() { return where; }\nget().push(req.body.x);\nawait c.query('SELECT 1 WHERE ' + where.join(' AND '));")],
  ['identity fn returns param', route2("const where: string[] = ['1=1'];\nconst alias = id(where);\nalias.push(req.body.x);\nawait c.query('SELECT 1 WHERE ' + where.join(' AND '));", "function id(a: string[]) { return a; }")],
  ['fallback || param', route2("const where: string[] = ['1=1'];\nconst alias = id2(where);\nalias.push(req.body.x);\nawait c.query('SELECT 1 WHERE ' + where.join(' AND '));", "function id2(a: string[]) { const w = null || a; return w; }")],
  ['ternary alias in same fn', route2("const where: string[] = ['1=1'];\nconst alias = req.body.k ? where : [];\nalias.push(req.body.x);\nawait c.query('SELECT 1 WHERE ' + where.join(' AND '));")],
  ['non-null push', route2("const where: string[] = ['1=1'];\nwhere!.push(req.body.x);\nawait c.query('SELECT 1 WHERE ' + where.join(' AND '));")],
  ['as-paren push', route2("const where: string[] = ['1=1'];\n(where as string[]).push(req.body.x);\nawait c.query('SELECT 1 WHERE ' + where.join(' AND '));")],
  ['paren push', route2("const where: string[] = ['1=1'];\n(where).push(req.body.x);\nawait c.query('SELECT 1 WHERE ' + where.join(' AND '));")],
  ['member call named update', route2("const where: string[] = ['1=1'];\nh.update(where, req.body.x);\nawait c.query('SELECT 1 WHERE ' + where.join(' AND '));", "const h = { update(a: string[], v: string) { a.push(v); } };")],
  ['member call named get', route2("const where: string[] = ['1=1'];\nh.get(where, req.body.x);\nawait c.query('SELECT 1 WHERE ' + where.join(' AND '));", "const h = { get(a: string[], v: string) { a.push(v); } };")],
  ['computed dispatch', "const svc = { run(c: any, sql: string) { return c.query(sql); }, other() {} };\nsvc.run(null, 'SELECT 1');\nimport { app } from '../app';\napp.get('/x', async (req: any) => (svc as any)[req.query.k](req.c, req.query.q));"],
  ['ns computed', "import * as B from './b';\nimport { app } from '../app';\napp.get('/x', async (req: any) => (B as any)[req.query.k](req.c, req.query.q));", { 'server/__sqli/b.ts': "export function run(c: any, sql: string) { return c.query(sql); }\nrun(null, 'SELECT 1');" }],
  ['ns string key', "import * as B from './b';\nimport { app } from '../app';\napp.get('/x', async (req: any) => (B as any)['run'](req.c, req.query.q));", { 'server/__sqli/b.ts': "export function run(c: any, sql: string) { return c.query(sql); }\nrun(null, 'SELECT 1');" }],
  ['dyn import string key', "import { app } from '../app';\napp.get('/x', async (req: any) => { const m: any = await import('./b'); return m['run'](req.c, req.query.q); });", { 'server/__sqli/b.ts': "export function run(c: any, sql: string) { return c.query(sql); }\nrun(null, 'SELECT 1');" }],
  ['dyn import computed', "import { app } from '../app';\napp.get('/x', async (req: any) => { const m: any = await import('./b'); return m[req.query.k](req.c, req.query.q); });", { 'server/__sqli/b.ts': "export function run(c: any, sql: string) { return c.query(sql); }\nrun(null, 'SELECT 1');" }],
  ['non-null method call', "const svc = { run(c: any, sql: string) { return c.query(sql); } };\nsvc.run(null, 'SELECT 1');\nimport { app } from '../app';\napp.get('/x', async (req: any) => svc.run!(req.c, req.query.q));"],
  ['reassigned primitive to array', route2("let where: any = '1=1';\nwhere = ['1=1'];\nfill(where, req.body.x);\nawait c.query('SELECT 1 WHERE ' + where.join ? where.join(' AND ') : where);", "function fill(a: string[], v: string) { a.push(v); }")],
  ['exported obj returned and mutated elsewhere', "import { getW } from './b';\nimport { app } from '../app';\napp.get('/x', async (req: any) => { getW().push(req.query.o); });", { 'server/__sqli/b.ts': "const W: string[] = ['1=1'];\nexport function getW() { return W; }\nexport async function list(c: any) { return c.query('SELECT 1 WHERE ' + W.join(' AND ')); }\nlist(null);" }],
  ['imported obj returned by importer', "import { W } from './b';\nimport { app } from '../app';\nexport function getW() { return W; }\napp.get('/x', async (req: any) => { getW().push(req.query.o); });", { 'server/__sqli/b.ts': "export const W: string[] = ['1=1'];\nexport async function list(c: any) { return c.query('SELECT 1 WHERE ' + W.join(' AND ')); }\nlist(null);" }],
  ['imported obj stored by ||', "import { W } from './b';\nimport { app } from '../app';\napp.get('/x', async (req: any) => { const z = req.query.k || W; z.push(req.query.o); });", { 'server/__sqli/b.ts': "export const W: string[] = ['1=1'];\nexport async function list(c: any) { return c.query('SELECT 1 WHERE ' + W.join(' AND ')); }\nlist(null);" }],
  ['param pushed via ternary alias', route2("const where: string[] = ['1=1'];\nbuild(where, req.body.x);\nawait c.query('SELECT 1 WHERE ' + where.join(' AND '));", "function build(a: string[], v: string) { const w = v ? a : []; w.push(v); }")],
  ['param pushed via return in callee', route2("const where: string[] = ['1=1'];\nid(where).push(req.body.x);\nawait c.query('SELECT 1 WHERE ' + where.join(' AND '));", "function id(a: string[]) { return a; }")],
  ['spread into push of holder', route2("const where: string[] = ['1=1'];\nconst h = [where];\nh[0].push(req.body.x);\nawait c.query('SELECT 1 WHERE ' + where.join(' AND '));")],
  ['Object.entries mutate', route2("const o: any = { text: 'select 1' };\nfor (const [k] of Object.entries(o)) { }\nObject.defineProperty(o, 'text', { value: req.body.x });\nawait c.query(o);")],
  ['Object.defineProperty/ Reflect.set', route2("const o: any = { text: 'select 1' };\nReflect.set(o, 'text', req.body.x);\nawait c.query(o);")],
  ['setter fn on obj', route2("const o: any = { text: 'select 1' };\nObject.defineProperty(o, 'text', { value: req.body.x });\nawait c.query(o.text);")],
  ['template concat with array toString', route2("const where: string[] = ['1=1'];\nwhere.splice(0, 1, req.body.x);\nawait c.query(`SELECT 1 WHERE ${where}`);")],
  ['unshift via apply', route2("const where: string[] = ['1=1'];\nwhere.push.apply(where, [req.body.x]);\nawait c.query(`SELECT 1 WHERE ${where.join(' ')}`);")],
  ['index assign nested', route2("const o: any = { a: { text: 'x' } };\no.a.text = req.body.x;\nawait c.query(o.a.text);")],
  ['Object.assign into nested', route2("const o: any = { a: { text: 'x' } };\nObject.assign(o.a, req.body);\nawait c.query(o.a.text);")],
  ['alias nested', route2("const o: any = { a: { text: 'x' } };\nconst inner = o.a;\ninner.text = req.body.x;\nawait c.query(o.a.text);")],
  ['alias via destructure', route2("const o: any = { a: { text: 'x' } };\nconst { a } = o;\na.text = req.body.x;\nawait c.query(o.a.text);")],
  ['alias via for-of', route2("const o: any = { a: { text: 'x' } };\nfor (const v of Object.values(o)) (v as any).text = req.body.x;\nawait c.query(o.a.text);")],
  ['alias via array index', route2("const parts = ['a', 'b'];\nconst p2 = parts.slice(0, 0);\nconst h = { parts };\nh.parts.push(req.body.x);\nawait c.query('SELECT ' + parts.join(','));")],
  ['alias via function return nested', route2("const o: any = { a: { text: 'x' } };\nconst get = () => o.a;\nget().text = req.body.x;\nawait c.query(o.a.text);")],
  ['alias via method on obj', route2("const o: any = { a: { text: 'x' }, get() { return this.a; } };\no.get().text = req.body.x;\nawait c.query(o.a.text);")],
];
for (const [name, src, more] of injected)
  test('injection is caught: ' + name, () => {
    // the injected site, or the indirect use that hands SQL text on (a second site), must be dynamic
    const all = lint({ 'server/__sqli/a.ts': src, ...(more ?? {}) }).filter((s) => s.file.startsWith('server/__sqli/'));
    assert.ok(all.some((s) => s.verdict === 'dynamic'), all.map(show).join('\n') || 'no site');
  });

const constant: [string, string][] = [
  ['bound parameters', route("await c.query('SELECT * FROM t WHERE a=$1', [req.body.x]);")],
  ['WHERE builder with placeholders only', route("const where = ['tenant_id=$1'], params: unknown[] = [req.c.tenant];\nif (req.body.name) { params.push(req.body.name); where.push(`name=$${params.length}`); }\nawait c.query(`SELECT * FROM t WHERE ${where.join(' AND ')}`, params);")],
  ['whitelisted identifier via a constant map', "const ORDER = { new: 'created_at DESC', old: 'created_at' } as const;\nimport { app } from '../app';\napp.get('/x', async (req: any) => req.c.query(`SELECT * FROM t ORDER BY ${ORDER[req.query.o as keyof typeof ORDER]}`));"],
  ['numbers only', route("await c.query(`SELECT 1 LIMIT ${Number(req.body.n) + 1} OFFSET ${req.body.p * 10}`);")],
  ['constant table list', "const TABLES = ['a', 'b'] as const;\nexport async function count(c: any) { for (const t of TABLES) await c.query(`SELECT count(*) FROM ${t}`); }\nexport async function call(c: any) { return count(c); }"],
  ['ternary of literals on a request flag', route("await c.query('SELECT * FROM t WHERE id=$1' + (req.body.lock ? ' FOR UPDATE' : ''), [req.body.id]);")],
];
for (const [name, src] of constant)
  test('constant SQL stays green: ' + name, () => {
    const s = one(src);
    assert.notEqual(s.verdict, 'dynamic', s.reason);
  });

// third review round: each case needs at least one dynamic site; the controls only steer literals with a request value
const REVIEW3_CONTROLS = new Set(['pattern default shadow', 'optional chain string', 'toISOString', 'shadow module level in function']);
for (const [name, src, more] of review3)
  test((REVIEW3_CONTROLS.has(name) ? 'review 3 control stays green: ' : 'review 3 injection is caught: ') + name, () => {
    const all = lint({ 'server/__sqli/a.ts': src, ...(more ?? {}) }).filter((s) => s.file.startsWith('server/__sqli/'));
    if (REVIEW3_CONTROLS.has(name)) assert.ok(all.length > 0 && all.every((s) => s.verdict !== 'dynamic'), all.map(show).join('\n'));
    else assert.ok(all.some((s) => s.verdict === 'dynamic'), all.map(show).join('\n') || 'no site');
  });

test('mutation of a real file: a request value spliced into crm.ts listCrmClients is caught', () => {
  const rel = 'server/crm.ts';
  const src = fs.readFileSync(path.join(root, rel), 'utf8');
  const from = "where += ` AND profile->>'${k}' ILIKE $${params.length}`;";
  assert.ok(src.includes(from), 'crm.ts changed: pick another mutation point');
  const mutated = src.replace(from, "where += ` AND profile->>'${k}' ILIKE '${q[k]}'`;");
  const before = new Linter(root, files).sites().filter((s) => s.file === rel && s.verdict === 'dynamic');
  const after = new Linter(root, files, { [rel]: mutated }).sites().filter((s) => s.file === rel && s.verdict === 'dynamic');
  assert.equal(before.length, 0);
  assert.equal(after.length, 1, after.map(show).join('\n'));
  assert.equal(after[0]!.fn, 'listCrmClients');
});
