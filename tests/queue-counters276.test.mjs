/** p276 (docs/parity/QUEUE-COUNTERS-P276-20261029.md, "Integracja jako 260"): the remaining costs of p275 §5. The prepared
 * 275 and 276 are the migrations 259_jobs_running_lease and 260_automation_runs_queued_job; the object names have no number.
 *
 * - Queue-limit counters `count(*) FROM jobs WHERE state IN ('pending','running')` read the whole jobs table (done rows
 *   are never pruned): a ScalarArrayOp implies neither partial index. Written as `(state='pending' OR state='running')`
 *   each arm is proved by one partial index, jobs_claim (state='pending') and the prepared 275 jobs_running_lease
 *   (state='running'), and the planner takes a BitmapOr of the two.
 * - The automation_runs reaper of tick() (server/worker.ts) reads every run for the few queued ones: the prepared 276
 *   partial index automation_runs_queued_job (job_id) WHERE state='queued'.
 * - Manual dispatch (server/local-automation-routes.ts) found the order's paid dispatcher job by a scan of the tenant's
 *   jobs; it now starts from the order's events and probes the dispatcher by its dedup key event:<id> (server/events.ts).
 *
 * The static tests always run. The plan test runs only against an own PG04 clone (DATABASE_URL pathname
 * /dynaminds_m260_YYYYMMDD_NN or m261) migrated by the real migrate(), which applies 259 and 260 (the prepared run applied
 * 275 and 276 by hand; that step is dropped): in a rolled-back transaction it plants 100 000
 * done jobs and 50 000 done runs of one tenant (triggers and FKs off, as superuser) next to a few active ones, ANALYZEs,
 * and then requires index scans and the exact counts and rows. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { RELEASE_MIGRATIONS } from '../shared/large-import-dependencies/pim-large-import173-business-traversal-ui/migration-manifest.mjs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const ACTIVE = "(state='pending' OR state='running')";
// Count queries over jobs in double-quoted literals (every queue counter of server/ is one).
const counters = (text) => [...text.matchAll(/"(SELECT count\(\*\)::int(?: AS)? n FROM jobs WHERE [^"]*)"/g)].map((m) => m[1]);
// The rewritten counters: file → number of counters in it.
const SITES = {
  'server/email.ts': 1, 'server/sms.ts': 1, 'server/repricing-schedules.ts': 1, 'server/automation-schedules.ts': 2,
  'server/odoo-catalog-sync.ts': 1, 'server/dpd-pickup-schedules.ts': 1, 'server/automation-local-effects.ts': 1,
  'server/supplier-schedules.ts': 1, 'server/shopify-fulfillment.ts': 1, 'server/automations.ts': 1, 'server/customer-message-workflows.ts': 1,
};
// Counts that keep `state IN ('pending','running')`, and why.
const KEPT = {
  'server/tracking.ts': 'jobs_tracking_channel_active has this predicate', 'server/source-payments.ts': 'jobs_source_payment_channel has this predicate',
  'server/shopify-webhooks.ts': 'shopify_webhook_queue has this predicate', 'server/wms-lots.ts': 'WMS limits lane owns the file',
  'server/b2b-network.ts': 'hash-pinned in server/catalog-stock-writer-coverage.ts; rewrite with a re-pin round',
};

test('queue counters: every rewritten counter states the active jobs as two partial-index arms', () => {
  for (const [file, n] of Object.entries(SITES)) {
    const own = counters(read(file)).filter((sql) => /pending/.test(sql));
    assert.equal(own.length, n, file);
    for (const sql of own) {
      assert(sql.includes(ACTIVE), `${file}: ${sql}`);
      assert.doesNotMatch(sql, /state ?IN ?\(/, file);
    }
  }
});

test('queue counters: no other count over jobs filters active jobs by state IN, except where an index or owner says so', () => {
  const left = [];
  for (const f of readdirSync(new URL('../server/', import.meta.url)).filter((f) => f.endsWith('.ts'))) {
    const text = read('server/' + f);
    for (const m of text.matchAll(/count\(\*\)[^"`]{0,40}FROM jobs\b[^"`]*?state ?IN ?\('pending', ?'running'\)/g))
      if (!KEPT['server/' + f]) left.push(`server/${f}:${text.slice(0, m.index).split('\n').length}`);
  }
  assert.deepEqual(left, []);
});

const file276 = new URL('../server/260_automation_runs_queued_job.sql', import.meta.url);
test('260 follows 259 in the release list and pins the exact SQL bytes', () => {
  const i = RELEASE_MIGRATIONS.findIndex((m) => m.number === 260), row = RELEASE_MIGRATIONS[i];
  const b = readFileSync(file276);
  assert(row, 'manifest row 260');
  assert.equal(row.name, '260_automation_runs_queued_job');
  assert.equal(row.file, '260_automation_runs_queued_job.sql');
  assert.equal(row.native_id, 'automation_runs_queued_job260');
  assert.equal(row.cold.contract, 'automation-runs-queued-job260');
  assert.equal(row.cold.project, 'projectCompiledAutomationRunsQueuedJob260Catalogue');
  assert.equal(row.bytes, b.length);
  assert.equal(row.sha256, createHash('sha256').update(b).digest('hex'));
  assert.equal(row.bytes, 1075);
  assert.equal(row.sha256, 'a5e54f68cb9cd02604f282f282eb85887d92ae732b71366271c595696d752737');
  assert.equal(RELEASE_MIGRATIONS[i - 1].name, '259_jobs_running_lease');
  assert.equal(RELEASE_MIGRATIONS[i + 1]?.name, '261_stocktake_evidence_usage', '261 follows 260');
  assert.equal(RELEASE_MIGRATIONS.some((m) => m.number === 276 || /^276_/.test(m.file)), false, 'the placeholder number is gone');
  assert.doesNotMatch(read('server/db.ts'), /automation_runs_queued_job/, 'db.ts takes 260 from the manifest, not a literal pair');
});
test('260: the file is the registered migration and creates exactly one partial index on automation_runs', () => {
  assert(existsSync(file276), 'server/260_automation_runs_queued_job.sql exists');
  const text = readFileSync(file276, 'utf8');
  assert.match(text.split('\n')[0], /^-- Migration 260_automation_runs_queued_job \(prepared as 276, registered after 259_jobs_running_lease;/);
  assert.equal(text.replace(/--.*$/gm, '').replace(/\s+/g, ' ').trim(), "CREATE INDEX automation_runs_queued_job ON public.automation_runs(job_id) WHERE state='queued';");
});

const reaper = /"(UPDATE automation_runs r SET state='failed',error='Dzierżawa zadania wygasła',finished_at=now\(\) FROM jobs j WHERE j\.id=r\.job_id AND j\.state='failed' AND r\.state='queued')"/.exec(read('server/worker.ts'))?.[1];
const routes = read('server/local-automation-routes.ts');
const dispatch = /c\.query\(`(SELECT j\.\* FROM [\s\S]*?FOR UPDATE OF j)`/.exec(routes.slice(routes.indexOf("'/api/orders/:id/local-automation/:request/dispatch'")))?.[1];

test('reaper and manual dispatch: the queries the plan test reads are the ones in the source', () => {
  assert.ok(reaper, 'server/worker.ts automation_runs reaper');
  assert.ok(dispatch, 'server/local-automation-routes.ts dispatch claim');
  // The dispatcher job of event e is inserted with dedup_key 'event:'||e.id (both inserts of server/events.ts).
  assert.equal([...read('server/events.ts').matchAll(/\n\s*'automation',\n\s*JSON\.stringify\(\{ eventId: id,[^\n]*\n\s*`event:\$\{id\}`,/g)].length, 2);
  assert.match(dispatch, /^SELECT j\.\* FROM order_events e CROSS JOIN LATERAL\(SELECT 'event:'\|\|e\.id::text dedup_key OFFSET 0\)x JOIN jobs j ON \(j\.tenant_id,j\.dedup_key\)=\(e\.tenant_id,x\.dedup_key\)/);
  for (const p of ['j.tenant_id=$1', "j.kind='automation'", "j.payload->>'orderId'=$2", "(j.payload->>'eventId')::uuid=e.id", 'e.tenant_id=$1', 'e.order_id=$2::uuid', "e.kind='order.paid'", "j.payload->'rules' @> $3::jsonb"])
    assert(dispatch.includes(p), p);
});

const url = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
const own = url && /^\/dynaminds_m26[0123]_\d{8}_\d{2}$/.test(url.pathname);
test('PG04 clone with 259 and 260: counters, reaper and manual dispatch use indexes and keep their results', { skip: own ? false : 'needs DATABASE_URL of an own dynaminds_m260_ (or m261) clone migrated to HEAD' }, async () => {
  const pg = createRequire(import.meta.url)('pg');
  const c = new pg.Client({ connectionString: url.href, options: '-c jit=off -c timezone=UTC' });
  await c.connect();
  const tenant = '27600000-0000-4000-8000-000000000001', rule = '27600000-0000-4000-8000-000000000002', order = '27600000-0000-4000-8000-000000000003';
  const id = (p, i) => `md5('${p}276:'||${i})::uuid`;
  const scans = async (rel, sql, params) => {
    const plan = (await c.query('EXPLAIN (FORMAT JSON) ' + sql, params)).rows[0]['QUERY PLAN'][0].Plan, out = [];
    // A Bitmap Index Scan names no relation: it belongs to the Bitmap Heap Scan above it.
    (function walk(n, on) {
      const here = n['Relation Name'] ?? (n['Node Type'] === 'Bitmap Heap Scan' || /^Bitmap(And|Or)$|^Bitmap Index Scan$/.test(n['Node Type']) ? on : undefined);
      if (here === rel && /Scan/.test(n['Node Type'])) out.push(`${n['Node Type']}:${n['Index Name'] ?? ''}`);
      for (const k of n.Plans ?? []) walk(k, here);
    })(plan);
    return out;
  };
  await c.query('BEGIN');
  try {
    assert.deepEqual((await c.query("SELECT to_regclass('public.jobs_running_lease')::text a,to_regclass('public.automation_runs_queued_job')::text b")).rows[0],
      { a: 'jobs_running_lease', b: 'automation_runs_queued_job' }, '259 and 260 applied by migrate()');
    await c.query('SET LOCAL session_replication_role=replica');
    // History: 50 000 done dispatcher jobs (one per order.paid event of other orders) and 50 000 done automation.run jobs with their runs.
    await c.query(`INSERT INTO order_events(id,tenant_id,order_id,kind,detail,created_at) SELECT ${id('e', 'i')},$1,${id('o', 'i')},'order.paid','{}',now()
      FROM generate_series(1,50000) i`, [tenant]);
    await c.query(`INSERT INTO jobs(id,tenant_id,kind,payload,state,attempts,max_attempts,run_at,created_at,dedup_key)
      SELECT ${id('jd', 'i')},$1,'automation',jsonb_build_object('rules',jsonb_build_array(jsonb_build_object('id',$2::text)),'eventId',${id('e', 'i')}::text,
       'orderId',${id('o', 'i')}::text,'trigger','order.paid'),'done',1,1,now(),now(),'event:'||${id('e', 'i')}::text FROM generate_series(1,50000) i`, [tenant, rule]);
    await c.query(`INSERT INTO jobs(id,tenant_id,kind,payload,state,attempts,max_attempts,run_at,created_at,dedup_key)
      SELECT ${id('jr', 'i')},$1,'automation.run',jsonb_build_object('run_id',${id('r', 'i')}::text),'done',1,1,now(),now(),'p276r:'||i FROM generate_series(1,50000) i`, [tenant]);
    await c.query(`INSERT INTO automation_runs(id,tenant_id,rule_id,rule_version,event_id,order_id,job_id,definition,snapshot,context,state,created_at)
      SELECT ${id('r', 'i')},$1,$2,2,${id('e', 'i')},${id('o', 'i')},${id('jr', 'i')},'{}','{}','{}','done',now() FROM generate_series(1,50000) i`, [tenant, rule]);
    // In flight: runs 1..4 queued; the jobs of runs 1 and 2 failed (the reaper's work), 3 pending, 4 running; 5 more pending
    // and 2 more running jobs of other kinds; the order's own paid event 0 with its pending dispatcher job.
    await c.query(`UPDATE automation_runs SET state='queued' WHERE id IN (${[1, 2, 3, 4].map((i) => id('r', i)).join(',')})`);
    await c.query(`UPDATE jobs SET state=CASE WHEN id IN (${id('jr', 1)},${id('jr', 2)}) THEN 'failed' WHEN id=${id('jr', 3)} THEN 'pending' ELSE 'running' END,
      attempts=CASE WHEN id=${id('jr', 3)} THEN 0 ELSE 1 END,lease_token=CASE WHEN id=${id('jr', 4)} THEN gen_random_uuid() END,locked_at=CASE WHEN id=${id('jr', 4)} THEN now() END
      WHERE id IN (${[1, 2, 3, 4].map((i) => id('jr', i)).join(',')})`);
    await c.query(`INSERT INTO jobs(id,tenant_id,kind,payload,state,attempts,max_attempts,run_at,created_at,dedup_key,lease_token,locked_at)
      SELECT ${id('ja', 'i')},$1,'shopify.fulfillment','{}',CASE WHEN i<=5 THEN 'pending' ELSE 'running' END,CASE WHEN i<=5 THEN 0 ELSE 1 END,3,now(),now(),'p276a:'||i,
       CASE WHEN i>5 THEN gen_random_uuid() END,CASE WHEN i>5 THEN now() END FROM generate_series(1,7) i`, [tenant]);
    await c.query(`INSERT INTO order_events(id,tenant_id,order_id,kind,detail,created_at) VALUES(${id('e', 0)},$1,$2,'order.paid','{}',now())`, [tenant, order]);
    await c.query(`INSERT INTO jobs(id,tenant_id,kind,payload,state,attempts,max_attempts,run_at,created_at,dedup_key)
      VALUES(${id('jd', 0)},$1,'automation',jsonb_build_object('rules',jsonb_build_array(jsonb_build_object('id',$2::text)),'eventId',${id('e', 0)}::text,
       'orderId',$3::text,'trigger','order.paid'),'pending',0,1,now(),now(),'event:'||${id('e', 0)}::text)`, [tenant, rule, order]);
    await c.query('SET LOCAL session_replication_role=origin');
    for (const t of ['jobs', 'automation_runs', 'order_events']) await c.query(`ANALYZE ${t}`);
    const want = (await c.query(`SELECT ${id('jd', 0)}::text dispatcher, (SELECT count(*)::int FROM automation_runs r JOIN jobs j ON j.id=r.job_id
      WHERE j.state='failed' AND r.state='queued') reaped`)).rows[0];
    assert(want.reaped >= 2, 'the two planted queued runs of failed jobs');
    // The reaper runs on the worker pool (postgres, no RLS).
    const r = await scans('automation_runs', reaper, []);
    assert.ok(r.some((s) => s.endsWith(':automation_runs_queued_job')) && !r.some((s) => /^Seq Scan/.test(s)), 'reaper: ' + r.join(', '));
    await c.query('SAVEPOINT reap');
    await c.query('SET LOCAL session_replication_role=replica'); // planted rows have no orders: FK checks of own new rows would fire
    assert.equal((await c.query(reaper)).rowCount, want.reaped, 'reaper fails exactly the queued runs of failed jobs');
    await c.query('ROLLBACK TO SAVEPOINT reap');
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
    const failures = [];
    // Active jobs of the tenant: 2 pending + 1 running (planted automation runs/dispatcher), 5 pending + 2 running others.
    const expected = { bare: 10, shopify: 7, message: 0 };
    for (const [file, n] of Object.entries(SITES)) {
      for (const sql of counters(read(file)).filter((s) => /pending/.test(s)).slice(0, n)) {
        const params = sql.includes('$1') ? ['27600000-0000-4000-8000-0000000000ff'] : [];
        const s = await scans('jobs', sql, params);
        if (!s.length || s.some((x) => /^Seq Scan/.test(x)) || !s.includes('Bitmap Index Scan:jobs_claim') || !s.includes('Bitmap Index Scan:jobs_running_lease'))
          failures.push(`${file}: ${s.join(', ')}`);
        const kind = /kind='shopify\.fulfillment'/.test(sql) ? 'shopify' : /customer_message/.test(sql) ? 'message' : 'bare';
        const got = (await c.query(sql, params)).rows[0].n, before = (await c.query(sql.replace(ACTIVE, "state IN ('pending','running')"), params)).rows[0].n;
        if (got !== expected[kind] || got !== before) failures.push(`${file}: count ${got}, as before ${before}, want ${expected[kind]}`);
      }
    }
    assert.deepEqual(failures, []);
    const params = [tenant, order, JSON.stringify([{ id: rule }])];
    const d = await scans('jobs', dispatch, params);
    assert.ok(d.length && d.every((s) => /^Index Scan:jobs_tenant_id_dedup_key_key$/.test(s)), 'dispatch jobs: ' + d.join(', '));
    const e = await scans('order_events', dispatch, params);
    assert.ok(e.length && e.every((s) => /^(Index|Bitmap Index|Bitmap Heap) Scan/.test(s)), 'dispatch events: ' + e.join(', '));
    assert.deepEqual((await c.query(dispatch, params)).rows.map((x) => x.id), [want.dispatcher]);
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    // ANALYZE writes pg_class.reltuples/relpages in place (not rolled back): re-estimate the clone's real contents.
    for (const t of ['jobs', 'automation_runs', 'order_events']) await c.query(`ANALYZE ${t}`).catch(() => {});
    await c.end();
  }
});
