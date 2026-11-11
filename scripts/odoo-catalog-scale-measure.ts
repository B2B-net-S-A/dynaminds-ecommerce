// Measure the real service and RLS in a disposable local database, with a synthetic JSON-2 transport.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { arch, cpus, platform, totalmem } from 'node:os';
import { migrate, pool, tenantTx } from '../server/db';
import { buildApp } from '../server/app';
import { encrypt } from '../server/security';
import { processOdooCatalogSync } from '../server/odoo-catalog-sync';
import { seed, DEMO_TENANT, SECOND_TENANT } from '../tests/fixtures';
import { odooFixture, odooSettings, odooCredentials } from '../tests/odoo-fixtures';

assert.equal(process.env.DYNA_TEST, 'true');
const dbName = process.env.DYNA_SCALE_NAME!;
assert(/^dynaminds_scale_[a-f0-9]{32}$/.test(dbName));
assert.equal(new URL(process.env.DATABASE_URL!).pathname, '/' + dbName);
const count = 10000,
  channel = randomUUID(),
  f = odooFixture(count);
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
const percentiles = (values: number[]) => {
  const v = [...values].sort((a, b) => a - b);
  return {
    samples: v.length,
    p50_ms: v[Math.floor((v.length - 1) * 0.5)],
    p95_ms: v[Math.floor((v.length - 1) * 0.95)],
    max_ms: v.at(-1),
  };
};
try {
  await migrate();
  await seed();
  const warehouse = (
    await pool.query('SELECT id FROM warehouses WHERE tenant_id=$1 ORDER BY id LIMIT 1', [
      DEMO_TENANT,
    ])
  ).rows[0].id;
  const setupStarted = performance.now();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      "INSERT INTO channels(id,tenant_id,provider,name,mode,credentials,settings) VALUES($1,$2,'odoo','Scale fixture','sandbox',$3,$4)",
      [channel, DEMO_TENANT, encrypt(odooCredentials), JSON.stringify(odooSettings)],
    );
    await c.query(
      `CREATE TEMP TABLE scale_products AS SELECT gen_random_uuid() id,n FROM generate_series(1,$1::integer) n`,
      [count],
    );
    await c.query(
      "INSERT INTO products(id,tenant_id,sku,name,price) SELECT id,$1,'ODOO-SCALE-'||n,'Synthetic Odoo scale '||n,9999 FROM scale_products",
      [DEMO_TENANT],
    );
    await c.query(
      'INSERT INTO stock(tenant_id,warehouse_id,product_id,on_hand) SELECT $1,$2,id,12 FROM scale_products',
      [DEMO_TENANT, warehouse],
    );
    await c.query(
      'INSERT INTO listings(id,tenant_id,channel_id,product_id,external_id,price) SELECT gen_random_uuid(),$1,$2,id,(100+n)::text,9999 FROM scale_products',
      [DEMO_TENANT, channel],
    );
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
  const setupMs = performance.now() - setupStarted;
  app = await buildApp({ integrationTransport: f.transport });
  let cookie = '';
  const req = (url: string, method: any = 'GET', payload?: any, auth = cookie) =>
    app!.inject({ url: '/api' + url, method, payload, headers: { cookie: auth } });
  const login = await req('/auth/login', 'POST', {
    email: 'admin@demo.local',
    password: 'DynaDemo!2026',
  });
  assert.equal(login.statusCode, 200, login.body);
  cookie = String(login.headers['set-cookie']).split(';')[0];
  const switched = await req('/workspaces/switch', 'POST', { tenant_id: DEMO_TENANT });
  assert.equal(switched.statusCode, 200, switched.body);
  cookie = String(switched.headers['set-cookie']).split(';')[0];
  const cfg = await req(`/integrations/${channel}/odoo-catalog-sync`, 'PUT', {
    version: 0,
    enabled: true,
    interval_minutes: 60,
    prices: true,
    confirmed: true,
  });
  assert.equal(cfg.statusCode, 200, cfg.body);
  const key = randomUUID(),
    enqueueStarted = performance.now();
  const queued = await req(`/integrations/${channel}/odoo-catalog-sync`, 'POST', {
    version: 1,
    client_key: key,
  });
  assert(queued.statusCode < 300, queued.body);
  const enqueueMs = performance.now() - enqueueStarted,
    run = queued.json();
  assert.equal(run.total, count);
  const durations: number[] = [],
    historyDurations: number[] = [];
  let rpcCount = 0,
    largestRead = 0,
    maxRss = process.memoryUsage().rss,
    replayChecked = false;
  const transport: typeof f.transport = async (url, init) => {
    rpcCount++;
    const args = JSON.parse(String(init.body));
    largestRead = Math.max(largestRead, args.ids?.length ?? 0);
    const response = await f.transport(url, init);
    // The fixture's call recorder is for contract assertions, not an unbounded benchmark log.
    f.calls.length = 0;
    return response;
  };
  const began = performance.now();
  for (let page = 0; page < count / 50; page++) {
    const job = (
      await pool.query(
        "UPDATE jobs SET state='running',attempts=attempts+1,lease_token=$2,locked_at=now() WHERE id=$1 AND state='pending' RETURNING *",
        [run.job_id, randomUUID()],
      )
    ).rows[0];
    assert(job, 'Worker must have a pending checkpoint');
    const pageStarted = performance.now();
    // Bypass only the scheduler's one-second inter-page delay; retain real service transactions and fences.
    await processOdooCatalogSync(job, { transport });
    durations.push(performance.now() - pageStarted);
    maxRss = Math.max(maxRss, process.memoryUsage().rss);
    if (page % 20 === 0) {
      const readStarted = performance.now();
      const history = await req(`/odoo-catalog-sync-runs/${run.id}?limit=100`);
      assert.equal(history.statusCode, 200, history.body);
      historyDurations.push(performance.now() - readStarted);
      assert.equal(
        (
          await tenantTx(SECOND_TENANT, (tx) =>
            tx.query('SELECT count(*)::integer n FROM odoo_catalog_sync_items WHERE run_id=$1', [
              run.id,
            ]),
          )
        ).rows[0].n,
        0,
      );
      console.log(`Catalog checkpoint ${page + 1}/${count / 50}`);
    }
    if (page === 0) {
      const replayRpc = rpcCount;
      await processOdooCatalogSync(job, { transport });
      assert.equal(rpcCount, replayRpc, 'Lost lease must not repeat a completed page');
      replayChecked = true;
    }
  }
  const workMs = performance.now() - began;
  const final = (await pool.query('SELECT * FROM odoo_catalog_sync_runs WHERE id=$1', [run.id]))
    .rows[0];
  assert.equal(final.state, 'success');
  assert.equal(final.applied, count);
  assert.equal(final.skipped, 0);
  const summary = (
    await pool.query(
      `SELECT count(*)::integer n,count(*) FILTER(WHERE p.price=CASE WHEN l.external_id::integer % 2=1 THEN 4305 ELSE 4920 END)::integer correct_prices,count(*) FILTER(WHERE s.on_hand=12 AND s.reserved=0)::integer unchanged_stock,count(*) FILTER(WHERE i.state='applied' AND (i.result->>'availability')::integer=12+l.external_id::integer-101)::integer correct_results FROM listings l JOIN products p ON p.id=l.product_id JOIN stock s ON s.product_id=p.id JOIN odoo_catalog_sync_items i ON i.listing_id=l.id AND i.run_id=$1 WHERE l.channel_id=$2`,
      [run.id, channel],
    )
  ).rows[0];
  assert.deepEqual(summary, {
    n: count,
    correct_prices: count,
    unchanged_stock: count,
    correct_results: count,
  });
  const replay = await req(`/integrations/${channel}/odoo-catalog-sync`, 'POST', {
    version: 1,
    client_key: key,
  });
  assert.equal(replay.json().id, run.id);
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::integer n FROM odoo_catalog_sync_runs WHERE channel_id=$1',
        [channel],
      )
    ).rows[0].n,
    1,
  );
  const report = {
    checked_at: new Date().toISOString(),
    revision: process.env.APP_REVISION,
    source_state: process.env.DYNA_SCALE_SOURCE_STATE,
    scope: 'isolated_local_odoo_catalog_service_synthetic_transport',
    provider_authenticated: false,
    variants: count,
    pages: durations.length,
    applied: final.applied,
    skipped: final.skipped,
    setup_ms: setupMs,
    enqueue_ms: enqueueMs,
    work_ms: workMs,
    variants_per_second_without_scheduler_delay: count / (workMs / 1000),
    configured_inter_page_delay_ms: 1000,
    estimated_serial_seconds_with_delay: workMs / 1000 + durations.length - 1,
    worker_pages: percentiles(durations),
    history_reads_between_pages: percentiles(historyDurations),
    synthetic_rpc_count: rpcCount,
    largest_read_ids: largestRead,
    peak_process_rss_bytes: maxRss,
    unchanged_physical_stock_rows: summary.unchanged_stock,
    correct_price_rows: summary.correct_prices,
    correct_availability_rows: summary.correct_results,
    tenant_isolation_checked: true,
    stale_lease_replay_checked: replayChecked,
    enqueue_replay_checked: true,
    scheduler_delay_bypassed: true,
    concurrent_users_tested: 0,
    real_provider_requests: 0,
    host: { platform: platform(), arch: arch(), cpus: cpus().length, memory_bytes: totalmem() },
    whole_goal_complete: false,
  };
  await writeFile('docs/odoo-catalog-scale-qa.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await app?.close();
  await pool.end();
}
