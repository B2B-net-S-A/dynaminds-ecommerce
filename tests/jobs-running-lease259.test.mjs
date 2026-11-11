/** Migration 259_jobs_running_lease (prepared as 275, registered after 258_wz_issuer_refresh;
 * docs/parity/SCOPED-CLAIM-P275-20261029.md "Integracja jako 259"); the object name has no number. One partial index on jobs for the
 * two queries that look for leases still held (state='running'): the reaper at the start of every tick() of the
 * generic worker (server/worker.ts) and expireAutomationLeases() of the scoped rule processor (server/automations.ts).
 * Without it both read the whole jobs table, whose done rows are never pruned (1 018 531 rows: 230 ms and 146 ms).
 *
 * The plan test runs only against an own PG04 clone (DATABASE_URL pathname /dynaminds_m259_YYYYMMDD_NN or a later
 * m26N family) migrated to HEAD by the real migrate(), which applies 259 (the prepared run applied 275 by hand; that step
 * is dropped): in a rolled-back transaction it plants 100 000 done jobs, ANALYZEs, and both queries must scan
 * jobs_running_lease. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { RELEASE_MIGRATIONS } from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/migration-manifest.mjs';

const file = new URL('../server/259_jobs_running_lease.sql', import.meta.url);
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const code = () => readFileSync(file, 'utf8').replace(/--.*$/gm, '').replace(/\s+/g, ' ').trim();
const reaper = /"(UPDATE jobs SET state=CASE WHEN attempts>=max_attempts THEN 'failed' ELSE 'pending' END,lease_token=NULL,locked_at=NULL,run_at=now\(\) WHERE state='running' AND kind NOT IN \('catalog\.deepl','catalog\.deepl\.batch'\) AND locked_at<now\(\)-interval '2 minutes')"/.exec(read('server/worker.ts'))?.[1];
const expiry = /`(WITH stale AS \(SELECT tenant_id,id FROM jobs WHERE kind IN \('automation','automation\.run'\) AND state='running'[\s\S]*?)`/.exec(read('server/automations.ts'))?.[1];

test('259 follows 258 in the release list and pins the exact SQL bytes', () => {
  const i = RELEASE_MIGRATIONS.findIndex((m) => m.number === 259), row = RELEASE_MIGRATIONS[i];
  const b = readFileSync(file);
  assert(row, 'manifest row 259');
  assert.equal(row.name, '259_jobs_running_lease');
  assert.equal(row.file, '259_jobs_running_lease.sql');
  assert.equal(row.native_id, 'jobs_running_lease259');
  assert.equal(row.cold.contract, 'jobs-running-lease259');
  assert.equal(row.cold.project, 'projectCompiledJobsRunningLease259Catalogue');
  assert.equal(row.bytes, b.length);
  assert.equal(row.sha256, createHash('sha256').update(b).digest('hex'));
  assert.equal(row.bytes, 1376);
  assert.equal(row.sha256, '8f8916b2798b98c5a0eef182ad590b47e24cbd69284e8b485cd7d944f63b4524');
  assert.equal(RELEASE_MIGRATIONS[i - 1].name, '258_wz_issuer_refresh');
  assert.equal(RELEASE_MIGRATIONS[i + 1]?.name, '260_automation_runs_queued_job', '260 follows 259');
  assert.equal(RELEASE_MIGRATIONS.some((m) => m.number === 275 || /^275_/.test(m.file)), false, 'the placeholder number is gone');
  assert.doesNotMatch(read('server/db.ts'), /jobs_running_lease/, 'db.ts takes 259 from the manifest, not a literal pair');
});

test('259: the file is the registered migration and creates exactly one partial index on jobs', () => {
  assert(existsSync(file), 'server/259_jobs_running_lease.sql exists');
  assert.match(readFileSync(file, 'utf8').split('\n')[0], /^-- Migration 259_jobs_running_lease \(prepared as 275, registered after 258_wz_issuer_refresh;/);
  assert.equal(code(), "CREATE INDEX jobs_running_lease ON public.jobs(id) WHERE state='running';");
});

test('the two lease queries the index serves are the ones in the source', () => {
  assert.ok(reaper, 'server/worker.ts tick() reaper');
  assert.ok(expiry, 'server/automations.ts expireAutomationLeases()');
  assert.match(expiry, /ORDER BY locked_at,id LIMIT 32 FOR UPDATE SKIP LOCKED/);
});

const url = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
const own = url && /^\/dynaminds_m2(?:59|6[0123])_\d{8}_\d{2}$/.test(url.pathname);
test('PG04 clone with 259: reaper and lease expiry scan jobs_running_lease, not the done rows', { skip: own ? false : 'needs DATABASE_URL of an own dynaminds_m259_ (or m260/m261) clone migrated to HEAD' }, async () => {
  const pg = createRequire(import.meta.url)('pg');
  const c = new pg.Client({ connectionString: url.href, options: '-c jit=off -c timezone=UTC' });
  await c.connect();
  await c.query('BEGIN');
  try {
    const tenant = '27500000-0000-4000-8000-000000000011';
    await c.query('SET LOCAL session_replication_role=replica');
    await c.query(`INSERT INTO jobs(id,tenant_id,kind,payload,state,attempts,max_attempts,run_at,created_at,dedup_key)
      SELECT md5('jl275:'||i)::uuid,$1,CASE WHEN i%2=0 THEN 'automation' ELSE 'automation.run' END,'{}','done',1,1,now(),now(),'p275l:'||i
      FROM generate_series(1,100000) i`, [tenant]);
    await c.query('SET LOCAL session_replication_role=origin');
    await c.query('ANALYZE jobs');
    const scans = async (sql, params) => {
      const plan = (await c.query('EXPLAIN (FORMAT JSON) ' + sql, params)).rows[0]['QUERY PLAN'][0].Plan, out = [];
      // A Bitmap Heap Scan names no index itself: it reads only the heap pages its Bitmap Index Scan children return, so
      // it counts as a scan of the index those children name (the planner picks it over an Index Scan on some stats).
      const bitmap = (n) => n['Node Type'] === 'Bitmap Index Scan' ? [n['Index Name']] : (n.Plans ?? []).flatMap(bitmap);
      (function walk(n) { if (n['Relation Name'] === 'jobs' && /Scan/.test(n['Node Type'])) out.push(`${n['Node Type']}:${n['Node Type'] === 'Bitmap Heap Scan' ? [...new Set(n.Plans.flatMap(bitmap))].join('+') : n['Index Name'] ?? ''}`); for (const k of n.Plans ?? []) walk(k); })(plan);
      return out;
    };
    const r = await scans(reaper, []);
    assert.ok(r.length && r.every((s) => s.endsWith(':jobs_running_lease')), 'reaper: ' + r.join(', '));
    const e = await scans(expiry, [null, '5 minutes', 'x']);
    assert.ok(e.some((s) => s.endsWith(':jobs_running_lease')) && !e.some((s) => /^Seq Scan/.test(s)), 'expiry: ' + e.join(', '));
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    await c.query('ANALYZE jobs').catch(() => {}); // pg_class estimates are written in place by ANALYZE
    await c.end();
  }
});
