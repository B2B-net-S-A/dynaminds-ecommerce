#!/usr/bin/env node
// Measured data-loss window (RPO) of the WAL archive: continuous acknowledged commits, kill -9 of the server
// just before the next archive_timeout switch (worst case), restore of base backup + archive only (the data
// volume counts as lost) to a new container, and comparison of the newest restored row with the newest
// acknowledged commit. Then the killed server is started on its own volume (crash recovery) as the
// "disk intact" case. See tools/recovery/README.md.
//
//   node tools/recovery/rpo-drill.mjs --src dyna-recovery-rposrc --dir <dir> [--target dyna-recovery-rpo]
//     [--rate-ms 100] [--margin-ms 2500]
// --src must be a disposable drill container (never dyna-scale-pg18): it is killed with SIGKILL.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { docker, psql, run, now } from './docker.mjs';
import { baseBackup, restore } from './pitr.mjs';
import { STAGE5_CONTAINER, rpoWindow } from './pitr-lib.mjs';

const { values: a } = parseArgs({ options: { src: { type: 'string' }, dir: { type: 'string' }, target: { type: 'string', default: 'dyna-recovery-rpo' },
  'rate-ms': { type: 'string', default: '100' }, 'margin-ms': { type: 'string', default: '2500' } } });
if (!a.src || !a.dir) throw new Error('--src and --dir required');
if (a.src === STAGE5_CONTAINER) throw new Error('refused: the RPO drill kills its source; use a drill container restored from a base backup');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.error(`[${new Date().toISOString()}] ${m}`);
mkdirSync(a.dir, { recursive: true, mode: 0o700 });
const report = { schema: 'dyna-recovery-rpo-drill/v1', src: a.src, target: a.target };

const archiveTimeoutS = Number(psql(a.src, 'postgres', "SELECT setting FROM pg_settings WHERE name='archive_timeout'"));
report.archive_timeout_s = archiveTimeoutS;
if (psql(a.src, 'postgres', "SELECT count(*) FROM pg_database WHERE datname='recovery_rpo'") === '0') psql(a.src, 'postgres', 'CREATE DATABASE recovery_rpo');
psql(a.src, 'recovery_rpo', 'DROP TABLE IF EXISTS rpo_probe');
psql(a.src, 'recovery_rpo', 'CREATE TABLE rpo_probe(seq bigint PRIMARY KEY, at timestamptz NOT NULL DEFAULT clock_timestamp())');
log('base backup of the drill source');
report.base_backup = baseBackup({ source: a.src, sets: join(a.dir, 'sets'), config: [] });

// Writer: one session, autocommit, synchronous_commit=on — a returned row is a durable local commit.
const w = spawn('docker', ['exec', '-i', a.src, 'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'recovery_rpo'], { stdio: ['pipe', 'pipe', 'pipe'] });
const acked = [];
let buf = '';
w.stdout.on('data', (b) => {
  buf += b; const lines = buf.split('\n'); buf = lines.pop();
  for (const l of lines) { const [seq, ms] = l.split('|'); if (/^\d+$/.test(seq)) acked.push({ seq: Number(seq), at_ms: Number(ms), host_ms: now() }); }
});
w.stderr.on('data', () => {});
w.stdin.on('error', () => {});
let seq = 0, writing = true;
(async () => { while (writing) { seq++; w.stdin.write(`INSERT INTO rpo_probe(seq) VALUES (${seq}) RETURNING seq, (extract(epoch FROM at)*1000)::bigint;\n`); await sleep(Number(a['rate-ms'])); } })();

// Wait for an archive_timeout switch that happens while writing, then kill just before the next one.
const archived = () => psql(a.src, 'postgres', "SELECT coalesce(last_archived_wal,'')||'|'||coalesce((extract(epoch FROM last_archived_time)*1000)::bigint::text,'0') FROM pg_stat_archiver").split('|');
const [firstWal] = archived();
let last;
for (;;) { last = archived(); if (last[0] !== firstWal && acked.length > 0) break; await sleep(200); }
report.last_switch = { wal: last[0], archived_at: new Date(Number(last[1])).toISOString() };
const killAt = Number(last[1]) + archiveTimeoutS * 1000 - Number(a['margin-ms']);
log(`archived ${last[0]} at ${report.last_switch.archived_at}; kill -9 at ${new Date(killAt).toISOString()}`);
while (now() < killAt) await sleep(50);
const beforeKill = archived();
report.crash_ms = now();
docker('kill', '--signal', 'KILL', a.src);
writing = false;
await sleep(500);
w.kill('SIGKILL');
report.crash_at = new Date(report.crash_ms).toISOString();
report.archived_before_kill = beforeKill[0];
report.acked = { count: acked.length, last: acked[acked.length - 1] };
log(`killed; ${acked.length} acknowledged commits, last seq ${report.acked.last.seq}`);

// Disaster case: the data volume is lost; base backup + WAL archive only.
log('restore base backup + archive to a new container');
report.restore = await restore({ set: report.base_backup.set, target: a.target, target_mode: 'latest' });
const [rseq, rms, rcount] = psql(a.target, 'recovery_rpo', 'SELECT max(seq), (extract(epoch FROM max(at))*1000)::bigint, count(*) FROM rpo_probe').split('|').map(Number);
report.archive_only = rpoWindow({ acked, restored_last: { seq: rseq, at_ms: rms }, crash_ms: report.crash_ms, restored_count: rcount });
report.archive_only.restored_last = { seq: rseq, at: new Date(rms).toISOString() };
report.archive_only.last_acked_at = new Date(report.acked.last.at_ms).toISOString();

// Server crash with the disk intact: crash recovery of the killed container from its own pg_wal.
log('start the killed server on its own volume');
docker('start', a.src);
for (let i = 0; ; i++) {
  if (run('docker', ['exec', a.src, 'pg_isready', '-h', '127.0.0.1', '-q'], { allowFail: true }).status === 0) break;
  if (i > 600) throw new Error('killed server did not restart'); await sleep(200);
}
const [cseq, cms, ccount] = psql(a.src, 'recovery_rpo', 'SELECT max(seq), (extract(epoch FROM max(at))*1000)::bigint, count(*) FROM rpo_probe').split('|').map(Number);
report.disk_intact = rpoWindow({ acked, restored_last: { seq: cseq, at_ms: cms }, crash_ms: report.crash_ms, restored_count: ccount });
writeFileSync(join(a.dir, 'rpo-report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ archive_timeout_s: archiveTimeoutS, archive_only: report.archive_only, disk_intact: report.disk_intact,
  crash_at: report.crash_at, last_switch: report.last_switch }, null, 2));
