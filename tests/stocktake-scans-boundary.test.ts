/** Separate, explicitly synthetic 10000-lot scope; no 10000-scan/capacity claim. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../server/app';
import { migrate, pool, tenantTx } from '../server/db';
import { enlistWmsActorInTx } from '../server/wms-lots-transaction';
import { wmsLotsHash } from '../server/wms-lots';
import { seed } from './fixtures';

assert.equal(process.env.DYNA_TEST, 'true');
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
assert.match(database.pathname, /^\/dynaminds_test_\d+$/);
// Isolated diagnostic only: emit SQL text and timings, never bind values or credentials.
if (process.env.STOCKTAKE_SCAN_TEST_SQL === 'true')
  pool.on('connect', (client) => {
    const query = client.query.bind(client);
    client.query = ((...args: any[]) => {
      const started = performance.now();
      const sql = typeof args[0] === 'string' ? args[0] : (args[0]?.text ?? '');
      if (sql.includes('SELECT p.layer_id FROM wms_layer_positions p JOIN wms_cost_layers l')) {
        const compact = (p: any): any =>
          Object.fromEntries([
            ...['Node Type', 'Join Type', 'Relation Name', 'Index Name', 'Plan Rows', 'Total Cost']
              .filter((k) => k in p)
              .map((k) => [k, p[k]]),
            ...(p.Plans ? [['Plans', p.Plans.map(compact)]] : []),
          ]);
        return (query as any)('EXPLAIN (FORMAT JSON) ' + sql, args[1])
          .then((plan: any) => {
            console.error('SQL plan', JSON.stringify(compact(plan.rows[0]['QUERY PLAN'][0].Plan)));
            return (query as any)(...args);
          })
          .catch((error: any) => {
            console.error(
              'SQL failed',
              error.code,
              Math.round(performance.now() - started),
              sql.slice(0, 2000),
            );
            throw error;
          });
      }
      const result = (query as any)(...args);
      if (!result?.then) return result;
      return result.then(
        (value: unknown) => {
          const elapsed = performance.now() - started;
          if (elapsed > 200) console.error('SQL timing', Math.round(elapsed), sql.slice(0, 2000));
          return value;
        },
        (error: any) => {
          console.error(
            'SQL failed',
            error.code,
            Math.round(performance.now() - started),
            sql.slice(0, 2000),
          );
          throw error;
        },
      );
    }) as typeof client.query;
  });
type Row = Record<string, any>;
let app: Awaited<ReturnType<typeof buildApp>>,
  cookie = '',
  tenant = '',
  warehouse = '',
  user = '',
  ip = 1,
  providerCalls = 0;
const req = (path: string, method: any = 'GET', payload?: any) =>
  app.inject({
    url: '/api' + path,
    method,
    payload,
    headers: { cookie },
    remoteAddress: '127.0.153.' + ip,
  });
async function ok(path: string, method: any = 'GET', body?: any) {
  const r = await req(path, method, body);
  // Only this isolated synthetic fixture response is logged; never auth headers,
  // cookies or request credentials. Preserve a bounded SQL/error diagnosis.
  assert(
    r.statusCode >= 200 && r.statusCode < 300,
    `${method} ${path}: ${r.statusCode}; ${r.body.slice(0, 4000)}`,
  );
  return r.json() as Row;
}
before(async () => {
  await migrate();
  await seed();
  app = await buildApp({
    integrationTransport: async () => {
      ++providerCalls;
      throw Error('Boundary must not call providers');
    },
    logging: process.env.STOCKTAKE_SCAN_TEST_LOG === 'true',
  });
  const r = await req('/auth/login', 'POST', {
    email: 'admin@demo.local',
    password: 'DynaDemo!2026',
  });
  assert.equal(r.statusCode, 200);
  cookie = String(r.headers['set-cookie']).split(';')[0];
  user = (await pool.query("SELECT id FROM users WHERE email='admin@demo.local'")).rows[0].id;
  tenant = randomUUID();
  warehouse = randomUUID();
  await pool.query(
    "INSERT INTO tenants(id,name,plan) VALUES($1,'Synthetic 10000-lot scan boundary','enterprise')",
    [tenant],
  );
  await pool.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'admin')", [
    tenant,
    user,
  ]);
  await pool.query(
    "INSERT INTO warehouses(id,tenant_id,name,code) VALUES($1,$2,'Bounded lot layout','BOUND')",
    [warehouse, tenant],
  );
  const switched = await req('/workspaces/switch', 'POST', { tenant_id: tenant });
  assert.equal(switched.statusCode, 200);
  cookie = String(switched.headers['set-cookie']).split(';')[0];
});
after(async () => {
  try {
    await app?.close();
  } finally {
    await pool.end();
  }
});
async function physical() {
  const out: Row = {};
  for (const table of [
    'products',
    'stock',
    'stock_locations',
    'wms_operations',
    'wms_policies',
    'wms_lots',
    'wms_cost_layers',
    'wms_layer_positions',
    'wms_layer_movements',
    'stock_movements',
    'stock_location_movements',
    'orders',
    'reservations',
    'reservation_locations',
    'jobs',
    'outbound_events',
  ])
    out[table] = (
      await pool.query(`SELECT to_jsonb(t) row FROM ${table} t WHERE tenant_id=$1 ORDER BY 1`, [
        tenant,
      ])
    ).rows;
  return out;
}
test(
  '10000 same-bin lot candidates paginate exactly; an explicit last-page choice writes one zero receipt and no physical effects',
  // Hang guard only: the 10000-lot fixture, stocktake and 100 candidate pages took 262 s locally on 13.11.2026.
  { timeout: 600000 },
  async () => {
    const product = await ok('/products', 'POST', {
      sku: 'BOUNDARY-' + randomUUID(),
      ean: '000010000',
      name: 'Synthetic 10000-lot product',
      price: 100,
      warehouse_id: warehouse,
      quantity: 10000,
      location: 'A-01',
    });
    const operation = randomUUID(),
      request = {
        synthetic: '10000-lot-opening',
        product_id: product.id,
        warehouse_id: warehouse,
        quantity: 10000,
      };
    // Explicit isolated fixture: a genuine typed opening operation and exact
    // positions/journal. No triggers, source guards or quantity checks are disabled.
    await tenantTx(
      tenant,
      async (c) => {
        // Fixture only: 10000 rows per statement pass per-row warehouse policy guards (~5-13 ms per row,
        // 13.11.2026) and exceeded the ordinary 8 s statement_timeout on CI. The code under test keeps 8 s.
        await c.query("SET LOCAL statement_timeout='120s'");
        enlistWmsActorInTx(
          c,
          { tenantId: tenant, userId: user, source: 'manual' },
          { adminOnly: true, cost: true },
        );
        await c.query(
          `INSERT INTO wms_operations(id,tenant_id,actor_id,client_key,request_hash,kind,source,policy_version,request,result) VALUES($1,$2,$3,$4,$5,'opening','manual',1,$6,'{}')`,
          [operation, tenant, user, randomUUID(), wmsLotsHash(request), request],
        );
        await c.query(
          `INSERT INTO wms_policies(tenant_id,enabled,version,method,currency,exponent,opening_operation_id) VALUES($1,true,1,'FIFO','PLN',2,$2)`,
          [tenant, operation],
        );
        await c.query(
          `INSERT INTO wms_lots(id,tenant_id,product_id,operation_id,lot_code,origin) SELECT gen_random_uuid(),$1,$2,$3,'BOUND-'||lpad(n::text,5,'0'),'opening' FROM generate_series(1,10000)n`,
          [tenant, product.id, operation],
        );
        await c.query(
          `INSERT INTO wms_cost_layers(id,tenant_id,lot_id,product_id,operation_id,quantity_received,unit_cost_minor,currency,exponent) SELECT gen_random_uuid(),tenant_id,id,product_id,$2,1,NULL,'PLN',2 FROM wms_lots WHERE tenant_id=$1`,
          [tenant, operation],
        );
        await c.query(
          `INSERT INTO wms_layer_positions(tenant_id,warehouse_id,product_id,location,layer_id,quantity) SELECT $1,$2,$3,'A-01',id,1 FROM wms_cost_layers WHERE tenant_id=$1`,
          [tenant, warehouse, product.id],
        );
        await c.query(
          `INSERT INTO wms_layer_movements(id,tenant_id,operation_id,warehouse_id,product_id,location,layer_id,delta,value_delta,kind) SELECT gen_random_uuid(),$1,$2,$3,$4,'A-01',id,1,NULL,'opening' FROM wms_cost_layers WHERE tenant_id=$1`,
          [tenant, operation, warehouse, product.id],
        );
        await c.query('SET CONSTRAINTS ALL IMMEDIATE');
      },
      { wmsAdmission: 'activation' },
    );
    // Autovacuum would analyze 10000 fresh rows within a minute; without statistics every 100-line
    // stocktake scope query planned a nested loop over all layers (~4 s each, 13.11.2026).
    await pool.query('ANALYZE wms_lots, wms_cost_layers, wms_layer_positions, wms_layer_movements');
    const { stocktake } = await ok('/wms-lots/stocktakes', 'POST', {
      client_key: randomUUID(),
      warehouse_id: warehouse,
      name: 'Actual complete resolver scope',
      policy_version: '1',
      blind: true,
    });
    assert.equal(stocktake.line_count, 10000);
    const base = '/wms-lots/stocktakes/' + stocktake.id,
      physicalBefore = await physical();
    const expected = (
        await pool.query(
          'SELECT id,product_id,location,lot FROM wms_stocktake_lines WHERE tenant_id=$1 AND stocktake_id=$2 ORDER BY id',
          [tenant, stocktake.id],
        )
      ).rows,
      byId = new Map(expected.map((l) => [l.id, l]));
    assert.equal(byId.size, 10000);
    let cursor: string | undefined,
      pages = 0,
      last: Row | undefined,
      firstCursor: string | undefined;
    const seen = new Set<string>(),
      cursors = new Set<string>();
    do {
      const path =
          base +
          '/scan-candidates?' +
          new URLSearchParams({
            code: product.ean,
            location: 'A-01',
            limit: '100',
            ...(cursor ? { cursor } : {}),
          }),
        response = await req(path);
      assert.equal(response.statusCode, 200);
      assert.match(String(response.headers['cache-control']), /no-store/);
      const page = response.json();
      assert.equal(page.meta.total, 10000);
      assert.equal(page.data.length, 100);
      for (const line of page.data as Row[]) {
        assert(!seen.has(line.line_id));
        seen.add(line.line_id);
        const raw = byId.get(line.line_id);
        assert(raw);
        assert.equal(line.product_id, product.id);
        assert.equal(line.location, raw.location);
        assert.deepEqual(line.lot, raw.lot);
        assert.equal(line.counted, null);
        assert.equal(line.generation_id, null);
        assert.equal(line.can_continue, false);
        assert.match(line.resolution_token, /^[a-f0-9]{64}$/);
        last = line;
      }
      cursor = page.meta.cursor ?? undefined;
      if (!pages) firstCursor = cursor;
      assert(++pages <= 100);
      if (cursor) {
        assert(!cursors.has(cursor));
        cursors.add(cursor);
      }
      if (pages % 20 === 0) ++ip;
    } while (cursor);
    assert.equal(pages, 100);
    assert.deepEqual([...seen].sort(), [...byId.keys()].sort());
    assert(last && firstCursor);
    const changedFilter = await req(
      base +
        '/scan-candidates?' +
        new URLSearchParams({
          code: product.sku,
          location: 'A-01',
          limit: '100',
          cursor: firstCursor,
        }),
    );
    assert.equal(changedFilter.statusCode, 409);
    const start = await ok(base + '/scan-start', 'POST', {
      client_key: randomUUID(),
      line_id: last.line_id,
      version: last.line_version,
      basis_token: last.basis_token,
      code: product.ean,
      location: last.location,
      resolution_token: last.resolution_token,
      expires_at: last.expires_at,
      confirmed_zero: true,
      confirmed_reset: false,
      note: 'Only explicit last-page zero count',
    });
    assert.equal(start.scan.line_id, last.line_id);
    assert.equal(start.scan.counted, 0);
    assert.equal(
      (
        await pool.query('SELECT count(*)::int n FROM stocktake_scan_receipts WHERE tenant_id=$1', [
          tenant,
        ])
      ).rows[0].n,
      1,
    );
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int n FROM wms_stocktake_measurements WHERE tenant_id=$1',
          [tenant],
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int n FROM wms_stocktake_lines WHERE tenant_id=$1 AND counted IS NOT NULL',
          [tenant],
        )
      ).rows[0].n,
      1,
    );
    assert.deepEqual(await physical(), physicalBefore);
    assert.equal(providerCalls, 0);
  },
);
