/** Static SQL-text lint (SQL-injection audit B, 29.10). The app logs in as superuser `postgres` and drops to
 * `dyna_app` with SET LOCAL ROLE per transaction, so an injected `RESET ROLE` would run as superuser: no SQL text
 * may be built from request, import or provider data. This module finds every `.query(` call in server/ and
 * shared/ (.ts, .mts, .mjs) and checks that its SQL text (first argument, or `text` of an object argument) can
 * only be built from literals and constants. It is a conservative heuristic, not a type-checked proof: a small
 * evaluator over a token stream that answers "unsafe" whenever it cannot follow a value:
 *   - literals, numbers, booleans, templates whose substitutions are safe, `a + b`, `c ? a : b`, `a || b`,
 *     `a ?? b`, `a && b` (only the last operand can be a string), comparisons (booleans) and arithmetic other
 *     than `+` (numbers);
 *   - identifiers resolved lexically (per function): every initializer and every assignment, `+=`, push/unshift/
 *     set/add, field write (also through `x!`/`(x)`/`(x as T)` and from a module that imports the binding) must
 *     be safe; a value that may be an array/object may otherwise only be read (useKind: value-returning methods,
 *     .length, element reads followed further, index/property reads in expressions, read-only callees,
 *     read-only aliases) — any other use (return, alias, store, unknown method/callee) makes it unsafe;
 *     neither is `for…in` or a destructuring with defaults;
 *   - parameters: the argument at that position at every call site of the named function, found through imports,
 *     default imports, `export {…} from`/`export *` barrels, namespaces and `await import()` (`.map`-style
 *     callbacks: the element of a safe receiver, the index is a number; `x[k](…)` calls every function named
 *     as k can evaluate to, an unknown k makes callers unknown); a function or method referenced other
 *     than by a call, an exported function without a caller here, and a collection parameter changed inside its
 *     function cannot be followed;
 *   - calls of repository functions: every `return` (with parameters bound to the call-site arguments); a few
 *     built-ins that always yield numbers or are pure on safe input (Number, Math.*, join, map, slice, …);
 *   - imports are followed to the exporting file (`import { X } from './y'`, `import * as N from './y'`).
 * Whatever it cannot show needs a reviewed entry in tests/sql-text-allowlist.json (with a reason). */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

type T = 'str' | 'tb' | 'tm' | 'te' | 'num' | 'id' | 'p' | 're';
export interface Tok { t: T; v: string; s: number; e: number }

