import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { arch, cpus, platform, totalmem } from 'node:os';
import { migrate, pool, tenantTx } from '../server/db';
import { buildApp } from '../server/app';
import { tokenHash, hashPassword } from '../server/security';
import { listProducts } from '../server/catalog';
import { listInventory, inventorySnapshot, inventoryQuery } from '../server/inventory';
assert.equal(process.env.DYNA_TEST, 'true');
const name = process.env.DYNA_SCALE_NAME!,
  file = process.env.DYNA_SCALE_FIXTURE!,
  phase = process.argv[2];
assert(/^dynaminds_scale_[a-f0-9]{32}$/.test(name));
assert.equal(new URL(process.env.DATABASE_URL!).pathname, '/' + name);
assert(['baseline', 'current', 'confirmation', 'inventory'].includes(phase));
type Fixture = {
  tenant: string;
  warehouse: string;
  product: string;
  hot: string;
  cookie: string;
  sample: string[];
};
let fixtures: Fixture[];
async function load() {
  await migrate();
  const began = performance.now();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    // Fast synthetic fixture loading, never a throughput measurement. Limited to the guarded disposable DB.
    // Restore normal triggers before every HTTP request; verify all loaded relationships and counters below.
    await c.query('SET LOCAL session_replication_role=replica');
    await c.query(
      `CREATE FUNCTION pg_temp.scale_id(value text) RETURNS uuid LANGUAGE sql IMMUTABLE AS 'SELECT overlay(overlay(md5(value) placing ''4'' from 13 for 1) placing ''8'' from 17 for 1)::uuid'`,
    );
    await c.query(
      `CREATE TEMP TABLE scale_tenants AS SELECT n,pg_temp.scale_id('scale:tenant:'||n) tenant,pg_temp.scale_id('scale:warehouse:'||n) warehouse,pg_temp.scale_id('scale:user:'||n) account FROM generate_series(1,100) n`,
    );
    await c.query(
      "INSERT INTO tenants(id,name,plan) SELECT tenant,'SCALE-FIXTURE-'||n,'enterprise' FROM scale_tenants",
    );
    await c.query(
      "INSERT INTO users(id,email,name,password_hash) SELECT account,'scale-'||n||'@example.test','Operator syntetyczny '||n,$1 FROM scale_tenants",
      [hashPassword('scale-fixture-only')],
    );
    await c.query(
      "INSERT INTO memberships(user_id,tenant_id,role) SELECT account,tenant,'operator' FROM scale_tenants",
    );
    await c.query(
      "INSERT INTO warehouses(id,tenant_id,name,code) SELECT warehouse,tenant,'Magazyn skali','SCALE' FROM scale_tenants",
    );
    await c.query(
      `INSERT INTO products(id,tenant_id,sku,name,price) SELECT pg_temp.scale_id('scale:product:'||t.n||':'||p),t.tenant,'SKU-'||lpad(p::text,6,'0'),'Produkt skali '||t.n||' / '||p,10000 FROM scale_tenants t CROSS JOIN generate_series(1,10000) p`,
    );
    await c.query(
      `INSERT INTO stock(tenant_id,warehouse_id,product_id,on_hand) SELECT p.tenant_id,t.warehouse,p.id,CASE WHEN p.sku='SKU-010000' THEN 10 ELSE 100 END FROM products p JOIN scale_tenants t ON t.tenant=p.tenant_id`,
    );
    await c.query(
      'INSERT INTO stock_locations(tenant_id,warehouse_id,product_id,location,quantity) SELECT tenant_id,warehouse_id,product_id,location,on_hand FROM stock',
    );
    await c.query(
      `INSERT INTO orders(id,tenant_id,number,source,customer_name,email,status,total,warehouse_id,portal_token,created_at) SELECT pg_temp.scale_id('scale:order:'||t.n||':'||o),t.tenant,'SCALE-'||t.n||'-'||o,'scale-fixture','Klient syntetyczny '||o,'scale-order-'||o||'@example.test','cancelled',10000,t.warehouse,md5('scale:portal:'||t.n||':'||o),date_trunc('day',now())+o*interval '1 second' FROM scale_tenants t CROSS JOIN generate_series(1,1000) o`,
    );
    await c.query(
      `INSERT INTO order_items(id,tenant_id,order_id,product_id,name,sku,quantity,price,vat,line_total) SELECT pg_temp.scale_id('scale:item:'||t.n||':'||o),t.tenant,pg_temp.scale_id('scale:order:'||t.n||':'||o),pg_temp.scale_id('scale:product:'||t.n||':'||o),'Produkt skali '||t.n||' / '||o,'SKU-'||lpad(o::text,6,'0'),1,10000,23,10000 FROM scale_tenants t CROSS JOIN generate_series(1,1000) o`,
    );
    await c.query(
      `INSERT INTO order_pick_items(id,tenant_id,order_id,product_id,name,sku,quantity) SELECT id,tenant_id,order_id,product_id,name,sku,quantity FROM order_items`,
    );
    for (const table of ['products', 'warehouses', 'memberships'])
      await c.query(
        `INSERT INTO workspace_usage(tenant_id,resource,period,used) SELECT tenant_id,$1,'2000-01-01',count(*) FROM ${table} GROUP BY tenant_id`,
        [table],
      );
    await c.query(
      `INSERT INTO workspace_usage(tenant_id,resource,period,used) SELECT tenant_id,'orders',date_trunc('month',created_at AT TIME ZONE 'UTC')::date,count(*) FROM orders GROUP BY 1,3`,
    );
    const rows = (await c.query('SELECT * FROM scale_tenants ORDER BY n')).rows;
    fixtures = [];
    for (const t of rows) {
      const token = randomBytes(32).toString('hex');
      await c.query(
        "INSERT INTO sessions(token_hash,user_id,tenant_id,expires_at) VALUES($1,$2,$3,now()+interval '2 hours')",
        [tokenHash(token), t.account, t.tenant],
      );
      fixtures.push({
        tenant: t.tenant,
        warehouse: t.warehouse,
        product: (
          await c.query("SELECT id FROM products WHERE tenant_id=$1 AND sku='SKU-000001'", [
            t.tenant,
          ])
        ).rows[0].id,
        hot: (
          await c.query("SELECT id FROM products WHERE tenant_id=$1 AND sku='SKU-010000'", [
            t.tenant,
          ])
        ).rows[0].id,
        cookie: 'dyna_session=' + token,
        sample: (
          await c.query('SELECT id FROM products WHERE tenant_id=$1 ORDER BY sku LIMIT 200', [
            t.tenant,
          ])
        ).rows.map((p) => p.id),
      });
    }
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
  const counts = (
    await pool.query(
      `SELECT (SELECT count(*)::int FROM tenants) tenants,(SELECT count(*)::int FROM products) products,(SELECT count(*)::int FROM stock) stock,(SELECT count(*)::int FROM stock_locations) locations,(SELECT count(*)::int FROM orders) orders,(SELECT count(*)::int FROM order_items) items,(SELECT count(*)::int FROM order_pick_items) picks`,
    )
  ).rows[0];
  assert.deepEqual(counts, {
    tenants: 100,
    products: 1000000,
    stock: 1000000,
    locations: 1000000,
    orders: 100000,
    items: 100000,
    picks: 100000,
  });
  const invalid = (
    await pool.query(`SELECT
    (SELECT count(*) FROM products p LEFT JOIN tenants t ON t.id=p.tenant_id WHERE t.id IS NULL)+
    (SELECT count(*) FROM stock s LEFT JOIN warehouses w ON (w.tenant_id,w.id)=(s.tenant_id,s.warehouse_id) LEFT JOIN products p ON (p.tenant_id,p.id)=(s.tenant_id,s.product_id) WHERE w.id IS NULL OR p.id IS NULL)+
    (SELECT count(*) FROM stock_locations l LEFT JOIN stock s USING(tenant_id,warehouse_id,product_id) WHERE s.product_id IS NULL OR l.quantity<>s.on_hand)+
    (SELECT count(*) FROM orders o LEFT JOIN warehouses w ON (w.tenant_id,w.id)=(o.tenant_id,o.warehouse_id) WHERE w.id IS NULL)+
    (SELECT count(*) FROM order_items i LEFT JOIN orders o ON (o.tenant_id,o.id)=(i.tenant_id,i.order_id) LEFT JOIN products p ON (p.tenant_id,p.id)=(i.tenant_id,i.product_id) WHERE o.id IS NULL OR p.id IS NULL OR i.price*i.quantity<>o.total) n`)
  ).rows[0];
  assert.equal(Number(invalid.n), 0);
  assert.equal(
    (await pool.query('SHOW session_replication_role')).rows[0].session_replication_role,
    'origin',
  );
  for (const table of [
    'products',
    'stock',
    'stock_locations',
    'orders',
    'order_items',
    'order_pick_items',
  ])
    await pool.query('ANALYZE ' + table);
  const evidence = { fixtures, counts, fixture_load_ms: Math.round(performance.now() - began) };
  await writeFile(file, JSON.stringify(evidence), { mode: 0o600 });
  console.log(
    JSON.stringify({ phase: 'fixture_loaded', counts, load_ms: evidence.fixture_load_ms }),
  );
  return evidence;
}
async function measure() {
  if (phase === 'confirmation') await migrate();
  const fixture =
    phase !== 'confirmation' ? await load() : JSON.parse(await readFile(file, 'utf8'));
  fixtures = fixture.fixtures;
  const plans: any[] = [];
  for (const q of [
    { search: '', limit: 50 },
    { search: 'SKU-000500', limit: 50 },
    { search: '', limit: 50, warehouse_id: fixtures[0].warehouse },
  ]) {
    await tenantTx(fixtures[0].tenant, async (c) => {
      let sql = '',
        params: any[] = [];
      await (phase === 'inventory' ? listInventory : listProducts)(
        {
          query: async (text: string, args: any[]) => {
            sql = text;
            params = args;
            return c.query(text, args);
          },
        } as any,
        phase === 'inventory' ? inventoryQuery.parse(q) : q,
      );
      plans.push({
        query_scope: q,
        plan: (await c.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ' + sql, params)).rows[0][
          'QUERY PLAN'
        ],
      });
    });
  }
  if (phase === 'inventory')
    await tenantTx(fixtures[0].tenant, async (c) => {
      let sql = '',
        params: any[] = [];
      await inventorySnapshot(
        {
          query: async (text: string, args: any[]) => {
            sql = text;
            params = args;
            return c.query(text, args);
          },
        } as any,
        { warehouse_id: fixtures[0].warehouse, product_ids: fixtures[0].sample },
      );
      plans.push({
        query_scope: { snapshot_products: 200 },
        plan: (await c.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ' + sql, params)).rows[0][
          'QUERY PLAN'
        ],
      });
    });
  const app = await buildApp();

  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  assert(address && typeof address === 'object');
  const base = 'http://127.0.0.1:' + address.port + '/api';
  const durations: Record<string, number[]> =
    phase === 'inventory'
      ? { inventory: [], snapshot: [], orders: [], create: [] }
      : { products: [], search: [], orders: [], create: [] };
  let next = 0,
    success = 0;
  async function http(f: Fixture, path: string, method = 'GET', payload?: any, key?: string) {
    const response = await fetch(base + path, {
      signal: AbortSignal.timeout(20000),
      method,
      headers: {
        cookie: f.cookie,
        ...(payload ? { 'content-type': 'application/json' } : {}),
        ...(key ? { 'idempotency-key': key } : {}),
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    return { status: response.status, data: await response.json() };
  }
  let hot: any = null;
  try {
    for (const f of fixtures.slice(0, 3))
      assert.equal((await http(f, '/products?limit=5')).status, 200);
    const before = (await pool.query('SELECT count(*)::int n FROM orders')).rows[0].n;
    const began = performance.now();
    const workers = await Promise.allSettled(
      Array.from({ length: 100 }, async () => {
        while (next < 400) {
          const n = next++,
            f = fixtures[n % 100],
            kind = (
              phase === 'inventory'
                ? ['create', 'inventory', 'orders', 'snapshot']
                : ['create', 'products', 'orders', 'search']
            )[Math.floor(n / 100)],
            start = performance.now();
          const r =
            kind === 'create'
              ? await http(
                  f,
                  '/orders',
                  'POST',
                  {
                    customer_name: 'SCALE-BURST-' + phase,
                    email: 'scale-burst@example.test',
                    warehouse_id: f.warehouse,
                    items: [{ product_id: f.product, quantity: 1 }],
                  },
                  'scale-' + phase + '-' + n,
                )
              : await http(
                  f,
                  kind === 'products'
                    ? '/products?limit=50'
                    : kind === 'orders'
                      ? '/orders?limit=50'
                      : kind === 'inventory'
                        ? '/inventory?limit=50'
                        : kind === 'snapshot'
                          ? '/inventory/snapshot?' +
                            new URLSearchParams({
                              warehouse_id: f.warehouse,
                              product_ids: f.sample.join(','),
                            })
                          : '/products?limit=50&search=SKU-000500',
                );
          durations[kind].push(performance.now() - start);
          assert.equal(
            r.status,
            kind === 'create' ? 201 : 200,
            JSON.stringify({ kind, status: r.status, problem: r.data.detail }),
          );
          if (kind === 'create') {
            assert.equal(r.data.tenant_id, f.tenant);
            assert.equal(r.data.total, 10000);
          } else {
            assert(r.data.data.length > 0);
            assert(r.data.data.every((p: any) => p.tenant_id === f.tenant));
            if (kind === 'inventory') assert.equal(r.data.data.length, 50);
            if (kind === 'snapshot') assert.equal(r.data.data.length, 200);
            if (kind === 'search') assert(r.data.data.every((p: any) => p.sku === 'SKU-000500'));
          }
          success++;
        }
      }),
    );
    for (const result of workers) if (result.status === 'rejected') throw result.reason;
    const elapsed = performance.now() - began;
    assert.equal((await pool.query('SELECT count(*)::int n FROM orders')).rows[0].n, before + 100);
    const balances = (
      await pool.query(
        'SELECT sum(on_hand)::bigint on_hand,sum(reserved)::bigint reserved,sum(available)::bigint available FROM stock',
      )
    ).rows[0];
    const reserved = phase === 'confirmation' ? 200 : 100;
    assert.equal(Number(balances.reserved), reserved);
    assert.equal(Number(balances.on_hand), 99991000);
    assert.equal(Number(balances.available), 99991000 - reserved);
    for (const f of fixtures.slice(0, 5))
      assert.equal(
        (await http(f, '/products/' + fixtures[(fixtures.indexOf(f) + 1) % 100].product)).status,
        404,
      );
    // Repeated cursors traverse exactly 1,000 archived orders despite equal dates across firms.
    const f = fixtures[0];
    let cursor = '',
      pages = 0;
    const ids = new Set();
    do {
      const page = await http(
        f,
        '/orders?status=cancelled&limit=200' +
          (cursor ? '&after=' + encodeURIComponent(cursor) : ''),
      );
      assert.equal(page.status, 200);
      for (const o of page.data.data) {
        assert.equal(o.tenant_id, f.tenant);
        assert(!ids.has(o.id));
        ids.add(o.id);
      }
      cursor = page.data.meta.cursor ?? '';
      pages++;
    } while (cursor);
    assert.equal(ids.size, 1000);
    assert.equal(pages, 5);
    if (phase !== 'baseline') {
      const requests = await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          http(
            f,
            '/orders',
            'POST',
            {
              customer_name: 'SCALE-CONTENTION',
              email: 'scale-hot@example.test',
              warehouse_id: f.warehouse,
              items: [{ product_id: f.hot, quantity: 1 }],
            },
            'scale-hot-' + i,
          ),
        ),
      );
      const accepted = requests.filter((r) => r.status === 201),
        conflicts = requests.filter((r) => r.status === 409);
      assert.equal(accepted.length, 10);
      assert.equal(conflicts.length, 90);
      const body = {
        customer_name: 'SCALE-CONTENTION',
        email: 'scale-hot@example.test',
        warehouse_id: f.warehouse,
        items: [{ product_id: f.hot, quantity: 1 }],
      };
      const acceptedIndex = requests.findIndex((r) => r.status === 201),
        replay = await http(f, '/orders', 'POST', body, 'scale-hot-' + acceptedIndex);
      assert.equal(replay.status, 200);
      assert.equal(replay.data.id, requests[acceptedIndex].data.id);
      const s = (
        await pool.query(
          'SELECT on_hand,reserved,available FROM stock WHERE tenant_id=$1 AND product_id=$2',
          [f.tenant, f.hot],
        )
      ).rows[0];
      assert.deepEqual(s, { on_hand: 10, reserved: 10, available: 0 });
      hot = {
        concurrency: 100,
        available_before: 10,
        accepted: 10,
        conflicts: 90,
        stock: s,
        replay_same_order: true,
      };
    }
    // Verify quota counters against persisted rows after normal HTTP writes and rejected races.
    const quotaMismatch = await pool.query(`WITH actual AS (
    SELECT tenant_id,'products' resource,'2000-01-01'::date period,count(*) used FROM products GROUP BY tenant_id
    UNION ALL SELECT tenant_id,'warehouses','2000-01-01'::date,count(*) FROM warehouses GROUP BY tenant_id
    UNION ALL SELECT tenant_id,'memberships','2000-01-01'::date,count(*) FROM memberships GROUP BY tenant_id
    UNION ALL SELECT tenant_id,'orders',date_trunc('month',created_at AT TIME ZONE 'UTC')::date,count(*) FROM orders GROUP BY 1,3
  ) SELECT count(*)::int n FROM actual a FULL JOIN workspace_usage u USING(tenant_id,resource,period)
    WHERE coalesce(a.used,0)<>coalesce(u.used,0)`);
    assert.equal(quotaMismatch.rows[0].n, 0);
    let inventoryPageEvidence: any = null;
    if (phase === 'inventory') {
      let after = '',
        pages = 0;
      const ids = new Set<string>();
      do {
        const r = await http(
          fixtures[0],
          '/inventory?limit=200&warehouse_id=' +
            fixtures[0].warehouse +
            (after ? '&after=' + encodeURIComponent(after) : ''),
        );
        assert.equal(r.status, 200);
        for (const row of r.data.data) {
          assert.equal(row.tenant_id, fixtures[0].tenant);
          assert.equal(row.warehouse_id, fixtures[0].warehouse);
          assert(!ids.has(row.product_id));
          ids.add(row.product_id);
        }
        after = r.data.meta.cursor ?? '';
        pages++;
      } while (after);
      assert.equal(ids.size, 10000);
      assert.equal(pages, 50);
      inventoryPageEvidence = { unique_products: 10000, pages: 50 };
    }
    const percentiles = (values: number[]) => {
      const a = [...values].sort((a, b) => a - b);
      return {
        samples: a.length,
        p50_ms: Math.round(a[Math.min(a.length - 1, Math.floor(a.length * 0.5))]),
        p95_ms: Math.round(a[Math.min(a.length - 1, Math.floor(a.length * 0.95))]),
        p99_ms: Math.round(a[Math.min(a.length - 1, Math.floor(a.length * 0.99))]),
      };
    };
    const report = {
      checked_at: new Date().toISOString(),
      phase,
      revision: process.env.APP_REVISION ?? 'working_tree',
      source_state: process.env.DYNA_SCALE_SOURCE_STATE ?? 'unknown',
      source_hashes: Object.fromEntries(
        await Promise.all(
          ['server/app.ts', 'server/catalog.ts', 'server/inventory.ts'].map(async (file) => [
            file,
            createHash('sha256')
              .update(await readFile(file))
              .digest('hex'),
          ]),
        ),
      ),
      catalog_source_sha256: createHash('sha256')
        .update(await readFile('server/catalog.ts'))
        .digest('hex'),
      starting_orders: before,
      ending_orders: (await pool.query('SELECT count(*)::int n FROM orders')).rows[0].n,
      profile: {
        tenants: 100,
        sku: 1000000,
        archived_orders: 100000,
        clients: 100,
        concurrency: 100,
        requests: 400,
        writes: 100,
        read_requests: 300,
        ...(phase === 'inventory' ? { inventory_page: 50, snapshot_products: 200 } : {}),
      },
      fixture: {
        counts: fixture.counts,
        load_ms: fixture.fixture_load_ms,
        loading:
          'synthetic bulk SQL with triggers suspended only in disposable database; not import throughput',
        loaded_relationships_verified: true,
        triggers_restored: true,
      },
      environment: {
        platform: platform(),
        arch: arch(),
        cpu: cpus()[0].model,
        memory_gb: Math.round(totalmem() / 1024 ** 3),
        pool_connections: 12,
        postgres: (await pool.query('SHOW server_version')).rows[0].server_version,
        database_bytes: Number(
          (await pool.query('SELECT pg_database_size(current_database()) n')).rows[0].n,
        ),
      },
      results: {
        success,
        errors: 400 - success,
        elapsed_ms: Math.round(elapsed),
        http_requests_per_second: Number(((400 / elapsed) * 1000).toFixed(2)),
        order_creates_per_second: Number(((100 / elapsed) * 1000).toFixed(2)),
        operations: Object.fromEntries(
          Object.entries(durations).map(([k, v]) => [k, percentiles(v)]),
        ),
      },
      invariants: {
        rls_all_read_responses: true,
        cross_tenant_ids_denied: 5,
        archived_order_cursor_unique: 1000,
        stock_conservation: true,
        quota_counters_match_rows: true,
        real_api_transactions: true,
        provider_requests: 0,
      },
      contention: hot,
      inventory_pagination: inventoryPageEvidence,
      plans,
      limits:
        'Local HTTP/Fastify/PostgreSQL, synthetic archived cancelled orders, warm database, bounded burst. No external provider latency, TLS, sustained 24h load, complete fulfillment/queues, long retention or production capacity claim.',
    };
    await writeFile('docs/scale-' + phase + '.json', JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ phase, ...report.results, contention: hot }));
  } catch (error) {
    console.error(error);
    throw error;
  } finally {
    app.server.closeAllConnections();
    await app.close();
  }
}
try {
  await measure();
} finally {
  await pool.end();
}
