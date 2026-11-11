#!/usr/bin/env node
// Splits one cold start trace of tools/scale/load/coldstart-probe.mjs into phases.
//
//   node tools/scale/load/coldstart-report.mjs <trace.ndjson> [--top 25] [--json <out.json>]
//
// Wall time = union of query intervals (database time, on any client) + gaps (JS work, file hashing, imports).
// Queries are grouped by a normalized text key (literals and numbers replaced); each group shows its count,
// summed duration and its wall share (the part of the run not overlapped by an earlier-reported group).
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values: o, positionals: [file] } = parseArgs({ allowPositionals: true, options: { top: { type: 'string', default: '25' }, json: { type: 'string' } } });
if (!file) throw new Error('trace.ndjson required');
const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const mark = (k) => rows.find((r) => r.kind === k)?.s;
const qs = rows.filter((r) => r.kind === 'q');
export const keyOf = (t) => t.replace(/'(?:[^']|'')*'/g, "'?'").replace(/\$\d+/g, '$n').replace(/\b\d+\b/g, 'N').slice(0, 120);

// Union of intervals.
const union = (iv) => { const s = [...iv].sort((x, y) => x[0] - y[0]); let tot = 0, cur = null; for (const [b, e] of s) { if (!cur || b > cur[1]) { if (cur) tot += cur[1] - cur[0]; cur = [b, e]; } else cur[1] = Math.max(cur[1], e); } if (cur) tot += cur[1] - cur[0]; return tot; };
const end = mark('factory') ?? Math.max(...qs.map((q) => q.e));
const dbWall = union(qs.map((q) => [q.s, q.e]));
const groups = new Map();
for (const q of qs) { const k = keyOf(q.t); const g = groups.get(k) ?? { key: k, n: 0, sum_ms: 0, max_ms: 0, first_s: q.s, intervals: [] }; g.n++; g.sum_ms += q.e - q.s; g.max_ms = Math.max(g.max_ms, q.e - q.s); g.intervals.push([q.s, q.e]); groups.set(k, g); }
const top = [...groups.values()].sort((x, y) => y.sum_ms - x.sum_ms).slice(0, Number(o.top))
  .map((g) => ({ key: g.key, n: g.n, sum_ms: Math.round(g.sum_ms), wall_ms: Math.round(union(g.intervals)), max_ms: Math.round(g.max_ms), first_s: Math.round(g.first_s) }));
// Timeline: contiguous windows of the trace split at the factory's coarse marks (migration ledger, cold startup, app).
const timings = rows.find((r) => r.kind === 'factory')?.timings ?? {};
const result = {
  file, imported_ms: mark('imported'), factory_ms: mark('factory'), listening_ms: mark('listening'), factory_timings: timings,
  queries: qs.length, clients: new Set(qs.map((q) => q.c)).size, db_wall_ms: Math.round(dbWall), js_gap_ms: Math.round(end - dbWall),
  top,
};
console.log(`factory ${Math.round(result.factory_ms)} ms (import ${Math.round(result.imported_ms)}), migrate ${Math.round(timings.migrate_ms ?? 0)}, cold ${Math.round(timings.cold_validation_ms ?? 0)}; ` +
  `queries ${result.queries} on ${result.clients} clients; DB wall ${result.db_wall_ms} ms, outside DB ${result.js_gap_ms} ms`);
// Timeline: every stretch > 1 s without a running query (JS work on the critical path) and every query > 1 s.
const timeline = []; let last = 0, lastT = '(start)';
for (const q of [...qs].sort((x, y) => x.s - y.s)) {
  if (q.s - last > 1000) timeline.push({ kind: 'outside_db', from_s: last / 1000, ms: Math.round(q.s - last), after: lastT.slice(0, 90), before: q.t.slice(0, 90) });
  if (q.e - q.s > 1000) timeline.push({ kind: 'query', from_s: q.s / 1000, ms: Math.round(q.e - q.s), text: q.t.slice(0, 90) });
  if (q.e > last) { last = q.e; lastT = q.t; }
}
if (end - last > 1000) timeline.push({ kind: 'outside_db', from_s: last / 1000, ms: Math.round(end - last), after: lastT.slice(0, 90), before: '(factory returned)' });
result.timeline = timeline;
// Phases of createOrdinaryLocalApplication, cut at the first query of each next step (server/ordinary-local-runtime.ts).
const cuts = [
  ['migrate_resources_startup_handle', /^SET SESSION statement_timeout/],
  ['legacy_acl_normalization (catalogue read + cold chain + compiled compare)', /^SHOW transaction_read_only/],
  ['activation: packing cold compartment (catalogue read + cold chain + compiled compare)', /^SELECT EXISTS\(SELECT FROM public\.migrations WHERE name='189_packing/],
  ['activation: native predicates, approval, closing cuts, COMMIT', /^SELECT public\.ordinary182_owner_gate\(\)/],
];
const sortedQs = [...qs].sort((x, y) => x.s - y.s); let from = 0, idx = 0; result.phases = [];
for (const [name, re] of cuts) {
  while (idx < sortedQs.length && !(sortedQs[idx].s >= from && re.test(sortedQs[idx].t))) idx++;
  if (idx >= sortedQs.length) break;
  const at = sortedQs[idx].s, inside = sortedQs.filter((q) => q.s >= from && q.s < at);
  result.phases.push({ name, from_s: from / 1000, ms: Math.round(at - from), db_wall_ms: Math.round(union(inside.map((q) => [q.s, Math.min(q.e, at)]))) });
  from = at;
}
{ const inside = sortedQs.filter((q) => q.s >= from); result.phases.push({ name: 'composite inspection + buildApp capability guards', from_s: from / 1000, ms: Math.round(end - from), db_wall_ms: Math.round(union(inside.map((q) => [q.s, q.e]))) }); }
for (const p of result.phases) console.log(`phase ${String(p.ms).padStart(7)} ms (DB ${String(p.db_wall_ms).padStart(6)})  ${p.name}`);
if (o.json) writeFileSync(o.json, JSON.stringify(result, null, 1) + '\n');
for (const x of timeline) console.log(x.kind === 'query' ? `  query ${String(x.ms).padStart(7)} @${x.from_s.toFixed(1)}  ${x.text}` : `  JS    ${String(x.ms).padStart(7)} @${x.from_s.toFixed(1)}  after ${x.after} | before ${x.before}`);
for (const g of top) console.log(`${String(g.sum_ms).padStart(8)} ${String(g.wall_ms).padStart(8)} ${String(g.n).padStart(5)} ${String(g.max_ms).padStart(7)} @${String(g.first_s).padStart(7)}  ${g.key}`);