const ID0 = /[A-Za-z_$#À-￿]/;
const ID = /[A-Za-z0-9_$À-￿]/;
const REGEX_AFTER = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await', 'instanceof']);
const PUNCS = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '&&=', '||=', '??=', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<'];

/** Flat token stream; a template with substitutions is `tb expr (tm expr)* te`. `>>` is not merged so that
 * generic closers stay balanced. */
export function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  const stack: string[] = [];
  const n = src.length;
  let i = 0;
  const regexOk = () => {
    const p = toks.at(-1);
    if (!p) return true;
    if (p.t === 'p') return !(p.v === ')' || p.v === ']' || p.v === '}' || p.v === '++' || p.v === '--');
    if (p.t === 'id') { const pp = toks.at(-2); return REGEX_AFTER.has(p.v) && !(pp?.t === 'p' && (pp.v === '.' || pp.v === '?.')); }
    return p.t === 'tb' || p.t === 'tm';
  };
  const template = (start: number, first: boolean) => {
    let j = start, v = '';
    while (j < n && src[j] !== '`') {
      if (src[j] === '\\') { v += src.slice(j, j + 2); j += 2; continue; }
      if (src[j] === '$' && src[j + 1] === '{') {
        toks.push({ t: first ? 'tb' : 'tm', v, s: start, e: j + 2 });
        stack.push('${');
        return j + 2;
      }
      v += src[j]; j++;
    }
    toks.push({ t: first ? 'str' : 'te', v, s: start, e: j + 1 });
    return j + 1;
  };
  while (i < n) {
    const ch = src[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
    if (ch === '/' && src[i + 1] === '/') { const j = src.indexOf('\n', i); i = j < 0 ? n : j; continue; }
    if (ch === '/' && src[i + 1] === '*') { const j = src.indexOf('*/', i + 2); i = j < 0 ? n : j + 2; continue; }
    if (ch === "'" || ch === '"') {
      let j = i + 1, v = '';
      while (j < n && src[j] !== ch) { if (src[j] === '\\') { v += src.slice(j, j + 2); j += 2; continue; } v += src[j]; j++; }
      toks.push({ t: 'str', v, s: i, e: j + 1 }); i = j + 1; continue;
    }
    if (ch === '`') { i = template(i + 1, true); continue; }
    if (ch === '/' && regexOk()) {
      let j = i + 1, cls = false;
      while (j < n && src[j] !== '\n') {
        const c = src[j]!;
        if (c === '\\') { j += 2; continue; }
        if (cls) { if (c === ']') cls = false; } else if (c === '[') cls = true; else if (c === '/') break;
        j++;
      }
      j++;
      while (j < n && /[a-z]/.test(src[j]!)) j++;
      toks.push({ t: 're', v: src.slice(i, j), s: i, e: j }); i = j; continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i; while (j < n && /[0-9A-Za-z_.]/.test(src[j]!)) j++;
      toks.push({ t: 'num', v: src.slice(i, j), s: i, e: j }); i = j; continue;
    }
    if (ID0.test(ch)) {
      let j = i + 1; while (j < n && ID.test(src[j]!)) j++;
      toks.push({ t: 'id', v: src.slice(i, j), s: i, e: j }); i = j; continue;
    }
    if (ch === '{') stack.push('{');
    if (ch === '}') {
      const top = stack.pop();
      if (top === '${') { i = template(i + 1, false); continue; }
    }
    let v = PUNCS.find((p) => src.startsWith(p, i)) ?? ch;
    if (v === '?.' && /[0-9]/.test(src[i + 2] ?? '')) v = '?';
    toks.push({ t: 'p', v, s: i, e: i + v.length }); i += v.length;
  }
  return toks;
}

const OPEN: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

interface Fn { name: string | null; params: Param[]; ps: number; pe: number; bs: number; be: number; arrowExpr: boolean; head: number; parent: Fn | null; method: boolean }
interface Param { name: string; idx: number; pattern: boolean; rest: boolean; def: [number, number] | null }

export interface FileInfo {
  rel: string; src: string; toks: Tok[]; match: Int32Array; fns: Fn[];
  imports: Map<string, { from: string; name: string }>; namespaces: Map<string, string>;
  /** innermost function (index into fns) per token, -1 at module scope */
  encl: Int32Array; occ: Map<string, number[]>; decls: Map<string, DeclRec[]>;
  /** `export { local as exported }`: exported → local */
  exportAs: Map<string, string>;
  /** `export { a as b } from './x'` (names: exported → original) and `export * from './x'` (names null) */
  reexports: { from: string; names: Map<string, string> | null }[];
  /** the local name behind `export default` */
  defaultName: string | null;
}
interface DeclRec { q: number; scope: Fn | null; kind: 'simple' | 'pattern' | 'function' | 'catch' | 'forin' | 'forof'; init: [number, number] | null; blk?: [number, number] }

/** Bracket and template matching: match[open] = close, match[close] = open. Templates chain forward
 * tb→tm→…→te, and match[te] = tb (so a backward scan jumps over the whole template). */
function matchAll(toks: Tok[]): Int32Array {
  const m = new Int32Array(toks.length).fill(-1);
  const start = new Int32Array(toks.length).fill(-1);
  const st: number[] = [];
  for (let i = 0; i < toks.length; i++) {
    const k = toks[i]!;
    if ((k.t === 'p' && OPEN[k.v]) || k.t === 'tb') { st.push(i); start[i] = i; }
    else if (k.t === 'p' && (k.v === ')' || k.v === ']' || k.v === '}')) {
      const o = st.pop();
      if (o !== undefined) { m[o] = i; m[i] = o; }
    } else if (k.t === 'tm' || k.t === 'te') {
      const o = st.pop();
      if (o === undefined) continue;
      m[o] = i;
      if (k.t === 'tm') { start[i] = start[o]!; st.push(i); } else m[i] = start[o]!;
    }
  }
  return m;
}

const NOT_FN = new Set(['if', 'for', 'while', 'switch', 'with', 'catch', 'return', 'typeof', 'await', 'new', 'yield', 'void', 'delete', 'in', 'of', 'super', 'import']);

function parseParams(f: FileInfo, ps: number, pe: number): Param[] {
  const out: Param[] = [];
  let idx = 0, i = ps + 1;
  while (i < pe) {
    let j = i; let depth = 0;
    const start = i;
    let eq = -1;
    for (; j < pe; j++) {
      const k = f.toks[j]!;
      if (k.t === 'p' && (OPEN[k.v] || k.v === '<')) depth++;
      else if (k.t === 'p' && (k.v === ')' || k.v === ']' || k.v === '}' || k.v === '>')) depth--;
      else if (k.t === 'tb') { j = f.match[j]!; while (f.toks[j]!.t === 'tm') j = f.match[j]!; continue; }
      if (depth === 0 && k.t === 'p' && k.v === ',') break;
      if (depth === 0 && k.t === 'p' && k.v === '=' && eq < 0) eq = j;
    }
    let a = start;
    while (a < j && f.toks[a]!.t === 'id' && ['public', 'private', 'protected', 'readonly', 'override'].includes(f.toks[a]!.v) && f.toks[a + 1]?.t === 'id') a++;
    const first = f.toks[a];
    const rest = first?.t === 'p' && first.v === '...';
    const nameTok = rest ? f.toks[a + 1] : first;
    if (nameTok) {
      const pattern = nameTok.t === 'p' && (nameTok.v === '{' || nameTok.v === '[');
      out.push({ name: nameTok.t === 'id' ? nameTok.v : '', idx, pattern, rest, def: eq >= 0 ? [eq + 1, j] : null });
      if (pattern) {
        const close = f.match[a]!;
        for (let q = a + 1; q < close; q++) {
          const t = f.toks[q]!;
          // `= default` up to the next `,` or the end of this pattern level is an expression, not a binding
          if (t.t === 'p' && t.v === '=') { let d = 0; for (; q < close; q++) { const v = f.toks[q]!.v; if (OPEN[v]) d++; else if (v === ')' || v === ']' || v === '}') { if (d === 0) break; d--; } else if (v === ',' && d === 0) break; } q--; continue; }
          if (t.t === 'id' && !(f.toks[q + 1]?.t === 'p' && f.toks[q + 1]!.v === ':')) out.push({ name: t.v, idx, pattern: true, rest: false, def: null });
        }
      }
    }
    idx++; i = j + 1;
  }
  return out;
}

/** Skip a return-type annotation starting at `i` (the token after `:`); returns the index of `{` or `=>`. */
function skipType(f: FileInfo, i: number, limit: number): number {
  let prevOp = true, angle = 0;
  for (let j = i; j < limit; j++) {
    const k = f.toks[j]!;
    if (k.t === 'p' && k.v === '<') { angle++; prevOp = true; continue; }
    if (k.t === 'p' && k.v === '>') { angle--; prevOp = false; continue; }
    if (k.t === 'p' && k.v === '=>') { if (angle > 0) { prevOp = true; continue; } return j; }
    if (k.t === 'p' && k.v === '{') { if (prevOp || angle > 0) { j = f.match[j]!; prevOp = false; continue; } return j; }
    if (k.t === 'p' && (k.v === '(' || k.v === '[')) { j = f.match[j]!; prevOp = false; continue; }
    if (k.t === 'p' && k.v === ',' && angle > 0) { prevOp = true; continue; }
    if (k.t === 'p' && (k.v === ';' || k.v === ')' || k.v === ',' || k.v === '}' || k.v === '=')) return -1;
    prevOp = k.t === 'p' && ['|', '&', '<', ',', ':', '?', '.'].includes(k.v) || (k.t === 'id' && (k.v === 'keyof' || k.v === 'typeof' || k.v === 'readonly'));
  }
  return -1;
}

function findFns(f: FileInfo): Fn[] {
  const fns: Fn[] = [];
  const toks = f.toks;
  for (let i = 0; i < toks.length; i++) {
    const k = toks[i]!;
    if (!(k.t === 'p' && k.v === '(') && !(k.t === 'id' && toks[i + 1]?.t === 'p' && toks[i + 1]!.v === '=>')) continue;
    let ps: number, pe: number, params: Param[];
    if (k.t === 'id') { ps = i; pe = i; params = [{ name: k.v, idx: 0, pattern: false, rest: false, def: null }]; }
    else { ps = i; pe = toks[i]!.t === 'p' ? f.match[i]! : -1; if (pe < 0) continue; params = []; }
    let j = pe + 1;
    let next = toks[j];
    if (next?.t === 'p' && next.v === ':') { const q = skipType(f, j + 1, Math.min(toks.length, j + 400)); if (q < 0) continue; j = q; next = toks[j]; }
    if (!next) continue;
    let name: string | null = null, arrow = false, method = false, head = ps;
    if (next.t === 'p' && next.v === '=>') {
      arrow = true;
      // `const name = (…) =>` / `name: (…) =>`
      let h = ps - 1;
      if (toks[h]?.t === 'p' && toks[h]!.v === '>') { let d = 0; for (; h >= 0; h--) { const v = toks[h]!.v; if (v === '>') d++; else if (v === '<' && --d === 0) { h--; break; } } }
      if (toks[h]?.t === 'id' && toks[h]!.v === 'async') h--;
      if (toks[h]?.t === 'p' && toks[h]!.v === '=' && toks[h - 1]?.t === 'id' && /^(const|let|var)$/.test(toks[h - 2]?.v ?? '')) { name = toks[h - 1]!.v; head = h - 2; }
      // `const a = …, name = (…) =>` (a later declarator of the same list)
      else if (toks[h]?.t === 'p' && toks[h]!.v === '=' && toks[h - 1]?.t === 'id' && toks[h - 2]?.v === ',') { name = toks[h - 1]!.v; head = h - 1; }
      // `{ name: (…) => … }`: an object member, called as `.name(…)`
      else if (toks[h]?.t === 'p' && toks[h]!.v === ':' && toks[h - 1]?.t === 'id' && (toks[h - 2]?.v === '{' || toks[h - 2]?.v === ',')) { name = toks[h - 1]!.v; head = h - 1; method = true; }
      else if (toks[h]?.t === 'p' && toks[h]!.v === '=' && toks[h - 1]?.t === 'p' && toks[h - 1]!.v === ')') { /* typed const: skip */ }
      else if (toks[h]?.t === 'p' && toks[h]!.v === '=' && toks[h - 2]?.t === 'p' && toks[h - 2]!.v === ':') { /* const x: T = (…) => */ let q = h - 1; while (q > 0 && !(toks[q]!.t === 'p' && toks[q]!.v === ':' && /^(const|let|var)$/.test(toks[q - 2]?.v ?? ''))) q--; if (q > 0 && toks[q - 1]?.t === 'id') { name = toks[q - 1]!.v; head = q - 2; } }
    } else if (next.t === 'p' && next.v === '{') {
      let h = ps - 1;
      if (toks[h]?.t === 'p' && toks[h]!.v === '>') { let d = 0; for (; h >= 0; h--) { const v = toks[h]!.v; if (v === '>') d++; else if (v === '<' && --d === 0) { h--; break; } } }
      const nt = toks[h];
      if (nt?.t === 'id' && nt.v === 'function') { head = h; }
      else if (nt?.t === 'id' && toks[h - 1]?.t === 'id' && toks[h - 1]!.v === 'function') { name = nt.v; head = h - 1; }
      else if (nt?.t === 'id' && toks[h - 1]?.t === 'p' && toks[h - 1]!.v === '*' && toks[h - 2]?.v === 'function') { name = nt.v; head = h - 2; }
      else if (nt?.t === 'id' && !NOT_FN.has(nt.v) && !(toks[h - 1]?.t === 'p' && (toks[h - 1]!.v === '.' || toks[h - 1]!.v === '?.'))) { name = nt.v; method = true; head = h; }
      else if (nt?.t === 'p' && nt.v === ']' && f.match[h]! >= 0 && ['{', ','].includes(toks[f.match[h]! - 1]?.v ?? '')) { name = null; method = true; head = f.match[h]!; } // `[k](…) {}`
      else continue;
    } else continue;
    if (k.t === 'p') params = parseParams(f, ps, pe);
    let bs: number, be: number, arrowExpr = false;
    if (arrow) {
      bs = j + 1;
      if (toks[bs]?.t === 'p' && toks[bs]!.v === '{') be = f.match[bs]!;
      else {
        arrowExpr = true;
        let q = bs;
        for (; q < toks.length; q++) {
          const t = toks[q]!;
          if ((t.t === 'p' && OPEN[t.v]) || t.t === 'tb') { q = f.match[q]!; if (q < 0) break; while (toks[q]!.t === 'tm') q = f.match[q]!; continue; }
          if (t.t === 'p' && (t.v === ',' || t.v === ';' || t.v === ')' || t.v === ']' || t.v === '}')) break;
          if (t.t === 'tm' || t.t === 'te') break;
        }
        be = q;
      }
    } else { bs = j; be = f.match[j]!; }
    if (be < 0) continue;
    fns.push({ name, params, ps, pe, bs, be, arrowExpr, head, parent: null, method });
  }
  fns.sort((a, b) => a.ps - b.ps || b.be - a.be);
  f.encl = new Int32Array(toks.length).fill(-1);
  fns.forEach((fn, idx) => {
    const p = f.encl[fn.ps]!;
    fn.parent = p >= 0 && fns[p]!.be >= fn.be ? fns[p]! : null;
    f.encl.fill(idx, fn.ps, Math.min(toks.length, fn.be + 1));
  });
  return fns;
}

/** `./x` from fromRel → the .ts module (or index.ts) relative to root, from the linted set or the disk. */
function resolveModule(root: string, fromRel: string, spec: string, known: Set<string>): string | null {
  const exact = path.relative(root, path.resolve(path.dirname(path.join(root, fromRel)), spec));
  const base = exact.replace(/\.(js|ts|mjs|mts)$/, '');
  for (const rel of [exact, base + '.ts', base + '.mts', base + '.mjs', path.join(base, 'index.ts')])
    if (/\.(ts|mts|mjs)$/.test(rel) && (known.has(rel) || fs.existsSync(path.join(root, rel)))) return rel;
  return null;
}

function parseImports(f: FileInfo, root: string, known: Set<string>) {
  const toks = f.toks;
  for (let i = 0; i < toks.length; i++) {
    if (!(toks[i]!.t === 'id' && toks[i]!.v === 'import')) continue;
    let j = i + 1;
    if (toks[j]?.v === 'type') continue;
    const names: [string, string][] = [];
    let ns: string | null = null;
    if (toks[j]?.t === 'id' && toks[j]!.v !== 'from') { names.push(['default', toks[j]!.v]); j++; if (toks[j]?.v === ',') j++; }
    if (toks[j]?.v === '*' && toks[j + 1]?.v === 'as') { ns = toks[j + 2]!.v; j += 3; }
    if (toks[j]?.v === '{') {
      const c = f.match[j]!;
      for (let q = j + 1; q < c; q++) {
        if (toks[q]!.t !== 'id') continue;
        if (toks[q]!.v === 'type') continue;
        const orig = toks[q]!.v;
        if (toks[q + 1]?.v === 'as') { names.push([orig, toks[q + 2]!.v]); q += 2; } else names.push([orig, orig]);
      }
      j = c + 1;
    }
    if (toks[j]?.v !== 'from' || toks[j + 1]?.t !== 'str') continue;
    const spec = toks[j + 1]!.v;
    if (!spec.startsWith('.')) continue;
    const rel = resolveModule(root, f.rel, spec, known);
    if (!rel) continue;
    for (const [orig, local] of names) f.imports.set(local, { from: rel, name: orig });
    if (ns) f.namespaces.set(ns, rel);
  }
  for (const i of f.occ.get('export') ?? []) {
    // `export default name` / `export default (async) function name`
    if (toks[i + 1]?.v === 'default') {
      let q = i + 2;
      if (toks[q]?.v === 'async') q++;
      if (toks[q]?.v === 'function' || toks[q]?.v === 'class') q++;
      if (toks[q]?.v === '*') q++;
      if (toks[q]?.t === 'id') f.defaultName = toks[q]!.v;
      continue;
    }
    // `export * from './x'`
    if (toks[i + 1]?.v === '*' && toks[i + 2]?.v === 'from' && toks[i + 3]?.t === 'str') {
      const rel = resolveModule(root, f.rel, toks[i + 3]!.v, known);
      if (rel) f.reexports.push({ from: rel, names: null });
      continue;
    }
    if (toks[i + 1]?.v !== '{') continue;
    const c = f.match[i + 1]!;
    if (c < 0) continue;
    const names = new Map<string, string>();
    for (let q = i + 2; q < c; q++) {
      if (toks[q]!.t !== 'id' || toks[q]!.v === 'type') continue;
      if (toks[q + 1]?.v === 'as' && toks[q + 2]?.t === 'id') { names.set(toks[q + 2]!.v, toks[q]!.v); q += 2; } else names.set(toks[q]!.v, toks[q]!.v);
    }
    if (toks[c + 1]?.v === 'from' && toks[c + 2]?.t === 'str') {
      // `export { a as b } from './x'`
      const rel = resolveModule(root, f.rel, toks[c + 2]!.v, known);
      if (rel) f.reexports.push({ from: rel, names });
    } else for (const [exported, local] of names) if (exported !== local) f.exportAs.set(exported, local);
  }
}

/** One `.query(` call. key: sha256 (16 hex) of the whitespace-normalised SQL-text argument, which pins an
 * allow-list entry to the exact reviewed expression. */
export interface Site { file: string; line: number; col: number; fn: string | null; text: string; key: string; verdict: 'literal' | 'constant' | 'dynamic'; reason: string }

const NUMBER_FNS = new Set(['Number', 'parseInt', 'parseFloat']);
const PURE_METHODS = new Set(['join', 'slice', 'concat', 'trim', 'trimStart', 'trimEnd', 'toUpperCase', 'toLowerCase', 'toString', 'padStart', 'padEnd', 'repeat', 'at', 'flat', 'replace', 'replaceAll', 'substring', 'sort', 'reverse', 'filter', 'split', 'toSorted', 'toReversed', 'values', 'keys']);
/** Members that reach constructors or rebinding (`x.constructor(…)` can be Function(…)). */
const UNSAFE_MEMBERS = new Set(['constructor', 'prototype', '__proto__', 'call', 'apply', 'bind', '__defineGetter__', '__defineSetter__']);
const NUMBER_METHODS = new Set(['toFixed', 'indexOf', 'findIndex', 'lastIndexOf', 'getTime', 'localeCompare', 'toISOString', 'includes', 'some', 'every', 'has', 'startsWith', 'endsWith', 'test']);
/** Global functions that neither change nor keep their arguments. */
const GLOBAL_PURE = new Set(['String', 'Number', 'Boolean', 'BigInt', 'isNaN', 'isFinite', 'parseInt', 'parseFloat', 'structuredClone', 'encodeURIComponent', 'decodeURIComponent', 'Symbol']);
/** Writes into an array/Map/Set that the lint follows: their values are checked like assignments. */
const TRACKED_WRITES = new Set(['push', 'unshift', 'set', 'add', 'splice', 'fill']);
/** Methods whose result is a fresh string, number or boolean (the receiver is only read). */
const VALUE_READS = new Set(['join', 'includes', 'indexOf', 'lastIndexOf', 'has', 'toString', 'toLocaleString', 'startsWith', 'endsWith', 'trim', 'trimStart', 'trimEnd', 'toUpperCase', 'toLowerCase', 'localeCompare', 'test', 'padStart', 'padEnd', 'repeat', 'replace', 'replaceAll', 'substring', 'split', 'toFixed', 'toISOString', 'getTime', 'charAt', 'charCodeAt', 'codePointAt', 'normalize', 'match', 'search', 'delete', 'clear', 'digest']);
/** Methods that only read the receiver but may return its elements (or the receiver itself): their result is
 * followed like the receiver; callback element parameters must not be written. */
const ELEMENT_READS = new Set(['map', 'flatMap', 'filter', 'slice', 'concat', 'find', 'findLast', 'at', 'get', 'values', 'entries', 'keys', 'forEach', 'some', 'every', 'findIndex', 'reduce', 'flat', 'toSorted', 'toReversed', 'sort', 'reverse', 'pop', 'shift']);
/** Built-in methods (with no repository method of the same name) that only read their arguments. */
const BUILTIN_READ_ARG = new Set(['includes', 'indexOf', 'lastIndexOf', 'has', 'startsWith', 'endsWith', 'test', 'localeCompare', 'join', 'concat', 'digest', 'update', 'equal', 'deepEqual', 'strictEqual', 'notEqual', 'deepStrictEqual', 'notDeepStrictEqual', 'stringify', 'parse', 'safeParse', 'isArray', 'get', 'delete', 'some', 'every']);
const CALLBACK_METHODS = new Set(['map', 'flatMap', 'filter', 'forEach', 'some', 'every', 'find', 'findIndex', 'reduce']);

export class Linter {
  files = new Map<string, FileInfo>();
  memo = new Map<string, string | null>();
  busy = new Set<string>();
  /** files that `import('./x')` a module, by the module's relative path */
  dynImporters = new Map<string, Set<FileInfo>>();
  /** cycle hits: results computed while a cycle was cut optimistically are not memoised as safe */
  cycles = 0;
  /** rels: files to lint (relative to root); overrides: replacement or additional sources by relative path */
  constructor(public root: string, rels: string[], overrides: Record<string, string> = {}) {
    const known = new Set([...rels, ...Object.keys(overrides)]);
    for (const rel of known) {
      const src = overrides[rel] ?? fs.readFileSync(path.join(root, rel), 'utf8');
      const toks = lex(src);
      const f: FileInfo = { rel, src, toks, match: matchAll(toks), fns: [], imports: new Map(), namespaces: new Map(), encl: new Int32Array(0), occ: new Map(), decls: new Map(), exportAs: new Map(), reexports: [], defaultName: null };
      f.fns = findFns(f);
      toks.forEach((t, q) => { if (t.t === 'id') { const l = f.occ.get(t.v); if (l) l.push(q); else f.occ.set(t.v, [q]); } });
      parseImports(f, root, known);
      this.files.set(rel, f);
    }
    for (const f of this.files.values()) for (const q of f.occ.get('import') ?? []) {
      const t = f.toks;
      if (t[q + 1]?.v !== '(' || t[q + 2]?.t !== 'str' || !t[q + 2]!.v.startsWith('.')) continue;
      const rel = resolveModule(root, f.rel, t[q + 2]!.v, known);
      if (!rel) continue;
      const set = this.dynImporters.get(rel) ?? new Set();
      set.add(f);
      this.dynImporters.set(rel, set);
    }
  }

  line(f: FileInfo, tok: number) { const s = f.toks[tok]!.s; const before = f.src.slice(0, s); return [before.split('\n').length, s - before.lastIndexOf('\n')]; }

  /** End (exclusive) of the expression starting at i: next top-level `,` `;` `)` `]` `}` or template boundary. */
  exprEnd(f: FileInfo, i: number, limit = f.toks.length): number {
    for (let q = i; q < limit; q++) {
      const t = f.toks[q]!;
      if ((t.t === 'p' && OPEN[t.v]) || t.t === 'tb') { q = this.skip(f, q); continue; }
      if (t.t === 'p' && t.v === '<') { const c = this.genericClose(f, q, limit); if (c > 0) { q = c; continue; } }
      if (t.t === 'p' && (t.v === ',' || t.v === ';' || t.v === ')' || t.v === ']' || t.v === '}')) return q;
      if (t.t === 'tm' || t.t === 'te') return q;
    }
    return limit;
  }
  /** From an opener return the index of its final closer (for templates the `te`). */
  skip(f: FileInfo, q: number): number {
    let c = f.match[q]!;
    if (c < 0) return f.toks.length;
    while (f.toks[c]!.t === 'tm') c = f.match[c]!;
    return c;
  }

  /** Split [s,e) at top-level tokens satisfying pred. */
  split(f: FileInfo, s: number, e: number, pred: (t: Tok, q: number) => boolean): [number, number, string][] {
    const out: [number, number, string][] = [];
    let a = s, op = '';
    for (let q = s; q < e; q++) {
      const t = f.toks[q]!;
      if ((t.t === 'p' && OPEN[t.v]) || t.t === 'tb') { q = this.skip(f, q); continue; }
      if (t.t === 'p' && t.v === '<') { const c = this.genericClose(f, q, e); if (c > 0) { q = c; continue; } }
      if (pred(t, q)) { out.push([a, q, op]); op = t.v; a = q + 1; }
    }
    out.push([a, e, op]);
    return out;
  }

  enclosing(f: FileInfo, at: number): Fn | null {
    const i = at >= 0 && at < f.encl.length ? f.encl[at]! : -1;
    return i >= 0 ? f.fns[i]! : null;
  }

  /** null = safe; otherwise a reason. env binds parameter names for the function being evaluated. */
  safe(f: FileInfo, s: number, e: number, env: Env, depth: number): string | null {
    if (env.binds.size) return this.safe0(f, s, e, env, depth);
    const key = 'E:' + f.rel + ':' + s + ':' + e;
    if (this.memo.has(key)) return this.memo.get(key)!;
    if (this.busy.has(key)) { this.cycles++; return null; }
    this.busy.add(key);
    const c0 = this.cycles;
    const r = this.safe0(f, s, e, env, depth);
    this.busy.delete(key);
    if (r !== null || this.cycles === c0) this.memo.set(key, r);
    return r;
  }

  safe0(f: FileInfo, s: number, e: number, env: Env, depth: number): string | null {
    const toks = f.toks;
    if (s >= e) return 'empty expression';
    if (depth > 40) return 'too deep';
    // type assertions / non-null
    const asAt = this.split(f, s, e, (t, q) => this.isAssertion(f, q));
    if (asAt.length > 1) {
      // `x as T + y` is (x as T) + y: anything after the type is not followed, so it is not accepted
      if (this.typeEnd(f, asAt[0]![1] + 1, e) < e) return 'expression continues after a type assertion';
      return this.safe(f, s, asAt[0]![1], env, depth + 1);
    }
    if (toks[s]!.t === 'p' && toks[s]!.v === '<') return 'angle-bracket type assertion';
    if (toks[e - 1]!.t === 'p' && toks[e - 1]!.v === '!' ) return this.safe(f, s, e - 1, env, depth + 1);
    // ternary
    const parts = this.split(f, s, e, (t) => t.t === 'p' && t.v === '?');
    if (parts.length > 1) {
      // find the matching ':' for the first '?'
      let d = 0, colon = -1;
      for (let q = parts[0]![1] + 1; q < e; q++) {
        const t = toks[q]!;
        if ((t.t === 'p' && OPEN[t.v]) || t.t === 'tb') { q = this.skip(f, q); continue; }
        if (t.t === 'p' && t.v === '?') d++;
        else if (t.t === 'p' && t.v === ':') { if (d === 0) { colon = q; break; } d--; }
      }
      if (colon < 0) return 'unparsed ternary';
      return this.safe(f, parts[0]![1] + 1, colon, env, depth + 1) ?? this.safe(f, colon + 1, e, env, depth + 1);
    }
    for (const op of ['||', '??']) {
      const ps = this.split(f, s, e, (t) => t.t === 'p' && t.v === op);
      if (ps.length > 1) { for (const [a, b] of ps) { const r = this.safe(f, a, b, env, depth + 1); if (r) return r; } return null; }
    }
    const and = this.split(f, s, e, (t) => t.t === 'p' && t.v === '&&');
    if (and.length > 1) return this.safe(f, and.at(-1)![0], and.at(-1)![1], env, depth + 1);
    if (this.split(f, s, e, (t) => t.t === 'p' && ['|', '^', '&'].includes(t.v)).length > 1) return null;
    // comparisons are booleans; `<`/`>` of a generic call `f<T>(…)` are not comparisons
    const generic = this.genericTokens(f, s, e);
    for (let q = s; q < e; q++) { const t = toks[q]!; if ((t.t === 'p' && OPEN[t.v]) || t.t === 'tb') { q = this.skip(f, q); continue; } if (t.t === 'p' && t.v === '<' && !generic.has(q) && (q === s || !this.binaryPos(f, q))) return 'angle-bracket type assertion'; }
    if (this.split(f, s, e, (t, q) => q > s && !generic.has(q) && this.binaryPos(f, q) && ((t.t === 'p' && ['===', '!==', '==', '!=', '<=', '>=', '<', '>'].includes(t.v)) || (t.t === 'id' && (t.v === 'instanceof' || t.v === 'in') && !['.', '?.'].includes(f.toks[q - 1]?.v ?? '')))).length > 1) return null;
    if (this.split(f, s, e, (t) => t.t === 'p' && t.v === '<<').length > 1) return null;
    // additive chain (binary + / -): a '-' yields a number; '+' needs both sides safe
    const add = this.split(f, s, e, (t, q) => t.t === 'p' && (t.v === '+' || t.v === '-') && q > s && this.binaryPos(f, q));
    if (add.length > 1) {
      let acc: string | null = this.safe(f, add[0]![0], add[0]![1], env, depth + 1);
      for (const [a, b, op] of add.slice(1)) acc = op === '-' ? null : acc ?? this.safe(f, a, b, env, depth + 1);
      return acc;
    }
    const mul = this.split(f, s, e, (t, q) => t.t === 'p' && ['*', '/', '%', '**'].includes(t.v) && q > s);
    if (mul.length > 1) return null;
    const t0 = toks[s]!;
    if (t0.t === 'p' && ['-', '+', '~', '++', '--', '!'].includes(t0.v)) return null; // numbers / booleans
    if (t0.t === 'id' && (t0.v === 'typeof' || t0.v === 'void' || t0.v === 'delete')) return null;
    if (t0.t === 'id' && t0.v === 'await') return this.safe(f, s + 1, e, env, depth + 1);
    return this.postfix(f, s, e, env, depth);
  }

  /** `x as T` / `x satisfies T` (not a property named `as`). */
  isAssertion(f: FileInfo, q: number): boolean {
    const t = f.toks[q]!, pv = f.toks[q - 1];
    return t.t === 'id' && (t.v === 'as' || t.v === 'satisfies') && !(pv?.t === 'p' && (pv.v === '.' || pv.v === '?.')) && f.toks[q + 1]?.v !== ':' && f.toks[q + 1]?.v !== '(';
  }

  /** `name<A, B>(`: the index of the closing `>` of the type arguments starting at q, else -1. */
  genericClose(f: FileInfo, q: number, limit: number): number {
    const toks = f.toks;
    if (toks[q - 1]?.t !== 'id' || REGEX_AFTER.has(toks[q - 1]!.v)) return -1;
    let d = 0;
    for (let r = q; r < limit && r < q + 80; r++) {
      const t = toks[r]!;
      if (t.v === '<') d++;
      else if (t.v === '>') { if (--d === 0) return toks[r + 1]?.v === '(' ? r : -1; }
      else if ((t.t === 'p' && OPEN[t.v])) { r = f.match[r]!; if (r < 0) return -1; }
      else if (t.t === 'p' && !['.', ',', '|', '&', ':', '?', '=>'].includes(t.v)) return -1;
      else if (t.t === 'tb') return -1;
    }
    return -1;
  }

  /** End (exclusive) of a type starting at q (after `as`/`satisfies`). */
  typeEnd(f: FileInfo, q: number, e: number): number {
    const toks = f.toks;
    let r = q, expectOperand = true;
    while (r < e) {
      const t = toks[r]!;
      if (t.t === 'id' || t.t === 'str' || t.t === 'num') { if (!expectOperand && !['keyof', 'typeof', 'readonly', 'unique'].includes(toks[r - 1]!.v)) break; r++; expectOperand = ['keyof', 'typeof', 'readonly', 'unique'].includes(t.v); continue; }
      if (t.t === 'p' && (t.v === '.' || t.v === '|' || t.v === '&')) { r++; expectOperand = true; continue; }
      if (t.t === 'p' && t.v === '[') { r = f.match[r]! + 1; expectOperand = false; continue; }
      if (t.t === 'p' && (t.v === '{' || t.v === '(') && expectOperand) { r = f.match[r]! + 1; expectOperand = false; continue; }
      if (t.t === 'p' && t.v === '<') { let d = 0; for (; r < e; r++) { const v = toks[r]!.v; if (v === '<') d++; else if (v === '>' && --d === 0) break; } r++; expectOperand = false; continue; }
      break;
    }
    return r;
  }

  /** Token indices of type-argument lists `name<…>(` within [s,e). */
  genericTokens(f: FileInfo, s: number, e: number): Set<number> {
    const out = new Set<number>();
    for (let q = s + 1; q < e; q++) {
      if (f.toks[q]!.v !== '<' || f.toks[q - 1]!.t !== 'id') continue;
      let d = 0, r = q;
      for (; r < e && r < q + 80; r++) {
        const t = f.toks[r]!;
        if (t.v === '<') d++;
        else if (t.v === '>') { if (--d === 0) break; }
        else if (t.t === 'p' && !['.', ',', '[', ']', '|', '&', '{', '}', ':', '?', ';', '(', ')', '=>'].includes(t.v)) { r = e; break; }
      }
      if (r < e && d === 0 && f.toks[r + 1]?.v === '(') { for (let z = q; z <= r; z++) out.add(z); q = r; }
    }
    return out;
  }

  binaryPos(f: FileInfo, q: number): boolean {
    const p = f.toks[q - 1]!;
    if (p.t === 'p') return [')', ']', '}', '++', '--', '!'].includes(p.v);
    if (p.t === 'id') return !REGEX_AFTER.has(p.v);
    return p.t !== 'tb' && p.t !== 'tm';
  }

  /** primary followed by .x ?.x [i] (args) */
  postfix(f: FileInfo, s: number, e: number, env: Env, depth: number): string | null {
    const toks = f.toks;
    // locate the start of the last postfix operation
    let q = s;
    const segs: [number, number][] = []; // primary then ops
    const t0 = toks[s]!;
    let pe: number;
    if (t0.t === 'p' && OPEN[t0.v]) pe = f.match[s]! + 1;
    else if (t0.t === 'tb') pe = this.skip(f, s) + 1;
    else if (t0.t === 'id' && t0.v === 'new') return this.newExpr(f, s, e, env, depth);
    else pe = s + 1;
    // arrow function as value
    if (pe < e && toks[pe]?.t === 'p' && toks[pe]!.v === '=>') return 'function value';
    segs.push([s, pe]);
    q = pe;
    while (q < e) {
      const t = toks[q]!;
      if (t.t === 'p' && (t.v === '.' || t.v === '?.')) {
        if (toks[q + 1]?.t === 'p' && (toks[q + 1]!.v === '(' || toks[q + 1]!.v === '[')) { const c = f.match[q + 1]!; segs.push([q, c + 1]); q = c + 1; }
        else { segs.push([q, q + 2]); q += 2; }
      } else if (t.t === 'p' && (t.v === '(' || t.v === '[')) { const c = f.match[q]!; segs.push([q, c + 1]); q = c + 1; }
      else if (t.t === 'p' && t.v === '!') { q++; }
      else if (t.t === 'str' || t.t === 'tb') { // tagged template: only String.raw is the template itself
        const end = t.t === 'str' ? q + 1 : this.skip(f, q) + 1;
        if (f.src.slice(toks[s]!.s, toks[q - 1]!.e).replace(/\s+/g, '') !== 'String.raw') return 'tagged template';
        segs.length = 0; segs.push([q, end]); q = end;
      }
      else if (t.t === 'p' && t.v === '<') { // generic call f<T>(…)
        let d = 0, r = q;
        for (; r < e; r++) { const v = toks[r]!.v; if (v === '<') d++; else if (v === '>') { if (--d === 0) break; } }
        if (toks[r + 1]?.v === '(') { q = r + 1; continue; }
        return 'unparsed expression `' + f.src.slice(t.s, toks[e - 1]!.e).slice(0, 60) + '`';
      }
      else return 'unparsed expression `' + f.src.slice(toks[s]!.s, toks[e - 1]!.e).slice(0, 80) + '`';
    }
    return this.chain(f, segs, segs.length, env, depth);
  }

  /** `new Date(…)…` renders a date or a number; `new Array/Set/Map(args)` holds its arguments. */
  newExpr(f: FileInfo, s: number, e: number, env: Env, depth: number): string | null {
    const toks = f.toks;
    const name = toks[s + 1]?.v;
    let open = s + 2;
    if (toks[open]?.v === '<') { let d = 0; for (; open < e; open++) { const v = toks[open]!.v; if (v === '<') d++; else if (v === '>' && --d === 0) break; } open++; }
    if (name === 'Date') {
      const rest = toks[open]?.v === '(' ? f.match[open]! + 1 : open;
      if (rest >= e) return null;
      // `new Date(x).toISOString()` & co. render a date or a number; `.constructor…` could reach Function
      if (toks[rest]?.v === '.' && /^(to\w*String|toJSON|get\w+|valueOf)$/.test(toks[rest + 1]?.v ?? '') && toks[rest + 2]?.v === '(' && f.match[rest + 2] === e - 1) return null;
      return '`new Date` expression';
    }
    if (!['Array', 'Set', 'Map'].includes(name ?? '') || toks[open]?.v !== '(') return '`new ' + name + '` value';
    for (const [a, b] of this.args(f, open)) { const r = this.safe(f, a, b, env, depth + 1); if (r) return 'element of new ' + name + ': ' + r; }
    const rest = f.match[open]! + 1;
    if (rest === e) return null;
    // `.size`, `.length`, `.join(sep)` of the collection
    if (toks[rest]?.v === '.' && ['size', 'length'].includes(toks[rest + 1]?.v ?? '') && rest + 2 === e) return null;
    if (toks[rest]?.v === '.' && toks[rest + 1]?.v === 'join' && toks[rest + 2]?.v === '(' && f.match[rest + 2] === e - 1) {
      for (const [a, b] of this.args(f, rest + 2)) { const r = this.safe(f, a, b, env, depth + 1); if (r) return r; }
      return null;
    }
    return '`new ' + name + '` expression';
  }

  /** Safety of the value produced by segs[0..n). */
  chain(f: FileInfo, segs: [number, number][], n: number, env: Env, depth: number): string | null {
    const toks = f.toks;
    const [s0, e0] = segs[0]!;
    if (n === 1) return this.primary(f, s0, e0, env, depth);
    // a parameter used as a collection (p.join(), p.x, p[i]) must not be filled inside its function
    // (`.length`/`.size` stay numbers whatever is written into the collection)
    const lengthOnly = n === 2 && ['.', '?.'].includes(toks[segs[1]![0]]!.v) && ['length', 'size'].includes(toks[segs[1]![0] + 1]?.v ?? '');
    const changed = lengthOnly ? null : this.paramChanged(f, s0, e0);
    if (changed) return changed;
    const [ls, le] = segs[n - 1]!;
    const lt = toks[ls]!;
    const isCall = (lt.t === 'p' && lt.v === '(') || (lt.v === '?.' && toks[ls + 1]?.v === '(');
    if (isCall) {
      const open = lt.v === '(' ? ls : ls + 1;
      const args = this.args(f, open);
      // callee
      if (n - 1 === 1 && toks[s0]!.t === 'id' && e0 === s0 + 1) {
        const name = toks[s0]!.v;
        if (NUMBER_FNS.has(name) || name === 'Boolean') return null;
        if (name === 'String') return args[0] ? this.safe(f, args[0][0], args[0][1], env, depth + 1) : null;
        return this.callNamed(f, s0, name, args, env, depth);
      }
      // method call: receiver = segs[0..n-2), method = segs[n-2]
      const [ms] = segs[n - 2]!;
      const mt = toks[ms]!;
      if ((mt.v === '.' || mt.v === '?.') && toks[ms + 1]?.t === 'id') {
        const m = toks[ms + 1]!.v;
        // Math.x(…), Number.x(…), Object.keys(…).length etc.
        if (n - 2 === 1 && toks[s0]!.t === 'id' && (toks[s0]!.v === 'Math' || toks[s0]!.v === 'Number') && !UNSAFE_MEMBERS.has(m)) return null;
        if (n - 2 === 1 && toks[s0]!.t === 'id' && toks[s0]!.v === 'Array' && m === 'from') {
          const r = args[0] ? this.safe(f, args[0][0], args[0][1], env, depth + 1) : null;
          if (args[1]) return this.callback(f, args[1], r === null ? null : 'element of ' + r, env, depth);
          return r;
        }
        if (n - 2 === 1 && toks[s0]!.t === 'id' && toks[s0]!.v === 'Object' && m === 'keys') {
          return args[0] ? this.keysOf(f, args[0][0], args[0][1], env, depth + 1) : null;
        }
        if (n - 2 === 1 && toks[s0]!.t === 'id' && toks[s0]!.v === 'Object' && (m === 'values' || m === 'entries')) {
          return args[0] ? this.safe(f, args[0][0], args[0][1], env, depth + 1) : null;
        }
        if (n - 2 === 1 && toks[s0]!.t === 'id' && toks[s0]!.v === 'JSON') return '`JSON.' + m + '` value';
        if (n - 2 === 1 && toks[s0]!.t === 'id' && toks[s0]!.v === 'Object' && m === 'freeze') return args[0] ? this.safe(f, args[0][0], args[0][1], env, depth + 1) : null;
        if (NUMBER_METHODS.has(m)) return null;
        if (CALLBACK_METHODS.has(m)) {
          const recv = this.chain(f, segs, n - 2, env, depth + 1);
          if (m === 'filter' || m === 'find') return recv;
          if (m === 'forEach' || m === 'some' || m === 'every' || m === 'findIndex') return null;
          if (m === 'reduce') return args[0] ? this.callback(f, args[0], recv, env, depth, args[1] ?? null) : 'reduce';
          return args[0] ? this.callback(f, args[0], recv, env, depth) : recv;
        }
        if (PURE_METHODS.has(m)) {
          const recv = this.chain(f, segs, n - 2, env, depth + 1);
          if (recv) return recv;
          for (const [a, b] of args) { const r = this.safe(f, a, b, env, depth + 1); if (r) return r; }
          return null;
        }
        // namespace import N.fn(…)
        if (n - 2 === 1 && toks[s0]!.t === 'id' && f.namespaces.has(toks[s0]!.v)) {
          const target = this.files.get(f.namespaces.get(toks[s0]!.v)!);
          if (target) return this.callIn(target, m, args, f, env, depth);
        }
        // this.method(…) / obj.method(…) on a repository method
        if (n - 2 === 1 && toks[s0]!.t === 'id' && toks[s0]!.v === 'this') {
          const fns = f.fns.filter((x) => x.method && x.name === m);
          if (fns.length) return this.returns(f, fns, args, f, env, depth);
        }
        return 'call of `.' + m + '()`';
      }
      return 'call of computed function';
    }
    // member access
    if (lt.v === '.' || lt.v === '?.') {
      const prop = toks[ls + 1]?.v;
      if (prop === 'length' || prop === 'size') {
        // a number for arrays, strings and sets built in code; a parsed JSON body could carry {"length": "…"}
        const r = this.chain(f, segs, n - 1, env, depth + 1);
        if (r === null) return null;
        if (this.arrayish(f, s0, segs[n - 2]![1], null, depth + 1)) return null;
        return '`.' + prop + '` of ' + r;
      }
      // namespace member
      if (n === 2 && toks[s0]!.t === 'id' && f.namespaces.has(toks[s0]!.v)) {
        const target = this.files.get(f.namespaces.get(toks[s0]!.v)!);
        if (target) return this.moduleName(target, prop!, depth);
      }
    }
    // a named property: only that property of the receiver (object literals, their assignments, returns)
    if ((lt.v === '.' || lt.v === '?.') && toks[ls + 1]?.t === 'id') return this.propOf(f, s0, segs[n - 2]![1], toks[ls + 1]!.v, env, depth + 1);
    // index of a safe object or array: safe when the whole object is safe
    return this.chain(f, segs, n - 1, env, depth + 1);
  }

  /** Strip `await`, parentheses and `as T` around [s,e). */
  core(f: FileInfo, s: number, e: number): [number, number] {
    for (;;) {
      const asAt = this.split(f, s, e, (t, q) => this.isAssertion(f, q));
      if (asAt.length > 1 && this.typeEnd(f, asAt[0]![1] + 1, e) >= e) { e = asAt[0]![1]; continue; }
      if (f.toks[s]?.v === 'await' && s + 1 < e) { s++; continue; }
      if (f.toks[e - 1]?.v === '!' && e - 1 > s) { e--; continue; }
      if (f.toks[s]?.v === '(' && f.match[s] === e - 1) { s++; e--; continue; }
      return [s, e];
    }
  }

  /** Return expressions of a function. */
  returnRanges(f: FileInfo, fn: Fn): [number, number][] {
    if (fn.arrowExpr) return [[fn.bs, fn.be]];
    const out: [number, number][] = [];
    for (const q of f.occ.get('return') ?? []) {
      if (q <= fn.bs || q >= fn.be || this.enclosing(f, q) !== fn) continue;
      const end = this.exprEnd(f, q + 1, fn.be);
      if (end > q + 1) out.push([q + 1, end]);
    }
    return out;
  }

  /** Branches of a top-level ternary / || / ?? (values the expression can take), or null. */
  branches(f: FileInfo, s: number, e: number): [number, number][] | null {
    const parts = this.split(f, s, e, (t) => t.t === 'p' && t.v === '?');
    if (parts.length > 1) {
      let d = 0;
      for (let q = parts[0]![1] + 1; q < e; q++) {
        const t = f.toks[q]!;
        if ((t.t === 'p' && OPEN[t.v]) || t.t === 'tb') { q = this.skip(f, q); continue; }
        if (t.t === 'p' && t.v === '?') d++;
        else if (t.t === 'p' && t.v === ':') { if (d === 0) return [[parts[0]![1] + 1, q], [q + 1, e]]; d--; }
      }
      return null;
    }
    for (const op of ['||', '??']) {
      const ps = this.split(f, s, e, (t) => t.t === 'p' && t.v === op);
      if (ps.length > 1) return ps.map(([a, b]) => [a, b]);
    }
    return null;
  }

  /** Safety of `(expr).prop`. */
  propOf(f: FileInfo, s0: number, e0: number, prop: string, env: Env, depth: number): string | null {
    if (depth > 40) return 'too deep';
    const [s, e] = this.core(f, s0, e0);
    const br = this.branches(f, s, e);
    if (br) { for (const [a, b] of br) { const r = this.propOf(f, a, b, prop, env, depth + 1); if (r) return r; } return null; }
    const t = f.toks[s]!;
    if (t.v === '{' && f.match[s] === e - 1) return this.objectProp(f, [s, e], prop, env, depth + 1);
    if (t.t === 'id' && e === s + 1 && !f.namespaces.has(t.v)) return this.identProp(f, s, t.v, prop, env, depth + 1);
    if (t.t === 'id' && f.toks[s + 1]?.v === '(' && f.match[s + 1] === e - 1) {
      const found = this.findFn(f, s, t.v);
      if (found) return this.returns(found.file, [found.fn], this.args(f, s + 1), f, env, depth + 1, null, (ff, a, b, en, d) => this.propOf(ff, a, b, prop, en, d));
    }
    const whole = this.safe(f, s, e, env, depth + 1);
    return whole ? '`.' + prop + '` of ' + whole : null;
  }

  identProp(f: FileInfo, at: number, name: string, prop: string, env: Env, depth: number): string | null {
    const bound = env.binds.has(name) && this.bindingScope(f, at, name)?.param !== undefined;
    const d = bound ? null : this.declsOf(f, at, name);
    if (!d || d.kind !== 'decl' || d.bad) { const r = this.ident(f, at, name, env, depth + 1); return r ? '`.' + prop + '` of ' + r : null; }
    const key = 'IP:' + f.rel + ':' + (d.scope ? d.scope.ps : -1) + ':' + (d.blk ? d.blk[0] : -1) + ':' + name + '.' + prop;
    if (env.binds.size === 0 && this.memo.has(key)) return this.memo.get(key)!;
    if (this.busy.has(key)) { this.cycles++; return null; }
    this.busy.add(key);
    const c0 = this.cycles;
    let r: string | null = null;
    for (const [a, b] of d.inits) {
      if (r) break;
      if (a === b) continue;
      if (a < 0) { const w = this.safe(f, -a, b, env, depth + 1); r = w ? 'element of ' + w : null; }
      else r = this.propOf(f, a, b, prop, env, depth + 1);
    }
    for (const [a, b] of d.plain ?? []) { if (r) break; r = this.propOf(f, a, b, prop, env, depth + 1); }
    for (const m of d.members ?? []) { if (r) break; if (m.prop === null || m.prop === prop) r = this.safe(f, m.range[0], m.range[1], env, depth + 1); }
    this.busy.delete(key);
    if (r) r = '`' + name + '.' + prop + '` ← ' + r;
    if (env.binds.size === 0 && (r !== null || this.cycles === c0)) this.memo.set(key, r);
    return r;
  }

  /** The value of `(expr)` (or of `(expr).prop`) is an array, string, Set or Map created in code (so `.length` is a number). */
  arrayish(f: FileInfo, s0: number, e0: number, prop: string | null, depth: number): boolean {
    if (depth > 40) return false;
    const [s, e] = this.core(f, s0, e0);
    if (s >= e) return false;
    const br = this.branches(f, s, e);
    if (br) return br.every(([a, b]) => this.arrayish(f, a, b, prop, depth + 1));
    const toks = f.toks;
    const t = toks[s]!;
    if (prop === null) {
      if (t.v === '[' && f.match[s] === e - 1) return true;
      if (e === s + 1 && t.t === 'str') return true;
      if (t.t === 'tb' && this.skip(f, s) === e - 1) return true;
      if (t.v === 'new' && ['Array', 'Set', 'Map'].includes(toks[s + 1]?.v ?? '')) return true;
      if (toks[e - 1]!.v === ')') {
        const open = f.match[e - 1]!;
        const m = toks[open - 1];
        if (m?.t === 'id' && (toks[open - 2]?.v === '.' || toks[open - 2]?.v === '?.') && ['map', 'filter', 'flatMap', 'slice', 'concat', 'split', 'keys', 'values', 'entries', 'from', 'sort', 'toSorted', 'reverse', 'flat', 'join', 'trim', 'toUpperCase', 'toLowerCase'].includes(m.v)) return true;
      }
    } else if (t.v === '{' && f.match[s] === e - 1) {
      const entries = this.split(f, s + 1, e - 1, (x) => x.t === 'p' && x.v === ',');
      // a spread may override the property with anything (`{ list: [], ...req.body }`)
      if (entries.some(([a, b]) => a < b && toks[a]!.v === '...')) return false;
      for (const [a, b] of entries) {
        if (a >= b || toks[a]!.v !== prop) continue;
        if (b === a + 1) return this.arrayish(f, a, b, null, depth + 1);
        if (toks[a + 1]?.v === ':') return this.arrayish(f, a + 2, b, null, depth + 1);
      }
      return false;
    }
    if (t.t === 'id' && e === s + 1) {
      const d = this.declsOf(f, s, t.v);
      if (!d) return false;
      if (d.kind === 'param') {
        // every call passes an array (or the default is one)
        const fn = d.fn!, p = d.param!;
        if (!fn.name || p.pattern || p.rest) return false;
        const callers = this.callSites(f, fn);
        if (typeof callers === 'string') return false;
        return callers.every((c) => { const a = c.args[p.idx]; return a ? this.arrayish(c.file, a[0], a[1], prop, depth + 1) : !!p.def && this.arrayish(f, p.def[0], p.def[1], prop, depth + 1); });
      }
      if (d.kind === 'import') {
        const tf = this.files.get(d.imp!.from);
        if (!tf) return false;
        const at = tf.toks.findIndex((x, i) => x.t === 'id' && x.v === d.imp!.name && /^(const|let|var)$/.test(tf.toks[i - 1]?.v ?? ''));
        return at >= 0 && this.arrayish(tf, at, at + 1, prop, depth + 1);
      }
      if (d.kind !== 'decl' || (d.bad && !/^escape: /.test(d.bad)) || !d.inits.length) return false;
      const key = 'A:' + f.rel + ':' + (d.scope ? d.scope.ps : -1) + ':' + (d.blk ? d.blk[0] : -1) + ':' + t.v + ':' + prop;
      if (this.memo.has(key)) return this.memo.get(key) === null;
      if (this.busy.has(key)) { this.cycles++; return true; }
      this.busy.add(key);
    const c0 = this.cycles;
      let ok = d.inits.every(([a, b]) => a >= 0 && a !== b && this.arrayish(f, a, b, prop, depth + 1)) && (d.plain ?? []).every(([a, b]) => this.arrayish(f, a, b, prop, depth + 1));
      if (prop !== null) ok = ok && (d.members ?? []).every((m) => (m.prop !== prop && m.prop !== null) || this.isPushArg(f, m.range) || this.arrayish(f, m.range[0], m.range[1], null, depth + 1));
      this.busy.delete(key);
      if (!ok || this.cycles === c0) this.memo.set(key, ok ? null : 'no');
      return ok;
    }
    // x.p
    if (prop === null && e - s >= 3 && toks[e - 2]!.v === '.' && toks[e - 1]!.t === 'id') return this.arrayish(f, s, e - 2, toks[e - 1]!.v, depth + 1);
    // call of a repository function
    if (t.t === 'id' && toks[s + 1]?.v === '(' && f.match[s + 1] === e - 1) {
      const found = this.findFn(f, s, t.v);
      if (found) { const rs = this.returnRanges(found.file, found.fn); return rs.length > 0 && rs.every(([a, b]) => this.arrayish(found.file, a, b, prop, depth + 1)); }
    }
    return false;
  }

  /** Safety of the keys of an object (`Object.keys(expr)`): literal keys of object literals at every source. */
  keysOf(f: FileInfo, s0: number, e0: number, env: Env, depth: number): string | null {
    if (depth > 40) return 'too deep';
    const [s, e] = this.core(f, s0, e0);
    const br = this.branches(f, s, e);
    if (br) { for (const [a, b] of br) { const r = this.keysOf(f, a, b, env, depth + 1); if (r) return r; } return null; }
    const toks = f.toks;
    const t = toks[s]!;
    if (t.v === '{' && f.match[s] === e - 1) {
      for (const [a, b] of this.split(f, s + 1, e - 1, (x) => x.t === 'p' && x.v === ',')) {
        if (a >= b) continue;
        if (toks[a]!.v === '...') { const r = this.keysOf(f, a + 1, b, env, depth + 1); if (r) return r; continue; }
        if (toks[a]!.v === '[') { const r = this.safe(f, a + 1, f.match[a]!, env, depth + 1); if (r) return 'computed key: ' + r; }
      }
      return null;
    }
    if (t.t === 'id' && e === s + 1) {
      const b = this.bindingScope(f, s, t.v);
      if (b?.param && !env.binds.has(t.v)) {
        const fn = b.scope!, p = b.param;
        if (!fn.name || p.pattern || p.rest) return 'keys of parameter `' + t.v + '` (callers unknown)';
        const callers = this.callSites(f, fn);
        if (typeof callers === 'string') return 'keys of parameter `' + t.v + '`: ' + callers;
        for (const c of callers) {
          const a = c.args[p.idx];
          const r = a ? this.keysOf(c.file, a[0], a[1], { binds: new Map(), fnScopes: [] }, depth + 1) : null;
          if (r) return 'keys of parameter `' + t.v + '` ← ' + c.file.rel + ':' + this.line(c.file, c.at)[0] + ': ' + r;
        }
        return null;
      }
      const d = b && !b.param ? this.declsOf(f, s, t.v) : null;
      if (d && d.kind === 'decl' && !d.bad) {
        for (const [a, b2] of d.inits) { if (a < 0 || a === b2) return 'keys of `' + t.v + '`'; const r = this.keysOf(f, a, b2, env, depth + 1); if (r) return r; }
        for (const [a, b2] of d.plain ?? []) { const r = this.keysOf(f, a, b2, env, depth + 1); if (r) return r; }
        for (const m of d.members ?? []) if (m.prop === null) return 'keys of `' + t.v + '`: computed member assignment';
        return null;
      }
    }
    const whole = this.safe(f, s, e, env, depth + 1);
    return whole ? 'keys of ' + whole : null;
  }

  /** A member range that is an argument of `.push()`/`.unshift()` (adds an element, keeps the array). */
  isPushArg(f: FileInfo, range: [number, number]): boolean {
    const open = this.openParen(f, range[0]);
    return open > 0 && ['push', 'unshift'].includes(f.toks[open - 1]?.v ?? '');
  }

  args(f: FileInfo, open: number): [number, number][] {
    const close = f.match[open]!;
    if (close === open + 1) return [];
    return this.split(f, open + 1, close, (t) => t.t === 'p' && t.v === ',').filter(([a, b]) => a < b).map(([a, b]) => [a, b]);
  }

  /** callback(element, index) returns */
  callback(f: FileInfo, arg: [number, number], elem: string | null, env: Env, depth: number, init: [number, number] | null = null): string | null {
    const fn = f.fns.find((x) => x.ps === arg[0] || (f.toks[arg[0]]!.v === 'async' && x.ps === arg[0] + 1) || (x.head === arg[0]));
    if (!fn) {
      // a named function reference
      if (arg[1] === arg[0] + 1 && f.toks[arg[0]]!.t === 'id') {
        const named = this.findFn(f, arg[0], f.toks[arg[0]]!.v);
        if (named) return this.returns(named.file, [named.fn], [], f, env, depth, [elem, null]);
      }
      return 'callback not a function literal';
    }
    const bind = new Map(env.binds);
    const reducer = init !== null;
    fn.params.forEach((p) => {
      if (p.pattern) bind.set(p.name, { reason: elem === null ? null : 'destructured ' + elem });
      else if (reducer) bind.set(p.name, p.idx === 0 ? { reason: 'reduce accumulator' } : p.idx === 1 ? { reason: elem } : { reason: null });
      else bind.set(p.name, { reason: p.idx === 0 ? elem : null });
    });
    if (reducer && init) {
      const r0 = this.safe(f, init[0], init[1], env, depth + 1);
      if (r0) return r0;
      const acc = fn.params[0];
      if (acc) bind.set(acc.name, { reason: this.paramMutated(f, fn, acc, 0) ? 'reduce accumulator filled in the callback' : null });
    }
    return this.fnReturns(f, fn, { binds: bind, fnScopes: [...env.fnScopes, fn] }, depth + 1);
  }

  fnReturns(f: FileInfo, fn: Fn, env: Env, depth: number, ev: Ev | null = null): string | null {
    for (const [a, b] of this.returnRanges(f, fn)) {
      const r = ev ? ev(f, a, b, env, depth + 1) : this.safe(f, a, b, env, depth + 1);
      if (r) return 'return of ' + (fn.name ?? 'function') + ': ' + r;
    }
    return null;
  }

  findFn(f: FileInfo, at: number, name: string): { file: FileInfo; fn: Fn } | null {
    // the binding visible at the call: a parameter is not a known function; a local is the function it names
    const b = this.bindingScope(f, at, name);
    if (b?.param) return null;
    if (b?.decl) {
      const d = b.decl;
      let fn: Fn | undefined;
      if (d.kind === 'function') fn = f.fns.find((x) => x.name === name && !x.method && x.head <= d.q && d.q < x.ps);
      else if (d.kind === 'simple' && d.init) { const [a] = this.core(f, d.init[0], d.init[1]); fn = f.fns.find((x) => x.ps === a || x.ps === a + 1 || x.head === a); }
      if (!fn) return null;
      if (d.kind === 'simple' && this.declsOf(f, at, name)?.plain?.length) return null; // re-assigned
      return { file: f, fn };
    }
    const imp = f.imports.get(name);
    if (imp) {
      const target = this.files.get(imp.from);
      if (!target) return null;
      return this.exportedFn(target, imp.name, 0);
    }
    return null;
  }

  /** The top-level function a module exports under `exported` (through `export {a as b}`, default, barrels). */
  exportedFn(target: FileInfo, exported: string, depth: number): { file: FileInfo; fn: Fn } | null {
    if (depth > 8) return null;
    const local = exported === 'default' ? target.defaultName : target.exportAs.get(exported) ?? exported;
    if (!local) return null;
    const fns = target.fns.filter((x) => x.name === local && !x.parent && !x.method);
    if (fns.length === 1) return { file: target, fn: fns[0]! };
    const imp = target.imports.get(local);
    if (imp) { const t2 = this.files.get(imp.from); if (t2) return this.exportedFn(t2, imp.name, depth + 1); }
    for (const r of target.reexports) {
      const orig = r.names ? r.names.get(exported) : exported === 'default' ? undefined : exported;
      const t2 = orig === undefined ? undefined : this.files.get(r.from);
      if (t2) { const found = this.exportedFn(t2, orig!, depth + 1); if (found) return found; }
    }
    return null;
  }

  /** Every (file, local binding) that imports `exported` of module rel, directly or through barrels;
   * ns: a namespace binding whose `ns.exported` is the function. */
  importersOf(rel: string, exported: string, depth = 0): { file: FileInfo; local?: string; ns?: string }[] {
    if (depth > 8) return [];
    const out: { file: FileInfo; local?: string; ns?: string }[] = [];
    for (const other of this.files.values()) {
      if (other.rel === rel) continue;
      for (const [local, imp] of other.imports) if (imp.from === rel && imp.name === exported) out.push({ file: other, local });
      for (const [ns, from] of other.namespaces) if (from === rel && exported !== 'default') out.push({ file: other, ns });
      for (const r of other.reexports) if (r.from === rel) {
        if (r.names) { for (const [e, orig] of r.names) if (orig === exported) out.push(...this.importersOf(other.rel, e, depth + 1)); }
        else if (exported !== 'default') out.push(...this.importersOf(other.rel, exported, depth + 1));
      }
    }
    return out;
  }


  callNamed(f: FileInfo, at: number, name: string, args: [number, number][], env: Env, depth: number): string | null {
    const found = this.findFn(f, at, name);
    if (!found) {
      // a const bound to a safe value cannot be called; an unknown function cannot be followed
      return 'call of `' + name + '()` (not resolved)';
    }
    return this.returns(found.file, [found.fn], args, f, env, depth);
  }

  callIn(target: FileInfo, name: string, args: [number, number][], caller: FileInfo, env: Env, depth: number): string | null {
    const fns = target.fns.filter((x) => x.name === name && !x.parent && !x.method);
    if (fns.length !== 1) return 'call of `' + name + '()` (not resolved)';
    return this.returns(target, fns, args, caller, env, depth);
  }

  /** Returns of fns with params bound to caller args (evaluated in the caller). */
  returns(f: FileInfo, fns: Fn[], args: [number, number][], caller: FileInfo, env: Env, depth: number, direct: (string | null)[] | null = null, ev: Ev | null = null): string | null {
    for (const fn of fns) {
      const bind = new Map<string, Binding>();
      for (const p of fn.params) {
        let reason: string | null;
        if (direct) reason = direct[p.idx] ?? null;
        else if (p.rest) { reason = null; for (const a of args.slice(p.idx)) { reason = this.safe(caller, a[0], a[1], env, depth + 1); if (reason) break; } }
        else if (p.pattern) {
          const a = args[p.idx];
          reason = a ? this.objectProp(caller, a, p.name, env, depth) : p.def ? this.safe(f, p.def[0], p.def[1], { binds: new Map(), fnScopes: [] }, depth + 1) : null;
        } else {
          const a = args[p.idx];
          reason = a ? this.safe(caller, a[0], a[1], env, depth + 1) : p.def ? this.safe(f, p.def[0], p.def[1], { binds: new Map(), fnScopes: [] }, depth + 1) : null;
        }
        bind.set(p.name, { reason });
      }
      const r = this.fnReturns(f, fn, { binds: bind, fnScopes: [fn] }, depth + 1, ev);
      if (r) return r;
    }
    return null;
  }

  /** Safety of `arg.prop` when arg is an object literal at the call site; otherwise of arg. */
  objectProp(f: FileInfo, a: [number, number], prop: string, env: Env, depth: number): string | null {
    const t = f.toks[a[0]]!;
    if (t.t === 'p' && t.v === '{' && f.match[a[0]] === a[1] - 1) {
      // every entry that can supply `prop`: the key itself, a spread, a computed key (later ones override)
      const entries = this.split(f, a[0] + 1, a[1] - 1, (x) => x.t === 'p' && x.v === ',');
      for (const [s, e] of entries) {
        if (s >= e) continue;
        const k = f.toks[s]!;
        let r: string | null = null;
        if (k.t === 'p' && k.v === '...') r = this.safe(f, s + 1, e, env, depth + 1);
        else if (k.v === '[' && f.toks[f.match[s]! + 1]?.v === ':') r = this.safe(f, f.match[s]! + 2, e, env, depth + 1);
        else if ((k.v === 'get' || k.v === 'set') && f.toks[s + 1]?.t === 'id' && f.toks[s + 2]?.v === '(') r = f.toks[s + 1]!.v === prop ? 'accessor `' + prop + '`' : null;
        else if (k.v === prop && e === s + 1) r = this.safe(f, s, e, env, depth + 1); // shorthand
        else if (k.v === prop && f.toks[s + 1]?.v === ':') r = this.safe(f, s + 2, e, env, depth + 1);
        else if (k.v === prop) r = 'object member `' + prop + '`';
        if (r) return r;
      }
      return null; // absent → undefined
    }
    return this.safe(f, a[0], a[1], env, depth + 1);
  }

  primary(f: FileInfo, s: number, e: number, env: Env, depth: number): string | null {
    const toks = f.toks;
    const t = toks[s]!;
    if (t.t === 'str' || t.t === 'num' || t.t === 're') return null;
    if (t.t === 'tb') {
      // substitutions
      let q = s;
      while (toks[q]!.t !== 'te') {
        const c = f.match[q]!; // tm or te
        const r = this.safe(f, q + 1, c, env, depth + 1);
        if (r) return r;
        q = c;
      }
      return null;
    }
    if (t.t === 'p' && t.v === '(') return this.safe(f, s + 1, e - 1, env, depth + 1);
    if (t.t === 'p' && t.v === '[') {
      for (const [a, b] of this.split(f, s + 1, e - 1, (x) => x.t === 'p' && x.v === ',')) {
        if (a >= b) continue;
        const r = toks[a]!.v === '...' ? this.safe(f, a + 1, b, env, depth + 1) : this.safe(f, a, b, env, depth + 1);
        if (r) return r;
      }
      return null;
    }
    if (t.t === 'p' && t.v === '{') {
      for (const [a, b] of this.split(f, s + 1, e - 1, (x) => x.t === 'p' && x.v === ',')) {
        if (a >= b) continue;
        if (toks[a]!.v === '...') { const r = this.safe(f, a + 1, b, env, depth + 1); if (r) return r; continue; }
        let c = a;
        if (toks[c]!.v === '[') c = f.match[c]! ; // computed key
        if (toks[c + 1]?.v === ':') { const r = this.safe(f, c + 2, b, env, depth + 1); if (r) return r; continue; }
        if (b === a + 1 && toks[a]!.t === 'id') { const r = this.ident(f, a, toks[a]!.v, env, depth); if (r) return r; continue; }
        // method in object literal: its returns
        const fn = f.fns.find((x) => x.head === a || x.ps === a + 1);
        if (fn) { const r = this.fnReturns(f, fn, { binds: new Map(env.binds), fnScopes: [...env.fnScopes, fn] }, depth + 1); if (r) return r; continue; }
        return 'unparsed object member';
      }
      return null;
    }
    if (t.t === 'id') {
      if (['true', 'false', 'null', 'undefined', 'NaN', 'Infinity'].includes(t.v)) return null;
      if (t.v === 'this') return '`this`';
      return this.ident(f, s, t.v, env, depth);
    }
    return 'unparsed primary `' + t.v + '`';
  }

  /** All declarations of `name` in the file (lexical, function-level scopes). */
  declRecs(f: FileInfo, name: string): DeclRec[] {
    const hit = f.decls.get(name);
    if (hit) return hit;
    const toks = f.toks;
    const out: DeclRec[] = [];
    for (const q of f.occ.get(name) ?? []) {
      const prev = toks[q - 1];
      if (prev?.t === 'p' && (prev.v === '.' || prev.v === '?.')) continue;
      const scope = this.enclosing(f, q);
      if (scope && q >= scope.ps && q <= scope.pe) continue; // parameter list (params are read from fn.params)
      if ((prev?.t === 'id' && /^(const|let|var)$/.test(prev.v)) || (prev?.v === ',' && this.inDeclList(f, q))) {
        let r = q + 1;
        if (toks[r]?.v === '!') r++;
        if (toks[r]?.v === ':') r = this.skipVarType(f, r + 1);
        if (toks[r]?.v === '=') out.push({ q, scope, kind: 'simple', init: [r + 1, this.exprEnd(f, r + 1)] });
        else if (toks[r]?.v === 'of') out.push({ q, scope, kind: 'forof', init: [r + 1, this.exprEnd(f, r + 1)] });
        else if (toks[r]?.v === 'in') out.push({ q, scope, kind: 'forin', init: null });
        else out.push({ q, scope, kind: 'simple', init: null });
        continue;
      }
      if (prev?.t === 'id' && (prev.v === 'function' || prev.v === 'class')) { out.push({ q, scope, kind: 'function', init: null }); continue; }
      if (prev?.v === '(' && toks[q - 2]?.v === 'catch') { out.push({ q, scope, kind: 'catch', init: null }); continue; }
      if (prev?.t === 'p' && ['{', '[', ',', ':', '...'].includes(prev.v) && toks[q + 1]?.t === 'p' && [',', '}', ']', '='].includes(toks[q + 1]!.v)) {
        const pat = this.inPattern(f, q);
        if (pat < 0) continue;
        // the whole right-hand side safe ⇒ every destructured part is safe; defaults inside the pattern are not followed
        const close = f.match[pat]!;
        let defaults = false;
        for (let z = pat + 1; z < close; z++) if (toks[z]!.v === '=') defaults = true;
        const nx = toks[close + 1];
        if (!defaults && nx?.v === '=') out.push({ q, scope, kind: 'pattern', init: [close + 2, this.exprEnd(f, close + 2)] });
        else if (!defaults && nx?.v === 'of') out.push({ q, scope, kind: 'forof', init: [close + 2, this.exprEnd(f, close + 2)] });
        else out.push({ q, scope, kind: 'pattern', init: null });
      }
    }
    for (const d of out) d.blk = this.declBlock(f, d);
    f.decls.set(name, out);
    return out;
  }

  /** Token range where a declaration is visible: the enclosing block or `for` statement for let/const,
   * the whole function (or module) for var, function declarations, catch and anything not recognised. */
  declBlock(f: FileInfo, d: DeclRec): [number, number] {
    const toks = f.toks;
    const whole: [number, number] = d.scope ? [d.scope.ps, d.scope.be] : [0, toks.length];
    if (d.kind === 'function' || d.kind === 'catch') return whole;
    let kw = -1;
    if (d.kind === 'pattern' || (d.kind === 'forof' && toks[d.q - 1]?.v !== 'const' && toks[d.q - 1]?.v !== 'let' && toks[d.q - 1]?.v !== 'var')) {
      const pat = this.inPattern(f, d.q);
      if (pat >= 0) kw = /^(const|let|var)$/.test(toks[pat - 1]?.v ?? '') ? pat - 1 : this.declKeyword(f, pat);
    } else kw = /^(const|let|var)$/.test(toks[d.q - 1]?.v ?? '') ? d.q - 1 : this.declKeyword(f, d.q);
    if (kw < 0 || toks[kw]!.v === 'var') return whole;
    const o = this.opener(f, kw);
    if (o < 0 || (d.scope && o === d.scope.bs)) return whole;
    if (toks[o]!.v === '(' && toks[o - 1]?.v === 'for') {
      const body = f.match[o]! + 1;
      const end = toks[body]?.v === '{' ? f.match[body]! : this.exprEnd(f, body);
      return [o - 1, end];
    }
    if (toks[o]!.v === '{') return [o, f.match[o]!];
    return whole;
  }

  /** The const/let/var keyword of a later declarator `…, name = …` (walking back over the list), or -1. */
  declKeyword(f: FileInfo, q: number): number {
    for (let r = q - 1; r >= 0; r--) {
      const t = f.toks[r]!;
      if (t.t === 'p' && (t.v === ';' || t.v === '{' || t.v === '}' || t.v === '(' || t.v === '[')) return -1;
      if (t.t === 'id' && /^(const|let|var)$/.test(t.v)) return r;
      if (t.t === 'p' && (t.v === ')' || t.v === ']')) { r = f.match[r]!; continue; }
      if (t.t === 'te') { r = f.match[r]!; continue; }
    }
    return -1;
  }

  skipVarType(f: FileInfo, z: number): number {
    let dd = 0;
    for (; z < f.toks.length; z++) {
      const v = f.toks[z]!;
      if (v.t === 'p' && OPEN[v.v]) { z = f.match[z]!; if (z < 0) return f.toks.length; continue; }
      if (v.t === 'p' && v.v === '<') dd++;
      else if (v.t === 'p' && v.v === '>') dd--;
      else if (dd <= 0 && v.t === 'p' && (v.v === '=' || v.v === ',' || v.v === ';' || v.v === ')')) return z;
      else if (dd <= 0 && v.t === 'id' && (v.v === 'of' || v.v === 'in')) return z;
    }
    return z;
  }

  /** q is a binding inside a destructuring pattern of a const/let/var declaration. */
  /** Index of the outermost pattern bracket when q is bound by a const/let/var destructuring pattern, else -1. */
  inPattern(f: FileInfo, q: number): number {
    let r = this.opener(f, q);
    while (r >= 0 && (f.toks[r]!.v === '{' || f.toks[r]!.v === '[')) {
      const p = f.toks[r - 1];
      if (p && ((p.t === 'id' && /^(const|let|var)$/.test(p.v)) || (p.v === ',' && this.inDeclList(f, r)))) return r;
      // a nested pattern sits directly in its parent pattern
      if (!p || !['{', '[', ',', ':', '...'].includes(p.v)) return -1;
      r = this.opener(f, r);
    }
    return -1;
  }

  /** innermost bracket opener containing q (-1: none or a template). */
  opener(f: FileInfo, q: number): number {
    for (let r = q - 1, n = 0; r >= 0 && n < 4000; r--, n++) {
      const t = f.toks[r]!;
      if (t.t === 'p' && (t.v === ')' || t.v === ']' || t.v === '}')) { r = f.match[r]!; if (r < 0) return -1; continue; }
      if (t.t === 'te') { r = f.match[r]!; if (r < 0) return -1; continue; }
      if (t.t === 'tm') return -1;
      if (t.t === 'p' && OPEN[t.v]) return r;
      if (t.t === 'tb') return -1;
    }
    return -1;
  }

  /** The scope (function or module) whose binding of `name` a reference at q sees; undefined: none. */
  bindingScope(f: FileInfo, q: number, name: string): { scope: Fn | null; param?: Param; decl?: DeclRec } | undefined {
    const recs = this.declRecs(f, name);
    let fn = this.enclosing(f, q);
    for (;;) {
      // the innermost block of this function that declares the name and contains q
      let best: DeclRec | undefined;
      for (const d of recs) if (d.scope === fn && d.blk![0] <= q && q <= d.blk![1] && (!best || d.blk![0] > best.blk![0])) best = d;
      const p = fn ? fn.params.find((x) => x.name === name) : undefined;
      // a block declaration inside the function body shadows the parameter there
      if (best && (!p || best.blk![0] > fn!.bs)) return { scope: fn, decl: best };
      if (p) return { scope: fn, param: p };
      if (best) return { scope: fn, decl: best };
      if (!fn) return undefined;
      fn = fn.parent;
    }
  }

  /** Declarations of `name` visible at token `at`. */
  declsOf(f: FileInfo, at: number, name: string): Decl | null {
    const toks = f.toks;
    const b = this.bindingScope(f, at, name);
    if (!b) {
      if (f.imports.has(name)) return { kind: 'import', inits: [], assigns: [], scope: null, imp: f.imports.get(name)! };
      if (f.namespaces.has(name)) return { kind: 'namespace', inits: [], assigns: [], scope: null };
      return null;
    }
    if (b.param) return { kind: 'param', fn: b.scope!, param: b.param, inits: [], assigns: [], scope: b.scope };
    // a declaration's facts do not depend on the use site: memoised; a cycle (the escape analysis of one
    // binding needing another's) is answered conservatively
    const blk = b.decl!.blk!;
    const key = 'D:' + f.rel + ':' + (b.scope ? b.scope.ps : -1) + ':' + blk[0] + ':' + name;
    const hit = this.declMemo.get(key);
    if (hit) return hit;
    if (this.busy.has(key)) return this.partial.get(key) ?? { kind: 'decl', inits: [], assigns: [], scope: b.scope, bad: 'escape: cyclic analysis' };
    this.busy.add(key);
    const d = this.declsOf0(f, name, b.scope, key, blk);
    this.busy.delete(key);
    this.declMemo.set(key, d);
    return d;
  }

  declMemo = new Map<string, Decl>();
  partial = new Map<string, Decl>();

  declsOf0(f: FileInfo, name: string, sc: Fn | null, memoKey: string, blk: [number, number]): Decl {
    const toks = f.toks;
    const recs = this.declRecs(f, name).filter((d) => d.scope === sc && d.blk![0] === blk[0] && d.blk![1] === blk[1]);
    const inits: [number, number][] = [];
    let bad: string | null = null;
    for (const d of recs) {
      if (d.kind === 'pattern' && d.init) inits.push(d.init);
      else if (d.kind === 'pattern') bad = bad ?? 'destructured binding';
      else if (d.kind === 'catch') bad = bad ?? 'catch binding';
      else if (d.kind === 'function' && f.toks[d.q - 1]?.v === 'class') bad = bad ?? 'class (its methods can write its static fields)';
      else if (d.kind === 'forin') bad = bad ?? 'for…in key';
      else if (d.kind === 'forof') inits.push([-d.init![0], d.init![1]]);
      else if (d.kind === 'simple' && d.init) inits.push(d.init);
    }
    // assignments and mutations of the binding (references that resolve to this scope)
    const assigns: [number, number][] = [];
    const plain: [number, number][] = [];
    const members: { prop: string | null; range: [number, number] }[] = [];
    const declQs = new Set(recs.map((d) => d.q));
    const occs = (f.occ.get(name) ?? []).filter((q) => {
      if (declQs.has(q) || ['.', '?.'].includes(toks[q - 1]?.v ?? '')) return false;
      if (sc && (q < sc.ps || q > sc.be)) return false;
      const bs = this.bindingScope(f, q, name);
      return !!bs && !bs.param && bs.scope === sc && bs.decl?.blk![0] === blk[0];
    });
    // re-assignments first: `let w = ''; w = []` makes w a collection
    for (const q of occs) {
      const { after } = this.refBase(f, q);
      const nx = toks[after];
      if (this.inAssignPattern(f, q)) bad = bad ?? 'assigned by destructuring at line ' + this.line(f, q)[0];
      if (toks[q - 1]?.v === '(' && toks[q - 2]?.v === 'for' && (nx?.v === 'of' || nx?.v === 'in')) bad = bad ?? 'assigned by a for…' + nx.v + ' header at line ' + this.line(f, q)[0];
      if (after === q + 1 && nx?.t === 'p' && ['=', '+=', '||=', '??=', '&&='].includes(nx.v)) {
        const range: [number, number] = [after + 1, this.exprEnd(f, after + 1)];
        assigns.push(range); plain.push(range);
      }
    }
    // anything but a primitive may be an array/object (a ternary of arrays, 'a,b'.split(','), a call)
    const mutable = recs.some((d) => d.kind === 'simple' && !!d.init && this.maybeCollection(f, d.init[0], d.init[1], 0)) || plain.some(([a, b]) => this.maybeCollection(f, a, b, 0));
    const ownMethods = inits.some(([a, b]) => a >= 0 && this.hasOwnMethods(f, a, b));
    const uses: number[] = [];
    for (const q of occs) {
      const { after } = this.refBase(f, q);
      if (after === q + 1 && toks[after]?.t === 'p' && ['=', '+=', '||=', '??=', '&&='].includes(toks[after]!.v)) continue;
      if (ownMethods && toks[after]?.t === 'p' && ['.', '?.'].includes(toks[after]!.v) && (toks[after + 2]?.v === '(' || toks[after + 2]?.v === '!')) { bad = bad ?? 'escape: calls a method of an object with its own methods at line ' + this.line(f, q)[0]; continue; }
      const w = this.writePath(f, after);
      if (w) {
        // name.push(v), name.p = v, name[k] = v, name.p.push(v), name.set(k, v): the written values are checked
        for (const range of w.values) { assigns.push(range); if (w.path.length > (w.call ? 1 : 0)) members.push({ prop: w.path[0] ?? null, range }); }
        continue;
      }
      uses.push(q);
    }
    // the values are known now; a cyclic question about this binding during the escape check gets them
    this.partial.set(memoKey, { kind: 'decl', inits, assigns, scope: sc, bad: 'escape: cyclic analysis', plain, members, blk });
    // any other use of an array/object must be a read (`.join()`, `.length`, `[i]` read, a template, a
    // read-only callee); an alias, a store, an unknown method or callee could fill it unseen
    if (mutable) for (const q of uses) { const u = this.useKind(f, q, 0); if (u) { bad = bad ?? 'escape: ' + u + ' at line ' + this.line(f, q)[0]; break; } }
    // a module-level array/object another module imports can be changed there
    if (!sc && mutable && !bad) {
      const names = [name, ...[...f.exportAs].filter(([, l]) => l === name).map(([e]) => e), ...(f.defaultName === name ? ['default'] : [])];
      const exported = names.length > 1 || f.defaultName === name || new RegExp('export\\s+(const|let|var)\\s+' + name + '\\b|export\\s*\\{[^}]*\\b' + name + '\\b').test(f.src);
      if (exported) for (const e of names) for (const imp of this.importersOf(f.rel, e)) {
        const refs = imp.local ? (imp.file.occ.get(imp.local) ?? []).filter((q) => !['.', '?.'].includes(imp.file.toks[q - 1]?.v ?? '') && !this.inImportExport(imp.file, q))
          : (imp.file.occ.get(imp.ns!) ?? []).filter((q) => imp.file.toks[q + 1]?.v === '.' && imp.file.toks[q + 2]?.v === e).map((q) => q + 2);
        const at = refs.find((q) => this.refChanges(imp.file, q));
        if (at !== undefined) { bad = 'changed in ' + imp.file.rel + ':' + this.line(imp.file, at)[0]; break; }
      }
      // `const m = await import('./x'); m.W.push(…)` / `const { W } = await import('./x')`: every occurrence
      if (exported && !bad) for (const other of this.dynImporters.get(f.rel) ?? []) {
        const at = (other.occ.get(name) ?? []).find((q) => !this.inImportExport(other, q) && this.refChanges(other, q));
        if (at !== undefined) { bad = 'changed in ' + other.rel + ':' + this.line(other, at)[0]; break; }
      }
    }
    return { kind: 'decl', inits, assigns, scope: sc, bad, plain, members, blk };
  }

  inDeclList(f: FileInfo, q: number): boolean {
    // `let a = 1, name = 2` — walk back over the declarator list
    for (let r = q - 1; r >= 0; r--) {
      const t = f.toks[r]!;
      if (t.t === 'p' && (t.v === ';' || t.v === '{' || t.v === '}')) return false;
      if (t.t === 'id' && /^(const|let|var)$/.test(t.v)) {
        // only if no statement boundary between: the comma-separated list
        const end = this.exprEnd(f, r + 1);
        return end >= q || f.toks[end]?.v === ',';
      }
      if ((t.t === 'p' && OPEN[t.v] === undefined && [')', ']'].includes(t.v))) { r = f.match[r]!; continue; }
      if (t.t === 'p' && (t.v === '(' || t.v === '[')) return false;
    }
    return false;
  }

  openParen(f: FileInfo, q: number): number {
    for (let r = q - 1; r >= 0; r--) {
      const t = f.toks[r]!;
      if (t.t === 'p' && (t.v === ')' || t.v === ']' || t.v === '}')) { r = f.match[r]!; continue; }
      if (t.t === 'te') { r = f.match[r]!; if (r < 0) return -1; continue; }
      if (t.t === 'tm') return -1;
      if (t.t === 'p' && (t.v === '(' || t.v === '[' || t.v === '{')) return t.v === '(' ? r : -1;
      if (t.t === 'tb') return -1;
    }
    return -1;
  }
  isCallParen(f: FileInfo, open: number): boolean {
    const p = f.toks[open - 1];
    if (!p) return false;
    if (p.t === 'id') return !NOT_FN.has(p.v) && p.v !== 'function';
    return p.t === 'p' && (p.v === ')' || p.v === ']' || p.v === '>');
  }
  calleeName(f: FileInfo, open: number): string { return f.toks[open - 1]!.t === 'id' ? f.toks[open - 1]!.v : '(expression)'; }
  /** [s,e) is an object literal (or a choice of them) with a method, accessor or function-valued member. */
  hasOwnMethods(f: FileInfo, s0: number, e0: number): boolean {
    const [s, e] = this.core(f, s0, e0);
    const br = this.branches(f, s, e);
    if (br) return br.some(([a, b]) => this.hasOwnMethods(f, a, b));
    if (!(f.toks[s]?.v === '{' && f.match[s] === e - 1)) return false;
    return f.fns.some((x) => x.ps > s && x.be < e && this.opener(f, x.head) === s) || this.split(f, s + 1, e - 1, (t) => t.t === 'p' && t.v === ',').some(([a]) => ['get', 'set', 'async', '*'].includes(f.toks[a]?.v ?? '') && f.toks[a + 1]?.t === 'id');
  }

  /** The reference at q is a target inside a destructuring assignment `[x] = …` / `({ x } = …)`. */
  inAssignPattern(f: FileInfo, q: number): boolean {
    const toks = f.toks;
    let r = this.opener(f, q), outer = -1;
    while (r >= 0 && (toks[r]!.v === '[' || toks[r]!.v === '{')) {
      const pv = toks[r - 1];
      outer = r;
      if (!pv || !['{', '[', ',', ':', '...', '('].includes(pv.v)) break;
      if (pv.v === '(' || pv.v === ',' && !['[', '{'].includes(toks[this.opener(f, r)]?.v ?? '')) break;
      r = this.opener(f, r);
    }
    if (outer < 0) return false;
    const close = f.match[outer]!;
    if (toks[close + 1]?.v !== '=') return false;
    const pv = toks[outer - 1];
    if (pv?.t === 'id' && /^(const|let|var)$/.test(pv.v)) return false; // a declaration
    if (pv?.v === ',' && this.inDeclList(f, outer)) return false;
    // `[x] = …` must not be an index (`a[x] = …`)
    if (toks[outer]!.v === '[' && (pv?.t === 'id' || [')', ']'].includes(pv?.v ?? '')) && !/^(return|of|in|typeof|case|yield|await)$/.test(pv?.v ?? '')) return false;
    return true;
  }

  /** The init range is a string/number/template literal (or a choice between such): an immutable value. */
  primitiveInit(f: FileInfo, s0: number, e0: number): boolean {
    const [s, e] = this.core(f, s0, e0);
    const br = this.branches(f, s, e);
    if (br) return br.every(([a, b]) => this.primitiveInit(f, a, b));
    const t = f.toks[s]!;
    if (e === s + 1) return t.t === 'str' || t.t === 'num' || ['true', 'false', 'null', 'undefined'].includes(t.v);
    return t.t === 'tb' && this.skip(f, s) === e - 1;
  }

  /** The value of [s,e) may be an array or object (so it can be filled later); false only when it is
   * provably a string, number or boolean. */
  maybeCollection(f: FileInfo, s0: number, e0: number, depth: number): boolean {
    if (depth > 12) return true;
    const [s, e] = this.core(f, s0, e0);
    if (s >= e) return true;
    if (this.primitiveInit(f, s, e)) return false;
    const br = this.branches(f, s, e);
    if (br) return br.some(([a, b]) => this.maybeCollection(f, a, b, depth + 1));
    const toks = f.toks;
    // string concatenation, arithmetic, comparisons
    if (this.split(f, s, e, (t, q) => t.t === 'p' && ['+', '-', '*', '/', '%', '===', '!==', '==', '!=', '<', '>', '<=', '>='].includes(t.v) && q > s && this.binaryPos(f, q)).length > 1) return false;
    const t = toks[s]!;
    if (t.t === 'p' && ['!', '-', '+', '~'].includes(t.v)) return false;
    if (t.t === 'id' && e === s + 1) {
      const d = this.declsOf(f, s, t.v);
      if (!d) return true;
      if (d.kind === 'decl') return d.inits.some(([a, b]) => a < 0 || a === b || this.maybeCollection(f, a, b, depth + 1)) || (d.plain ?? []).some(([a, b]) => this.maybeCollection(f, a, b, depth + 1));
      return true;
    }
    if (toks[e - 1]!.v === ')') {
      const open = f.match[e - 1]!;
      const m = toks[open - 1];
      const member = toks[open - 2]?.v === '.' || toks[open - 2]?.v === '?.';
      if (m?.t === 'id' && member && ['join', 'trim', 'trimStart', 'trimEnd', 'toUpperCase', 'toLowerCase', 'toString', 'toFixed', 'toISOString', 'replace', 'replaceAll', 'padStart', 'padEnd', 'repeat', 'substring', 'includes', 'has', 'test', 'startsWith', 'endsWith', 'indexOf', 'digest'].includes(m.v)) return false;
      if (m?.t === 'id' && !member && ['String', 'Number', 'Boolean', 'parseInt', 'parseFloat'].includes(m.v)) return false;
      if (m?.t === 'id' && !member && open - 1 === s) {
        const found = this.findFn(f, s, m.v);
        if (found) { const rs = this.returnRanges(found.file, found.fn); return rs.length === 0 || rs.some(([a, b]) => this.maybeCollection(found.file, a, b, depth + 1)); }
      }
    }
    return true;
  }

  /** The reference at q seen through `x!`, `(x)` and `(x as T)`: start = first token of the reference,
   * after = first token after it. */
  refBase(f: FileInfo, q: number): { start: number; after: number } {
    const toks = f.toks;
    let start = q, after = q + 1;
    for (;;) {
      if (toks[after]?.v === '!' && !(toks[after + 1]?.v === '=' )) { after++; continue; }
      const p = toks[start - 1];
      if (p?.v === '(' && !this.isCallParen(f, start - 1) && !f.fns.some((x) => x.ps === start - 1)) {
        const close = f.match[start - 1]!;
        let k = after;
        if (toks[k]?.t === 'id' && (toks[k]!.v === 'as' || toks[k]!.v === 'satisfies')) k = close;
        if (k === close) { start--; after = close + 1; continue; }
      }
      return { start, after };
    }
  }

  /** A write through the reference that ends at `after`: `.push(…)`/`.unshift`/`.set`/`.add`/`.splice`/`.fill`
   * (also on a member path) or `.p = v` / `[k] = v` / `.p.q += v`. Returns the written value ranges. */
  writePath(f: FileInfo, after: number): { path: (string | null)[]; call: boolean; values: [number, number][] } | null {
    const toks = f.toks;
    let r = after;
    const path: (string | null)[] = [];
    while (toks[r]?.v === '[' || toks[r]?.v === '!' || ((toks[r]?.v === '.' || toks[r]?.v === '?.') && toks[r + 1]?.t === 'id')) {
      if (toks[r]!.v === '!') { r++; continue; }
      if (toks[r]!.v === '[') { path.push(null); r = f.match[r]! + 1; } else { path.push(toks[r + 1]!.v); r += 2; }
    }
    if (!path.length) return null;
    if (toks[r]?.t === 'p' && ['=', '+=', '||=', '??=', '&&=', '-=', '*='].includes(toks[r]!.v)) return { path, call: false, values: [[r + 1, this.exprEnd(f, r + 1)]] };
    if (toks[r]?.t === 'p' && ['++', '--'].includes(toks[r]!.v)) return { path, call: false, values: [] };
    const m = path.at(-1);
    if (toks[r]?.v === '(' && m && TRACKED_WRITES.has(m)) {
      const args = this.args(f, r);
      const vals = m === 'splice' ? args.slice(2) : m === 'fill' ? args.slice(0, 1) : args;
      return { path, call: true, values: vals.map(([a, c]) => (toks[a]!.v === '...' ? [a + 1, c] : [a, c]) as [number, number]) };
    }
    return null;
  }

  /** How an array/object reference at q (not a tracked write) is used: null for a read, else why it may
   * let other code fill the value (alias, store, unknown method or callee). */
  useKind(f: FileInfo, q: number, depth: number): string | null {
    if (depth > 6) return 'use chain too deep';
    const toks = f.toks;
    const { start, after } = this.refBase(f, q);
    let r = after, derived = false;
    for (;;) {
      const t = toks[r];
      if (t?.v === '!' && toks[r + 1]?.v !== '=') { r++; continue; }
      if ((t?.v === '.' || t?.v === '?.') && toks[r + 1]?.t === 'id') {
        const m = toks[r + 1]!.v;
        let open = r + 2;
        if (toks[open]?.v === '!') open++;
        if (toks[open]?.v === '(') {
          if (VALUE_READS.has(m)) return null; // a string, number or boolean comes out
          if (ELEMENT_READS.has(m)) {
            const cb = this.args(f, open)[0];
            if (cb && CALLBACK_METHODS.has(m)) {
              // the element parameter of the callback must not be written or handed on
              const lit = f.fns.find((x) => x.ps === cb[0] || x.ps === cb[0] + 1);
              const named = !lit && cb[1] === cb[0] + 1 && toks[cb[0]]!.t === 'id' ? this.findFn(f, cb[0], toks[cb[0]]!.v) : null;
              const target = lit ? { file: f, fn: lit } : named;
              if (!target) return 'an unresolved .' + m + '() callback';
              const p = this.elementsMaybeCollection(f, this.chainStart(f, r), r, 0) ? target.fn.params.find((x) => x.idx === (m === 'reduce' ? 1 : 0)) : undefined;
              if (p && (p.pattern || this.paramMutated(target.file, target.fn, p, depth + 1))) return 'an element is changed in the .' + m + '() callback';
              // the array itself is the last callback argument
              const arr = target.fn.params.find((x) => x.idx === (m === 'reduce' ? 3 : 2));
              if (arr && (arr.pattern || arr.rest || this.paramMutated(target.file, target.fn, arr, depth + 1))) return 'the array is changed in the .' + m + '() callback';
              if (target.fn.params.some((x) => x.rest)) return 'a rest parameter in the .' + m + '() callback';
            }
            if (['some', 'every', 'findIndex', 'forEach'].includes(m)) return null; // a boolean, a number or nothing
            if (m === 'sort' || m === 'reverse') { r = f.match[open]! + 1; continue; } // the same array again
            // a new array (map/filter/slice/…) or an element: it leads back into this value only through its elements
            if (!this.elementsMaybeCollection(f, this.chainStart(f, r), r, 0)) return null;
            r = f.match[open]! + 1; derived = true; continue;
          }
          return 'calls .' + m + '()';
        }
        if (m === 'length' || m === 'size') return null;
        r += 2; continue;
      }
      if (t?.v === '[') { r = f.match[r]! + 1; continue; }
      if (t?.v === '(') return 'called';
      if (t?.t === 'tb' || t?.t === 'str') return 'tagged template';
      break;
    }
    const nx = toks[r], prev = toks[start - 1];
    if (nx?.t === 'p' && ['=', '+=', '||=', '??=', '&&=', '-=', '*=', '++', '--'].includes(nx.v) && r !== after) return derived ? 'written through a derived value' : null;
    if (prev?.t === 'id' && ['return', 'yield', 'throw', 'await'].includes(prev.v)) return prev.v === 'await' ? 'awaited (the result is the same value)' : 'returned';
    if (prev?.t === 'p' && prev.v === '>') return 'type assertion or comparison';
    if (prev?.t === 'id' && prev.v === 'of') return this.loopEscapes(f, start - 1, depth);
    // the value taken out is a string or number: nothing to fill
    if (r !== after && !this.pathMaybeCollection(f, q, after, r)) return null;
    // `const t = x[k]`: an alias that is itself only read is a read
    if (prev?.v === '=' && toks[start - 2]?.t === 'id' && /^(const|let|var)$/.test(toks[start - 3]?.v ?? '') && depth < 4) {
      const alias = toks[start - 2]!.v, at = start - 2;
      for (const q2 of f.occ.get(alias) ?? []) {
        if (q2 === at || ['.', '?.'].includes(toks[q2 - 1]?.v ?? '')) continue;
        const b2 = this.bindingScope(f, q2, alias);
        if (!b2 || b2.param || b2.decl?.q !== at) continue;
        const { after: a2 } = this.refBase(f, q2);
        if (a2 === q2 + 1 && toks[a2]?.t === 'p' && ['=', '+=', '||=', '??=', '&&='].includes(toks[a2]!.v)) continue; // re-bound
        if (this.writePath(f, a2)) return 'alias `' + alias + '` written at line ' + this.line(f, q2)[0];
        const u = this.useKind(f, q2, depth + 1);
        if (u) return 'alias `' + alias + '`: ' + u;
      }
      return null;
    }
    if (prev?.t === 'p' && ['=', '=>', '?', '||', '??', '&&'].includes(prev.v)) return 'aliased';
    if (prev?.t === 'p' && prev.v === ':') return 'stored in an object or chosen by ?:';
    if (nx?.t === 'p' && (nx.v === '||' || nx.v === '??')) return 'aliased';
    if (prev?.t === 'p' && ['(', ',', '[', '{', '...'].includes(prev.v)) {
      const open = this.opener(f, start);
      const o = toks[open];
      if (o?.v === '(' && this.isCallParen(f, open)) return this.argReadOnly(f, open, start, depth) ? null : 'passed to ' + this.calleeName(f, open) + '()';
      // a spread copies one level: nested arrays/objects stay shared
      if (prev.v === '...' && o && o.v === '[') return this.elementsMaybeCollection(f, q, q + 1, 0) ? 'spread with shared elements' : null;
      if (prev.v === '...' && o && o.v === '{') return 'spread into an object (shared members)';
      if (o?.v === '(' && prev.v === ',') return 'comma operator';
      // `a[x]` is an index read; `[x]` / `{ x }` after an operator is a literal that keeps it
      const indexed = o?.v === '[' && (toks[open - 1]?.t === 'id' || [')', ']', '!'].includes(toks[open - 1]?.v ?? '')) && !/^(return|of|in|typeof|case|yield|await)$/.test(toks[open - 1]?.v ?? '');
      if (o && (o.v === '[' || o.v === '{') && !indexed && !f.fns.some((x) => x.ps === open)) return 'stored in a literal';
    }
    return null;
  }

  /** `for (const v of x)`: the loop variable must not be written or escape (it is x's element). */
  loopEscapes(f: FileInfo, ofTok: number, depth: number): string | null {
    const toks = f.toks;
    const open = this.opener(f, ofTok);
    if (open < 0 || toks[open - 1]?.v !== 'for') return 'iterated in an unknown construct';
    if (!/^(const|let|var)$/.test(toks[open + 1]?.v ?? '') && !(toks[open + 1]?.v === 'await' && /^(const|let|var)$/.test(toks[open + 2]?.v ?? ''))) return 'iterated into an outer binding';
    // elements that are strings or numbers cannot be filled
    if (!this.elementsMaybeCollection(f, ofTok + 1, this.exprEnd(f, ofTok + 1), 0)) return null;
    const names: number[] = [];
    for (let z = open + 1; z < ofTok; z++) if (toks[z]!.t === 'id' && !/^(const|let|var|await)$/.test(toks[z]!.v) && toks[z + 1]?.v !== ':') names.push(z);
    for (const z of names) {
      const v = toks[z]!.v;
      for (const q of f.occ.get(v) ?? []) {
        if (q <= ofTok || ['.', '?.'].includes(toks[q - 1]?.v ?? '')) continue;
        const b = this.bindingScope(f, q, v);
        if (!b || b.param) continue;
        if (b.decl?.q !== z) continue;
        const { after } = this.refBase(f, q);
        if (this.writePath(f, after)) return 'loop element `' + v + '` written at line ' + this.line(f, q)[0];
        const u = this.useKind(f, q, depth + 1);
        if (u) return 'loop element `' + v + '` ' + u;
      }
    }
    return null;
  }

  /** The call whose `(` is at open only reads its argument at token q. */
  argReadOnly(f: FileInfo, open: number, q: number, depth: number): boolean {
    const toks = f.toks;
    if (f.fns.some((x) => x.ps === open)) return true; // a parameter list, not a call
    const idx = this.args(f, open).findIndex(([a, b]) => a <= q && q < b);
    // `x.name<T>(…)`: the callee name sits before the type arguments
    if (toks[open - 1]?.v === '>') {
      let d = 0, r = open - 1;
      for (; r > 0; r--) { const v = toks[r]!.v; if (v === '>') d++; else if (v === '<' && --d === 0) break; }
      open = r;
    }
    const name = toks[open - 1]?.v ?? '';
    const member = toks[open - 2]?.v === '.' || toks[open - 2]?.v === '?.';
    if (member) {
      const recv = toks[open - 3]?.v;
      if (recv === 'Object' && ['keys', 'freeze', 'isFrozen', 'getOwnPropertyNames'].includes(name)) return true;
      if (recv === 'JSON' && name === 'stringify') return true;
      if (recv === 'Array' && name === 'isArray') return true;
      if (recv === 'assert') return true;
      if (recv === 'Math' || recv === 'Number' || recv === 'String') return true;
      if (recv === 'Object' || recv === 'Reflect' || recv === 'Array') return false;
      if (name === 'query') return true; // pg reads its values array
      // a repository method of that name decides, whatever the receiver
      const methods = [...this.files.values()].flatMap((file) => file.fns.filter((x) => x.method && x.name === name).map((fn) => ({ file, fn })));
      if (methods.length) return methods.every(({ file, fn }) => { const p = fn.params.find((x) => x.idx === idx); return !p || (!p.rest && !p.pattern && !this.paramMutated(file, fn, p, depth + 1)); }) && !methods.some(({ fn }) => fn.params.some((x) => x.rest));
      return BUILTIN_READ_ARG.has(name);
    }
    if (toks[open - 1]?.t !== 'id') return false;
    if (GLOBAL_PURE.has(name) || name === 'assert') return true;
    const callee = this.findFn(f, open - 1, name);
    if (!callee) return false;
    const p = callee.fn.params.find((x) => x.idx === idx);
    if (!p) return !callee.fn.params.some((x) => x.rest) && !/\barguments\b/.test(f.src.slice(f.toks[callee.fn.bs]!.s, f.toks[callee.fn.be]!.e));
    return !p.rest && !p.pattern && !this.paramMutated(callee.file, callee.fn, p, depth + 1);
  }

  /** The reference at token q (an identifier, e.g. an imported binding) writes into its value or lets it escape. */
  refChanges(f: FileInfo, q: number): boolean {
    const { after } = this.refBase(f, q);
    const nx = f.toks[after];
    if (after === q + 1 && nx?.t === 'p' && ['=', '+=', '||=', '??=', '&&='].includes(nx.v)) return true;
    return !!this.writePath(f, after) || this.useKind(f, q, 0) !== null;
  }

  /** `const NAME = { …method… }`: the binding holding an object-literal method, or null (a class, or no binding). */
  methodOwner(f: FileInfo, fn: Fn): { name: string; q: number } | null {
    const toks = f.toks;
    const o = this.opener(f, fn.head);
    if (o < 0 || toks[o]!.v !== '{' || this.enclosing(f, o) !== fn.parent) return null;
    let r = o - 1;
    if (toks[r]?.v !== '=') return null;
    // `const NAME: T = {` / `const NAME = {`
    for (let z = r - 1; z >= 0 && z > r - 40; z--) {
      if (/^(const|let|var)$/.test(toks[z]!.v) && toks[z + 1]?.t === 'id') return { name: toks[z + 1]!.v, q: z + 1 };
      if (toks[z]!.v === ';' || toks[z]!.v === '{' || toks[z]!.v === '}') break;
    }
    return null;
  }

  /** q lies in the parameter list (with types) of a function. */
  enclosingParamList(f: FileInfo, q: number): boolean {
    for (let fn = this.enclosing(f, q); fn; fn = fn.parent) if (q > fn.ps && q < fn.pe) return true;
    return false;
  }

  /** fn is a function literal passed as the first argument of `.map(`/`.filter(`/… */
  isArrayCallback(f: FileInfo, fn: Fn): boolean {
    const toks = f.toks;
    const before = toks[fn.ps - 1]?.v === 'async' ? fn.ps - 2 : fn.ps - 1;
    return toks[before]?.v === '(' && CALLBACK_METHODS.has(toks[before - 1]?.v ?? '') && ['.', '?.'].includes(toks[before - 2]?.v ?? '');
  }

  /** The value at the end of the read path [after, end) from the binding at q may be an array/object
   * (false when the binding's literal shows only strings/numbers there). */
  pathMaybeCollection(f: FileInfo, q: number, after: number, end: number): boolean {
    const toks = f.toks;
    const steps: (string | null)[] = [];
    for (let r = after; r < end;) {
      if (toks[r]!.v === '!') { r++; continue; }
      if ((toks[r]!.v === '.' || toks[r]!.v === '?.') && toks[r + 1]?.t === 'id') { steps.push(toks[r + 1]!.v); r += 2; continue; }
      if (toks[r]!.v === '[') { steps.push(null); r = f.match[r]! + 1; continue; }
      return true; // a call in the path
    }
    const d = this.declsOf(f, q, toks[q]!.v);
    if (!d) return true;
    // starting values: the literal initialisers, or for a parameter the argument of every call (or its default)
    let ranges: [FileInfo, number, number][];
    if (d.kind === 'param') {
      const fn = d.fn!, p = d.param!;
      if (!fn.name || p.pattern || p.rest) return true;
      const callers = this.callSites(f, fn);
      if (typeof callers === 'string') return true;
      ranges = [];
      for (const c of callers) { const a = c.args[p.idx]; if (a) ranges.push([c.file, a[0], a[1]]); else if (p.def) ranges.push([f, p.def[0], p.def[1]]); }
      if (!ranges.length) return true;
    } else {
      if (d.kind !== 'decl' || !d.inits.length || (d.plain ?? []).length || (d.members ?? []).length) return true;
      if (d.inits.some(([a]) => a < 0)) return true;
      ranges = d.inits.map(([a, b]) => [f, a, b]);
    }
    for (const st of steps) {
      const next: [FileInfo, number, number][] = [];
      for (const [file, a0, b0] of ranges) {
        const t = file.toks;
        const [a, b] = this.core(file, a0, b0);
        const o = t[a]!;
        if (!((o.v === '{' || o.v === '[') && file.match[a] === b - 1)) return true;
        let found = false;
        for (const [x, y] of this.split(file, a + 1, b - 1, (k) => k.t === 'p' && k.v === ',')) {
          if (x >= y) continue;
          if (t[x]!.v === '...' || (o.v === '{' && t[x]!.v === '[')) return true;
          if (o.v === '[') { if (st === null) { next.push([file, x, y]); found = true; } continue; }
          if (st !== null && t[x]!.v !== st) continue;
          if (t[x + 1]?.v === ':') { next.push([file, x + 2, y]); found = true; } else if (y === x + 1) { next.push([file, x, y]); found = true; } else return true;
        }
        // absent from an object literal: undefined, unless the name is inherited (constructor, __proto__, toString…)
        if (!found && (o.v === '[' || st === null || st in Object.prototype || st === '__proto__')) return true;
      }
      ranges = next;
    }
    return ranges.some(([file, a, b]) => this.maybeCollection(file, a, b, 0));
  }

  /** The elements of [s,e) may be arrays/objects (false: provably strings/numbers, e.g. a literal list). */
  elementsMaybeCollection(f: FileInfo, s0: number, e0: number, depth: number): boolean {
    if (depth > 8) return true;
    const [s, e] = this.core(f, s0, e0);
    if (s >= e) return true;
    const toks = f.toks;
    const br = this.branches(f, s, e);
    if (br) return br.some(([a, b]) => this.elementsMaybeCollection(f, a, b, depth + 1));
    const t = toks[s]!;
    if (t.v === '[' && f.match[s] === e - 1)
      return this.split(f, s + 1, e - 1, (x) => x.t === 'p' && x.v === ',').some(([a, b]) => a < b && (toks[a]!.v === '...' ? this.elementsMaybeCollection(f, a + 1, b, depth + 1) : this.maybeCollection(f, a, b, depth + 1)));
    if (toks[e - 1]!.v === ')') {
      const open = f.match[e - 1]!;
      const m = toks[open - 1]?.v;
      if (m === 'keys' && toks[open - 3]?.v === 'Object') return false;
      if (m === 'split' || m === 'match') return false;
      if (['filter', 'slice', 'sort', 'reverse', 'toSorted', 'concat'].includes(m ?? '') && (toks[open - 2]?.v === '.' || toks[open - 2]?.v === '?.')) return this.elementsMaybeCollection(f, s, open - 2, depth + 1);
    }
    if (t.t === 'id' && e === s + 1) {
      const d = this.declsOf(f, s, t.v);
      if (d?.kind === 'import') { const tf = this.files.get(d.imp!.from); const name = tf ? (tf.exportAs.get(d.imp!.name) ?? d.imp!.name) : ''; const at = tf ? tf.toks.findIndex((x, i) => x.t === 'id' && x.v === name && /^(const|let|var)$/.test(tf.toks[i - 1]?.v ?? '')) : -1; return at < 0 || this.elementsMaybeCollection(tf!, at, at + 1, depth + 1); }
      if (d?.kind !== 'decl' || !d.inits.length) return true;
      return d.inits.some(([a, b]) => a < 0 || a === b || this.elementsMaybeCollection(f, a, b, depth + 1)) || (d.plain ?? []).some(([a, b]) => this.elementsMaybeCollection(f, a, b, depth + 1))
        || d.assigns.filter((r) => !(d.plain ?? []).includes(r)).some(([a, b]) => this.maybeCollection(f, a, b, depth + 1));
    }
    return true;
  }

  /** [s,e) is one identifier bound to a parameter that its function fills or hands on: the reason. Only when a
   * caller may pass an array/object (a string parameter cannot be filled). */
  paramChanged(f: FileInfo, s: number, e: number): string | null {
    const t = f.toks[s]!;
    if (e !== s + 1 || t.t !== 'id') return null;
    const b = this.bindingScope(f, s, t.v);
    if (!b?.param || b.param.pattern || !b.scope) return null;
    const fn = b.scope, p = b.param;
    if (fn.method && fn.name === 'query' && p.idx === 0) return null; // SQL text of a query adapter, linted at its callers
    // the element parameter of a .map/.filter/… callback: writes into it are checked on the receiver's binding
    if (!fn.name && this.isArrayCallback(f, fn)) return null;
    if (fn.name && !p.rest) {
      const callers = this.callSites(f, fn);
      if (typeof callers !== 'string' && callers.every((c) => { const a = c.args[p.idx]; return a ? !this.maybeCollection(c.file, a[0], a[1], 0) : !p.def || !this.maybeCollection(f, p.def[0], p.def[1], 0); })) return null;
    }
    return this.paramMutated(f, fn, p, 0) ? 'parameter `' + t.v + '` is changed or handed on inside ' + (fn.name ?? 'its function') : null;
  }

  /** The function writes into its parameter p, or lets it escape (returns, aliases, stores, passes it on to
   * code that may write). Re-binding `p = …` is not a write into the caller's value. */
  paramMutated(f: FileInfo, fn: Fn, p: Param, depth: number): boolean {
    if (depth > 8) return true;
    const key = 'M:' + f.rel + ':' + fn.ps + ':' + p.name;
    if (this.memo.has(key)) return this.memo.get(key) !== null;
    if (this.busy.has(key)) { this.cycles++; return false; } // cycle: optimistic, other uses decide
    this.busy.add(key);
    const c0 = this.cycles;
    const toks = f.toks;
    let out = false;
    for (const q of f.occ.get(p.name) ?? []) {
      if (out) break;
      if (q <= fn.pe || q > fn.be) continue;
      if (['.', '?.'].includes(toks[q - 1]?.v ?? '')) continue;
      const b = this.bindingScope(f, q, p.name);
      if (b?.scope !== fn || b.param !== p) continue;
      const { after } = this.refBase(f, q);
      if (after === q + 1 && toks[after]?.t === 'p' && ['=', '+=', '||=', '??=', '&&='].includes(toks[after]!.v)) continue;
      if (this.writePath(f, after)) { out = true; break; }
      if (this.useKind(f, q, depth + 1)) out = true;
    }
    this.busy.delete(key);
    if (out || this.cycles === c0) this.memo.set(key, out ? 'mutated' : null);
    return out;
  }

  ident(f: FileInfo, at: number, name: string, env: Env, depth: number): string | null {
    if (env.binds.has(name)) {
      // only if the reference resolves to a parameter of a function evaluated with these bindings
      const b = this.bindingScope(f, at, name);
      if (b?.param && env.fnScopes.includes(b.scope!)) return env.binds.get(name)!.reason;
    }
    const d = this.declsOf(f, at, name);
    if (!d) {
      if (name === 'Infinity' || name === 'undefined') return null;
      return '`' + name + '` (unresolved global)';
    }
    if (d.kind === 'import') {
      const target = this.files.get(d.imp!.from);
      if (!target) return '`' + name + '` imported from outside server/ and shared/';
      return this.moduleName(target, d.imp!.name, depth);
    }
    if (d.kind === 'namespace') return 'namespace `' + name + '`';
    if (d.kind === 'param') return this.paramSafety(f, d.fn!, d.param!, env, depth);
    const key = f.rel + ':' + (d.scope ? d.scope.ps : -1) + ':' + (d.blk ? d.blk[0] : -1) + ':' + name;
    if (this.memo.has(key)) return this.memo.get(key)!;
    if (this.busy.has(key)) { this.cycles++; return null; } // cycle: other operands decide
    this.busy.add(key);
    const c0 = this.cycles;
    let r: string | null = d.bad ?? null;
    const scEnv: Env = { binds: env.binds, fnScopes: env.fnScopes };
    for (const [a, b] of d.inits) {
      if (r) break;
      if (a === b) continue; // function / class declaration
      if (a < 0) { const rr = this.paramChanged(f, -a, b) ?? this.safe(f, -a, b, scEnv, depth + 1); r = rr ? 'element of ' + rr : null; }
      else r = this.safe(f, a, b, scEnv, depth + 1);
    }
    for (const [a, b] of d.assigns) { if (r) break; r = this.safe(f, a, b, scEnv, depth + 1); }
    this.busy.delete(key);
    if (r) r = '`' + name + '` ← ' + r;
    // results depending on env bindings are not memoised
    if (env.binds.size === 0 && (r !== null || this.cycles === c0)) this.memo.set(key, r);
    return r;
  }

  moduleName(target: FileInfo, name: string, depth: number): string | null {
    name = target.exportAs.get(name) ?? name;
    const d = this.declsOf(target, 0, name);
    if (!d) return '`' + name + '` not found in ' + target.rel;
    if (d.kind === 'import') { const t2 = this.files.get(d.imp!.from); return t2 ? this.moduleName(t2, d.imp!.name, depth + 1) : '`' + name + '` from outside'; }
    // evaluate at module scope of target
    const at = target.toks.findIndex((t, i) => t.t === 'id' && t.v === name && /^(const|let|var|function|class)$/.test(target.toks[i - 1]?.v ?? ''));
    return this.ident(target, at < 0 ? 0 : at, name, { binds: new Map(), fnScopes: [] }, depth + 1);
  }

  /** A parameter: the arguments at every call site, or the element of a callback receiver. */
  paramSafety(f: FileInfo, fn: Fn, p: Param, env: Env, depth: number): string | null {
    if (depth > 30) return 'parameter chain too deep';
    const key = 'P:' + f.rel + ':' + fn.ps + ':' + p.name;
    if (this.memo.has(key)) return this.memo.get(key)!;
    if (this.busy.has(key)) { this.cycles++; return null; }
    this.busy.add(key);
    const c0 = this.cycles;
    const r = this.paramSafety0(f, fn, p, depth);
    this.busy.delete(key);
    if (r !== null || this.cycles === c0) this.memo.set(key, r);
    void env;
    return r;
  }

  paramSafety0(f: FileInfo, fn: Fn, p: Param, depth: number): string | null {
    const toks = f.toks;
    const empty: Env = { binds: new Map(), fnScopes: [] };
    const label = 'parameter `' + p.name + '` of ' + (fn.name ?? 'anonymous function');
    // callback of a known array method
    const before = toks[fn.ps - 1]?.v === 'async' ? fn.ps - 2 : fn.ps - 1;
    const bt = toks[before];
    if (!fn.name && bt?.t === 'p' && (bt.v === '(' || bt.v === ',')) {
      const open = bt.v === '(' ? before : this.openParen(f, before);
      const m = toks[open - 1]?.v ?? '';
      if (open > 1 && CALLBACK_METHODS.has(m) && (toks[open - 2]?.v === '.' || toks[open - 2]?.v === '?.')) {
        if (p.idx >= 1 && m !== 'reduce') return null; // index / array
        if (m === 'reduce' && p.idx >= 2) return null;
        if (m === 'reduce' && p.idx === 0) {
          const args = this.args(f, open);
          return args[1] ? this.safe(f, args[1][0], args[1][1], empty, depth + 1) : label + ': reduce accumulator';
        }
        // receiver = expression before `.m(`
        const recvEnd = open - 2;
        const recvStart = this.chainStart(f, recvEnd);
        const r = this.safe(f, recvStart, recvEnd, empty, depth + 1);
        return r ? label + ' = element of ' + r : null;
      }
      if (open > 1 && m === 'from' && toks[open - 3]?.v === 'Array') {
        if (p.idx >= 1) return null;
        const args = this.args(f, open);
        const r = args[0] ? this.safe(f, args[0][0], args[0][1], empty, depth + 1) : null;
        return r ? label + ' = element of ' + r : null;
      }
      return label + ': callback of ' + (m || 'expression') + ' (callers unknown)';
    }
    if (!fn.name) return label + ': callers unknown';
    // the SQL text parameter of a `query` adapter method ({ query: (sql, args) => c.query(sql, args) }):
    // its callers are `.query(…)` calls, and every one of them is a site this lint checks on its own
    if (fn.method && fn.name === 'query' && p.idx === 0) return null;
    if (p.rest) return label + ': rest parameter';
    // every reference to the function must be a direct call; check each call's argument
    const callers = this.callSites(f, fn);
    if (typeof callers === 'string') return label + ': ' + callers;
    for (const c of callers) {
      const a = c.args[p.idx];
      let r: string | null;
      if (p.pattern) r = a ? this.objectProp(c.file, a, p.name, empty, depth + 1) : null;
      else r = a ? this.safe(c.file, a[0], a[1], empty, depth + 1) : p.def ? this.safe(f, p.def[0], p.def[1], empty, depth + 1) : null;
      if (r) { const [l] = this.line(c.file, a ? a[0] : c.at); return label + ' ← ' + c.file.rel + ':' + l + ': ' + r; }
    }
    return null;
  }

  chainStart(f: FileInfo, end: number): number {
    let q = end - 1;
    for (;;) {
      const t = f.toks[q]!;
      if (t.t === 'p' && (t.v === ')' || t.v === ']')) q = f.match[q]!;
      else if (t.t === 'te') { q = f.match[q]!; if (q < 0) return 0; }
      if (q <= 0) return 0;
      const pv = f.toks[q - 1]!;
      if (pv.t === 'p' && (pv.v === '.' || pv.v === '?.')) { q -= 2; continue; }
      if ((f.toks[q]!.v === '(' || f.toks[q]!.v === '[') && (pv.t === 'id' || (pv.t === 'p' && (pv.v === ')' || pv.v === ']')))) { q -= 1; continue; }
      if (f.toks[q]!.v === '!' && q > 0) { q--; continue; }
      return q;
    }
  }

  siteCache = new Map<Fn, Caller[] | string>();
  callSites(f: FileInfo, fn: Fn): Caller[] | string {
    let r = this.siteCache.get(fn);
    if (!r) { r = this.callSites0(f, fn); this.siteCache.set(fn, r); }
    return r;
  }

  callSites0(f: FileInfo, fn: Fn): Caller[] | string {
    const out: { file: FileInfo; at: number; args: [number, number][] }[] = [];
    const name = fn.name!;
    const scan = (file: FileInfo, local: string, member: boolean) => {
      const toks = file.toks;
      for (const q of file.occ.get(local) ?? []) {
        const prev = toks[q - 1];
        const isMember = prev?.t === 'p' && (prev.v === '.' || prev.v === '?.');
        if (member !== isMember) continue;
        if (!member && file === f && (q === fn.ps - 1 || (fn.head <= q && q < fn.ps))) continue; // definition
        if (!member) {
          // a reference bound to something else (a parameter or local of the same name) is not this function
          const b = this.bindingScope(file, q, local);
          if (file === f ? (b?.param !== undefined || (b && b.scope !== fn.parent)) : b !== undefined) continue;
        }
        if (!member && /^(function|const|let|var|class)$/.test(prev?.v ?? '') ) continue;
        if (!member && (prev?.v === 'import' || prev?.v === 'export')) continue;
        let nq = q + 1;
        if (toks[nq]?.v === '<') { let d = 0; for (; nq < toks.length; nq++) { const v = toks[nq]!.v; if (v === '<') d++; else if (v === '>') { if (--d === 0) break; } } nq++; }
        if (toks[nq]?.v === '!') nq++;
        if (toks[nq]?.v === '?.' ) nq++;
        if (toks[nq]?.v === '(') {
          // a signature `name(x: T)` in a type or interface is not a call
          if (toks[nq + 1]?.t === 'id' && (toks[nq + 2]?.v === ':' || (toks[nq + 2]?.v === '?' && toks[nq + 3]?.v === ':'))) continue;
          out.push({ file, at: q, args: this.args(file, nq) });
          continue;
        }
        if (member) {
          // `x.name` used as a value (`.then(x.name)`, `f = x.name`, `x.name.call(…)`) has callers this scan cannot see;
          // `x.name.y` / `x.name[i]` is another object's property of the same name
          const nv = toks[nq]?.v;
          if (nv === '.' && ['call', 'apply', 'bind'].includes(toks[nq + 1]?.v ?? '')) return 'method `' + local + '` used through .' + toks[nq + 1]!.v + ' at ' + file.rel + ':' + this.line(file, q)[0];
          if (nv === '.' || nv === '?.' || nv === '[' || nv === '!' || nv === '=' || nv === '+=') continue;
          if (['===', '!==', '==', '!=', '&&', '||', '??', '?'].includes(nv ?? '')) continue; // a test, not a call
          return 'method `' + local + '` referenced as a value at ' + file.rel + ':' + this.line(file, q)[0];
        }
        // `{ name }` in import/export lists; a renamed or default export has callers this scan cannot see
        if (this.inImportExport(file, q)) continue; // renamed exports are followed through exportAs
        if (file === f && prev?.v === 'default' && toks[q - 2]?.v === 'export') return 'default export at ' + file.rel + ':' + this.line(file, q)[0];
        // method definition token itself
        if (fn.method && file === f && q === fn.ps - 1) continue;
        // object property key `name:` in a type/literal, or a method signature in an interface
        if (toks[nq]?.v === ':' || (toks[nq]?.v === '?' && toks[nq + 1]?.v === ':')) continue;
        const [l] = this.line(file, q);
        return 'referenced without a call at ' + file.rel + ':' + l;
      }
      return null;
    };
    if (fn.method) {
      // a class/object method: every member call `.name(…)` in any file (over-approximated by name)
      for (const file of this.files.values()) { const r = scan(file, name, true); if (r) return r; }
      // the object literal holding the method: used other than as `obj.x` it hands the method to unseen code
      // (`(obj as any)[k]`, `Object.values(obj)`, `const { [k]: f } = obj`, `fn(obj)`)
      const owner = this.methodOwner(f, fn);
      if (owner) {
        const files = [f, ...this.importersOf(f.rel, owner.name).map((x) => x.file), ...(this.dynImporters.get(f.rel) ?? [])];
        for (const file of new Set(files)) for (const q of file.occ.get(owner.name) ?? []) {
          if (file === f && q === owner.q) continue;
          if (['.', '?.'].includes(file.toks[q - 1]?.v ?? '') || this.inImportExport(file, q)) continue;
          if (file === f) { const b = this.bindingScope(f, q, owner.name); if (b?.decl?.q !== owner.q) continue; }
          let a = q + 1;
          if (file.toks[a]?.v === '!') a++;
          if (['.', '?.'].includes(file.toks[a]?.v ?? '') && file.toks[a + 1]?.t === 'id') continue;
          return 'the object holding method `' + name + '` is used as a value at ' + file.rel + ':' + this.line(file, q)[0];
        }
      }
      // `x[k](…)`: a computed call reaches every method whose name k can take
      for (const cc of this.computedCalls()) {
        if (!cc.keys) return 'computed call at ' + cc.file.rel + ':' + this.line(cc.file, cc.open)[0] + ' (callers unknown)';
        if (cc.keys.has(name)) out.push({ file: cc.file, at: cc.open, args: this.args(cc.file, cc.open) });
      }
      // `x['name'](…)` and `const { name } = x` take the method without a visible `.name(` call
      for (const file of this.files.values()) for (let q = 1; q < file.toks.length; q++) {
        const t = file.toks[q]!;
        if (t.t === 'str' && t.v === name && file.toks[q - 1]?.v === '[') return 'method `' + name + '` used by a string key at ' + file.rel + ':' + this.line(file, q)[0];
      }
      for (const file of this.files.values()) for (const q of file.occ.get(name) ?? []) {
        const pv = file.toks[q - 1]?.v;
        if ((pv === '{' || pv === ',') && this.inPattern(file, q) >= 0) return 'method `' + name + '` destructured at ' + file.rel + ':' + this.line(file, q)[0];
      }
      // no caller at all: it is called by code outside the linted set (a library, a script)
      return out.length ? out : 'method `' + name + '` has no caller in the linted files';
    }
    const r = scan(f, name, false);
    if (r) return r;
    const exported = !fn.parent && (/export/.test(f.src.slice(f.toks[Math.max(0, fn.head - 2)]!.s, f.toks[fn.ps]!.s)) || new RegExp('export\\s*\\{[^}]*\\b' + name + '\\b').test(f.src) || /export\s+default/.test(f.src));
    if (exported) {
      // every name the module exports this function under: itself, `export { name as x }`, default
      const names = [name, ...[...f.exportAs].filter(([, l]) => l === name).map(([e]) => e), ...(f.defaultName === name ? ['default'] : [])];
      for (const e of names) for (const imp of this.importersOf(f.rel, e)) {
        if (imp.local) { const rr = scan(imp.file, imp.local, false); if (rr) return rr; continue; }
        const toks = imp.file.toks;
        for (const q of imp.file.occ.get(imp.ns!) ?? []) if (toks[q + 1]?.v === '.' && toks[q + 2]?.v === e) {
          if (toks[q + 3]?.v === '(') out.push({ file: imp.file, at: q + 2, args: this.args(imp.file, q + 3) });
          else return 'referenced without a call at ' + imp.file.rel + ':' + this.line(imp.file, q)[0];
        }
      }
      // a namespace / dynamic-import binding of this module used other than as `N.x` hands its functions on
      for (const e of names) for (const imp of this.importersOf(f.rel, e)) if (imp.ns) {
        for (const q of imp.file.occ.get(imp.ns) ?? []) {
          if (['.', '?.'].includes(imp.file.toks[q - 1]?.v ?? '') || imp.file.toks[q - 1]?.v === 'as' || this.inImportExport(imp.file, q)) continue;
          if (['.', '?.'].includes(imp.file.toks[q + 1]?.v ?? '') && imp.file.toks[q + 2]?.t === 'id') continue;
          return 'namespace `' + imp.ns + '` used as a value at ' + imp.file.rel + ':' + this.line(imp.file, q)[0];
        }
      }
      for (const other of this.dynImporters.get(f.rel) ?? []) {
        const t = other.toks;
        for (const q of other.occ.get('import') ?? []) {
          if (t[q + 1]?.v !== '(' || t[q + 2]?.t !== 'str' || resolveModule(this.root, other.rel, t[q + 2]!.v, new Set(this.files.keys())) !== f.rel) continue;
          const close = other.match[q + 1]!;
          // `(await import('./x')).name(…)` is a member call (scanned by name); `const { a } = await import(…)` too
          const awaited = t[q - 1]?.v === 'await' ? q - 1 : q;
          const pv = t[awaited - 1];
          if (pv?.v === '(' && t[close + 1]?.v === ')' && ['.', '?.'].includes(t[close + 2]?.v ?? '') && t[close + 3]?.t === 'id') continue;
          if (pv?.v === '=') {
            let z = awaited - 2;
            if (t[z]?.t === 'id' && !/^(const|let|var)$/.test(t[z]!.v) && t[z - 1]?.v === ':') z -= 2; // `m: any =`
            if (t[z]?.v === '}') { const ob = other.match[z]!; let comp = false; for (let y = ob; y < z; y++) if (t[y]!.v === '[' || t[y]!.v === '...') comp = true; if (!comp) continue; return 'computed destructuring of a dynamic import at ' + other.rel + ':' + this.line(other, q)[0]; }
            if (t[z]?.t === 'id') {
              const m = t[z]!.v;
              for (const r of other.occ.get(m) ?? []) {
                if (r === z || ['.', '?.'].includes(t[r - 1]?.v ?? '')) continue;
                if (['.', '?.'].includes(t[r + 1]?.v ?? '') && t[r + 2]?.t === 'id') continue;
                return 'dynamic import binding `' + m + '` used as a value at ' + other.rel + ':' + this.line(other, r)[0];
              }
              continue;
            }
          }
          if (pv?.v === '(' && t[close + 1]?.v === ')') return 'dynamic import used as a value at ' + other.rel + ':' + this.line(other, q)[0];
        }
      }
      // `N[k](…)` on a namespace or a dynamic import of this module (any computed call in such a file)
      const nsFiles = new Set<FileInfo>([...this.dynImporters.get(f.rel) ?? []]);
      for (const e of names) for (const imp of this.importersOf(f.rel, e)) if (imp.ns) nsFiles.add(imp.file);
      for (const cc of this.computedCalls()) if (nsFiles.has(cc.file)) {
        if (!cc.keys) return 'computed call at ' + cc.file.rel + ':' + this.line(cc.file, cc.open)[0] + ' (callers unknown)';
        if (names.some((e) => cc.keys!.has(e))) out.push({ file: cc.file, at: cc.open, args: this.args(cc.file, cc.open) });
      }
      // `await import('./x')`: every occurrence of the name in an importing file (no binding check)
      for (const other of this.dynImporters.get(f.rel) ?? []) {
        const toks = other.toks;
        for (const q of other.occ.get(name) ?? []) {
          const nx = toks[q + 1], pv = toks[q - 1];
          if (nx?.v === '(') { out.push({ file: other, at: q, args: this.args(other, q + 1) }); continue; }
          if ((pv?.v === '{' || pv?.v === ',') && (nx?.v === ',' || nx?.v === '}')) continue; // destructured: its calls are other occurrences
          return 'referenced without a call (dynamic import) at ' + other.rel + ':' + this.line(other, q)[0];
        }
      }
      // an exported function nobody in server/ or shared/ calls is called from elsewhere (scripts, tests)
      if (!out.length) return 'exported `' + name + '` has no caller in the linted files';
    }
    return out;
  }

  /** Every `x[k](…)` / `(x as T)[k](…)` / `x[k]!(…)` call; keys: the strings k can be, null when unknown. */
  ccCache: { file: FileInfo; open: number; keys: Set<string> | null }[] | null = null;
  computedCalls(): { file: FileInfo; open: number; keys: Set<string> | null }[] {
    if (this.ccCache) return this.ccCache;
    const out: { file: FileInfo; open: number; keys: Set<string> | null }[] = [];
    for (const file of this.files.values()) {
      const t = file.toks;
      for (let q = 1; q < t.length; q++) {
        if (t[q]!.v !== '[' || t[q]!.t !== 'p') continue;
        const pv = t[q - 1]!;
        if (!(pv.t === 'id' || [')', ']', '!'].includes(pv.v)) || /^(return|of|in|typeof|case|yield|await)$/.test(pv.v)) continue;
        const close = file.match[q]!;
        let open = close + 1;
        if (t[open]?.v === '!') open++;
        if (t[open]?.v !== '(') continue;
        out.push({ file, open, keys: this.literalValues(file, q + 1, close, 0) });
      }
    }
    this.ccCache = out;
    return out;
  }

  /** The strings an expression can evaluate to (literals, ?: of literals, a const of them, a parameter every
   * caller passes one to); null when not known. */
  literalValues(f: FileInfo, s0: number, e0: number, depth: number): Set<string> | null {
    if (depth > 6) return null;
    const [s, e] = this.core(f, s0, e0);
    if (s >= e) return null;
    const br = this.branches(f, s, e);
    if (br) {
      const all = new Set<string>();
      for (const [a, b] of br) { const v = this.literalValues(f, a, b, depth + 1); if (!v) return null; for (const x of v) all.add(x); }
      return all;
    }
    const t = f.toks[s]!;
    if (e === s + 1 && t.t === 'str') return new Set([t.v]);
    if (e === s + 1 && t.t === 'id') {
      const d = this.declsOf(f, s, t.v);
      if (!d) return null;
      const ranges: [FileInfo, number, number][] = [];
      if (d.kind === 'param') {
        const fn = d.fn!, p = d.param!;
        if (!fn.name || p.pattern || p.rest) return null;
        const callers = this.callSites(f, fn);
        if (typeof callers === 'string') return null;
        for (const c of callers) { const a = c.args[p.idx]; if (a) ranges.push([c.file, a[0], a[1]]); else if (p.def) ranges.push([f, p.def[0], p.def[1]]); else return null; }
        if (!callers.length && p.def) ranges.push([f, p.def[0], p.def[1]]);
      } else if (d.kind === 'decl') {
        if (!d.inits.length || d.inits.some(([a, b]) => a < 0 || a === b) || (d.members ?? []).length) return null;
        for (const [a, b] of [...d.inits, ...(d.plain ?? [])]) ranges.push([f, a, b]);
      } else return null;
      const all = new Set<string>();
      for (const [file, a, b] of ranges) { const v = this.literalValues(file, a, b, depth + 1); if (!v) return null; for (const x of v) all.add(x); }
      return all.size ? all : null;
    }
    return null;
  }

  inImportExport(f: FileInfo, q: number): boolean {
    for (let r = q - 1; r >= 0 && r > q - 400; r--) {
      const t = f.toks[r]!;
      if (t.t === 'p' && t.v === '{') return f.toks[r - 1]?.v === 'import' || f.toks[r - 1]?.v === 'export' || (f.toks[r - 1]?.v === ',' && f.toks[r - 3]?.v === 'import') || (f.toks[r - 1]?.t === 'id' && f.toks[r - 2]?.v === 'import');
      if (t.t === 'p' && (t.v === ';' || t.v === '}' || t.v === '(' || t.v === ')')) return false;
    }
    return false;
  }

  /** All `.query(` sites with verdicts. */
  sites(only?: (rel: string) => boolean): Site[] {
    const out: Site[] = [];
    for (const f of this.files.values()) {
      if (only && !only(f.rel)) continue;
      const toks = f.toks;
      for (let i = 1; i < toks.length; i++) {
        const t = toks[i]!;
        if (!(t.t === 'id' && t.v === 'query')) continue;
        const prev = toks[i - 1]!;
        if (!(prev.t === 'p' && (prev.v === '.' || prev.v === '?.'))) continue;
        let j = i + 1;
        if (toks[j]?.v === '<') { let d = 0; for (; j < toks.length; j++) { const v = toks[j]!.v; if (toks[j]!.t !== 'p') continue; if (v === '<') d++; else if (v === '>') { if (--d === 0) break; } } j++; }
        const [line, col] = this.line(f, i);
        const fn = this.enclosing(f, i);
        const fnName = fn ? (fn.name ?? this.nearestName(fn)) : null;
        if (toks[j]?.v === '.' && ['call', 'apply', 'bind'].includes(toks[j + 1]?.v ?? '')) {
          // the SQL text of c.query.call(c, sql) / c.query.bind(c) is not the first argument here
          out.push({ file: f.rel, line, col, fn: fnName, text: f.src.slice(t.s, toks[j + 1]!.e), key: '', verdict: 'dynamic', reason: '.query used through .' + toks[j + 1]!.v });
          continue;
        }
        if ((toks[j]?.v === '?.' || toks[j]?.v === '!') && toks[j + 1]?.v === '(') j++;
        else if (toks[j]?.v === ')' || (toks[j]?.t === 'id' && toks[j]!.v === 'as')) {
          const close = toks[j]!.v === ')' ? j : this.typeEnd(f, j + 1, toks.length);
          const open = f.match[close] ?? -1;
          if (toks[close]?.v === ')' && open >= 0 && open < i && toks[close + 1]?.v === '(') j = close + 1;
        }
        if (toks[j]?.v !== '(') continue;
        const args = this.args(f, j);
        if (!args.length) { out.push({ file: f.rel, line, col, fn: fnName, text: '', key: '', verdict: 'dynamic', reason: 'no arguments' }); continue; }
        const [a, b] = args[0]!;
        // a signature `query(sql: string)` in a type is not a call
        if (toks[a + 1]?.v === ':' && toks[a]!.t === 'id') continue;
        const full = f.src.slice(toks[a]!.s, toks[b - 1]!.e).replace(/\s+/g, ' ');
        const site = { file: f.rel, line, col, fn: fnName, text: full.slice(0, 160), key: createHash('sha256').update(full).digest('hex').slice(0, 16) };
        // a literal, or literals joined by +
        let literal = true;
        for (let q = a; q < b; q++) { const k = toks[q]!; if (!(k.t === 'str' || (k.t === 'p' && (k.v === '+' || k.v === '(' || k.v === ')')))) { literal = false; break; } }
        if (literal) { out.push({ ...site, verdict: 'literal', reason: '' }); continue; }
        // pg reads `config.text` of an object argument and a string argument as is; propOf covers both
        const r = this.propOf(f, a, b, 'text', { binds: new Map(), fnScopes: [] }, 0);
        out.push({ ...site, verdict: r ? 'dynamic' : 'constant', reason: r ?? '' });
      }
    }
    // the query method of a client (a binding with a direct `.query(` call) used any other way
    for (const f of this.files.values()) {
      if (only && !only(f.rel)) continue;
      const toks = f.toks;
      const clients = new Set<string>();
      const bindingKey = (q: number) => { const b = this.bindingScope(f, q, toks[q]!.v); return b ? (b.param ? 'p' + b.scope!.ps + ':' + b.param.name : 'd' + (b.decl?.q ?? -1)) : 'g' + toks[q]!.v; };
      for (const q of f.occ.get('query') ?? []) {
        if (!['.', '?.'].includes(toks[q - 1]?.v ?? '') || toks[q - 2]?.t !== 'id') continue;
        let j = q + 1;
        if (toks[j]?.v === '<') { const c = this.genericClose(f, j, toks.length); if (c > 0) j = c + 1; }
        if (toks[j]?.v === '(' || ((toks[j]?.v === '?.' || toks[j]?.v === '!') && toks[j + 1]?.v === '(')) clients.add(bindingKey(q - 2));
      }
      // a binding used like a request or data object (`x.body`, `x.query.k`): its `.query` is data, not a method
      const dataLike = new Set<string>();
      for (const q of f.occ.get('query') ?? []) if (['.', '?.'].includes(toks[q - 1]?.v ?? '') && toks[q - 2]?.t === 'id' && ['.', '?.', '['].includes(toks[q + 1]?.v ?? '') && !['call', 'apply', 'bind'].includes(toks[q + 2]?.v ?? '')) dataLike.add(bindingKey(q - 2));
      for (const prop of ['body', 'params', 'headers', 'url', 'method', 'cookies', 'raw', 'routeOptions'])
        for (const q of f.occ.get(prop) ?? []) if (['.', '?.'].includes(toks[q - 1]?.v ?? '') && toks[q - 2]?.t === 'id') dataLike.add(bindingKey(q - 2));
      // a request object: a parameter typed …Request, or a parameter of a route/hook handler (`app.get(…, (req) => …)`)
      const ROUTE = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all', 'route', 'addHook', 'setErrorHandler', 'setNotFoundHandler', 'onRequest', 'preHandler', 'preValidation', 'onSend', 'register', 'decorate', 'decorateRequest']);
      const requestLike = (q: number) => {
        const b = this.bindingScope(f, q, toks[q]!.v);
        if (!b?.param) return false;
        if (/^(req|request|r|original|raw)$/.test(b.param.name)) return true; // the handler naming convention (documented residual)
        const fn = b.scope!;
        const ann = f.src.slice(toks[fn.ps]!.s, toks[fn.pe]!.e);
        if (new RegExp('\\b' + b.param.name + '\\s*\\??\\s*:\\s*[^,)]*Request\\b').test(ann)) return true;
        const before = toks[fn.ps - 1]?.v === 'async' ? fn.ps - 2 : fn.ps - 1;
        const open = toks[before]?.v === '(' ? before : toks[before]?.v === ',' ? this.openParen(f, before) : -1;
        return open > 1 && ROUTE.has(toks[open - 1]?.v ?? '');
      };
      const flag = (q: number, why: string) => { const [line, col] = this.line(f, q); out.push({ file: f.rel, line, col, fn: this.nearestName(this.enclosing(f, q) ?? ({ name: null, parent: null } as Fn)), text: f.src.slice(toks[Math.max(0, q - 2)]!.s, toks[q]!.e), key: '', verdict: 'dynamic', reason: why }); };
      for (const q of f.occ.get('query') ?? []) {
        const pv = toks[q - 1]?.v;
        if ((pv === '.' || pv === '?.') && toks[q - 2]?.t === 'id' && toks[q - 3]?.v !== 'typeof' && (clients.has(bindingKey(q - 2)) || (!dataLike.has(bindingKey(q - 2)) && !requestLike(q - 2)))) {
          let j = q + 1;
          if (toks[j]?.v === '<') { const c = this.genericClose(f, j, toks.length); if (c > 0) j = c + 1; }
          const nv = toks[j]?.v;
          if (nv === '(' || ((nv === '?.' || nv === '!') && toks[j + 1]?.v === '(')) continue; // a site
          if (nv === '.' && ['call', 'apply', 'bind'].includes(toks[j + 1]?.v ?? '')) continue; // reported above
          if ((nv === ')' || nv === 'as') && toks[(nv === ')' ? j : this.typeEnd(f, j + 1, toks.length)) + 1]?.v === '(') continue; // (c.query)(…): a site
          if (['.', '?.', '['].includes(nv ?? '')) continue; // x.query.k: a property of a data object
          if (['===', '!==', '==', '!='].includes(nv ?? '') || ['===', '!==', '==', '!='].includes(toks[q - 3]?.v ?? '')) continue; // compared, not called
          const op = this.openParen(f, q - 2);
          if (['(', ','].includes(toks[q - 3]?.v ?? '') && op >= 0 && this.isCallParen(f, op) && this.argReadOnly(f, op, q - 2, 0) && !['apply', 'call', 'bind'].includes(toks[op - 1]?.v ?? '')) continue; // read by a read-only callee
          flag(q, 'a query method used as a value (callers of the SQL text unknown)');
        } else if ((pv === '{' || pv === ',') && [',', '}', ':', '='].includes(toks[q + 1]?.v ?? '') && !this.enclosingParamList(f, q) && (this.inPattern(f, q) >= 0 || this.inAssignPattern(f, q))) {
          flag(q, 'a query property destructured (it may be a client method)');
        }
      }
      for (const cc of this.computedCalls()) if (cc.file === f && (!cc.keys || cc.keys.has('query'))) {
        // the receiver of `x[k](…)` / `(x as T)[k](…)`
        const rb = toks[cc.open - 1]?.v === ']' ? cc.open - 1 : cc.open - 2;
        const lb = f.match[rb]!;
        let recv = lb - 1;
        if (toks[recv]?.v === ')') recv = f.match[recv]! + 1;
        if (toks[recv]?.t === 'id' && !dataLike.has(bindingKey(recv))) flag(cc.open, cc.keys ? 'query called through a computed key' : 'a computed call on a client (it may reach query)');
      }
    }
    // c['query'](sql) / c["query"](sql)
    for (const f of this.files.values()) {
      if (only && !only(f.rel)) continue;
      for (let i = 1; i < f.toks.length; i++) {
        const t = f.toks[i]!;
        if (t.t === 'str' && t.v === 'query' && f.toks[i - 1]?.v === '[' && f.toks[i + 1]?.v === ']' && f.toks[i + 2]?.v === '(') {
          const [line, col] = this.line(f, i);
          out.push({ file: f.rel, line, col, fn: this.nearestName(this.enclosing(f, i) ?? ({ name: null, parent: null } as Fn)), text: "['query'](", key: '', verdict: 'dynamic', reason: 'query called by a string key' });
        }
      }
    }
    return out;
  }

  nearestName(fn: Fn): string | null { let x: Fn | null = fn; while (x && !x.name) x = x.parent; return x?.name ?? null; }
}

interface Binding { reason: string | null }
type Ev = (f: FileInfo, s: number, e: number, env: Env, depth: number) => string | null;
interface Caller { file: FileInfo; at: number; args: [number, number][] }
interface Env { binds: Map<string, Binding>; fnScopes: Fn[] }
interface Decl { kind: 'param' | 'decl' | 'import' | 'namespace'; fn?: Fn; param?: Param; inits: [number, number][]; assigns: [number, number][]; scope: Fn | null; bad?: string | null; imp?: { from: string; name: string }; plain?: [number, number][]; members?: { prop: string | null; range: [number, number] }[]; blk?: [number, number] }

export function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) {
      const rel = path.join(d, e.name);
      if (e.isDirectory()) walk(rel);
      else if (/\.(ts|mts|mjs)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(rel);
    }
  };
  walk('server');
  walk('shared');
  return out.sort();
}
