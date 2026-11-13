import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { platform, arch, cpus } from 'node:os';
import { migrate, pool } from '../server/db';
import { buildApp } from '../server/app';
import { hashPassword, tokenHash } from '../server/security';
import { tenantScopedOwnerQuery } from './tenant-scoped-owner-write';
assert.equal(process.env.DYNA_TEST, 'true');
test('lokalny burst: 20 organizacji, 200 SKU, 400 zamówień, 25 równoczesnych żądań', async () => {
  await migrate();
  const userId = randomUUID();
  await pool.query('INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,$4)', [
    userId,
    'benchmark@example.test',
    'Benchmark',
    hashPassword('benchmark-only'),
  ]);
  const fixtures: { tenant: string; warehouse: string; products: string[]; cookie: string }[] = [];
  for (let t = 0; t < 20; t++) {
    const tenant = randomUUID(),
      warehouse = randomUUID(),
      token = randomBytes(32).toString('hex'),
      products: string[] = [];
    await pool.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [tenant, `Benchmark ${t}`]);
    await pool.query('INSERT INTO memberships(user_id,tenant_id,role) VALUES($1,$2,$3)', [
      userId,
      tenant,
      'admin',
    ]);
    await pool.query(
      "INSERT INTO sessions(token_hash,user_id,tenant_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
      [tokenHash(token), userId, tenant],
    );
    await pool.query('INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,$3,$4)', [
      warehouse,
      tenant,
      'Benchmark',
      'LOAD',
    ]);
    for (let n = 0; n < 10; n++) {
      const id = randomUUID();
      products.push(id);
      await pool.query(
        'INSERT INTO products(id,tenant_id,sku,name,price) VALUES($1,$2,$3,$4,10000)',
        [id, tenant, `LOAD-${n}`, 'Produkt obciążenia'],
      );
      await tenantScopedOwnerQuery(
        tenant,
        'INSERT INTO stock(tenant_id,warehouse_id,product_id,on_hand) VALUES($1,$2,$3,100)',
        [tenant, warehouse, id],
      );
    }
    fixtures.push({ tenant, warehouse, products, cookie: `dyna_session=${token}` });
  }
  const app = await buildApp();
  const durations: number[] = [];
  let next = 0,
    success = 0;
  const start = performance.now();
  try {
    await Promise.all(
      Array.from({ length: 25 }, async () => {
        while (next < 400) {
          const n = next++,
            f = fixtures[n % 20],
            p = f.products[Math.floor(n / 20) % 10],
            began = performance.now();
          const r = await app.inject({
            method: 'POST',
            url: '/api/orders',
            headers: { cookie: f.cookie, 'idempotency-key': `burst-${n}` },
            payload: {
              customer_name: 'Klient benchmark',
              email: 'load@example.test',
              warehouse_id: f.warehouse,
              items: [{ product_id: p, quantity: 1 }],
            },
          });
          assert.equal(r.statusCode, 201, r.body);
          durations.push(performance.now() - began);
          success++;
        }
      }),
    );
    const elapsed = performance.now() - start;
    durations.sort((a, b) => a - b);
    const stock = (
      await pool.query(
        'SELECT sum(on_hand)::int AS on_hand,sum(reserved)::int AS reserved,sum(available)::int AS available FROM stock',
      )
    ).rows[0];
    assert.deepEqual(stock, { on_hand: 20000, reserved: 400, available: 19600 });
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n, 400);
    const quotas = (
      await pool.query(
        'SELECT resource,sum(used)::int AS used FROM workspace_usage GROUP BY resource',
      )
    ).rows;
    assert.deepEqual(Object.fromEntries(quotas.map((r) => [r.resource, r.used])), {
      orders: 400,
      products: 200,
      warehouses: 20,
      memberships: 20,
    });
    for (const f of fixtures) {
      const list = await app.inject({
        url: '/api/orders?limit=200',
        headers: { cookie: f.cookie },
      });
      assert.equal(list.json().data.length, 20);
      assert.ok(list.json().data.every((o: any) => o.tenant_id === f.tenant));
    }
    const evidence = {
      timestamp: new Date().toISOString(),
      profile: { tenants: 20, sku: 200, requests: 400, concurrency: 25 },
      environment: {
        platform: platform(),
        arch: arch(),
        cpu: cpus()[0].model,
        pool_connections: 12,
      },
      results: {
        success,
        errors: 400 - success,
        elapsed_ms: Math.round(elapsed),
        requests_per_second: Number((success / (elapsed / 1000)).toFixed(1)),
        p50_ms: Math.round(durations[Math.floor(durations.length * 0.5)]),
        p95_ms: Math.round(durations[Math.floor(durations.length * 0.95)]),
        p99_ms: Math.round(durations[Math.floor(durations.length * 0.99)]),
      },
      invariants: {
        stock_conservation: true,
        tenant_isolation: true,
        idempotency_keys: 400,
        quota_counters: true,
      },
      limits:
        'API Fastify inject + rzeczywisty PostgreSQL na jednej maszynie. Bez HTTP/TLS, sieci dostawców, długiego testu stabilności, dużej historii i workerów. Nie jest dowodem docelowej skali Base.',
    };
    writeFileSync(
      process.env.DYNA_BENCHMARK_OUTPUT ?? 'docs/benchmark-foundation.json',
      JSON.stringify(evidence, null, 2),
    );
    console.log(JSON.stringify(evidence.results));
  } finally {
    await app.close();
    await pool.end();
  }
});
