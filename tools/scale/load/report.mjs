#!/usr/bin/env node
// Rebuild run.json's result and SUMMARY.md of a finished load run from its raw NDJSON (after a change of lib.mjs).
//   node tools/scale/load/report.mjs <run directory>
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { aggregate, summarizeMonitor, renderMarkdown } from './lib.mjs';

const dir = process.argv[2], raw = join(dir, 'raw');
const nd = (suffix) => readdirSync(raw).filter((f) => f.endsWith(suffix)).flatMap((f) => readFileSync(join(raw, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
const report = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
const phases = report.phases.map((p) => ({ id: p.id, clients: p.clients, start_ms: p.start_ms, end_ms: p.end_ms }));
const mix = JSON.parse(readFileSync(new URL('../../../docs/parity/acceptance-profile.v1.json', import.meta.url), 'utf8')).config.http.mix;
report.result = aggregate({ samples: nd('.samples.ndjson'), prep: nd('.prep.ndjson'), loops: nd('.loop.ndjson'), mix, phases, monitor: summarizeMonitor(nd('monitor.ndjson'), phases),
  hostPauses: report.host_pauses ?? [], contentionPlan: report.contention_plan ?? null });
writeFileSync(join(dir, 'run.json'), JSON.stringify(report, null, 1) + '\n', { mode: 0o600 });
writeFileSync(join(dir, 'SUMMARY.md'), renderMarkdown(report), { mode: 0o600 });
console.log(join(dir, 'SUMMARY.md'));
