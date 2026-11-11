/** p275: the claim queries of the scoped rule processor (server/local-automation-worker-control.ts, claimAutomaticJob)
 * stay bounded by the pending jobs when jobs, automation_runs and order_events grow
 * (docs/parity/SCOPED-CLAIM-P275-20261029.md).
 *
 * Root cause (load test 29.10, steady24): the claims run as dyna_app under RLS. A join clause that casts a value out of
 * j.payload (`e.id=(j.payload->>'eventId')::uuid`) calls non-leakproof functions (->>, uuid_in), so the planner may not
 * use it as an index condition below the RLS quals of order_events/automation_runs. The dispatcher claim became a
 * merge join over every order event of the tenant since the activation; the automation.run claim joined runs by
 * job_id (no index) and read every run of the rule. Projecting the payload ids in a LATERAL(… OFFSET 0) subquery turns
 * the join clauses into plain Var = Var (uuid_eq is leakproof): one index probe per pending job.
 *
 * The static tests always run. The plan test runs only against an own PG04 clone (DATABASE_URL pathname
 * /dynaminds_p275_YYYYMMDD_NN). In one transaction that is rolled back it plants the shape of a load run for a
 * synthetic tenant (200 000 order events, 50 000 done order.created chains of the rule: the 29.10 load run had 51 000 runs, one pending dispatcher job, one
 * queued run with its pending job; triggers and FKs off, as superuser), ANALYZEs, and then, as dyna_app with the
 * tenant set: every claim must probe order_events/automation_runs by id, and the claims must return exactly the
 * planted pending jobs. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const source = readFileSync(new URL('../server/local-automation-worker-control.ts', import.meta.url), 'utf8');
const body = source.slice(source.indexOf('export async function claimAutomaticJob'), source.indexOf('const request=z.strictObject'));
const claims = [...body.matchAll(/c\.query\(`(SELECT j\.\* FROM jobs j[\s\S]*?)`/g)].map((m) => m[1]);
const kindOf = (sql) => /j\.kind='([a-z._]+)'/.exec(sql)?.[1];
const LATERAL = /CROSS JOIN LATERAL\(SELECT ((?:\(j\.payload->>'[A-Za-z_]+'\)::uuid [a-z_]+|j\.payload->>'[A-Za-z_]+' [a-z_]+)(?:,(?:\(j\.payload->>'[A-Za-z_]+'\)::uuid [a-z_]+|j\.payload->>'[A-Za-z_]+' [a-z_]+))*) OFFSET 0\)x /;

test('claimAutomaticJob has its four claim statements, one per job kind', () => {
  assert.deepEqual(claims.map(kindOf), ['automation.run', 'automation.local_stock', 'email.send', 'automation']);
  for (const sql of claims) assert.match(sql, /ORDER BY j\.run_at,j\.created_at,j\.id FOR UPDATE OF j SKIP LOCKED LIMIT 1$/);
});

test('no claim joins on a value cast out of j.payload; payload ids come only from the LATERAL projection', () => {
  for (const sql of claims) {
    const rest = sql.replace(LATERAL, '');
    assert.doesNotMatch(rest, /payload->>/, `${kindOf(sql)}: payload value outside the LATERAL projection`);
  }
  const [run, stock, , dispatcher] = claims;
  // automation.run: the run of the payload, which must also name this job (dispatchAutomation writes both).
  assert.match(run, LATERAL);
  assert.match(run, /JOIN automation_runs r ON\(r\.tenant_id,r\.id,r\.job_id\)=\(j\.tenant_id,x\.run_id,j\.id\)/);
  assert.match(stock, /JOIN automation_runs r ON\(r\.tenant_id,r\.id\)=\(j\.tenant_id,x\.run_id\)/);
  assert.match(dispatcher, /JOIN order_events e ON\(e\.tenant_id,e\.id\)=\(j\.tenant_id,x\.event_id\)/);
  assert.match(dispatcher, /AND e\.order_id=x\.order_id AND e\.kind=x\.kind/);
});

test('the claim predicates on the job itself are unchanged (pending, unattempted, unleased, due, after the watermark)', () => {
  for (const sql of claims) {
    for (const p of ["j.state='pending'", 'j.attempts=0', 'j.lease_token IS NULL', 'j.locked_at IS NULL', 'j.run_at<=now()', 'j.tenant_id=$1'])
      assert.ok(sql.includes(p), `${kindOf(sql)}: ${p}`);
    assert.match(sql, /e\.created_at>\$[34]::timestamptz AND j\.created_at>\$[34]::timestamptz/);
  }
});

const url = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
const own = url && /^\/dynaminds_(?:p275|m2(?:59|6[0123]))_\d{8}_\d{2}$/.test(url.pathname);
test('PG04 clone: every claim probes order_events and automation_runs by id (dyna_app, RLS)', { skip: own ? false : 'needs DATABASE_URL of an own dynaminds_p275_ (or m259/m260/m261 integration) clone' }, async () => {
  const pg = createRequire(import.meta.url)('pg');
  const c = new pg.Client({ connectionString: url.href, options: '-c jit=off -c timezone=UTC' });
  await c.connect();
  const tenant = '27500000-0000-4000-8000-000000000001', rule = '27500000-0000-4000-8000-000000000002';
  const id = (p, i) => `md5('${p}275:'||${i})::uuid`;
  await c.query('BEGIN');
  try {
    const since = (await c.query("SELECT (now()-interval '1 hour')::text t")).rows[0].t; // the activation watermark
    await c.query('SET LOCAL session_replication_role=replica');
    // Every 4th event is the order.created of order i/4; the others are later events of the same orders.
    await c.query(`INSERT INTO order_events(id,tenant_id,order_id,kind,detail,created_at) SELECT ${id('e', 'i')},$1,${id('o', 'i/4')},
      CASE WHEN i%4=0 THEN 'order.created' ELSE 'order.updated' END,'{}',$2::timestamptz+i*interval '1 ms' FROM generate_series(1,200000) i`, [tenant, since]);
    await c.query(`INSERT INTO jobs(id,tenant_id,kind,payload,state,attempts,max_attempts,run_at,created_at,dedup_key)
      SELECT ${id('jd', 'i')},$1,'automation',jsonb_build_object('rules',jsonb_build_array(jsonb_build_object('id',$2::text,'version','2')),
       'eventId',${id('e', 'i')}::text,'orderId',${id('o', 'i/4')}::text,'trigger','order.created'),
       CASE WHEN i=200000 THEN 'pending' ELSE 'done' END,CASE WHEN i=200000 THEN 0 ELSE 1 END,1,
       $3::timestamptz+i*interval '1 ms',$3::timestamptz+i*interval '1 ms','p275d:'||i FROM generate_series(4,200000,4) i`, [tenant, rule, since]);
    await c.query(`INSERT INTO automation_runs(id,tenant_id,rule_id,rule_version,event_id,order_id,job_id,definition,snapshot,context,state,created_at)
      SELECT ${id('r', 'i')},$1,$2,2,${id('e', 'i')},${id('o', 'i/4')},${id('jr', 'i')},'{}','{}','{}',CASE WHEN i=199996 THEN 'queued' ELSE 'done' END,
       $3::timestamptz+i*interval '1 ms' FROM generate_series(4,199996,4) i`, [tenant, rule, since]);
    await c.query(`INSERT INTO jobs(id,tenant_id,kind,payload,state,attempts,max_attempts,run_at,created_at,dedup_key)
      SELECT ${id('jr', 'i')},$1,'automation.run',jsonb_build_object('run_id',${id('r', 'i')}::text),
       CASE WHEN i=199996 THEN 'pending' ELSE 'done' END,CASE WHEN i=199996 THEN 0 ELSE 1 END,1,
       $2::timestamptz+i*interval '1 ms',$2::timestamptz+i*interval '1 ms','p275r:'||i FROM generate_series(4,199996,4) i`, [tenant, since]);
    await c.query('SET LOCAL session_replication_role=origin');
    for (const t of ['jobs', 'automation_runs', 'order_events']) await c.query(`ANALYZE ${t}`);
    const want = (await c.query(`SELECT ${id('jr', 199996)} run,${id('jd', 200000)} dispatcher`)).rows[0];
    await c.query('SET LOCAL ROLE dyna_app');
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
    const failures = [], claimed = {};
    for (const sql of claims) {
      const kind = kindOf(sql);
      const params = kind === 'automation' ? [tenant, JSON.stringify([{ id: rule, version: '2' }]), since] : [tenant, rule, '2', since];
      const plan = (await c.query('EXPLAIN (FORMAT JSON) ' + sql, params)).rows[0]['QUERY PLAN'][0].Plan;
      const nodes = [];
      (function walk(n) { nodes.push(n); for (const k of n.Plans ?? []) walk(k); })(plan);
      for (const n of nodes.filter((n) => ['order_events', 'automation_runs'].includes(n['Relation Name']))) {
        const ok = /Index (Only )?Scan/.test(n['Node Type']) && /\(id = [a-z_]+\.[a-z_]+\)/.test(n['Index Cond'] ?? '');
        if (!ok) failures.push(`${kind}: ${n['Relation Name']} ${n['Node Type']} ${n['Index Name'] ?? ''} cond=${n['Index Cond'] ?? '-'}`);
      }
      claimed[kind] = (await c.query(sql, params)).rows.map((r) => r.id);
    }
    assert.deepEqual(failures, []);
    assert.deepEqual(claimed, { 'automation.run': [want.run], 'automation.local_stock': [], 'email.send': [], automation: [want.dispatcher] });
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    // ANALYZE writes pg_class.reltuples/relpages in place (not rolled back): re-estimate the clone's real contents.
    for (const t of ['jobs', 'automation_runs', 'order_events']) await c.query(`ANALYZE ${t}`).catch(() => {});
    await c.end();
  }
});
